#!/usr/bin/env python3
"""Current conditions for a latitude/longitude from the Baron Velocity Weather API.

Fetches one observation from the conditions report server and prints it as a
labelled block, or as the raw API JSON with --json.

The API serves two conditions domains. `basic` covers the contiguous United
States at higher resolution, `global` covers everything else. The domain is
chosen from the coordinate unless --domain names one.

Credentials
-----------
Read from a .env file and nothing else. See .env.example.

Usage
-----
    python3 baron_conditions.py 34.73 -86.58
    python3 baron_conditions.py 51.5 -0.12 --units imperial
    python3 baron_conditions.py 34.73 -86.58 --domain global
    python3 baron_conditions.py 34.73 -86.58 --json | jq .
"""

import argparse
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from urllib.parse import urlencode

DEFAULT_BASE_URL = 'https://api.velocityweather.com'
MAX_RETRIES = 3
RETRY_BASE_DELAY = 2.0
DEFAULT_TIMEOUT = 30
USER_AGENT = 'baron_conditions/1.0'

# lat_min, lat_max, lon_min, lon_max. Points inside the box use the basic
# domain; everything else has to come from global.
CONUS_BOX = (24.0, 50.0, -125.0, -66.5)

LABEL_WIDTH = 16
COMPASS = ('N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
           'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW')


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
    base = env.get('BARON_API_BASE_URL') or DEFAULT_BASE_URL
    if not key or not secret:
        sys.exit('error: BARON_API_KEY / BARON_API_SECRET not found in:\n  '
                 + '\n  '.join(tried)
                 + '\ncredentials are read from the .env file only, not the environment')
    return key, secret, base.rstrip('/')


# --------------------------------------------------------------------------- #
# HTTP / auth
# --------------------------------------------------------------------------- #

class FetchError(Exception):
    """A request failed, or failed after exhausting retries."""


class NotFound(Exception):
    """The API reported the resource does not exist."""


class BaronClient:
    """Signed HTTP client for the Velocity Weather report servers.

    Every request carries a whole-second timestamp and an HMAC-SHA1 signature of
    "key:timestamp", keyed with the API secret and urlsafe-base64 encoded.
    """

    def __init__(self, key, secret, base_url, timeout=DEFAULT_TIMEOUT):
        self.key = key
        self.secret = secret
        self.base_url = base_url
        self.timeout = timeout

    def _auth_params(self):
        ts = str(int(time.time()))
        digest = hmac.new(self.secret.encode('utf-8'),
                          f'{self.key}:{ts}'.encode('utf-8'),
                          hashlib.sha1).digest()
        return ts, base64.urlsafe_b64encode(digest).decode('utf-8')

    def build_url(self, path, params=None):
        """Build a fully signed URL for a report-server path."""
        ts, sig = self._auth_params()
        query = dict(params or {})
        query['ts'] = ts
        query['sig'] = sig
        return f'{self.base_url}/v1/{self.key}/{path}?{urlencode(query)}'

    def get(self, path, params=None, retries=MAX_RETRIES):
        """GET a path with retry/backoff, returning the raw response body."""
        last_error = None
        for attempt in range(retries):
            url = self.build_url(path, params)
            try:
                req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    return resp.read()
            except urllib.error.HTTPError as exc:
                # 404 is a definitive answer; the rest are our fault, not a
                # transient failure, so retrying only wastes time.
                if exc.code == 404:
                    raise NotFound(f'HTTP 404 for {path}') from exc
                if exc.code in (401, 403):
                    raise FetchError(f'HTTP {exc.code} for {path}: the API rejected '
                                     'the key or signature; check BARON_API_KEY and '
                                     'BARON_API_SECRET') from exc
                if exc.code == 400:
                    raise FetchError(f'HTTP 400 for {path}: {exc.read()[:200]!r}') from exc
                last_error = f'HTTP {exc.code}'
            except Exception as exc:                     # timeouts, resets, DNS
                last_error = f'{type(exc).__name__}: {exc}'
            if attempt < retries - 1:
                time.sleep(RETRY_BASE_DELAY * (2 ** attempt))
        raise FetchError(f'{path} failed after {retries} attempts: {last_error}')

    def get_json(self, path, params=None):
        body = self.get(path, params)
        try:
            return json.loads(body)
        except json.JSONDecodeError as exc:
            raise FetchError(f'{path} returned unparseable JSON: {body[:200]!r}') from exc


