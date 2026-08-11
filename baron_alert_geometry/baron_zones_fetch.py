#!/usr/bin/env python3
"""
Baron Velocity Weather API - alert zone geometry fetcher.

Retrieves the complete NWS zone geometry set (FIRE, COUNTY, COASTAL, FORECAST,
OFFSHORE) from the Velocity Weather alert report server and stores it in a
spatially- and attribute-indexed GeoPackage.

Pipeline
--------
    1. GET zones/versions   -> shapefile version date per zone type (provenance)
    2. GET zones/ids        -> zone id list per zone type
    3. GET zones/{id}       -> one GeoJSON Feature (or FeatureCollection) per id
       written streaming to per-type NDJSON staging files (append-only, resumable)
    4. ogr2ogr              -> single GeoPackage table `zones`, indexed on zone_id
       and type; optional FlatGeobuf copy for bbox/tile-serving workloads

Authentication
--------------
HMAC-SHA1 over the string "{access_key}:{unix_timestamp}", base64 url-safe
encoded, passed as the `sig` query parameter alongside `ts`.

Endpoint notes (verified against report_server/handlers/alert_handler.py)
------------------------------------------------------------------------
  * `precision` is documented as 3-9 but the API rejects 3 with HTTP 400.
    Effective range is 4-9; 6 (~10 cm) is the default and the practical choice
    since lower precision saves little (measured: p4 is only ~15% smaller).
  * zones/ids lists 11,891 entries of which 11,651 are distinct. 227 ids have
    2-6 rows within a single shapefile version. Those ids return a
    *FeatureCollection* rather than a *Feature*, and every feature in it is a
    real distinct geometry row. This script unwraps those collections and writes
    every feature, so the output feature count matches the listed count. It does
    not repeat identical HTTP requests for a repeated id, because the response
    already carries all rows for that id.
  * HIGHSEA zones are excluded server-side and never appear.
  * The `from` date is resolved once per run and sent on every request so the
    whole dataset is a single consistent snapshot.

Structured log tags: ZONE_OK, ZONE_FAILED, ZONE_NOTFOUND, TYPE_ROLLUP, RUN_TOTAL

Usage
-----
    python3 baron_zones_fetch.py                        # full fetch + GeoPackage
    python3 baron_zones_fetch.py --limit 25             # smoke test, 25 per type
    python3 baron_zones_fetch.py --types COASTAL,OFFSHORE
    python3 baron_zones_fetch.py --resume               # continue an interrupted run
    python3 baron_zones_fetch.py --fgb                  # also emit FlatGeobuf
    python3 baron_zones_fetch.py --check-versions       # is the local copy stale?
"""

import argparse
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import quote, urlencode

ZONE_TYPES = ('FIRE', 'COUNTY', 'COASTAL', 'FORECAST', 'OFFSHORE')
ZONE_ID_RE = re.compile(r'^[A-Z]{2}[CFZ]\d{3}$', re.IGNORECASE)

DEFAULT_WORKERS = 12
DEFAULT_PRECISION = 6
MAX_RETRIES = 4
RETRY_BASE_DELAY = 2.0
REQUEST_TIMEOUT = 90
USER_AGENT = 'baron_zones_fetch/1.0'

LOG_FILE = 'baron_zones_fetch.log'
logger = logging.getLogger('baron_zones')


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

def load_env(path='.env'):
    """Parse a KEY=VALUE .env file into a dict, ignoring comments and blanks."""
    env = {}
    if not os.path.exists(path):
        return env
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, val = line.partition('=')
            env[key.strip()] = val.strip().strip('"').strip("'")
    return env


def resolve_env_path(env_path):
    """Find the .env file to read. Returns (path, list of paths tried).

    A bare default like `.env` resolves against the current working directory, so
    running a script from anywhere but its own folder finds nothing even when the
    .env sits right beside it. The working directory is still searched first, so a
    per-project .env keeps winning; the script's own folder is the fallback.

    An explicit --env path is used exactly as given and never falls back.
    """
    tried = [os.path.abspath(env_path)]
    if os.path.exists(env_path):
        return env_path, tried
    if os.path.isabs(env_path) or os.path.dirname(env_path):
        return env_path, tried            # the caller named a place; do not guess
    beside_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), env_path)
    tried.append(beside_script)
    if os.path.exists(beside_script):
        return beside_script, tried
    return env_path, tried


