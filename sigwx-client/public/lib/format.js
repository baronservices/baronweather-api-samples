// Height labels and XXX rules. Browser-safe ES module.
import { mToFL } from './units.js';
import { LEVEL_RANGE, MISSING, OPEN } from './conventions.js';

const below = (range) => ({ text: 'XXX', decode: `below FL${range.floor} (chart floor)` });
const above = (range) => ({ text: 'XXX', decode: `above FL${range.ceiling} (chart ceiling)` });

// One height bound (metres, or undefined/null when missing) to {text, decode}.
// Throws on an unknown product, level or field, so a typo never prints a
// plausible-looking '?'.
export function formatBound(valueM, field, { product, level }) {
  const range = LEVEL_RANGE[level];
  const conv = MISSING[product]?.[level]?.[field];
  if (!range || !conv) throw new Error(`formatBound: unknown ${product}/${level}/${field}`);

  if (valueM == null) {
    if (conv === 'below') return below(range);
    if (conv === 'above') return above(range);
    return { text: '?', decode: 'not given in data' };
  }

  const fl = mToFL(valueM);
  if (fl < range.floor) return below(range);
  if (fl > range.ceiling) return above(range);
  if (OPEN.dataFloorFL != null && fl === OPEN.dataFloorFL && field.endsWith('Base')) {
    return { text: `≤${fl}`, decode: `at or below FL${fl} (data floor)` };
  }
  return { text: String(fl), decode: `FL${fl}` };
}

// Jet depth to 'bbb/aaa', or null when the symbol has no depth.
export function depthLabel(depth, ctx) {
  if (depth == null) return null;
  return `${formatBound(depth.below, 'depthBelow', ctx).text}/${formatBound(depth.above, 'depthAbove', ctx).text}`;
}

// Data 'FREQ' prints as the chart's 'FRQ'; anything else verbatim.
export function distributionLabel(d) {
  return d === 'FREQ' ? 'FRQ' : d;
}
