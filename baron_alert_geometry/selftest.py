#!/usr/bin/env python3
"""
selftest.py -- offline test harness for the geometry and GeoPackage code paths.

Builds a synthetic zones.gpkg and a synthetic set of alert records, then drives
the real code against them. No network and no credentials, so this runs anywhere
and gives the same answer every time.

What it covers
--------------
  geometry      re-nesting the API's under-nested inline polygons
                antimeridian centroids (the case that lands a Bering Sea zone
                off West Africa when handled naively)
                the combined alert centroid across the antimeridian
  geopackage    both writers: layer names, feature counts, geometry types,
                lon/lat axis order, attribute round-trip, indexes
                geometry fidelity: area in equals area out
  lookup        zone_geometry.py by id, multi-row ids, the fire Z -> F recode
                and the FORECAST/FIRE number collision it has to survive,
                output formats, --gpkg-out, exit code on a missing id

Usage:
    python3 selftest.py [--keep]
"""

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

from osgeo import gdal, ogr, osr

gdal.UseExceptions()

HERE = os.path.dirname(os.path.abspath(__file__))
ZONE_GEOMETRY = os.path.join(HERE, 'zone_geometry.py')

sys.path.insert(0, HERE)
import baron_alerts_report as report                                  # noqa: E402

passed = 0
failures = []


def check(label, ok, detail=''):
    global passed
    print(f'  [{"PASS" if ok else "FAIL"}] {label}{" — " + detail if detail else ""}')
    if ok:
        passed += 1
    else:
        failures.append(label)


def box(west, south, east, north):
    """A closed rectangular ring as GeoJSON Polygon coordinates."""
    return [[[west, south], [east, south], [east, north],
             [west, north], [west, south]]]


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #

# ALZ001 and ALF001 are the collision from KNOWN_ISSUES item 1: the same state and
# number exist as both a FORECAST zone and a FIRE zone. They are given clearly
# different boxes so a wrong resolution is visible in the centroid, not subtle.
# FMC001 carries two rows under one id, the multi-row case 227 real ids have.
ZONE_FIXTURES = [
    ('ALC089', 'COUNTY', 'Madison', box(-86.9, 34.6, -86.4, 35.0)),
    ('ALZ001', 'FORECAST', 'Lauderdale forecast zone', box(-88.0, 34.7, -87.5, 35.0)),
    ('ALF001', 'FIRE', 'Lauderdale fire zone', box(-80.0, 24.7, -79.5, 25.0)),
    ('FMC001', 'COUNTY', 'Onoun', box(149.0, 7.0, 149.2, 7.2)),
    ('FMC001', 'COUNTY', 'Faraulep', box(144.5, 8.5, 144.7, 8.7)),
    ('PKZ784', 'OFFSHORE', 'Bering Sea west', [[[179.0, 60.0], [-179.0, 60.0],
                                                [-179.0, 61.0], [179.0, 61.0],
                                                [179.0, 60.0]]]),
]


def build_zones_gpkg(path):
    """Write a synthetic zones.gpkg with the same schema baron_zones_fetch makes."""
    driver = ogr.GetDriverByName('GPKG')
    dataset = driver.CreateDataSource(path)
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(4326)
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    layer = dataset.CreateLayer('zones', srs, ogr.wkbMultiPolygon,
                                ['GEOMETRY_NAME=geom'])
    for name in ('zone_id', 'type', 'name', 'valid_begin'):
        layer.CreateField(ogr.FieldDefn(name, ogr.OFTString))
    for zone_id, zone_type, name, coords in ZONE_FIXTURES:
        feature = ogr.Feature(layer.GetLayerDefn())
        feature.SetField('zone_id', zone_id)
        feature.SetField('type', zone_type)
        feature.SetField('name', name)
        feature.SetField('valid_begin', '2026-04-16T00:00:00Z')
        geometry = ogr.CreateGeometryFromJson(
            json.dumps({'type': 'Polygon', 'coordinates': coords}))
        feature.SetGeometry(ogr.ForceToMultiPolygon(geometry))
        layer.CreateFeature(feature)
        feature = None
    layer = dataset = None
    con = sqlite3.connect(path)
    con.execute('CREATE INDEX idx_zones_zone_id ON zones(zone_id)')
    con.execute('CREATE INDEX idx_zones_type ON zones(type)')
    con.commit()
    con.close()


