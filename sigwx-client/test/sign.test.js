import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signature, sigwxUrl, signedHeaders, signingTs } from '../server/sign.js';

test('signature matches a known reference value', () => {
  assert.equal(signature('test-key','test-secret',1792497600), 'sig=ld0NVVXQjpWSk0u7Lngo5a5_Elo%3D&ts=1792497600');
});
test('sigwxUrl: key in path, padding kept, never double-encoded', () => {
  const u = sigwxUrl('test-key','test-secret','sigwx','high',1792497600);
  assert.equal(u, 'https://api.velocityweather.com/v1/test-key/reports/sigwx/high.json?sig=ld0NVVXQjpWSk0u7Lngo5a5_Elo%3D&ts=1792497600');
  assert.ok(!u.includes('%25'));
});
test('non-integer ts throws', () => { assert.throws(() => signature('k','s',1792497600.6), TypeError); });
// Baron's map CDN takes the same signature as headers, with the padding as '=' (a header is not a URL).
test('signedHeaders: the key, the same signature unencoded, and ts', () => {
  assert.deepEqual(signedHeaders('test-key','test-secret',1792497600),
    { 'X-VW-key': 'test-key', 'X-VW-sig': 'ld0NVVXQjpWSk0u7Lngo5a5_Elo=', 'X-VW-ts': '1792497600' });
});
// The signature's time is rounded to the nearest 5 minutes, so a signed URL or header set stays
// the same for 5 minutes at a time.
test('signingTs: epoch ms to seconds, rounded to the nearest 300 s', () => {
  const t = 1792497600;   // a multiple of 300
  assert.equal(signingTs(t * 1000), t);
  assert.equal(signingTs((t + 149) * 1000), t);
  assert.equal(signingTs((t + 150) * 1000), t + 300);
  assert.equal(signingTs((t - 150) * 1000), t);
  assert.equal(signingTs((t - 151) * 1000), t - 300);
});
