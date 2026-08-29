/** Playable HLS for the CENC-encrypted CMAF that Disney Streaming serves ABC.
 *
 * MediaFlow cannot carry this stream on its own, in two separate ways:
 *
 *  - Its `/proxy/hls` endpoints know nothing about CENC. They accept no
 *    `key_id`/`key` and rewrite every `#EXT-X-KEY` URI into a segment fetch,
 *    including the `data:text/plain;base64,…` ones Disney uses — the wall of
 *    "Client error downloading data:text/plain…" and 502s in the proxy log.
 *  - Its `/proxy/mpd/segment.mp4` endpoint does decrypt CENC, but only the
 *    first fragment of a segment, repeating it to fill the length. Disney
 *    chunks each 8s segment into about seven fragments, so that delivers 1.4s
 *    of video per 8s slot while the audio — one fragment per segment — arrives
 *    whole, and the two drift apart.
 *
 * So the playlists are rewritten here: the key lines are dropped, the init
 * still comes from MediaFlow (which strips the `sinf` protection scheme
 * correctly), and the segments are fetched and decrypted in this process.
 */
import express from 'express';

import { getLogger } from '../utils/logger.js';
import { getBaseUrl } from '../utils/baseUrl.js';
import { loadCredentials } from '../utils/credentials.js';
import { getRandomWindowsUA } from '../utils/userAgent.js';
import { decryptCencSegment } from '../utils/drm/cencDecrypt.js';
import { buildMediaflowUrl } from '../utils/mediaflow.js';

export const router = express.Router();
const logger = getLogger('routers.hlsCenc');

export const CENC_PLAYLIST_PATH = '/hls-cenc/playlist.m3u8';
export const CENC_SEGMENT_PATH = '/hls-cenc/segment.mp4';

// ponytail: one CDN family, because that is the only one that needs this.
// Widen the list when another provider hits the same MediaFlow gap.
const ALLOWED_HOSTS = /(^|\.)dssott\.com$/;

const MIME_TYPES = new Set(['video/mp4', 'audio/mp4']);

/** Public URL of the rewritten playlist for *playlistUrl*. */
export function buildCencPlaylistUrl(baseUrl, playlistUrl, { key_id: keyId, key }, mime = 'video/mp4') {
  const q = new URLSearchParams({
    u: playlistUrl, key_id: keyId, key, mime,
  });
  return `${baseUrl.replace(/\/+$/, '')}${CENC_PLAYLIST_PATH}?${q}`;
}

export function mediaflowConfig() {
  const creds = loadCredentials().mediaflow || {};
  return {
    url: (process.env.MEDIAFLOW_PROXY_URL || creds.url || '').replace(/\/+$/, ''),
    password: process.env.MEDIAFLOW_API_PASSWORD || creds.password || '',
  };
}

/** MediaFlow's decrypted init for one rendition.
 *
 * Only the init: it is one small request per rendition, and MediaFlow already
 * rewrites `encv`/`enca` back to their plain sample entries there. Segments go
 * through this addon instead, because MediaFlow drops all but their first
 * fragment.
 */
function initUrl(mf, init, mime, keys) {
  const q = new URLSearchParams({
    init_url: init, mime_type: mime, key_id: keys.key_id, key: keys.key, api_password: mf.password,
  });
  return `${mf.url}/proxy/mpd/init.mp4?${q}`;
}

const segmentUrl = (base, segment, keys) => `${base.replace(/\/+$/, '')}${CENC_SEGMENT_PATH}?${
  new URLSearchParams({ u: segment, key: keys.key })}`;

/** Subtitles through MediaFlow untouched, audio through the decryptor.
 *
 * WebVTT is in the clear, so a segment decryptor would only corrupt it — but
 * leaving the rendition pointing at Disney's CDN made it the one asset the
 * player fetched on its own, from wherever the viewer happens to be. That CDN
 * answers only US addresses, so everyone outside the US got a silent 403 and no
 * subtitle track while the video (proxied) played fine. MediaFlow's plain HLS
 * proxy is the addon's US egress and is enough here precisely because there is
 * no CENC in the way.
 */
