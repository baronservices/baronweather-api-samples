import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJob, readJob, staticUrl, JobError, LAYER_KEYS, cameraWarning, loadingWarning, basemapWarning } from '../cli/job.js';

const base = { output: 'a.png' };
const bad = (obj, ...needles) => {
  assert.throws(() => parseJob(obj), (e) => {
    assert.equal(e.name, 'JobError');
    for (const n of needles) assert.ok(e.message.includes(n), `${JSON.stringify(e.message)} lacks ${n}`);
    return true;
  });
};

test('defaults', () => {
  assert.deepEqual(parseJob(base), {
    output: 'a.png', product: 'sigwx', level: 'high', valid: 'current', center: { lat: 5, lon: -80 },
    zoom: 3.75, basemap: 'light', density: 1, legend: true, key: false, width: 1280, height: 800, scale: 1,
    layers: { jet: true, cb: true, cat: true, icing: true, tropo: true, volcano: true, tc: true, graticule: true },
    style: {},
  });
});

test('LAYER_KEYS maps job names to internal keys', () => {
  assert.deepEqual(LAYER_KEYS, { jets: 'jet', cb: 'cb', turbulence: 'cat', icing: 'icing', tropopause: 'tropo', volcanoes: 'volcano', cyclones: 'tc', grid: 'graticule' });
});

test('layers: all then overrides', () => {
  const only = parseJob({ ...base, layers: { all: false, jets: true } }).layers;
  assert.deepEqual(Object.keys(only).filter((k) => only[k]), ['jet']);
  const most = parseJob({ ...base, layers: { tropopause: false } }).layers;
  assert.deepEqual(Object.keys(most).filter((k) => !most[k]), ['tropo']);
});

test('unknown and missing keys', () => {
  bad({ ...base, zoom_level: 3 }, 'unknown key "zoom_level"');
  bad({ ...base, layers: { jet: true } }, 'layers.jet');
  bad({}, 'output');
  bad({ output: 'a.jpg' }, 'output');
  bad({ output: 3 }, 'output');
});

test('ranges', () => {
  bad({ ...base, density: 0.4 }, '"density" must be a number from 0.5 to 2');
  bad({ ...base, density: 2.1 }, 'density');
  bad({ ...base, zoom: -1 }, 'zoom');
  bad({ ...base, zoom: 15 }, 'zoom');
  bad({ ...base, width: 199 }, 'width');
  bad({ ...base, width: 4097 }, 'width');
  bad({ ...base, scale: 4 }, 'scale');
  bad({ ...base, center: { lat: 86, lon: 0 } }, 'center.lat');
  bad({ ...base, center: { lat: 0, lon: 181 } }, 'center.lon');
});

test('width and height must be whole numbers; scale may be fractional', () => {
  bad({ ...base, width: 300.5 }, '"width" must be a whole number from 200 to 4096');
  bad({ ...base, height: 300.5 }, '"height" must be a whole number from 200 to 4096');
  assert.equal(parseJob({ ...base, scale: 1.5 }).scale, 1.5);
});

test('unknown center key', () => {
  bad({ ...base, center: { lat: 1, lon: 2, x: 3 } }, 'unknown key "center.x"');
});

test('wrong types and enums', () => {
  bad({ ...base, legend: 'yes' }, 'legend');
  bad({ ...base, center: [5, -80] }, 'center');
  bad({ ...base, product: 'x' }, 'product');
  bad({ ...base, basemap: 'x' }, 'basemap');
  bad({ ...base, level: 'low' }, 'level');
});

test('every problem is listed', () => {
  bad({ ...base, density: 9, zoom_level: 1 }, 'density', 'zoom_level');
});

test('valid', () => {
  assert.equal(parseJob({ ...base, valid: 'current' }).valid, 'current');
  assert.equal(parseJob({ ...base, valid: '2026-10-21T12:00:00Z' }).valid, '2026-10-21T12:00:00Z');
  bad({ ...base, valid: '2026-10-21T12:00:00' }, 'valid');
  bad({ ...base, valid: 5 }, 'valid');
});