def alert_records():
    """Two synthetic report records, already in the shape build_alert_record emits."""
    county = {'type': 'Polygon', 'coordinates': box(-86.9, 34.6, -86.4, 35.0)}
    bering = {'type': 'Polygon',
              'coordinates': [[[179.0, 60.0], [-179.0, 60.0], [-179.0, 61.0],
                               [179.0, 61.0], [179.0, 60.0]]]}
    first = {
        'record_key': 'KHUN.SV.W.1:aaaaaaaa',
        'event_key': 'KHUN.SV.W.1',
        'event_keys': ['KHUN.SV.W.1'],
        'types': ['Severe Thunderstorm Warning'],
        'colors': ['#ffa500'],
        'valid_end': '2026-08-10T21:00:00Z',
        'zones': ['ALC089'],
        'polygon_count': 1,
        'polygons': [{
            'source': 'zone:geopackage', 'zone_id': 'ALC089', 'zone_type': 'COUNTY',
            'zone_name': 'Madison', 'zone_row': 0, 'zone_rows_for_id': 1,
            'centroid': {'lon': -86.65, 'lat': 34.8}, 'centroid_inside_polygon': True,
            'crosses_antimeridian': False, 'parts': 1, 'geometry_type': 'Polygon',
            '_geometry': county,
        }],
        'centroid': {'lon': -86.65, 'lat': 34.8},
    }
    second = {
        'record_key': 'PAFC.GL.W.9:bbbbbbbb',
        'event_key': 'PAFC.GL.W.9',
        'event_keys': ['PAFC.GL.W.9'],
        'types': ['Gale Warning'],
        'colors': ['#dda0dd'],
        'valid_end': '2026-08-10T23:00:00Z',
        'zones': ['PKZ784', 'MISSING1'],
        'polygon_count': 1,
        'polygons': [{
            'source': 'zone:geopackage', 'zone_id': 'PKZ784', 'zone_type': 'OFFSHORE',
            'zone_name': 'Bering Sea west', 'zone_row': 0, 'zone_rows_for_id': 1,
            'centroid': {'lon': -180.0, 'lat': 60.5}, 'centroid_inside_polygon': True,
            'crosses_antimeridian': True, 'parts': 1, 'geometry_type': 'Polygon',
            '_geometry': bering,
        }],
        'centroid': {'lon': -180.0, 'lat': 60.5},
        'unresolved_zones': [{'zone_id': 'MISSING1', 'reason': 'absent'}],
    }
    return [first, second]


def run_cli(*arguments):
    """Run zone_geometry.py and return (returncode, stdout, stderr)."""
    proc = subprocess.run([sys.executable, ZONE_GEOMETRY, *arguments],
                          capture_output=True, text=True, cwd=HERE)
    return proc.returncode, proc.stdout, proc.stderr


# --------------------------------------------------------------------------- #
# Tests
# --------------------------------------------------------------------------- #

