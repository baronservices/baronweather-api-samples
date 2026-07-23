#!/usr/bin/env python3
"""
Look up a BGG GeoTIFF's value at a given lat/lon and time.

Background
----------
BGG "day"/"night" GeoTIFFs (bgg-global-day-*, bgg-global-night-*) are the
same product family documented in ds.global-fcst's compute_day_night.py /
query_daily_by_latlon.py (see QUERYING_DAILY_BY_LATLON.md and
TOKYO_MAXTMP_WORKED_EXAMPLE.md there), just delivered as GeoTIFF instead of
NetCDF: each band is a 24h aggregation window (window_hrs=24) stepping every
12h (stride_hrs=12), and DAY/NIGHT is a *local, fixed-clock-hour* split
(day = local [07:00, 19:00), night = the rest) resolved per-pixel from that
pixel's own timezone -- not a single global UTC cutoff (see
BGG_Data_Interpretation_Guide.md). Which band's 24h window fully contains a
given local calendar date's DAY (or NIGHT) span depends on that pixel's UTC
offset relative to the model's init time -- it is not the same band for
every city, or even for the same city on every model run.

This script:
  1. Snaps lat/lon to this GeoTIFF's nearest grid cell and resolves the IANA
     timezone AT THAT SNAPPED CELL CENTER, not the raw query point -- the
     pipeline keys each pixel's day/night split to its own cell-center
     timezone, and resolving at the raw point can pick the wrong side of a
     timezone border (see ds.global-fcst's
     REVIEW_FINDINGS_query_daily_by_latlon.md, finding on
     query_daily_by_latlon.py:165).
  2. Converts --time (UTC) to that timezone to get the local calendar date.
     For NIGHT, an instant before day-start (local 00:00-06:59) attaches to
     the night that BEGAN the previous calendar date -- the product's "night
     of date D" runs D 19:00 -> D+1 07:00 local, so this keeps the selected
     window containing the requested instant.
  3. Builds the local DAY or NIGHT window for that date and finds which
     band(s) fully contain it, using a half-open containment test: a band's
     window covers hours (window_start, window_end] since model init, not
     the closed interval -- the same review flagged the closed-interval
     version (query_daily_by_latlon.py:117) as both admitting windows that
     miss the target's first hour and discarding windows that are genuinely
     valid.
  4. Reads the pixel value from the selected band and decodes it through the
     product's legend (see below) -- NOT the raw byte, which is a palette
     index, not the physical value.

GeoTIFF pixels are Byte (0-255) palette INDEXES, not physical values.
Baron's own legend endpoint (https://static.velocityweather.com/legends/
{product}/{projection}/geotiff_legend.json -- same one geotiff_fetch.py's
--save-legend hits) maps each index to a real value string, e.g. index 192
for a temperature product decodes to "27.5 °C", not 192 K/C. Some
products (e.g. cloud-total) happen to have an identity legend (index i ->
"i %"), so the raw byte looks like a sane answer by coincidence -- but that
is not true in general (confirmed: bgg-global-day-temp-max-c-2meter's index
192 legend-decodes to 27.5 degC, nothing close to 192 in either K or C).
This script always decodes through the legend and only falls back to the
raw index (with a loud warning) if the legend can't be fetched.

Plain (non day/night) BGG products -- e.g. bgg-global-cloud-total -- have no
day/night window semantics; for those this script just finds the band whose
GRIB_VALID_TIME is nearest to --time.

Caveats (inherited from the same window-selection approach in
query_daily_by_latlon.py):
  - DST approximation: the local day/night window's UTC span is evaluated
    only at its start/end instants, so a DST transition landing inside the
    window can be off by up to 1h.
  - No timezone resolved falls back to UTC (in practice timezonefinder
    blankets oceans with Etc/GMT zones, so this path is rarely reached).
  - When a pixel's UTC offset aligns with the 12h window grid, two adjacent
    bands both fully contain the span; either is equally correct (verified:
    genuinely-tied bands hold byte-identical values). This script picks the
    earlier one and prints a NOTE.
  - --day-start/--day-end must match the pipeline config the data was built
    with (7/19): they re-window band SELECTION but cannot re-mask the
    aggregation already baked into the pixels.

Usage:
    python geotiff_value_at.py \
        --file download/bgg-global-day-cloud-total_Standard-Geodetic_20260721T000000Z.tif \
        --lat 41.8781 --lon -87.6298 --time 2026-07-24T18:00:00Z
"""

