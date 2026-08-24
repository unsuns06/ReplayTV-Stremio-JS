import { getLogger } from '../../utils/logger.js';
import { getBaseUrl, getLogoUrl } from '../../utils/baseUrl.js';
import { extractPsshFromMpd } from '../../utils/drm/psshExtractor.js';
import { normalizeKeyId } from '../../utils/encoding.js';
import { getRandomWindowsUA } from '../../utils/userAgent.js';
import { getProgramsForProvider } from '../../utils/programsLoader.js';
import { BaseProvider, safeProviderCall } from '../baseProvider.js';
import { withDrmProcessedFiles } from '../drmMixin.js';
import { loadAuthState, storeAuthState } from '../../utils/authCache.js';

const logger = getLogger('providers.mytf1');

export class MyTF1Provider extends withDrmProcessedFiles(BaseProvider) {
  static providerName = 'mytf1';
  static baseUrl = 'https://www.tf1.fr';
  static country = 'fr';

  // Metadata
  static displayName = 'TF1+';
  static idPrefix = 'cutam:fr:mytf1';
  static episodeMarker = 'episode:';
  static catalogId = 'fr-mytf1-replay';
  static defaultChannel = 'tf1';
  static supportsLive = true;

  // TF1 mediainfo API version constants — one place, so upgrades are one line
  static LIVE_MEDIAINFO_PARAMS = {
    context: 'MYTF1', pver: '5029000', platform: 'web',
    device: 'desktop', os: 'windows', osVersion: '10.0',
    topDomain: 'www.tf1.fr', playerVersion: '5.29.0',
    productName: 'mytf1', productVersion: '3.37.0', format: 'hls',
  };

  static REPLAY_MEDIAINFO_PARAMS = {
    context: 'MYTF1', pver: '5010000', platform: 'web',
    device: 'desktop', os: 'linux', osVersion: 'unknown',
    topDomain: 'www.tf1.fr', playerVersion: '5.19.0',
    productName: 'mytf1', productVersion: '3.22.0',
  };

  // Artwork field -> GraphQL decoration key. Verified across all 500 programs
  // in the list: 'image' is always type PORTRAIT (700x933 card), 'background'
  // always type BACKGROUND, and 'logo' is the 450x225 logo-programme PNG.
  // There is no LOGO-typed entry — the logo only ever lives under its own key.
  static DECORATION_IMAGES = {
    logo: 'logo',
    poster: 'image',
    background: 'background',
    fanart: 'background',
  };

  static GIGYA_CONSENT_IDS = [
    '1', '2', '3', '4', '10001', '10003', '10005', '10007', '10013',
    '10015', '10017', '10019', '10009', '10011', '13002', '13001',
    '10004', '10014', '10016', '10018', '10020', '10010', '10012',
    '10006', '10008',
  ];

  // The programs list is the only TF1 endpoint carrying a show's logo,
  // description and categories — programBySlug returns none of them reliably —
  // and it can only be filtered by channel, never by name or slug.  The
  // unfiltered page (the 500 most prominent programs) is tried first, the four
  // channel lists after.  Every list is cached, so the second show usually
  // costs no request at all.
  static PROGRAM_LIST_FILTERS = [null, 'tf1', 'tmc', 'tfx', 'tf1-series-films'];

  get needsIpForwarding() {
    return true;
  }

  /** Pre-authenticate so no viewer pays for the 3-round-trip Gigya login. */
  async warmAuth() {
    if (!this.credentials.login || !this.credentials.password) return null;
    return this._authenticate();
  }

