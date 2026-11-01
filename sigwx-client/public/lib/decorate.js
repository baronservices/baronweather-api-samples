// Zoom-dependent decorations as generated geometry. Browser-safe ES module.
// Work is done in merc pixels at the given zoom (y down), and results go back to [lon,lat].
// In merc px, "right of travel" for a unit direction (dx, dy) is (-dy, dx); for a CCW
// lon/lat ring that is the outside.
import { toMerc, fromMerc } from './geo.js';

// World size in px at zoom z (Spike Results: 2048 at z2, 4096 at z3).
export const worldPx = (z) => 512 * 2 ** z;

// A lon/lat clip box [w, s, e, n] in merc px [x0, y0, x1, y1] at world size w.
function pxBox([west, south, east, north], w) {
  const [x0, y0] = toMerc([west, north]), [x1, y1] = toMerc([east, south]);
  return [x0 * w, y0 * w, x1 * w, y1 * w];
}
// True when the px box a, grown by m, meets the px box b in some world copy (w px
// apart; the map draws them all).
function meets(a, b, w, m = 0) {
  return a[1] - m <= b[3] && a[3] + m >= b[1]
    && Math.ceil((b[0] - a[2] - m) / w) <= Math.floor((b[2] - a[0] + m) / w);
}
const inBox = (p, b, w) => meets([p[0], p[1], p[0], p[1]], b, w);

// Projects coords to merc px and returns the non-zero-length segments with their
// start distance along the line.
function segments(coords, w) {
  const px = coords.map((p) => toMerc(p).map((v) => v * w));
  const segs = [];
  let total = 0;
  for (let i = 0; i + 1 < px.length; i++) {
    const a = px[i], dx = px[i + 1][0] - a[0], dy = px[i + 1][1] - a[1];
    const len = Math.hypot(dx, dy);
    if (!len) continue;
    segs.push({ a, ux: dx / len, uy: dy / len, len, start: total });
    total += len;
  }
  return { segs, total };
}

// The stretches [t0, t1] (px along segment s) whose points can lie in the px box b
// grown by m, in any world copy: each copy's corners projected onto s, 1 px wider for
// rounding (callers make the exact test), clipped to s, merged.
function near(s, b, w, m) {
  const ex = s.a[0] + s.ux * s.len, ey = s.a[1] + s.uy * s.len;
  if (Math.min(s.a[1], ey) - m > b[3] || Math.max(s.a[1], ey) + m < b[1]) return [];
  const spans = [];
  for (let j = Math.ceil((b[0] - m - Math.max(s.a[0], ex)) / w); j <= Math.floor((b[2] + m - Math.min(s.a[0], ex)) / w); j++) {
    const ts = [b[0] - m, b[2] + m].flatMap((x) => [b[1] - m, b[3] + m].map((y) => (x - j * w - s.a[0]) * s.ux + (y - s.a[1]) * s.uy));
    const t0 = Math.max(0, Math.min(...ts) - 1), t1 = Math.min(s.len, Math.max(...ts) + 1);
    if (t0 <= t1) spans.push([t0, t1]);
  }
  spans.sort((p, q) => p[0] - q[0]);
  const merged = [];
  for (const sp of spans) {
    if (merged.length && sp[0] <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], sp[1]);
    else merged.push(sp);
  }
  return merged;
}

// Samples at distances first + k * step while < total: {k, p, ux, uy} in merc px. With
// a px box, only on the stretches within margin px of it, so the work follows what is
// in view rather than the whole line.
function samples({ segs, total }, first, step, box = null, w = 0, margin = 0) {
  const out = [];
  segs.forEach((s, i) => {
    const end = i === segs.length - 1 ? total : s.start + s.len;
    for (const [t0, t1] of box ? near(s, box, w, margin) : [[0, s.len]]) {
      let k = Math.max(0, Math.ceil((s.start + t0 - first) / step));
      while (k > 0 && first + (k - 1) * step >= s.start + t0) k--;
      for (let d; (d = first + k * step) < end && d <= s.start + t1; k++) {
        if (d < s.start) continue;
        const t = d - s.start;
        out.push({ k, p: [s.a[0] + s.ux * t, s.a[1] + s.uy * t], ux: s.ux, uy: s.uy });
      }
    }
  });
  return out;
}

