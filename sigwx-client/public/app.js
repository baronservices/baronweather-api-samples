// SIGWX app: controls, atomic selection swaps, 5-minute refresh, banners,
// the legend, the KEY, popups and the hidden-label list. Browser ES module.
import { parseFeed, buildStep } from './lib/model.js';
import { LEVEL_RANGE } from './lib/conventions.js';
import { legendLines } from './lib/legend.js';
import { createRequestGate } from './lib/state.js';
import { isOutsideUsable, nearestIndex, pickDefault, usableWindow, toMs } from './lib/time.js';
import { clampDensity } from './lib/callouts.js';
import { BASEMAPS, setBasemap, basemapRequest } from './map/basemap.js';
import { attachSigwx, setStep, applyToggles, applyDensity } from './map/layers.js';
import { drawSymbol, flecheImage, hatchTile } from './map/symbols.js';
import { createOverlay, boxLayout, drawBox, drawLeader, headerOf } from './map/overlay.js';
import { fmtLatLon } from './lib/units.js';
import { STYLE, DEFAULT_STYLE, PAGE_FAMILIES, parseStyle, setStyle, googleFontsHref, canvasFont, jetHalf, arrowTip, failedMapFont, chipInk } from './lib/style.js';

// ---- labels (every control in plain words) ----

const PRODUCTS = { sigwx: 'SIGWX', sigwx_alt: 'SIGWX ALT' };
const LEVELS = Object.fromEntries(Object.entries(LEVEL_RANGE)
  .map(([k, r]) => [k, `${k.toUpperCase()} FL${r.floor}–FL${r.ceiling}`]));
