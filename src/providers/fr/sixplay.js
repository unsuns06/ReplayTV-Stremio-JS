import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getLogger } from '../../utils/logger.js';
import { SixPlayAuth } from '../../auth/sixplayAuth.js';
import { extractPsshFromMpd } from '../../utils/drm/psshExtractor.js';
import { normalizeKeyId, normalizeDecryptionKey } from '../../utils/encoding.js';
import { getRandomWindowsUA } from '../../utils/userAgent.js';
import { getProgramsForProvider } from '../../utils/programsLoader.js';
import { loadAuthState, storeAuthState } from '../../utils/authCache.js';
import { getLogoUrl } from '../../utils/baseUrl.js';
import { cache } from '../../utils/cache.js';
import { CacheKeys, CacheTTL } from '../../utils/cacheKeys.js';
import { BaseProvider, safeProviderCall } from '../baseProvider.js';
import { withDrmProcessedFiles } from '../drmMixin.js';
import { htmlUnescape } from './metadata.js';
import { Cdm } from '../../widevine/cdm.js';
import { Device } from '../../widevine/device.js';
import { PSSH } from '../../widevine/pssh.js';

const logger = getLogger('providers.sixplay');
const HERE = path.dirname(fileURLToPath(import.meta.url));

// DRMtoday only issues licenses to this UA — same value for replay and live.
const DRM_UA = 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/59.0.3041.0 Safari/537.36';
const DRM_LICENSE_URL = 'https://lic.drmtoday.com/license-proxy-widevine/cenc/';
const UPFRONT_TOKEN_BASE = 'https://drm.6cloud.fr/v1/customers/m6web/platforms/m6group_web';
// Every 6play image is addressed by its external_key.
const IMAGE_URL = 'https://images.6play.fr/v1/images/{}/raw';

const imageUrl = (key) => IMAGE_URL.replace('{}', key);

export class SixPlayProvider extends withDrmProcessedFiles(BaseProvider) {
  static providerName = '6play';
  static baseUrl = 'https://www.6play.fr';
  static country = 'fr';

  // Metadata
  static displayName = '6play';
  static idPrefix = 'cutam:fr:6play';
  static episodeMarker = 'episode:';
  static catalogId = 'fr-6play-replay';
  static defaultChannel = 'm6';
  static supportsLive = true;

  // Artwork field -> 6play image role. Anything already set in programs.json
  // takes precedence; the API only fills what is missing.
  // Roles are tried in order: not every program publishes a fullColorLogo
  // (66 minutes Grand Format has only the plain "logo").
  static IMAGE_ROLES = {
    logo: ['logo', 'fullColorLogo'],
    poster: ['cover'],
    background: ['jumbotron'],
    fanart: ['jumbotron'],
  };

  // Live channels: [slug, display name, 6play live key, description].
  // The live key is the slug upper-cased except for the two the API renames.
  static LIVE_CHANNELS = [
    ['m6', 'M6', 'M6', 'Chaîne généraliste du groupe M6'],
    ['w9', 'W9', 'W9', 'Chaîne de divertissement du groupe M6'],
    ['6ter', '6ter', '6T', 'Chaîne familiale du groupe M6'],
    ['gulli', 'Gulli', 'gulli', 'Chaîne jeunesse du groupe M6'],
  ];

  constructor(req = null) {
    super(req);

    // 6play-specific API endpoints
    this.apiUrl = 'https://android.middleware.6play.fr/6play/v2/platforms/m6group_androidmob/services/6play';
    this.authUrl = 'https://login-gigya.m6.fr/accounts.login';
    this.tokenUrl = 'https://6cloud.fr/v1/customers/m6web/platforms/m6group_web/services/6play/users';
    this.liveUrl = 'https://android.middleware.6play.fr/6play/v2/platforms/m6group_androidmob/services/6play/live';
    this.apiKey = '3_hH5KBv25qZTd_sURpixbQW6a4OsiIzIEF2Ei_2H7TXTGLJb_1Hr4THKZianCQhWK';

    // 6play-specific authentication state
    this.accountId = null;
    this.loginToken = null;
    this._authAttempted = false;

    this.shows = getProgramsForProvider('6play');
  }

  /** Pre-authenticate so no viewer pays for the API-key scrape + Gigya login. */
  async warmAuth() {
    const creds = this.credentials || {};
    if (!(creds.username || creds.login) || !creds.password) return null;
    return this._authenticate();
  }

