# Interactive Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a very basic static web page that shows three Baron Weather raster products on a map, delivered through either TMS or WMS.

**Architecture:** Three source files served as plain static assets. `baron.js` owns everything that touches the API — credentials, HMAC signing, instance lookup, URL building — and never references MapLibre. `app.js` owns the map and the panel and never computes a signature. Signatures are appended per request through MapLibre's `transformRequest` hook rather than baked into tile URLs, because they expire after about 15 minutes.

**Tech Stack:** Plain HTML, ES modules, MapLibre GL JS 5.24.0 from jsDelivr, `python3 -m http.server` for serving. No build step. No npm. No dependencies to install.

**Spec:** `docs/superpowers/specs/2026-08-11-interactive-map-design.md`

## Global Constraints

- **Working folder:** `interactive-map/`. All source paths below are relative to the repository root.
- **No build step, no npm, no installed dependencies.** Only the two MapLibre files from a CDN.
- **MapLibre GL JS pinned to 5.24.0**: `https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js` and `.../maplibre-gl.css`. Do not upgrade to 6.x — it ships ES modules only and has no build usable from a plain `<script>` tag.
- **No test framework.** The spec's section 10 calls for manual verification. Each task below ends with an explicit verification step instead. Do not add a test runner, a `package.json`, or a `node_modules`.
- **Three source files only:** `index.html` (~80 lines), `baron.js` (~90 lines), `app.js` (~110 lines). Plus `env.example` and `README.md`.
- **Very basic demonstration app.** Simple, well commented code is a requirement. Every verified API quirk gets a comment at the place the code depends on it. Do not add features beyond this plan.
- **API base:** `https://api.velocityweather.com/v1`
- **Legend base:** `https://static.velocityweather.com/legends` — public, takes no signature.
- **All three products** use config `Standard-Mercator` and resolve under `/meta/tiles/`. Do not implement the `/meta/maps/` fallback.
- **WMS requires** `version=1.3.0`, `crs=EPSG:3857`, and `layers=<instance timestamp>`. The product code in `layers` returns HTTP 400.
- **TMS requires** the instance timestamp in the path and `scheme: 'tms'` on the source. Omitting the timestamp returns HTTP 404.
- **Signatures are valid about ±15 minutes.** Renew the cached signature every 5 minutes. Never bake a signature into a source URL.
- **Basemap:** `https://demotiles.maplibre.org/style.json`, centre `[-90, 30]`, zoom `3`. Insert the weather layer before the layer id `geolines-label`.
- **Credential names:** accept `BARON_API_KEY` / `BARON_API_SECRET` first, then `BARON_ACCESS_KEY` / `BARON_ACCESS_KEY_SECRET`.
- **Styling is deliberately minimal.** A dark panel, monospace text. This is a plumbing demonstration, not a design deliverable.

## File Structure

| File | Responsibility |
|---|---|
| `interactive-map/index.html` | Panel markup, inline styles, MapLibre CDN tags. No logic. |
| `interactive-map/baron.js` | Credentials, signing, instance lookup, URL builders. Knows nothing about MapLibre. |
| `interactive-map/app.js` | Product list, map setup, panel wiring, legend rendering. Knows nothing about HMAC. |
| `interactive-map/env.example` | Credential template. Tracked in git. |
| `interactive-map/README.md` | Setup, security note, API notes, verification checklist. |

`interactive-map/.env` holds real credentials and is already ignored — the root `.gitignore` has a bare `.env` pattern, which matches at any depth. Do not add a new `.gitignore`.

## A note on the two timers

There is exactly one timer in this app: signature renewal, every 5 minutes. It exists for correctness. There is deliberately **no** timer polling for new product instances — the Refresh button covers that. Do not add one.

---

### Task 1: Static page shell with a basemap

Produces a page that loads MapLibre, draws the demo basemap, and shows an empty control panel. No API calls yet.

**Files:**
- Create: `interactive-map/index.html`
- Create: `interactive-map/app.js`

**Interfaces:**
- Consumes: nothing.
- Produces: DOM element ids that later tasks wire up — `map`, `panel`, `products`, `protocol`, `refresh`, `status`, `legend-bar`, `legend-labels`, `legend-note`. A global `maplibregl` from the CDN script. In `app.js`: `el(id)`, `setStatus(text, isError)`, `createMap()`, `start()`.

