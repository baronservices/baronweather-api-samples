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
