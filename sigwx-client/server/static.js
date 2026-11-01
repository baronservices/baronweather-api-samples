import { statSync } from 'node:fs';
import path from 'node:path';

export const STATIC_EXTS = new Set(['.html', '.js', '.css', '.json', '.svg', '.png', '.woff2']);

// Maps a request path to a file under publicRoot, or null. Null for a malformed
// escape, a path outside publicRoot, a disallowed extension or a missing file.
export function resolveStatic(publicRoot, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (decoded === '/') decoded = '/index.html';
  const root = path.resolve(publicRoot);
  const file = path.resolve(root, '.' + decoded);
  if (!file.startsWith(root + path.sep) || !STATIC_EXTS.has(path.extname(file))) return null;
  try { return statSync(file).isFile() ? file : null; } catch { return null; }
}
