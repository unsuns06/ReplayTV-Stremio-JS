import { networkInterfaces } from 'node:os';

import { getLogger } from '../utils/logger.js';
import { formEncode } from '../utils/apiClient.js';
import { cache } from '../utils/cache.js';

const logger = getLogger('auth.sixplay');

const API_KEY_CACHE_KEY = 'sixplay:gigya_api_key';
const API_KEY_TTL = 3600; // 1 hour

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

/** A stable per-machine device id, the way uuid.getnode() gave Python one. */
function machineDeviceId() {
  let mac = '000000000000';
  for (const addrs of Object.values(networkInterfaces())) {
    const found = (addrs || []).find((a) => a.mac && a.mac !== '00:00:00:00:00:00');
    if (found) {
      mac = found.mac.replace(/:/g, '');
      break;
    }
  }
  const hex = mac.padStart(32, '0');
  return `_luid_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Real 6play authentication implementation based on the Gigya API. */
export class SixPlayAuth {
  constructor(username = null, password = null) {
    this.username = username;
    this.password = password;
    this.sessionToken = null;
    this.accountId = null;
    this.deviceId = machineDeviceId();

    // API endpoints
    this.loginUrl = 'https://login-gigya.m6.fr/accounts.login';
    this.tokenUrl = 'https://front-auth.6cloud.fr/v2/platforms/m6group_web/getJwt';
    this.apiKeyUrl = 'https://www.6play.fr/connexion';
    this.jsBundleUrl = 'https://www.6play.fr/main-%s.bundle.js';

    // Default API key (fallback)
    this.defaultApiKey = '3_hH5KBv25qZTd_sURpixbQW6a4OsiIzIEF2Ei_2H7TXTGLJb_1Hr4THKZianCQhWK';

    // Patterns for extracting the API key and JS ID
    this.patternApiKey = /"eu1\.gigya\.com",key:"(.*?)"/;
    this.patternJsId = /main-(.*?)\.bundle\.js/;
  }

  /** Get the current API key from the 6play website.
   *
   * Cached: the scrape is two page loads, and www.6play.fr/connexion currently
   * answers 500 (~0.8s) before the default key gets used anyway. The key rotates
   * rarely, so an hour of reuse costs nothing and a rotation is still picked up
   * on the next warm sweep.
   */
  async _getApiKey() {
    const cached = cache.get(API_KEY_CACHE_KEY);
    if (cached) return cached;
    const key = await this._scrapeApiKey();
    // The fallback is cached too — a page 500ing now will still 500 in a minute.
    cache.set(API_KEY_CACHE_KEY, key, API_KEY_TTL);
    return key;
  }

  async _scrapeApiKey() {
    try {
      const headers = { 'User-Agent': UA };

      const response = await fetch(this.apiKeyUrl, { headers, signal: AbortSignal.timeout(10_000) });
      const text = await response.text();
      const jsIdMatch = text.match(this.patternJsId);

      if (!jsIdMatch) {
        logger.warning('[SixPlayAuth] Could not find JS ID, using default API key');
        return this.defaultApiKey;
      }

      const bundleResponse = await fetch(this.jsBundleUrl.replace('%s', jsIdMatch[1]), {
        headers, signal: AbortSignal.timeout(10_000),
      });
      const bundleText = await bundleResponse.text();
      const apiKeyMatch = bundleText.match(this.patternApiKey);

      if (!apiKeyMatch) {
        logger.warning('[SixPlayAuth] Could not extract API key from bundle, using default');
        return this.defaultApiKey;
      }

      logger.debug('[SixPlayAuth] Successfully extracted API key: %s...', apiKeyMatch[1].slice(0, 20));
      return apiKeyMatch[1];
    } catch (e) {
      logger.error('[SixPlayAuth] Error getting API key: %s', e.message);
      return this.defaultApiKey;
    }
  }

  /** Authenticate with 6play using the Gigya API. */
  async login() {
    try {
      if (!this.username || !this.password) {
        logger.warning('[SixPlayAuth] No credentials provided');
        return false;
      }

      const apiKey = await this._getApiKey();

      const payload = {
        loginID: this.username,
        password: this.password,
        apiKey,
        format: 'jsonp',
        callback: 'jsonp_3bbusffr388pem4',
      };

      logger.info('[SixPlayAuth] Attempting login for user: %s', this.username);

      const response = await fetch(this.loginUrl, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          Referer: 'https://www.6play.fr/connexion',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formEncode(payload),
        signal: AbortSignal.timeout(10_000),
      });

      // Parse the JSONP response
      const text = await response.text();
      const jsonText = text.replace('jsonp_3bbusffr388pem4(', '').replace(/\);?\s*$/, '');
      const jsonData = JSON.parse(jsonText);

      if (!('UID' in jsonData)) {
        logger.error('[SixPlayAuth] Login failed: %s', jsonData.errorMessage || 'Unknown error');
        return false;
      }

      this.accountId = jsonData.UID;
      const accountTimestamp = jsonData.signatureTimestamp;
      const accountSignature = jsonData.UIDSignature;

      logger.info('[SixPlayAuth] Gigya login successful, account ID: %s', this.accountId);

      const tokenResponse = await fetch(this.tokenUrl, {
        headers: {
          'x-auth-gigya-signature': accountSignature,
          'x-auth-gigya-signature-timestamp': String(accountTimestamp),
          'x-auth-gigya-uid': this.accountId,
          'x-auth-device-id': this.deviceId,
          'x-customer-name': 'm6web',
        },
        signal: AbortSignal.timeout(10_000),
      });
      const tokenData = await tokenResponse.json();

      this.sessionToken = tokenData.token;

      logger.debug('[SixPlayAuth] JWT token obtained: %s...', String(this.sessionToken).slice(0, 20));
      return true;
    } catch (e) {
      logger.error('[SixPlayAuth] Login error: %s', e.message);
      return false;
    }
  }

  /** Whether we have a valid session. */
  isAuthenticated() {
    return this.sessionToken !== null && this.accountId !== null;
  }

  /** Authentication data for API calls: [accountId, sessionToken] or null. */
  getAuthData() {
    return this.isAuthenticated() ? [this.accountId, this.sessionToken] : null;
  }

  /** Refresh the authentication session. */
  refreshSession() {
    return this.login();
  }
}
