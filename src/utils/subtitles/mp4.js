/** The two bytes of ISO-BMFF this addon needs: find the `mdat` payloads.
 *
 * A DASH subtitle segment is `styp | sidx | moof | mdat`, and the TTML document
 * is the whole `mdat`. Walking top-level boxes is enough — no dependency, no
 * full demuxer.
 */

/** Top-level boxes of *buf* as `{type, start, end}` (payload bounds). */
export function iterBoxes(buf) {
  const boxes = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    let size = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('latin1');
    let header = 8;
    if (size === 1) {
      if (offset + 16 > buf.length) break;
      size = Number(buf.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = buf.length - offset; // "to end of file"
    }
    if (size < header || offset + size > buf.length) break;
    boxes.push({ type, start: offset + header, end: offset + size });
    offset += size;
  }
  return boxes;
}

/** Concatenated `mdat` payloads of a segment. */
export function extractMdat(buf) {
  return iterBoxes(buf)
    .filter((b) => b.type === 'mdat')
    .map((b) => buf.subarray(b.start, b.end));
}

/** Whether *buf* looks like an ISO-BMFF segment (a known box type up front). */
export function looksLikeMp4(buf) {
  if (buf.length < 8) return false;
  return ['styp', 'ftyp', 'moof', 'sidx', 'moov', 'free', 'skip'].includes(
    buf.subarray(4, 8).toString('latin1'),
  );
}

/** Normalise a fetched segment body.
 *
 * The geo proxy is an API Gateway Lambda, which hands binary responses back
 * base64-encoded rather than raw — so a body that is not already a box is
 * decoded once before being parsed.
 */
export function decodeSegmentBody(buf) {
  if (looksLikeMp4(buf)) return buf;
  const decoded = Buffer.from(buf.toString('latin1'), 'base64');
  return looksLikeMp4(decoded) ? decoded : buf;
}
