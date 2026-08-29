/** The auth warm-up and the parallel-probe rewrites.
 *
 * No network: every test stubs the one call it is about, so these assert the
 * shape of the work (how many requests, in what order, concurrent or not)
 * rather than that a provider is reachable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { warmAllProviders, stopAuthWarmer, startAuthWarmer, WARM_INTERVAL_MS } from '../src/utils/authWarmer.js';
import { EXPIRY_BUFFER, ttlFromJwt } from '../src/utils/authCache.js';
import { CBCAuthenticator } from '../src/auth/cbcAuth.js';
import { CBCProvider } from '../src/providers/ca/cbc.js';
import { FranceTVProvider } from '../src/providers/fr/francetv.js';
import { MyTF1Provider } from '../src/providers/fr/mytf1.js';
import { cache } from '../src/utils/cache.js';
import { PROVIDER_CLASSES } from '../src/providers/registry.js';

const realFetch = globalThis.fetch;
const restoreFetch = () => { globalThis.fetch = realFetch; };

/** A fetch stub that refuses everything quickly and counts the calls. */
function stubFetch({ delayMs = 0, status = 404 } = {}) {
  const state = { calls: [], concurrent: 0, maxConcurrent: 0 };
  globalThis.fetch = async (url) => {
    const u = typeof url === 'string' ? url : url.url;
    state.calls.push(u);
    state.concurrent += 1;
    state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
    if (delayMs) await new Promise((r) => { setTimeout(r, delayMs); });
    state.concurrent -= 1;
    return new Response('{}', { status, headers: { 'content-type': 'application/json' } });
  };
  return state;
}

test('the warmer reports one result per provider and never throws', async (t) => {
  t.after(restoreFetch);
  stubFetch();
  const results = await warmAllProviders();

  // Derived from the registry, so registering a provider does not fail this.
  const expected = Object.keys(PROVIDER_CLASSES).sort();
  assert.equal(results.length, expected.length);
  const byKey = Object.fromEntries(results.map((r) => [r.key, r]));
  assert.deepEqual(Object.keys(byKey).sort(), expected);
  // FranceTV needs no credentials, so it must never be reported as a failure.
  assert.equal(byKey.francetv.state, 'no-auth');
  for (const r of results) {
    assert.ok(['ready', 'failed', 'error', 'no-auth'].includes(r.state), `bad state ${r.state}`);
    assert.equal(typeof r.ms, 'number');
  }
});

test('providers are warmed concurrently, not one after another', async (t) => {
  t.after(restoreFetch);
  const state = stubFetch({ delayMs: 120 });
  const t0 = Date.now();
  await warmAllProviders();
  const elapsed = Date.now() - t0;

  // Three providers authenticate; serial would be at least 3 × 120ms of
  // first-call latency alone.
  assert.ok(state.maxConcurrent > 1, `expected overlapping requests, saw ${state.maxConcurrent}`);
  assert.ok(elapsed < 3 * 120, `expected concurrency, took ${elapsed}ms`);
});

test('a second sweep joins the one in flight instead of double-logging-in', async (t) => {
  t.after(restoreFetch);
  const state = stubFetch({ delayMs: 60 });
  const [a, b] = await Promise.all([warmAllProviders(), warmAllProviders()]);
  const single = state.calls.length;

  assert.deepEqual(a, b, 'both callers get the same sweep');
  // A duplicated sweep would roughly double the request count.
  const state2 = stubFetch({ delayMs: 60 });
  await warmAllProviders();
  assert.equal(state2.calls.length, single, 'a later sweep does the same work once');
});

test('the warm interval stays inside the token expiry buffer', () => {
  // The cache drops a token EXPIRY_BUFFER before it really expires; sweeping
  // less often than that would let a request find an empty cache.
  assert.ok(WARM_INTERVAL_MS / 1000 < EXPIRY_BUFFER,
    `warm interval ${WARM_INTERVAL_MS / 1000}s must be under the ${EXPIRY_BUFFER}s buffer`);
});

test('startAuthWarmer returns a stop function and does not hold the process', (t) => {
  t.after(restoreFetch);
  stubFetch();
  const stop = startAuthWarmer({ immediate: false });
  assert.equal(typeof stop, 'function');
  stop();
  stopAuthWarmer(); // idempotent
});

test('CBC tokens are cached for their real lifetime, not the 60s default', () => {
  const writes = [];
  const fakeCache = {
    get: () => null,
    set: (key, value, ttl) => writes.push({ key, value, ttl }),
    delete: (key) => writes.push({ key, deleted: true }),
  };
  const auth = new CBCAuthenticator(fakeCache);

  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
  auth._cacheToken('cbc_access_token', jwt);

  const write = writes.find((w) => w.key === 'cbc_access_token' && !w.deleted);
  assert.ok(write, 'the token was written');
  assert.equal(write.ttl, ttlFromJwt(jwt));
  assert.ok(write.ttl > 3000, `expected ~55 min, got ${write.ttl}s — the 60s default would break reuse`);

  auth._cacheToken('cbc_access_token', null);
  assert.ok(writes.some((w) => w.key === 'cbc_access_token' && w.deleted), 'a null token clears the entry');
});

