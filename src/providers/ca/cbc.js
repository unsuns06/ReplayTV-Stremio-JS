import { getLogger } from '../../utils/logger.js';
import { BaseProvider, safeProviderCall } from '../baseProvider.js';
import { CBCAuthenticator } from '../../auth/cbcAuth.js';
import { cache } from '../../utils/cache.js';
import { CacheKeys, CacheTTL } from '../../utils/cacheKeys.js';
import { getClientIp } from '../../utils/clientIp.js';
import { getProgramsForProvider } from '../../utils/programsLoader.js';

const logger = getLogger('providers.cbc');

// Auth-status cache TTLs (seconds)
const AUTH_SUCCESS_TTL = 3600; // 1 hour — re-check auth after the token likely expired
const AUTH_FAILURE_TTL = 300; // 5 minutes — retry sooner after a failure

const CBC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

export class CBCProvider extends BaseProvider {
  static providerName = 'cbc';
  static baseUrl = 'https://gem.cbc.ca';
  static country = 'ca';
  static credentialsKey = 'cbcgem'; // legacy section name in users' credentials files

  // Metadata
  static displayName = 'CBC';
  static idPrefix = 'cutam:ca:cbc';
  static episodeMarker = 'episode:';
  static catalogId = 'ca-cbc-dragons-den';
  static supportsLive = false;
  static defaultChannel = 'dragonsden';
  static defaultRating = 'G';

  static AUTH_CACHE_KEY = CacheKeys.providerResource('cbc', 'auth_status');

  // getPrograms comes from the BaseProvider template; _getShowApiMetadata
  // below supplies the artwork, all of it read straight out of the show payload.
  static SHOW_IMAGES = {
    logo: ['logo'],
    background: ['background'],
    fanart: ['background'],
  };

  // Some shows have no season 1 in the catalog (it aged out), and the API 404s
  // on s01e01 even though later seasons are there. Walk forward until one hits.
  // ponytail: 10 tries, sequential. Raise it if a show is found starting later.
  static MAX_SEASON_PROBE = 10;

  get needsIpForwarding() {
    return true;
  }

  constructor(req = null) {
    super(req);

    // CBC-specific API URLs
    this.apiBase = 'https://services.radio-canada.ca';
    this.catalogApi = `${this.apiBase}/ott/catalog/v2/gem`;
    this.mediaApi = `${this.apiBase}/media/validation/v2`;

    // Lazy auth — only called in getEpisodeStreamUrl()
    this.authenticator = new CBCAuthenticator(cache);

    this.shows = getProgramsForProvider('cbc');
  }

  /** Headers with viewer IP forwarding for geo-sensitive requests. */
  _getHeadersWithViewerIp(additionalHeaders = null) {
    return this._buildIpHeaders({ 'User-Agent': CBC_UA, ...(additionalHeaders || {}) });
  }

  /** Whether a valid, non-stale auth entry exists in the cache. */
  async _checkAuthCache() {
    const cached = cache.get(CBCProvider.AUTH_CACHE_KEY);
    if (cached && cached.authenticated) {
      if (await this.authenticator.isAuthenticated()) return true;
      logger.warning('⚠️ [CBC] Cached auth status was stale, re-authenticating');
    }
    return false;
  }

  /** Persist the authentication outcome to cache with an appropriate TTL. */
  _storeAuthResult(success) {
    cache.set(CBCProvider.AUTH_CACHE_KEY, { authenticated: success },
      success ? AUTH_SUCCESS_TTL : AUTH_FAILURE_TTL);
  }

  /** Authenticate with CBC if credentials are available, using caching. */
  async _authenticateIfNeeded() {
    try {
      if (await this.authenticator.isAuthenticated()) {
        logger.debug('✅ [CBC] Already authenticated');
        return;
      }

      if (await this._checkAuthCache()) {
        logger.debug('✅ [CBC] Using cached authentication status');
        return;
      }

      const cbcCreds = this.credentials || {};

      if (cbcCreds.login && cbcCreds.password) {
        logger.info('🔍 [CBC] Authenticating with CBC Gem');
        const success = await this.authenticator.login(cbcCreds.login, cbcCreds.password);
        this._storeAuthResult(success);
        if (success) logger.info('✅ [CBC] Authentication successful');
        else logger.warning('⚠️ [CBC] Authentication failed');
      } else {
        logger.info('ℹ️ [CBC] No credentials provided, using unauthenticated access');
        this._storeAuthResult(false);
      }
    } catch (e) {
      logger.error('❌ [CBC] Error during authentication: %s', e.message);
      this._storeAuthResult(false);
    }
  }

