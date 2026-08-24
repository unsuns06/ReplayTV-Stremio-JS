/** The few protobuf primitives the Widevine license exchange needs.
 *
 * ponytail: hand-rolled instead of pulling in protobufjs + the .proto schema —
 * the whole exchange is five messages made of varints and length-delimited
 * bytes, and only the field numbers matter. Add a real protobuf library if the
 * CDM ever needs to read a message with maps, floats, or packed repeats.
 */

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_BYTES = 2;
const WIRE_32BIT = 5;

/** Encode an unsigned integer as a protobuf varint. */
export function encodeVarint(value) {
  let v = BigInt(value);
  if (v < 0n) v += 1n << 64n; // two's complement, as protobuf does for negatives
  const out = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return Buffer.from(out);
}

function tag(fieldNumber, wireType) {
  return encodeVarint(fieldNumber * 8 + wireType);
}

/** Builds a protobuf message field by field, in the order fields are added. */
export class ProtoWriter {
  constructor() {
    this.chunks = [];
  }

  /** varint field (int32/int64/uint32/uint64/enum/bool). */
  varint(fieldNumber, value) {
    if (value === null || value === undefined) return this;
    this.chunks.push(tag(fieldNumber, WIRE_VARINT), encodeVarint(value));
    return this;
  }

  /** length-delimited field (bytes/string/embedded message). */
  bytes(fieldNumber, value) {
    if (value === null || value === undefined) return this;
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.chunks.push(tag(fieldNumber, WIRE_BYTES), encodeVarint(buf.length), buf);
    return this;
  }

  /** embedded message field, built by *fn* into a fresh writer. */
  message(fieldNumber, fn) {
    const sub = new ProtoWriter();
    fn(sub);
    return this.bytes(fieldNumber, sub.finish());
  }

  finish() {
    return Buffer.concat(this.chunks);
  }
}

/**
 * Decode a protobuf message into `{ [fieldNumber]: [values...] }`.
 *
 * Values are Buffers for length-delimited fields, BigInt for varints, and
 * Buffers for fixed-width fields. Repeated fields keep every occurrence.
 */
export function decodeMessage(buffer) {
  const fields = {};
  let offset = 0;

  const readVarint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (offset >= buffer.length) throw new Error('truncated varint');
      const byte = buffer[offset];
      offset += 1;
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) break;
      shift += 7n;
      if (shift > 70n) throw new Error('varint too long');
    }
    return result;
  };

  const push = (field, value) => {
    (fields[field] ||= []).push(value);
  };

  while (offset < buffer.length) {
    const key = readVarint();
    const field = Number(key >> 3n);
    const wireType = Number(key & 7n);

    if (wireType === WIRE_VARINT) {
      push(field, readVarint());
    } else if (wireType === WIRE_BYTES) {
      const length = Number(readVarint());
      if (offset + length > buffer.length) throw new Error('truncated bytes field');
      push(field, buffer.subarray(offset, offset + length));
      offset += length;
    } else if (wireType === WIRE_64BIT) {
      push(field, buffer.subarray(offset, offset + 8));
      offset += 8;
    } else if (wireType === WIRE_32BIT) {
      push(field, buffer.subarray(offset, offset + 4));
      offset += 4;
    } else {
      throw new Error(`unsupported wire type ${wireType}`);
    }
  }

  return fields;
}

/** First value of *field*, or `undefined`. */
export function first(fields, field) {
  return fields[field]?.[0];
}

/** Every value of *field* (empty array when absent). */
export function all(fields, field) {
  return fields[field] || [];
}
