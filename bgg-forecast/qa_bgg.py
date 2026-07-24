#!/usr/bin/env python3
"""
qa_bgg.py -- on-demand meteorological QA for BGG global GeoTIFF products.

Runs the automatable subset of BGG_QA_TEST_PLAN.md against a folder of BGG
GeoTIFFs (the products in bgg-global-endpoints.md). Per product it checks
structure, time-metadata integrity, legend decode, physical-range bounds,
a georeference anchor for temperature-like fields, spatial non-degeneracy,
and frozen-band / accumulation checks; across products present in the folder
it checks the inter-variable inequalities (Td<=T, gust>=wind, mph=mps*k,
vector speed = windspeed, temp-min<=temp-max). Prints a per-product
PASS/WARN/FAIL report and exits nonzero on any FAIL.

Usage:
    python3 qa_bgg.py --dir download [--legends download] [--strict] [-v]
                      [--cross-sample-bands 3] [--wx-sample-bands 3]
                      [--json report.json]

Verbose mode writes JSON-lines trace records to stderr. Aggregate checks report
their inputs and outcome; pixel rules report cell coordinates, model time,
classification labels, values, predicate, and PASS/FAIL result. Per-pixel output
can be enormous on global rasters; redirect stderr to a file or use
--verbose-pixel-limit while investigating.

Condition-aware checks (calibrated against the 2026-07-22T12Z reference run):
month-aware desert/antipode anchors per temperature-like product (summer
hemisphere carries the requirement; dewpoint uses a season-independent
dry-desert-vs-marine-antipode test), zonal summer/winter asymmetry, diurnal
phase of the plain temperature field, per-band global-mean stability and
flat-band detection from the palette histograms, cumulative-accumulation
monotonicity, clamp-bucket usage accounting, snow=>cold, and wind-chill /
heat-index regime sign tests.

Each product's own legend is tried first, locally and then from the CDN.
Known sibling legends are fallback-only (mps day/night -> plain mps;
day/night wxcode -> plain wxcode; plain precip-probability -> day
precip-probability). windvector has no palette and decodes as Int16/100 = m/s.

Reads band-by-band (never the whole 252-band stack) and streams cross-product
samples instead of retaining every product array in memory.
"""
import argparse, datetime, glob, json, math, os, re, sys, urllib.request
from collections import defaultdict
import numpy as np
from osgeo import gdal
gdal.UseExceptions()
gdal.SetConfigOption("GDAL_PAM_ENABLED", "NO")
gdal.SetCacheMax(256 * 1024 * 1024)

CDN = "https://static.velocityweather.com/legends"
GT = (-180.05, 0.1, 0.0, 90.05, 0.0, -0.1)
NX, NY = 3601, 1801
MPH_PER_MPS = 2.2369362920544

# ----- condition-aware validation constants ----------------------------------
# Calibrated against the clean 2026-07-22T12Z reference run (see
# QA_BGG_REVIEW_FINDINGS.md): plain-temp global mean spread 1.27 C / max step
# 0.20 C; feelslike clamp usage peaks at 2.0% (polar-winter cold clamp); July
# zonal N-S day-temp-max asymmetry +14.1 C at 45 deg; diurnal peaks 12h-20h.
NH_SUMMER_MONTHS = {5, 6, 7, 8, 9}
SH_SUMMER_MONTHS = {11, 12, 1, 2, 3}     # 4 and 10 are transition months
ANCHOR_MARGIN_C = 3.0
ZONAL_LAT_DEG = 45.0
ZONAL_MARGIN_C = 5.0
STABILITY_FAMS = {"temp", "temp-max", "temp-min", "dewpoint", "feelslike", "wetbulbglobe"}
STABILITY_SPREAD_C = 5.0
STABILITY_JUMP_C = 1.5
CUMULATIVE_FAMS = {"precipaccum", "snowaccum-in-10-1"}   # plain form is a running total
CLAMP_WARN_FRAC = 0.05
CLAMP_FAIL_FRAC = 0.25
SNOW_MIN_IN = 0.5                        # snow=>cold rule qualifier
APPARENT_WARN_FRAC = 0.10                # soft threshold for regime-sign rules
DIURNAL_HOURS = (10.0, 22.0)             # local solar window for the daily temp max
DIURNAL_MIN_OK = 0.6
DIURNAL_CITIES = [("Cairo", 31.24, 30.05), ("Denver", -104.99, 39.74),
                  ("Sydney", 151.21, -33.87), ("Lagos", 3.39, 6.52),
                  ("Sao Paulo", -46.63, -23.55)]
# Desert anchors: hot vs the 180-degree antipode for temperature-like fields
# (only the summer hemisphere carries the requirement -- winter margins are
# noise), dry vs the antipode for dewpoint (season-independent, but only where
# the antipode is open ocean so marine air guarantees a moist reference).
ANCHORS = [
    ("Sahara",   13.0,  23.0, "NH", True),
    ("Sonoran", -112.0, 32.0, "NH", False),  # antipode is Afghan highlands (land)
    ("Arabian",  47.0,  24.0, "NH", True),
    ("Thar",     71.0,  27.0, "NH", True),
    ("Outback", 135.0, -25.0, "SH", True),
    ("Kalahari", 21.0, -24.0, "SH", True),
    ("Gibson",  126.5, -24.5, "SH", False),  # antipode is inland Brazil (land)
]
ANCHOR_WARM_FAMS = {"temp", "temp-max", "feelslike"}  # temp-min/WBGT margins too thin

# ----- product taxonomy: family -> spec -------------------------------------
# bounds are in DELIVERED units (post-legend).
FAMILIES = {
    "temp":        dict(units="C",     lo=-90,  hi=60),
    "temp-max":    dict(units="C",     lo=-90,  hi=60),
    "temp-min":    dict(units="C",     lo=-90,  hi=60),
    "dewpoint":    dict(units="C",     lo=-90,  hi=40),
    "feelslike":   dict(units="C",     lo=-90,  hi=65),
    "wetbulbglobe":dict(units="C",     lo=-90,  hi=45),  # shares apparent-temp legend; cold polar extremes real
    "relhumidity": dict(units="%",     lo=0,    hi=100),
    "cloud-total": dict(units="%",     lo=0,    hi=100),
    "pressure":    dict(units="mb",    lo=800,  hi=1085),
    "cape":        dict(units="J/kg",  lo=0,    hi=12000),
    "precip-probability": dict(units="%", lo=0, hi=100),
    "preciprate":  dict(units="in/hr", lo=0,    hi=65),
    "precipaccum": dict(units="in",    lo=0,    hi=200),
    "snowaccum-1hr":     dict(units="in", lo=0, hi=200),
    "snowaccum-in-10-1": dict(units="in", lo=0, hi=200),
    "windspeed-mph": dict(units="mph", lo=0,    hi=220),
    "windspeed-mps": dict(units="mps", lo=0,    hi=100),
    "gust-mph":    dict(units="mph",   lo=0,    hi=250),
    "gust-mps":    dict(units="mps",   lo=0,    hi=115),
    "windvector":  dict(units="mps",   lo=-115, hi=115),  # per-component, Int16/100
    "visibility":  dict(units="miles", lo=0,    hi=12.8),
    "wxcode":      dict(units="code",  lo=None, hi=None),
}

# borrow rules: product whose legend can be used only when the product's own
# legend is unavailable.
def legend_product(prod):
    # windvector: no palette
    if "windvector" in prod: return None
    # mps day/night borrow plain mps
    m = re.match(r"bgg-global-(day|night)-(windspeed|gust)-mps-10meter", prod)
    if m: return f"bgg-global-{m.group(2)}-mps-10meter"
    # day/night wxcode borrow plain wxcode
    if prod in ("bgg-global-day-wxcode", "bgg-global-night-wxcode"): return "bgg-global-wxcode"
    # plain precip-probability borrows day
    if prod == "bgg-global-precip-probability": return "bgg-global-day-precip-probability"
    return prod

def family_of(prod):
    p = prod.replace("bgg-global-", "")
    p = re.sub(r"^(day|night)-", "", p)
    # order matters: match longest/specific first
    for key in ["temp-max-c-2meter","temp-min-c-2meter","temp-c-2meter","dewpoint-c-surface",
                "feelslike-c-2meter","wetbulbglobe-c-2meter","relhumidity-2meter","cloud-total",
                "pressure-mb-surface","cape-jkg-surface","precip-probability",
                "preciprate-inph-surface","precipaccum-in-surface","snowaccum-1hr-in-surface",
                "snowaccum-in-10-1-surface","windspeed-mph-10meter","windspeed-mps-10meter",
                "gust-mph-10meter","gust-mps-10meter","windvector-10meter",
                "visibility-miles-surface","wxcode"]:
        if p == key:
            fam = {"temp-max-c-2meter":"temp-max","temp-min-c-2meter":"temp-min","temp-c-2meter":"temp",
                   "dewpoint-c-surface":"dewpoint","feelslike-c-2meter":"feelslike",
                   "wetbulbglobe-c-2meter":"wetbulbglobe","relhumidity-2meter":"relhumidity",
                   "cloud-total":"cloud-total","pressure-mb-surface":"pressure","cape-jkg-surface":"cape",
                   "precip-probability":"precip-probability","preciprate-inph-surface":"preciprate",
                   "precipaccum-in-surface":"precipaccum","snowaccum-1hr-in-surface":"snowaccum-1hr",
                   "snowaccum-in-10-1-surface":"snowaccum-in-10-1","windspeed-mph-10meter":"windspeed-mph",
                   "windspeed-mps-10meter":"windspeed-mps","gust-mph-10meter":"gust-mph",
                   "gust-mps-10meter":"gust-mps","windvector-10meter":"windvector",
                   "visibility-miles-surface":"visibility","wxcode":"wxcode"}
            return fam[key]
    return None

def form_of(prod):
    if re.search(r"bgg-global-day-", prod): return "day"
    if re.search(r"bgg-global-night-", prod): return "night"
    return "plain"

def _json_value(value):
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, float) and not math.isfinite(value):
        return "nan" if math.isnan(value) else ("inf" if value > 0 else "-inf")
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_value(item) for item in value]
    return value

class VerboseTrace:
    def __init__(self, enabled=False, pixel_limit=0):
        self.enabled = enabled
        self.pixel_limit = max(0, pixel_limit)
        self.pixel_count = 0
        self.pixel_counts = defaultdict(int)
        self.pixel_truncated = set()

    def event(self, event, **fields):
        if not self.enabled:
            return
        payload = {"event": event}
        payload.update({key: _json_value(value) for key, value in fields.items()})
        print("[TRACE] " + json.dumps(payload, sort_keys=True, separators=(",", ":")),
              file=sys.stderr)

    def pixel(self, rule, row, col, **fields):
        if not self.enabled:
            return False
        if self.pixel_limit and self.pixel_counts[rule] >= self.pixel_limit:
            if rule not in self.pixel_truncated:
                self.pixel_truncated.add(rule)
                self.event("pixel-trace-truncated", rule=rule, limit=self.pixel_limit)
            return False
        lon = GT[0] + (col + 0.5) * GT[1]
        lat = GT[3] + (row + 0.5) * GT[5]
        self.pixel_count += 1
        self.pixel_counts[rule] += 1
        self.event("pixel", rule=rule, row=row, col=col, lat=round(lat, 4),
                   lon=round(lon, 4), **fields)
        return True

    def can_emit_pixels(self, rule=None):
        if not self.enabled:
            return False
        return not (rule is not None and self.pixel_limit
                    and self.pixel_counts[rule] >= self.pixel_limit)

