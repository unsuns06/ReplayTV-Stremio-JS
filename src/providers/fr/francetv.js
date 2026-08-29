import { getLogger } from '../../utils/logger.js';
import { metadataProcessor, imageExtractor, htmlUnescape } from './metadata.js';
import { getBaseUrl, getLogoUrl } from '../../utils/baseUrl.js';
import { cache } from '../../utils/cache.js';
import { CacheKeys, CacheTTL } from '../../utils/cacheKeys.js';
import { getProgramsForProvider } from '../../utils/programsLoader.js';
import { API_FIELDS, DEFAULT_RATING } from '../../utils/showMeta.js';
import { BaseProvider, safeProviderCall } from '../baseProvider.js';
import { buildFtvManifestUrl } from '../../routers/ftvGeo.js';

const logger = getLogger('providers.francetv');

const DESC_PUBLIC = 'Chaîne de télévision française de service public';
// [slug, displayName, logoKey, fallbackBroadcastId, description]
const CHANNELS = [
  ['france-2', 'France 2', 'france2', '006194ea-117d-4bcf-94a9-153d999c59ae', DESC_PUBLIC],
  ['france-3', 'France 3', 'france3', '29bdf749-7082-4426-a4f3-595cc436aa0d', DESC_PUBLIC],
  ['france-4', 'France 4', 'france4', '9a6a7670-dde9-4264-adbc-55b89558594b', DESC_PUBLIC],
  ['france-5', 'France 5', 'france5', '45007886-f3ff-4b3e-9706-1ef1014c5a60', DESC_PUBLIC],
  ['franceinfo', 'franceinfo:', 'franceinfo', '35be22fb-1569-43ff-857c-99bf81defa2e', "Chaîne d'information continue française de service public"],
];
const FALLBACK_BROADCAST_IDS = Object.fromEntries(CHANNELS.map(([slug, , , bid]) => [slug, bid]));

export class FranceTVProvider extends BaseProvider {
  static providerName = 'francetv';
  static baseUrl = 'https://www.france.tv';
  static country = 'fr';

  // Metadata
  static displayName = 'France TV';
  static idPrefix = 'cutam:fr:francetv';
  static episodeMarker = 'episode:';
  static catalogId = 'fr-francetv-replay';
  static defaultChannel = 'france2';
  static supportsLive = true;

  constructor(req = null) {
    super(req);

    // France TV specific API endpoints
    this.apiMobile = 'https://api-mobile.yatta.francetv.fr';
    this.apiFront = 'http://api-front.yatta.francetv.fr';

    this.staticBase = getBaseUrl(req);

    this.shows = getProgramsForProvider('francetv');
  }

  // getPrograms comes from the BaseProvider template: it fetches
  // _getShowApiMetadata for every show in parallel and merges the result
  // through _buildShowMetadata below.

  /** Build show metadata via the FranceTV metadata processor.
   *
   * Unlike the base merge, FranceTV's API metadata contains raw image pattern
   * lists that must be transformed (`populateImages`), so the merge is
   * delegated to `enhanceMetadataWithApi`.
   */
  _buildShowMetadata(slug, info, extra = null) {
    let showMetadata = metadataProcessor.getShowMetadata(`${this.idPrefix}:${slug}`, info);
    if (extra) {
      showMetadata = metadataProcessor.enhanceMetadataWithApi(showMetadata, extra);
      for (const [k, v] of Object.entries(extra)) {
        if (v && API_FIELDS.includes(k)) showMetadata[k] = v;
      }
    }
    return showMetadata;
  }

  /** The taxonomy payload for *apiId*, cached.
   *
   * Both the id probe below and the metadata read want it, and the id probe
   * already paid for the request.
   */
  async _taxonomy(apiId) {
    return this._cachedPayload(`taxonomy:${apiId}`, () => this.apiClient.get(
      `${this.apiFront}/standard/publish/taxonomies/${apiId}`,
      { params: { platform: 'apps' } },
    ));
  }