  constructor(req = null) {
    super(req);

    // TF1-specific API configuration
    this.apiKey = '3_hWgJdARhz_7l1oOp3a8BDLoR9cuWZpUaKG4aqF7gum9_iK3uTZ2VlDBl8ANf8FVk';
    this.apiUrl = 'https://www.tf1.fr/graphql/web';
    this.videoStreamUrl = 'https://mediainfo.tf1.fr/mediainfocombo';

    if (this.mediaflowUrl) {
      logger.debug('✅ [MyTF1] MediaFlow configured: %s...', this.mediaflowUrl.slice(0, 30));
    }
    logger.debug('✅ [MyTF1] MediaFlow Password: %s', this.mediaflowPassword ? '***' : 'None');

    this.staticBase = getBaseUrl(req);

    // TF1-specific auth endpoints
    this.accountsLogin = 'https://compte.tf1.fr/accounts.login';
    this.accountsBootstrap = 'https://compte.tf1.fr/accounts.webSdkBootstrap';
    this.tokenGigyaWeb = 'https://www.tf1.fr/token/gigya/web';
    this.licenseBaseUrl = 'https://drm-wide.tf1.fr/proxy?id=%s';

    this.authToken = null;

    this.shows = getProgramsForProvider('mytf1');
  }

  /** TF1-specific headers for video stream requests, extending the base set. */
  _buildStreamHeaders(authToken = null, extra = null) {
    return super._buildStreamHeaders(authToken || this.authToken, {
      'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8,en-US;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Charset': 'UTF-8,*;q=0.5',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
      'Sec-GPC': '1',
      DNT: '1',
      'Upgrade-Insecure-Requests': '1',
      ...(extra || {}),
    });
  }

  /** Validate the proxy delivery response for TF1 stream endpoints. */
  static validateTf1Delivery(data) {
    const delivery = data.delivery || {};
    return delivery.code === 200 && (delivery.country ?? 'US') !== 'US';
  }

  /** Extract the DRM license URL and headers from a delivery response. */
  _extractDrmInfo(delivery, videoId) {
    const drm = (delivery.drms || [{}])[0] || {};
    const licenseUrl = drm.url || this.licenseBaseUrl.replace('%s', videoId);
    const licenseHeaders = {};
    for (const h of drm.h || []) {
      if (h.k && h.v) licenseHeaders[h.k] = h.v;
    }
    return [licenseUrl, licenseHeaders];
  }

  /** Authenticate with TF1+ using the configured credentials. */
  async _authenticate() {
    // Reuse a token cached by a previous request (avoids 3 login round-trips
    // per stream request — provider instances are per-request).
    const cached = loadAuthState(this.providerName);
    if (cached && cached.auth_token) {
      this.authToken = cached.auth_token;
      this._authenticated = true;
      logger.debug('✅ [MyTF1] Using cached auth token');
      return true;
    }

    if (!this.credentials.login || !this.credentials.password) {
      logger.error('❌ [MyTF1] MyTF1 credentials not provided');
      return false;
    }

    try {
      logger.debug('✅ [MyTF1] Attempting MyTF1 authentication...');

      // Bootstrap — authentication calls go DIRECT, never through the proxy
      logger.debug('✅ [MyTF1] Making DIRECT bootstrap request to: %s', this.accountsBootstrap);
      const bootstrapData = await this.apiClient.get(this.accountsBootstrap, {
        headers: this._buildIpHeaders({ referrer: this.baseUrl }),
        params: {
          apiKey: this.apiKey,
          pageURL: 'https%3A%2F%2Fwww.tf1.fr%2F',
          sd: 'js_latest',
          sdkBuild: '13987',
          format: 'json',
        },
      });
      if (!bootstrapData) {
        logger.error('❌ [MyTF1] Bootstrap failed');
        return false;
      }

      // Login
      logger.debug('✅ [MyTF1] Making DIRECT login request to: %s', this.accountsLogin);
      const loginData = await this.apiClient.post(this.accountsLogin, {
        headers: this._buildIpHeaders({
          'Content-Type': 'application/x-www-form-urlencoded',
          referrer: this.baseUrl,
        }),
        data: {
          loginID: this.credentials.login,
          password: this.credentials.password,
          sessionExpiration: 31536000,
          targetEnv: 'jssdk',
          include: 'identities-all,data,profile,preferences,',
          includeUserInfo: 'true',
          loginMode: 'standard',
          lang: 'fr',
          APIKey: this.apiKey,
          sdk: 'js_latest',
          authMode: 'cookie',
          pageURL: this.baseUrl,
          sdkBuild: 13987,
          format: 'json',
        },
      });

      if (loginData && loginData.errorCode === 0) {
        // Get the Gigya token — also DIRECT
        logger.debug('✅ [MyTF1] Making DIRECT JWT token request to: %s', this.tokenGigyaWeb);
        const jwtData = await this.apiClient.post(this.tokenGigyaWeb, {
          headers: this._buildIpHeaders({ 'content-type': 'application/json' }),
          data: {
            uid: loginData.userInfo.UID,
            signature: loginData.userInfo.UIDSignature,
            timestamp: parseInt(loginData.userInfo.signatureTimestamp, 10),
            consent_ids: [...MyTF1Provider.GIGYA_CONSENT_IDS],
          },
        });

        if (jwtData && jwtData.token) {
          this.authToken = jwtData.token;
          this._authenticated = true;
          storeAuthState(this.providerName, { auth_token: this.authToken }, this.authToken);
          logger.debug('✅ [MyTF1] MyTF1 authentication successful!');
          logger.debug('✅ [MyTF1] Session token generated: %s...', this.authToken.slice(0, 20));
          return true;
        }
        logger.error('❌ [MyTF1] Failed to get Gigya token');
      } else {
        logger.error('❌ [MyTF1] MyTF1 login failed: %s', loginData ? (loginData.errorMessage || 'Unknown error') : 'No response');
      }
    } catch (e) {
      logger.error('❌ [MyTF1] Error during MyTF1 authentication: %s', e.message);
    }

    return false;
  }