def season_classification(row, month):
    lat = GT[3] + (row + 0.5) * GT[5]
    if abs(lat) < 10:
        return ["tropical", "equatorial"]
    hemisphere = "northern-hemisphere" if lat > 0 else "southern-hemisphere"
    if month is None:
        season = "season-unknown"
    elif ((lat > 0 and month in NH_SUMMER_MONTHS)
          or (lat < 0 and month in SH_SUMMER_MONTHS)):
        season = "summer"
    elif ((lat > 0 and month in SH_SUMMER_MONTHS)
          or (lat < 0 and month in NH_SUMMER_MONTHS)):
        season = "winter"
    else:
        season = "transition-season"
    return [hemisphere, season]

def value_classification(fam, value, row=None, month=None, form=None):
    labels = []
    if form:
        labels.append(form)
    if row is not None:
        labels.extend(season_classification(row, month))
    if not np.isfinite(value):
        labels.append("nodata")
        return labels
    if fam in {"temp", "temp-max", "temp-min", "feelslike", "wetbulbglobe"}:
        if value <= 2:
            labels.append("very-cold")
        elif value < 0:
            labels.append("cold")
        elif value >= 35:
            labels.append("very-hot")
        elif value > 27:
            labels.append("hot")
        else:
            labels.append("mild")
    elif fam == "dewpoint":
        labels.append("humid-air" if value >= 20 else ("dry-air" if value <= 5 else "moderate-moisture"))
    elif fam in {"preciprate", "precipaccum"}:
        labels.append("precipitating" if value > 0 else "dry")
    elif fam in {"snowaccum-1hr", "snowaccum-in-10-1"}:
        labels.append("snow" if value > 0 else "no-snow")
    elif fam == "precip-probability":
        labels.append("precip-likely" if value >= 50 else "precip-unlikely")
    elif fam == "relhumidity":
        labels.append("humid" if value >= HUMID_RH_MIN else ("dry" if value < 30 else "moderate-humidity"))
    elif fam == "cloud-total":
        labels.append("cloudy" if value >= CLOUD_MIN else "mostly-clear")
    elif fam == "cape":
        labels.append("thunder-supportive" if value >= CAPE_MIN else "low-instability")
    elif fam == "visibility":
        labels.append("fog-supportive" if value <= FOG_VIS_MAX else (
            "obstruction-supportive" if value <= OBSTR_VIS_MAX else "good-visibility"))
    elif fam and (fam.startswith("windspeed") or fam.startswith("gust")):
        threshold = WINDY_GUST_MIN if fam.endswith("mph") else WINDY_GUST_MIN / MPH_PER_MPS
        labels.append("windy" if value >= threshold else ("calm" if value < 2 else "breezy"))
    return labels

def trace_mask_pixels(trace, rule, key, mask, values, families, form, test,
                      failed=None, extra_classifications=None, result_mode="predicate"):
    if not trace.can_emit_pixels(rule):
        return
    month = datetime.datetime.fromtimestamp(key[0], tz=datetime.timezone.utc).month
    for row in range(mask.shape[0]):
        for col in np.flatnonzero(mask[row]):
            pixel_values = {name: array[row, col] for name, array in values.items()}
            classifications = list(extra_classifications or [])
            for name, value in pixel_values.items():
                classifications.extend(value_classification(families.get(name), value,
                                                            row=row, month=month, form=form))
            classifications = sorted(set(classifications))
            if result_mode == "observed":
                result = "OBSERVED"
            else:
                result = "FAIL" if failed is not None and bool(failed[row, col]) else "PASS"
            if not trace.pixel(rule, row, int(col), ref_time=key[0], valid_time=key[1],
                               classifications=classifications, values=pixel_values,
                               test=test, result=result):
                return

def trace_scalar_product_pixels(trace, ds, product, fam, form, lut, entries,
                                zero_indices, lo, hi):
    rule = f"{product}:legend-decode-and-range"
    if not trace.can_emit_pixels(rule):
        return
    zero_indices = set(zero_indices)
    for band_number in range(1, ds.RasterCount + 1):
        raw = np.asarray(ds.GetRasterBand(band_number).ReadAsArray())
        ref = band_meta(ds, band_number, "GRIB_REF_TIME")
        valid = band_meta(ds, band_number, "GRIB_VALID_TIME")
        ref_epoch = int(str(ref).split()[0]) if ref is not None else None
        valid_epoch = int(str(valid).split()[0]) if valid is not None else None
        month = (datetime.datetime.fromtimestamp(ref_epoch, tz=datetime.timezone.utc).month
                 if ref_epoch is not None else None)
        for row in range(raw.shape[0]):
            for col in range(raw.shape[1]):
                index = int(raw[row, col])
                label = ((entries[index].get("value") or "").strip()
                         if 0 <= index < len(entries) else "")
                if 0 <= index < len(lut) and np.isfinite(lut[index]):
                    value = float(lut[index])
                    result = "PASS" if lo - 0.6 <= value <= hi + 0.6 else "FAIL"
                    classifications = value_classification(fam, value, row, month, form)
                elif index in zero_indices:
                    value = 0.0
                    result = "PASS"
                    classifications = value_classification(fam, value, row, month, form)
                    classifications.append("legend-nodata-treated-as-zero")
                elif label.startswith(("<", ">")):
                    value = label
                    result = "OBSERVED"
                    classifications = value_classification(fam, np.nan, row, month, form)
                    classifications.append("clamp-bucket")
                elif label.lower() in NODATA_TEXT:
                    value = "nodata"
                    result = "SKIP"
                    classifications = value_classification(fam, np.nan, row, month, form)
                else:
                    value = "undefined"
                    result = "FAIL"
                    classifications = value_classification(fam, np.nan, row, month, form)
                    classifications.append("undefined-palette-index")
                if not trace.pixel(rule, row, col, product=product, family=fam, form=form,
                                   band=band_number, ref_time=ref_epoch,
                                   valid_time=valid_epoch, raw_index=index,
                                   legend_label=label, value=value,
                                   units=FAMILIES[fam]["units"],
                                   classifications=sorted(set(classifications)),
                                   test=f"decoded value in [{lo},{hi}]",
                                   result=result):
                    return

def trace_categorical_product_pixels(trace, ds, product, form, categories):
    rule = f"{product}:weather-category"
    if not trace.can_emit_pixels(rule):
        return
    for band_number in range(1, ds.RasterCount + 1):
        raw = np.asarray(ds.GetRasterBand(band_number).ReadAsArray())
        ref = band_meta(ds, band_number, "GRIB_REF_TIME")
        valid = band_meta(ds, band_number, "GRIB_VALID_TIME")
        ref_epoch = int(str(ref).split()[0]) if ref is not None else None
        valid_epoch = int(str(valid).split()[0]) if valid is not None else None
        month = (datetime.datetime.fromtimestamp(ref_epoch, tz=datetime.timezone.utc).month
                 if ref_epoch is not None else None)
        for row in range(raw.shape[0]):
            for col in range(raw.shape[1]):
                index = int(raw[row, col])
                label = categories.get(index)
                classifications = season_classification(row, month)
                if label:
                    groups = sorted(wx_groups(label))
                    classifications.extend([group.replace("_", "-") for group in groups]
                                           or ["weather-other"])
                    result = "PASS"
                else:
                    groups = []
                    classifications.append("undefined-weather-code")
                    result = "FAIL"
                if not trace.pixel(rule, row, col, product=product, form=form,
                                   band=band_number, ref_time=ref_epoch,
                                   valid_time=valid_epoch, raw_index=index,
                                   weather_label=label, weather_groups=groups,
                                   classifications=sorted(set(classifications)),
                                   test="weather code has a defined category",
                                   result=result):
                    return

def trace_windvector_pixels(trace, product, form, ref_epoch, valid_epoch, u, v, lo, hi):
    rule = f"{product}:windvector-component-range"
    if not trace.can_emit_pixels(rule):
        return
    month = (datetime.datetime.fromtimestamp(ref_epoch, tz=datetime.timezone.utc).month
             if ref_epoch is not None else None)
    for row in range(u.shape[0]):
        for col in range(u.shape[1]):
            u_value = float(u[row, col]); v_value = float(v[row, col])
            speed = math.hypot(u_value, v_value)
            classifications = season_classification(row, month)
            classifications.append("windy" if speed >= WINDY_GUST_MIN / MPH_PER_MPS
                                   else ("calm" if speed < 2 else "breezy"))
            result = "PASS" if lo <= u_value <= hi and lo <= v_value <= hi else "FAIL"
            if not trace.pixel(rule, row, col, product=product, family="windvector",
                               form=form, band_u=1, band_v=2, ref_time=ref_epoch,
                               valid_time=valid_epoch,
                               classifications=sorted(set(classifications)),
                               values={"u_mps": u_value, "v_mps": v_value,
                                       "speed_mps": speed},
                               test=f"u and v in [{lo},{hi}] m/s", result=result):
                return

def trace_weather_rule_pixels(trace, rule, key, selected, failed, weather_raw,
                              categories, companion_values, companion_family,
                              companion_name, form, test):
    if not trace.can_emit_pixels(rule):
        return
    month = datetime.datetime.fromtimestamp(key[0], tz=datetime.timezone.utc).month
    for row in range(selected.shape[0]):
        for col in np.flatnonzero(selected[row]):
            weather_index = int(weather_raw[row, col])
            weather_label = categories.get(weather_index)
            weather_groups = sorted(wx_groups(weather_label)) if weather_label else []
            value = companion_values[row, col]
            classifications = season_classification(row, month)
            classifications.extend([group.replace("_", "-") for group in weather_groups]
                                   or ["weather-other"])
            if "liquid" in weather_groups:
                classifications.append("rain")
            if "frozen" in weather_groups:
                classifications.append("snow")
            classifications.extend(value_classification(companion_family, value, row, month, form))
            if not trace.pixel(rule, row, int(col), form=form, ref_time=key[0],
                               valid_time=key[1], weather_index=weather_index,
                               weather_label=weather_label, weather_groups=weather_groups,
                               classifications=sorted(set(classifications)),
                               values={companion_name: value}, test=test,
                               result="FAIL" if bool(failed[row, col]) else "PASS"):
                return

# ----- legend handling -------------------------------------------------------
_legend_cache = {}
_legend_failures = set()
NODATA_TEXT = {"", "undefined", "no data", "nodata", "n/a", "none", "null", "transparent"}

