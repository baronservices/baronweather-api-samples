/**
 * app.js — the map and the panel.
 *
 * This file knows nothing about HMAC signing. Everything that talks to the
 * Baron Weather API lives in baron.js.
 */

import {
  API_BASE,
  loadCredentials,
  startSigning,
  signQuery,
  refreshSignature,
  latestInstance,
  tmsTemplate,
  wmsImageUrl,
  legendUrl
} from './baron.js'

// The service rejects WIDTH or HEIGHT above this.
const WMS_MAX_PIXELS = 3000

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
let protocol = 'tms'   // 'tms' or 'wms'
let ready = false   // credentials loaded and the first signature computed
let currentTime = null   // the instance time showProduct() last resolved

/** Shorthand for document.getElementById. */
const el = (id) => document.getElementById(id)

/** Write a message into the panel. Errors are styled differently. */
function setStatus(text, isError = false) {
  el('status').textContent = text
  el('status').classList.toggle('error', isError)
}

/**
 * Forward Web Mercator, degrees to EPSG:3857 metres.
 *
 * Inputs are clamped: longitudes can run past ±180 when the map wraps, and the
 * latitude formula diverges at the poles, so 85.05112878 is Web Mercator's
 * usable limit.
 */
function toMercator(lng, lat) {
  const l = Math.max(-180, Math.min(180, lng))
  const t = Math.max(-85.05112878, Math.min(85.05112878, lat))
  return [
    (l * 20037508.34) / 180,
    (Math.log(Math.tan(((90 + t) * Math.PI) / 360)) / (Math.PI / 180)) * (20037508.34 / 180)
  ]
}

/**
 * The WMS image URL and corner coordinates for the current view.
 *
 * getBounds() returns a box that covers the viewport even when the map is
 * rotated, and height is derived from that box's aspect rather than the canvas
 * aspect — so the image is never distorted, whatever the camera is doing.
 *
 * Returns null for a momentarily unsized container (width or height of 0)
 * rather than requesting a bad URL.
 */
function wmsViewport() {
  const bounds = map.getBounds()
  const [minx, miny] = toMercator(bounds.getWest(), bounds.getSouth())
  const [maxx, maxy] = toMercator(bounds.getEast(), bounds.getNorth())

  let width = Math.min(map.getCanvas().clientWidth, WMS_MAX_PIXELS)
  let height = Math.round((width * (maxy - miny)) / (maxx - minx))
  if (height > WMS_MAX_PIXELS) {
    width = Math.round((width * WMS_MAX_PIXELS) / height)
    height = WMS_MAX_PIXELS
  }
  if (!width || !height) return null

  return {
    url: wmsImageUrl(selected.code, selected.config, currentTime,
                     [minx, miny, maxx, maxy], width, height),
    coordinates: [
      [bounds.getWest(), bounds.getNorth()],
      [bounds.getEast(), bounds.getNorth()],
      [bounds.getEast(), bounds.getSouth()],
      [bounds.getWest(), bounds.getSouth()]
    ]
  }
}

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

      // signQuery() is null until the first signature is computed. Returning
      // early leaves the URL untouched, which fails visibly, rather than
      // concatenating the string "null" into the query.
      const query = signQuery()
      if (!query) return

      return { url: url + (url.includes('?') ? '&' : '?') + query }
    }
  })

  let lastRefresh = 0
  map.on('error', (event) => {
    console.warn('map error:', event.error && event.error.message)
    // A burst of tile errors usually means the signature expired. Renew it, but
    // not more than once every 30 seconds.
    if (Date.now() - lastRefresh > 30000) {
      lastRefresh = Date.now()
      refreshSignature().catch((error) => {
        console.warn('signature refresh failed:', error.message)
      })
    }
  })

  // WMS delivers one image for one view, so a new view needs a new image. TMS
  // needs nothing here: MapLibre requests tiles for the new view by itself.
  map.on('moveend', () => {
    if (protocol !== 'wms' || !ready || !currentTime) return
    const source = map.getSource('wx')
    if (!source || !source.updateImage) return
    const view = wmsViewport()
    if (!view) return
    source.updateImage({ url: view.url, coordinates: view.coordinates })
  })
}

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
function resetLegend() {
  el('legend-bar').style.display = 'none'
  el('legend-labels').replaceChildren()
  el('legend-note').textContent = ''
}