import argparse
import datetime
import json
import math
import os
import sys
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

from osgeo import gdal, osr

gdal.UseExceptions()

try:
    from timezonefinder import TimezoneFinder
except ImportError:
    sys.exit("timezonefinder is required: pip install timezonefinder")

DAY_START = 7
DAY_END = 19
WINDOW_HRS = 24
LEGEND_BASE_URL = "https://static.velocityweather.com/legends"


def parse_iso_gmt(value):
    text = value.strip().upper().replace("Z", "+00:00")
    dt = datetime.datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt.astimezone(datetime.timezone.utc)


def grib_epoch(value):
    """Parse a GRIB time metadata item as an integer. Current GDAL emits bare
    epoch seconds; older GDALs emit e.g. '1784592000 sec UTC'."""
    return int(str(value).strip().split()[0])


def normalize_lon(lon):
    return ((lon + 180) % 360) - 180


def detect_period(filepath):
    name = os.path.basename(filepath).lower()
    if "-day-" in name:
        return "DAY"
    if "-night-" in name:
        return "NIGHT"
    return None


def parse_product_projection(filepath):
    """Best-effort split of 'PRODUCT_PROJECTION_timestamp.tif' -> (product, projection).
    Matches geotiff_fetch.py's own naming convention (product and projection
    both use hyphens internally, so splitting the stem on '_' is safe)."""
    stem = os.path.splitext(os.path.basename(filepath))[0]
    parts = stem.split("_")
    if len(parts) < 2:
        return None, None
    return parts[0], parts[1]


def validate_legend(legend, source):
    """Sanity-check a parsed legend's structure; return it, or None (with a
    stderr warning) if it isn't a usable palettes/entries document."""
    try:
        entries = legend["palettes"][0]["entries"]
        if not isinstance(entries, list) or not entries:
            raise ValueError("empty entries")
    except (KeyError, IndexError, TypeError, ValueError):
        print(
            f"WARNING: legend from {source} is malformed -- "
            "showing raw pixel index, NOT the decoded physical value.",
            file=sys.stderr,
        )
        return None
    return legend


def fetch_legend(product, projection):
    """Fetch the product's index->value legend (public, no auth) -- the same
    endpoint geotiff_fetch.py's --save-legend uses. Returns the parsed dict,
    or None (with a stderr warning) if it can't be fetched or is malformed."""
    if not product or not projection:
        print(
            "WARNING: could not determine product/projection from the filename -- "
            "showing raw pixel index, NOT the decoded physical value.",
            file=sys.stderr,
        )
        return None
    url = f"{LEGEND_BASE_URL}/{product}/{projection}/geotiff_legend.json"
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            legend = json.load(resp)
    except (OSError, ValueError) as e:  # URLError/HTTPError/timeout/bad JSON
        print(
            f"WARNING: could not fetch legend from {url} ({e}) -- "
            "showing raw pixel index, NOT the decoded physical value.",
            file=sys.stderr,
        )
        return None
    return validate_legend(legend, url)


NODATA_TEXT = {"", "undefined", "no data", "nodata", "n/a", "none", "null", "transparent"}


def decode_via_legend(legend, pixel_value):
    """Return the legend's decoded label for this palette index, or None for a
    no-data entry.

    No-data detection is LABEL-based, not alpha-based: several BGG legends
    render physically-valid buckets transparent -- precipaccum '0 in',
    preciprate '0 in/hr', cloud-total/relhumidity/precip-probability '0 %',
    and snowaccum's *nonzero* '0.1 in' bucket all carry alpha==0 -- so the
    display-raster convention (alpha==0 == nodata, as in geotiff_fetch's
    indexed_to_float.py) would wrongly report NODATA for the most common
    values on Earth in a value query. A label that is empty or a known no-data word (e.g.
    north-american-radar's 'Undefined' indices 0-66) is no-data; any other
    label -- numeric or categorical (wxcode) -- is a real value regardless of
    transparency.
    """
    if legend is None:
        return None
    try:
        entries = legend["palettes"][0]["entries"]
    except (KeyError, IndexError, TypeError):
        return None
    idx = int(pixel_value)
    if not (0 <= idx < len(entries)):
        return None
    label = (entries[idx].get("value") or "").strip()
    if label.lower() in NODATA_TEXT:
        return None
    return label


