import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.js';
import { parseFeed, buildStep } from '../public/lib/model.js';
import { dedupe, unwrapLine, pointInRing, shiftNear, ringArea, isSimpleRing } from '../public/lib/geo.js';

const step = (o) => ({valid_begin:'2026-10-21T12:00:00Z', jet:[], cloud:[], cat:[], ...o});
test('empty and missing keys are safe', () => {
  const s=buildStep(step({}),{product:'sigwx',level:'high'});
  assert.deepEqual(s.counts,{jet:0,cb:0,cat:0,icing:0,tropo:0,volcano:0,tc:0}); assert.equal(s.callouts.length,0);
});
test('parseFeed', () => { assert.deepEqual(parseFeed({sigwx_alt_mid:{data:[]}}),{product:'sigwx_alt',level:'mid',steps:[]}); });
test('MOD anchor avoids its SEV hole', () => {
  const {mod23, sev6}=load('cat_high_t0.json'); const s=buildStep(step({cat:[mod23,sev6]}),{product:'sigwx',level:'high'});
  const mod=s.callouts.find(c=>c.level==='MOD'); const S=dedupe(unwrapLine(sev6.geometry.coordinates));
  assert.ok(!pointInRing(mod.anchor, shiftNear(S, mod.anchor[0])));
});
// MOD-minus-SEV beyond the nested case: the anchor is inside MOD and outside every SEV ring.
const square = (x0,y0,x1,y1) => [[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]];
const seq = (a,b,d) => Array.from({length:Math.round((b-a)/d)+1},(_,i)=>+(a+i*d).toFixed(4));
const MODSQ = square(0,0,10,10);
for (const [name, sevs] of [
  ['a SEV poking out past the MOD edge', [square(3,3,12,7)]],
  ['a SEV with 90%+ of its vertices inside and a lobe outside MOD', [[...seq(3,7,0.25).map(x=>[x,3]),[7,2],[16,2],[16,8],[7,8],...seq(7,3,-0.25).map(x=>[x,7]),...seq(6.75,3.25,-0.25).map(y=>[3,y]),[3,3]]]],
  ['two overlapping SEVs', [square(1,1,7,9), square(3,1,9,9)]],
]) test(`MOD anchor: ${name}`, () => {
  const cat = [{level:'MOD',geometry:{type:'Polygon',coordinates:MODSQ},height:{top:11000,base:9000}},
    ...sevs.map(r=>({level:'SEV',geometry:{type:'Polygon',coordinates:r},height:{top:11000,base:9000}}))];
  const mod = buildStep(step({cat}),{product:'sigwx',level:'high'}).callouts.find(c=>c.level==='MOD');
  assert.ok(pointInRing(mod.anchor, MODSQ), `anchor ${mod.anchor} outside MOD`);
  for (const r of sevs) assert.ok(!pointInRing(mod.anchor, r), `anchor ${mod.anchor} inside a SEV`);
});
const both = (M, S) => buildStep(step({cat:[{level:'MOD',geometry:{type:'Polygon',coordinates:M}},
  {level:'SEV',geometry:{type:'Polygon',coordinates:S}}]}),{product:'sigwx',level:'high'}).callouts;
