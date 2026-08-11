#!/usr/bin/env python3
"""
Run the alert report, then check it for errors. Made for cron.

The script does four things:
  1. It runs baron_alerts_report.py.
  2. It checks alerts_report.json for problems.
  3. It checks that the two GeoPackages hold the same row counts the JSON reports.
     A silent disagreement between them is worse than a missing file, because
     the map and the report then show different things.
  4. It prints one line for each problem, with the tag ERROR or WARN.

Exit codes:
  0  No problem found.
  1  A problem was found. Read the ERROR and WARN lines.
  2  The report did not run, or the JSON is not readable.

Every line starts with a UTC timestamp. Cron output goes to the log file.

Usage:
    python3 check_alerts.py                     # run the report, then check it
    python3 check_alerts.py --check-only        # check the present JSON only
    python3 check_alerts.py --quiet             # print only problems and the verdict

Cron, every 3 hours:
    0 */3 * * * cd /Users/sherman/tmp/1/2 && /usr/bin/python3 check_alerts.py >> alert_monitor.log 2>&1
"""

import argparse
import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone

REPORT = 'alerts_report.json'
SCRIPT = 'baron_alerts_report.py'
ZONES_GPKG = os.path.join('zones_out', 'zones.gpkg')

# The GeoPackages the report writes beside the JSON. A GeoPackage is a SQLite
# file, so the row counts are read with sqlite3 and this script needs no GDAL.
CENTROIDS_GPKG = 'alerts_centroids.gpkg'
GEOMETRY_GPKG = 'alerts_geometry.gpkg'

# An alert count below this value is unusual. The feed normally holds 100 or more.
MIN_EXPECTED_ALERTS = 5
# A run that is much slower than normal points to a problem at the API.
MAX_EXPECTED_SECONDS = 180

problems = []


def stamp():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def say(message):
    print(f'{stamp()} {message}', flush=True)


def problem(level, message):
    """Record a problem and print it. level is ERROR or WARN."""
    problems.append((level, message))
    say(f'{level} {message}')


def run_report(python_exe):
    """Run the alert report. Return True if it succeeded."""
    say(f'INFO running {SCRIPT}')
    try:
        proc = subprocess.run([python_exe, SCRIPT], capture_output=True, text=True,
                              timeout=900)
    except subprocess.TimeoutExpired:
        problem('ERROR', f'{SCRIPT} did not finish in 900 s')
        return False
    except OSError as exc:
        problem('ERROR', f'{SCRIPT} could not start: {exc}')
        return False

    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or '').strip().splitlines()[-3:]
        problem('ERROR', f'{SCRIPT} exited {proc.returncode}: {" | ".join(tail)}')
        return False

    say('INFO report finished')
    return True


def check_report():
    """Check alerts_report.json. Return the meta counts, or None if unreadable."""
    if not os.path.exists(REPORT):
        problem('ERROR', f'{REPORT} does not exist')
        return None

    age_hours = (datetime.now(timezone.utc).timestamp() - os.path.getmtime(REPORT)) / 3600
    if age_hours > 4:
        problem('WARN', f'{REPORT} is {age_hours:.1f} h old; the run may have failed')

    try:
        with open(REPORT) as handle:
            data = json.load(handle)
    except (json.JSONDecodeError, OSError) as exc:
        problem('ERROR', f'{REPORT} is not readable: {exc}')
        return None

    meta = data.get('meta') or {}
    counts = meta.get('counts') or {}
    alerts = data.get('alerts')
    if alerts is None:
        problem('ERROR', f'{REPORT} has no "alerts" array')
        return None

    # --- counts reported by the script itself ---
    if counts.get('unresolved_zone_references', 0) > 0:
        problem('ERROR', f'{counts["unresolved_zone_references"]} zone references did '
                         f'not resolve to geometry')
    if counts.get('alerts_without_centroid', 0) > 0:
        problem('ERROR', f'{counts["alerts_without_centroid"]} alerts have no centroid')

    # --- independent check of the alert records ---
    no_polygon = [a for a in alerts if a.get('polygon_count', 0) == 0]
    no_centroid = [a for a in alerts if not a.get('centroid')]
    bad_centroid = []
    missing_zone = []
    for alert in alerts:
        for polygon in alert.get('polygons') or []:
            centre = polygon.get('centroid')
            if not centre:
                bad_centroid.append(polygon.get('zone_id'))
                continue
            if not (-180 <= centre['lon'] <= 180 and -90 <= centre['lat'] <= 90):
                bad_centroid.append(polygon.get('zone_id'))
        present = {p.get('zone_id') for p in alert.get('polygons') or []}
        for zone in alert.get('zones') or []:
            if zone not in present:
                missing_zone.append(zone)

    if no_polygon:
        problem('ERROR', f'{len(no_polygon)} alerts mapped to no polygon')
    if no_centroid:
        problem('ERROR', f'{len(no_centroid)} alerts have no alert-level centroid')
    if bad_centroid:
        problem('ERROR', f'{len(bad_centroid)} polygons have a missing or invalid '
                         f'centroid, for example {bad_centroid[:3]}')
    if missing_zone:
        problem('ERROR', f'{len(missing_zone)} cited zones are absent from the '
                         f'polygons, for example {missing_zone[:3]}')

    # --- conditions that point to a problem at the API ---
    if len(alerts) < MIN_EXPECTED_ALERTS:
        problem('WARN', f'only {len(alerts)} alerts; the feed normally holds 100 or more')
    seconds = counts.get('seconds') or 0
    if seconds > MAX_EXPECTED_SECONDS:
        problem('WARN', f'the run took {seconds:.0f} s; normal is under 15 s')

    pages = (meta.get('source') or {}).get('pages_reported_per_request') or []
    if len(set(pages)) > 1:
        problem('WARN', f'the page count changed during the walk: {pages}')

    return {'counts': counts, 'meta': meta, 'alerts': len(alerts), 'data': data}