  /** Authenticate the session for 6play using real Gigya authentication.
   *
   * Follows the Kodi plugin approach: Gigya login for a JWT that unlocks DRM
   * content, graceful fallback to unauthenticated access for free content, and
   * a cached auth state so a per-request provider instance does not re-login.
   */
  async _authenticate() {
    try {
      if (this._authenticated) return true;
      if (this._authAttempted) return false;

      const cached = loadAuthState(this.providerName);
      if (cached && cached.account_id && cached.login_token) {
        this.accountId = cached.account_id;
        this.loginToken = cached.login_token;
        this._authenticated = true;
        logger.debug('✅ [SixPlay] Using cached auth tokens');
        return true;
      }

      const creds = this.credentials || {};
      const username = creds.username || creds.login;
      const password = creds.password;

      // If tokens are pre-provisioned, use them directly
      if (creds.account_id && creds.login_token) {
        this.accountId = creds.account_id;
        this.loginToken = creds.login_token;
        this._authenticated = true;
        logger.debug('✅ [SixPlay] Using preset 6play account_id/login_token from credentials');
        return true;
      }

      // No credentials: allow unauthenticated access (HLS-only paths may work)
      if (!username || !password) {
        logger.warning('⚠️ [SixPlay] No 6play credentials found; continuing without authentication');
        logger.warning('⚠️ [SixPlay] Note: DRM content will not be accessible without valid credentials');
        this._authenticated = true; // mark as 'handled' so callers reach non-DRM paths
        return true;
      }

      const auth = new SixPlayAuth(username, password);
      if (await auth.login()) {
        const authData = auth.getAuthData();
        if (authData) {
          [this.accountId, this.loginToken] = authData;
          this._authenticated = true;
          storeAuthState(
            this.providerName,
            { account_id: this.accountId, login_token: this.loginToken },
            this.loginToken,
          );
          logger.debug('✅ [SixPlay] 6play authentication succeeded');
          logger.debug('🔑 [SixPlay] Account ID: %s', this.accountId);
          logger.debug('🔑 [SixPlay] JWT Token: %s...', String(this.loginToken).slice(0, 20));
          return true;
        }
      }

      logger.error('❌ [SixPlay] 6play authentication failed');
      this._authAttempted = true;
      return false;
    } catch (e) {
      logger.error('❌ [SixPlay] Authentication error: %s', e.message);
      this._authAttempted = true;
      return false;
    }
  }

  /** Resolve the program_id for a slug, then return the raw video list. */
  async _fetchEpisodesRaw(slug) {
    let programId = (this.shows[slug] || {}).api_id;
    if (programId) {
      logger.debug('✅ [SixPlay] Using hardcoded program ID: %s', programId);
    } else {
      programId = await this._findProgramId(slug);
    }
    if (!programId) {
      logger.error('❌ [SixPlay] No program ID found for show: %s', slug);
      return null;
    }
    return this._fetchRawVideos(programId);
  }

  /** Streams for a 6play episode: pre-processed file(s) *and* the direct source. */
  async getEpisodeStreamUrl(episodeId) {
    const actualEpisodeId = this._extractAfterMarker(episodeId);
    try {
      // The processed-file lookup, the login and the asset list are three
      // independent round trips — the asset API is unauthenticated, so none of
      // them has to wait for the others.
      const [existingResult, authOk, videoAssets] = await Promise.all([
        this._checkProcessedFile(actualEpisodeId),
        this._authenticated ? true : this._authenticate(),
        this._fetchVideoAssets(actualEpisodeId),
      ]);
      const existing = existingResult || [];

      if (!authOk) {
        logger.error('❌ [SixPlay] 6play authentication failed');
        return existing.length ? existing : null;
      }

      if (!videoAssets) return existing.length ? existing : null;

      const [url, fmt] = await this._selectBestAsset(videoAssets);
      if (!url) {
        logger.warning('⚠️ [SixPlay] No stream URL found for %s', actualEpisodeId);
        return existing.length ? existing : null;
      }
      logger.debug('✅ [SixPlay] Selected %s stream', fmt ? fmt.toUpperCase() : 'unknown');
      if (fmt === 'hls') {
        const direct = this._buildDirectStream(url, 'hls');
        return [...existing, direct || { url, manifest_type: 'hls' }];
      }
      // Don't re-download something that is already processed.
      return [...existing, ...(await this._handleMpdStream(url, actualEpisodeId, !existing.length))];
    } catch (e) {
      logger.error('❌ [SixPlay] Error getting stream for %s: %s', actualEpisodeId, e.message);
      return null;
    }
  }

  /** Call the 6play video API and return the assets list for the episode. */
  async _fetchVideoAssets(episodeId) {
    const headers = this._mergeIpHeaders({ 'User-Agent': getRandomWindowsUA() });
    // The web platform's HD asset carries a 1080p rendition; the androidmob one
    // is named upTo1080p but tops out at 720p.  Same default_KID, so the DRM
    // path is untouched — only the manifest has more to choose from.
    const url = 'https://pc.middleware.6play.fr/6play/v2/platforms/m6group_web/services/6play/videos/'
      + `${episodeId}?csa=6&with=clips,freemiumpacks`;
    const response = await this.apiClient.rawRequest('GET', url, { headers });
    if (!response || response.status !== 200) {
      logger.error('❌ [SixPlay] Video API error %s for %s',
        response ? response.status : 'no response', episodeId);
      return null;
    }
    const clips = (await response.json()).clips || [];
    if (!clips.length) {
      logger.error('❌ [SixPlay] No clips in API response for %s', episodeId);
      return null;
    }
    return clips[0].assets || null;
  }

  /** The per-episode DRM upfront token from 6cloud. */
  async _fetchDrmToken(episodeId) {
    return this._fetchUpfrontToken(`services/m6replay/users/${this.accountId}/videos/${episodeId}/upfront-token`);
  }