def test_geometry():
    print('geometry')

    bare = {'type': 'Polygon', 'coordinates': [[-86.9, 34.6], [-86.4, 34.6],
                                               [-86.4, 35.0], [-86.9, 35.0],
                                               [-86.9, 34.6]]}
    fixed, renested = report.normalise_geojson(bare)
    check('a bare ring is re-nested to a list of rings', renested)
    check('the re-nested polygon parses',
          ogr.CreateGeometryFromJson(json.dumps(fixed)) is not None)

    already = {'type': 'Polygon', 'coordinates': box(-86.9, 34.6, -86.4, 35.0)}
    _, touched = report.normalise_geojson(already)
    check('a correct polygon is left alone', not touched)

    # The naive planar centroid of this shape is near longitude 0, in the Atlantic.
    # The correct answer sits on the antimeridian.
    bering = {'type': 'Polygon',
              'coordinates': [[[179.0, 60.0], [-179.0, 60.0], [-179.0, 61.0],
                               [179.0, 61.0], [179.0, 60.0]]]}
    measured = report.polygon_centroid(bering)
    lon = measured['centroid']['lon']
    check('an antimeridian zone is flagged', measured['crosses_antimeridian'] is True)
    check('its centroid stays on the antimeridian', abs(abs(lon) - 180.0) < 0.5,
          f'lon={lon}')
    check('its centroid is not dragged to the prime meridian', abs(lon) > 170.0,
          f'lon={lon}')
    check('its latitude is correct', abs(measured['centroid']['lat'] - 60.5) < 0.1,
          f"lat={measured['centroid']['lat']}")

    plain = report.polygon_centroid({'type': 'Polygon',
                                     'coordinates': box(-86.9, 34.6, -86.4, 35.0)})
    check('a normal zone is not flagged', plain['crosses_antimeridian'] is False)
    check('a normal centroid is right', abs(plain['centroid']['lon'] + 86.65) < 0.01,
          f"lon={plain['centroid']['lon']}")

    combined = report.combine_centroids([
        {'centroid': {'lon': 179.0, 'lat': 60.0}, '_area': 1.0},
        {'centroid': {'lon': -179.0, 'lat': 60.0}, '_area': 1.0}])
    check('a combined centroid wraps the antimeridian', abs(abs(combined['lon']) - 180.0) < 0.01,
          f"lon={combined['lon']}")

    check('bad geometry returns None, it does not raise',
          report.polygon_centroid({'type': 'Polygon', 'coordinates': 'rubbish'}) is None)


def test_centroid_gpkg(workdir):
    print('\ngeopackage: centroids')
    path = os.path.join(workdir, 'alerts_centroids.gpkg')
    records = alert_records()
    stats = report.write_centroid_gpkg(records, path)

    check('the file exists', os.path.exists(path))
    check('polygon centroid count is right', stats['polygon_centroids'] == 2,
          str(stats['polygon_centroids']))
    check('alert centroid count is right', stats['alert_centroids'] == 2,
          str(stats['alert_centroids']))

    dataset = ogr.Open(path)
    names = {dataset.GetLayer(i).GetName() for i in range(dataset.GetLayerCount())}
    check('both layers are present',
          names == {report.POLYGON_CENTROID_LAYER, report.ALERT_CENTROID_LAYER},
          str(sorted(names)))

    layer = dataset.GetLayerByName(report.POLYGON_CENTROID_LAYER)
    check('the centroid layer is points',
          ogr.GeometryTypeToName(layer.GetGeomType()) == 'Point',
          ogr.GeometryTypeToName(layer.GetGeomType()))

    layer.SetAttributeFilter("zone_id = 'ALC089'")
    feature = next(iter(layer))
    geometry = feature.GetGeometryRef()
    # A transposed axis order would put 34.8 in X. Latitude cannot exceed 90, so
    # this check fails loudly rather than shifting a point somewhere plausible.
    check('lon/lat are not transposed', abs(geometry.GetX() + 86.65) < 0.01,
          f'x={geometry.GetX():.4f} y={geometry.GetY():.4f}')
    check('the attributes round-trip', feature.GetField('zone_name') == 'Madison'
          and feature.GetField('record_key') == 'KHUN.SV.W.1:aaaaaaaa')
    check('booleans are stored as 0/1', feature.GetField('centroid_inside_polygon') == 1)
    layer.SetAttributeFilter(None)

    alerts = dataset.GetLayerByName(report.ALERT_CENTROID_LAYER)
    alerts.SetAttributeFilter("record_key = 'PAFC.GL.W.9:bbbbbbbb'")
    feature = next(iter(alerts))
    check('the alert row lists its zones', feature.GetField('zones') == 'PKZ784, MISSING1',
          feature.GetField('zones'))
    check('the unresolved count is carried', feature.GetField('unresolved_zone_count') == 1)
    dataset = None

    con = sqlite3.connect(path)
    indexes = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='index'")}
    con.close()
    check('the record_key index exists',
          f'idx_{report.POLYGON_CENTROID_LAYER}_record_key' in indexes)
    check('the zone_id index exists',
          f'idx_{report.POLYGON_CENTROID_LAYER}_zone_id' in indexes)


