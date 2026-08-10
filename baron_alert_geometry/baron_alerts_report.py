#!/usr/bin/env python3
"""
Baron Velocity Weather API - alert report with per-polygon centroids.

Walks every page of the alert feed, resolves the polygon(s) behind each alert,
computes a centroid for each one, and writes a single consolidated JSON report.

Polygon resolution
------------------
An alert carries geometry in one of two ways:

  * zone-based (the `all` product): the alert lists NWS zone ids in `zones` and
    carries no geometry. The polygon comes from the zone geometry dataset built
    by baron_zones_fetch.py, or from the live zones/{id} endpoint.
  * storm-based (the `poly` product): the alert carries an inline `geometry`
    object describing the warning polygon itself.

The `all-poly` product returns both kinds; this script handles either, using the
inline geometry when present and falling back to zone lookup otherwise.

Centroids
---------
Each polygon gets an area-weighted centroid. Each alert also gets a single
combined centroid across all of its polygons, weighted by area and corrected by
cos(latitude) so that a polygon's weight approximates its true surface area
rather than its area in square degrees.

Both are antimeridian-safe. Four zones in the dataset genuinely straddle 180
degrees (AKC016 and the Bering Sea marine zones PKZ767/784/785); a naive planar
centroid of those lands in the Atlantic off Africa. Longitudes are shifted into a
continuous frame before the centroid is taken and normalised back afterwards, and
the combined centroid averages longitudes as unit vectors, which wraps correctly
by construction.

Data quirks handled
-------------------
  * Inline alert geometry is non-standard GeoJSON: a `Polygon` whose
    `coordinates` is a bare ring (nesting depth 2) rather than a list of rings
    (depth 3). Standard parsers reject or misread it, so it is re-nested. Rings
    are already closed.
  * `from` is pinned to the timestamp reported by page 1 so that all pages come
    from one consistent snapshot. Without it the live feed can shift between
    requests, duplicating or skipping alerts.
  * Requesting a page beyond `meta.pages` returns HTTP 400, so the walk is
    bounded by the page count and re-reads it from every response.
  * A zone id may map to several distinct geometry rows (227 do). Every row is
    reported as its own polygon with its own centroid; none are collapsed.
  * Fire-weather alerts cite their zones with a Z code (WYZ286) while the zone
    shapefile stores fire zones with an F code (WYF286, "Absaroka Mountains/North
    Shoshone NF"). The ingest synthesises that F, which exists in no NWS product.
    For an FW product the F-coded FIRE zone is therefore resolved first.
  * Anything still unresolvable is recorded per alert in `unresolved_zones` and
    counted in the report meta rather than dropped.

Usage
-----
    python3 baron_alerts_report.py                          # all product -> alerts_report.json
    python3 baron_alerts_report.py --product all-poly       # include storm-based polygons
    python3 baron_alerts_report.py --include-geometry       # embed polygons (large)
    python3 baron_alerts_report.py --no-text                # drop bulletin text
    python3 baron_alerts_report.py --geometry-source api    # ignore the local GeoPackage
"""

import argparse
import hashlib
import json
import logging
import math
import os
import re
import sys
import time
from datetime import datetime, timezone

from baron_zones_fetch import BaronClient, FetchError, NotFound, backup_file, get_credentials

try:
    from osgeo import gdal, ogr
    gdal.UseExceptions()
except ImportError:
    sys.exit('error: GDAL Python bindings required (python3 -c "from osgeo import ogr")')

PRODUCTS = ('all', 'poly', 'all-poly')
DEFAULT_GPKG = os.path.join('zones_out', 'zones.gpkg')
MAX_PAGE_WALK = 500          # backstop against a runaway pages value
LOG_FILE = 'baron_alerts_report.log'

# Fire-weather alerts cite their zones with a Z code (WYZ277) while the zone
# shapefile stores fire zones with an F code (WYF277 "Lincoln and Uinta
# Counties/Lower Elevations"). Same zone, different letter. Verified for all 31
# such references in a live snapshot: every one has an F-coded FIRE twin.
FIRE_RECODE_RE = re.compile(r'^([A-Z]{2})Z(\d{3})$')

