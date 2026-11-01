import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parseFeed, buildStep } from '../public/lib/model.js';
import { ringArea, pointInRing, shiftNear } from '../public/lib/geo.js';
import { nearestOnRing } from '../public/lib/icing.js';

// The full captures are gitignored; without them every test here skips loudly.
const DIR = new URL('./captures/', import.meta.url);
const FILES = ['sigwx_high', 'sigwx_mid', 'sigwx_alt_high', 'sigwx_alt_mid'];
const HAVE = FILES.every((n) => existsSync(new URL(`${n}.json`, DIR)));
const SKIP = 'captures missing: see "Captures" in the README';

// parseFeed, then buildStep on each step with the feed's product/level. Memoised per file.
const buildAll = (json) => { const {product, level, steps} = parseFeed(json); return steps.map((s) => buildStep(s, {product, level})); };
const memo = new Map();
const F = (n) => { if (!memo.has(n)) memo.set(n, buildAll(JSON.parse(readFileSync(new URL(`${n}.json`, DIR), 'utf8')))); return memo.get(n); };
const same = (p, q) => p[0] === q[0] && p[1] === q[1];
const isClosed = (f) => { const c = f.geometry.coordinates; return c.length > 0 && same(c[0], c.at(-1)); };

test('range filter counts', (t) => {
  if (!HAVE) return t.skip(SKIP);
  assert.deepEqual(F('sigwx_high').map(s=>s.counts.jet),[42,40,38,40,41]);
  assert.deepEqual(F('sigwx_mid').map(s=>s.counts.jet),[43,38,37,41,41]);
  assert.deepEqual(F('sigwx_alt_high').map(s=>s.counts.jet),[40,37,39,34]);
  assert.deepEqual(F('sigwx_alt_mid').map(s=>s.counts.jet),[40,37,39,35]);
  assert.deepEqual(F('sigwx_high').map(s=>s.counts.cb),[41,49,41,43,47]);
  assert.deepEqual(F('sigwx_mid').map(s=>s.counts.tropo),[87,95,80,88,95]);
});
test('sigwx mid CB tops XXX per step', (t) => {
  if (!HAVE) return t.skip(SKIP);
  assert.deepEqual(F('sigwx_mid').map(s=>s.callouts.filter(c=>c.kind==='cb'&&c.lines[2]==='XXX').length),[12,17,16,14,16]);
});
test('open icing split', (t) => {
  if (!HAVE) return t.skip(SKIP);
  const rec = s => s.geo.icingLine.features.filter(f=>f.properties.reconstructed).length;
  const fb  = s => s.geo.icingLine.features.filter(f=>f.properties.reconstructed===false && f.geometry.coordinates.length && !isClosed(f)).length;
  assert.deepEqual(F('sigwx_mid').map(rec),[47,53,36,42,54]);  assert.deepEqual(F('sigwx_mid').map(fb),[14,13,28,19,23]);
  assert.deepEqual(F('sigwx_alt_mid').map(rec),[55,34,40,48]); assert.deepEqual(F('sigwx_alt_mid').map(fb),[8,23,19,23]);
  const flagged = s => s.geo.icingLine.features.filter(f=>f.properties.fallback===true).length;   // exactly the open, unrebuilt lines
  assert.deepEqual(F('sigwx_mid').map(flagged),[14,13,28,19,23]); assert.deepEqual(F('sigwx_alt_mid').map(flagged),[8,23,19,23]);
});
test('POPOCATEPETL and storm 5 at sigwx high t4', (t) => {
  if (!HAVE) return t.skip(SKIP);
  const s=F('sigwx_high')[4];
  assert.deepEqual(s.callouts.find(c=>c.lines[0]==='POPOCATEPETL').lines,['POPOCATEPETL','19.0N 98.6W']);
  assert.ok(s.callouts.some(c=>c.lines[0]==='5 (NAME UNVERIFIED)'));
});

// ---- unwrapping: walk every coordinate of every feature in every geo collection ----
// Positions of one geometry, grouped into the paths whose consecutive Δlon is checked.
const paths = (g) => g.type === 'Point' ? [[g.coordinates]] : g.type === 'LineString' ? [g.coordinates] : g.type === 'Polygon' ? g.coordinates : null;

