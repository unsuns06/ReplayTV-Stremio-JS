/** A per-client cookie jar — the one thing `requests.Session` gave the Python
 * providers that `fetch` does not.
 *
 * It matters: TF1's Gigya login only accepts a request carrying the `gmid`
 * cookie that `accounts.webSdkBootstrap` set moments earlier, and answers
 * "Invalid parameter value" without it.
 *
 * ponytail: domain matching and Max-Age=0 deletion only — no path scoping, no
 * expiry clock, no secure/samesite rules. The jar lives as long as one provider
 * instance (one request), so a cookie cannot outlive its usefulness anyway.
 */

/** Parse one Set-Cookie header line into `{name, value, domain, remove}`. */
function parseSetCookie(line, requestHost) {
  const parts = String(line).split(';');
  const [rawName, ...rawValue] = parts[0].split('=');
  const name = rawName.trim();
  if (!name) return null;
  const value = rawValue.join('=').trim();

  let domain = requestHost;
  let remove = false;
  for (const attr of parts.slice(1)) {
    const [key, ...rest] = attr.split('=');
    const attrName = key.trim().toLowerCase();
    const attrValue = rest.join('=').trim();
    if (attrName === 'domain' && attrValue) domain = attrValue.replace(/^\./, '').toLowerCase();
    if (attrName === 'max-age' && Number(attrValue) <= 0) remove = true;
    if (attrName === 'expires' && Date.parse(attrValue) <= Date.now()) remove = true;
  }
  return { name, value, domain, remove };
}

function domainMatches(cookieDomain, host) {
  return host === cookieDomain || host.endsWith(`.${cookieDomain}`);
}

export class CookieJar {
  constructor() {
    this._cookies = new Map(); // `${domain}|${name}` -> {name, value, domain}
  }

  /** Record the Set-Cookie headers of a response to *url*. */
  store(url, response) {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    if (!setCookies.length) return;
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return;
    }
    for (const line of setCookies) {
      const cookie = parseSetCookie(line, host);
      if (!cookie) continue;
      const key = `${cookie.domain}|${cookie.name}`;
      if (cookie.remove) this._cookies.delete(key);
      else this._cookies.set(key, cookie);
    }
  }

  /** The `Cookie` header value for *url*, or null when nothing matches. */
  header(url) {
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
    const matching = [...this._cookies.values()].filter((c) => domainMatches(c.domain, host));
    if (!matching.length) return null;
    return matching.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  clear() {
    this._cookies.clear();
  }
}