# The recode is gated on the alert being a fire-weather product, because NWS reuses
# zone numbers between the two zone sets: 3,016 state+number pairs exist as both a
# FORECAST zone and a FIRE zone. An unconditional Z->F fallback could therefore
# resolve a genuinely missing forecast zone to unrelated fire geometry.
FIRE_WEATHER_VTEC_PREFIX = 'FW'

logger = logging.getLogger('baron_alerts')


def is_fire_weather(alert):
    """True if the alert is a fire-weather product (VTEC phenomenon FW)."""
    for vtec in alert.get('vtecs') or []:
        if str(vtec.get('pps') or '').upper().startswith(FIRE_WEATHER_VTEC_PREFIX):
            return True
    # Fall back to the product name when an alert carries no VTEC block.
    return any('fireweather' in str(t).lower().replace(' ', '')
               for t in alert.get('types') or [])


# --------------------------------------------------------------------------- #
# Geometry helpers
# --------------------------------------------------------------------------- #

def map_coords(coords, fn):
    """Apply fn to every coordinate pair in an arbitrarily nested list."""
    if coords and isinstance(coords[0], (int, float)):
        return fn(coords)
    return [map_coords(c, fn) for c in coords]


def normalise_geojson(geom):
    """Repair the API's under-nested inline polygons.

    The alert feed emits {"type": "Polygon", "coordinates": [[lon, lat], ...]},
    a bare ring where GeoJSON requires a list of rings. MultiPolygon is checked
    the same way. Anything already correctly nested is returned untouched.
    """
    if not isinstance(geom, dict) or 'coordinates' not in geom:
        return geom, False

    def depth(node):
        n = 0
        while isinstance(node, list) and node:
            n += 1
            node = node[0]
        return n

    gtype = geom.get('type')
    want = {'Polygon': 3, 'MultiPolygon': 4, 'LineString': 2, 'Point': 1}.get(gtype)
    have = depth(geom['coordinates'])
    if want is None or have >= want:
        return geom, False

    fixed = dict(geom)
    coords = geom['coordinates']
    for _ in range(want - have):
        coords = [coords]
    fixed['coordinates'] = coords
    return fixed, True


def polygon_centroid(geom_json):
    """Area-weighted centroid of a GeoJSON polygon, antimeridian-safe.

    Returns a dict with centroid, bbox, part count, planar area (used only as a
    combining weight, not published as a measurement) and whether the centroid
    falls inside the polygon. Returns None if the geometry cannot be read.
    """
    try:
        geom = ogr.CreateGeometryFromJson(json.dumps(geom_json))
    except Exception as exc:
        logger.error(f'GEOM_UNREADABLE {type(exc).__name__}: {exc}')
        return None
    if geom is None:
        logger.error('GEOM_UNREADABLE CreateGeometryFromJson returned None')
        return None

    min_x, max_x, min_y, max_y = geom.GetEnvelope()
    wrapped = (max_x - min_x) > 180

    if wrapped:
        # Shift the western hemisphere by +360 so the shape is continuous, take
        # the centroid there, then fold the result back into [-180, 180].
        shifted_json = dict(geom_json)
        shifted_json['coordinates'] = map_coords(
            geom_json['coordinates'],
            lambda p: [p[0] + 360.0 if p[0] < 0 else p[0]] + list(p[1:]))
        work = ogr.CreateGeometryFromJson(json.dumps(shifted_json))
        if work is None:
            work = geom
            wrapped = False
    else:
        work = geom

    try:
        centre = work.Centroid()
    except Exception as exc:
        logger.error(f'CENTROID_FAILED {type(exc).__name__}: {exc}')
        return None
    if centre is None or centre.IsEmpty():
        logger.error('CENTROID_FAILED empty centroid')
        return None

    lon, lat = centre.GetX(), centre.GetY()
    if wrapped:
        lon = ((lon + 180.0) % 360.0) - 180.0

    try:
        inside = bool(work.Contains(centre))
    except Exception:
        inside = None

    if geom.GetGeometryName() == 'MULTIPOLYGON':
        parts = geom.GetGeometryCount()
    else:
        parts = 1

    return {
        'centroid': {'lon': round(lon, 6), 'lat': round(lat, 6)},
        'centroid_inside_polygon': inside,
        'bbox': [round(min_x, 6), round(min_y, 6), round(max_x, 6), round(max_y, 6)],
        'geometry_type': geom.GetGeometryName().title().replace('Multipolygon', 'MultiPolygon'),
        'parts': parts,
        'crosses_antimeridian': wrapped,
        '_area': work.GetArea(),
    }


