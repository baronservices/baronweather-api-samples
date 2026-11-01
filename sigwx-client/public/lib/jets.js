// Jet-stream symbology (ICAO guide §3.5). Browser-safe ES module.
import { mToFL, msToKt } from './units.js';
import { LEVEL_RANGE } from './conventions.js';
import { formatBound, depthLabel } from './format.js';
import { unwrapLine, dedupe, alignToLine, nearestOnPolyline, segmentAngleDeg } from './geo.js';

// Pennant 50, feather 10, half-feather 5. kt is already a multiple of 5.
export function composeFleche(kt) {
  const pennants = Math.floor(kt / 50);
  const rem = kt - 50 * pennants;
  return { pennants, feathers: Math.floor(rem / 10), halves: (rem % 10) / 5 };
}

// Fleche at the first and last symbol, at each local maximum, and wherever the
// step from the previous symbol is not exactly ±20 kt; change bar elsewhere.
// A fleche always carries its FL label; a bar does when its FL differs by ≥30
// from the last label printed. fl and label are numbers (FL).
export function classifyJetSymbols(symbols) {
  const v = symbols.map((s) => ({ kt: msToKt(s.wind.speed), fl: mToFL(s.height.value) }));
  let last = null;
  return v.map(({ kt, fl }, i) => {
    const n = v.length;
    const fleche = i === 0 || i === n - 1
      || (kt > v[i - 1].kt && kt >= v[i + 1].kt)
      || Math.abs(kt - v[i - 1].kt) !== 20;
    const label = fleche || Math.abs(fl - last) >= 30 ? fl : null;
    if (label != null) last = label;
    return { kind: fleche ? 'fleche' : 'bar', kt, fl, label };
  });
}

// True when any symbol's FL lies within the level's range, ends included.
export function jetInRange(rawJet, level) {
  const { floor, ceiling } = LEVEL_RANGE[level];
  return (rawJet.symbols ?? []).some((s) => {
    const fl = mToFL(s.height.value);
    return fl >= floor && fl <= ceiling;
  });
}

const point = (coordinates, properties) => ({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties });

// One raw jet to {line, points}: the line Feature, then one jetPoint per
// symbol (in symbol order) and the end arrow last. ctx = {product, level, id}.
export function buildJet(rawJet, ctx) {
  const coords = dedupe(unwrapLine(rawJet.geometry.coordinates));
  const symbols = rawJet.symbols ?? [];
  const classes = classifyJetSymbols(symbols);

  const points = symbols.map((s, i) => {
    const c = classes[i];
    const snap = nearestOnPolyline(alignToLine(s.coordinates, coords), coords);
    const fleche = c.kind === 'fleche';
    const depth = fleche ? depthLabel(s.depth, ctx) : null;
    let popup = `Jet ${c.kt} KT at FL${c.fl}`;
    if (depth != null) {
      // A '?' bound reads as an unknown base or top; XXX and FL bounds keep their decode.
      const bound = (v, field, end) => {
        const f = formatBound(v, field, ctx);
        return f.text === '?' ? `an unknown ${end} (${f.decode})` : f.decode;
      };
      popup += `. 80 KT or more from ${bound(s.depth.below, 'depthBelow', 'base')} to ${bound(s.depth.above, 'depthAbove', 'top')}`;
    }
    return point(snap.point, {
      id: `${ctx.id}-s${i}`,
      kind: c.kind,
      kt: c.kt,
      icon: fleche ? `fleche-${c.kt}-${snap.point[1] >= 0 ? 'nh' : 'sh'}` : 'change-bar',
      rotate: segmentAngleDeg(coords[snap.segIndex], coords[snap.segIndex + 1]),
      fl: c.label != null ? `FL${c.label}` : null,
      depth,
      popup,
    });
  });

  const max = classes.reduce((m, c) => (!m || c.kt > m.kt ? c : m), null);
  const linePopup = max ? `Jet stream, max ${max.kt} KT at FL${max.fl}` : 'Jet stream';

  points.push(point(coords.at(-1), {
    id: `${ctx.id}-arrow`,
    kind: 'arrow',
    icon: 'jet-arrow',
    rotate: segmentAngleDeg(coords.at(-2), coords.at(-1)),
    fl: null,
    depth: null,
    popup: linePopup,
  }));

  const line = { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { id: ctx.id, popup: linePopup } };
  return { line, points };
}
