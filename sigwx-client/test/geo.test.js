import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.js';
import {
  unwrapLine, dedupe, wrapOffset, wrapNear, shiftNear, alignToLine, toMerc, fromMerc,
  ringArea, pointInRing, isSimpleRing, nearestOnPolyline, segmentAngleDeg, poleOfInaccessibility, chartParts, MAX_LAT,
} from '../public/lib/geo.js';

test('unwrap, wrap, shift, align', () => {
  assert.deepEqual(unwrapLine([[180,-61.5],[-160.2,-54]]), [[180,-61.5],[199.8,-54]]);
  assert.equal(wrapNear(205,-170),-155); assert.equal(wrapNear(-175,170),185); assert.equal(wrapOffset(10,-179),-360);
  assert.deepEqual(dedupe([[1,1],[1,1],[2,2]]), [[1,1],[2,2]]);
  assert.deepEqual(shiftNear([[142.3,0],[150,1]], -177.6), [[-217.7,0],[-210,1]]);
  assert.deepEqual(alignToLine([-176.5,-59.5], [[180,-61.5],[199.8,-54]]), [183.5,-59.5]);
});
test('mercator does not wrap', () => {
  assert.deepEqual(toMerc([0,0]), [0.5,0.5]);
  assert.ok(toMerc([199.8,-54])[0] > 1);
  const p = fromMerc(toMerc([-98.6,19])); assert.ok(Math.abs(p[0]+98.6)<1e-9 && Math.abs(p[1]-19)<1e-9);
});
test('mercator clamps the poles', () => {
  assert.ok(Number.isFinite(toMerc([0,-90])[1]) && Number.isFinite(toMerc([0,90])[1]));
  const ring = [[0,0],[10,0],[10,-90],[0,-90],[0,0]];
  const {point} = poleOfInaccessibility([ring]);   // hung before the clamp: y = Infinity
  assert.ok(point.every(Number.isFinite) && pointInRing(point, ring));
});
test('area, inside, simple, nearest, angle', () => {
  const sq=[[0,0],[1,0],[1,1],[0,1],[0,0]];
  assert.equal(ringArea(sq),1); assert.ok(pointInRing([0.5,0.5],sq)); assert.ok(!pointInRing([2,2],sq));
  assert.ok(isSimpleRing(sq)); assert.ok(!isSimpleRing([[0,0],[1,1],[1,0],[0,1],[0,0]]));
  const n=nearestOnPolyline([5,1],[[0,0],[10,0]]); assert.equal(n.segIndex,0); assert.ok(Math.abs(n.point[0]-5)<1e-9 && Math.abs(n.point[1])<1e-9);
  assert.equal(segmentAngleDeg([0,0],[10,0]),0); assert.equal(segmentAngleDeg([0,0],[0,10]),-90); assert.equal(segmentAngleDeg([0,0],[0,-10]),90);
});
test('antimeridian ring unwraps closed', () => {
  const r = dedupe(unwrapLine(load('cat_high_t0.json').mod20am.geometry.coordinates));
  assert.deepEqual(r[0], r.at(-1));
  for (let i=1;i<r.length;i++) assert.ok(Math.abs(r[i][0]-r[i-1][0]) <= 180);
  assert.ok(Math.min(...r.map(p=>p[0])) < -200);   // -218.7 by reference
});
test('pole of inaccessibility honours holes (MOD 23 minus SEV 6)', () => {
  const r = poleOfInaccessibility([[[0,0],[10,0],[10,10],[0,10],[0,0]]]); assert.ok(Math.abs(r.point[0]-5)<0.2 && Math.abs(r.point[1]-5)<0.2);
  const {mod23, sev6} = load('cat_high_t0.json');
  const M = dedupe(unwrapLine(mod23.geometry.coordinates)), S = shiftNear(dedupe(unwrapLine(sev6.geometry.coordinates)), M[0][0]);
  assert.ok(pointInRing(poleOfInaccessibility([M]).point, S));   // control: no hole → (88.58,-37.36) inside SEV
  const a = poleOfInaccessibility([M,S]).point;                  // reference (75.05,-46.29)
  assert.ok(pointInRing(a,M) && !pointInRing(a,S));
});

// Web Mercator ends at ±MAX_LAT; MapLibre draws a vertex beyond it on the edge, so a line's parts
// beyond are cut off where the line crosses the edge, straight in Mercator as MapLibre draws it.
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
test('chartParts: a line within the chart is one part, unchanged', () => {
  const line = [[0, 10], [20, 84], [40, -85.051129], [60, 0]];
  assert.deepEqual(chartParts(line), [line]);
});
test('chartParts: a line that leaves the chart and comes back is cut at the edge into two parts', () => {
  const parts = chartParts([[0, 80], [10, 88], [20, 89], [30, 80]]);
  assert.equal(parts.length, 2);
  const t = (mercY(MAX_LAT) - mercY(80)) / (mercY(88) - mercY(80));
  assert.deepEqual(parts[0], [[0, 80], [10 * t, MAX_LAT]]);
  assert.equal(parts[1][0][1], MAX_LAT);
  assert.deepEqual(parts[1].at(-1), [30, 80]);
  assert.ok(parts.flat().every(([, y]) => Math.abs(y) <= MAX_LAT));
});
test('chartParts: a segment from beyond the north edge to beyond the south edge crosses the whole chart', () => {
  assert.deepEqual(chartParts([[0, 86], [0, -86]]), [[[0, MAX_LAT], [0, -MAX_LAT]]]);
});
test('chartParts: a line wholly beyond the chart has no parts', () => {
  assert.deepEqual(chartParts([[0, 86], [90, 88], [180, 87]]), []);
});
