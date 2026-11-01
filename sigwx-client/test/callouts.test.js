import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeCallouts, clampDensity, densityOpts } from '../public/lib/callouts.js';
import { LABEL_DENSITY_DEFAULT } from '../public/lib/conventions.js';

const V={w:800,h:600}, I=(o)=>({inView:true, poly:null, ...o});
test('fits inside → centred, no leader', () => {
  const {placed}=placeCallouts([I({id:'a',priority:4,ax:400,ay:300,r:80,w:60,h:60})],V);
  assert.equal(placed[0].leader,null); assert.equal(placed[0].x+placed[0].w/2,400);
});
test('priority wins, loser moves out, no overlap', () => {
  const {placed}=placeCallouts([I({id:'mod',priority:5,ax:400,ay:300,r:0,w:60,h:40}),I({id:'sev',priority:0,ax:400,ay:300,r:0,w:60,h:40})],V);
  assert.equal(placed[0].id,'sev'); const [a,b]=placed;
  assert.ok(a.x+a.w<=b.x||b.x+b.w<=a.x||a.y+a.h<=b.y||b.y+b.h<=a.y); assert.ok(placed.every(p=>p.leader));
});
test('inside collision falls through to outside', () => {
  const {placed}=placeCallouts([I({id:'p',priority:0,ax:400,ay:300,r:0,w:60,h:40}),I({id:'q',priority:1,ax:400,ay:300,r:200,w:60,h:40})],V);
  assert.ok(placed.find(p=>p.id==='q').leader);
});
test('outside box avoids its own elongated polygon', () => {
  const poly=[[0,250],[800,250],[800,350],[0,350],[0,250]];
  const {placed}=placeCallouts([I({id:'e',priority:4,ax:400,ay:300,r:50,w:120,h:80,poly})],V);
  assert.ok(placed[0].y >= 350);   // reference: the 90° candidate, y = 386
});
test('off-screen anchor: in view → hidden; not in view → ignored; no room → hidden', () => {
  assert.deepEqual(placeCallouts([I({id:'big',priority:0,ax:-50,ay:300,r:0,w:10,h:10})],V).hidden,['big']);
  assert.deepEqual(placeCallouts([I({id:'o',priority:0,ax:-50,ay:10,r:0,w:10,h:10,inView:false})],V),{placed:[],hidden:[]});
  assert.deepEqual(placeCallouts([I({id:'x',priority:0,ax:50,ay:30,r:0,w:90,h:50})],{w:100,h:60}).hidden,['x']);
});

// Label density: opts {padding, distances} (label density) and opts.blocked (MapLibre labels).
const near = (a, b) => Math.abs(a - b) < 1e-9;
test('opts omitted = explicit defaults {padding: 4, distances: [16, 48, 96]}', () => {
  const items = [I({id:'a',priority:0,ax:400,ay:300,r:0,w:60,h:40}), I({id:'b',priority:1,ax:410,ay:300,r:0,w:60,h:40}),
    I({id:'c',priority:2,ax:420,ay:310,r:30,w:60,h:40})];
  assert.deepEqual(placeCallouts(items, V, {padding:4, distances:[16,48,96]}), placeCallouts(items, V));
  assert.deepEqual(placeCallouts(items, V, {}), placeCallouts(items, V));
});
test('opts.distances sets the candidate rings', () => {
  const [p] = placeCallouts([I({id:'a',priority:0,ax:400,ay:300,r:10,w:20,h:20})], V, {distances:[100]}).placed;
  const c = 10 + 100 + 10;   // r + distance + max(w,h)/2, first direction 45° (down-right)
  assert.ok(near(p.x + 10, 400 + c * Math.SQRT1_2) && near(p.y + 10, 300 + c * Math.SQRT1_2));
});
test('opts.padding is the clearance between boxes', () => {
  // Both fit inside their areas; their boxes are 20 px apart vertically.
  const items = [I({id:'a',priority:0,ax:400,ay:300,r:100,w:40,h:20}), I({id:'b',priority:1,ax:400,ay:340,r:100,w:40,h:20})];
  assert.equal(placeCallouts(items, V).placed[1].leader, null);
  const b = placeCallouts(items, V, {padding:24}).placed[1];
  assert.equal(b.id, 'b'); assert.ok(b.leader);
});
test('opts.blocked rejects candidates (inside and outside); all blocked → hidden', () => {
  const it = I({id:'a',priority:0,ax:400,ay:300,r:100,w:40,h:20});
  const inside = placeCallouts([it], V).placed[0];
  assert.equal(inside.leader, null);
  const p = placeCallouts([it], V, {blocked:(b)=>b.x+b.w/2 >= 400}).placed[0];   // right half blocked
  assert.ok(p.leader && p.x + p.w/2 < 400);
  assert.deepEqual(placeCallouts([it], V, {blocked:()=>true}), {placed:[], hidden:['a']});
});
test('clampDensity: default 1.0, clamped to [0.5, 2.0], non-numeric → default', () => {
  assert.equal(LABEL_DENSITY_DEFAULT, 1);
  for (const [v, want] of [[1,1],[0.5,0.5],[2,2],[0.1,0.5],[5,2],['1.5',1.5],[' 2 ',2],['0',0.5],
    ['abc',1],['',1],[' ',1],[undefined,1],[null,1],[NaN,1],[Infinity,1]]) {
    assert.equal(clampDensity(v), want, `clampDensity(${JSON.stringify(v)})`);
  }
});
test('densityOpts: padding 4/d, distances [16,48,96]/d, plus [160,240]/d when d > 1', () => {
  assert.deepEqual(densityOpts(1), {padding:4, distances:[16,48,96]});
  assert.deepEqual(densityOpts(2), {padding:2, distances:[8,24,48,80,120]});
  assert.deepEqual(densityOpts(0.5), {padding:8, distances:[32,96,192]});
  assert.deepEqual(densityOpts(10), densityOpts(2));   // clamped
});