def get_credentials(env_path):
    """Resolve API credentials from the .env file.

    The file is the only source. Environment variables are deliberately not read:
    one visible file is easier to audit than a value that could come from a shell,
    a container, or a cron environment, and a stale exported key silently taking
    precedence over the file is a confusing failure to diagnose.
    """
    resolved, tried = resolve_env_path(env_path)
    env = load_env(resolved)
    key = env.get('BARON_API_KEY')
    secret = env.get('BARON_API_SECRET')
    base = env.get('BARON_API_BASE_URL') or 'https://api.velocityweather.com'
    if not key or not secret:
        sys.exit('error: BARON_API_KEY / BARON_API_SECRET not found in:\n  '
                 + '\n  '.join(tried)
                 + '\ncredentials are read from the .env file only, not the environment')
    return key, secret, base.rstrip('/')


# --------------------------------------------------------------------------- #
# HTTP / auth
# --------------------------------------------------------------------------- #

class BaronClient:
    """Signed HTTP client for the Velocity Weather alert report server.

    Signatures are bound to a whole-second timestamp, so they are computed once
    per second and shared across worker threads rather than recomputed per
    request.
    """

    def __init__(self, key, secret, base_url):
        self.key = key
        self.secret = secret
        self.base_url = base_url
        self._lock = threading.Lock()
        self._cached_ts = None
        self._cached_sig = None
        self.bytes_downloaded = 0
        self.requests_made = 0

    def _auth_params(self):
        ts = str(int(time.time()))
        with self._lock:
            if ts != self._cached_ts:
                digest = hmac.new(self.secret.encode('utf-8'),
                                  f'{self.key}:{ts}'.encode('utf-8'),
                                  hashlib.sha1).digest()
                self._cached_ts = ts
                self._cached_sig = base64.urlsafe_b64encode(digest).decode('utf-8')
            return self._cached_ts, self._cached_sig

    def build_url(self, path, params=None):
        """Build a fully signed URL for an alert-server path."""
        ts, sig = self._auth_params()
        query = dict(params or {})
        query['ts'] = ts
        query['sig'] = sig
        return f'{self.base_url}/v1/{self.key}/reports/alert/{path}?{urlencode(query)}'

    def get(self, path, params=None, retries=MAX_RETRIES):
        """GET a path with retry/backoff.

        Returns the raw response body. Raises NotFound on HTTP 404 (an invalid or
        unknown zone identifier) and FetchError once retries are exhausted.
        """
        last_error = None
        for attempt in range(retries):
            url = self.build_url(path, params)
            try:
                req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
                with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                    body = resp.read()
                with self._lock:
                    self.bytes_downloaded += len(body)
                    self.requests_made += 1
                return body
            except urllib.error.HTTPError as exc:
                # 404 is a definitive answer; 400 means we sent something invalid.
                if exc.code == 404:
                    raise NotFound(f'HTTP 404 for {path}') from exc
                if exc.code == 400:
                    raise FetchError(f'HTTP 400 for {path}: {exc.read()[:200]!r}') from exc
                last_error = f'HTTP {exc.code}'
            except Exception as exc:                     # timeouts, resets, DNS
                last_error = f'{type(exc).__name__}: {exc}'
            if attempt < retries - 1:
                time.sleep(RETRY_BASE_DELAY * (2 ** attempt))
        raise FetchError(f'{path} failed after {retries} attempts: {last_error}')

    def get_json(self, path, params=None):
        return json.loads(self.get(path, params))


class FetchError(Exception):
    """A request failed after exhausting retries."""


class NotFound(Exception):
    """The API reported the resource does not exist."""


# --------------------------------------------------------------------------- #
# Staging file helpers
# --------------------------------------------------------------------------- #

def backup_file(path):
    """Copy a file to backup/<name>.<utc timestamp>.backup before it is replaced."""
    if not os.path.exists(path):
        return None
    directory = os.path.dirname(os.path.abspath(path))
    backup_dir = os.path.join(directory, 'backup')
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y_%m_%dT%H%M%SZ')
    dest = os.path.join(backup_dir, f'{os.path.basename(path)}.{stamp}.backup')
    shutil.copy2(path, dest)
    logger.info(f'BACKUP {path} -> {dest}')
    return dest


