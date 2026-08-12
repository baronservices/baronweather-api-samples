# Interactive Map, Server-Side — Design

**Date:** 2026-08-11
**Folder:** `interactive-map-serverside/`
**Status:** Approved for planning

## 1. Purpose

Show the same three Baron Weather raster products as `interactive-map/`, through the same
TMS / WMS toggle, but with every request to Baron made by a server rather than by the browser.

`interactive-map/` exists to demonstrate the two delivery protocols. It carries a warning in
its own README: the key and the secret are fetched into the browser, and `http.server` serves
the whole folder, so `.env` is readable by anything that can reach the port. **This app is
the answer to that warning.** The pair is meant to be read side by side.

This is a **demonstration app** that runs on a local machine. Simple, well commented code is a
requirement, not a preference.

### In scope

- The three products from `interactive-map/`, unchanged.
- A TMS / WMS toggle that applies to the selected product.
- The newest instance of the selected product.
- The instance time, shown as text.
- A legend for the selected product.
- A Refresh button.
- A FastAPI server that holds the credentials, signs, proxies, and caches.

### Out of scope

No time animation or instance history. No click-to-query point values. No stacking of more than
one weather layer. No unit switching. No saved state. No basemap switcher.

No user accounts, no rate limiting, no TLS, no production deployment path. The server removes
the browser's access to the secret; it is not otherwise hardened, and the README says so.

No automatic polling for new instances. The Refresh button covers that.

## 2. What changes by moving server-side

This section is the point of the app. Each row is a thing the client-side twin has to do that
this one does not.

| Concern | `interactive-map/` | This app |
|---|---|---|
| Who holds the secret | The browser | The server process |
| Who can read `.env` | Anything that reaches the port | Nothing; it is outside the served tree |
| Signing | `crypto.subtle` in the browser | `hmac` on the server |
| Signature cache | Required | **Deleted** — see 2.1 |
| Secure-context check | Required | **Deleted** — `crypto.subtle` is not used |
| Product list | In `app.js` | Served by `/api/config`, defined once |
| `baron.js` | 233 lines | **Deleted** — nothing left for it to do |

### 2.1 Why the signature cache disappears

`interactive-map/` caches a signature and renews it on a 5-minute timer. That machinery exists
for one reason: MapLibre's `transformRequest` hook must return synchronously, and
`crypto.subtle.sign` is asynchronous. The cache bridges that gap.

A server has no such constraint. It signs inside the request handler, so `ts` is always a few
milliseconds old against a window of about ±15 minutes. The expiry hazard that dominates the
client-side design stops being a design problem at all.

One consequence worth stating plainly: the client-side README's verification step 8 — *leave the
page open for 20 minutes, then pan* — has no equivalent here, because there is no longer a code
path that could fail it.

### 2.2 What does not change

The WMS geometry. Deriving a bbox from the map camera exists to serve MapLibre, so it stays in
`app.js`, and the trap it guards against is unchanged. See section 7.2.

## 3. Verified API behaviour

Every fact in this section was verified against the live service on 2026-08-11 and is recorded
in `docs/superpowers/specs/2026-08-11-interactive-map-design.md` sections 2.1 to 2.5. It is
summarised here, not re-derived. The implementation depends on these, so each gets a comment at
the place in the code that relies on it.

### 3.1 Signature

```
ts       = floor(unix seconds)
to_sign  = "<key>:<ts>"
sig      = urlsafe_base64(HMAC_SHA1(secret, to_sign))
query    = "ts=<ts>&sig=<sig>"
```

A SHA-1 digest is 20 bytes, so the base64 form always carries one `=` of padding.

Signatures expire at about ±15 minutes. Measured: accepted at 15 minutes old, `403
{"status":403,"message":"Expired timestamp","code":800311}` at 20 minutes old.

A system clock more than about 15 minutes out therefore fails every request with `403 Expired
timestamp`, even though the key and secret are correct. This is a first-run failure worth
naming in an error message; see section 9.

### 3.2 Newest instance

```
GET {API_BASE}/{key}/meta/tiles/product-instances/{product}/{config}.json?page_size=1&{sig}
→ [{"time":"2026-08-11T16:20:38Z","created":"2026-08-11T16:21:59Z"}]
```

Ordered newest first. All three products resolve under `/meta/tiles/`; the `/meta/maps/`
fallback that forecast products need is not required here and is not implemented.

