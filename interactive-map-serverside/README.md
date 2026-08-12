# Baron Interactive Map — Server-Side

The same three [Baron Weather](https://www.baronweather.com/) raster products as
[`../interactive-map`](../interactive-map), delivered through either TMS or WMS — but with a
FastAPI server holding the credentials, signing every request, and proxying every byte.

The browser never sees the key, the secret, or a signature. It talks only to `localhost:8000`.

**Read this alongside `../interactive-map`.** That app puts the credentials in the browser and
says so in its own README. This one is the answer to that warning, and the two are meant to be
compared.

## Setup

Every command in this README runs from `interactive-map-serverside/`.

```bash
cp env.example .env      # then fill in your key and secret
./run.sh
```

Open <http://localhost:8000/>.

`run.sh` creates a virtual environment on first run, installs the dependencies, and starts
uvicorn with `--reload`. It runs in the foreground until you press `Ctrl-C`.

Without a `.env` the server still starts: the page and the basemap load, and the panel shows a
setup message instead of weather. That is deliberate — a missing `.env` should look like a
missing `.env`, not like a broken app.

## Security

The secret stays in the server process, and `.env` sits outside the served tree entirely — only
`static/` is mounted, so `curl localhost:8000/.env` returns 404.

**That is the only thing this app hardens.** There is no TLS, no authentication, and no rate
limiting, so anyone who can reach the port can spend your key's entitlement through the proxy.
Keep it bound to localhost. This is a demonstration, not a deployment.

## What changed from the client-side version

| Concern | `../interactive-map` | This app |
|---|---|---|
| Who holds the secret | The browser | The server process |
| Who can read `.env` | Anything that reaches the port | Nothing |
| Signing | `crypto.subtle` in the browser | `hmac` on the server |
| Signature cache | Required | Gone |
| Secure-context check | Required | Gone |
| Product list | Hard-coded in `app.js` | Served by `/api/config` |
| `baron.js` | 233 lines | Gone |

Three of those deserve an explanation.

**The signature cache disappears.** `baron.js` caches a signature and renews it on a timer for
exactly one reason: MapLibre's `transformRequest` hook must return synchronously, and
`crypto.subtle.sign` is asynchronous. A server has no such constraint — it signs inside the
request handler, so the timestamp is milliseconds old against a window of about ±15 minutes.
The client-side README's "leave it open for 20 minutes, then pan" check has no equivalent here,
because there is no longer a code path that could fail it.

**The secure-context check disappears.** `crypto.subtle` exists only in a secure context, which
is why the client-side app refuses to work when served from a LAN address. Nothing in this
browser code signs anything, so the constraint does not apply.

**The WMS geometry did not move.** Deriving a bbox from the camera exists to serve MapLibre, so
it stays in `app.js`. See the comment on `viewGeometry()` — it guards a bug this project
actually shipped.

## Files

| File | Purpose |
|---|---|
| `main.py` | Routes, the shared httpx client, the static mount. Computes no signature |
| `baron.py` | Credentials, signing, upstream URLs. Imports no FastAPI |
| `cache.py` | A TTL byte cache. Knows nothing about tiles or HTTP |
| `static/index.html` | Panel markup, styles, MapLibre tags |
| `static/app.js` | Map, panel, legend, WMS bbox maths. Knows nothing about signing |
| `tests/` | pytest suite. No network, no credentials required |

`baron.py` imports no FastAPI and `main.py` computes no signature — the same boundary that
`baron.js` and `app.js` keep in the client-side version, in a different language.

## Endpoints

| Route | Returns |
|---|---|
| `GET /` | The map page |
| `GET /api/config` | Products, default view, and whether credentials are loaded |
| `GET /api/instance/{product}/{config}` | `{"time": "2026-08-11T16:20:38Z"}` |
| `GET /api/tms/{product}/{config}/{time}/{z}/{x}/{y}.png` | One signed, cached tile |
| `GET /api/wms/{product}/{config}?time=&bbox=&width=&height=` | One signed GetMap image |
| `GET /api/legend/{product}/{config}` | Legend JSON, or 404 |
| `GET /health` | `{"status": "ok", "credentials": true}` |

TMS tiles and legends are cached in memory for 60 seconds. WMS is not cached: a GetMap image is
built for one arbitrary viewport and is essentially never requested twice, so caching it would
spend memory for nothing.

The tile cache key includes the instance time, so a cached tile cannot go stale — a new instance
simply produces keys nobody has asked for yet. The TTL bounds memory, not staleness.

## Products

| Label | Code | Config |
|---|---|---|
| Max Reflectivity Composite | `C39-0x0302-0` | `Standard-Mercator` |
| Lightning Heatmap | `lightning-heatmap-global` | `Standard-Mercator` |
| GOES East Full Disk IR | `goes-east-fulldisk-hires-ir` | `Standard-Mercator` |

Defined once, in `main.py`. Availability depends on what your key is entitled to; a key without
one of these gets a message in the panel rather than a blank map.

## API notes

The reusable part of this sample. Each item was verified against the live service.

### Signing

```
ts      = floor(unix seconds)
to_sign = "<key>:<ts>"
sig     = urlsafe_base64(HMAC_SHA1(secret, to_sign))
query   = "ts=<ts>&sig=<sig>"
```

A signature is valid for about ±15 minutes. At 20 minutes old the API returns
`403 {"status":403,"message":"Expired timestamp","code":800311}`. Because signing is
timestamp-based, a system clock more than about 15 minutes out fails every request the same way,
even though the key and secret are correct.

**Pass the signature to httpx raw.** A SHA-1 digest is 20 bytes, so the base64 form always ends
in one `=`, and httpx percent-encodes it to `%3D` for you. Encoding it yourself first produces
`%253D` and a 403 that looks exactly like a wrong secret.

### Newest instance

```
GET /v1/{key}/meta/tiles/product-instances/{product}/{config}.json?page_size=1&{sig}
→ [{"time":"2026-08-11T16:20:38Z","created":"2026-08-11T16:21:59Z"}]
```

Ordered newest first. Observational products live under `/meta/tiles/`; forecast products live
under `/meta/maps/`, which this app does not use.

### TMS

```
/v1/{key}/tms/1.0.0/{product}+{config}+{time}/{z}/{x}/{y}.png
```

The instance time is part of the path and is required — omitting it returns 404. Rows run
bottom-up, so a MapLibre raster source needs `scheme: 'tms'`. That stays true through the proxy,
which passes `z`/`x`/`y` unchanged.

Neither the `+` nor the `:` inside the timestamp needs quoting; both are legal in a path segment.

### WMS

```
/v1/{key}/wms/{product}/{config}
  ?service=WMS&version=1.3.0&request=GetMap
  &crs=EPSG:3857&bbox={minx},{miny},{maxx},{maxy}
  &width={w}&height={h}&format=image/png&transparent=true
  &layers={instance time}
```

One image for the whole view, rebuilt on `moveend` — not a tile pyramid. That is what WMS is
designed for, and it is the contrast this app exists to show.

Three traps:

- **`LAYERS` is the instance timestamp, not the product code.** The product code returns
  `400 InvalidParameter`.
- **`VERSION` must be `1.3.0`.** `1.1.1` is rejected.
- **`CRS=EPSG:3857` is the only projection offered.**

And two limits:

- **`WIDTH`/`HEIGHT` are capped at 3000.** `3001` returns `400 InvalidParameter`.
- **A bbox whose aspect ratio disagrees with `width`/`height` still returns HTTP 200** and
  silently distorts the image. There is no error to catch — the caller must derive one dimension
  from the other rather than trusting the service to complain.

### Legends

```
https://static.velocityweather.com/legends/{product}/{config}/legend.json
→ {"palettes": [{"entries": [{"color": "#a4ffa47f", "value": "5 dBZ"}]}]}
```

Public — no signature. Colours are `#rrggbbaa`, which CSS accepts directly.

Quality varies, and a client has to handle all three cases:

| Product | Legend |
|---|---|
| `C39-0x0302-0` | 15 entries, all labelled, `5 dBZ` to `75 dBZ` in 5 dBZ steps |
| `goes-east-fulldisk-hires-ir` | 254 entries, every label is the string `Undefined` |
| `lightning-heatmap-global` | None. The CDN returns `403 AccessDenied` |

The CDN answers `403` rather than `404` because the bucket denies `ListBucket`, so a missing
object and a forbidden one look identical from outside. This server normalises both to a plain
404, and the page treats that as a normal state rather than an error.

WMS is no fallback: the service answers `400 OperationNotSupported` for `GetLegendGraphic`, and
its `GetCapabilities` advertises no `LegendURL` and no `<Style>` blocks. If the CDN has no
legend, there is no legend.

## Tests

```bash
source venv/bin/activate     # created by run.sh on first run
pytest
```

From the app folder, as above. `main.py` mounts `static/` on a relative path, so collection
fails from anywhere else.

No test touches the network and none needs credentials — upstream calls are faked with
`httpx.MockTransport`. The suite covers what fails *silently*: a double-encoded signature
returns a plausible 403 rather than raising, and a cache that never expires just serves stale
imagery. Neither is visible in a browser, which is why they get tests while the map does not.

MapLibre rendering is not tested. That is the checklist below.

## Verification

1. Copy `env.example` to `.env` and fill in a valid key and secret.
2. Run `./run.sh`. Open <http://localhost:8000/>.
3. `curl localhost:8000/health` → `{"status":"ok","credentials":true}`.
4. Each of the three products draws tiles in TMS mode.
5. The WMS toggle redraws each product.
6. The valid time appears and matches the newest instance.
7. Max Reflectivity shows a labelled legend. GOES East shows an unlabelled ramp. Lightning
   Heatmap shows `No legend published for this product.`
8. Refresh re-resolves the instance and the map redraws.
9. **In the browser's network panel, every request goes to `localhost:8000`.** Nothing reaches
   `api.velocityweather.com`, and no `ts` or `sig` appears anywhere. This is the check the whole
   app exists to pass.
10. `curl localhost:8000/.env` → 404. The secret is not in the served tree.
11. Pan back over ground already visited. Tiles return instantly and the server log stops
    growing — the cache is working.
12. In WMS mode, exactly one `/api/wms` request fires per settled move, sized to the viewport.
13. In WMS mode, zoom out to about z1. The overlay stays registered against the basemap, with
    blank margins where the map wraps — not stretched to fill them.
14. In WMS mode, pan to about longitude ±175 at a working zoom. The overlay still registers.
15. Rename `.env` and restart. The server still starts, `/health` reports `credentials: false`,
    the panel shows the setup message, and the basemap still loads.

Steps 9 and 10 are what separate this app from its twin; both pass trivially on a finished proxy
and fail on a half-finished one.

Steps 13 and 14 catch a geometry bug `../interactive-map` actually shipped. They are the only
two camera positions where a mismatch between the requested bbox and the placed image corners
becomes visible, and the default view reaches neither. A shortcut for both: GOES East's
full-disk imagery is a circle, so any horizontal stretch shows up immediately as an ellipse.

The common thread across 11, 13, and 14 is that each visits a state the opening screen never
reaches. Verification that only exercises the default view will pass while any of these bugs is
present.

## Limitations

The basemap is MapLibre's demo style — country outlines only, no state borders and no cities, so
placing radar geographically is hard. Swap the `style` URL in `app.js` for something with more
detail if that matters.

One weather layer at a time. No animation, no instance history, no point queries, and no
automatic polling for new instances — the Refresh button covers that.

The tile cache is per-process and in-memory, so `--reload` empties it on every code change.

In WMS mode, one image covers one view. MapLibre applies a new image's coordinates only once the
replacement has loaded, so the previous image stays pinned to its own geographic corners until
then: on zoom it scales and blurs while staying correctly registered, and on pan the newly
revealed edge is blank until the new image arrives at `moveend`. Tiled TMS does not do this —
each tile is independent, so only the tiles entering the view need to load.