  /** The per-channel live DRM upfront token from 6cloud. */
  async _fetchLiveDrmToken(liveKey) {
    return this._fetchUpfrontToken(`services/6play/users/${this.accountId}/live/dashcenc_${liveKey}/upfront-token`);
  }

  /** Fetch a DRM upfront token from 6cloud (*path* is appended to the base). */
  async _fetchUpfrontToken(urlPath) {
    if (!this.accountId || !this.loginToken) return null;
    try {
      const headers = this._mergeIpHeaders({
        'X-Customer-Name': 'm6web',
        'X-Client-Release': '5.103.3',
        Authorization: `Bearer ${this.loginToken}`,
      });
      const response = await this.apiClient.rawRequest('GET', `${UPFRONT_TOKEN_BASE}/${urlPath}`, { headers });
      if (response && response.status === 200) {
        const token = (await response.json()).token;
        logger.debug('✅ [SixPlay] DRM token obtained');
        return token;
      }
      logger.error('❌ [SixPlay] DRM token request failed: %s', response ? response.status : 'no response');
      return null;
    } catch (e) {
      logger.error('❌ [SixPlay] DRM token fetch error: %s', e.message);
      return null;
    }
  }

  /** licenseUrl / licenseHeaders for DRM-protected streams. */
  _buildDrmLicenseInfo(drmToken) {
    const licenseUrl = `${DRM_LICENSE_URL}`
      + `|Content-Type=&User-Agent=${DRM_UA}`
      + `&Host=lic.drmtoday.com&x-dt-auth-token=${drmToken}`
      + '|R{SSM}|JBlicense';
    return {
      licenseUrl,
      licenseHeaders: { 'User-Agent': DRM_UA },
      drm_token: drmToken,
      drm_protected: true,
    };
  }

  // Background DRM processing + placeholder streams come from the DRM mixin.

  /** Extract PSSH and key ID from an MPD manifest.
   * @returns {Promise<[PsshRecord|null, string|null, Object]>}
   */
  async _extractMpdDrmInfo(videoUrl) {
    const [psshRecord, , drmInfo] = await extractPsshFromMpd(videoUrl, 'SixPlay');
    const keyIdHex = normalizeKeyId((drmInfo || {}).key_id);
    if (keyIdHex) logger.debug('[SixPlay] MPD default_KID: %s', keyIdHex);

    const stream = { url: videoUrl, manifest_type: 'mpd' };
    if (keyIdHex) stream.default_kid = keyIdHex;
    if (psshRecord) {
      stream.pssh = psshRecord.base64Text;
      stream.pssh_system_id = psshRecord.systemId;
      stream.pssh_source = psshRecord.source;
      logger.debug('[SixPlay] PSSH included in stream');
    } else {
      logger.warning('[SixPlay] No PSSH found in MPD manifest');
    }
    return [psshRecord, keyIdHex, stream];
  }

  /** Extract and normalize a Widevine decryption key. */
  async _acquireDecryptionKey(psshRecord, keyIdHex, drmToken) {
    if (!psshRecord || !drmToken) return null;
    const rawKey = await this._extractWidevineKey(psshRecord.base64Text, drmToken, keyIdHex);
    if (!rawKey) {
      logger.error('[SixPlay] CDRM did not return a Widevine key');
      return null;
    }
    // Normalize against the KID actually returned, not the requested one: on a
    // mismatch normalizeDecryptionKey falls back to a bare 32-hex search and
    // would hand back the KID itself as if it were the key.
    const normalized = normalizeDecryptionKey(rawKey, rawKey.split(':')[0]);
    if (!normalized) logger.error('[SixPlay] Unable to normalize Widevine key');
    return normalized;
  }

  /** Orchestrate the MPD/DASH DRM flow: extract PSSH, acquire key, build streams. */
  async _handleMpdStream(videoUrl, episodeId, startProcessing = true) {
    // Reading the manifest and minting the upfront token are unrelated calls to
    // different hosts; running them together saves a full round trip (~370ms)
    // before the licence request that needs both can even start.
    const [[psshRecord, keyIdHex, stream], drmToken] = await Promise.all([
      this._extractMpdDrmInfo(videoUrl),
      this._fetchDrmToken(episodeId),
    ]);

    const decryptionKey = await this._cachedDecryptionKey(psshRecord, keyIdHex, drmToken);
    const streams = [];
    const direct = this._buildDirectStream(videoUrl, 'mpd', keyIdHex, decryptionKey, drmToken);
    if (direct) streams.push(direct);

    if (decryptionKey) {
      stream.decryption_key = decryptionKey;
      this._printDownloadCommand(videoUrl, decryptionKey, episodeId);
      // _startDrmProcessing returns null when the drm_processing toggle is off
      // — appending it would put a null in the stream list.
      const placeholder = startProcessing
        ? await this._startDrmProcessing(videoUrl, episodeId, { key: decryptionKey })
        : null;
      if (placeholder) streams.push(placeholder);
      // streams is empty only if MediaFlow is unconfigured too — fall back to
      // the raw manifest.
      return streams.length ? streams : [stream];
    }

    // No key: hand the player the raw manifest and let it license the stream.
    if (drmToken) Object.assign(stream, this._buildDrmLicenseInfo(drmToken));
    else logger.warning('[SixPlay] No DRM token — returning basic MPD stream');
    streams.push(stream);
    return streams;
  }

