// Chart style: the job's `style` object. Browser-safe
// ES module, also used by the CLI. One table gives every key's default and check; parseStyle
// validates a job's overrides and merges them over the defaults; setStyle makes a style
// current. Every module reads STYLE when it draws, never at import, so setStyle must run
// before the map is created.

// The basemap glyph server's font stacks (probed 2026-10-30: these answer 200; Metropolis
// Regular, Noto Sans Mono Regular, Open Sans Regular and Roboto Regular answer 403).
export const GLYPH_STACKS = ['Noto Sans Regular', 'Noto Sans Bold', 'Noto Sans Italic', 'Metropolis Bold', 'Metropolis Semi Bold'];
// The call-out priority names, highest first by default, and the model's key for each.
export const PRIORITY_KEYS = {
  severeTurbulence: 'catSEV', severeIcing: 'icingSEV', volcanoes: 'volcano', cyclones: 'tc',
  cb: 'cb', moderateTurbulence: 'catMOD', moderateIcing: 'icingMOD',
};
// Web font families index.html already loads (Noto Sans 400/600/700, Noto Sans Mono 400/700).
export const PAGE_FAMILIES = ['Noto Sans', 'Noto Sans Mono'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (min, max) => (v) => (isNum(v) && v >= min && v <= max ? null : `must be a number from ${min} to ${max}`);
const whole = (min, max) => (v) => (Number.isInteger(v) && v >= min && v <= max ? null : `must be a whole number from ${min} to ${max}`);
const oneOf = (...vals) => (v) => (vals.includes(v) ? null : `must be one of ${vals.map((x) => JSON.stringify(x)).join(', ')}`);
const color = (v) => (typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? null : 'must be a colour like "#1d4ed8" or "#fff"');
const colorOrNull = (v) => (v === null ? null : color(v) && 'must be null or a colour like "#1d4ed8" or "#fff"');
const bool = (v) => (typeof v === 'boolean' ? null : 'must be true or false');
const weight = oneOf('regular', 'bold');
const glyphs = oneOf(...GLYPH_STACKS);
const family = (v) => (typeof v === 'string' && v.length <= 40 && /^[A-Za-z0-9]+( [A-Za-z0-9]+)*$/.test(v)
  ? null : 'must be a Google Fonts family name: letters and digits, single spaces between words, at most 40 characters');
// A MapLibre line-dasharray, in line widths: dash, gap, dash, … with every dash above 0.
const dash = (v) => (Array.isArray(v) && v.length >= 2 && v.length <= 8 && v.every((x) => isNum(x) && x >= 0 && x <= 20)
  && v.every((x, i) => i % 2 || x > 0)
  ? null : 'must be a list of 2 to 8 numbers from 0 to 20 (dash, gap, …), every dash above 0; [1, 0] is solid');
const priority = (v) => {
  const names = Object.keys(PRIORITY_KEYS);
  return Array.isArray(v) && v.length === names.length && names.every((n) => v.includes(n))
    ? null : `must list each of ${names.map((n) => JSON.stringify(n)).join(', ')} once, highest priority first`;
};

// [path, default, check], grouped as the README lists them. Defaults are today's values.
export const FIELDS = [
  ['fonts.mapRegular', 'Noto Sans Regular', glyphs],
  ['fonts.mapBold', 'Noto Sans Bold', glyphs],
  ['fonts.labels', 'Noto Sans Mono', family],
  ['fonts.text', 'Noto Sans', family],

  ['symbols.color', '#000', color],
  ['symbols.halo', '#fff', color],
  ['symbols.haloWidth', 1.5, num(0, 4)],
  ['symbols.stroke', 0.085, num(0.05, 0.12)],

  ['jets.line.color', '#000', color],
  ['jets.line.width', 4, num(1, 12)],
  ['jets.casing.color', '#fff', color],
  ['jets.casing.width', 7, num(0, 20)],
  ['jets.label.size', 13, num(8, 24)],
  ['jets.label.color', '#000', color],
  ['jets.label.halo', '#fff', color],
  ['jets.label.haloWidth', 1.5, num(0, 4)],
  ['jets.label.speedWeight', 'bold', weight],
  ['jets.label.weight', 'regular', weight],
  ['jets.barbs.scale', 1, num(0.5, 2)],
  ['jets.barbs.width', 2, num(0.5, 5)],
  ['jets.arrowSize', 24, num(12, 48)],
  ['jets.changeBarSize', 24, num(12, 48)],

  ['turbulence.moderate.fill', '#808080', color],
  ['turbulence.moderate.opacity', 0.2, num(0, 1)],
  ['turbulence.severe.fill', '#4a4a4a', color],
  ['turbulence.severe.opacity', 0.35, num(0, 1)],
  ['turbulence.outline.color', '#000', color],
  ['turbulence.outline.width', 2.5, num(0.5, 10)],
  ['turbulence.outline.dash', [3, 2], dash],
  ['turbulence.casing.color', '#fff', color],
  ['turbulence.casing.width', 5.5, num(0, 20)],

  ['icing.moderate.fill', '#9d4edd', color],
  ['icing.moderate.opacity', 0.18, num(0, 1)],
  ['icing.severe.fill', '#5a189a', color],
  ['icing.severe.opacity', 0.35, num(0, 1)],
  ['icing.line.color', '#7b2cbf', color],
  ['icing.line.width', 2, num(0.5, 10)],
  ['icing.line.fallbackDash', [2, 1.5], dash],
  ['icing.ticks.width', 1.5, num(0.5, 6)],
  ['icing.ticks.length', 7, num(2, 20)],
  ['icing.ticks.spacing', 18, num(6, 60)],

  ['hatch.opacity', 0.6, num(0, 1)],
  ['hatch.size', 8, whole(4, 32)],
  ['hatch.color', '#000', color],
  ['hatch.width', 1.5, num(0.5, 16)],
  ['hatch.edge', '#fff', color],
  ['hatch.edgeWidth', 3.5, num(0, 16)],

  ['cb.color', '#e00000', color],
  ['cb.width', 2, num(0.5, 10)],
  ['cb.scallop', 14, num(6, 40)],

  ['tropopause.color', '#1d4ed8', color],
  ['tropopause.border', '#1d4ed8', color],
  ['tropopause.fill', '#fff', color],
  ['tropopause.borderWidth', 1.5, num(0, 4)],
  ['tropopause.size', 11, num(8, 24)],
  ['tropopause.weight', 'bold', weight],

  ['volcanoes.size', 24, num(12, 48)],
  ['cyclones.size', 24, num(12, 48)],

  ['grid.color', '#8b929c', color],
  ['grid.width', 1, num(0.5, 4)],
  ['grid.dash', [1, 4], dash],
  ['grid.spacing', 10, oneOf(5, 10, 15, 20, 30)],
  ['grid.labelEvery', 30, whole(5, 90)],
  ['grid.allLabelsFromZoom', 5, num(0, 24)],
  ['grid.label.size', 11, num(8, 24)],
  ['grid.label.color', '#374151', color],
  ['grid.label.halo', '#fff', color],
  ['grid.label.haloWidth', 1.5, num(0, 4)],
  ['grid.label.weight', 'regular', weight],

  ['callouts.size', 11, num(8, 20)],
  ['callouts.color', '#000', color],
  ['callouts.fill', '#fff', color],
  ['callouts.border', '#000', color],
  ['callouts.borderWidth', 1.5, num(0, 4)],
  ['callouts.weight', 'regular', weight],
  ['callouts.headerWeight', 'bold', weight],
  ['callouts.paddingX', 5, num(2, 12)],
  ['callouts.paddingY', 3, num(1, 10)],
  ['callouts.symbolSize', 18, num(10, 28)],
  ['callouts.symbolGap', 4, num(0, 12)],
  ['callouts.leader.color', '#000', color],
  ['callouts.leader.width', 1.5, num(0.5, 4)],
  ['callouts.leader.casing', '#fff', color],
  ['callouts.leader.casingWidth', 4, num(0, 10)],
  ['callouts.leader.arrowLength', 9, num(4, 20)],
  ['callouts.leader.arrowWidth', 8, num(4, 20)],
  ['callouts.priority', Object.keys(PRIORITY_KEYS), priority],
  ['callouts.repeats.max', 3, whole(0, 10)],
  ['callouts.repeats.spacing', 400, num(100, 2000)],
  ['callouts.repeats.minClearance', 24, num(8, 200)],
  ['callouts.edgePieces', true, bool],

  ['legend.size', 10.5, num(8, 16)],
  ['legend.lineHeight', 1.4, num(1, 2)],
  ['legend.paddingX', 8, num(0, 20)],
  ['legend.paddingY', 5, num(0, 20)],
  ['legend.color', '#000', color],
  ['legend.background', '#fff', color],
  ['legend.border', '#000', color],
  ['legend.borderWidth', 1.5, num(0, 4)],

  ['key.size', 12, num(9, 16)],
  ['key.headingSize', 11, num(8, 16)],
  ['key.chipSize', 10.5, num(8, 16)],
  ['key.color', '#0b1220', color],
  ['key.background', '#fff', color],
  ['key.headingColor', '#4b5563', color],
  ['key.noteColor', '#374151', color],
  ['key.ruleColor', '#eef0f4', color],

  ['panel.background', null, colorOrNull],
  ['panel.columnWidth', 280, num(240, 480)],
  ['panel.columnGap', 10, num(0, 40)],
  ['panel.padding', 10, num(0, 40)],

  ['attribution.size', 10, num(8, 14)],

  ['basemap.roads', false, bool],
  ['basemap.roadLabels', false, bool],
  ['basemap.buildings', false, bool],
  ['basemap.pointsOfInterest', false, bool],
  ['basemap.stateBorders', false, bool],
];

const LEAVES = new Map(FIELDS.map(([path, dflt, check]) => [path, { dflt, check }]));
const GROUPS = new Set(FIELDS.flatMap(([path]) => path.split('.').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('.'))));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (Array.isArray(v) ? [...v] : v);

