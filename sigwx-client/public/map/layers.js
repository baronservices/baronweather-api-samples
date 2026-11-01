// SIGWX sources and layers on a Baron basemap. Browser ES module.
// Source ids are the Step.geo keys plus the generated catLine, cb-scallop, icing-ticks, graticule,
// graticule-labels and graticule-labels-10.
import { scallopRing, tTicks } from '../lib/decorate.js';
import { wrapOffset, chartParts, MAX_LAT } from '../lib/geo.js';
import { registerSymbols } from './symbols.js';
import { hideClutter } from './basemap.js';
import { clampDensity } from '../lib/callouts.js';
import { STYLE, arrowTip, flecheLabelEm, barLabelEm, mapFont } from '../lib/style.js';

const GEO_KEYS = ['catFill', 'icingFill', 'icingLine', 'cbRing', 'jetLine', 'jetPoint', 'tropo', 'vtsPoint'];
const collection = (features) => ({ type: 'FeatureCollection', features });
const feature = (type, coordinates, properties = {}) => ({ type: 'Feature', geometry: { type, coordinates }, properties });

// ---- graticule (static) ----

// Every label names its hemisphere: 30°N, 30°S, 60°W, 120°E, 0°, 180°.
const fmtLon = (x) => (x === 0 || Math.abs(x) === 180 ? `${Math.abs(x)}°` : `${Math.abs(x)}°${x < 0 ? 'W' : 'E'}`);
const fmtLat = (y) => (y === 0 ? '0°' : `${Math.abs(y)}°${y < 0 ? 'S' : 'N'}`);

// The style's grid: lines every `spacing`° (10), at multiples of it: longitudes from −180
// up to 180, latitudes within ±85. Parallels and meridians are straight in Mercator, so two
// vertices each.
const lons = (sp) => Array.from({ length: 360 / sp }, (_, i) => -180 + i * sp);
const lats = (sp) => { const n = Math.floor(85 / sp); return Array.from({ length: 2 * n + 1 }, (_, i) => (i - n) * sp); };
function graticule({ spacing }) {
  return collection([
    ...lons(spacing).map((lon) => feature('LineString', [[lon, -85], [lon, 85]])),
    ...lats(spacing).map((lat) => feature('LineString', [[-180, lat], [180, lat]])),
  ]);
}

// At a grid crossing: the longitude above-right of it, the latitude below-right (offset far
// enough apart that the two do not collide with each other). Every `labelEvery`° (30°)
// crossing within ±60° goes in graticule-labels, shown at every zoom; every other crossing
// goes in graticule-labels-10, shown from `allLabelsFromZoom` (5), so each line in view
// is labelled there.
const isMajor = (lon, lat, every) => lon % every === 0 && lat % every === 0 && Math.abs(lat) <= 60;
function graticuleLabels(major, { spacing, labelEvery }) {
  const points = [];
  for (const lon of lons(spacing)) {
    for (const lat of lats(spacing)) {
      if (isMajor(lon, lat, labelEvery) !== major) continue;
      points.push(feature('Point', [lon, lat], { label: fmtLon(lon), anchor: 'bottom-left' }));
      points.push(feature('Point', [lon, lat], { label: fmtLat(lat), anchor: 'top-left' }));
    }
  }
  return collection(points);
}

// The grid sources for the current style.
const gridSources = (g = STYLE.grid) =>
  ({ graticule: graticule(g), 'graticule-labels': graticuleLabels(true, g), 'graticule-labels-10': graticuleLabels(false, g) });

// ---- layers, bottom to top ----

// Colours, widths, fonts and sizes come from the style (lib/style.js), which the KEY reads too.
const isString = (prop) => ['==', ['typeof', ['get', prop]], 'string'];
const hasKt = ['==', ['typeof', ['get', 'kt']], 'number'];   // fleches and change bars, not the arrow
const lineOf = (prop) => ['case', isString(prop), ['concat', '\n', ['get', prop]], ''];

