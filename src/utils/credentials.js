import fs from 'node:fs';

import { getLogger } from './logger.js';
import { parseJsonText } from './jsonParser.js';
import { dataFile } from './paths.js';

const logger = getLogger('utils.credentials');

/** Parse JSON with diagnostic logging on failure. */
function lenientParse(text, context) {
  try {
    return JSON.parse(text);
  } catch (e) {
    logger.error('%s - JSON parse error: %s', context, e.message);
  }

  const result = parseJsonText(text, context);
  if (result !== null) return result;

  logger.error('%s - Lenient parsing attempts failed', context);
  return null;
}

/** Load credentials from the CREDENTIALS_JSON environment variable if set. */
function loadFromEnv() {
  const raw = process.env.CREDENTIALS_JSON;
  if (!raw) return null;
  logger.info('credentials: Using CREDENTIALS_JSON environment variable');
  const parsed = lenientParse(raw, 'credentials.env:CREDENTIALS_JSON');
  if (parsed === null) logger.error('credentials: Failed to parse CREDENTIALS_JSON');
  return parsed;
}

/** Load credentials from a specific file path with diagnostics. */
function loadFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    logger.info('credentials: File not found: %s', filePath);
    return null;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    logger.info('credentials: Loading credentials from %s (%d bytes)', filePath, content.length);
    const parsed = lenientParse(content, `credentials.file:${filePath}`);
    if (parsed === null) logger.error('credentials: Failed to parse file %s', filePath);
    return parsed;
  } catch (e) {
    logger.error('credentials: Unexpected error reading %s: %s', filePath, e.message);
    return null;
  }
}

// Module-level credentials cache — loaded once per process, never re-read from
// disk.  This eliminates the file reads that would otherwise happen in every
// provider constructor, getProviderCredentials call, proxy lookup, etc.
let cachedCredentials = null;

/** Load credentials from env or files, with diagnostics for deployment debugging.
 *
 * Result is cached for the lifetime of the process.  Call `reloadCredentials()`
 * to force a re-read (useful for live credential rotation without a restart).
 */
export function loadCredentials() {
  if (cachedCredentials !== null) return cachedCredentials;

  // Try environment variable first (useful on cloud)
  let creds = loadFromEnv();
  if (creds !== null) {
    cachedCredentials = creds;
    return creds;
  }

  // Primary: credentials.json
  creds = loadFromFile(dataFile('credentials.json'));
  if (creds !== null) {
    cachedCredentials = creds;
    return creds;
  }

  // Fallback: credentials-test.json
  logger.warning('credentials: Falling back to credentials-test.json');
  creds = loadFromFile(dataFile('credentials-test.json'));
  if (creds !== null) {
    cachedCredentials = creds;
    return creds;
  }

  logger.warning('credentials: No credentials could be loaded; using empty credentials');
  cachedCredentials = {};
  return cachedCredentials;
}

/** Clear the credentials cache and reload from source. */
export function reloadCredentials() {
  cachedCredentials = null;
  logger.info('credentials: Cache cleared — reloading credentials from source');
  return loadCredentials();
}

/** Get credentials for a specific provider with defensive defaults. */
export function getProviderCredentials(providerName) {
  const credentials = loadCredentials();
  const provider = credentials[providerName] ?? {};
  if (typeof provider !== 'object' || Array.isArray(provider) || provider === null) {
    logger.error("credentials: Provider '%s' section is not an object", providerName);
    return {};
  }
  return provider;
}
