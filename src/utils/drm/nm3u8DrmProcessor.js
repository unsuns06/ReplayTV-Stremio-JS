/** DRM content processor backed by the N_m3u8DL-RE remote API. */
import { getProxyConfig } from '../proxyConfig.js';

/** Offloads DRM-protected downloads to an N_m3u8DL-RE API endpoint. */
export class SimpleDRMProcessor {
  constructor(apiUrl = null) {
    const url = apiUrl ?? getProxyConfig().getProxy('nm3u8_processor');
    if (!url) throw new Error('nm3u8_processor is not configured');
    this.apiUrl = url.replace(/\/+$/, '');
  }

  /**
   * Start a DRM processing job and return immediately.
   *
   * @param {Object} opts
   * @param {string} opts.url        DRM-protected content URL
   * @param {string} opts.saveName   name for the output file
   * @param {string} [opts.key]      single DRM decryption key (use `keys` instead)
   * @param {string[]} [opts.keys]   DRM decryption keys for multi-key content
   * @param {string} [opts.quality]  video quality selection
   * @param {string} [opts.format]   output format (mkv, mp4, …)
   */
  async processDrmContent({ url, saveName, key = null, keys = null, quality = 'best', format = 'mkv' }) {
    const payload = {
      url,
      save_name: saveName,
      select_video: quality,
      select_audio: 'all',
      select_subtitle: 'all',
      format,
      log_level: 'OFF',
      binary_merge: true,
    };

    if (keys) payload.keys = keys;
    else if (key) payload.key = key;
    else return { success: false, error: 'No decryption key(s) provided' };

    try {
      const response = await fetch(`${this.apiUrl}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return {
        success: true,
        job_id: data.job_id,
        status: 'processing_started',
        message: 'Processing started in background',
      };
    } catch (e) {
      return { success: false, error: `Failed to start processing: ${e.message}` };
    }
  }
}

/** Convenience wrapper around `SimpleDRMProcessor`. */
export async function processDrmSimple({ url, saveName, key = null, keys = null, ...opts }) {
  const apiUrl = opts.apiUrl ?? getProxyConfig().getProxy('nm3u8_processor');
  const processor = new SimpleDRMProcessor(apiUrl);
  return processor.processDrmContent({
    url,
    saveName,
    key,
    keys,
    quality: opts.quality ?? 'best',
    format: opts.format ?? 'mp4',
  });
}