  /** MediaFlow-proxied stream straight from 6play's CDN. Null if MediaFlow is off.
   *
   * Same mechanics as the live path: when the Widevine key was extracted
   * locally MediaFlow decrypts the CENC segments itself (`key_id`/`key`);
   * otherwise it is pointed at DRMtoday to license the stream on its own.
   */
  _buildDirectStream(videoUrl, fmt, keyIdHex = null, key = null, drmToken = null) {
    let licenseUrl = null;
    let licenseHeaders = null;
    let keyParams = null;
    if (key && keyIdHex) {
      keyParams = { key_id: keyIdHex, key };
    } else if (drmToken) {
      licenseUrl = `${DRM_LICENSE_URL}?specConform=true`;
      licenseHeaders = { 'x-dt-auth-token': drmToken, 'User-Agent': DRM_UA };
    }

    const proxied = this._buildMediaflowProxiedUrl(videoUrl, fmt, {
      licenseUrl, licenseHeaders, extraParams: keyParams,
    });
    if (!proxied) {
      logger.debug('⚠️ [SixPlay] MediaFlow not configured — no direct source stream');
      return null;
    }

    const stream = {
      url: proxied,
      manifest_type: fmt,
      title: `🌐 [${fmt.toUpperCase()}] Direct source (MediaFlow)`,
      headers: this._buildStreamHeaders(),
    };
    if (licenseUrl) {
      stream.licenseUrl = licenseUrl;
      stream.licenseHeaders = licenseHeaders;
    }
    return stream;
  }

  // ------------------------------------------------------------------
  // Live channels
  // ------------------------------------------------------------------

  async getLiveChannels() {
    return SixPlayProvider.LIVE_CHANNELS.map(([slug, name, , desc]) => {
      const logo = getLogoUrl('fr', slug, this.req);
      return {
        id: `cutam:fr:6play:${slug}`,
        type: 'channel',
        name,
        poster: logo,
        logo,
        description: desc,
      };
    });
  }

  /** The current live diffusion entry for a channel, or null. */
  async _fetchLiveEntry(liveKey) {
    return safeProviderCall(this, '_fetchLiveEntry', null, async () => {
      const headers = this._mergeIpHeaders({
        'User-Agent': getRandomWindowsUA(),
        'x-customer-name': 'm6web',
      });
      const params = { channel: liveKey, with: 'service_display_images,nextdiffusion,extra_data' };
      const response = await this.apiClient.rawRequest('GET', this.liveUrl, { headers, params });
      if (!response || response.status !== 200) {
        logger.error('❌ [SixPlay] Live API error %s for %s',
          response ? response.status : 'no response', liveKey);
        return null;
      }
      const entries = (await response.json())[liveKey] || [];
      if (!entries.length) {
        logger.error('❌ [SixPlay] No live entry for channel %s', liveKey);
        return null;
      }
      return entries[0];
    });
  }

  /** The live stream for a 6play channel (DASH+Widevine via MediaFlow). */
  async getChannelStreamUrl(channelId) {
    const slug = this._extractSlug(channelId);
    const channel = SixPlayProvider.LIVE_CHANNELS.find((c) => c[0] === slug);
    if (!channel) {
      logger.error('❌ [SixPlay] Unknown live channel: %s', slug);
      return null;
    }
    const [, name, liveKey] = channel;

    try {
      if (!this._authenticated && !(await this._authenticate())) {
        logger.error('❌ [SixPlay] 6play authentication failed');
        return null;
      }
      if (!(this.accountId && this.loginToken)) {
        logger.error('❌ [SixPlay] Live streams need 6play credentials (no account_id/login_token)');
        return null;
      }

      const entry = await this._fetchLiveEntry(liveKey);
      const assets = entry?.live?.assets;
      if (!assets) {
        logger.error('❌ [SixPlay] No live assets for %s', liveKey);
        return null;
      }

      const [url, fmt] = await this._selectBestAsset(assets, true);
      if (!url) {
        logger.error('❌ [SixPlay] No usable live asset for %s', liveKey);
        return null;
      }

      return [await this._buildLiveStreamInfo(url, fmt, liveKey, entry, name)];
    } catch (e) {
      logger.error('❌ [SixPlay] Error getting live stream for %s: %s', slug, e.message);
      return null;
    }
  }

  /** Widevine content key, cached by KID (used by both live and replay).
   *
   * ponytail: the cache is keyed on the MPD's `default_KID`, so a key rotation
   * publishes a new KID, misses the cache and re-licenses by itself — no
   * rotation schedule to track. If 6play ever ships several KIDs in one
   * manifest, switch to a per-Period key map here.
   */
  async _cachedDecryptionKey(psshRecord, keyIdHex, drmToken) {
    if (!(psshRecord && keyIdHex && drmToken)) return null;
    const cacheKey = CacheKeys.providerResource(this.providerName, `wv_key:${keyIdHex}`);
    const cached = cache.get(cacheKey);
    if (cached) {
      logger.debug('✅ [SixPlay] Live key served from cache (KID %s)', keyIdHex);
      return cached;
    }
    const key = await this._acquireDecryptionKey(psshRecord, keyIdHex, drmToken);
    if (key) cache.set(cacheKey, key, CacheTTL.STREAM);
    return key;
  }