def combine_centroids(records):
    """Combine polygon centroids into one alert-level centroid.

    Longitudes are averaged as unit vectors, which handles the antimeridian
    without special-casing. Weights are planar area scaled by cos(latitude) so a
    polygon counts for roughly its true surface area rather than its area in
    square degrees.
    """
    x = y = lat_sum = weight_sum = 0.0
    for rec in records:
        lon = rec['centroid']['lon']
        lat = rec['centroid']['lat']
        weight = max(rec.get('_area', 0.0), 1e-12) * max(math.cos(math.radians(lat)), 1e-6)
        radians = math.radians(lon)
        x += math.cos(radians) * weight
        y += math.sin(radians) * weight
        lat_sum += lat * weight
        weight_sum += weight
    if weight_sum <= 0:
        return None
    return {
        'lon': round(math.degrees(math.atan2(y, x)), 6),
        'lat': round(lat_sum / weight_sum, 6),
    }


# --------------------------------------------------------------------------- #
# Zone geometry resolution
# --------------------------------------------------------------------------- #

class ZoneGeometryResolver:
    """Resolves a zone id to its geometry rows, GeoPackage first then API.

    A zone id can back several distinct geometry rows; every row is returned.
    Lookups are cached because alerts share zones heavily (measured: 1,511 zone
    references across only 1,250 distinct zones).
    """

    def __init__(self, client, gpkg_path, source='auto', precision=6, from_date=None):
        self.client = client
        self.source = source
        self.precision = precision
        self.from_date = from_date
        self.cache = {}
        self.stats = {'gpkg_hits': 0, 'api_hits': 0, 'misses': 0, 'api_calls': 0,
                      'fire_recoded': 0}
        self.layer = None
        self.dataset = None

        if source in ('auto', 'gpkg'):
            if os.path.exists(gpkg_path):
                self.dataset = ogr.Open(gpkg_path)
                if self.dataset is not None:
                    self.layer = self.dataset.GetLayer('zones') or self.dataset.GetLayer(0)
                    logger.info(f'GPKG_OPEN {gpkg_path} '
                                f'features={self.layer.GetFeatureCount()}')
            elif source == 'gpkg':
                sys.exit(f'error: --geometry-source gpkg but {gpkg_path} not found')
            else:
                logger.warning(f'GPKG_ABSENT {gpkg_path} not found; using the API only')

    def _from_gpkg(self, zone_id):
        if self.layer is None:
            return []
        self.layer.SetAttributeFilter(f"zone_id = '{zone_id}'")
        rows = []
        for feat in self.layer:
            geom = feat.GetGeometryRef()
            if geom is None:
                continue
            rows.append({
                'geometry': json.loads(geom.ExportToJson()),
                'zone_type': feat.GetField('type'),
                'name': feat.GetField('name'),
                'valid_begin': feat.GetField('valid_begin'),
                'source': 'geopackage',
            })
        self.layer.SetAttributeFilter(None)
        return rows

    def _from_api(self, zone_id):
        params = {'precision': self.precision}
        if self.from_date:
            params['from'] = self.from_date
        self.stats['api_calls'] += 1
        try:
            payload = self.client.get_json(f'zones/{zone_id}', params)
        except NotFound:
            return []
        except FetchError as exc:
            logger.error(f'ZONE_FETCH_FAILED {zone_id} {exc}')
            return []
        features = ([payload] if payload.get('type') == 'Feature'
                    else payload.get('features', []))
        rows = []
        for feat in features:
            props = feat.get('properties') or {}
            rows.append({
                'geometry': feat.get('geometry'),
                'zone_type': props.get('type'),
                'name': props.get('name'),
                'valid_begin': props.get('valid_begin'),
                'source': 'api',
            })
        return rows

    def _lookup(self, zone_id):
        """Raw lookup of one zone id: GeoPackage first, then API, per source."""
        rows = []
        if self.source in ('auto', 'gpkg'):
            rows = self._from_gpkg(zone_id)
            if rows:
                self.stats['gpkg_hits'] += 1
        if not rows and self.source in ('auto', 'api'):
            rows = self._from_api(zone_id)
            if rows:
                self.stats['api_hits'] += 1
        return rows

    def resolve(self, zone_id, allow_fire_recode=False):
        """Resolve a zone id to its geometry rows.

        Returns (rows, resolved_id). resolved_id differs from zone_id only when a
        fire-weather zone cited with a Z code was matched to its F-coded FIRE
        twin, which is accepted only when the twin is genuinely a FIRE zone.
        For a fire-weather product the F-coded zone takes priority over the cited
        Z code, because zone numbers are reused between the two zone sets.
        """
        zone_id = zone_id.upper()
        key = (zone_id, allow_fire_recode)
        if key in self.cache:
            return self.cache[key]

        rows = []
        resolved_id = zone_id

        # For a fire-weather product the F-coded fire zone is authoritative, so try
        # it BEFORE the cited Z code. NWS reuses zone numbers between the public and
        # fire zone sets - 3,016 state+number pairs exist in both - so the cited Z
        # code can match an unrelated forecast zone. Looking it up first would return
        # that zone and never reach the fire zone.
        if allow_fire_recode:
            match = FIRE_RECODE_RE.match(zone_id)
            if match:
                twin = f'{match.group(1)}F{match.group(2)}'
                candidate = [r for r in self._lookup(twin)
                             if str(r.get('zone_type') or '').upper() == 'FIRE']
                if candidate:
                    rows = candidate
                    resolved_id = twin
                    self.stats['fire_recoded'] += 1
                    logger.info(f'ZONE_RECODED {zone_id} -> {twin} '
                                f'(fire-weather zone cited with a Z code)')

        if not rows:
            rows = self._lookup(zone_id)
            resolved_id = zone_id

        if not rows:
            self.stats['misses'] += 1
            logger.warning(f'ZONE_UNRESOLVED {zone_id} absent from both the local '
                           f'dataset and the API')

        self.cache[key] = (rows, resolved_id)
        return rows, resolved_id


