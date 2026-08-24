/**
 * CBC Gem Authentication Module.
 * Based on the yt-dlp CBC extractor implementation.
 */
import { getLogger } from '../utils/logger.js';
import { decodeJwt } from '../utils/authCache.js';
import { formEncode } from '../utils/apiClient.js';

const logger = getLogger('auth.cbc');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

/** Wraps a plain object in the get/set/delete interface used by the cache. */
class ObjectCacheAdapter {
  constructor(obj) {
    this._obj = obj;
  }

  get(key) {
    return this._obj[key] ?? null;
  }

  set(key, value) {
    this._obj[key] = value;
  }

  delete(key) {
    delete this._obj[key];
  }
}

/** CBC Gem OAuth 2.0 authenticator using the ROPC flow. */
export class CBCAuthenticator {
  static CLIENT_ID = 'fc05b0ee-3865-4400-a3cc-3da82c330c23';

  constructor(cacheHandler = null) {
    this.userAgent = UA;

    // Token storage
    this.refreshToken = null;
    this.accessToken = null;
    this.claimsToken = null;

    const raw = cacheHandler ?? {};
    this._cache = typeof raw.set === 'function' ? raw : new ObjectCacheAdapter(raw);

    // ROPC settings cache
    this._ropcSettings = null;
  }

  /** Get ROPC settings from the CBC API. */
  async getRopcSettings() {
    if (!this._ropcSettings) {
      try {
        const response = await fetch(
          'https://services.radio-canada.ca/ott/catalog/v1/gem/settings?device=web',
          { headers: { 'User-Agent': this.userAgent }, signal: AbortSignal.timeout(30_000) },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        this._ropcSettings = data.identityManagement.ropc;
        logger.info('Retrieved ROPC settings');
      } catch (e) {
        logger.error('Failed to get ROPC settings: %s', e.message);
        throw new Error(`Failed to get ROPC settings: ${e.message}`);
      }
    }
    return this._ropcSettings;
  }

  /** Whether a JWT is expired (with a 5 minute buffer). */
  _isJwtExpired(token) {
    if (!token) return true;
    const decoded = decodeJwt(token);
    if (!decoded) return true;
    const expTime = decoded.exp ?? 0;
    return expTime - Date.now() / 1000 < 300;
  }

  /** Call the CBC OAuth API. */
  async _callOauthApi(oauthData, note = 'OAuth API call') {
    const ropcSettings = await this.getRopcSettings();

    const data = {
      client_id: CBCAuthenticator.CLIENT_ID,
      scope: ropcSettings.scopes,
      ...oauthData,
    };

    let response;
    try {
      response = await fetch(ropcSettings.url, {
        method: 'POST',
        headers: {
          'User-Agent': this.userAgent,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formEncode(data),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      logger.error('Network error during %s: %s', note, e.message);
      throw new Error(`Network error: ${e.message}`);
    }

    logger.info('%s: Status %s', note, response.status);

    if (response.status === 400) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Authentication failed: ${errorData.error_description || 'Invalid credentials'}`);
    }
    if (!response.ok) throw new Error(`Network error: HTTP ${response.status}`);

    const tokenData = await response.json();

    this.refreshToken = tokenData.refresh_token ?? null;
    this.accessToken = tokenData.access_token ?? null;

    this._cache.set('cbc_refresh_token', this.refreshToken);
    this._cache.set('cbc_access_token', this.accessToken);

    logger.info('Successfully %s', note.toLowerCase());
    return tokenData;
  }

  /** Perform the initial login with a username/password pair. */
  async login(username, password) {
    try {
      this._loadCachedTokens();

      if (this.refreshToken && this.accessToken && !this._isJwtExpired(this.accessToken)) {
        logger.info('Using cached valid tokens');
        return true;
      }

      logger.info('Performing fresh login');
      await this._callOauthApi({ grant_type: 'password', username, password }, 'Login');

      return true;
    } catch (e) {
      logger.error('Login failed: %s', e.message);
      return false;
    }
  }

  _loadCachedTokens() {
    try {
      this.refreshToken = this._cache.get('cbc_refresh_token');
      this.accessToken = this._cache.get('cbc_access_token');
      this.claimsToken = this._cache.get('cbc_claims_token');
    } catch (e) {
      logger.error('Failed to load cached tokens: %s', e.message);
    }
  }

  /** A valid access token, refreshing if needed. */
  async getAccessToken() {
    if (this.accessToken && !this._isJwtExpired(this.accessToken)) return this.accessToken;

    if (this.refreshToken && !this._isJwtExpired(this.refreshToken)) {
      try {
        logger.info('Refreshing access token');
        await this._callOauthApi({ grant_type: 'refresh_token', refresh_token: this.refreshToken }, 'Refresh token');
        return this.accessToken;
      } catch (e) {
        logger.error('Token refresh failed: %s', e.message);
        this.refreshToken = null;
        this.accessToken = null;
        return null;
      }
    }

    logger.warning('No valid access token available');
    return null;
  }

  /** A valid claims token for content access. */
  async getClaimsToken() {
    if (this.claimsToken && !this._isJwtExpired(this.claimsToken)) return this.claimsToken;

    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      logger.error('No access token available for claims token');
      return null;
    }

    try {
      logger.info('Fetching claims token');
      const response = await fetch(
        'https://services.radio-canada.ca/ott/subscription/v2/gem/Subscriber/profile?device=web',
        {
          headers: { 'User-Agent': this.userAgent, Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(30_000),
        },
      );
      logger.info('Claims token API response: %s', response.status);

      if (response.status === 401) {
        logger.error('Access token expired or invalid when fetching claims token');
        this.accessToken = null;
        this.refreshToken = null;
        return null;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      this.claimsToken = data.claimsToken ?? null;

      if (!this.claimsToken) {
        logger.error('No claims token in response payload');
        logger.error(JSON.stringify(data).slice(0, 500));
        return null;
      }

      this._cache.set('cbc_claims_token', this.claimsToken);

      logger.info('Successfully fetched claims token');
      logger.info('Claims token (truncated): %s...', this.claimsToken.slice(0, 20));
      return this.claimsToken;
    } catch (e) {
      logger.error('Failed to get claims token: %s', e.message);
      return null;
    }
  }

  /** Headers with authentication tokens for API requests. */
  async getAuthenticatedHeaders() {
    const headers = {
      'User-Agent': this.userAgent,
      Referer: 'https://gem.cbc.ca/',
      Origin: 'https://gem.cbc.ca',
    };

    const claimsToken = await this.getClaimsToken();
    if (claimsToken) headers['x-claims-token'] = claimsToken;

    return headers;
  }

  /** Whether the user is properly authenticated. */
  async isAuthenticated() {
    return Boolean(await this.getAccessToken());
  }

  /** Clear all tokens and log out. */
  logout() {
    this.refreshToken = null;
    this.accessToken = null;
    this.claimsToken = null;

    this._cache.delete('cbc_refresh_token');
    this._cache.delete('cbc_access_token');
    this._cache.delete('cbc_claims_token');

    logger.info('Logged out successfully');
  }
}