  /** Assemble the live stream object, adding DRM license info for DASH assets. */
  async _buildLiveStreamInfo(url, fmt, liveKey, entry, channelName) {
    let licenseUrl = null;
    let licenseHeaders = null;
    let keyParams = null;
    if (fmt === 'mpd') {
      // Same independent pair as the replay path: token and manifest together.
      const [drmToken, [psshRecord, keyIdHex]] = await Promise.all([
        this._fetchLiveDrmToken(liveKey),
        this._extractMpdDrmInfo(url),
      ]);
      if (drmToken) {
        licenseUrl = `${DRM_LICENSE_URL}?specConform=true`;
        licenseHeaders = { 'x-dt-auth-token': drmToken, 'User-Agent': DRM_UA };
        const key = await this._cachedDecryptionKey(psshRecord, keyIdHex, drmToken);
        if (key) {
          // MediaFlow decrypts the CENC segments itself with this pair.
          keyParams = { key_id: keyIdHex, key };
          logger.debug('✅ [SixPlay] Live key extracted: %s:%s', keyIdHex, key);
        } else {
          logger.warning('⚠️ [SixPlay] No live Widevine key — falling back to license URL');
        }
      } else {
        logger.warning('⚠️ [SixPlay] No live DRM token — stream will likely not play');
      }
    }

    const proxied = this._buildMediaflowProxiedUrl(url, fmt, {
      licenseUrl, licenseHeaders, extraParams: keyParams,
    });
    const program = (entry || {}).title;
    const stream = {
      url: proxied || url,
      manifest_type: fmt,
      title: `[${fmt.toUpperCase()}] ${program || channelName}`,
      headers: this._buildStreamHeaders(),
    };
    if (licenseUrl) {
      stream.licenseUrl = licenseUrl;
      stream.licenseHeaders = licenseHeaders;
    }
    return stream;
  }

  /** Pick the best [url, format] from an asset list, or [null, null]. */
  async _selectBestAsset(assets, isLive = false) {
    const typeOrder = isLive
      ? ['http_h264', 'usp_dashcenc_h264', 'dashcenc']
      : ['usp_dashcenc_h264', 'dashcenc', 'http_h264'];
    const qualityRank = { hd: 1, sd: 0 };
    for (const atype of typeOrder) {
      const matches = assets
        .filter((a) => (a.type || '').includes(atype))
        .map((a) => [qualityRank[(a.video_quality || 'sd').toLowerCase()] ?? 0, a]);
      if (!matches.length) continue;
      const best = matches.sort((x, y) => y[0] - x[0])[0][1];
      let url = best.full_physical_path || '';
      if (!url) continue;
      const fmt = atype.includes('http_h264') ? 'hls' : 'mpd';
      if (fmt === 'mpd') url = await this._resolveCdnUrl(url);
      return [url, fmt];
    }
    return [null, null];
  }

  /** Follow 6cloud's signed redirect to the real CDN host.
   *
   * `lbcdn.6cloud.fr` 302s to the bedrock edge and serves a manifest whose
   * SegmentTemplate paths are root-relative (`/m6web/output/...`), so segments
   * are fetched from whatever host the manifest was fetched from. Hand
   * MediaFlow the signed lbcdn URL and every segment 404s — the redirect has to
   * be resolved here, before the URL leaves the provider.
   */
  async _resolveCdnUrl(url) {
    const resp = await this.apiClient.rawRequest('GET', url, { redirect: 'follow' });
    if (resp) {
      try {
        if (resp.status < 400 && resp.url) {
          if (resp.url !== url) logger.debug('🔀 [SixPlay] Resolved CDN redirect → %s', resp.url);
          return resp.url;
        }
        logger.debug('⚠️ [SixPlay] Direct CDN resolve returned %s — trying fr_router', resp.status);
      } finally {
        // Headers only — the body is never read.
        resp.body?.cancel?.().catch(() => {});
      }
    }
    return (await this._resolveViaRouter(url)) || url;
  }