// Two tiers: each item tries candidates clear of everything (opts.blocked) first, then
// candidates clear of SIGWX obstacles only (opts.blockedSigwx, which ignores basemap labels),
// then is hidden: per item, inside the priority loop, never as a second whole-list pass.
test('opts.blockedSigwx: an item with no strict candidate takes a SIGWX-clear one before a lower priority', () => {
  const sev = I({id:'sev',priority:0,ax:400,ay:300,r:0,w:40,h:20}), mod = I({id:'mod',priority:5,ax:400,ay:300,r:0,w:40,h:20});
  const first = placeCallouts([sev], V).placed[0];   // the first candidate when nothing blocks
  const out = placeCallouts([mod, sev], V, {blocked:(b)=>b.id==='sev', blockedSigwx:()=>false});   // place names around every SEV candidate
  assert.deepEqual(out.hidden, []);
  const s = out.placed.find(p=>p.id==='sev'), m = out.placed.find(p=>p.id==='mod');
  assert.equal(out.placed[0].id, 'sev'); assert.deepEqual([s.x, s.y], [first.x, first.y]);
  assert.notDeepEqual([m.x, m.y], [first.x, first.y]);
});
test('opts.blockedSigwx: every strict candidate is tried before any SIGWX-only one', () => {
  const it = I({id:'a',priority:0,ax:400,ay:300,r:0,w:40,h:20});
  const first = placeCallouts([it], V).placed[0];
  let calls = 0;
  const spy = () => { calls++; return false; };
  const [p] = placeCallouts([it], V, {blocked:(b)=>b.x===first.x && b.y===first.y, blockedSigwx:spy}).placed;
  assert.notDeepEqual([p.x, p.y], [first.x, first.y]);
  assert.equal(calls, 0);   // a strict candidate was clear: the SIGWX-only tier is never consulted
  calls = 0;   // control: with no strict candidate, the SIGWX-only tier is consulted and places the item
  assert.equal(placeCallouts([it], V, {blocked:()=>true, blockedSigwx:spy}).placed.length, 1);
  assert.ok(calls > 0);
});