  /** The show payload — sXXe01 returns ALL seasons in the lineups array. */
  async _showPayload(showSlug) {
    for (let season = 1; season <= CBCProvider.MAX_SEASON_PROBE; season += 1) {
      const url = `${this.catalogApi}/show/${showSlug}/s${String(season).padStart(2, '0')}e01?device=web&tier=Member`;
      logger.debug('🔍 [CBC] API request: %s', url);
      const data = await this.apiClient.get(url, {
        headers: this._getHeadersWithViewerIp({
          Accept: 'application/json, text/plain, */*',
          Referer: 'https://gem.cbc.ca/',
          Origin: 'https://gem.cbc.ca',
        }),
      });
      if (data) {
        if (season > 1) logger.info('ℹ️ [CBC] %s has no season 1; used season %d', showSlug, season);
        return data;
      }
    }
    return null;
  }

  /** Fetch the show's metadata and artwork from the CBC catalog API. */
  async _getShowApiMetadata(showId, showInfo) {
    return safeProviderCall(this, '_getShowApiMetadata', {}, async () => {
      const data = await this._cachedPayload(`show:${showId}`, () => this._showPayload(showId));
      const images = (data || {}).images || {};
      const candidates = {};
      for (const [field, keys] of Object.entries(CBCProvider.SHOW_IMAGES)) {
        candidates[field] = keys.map((k) => (images[k] || {}).url);
      }
      // No poster is published: derive it from the background URL, falling back
      // to the page's og:image. Skipped entirely when programs.json pins one.
      if (!showInfo.poster) {
        candidates.poster = [
          await this._firstExisting(this._posterCandidates(data || {})),
          ((data || {}).htmlMeta || {})['og:image'],
        ];
      }
      // Neither a year nor a rating is published at show level; both live on
      // the episodes the same request already returned.
      const episodes = [];
      for (const lineup of (((data || {}).content || [{}])[0] || {}).lineups || []) {
        episodes.push(...(lineup.items || []));
      }
      const airYears = episodes
        .map((e) => ((e.metadata || {}).airDate || '').slice(0, 4))
        .filter((y) => /^\d{4}$/.test(y))
        .sort();
      const ratings = episodes.map((e) => (e.metadata || {}).rating).filter(Boolean);
      candidates.description = [CBCProvider.description(data)];
      // CBC publishes no channel — the provider is the channel — but only claim
      // it when the payload is real (every show carries a title).
      candidates.channel = [(data || {}).title ? this.displayName : null];
      candidates.genres = [((data || {}).navigationFilters || [])
        .filter((f) => f.title && f.title !== 'Shows')
        .map((f) => f.title)];
      candidates.year = [airYears.length ? parseInt(airYears[0], 10) : null];
      candidates.rating = [ratings.length ? ratings[0] : null];
      return this._pickFields(candidates, showInfo);
    });
  }

  /** The synopsis with CBC's scheduling notes appended as their own paragraphs.
   *
   * Gem keeps timely announcements ("New season streaming September 17th") in
   * `messages` rather than in the synopsis, so a reader who only sees
   * `description` misses them.
   */
  static description(data) {
    const notes = ((data || {}).messages || []).filter((n) => n.message).map((n) => n.message);
    const paragraphs = [(data || {}).description || '', ...notes];
    return paragraphs.filter(Boolean).join(' ') || null;
  }

  /** Poster URLs derived from the background URL, most specific first.
   *
   * Two shapes exist, and which one a show uses is not predictable:
   * `season/perso/<stem>_s<latest>_ott_poster_v01.jpg` (dragons-den) and
   * `show/perso/<stem>_ott_poster_v01.jpg` (schitts-creek). Together they cover
   * 12 of 16 shows sampled; the caller HEAD-checks them in order.
   *
   * ponytail: v01 only. The poster's version is independent of the
   * background's, so chasing it would mean a request per guess — og:image
   * covers those shows instead.
   */
  _posterCandidates(data) {
    const background = ((data.images || {}).background || {}).url;
    if (!background) return [];
    const seasons = CBCProvider.seasonNumbers(data);
    const candidates = [];
    if (seasons.length) {
      candidates.push(background
        .replace('/show/', '/season/')
        .replace(/_ott_background_v\d+/, `_s${Math.max(...seasons)}_ott_poster_v01`));
    }
    candidates.push(background.replace(/_ott_background_v\d+/, '_ott_poster_v01'));
    return candidates;
  }