  /** Resolve a signed URL through the fr_router proxy.
   *
   * lbcdn is geo-restricted: from outside France the redirect itself answers
   * 403, so the direct resolve above yields nothing and the signed URL would
   * leak to MediaFlow.  fr_router answers from a French IP with a meta-refresh
   * page naming the resolved URL, which works from any host.
   */
  async _resolveViaRouter(url) {
    const routed = this._getGeoProxyUrl(url, 'fr_router');
    if (!routed) return null;
    const resp = await this.apiClient.rawRequest('GET', routed);
    if (!resp || resp.status !== 200) {
      logger.warning('⚠️ [SixPlay] fr_router resolve failed (%s) — keeping signed URL',
        resp ? resp.status : 'no response');
      return null;
    }
    const match = (await resp.text()).match(/url=['"]([^'"]+)/);
    if (!match) {
      logger.warning('⚠️ [SixPlay] fr_router returned no redirect target');
      return null;
    }
    // The target sits in an HTML attribute, so its '&' separators are &amp;-escaped.
    const final = htmlUnescape(match[1]);
    logger.debug('🔀 [SixPlay] Resolved via fr_router → %s', final);
    return final;
  }

  /** Locate the WVD device file, or null. */
  static loadWidevineDevice() {
    const candidates = [
      path.join(HERE, 'device.wvd'),
      './device.wvd',
      path.join(os.homedir(), '.pywidevine', 'device.wvd'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try {
          const device = Device.load(candidate);
          logger.debug('✅ [SixPlay] WVD device loaded from %s', candidate);
          return device;
        } catch (loadErr) {
          logger.warning('⚠️ [SixPlay] Failed to load WVD %s: %s', candidate, loadErr.message);
        }
      }
    }
    return null;
  }

  /** Extract the Widevine decryption key using the local CDM.
   *
   * Sends the license challenge directly to lic.drmtoday.com with the supplied
   * DRM token — no external key-extraction API required.  When *keyIdHex* is
   * given, the matching key is preferred over the first one (a license can
   * carry several KIDs).  Returns a `kid:key_hex` string, or null on failure.
   */
  async _extractWidevineKey(psshValue, drmToken, keyIdHex = null) {
    const device = SixPlayProvider.loadWidevineDevice();
    if (!device) {
      logger.error('❌ [SixPlay] No valid WVD device file found');
      return null;
    }

    let cdm = null;
    let sessionId = null;
    try {
      logger.debug('🔑 [SixPlay] Extracting Widevine key (local CDM)...');
      logger.debug('📋   PSSH: %s...', psshValue.slice(0, 50));

      const pssh = new PSSH(psshValue);
      cdm = Cdm.fromDevice(device);
      sessionId = cdm.open();

      const challenge = cdm.getLicenseChallenge(sessionId, pssh);
      logger.debug('📋 [SixPlay] License challenge generated: %d bytes', challenge.length);

      const licenseUrl = `${DRM_LICENSE_URL}?specConform=true`;
      const response = await fetch(licenseUrl, {
        method: 'POST',
        headers: {
          'User-Agent': DRM_UA,
          'x-dt-auth-token': drmToken,
          'Content-Type': 'application/octet-stream',
        },
        body: challenge,
        signal: AbortSignal.timeout(15_000),
      });
      logger.debug('📋 [SixPlay] License server: %s', response.status);

      if (response.status !== 200) {
        const text = await response.text().catch(() => '');
        logger.error('❌ [SixPlay] License server error %s: %s', response.status, text.slice(0, 300));
        return null;
      }

      cdm.parseLicense(sessionId, Buffer.from(await response.arrayBuffer()));

      const contentKeys = {};
      for (const k of cdm.getKeys(sessionId, 'CONTENT')) {
        contentKeys[k.kid.replace(/-/g, '').toLowerCase()] = k.key.toString('hex');
      }
      if (!Object.keys(contentKeys).length) {
        logger.error('❌ [SixPlay] No CONTENT keys found in license response');
        return null;
      }

      const wanted = (keyIdHex || '').toLowerCase();
      if (wanted && !(wanted in contentKeys)) {
        logger.warning('⚠️ [SixPlay] KID %s absent from license (%d key(s)) — using first',
          wanted, Object.keys(contentKeys).length);
      }
      const kidHex = wanted in contentKeys ? wanted : Object.keys(contentKeys)[0];
      logger.debug('✅ [SixPlay] Widevine key extracted: %s:%s', kidHex, contentKeys[kidHex]);
      return `${kidHex}:${contentKeys[kidHex]}`;
    } catch (e) {
      logger.error('❌ [SixPlay] Widevine key extraction failed: %s', e.message);
      return null;
    } finally {
      if (cdm && sessionId) {
        try {
          cdm.close(sessionId);
        } catch { /* already closed */ }
      }
    }
  }

  /** Print the N_m3u8DL-RE download command with the decryption key. */
  _printDownloadCommand(videoUrl, decryptionKey, contentId) {
    try {
      const cleanName = contentId.replace(/[:/\\]/g, '_');
      const displayUrl = videoUrl.length > 100 ? `${videoUrl.slice(0, 100)}...` : videoUrl;

      logger.debug('\n📥 N_m3u8DL-RE Download Command:');
      logger.debug('./N_m3u8DL-RE "%s" --save-name "%s" --select-video best --select-audio all --select-subtitle all -mt -M format=mkv --log-level OFF --binary-merge --key %s',
        videoUrl, cleanName, decryptionKey);
      logger.debug('\n🔗 URL: %s', displayUrl);
      logger.debug('🔑 Key: %s', decryptionKey);
      logger.debug('💾 Save as: %s', cleanName);
    } catch (e) {
      logger.error('❌ [SixPlay] Error printing download command: %s', e.message);
    }
  }

  async _getShowApiMetadata(showId, showInfo) {
    return safeProviderCall(this, '_getShowApiMetadata', {}, async () => {
      const programId = showInfo.api_id || (await this._findProgramId(showId));
      if (!programId) return {};
      const programData = await this._cachedPayload(
        `program:${programId}`, () => this._fetchProgram(showId, programId),
      );
      return programData ? this._imagesFromProgram(programData, showInfo) : {};
    });
  }

  async _fetchProgram(showId, programId) {
    const url = `${this.apiUrl}/programs/${programId}?with=links,subcats,rights`;
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' };
    const response = await this.apiClient.rawRequest('GET', url, { headers: this._mergeIpHeaders(headers) });
    if (!response || response.status !== 200) {
      logger.error('❌ [SixPlay] Failed to get program data for %s: %s',
        showId, response ? response.status : 'no response');
      return null;
    }
    return response.json();
  }

  /** Map the 6play program payload onto show fields. Precedence: _pickFields. */
  _imagesFromProgram(programData, showInfo) {
    const keys = {};
    for (const img of programData.images || []) {
      if (img.external_key) keys[img.role] = img.external_key;
    }
    const candidates = {};
    for (const [field, roles] of Object.entries(SixPlayProvider.IMAGE_ROLES)) {
      candidates[field] = roles.filter((r) => r in keys).map((r) => imageUrl(keys[r]));
    }
    const diffusions = programData.next_diffusions || [];
    // No channel field exists: the upcoming broadcast names it ("M6"), and the
    // service code ("m6replay") covers shows with nothing scheduled.
    const service = programData.service_display?.code || '';
    const genre = programData.program_type_wording?.singular || '';
    const year = programData.year_production || '';
    candidates.description = [programData.description, programData.summary];
    candidates.channel = [
      diffusions.length ? diffusions[0].channel : null,
      service.replace('replay', '').toUpperCase() || null,
    ];
    // str.capitalize(): first character upper, the rest lower ("JT" -> "Jt").
    candidates.genres = [genre ? [genre.charAt(0).toUpperCase() + genre.slice(1).toLowerCase()] : null];
    candidates.year = [/^\d+$/.test(String(year)) ? parseInt(year, 10) : null];
    candidates.rating = [programData.csa?.label];
    return this._pickFields(candidates, showInfo);
  }

  /** Cached wrapper around `_resolveProgramId`.
   *
   * The lookup pulls the whole first-letter program list (limit=999), and a
   * single detail-page load asks for the ID twice — once for the episodes, once
   * for the artwork. Cache it for the programs TTL.
   */
  async _findProgramId(showId) {
    const key = CacheKeys.providerResource(this.providerName, `program_id:${showId}`);
    let programId = cache.get(key);
    if (programId === null) {
      programId = await this._resolveProgramId(showId);
      if (programId) cache.set(key, programId, CacheTTL.PROGRAMS);
    }
    return programId;
  }

  /** Find the program ID for a show using the 6play programs API.
   *
   * 1. Look up the show's display name from programs.json ("66 minutes").
   * 2. Query the 6play programs API filtered by the first letter of that name.
   * 3. Match the API's `title` against the show name (exact, then partial).
   * 4. Fall back to Algolia search if the programs API fails.
   */
  async _resolveProgramId(showId) {
    let showName = null;
    if (showId in this.shows) showName = this.shows[showId].name;
    if (!showName) showName = showId.replace(/-/g, ' ');

    /** Lowercase, collapse hyphens/colons/extra spaces for comparison. */
    const normalize = (s) => String(s).toLowerCase().replace(/-/g, ' ').replace(/:/g, ' ')
      .replace(/\s+/g, ' ').trim();

    const normSearch = normalize(showName);

    // --- Strategy 1: the 6play programs API ---
    try {
      let firstLetter = showName ? showName[0].toLowerCase() : 'a';
      // '@' is used by the API for names starting with a digit / special char
      if (!/[a-z]/i.test(firstLetter)) firstLetter = '@';

      const programsUrl = 'https://android.middleware.6play.fr/6play/v2/platforms/'
        + 'm6group_androidmob/services/6play/programs';
      const params = {
        limit: '999', offset: '0', csa: '6', firstLetter, with: 'rights',
      };
      const headers = { 'User-Agent': getRandomWindowsUA(), 'x-customer-name': 'm6web' };

      logger.debug("🔍 [SixPlay] Searching programs API for '%s' (letter=%s)", showName, firstLetter);
      const response = await this.apiClient.rawRequest('GET', programsUrl, {
        params, headers: this._mergeIpHeaders(headers), timeout: 10,
      });

      if (response && response.status === 200) {
        const programs = await response.json();
        let partialMatch = null;

        for (const prog of programs) {
          const progTitle = prog.title || '';
          const progId = String(prog.id ?? '');
          const normTitle = normalize(progTitle);

          if (normTitle === normSearch) {
            logger.debug("✅ [SixPlay] Programs API exact match: '%s' (ID: %s)", progTitle, progId);
            return progId;
          }
          if (!partialMatch && (normTitle.includes(normSearch) || normSearch.includes(normTitle))) {
            partialMatch = [progId, progTitle];
          }
        }

        if (partialMatch) {
          logger.debug("✅ [SixPlay] Programs API partial match: '%s' (ID: %s)", partialMatch[1], partialMatch[0]);
          return partialMatch[0];
        }

        logger.warning("⚠️ [SixPlay] Programs API returned no match for '%s', trying Algolia…", showName);
      } else {
        logger.warning('⚠️ [SixPlay] Programs API HTTP %s, trying Algolia…',
          response ? response.status : 'no response');
      }
    } catch (e) {
      logger.error('⚠️ [SixPlay] Programs API error: %s, trying Algolia…', e.message);
    }

    // --- Strategy 2: Algolia search (fallback) ---
    try {
      const algoliaHosts = [
        'nhacvivxxk-dsn.algolia.net',
        'NHACVIVXXK-1.algolianet.com',
        'NHACVIVXXK-2.algolianet.com',
        'NHACVIVXXK-3.algolianet.com',
      ];
      const searchHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-algolia-api-key': '6ef59fc6d78ac129339ab9c35edd41fa',
        'x-algolia-application-id': 'NHACVIVXXK',
      };
      const searchData = {
        requests: [{
          indexName: 'rtlmutu_prod_bedrock_layout_items_v2_m6web_main',
          query: showName,
          params: 'clickAnalytics=true&hitsPerPage=10&facetFilters=[["metadata.item_type:program"], ["metadata.platforms_assets:m6group_web"]]',
        }],
      };

      let response = null;
      for (const host of algoliaHosts) {
        try {
          logger.debug('🔍 [SixPlay] Trying Algolia host: %s', host);
          response = await this.apiClient.rawRequest('POST', `https://${host}/1/indexes/*/queries`, {
            headers: this._mergeIpHeaders(searchHeaders),
            body: JSON.stringify(searchData),
            timeout: 5,
          });
          if (response && response.status === 200) break;
        } catch (e) {
          logger.error('⚠️ [SixPlay] Error with Algolia host %s: %s', host, e.message);
        }
      }

      if (!response || response.status !== 200) {
        logger.error('❌ [SixPlay] All Algolia hosts failed or returned error');
        return null;
      }

      const data = await response.json();
      let partialMatch = null;

      for (const result of data.results || []) {
        for (const hit of result.hits || []) {
          const title = hit.item.itemContent.title;
          const programId = String(hit.content.id);
          const normTitle = normalize(title);
          if (normTitle === normSearch) {
            logger.debug("✅ [SixPlay] Algolia exact match: '%s' (ID: %s)", title, programId);
            return programId;
          }
          if (!partialMatch && (normTitle.includes(normSearch) || normSearch.includes(normTitle))) {
            partialMatch = [programId, title];
          }
        }
      }

      if (partialMatch) {
        logger.debug("✅ [SixPlay] Algolia partial match: '%s' (ID: %s)", partialMatch[1], partialMatch[0]);
        return partialMatch[0];
      }

      logger.error("❌ [SixPlay] No program ID found for show '%s' (slug=%s)", showName, showId);
      return null;
    } catch (e) {
      logger.error('❌ [SixPlay] Error finding program ID for %s: %s', showId, e.message);
      return null;
    }
  }

  async _fetchRawVideos(programId) {
    return safeProviderCall(this, '_fetchRawVideos', null, async () => {
      const url = 'https://android.middleware.6play.fr/6play/v2/platforms/'
        + `m6group_androidmob/services/6play/programs/${programId}`
        + '/videos?csa=6&with=clips,freemiumpacks&type=vi&limit=999&offset=0';
      const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' };
      const response = await this.apiClient.rawRequest('GET', url, { headers: this._mergeIpHeaders(headers) });
      if (response && response.status === 200) {
        const videos = await response.json();
        return videos && videos.length ? videos : null;
      }
      logger.error('❌ [SixPlay] Failed to get episodes: %s', response ? response.status : 'no response');
      return null;
    });
  }

  async _parseEpisode(video, episodeNumber) {
    return safeProviderCall(this, '_parseEpisode', null, async () => {
      const videoId = String(video.id ?? '');
      const title = video.title ?? '';
      const description = video.description ?? '';
      const duration = video.duration ?? '';
      let poster = null;
      let fanart = null;
      for (const img of video.images || []) {
        if (['vignette', 'carousel'].includes(img.role) && img.external_key) {
          poster = imageUrl(img.external_key);
          fanart = poster;
          break;
        }
      }
      let broadcastDate = null;
      let released = '';
      if (video.clips?.length) {
        const firstDiff = video.clips[0].product?.first_diffusion || '';
        if (firstDiff) {
          broadcastDate = firstDiff.slice(0, 10);
          released = `${firstDiff.replace(' ', 'T')}.000Z`;
        }
      }
      if (!released && video.publication_date) {
        const pubDate = video.publication_date;
        broadcastDate = broadcastDate || pubDate.slice(0, 10);
        released = `${pubDate.replace(' ', 'T')}.000Z`;
      }
      const episodeInfo = {
        id: `cutam:fr:6play:episode:${videoId}`,
        type: 'episode',
        title,
        description,
        poster,
        fanart,
        episode: episodeNumber,
        duration,
        broadcast_date: broadcastDate,
      };
      if (released) episodeInfo.released = released;
      return episodeInfo;
    });
  }
}
