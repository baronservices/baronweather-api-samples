# Baron Velocity Weather — Alert Zones & Alert Reports

Tools for the Velocity Weather alert API:

| script | what it does |
|---|---|
| `baron_zones_fetch.py` | Fetches all NWS alert zone geometry into an indexed GeoPackage |
| `verify_zones.py` | Verifies a fetch for completeness and measures read performance |
| `baron_alerts_report.py` | Walks all alert pages and writes a JSON report plus a centroid GeoPackage and a raw-geometry GeoPackage |
| `zone_geometry.py` | Retrieves the geometry of one or more zone ids |
| `check_alerts.py` | Cron-ready: runs the report, then checks the JSON and both GeoPackages |
| `refresh_zones.sh` | Cron-ready: refetches only the zone types whose version changed |
| `selftest.py` | Offline test suite. No network, no credentials |

See `KNOWN_ISSUES.md` for open items and for the API quirks these tools work around.

The zone dataset is the geometry source for the alert report: alerts reference zones
by id and carry no geometry of their own, so fetch the zones first.

## Setup

Requires Python 3 and GDAL with the Python bindings (`ogr2ogr` on `PATH`).

Copy the example credentials file, then add your key and secret:

```bash
cp .env.example .env
```

```
BARON_API_KEY=your_key
BARON_API_SECRET=your_secret
BARON_API_BASE_URL=https://api.velocityweather.com
```

`.gitignore` excludes `.env`, `zones_out/`, the generated reports, and every `*.gpkg`
and `*.fgb`. All of those are script output.

**The file is the only source.** Environment variables are not read. Exporting
`BARON_API_KEY` has no effect. One visible file is easier to audit than a value that
could arrive from a shell, a container, or a cron environment, and a stale exported key
silently overriding the file is a confusing failure to diagnose.

Check GDAL with:

```bash
python3 -c "from osgeo import gdal; print(gdal.__version__)" && ogr2ogr --version
```

Auth is handled for you: HMAC-SHA1 over `{key}:{unix_ts}`, base64 url-safe, sent as
`ts` and `sig`. Signatures are computed once per second and shared across threads.

### Where the `.env` is looked for

Every script takes `--env`. Left at its default, the search order is:

1. `.env` in the current working directory
2. `.env` beside the script

So the scripts work from any directory, and a per-project `.env` in the working
directory still wins over the one in the script folder. This matters for cron, which
does not run in the script's folder:

```bash
python3 /path/to/baron_alert_geometry/zone_geometry.py ALC089   # finds its own .env
```

An explicit `--env /path/to/.env` is used exactly as given and never falls back — a
named path must not silently resolve to different credentials. If nothing is found, the
error names both places it looked.

---

## 1. `baron_zones_fetch.py` — zone geometry

```bash
python3 baron_zones_fetch.py                      # full fetch, all 5 types -> zones_out/
python3 baron_zones_fetch.py --limit 25           # smoke test, 25 zones per type
python3 baron_zones_fetch.py --types COASTAL,OFFSHORE
python3 baron_zones_fetch.py --resume             # continue an interrupted run
python3 baron_zones_fetch.py --fgb                # also emit FlatGeobuf
python3 baron_zones_fetch.py --check-versions     # is the local copy stale?
```

A full run takes about 4–5 minutes: 11,651 requests at ~45/s for 217 MB on the wire.

### Options

| flag | default | notes |
|---|---|---|
| `--out-dir` | `zones_out` | output directory |
| `--types` | all five | `FIRE,COUNTY,COASTAL,FORECAST,OFFSHORE` |
| `--precision` | `6` | coordinate decimals, **4–9**. The API documents 3 but returns 400 for it |
| `--from` | today UTC | snapshot date, pinned across the whole run |
| `--workers` | `12` | concurrent requests |
| `--limit` | — | N zones per type, for smoke tests |
| `--resume` | off | skip ids already staged; repairs a truncated staging file first |
| `--no-gpkg` | off | stage NDJSON only |
| `--fgb` | off | also write `zones.fgb` |
| `--check-versions` | — | compare live shapefile versions to the local manifest, then exit |
| `--progress-every` | `250` | progress line cadence, `0` to disable |

Lower precision is not worth it — p4 is only ~15% smaller than p6, because JSON
punctuation dominates, not coordinate digits.

