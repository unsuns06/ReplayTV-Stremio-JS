/** Pre-processed-file lookup and background DRM processing for DRM providers.
 *
 * Only the DRM providers (MyTF1, 6play) need the TorBox / Real-Debrid /
 * nm3u8-processor integration and the background-processing placeholder
 * streams, so it lives here rather than on BaseProvider.
 *
 * JS has no multiple inheritance: `withDrmProcessedFiles(Base)` is a class
 * mixin factory, applied as `class X extends withDrmProcessedFiles(BaseProvider)`.
 */
import { getLogger } from '../utils/logger.js';
import { cache } from '../utils/cache.js';
import { loadCredentials } from '../utils/credentials.js';
import { getRandomWindowsUA } from '../utils/userAgent.js';
import { processDrmSimple } from '../utils/drm/nm3u8DrmProcessor.js';

const logger = getLogger('providers.drm');

/** Sentinel URL Stremio shows while background DRM processing runs */
export const PROCESSING_PLACEHOLDER_URL = 'https://stream-not-available';

const TORBOX_API = 'https://api.torbox.app/v1/api';
const TORBOX_LIST_CACHE_KEY = 'torbox:webdl:mylist';

/** Master switch for nm3u8 processing + TorBox/Real-Debrid lookups. Off by default.
 *
 * Set `"drm_processing": true` in credentials.json, or `DRM_PROCESSING=1` in
 * the environment (env wins). Disabled means providers offer only the direct
 * stream.
 */
export function drmProcessingEnabled() {
  const env = process.env.DRM_PROCESSING;
  if (env !== undefined) return ['1', 'true', 'yes', 'on'].includes(env.trim().toLowerCase());
  return Boolean(loadCredentials().drm_processing);
}

/** Find the finished web download holding *filename*. Returns [webId, fileId] or null. */
export function matchWebdl(items, filename) {
  const stem = filename.includes('.') ? filename.slice(0, filename.lastIndexOf('.')) : filename;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (!(item.download_finished || item.download_present)) continue;
    const files = (item.files || []).filter((f) => f && typeof f === 'object');
    for (const f of files) {
      const name = f.short_name || f.name || '';
      if (name.endsWith(filename)) return [item.id, f.id ?? 0];
    }
    if (item.name === filename || item.name === stem || (item.original_url || '').includes(filename)) {
      return [item.id, files.length ? (files[0].id ?? 0) : 0];
    }
  }
  return null;
}

