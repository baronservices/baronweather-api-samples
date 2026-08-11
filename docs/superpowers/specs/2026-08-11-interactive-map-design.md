# Interactive Map — Design

**Date:** 2026-08-11
**Folder:** `interactive-map/`
**Status:** Approved for planning

## 1. Purpose

Show Baron Weather raster products on an interactive map. Deliver the same product through
either TMS or WMS, so a reader can compare the two request styles side by side.

This is a **very basic demonstration app**. It runs on a local machine. It has no build step
and no npm dependencies. Simple, well commented code is a requirement, not a preference.

### In scope

- A menu of three products.
- A TMS / WMS toggle that applies to the selected product.
- The newest instance of the selected product.
- The instance time, shown as text.
- A legend for the selected product.
- A Refresh button.

### Out of scope

No time animation or instance history. No click-to-query point values. No stacking of more
than one weather layer. No unit switching. No saved state. No basemap switcher. No production
deployment path.

No automatic polling for new instances. The Refresh button covers that. The app does hold one
timer, for signature renewal, which is a separate concern — see section 5.

## 2. Verified API behaviour

Every fact below was tested against the live API on 2026-08-11 with the key in
`geotiff_fetch/.env`. The implementation depends on these, so each one gets a comment at the
place in the code that relies on it.

### 2.1 Signature

```
ts       = floor(Date.now() / 1000)
to_sign  = "<key>:<ts>"
sig      = base64(HMAC_SHA1(secret, to_sign))
           then "+" → "-", "/" → "_", "=" → "%3D"
query    = "ts=<ts>&sig=<sig>"
```

A SHA-1 digest is 20 bytes, so the base64 form always carries one `=` of padding. That `=`
is percent-encoded, which matches `geotiff_fetch/baron_geotiff.py`.

**Signatures expire at about ±15 minutes.** Measured: accepted at 15 minutes old and 15
minutes in the future; `403 {"status":403,"message":"Expired timestamp","code":800311}` at 20
minutes old and 1 hour in the future. This is the single most important constraint in the
design. See section 5.

### 2.2 Newest instance

```
GET {API_BASE}/{key}/meta/tiles/product-instances/{product}/{config}.json?page_size=1&{sig}
```

Returns a JSON array, newest first:

```json
[{"time":"2026-08-11T16:20:38Z","created":"2026-08-11T16:21:59Z"}]
```

All three products in this app resolve under `/meta/tiles/`. The `/meta/maps/` fallback that
`baron_geotiff.py` needs for forecast products is not required here, and is not implemented.

An empty array is possible. Treat it as an error.

### 2.3 TMS

```
{API_BASE}/{key}/tms/1.0.0/{product}+{config}+{time}/{z}/{x}/{y}.png
```

The instance time is part of the path and is **required**. Omitting it returns 404. The tile
row order is TMS, so the MapLibre source needs `scheme: 'tms'`.

### 2.4 WMS

```
{API_BASE}/{key}/wms/{product}/{config}
    ?service=WMS
    &version=1.3.0
    &request=GetMap
    &crs=EPSG:3857
    &bbox=<minx>,<miny>,<maxx>,<maxy>
    &width=<viewport px>
    &height=<derived from the bbox aspect>
    &format=image/png
    &transparent=true
    &layers=<instance time>
```

**One image per view, not a tile pyramid.** This is what WMS is designed for, and it is the
contrast the whole app exists to show: TMS serves fixed 256-pixel tiles at fixed zoom levels,
WMS serves one image for one arbitrary view. MapLibre does offer a `{bbox-epsg-3857}` template
token that would let a raster source tile WMS instead, and this app deliberately does not use it.

Three traps, all confirmed:

- **`LAYERS` is the instance timestamp, not the product code.** `GetCapabilities` lists each
  instance time as a nested `<Layer><Name>`. Passing the product code returns
  `400 InvalidParameter`.
- **`VERSION` must be `1.3.0`.** `1.1.1` returns
  `Unsupported value for parameter "VERSION": must be "1.3.0"`.