- [ ] **Step 1: Create `interactive-map/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Baron Weather — Interactive Map</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.css">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  #map { position: absolute; inset: 0; }
  #panel {
    position: absolute; top: 12px; left: 12px; width: 260px; z-index: 1;
    background: rgba(18, 20, 24, 0.92); color: #e8e8e8;
    border: 1px solid #333; border-radius: 6px; padding: 12px; font-size: 12px;
  }
  #panel h1 {
    font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase;
    margin: 0 0 10px; color: #7fd4ff;
  }
  #panel h2 {
    font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
    color: #8a8f98; margin: 12px 0 6px; font-weight: normal;
  }
  #products label { display: block; padding: 2px 0; cursor: pointer; }
  #protocol button, #refresh {
    font: inherit; background: #23262c; color: #cfd3d8;
    border: 1px solid #3a3e45; border-radius: 4px; padding: 4px 10px; cursor: pointer;
  }
  #protocol button.on { background: #7fd4ff; border-color: #7fd4ff; color: #10131a; }
  #refresh { margin-top: 12px; width: 100%; }
  #status { color: #8a8f98; margin: 10px 0 0; min-height: 2.4em; word-break: break-word; }
  #status.error { color: #ff9b9b; }
  #legend-bar {
    height: 12px; border: 1px solid #3a3e45; border-radius: 2px;
    margin-top: 8px; display: none;
  }
  #legend-labels { display: flex; justify-content: space-between; color: #8a8f98; margin-top: 4px; }
  #legend-note { color: #8a8f98; margin: 8px 0 0; }
</style>
</head>
<body>
  <div id="map"></div>

  <div id="panel">
    <h1>Baron Weather</h1>

    <h2>Product</h2>
    <!-- Radios are built by app.js from its PRODUCTS list, so the product
         definitions live in exactly one place. -->
    <div id="products"></div>

    <h2>Delivery</h2>
    <div id="protocol">
      <button data-protocol="tms" class="on">TMS</button>
      <button data-protocol="wms">WMS</button>
    </div>

    <button id="refresh">Refresh</button>

    <p id="status">Starting…</p>

    <div id="legend">
      <div id="legend-bar"></div>
      <div id="legend-labels"></div>
      <p id="legend-note"></p>
    </div>
  </div>

  <!-- MapLibre 5.24.0 is the newest release with a classic build usable from a
       plain script tag. Version 6.x is ES modules only. -->
  <script src="https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js"></script>
  <script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `interactive-map/app.js`**

```js
/**
 * app.js — the map and the panel.
 *
 * This file knows nothing about HMAC signing. Everything that talks to the
 * Baron Weather API lives in baron.js.
 */

// The demo basemap's first symbol layer. Weather is inserted below it so that
// country labels stay readable on top of the data.
const LABEL_LAYER = 'geolines-label'

let map

/** Shorthand for document.getElementById. */
const el = (id) => document.getElementById(id)

/** Write a message into the panel. Errors are styled differently. */
function setStatus(text, isError = false) {
  el('status').textContent = text
  el('status').classList.toggle('error', isError)
}

function createMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://demotiles.maplibre.org/style.json',
    center: [-90, 30],
    zoom: 3
  })
}

function start() {
  createMap()
  setStatus('Basemap loaded.')
}

start()
```

- [ ] **Step 3: Serve the folder and open it**

Run:

```bash
cd interactive-map && python3 -m http.server 8000
```

Open `http://localhost:8000/` in a browser.

Expected:
- A world map draws with country outlines and country labels.
- The panel appears top-left, reading `BARON WEATHER`, `PRODUCT`, `DELIVERY`, a `TMS`/`WMS` pair with TMS highlighted in blue, a full-width `Refresh` button, and the text `Basemap loaded.`
- The browser console is free of errors.

- [ ] **Step 4: Confirm the insertion anchor exists**

In the browser console, run:

```js
map.getStyle().layers.map(l => l.id + ' (' + l.type + ')')
```

Expected: the list contains `geolines-label (symbol)`. This is the anchor `LABEL_LAYER` names, and Task 3 depends on it.

- [ ] **Step 5: Commit**

```bash
git add interactive-map/index.html interactive-map/app.js
git commit -m "Add the interactive map page shell and basemap"
```

---

### Task 2: Credentials, signing, and instance lookup

Produces a page that reads `.env`, signs a real API request, and shows the newest instance time for the first product in the panel. This proves signing works end to end before any tiles are involved.

**Files:**
- Create: `interactive-map/env.example`
- Create: `interactive-map/baron.js`
- Modify: `interactive-map/app.js`

**Interfaces:**
- Consumes: `el(id)`, `setStatus(text, isError)`, `createMap()`, `start()` from Task 1.
- Produces, exported from `baron.js`:
  - `API_BASE` — string, `'https://api.velocityweather.com/v1'`
  - `parseEnv(text)` → object of key/value strings
  - `loadCredentials()` → `Promise<{key, secret}>`; throws `Error` with a user-facing message
  - `startSigning()` → `Promise<void>`
  - `refreshSignature()` → `Promise<void>`
  - `signQuery()` → string `'ts=…&sig=…'`, synchronous
  - `latestInstance(product, config)` → `Promise<string>` ISO time, e.g. `'2026-08-11T16:20:38Z'`; throws `Error`

- [ ] **Step 1: Create `interactive-map/env.example`**

```
# Rename this file to .env and fill in valid credentials.
#
# The page fetches this file over HTTP, so the folder has to be served — see the
# README. Anything that can reach the port can read it. Local demonstration only.
#
# Either name pair works. BARON_API_KEY / BARON_API_SECRET is checked first and
# BARON_ACCESS_KEY / BARON_ACCESS_KEY_SECRET is the fallback, so one .env can
# serve every folder in this repository.

BARON_API_KEY=your_access_key
BARON_API_SECRET=your_access_secret
```

- [ ] **Step 2: Create `interactive-map/baron.js`**