def load_staged_ids(path):
    """Return the set of zone ids already staged in an NDJSON file.

    A run killed mid-write can leave a truncated final line. Any trailing
    unparseable content is dropped and the file rewritten so appends stay valid.
    """
    if not os.path.exists(path):
        return set()
    ids = set()
    good_bytes = 0
    truncated = False
    with open(path, 'rb') as fh:
        for raw in fh:
            if not raw.endswith(b'\n'):
                truncated = True
                break
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                truncated = True
                break
            feats = [obj] if obj.get('type') == 'Feature' else obj.get('features', [])
            for feat in feats:
                zid = (feat.get('properties') or {}).get('zone_id')
                if zid:
                    ids.add(zid.upper())
            good_bytes += len(raw)
    if truncated:
        logger.warning(f'RESUME_TRUNCATE {path} had an incomplete trailing record; '
                       f'truncating to {good_bytes} bytes')
        with open(path, 'r+b') as fh:
            fh.truncate(good_bytes)
    return ids


# --------------------------------------------------------------------------- #
# Fetch
# --------------------------------------------------------------------------- #

def fetch_zone_type(client, zone_type, zone_ids, out_path, precision, from_date,
                    workers, resume, progress_every):
    """Fetch every zone id for one zone type into an NDJSON staging file.

    Each response is written verbatim as one line. FeatureCollection responses
    (ids backed by multiple shapefile rows) are unwrapped so every line holds
    exactly one Feature and no geometry row is lost.

    Returns a stats dict for the type.
    """
    already = load_staged_ids(out_path) if resume else set()
    if not resume:
        # The file is opened in append mode below, so a fresh (non-resume) fetch has
        # to clear it first or a re-fetch of an already-staged type doubles every
        # record instead of replacing it.
        backup_file(out_path)
        if os.path.exists(out_path):
            os.remove(out_path)
            logger.info(f'STAGING_CLEARED {out_path} (fresh fetch, not --resume)')

    # One request per distinct id: a repeated id returns all of its rows in a
    # single FeatureCollection, so requesting it again would only duplicate them.
    seen = set()
    todo = []
    for zid in zone_ids:
        upper = zid.upper()
        if upper in seen:
            continue
        seen.add(upper)
        if upper in already:
            continue
        todo.append(upper)

    duplicate_ids = len(zone_ids) - len(seen)
    stats = {
        'listed': len(zone_ids),
        'distinct_ids': len(seen),
        'duplicate_listings': duplicate_ids,
        'skipped_resume': len(seen) - len(todo) if resume else 0,
        'requested': len(todo),
        'features_written': 0,
        'collections': 0,
        'notfound': 0,
        'failed': [],
        'bytes': 0,
    }

    logger.info(f'TYPE_START {zone_type} listed={stats["listed"]} '
                f'distinct={stats["distinct_ids"]} repeated_ids={duplicate_ids} '
                f'to_fetch={len(todo)}'
                + (f' resumed={stats["skipped_resume"]}' if resume else ''))

    if not todo:
        return stats

    def fetch_one(zid):
        params = {'precision': precision, 'from': from_date}
        try:
            body = client.get(f'zones/{quote(zid)}', params)
            return zid, body, None
        except NotFound as exc:
            return zid, None, ('notfound', str(exc))
        except FetchError as exc:
            return zid, None, ('failed', str(exc))

    started = time.time()
    done = 0
    with open(out_path, 'a', encoding='utf-8') as out, ThreadPoolExecutor(workers) as pool:
        for zid, body, err in pool.map(fetch_one, todo):
            done += 1
            if err:
                kind, message = err
                if kind == 'notfound':
                    stats['notfound'] += 1
                    logger.warning(f'ZONE_NOTFOUND {zone_type} {zid} {message}')
                else:
                    stats['failed'].append(zid)
                    logger.error(f'ZONE_FAILED {zone_type} {zid} {message}')
                continue

            stats['bytes'] += len(body)
            obj = json.loads(body)
            if obj.get('type') == 'FeatureCollection':
                features = obj.get('features', [])
                stats['collections'] += 1
                logger.info(f'ZONE_OK {zone_type} {zid} bytes={len(body)} '
                            f'features={len(features)} multi_row=1')
            else:
                features = [obj]
                logger.debug(f'ZONE_OK {zone_type} {zid} bytes={len(body)} features=1')

            for feat in features:
                out.write(json.dumps(feat, separators=(',', ':')) + '\n')
                stats['features_written'] += 1

            if done % 200 == 0:
                out.flush()
            if progress_every and done % progress_every == 0:
                rate = done / max(time.time() - started, 0.001)
                remaining = (len(todo) - done) / rate if rate else 0
                print(f'  {zone_type}: {done}/{len(todo)} '
                      f'({rate:.1f}/s, ~{remaining/60:.1f} min left, '
                      f'{stats["bytes"]/1048576:.0f} MB)', flush=True)

    elapsed = time.time() - started
    logger.info(f'TYPE_ROLLUP {zone_type} requested={stats["requested"]} '
                f'features={stats["features_written"]} collections={stats["collections"]} '
                f'notfound={stats["notfound"]} failed={len(stats["failed"])} '
                f'bytes={stats["bytes"]} mb={stats["bytes"]/1048576:.1f} '
                f'seconds={elapsed:.1f}')
    stats['seconds'] = round(elapsed, 1)
    return stats


