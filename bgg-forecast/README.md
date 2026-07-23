# BGG GeoTIFF Tools

Fetch and query [Baron Weather](https://www.baronweather.com/) **BGG (Baron Global Grid)**
forecast GeoTIFFs from the Velocity Weather API — with correct handling of the two things
that make BGG data easy to misread:

1. **Band selection** — each daily file holds 20 overlapping 24-hour forecast windows, and
   *which* window represents a given city's calendar day depends on that city's UTC offset.
   There is no universal rule like "always add 24h"; picking the wrong adjacent band silently
   blends in data from the wrong calendar day.
2. **Pixel decoding** — GeoTIFF pixels are 8-bit **palette indices**, not physical values.
   Index 192 in a temperature file means 27.5 °C, not 192 K. Values must be decoded through
   the product's legend.

Both behaviors in `geotiff_value_at.py` are validated against the pipeline that produces the
data (see [Validation](#validation)).

---

## Repository layout

| File | Purpose |
|---|---|
| `geotiff_fetch.py` | General-purpose fetcher for any Baron GeoTIFF product (single timestamp, time range, list-times, legend download) |
| `geotiff_value_at.py` | **The point-query tool**: value at a lat/lon/time, with pipeline-faithful DAY/NIGHT band selection, legend decoding, and windvector (u/v) support |
| `bgg-global-endpoints.md` | Catalog of the 60 BGG product codes |
| `BGG_Data_Interpretation_Guide.md` | Background on bands and the DAY/NIGHT convention (see caveat in [Validation](#validation)) |

## Requirements

- Python 3.9+ with: `GDAL` (osgeo bindings), `timezonefinder`, `requests`, `tenacity`
  (`requests`/`tenacity` are only needed by `geotiff_fetch.py`; `GDAL`/`timezonefinder` only by `geotiff_value_at.py`)
- API credentials in the environment (fetching only — legend download and value decoding hit a public CDN):

```bash
export BARON_ACCESS_KEY=...
export BARON_ACCESS_KEY_SECRET=...
```

---

## The BGG daily data model

A daily product file (e.g. `bgg-global-day-temp-max-c-2meter`) contains:

- **Grid**: global 0.1° WGS84 (`Standard-Geodetic`), 3601 × 1801 pixels, cell centers at
  −180.0 … +180.0 / −90.0 … +90.0 (the ±180 columns are duplicates of the same meridian).
- **20 bands** = 24-hour aggregation windows stepping every 12 h, forecast leads f+24h … f+252h.
  A band's `GRIB_VALID_TIME` marks the **end** of its window: band *N* covers forecast hours
  `(12(N−1), 12(N−1)+24]` since model init.
- **DAY/NIGHT split**: DAY = local clock 07:00–19:00, NIGHT = 19:00–07:00 — resolved
  **per pixel** from that pixel's own IANA timezone (fixed clock hours, not solar). A band's
  value at a pixel is the aggregate (max/min/avg/sum, see table below) over only the hourly
  timesteps inside that window that fall in the pixel's local day (or night).
- **Pixels**: `Byte` palette indices, decoded via the product legend at
  `https://static.velocityweather.com/legends/{product}/{projection}/geotiff_legend.json`
  (public, no auth).

Model runs are produced twice daily (00Z and 12Z); the API retains the two most recent runs.

### Why band selection is non-trivial

To read "Tokyo's daytime high for July 25" you must find the band whose 24 h window contains
*all 12 hourly steps of Tokyo's local 07:00–19:00 on July 25* (= 2026-07-24T22:00Z →
2026-07-25T10:00Z). Because windows aggregate steps `ws+1 … ws+24`, a band qualifies iff

```
window_start < start_h   AND   window_end >= end_h − 1
```

(hours since model init, **strict** lower bound). Depending on the city's UTC offset this
yields exactly **one** band, or **two** equally-correct bands (verified: genuinely tied bands
hold byte-identical pixel values — the tool picks the earlier and prints a NOTE). Using the
closed-interval test instead (`window_start <= start_h`) admits a band that *misses the
target's local 07:00 step and blends in the next day's* — a silent wrong-calendar-day error.

`geotiff_value_at.py` implements all of this; you just supply lat/lon/time.

---

## Supported products

`bgg-global-endpoints.md` lists **60 product codes** — 18 meteorological data types, each
published in some combination of three temporal forms:

- **Plain / hourly (20 products)** — instantaneous, **252 hourly bands** (f+0h … f+251h).
  Queried in **INSTANT** mode (`geotiff_value_at.py` picks the band whose `GRIB_VALID_TIME` is
  nearest `--time`, warning if >6 h away). `windvector` is 504 bands (u/v interleaved).
- **Day & Night (40 products = 20 × 2)** — 24-hour aggregation windows on a 12-hour stride,
  **20 bands** (f+24h … f+252h), value = the local-daytime (07–19) or local-night aggregate.
  Window-selected; DAY/NIGHT auto-detected from `-day-`/`-night-` in the filename. `windvector`
  day/night = 40 bands.

Fetch a product with `geotiff_fetch.py` (see [Usage](#usage)).
Values are decoded via each product's legend, **except `windvector`** (Int16 u/v, no palette →
`raw ÷ 100 = m/s`). Aggregation semantics follow the pipeline's `day_night_config.json`.

| # | Data type | Product code stem(s) (`bgg-global-[day-/night-]…`) | Forms | Unit | DAY / NIGHT agg |
|---|---|---|---|---|---|
| 1 | Air temperature | `temp-c-2meter` (plain); `temp-max-c-2meter`, `temp-min-c-2meter` (day/night) | P·D·N | °C | max / min* |
| 2 | Dew point | `dewpoint-c-surface` | P·D·N | °C | max / min |
| 3 | Feels-like (apparent) | `feelslike-c-2meter` | P·D·N | °C | max / min |
| 4 | Wet-bulb globe temp | `wetbulbglobe-c-2meter` | P·D·N | °C | max / min |
| 5 | Relative humidity | `relhumidity-2meter` | P·D·N | % | average |
| 6 | Total cloud cover | `cloud-total` | P·D·N | % | average |
| 7 | Mean sea-level pressure | `pressure-mb-surface` | P·D·N | mb | average |
| 8 | CAPE (surface) | `cape-jkg-surface` | P·D·N | J/kg | max |
| 9 | Precip probability | `precip-probability` | P·D·N | % | max |
| 10 | Precip rate | `preciprate-inph-surface` | P·D·N | in/hr | max |
| 11 | Accumulated precip | `precipaccum-in-surface` | P·D·N | in | max |
| 12 | Snow accum 1 hr | `snowaccum-1hr-in-surface` | P·D·N | in | sum |
| 13 | Snow accum 10:1 ratio | `snowaccum-in-10-1-surface` | P·D·N | in | max |
| 14 | Wind speed (10 m) | `windspeed-mph-10meter`, `windspeed-mps-10meter` | P·D·N (each) | mph / m/s | max |
| 15 | Wind gust (10 m) | `gust-mph-10meter`, `gust-mps-10meter` | P·D·N (each) | mph / m/s | max |
| 16 | Wind vector (10 m) | `windvector-10meter` | P·D·N | m/s (Int16 ÷100) | average (u,v) |
| 17 | Visibility | `visibility-miles-surface` | **P only** | miles | — |
| 18 | Weather code | `wxcode` | P·D·N | category (59-cat NWS) | most-common (priority-ranked) |

Forms: **P** = plain/hourly, **D** = `bgg-global-day-…`, **N** = `bgg-global-night-…`.
\*Temperature is the one exception to the naming: the plain form is instantaneous `temp-c-2meter`,
while day/night split into separate `temp-max` (agg max) and `temp-min` (agg min) products.
Visibility is published only as a plain hourly product (no day/night). Product tally: 20 plain +
20 day + 20 night = **60**. Several products carry mislabeled GRIB metadata and other quirks.

---

## Usage

### 1. Fetch

```bash
# Latest run of one daily product (keep this filename convention -- see note below)
python3 geotiff_fetch.py \
    --product bgg-global-day-temp-max-c-2meter \
    --projection Standard-Geodetic \
    --product-type forecast \
    --timestamp latest \
    --output download/bgg-global-day-temp-max-c-2meter_Standard-Geodetic_latest.tif

# List which model runs the API currently has
python3 geotiff_fetch.py --product bgg-global-day-temp-max-c-2meter \
    --projection Standard-Geodetic --product-type forecast --list-times
```

Notes:
- BGG products live on the `/meta/maps/` (forecast) endpoint; pass `--product-type forecast`
  to skip a wasted 404 probe of `/meta/tiles/` (the fetcher falls back automatically, so the
  flag is an optimization, not a requirement).
- `--timestamp` is a strictly-exclusive *older_than* query: asking for a run's **exact** init
  time silently resolves to the *previous* retained run (or nothing, if none is retained).
  Ask for 1 second later (`2026-07-21T00:00:01Z` resolves to the `2026-07-21T00:00:00Z` run).
- **Keep the `{product}_{projection}_…​.tif` filename convention** (the fetch commands above
  do): `geotiff_value_at.py` parses product and projection out of the filename to fetch the
  right legend, **and** detects DAY/NIGHT from `-day-`/`-night-` in the basename. Renaming a
  file breaks both — the legend part is fixable with `--legend legend.json`
  (`geotiff_fetch.py --save-legend` downloads one), but you must *also* pass
  `--period DAY|NIGHT`, or the tool silently falls back to INSTANT mode and returns a
  wrong-window value.

### 2. Query a value

```bash
python3 geotiff_value_at.py \
    --file download/bgg-global-day-temp-max-c-2meter_Standard-Geodetic_20260721T000000Z.tif \
    --lat 35.6895 --lon 139.6917 \
    --time 2026-07-25T03:00:00Z
```

Output:

```
File:              download/bgg-global-day-temp-max-c-2meter_Standard-Geodetic_20260721T000000Z.tif
Requested time:    2026-07-25T03:00:00Z
Pixel (col, row):  (3197, 543)  cell center=(35.700, 139.700)
Period:            DAY  (auto-detected)
Timezone:          Asia/Tokyo
Local date:        2026-07-25  (implied by --time in this timezone)
DAY window:         2026-07-24T22:00:00+00:00 -> 2026-07-25T10:00:00+00:00 UTC
Selected band:     8 of 20  (window 84h-108h, lead f+108h)
Band valid time:   2026-07-25T12:00:00Z
Variable:          Temperature [K]
Value:             27.5 °C  (pixel index 192)
```

Reading the output: the requested instant fell on local calendar date 2026-07-25 in Tokyo;
that date's DAY window (07:00–19:00 JST) is fully contained only by band 8, whose value at
this pixel legend-decodes to 27.5 °C — Tokyo's forecast daytime high for July 25.
(The `Variable:` line echoes raw GRIB metadata, which is occasionally mislabeled upstream;
the *product name* is authoritative for what the value means.)

### Flags (`geotiff_value_at.py`)

| Flag | Meaning |
|---|---|
| `--file` | GeoTIFF to read (required) |
| `--lat` / `--lon` | Query point, decimal degrees; lon accepts −180..180 or 0..360 (required) |
| `--time` | Target instant, ISO 8601 UTC, e.g. `2026-07-25T12:00:00Z` (required) |
| `--period DAY\|NIGHT\|INSTANT` | Override the filename-based auto-detection |
| `--list-times` | Dump every band's lead, valid time, and decoded value at this pixel, then exit |
| `--legend PATH` | Use a local legend JSON instead of fetching by product/projection |
| `--no-legend` | Print the raw palette index (offline; **not** a physical value for most variables) |
| `--day-start` / `--day-end` | Local clock hours of the DAY window (default 7/19). Must match the pipeline config the data was built with — they re-window band *selection* but cannot re-mask the aggregation already baked into the pixels |
| `--window-hrs` | Aggregation window width (default 24) |

Exit codes: `0` success, `1` error (bad input, point outside grid, no qualifying band),
`2` argparse usage error.

### Semantics worth knowing

- **`--time` → calendar date**: the instant is converted to the *pixel's* local time to pick
  the target calendar date. For **NIGHT**, "the night of date D" runs D 19:00 → D+1 07:00
  local, so a pre-dawn instant (local 00:00–06:59) attaches to the night that began the
  *previous* date — the selected window always contains your instant, and both halves of one
  physical night resolve to the same band.
- **Two qualifying bands**: some city/date/run combinations legitimately have two valid bands;
  the tool prints a NOTE and uses the earlier. Tied bands were verified to hold identical
  pixel values.
- **NODATA**: decided by the legend's *label* (empty or "Undefined"-style text). Transparent
  buckets with real labels (`0 in`, `0 %`, snowaccum's `0.1 in`) are correctly reported as
  values, not NODATA.
- **Clamped extremes**: legend end buckets like `< -85 °C` / `> 58 °C` are reported with a
  "clamped" note — the true value is at or beyond that bound.

---

## How `geotiff_value_at.py` works

1. **Snap** the query lat/lon to the nearest grid cell (reprojecting first if the file is not
   already WGS84 — Mercator files work too).
2. **Resolve the timezone at the snapped cell center**, not the raw query point — the
   pipeline keys each pixel's day/night mask to its cell-center timezone, so this matches the
   data even right next to a timezone border. (The ±180° seam is keyed at +180 to match the
   pipeline's source grid.)
3. **Derive the local calendar date** from `--time` in that timezone (NIGHT pre-dawn rule
   above), and build the local DAY or NIGHT window as a UTC interval.
4. **Select the band(s)** whose aggregation window fully contains that interval, using the
   half-open containment test derived from the pipeline's own aggregation loop
   (steps `ws+1 … ws+24`).
5. **Read the pixel** from the selected band and **decode** it through the product legend.

For INSTANT (non-day/night) files, steps 2–4 collapse to "nearest `GRIB_VALID_TIME`".

## Validation

The band-selection logic was validated against the pipeline source that produces this data
(`ds.global-fcst`'s `compute_day_night.py`) in a multi-agent, adversarially-verified review.
The validation harness and the pipeline source live outside this repo, so these results are
stated here for the record rather than reproducible from a clone:

- **Caveat on `BGG_Data_Interpretation_Guide.md`**: its worked examples claim several cities
  can use "either of two adjacent bands"; for Chicago and Jakarta one of each claimed pair is
  spurious under the pipeline's actual aggregation (same off-by-one). Trust this tool's
  selection over the guide's tables.

## Known limitations

- **Legend versioning**: legends are fetched at the *current* product version. If Baron ever
  changes a product's palette, decoding an archived GeoTIFF fetched before the change would
  silently use the new mapping. Save legends alongside archives (`--save-legend`) and pass
  them with `--legend` when querying old files.
- **DST edges**: the local day/night window's UTC span is evaluated at its start/end instants
  only; a DST transition *inside* the window can shift it by up to 1 h relative to the
  pipeline's per-hour masking (1–2 nights/year per affected zone).
- **Reprojected day/night files** (e.g. `Standard-Mercator`): pixels are resampled from the
  0.1° source grid, so near timezone borders a pixel may blend cells that were aggregated
  under different local clocks. Prefer `Standard-Geodetic` for point queries.
- **Hourly files queried as DAY/NIGHT**: if a plain hourly product is forced through
  day/night selection (e.g. via `--period DAY`), many overlapping bands qualify; the tool
  warns loudly and the result should not be trusted — use INSTANT mode.
