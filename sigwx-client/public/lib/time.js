// Valid-time labels, usable windows and timestep selection.
// Browser-safe ES module. Every time is UTC: only getUTC* getters are used.

const USABLE_HALF_MS = 3 * 3600 * 1000; // the usable window is valid ±3 h (ICAO guide §3.1.6)
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const pad2 = (n) => String(n).padStart(2, '0');

// Epoch ms from epoch ms or an ISO string that carries a zone (Z or ±hh:mm).
// Date.parse reads a zone-less date-time as local time, so it is rejected; so are
// null and undefined, which new Date() would turn into epoch 0.
export function toMs(t) {
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  if (typeof t === 'string' && /(Z|[+-]\d{2}:?\d{2})$/i.test(t)) {
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) return ms;
  }
  throw new Error(`time: expected epoch ms or an ISO time with a time zone, got ${JSON.stringify(t)}`);
}

// 'VALID 18 UTC 20 OCT 2026'
export function validLabel(iso) {
  const d = new Date(toMs(iso));
  return `VALID ${pad2(d.getUTCHours())} UTC ${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// {startMs, endMs, label: '21–03 UTC'}; both ends are inside the window.
export function usableWindow(iso) {
  const t = toMs(iso), startMs = t - USABLE_HALF_MS, endMs = t + USABLE_HALF_MS;
  const label = `${pad2(new Date(startMs).getUTCHours())}–${pad2(new Date(endMs).getUTCHours())} UTC`;
  return { startMs, endMs, label };
}

export function isOutsideUsable(iso, nowMs) {
  const { startMs, endMs } = usableWindow(iso);
  return nowMs < startMs || nowMs > endMs;
}

// Index of the candidate nearest to tMs by absolute difference; ties go to the earlier index. -1 if none.
function nearestOf(isos, indices, tMs) {
  let best = -1, bestD = Infinity;
  for (const i of indices) {
    const d = Math.abs(toMs(isos[i]) - tMs);
    if (d < bestD) { best = i; bestD = d; }
  }
  return best;
}

export function nearestIndex(isos, iso) {
  return nearestOf(isos, isos.keys(), toMs(iso));
}

// The timestep whose usable window contains now (nearest valid time if several);
// otherwise the nearest timestep, flagged outside. Empty list → {index: -1, outside: true}.
export function pickDefault(isos, nowMs) {
  const inside = [...isos.keys()].filter((i) => !isOutsideUsable(isos[i], nowMs));
  if (inside.length) return { index: nearestOf(isos, inside, nowMs), outside: false };
  return { index: nearestOf(isos, isos.keys(), nowMs), outside: true };
}
