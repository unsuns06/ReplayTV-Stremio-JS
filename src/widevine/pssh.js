/** MP4 PSSH box parsing — just enough to reach the init data.
 *
 * A license request carries the Widevine Cenc Header (the PSSH box's
 * `init_data`).  Anything that is not a parseable box is passed through as
 * init data unchanged, matching pywidevine's lenient mode: some services
 * accept a custom init_data value.
 */

export const WIDEVINE_SYSTEM_ID = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
export const PLAYREADY_SYSTEM_ID = '9a04f079-9840-4286-ab92-e65be0885f95';

function formatUuid(buf) {
  const hex = buf.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class PSSH {
  /** @param {Buffer|string} data  a PSSH box or Widevine Cenc Header, raw or base64 */
  constructor(data) {
    if (!data) throw new Error('Data must not be empty.');
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data).replace(/\s+/g, ''), 'base64');
    if (!buf.length) throw new Error('Data must not be empty.');

    const parsed = PSSH._parseBox(buf);
    if (parsed) {
      this.version = parsed.version;
      this.flags = parsed.flags;
      this.systemId = parsed.systemId;
      this.keyIds = parsed.keyIds;
      this.initData = parsed.initData;
    } else {
      // Not an mp4 box — treat the payload as init data for a v0 Widevine box.
      this.version = 0;
      this.flags = 0;
      this.systemId = WIDEVINE_SYSTEM_ID;
      this.keyIds = [];
      this.initData = buf;
    }
  }

  static _parseBox(buf) {
    if (buf.length < 32) return null;
    const size = buf.readUInt32BE(0);
    if (buf.subarray(4, 8).toString('ascii') !== 'pssh') return null;
    if (size !== buf.length && size !== 0) {
      // A concatenated or truncated box: still parse what we have.
      if (size > buf.length) return null;
    }
    const version = buf[8];
    const flags = (buf[9] << 16) | (buf[10] << 8) | buf[11];
    const systemId = formatUuid(buf.subarray(12, 28));
    let offset = 28;
    const keyIds = [];
    if (version > 0) {
      const count = buf.readUInt32BE(offset);
      offset += 4;
      for (let i = 0; i < count; i += 1) {
        keyIds.push(formatUuid(buf.subarray(offset, offset + 16)));
        offset += 16;
      }
    }
    const dataSize = buf.readUInt32BE(offset);
    offset += 4;
    return { version, flags, systemId, keyIds, initData: buf.subarray(offset, offset + dataSize) };
  }
}
