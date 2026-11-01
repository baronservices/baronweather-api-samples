import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearCanvas, inkMargin } from '../public/map/overlay.js';

// nearCanvas: a hazard whose ink reaches the canvas is in view.
test('nearCanvas: a segment that clips the canvas grown by m px counts; 1 px further out does not', () => {
  assert.equal(nearCanvas([[103, -50], [103, 200]], 100, 100, 5), true);    // grown edge x = 105; both ends outside it
  assert.equal(nearCanvas([[106, -50], [106, 200]], 100, 100, 5), false);   // misses the grown edge by 1 px
});
test('inkMargin: the CB scallop bulge is half the 14 px chord plus half the line, 8 px, at any zoom', () => {
  for (const z of [3.75, 12]) assert.equal(inkMargin({ getZoom: () => z }, { kind: 'cb' }), 8);
});
