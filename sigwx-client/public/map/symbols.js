// ICAO SIGWX symbols, shared by the map and the call-out overlay. Browser ES module.
// Shapes follow the WAFC SIGWX guide (Jan 2025): figures 5, 10, 18, 22 and 23.
import { composeFleche } from '../lib/jets.js';
import { STYLE, jetHalf } from '../lib/style.js';

const TAU = Math.PI * 2;

// Each symbol is drawn in a unit box ([-0.5, 0.5] on both axes, y down) centred on
// (cx, cy) and scaled to `size` px, so line widths scale with the symbol.
const SHAPES = {
  'turb-mod'(c) {
    poly(c, [[-0.45, 0.22], [-0.2, 0.22], [0, -0.28], [0.2, 0.22], [0.45, 0.22]]);
  },
  'turb-sev'(c) {
    poly(c, [[-0.45, 0.32], [-0.2, 0.32], [0, -0.12], [0.2, 0.32], [0.45, 0.32]]);
    poly(c, [[-0.2, 0.08], [0, -0.4], [0.2, 0.08]]);
  },
  'ice-mod'(c) { icing(c, [-0.09, 0.09]); },
  'ice-sev'(c) { icing(c, [-0.15, 0, 0.15]); },
  volcano(c) {
    poly(c, [[-0.13, -0.08], [0.13, -0.08], [0.33, 0.34], [-0.33, 0.34]], true);
    poly(c, [[-0.06, -0.16], [-0.17, -0.42]]);
    poly(c, [[0, -0.16], [0, -0.45]]);
    poly(c, [[0.06, -0.16], [0.17, -0.42]]);
    c.beginPath(); c.arc(0, 0.24, 0.06, 0, TAU); c.fill();
  },
  'tc-nh'(c) { cyclone(c); },
  'tc-sh'(c) { c.scale(-1, 1); cyclone(c); },
  // Two thin lines perpendicular to +x, i.e. across a jet drawn along +x.
  'change-bar'(c) {
    poly(c, [[-0.12, -0.42], [-0.12, 0.42]]);
    poly(c, [[0.12, -0.42], [0.12, 0.42]]);
  },
  // A filled head pointing +x; its tip is at the right edge of the box (x = +0.5).
  'jet-arrow'(c) {
    c.beginPath(); c.moveTo(-0.5, -0.35); c.lineTo(0.5, 0); c.lineTo(-0.5, 0.35); c.closePath(); c.fill();
  },
};

export const SYMBOL_NAMES = Object.keys(SHAPES);

function poly(c, pts, closed = false) {
  c.beginPath();
  pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  if (closed) c.closePath();
  c.stroke();
}

// A bowl open upward, crossed by one vertical stroke per x.
function icing(c, xs) {
  c.beginPath(); c.arc(0, -0.08, 0.3, 0, Math.PI); c.stroke();
  for (const x of xs) poly(c, [[x, -0.42], [x, 0.4]]);
}

// The NH "6": a ring with one arm rising from its left side and hooking right, and
// one falling from its right side and hooking left. The SH symbol is its mirror.
function cyclone(c) {
  c.beginPath(); c.arc(0, 0, 0.13, 0, TAU); c.stroke();
  c.beginPath(); c.moveTo(-0.13, 0); c.quadraticCurveTo(-0.16, -0.44, 0.22, -0.4); c.stroke();
  c.beginPath(); c.moveTo(0.13, 0); c.quadraticCurveTo(0.16, 0.44, -0.22, 0.4); c.stroke();
}

// Draws one named symbol in the style's ink (black), centred on (cx, cy), `size` px square.
export function drawSymbol(ctx, name, cx, cy, size) {
  const shape = SHAPES[name];
  if (!shape) throw new Error(`drawSymbol: unknown symbol ${name}`);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(size, size);
  ctx.strokeStyle = ctx.fillStyle = STYLE.symbols.color;
  ctx.lineWidth = STYLE.symbols.stroke;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  shape(ctx);
  ctx.restore();
}

function pixels(c, width, height) {
  return { width, height, data: c.getContext('2d').getImageData(0, 0, width, height).data };
}

// Every map image carries a white outline so the black symbols read on the
// dark and satellite basemaps. HALO (the style's symbols.haloWidth, 1.5) is in CSS px;
// JET_HALF (jetHalf) is half the jet line, 2 px at its default 4 px.

