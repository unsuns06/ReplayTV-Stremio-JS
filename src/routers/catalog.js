import express from 'express';

import { getLogger } from '../utils/logger.js';
import { catalogResponse } from '../schemas/stremio.js';
import { ProviderFactory } from '../providers/factory.js';
import { getLogoUrl } from '../utils/baseUrl.js';
import { getProgramsForProvider } from '../utils/programsLoader.js';
import { buildShowDict } from '../utils/showMeta.js';
import { cache } from '../utils/cache.js';
import { CacheKeys, CacheTTL } from '../utils/cacheKeys.js';
import { getProviderByCatalogId, getLiveProviders, getProviderConfig } from '../config/providerConfig.js';

export const router = express.Router();
const logger = getLogger('routers.catalog');

/** Build the fallback show list from programs.json for a specific provider. */
function buildFallbackShowsFromPrograms(providerName, req) {
  const cfg = getProviderConfig(providerName) || {};
  const region = cfg.country || 'fr';
  const defaultChannel = cfg.default_channel || 'france2';
  const idPrefix = cfg.id_prefix || `cutam:${region}:${providerName}`;
  try {
    const programs = getProgramsForProvider(providerName);
    const fallbackLogo = getLogoUrl(region, defaultChannel, req);
    return Object.entries(programs)
      .map(([slug, showInfo]) => buildShowDict(idPrefix, slug, showInfo, fallbackLogo));
  } catch (e) {
    logger.error('❌ Error building fallback shows from programs.json: %s', e.message);
    return [];
  }
}

// `:id` swallows the `.json` suffix, which is stripped below — a plain param
// keeps the route valid on both Express 4 and 5 path syntaxes.
router.get('/catalog/:type/:id', async (req, res) => {
  const { type } = req.params;
  const id = req.params.id.replace(/\.json$/, '');
  logger.info('🔍 CATALOG REQUEST: type=%s, id=%s', type, id);

  // Live TV channels
  if (type === 'channel' && id === 'fr-live') {
    logger.info('📺 Processing live TV channels request');
    const liveProviderKeys = getLiveProviders();

    const fetchProviderChannels = async (pKey) => {
      const cacheKey = CacheKeys.channels(pKey);
      const cached = cache.get(cacheKey);
      if (cached !== null) {
        logger.debug('📺 %s channels served from cache (%d items)', pKey, cached.length);
        return cached;
      }

      try {
        logger.debug('📺 Getting %s channels...', pKey);
        const provider = ProviderFactory.createProvider(pKey, req);
        const channels = await provider.getLiveChannels();
        cache.set(cacheKey, channels, CacheTTL.CHANNELS);
        logger.debug('✅ %s returned %d channels', pKey, channels.length);
        return channels;
      } catch (e) {
        logger.exception('❌ Error getting %s channels', pKey, e);
        return [];
      }
    };

    const results = await Promise.all(liveProviderKeys.map(fetchProviderChannels));
    const allChannels = results.flat();

    logger.info('📊 Total channels returned: %d', allChannels.length);
    return res.json(catalogResponse(allChannels));
  }

  // Series catalogs, resolved dynamically
  if (type === 'series') {
    const providerKey = getProviderByCatalogId(id);

    if (providerKey) {
      logger.info('📺 Processing %s catalog request: %s', providerKey, id);
      try {
        const cacheKey = CacheKeys.programs(providerKey);
        let shows = cache.get(cacheKey);
        if (shows !== null) {
          logger.info('✅ %s shows served from cache (%d items)', providerKey, shows.length);
          return res.json(catalogResponse(shows));
        }

        const provider = ProviderFactory.createProvider(providerKey, req);
        shows = await provider.getPrograms();
        cache.set(cacheKey, shows, CacheTTL.PROGRAMS);
        logger.info('✅ %s returned %d shows', providerKey, shows.length);
        return res.json(catalogResponse(shows));
      } catch (e) {
        logger.exception('❌ Error getting %s shows', providerKey, e);
        logger.info('🔄 Using fallback %s shows from programs.json', providerKey);
        return res.json(catalogResponse(buildFallbackShowsFromPrograms(providerKey, req)));
      }
    }
  }

  logger.warning('⚠️ Unknown catalog request: type=%s, id=%s', type, id);
  return res.json(catalogResponse([]));
});
