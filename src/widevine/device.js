/** Widevine device (.wvd) file loading.
 *
 * Format (pywidevine "WVD" v2), big-endian:
 *
 *     magic "WVD" | version u8 | type u8 | security_level u8 | flags u8
 *     private_key_len u16 | private_key (PKCS#1 DER)
 *     client_id_len   u16 | client_id (serialised ClientIdentification)
 *
 * The client ID is kept as opaque bytes: the license request embeds it
 * verbatim, so nothing here needs to understand its schema.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

export const DeviceTypes = { CHROME: 1, ANDROID: 2 };

export class Device {
  constructor({ type, securityLevel, privateKeyDer, clientId }) {
    if (!clientId?.length) throw new Error('Client ID is required, the WVD does not contain one or is malformed.');
    if (!privateKeyDer?.length) throw new Error('Private Key is required, the WVD does not contain one or is malformed.');
    this.type = type;
    this.securityLevel = securityLevel;
    this.clientId = clientId;
    this.privateKey = crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs1' });
    this.publicKey = crypto.createPublicKey(this.privateKey);
  }

  /** Parse a .wvd buffer. */
  static loads(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
    if (buf.subarray(0, 3).toString('ascii') !== 'WVD') {
      throw new Error('Not a WVD file (bad magic)');
    }
    const version = buf[3];
    if (version !== 2) {
      throw new Error(`Unsupported WVD version ${version} (only v2 is supported)`);
    }
    const type = buf[4];
    const securityLevel = buf[5];
    // buf[6] is the flags byte — no per-device flags are defined yet.
    let offset = 7;

    const privateKeyLen = buf.readUInt16BE(offset);
    offset += 2;
    const privateKeyDer = buf.subarray(offset, offset + privateKeyLen);
    offset += privateKeyLen;

    const clientIdLen = buf.readUInt16BE(offset);
    offset += 2;
    const clientId = buf.subarray(offset, offset + clientIdLen);

    return new Device({ type, securityLevel, privateKeyDer, clientId });
  }

  /** Load a .wvd file from disk. */
  static load(filePath) {
    return Device.loads(fs.readFileSync(filePath));
  }
}
