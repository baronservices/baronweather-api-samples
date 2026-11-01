import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTimes } from '../cli/times.js';

const HIGH = ['2026-10-21T00:00:00Z', '2026-10-21T06:00:00Z', '2026-10-21T12:00:00Z', '2026-10-21T18:00:00Z'];

test('formatTimes: heading, one line per time, current marker on the default step', () => {
  assert.deepEqual(formatTimes([{ product: 'sigwx', level: 'high', times: HIGH }], Date.parse('2026-10-21T13:10:00Z')), [
    'SIGWX HIGH (sigwx high)',
    '2026-10-21T00:00:00Z  00Z 21 OCT  usable 21–03 UTC',
    '2026-10-21T06:00:00Z  06Z 21 OCT  usable 03–09 UTC',
    '2026-10-21T12:00:00Z  12Z 21 OCT  usable 09–15 UTC  ← current',
    '2026-10-21T18:00:00Z  18Z 21 OCT  usable 15–21 UTC',
  ]);
});

test('formatTimes: several feeds in order; SIGWX ALT heading; month change; ISO printed as given', () => {
  const alt = ['2026-10-31T18:00:00Z', '2026-11-01T00:00:00.000Z'];
  assert.deepEqual(formatTimes([
    { product: 'sigwx', level: 'mid', times: ['2026-10-31T12:00:00Z'] },
    { product: 'sigwx_alt', level: 'mid', times: alt },
  ], Date.parse('2026-10-31T22:00:00Z')), [
    'SIGWX MID (sigwx mid)',
    '2026-10-31T12:00:00Z  12Z 31 OCT  usable 09–15 UTC  ← current',   // now is outside every window: the nearest
    'SIGWX ALT MID (sigwx_alt mid)',
    '2026-10-31T18:00:00Z  18Z 31 OCT  usable 15–21 UTC',
    '2026-11-01T00:00:00.000Z  00Z 01 NOV  usable 21–03 UTC  ← current',
  ]);
});

test('formatTimes: a feed with no times', () => {
  assert.deepEqual(formatTimes([{ product: 'sigwx_alt', level: 'high', times: [] }], 0), [
    'SIGWX ALT HIGH (sigwx_alt high)',
    '(no valid times)',
  ]);
});
