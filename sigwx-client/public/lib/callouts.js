// Call-out placement in screen px. Pure and browser-safe; the overlay calls it
// after every move. A label that cannot be placed is reported as hidden, never dropped.
import { pointInRing } from './geo.js';
import { LABEL_DENSITY_DEFAULT } from './conventions.js';
import { leaderGeometry } from './style.js';

const GAP = 4; // a candidate grown by this on every side must not touch a placed box
const S = Math.SQRT1_2;
// Unit vectors for 45°, 135°, 225°, 315°, 0°, 90°, 180°, 270° in screen angles (90° is down).
const DIRS = [[S, S], [-S, S], [-S, -S], [S, -S], [1, 0], [0, 1], [-1, 0], [0, -1]];
const OFFSETS = [16, 48, 96];

// Label density from a number or a string (?density=, the slider), clamped to
// [0.5, 2]. Anything non-numeric or non-finite, including '', gives LABEL_DENSITY_DEFAULT.
export function clampDensity(v) {
  const n = typeof v === 'string' ? (v.trim() === '' ? NaN : Number(v)) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(2, Math.max(0.5, n)) : LABEL_DENSITY_DEFAULT;
}

// placeCallouts opts for density d: padding 4/d px, candidate distances [16, 48, 96]/d,
// plus [160, 240]/d when d > 1. Density never enables overlap.
export function densityOpts(d) {
  const k = clampDensity(d);
  return { padding: GAP / k, distances: [...OFFSETS, ...(k > 1 ? [160, 240] : [])].map((x) => x / k) };
}

const overlapsAny = (b, placed, gap) => placed.some((p) =>
  b.x - gap < p.x + p.w && p.x < b.x + b.w + gap && b.y - gap < p.y + p.h && p.y < b.y + b.h + gap);

const inViewport = (b, V) => b.x >= 0 && b.y >= 0 && b.x + b.w <= V.w && b.y + b.h <= V.h;

function touchesPoly(b, poly) {
  const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h], [b.x + b.w / 2, b.y + b.h / 2]];
  return pts.some((p) => pointInRing(p, poly));
}

// [x1, y1, ax, ay]: from the point on the box boundary nearest the anchor, to the anchor.
function leader(b, ax, ay) {
  const x0 = b.x, x1 = b.x + b.w, y0 = b.y, y1 = b.y + b.h;
  let ex = Math.min(Math.max(ax, x0), x1), ey = Math.min(Math.max(ay, y0), y1);
  if (ex === ax && ey === ay) { // anchor inside the box: move to the nearest side
    const d = [ax - x0, x1 - ax, ay - y0, y1 - ay], m = Math.min(...d);
    if (m === d[0]) ex = x0; else if (m === d[1]) ex = x1; else if (m === d[2]) ey = y0; else ey = y1;
  }
  return [ex, ey, ax, ay];
}

// The leader as the overlay draws it (style leaderGeometry): a cased shaft, and at the tip a
// cased arrowhead; at the defaults the shaft is cased 4 px wide and the head is 9 px long and
// 8 px wide, cased 1.5 px.

// The ink of leader [x1, y1, x2, y2] as thick segments [x1, y1, x2, y2, half-width]: the
// head (tip to base), then the shaft. A zero-length leader is a head-sized square at the tip.
export function leaderPieces([x1, y1, x2, y2]) {
  const { len: arrowLen, shaftHalf, headHalf } = leaderGeometry();
  const len = Math.hypot(x2 - x1, y2 - y1), head = Math.min(arrowLen, len);
  const bx = len ? x2 - ((x2 - x1) / len) * head : x2, by = len ? y2 - ((y2 - y1) / len) * head : y2;
  return len > head ? [[bx, by, x2, y2, headHalf], [x1, y1, bx, by, shaftHalf]] : [[bx, by, x2, y2, headHalf]];
}

// True when segment (x1, y1)–(x2, y2) meets box b grown by g px on every side (Liang–Barsky).
function segMeetsBox(x1, y1, x2, y2, b, g) {
  const dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, x1 - b.x + g], [dx, b.x + b.w + g - x1], [-dy, y1 - b.y + g], [dy, b.y + b.h + g - y1]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; t0 = Math.max(t0, t); } else { if (t < t0) return false; t1 = Math.min(t1, t); }
  }
  return true;
}
const leaderMeetsBox = (L, b) => leaderPieces(L).some(([x1, y1, x2, y2, g]) => segMeetsBox(x1, y1, x2, y2, b, g));

// True when leaders L and M cross strictly: each one's ends lie on opposite sides of the
// other's line. Touching or collinear leaders do not count.
const side = (ax, ay, bx, by, px, py) => Math.sign((bx - ax) * (py - ay) - (by - ay) * (px - ax));
const leadersCross = ([a, b, c, d], [e, f, g, h]) =>
  side(a, b, c, d, e, f) * side(a, b, c, d, g, h) < 0 && side(e, f, g, h, a, b) * side(e, f, g, h, c, d) < 0;

// Distance from (x, y) to the edges of ring.
function edgeDist(x, y, ring) {
  let d = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j], dx = ring[i][0] - ax, dy = ring[i][1] - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return d;
}