  /** First URL the CDN actually serves, or null. Each result cached. */
  async _firstExisting(urls) {
    for (const url of urls) {
      const cacheKey = CacheKeys.providerResource(this.providerName, `url_ok:${url}`);
      let exists = cache.get(cacheKey);
      if (exists === null) {
        try {
          const resp = await this.apiClient.rawRequest('HEAD', url, { timeout: 10 });
          exists = Boolean(resp && resp.status === 200);
        } catch (exc) {
          logger.debug('⚠️ [CBC] Poster check failed for %s: %s', url, exc.message);
          exists = false;
        }
        cache.set(cacheKey, exists, CacheTTL.PROGRAMS);
      }
      if (exists) return url;
    }
    return null;
  }

  /** Season numbers CBC Gem offers for a show, ascending.
   *
   * One show request returns every season in `lineups` — which seasons to
   * scrape for episodes and which season the poster belongs to both come from
   * here, so the payload is only parsed one way.
   */
  static seasonNumbers(data) {
    const lineups = (((data || {}).content || [{}])[0] || {}).lineups || [];
    const seasons = new Set();
    for (const lineup of lineups) {
      if (Number.isInteger(lineup.seasonNumber)) seasons.add(lineup.seasonNumber);
    }
    return [...seasons].sort((a, b) => a - b);
  }

  /** Episodes for any CBC series. */
  async getEpisodes(seriesId) {
    try {
      logger.info('🔍 [CBC] Getting episodes for series: %s', seriesId);

      // NOTE: caching is handled by the meta router (CacheKeys.episodes).

      const showSlug = this._extractSlug(seriesId);
      if (!showSlug) {
        logger.warning('⚠️ [CBC] Invalid series ID format: %s', seriesId);
        return [];
      }

      const cbcShows = getProgramsForProvider('cbc');
      const showInfo = cbcShows[showSlug] || {};
      const showName = showInfo.name
        || showSlug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

      const episodes = await this._getShowEpisodes(showSlug, showName);
      if (episodes.length) {
        logger.info('✅ CBC returned %d episodes for %s', episodes.length, showName);
        return episodes;
      }

      logger.warning('⚠️ [CBC] No episodes found for: %s', showSlug);
      return [];
    } catch (e) {
      logger.error('❌ [CBC] Error getting CBC episodes: %s', e.message);
      return [];
    }
  }

  /** ALL episodes for a CBC show, from a single show payload. */
  async _getShowEpisodes(showSlug, showName) {
    try {
      logger.info('🔍 [CBC] Fetching %s episodes from CBC API...', showName);

      // Same key family the meta router uses, so the episode list is cached
      // exactly once with one TTL.
      const cacheKey = CacheKeys.episodes(`${this.idPrefix}:${showSlug}`);
      const cachedEpisodes = cache.get(cacheKey);
      if (cachedEpisodes) {
        logger.info('✅ Using cached %s episodes: %d episodes', showName, cachedEpisodes.length);
        return cachedEpisodes;
      }

      const episodes = [];
      const data = await this._showPayload(showSlug);

      if (data && data.content && data.content.length) {
        const lineups = data.content[0].lineups || [];
        const seasons = CBCProvider.seasonNumbers(data);
        logger.info('✅ [CBC] %s: scraping seasons %s', showName, seasons.join(', ') || 'none');

        for (const lineup of lineups) {
          const seasonNum = lineup.seasonNumber;
          if (!seasons.includes(seasonNum)) continue;

          let seasonEpisodeCount = 0;
          for (const item of lineup.items || []) {
            // Daily-segment shows (About That) publish LiveToVod items, not
            // Episode ones — same shape, same streams.
            if (!['Episode', 'LiveToVod'].includes(item.mediaType)) continue;

            const episodeData = this._parseEpisodeFromSeasonData(item, seasonNum, showSlug, showName);
            if (episodeData) {
              episodes.push(episodeData);
              seasonEpisodeCount += 1;
            }
          }

          if (seasonEpisodeCount > 0) {
            logger.debug('🔍 [CBC] Season %s: %s episodes', seasonNum, seasonEpisodeCount);
          }
        }
      } else {
        logger.warning('⚠️ [CBC] API returned no content for %s', showSlug);
      }

      episodes.sort((a, b) => (a.season - b.season) || (a.episode - b.episode));

      // LiveToVod segments carry Gem's media id where an episode number belongs
      // (10735091), and Stremio prints that in front of every title. Only the
      // displayed number is renumbered — the episode id keeps the media id, so
      // streams still resolve by direct id match.
      episodes.forEach((episode, index) => {
        const isLiveToVod = episode.livetovod;
        delete episode.livetovod;
        if (isLiveToVod) episode.episode = index + 1;
      });

      if (episodes.length) {
        cache.set(cacheKey, episodes, CacheTTL.EPISODES);
        logger.info('✅ [CBC] Found %d total episodes for %s', episodes.length, showName);
      }

      return episodes;
    } catch (e) {
      logger.error('❌ [CBC] Error fetching %s episodes: %s', showName, e.message);
      return [];
    }
  }

