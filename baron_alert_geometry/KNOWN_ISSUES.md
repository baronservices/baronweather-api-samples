# Known Issues & Open Items

Status of everything found while building these tools. Fixed items are listed for the
record; open items say why they're open and what the fix is.

---

## Fixed

### 1. Fire-weather alerts had no geometry — `baron_alerts_report.py`

**Was:** 31 zone references across 8 FireWeather Warnings resolved to nothing, leaving
those alerts with no polygon and no centroid. Every fire-weather alert in the feed was
affected.

**Cause:** the alert feed cites fire-weather zones with a `Z` code while the zone
shapefile stores them with an `F` code. `WYZ277` is `WYF277`, *"Lincoln and Uinta
Counties/Lower Elevations"*. Not staleness — the geometry was always present.

| type | code letter | WY numbering |
|---|---|---|
| FORECAST | `Z` | 1–199 |
| FIRE | `F` | 140–433 |

**Root cause, from their source:** `wxworx/ingest/alerts_archive/alerts_shp_manager.py:56`
builds the id as `data['state'] + 'F' + data['zone']`, while `:29` builds forecast zones
as `state + 'Z' + zone`. The `F` is a literal this function inserts; it exists in no NWS
product. `alerts_parser.py:79` confirms the other side can never emit it — the UGC regex
is `[A-Z]{2}[ZC]\d{3}`.

They had a reason: `zones` is keyed on `id` alone, and NWS reuses zone numbers between the
two zone sets. **3,016 state+number pairs exist as both a FORECAST and a FIRE zone.**
Ingesting fire zones with `Z` codes would collide.

**Fix:** for a fire-weather product (VTEC `pps` prefix `FW`), resolve the F-coded FIRE
zone **first**, and fall back to the cited Z code only if no FIRE twin exists. Order
matters: an earlier version recoded only when the Z code *missed*, so a fire-weather alert
citing a colliding number (`ALZ001`) silently returned the FORECAST polygon and never
reached `ALF001`. Every substitution is recorded in the polygon as `resolved_zone_id` +
`recode_reason`, and counted in `meta.counts.polygons_from_recoded_fire_zones`. Disable
with `--no-fire-zone-recode`.

**Result:** unresolved references 31 → 0, alerts without a centroid 8 → 0, and the API
round-trips for those zones 31 → 0 (run time 11.5 s → 3.9 s).

**Verified:** a fire-weather alert citing `ALZ001` resolves to `ALF001` (FIRE); the same
code on a non-fire alert still resolves to `ALZ001` (FORECAST); a fire-weather alert citing
a Z code with no F twin falls back to the cited zone.

**Note on the collision risk:** the two zone sets are nearly identical geometrically —
3,012 of 3,016 colliding pairs share the same name, median centroid distance 0.00 km, p99
0.01 km, max 28.8 km. So the earlier ordering was low-harm in practice, not silently very
wrong. The fix removes the dependence on zone numbering regardless.

### 2. Re-fetching a type doubled its records — `baron_zones_fetch.py`

**Was:** without `--resume`, a fetch of an already-staged type backed the staging file up
and then opened it in **append** mode without clearing it, so every record was written
twice. Caught by `verify_zones.py` during a refresh test: OFFSHORE came back as 260
features instead of 130, with 130 identical `(zone_id, geometry)` pairs.

Earlier testing missed it because a fresh run used an empty directory and the repeat run
used `--resume`. Only the refresh workflow — re-fetch one type into a populated directory
— exposed it.

**Fix:** a non-resume fetch removes the staging file after backing it up, logged as
`STAGING_CLEARED`.

### 3. A partial refresh wiped the other zone types — `baron_zones_fetch.py`

**Was:** the GeoPackage was rebuilt from only the staging files of the types fetched in
that run, so `--types OFFSHORE` produced a GeoPackage containing *only* offshore zones,
silently discarding the other ~11,700.

**Fix:** the rebuild now includes every `zones_*.geojsonl` in the output directory,
logging `GPKG_CARRY_FORWARD` and printing which types were carried. The feature-count
cross-check compares against all contributing staging files rather than just the current
run's totals.

### 4. `alert_key` was not unique — `baron_alerts_report.py`

**Was:** the first VTEC event was labelled as the alert's identity, but only 96 were
distinct across 138 alerts. One event is split across several records, each holding a
different zone subset — `KWNS.SV.A.556` appeared as 6 records.

**Fix:** the field is now `event_key`/`event_keys`, which is honestly the *event*
identity and is meant to repeat, plus `record_key` (events + a hash of the zone list)
which is unique per record — verified 138/138.

---

## Open