```js
/**
 * baron.js — everything that talks to the Baron Weather API.
 *
 * This file knows nothing about MapLibre. It reads credentials, signs requests,
 * resolves the newest product instance, and builds URLs.
 */

export const API_BASE = 'https://api.velocityweather.com/v1'

// The API accepts a signature for about 15 minutes either side of now, so
// renewing every 5 minutes leaves a wide margin.
const SIGNATURE_INTERVAL_MS = 5 * 60 * 1000

let credentials = null   // {key, secret}
let cachedQuery = null   // "ts=...&sig=..."

/**
 * Parse a .env file the way the Python tools in this repository do: skip blank
 * lines and comments, split on the first "=", trim both sides.
 */
export function parseEnv(text) {
  const values = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return values
}

/**
 * Fetch and parse .env. Throws an Error whose message is fit to show a user.
 */
export async function loadCredentials() {
  let response
  try {
    response = await fetch('.env')
  } catch {
    // fetch() of a relative path fails outright when the page was opened as a
    // file:// URL. Name the fix rather than reporting a network error.
    throw new Error('Cannot read .env — serve this folder: python3 -m http.server 8000')
  }
  if (!response.ok) {
    throw new Error('Create interactive-map/.env from env.example')
  }
  const values = parseEnv(await response.text())
  const key = values.BARON_API_KEY || values.BARON_ACCESS_KEY
  const secret = values.BARON_API_SECRET || values.BARON_ACCESS_KEY_SECRET
  if (!key || !secret) {
    throw new Error('Create interactive-map/.env from env.example')
  }
  credentials = { key, secret }
  return credentials
}

/**
 * Compute "ts=...&sig=..." for right now.
 *
 * The signed string is "<key>:<ts>", hashed with HMAC-SHA1 and base64 encoded,
 * then made URL safe. A SHA-1 digest is 20 bytes, so the base64 form always
 * carries one "=" of padding, which is percent-encoded. This matches
 * geotiff_fetch/baron_geotiff.py.
 */
async function computeQuery() {
  const { key, secret } = credentials
  const ts = Math.floor(Date.now() / 1000)
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  )
  const digest = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(`${key}:${ts}`)
  )
  const sig = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '%3D')
  return `ts=${ts}&sig=${sig}`
}

/** Compute the first signature, then renew it on a timer. */
export async function startSigning() {
  // crypto.subtle exists only in a secure context. Browsers count
  // http://localhost and http://127.0.0.1 as secure, so the documented setup
  // works — but serving this page on a LAN address does not, and the API would
  // be undefined. Say so plainly instead of failing with a type error.
  if (!crypto.subtle) {
    throw new Error('Signing needs a secure context — open http://localhost:8000, not a LAN address')
  }
  await refreshSignature()
  setInterval(refreshSignature, SIGNATURE_INTERVAL_MS)
}

/** Recompute the signature now. */
export async function refreshSignature() {
  cachedQuery = await computeQuery()
}

/**
 * The current signature query string.
 *
 * Synchronous on purpose. MapLibre's transformRequest hook has to return
 * immediately and crypto.subtle.sign is asynchronous, so the value is cached
 * rather than computed on demand.
 */
export function signQuery() {
  return cachedQuery
}

/** Sign a URL that our own code fetches. MapLibre requests are signed by the hook. */
function signed(url) {
  return url + (url.includes('?') ? '&' : '?') + signQuery()
}

/**
 * The newest instance time for a product, e.g. "2026-08-11T16:20:38Z".
 *
 * The response is an array ordered newest first, so page_size=1 is enough. All
 * three products in this demo are observational and live under /meta/tiles/.
 */
export async function latestInstance(product, config) {
  const url = signed(
    `${API_BASE}/${credentials.key}` +
    `/meta/tiles/product-instances/${product}/${config}.json?page_size=1`
  )
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`No instances for ${product} (HTTP ${response.status})`)
  }
  const instances = await response.json()
  if (!instances.length) {
    throw new Error(`No instances for ${product}`)
  }
  return instances[0].time
}
```

- [ ] **Step 3: Rewrite `interactive-map/app.js` to use it**

Replace the whole file:

```js
/**
 * app.js — the map and the panel.
 *
 * This file knows nothing about HMAC signing. Everything that talks to the
 * Baron Weather API lives in baron.js.
 */

import {
  loadCredentials,
  startSigning,
  latestInstance
} from './baron.js'

// The three products this demo offers. All are observational raster products on
// Standard-Mercator, and all work over both TMS and WMS.
const PRODUCTS = [
  {
    code: 'C39-0x0302-0',
    config: 'Standard-Mercator',
    label: 'Max Reflectivity Composite'
  },
  {
    code: 'lightning-heatmap-global',
    config: 'Standard-Mercator',
    label: 'Lightning Heatmap'
  },
  {
    code: 'goes-east-fulldisk-hires-ir',
    config: 'Standard-Mercator',
    label: 'GOES East Full Disk IR'
  }
]

// The demo basemap's first symbol layer. Weather is inserted below it so that
// country labels stay readable on top of the data.
const LABEL_LAYER = 'geolines-label'

let map
let selected = PRODUCTS[0]

/** Shorthand for document.getElementById. */
const el = (id) => document.getElementById(id)

/** Write a message into the panel. Errors are styled differently. */
function setStatus(text, isError = false) {
  el('status').textContent = text
  el('status').classList.toggle('error', isError)
}

function createMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://demotiles.maplibre.org/style.json',
    center: [-90, 30],
    zoom: 3
  })
}

async function start() {
  createMap()

  try {
    await loadCredentials()
    await startSigning()
  } catch (error) {
    // Without credentials the basemap still loads, so the page is never blank.
    setStatus(error.message, true)
    return
  }

  try {
    const time = await latestInstance(selected.code, selected.config)
    setStatus(`Valid ${time}`)
  } catch (error) {
    setStatus(error.message, true)
  }
}

start()
```