const BASEMAP_NAMES = { light: 'Light', dark: 'Dark', satellite: 'Satellite' };
const TOGGLES = [
  ['jet', 'Jet streams'], ['cb', 'CB areas'], ['cat', 'Turbulence'], ['icing', 'Icing'],
  ['tropo', 'Tropopause'], ['volcano', 'Volcanoes'], ['tc', 'Tropical cyclones'], ['graticule', 'Lat/lon grid'],
];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const pad2 = (n) => String(n).padStart(2, '0');
const utc = (t) => new Date(toMs(t));
const timeButton = (iso) => { const d = utc(iso); return `${pad2(d.getUTCHours())}Z ${pad2(d.getUTCDate())}`; };        // 12Z 21
const timeLong = (iso) => `${timeButton(iso)} ${MONTHS[utc(iso).getUTCMonth()]}`;                                       // 12Z 21 OCT
const clock = (t) => { const d = utc(t); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}Z`; };            // 03:34Z
const feedName = ({ product, level }) => `${PRODUCTS[product]} ${level.toUpperCase()}`;

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

// ---- state ----

const params = new URLSearchParams(location.search);
// Static mode (?static=1) renders one fixed chart for the CLI to capture: no controls,
// timers or animations, and window.sigwxStatic reports when it is ready.
const STATIC_MODE = params.get('static') === '1';
const sigwxStatic = STATIC_MODE
  ? (window.sigwxStatic = { ready: false, error: null, valid: null, usable: null, outsideUsable: false, placed: 0, hidden: [], size: null, incomplete: false, view: null, rtl: null, tiles: null })
  : null;
// A page script that fails (e.g. MapLibre did not load) fails the render at once, instead of
// reading as a map that never finishes drawing.
if (STATIC_MODE) window.addEventListener('error', (e) => { sigwxStatic.error ??= `page script failed: ${e.message}`; });
// The job's style (?style=, URL-encoded JSON), checked as the CLI checks it, before anything
// is drawn. A bad one fails a static render; the app shows it in its own banner and keeps the
// default style.
const styleError = (() => {
  const raw = params.get('style');
  if (raw === null) return null;
  let obj;
  const shown = STATIC_MODE ? '' : ' (the default style is shown)';   // a static render fails instead
  try { obj = JSON.parse(raw); } catch (err) { return `?style= is not valid JSON (${err.message})${shown}`; }
  const { style, errors } = parseStyle(obj);
  if (errors.length) return `${errors.join('; ')}${shown}`;
  setStyle(style);
  return null;
})();
if (STATIC_MODE && styleError) sigwxStatic.error = `style: ${styleError}`;
const pick = (v, table, dflt) => (Object.hasOwn(table, v ?? '') ? v : dflt);
// ?valid= must be a time toMs accepts (with a zone); anything else counts as no time asked
// for, so the default step is chosen instead of a load that can never succeed.
const validParam = (v) => {
  if (!v) return null;
  try { toMs(v); return v; } catch { console.warn(`ignoring ?valid=${v}: not an ISO time with a zone`); return null; }
};
const state = {
  want: {   // the latest selection asked for; refreshes reload it
    product: pick(params.get('product'), PRODUCTS, 'sigwx'),
    level: pick(params.get('level'), LEVELS, 'high'),
    valid: validParam(params.get('valid')),
  },
  applied: null,   // what is on screen: {product, level, valid, times, fetchedAt}
  step: null,
  // Static mode: ?layers= lists the toggles that are on; an empty value means none.
  toggles: STATIC_MODE && params.has('layers')
    ? Object.fromEntries(TOGGLES.map(([key]) => [key, params.get('layers').split(',').includes(key)]))
    : {},
  density: clampDensity(params.get('density') ?? undefined),
  basemap: pick(params.get('basemap'), BASEMAPS, 'light'),
  error: null, refreshFailed: false, notice: null, loading: false,
  styleError,   // a bad ?style= or a web font that did not load; feed loads never clear it
  hidden: [], placed: 0,
};
const gate = createRequestGate();

// The legend, KEY, panel and attribution style as CSS variables (app.css holds the same
// defaults). A panel colour replaces the dark panel and sheet background.
{
  const S = STYLE, root = document.documentElement.style, px = (v) => `${v}px`;
  const vars = {
    '--labels-font': `"${S.fonts.labels}"`, '--text-font': `"${S.fonts.text}"`,
    '--legend-size': px(S.legend.size), '--legend-line': String(S.legend.lineHeight),
    '--legend-pad-x': px(S.legend.paddingX), '--legend-pad-y': px(S.legend.paddingY),
    '--legend-color': S.legend.color, '--legend-bg': S.legend.background,
    '--legend-border': S.legend.border, '--legend-border-w': px(S.legend.borderWidth),
    '--key-size': px(S.key.size), '--key-heading-size': px(S.key.headingSize), '--key-chip-size': px(S.key.chipSize),
    '--key-color': S.key.color, '--key-bg': S.key.background, '--key-heading-color': S.key.headingColor,
    '--key-note-color': S.key.noteColor, '--key-rule-color': S.key.ruleColor,
    '--attrib-size': px(S.attribution.size),
    '--col-w': px(S.panel.columnWidth), '--col-gap': px(S.panel.columnGap), '--side-pad': px(S.panel.padding),
  };
  for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
  if (S.panel.background !== null) {
    const side = document.querySelector('.side');
    document.querySelector('main').style.background = S.panel.background;
    Object.assign(side.style, { background: S.panel.background, borderLeftColor: S.panel.background });
    document.querySelector('.legend').style.boxShadow = `0 -10px 0 ${S.panel.background}`;   // the app's sticky legend
  }
}

// Static layout, before the map exists so it is created at its size: #sheet (the captured
// element) is the w×h map with the attribution in a strip below it, plus, to the right,
// the legend if legend=1 and the KEY if key=1.
if (STATIC_MODE) {
  const size = (key, dflt) => `${Number.parseInt(params.get(key), 10) || dflt}px`;
  document.body.classList.add('static');
  document.body.style.setProperty('--map-w', size('w', 1280));
  document.body.style.setProperty('--map-h', size('h', 800));
  document.querySelector('main').id = 'sheet';
  $('map').after($('attribution'));
  document.querySelector('.legend').hidden = params.get('legend') !== '1';
  $('key').hidden = params.get('key') !== '1';
  $('key').open = true;
  document.querySelector('.side').hidden = params.get('legend') !== '1' && params.get('key') !== '1';
}

// ---- map, overlay, attribution ----

// Arabic, Persian and Hebrew basemap labels need MapLibre's right-to-left text plugin; without
// it they are drawn left to right with unjoined letters. Loaded now, not lazily, so a static
// render's labels are shaped before it is ready. A failed load leaves them unshaped, as before.
// It is served from public/vendor (@mapbox/mapbox-gl-rtl-text 0.2.3, BSD-2, its licence beside
// it), not a CDN: MapLibre's one worker loads it before any tile, so a slow CDN would blank the map.
const RTL_TEXT_PLUGIN = new URL('vendor/mapbox-gl-rtl-text-0.2.3.min.js', location.href).href;
maplibregl.setRTLTextPlugin(RTL_TEXT_PLUGIN, false).catch(() => {});

const map = new maplibregl.Map({
  container: 'map', style: BASEMAPS[state.basemap], center: [-80, 5], zoom: 3.75,
  transformRequest: (url) => basemapRequest(url),   // signed by the local server
  attributionControl: false, hash: true,
});
attachSigwx(map, () => state);
// The attribution lives in the side panel, outside the map, so it covers nothing.
// A static image prints it in full in a strip below the map, where it covers nothing either.
$('attribution').append(new maplibregl.AttributionControl({ compact: !STATIC_MODE }).onAdd(map));
new ResizeObserver(() => map.resize()).observe($('map'));

const overlay = createOverlay(map, {
  onHiddenChange(hidden, placed) {
    state.hidden = hidden; state.placed = placed;
    renderHidden();
    if (STATIC_MODE) Object.assign(sigwxStatic, { placed, hidden: hidden.map(hiddenText) });
  },
});
overlay.setDensity(state.density);
// A SIGWX map font the basemap's font server does not serve fails a static render: its labels
// would be missing. Other map errors (basemap tiles, the basemap's own glyphs) never do.
// Each source's tiles that came and that failed are kept for the CLI's basemap warning.
const staticTiles = new Map();   // sourceId -> {ok: Set, failed: Set, statuses: {status: count}} of tile keys
const tileLog = (id) => staticTiles.get(id) ?? staticTiles.set(id, { ok: new Set(), failed: new Set(), statuses: {} }).get(id);
if (STATIC_MODE) {
  map.on('error', (e) => {
    const font = failedMapFont(e.error?.url ?? e.error?.message);
    if (font) sigwxStatic.error ??= `map font "${font}" did not load`;
    if (!e.tile) return;
    const t = tileLog(e.sourceId), status = e.error?.status || 'network';
    t.failed.add(e.tile.tileID.key);
    t.statuses[status] = (t.statuses[status] ?? 0) + 1;
    // MapLibre 4.7.1 asks for no frame and no source update after a tile fails other than with
    // 404, so when that tile was the last to settle 'idle' never came and the page waited for
    // its 20 s fallback. A source update (setMaxZoom calls _update even with the same value) also
    // asks for the failed tile's parent, so a refused tile shows its nearest loaded ancestor.
    map.setMaxZoom(map.getMaxZoom());
  });
  map.on('sourcedata', (e) => { if (e.tile && e.dataType === 'source' && !e.sourceDataType) tileLog(e.sourceId).ok.add(e.tile.tileID.key); });
}

const visibleCallouts = () => (state.step?.callouts ?? []).filter((c) => state.toggles[c.kind] !== false);
// Open icing lines (no area) by id, so the overlay can label the part of one that is in view
// on its iced side.
const openLines = () => new Map((state.step?.geo.icingLine.features ?? [])
  .map((f) => [f.properties.id, { coords: f.geometry.coordinates, side: f.properties.tickSide }]));

// ---- loading: every selection and refresh is one atomic swap ----

async function load(want, reason) {
  const token = gate.next();
  state.want = want;
  setLoading(true);
  renderControls();   // the requested choice shows as pending until it is applied
  let next, notice = null;
  try {
    let res;
    try {
      res = await fetch(`/api/sigwx/${want.product}/${want.level}`, { cache: 'no-store' });
    } catch (err) {
      console.warn('SIGWX feed fetch failed', err);   // the request is /api/sigwx/…, never a signed URL
      throw new Error('cannot reach the SIGWX server (is npm start running?)');
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    const feed = parseFeed(body);
    const times = feed.steps.map((s) => s.valid_begin);
    // ?valid= matches a timestep by instant, so 12:00:00.000Z is 12:00:00Z.
    let i = want.valid ? times.findIndex((v) => toMs(v) === toMs(want.valid)) : -1;
    // A static image must show the time it asked for: no nearest-time fallback.
    if (i < 0 && STATIC_MODE) throw new Error(`valid time ${want.valid} is not in ${feedName(feed)}; available: ${times.join(', ')}`);
    if (i < 0 && want.valid) {
      i = nearestIndex(times, want.valid);
      if (i >= 0) notice = `${timeLong(want.valid)} not in ${feedName(feed)} — showing ${timeLong(times[i])}`;
    } else if (i < 0) i = pickDefault(times, Date.now()).index;
    if (i < 0) throw new Error('the feed has no timesteps');
    next = {
      applied: { product: feed.product, level: feed.level, valid: times[i], times, fetchedAt: res.headers.get('x-fetched-at') || Date.now() },
      step: buildStep(feed.steps[i], { product: feed.product, level: feed.level }),
    };
  } catch (err) {
    if (!gate.isLatest(token)) return;
    state.error = `${feedName(want)}: ${err.message}`;
    if (STATIC_MODE) sigwxStatic.error = err.message;
    state.refreshFailed = reason === 'refresh';
    setLoading(false);
    renderAll();
    return;
  }
  if (!gate.isLatest(token)) return;   // a newer selection was made meanwhile
  Object.assign(state, next, { error: null, refreshFailed: false });
  state.want = { ...want, valid: next.applied.valid };
  if (notice || reason !== 'refresh') state.notice = notice;
  if (map.getSource('catFill')) setStep(map, state.step);   // before the first style.load, the style.load handler sets it
  overlay.setCallouts(visibleCallouts(), openLines());
  setLoading(false);
  renderAll();
  if (STATIC_MODE) staticStepApplied();
}

function setLoading(on) {
  state.loading = on;
  $('loading').hidden = !on;
  document.body.classList.toggle('is-loading', on);
}

// A selection starts from what is on screen, so after a failed load a click on another
// control does not re-send the failed product or level.
const select = (change) => {
  const a = state.applied, w = state.want;
  load({ product: a?.product ?? w.product, level: a?.level ?? w.level, valid: a?.valid ?? w.valid, ...change }, 'select');
};
const refresh = () => load({ ...state.want }, 'refresh');

// Refresh every 5 minutes and whenever the tab becomes visible again; the
// usable-window check runs every minute, since time passes without any fetch. A static
// image is one fixed chart: none of these.
if (!STATIC_MODE) {
  setInterval(refresh, 5 * 60 * 1000);
  setInterval(renderBanners, 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
}

// ---- controls ----

function segment(container, entries, active, pending, onPick) {
  container.replaceChildren(...entries.map(([value, label, title]) => {
    const b = el('button', { type: 'button', textContent: label, title: title ?? '' });
    b.setAttribute('aria-pressed', String(value === active));
    if (value === pending && value !== active) b.classList.add('pending');
    b.addEventListener('click', () => onPick(value));
    return b;
  }));
}

function renderControls() {
  const a = state.applied, w = state.want;
  segment($('product'), Object.entries(PRODUCTS), a?.product, w.product, (product) => select({ product }));
  segment($('level'), Object.entries(LEVELS), a?.level, w.level, (level) => select({ level }));
  segment($('basemap'), Object.entries(BASEMAP_NAMES), state.basemap, null, (name) => {
    if (name === state.basemap) return;
    state.basemap = name;
    setBasemap(map, name);
    renderControls();
  });
  $('lbl-valid').textContent = a ? `Valid: ${timeLong(a.valid)}` : 'Valid:';
  segment($('valid'), (a?.times ?? []).map((t) => [t, timeButton(t), `${timeLong(t)}, usable ${usableWindow(t).label}`]),
    a?.valid, w.valid, (valid) => select({ valid }));
  $('density').value = String(state.density);
  $('density-out').textContent = `${state.density.toFixed(2).replace(/0$/, '')}×`;
  renderToggles();
}

function renderToggles() {
  const counts = state.step?.counts;
  $('toggles').replaceChildren(...TOGGLES.map(([key, label]) => {
    const n = key === 'graticule' ? '' : ` (${counts ? counts[key] : '—'})`;
    const box = el('input', { type: 'checkbox', checked: state.toggles[key] !== false });
    box.addEventListener('change', () => {
      state.toggles[key] = box.checked;
      applyToggles(map, state.toggles);
      overlay.setCallouts(visibleCallouts(), openLines());
    });
    return el('label', { className: 'toggle' }, box, el('span', { textContent: `${label}${n}` }));
  }));
}

$('density').addEventListener('input', (e) => {
  state.density = clampDensity(e.target.value);
  applyDensity(map, state.density);
  overlay.setDensity(state.density);
  renderControls();
});

// ---- banners: red = feed error, amber = stale, blue = notice. Map 'error' events (basemap
// tile 403s) never reach them. ----

function renderBanners() {
  const a = state.applied, now = Date.now();
  $('banner-style').hidden = !state.styleError;
  if (state.styleError) $('banner-style').textContent = `Style error — ${state.styleError}.`;
  const err = $('banner-error');
  err.hidden = !state.error;
  if (state.error) {
    err.textContent = `SIGWX feed error — ${state.error}. ` + (a
      ? `Still showing ${feedName(a)} ${timeLong(a.valid)}, fetched ${clock(a.fetchedAt)}.`
      : 'No chart is shown.');
  }
  const stale = [];
  if (a && isOutsideUsable(a.valid, now)) {
    stale.push(`${timeLong(a.valid)} is outside its usable window (${usableWindow(a.valid).label}); it is now ${clock(now)}.`);
  }
  if (a && state.refreshFailed) stale.push(`Refresh failed: showing data fetched ${clock(a.fetchedAt)}, which may be out of date.`);
  $('banner-stale').hidden = !stale.length;
  $('banner-stale').textContent = stale.join(' ');
  const notice = $('banner-notice');
  notice.hidden = !state.notice;
  notice.querySelector('span').textContent = state.notice ?? '';
}
$('banner-notice').querySelector('button').addEventListener('click', () => { state.notice = null; renderBanners(); });

// ---- legend: always visible ----

function renderLegend() {
  const a = state.applied;
  if (!a) { $('legend').replaceChildren(el('p', { className: 'rule', textContent: 'NO CHART LOADED' })); return; }
  const lines = legendLines({ product: a.product, level: a.level, valid: a.valid, fetchedAt: a.fetchedAt });
  // Groups: issuer, range and validity, advisories, fetch time; a black rule between groups.
  const groups = [lines.slice(0, 2), lines.slice(2, 4), lines.slice(4, -1), lines.slice(-1)];
  $('legend').replaceChildren(...groups.map((g) => el('div', { className: 'rule' }, ...g.map((t) => el('div', { textContent: t })))));
}

// ---- hidden labels: counter, list, flyTo + popup ----

// A new popup per click: re-adding one instance during a click would let its own
// close-on-click listener, already queued for that click, close it again.
let popup = null;
function showPopup(lngLat, texts) {
  popup?.remove();
  popup = new maplibregl.Popup({ maxWidth: '340px' }).setLngLat(lngLat)
    .setDOMContent(el('div', { className: 'popup' }, ...texts.map((t) => el('div', { textContent: t })))).addTo(map);
}

function renderHidden() {
  const n = state.hidden.length, btn = $('hidden-btn');
  btn.textContent = n ? `${n} label${n === 1 ? '' : 's'} hidden — zoom in or open list` : '0 labels hidden';
  btn.classList.toggle('has-hidden', n > 0);
  btn.title = `${state.placed} hazard call-outs shown, ${n} hidden`;
  $('lbl-hidden').textContent = `Hidden labels (${n})`;
  $('hidden-items').replaceChildren(...state.hidden.map(({ callout: c, lngLat }) => {
    const b = el('button', { type: 'button' }, el('strong', { textContent: headerOf(c) ?? c.lines.slice(0, 2).join(' ') }), ` ${c.popup}`);
    b.addEventListener('click', () => {
      map.once('moveend', () => showPopup(lngLat, [c.popup]));
      map.flyTo({ center: lngLat, zoom: Math.min(8, Math.max(map.getZoom() + 1, 4)) });
    });
    return el('li', {}, b);
  }));
}
$('hidden-btn').addEventListener('click', () => {
  const list = $('hidden-list'), open = list.hidden;
  list.hidden = !open;
  $('hidden-btn').setAttribute('aria-expanded', String(open));
  if (open) list.scrollIntoView({ block: 'nearest' });
});

// ---- popups on every SIGWX feature and on call-out boxes ----

const POPUP_LAYERS = ['vts-symbols', 'jet-arrows', 'jet-symbols', 'tropo', 'jet-line', 'cb-hit', 'icing-line',
  'icing-line-fallback', 'icing-fill-sev', 'icing-fill-mod', 'cat-fill-sev', 'cat-fill-mod'];
function featuresAt({ x, y }) {
  const layers = POPUP_LAYERS.filter((id) => map.getLayer(id));
  return layers.length ? map.queryRenderedFeatures([[x - 3, y - 3], [x + 3, y + 3]], { layers }) : [];
}
map.on('click', (e) => {
  const hit = overlay.hitTest(e.point.x, e.point.y);
  if (hit) { showPopup(hit.lngLat, [hit.callout.popup]); return; }
  const texts = [...new Set(featuresAt(e.point).map((f) => f.properties.popup).filter(Boolean))];
  if (texts.length) showPopup(e.lngLat, texts);
});
map.on('mousemove', (e) => {
  const hit = overlay.hitTest(e.point.x, e.point.y) || featuresAt(e.point).length;
  map.getCanvas().style.cursor = hit ? 'pointer' : '';
});

// ---- KEY: every symbol and notation on screen ----

// The KEY keeps its own geometry (swatch sizes, the CB arc, tick spacing, icon sizes; no
// casings, and halos only on the barbs, which use the map's image) and takes the rest from
// the style: colours, widths, dashes, the hatch,
// the symbol ink and stroke, barbs, the call-out box and leader, text sizes and web fonts.
// Each mapping gives today's swatch at the defaults.
const SW = 64, SH = 30;
const r3 = (x) => Math.round(x * 1000) / 1000;
function swatch(draw, w = SW, h = SH) {
  const r = window.devicePixelRatio || 1;
  const c = el('canvas', { width: Math.round(w * r), height: Math.round(h * r) });
  c.style.width = `${w}px`; c.style.height = `${h}px`;
  c.setAttribute('aria-hidden', 'true');
  const ctx = c.getContext('2d');
  ctx.scale(r, r);
  draw(ctx, w, h);
  return c;
}
// A chip shows notation as a call-out box prints it, so it takes the box's fill, border and
// text colour (chipInk: its text keeps the KEY's ink only at the defaults).
function chip(text) {
  const C = STYLE.callouts, c = el('span', { className: 'chip', textContent: text });
  Object.assign(c.style, { background: C.fill, border: `${C.borderWidth}px solid ${C.border}` });
  if (chipInk()) c.style.color = chipInk();
  return c;
}

function jetLine(ctx, x0, x1, y) {
  ctx.strokeStyle = STYLE.jets.line.color; ctx.lineWidth = STYLE.jets.line.width;
  ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
}
// The line runs 14 px above the bottom; the swatch is 40 px tall unless the barbs need more.
function fleche(kt) {
  const above = jetHalf() + 17 * STYLE.jets.barbs.scale + 4 + Math.ceil(STYLE.symbols.haloWidth);
  return swatch((ctx, w, h) => {
    const y = h - 14;
    jetLine(ctx, 2, w - 2, y);
    const r = window.devicePixelRatio || 1, img = flecheImage(kt, 'nh', r);
    const off = new OffscreenCanvas(img.width, img.height);
    off.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    const iw = img.width / r, ih = img.height / r;
    ctx.drawImage(off, (w - iw) / 2, y - ih / 2, iw, ih);
  }, SW, Math.max(40, Math.ceil(above) + 14));
}
// An area swatch; hatched, it gets the map's SEV hatch tile at the map's opacity.
// stroke: {color, width, dash (in widths) or null}.
function area(fill, opacity, stroke, symbol, hatched = false) {
  const m = Math.max(3, Math.ceil(stroke.width / 2) + 1);   // the rectangle's inset: 3 px today
  return swatch((ctx) => {
    ctx.globalAlpha = opacity; ctx.fillStyle = fill; ctx.fillRect(m, m + 2, 30, 20); ctx.globalAlpha = 1;
    if (hatched) {
      const r = Math.max(1, Math.round(window.devicePixelRatio || 1)), pattern = ctx.createPattern(hatchTile(r), 'repeat');
      pattern.setTransform(new DOMMatrix().scale(1 / r));
      ctx.globalAlpha = STYLE.hatch.opacity; ctx.fillStyle = pattern; ctx.fillRect(m, m + 2, 30, 20); ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = stroke.color; ctx.lineWidth = stroke.width; ctx.setLineDash(stroke.dash ? stroke.dash.map((d) => r3(d * stroke.width)) : []);
    ctx.strokeRect(m, m + 2, 30, 20); ctx.setLineDash([]);
    drawSymbol(ctx, symbol, m + 47, m + 12, 22);
  }, SW + 2 * (m - 3), Math.max(SH, 20 + 2 * m + 2));
}
// The call-out shown in the KEY.
const EXAMPLE_CALLOUT = { kind: 'cat', level: 'MOD', symbol: 'turb-mod', lines: ['380', 'XXX'] };

function buildKey() {
  const { high, mid } = LEVEL_RANGE;
  const S = STYLE, T = S.turbulence, I = S.icing, G = S.grid, P = S.tropopause;
  const row = (sw, html) => el('div', { className: 'krow' }, el('div', { className: 'ksw' }, sw), el('div', { className: 'ktext', innerHTML: html }));
  const head = (t) => el('h3', { textContent: t });
  // 84 × 64 by default; larger when the style's call-out is.
  const box0 = boxLayout(document.createElement('canvas').getContext('2d'), EXAMPLE_CALLOUT);
  const exampleBox = swatch((ctx, w, h) => {
    const L = boxLayout(ctx, EXAMPLE_CALLOUT);
    drawLeader(ctx, [2 + L.w, 2 + L.h * 0.75, w - 3, h - 3]);
    drawBox(ctx, 2, 2, L);
  }, Math.max(84, box0.w + 18), Math.max(64, box0.h + 16));
  const catStroke = { color: T.outline.color, width: r3(0.8 * T.outline.width), dash: T.outline.dash };
  const iceStroke = { color: I.line.color, width: I.line.width, dash: null };
  const tickSwatchH = Math.max(SH, 12 + I.ticks.length + 3);
  // The TROP box: 60 × 16 px at today's 11 px text, scaled with larger text.
  const tk = Math.max(1, (P.size - 1) / 10), tw = 60 * tk, th = 16 * tk;
  const isRed = S.cb.color.toLowerCase() === DEFAULT_STYLE.cb.color;
  $('key-body').replaceChildren(
    head('Jet streams'),
    // The line stops where the arrowhead (tip at w − 2) still covers it: w − 16 at the defaults.
    row(swatch((ctx, w, h) => { jetLine(ctx, 2, Math.min(w - 16, w - 2 - arrowTip()), h / 2); drawSymbol(ctx, 'jet-arrow', w - 14, h / 2, 24); }),
      'Jet stream core (wind 80&nbsp;KT or more). The <b>arrowhead</b> marks its end and the flow direction.'),
    row(fleche(50), '<b>Pennant</b> = 50&nbsp;KT'),
    row(fleche(10), '<b>Feather</b> = 10&nbsp;KT'),
    row(fleche(5), '<b>Half feather</b> = 5&nbsp;KT. Barbs add up to the wind speed; they sit on the low-pressure side.'),
    row(swatch((ctx, w, h) => { jetLine(ctx, 2, w - 2, h / 2); drawSymbol(ctx, 'change-bar', w / 2, h / 2, 24); }),
      '<b>Change bar</b>: the wind speed changes by 20&nbsp;KT here.'),
    row(chip('160KT\nFL400\nXXX/470'), 'Jet label: <b>speed</b>, its <b>flight level</b>, and the FL band where the wind is 80&nbsp;KT or more (base/top).'),
    head('Hazard areas'),
    row(swatch((ctx, w, h) => {
      ctx.strokeStyle = S.cb.color; ctx.lineWidth = S.cb.width; ctx.beginPath();
      for (let x = 4; x + 8 <= w - 4; x += 8) ctx.arc(x + 4, h / 2 + 3, 4, Math.PI, 0);
      ctx.stroke();
    }), `<b>CB</b>: cumulonimbus area (${isRed ? 'red ' : ''}scalloped line). CB implies thunderstorms, hail, MOD or SEV turbulence and icing.`),
    row(area(T.moderate.fill, T.moderate.opacity, catStroke, 'turb-mod'), '<b>MOD TURB</b>: moderate clear-air turbulence (CAT) area, dashed outline.'),
    row(area(T.severe.fill, T.severe.opacity, catStroke, 'turb-sev', true), '<b>SEV TURB</b>: severe CAT area, hatched.'),
    row(area(I.moderate.fill, I.moderate.opacity, iceStroke, 'ice-mod'), '<b>MOD ICE</b>: moderate icing area (MID level).'),
    row(area(I.severe.fill, I.severe.opacity, iceStroke, 'ice-sev', true), '<b>SEV ICE</b>: severe icing area, hatched.'),
    row(swatch((ctx, w) => {
      ctx.globalAlpha = I.moderate.opacity; ctx.fillStyle = I.moderate.fill; ctx.fillRect(2, 12, w - 4, 16); ctx.globalAlpha = 1;
      ctx.strokeStyle = I.line.color; ctx.lineWidth = I.line.width; ctx.beginPath(); ctx.moveTo(2, 12); ctx.lineTo(w - 2, 12); ctx.stroke();
      ctx.lineWidth = I.ticks.width; ctx.beginPath();
      for (let x = 8; x < w; x += 12) { ctx.moveTo(x, 12); ctx.lineTo(x, 12 + I.ticks.length); }
      ctx.stroke();
    }, SW, tickSwatchH), '<b>Icing boundary</b>: the T-ticks point into the iced area.'),
    row(swatch((ctx, w) => {
      ctx.strokeStyle = I.line.color; ctx.lineWidth = I.line.width; ctx.setLineDash(I.line.fallbackDash.map((d) => r3(d * I.line.width)));
      ctx.beginPath(); ctx.moveTo(2, 12); ctx.lineTo(w - 2, 12); ctx.stroke(); ctx.setLineDash([]);
      ctx.lineWidth = I.ticks.width; ctx.beginPath();
      for (let x = 8; x < w; x += 12) { ctx.moveTo(x, 12); ctx.lineTo(x, 12 + I.ticks.length); }
      ctx.stroke();
    }, SW, tickSwatchH), '<b>Dashed icing line</b>: an open icing boundary whose area could not be rebuilt. Its iced side (T-ticks) is <b>inferred</b>, not given in the data.'),
    row(swatch((ctx) => drawSymbol(ctx, 'volcano', 32, 15, 24)), '<b>Volcano</b> (eruption). Its box gives the name and position.'),
    row(swatch((ctx) => drawSymbol(ctx, 'tc-nh', 32, 15, 24)), '<b>Tropical cyclone</b>, northern hemisphere.'),
    row(swatch((ctx) => drawSymbol(ctx, 'tc-sh', 32, 15, 24)), '<b>Tropical cyclone</b>, southern hemisphere.'),
    row(swatch((ctx) => {
      ctx.fillStyle = P.fill; ctx.fillRect(2, 7, tw, th);
      if (P.borderWidth > 0) { ctx.strokeStyle = P.border; ctx.lineWidth = P.borderWidth; ctx.strokeRect(2, 7, tw, th); }
      ctx.fillStyle = P.color; ctx.font = canvasFont(P.weight, P.size - 1, S.fonts.text); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('TROP FL350', 2 + tw / 2, 7 + th / 2 + 0.5);
    }, Math.max(SW, tw + 4), Math.max(SH, th + 14)), '<b>Tropopause</b> height (here FL350).'),
    row(swatch((ctx, w, h) => {
      ctx.strokeStyle = G.color; ctx.setLineDash(G.dash.map((d) => r3(d * G.width))); ctx.lineWidth = G.width;
      ctx.beginPath(); ctx.moveTo(2, h / 2); ctx.lineTo(w - 2, h / 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = G.label.color; ctx.font = canvasFont(G.label.weight, G.label.size - 1, S.fonts.text); ctx.fillText(`${G.labelEvery}°N`, 4, h / 2 - 4);
    }), `Latitude/longitude grid every ${G.spacing}°, labelled every ${G.labelEvery}°, and every ${G.spacing}° when zoomed in.`),
    head('Call-outs and notation'),
    row(exampleBox, '<b>Call-out</b>: the hazard, then its <b>top over its base</b> in FL. The arrow points into the area; a box inside its area has no arrow.'),
    row(chip('OCNL\nFRQ\nISOL'), 'CB coverage: <b>OCNL</b> occasional, <b>FRQ</b> frequent, <b>ISOL</b> isolated.'),
    row(chip('MOD\nSEV'), '<b>MOD</b> moderate, <b>SEV</b> severe.'),
    row(chip('XXX'), `Beyond the chart's height range: below FL${high.floor} or above FL${high.ceiling} on HIGH, below FL${mid.floor} or above FL${mid.ceiling} on MID.`),
    row(chip('?'), 'Not given in the data.'),
    row(chip('FL'), 'Flight level: hundreds of feet (FL350 = 35,000&nbsp;ft).'),
    row(chip('KT'), 'Knots.'),
    // A static image has no hidden-labels button or list; the CLI logs those hazards.
    STATIC_MODE
      ? el('p', { className: 'knote', textContent: 'Hazards with no room for a label are listed in the render log.' })
      : row(chip('N labels\nhidden'), 'Hazard call-outs with no room on screen. Open the list to fly to each one, or zoom in.'),
    el('p', { className: 'knote', textContent: STATIC_MODE
      ? 'Jet symbols and TROP boxes that would overlap are left out at this zoom; render at a higher zoom to show them.'
      : 'Jet symbols and TROP boxes that would overlap appear as you zoom in.' }),
  );
  // The swatch column is as wide as the widest swatch, at least 84 px.
  const widest = Math.max(84, ...[...$('key-body').querySelectorAll('.ksw canvas')].map((c) => Number.parseFloat(c.style.width)));
  document.documentElement.style.setProperty('--key-swatch-w', `${widest}px`);
}

