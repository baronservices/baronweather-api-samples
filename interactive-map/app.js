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
  wmsTemplate,
  legendUrl
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
let protocol = 'tms'   // 'tms' or 'wms'

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
  map.addLayer({ id: 'wx', type: 'raster', source: 'wx' }, LABEL_LAYER)

  setStatus(`Valid ${time}`)
  showLegend()
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

async function start() {
  buildProducts()
  buildProtocolToggle()
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

start()