# --------------------------------------------------------------------------- #
# Conversion
# --------------------------------------------------------------------------- #

def have_ogr2ogr():
    return shutil.which('ogr2ogr') is not None


def run_ogr(args):
    """Run an ogr2ogr command, raising with its stderr on failure."""
    proc = subprocess.run(['ogr2ogr'] + args, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f'ogr2ogr failed: {" ".join(args)}\n{proc.stderr.strip()}')
    if proc.stderr.strip():
        logger.warning(f'OGR_WARN {proc.stderr.strip()[:500]}')


def build_geopackage(ndjson_paths, gpkg_path, layer='zones'):
    """Convert the NDJSON staging files into one indexed GeoPackage table.

    `-nlt MULTIPOLYGON` is required: without it the layer geometry type is taken
    from the first feature and mismatched features are silently dropped.
    """
    backup_file(gpkg_path)
    if os.path.exists(gpkg_path):
        os.remove(gpkg_path)

    for i, path in enumerate(ndjson_paths):
        base = ['-f', 'GPKG', gpkg_path, path, '-nln', layer,
                '-nlt', 'MULTIPOLYGON', '-lco', 'GEOMETRY_NAME=geom']
        run_ogr(base if i == 0 else ['-update', '-append', gpkg_path, path,
                                     '-nln', layer, '-nlt', 'MULTIPOLYGON'])
        logger.info(f'GPKG_APPEND {os.path.basename(path)}')

    # A B-tree index on zone_id is what makes id lookups constant-time; without
    # it GDAL falls back to a full table scan (measured 28.6 ms vs 1.7 ms).
    con = sqlite3.connect(gpkg_path)
    try:
        con.execute(f'CREATE INDEX IF NOT EXISTS idx_{layer}_zone_id ON {layer}(zone_id)')
        con.execute(f'CREATE INDEX IF NOT EXISTS idx_{layer}_type ON {layer}(type)')
        con.commit()
        count = con.execute(f'SELECT COUNT(*) FROM {layer}').fetchone()[0]
    finally:
        con.close()
    logger.info(f'GPKG_DONE {gpkg_path} features={count} '
                f'bytes={os.path.getsize(gpkg_path)}')
    return count


def build_flatgeobuf(gpkg_path, fgb_path, layer='zones'):
    """Derive a FlatGeobuf copy from the GeoPackage (faster bbox/tile reads)."""
    backup_file(fgb_path)
    if os.path.exists(fgb_path):
        os.remove(fgb_path)
    run_ogr(['-f', 'FlatGeobuf', fgb_path, gpkg_path, layer, '-nlt', 'MULTIPOLYGON'])
    logger.info(f'FGB_DONE {fgb_path} bytes={os.path.getsize(fgb_path)}')


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def setup_logging(out_dir, verbose):
    log_path = os.path.join(out_dir, LOG_FILE)
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