def test_geometry_gpkg(workdir):
    print('\ngeopackage: raw geometry')
    path = os.path.join(workdir, 'alerts_geometry.gpkg')
    records = alert_records()
    stats = report.write_geometry_gpkg(records, path)

    check('every polygon is written', stats['features'] == 2, str(stats['features']))
    check('nothing was skipped', stats['skipped'] == 0)

    dataset = ogr.Open(path)
    layer = dataset.GetLayerByName(report.ALERT_POLYGON_LAYER)
    check('the layer is MultiPolygon',
          ogr.GeometryTypeToName(layer.GetGeomType()) == 'Multi Polygon',
          ogr.GeometryTypeToName(layer.GetGeomType()))
    check('the feature count matches', layer.GetFeatureCount() == 2)

    layer.SetAttributeFilter("zone_id = 'ALC089'")
    feature = next(iter(layer))
    stored = feature.GetGeometryRef()
    source = ogr.CreateGeometryFromJson(json.dumps(
        {'type': 'Polygon', 'coordinates': box(-86.9, 34.6, -86.4, 35.0)}))
    # Area in equals area out: this catches a dropped ring, a truncated
    # coordinate, or a silent reprojection, which a feature count alone would not.
    check('the geometry survives the round-trip',
          abs(stored.GetArea() - source.GetArea()) < 1e-9,
          f'{stored.GetArea():.8f} vs {source.GetArea():.8f}')
    check('the centroid attribute matches the JSON record',
          abs(feature.GetField('centroid_lon') + 86.65) < 0.01)
    dataset = None

    # A record with no held geometry must be skipped, not written empty.
    stripped = alert_records()
    for record in stripped:
        for polygon in record['polygons']:
            polygon.pop('_geometry', None)
    bare_path = os.path.join(workdir, 'alerts_geometry_bare.gpkg')
    bare = report.write_geometry_gpkg(stripped, bare_path)
    check('polygons without held geometry are skipped, not written',
          bare['features'] == 0 and bare['skipped'] == 2,
          f"features={bare['features']} skipped={bare['skipped']}")


class StubResolver:
    """Stands in for ZoneGeometryResolver so record building needs no network."""

    def __init__(self):
        self.stats = {}

    def resolve(self, zone_id, allow_fire_recode=False):
        if zone_id.upper() != 'ALC089':
            return [], zone_id.upper()
        return [{'geometry': {'type': 'Polygon',
                              'coordinates': box(-86.9, 34.6, -86.4, 35.0)},
                 'zone_type': 'COUNTY', 'name': 'Madison',
                 'valid_begin': '2026-04-16T00:00:00Z', 'source': 'geopackage'}], 'ALC089'


def test_record_build():
    """The main() wiring: hold geometry for the writers, keep it out of the JSON."""
    print('\nrecord build')
    alert = {'types': ['Severe Thunderstorm Warning'], 'colors': ['#ffa500'],
             'zones': ['ALC089'], 'valid_end': '2026-08-10T21:00:00Z',
             'vtecs': [{'event': 'KHUN.SV.W.1', 'pps': 'SV'}], 'text': 'BULLETIN'}

    held, _ = report.build_alert_record(alert, StubResolver(), False, True,
                                        keep_geometry=True)
    check('keep_geometry holds the polygon for the writer',
          '_geometry' in held['polygons'][0])
    check('keep_geometry does not publish it as report data',
          'geometry' not in held['polygons'][0])

    plain, _ = report.build_alert_record(alert, StubResolver(), False, True,
                                         keep_geometry=False)
    check('without keep_geometry nothing is held', '_geometry' not in plain['polygons'][0])

    published, _ = report.build_alert_record(alert, StubResolver(), True, True,
                                             keep_geometry=True)
    check('include_geometry publishes the polygon too',
          'geometry' in published['polygons'][0])

    # This is the strip main() does before json.dump. A leaked private key would
    # silently inflate every report by the full geometry.
    for entry in held['polygons']:
        entry.pop('_geometry', None)
    text = json.dumps(held)
    check('the stripped record serialises to JSON', '_geometry' not in text)
    check('the centroid survives the strip', held['centroid'] is not None)

    missing, unresolved = report.build_alert_record(
        {'types': ['Gale Warning'], 'zones': ['NOPE99'], 'vtecs': []},
        StubResolver(), False, True, keep_geometry=True)
    check('an unresolved zone is recorded, not dropped', unresolved == 1
          and missing['unresolved_zones'][0]['zone_id'] == 'NOPE99')
    check('an alert with no polygon has no centroid', missing['centroid'] is None)


