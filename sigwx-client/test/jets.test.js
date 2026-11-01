import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.js';
import { nearestOnPolyline } from '../public/lib/geo.js';
import { composeFleche, classifyJetSymbols, jetInRange, buildJet } from '../public/lib/jets.js';

const sym = (kt, lon=0, lat=40, m=10668) => ({coordinates:[lon,lat], height:{value:m,units:'m'}, wind:{speed:kt/1.943844, speed_units:'m/s'}});
test('composeFleche', () => {
  assert.deepEqual(composeFleche(145),{pennants:2,feathers:4,halves:1}); assert.deepEqual(composeFleche(75),{pennants:1,feathers:2,halves:1});
  assert.deepEqual(composeFleche(200),{pennants:4,feathers:0,halves:0}); assert.deepEqual(composeFleche(80),{pennants:1,feathers:3,halves:0});
});
test('classify real jets', () => {
  let c = classifyJetSymbols(load('jet_high_t0_j0.json').symbols);
  assert.deepEqual(c.map(x=>x.kind), ['fleche','fleche','bar','bar','bar','fleche','bar','bar','fleche','bar','fleche']);
  assert.deepEqual(c.map(x=>x.label), [390,380,null,null,null,360,null,null,380,null,400]);
  c = classifyJetSymbols(load('jet_high_t4_j11.json').symbols);
  assert.deepEqual(c.map(x=>x.kind), ['fleche','bar','bar','bar','fleche','bar','bar','bar','fleche']);
  assert.deepEqual(c.map(x=>x.label), [380,null,null,350,340,null,null,null,340]);
  assert.deepEqual(classifyJetSymbols(load('jet_altmid_t2_j33.json').symbols).map(x=>x.kt), [100,85]);
});
test('non-20 kt step → fleche', () => {
  assert.deepEqual(classifyJetSymbols([90,110,130,115,95].map(k=>sym(k))).map(x=>x.kind), ['fleche','bar','fleche','fleche','fleche']);
});
test('partly-in-range jet keeps real FL labels', () => {
  const j = load('jet_high_t0_j7.json');
  assert.equal(jetInRange(j,'high'), true);
  assert.deepEqual(buildJet(j,{product:'sigwx',level:'high',id:'j7'}).points.filter(p=>p.properties.fl).map(p=>p.properties.fl), ['FL230','FL240','FL250']);
});
test('depth, hemisphere, arrow, popup', () => {
  const {line, points} = buildJet(load('jet_high_t4_j2.json'), {product:'sigwx',level:'high',id:'j'});
  for (const p of points) assert.ok(nearestOnPolyline(p.geometry.coordinates, line.geometry.coordinates).dist < 1e-12);
  const max = points.find(p=>p.properties.depth);
  assert.equal(max.properties.fl,'FL400'); assert.equal(max.properties.depth,'XXX/470'); assert.ok(max.properties.icon.endsWith('-sh'));
  assert.equal(max.properties.popup, 'Jet 160 KT at FL400. 80 KT or more from below FL250 (chart floor) to FL470');
  assert.equal(points.at(-1).properties.kind,'arrow');
});
test('antimeridian: symbols aligned before snapping', () => {
  const ctx={product:'sigwx',level:'high',id:'j'};
  const a = buildJet(load('jet_high_t0_j1.json'), ctx);
  assert.deepEqual(a.line.geometry.coordinates.slice(0,2), [[180,-61.5],[199.8,-54]]);
  const lon0 = a.points[0].geometry.coordinates[0]; assert.ok(lon0 > 180 && lon0 < 200);   // reference ≈183.5
  const b = buildJet(load('jet_high_t0_j0.json'), ctx).points[5].geometry.coordinates;
  assert.ok(Math.abs(b[0]-216.6158) < 0.01 && Math.abs(b[1]+31.6037) < 0.01);
});
test('≥120 kt maximum without depth → no depth label', () => {
  const jet = {geometry:{type:'LineString',coordinates:[[-140,-50],[-133,-49],[-126,-48]]}, symbols:[sym(140,-140,-50),sym(160,-133,-49),sym(140,-126,-48)]};
  const {points} = buildJet(jet,{product:'sigwx_alt',level:'high',id:'x'});
  assert.equal(points[1].properties.icon,'fleche-160-sh'); assert.equal(points.filter(p=>p.properties.depth).length,0);
});
test('every symbol point carries its numeric kt', () => {
  const {points} = buildJet(load('jet_high_t0_j0.json'), {product:'sigwx',level:'high',id:'j'});
  assert.equal(points[0].properties.kind,'fleche'); assert.equal(points[0].properties.kt, 90);
  assert.equal(points[2].properties.kind,'bar'); assert.equal(points[2].properties.kt, 90);
  assert.equal(points[5].properties.kt, 150);
  for (const p of points.slice(0, -1)) assert.equal(typeof p.properties.kt, 'number', p.properties.id);
  assert.equal(points.at(-1).properties.kind, 'arrow'); assert.equal('kt' in points.at(-1).properties, false);
});
test('a ? depth bound reads naturally in the popup; XXX is unchanged', () => {
  const jet = (depth) => ({geometry:{type:'LineString',coordinates:[[-90,-30],[-80,-30],[-70,-30]]},
    symbols:[sym(120,-90,-30), {...sym(160,-80,-30), depth:{...depth, units:'m'}}, sym(120,-70,-30)]});
  const max = (depth) => buildJet(jet(depth), {product:'sigwx',level:'high',id:'q'}).points[1].properties;
  let p = max({below:6706});   // top missing: depthAbove is 'unknown' → ?
  assert.equal(p.depth, 'XXX/?');
  assert.equal(p.popup, 'Jet 160 KT at FL350. 80 KT or more from below FL250 (chart floor) to an unknown top (not given in data)');
  p = max({above:14326});      // base missing: depthBelow is 'unknown' → ?
  assert.equal(p.depth, '?/470');
  assert.equal(p.popup, 'Jet 160 KT at FL350. 80 KT or more from an unknown base (not given in data) to FL470');
});