  /** Parse episode data from a season lineup item. */
  _parseEpisodeFromSeasonData(item, seasonNum, showSlug = '', showName = '') {
    try {
      // LiveToVod items carry no episodeNumber; Gem's own URL puts the media id
      // in its place (s01e10735091), so mirror that — it is stable, where a
      // positional index would shift as segments air.
      const urlNumber = (item.url || '').match(/e(\d+)$/);
      const episodeNum = item.episodeNumber || (urlNumber ? parseInt(urlNumber[1], 10) : 0);
      if (!episodeNum) return null;

      const metadata = item.metadata || {};

      const title = item.callToActionTitle || item.title || `Season ${seasonNum}, Episode ${episodeNum}`;
      const description = item.description || '';

      // Default 44 minutes
      const duration = 'duration' in metadata ? metadata.duration : 2640;

      const airDate = item.infoTitle || metadata.airDate || metadata.availabilityDate || '';

      let released = '';
      const availabilityDate = metadata.availabilityDate || '';
      if (availabilityDate) released = `${availabilityDate}T00:00:00.000Z`;

      const rating = metadata.rating || 'PG';

      let thumbnail = '';
      const images = item.images || {};
      if (images.card && images.card.url) thumbnail = images.card.url;

      let cast = [];
      for (const credit of metadata.credits || []) {
        if (credit.title === 'Actor(s)') {
          const peoples = credit.peoples || '';
          if (peoples) {
            cast = peoples.split(',').map((n) => n.trim()).filter(Boolean);
            break;
          }
        }
      }

      const genres = metadata.genres || [];

      const gemUrl = `https://gem.cbc.ca/${showSlug}/s${String(seasonNum).padStart(2, '0')}e${String(episodeNum).padStart(2, '0')}`;

      // Media ID — critical for stream resolution
      const cbcMediaId = item.idMedia;
      if (!cbcMediaId) {
        logger.warning('⚠️ [CBC] No media ID for S%sE%s', seasonNum, episodeNum);
        return null;
      }

      const episodeData = {
        id: `cutam:ca:cbc:${showSlug}:episode:${seasonNum}:${episodeNum}`,
        title,
        season: seasonNum,
        episode: episodeNum,
        description,
        duration: String(duration),
        broadcast_date: airDate,
        rating,
        channel: 'CBC',
        program: showName,
        type: 'episode',
        poster: thumbnail,
        thumbnail,
        gem_url: gemUrl,
        genres,
        cast,
        cbc_media_id: String(cbcMediaId),
        // Consumed by _getShowEpisodes, which renumbers these.
        livetovod: item.mediaType === 'LiveToVod',
      };

      if (released) episodeData.released = released;

      logger.debug('🔍 [CBC] Created episode S%sE%s', seasonNum, episodeNum);
      return episodeData;
    } catch (e) {
      logger.error('❌ [CBC] Error parsing episode data: %s', e.message);
      return null;
    }
  }

  /** Stream URL for a CBC episode using the CBC Gem API, with caching. */
  async getEpisodeStreamUrl(episodeId) {
    try {
      logger.info('🔍 [CBC] Getting stream for episode: %s', episodeId);

      // Lazy authentication — only when a stream is actually requested
      await this._authenticateIfNeeded();

      const cacheKey = CacheKeys.stream(episodeId);
      const cachedStream = cache.get(cacheKey);
      if (cachedStream) {
        logger.info('✅ [CBC] Using cached stream URL for episode: %s', episodeId);
        return cachedStream;
      }

      const mediaId = await this._extractMediaIdFromEpisodeId(episodeId);
      if (!mediaId) {
        logger.error('❌ [CBC] Could not extract media ID from episode: %s', episodeId);
        return null;
      }

      const streamInfo = await this._getStreamFromCbcApi(mediaId);
      if (streamInfo) {
        cache.set(cacheKey, streamInfo, CacheTTL.STREAM);
        return streamInfo;
      }

      logger.warning('⚠️ [CBC] No stream found for episode: %s', episodeId);
      return null;
    } catch (e) {
      logger.error('❌ [CBC] Error getting CBC episode stream: %s', e.message);
      return null;
    }
  }