- [ ] **Step 4: Create a working `.env`**

```bash
cd interactive-map && cp env.example .env
```

Edit `.env` and fill in a real key and secret. A working pair already exists in `geotiff_fetch/.env` if you need one.

- [ ] **Step 5: Verify a signed request succeeds**

Reload `http://localhost:8000/`.

Expected: the panel reads `Valid 2026-…Z` with a real timestamp within the last few minutes. That single line proves `.env` parsing, HMAC signing, and the metadata endpoint all work.

Optional cross-check against the repository's independent Python signing path. This needs
`requests` and `tenacity` installed; skip it if they are not:

```bash
cd geotiff_fetch && python3 baron_geotiff.py --product C39-0x0302-0 \
    --projection Standard-Mercator --list-times 1
```

Expected: the same timestamp, or one instance newer if the product updated between the two calls.

- [ ] **Step 6: Verify the missing-credentials path**

```bash
cd interactive-map && mv .env .env.hidden
```

Reload the page.

Expected: the basemap still draws, and the panel shows `Create interactive-map/.env from env.example` in red.

Restore it:

```bash
cd interactive-map && mv .env.hidden .env
```

- [ ] **Step 7: Commit**

```bash
git add interactive-map/env.example interactive-map/baron.js interactive-map/app.js
git commit -m "Read credentials, sign requests, and resolve the newest instance"
```

`.env` itself must not appear in the commit. The root `.gitignore` already covers it — confirm with `git status` before committing.

---

### Task 3: TMS layer on the map

Produces working weather tiles. The product radios and the Refresh button become live, and signing moves into MapLibre's request hook.

**Files:**
- Modify: `interactive-map/baron.js`
- Modify: `interactive-map/app.js`

**Interfaces:**
- Consumes: `API_BASE`, `signQuery()`, `refreshSignature()`, `latestInstance(product, config)` from Task 2. `PRODUCTS`, `LABEL_LAYER`, `el`, `setStatus`, `createMap`, `start` from Task 2's `app.js`.
- Produces:
  - `baron.js`: `tmsTemplate(product, config, time)` → unsigned URL template string
  - `app.js`: `showProduct()` → `Promise<void>`, the single code path that puts weather on the map; `buildProducts()`

- [ ] **Step 1: Add `tmsTemplate` to `interactive-map/baron.js`**

Append after `latestInstance`:

```js
/**
 * TMS tile template.
 *
 * The instance time sits in the path and is required — leaving it out returns
 * 404. The time is used verbatim, not percent-encoded, which is the form the
 * endpoint was verified against.
 *
 * Rows run bottom-up, so the MapLibre source needs scheme: 'tms'.
 *
 * Returned unsigned. transformRequest adds ts and sig to each tile request.
 */
export function tmsTemplate(product, config, time) {
  const layer = `${product}+${config}+${time}`
  return `${API_BASE}/${credentials.key}/tms/1.0.0/${layer}/{z}/{x}/{y}.png`
}
```

- [ ] **Step 2: Sign MapLibre's requests in `interactive-map/app.js`**

Extend the import to add `API_BASE`, `signQuery`, `refreshSignature`, and `tmsTemplate`:

```js
import {
  API_BASE,
  loadCredentials,
  startSigning,
  signQuery,
  refreshSignature,
  latestInstance,
  tmsTemplate
} from './baron.js'
```

Replace `createMap` with:

```js
function createMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://demotiles.maplibre.org/style.json',
    center: [-90, 30],
    zoom: 3,

    // Sign every Baron request as it is made, rather than baking a signature
    // into the tile URL. A signature is good for only about 15 minutes, so a
    // long-lived source URL would start returning 403 and the map would go
    // blank while panning.
    transformRequest: (url) => {
      if (!url.startsWith(API_BASE)) return   // basemap requests pass through
      return { url: url + (url.includes('?') ? '&' : '?') + signQuery() }
    }
  })

  let lastRefresh = 0
  map.on('error', (event) => {
    console.warn('map error:', event.error && event.error.message)
    // A burst of tile errors usually means the signature expired. Renew it, but
    // not more than once every 30 seconds.
    if (Date.now() - lastRefresh > 30000) {
      lastRefresh = Date.now()
      refreshSignature()
    }
  })
}
```

- [ ] **Step 3: Add the layer code path and the product radios**

Insert before `start()`:

```js
/**
 * The one code path that puts weather on the map. The product radios, the
 * protocol toggle, and the Refresh button all call this.
 *
 * It always removes and re-adds the source. A raster source's `scheme` cannot
 * be changed after the source is created, so a protocol switch has to re-add it
 * anyway — one path is simpler than two.
 */
async function showProduct() {
  if (map.getLayer('wx')) map.removeLayer('wx')
  if (map.getSource('wx')) map.removeSource('wx')

  setStatus(`Loading ${selected.label}…`)

  let time
  try {
    time = await latestInstance(selected.code, selected.config)
  } catch (error) {
    setStatus(error.message, true)
    return
  }

  map.addSource('wx', {
    type: 'raster',
    tiles: [tmsTemplate(selected.code, selected.config, time)],
    tileSize: 256,
    scheme: 'tms',           // Baron TMS rows run bottom-up
    attribution: '&copy; Baron Weather'
  })
  map.addLayer({ id: 'wx', type: 'raster', source: 'wx' }, LABEL_LAYER)

  setStatus(`Valid ${time}`)
}

/** Build the product radios from PRODUCTS, so the list lives in one place. */
function buildProducts() {
  const container = el('products')
  PRODUCTS.forEach((product, index) => {
    const label = document.createElement('label')
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'product'
    radio.checked = index === 0
    radio.addEventListener('change', () => {
      selected = product
      showProduct()
    })
    label.append(radio, ` ${product.label}`)
    container.append(label)
  })
}
```

