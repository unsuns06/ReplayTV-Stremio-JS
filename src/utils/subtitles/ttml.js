/** TTML (EBU-TT-D / IMSC1) → WebVTT.
 *
 * 6play ships subtitles as segmented `stpp.ttml.im1t`: each segment's `mdat` is
 * a complete TTML document whose `begin`/`end` are absolute media times, so the
 * segments concatenate without any per-segment offset arithmetic.
 *
 * ponytail: regex over `<p>` elements rather than an XML parser — TTML cue
 * bodies are spans, breaks and text, and that is all that survives the trip to
 * WebVTT anyway. Styling, regions and positioning are dropped on purpose.
 */
import { htmlUnescape } from '../../providers/fr/metadata.js';

/** Parse a TTML time expression into milliseconds, or null.
 *
 * Handles `hh:mm:ss.mmm`, `hh:mm:ss:frames` and offset times (`12.5s`, `300ms`,
 * `10f`, `5t`), which is the full set IMSC1 allows.
 */
export function parseTtmlTime(value, { frameRate = 25, tickRate = 1 } = {}) {
  if (!value) return null;
  const text = String(value).trim();

  const clock = text.match(/^(\d+):(\d{2}):(\d{2})(?:[.,](\d+)|:(\d+(?:\.\d+)?))?$/);
  if (clock) {
    const [, h, m, s, fraction, frames] = clock;
    let ms = ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000;
    if (fraction !== undefined) ms += Number(`0.${fraction}`) * 1000;
    else if (frames !== undefined) ms += (Number(frames) / frameRate) * 1000;
    return Math.round(ms);
  }

  const offset = text.match(/^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/);
  if (offset) {
    const amount = Number(offset[1]);
    switch (offset[2]) {
      case 'h': return Math.round(amount * 3600000);
      case 'm': return Math.round(amount * 60000);
      case 's': return Math.round(amount * 1000);
      case 'ms': return Math.round(amount);
      case 'f': return Math.round((amount / frameRate) * 1000);
      case 't': return Math.round((amount / tickRate) * 1000);
      default: return null;
    }
  }

  return null;
}

/** Cue text from the inner markup of a `<p>`: keep line breaks, drop styling. */
function cueText(inner) {
  const text = inner
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((line) => htmlUnescape(line).replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n') // the source pads short cues with empty <br/> lines
    .trim();
  return text;
}

/** Cues from one TTML document, as `{start, end, text}` in milliseconds. */
export function ttmlToCues(xml) {
  if (!xml) return [];

  const frameRate = Number((xml.match(/ttp:frameRate\s*=\s*"(\d+)"/i) || [])[1]) || 25;
  const tickRate = Number((xml.match(/ttp:tickRate\s*=\s*"(\d+)"/i) || [])[1]) || 1;
  const opts = { frameRate, tickRate };

  const cues = [];
  const paragraphs = xml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi);
  for (const [, attrs, inner] of paragraphs) {
    const attr = (name) => (attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i')) || [])[1];
    const start = parseTtmlTime(attr('begin'), opts);
    if (start === null) continue;
    let end = parseTtmlTime(attr('end'), opts);
    if (end === null) {
      const duration = parseTtmlTime(attr('dur'), opts);
      end = duration === null ? start + 3000 : start + duration;
    }
    const text = cueText(inner);
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

function vttTimestamp(ms) {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3600000);
  const minutes = Math.floor((clamped % 3600000) / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  const millis = clamped % 1000;
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

/** Merge, sort and de-duplicate cues, then render WebVTT.
 *
 * Segments can repeat a cue that straddles their boundary, so identical
 * start/text pairs are collapsed and the longest end wins.
 */
export function cuesToVtt(cues, { offsetMs = 0 } = {}) {
  const byKey = new Map();
  for (const cue of cues) {
    const key = `${cue.start}|${cue.text}`;
    const existing = byKey.get(key);
    if (existing) existing.end = Math.max(existing.end, cue.end);
    else byKey.set(key, { ...cue });
  }

  const ordered = [...byKey.values()].sort((a, b) => a.start - b.start || a.end - b.end);

  const lines = ['WEBVTT', ''];
  ordered.forEach((cue, index) => {
    const start = cue.start - offsetMs;
    const end = cue.end - offsetMs;
    if (end <= 0) return;
    lines.push(String(index + 1));
    lines.push(`${vttTimestamp(start)} --> ${vttTimestamp(end)}`);
    lines.push(cue.text);
    lines.push('');
  });
  return lines.join('\n');
}
