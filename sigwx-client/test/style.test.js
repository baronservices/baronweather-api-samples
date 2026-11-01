import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FIELDS, DEFAULT_STYLE, STYLE, parseStyle, setStyle, styleParam, googleFontsHref, priorityOf,
  jetHalf, arrowTip, flecheLabelEm, barLabelEm, calloutLine, calloutBorderGrow, leaderGeometry, canvasFont, mapFont, chipInk,
} from '../public/lib/style.js';
import { buildLayers, addSigwxLayers } from '../public/map/layers.js';
import { hideClutter, basemapRequest } from '../public/map/basemap.js';
import { buildStep } from '../public/lib/model.js';
import { failedMapFont } from '../public/lib/style.js';
import { tropoEdge, mapSize } from '../public/map/symbols.js';
import { leaderPieces } from '../public/lib/callouts.js';
import { inkMargin } from '../public/map/overlay.js';

// Runs fn with the style that `obj` gives, then restores the default.
function withStyle(obj, fn) {
  const { style, errors } = parseStyle(obj);
  assert.deepEqual(errors, []);
  setStyle(style);
  try { return fn(style); } finally { setStyle(DEFAULT_STYLE); }
}
const errorsOf = (obj) => parseStyle(obj).errors;
const nest = (path, value) => path.split('.').reduceRight((v, k) => ({ [k]: v }), value);
const fakeMap = () => {
  const sources = {}, layers = [];
  return { sources, layers, getSource: (id) => sources[id], addSource: (id, s) => { sources[id] = s; },
    getLayer: (id) => layers.find((l) => l.id === id), addLayer: (l) => layers.push(l) };
};

// ---- parseStyle ----

test('no style, {} and every key at its default all give the default style', () => {
  assert.deepEqual(parseStyle(undefined), { style: DEFAULT_STYLE, errors: [] });
  assert.deepEqual(parseStyle({}), { style: DEFAULT_STYLE, errors: [] });
  const all = {};
  for (const [path, dflt] of FIELDS) Object.assign(all, merge(all, nest(path, dflt)));
  assert.deepEqual(parseStyle(all), { style: DEFAULT_STYLE, errors: [] });
  assert.equal(STYLE, DEFAULT_STYLE);
});
function merge(a, b) {
  for (const [k, v] of Object.entries(b)) a[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a[k] ?? {}, v) : v;
  return a;
}

test('every default is valid by its own check', () => {
  for (const [path, dflt, check] of FIELDS) assert.equal(check(dflt), null, path);
});

test('a few defaults are the values that were hard-coded', () => {
  const S = DEFAULT_STYLE;
  assert.equal(S.jets.line.width, 4);
  assert.equal(S.turbulence.moderate.fill, '#808080');
  assert.equal(S.icing.line.color, '#7b2cbf');
  assert.deepEqual(S.icing.line.fallbackDash, [2, 1.5]);
  assert.equal(S.cb.color, '#e00000');
  assert.equal(S.tropopause.color, '#1d4ed8');
  assert.equal(S.hatch.opacity, 0.6);
  assert.equal(S.callouts.size, 11);
  assert.equal(S.fonts.labels, 'Noto Sans Mono');
  assert.deepEqual(S.callouts.priority, ['severeTurbulence', 'severeIcing', 'volcanoes', 'cyclones', 'cb', 'moderateTurbulence', 'moderateIcing']);
});

test('overrides merge over the defaults and leave the rest', () => {
  const { style, errors } = parseStyle({ jets: { line: { color: '#ff00ff' } }, grid: { spacing: 15 } });
  assert.deepEqual(errors, []);
  assert.equal(style.jets.line.color, '#ff00ff');
  assert.equal(style.jets.line.width, 4);
  assert.equal(style.grid.spacing, 15);
  assert.equal(DEFAULT_STYLE.jets.line.color, '#000');
  assert.ok(Object.isFrozen(style.jets.line));
});

test('unknown keys, wrong types and groups are reported with their full path', () => {
  assert.deepEqual(errorsOf([]), ['"style" must be an object']);
  assert.deepEqual(errorsOf({ jet: {} }), ['unknown key "style.jet"']);
  assert.deepEqual(errorsOf({ jets: { line: { colour: '#000' } } }), ['unknown key "style.jets.line.colour"']);
  assert.deepEqual(errorsOf({ jets: 4 }), ['"style.jets" must be an object']);
  assert.deepEqual(errorsOf({ jets: { line: { width: { px: 4 } } } }), ['"style.jets.line.width" must be a number from 1 to 12']);
  assert.deepEqual(errorsOf({ jets: { line: { width: '4' } } }), ['"style.jets.line.width" must be a number from 1 to 12']);
});