An empty array is possible. Treat it as an error.

### 3.3 TMS

```
{API_BASE}/{key}/tms/1.0.0/{product}+{config}+{time}/{z}/{x}/{y}.png
```

The instance time is part of the path and is required — omitting it returns 404. Rows run
bottom-up, so the MapLibre raster source needs `scheme: 'tms'`. **This is still true even
though the browser now requests our proxy instead**: the proxy passes `z`, `x`, and `y`
through unchanged, so the row order the browser sees is the row order Baron sends.

### 3.4 WMS

```
{API_BASE}/{key}/wms/{product}/{config}
    ?service=WMS&version=1.3.0&request=GetMap
    &crs=EPSG:3857&bbox=<minx>,<miny>,<maxx>,<maxy>
    &width=<px>&height=<derived from bbox aspect>
    &format=image/png&transparent=true
    &layers=<instance time>
```

One image per view, not a tile pyramid. Traps, all confirmed:

- **`LAYERS` is the instance timestamp, not the product code.** The product code returns
  `400 InvalidParameter`.
- **`VERSION` must be `1.3.0`.** `1.1.1` is rejected.
- **`CRS=EPSG:3857` is the only projection offered.**
- **`WIDTH` and `HEIGHT` are capped at 3000.** `3001` returns `400 InvalidParameter`.
- **A bbox whose aspect disagrees with `width`/`height` still returns HTTP 200** and silently
  distorts the image. There is no error to catch.

### 3.5 Legend

```
https://static.velocityweather.com/legends/{product}/{config}/legend.json
→ {"palettes": [{"entries": [{"color": "#a4ffa47f", "value": "5 dBZ"}]}]}
```

Public — no signature. Colours are `#rrggbbaa`, which CSS accepts directly. Use `palettes[0]`.

Availability differs per product, and all three cases must be handled:

| Product | Legend |
|---|---|
| `C39-0x0302-0` | 15 entries, all labelled, `5 dBZ` to `75 dBZ` in 5 dBZ steps |
| `goes-east-fulldisk-hires-ir` | 254 entries, every label is the string `Undefined` |
| `lightning-heatmap-global` | None. The CDN returns `403 AccessDenied` |

The CDN answers `403` rather than `404` because the bucket denies `ListBucket`. From outside, a
missing object and a forbidden one are indistinguishable. WMS is no fallback: the service
answers `400 OperationNotSupported` for `GetLegendGraphic`.

### 3.6 Python-side encoding

Verified locally on 2026-08-11 against `httpx` 0.28.1, because these decide how `baron.py`
builds URLs:

| Case | Result |
|---|---|
| Raw `sig` passed through `params=` | `sig=…RGw%3D` — httpx encodes the padding itself |
| `sig` pre-encoded to `%3D` *and* passed through `params=` | `sig=…RGw%253D` — **double-encoded, breaks signing** |
| `+` and `:` in a URL path | Survive untouched; TMS layer names need no quoting |
| `layers` / `bbox` through `params=` | `%3A` and `%2C` — correct |

So: build the signature with `urlsafe_b64encode`, pass it raw through `params=`, and never
hand-encode it. The second row is the trap — it is invisible until the API returns 403.

## 4. Products

| Label | Code | Config |
|---|---|---|
| Max Reflectivity Composite | `C39-0x0302-0` | `Standard-Mercator` |
| Lightning Heatmap | `lightning-heatmap-global` | `Standard-Mercator` |
| GOES East Full Disk IR | `goes-east-fulldisk-hires-ir` | `Standard-Mercator` |

Defined once, in `main.py`, and served to the browser by `/api/config`. Availability depends on
key entitlement; a key without one of these gets a clear message in the panel rather than a
blank map.

Initial view: centre `[-90, 30]`, zoom 3.

## 5. Files

```
interactive-map-serverside/
├── main.py           routes, static mount, lifespan, startup checks
├── baron.py          credentials, signing, instances, upstream URL building
├── cache.py          TTL byte cache
├── static/
│   ├── index.html    panel markup, styles, MapLibre tags
│   └── app.js        map, panel, legend, WMS bbox maths
├── env.example       credential template, tracked
├── requirements.txt  fastapi, uvicorn, httpx, python-dotenv
├── run.sh            venv, install, uvicorn
└── README.md
```

