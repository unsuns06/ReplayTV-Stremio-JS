/** The pure logic behind the addon: ID parsing, caching, encoding, IP
 * resolution, catalogue building and the programs.json round-trip.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { parseStremioId } from '../src/utils/ids.js';
import { InMemoryCache } from '../src/utils/cache.js';
import { CacheKeys } from '../src/utils/cacheKeys.js';
import {
  normalizeIp, isPublicIp, extractPublicIpFromXff, resolveViewerIp, makeIpHeaders,
} from '../src/utils/clientIp.js';
import { normalizeKeyId, ensureHexKey, hexToBase64Url, normalizeDecryptionKey } from '../src/utils/encoding.js';
import { buildMediaflowUrl } from '../src/utils/mediaflow.js';
import { buildShowDict } from '../src/utils/showMeta.js';
import { ttlFromJwt, decodeJwt } from '../src/utils/authCache.js';
import { CookieJar } from '../src/utils/cookieJar.js';
import { metaPreview, streamResponse } from '../src/schemas/stremio.js';
import { getProgramsForProvider, getProgramsFilePath } from '../src/utils/programsLoader.js';
import { dumpPrograms, validate } from '../src/routers/editor.js';
import { extractDrmInfoFromMpd } from '../src/utils/drm/psshExtractor.js';
import { matchWebdl } from '../src/providers/drmMixin.js';
import { htmlUnescape, imageExtractor } from '../src/providers/fr/metadata.js';

test('parseStremioId splits the documented grammar', () => {
  const show = parseStremioId('cutam:fr:francetv:cash-investigation');
  assert.equal(show.country, 'fr');
  assert.equal(show.provider, 'francetv');
  assert.equal(show.slug, 'cash-investigation');

  const episode = parseStremioId('cutam:ca:cbc:dragons-den:episode:20:16');
  assert.equal(episode.provider, 'cbc');
  assert.equal(episode.rest, 'dragons-den:episode:20:16');
  assert.equal(episode.afterMarker('episode:'), '20:16');
  assert.equal(episode.afterMarker('season:'), null);

  // Malformed IDs must not resolve to a provider
  for (const bad of ['', 'tt1234567', 'cutam:fr', 'cutam:fr:francetv', 'other:fr:francetv:x']) {
    assert.equal(parseStremioId(bad), null, `${bad} should not parse`);
  }
});

test('the cache expires entries and evicts the least recently used', () => {
  const cache = new InMemoryCache(2);
  cache.set('a', 1, 60);
  cache.set('b', 2, 60);
  assert.equal(cache.get('a'), 1); // 'a' becomes most recent
  cache.set('c', 3, 60); // evicts 'b'
  assert.equal(cache.get('b'), null);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);

  assert.equal(cache.stats().size, 2, 'the cache never grows past its limit');
  assert.match(cache.stats().hit_rate, /%$/);

  cache.set('gone', 'x', -1); // evicts 'a', the oldest of the three
  assert.equal(cache.get('gone'), null, 'a past TTL is a miss');
  assert.equal(cache.stats().size, 1, 'and the expired entry is dropped on read');
});

test('cache keys are stable', () => {
  assert.equal(CacheKeys.channels('6play'), 'channels:6play');
  assert.equal(CacheKeys.episodes('cutam:fr:mytf1:x'), 'episodes:cutam:fr:mytf1:x');
  assert.equal(CacheKeys.providerResource('cbc', 'auth_status'), 'provider:cbc:auth_status');
});

test('viewer IP resolution follows the documented header priority', () => {
  assert.equal(normalizeIp('203.0.113.5:1234'), '203.0.113.5');
  assert.equal(normalizeIp('[2001:db8::1]:443'), '2001:db8::1');
  assert.equal(normalizeIp('::ffff:192.0.2.10'), '192.0.2.10');

  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('192.168.1.1'), false);
  assert.equal(isPublicIp('10.0.0.1'), false);
  assert.equal(isPublicIp('127.0.0.1'), false);
  assert.equal(isPublicIp('not-an-ip'), false);

  assert.equal(extractPublicIpFromXff('192.168.1.1, 8.8.8.8'), '8.8.8.8');

  // cf-connecting-ip outranks x-forwarded-for
  assert.equal(resolveViewerIp({
    'cf-connecting-ip': '9.9.9.9',
    'x-forwarded-for': '8.8.8.8',
  }), '9.9.9.9');

  // a signed x-ip-token outranks everything
  const payload = Buffer.from(JSON.stringify({ ip: '1.2.3.4' })).toString('base64url');
  assert.equal(resolveViewerIp({
    'x-ip-token': `h.${payload}.s`,
    'cf-connecting-ip': '9.9.9.9',
  }), '1.2.3.4');

  // the connection address is the last resort
  assert.equal(resolveViewerIp({}, '5.6.7.8'), '5.6.7.8');

  const headers = makeIpHeaders('8.8.8.8');
  assert.equal(headers['X-Forwarded-For'], '8.8.8.8');
  assert.equal(headers.Forwarded, 'for=8.8.8.8');
  assert.deepEqual(makeIpHeaders(null), {}, 'no IP means no headers');
});

test('DRM key encoding handles hex, base64 and kid:key pairs', () => {
  const hex = '00112233445566778899aabbccddeeff';
  assert.equal(normalizeKeyId(hex), hex);
  assert.equal(normalizeKeyId('00112233-4455-6677-8899-aabbccddeeff'), hex);
  assert.equal(normalizeKeyId(Buffer.from(hex, 'hex').toString('base64')), hex);
  assert.equal(normalizeKeyId(''), null);

  assert.equal(ensureHexKey(hex.toUpperCase()), hex);
  assert.equal(ensureHexKey(`kid:${hex}`), hex);
  assert.equal(hexToBase64Url(hex), Buffer.from(hex, 'hex').toString('base64url'));
  assert.equal(hexToBase64Url('nothex'), null);

  const key = 'ffeeddccbbaa99887766554433221100';
  assert.equal(normalizeDecryptionKey(`${hex}:${key}`, hex), key);
  // A kid that does not match the requested one yields the bare-hex fallback
  assert.equal(normalizeDecryptionKey(key, key), key);
});

test('MediaFlow URLs carry headers, license info and DRM keys', () => {
  const url = buildMediaflowUrl({
    baseUrl: 'https://mf.example/',
    password: 'secret',
    destinationUrl: 'https://cdn.example/manifest.mpd?a=1&b=2',
    endpoint: '/proxy/mpd/manifest.m3u8',
    requestHeaders: { Referer: 'https://x.example', Skipped: null },
    licenseUrl: 'https://lic.example/',
    licenseHeaders: { 'X-Token': 'abc' },
    extraParams: { key_id: 'kkk', key: 'vvv' },
  });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://mf.example/proxy/mpd/manifest.m3u8');
  assert.equal(parsed.searchParams.get('d'), 'https://cdn.example/manifest.mpd?a=1&b=2');
  assert.equal(parsed.searchParams.get('api_password'), 'secret');
  assert.equal(parsed.searchParams.get('h_referer'), 'https://x.example');
  assert.equal(parsed.searchParams.get('h_skipped'), null, 'null headers are dropped');
  assert.equal(parsed.searchParams.get('license_url'), 'https://lic.example/');
  assert.equal(parsed.searchParams.get('license_h_x-token'), 'abc');
  assert.equal(parsed.searchParams.get('key_id'), 'kkk');
});

test('buildShowDict applies the programs.json precedence rules', () => {
  const pinned = buildShowDict('cutam:fr:francetv', 'slug', {
    name: 'Pinned', logo: 'https://pinned/logo.png',
  }, 'https://fallback/logo.png');
  assert.equal(pinned.id, 'cutam:fr:francetv:slug');
  assert.equal(pinned.type, 'series');
  assert.equal(pinned.logo, 'https://pinned/logo.png');
  assert.equal(pinned.poster, 'https://fallback/logo.png', 'unpinned fields fall back');
  assert.equal(pinned.year, 2024);
  assert.equal(pinned.rating, 'Tous publics');

  const bare = buildShowDict('cutam:ca:cbc', 'x', {}, null, 'G');
  assert.equal(bare.name, 'x', 'the slug stands in for a missing name');
  assert.equal(bare.rating, 'G');
});

test('auth TTLs come from the JWT expiry', () => {
  const makeJwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
  const inTwoHours = Math.floor(Date.now() / 1000) + 7200;
  const ttl = ttlFromJwt(makeJwt(inTwoHours));
  assert.ok(ttl > 7200 - 400 && ttl <= 7200 - 300, `expected ~6900, got ${ttl}`);

  assert.equal(ttlFromJwt(makeJwt(Math.floor(Date.now() / 1000) - 10)), 0, 'expired tokens get 0');
  assert.equal(ttlFromJwt(null), 4 * 3600, 'no token means the default TTL');
  assert.equal(ttlFromJwt('not-a-jwt'), 4 * 3600);
  assert.equal(decodeJwt('garbage'), null);
});

test('the cookie jar scopes cookies by domain', () => {
  const jar = new CookieJar();
  const response = (cookies) => ({ headers: { getSetCookie: () => cookies } });

  jar.store('https://compte.tf1.fr/accounts.webSdkBootstrap', response([
    'gmid=gmid.value; Domain=.tf1.fr; Path=/',
    'sessionOnly=1',
  ]));

  const header = jar.header('https://compte.tf1.fr/accounts.login');
  assert.match(header, /gmid=gmid\.value/, 'a .tf1.fr cookie is sent to compte.tf1.fr');
  assert.match(header, /sessionOnly=1/, 'a host cookie is sent back to its host');
  assert.equal(jar.header('https://example.com/'), null, 'other hosts get nothing');

  jar.store('https://compte.tf1.fr/', response(['gmid=x; Domain=.tf1.fr; Max-Age=0']));
  assert.doesNotMatch(jar.header('https://compte.tf1.fr/') || '', /gmid/, 'Max-Age=0 deletes');
});

test('response schemas project onto the declared fields only', () => {
  const meta = metaPreview({ id: 'x', type: 'series', name: 'N', channel: 'dropped', year: '2019' });
  assert.equal(meta.channel, undefined, 'undeclared fields are dropped');
  assert.equal(meta.year, 2019, 'year is coerced to a number');
  assert.equal(meta.poster, null, 'unset optional fields render as null');

  const streams = streamResponse([{ url: 'https://a/', extra: 'dropped' }]);
  assert.deepEqual(Object.keys(streams), ['streams']);
  assert.equal(streams.streams[0].extra, undefined);
  assert.equal(streams.streams[0].url, 'https://a/');
});

test('programs.json survives a load → dump round-trip byte for byte', () => {
  const raw = fs.readFileSync(getProgramsFilePath(), 'utf-8');
  const data = JSON.parse(raw);
  data.shows = validate(data);
  const dumped = dumpPrograms(data);
  // The editor rewrites the whole file, so its output must re-parse to the
  // same document — that is what keeps a save from losing pinned fields.
  assert.deepEqual(JSON.parse(dumped), JSON.parse(raw));
  assert.ok(!dumped.includes('\r'), 'always LF, never CRLF');
  assert.match(dumped, /^\{\n {2}"version"/);
});

test('the editor rejects malformed show lists', () => {
  assert.throws(() => validate({}), /shows/);
  assert.throws(() => validate({ shows: [{ provider: 'nope', slug: 's', name: 'n' }] }), /unknown provider/);
  assert.throws(() => validate({ shows: [{ provider: 'cbc', slug: '', name: 'n' }] }), /'slug' is required/);
  assert.throws(() => validate({
    shows: [{ provider: 'cbc', slug: 'a', name: 'n' }, { provider: 'cbc', slug: 'a', name: 'm' }],
  }), /duplicate/);

  const kept = validate({ shows: [{ provider: 'cbc', slug: ' a ', name: 'N', poster: 'https://p/' }] });
  assert.deepEqual(kept, [{ provider: 'cbc', slug: 'a', name: 'N', poster: 'https://p/' }]);
});

test('programs.json feeds each provider only its own shows', () => {
  const cbc = getProgramsForProvider('cbc');
  assert.ok(Object.keys(cbc).length > 0);
  for (const [slug, info] of Object.entries(cbc)) {
    assert.equal(info.id, slug);
    assert.equal(info.provider, undefined, 'the provider key is stripped');
  }
  assert.deepEqual(getProgramsForProvider('nonexistent'), {});
});

test('MPD ContentProtection reading finds the KID and the Widevine PSSH', () => {
  const mpd = `<?xml version="1.0"?>
<MPD xmlns:cenc="urn:mpeg:cenc:2013">
  <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"
    cenc:default_KID="f5b25ff2-6238-5eff-9d80-eca8cbf94b09"/>
  <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed">
    <cenc:pssh>AAAAWHBzc2gAAAAA</cenc:pssh>
  </ContentProtection>
  <ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95">
    <cenc:pssh>UExBWVJFQURZ</cenc:pssh>
  </ContentProtection>
</MPD>`;
  const info = extractDrmInfoFromMpd(mpd);
  assert.equal(info.key_id, 'f5b25ff2-6238-5eff-9d80-eca8cbf94b09');
  assert.equal(info.widevine_pssh, 'AAAAWHBzc2gAAAAA');
  assert.equal(info.playready_pssh, 'UExBWVJFQURZ');
  assert.equal(normalizeKeyId(info.key_id), 'f5b25ff262385eff9d80eca8cbf94b09');
});

test('a finished TorBox download is matched by filename', () => {
  const items = [
    { id: 1, download_finished: false, files: [{ id: 0, short_name: 'x.mp4' }] },
    { id: 2, download_finished: true, files: [{ id: 3, short_name: 'wanted.mp4' }] },
  ];
  assert.deepEqual(matchWebdl(items, 'wanted.mp4'), [2, 3]);
  assert.equal(matchWebdl(items, 'x.mp4'), null, 'unfinished downloads do not match');
  assert.deepEqual(
    matchWebdl([{ id: 9, download_present: true, name: 'bare', files: [] }], 'bare.mp4'),
    [9, 0],
    'a download named after the stem matches too',
  );
});

test('France TV image patterns resolve to absolute URLs at the preferred width', () => {
  const patterns = [
    { type: 'vignette_16x9', urls: { 'w:400': '/small.jpg', 'w:1024': '/big.jpg' } },
    { type: 'logo', urls: { 'w:150': '/logo-small.png' } },
  ];
  const extracted = imageExtractor.extract(patterns, { poster: 'vignette_16x9', logo: 'logo' });
  assert.equal(extracted.poster, 'https://www.france.tv/big.jpg', 'the widest preference wins');
  assert.equal(extracted.logo, 'https://www.france.tv/logo-small.png', 'and falls back when absent');
  assert.deepEqual(imageExtractor.extract(patterns, { missing: 'carre' }), {});
});

test('HTML entities in France TV copy are decoded', () => {
  assert.equal(htmlUnescape('Enqu&ecirc;te &amp; d&eacute;bat'), 'Enquête & débat');
  assert.equal(htmlUnescape('&#233;t&#xe9;'), 'été');
  assert.equal(htmlUnescape('a &notanentity; b'), 'a &notanentity; b');
});