- [ ] **Step 4: Wire startup to draw the first product**

Replace `start` with:

```js
async function start() {
  buildProducts()
  el('refresh').addEventListener('click', showProduct)
  createMap()

  try {
    await loadCredentials()
    await startSigning()
  } catch (error) {
    // Without credentials the basemap still loads, so the page is never blank.
    setStatus(error.message, true)
    return
  }

  // Wait for the style before adding a layer — addLayer needs its anchor layer
  // to exist. Loading credentials is fast enough that the style is usually still
  // loading, but check rather than rely on the race going one way.
  if (map.isStyleLoaded()) showProduct()
  else map.on('load', showProduct)
}
```

- [ ] **Step 5: Verify tiles draw for all three products**

Reload `http://localhost:8000/`.

Expected:
- Three radios appear: `Max Reflectivity Composite` (selected), `Lightning Heatmap`, `GOES East Full Disk IR`.
- Radar returns draw over North America. Coverage depends on the weather; on a quiet day zoom to a region with active storms.
- The status line reads `Valid <timestamp>`.
- Selecting `GOES East Full Disk IR` replaces it with a satellite image — this one always has visible data, so use it to confirm the path works regardless of weather.
- Selecting `Lightning Heatmap` draws sparse global blobs. Zoom out to zoom 2 to see them.
- Country labels stay drawn on top of the weather.

- [ ] **Step 6: Verify the signature reaches the tile requests**

In the browser Network panel, filter on `tms`. Click any tile request.

Expected: the request URL matches
`https://api.velocityweather.com/v1/<key>/tms/1.0.0/C39-0x0302-0+Standard-Mercator+<timestamp>/<z>/<x>/<y>.png?ts=<digits>&sig=<...>%3D`
and returns `200` with content type `image/png`.

The `ts` and `sig` are appended by `transformRequest`, so they must **not** appear in the source definition. Confirm:

```js
map.getSource('wx').tiles[0]
```

Expected: the template string ends in `/{z}/{x}/{y}.png` with no `ts` or `sig`. This is the property that keeps the map alive past 15 minutes.

- [ ] **Step 7: Verify Refresh**

Click `Refresh`.

Expected: the status line briefly shows `Loading …`, then `Valid <timestamp>`. For radar the timestamp advances every couple of minutes, so a second click after a wait shows a newer time.

- [ ] **Step 8: Commit**

```bash
git add interactive-map/baron.js interactive-map/app.js
git commit -m "Draw Baron products as TMS tiles, signed per request"
```

---

### Task 4: WMS toggle

Produces the TMS/WMS switch. The same product renders through either protocol.

**Files:**
- Modify: `interactive-map/baron.js`
- Modify: `interactive-map/app.js`

**Interfaces:**
- Consumes: `API_BASE`, `credentials` (module-private), `tmsTemplate` from Task 3. `showProduct()`, `el`, `setStatus` from Task 3's `app.js`.
- Produces:
  - `baron.js`: `wmsTemplate(product, config, time)` → unsigned URL template string containing MapLibre's `{bbox-epsg-3857}` placeholder
  - `app.js`: module-level `protocol` variable holding `'tms'` or `'wms'`; `buildProtocolToggle()`

- [ ] **Step 1: Add `wmsTemplate` to `interactive-map/baron.js`**

Append after `tmsTemplate`:

```js
/**
 * WMS GetMap template.
 *
 * Three things this endpoint insists on, all verified against the live service:
 *
 *   - LAYERS is the instance timestamp, NOT the product code. GetCapabilities
 *     lists each available instance time as a nested layer name. Passing the
 *     product code returns 400 InvalidParameter.
 *   - VERSION must be 1.3.0. Version 1.1.1 is rejected outright.
 *   - CRS=EPSG:3857 is the only projection offered. EPSG:4326 is rejected.
 *
 * {bbox-epsg-3857} is a MapLibre placeholder, filled in per tile by MapLibre.
 * The instance time is substituted here.
 *
 * Returned unsigned, like tmsTemplate.
 */
export function wmsTemplate(product, config, time) {
  const query = [
    'service=WMS',
    'version=1.3.0',
    'request=GetMap',
    'crs=EPSG:3857',
    'bbox={bbox-epsg-3857}',
    'width=256',
    'height=256',
    'format=image/png',
    'transparent=true',
    `layers=${encodeURIComponent(time)}`
  ].join('&')
  return `${API_BASE}/${credentials.key}/wms/${product}/${config}?${query}`
}
```

- [ ] **Step 2: Track the selected protocol in `interactive-map/app.js`**

Add `wmsTemplate` to the import list from `./baron.js`.

Add below `let selected = PRODUCTS[0]`:

