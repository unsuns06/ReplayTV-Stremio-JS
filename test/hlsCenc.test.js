import test from 'node:test';
import assert from 'node:assert/strict';

import { rewritePlaylist } from '../src/routers/hlsCenc.js';

const CTX = {
  base: 'https://addon.example',
  mf: { url: 'https://mf.example', password: 'psw' },
  keys: { key_id: 'aabb', key: 'ccdd' },
  mime: 'video/mp4',
};

const MASTER_URL = 'https://vod.dssott.com/ps01/show/master.m3u8';
const MASTER = [
  '#EXTM3U',
  '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES-CTR,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",URI="data:text/plain;base64,AAAA"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",URI="r/audio.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",URI="r/subs.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=2400000',
  'r/video.m3u8',
].join('\n');

const MEDIA_URL = 'https://vod.dssott.com/ps01/show/r/video.m3u8';
const MEDIA = [
  '#EXTM3U',
  '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,KEYFORMAT="PRMNAGRA",URI="data:text/plain;base64,eyJ9"',
  '#EXT-X-MAP:URI="v/map.mp4"',
  '#EXTINF:8.008,',
  'v/pts_0.mp4',
  '#EXT-X-ENDLIST',
].join('\n');

test('master playlist drops the key lines the proxy chokes on', () => {
  const out = rewritePlaylist(MASTER, MASTER_URL, CTX);
  assert.ok(!out.includes('EXT-X-SESSION-KEY'));
  assert.ok(!out.includes('data:text/plain'));
});

test('master routes video and audio through this addon, subtitles through MediaFlow', () => {
  const lines = rewritePlaylist(MASTER, MASTER_URL, CTX).split('\n');
  const video = lines[lines.length - 1];
  assert.ok(video.startsWith('https://addon.example/hls-cenc/playlist.m3u8?'));
  assert.ok(video.includes(`u=${encodeURIComponent('https://vod.dssott.com/ps01/show/r/video.m3u8')}`));
  assert.ok(video.includes('mime=video%2Fmp4'));

  const audio = lines.find((l) => l.includes('TYPE=AUDIO'));
  assert.ok(audio.includes('/hls-cenc/playlist.m3u8?'));
  assert.ok(audio.includes('mime=audio%2Fmp4'));

  // WebVTT is not encrypted, so it skips the decryptor — but it still has to
  // leave via MediaFlow, or the player fetches it from the viewer's own address
  // and Disney's US-only CDN answers 403.
  const subs = lines.find((l) => l.includes('TYPE=SUBTITLES'));
  assert.ok(subs.includes('URI="https://mf.example/proxy/hls/manifest.m3u8?'));
  assert.ok(subs.includes(encodeURIComponent('https://vod.dssott.com/ps01/show/r/subs.m3u8')));
  assert.ok(!subs.includes('/hls-cenc/'));
});

test('media playlist sends every segment to the decrypting endpoint', () => {
  const lines = rewritePlaylist(MEDIA, MEDIA_URL, CTX).split('\n');
  assert.ok(!lines.some((l) => l.startsWith('#EXT-X-KEY')));
  assert.ok(lines.includes('#EXTINF:8.008,'));
  assert.ok(lines.includes('#EXT-X-ENDLIST'));

  // MediaFlow decrypts only a segment's first fragment, so segments are
  // decrypted here instead; only the init still comes from MediaFlow.
  const segment = lines.find((l) => l.startsWith('https://addon.example'));
  const q = new URL(segment).searchParams;
  assert.equal(new URL(segment).pathname, '/hls-cenc/segment.mp4');
  assert.equal(q.get('u'), 'https://vod.dssott.com/ps01/show/r/v/pts_0.mp4');
  assert.equal(q.get('key'), 'ccdd');
});

test('the init stays a separate EXT-X-MAP, so fragments share one timeline', () => {
  const lines = rewritePlaylist(MEDIA, MEDIA_URL, CTX).split('\n');

  const map = lines.find((l) => l.startsWith('#EXT-X-MAP:'));
  const mapUrl = new URL(map.match(/URI="([^"]+)"/)[1]);
  assert.equal(mapUrl.pathname, '/proxy/mpd/init.mp4');
  assert.equal(mapUrl.searchParams.get('init_url'), 'https://vod.dssott.com/ps01/show/r/v/map.mp4');

  // An init concatenated into every fragment makes each one a standalone MP4;
  // the player re-initialises on each and the tracks drift apart.
  assert.ok(!lines.some((l) => l.startsWith('https://') && l.includes('init_url=') && !l.startsWith('#')));
});
