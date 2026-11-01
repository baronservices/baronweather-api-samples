// Hazard call-outs: an app-owned canvas over the map draws a box, with a
// leader arrow when it sits outside its area, for every CB, turbulence, icing, volcano and
// TC call-out, and reports those it cannot place. Browser ES module.
import { placeCallouts, densityOpts, clampDensity, leaderPieces } from '../lib/callouts.js';
import { LABEL_DENSITY_DEFAULT } from '../lib/conventions.js';
import { wrapOffset } from '../lib/geo.js';
import { STYLE, calloutLine, calloutBorderGrow, leaderGeometry, canvasFont } from '../lib/style.js';
import { drawSymbol, mapSize } from './symbols.js';

// The call-out fonts (11px "Noto Sans Mono", regular and bold, by default).
export const calloutFont = () => canvasFont(STYLE.callouts.weight, STYLE.callouts.size, STYLE.fonts.labels);
export const calloutHeaderFont = () => canvasFont(STYLE.callouts.headerWeight, STYLE.callouts.size, STYLE.fonts.labels);

// The SIGWX layers whose placed symbols and labels a box must not cover (no overlapping
// text). jet-arrows take part in collision, so they are found here too. A box
// also avoids the basemap's own symbol layers (place names) when it can; when it cannot,
// a hazard call-out outranks a place name and covers it.
export const LABEL_LAYERS = ['vts-symbols', 'jet-arrows', 'jet-symbols', 'tropo', 'graticule-labels', 'graticule-labels-10'];
// The layers a leader, shaft and arrowhead, must not cross, and the graticule
// labels. Not vts-symbols: a volcano's leader ends on its own icon.
export const LEADER_LAYERS = ['jet-symbols', 'jet-arrows', 'tropo', 'graticule-labels', 'graticule-labels-10'];

// The hazard header. CB boxes have none: their model lines already read
// OCNL/FRQ, CB, top, base.
export function headerOf(c) {
  if (c.kind === 'cat') return [c.level, 'TURB'].filter(Boolean).join(' ');
  if (c.kind === 'icing') return [c.level, 'ICE'].filter(Boolean).join(' ');
  if (c.kind === 'volcano') return 'VOLCANO';
  if (c.kind === 'tc') return 'TROPICAL CYCLONE';
  return null;
}

// Box size and content in CSS px: the header (bold) on top, then the symbol in an 18 px
// square left of the model lines; lines are centred in their column (default sizes).
export function boxLayout(ctx, c) {
  const C = STYLE.callouts, line = calloutLine();
  const header = headerOf(c), lines = c.lines ?? [], symbol = c.symbol ?? null;
  ctx.font = calloutHeaderFont();
  const headW = header ? ctx.measureText(header).width : 0;
  ctx.font = calloutFont();
  const textW = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
  const bodyW = (symbol ? C.symbolSize + C.symbolGap : 0) + textW;
  const bodyH = Math.max(symbol ? C.symbolSize : 0, lines.length * line);
  return {
    header, lines, symbol, textW,
    w: Math.ceil(2 * C.paddingX + Math.max(headW, bodyW)),
    h: Math.ceil(2 * C.paddingY + (header ? line : 0) + bodyH),
  };
}

