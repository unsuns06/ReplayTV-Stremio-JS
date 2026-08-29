/** ABC's payload parsing: the shapes that differ from every other provider.
 *
 * ABC nests `tvrating`/`duration` in objects and publishes a rolling free
 * window with holes in its episode numbering — both have already been got
 * wrong once, so they are what this pins down.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ABCProvider } from '../src/providers/us/abc.js';

/** One `video` entry as the ABC contents API returns it, trimmed to what is read. */
const VIDEO = {
  id: 'VDKA39918321',
  type: 'lf',
  title: 'Dating in the Wild',
  description: 'An e-compass for finding friends; a no-swipe dating app.',
  longdescription: 'An e-compass for finding friends; a no-swipe dating app; screen protectors.',
  episodenumber: '10',
  season: { num: '17' },
  duration: { unit: 'millisecond', value: '2583030' },
  tvrating: { rating: 'TV-PG', descriptors: 'L' },
  airdates: { airdate: ['Wed, 21 Jan 2026 22:01:00 -0800'] },
  thumbnails: {
    thumbnail: [
      { type: 'main', width: '324', value: 'https://cdn/324.jpg' },
      { type: 'casting-image', width: '952', value: 'https://cdn/952.jpg' },
      { type: 'casting-thumb', width: '113', value: 'https://cdn/113.jpg' },
    ],
  },
};

test('ABC _parseEpisode unwraps the nested rating and duration', async () => {
  const episode = await new ABCProvider()._parseEpisode(VIDEO, 1);

  assert.equal(episode.id, 'cutam:us:abc:episode:VDKA39918321');
  assert.equal(episode.season, 17);
  assert.equal(episode.episode, 10);
  // Milliseconds in, seconds out — and not "[object Object]".
  assert.equal(episode.duration, '2583');
  assert.equal(episode.rating, 'TV-PG');
  assert.equal(episode.broadcast_date, '2026-01-22');
  assert.equal(episode.description, VIDEO.longdescription);
  // Widest published crop wins.
  assert.equal(episode.thumbnail, 'https://cdn/952.jpg');
});

test('ABC _parseEpisode survives a payload with nothing in it', async () => {
  const provider = new ABCProvider();
  assert.equal(await provider._parseEpisode({}, 3), null, 'no video id means no episode');

  const bare = await provider._parseEpisode({ id: 'VDKA1' }, 3);
  assert.equal(bare.season, 1);
  assert.equal(bare.episode, 3, 'falls back to the list position');
  assert.equal(bare.duration, '0');
  assert.equal(bare.rating, ABCProvider.defaultRating);
  assert.equal(bare.released, '');
});

/** A show page cut down to the two things extraction reads: the header logo
 * and the typed image array — including a rail item belonging to another show.
 */
const SHOW_PAGE = `
<h1 class="Header__Logo"><img class="Header__Logo__img" title="Shark Tank"
  src="https://cdn1.edgedatg.com/aws/v2/abc/SharkTank/showimages/aaa/700x234-Q80_aaa.png"/></h1>
{"images":[
{"value":"https://cdn1.edgedatg.com/aws/v2/abc/SharkTank/showimages/bbb/4300x2430-Q80_bbb.jpg","type":"show-background","width":4300,"height":2430},
{"value":"https://cdn1.edgedatg.com/aws/v2/abc/SharkTank/showimages/bbb/1440x812-Q80_bbb.jpg","type":"show-background","width":1440,"height":812},
{"value":"https://cdn1.edgedatg.com/aws/v2/abc/SharkTank/showimages/ddd/1600x900-Q90_ddd.jpg","type":"showdetails","width":1600,"height":900},
{"value":"https://cdn1.edgedatg.com/aws/v2/abc/SharkTank/showimages/ccc/196x261-Q80_ccc.jpg","type":"auth","width":196,"height":261},
{"value":"https://cdn1.edgedatg.com/aws/v2/natgeotv/TucciInItaly/showimages/zzz/454x606-Q80_zzz.jpg","type":"auth","width":454,"height":606},
{"value":"https://cdn1.edgedatg.com/aws/v2/abc/OtherShow/showimages/yyy/700x234-Q80_yyy.png","type":"showLogoCentered","width":700,"height":234}
]}`;