function setPath(obj, path, value) {
  const keys = path.split('.'), last = keys.pop();
  let o = obj;
  for (const k of keys) o = (o[k] ??= {});
  o[last] = value;
}

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

function defaults() {
  const s = {};
  for (const [path, dflt] of FIELDS) setPath(s, path, clone(dflt));
  return s;
}
export const DEFAULT_STYLE = deepFreeze(defaults());

// Rules between keys, checked only when the keys involved are valid themselves.
const CROSS = [
  [['jets.line.width', 'jets.arrowSize'], (s) => ((s.jets.line.width + 0.2) / 0.7 <= s.jets.arrowSize ? null
    : '"style.jets.arrowSize" is too small for "style.jets.line.width": the arrowhead must cover the line\'s end ((line width + 0.2) / 0.7 ≤ arrowSize)')],
  [['jets.barbs.width', 'jets.barbs.scale'], (s) => (s.jets.barbs.width + 1 <= 5.17 * s.jets.barbs.scale ? null
    : '"style.jets.barbs.width" is too wide for "style.jets.barbs.scale": feathers would merge (width + 1 ≤ 5.17 × scale)')],
  [['jets.changeBarSize', 'jets.line.width'], (s) => (0.42 * s.jets.changeBarSize >= s.jets.line.width / 2 + 2 ? null
    : '"style.jets.changeBarSize" is too small for "style.jets.line.width": the bar must reach 2 px past the line (0.42 × changeBarSize ≥ line width / 2 + 2)')],
  [['grid.labelEvery', 'grid.spacing'], (s) => (s.grid.labelEvery % s.grid.spacing === 0 ? null
    : '"style.grid.labelEvery" must be a multiple of "style.grid.spacing"')],
  [['hatch.width', 'hatch.size'], (s) => (s.hatch.width <= s.hatch.size / 2 ? null : '"style.hatch.width" must be at most half of "style.hatch.size"')],
  [['hatch.edgeWidth', 'hatch.size'], (s) => (s.hatch.edgeWidth <= s.hatch.size / 2 ? null : '"style.hatch.edgeWidth" must be at most half of "style.hatch.size"')],
];

