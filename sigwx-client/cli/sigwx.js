#!/usr/bin/env node
// sigwx CLI: list the feeds' valid times, or render one job file to a PNG.
// Starts the local server in-process on a free port and drives Chrome headless against it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from '../server/config.js';
import { createServer } from '../server/app.js';
import { parseFeed } from '../public/lib/model.js';
import { pickDefault, toMs } from '../public/lib/time.js';
import { readJob, staticUrl, JobError, cameraWarning, loadingWarning, basemapWarning } from './job.js';
import { findChrome, launchChrome, closeAll } from './chrome.js';
import { formatTimes, feedName, shortLabel, firstPerId } from './times.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRODUCTS = ['sigwx', 'sigwx_alt'];
const LEVELS = ['high', 'mid'];
const RENDER_MS = 60000;
const USAGE = `usage:
  sigwx times [--product sigwx|sigwx_alt] [--level high|mid]
      list the valid times of each feed (all four by default)
  sigwx render <job.json>
      render one job file to a PNG
  sigwx --help`;

// ---- the in-process server ----

let server = null;
async function startServer({ key, secret }) {
  server = createServer({ key, secret, publicRoot: path.join(ROOT, 'public'), log: () => {} });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}
function stopServer() {
  if (!server) return Promise.resolve();
  const s = server;
  server = null;
  return new Promise((resolve) => { s.close(() => resolve()); s.closeAllConnections(); });
}

// The feed's valid times, or an Error with the app's message ('upstream HTTP 503' and so on).
async function fetchTimes(origin, product, level) {
  let res, body;
  try {
    res = await fetch(`${origin}/api/sigwx/${product}/${level}`);
    body = await res.json();
  } catch {
    throw new Error(`${feedName({ product, level })}: cannot read the feed from the local server`);
  }
  if (!res.ok) throw new Error(`${feedName({ product, level })}: ${body?.error ?? `HTTP ${res.status}`}`);
  return parseFeed(body).steps.map((s) => s.valid_begin);
}

// ---- times ----

async function times(args) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({ args, options: { product: { type: 'string' }, level: { type: 'string' } }, allowPositionals: true }));
  } catch (err) {
    throw new Error(err.message.split('. ')[0]);   // Node's first sentence, e.g. "Unknown option '--x'"
  }
  if (positionals.length) throw new Error(`unexpected argument "${positionals[0]}"; usage: sigwx times [--product sigwx|sigwx_alt] [--level high|mid]`);
  if (values.product !== undefined && !PRODUCTS.includes(values.product)) throw new Error('--product must be sigwx or sigwx_alt');
  if (values.level !== undefined && !LEVELS.includes(values.level)) throw new Error('--level must be high or mid');
  const wanted = PRODUCTS.filter((p) => (values.product ?? p) === p)
    .flatMap((product) => LEVELS.filter((l) => (values.level ?? l) === l).map((level) => ({ product, level })));
  const origin = await startServer(loadConfig({ root: ROOT }));
  // Every feed settles before the server stops, so a failed one neither hides the others
  // nor leaves an upstream fetch holding Node open.
  const results = await Promise.allSettled(wanted.map((f) => fetchTimes(origin, f.product, f.level)));
  const now = Date.now();
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') console.log(formatTimes([{ ...wanted[i], times: r.value }], now).join('\n'));
    else console.error(r.reason.message);   // '<FEED>: <error>'
  });
  if (results.some((r) => r.status === 'rejected')) process.exitCode = 1;
}

// ---- render ----

const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });   // IHDR

// The PNG goes to a temporary file in the same folder and is then renamed into place, so the
// output path only ever holds a complete chart: a failed write neither truncates an existing
// PNG nor leaves a partial one.
function writeAtomic(out, data) {
  const tmp = path.join(path.dirname(out), `.${path.basename(out)}.${process.pid}.tmp`);
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, out);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
    throw new Error(`cannot write ${out}: ${err.code ?? err.message}`);
  }
}

