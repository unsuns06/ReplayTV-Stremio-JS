/**
 * Base URL utility for serving static assets.
 * Handles proper URL construction for deployed environments.
 */

/**
 * Get the base URL for serving static assets.
 *
 * Priority order:
 * 1. ADDON_BASE_URL environment variable (if set)
 * 2. Constructed from the current request (if available)
 * 3. Default fallback
 */
export function getBaseUrl(req = null) {
  const envBaseUrl = process.env.ADDON_BASE_URL;
  if (envBaseUrl) return envBaseUrl.replace(/\/+$/, '');

  if (req) {
    // Behind a proxy Express fills these from X-Forwarded-* when `trust proxy`
    // is enabled (see app.js), which is what a deployed instance needs.
    const scheme = req.protocol || 'http';
    const hostHeader = req.get?.('host') || req.headers?.host || 'localhost:7860';
    const [host, port] = hostHeader.startsWith('[')
      ? [hostHeader.slice(0, hostHeader.indexOf(']') + 1), hostHeader.split(']:')[1]]
      : hostHeader.split(':');
    if (port && !['80', '443'].includes(port)) return `${scheme}://${host}:${port}`;
    return `${scheme}://${host}`;
  }

  return 'http://localhost:7860';
}

/** Complete URL for a static asset (e.g. "static/logos/fr/france2.png"). */
export function getStaticUrl(assetPath, req = null) {
  const base = getBaseUrl(req);
  const p = assetPath.startsWith('/') ? assetPath : `/${assetPath}`;
  return `${base}${p}`;
}

/** Complete URL for a channel logo. */
export function getLogoUrl(provider, channel, req = null) {
  return getStaticUrl(`static/logos/${provider}/${channel}.png`, req);
}
