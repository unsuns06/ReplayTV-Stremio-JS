/** The CDM's crypto, checked against published vectors and a synthetic license.
 *
 * These are the checks that fail loudly if the key derivation, the CMAC, the
 * protobuf encoding or the PSSH parsing drifts — everything else in the DRM
 * path is network glue around them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { aesCmac } from '../src/widevine/cmac.js';
import { Cdm } from '../src/widevine/cdm.js';
import { Device } from '../src/widevine/device.js';
import { PSSH, WIDEVINE_SYSTEM_ID } from '../src/widevine/pssh.js';
import { ProtoWriter, decodeMessage, first } from '../src/widevine/protobuf.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WVD_PATH = path.join(HERE, '..', 'src', 'providers', 'fr', 'device.wvd');

test('AES-CMAC matches the RFC 4493 test vectors', () => {
  const key = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex');
  const vectors = [
    ['', 'bb1d6929e95937287fa37d129b756746'],
    ['6bc1bee22e409f96e93d7e117393172a', '070a16b46b4d4144f79bdd9dd04a287c'],
    ['6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411',
      'dfa66747de9ae63030ca32611497c827'],
    ['6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411'
      + 'e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710', '51f0bebf7e3b9d92fc49741779363cfe'],
  ];
  for (const [message, expected] of vectors) {
    assert.equal(aesCmac(key, Buffer.from(message, 'hex')).toString('hex'), expected);
  }
});

test('protobuf round-trips varints and length-delimited fields', () => {
  const inner = new ProtoWriter().varint(1, 300).bytes(2, Buffer.from('hi')).finish();
  const outer = new ProtoWriter().bytes(1, inner).varint(2, 1).finish();
  const decoded = decodeMessage(outer);
  assert.equal(Number(first(decoded, 2)), 1);
  const innerDecoded = decodeMessage(first(decoded, 1));
  assert.equal(Number(first(innerDecoded, 1)), 300);
  assert.equal(first(innerDecoded, 2).toString(), 'hi');
});

test('PSSH box parsing yields the Widevine init data', () => {
  const initData = Buffer.concat([Buffer.from([0x12, 0x10]), Buffer.alloc(16, 0xab)]);
  const box = Buffer.concat([
    Buffer.alloc(4), // size, filled below
    Buffer.from('pssh'),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from(WIDEVINE_SYSTEM_ID.replace(/-/g, ''), 'hex'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(initData.length); return b; })(),
    initData,
  ]);
  box.writeUInt32BE(box.length, 0);

  const pssh = new PSSH(box.toString('base64'));
  assert.equal(pssh.systemId, WIDEVINE_SYSTEM_ID);
  assert.deepEqual(pssh.initData, initData);

  // Lenient mode: a bare Cenc Header is taken as init data as-is.
  const bare = new PSSH(initData.toString('base64'));
  assert.deepEqual(bare.initData, initData);
});

test('a license challenge is a signed LicenseRequest carrying the PSSH', () => {
  const device = Device.load(WVD_PATH);
  const cdm = Cdm.fromDevice(device);
  const sessionId = cdm.open();

  const initData = Buffer.concat([Buffer.from([0x12, 0x10]), Buffer.alloc(16, 0x5a)]);
  const challenge = cdm.getLicenseChallenge(sessionId, new PSSH(initData.toString('base64')));

  const signed = decodeMessage(challenge);
  assert.equal(Number(first(signed, 1)), 1, 'message type is LICENSE_REQUEST');

  const msg = first(signed, 2);
  const signature = first(signed, 3);
  const verified = crypto.verify('sha1', msg, {
    key: device.publicKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 20,
  }, signature);
  assert.ok(verified, 'RSA-PSS signature verifies against the device key');

  const request = decodeMessage(msg);
  assert.deepEqual(first(request, 1), device.clientId, 'client_id is sent verbatim');
  assert.equal(Number(first(request, 3)), 1, 'request type NEW');
  assert.equal(Number(first(request, 6)), 21, 'protocol version 2.1');

  const contentId = decodeMessage(first(request, 2));
  const wv = decodeMessage(first(contentId, 1));
  assert.deepEqual(first(wv, 1), initData);
  assert.equal(Number(first(wv, 2)), 1, 'license type STREAMING');

  cdm.close(sessionId);
});

test('parseLicense unwraps content keys from a license response', () => {
  const device = Device.load(WVD_PATH);
  const cdm = Cdm.fromDevice(device);
  const sessionId = cdm.open();

  const initData = Buffer.concat([Buffer.from([0x12, 0x10]), Buffer.alloc(16, 0x11)]);
  const challenge = cdm.getLicenseChallenge(sessionId, new PSSH(initData.toString('base64')));
  const licenseRequest = first(decodeMessage(challenge), 2);
  const requestId = first(decodeMessage(first(decodeMessage(licenseRequest), 2)), 1)
    ? first(decodeMessage(first(decodeMessage(first(decodeMessage(licenseRequest), 2)), 1)), 3)
    : null;
  assert.ok(requestId, 'request_id recovered from the challenge');

  // Stand in for the license server, using the same steps a real one takes.
  const sessionKey = crypto.randomBytes(16);
  const [encContext, macContext] = Cdm.deriveContext(licenseRequest);
  const [encKey, macKeyServer] = Cdm.deriveKeys(encContext, macContext, sessionKey);

  const contentKey = crypto.randomBytes(16);
  const kid = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-cbc', encKey, iv);
  const encryptedKey = Buffer.concat([cipher.update(contentKey), cipher.final()]);

  const licence = new ProtoWriter()
    .message(1, (id) => id.bytes(1, requestId))
    .message(3, (container) => container
      .bytes(1, kid)
      .bytes(2, iv)
      .bytes(3, encryptedKey)
      .varint(4, 2)) // CONTENT
    .finish();

  const response = new ProtoWriter()
    .varint(1, 2) // LICENSE
    .bytes(2, licence)
    .bytes(3, crypto.createHmac('sha256', macKeyServer).update(licence).digest())
    .bytes(4, crypto.publicEncrypt({
      key: device.publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha1',
    }, sessionKey))
    .finish();

  cdm.parseLicense(sessionId, response);
  const keys = cdm.getKeys(sessionId, 'CONTENT');
  assert.equal(keys.length, 1);
  assert.equal(keys[0].key.toString('hex'), contentKey.toString('hex'));
  assert.equal(keys[0].kid.replace(/-/g, ''), kid.toString('hex'));

  cdm.close(sessionId);
});

test('an all-digit Key ID is read as a decimal UUID, as Widevine specifies', () => {
  // Some services hand out decimal Key IDs as ASCII digits; the CDM must not
  // treat those 16 bytes as raw UUID bytes.
  const device = Device.load(WVD_PATH);
  const cdm = Cdm.fromDevice(device);
  const sessionId = cdm.open();
  const initData = Buffer.concat([Buffer.from([0x12, 0x10]), Buffer.alloc(16, 0x44)]);
  const challenge = cdm.getLicenseChallenge(sessionId, new PSSH(initData.toString('base64')));
  const licenseRequest = first(decodeMessage(challenge), 2);
  const contentId = decodeMessage(first(decodeMessage(licenseRequest), 2));
  const requestId = first(decodeMessage(first(contentId, 1)), 3);

  const sessionKey = crypto.randomBytes(16);
  const [encContext, macContext] = Cdm.deriveContext(licenseRequest);
  const [encKey, macKeyServer] = Cdm.deriveKeys(encContext, macContext, sessionKey);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-cbc', encKey, iv);
  const encryptedKey = Buffer.concat([cipher.update(crypto.randomBytes(16)), cipher.final()]);

  const licence = new ProtoWriter()
    .message(1, (id) => id.bytes(1, requestId))
    .message(3, (container) => container
      .bytes(1, Buffer.from('42', 'ascii'))
      .bytes(2, iv)
      .bytes(3, encryptedKey)
      .varint(4, 2))
    .finish();
  const response = new ProtoWriter()
    .varint(1, 2)
    .bytes(2, licence)
    .bytes(3, crypto.createHmac('sha256', macKeyServer).update(licence).digest())
    .bytes(4, crypto.publicEncrypt({
      key: device.publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha1',
    }, sessionKey))
    .finish();

  cdm.parseLicense(sessionId, response);
  assert.equal(cdm.getKeys(sessionId, 'CONTENT')[0].kid, '00000000-0000-0000-0000-00000000002a');
  cdm.close(sessionId);
});

test('a tampered license signature is rejected', () => {
  const device = Device.load(WVD_PATH);
  const cdm = Cdm.fromDevice(device);
  const sessionId = cdm.open();
  const initData = Buffer.concat([Buffer.from([0x12, 0x10]), Buffer.alloc(16, 0x22)]);
  const challenge = cdm.getLicenseChallenge(sessionId, new PSSH(initData.toString('base64')));
  const licenseRequest = first(decodeMessage(challenge), 2);
  const contentId = decodeMessage(first(decodeMessage(licenseRequest), 2));
  const requestId = first(decodeMessage(first(contentId, 1)), 3);

  const sessionKey = crypto.randomBytes(16);
  const licence = new ProtoWriter().message(1, (id) => id.bytes(1, requestId)).finish();
  const response = new ProtoWriter()
    .varint(1, 2)
    .bytes(2, licence)
    .bytes(3, Buffer.alloc(32, 0xff)) // wrong HMAC
    .bytes(4, crypto.publicEncrypt({
      key: device.publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha1',
    }, sessionKey))
    .finish();

  assert.throws(() => cdm.parseLicense(sessionId, response), /Signature Mismatch/);
  cdm.close(sessionId);
});