  /** France TV addresses a show as `<channel>_<slug>`.
   *
   * The channels are probed in order, which costs nothing for a France 2 show
   * and at most five cached requests for a franceinfo one.
   */
  async _apiShowId(slug) {
    const key = CacheKeys.providerResource(this.providerName, `api_id:${slug}`);
    let apiId = cache.get(key);
    if (apiId === null) {
      apiId = '';
      // France 2 alone first — it answers for most shows, and the taxonomy it
      // returns is the one the caller wants anyway. The other four only go out
      // together when it misses, so a franceinfo show costs two round trips
      // instead of five.
      const [firstChannel] = CHANNELS[0];
      if (await this._taxonomy(`${firstChannel}_${slug}`)) {
        apiId = `${firstChannel}_${slug}`;
      } else {
        const rest = CHANNELS.slice(1).map(([channel]) => channel);
        const hits = await Promise.all(rest.map((channel) => this._taxonomy(`${channel}_${slug}`)));
        // Channel order still decides, not response order.
        const index = hits.findIndex(Boolean);
        if (index !== -1) apiId = `${rest[index]}_${slug}`;
      }
      cache.set(key, apiId, CacheTTL.PROGRAMS);
    }
    return apiId || null;
  }

  async _getShowApiMetadata(showId, showInfo) { // eslint-disable-line no-unused-vars
    return safeProviderCall(this, '_getShowApiMetadata', null, async () => {
      const apiId = await this._apiShowId(showId);
      const data = apiId ? await this._taxonomy(apiId) : null;
      if (!data) return null;

      const images = data.media_image?.patterns || [];
      const extracted = imageExtractor.extract(images, { logo: 'logo' });
      const ageMin = data.age_min;
      return {
        images,
        text: data.seo || '',
        logo: extracted.logo,
        // synopsis is the editorial pitch; description is the SEO blurb.
        description: htmlUnescape(data.synopsis || data.description || ''),
        channel: data.parent?.label,
        genres: (data.taxonomy_has_taxonomies || [])
          .filter((t) => t.taxonomy?.label)
          .map((t) => t.taxonomy.label),
        rating: Number.isInteger(ageMin) && ageMin > 3 ? `-${ageMin}` : DEFAULT_RATING,
      };
    });
  }

  /** Enrich series metadata from the France TV API.
   *
   * Overrides the base merge because the API metadata carries raw image
   * pattern lists that `populateImages` has to transform first.
   */
  async enhanceSeriesMeta(seriesMeta, showId) {
    try {
      const extra = await this._getShowApiMetadata(showId, this.shows[showId] || {});
      if (extra) {
        seriesMeta = metadataProcessor.enhanceMetadataWithApi(seriesMeta, extra);
        for (const [k, v] of Object.entries(extra)) {
          if (v && API_FIELDS.includes(k)) seriesMeta[k] = v;
        }
      }
    } catch (e) {
      logger.warning('Could not enhance series metadata for %s: %s', showId, e.message);
    }
    return seriesMeta;
  }

  /** Poster and logo images for a channel from the FranceTV API. */
  async _getChannelImages(channelId) {
    try {
      const data = await this.apiClient.get(
        `${this.apiFront}/standard/publish/taxonomies/${channelId}`,
        { params: { platform: 'apps' } },
      );
      if (!data) return { poster: '', logo: '' };

      const images = data.media_image?.patterns || [];
      const extracted = imageExtractor.extract(images, { poster: 'vignette_3x4', logo: 'logo' });
      return { poster: extracted.poster || '', logo: extracted.logo || '' };
    } catch (e) {
      logger.error('❌ [FranceTV] Error getting channel images for %s: %s', channelId, e.message);
      return { poster: '', logo: '' };
    }
  }

  /** Live TV channels with dynamic images from the France TV API (parallel). */
  async getLiveChannels() {
    const pairs = await this._parallelMap(
      async (ch) => [ch[0], await this._getChannelImages(ch[0])],
      CHANNELS,
    );
    const imageResults = Object.fromEntries(pairs);

    return CHANNELS.map(([slug, name, logoKey, , desc]) => {
      const images = imageResults[slug] || {};
      const fallback = getLogoUrl('fr', logoKey, this.req);
      return {
        id: `cutam:fr:francetv:${slug}`,
        type: 'channel',
        name,
        poster: images.poster || fallback,
        logo: images.logo || fallback,
        description: desc,
      };
    });
  }