// ---- static mode: panel columns and readiness ----

// '<header> <box lines> near <position> [<id>]'; a CB box has no header. The position is
// the point the hidden box would have marked: an [lon, lat] array, or a LngLat for a
// visible piece of an area cut by the map edge.
// Turbulence and icing lines say which value is the top and which the base.
function hiddenText({ callout: c, lngLat }) {
  const at = Array.isArray(lngLat) ? lngLat : [lngLat.lng, lngLat.lat];
  const body = c.kind === 'cat' || c.kind === 'icing'
    ? [headerOf(c), 'top', c.lines[0], 'base', c.lines[1]]
    : [headerOf(c), ...c.lines];
  return `${body.filter((s) => s !== null).join(' ')} near ${fmtLatLon(at)} [${c.id}]`;
}

// The panels fill columns as tall as the map (CSS multi-column, column-fill: auto), as
// many as they need. A multi-column box does not widen for its overflow columns, so the
// count is raised until nothing overflows.
function layoutPanels() {
  const side = document.querySelector('.side');
  if (side.hidden) return;
  for (let n = 1; n <= 12; n++) {
    side.style.columnCount = String(n);
    side.style.width = `calc(${n} * var(--col-w) + ${n - 1} * var(--col-gap) + 2 * var(--side-pad) + 1px)`;
    if (side.scrollWidth <= side.clientWidth) break;
  }
}