# --------------------------------------------------------------------------- #
# Fetch
# --------------------------------------------------------------------------- #

def pick_domain(lat, lon):
    """Choose the conditions domain that covers a coordinate."""
    lat_min, lat_max, lon_min, lon_max = CONUS_BOX
    if lat_min <= lat <= lat_max and lon_min <= lon <= lon_max:
        return 'basic'
    return 'global'


def fetch_conditions(client, domain, lat, lon):
    """Return the decoded conditions response for one point."""
    return client.get_json(f'reports/conditions/{domain}.json',
                           {'lat': lat, 'lon': lon})


# --------------------------------------------------------------------------- #
# Unit conversion
# --------------------------------------------------------------------------- #

def c_to_f(value):
    return value * 9.0 / 5.0 + 32.0


def ms_to_mph(value):
    return value * 2.2369362920544


def hpa_to_inhg(value):
    return value * 0.029529983071445


def mm_to_in(value):
    return value / 25.4


def m_to_mi(value):
    return value / 1609.344


# --------------------------------------------------------------------------- #
# Formatting
# --------------------------------------------------------------------------- #

def number(value, digits=1, convert=None):
    """Format a number to a fixed precision. Returns None when it is absent."""
    if value is None or isinstance(value, bool):
        return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    if convert is not None:
        value = convert(value)
    return f'{value:.{digits}f}'


def quantity(value, unit, digits=1, convert=None):
    """Format a value and its unit, or 'n/a' when the field is missing."""
    text = number(value, digits, convert)
    return 'n/a' if text is None else f'{text} {unit}'


def compass(degrees):
    """Convert a bearing in degrees to a 16-point compass abbreviation."""
    return COMPASS[int((degrees % 360) / 22.5 + 0.5) % 16]


def format_wind(wind, imperial):
    """Render the wind block as 'SE 129 deg at 0.5 m/s, gust 2.2 m/s'."""
    if not isinstance(wind, dict):
        return 'n/a'
    unit = 'mph' if imperial else (wind.get('speed_units') or 'm/s')
    convert = ms_to_mph if imperial else None
    speed = number(wind.get('speed'), 1, convert)
    if speed is None:
        return 'n/a'
    bearing = number(wind.get('dir'), 0)
    if bearing is None:
        text = f'{speed} {unit}'
    else:
        text = f'{compass(float(wind["dir"]))} {bearing} deg at {speed} {unit}'
    gust = number(wind.get('gust'), 1, convert)
    if gust is not None:
        text += f', gust {gust} {unit}'
    return text


def format_weather(code):
    """Render the weather code as 'Partly Cloudy (9003)'."""
    if not isinstance(code, dict):
        return 'n/a'
    text = code.get('text')
    value = code.get('value')
    if text and value is not None:
        return f'{text} ({value})'
    if text:
        return text
    return 'n/a' if value is None else str(value)


def format_lightning(value):
    if value is None:
        return 'n/a'
    return 'yes' if value else 'no'


