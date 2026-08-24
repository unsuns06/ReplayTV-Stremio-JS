/** The 6play subtitle pipeline: manifest → segments → TTML → WebVTT.
 *
 * All offline. Segment bodies are synthesised as real ISO-BMFF boxes so the
 * parsing is exercised for real, not mocked away.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { iterBoxes, extractMdat, looksLikeMp4, decodeSegmentBody } from '../src/utils/subtitles/mp4.js';
import { parseTtmlTime, ttmlToCues, cuesToVtt } from '../src/utils/subtitles/ttml.js';
import { findTextTracks, normaliseLang, fillTemplate, parseIsoDuration } from '../src/utils/subtitles/dashText.js';
import { createApp } from '../src/app.js';
import { cache } from '../src/utils/cache.js';
import { CacheKeys } from '../src/utils/cacheKeys.js';

/** Build a `size|type|payload` box. */
function box(type, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

/** A subtitle segment shaped like the ones 6play serves. */
function segment(ttml) {
  return Buffer.concat([
    box('styp', Buffer.from('iso6iso6msdhmsix', 'latin1')),
    box('sidx', Buffer.alloc(32)),
    box('moof', Buffer.alloc(48)),
    box('mdat', Buffer.from(ttml, 'utf-8')),
  ]);
}

const TTML_DOC = `<?xml version="1.0" encoding="utf-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="fr" ttp:timeBase="media">
<body><div>
<p begin="00:01:00.000" end="00:01:00.200" region="bottomAligned" xml:id="sub23"><span style="CyanOnBlack">chaque année</span><br /><span style="CyanOnBlack">plus de 3 millions de touristes.</span><br /><br /></p>
<p begin="00:01:01.960" end="00:01:05.120"><span>Mais à cause de l&apos;inflation,</span><br /><br /></p>
</div></body></tt>`;

test('ISO-BMFF box walking finds the mdat payload', () => {
  const buf = segment('hello');
  const types = iterBoxes(buf).map((b) => b.type);
  assert.deepEqual(types, ['styp', 'sidx', 'moof', 'mdat']);
  assert.equal(extractMdat(buf).map((b) => b.toString()).join(''), 'hello');

  assert.equal(looksLikeMp4(buf), true);
  assert.equal(looksLikeMp4(Buffer.from('not an mp4 at all')), false);
  // A truncated box must not loop or throw.
  assert.deepEqual(iterBoxes(buf.subarray(0, 6)), []);
});

test('64-bit box sizes are handled', () => {
  const payload = Buffer.from('big');
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0); // size == 1 -> largesize follows the type
  header.write('mdat', 4, 'latin1');
  header.writeBigUInt64BE(BigInt(16 + payload.length), 8);
  const buf = Buffer.concat([header, payload]);
  assert.equal(extractMdat(buf).map((b) => b.toString()).join(''), 'big');
});

test('a base64-wrapped segment body is decoded', () => {
  // The geo proxy is an API Gateway Lambda: it hands binary back as base64.
  const raw = segment(TTML_DOC);
  const wrapped = Buffer.from(raw.toString('base64'), 'latin1');
  assert.equal(looksLikeMp4(wrapped), false, 'the wrapped body is not a segment yet');
  const decoded = decodeSegmentBody(wrapped);
  assert.equal(looksLikeMp4(decoded), true);
  assert.deepEqual(extractMdat(decoded)[0].toString('utf-8'), TTML_DOC);
  // An already-raw body passes through untouched.
  assert.deepEqual(decodeSegmentBody(raw), raw);
});

test('TTML time expressions parse to milliseconds', () => {
  assert.equal(parseTtmlTime('00:01:00.000'), 60000);
  assert.equal(parseTtmlTime('01:31:59.640'), 5519640);
  assert.equal(parseTtmlTime('00:00:01,500'), 1500, 'comma decimal separator');
  assert.equal(parseTtmlTime('00:00:02:12', { frameRate: 25 }), 2480, 'frames');
  assert.equal(parseTtmlTime('12.5s'), 12500);
  assert.equal(parseTtmlTime('300ms'), 300);
  assert.equal(parseTtmlTime('2m'), 120000);
  assert.equal(parseTtmlTime('50t', { tickRate: 100 }), 500);
  assert.equal(parseTtmlTime(''), null);
  assert.equal(parseTtmlTime('nonsense'), null);
});