def test_lookup(workdir):
    print('\nlookup: zone_geometry.py')
    gpkg = os.path.join(workdir, 'zones.gpkg')
    common = ['--gpkg', gpkg, '--source', 'gpkg', '--quiet']

    code, out, _ = run_cli('ALC089', *common)
    check('a single id resolves', code == 0 and 'Madison' in out, out.strip()[:60])

    code, out, _ = run_cli('FMC001', *common, '--format', 'json')
    rows = json.loads(out)
    check('a multi-row id returns every row', len(rows) == 2, f'{len(rows)} rows')
    check('the rows are separately named',
          {r['name'] for r in rows} == {'Onoun', 'Faraulep'},
          str(sorted(r['name'] for r in rows)))
    check('each row reports the row count', all(r['rows_for_id'] == 2 for r in rows))

    code, out, _ = run_cli('ALC089', *common, '--format', 'geojson')
    collection = json.loads(out)
    check('geojson output is a FeatureCollection',
          collection['type'] == 'FeatureCollection' and len(collection['features']) == 1)
    check('the geojson feature carries geometry',
          collection['features'][0]['geometry']['type'] in ('Polygon', 'MultiPolygon'))

    code, out, _ = run_cli('ALC089', *common, '--format', 'wkt')
    check('wkt output is WKT', out.strip().split('\t')[1].startswith('MULTIPOLYGON'),
          out.strip()[:40])

    # The collision case. ALZ001 and ALF001 both exist. Without --fire the cited Z
    # code must win; with --fire the FIRE zone must win. Getting this backwards is
    # exactly the bug KNOWN_ISSUES item 1 describes.
    code, out, _ = run_cli('ALZ001', *common, '--format', 'json')
    rows = json.loads(out)
    check('without --fire a Z code stays on the FORECAST zone',
          rows[0]['zone_type'] == 'FORECAST' and rows[0]['resolved_zone_id'] == 'ALZ001',
          f"{rows[0]['zone_type']} {rows[0]['resolved_zone_id']}")

    code, out, _ = run_cli('ALZ001', *common, '--fire', '--format', 'json')
    rows = json.loads(out)
    check('with --fire the F-coded FIRE zone wins the collision',
          rows[0]['zone_type'] == 'FIRE' and rows[0]['resolved_zone_id'] == 'ALF001',
          f"{rows[0]['zone_type']} {rows[0]['resolved_zone_id']}")
    check('the recode is visible in the output', rows[0]['zone_id'] == 'ALZ001',
          'zone_id keeps the cited code')

    # A Z code with no F twin must fall back to the cited zone, not fail.
    code, out, _ = run_cli('ALC089', *common, '--fire', '--format', 'json')
    rows = json.loads(out)
    check('--fire falls back when there is no F twin',
          code == 0 and rows[0]['resolved_zone_id'] == 'ALC089')

    code, out, err = run_cli('NOPE99', *common)
    check('a missing id exits 1', code == 1, f'exit {code}')
    check('a missing id is named on stderr', 'NOPE99' in err, err.strip()[:60])

    code, out, _ = run_cli('ALC089', 'FMC001', *common, '--format', 'json')
    check('several ids resolve in one call', len(json.loads(out)) == 3,
          f'{len(json.loads(out))} rows')

    code, out, _ = run_cli('PKZ784', *common, '--format', 'json')
    rows = json.loads(out)
    check('an antimeridian zone is flagged through the CLI',
          rows[0]['crosses_antimeridian'] is True)
    check('its CLI centroid stays on the antimeridian',
          abs(abs(rows[0]['centroid']['lon']) - 180.0) < 0.5,
          f"lon={rows[0]['centroid']['lon']}")

    out_gpkg = os.path.join(workdir, 'one_zone.gpkg')
    code, out, _ = run_cli('FMC001', *common, '--gpkg-out', out_gpkg)
    dataset = ogr.Open(out_gpkg)
    written = dataset.GetLayer(0).GetFeatureCount()
    dataset = None
    check('--gpkg-out writes every row', code == 0 and written == 2, f'{written} features')

    code, out, err = run_cli(*common)
    check('no ids is an error', code != 0 and 'no zone ids' in err, err.strip()[:50])

    # The resolver caches (rows, resolved_id) for a miss as well as a hit, so the
    # tuple is truthy either way. Anything counting resolved zones must test rows.
    resolver = report.ZoneGeometryResolver(None, gpkg, 'gpkg')
    resolver.resolve('ALC089')
    resolver.resolve('NOPE99')
    check('the cache holds an entry for a miss too', len(resolver.cache) == 2)
    resolved = len([z for z, (rows, _) in resolver.cache.items() if rows])
    check('counting resolved zones tests rows, not the tuple', resolved == 1,
          f'{resolved} of {len(resolver.cache)} cached')