// Draws draw(ctx) (ink, CSS px, inside w x h) at `ratio` on a canvas padded for the halo,
// then puts the halo under it: the ink stamped in the halo colour HALO px away in 16
// directions (none at HALO 0). With lineBand, the halo is cleared from the middle rows
// (|y| < JET_HALF), where the jet line runs, so it never notches the line the symbol sits on.
function haloed(w, h, ratio, draw, lineBand = false) {
  const HALO = STYLE.symbols.haloWidth, JET_HALF = jetHalf();
  const pad = Math.ceil(HALO);
  const W = Math.ceil((w + 2 * pad) * ratio), H = Math.ceil((h + 2 * pad) * ratio);
  const ink = new OffscreenCanvas(W, H), ictx = ink.getContext('2d');
  ictx.scale(ratio, ratio);
  ictx.translate(pad, pad);
  draw(ictx);
  const white = new OffscreenCanvas(W, H), wctx = white.getContext('2d');
  wctx.drawImage(ink, 0, 0);
  wctx.globalCompositeOperation = 'source-in';
  wctx.fillStyle = STYLE.symbols.halo;
  wctx.fillRect(0, 0, W, H);
  const out = new OffscreenCanvas(W, H), o = out.getContext('2d');
  for (let k = 0; HALO > 0 && k < 16; k++) {
    const a = (k * Math.PI) / 8;
    o.drawImage(white, HALO * ratio * Math.cos(a), HALO * ratio * Math.sin(a));
  }
  if (lineBand) o.clearRect(0, H / 2 - JET_HALF * ratio, W, 2 * JET_HALF * ratio);
  o.drawImage(ink, 0, 0);
  return pixels(out, W, H);
}

// {width, height, data} of one symbol centred in a size x size CSS px square, plus its
// halo on every side, at `ratio` device px per CSS px (pass the same ratio to addImage).
export function symbolImage(name, size, ratio = 1) {
  const onLine = name === 'change-bar' || name === 'jet-arrow';
  return haloed(size, size, ratio, (ctx) => drawSymbol(ctx, name, size / 2, size / 2, size), onLine);
}

// Fleche geometry in px, at WAFC chart size at the style's
// jets.barbs.scale 1: a feather is 20 px long, a half-feather 10 px, a pennant about
// 10 x 17 px. Feathers lean upstream, parallel to the pennant's long side (guide figure 5).
// Barbs start at the edge of the jet line (EDGE = JET_HALF).
const PENNANT_W = 10, BARB_H = 17;   // hypot(10, 17) ≈ 20

// {width, height, data} of a fleche for kt, pointing +x: pennants upstream (left), then
// feathers, then a half. Barbs are screen-up for 'nh' and screen-down for 'sh'. The
// image is symmetric about its middle row, which is where the jet line runs.
// `ratio` renders at that device-pixel ratio (pass the same value to addImage).
export function flecheImage(kt, hemi, ratio = 1) {
  const { pennants, feathers, halves } = composeFleche(kt);
  // PAD: 2 px around the barbs, more for a stroke too wide for it.
  const k = STYLE.jets.barbs.scale, EDGE = jetHalf(), PAD = Math.max(2, Math.ceil(STYLE.jets.barbs.width / 2));
  const w = PENNANT_W * k, h = BARB_H * k, gap = 2 * k, step = 6 * k;
  const shapes = [];
  let end = null;   // x of the downstream base point of the last element
  for (let i = 0; i < pennants; i++) {
    const s = end == null ? PAD : end + gap;
    shapes.push({ fill: [[s, 0], [s, -h], [s + w, 0]] });
    end = s + w;
  }
  for (let i = 0; i < feathers; i++) {
    const b = end == null ? PAD + w : end + step;
    shapes.push({ line: [[b, 0], [b - w, -h]] });
    end = b;
  }
  for (let i = 0; i < halves; i++) {
    const b = end == null ? PAD + w + step : end + step;
    shapes.push({ line: [[b, 0], [b - w / 2, -h / 2]] });
    end = b;
  }
  const W = Math.ceil((end ?? 0) + PAD), H = 2 * (EDGE + h + PAD);
  return haloed(W, H, ratio, (ctx) => {
    ctx.translate(0, H / 2);
    if (hemi === 'sh') ctx.scale(1, -1);
    ctx.translate(0, -EDGE);
    ctx.strokeStyle = ctx.fillStyle = STYLE.symbols.color;
    ctx.lineWidth = STYLE.jets.barbs.width;
    for (const sh of shapes) {
      const pts = sh.fill ?? sh.line;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (sh.fill) { ctx.closePath(); ctx.fill(); } else ctx.stroke();
    }
  }, true);
}

