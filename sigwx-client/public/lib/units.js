// Unit conversions and coordinate text. Browser-safe ES module.

// Metres to flight level (hundreds of feet).
export function mToFL(m) {
  return Math.round(m / 30.48);
}

// Metres per second to knots, rounded to the nearest 5 kt.
export function msToKt(ms) {
  return 5 * Math.round(ms * 1.943844 / 5);
}

// One axis to text with one decimal. The hemisphere follows the sign of the
// rounded value, so -0.04 prints '0.0' with the positive letter.
function axis(v, pos, neg) {
  const s = Math.abs(v).toFixed(1);
  return s + (v < 0 && s !== '0.0' ? neg : pos);
}

// [lon, lat] to '19.0N 98.6W'. Lon outside [-180, 180] is wrapped into it;
// lon already in range (including exactly 180) is left as is.
export function fmtLatLon([lon, lat]) {
  const w = lon > 180 || lon < -180 ? ((lon + 180) % 360 + 360) % 360 - 180 : lon;
  return `${axis(lat, 'N', 'S')} ${axis(w, 'E', 'W')}`;
}