- **`CRS=EPSG:3857` is the only projection offered.** `EPSG:4326` and `EPSG:900913` are
  rejected.

Pass the instance time through `encodeURIComponent`; raw colons also work, but encoding is safer.

Two further limits, both measured:

- **`WIDTH` and `HEIGHT` are capped at 3000.** `3001` returns
  `400 InvalidParameter: exceeds the maximum allowable value of 3000`, matching `GetCapabilities`.
- **A bbox whose aspect ratio disagrees with `width`/`height` still returns HTTP 200, and
  silently distorts the image.** There is no error to catch, so the caller must derive one
  dimension from the other rather than waiting for the service to complain.

`GetCapabilities` also reports `LayerLimit 1`, `MaxWidth 3000`, and `MaxHeight 3000`. A
256-pixel tile is well inside those limits.

### 2.5 Legend

```
https://static.velocityweather.com/legends/{product}/{config}/legend.json
```

Public. **No signature.** Shape:

```json
{"palettes": [{"entries": [{"color": "#a4ffa47f", "value": "5 dBZ"}]}]}
```

Colours are `#rrggbbaa`, which CSS accepts directly. Use `palettes[0]`.

Note this is a different document from the `geotiff_legend.json` that `geotiff_fetch` uses.

Legend availability differs per product, and the app must handle all three cases:

| Product | Legend |
|---|---|
| `C39-0x0302-0` | 15 entries, all labelled, `5 dBZ` to `75 dBZ` in 5 dBZ steps |
| `goes-east-fulldisk-hires-ir` | 254 entries, every `value` is the string `Undefined` |
| `lightning-heatmap-global` | None. The CDN returns `403 AccessDenied` |

The absence for `lightning-heatmap-global` was confirmed exhaustively: 403 on four config names, on six filename variants, and on five API-side legend endpoints, while a control product returns 200 from the same path shape. WMS is no fallback either — the service answers
`400 OperationNotSupported` for `GetLegendGraphic`, and its `GetCapabilities` advertises no
`LegendURL` and no `<Style>` blocks.

Note the CDN returns `403 AccessDenied` rather than `404` because the bucket denies
`ListBucket`. From outside, a missing object and a forbidden one are indistinguishable, so a
client cannot tell "no legend exists" from "no permission" — and does not need to, since
neither yields a legend to draw.

## 3. Products

All three verified on `Standard-Mercator`, on both TMS and WMS, returning `image/png`.

| Label | Code | Config |
|---|---|---|
| Max Reflectivity Composite | `C39-0x0302-0` | `Standard-Mercator` |
| Lightning Heatmap | `lightning-heatmap-global` | `Standard-Mercator` |
| GOES East Full Disk IR | `goes-east-fulldisk-hires-ir` | `Standard-Mercator` |

Product availability depends on key entitlement. A key without one of these gets a clear
error in the panel rather than a blank map.

## 4. Files

```
interactive-map/
├── index.html      panel markup, inline styles, MapLibre CDN tags
├── baron.js        credentials, signing, instance lookup, URLs
├── app.js          products, map setup, panel wiring, legend
├── env.example     credential template, tracked
├── .env            credentials, ignored by the root .gitignore
└── README.md       setup, the API notes from section 2, checklist
```

No line budget applies. Thorough comments are a requirement, and they make each file
noticeably longer than a bare implementation would be. What matters is that each file keeps one
responsibility.

The split that matters: `baron.js` calls no MapLibre API, and `app.js` computes no signature.
Each file can be read on its own.

Stated precisely, because "never references MapLibre" would overclaim: `baron.js` does embed
MapLibre's `{z}/{x}/{y}` tokens in the TMS template, so that template is not renderer-portable.
What it never does is call a MapLibre function or touch a map object. The WMS URL carries no
MapLibre tokens at all — it is a complete GetMap request — but the Mercator maths that produces
its bbox lives in `app.js`, because it exists to serve MapLibre's camera.