// The job's style object (or undefined) → {style: the full merged style, errors: [line]}.
// Every problem is listed; with errors, style holds the valid keys only.
export function parseStyle(input) {
  const style = defaults(), errors = [], bad = new Set();
  if (input === undefined) return { style: deepFreeze(style), errors };
  if (!isObj(input)) return { style: deepFreeze(style), errors: ['"style" must be an object'] };
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      // A key is one name: "jets.line.width" is not a way to write jets → line → width.
      if (k.includes('.')) { errors.push(`unknown key "style.${path}"`); continue; }
      const leaf = LEAVES.get(path);
      if (leaf) {
        const msg = leaf.check(v);
        if (msg) { errors.push(`"style.${path}" ${msg}`); bad.add(path); } else setPath(style, path, clone(v));
      } else if (GROUPS.has(path)) {
        if (isObj(v)) walk(v, path);
        else { errors.push(`"style.${path}" must be an object`); for (const p of LEAVES.keys()) if (p.startsWith(`${path}.`)) bad.add(p); }
      } else errors.push(`unknown key "style.${path}"`);
    }
  };
  walk(input, '');
  for (const [paths, rule] of CROSS) {
    if (paths.some((p) => bad.has(p))) continue;
    const msg = rule(style);
    if (msg) errors.push(msg);
  }
  return { style: deepFreeze(style), errors };
}

// The current style, read by every module when it draws (an ES live binding).
export let STYLE = DEFAULT_STYLE;
export function setStyle(style) { STYLE = style; }