  // _buildShowMetadata: the base implementation already filters null values out
  // of the API-metadata extras, so no override is needed.

  /** Live TV channels from TF1+. */
  async getLiveChannels() {
    const ch = (name, slug, desc) => {
      const logo = getLogoUrl('fr', slug, this.req);
      return { id: `cutam:fr:mytf1:${slug}`, type: 'channel', name, poster: logo, logo, description: desc };
    };
    return [
      ch('TF1', 'tf1', 'Première chaîne de télévision privée française'),
      ch('TMC', 'tmc', 'Chaîne de télévision du groupe TF1'),
      ch('TFX', 'tfx', 'Chaîne de divertissement du groupe TF1'),
      ch('TF1 Séries Films', 'tf1-series-films', 'Chaîne dédiée aux séries et films du groupe TF1'),
    ];
  }

  /** Auth, resolve the program via GraphQL, and return the raw video items. */
  async _fetchEpisodesRaw(slug) {
    if (!this._authenticated && !(await this._authenticate())) {
      logger.error('❌ [MyTF1] MyTF1 authentication failed');
      return null;
    }

    const headers = {
      'content-type': 'application/json',
      referer: 'https://www.tf1.fr/programmes-tv',
      'User-Agent': getRandomWindowsUA(),
      origin: this.baseUrl,
      'accept-language': 'fr-FR,fr;q=0.9',
      accept: 'application/json, text/plain, */*',
      authorization: `Bearer ${this.authToken}`,
    };

    const program = await this._findProgram(slug, headers);
    if (!program) return null;

    return this._fetchRawVideoItems(program.slug, headers);
  }

  _fallbackEpisodes(slug) {
    logger.debug('✅ [MyTF1] Using fallback episode for %s', slug);
    return [this._createFallbackEpisode(slug)];
  }