The root `.gitignore` already ignores `.env` at any depth. No change needed.

### 4.1 `baron.js` interface

```js
export const API_BASE = 'https://api.velocityweather.com/v1'

// Parse .env text into an object. Skips blanks and comments, splits on the first
// "=", trims, and strips one layer of surrounding quotes.
export function parseEnv(text)

// Read .env over HTTP. Returns {key, secret}. Throws a message fit to show a user.
export async function loadCredentials()

// Compute the first signature, then refresh it every 5 minutes. Takes no argument —
// loadCredentials already stashed the pair in module scope.
export async function startSigning()

// Return "ts=...&sig=..." from the cache. Synchronous by necessity — see section 5.
export function signQuery()

// Recompute the signature now. Called by the tile error handler.
export async function refreshSignature()

// Newest instance time for a product, e.g. "2026-08-11T16:20:38Z". Throws if none exist.
export async function latestInstance(product, config)

// Unsigned TMS tile template, with MapLibre's {z}/{x}/{y} left in place.
export function tmsTemplate(product, config, time)

// One unsigned WMS GetMap URL, complete rather than a template: WMS serves a
// single image for a single view, so app.js rebuilds this on every map move.
// bbox is [minx, miny, maxx, maxy] in EPSG:3857; width and height are capped at
// 3000 and must match the bbox aspect or the service silently distorts the image.
export function wmsImageUrl(product, config, time, bbox, width, height)

// Public legend URL. Needs no signature.
export function legendUrl(product, config)
```

The key and the secret are held in module scope inside `baron.js`, so no caller has to pass
them around.

`.env` parsing matches the Python tools: read each line, skip blank lines and lines starting
with `#`, split on the first `=`, trim both sides. Accept `BARON_API_KEY` / `BARON_API_SECRET`
first and `BARON_ACCESS_KEY` / `BARON_ACCESS_KEY_SECRET` as a fallback, so one `.env` can
serve every folder in the repository.

`app.js` loads as `<script type="module">`. MapLibre loads as a classic script and supplies
the `maplibregl` global.

## 5. Signing at request time

Tile URL templates are stored **unsigned**. A module-level cache holds the current
`{ts, sig}`. MapLibre's `transformRequest` hook appends it to every request aimed at the API:

```js
transformRequest: (url) => {
  if (!url.startsWith(API_BASE)) return          // basemap and legend pass through
  const join = url.includes('?') ? '&' : '?'
  return { url: url + join + signQuery() }
}
```

`transformRequest` must return synchronously, and `crypto.subtle.sign` is asynchronous. The
cache is what bridges that gap. It is computed once before the map is created, then refreshed
by a 5-minute timer. A signature is therefore at most 5 minutes old against a ±15-minute
window.

This is why the app keeps working. A signature baked into a source URL stops working after
about 15 minutes, and every later tile request returns 403 — the map goes blank while panning.

Our own `fetch` calls are outside MapLibre, so they handle signing directly: the instance
lookup appends `signQuery()`, and the legend request appends nothing.

## 6. Layer handling

One weather layer at a time. Fixed ids: source `wx`, layer `wx`.

**One code path**, used by product change, protocol change, and Refresh alike:

1. Remove layer `wx` and source `wx` if they exist. This ordering matters: the `moveend`
   handler below relies on the source being absent for the whole of step 2.
2. Resolve the newest instance time, and remember it — a later map move rebuilds the WMS URL
   from it without another metadata lookup.
3. Add the source, which is where the two protocols diverge:
   - **TMS** — `type: 'raster'`, `tiles: [template]`, `tileSize: 256`, `scheme: 'tms'`, and the
     attribution `&copy; Baron Weather`.
   - **WMS** — `type: 'image'`, with a `url` for the current view and the four `coordinates` of
     that view. An image source accepts only `url` and `coordinates`, so it carries no
     attribution; `addSource` rejects the property outright.