test('TTML cues keep line breaks and lose styling', () => {
  const cues = ttmlToCues(TTML_DOC);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], {
    start: 60000,
    end: 60200,
    text: 'chaque année\nplus de 3 millions de touristes.',
  });
  // Entities decoded, padding <br/> dropped
  assert.equal(cues[1].text, "Mais à cause de l'inflation,");
  assert.equal(ttmlToCues('').length, 0);
  assert.equal(ttmlToCues('<tt><body/></tt>').length, 0);
});

test('a cue without an end falls back to dur, then to a default', () => {
  const withDur = ttmlToCues('<p begin="1s" dur="4s">x</p>');
  assert.deepEqual(withDur[0], { start: 1000, end: 5000, text: 'x' });
  const withNeither = ttmlToCues('<p begin="1s">x</p>');
  assert.equal(withNeither[0].end, 4000);
});

test('WebVTT output is ordered, de-duplicated and offset-able', () => {
  const vtt = cuesToVtt([
    { start: 5000, end: 6000, text: 'second' },
    { start: 1000, end: 2000, text: 'first' },
    // The same cue can appear in two segments when it straddles the boundary;
    // the longer end must win and only one cue survive.
    { start: 1000, end: 2500, text: 'first' },
  ]);
  assert.match(vtt, /^WEBVTT\n/);
  assert.equal((vtt.match(/-->/g) || []).length, 2);
  assert.match(vtt, /00:00:01\.000 --> 00:00:02\.500\nfirst/);
  assert.ok(vtt.indexOf('first') < vtt.indexOf('second'), 'cues are sorted by start');

  // Live: shift the window back to zero, dropping anything before it.
  const shifted = cuesToVtt([
    { start: 100000, end: 101000, text: 'dropped' },
    { start: 160000, end: 161000, text: 'kept' },
  ], { offsetMs: 160000 });
  assert.doesNotMatch(shifted, /dropped/);
  assert.match(shifted, /00:00:00\.000 --> 00:00:01\.000\nkept/);
});

test('SegmentTemplate placeholders are filled', () => {
  assert.equal(fillTemplate('a-$RepresentationID$-$Time$.dash', { RepresentationID: 'x', Time: 42 }), 'a-x-42.dash');
  assert.equal(fillTemplate('s_$Number%05d$.mp4', { Number: 7 }), 's_00007.mp4');
  assert.equal(fillTemplate('cost $$5', {}), 'cost $5', '$$ is a literal dollar');
  assert.equal(fillTemplate('keep-$Unknown$', {}), 'keep-$Unknown$');
  assert.equal(parseIsoDuration('PT1H31M59.840S'), 5519.84);
  assert.equal(parseIsoDuration('garbage'), 0);
});

const REPLAY_MPD = `<MPD type="static" mediaPresentationDuration="PT0H3M0.000S">
 <Period>
  <AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v"/></AdaptationSet>
  <AdaptationSet id="3" contentType="text" lang="fra" mimeType="application/mp4" codecs="stpp.ttml.im1t">
   <Role schemeIdUri="urn:mpeg:dash:role:2011" value="caption"/>
   <Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/>
   <Representation id="textstream_fra=1000" bandwidth="1000">
    <SegmentTemplate timescale="1000" initialization="/sub_sdh_fra-$RepresentationID$.dash" media="/sub_sdh_fra-$RepresentationID$-$Time$.dash">
     <SegmentTimeline><S t="0" d="60000" r="1"/><S d="59640"/></SegmentTimeline>
    </SegmentTemplate>
   </Representation>
  </AdaptationSet>
 </Period>
</MPD>`;

const LIVE_MPD = `<MPD type="dynamic">
 <Period>
  <AdaptationSet contentType="application" mimeType="application/mp4" codecs="stpp" lang="fra">
   <Role schemeIdUri="urn:mpeg:dash:role:2011" value="caption"/>
   <Representation id="subtitles_fr_hoh_ttml">
    <SegmentTemplate timescale="50000" startNumber="10" media="segment_$RepresentationID$_$Number$.mp4">
     <SegmentTimeline><S t="1000" d="100000" r="2"/></SegmentTimeline>
    </SegmentTemplate>
   </Representation>
  </AdaptationSet>
  <AdaptationSet contentType="application" mimeType="application/mp4" codecs="stpp" lang="fre">
   <Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/>
   <Representation id="subtitles_fr_ttml">
    <SegmentTemplate timescale="50000" startNumber="10" media="segment_$RepresentationID$_$Number$.mp4">
     <SegmentTimeline><S t="1000" d="100000" r="2"/></SegmentTimeline>
    </SegmentTemplate>
   </Representation>
  </AdaptationSet>
 </Period>
</MPD>`;