test('a key is one name: dotted keys are unknown, so no field has two spellings', () => {
  assert.deepEqual(errorsOf({ 'jets.line.width': 6 }), ['unknown key "style.jets.line.width"']);
  assert.deepEqual(errorsOf({ jets: { 'line.width': 6 } }), ['unknown key "style.jets.line.width"']);
  assert.deepEqual(errorsOf({ 'jets.line.width': 6, jets: { line: { width: 4 } } }), ['unknown key "style.jets.line.width"']);
});

test('ranges, colours, enums and whole numbers', () => {
  assert.deepEqual(errorsOf({ jets: { line: { width: 0.5 } } }), ['"style.jets.line.width" must be a number from 1 to 12']);
  assert.deepEqual(errorsOf({ jets: { line: { width: 12 } } }), []);   // (12 + 0.2) / 0.7 ≈ 17.4 ≤ the 24 px arrow
  for (const c of ['red', '#12345', '#1234567', '#ggg', 'rgb(0,0,0)', '#ffff']) {
    assert.deepEqual(errorsOf({ cb: { color: c } }), ['"style.cb.color" must be a colour like "#1d4ed8" or "#fff"'], c);
  }
  for (const c of ['#abc', '#ABCDEF', '#0a0B0c']) assert.deepEqual(errorsOf({ cb: { color: c } }), [], c);
  assert.deepEqual(errorsOf({ grid: { spacing: 12, labelEvery: 36 } }), ['"style.grid.spacing" must be one of 5, 10, 15, 20, 30']);
  assert.deepEqual(errorsOf({ hatch: { size: 8.5 } }), ['"style.hatch.size" must be a whole number from 4 to 32']);
  assert.deepEqual(errorsOf({ callouts: { weight: 'heavy' } }), ['"style.callouts.weight" must be one of "regular", "bold"']);
  assert.deepEqual(errorsOf({ fonts: { mapBold: 'Roboto Bold' } }).length, 1);
  assert.deepEqual(errorsOf({ fonts: { mapBold: 'Metropolis Semi Bold' } }), []);
  assert.deepEqual(errorsOf({ panel: { background: null } }), []);
  assert.deepEqual(errorsOf({ panel: { background: '#123' } }), []);
  assert.deepEqual(errorsOf({ panel: { background: 'none' } }), ['"style.panel.background" must be null or a colour like "#1d4ed8" or "#fff"']);
  assert.deepEqual(errorsOf({ basemap: { roads: 'yes' } }), ['"style.basemap.roads" must be true or false']);
});

test('font families: Google Fonts names, at most 40 characters', () => {
  for (const f of ['Roboto Mono', 'IBM Plex Sans', 'Lato', 'A'.repeat(40)]) assert.deepEqual(errorsOf({ fonts: { text: f } }), [], f);
  for (const f of ['', ' Lato', 'Lato ', 'Noto  Sans', 'A'.repeat(41), 'Lato;x', 'Lato"', 'Noto+Sans']) {
    assert.equal(errorsOf({ fonts: { text: f } }).length, 1, JSON.stringify(f));
  }
});

test('dashes: 2 to 8 numbers from 0 to 20, every dash above 0', () => {
  for (const d of [[1, 0], [3, 2], [2, 1.5, 0.5, 1.5], [20, 20, 20, 20, 20, 20, 20, 20]]) assert.deepEqual(errorsOf({ grid: { dash: d } }), [], JSON.stringify(d));
  for (const d of [[0, 4], [1], [1, 2, 0, 3], [1, 21], [1, -1], Array(9).fill(1), '1 4']) {
    assert.equal(errorsOf({ grid: { dash: d } }).length, 1, JSON.stringify(d));
  }
});

test('priority: each of the seven names once', () => {
  const p = [...DEFAULT_STYLE.callouts.priority];
  assert.deepEqual(errorsOf({ callouts: { priority: [...p].reverse() } }), []);
  for (const bad of [p.slice(1), [...p, 'cb'], [...p.slice(1), 'cb'], [...p.slice(1), 'hail']]) {
    assert.equal(errorsOf({ callouts: { priority: bad } }).length, 1, JSON.stringify(bad));
  }
});

