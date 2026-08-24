/**
 * Build a MediaFlow proxy URL with h_ header params and optional DRM license support.
 *
 * Mirrors the simple pattern used in TVVoo:
 * `${base}${path}?d=<dest>&api_password=<psw>&h_<k>=<v>`.
 * Header keys are passed as lowercased names after the `h_` prefix, consistent
 * with MediaFlow.
 *
 * @param {Object} opts
 * @param {string} opts.baseUrl         MediaFlow proxy base URL
 * @param {string} opts.password        MediaFlow API password
 * @param {string} opts.destinationUrl  target stream URL to proxy
 * @param {string} [opts.endpoint]      MediaFlow endpoint path (defaults to HLS proxy)
 * @param {Object} [opts.requestHeaders] headers to pass through to destination
 * @param {string} [opts.licenseUrl]    DRM license server URL (Widevine/FairPlay)
 * @param {Object} [opts.licenseHeaders] headers to pass to the license server
 * @param {Object} [opts.extraParams]   additional query parameters (e.g. DRM keys)
 */
export function buildMediaflowUrl({
  baseUrl,
  password,
  destinationUrl,
  endpoint = null,
  requestHeaders = null,
  licenseUrl = null,
  licenseHeaders = null,
  extraParams = null,
}) {
  const path = (endpoint || '/proxy/hls/manifest.m3u8').replace(/^\/+/, '');
  const base = baseUrl.replace(/\/+$/, '');

  const q = new URLSearchParams();
  q.append('d', destinationUrl);
  q.append('api_password', password);

  if (requestHeaders) {
    for (const [k, v] of Object.entries(requestHeaders)) {
      if (v === null || v === undefined) continue;
      q.append(`h_${k.toLowerCase()}`, v);
    }
  }

  if (licenseUrl) q.append('license_url', licenseUrl);

  if (extraParams) {
    for (const [k, v] of Object.entries(extraParams)) {
      if (v === null || v === undefined) continue;
      q.append(String(k), v);
    }
  }

  if (licenseHeaders) {
    for (const [k, v] of Object.entries(licenseHeaders)) {
      if (v === null || v === undefined) continue;
      q.append(`license_h_${k.toLowerCase()}`, v);
    }
  }

  return `${base}/${path}?${q.toString()}`;
}
