// Geometry helpers. Browser-safe ES module.
// Coordinates are [lon,lat]. "Merc" is Web-Mercator world units, y down;
// merc x is never wrapped, so it may lie outside [0, 1].

// The multiple of 360 that brings lon within 180° of refLon. Exactly 180°
// apart counts as within, so it is not shifted. `+ 0` turns -0 into 0.
export function wrapOffset(lon, refLon) {
  const x = (lon - refLon) / 360;
  return -360 * Math.sign(x) * Math.ceil(Math.abs(x) - 0.5) + 0;
}

export function wrapNear(lon, refLon) {
  return lon + wrapOffset(lon, refLon);
}

// Shifts each vertex by ±360 so it lies within 180° of the previous one.
export function unwrapLine(coords) {
  const out = [];
  for (const p of coords) {
    const lon = out.length ? wrapNear(p[0], out[out.length - 1][0]) : p[0];
    out.push([lon, p[1]]);
  }
  return out;
}

// Drops consecutive duplicate vertices.
export function dedupe(coords) {
  return coords.filter((p, i) => i === 0 || p[0] !== coords[i - 1][0] || p[1] !== coords[i - 1][1]);
}

// Shifts the whole line or ring by the offset that brings its first vertex near refLon.
export function shiftNear(coords, refLon) {
  if (!coords.length) return [];
  const k = wrapOffset(coords[0][0], refLon);
  return coords.map((p) => [p[0] + k, p[1]]);
}

// The copy of p (k = 0, -1, 1 worlds) nearest to the line in merc. Ties keep k = 0.
export function alignToLine(p, line) {
  let best = null;
  for (const k of [0, -1, 1]) {
    const q = [p[0] + k * 360, p[1]];
    const d = nearestOnPolyline(q, line).dist;
    if (!best || d < best.d) best = { q, d };
  }
  return best.q;
}

// Latitude is clamped to MapLibre's ±85.051129 so the poles stay finite. Only y is
// clamped; x is never wrapped, so lines and rings cross 180° without a jump.
export const MAX_LAT = 85.051129;

export function toMerc(p) {
  const phi = Math.max(-MAX_LAT, Math.min(MAX_LAT, p[1])) * Math.PI / 180;
  return [(p[0] + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2];
}

export function fromMerc(q) {
  return [q[0] * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * q[1]))) * 180 / Math.PI];
}

// The parts of a polyline within ±MAX_LAT, each cut where the line crosses an edge; MapLibre
// would draw the vertices beyond on the edge itself. The cut is straight in Mercator, as MapLibre
// draws the segment. Vertices within are kept as they are; a part needs 2 points.
export function chartParts(coords) {
  const Y = (lat) => Math.log(Math.tan(Math.PI / 4 + Math.max(-89.9999, Math.min(89.9999, lat)) * Math.PI / 360));
  const inside = (p) => Math.abs(p[1]) <= MAX_LAT;
  const cut = (a, b, lat) => [a[0] + ((Y(lat) - Y(a[1])) / (Y(b[1]) - Y(a[1]))) * (b[0] - a[0]), lat];
  const parts = [];
  let part = [];
  const end = () => { if (part.length > 1) parts.push(part); part = []; };
  coords.forEach((p, i) => {
    const a = coords[i - 1];
    if (a && inside(a) && !inside(p)) { part.push(cut(a, p, Math.sign(p[1]) * MAX_LAT)); end(); }
    else if (a && !inside(a) && inside(p)) part.push(cut(a, p, Math.sign(a[1]) * MAX_LAT));
    else if (a && !inside(a) && !inside(p) && Math.sign(a[1]) !== Math.sign(p[1])) {   // across the whole chart
      part.push(cut(a, p, Math.sign(a[1]) * MAX_LAT), cut(a, p, Math.sign(p[1]) * MAX_LAT)); end();
    }
    if (inside(p)) part.push(p);
  });
  end();
  return parts;
}

// Planar signed area in the ring's own units; CCW is positive. Open or closed rings.
export function ringArea(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

// True when the ray from (x, y) towards +x crosses edge a–b (even-odd rule).
function crossesRay(x, y, a, b) {
  return (a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0];
}

// Even-odd ray cast, planar in the ring's own units. Open or closed rings.
export function pointInRing(p, ring) {
  const [x, y] = p;
  let inside = false;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    if (crossesRay(x, y, ring[i], ring[j])) inside = !inside;
  }
  return inside;
}

function orient(p, q, r) {
  return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
}

// True when no two non-adjacent segments cross strictly. Touching or collinear
// segments do not count. The first and last segments are adjacent.
export function isSimpleRing(ring) {
  const r = ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring : [...ring, ring[0]];
  const n = r.length - 1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const a = r[i], b = r[i + 1], c = r[j], d = r[j + 1];
      if (orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0) return false;
    }
  }
  return true;
}