test('pixel size: width × scale and height × scale are each at most 8192', () => {
  const atCap = parseJob({ ...base, width: 4096, height: 2730, scale: 2 });   // 8192 × 5460 px
  assert.deepEqual([atCap.width, atCap.height, atCap.scale], [4096, 2730, 2]);
  assert.equal(parseJob({ ...base, width: 2730, height: 2730, scale: 3 }).scale, 3);   // 8190 px each
  bad({ ...base, width: 4096, scale: 2.01 }, '"width" × "scale"', '8192');
  bad({ ...base, height: 2731, scale: 3 }, '"height" × "scale"', '8192');
  bad({ ...base, width: 4096, height: 4096, scale: 3 }, '"width" × "scale"', '"height" × "scale"');
  // Not checked while a size or the scale is itself invalid: that error is the one reported.
  assert.throws(() => parseJob({ ...base, width: 5000, scale: 2 }), (e) => !e.message.includes('×') && e.message.includes('"width"'));
});

test('staticUrl', () => {
  const job = parseJob({ ...base, layers: { all: false, jets: true }, key: true, zoom: 3.75 });
  assert.equal(
    staticUrl(job, 'http://127.0.0.1:5000', '2026-10-21T12:00:00Z'),
    'http://127.0.0.1:5000/?static=1&product=sigwx&level=high&valid=2026-10-21T12%3A00%3A00Z&basemap=light&density=1&layers=jet&legend=1&key=1&w=1280&h=800#3.75/5/-80',
  );
});

test('style: kept as written; its problems are listed with the other job problems, by full path', () => {
  const style = { jets: { line: { color: '#ff00ff' } }, grid: { spacing: 15 } };
  assert.deepEqual(parseJob({ ...base, style }).style, style);
  bad({ ...base, zoom: 99, style: { jets: { line: { width: 0 } }, colour: 1 } },
    '"zoom" must be a number from 0 to 14', '"style.jets.line.width" must be a number from 1 to 12', 'unknown key "style.colour"');
  bad({ ...base, style: 'dark' }, '"style" must be an object');
});

test('staticUrl: a style goes in the query, before the camera fragment, and reads back unchanged', () => {
  const style = { fonts: { text: 'IBM Plex Sans' }, grid: { dash: [1, 0] }, panel: { background: '#0a0b0c' } };
  const url = staticUrl(parseJob({ ...base, style }), 'http://127.0.0.1:5000', '2026-10-21T12:00:00Z');
  const u = new URL(url);
  assert.deepEqual(JSON.parse(u.searchParams.get('style')), style);
  assert.equal(u.hash, '#3.75/5/-80');
  assert.equal(u.searchParams.get('h'), '800');
  // An empty style adds nothing.
  assert.equal(staticUrl(parseJob({ ...base, style: {} }), 'o', 'v'), staticUrl(parseJob(base), 'o', 'v'));
});

test('readJob', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigwx-job-'));
  const f = path.join(dir, 'j.json');
  fs.writeFileSync(f, '{ nope');
  assert.throws(() => readJob(f), (e) => e instanceof JobError && e.message.startsWith(`${f}: invalid JSON: `));
  assert.throws(() => readJob(path.join(dir, 'x.json')), { name: 'JobError', message: `${path.join(dir, 'x.json')}: not found` });
  assert.throws(() => readJob(dir), (e) => e instanceof JobError && e.message.startsWith(`${dir}: cannot read: `));
  fs.writeFileSync(f, '{"output":"o.png"}');
  assert.equal(readJob(f).output, 'o.png');
});

