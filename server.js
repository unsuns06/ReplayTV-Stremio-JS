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

const host = process.env.HOST || '127.0.0.1';
const port = parseInt(process.env.PORT || '7860', 10);

startupDiagnostics();

const app = createApp();
app.listen(port, host, () => {
  logger.info('🚀 Listening on http://%s:%d', host, port);
  logger.info('   Add http://%s:%d/manifest.json as an addon in Stremio', host, port);
  // Log in to every provider now and keep the tokens fresh, so the first
  // viewer to press play does not wait out a login. Detached on purpose:
  // the server is already answering requests.
  startBackgroundAuth();
});