### 5. Fire zone ids are not real UGC codes — desirable, not necessary

Client-side handling is complete (item 1), so nothing here depends on this. It is a defect
report for Baron, not work for this project.

**The defect:** `zones/ids` publishes `WYF286`. No NWS product contains that code, and the
alert feed cites `WYZ286`. The API documents no mapping between them, so every client must
infer `state + 'F' + number` by reading the ingest source.

**Suggested fix:** key the zone table on `(shp_type, ugc)` and have the alert join pass the
zone set, which the VTEC phenomenon already identifies (`FW` → fire zones). `adjust_fire`
can then store the true UGC code.

**Do not** simply change fire zone ids to `Z` codes in the present schema — that
reintroduces 3,016 key collisions.

**Cost of leaving it:** our workaround depends on an undocumented internal convention. If
Baron changes it, the recode fails silently.

### 6. `precision=3` returns HTTP 400 — API off-by-one

**Where:** `wxworx/lib/url/argschecker.py:150` in `baronwebapi.dev`.

```python
if val <= lower_bound:      # exclusive, so lower_bound itself is rejected
    raise Exception
```

`ZoneHandler` calls it with `lower_bound=3` (`wxworx/report_server/handlers/alert_handler.py:930`),
intending 3 to be valid, but the check rejects it. The error text — `must be an integer > 3`
— reflects the actual behaviour. Effective range is 4–9.

**Suggested fix:** change the handler's call to `lower_bound=2`. **Do not** make the
shared checker inclusive: `page()` relies on the exclusive semantics (`lower_bound=0` to
reject `page=0`), so flipping it would silently accept `page=0` on every paginated
endpoint.

**Why open:** it lives in the API's own repo, not this project, and needs review and a
deploy. Nothing here depends on precision 3 — the scripts validate 4–9 up front with a
clear message, and precision barely affects size anyway (p4 is only ~15% smaller than p6).

### 7. Should this read PostGIS directly instead of the HTTP API?

The alert server already holds this data in PostGIS — a `zones` table with a geometry
column plus `shp_versions`. Querying it directly would avoid 217 MB of HTTP and 11,651
requests, and make the staleness question moot.

**Why open:** it's an architecture decision, not a defect. Reading the database couples
you to their schema, whereas the HTTP API is the stable contract. Reasonable split — API
for anything portable or external, database for in-infra batch work. Needs a call from
whoever owns the deployment.

### 8. Geometry is over-detailed for rendering

`NCZ196` has 216 polygon parts, `NCZ110` 174, `NJC009` 115. Fine for analysis, wasteful
for drawing.

Note `--precision` will **not** help: it trims coordinate decimals, not vertex counts.
The lever is simplification — a derived display layer via `ST_SimplifyPreserveTopology`,
keeping `zones.gpkg` as the analytical source.

**Why open:** depends on whether these get drawn, and at what zoom levels, which
determines the tolerance. Not worth guessing.

### 9. ~~31 wasted API calls per alert-report run~~ — fixed by item 1

Closed as a side effect of resolving the F-coded zone first: the Z-coded lookup that used
to 404 against the API no longer happens. API zone calls per run 31 → 0, run time 11.5 s →
3.9 s.

### 10. `--geometry-source api` is slow

Zone lookups over the API are serial at roughly 0.2 s each, so the full `all` product
takes about 4 minutes versus ~12 s from the GeoPackage. Concurrent pre-resolution would
fix it.

**Why open:** it's a fallback path for checking the local copy or running without one,
not the daily route. Results are identical either way — cross-checked over 93 shared
zones, maximum centroid difference 0.000000000°.

---

## Not bugs — verified expected behaviour

**227 zone ids have 2–6 geometry rows.** Legitimate. The rows are disjoint (zero
intersection area) and separately named: `FMC001`'s six rows are six Micronesian islands
(Onoun, Faraulep, Mwoakilloa, Sapwuahfik, Nukuoro, Pakin) sharing one zone code. All rows
are preserved; none are collapsed.

**50 of 1,597 centroids fall outside their polygon.** Expected for a C-shaped county or a
multi-island marine zone — the area-weighted centroid of a concave or multipart shape need
not lie inside it. Flagged per polygon as `centroid_inside_polygon: false`. Use
`ST_PointOnSurface` if you need a guaranteed-inside label point.

**Alert counts drift between runs.** The feed is live; `all` was 132 alerts one minute and
138 a few minutes later. `from` is pinned to page 1's timestamp so each report is
internally consistent.

**Bulletin text is only ~21% of the report** (0.16 of 0.77 MB compact), so `--no-text` is
not a meaningful size lever.