// Draws one box at (x, y): white, 1.5 px black border, black text (default colours). A
// border of width 0 is not drawn (canvas ignores lineWidth = 0).
export function drawBox(ctx, x, y, L) {
  const C = STYLE.callouts, line = calloutLine(), sym = C.symbolSize, gap = C.symbolGap;
  ctx.fillStyle = C.fill;
  ctx.fillRect(x, y, L.w, L.h);
  if (C.borderWidth > 0) {
    ctx.strokeStyle = C.border;
    ctx.lineWidth = C.borderWidth;
    ctx.strokeRect(x, y, L.w, L.h);
  }
  ctx.fillStyle = C.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let top = y + C.paddingY;
  if (L.header) {
    ctx.font = calloutHeaderFont();
    ctx.fillText(L.header, x + L.w / 2, top + line / 2);
    top += line;
  }
  const bodyH = L.h - C.paddingY - (top - y);
  ctx.font = calloutFont();
  if (L.symbol) {
    const left = x + (L.w - (sym + gap + L.textW)) / 2;
    drawSymbol(ctx, L.symbol, left + sym / 2, top + bodyH / 2, sym);
    const cx = left + sym + gap + L.textW / 2, t0 = top + (bodyH - L.lines.length * line) / 2;
    L.lines.forEach((s, i) => ctx.fillText(s, cx, t0 + i * line + line / 2));
  } else {
    const t0 = top + (bodyH - L.lines.length * line) / 2;
    L.lines.forEach((s, i) => ctx.fillText(s, x + L.w / 2, t0 + i * line + line / 2));
  }
}

// Leader [x1, y1, ax, ay]: from the box edge to the anchor, arrowhead at the
// anchor. A white casing keeps it visible on the dark and satellite basemaps; a casing of
// width 0 is not drawn.
export function drawLeader(ctx, [x1, y1, ax, ay]) {
  const len = Math.hypot(ax - x1, ay - y1);
  if (len < 1) return;
  const S = STYLE.callouts.leader, G = leaderGeometry();
  const ux = (ax - x1) / len, uy = (ay - y1) / len;
  const head = Math.min(G.len, len), bx = ax - ux * head, by = ay - uy * head;
  const tri = () => {
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx - uy * G.half, by + ux * G.half);
    ctx.lineTo(bx + uy * G.half, by - ux * G.half);
    ctx.closePath();
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (S.casingWidth > 0) {
    ctx.strokeStyle = S.casing;
    ctx.lineWidth = S.casingWidth;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(bx, by); ctx.stroke();
    tri(); ctx.lineWidth = G.headCasing; ctx.stroke();
  }
  ctx.strokeStyle = ctx.fillStyle = S.color;
  ctx.lineWidth = S.width;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(bx, by); ctx.stroke();
  tri(); ctx.fill();
}

// Visible parts (every visible hazard area carries a call-out). An area whose ring
// crosses the canvas edge can show as several separate pieces, joined off screen, and its
// model anchor may be off screen. Such a ring is rasterised on a CELL px grid: the ring,
// minus every SEV area of the same kind in view for a MOD area (MOD minus SEV),
// clipped to the canvas. Each connected piece at least MIN_CLEAR px from its edges (the
// canvas edges included) gets its own call-out: the piece holding the on-screen model
// anchor uses that anchor; any other uses its own pole (the cell farthest from its edges).
// A ring with no visible piece that wide keeps the old rule: counted and listed as hidden
// when its anchor is off screen; a ring with no visible cell at all is not in view.
// A large piece can span the screen, its lobes far from its one box, so it also gets up to
// REPEATS repeat boxes: at its deepest cells (clearance >= REPEAT_MIN_R px) at least
// REPEAT_PX px from its other anchors. Repeats are placed after every other box and are
// best effort: one that does not fit is dropped, not counted as hidden.
// Point features (volcano, TC) and open icing lines (no ring) are never rasterised.
// Switch it off with the style's callouts.edgePieces = false; callouts.repeats sets REPEATS
// (max), REPEAT_PX (spacing) and REPEAT_MIN_R (minClearance).
const CELL = 4, MIN_CLEAR = 4;
let raster = null;