const modOf = (M, S) => both(M, S).find(c=>c.level==='MOD');
test('MOD anchor: a SEV that overlaps MOD only in another world copy', () => {
  // The SEV crosses the antimeridian (160..185 once unwrapped); MOD's first vertex is at 0.
  const M=[[0,0],[160,0],[160,-10],[179,-10],[179,10],[160,10],[160,1],[0,1],[0,0]];
  const [mod, sev] = ['MOD','SEV'].map(l=>both(M, square(-175,-11,160,11)).find(c=>c.level===l));
  assert.ok(pointInRing(mod.anchor, M), `anchor ${mod.anchor} outside MOD`);
  assert.ok(!pointInRing(mod.anchor, shiftNear(sev.ring, mod.anchor[0])), `anchor ${mod.anchor} inside the SEV`);
});
test('MOD anchor: a MOD that runs on through two more worlds meets the SEV in each', () => {
  const M=[[0,0],[160,0],[320,0],[480,0],[640,0],[720,0],[720,-10],[880,-10],[880,10],[720,10],[720,1],[640,1],[480,1],[320,1],[160,1],[0,1],[0,0]];
  const mod = modOf(M, square(0,-11,160,11));
  for (const d of [0,360,720]) assert.ok(!pointInRing(mod.anchor, square(d,-11,160+d,11)), `anchor ${mod.anchor} inside the SEV at +${d}`);
});
test('MOD anchor: a MOD-minus-SEV strip narrower than the default search precision', () => {
  const mod = modOf(MODSQ, square(-1,-1,9.99,11));
  assert.ok(pointInRing(mod.anchor, MODSQ) && !pointInRing(mod.anchor, square(-1,-1,9.99,11)), `anchor ${mod.anchor}`);
});
test('MOD anchor: a SEV covering all of MOD leaves the anchor at the MOD pole, not a corner', () => {
  const mod = modOf(MODSQ, square(-1,-1,11,11));
  assert.deepEqual(mod.anchor.map(Math.round), [5,5]); assert.ok(mod.edge[0] > mod.anchor[0]);
});
test('alt-high CAT base FL160 prints XXX', () => {
  const s=buildStep(step({cat:[load('cat_althigh_t0_c0.json')]}),{product:'sigwx_alt',level:'high'});
  assert.deepEqual(s.callouts[0].lines,['400','XXX']); assert.equal(s.callouts[0].symbol,'turb-sev');
  // The popup names the hazard as its box header does, with CAT spelled out in the KEY.
  assert.equal(s.callouts[0].popup, 'SEV TURB (CAT), top FL400, base below FL250 (chart floor)');
  assert.equal(s.geo.catFill.features[0].properties.popup, s.callouts[0].popup);
});
test('antimeridian polygon stays in one world copy', () => {
  const s=buildStep(step({cat:[load('cat_high_t0.json').mod20am]}),{product:'sigwx',level:'high'});
  const r=s.geo.catFill.features[0].geometry.coordinates[0]; for (let i=1;i<r.length;i++) assert.ok(Math.abs(r[i][0]-r[i-1][0])<=180);
});
test('TC mirroring, NN, unverified name', () => {
  const s=buildStep(step({vts:{storm:[{coordinates:[52.3,-5.5],name:''},{coordinates:[128.3,19.5],name:'5'}],volcano:[]}}),{product:'sigwx',level:'high'});
  const [a,b]=s.callouts; assert.equal(a.symbol,'tc-sh'); assert.equal(a.lines[0],'NN'); assert.equal(b.symbol,'tc-nh'); assert.equal(b.lines[0],'5 (NAME UNVERIFIED)');
});
test('right-sided reconstructed icing keeps tickSide right', () => {
  const a=load('icing_altmid_t0.json'); const cb=a.cbRings.map(r=>({type:'CB',distribution:'OCNL',geometry:{type:'Polygon',coordinates:r},height:{top:12000,units:'m'}}));
  const s=buildStep(step({cloud:[...cb, a.line49]}),{product:'sigwx_alt',level:'mid'});
  assert.equal(s.geo.icingLine.features.find(f=>f.properties.reconstructed).properties.tickSide,'right');
  assert.ok(s.geo.icingLine.features.every(f=>f.properties.fallback===false));   // rebuilt boundaries are not fallback lines
});