  /** Look up the live broadcast ID and current programme title for a channel.
   *
   * Tries three sources in order: the mobile API, the front API, then the
   * hard-coded fallback IDs.
   *
   * @returns {Promise<[string|null, string|null]>} [broadcastId, currentProgramTitle]
   */
  async _getBroadcastId(channelName) {
    let broadcastId = null;
    let currentProgramTitle = null;

    try {
      const data = await this.apiClient.get(
        `${this.apiMobile}/apps/channels/${channelName}`,
        { params: { platform: 'apps' } },
      );
      if (data) {
        for (const collection of data.collections || []) {
          if (collection.type === 'live') {
            const items = collection.items || [];
            if (items.length) {
              currentProgramTitle = items[0].title || '';
              const ch = items[0].channel || {};
              if (ch.si_id) broadcastId = ch.si_id;
            }
            break;
          }
        }
      }
    } catch (e) {
      logger.error('   ⚠️ Mobile API failed: %s', e.message);
    }

    if (!broadcastId) {
      try {
        const data = await this.apiClient.get(`${this.apiFront}/standard/edito/directs`);
        if (data) {
          for (const live of data.result || []) {
            if (live.channel === channelName) {
              const collections = live.collection || [];
              if (collections.length && !currentProgramTitle) {
                currentProgramTitle = collections[0].title || '';
              }
              for (const m of (collections.length ? collections[0].content_has_medias || [] : [])) {
                if (m.media && 'si_direct_id' in m.media) {
                  broadcastId = m.media.si_direct_id;
                  break;
                }
              }
              break;
            }
          }
        }
      } catch (e) {
        logger.error('   ⚠️ Front API failed: %s', e.message);
      }
    }

    if (!broadcastId) broadcastId = FALLBACK_BROADCAST_IDS[channelName] ?? null;

    return [broadcastId, currentProgramTitle];
  }

  async getChannelStreamUrl(channelId) {
    return safeProviderCall(this, 'getChannelStreamUrl', null, async () => {
      logger.debug('🔍 [FranceTV] Getting live stream for %s', channelId);
      const channelName = channelId.split(':').pop();
      const [broadcastId, currentProgramTitle] = await this._getBroadcastId(channelName);

      if (!broadcastId) {
        logger.error('   ❌ No broadcast ID found for %s', channelName);
        return null;
      }

      const params = {
        country_code: 'FR',
        os: 'androidtv',
        diffusion_mode: 'tunnel_first',
        offline: 'false',
      };

      const videoData = await this.apiClient.get(
        `https://k7.ftven.fr/videos/${broadcastId}`, { params, maxRetries: 2 },
      );

      if (!videoData || !videoData.video) {
        logger.error("   ❌ No 'video' key in response or API failed");
        return null;
      }

      const videoInfo = videoData.video;
      const tokenField = videoInfo.token;
      const urlToken = (tokenField && typeof tokenField === 'object')
        ? (tokenField.akamai || 'https://hdfauth.ftven.fr/esi/TA')
        : (tokenField || 'https://hdfauth.ftven.fr/esi/TA');

      const tokenData = await this.apiClient.get(urlToken, {
        params: { format: 'json', url: videoInfo.url || '' },
        maxRetries: 2,
      });

      if (!tokenData || !tokenData.url) {
        logger.error('   ❌ Token API failed or no URL found');
        return null;
      }

      const manifestType = this._detectManifestType(tokenData.url);
      // The signed URL is only playable from France, so hand the player this
      // addon's copy instead and let the proxy do the travelling.
      const finalUrl = buildFtvManifestUrl(getBaseUrl(this.req), tokenData.url);
      const formatLabel = manifestType === 'hls' ? 'HLS' : 'MPD';
      const streamTitle = currentProgramTitle
        ? `[${formatLabel}] ${currentProgramTitle}`
        : `[${formatLabel}] ${channelName.toUpperCase()}`;
      return [{ url: finalUrl, manifest_type: manifestType, title: streamTitle }];
    });
  }