function subtitleUrl(mf, url) {
  if (!mf.url) return url;
  return buildMediaflowUrl({
    baseUrl: mf.url,
    password: mf.password,
    destinationUrl: url,
    endpoint: '/proxy/hls/manifest.m3u8',
    requestHeaders: { referer: 'https://abc.com' },
  });
}

function rewriteMediaTag(line, absolute, ctx) {
  const uri = line.match(/URI="([^"]+)"/);
  if (!uri) return line;
  const target = /TYPE=AUDIO/.test(line)
    ? buildCencPlaylistUrl(ctx.base, absolute(uri[1]), ctx.keys, 'audio/mp4')
    : subtitleUrl(ctx.mf, absolute(uri[1]));
  return line.replace(/URI="[^"]+"/, `URI="${target}"`);
}

/** Rewrite one master or media playlist. Exported for the tests. */
export function rewritePlaylist(text, playlistUrl, ctx) {
  const absolute = (uri) => new URL(uri, playlistUrl).toString();
  const isMaster = text.includes('#EXT-X-STREAM-INF');
  const out = [];

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    // Key lines only ask the player to do DRM that is already done for it.
    if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-SESSION-KEY')) continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      const uri = line.match(/URI="([^"]+)"/);
      if (!uri) continue;
      out.push(`#EXT-X-MAP:URI="${initUrl(ctx.mf, absolute(uri[1]), ctx.mime, ctx.keys)}"`);
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA:')) {
      out.push(rewriteMediaTag(line, absolute, ctx));
      continue;
    }
    if (!line.trim() || line.startsWith('#')) {
      out.push(line);
      continue;
    }
    out.push(isMaster
      ? buildCencPlaylistUrl(ctx.base, absolute(line), ctx.keys, 'video/mp4')
      : segmentUrl(ctx.base, absolute(line), ctx.keys));
  }
  return out.join('\n');
}

/** The `u` parameter is player-supplied: keep it pointed at the CDN it exists for. */
function allowedTarget(u) {
  let target;
  try {
    target = new URL(u);
  } catch {
    return null;
  }
  return target.protocol === 'https:' && ALLOWED_HOSTS.test(target.hostname) ? target : null;
}

async function fetchUpstream(url) {
  const upstream = await fetch(url, {
    headers: { 'user-agent': getRandomWindowsUA(), referer: 'https://abc.com' },
    signal: AbortSignal.timeout(20000),
  });
  if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
  return upstream;
}

router.get(CENC_PLAYLIST_PATH, async (req, res) => {
  const { u, key_id: keyId, key } = req.query;
  const mime = MIME_TYPES.has(req.query.mime) ? req.query.mime : 'video/mp4';
  if (!u || !keyId || !key) {
    res.status(400).send('u, key_id and key are required');
    return;
  }
  if (!allowedTarget(u)) {
    res.status(400).send('u must be an https URL on a supported CDN');
    return;
  }

  const mf = mediaflowConfig();
  if (!mf.url) {
    res.status(503).send('MediaFlow is not configured');
    return;
  }

  let text;
  try {
    text = await (await fetchUpstream(u)).text();
  } catch (exc) {
    logger.error('❌ Playlist fetch failed: %s', exc.message);
    res.status(502).send('upstream playlist unavailable');
    return;
  }

  res.type('application/vnd.apple.mpegurl').send(rewritePlaylist(text, u, {
    base: getBaseUrl(req), mf, keys: { key_id: keyId, key }, mime,
  }));
});

router.get(CENC_SEGMENT_PATH, async (req, res) => {
  const { u, key } = req.query;
  if (!u || !key) {
    res.status(400).send('u and key are required');
    return;
  }
  if (!allowedTarget(u)) {
    res.status(400).send('u must be an https URL on a supported CDN');
    return;
  }

  try {
    const upstream = await fetchUpstream(u);
    const encrypted = Buffer.from(await upstream.arrayBuffer());
    res.type('video/mp4').send(decryptCencSegment(encrypted, key));
  } catch (exc) {
    logger.error('❌ Segment failed: %s', exc.message);
    res.status(502).send('segment unavailable');
  }
});
