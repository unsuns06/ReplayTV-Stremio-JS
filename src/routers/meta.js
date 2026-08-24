import express from 'express';

import { getLogger } from '../utils/logger.js';
import { metaResponse } from '../schemas/stremio.js';
import { ProviderFactory } from '../providers/factory.js';
import { getBaseUrl } from '../utils/baseUrl.js';
import { parseStremioId } from '../utils/ids.js';
import { getProgramsForProvider } from '../utils/programsLoader.js';
import { cache } from '../utils/cache.js';
import { CacheKeys, CacheTTL } from '../utils/cacheKeys.js';
import {
  PROVIDER_REGISTRY,
  getLiveProviders,
  getProviderByIdPrefix,
  getProviderConfig,
} from '../config/providerConfig.js';

export const router = express.Router();
const logger = getLogger('routers.meta');

const CHANNEL_PROVIDERS = getLiveProviders();

/** Show metadata from programs.json for a specific show. */
function getShowMetadataFromPrograms(providerName, showSlug, staticBase) {
  const programs = getProgramsForProvider(providerName);
  if (showSlug in programs) {
    const show = programs[showSlug];
    const cfg = getProviderConfig(providerName) || {};
    const country = cfg.country || 'fr';
    const defaultChannel = cfg.default_channel || 'france2';
    const fallbackLogo = `${staticBase}/static/logos/${country}/${defaultChannel}.png`;
    return {
      id: showSlug,
      name: show.name ?? showSlug,
      description: show.description ?? '',
      logo: show.logo || fallbackLogo,
      poster: show.poster ?? '',
      background: show.background ?? '',
      channel: show.channel ?? '',
      genres: show.genres ?? [],
      year: show.year ?? 2024,
      rating: show.rating ?? 'Tous publics',
    };
  }
  return null;
}

/** Build a video object from episode and show metadata. */
function buildVideoData(episode, showMeta, index) {
  const videoData = {
    id: episode.id,
    title: episode.title,
    season: episode.season ?? 1,
    episode: episode.episode ?? index + 1,
    thumbnail: episode.poster ?? (showMeta.poster || showMeta.logo || ''),
    description: episode.description ?? '',
    overview: episode.description ?? '',
    summary: episode.description ?? '',
    duration: episode.duration ?? '',
    broadcast_date: episode.broadcast_date ?? '',
    rating: episode.rating ?? '',
    director: episode.director ?? '',
    cast: episode.cast ?? [],
    channel: episode.channel ?? (showMeta.channel ?? ''),
    program: episode.program ?? (showMeta.name ?? ''),
    type: episode.type ?? 'episode',
  };

  // Only add 'released' when it exists and is non-empty (optional for Stremio)
  if (episode.released) videoData.released = episode.released;

  return videoData;
}

/** Build a series metadata object from show metadata and videos. */
function buildSeriesMeta(showMeta, idPrefix, videos) {
  return {
    id: `${idPrefix}:${showMeta.id}`,
    type: 'series',
    name: showMeta.name,
    poster: showMeta.poster || showMeta.logo || '',
    logo: showMeta.logo ?? '',
    background: showMeta.background ?? '',
    description: showMeta.description ?? '',
    channel: showMeta.channel ?? '',
    genres: showMeta.genres ?? [],
    year: showMeta.year ?? 2024,
    rating: showMeta.rating ?? 'Tous publics',
    videos,
  };
}

/** Search for channel metadata across all channel providers in parallel. */
async function handleChannelMetadata(id, req) {
  const fetchFromProvider = async (providerKey) => {
    const cacheKey = CacheKeys.channels(providerKey);
    let channels = cache.get(cacheKey);
    if (channels === null) {
      try {
        const provider = ProviderFactory.createProvider(providerKey, req);
        channels = await provider.getLiveChannels();
        cache.set(cacheKey, channels, CacheTTL.CHANNELS);
      } catch (e) {
        logger.error('Error getting %s channel metadata: %s', providerKey, e.message);
        return null;
      }
    }
    return channels.find((channel) => channel.id === id) ?? null;
  };

  const results = await Promise.all(CHANNEL_PROVIDERS.map(fetchFromProvider));

  for (const result of results) {
    if (result) {
      return metaResponse({
        id: result.id,
        type: 'channel',
        name: result.name,
        logo: result.logo ?? '',
        poster: result.poster ?? '',
        description: result.description ?? '',
        videos: [],
      });
    }
  }

  return null;
}

/** Extract the show slug from a series ID. */
function extractShowIdFromId(id) {
  const parsed = parseStremioId(id);
  return parsed ? parsed.slug : null;
}

/** Handle series metadata for any provider. */
async function handleSeriesMetadata(providerKey, showId, req, staticBase) {
  const config = PROVIDER_REGISTRY[providerKey];
  const providerName = config.provider_name;
  const displayName = config.display_name;
  const idPrefix = config.id_prefix;

  try {
    const provider = ProviderFactory.createProvider(providerName, req);

    const showMeta = getShowMetadataFromPrograms(providerName, showId, staticBase);
    if (!showMeta) return metaResponse(null);

    // Episodes for the show (cached)
    const seriesId = `${idPrefix}:${showId}`;
    const episodesCacheKey = CacheKeys.episodes(seriesId);
    let episodes = cache.get(episodesCacheKey);
    if (episodes === null) {
      episodes = await provider.getEpisodes(seriesId);
      cache.set(episodesCacheKey, episodes, CacheTTL.EPISODES);
    }

    const videos = episodes.map((ep, i) => buildVideoData(ep, showMeta, i));

    let seriesMeta = buildSeriesMeta(showMeta, idPrefix, videos);
    seriesMeta = await provider.enhanceSeriesMeta(seriesMeta, showId);

    return metaResponse(seriesMeta);
  } catch (e) {
    logger.error('Error getting %s series metadata: %s', displayName, e.message);

    // Fallback to programs.json data only
    const showMeta = getShowMetadataFromPrograms(providerName, showId, staticBase);
    if (showMeta) return metaResponse(buildSeriesMeta(showMeta, idPrefix, []));

    return metaResponse(null);
  }
}

router.get('/meta/:type/:id', async (req, res) => {
  const { type } = req.params;
  const id = req.params.id.replace(/\.json$/, '');

  // Base URL for static assets (env override or derived from the request)
  const staticBase = getBaseUrl(req);

  if (type === 'channel') {
    const result = await handleChannelMetadata(id, req);
    return res.json(result || metaResponse(null));
  }

  if (type === 'series') {
    const providerKey = getProviderByIdPrefix(id);
    if (providerKey) {
      const showId = extractShowIdFromId(id);
      if (showId) return res.json(await handleSeriesMetadata(providerKey, showId, req, staticBase));
    }
  }

  return res.json(metaResponse(null));
});