  /** Fetch and filter the raw episode list from the France TV API. */
  async _fetchEpisodesRaw(slug) {
    const apiShowId = await this._apiShowId(slug);
    const apiUrl = `${this.apiFront}/standard/publish/taxonomies/${apiShowId}/contents/`;
    const params = { size: 20, page: 0, filter: 'with-no-vod,only-visible', sort: 'begin_date:desc' };
    const data = await this.apiClient.get(apiUrl, { params });
    if (!data || !data.result) {
      logger.error('❌ [FranceTV] API failed or no result for %s', slug);
      return null;
    }
    const filtered = data.result.filter((v) => ['integrale', 'extrait'].includes(v.type));
    return filtered.length ? filtered : null;
  }

  _fallbackEpisodes(slug) {
    logger.warning('⚠️ [FranceTV] Using fallback episode for %s', slug);
    return [this._createFallbackEpisode(slug)];
  }

  async _parseEpisode(episodeData, episodeNumber) {
    return safeProviderCall(this, '_parseEpisode', null, async () => {
      const title = episodeData.title ?? episodeData.label ?? 'Unknown Title';
      const rawDescription = episodeData.text ?? episodeData.description ?? '';
      const description = rawDescription ? htmlUnescape(rawDescription) : '';

      // Collect all image patterns from both API sources, then extract in one pass
      const patterns = [];
      for (const m of episodeData.content_has_medias || []) {
        if (m.type === 'image') patterns.push(...(m.media?.patterns || []));
      }
      patterns.push(...(episodeData.media_image?.patterns || []));
      const imgs = imageExtractor.extract(patterns, {
        poster: 'vignette_16x9',
        fanart: 'background_16x9',
        poster_sq: 'carre',
      });
      const poster = imgs.poster || imgs.poster_sq;
      const fanart = imgs.fanart || imgs.poster || imgs.poster_sq;

      let broadcastId = null;
      for (const medium of episodeData.content_has_medias || []) {
        if (medium.type === 'main') {
          broadcastId = medium.media?.si_id ?? null;
          break;
        }
      }
      if (!broadcastId) broadcastId = episodeData.id;
      if (!broadcastId) return null;

      let airDate = episodeData.begin_date || '';
      if (airDate && String(airDate).includes('T')) airDate = String(airDate).split('T')[0];

      let released = '';
      const firstPubDate = episodeData.first_publication_date || '';
      if (firstPubDate) {
        // The wall-clock parts are kept as-is (no timezone conversion), which
        // is what datetime.fromisoformat().strftime() did on the Python side.
        const m = String(firstPubDate).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
        released = m ? `${m[1]}T${m[2]}.000Z` : firstPubDate;
      }

      const episodeMeta = {
        id: `cutam:fr:francetv:episode:${broadcastId}`,
        title,
        description,
        poster,
        fanart,
        broadcast_id: broadcastId,
        type: 'episode',
        air_date: airDate,
        released,
        episode_number: episodeNumber,
        season: 1,
        episode: episodeNumber,
      };
      return metadataProcessor.enhanceMetadataWithApi(episodeMeta, episodeData);
    });
  }

  async getEpisodeStreamUrl(episodeId) {
    return safeProviderCall(this, 'getEpisodeStreamUrl', null, async () => {
      const broadcastId = this._extractAfterMarker(episodeId);
      const params = {
        country_code: 'FR',
        os: 'androidtv',
        diffusion_mode: 'tunnel_first',
        offline: 'false',
      };
      const videoData = await this.apiClient.get(
        `https://k7.ftven.fr/videos/${broadcastId}`, { params, maxRetries: 2 },
      );
      if (!videoData || !videoData.video) {
        logger.error('❌ [FranceTV] Failed to get video info or API failed');
        return null;
      }
      const streamUrl = videoData.video.url;
      if (!streamUrl) {
        logger.error('❌ [FranceTV] No video URL found');
        return null;
      }
      const tokenData = await this.apiClient.get('https://hdfauth.ftven.fr/esi/TA', {
        params: { format: 'json', url: streamUrl },
        maxRetries: 2,
      });
      if (!tokenData || !tokenData.url) {
        logger.error('❌ [FranceTV] Failed to get stream URL');
        return null;
      }
      // Replays are DASH (`.../manifest.mpd`, `format: dash` in the k7 payload);
      // calling them HLS was only ever survivable because players sniff.
      return [{
        url: buildFtvManifestUrl(getBaseUrl(this.req), tokenData.url),
        manifest_type: this._detectManifestType(tokenData.url),
      }];
    });
  }
}
