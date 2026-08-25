/** How long a signed CDN URL is still worth handing to a player.
 *
 * Providers return URLs that carry their own expiry, and some are far shorter
 * than they look: CBC's master playlist is signed with an Akamai token whose
 * window is 120 seconds (`hdnea=st=…~exp=…`). Caching such a URL for the
 * stream TTL means every viewer after the first two minutes is handed a link
 * that answers 403 — and keeps answering 403 until the cache entry expires.
 *
 * Nothing here tries to validate the signature; it only reads the expiry the
 * URL states about itself.
 */

/** Epoch seconds this URL stops being accepted, or null if it does not say. */
export function urlExpirySeconds(url) {
  if (!url || typeof url !== 'string') return null;

  // Akamai (`~exp=`/`&exp=`), CloudFront/S3 (`Expires=`), and the plain
  // `expires=` a few CDNs use. Seconds since the epoch, 10 digits and up.
  const patterns = [/[?&~]exp=(\d{10,})/i, /[?&~]expires=(\d{10,})/i];
  const found = [];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) found.push(Number(match[1]));
  }
  if (!found.length) return null;
  // The earliest expiry is the one that bites first.
  return Math.min(...found);
}

/**
 * Seconds this URL may be cached for, never past its own expiry.
 *
 * @param {string} url
 * @param {number} fallbackSeconds  used when the URL states no expiry
 * @param {number} safetySeconds    shaved off, so a URL handed out at the last
 *                                  moment still has time to be opened
 * @returns {number} 0 when the URL is already dead — do not cache it at all
 */
export function ttlForSignedUrl(url, fallbackSeconds, safetySeconds = 15) {
  const expiry = urlExpirySeconds(url);
  if (expiry === null) return fallbackSeconds;
  const remaining = Math.floor(expiry - Date.now() / 1000 - safetySeconds);
  if (remaining <= 0) return 0;
  return Math.min(fallbackSeconds, remaining);
}

/** The shortest cacheable lifetime across a list of streams. */
export function ttlForStreams(streams, fallbackSeconds, safetySeconds = 15) {
  const ttls = (streams || [])
    .map((s) => s?.url)
    .filter(Boolean)
    .map((url) => ttlForSignedUrl(url, fallbackSeconds, safetySeconds));
  if (!ttls.length) return fallbackSeconds;
  return Math.min(...ttls);
}