def format_pixel(value, legend):
    """Compact decoded representation shared by --list-times and errors."""
    decoded = decode_via_legend(legend, value)
    if legend is not None and decoded is None:
        return f"NODATA (index {value})"
    if decoded is not None:
        return f"{decoded} (index {value})"
    return f"{value} (raw palette index, no legend)"


def lonlat_to_pixel(ds, lon, lat):
    """Convert a WGS84 lon/lat into (col, row, snapped_cell_lon, snapped_cell_lat)."""
    src_srs = osr.SpatialReference()
    src_srs.SetWellKnownGeogCS("WGS84")
    src_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)

    dst_srs = osr.SpatialReference()
    dst_srs.ImportFromWkt(ds.GetProjection())
    dst_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)

    to_raster = osr.CoordinateTransformation(src_srs, dst_srs)
    x, y, _ = to_raster.TransformPoint(lon, lat)

    gt = ds.GetGeoTransform()
    inv_gt = gdal.InvGeoTransform(gt)
    px, py = gdal.ApplyGeoTransform(inv_gt, x, y)
    # floor, not int(): int() truncates toward zero, which would silently
    # accept points up to one full pixel outside the west/north edge
    # (px in (-1, 0) -> col 0) instead of failing the bounds check.
    col, row = math.floor(px), math.floor(py)

    # Snapped cell CENTER, converted back to WGS84 -- this is what gets fed
    # to TimezoneFinder, not the raw query point (see module docstring).
    cx, cy = gdal.ApplyGeoTransform(gt, col + 0.5, row + 0.5)
    from_raster = osr.CoordinateTransformation(dst_srs, src_srs)
    cell_lon, cell_lat, _ = from_raster.TransformPoint(cx, cy)

    return col, row, cell_lon, cell_lat


def resolve_timezone(lat, lon):
    """Resolve the IANA timezone at a grid-cell center.

    The antimeridian is keyed at lng=+180.0, matching the pipeline: its tz
    raster is built on the 0..359.9 source grid whose seam column is 180.0
    (compute_day_night.py normalizes with a strict `lons > 180`, leaving
    180.0 as +180), and timezonefinder returns different zones for +180 vs
    -180 at ~305 of the 1801 grid latitudes. Both duplicate seam columns of
    the GeoTIFF (col 0 center -180.0, col 3600 center +180.0) carry that same
    source column's data, so both are keyed at +180.0 here.
    """
    tf = TimezoneFinder()
    lng = lon if -180.0 <= lon <= 180.0 else normalize_lon(lon)
    if lng == -180.0:
        lng = 180.0
    tz_name = tf.timezone_at(lng=lng, lat=lat)
    if tz_name is None:
        print(
            f"WARNING: no timezone resolved at cell center ({lat:.4f}, {lon:.4f}) -- "
            "falling back to UTC (matches the BGG pipeline's behavior for points "
            "it can't classify).",
            file=sys.stderr,
        )
        tz_name = "UTC"
    return tz_name


def local_window_utc(target_date, tz_name, period, day_start=DAY_START, day_end=DAY_END):
    """Return (start_utc, end_utc) for the DAY or NIGHT window on
    target_date's *local* calendar date, fixed-clock-hour convention."""
    tz = ZoneInfo(tz_name)
    if period == "DAY":
        start_local = datetime.datetime(target_date.year, target_date.month, target_date.day, day_start, tzinfo=tz)
        end_local = datetime.datetime(target_date.year, target_date.month, target_date.day, day_end, tzinfo=tz)
    elif period == "NIGHT":
        start_local = datetime.datetime(target_date.year, target_date.month, target_date.day, day_end, tzinfo=tz)
        end_local = start_local + datetime.timedelta(hours=24 - (day_end - day_start))
    else:
        raise ValueError(f"period must be DAY or NIGHT, got {period!r}")
    utc = datetime.timezone.utc
    return start_local.astimezone(utc), end_local.astimezone(utc)


