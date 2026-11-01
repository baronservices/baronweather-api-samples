// Baron basemaps. Browser ES module.
import { STYLE } from '../lib/style.js';

// Every request for a Baron basemap file (style, TileJSON, tiles, glyphs, sprites) goes to the local
// server, which signs it and keeps the key: Baron's map CDN answers an unsigned request it has not
// cached with 403. For MapLibre's transformRequest; undefined leaves a request as it is.
const CDN = 'https://cdnmaps.velocityweather.com/';
export function basemapRequest(url, origin = globalThis.location?.origin) {
  return url.startsWith(CDN) ? { url: `${origin}/api/basemap/${url.slice(CDN.length).split('?')[0]}` } : undefined;
}

export const BASEMAPS = {
  light: 'https://cdnmaps.velocityweather.com/styles/light/style.json',
  dark: 'https://cdnmaps.velocityweather.com/styles/dark/style.json',
  satellite: 'https://cdnmaps.velocityweather.com/styles/satellite/style.json',
};

// Roads, buildings and POIs, hidden unless the style's basemap flag for the group is true
// (house numbers always: no Baron style has a housenumber layer today, so no flag).
// aerodrome_label is kept: the style's airport-label-major (z10+) stays visible, and no
// low-zoom aerodrome layer is added (the tiles have no aerodrome_label data below z10).
const CLUTTER = {
  transportation: 'roads', transportation_name: 'roadLabels', building: 'buildings',
  poi: 'pointsOfInterest', housenumber: null,
};
const isClutter = (layer) => {
  const sl = layer['source-layer'] ?? '';
  return Object.hasOwn(CLUTTER, sl) && !(CLUTTER[sl] && STYLE.basemap[CLUTTER[sl]]);
};

// The styles' ocean outline ("water-ocean border": a line layer on source-layer water,
// class ocean) also strokes the ocean polygons' cut edge at the antimeridian, which shows
// as a solid black line along 180°. It is hidden too; coasts still show as the land/water
// fill edge.
const isOceanOutline = (layer) =>
  layer.type === 'line' && layer['source-layer'] === 'water' && JSON.stringify(layer.filter ?? []).includes('"ocean"');

// State, province and county borders: near-black lines that cross water can
// be taken for SIGWX boundaries. A boundary layer is hidden when its filter admits only
// admin_level >= 3, unless the style's basemap.stateBorders is true; country borders
// (admin_level 2) stay.
const isAdminLevel = (x) => x === 'admin_level' || (Array.isArray(x) && x[0] === 'get' && x[1] === 'admin_level');
function adminFloor(f) {
  if (!Array.isArray(f)) return -Infinity;
  if (f[0] === 'all') return Math.max(-Infinity, ...f.slice(1).map(adminFloor));
  if (isAdminLevel(f[1]) && typeof f[2] === 'number') {
    if (f[0] === '>=' || f[0] === '==') return f[2];
    if (f[0] === '>') return f[2] + 1;
  }
  return -Infinity;
}
const isSubNationalBorder = (layer) => layer['source-layer'] === 'boundary' && adminFloor(layer.filter) >= 3;

export function hideClutter(map) {
  for (const layer of map.getStyle().layers) {
    if (isClutter(layer) || isOceanOutline(layer) || (isSubNationalBorder(layer) && !STYLE.basemap.stateBorders)) {
      map.setLayoutProperty(layer.id, 'visibility', 'none');
    }
    // A translated water fill (Dark's water-offset is [2,0] at z<=6) leaves a gap
    // at the 180° seam between the ocean polygons, which shows as a line along 180°.
    if (layer.type === 'fill' && layer['source-layer'] === 'water') map.setPaintProperty(layer.id, 'fill-translate', [0, 0]);
  }
}

// Switches basemap. Every custom source, layer and image is dropped; the style.load
// handler (layers.js attachSigwx) puts them back.
export function setBasemap(map, name) {
  map.setStyle(BASEMAPS[name], { diff: false });
}