export function withDrmProcessedFiles(Base) {
  return class DRMProcessedFileMixin extends Base {
    static supportsDrmFiles = true;

    static _torboxConfig() {
      const tb = loadCredentials().torbox;
      return tb && typeof tb === 'object' && !Array.isArray(tb) ? tb : {};
    }

    /** Look for a pre-processed file on TorBox: API first, then WebDAV.
     *
     * The WebDAV mount only refreshes every 15 minutes, so a freshly uploaded
     * file is invisible there; the API reads live. WebDAV stays as the fallback
     * because it keeps serving from that cache when the API is down.
     */
    async _checkTorbox(processedFilename) {
      return (await this._checkTorboxApi(processedFilename))
        || (await this._checkTorboxWebdav(processedFilename));
    }

    /** The TorBox web-download list, cached 60s. Empty list on any failure. */
    async _torboxWebdlList(apiKey) {
      const cached = cache.get(TORBOX_LIST_CACHE_KEY);
      if (cached !== null) return cached;
      let items = [];
      try {
        const resp = await this.apiClient.rawRequest('GET', `${TORBOX_API}/webdl/mylist`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          // bypass_cache is the fast path: ~1.5s, versus a 60s Cloudflare 504 without it
          params: { bypass_cache: 'true' },
          timeout: 10,
        });
        if (!resp || !resp.ok) throw new Error(`HTTP ${resp ? resp.status : 'no response'}`);
        const data = await resp.json();
        items = Array.isArray(data.data) ? data.data : [];
      } catch (exc) {
        logger.error('❌ %s TorBox API list error: %s', this.logPrefix, exc.message);
        items = [];
      }
      cache.set(TORBOX_LIST_CACHE_KEY, items, 60);
      return items;
    }

    /** Find the file in the live TorBox list and resolve a direct CDN link. */
    async _checkTorboxApi(processedFilename) {
      const tb = this.constructor._torboxConfig();
      const apiKey = tb.tb_api_key || tb.tb_webdav_password;
      if (!apiKey) return null;

      const match = matchWebdl(await this._torboxWebdlList(apiKey), processedFilename);
      if (!match) return null;
      const [webId, fileId] = match;

      let url;
      try {
        const resp = await this.apiClient.rawRequest('GET', `${TORBOX_API}/webdl/requestdl`, {
          params: { token: apiKey, web_id: webId, file_id: fileId },
          timeout: 10,
        });
        if (!resp || !resp.ok) throw new Error(`HTTP ${resp ? resp.status : 'no response'}`);
        url = (await resp.json()).data;
      } catch (exc) {
        logger.error('❌ %s TorBox requestdl error: %s', this.logPrefix, exc.message);
        return null;
      }
      if (!url || typeof url !== 'string') return null;

      logger.debug("✅ %s File '%s' found via TorBox API.", this.logPrefix, processedFilename);
      return [{ url, manifest_type: 'video', title: '✅ [TorBox] DRM-Free Video', filename: processedFilename }];
    }

    /** Check the TorBox WebDAV for a pre-processed file.
     *
     * TorBox stores each download in a folder named after the file, so the path
     * is `{tb_webdav_url}/{filename}/{filename}`.
     */
    async _checkTorboxWebdav(processedFilename) {
      const tb = this.constructor._torboxConfig();
      const base = tb.tb_webdav_url;
      const user = tb.tb_webdav_username;
      const password = tb.tb_webdav_password;
      if (!(base && user && password)) return null;

      const name = encodeURIComponent(processedFilename);
      const url = `${base.replace(/\/+$/, '')}/${name}/${name}`;
      try {
        const resp = await this.apiClient.rawRequest('HEAD', url, { auth: [user, password], timeout: 10 });
        if (!resp || resp.status !== 200) return null;
      } catch (exc) {
        logger.error('❌ %s TorBox WebDAV error: %s', this.logPrefix, exc.message);
        return null;
      }

      // ponytail: credentials inline in the URL — Stremio can't send per-stream auth
      // headers; switch to a local proxy endpoint if TorBox ever rejects userinfo URLs.
      const [scheme, rest] = url.split('://');
      const authUrl = `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${rest}`;
      logger.debug("✅ %s File '%s' found on TorBox.", this.logPrefix, processedFilename);
      return [{ url: authUrl, manifest_type: 'video', title: '✅ [TorBox] DRM-Free Video', filename: processedFilename }];
    }

    /** Check the Real-Debrid folder for a pre-processed file. */
    async _checkRdFolder(processedFilename) {
      try {
        const rdFolder = loadCredentials().realdebridfolder;
        if (!rdFolder) return null;
        const rdHeaders = {
          'User-Agent': getRandomWindowsUA(),
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
          DNT: '1',
          Connection: 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Cache-Control': 'max-age=0',
        };
        const resp = await this.apiClient.rawRequest('GET', rdFolder, { headers: rdHeaders, timeout: 10 });
        if (resp && resp.status === 200 && (await resp.text()).includes(processedFilename)) {
          const url = `${rdFolder.replace(/\/+$/, '')}/${processedFilename}`;
          logger.debug("✅ %s File '%s' found in RD folder.", this.logPrefix, processedFilename);
          return [{ url, manifest_type: 'video', title: '✅ [RD] DRM-Free Video', filename: processedFilename }];
        }
      } catch (exc) {
        logger.error('❌ %s RD folder error: %s', this.logPrefix, exc.message);
      }
      return null;
    }

    /** Whether a DRM-free processed file already exists.
     *
     * Returns a single-element stream list so callers can forward it straight
     * to the router, consistent with the StreamInfo[] contract.
     */
    async _checkProcessedFile(episodeId) {
      if (!drmProcessingEnabled()) return null;

      const processorUrl = this.proxyConfig.getProxy('nm3u8_processor');
      if (!processorUrl) {
        logger.error('❌ %s nm3u8_processor not configured', this.logPrefix);
        return null;
      }

      const processedFilename = `${episodeId}.mp4`;
      logger.debug('✅ %s Looking for processed file: %s', this.logPrefix, processedFilename);

      // Order: TorBox → Real-Debrid → processor website
      for (const check of [this._checkTorbox, this._checkRdFolder]) {
        const result = await check.call(this, processedFilename);
        if (result) return result;
      }

      const processedUrl = `${processorUrl}/stream/${processedFilename}`;
      try {
        const checkResp = await this.apiClient.rawRequest('HEAD', processedUrl, { timeout: 5 });
        if (checkResp && checkResp.status === 200) {
          logger.debug('✅ %s Processed file exists at processor URL.', this.logPrefix);
          return [{ url: processedUrl, manifest_type: 'video', title: '✅ DRM-Free Video', filename: processedFilename }];
        }
      } catch (exc) {
        logger.error('❌ %s Error checking processor URL: %s', this.logPrefix, exc.message);
      }

      return null;
    }

    /** The placeholder stream shown while background processing runs. */
    _makeProcessingPlaceholder(started) {
      if (started) {
        return {
          url: PROCESSING_PLACEHOLDER_URL,
          manifest_type: 'video',
          title: '⏳ DRM-Free Video (Processing in background...)',
          description: 'Processing in progress. Please check back in a few minutes.',
        };
      }
      return {
        url: PROCESSING_PLACEHOLDER_URL,
        manifest_type: 'video',
        title: '❌ DRM Processing Failed',
        description: 'DRM processing could not be started. Please try again later.',
      };
    }

    /** Kick off background DRM processing and return a placeholder stream.
     *
     * Returns null when processing is disabled, so callers add no placeholder.
     */
    async _startDrmProcessing(videoUrl, saveName, { key = null, keys = null } = {}) {
      if (!drmProcessingEnabled()) return null;

      const result = await processDrmSimple({
        url: videoUrl, saveName, key, keys, quality: 'best', format: 'mkv',
      });
      const started = Boolean(result.success);
      if (started) {
        logger.debug('✅ %s Background DRM processing started', this.logPrefix);
      } else {
        logger.error('⚠️ %s Background DRM processing failed to start: %s', this.logPrefix, result.error);
      }
      return this._makeProcessingPlaceholder(started);
    }
  };
}