### Output

```
zones_out/
  zones.gpkg              146 MB   <- the artifact you query
  zones.fgb              139 MB   (only with --fgb)
  zones_{TYPE}.geojsonl  ~200 MB  NDJSON staging, kept so --resume works
  zones_ids.json                  id listing as returned by the API
  zones_versions.json             shapefile version per type
  manifest.json                   provenance, counts, timings, per-type stats
  baron_zones_fetch.log           structured log
```

`zones.gpkg` holds one `zones` table with columns `zone_id`, `type`, `name`,
`valid_begin`, `geom`, indexed on `zone_id` and `type` plus the spatial R-tree.

```sql
SELECT zone_id, name FROM zones WHERE zone_id = 'ALC089';
SELECT zone_id FROM zones WHERE type = 'OFFSHORE';
```

```bash
ogrinfo -so zones_out/zones.gpkg zones
```

### Keeping it current

Zone geometry is versioned and static — every type is currently stamped `2026-04-16`.
Don't refetch on a schedule; poll instead:

```bash
python3 baron_zones_fetch.py --check-versions
```

```
type       local        live         status
COASTAL    2026-04-16   2026-04-16   current
...
local copy is current
```

Exit code is 0 when current, 1 when any type is stale. When something is stale it prints
the exact command to fix it, e.g. `refetch with: --types FIRE,FORECAST`.

`refresh_zones.sh` automates that loop — check, refetch only the stale types, rebuild,
verify:

```bash
./refresh_zones.sh                  # exits 0 if already current
15 4 * * * cd /Users/sherman/tmp/1/2 && ./refresh_zones.sh >> refresh.log 2>&1
```

A partial refresh is safe: types not fetched in that run keep their staging files and are
carried forward into the rebuilt GeoPackage (reported as `carrying forward N staged
type(s)`), so `--types OFFSHORE` does not discard the other ~11,700 zones. That turns a 217 MB job into a
single request. A version stamp is only recorded for a type fetched **in full**, so a
`--limit` or partly-failed run reports STALE rather than falsely claiming current, and
partial runs merge into the manifest instead of wiping other types' stamps.

### Resuming

`--resume` skips ids already in the staging files. If a run was killed mid-write the
final line may be truncated; the staging file is validated and truncated back to the
last complete record before appending, so a resumed run produces byte-identical results
to a clean one (verified: kill at 669/700 records, resume, 700 features either way).

---

## 2. `verify_zones.py` — verification

```bash
python3 verify_zones.py [out_dir]        # default: zones_out
```

Checks feature counts against the API's own id listing, that every listed id is present
and no unlisted ids appear, that duplicate zone rows survived and no row was
double-written, that indexes exist and id lookups are index-backed, then times the four
real access patterns. Exit code 1 if any check fails.

Measured on the full dataset (11,891 features, 146 MB):

```
lookup by zone_id      1.73 ms
bbox query             2.97 ms
point-in-polygon       3.47 ms
full scan (11,891)      132 ms
```

---

## 3. `baron_alerts_report.py` — alerts with centroids

```bash
python3 baron_alerts_report.py                     # JSON + both GeoPackages
python3 baron_alerts_report.py --product all-poly  # include storm-based polygons
python3 baron_alerts_report.py --no-gpkg           # JSON only
python3 baron_alerts_report.py --gpkg-dir out      # GeoPackages into out/
python3 baron_alerts_report.py --include-geometry   # embed polygons in the JSON
python3 baron_alerts_report.py --no-text            # drop bulletin text
python3 baron_alerts_report.py --geometry-source api  # ignore the local GeoPackage
```

Walks every page of the alert feed, resolves the polygon(s) behind each alert, computes
a centroid per polygon plus one combined centroid per alert, and writes three files.
A run takes ~12 s.

### Output files

```
alerts_report.json      the full report, every polygon with its centroid
alerts_centroids.gpkg   layer polygon_centroids  one point per polygon
                        layer alert_centroids    one point per alert
alerts_geometry.gpkg    layer alert_polygons     the raw polygon of each
```

The centroid file answers *where is this alert*. The geometry file answers *what shape
is it*. Both are EPSG:4326, and both are written next to `--out` unless `--gpkg-dir`
says otherwise.

