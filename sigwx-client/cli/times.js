// CLI output text: the `sigwx times` listing, the feed and time labels the
// render summary shares, and the render log's list of unlabelled hazards. Pure module.
import { pickDefault, usableWindow, toMs } from '../public/lib/time.js';

// An area cut by the map edge may repeat its [id]; each hazard is listed once,
// as its first entry.
export function firstPerId(lines) {
  const seen = new Set();
  return lines.filter((s) => {
    const id = /\[([^\]]*)\]$/.exec(s)?.[1] ?? s;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

const PRODUCTS = { sigwx: 'SIGWX', sigwx_alt: 'SIGWX ALT' };   // as the app names them
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const pad2 = (n) => String(n).padStart(2, '0');

// 'SIGWX ALT MID'
export const feedName = ({ product, level }) => `${PRODUCTS[product] ?? product} ${level.toUpperCase()}`;

// '12Z 21 OCT', as the app's time buttons title it.
export function shortLabel(iso) {
  const d = new Date(toMs(iso));
  return `${pad2(d.getUTCHours())}Z ${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}`;
}

// feeds: [{product, level, times: ISO[]}]. Per feed, a heading line, then one line per time;
// '← current' marks the time the app would pick by default at nowMs.
export function formatTimes(feeds, nowMs) {
  const lines = [];
  for (const { product, level, times } of feeds) {
    lines.push(`${feedName({ product, level })} (${product} ${level})`);
    if (!times.length) { lines.push('(no valid times)'); continue; }
    const current = pickDefault(times, nowMs).index;
    times.forEach((iso, i) => {
      lines.push(`${iso}  ${shortLabel(iso)}  usable ${usableWindow(iso).label}${i === current ? '  ← current' : ''}`);
    });
  }
  return lines;
}