// ---- Review Focus 2 and the carried degenerate-input contracts ----
const ZERO = {jet:0,cb:0,cat:0,icing:0,tropo:0,volcano:0,tc:0};
test('a step with every key missing builds empty collections', () => {
  for (const raw of [{valid_begin:'2026-10-21T12:00:00Z'}, step({tropo:{}, vts:{}})]) {
    const s=buildStep(raw,{product:'sigwx',level:'mid'});
    assert.deepEqual(s.counts,ZERO); assert.equal(s.callouts.length,0);
    for (const fc of Object.values(s.geo)) assert.deepEqual(fc,{type:'FeatureCollection',features:[]});
  }
});
test('degenerate geometry is skipped, never thrown', () => {
  const sym={coordinates:[0,40],height:{value:10668,units:'m'},wind:{speed:50,speed_units:'m/s'}};
  const line=(c)=>({type:'LineString',coordinates:c}), poly=(c)=>({type:'Polygon',coordinates:c});
  const s=buildStep(step({
    jet:[{symbols:[sym]}, {geometry:line([[0,40],[0,40]]),symbols:[sym]}],
    cat:[{level:'MOD',geometry:poly([[0,0],[1,0],[0,0]]),height:{top:12000,units:'m'}}],
    cloud:[
      {type:'CB',distribution:'OCNL',geometry:poly([[5,5],[5,5]]),height:{top:12000,units:'m'}},   // throws inside reconstructOpenIcing if passed
      {icing:{level:'MOD CLOUD',height:{top:5000,units:'m'}},geometry:poly([[0,0],[1,1],[0,0]])},
      {icing:{level:'MOD CLOUD',height:{top:5000,units:'m'}},geometry:line([[7,7],[7,7]])},
      {icing:{level:'SEV CLOUD',height:{top:5000,units:'m'}},geometry:line([[5,5.1],[6,5.1]])},
    ],
  }),{product:'sigwx',level:'mid'});
  assert.deepEqual(s.counts,{...ZERO,icing:1});
  assert.equal(s.geo.icingLine.features.length,1); assert.equal(s.geo.icingLine.features[0].properties.reconstructed,false);
});
test('fallback icing anchor: length-midpoint 0.25° left, inside its own bbox', () => {
  // Length 4: the midpoint is (2,0) on the first segment; left of eastward is north.
  // The line's own bbox is flat (lat 0), so the anchor at lat 0.25 must widen it.
  const ice={icing:{level:'MOD CLOUD',height:{base:4000,top:5000,units:'m'}},geometry:{type:'LineString',coordinates:[[0,0],[3,0],[4,0]]}};
  const s=buildStep(step({cloud:[ice]}),{product:'sigwx',level:'mid'});
  const [c]=s.callouts, [f]=s.geo.icingLine.features;
  assert.deepEqual(c.anchor,[2,0.25]); assert.equal(c.edge,null); assert.equal(c.ring,null);
  assert.deepEqual(c.bbox,[0,0,4,0.25]); assert.equal(c.id,f.properties.id);
  assert.deepEqual(f.properties,{id:'ice-0',popup:c.popup,level:'MOD',tickSide:'left',reconstructed:false,fallback:true});
  assert.deepEqual(c.lines,['164','131']); assert.equal(c.symbol,'ice-mod'); assert.equal(s.geo.icingFill.features.length,0);
});
test('emitted rings are closed and CCW; CB call-out lines', () => {
  const cw=[[0,0],[0,4],[4,4],[4,0]];   // clockwise and open
  const s=buildStep(step({cat:[{level:'SEV',geometry:{type:'Polygon',coordinates:cw},height:{top:12000,units:'m'}}],
    cloud:[{type:'CB',distribution:'FREQ',geometry:{type:'Polygon',coordinates:cw}}]}),{product:'sigwx',level:'mid'});
  for (const fc of [s.geo.catFill, s.geo.cbRing]) {
    const r=fc.features[0].geometry.coordinates[0];
    assert.deepEqual(r[0],r.at(-1)); assert.equal(r.length,5); assert.ok(ringArea(r)>0);
  }
  const cb=s.callouts.find(c=>c.kind==='cb');
  assert.deepEqual(cb.lines,['FRQ','CB','XXX','XXX']); assert.equal(cb.priority,4); assert.equal(cb.id,'cb-0');
  assert.deepEqual(cb.anchor.map(v=>Math.round(v)),[2,2]); assert.ok(cb.edge[0]>cb.anchor[0]);
  assert.ok(cb.bbox[0]<=cb.anchor[0] && cb.anchor[0]<=cb.bbox[2] && cb.bbox[1]<=cb.anchor[1] && cb.anchor[1]<=cb.bbox[3]);
});

