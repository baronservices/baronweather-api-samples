import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';

const before = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
  Object.assign(process.env, before);
});

function envFile(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigwx-config-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, text);
  return file;
}
const KEYS = 'BARON_ACCESS_KEY=k1\nBARON_ACCESS_KEY_SECRET=s1\n';

test('both keys in the file give key, secret and the default port', () => {
  const env = { SIGWX_ENV_FILE: envFile(KEYS) };
  assert.deepEqual(loadConfig({ env, root: '/x' }), { key: 'k1', secret: 's1', port: 8787 });
});

test('PORT=0 is allowed', () => {
  const env = { SIGWX_ENV_FILE: envFile(KEYS + 'PORT=0\n') };
  assert.equal(loadConfig({ env, root: '/x' }).port, 0);
});

test('missing keys throw', () => {
  const env = { SIGWX_ENV_FILE: envFile('FOO=1\n') };
  assert.throws(() => loadConfig({ env, root: '/x' }), { message: 'missing BARON_ACCESS_KEY or BARON_ACCESS_KEY_SECRET' });
});

test('a bad PORT throws', () => {
  const env = { SIGWX_ENV_FILE: envFile(KEYS + 'PORT=abc\n') };
  assert.throws(() => loadConfig({ env, root: '/x' }), { message: 'PORT must be a whole number from 0 to 65535, got "abc"' });
});

test('a nonexistent env file is fine when env has the keys', () => {
  const env = { SIGWX_ENV_FILE: '/nonexistent/.env', BARON_ACCESS_KEY: 'a', BARON_ACCESS_KEY_SECRET: 'b' };
  assert.deepEqual(loadConfig({ env, root: '/x' }), { key: 'a', secret: 'b', port: 8787 });
});

test('an unreadable env file throws with the code', () => {
  const env = { SIGWX_ENV_FILE: os.tmpdir() };
  assert.throws(() => loadConfig({ env, root: '/x' }), /^Error: cannot read env file .*: \w+$/);
});

test('an existing env variable beats the file', () => {
  const env = { SIGWX_ENV_FILE: envFile(KEYS), BARON_ACCESS_KEY: 'mine' };
  assert.equal(loadConfig({ env, root: '/x' }).key, 'mine');
});

test('process.env is not polluted when env is passed', () => {
  const env = { SIGWX_ENV_FILE: envFile(KEYS + 'SIGWX_TEST_LEAK=1\n') };
  loadConfig({ env, root: '/x' });
  assert.equal(process.env.SIGWX_TEST_LEAK, undefined);
});
