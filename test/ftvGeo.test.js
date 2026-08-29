/** The France TV geo route: manifest rewriting and the host guard.
 *
 * No network calls — `rewriteMpd` is pure, and the guard cases are requests the
 * addon must refuse before it ever reaches out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { rewriteMpd, buildFtvManifestUrl, FTV_SEGMENT_PATH } from '../src/routers/ftvGeo.js';

const ADDON = 'https://addon.example';
const LIVE_URL = 'https://simulcast-p.ftven.fr/TOKEN/simulcast/France_2/dash_fr2/France_2.mpd?hdnea=exp=1~hmac=ab';
const REPLAY_URL = 'https://cloudreplay.ftven.fr/ftv/b/7c/x/show_TA.ism/manifest.mpd?hdnea=exp=1~hmac=cd';

const LIVE_MPD = '<?xml version="1.0"?>\n<MPD type="dynamic" profiles="urn:mpeg:dash:profile:isoff-live:2011">\n  <Period id="1" />\n</MPD>';
const REPLAY_MPD = '<?xml version="1.0"?>\n<MPD type="static">\n  <BaseURL>dash/</BaseURL>\n  <Period id="1" />\n</MPD>';

/** The CDN base and query the segment route will rebuild from a rewritten MPD. */
function decodeBaseUrl(xml) {
  const href = xml.match(/<BaseURL>([^<]*)<\/BaseURL>/)[1];
  const context = href.slice(href.indexOf(`${FTV_SEGMENT_PATH}/`) + FTV_SEGMENT_PATH.length + 1).replace(/\/$/, '');
  const [base, search] = Buffer.from(context, 'base64url').toString().split('\n');
  return { base, search };
}

test('a live manifest gets a BaseURL it did not have', () => {
  const out = rewriteMpd(LIVE_MPD, LIVE_URL, ADDON);
  const href = out.match(/<BaseURL>([^<]*)<\/BaseURL>/)[1];
  assert.ok(href.startsWith(`${ADDON}${FTV_SEGMENT_PATH}/`));
  assert.ok(href.endsWith('/'), 'a BaseURL the player appends to must end in a slash');

  const { base, search } = decodeBaseUrl(out);
  assert.equal(base, 'https://simulcast-p.ftven.fr/TOKEN/simulcast/France_2/dash_fr2/');
  // The signature travels in the context, never in the URL the player builds.
  assert.equal(search, '?hdnea=exp=1~hmac=ab');
  assert.ok(!href.includes('hdnea'));
});

test("a replay's relative BaseURL is resolved, not stacked", () => {
  const out = rewriteMpd(REPLAY_MPD, REPLAY_URL, ADDON);
  assert.equal(out.match(/<BaseURL>/g).length, 1, 'the original BaseURL must be replaced, not joined');

  const { base } = decodeBaseUrl(out);
  // 'dash/' resolved against the manifest's own directory — if it were left in
  // the manifest as well the player would ask for .../dash/dash/<segment>.
  assert.equal(base, 'https://cloudreplay.ftven.fr/ftv/b/7c/x/show_TA.ism/dash/');
  assert.ok(!out.includes('<BaseURL>dash/</BaseURL>'));
});

test('the manifest URL carries the signed source verbatim', () => {
  const built = buildFtvManifestUrl(ADDON, LIVE_URL);
  assert.equal(new URL(built).searchParams.get('u'), LIVE_URL);
});

test('the route fetches nothing outside the France TV CDNs', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const bad of [
      'https://evil.example/manifest.mpd',
      'http://simulcast-p.ftven.fr/x.mpd', // not https
      'https://ftven.fr.evil.example/x.mpd', // suffix must be a real label
      'file:///etc/passwd',
    ]) {
      const r = await fetch(`${base}/ftv/manifest.mpd?u=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 400, `should refuse ${bad}`);
    }
    const missing = await fetch(`${base}/ftv/manifest.mpd`);
    assert.equal(missing.status, 400);
  } finally {
    server.close();
    await new Promise((resolve) => server.once('close', resolve));
  }
});
