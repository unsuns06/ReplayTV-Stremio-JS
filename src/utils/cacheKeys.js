/** Canonical cache key and TTL definitions for the global InMemoryCache.
 *
 * All modules that read or write the shared cache must use these helpers so
 * that key-naming is consistent and refactoring a key only requires one edit.
 * TTLs live next to their keys (`CacheTTL`) so a key's lifetime is defined
 * exactly once instead of being re-declared per router.
 */

/** Seconds-to-live for each cache key family. */
export const CacheTTL = {
  CHANNELS: 300, // 5 min  — live-channel lists
  PROGRAMS: 600, // 10 min — replay-show catalogues
  EPISODES: 600, // 10 min — episode lists
  STREAM: 1800, // 30 min — resolved stream URLs (signed, limited life)
  PROGRAMS_FILE: 3600, // 1 hour — parsed programs.json contents
};

/** Factory functions for every cache key used in this addon. */
export const CacheKeys = {
  /** Live-channel list for a provider. TTL: CacheTTL.CHANNELS. */
  channels: (provider) => `channels:${provider}`,
  /** Replay-show catalogue for a provider. TTL: CacheTTL.PROGRAMS. */
  programs: (provider) => `programs:${provider}`,
  /** Episode list for a series. TTL: CacheTTL.EPISODES. */
  episodes: (seriesId) => `episodes:${seriesId}`,
  /** Resolved stream URL for an episode. TTL: CacheTTL.STREAM. */
  stream: (episodeId) => `stream:${episodeId}`,
  /** Parsed programs.json file contents. TTL: CacheTTL.PROGRAMS_FILE. */
  programsFile: () => 'programs_data',
  /** Persisted auth tokens for a provider. TTL: derived from JWT expiry. */
  authState: (provider) => `auth:${provider}`,
  /** Provider-internal API resource (e.g. a GraphQL program list). */
  providerResource: (provider, resource) => `provider:${provider}:${resource}`,
};
