import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sigwxUrl, signedHeaders, signingTs } from './sign.js';
import { resolveStatic } from './static.js';

const PRODUCTS = new Set(['sigwx', 'sigwx_alt']);
const LEVELS = new Set(['high', 'mid']);
const JSON_TYPE = { 'content-type': 'application/json' };
const TEXT_TYPE = { 'content-type': 'text/plain; charset=utf-8' };
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2',
};
const error = msg => JSON.stringify({ error: msg });
// Baron's map CDN, and the folders of it the basemap styles use: styles and sprites, TileJSON and
// vector tiles, raster tiles, glyphs.
const CDN = 'https://cdnmaps.velocityweather.com/';
const BASEMAP_DIRS = new Set(['styles', 'data', 'tiles', 'fonts']);

export function createServer({ key, secret, publicRoot, fetchImpl = fetch, now = Date.now, cacheMs = 300000, timeoutMs = 20000, log = console.log }) {
  const cache = new Map(); // 'product/level' -> {body, fetchedAt}
  const inFlight = new Map(); // 'product/level' -> the pending upstream result
  const closing = new AbortController();   // aborts basemap fetches still running when the server closes

  // A cache miss joins the feed's upstream call when one is in flight, so concurrent
  // misses make one call and an older, slower response cannot replace a newer one.
  function proxy(product, level) {
    const cacheKey = `${product}/${level}`;
    const hit = cache.get(cacheKey);
    if (hit && now() - hit.fetchedAt < cacheMs) return ok(hit);
    if (!inFlight.has(cacheKey)) inFlight.set(cacheKey, upstream(product, level).finally(() => inFlight.delete(cacheKey)));
    return inFlight.get(cacheKey);
  }

  // Signs and fetches one feed. Never lets the signed URL, the secret or an
  // upstream error message into the result. A fetch that has not finished (headers and
  // body) after timeoutMs is aborted and reads as timed out.
  async function upstream(product, level) {
    const cacheKey = `${product}/${level}`;
    const fetchedAt = now();
    const url = sigwxUrl(key, secret, product, level, signingTs(fetchedAt));
    const sigParam = url.split('?')[1].split('&')[0]; // exact 'sig=<value>', still %3D-encoded
    let res, body;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      body = await res.text();
    } catch (err) {
      // A slow upstream is not an unreachable one: say which, so the fix is looked for in the right place.
      const msg = err?.name === 'TimeoutError' ? `upstream timed out after ${timeoutMs / 1000} s` : 'upstream unreachable';
      return [502, error(msg), JSON_TYPE];
    }
    if (!(res.status >= 200 && res.status < 300)) return [502, error(`upstream HTTP ${res.status}`), JSON_TYPE];
    if (body.includes(secret) || body.includes(sigParam)) return [502, error('upstream response rejected'), JSON_TYPE];
    const entry = { body, fetchedAt };
    cache.set(cacheKey, entry);
    return ok(entry);
  }
  const ok = ({ body, fetchedAt }) => [200, body, { ...JSON_TYPE, 'x-fetched-at': new Date(fetchedAt).toISOString() }];

  // One basemap file from Baron's map CDN, signed: the CDN answers an unsigned request it has not
  // cached with 403 ("Access key does not exist"). The path goes on as it came, still
  // percent-encoded; the query is dropped. A refusal keeps its status, so MapLibre sees a tile error.
  async function basemap(rest) {
    let decoded;
    try { decoded = decodeURIComponent(rest); } catch { return [404, error('not found'), JSON_TYPE]; }
    if (!BASEMAP_DIRS.has(rest.split('/')[0]) || decoded.split('/').includes('..') || /\\|\/\//.test(decoded)) return [404, error('not found'), JSON_TYPE];
    let res, body;
    try {
      res = await fetchImpl(CDN + rest, { headers: signedHeaders(key, secret, signingTs(now())), redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), closing.signal]) });
      body = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      return [502, error(err?.name === 'TimeoutError' ? `basemap timed out after ${timeoutMs / 1000} s` : 'basemap unreachable'), JSON_TYPE];
    }
    if (!(res.status >= 200 && res.status < 300)) return [res.status, error(`basemap HTTP ${res.status}`), JSON_TYPE];
    if (body.includes(secret)) return [502, error('basemap response rejected'), JSON_TYPE];
    return [200, body, { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream' }];
  }

  async function handle(req, route) {
    const { port } = server.address();
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return [403, 'forbidden', TEXT_TYPE];
    if (req.method !== 'GET') return [404, 'not found', TEXT_TYPE];
    if (route === '/healthz') return [200, 'ok', TEXT_TYPE];
    if (route.startsWith('/api/basemap/')) return basemap(route.slice('/api/basemap/'.length));
    if (route.startsWith('/api/')) {
      const m = /^\/api\/sigwx\/([^/]+)\/([^/]+)$/.exec(route);
      if (!m || !PRODUCTS.has(m[1]) || !LEVELS.has(m[2])) return [404, error('not found'), JSON_TYPE];
      return proxy(m[1], m[2]);
    }
    const file = resolveStatic(publicRoot, route);
    if (!file) return [404, 'not found', TEXT_TYPE];
    return [200, await readFile(file), { 'content-type': MIME[path.extname(file)] }];
  }

  const server = http.createServer(async (req, res) => {
    const pathOnly = req.url.split('?')[0]; // logged without the query string
    let status, body, headers;
    try {
      [status, body, headers] = await handle(req, pathOnly);
    } catch {
      [status, body, headers] = [500, error('internal error'), JSON_TYPE];
    }
    res.writeHead(status, headers).end(body);
    log(`${req.method} ${pathOnly} ${status}`);
  });
  // A slow basemap fetch would otherwise keep the CLI's process alive until its own timeout.
  server.on('close', () => closing.abort());
  return server;
}