async function showLegend() {
  const bar = el('legend-bar')
  const labels = el('legend-labels')
  const note = el('legend-note')

  resetLegend()

  let entries
  try {
    const response = await fetch(legendUrl(selected.code, selected.config))

    // Some products publish no legend at all. The CDN answers 403 rather than
    // 404 because the bucket denies listing, so "missing" and "forbidden" look
    // identical from outside. Either way there is nothing to draw, and for
    // lightning-heatmap-global this is the normal, permanent state — verified
    // against the CDN — so it is not worth a console warning.
    if (response.status === 403 || response.status === 404) {
      note.textContent = 'No legend published for this product.'
      return
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    entries = (await response.json()).palettes[0].entries
    if (!Array.isArray(entries) || !entries.length) {
      throw new Error('legend has no palette entries')
    }
  } catch (error) {
    // Anything else — a network failure, malformed JSON, or an unexpected
    // document shape — is a real problem and must not hide behind the same
    // silence as a product that simply has no legend.
    console.warn('legend fetch failed:', error.message)
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

/**
 * The one code path that puts weather on the map. The product radios, the
 * protocol toggle, and the Refresh button all call this.
 *
 * It always removes and re-adds the source. A raster source's `scheme` cannot
 * be changed after the source is created, so a protocol switch has to re-add it
 * anyway — one path is simpler than two.
 */
async function showProduct() {
  // Leave the setup message from start() in place rather than overwriting it
  // with a null-dereference from deeper in the stack.
  if (!ready) return

  if (map.getLayer('wx')) map.removeLayer('wx')
  if (map.getSource('wx')) map.removeSource('wx')

  setStatus(`Loading ${selected.label}…`)

  let time
  try {
    time = await latestInstance(selected.code, selected.config)
  } catch (error) {
    resetLegend()
    setStatus(error.message, true)
    return
  }
  // wmsViewport() needs this so a later map move can rebuild the URL without
  // another metadata lookup.
  currentTime = time

  if (protocol === 'tms') {
    map.addSource('wx', {
      type: 'raster',
      tiles: [tmsTemplate(selected.code, selected.config, time)],
      tileSize: 256,
      scheme: 'tms',   // Baron TMS rows run bottom-up
      attribution: '&copy; Baron Weather'
    })
  } else {
    const view = wmsViewport()
    // A momentarily unsized container (width or height of 0) would build a bad
    // URL. Bail out rather than request one — the next Refresh or map move
    // tries again.
    if (!view) {
      resetLegend()
      setStatus('Map has no size yet — try Refresh', true)
      return
    }
    map.addSource('wx', { type: 'image', url: view.url, coordinates: view.coordinates })
  }

  map.addLayer({ id: 'wx', type: 'raster', source: 'wx' }, LABEL_LAYER)

  setStatus(`Valid ${time}`)
  showLegend()
}

/**
 * showProduct() is async, so a throw after the instance lookup — a source id
 * collision from fast clicking, a missing basemap anchor layer, a style that is
 * not loaded yet — would otherwise surface only as a console rejection while the
 * panel sat on "Loading …". Every entry point goes through here so the reason
 * always reaches the panel.
 */
const redraw = () => showProduct().catch((error) => setStatus(error.message, true))

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
      redraw()
    })
    label.append(radio, ` ${product.label}`)
    container.append(label)
  })
}

/** Wire the TMS/WMS buttons. Switching redraws the selected product. */
function buildProtocolToggle() {
  const buttons = document.querySelectorAll('#protocol button')
  for (const button of buttons) {
    button.addEventListener('click', () => {
      protocol = button.dataset.protocol
      for (const other of buttons) {
        other.classList.toggle('on', other === button)
      }
      redraw()
    })
  }
}

async function start() {
  buildProducts()
  buildProtocolToggle()
  el('refresh').addEventListener('click', redraw)
  createMap()

  try {
    await loadCredentials()
    await startSigning()
    ready = true
  } catch (error) {
    // Without credentials the basemap still loads, so the page is never blank.
    setStatus(error.message, true)
    return
  }

  // Wait for the style before adding a layer — addLayer needs its anchor layer
  // to exist. Loading credentials is fast enough that the style is usually still
  // loading, but check rather than rely on the race going one way.
  if (map.isStyleLoaded()) redraw()
  else map.on('load', redraw)
}

start()
