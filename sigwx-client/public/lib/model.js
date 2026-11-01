// Feed model: one raw SIGWX timestep to render-ready GeoJSON (with the properties the
// map layers read) and call-out descriptors. Pure, browser-safe ES module.
import { mToFL, fmtLatLon } from './units.js';
import { LEVEL_RANGE } from './conventions.js';
import { formatBound, distributionLabel } from './format.js';
import { unwrapLine, dedupe, wrapNear, toMerc, fromMerc, ringArea, poleOfInaccessibility, MAX_LAT } from './geo.js';
import { jetInRange, buildJet } from './jets.js';
import { reconstructOpenIcing } from './icing.js';
import { priorityOf } from './style.js';

// {"<product>_<level>": {data: [...]}} -> {product, level, steps}. The key splits on its last '_'.
export function parseFeed(json) {
  const keys = Object.keys(json ?? {});
  if (keys.length !== 1) throw new Error(`parseFeed: expected one top-level key, got ${keys.length}`);
  const key = keys[0], i = key.lastIndexOf('_');
  return { product: key.slice(0, i), level: key.slice(i + 1), steps: json[key]?.data ?? [] };
}

const norm = (coords) => dedupe(unwrapLine(coords));
const coordsOf = (f) => (Array.isArray(f?.geometry?.coordinates) ? f.geometry.coordinates : []);
const feature = (type, coordinates, properties) => ({ type: 'Feature', geometry: { type, coordinates }, properties });
const collection = (features) => ({ type: 'FeatureCollection', features });

// Web Mercator ends at ±MAX_LAT: a feature wholly beyond one edge cannot be drawn and is left
// out. (Vertices beyond both edges are joined across the chart.)
const offChart = (pts) => pts.length > 0 && (pts.every((p) => p[1] > MAX_LAT) || pts.every((p) => p[1] < -MAX_LAT));

// A raw bare ring to {ring, line}, or null when fewer than 4 vertices remain: ring closed and
// CCW, line its boundary as drawn, which is the ring itself unless the ring goes round a
// pole. Such a ring unwraps to ends a whole turn apart. It is closed over that pole (lat ±90,
// the side of its mean latitude, so a 360° ring near the equator would be ambiguous) by a seam
// from its most poleward vertex, which no edge can cross since none reaches higher; its line is
// the boundary once round, from that vertex to its copy a turn later, with no seam or pole edge.
// (CAT outlines and CB scallops are drawn from the ring, so they also trace the seam and pole
// edge, and the anchor search takes the seam for an edge: all off the chart, so harmless, while
// that vertex is beyond MAX_LAT, as for every polar ring seen to 31 Oct 2026.)
function areaRing(coords) {
  const r = norm(coords);
  if (r.length > 2 && wrapNear(r[0][0], r.at(-1)[0]) !== r[0][0]) {
    const pole = r.reduce((a, p) => a + p[1], 0) >= 0 ? 90 : -90;
    if (r.at(-1)[1] === r[0][1] && Math.abs(wrapNear(r.at(-1)[0], r[0][0]) - r[0][0]) < 1e-9) r.pop();   // the closing vertex
    let k = 0;
    r.forEach((p, i) => { if (p[1] * pole > r[k][1] * pole) k = i; });
    const start = [wrapNear(r[k][0], 0), r[k][1]];
    let line = unwrapLine([start, ...r.slice(k + 1), ...r.slice(0, k), start]);
    let ring = [...line, [line.at(-1)[0], pole], [start[0], pole], start];
    if (ringArea(ring) < 0) { ring = ring.reverse(); line = line.reverse(); }
    return { ring, line };
  }
  if (r.length && (r[0][0] !== r.at(-1)[0] || r[0][1] !== r.at(-1)[1])) r.push([r[0][0], r[0][1]]);
  if (r.length < 4) return null;
  const ring = ringArea(r) < 0 ? r.reverse() : r;
  return { ring, line: ring };
}

