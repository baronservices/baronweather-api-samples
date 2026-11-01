// Per-product, per-level data conventions, and the open questions about the data (Q1–Q6 in
// the README). Browser-safe ES module.

// Chart level ranges, in FL.
export const LEVEL_RANGE = {
  high: { floor: 250, ceiling: 600 },
  mid: { floor: 100, ceiling: 450 },
};

// What a missing height means, per product, level and field:
//   'below'   — below the chart floor; print XXX (proven from the feeds)
//   'above'   — above the chart ceiling; print XXX (proven from the feeds)
//   'unknown' — not given in data; print ?
// Every combination is listed on purpose, so this table is the documentation.
// cbBase is never present in any feed (ICAO guide §3.7.3), so it is 'below' everywhere.
// Icing appears only in the mid feeds (captures: 0 icing features in either
// high feed), so the high icing rows exist only to complete the table.
export const MISSING = {
  sigwx: {
    high: {
      catBase: 'below', // proven: all 135 missing bases match a mid base < FL250
      catTop: 'unknown',
      cbBase: 'below',
      cbTop: 'unknown',
      icingBase: 'unknown',
      icingTop: 'unknown',
      depthBelow: 'unknown',
      depthAbove: 'unknown', // Q4 placeholder: XXX (above FL600) or unknown?
    },
    mid: {
      catBase: 'unknown',
      catTop: 'unknown',
      cbBase: 'below',
      cbTop: 'above', // proven: missing on 75/223, all 75 top above FL450
      icingBase: 'unknown', // Q6 placeholder: XXX (below FL100) or ?
      icingTop: 'unknown',
      depthBelow: 'unknown',
      depthAbove: 'unknown', // Q4 placeholder: sigwx mid jets are identical to high
    },
  },
  sigwx_alt: {
    high: {
      catBase: 'unknown',
      catTop: 'unknown',
      cbBase: 'below',
      cbTop: 'unknown',
      icingBase: 'unknown',
      icingTop: 'unknown',
      depthBelow: 'unknown',
      depthAbove: 'unknown', // Q4 placeholder: XXX (above FL600) or unknown?
    },
    mid: {
      catBase: 'unknown',
      catTop: 'unknown',
      cbBase: 'below',
      cbTop: 'unknown',
      icingBase: 'unknown', // Q6 placeholder: XXX (below FL100) or ?
      icingTop: 'unknown',
      depthBelow: 'unknown',
      // Q4 placeholder: of the 47 alt-mid maxima that lack it, only
      // 28 have an above-FL450 value in alt-high; 19 of the 47 omissions are
      // unproven, so XXX is not safe here.
      depthAbove: 'unknown',
    },
  },
};

// Data conventions (Q1–Q6 in the README). Mutable on purpose: answers are set here.
export const OPEN = {
  dataFloorFL: null, // Q1: is FL160 a data floor? If set, a *Base equal to it prints ≤FL.
  // Q2 answered: KKCI (WAFC Washington) -> sigwx, EGRR (WAFC London) -> sigwx_alt.
  issuer: { sigwx: 'WAFC WASHINGTON', sigwx_alt: 'WAFC LONDON' },
};

// Label density: one knob for call-out spacing and MapLibre symbol padding.
// 1.0 is the default; the app clamps any setting (?density=, the slider) to 0.5–2.0.
// It never permits overlap.
export const LABEL_DENSITY_DEFAULT = 1.0;
