import { createHmac } from 'node:crypto';

// Baron request signature: base64(HMAC-SHA1(secret, `${key}:${ts}`)) with
// '+'→'-', '/'→'_', and in a URL '='→'%3D'. Not 'base64url': that drops the padding.
function sigOf(key, secret, ts) {
  if (!Number.isInteger(ts)) throw new TypeError('ts must be an integer number of seconds');
  return createHmac('sha1', secret).update(`${key}:${ts}`).digest('base64').replaceAll('+', '-').replaceAll('/', '_');
}
export function signature(key, secret, ts) {
  return `sig=${sigOf(key, secret, ts).replaceAll('=', '%3D')}&ts=${ts}`;
}

// The signature's time, ts, from epoch ms: seconds rounded to the nearest 5 minutes, so the
// signed URLs and headers stay the same for 5 minutes at a time.
export const signingTs = (ms) => Math.round(ms / 300000) * 300;

// The same signature as request headers, as Baron's map CDN takes it (padding kept as '=').
export function signedHeaders(key, secret, ts) {
  return { 'X-VW-key': key, 'X-VW-sig': sigOf(key, secret, ts), 'X-VW-ts': String(ts) };
}

// Built by hand; never URLSearchParams (it would re-encode %3D as %253D).
export function sigwxUrl(key, secret, product, level, ts) {
  return `https://api.velocityweather.com/v1/${key}/reports/${product}/${level}.json?${signature(key, secret, ts)}`;
}