const fill = (id, source, level, color, opacity) => ({
  id, type: 'fill', source, filter: ['==', ['get', 'level'], level],
  paint: { 'fill-color': color, 'fill-opacity': opacity },
});
// The SEV hatch over a SEV fill: the same image whatever the basemap, so SEV never
// depends on fill contrast; registered by registerSymbols, again after every style change.
const hatch = (id, source, opacity) => ({
  id, type: 'fill', source, filter: ['==', ['get', 'level'], 'SEV'],
  paint: { 'fill-pattern': 'hatch-sev', 'fill-opacity': opacity },
});
const isFallback = ['==', ['get', 'fallback'], true];
const graticuleLabelLayer = (id, minzoom, L, S) => ({
  id, type: 'symbol', source: id, minzoom,
  layout: { 'text-field': ['get', 'label'], 'text-font': mapFont(L.weight, S), 'text-size': L.size,
    'text-anchor': ['get', 'anchor'],
    'text-offset': ['match', ['get', 'anchor'], 'bottom-left', ['literal', [0.3, -0.5]], ['literal', [0.3, 0.5]]] },
  paint: { 'text-color': L.color, 'text-halo-color': L.halo, 'text-halo-width': L.haloWidth },
});

// The map layers for the current style, bottom to top (defaults in brackets where a comment
// names a colour).
export function buildLayers(S = STYLE) {
  const T = S.turbulence, I = S.icing, J = S.jets, G = S.grid;
  return [
    { id: 'graticule', type: 'line', source: 'graticule',
      paint: { 'line-color': G.color, 'line-width': G.width, 'line-dasharray': G.dash } },
    graticuleLabelLayer('graticule-labels', 0, G.label, S),
    graticuleLabelLayer('graticule-labels-10', G.allLabelsFromZoom, G.label, S),
    fill('cat-fill-mod', 'catFill', 'MOD', T.moderate.fill, T.moderate.opacity),
    fill('icing-fill-mod', 'icingFill', 'MOD', I.moderate.fill, I.moderate.opacity),
    fill('cat-fill-sev', 'catFill', 'SEV', T.severe.fill, T.severe.opacity),
    hatch('cat-hatch-sev', 'catFill', S.hatch.opacity),
    fill('icing-fill-sev', 'icingFill', 'SEV', I.severe.fill, I.severe.opacity),
    hatch('icing-hatch-sev', 'icingFill', S.hatch.opacity),
    // A (white) casing under the dashed CAT outline so it reads on the dark and satellite basemaps.
    { id: 'cat-casing', type: 'line', source: 'catLine', paint: { 'line-color': T.casing.color, 'line-width': T.casing.width } },
    { id: 'cat-outline', type: 'line', source: 'catLine',
      paint: { 'line-color': T.outline.color, 'line-width': T.outline.width, 'line-dasharray': T.outline.dash } },
    // Rebuilt and area boundaries are solid; an open fallback line, whose iced side is
    // assumed, is dashed.
    { id: 'icing-line', type: 'line', source: 'icingLine', filter: ['!', isFallback], layout: { 'line-join': 'round' },
      paint: { 'line-color': I.line.color, 'line-width': I.line.width } },
    { id: 'icing-line-fallback', type: 'line', source: 'icingLine', filter: isFallback, layout: { 'line-join': 'round' },
      paint: { 'line-color': I.line.color, 'line-width': I.line.width, 'line-dasharray': I.line.fallbackDash } },
    { id: 'icing-ticks', type: 'line', source: 'icing-ticks',
      paint: { 'line-color': I.line.color, 'line-width': I.ticks.width } },
    { id: 'cb-scallop', type: 'line', source: 'cb-scallop', layout: { 'line-join': 'round' },
      paint: { 'line-color': S.cb.color, 'line-width': S.cb.width } },
    // Invisible, but still hit by queryRenderedFeatures: CB popups.
    { id: 'cb-hit', type: 'fill', source: 'cbRing', paint: { 'fill-color': 'rgba(0,0,0,0)' } },
    // A (white) casing under the (black) jet so it reads on the dark and satellite basemaps.
    { id: 'jet-casing', type: 'line', source: 'jetLine', layout: { 'line-join': 'round' },
      paint: { 'line-color': J.casing.color, 'line-width': J.casing.width } },
    { id: 'jet-line', type: 'line', source: 'jetLine', layout: { 'line-join': 'round' },
      paint: { 'line-color': J.line.color, 'line-width': J.line.width } },
    // Tropopause boxes collide: never over each other or over a jet symbol, label
    // or end arrow (jet-symbols and jet-arrows, above, are placed first); crowded ones appear
    // as you zoom in. Drawn above the jet line so a line never cuts a box.
    { id: 'tropo', type: 'symbol', source: 'tropo',
      layout: { 'text-field': ['concat', 'TROP FL', ['get', 'label']], 'text-font': mapFont(S.tropopause.weight, S), 'text-size': S.tropopause.size,
        'icon-image': 'tropo-box', 'icon-text-fit': 'both', 'icon-text-fit-padding': [1, 3, 1, 3] },
      paint: { 'text-color': S.tropopause.color } },
    // rotate is the segment's clockwise screen angle; every image points +x. The arrow is
    // pulled back so its tip sits arrowTip (6) px past the jet's last vertex: there the head is
    // just wider than the (4 px) line, so the line's square end is covered. It has no label. It
    // always shows (allow-overlap) and takes part in collision, so TROP boxes,
    // below it, are placed around it. MapLibre places the topmost layer first (checked at
    // runtime: with the arrows above jet-symbols, jet-2-s3 at the reference frame was not
    // placed; moved below, it was), so the arrows sit below jet-symbols: jet labels win
    // and an arrowhead may sit under a label.
    { id: 'jet-arrows', type: 'symbol', source: 'jetPoint', filter: ['==', ['get', 'kind'], 'arrow'],
      layout: { 'icon-image': ['get', 'icon'], 'icon-rotate': ['get', 'rotate'],
        'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': false,
        'icon-offset': ['literal', [arrowTip(S) - J.arrowSize / 2, 0]] } },
    // Each fleche and change bar is placed together with its label: speed (bold),
    // then FL and depth when present, one per line, along the jet on the side
    // away from the barbs (labelPlacement). Both or neither: no overlap and nothing optional,
    // so there is never an unlabelled barb or bar and never overlapping text. Where they
    // compete, maxima (with depth) win, then other fleches, then bars.
    { id: 'jet-symbols', type: 'symbol', source: 'jetPoint', filter: hasKt,
      layout: { 'symbol-sort-key': ['case', isString('depth'), 0, ['==', ['get', 'kind'], 'fleche'], 1, 2],
        'icon-image': ['get', 'icon'], 'icon-rotate': ['get', 'rotate'], 'icon-rotation-alignment': 'map',
        'icon-allow-overlap': false, 'icon-optional': false,
        'text-field': ['format',
          ['concat', ['to-string', ['get', 'kt']], 'KT'], { 'text-font': ['literal', mapFont(J.label.speedWeight, S)] },
          ['concat', lineOf('fl'), lineOf('depth')], {}],
        'text-font': mapFont(J.label.weight, S), 'text-size': J.label.size, 'text-allow-overlap': false, 'text-optional': false,
        'text-rotation-alignment': 'map', 'text-rotate': ['get', 'labelRotate'],
        'text-anchor': ['get', 'labelAnchor'],
        // A fleche's label sits on its bare side, 0.8 em off the line so it clears the line's
        // casing; a change bar crosses the line both ways, so its label clears the
        // bar's 12 px half-length (flecheLabelEm and barLabelEm at the defaults).
        'text-offset': ['case', ['==', ['get', 'kind'], 'bar'],
          ['match', ['get', 'labelAnchor'], 'top', ['literal', [0, barLabelEm(S)]], ['literal', [0, -barLabelEm(S)]]],
          ['match', ['get', 'labelAnchor'], 'top', ['literal', [0, flecheLabelEm(S)]], ['literal', [0, -flecheLabelEm(S)]]]] },
      paint: { 'text-color': J.label.color, 'text-halo-color': J.label.halo, 'text-halo-width': J.label.haloWidth } },
    { id: 'vts-symbols', type: 'symbol', source: 'vtsPoint',
      layout: { 'icon-image': ['get', 'icon'], 'icon-allow-overlap': true } },
  ];
}