// Nearest point on the polyline, measured in merc. point is [lon,lat];
// dist and t are merc. A one-vertex line is a zero-length segment.
export function nearestOnPolyline(p, line) {
  const P = toMerc(p);
  const L = line.map(toMerc);
  if (L.length === 1) L.push(L[0]);
  let best = null;
  for (let i = 0; i < L.length - 1; i++) {
    const a = L[i], b = L[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.min(1, Math.max(0, ((P[0] - a[0]) * dx + (P[1] - a[1]) * dy) / len2)) : 0;
    const q = t === 0 ? a : t === 1 ? b : [a[0] + t * dx, a[1] + t * dy];
    const dist = Math.hypot(P[0] - q[0], P[1] - q[1]);
    if (!best || dist < best.dist) best = { q, segIndex: i, t, dist };
  }
  if (!best) return null;
  return { point: fromMerc(best.q), segIndex: best.segIndex, t: best.t, dist: best.dist };
}

// Screen angle of a→b in merc (y down), degrees, clockwise-positive:
// east 0, north -90, south 90.
export function segmentAngleDeg(a, b) {
  const A = toMerc(a), B = toMerc(b);
  return Math.atan2(B[1] - A[1], B[0] - A[0]) * 180 / Math.PI + 0;
}

// ---- pole of inaccessibility: the mapbox/polylabel cell queue, in merc ----

function segDistSq(x, y, a, b) {
  let px = a[0], py = a[1];
  const dx = b[0] - px, dy = b[1] - py;
  if (dx !== 0 || dy !== 0) {
    const t = ((x - px) * dx + (y - py) * dy) / (dx * dx + dy * dy);
    if (t > 1) { px = b[0]; py = b[1]; } else if (t > 0) { px += dx * t; py += dy * t; }
  }
  return (x - px) ** 2 + (y - py) ** 2;
}

// Signed distance to the polygon edges, holes included: positive inside, which is inside
// rings[0] and outside every hole, so overlapping holes or a hole past the edge stay out.
function polygonDist(x, y, rings) {
  let inside = false, min = Infinity;
  rings.forEach((ring, k) => {
    let odd = false;
    for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
      const a = ring[i], b = ring[j];
      if (crossesRay(x, y, a, b)) odd = !odd;
      min = Math.min(min, segDistSq(x, y, a, b));
    }
    if (k === 0) inside = odd; else if (odd) inside = false;
  });
  return min === 0 ? 0 : (inside ? 1 : -1) * Math.sqrt(min);
}

function cell(x, y, h, rings) {
  const d = polygonDist(x, y, rings);
  return { x, y, h, d, max: d + h * Math.SQRT2 };
}

// Area centroid of the outer ring, or its first vertex if that falls outside.
function centroidCell(rings) {
  const pts = rings[0];
  let area = 0, x = 0, y = 0;
  for (let i = 0, n = pts.length, j = n - 1; i < n; j = i++) {
    const a = pts[i], b = pts[j], f = a[0] * b[1] - b[0] * a[1];
    x += (a[0] + b[0]) * f; y += (a[1] + b[1]) * f; area += f * 3;
  }
  const c = area === 0 ? null : cell(x / area, y / area, 0, rings);
  return c && c.d >= 0 ? c : cell(pts[0][0], pts[0][1], 0, rings);
}

// Binary max-heap on cell.max.
class CellQueue {
  constructor() { this.a = []; }
  get length() { return this.a.length; }
  push(c) {
    const a = this.a;
    let i = a.push(c) - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].max >= a[i].max) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].max > a[m].max) m = l;
        if (r < a.length && a[r].max > a[m].max) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

// rings[0] is the outer ring; further rings are holes. Returns the point in
// [lon,lat] and the radius (distance to the nearest edge) in merc units.
export function poleOfInaccessibility(rings, precisionMerc = 1e-4) {
  const R = rings.map((r) => r.map(toMerc));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of R[0]) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const w = maxX - minX, hgt = maxY - minY;
  // Never smaller than the precision, so a sliver cannot spawn a huge grid.
  const size = Math.max(precisionMerc, Math.min(w, hgt));

  let best = centroidCell(R);
  const bbox = cell(minX + w / 2, minY + hgt / 2, 0, R);
  if (bbox.d > best.d) best = bbox;

  const queue = new CellQueue();
  const probe = (x, y, h) => {
    const c = cell(x, y, h, R);
    if (c.max > best.d + precisionMerc) queue.push(c);
    if (c.d > best.d) best = c;
  };
  for (let x = minX; x < maxX; x += size) {
    for (let y = minY; y < maxY; y += size) probe(x + size / 2, y + size / 2, size / 2);
  }
  while (queue.length) {
    const c = queue.pop();
    if (c.max - best.d <= precisionMerc) break;
    const h = c.h / 2;
    probe(c.x - h, c.y - h, h); probe(c.x + h, c.y - h, h);
    probe(c.x - h, c.y + h, h); probe(c.x + h, c.y + h, h);
  }
  return { point: fromMerc([best.x, best.y]), radius: best.d };
}
