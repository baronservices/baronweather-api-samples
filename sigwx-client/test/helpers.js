import { readFileSync } from 'node:fs';

// Reads and parses test/fixtures/<name>, resolved from this file so any cwd works.
export function load(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}