def table_count(path, table):
    """Row count of one GeoPackage table, or None if it cannot be read."""
    try:
        con = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    except sqlite3.Error:
        return None
    try:
        return con.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
    except sqlite3.Error:
        return None
    finally:
        con.close()


def check_geopackages(data):
    """Check the two GeoPackages against the counts the JSON reports.

    A count that disagrees means the JSON and the map layers describe different
    things, which is worse than a missing file because it is not visible.
    """
    meta = data.get('meta') or {}
    counts = meta.get('counts') or {}
    outputs = meta.get('outputs') or {}
    if not outputs:
        problem('WARN', 'the report wrote no "outputs" block; it may be an old version')
        return
    if outputs.get('centroids_geopackage') is None:
        say('INFO the report ran with --no-gpkg; skipping the geopackage checks')
        return

    alerts = data.get('alerts') or []
    want_polygons = sum(1 for a in alerts for p in a.get('polygons') or [] if p.get('centroid'))
    want_alerts = sum(1 for a in alerts if a.get('centroid'))

    for name, table, want in (
            (CENTROIDS_GPKG, 'polygon_centroids', want_polygons),
            (CENTROIDS_GPKG, 'alert_centroids', want_alerts),
            (GEOMETRY_GPKG, 'alert_polygons', counts.get('polygons', 0))):
        path = os.path.join(os.path.dirname(os.path.abspath(REPORT)), name)
        if not os.path.exists(path):
            problem('ERROR', f'{name} does not exist')
            continue
        got = table_count(path, table)
        if got is None:
            problem('ERROR', f'{name} has no readable "{table}" layer')
        elif got != want:
            problem('ERROR', f'{name} layer {table} holds {got} rows but the JSON '
                             f'implies {want}')
        elif got == 0:
            problem('WARN', f'{name} layer {table} is empty')


def check_zone_versions(python_exe):
    """Warn if the zone shapefiles are newer than the local copy."""
    if not os.path.exists(ZONES_GPKG):
        problem('ERROR', f'{ZONES_GPKG} does not exist; run baron_zones_fetch.py')
        return
    try:
        proc = subprocess.run([python_exe, 'baron_zones_fetch.py', '--check-versions'],
                              capture_output=True, text=True, timeout=120)
    except (subprocess.TimeoutExpired, OSError) as exc:
        problem('WARN', f'the zone version check did not run: {exc}')
        return
    if proc.returncode != 0:
        stale = [line for line in proc.stdout.splitlines() if line.startswith('stale types')]
        problem('WARN', f'the zone geometry is stale. {stale[0] if stale else ""} '
                        f'Run ./refresh_zones.sh')


def main(argv=None):
    parser = argparse.ArgumentParser(description='Run the alert report and check it.')
    parser.add_argument('--check-only', action='store_true',
                        help='check the present JSON; do not run the report')
    parser.add_argument('--quiet', action='store_true',
                        help='print only problems and the verdict')
    parser.add_argument('--python', default=sys.executable,
                        help='the python to use for the sub-processes')
    args = parser.parse_args(argv)

    global say
    if args.quiet:
        say = lambda message: None                          # noqa: E731

    print(f'{stamp()} ===== alert check start =====', flush=True)

    if not args.check_only:
        if not run_report(args.python):
            print(f'{stamp()} VERDICT FAIL the report did not run', flush=True)
            return 2

    result = check_report()
    if result is None:
        print(f'{stamp()} VERDICT FAIL the report is not readable', flush=True)
        return 2

    check_geopackages(result['data'])

    if not args.check_only:
        check_zone_versions(args.python)

    counts = result['counts']
    summary = (f'{result["alerts"]} alerts, {counts.get("polygons", 0)} polygons, '
               f'{counts.get("polygons_from_recoded_fire_zones", 0)} recoded fire zones, '
               f'{counts.get("seconds", 0):.0f} s')

    errors = sum(1 for level, _ in problems if level == 'ERROR')
    warnings = sum(1 for level, _ in problems if level == 'WARN')

    if errors:
        print(f'{stamp()} VERDICT FAIL {errors} error(s), {warnings} warning(s). '
              f'{summary}', flush=True)
        return 1
    if warnings:
        print(f'{stamp()} VERDICT WARN {warnings} warning(s). {summary}', flush=True)
        return 1
    print(f'{stamp()} VERDICT OK {summary}', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