// The job's style as the static URL carries it: only what the job sets.
export const styleParam = (obj) => (isObj(obj) && Object.keys(obj).length ? encodeURIComponent(JSON.stringify(obj)) : null);

// ---- derived values: each equals today's constant at the defaults ----

const r3 = (x) => Math.round(x * 1000) / 1000;
// Half the jet line: where barbs start, and the band the halo leaves clear on line symbols.
export const jetHalf = (s = STYLE) => s.jets.line.width / 2;
// How far the arrow's tip lies past the jet's last vertex: where the head is 0.2 px wider
// than the line, so it covers the line's square end (6 px at a 4 px line).
export const arrowTip = (s = STYLE) => r3((s.jets.line.width + 0.2) / 0.7);
// Jet label offsets in em: a fleche's label clears the line's casing; a change bar's clears
// the bar (0.42 of its size each way) and its halo. 6.9 and 2.72 px are today's clearances.
const jetEnvelope = (s) => Math.max(s.jets.casing.width, s.jets.line.width) / 2;
export const flecheLabelEm = (s = STYLE) => r3((jetEnvelope(s) + 6.9) / s.jets.label.size);
export const barLabelEm = (s = STYLE) =>
  r3((Math.max(0.42 * s.jets.changeBarSize + s.symbols.haloWidth, jetEnvelope(s)) + 2.72) / s.jets.label.size);
// Call-out text line height, px.
export const calloutLine = (s = STYLE) => Math.round(s.callouts.size * 13 / 11);
// The text colour of a KEY notation chip, which takes the call-out box's fill: the call-out
// ink, except at the defaults, where null keeps the KEY ink (today's pixels).
export const chipInk = (s = STYLE) => (s.callouts.color === DEFAULT_STYLE.callouts.color
  && s.key.color === DEFAULT_STYLE.key.color ? null : s.callouts.color);
// Call-out ink outside its nominal box: the excess of a border wider than today's 1.5 px.
export const calloutBorderGrow = (s = STYLE) => Math.max(0, s.callouts.borderWidth - 1.5) / 2;
// Leader geometry (collision and drawing): arrowhead length and half-width, the cased shaft's
// and the cased head's half-widths, and the head's casing stroke.
export function leaderGeometry(s = STYLE) {
  const L = s.callouts.leader, headCasing = 0.75 * L.casingWidth;
  return {
    len: L.arrowLength, half: L.arrowWidth / 2, headCasing,
    shaftHalf: Math.max(L.casingWidth, L.width) / 2, headHalf: L.arrowWidth / 2 + headCasing / 2,
  };
}
// The model's call-out priority (0 = placed first) for a model key such as 'catSEV';
// undefined for a key with none (a level other than MOD or SEV), as before.
export function priorityOf(key, s = STYLE) {
  const i = s.callouts.priority.findIndex((name) => PRIORITY_KEYS[name] === key);
  return i < 0 ? undefined : i;
}
// The font string for a call-out, legend or KEY canvas.
export const canvasFont = (weightName, sizePx, fam) => `${weightName === 'bold' ? 'bold ' : ''}${sizePx}px "${fam}"`;
// The map font stack for a weight.
export const mapFont = (weightName, s = STYLE) => [weightName === 'bold' ? s.fonts.mapBold : s.fonts.mapRegular];
// The SIGWX map font a failed glyph request was for, or null. SIGWX labels are ASCII and °,
// all in range 0-255, so only that range of the style's two stacks counts; the basemap's own
// requests (other stacks, other ranges) never do. MapLibre's error carries the URL with the
// stack's spaces as they are (seen with 4.7.1: ".../fonts/Nope Regular/0-255.pbf").
export function failedMapFont(url, s = STYLE) {
  const u = String(url ?? '');
  return [s.fonts.mapRegular, s.fonts.mapBold].find((f) =>
    u.includes(`/fonts/${f}/0-255.pbf`) || u.includes(`/fonts/${encodeURIComponent(f)}/0-255.pbf`)) ?? null;
}

// The Google Fonts stylesheet for the style's web families that index.html does not load
// (weights 400 and 700), or null.
export function googleFontsHref(s = STYLE) {
  const fams = [...new Set([s.fonts.labels, s.fonts.text])].filter((f) => !PAGE_FAMILIES.includes(f));
  if (!fams.length) return null;
  return `https://fonts.googleapis.com/css2?${fams.map((f) => `family=${f.replaceAll(' ', '+')}:wght@400;700`).join('&')}&display=swap`;
}
