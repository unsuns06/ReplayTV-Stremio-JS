/** In-place CENC (AES-CTR) decryption of a CMAF segment.
 *
 * MediaFlow's `/proxy/mpd/segment.mp4` decrypts only the first fragment of a
 * segment and repeats it to fill the length — harmless for the one-fragment-
 * per-segment DASH it was written for, fatal for Disney, who chunk each 8s
 * segment into ~7 fragments. The player then got 1.4s of video per 8s slot and
 * fell steadily behind the audio, which is one fragment per segment and so
 * came through intact.
 *
 * Only `mdat` bytes are rewritten. `senc`/`saiz`/`saio` are left where they
 * are: the init MediaFlow serves has already dropped the `sinf` protection
 * scheme, so with no scheme and no `tenc` key a demuxer never consults them,
 * and leaving them means no box needs resizing and no `trun` data offset needs
 * fixing up.
 */
import crypto from 'node:crypto';

/** Walk the boxes between *start* and *end*, yielding each header. */
function* boxes(buf, start = 0, end = buf.length) {
  let offset = start;
  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) return;
      size = Number(buf.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) return;
    yield {
      type: buf.toString('latin1', offset + 4, offset + 8),
      start: offset,
      size,
      body: offset + header,
    };
    offset += size;
  }
}

const children = (buf, box, type) => [...boxes(buf, box.body, box.start + box.size)]
  .filter((b) => b.type === type);

const child = (buf, box, type) => children(buf, box, type)[0] || null;

/** Sample sizes and the offset their bytes start at, from `tfhd` + `trun`. */
function parseRun(buf, traf, trun, moofStart) {
  const tfhd = child(buf, traf, 'tfhd');
  const tfhdFlags = buf.readUInt32BE(tfhd.body) & 0xffffff;
  let p = tfhd.body + 8;
  let base = null;
  if (tfhdFlags & 0x1) { base = Number(buf.readBigUInt64BE(p)); p += 8; }
  if (tfhdFlags & 0x2) p += 4;
  if (tfhdFlags & 0x8) p += 4;
  const defaultSize = (tfhdFlags & 0x10) ? buf.readUInt32BE(p) : 0;

  const flags = buf.readUInt32BE(trun.body) & 0xffffff;
  const count = buf.readUInt32BE(trun.body + 4);
  let o = trun.body + 8;
  let dataOffset = 0;
  if (flags & 0x1) { dataOffset = buf.readInt32BE(o); o += 4; }
  if (flags & 0x4) o += 4;

  const stride = ((flags & 0x100) ? 4 : 0) + ((flags & 0x200) ? 4 : 0)
    + ((flags & 0x400) ? 4 : 0) + ((flags & 0x800) ? 4 : 0);
  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const at = o + i * stride + ((flags & 0x100) ? 4 : 0);
    sizes.push((flags & 0x200) ? buf.readUInt32BE(at) : defaultSize);
  }
  // Without base-data-offset the run is relative to the start of its own moof.
  return { sizes, start: (base === null ? moofStart : base) + dataOffset };
}

/** Per-sample IVs and subsample ranges, or null if *ivSize* is not the one used.
 *
 * `senc` does not state its own IV size — it lives in `tenc`, in an init this
 * function never sees. Landing exactly on the end of the box is what proves a
 * guess right; a wrong size runs off the end or stops short.
 */
function parseSenc(buf, senc, ivSize) {
  const flags = buf.readUInt32BE(senc.body) & 0xffffff;
  const count = buf.readUInt32BE(senc.body + 4);
  const end = senc.start + senc.size;
  const samples = [];
  let o = senc.body + 8;
  for (let i = 0; i < count; i += 1) {
    if (o + ivSize > end) return null;
    const iv = buf.subarray(o, o + ivSize);
    o += ivSize;
    const subsamples = [];
    if (flags & 0x2) {
      if (o + 2 > end) return null;
      const n = buf.readUInt16BE(o);
      o += 2;
      if (o + n * 6 > end) return null;
      for (let j = 0; j < n; j += 1) {
        subsamples.push({ clear: buf.readUInt16BE(o), encrypted: buf.readUInt32BE(o + 2) });
        o += 6;
      }
    }
    samples.push({ iv, subsamples });
  }
  return o === end ? samples : null;
}

/** Decrypt one sample in place. The CTR counter runs on across its subsamples. */
function decryptSample(buf, offset, size, key, { iv, subsamples }) {
  const counter = Buffer.alloc(16);
  iv.copy(counter);
  const decipher = crypto.createDecipheriv('aes-128-ctr', key, counter);

  if (!subsamples.length) {
    decipher.update(buf.subarray(offset, offset + size)).copy(buf, offset);
    return;
  }
  let p = offset;
  for (const { clear, encrypted } of subsamples) {
    p += clear;
    if (encrypted) {
      decipher.update(buf.subarray(p, p + encrypted)).copy(buf, p);
      p += encrypted;
    }
  }
}

/**
 * Decrypt every fragment in a CMAF segment.
 *
 * @param {Buffer} segment  the encrypted segment, unmodified
 * @param {string} keyHex   the 16-byte content key, hex encoded
 * @returns {Buffer} a decrypted copy
 */
export function decryptCencSegment(segment, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 16) throw new Error(`content key must be 16 bytes, got ${key.length}`);
  const buf = Buffer.from(segment);

  let fragments = 0;
  for (const moof of boxes(buf)) {
    if (moof.type !== 'moof') continue;
    for (const traf of children(buf, moof, 'traf')) {
      const senc = child(buf, traf, 'senc');
      if (!senc) continue;
      const samples = parseSenc(buf, senc, 8) || parseSenc(buf, senc, 16);
      if (!samples) throw new Error('senc: no usable per-sample IV size');

      let i = 0;
      for (const trun of children(buf, traf, 'trun')) {
        const run = parseRun(buf, traf, trun, moof.start);
        let offset = run.start;
        for (const size of run.sizes) {
          if (i < samples.length) decryptSample(buf, offset, size, key, samples[i]);
          offset += size;
          i += 1;
        }
      }
      fragments += 1;
    }
  }
  if (!fragments) throw new Error('no encrypted fragment found in segment');
  return buf;
}
