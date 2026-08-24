/**
 * Unified API client with robust error handling and retry logic.
 *
 * Built on the global `fetch` (Node 18+), with User-Agent rotation and IP
 * header forwarding.  Used directly by all providers via BaseProvider.
 *
 * ponytail: no session/connection-pool object — Node's fetch keeps its own
 * keep-alive agent, so the requests.Session + HTTPAdapter pair has no JS
 * counterpart to port. Per-provider default headers live on the instance.
 */
import { getLogger } from './logger.js';
import { mergeIpHeaders } from './clientIp.js';
import { getRandomWindowsUA } from './userAgent.js';
import { safeJsonParse } from './jsonParser.js';
import { CookieJar } from './cookieJar.js';

const logger = getLogger('utils.apiClient');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Append `params` to `url` as a query string. */
export function withParams(url, params) {
  if (!params) return url;
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  if (!entries.length) return url;
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return url + (url.includes('?') ? '&' : '?') + qs;
}

/** Serialise an object as application/x-www-form-urlencoded. */
export function formEncode(data) {
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/**
 * Provider-specific HTTP client with retry logic and error handling.
 *
 * Features:
 * - User-Agent rotation per request
 * - IP header forwarding for geo-restricted content
 * - Provider-prefixed logging
 */
export class ProviderAPIClient {
  constructor(providerName, timeout = 15, maxRetries = 3) {
    this.providerName = providerName;
    this.timeout = timeout;
    this.maxRetries = maxRetries;
    /** Default headers merged into every request (BaseProvider sets a UA here). */
    this.headers = {};
    /** Cookies persist across this client's requests, as requests.Session did. */
    this.cookies = new CookieJar();
  }

  /** Run one fetch with the jar's cookies attached, recording any it returns. */
  async _fetch(url, init) {
    const cookieHeader = this.cookies.header(url);
    if (cookieHeader) init.headers = { ...init.headers, Cookie: cookieHeader };
    const response = await fetch(url, init);
    this.cookies.store(response.url || url, response);
    return response;
  }

  /** Prepare headers with User-Agent rotation and IP forwarding.
   *
   * The rotated UA wins over anything the caller passed, matching the Python
   * client (requests merges case-insensitively, so a lower-case `user-agent`
   * from the caller is dropped here rather than sent as a second header).
   */
  _prepareHeaders(headers = null, rotateUa = true) {
    const current = { ...this.headers, ...(headers || {}) };
    if (rotateUa) {
      delete current['user-agent'];
      current['User-Agent'] = getRandomWindowsUA();
    }
    return mergeIpHeaders(current);
  }

  /**
   * Make a safe API request with retry logic and error handling.
   * Returns the parsed JSON body, or `null` when every attempt failed.
   */
  async safeRequest(method, url, options = {}) {
    const {
      params = null,
      headers = null,
      data = null,
      jsonData = null,
      timeout = null,
      maxRetries = null,
    } = options;

    const retries = maxRetries || this.maxRetries;
    const reqTimeout = (timeout || this.timeout) * 1000;
    const target = withParams(url, params);

    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        const currentHeaders = this._prepareHeaders(headers);
        logger.debug(
          '🔍 [%s] %s attempt %d/%d: %s',
          this.providerName, method, attempt + 1, retries, target,
        );

        const init = { method: method.toUpperCase(), headers: currentHeaders, signal: AbortSignal.timeout(reqTimeout) };

        if (init.method === 'POST') {
          if (jsonData) {
            init.body = JSON.stringify(jsonData);
            init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
          } else if (data) {
            const ct = currentHeaders['Content-Type'] || currentHeaders['content-type'] || '';
            if (ct === 'application/x-www-form-urlencoded') {
              init.body = typeof data === 'string' ? data : formEncode(data);
            } else {
              init.body = typeof data === 'string' ? data : JSON.stringify(data);
              init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
            }
          }
        }

        const response = await this._fetch(target, init);

        if (response.status === 200) {
          const text = await response.text();
          const result = safeJsonParse(response, text, `[${this.providerName}]`);
          if (result !== null) return result;
          if (attempt < retries - 1) {
            await sleep(2 ** attempt * 1000);
            continue;
          }
        } else if ([403, 429, 500, 502, 503].includes(response.status)) {
          logger.warning('⚠️ [%s] HTTP %s', this.providerName, response.status);
          if (attempt < retries - 1) {
            await sleep(2 ** attempt * 1000);
            continue;
          }
        } else {
          const text = await response.text().catch(() => '');
          logger.warning('⚠️ [%s] HTTP %s: %s', this.providerName, response.status, text.slice(0, 200));
          // 404 and friends answer the same way every time — retrying only
          // multiplies the wait (CBC season probing hits these).
          return null;
        }
      } catch (e) {
        if (e.name === 'TimeoutError' || e.name === 'AbortError') {
          logger.warning('⏰ [%s] Timeout on attempt %d', this.providerName, attempt + 1);
        } else {
          logger.warning('⚠️ [%s] Request error: %s', this.providerName, e.message);
        }
        if (attempt < retries - 1) {
          await sleep(2 ** attempt * 1000);
          continue;
        }
      }
    }

    logger.error('❌ [%s] All %d attempts failed for %s...', this.providerName, retries, target.slice(0, 60));
    return null;
  }

  /** Convenience method for GET requests. */
  get(url, options = {}) {
    return this.safeRequest('GET', url, options);
  }

  /** Convenience method for POST requests. */
  post(url, options = {}) {
    return this.safeRequest('POST', url, options);
  }

  /**
   * Make a raw request and return the fetch Response (non-JSON callers).
   * Returns `null` on a transport error.
   */
  async rawRequest(method, url, options = {}) {
    const {
      headers = null,
      params = null,
      timeout = null,
      body = null,
      auth = null,
      redirect = 'follow',
    } = options;
    try {
      const currentHeaders = this._prepareHeaders(headers);
      if (auth) {
        currentHeaders.Authorization = `Basic ${Buffer.from(`${auth[0]}:${auth[1]}`).toString('base64')}`;
      }
      return await this._fetch(withParams(url, params), {
        method: method.toUpperCase(),
        headers: currentHeaders,
        body,
        redirect,
        signal: AbortSignal.timeout((timeout || this.timeout) * 1000),
      });
    } catch (e) {
      logger.error('❌ [%s] Raw request error: %s', this.providerName, e.message);
      return null;
    }
  }

  /** Read a Response as JSON, returning `null` on any failure. */
  static async json(response) {
    if (!response) return null;
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  /** Nothing to release — fetch owns its own connection pool. */
  close() {}
}