  /** The TF1 programs-list entry for *slug*.
   *
   * programs.json carries TF1's own slug, so that is the match; the name it
   * also carries is the fallback for a show TF1 has since re-slugged.  The
   * entry holds the artwork and the metadata, so the catalogue, the detail page
   * and the episode lookup all resolve a show exactly once.
   */
  async _findProgram(slug, headers = null) {
    const showName = ((this.shows[slug] || {}).name || slug.replace(/-/g, ' ')).toLowerCase();
    const requestHeaders = headers || {
      'content-type': 'application/json',
      referer: 'https://www.tf1.fr/programmes-tv',
    };
    const match = (programs) => (programs || []).find(
      (program) => program.slug === slug || (program.name || '').toLowerCase() === showName,
    );

    // The unfiltered list (TF1's 500 most prominent programmes) is tried alone
    // first and usually hits. Only a miss fans out to the four channel lists —
    // 500-item GraphQL pages, worth four parallel requests to avoid rather than
    // four serial ones to endure.
    const [firstFilter, ...restFilters] = MyTF1Provider.PROGRAM_LIST_FILTERS;
    const firstHit = match(await this._getGraphqlProgramsList(requestHeaders, firstFilter));
    if (firstHit) return firstHit;

    const lists = await Promise.all(
      restFilters.map((channel) => this._getGraphqlProgramsList(requestHeaders, channel)),
    );
    // Filter order still decides which entry wins, not which reply arrived first.
    for (const programs of lists) {
      const hit = match(programs);
      if (hit) return hit;
    }

    logger.error('❌ [MyTF1] Program not found for show: %s', slug);
    return null;
  }

  /** Fetch a TF1 programs list from the GraphQL API, with caching. */
  async _getGraphqlProgramsList(headers, channelFilter = null) {
    const variables = {
      context: {
        persona: 'PERSONA_2', application: 'WEB', device: 'DESKTOP', os: 'WINDOWS',
      },
      filter: channelFilter ? { channel: channelFilter } : {},
      offset: 0,
      limit: 500,
    };
    const params = { id: '483ce0f', variables: JSON.stringify(variables) };

    const fetchList = async () => {
      const data = await this.apiClient.get(this.apiUrl, {
        headers: this._buildIpHeaders(headers), params, maxRetries: 3,
      });
      if (data && data.data && data.data.programs) return data.data.programs.items || [];
      return null;
    };

    return this._cachedPayload(`graphql_programs:${channelFilter || 'all'}`, fetchList);
  }

  /** Fetch a program's raw replay video items from the TF1 GraphQL API. */
  async _fetchRawVideoItems(programSlug, headers) {
    return safeProviderCall(this, '_fetchRawVideoItems', null, async () => {
      const variables = {
        programSlug,
        offset: 0,
        limit: 50,
        sort: { type: 'DATE', order: 'DESC' },
        types: ['REPLAY'],
      };
      const params = { id: 'a6f9cf0e', variables: JSON.stringify(variables) };
      const data = await this._fetchWithProxyFallback(this.apiUrl, {
        params, headers: this._buildIpHeaders(headers),
      });
      if (data && data.data && data.data.programBySlug) {
        const programData = data.data.programBySlug;
        const videoItems = programData.videos?.items || [];
        if (videoItems.length) {
          logger.debug('✅ [MyTF1] Found %d video items', videoItems.length);
          return videoItems;
        }
        logger.error('❌ [MyTF1] No videos found in programBySlug: %s', Object.keys(programData));
      } else {
        logger.error('❌ [MyTF1] No programBySlug in response: %s', data ? Object.keys(data) : 'No data');
      }
      return null;
    });
  }

  async _parseEpisode(video, episodeNumber) {
    return safeProviderCall(this, '_parseEpisode', null, async () => {
      const episodeId = video.id;
      const decoration = video.decoration || {};
      const title = decoration.label ?? 'Unknown Title';
      const description = decoration.description ?? '';
      const duration = video.playingInfos?.duration ?? '';
      const released = video.date ?? '';

      let poster = null;
      if (decoration.images) {
        try {
          const images = decoration.images;
          poster = images.length > 1
            ? images[1].sources[0].url || ''
            : images[0].sources[0].url || '';
        } catch { /* no usable decoration image */ }
      }
      if (!poster && video.image?.sourcesWithScales) {
        poster = video.image.sourcesWithScales[0]?.url || '';
      }

      return {
        id: `cutam:fr:mytf1:episode:${episodeId}`,
        title,
        description,
        poster,
        fanart: null,
        duration,
        released,
        type: 'episode',
        episode_number: episodeNumber,
        season: 1,
        episode: episodeNumber,
      };
    });
  }