function bboxOf(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

const bboxesMeet = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

// Area call-out: anchor at the pole of inaccessibility of the ring minus its holes,
// edge one inscribed radius east of it in merc. Holes are the SEV rings whose bbox
// meets the ring's (nested, sharing an edge or poking out past it), in every world copy
// where it does. A remainder too thin for the default search gets a finer one (1e-5
// merc, about 400 m); one thinner still counts as none, and with none the anchor is the
// ring's own pole.
function areaCallout(base, ring, sevRings) {
  const box = bboxOf(ring);
  const holes = sevRings.flatMap((S) => {
    const b = bboxOf(S), copies = [];
    for (let k = Math.ceil((box[0] - b[2]) / 360); k <= Math.floor((box[2] - b[0]) / 360); k++) copies.push(S.map(([x, y]) => [x + 360 * k, y]));
    return copies;
  }).filter((S) => bboxesMeet(bboxOf(S), box));
  let pole = poleOfInaccessibility([ring, ...holes]);
  if (pole.radius <= 0 && holes.length) pole = poleOfInaccessibility([ring, ...holes], 1e-5);
  if (pole.radius <= 0 && holes.length) pole = poleOfInaccessibility([ring]);
  const { point: anchor, radius } = pole;
  const m = toMerc(anchor);
  return { ...base, anchor, edge: fromMerc([m[0] + radius, m[1]]), ring, bbox: bboxOf([...ring, anchor]) };
}

// The point at half the line's planar length (degrees), moved off° to tickSide of
// the segment direction there.
function offsetMidpoint(line, tickSide, off = 0.25) {
  const len = [];
  for (let i = 0; i < line.length - 1; i++) len.push(Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]));
  let rest = len.reduce((a, b) => a + b, 0) / 2, i = 0;
  while (i < len.length - 1 && rest > len[i]) rest -= len[i++];
  const a = line[i], b = line[i + 1], t = Math.min(1, rest / len[i]);
  const ux = (b[0] - a[0]) / len[i], uy = (b[1] - a[1]) / len[i], s = tickSide === 'left' ? off : -off;
  return [a[0] + t * (b[0] - a[0]) - s * uy, a[1] + t * (b[1] - a[1]) + s * ux];
}

const bounds = (h, top, base, ctx) => [formatBound(h?.top, top, ctx), formatBound(h?.base, base, ctx)];
const hasPoint = (p) => Array.isArray(p?.coordinates) && p.coordinates.length >= 2;