// Blocked anchor: walking the leader's line from the box edge (ex, ey) towards
// the anchor in STEP px steps, the first point inside the area (poly minus holes) and at
// least INSET px from its edges whose leader is clear. null when there is none.
const STEP = 2, INSET = 6;
function insideTip(ex, ey, ax, ay, poly, holes, clear) {
  const len = Math.hypot(ax - ex, ay - ey);
  if (!len) return null;
  const ux = (ax - ex) / len, uy = (ay - ey) / len;
  const inArea = (x, y) => pointInRing([x, y], poly) && !holes.some((h) => pointInRing([x, y], h));
  let t = 0;
  while (t <= len && !inArea(ex + ux * t, ey + uy * t)) t += STEP;
  for (t += INSET; t <= len; t += STEP) {
    const x = ex + ux * t, y = ey + uy * t;
    if (!inArea(x, y) || [poly, ...holes].some((r) => edgeDist(x, y, r) < INSET)) continue;
    if (clear([ex, ey, x, y])) return [ex, ey, x, y];
  }
  return null;
}

// items: [{id, priority, ax, ay, r, w, h, inView, poly, holes?}] in screen px; V: {w, h}.
// poly is the item's area ring and holes the rings cut out of it (a MOD area minus SEV).
// opts (all optional):
// - padding (px, default 4) and distances (candidate rings beyond r, default [16, 48, 96]);
// - blocked(box) → true rejects a box, e.g. one over any map label;
// - blockedSigwx(box), default blocked: the looser test (a hazard label may cover a place name), e.g. SIGWX labels
//   only. Each item first tries every candidate against blocked, then every candidate
//   against blockedSigwx, then a box moved off its anchor inside its area against each, then
//   is hidden; so a higher priority item is never starved by a lower one;
// - blockedSeg(x1, y1, x2, y2) → true when a leader from (x1, y1) with its arrowhead at
//   (x2, y2) crosses a SIGWX symbol or label. If the anchor itself is blocked
//   (blockedSeg(ax, ay, ax, ay)), a leader may end at the first clear point a few px
//   inside the area instead (insideTip); an item with no area then has no candidate.
// Whatever the opts, a leader never crosses a placed box or strictly crosses a placed
// leader, and a box never covers a placed leader (leaderPieces: shaft and arrowhead).
// Returns {placed: [{id, x, y, w, h, leader}] in placement order, hidden: [id]}.
export function placeCallouts(items, V, opts = {}) {
  const { padding = GAP, distances = OFFSETS, blocked = () => false, blockedSigwx = blocked, blockedSeg = () => false } = opts;
  const tiers = blockedSigwx === blocked ? [blocked] : [blocked, blockedSigwx];
  const sorted = [...items].sort((a, b) =>
    a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const placed = [], hidden = [];
  const free = (b) => !overlapsAny(b, placed, padding) && !placed.some((p) => p.leader && leaderMeetsBox(p.leader, b));
  const clear = (L) => !blockedSeg(...L) && !placed.some((p) => leaderMeetsBox(L, p) || (p.leader && leadersCross(L, p.leader)));

  // The first candidate for it that passes isBlocked: the box inside its area, then the
  // rings of outside boxes with a clear leader. null when there is none.
  function candidate(it, isBlocked, tipBlocked) {
    const { id, ax, ay, r, w, h, poly, holes = [] } = it;
    if (r >= Math.hypot(w, h) / 2) {
      const b = { id, x: ax - w / 2, y: ay - h / 2, w, h, leader: null };
      if (free(b) && !isBlocked(b)) return b;
    }
    for (const off of distances) {
      const c = r + off + Math.max(w, h) / 2;
      for (const [ux, uy] of DIRS) {
        const b = { id, x: ax + ux * c - w / 2, y: ay + uy * c - h / 2, w, h, leader: null };
        if (!inViewport(b, V) || !free(b) || (poly && touchesPoly(b, poly)) || isBlocked(b)) continue;
        const L = leader(b, ax, ay);
        if (!tipBlocked) b.leader = clear(L) ? L : null;
        else b.leader = poly ? insideTip(L[0], L[1], ax, ay, poly, holes, clear) : null;
        if (b.leader) return b;
      }
    }
    return null;
  }

  // The last resort, after every tier's candidates: a box moved off the anchor within the
  // inscribed circle, so still inside its area with no leader. For an area that fills the view
  // (its outside rings lie off-screen) whose centred box is blocked, e.g. by another area's
  // anchor at the same centre. null when there is none.
  function shifted(it, isBlocked) {
    const { id, ax, ay, r, w, h } = it;
    for (const off of distances) {
      if (off + Math.hypot(w, h) / 2 > r) break;
      for (const [ux, uy] of DIRS) {
        const b = { id, x: ax + ux * off - w / 2, y: ay + uy * off - h / 2, w, h, leader: null };
        if (inViewport(b, V) && free(b) && !isBlocked(b)) return b;
      }
    }
    return null;
  }

  for (const it of sorted) {
    const { id, ax, ay } = it;
    if (ax < 0 || ay < 0 || ax > V.w || ay > V.h) {
      if (it.inView) hidden.push(id);
      continue;
    }
    const tipBlocked = blockedSeg(ax, ay, ax, ay);
    let box = null;
    for (const isBlocked of tiers) if ((box = candidate(it, isBlocked, tipBlocked))) break;
    if (!box) for (const isBlocked of tiers) if ((box = shifted(it, isBlocked))) break;
    if (!box) { hidden.push(id); continue; }
    placed.push(box);
  }
  return { placed, hidden };
}