  /** Format the `[HLS|MPD] <title>` label shown in Stremio. */
  static formatStreamTitle(manifestType, program, fallback) {
    const label = manifestType === 'hls' ? 'HLS' : 'MPD';
    return program ? `[${label}] ${program}` : `[${label}] ${fallback}`;
  }

  /** Assemble the live stream object from a mediainfo response. */
  _buildLiveStreamInfo(mediainfo, videoId, channelName) {
    const delivery = mediainfo.delivery;
    const videoUrl = delivery.url;
    logger.debug('✅ [MyTF1] Stream URL obtained: %s...', videoUrl.slice(0, 50));

    const [licenseUrl, licenseHeaders] = this._extractDrmInfo(delivery, videoId);
    const manifestType = this._detectManifestType(videoUrl);
    const headers = this._buildStreamHeaders();

    const proxied = this._buildMediaflowProxiedUrl(videoUrl, manifestType, {
      extraHeaders: { authorization: `Bearer ${this.authToken}` },
      licenseUrl,
      licenseHeaders,
    });

    let currentProgram = null;
    if (mediainfo.media) {
      currentProgram = mediainfo.media.programName || mediainfo.media.title || '';
      logger.debug('✅ [MyTF1] Current program: %s', currentProgram);
    }

    const streamInfo = {
      url: proxied || videoUrl,
      manifest_type: manifestType,
      title: MyTF1Provider.formatStreamTitle(manifestType, currentProgram, channelName.toUpperCase()),
      headers,
    };
    if (licenseUrl) {
      streamInfo.licenseUrl = licenseUrl;
      if (Object.keys(licenseHeaders).length) streamInfo.licenseHeaders = licenseHeaders;
    }
    return streamInfo;
  }

  async getChannelStreamUrl(channelId) {
    const channelName = channelId.split(':').pop();

    try {
      logger.debug('✅ [MyTF1] Getting stream for channel: %s', channelName);
      if (!this._authenticated && !(await this._authenticate())) {
        logger.error('❌ [MyTF1] MyTF1 authentication failed');
        return null;
      }

      const videoId = `L_${channelName.toUpperCase()}`;
      const mediainfo = await this._fetchMediainfo(videoId, MyTF1Provider.LIVE_MEDIAINFO_PARAMS);

      if (!mediainfo) {
        logger.error('❌ [MyTF1] MyTF1 API error: No valid JSON from mediainfo (proxy and direct attempts failed)');
        return null;
      }

      if ((mediainfo.delivery?.code ?? 500) > 400) {
        logger.error('❌ [MyTF1] MyTF1 delivery error: %s', mediainfo.delivery?.code);
        return null;
      }

      return [this._buildLiveStreamInfo(mediainfo, videoId, channelName)];
    } catch (e) {
      logger.error('❌ [MyTF1] Error getting stream for %s: %s', channelName, e.message);
      return null;
    }
  }

  /** Fetch delivery data from the TF1 mediainfo API with proxy fallback. */
  async _fetchMediainfo(mediaId, mediainfoParams) {
    const headers = this._buildStreamHeaders();
    const url = `${this.videoStreamUrl}/${mediaId}`;
    return this._fetchWithProxyFallback(url, {
      params: { ...mediainfoParams },
      headers,
      validate: MyTF1Provider.validateTf1Delivery,
    });
  }

  /** Fetch delivery data for a replay episode. */
  async _fetchEpisodeDelivery(episodeId) {
    return this._fetchMediainfo(episodeId, MyTF1Provider.REPLAY_MEDIAINFO_PARAMS);
  }