let staticStep = false, staticIdle = false, staticFonts = false, staticTimedOut = false;
function staticStepApplied() {
  const { valid } = state.applied;
  Object.assign(sigwxStatic, { valid, usable: usableWindow(valid).label, outsideUsable: isOutsideUsable(valid, Date.now()) });
  staticStep = true;
  setTimeout(() => { staticTimedOut = true; staticReady(); }, 20 * 1000);   // no idle by then (a hung tile): ready anyway
}

// Ready once the step is applied, the style has loaded (the SIGWX sources exist; not
// map.isStyleLoaded(), which stays false while any tile is pending), the map has gone idle
// since the step (or 20 s have passed) and the fonts have loaded. The call-outs are then
// placed once more, so the placement reported follows all of these.
function staticReady() {
  if (sigwxStatic.ready || sigwxStatic.error || !staticStep || !staticFonts || !map.getSource('catFill')) return;
  if (!staticIdle && !staticTimedOut) return;
  if (!$('attribution').textContent.trim()) return;   // the basemap attribution must be in the image
  layoutPanels();
  overlay.redraw();
  const r = $('sheet').getBoundingClientRect();
  sigwxStatic.size = { width: Math.ceil(r.width), height: Math.ceil(r.height) };
  sigwxStatic.incomplete = !staticIdle;   // readied by the 20 s fallback, so tiles may be missing
  const c = map.getCenter();   // the camera MapLibre used, which a tall map or a polar centre can change
  sigwxStatic.view = { zoom: map.getZoom(), lat: c.lat, lon: c.lng };
  sigwxStatic.rtl = maplibregl.getRTLTextPluginStatus();   // 'loading' here holds back every tile (MapLibre's one worker)
  const basemapSource = (id) => ['vector', 'raster'].includes(map.getSource(id)?.type);
  sigwxStatic.tiles = Object.fromEntries([...staticTiles].filter(([id]) => basemapSource(id)).map(([id, t]) => [id,
    { type: map.getSource(id).type, ok: [...t.ok].filter((k) => !t.failed.has(k)).length, failed: t.failed.size, statuses: t.statuses }]));
  sigwxStatic.ready = true;
}