// Idempotent: skips any source or layer that is already present.
export function addSigwxLayers(map) {
  const grid = gridSources();
  for (const id of [...Object.keys(grid), ...GEO_KEYS, 'catLine', 'cb-scallop', 'icing-ticks']) {
    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: grid[id] ?? collection([]) });
  }
  for (const layer of buildLayers()) if (!map.getLayer(layer.id)) map.addLayer(layer);
}

// ---- data ----

// Label properties for a jet symbol point: the text runs along the jet, kept upright,
// on the side away from the barbs (NH barbs are left of the flow, SH right, by latitude
// as in jets.js). Only these copies get them; the model's features are not touched.
function labelPlacement(f) {
  const { rotate } = f.properties;
  const flip = rotate > 90 || rotate <= -90;
  const below = (f.geometry.coordinates[1] >= 0) !== flip;   // below in the text's own frame
  return {
    ...f,
    properties: { ...f.properties, labelRotate: flip ? rotate - Math.sign(rotate) * 180 : rotate,
      labelAnchor: below ? 'top' : 'bottom' },
  };
}

// Lines are drawn only within the chart (±MAX_LAT): MapLibre would draw a part beyond it flat
// along the top or bottom edge of the world. A line wholly within keeps its feature as it is;
// coords defaults to the line's own (a polygon passes its ring, for its outline).
function onChart(f, coords = f.geometry.coordinates) {
  const parts = chartParts(coords);
  if (parts.length === 1 && parts[0].length === coords.length) return f;
  return parts.length ? { ...f, geometry: { type: 'MultiLineString', coordinates: parts } } : null;
}
const drawable = (fc, fn) => collection(fc.features.map(fn).filter(Boolean));

