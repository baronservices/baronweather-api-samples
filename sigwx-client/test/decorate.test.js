import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scallopRing, tTicks, worldPx } from '../public/lib/decorate.js';
import { redecorate, setStep } from '../public/map/layers.js';
import { pointInRing, toMerc, fromMerc, MAX_LAT } from '../public/lib/geo.js';

const sq=[[0,0],[10,0],[10,10],[0,10],[0,0]], inner=[[0.01,0.01],[9.99,0.01],[9.99,9.99],[0.01,9.99],[0.01,0.01]];
test('scallops bulge outward', () => {
  const [s]=scallopRing(sq,4); assert.deepEqual(s[0],s.at(-1));
  assert.equal(s.filter(p=>pointInRing(p,inner)).length,0); assert.ok(s.some(p=>!pointInRing(p,sq)));
});
test('tiny ring returned unchanged', () => { const t=[[0,0],[0.001,0],[0.001,0.001],[0,0]]; assert.deepEqual(scallopRing(t,0),[t]); });
test('ticks point to the requested side', () => {
  for (const [,tip] of tTicks(sq,4,'left')) assert.ok(pointInRing(tip,inner));
  for (const [,tip] of tTicks(sq,4,'right')) assert.ok(!pointInRing(tip,sq));
});

// redecorate on a stub map: a W x H px view centred on c at zoom z; setData lands in data.
function stubMap(z, c, W = 1280, H = 800) {
  const w = worldPx(z), m = toMerc(c);
  const [west, north] = fromMerc([m[0] - W / 2 / w, m[1] - H / 2 / w]), [east, south] = fromMerc([m[0] + W / 2 / w, m[1] + H / 2 / w]);
  const data = {};
  return { data, getZoom: () => z,
    getBounds: () => ({ getWest: () => west, getEast: () => east, getSouth: () => south, getNorth: () => north }),
    getSource: (id) => ({ setData: (d) => { data[id] = d; } }) };
}
const fc = (features) => ({ type: 'FeatureCollection', features });
const stepWith = (ring, line) => ({ geo: {
  cbRing: fc(ring ? [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { id: 'cb-0' } }] : []),
  icingLine: fc(line ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: { id: 'ice-0', tickSide: 'left' } }] : []),
} });
const lines = (f) => (f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates);
const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

test('scallops and ticks are the style\'s px on screen (14, 7, 18) at zoom 3.75 and 12', () => {
  for (const z of [3.75, 12]) {
    const w = worldPx(z), px = (p) => toMerc(p).map((v) => v * w), d = 200 / w * 360;   // a 400 px square
    const map = stubMap(z, [0, 0]);
    redecorate(map, stepWith(box(-d, -d, d, d), [[-2 * d, 0], [2 * d, 0]]));
    const s = lines(map.data['cb-scallop'].features[0]).find((l) => l.length > 8);
    const chord = Math.hypot(...[0, 1].map((k) => px(s[8])[k] - px(s[0])[k]));
    assert.ok(Math.abs(chord - 14) < 0.5, `zoom ${z}: chord ${chord}`);
    const t = lines(map.data['icing-ticks'].features[0]);
    const len = Math.hypot(...[0, 1].map((k) => px(t[0][1])[k] - px(t[0][0])[k]));
    const gap = Math.hypot(...[0, 1].map((k) => px(t[1][0])[k] - px(t[0][0])[k]));
    assert.ok(Math.abs(len - 7) < 0.01 && Math.abs(gap - 18) < 0.01, `zoom ${z}: tick ${len}, spacing ${gap}`);
  }
});

test('a ring and line far larger than the view stay within a vertex budget at zoom 14', () => {
  const map = stubMap(14, [-20, 0]);   // the view sits on the ring's west edge
  redecorate(map, stepWith(box(-20, -10, 20, 10), [[-40, 0.0001], [40, 0.0001]]));
  const n = map.data['cb-scallop'].features.flatMap(lines).reduce((a, l) => a + l.length, 0);
  const k = map.data['icing-ticks'].features.flatMap(lines).length;
  assert.ok(n > 0 && n < 10000, `scallop vertices ${n}`);
  assert.ok(k > 0 && k < 1000, `ticks ${k}`);
});

test('a ring one world copy away from the view is decorated where it shows', () => {
  const map = stubMap(6, [-167.5, 0]);   // the ring's copy at -170..-165 is in view
  redecorate(map, stepWith(box(190, -2, 195, 2), null));
  const pts = map.data['cb-scallop'].features.flatMap(lines).flat();
  assert.ok(pts.length > 0 && pts.every(([x]) => x > 189 && x < 196));
});

test('decorations reach one view past the view, so a drag shows them before redecorate', () => {
  const z = 14, w = worldPx(z), map = stubMap(z, [-20, 0]);
  redecorate(map, stepWith(box(-20, -10, 20, 10), null));
  const ys = map.data['cb-scallop'].features.flatMap(lines).flat().map((p) => toMerc(p)[1] * w);
  const y0 = toMerc([-20, 0])[1] * w;   // the view's centre; it is 800 px tall
  assert.ok(Math.min(...ys) < y0 - 1150 && Math.max(...ys) > y0 + 1150, `${Math.min(...ys) - y0}..${Math.max(...ys) - y0}`);
});

