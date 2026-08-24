/** A Widevine Content Decryption Module, in JavaScript.
 *
 * This is the JS counterpart of pywidevine's `Cdm`: it builds a signed license
 * challenge from a PSSH and a provisioned device (.wvd), then unwraps the
 * content keys from the license server's response.
 *
 * The exchange, end to end:
 *   1. LicenseRequest {client_id, content_id{pssh, request_id}, ...}
 *   2. SignedMessage  {LICENSE_REQUEST, msg, RSA-PSS(SHA-1) signature}   → server
 *   3. SignedMessage  {LICENSE, msg, HMAC signature, RSA-OAEP session_key} ← server
 *   4. session_key → (CMAC key derivation) → enc_key, mac_key_server
 *   5. verify HMAC-SHA256, then AES-128-CBC decrypt each KeyContainer
 *
 * Privacy mode (service-certificate-encrypted client IDs) is not implemented —
 * none of this addon's license servers ask for it.
 */
import crypto from 'node:crypto';

import { ProtoWriter, decodeMessage, first, all } from './protobuf.js';
import { aesCmac } from './cmac.js';
import { DeviceTypes } from './device.js';

const MESSAGE_TYPE = { LICENSE_REQUEST: 1, LICENSE: 2, ERROR_RESPONSE: 3 };
const LICENSE_TYPE = { STREAMING: 1, OFFLINE: 2, AUTOMATIC: 3 };
const REQUEST_TYPE_NEW = 1;
const PROTOCOL_VERSION_2_1 = 21;
const KEY_TYPE = { 1: 'SIGNING', 2: 'CONTENT', 3: 'KEY_CONTROL', 4: 'OPERATOR_SESSION', 5: 'ENTITLEMENT', 6: 'OEM_CONTENT' };

const MAX_NUM_OF_SESSIONS = 16;

/** Convert Key ID bytes to a dashed UUID string. */
function kidToUuid(kid) {
  let buf = Buffer.isBuffer(kid) ? kid : Buffer.from(kid || []);
  if (!buf.length) buf = Buffer.alloc(16);

  // Some services hand out decimal Key IDs as ASCII digits.
  const asText = buf.toString('latin1');
  if (/^\d+$/.test(asText)) {
    const hex = BigInt(asText).toString(16).padStart(32, '0');
    buf = Buffer.from(hex.slice(-32), 'hex');
  } else if (buf.length < 16) {
    buf = Buffer.concat([buf, Buffer.alloc(16 - buf.length)]);
  }

  const hex = buf.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function pkcs7Unpad(buf) {
  if (!buf.length) return buf;
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 16 || pad > buf.length) throw new Error('Invalid PKCS#7 padding');
  for (let i = buf.length - pad; i < buf.length; i += 1) {
    if (buf[i] !== pad) throw new Error('Invalid PKCS#7 padding');
  }
  return buf.subarray(0, buf.length - pad);
}

class Session {
  constructor(number) {
    this.number = number;
    this.id = crypto.randomBytes(16).toString('hex');
    this.context = new Map(); // request_id hex -> [encContext, macContext]
    this.keys = [];
  }
}

export class Cdm {
  constructor({ deviceType, securityLevel, clientId, privateKey }) {
    if (!clientId) throw new Error('Client ID must be provided');
    if (!privateKey) throw new Error('RSA Key must be provided');
    this.deviceType = deviceType;
    this.securityLevel = securityLevel;
    this._clientId = clientId;
    this._privateKey = privateKey;
    this._sessions = new Map();
  }

  /** Initialize a Widevine CDM from a Widevine Device (.wvd) file. */
  static fromDevice(device) {
    return new Cdm({
      deviceType: device.type,
      securityLevel: device.securityLevel,
      clientId: device.clientId,
      privateKey: device.privateKey,
    });
  }

  /** Open a CDM session; returns its identifier. */
  open() {
    if (this._sessions.size > MAX_NUM_OF_SESSIONS) {
      throw new Error(`Too many Sessions open (${MAX_NUM_OF_SESSIONS}).`);
    }
    const session = new Session(this._sessions.size + 1);
    this._sessions.set(session.id, session);
    return session.id;
  }

  /** Close a CDM session. */
  close(sessionId) {
    if (!this._sessions.has(sessionId)) throw new Error(`Session identifier ${sessionId} is invalid.`);
    this._sessions.delete(sessionId);
  }

  _session(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error(`Session identifier ${sessionId} is invalid.`);
    return session;
  }

  _requestId(session) {
    if (this.deviceType === DeviceTypes.ANDROID) {
      // OEMCrypto's request_id is an AES-CTR counter block, re-encoded as
      // uppercase hex: 4 random bytes, 4 zero bytes, then an 8-byte counter.
      const counter = Buffer.alloc(8);
      counter.writeBigUInt64LE(BigInt(session.number));
      const raw = Buffer.concat([crypto.randomBytes(4), Buffer.alloc(4), counter]);
      return Buffer.from(raw.toString('hex').toUpperCase(), 'ascii');
    }
    return crypto.randomBytes(16);
  }

