/** PSSH extraction and DRM metadata reading for MPD manifests. */
import { getLogger } from '../logger.js';
import { extractFirstPssh, PsshRecord } from './extractPssh.js';
import { iterContentProtection, xmlAttr } from './mpdXml.js';

const logger = getLogger('utils.drm.psshExtractor');

const MP4PROTECTION = 'MP4PROTECTION';
const WIDEVINE_SCHEME = 'EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED';
const PLAYREADY_SCHEME = '9A04F079-9840-4286-AB92-E65BE0885F95';

/** Extract DRM key IDs and PSSH boxes from an MPD manifest. */
export function extractDrmInfoFromMpd(mpdContent) {
  try {
    const drmInfo = { key_id: null, widevine_pssh: null, playready_pssh: null };

    for (const { attrs, body } of iterContentProtection(mpdContent)) {
      // Scheme UUIDs appear lower-cased in live manifests, upper-cased in replay ones.
      const schemeId = (xmlAttr(attrs, 'schemeIdUri') || '').toUpperCase();
      const psshMatch = body.match(/<(?:[\w.-]+:)?pssh\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?pssh>/i);
      const pssh = psshMatch ? psshMatch[1].trim() : null;

      if (schemeId.includes(MP4PROTECTION)) {
        const defaultKid = xmlAttr(attrs, 'default_KID');
        if (defaultKid) drmInfo.key_id = defaultKid;
      } else if (schemeId.includes(WIDEVINE_SCHEME)) {
        if (pssh) drmInfo.widevine_pssh = pssh;
      } else if (schemeId.includes(PLAYREADY_SCHEME)) {
        if (pssh) drmInfo.playready_pssh = pssh;
      }
    }

    return drmInfo;
  } catch (e) {
    logger.error('[MPD] Error extracting DRM info: %s', e.message);
    return {};
  }
}

/**
 * Extract PSSH data and DRM metadata from an MPD manifest.
 *
 * @returns {Promise<[PsshRecord|null, string|null, Object]>}
 *   the PSSH record (if found), the raw MPD text, and the DRM info object.
 */
export async function extractPsshFromMpd(mpdUrl, providerName = 'DRM') {
  let mpdText = null;
  let drmInfo = {};

  try {
    const { record, mpd } = await extractFirstPssh(mpdUrl);
    let psshRecord = record;

    if (mpd) mpdText = mpd.toString('utf-8');

    if (mpdText) {
      try {
        drmInfo = extractDrmInfoFromMpd(mpdText) || {};
      } catch (drmError) {
        drmInfo = {};
        logger.warning('⚠️ [%s] Failed to parse DRM info: %s', providerName, drmError.message);
      }
    }

    // Fallback: create a PSSH record from the DRM info if the scan found none
    if (!psshRecord && drmInfo.widevine_pssh) {
      try {
        const raw = Buffer.from(drmInfo.widevine_pssh, 'base64');
        psshRecord = new PsshRecord({
          source: 'drm_info',
          parent: 'ContentProtection',
          base64Text: drmInfo.widevine_pssh,
          rawLength: raw.length,
          systemId: 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed',
        });
      } catch { /* leave psshRecord null */ }
    }

    if (psshRecord) {
      logger.debug('✅ [%s] PSSH extracted: %s...', providerName, psshRecord.base64Text.slice(0, 50));
    } else {
      logger.warning('⚠️ [%s] No PSSH found in MPD manifest', providerName);
    }

    return [psshRecord, mpdText, drmInfo];
  } catch (e) {
    logger.error('❌ [%s] Error extracting PSSH from MPD: %s', providerName, e.message);
    return [null, null, {}];
  }
}
