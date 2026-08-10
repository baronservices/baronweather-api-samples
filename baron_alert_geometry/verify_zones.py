#!/usr/bin/env python3
"""
Verify a baron_zones_fetch.py run: completeness against the API's own id listing,
then read-performance of the resulting GeoPackage.

Checks
------
  * every id in zones_ids.json is present in the GeoPackage
  * feature count matches the listed count (duplicate zone rows preserved)
  * no duplicate (zone_id, geometry) pairs, i.e. nothing double-written
  * indexes exist and id lookup is index-backed, not a table scan
  * timings for the four real access patterns

Usage: python3 verify_zones.py [out_dir]
"""

import collections
import json
import os
import sqlite3
import sys
import time

from osgeo import ogr, gdal

gdal.UseExceptions()

OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else 'zones_out'
GPKG = os.path.join(OUT_DIR, 'zones.gpkg')
IDS_JSON = os.path.join(OUT_DIR, 'zones_ids.json')
LAYER = 'zones'

failures = []


def check(label, ok, detail=''):
    print(f'  [{"PASS" if ok else "FAIL"}] {label}{" — " + detail if detail else ""}')
    if not ok:
        failures.append(label)


def timeit(fn, n=5):
    times = []
    for _ in range(n):
        t0 = time.perf_counter()
        fn()
        times.append(time.perf_counter() - t0)
    return min(times) * 1000


print(f'verifying {GPKG}\n')
if not os.path.exists(GPKG):
    sys.exit(f'error: {GPKG} not found')

with open(IDS_JSON) as fh:
    listed = json.load(fh)['zones']
listed_counts = {t: len(v) for t, v in listed.items()}
listed_total = sum(listed_counts.values())
listed_ids = {zid.upper() for ids in listed.values() for zid in ids}

con = sqlite3.connect(GPKG)

print('completeness')
total = con.execute(f'SELECT COUNT(*) FROM {LAYER}').fetchone()[0]
check('feature count matches ids listed by the API',
      total == listed_total, f'{total} features vs {listed_total} listed')

db_counts = dict(con.execute(f'SELECT type, COUNT(*) FROM {LAYER} GROUP BY type').fetchall())
for zone_type, want in sorted(listed_counts.items()):
    got = db_counts.get(zone_type, 0)
    check(f'{zone_type} count', got == want, f'{got} vs {want}')

db_ids = {r[0].upper() for r in con.execute(f'SELECT DISTINCT zone_id FROM {LAYER}')}
absent = listed_ids - db_ids
check('every listed zone id present', not absent,
      'all present' if not absent else f'{len(absent)} missing e.g. {sorted(absent)[:5]}')
extra = db_ids - listed_ids
check('no unlisted zone ids', not extra,
      'none' if not extra else f'{len(extra)} extra e.g. {sorted(extra)[:5]}')

print('\nduplicate zone rows preserved (not deduped, not double-written)')
multi = con.execute(
    f'SELECT zone_id, COUNT(*) c FROM {LAYER} GROUP BY zone_id HAVING c > 1').fetchall()
extra_rows = sum(c - 1 for _, c in multi)
check('multi-row ids retain every row', extra_rows == listed_total - len(listed_ids),
      f'{len(multi)} ids carry {extra_rows} extra rows; '
      f'listing implies {listed_total - len(listed_ids)}')

dup_geom = con.execute(f"""
    SELECT COUNT(*) FROM (
        SELECT zone_id, HEX(geom) g, COUNT(*) c
        FROM {LAYER} GROUP BY zone_id, g HAVING c > 1)
""").fetchone()[0]
check('no identical (zone_id, geometry) pairs', dup_geom == 0,
      f'{dup_geom} duplicated pairs' if dup_geom else 'every row is a distinct geometry')

null_geom = con.execute(f'SELECT COUNT(*) FROM {LAYER} WHERE geom IS NULL').fetchone()[0]
check('no null geometries', null_geom == 0, f'{null_geom} null')

print('\nindexes')
idx = {r[0] for r in con.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?", (LAYER,))}
check('zone_id index present', f'idx_{LAYER}_zone_id' in idx)
check('type index present', f'idx_{LAYER}_type' in idx)
check('spatial R-tree present',
      bool(con.execute("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'rtree_%'"
                       ).fetchone()[0]))
plan = con.execute(
    f'EXPLAIN QUERY PLAN SELECT * FROM {LAYER} WHERE zone_id = ?', ('ALC089',)).fetchall()
plan_text = ' '.join(str(r[-1]) for r in plan)
check('id lookup uses the index, not a scan', 'USING INDEX' in plan_text, plan_text.strip())

sample_id = con.execute(
    f'SELECT zone_id FROM {LAYER} LIMIT 1 OFFSET ?', (total // 2,)).fetchone()[0]
con.close()

print('\nread performance (min of 5, warm cache)')
ds = ogr.Open(GPKG)
lyr = ds.GetLayer(0)
lyr.SetAttributeFilter("type = 'COUNTY'")
probe = next(iter(lyr))
centroid = probe.GetGeometryRef().GetGeometryRef(0).Centroid()
lon, lat = centroid.GetX(), centroid.GetY()
del lyr, ds

BBOX = (-88.0, 34.0, -85.0, 36.0)


def full_scan():
    ds = ogr.Open(GPKG)
    lyr = ds.GetLayer(0)
    return sum(1 for f in lyr if f.GetGeometryRef() is not None)


def bbox():
    ds = ogr.Open(GPKG)
    lyr = ds.GetLayer(0)
    lyr.SetSpatialFilterRect(*BBOX)
    return sum(1 for _ in lyr)


def by_id():
    ds = ogr.Open(GPKG)
    lyr = ds.GetLayer(0)
    lyr.SetAttributeFilter(f"zone_id = '{sample_id}'")
    return sum(1 for _ in lyr)


def point_in_polygon():
    ds = ogr.Open(GPKG)
    lyr = ds.GetLayer(0)
    pt = ogr.CreateGeometryFromWkt(f'POINT({lon} {lat})')
    lyr.SetSpatialFilter(pt)
    return [f.GetField('zone_id') for f in lyr if f.GetGeometryRef().Contains(pt)]


print(f'  full scan ({total} features)      {timeit(full_scan, 3):8.1f} ms')
print(f'  bbox query ({bbox()} hits)          {timeit(bbox):8.2f} ms')
print(f'  lookup by zone_id ({sample_id})   {timeit(by_id):8.2f} ms')
hits = point_in_polygon()
print(f'  point-in-polygon -> {len(hits)} zones     {timeit(point_in_polygon):8.2f} ms  {hits[:5]}')

print(f'\n  on disk: {os.path.getsize(GPKG)/1048576:.1f} MB')
fgb = os.path.join(OUT_DIR, 'zones.fgb')
if os.path.exists(fgb):
    print(f'  flatgeobuf: {os.path.getsize(fgb)/1048576:.1f} MB')

print()
if failures:
    print(f'{len(failures)} CHECK(S) FAILED: {failures}')
    sys.exit(1)
print('all checks passed')