  /** Extract the CBC media ID from an episode ID. */
  async _extractMediaIdFromEpisodeId(episodeId) {
    try {
      // Format: cutam:ca:cbc:show-slug:episode:S:E
      const parts = episodeId.split(':');
      if (parts.length < 5) {
        logger.warning('⚠️ [CBC] Invalid episode ID format: %s', episodeId);
        return null;
      }
      const showSlug = parts[3];
      const seriesId = `cutam:ca:cbc:${showSlug}`;

      const episodes = await this.getEpisodes(seriesId);

      if (parts.length >= 7) {
        const seasonNum = parseInt(parts[parts.length - 2], 10);
        const episodeNum = parseInt(parts[parts.length - 1], 10);
        if (!Number.isNaN(seasonNum) && !Number.isNaN(episodeNum)) {
          for (const ep of episodes) {
            if (ep.season === seasonNum && ep.episode === episodeNum && ep.cbc_media_id) {
              const mediaId = String(ep.cbc_media_id);
              logger.debug('🔍 [CBC] Found media ID for S%sE%s: %s', seasonNum, episodeNum, mediaId);
              return mediaId;
            }
          }
        }
      }

      // Fallback: direct ID match
      for (const ep of episodes) {
        if (ep.id === episodeId && ep.cbc_media_id) return String(ep.cbc_media_id);
      }

      logger.warning('⚠️ [CBC] No media ID found for: %s', episodeId);
      return null;
    } catch (e) {
      logger.error('❌ Error extracting media ID: %s', e.message);
      return null;
    }
  }

  /** Get the stream URL from the CBC Gem API.
   *
   * Retries once with a refreshed claims token when the API reports an
   * invalid/expired token (errorCode 35).
   */
  async _getStreamFromCbcApi(mediaId) {
    try {
      logger.info('🔍 Getting stream from CBC API for media: %s', mediaId);

      if (!(await this.authenticator.isAuthenticated())) {
        logger.error('❌ Not authenticated with CBC Gem');
        return null;
      }

      const params = {
        appCode: 'gem',
        connectionType: 'hd',
        deviceType: 'ipad',
        multibitrate: 'true',
        output: 'json',
        tech: 'hls',
        manifestVersion: '2',
        manifestType: 'desktop',
        idMedia: String(mediaId),
      };

      const viewerIp = getClientIp();
      if (viewerIp) logger.info('🌍 CBC Media API request using viewer IP: %s', viewerIp);
      else logger.warning('⚠️ CBC Media API request using server IP (no viewer IP available)');

      let data = null;
      let headers = {};
      let resolved = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        headers = await this.authenticator.getAuthenticatedHeaders();
        const claimsToken = headers['x-claims-token'];
        if (!claimsToken) {
          logger.error('❌ Missing claims token for CBC content');
          return null;
        }

        data = await this.apiClient.get(this.mediaApi, {
          params,
          headers: this._mergeIpHeaders(headers),
        });
        if (!data) return null;

        const errorCode = data.errorCode ?? 0;
        if (errorCode === 0) {
          resolved = true;
          break;
        }
        if (errorCode === 1) {
          logger.error('❌ Content is geo-restricted to Canada');
          return null;
        }
        if (errorCode === 6 && params.appCode === 'gem') {
          // Quickturn news segments (About That) are served from the medianet
          // catalog; gem simply has no such media.
          logger.info('ℹ️ Media %s absent from gem; retrying as medianet', mediaId);
          params.appCode = 'medianet';
          continue;
        }
        if (errorCode === 35 && attempt === 0) {
          logger.error('❌ Claims token invalid/expired; refreshing once');
          this.authenticator.claimsToken = null;
          continue;
        }
        logger.error('❌ CBC API error %s: %s', errorCode, data.message || 'Unknown error');
        return null;
      }
      if (!resolved) return null;

      const streamUrl = data.url;
      if (!streamUrl) {
        logger.error('❌ No stream URL in CBC API response');
        logger.error(JSON.stringify(data).slice(0, 500));
        return null;
      }

      const manifestType = this._detectManifestType(streamUrl);

      logger.info('✅ Got CBC stream: %s', manifestType.toUpperCase());
      logger.info('🔗 [CBC] Full stream URL: %s', streamUrl);

      // Only return safe playback headers
      const playbackHeaders = {
        'User-Agent': headers['User-Agent'] || CBC_UA,
        Referer: headers.Referer || 'https://gem.cbc.ca/',
        Origin: headers.Origin || 'https://gem.cbc.ca',
      };

      return [{ url: streamUrl, manifest_type: manifestType, headers: playbackHeaders, title: 'CBC Gem Stream' }];
    } catch (e) {
      logger.exception('❌ Error getting stream from CBC API', e);
      return null;
    }
  }
}
