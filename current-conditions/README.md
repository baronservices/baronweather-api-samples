# current-conditions

A command-line tool that prints the current conditions for a latitude/longitude
from the Baron Velocity Weather API.

```
$ ./baron_conditions.py 34.73 -86.58
Current conditions  34.7300, -86.5800
Observed        2026-08-11 04:27 UTC  (basic)

Conditions      Partly Cloudy (9003)
Temperature     25.9 C
Feels like      25.9 C
Dew point       24.7 C
Humidity        93 %
Wind            SE 133 deg at 1.9 m/s, gust 2.4 m/s
Pressure        1019.8 hPa
Precip rate     0.0 mm/h
Cloud cover     6 %
Visibility      15532 m
Lightning       no
```

Python 3 and the standard library only. There is nothing to install.

## Setup

Copy the example file and add your key and secret:

```
cp .env.example .env
```

```
BARON_API_KEY=your_access_key
BARON_API_SECRET=your_access_secret
BARON_API_BASE_URL=https://api.velocityweather.com
```

The script reads this file and nothing else. Environment variables are
deliberately ignored, so exporting `BARON_API_KEY` has no effect. The file is
looked for in the current working directory first, then beside the script, so
the tool works from any directory. `--env PATH` names a file exactly and never
falls back.

`.env` is git-ignored. Never commit it.

## Usage

```
baron_conditions.py LAT LON [--units metric|imperial] [--domain auto|basic|global]
                            [--json] [--env PATH] [--timeout SECONDS]
```

```
./baron_conditions.py 34.73 -86.58                    # Huntsville, metric
./baron_conditions.py 51.5 -0.12 --units imperial     # London, imperial
./baron_conditions.py 34.73 -86.58 --domain global    # force the global domain
./baron_conditions.py 34.73 -86.58 --json | jq .      # raw API response
```

| Option | Default | Effect |
| --- | --- | --- |
| `--units` | `metric` | `metric` prints the API values as returned. `imperial` converts to F, mph, inHg, in/h, and mi. |
| `--domain` | `auto` | `auto` picks `basic` inside the CONUS box and `global` elsewhere. `basic` or `global` forces one. |
| `--json` | off | Prints the raw API response and skips all formatting. |
| `--env` | `.env` | Path to the credentials file. |
| `--timeout` | `30` | Request timeout in seconds. |

## Domains

The API serves conditions from two domains. `basic` covers the contiguous
United States at higher resolution; `global` covers the rest of the world. With
`--domain auto` the script uses `basic` for points inside latitude 24.0 to 50.0
and longitude -125.0 to -66.5, and `global` for everything else. The two
domains are different models, so the same point can report slightly different
values under each.

## Output

The report reads `conditions.data` from the response. Any field the API omits
prints as `n/a` instead of failing. The observation time is the API's
`issuetime`, always UTC.

Metric keeps the units the API supplies (C, m/s, hPa, mm/h, m). Imperial
converts every measurement, so its unit labels are fixed.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Conditions printed. |
| 1 | Missing credentials, a rejected key, a request failure, or an empty payload. |
| 2 | Bad command-line arguments, including an out-of-range coordinate. |

## Notes

A negative longitude works as a bare positional argument, because argparse
recognises it as a number rather than an option. If a coordinate is ever
rejected as an unknown option, put `--` before it. Everything after `--` is
treated as a coordinate, so any options have to come first:

```
./baron_conditions.py --units imperial -- 34.73 -86.58
```

Credential handling is the same as `../baron_alert_geometry`: the `.env` file
is the only source, the working directory wins over the script directory, and
requests are signed with an HMAC-SHA1 of `key:timestamp`.
