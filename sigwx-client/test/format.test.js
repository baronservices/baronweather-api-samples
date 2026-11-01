import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mToFL, msToKt, fmtLatLon } from '../public/lib/units.js';
import { OPEN } from '../public/lib/conventions.js';
import { formatBound, depthLabel, distributionLabel } from '../public/lib/format.js';

const H={product:'sigwx',level:'high'}, M={product:'sigwx',level:'mid'}, AH={product:'sigwx_alt',level:'high'}, AM={product:'sigwx_alt',level:'mid'};
test('units', () => {
  assert.equal(mToFL(12190),400); assert.equal(mToFL(7320),240); assert.equal(mToFL(3657),120);
  assert.equal(msToKt(41.2),80); assert.equal(msToKt(46.3),90); assert.equal(msToKt(102.9),200);
  assert.equal(fmtLatLon([-98.6,19.0]),'19.0N 98.6W'); assert.equal(fmtLatLon([-78.3,-2.0]),'2.0S 78.3W'); assert.equal(fmtLatLon([199.8,-54]),'54.0S 160.2W');
});
test('present: clamp by range', () => {
  assert.deepEqual(formatBound(4880,'catBase',AH), {text:'XXX',decode:'below FL250 (chart floor)'});
  assert.deepEqual(formatBound(4880,'catBase',M), {text:'160',decode:'FL160'});
  assert.deepEqual(formatBound(15240,'cbTop',AM), {text:'XXX',decode:'above FL450 (chart ceiling)'});
});
test('missing + proven convention → XXX', () => {
  assert.equal(formatBound(undefined,'catBase',H).text,'XXX');
  assert.equal(formatBound(undefined,'cbTop',M).decode,'above FL450 (chart ceiling)');
  assert.equal(formatBound(undefined,'cbBase',AH).text,'XXX');
});
test('missing, no convention → ?', () => {
  assert.deepEqual(formatBound(undefined,'catBase',M), {text:'?',decode:'not given in data'});
  for (const c of [H, AH, AM]) assert.equal(formatBound(undefined,'depthAbove',c).text,'?');
  assert.equal(formatBound(undefined,'icingBase',M).text,'?');
});
test('depth labels', () => {
  assert.equal(depthLabel({below:6706,above:14326,units:'m'},H),'XXX/470');
  assert.equal(depthLabel({below:7925,above:13716,units:'m'},H),'260/450');
  assert.equal(depthLabel({below:7620,units:'m'},H),'250/?');
  assert.equal(depthLabel(undefined,H),null);
});
test('distribution', () => { assert.equal(distributionLabel('FREQ'),'FRQ'); assert.equal(distributionLabel('OCNL'),'OCNL'); assert.equal(distributionLabel('ISOL'),'ISOL'); });
test('Q1 hook', () => { OPEN.dataFloorFL = 160; try { assert.equal(formatBound(4880,'catBase',M).text,'≤160'); } finally { OPEN.dataFloorFL = null; } });