All three files carry `record_key`, so they join to each other. The two polygon-level
layers share one attribute schema, so a centroid row and its polygon row have identical
columns. `alerts_centroids.gpkg` is indexed on `record_key`, `zone_id`, and `event_key`;
`alerts_geometry.gpkg` on `record_key` and `zone_id`.

```sql
-- every polygon of one alert
SELECT zone_id, zone_name FROM alert_polygons WHERE record_key = 'KCTP.FF.W.59:6f02ee4d';
-- one dot per alert, for a map
SELECT alert_types, centroid_lon, centroid_lat FROM alert_centroids;
```

```bash
ogrinfo -so alerts_centroids.gpkg
ogrinfo -so alerts_geometry.gpkg alert_polygons
```

`alert_polygons` is created as MULTIPOLYGON and every geometry is promoted to one. A
mixed Polygon/MultiPolygon layer loses the odd feature out — the same trap
`-nlt MULTIPOLYGON` guards against in `baron_zones_fetch.py`.

`--no-gpkg` writes the JSON alone. It also stops the polygons being held in memory,
which is the only reason to use it on a large product.

### Options

| flag | default | notes |
|---|---|---|
| `--product` | `all` | `all` zone-based, `poly` storm-based, `all-poly` both |
| `--out` | `alerts_report.json` | output file |
| `--zones-gpkg` | `zones_out/zones.gpkg` | zone geometry source |
| `--geometry-source` | `auto` | `auto` GeoPackage then API, or force `gpkg` / `api` |

| `--from` | page 1's timestamp | pin the snapshot |
| `--precision` | `6` | precision for API zone lookups |
| `--include-geometry` | off | embed full polygons in the JSON; output grows to tens of MB |
| `--no-gpkg` | off | skip both GeoPackages, write the JSON alone |
| `--gpkg-dir` | beside `--out` | directory for the two GeoPackages |
| `--no-text` | off | omit bulletin text |
| `--indent` | `2` | `0` for compact JSON |

### Which product

| product | geometry | one observed snapshot |
|---|---|---|
| `all` | zone ids only | 7 pages, 133 alerts |
| `poly` | inline storm polygons only | 2 pages, 33 alerts |
| `all-poly` | both | 9 pages, 166 alerts |

Counts are illustrative, not fixed — the feed is live and moves minute to minute
(`all` was 132 alerts one minute and 133 the next).

### Geometry source

`auto` reads zone polygons from `zones.gpkg` and falls back to the API for anything
missing. `--geometry-source api` skips the GeoPackage entirely, which is useful to check
the local copy or to run without one, but it is much slower: zone lookups are serial at
roughly 0.2 s each, so the full `all` product takes about 4 minutes against ~12 s from the
GeoPackage. Both produce identical results — cross-checked over 93 shared zones, maximum
centroid difference 0.000000000°, so the GeoPackage is a lossless round-trip of the API
geometry.

`all` is the default. Storm-based warnings (tornado, severe thunderstorm, flash flood)
carry a polygon tighter than the county zones they list — use `all-poly` if you want it.

### Report structure

```json
{
  "meta": {
    "source":  { "product": "all", "snapshot_from": "...", "pages": 7 },
    "geometry":{ "zones_geopackage": "...", "zone_shapefile_versions": {...} },
    "centroid_method": { "per_polygon": "...", "per_alert": "..." },
    "outputs": { "json": "alerts_report.json",
                 "centroids_geopackage": { "path": "...", "polygon_centroids": 1515,
                                           "alert_centroids": 132, "bytes": 0 },
                 "geometry_geopackage":  { "path": "...", "features": 1515, "bytes": 0 },
                 "join_key": "record_key" },
    "counts":  { "alerts": 132, "polygons": 1515, "unresolved_zone_references": 31 }
  },
  "alerts": [
    {
      "record_key": "KCTP.FF.W.59:6f02ee4d",
      "event_key": "KCTP.FF.W.59", "event_keys": ["KCTP.FF.W.59"],
      "types": ["Flash Flood Warning"], "colors": ["#8b0000"],
      "valid_end": "...", "zones": ["PAC055"], "vtecs": [...], "text": "...",
      "centroid": { "lon": -77.71777, "lat": 39.931648 },
      "polygon_count": 2,
      "polygons": [
        { "source": "alert_polygon", "zone_id": null,
          "centroid": {...}, "centroid_inside_polygon": true, "bbox": [...],
          "geometry_type": "Polygon", "parts": 1,
          "renested_from_nonstandard_geojson": true },
        { "source": "zone:geopackage", "zone_id": "PAC055",
          "zone_type": "COUNTY", "zone_name": "Franklin",
          "zone_row": 0, "zone_rows_for_id": 1,
          "centroid": {...}, "centroid_inside_polygon": true, "bbox": [...],
          "geometry_type": "MultiPolygon", "parts": 1 }
      ]
    }
  ]
}
```

