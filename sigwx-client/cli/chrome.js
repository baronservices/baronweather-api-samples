// Drives the installed Chrome headless over the DevTools protocol with Node's global
// WebSocket (Node 22.4+). No dependencies.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const NOT_FOUND = 'Chrome not found; set CHROME_PATH to the Chrome executable';
const START_MS = 20000;

const isExecutable = (p) => {
  try { return fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true); } catch { return false; }
};

const APPS = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];

// CHROME_PATH, when set, is the only candidate, so a wrong value is reported, not bypassed.
// Then the app bundles (apps is a parameter only so tests can leave them out), then PATH.
export function findChrome(env = process.env, apps = APPS) {
  if (env.CHROME_PATH) {
    if (isExecutable(env.CHROME_PATH)) return env.CHROME_PATH;
    throw new Error(NOT_FOUND);
  }
  const onPath = ['google-chrome', 'chromium', 'chromium-browser']
    .flatMap((name) => (env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name)));
  const found = [...apps, ...onPath].find(isExecutable);
  if (!found) throw new Error(NOT_FOUND);
  return found;
}

// Every Chrome launched and not yet closed, from the moment it is spawned, so a SIGINT
// during start-up can still kill it.
const live = new Set();
export const closeAll = () => Promise.all([...live].map((close) => close()));

// Starts Chrome headless with a fresh profile and connects to its page target.
// send(method, params, timeoutMs) resolves with the result or rejects with a one-line Error;
// close() (idempotent) kills Chrome, waits for it to exit and removes the profile.
export async function launchChrome(chromePath) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sigwx-chrome-'));
  // Detached, Chrome leads its own process group, which its helper processes
  // inherit. Killing the group also kills a helper too starved of CPU to notice that the
  // browser has gone, which would otherwise outlive the CLI.
  // Chrome gets the environment without the Baron key and secret, which loadConfig put in
  // process.env and which Chrome has no use for.
  const env = { ...process.env };
  delete env.BARON_ACCESS_KEY;
  delete env.BARON_ACCESS_KEY_SECRET;
  const child = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore', detached: true, env });
  const killGroup = (signal) => {
    if (child.pid === undefined) return;   // never started
    try { process.kill(-child.pid, signal); } catch { /* ESRCH: the group is already empty */ }
  };

  let dead = null;   // set once Chrome or the page is gone: every send then rejects with it
  let ws = null, seq = 0, closing = null;
  const pending = new Map();
  const fail = (err) => {
    dead ??= err;
    for (const p of pending.values()) p.reject(dead);
    pending.clear();
  };
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => { fail(new Error(`Chrome exited unexpectedly (${signal ?? `code ${code}`})`)); resolve(); });
    child.once('error', (err) => { fail(new Error(`cannot start Chrome at ${chromePath}: ${err.code ?? err.message}`)); resolve(); });
  });
  // Last resort if Node dies without running close() (an uncaught error): a detached Chrome
  // would otherwise keep running.
  const killOnExit = () => killGroup('SIGKILL');
  process.once('exit', killOnExit);

  function close() {
    closing ??= (async () => {
      fail(new Error('Chrome was closed'));
      try { ws?.close(); } catch { /* not open */ }
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        // Unref'd, so the losing timer of a race does not keep Node running after Chrome exits.
        killGroup('SIGTERM');
        const gone = await Promise.race([exited.then(() => true), sleep(5000, false, { ref: false })]);
        if (!gone) { killGroup('SIGKILL'); await Promise.race([exited, sleep(5000, undefined, { ref: false })]); }
      }
      killGroup('SIGKILL');   // any helper still left once the browser has gone (or crashed)
      // A profile that cannot be removed is reported, not thrown: it must not turn a
      // finished render into a failure.
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (err) {
        console.error(`warning: could not remove Chrome's temporary profile ${profile}: ${err.code ?? err.message}`);
      }
      process.removeListener('exit', killOnExit);
      live.delete(close);
    })();
    return closing;
  }
  live.add(close);

  function send(method, params = {}, timeoutMs = 30000) {
    if (dead) return Promise.reject(dead);
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Chrome did not answer ${method} within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          if (msg.error) reject(new Error(`Chrome ${method} failed: ${msg.error.message}`));
          else resolve(msg.result);
        },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  try {
    const deadline = Date.now() + START_MS;
    const waitStep = async () => {
      if (dead) throw dead;
      if (Date.now() > deadline) throw new Error(`Chrome did not start within ${START_MS / 1000} s`);
      await sleep(100);
    };

    // DevToolsActivePort: the port on line 1, written once Chrome listens.
    let port = null;
    while (!port) {
      try { port = /^\d+$/.exec(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0])?.[0]; } catch { /* not yet */ }
      if (!port) await waitStep();
    }
    let page = null;
    while (!page) {
      try {
        // Bounded, so a hung request cannot outlast the start deadline.
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
        page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch { /* not yet */ }
      if (!page) await waitStep();
    }

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('cannot connect to Chrome')), { once: true });
      exited.then(() => reject(dead));
    });
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); }
      else if (msg.method === 'Inspector.targetCrashed') fail(new Error('the page crashed in Chrome'));
    });
    ws.addEventListener('close', () => fail(new Error('Chrome closed the connection unexpectedly (did it crash?)')));
    await send('Inspector.enable');
  } catch (err) {
    await close();
    throw err;
  }
  return { send, close };
}