// [{ax, ay, r, cells, model, repeats: [{ax, ay, r}]}] for the visible pieces of poly minus
// holes (screen px), the largest first. model marks the piece that contains (mx, my), whose
// repeats keep their distance from (mx, my). [] when nothing is visible.
function visibleParts(poly, holes, W, H, mx, my) {
  const gw = Math.ceil(W / CELL), gh = Math.ceil(H / CELL), n = gw * gh;
  if (!raster || raster.width !== gw || raster.height !== gh) raster = new OffscreenCanvas(gw, gh);
  const g = raster.getContext('2d', { willReadFrequently: true });
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, gw, gh);
  g.setTransform(1 / CELL, 0, 0, 1 / CELL, 0, 0);
  const fill = (ring) => {
    g.beginPath();
    ring.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fill();
  };
  g.fillStyle = '#000';
  fill(poly);
  g.globalCompositeOperation = 'destination-out';
  holes.forEach(fill);
  const px = g.getImageData(0, 0, gw, gh).data, mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = px[4 * i + 3] >= 128 ? 1 : 0;

  // Chamfer (3-4) distance to the nearest empty cell; outside the grid counts as empty.
  const d = new Float32Array(n), at = (i, ok) => (ok ? d[i] : 0);
  for (let y = 0; y < gh; y++) {
    for (let x = 0, i = y * gw; x < gw; x++, i++) {
      if (!mask[i]) continue;
      d[i] = Math.min(at(i - 1, x > 0) + 3, at(i - gw, y > 0) + 3,
        at(i - gw - 1, x > 0 && y > 0) + 4, at(i - gw + 1, x < gw - 1 && y > 0) + 4);
    }
  }
  for (let y = gh - 1; y >= 0; y--) {
    for (let x = gw - 1, i = y * gw + x; x >= 0; x--, i--) {
      if (!mask[i]) continue;
      d[i] = Math.min(d[i], at(i + 1, x < gw - 1) + 3, at(i + gw, y < gh - 1) + 3,
        at(i + gw + 1, x < gw - 1 && y < gh - 1) + 4, at(i + gw - 1, x > 0 && y < gh - 1) + 4);
    }
  }

  // 4-connected pieces; each keeps its count and its deepest cell.
  const seen = new Uint8Array(n), stack = new Int32Array(n), parts = [];
  const mi = mx >= 0 && my >= 0 && mx < W && my < H ? Math.floor(my / CELL) * gw + Math.floor(mx / CELL) : -1;
  const pt = (i) => ({ ax: (i % gw + 0.5) * CELL, ay: (Math.floor(i / gw) + 0.5) * CELL, r: (d[i] / 3 - 0.5) * CELL });
  for (let s = 0; s < n; s++) {
    if (!mask[s] || seen[s]) continue;
    let top = 0, best = s, model = false;
    const cells = [];
    stack[top++] = s; seen[s] = 1;
    while (top) {
      const i = stack[--top], x = i % gw;
      cells.push(i);
      if (d[i] > d[best]) best = i;
      if (i === mi) model = true;
      for (const [j, ok] of [[i - 1, x > 0], [i + 1, x < gw - 1], [i - gw, i >= gw], [i + gw, i + gw < n]]) {
        if (ok && mask[j] && !seen[j]) { seen[j] = 1; stack[top++] = j; }
      }
    }
    const { max: REPEATS, spacing: REPEAT_PX, minClearance: REPEAT_MIN_R } = STYLE.callouts.repeats;
    const anchors = [model ? { ax: mx, ay: my } : pt(best)], repeats = [];
    while (repeats.length < REPEATS) {
      let pick = -1;
      for (const i of cells) {
        if ((pick < 0 || d[i] > d[pick]) && pt(i).r >= REPEAT_MIN_R) {
          const q = pt(i);
          if (anchors.every((a) => Math.hypot(a.ax - q.ax, a.ay - q.ay) >= REPEAT_PX)) pick = i;
        }
      }
      if (pick < 0) break;
      anchors.push(pt(pick)); repeats.push(pt(pick));
    }
    parts.push({ ...pt(best), cells: cells.length, model, repeats });
  }
  return parts.sort((a, b) => b.cells - a.cells);
}

const offScreen = (x, y, W, H) => x < 0 || y < 0 || x > W || y > H;
const crossesEdge = (poly, W, H) => poly.some(([x, y]) => offScreen(x, y, W, H));