// -> {values, problems}: values is how many numbers were checked; problems lists each failure.
function walkStep(s) {
  let values = 0;
  const problems = [];
  const num = (v, where) => { values++; if (!Number.isFinite(v)) problems.push(`${where}: non-finite ${v}`); };
  const finite = (p, where) => {
    p.forEach((v) => num(v, where));
    if (p.length !== 2) problems.push(`${where}: ${p.length} values`);
  };
  for (const [key, fc] of Object.entries(s.geo)) {
    for (const f of fc.features) {
      const where = `${key} ${f.properties.id}`, P = paths(f.geometry);
      if (!P) { problems.push(`${where}: geometry ${f.geometry.type}`); continue; }
      for (const path of P) {
        path.forEach((p, i) => {
          finite(p, `${where}[${i}]`);
          if (i && !(Math.abs(p[0] - path[i - 1][0]) <= 180)) problems.push(`${where}[${i}]: Δlon ${p[0] - path[i - 1][0]}`);
        });
      }
    }
  }
  for (const c of s.callouts) {
    const where = `callout ${c.id}`;
    finite(c.anchor, `${where} anchor`); c.bbox.forEach((v) => num(v, `${where} bbox`));
    if (c.edge) { finite(c.edge, `${where} edge`); if (!(Math.abs(c.edge[0] - c.anchor[0]) <= 180)) problems.push(`${where}: edge Δlon`); }
    (c.ring ?? []).forEach((p, i) => finite(p, `${where} ring[${i}]`));
    const [a, b, x, y] = c.bbox;   // the bbox holds its own anchor
    if (!(a <= c.anchor[0] && c.anchor[0] <= x && b <= c.anchor[1] && c.anchor[1] <= y)) problems.push(`${where}: anchor outside bbox`);
  }
  return { values, problems };
}

test('the coordinate walk catches NaN, Infinity, a >180° jump and an anchor outside its bbox', () => {
  const fc = (features) => ({ type: 'FeatureCollection', features });
  const bad = { geo: {
    jetLine: fc([{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[170, 0], [-170, 1]] }, properties: { id: 'jet-0' } }]),
    tropo: fc([{ type: 'Feature', geometry: { type: 'Point', coordinates: [NaN, 0] }, properties: { id: 'tropo-0' } }]),
    catFill: fc([{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, Infinity], [0, 0]]] }, properties: { id: 'cat-0' } }]),
  }, callouts: [{ id: 'vol-0', anchor: [5, 5], edge: null, ring: null, bbox: [0, 0, 1, 1] }] };
  assert.deepEqual(walkStep(bad).problems, [
    'jetLine jet-0[1]: Δlon -340', 'tropo tropo-0[0]: non-finite NaN', 'catFill cat-0[1]: non-finite Infinity', 'callout vol-0: anchor outside bbox']);
});

test('no NaN and no |Δlon|>180 edge anywhere, all files, all steps', (t) => {
  if (!HAVE) return t.skip(SKIP);
  for (const n of FILES) {
    const steps = F(n);
    assert.ok(steps.length >= 4, `${n}: ${steps.length} steps`);
    steps.forEach((s, i) => {
      const { values, problems } = walkStep(s);
      assert.ok(values > 1000, `${n} t${i}: only ${values} values walked`);   // positive control: the walk saw real data
      assert.deepEqual(problems, [], `${n} t${i}`);
    });
  }
});

test('every emitted area ring is closed and CCW, all files, all steps', (t) => {
  if (!HAVE) return t.skip(SKIP);
  let rings = 0;
  for (const n of FILES) {
    F(n).forEach((s, i) => {
      for (const key of ['catFill', 'icingFill', 'cbRing']) {
        for (const f of s.geo[key].features) {
          const r = f.geometry.coordinates[0]; rings++;
          assert.ok(r.length >= 4 && same(r[0], r.at(-1)) && ringArea(r) > 0, `${n} t${i} ${f.properties.id}`);
        }
      }
    });
  }
  assert.ok(rings > 1000, `only ${rings} rings`);
});

// A MOD anchor lies inside its own MOD ring and outside every same-type
// SEV ring whose vertices all lie inside or on (1e-6°, planar) that MOD ring.
test('MOD anchors avoid every SEV ring nested in their MOD ring, all files, all steps', (t) => {
  if (!HAVE) return t.skip(SKIP);
  const insideOrOn = (p, R) => pointInRing(p, R) || nearestOnRing(p, R).dist < 1e-6;
  let mods = 0, nested = 0;
  const outside = [], inSev = [];
  for (const n of FILES) {
    F(n).forEach((s, i) => {
      for (const kind of ['cat', 'icing']) {
        const sev = s.callouts.filter((c) => c.kind === kind && c.level === 'SEV' && c.ring);
        for (const m of s.callouts.filter((c) => c.kind === kind && c.level === 'MOD' && c.ring)) {
          mods++;
          if (!pointInRing(m.anchor, m.ring)) outside.push(`${n} t${i} ${m.id}`);
          for (const v of sev) {
            const S = shiftNear(v.ring, m.ring[0][0]);
            if (!S.every((p) => insideOrOn(p, m.ring))) continue;
            nested++;
            if (pointInRing(m.anchor, S)) inSev.push(`${n} t${i} ${m.id} in ${v.id}`);
          }
        }
      }
    });
  }
  assert.ok(mods > 1000 && nested > 100, `only ${mods} MOD anchors, ${nested} nested SEV rings`);   // positive control
  assert.deepEqual(outside, []);
  assert.deepEqual(inSev, []);
});