def precision_arg(value):
    ivalue = int(value)
    if not 4 <= ivalue <= 9:
        raise argparse.ArgumentTypeError(
            'precision must be 4-9 (the API rejects 3 despite documenting it)')
    return ivalue


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description='Fetch all Baron Velocity Weather alert zone geometry.',
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--out-dir', default='zones_out', help='output directory (default: zones_out)')
    p.add_argument('--env', default='.env', help='path to .env with credentials (default: .env)')
    p.add_argument('--types', default=','.join(ZONE_TYPES),
                   help='comma-separated zone types (default: all)')
    p.add_argument('--precision', type=precision_arg, default=DEFAULT_PRECISION,
                   help=f'coordinate decimal places, 4-9 (default: {DEFAULT_PRECISION})')
    p.add_argument('--from', dest='from_date', default=None,
                   help='snapshot date YYYY-MM-DD (default: today UTC)')
    p.add_argument('--workers', type=int, default=DEFAULT_WORKERS,
                   help=f'concurrent requests (default: {DEFAULT_WORKERS})')
    p.add_argument('--limit', type=int, default=None,
                   help='fetch at most N zones per type (smoke test)')
    p.add_argument('--resume', action='store_true',
                   help='skip zone ids already present in the staging files')
    p.add_argument('--no-gpkg', action='store_true', help='stage NDJSON only, skip GeoPackage')
    p.add_argument('--fgb', action='store_true', help='also emit a FlatGeobuf copy')
    p.add_argument('--keep-ndjson', action='store_true',
                   help='keep NDJSON staging files after conversion (default: keep)')
    p.add_argument('--check-versions', action='store_true',
                   help='compare live shapefile versions against the local manifest and exit')
    p.add_argument('--progress-every', type=int, default=250,
                   help='progress line every N zones, 0 to disable (default: 250)')
    p.add_argument('--verbose', action='store_true', help='debug-level logging to the log file')
    return p.parse_args(argv)


def check_versions(client, out_dir, from_date):
    """Print live vs. local shapefile versions. Exit 1 if any type is stale."""
    live = client.get_json('zones/versions', {'from': from_date}).get('zones', {})
    manifest_path = os.path.join(out_dir, 'manifest.json')
    local = {}
    if os.path.exists(manifest_path):
        with open(manifest_path) as fh:
            local = (json.load(fh).get('versions') or {})
    else:
        print(f'no local manifest at {manifest_path}; treating all types as stale')

    stale = []
    print(f'{"type":10} {"local":12} {"live":12} status')
    for zone_type in sorted(live):
        have = local.get(zone_type, '-')
        want = live[zone_type]
        ok = have == want
        if not ok:
            stale.append(zone_type)
        print(f'{zone_type:10} {have:12} {want:12} {"current" if ok else "STALE"}')
    if stale:
        print(f'\nstale types: {",".join(stale)}')
        print(f'refetch with: --types {",".join(stale)}')
        return 1
    print('\nlocal copy is current')
    return 0