// How far a hazard's ink reaches past its geometry, in px: half its icon (plus halo)
// for a volcano or TC; the scallop bulge for a CB (half the scallop chord, 7 px by
// default), plus half its line; the casing for CAT; half the line for
// an icing boundary, plus its T-ticks on an open fallback line (decorate.js). Approximations,
// as before: a chord can exceed the style's by rounding, and a long tick can cross an area.
export function inkMargin(map, c) {
  const S = STYLE;
  if (c.kind === 'volcano' || c.kind === 'tc') return (mapSize(c.symbol) ?? 24) / 2 + S.symbols.haloWidth;
  if (c.kind === 'cb') return S.cb.scallop / 2 + S.cb.width / 2;
  if (c.kind === 'cat') return Math.max(S.turbulence.casing.width, S.turbulence.outline.width) / 2;
  const half = Math.max(S.icing.line.width, S.icing.ticks.width) / 2;
  return c.ring ? half : S.icing.ticks.length + half;
}

// True when some segment of line (screen px) comes within m px of the canvas.
export function nearCanvas(line, W, H, m) {
  const x0 = -m, y0 = -m, x1 = W + m, y1 = H + m;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i], dx = line[i + 1][0] - ax, dy = line[i + 1][1] - ay;
    let t0 = 0, t1 = 1;   // Liang–Barsky
    for (const [pp, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
      if (pp === 0) { if (q < 0) { t0 = 1; t1 = 0; } continue; }
      const t = q / pp;
      if (pp < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    }
    if (t0 <= t1) return true;
  }
  return false;
}

// An open icing line (no area: the fallback) whose model anchor is off screen is
// labelled at the middle of its longest run inside the canvas (inset by EDGE px), LINE_OFF px
// to its iced side: the feature's tickSide ('left' or 'right' of the line direction, which
// the fallback sets to left). Screen y points down, so the left of screen direction
// (sx, sy) is (sy, -sx). null when no part of the line is inside.
const EDGE = 8, LINE_OFF = 6;
function visibleLinePoint(line, W, H, side = 'left') {
  const off = side === 'right' ? -LINE_OFF : LINE_OFF;
  const x0 = EDGE, y0 = EDGE, x1 = W - EDGE, y1 = H - EDGE;
  const runs = [];
  let run = null;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i], [bx, by] = line[i + 1], dx = bx - ax, dy = by - ay;
    let t0 = 0, t1 = 1;   // Liang–Barsky
    for (const [pp, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
      if (pp === 0) { if (q < 0) { t0 = 1; t1 = 0; } continue; }
      const t = q / pp;
      if (pp < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    }
    if (t0 >= t1) { run = null; continue; }
    const a = [ax + t0 * dx, ay + t0 * dy], b = [ax + t1 * dx, ay + t1 * dy];
    if (!run || t0 > 0) runs.push(run = [a]);
    run.push(b);
    if (t1 < 1) run = null;
  }
  let best = null, bestLen = 0;
  for (const r of runs) {
    let len = 0;
    for (let i = 0; i < r.length - 1; i++) len += Math.hypot(r[i + 1][0] - r[i][0], r[i + 1][1] - r[i][1]);
    if (len > bestLen) { best = r; bestLen = len; }
  }
  if (!best) return null;
  let rest = bestLen / 2;
  for (let i = 0; i < best.length - 1; i++) {
    const [ax, ay] = best[i], [bx, by] = best[i + 1], len = Math.hypot(bx - ax, by - ay);
    if (rest <= len || i === best.length - 2) {
      const t = len ? Math.min(1, rest / len) : 0, sx = len ? (bx - ax) / len : 1, sy = len ? (by - ay) / len : 0;
      return { ax: ax + t * (bx - ax) + sy * off, ay: ay + t * (by - ay) - sx * off };
    }
    rest -= len;
  }
  return null;
}

