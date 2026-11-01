import fs from 'node:fs';
import { toMs } from '../public/lib/time.js';
import { parseStyle, styleParam } from '../public/lib/style.js';

export class JobError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JobError';
  }
}

// Job layer name -> internal toggle key (also the order used in the static URL).
export const LAYER_KEYS = {
  jets: 'jet', cb: 'cb', turbulence: 'cat', icing: 'icing',
  tropopause: 'tropo', volcanoes: 'volcano', cyclones: 'tc', grid: 'graticule',
};

const MAX_PX = 8192;   // the most px allowed for width × scale and for height × scale
const TOP_KEYS = ['output', 'product', 'level', 'valid', 'center', 'zoom', 'basemap', 'density', 'layers', 'legend', 'key', 'width', 'height', 'scale', 'style'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function parseJob(obj) {
  if (!isObj(obj)) throw new JobError('job must be a JSON object');
  const errs = [];
  for (const k of Object.keys(obj)) if (!TOP_KEYS.includes(k)) errs.push(`unknown key "${k}"`);

  const pick = (k, def) => (obj[k] === undefined ? def : obj[k]);
  const oneOf = (k, def, allowed) => {
    const v = pick(k, def);
    if (!allowed.includes(v)) { errs.push(`"${k}" must be one of ${allowed.join(', ')}`); return def; }
    return v;
  };
  const num = (k, def, min, max, whole = false) => {
    const v = pick(k, def);
    if (!isNum(v) || v < min || v > max || (whole && !Number.isInteger(v))) {
      errs.push(`"${k}" must be a ${whole ? 'whole number' : 'number'} from ${min} to ${max}`);
      return def;
    }
    return v;
  };
  const bool = (k, def) => {
    const v = pick(k, def);
    if (typeof v !== 'boolean') { errs.push(`"${k}" must be true or false`); return def; }
    return v;
  };

  let output = obj.output;
  if (typeof output !== 'string' || !output.toLowerCase().endsWith('.png')) {
    errs.push(obj.output === undefined ? '"output" is required' : '"output" must be a path ending in .png');
    output = '';
  }
  const product = oneOf('product', 'sigwx', ['sigwx', 'sigwx_alt']);
  const level = oneOf('level', 'high', ['high', 'mid']);
  const basemap = oneOf('basemap', 'light', ['light', 'dark', 'satellite']);

  let valid = pick('valid', 'current');
  if (valid !== 'current') {
    let ok = typeof valid === 'string';
    if (ok) { try { toMs(valid); } catch { ok = false; } }
    if (!ok) { errs.push('"valid" must be "current" or an ISO time with a time zone, e.g. 2026-10-21T12:00:00Z'); valid = 'current'; }
  }

  const center = { lat: 5, lon: -80 };
  const c = obj.center;
  if (c !== undefined) {
    if (!isObj(c)) errs.push('"center" must be an object like {"lat": 5, "lon": -80}');
    else {
      for (const k of Object.keys(c)) if (k !== 'lat' && k !== 'lon') errs.push(`unknown key "center.${k}"`);
      if (c.lat !== undefined) center.lat = isNum(c.lat) && Math.abs(c.lat) <= 85 ? c.lat : (errs.push('"center.lat" must be a number from -85 to 85'), 5);
      if (c.lon !== undefined) center.lon = isNum(c.lon) && Math.abs(c.lon) <= 180 ? c.lon : (errs.push('"center.lon" must be a number from -180 to 180'), -80);
    }
  }

  const zoom = num('zoom', 3.75, 0, 14);
  const density = num('density', 1, 0.5, 2);
  const width = num('width', 1280, 200, 4096, true);
  const height = num('height', 800, 200, 4096, true);
  const scale = num('scale', 1, 1, 3);
  // The image's pixel size (map CSS px × scale) is capped. Checked only when the sizes and the
  // scale are valid themselves, so a bad value is reported once.
  if (!errs.some((e) => /^"(width|height|scale)"/.test(e))) {
    for (const [k, v] of [['width', width], ['height', height]]) {
      if (v * scale > MAX_PX) errs.push(`"${k}" × "scale" must be at most ${MAX_PX} px; got ${v} × ${scale} = ${Math.ceil(v * scale)}`);
    }
  }
  const legend = bool('legend', true);
  const key = bool('key', false);

  const layers = Object.fromEntries(Object.values(LAYER_KEYS).map((k) => [k, true]));
  const L = obj.layers;
  if (L !== undefined) {
    if (!isObj(L)) errs.push('"layers" must be an object');
    else {
      const names = ['all', ...Object.keys(LAYER_KEYS)];
      for (const k of Object.keys(L)) {
        if (!names.includes(k)) errs.push(`unknown key "layers.${k}"`);
        else if (typeof L[k] !== 'boolean') errs.push(`"layers.${k}" must be true or false`);
      }
      if (typeof L.all === 'boolean') for (const k of Object.keys(layers)) layers[k] = L.all;
      for (const [name, internal] of Object.entries(LAYER_KEYS)) if (typeof L[name] === 'boolean') layers[internal] = L[name];
    }
  }

  // The style is checked here and again by the page; the job keeps the object as written, so
  // the URL carries only what it sets.
  errs.push(...parseStyle(obj.style).errors);
  const style = obj.style ?? {};

  if (errs.length) throw new JobError(errs.join('\n'));
  return { output, product, level, valid, center, zoom, basemap, density, layers, legend, key, width, height, scale, style };
}

export function readJob(path) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new JobError(`${path}: not found`);
    throw new JobError(`${path}: cannot read: ${err.code ?? 'error'}`);
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new JobError(`${path}: invalid JSON: ${err.message}`);
  }
  return parseJob(obj);
}

