/** Find the subtitle tracks in a DASH manifest and expand them to segment URLs.
 *
 * 6play publishes subtitles as a text AdaptationSet inside the same manifest as
 * the video — `contentType="text"` for replay, `contentType="application"` with
 * `codecs="stpp"` for live — never as the sidecar VTT asset older clients used.
 */

const attrOf = (source, name) => (source.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i')) || [])[1];

/** ISO-8601 duration (`PT1H31M59.840S`) in seconds, or 0. */
export function parseIsoDuration(value) {
  const m = String(value || '').match(/^P(?:.*?T)?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!m) return 0;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

/** Fill `$RepresentationID$`, `$Number$`, `$Time$`, `$Bandwidth$` in a template. */
export function fillTemplate(template, values) {
  return String(template).replace(/\$(\w+)(?:%0(\d+)d)?\$|\$\$/g, (match, name, width) => {
    if (match === '$$') return '$';
    const value = values[name];
    if (value === undefined || value === null) return match;
    return width ? String(value).padStart(Number(width), '0') : String(value);
  });
}

/** Absolute URL for a manifest-relative path. */
function resolveUrl(path, manifestUrl) {
  try {
    return new URL(path, manifestUrl).href;
  } catch {
    return path;
  }
}

/** Expand a SegmentTemplate into the list of media segment URLs. */
function segmentUrls(templateAttrs, timelineXml, representation, manifestUrl, mpdDurationSec) {
  const media = attrOf(templateAttrs, 'media');
  if (!media) return [];

  const timescale = Number(attrOf(templateAttrs, 'timescale') || 1) || 1;
  const startNumber = Number(attrOf(templateAttrs, 'startNumber') ?? 1);
  const values = { RepresentationID: representation.id, Bandwidth: representation.bandwidth };

  const urls = [];
  const timeline = [...(timelineXml || '').matchAll(/<S\b([^>]*?)\/?>/gi)];

  if (timeline.length) {
    let time = 0;
    let number = startNumber;
    for (const [, attrs] of timeline) {
      const t = attrOf(attrs, 't');
      const d = Number(attrOf(attrs, 'd'));
      const repeat = Number(attrOf(attrs, 'r') || 0);
      if (t !== undefined) time = Number(t);
      if (!Number.isFinite(d) || d <= 0) continue;
      // r="-1" means "repeat until the period ends" — only meaningful for live,
      // where the segment list is bounded by the manifest anyway.
      const count = repeat < 0 ? 0 : repeat;
      for (let i = 0; i <= count; i += 1) {
        urls.push({
          url: resolveUrl(fillTemplate(media, { ...values, Time: time, Number: number }), manifestUrl),
          time,
          timeMs: (time / timescale) * 1000,
        });
        time += d;
        number += 1;
      }
    }
    return urls;
  }

  // No timeline: a fixed segment duration covering the whole presentation.
  const duration = Number(attrOf(templateAttrs, 'duration'));
  if (!Number.isFinite(duration) || duration <= 0 || !mpdDurationSec) return [];
  const segmentSec = duration / timescale;
  const count = Math.ceil(mpdDurationSec / segmentSec);
  for (let i = 0; i < count; i += 1) {
    const number = startNumber + i;
    const time = i * duration;
    urls.push({
      url: resolveUrl(fillTemplate(media, { ...values, Time: time, Number: number }), manifestUrl),
      time,
      timeMs: i * segmentSec * 1000,
    });
  }
  return urls;
}

/**
 * Every subtitle track in *mpdXml*.
 *
 * @returns {Array<{lang: string, roles: string[], forced: boolean, segments: Array}>}
 */
export function findTextTracks(mpdXml, manifestUrl) {
  if (!mpdXml) return [];
  const mpdDurationSec = parseIsoDuration(attrOf(mpdXml, 'mediaPresentationDuration'));
  const tracks = [];

  for (const [, attrs, body] of mpdXml.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi)) {
    const contentType = (attrOf(attrs, 'contentType') || '').toLowerCase();
    const mimeType = (attrOf(attrs, 'mimeType') || '').toLowerCase();
    const codecs = `${attrOf(attrs, 'codecs') || ''} ${attrOf(body, 'codecs') || ''}`.toLowerCase();

    const isText = contentType === 'text'
      || mimeType.startsWith('text/')
      || codecs.includes('stpp')
      || codecs.includes('wvtt');
    if (!isText) continue;

    const representation = body.match(/<Representation\b([^>]*)>/i);
    const repAttrs = representation ? representation[1] : '';
    const rep = { id: attrOf(repAttrs, 'id'), bandwidth: attrOf(repAttrs, 'bandwidth') };

    // The template can sit on the AdaptationSet or inside the Representation.
    const templateMatch = body.match(/<SegmentTemplate\b([^>]*?)>([\s\S]*?)<\/SegmentTemplate>/i)
      || body.match(/<SegmentTemplate\b([^>]*?)\/>/i);
    if (!templateMatch) continue;

    const roles = [...body.matchAll(/<Role\b[^>]*value="([^"]*)"/gi)].map((m) => m[1].toLowerCase());
    const segments = segmentUrls(
      templateMatch[1], templateMatch[2] || '', rep, manifestUrl, mpdDurationSec,
    );
    if (!segments.length) continue;

    tracks.push({
      lang: (attrOf(attrs, 'lang') || attrOf(repAttrs, 'lang') || 'und').toLowerCase(),
      roles,
      // EBU calls the hard-of-hearing track "caption"; a plain subtitle track
      // has no caption role. Both are offered, labelled differently.
      hearingImpaired: roles.includes('caption') && /sdh|hoh|_cc/i.test(segments[0].url),
      forced: roles.includes('forced-subtitle') || roles.includes('forced_subtitle'),
      segments,
    });
  }

  return tracks;
}

/** ISO-639-2/B and friends → the 3-letter code Stremio expects. */
export function normaliseLang(lang) {
  const map = { fre: 'fra', fr: 'fra', ger: 'deu', de: 'deu', en: 'eng', es: 'spa', und: 'und' };
  const key = String(lang || '').toLowerCase().split('-')[0];
  return map[key] || key || 'und';
}
