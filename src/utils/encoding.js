/**
 * Encoding utilities for DRM and stream processing.
 * Shared across providers (6play, MyTF1).
 */
import { getLogger } from './logger.js';

const logger = getLogger('utils.encoding');

/** Pad base64 strings to a valid length. */
export function padBase64(value) {
  if (!value) return value;
  const missing = value.length % 4;
  return missing ? value + '='.repeat(4 - missing) : value;
}

function b64Decode(value, urlSafe = false) {
  const buf = Buffer.from(padBase64(value), urlSafe ? 'base64url' : 'base64');
  // Node's base64 decoder is lenient; re-encoding catches junk that would
  // otherwise silently produce a wrong-length buffer.
  return buf;
}

/**
 * Return the key ID as 32-char lowercase hex if possible.
 * Handles both hex and base64 encoded key IDs.
 */
export function normalizeKeyId(keyId) {
  if (!keyId) return null;

  const cleaned = String(keyId).trim().toLowerCase().replace(/-/g, '').replace(/ /g, '');

  if (/^[0-9a-f]{32}$/.test(cleaned)) return cleaned;

  try {
    const decoded = b64Decode(keyId.trim());
    if (decoded.length === 16) return decoded.toString('hex');
  } catch { /* not base64 */ }

  try {
    const decoded = b64Decode(keyId.trim(), true);
    if (decoded.length === 16) return decoded.toString('hex');
  } catch { /* not base64url */ }

  logger.warning('⚠️ Could not normalize key ID: %s', keyId);
  return null;
}

/**
 * Coerce provided key data into a 32-character hex string.
 * Handles hex, base64, and mixed formats.
 */
export function ensureHexKey(keyValue) {
  if (!keyValue) return null;

  const value = String(keyValue).trim();

  if (/^[0-9a-fA-F]{32}$/.test(value)) return value.toLowerCase();

  // Remove any prefix like "key:"
  if (value.includes(':')) {
    for (const part of value.split(':')) {
      const trimmed = part.trim();
      if (/^[0-9a-fA-F]{32}$/.test(trimmed)) return trimmed.toLowerCase();
    }
  }

  try {
    const decoded = b64Decode(value);
    if (decoded.length === 16) return decoded.toString('hex');
  } catch { /* not base64 */ }

  try {
    const decoded = b64Decode(value, true);
    if (decoded.length === 16) return decoded.toString('hex');
  } catch { /* not base64url */ }

  logger.warning('⚠️ Could not ensure hex key: %s...', value.slice(0, 20));
  return null;
}

/** Convert hex strings to base64url without padding. */
export function hexToBase64Url(hexValue) {
  if (!hexValue) return null;
  try {
    const clean = String(hexValue).toLowerCase().replace(/-/g, '').replace(/ /g, '');
    if (!/^[0-9a-f]+$/.test(clean)) return null;
    return Buffer.from(clean, 'hex').toString('base64url');
  } catch (e) {
    logger.warning('⚠️ hexToBase64Url error: %s', e.message);
    return null;
  }
}

/**
 * Extract the matching hex key from various key string formats.
 *
 * Handles formats like:
 * - "kid:key"
 * - "key_id:key_value"
 * - Just the key value
 * - Multiple keys separated by newlines
 */
export function normalizeDecryptionKey(rawKey, keyIdHex) {
  if (!rawKey) return null;

  const matchCandidate = (kidCandidate, keyCandidate) => {
    if (!keyCandidate) return null;

    const normalizedKid = kidCandidate ? normalizeKeyId(kidCandidate) : null;
    const normalizedKey = ensureHexKey(keyCandidate);
    if (!normalizedKey) return null;

    // With a target key_id, only a matching kid counts
    if (keyIdHex && normalizedKid) {
      return normalizedKid.toLowerCase() === String(keyIdHex).toLowerCase() ? normalizedKey : null;
    }
    return normalizedKey;
  };

  const value = String(rawKey).trim();

  for (const rawLine of value.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.includes(':')) {
      const idx = line.indexOf(':');
      const result = matchCandidate(line.slice(0, idx), line.slice(idx + 1));
      if (result) return result;
    } else {
      const result = ensureHexKey(line);
      if (result) return result;
    }
  }

  // Fallback: any 32-char hex run anywhere in the string
  const hexMatch = value.match(/[0-9a-fA-F]{32}/);
  if (hexMatch) return hexMatch[0].toLowerCase();

  logger.warning('⚠️ Could not normalize decryption key from: %s...', value.slice(0, 50));
  return null;
}
