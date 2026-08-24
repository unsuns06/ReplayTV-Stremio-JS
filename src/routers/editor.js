/** The programs.json editor, served as the addon's homepage.
 *
 * These routes write to programs.json, so they answer to loopback only — a
 * deployed instance still gets the plain JSON greeting at `/`.  Set
 * `enable_remote_editor` to lift that if you know what you are exposing
 * (lower-case: Hugging Face Spaces reject capitals in variable names, and env
 * lookups are case-sensitive everywhere except Windows).
 *
 * The catalogue endpoints exist because a browser cannot call the provider APIs
 * itself: none of them send CORS headers.
 */
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { getLogger } from '../utils/logger.js';
import { getProgramsFilePath, reloadPrograms } from '../utils/programsLoader.js';
import { STATIC_DIR } from '../utils/paths.js';
import { withParams } from '../utils/apiClient.js';

const logger = getLogger('routers.editor');
export const router = express.Router();

const PROGRAMS = getProgramsFilePath();
const EDITOR_PAGE = path.join(STATIC_DIR, 'editor.html');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

function isLocal(req) {
  if (process.env.enable_remote_editor) return true;
  const host = req.socket?.remoteAddress || '';
  return LOOPBACK.has(host);
}

async function get(url, params = null, headers = null) {
  const response = await fetch(withParams(url, params), {
    headers: { 'User-Agent': UA, ...(headers || {}) },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

/** Map *fn* over *items*, at most 8 at a time. Results keep the input order. */
async function parallel(fn, items) {
  const list = [...items];
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= list.length) return;
      results[index] = await fn(list[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, list.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// One "every show this provider offers" reader per provider.  Each returns
// {slug, name, channel} rows whose slug is what the addon will put in
// programs.json — the provider's own identifier, never a display name.
// ---------------------------------------------------------------------------

/** 6play only lists programs one initial letter at a time ('@' = digits). */
async function catalogue6play() {
  const url = 'https://android.middleware.6play.fr/6play/v2/platforms/'
    + 'm6group_androidmob/services/6play/programs';
  const letters = ['@', ...'abcdefghijklmnopqrstuvwxyz'];
  const pages = await parallel(
    (letter) => get(url, {
      limit: 999, offset: 0, csa: 6, firstLetter: letter, with: 'rights',
    }, { 'x-customer-name': 'm6web' }),
    letters,
  );
  const rows = {};
  for (const page of pages) {
    for (const program of page) {
      if (program.code) rows[program.code] = { slug: program.code, name: program.title || '', channel: '' };
    }
  }
  return rows;
}

// The same lists src/providers/fr/mytf1.js searches, so the editor can only
// offer shows the addon is able to resolve.  TF1 has 4471 programs and pages
// 500 at a time, and its only filter is the channel.
const TF1_LISTS = [null, 'tf1', 'tmc', 'tfx', 'tf1-series-films'];

async function catalogueMytf1() {
  const byChannel = async (channel) => {
    const variables = {
      context: {
        persona: 'PERSONA_2', application: 'WEB', device: 'DESKTOP', os: 'WINDOWS',
      },
      filter: channel ? { channel } : {},
      offset: 0,
      limit: 500,
    };
    const data = await get(
      'https://www.tf1.fr/graphql/web',
      { id: '483ce0f', variables: JSON.stringify(variables) },
      { referer: 'https://www.tf1.fr/programmes-tv' },
    );
    return data.data?.programs?.items || [];
  };

  const rows = {};
  for (const items of await parallel(byChannel, TF1_LISTS)) {
    for (const program of items) {
      if (program.slug) {
        rows[program.slug] = {
          slug: program.slug,
          name: program.name || '',
          channel: program.mainChannel?.label || '',
        };
      }
    }
  }
  return rows;
}

// France TV addresses a show as <channel>_<slug>; src/providers/fr/francetv.js
// rebuilds that from these five channels, so a programme filed under anything
// else (sport/…, la1ere/…, documentaires/…) is not offered.
const FRANCETV_CHANNELS = ['france-2', 'france-3', 'france-4', 'france-5', 'franceinfo'];
const FRANCETV_PROGRAMS = 'http://api-front.yatta.francetv.fr/standard/publish/channels';

async function catalogueFrancetv() {
  const byChannel = async (channel) => {
    // Each channel's list leans towards that channel but is not limited to it,
    // so all five are read and unioned. Page 0 says how many follow.
    const url = `${FRANCETV_PROGRAMS}/${channel}/programs/`;
    const first = await get(url, { platform: 'apps', size: 100, page: 0 });
    const lastPage = first.cursor?.last ?? 0;
    const pages = Array.from({ length: lastPage }, (_, i) => i + 1);
    const rest = await parallel(
      async (page) => (await get(url, { platform: 'apps', size: 100, page })).result || [],
      pages,
    );
    return [...(first.result || []), ...rest.flat()];
  };

  const rows = {};
  for (const programs of await parallel(byChannel, FRANCETV_CHANNELS)) {
    for (const program of programs) {
      const complete = program.url_complete || '';
      const idx = complete.indexOf('/');
      const channel = idx === -1 ? complete : complete.slice(0, idx);
      const slug = idx === -1 ? '' : complete.slice(idx + 1);
      if (FRANCETV_CHANNELS.includes(channel) && slug) {
        rows[slug] = { slug, name: program.label || '', channel };
      }
    }
  }
  return rows;
}

async function catalogueCbc() {
  const data = await get(
    'https://services.radio-canada.ca/ott/catalog/v2/gem/category/shows',
    { device: 'web', pageNumber: 1, pageSize: 500 },
    { Accept: 'application/json', Referer: 'https://gem.cbc.ca/', Origin: 'https://gem.cbc.ca' },
  );
  const rows = {};
  for (const show of data.content[0].items.results) {
    if (show.url) rows[show.url] = { slug: show.url, name: show.title || '', channel: 'CBC' };
  }
  return rows;
}

const CATALOGUES = {
  '6play': catalogue6play,
  mytf1: catalogueMytf1,
  francetv: catalogueFrancetv,
  cbc: catalogueCbc,
};

const catalogueCache = {};

/** Every show a provider offers, sorted by name. Fetched once per run. */
async function catalogue(provider) {
  if (!(provider in catalogueCache)) {
    const rows = await CATALOGUES[provider]();
    // Code-point order on the lower-cased name, not locale collation: locale
    // rules reorder punctuation ("Jamie:" before "Jamie's"), and the editor's
    // list should stay in one predictable order.
    catalogueCache[provider] = Object.values(rows).sort((a, b) => {
      const x = a.name.toLowerCase();
      const y = b.name.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }
  return catalogueCache[provider];
}

// ---------------------------------------------------------------------------
// programs.json
// ---------------------------------------------------------------------------

function fields(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(', ');
}

/** Serialise in the file's own layout: one show per line, 2-space indent. */
export function dumpPrograms(data) {
  const head = Object.entries(data)
    .filter(([k]) => k !== 'shows')
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(',\n');
  const shows = data.shows.map((show) => `    { ${fields(show)} }`).join(',\n');
  return `{\n${head},\n  "shows": [\n${shows}\n  ]\n}\n`;
}

const CORE = ['provider', 'slug', 'name'];

/** The shows to write, or a thrown Error. This overwrites a real file, so
 * nothing unchecked gets through. */
export function validate(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.shows)) {
    throw new Error("expected an object with a 'shows' list");
  }
  const seen = new Set();
  const shows = [];
  payload.shows.forEach((show, i) => {
    if (!show || typeof show !== 'object' || Array.isArray(show)) {
      throw new Error(`show ${i} is not an object`);
    }
    const clean = {};
    for (const field of CORE) {
      const value = show[field];
      if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`show ${i}: '${field}' is required`);
      }
      clean[field] = value.trim();
    }
    if (!(clean.provider in CATALOGUES)) {
      throw new Error(`show ${i}: unknown provider '${clean.provider}'`);
    }
    const key = `${clean.provider}/${clean.slug}`;
    if (seen.has(key)) throw new Error(`duplicate show: ${key}`);
    seen.add(key);
    // Any other field the file already pinned (an artwork URL, a genre
    // override) is kept verbatim; the editor just does not offer to add one.
    for (const [field, value] of Object.entries(show)) {
      if (!(field in clean) && field !== 'enabled') clean[field] = value;
    }
    if (show.enabled === false) clean.enabled = false;
    shows.push(clean);
  });
  return shows;
}

// ---------------------------------------------------------------------------

const FORBIDDEN = { error: 'The programs editor is local-only' };

/** The editor locally, the plain API greeting anywhere else. */
router.get('/', (req, res) => {
  if (!isLocal(req)) return res.json({ message: 'Catch-up TV & More for Stremio API' });
  return res.sendFile(EDITOR_PAGE);
});

router.get('/api/programs', (req, res) => {
  if (!isLocal(req)) return res.status(403).json(FORBIDDEN);
  return res.type('application/json; charset=utf-8').send(fs.readFileSync(PROGRAMS, 'utf-8'));
});

router.post('/api/programs', (req, res) => {
  if (!isLocal(req)) return res.status(403).json(FORBIDDEN);
  const data = JSON.parse(fs.readFileSync(PROGRAMS, 'utf-8'));
  try {
    data.shows = validate(req.body);
  } catch (exc) {
    return res.status(400).json({ error: exc.message });
  }
  // The repo keeps programs.json in LF; dumpPrograms only ever emits \n, so
  // nothing here can rewrite the file as CRLF on Windows.
  fs.writeFileSync(PROGRAMS, dumpPrograms(data), 'utf-8');
  // Without this the catalogues and the manifest keep serving the old list for
  // up to an hour, and a save looks like it did nothing.
  reloadPrograms();
  logger.info('✅ [Editor] Saved %d shows to programs.json', data.shows.length);
  return res.json({ saved: data.shows.length, path: PROGRAMS });
});

router.get('/api/catalogue/:provider', async (req, res) => {
  if (!isLocal(req)) return res.status(403).json(FORBIDDEN);
  const { provider } = req.params;
  if (!(provider in CATALOGUES)) {
    return res.status(404).json({ error: `unknown provider '${provider}'` });
  }
  try {
    return res.json(await catalogue(provider));
  } catch (exc) {
    logger.error('❌ [Editor] %s catalogue failed: %s', provider, exc.message);
    return res.status(502).json({ error: `${provider}: ${exc.message}` });
  }
});
