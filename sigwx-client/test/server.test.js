import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server/app.js';
import { resolveStatic } from '../server/static.js';
import { FIELDS, parseStyle } from '../public/lib/style.js';
import { parseJob, staticUrl } from '../cli/job.js';

// Project root, resolved from this file so the tests work from any cwd.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = path.resolve(ROOT, 'public');
const FEED = '{"sigwx_high":{"data":[]}}';

let t; // mutable clock, reset by start()

// Fresh server per test, closed when the test ends. fetchImpl is a factory so
// every upstream call gets a new Response (a body can be read only once).
async function start(ctx, { fetchImpl = () => new Response(FEED), timeoutMs } = {}) {
  t = 1792497600000;
  const calls = [];
  const logs = [];
  const server = createServer({
    key: 'test-key', secret: 'test-secret', publicRoot: PUBLIC, now: () => t, timeoutMs,
    fetchImpl: (url, opts) => { calls.push(url); return fetchImpl(url, opts); },
    log: line => logs.push(line),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const close = () => new Promise(resolve => server.close(resolve));
  ctx.after(close);
  // node:http with an explicit Host header (fetch would not let us forge it).
  const get = (p, { host = `127.0.0.1:${port}` } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { host }, agent: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
  return { base: `http://127.0.0.1:${port}`, port, calls, logs, close, get, server };
}

test('resolveStatic: traversal, malformed escapes, extensions', () => {
  const root = PUBLIC;
  assert.equal(resolveStatic(root, '/'), path.join(root, 'index.html'));
  for (const p of ['/..%2F.env', '/../.env', '/%2e%2e/.env', '/%', '/%GG', '/x.exe']) assert.equal(resolveStatic(root, p), null);
  // Outside publicRoot but an existing file with an allowed extension: only the containment check stops it.
  for (const p of ['/../package.json', '/..%2Fpackage.json', '/%2e%2e/package.json']) assert.equal(resolveStatic(root, p), null);
});

test('malformed URL is 404 and the server keeps serving', async ctx => {
  const { get } = await start(ctx);
  assert.equal((await get('/%')).status, 404);
  assert.equal((await get('/healthz')).status, 200);
});

test('GET /..%2F.env → 404', async ctx => {
  const { get } = await start(ctx);
  assert.equal((await get('/..%2F.env')).status, 404);
  assert.equal((await get('/..%2Fpackage.json')).status, 404);
  assert.equal((await get('/index.html')).status, 200);
});

test('foreign Host → 403', async ctx => {
  const { get, logs } = await start(ctx);
  assert.equal((await get('/healthz', { host: 'evil.example:1234' })).status, 403);
  assert.deepEqual(logs, ['GET /healthz 403']);
});

test('proxy signs, passes through, stamps x-fetched-at', async ctx => {
  const { get, calls, logs } = await start(ctx);
  const r = await get('/api/sigwx/sigwx/high');
  assert.equal(r.status, 200); assert.equal(r.body, FEED);
  assert.equal(r.headers['content-type'], 'application/json');
  assert.ok(calls[0].startsWith('https://api.velocityweather.com/v1/test-key/reports/sigwx/high.json?sig='));
  assert.match(calls[0], /&ts=1792497600$/);
  assert.ok(!Number.isNaN(Date.parse(r.headers['x-fetched-at'])));
  assert.deepEqual(logs, ['GET /api/sigwx/sigwx/high 200']);
});

test('cache: 1 call within 5 min, 2 after', async ctx => {
  const { get, calls } = await start(ctx);
  const first = await get('/api/sigwx/sigwx/high'); t += 299999;
  const second = await get('/api/sigwx/sigwx/high'); assert.equal(calls.length, 1);
  assert.equal(second.body, first.body);
  assert.equal(second.headers['x-fetched-at'], first.headers['x-fetched-at']);
  t += 2; await get('/api/sigwx/sigwx/high'); assert.equal(calls.length, 2);
});

// Two requests for the same feed while its upstream call is still in flight.
async function concurrentPair(ctx, response) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const s = await start(ctx, { fetchImpl: () => gate.then(response) });
  const both = Promise.all([s.get('/api/sigwx/sigwx/high'), s.get('/api/sigwx/sigwx/high')]);
  await new Promise(resolve => setTimeout(resolve, 100));   // both requests reach the server
  release();
  return { ...s, results: await both };
}

test('concurrent misses for one feed share one upstream call', async ctx => {
  const { calls, results: [a, b] } = await concurrentPair(ctx, () => new Response(FEED));
  assert.equal(calls.length, 1);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(b.body, a.body);
  assert.equal(b.headers['x-fetched-at'], a.headers['x-fetched-at']);
});

test('a failed shared fetch reaches every waiter and is not reused', async ctx => {
  const { get, calls, results } = await concurrentPair(ctx, () => new Response('down', { status: 503 }));
  assert.equal(calls.length, 1);
  assert.deepEqual(results.map(r => r.status), [502, 502]);
  await get('/api/sigwx/sigwx/high'); assert.equal(calls.length, 2);
});

test('unknown product/level → 404, no upstream call', async ctx => {
  const { get, calls } = await start(ctx);
  for (const p of ['/api/sigwx/evil/high', '/api/sigwx/sigwx/low', '/api/sigwx/__proto__/high', '/api/sigwx/sigwx/high/x'])
    assert.equal((await get(p)).status, 404, p);
  assert.equal(calls.length, 0);
});

test('upstream 403 → 502, nothing secret anywhere', async ctx => {
  const { get, logs } = await start(ctx, { fetchImpl: () => new Response('denied', { status: 403 }) });
  const r = await get('/api/sigwx/sigwx/high');
  assert.equal(r.status, 502); assert.deepEqual(JSON.parse(r.body), { error: 'upstream HTTP 403' });
  for (const s of [r.body, logs.join('\n'), JSON.stringify(r.headers)]) {
    assert.ok(!s.includes('sig=')); assert.ok(!s.includes('test-secret')); assert.ok(!s.includes('velocityweather'));
  }
  assert.deepEqual(logs, ['GET /api/sigwx/sigwx/high 502']);
  // A query string never reaches the log: it carries only <method> <path> <status>.
  await get('/api/sigwx/sigwx/mid?sig=client-supplied');
  assert.deepEqual(logs, ['GET /api/sigwx/sigwx/high 502', 'GET /api/sigwx/sigwx/mid 502']);
});

test('fetch throws with the signed URL in its message → 502 unreachable, not echoed', async ctx => {
  const { get, logs } = await start(ctx, { fetchImpl: url => { throw new TypeError('Failed to parse URL from ' + url); } });
  const r = await get('/api/sigwx/sigwx/high');
  assert.equal(r.status, 502);
  assert.deepEqual(JSON.parse(r.body), { error: 'upstream unreachable' });
  assert.ok(!r.body.includes('sig=') && !logs.join('\n').includes('sig='));
  assert.ok(!JSON.stringify(r.headers).includes('sig='));
});

test('errored body stream → 502 unreachable', async ctx => {
  const { get, logs } = await start(ctx, {
    fetchImpl: () => new Response(new ReadableStream({ start(c) { c.error(new Error('x ?sig=LEAK')); } })),
  });
  const r = await get('/api/sigwx/sigwx/high');
  assert.equal(r.status, 502); assert.ok(!r.body.includes('LEAK'));
  assert.deepEqual(JSON.parse(r.body), { error: 'upstream unreachable' });
  assert.ok(!logs.join('\n').includes('LEAK'));
});

test('2xx body echoing the secret is rejected', async ctx => {
  const { get } = await start(ctx, { fetchImpl: () => new Response('{"x":"test-secret"}') });
  const r = await get('/api/sigwx/sigwx/high');
  assert.equal(r.status, 502);
  assert.deepEqual(JSON.parse(r.body), { error: 'upstream response rejected' });
  // The exact sig=<value> just used is rejected too.
  const echo = await start(ctx, { fetchImpl: url => new Response(JSON.stringify({ url })) });
  const r2 = await echo.get('/api/sigwx/sigwx/mid');
  assert.deepEqual(JSON.parse(r2.body), { error: 'upstream response rejected' });
  assert.ok(!r2.body.includes('sig='));
});

test('main exits 1 without credentials and never reads the real .env', () => {
  const r = spawnSync(process.execPath, ['server/main.js'], { cwd: ROOT, timeout: 5000,
    env: { PATH: process.env.PATH, SIGWX_ENV_FILE: '/nonexistent/.env' } });
  assert.equal(r.status, 1); assert.match(String(r.stderr), /missing BARON_ACCESS_KEY/);
});

// The upstream fetch carries a timeout signal (20 s by default; 50 ms
// here). The fake fetch honours it as fetch does; its 2 s fallback only keeps a missing
// signal from hanging the test.
test('hung upstream → aborted by the fetch timeout → 502 timed out, nothing leaked', async ctx => {
  const seen = [];
  const { get, logs } = await start(ctx, { timeoutMs: 50, fetchImpl: (url, opts) => new Promise((resolve, reject) => {
    seen.push(opts?.signal);
    const fallback = setTimeout(() => reject(new Error('no signal: fallback')), 2000);
    opts?.signal?.addEventListener('abort', () => { clearTimeout(fallback); reject(opts.signal.reason); });
  }) });
  const t0 = performance.now();
  const r = await get('/api/sigwx/sigwx/high');
  const ms = performance.now() - t0;
  assert.ok(seen[0] instanceof AbortSignal, 'fetch got no signal');
  assert.ok(ms < 1000, `ended after ${Math.round(ms)} ms, not by the 50 ms timeout`);
  assert.equal(r.status, 502); assert.deepEqual(JSON.parse(r.body), { error: 'upstream timed out after 0.05 s' });
  assert.ok(!/timeout|abort|sig=/i.test(r.body + JSON.stringify(r.headers) + logs.join('\n')));
  assert.deepEqual(logs, ['GET /api/sigwx/sigwx/high 502']);
});

// Baron's map CDN refuses an unsigned request it has not cached (403, "Access key does not exist"),
// so the page asks the server for every basemap file and the server signs the request.
test('basemap: signed with X-VW headers, path passed as it is, query dropped, body and type passed through', async ctx => {
  const seen = [];
  const { get } = await start(ctx, { fetchImpl: (url, opts) => { seen.push({ url, headers: opts?.headers }); return new Response('TILE', { headers: { 'content-type': 'application/x-protobuf' } }); } });
  const r = await get('/api/basemap/fonts/Noto%20Sans%20Regular/0-255.pbf?x=1');
  assert.equal(r.status, 200); assert.equal(r.body, 'TILE');
  assert.equal(r.headers['content-type'], 'application/x-protobuf');
  assert.equal(seen[0].url, 'https://cdnmaps.velocityweather.com/fonts/Noto%20Sans%20Regular/0-255.pbf');
  assert.deepEqual(seen[0].headers, { 'X-VW-key': 'test-key', 'X-VW-sig': 'ld0NVVXQjpWSk0u7Lngo5a5_Elo=', 'X-VW-ts': '1792497600' });
  for (const p of ['/api/basemap/styles/light/style.json', '/api/basemap/data/planet.json', '/api/basemap/data/planet/3/2/3.pbf', '/api/basemap/tiles/s2/mercator/3/2/3.jpeg']) {
    assert.equal((await get(p)).status, 200, p);
  }
});
test('basemap: only the CDN\'s basemap folders, no traversal, no other host', async ctx => {
  const { get, calls } = await start(ctx);
  for (const p of ['/api/basemap/', '/api/basemap/v1/key/reports/sigwx/high.json', '/api/basemap/../.env', '/api/basemap/data/../../x',
    '/api/basemap/data/%2e%2e/%2e%2e/x', '/api/basemap/data/..%2F..%2Fx', '/api/basemap//evil.example/x', '/api/basemap/data\\x']) {
    assert.equal((await get(p)).status, 404, p);
  }
  assert.equal(calls.length, 0);
});
test('basemap: a refusal keeps its status, without the CDN\'s text; failures are 502', async ctx => {
  let mode = 'refuse';
  const { get } = await start(ctx, { timeoutMs: 50, fetchImpl: (url, opts) => {
    if (mode === 'refuse') return new Response('{"status":403,"code":"800101","message":"Access key does not exist"}', { status: 403 });
    if (mode === 'throw') return Promise.reject(new TypeError('fetch failed'));
    return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason)));
  } });
  const refused = await get('/api/basemap/data/planet/12/1062/1626.pbf');
  assert.equal(refused.status, 403); assert.deepEqual(JSON.parse(refused.body), { error: 'basemap HTTP 403' });
  mode = 'throw';
  assert.deepEqual(JSON.parse((await get('/api/basemap/data/planet/0/0/0.pbf')).body), { error: 'basemap unreachable' });
  mode = 'hang';
  const hung = await get('/api/basemap/data/planet/0/0/0.pbf');
  assert.equal(hung.status, 502); assert.deepEqual(JSON.parse(hung.body), { error: 'basemap timed out after 0.05 s' });
});

