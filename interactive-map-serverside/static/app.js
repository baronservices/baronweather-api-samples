// The browser half of the server-side map.
//
// Compare ../../interactive-map/app.js, which has a baron.js beside it holding
// credentials, HMAC signing, a signature cache, and a secure-context check.
// None of that is here. Every URL below points at this app's own server, which
// signs and fetches on our behalf, so this file has no idea what a signature is.
//
// What did NOT move to the server is the WMS geometry near the bottom. It
// exists to serve MapLibre's camera, so it belongs beside the camera.

const SOURCE_ID = 'wx'
const LAYER_ID = 'wx'

// The first symbol layer in MapLibre's demo style. Inserting below it keeps
// country labels readable above the weather.
const LABEL_ANCHOR = 'geolines-label'

const panel = {
  products: document.getElementById('products'),
  protocol: document.getElementById('protocol'),
  refresh: document.getElementById('refresh'),
  status: document.getElementById('status'),
}

// Everything the redraw path needs. `time` is remembered so a map move can
// rebuild a WMS URL without a second instance lookup.
const state = {
  products: [],
  product: null,
  config: null,
  protocol: 'tms',
  time: null,
  // Until /api/config returns there is nothing to draw. Without this flag an
  // early click replaces the setup message with a null dereference from
  // somewhere deeper in the stack.
  ready: false,
}

let map = null

// Bumped by every showProduct() call. A call that finds the counter has
// moved on while it was awaiting knows a newer redraw superseded it, and
// returns without touching shared state. Without this, two overlapping
// calls both reach addSource, the slower one throws on the duplicate
// source ID, and its rejection overwrites the correct status with an
// error while state.time is left holding the wrong product's timestamp.
let generation = 0

/** Write the panel's message line. */
function setStatus(text, isError = false) {
  panel.status.textContent = text
  panel.status.classList.toggle('error', isError)
}

/**
 * Fetch JSON from our own server, raising the server's `detail` text.
 *
 * The server writes messages meant for a person to read — it names the three
 * causes of a 403, for instance — so showing `detail` verbatim beats inventing
 * a client-side phrasing that throws that detail away.
 */
async function getJson(url) {
  const response = await fetch(url)
  if (!response.ok) {
    let detail = `Request failed with ${response.status}`
    try {
      const body = await response.json()
      if (body.detail) detail = body.detail
    } catch {
      // A non-JSON error body leaves the status-code message in place.
    }
    const error = new Error(detail)
    error.status = response.status
    throw error
  }
  return response.json()
}

// --- Startup ----------------------------------------------------------------

async function start() {
  let config
  try {
    config = await getJson('/api/config')
  } catch (error) {
    // The same process serves this page and answers /api/config, so a failure
    // here almost always means the server died rather than a bad URL.
    setStatus(`Cannot reach the server: ${error.message}`, true)
    return
  }

  state.products = config.products
  buildProductList(config.products)
  createMap(config.center, config.zoom)

  if (!config.credentials) {
    // The basemap still loads. Only the weather layer is unavailable.
    setStatus(config.setupMessage, true)
    return
  }

  state.ready = true
  state.product = config.products[0].product
  state.config = config.products[0].config
  redraw()
}

function buildProductList(products) {
  panel.products.innerHTML = ''
  products.forEach((entry, index) => {
    const label = document.createElement('label')
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'product'
    radio.value = entry.product
    radio.checked = index === 0
    radio.addEventListener('change', () => {
      state.product = entry.product
      state.config = entry.config
      redraw()
    })
    label.append(radio, ` ${entry.label}`)
    panel.products.append(label)
  })
}

function createMap(center, zoom) {
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://demotiles.maplibre.org/style.json',
    center,
    zoom,
  })

  // One persistent listener, attached once, here, because this is the only
  // place `map` is known to exist. It no-ops unless WMS is active, so it never
  // needs attaching and detaching — and a listener that is never removed
  // cannot leak.
  map.on('moveend', () => {
    if (state.protocol !== 'wms') return

    const source = map.getSource(SOURCE_ID)
    if (!source) return

    const view = viewGeometry()
    if (!view) return

    // updateImage aborts any in-flight request and applies the new coordinates
    // only once the new image has loaded, so the URL and the corners always
    // commit together. Until it lands the previous image stays pinned to its
    // own corners: it scales and blurs on zoom, and leaves the newly revealed
    // edge blank on pan, rather than stretching to fill the new view.
    source.updateImage({ url: wmsUrl(view), coordinates: view.coordinates })
  })
}

// --- The single redraw path -------------------------------------------------

/**
 * Rebuild the weather layer. Product change, protocol change, and Refresh all
 * come through here, so there is one path to reason about rather than three.
 */
async function showProduct() {
  if (!state.ready) return

  const mine = ++generation

  // Removed first, and the moveend handler above depends on the source being
  // absent for the whole of the await below.
  removeWeatherLayer()
  setStatus('Loading…')

  const { time } = await getJson(`/api/instance/${state.product}/${state.config}`)

  // A newer redraw started while we were waiting. Adding a source now
  // would throw on the duplicate id and clobber the newer call's status.
  if (mine !== generation) return

  state.time = time

  if (state.protocol === 'tms') {
    addTmsSource()
  } else {
    addWmsSource()
  }

  map.addLayer(
    {
      id: LAYER_ID,
      type: 'raster',
      source: SOURCE_ID,
      // A raster layer renders both source types. Zero fade stops the image
      // flashing when WMS replaces it on a move.
      paint: { 'raster-fade-duration': 0 },
    },
    map.getLayer(LABEL_ANCHOR) ? LABEL_ANCHOR : undefined
  )

  setStatus(`Valid ${time}`)
}

