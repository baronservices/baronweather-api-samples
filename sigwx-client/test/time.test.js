import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validLabel, usableWindow, isOutsideUsable, pickDefault, nearestIndex } from '../public/lib/time.js';
import { legendLines } from '../public/lib/legend.js';
import { createRequestGate } from '../public/lib/state.js';
import { OPEN } from '../public/lib/conventions.js';

const T=['2026-10-20T12:00:00Z','2026-10-20T18:00:00Z','2026-10-21T00:00:00Z','2026-10-21T06:00:00Z','2026-10-21T12:00:00Z'];
test('labels and windows', () => {
  assert.equal(validLabel('2026-10-20T18:00:00Z'),'VALID 18 UTC 20 OCT 2026');
  assert.equal(usableWindow('2026-10-21T00:00:00Z').label,'21–03 UTC');
  assert.equal(isOutsideUsable('2026-10-20T18:00:00Z', Date.parse('2026-10-20T21:00:01Z')), true);
  assert.equal(isOutsideUsable('2026-10-20T18:00:00Z', Date.parse('2026-10-20T21:00:00Z')), false);
});
test('default and nearest', () => {
  assert.deepEqual(pickDefault(T,Date.parse('2026-10-20T21:30:00Z')),{index:2,outside:false});
  assert.deepEqual(pickDefault(T,Date.parse('2026-10-22T06:00:00Z')),{index:4,outside:true});
  assert.equal(nearestIndex(T.slice(1),'2026-10-20T12:00:00Z'),0);
});
test('legend', () => {
  assert.deepEqual(legendLines({product:'sigwx',level:'high',valid:'2026-10-21T12:00:00Z',fetchedAt:'2026-10-20T21:05:00Z'}),[
    'ISSUED BY WAFC WASHINGTON','PROVIDED BY BARON','SIGWX HIGH LEVEL FL250–FL600','VALID 12 UTC 21 OCT 2026 (USABLE 09–15 UTC)',
    'CB IMPLIES TS, GR, MOD OR SEV TURB AND ICE','UNITS USED: HEIGHTS IN FLIGHT LEVELS',
    'CHECK SIGMET, ADVISORIES FOR TC AND VA, AND ASHTAM AND NOTAM FOR VA','DATA FETCHED 21:05Z']);
  assert.equal(legendLines({product:'sigwx_alt',level:'high',valid:'2026-10-21T12:00:00Z',fetchedAt:'2026-10-20T21:05:00Z'})[0],'ISSUED BY WAFC LONDON');
});
test('gate', () => { const g=createRequestGate(), a=g.next(), b=g.next(); assert.equal(g.isLatest(a),false); assert.equal(g.isLatest(b),true); });

// Edge cases the four tests above leave unpinned.
test('edges', () => {
  // Window start is inclusive too; the window is exactly ±3 h.
  const w=usableWindow('2026-10-20T18:00:00Z');
  assert.equal(w.startMs,Date.parse('2026-10-20T15:00:00Z')); assert.equal(w.endMs,Date.parse('2026-10-20T21:00:00Z'));
  assert.equal(isOutsideUsable('2026-10-20T18:00:00Z', Date.parse('2026-10-20T15:00:00Z')), false);
  assert.equal(isOutsideUsable('2026-10-20T18:00:00Z', Date.parse('2026-10-20T14:59:59Z')), true);
  // Day and hour are zero-padded; a zone-less ISO string (parsed as local time by Date.parse) is rejected.
  assert.equal(validLabel('2026-01-05T06:00:00Z'),'VALID 06 UTC 05 JAN 2026');
  assert.throws(() => validLabel('2026-10-20T18:00:00'), /time zone/);
  // 21:00 sits in both the 18Z and 00Z windows: a tie goes to the earlier index.
  assert.deepEqual(pickDefault(T,Date.parse('2026-10-20T21:00:00Z')),{index:1,outside:false});
  assert.equal(nearestIndex(T,'2026-10-20T15:00:00Z'),0);
  assert.deepEqual(pickDefault([],0),{index:-1,outside:true}); assert.equal(nearestIndex([],T[0]),-1);
  // The legend reads the issuer at call time; mid range; fetchedAt may be epoch ms.
  const before=OPEN.issuer.sigwx_alt;
  try {
    OPEN.issuer.sigwx_alt='TEST ISSUER';
    const L=legendLines({product:'sigwx_alt',level:'mid',valid:'2026-10-21T00:00:00Z',fetchedAt:Date.parse('2026-10-21T00:09:00Z')});
    assert.equal(L[0],'ISSUED BY TEST ISSUER'); assert.equal(L[2],'SIGWX MID LEVEL FL100–FL450');
    assert.equal(L[3],'VALID 00 UTC 21 OCT 2026 (USABLE 21–03 UTC)'); assert.equal(L[7],'DATA FETCHED 00:09Z');
  } finally { OPEN.issuer.sigwx_alt=before; }
  // A missing fetch time throws rather than printing epoch 00:00Z.
  assert.throws(() => legendLines({product:'sigwx',level:'high',valid:T[0],fetchedAt:null}));
});
