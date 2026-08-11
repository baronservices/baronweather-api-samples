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
    &bbox={bbox-epsg-3857}
    &width=256
    &height=256
    &format=image/png
    &transparent=true
    &layers=<instance time>
```

Three traps, all confirmed:

- **`LAYERS` is the instance timestamp, not the product code.** `GetCapabilities` lists each
  instance time as a nested `<Layer><Name>`. Passing the product code returns
  `400 InvalidParameter`.
- **`VERSION` must be `1.3.0`.** `1.1.1` returns
  `Unsupported value for parameter "VERSION": must be "1.3.0"`.
- **`CRS=EPSG:3857` is the only projection offered.** `EPSG:4326` and `EPSG:900913` are
  rejected.

`{bbox-epsg-3857}` is a **MapLibre** placeholder, substituted per tile by MapLibre. The
instance time is substituted by our code when the template is built. Pass the time through
`encodeURIComponent`; raw colons also work, but encoding is safer.

`GetCapabilities` also reports `LayerLimit 1`, `MaxWidth 3000`, and `MaxHeight 3000`. A
256-pixel tile is well inside those limits.

### 2.5 Legend

```
https://static.velocityweather.com/legends/{product}/{config}/legend.json
```

Public. **No signature.** Shape:

```json
{"palettes": [{"entries": [{"color": "#01f3f7ff", "value": "0.5 dBZ"}]}]}
```

Colours are `#rrggbbaa`, which CSS accepts directly. Use `palettes[0]`.

Note this is a different document from the `geotiff_legend.json` that `geotiff_fetch` uses.

Legend availability differs per product, and the app must handle all three cases:

| Product | Legend |
|---|---|
| `C39-0x0302-0` | 15 entries, all labelled, `5 dBZ` to `75 dBZ` in 5 dBZ steps |
| `goes-east-fulldisk-hires-ir` | 254 entries, every `value` is the string `Undefined` |
| `lightning-heatmap-global` | None. The CDN returns `403 AccessDenied` |

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

The split that matters: `baron.js` never references MapLibre, and `app.js` never computes a
signature. Each file can be read on its own.

The root `.gitignore` already ignores `.env` at any depth. No change needed.

### 4.1 `baron.js` interface

```js
export const API_BASE = 'https://api.velocityweather.com/v1'

// Read .env over HTTP. Returns {key, secret}. Throws a message fit to show a user.
export async function loadCredentials()

// Compute the first signature, then refresh it every 5 minutes.
export async function startSigning(credentials)

// Return "ts=...&sig=..." from the cache. Synchronous by necessity — see section 5.
export function signQuery()

// Recompute the signature now. Called by the tile error handler.
export async function refreshSignature()

// Newest instance time for a product, e.g. "2026-08-11T16:20:38Z". Throws if none exist.
export async function latestInstance(product, config)

// Unsigned URL templates.
export function tmsTemplate(product, config, time)
export function wmsTemplate(product, config, time)

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

1. Remove layer `wx` and source `wx` if they exist.
2. Resolve the newest instance time.
3. Build the TMS or WMS template.
4. Add the raster source. TMS adds `scheme: 'tms'`; WMS leaves the default. Both use
   `tileSize: 256` and the attribution `&copy; Baron Weather`.
5. Add the raster layer before `geolines-label`.
6. Update the valid-time text and the legend.

`scheme` cannot be changed after a source is created, so a protocol switch has to re-add the
source. Using the same path everywhere keeps the code to one function instead of adding
`setTiles` for a second case.

### 6.1 Map setup

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
| Instance lookup fails or is empty | Message in the panel. Layer stays off. Other products stay selectable |
| MapLibre reports repeated tile errors | The `error` handler calls `refreshSignature()`, then logs. A 403 storm means an expired signature |
| Legend 403 or 404 | The `No legend published` line. Not an error, not a console warning |

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

Step 8 is the one that catches the mistake this design exists to avoid.
