// The chart legend block (ICAO guide §3.1–3.2). Browser-safe ES module.
// Never a WMO header, an issue time, or "PROVIDED BY" a WAFC.

import { LEVEL_RANGE, OPEN } from './conventions.js';
import { toMs, validLabel, usableWindow } from './time.js';

// Verbatim advisory text.
export const ADVISORY = [
  'CB IMPLIES TS, GR, MOD OR SEV TURB AND ICE',
  'UNITS USED: HEIGHTS IN FLIGHT LEVELS',
  'CHECK SIGMET, ADVISORIES FOR TC AND VA, AND ASHTAM AND NOTAM FOR VA',
];

const pad2 = (n) => String(n).padStart(2, '0');

// fetchedAt: epoch ms or an ISO time with a zone. The issuer is read at call time,
// so answering Q2 in conventions.js changes the legend.
export function legendLines({ product, level, valid, fetchedAt }) {
  const range = LEVEL_RANGE[level];
  if (!range) throw new Error(`legendLines: unknown level ${JSON.stringify(level)}`);
  if (!Object.hasOwn(OPEN.issuer, product)) throw new Error(`legendLines: unknown product ${JSON.stringify(product)}`);
  const f = new Date(toMs(fetchedAt));
  return [
    `ISSUED BY ${OPEN.issuer[product]}`,
    'PROVIDED BY BARON',
    `SIGWX ${level.toUpperCase()} LEVEL FL${range.floor}–FL${range.ceiling}`,
    `${validLabel(valid)} (USABLE ${usableWindow(valid).label})`,
    ...ADVISORY,
    `DATA FETCHED ${pad2(f.getUTCHours())}:${pad2(f.getUTCMinutes())}Z`,
  ];
}