// S2. valid is URL-encoded because an offset such as +02:00 would otherwise read back as a space.
// The style, when the job sets one, goes in the query too (the fragment is the camera).
export function staticUrl(job, origin, validIso) {
  const on = Object.values(LAYER_KEYS).filter((k) => job.layers[k]).join(',');
  const style = styleParam(job.style);
  const q = [
    'static=1', `product=${job.product}`, `level=${job.level}`, `valid=${encodeURIComponent(validIso)}`,
    `basemap=${job.basemap}`, `density=${job.density}`, `layers=${on}`,
    `legend=${job.legend ? 1 : 0}`, `key=${job.key ? 1 : 0}`, `w=${job.width}`, `h=${job.height}`,
    ...(style ? [`style=${style}`] : []),
  ].join('&');
  return `${origin}/?${q}#${job.zoom}/${job.center.lat}/${job.center.lon}`;
}

// The CLI's warning when MapLibre drew the map somewhere other than the job asked (view: the
// camera the page reports, {zoom, lat, lon}), or null. It shows no space above or below the
// world: a map taller than the world at the job's zoom is drawn at the zoom that fills it,
// centred on the equator, and a view that would reach past 85° has its centre moved.
// The CLI's warning when the page was readied by the 20 s fallback (st: window.sigwxStatic), or
// null. MapLibre's one worker loads the right-to-left text plugin before any tile, so
// while that is still loading the map is blank, SIGWX geometry included.
export function loadingWarning(st) {
  if (!st.incomplete) return null;
  if (st.rtl === 'loading') return 'warning: the map was still loading after 20 s: the right-to-left text plugin had not loaded, and until it does MapLibre draws neither the basemap nor the SIGWX lines and areas';
  return 'warning: the map was still loading after 20 s; the basemap may be incomplete';
}

// The CLI's warning when the basemap CDN did not serve tiles the view needed, or null.
// tiles: {sourceId: {type: 'vector'|'raster', ok, failed, statuses: {403: n, network: n}}}.
// Map (vector) tiles count one by one; satellite imagery only when none of it came, since the
// satellite style draws one imagery source over another and either may cover the view.
export function basemapWarning(tiles) {
  const all = Object.values(tiles ?? {});
  const sum = (type, k) => all.filter((t) => t.type === type).reduce((a, t) => a + t[k], 0);
  const vf = sum('vector', 'failed'), vn = vf + sum('vector', 'ok');
  const rf = sum('raster', 'failed'), rn = rf + sum('raster', 'ok');
  const noImagery = rf > 0 && rf === rn;
  if (!vf && !noImagery) return null;
  const blank = (vn === 0 || vf === vn) && (rn === 0 || noImagery);
  const keys = [...new Set(all.flatMap((t) => Object.keys(t.statuses ?? {})))];
  const codes = keys.filter((k) => k !== 'network').sort();
  const why = [codes.length && `HTTP ${codes.join(', ')}`, keys.includes('network') && 'network error'].filter(Boolean).join(', ');
  const what = [vf && `${vf} of ${vn} map tiles`, noImagery && `any of ${rf} satellite image tiles`].filter(Boolean).join(' and ');
  return `warning: the basemap is ${blank ? 'blank' : 'partly missing'}: Baron's map CDN did not serve ${what} (${why})`;
}

const deg = (lat, d = 1) => `${Math.abs(lat).toFixed(d)}°${lat < 0 ? 'S' : 'N'}`;
// The fewest decimals, from min up to 6, at which x and y print differently.
const apart = (x, y, min) => { let d = min; while (d < 6 && x.toFixed(d) === y.toFixed(d)) d++; return d; };
export function cameraWarning(job, view) {
  if (!view) return null;
  if (view.zoom - job.zoom > 1e-6) {
    const z = Number(view.zoom.toFixed(apart(view.zoom, job.zoom, 2)));
    return `warning: at zoom ${job.zoom} the whole world is shorter than the ${job.height} px map, so it was drawn at zoom ${z}, centred on ${deg(view.lat)}`;
  }
  if (Math.abs(view.lat - job.center.lat) > 1e-6) {
    const d = apart(view.lat, job.center.lat, 1);
    return `warning: the map was centred on ${deg(view.lat, d)}, not ${deg(job.center.lat, d)}, so that it does not reach past the edge of the world (85°)`;
  }
  return null;
}