4. Add the raster layer before `geolines-label`, with `raster-fade-duration: 0`. A raster layer
   renders both source types, and the zero fade stops the image flashing when it is replaced.
5. Update the valid-time text and the legend.

Every entry point calls this through a wrapper that catches — `showProduct()` is async, and a
throw after step 2 would otherwise leave the panel reading `Loading …` with the reason only in
the console.

`scheme` cannot be changed after a source is created, and the two protocols now need different
source types anyway, so any switch re-adds the source. One path stays simpler than two.

### 6.1 Keeping the WMS image current

A tiled source re-requests tiles for a new view by itself. A single image does not, so one
persistent `moveend` handler rebuilds it. The handler no-ops unless the protocol is WMS, so it
never needs attaching and detaching — a listener that is never removed cannot leak.

Updating goes through `ImageSource.updateImage({url, coordinates})`, which aborts any in-flight
request and applies the new coordinates only once the new image loads. So the URL and the corners
commit together, and a slow response can never leave the pair mismatched. Until it lands, the
previous image stays pinned to its own geographic corners — scaling and blurring on zoom, leaving
the newly revealed edge blank on pan, rather than stretching to fill the new view.

**The bbox and the coordinates must be built from the same four numbers.** Clamp
`getBounds()` once to ±180 longitude and ±85.05112878 latitude, then feed those exact values to
both. This is not defensive tidiness — it is a bug this project actually shipped and had to fix.
`getBounds()` runs past ±180 whenever the viewport is wider than the world, and, because
MapLibre leaves longitude unconstrained by default, at *any* zoom near the antimeridian. When the
bbox was clamped and the corners were not, the image covered one rectangle and was placed on
another, and the whole overlay stretched — 1.4× at low zoom, 1.2× near the antimeridian. Keep
exactly one clamp site; two is what caused it.

Height comes from the **bbox** aspect, never the canvas aspect, so camera rotation cannot distort
the image. Both dimensions clamp to 3000. Guard against a zero or negative size rather than
sending a malformed URL.

### 6.2 Map setup

- MapLibre GL 5.24.0 from
  `https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js` plus its CSS.
  Version 6.x ships ES modules only and has no build usable from a plain `<script>` tag.
- Basemap style: `https://demotiles.maplibre.org/style.json`.
- Initial view: centre `[-90, 30]`, zoom 3.
- Insertion anchor: `geolines-label`, the first symbol layer in that style, so country labels
  stay readable above the weather.

The demo style ends with a `crimea-fill` layer, which sits after the symbol layers and so
draws above the weather. It is a small polygon and the effect is cosmetic. Left as is.

The demo basemap shows country outlines only — no state borders and no cities.

## 7. Legend

Fetch `legendUrl(product, config)`. Build a CSS gradient from `palettes[0].entries`, one stop
per entry, spread evenly:

```js
const stops = entries.map(
  (e, i) => `${e.color} ${((i / (entries.length - 1)) * 100).toFixed(2)}%`
)
bar.style.background = `linear-gradient(to right, ${stops.join(', ')})`
```

That divides by `entries.length - 1`, so a palette holding a single entry gives `NaN`. Treat
one entry as a solid fill instead. None of the three products hits this, but the guard is one
line.

The legend block is always present. It degrades in three steps:

| Case | Display |
|---|---|
| Entries carry real labels | Gradient bar, with the first, middle, and last label below it |
| Every `value` is `Undefined` | Gradient bar, no labels |
| The fetch fails | The text `No legend published for this product.` |

A label is real when `value` is not the string `Undefined`. Pick the first, middle, and last
of the real labels only. With fewer than three real labels, show the ones that exist and do
not pad the row.

## 8. Error handling