def test_env_resolution(workdir):
    """The .env beside the script must be found from any working directory."""
    print('\ncredentials: .env resolution')
    import baron_zones_fetch as fetch

    beside = os.path.join(HERE, '.env')
    case = os.path.join(workdir, 'elsewhere')
    os.makedirs(case, exist_ok=True)
    start = os.getcwd()
    os.chdir(case)
    try:
        resolved, tried = fetch.resolve_env_path('.env')
        if os.path.exists(beside):
            check('a bare .env resolves to the one beside the script',
                  os.path.abspath(resolved) == os.path.abspath(beside), resolved)
        else:
            check('a bare .env reports both places it looked', len(tried) == 2,
                  f'{len(tried)} paths')

        # A local .env must still win, so a per-project file is never shadowed.
        local = os.path.join(case, '.env')
        with open(local, 'w') as handle:
            handle.write('BARON_API_KEY=local\nBARON_API_SECRET=localsecret\n')
        resolved, _ = fetch.resolve_env_path('.env')
        # realpath, not abspath: mkdtemp hands back /var/... which is a symlink to
        # /private/var/..., so abspath alone compares two spellings of one file.
        check('a .env in the working directory still wins',
              os.path.realpath(resolved) == os.path.realpath(local), resolved)
        key, secret, base = fetch.get_credentials('.env')
        check('the local .env is the one actually read',
              key == 'local' and secret == 'localsecret', key)
        check('the base url falls back to the default',
              base == 'https://api.velocityweather.com', base)

        # The file is the only source. An exported key must not win, or a stale
        # shell variable silently overrides the file and is hard to diagnose.
        saved = {name: os.environ.get(name) for name in
                 ('BARON_API_KEY', 'BARON_API_SECRET', 'BARON_API_BASE_URL')}
        os.environ['BARON_API_KEY'] = 'from_environment'
        os.environ['BARON_API_SECRET'] = 'from_environment'
        os.environ['BARON_API_BASE_URL'] = 'https://wrong.example.com'
        try:
            key, secret, base = fetch.get_credentials('.env')
            check('an exported key does not override the file', key == 'local', key)
            check('an exported secret does not override the file',
                  secret == 'localsecret', secret)
            check('an exported base url does not override the file',
                  base == 'https://api.velocityweather.com', base)
        finally:
            for name, value in saved.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value
        os.remove(local)

        # An explicit path is used as given. Guessing elsewhere would silently read
        # the wrong credentials.
        named = os.path.join(case, 'named.env')
        resolved, tried = fetch.resolve_env_path(named)
        check('an explicit path is never second-guessed',
              resolved == named and len(tried) == 1, str(len(tried)))
        resolved, tried = fetch.resolve_env_path('sub/dir.env')
        check('a path with a directory is never second-guessed', len(tried) == 1)

        resolved, tried = fetch.resolve_env_path('absent.env')
        check('a missing bare name reports both candidates', len(tried) == 2
              and os.path.dirname(tried[1]) == HERE, str(tried[1]))
    finally:
        os.chdir(start)


