/** Build a WebVTT file from a DASH manifest's segmented TTML subtitle track.
 *
 * Stremio wants a subtitle URL it can fetch once; DASH publishes a few dozen
 * TTML fragments. This fetches them (through the geo proxy, since the CDN is
 * France-only), unwraps each `mdat`, and concatenates the cues.
 */
import { getLogger } from '../logger.js';
import { cache } from '../cache.js';
import { getProxyConfig } from '../proxyConfig.js';
import { extractMdat, decodeSegmentBody } from './mp4.js';
import { ttmlToCues, cuesToVtt } from './ttml.js';
import { findTextTracks, normaliseLang } from './dashText.js';

const logger = getLogger('utils.subtitles');

/** Segments fetched at once. The CDN is fine with it and 90 serial round trips
 *  through the proxy would take a minute. */
const SEGMENT_CONCURRENCY = 8;
const SEGMENT_TIMEOUT_MS = 20_000;

/** Fetch one segment, through the geo proxy when one is configured. */
async function fetchSegment(url, proxyBase) {
  const target = proxyBase ? proxyBase + encodeURIComponent(url) : url;
  const response = await fetch(target, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: '*/*',
    },
    signal: AbortSignal.timeout(SEGMENT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return decodeSegmentBody(Buffer.from(await response.arrayBuffer()));
}

/** Map *fn* over *items*, at most *limit* at a time, keeping order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Fetch every segment of *track* and render one WebVTT document.
 *
 * A segment that fails is skipped rather than failing the whole file — losing
 * one minute of subtitles beats losing all of them.
 */
export async function buildVttFromTrack(track, { offsetMs = 0 } = {}) {
  const proxyBase = getProxyConfig().getProxy('fr_default');
  let failed = 0;

  const cueGroups = await mapLimit(track.segments, SEGMENT_CONCURRENCY, async (segment) => {
    try {
      const body = await fetchSegment(segment.url, proxyBase);
      const documents = extractMdat(body);
      if (!documents.length) return [];
      return documents.flatMap((doc) => ttmlToCues(doc.toString('utf-8')));
    } catch (e) {
      failed += 1;
      logger.debug('subtitles: segment failed (%s): %s', segment.url.slice(-40), e.message);
      return [];
    }
  });

  const cues = cueGroups.flat();
  if (failed) {
    logger.warning('⚠️ subtitles: %d/%d segment(s) failed', failed, track.segments.length);
  }
  if (!cues.length) return null;

  logger.info('✅ subtitles: %d cues from %d segment(s) [%s]', cues.length, track.segments.length, track.lang);
  return cuesToVtt(cues, { offsetMs });
}

/**
 * Subtitle tracks advertised by a manifest, ready to be listed in a stream.
 *
 * @returns {Array<{lang: string, label: string, hearingImpaired: boolean}>}
 */
export function describeTracks(mpdXml, manifestUrl) {
  return findTextTracks(mpdXml, manifestUrl).map((track) => ({
    lang: normaliseLang(track.lang),
    hearingImpaired: track.hearingImpaired,
    forced: track.forced,
  }));
}

/** Pick the track matching *lang* (and SDH preference), or the first one. */
export function selectTrack(tracks, lang) {
  if (!tracks.length) return null;
  if (!lang) return tracks[0];
  const wanted = normaliseLang(lang);
  return tracks.find((t) => normaliseLang(t.lang) === wanted) || tracks[0];
}

/** Cache key for a built VTT. */
export const vttCacheKey = (id, lang) => `subtitles:vtt:${id}:${lang}`;

export { findTextTracks, normaliseLang, cache };