# --------------------------------------------------------------------------- #
# Alert feed walk
# --------------------------------------------------------------------------- #

def walk_alerts(client, product, from_date=None):
    """Fetch every page of the alert feed as one consistent snapshot.

    `from` is pinned to the timestamp page 1 reports so later pages cannot drift.
    The page count is re-read from every response, and the walk is bounded by it
    because requesting page > pages is an HTTP 400.
    """
    alerts = []
    pinned = from_date
    page = 1
    pages = 1
    pages_seen = []

    while page <= pages and page <= MAX_PAGE_WALK:
        params = {'page': page}
        if pinned:
            params['from'] = pinned
        payload = client.get_json(f'{product}/all.json', params)
        block = payload.get('alerts') or {}
        meta = block.get('meta') or {}
        data = block.get('data') or []

        if page == 1 and not pinned:
            pinned = meta.get('from')
            logger.info(f'SNAPSHOT_PINNED from={pinned}')

        reported = int(meta.get('pages') or 1)
        pages_seen.append(reported)
        if reported != pages and page > 1:
            logger.warning(f'PAGE_COUNT_CHANGED was={pages} now={reported} at page={page}')
        pages = reported

        alerts.extend(data)
        logger.info(f'PAGE_OK product={product} page={page}/{pages} alerts={len(data)} '
                    f'running_total={len(alerts)}')
        print(f'  page {page}/{pages}: {len(data)} alerts (total {len(alerts)})', flush=True)
        page += 1

    if page > MAX_PAGE_WALK:
        logger.error(f'PAGE_WALK_CAPPED stopped at {MAX_PAGE_WALK} pages')

    return alerts, pinned, pages, pages_seen


