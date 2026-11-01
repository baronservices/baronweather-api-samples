import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.js';
import { reconstructOpenIcing } from '../public/lib/icing.js';
import { ringArea, pointInRing, isSimpleRing } from '../public/lib/geo.js';

const m = load('icing_mid_t0.json'), a = load('icing_altmid_t0.json');
test('same-CB line closes on the iced side (left)', () => {
  const {ring, side} = reconstructOpenIcing(m.line42.geometry.coordinates, m.cbRings);
  assert.deepEqual(ring[0], ring.at(-1)); assert.equal(side,'left');
  assert.ok(Math.abs(ringArea(ring) - 23.687) < 0.01);
  assert.ok(pointInRing([-80.5,-36.0], ring)); assert.ok(!pointInRing([-80.0,-35.5], ring));
});
test('end jitter is trimmed: line 47 gives a simple ring', () => {
  const {ring} = reconstructOpenIcing(m.line47.geometry.coordinates, m.cbRings);
  assert.ok(ring && isSimpleRing(ring)); assert.ok(Math.abs(ringArea(ring) - 29.98) < 0.05);
});
test('iced side on the right (alt-mid line 49)', () => {
  const {ring, side} = reconstructOpenIcing(a.line49.geometry.coordinates, a.cbRings);
  assert.equal(side,'right'); assert.ok(Math.abs(ringArea(ring) - 2.994) < 0.01);
});
test('ends on two CBs → fallback', () => { assert.equal(reconstructOpenIcing(m.line90.geometry.coordinates, m.cbRings).ring, null); });