// Rings around a pole unwrap to ends 360° apart (live feeds carry MOD CAT and icing rings
// round the North Pole). The area is the cap inside the ring, closed over the pole.
const around = (lat, wobble = 0) => [...Array.from({length: 36}, (_, i) => [-180 + i * 10, lat + (i % 2) * wobble]), [-180, lat]];
const midIcing = (coords, top = 6000) => ({ icing: { level: 'MOD CLOUD', height: { top, base: 3000 } }, geometry: { type: 'Polygon', coordinates: coords } });
test('an icing ring round the North Pole is the cap inside it, not a band down to its start latitude', () => {
  const s = buildStep(step({ cloud: [midIcing(around(80, 2))] }), { product: 'sigwx', level: 'mid' });
  const ring = s.geo.icingFill.features[0].geometry.coordinates[0];
  assert.ok(pointInRing([0, 84], ring), 'the cap north of the ring is iced');
  assert.ok(!pointInRing([0, 70], ring), 'south of the ring is not');
  assert.ok(s.callouts[0].anchor[1] > 80, `anchor ${s.callouts[0].anchor} not in the cap`);
});
test('the boundary line of a polar icing ring has no pole points and its ticks point to the pole', () => {
  const s = buildStep(step({ cloud: [midIcing(around(80, 2))] }), { product: 'sigwx', level: 'mid' });
  const f = s.geo.icingLine.features[0], line = f.geometry.coordinates;
  assert.ok(line.every(([, y]) => Math.abs(y) < 90));
  const east = line[1][0] > line[0][0];   // travelling east, left is north
  assert.equal(f.properties.tickSide, east ? 'left' : 'right');
});
test('a ring round the South Pole closes over the South Pole', () => {
  const s = buildStep(step({ cloud: [midIcing(around(-80, 2))] }), { product: 'sigwx', level: 'mid' });
  const ring = s.geo.icingFill.features[0].geometry.coordinates[0];
  assert.ok(pointInRing([0, -84], ring) && !pointInRing([0, -70], ring));
});
// A real ring (SIGWX ALT MID, cloud 176, 18Z 31 Oct 2026) that also crosses its first vertex's
// meridian at 83.4°N and 89.05°N: a seam from that vertex to the pole would cut through it.
test('a polar ring that recrosses its start meridian is closed by a seam that cuts nothing', () => {
  const { ice176 } = load('icing_altmid_polar.json');
  const s = buildStep(step({ cloud: [ice176] }), { product: 'sigwx_alt', level: 'mid' });
  const ring = s.geo.icingFill.features[0].geometry.coordinates[0];
  assert.ok(isSimpleRing(ring), 'the emitted ring crosses itself');
  const inAny = (p) => [-360, 0, 360].some((k) => pointInRing([p[0] + k, p[1]], ring));
  assert.ok(!inAny([-115, 84]), 'the bay at 115°W 84°N is not iced');
  assert.ok(inAny([-100, 80]), 'the cap at 100°W 80°N is iced');
});
// The boundary of a ring closed over a pole is the open line once round, from a vertex to that
// vertex a turn later with the area on its left (east round the North Pole, west round the
// South): every raw vertex, those beyond 85.05° too, and no pole point.
for (const [name, coords] of [
  ['open', around(80, 2).slice(0, -1)],
  ['explicitly closed', around(80, 2)],
  ['partly beyond 85.05°', around(84, 2)],
  ['closed by a vertex on the start meridian at another latitude', [...around(80, 2).slice(0, -1), [-180, 75]]],
  ['round the South Pole, drawn westward', around(-80, 2).reverse()],
  ['round the North Pole, drawn westward', around(80, 2).reverse()],
  ['round the South Pole, drawn eastward', around(-80, 2)],
]) test(`polar boundary line: ${name}`, () => {
  const s = buildStep(step({ cloud: [midIcing(coords)] }), { product: 'sigwx', level: 'mid' });
  const line = s.geo.icingLine.features[0].geometry.coordinates;
  const distinct = new Set(coords.map(([x, y]) => `${(x + 360) % 360},${y}`)).size;
  assert.equal(line.at(-1)[0] - line[0][0], coords[0][1] > 0 ? 360 : -360);
  assert.equal(line.at(-1)[1], line[0][1]);
  assert.equal(line.length, distinct + 1);
  assert.ok(line.every(([, y]) => Math.abs(y) < 90));
});
test('a ring with a vertex at the pole that does not wind round it keeps its whole boundary', () => {
  const s = buildStep(step({ cloud: [midIcing([[0, 80], [10, 80], [10, 90], [0, 80]])] }), { product: 'sigwx', level: 'mid' });
  const line = s.geo.icingLine.features[0].geometry.coordinates;
  assert.equal(line.length, 4);
  assert.deepEqual(line[0], line.at(-1));
});
// Web Mercator ends at ±85.051129°: a feature wholly beyond it cannot be drawn, so it is left
// out (no feature, count or call-out) rather than squashed onto the map's top edge.
test('areas, lines and points wholly beyond 85.05° are left out', () => {
  const s = buildStep(step({
    cat: [{ level: 'MOD', geometry: { type: 'Polygon', coordinates: around(86.5, 1.5) }, height: { top: 12000, base: 9000 } }],
    cloud: [{ icing: { level: 'MOD CLOUD', height: { top: 6000, base: 3000 } }, geometry: { type: 'LineString', coordinates: [[0, 87], [40, 88], [80, 87.5]] } }],
    tropo: { spot: [{ coordinates: [10, 88.2], height: { value: 10700 } }] },
    vts: { volcano: [{ name: 'X', coordinates: [20, 86] }] },
  }), { product: 'sigwx', level: 'high' });
  assert.deepEqual([s.counts.cat, s.counts.tropo, s.counts.volcano], [0, 0, 0]);
  assert.equal(s.callouts.length, 0);
  const m = buildStep(step({ cloud: [{ icing: { level: 'MOD CLOUD', height: { top: 6000, base: 3000 } }, geometry: { type: 'LineString', coordinates: [[0, 87], [40, 88], [80, 87.5]] } }] }), { product: 'sigwx', level: 'mid' });
  assert.equal(m.counts.icing, 0);
});
test('a feature reaching below 85.05° is kept', () => {
  const s = buildStep(step({ tropo: { spot: [{ coordinates: [10, 84.9], height: { value: 10700 } }] } }), { product: 'sigwx', level: 'high' });
  assert.equal(s.counts.tropo, 1);
});
test('a feature with vertices beyond both 85.05°N and 85.05°S crosses the chart and is kept', () => {
  const s = buildStep(step({ cat: [{ level: 'MOD', geometry: { type: 'Polygon', coordinates: [[0, 86], [20, 86], [20, -86], [0, -86], [0, 86]] }, height: { top: 12000, base: 9000 } }] }), { product: 'sigwx', level: 'high' });
  assert.equal(s.counts.cat, 1);
});
test('an open icing line beyond 85.05° whose rebuilt area reaches the chart is kept', () => {
  const cb = { type: 'CB', distribution: 'OCNL', geometry: { type: 'Polygon', coordinates: [[0, 84], [10, 84], [10, 89], [0, 89], [0, 84]] }, height: { top: 12000, units: 'm' } };
  const ice = { icing: { level: 'MOD CLOUD', height: { top: 6000, base: 3000 } }, geometry: { type: 'LineString', coordinates: [[0, 86], [10, 86]] } };
  const s = buildStep(step({ cloud: [cb, ice] }), { product: 'sigwx', level: 'mid' });
  assert.equal(s.counts.icing, 1);
  assert.ok(pointInRing([5, 84.5], s.geo.icingFill.features[0].geometry.coordinates[0]));
});