# --------------------------------------------------------------------------- #
# Report construction
# --------------------------------------------------------------------------- #

def build_alert_record(alert, resolver, include_geometry, include_text, fire_recode=True):
    """Turn one raw alert into a report record with per-polygon centroids."""
    record = {k: v for k, v in alert.items() if k not in ('geometry', 'text')}
    if include_text and 'text' in alert:
        record['text'] = alert['text']

    # The feed carries no alert id. VTEC event (office.phenomenon.significance.number)
    # identifies the *event*, but one event is split across several records, each
    # holding a different subset of zones: KWNS.SV.A.556 appeared as 6 records in one
    # snapshot. So event_key tracks an event across snapshots, while record_key
    # (event plus a hash of the zone list) is unique per record — verified 138/138
    # distinct where event_key alone gave only 96.
    events = [v.get('event') for v in alert.get('vtecs') or [] if v.get('event')]
    zones = alert.get('zones') or []
    record['event_keys'] = events
    record['event_key'] = events[0] if events else None
    record['record_key'] = '{}:{}'.format(
        '+'.join(events) or 'NOVTEC',
        hashlib.sha1('|'.join(zones).encode()).hexdigest()[:8])

    fire_weather = fire_recode and is_fire_weather(alert)
    polygons = []
    unresolved = []

    inline = alert.get('geometry')
    if inline:
        geom, renested = normalise_geojson(inline)
        measured = polygon_centroid(geom)
        if measured:
            entry = {'source': 'alert_polygon', 'zone_id': None}
            entry.update(measured)
            entry['renested_from_nonstandard_geojson'] = renested
            if include_geometry:
                entry['geometry'] = geom
            polygons.append(entry)
        else:
            unresolved.append({'zone_id': None, 'reason': 'inline geometry unreadable'})

    for zone_id in alert.get('zones', []):
        rows, resolved_id = resolver.resolve(zone_id, allow_fire_recode=fire_weather)
        if not rows:
            unresolved.append({'zone_id': zone_id,
                               'reason': 'not present in the local dataset or the API'})
            continue
        for index, row in enumerate(rows):
            measured = polygon_centroid(row['geometry'])
            if not measured:
                unresolved.append({'zone_id': zone_id, 'row': index,
                                   'reason': 'geometry unreadable'})
                continue
            entry = {
                'source': f'zone:{row["source"]}',
                'zone_id': zone_id,
                'zone_type': row.get('zone_type'),
                'zone_name': row.get('name'),
                'zone_row': index,
                'zone_rows_for_id': len(rows),
            }
            if resolved_id != zone_id:
                entry['resolved_zone_id'] = resolved_id
                entry['recode_reason'] = ('fire-weather zone cited with a Z code; '
                                          'matched the F-coded FIRE zone')
            entry.update(measured)
            if include_geometry:
                entry['geometry'] = row['geometry']
            polygons.append(entry)

    record['centroid'] = combine_centroids(polygons) if polygons else None
    record['polygon_count'] = len(polygons)
    record['polygons'] = polygons
    if unresolved:
        record['unresolved_zones'] = unresolved

    # _area is an internal combining weight in square degrees, not a measurement.
    for entry in polygons:
        entry.pop('_area', None)

    return record, len(unresolved)