def validate_legend(legend, source):
    try:
        entries = legend["palettes"][0]["entries"]
        if not isinstance(entries, list) or not entries:
            raise ValueError("empty entries")
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise ValueError(f"malformed legend from {source}") from exc
    return legend

def load_legend(prod, legends_dir):
    fallback = legend_product(prod)
    if fallback is None: return None       # windvector: no palette
    candidates = [prod]
    if fallback != prod:
        candidates.append(fallback)
    for candidate in candidates:
        if candidate in _legend_cache:
            return _legend_cache[candidate]
        if candidate in _legend_failures:
            continue
        if legends_dir:
            path = f"{legends_dir}/{candidate}_Standard-Geodetic_legend.json"
            if os.path.exists(path):
                with open(path) as handle:
                    data = validate_legend(json.load(handle), path)
                _legend_cache[candidate] = data
                return data
        try:
            url = f"{CDN}/{candidate}/Standard-Geodetic/geotiff_legend.json"
            with urllib.request.urlopen(url, timeout=15) as response:
                data = validate_legend(json.load(response), url)
            _legend_cache[candidate] = data
            return data
        except Exception:
            _legend_failures.add(candidate)
            continue
    return None

def build_lut(legend):
    """index -> numeric value (nan for clamp/nodata/undefined)."""
    e = legend["palettes"][0]["entries"]
    lut = np.full(len(e), np.nan, dtype=np.float32)
    cat = {}
    for i, x in enumerate(e):
        v = (x.get("value") or "").strip()
        if v.lower() in NODATA_TEXT:
            continue
        if v.startswith(("<",">")):
            continue
        m = re.search(r"-?\d+\.?\d*", v)
        if m: lut[i] = float(m.group())
        else: cat[i] = v            # categorical (wxcode)
    return lut, cat

def safe_decode(raw, lut):
    decoded = np.full(raw.shape, np.nan, dtype=np.float32)
    valid = (raw >= 0) & (raw < len(lut))
    decoded[valid] = lut[raw[valid].astype(np.int64)]
    return decoded

def palette_usage(ds):
    """Return in-use palette indices, the first band using each, and per-band
    exact histograms (256 buckets) for downstream per-band statistics."""
    used = set()
    first_band = {}
    histograms = []
    for band_number in range(1, ds.RasterCount + 1):
        band = ds.GetRasterBand(band_number)
        histogram = band.GetHistogram(min=-0.5, max=255.5, buckets=256,
                                      include_out_of_range=False, approx_ok=False)
        if histogram is None:
            histogram = [0] * 256
            values, counts = np.unique(np.asarray(band.ReadAsArray()), return_counts=True)
            for value, count in zip(values.astype(int), counts):
                if 0 <= value < 256:
                    histogram[value] = int(count)
        histograms.append(np.asarray(histogram, dtype=float))
        for index, count in enumerate(histogram):
            if count:
                used.add(index)
                first_band.setdefault(index, band_number)
    return sorted(used), first_band, histograms

def sample_positions(count, sample_n):
    if count <= 0:
        return []
    if sample_n <= 0 or sample_n >= count:
        return list(range(count))
    return sorted(set(int(round(x)) for x in np.linspace(0, count - 1, sample_n)))

def parse_timestamp_epoch(token):
    if not token or token.lower() == "latest":
        return None
    for fmt in ("%Y%m%dT%H%M%SZ", "%Y%m%dT%H%M%S"):
        try:
            dt = datetime.datetime.strptime(token, fmt).replace(tzinfo=datetime.timezone.utc)
            return int(dt.timestamp())
        except ValueError:
            pass
    normalized = token
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2}Z", normalized):
        normalized = normalized.replace("_", ":")
    try:
        dt = datetime.datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return int(dt.astimezone(datetime.timezone.utc).timestamp())

def parse_tif_identity(path):
    name = os.path.basename(path)
    stem, suffix = os.path.splitext(name)
    if suffix.lower() != ".tif":
        return None
    if stem.startswith("source+"):
        parts = stem.split("+")
        if len(parts) < 3 or parts[0] != "source" or not parts[1].startswith("bgg-global-"):
            return None
        projection = {"g": "Standard-Geodetic", "m": "Standard-Mercator"}.get(
            parts[2].lower(), parts[2]
        )
        token = parts[-1] if len(parts) >= 5 else None
        filename_ref = parse_timestamp_epoch(token)
        if token and token.lower() != "latest" and filename_ref is None:
            return None
        return dict(product=parts[1], projection=projection,
                    filename_ref=filename_ref)
    if not stem.startswith("bgg-global-"):
        return None
    parts = stem.split("_")
    product = parts.pop(0)
    projection = None
    token = None
    if parts and parts[0].startswith("Standard-"):
        projection = parts.pop(0)
    if parts:
        token = parts.pop(0)
    if parts or (token and token.lower() != "latest" and parse_timestamp_epoch(token) is None):
        return None
    return dict(product=product, projection=projection,
                filename_ref=parse_timestamp_epoch(token))

def tif_paths(dirpath):
    return sorted(path for path in glob.glob(os.path.join(dirpath, "*"))
                  if os.path.isfile(path) and os.path.splitext(path)[1].lower() == ".tif")

# ----- helpers ---------------------------------------------------------------
def cell(lon, lat):
    return math.floor((GT[3]-lat)/-GT[5]), math.floor((lon-GT[0])/GT[1])

def band_meta(ds, b, key):
    return ds.GetRasterBand(b).GetMetadataItem(key)

class Report:
    def __init__(self, trace=None):
        self.items = []
        self.trace = trace

    def add(self, prod, level, msg):
        self.items.append((prod, level, msg))
        if self.trace is not None:
            self.trace.event("check", tag=prod, level=level, message=msg)

def check_frozen_samples(ds, is_wv, form, tag, rep, sample_n=3):
    per = 2 if is_wv else 1
    logical_count = ds.RasterCount // per
    delta = 2 if form in ("day", "night") else 1
    starts = sample_positions(max(0, logical_count - delta), sample_n)
    frozen = []
    for start in starts:
        left = start * per + 1
        right = (start + delta) * per + 1
        same = True
        for offset in range(per):
            a = ds.GetRasterBand(left + offset).ReadAsArray()
            b = ds.GetRasterBand(right + offset).ReadAsArray()
            if not np.array_equal(a, b):
                same = False
                break
        if same:
            frozen.append((left, right))
    if frozen:
        pairs = ", ".join(f"{a}/{b}" for a, b in frozen[:4])
        rep.add(tag, "FAIL", f"globally identical sampled band pairs: {pairs}")
    elif starts:
        rep.add(tag, "PASS", f"{len(starts)} sampled evolution pairs are not frozen")

def crs_is_epsg4326(ds):
    actual = ds.GetSpatialRef()
    if actual is None:
        return False
    return bool(actual.IsGeographic()) and actual.GetAuthorityCode(None) == "4326"