if (STATIC_MODE) {
  map.on('idle', () => {
    if (!staticStep) return;
    staticIdle = true;
    staticReady();
  });
  // A style that loads only after the 20 s timer has fired, with no idle after it, is ready too.
  map.once('style.load', () => staticReady());
  // The attribution control fills the strip on a source's 'metadata' event (its
  // TileJSON has arrived) or 'visibility' event (a frame has marked it used), whichever comes
  // last; it listens first, so the strip is up to date when this runs.
  map.on('sourcedata', (e) => {
    if (e.sourceDataType === 'metadata' || e.sourceDataType === 'visibility') staticReady();
  });
}

// ---- web fonts: one barrier for the call-out, legend and KEY fonts, default or not ----

// Each family the chart draws with (fonts.labels, fonts.text) is loaded at 400 and 700, with
// sample text so the subsets the chart uses come too. A family index.html does not load gets
// a Google Fonts stylesheet first. A font that does not load in FONT_WAIT_MS, or loads without
// the weight asked for (load() then returns the nearest weight), is an error: it fails a
// static render and shows in the app's style banner. Then the KEY's canvases, drawn before
// the fonts arrived, are drawn again, and the call-outs, measured with them, placed again.
const FONT_SAMPLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789°≤–/?.';
const FONT_WAIT_MS = 20 * 1000;
// A FontFace weight is a number, a keyword or a range such as '100 900'.
const weightOf = (x) => (x === 'normal' ? 400 : x === 'bold' ? 700 : Number(x));
const covers = (spec, w) => { const [a, b = a] = String(spec).split(' ').map(weightOf); return w >= a && w <= b; };
async function loadFonts() {
  const S = STYLE, families = [...new Set([S.fonts.labels, S.fonts.text])];
  const href = googleFontsHref();
  if (href) {
    await new Promise((resolve, reject) => {
      const link = el('link', { rel: 'stylesheet', href });
      link.addEventListener('load', resolve, { once: true });
      const linked = families.filter((f) => !PAGE_FAMILIES.includes(f));
      link.addEventListener('error', () => reject(new Error(`Google Fonts did not serve ${linked.map((f) => `"${f}"`).join(' and ')} with weights 400 and 700`)), { once: true });
      document.head.append(link);
    });
  }
  for (const family of families) {
    for (const w of [400, 700]) {
      const faces = await document.fonts.load(`${w} 12px "${family}"`, FONT_SAMPLE);
      if (!faces.length || !faces.every((f) => covers(f.weight, w))) throw new Error(`font "${family}" weight ${w} did not load`);
    }
  }
  await document.fonts.ready;
}
let fontTimer;
const fontsLoaded = loadFonts();
Promise.race([fontsLoaded, new Promise((_, reject) => {
  fontTimer = setTimeout(() => reject(new Error(`the fonts did not load within ${FONT_WAIT_MS / 1000} s`)), FONT_WAIT_MS);
})]).finally(() => clearTimeout(fontTimer)).then(() => {
  buildKey();
  overlay.redraw();
  if (STATIC_MODE) { staticFonts = true; staticReady(); }
}, (err) => {
  if (STATIC_MODE) sigwxStatic.error ??= err.message;
  // The app carries on with whatever font the browser falls back to, drawn again with it, and
  // again if a font that timed out arrives after all.
  state.styleError = [state.styleError, `${err.message} (a fallback font is used)`].filter(Boolean).join('; ');
  renderBanners();
  buildKey();
  overlay.redraw();
  if (!STATIC_MODE) fontsLoaded.then(() => { buildKey(); overlay.redraw(); }, () => {});
});

// ---- render ----

function renderAll() {
  renderControls();
  renderBanners();
  renderLegend();
  renderHidden();
}

buildKey();
renderAll();
load(state.want, 'init');

// For checks from the browser console and Playwright.
Object.assign(window, { sigwx: { map, state, overlay } });
