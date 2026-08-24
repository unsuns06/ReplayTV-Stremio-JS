/**
 * Centralized provider configuration registry.
 * Dynamically built from the provider classes, so they stay the single source
 * of truth and adding a provider never means editing this file.
 */
import { PROVIDER_CLASSES } from '../providers/registry.js';
import { parseStremioId } from '../utils/ids.js';

function buildRegistry() {
  const registry = {};
  for (const [key, cls] of Object.entries(PROVIDER_CLASSES)) {
    registry[key] = {
      provider_name: cls.providerName,
      display_name: cls.displayName,
      id_prefix: cls.idPrefix,
      country: cls.country,
      episode_marker: cls.episodeMarker,
      catalog_id: cls.catalogId,
      supports_live: Boolean(cls.supportsLive),
      default_channel: cls.defaultChannel,
      credentials_key: cls.credentialsKey || cls.providerName,
    };
  }
  return registry;
}

/** Centralized provider registry — single source of truth (dynamically built). */
export const PROVIDER_REGISTRY = buildRegistry();

/** Configuration for a specific provider, or undefined if not found. */
export function getProviderConfig(providerKey) {
  return PROVIDER_REGISTRY[providerKey];
}

/** All provider configurations. */
export function getAllProviders() {
  return PROVIDER_REGISTRY;
}

/** Provider keys filtered by two-letter country code. */
export function getProvidersByCountry(country) {
  return Object.entries(PROVIDER_REGISTRY)
    .filter(([, config]) => config.country === country)
    .map(([key]) => key);
}

/** Provider keys that support live channels. */
export function getLiveProviders() {
  return Object.entries(PROVIDER_REGISTRY)
    .filter(([, config]) => config.supports_live)
    .map(([key]) => key);
}

/** Provider key for a catalog ID (e.g. "fr-francetv-replay"), or null. */
export function getProviderByCatalogId(catalogId) {
  for (const [key, config] of Object.entries(PROVIDER_REGISTRY)) {
    if (config.catalog_id === catalogId) return key;
  }
  return null;
}

/**
 * Identify the provider from a composite ID string.
 *
 * Parses the documented `cutam:{country}:{provider}:...` grammar instead of
 * prefix-matching, so an empty/missing id_prefix can never match everything
 * and provider keys embedded elsewhere in an ID cannot mis-route.
 */
export function getProviderByIdPrefix(idString) {
  const parsed = parseStremioId(idString);
  if (parsed && parsed.provider in PROVIDER_REGISTRY) return parsed.provider;
  return null;
}