No line budget applies. Thorough comments are a requirement. What matters is that each file
keeps one responsibility.

**The split that matters:** `baron.py` imports no FastAPI, and `main.py` computes no signature.
This deliberately mirrors `interactive-map/`, where `baron.js` calls no MapLibre API and
`app.js` computes no signature. Read side by side, `baron.js` and `baron.py` are the same
boundary in two languages.

The root `.gitignore` already ignores `.env` at any depth and tracks `env.example`. No change
needed.

### 5.1 `baron.py` interface

```python
API_BASE    = "https://api.velocityweather.com/v1"
LEGEND_BASE = "https://static.velocityweather.com/legends"

# Read BARON_API_KEY / BARON_API_SECRET from the environment, having loaded .env.
# Falls back to BARON_ACCESS_KEY / BARON_ACCESS_KEY_SECRET so one .env can serve
# every folder in this repository. Returns None when neither pair is present —
# a missing .env is a reportable state, not a crash.
def load_credentials() -> tuple[str, str] | None

# True once load_credentials() has found a usable pair.
def configured() -> bool

# {"ts": ..., "sig": ...} for right now. No cache: signing is microseconds, and
# a server has no synchronous-callback constraint to work around. See design 2.1.
def signed_params() -> dict

def instance_url(product: str, config: str) -> str
def tms_url(product: str, config: str, time: str, z: int, x: int, y: int) -> str
def wms_url(product: str, config: str, time: str,
            bbox: str, width: int, height: int) -> tuple[str, dict]
def legend_url(product: str, config: str) -> str
```

The key and the secret are held in module scope, so no caller passes them around.

`wms_url` returns a `(url, params)` pair rather than a joined string, because the caller hands
both to `httpx` and pre-joining would invite the double-encoding trap in 3.6.

### 5.2 `cache.py` interface

```python
class TTLCache:
    def __init__(self, ttl: int = 300, maxsize: int = 500)
    def get(self, key: str) -> bytes | None
    def set(self, key: str, value: bytes) -> None
```

An `OrderedDict` of `key → (expires_at, bytes)`. Expired entries are dropped lazily on read.
On overflow, the oldest entry is evicted with `popitem(last=False)`.

It stores bytes and knows nothing about tiles, products, or HTTP.

## 6. Endpoints

| Route | Returns |
|---|---|
| `GET /` | `static/index.html` |
| `GET /api/config` | products, default centre and zoom, `credentials: bool` |
| `GET /api/instance/{product}/{config}` | `{"time": "2026-08-11T16:20:38Z"}` |
| `GET /api/tms/{product}/{config}/{time}/{z}/{x}/{y}.png` | one signed, proxied, cached tile |
| `GET /api/wms/{product}/{config}` | one signed, proxied GetMap image |
| `GET /api/legend/{product}/{config}` | legend JSON, or 404 |
| `GET /health` | `{"status": "ok", "credentials": bool}` |

`/api/wms` takes `time`, `bbox`, `width`, and `height` as query parameters.

Three of these need justifying.

**`/api/config` moves the product list to the server.** In the twin, `PRODUCTS` lives in
`app.js`. Here the server already needs the list to validate incoming product ids, so defining
it twice would be a bug waiting to happen. It also carries `credentials: false` when `.env` is
missing, which is what lets the panel show a setup message instead of a wall of failed requests.

**`/api/legend` proxies something public.** The legend needs no signature and the twin fetches
it straight from the CDN. Proxying it anyway buys three things: the browser has exactly one
origin so CORS never enters the picture, the server can normalise the CDN's `403 AccessDenied`
into an honest 404, and the response is cacheable alongside the tiles.

**`/api/wms` is not cached.** A WMS image is built for one arbitrary viewport and is essentially
never requested twice. Caching it would consume memory to no purpose. TMS tiles and legends are
cached; WMS is not.

### 6.1 Cache keys and TTL

```
tms:{product}:{config}:{time}:{z}:{x}:{y}
legend:{product}:{config}
```

The instance time is part of the TMS key, so **a cached tile can never be stale** — a new
instance produces new keys. The TTL therefore exists only to bound memory, not to bound
staleness. 300 seconds, 500 entries; at roughly 50 KB per tile that is a ceiling of about 25 MB.

### 6.2 Proxy behaviour

One shared `httpx.AsyncClient` is created in a FastAPI lifespan handler and closed at shutdown,
so connections are pooled across requests. Timeout 10 seconds.

