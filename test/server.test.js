/** How `server.js` binds — the thing that decides whether Stremio and the
 * browser can reach the addon at all.
 *
 * Runs the real entry point as a child process; `CREDENTIALS_JSON={}` leaves
 * every provider unconfigured so the auth warm-up makes no network calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

/** A port nothing is listening on. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Start server.js and resolve once it answers, or reject on timeout. */
async function startServer(env, port, { timeoutMs = 20_000 } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env, PORT: String(port), LOG_LEVEL: 'error', CREDENTIALS_JSON: '{}', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  const deadline = Date.now() + timeoutMs;
  const host = env.HOST || '127.0.0.1';
  const target = host === '0.0.0.0' ? '127.0.0.1' : host;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (${child.exitCode}): ${output}`);
    }
    try {
      const res = await fetch(`http://${target}:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return { child, output: () => output };
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`server never came up: ${output}`);
    }
    await new Promise((r) => { setTimeout(r, 200); });
  }
}

const ok = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.status;
  } catch (e) {
    return `unreachable (${e.cause?.code || e.message})`;
  }
};

test('by default the addon answers on both loopback stacks', async (t) => {
  const port = await freePort();
  const { child } = await startServer({}, port);
  t.after(() => child.kill());

  // `localhost` resolves to ::1 first on Windows. Binding IPv4 only left
  // http://localhost:PORT refused for any client that does not fall back,
  // which looked exactly like "the manifest does not work".
  assert.equal(await ok(`http://127.0.0.1:${port}/manifest.json`), 200, 'IPv4 loopback');
  assert.equal(await ok(`http://[::1]:${port}/manifest.json`), 200, 'IPv6 loopback');

  // The editor homepage has to be reachable — and recognised as local — on both.
  for (const base of [`http://127.0.0.1:${port}`, `http://[::1]:${port}`]) {
    const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(3000) });
    const body = await res.text();
    assert.match(body, /^<!doctype html>/i, `${base}/ serves the editor, not the API greeting`);
  }
});

test('HOST pins the bind address, as the container image needs', async (t) => {
  const port = await freePort();
  const { child } = await startServer({ HOST: '0.0.0.0' }, port);
  t.after(() => child.kill());
  assert.equal(await ok(`http://127.0.0.1:${port}/manifest.json`), 200);
});

test('a port already in use is reported, not thrown as a stack trace', async (t) => {
  const port = await freePort();
  const { child } = await startServer({}, port);
  t.after(() => child.kill());

  const second = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), LOG_LEVEL: 'error', CREDENTIALS_JSON: '{}' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  second.stdout.on('data', (d) => { output += d; });
  second.stderr.on('data', (d) => { output += d; });
  const code = await new Promise((resolve) => second.on('exit', resolve));

  assert.equal(code, 1, 'it exits rather than hanging half-started');
  assert.match(output, /already in use/i);
  assert.doesNotMatch(output, /EADDRINUSE\s*\n\s*at /, 'no raw stack trace');
});