async function render(args) {
  if (typeof WebSocket === 'undefined') throw new Error('sigwx render needs Node 22.4 or later');
  if (args.length !== 1) throw new Error('usage: sigwx render <job.json>');
  const job = readJob(args[0]);
  const config = loadConfig({ root: ROOT });     // also loads .env into process.env, so it can set CHROME_PATH
  const chromePath = findChrome(process.env);   // before any network, so a missing Chrome fails fast
  const origin = await startServer(config);
  const feed = feedName(job);
  const times = await fetchTimes(origin, job.product, job.level);
  if (!times.length) throw new Error(`${feed}: the feed has no timesteps`);
  const i = job.valid === 'current'
    ? pickDefault(times, Date.now()).index
    : times.findIndex((t) => toMs(t) === toMs(job.valid));
  if (i < 0) throw new JobError(`valid time ${job.valid} is not in ${feed}; available: ${times.join(', ')}`);
  const valid = times[i];

  // A signal during the fetches above has already run closeAll(), so no Chrome may start now.
  if (interrupted) throw new Error('interrupted');
  const chrome = await launchChrome(chromePath);
  try {
    const { send } = chrome;
    const view = { width: job.width + 400, height: Math.max(job.height, 800) };
    await send('Emulation.setDeviceMetricsOverride', { ...view, deviceScaleFactor: job.scale, mobile: false });
    const nav = await send('Page.navigate', { url: staticUrl(job, origin, valid) });
    if (nav.errorText) throw new Error(`cannot load the chart page: ${nav.errorText}`);

    const deadline = Date.now() + RENDER_MS;
    let st = null;
    for (;;) {
      const r = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.sigwxStatic ?? null)', returnByValue: true });
      st = r.exceptionDetails ? null : JSON.parse(r.result.value ?? 'null');   // mid-navigation: not ready yet
      if (st?.error) throw new Error(st.error);
      if (st?.ready) break;
      if (Date.now() >= deadline) throw new Error(`the map did not finish drawing within ${RENDER_MS / 1000} s (basemap or network problem?)`);
      await sleep(250);
    }

    const { width, height } = st.size;
    if (width > view.width || height > view.height) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: Math.max(width, view.width), height: Math.max(height, view.height), deviceScaleFactor: job.scale, mobile: false,
      });
      await send('Runtime.evaluate', { expression: 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))', awaitPromise: true });
    }
    const shot = await send('Page.captureScreenshot', {
      format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 }, captureBeyondViewport: true,
    }, RENDER_MS);
    // Placed and hidden can change after ready, so they are read right after the capture.
    // The basemap attribution must be in the image: the strip has text and lies inside the captured area.
    const after = await send('Runtime.evaluate', {
      expression: `JSON.stringify((() => {
        const a = document.getElementById('attribution'), r = a.getBoundingClientRect();
        return { placed: window.sigwxStatic.placed, hidden: window.sigwxStatic.hidden, error: window.sigwxStatic.error,
          attribution: a.textContent.trim() !== '' && r.height > 0 && r.bottom <= ${height} + 0.5 };
      })())`, returnByValue: true,
    });
    const { placed, hidden, error, attribution } = JSON.parse(after.result.value);
    if (error) throw new Error(error);   // e.g. a map font that failed while the image was taken

    const png = Buffer.from(shot.data, 'base64');
    const out = path.resolve(job.output);
    writeAtomic(out, png);

    const px = pngSize(png);
    const unplaced = firstPerId(hidden);
    const lines = [
      `wrote ${out} (${px.width}×${px.height} px${job.scale !== 1 ? `, ${width}×${height} CSS px at scale ${job.scale}` : ''})`,
      `${feed}, valid ${valid} (${shortLabel(valid)}), usable ${st.usable}`,
      `${placed} hazard label${placed === 1 ? '' : 's'} placed`,
      `${unplaced.length} hazard${unplaced.length === 1 ? '' : 's'} with no room for a label${unplaced.length ? ':' : ''}`,
      ...unplaced.map((s) => `  ${s}`),
    ];
    if (!attribution) lines.push('warning: the image has no basemap attribution strip; it must not be published without one');
    const loading = loadingWarning(st);   // readied by the 20 s fallback: the map may be incomplete
    if (loading) lines.push(loading);
    const basemap = basemapWarning(st.tiles);
    if (basemap) lines.push(basemap);
    const moved = cameraWarning(job, st.view);
    if (moved) lines.push(moved);
    if (st.outsideUsable) lines.push(`warning: the time now, ${new Date().toISOString().slice(11, 16)}Z, is outside the usable window of ${valid} (${st.usable})`);
    console.log(lines.join('\n'));
  } finally {
    await chrome.close();
  }
}

// ---- main ----

// SIGINT (Ctrl-C), SIGTERM (kill, timeout, CI) and SIGHUP (terminal closed) all close Chrome
// and the server, then exit 128 + the signal number. A repeated signal does not cut the
// clean-up short (that would leave Chrome running).
let interrupted = false;
function onSignal(signal) {
  if (interrupted) return;
  interrupted = true;
  const code = 128 + os.constants.signals[signal];
  setTimeout(() => process.exit(code), 10000).unref();   // in case the clean-up itself hangs
  Promise.allSettled([closeAll(), stopServer()])
    .then(() => process.stderr.write(`${signal === 'SIGINT' ? 'interrupted' : `stopped by ${signal}`}\n`, () => process.exit(code)));
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, onSignal);

const HELP = ['--help', '-h'];
async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === 'help' || HELP.includes(cmd)
    || ((cmd === 'times' || cmd === 'render') && rest.some((a) => HELP.includes(a)))) { console.log(USAGE); return; }
  try {
    if (cmd === 'times') await times(rest);
    else if (cmd === 'render') await render(rest);
    else { console.error(`unknown command "${cmd}"\n${USAGE}`); process.exitCode = 1; }
  } catch (err) {
    if (!interrupted) {
      console.error(err.message);
      process.exitCode = 1;
    }
  } finally {
    await stopServer();
  }
}

await main(process.argv.slice(2));