Every polygon carries its own centroid. `centroid` at the alert level is the combined
one — useful when an alert spans up to 58 zones and you need a single point to plot.

### Keys

The feed carries no alert id, so two keys are derived:

- **`event_key`** — the VTEC event (`office.phenomenon.significance.number`). Identifies
  the *event* and is **meant to repeat**: one event is split across several records, each
  with a different zone subset. `KWNS.SV.A.556` appeared as 6 records in one snapshot.
  Use this to follow an event across snapshots.
- **`record_key`** — `event_key` plus a hash of the zone list. Unique per record
  (verified 138/138 where `event_key` alone gave 96). Use this to diff snapshots.

### Centroids

Per polygon: area-weighted centroid in EPSG:4326. Per alert: mean of its polygon
centroids weighted by area × cos(latitude), so a polygon counts for roughly its true
surface area rather than its area in square degrees.

Both are **antimeridian-safe**, which matters: four zones straddle 180° (`AKC016` and
Bering Sea zones `PKZ767`/`PKZ784`/`PKZ785`). A naive planar centroid of `PKZ784` lands
at lon **-3.1**, in the Atlantic off West Africa; the correct answer is **-179.9**.
Longitudes are shifted into a continuous frame before the centroid is taken, and the
combined centroid averages longitudes as unit vectors. Affected polygons are flagged
with `crosses_antimeridian`.

`centroid_inside_polygon` is `false` for ~3% of polygons (50 of 1515). That is expected,
not a bug — the area centroid of a C-shaped county or a multi-island marine zone can
fall outside the shape. If you need a point guaranteed to be inside, for a map label,
use `ST_PointOnSurface` against `zones.gpkg` rather than the centroid.

### Fire-weather zone codes

Fire-weather alerts cite their zones with a `Z` code while the zone shapefile stores fire
zones with an `F` code — `WYZ277` is `WYF277`, *"Lincoln and Uinta Counties/Lower
Elevations"*. Without handling this, every fire-weather alert in the feed resolves to no
geometry (measured: 31 references across 8 FireWeather Warnings).

For a fire-weather product (VTEC `pps` prefix `FW`), the `F`-coded zone is resolved
**first**, and the cited `Z` code is used only if no `FIRE` twin exists. The order matters:
NWS reuses zone numbers between the two zone sets — **3,016 state+number pairs exist as
both** — so a fire-weather alert citing `ALZ001` would otherwise match the *forecast* zone
and never reach `ALF001`. The gate on `FW` matters for the same reason: an unconditional
fallback could send a non-fire alert to fire geometry. Substitutions are always visible:

```json
{ "zone_id": "SDZ322", "resolved_zone_id": "SDF322",
  "zone_type": "FIRE", "zone_name": "Fall River County Area",
  "recode_reason": "fire-weather zone cited with a Z code; matched the F-coded FIRE zone" }
```

Counted in `meta.counts.polygons_from_recoded_fire_zones`; disable with
`--no-fire-zone-recode` to see the raw unresolved state.

### Unresolved zones

Anything still unresolvable is recorded per alert in `unresolved_zones` and counted in
`meta.counts.unresolved_zone_references` rather than silently dropped. With the recode in
place the current snapshot has none.

---

## 4. `zone_geometry.py` — geometry by zone id

```bash
python3 zone_geometry.py ALC089                     # summary table
python3 zone_geometry.py ALC089 PAC055 FMC001       # several ids
python3 zone_geometry.py FMC001 --format geojson    # FeatureCollection
python3 zone_geometry.py ALC089 --format wkt
python3 zone_geometry.py WYZ277 --fire              # apply the Z -> F recode
python3 zone_geometry.py ALC089 --gpkg-out zone.gpkg
python3 zone_geometry.py --stdin < ids.txt          # one id per line
```