```js
let protocol = 'tms'   // 'tms' or 'wms'
```

- [ ] **Step 3: Branch the source on protocol**

In `showProduct`, replace the `map.addSource('wx', {...})` call with:

```js
  const source = {
    type: 'raster',
    tiles: [
      protocol === 'tms'
        ? tmsTemplate(selected.code, selected.config, time)
        : wmsTemplate(selected.code, selected.config, time)
    ],
    tileSize: 256,
    attribution: '&copy; Baron Weather'
  }
  // Baron TMS rows run bottom-up. WMS is addressed by bounding box, so it uses
  // the default scheme.
  if (protocol === 'tms') source.scheme = 'tms'

  map.addSource('wx', source)
```

- [ ] **Step 4: Add the toggle**

Insert after `buildProducts`:

```js
/** Wire the TMS/WMS buttons. Switching redraws the selected product. */
function buildProtocolToggle() {
  const buttons = document.querySelectorAll('#protocol button')
  for (const button of buttons) {
    button.addEventListener('click', () => {
      protocol = button.dataset.protocol
      for (const other of buttons) {
        other.classList.toggle('on', other === button)
      }
      showProduct()
    })
  }
}
```

Call it in `start`, right after `buildProducts()`:

```js
  buildProducts()
  buildProtocolToggle()
```

- [ ] **Step 5: Verify both protocols for all three products**

Reload the page. For each of the three products, click `TMS`, then `WMS`.

Expected: all six combinations draw imagery. The WMS render of a product looks the same as its TMS render, possibly with slightly different tile edges.

- [ ] **Step 6: Verify the WMS request shape**

In the Network panel, filter on `wms`. Click any request.

Expected: the query string contains `request=GetMap`, `version=1.3.0`, `crs=EPSG:3857`, `layers=2026-...%3A...%3A...Z` (the instance timestamp, percent-encoded), a real numeric `bbox`, and the appended `ts` and `sig`. Status `200`, content type `image/png`.

Confirm the failure the comment warns about is real. Rather than hand-building a signature,
copy a working URL straight out of the browser: right-click any successful `wms` request in the
Network panel and choose **Copy → Copy as cURL**. Run it once as-is to confirm it returns an
image, then edit the `layers=` value to the product code `C39-0x0302-0` and run it again.

Expected: the unedited command succeeds; the edited one returns
`400 InvalidParameter`. Only the instance timestamp is accepted in `layers`.

Do this within 15 minutes of copying the URL, or the signature it carries will have expired and
you will get a `403 Expired timestamp` instead — which is itself a live demonstration of why
`transformRequest` exists.

- [ ] **Step 7: Commit**

```bash
git add interactive-map/baron.js interactive-map/app.js
git commit -m "Add a WMS delivery toggle alongside TMS"
```

---

### Task 5: Legend

Produces a legend block that degrades honestly across the three products, which publish three different qualities of legend document.

**Files:**
- Modify: `interactive-map/baron.js`
- Modify: `interactive-map/app.js`

**Interfaces:**
- Consumes: `selected`, `el`, `showProduct()` from Task 4.
- Produces:
  - `baron.js`: `legendUrl(product, config)` → public URL string, unsigned
  - `app.js`: `showLegend()` → `Promise<void>`

- [ ] **Step 1: Add `legendUrl` to `interactive-map/baron.js`**

Add near the top, below `API_BASE`:

```js
const LEGEND_BASE = 'https://static.velocityweather.com/legends'
```

Append at the end of the file:

```js
/**
 * The legend document for a product.
 *
 * Public, and takes no signature — note this URL is not under API_BASE, so
 * transformRequest leaves it alone.
 *
 * Shape: {"palettes": [{"entries": [{"color": "#rrggbbaa", "value": "5 dBZ"}]}]}
 *
 * This is a different document from the geotiff_legend.json that geotiff_fetch
 * uses.
 */
export function legendUrl(product, config) {
  return `${LEGEND_BASE}/${product}/${config}/legend.json`
}
```

- [ ] **Step 2: Add `showLegend` to `interactive-map/app.js`**

Add `legendUrl` to the import list. Insert `showLegend` before `showProduct`:

```js
/**
 * Draw the legend for the selected product.
 *
 * Legend quality varies by product, so this degrades in three steps:
 *   - real labels        → gradient bar with first, middle, and last label
 *   - every value is
 *     the string
 *     "Undefined"        → gradient bar, no labels
 *   - no legend at all   → a plain note (the CDN answers 403 for some products)
 */
async function showLegend() {
  const bar = el('legend-bar')
  const labels = el('legend-labels')
  const note = el('legend-note')

  bar.style.display = 'none'
  labels.replaceChildren()
  note.textContent = ''

  let entries
  try {
    const response = await fetch(legendUrl(selected.code, selected.config))
    if (!response.ok) throw new Error('no legend')
    entries = (await response.json()).palettes[0].entries
  } catch {
    note.textContent = 'No legend published for this product.'
    return
  }

  // Colours are #rrggbbaa, which CSS takes as-is. One evenly spaced stop per
  // entry. A single-entry palette would divide by zero, so treat it as a fill.
  bar.style.background = entries.length === 1
    ? entries[0].color
    : `linear-gradient(to right, ${entries
        .map((e, i) => `${e.color} ${((i / (entries.length - 1)) * 100).toFixed(2)}%`)
        .join(', ')})`
  bar.style.display = 'block'

  // Some palettes label every entry "Undefined" — a ramp with no meaning. Show
  // labels only where real ones exist, and do not pad a short row.
  const real = entries.filter((e) => e.value !== 'Undefined')
  if (!real.length) return
  const picks = real.length < 3
    ? real
    : [real[0], real[Math.floor(real.length / 2)], real[real.length - 1]]

  labels.replaceChildren(
    ...picks.map((entry) => {
      const span = document.createElement('span')
      span.textContent = entry.value
      return span
    })
  )
}
```