// The tropopause box: white with a blue border (default colours), stretchable for
// icon-text-fit. The border lies inside the 16 px tile; a border of width 0 is not drawn.
function tropoBox(ratio) {
  const T = STYLE.tropopause, bw = T.borderWidth;
  const n = 16 * ratio, c = new OffscreenCanvas(n, n), ctx = c.getContext('2d');
  ctx.fillStyle = T.fill;
  ctx.fillRect(0, 0, n, n);
  if (bw > 0) {
    ctx.strokeStyle = T.border;
    ctx.lineWidth = bw * ratio;
    ctx.strokeRect((bw / 2) * ratio, (bw / 2) * ratio, n - bw * ratio, n - bw * ratio);
  }
  return pixels(c, n, n);
}
// The tile's stretchable part runs from TROPO_EDGE to 16 − TROPO_EDGE px, clear of the border.
export const tropoEdge = () => Math.max(3, Math.ceil(STYLE.tropopause.borderWidth) + 1);

// The SEV hatch: diagonal black stripes with white edges (default colours) on a
// transparent tile of the style's hatch.size (8) px, seamless when repeated. It reads the same
// on the light, dark and satellite basemaps, over the SEV CAT and SEV icing fills
// (fill-pattern 'hatch-sev', at hatch.opacity). The KEY swatches draw the same tile. Edges
// of width 0 are not drawn.
export function hatchTile(ratio = 1) {
  const { size: HATCH, color, width, edge, edgeWidth } = STYLE.hatch;
  const n = HATCH * ratio, c = new OffscreenCanvas(n, n), ctx = c.getContext('2d');
  ctx.scale(ratio, ratio);
  const stripes = (lineWidth, strokeStyle) => {
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    for (const t of [-HATCH, 0, HATCH]) { ctx.moveTo(t, HATCH); ctx.lineTo(t + HATCH, 0); }
    ctx.stroke();
  };
  if (edgeWidth > 0) stripes(edgeWidth, edge);
  stripes(width, color);
  return c;
}

// Map icon sizes in CSS px, before the halo (24 each by default). The arrow tip is
// mapSize('jet-arrow') / 2 right of centre. Change bar and arrow are sized to go with the
// WAFC-sized fleches.
export const MAP_SYMBOLS = ['change-bar', 'jet-arrow', 'volcano', 'tc-nh', 'tc-sh'];
export function mapSize(name) {
  const S = STYLE;
  return { 'change-bar': S.jets.changeBarSize, 'jet-arrow': S.jets.arrowSize, volcano: S.volcanoes.size,
    'tc-nh': S.cyclones.size, 'tc-sh': S.cyclones.size }[name];
}

const FLECHE_ID = /^fleche-(\d+)-(nh|sh)$/;
const withHandler = new WeakSet();
const pixelRatio = () => Math.max(1, Math.round(globalThis.devicePixelRatio || 1));

// Adds the map's symbol images and the SEV hatch (they are lost on every setStyle) and,
// once per map, a styleimagemissing handler that builds fleche-<kt>-<hemi> on demand.
export function registerSymbols(map) {
  const r = pixelRatio();
  for (const name of MAP_SYMBOLS) {
    if (!map.hasImage(name)) map.addImage(name, symbolImage(name, mapSize(name), r), { pixelRatio: r });
  }
  if (!map.hasImage('tropo-box')) {
    const e = tropoEdge(), a = e * r, b = (16 - e) * r;
    map.addImage('tropo-box', tropoBox(r), { pixelRatio: r, stretchX: [[a, b]], stretchY: [[a, b]], content: [a, a, b, b] });
  }
  const H = STYLE.hatch.size;
  if (!map.hasImage('hatch-sev')) map.addImage('hatch-sev', pixels(hatchTile(r), H * r, H * r), { pixelRatio: r });
  if (withHandler.has(map)) return;
  withHandler.add(map);
  map.on('styleimagemissing', (e) => {
    const m = FLECHE_ID.exec(e.id);
    if (!m || map.hasImage(e.id)) return;
    const k = pixelRatio();
    map.addImage(e.id, flecheImage(Number(m[1]), m[2], k), { pixelRatio: k });
  });
}
