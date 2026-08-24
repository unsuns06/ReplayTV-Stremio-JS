#!/usr/bin/env node
/** Start the addon.
 *
 * `HOST` / `PORT` pick the bind address (127.0.0.1:7860 by default).
 *
 * ponytail: no reloader here — `npm run dev` is `node --watch server.js`, which
 * restarts on source changes. programs.json edits made through the editor drop
 * their own cache entry, so they show up without a restart.
 */
import fs from 'node:fs';
import path from 'node:path';

import { createApp, startupDiagnostics, startBackgroundAuth } from './src/app.js';
import { getLogger } from './src/utils/logger.js';
import { PACKAGE_ROOT } from './src/utils/paths.js';
import { watchProgramsFile } from './src/utils/programsLoader.js';

const logger = getLogger('server');

/** Load KEY=value pairs from a .env file, without a dotenv dependency. */
function loadDotenv() {
  const envPath = path.join(PACKAGE_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (!match) continue;
    const key = match[1];
    let value = (match[2] || '').trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotenv();

const port = parseInt(process.env.PORT || '7860', 10);

/** Addresses to bind.
 *
 * `localhost` resolves to ::1 before 127.0.0.1 on Windows, so binding IPv4 only
 * leaves http://localhost:7860 refused for anything that does not fall back —
 * which is how both Stremio and the browser end up seeing a dead addon. Bind
 * both loopback addresses unless HOST says otherwise (Docker sets 0.0.0.0).
 */
const hosts = process.env.HOST ? [process.env.HOST] : ['127.0.0.1', '::1'];

startupDiagnostics();

const app = createApp();
let listening = 0;
let started = false;

/** Everything that should happen once, after the first successful bind. */
function onFirstListen() {
  if (started) return;
  started = true;
  // Behind a pinned HOST (a container) "localhost" would be the wrong advice:
  // the useful URL there is whatever the host maps in front of this port.
  if (process.env.HOST) {
    logger.info('   Serving /manifest.json on port %d', port);
  } else {
    logger.info('   Add http://localhost:%d/manifest.json as an addon in Stremio', port);
  }
  // Log in to every provider now and keep the tokens fresh, so the first
  // viewer to press play does not wait out a login. Detached on purpose:
  // the server is already answering requests.
  startBackgroundAuth();
  // The Python addon restarted itself when programs.json changed; re-reading
  // the file is enough, and keeps the server up.
  watchProgramsFile();
}

for (const host of hosts) {
  const server = app.listen(port, host);
  server.on('listening', () => {
    listening += 1;
    logger.info('🚀 Listening on http://%s:%d', host.includes(':') ? `[${host}]` : host, port);
    onFirstListen();
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error('❌ Port %d is already in use — is another copy of the addon (or the Python one) running?', port);
      process.exit(1);
    }
    // A machine with no IPv6 stack simply cannot offer ::1; that is not fatal
    // as long as the IPv4 bind worked.
    if (['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EINVAL'].includes(err.code)) {
      logger.debug('Skipping %s: %s', host, err.code);
      return;
    }
    logger.error('❌ Could not listen on %s:%d — %s', host, port, err.message);
    if (!listening) process.exit(1);
  });
}
