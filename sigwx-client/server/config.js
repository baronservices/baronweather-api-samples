import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

// Reads the env file into `env` (existing variables win, as with process.loadEnvFile),
// then returns { key, secret, port }. Throws Error with a one-line message.
export function loadConfig({ env = process.env, root }) {
  const envFile = env.SIGWX_ENV_FILE ?? path.join(root, '.env');
  try {
    const parsed = parseEnv(fs.readFileSync(envFile, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) if (!(k in env)) env[k] = v;
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`cannot read env file ${envFile}: ${err.code ?? 'error'}`);
  }

  const key = env.BARON_ACCESS_KEY;
  const secret = env.BARON_ACCESS_KEY_SECRET;
  if (!key || !secret) throw new Error('missing BARON_ACCESS_KEY or BARON_ACCESS_KEY_SECRET');
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a whole number from 0 to 65535, got ${JSON.stringify(env.PORT)}`);
  }
  return { key, secret, port };
}