// A leader (its segment and arrowhead) must not cross a SIGWX obstacle
// (opts.blockedSeg) or a placed box, and a box must not cover a placed leader.
// Test-side: the segment against rect r grown by g px, sampled every 0.25 px.
const segHits = (x1, y1, x2, y2, r, g = 2) => {
  const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 4));
  for (let i = 0; i <= n; i++) {
    const x = x1 + (x2 - x1) * i / n, y = y1 + (y2 - y1) * i / n;
    if (x >= r.x - g && x <= r.x + r.w + g && y >= r.y - g && y <= r.y + r.h + g) return true;
  }
  return false;
};
test('opts.blockedSeg: a candidate whose leader crosses a SIGWX obstacle is rejected', () => {
  const label = {x:406,y:310,w:4,h:6};   // on the 45° leader, clear of the anchor and of the 135° leader
  const it = I({id:'a',priority:0,ax:400,ay:300,r:10,w:40,h:20});
  assert.ok(segHits(...placeCallouts([it], V).placed[0].leader, label));   // control: the first candidate's leader crosses it
  const [p] = placeCallouts([it], V, {blockedSeg:(...s)=>segHits(...s, label)}).placed;
  assert.ok(p.leader && !segHits(...p.leader, label));
  assert.deepEqual(p.leader.slice(2), [400, 300]);   // the anchor is clear, so the arrow still marks it
});
test('a leader never crosses a call-out box already placed', () => {
  const A = I({id:'A',priority:0,ax:409,ay:312,r:100,w:6,h:6});   // inside box 406..412 x 309..315
  const B = I({id:'B',priority:1,ax:400,ay:300,r:10,w:40,h:20});   // its 45° leader runs through A's box
  const {placed} = placeCallouts([A, B], V);
  const a = placed.find(p=>p.id==='A'), b = placed.find(p=>p.id==='B');
  assert.equal(a.leader, null);
  assert.ok(b && b.leader && !segHits(...b.leader, a, 0));
});
test('a box never covers a leader already placed', () => {
  const A = I({id:'A',priority:0,ax:400,ay:300,r:0,w:40,h:20});
  const B = I({id:'B',priority:1,ax:401,ay:306,r:100,w:6,h:6});   // its inside box would sit on A's leader
  const {placed} = placeCallouts([A, B], V);
  const a = placed.find(p=>p.id==='A'), b = placed.find(p=>p.id==='B');
  assert.ok(a.leader && segHits(...a.leader, {x:398,y:303,w:6,h:6}, 0));   // control: B's inside spot is on A's leader
  assert.ok(b && !segHits(...a.leader, b, 0));
});
test('blocked anchor: the arrow ends at the first clear point a few px inside the area', () => {
  const poly = [[300,200],[500,200],[500,400],[300,400],[300,200]];
  const label = {x:380,y:290,w:40,h:20};   // a jet label over the anchor
  const it = I({id:'a',priority:0,ax:400,ay:300,r:5,w:40,h:20,poly});
  assert.deepEqual(placeCallouts([it], V).placed[0].leader, [501,300,400,300]);   // control: the 0° box
  const [p] = placeCallouts([it], V, {blockedSeg:(...s)=>segHits(...s, label)}).placed;
  const [x1, y1, tx, ty] = p.leader;
  assert.deepEqual([x1, y1, ty], [501, 300, 300]);
  assert.ok(tx <= 494 && tx >= 480, `tip x ${tx}`);   // a few px inside the east edge (x = 500)
  assert.ok(!segHits(...p.leader, label));
});
test('blocked anchor: the arrow never ends in a hole (MOD minus SEV)', () => {
  const poly = [[300,200],[500,200],[500,400],[300,400],[300,200]], hole = [[470,280],[500,280],[500,320],[470,320],[470,280]];
  const label = {x:380,y:290,w:40,h:20};
  const it = I({id:'a',priority:5,ax:400,ay:300,r:5,w:40,h:20,poly,holes:[hole]});
  const [p] = placeCallouts([it], V, {blockedSeg:(...s)=>segHits(...s, label)}).placed;
  const tx = p.leader[2];
  assert.ok(tx <= 470 - 4 && tx > 422, `tip x ${tx}`);
});
test('blocked anchor with no area (a point) → hidden', () => {
  const label = {x:390,y:290,w:20,h:20};
  const it = I({id:'v',priority:2,ax:400,ay:300,r:0,w:40,h:20});
  assert.deepEqual(placeCallouts([it], V, {blockedSeg:(...s)=>segHits(...s, label)}), {placed:[], hidden:['v']});
});