test('ABC artwork is scoped to the show that owns the page', async () => {
  const provider = new ABCProvider();
  provider.apiClient.rawRequest = async () => ({ status: 200, text: async () => SHOW_PAGE });

  const art = await provider._showArtwork('shark-tank');

  assert.equal(art.logo,
    'https://cdn1.edgedatg.com/aws/v2/abc/SharkTank/showimages/aaa/700x234-Q80_aaa.png',
    'the header logo, not another show\'s showLogoCentered');
  // The rail's 454x606 auth image is larger but belongs to a different show.
  assert.match(art.poster, /\/abc\/SharkTank\//);
  // …and the small poster is asked for at a size the grid can use.
  assert.equal(art.poster,
    'https://cdn1.edgedatg.com/aws/v2/abc/SharkTank/showimages/ccc/454x606-Q80_ccc.jpg');
  // `show-background` is bigger and better-named but is ABC's near-black page
  // wash; the key art is what a Stremio detail page needs to look like anything.
  assert.equal(art.background,
    'https://cdn1.edgedatg.com/aws/v2/abc/SharkTank/showimages/ddd/1600x900-Q90_ddd.jpg');
  assert.ok(!/show-background|\/bbb\//.test(art.background), 'never the page backdrop');
});

test('ABC falls back to the catalogue crop when the page yields nothing', async () => {
  const provider = new ABCProvider();
  provider.apiClient.rawRequest = async () => ({ status: 404, text: async () => '' });
  assert.equal(await provider._showArtwork('nope'), null);

  // No header logo means no way to tell whose art is whose — refuse rather than guess.
  provider.apiClient.rawRequest = async () => ({ status: 200, text: async () => SHOW_PAGE.split('</h1>')[1] });
  assert.equal(await provider._showArtwork('headerless'), null);
});

test('ABC keeps the holes in its free-window numbering', async () => {
  const provider = new ABCProvider();
  // The free window is a rolling subset: S17 currently skips episode 7.
  const numbers = [10, 9, 8, 6, 5];
  provider.shows = { 'shark-tank': { id: 'shark-tank' } };
  provider._fetchEpisodesRaw = async () => numbers.map((n) => ({
    ...VIDEO, id: `VDKA${n}`, episodenumber: String(n),
  }));

  const episodes = await provider.getEpisodes('cutam:us:abc:shark-tank');
  assert.deepEqual(episodes.map((e) => e.episode), [5, 6, 8, 9, 10],
    'sorted ascending, never renumbered 1..n');
});

/** The Widevine license call: the two things ABC's endpoint rejects it over.
 *
 * `apiClient.post` JSON-encodes whatever it is handed, which turns the binary
 * challenge into `{"type":"Buffer",…}` (400 bad-license-request), and BAM
 * refuses an anonymous token on its own (403 not-entitled) unless the
 * playback response's rights JWT rides along.
 */
test('ABC posts the license challenge as raw bytes', async () => {
  const provider = new ABCProvider();
  let sent = null;
  provider.apiClient.rawRequest = async (method, url, options) => {
    sent = { method, url, options };
    return { status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  };

  await provider._extractDrmKeys(
    'AAAAMnBzc2gAAAAA7e+LqXnWSs6jyCfc1R0h7QAAABISELkMLDGdCUv3q2dDyFAtoGY=',
    'https://license.example/obtain-license',
    { Authorization: 'Bearer tok', 'x-playback-rights-authorization': 'rights-jwt' },
  );

  assert.ok(sent, 'the license request went out');
  assert.equal(sent.method, 'POST');
  assert.ok(Buffer.isBuffer(sent.options.body) || sent.options.body instanceof Uint8Array,
    'the challenge is raw protobuf, never a JSON-encoded Buffer');
  assert.equal(sent.options.headers['x-playback-rights-authorization'], 'rights-jwt');
});

test('ABC carries the playback rights JWT into the license headers', async () => {
  const provider = new ABCProvider();
  provider._checkProcessedFile = async () => [];
  provider._playbackToken = async () => 'pbtoken';
  provider._accessToken = async () => 'access';
  provider.apiClient.post = async () => ({
    stream: {
      sources: [{ complete: { url: 'https://cdn.example/master.m3u8' } }],
      playbackRights: { playbackRightsContext: 'rights-jwt' },
    },
  });
  provider._extractPsshFromHls = async () => null;

  const [stream] = await provider.getEpisodeStreamUrl('cutam:us:abc:episode:VDKA1');

  assert.equal(stream.licenseHeaders['x-playback-rights-authorization'], 'rights-jwt',
    'without it BAM answers 403 not-entitled');
});