def format_issuetime(raw):
    """Reformat the ISO-8601 issue time, or pass it through unchanged."""
    if not raw:
        return 'n/a'
    try:
        stamp = datetime.strptime(raw, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return str(raw)
    return stamp.strftime('%Y-%m-%d %H:%M UTC')


def build_rows(data, imperial):
    """Build the (label, value) pairs of the report body.

    Metric prints the values exactly as the API returns them. Imperial converts
    every measurement, so the unit labels are fixed rather than taken from the
    payload.
    """
    temperature = data.get('temperature') or {}
    humidity = data.get('relative_humidity') or {}
    pressure = data.get('pressure') or {}
    rate = (data.get('precipitation') or {}).get('rate') or {}
    cloud = data.get('cloud_cover') or {}
    visibility = data.get('visibility') or {}

    if imperial:
        t_unit, t_conv = 'F', c_to_f
        p_unit, p_conv, p_digits = 'inHg', hpa_to_inhg, 2
        r_unit, r_conv, r_digits = 'in/h', mm_to_in, 2
        v_unit, v_conv, v_digits = 'mi', m_to_mi, 1
    else:
        t_unit, t_conv = temperature.get('units') or 'C', None
        p_unit, p_conv, p_digits = pressure.get('units') or 'hPa', None, 1
        r_unit, r_conv, r_digits = rate.get('units') or 'mm/h', None, 1
        v_unit, v_conv, v_digits = visibility.get('units') or 'm', None, 0

    return [
        ('Conditions', format_weather(data.get('weather_code'))),
        ('Temperature', quantity(temperature.get('value'), t_unit, 1, t_conv)),
        ('Feels like', quantity(temperature.get('apparent'), t_unit, 1, t_conv)),
        ('Dew point', quantity(temperature.get('dew_point'), t_unit, 1, t_conv)),
        ('Humidity', quantity(humidity.get('value'), humidity.get('units') or '%', 0)),
        ('Wind', format_wind(data.get('wind'), imperial)),
        ('Pressure', quantity(pressure.get('value'), p_unit, p_digits, p_conv)),
        ('Precip rate', quantity(rate.get('value'), r_unit, r_digits, r_conv)),
        ('Cloud cover', quantity(cloud.get('value'), cloud.get('units') or '%', 0)),
        ('Visibility', quantity(visibility.get('value'), v_unit, v_digits, v_conv)),
        ('Lightning', format_lightning(data.get('lightning'))),
    ]


def format_conditions(data, lat, lon, domain, imperial):
    """Render the whole report."""
    observed = format_issuetime(data.get('issuetime'))
    lines = [f'Current conditions  {lat:.4f}, {lon:.4f}',
             f'{"Observed":<{LABEL_WIDTH}}{observed}  ({domain})',
             '']
    for label, value in build_rows(data, imperial):
        lines.append(f'{label:<{LABEL_WIDTH}}{value}')
    return '\n'.join(lines)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def latitude(text):
    value = float(text)
    if not -90.0 <= value <= 90.0:
        raise argparse.ArgumentTypeError(f'latitude {value} is outside -90..90')
    return value


def longitude(text):
    value = float(text)
    if not -180.0 <= value <= 180.0:
        raise argparse.ArgumentTypeError(f'longitude {value} is outside -180..180')
    return value


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description='Print current conditions for a latitude/longitude.',
        epilog='Credentials are read from the .env file only, not the environment.')
    parser.add_argument('lat', type=latitude, help='latitude, -90 to 90')
    parser.add_argument('lon', type=longitude, help='longitude, -180 to 180')
    parser.add_argument('--units', choices=('metric', 'imperial'), default='metric',
                        help='metric prints the API values as returned (default)')
    parser.add_argument('--domain', choices=('auto', 'basic', 'global'), default='auto',
                        help='conditions domain; auto picks basic inside the CONUS '
                             'box and global elsewhere (default: auto)')
    parser.add_argument('--json', action='store_true',
                        help='print the raw API response instead of the report')
    parser.add_argument('--env', default='.env',
                        help='path to the .env file (default: .env)')
    parser.add_argument('--timeout', type=float, default=DEFAULT_TIMEOUT,
                        help=f'request timeout in seconds (default: {DEFAULT_TIMEOUT})')
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    key, secret, base = get_credentials(args.env)
    client = BaronClient(key, secret, base, args.timeout)
    domain = pick_domain(args.lat, args.lon) if args.domain == 'auto' else args.domain

    try:
        body = fetch_conditions(client, domain, args.lat, args.lon)
    except NotFound:
        sys.exit(f'error: the {domain} domain has no conditions for '
                 f'{args.lat}, {args.lon}')
    except FetchError as exc:
        sys.exit(f'error: {exc}')

    if args.json:
        print(json.dumps(body, indent=2))
        return 0

    data = (body.get('conditions') or {}).get('data')
    if not data:
        sys.exit(f'error: the {domain} domain returned no conditions for '
                 f'{args.lat}, {args.lon}')
    print(format_conditions(data, args.lat, args.lon, domain, args.units == 'imperial'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