def check_product(path, legends_dir, rep, trace=None):
    identity = parse_tif_identity(path)
    raw_name = os.path.basename(path)
    if identity is None:
        rep.add(os.path.splitext(raw_name)[0], "WARN", "unrecognized filename; skipped")
        return None
    prod = identity["product"]
    fam = family_of(prod); form = form_of(prod)
    if fam is None:
        rep.add(prod, "WARN", "unrecognized product code; skipped"); return None
    spec = FAMILIES[fam]
    ds = gdal.Open(path); n = ds.RasterCount
    tag = f"{prod}"
    result = dict(prod=prod, fam=fam, form=form, path=path, ref0=None,
                  cross_usable=True)
    if trace is not None:
        trace.event("product-start", product=prod, family=fam, form=form,
                    path=path, bands=n, width=ds.RasterXSize, height=ds.RasterYSize)

    # 2.1 grid/geotransform
    grid_ok = (ds.RasterXSize, ds.RasterYSize) == (NX, NY)
    if trace is not None:
        trace.event("check-detail", product=prod, rule="grid-size",
                    actual=[ds.RasterXSize, ds.RasterYSize], expected=[NX, NY],
                    result="PASS" if grid_ok else "FAIL")
    if not grid_ok:
        rep.add(tag,"FAIL",f"grid {ds.RasterXSize}x{ds.RasterYSize} != {NX}x{NY}")
        result["cross_usable"] = False
    actual_gt = tuple(round(x,4) for x in ds.GetGeoTransform())
    geotransform_ok = actual_gt == GT
    if trace is not None:
        trace.event("check-detail", product=prod, rule="geotransform",
                    actual=actual_gt, expected=GT,
                    result="PASS" if geotransform_ok else "FAIL")
    if not geotransform_ok:
        rep.add(tag,"FAIL",f"geotransform {ds.GetGeoTransform()} != {GT}")
        result["cross_usable"] = False
    projection_ok = identity["projection"] in (None, "Standard-Geodetic")
    if trace is not None:
        trace.event("check-detail", product=prod, rule="filename-projection",
                    actual=identity["projection"], expected="Standard-Geodetic or omitted",
                    result="PASS" if projection_ok else "FAIL")
    if not projection_ok:
        rep.add(tag, "FAIL", f"filename projection {identity['projection']} is not Standard-Geodetic")
        result["cross_usable"] = False
    crs_ok = crs_is_epsg4326(ds)
    if trace is not None:
        trace.event("check-detail", product=prod, rule="crs",
                    actual=(ds.GetSpatialRef().GetAuthorityCode(None)
                            if ds.GetSpatialRef() is not None else None),
                    expected="EPSG:4326", result="PASS" if crs_ok else "FAIL")
    if not crs_ok:
        rep.add(tag, "FAIL", "CRS is not EPSG:4326")
        result["cross_usable"] = False

    seam_bands = [position + 1 for position in sample_positions(n, 3)]
    seam_bad = 0
    for b in seam_bands:
        band = ds.GetRasterBand(b)
        left = band.ReadAsArray(0, 0, 1, ds.RasterYSize)
        right = band.ReadAsArray(ds.RasterXSize - 1, 0, 1, ds.RasterYSize)
        seam_ok = np.array_equal(left, right)
        if trace is not None:
            trace.event("check-detail", product=prod, rule="longitude-seam",
                        band=b, cells_compared=ds.RasterYSize,
                        result="PASS" if seam_ok else "FAIL")
        if not seam_ok:
            seam_bad += 1
    if seam_bad:
        rep.add(tag, "FAIL", f"longitude seam differs in {seam_bad}/{len(seam_bands)} sampled bands")
        result["cross_usable"] = False

    # 2.3 band count / schedule
    is_wv = (fam=="windvector"); per = 2 if is_wv else 1
    exp = {"plain":252,"day":20,"night":20}[form]*per
    if trace is not None:
        trace.event("check-detail", product=prod, rule="band-count", actual=n,
                    expected=exp, result="PASS" if n == exp else "FAIL")
    if n != exp:
        rep.add(tag,"FAIL",f"{n} bands, expected {exp} for {form} {'(u/v x2)' if is_wv else ''}")
        result["cross_usable"] = False

    # 2.4 time-metadata integrity: exact start + cadence, constant REF, and VALID=REF+FCST.
    def gi(b,k):
        v=band_meta(ds,b,k); return int(str(v).split()[0]) if v is not None else None
    ref0=gi(1,"GRIB_REF_TIME")
    result["ref0"] = ref0
    expected_base = 3600 if form == "plain" and fam == "precip-probability" else (
        0 if form == "plain" else 86400
    )
    step = 3600 if form=="plain" else 43200
    bad=0; bad_elements=0
    for b in range(1, n+1):
        tstep=(b-1)//per if is_wv else (b-1)
        rt=gi(b,"GRIB_REF_TIME"); fs=gi(b,"GRIB_FORECAST_SECONDS"); vt=gi(b,"GRIB_VALID_TIME")
        expected_seconds = expected_base+step*tstep
        expected_element = "UGRD" if is_wv and b % 2 else ("VGRD" if is_wv else None)
        time_ok = (rt is not None and fs is not None and vt is not None
                   and rt == ref0 and vt == rt + fs and fs == expected_seconds)
        element_ok = not is_wv or band_meta(ds, b, "GRIB_ELEMENT") == expected_element
        if trace is not None:
            trace.event("band-metadata", product=prod, band=b, ref_time=rt,
                        forecast_seconds=fs, valid_time=vt,
                        expected_forecast_seconds=expected_seconds,
                        element=band_meta(ds, b, "GRIB_ELEMENT"),
                        expected_element=expected_element,
                        dtype=gdal.GetDataTypeName(ds.GetRasterBand(b).DataType),
                        time_result="PASS" if time_ok else "FAIL",
                        element_result="PASS" if element_ok else "FAIL")
        if rt is None or fs is None or vt is None: bad+=1; continue
        if rt!=ref0: bad+=1
        if vt!=rt+fs: bad+=1
        if fs!=expected_base+step*tstep: bad+=1
        if is_wv:
            if band_meta(ds, b, "GRIB_ELEMENT") != expected_element:
                bad_elements += 1
    if bad:
        rep.add(tag,"FAIL",f"time-metadata inconsistencies in {bad} band-checks")
        result["cross_usable"] = False
    if bad_elements:
        rep.add(tag, "FAIL", f"u/v component order wrong in {bad_elements} bands")
        result["cross_usable"] = False
    if identity["filename_ref"] is not None and ref0 != identity["filename_ref"]:
        rep.add(tag, "FAIL", f"filename run {identity['filename_ref']} != GRIB_REF_TIME {ref0}")
        result["cross_usable"] = False

    # 2.5 dtype
    want = "Int16" if is_wv else "Byte"
    bad_dtype = [b for b in range(1, n + 1)
                 if gdal.GetDataTypeName(ds.GetRasterBand(b).DataType) != want]
    if trace is not None:
        trace.event("check-detail", product=prod, rule="band-dtype",
                    expected=want, failing_bands=bad_dtype,
                    result="PASS" if not bad_dtype else "FAIL")
    if bad_dtype:
        rep.add(tag,"FAIL",f"wrong dtype in {len(bad_dtype)} bands; expected {want}")
        result["cross_usable"] = False

    check_frozen_samples(ds, is_wv, form, tag, rep)

    # ---- decode band 1 (+ band2 for windvector) ----
    if is_wv:
        if n < 2:
            ds=None; result["cross_usable"] = False; return result
        a1 = np.asarray(ds.GetRasterBand(1).ReadAsArray())
        b2 = np.asarray(ds.GetRasterBand(2).ReadAsArray())
        u, v = a1.astype(np.float32)/100.0, b2.astype(np.float32)/100.0
        if trace is not None:
            trace_windvector_pixels(trace, prod, form, ref0, gi(1, "GRIB_VALID_TIME"),
                                    u, v, spec["lo"], spec["hi"])
        # 3.P bounds on components + derived speed
        if np.nanmin(u) < spec["lo"] or np.nanmax(u) > spec["hi"] or np.nanmin(v)<spec["lo"] or np.nanmax(v)>spec["hi"]:
            rep.add(tag,"FAIL",f"u/v out of [{spec['lo']},{spec['hi']}] m/s (u[{u.min():.1f},{u.max():.1f}] v[{v.min():.1f},{v.max():.1f}])")
        else:
            rep.add(tag,"PASS",f"Int16/100 u/v within bounds; speed max {np.hypot(u,v).max():.1f} m/s")
        if trace is not None:
            trace.event("product-end", product=prod)
        ds=None; return result

    legend = load_legend(prod, legends_dir)
    if legend is None:
        rep.add(tag,"FAIL","no legend/decode path resolved")
        result["cross_usable"] = False
        if trace is not None:
            trace.event("product-end", product=prod)
        ds=None; return result
    lut, cat = build_lut(legend)
    entries = legend["palettes"][0]["entries"]

    # 2.6 every in-use index across the full band series maps to a defined entry.
    used, first_band, histograms = palette_usage(ds)
    accum = fam in ("precipaccum","snowaccum-1hr","snowaccum-in-10-1","preciprate")

    # 4.6/5.1 flat (single-index) bands anywhere in the series, from the same
    # histograms. Accumulation products may legitimately hold flat all-zero
    # early bands (f+0h, and quiet hours for hourly snowfall), so only report
    # them when most of the series is flat.
    flat_bands = [position for position, histogram in enumerate(histograms, start=1)
                  if histogram.sum() and (histogram > 0).sum() <= 1]
    if accum:
        if len(flat_bands) > len(histograms) // 2:
            rep.add(tag, "WARN", f"{len(flat_bands)}/{len(histograms)} bands are spatially constant")
    elif flat_bands == [1]:
        rep.add(tag, "WARN", "band 1 is spatially constant")
    elif flat_bands:
        rep.add(tag, "FAIL", f"spatially constant bands: {flat_bands[:6]}")

    if fam=="wxcode":
        undef=[]
        for i in used:
            if i in cat:
                continue
            if 0 <= i < len(entries):
                label = (entries[i].get("value") or "").strip().lower()
                if label in NODATA_TEXT or label.startswith(("<", ">")):
                    continue
            undef.append(int(i))
        if undef:
            detail = [f"{index}@band{first_band[index]}" for index in undef[:8]]
            rep.add(tag,"FAIL",f"wxcode indices with no category: {detail}")
            result["cross_usable"] = False
        else:
            rep.add(tag,"PASS",f"{len(cat)}-category legend; all used codes defined across {n} bands ({min(used)}..{max(used)})")
        if trace is not None:
            trace_categorical_product_pixels(trace, ds, prod, form, cat)
        if trace is not None:
            trace.event("product-end", product=prod)
        ds=None; return result

    undef=[]; zero_indices=[]
    for i in used:
        if 0 <= i < len(lut) and np.isfinite(lut[i]):
            continue
        if 0 <= i < len(entries):
            label = (entries[i].get("value") or "").strip()
            if label.startswith(("<", ">")):
                continue
            if accum and label.lower() in NODATA_TEXT:
                zero_indices.append(int(i)); continue
        undef.append(int(i))
    if undef:
        detail = [f"{index}@band{first_band[index]}" for index in undef[:8]]
        rep.add(tag,"FAIL",f"in-use indices undefined in legend: {detail}")
        result["cross_usable"] = False
    else:
        rep.add(tag, "PASS", f"all in-use palette indices have a decode path across {n} bands")

    # 3.x physical range
    lo,hi = spec["lo"],spec["hi"]
    finite_values = [float(lut[index]) for index in used
                     if 0 <= index < len(lut) and np.isfinite(lut[index])]
    if zero_indices:
        finite_values.append(0.0)
    if not finite_values:
        rep.add(tag,"WARN","no finite decoded values across audited bands -- range not evaluable")
    else:
        vmin,vmax = min(finite_values), max(finite_values)
        if vmin < lo-0.6 or vmax > hi+0.6:
            rep.add(tag,"FAIL",f"decoded range [{vmin:.2f},{vmax:.2f}] {spec['units']} outside [{lo},{hi}] across {n} bands")
        else:
            rep.add(tag,"PASS",f"range [{vmin:.2f},{vmax:.2f}] {spec['units']} within [{lo},{hi}] across {n} bands")
    if trace is not None:
        trace_scalar_product_pixels(trace, ds, prod, fam, form, lut, entries,
                                    zero_indices, lo, hi)

    # Per-band statistics from the already-computed histograms: clamp-bucket
    # usage (a unit/scaling defect concentrates mass in the clamp buckets, which
    # every other check skips), lead-time stability of the global mean, and
    # cumulative-accumulation monotonicity.
    clamp_indices = [i for i, x in enumerate(entries)
                     if ((x.get("value") or "").strip().startswith(("<", ">")))]
    L = min(len(lut), 256)
    finite_lut = np.isfinite(lut[:L])
    clamp_max = 0.0
    means_finite = []   # mean over defined-value pixels (temperature-like fields)
    means_zeroed = []   # mean with nodata-as-zero denominators (accumulations)
    for histogram in histograms:
        clipped = histogram[:L]
        total = histogram.sum()
        if not total:
            means_finite.append(np.nan); means_zeroed.append(np.nan); continue
        finite_count = clipped[finite_lut].sum()
        numerator = float((clipped[finite_lut] * lut[:L][finite_lut]).sum())
        means_finite.append(numerator / finite_count if finite_count else np.nan)
        means_zeroed.append(numerator / total)
        if clamp_indices:
            clamp_px = sum(histogram[i] for i in clamp_indices if i < histogram.size)
            clamp_max = max(clamp_max, clamp_px / total)
    if clamp_indices:
        if clamp_max > CLAMP_FAIL_FRAC:
            rep.add(tag, "FAIL", f"clamp-bucket usage peaks at {100*clamp_max:.1f}% of a band -- scaling/unit defect?")
        elif clamp_max > CLAMP_WARN_FRAC:
            rep.add(tag, "WARN", f"clamp-bucket usage peaks at {100*clamp_max:.1f}% of a band")
        elif clamp_max > 0:
            rep.add(tag, "PASS", f"clamp-bucket usage peaks at {100*clamp_max:.1f}% of a band (<= {100*CLAMP_WARN_FRAC:.0f}%)")

    # 5.3 lead-time stability of the global mean (temperature-like fields).
    if fam in STABILITY_FAMS:
        series = np.asarray(means_finite, dtype=float)
        finite_series = series[np.isfinite(series)]
        if finite_series.size >= 2:
            spread = float(finite_series.max() - finite_series.min())
            steps = np.abs(np.diff(finite_series))
            step = float(steps.max()) if steps.size else 0.0
            if spread > STABILITY_SPREAD_C or step > STABILITY_JUMP_C:
                rep.add(tag, "WARN", f"global-mean drift across bands: spread {spread:.2f} C, max step {step:.2f} C")
            else:
                rep.add(tag, "PASS", f"global mean stable across {n} bands (spread {spread:.2f} C, max step {step:.2f} C)")

    # 5.4 cumulative accumulations must not decrease with lead (plain form).
    if form == "plain" and fam in CUMULATIVE_FAMS:
        series = means_zeroed
        drops = [position + 1 for position in range(len(series) - 1)
                 if np.isfinite(series[position]) and np.isfinite(series[position + 1])
                 and series[position + 1] < series[position] - 1e-3]
        if drops:
            rep.add(tag, "FAIL", f"cumulative global mean decreases after bands {drops[:6]}")
        else:
            rep.add(tag, "PASS", f"cumulative global mean non-decreasing across {n} bands")

    if trace is not None:
        trace.event("product-end", product=prod)
    ds=None
    return result

