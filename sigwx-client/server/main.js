import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './app.js';
import { loadConfig } from './config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// exitCode, not process.exit(): stderr to a pipe is async on macOS and exit() could drop the message.
let config = null;
try {
  config = loadConfig({ root: ROOT });
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}

if (config) {
  const { key, secret, port } = config;
  const server = createServer({ key, secret, publicRoot: path.join(ROOT, 'public') });
  server.listen(port, '127.0.0.1', () => console.log(`SIGWX on http://127.0.0.1:${server.address().port}/`));
}
