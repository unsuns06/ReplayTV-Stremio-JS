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

/** Force reload of programs.json, dropping everything derived from it.
 *
 * The parsed file is cached for an hour and each provider's catalogue for ten
 * minutes, so clearing only the first would leave the catalogues — and the
 * show lists in the manifest — stale after an edit. The Python addon got this
 * for free by restarting the server whenever the file changed; this is the same
 * effect without dropping in-flight requests.
 */
export function reloadPrograms() {
  cache.delete(CacheKeys.programsFile());
  const dropped = cache.deletePrefix('programs:');
  logger.info('🔄 [ProgramsLoader] Programs cache cleared (%d catalogue(s) dropped)', dropped);
}

/** Re-read programs.json whenever it changes on disk. Returns a stop function.
 *
 * Covers the edits the save route cannot see for itself: a git pull, an editor
 * running in another checkout, or the file being changed by hand.
 */
export function watchProgramsFile() {
  const filePath = getProgramsFilePath();
  let timer = null;
  let watcher = null;
  try {
    watcher = fs.watch(filePath, () => {
      // One save touches the file more than once; settle before re-reading.
      clearTimeout(timer);
      timer = setTimeout(() => {
        logger.info('🔄 [ProgramsLoader] programs.json changed on disk');
        reloadPrograms();
      }, 250);
    });
    watcher.unref?.();
  } catch (e) {
    logger.warning('⚠️ [ProgramsLoader] Could not watch programs.json: %s', e.message);
    return () => {};
  }
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