| Condition | Behaviour |
|---|---|
| `.env` returns 404 | Panel shows `Create interactive-map/.env from env.example`. Basemap still loads |
| `fetch` of `.env` throws | Panel names the fix: `python3 -m http.server 8000`. This is what a `file://` open looks like |
| `.env` has no usable key pair | Same message as a missing `.env` |
| `crypto.subtle` is missing | Panel says signing needs a secure context and names `http://localhost:8000`. See below |
| Instance lookup returns 401 or 403 | Panel names the three real causes: the key's entitlement, a malformed secret, and a system clock more than ~15 minutes out. Reporting this as "no instances" misdirects every first-run failure |
| Instance lookup fails otherwise, or is empty | Message in the panel. Layer stays off. Other products stay selectable. The legend is cleared too, so it cannot describe the previous product beside an error for a new one |
| A throw anywhere else in the redraw | Every entry point calls `showProduct()` through a wrapper that catches into the panel. Without it an `addSource` collision, a missing basemap anchor, or an unloaded style leaves the panel reading `Loading …` with the reason only in the console |
| A control is clicked before credentials load | A readiness flag makes the handler return early, so the setup message stays put instead of being replaced by a null dereference from deeper in the stack |
| MapLibre reports repeated tile errors | The `error` handler calls `refreshSignature()`, then logs. A 403 storm means an expired signature |
| Legend 403 or 404 | The `No legend published` line. Silent — no console warning. Verified as the normal, permanent state for `lightning-heatmap-global` |
| Any other legend failure | The same panel line, plus a `console.warn` naming the cause. A network error, malformed JSON, or a missing `palettes[0].entries` must not hide behind the silence that a genuinely absent legend earns |

Every message is plain text in the panel. The map never silently shows nothing.

**Secure context.** `crypto.subtle` exists only in a secure context. Browsers treat
`http://localhost` and `http://127.0.0.1` as secure, so the normal setup works. Serving the
same page on a LAN address such as `http://192.168.1.20:8000` leaves `crypto.subtle` undefined
and signing fails with an obscure type error. The app checks for it once and reports the cause.

## 9. README contents

- What the app does, in three sentences.
- Setup: `cp env.example .env`, fill in the key and secret, `python3 -m http.server 8000`,
  open `http://localhost:8000/`.
- **Security note.** The key and the secret reach the browser, and `http.server` serves the
  whole folder, so `.env` itself is readable by anything that can reach the port. This is a
  local demonstration. Do not deploy it as it stands.
- The API notes from section 2, which are the reusable part for a reader.
- The verification checklist from section 10.

## 10. Verification checklist

Manual. No test harness — the app is three small files and every check below is observable in a
browser.

1. Copy `env.example` to `.env` and fill in a valid key and secret.
2. Run `python3 -m http.server 8000` in `interactive-map/`. Open `http://localhost:8000/`.
3. Each of the three products draws tiles in TMS mode.
4. The WMS toggle redraws each product. The network panel shows `request=GetMap`.
5. The valid time appears, and matches the newest instance in the metadata response.
6. Max Reflectivity shows a labelled legend. GOES East shows an unlabelled ramp. Lightning
   Heatmap shows `No legend published for this product.`
7. Refresh re-resolves the instance and the map redraws.
8. Leave the page open for 20 minutes, then pan. Tiles still load. This is the check that
   proves per-request signing works.
9. Rename `.env` and reload. The panel shows the setup message and the basemap still loads.
10. In WMS mode, exactly **one** `request=GetMap` per settled move, sized to the viewport.
11. In WMS mode, zoom out to around z1. The overlay stays correctly registered against the
    basemap, with blank margins where the map wraps — not stretched to fill them.
12. In WMS mode, pan to around longitude ±175 at a working zoom. The overlay still registers.

Step 8 catches the signing mistake this design exists to avoid. Steps 11 and 12 catch the
geometry mistake this app actually shipped once: they are the two camera positions where a
mismatch between the requested bbox and the placed corners becomes visible, and neither is
reachable from the default view. A useful shortcut for both — GOES East's full-disk imagery is a
circle, so any horizontal stretch shows up immediately as an ellipse, with no coastline
comparison needed.

Steps 8, 11, and 12 share a lesson worth stating: each visits a state the happy path never
reaches. Verification that only exercises the default view will pass while the bug is present.