def find_qualifying_bands(ds, start_utc, end_utc, window_hrs=WINDOW_HRS):
    """
    Return every band whose 24h aggregation window fully contains
    [start_utc, end_utc]. A band's window covers the HALF-OPEN interval
    (window_start, window_end] hours-since-init (steps window_start+1 ..
    window_end), not the closed interval -- so containment requires
    `window_start < start_h` (strict) and `window_end >= end_h - 1`
    (the window's last hourly step is at end_h - 1, since the local window's
    end instant itself is exclusive). Exhaustively validated against a
    simulation of compute_day_night.py's aggregation across every UTC offset
    (-12..+14 in 15-min steps) x 13 target dates x DAY/NIGHT: zero mismatches.
    """
    candidates = []
    for b in range(1, ds.RasterCount + 1):
        band = ds.GetRasterBand(b)
        ref_time = band.GetMetadataItem("GRIB_REF_TIME")
        fcst_secs = band.GetMetadataItem("GRIB_FORECAST_SECONDS")
        if ref_time is None or fcst_secs is None:
            continue

        ref_dt = datetime.datetime.fromtimestamp(grib_epoch(ref_time), tz=datetime.timezone.utc)
        window_end_h = grib_epoch(fcst_secs) / 3600.0
        window_start_h = window_end_h - window_hrs

        start_h = (start_utc - ref_dt).total_seconds() / 3600.0
        end_h = (end_utc - ref_dt).total_seconds() / 3600.0

        if window_start_h < start_h and window_end_h >= end_h - 1:
            valid_dt = ref_dt + datetime.timedelta(hours=window_end_h)
            candidates.append((b, window_start_h, window_end_h, valid_dt))
    return candidates


def find_nearest_band(ds, target_dt):
    """No day/night semantics (plain/hourly product) -- just nearest GRIB_VALID_TIME."""
    target_epoch = target_dt.timestamp()
    best = None
    for b in range(1, ds.RasterCount + 1):
        band = ds.GetRasterBand(b)
        valid_time = band.GetMetadataItem("GRIB_VALID_TIME")
        if valid_time is None:
            continue
        diff = abs(grib_epoch(valid_time) - target_epoch)
        if best is None or diff < best[1]:
            best = (b, diff, grib_epoch(valid_time))
    if best is None:
        raise ValueError("No band in this file has GRIB_VALID_TIME metadata")
    return best


def list_bands(ds, col, row, legend):
    """Dump every band's lead/valid time and decoded value at this pixel."""
    for b in range(1, ds.RasterCount + 1):
        b_obj = ds.GetRasterBand(b)
        fcst_secs = b_obj.GetMetadataItem("GRIB_FORECAST_SECONDS")
        valid_time = b_obj.GetMetadataItem("GRIB_VALID_TIME")
        if fcst_secs is None or valid_time is None:
            print(f"  band={b:2d} (no GRIB time metadata)")
            continue
        vdt = datetime.datetime.fromtimestamp(grib_epoch(valid_time), tz=datetime.timezone.utc)
        v = b_obj.ReadAsArray(col, row, 1, 1)[0, 0]
        print(f"  band={b:2d} lead=f+{grib_epoch(fcst_secs) // 3600:4d}h valid={vdt.isoformat()} value={format_pixel(v, legend)}")


def is_windvector(ds, filepath):
    """windvector products are Int16 u/v pairs (UGRD then VGRD per step), no legend."""
    el = ds.GetRasterBand(1).GetMetadataItem("GRIB_ELEMENT")
    return el in ("UGRD", "VGRD") or "windvector" in os.path.basename(filepath).lower()


def print_windvector(ds, u_band_idx, col, row):
    """Decode and print the 10 m wind vector for the step whose u-component is at
    u_band_idx (v-component is the next band). Int16 counts are m/s x 100 -- there
    is no palette. Reports u/v components, speed, and meteorological direction."""
    u_raw = int(ds.GetRasterBand(u_band_idx).ReadAsArray(col, row, 1, 1)[0, 0])
    v_raw = int(ds.GetRasterBand(u_band_idx + 1).ReadAsArray(col, row, 1, 1)[0, 0])
    u, v = u_raw / 100.0, v_raw / 100.0           # eastward, northward (m/s)
    speed = math.hypot(u, v)
    direction = math.degrees(math.atan2(-u, -v)) % 360   # degrees the wind blows FROM
    print("Variable:          10 m wind vector (UGRD/VGRD, Int16 x100 -> m/s)")
    print(f"Value:             u={u:+.2f} m/s  v={v:+.2f} m/s   (raw Int16 {u_raw:+d}/{v_raw:+d})")
    print(f"                   speed={speed:.2f} m/s ({speed * 2.2369362920544:.1f} mph)  "
          f"direction={direction:.0f} deg (from)")