Handlers are `async def`. This is why the reference app's `ThreadPoolExecutor`, its per-host
`Semaphore` map, and its `atexit` cleanup are all absent: async gives the same concurrency
without them.

Images are returned with `Response(content=..., media_type=...)` and
`Cache-Control: public, max-age=300`. Upstream status codes pass through unchanged, so a 403
from Baron reaches the browser as a 403 rather than being flattened into a 500.

### 6.3 Static mount ordering

`app.mount("/", StaticFiles(directory="static", html=True))` matches every path, so it must be
declared **after** every `/api` route. Starlette matches routes in declaration order; mounting
first silently shadows the whole API.

## 7. Client behaviour

`app.js` keeps the twin's structure and loses its credential handling. No `.env` fetch, no
`crypto.subtle`, no `transformRequest`, no secure-context check. It fetches `/api/config` at
startup and builds the product radios from the response.

One weather layer at a time. Fixed ids: source `wx`, layer `wx`.

**One code path**, used by product change, protocol change, and Refresh alike:

1. Remove layer `wx` and source `wx` if they exist.
2. Fetch `/api/instance/{product}/{config}` and remember the time — a later map move rebuilds
   the WMS URL from it without another lookup.
3. Add the source:
   - **TMS** — `type: 'raster'`, `tiles: ['/api/tms/…/{z}/{x}/{y}.png']`, `tileSize: 256`,
     `scheme: 'tms'`, attribution `© Baron Weather`.
   - **WMS** — `type: 'image'`, with a `url` for the current view and the four `coordinates` of
     that view. An image source accepts only `url` and `coordinates`; `addSource` rejects an
     attribution outright.
4. Add the raster layer before `geolines-label`, with `raster-fade-duration: 0`.
5. Update the valid-time text and the legend.

Every entry point calls this through a wrapper that catches, so a throw after step 2 cannot
leave the panel reading `Loading …` with the reason only in the console.

### 7.1 Map setup

- MapLibre GL 5.24.0 from `https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js`
  plus its CSS. Version 6.x ships ES modules only and has no build usable from a plain
  `<script>` tag.
- Basemap style: `https://demotiles.maplibre.org/style.json`. Country outlines only — no state
  borders and no cities. Noted as a limitation in the README, unchanged from the twin.
- Insertion anchor: `geolines-label`, the first symbol layer in that style.

### 7.2 Keeping the WMS image current

A tiled source re-requests tiles for a new view by itself. A single image does not, so one
persistent `moveend` handler rebuilds it. The handler no-ops unless the protocol is WMS, so it
never needs attaching and detaching.

Updating goes through `ImageSource.updateImage({url, coordinates})`, which aborts any in-flight
request and applies the new coordinates only once the new image loads, so the URL and the
corners commit together.

**The bbox and the coordinates must be built from the same four numbers.** Clamp `getBounds()`
once to ±180 longitude and ±85.05112878 latitude, then feed those exact values to both.

This is not defensive tidiness. `interactive-map/` shipped this bug and had to fix it:
`getBounds()` runs past ±180 whenever the viewport is wider than the world, and at any zoom near
the antimeridian. Clamping the bbox but not the corners made the image cover one rectangle while
being placed on another, stretching the overlay 1.4× at low zoom. **Keep exactly one clamp
site**; two is what caused it.

Height comes from the **bbox** aspect, never the canvas aspect, so camera rotation cannot
distort the image. Both dimensions clamp to 3000. Guard against a zero or negative size rather
than sending a malformed URL.

## 8. Legend

Fetch `/api/legend/{product}/{config}`. Build a CSS gradient from `palettes[0].entries`, one
stop per entry, spread evenly. Dividing by `entries.length - 1` gives `NaN` for a single-entry
palette, so treat one entry as a solid fill.

| Case | Display |
|---|---|
| Entries carry real labels | Gradient bar, with the first, middle, and last label below it |
| Every `value` is `Undefined` | Gradient bar, no labels |
| The endpoint returns 404 | The text `No legend published for this product.` |

A label is real when `value` is not the string `Undefined`. With fewer than three real labels,
show the ones that exist and do not pad the row.

## 9. Error handling

**A missing `.env` never stops the server.** It starts, logs a warning, and `/api/config`
reports `credentials: false`. The panel shows a setup message and the basemap still loads.