test('basemap: closing the server aborts the fetches still in flight, so the process can exit', async ctx => {
  let signal;
  const { get, server } = await start(ctx, { timeoutMs: 60000, fetchImpl: (url, opts) => { signal = opts.signal; return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason))); } });
  const pending = get('/api/basemap/tiles/s2/mercator/15/1/1.jpeg').catch(() => null);
  while (!signal) await new Promise((r) => setTimeout(r, 5));
  assert.equal(signal.aborted, false);
  const t0 = performance.now();
  await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });   // as the CLI stops it
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(signal.aborted, true, 'the upstream fetch is still running after the server closed');
  assert.ok(performance.now() - t0 < 1000);
  await pending;
});

test('every signature, feed and basemap, carries the time rounded to the nearest 5 minutes', async ctx => {
  const seen = [];
  const { get } = await start(ctx, { fetchImpl: (url, opts) => { seen.push({ url, headers: opts?.headers }); return new Response(FEED); } });
  t += 151 * 1000;   // 2 min 31 s past a 5-minute mark: rounds up
  await get('/api/sigwx/sigwx/high');
  await get('/api/basemap/data/planet.json');
  assert.match(seen[0].url, /&ts=1792497900$/);
  assert.equal(seen[1].headers['X-VW-ts'], '1792497900');
});