def print_value(band, col, row, legend):
    value = band.ReadAsArray(col, row, 1, 1)[0, 0]
    nodata = band.GetNoDataValue()
    comment = band.GetMetadataItem("GRIB_COMMENT") or ""
    if comment:
        print(f"Variable:          {comment}")
    if nodata is not None and value == nodata:
        print("Value:             NODATA")
        return

    decoded = decode_via_legend(legend, value)
    if decoded is None and legend is not None:
        print(f"Value:             NODATA (legend marks pixel index {value} as no-data)")
    elif decoded is not None:
        clamped = decoded.startswith(("<", ">"))
        note = "  (clamped to legend's min/max bucket, not exact)" if clamped else ""
        print(f"Value:             {decoded}  (pixel index {value}){note}")
    else:
        print(f"Value:             {value}  ** RAW PALETTE INDEX, not a physical value (no legend available) **")


def main():
    """CLI entry point: validate inputs, snap the query point, pick the band
    (window-selected for DAY/NIGHT files, nearest-valid-time for INSTANT),
    and print the legend-decoded value.

    Returns a process exit code: 0 on success, 1 on any input/data error
    (argparse itself exits 2 on usage errors).
    """
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--file", required=True, metavar="PATH", help="GeoTIFF file to read")
    parser.add_argument("--lat", required=True, type=float, help="Latitude in decimal degrees")
    parser.add_argument("--lon", required=True, type=float, help="Longitude in decimal degrees")
    parser.add_argument("--time", required=True, metavar="ISO_TIME", help="Target time, ISO 8601 GMT/UTC (e.g. 2026-07-25T12:00:00Z)")
    parser.add_argument("--period", choices=["DAY", "NIGHT", "INSTANT"], default=None,
                         help="Override auto-detection from the filename (looks for '-day-'/'-night-' in the basename)")
    parser.add_argument("--day-start", type=int, default=DAY_START,
                         help=f"Local hour DAY starts (default {DAY_START}). Must match the pipeline config the data was built with -- changes band selection but cannot re-mask the aggregation baked into the pixels")
    parser.add_argument("--day-end", type=int, default=DAY_END,
                         help=f"Local hour DAY ends (default {DAY_END}). Same caveat as --day-start")
    parser.add_argument("--window-hrs", type=int, default=WINDOW_HRS, help=f"Aggregation window width in hours (default {WINDOW_HRS})")
    parser.add_argument("--list-times", action="store_true", help="Dump every band's valid time and value at this lat/lon, skip band selection")
    legend_group = parser.add_mutually_exclusive_group()
    legend_group.add_argument("--legend", metavar="PATH", default=None, help="Use a local legend JSON instead of fetching one from the product/projection parsed out of --file")
    legend_group.add_argument("--no-legend", action="store_true", help="Skip legend decoding entirely and print the raw palette index (fast, offline, but NOT the physical value for most variables)")
    args = parser.parse_args()

    if not (math.isfinite(args.lat) and -90 <= args.lat <= 90):
        print(f"Error: latitude {args.lat} is out of range", file=sys.stderr)
        return 1
    if not math.isfinite(args.lon):
        print(f"Error: longitude {args.lon} is not a finite number", file=sys.stderr)
        return 1

    try:
        target_dt = parse_iso_gmt(args.time)
    except ValueError as e:
        print(f"Error: could not parse --time {args.time!r} as ISO 8601 (e.g. 2026-07-25T12:00:00Z): {e}", file=sys.stderr)
        return 1

    lon = normalize_lon(args.lon)

    ds = gdal.Open(args.file)

    col, row, cell_lon, cell_lat = lonlat_to_pixel(ds, lon, args.lat)
    if not (0 <= col < ds.RasterXSize and 0 <= row < ds.RasterYSize):
        print(f"Error: lat/lon ({args.lat}, {args.lon}) falls outside this GeoTIFF's extent", file=sys.stderr)
        return 1

    period = args.period or detect_period(args.file) or "INSTANT"
    wv = is_windvector(ds, args.file)   # Int16 u/v pairs; decoded via /100, not a legend

    if wv or args.no_legend:
        legend = None
    elif args.legend:
        try:
            with open(args.legend) as f:
                legend = validate_legend(json.load(f), args.legend)
        except (OSError, ValueError) as e:
            print(f"Error: could not load legend {args.legend}: {e}", file=sys.stderr)
            return 1
    else:
        product, projection = parse_product_projection(args.file)
        legend = fetch_legend(product, projection)

    print(f"File:              {args.file}")
    print(f"Requested time:    {target_dt.isoformat().replace('+00:00', 'Z')}")
    print(f"Pixel (col, row):  ({col}, {row})  cell center=({cell_lat:.3f}, {cell_lon:.3f})")
    print(f"Period:            {period}{'  (auto-detected)' if args.period is None and period != 'INSTANT' else ''}")

    if period == "INSTANT":
        if args.list_times:
            list_bands(ds, col, row, legend)
            return 0
        band_idx, diff_secs, valid_epoch = find_nearest_band(ds, target_dt)
        band = ds.GetRasterBand(band_idx)
        valid_dt = datetime.datetime.fromtimestamp(valid_epoch, tz=datetime.timezone.utc)
        print(f"Matched band:      {band_idx} of {ds.RasterCount}")
        print(f"Band valid time:   {valid_dt.isoformat().replace('+00:00', 'Z')}  (off by {diff_secs / 3600:.1f}h)")
        if diff_secs > 6 * 3600:
            print(
                f"WARNING: requested time is {diff_secs / 3600:.1f}h from the nearest band -- "
                "this file may not cover the requested time.",
                file=sys.stderr,
            )
    else:
        tz_name = resolve_timezone(cell_lat, cell_lon)
        local_dt = target_dt.astimezone(ZoneInfo(tz_name))
        target_local_date = local_dt.date()
        attach_note = ""
        if period == "NIGHT" and local_dt.hour < args.day_start:
            # The night of date D runs D 19:00 -> D+1 07:00 local; a pre-dawn
            # instant belongs to the night that began the previous date.
            target_local_date -= datetime.timedelta(days=1)
            attach_note = "  (pre-dawn instant attaches to the night that began this date)"
        start_utc, end_utc = local_window_utc(target_local_date, tz_name, period, args.day_start, args.day_end)

        print(f"Timezone:          {tz_name}")
        print(f"Local date:        {target_local_date}  (implied by --time in this timezone){attach_note}")
        print(f"{period} window:         {start_utc.isoformat()} -> {end_utc.isoformat()} UTC")

        if args.list_times:
            list_bands(ds, col, row, legend)
            return 0

        candidates = find_qualifying_bands(ds, start_utc, end_utc, args.window_hrs)
        if wv:
            # u and v of one step share a window; count STEPS by keeping only the u bands
            candidates = [c for c in candidates if ds.GetRasterBand(c[0]).GetMetadataItem("GRIB_ELEMENT") == "UGRD"]
        if not candidates:
            print(
                "Error: no forecast band fully contains this local day/night span -- "
                "check that --time falls within the model's lead time, or use --list-times to inspect the file.",
                file=sys.stderr,
            )
            return 1

        candidates.sort(key=lambda c: c[2])
        if len(candidates) > 2:
            print(
                f"WARNING: {len(candidates)} overlapping bands qualify -- this file's band layout does not "
                "look like a 24h-window/12h-stride day/night product (plain hourly product?). "
                "The result below is unreliable; consider --period INSTANT.",
                file=sys.stderr,
            )
        elif len(candidates) == 2:
            leads = [f"f+{int(c[2])}h" for c in candidates]
            print(f"NOTE: 2 bands fully contain this span ({', '.join(leads)}); using the earliest -- either is equally correct.")

        band_idx, window_start_h, window_end_h, valid_dt = candidates[0]
        band = ds.GetRasterBand(band_idx)
        print(f"Selected band:     {band_idx} of {ds.RasterCount}  (window {int(window_start_h)}h-{int(window_end_h)}h, lead f+{int(window_end_h)}h)")
        print(f"Band valid time:   {valid_dt.isoformat().replace('+00:00', 'Z')}")

    if wv:
        el = ds.GetRasterBand(band_idx).GetMetadataItem("GRIB_ELEMENT")
        u_idx = band_idx - 1 if el == "VGRD" else band_idx
        print_windvector(ds, u_idx, col, row)
    else:
        print_value(band, col, row, legend)
    return 0


if __name__ == "__main__":
    sys.exit(main())