Reads `zones_out/zones.gpkg` and falls back to the live `zones/{id}` endpoint for
anything the local copy does not hold. `--source gpkg` never calls the API and needs no
credentials; `--source api` never reads the local copy.

### Options

| flag | default | notes |
|---|---|---|
| `--gpkg` | `zones_out/zones.gpkg` | zone geometry source |
| `--source` | `auto` | `auto` GeoPackage then API, or force `gpkg` / `api` |
| `--format` | `summary` | `summary`, `geojson`, `wkt`, or `json` without geometry |
| `--fire` | off | resolve a Z-coded fire-weather zone to its F-coded FIRE twin first |
| `--out` | stdout | write the output to a file |
| `--gpkg-out` | — | also write the rows to a single-layer GeoPackage |
| `--stdin` | off | also read ids from stdin, one per line |

Exit code is 0 when every id resolved and 1 when any did not. Ids that failed are named
on stderr.

### Two behaviours to know

**A zone id can return several rows.** 227 ids do. `FMC001` is six separate Micronesian
islands under one code. Every row comes back as its own feature with its own centroid,
tagged `row` and `rows_for_id`. Nothing is merged.

**`--fire` matters and the order inside it matters.** NWS reuses zone numbers between the
public and fire zone sets — 3,016 state+number pairs exist as both. So `ALZ001` is a real
FORECAST zone *and* `ALF001` is a real FIRE zone.

```
python3 zone_geometry.py ALZ001            -> FORECAST, the cited zone
python3 zone_geometry.py ALZ001 --fire     -> ALF001, FIRE
```

Use `--fire` only for a zone cited by a fire-weather alert. `baron_alerts_report.py`
makes this decision for you from the VTEC phenomenon; here it is yours. A recoded row
keeps the cited code in `zone_id` and reports the real one in `resolved_zone_id`, and the
summary marks it with `*`.

---

## 5. `selftest.py` — offline tests

```bash
python3 selftest.py
```

```
all 68 checks passed
```

No network and no credentials. It builds a synthetic `zones.gpkg` and a synthetic set of
alert records, then drives the real code against them, so the answer is the same every
time. Exit code 1 if any check fails.

What it covers:

| area | checks |
|---|---|
| geometry | re-nesting the API's under-nested polygons; antimeridian centroids; the combined centroid across 180° |
| geopackage | layer names, counts, geometry types, lon/lat axis order, attribute round-trip, indexes, and area-in equals area-out |
| record build | `keep_geometry` holds the polygon for the writer and `main()` strips it before the JSON |
| lookup | by id, multi-row ids, the FORECAST/FIRE number collision in both directions, every output format, exit codes |
| credentials | the `.env` beside the script is found from any directory, a local `.env` still wins, an explicit `--env` never falls back |
| monitor | `check_alerts.py` catches a GeoPackage that disagrees with the JSON |

The collision test is the one worth keeping. It asserts `ALZ001` resolves to FORECAST
without `--fire` and to `ALF001` FIRE with it. Reversing that is the exact bug
`KNOWN_ISSUES.md` item 1 describes, and a count-based test would not see it.

The axis-order check is the other one. It asserts a written point has longitude in X.
GDAL 3 defaults EPSG:4326 to authority axis order (lat, lon); the writers force
traditional order. Without that, every point lands transposed.

---

## Why GeoPackage

Benchmarked at full scale (11,651 features, GDAL 3.13.1, min of 3–5 runs, warm cache):

| format | on disk | full scan | bbox | point-in-poly | by `zone_id` |
|---|---|---|---|---|---|
| NDJSON | 174 MB | 7,475 ms | 7,451 ms | 7,223 ms | 7,387 ms |
| **GeoPackage** + index | 128 MB | 128 ms | 2.8 ms | 3.7 ms | **1.7 ms** |
| FlatGeobuf | 122 MB | 100 ms | **0.8 ms** | **1.9 ms** | 37.8 ms |
| GeoParquet (zstd) | ~41 MB | 115 ms | 37.0 ms | 35.4 ms | 35.0 ms |

