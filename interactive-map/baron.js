/**
 * baron.js — everything that talks to the Baron Weather API.
 *
 * This file knows nothing about MapLibre. It reads credentials, signs requests,
 * resolves the newest product instance, and builds URLs.
 */

export const API_BASE = 'https://api.velocityweather.com/v1'
const LEGEND_BASE = 'https://static.velocityweather.com/legends'

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
    // Strip surrounding quotes, matching geotiff_fetch/baron_geotiff.py. One .env
    // is meant to serve every folder in this repository, so a value written
    // KEY="abc" has to parse the same way here as it does there — otherwise it
    // silently signs with the quotes included and every request 403s.
    values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
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
  // Same guard as transformRequest in app.js: before the first signature is
  // computed there is nothing to append, and a malformed query is harder to
  // diagnose than a clear failure. latestInstance's caller shows this message.
  const query = signQuery()
  if (!query) {
    throw new Error('No signature yet — credentials are still loading')
  }
  return url + (url.includes('?') ? '&' : '?') + query
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
  if (response.status === 401 || response.status === 403) {
    // The three usual causes, none of which are "this product has no data":
    // a key not entitled to the product, a malformed secret, or a system clock
    // more than ~15 minutes out — signing is timestamp-based, so clock skew
    // fails every request while everything else looks correct.
    throw new Error(
      `Not authorised for ${product} — check the key, the secret, and the system clock (HTTP ${response.status})`
    )
  }
  if (!response.ok) {
    throw new Error(`No instances for ${product} (HTTP ${response.status})`)
  }
  const instances = await response.json()
  if (!instances.length) {
    throw new Error(`No instances for ${product}`)
  }
  return instances[0].time
}

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
    'width=256',    // must match tileSize in app.js's createMap source
    'height=256',
    'format=image/png',
    'transparent=true',
    `layers=${encodeURIComponent(time)}`
  ].join('&')
  return `${API_BASE}/${credentials.key}/wms/${product}/${config}?${query}`
}

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
