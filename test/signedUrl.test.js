/** Signed-URL lifetimes — the thing that decides how long a resolved stream
 * may be cached before it starts answering 403.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { urlExpirySeconds, ttlForSignedUrl, ttlForStreams } from '../src/utils/signedUrl.js';
import { CBCProvider } from '../src/providers/ca/cbc.js';
import { cache } from '../src/utils/cache.js';
import { CacheKeys, CacheTTL } from '../src/utils/cacheKeys.js';

const now = () => Math.floor(Date.now() / 1000);

/** A CBC master playlist URL, signed the way the real one is. */
const cbcUrl = (expSeconds) => 'https://cbcrcott-aws-gem.akamaized.net/out/v1/abc/def/ghi/index-aes.m3u8'
  + `?pckgrp=bf5b&ewid=83317&manifestType=desktop&hdnea=st=${expSeconds - 120}~exp=${expSeconds}`
  + '~acl=*~hmac=a705e02d66efbe9102849a52942cf80a5be66e05e62668e03f7ab44a92f22361&lang=en';

test('an Akamai hdnea expiry is read out of the URL', () => {
  const exp = now() + 120;
  assert.equal(urlExpirySeconds(cbcUrl(exp)), exp);
  assert.equal(urlExpirySeconds('https://cdn.example/a.m3u8?Expires=1787692002'), 1787692002);
  assert.equal(urlExpirySeconds('https://cdn.example/a.m3u8'), null, 'no expiry stated');
  assert.equal(urlExpirySeconds(''), null);
  assert.equal(urlExpirySeconds(null), null);
  // A base64 path that merely contains the letters is not an expiry.
  assert.equal(urlExpirySeconds('https://x/ZXhwPTE3ODc2Mjc5MjB+YWNs/manifest.mpd'), null);
});

test('a URL is never cached past its own signature', () => {
  // CBC's window is 120s; the stream TTL is 1800s. The signature must win.
  const ttl = ttlForSignedUrl(cbcUrl(now() + 120), CacheTTL.STREAM);
  assert.ok(ttl > 90 && ttl <= 105, `expected ~105s, got ${ttl}`);

  // A long signature does not extend caching beyond the normal TTL.
  assert.equal(ttlForSignedUrl(cbcUrl(now() + 86400), CacheTTL.STREAM), CacheTTL.STREAM);

  // An already-dead URL must not be cached at all.
  assert.equal(ttlForSignedUrl(cbcUrl(now() - 10), CacheTTL.STREAM), 0);
  assert.equal(ttlForSignedUrl(cbcUrl(now() + 5), CacheTTL.STREAM), 0, 'inside the safety margin');

  // No stated expiry falls back to the caller's TTL.
  assert.equal(ttlForSignedUrl('https://cdn.example/a.m3u8', CacheTTL.STREAM), CacheTTL.STREAM);
});

test('a stream list is capped by its shortest-lived URL', () => {
  const streams = [
    { url: cbcUrl(now() + 86400) },
    { url: cbcUrl(now() + 120) },
  ];
  const ttl = ttlForStreams(streams, CacheTTL.STREAM);
  assert.ok(ttl > 90 && ttl <= 105, `expected the short one to win, got ${ttl}`);
  assert.equal(ttlForStreams([], CacheTTL.STREAM), CacheTTL.STREAM);
});

test('CBC caches a resolved stream only for as long as it stays playable', async (t) => {
  const provider = new CBCProvider(null);
  const episodeId = 'cutam:ca:cbc:test-show:episode:1:1';
  cache.delete(CacheKeys.stream(episodeId));

  provider._authenticateIfNeeded = async () => {};
  provider._extractMediaIdFromEpisodeId = async () => '12345';
  provider._getStreamFromCbcApi = async () => [{
    url: cbcUrl(now() + 120), manifest_type: 'hls', title: 'CBC Gem Stream',
  }];

  // Watch what TTL the provider asks for.
  const realSet = cache.set.bind(cache);
  const writes = [];
  cache.set = (key, value, ttl) => { writes.push({ key, ttl }); return realSet(key, value, ttl); };
  t.after(() => { cache.set = realSet; cache.delete(CacheKeys.stream(episodeId)); });

  const streams = await provider.getEpisodeStreamUrl(episodeId);
  assert.equal(streams.length, 1);

  const write = writes.find((w) => w.key === CacheKeys.stream(episodeId));
  assert.ok(write, 'the stream was cached');
  assert.ok(write.ttl > 90 && write.ttl <= 105,
    `expected ~105s from the 120s signature, got ${write.ttl}s (1800 was the bug)`);
});

test('CBC does not cache a stream whose signature has already lapsed', async (t) => {
  const provider = new CBCProvider(null);
  const episodeId = 'cutam:ca:cbc:test-show:episode:2:2';
  cache.delete(CacheKeys.stream(episodeId));

  provider._authenticateIfNeeded = async () => {};
  provider._extractMediaIdFromEpisodeId = async () => '99999';
  provider._getStreamFromCbcApi = async () => [{ url: cbcUrl(now() - 60), manifest_type: 'hls' }];

  const streams = await provider.getEpisodeStreamUrl(episodeId);
  assert.equal(streams.length, 1, 'it is still returned to the caller');
  assert.equal(cache.get(CacheKeys.stream(episodeId)), null, 'but never cached');
  t.after(() => cache.delete(CacheKeys.stream(episodeId)));
});