// One raw timestep -> {valid, counts, geo, callouts}. ctx = {product, level}.
export function buildStep(raw, ctx) {
  const range = LEVEL_RANGE[ctx.level];
  if (!range) throw new Error(`buildStep: unknown level ${ctx.level}`);
  const topBelowFloor = (m) => m != null && mToFL(m) < range.floor;   // a present top under the chart floor

  const geo = { jetLine: [], jetPoint: [], cbRing: [], catFill: [], icingFill: [], icingLine: [], tropo: [], vtsPoint: [] };
  const counts = { jet: 0, cb: 0, cat: 0, icing: 0, tropo: 0, volcano: 0, tc: 0 };

  // Jets: in range, with at least 2 vertices after unwrap + dedupe.
  (raw.jet ?? []).forEach((j, i) => {
    if (!jetInRange(j, ctx.level) || norm(coordsOf(j)).length < 2 || offChart(coordsOf(j))) return;
    const { line, points } = buildJet(j, { ...ctx, id: `jet-${i}` });
    geo.jetLine.push(line); geo.jetPoint.push(...points); counts.jet++;
  });

  const cloud = (raw.cloud ?? []).map((c, i) => ({ c, i }));
  const cbs = cloud.filter(({ c }) => c.type === 'CB');
  // Open-icing closure uses every CB ring in the step, before the range filter;
  // rings of fewer than 4 vertices are left out, since reconstructOpenIcing cannot take them.
  const cbRingsRaw = cbs.map(({ c }) => coordsOf(c)).filter((r) => norm(r).length >= 4);

  // Areas wait for their anchors until every SEV ring of the step is known.
  const areas = { cat: [], icing: [] };
  const sevRings = (kind) => areas[kind].filter((a) => a.base.level === 'SEV').map((a) => a.ring);

  (raw.cat ?? []).forEach((c, i) => {
    if (topBelowFloor(c.height?.top) || offChart(coordsOf(c))) return;
    const ring = areaRing(coordsOf(c))?.ring;
    if (!ring) return;
    const [top, base] = bounds(c.height, 'catTop', 'catBase', ctx);
    const id = `cat-${i}`, level = c.level;
    const popup = `${level} TURB (CAT), top ${top.decode}, base ${base.decode}`;   // named as its box header names it
    geo.catFill.push(feature('Polygon', [ring], { id, popup, level }));
    areas.cat.push({ ring, base: { id, kind: 'cat', level, priority: priorityOf(`cat${level}`),
      symbol: level === 'SEV' ? 'turb-sev' : 'turb-mod', lines: [top.text, base.text], popup } });
    counts.cat++;
  });

  // Icing, in cloud order. Each entry is an area (anchored below) or a finished fallback call-out.
  const icing = [];
  for (const { c, i } of cloud) {
    if (!c.icing || topBelowFloor(c.icing.height?.top)) continue;
    const level = c.icing.level.split(' ')[0];   // 'MOD CLOUD' -> 'MOD'
    const [top, base] = bounds(c.icing.height, 'icingTop', 'icingBase', ctx);
    const id = `ice-${i}`;
    const head = { id, kind: 'icing', level, priority: priorityOf(`icing${level}`),
      symbol: level === 'SEV' ? 'ice-sev' : 'ice-mod', lines: [top.text, base.text] };
    const popup = `${level} icing, top ${top.decode}, base ${base.decode}`;

    let ring, line, tickSide = 'left', reconstructed = false;
    if (c.geometry?.type === 'LineString') {
      line = norm(coordsOf(c));
      if (line.length < 2) continue;
      const r = reconstructOpenIcing(coordsOf(c), cbRingsRaw);
      ring = r.ring && areaRing(r.ring)?.ring;
      if (ring) { tickSide = r.side; reconstructed = true; }
    } else {
      const a = areaRing(coordsOf(c));
      if (!a) continue;
      ({ ring, line } = a);   // CCW: ticks on the left point inward
    }
    if (offChart(ring ?? line)) continue;   // the area as rebuilt, which may reach the chart when its line does not

    if (ring) {
      geo.icingFill.push(feature('Polygon', [ring], { id, popup, level }));
      geo.icingLine.push(feature('LineString', line, { id: `${id}-line`, popup, level, tickSide, reconstructed, fallback: false }));
      const entry = { ring, base: { ...head, popup } };
      areas.icing.push(entry); icing.push(entry);
    } else {
      // Fallback: the line only, iced side assumed left; a flagged heuristic,
      // drawn dashed (fallback: true).
      const fbPopup = `${popup}. Open line: area not rebuilt, iced side assumed left (heuristic)`;
      geo.icingLine.push(feature('LineString', line, { id, popup: fbPopup, level, tickSide, reconstructed, fallback: true }));
      const anchor = offsetMidpoint(line, tickSide);
      icing.push({ callout: { ...head, popup: fbPopup, anchor, edge: null, ring: null, bbox: bboxOf([...line, anchor]) } });
    }
    counts.icing++;
  }

  const cbCallouts = [];
  for (const { c, i } of cbs) {
    if (topBelowFloor(c.height?.top) || offChart(coordsOf(c))) continue;
    const ring = areaRing(coordsOf(c))?.ring;
    if (!ring) continue;
    const [top, base] = bounds(c.height, 'cbTop', 'cbBase', ctx);
    const id = `cb-${i}`, dist = distributionLabel(c.distribution);
    const popup = `${dist} CB, top ${top.decode}, base ${base.decode}`;
    geo.cbRing.push(feature('Polygon', [ring], { id, popup, distribution: c.distribution }));
    cbCallouts.push(areaCallout({ id, kind: 'cb', level: null, priority: priorityOf('cb'), symbol: null,
      lines: [dist, 'CB', top.text, base.text], popup }, ring, []));
    counts.cb++;
  }

  (raw.tropo?.spot ?? []).forEach((p, i) => {
    const fl = mToFL(p.height?.value);
    if (!hasPoint(p) || !(fl >= range.floor && fl <= range.ceiling) || offChart([p.coordinates])) return;
    geo.tropo.push(feature('Point', p.coordinates, { id: `tropo-${i}`, popup: `Tropopause FL${fl}`, label: String(fl) }));
    counts.tropo++;
  });

  const pointCallout = (id, kind, symbol, lines, popup, p) =>
    ({ id, kind, level: null, priority: priorityOf(kind), anchor: p, edge: null, ring: null, bbox: [p[0], p[1], p[0], p[1]], symbol, lines, popup });

  const vtsCallouts = [];
  (raw.vts?.volcano ?? []).forEach((v, i) => {
    if (!hasPoint(v) || offChart([v.coordinates])) return;
    const id = `vol-${i}`, name = v.name ?? '', at = fmtLatLon(v.coordinates);
    const popup = `Volcano ${name}, ${at}`;
    geo.vtsPoint.push(feature('Point', v.coordinates, { id, popup, icon: 'volcano' }));
    vtsCallouts.push(pointCallout(id, 'volcano', 'volcano', [name, at], popup, v.coordinates));
    counts.volcano++;
  });
  (raw.vts?.storm ?? []).forEach((s, i) => {
    if (!hasPoint(s) || offChart([s.coordinates])) return;
    const name = /^\d+$/.test(s.name ?? '') ? `${s.name} (NAME UNVERIFIED)` : s.name || 'NN';
    const id = `tc-${i}`, icon = s.coordinates[1] < 0 ? 'tc-sh' : 'tc-nh', at = fmtLatLon(s.coordinates);
    const popup = `Tropical cyclone ${name}, ${at}`;
    geo.vtsPoint.push(feature('Point', s.coordinates, { id, popup, icon }));
    vtsCallouts.push(pointCallout(id, 'tc', icon, [name, at], popup, s.coordinates));
    counts.tc++;
  });

  const catSev = sevRings('cat'), icingSev = sevRings('icing');
  const callouts = [
    ...areas.cat.map((a) => areaCallout(a.base, a.ring, a.base.level === 'MOD' ? catSev : [])),
    ...icing.map((e) => e.callout ?? areaCallout(e.base, e.ring, e.base.level === 'MOD' ? icingSev : [])),
    ...cbCallouts,
    ...vtsCallouts,
  ];

  const out = {};
  for (const [k, v] of Object.entries(geo)) out[k] = collection(v);
  return { valid: raw.valid_begin, counts, geo: out, callouts };
}