// Sets the data on every Step.geo source and on catLine (the CAT outlines, from catFill), then
// redecorates; a null step clears them. Jet symbols beyond the chart are left out with their line.
export function setStep(map, step) {
  const data = (key) => step?.geo?.[key] ?? collection([]);
  const drawn = {
    jetLine: drawable(data('jetLine'), (f) => onChart(f)),
    jetPoint: drawable(data('jetPoint'), (f) => (Math.abs(f.geometry.coordinates[1]) > MAX_LAT ? null : typeof f.properties.kt === 'number' ? labelPlacement(f) : f)),
    icingLine: drawable(data('icingLine'), (f) => onChart(f)),
    catLine: drawable(data('catFill'), (f) => onChart(f, f.geometry.coordinates[0])),
  };
  for (const key of [...GEO_KEYS, 'catLine']) map.getSource(key)?.setData(drawn[key] ?? data(key));
  redecorate(map, step);
}

// ---- decorations: CB scallops and icing T-ticks, at the map's zoom, culled and clipped ----

const bboxes = new WeakMap();   // coordinate array -> [w, s, e, n]
function bboxOf(coords) {
  let b = bboxes.get(coords);
  if (!b) {
    b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of coords) {
      b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
    }
    bboxes.set(coords, b);
  }
  return b;
}

// The visible bounds grown by f of their size on each side: by default to 1.5x on each
// axis, the culling box. Longitudes are not wrapped.
function cullBox(map, f = 0.25) {
  const b = map.getBounds();
  const w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
  const dx = (e - w) * f, dy = (n - s) * f;
  return [w - dx, s - dy, e + dx, n + dy];
}

// Unwrapped coordinates may sit a world away from the view, so the bbox is tried at the
// world copy nearest the view and at one more copy each side.
function intersects(bb, v) {
  if (bb[1] > v[3] || bb[3] < v[1]) return false;
  const k = wrapOffset((bb[0] + bb[2]) / 2, (v[0] + v[2]) / 2);
  return [k - 360, k, k + 360].some((d) => bb[0] + d <= v[2] && bb[2] + d >= v[0]);
}