| Condition | Behaviour |
|---|---|
| `.env` absent or has no usable key pair | Server starts. `/api/config` → `credentials: false`. Panel: `Create interactive-map-serverside/.env from env.example`. Basemap still loads |
| Any `/api` call while unconfigured | `503` with the same setup message, so a stray request cannot look like a network fault |
| Upstream 401 or 403 on instance lookup | `502`, naming the three real causes: the key's entitlement, a malformed secret, and a system clock more than ~15 minutes out. Reporting this as "no instances" misdirects every first-run failure |
| Instance lookup returns an empty array | `502` with a message saying the product has no published instances |
| Upstream timeout or connection error | `504` naming the host that did not answer |
| Legend upstream 403 or 404 | `404` with `no legend published`. Not logged as an error — this is the normal, permanent state for `lightning-heatmap-global` |
| Any other legend failure | `502`, and logged. A network error or malformed JSON must not hide behind the silence a genuinely absent legend earns |
| Unknown product or config id | `404`. `/api/config` defines the valid set |
| A throw anywhere in the client redraw | The wrapper catches it into the panel |
| A control is clicked before `/api/config` returns | A readiness flag makes the handler return early |

Server-side messages are plain text in a JSON `detail`. The client shows them verbatim in the
panel. The map never silently shows nothing.

## 10. README contents

- What the app does, in three sentences, and that it is the server-side counterpart of
  `../interactive-map`.
- Setup: `cp env.example .env`, fill in the key and secret, `./run.sh`, open
  `http://localhost:8000/`. Note that `../interactive-map` also documents port 8000, so the two
  cannot run at once without passing `--port` to one of them.
- **Security note.** The secret stays in the server process and `.env` is outside the served
  tree, which is the whole point of this variant. But there is no TLS, no authentication, and
  no rate limiting: anyone who can reach the port can use your key's entitlement through the
  proxy. Bind it to localhost. This is a demonstration, not a deployment.
- The endpoint table from section 6.
- A **"what changed from the client-side twin"** section, built from section 2. This is the
  most useful part of the document for a reader who has seen the other app.
- The API notes from section 3.
- The verification checklist from section 11.

## 11. Verification checklist

Manual. No test harness — every check below is observable in a browser or with `curl`.

1. Copy `env.example` to `.env` and fill in a valid key and secret.
2. Run `./run.sh`. Open `http://localhost:8000/`.
3. `curl localhost:8000/health` → `{"status":"ok","credentials":true}`.
4. Each of the three products draws tiles in TMS mode.
5. The WMS toggle redraws each product.
6. The valid time appears and matches the newest instance in the metadata response.
7. Max Reflectivity shows a labelled legend. GOES East shows an unlabelled ramp. Lightning
   Heatmap shows `No legend published for this product.`
8. Refresh re-resolves the instance and the map redraws.
9. **In the browser's network panel, every request goes to `localhost:8000`.** No request
   reaches `api.velocityweather.com`, and no `ts` or `sig` appears anywhere in the browser.
   This is the check the whole app exists to pass.
10. `curl localhost:8000/.env` → 404. The secret is not in the served tree.
11. Pan back and forth over ground already visited. The server log shows cache hits, and the
    tile count against Baron stops rising.
12. In WMS mode, exactly one GetMap request fires per settled move, sized to the viewport.
13. In WMS mode, zoom out to around z1. The overlay stays registered against the basemap, with
    blank margins where the map wraps — not stretched to fill them.
14. In WMS mode, pan to around longitude ±175 at a working zoom. The overlay still registers.
15. Rename `.env` and restart. The server still starts, `/health` reports
    `credentials: false`, the panel shows the setup message, and the basemap still loads.

Steps 9 and 10 are what distinguish this app from its twin; they are the two that would pass
trivially on any ordinary proxy and fail on a half-finished one.

Steps 13 and 14 catch the geometry bug `interactive-map/` actually shipped. They are the only
two camera positions where a mismatch between the requested bbox and the placed image corners
becomes visible, and the default view reaches neither. A shortcut for both: GOES East's
full-disk imagery is a circle, so any horizontal stretch shows up immediately as an ellipse.

The lesson steps 13 and 14 share with step 11 is that each visits a state the default view never
reaches. Verification that only exercises the opening screen will pass while any of these bugs
is present.