- [ ] **Step 3: Call it from `showProduct`**

Replace the last line of `showProduct`:

```js
  setStatus(`Valid ${time}`)
  showLegend()
```

- [ ] **Step 4: Verify all three degradation cases**

Reload the page and select each product in turn.

Expected:
- `Max Reflectivity Composite` — a green-to-red gradient bar with three labels below it: `5 dBZ`, roughly `35 dBZ`, and `70 dBZ`.
- `GOES East Full Disk IR` — a gradient bar with **no** labels beneath it. Its 254 entries are all labelled `Undefined`.
- `Lightning Heatmap` — no bar, and the text `No legend published for this product.`

- [ ] **Step 5: Confirm the legend request is unsigned**

In the Network panel, filter on `legend.json`.

Expected: two successful requests to `static.velocityweather.com` with no `ts` or `sig` in the query, and one `403` for `lightning-heatmap-global`. The 403 is expected and is handled — it must not appear as an unhandled error.

- [ ] **Step 6: Commit**

```bash
git add interactive-map/baron.js interactive-map/app.js
git commit -m "Show a product legend, degrading when labels or documents are missing"
```

---

### Task 6: README and full verification

Produces the documentation and runs the spec's complete checklist, including the 20-minute test that the signature design exists to pass.

**Files:**
- Create: `interactive-map/README.md`

**Interfaces:**
- Consumes: the finished app from Task 5.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Create `interactive-map/README.md`**

```markdown
# Baron Interactive Map

A very basic map that shows three [Baron Weather](https://www.baronweather.com/) raster
products, delivered through either TMS or WMS. Pick a product, flip the delivery toggle, and
compare the two request styles against the same data.

One static page, no build step, no dependencies to install.

## Setup

```bash
cp env.example .env      # then fill in your key and secret
python3 -m http.server 8000
```

Open <http://localhost:8000/>.

Use `localhost`, not a LAN address. Signing uses `crypto.subtle`, which browsers expose only in
a secure context. `http://localhost` and `http://127.0.0.1` qualify; `http://192.168.1.20:8000`
does not, and the page will tell you so rather than fail obscurely.

## Security

**This is a local demonstration. Do not deploy it as it stands.**

The key and the secret are fetched into the browser, so anyone with the page open can read
them. `http.server` serves the whole folder, so `.env` itself is readable by anything that can
reach the port. A public deployment needs a server that holds the secret and signs on behalf
of the page.

## Files

| File | Purpose |
|---|---|
| `index.html` | Panel markup, styles, MapLibre tags |
| `baron.js` | Credentials, signing, instance lookup, URL building. Knows nothing about MapLibre |
| `app.js` | Products, map, panel, legend. Knows nothing about signing |

## Products

| Label | Code | Config |
|---|---|---|
| Max Reflectivity Composite | `C39-0x0302-0` | `Standard-Mercator` |
| Lightning Heatmap | `lightning-heatmap-global` | `Standard-Mercator` |
| GOES East Full Disk IR | `goes-east-fulldisk-hires-ir` | `Standard-Mercator` |

Availability depends on what your key is entitled to. A key without one of these gets a
message in the panel rather than a blank map.

## API notes

The reusable part of this sample. Each item was verified against the live service.

### Signing

```
ts      = floor(Date.now() / 1000)
to_sign = "<key>:<ts>"
sig     = base64(HMAC_SHA1(secret, to_sign)), then "+" → "-", "/" → "_", "=" → "%3D"
query   = "ts=<ts>&sig=<sig>"
```

**A signature is valid for about ±15 minutes.** At 20 minutes old the API returns
`403 {"status":403,"message":"Expired timestamp","code":800311}`.

That is why this app never puts a signature in a tile URL. It caches one, renews it every 5
minutes, and appends it per request through MapLibre's `transformRequest` hook. A signature
baked into a source URL works at first and then the map quietly goes blank while panning.

### Newest instance

```
GET /v1/{key}/meta/tiles/product-instances/{product}/{config}.json?page_size=1&{sig}
→ [{"time":"2026-08-11T16:20:38Z","created":"2026-08-11T16:21:59Z"}]
```

Ordered newest first. Observational products live under `/meta/tiles/`; forecast products live
under `/meta/maps/`, which this demo does not use.

### TMS

```
/v1/{key}/tms/1.0.0/{product}+{config}+{time}/{z}/{x}/{y}.png
```

The instance time is part of the path and is required — omitting it returns 404. Rows run
bottom-up, so a MapLibre raster source needs `scheme: 'tms'`.

### WMS

```
/v1/{key}/wms/{product}/{config}
  ?service=WMS&version=1.3.0&request=GetMap
  &crs=EPSG:3857&bbox={minx},{miny},{maxx},{maxy}
  &width=256&height=256&format=image/png&transparent=true
  &layers={instance time}
```