/**
 * Every entry point calls showProduct through here.
 *
 * Without the catch, a throw after the layer is removed leaves the panel
 * reading "Loading…" with the real reason only in the console.
 */
function redraw() {
  showProduct().catch((error) => setStatus(error.message, true))
}

function removeWeatherLayer() {
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID)
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID)
}

function addTmsSource() {
  map.addSource(SOURCE_ID, {
    type: 'raster',
    tiles: [
      `/api/tms/${state.product}/${state.config}/${encodeURIComponent(state.time)}/{z}/{x}/{y}.png`,
    ],
    tileSize: 256,
    // Baron serves TMS row order, bottom-up. The proxy passes z/x/y through
    // untouched, so this is still required even though the URL is local.
    scheme: 'tms',
    attribution: '&copy; Baron Weather',
  })
}

// --- WMS mode ---------------------------------------------------------------
//
// WMS serves one image for one arbitrary view. That is the contrast this app
// exists to show: TMS serves fixed 256px tiles at fixed zoom levels. A tiled
// source re-requests tiles for a new view by itself; a single image does not,
// which is why createMap installs a moveend handler.

// Web Mercator is undefined beyond this latitude.
const MAX_LATITUDE = 85.05112878

// The service rejects anything larger with 400 InvalidParameter.
const MAX_DIMENSION = 3000

/**
 * The current view as a bbox and as its four corners, from ONE clamp.
 *
 * Both outputs come from the same four numbers, and that is the entire point
 * of this function. `interactive-map` shipped a bug where the bbox was clamped
 * and the corners were not: getBounds() runs past ±180 whenever the viewport
 * is wider than the world, and at any zoom near the antimeridian, because
 * MapLibre leaves longitude unconstrained by default. The image then covered
 * one rectangle and was placed on another, stretching the overlay 1.4× at low
 * zoom and 1.2× near the antimeridian.
 *
 * Keep exactly one clamp site. Two is what caused it.
 *
 * Returns null when the view has no area, so the caller can skip the request
 * rather than send a malformed URL.
 */
function viewGeometry() {
  const bounds = map.getBounds()

  const west = Math.max(bounds.getWest(), -180)
  const east = Math.min(bounds.getEast(), 180)
  const south = Math.max(bounds.getSouth(), -MAX_LATITUDE)
  const north = Math.min(bounds.getNorth(), MAX_LATITUDE)

  const [minX, minY] = toMercator(west, south)
  const [maxX, maxY] = toMercator(east, north)

  const spanX = maxX - minX
  const spanY = maxY - minY
  if (spanX <= 0 || spanY <= 0) return null

  // Height comes from the BBOX aspect, never the canvas aspect, so rotating
  // the camera cannot distort the image. A bbox whose aspect disagrees with
  // width and height still returns HTTP 200 and silently distorts, so there is
  // no error to catch — it has to be prevented here.
  const width = Math.min(Math.round(map.getCanvas().clientWidth), MAX_DIMENSION)
  const height = Math.min(Math.round(width * (spanY / spanX)), MAX_DIMENSION)
  if (width < 1 || height < 1) return null

  return {
    bbox: `${minX},${minY},${maxX},${maxY}`,
    width,
    height,
    // The same clamped corners the bbox was built from, in the order an image
    // source expects: top-left, top-right, bottom-right, bottom-left.
    coordinates: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
  }
}

/** Longitude and latitude to EPSG:3857 metres. */
function toMercator(lng, lat) {
  const RADIUS = 6378137
  const x = (RADIUS * lng * Math.PI) / 180
  const y = RADIUS * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
  return [x, y]
}

/** The GetMap URL for a given view. */
function wmsUrl(view) {
  const query = new URLSearchParams({
    time: state.time,
    bbox: view.bbox,
    width: view.width,
    height: view.height,
  })
  return `/api/wms/${state.product}/${state.config}?${query}`
}

function addWmsSource() {
  const view = viewGeometry()
  if (!view) throw new Error('The map view has no area to request.')

  // An image source accepts only url and coordinates. addSource rejects an
  // attribution property outright, so WMS mode carries none.
  map.addSource(SOURCE_ID, {
    type: 'image',
    url: wmsUrl(view),
    coordinates: view.coordinates,
  })
}

// --- Wiring -----------------------------------------------------------------

panel.protocol.addEventListener('click', (event) => {
  const button = event.target.closest('button')
  if (!button) return

  state.protocol = button.dataset.protocol
  for (const other of panel.protocol.querySelectorAll('button')) {
    other.classList.toggle('on', other === button)
  }
  // scheme cannot be changed after a source is created, and the two protocols
  // need different source types anyway, so a switch always re-adds the source.
  // One path stays simpler than two.
  redraw()
})

panel.refresh.addEventListener('click', redraw)

start()