class CrossReader:
    def __init__(self, result, legends_dir):
        self.result = result
        self.ds = gdal.Open(result["path"])
        self.is_wv = result["fam"] == "windvector"
        self.lut = None
        if not self.is_wv:
            legend = load_legend(result["prod"], legends_dir)
            if legend is None:
                raise ValueError(f"no legend for {result['prod']}")
            self.lut = build_lut(legend)[0]
        per = 2 if self.is_wv else 1
        self.bands = {}
        for band_number in range(1, self.ds.RasterCount + 1, per):
            ref = band_meta(self.ds, band_number, "GRIB_REF_TIME")
            valid = band_meta(self.ds, band_number, "GRIB_VALID_TIME")
            if ref is None or valid is None:
                continue
            key = (int(str(ref).split()[0]), int(str(valid).split()[0]))
            if key in self.bands:
                raise ValueError(f"duplicate run/valid time in {result['prod']}: {key}")
            self.bands[key] = band_number
        self.keys = sorted(self.bands)
        self.refs = {key[0] for key in self.keys}

    def read_raw(self, key):
        band_number = self.bands[key]
        if self.is_wv:
            return (np.asarray(self.ds.GetRasterBand(band_number).ReadAsArray()),
                    np.asarray(self.ds.GetRasterBand(band_number + 1).ReadAsArray()))
        return np.asarray(self.ds.GetRasterBand(band_number).ReadAsArray())

    def read(self, key):
        raw = self.read_raw(key)
        if self.is_wv:
            u = raw[0].astype(np.float32) / 100.0
            v = raw[1].astype(np.float32) / 100.0
            return np.hypot(u, v)
        return safe_decode(raw, self.lut)

    def point(self, key, lon, lat):
        row, col = cell(lon, lat)
        raw = self.ds.GetRasterBand(self.bands[key]).ReadAsArray(col, row, 1, 1)[0, 0]
        if self.is_wv:
            raise ValueError("point decode is scalar-only")
        return self.lut[int(raw)] if 0 <= int(raw) < len(self.lut) else np.nan

    def point_daily_max(self, lon, lat):
        """Anchor probe value at a location: window-aggregate products use their
        first band; instantaneous (plain) products take the max over the first
        24 hourly steps -- a daily max, which removes the diurnal-phase
        confound between a point and its antipode (12 h out of local phase)."""
        keys = self.keys[:24] if self.result["form"] == "plain" else self.keys[:1]
        values = [self.point(key, lon, lat) for key in keys]
        values = [value for value in values if np.isfinite(value)]
        return max(values) if values else np.nan

    def close(self):
        self.ds = None

