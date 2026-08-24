import express from 'express';

import { getLogger } from '../utils/logger.js';
import { streamResponse } from '../schemas/stremio.js';
import { ProviderFactory } from '../providers/factory.js';
import { makeIpHeaders } from '../utils/clientIp.js';
import { parseStremioId } from '../utils/ids.js';
import { PROVIDER_REGISTRY, getLiveProviders, getProviderByIdPrefix } from '../config/providerConfig.js';

export const router = express.Router();
const logger = getLogger('routers.stream');

const LIVE_PROVIDERS = getLiveProviders();

/** Merge provider headers with viewer IP headers. */
function mergeHeaders(providerHeaders, includeIp = true) {
  const merged = { ...(providerHeaders || {}) };
  if (includeIp) Object.assign(merged, makeIpHeaders());
  return Object.keys(merged).length ? merged : null;
}

/** Build a Stream object from a stream info object. */
function buildStreamFromInfo(info, includeIpHeaders = true) {
  const mergedHeaders = mergeHeaders(info.headers, includeIpHeaders);
  const mergedLicenseHeaders = mergeHeaders(info.licenseHeaders, includeIpHeaders);

  // ponytail: every URL we return is already a self-contained MediaFlow/dash-proxy
  // URL with upstream headers baked into the query string, so it's web-ready and
  // must NOT carry notWebReady/proxyHeaders — that makes Stremio re-proxy it and
  // inject the wrong headers, killing playback. Add proxyHeaders back (gated on a
  // per-stream "raw url" flag) only if a provider ever returns an un-proxied URL.

  return {
    url: info.url,
    title: info.title ?? `${(info.manifest_type || 'stream').toUpperCase()} Stream`,
    behaviorHints: null,
    headers: mergedHeaders,
    manifest_type: info.manifest_type ?? null,
    licenseUrl: info.licenseUrl ?? null,
    licenseHeaders: mergedLicenseHeaders,
    externalUrl: info.externalUrl ?? null,
  };
}

/** Build a stream response from provider stream info (always a list). */
function buildStreamResponse(streamInfo, providerName, includeIpHeaders = true) {
  if (!streamInfo || !streamInfo.length) {
    logger.warning('⚠️ %s returned no stream info', providerName);
    return streamResponse([]);
  }
  const streams = streamInfo.map((info) => buildStreamFromInfo(info, includeIpHeaders));
  logger.info('✅ %s returned %d streams', providerName, streams.length);
  return streamResponse(streams);
}

/** Handle live channel stream requests. */
async function handleChannelStream(id, req) {
  logger.info('📺 Processing live stream request for channel: %s', id);

  // Determine the provider by parsing the composite ID (no substring matching)
  const parsed = parseStremioId(id);
  const providerKey = parsed && LIVE_PROVIDERS.includes(parsed.provider) ? parsed.provider : null;

  if (!providerKey) {
    logger.warning('⚠️ Unknown channel provider in ID: %s', id);
    return streamResponse([]);
  }

  const providerName = PROVIDER_REGISTRY[providerKey].display_name;

  logger.info('🎯 Using %s provider for channel: %s', providerName, id);

  try {
    const provider = ProviderFactory.createProvider(providerKey, req);
    const streamInfo = await provider.getChannelStreamUrl(id);
    return buildStreamResponse(streamInfo, providerName, true);
  } catch (e) {
    logger.exception('❌ Error getting %s stream for channel %s', providerName, id, e);
    return streamResponse([]);
  }
}

/** Handle series/episode stream requests for any provider. */
async function handleSeriesStream(providerKey, id, req) {
  const config = PROVIDER_REGISTRY[providerKey];
  const providerName = config.display_name;
  const episodeMarker = config.episode_marker;

  logger.info('📺 Processing %s replay stream request: %s', providerName, id);

  try {
    const provider = ProviderFactory.createProvider(providerKey, req);

    if (!id.includes(episodeMarker)) {
      logger.warning('⚠️ No episode specified in series ID: %s', id);
      return streamResponse([]);
    }

    logger.info('🎬 Getting stream for specific episode: %s', id);

    const streamInfo = await provider.getEpisodeStreamUrl(id);

    return buildStreamResponse(streamInfo, providerName, provider.needsIpForwarding);
  } catch (e) {
    logger.exception('❌ Error getting %s stream', providerName, e);
    return streamResponse([]);
  }
}

router.get('/stream/:type/:id', async (req, res) => {
  const { type } = req.params;
  const id = req.params.id.replace(/\.json$/, '');
  logger.info('🔍 STREAM REQUEST: type=%s, id=%s', type, id);

  if (type === 'channel') return res.json(await handleChannelStream(id, req));

  if (type === 'series') {
    const providerKey = getProviderByIdPrefix(id);
    if (providerKey) return res.json(await handleSeriesStream(providerKey, id, req));
  }

  logger.warning('⚠️ Unknown stream request: type=%s, id=%s', type, id);
  return res.json(streamResponse([]));
});
