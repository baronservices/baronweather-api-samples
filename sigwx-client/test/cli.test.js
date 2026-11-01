import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { firstPerId } from '../cli/times.js';
import { findChrome } from '../cli/chrome.js';
import { parseJob, staticUrl } from '../cli/job.js';

const NOT_FOUND = { message: 'Chrome not found; set CHROME_PATH to the Chrome executable' };
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
// A temp folder holding empty files with these names, executable unless mode says otherwise.
const fakeBin = (names, mode = 0o755) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigwx-path-'));
  dirs.push(dir);
  for (const n of names) { fs.writeFileSync(path.join(dir, n), '#!/bin/sh\n'); fs.chmodSync(path.join(dir, n), mode); }
  return dir;
};

test('firstPerId: a repeated [id] is listed once, as its first entry, in order', () => {
  assert.deepEqual(firstPerId([
    'SEV TURB top 360 base 220 near 36.8N 120.9W [cat-3]',
    'OCNL CB 470 XXX near 1.0N 2.0W [cb-1]',
    'SEV TURB top 360 base 220 near 30.1N 110.0W [cat-3]',
    'MOD ICE top 240 base ? near 39.4N 46.4E [ice-153]',
    'OCNL CB 470 XXX near 3.0N 4.0W [cb-1]',
  ]), [
    'SEV TURB top 360 base 220 near 36.8N 120.9W [cat-3]',
    'OCNL CB 470 XXX near 1.0N 2.0W [cb-1]',
    'MOD ICE top 240 base ? near 39.4N 46.4E [ice-153]',
  ]);
  assert.deepEqual(firstPerId([]), []);
});

test('findChrome: CHROME_PATH unset, a candidate on PATH is found, in the brief order', () => {
  const empty = fakeBin([]), one = fakeBin(['chromium-browser']), all = fakeBin(['chromium-browser', 'chromium', 'google-chrome']);
  // No app bundle: PATH is searched, folder by folder for each name.
  assert.equal(findChrome({ PATH: [empty, one].join(path.delimiter) }, []), path.join(one, 'chromium-browser'));
  assert.equal(findChrome({ PATH: [one, all].join(path.delimiter) }, []), path.join(all, 'google-chrome'));
  // An app bundle comes before PATH.
  const app = path.join(fakeBin(['Chrome']), 'Chrome');
  assert.equal(findChrome({ PATH: all }, ['/nonexistent/Chrome', app]), app);
  // A valid CHROME_PATH wins over both.
  assert.equal(findChrome({ CHROME_PATH: path.join(one, 'chromium-browser'), PATH: all }, [app]), path.join(one, 'chromium-browser'));
});

test('findChrome: not executable, nothing found, or a wrong CHROME_PATH is "not found"', () => {
  assert.throws(() => findChrome({ PATH: fakeBin(['google-chrome'], 0o644) }, []), NOT_FOUND);
  assert.throws(() => findChrome({ PATH: fakeBin(['chrome']) }, []), NOT_FOUND);   // not one of the three names
  assert.throws(() => findChrome({}, []), NOT_FOUND);
  // A wrong CHROME_PATH is reported, not bypassed, even with Chrome on PATH.
  assert.throws(() => findChrome({ CHROME_PATH: '/nonexistent', PATH: fakeBin(['google-chrome']) }, []), NOT_FOUND);
});

test('staticUrl: every layer off gives an empty layers=', () => {
  const job = parseJob({ output: 'a.png', layers: { all: false } });
  assert.equal(
    staticUrl(job, 'http://127.0.0.1:5000', '2026-10-21T12:00:00Z'),
    'http://127.0.0.1:5000/?static=1&product=sigwx&level=high&valid=2026-10-21T12%3A00%3A00Z&basemap=light&density=1&layers=&legend=1&key=0&w=1280&h=800#3.75/5/-80',
  );
  assert.equal(new URL(staticUrl(job, 'http://127.0.0.1:5000', '2026-10-21T12:00:00Z')).searchParams.get('layers'), '');
});

test('staticUrl: a +02:00 valid is encoded, so the page reads it back unchanged', () => {
  const url = staticUrl(parseJob({ output: 'a.png' }), 'http://127.0.0.1:5000', '2026-10-21T14:00:00+02:00');
  assert.ok(url.includes('&valid=2026-10-21T14%3A00%3A00%2B02%3A00&'), url);
  assert.equal(new URL(url).searchParams.get('valid'), '2026-10-21T14:00:00+02:00');   // as the page parses it
  assert.equal(new URL(url).searchParams.get('layers'), 'jet,cb,cat,icing,tropo,volcano,tc,graticule');
});
