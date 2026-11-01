// Usage: node scripts/extract-fixtures.mjs <capturesDir> <outDir>
// Writes the compact test fixtures from the four full SIGWX captures.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const [capturesDir, outDir] = process.argv.slice(2);
if (!capturesDir || !outDir) {
  console.error('usage: node scripts/extract-fixtures.mjs <capturesDir> <outDir>');
  process.exit(1);
}

// Each capture is {"<name>": {"data": [...]}}; keep the data[] array.
const cap = {};
for (const name of ['sigwx_high', 'sigwx_mid', 'sigwx_alt_high', 'sigwx_alt_mid']) {
  cap[name] = JSON.parse(readFileSync(path.join(capturesDir, `${name}.json`), 'utf8'))[name].data;
}

// cap[name].data[t][kind][i]; throws instead of letting a key drop silently.
const pick = (name, t, kind, i) => {
  const v = cap[name][t]?.[kind]?.[i];
  if (v === undefined) throw new Error(`missing ${name}.data[${t}].${kind}[${i}]`);
  return v;
};
// Bare rings of every CB cloud entry (the entries that carry a `type`).
const cbRings = (name, t) => cap[name][t].cloud.filter(e => 'type' in e).map(e => e.geometry.coordinates);

const fixtures = {
  'jet_high_t0_j0.json': pick('sigwx_high', 0, 'jet', 0),
  'jet_high_t0_j1.json': pick('sigwx_high', 0, 'jet', 1),
  'jet_high_t0_j7.json': pick('sigwx_high', 0, 'jet', 7),
  'jet_high_t4_j2.json': pick('sigwx_high', 4, 'jet', 2),
  'jet_high_t4_j11.json': pick('sigwx_high', 4, 'jet', 11),
  'jet_altmid_t2_j33.json': pick('sigwx_alt_mid', 2, 'jet', 33),
  'icing_mid_t0.json': {
    line42: pick('sigwx_mid', 0, 'cloud', 42),
    line47: pick('sigwx_mid', 0, 'cloud', 47),
    line90: pick('sigwx_mid', 0, 'cloud', 90),
    cbRings: cbRings('sigwx_mid', 0),
  },
  'icing_altmid_t0.json': { line49: pick('sigwx_alt_mid', 0, 'cloud', 49), cbRings: cbRings('sigwx_alt_mid', 0) },
  'cat_high_t0.json': {
    mod23: pick('sigwx_high', 0, 'cat', 23),
    sev6: pick('sigwx_high', 0, 'cat', 6),
    mod20am: pick('sigwx_high', 0, 'cat', 20),
  },
  'cat_althigh_t0_c0.json': pick('sigwx_alt_high', 0, 'cat', 0),
};

mkdirSync(outDir, { recursive: true });
for (const [file, value] of Object.entries(fixtures)) {
  writeFileSync(path.join(outDir, file), JSON.stringify(value));
  console.log(file);
}
