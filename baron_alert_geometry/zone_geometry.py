#!/usr/bin/env python3
"""
Retrieve zone geometry by zone id.

Reads zones.gpkg (built by baron_zones_fetch.py) and prints the geometry of one
or more zone ids. Falls back to the live zones/{id} endpoint for anything the
local copy does not hold.

Two behaviours are inherited from the dataset and matter here:

  * A zone id can back several distinct geometry rows. 227 ids do; FMC001 is six
    separate Micronesian islands under one code. Every row is returned as its own
    feature, none are merged.
  * Fire-weather zones are stored with an F code (WYF277) while the alert feed
    cites them with a Z code (WYZ277). Pass --fire to resolve the F-coded twin
    first. Without it, WYZ277 returns the unrelated FORECAST zone of the same
    number, because NWS reuses zone numbers between the two zone sets.

Usage
-----
    python3 zone_geometry.py ALC089                     # summary table
    python3 zone_geometry.py ALC089 PAC055 FMC001       # several ids
    python3 zone_geometry.py FMC001 --format geojson    # FeatureCollection
    python3 zone_geometry.py ALC089 --format wkt
    python3 zone_geometry.py WYZ277 --fire              # apply the Z -> F recode
    python3 zone_geometry.py ALC089 --format geojson --out zone.geojson
    python3 zone_geometry.py ALC089 --gpkg-out zone.gpkg
    python3 zone_geometry.py --stdin < ids.txt          # one id per line
    python3 zone_geometry.py ALC089 --source api        # skip the local copy

Exit codes: 0 every id resolved, 1 one or more ids did not resolve.
"""

import argparse
import json
import logging
import os
import sys

try:
    from osgeo import gdal, ogr, osr
    gdal.UseExceptions()
except ImportError:
    sys.exit('error: GDAL Python bindings required (python3 -c "from osgeo import ogr")')

from baron_alerts_report import (DEFAULT_GPKG, ZoneGeometryResolver, polygon_centroid)
from baron_zones_fetch import BaronClient, get_credentials

FORMATS = ('summary', 'geojson', 'wkt', 'json')
LAYER = 'zones'

logger = logging.getLogger('baron_alerts')     # the resolver logs under this name


def read_ids(args):
    """Collect zone ids from the command line and, with --stdin, from stdin."""
    ids = list(args.zone_ids)
    if args.stdin:
        ids.extend(line.strip() for line in sys.stdin if line.strip())
    seen = set()
    unique = []
    for zone_id in ids:
        upper = zone_id.strip().upper()
        if upper and upper not in seen:
            seen.add(upper)
            unique.append(upper)
    return unique


def build_resolver(args):
    """Open the resolver, creating an API client only when one is needed."""
    client = None
    if args.source in ('auto', 'api'):
        key, secret, base_url = get_credentials(args.env)
        client = BaronClient(key, secret, base_url)
    return ZoneGeometryResolver(client, args.gpkg, args.source,
                                args.precision, args.from_date)


def collect(resolver, zone_ids, fire):
    """Resolve every id. Returns (rows, missing) where rows are flat records."""
    rows = []
    missing = []
    for zone_id in zone_ids:
        found, resolved_id = resolver.resolve(zone_id, allow_fire_recode=fire)
        if not found:
            missing.append(zone_id)
            continue
        for index, row in enumerate(found):
            rows.append({
                'zone_id': zone_id,
                'resolved_zone_id': resolved_id,
                'row': index,
                'rows_for_id': len(found),
                'zone_type': row.get('zone_type'),
                'name': row.get('name'),
                'valid_begin': row.get('valid_begin'),
                'source': row.get('source'),
                'geometry': row.get('geometry'),
            })
    return rows, missing


def measure(row):
    """Attach centroid, bbox and part count. Reuses the report's centroid code."""
    measured = polygon_centroid(row['geometry']) or {}
    measured.pop('_area', None)
    return {**row, **measured}


def as_geojson(rows):
    features = []
    for row in rows:
        properties = {k: v for k, v in row.items() if k != 'geometry'}
        features.append({'type': 'Feature', 'properties': properties,
                         'geometry': row['geometry']})
    return {'type': 'FeatureCollection', 'features': features}


def as_wkt(rows):
    lines = []
    for row in rows:
        geometry = ogr.CreateGeometryFromJson(json.dumps(row['geometry']))
        label = row['resolved_zone_id']
        if row['rows_for_id'] > 1:
            label += f'[{row["row"]}]'
        lines.append(f'{label}\t{geometry.ExportToWkt()}')
    return '\n'.join(lines)


def as_summary(rows):
    lines = [f'{"zone_id":10} {"type":9} {"row":>3} {"parts":>5} '
             f'{"centroid lon,lat":>24}  name']
    for row in rows:
        centroid = row.get('centroid') or {}
        point = f'{centroid.get("lon", 0):.6f},{centroid.get("lat", 0):.6f}'
        label = row['resolved_zone_id']
        if label != row['zone_id']:
            label += '*'
        lines.append(f'{label:10} {str(row.get("zone_type") or "-"):9} '
                     f'{row["row"]:>3} {row.get("parts", 0):>5} {point:>24}  '
                     f'{row.get("name") or "-"}')
        if row.get('bbox'):
            lines.append(f'{"":10} bbox {row["bbox"]}'
                         + ('  crosses the antimeridian'
                            if row.get('crosses_antimeridian') else ''))
    if any(r['resolved_zone_id'] != r['zone_id'] for r in rows):
        lines.append('\n* recoded from the cited Z code to the F-coded FIRE zone')
    return '\n'.join(lines)