test('cross-field rules', () => {
  // The arrowhead must cover the line's end: (w + 0.2) / 0.7 ≤ arrowSize.
  assert.deepEqual(errorsOf({ jets: { line: { width: 8.2 }, arrowSize: 12 } }), []);
  assert.match(errorsOf({ jets: { line: { width: 8.3 }, arrowSize: 12 } })[0], /arrowhead must cover/);
  // A change bar shows past the line: 0.42 × changeBarSize ≥ line width / 2 + 2.
  assert.deepEqual(errorsOf({ jets: { changeBarSize: 15, line: { width: 8 } } }), []);
  assert.match(errorsOf({ jets: { changeBarSize: 12, line: { width: 12 } } })[0], /bar must reach 2 px past the line/);
  // Feathers stay apart: width + 1 ≤ 5.17 × scale.
  assert.deepEqual(errorsOf({ jets: { barbs: { scale: 1, width: 4.17 } } }), []);
  assert.match(errorsOf({ jets: { barbs: { scale: 0.5, width: 2 } } })[0], /feathers would merge/);
  assert.deepEqual(errorsOf({ grid: { spacing: 15, labelEvery: 45 } }), []);
  assert.deepEqual(errorsOf({ grid: { spacing: 20 } }), ['"style.grid.labelEvery" must be a multiple of "style.grid.spacing"']);
  assert.deepEqual(errorsOf({ hatch: { size: 4, width: 2, edgeWidth: 2 } }), []);
  assert.deepEqual(errorsOf({ hatch: { size: 4 } }), ['"style.hatch.edgeWidth" must be at most half of "style.hatch.size"']);
});

test('every problem is listed; a rule on a bad key is not checked', () => {
  const errs = errorsOf({ jets: { line: { width: 99 }, arrowSize: 12, foo: 1 }, cb: { color: 'red' }, grid: 'x' });
  assert.deepEqual(errs, [
    '"style.jets.line.width" must be a number from 1 to 12',
    'unknown key "style.jets.foo"',
    '"style.cb.color" must be a colour like "#1d4ed8" or "#fff"',
    '"style.grid" must be an object',
  ]);
});

test('styleParam: only a style with keys travels, and it round-trips through a query', () => {
  assert.equal(styleParam(undefined), null);
  assert.equal(styleParam({}), null);
  const obj = { fonts: { text: 'IBM Plex Sans' }, jets: { line: { color: '#ff00ff' } }, grid: { dash: [1, 0] } };
  const q = new URLSearchParams(`a=1&style=${styleParam(obj)}&b=2`);
  assert.deepEqual(JSON.parse(q.get('style')), obj);
});

test('googleFontsHref: none for the page fonts; one link for the others, weights 400 and 700', () => {
  assert.equal(googleFontsHref(DEFAULT_STYLE), null);
  const { style } = parseStyle({ fonts: { labels: 'Roboto Mono', text: 'IBM Plex Sans' } });
  assert.equal(googleFontsHref(style), 'https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@400;700&family=IBM+Plex+Sans:wght@400;700&display=swap');
  const one = parseStyle({ fonts: { labels: 'Lato', text: 'Lato' } }).style;
  assert.equal(googleFontsHref(one), 'https://fonts.googleapis.com/css2?family=Lato:wght@400;700&display=swap');
});

// ---- derived values: today's constants at the defaults ----