// A leader never strictly crosses a leader already placed.
const crosses = ([a, b, c, d], [e, f, g, h]) => {
  const o = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return o(a, b, c, d, e, f) * o(a, b, c, d, g, h) < 0 && o(e, f, g, h, a, b) * o(e, f, g, h, c, d) < 0;
};
test('a leader never strictly crosses a leader already placed', () => {
  const W = {w:460, h:600}, opts = {distances:[100]};   // B's 45° box is off canvas
  const A = I({id:'A',priority:0,ax:300,ay:300,r:0,w:20,h:20}), B = I({id:'B',priority:1,ax:380,ay:300,r:0,w:20,h:20});
  assert.ok(crosses([312.2,367.8,380,300], placeCallouts([A], W, opts).placed[0].leader));   // control: B's 135° leader would cross A's
  const {placed} = placeCallouts([A, B], W, opts);
  const a = placed.find(p=>p.id==='A'), b = placed.find(p=>p.id==='B');
  assert.ok(a && b && a.leader && b.leader);
  assert.ok(!crosses(a.leader, b.leader), `B leader ${b.leader.map(Math.round)}`);
});

// Two areas that both fill the view share one anchor (the visible piece's centre). The box
// centred on it covers the other's anchor (the overlay's blocked rule) and the outside rings
// lie beyond the view, so each needs a box moved within its own area, with no leader.
test('areas that fill the view and share an anchor both get a box inside their area', () => {
  const items = [I({id:'cb',priority:4,ax:400,ay:300,r:1000,w:60,h:50}), I({id:'cat',priority:5,ax:400,ay:300,r:1000,w:60,h:50})];
  const covers = (b, it) => it.ax >= b.x && it.ax <= b.x + b.w && it.ay >= b.y && it.ay <= b.y + b.h;
  const blocked = (b) => items.some((it) => it.id !== b.id && covers(b, it));
  const { placed, hidden } = placeCallouts(items, V, { blocked });
  assert.deepEqual(hidden, []); assert.equal(placed.length, 2);
  for (const b of placed) {
    assert.equal(b.leader, null);
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= V.w && b.y + b.h <= V.h);
    assert.ok(!covers(b, items.find((it) => it.id !== b.id)));
  }
});
test('an inside box moved off its anchor stays within the inscribed circle', () => {
  // The area covers the view, so every outside box touches it; a box covering the anchor is
  // blocked. A 60x50 box clears the anchor 48 px from it, where its far corner is 87.05 px out:
  // inside r 90, outside r 80.
  const poly = [[-1000, -1000], [2000, -1000], [2000, 2000], [-1000, 2000]];
  const blocked = (b) => b.x <= 400 && 400 <= b.x + b.w && b.y <= 300 && 300 <= b.y + b.h;
  const corner = (b) => Math.max(...[[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(([x, y]) => Math.hypot(x - 400, y - 300)));
  const wide = placeCallouts([I({id:'a',priority:4,ax:400,ay:300,r:90,w:60,h:50,poly})], V, { blocked });
  assert.deepEqual(wide.hidden, []);
  const [a] = wide.placed;
  assert.equal(a.leader, null);
  assert.ok(!blocked(a));
  assert.ok(corner(a) <= 90, `corner ${corner(a)} px from the anchor, beyond r 90`);
  const narrow = placeCallouts([I({id:'a',priority:4,ax:400,ay:300,r:80,w:60,h:50,poly})], V, { blocked });
  assert.deepEqual(narrow.hidden, ['a'], `placed at ${JSON.stringify(narrow.placed[0])}`);
});
// The looser tier (SIGWX labels only) keeps the box centred on its anchor over a place
// name; moving the box off its anchor is the last resort, after both tiers.
test('a centred box over a place name is kept before an inside box is moved off its anchor', () => {
  const name = { x: 380, y: 290, w: 40, h: 16 };
  const overlaps = (b) => b.x < name.x + name.w && name.x < b.x + b.w && b.y < name.y + name.h && name.y < b.y + b.h;
  const { placed } = placeCallouts([I({id:'a',priority:4,ax:400,ay:300,r:1000,w:60,h:50})], V, { blocked: overlaps, blockedSigwx: () => false });
  assert.deepEqual([placed[0].x + placed[0].w / 2, placed[0].y + placed[0].h / 2], [400, 300]);
});