Three traps:

- **`LAYERS` is the instance timestamp, not the product code.** `GetCapabilities` lists each
  instance time as a nested layer name. The product code returns `400 InvalidParameter`.
- **`VERSION` must be `1.3.0`.** `1.1.1` returns
  `Unsupported value for parameter "VERSION": must be "1.3.0"`.
- **`CRS=EPSG:3857` is the only projection offered.**

`GetCapabilities` also reports `LayerLimit 1`, `MaxWidth 3000`, `MaxHeight 3000`.

### Legends

```
https://static.velocityweather.com/legends/{product}/{config}/legend.json
→ {"palettes": [{"entries": [{"color": "#01f3f7ff", "value": "0.5 dBZ"}]}]}
```

Public — no signature. Colours are `#rrggbbaa`, which CSS accepts directly. This is a
different document from the `geotiff_legend.json` that `../geotiff_fetch` uses.

Quality varies, and a client has to cope with all three cases:

| Product | Legend |
|---|---|
| `C39-0x0302-0` | About 19 entries, all labelled, `5 dBZ` to `70 dBZ` |
| `goes-east-fulldisk-hires-ir` | 254 entries, every label is the string `Undefined` |
| `lightning-heatmap-global` | None. The CDN returns `403 AccessDenied` |

## Verification

1. Copy `env.example` to `.env` and fill in a valid key and secret.
2. Run `python3 -m http.server 8000`. Open <http://localhost:8000/>.
3. Each of the three products draws tiles in TMS mode.
4. The WMS toggle redraws each product. The network panel shows `request=GetMap`.
5. The valid time appears and matches the newest instance in the metadata response.
6. Max Reflectivity shows a labelled legend. GOES East shows an unlabelled ramp. Lightning
   Heatmap shows `No legend published for this product.`
7. Refresh re-resolves the instance and the map redraws.
8. Leave the page open for 20 minutes, then pan. Tiles still load. This is the check that
   proves per-request signing works.
9. Rename `.env` and reload. The panel shows the setup message and the basemap still loads.

Step 8 is the one that catches the mistake this design exists to avoid.

## Limitations

The basemap is MapLibre's demo style — country outlines only, no state borders and no cities,
so placing radar geographically is hard. Swap the `style` URL in `app.js` for something with
more detail if that matters.

One weather layer at a time. No animation, no instance history, no point queries, and no
automatic polling for new instances — the Refresh button covers that.
```

- [ ] **Step 2: Run checklist steps 1 to 7**

Work through the README's verification list, items 1 through 7. Every one must pass. Fix anything that does not before continuing.

- [ ] **Step 3: Run the 20-minute signature check**

This is the load-bearing verification and it cannot be rushed.

Load the page, select `GOES East Full Disk IR` in TMS mode, and leave it alone for a full 20 minutes. Then pan and zoom into an area not yet loaded.

Expected: new tiles load normally. No `403` in the Network panel.

If tiles fail, the signature is being baked into the source URL instead of appended per request. Re-check that `map.getSource('wx').tiles[0]` has no `ts` or `sig`, and that `transformRequest` is present on the map options.

- [ ] **Step 4: Run checklist step 9**

```bash
cd interactive-map && mv .env .env.hidden
```

Reload.

Expected: basemap draws, panel shows `Create interactive-map/.env from env.example` in red, no unhandled console errors.

```bash
cd interactive-map && mv .env.hidden .env
```

- [ ] **Step 5: Confirm no credentials are staged**

```bash
git status --short interactive-map/
```

Expected: `README.md` shows as new. `.env` must **not** appear. If it does, stop and fix the ignore rule before committing.

- [ ] **Step 6: Commit**

```bash
git add interactive-map/README.md
git commit -m "Document the interactive map and the API behaviour it relies on"
```

---

## Self-review notes

Spec coverage, section by section:

| Spec section | Task |
|---|---|
| 2.1 Signature, ±15 minute window | 2 (compute), 3 (per-request hook), 6 (20-minute check) |
| 2.2 Newest instance | 2 |
| 2.3 TMS | 3 |
| 2.4 WMS, three traps | 4 |
| 2.5 Legend, three qualities | 5 |
| 3 Products | 2 (list), 3 (all three draw) |
| 4 Files | 1, 2, 6 |
| 4.1 `baron.js` interface | 2, 3, 4, 5 |
| 5 Signing at request time | 3 |
| 6 Layer handling, single path | 3 (path), 4 (protocol branch) |
| 6.1 Map setup | 1 |
| 7 Legend rendering and degradation | 5 |
| 8 Error handling | 2 (credentials, secure context), 3 (tile errors), 5 (legend 403), 6 (checks) |
| 9 README contents | 6 |
| 10 Verification checklist | 6 |

Two spec details deliberately not implemented, both stated as out of scope in section 1: no instance polling timer, and no `/meta/maps/` fallback.

Names are consistent across tasks: `showProduct`, `showLegend`, `buildProducts`, `buildProtocolToggle`, `setStatus`, `createMap`, `el`, `signQuery`, `refreshSignature`, `startSigning`, `loadCredentials`, `parseEnv`, `latestInstance`, `tmsTemplate`, `wmsTemplate`, `legendUrl`. Source and layer ids are both `wx`. The insertion anchor is `LABEL_LAYER` = `geolines-label`.