test('a view inside a ring, away from its edge, gets no empty scallop feature', () => {
  const map = stubMap(14, [0, 0]);
  redecorate(map, stepWith(box(-20, -10, 20, 10), null));
  assert.deepEqual(map.data['cb-scallop'].features, []);
});

// Work follows the clip box, not the line: at zoom 30, sampling a whole 160° segment
// runs out of memory.
test('long segments near a clip box are sampled only near it', () => {
  const clip = [-1e-7, 50 - 1e-7, 1e-7, 50 + 1e-7];   // about 300 px across at zoom 30
  assert.deepEqual(tTicks([[-80, -70], [80, 70]], 30, 'left', 18, 7, clip), []);
  const t = tTicks([[-80, 50], [80, 50]], 30, 'left', 18, 7, clip);
  assert.ok(t.length > 0 && t.length < 1000, String(t.length));
  const s = scallopRing(box(-80, 50, 80, 60), 30, 14, clip);
  assert.ok(s.length > 0 && s.flat().length < 1000, String(s.flat().length));
});

test('a tick starting exactly on the clip box edge is kept', () => {
  const line = [[0, 1], [0, 0], [100, 0]], [start] = tTicks(line, 0)[0], x = start[0];
  assert.deepEqual(tTicks(line, 0, 'left', 18, 7, [x - 1, -1, x, 1])[0], tTicks(line, 0)[0]);
});

test('the clip keeps arcs in any world copy of the box, and only those', () => {
  const xs = scallopRing(box(0, -5, 170, 5), 2, 14, [165, -10, 365, 10]).flat().map(([x]) => x);
  assert.ok(xs.some((x) => x > 165) && xs.some((x) => x < 5) && !xs.some((x) => x > 20 && x < 150));
});

test('a ring shown in two world copies is decorated where each copy shows', () => {
  const map = stubMap(Math.log2(4.5), [265, 0]);   // a 200° view, 165..365: the ring's east end and, a world on, its west end
  redecorate(map, stepWith(box(0, -5, 170, 5), null));
  const xs = map.data['cb-scallop'].features.flatMap(lines).flat().map(([x]) => x);
  assert.ok(xs.some((x) => x > 165), 'east end, in view at 165..170');
  assert.ok(xs.some((x) => x < 5), 'west end, in view a world on at 360..365');
});

// Lines are drawn only within the chart: a jet, a CAT outline or an icing line that runs past
// ±85.05° would otherwise be drawn flat along the top or bottom edge of the world.
test('setStep draws lines only within ±85.05°, and lines within the chart unchanged', () => {
  const f = (type, coordinates, properties) => ({ type: 'Feature', geometry: { type, coordinates }, properties });
  const inside = f('LineString', [[0, 40], [30, 50]], { id: 'jet-0' }), over = f('LineString', [[0, 80], [10, 88], [20, 89], [30, 80]], { id: 'jet-1' });
  const ringIn = [[0, 0], [10, 0], [10, 10], [0, 0]], ringOver = [[0, 80], [40, 80], [40, 88], [0, 88], [0, 80]];
  const geo = {
    jetLine: fc([inside, over]),
    jetPoint: fc([f('Point', [5, 45], { id: 'jet-0-s0', kt: 100, rotate: 0 }), f('Point', [15, 88.5], { id: 'jet-1-arrow', rotate: 0 })]),
    catFill: fc([f('Polygon', [ringIn], { id: 'cat-0', level: 'MOD' }), f('Polygon', [ringOver], { id: 'cat-1', level: 'MOD' })]),
    icingLine: fc([f('LineString', [[0, 82], [40, 87], [80, 82]], { id: 'ice-0-line', tickSide: 'left' })]),
    cbRing: fc([]),
  };
  const map = stubMap(1, [0, 60], 1280, 1280);
  setStep(map, { geo });
  const pts = (g) => (g.type === 'LineString' ? g.coordinates : g.type === 'Polygon' ? g.coordinates[0] : g.coordinates.flat());
  const J = map.data.jetLine.features, C = map.data.catLine.features, I = map.data.icingLine.features;
  assert.equal(J[0], inside);
  assert.equal(J[1].geometry.type, 'MultiLineString'); assert.equal(J[1].geometry.coordinates.length, 2);
  assert.equal(C[0].geometry.type, 'Polygon'); assert.deepEqual(C[0].geometry.coordinates, [ringIn]);
  assert.deepEqual(C[1].properties, { id: 'cat-1', level: 'MOD' });
  for (const g of [...J, ...C, ...I].map((x) => x.geometry)) assert.ok(pts(g).every(([, y]) => Math.abs(y) <= MAX_LAT), JSON.stringify(g));
  assert.deepEqual(map.data.jetPoint.features.map((x) => x.properties.id), ['jet-0-s0']);
  assert.ok(map.data['icing-ticks'].features[0].geometry.coordinates.every(([base]) => Math.abs(base[1]) <= MAX_LAT));
});
