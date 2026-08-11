/**
 * app.js — the map and the panel.
 *
 * This file knows nothing about HMAC signing. Everything that talks to the
 * Baron Weather API lives in baron.js.
 */

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