// The call-out in screen px at the world copy nearest the map centre: one offset k for the
// anchor, edge, ring and bbox (new arrays; the model's are never touched). inView: the bbox
// grown by the ink margin m meets the canvas.
function project(map, c, refLng, W, H) {
  const k = wrapOffset(c.anchor[0], refLng), m = inkMargin(map, c);
  const P = (lon, lat) => { const p = map.project([lon + k, lat]); return [p.x, p.y]; };
  const [ax, ay] = P(c.anchor[0], c.anchor[1]);
  const [ex, ey] = c.edge ? P(c.edge[0], c.edge[1]) : [ax, ay];
  const [x0, y0] = P(c.bbox[0], c.bbox[3]), [x1, y1] = P(c.bbox[2], c.bbox[1]);
  const inView = x1 >= -m && x0 <= W + m && y1 >= -m && y0 <= H + m;
  return { k, m, ax, ay, r: Math.hypot(ex - ax, ey - ay), inView, poly: inView && c.ring ? c.ring.map(([lon, lat]) => P(lon, lat)) : null };
}

// createOverlay(map, {onHiddenChange}) → {setCallouts, setDensity, redraw, hitTest, last}.
// setCallouts(callouts, lines?): lines maps a ring-less call-out's id to
// {coords: [[lon, lat]], side: its tickSide}.
// onHiddenChange([{callout, lngLat}], placed count) runs after every placement; lngLat is
// the point the hidden box would have marked.
export function createOverlay(map, { onHiddenChange = () => {} } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'sigwx-overlay';
  canvas.setAttribute('aria-hidden', 'true');
  map.getCanvasContainer().appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let callouts = [], lines = new Map(), density = LABEL_DENSITY_DEFAULT, W = 0, H = 0, dpr = 1;
  let result = { placed: [], hidden: [] }, entries = new Map(), items = [];

  function size() {
    const c = map.getCanvas();
    W = c.clientWidth; H = c.clientHeight; dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
  }

  function clear() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // Symbol layers to avoid when it can: ours plus the basemap's, listed once per style
  // (setStyle drops and re-adds every layer). Hidden layers are never placed, so they never
  // block.
  let symbolLayers = null;
  map.on('style.load', () => { symbolLayers = null; });
  const avoidLayers = () => {
    let base = symbolLayers;
    if (!base) {
      base = (map.getStyle()?.layers ?? []).filter((l) => l.type === 'symbol' && !LABEL_LAYERS.includes(l.id)).map((l) => l.id);
      if (map.isStyleLoaded()) symbolLayers = base;   // cache only a complete list
    }
    return [...LABEL_LAYERS, ...base].filter((id) => map.getLayer(id));
  };

  // A candidate box is rejected when it would leave the canvas (an inside box is centred on
  // its anchor, which the placer does not check), cover another call-out's anchor (its arrow
  // would vanish) or cover a placed map symbol or label other than its own feature's:
  // strict counts every symbol layer, the basemap's place names included; sigwx counts only
  // ours (LABEL_LAYERS), the placer's fallback when strict leaves no room.
  // Repeat anchors never constrain a primary box (repeats are placed last, best effort).
  function blockedBy(items, pad) {
    const primary = items.filter((it) => !entries.get(it.id).repeat);
    const test = (layers) => (b) => {
      if (b.x < 0 || b.y < 0 || b.x + b.w > W || b.y + b.h > H) return true;
      const x0 = b.x - pad, y0 = b.y - pad, x1 = b.x + b.w + pad, y1 = b.y + b.h + pad;
      const anchors = entries.get(b.id).repeat ? items : primary;
      if (anchors.some((it) => it.id !== b.id && it.ax >= x0 && it.ax <= x1 && it.ay >= y0 && it.ay <= y1)) return true;
      if (!layers.length) return false;
      return map.queryRenderedFeatures([[x0, y0], [x1, y1]], { layers }).some((f) => f.properties?.id !== b.id);
    };
    return { strict: test(avoidLayers()), sigwx: test(LABEL_LAYERS.filter((id) => map.getLayer(id))) };
  }

  // blockedSeg for the placer. A leader [x1, y1, x2, y2], shaft and arrowhead
  // (leaderPieces), is blocked when it meets a placed jet symbol or label, jet arrow, TROP
  // box or graticule label (LEADER_LAYERS). Each piece's box, grown by its half-width, is
  // queried; a hit is halved until the piece is under SEG_MIN px long, so a clear leader
  // costs one query per piece.
  const SEG_MIN = 4;
  function leaderBlockedBy() {
    const layers = LEADER_LAYERS.filter((id) => map.getLayer(id));
    if (!layers.length) return () => false;
    const seg = (x1, y1, x2, y2, g) => {
      const box = [[Math.min(x1, x2) - g, Math.min(y1, y2) - g], [Math.max(x1, x2) + g, Math.max(y1, y2) + g]];
      if (!map.queryRenderedFeatures(box, { layers }).length) return false;
      if (Math.hypot(x2 - x1, y2 - y1) <= SEG_MIN) return true;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      return seg(x1, y1, mx, my, g) || seg(mx, my, x2, y2, g);
    };
    return (x1, y1, x2, y2) => leaderPieces([x1, y1, x2, y2]).some((piece) => seg(...piece));
  }

  // One placement item per call-out, or per visible piece of an area that crosses the
  // canvas edge (ids '<id>', '<id>#1', …). entries: item id → {c, L, ax, ay, lngLat, part}.
  // A MOD area's item carries the SEV areas of its kind in view as holes, so a leader that
  // ends inside the area never ends in one of them.
  function itemsFor(refLng) {
    const projected = callouts.map((c) => ({ c, p: project(map, c, refLng, W, H), L: boxLayout(ctx, c) }));
    const items = [];
    entries = new Map();
    const holesOf = new Map();
    const holes = (c) => {
      if (!holesOf.has(c)) {
        holesOf.set(c, c.level === 'MOD'
          ? projected.filter((o) => o.c.kind === c.kind && o.c.level === 'SEV' && o.p.poly).map((o) => o.p.poly)
          : []);
      }
      return holesOf.get(c);
    };
    // A border wider than 1.5 px grows the placed box by its excess, so its ink is placed too.
    const e = calloutBorderGrow();
    const add = (id, c, L, ax, ay, r, inView, poly, lngLat, part, repeat = false) => {
      entries.set(id, { c, L, ax, ay, lngLat, part, repeat });
      items.push({ id, priority: c.priority + (repeat ? 100 : 0), ax, ay, r, w: L.w + 2 * e, h: L.h + 2 * e, inView, poly, holes: poly ? holes(c) : [] });
    };
    for (const { c, p, L } of projected) {
      const model = [c.anchor[0] + p.k, c.anchor[1]], rModel = p.r;
      const line = !c.ring && lines.get(c.id);
      if (STYLE.callouts.edgePieces && line && p.inView && offScreen(p.ax, p.ay, W, H)) {
        const pts = line.coords.map(([lon, lat]) => { const s = map.project([lon + p.k, lat]); return [s.x, s.y]; });
        const q = visibleLinePoint(pts, W, H, line.side);
        if (q) add(c.id, c, L, q.ax, q.ay, 0, true, null, map.unproject([q.ax, q.ay]), true);
        // Ink at the canvas edge but no run inside to label: counted hidden.
        else if (nearCanvas(pts, W, H, p.m)) add(c.id, c, L, p.ax, p.ay, 0, true, null, model, false);
        continue;   // no part of the line or its ticks inside: not in view
      }
      if (!(STYLE.callouts.edgePieces && p.inView && p.poly && crossesEdge(p.poly, W, H))) {
        add(c.id, c, L, p.ax, p.ay, rModel, p.inView, p.poly, model, false);
        continue;
      }
      const parts = visibleParts(p.poly, holes(c), W, H, p.ax, p.ay);
      const own = parts.filter((q) => q.model || q.r >= MIN_CLEAR);
      if (!own.length) {   // nothing wide enough: the old rule; in view when its ink reaches the canvas
        add(c.id, c, L, p.ax, p.ay, rModel, parts.length > 0 || nearCanvas(p.poly, W, H, p.m), p.poly, model, false);
        continue;
      }
      own.sort((a, b) => b.model - a.model);   // the model piece keeps the plain id
      own.forEach((q, k) => {
        const id = k ? `${c.id}#${k}` : c.id;
        if (q.model) add(id, c, L, p.ax, p.ay, rModel, true, p.poly, model, false);
        else add(id, c, L, q.ax, q.ay, q.r, true, p.poly, map.unproject([q.ax, q.ay]), true);
        q.repeats.forEach((t, j) => add(`${id}+${j + 1}`, c, L, t.ax, t.ay, t.r, true, p.poly, map.unproject([t.ax, t.ay]), true, true));
      });
    }
    return items;
  }

  function redraw() {
    if (!W) size();
    clear();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    items = itemsFor(map.getCenter().lng);
    const opts = densityOpts(density), { strict, sigwx } = blockedBy(items, opts.padding);
    result = placeCallouts(items, { w: W, h: H }, { ...opts, blocked: strict, blockedSigwx: sigwx, blockedSeg: leaderBlockedBy() });
    // Repeats are best effort: never counted as hidden, and dropped when a box placed
    // earlier covers the point their arrow would mark.
    result.hidden = result.hidden.filter((id) => !entries.get(id).repeat);
    result.placed = result.placed.filter((b) => !entries.get(b.id).repeat || !result.placed.some((o) => o !== b
      && entries.get(b.id).ax >= o.x && entries.get(b.id).ax <= o.x + o.w && entries.get(b.id).ay >= o.y && entries.get(b.id).ay <= o.y + o.h));
    for (const b of result.placed) if (b.leader) drawLeader(ctx, b.leader);
    const e = calloutBorderGrow();
    for (const b of result.placed) drawBox(ctx, b.x + e, b.y + e, entries.get(b.id).L);
    onHiddenChange(result.hidden.map((id) => ({ callout: entries.get(id).c, lngLat: entries.get(id).lngLat })), result.placed.length);
  }

  // Cleared on movestart. The boxes avoid MapLibre's placed labels, and at moveend its
  // collision index can still describe the previous camera (placement lags by up to the
  // 300 ms fade), so the move's redraw waits for 'idle', when the labels it shows are
  // final. 'idle' also follows new data, a new basemap and a density change.
  // If 'idle' has not come IDLE_FALLBACK_MS after moveend (a hung tile), the
  // boxes are placed anyway; the next 'idle' places them again.
  const IDLE_FALLBACK_MS = 1000;
  let fallback = null;
  const cancelFallback = () => { clearTimeout(fallback); fallback = null; };
  map.on('movestart', () => { cancelFallback(); clear(); });
  map.on('moveend', () => {
    cancelFallback();
    fallback = setTimeout(() => { fallback = null; redraw(); }, IDLE_FALLBACK_MS);
  });
  map.on('idle', () => { cancelFallback(); redraw(); });
  map.on('resize', () => { size(); redraw(); });

  return {
    setCallouts(list, lineMap = new Map()) { callouts = list ?? []; lines = lineMap; redraw(); },
    setDensity(d) { density = clampDensity(d); redraw(); },
    redraw,
    // {callout, lngLat of the point its arrow marks} for the placed box at the screen
    // point, or null.
    hitTest(x, y) {
      const b = result.placed.find((q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h);
      if (!b) return null;
      const e = entries.get(b.id);
      return { callout: e.c, lngLat: e.lngLat };
    },
    // The last placement, for checks: {placed, hidden, W, H, items (the placer's input),
    // parts: item ids anchored on a visible piece instead of the model anchor}.
    last: () => ({ ...result, W, H, items, parts: [...entries].filter(([, e]) => e.part).map(([id]) => id) }),
  };
}