// MapLibre will not show empty space above or below the world: a map taller than the world at
// the job's zoom is drawn at the zoom that fills it, centred on the equator; otherwise a view
// that would reach past 85° has its centre moved. The CLI says so instead of staying silent.
test('cameraWarning: none when the map was drawn where the job asked', () => {
  const job = parseJob({ ...base, zoom: 3.75, center: { lat: 5, lon: -80 } });
  assert.equal(cameraWarning(job, { zoom: 3.75, lat: 5, lon: -80 }), null);
  assert.equal(cameraWarning(job, { zoom: 3.75 + 1e-9, lat: 5 + 1e-9, lon: -80 }), null);
});
test('cameraWarning: a zoom raised to fill a tall map', () => {
  const job = parseJob({ ...base, zoom: 0.5, height: 1024, center: { lat: 51.2, lon: 15.7 } });
  assert.equal(cameraWarning(job, { zoom: 1, lat: 0, lon: 15.7 }),
    'warning: at zoom 0.5 the whole world is shorter than the 1024 px map, so it was drawn at zoom 1, centred on 0.0°N');
});
test('cameraWarning: a centre moved so the view stays inside the world', () => {
  const job = parseJob({ ...base, zoom: 3, center: { lat: 84, lon: 0 } });
  assert.equal(cameraWarning(job, { zoom: 3, lat: 72.34, lon: 0 }),
    'warning: the map was centred on 72.3°N, not 84.0°N, so that it does not reach past the edge of the world (85°)');
});
test('loadingWarning: none when ready, the basemap when late, the RTL plugin when it held the map back', () => {
  assert.equal(loadingWarning({ incomplete: false, rtl: 'loaded' }), null);
  assert.equal(loadingWarning({ incomplete: true, rtl: 'loaded' }), 'warning: the map was still loading after 20 s; the basemap may be incomplete');
  assert.equal(loadingWarning({ incomplete: true, rtl: 'loading' }),
    'warning: the map was still loading after 20 s: the right-to-left text plugin had not loaded, and until it does MapLibre draws neither the basemap nor the SIGWX lines and areas');
});
// A small move still shows: the numbers get the decimals that tell them apart (views from MapLibre
// 4.7.1's constraint for these jobs).
test('cameraWarning: a small change is never printed as no change', () => {
  const north = parseJob({ ...base, zoom: 8, height: 512, center: { lat: 85, lon: 0 } });
  assert.equal(cameraWarning(north, { zoom: 8, lat: 84.99010018023479, lon: 0 }),
    'warning: the map was centred on 84.99°N, not 85.00°N, so that it does not reach past the edge of the world (85°)');
  const tall = parseJob({ ...base, zoom: 2, height: 2049 });
  assert.equal(cameraWarning(tall, { zoom: 2.0007042690112464, lat: 0, lon: -80 }),
    'warning: at zoom 2 the whole world is shorter than the 2049 px map, so it was drawn at zoom 2.001, centred on 0.0°N');
});
// The basemap tiles the CDN did not serve, per source (st.tiles: {id: {type, ok, failed, statuses}}).
test('basemapWarning: none when every tile came, or when one imagery source covers for another', () => {
  assert.equal(basemapWarning(undefined), null);
  assert.equal(basemapWarning({ openmaptiles: { type: 'vector', ok: 12, failed: 0, statuses: {} } }), null);
  assert.equal(basemapWarning({ openmaptiles: { type: 'vector', ok: 12, failed: 0, statuses: {} },
    s2: { type: 'raster', ok: 0, failed: 40, statuses: { 403: 40 } }, naip: { type: 'raster', ok: 40, failed: 0, statuses: {} } }), null);
});
test('basemapWarning: a blank basemap, a partly missing one, and no imagery', () => {
  assert.equal(basemapWarning({ openmaptiles: { type: 'vector', ok: 0, failed: 12, statuses: { 403: 12 } } }),
    'warning: the basemap is blank: Baron\'s map CDN did not serve 12 of 12 map tiles (HTTP 403)');
  assert.equal(basemapWarning({ openmaptiles: { type: 'vector', ok: 9, failed: 3, statuses: { 403: 3 } } }),
    'warning: the basemap is partly missing: Baron\'s map CDN did not serve 3 of 12 map tiles (HTTP 403)');
  assert.equal(basemapWarning({ openmaptiles: { type: 'vector', ok: 0, failed: 12, statuses: { 403: 12 } },
    naip: { type: 'raster', ok: 0, failed: 88, statuses: { 403: 88 } }, s2: { type: 'raster', ok: 0, failed: 88, statuses: { 403: 80, network: 8 } } }),
    'warning: the basemap is blank: Baron\'s map CDN did not serve 12 of 12 map tiles and any of 176 satellite image tiles (HTTP 403, network error)');
  assert.equal(basemapWarning({ openmaptiles: { type: 'vector', ok: 12, failed: 0, statuses: {} }, s2: { type: 'raster', ok: 0, failed: 30, statuses: { 403: 30 } } }),
    'warning: the basemap is partly missing: Baron\'s map CDN did not serve any of 30 satellite image tiles (HTTP 403)');
});
