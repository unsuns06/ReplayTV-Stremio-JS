import fs from 'node:fs';

import { getLogger } from './logger.js';
import { cache } from './cache.js';
import { CacheKeys, CacheTTL } from './cacheKeys.js';
import { dataFile } from './paths.js';

const logger = getLogger('utils.programsLoader');

/** Path to the programs.json file. */
export function getProgramsFilePath() {
  return dataFile('programs.json');
}

/** Load programs from the JSON file, cached for CacheTTL.PROGRAMS_FILE. */
function loadPrograms() {
  const cached = cache.get(CacheKeys.programsFile());
  if (cached) return cached;

  const filePath = getProgramsFilePath();
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    cache.set(CacheKeys.programsFile(), data, CacheTTL.PROGRAMS_FILE);
    logger.debug('✅ [ProgramsLoader] Loaded %d shows from programs.json', (data.shows || []).length);
    return data;
  } catch (e) {
    if (e.code === 'ENOENT') {
      logger.warning('⚠️ [ProgramsLoader] programs.json not found at %s', filePath);
    } else {
      logger.error('❌ [ProgramsLoader] Error loading programs.json: %s', e.message);
    }
    return { version: '1.0', shows: [] };
  }
}

/**
 * All enabled programs for a specific provider.
 * @returns {Object} mapping slug -> program data
 */
export function getProgramsForProvider(providerName) {
  const data = loadPrograms();
  const shows = data.shows || [];

  const result = {};
  for (const show of shows) {
    if (show.provider === providerName && (show.enabled ?? true)) {
      const slug = show.slug;
      if (!slug) continue;
      // Pass every pinned field through untouched. Absent fields stay absent so
      // providers can tell "not set" from "set to empty" and fill them from
      // their metadata API; defaults are applied later by buildShowDict.
      const programData = {};
      for (const [k, v] of Object.entries(show)) {
        if (k !== 'provider' && k !== 'enabled') programData[k] = v;
      }
      programData.id = slug;
      result[slug] = programData;
    }
  }

  logger.debug("✅ [ProgramsLoader] Found %d shows for provider '%s'", Object.keys(result).length, providerName);
  return result;
}

/** All enabled programs from all providers. */
export function getAllPrograms() {
  return (loadPrograms().shows || []).filter((show) => show.enabled ?? true);
}

/** Force reload of programs.json (clears the cache). */
export function reloadPrograms() {
  cache.delete(CacheKeys.programsFile());
  logger.info('🔄 [ProgramsLoader] Programs cache cleared');
}
