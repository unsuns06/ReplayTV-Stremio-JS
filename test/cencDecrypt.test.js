import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { decryptCencSegment } from '../src/utils/drm/cencDecrypt.js';

const KEY = '000102030405060708090a0b0c0d0e0f';

const box = (type, ...parts) => {
  const payload = Buffer.concat(parts);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length + 8);
  return Buffer.concat([size, Buffer.from(type, 'latin1'), payload]);
};
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };

/** Encrypt one sample the way a CENC packager does: one CTR run per sample. */
function encryptSample(plain, key, iv, subsamples) {
  const counter = Buffer.alloc(16);
  iv.copy(counter);
  const cipher = crypto.createCipheriv('aes-128-ctr', key, counter);
  const out = Buffer.from(plain);
  let p = 0;
  for (const { clear, encrypted } of subsamples) {
    p += clear;
    cipher.update(out.subarray(p, p + encrypted)).copy(out, p);
    p += encrypted;
  }
  return out;
}

/** A one-fragment segment holding *samples*, encrypted, with a `senc` describing it. */
function buildFragment(samples, key) {
  const encrypted = samples.map((s) => encryptSample(s.plain, key, s.iv, s.subsamples));

  const sencEntries = samples.map((s) => Buffer.concat([
    s.iv,
    u16(s.subsamples.length),
    ...s.subsamples.map(({ clear, encrypted: enc }) => Buffer.concat([u16(clear), u32(enc)])),
  ]));
  // version 0, flags 0x2 (subsample encryption present)
  const senc = box('senc', Buffer.from([0, 0, 0, 2]), u32(samples.length), ...sencEntries);
  // tfhd flags 0x0: sizes come from the trun instead
  const tfhd = box('tfhd', Buffer.from([0, 0, 0, 0]), u32(1));

  // trun flags 0x1 data-offset-present | 0x200 sample-size-present. The offset
  // is only knowable once the moof is sized, so build it twice.
  const trunFor = (dataOffset) => box(
    'trun',
    Buffer.from([0, 0, 0x02, 0x01]),
    u32(samples.length),
    u32(dataOffset),
    ...encrypted.map((e) => u32(e.length)),
  );
  const moofSize = box('moof', box('traf', tfhd, trunFor(0), senc)).length;
  const moof = box('moof', box('traf', tfhd, trunFor(moofSize + 8), senc));
  const mdat = box('mdat', ...encrypted);
  return { segment: Buffer.concat([moof, mdat]), mdatStart: moof.length + 8 };
}

const sample = (bytes, iv, subsamples) => ({
  plain: Buffer.from(bytes), iv: Buffer.from(iv, 'hex'), subsamples,
});

test('decrypts every sample, with the counter running on across subsamples', () => {
  const key = Buffer.from(KEY, 'hex');
  const samples = [
    // a clear NAL header followed by two encrypted runs, as video really looks
    sample(crypto.randomBytes(100), '0000000000000001', [{ clear: 4, encrypted: 32 }, { clear: 4, encrypted: 60 }]),
    sample(crypto.randomBytes(48), '0000000000000002', [{ clear: 0, encrypted: 48 }]),
  ];
  const { segment, mdatStart } = buildFragment(samples, key);

  const plain = Buffer.concat(samples.map((s) => s.plain));
  assert.notDeepEqual(segment.subarray(mdatStart, mdatStart + plain.length), plain, 'fixture must be encrypted');

  const out = decryptCencSegment(segment, KEY);
  assert.deepEqual(out.subarray(mdatStart, mdatStart + plain.length), plain);
});

test('decrypts every fragment in a multi-fragment segment', () => {
  // MediaFlow decrypted only the first of these and repeated it; Disney puts
  // about seven per 8s segment, which is what desynced audio from video.
  const key = Buffer.from(KEY, 'hex');
  const plaintexts = [1, 2, 3, 4, 5, 6, 7].map(() => crypto.randomBytes(64));
  const built = plaintexts.map((plain, i) => buildFragment(
    [sample(plain, `000000000000000${i + 1}`, [{ clear: 8, encrypted: 56 }])],
    key,
  ));
  const segment = Buffer.concat(built.map((b) => b.segment));

  const out = decryptCencSegment(segment, KEY);
  let at = 0;
  built.forEach((b, i) => {
    const start = at + b.mdatStart;
    assert.deepEqual(out.subarray(start, start + 64), plaintexts[i], `fragment ${i} not decrypted`);
    at += b.segment.length;
  });
});

test('leaves an unencrypted segment alone rather than corrupting it', () => {
  assert.throws(() => decryptCencSegment(box('moof', box('traf')), KEY), /no encrypted fragment/);
});

test('rejects a key that is not 16 bytes', () => {
  assert.throws(() => decryptCencSegment(Buffer.alloc(0), 'aabb'), /16 bytes/);
});

test('strips the CENC signalling ExoPlayer trips over, without moving anything', () => {
  const key = Buffer.from(KEY, 'hex');
  const iv = Buffer.alloc(8, 7);
  const { segment } = buildFragment(
    [{ plain: crypto.randomBytes(64), iv, subsamples: [{ clear: 16, encrypted: 48 }] }],
    key,
  );
  const out = decryptCencSegment(segment, KEY);

  // Renamed in place: the player must not find a `senc` describing samples that
  // are already in the clear, and every offset has to stay where `trun` says.
  assert.equal(out.includes(Buffer.from('senc', 'latin1')), false);
  assert.equal(out.length, segment.length);
  assert.equal(out.includes(Buffer.from('free', 'latin1')), true);
});