def clean_records(count=6):
    """`count` fully-resolved alert records, enough to clear the low-alert warning."""
    records = []
    for i in range(count):
        records.append({
            'record_key': f'KHUN.SV.W.{i}:aaaaaaa{i}',
            'event_key': f'KHUN.SV.W.{i}',
            'event_keys': [f'KHUN.SV.W.{i}'],
            'types': ['Severe Thunderstorm Warning'],
            'colors': ['#ffa500'],
            'valid_end': '2026-08-10T21:00:00Z',
            'zones': ['ALC089'],
            'polygon_count': 1,
            'polygons': [{
                'source': 'zone:geopackage', 'zone_id': 'ALC089', 'zone_type': 'COUNTY',
                'zone_name': 'Madison', 'zone_row': 0, 'zone_rows_for_id': 1,
                'centroid': {'lon': -86.65, 'lat': 34.8},
                'centroid_inside_polygon': True, 'crosses_antimeridian': False,
                'parts': 1, 'geometry_type': 'Polygon',
                '_geometry': {'type': 'Polygon',
                              'coordinates': box(-86.9, 34.6, -86.4, 35.0)},
            }],
            'centroid': {'lon': -86.65, 'lat': 34.8},
        })
    return records


def test_check_alerts(workdir):
    """check_alerts.py must catch a GeoPackage that disagrees with the JSON."""
    print('\nmonitor: check_alerts.py')
    case = os.path.join(workdir, 'monitor')
    os.makedirs(case, exist_ok=True)
    records = clean_records()
    centroids = report.write_centroid_gpkg(records, os.path.join(case, 'alerts_centroids.gpkg'))
    geometry = report.write_geometry_gpkg(records, os.path.join(case, 'alerts_geometry.gpkg'))
    for record in records:
        for polygon in record['polygons']:
            polygon.pop('_geometry', None)

    meta = {
        'source': {'product': 'all', 'pages': 1, 'pages_reported_per_request': [1]},
        'outputs': {
            'json': 'alerts_report.json',
            'centroids_geopackage': centroids,
            'geometry_geopackage': geometry,
            'join_key': 'record_key',
        },
        'counts': {
            'alerts': len(records), 'polygons': len(records),
            'alerts_without_centroid': 0, 'unresolved_zone_references': 0,
            'seconds': 3.0,
        },
    }
    with open(os.path.join(case, 'alerts_report.json'), 'w') as handle:
        json.dump({'meta': meta, 'alerts': records}, handle)

    def run_check():
        proc = subprocess.run([sys.executable,
                               os.path.join(HERE, 'check_alerts.py'), '--check-only'],
                              capture_output=True, text=True, cwd=case)
        return proc.returncode, proc.stdout + proc.stderr

    code, out = run_check()
    check('a consistent report and geopackage pass', code == 0 and 'VERDICT OK' in out,
          out.strip().splitlines()[-1] if out.strip() else '')

    # Remove one centroid row. The JSON still claims 6, so the counts disagree.
    con = sqlite3.connect(os.path.join(case, 'alerts_centroids.gpkg'))
    con.execute('DELETE FROM polygon_centroids WHERE fid = (SELECT MIN(fid) '
                'FROM polygon_centroids)')
    con.commit()
    con.close()
    code, out = run_check()
    detail = [line for line in out.splitlines() if 'polygon_centroids' in line]
    check('a geopackage short of a row is caught',
          code == 1 and 'polygon_centroids holds 5' in out,
          detail[0].strip() if detail else '')

    os.remove(os.path.join(case, 'alerts_geometry.gpkg'))
    code, out = run_check()
    check('a missing geopackage is caught',
          code == 1 and 'alerts_geometry.gpkg does not exist' in out)


def main():
    parser = argparse.ArgumentParser(description='Offline tests for the geometry tools.')
    parser.add_argument('--keep', action='store_true', help='keep the temporary work directory')
    args = parser.parse_args()

    workdir = tempfile.mkdtemp(prefix='baron_selftest_')
    print(f'workdir {workdir}\n')
    try:
        build_zones_gpkg(os.path.join(workdir, 'zones.gpkg'))
        test_geometry()
        test_record_build()
        test_centroid_gpkg(workdir)
        test_geometry_gpkg(workdir)
        test_lookup(workdir)
        test_env_resolution(workdir)
        test_check_alerts(workdir)
    finally:
        if args.keep:
            print(f'\nkept {workdir}')
        else:
            shutil.rmtree(workdir, ignore_errors=True)

    print()
    if failures:
        print(f'{len(failures)} of {passed + len(failures)} checks FAILED: {failures}')
        return 1
    print(f'all {passed} checks passed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