test('derived values equal the old constants at the defaults, exactly', () => {
  assert.equal(jetHalf(), 2);
  assert.equal(arrowTip(), 6);   // (4 + 0.2) / 0.7 is 6.000000000000001 before rounding
  assert.equal(flecheLabelEm(), 0.8);
  assert.equal(barLabelEm(), 1.1);
  assert.equal(calloutLine(), 13);
  assert.equal(calloutBorderGrow(), 0);
  assert.deepEqual(leaderGeometry(), { len: 9, half: 4, headCasing: 3, shaftHalf: 2, headHalf: 5.5 });
  assert.equal(tropoEdge(), 3);
  for (const n of ['change-bar', 'jet-arrow', 'volcano', 'tc-nh', 'tc-sh']) assert.equal(mapSize(n), 24);
  assert.deepEqual(['catSEV', 'icingSEV', 'volcano', 'tc', 'cb', 'catMOD', 'icingMOD'].map((k) => priorityOf(k)), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(priorityOf('catLGT'), undefined);
  assert.equal(canvasFont('regular', 11, 'Noto Sans Mono'), '11px "Noto Sans Mono"');
  assert.equal(canvasFont('bold', 10, 'Noto Sans'), 'bold 10px "Noto Sans"');
  assert.deepEqual(mapFont('bold'), ['Noto Sans Bold']);
});

test('derived values follow the style', () => {
  withStyle({ jets: { line: { width: 12 }, casing: { width: 0 }, arrowSize: 30, changeBarSize: 30, label: { size: 10 } }, symbols: { haloWidth: 4 } }, () => {
    assert.equal(jetHalf(), 6);
    assert.equal(arrowTip(), 17.429);
    assert.equal(flecheLabelEm(), 1.29);    // (max(0, 12) / 2 + 6.9) / 10: the line, not the casing, when wider
    assert.equal(barLabelEm(), 1.932);      // (max(0.42 × 30 + 4, 6) + 2.72) / 10
  });
  withStyle({ jets: { casing: { width: 20 }, changeBarSize: 12, label: { size: 10 } }, symbols: { haloWidth: 0 } }, () => {
    assert.equal(barLabelEm(), 1.272);      // (max(0.42 × 12 + 0, 20 / 2) + 2.72) / 10: the casing, when it reaches further
  });
  withStyle({ callouts: { size: 20, borderWidth: 4, leader: { casingWidth: 0, width: 2, arrowLength: 12, arrowWidth: 10 } } }, () => {
    assert.equal(calloutLine(), 24);
    assert.equal(calloutBorderGrow(), 1.25);
    assert.deepEqual(leaderGeometry(), { len: 12, half: 5, headCasing: 0, shaftHalf: 1, headHalf: 5 });
  });
  withStyle({ tropopause: { borderWidth: 4 }, volcanoes: { size: 40 } }, () => {
    assert.equal(tropoEdge(), 5);
    assert.equal(mapSize('volcano'), 40);
    assert.equal(mapSize('tc-nh'), 24);
  });
  withStyle({ callouts: { priority: ['moderateIcing', 'cb', 'severeTurbulence', 'severeIcing', 'volcanoes', 'cyclones', 'moderateTurbulence'] } }, () => {
    assert.equal(priorityOf('icingMOD'), 0);
    assert.equal(priorityOf('cb'), 1);
    assert.equal(priorityOf('catSEV'), 2);
  });
});

test('leader collision pieces follow the leader style', () => {
  const L = [0, 0, 100, 0];
  assert.deepEqual(leaderPieces(L), [[91, 0, 100, 0, 5.5], [0, 0, 91, 0, 2]]);
  withStyle({ callouts: { leader: { arrowLength: 20, arrowWidth: 12, casingWidth: 8 } } }, () => {
    assert.deepEqual(leaderPieces(L), [[80, 0, 100, 0, 9], [0, 0, 80, 0, 4]]);
  });
});

test('ink margins follow the style', () => {
  const map = { getZoom: () => 3 };   // k = 1
  withStyle({ cb: { scallop: 30, width: 4 }, turbulence: { casing: { width: 0 }, outline: { width: 3 } },
    icing: { line: { width: 1 }, ticks: { width: 3, length: 10 } }, cyclones: { size: 40 }, symbols: { haloWidth: 2 } }, () => {
    assert.equal(inkMargin(map, { kind: 'cb' }), 17);
    assert.equal(inkMargin(map, { kind: 'cat' }), 1.5);
    assert.equal(inkMargin(map, { kind: 'icing', ring: [[0, 0]] }), 1.5);
    assert.equal(inkMargin(map, { kind: 'icing', ring: null }), 11.5);
    assert.equal(inkMargin(map, { kind: 'tc', symbol: 'tc-nh' }), 22);
  });
});

// ---- map layers ----

test('default layers are exactly the layers before the style existed', () => {
  const before = JSON.parse(readFileSync(new URL('./fixtures/layers-default.json', import.meta.url), 'utf8'));
  assert.deepEqual(JSON.parse(JSON.stringify(buildLayers())), before);
  // Positive control: one changed key is seen.
  const changed = withStyle({ jets: { line: { color: '#ff00ff' } } }, () => JSON.parse(JSON.stringify(buildLayers())));
  assert.notDeepEqual(changed, before);
});

test('the layers take their paint and layout from the style', () => {
  const byId = (layers) => Object.fromEntries(layers.map((l) => [l.id, l]));
  withStyle({
    jets: { line: { color: '#ff00ff', width: 6 }, casing: { color: '#00ff00', width: 9 }, label: { size: 15, color: '#111', halo: '#eee', haloWidth: 2, weight: 'bold', speedWeight: 'regular' } },
    fonts: { mapRegular: 'Noto Sans Italic', mapBold: 'Metropolis Bold' },
    turbulence: { moderate: { fill: '#010101', opacity: 0.5 }, outline: { dash: [1, 0] } },
    icing: { line: { fallbackDash: [4, 4] }, ticks: { width: 3 } },
    hatch: { opacity: 0.25 }, cb: { color: '#0000ff', width: 3 },
    tropopause: { color: '#123456', size: 14, weight: 'regular' },
    grid: { color: '#222222', width: 2, dash: [2, 2], allLabelsFromZoom: 7, label: { size: 13, weight: 'bold' } },
  }, () => {
    const L = byId(buildLayers());
    assert.deepEqual(L['jet-line'].paint, { 'line-color': '#ff00ff', 'line-width': 6 });
    assert.deepEqual(L['jet-casing'].paint, { 'line-color': '#00ff00', 'line-width': 9 });
    assert.equal(L['jet-symbols'].layout['text-size'], 15);
    assert.deepEqual(L['jet-symbols'].layout['text-font'], ['Metropolis Bold']);
    assert.deepEqual(L['jet-symbols'].layout['text-field'][2], { 'text-font': ['literal', ['Noto Sans Italic']] });
    assert.deepEqual(L['jet-symbols'].paint, { 'text-color': '#111', 'text-halo-color': '#eee', 'text-halo-width': 2 });
    assert.deepEqual(L['jet-arrows'].layout['icon-offset'], ['literal', [arrowTip() - 12, 0]]);
    assert.deepEqual(L['cat-fill-mod'].paint, { 'fill-color': '#010101', 'fill-opacity': 0.5 });
    assert.deepEqual(L['cat-outline'].paint['line-dasharray'], [1, 0]);
    assert.deepEqual(L['icing-line-fallback'].paint['line-dasharray'], [4, 4]);
    assert.equal(L['icing-ticks'].paint['line-width'], 3);
    assert.equal(L['cat-hatch-sev'].paint['fill-opacity'], 0.25);
    assert.deepEqual(L['cb-scallop'].paint, { 'line-color': '#0000ff', 'line-width': 3 });
    assert.deepEqual(L.tropo.layout['text-font'], ['Noto Sans Italic']);
    assert.equal(L.tropo.layout['text-size'], 14);
    assert.equal(L.tropo.paint['text-color'], '#123456');
    assert.deepEqual(L.graticule.paint, { 'line-color': '#222222', 'line-width': 2, 'line-dasharray': [2, 2] });
    assert.equal(L['graticule-labels-10'].minzoom, 7);
    assert.deepEqual(L['graticule-labels'].layout['text-font'], ['Metropolis Bold']);
    assert.equal(L['graticule-labels'].layout['text-size'], 13);
  });
});

// The grid as it was built before the style existed (10° lines, 30° labels within ±60°).
function legacyGrid() {
  const f = (type, coordinates, properties = {}) => ({ type: 'Feature', geometry: { type, coordinates }, properties });
  const fmtLon = (x) => (x === 0 || Math.abs(x) === 180 ? `${Math.abs(x)}°` : `${Math.abs(x)}°${x < 0 ? 'W' : 'E'}`);
  const fmtLat = (y) => (y === 0 ? '0°' : `${Math.abs(y)}°${y < 0 ? 'S' : 'N'}`);
  const lines = [];
  for (let lon = -180; lon < 180; lon += 10) lines.push(f('LineString', [[lon, -85], [lon, 85]]));
  for (let lat = -80; lat <= 80; lat += 10) lines.push(f('LineString', [[-180, lat], [180, lat]]));
  const labels = (major) => {
    const pts = [];
    for (let lon = -180; lon < 180; lon += 10) {
      for (let lat = -80; lat <= 80; lat += 10) {
        if ((lon % 30 === 0 && lat % 30 === 0 && Math.abs(lat) <= 60) !== major) continue;
        pts.push(f('Point', [lon, lat], { label: fmtLon(lon), anchor: 'bottom-left' }));
        pts.push(f('Point', [lon, lat], { label: fmtLat(lat), anchor: 'top-left' }));
      }
    }
    return { type: 'FeatureCollection', features: pts };
  };
  return { graticule: { type: 'FeatureCollection', features: lines }, 'graticule-labels': labels(true), 'graticule-labels-10': labels(false) };
}
const gridOf = () => {
  const map = fakeMap();
  addSigwxLayers(map);
  return Object.fromEntries(['graticule', 'graticule-labels', 'graticule-labels-10'].map((id) => [id, map.sources[id].data]));
};

test('the default grid is exactly the grid before the style existed', () => {
  assert.deepEqual(gridOf(), legacyGrid());
});

test('grid spacing and labelling: multiples of the spacing, anchored on 0°', () => {
  for (const [spacing, labelEvery] of [[15, 30], [30, 30], [5, 45], [20, 60]]) {
    withStyle({ grid: { spacing, labelEvery } }, () => {
      const g = gridOf();
      const lats = g.graticule.features.filter((f) => f.geometry.coordinates[0][0] === -180 && f.geometry.coordinates[1][0] === 180)
        .map((f) => f.geometry.coordinates[0][1]);
      assert.ok(lats.includes(0), `${spacing}: the equator`);
      assert.ok(lats.every((y) => y % spacing === 0 && Math.abs(y) <= 85), `${spacing}: latitudes`);
      const majors = g['graticule-labels'].features.map((f) => f.geometry.coordinates);
      assert.ok(majors.length > 0, `${spacing}/${labelEvery}: major labels`);
      assert.ok(majors.every(([x, y]) => x % labelEvery === 0 && y % labelEvery === 0 && Math.abs(y) <= 60));
      assert.ok(majors.some(([, y]) => y === 0));
      const minors = g['graticule-labels-10'].features.map((f) => f.geometry.coordinates);
      assert.ok(minors.every(([x, y]) => x % spacing === 0 && y % spacing === 0 && !(x % labelEvery === 0 && y % labelEvery === 0 && Math.abs(y) <= 60)));
    });
  }
});

test('failedMapFont: only range 0-255 of the style\'s two map fonts counts (URL as MapLibre 4.7.1 reports it)', () => {
  const at = (stack, range = '0-255') => `https://cdnmaps.velocityweather.com/fonts/${stack}/${range}.pbf`;
  assert.equal(failedMapFont(at('Noto Sans Regular')), 'Noto Sans Regular');
  assert.equal(failedMapFont(at('Noto Sans Bold')), 'Noto Sans Bold');
  assert.equal(failedMapFont(at('Noto%20Sans%20Bold')), 'Noto Sans Bold');
  assert.equal(failedMapFont(`AJAXError:  (403): ${at('Noto Sans Regular')}`), 'Noto Sans Regular');
  assert.equal(failedMapFont(at('Noto Sans Regular', '19968-20223')), null);   // a basemap place name's range
  assert.equal(failedMapFont(at('Noto Sans Italic')), null);                    // a basemap-only stack
  assert.equal(failedMapFont(undefined), null);
  withStyle({ fonts: { mapBold: 'Metropolis Bold' } }, () => {
    assert.equal(failedMapFont(at('Metropolis Bold')), 'Metropolis Bold');
    assert.equal(failedMapFont(at('Noto Sans Bold')), null);
  });
});

test('the call-out priority is read when the step is built, after setStyle', () => {
  const cw = [[0, 0], [0, 4], [4, 4], [4, 0]];
  const raw = { valid_begin: '2026-10-21T12:00:00Z', jet: [], cat: [{ level: 'SEV', geometry: { type: 'Polygon', coordinates: cw }, height: { top: 12000, units: 'm' } }],
    cloud: [{ type: 'CB', distribution: 'FREQ', geometry: { type: 'Polygon', coordinates: cw } }] };
  const prio = () => Object.fromEntries(buildStep(raw, { product: 'sigwx', level: 'mid' }).callouts.map((c) => [c.kind, c.priority]));
  assert.deepEqual(prio(), { cat: 0, cb: 4 });
  withStyle({ callouts: { priority: ['cb', 'moderateIcing', 'severeIcing', 'volcanoes', 'cyclones', 'moderateTurbulence', 'severeTurbulence'] } }, () => {
    assert.deepEqual(prio(), { cat: 6, cb: 0 });
  });
});

test('ink margins at the defaults', () => {
  const map = { getZoom: () => 3.75 };
  assert.equal(inkMargin(map, { kind: 'cat' }), 2.75);
  assert.equal(inkMargin(map, { kind: 'icing', ring: [[0, 0]] }), 1);
  assert.equal(inkMargin(map, { kind: 'icing', ring: null }), 7 + 1);
  assert.equal(inkMargin(map, { kind: 'cb' }), 7 + 1);
  assert.equal(inkMargin(map, { kind: 'volcano', symbol: 'volcano' }), 13.5);
});

test('hideClutter: the basemap flags show their groups; the antimeridian fixes always apply', () => {
  const layers = [
    { id: 'road', type: 'line', 'source-layer': 'transportation' },
    { id: 'road-name', type: 'symbol', 'source-layer': 'transportation_name' },
    { id: 'bldg', type: 'fill', 'source-layer': 'building' },
    { id: 'poi', type: 'symbol', 'source-layer': 'poi' },
    { id: 'hn', type: 'symbol', 'source-layer': 'housenumber' },
    { id: 'state', type: 'line', 'source-layer': 'boundary', filter: ['all', ['>=', 'admin_level', 3]] },
    { id: 'country', type: 'line', 'source-layer': 'boundary', filter: ['==', 'admin_level', 2] },
    { id: 'ocean-line', type: 'line', 'source-layer': 'water', filter: ['==', 'class', 'ocean'] },
    { id: 'water', type: 'fill', 'source-layer': 'water' },
  ];
  const run = () => {
    const hidden = [], translated = [];
    hideClutter({ getStyle: () => ({ layers }),
      setLayoutProperty: (id, p, v) => { if (p === 'visibility' && v === 'none') hidden.push(id); },
      setPaintProperty: (id, p) => { if (p === 'fill-translate') translated.push(id); } });
    return { hidden, translated };
  };
  assert.deepEqual(run(), { hidden: ['road', 'road-name', 'bldg', 'poi', 'hn', 'state', 'ocean-line'], translated: ['water'] });
  withStyle({ basemap: { roads: true, roadLabels: true, buildings: true, pointsOfInterest: true, stateBorders: true } }, () => {
    assert.deepEqual(run(), { hidden: ['hn', 'ocean-line'], translated: ['water'] });
  });
});

// A KEY chip is drawn like a call-out box (callouts.fill), so its text must be the call-outs'
// ink whenever the KEY's own ink could clash with that fill; only at the defaults does it
// keep the KEY ink (today's pixels).
test('chipInk: KEY ink only at the defaults, else the call-out text colour', () => {
  const ink = (obj) => chipInk(parseStyle(obj).style);
  assert.equal(ink({}), null);
  assert.equal(ink({ key: { color: '#ecffd8' } }), '#000');
  assert.equal(ink({ callouts: { color: '#123456' } }), '#123456');
  assert.equal(ink({ key: { color: '#ecffd8' }, callouts: { color: '#123456' } }), '#123456');
});

// ---- basemap requests ----

test('basemap requests go to the local server, which signs them; other requests are left alone', () => {
  const origin = 'http://127.0.0.1:8787';
  assert.deepEqual(basemapRequest('https://cdnmaps.velocityweather.com/data/planet/3/2/3.pbf', origin), { url: 'http://127.0.0.1:8787/api/basemap/data/planet/3/2/3.pbf' });
  assert.deepEqual(basemapRequest('https://cdnmaps.velocityweather.com/fonts/Noto%20Sans%20Regular/0-255.pbf', origin), { url: 'http://127.0.0.1:8787/api/basemap/fonts/Noto%20Sans%20Regular/0-255.pbf' });
  assert.equal(basemapRequest('https://fonts.googleapis.com/css2?family=Inter', origin), undefined);
  assert.equal(basemapRequest('http://127.0.0.1:8787/api/sigwx/sigwx/high', origin), undefined);
});