  /**
   * Build a License Request (Challenge) to send to a License Server.
   *
   * @param {string} sessionId
   * @param {PSSH} pssh
   * @param {string} licenseType  STREAMING | OFFLINE | AUTOMATIC
   * @returns {Buffer} a signed SignedMessage containing a LicenseRequest
   */
  getLicenseChallenge(sessionId, pssh, licenseType = 'STREAMING') {
    const session = this._session(sessionId);
    if (!pssh) throw new Error('A pssh must be provided.');
    if (!(licenseType in LICENSE_TYPE)) throw new Error(`Invalid license_type value of '${licenseType}'.`);

    const requestId = this._requestId(session);

    const licenseRequest = new ProtoWriter()
      .bytes(1, this._clientId)
      .message(2, (contentId) => contentId.message(1, (wv) => wv
        .bytes(1, pssh.initData)
        .varint(2, LICENSE_TYPE[licenseType])
        .bytes(3, requestId)))
      .varint(3, REQUEST_TYPE_NEW)
      .varint(4, Math.floor(Date.now() / 1000))
      .varint(6, PROTOCOL_VERSION_2_1)
      .varint(7, crypto.randomInt(1, 2 ** 31))
      .finish();

    const signature = crypto.sign('sha1', licenseRequest, {
      key: this._privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 20, // PyCryptodome's pss default: salt length == digest size
    });

    const signedLicenseRequest = new ProtoWriter()
      .varint(1, MESSAGE_TYPE.LICENSE_REQUEST)
      .bytes(2, licenseRequest)
      .bytes(3, signature)
      .finish();

    session.context.set(requestId.toString('hex'), Cdm.deriveContext(licenseRequest));

    return signedLicenseRequest;
  }

  /**
   * Load keys from a License Message returned by a License Server.
   * License messages can only be loaded once per request.
   */
  parseLicense(sessionId, licenseMessage) {
    const session = this._session(sessionId);
    if (!licenseMessage?.length) throw new Error('Cannot parse an empty license_message');

    const raw = Buffer.isBuffer(licenseMessage) ? licenseMessage : Buffer.from(licenseMessage, 'base64');
    const signed = decodeMessage(raw);

    const type = Number(first(signed, 1) ?? 0);
    if (type !== MESSAGE_TYPE.LICENSE) {
      throw new Error(`Expecting a LICENSE message, not message type ${type}.`);
    }

    const msg = first(signed, 2);
    const signature = first(signed, 3);
    const sessionKeyEncrypted = first(signed, 4);
    const oemcryptoCoreMessage = first(signed, 9) || Buffer.alloc(0);
    if (!msg || !sessionKeyEncrypted) throw new Error('License message is missing msg or session_key');

    const licence = decodeMessage(msg);
    const licenseId = first(licence, 1);
    const requestId = licenseId ? first(decodeMessage(licenseId), 1) : null;
    const contextKey = requestId ? requestId.toString('hex') : '';
    const context = session.context.get(contextKey);
    if (!context) throw new Error('Cannot parse a license message without first making a license request');

    const sessionKey = crypto.privateDecrypt(
      { key: this._privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
      sessionKeyEncrypted,
    );

    const [encKey, macKeyServer] = Cdm.deriveKeys(context[0], context[1], sessionKey);

    // The oemcrypto_core_message (OEM Crypto API v16+) prefixes the HMAC input
    // when present; the raw `msg` bytes are used rather than a re-serialisation.
    const computed = crypto.createHmac('sha256', macKeyServer)
      .update(oemcryptoCoreMessage)
      .update(msg)
      .digest();

    if (!signature || !crypto.timingSafeEqual(computed, signature)) {
      throw new Error('Signature Mismatch on License Message, rejecting license');
    }

    session.keys = all(licence, 3).map((containerBytes) => {
      const container = decodeMessage(containerBytes);
      const id = first(container, 1) || Buffer.alloc(16);
      const iv = first(container, 2);
      const encrypted = first(container, 3);
      const keyType = KEY_TYPE[Number(first(container, 4) ?? 0)] || 'UNKNOWN';
      const decipher = crypto.createDecipheriv('aes-128-cbc', encKey, iv);
      decipher.setAutoPadding(false);
      const plain = pkcs7Unpad(Buffer.concat([decipher.update(encrypted), decipher.final()]));
      return { type: keyType, kid: kidToUuid(id), key: plain };
    });

    session.context.delete(contextKey);
  }

  /** Keys from the loaded License message, optionally filtered by type. */
  getKeys(sessionId, type = null) {
    const session = this._session(sessionId);
    return type ? session.keys.filter((k) => k.type === type) : session.keys;
  }

  /** The 2 context values used for computing the AES encryption and HMAC keys. */
  static deriveContext(message) {
    const sizeBuf = (bits) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(bits);
      return b;
    };
    const encContext = Buffer.concat([Buffer.from('ENCRYPTION'), Buffer.from([0]), message, sizeBuf(16 * 8)]);
    const macContext = Buffer.concat([Buffer.from('AUTHENTICATION'), Buffer.from([0]), message, sizeBuf(32 * 8 * 2)]);
    return [encContext, macContext];
  }

  /** The 3 keys derived from a session key: enc, mac_server, mac_client. */
  static deriveKeys(encContext, macContext, key) {
    const derive = (context, counter) => aesCmac(key, Buffer.concat([Buffer.from([counter]), context]));
    const encKey = derive(encContext, 1);
    const macKeyServer = Buffer.concat([derive(macContext, 1), derive(macContext, 2)]);
    const macKeyClient = Buffer.concat([derive(macContext, 3), derive(macContext, 4)]);
    return [encKey, macKeyServer, macKeyClient];
  }
}
