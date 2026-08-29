/** Stremio addon manifest, generated from the provider registry.
 *
 * Catalog entries and ID prefixes are derived from `PROVIDER_REGISTRY` and
 * `programs.json` so that adding or renaming a provider never requires a manual
 * manifest edit — only the static addon identity lives here.
 */
import { PROVIDER_REGISTRY } from './config/providerConfig.js';
import { getProgramsForProvider } from './utils/programsLoader.js';

export const ADDON_ID = 'org.catchuptvandmore.stremio';
// Stremio caches an installed addon's manifest and only re-reads it when this
// changes, so a new provider is invisible to existing installs until it moves.
export const ADDON_VERSION = '1.2.0';
export const ADDON_NAME = 'Catch-up TV & More';

/** Build a catalog display name listing the provider's shows. */
function catalogName(providerKey, displayName) {
  let names = '';
  try {
    const shows = getProgramsForProvider(providerKey);
    names = Object.entries(shows).map(([slug, info]) => info.name || slug).join(', ');
  } catch {
    names = '';
  }
  return names ? `${displayName} TV Shows: ${names}` : `${displayName} TV Shows`;
}

export function getManifest() {
  const catalogs = [
    { id: 'fr-live', type: 'channel', name: 'French Live TV' },
  ];
  for (const [key, cfg] of Object.entries(PROVIDER_REGISTRY)) {
    if (cfg.catalog_id) {
      catalogs.push({
        id: cfg.catalog_id,
        type: 'series',
        name: catalogName(key, cfg.display_name),
      });
    }
  }

  const idPrefixes = [...new Set(
    Object.values(PROVIDER_REGISTRY)
      .filter((cfg) => cfg.country)
      .map((cfg) => `cutam:${cfg.country}:`),
  )].sort();

  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: ADDON_NAME,
    description: 'Live TV and TV show replays from '
      + Object.values(PROVIDER_REGISTRY).map((cfg) => cfg.display_name).join(', '),
    logo: 'https://catch-up-tv-and-more.github.io/images/logo.png',
    background: 'https://catch-up-tv-and-more.github.io/images/background.jpg',
    resources: ['catalog', 'meta', 'stream'],
    types: ['channel', 'series'],
    catalogs,
    idPrefixes,
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
  };
}
