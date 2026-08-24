import { getLogger } from '../utils/logger.js';
import { getProviderCredentials } from '../utils/credentials.js';
import { ProviderAPIClient, withParams } from '../utils/apiClient.js';
import { getLogoUrl } from '../utils/baseUrl.js';
import { cache } from '../utils/cache.js';
import { CacheKeys, CacheTTL } from '../utils/cacheKeys.js';
import { API_FIELDS, DEFAULT_RATING, buildShowDict } from '../utils/showMeta.js';
import { getRandomWindowsUA } from '../utils/userAgent.js';
import { getProxyConfig } from '../utils/proxyConfig.js';
import { makeIpHeaders, mergeIpHeaders } from '../utils/clientIp.js';
import { buildMediaflowUrl } from '../utils/mediaflow.js';

const logger = getLogger('providers.base');

const PARALLEL_FETCH_WORKERS = 5; // max concurrent metadata / image fetches

/** Run *fn*, turning any throw into *fallback* plus one logged line.
 *
 * The JS stand-in for the `@safe_provider_call` decorator — decorators are not
 * available without a build step, so the call sites wrap their body instead.
 */
export async function safeProviderCall(provider, name, fallback, fn) {
  try {
    return await fn();
  } catch (e) {
    logger.error('%s %s failed: %s', provider.logPrefix, name, e.message);
    return fallback;
  }
}

// JS has no multiple inheritance, so the Python mixins become class flags:
// `supportsLive` (LiveProviderMixin) and `supportsDrmFiles`
// (DRMProcessedFileMixin). Consumers read the flag exactly as
// `issubclass(cls, LiveProviderMixin)` did.

/**
 * Base class for all content providers.
 *
 * Provides:
 * - credential loading
 * - an API client with retry logic and UA rotation
 * - MediaFlow / geo-proxy URL construction
 * - template methods for the catalogue, episode list and stream lookup
 */
export class BaseProvider {
  // Subclasses should override these
  static providerName = 'base';
  static baseUrl = '';
  static country = '';
  /** Section name in the credentials document; defaults to providerName.
   * Override only for backward compatibility with existing user files
   * (e.g. CBC reads the legacy "cbcgem" section). */
  static credentialsKey = '';

  // Metadata configuration (subclasses must override)
  static displayName = 'Unknown Provider';
  static idPrefix = '';
  static episodeMarker = 'episode:';
  static catalogId = '';
  static supportsLive = false;
  /** Whether the pre-processed-file / background-DRM machinery applies. */
  static supportsDrmFiles = false;
  static defaultChannel = '';
  static defaultRating = DEFAULT_RATING;
  /** Accept-Language sent with stream requests; override per provider/region. */
  static defaultLocale = 'fr-FR,fr;q=0.9,en;q=0.8';
  /** Geo-proxy key used by _getGeoProxyUrl / _fetchWithProxyFallback. */
  static geoProxyKey = 'fr_default';

  constructor(req = null) {
    this.req = req;

    const cls = this.constructor;
    // Mirror the class attributes onto the instance so provider code reads
    // `this.providerName` exactly as the Python version does.
    this.providerName = cls.providerName;
    this.baseUrl = cls.baseUrl;
    this.country = cls.country;
    this.displayName = cls.displayName;
    this.idPrefix = cls.idPrefix;
    this.episodeMarker = cls.episodeMarker;
    this.catalogId = cls.catalogId;
    this.defaultChannel = cls.defaultChannel;
    this.defaultRating = cls.defaultRating;
    this.defaultLocale = cls.defaultLocale;
    this.geoProxyKey = cls.geoProxyKey;

    this.credentials = getProviderCredentials(cls.credentialsKey || cls.providerName);

    this.apiClient = new ProviderAPIClient(cls.providerName, 15, 3);
    this.apiClient.headers['User-Agent'] = getRandomWindowsUA();

    /** Track authentication state */
    this._authenticated = false;

    this.proxyConfig = getProxyConfig();

    /** Show catalogue from programs.json; subclasses populate it. */
    this.shows = {};

    this._initMediaflow();
  }

  /** Whether this provider requires client IP forwarding headers. */
  get needsIpForwarding() {
    return false;
  }

