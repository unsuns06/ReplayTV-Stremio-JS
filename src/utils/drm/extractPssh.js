/** Fetch a DASH MPD document and extract the first PSSH box.
 *
 * Generic DRM tooling with no provider-specific logic.
 */
import { getProxyConfig } from '../proxyConfig.js';
import { iterPsshText } from './mpdXml.js';

export const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/dash+xml,application/xml;q=0.9,*/*;q=0.8',
};
export const REQUEST_TIMEOUT = 30_000;
export const WIDEVINE_SYSTEM_ID = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';

/** One PSSH box found in a manifest. */
export class PsshRecord {
  constructor({ source, parent, base64Text, rawLength, systemId }) {
    this.source = source;
    this.parent = parent;
    this.base64Text = base64Text;
    this.rawLength = rawLength;
    this.systemId = systemId;
  }
}

/** Fetch an MPD document using the geo proxy to bypass geoblocking. */
export async function fetchMpd(url) {
  const proxyBaseUrl = getProxyConfig().getProxy('fr_default');
  if (!proxyBaseUrl) throw new Error('fr_default proxy not configured in credentials');

  const proxyUrl = proxyBaseUrl + encodeURIComponent(url);
  const response = await fetch(proxyUrl, {
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (!response.ok) throw new Error(`MPD fetch failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function formatUuid(buf) {
  const hex = buf.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Decode one base64 PSSH payload into a PsshRecord, or null. */
export function decodePssh(base64Text, parent, source) {
  const cleaned = (base64Text || '').replace(/\s+/g, '');
  if (!cleaned) return null;

  let raw;
  try {
    raw = Buffer.from(cleaned, 'base64');
    if (!raw.length) return null;
  } catch {
    return null;
  }

  let systemId = null;
  if (raw.length >= 28) {
    systemId = formatUuid(raw.subarray(12, 28));
  }

  return new PsshRecord({
    source, parent, base64Text: cleaned, rawLength: raw.length, systemId,
  });
}

/** Every PSSH box in the manifest text. */
export function iterPssh(xml) {
  return iterPsshText(xml)
    .map(({ text, source, parent }) => decodePssh(text, parent, source))
    .filter(Boolean);
}

/**
 * Return the Widevine PSSH if the manifest has one, else the first PSSH.
 *
 * 6play's live manifests list the PlayReady box first, and a Widevine CDM
 * rejects it with a 400 — so system ID decides, not document order.
 *
 * @returns {Promise<{record: PsshRecord|null, mpd: Buffer|null}>}
 */
export async function extractFirstPssh(url) {
  const xmlBytes = await fetchMpd(url);
  const records = iterPssh(xmlBytes.toString('utf-8'));
  const record = records.find((r) => (r.systemId || '').toLowerCase() === WIDEVINE_SYSTEM_ID)
    ?? records[0] ?? null;
  return { record, mpd: xmlBytes };
}