const toLonLat = (q, w) => fromMerc([q[0] / w, q[1] / w]);

// CB scallops: the perimeter is split into round(perimeter / spacingPx) equal arcs
// (at least 2); each chord gets an 8-segment semicircle bulging right of travel.
// Input is a closed CCW lon/lat ring; output is a list of lines: the closed scalloped
// ring or, with a clip box (lon/lat), the runs of arcs with an end in it in any world
// copy. The arcs are always the whole ring's, so they hold still as the view
// moves. A ring shorter than 2 * spacingPx is returned unchanged, as the one line.
export function scallopRing(ring, zoom, spacingPx = 14, clip = null) {
  const w = worldPx(zoom), path = segments(ring, w);
  if (path.total < 2 * spacingPx) return [ring];
  const n = Math.max(2, Math.round(path.total / spacingPx)), step = path.total / n;
  const box = clip && pxBox(clip, w);
  // Arc i runs from point i to point i + 1 (mod n), one step apart, so both ends of an
  // arc with an end in the box lie on segments within the margin.
  const pts = new Map(samples(path, 0, step, box, w, 2 * step).filter((s) => s.k < n).map((s) => [s.k, s.p]));
  const arc = (i) => {
    const A = pts.get(i), B = pts.get((i + 1) % n);
    const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
    const r = Math.hypot(B[0] - A[0], B[1] - A[1]) / 2;
    if (!r) return [];
    const ux = (B[0] - A[0]) / (2 * r), uy = (B[1] - A[1]) / (2 * r);
    // theta runs pi -> 0: A, then the bulge at (-uy, ux), then B (B is the next arc's A).
    return Array.from({ length: 8 }, (_, k) => {
      const th = Math.PI - (k * Math.PI) / 8, c = Math.cos(th), s = Math.sin(th);
      return toLonLat([mx + r * (c * ux - s * uy), my + r * (c * uy + s * ux)], w);
    });
  };
  const shown = box
    ? [...new Set([...pts].filter(([, p]) => inBox(p, box, w)).flatMap(([k]) => [(k + n - 1) % n, k]))].sort((a, b) => a - b)
    : [...pts.keys()];
  if (shown.length === n) {
    const out = shown.flatMap((i) => arc(i));
    out.push(out[0].slice());
    return [out];
  }
  const runs = [];
  shown.forEach((i, j) => {
    if (shown[j - 1] !== i - 1) runs.push([]);
    runs.at(-1).push(...arc(i));
    if (shown[j + 1] !== i + 1) runs.at(-1).push(toLonLat(pts.get((i + 1) % n), w));
  });
  // A run through arc n - 1 that goes on into arc 0 is one line.
  if (runs.length > 1 && shown[0] === 0 && shown.at(-1) === n - 1) runs[0] = [...runs.pop().slice(0, -1), ...runs[0]];
  return runs.filter((l) => l.length > 1);
}

// Icing T-ticks: [[start, tip], …] in lon/lat. The first tick is spacingPx / 2 along
// the line, then one every spacingPx; each is lengthPx long, perpendicular to its
// segment, pointing to `side` ('left' or 'right') of the line's direction. With a clip
// box (lon/lat), only the ticks that start in it in any world copy.
export function tTicks(line, zoom, side = 'left', spacingPx = 18, lengthPx = 7, clip = null) {
  const w = worldPx(zoom), sgn = side === 'right' ? 1 : -1, box = clip && pxBox(clip, w);
  return samples(segments(line, w), spacingPx / 2, spacingPx, box, w).filter(({ p }) => !box || inBox(p, box, w)).map(({ p, ux, uy }) => [
    toLonLat(p, w),
    toLonLat([p[0] - sgn * uy * lengthPx, p[1] + sgn * ux * lengthPx], w),
  ]);
}