  /** Extract DRM keys with the local Widevine CDM.
   * @returns {Promise<{keys: Object, defaultKid: string|null}>}
   */
  async _extractDrmKeys(videoUrl, licenseUrl) {
    try {
      const { TF1DRMExtractor } = await import('./tf1DrmKeyExtractor.js');
      logger.debug('✅ [MyTF1] Extracting DRM keys for TF1 replay...');

      const extractor = new TF1DRMExtractor();
      const { keys, defaultKid } = await extractor.getKeys({ videoUrl, licenseUrl });

      if (Object.keys(keys).length) {
        logger.debug('✅ [MyTF1] Extracted %d DRM key(s)', Object.keys(keys).length);
        for (const [kid, key] of Object.entries(keys)) {
          logger.debug('   KID: %s -> KEY: %s', kid, key);
        }
      } else {
        logger.warning('⚠️ [MyTF1] No DRM keys extracted');
      }
      return { keys, defaultKid };
    } catch (drmError) {
      logger.error('⚠️ [MyTF1] DRM key extraction failed: %s', drmError.message);
      return { keys: {}, defaultKid: null };
    }
  }

  /** Pick the single `key_id`/`key` pair MediaFlow decrypts with.
   *
   * MediaFlow takes one pair, a license can carry several. With one key there
   * is nothing to choose; with several, the manifest's `default_KID` decides —
   * and that arrives with the keys now, read from the manifest the CDM already
   * fetched, so the multi-key case costs no extra request. Re-reading it is
   * only a fallback for a manifest that published no default_KID.
   */
  async _selectDrmKey(videoUrl, drmKeys, manifestKid = null) {
    const kids = Object.keys(drmKeys || {});
    if (!kids.length) return null;
    let kid = kids[0];
    if (kids.length > 1) {
      let defaultKid = manifestKid;
      if (!defaultKid) {
        const [, , drmInfo] = await extractPsshFromMpd(videoUrl, 'MyTF1');
        defaultKid = normalizeKeyId((drmInfo || {}).key_id);
      }
      if (defaultKid && kids.includes(defaultKid)) {
        kid = defaultKid;
      } else {
        logger.warning('⚠️ [MyTF1] default_KID %s not in license (%d key(s)) — using first',
          defaultKid, kids.length);
      }
    }
    return { key_id: kid, key: drmKeys[kid] };
  }

  /** MediaFlow-proxied stream straight from the TF1 CDN.
   *
   * With a locally extracted Widevine key MediaFlow decrypts the CENC segments
   * itself; without one it is pointed at the TF1 license proxy.
   */
  async _buildDirectStream(videoUrl, licenseUrl, licenseHeaders, headers, drmKeys, manifestType = 'mpd', manifestKid = null) {
    const keyParams = await this._selectDrmKey(videoUrl, drmKeys, manifestKid);
    if (keyParams) {
      logger.debug('✅ [MyTF1] Direct stream decrypted by MediaFlow (KID %s)', keyParams.key_id);
      licenseUrl = null;
      licenseHeaders = null;
    }

    const proxied = this._buildMediaflowProxiedUrl(videoUrl, manifestType, {
      extraHeaders: { authorization: `Bearer ${this.authToken}` },
      licenseUrl,
      licenseHeaders,
      extraParams: keyParams,
    });
    const stream = {
      url: proxied || videoUrl,
      manifest_type: manifestType,
      title: `🌐 [${manifestType.toUpperCase()}] Direct source (MediaFlow)`,
      headers,
    };
    if (licenseUrl) {
      stream.licenseUrl = licenseUrl;
      if (licenseHeaders && Object.keys(licenseHeaders).length) stream.licenseHeaders = licenseHeaders;
    }
    return stream;
  }