def write_gpkg(rows, path):
    """Write the resolved rows to a single-layer GeoPackage."""
    if os.path.exists(path):
        os.remove(path)
    dataset = ogr.GetDriverByName('GPKG').CreateDataSource(path)
    if dataset is None:
        sys.exit(f'error: could not create {path}')
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(4326)
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    layer = dataset.CreateLayer(LAYER, srs, ogr.wkbMultiPolygon, ['GEOMETRY_NAME=geom'])
    fields = (('zone_id', ogr.OFTString), ('resolved_zone_id', ogr.OFTString),
              ('zone_type', ogr.OFTString), ('name', ogr.OFTString),
              ('valid_begin', ogr.OFTString), ('source', ogr.OFTString),
              ('zone_row', ogr.OFTInteger), ('rows_for_id', ogr.OFTInteger),
              ('centroid_lon', ogr.OFTReal), ('centroid_lat', ogr.OFTReal))
    for name, field_type in fields:
        layer.CreateField(ogr.FieldDefn(name, field_type))

    written = 0
    for row in rows:
        geometry = ogr.CreateGeometryFromJson(json.dumps(row['geometry']))
        if geometry is None:
            continue
        feature = ogr.Feature(layer.GetLayerDefn())
        centroid = row.get('centroid') or {}
        values = {'zone_id': row['zone_id'], 'resolved_zone_id': row['resolved_zone_id'],
                  'zone_type': row.get('zone_type'), 'name': row.get('name'),
                  'valid_begin': row.get('valid_begin'), 'source': row.get('source'),
                  'zone_row': row['row'], 'rows_for_id': row['rows_for_id'],
                  'centroid_lon': centroid.get('lon'), 'centroid_lat': centroid.get('lat')}
        for name, value in values.items():
            if value is None:
                feature.SetFieldNull(name)
            else:
                feature.SetField(name, value)
        feature.SetGeometry(ogr.ForceToMultiPolygon(geometry))
        layer.CreateFeature(feature)
        feature = None
        written += 1
    layer = dataset = None
    return written


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description='Retrieve zone geometry by zone id from zones.gpkg or the API.')
    p.add_argument('zone_ids', nargs='*', help='one or more zone ids, e.g. ALC089')
    p.add_argument('--stdin', action='store_true', help='also read ids from stdin, one per line')
    p.add_argument('--gpkg', default=DEFAULT_GPKG,
                   help=f'zone geometry GeoPackage (default: {DEFAULT_GPKG})')
    p.add_argument('--source', default='auto', choices=('auto', 'gpkg', 'api'),
                   help='where geometry comes from (default: auto = GeoPackage, API fallback)')
    p.add_argument('--format', default='summary', choices=FORMATS,
                   help='summary table, geojson, wkt, or json without geometry (default: summary)')
    p.add_argument('--fire', action='store_true',
                   help='resolve a Z-coded fire-weather zone to its F-coded FIRE twin first')
    p.add_argument('--out', default=None, help='write the output to a file instead of stdout')
    p.add_argument('--gpkg-out', default=None,
                   help='also write the resolved rows to this GeoPackage')
    p.add_argument('--env', default='.env', help='path to .env with credentials')
    p.add_argument('--precision', type=int, default=6,
                   help='coordinate precision for API lookups, 4-9 (default: 6)')
    p.add_argument('--from', dest='from_date', default=None,
                   help='snapshot date for API lookups (default: the API default)')
    p.add_argument('--quiet', action='store_true', help='suppress the resolver warnings')
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if not args.quiet:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(logging.Formatter('%(levelname)s %(message)s'))
        logger.addHandler(handler)
    logger.setLevel(logging.ERROR if args.quiet else logging.WARNING)

    zone_ids = read_ids(args)
    if not zone_ids:
        sys.exit('error: no zone ids given; pass ids as arguments or use --stdin')

    resolver = build_resolver(args)
    rows, missing = collect(resolver, zone_ids, args.fire)
    rows = [measure(row) for row in rows]

    if args.format == 'geojson':
        text = json.dumps(as_geojson(rows), indent=2)
    elif args.format == 'wkt':
        text = as_wkt(rows)
    elif args.format == 'json':
        text = json.dumps([{k: v for k, v in r.items() if k != 'geometry'} for r in rows],
                          indent=2)
    else:
        text = as_summary(rows)

    if args.out:
        with open(args.out, 'w') as handle:
            handle.write(text + '\n')
        print(f'{len(rows)} row(s) -> {args.out}')
    else:
        print(text)

    if args.gpkg_out:
        written = write_gpkg(rows, args.gpkg_out)
        print(f'{written} feature(s) -> {args.gpkg_out}')

    if missing:
        print(f'\n{len(missing)} id(s) did not resolve: {", ".join(missing)}',
              file=sys.stderr)
        if not args.fire and any(len(m) == 6 and m[2] == 'Z' for m in missing):
            print('a Z-coded fire-weather zone needs --fire', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