  get logPrefix() {
    return `[${this.displayName}]`;
  }

  /** Put a usable auth token in the shared cache, off the request path.
   *
   * Called by the auth warmer at startup and on a timer. Returns `true` when a
   * token is ready, `false` when authentication was attempted and failed, and
   * `null` when the provider needs no credentials at all.
   */
  async warmAuth() {
    return null;
  }

  close() {
    this.apiClient.close();
  }

  /**
   * Apply *fn* to every item in *items*, at most PARALLEL_FETCH_WORKERS at once.
   * Results keep the input order, like Python's `executor.map`.
   */
  async _parallelMap(fn, items) {
    const list = [...items];
    const results = new Array(list.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= list.length) return;
        results[index] = await fn(list[index], index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_FETCH_WORKERS, list.length) }, worker));
    return results;
  }

  /** Load and log MediaFlow proxy configuration. */
  _initMediaflow() {
    this.mediaflowUrl = process.env.MEDIAFLOW_PROXY_URL || null;
    this.mediaflowPassword = process.env.MEDIAFLOW_API_PASSWORD || null;

    if (!this.mediaflowUrl || !this.mediaflowPassword) {
      const creds = getProviderCredentials('mediaflow');
      this.mediaflowUrl = this.mediaflowUrl || creds.url || null;
      this.mediaflowPassword = this.mediaflowPassword || creds.password || null;
    }

    if (this.mediaflowUrl && this.mediaflowPassword) {
      logger.debug('✅ %s MediaFlow configured', this.logPrefix);
    } else {
      logger.debug('⚠️ %s MediaFlow not configured', this.logPrefix);
    }
  }

  /** Detect manifest type from a URL. Returns 'hls', 'mpd', or 'ism'. */
  static detectManifestType(url) {
    const lower = (url || '').toLowerCase();
    if (lower.includes('.m3u8') || lower.includes('hls')) return 'hls';
    if (lower.includes('.mpd') || lower.includes('dash')) return 'mpd';
    if (lower.includes('.ism')) return 'ism';
    return 'hls';
  }

  _detectManifestType(url) {
    return BaseProvider.detectManifestType(url);
  }

  /** Extract the trailing slug from 'cutam:country:provider:slug'. */
  _extractSlug(compositeId) {
    return compositeId.split(':').pop();
  }

  /** Extract the portion after the episode marker. */
  _extractAfterMarker(compositeId, marker = null) {
    const m = marker || this.episodeMarker;
    if (!m) return compositeId;
    if (!compositeId.includes(m)) return compositeId;
    return compositeId.slice(compositeId.lastIndexOf(m) + m.length);
  }

  /** Proxied URL for geo-restricted content (defaults to geoProxyKey). */
  _getGeoProxyUrl(destinationUrl, proxyKey = null) {
    const key = proxyKey || this.geoProxyKey;
    const proxyBase = this.proxyConfig.getProxy(key);
    if (proxyBase) return proxyBase + encodeURIComponent(destinationUrl);
    logger.debug("⚠️ %s Proxy '%s' not configured", this.logPrefix, key);
    return null;
  }

  /** Try the geo-proxy first, fall back to a direct call on failure. */
  async _fetchWithProxyFallback(url, { params = null, headers = null, proxyKey = null, validate = null } = {}) {
    const destWithParams = withParams(url, params);
    const proxiedUrl = this._getGeoProxyUrl(destWithParams, proxyKey);

    if (proxiedUrl) {
      const data = await this.apiClient.get(proxiedUrl, { headers, maxRetries: 1 });
      if (data) {
        if (!validate || validate(data)) {
          logger.debug('✅ %s Proxy success', this.logPrefix);
          return data;
        }
        logger.debug('⚠️ %s Proxy response failed validation', this.logPrefix);
      }
    }

    logger.debug('⚠️ %s Trying direct', this.logPrefix);
    return this.apiClient.get(url, { params, headers, maxRetries: 2 });
  }

  /** Build a MediaFlow-proxied URL, or null when MediaFlow is not configured.
   *
   * `extraParams` goes straight into the query string — used for the
   * `key_id`/`key` pair MediaFlow needs to decrypt Widevine DASH.
   */
  _buildMediaflowProxiedUrl(videoUrl, manifestType, {
    extraHeaders = null, licenseUrl = null, licenseHeaders = null, extraParams = null,
  } = {}) {
    if (!this.mediaflowUrl || !this.mediaflowPassword) return null;
    const endpoint = manifestType === 'hls' ? '/proxy/hls/manifest.m3u8' : '/proxy/mpd/manifest.m3u8';
    const headers = {
      'user-agent': getRandomWindowsUA(),
      referer: this.baseUrl,
      origin: this.baseUrl,
      ...(extraHeaders || {}),
    };
    return buildMediaflowUrl({
      baseUrl: this.mediaflowUrl,
      password: this.mediaflowPassword,
      destinationUrl: videoUrl,
      endpoint,
      requestHeaders: headers,
      licenseUrl,
      licenseHeaders,
      extraParams,
    });
  }

  /** Standard headers for stream requests. */
  _buildStreamHeaders(authToken = null, extra = null) {
    const headers = {
      'User-Agent': getRandomWindowsUA(),
      referer: this.baseUrl,
      origin: this.baseUrl,
      'accept-language': this.defaultLocale,
      accept: 'application/json, text/plain, */*',
    };
    if (authToken) headers.authorization = `Bearer ${authToken}`;
    return extra ? { ...headers, ...extra } : headers;
  }

  /** IP-forwarding headers for the current request context. */
  _buildIpHeaders(extra = null) {
    return { ...makeIpHeaders(), ...(extra || {}) };
  }

  /** Merge IP-forwarding headers into an existing headers object. */
  _mergeIpHeaders(headers, extra = null) {
    return { ...mergeIpHeaders(headers), ...(extra || {}) };
  }

  /** Sort episodes by date (oldest first) and re-number them. */
  _sortEpisodesChronologically(episodes) {
    episodes.sort((a, b) => {
      const ka = a.released || a.broadcast_date || '';
      const kb = b.released || b.broadcast_date || '';
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    episodes.forEach((ep, i) => {
      ep.episode = i + 1;
      ep.episode_number = i + 1;
    });
    return episodes;
  }

  /** Build a Stremio series object from programs.json data.
   *
   * Providers may pass *extra* to override or extend any field (e.g. fanart
   * fetched from a live API).  Non-null keys in *extra* win over the base.
   */
  _buildShowMetadata(slug, info, extra = null) {
    const fallbackLogo = this.country && this.defaultChannel
      ? getLogoUrl(this.country, this.defaultChannel, this.req)
      : null;
    const result = buildShowDict(this.idPrefix, slug, info, fallbackLogo, this.defaultRating);
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (v !== null && v !== undefined) result[k] = v;
      }
    }
    return result;
  }

  /** Placeholder episode used when the live episode API fails. */
  _createFallbackEpisode(showId) {
    const showInfo = this.shows[showId] || {};
    const showName = showInfo.name
      || showId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      id: `${this.idPrefix}:episode:${showId}_fallback`,
      type: 'episode',
      title: `Latest ${showName}`,
      description: `Latest episode of ${showName}`,
      poster: showInfo.logo,
      fanart: showInfo.logo,
      episode: 1,
      season: 1,
      note: 'Fallback episode - API unavailable',
    };
  }

  /** Resolve show fields (artwork, description, genres, …) from ordered candidates.
   *
   * The precedence rule shared by every self-fetching provider lives here: a
   * value pinned in programs.json wins outright, otherwise the first non-empty
   * candidate is used, and a field with nothing to offer is left out so
   * `buildShowDict`'s own fallback still applies.
   */
  _pickFields(candidates, showInfo) {
    const picked = {};
    for (const [field, values] of Object.entries(candidates)) {
      if (showInfo[field]) continue;
      const value = values.find((v) => v !== null && v !== undefined && v !== ''
        && !(Array.isArray(v) && v.length === 0));
      if (value) picked[field] = value;
    }
    return picked;
  }

  /** Enrich series metadata with the provider's API metadata.
   *
   * The /meta route builds the detail page from programs.json alone, which
   * holds nothing but provider/slug/name, so everything else on the detail
   * page comes from here.  Providers needing a different merge override this.
   */
  async enhanceSeriesMeta(seriesMeta, showId) {
    const showInfo = this.shows[showId] || {};
    const extra = (await this._getShowApiMetadata(showId, showInfo)) || {};
    for (const [field, value] of Object.entries(extra)) {
      if (value && API_FIELDS.includes(field)) seriesMeta[field] = value;
    }
    return seriesMeta;
  }

  // ------------------------------------------------------------------
  // Template-method skeleton for episode listing.
  // Providers with a simple fetch→parse→sort flow implement
  // _fetchEpisodesRaw and _parseEpisode instead of overriding getEpisodes.
  // ------------------------------------------------------------------

  /** The raw list of episode objects for *slug*. */
  async _fetchEpisodesRaw(slug) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement _fetchEpisodesRaw or override getEpisodes`);
  }

  /** Parse one raw episode object into an EpisodeInfo object. */
  async _parseEpisode(raw, index) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement _parseEpisode or override getEpisodes`);
  }

  /** Fallback episodes when the API yields nothing. */
  _fallbackEpisodes(slug) { // eslint-disable-line no-unused-vars
    return [];
  }

  /** Extra metadata from a live API, or null to use programs.json only. */
  async _getShowApiMetadata(showId, showInfo) { // eslint-disable-line no-unused-vars
    return null;
  }

  /** Memoise a provider API payload for the programs TTL.
   *
   * The catalogue and the /meta detail page both build a show from the same
   * endpoint, so without this every show is fetched twice.  What is cached is
   * the raw payload, never the merged result — that one depends on which
   * fields programs.json pins.
   */
  async _cachedPayload(resource, fetchFn) {
    const key = CacheKeys.providerResource(this.providerName, resource);
    let data = cache.get(key);
    if (data === null) {
      data = await fetchFn();
      if (data) cache.set(key, data, CacheTTL.PROGRAMS);
    }
    return data;
  }

  /** Show list with optional per-show API enrichment (parallel).
   * Override entirely for providers that need a custom flow.
   */
  async getPrograms() {
    const entries = Object.entries(this.shows);
    if (!entries.length) return [];

    const fetchOne = async ([showId, showInfo]) => {
      try {
        return [showId, showInfo, await this._getShowApiMetadata(showId, showInfo)];
      } catch (e) {
        logger.warning('⚠️ %s Could not fetch API metadata for %s: %s', this.logPrefix, showId, e.message);
        return [showId, showInfo, null];
      }
    };

    try {
      const results = await this._parallelMap(fetchOne, entries);
      return results.map(([sid, sinfo, meta]) => this._buildShowMetadata(sid, sinfo, meta));
    } catch (e) {
      logger.error('❌ %s Error fetching show metadata: %s', this.logPrefix, e.message);
      return entries.map(([sid, sinfo]) => this._buildShowMetadata(sid, sinfo));
    }
  }

  /** Fetch, parse and sort episodes for *showId*. */
  async getEpisodes(showId) {
    const slug = this._extractSlug(showId);
    if (!(slug in this.shows)) return [];
    const raw = await this._fetchEpisodesRaw(slug);
    if (!raw || !raw.length) return this._fallbackEpisodes(slug);
    const parsed = await Promise.all(raw.map((item, i) => this._parseEpisode(item, i + 1)));
    return this._sortEpisodesChronologically(parsed.filter(Boolean));
  }

  /** Stream URL for a specific episode. Returns a list of stream objects or null. */
  async getEpisodeStreamUrl(episodeId) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement getEpisodeStreamUrl`);
  }

  /** Live channel list. Override in subclasses that support live channels. */
  async getLiveChannels() {
    return [];
  }

  /** Stream URL for a live channel. Returns a list of stream objects or null. */
  async getChannelStreamUrl(channelId) { // eslint-disable-line no-unused-vars
    return null;
  }

  /** Resolve any stream ID to a playable URL. */
  async resolveStream(streamId) {
    if (streamId.includes(':channel:') || streamId.startsWith('live_')) {
      return this.getChannelStreamUrl(streamId);
    }
    return this.getEpisodeStreamUrl(streamId);
  }
}
