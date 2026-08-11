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
