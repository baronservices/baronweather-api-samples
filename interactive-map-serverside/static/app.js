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

// Bumped by every redraw() call. A call that finds the counter has moved on
// while it was awaiting knows a newer redraw superseded it, and returns
// without touching shared state. Without this, two overlapping calls both
// reach addSource, the slower one throws on the duplicate source ID, and its
// rejection overwrites the correct status with an error while state.time is
// left holding the wrong product's timestamp.
let generation = 0

// Set once per redraw and checked by the map 'error' handler in createMap(),
// so a burst of failed tile requests reports once instead of repainting the
// panel on every single 403.
let tileErrorReported = false

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

  // createMap() above already kicked off a style fetch that runs concurrently
  // with everything this function just awaited. Which one finishes first is a
  // race with no guaranteed winner — a warm connection to this app's own
  // server can beat a slow or blocked style CDN, or lose to it — so check
  // isStyleLoaded() rather than assume redraw() always arrives second.
  // Guessing wrong throws "Style is not done loading" from addSource on
  // whichever runs the race the other way.
  if (map.isStyleLoaded()) redraw()
  else map.on('load', redraw)
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

  // The sibling registers this same handler to refresh a browser-computed
  // signature before it expires. Server-side signing removed that need — the
  // server signs fresh on every request — but it did not remove the need to
  // tell the user something failed. A key entitled to metadata but not to
  // tile rendering makes /api/instance succeed and every tile come back 403:
  // showProduct() finishes normally and the panel reads "Valid <time>" in
  // plain text over a map with no weather on it. The proxy sends empty error
  // bodies on purpose, so the network panel does not explain this either.
  map.on('error', (event) => {
    console.error('Map error:', event.error && event.error.message)

    if (tileErrorReported) return
    tileErrorReported = true

    // A more specific error already on screen — a failed instance lookup, the
    // setup message — is more useful than this generic one. Leave it alone.
    if (panel.status.classList.contains('error')) return

    setStatus('Tiles failed to load. The key may not be entitled to this product.', true)
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

    // Refresh the coverage note here too, not only in showProduct().
    //
    // A user meets the antimeridian by PANNING into it, which fires this
    // handler and never touches the status line. Computing the note only at
    // redraw time left it silent in the one case that actually happens: the
    // note appeared only if you switched product while already straddling.
    //
    // Guarded on the panel not currently showing an error, so a move cannot
    // overwrite a real failure with a cheerful valid-time line.
    if (state.time && !panel.status.classList.contains('error')) {
      setStatus(`Valid ${state.time}${view.crossesAntimeridian ? ANTIMERIDIAN_NOTE : ''}`)
    }
  })
}

// Shown whenever a WMS view is clamped at the antimeridian. Defined once
// because two places have to be able to raise it: a redraw that happens to
// start while straddling, and — far more commonly — a pan that crosses the
// seam without redrawing anything.
const ANTIMERIDIAN_NOTE =
  ' — the view crosses the antimeridian; one WMS image cannot cover both sides, so part of the view has no overlay. TMS mode shows it.'

// --- The single redraw path -------------------------------------------------

/**
 * Rebuild the weather layer. Product change, protocol change, and Refresh all
 * come through here, so there is one path to reason about rather than three.
 */