// A PORT that is not a port number exits 1 with a message, no stack trace.
test('main exits 1 with a clear message on a non-numeric PORT', () => {
  const r = spawnSync(process.execPath, ['server/main.js'], { cwd: ROOT, timeout: 5000,
    env: { PATH: process.env.PATH, SIGWX_ENV_FILE: '/nonexistent/.env', BARON_ACCESS_KEY: 'k', BARON_ACCESS_KEY_SECRET: 's', PORT: 'abc' } });
  assert.equal(r.status, 1);
  assert.match(String(r.stderr), /PORT must be a whole number from 0 to 65535, got "abc"/);
  assert.doesNotMatch(String(r.stderr), /\n\s+at /);
});

// The largest style a job can carry fits the server's request-header limit (16 KiB by
// default): every key set, family names at their 40-character maximum, colours at six
// digits, numbers at full precision where their check allows, dashes at 8 entries. The
// style passes validation, so it is one a job can really send.
test('the static URL of a job that sets every style key is served', async ctx => {
  const style = {};
  const set = (p, v) => { const keys = p.split('.'), last = keys.pop(); let o = style; for (const k of keys) o = (o[k] ??= {}); o[last] = v; };
  for (const [p, dflt, check] of FIELDS) {
    const long = typeof dflt === 'number' ? dflt * 0.99999999999937
      : Array.isArray(dflt) && typeof dflt[0] === 'number' ? Array(8).fill(1.1234567890123)
      : p === 'fonts.labels' || p === 'fonts.text' ? 'W'.repeat(40)
      : typeof dflt === 'string' && dflt.startsWith('#') ? '#abcdef' : dflt === null ? '#abcdef' : dflt;
    set(p, check(long) === null ? long : dflt);
  }
  // A long value can still break a rule between keys; those keys go back to their defaults.
  for (const err of parseStyle(style).errors) for (const m of err.matchAll(/"style\.([^"]+)"/g)) set(m[1], FIELDS.find(([p]) => p === m[1])[1]);
  assert.deepEqual(parseStyle(style).errors, []);
  const job = parseJob({ output: 'a.png', style });
  const { get, port } = await start(ctx);
  const url = new URL(staticUrl(job, `http://127.0.0.1:${port}`, '2026-10-21T12:00:00Z'));
  assert.ok(url.search.length > 5000, `only ${url.search.length} characters`);
  const r = await get(url.pathname + url.search);
  assert.equal(r.status, 200);
  assert.match(r.body, /<title>SIGWX<\/title>/);
});