Alerts reference zones **by id**, so id lookup is the hot path and GeoPackage wins it by
22x. That margin is entirely the `zone_id` B-tree index: without it the same query takes
28.6 ms. FlatGeobuf has a spatial index but no attribute index, so it wins bbox and loses
ids — worth a second copy (`--fgb`) if map tiling is your hot path, or to serve from S3
with HTTP range reads. GeoParquet is 3x smaller but 10–20x slower on every spatial
access; use it for archival, not serving. Never query the NDJSON directly.

---

## API quirks handled

Each of these silently corrupts a naive implementation:

1. **`zones/ids` lists 11,891 ids but only 11,651 are distinct.** 227 ids have 2–6 rows
   in a single shapefile version, and every row is a genuinely different polygon (verified:
   zero identical `(zone_id, geometry)` pairs). All rows are kept. One request per distinct
   id, since a repeated id returns all of its rows in one response.
2. **A repeated id returns a `FeatureCollection`, not a `Feature`.** Writing responses
   verbatim loses them — GDAL silently dropped 6 of 300 features before this was caught.
   Collections are unwrapped so every line holds one Feature.
3. **`ogr2ogr` needs `-nlt MULTIPOLYGON`**, or the layer takes its type from the first
   feature and mismatched geometries are dropped.
4. **Inline alert geometry is not valid GeoJSON.** It is a `Polygon` whose `coordinates`
   is a bare ring (nesting depth 2) instead of a list of rings (depth 3). GDAL rejects it
   outright: `OGRGeoJSONReadRawPoint(): invalid Point`. It is re-nested before use — 40 of
   173 alerts in an `all-poly` run. Rings are already closed.
5. **`precision=3` returns HTTP 400** despite the handler documenting a lower bound of 3.
   Effective range is 4–9.
6. **Requesting a page beyond `meta.pages` returns HTTP 400.** The walk is bounded by the
   page count, re-read from every response.
7. **The alert feed is live**, so `from` is pinned to page 1's timestamp for all later
   pages. Without it the feed shifts between requests and alerts get duplicated or missed.
8. **`HIGHSEA` zones** are excluded server-side and never appear.

## Logs

`baron_zones_fetch.log` and `baron_alerts_report.log`, with grep-able tags:

```bash
grep ZONE_FAILED    zones_out/baron_zones_fetch.log     # retryable failures
grep ZONE_NOTFOUND  zones_out/baron_zones_fetch.log     # 404s
grep TYPE_ROLLUP    zones_out/baron_zones_fetch.log     # per-type totals
grep RUN_TOTAL      zones_out/baron_zones_fetch.log     # bandwidth summary
grep ZONE_UNRESOLVED baron_alerts_report.log            # alerts citing absent zones
grep GPKG_          baron_alerts_report.log            # GeoPackage row counts and sizes
grep GPKG_GEOM_SKIPPED baron_alerts_report.log         # polygons with no usable geometry
```

Warnings and errors also go to stderr. Files are backed up to `backup/` with a UTC
timestamp before being overwritten.

## Troubleshooting

**`BARON_API_KEY / BARON_API_SECRET not found`** — no `.env` in the working directory
and none beside the script. The error lists both paths it tried. Pass
`--env /path/to/.env`. Exporting the variables will not help — the `.env` file is the
only source.

**`ogr2ogr not found on PATH`** — NDJSON is still staged. Install GDAL and rerun with
`--resume` to convert without refetching.

**`error: GDAL Python bindings required`** — `baron_alerts_report.py`,
`zone_geometry.py`, `verify_zones.py`, and `selftest.py` need `osgeo`, not just the
`ogr2ogr` binary.

**A zone id does not resolve** — if it is a 6-character code with `Z` in position 3 and
it comes from a fire-weather alert, add `--fire`. See section 4.

**The GeoPackage row count disagrees with the JSON** — `check_alerts.py` reports this as
an ERROR. Rerun the report; the two are written in one pass and cannot drift on their own.

**A run died partway** — rerun with `--resume`. Failed ids are listed at the end of the
run and in the log under `ZONE_FAILED`.

**`Invalid argument 'page'`** — a page beyond `meta.pages` was requested. The feed shrank
mid-walk; rerun.