async function showProduct(mine) {
  if (!state.ready) return

  // Removed first, and the moveend handler above depends on the source being
  // absent for the whole of the await below.
  removeWeatherLayer()
  // Clearing here, not only inside showLegend(), means a failure anywhere in
  // this function — including the instance lookup below, which never reaches
  // showLegend() at all — still leaves the panel without a stale colour scale
  // from whatever product was showing before.
  clearLegend()
  // Reset so this redraw's own tile failures, if any, still get one report
  // from the map 'error' handler instead of being silenced by a previous
  // product's failure.
  tileErrorReported = false
  setStatus('Loading…')

  const { time } = await getJson(`/api/instance/${state.product}/${state.config}`)

  // A newer redraw started while we were waiting. Adding a source now
  // would throw on the duplicate id and clobber the newer call's status.
  if (mine !== generation) return

  state.time = time

  // Empty unless the WMS branch below finds the view clamped past the
  // antimeridian, in which case it explains the resulting gap instead of
  // leaving it silent.
  let antimeridianNote = ''

  if (state.protocol === 'tms') {
    addTmsSource()
  } else if (addWmsSource()) {
    // A single WMS GetMap is one rectangle in EPSG:3857 and genuinely cannot
    // cross the antimeridian, unlike a tiled TMS source, which requests each
    // tile independently and has no such seam. viewGeometry()'s clamp keeps
    // the bbox and the placed image honestly matched to each other, but that
    // also means the sliver of the view past +/-180 is quietly uncovered.
    // Say so, rather than leave a gap with no weather and no explanation.
    antimeridianNote = ANTIMERIDIAN_NOTE
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

  setStatus(`Valid ${time}${antimeridianNote}`)
  await showLegend(mine)
}

/**
 * Every entry point calls showProduct through here.
 *
 * Without the catch, a throw after the layer is removed leaves the panel
 * reading "Loading…" with the real reason only in the console.
 */
function redraw() {
  // One ticket per redraw, taken here rather than inside showProduct, so
  // that the rejection path below can check it too. Patching each await
  // site individually missed this one twice: a stale REJECTION overwrites
  // the newer redraw's status just as surely as a stale success would.
  const mine = ++generation
  showProduct(mine).catch((error) => {
    if (mine !== generation) return
    setStatus(error.message, true)
  })
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
  const rawWest = bounds.getWest()
  const rawEast = bounds.getEast()

  const west = Math.max(rawWest, -180)
  const east = Math.min(rawEast, 180)
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
    // True when the clamp above actually discarded something: the raw bounds
    // spilled past +/-180 while the view still spans less than the whole
    // world. A viewport wider than the world also spills past +/-180, but for
    // an unrelated reason (zoomed out, not straddling the seam), so it is
    // excluded by the span check rather than reported as this case.
    crossesAntimeridian: (rawEast > 180 || rawWest < -180) && rawEast - rawWest < 360,
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

  return view.crossesAntimeridian
}

// --- Legend -----------------------------------------------------------------
//
// Legend quality varies by product and a client has to cope with all of it:
// Max Reflectivity publishes 15 labelled entries, GOES East publishes 254 whose
// every label is the string "Undefined", and Lightning Heatmap publishes none
// at all. "No legend" is a normal, permanent state — not an error.

const legend = {
  bar: document.getElementById('legend-bar'),
  labels: document.getElementById('legend-labels'),
  note: document.getElementById('legend-note'),
}

/** The literal label the API uses for an entry with no meaningful value. */
const UNDEFINED_LABEL = 'Undefined'

const NO_LEGEND_TEXT = 'No legend published for this product.'

async function showLegend(mine) {
  // showProduct() already cleared the legend before the instance lookup, so
  // that covers failures that happen before this function is ever reached.
  // Clearing again here keeps this function correct standing on its own,
  // rather than relying on a caller to have done it first.
  clearLegend()

  let data
  try {
    data = await getJson(`/api/legend/${state.product}/${state.config}`)
  } catch (error) {
    // Same reason as above: a superseded request must not overwrite the
    // newer product's legend with this one's "no legend" text.
    if (mine !== generation) return

    legend.note.textContent = NO_LEGEND_TEXT
    // A 404 is the normal answer for some products, so it stays silent. Any
    // other failure is a real fault and must not hide behind that silence.
    if (error.status !== 404) {
      console.warn(`Legend request failed: ${error.message}`)
    }
    return
  }

  // A newer redraw finished while this legend was in flight. Drawing now
  // would paint this product's scale over the one the map is actually
  // showing, which is worse than showing nothing.
  if (mine !== generation) return

  const entries = data?.palettes?.[0]?.entries
  if (!entries || entries.length === 0) {
    legend.note.textContent = NO_LEGEND_TEXT
    console.warn('Legend response carried no palette entries.')
    return
  }

  drawGradient(entries)
  drawLabels(entries)
}

function clearLegend() {
  legend.bar.style.display = 'none'
  legend.bar.style.background = ''
  legend.labels.innerHTML = ''
  legend.note.textContent = ''
}

function drawGradient(entries) {
  // Colours arrive as #rrggbbaa, which CSS accepts directly.
  if (entries.length === 1) {
    // One entry would divide by zero below and produce NaN stops.
    legend.bar.style.background = entries[0].color
  } else {
    const stops = entries.map(
      (entry, index) =>
        `${entry.color} ${((index / (entries.length - 1)) * 100).toFixed(2)}%`
    )
    legend.bar.style.background = `linear-gradient(to right, ${stops.join(', ')})`
  }
  legend.bar.style.display = 'block'
}

function drawLabels(entries) {
  const real = entries
    .map((entry) => entry.value)
    .filter((value) => value && value !== UNDEFINED_LABEL)

  // GOES East publishes 254 entries whose every label is "Undefined". Showing
  // the ramp with no labels is more honest than printing "Undefined" three times.
  if (real.length === 0) return

  const picks =
    real.length < 3
      ? real
      : [real[0], real[Math.floor(real.length / 2)], real[real.length - 1]]

  for (const text of picks) {
    const span = document.createElement('span')
    span.textContent = text
    legend.labels.append(span)
  }
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

start().catch((error) => {
  // start()'s own try/catch covers only the /api/config fetch. createMap()
  // runs after that and can fail two real ways: synchronously, with
  // "ReferenceError: maplibregl is not defined" if the MapLibre script never
  // loaded, or by throwing "Failed to initialize WebGL" out of MapLibre's
  // painter setup if the browser or GPU has no WebGL. Either way, without
  // this catch the rejection is unhandled and the panel is stuck on the grey
  // "Starting…" placeholder forever, which reads as still-in-progress rather
  // than failed.
  setStatus(
    `Map failed to start: ${error.message}. The MapLibre script may not have loaded, or this browser may not support WebGL.`,
    true
  )
})
