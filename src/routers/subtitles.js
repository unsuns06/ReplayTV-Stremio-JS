/** Serves the WebVTT files advertised in 6play stream responses.
 *
 * The stream response only names a URL; the file is built here, on the first
 * request for it, so pressing play is never slowed down by fetching ninety
 * TTML fragments. The result is cached, so a seek or a re-open is instant.
 */
import express from 'express';

import { getLogger } from '../utils/logger.js';
import { ProviderFactory } from '../providers/factory.js';
import { cache } from '../utils/cache.js';
import { CacheTTL } from '../utils/cacheKeys.js';
import {
  findTextTracks, normaliseLang, buildVttFromTrack, vttCacheKey,
} from '../utils/subtitles/index.js';

export const router = express.Router();
const logger = getLogger('routers.subtitles');

/** An empty but valid cue list — better than a 404 the player cannot explain. */
const EMPTY_VTT = 'WEBVTT\n\n';

/** Match the requested `fra` / `fra-sdh` key against the manifest's tracks. */
function pickTrack(tracks, key) {
  const wantSdh = key.endsWith('-sdh');
  const lang = normaliseLang(key.replace(/-sdh$/, ''));
  return tracks.find((t) => normaliseLang(t.lang) === lang && Boolean(t.hearingImpaired) === wantSdh)
    || tracks.find((t) => normaliseLang(t.lang) === lang)
    || tracks[0]
    || null;
}

router.get('/subtitles/6play/:contentId/:key.vtt', async (req, res) => {
  const { contentId } = req.params;
  const key = req.params.key;

  const cacheKey = vttCacheKey(contentId, key);
  const cached = cache.get(cacheKey);
  if (cached) {
    res.type('text/vtt; charset=utf-8').send(cached);
    return;
  }

  try {
    const provider = ProviderFactory.createProvider('6play', req);
    const manifest = await provider.subtitleManifest(contentId);
    if (!manifest) {
      logger.warning('⚠️ No manifest for subtitle request %s/%s', contentId, key);
      res.type('text/vtt; charset=utf-8').send(EMPTY_VTT);
      return;
    }

    const tracks = findTextTracks(manifest.mpdText, manifest.manifestUrl);
    const track = pickTrack(tracks, key);
    if (!track) {
      res.type('text/vtt; charset=utf-8').send(EMPTY_VTT);
      return;
    }

    // A live manifest is a rolling window whose segment times are wall-clock;
    // shifting to the start of the window is the closest a static file can get
    // to the player's own timeline.
    const isLive = /type\s*=\s*"dynamic"/i.test(manifest.mpdText);
    const offsetMs = isLive ? (track.segments[0]?.timeMs ?? 0) : 0;

    const vtt = await buildVttFromTrack(track, { offsetMs });
    if (!vtt) {
      res.type('text/vtt; charset=utf-8').send(EMPTY_VTT);
      return;
    }

    // A live window moves on; a replay file never changes.
    cache.set(cacheKey, vtt, isLive ? 60 : CacheTTL.STREAM);
    res.type('text/vtt; charset=utf-8').send(vtt);
  } catch (e) {
    logger.exception('❌ Failed to build subtitles for %s/%s', contentId, key, e);
    res.type('text/vtt; charset=utf-8').send(EMPTY_VTT);
  }
});