// Rebuilds cb-scallop and icing-ticks at the map's zoom, so their sizes are the style's
// px, for features whose bbox meets the culling box, and only their parts within one
// view of the view (a drag shows those before the next redecorate): at high zoom a
// whole ring would need millions of vertices. Builds new arrays; model arrays are never
// mutated.
export function redecorate(map, step) {
  const scallops = map.getSource('cb-scallop'), ticks = map.getSource('icing-ticks');
  if (!scallops || !ticks) return;
  const z = map.getZoom(), v = cullBox(map), clip = cullBox(map, 1);
  const rings = step?.geo?.cbRing.features ?? [], lines = step?.geo?.icingLine.features ?? [];
  const drawn = (f) => f.geometry.coordinates.length > 0;
  scallops.setData(collection(rings
    .filter((f) => intersects(bboxOf(f.geometry.coordinates[0]), v))
    .map((f) => feature('MultiLineString', scallopRing(f.geometry.coordinates[0], z, STYLE.cb.scallop, clip), { id: f.properties.id }))
    .filter(drawn)));
  const T = STYLE.icing.ticks;
  ticks.setData(collection(lines
    .filter((f) => intersects(bboxOf(f.geometry.coordinates), v))
    .map((f) => feature('MultiLineString', chartParts(f.geometry.coordinates).flatMap((part) => tTicks(part, z, f.properties.tickSide, T.spacing, T.length, clip)), { id: f.properties.id }))
    .filter(drawn)));
}

// ---- toggles ----

// Layer ids per toggle key; the keys match Step.counts, plus graticule. Volcano and TC
// share vts-symbols and are toggled by filter.
export const TOGGLE_LAYERS = {
  graticule: ['graticule', 'graticule-labels', 'graticule-labels-10'],
  cat: ['cat-fill-mod', 'cat-fill-sev', 'cat-hatch-sev', 'cat-casing', 'cat-outline'],
  icing: ['icing-fill-mod', 'icing-fill-sev', 'icing-hatch-sev', 'icing-line', 'icing-line-fallback', 'icing-ticks'],
  cb: ['cb-scallop', 'cb-hit'],
  tropo: ['tropo'],
  jet: ['jet-casing', 'jet-line', 'jet-arrows', 'jet-symbols'],
};

// toggles: {key: boolean}; a missing key means shown.
export function applyToggles(map, toggles = {}) {
  for (const [key, ids] of Object.entries(TOGGLE_LAYERS)) {
    for (const id of ids) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', toggles[key] === false ? 'none' : 'visible');
    }
  }
  if (!map.getLayer('vts-symbols')) return;
  const icons = [...(toggles.volcano === false ? [] : ['volcano']), ...(toggles.tc === false ? [] : ['tc-nh', 'tc-sh'])];
  map.setFilter('vts-symbols', ['in', ['get', 'icon'], ['literal', icons]]);
}

// ---- label density ----

// MapLibre's collision padding on the jet symbols and TROP boxes: 2/d px (its default is 2).
// It only spaces placed symbols; overlap stays off.
export function applyDensity(map, density) {
  const pad = 2 / clampDensity(density);
  for (const id of ['jet-symbols', 'tropo']) {
    if (!map.getLayer(id)) continue;
    map.setLayoutProperty(id, 'text-padding', pad);
    map.setLayoutProperty(id, 'icon-padding', pad);
  }
}

// ---- wiring ----

const attached = new WeakSet();

// Call once per map, right after creating it. getState() returns {step, toggles, density}.
// - The single style.load handler runs on the first style and after every
//   setStyle(url, {diff: false}), which drops all custom sources, layers and images. It
//   ends by re-applying the label density, whose padding a new style resets.
// - zoomend and moveend redecorate; both fire for a zoom, so they share one frame.
// - Rotation and pitch are disabled: fleche and label placement assume bearing 0, pitch 0.
export function attachSigwx(map, getState) {
  if (attached.has(map)) return;
  attached.add(map);
  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();
  map.touchPitch.disable();
  map.keyboard.disableRotation();
  map.on('style.load', () => {
    const { step = null, toggles = {}, density } = getState();
    registerSymbols(map);
    addSigwxLayers(map);
    hideClutter(map);
    setStep(map, step);
    redecorate(map, step);
    applyToggles(map, toggles);
    applyDensity(map, density);
  });
  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      redecorate(map, getState().step);
    });
  };
  map.on('zoomend', later);
  map.on('moveend', later);
}
