# Baron GeoTIFF Fetch + Colorize

Fetch one [Baron Weather](https://www.baronweather.com/) GeoTIFF from the Velocity Weather
API, fetch its legend, and write a copy that carries the legend **inside the file**. The
coloured copy needs no sidecar and no external legend: it opens in QGIS, ArcGIS, or any GDAL
reader and shows the right colours.

## Why this exists

GeoTIFFs from the API are **palette-indexed 8-bit rasters**. A pixel holds a palette index,
not a physical value. Index 192 in a temperature product means 27.5 °C, not 192 K, and index
67 in a radar product means 0.5 dBZ. The index-to-colour and index-to-label mapping lives in
a separate legend document on a public CDN.

So a raw file opened in a GIS renders as a flat grey ramp and reads as nonsense. This tool
closes that gap in one command.

## Repository layout

| File | Purpose |
|---|---|
| `baron_geotiff.py` | The tool: fetch → legend → coloured copy |
| `selftest.py` | Offline test harness for the legend parsing and palette embedding. No network, no credentials |
| `env.example` | Credential template. Copy to `.env` |

## Requirements

- Python 3.9+
- `requests` and `tenacity` — for fetching
- `GDAL` (osgeo bindings) and `numpy` — for the coloured copy only. Imported lazily, so
  `--no-color` works on a machine without GDAL.

## Credentials

Copy the example file and fill in your own key and secret:

```bash
cp env.example .env
```

Either name pair works. `BARON_API_KEY` / `BARON_API_SECRET` is checked first,
`BARON_ACCESS_KEY` / `BARON_ACCESS_KEY_SECRET` is the fallback, so one `.env` can serve every
tool folder in this repository. `BARON_API_BASE_URL` is optional and accepts the host with or
without its `/v1` segment.

**The file is the only source.** Environment variables are not read. Exporting
`BARON_API_KEY` has no effect. One visible file is easier to audit than a value that could
arrive from a shell, a container, or a cron environment, and a stale exported key silently
overriding the file is a confusing failure to diagnose.

Left at its default, `--env` searches the current working directory, then the folder holding
the script. An explicit `--env PATH` is used exactly as given and never falls back.

Legend download needs no credentials at all — the legend CDN is public.

## Quick start

```bash
# What instances exist?
python3 baron_geotiff.py --product north-american-radar --projection Standard-Mercator \
    --list-times 3

# Fetch the latest one
python3 baron_geotiff.py --product north-american-radar --projection Standard-Mercator \
    --output radar.tif
```

Three files land:

```
radar.tif            exactly what the API delivered, byte for byte
radar_color.tif      the same pixels, with the palette and labels embedded
radar_legend.json    the legend document as fetched
```

## What ends up inside the coloured file

| Item | Location |
|---|---|
| Colour table, RGB | Band 1, `ColorInterp=Palette` |
| Internal mask band | Band 1, marking every pixel whose palette alpha is 0 |
| `VALUE_<index>` | Band 1 metadata, one per labelled index |
| `ALPHA_<index>` | Band 1 metadata, for each index whose alpha is not 255 |
| `LEGEND_JSON` | Dataset metadata, the whole legend document |
| `PRODUCT`, `PROJECTION`, `INSTANCE_TIME`, `LEGEND_URL`, `LEGEND_PALETTE_INDEX` | Dataset metadata |

`Undefined` labels are skipped, so the metadata block stays readable.

### Transparency, and why it is not in the colour table

**A TIFF colour map holds RGB and nothing else.** GDAL accepts a 4-tuple and drops the alpha
when it writes the tag, so a palette on its own would render a transparent no-data head as
solid black. A radar legend marks indices 0–66 transparent, which is most of the country on a
quiet day.

Three carriers cover it instead:

- **An internal mask band** marks those pixels invalid. It lives inside the TIFF, not in a
  `.msk` sidecar, and GDAL and QGIS honour it. This is what makes the file render correctly.
- **`ALPHA_<index>` tags** keep the exact numbers, including partial alpha that no raster
  palette can express.
- **`LEGEND_JSON`** keeps the whole legend with RGBA intact.

The mask costs file size: the radar sample below grows from 1.36 MB to 1.89 MB. Use
`--no-color` if you only want the raw download.

### Pixels are never rewritten

The coloured copy is a byte-for-byte copy of the download, with the palette, the metadata,
and the mask attached afterwards. Values, NoData, compression, and georeferencing are exactly
what the API delivered, so the file is still queryable by index:

```bash
$ gdalinfo -checksum radar.tif       | grep Checksum
  Checksum=30348
$ gdalinfo -checksum radar_color.tif | grep Checksum
  Checksum=30348
```

Transparent indices are **not** remapped to a NoData value. That is a common shortcut and it
destroys the very index values a point query needs.

## Arguments

### Product

| Argument | Default | Meaning |
|---|---|---|
| `--product CODE` | required | Product code, e.g. `C39-0x03EA-0` or `north-american-radar` |
| `--projection NAME` | `Standard-Mercator` | Projection name. Also selects the legend |
| `--product-type TYPE` | `observational` | `observational` uses `/meta/tiles/`, `forecast` uses `/meta/maps/`. The other is tried as a fallback |

### Time

| Argument | Default | Meaning |
|---|---|---|
| `--timestamp TIME` | `latest` | `latest`, or an exact ISO 8601 time such as `2026-08-11T04:56:39Z` |
| `--list-times [N]` | — | Print the N most recent instance times and exit. N defaults to 10 |

An exact `--timestamp` is used **verbatim** and fails if that instance does not exist. It is
deliberately not resolved through a metadata lookup: an `older_than` query returns the newest
instance *before* the requested time, which silently hands back a different frame than the one
asked for.

### Output

| Argument | Default | Meaning |
|---|---|---|
| `--output PATH` | `<product>_<projection>_<time>.tif` | The raw GeoTIFF. The other two files are named from this |
| `--color-output PATH` | `<stem>_color.tif` | The coloured copy |
| `--save-legend PATH` | `<stem>_legend.json` | The legend document |
| `--no-color` | off | Skip the coloured copy. GDAL is then not needed |
| `--qml` | off | Also write a QGIS `.qml` style sidecar |

`<stem>` is `--output` without its `.tif` extension, so `--output` alone relocates the whole
set.

### Legend

| Argument | Default | Meaning |
|---|---|---|
| `--legend PATH` | — | Read the legend from a local JSON file instead of the CDN |
| `--palette N` | `0` | Which palette to embed when a legend holds several |

### Plumbing

| Argument | Default | Meaning |
|---|---|---|
| `--env PATH` | `.env` | Credential file |
| `--log-file PATH` | `logs/baron_geotiff.log` | Log file |
| `--log-level LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, or `ERROR` |
| `--quiet` | off | Suppress progress output. Errors still go to stderr |

At `DEBUG` the log records full signed API URLs and presigned S3 URLs. Both handlers follow
`--log-level` rather than pinning the file to `DEBUG`, so a long-lived log file does not
quietly become a plain-text credential store.

`--quiet` silences the summary lines but not failures: a cron job that fails should say so,
and stderr is what cron mails out. `--list-times` still prints under `--quiet`, because there
the listing is the requested output rather than progress chatter.

## Multi-palette legends

A `Mask1-Mercator` radar legend holds **three** palettes — rain, mixed, and snow — and a TIFF
holds one colour table. `--palette` selects which to embed, and the choice is recorded as
`LEGEND_PALETTE_INDEX` in the output.

```bash
# The snow palette
python3 baron_geotiff.py --product north-american-radar --projection Mask1-Mercator \
    --palette 2
```

To produce all three from one download, fetch once and then re-run against the saved legend.
Nothing is refetched:

```bash
python3 baron_geotiff.py --product north-american-radar --projection Mask1-Mercator \
    --output radar.tif
python3 baron_geotiff.py --product north-american-radar --projection Mask1-Mercator \
    --output radar.tif --legend radar_legend.json --palette 1 \
    --color-output radar_mixed.tif
```

## Verifying an output

```bash
$ gdalinfo radar_color.tif | grep -E 'Color Table|Mask Flags|VALUE_67|ALPHA_0|PRODUCT'
  PRODUCT=north-american-radar
  Mask Flags: PER_DATASET
    VALUE_67=0.5 dBZ
    ALPHA_0=0
  Color Table (RGB with 256 entries)
```

A value at a point still decodes through the labels, because the indices survived. Note the
coordinates go in on stdin: GDAL's newer argument parser reads a leading-minus longitude as an
option flag.

```bash
$ echo "-53.80 48.78" | gdallocationinfo -valonly -wgs84 radar_color.tif
153
$ gdalinfo radar_color.tif | grep 'VALUE_153='
    VALUE_153=43.5 dBZ
```

An index of 66 or below is part of the transparent no-data head, which is what the mask band
marks.

## Tests

```bash
python3 selftest.py
```

Offline, no credentials, no network. It builds a synthetic palette-indexed GeoTIFF and
synthetic legends, then drives the real code against them: both legend shapes, alpha in the
last two hex digits, `Undefined` exclusion, multi-palette selection, malformed input, the
colour table and mask reaching the file, pixel identity, the `VALUE_`/`ALPHA_` tags,
`LEGEND_JSON` round-tripping, the non-Byte and multi-band guards, and the QML sidecar.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Fatal error, nothing downloaded |
| 2 | The raw GeoTIFF was saved, but the legend or the coloured copy failed |

Code 2 is the useful one: a missing GDAL, a legend 404, or a raster that is not 8-bit indexed
all leave the download in place. Re-run with `--legend` against the saved legend to finish the
job without refetching.

## Related tools

`../bgg-forecast/geotiff_fetch.py` fetches time ranges in bulk and covers BGG band selection.
`../bgg-forecast/geotiff_value_at.py` does point queries with legend decoding. This folder is
deliberately narrower: one instance, one embedded palette.