test('a replay manifest yields one SDH track with $Time$ segments', () => {
  const tracks = findTextTracks(REPLAY_MPD, 'https://cdn.example/a/b/manifest.mpd');
  assert.equal(tracks.length, 1);
  const [track] = tracks;
  assert.equal(track.lang, 'fra');
  assert.deepEqual(track.roles, ['caption', 'subtitle']);
  assert.equal(track.hearingImpaired, true, 'the sdh filename marks it as hard-of-hearing');
  // <S t=0 d=60000 r=1> is two segments, plus the trailing one.
  assert.equal(track.segments.length, 3);
  assert.deepEqual(track.segments.map((s) => s.time), [0, 60000, 120000]);
  assert.equal(track.segments[1].url, 'https://cdn.example/sub_sdh_fra-textstream_fra=1000-60000.dash');
  assert.equal(track.segments[1].timeMs, 60000);
});

test('a live manifest yields both tracks with $Number$ segments', () => {
  const tracks = findTextTracks(LIVE_MPD, 'https://live.example/x/dash-short-hd.mpd');
  assert.equal(tracks.length, 2);

  const [sdh, plain] = tracks;
  assert.equal(sdh.hearingImpaired, true);
  assert.equal(plain.hearingImpaired, false);
  assert.equal(normaliseLang(plain.lang), 'fra', 'the fre code normalises to fra');

  // startNumber=10 and three segments from r="2"
  assert.deepEqual(sdh.segments.map((s) => s.url.split('_').pop()), ['10.mp4', '11.mp4', '12.mp4']);
  assert.equal(sdh.segments[0].url, 'https://live.example/x/segment_subtitles_fr_hoh_ttml_10.mp4');
  // timescale 50000: the wall-clock start converts to milliseconds
  assert.equal(sdh.segments[0].timeMs, 20);
});

test('manifests with no text track yield nothing', () => {
  assert.deepEqual(findTextTracks('<MPD><AdaptationSet contentType="video"/></MPD>', 'https://x/'), []);
  assert.deepEqual(findTextTracks('', 'https://x/'), []);
  assert.deepEqual(findTextTracks(null, 'https://x/'), []);
});

test('the subtitles route builds a VTT from the manifest it was given', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  // Seed what a stream resolution would have cached.
  cache.set(
    CacheKeys.providerResource('6play', 'subs_manifest:test-episode'),
    { manifestUrl: 'https://cdn.example/a/b/manifest.mpd', mpdText: REPLAY_MPD },
    600,
  );

  const server = createApp().listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Every segment answers with the same TTML document, base64-wrapped the way
  // the geo proxy delivers it. Requests to our own server must still go
  // through, or the test client would be talking to the stub.
  const wrapped = Buffer.from(segment(TTML_DOC).toString('base64'), 'latin1');
  let fetched = 0;
  globalThis.fetch = async (url, init) => {
    const target = typeof url === 'string' ? url : url.url;
    if (target.startsWith(base)) return realFetch(url, init);
    fetched += 1;
    return new Response(wrapped, { status: 200 });
  };

  const res = await fetch(`${base}/subtitles/6play/test-episode/fra-sdh.vtt`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/vtt/);
  const vtt = await res.text();

  assert.equal(fetched, 3, 'one request per segment');
  assert.match(vtt, /^WEBVTT/);
  // The same document in all three segments collapses to its two unique cues.
  assert.equal((vtt.match(/-->/g) || []).length, 2);
  assert.match(vtt, /chaque année\nplus de 3 millions de touristes\./);

  // Second request is served from cache, with no further segment fetches.
  const before = fetched;
  const again = await fetch(`${base}/subtitles/6play/test-episode/fra-sdh.vtt`);
  assert.equal(await again.text(), vtt);
  assert.equal(fetched, before, 'the built file is cached');
});

test('an unknown subtitle request answers with an empty but valid VTT', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const server = createApp().listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Offline: the re-resolve attempt must fail fast rather than hit 6play.
  globalThis.fetch = async (url, init) => {
    const target = typeof url === 'string' ? url : url.url;
    if (target.startsWith(base)) return realFetch(url, init);
    return new Response('nope', { status: 404 });
  };

  // No cached manifest and a nonsense id: the route must not 500, and must not
  // hand the player something it cannot parse.
  const res = await fetch(`${base}/subtitles/6play/definitely-not-an-episode/fra.vtt`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /^WEBVTT/);
});