  /** MediaFlow-proxied stream for HLS/non-DRM content. */
  _buildMediaflowStream(videoUrl, licenseUrl, licenseHeaders, headers, manifestType) {
    const base = { manifest_type: manifestType, headers };
    if (licenseUrl) base.licenseUrl = licenseUrl;
    if (licenseHeaders && Object.keys(licenseHeaders).length) base.licenseHeaders = licenseHeaders;

    const proxied = this._buildMediaflowProxiedUrl(videoUrl, manifestType, {
      extraHeaders: { authorization: `Bearer ${this.authToken}` },
      licenseUrl,
      licenseHeaders,
    });
    return [{ url: proxied || videoUrl, ...base }];
  }

  /** Streams for a replay episode: pre-processed file(s) *and* the direct source.
   *
   * The TorBox/Real-Debrid copy is listed first when it exists; the
   * MediaFlow-proxied original is always offered alongside it, so playback
   * works before (or without) background DRM processing.
   */
  async getEpisodeStreamUrl(episodeId) {
    const actualId = this._extractAfterMarker(episodeId);

    try {
      // The pre-processed-file lookup talks to TorBox/Real-Debrid and the login
      // talks to TF1 — nothing links them, so they run together.
      const [existingResult, authOk] = await Promise.all([
        this._checkProcessedFile(actualId),
        this._authenticated ? true : this._authenticate(),
      ]);
      const existing = existingResult || [];

      if (!authOk) return existing.length ? existing : null;

      const deliveryData = await this._fetchEpisodeDelivery(actualId);
      if (!deliveryData || (deliveryData.delivery?.code ?? 500) > 400) {
        return existing.length ? existing : null;
      }

      const videoUrl = deliveryData.delivery.url;
      const [licenseUrl, licenseHeaders] = this._extractDrmInfo(deliveryData.delivery, actualId);
      const headers = this._buildStreamHeaders();
      const manifestType = this._detectManifestType(videoUrl);

      if (manifestType === 'mpd' && licenseUrl) {
        const { keys: drmKeys, defaultKid } = await this._extractDrmKeys(videoUrl, licenseUrl);
        const streams = [await this._buildDirectStream(
          videoUrl, licenseUrl, licenseHeaders, headers, drmKeys, manifestType, defaultKid,
        )];
        // Don't re-download something that is already processed.
        if (Object.keys(drmKeys).length && !existing.length) {
          try {
            const placeholder = await this._startDrmProcessing(videoUrl, actualId, {
              keys: Object.entries(drmKeys).map(([kid, key]) => `${kid}:${key}`),
            });
            if (placeholder) streams.push(placeholder);
          } catch (e) {
            logger.error('⚠️ [MyTF1] Background processing failed: %s', e.message);
          }
        }
        return [...existing, ...streams];
      }

      return [...existing, ...this._buildMediaflowStream(
        videoUrl, licenseUrl, licenseHeaders, headers, manifestType,
      )];
    } catch (e) {
      logger.exception('❌ [MyTF1] Error getting episode stream', e);
      return null;
    }
  }

  /** Largest source URL of a decoration image — sources come size-descending. */
  static decorationUrl(decoration, key) {
    const sources = decoration[key]?.sources || [];
    return sources.length ? (sources[0].url || null) : null;
  }

  async _getShowApiMetadata(showId, showInfo) {
    return safeProviderCall(this, '_getShowApiMetadata', {}, async () => {
      const program = await this._findProgram(showId);
      if (!program) return {};
      const decoration = program.decoration || {};
      const candidates = {};
      for (const [field, key] of Object.entries(MyTF1Provider.DECORATION_IMAGES)) {
        candidates[field] = [MyTF1Provider.decorationUrl(decoration, key)];
      }
      // ponytail: no rating here — TF1 rates videos, not programs, and reading
      // one would cost a second request per show. Falls back to DEFAULT_RATING.
      candidates.description = [decoration.description];
      candidates.channel = [program.mainChannel?.label];
      candidates.genres = [(program.categories || []).filter((c) => c.label).map((c) => c.label)];
      candidates.year = [/^\d+$/.test(String(program.releaseYear)) ? parseInt(program.releaseYear, 10) : null];
      return this._pickFields(candidates, showInfo);
    });
  }
}