def setup_logging(out_path, verbose):
    log_path = os.path.join(os.path.dirname(os.path.abspath(out_path)), LOG_FILE)
    logger.setLevel(logging.DEBUG)
    logger.handlers.clear()
    fh = logging.FileHandler(log_path)
    fh.setLevel(logging.DEBUG if verbose else logging.INFO)
    fh.setFormatter(logging.Formatter('%(asctime)sZ %(levelname)s %(message)s'))
    logger.addHandler(fh)
    sh = logging.StreamHandler(sys.stderr)
    sh.setLevel(logging.WARNING)
    sh.setFormatter(logging.Formatter('%(levelname)s %(message)s'))
    logger.addHandler(sh)
    return log_path


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description='Walk all alert pages and write a JSON report with per-polygon centroids.')
    p.add_argument('--product', default='all', choices=PRODUCTS,
                   help='alert product: all (zone-based), poly (storm-based), '
                        'all-poly (both) (default: all)')
    p.add_argument('--out', default='alerts_report.json', help='output JSON (default: alerts_report.json)')
    p.add_argument('--env', default='.env', help='path to .env with credentials')
    p.add_argument('--zones-gpkg', default=DEFAULT_GPKG,
                   help=f'zone geometry GeoPackage (default: {DEFAULT_GPKG})')
    p.add_argument('--geometry-source', default='auto', choices=('auto', 'gpkg', 'api'),
                   help='where zone polygons come from (default: auto = GeoPackage, API fallback)')
    p.add_argument('--from', dest='from_date', default=None,
                   help='pin the snapshot to this timestamp (default: whatever page 1 reports)')
    p.add_argument('--precision', type=int, default=6,
                   help='coordinate precision for API zone lookups, 4-9 (default: 6)')
    p.add_argument('--include-geometry', action='store_true',
                   help='embed full polygon geometry in the report (much larger output)')
    p.add_argument('--no-text', action='store_true', help='omit the bulletin text of each alert')
    p.add_argument('--no-fire-zone-recode', action='store_true',
                   help='disable matching Z-coded fire-weather zones to their F-coded '
                        'FIRE twins; those zones then report as unresolved')
    p.add_argument('--indent', type=int, default=2, help='JSON indent, 0 for compact (default: 2)')
    p.add_argument('--verbose', action='store_true', help='debug-level logging to the log file')
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    log_path = setup_logging(args.out, args.verbose)
    key, secret, base_url = get_credentials(args.env)
    client = BaronClient(key, secret, base_url)

    started = time.time()
    logger.info(f'RUN_START product={args.product} out={args.out} '
                f'geometry_source={args.geometry_source} include_geometry={args.include_geometry}')
    print(f'Baron alert report  product={args.product}')
    print(f'log: {log_path}')

    print('walking alert pages...')
    alerts, pinned, pages, pages_seen = walk_alerts(client, args.product, args.from_date)
    if not alerts:
        print('no alerts returned; nothing to report')
        logger.warning('NO_ALERTS the feed returned zero alerts')

    resolver = ZoneGeometryResolver(client, args.zones_gpkg, args.geometry_source,
                                   args.precision, pinned)

    zone_versions = {}
    try:
        zone_versions = client.get_json('zones/versions', {'from': pinned} if pinned else None
                                        ).get('zones', {})
    except (FetchError, NotFound) as exc:
        logger.warning(f'VERSIONS_UNAVAILABLE {exc}')

    print(f'resolving polygons for {len(alerts)} alerts...')
    records = []
    total_unresolved = 0
    for i, alert in enumerate(alerts, 1):
        record, unresolved = build_alert_record(
            alert, resolver, args.include_geometry, not args.no_text,
            fire_recode=not args.no_fire_zone_recode)
        records.append(record)
        total_unresolved += unresolved
        if i % 25 == 0:
            print(f'  {i}/{len(alerts)} alerts, '
                  f'{sum(r["polygon_count"] for r in records)} polygons', flush=True)

    total_polygons = sum(r['polygon_count'] for r in records)
    without_centroid = sum(1 for r in records if r['centroid'] is None)
    wrapped = sum(1 for r in records for p in r['polygons'] if p.get('crosses_antimeridian'))
    outside = sum(1 for r in records for p in r['polygons']
                  if p.get('centroid_inside_polygon') is False)
    renested = sum(1 for r in records for p in r['polygons']
                   if p.get('renested_from_nonstandard_geojson'))
    recoded = sum(1 for r in records for p in r['polygons'] if p.get('resolved_zone_id'))
    elapsed = time.time() - started

    report = {
        'meta': {
            'generated_at': datetime.now(timezone.utc).isoformat(),
            'source': {
                'base_url': base_url,
                'product': args.product,
                'endpoint': f'reports/alert/{args.product}/all.json',
                'snapshot_from': pinned,
                'pages': pages,
                'pages_reported_per_request': pages_seen,
            },
            'geometry': {
                'zone_source': args.geometry_source,
                'zones_geopackage': (args.zones_gpkg
                                     if resolver.layer is not None else None),
                'zone_shapefile_versions': zone_versions,
                'api_zone_precision': args.precision,
                'geometry_embedded': args.include_geometry,
            },
            'centroid_method': {
                'per_polygon': 'area-weighted centroid in EPSG:4326, antimeridian-safe',
                'per_alert': ('area-weighted mean of polygon centroids; longitudes averaged '
                              'as unit vectors, weights scaled by cos(latitude)'),
            },
            'counts': {
                'alerts': len(records),
                'polygons': total_polygons,
                'alerts_without_centroid': without_centroid,
                'unresolved_zone_references': total_unresolved,
                'distinct_zones_resolved': len([z for z, v in resolver.cache.items() if v]),
                'polygons_crossing_antimeridian': wrapped,
                'centroids_outside_their_polygon': outside,
                'polygons_renested_from_nonstandard_geojson': renested,
                'polygons_from_recoded_fire_zones': recoded,
                'zone_lookups': dict(resolver.stats),
                # Successful responses only; 404s from unresolvable zones are
                # counted under zone_lookups.api_calls instead.
                'http_requests_ok': client.requests_made,
                'bytes_downloaded': client.bytes_downloaded,
                'seconds': round(elapsed, 1),
            },
        },
        'alerts': records,
    }

    backup_file(args.out)
    with open(args.out, 'w') as fh:
        json.dump(report, fh, indent=args.indent or None)

    logger.info(f'RUN_TOTAL alerts={len(records)} polygons={total_polygons} '
                f'unresolved={total_unresolved} requests={client.requests_made} '
                f'bytes={client.bytes_downloaded} seconds={elapsed:.1f}')

    print('\n' + '-' * 60)
    print(f'alerts                      {len(records)}')
    print(f'polygons with centroids     {total_polygons}')
    print(f'alerts without a centroid   {without_centroid}')
    print(f'unresolved zone references  {total_unresolved}')
    print(f'  from geopackage           {resolver.stats["gpkg_hits"]} zones')
    print(f'  from api                  {resolver.stats["api_hits"]} zones '
          f'({resolver.stats["api_calls"]} calls)')
    print(f'  unresolvable              {resolver.stats["misses"]} zones')
    print(f'  fire zones recoded Z->F   {resolver.stats["fire_recoded"]} zones '
          f'({recoded} polygons)')
    print(f'antimeridian polygons       {wrapped}')
    print(f'centroids outside polygon   {outside}')
    if renested:
        print(f'renested inline polygons    {renested}')
    print(f'http requests               {client.requests_made} '
          f'({client.bytes_downloaded/1048576:.1f} MB)')
    print(f'elapsed                     {elapsed:.1f}s')
    print('-' * 60)
    print(f'report: {args.out} ({os.path.getsize(args.out)/1048576:.1f} MB)')

    return 0


if __name__ == '__main__':
    sys.exit(main())
