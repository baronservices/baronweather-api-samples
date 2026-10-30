# Baron Weather API Samples

Sample code for the Baron Velocity Weather API (`https://api.velocityweather.com`).

Each folder holds one sample. Each folder has its own README with the setup, the usage, and the
tests. Read that README before you run the sample.

## Samples

| Folder | What it does | Requirements |
|---|---|---|
| [`baron_alert_geometry`](baron_alert_geometry) | Fetches the NWS alert zone geometry into an indexed GeoPackage. Writes alert reports with a centroid for each alert. | Python 3, GDAL with the Python bindings |
| [`bgg-forecast`](bgg-forecast) | Fetches BGG (Baron Global Grid) forecast GeoTIFFs. Gives the value at a point and a time, with the correct band and the legend decode. Includes a QA gate for a folder of BGG files. | Python 3.9+, GDAL with the Python bindings, `numpy`, `timezonefinder`, `requests`, `tenacity` |
| [`current-conditions`](current-conditions) | Prints the current conditions for a latitude and a longitude. | Python 3, standard library only |
| [`geotiff_fetch`](geotiff_fetch) | Fetches one GeoTIFF and writes a copy that holds the legend palette inside the file. | Python 3.9+, `requests`, `tenacity`. GDAL and `numpy` for the coloured copy |
| [`interactive-map`](interactive-map) | Shows three raster products on a MapLibre map through TMS or WMS. The browser holds the secret. Local demonstration only. | A browser, `python3 -m http.server` |
| [`interactive-map-serverside`](interactive-map-serverside) | Shows the same map. A FastAPI server holds the secret, signs the requests, and sends the images to the browser. Local demonstration only. | Python 3.10+ |

The two map samples are a pair. Compare them to see where the secret goes.

## Credentials

Each sample reads its credentials from a `.env` file.

1. Go to the sample folder.
2. Copy the example file to `.env`. The example file is `.env.example` in
   `baron_alert_geometry` and `current-conditions`. It is `env.example` in the other folders.
3. Write your key and secret in `.env`:

```
BARON_API_KEY=your_access_key
BARON_API_SECRET=your_access_secret
```

`bgg-forecast` uses different names:

```
BARON_ACCESS_KEY=your_access_key
BARON_ACCESS_KEY_SECRET=your_access_secret
```

`geotiff_fetch` and the two map samples accept both pairs. Git ignores `.env`. Do not commit it.

The samples do not all find and read `.env` in the same way. The folder README gives the rules
for that sample.

## Request signing

All samples sign each API request in the same way:

```
ts  = the current Unix time, in whole seconds
sig = url-safe base64 of HMAC-SHA1(secret, "<key>:<ts>")
```

Each request sends `ts` and `sig` as query parameters. A signature is valid for approximately
±15 minutes. If the system clock is incorrect by more than that, every request fails with
`403 Expired timestamp`. See [`interactive-map/README.md`](interactive-map/README.md) for more.

## Tests

| Folder | Command |
|---|---|
| `baron_alert_geometry` | `python3 selftest.py` |
| `bgg-forecast` | `python3 qa_selftest.py --reference download` |
| `geotiff_fetch` | `python3 selftest.py` |
| `interactive-map-serverside` | `pytest`, in the virtual environment that `run.sh` makes |

Run each command from its sample folder. The `bgg-forecast` test needs a folder of downloaded BGG
files. Its README tells you how to get them. The other tests do not use the network or
credentials.

`current-conditions` and `interactive-map` have no automated tests. The `interactive-map`
README gives a manual verification list.

## Other files

`docs/superpowers/` holds the design specifications and the implementation plans for the two
map samples.