def cross_checks(results, legends_dir, sample_n, rep, trace=None):
    """Stream run/time-matched inter-variable checks over sampled forecast bands."""
    trace_enabled = trace is not None and trace.enabled
    wanted = {"temp", "temp-max", "temp-min", "dewpoint", "windspeed-mph",
              "windspeed-mps", "gust-mph", "gust-mps", "windvector",
              "feelslike", "wetbulbglobe", "relhumidity", "snowaccum-1hr"}
    grouped = defaultdict(list)
    for result in results:
        if result and result["cross_usable"] and result["fam"] in wanted:
            grouped[(result["fam"], result["form"])].append(result)

    readers = {}
    for key, matches in grouped.items():
        if len(matches) > 1:
            continue
        try:
            readers[key] = CrossReader(matches[0], legends_dir)
        except Exception as exc:
            rep.add("[run:inputs]", "FAIL", f"cannot prepare {key[0]}/{key[1]}: {exc}")

    def paired(left_key, right_key, tag, label):
        left = readers.get(left_key); right = readers.get(right_key)
        if left is None or right is None:
            missing = []
            if left is None: missing.append(f"{left_key[0]}/{left_key[1]}")
            if right is None: missing.append(f"{right_key[0]}/{right_key[1]}")
            rep.add(tag, "SKIP", f"{label}: missing {' and '.join(missing)}")
            return None
        if left.refs != right.refs:
            rep.add(tag, "FAIL", f"{label} skipped: model-run mismatch {sorted(left.refs)} vs {sorted(right.refs)}")
            return None
        left_keys = set(left.keys); right_keys = set(right.keys)
        if left_keys != right_keys:
            rep.add(tag, "FAIL", f"{label} skipped: valid-time schedules differ")
            return None
        positions = sample_positions(len(left.keys), sample_n)
        return left, right, [left.keys[position] for position in positions]

    def fraction_rule(left_key, right_key, tag, label, predicate, predicate_text):
        pair = paired(left_key, right_key, tag, label)
        if pair is None:
            return
        left, right, keys = pair
        total = violations = 0
        for key in keys:
            a = left.read(key); b = right.read(key)
            finite = np.isfinite(a) & np.isfinite(b)
            total += int(finite.sum())
            if finite.any():
                pixel_failures = predicate(a[finite], b[finite])
                violations += int(pixel_failures.sum())
                if trace_enabled:
                    failed = np.zeros(finite.shape, dtype=bool)
                    failed[finite] = pixel_failures
                    trace_mask_pixels(trace, f"{tag}:{label}", key, finite,
                                      {"left": a, "right": b},
                                      {"left": left_key[0], "right": right_key[0]},
                                      left_key[1], predicate_text, failed=failed,
                                      extra_classifications=["finite-pair"])
        if total == 0:
            rep.add(tag, "SKIP", f"{label}: no finite paired pixels")
            return
        fraction = violations / total
        rep.add(tag, "FAIL" if fraction > 0.001 else "PASS",
                f"{label} violated at {100*fraction:.3f}% across {len(keys)} sampled bands")

    def ratio_rule(mph_key, mps_key, tag, label):
        pair = paired(mph_key, mps_key, tag, label)
        if pair is None:
            return
        mph_reader, mps_reader, keys = pair
        medians = []
        for key in keys:
            mph = mph_reader.read(key); mps = mps_reader.read(key)
            mask = np.isfinite(mph) & np.isfinite(mps) & (mps >= 2.0)
            if mask.any():
                medians.append(float(np.median(mph[mask] / mps[mask])))
                if trace_enabled:
                    ratio_values = np.full(mph.shape, np.nan, dtype=np.float32)
                    ratio_values[mask] = mph[mask] / mps[mask]
                    trace_mask_pixels(trace, f"{tag}:{label}", key, mask,
                                      {"mph": mph, "mps": mps, "ratio": ratio_values},
                                      {"mph": mph_key[0], "mps": mps_key[0], "ratio": None},
                                      mph_key[1],
                                      f"aggregate median ratio near {MPH_PER_MPS:.3f}",
                                      extra_classifications=["speed-at-least-2mps"],
                                      result_mode="observed")
        if not medians:
            rep.add(tag, "SKIP", f"{label}: no finite speeds >=2 m/s")
            return
        ratio = float(np.median(medians))
        rep.add(tag, "PASS" if abs(ratio - MPH_PER_MPS) < 0.06 else "FAIL",
                f"{label} ratio {ratio:.3f} across {len(medians)} sampled bands (expect {MPH_PER_MPS:.3f})")

    for form in ("plain", "day", "night"):
        tag = f"[cross:{form}]"
        temp_family = "temp" if form == "plain" else "temp-max"
        fraction_rule((temp_family, form), ("dewpoint", form), tag, "dewpoint<=temperature",
                      lambda temp, dewpoint: dewpoint > temp + 0.6,
                      "dewpoint <= temperature + 0.6C")
        for units in ("mph", "mps"):
            fraction_rule((f"windspeed-{units}", form), (f"gust-{units}", form), tag,
                          f"gust>=windspeed({units})", lambda wind, gust: gust + 0.6 < wind,
                          f"gust + 0.6 >= sustained wind ({units})")
        ratio_rule(("windspeed-mph", form), ("windspeed-mps", form), tag, "windspeed mph/mps")
        ratio_rule(("gust-mph", form), ("gust-mps", form), tag, "gust mph/mps")
        if form in ("day", "night"):
            fraction_rule(("temp-min", form), ("temp-max", form), tag, "temp-min<=temp-max",
                          lambda minimum, maximum: minimum > maximum + 0.6,
                          "minimum temperature <= maximum temperature + 0.6C")

        identity_pair = paired(("wetbulbglobe", form), ("feelslike", form), tag,
                               "WBGT differs from feels-like")
        if identity_pair is not None:
            wbgt, feels, keys = identity_pair
            identical = True
            for key in keys:
                wbgt_raw = wbgt.read_raw(key); feels_raw = feels.read_raw(key)
                band_identical = np.array_equal(wbgt_raw, feels_raw)
                identical = identical and band_identical
                if trace_enabled:
                    same = wbgt_raw == feels_raw
                    trace_mask_pixels(trace, f"{tag}:WBGT differs from feels-like", key,
                                      np.ones(same.shape, dtype=bool),
                                      {"wbgt_raw": wbgt_raw, "feelslike_raw": feels_raw,
                                       "byte_identical": same.astype(np.uint8)},
                                      {}, form,
                                      "aggregate bands must not be byte-identical",
                                      extra_classifications=["raw-palette-comparison"],
                                      result_mode="observed")
            rep.add(tag, "FAIL" if identical else "PASS",
                    f"WBGT {'is' if identical else 'is not'} byte-identical to feels-like across {len(keys)} sampled bands")

        # 6.9 snow => cold: pixels accumulating snow must sit at frozen-precip
        # temperatures (window-max forms get the more lenient day/night limit).
        snow_pair = paired(("snowaccum-1hr", form), (temp_family, form), tag, "snow=>cold")
        if snow_pair is not None:
            snow_reader, temp_reader, keys = snow_pair
            limit = FROZEN_MAX_C[form]
            total = violations = 0
            for key in keys:
                snow = snow_reader.read(key); temperature = temp_reader.read(key)
                snowy = np.isfinite(snow) & np.isfinite(temperature) & (snow > SNOW_MIN_IN)
                total += int(snowy.sum())
                if snowy.any():
                    pixel_failures = temperature[snowy] > limit
                    violations += int(pixel_failures.sum())
                    if trace_enabled:
                        failed = np.zeros(snowy.shape, dtype=bool)
                        failed[snowy] = pixel_failures
                        trace_mask_pixels(trace, f"{tag}:snow=>cold", key, snowy,
                                          {"snow_inches": snow, "temperature_c": temperature},
                                          {"snow_inches": "snowaccum-1hr",
                                           "temperature_c": temp_family},
                                          form, f"snow > {SNOW_MIN_IN:g}in implies temperature <= {limit:g}C",
                                          failed=failed,
                                          extra_classifications=["snowy"])
            if total < 200:
                rep.add(tag, "SKIP", f"snow=>cold: only {total} snowy pixels sampled")
            else:
                fraction = violations / total
                rep.add(tag, "WARN" if fraction > APPARENT_WARN_FRAC else "PASS",
                        f"snow=>cold (>{SNOW_MIN_IN:g} in => temp<={limit:g}C): {total} px, {100*fraction:.1f}% violate")

    vector_pair = paired(("windvector", "plain"), ("windspeed-mps", "plain"),
                         "[cross:plain]", "vector speed vs windspeed-mps")
    if vector_pair is not None:
        vector, scalar, keys = vector_pair
        medians = []
        for key in keys:
            a = vector.read(key); b = scalar.read(key)
            finite = np.isfinite(a) & np.isfinite(b)
            if finite.any():
                finite_difference = np.abs(a[finite] - b[finite])
                medians.append(float(np.median(finite_difference)))
                if trace_enabled:
                    difference = np.full(a.shape, np.nan, dtype=np.float32)
                    difference[finite] = finite_difference
                    trace_mask_pixels(trace, "[cross:plain]:vector speed vs windspeed-mps",
                                      key, finite,
                                      {"vector_speed_mps": a, "scalar_speed_mps": b,
                                       "absolute_difference_mps": difference},
                                      {"vector_speed_mps": "windspeed-mps",
                                       "scalar_speed_mps": "windspeed-mps",
                                       "absolute_difference_mps": None},
                                      "plain", "aggregate median absolute difference < 1.0 m/s",
                                      extra_classifications=["vector-scalar-comparison"],
                                      result_mode="observed")
        if medians:
            diff = float(np.median(medians))
            rep.add("[cross:plain]", "PASS" if diff < 1.0 else "FAIL",
                    f"|vector speed-windspeed-mps| median {diff:.2f} m/s across {len(medians)} sampled bands")
        else:
            rep.add("[cross:plain]", "SKIP", "vector speed vs windspeed-mps: no finite paired pixels")

    fraction_rule(("temp-max", "day"), ("temp-min", "night"), "[cross:day/night]",
                  "day-temp-max>=night-temp-min", lambda daymax, nightmin: daymax + 0.6 < nightmin,
                  "day maximum temperature + 0.6C >= night minimum temperature")

    # 6.6 apparent-temperature regime signs (plain/instantaneous form only --
    # aggregation-window statistics make the sign test mushy for day/night).
    # Cold+windy => wind chill pulls feels-like at/below temp; hot+humid =>
    # heat index pushes it at/above. Both regimes exist in any month because
    # one hemisphere is always in winter.
    apparent_tag = "[cross:plain]"
    apparent_needed = [("temp", "plain"), ("feelslike", "plain"),
                       ("windspeed-mph", "plain"), ("relhumidity", "plain")]
    apparent_readers = [readers.get(key) for key in apparent_needed]
    missing = [f"{key[0]}/{key[1]}" for key, reader in zip(apparent_needed, apparent_readers)
               if reader is None]
    if missing:
        rep.add(apparent_tag, "SKIP", f"apparent-temperature regime checks: missing {', '.join(missing)}")
    elif (len({tuple(sorted(reader.refs)) for reader in apparent_readers}) > 1
          or len({tuple(reader.keys) for reader in apparent_readers}) > 1):
        rep.add(apparent_tag, "FAIL", "apparent-temperature regime checks skipped: run/schedule mismatch")
    else:
        temp_r, feels_r, wind_r, rh_r = apparent_readers
        positions = sample_positions(len(temp_r.keys), sample_n)
        keys = [temp_r.keys[position] for position in positions]
        cold_total = cold_viol = hot_total = hot_viol = 0
        for key in keys:
            temperature = temp_r.read(key); feels = feels_r.read(key)
            wind = wind_r.read(key); rh = rh_r.read(key)
            base = np.isfinite(temperature) & np.isfinite(feels)
            cold = base & np.isfinite(wind) & (temperature < 0.0) & (wind > 15.0)
            hot = base & np.isfinite(rh) & (temperature > 27.0) & (rh > 60.0)
            cold_total += int(cold.sum()); hot_total += int(hot.sum())
            if cold.any():
                cold_pixel_failures = feels[cold] > temperature[cold] + 0.6
                cold_viol += int(cold_pixel_failures.sum())
                if trace_enabled:
                    cold_failed = np.zeros(cold.shape, dtype=bool)
                    cold_failed[cold] = cold_pixel_failures
                    trace_mask_pixels(trace, "[cross:plain]:wind-chill", key, cold,
                                      {"temperature_c": temperature, "feelslike_c": feels,
                                       "wind_mph": wind},
                                      {"temperature_c": "temp", "feelslike_c": "feelslike",
                                       "wind_mph": "windspeed-mph"},
                                      "plain", "T < 0C and wind > 15mph implies feelslike <= T + 0.6C",
                                      failed=cold_failed,
                                      extra_classifications=["cold", "windy", "wind-chill-regime"])
            if hot.any():
                hot_pixel_failures = feels[hot] < temperature[hot] - 0.6
                hot_viol += int(hot_pixel_failures.sum())
                if trace_enabled:
                    hot_failed = np.zeros(hot.shape, dtype=bool)
                    hot_failed[hot] = hot_pixel_failures
                    trace_mask_pixels(trace, "[cross:plain]:heat-index", key, hot,
                                      {"temperature_c": temperature, "feelslike_c": feels,
                                       "relative_humidity_pct": rh},
                                      {"temperature_c": "temp", "feelslike_c": "feelslike",
                                       "relative_humidity_pct": "relhumidity"},
                                      "plain", "T > 27C and RH > 60% implies feelslike >= T - 0.6C",
                                      failed=hot_failed,
                                      extra_classifications=["hot", "humid", "heat-index-regime"])
        for label, total, violations in (
                ("wind-chill (T<0C & wind>15mph => feelslike<=T)", cold_total, cold_viol),
                ("heat-index (T>27C & RH>60% => feelslike>=T)", hot_total, hot_viol)):
            if total < 200:
                rep.add(apparent_tag, "SKIP", f"{label}: only {total} qualifying pixels")
            else:
                fraction = violations / total
                rep.add(apparent_tag, "WARN" if fraction > APPARENT_WARN_FRAC else "PASS",
                        f"{label}: {total} px, {100*fraction:.1f}% violate")

    # 2.2 georeference anchors, per temperature-like product. The run month
    # decides which hemisphere carries the requirement (summer margins are
    # 10-20 C; winter margins are noise). Dewpoint gets a season-independent
    # dry-desert-vs-marine-antipode test instead.
    month = None
    refs_present = {next(iter(reader.refs)) for reader in readers.values() if reader.refs}
    if len(refs_present) == 1:
        month = datetime.datetime.fromtimestamp(next(iter(refs_present)),
                                                tz=datetime.timezone.utc).month
    def anti_lon(lon): return ((lon + 360) % 360) - 180
    georef_ok = []
    for (fam, form), reader in sorted(readers.items()):
        if fam in ANCHOR_WARM_FAMS:
            held = {"NH": 0, "SH": 0}; detail = []
            for name, lon, lat, hemisphere, _ in ANCHORS:
                here = reader.point_daily_max(lon, lat)
                there = reader.point_daily_max(anti_lon(lon), lat)
                if np.isfinite(here) and np.isfinite(there):
                    anchor_passed = bool(here > there + ANCHOR_MARGIN_C)
                    held[hemisphere] += anchor_passed
                    detail.append(f"{name} {here:.0f}/{there:.0f}")
                    if trace is not None:
                        row, col = cell(lon, lat)
                        anti_row, anti_col = cell(anti_lon(lon), lat)
                        trace.pixel(f"{reader.result['prod']}:georef-warm-anchor", row, col,
                                    product=reader.result["prod"], anchor=name,
                                    hemisphere=hemisphere, month=month,
                                    classifications=sorted(set(
                                        ["desert-anchor", hemisphere]
                                        + season_classification(row, month)
                                        + value_classification(fam, here, row, month, form))),
                                    values={"anchor_value_c": here,
                                            "antipode_value_c": there,
                                            "antipode_row": anti_row,
                                            "antipode_col": anti_col,
                                            "antipode_lon": anti_lon(lon),
                                            "antipode_lat": lat},
                                    test=f"anchor > antipode + {ANCHOR_MARGIN_C:g}C",
                                    result="PASS" if anchor_passed else "FAIL")
            if month in NH_SUMMER_MONTHS:
                ok = held["NH"] >= 2; rule = "NH-summer"
            elif month in SH_SUMMER_MONTHS:
                ok = held["SH"] >= 2; rule = "SH-summer"
            else:
                ok = held["NH"] >= 2 or held["SH"] >= 2; rule = "either-hemisphere"
            message = f"georef anchors ({rule}, month {month}): NH {held['NH']}/4, SH {held['SH']}/3"
            if not ok:
                message += " (" + "; ".join(detail) + ")"
            rep.add(reader.result["prod"], "PASS" if ok else "FAIL", message)
            georef_ok.append(ok)
        elif fam == "dewpoint":
            held = evaluable = 0
            for name, lon, lat, hemisphere, ocean_antipode in ANCHORS:
                if not ocean_antipode:
                    continue
                here = reader.point_daily_max(lon, lat)
                there = reader.point_daily_max(anti_lon(lon), lat)
                if np.isfinite(here) and np.isfinite(there):
                    evaluable += 1
                    anchor_passed = bool(here < there - ANCHOR_MARGIN_C)
                    held += anchor_passed
                    if trace is not None:
                        row, col = cell(lon, lat)
                        anti_row, anti_col = cell(anti_lon(lon), lat)
                        trace.pixel(f"{reader.result['prod']}:georef-dry-anchor", row, col,
                                    product=reader.result["prod"], anchor=name,
                                    hemisphere=hemisphere, month=month,
                                    classifications=sorted(set(
                                        ["desert-anchor", hemisphere]
                                        + season_classification(row, month)
                                        + value_classification(fam, here, row, month, form))),
                                    values={"anchor_dewpoint_c": here,
                                            "marine_antipode_dewpoint_c": there,
                                            "antipode_row": anti_row,
                                            "antipode_col": anti_col,
                                            "antipode_lon": anti_lon(lon),
                                            "antipode_lat": lat},
                                    test=f"desert dewpoint < marine antipode - {ANCHOR_MARGIN_C:g}C",
                                    result="PASS" if anchor_passed else "FAIL")
            ok = held >= 3
            rep.add(reader.result["prod"], "PASS" if ok else "FAIL",
                    f"georef dry-desert dewpoint anchors: {held}/{evaluable} drier than marine antipode")
            georef_ok.append(ok)
    if georef_ok:
        bad = georef_ok.count(False)
        rep.add("[run:georef]", "FAIL" if bad else "PASS",
                f"{len(georef_ok) - bad}/{len(georef_ok)} temperature-like products pass anchor placement")
    else:
        rep.add("[run:georef]", "SKIP", "no temperature-like product available for anchors")

    # 4.1 zonal summer/winter asymmetry: the summer hemisphere must be warmer
    # at matching |lat|. Catches north-south flips and season/run mislabeling;
    # sign is month-aware (reference: July N-S = +14.1 C at 45 deg).
    tmax = readers.get(("temp-max", "day")) or readers.get(("temp-max", "night"))
    if tmax and tmax.keys and (month in NH_SUMMER_MONTHS or month in SH_SUMMER_MONTHS):
        decoded = tmax.read(tmax.keys[0])
        row_north, _ = cell(0.0, ZONAL_LAT_DEG)
        row_south, _ = cell(0.0, -ZONAL_LAT_DEG)
        north_mean = float(np.nanmean(decoded[row_north]))
        south_mean = float(np.nanmean(decoded[row_south]))
        diff = north_mean - south_mean
        if month in NH_SUMMER_MONTHS:
            ok = diff > ZONAL_MARGIN_C; expected = f"N warmer by >{ZONAL_MARGIN_C:g}C"
        else:
            ok = diff < -ZONAL_MARGIN_C; expected = f"S warmer by >{ZONAL_MARGIN_C:g}C"
        rep.add("[run:season]", "PASS" if ok else "FAIL",
                f"zonal-mean temp-max at +/-{ZONAL_LAT_DEG:g} deg: N-S = {diff:+.1f} C (month {month} expects {expected})")
        if trace is not None:
            key = tmax.keys[0]
            for row, zone, row_mean in ((row_north, "north-zonal-row", north_mean),
                                        (row_south, "south-zonal-row", south_mean)):
                for col, value in enumerate(decoded[row]):
                    if not np.isfinite(value):
                        continue
                    if not trace.pixel("[run:season]:zonal-mean", row, col,
                                       ref_time=key[0], valid_time=key[1], month=month,
                                       classifications=sorted(set(
                                           [zone] + season_classification(row, month)
                                           + value_classification("temp-max", value, row, month,
                                                                  tmax.result["form"]))),
                                       values={"temperature_c": value,
                                               "row_mean_c": row_mean,
                                               "north_mean_c": north_mean,
                                               "south_mean_c": south_mean,
                                               "north_minus_south_c": diff},
                                       test=expected, result="OBSERVED"):
                        break
    elif tmax and tmax.keys:
        rep.add("[run:season]", "SKIP", f"month {month} outside asserted seasons; zonal sign not checked")
    else:
        rep.add("[run:season]", "SKIP", "day/night temp-max product unavailable")

    # 5.5 diurnal phase: the plain temperature field must peak in the local
    # afternoon/evening at low/mid-latitude cities. A 180-degree roll shifts
    # the phase by ~12 h; a band-time mislabel shifts it too. Season-robust
    # (reference peaks 12h-20h incl. winter Sydney), hence the wide window.
    temp_plain = readers.get(("temp", "plain"))
    if temp_plain and len(temp_plain.keys) >= 48:
        in_window = judged = 0; detail = []
        for name, lon, lat in DIURNAL_CITIES:
            by_day = defaultdict(list)
            for key in temp_plain.keys:
                value = temp_plain.point(key, lon, lat)
                if not np.isfinite(value):
                    continue
                solar = key[1] + lon * 240.0        # + lon/15 hours, in seconds
                solar_day = int(solar // 86400)
                solar_hour = (solar % 86400) / 3600.0
                by_day[solar_day].append((solar_hour, value))
                if trace is not None:
                    row, col = cell(lon, lat)
                    trace.pixel("[run:diurnal]:temperature-observation", row, col,
                                city=name, ref_time=key[0], valid_time=key[1],
                                solar_day=solar_day, solar_hour=solar_hour,
                                classifications=sorted(set(
                                    ["diurnal-candidate"]
                                    + season_classification(row, month)
                                    + value_classification("temp", value, row, month, "plain"))),
                                values={"temperature_c": value},
                                test="candidate for local-solar daily maximum",
                                result="OBSERVED")
            full_days = [day for day in sorted(by_day) if len(by_day[day]) >= 20][:4]
            peaks = [max(by_day[day], key=lambda hour_value: hour_value[1])[0]
                     for day in full_days]
            for peak in peaks:
                judged += 1
                in_window += DIURNAL_HOURS[0] <= peak < DIURNAL_HOURS[1]
                if trace is not None:
                    row, col = cell(lon, lat)
                    peak_ok = DIURNAL_HOURS[0] <= peak < DIURNAL_HOURS[1]
                    trace.pixel("[run:diurnal]:daily-peak", row, col, city=name,
                                classifications=sorted(set(
                                    ["daily-temperature-peak"] + season_classification(row, month))),
                                values={"peak_solar_hour": peak},
                                test=f"peak in [{DIURNAL_HOURS[0]:g},{DIURNAL_HOURS[1]:g}) local solar hours",
                                result="PASS" if peak_ok else "FAIL")
            detail.append(f"{name} {'/'.join(f'{peak:.0f}h' for peak in peaks)}")
        if judged >= 10:
            fraction = in_window / judged
            message = (f"daily temp max within local solar {DIURNAL_HOURS[0]:g}-{DIURNAL_HOURS[1]:g}h: "
                       f"{in_window}/{judged} city-days")
            if fraction < DIURNAL_MIN_OK:
                message += " (" + "; ".join(detail) + ")"
            rep.add("[run:diurnal]", "PASS" if fraction >= DIURNAL_MIN_OK else "FAIL", message)
        else:
            rep.add("[run:diurnal]", "SKIP", f"only {judged} evaluable city-days")
    else:
        rep.add("[run:diurnal]", "SKIP", "plain temp product unavailable or series too short")

    for reader in readers.values():
        reader.close()

# ----- weather-code consistency (wxcode vs companion fields) -----------------
# Thresholds (delivered units). Tunable; chosen leniently to avoid false positives
# on good data while still catching gross inconsistencies.
# frozen-precip code => temp at/below this. The day/night forms compare against
# the window-MAX temperature, where a real snowy-morning/warm-afternoon day is
# not a defect -- hence the more lenient limit (winter/shoulder seasons multiply
# such cases).
FROZEN_MAX_C = {"plain": 6.0, "day": 9.0, "night": 9.0}
CLEAR_RATE_MAX = 0.1    # clear/sunny/dry code => precip rate at/below this (in/hr)
CLOUD_MIN = 50.0        # precip / cloudy code => cloud cover at/above this (%)
CAPE_MIN = 100.0        # thunderstorm code => CAPE at/above this (J/kg)
FOG_VIS_MAX = 3.0       # fog code => visibility at/below this (miles)
FOG_RH_MIN = 85.0       # fog code => RH at/above this (%)
OBSTR_VIS_MAX = 6.0     # dust/haze/smoke code => visibility at/below this (miles)
WINDY_GUST_MIN = 25.0   # windy code => gust at/above this (mph)
VERYCOLD_MAX = 2.0      # very-cold code => temp at/below this (C)
HUMID_RH_MIN = 70.0     # humid code => RH at/above this (%)
WX_VIOL_FRAC_FAIL = 0.02   # hard rules FAIL above this violation fraction
WX_SOFT_WARN_FRAC = 0.10   # soft rules WARN above this violation fraction
WX_MIN_PIXELS = 200        # need at least this many matching pixels to judge a rule

# product-code stems for wxcode + its companions
WX_STEM = {"wxcode": "wxcode", "temp": "temp-c-2meter", "temp-max": "temp-max-c-2meter",
           "preciprate": "preciprate-inph-surface", "cape": "cape-jkg-surface", "cloud": "cloud-total",
           "vis": "visibility-miles-surface", "rh": "relhumidity-2meter", "gust": "gust-mph-10meter"}

def _wx_code(form, key):
    stem = WX_STEM[key]
    return f"bgg-global-{stem}" if form == "plain" else f"bgg-global-{form}-{stem}"

def _find_tif(dirpath, prod, rep=None, tag=None):
    hits = []
    for path in tif_paths(dirpath):
        identity = parse_tif_identity(path)
        if identity and identity["product"] == prod:
            hits.append(path)
    if len(hits) > 1:
        if rep is not None:
            rep.add(tag or "[run:inputs]", "FAIL",
                    f"multiple files found for {prod}: {', '.join(os.path.basename(x) for x in hits)}")
        return None
    return hits[0] if hits else None

def wx_groups(label):
    """Classify a wxcode category label into condition groups (a label may match several)."""
    l = label.lower(); g = set()
    if l.startswith("chance of"): g.add("chance")
    if any(k in l for k in ["snow", "sleet", "freezing", "ice pellet", "flurr", "blowing snow", "mixed precip", "frost"]):
        g.add("frozen")
    if any(k in l for k in ["rain", "shower", "drizzle"]): g.add("liquid")
    if "thunderstorm" in l: g.add("thunder")
    if l == "fog": g.add("fog")
    if any(k in l for k in ["dust", "haze", "smoke"]): g.add("obstruction")
    if l == "windy": g.add("windy")
    if l == "very hot": g.add("very_hot")
    if l == "very cold": g.add("very_cold")
    if l == "humid": g.add("humid")
    if l in ("sunny", "clear", "mostly clear", "dry"): g.add("clear")
    if l in ("cloudy", "mostly cloudy"): g.add("cloudy")
    # "falling precipitation" excludes standalone condition labels
    if (g & {"frozen", "liquid", "thunder"}) and l not in ("frost", "freezing", "blowing snow", "dry"):
        g.add("precip")
    return g

def wxcode_consistency(dirpath, form, sample_n, legends_dir, rep, trace=None):
    """Cross-check wxcode categories against companion fields (temp, precip rate, CAPE,
    cloud, visibility, RH, gust) at matching valid times. Samples sample_n bands per form.
    Companions are matched by both GRIB_REF_TIME and GRIB_VALID_TIME."""
    trace_enabled = trace is not None and trace.enabled
    tag = f"[wx:{form}]"
    wx_prod = _wx_code(form, "wxcode")
    wx_path = _find_tif(dirpath, wx_prod, rep, tag)
    if not wx_path:
        rep.add(tag, "SKIP", "wxcode product unavailable; checks not run")
        return
    wxds = gdal.Open(wx_path)
    leg = load_legend(wx_prod, legends_dir)
    if leg is None:
        rep.add(tag, "WARN", "wxcode legend unavailable; checks skipped"); wxds = None; return
    _, cat = build_lut(leg)          # index -> category label
    n = wxds.RasterCount
    idxs = [position + 1 for position in sample_positions(n, sample_n)]

    temp_key = "temp" if form == "plain" else "temp-max"   # day/night have no plain temp
    comp_keys = {"temp": temp_key, "rate": "preciprate", "cape": "cape", "cloud": "cloud",
                 "vis": "vis", "rh": "rh", "gust": "gust"}
    comp_ds = {}; comp_lut = {}; comp_vt = {}
    for ck, key in comp_keys.items():
        path = _find_tif(dirpath, _wx_code(form, key), rep, tag)
        if not path:
            continue
        ds = gdal.Open(path)
        cl = load_legend(_wx_code(form, key), legends_dir)
        comp_ds[ck] = ds
        comp_lut[ck] = build_lut(cl)[0] if cl else None
        vt = {}
        for b in range(1, ds.RasterCount + 1):
            ref = band_meta(ds, b, "GRIB_REF_TIME")
            valid = band_meta(ds, b, "GRIB_VALID_TIME")
            if ref is not None and valid is not None:
                vt.setdefault((int(str(ref).split()[0]), int(str(valid).split()[0])), b)
        comp_vt[ck] = vt

    def decode(ck, run_valid, cache):
        if ck in cache:
            return cache[ck]
        ds = comp_ds.get(ck); lut = comp_lut.get(ck)
        if ds is None or lut is None:
            return None
        b = comp_vt[ck].get(run_valid)
        if b is None:
            return None
        cache[ck] = safe_decode(np.asarray(ds.GetRasterBand(b).ReadAsArray()), lut)
        return cache[ck]

    frozen_limit = FROZEN_MAX_C[form]
    frozen_name = f"frozen->temp<={frozen_limit:g}C"
    rule_specs = [
        (frozen_name, "frozen", "temp", lambda d: d > frozen_limit,
         f"frozen weather implies temperature <= {frozen_limit:g}C"),
        ("clear->rate~0", "clear", "rate", lambda d: d > CLEAR_RATE_MAX,
         f"clear weather implies precipitation rate <= {CLEAR_RATE_MAX:g} in/hr"),
        ("fog->vis<=3mi", "fog", "vis", lambda d: d > FOG_VIS_MAX,
         f"fog implies visibility <= {FOG_VIS_MAX:g} miles"),
        ("precip->rate>0", "precip", "rate", lambda d: d <= 0,
         "falling precipitation implies precipitation rate > 0"),
        ("precip->cloud>=50%", "precip", "cloud", lambda d: d < CLOUD_MIN,
         f"falling precipitation implies cloud cover >= {CLOUD_MIN:g}%"),
        ("thunder->CAPE>=100", "thunder", "cape", lambda d: d < CAPE_MIN,
         f"thunderstorm implies CAPE >= {CAPE_MIN:g} J/kg"),
        ("fog->RH>=85%", "fog", "rh", lambda d: d < FOG_RH_MIN,
         f"fog implies relative humidity >= {FOG_RH_MIN:g}%"),
        ("obstruction->vis<=6mi", "obstruction", "vis", lambda d: d > OBSTR_VIS_MAX,
         f"dust/haze/smoke implies visibility <= {OBSTR_VIS_MAX:g} miles"),
        ("windy->gust>=25mph", "windy", "gust", lambda d: d < WINDY_GUST_MIN,
         f"windy weather implies gust >= {WINDY_GUST_MIN:g} mph"),
        ("very_cold->temp<=2C", "very_cold", "temp", lambda d: d > VERYCOLD_MAX,
         f"very cold weather implies temperature <= {VERYCOLD_MAX:g}C"),
        ("humid->RH>=70%", "humid", "rh", lambda d: d < HUMID_RH_MIN,
         f"humid weather implies relative humidity >= {HUMID_RH_MIN:g}%"),
        ("cloudy->cloud>=50%", "cloudy", "cloud", lambda d: d < CLOUD_MIN,
         f"cloudy weather implies cloud cover >= {CLOUD_MIN:g}%"),
    ]
    acc = {name: [0, 0] for name, _, _, _, _ in rule_specs}
    for b in idxs:
        refb = band_meta(wxds, b, "GRIB_REF_TIME")
        vtb = band_meta(wxds, b, "GRIB_VALID_TIME")
        if refb is None or vtb is None:
            continue
        run_valid = (int(str(refb).split()[0]), int(str(vtb).split()[0]))
        wraw = np.asarray(wxds.GetRasterBand(b).ReadAsArray())
        gidx = defaultdict(list)
        for ix in np.unique(wraw):
            lab = cat.get(int(ix))
            if not lab:
                continue
            for g in wx_groups(lab):
                gidx[g].append(ix)
        mask = {g: np.isin(wraw, v) for g, v in gidx.items()}
        chance = mask.get("chance", np.zeros(wraw.shape, bool))
        gm = lambda g: mask.get(g, np.zeros(wraw.shape, bool)) & ~chance
        decoded = {}
        for name, group, companion, predicate, predicate_text in rule_specs:
            dec = decode(companion, run_valid, decoded)
            if dec is None:
                continue
            selected = gm(group) & np.isfinite(dec)
            count = int(selected.sum())
            if count:
                pixel_failures = predicate(dec[selected])
                acc[name][0] += count
                acc[name][1] += int(pixel_failures.sum())
                if trace_enabled:
                    failed = np.zeros(selected.shape, dtype=bool)
                    failed[selected] = pixel_failures
                    family = {"temp": temp_key, "rate": "preciprate", "cape": "cape",
                              "cloud": "cloud-total", "vis": "visibility",
                              "rh": "relhumidity", "gust": "gust-mph"}[companion]
                    trace_weather_rule_pixels(trace, f"{tag}:{name}", run_valid,
                                              selected, failed, wraw, cat, dec,
                                              family, companion, form, predicate_text)

    hard = {frozen_name, "clear->rate~0", "fog->vis<=3mi", "fog->RH>=85%"}
    companions = {name: companion for name, _, companion, _, _ in rule_specs}
    for name, (nn, viol) in sorted(acc.items()):
        companion = companions[name]
        if companion not in comp_ds:
            rep.add(tag, "SKIP", f"{name}: companion {companion} product unavailable")
            continue
        if nn < WX_MIN_PIXELS:
            rep.add(tag, "SKIP", f"{name}: only {nn} matching pixels across {len(idxs)} sampled bands")
            continue
        frac = viol / nn
        if name in hard:
            lvl = "FAIL" if frac > WX_VIOL_FRAC_FAIL else "PASS"
        else:
            lvl = "WARN" if frac > WX_SOFT_WARN_FRAC else "PASS"
        rep.add(tag, lvl, f"{name}: {nn} px sampled, {100*frac:.1f}% violate")
    wxds = None
    comp_ds.clear()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", required=True, help="folder containing BGG product GeoTIFFs")
    ap.add_argument("--legends", default=None, help="folder of local *_legend.json (else fetch from CDN)")
    ap.add_argument("--strict", action="store_true", help="treat WARN as FAIL")
    ap.add_argument("-v", "--verbose", action="store_true",
                    help="emit structured aggregate and per-pixel trace records to stderr")
    ap.add_argument("--verbose-pixel-limit", type=int, default=0, metavar="N",
                    help="maximum pixel trace records per rule (0 means unlimited; -v can be enormous)")
    ap.add_argument("--cross-sample-bands", type=int, default=3,
                    help="inter-variable checks: bands sampled per form (0 checks all)")
    ap.add_argument("--wx-sample-bands", type=int, default=3,
                    help="wxcode-vs-conditions consistency: bands to sample per form (0 disables)")
    ap.add_argument("--json", default=None, metavar="PATH",
                    help="also write the report (summary + items) as JSON")
    args = ap.parse_args()
    if args.verbose_pixel_limit < 0:
        ap.error("--verbose-pixel-limit must be zero or greater")
    if args.legends is None: args.legends = args.dir

    tifs = [path for path in tif_paths(args.dir) if "bgg-global-" in os.path.basename(path)]
    if not tifs:
        print(f"No bgg-global-*.tif found in {args.dir}", file=sys.stderr); return 2

    trace = VerboseTrace(args.verbose, args.verbose_pixel_limit)
    if args.verbose:
        trace.event("verbose-start", directory=args.dir, legends=args.legends,
                    pixel_limit=args.verbose_pixel_limit,
                    warning="per-pixel tracing may produce extremely large output")
    rep = Report(trace); results=[]; recognized=0
    input_groups = defaultdict(list)
    for path in tifs:
        identity = parse_tif_identity(path)
        if identity is None:
            continue
        fam = family_of(identity["product"])
        if fam is None:
            continue
        recognized += 1
        input_groups[(fam, form_of(identity["product"]))].append(path)
    for key, paths in input_groups.items():
        if len(paths) > 1:
            rep.add("[run:inputs]", "FAIL",
                    f"duplicate {key[0]}/{key[1]} files: {', '.join(os.path.basename(x) for x in paths)}")

    for t in tifs:
        try:
            results.append(check_product(t, args.legends, rep, trace))
        except Exception as e:
            rep.add(os.path.basename(t), "FAIL", f"exception: {e}")
    run_products = defaultdict(list)
    for result in results:
        if result and result["ref0"] is not None:
            run_products[result["ref0"]].append(result["prod"])
    if len(run_products) > 1:
        detail = "; ".join(f"{ref}: {len(products)} products"
                           for ref, products in sorted(run_products.items()))
        rep.add("[run:inputs]", "FAIL", f"mixed GRIB_REF_TIME values across input folder ({detail})")
    if recognized == 0:
        rep.add("[run:inputs]", "FAIL", "no recognized BGG products; no QA checks were executed")
    else:
        cross_checks(results, args.legends, args.cross_sample_bands, rep, trace)
    if args.wx_sample_bands > 0:
        for form in ("plain", "day", "night"):
            try:
                wxcode_consistency(args.dir, form, args.wx_sample_bands, args.legends, rep, trace)
            except Exception as e:
                rep.add(f"[wx:{form}]", "FAIL", f"wxcode checks aborted: {e}")

    # print grouped report
    order={"FAIL":0,"WARN":1,"SKIP":2,"PASS":3}
    fails=sum(1 for _,l,_ in rep.items if l=="FAIL")
    warns=sum(1 for _,l,_ in rep.items if l=="WARN")
    skips=sum(1 for _,l,_ in rep.items if l=="SKIP")
    passes=sum(1 for _,l,_ in rep.items if l=="PASS")
    cur=None
    ordered = sorted(rep.items, key=lambda x:(x[0], order[x[1]]))
    for prod,lvl,msg in ordered:
        if prod!=cur: print(f"\n{prod}"); cur=prod
        print(f"  [{lvl}] {msg}")
    print(f"\n==== {passes} PASS, {warns} WARN, {skips} SKIP, {fails} FAIL "
          f"over {recognized} recognized product files ({len(tifs)} tif files) ====")
    if args.json:
        payload = dict(summary=dict(passes=passes, warns=warns, skips=skips, fails=fails,
                                    recognized=recognized, tif_files=len(tifs)),
                       items=[dict(tag=prod, level=lvl, message=msg)
                              for prod, lvl, msg in ordered])
        with open(args.json, "w") as handle:
            json.dump(payload, handle, indent=2)
    if args.verbose:
        trace.event("verbose-end", pixel_records=trace.pixel_count,
                    pixel_trace_truncated=trace.pixel_truncated,
                    passes=passes, warns=warns, skips=skips, fails=fails)
    if recognized == 0:
        return 2
    bad = fails + (warns if args.strict else 0)
    return 1 if bad else 0

if __name__ == "__main__":
    sys.exit(main())