def main(argv=None):
    args = parse_args(argv)
    os.makedirs(args.out_dir, exist_ok=True)
    log_path = setup_logging(args.out_dir, args.verbose)

    key, secret, base_url = get_credentials(args.env)
    client = BaronClient(key, secret, base_url)

    # Pin the snapshot date once so every request sees the same shapefile version.
    from_date = args.from_date or datetime.now(timezone.utc).strftime('%Y-%m-%d')

    if args.check_versions:
        return check_versions(client, args.out_dir, from_date)

    requested_types = [t.strip().upper() for t in args.types.split(',') if t.strip()]
    unknown = [t for t in requested_types if t not in ZONE_TYPES]
    if unknown:
        sys.exit(f'error: unknown zone type(s) {unknown}; valid: {", ".join(ZONE_TYPES)}')

    run_started = time.time()
    logger.info(f'RUN_START from={from_date} precision={args.precision} '
                f'types={",".join(requested_types)} workers={args.workers} '
                f'resume={args.resume} limit={args.limit}')
    print(f'Baron alert zone fetch  from={from_date} precision={args.precision} '
          f'workers={args.workers}')
    print(f'log: {log_path}')

    versions = client.get_json('zones/versions', {'from': from_date}).get('zones', {})
    logger.info(f'VERSIONS {json.dumps(versions, sort_keys=True)}')
    print('shapefile versions: '
          + ', '.join(f'{k}={v}' for k, v in sorted(versions.items())))

    all_ids = client.get_json('zones/ids', {'from': from_date}).get('zones', {})
    for zone_type, ids in sorted(all_ids.items()):
        logger.info(f'IDS {zone_type} listed={len(ids)} distinct={len(set(ids))}')

    missing = [t for t in requested_types if t not in all_ids]
    if missing:
        logger.warning(f'TYPE_ABSENT {missing} not present in zones/ids response')
        print(f'warning: {missing} not returned by zones/ids; skipping')
    work_types = [t for t in requested_types if t in all_ids]

    with open(os.path.join(args.out_dir, 'zones_ids.json'), 'w') as fh:
        json.dump({'from': from_date, 'zones': all_ids}, fh, indent=2)
    with open(os.path.join(args.out_dir, 'zones_versions.json'), 'w') as fh:
        json.dump({'from': from_date, 'zones': versions}, fh, indent=2)

    per_type = {}
    for zone_type in work_types:
        ids = all_ids[zone_type]
        if args.limit:
            ids = ids[:args.limit]
        path = os.path.join(args.out_dir, f'zones_{zone_type}.geojsonl')
        print(f'\n{zone_type}: {len(ids)} listed')
        per_type[zone_type] = fetch_zone_type(
            client, zone_type, ids, path, args.precision, from_date,
            args.workers, args.resume, args.progress_every)

    # Rebuild from every staging file in the output directory, not just the types
    # fetched this run. A `--types FIRE` refresh must not drop the other four
    # types from the GeoPackage.
    ndjson_paths = []
    for zone_type in ZONE_TYPES:
        path = os.path.join(args.out_dir, f'zones_{zone_type}.geojsonl')
        if os.path.exists(path) and os.path.getsize(path) > 0:
            ndjson_paths.append(path)
    carried = [os.path.basename(p) for p in ndjson_paths
               if not any(f'zones_{t}.geojsonl' == os.path.basename(p) for t in work_types)]
    if carried:
        logger.info(f'GPKG_CARRY_FORWARD including staging files not fetched this run: '
                    f'{", ".join(carried)}')
        print(f'\ncarrying forward {len(carried)} staged type(s) not fetched this run: '
              f'{", ".join(c.replace("zones_", "").replace(".geojsonl", "") for c in carried)}')

    total_features = sum(s['features_written'] for s in per_type.values())
    total_listed = sum(s['listed'] for s in per_type.values())
    total_requested = sum(s['requested'] for s in per_type.values())
    total_failed = sum(len(s['failed']) for s in per_type.values())
    elapsed = time.time() - run_started

    logger.info(f'RUN_TOTAL requests={client.requests_made} '
                f'bytes={client.bytes_downloaded} '
                f'mb={client.bytes_downloaded/1048576:.1f} '
                f'features={total_features} listed={total_listed} '
                f'failed={total_failed} seconds={elapsed:.1f}')

    print('\n' + '-' * 68)
    print(f'{"type":10} {"listed":>8} {"fetched":>8} {"features":>9} {"multi":>6} '
          f'{"fail":>5} {"MB":>7}')
    for zone_type, s in per_type.items():
        print(f'{zone_type:10} {s["listed"]:>8} {s["requested"]:>8} '
              f'{s["features_written"]:>9} {s["collections"]:>6} '
              f'{len(s["failed"]):>5} {s["bytes"]/1048576:>7.1f}')
    print('-' * 68)
    print(f'{"TOTAL":10} {total_listed:>8} {total_requested:>8} '
          f'{total_features:>9} {"":>6} {total_failed:>5} '
          f'{client.bytes_downloaded/1048576:>7.1f}')
    print(f'elapsed {elapsed/60:.1f} min')

    if total_failed:
        failed_ids = {t: s['failed'] for t, s in per_type.items() if s['failed']}
        print(f'\n{total_failed} zones failed; rerun with --resume to retry them:')
        for zone_type, ids in failed_ids.items():
            print(f'  {zone_type}: {", ".join(ids[:10])}'
                  + (f' (+{len(ids)-10} more)' if len(ids) > 10 else ''))

    # A version stamp is only recorded for a type that was fetched in full, so a
    # --limit or partially-failed run can never masquerade as current in
    # --check-versions. Types absent from `versions` read as stale.
    complete_types = [t for t in work_types
                      if not args.limit and not per_type[t]['failed']]
    manifest = {
        'fetched_at': datetime.now(timezone.utc).isoformat(),
        'from': from_date,
        'precision': args.precision,
        'complete_snapshot': set(complete_types) == set(ZONE_TYPES),
        'complete_types': complete_types,
        'versions': {t: versions.get(t) for t in complete_types},
        'totals': {
            'requests': client.requests_made,
            'zone_requests': total_requested,
            'bytes': client.bytes_downloaded,
            'features': total_features,
            'listed': total_listed,
            'failed': total_failed,
            'seconds': round(elapsed, 1),
        },
        'per_type': per_type,
    }

    gpkg_features = None
    if not args.no_gpkg and ndjson_paths:
        if not have_ogr2ogr():
            print('\nogr2ogr not found on PATH; NDJSON staged but not converted')
            logger.error('OGR_MISSING ogr2ogr not on PATH; skipping conversion')
        else:
            gpkg_path = os.path.join(args.out_dir, 'zones.gpkg')
            print(f'\nbuilding {gpkg_path} ...')
            t0 = time.time()
            gpkg_features = build_geopackage(ndjson_paths, gpkg_path)
            print(f'  {gpkg_features} features, '
                  f'{os.path.getsize(gpkg_path)/1048576:.1f} MB, {time.time()-t0:.1f}s')
            manifest['geopackage'] = {
                'path': gpkg_path,
                'features': gpkg_features,
                'bytes': os.path.getsize(gpkg_path),
            }
            # Compare against every staging file that fed the build, not just this
            # run's types, otherwise carry-forward looks like a mismatch.
            staged_features = 0
            for path in ndjson_paths:
                with open(path, 'rb') as fh:
                    staged_features += sum(1 for _ in fh)
            if gpkg_features != staged_features:
                msg = (f'GPKG_MISMATCH staging files hold {staged_features} features '
                       f'but the GeoPackage holds {gpkg_features}')
                logger.error(msg)
                print(f'  warning: {msg}')
            manifest['geopackage']['staged_features'] = staged_features

            if args.fgb:
                fgb_path = os.path.join(args.out_dir, 'zones.fgb')
                print(f'building {fgb_path} ...')
                t0 = time.time()
                build_flatgeobuf(gpkg_path, fgb_path)
                print(f'  {os.path.getsize(fgb_path)/1048576:.1f} MB, {time.time()-t0:.1f}s')
                manifest['flatgeobuf'] = {
                    'path': fgb_path,
                    'bytes': os.path.getsize(fgb_path),
                }

    # Merge into any existing manifest so a run over a subset of types keeps the
    # version stamps and stats of the types it did not touch.
    manifest_path = os.path.join(args.out_dir, 'manifest.json')
    if os.path.exists(manifest_path):
        backup_file(manifest_path)
        try:
            with open(manifest_path) as fh:
                prior = json.load(fh)
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning(f'MANIFEST_UNREADABLE {manifest_path} {exc}; writing fresh')
            prior = {}
        merged_versions = dict(prior.get('versions') or {})
        merged_versions.update(manifest['versions'])
        # A type fetched with --limit this run is no longer trustworthy, even if a
        # previous full run had stamped it.
        for zone_type in work_types:
            if zone_type not in complete_types:
                merged_versions.pop(zone_type, None)
        manifest['versions'] = merged_versions
        manifest['complete_types'] = sorted(merged_versions)
        manifest['complete_snapshot'] = set(merged_versions) == set(ZONE_TYPES)
        merged_per_type = dict(prior.get('per_type') or {})
        merged_per_type.update(per_type)
        manifest['per_type'] = merged_per_type
        manifest['previous_fetched_at'] = prior.get('fetched_at')

    with open(manifest_path, 'w') as fh:
        json.dump(manifest, fh, indent=2)
    print(f'\nmanifest: {manifest_path}')

    # On a resume run most ids are already staged, so "features written" is expected to
    # fall short of "ids listed" and saying so without context reads like a fault.
    total_skipped = sum(s['skipped_resume'] for s in per_type.values())
    if total_skipped:
        print(f'note: {total_skipped} zone ids were already staged and skipped '
              f'(--resume); {total_features} fetched this run')
    elif total_features != total_listed and not args.limit:
        print(f'note: {total_features} features written vs {total_listed} ids listed '
              f'({total_listed - total_features:+d})')

    return 1 if total_failed else 0


if __name__ == '__main__':
    sys.exit(main())
