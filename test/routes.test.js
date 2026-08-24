/** The HTTP surface, exercised in-process. No network calls: every route here
 * either answers from local data or is a request the addon must refuse.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';

import { createApp } from '../src/app.js';
import { getProgramsFilePath } from '../src/utils/programsLoader.js';

let server;
let base;

test.before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

const get = (path, init) => fetch(`${base}${path}`, init);

test('the manifest is generated from the provider registry', async () => {
  const manifest = await (await get('/manifest.json')).json();
  assert.equal(manifest.id, 'org.catchuptvandmore.stremio');
  assert.deepEqual(manifest.resources, ['catalog', 'meta', 'stream']);
  assert.deepEqual(manifest.types, ['channel', 'series']);
  assert.deepEqual(manifest.idPrefixes, ['cutam:ca:', 'cutam:fr:']);

  const ids = manifest.catalogs.map((c) => c.id);
  assert.deepEqual(ids, ['fr-live', 'fr-francetv-replay', 'fr-mytf1-replay', 'fr-6play-replay', 'ca-cbc-dragons-den']);
  // Catalog names list the shows from programs.json
  assert.match(manifest.catalogs[1].name, /^France TV TV Shows: /);
});

test('/health reports provider configuration and cache stats', async () => {
  const health = await (await get('/health')).json();
  assert.equal(health.status, 'healthy');
  assert.deepEqual(Object.keys(health.providers), ['francetv', 'mytf1', '6play', 'cbc']);
  for (const state of Object.values(health.providers)) {
    assert.ok(['configured', 'unconfigured'].includes(state));
  }
  assert.ok('hit_rate' in health.cache);
});

test('/configure/status answers as JSON', async () => {
  const status = await (await get('/configure/status')).json();
  assert.equal(typeof status.all_configured, 'boolean');
  assert.equal(typeof status.drm_processing, 'boolean');
  assert.equal(status.providers.francetv.label, '✅ Ready (no auth needed)');
});

test('unknown catalog / stream requests answer empty, not an error', async () => {
  const catalog = await get('/catalog/series/does-not-exist.json');
  assert.equal(catalog.status, 200);
  assert.deepEqual(await catalog.json(), { metas: [] });

  const stream = await get('/stream/movie/tt1234567.json');
  assert.equal(stream.status, 200);
  assert.deepEqual(await stream.json(), { streams: [] });

  // A well-formed ID for an unknown provider must not route anywhere
  const foreign = await get('/stream/series/cutam:fr:nosuchprovider:show:episode:1.json');
  assert.deepEqual(await foreign.json(), { streams: [] });

  const meta = await get('/meta/series/tt1234567.json');
  assert.deepEqual(await meta.json(), { meta: null });
});

test('a series ID with no episode marker yields no streams', async () => {
  const res = await get('/stream/series/cutam:fr:francetv:cash-investigation.json');
  assert.deepEqual(await res.json(), { streams: [] });
});

test('CORS headers and preflight are set for Stremio clients', async () => {
  const res = await get('/manifest.json');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  // Credentials must stay off while the origin is a wildcard
  assert.equal(res.headers.get('access-control-allow-credentials'), null);

  const preflight = await get('/manifest.json', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
});

test('static logos are served', async () => {
  const res = await get('/static/logos/fr/france2.png');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/png/);
});

test('the editor serves programs.json to a local caller', async () => {
  const res = await get('/api/programs');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.shows) && data.shows.length > 0);
});

test('an unknown editor catalogue is a 404, not a crash', async () => {
  const res = await get('/api/catalogue/nope');
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /unknown provider/);
});

test('saving through the editor makes the change visible at once', async (t) => {
  // The Python addon restarted the server on every write to programs.json.
  // Without an equivalent, the parsed file (1h) and each catalogue (10min)
  // stayed cached and a save appeared to do nothing.
  // Restore the file byte for byte: saving re-serialises it, which would
  // otherwise leave the repo with a whitespace-only diff after every test run.
  const programsPath = getProgramsFilePath();
  const original = fs.readFileSync(programsPath);
  t.after(() => fs.writeFileSync(programsPath, original));

  const before = await (await get('/manifest.json')).json();
  const cbcBefore = before.catalogs.find((c) => c.id === 'ca-cbc-dragons-den').name;
  assert.doesNotMatch(cbcBefore, /Editor Round Trip/);

  const shows = [...JSON.parse(original.toString('utf-8')).shows, {
    provider: 'cbc', slug: 'editor-round-trip', name: 'Editor Round Trip',
  }];
  const saved = await get('/api/programs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shows }),
  });
  assert.equal(saved.status, 200);

  const after = await (await get('/manifest.json')).json();
  const cbcAfter = after.catalogs.find((c) => c.id === 'ca-cbc-dragons-den').name;
  assert.match(cbcAfter, /Editor Round Trip/, 'the manifest lists the new show right away');

  const reread = await (await get('/api/programs')).json();
  assert.ok(reread.shows.some((s) => s.slug === 'editor-round-trip'));
});

test('a rejected save leaves programs.json untouched', async () => {
  const before = await (await get('/api/programs')).text();
  const res = await get('/api/programs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shows: [{ provider: 'nope', slug: 'x', name: 'y' }] }),
  });
  assert.equal(res.status, 400);
  assert.equal(await (await get('/api/programs')).text(), before);
});
