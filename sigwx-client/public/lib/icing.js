// Open icing reconstruction. Browser-safe ES module.
// An open icing LineString is an icing area whose part inside a CB was cut away.
// It is closed along the adjoining CB ring. Everything here is PLANAR lon/lat
// degrees, as the model's coordinates are; do not use the merc geo.nearestOnPolyline here.
import { unwrapLine, dedupe, shiftNear, ringArea, isSimpleRing } from './geo.js';

const FALLBACK = () => ({ ring: null, side: 'left' });

// Nearest point on the ring's segments, planar degrees. First minimum wins.
export function nearestOnRing(p, ring) {
  let best = null;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i], b = ring[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    const q = [a[0] + t * dx, a[1] + t * dy];
    const dist = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (!best || dist < best.dist) best = { dist, segIndex: i, t, point: q };
  }
  return best;
}

// Strict crossing of a–b with c–d (0 < t < 1 and 0 < u < 1): {t, point} or null.
function segCross(a, b, c, d) {
  const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
  if (den === 0) return null;
  const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
  const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
  if (t > 0 && t < 1 && u > 0 && u < 1) return { t, point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] };
  return null;
}

// Cuts end jitter where the line crosses the ring: the last crossing in the
// first quarter becomes the start, the first crossing in the last quarter the end.
function trimToRing(L, R) {
  const xs = [];
  for (let i = 0; i < L.length - 1; i++) {
    for (let j = 0; j < R.length - 1; j++) {
      const c = segCross(L[i], L[i + 1], R[j], R[j + 1]);
      if (c) xs.push({ pos: i + c.t, point: c.point });
    }
  }
  xs.sort((x, y) => x.pos - y.pos || x.point[0] - y.point[0] || x.point[1] - y.point[1]);
  const n = L.length - 1;
  const head = xs.filter((x) => x.pos <= 0.25 * n), tail = xs.filter((x) => x.pos >= 0.75 * n);
  let out = L;
  if (tail.length) out = [...out.slice(0, Math.floor(tail[0].pos) + 1), tail[0].point];
  if (head.length) out = [head.at(-1).point, ...out.slice(Math.floor(head.at(-1).pos) + 1)];
  return out;
}

// Projection onto the ring; an end already on the ring keeps its own coordinates.
function nearExact(p, R) {
  const r = nearestOnRing(p, R);
  return r.dist < 1e-9 ? { ...r, point: [p[0], p[1]] } : r;
}

const same = (p, q) => p[0] === q[0] && p[1] === q[1];

// Closes T from its end, along R, back to its start; returns the smaller-area closure.
function closeOnRing(T, R) {
  const n = R.length - 1;
  const { segIndex: i0, t: t0, point: q0 } = nearExact(T[0], R);
  const { segIndex: i1, t: t1 } = nearExact(T.at(-1), R);
  const fwd = [];
  if (!(i1 === i0 && t1 <= t0)) {
    for (let k = i1; ;) { k = (k + 1) % n; fwd.push(R[k]); if (k === i0) break; }
  }
  const bwd = [];
  if (!(i1 === i0 && t1 >= t0)) {
    for (let k = i1; ;) { bwd.push(R[k]); if (k === (i0 + 1) % n) break; k = (k - 1 + n) % n; }
  }
  const close = (walk) => {
    const r = [...T, ...walk, q0];
    return same(r.at(-1), r[0]) ? r : [...r, r[0]];
  };
  const A = close(fwd), B = close(bwd);
  const a = ringArea(A), b = ringArea(B);
  return Math.abs(a) <= Math.abs(b) ? { ring: A, signed: a } : { ring: B, signed: b };
}

// -> {ring: closed CCW coords | null, side: 'left'|'right'} (side of the line, in line order).
export function reconstructOpenIcing(line, cbRings, maxGapDeg = 0.5) {
  const L = dedupe(unwrapLine(line));
  if (!L.length || !cbRings.length) return FALLBACK();
  const rings = cbRings.map((r) => shiftNear(dedupe(unwrapLine(r)), L[0][0]));
  const nearestRing = (p) => {
    let best = null;
    rings.forEach((R, k) => {
      const d = nearestOnRing(p, R).dist;
      if (!best || d < best.d) best = { d, k };
    });
    return best;
  };
  const e0 = nearestRing(L[0]), e1 = nearestRing(L.at(-1));
  if (e0.k !== e1.k || e0.d > maxGapDeg || e1.d > maxGapDeg) return FALLBACK();
  const R = rings[e0.k];
  const { ring, signed } = closeOnRing(trimToRing(L, R), R);
  if (!isSimpleRing(ring)) return FALLBACK();
  return signed > 0 ? { ring, side: 'left' } : { ring: ring.reverse(), side: 'right' };
}
