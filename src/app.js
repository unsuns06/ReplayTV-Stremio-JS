import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';

import { getLogger, LOG_LEVEL_NAME } from './utils/logger.js';
import { STATIC_DIR, dataFile } from './utils/paths.js';
import { runWithClientIp, resolveViewerIp } from './utils/clientIp.js';
import { loadCredentials } from './utils/credentials.js';
import { cache } from './utils/cache.js';
import { getManifest } from './manifest.js';
import { PROVIDER_REGISTRY } from './config/providerConfig.js';

import { router as catalogRouter } from './routers/catalog.js';
import { router as metaRouter } from './routers/meta.js';
import { router as streamRouter } from './routers/stream.js';
import { router as configureRouter } from './routers/configure.js';
import { router as editorRouter } from './routers/editor.js';

const logger = getLogger('app.main');

const LOG_FILE_PATH = process.env.LOG_FILE || path.join(os.tmpdir(), 'server_debug.log');
const LOG_TO_FILE = ['1', 'true', 'yes', 'on'].includes((process.env.LOG_TO_FILE || 'false').toLowerCase());
let FILE_LOG_ENABLED = false;

if (LOG_TO_FILE) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE_PATH), { recursive: true });
    const stream = fs.createWriteStream(LOG_FILE_PATH, { flags: 'a' });
    for (const level of ['log', 'error', 'warn']) {
      const original = console[level].bind(console);
      console[level] = (...args) => {
        original(...args);
        stream.write(`${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
      };
    }
    FILE_LOG_ENABLED = true;
  } catch {
    // Fall back to console-only if the file cannot be opened
    FILE_LOG_ENABLED = false;
  }
}

/** Log the credential summary once at startup. */
export function startupDiagnostics() {
  try {
    logger.info('🔧 Startup diagnostics: loading credentials...');
    const creds = loadCredentials();
    const providers = creds && typeof creds === 'object' ? Object.keys(creds) : [];
    const summary = {};
    for (const [name, val] of Object.entries(creds || {})) {
      summary[name] = (val && typeof val === 'object' && !Array.isArray(val))
        ? Object.keys(val).sort()
        : `<${typeof val}>`;
    }
    logger.info('✅ Credentials loaded. Providers present: %s', providers);
    logger.info('✅ Credentials keys by provider (sanitized): %s', summary);
  } catch (e) {
    logger.error('❌ Startup diagnostics failed while loading credentials: %s', e.message);
  }
}

export function createApp() {
  const app = express();

  // Behind a proxy, honour X-Forwarded-Proto/Host so getBaseUrl builds the
  // public URL rather than the internal one.
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(express.json({ limit: '5mb' }));

  // CORS — Stremio clients need permissive origins and working preflight.
  // Credentials must stay off while the origin is a wildcard.
  app.use((req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': '*',
    });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  // Request logging + per-request viewer IP context
  app.use((req, res, next) => {
    const start = Date.now();
    logger.debug('REQUEST: %s %s', req.method, req.originalUrl);
    res.on('finish', () => {
      logger.debug('RESPONSE: %s in %ss', res.statusCode, ((Date.now() - start) / 1000).toFixed(3));
    });
    let ip = null;
    try {
      ip = resolveViewerIp(req.headers, req.socket?.remoteAddress);
    } catch (e) {
      logger.warning('Failed to extract viewer IP: %s', e.message);
    }
    // Everything downstream runs inside this store, so getClientIp() works from
    // anywhere in the async call chain without threading the request through.
    return runWithClientIp(ip, next);
  });

  // Static files for logos
  app.use('/static', express.static(STATIC_DIR));

  app.get('/manifest.json', (req, res) => {
    try {
      const manifestData = getManifest();
      logger.info('Manifest generated successfully');
      res.json(manifestData);
    } catch (e) {
      logger.exception('Error generating manifest', e);
      throw e;
    }
  });

  app.get('/health', (req, res) => {
    const providersStatus = {};
    try {
      const creds = loadCredentials();
      for (const [key, cfg] of Object.entries(PROVIDER_REGISTRY)) {
        const credsKey = cfg.credentials_key || key;
        providersStatus[key] = creds[credsKey] ? 'configured' : 'unconfigured';
      }
    } catch (e) {
      return res.json({ status: 'healthy', providers: { error: e.message } });
    }
    return res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      log_level: LOG_LEVEL_NAME,
      providers: providersStatus,
      cache: cache.stats(),
    });
  });

  if (process.env.ENABLE_DEBUG_ENDPOINTS) {
    app.get('/debug/logs', (req, res) => {
      if (!FILE_LOG_ENABLED) return res.json({ error: 'File logging is disabled' });
      try {
        const lines = fs.readFileSync(LOG_FILE_PATH, 'utf-8').split('\n');
        return res.json({
          log_file: LOG_FILE_PATH,
          total_lines: lines.length,
          recent_lines: lines.slice(-100),
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        if (e.code === 'ENOENT') return res.json({ error: 'Log file not found', path: LOG_FILE_PATH });
        return res.json({ error: `Could not read logs: ${e.message}` });
      }
    });

    app.get('/debug/status', (req, res) => {
      res.json({
        status: 'running',
        timestamp: new Date().toISOString(),
        environment: {
          ADDON_BASE_URL: process.env.ADDON_BASE_URL || 'Not set',
          LOG_LEVEL: LOG_LEVEL_NAME,
        },
        logging: { file_enabled: FILE_LOG_ENABLED, log_file_path: LOG_FILE_PATH },
      });
    });

    app.get('/debug/credentials', (req, res) => {
      const credPrimary = dataFile('credentials.json');
      const credFallback = dataFile('credentials-test.json');
      const envPresent = Boolean(process.env.CREDENTIALS_JSON);
      const info = {
        files: {
          'credentials.json_exists': fs.existsSync(credPrimary),
          'credentials-test.json_exists': fs.existsSync(credFallback),
        },
        env: {
          CREDENTIALS_JSON_present: envPresent,
          CREDENTIALS_JSON_length: envPresent ? process.env.CREDENTIALS_JSON.length : 0,
        },
        providers: {},
        timestamp: new Date().toISOString(),
      };
      try {
        const creds = loadCredentials();
        for (const [name, val] of Object.entries(creds || {})) {
          info.providers[name] = (val && typeof val === 'object' && !Array.isArray(val))
            ? Object.keys(val).sort()
            : `<${typeof val}>`;
        }
      } catch (e) {
        info.error = `Failed to load credentials: ${e.message}`;
      }
      res.json(info);
    });
  }

  // Routers
  app.use(catalogRouter);
  app.use(metaRouter);
  app.use(streamRouter);
  app.use(configureRouter);
  // Owns "/" — the programs.json editor locally, the API greeting elsewhere.
  app.use(editorRouter);

  // Global error handler — the last word on unhandled failures
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    logger.exception('Unhandled exception in %s %s', req.method, req.originalUrl, err);
    res.status(500).json({
      error: 'Unhandled Exception',
      message: err.message,
      type: err.name,
      timestamp: new Date().toISOString(),
      path: req.originalUrl,
    });
  });

  return app;
}