test('a fresh CBC authenticator adopts tokens already in the cache', () => {
  const store = { cbc_access_token: 'a', cbc_refresh_token: 'r', cbc_claims_token: 'c' };
  const auth = new CBCAuthenticator({
    get: (k) => store[k] ?? null, set: () => {}, delete: () => {},
  });
  // Provider instances are per-request; without this a warm token looked absent.
  assert.equal(auth.accessToken, 'a');
  assert.equal(auth.refreshToken, 'r');
  assert.equal(auth.claimsToken, 'c');
});

test('CBC probes season 1 alone, then the rest together', async () => {
  const provider = new CBCProvider(null);

  // Common case: season 1 answers, so nothing else is asked for.
  let asked = [];
  provider.apiClient.get = async (url) => { asked.push(url); return { title: 'ok' }; };
  const hit = await provider._showPayload('a-show');
  assert.equal(hit.title, 'ok');
  assert.equal(asked.length, 1, 'a show with a season 1 costs exactly one request');
  assert.match(asked[0], /s01e01/);

  // Aged-out case: season 1 misses, the rest go out at once and the lowest wins.
  asked = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  provider.apiClient.get = async (url) => {
    asked.push(url);
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => { setTimeout(r, 10); });
    concurrent -= 1;
    // Seasons 4 and 6 both exist; season 4 must win regardless of timing.
    if (url.includes('s04e01')) return { title: 'season4' };
    if (url.includes('s06e01')) return { title: 'season6' };
    return null;
  };
  const late = await provider._showPayload('aged-out');
  assert.equal(late.title, 'season4', 'the lowest available season wins, not the fastest reply');
  assert.equal(asked.length, CBCProvider.MAX_SEASON_PROBE);
  assert.ok(maxConcurrent > 1, 'the fallback probes run together');
});

test('FranceTV tries France 2 first, then the other channels together', async () => {
  const provider = new FranceTVProvider(null);

  cache.clear();
  let asked = [];
  provider._taxonomy = async (apiId) => { asked.push(apiId); return { id: apiId }; };
  assert.equal(await provider._apiShowId('some-show'), 'france-2_some-show');
  assert.equal(asked.length, 1, 'a France 2 show still costs one request');

  cache.clear();
  asked = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  provider._taxonomy = async (apiId) => {
    asked.push(apiId);
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => { setTimeout(r, 10); });
    concurrent -= 1;
    // Both France 5 and franceinfo answer; channel order must decide.
    return (apiId.startsWith('france-5') || apiId.startsWith('franceinfo')) ? { id: apiId } : null;
  };
  assert.equal(await provider._apiShowId('later-show'), 'france-5_later-show');
  assert.equal(asked.length, 5);
  assert.ok(maxConcurrent > 1, 'the remaining channels are probed together');
  cache.clear();
});

test('MyTF1 searches the unfiltered list first, then the channel lists together', async () => {
  const provider = new MyTF1Provider(null);
  provider.shows = { 'my-show': { name: 'My Show' } };

  let asked = [];
  provider._getGraphqlProgramsList = async (headers, channel) => {
    asked.push(channel);
    return [{ slug: 'my-show', name: 'My Show' }];
  };
  const found = await provider._findProgram('my-show');
  assert.equal(found.slug, 'my-show');
  assert.equal(asked.length, 1, 'a hit in the unfiltered list costs one request');
  assert.equal(asked[0], null);

  asked = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  provider._getGraphqlProgramsList = async (headers, channel) => {
    asked.push(channel);
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => { setTimeout(r, 10); });
    concurrent -= 1;
    if (channel === 'tfx') return [{ slug: 'my-show', name: 'My Show', from: 'tfx' }];
    if (channel === 'tmc') return [{ slug: 'my-show', name: 'My Show', from: 'tmc' }];
    return [];
  };
  const late = await provider._findProgram('my-show');
  assert.equal(late.from, 'tmc', 'filter order decides, not which reply landed first');
  assert.equal(asked.length, 5);
  assert.ok(maxConcurrent > 1, 'the channel lists are fetched together');
});

test('MyTF1 picks the multi-key KID from the manifest it already read', async (t) => {
  t.after(restoreFetch);
  const provider = new MyTF1Provider(null);

  // The old code re-read the manifest through the geo proxy just to learn the
  // default_KID, so any fetch here is the regression this guards.
  const state = stubFetch();

  const keys = { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: '11', bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: '22' };
  const picked = await provider._selectDrmKey(
    'https://example/manifest.mpd', keys, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  );
  assert.deepEqual(picked, { key_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', key: '22' });
  assert.equal(state.calls.length, 0, 'the manifest is not fetched a second time');

  // One key needs no manifest at all.
  const single = await provider._selectDrmKey('https://example/manifest.mpd', { cccccccccccccccccccccccccccccccc: '33' });
  assert.deepEqual(single, { key_id: 'cccccccccccccccccccccccccccccccc', key: '33' });
  assert.equal(await provider._selectDrmKey('https://example/manifest.mpd', {}), null);
  assert.equal(state.calls.length, 0);

  // Only a manifest that published no default_KID falls back to re-reading it.
  await provider._selectDrmKey('https://example/manifest.mpd', keys, null);
  assert.ok(state.calls.length > 0, 'the fallback still works when the KID is unknown');
});
