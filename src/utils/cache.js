import { getLogger } from './logger.js';

const logger = getLogger('utils.cache');

/**
 * In-memory cache with TTL and LRU eviction.
 *
 * Hit/miss counters are tracked and logged at DEBUG level on every access,
 * and can be read at any time via `stats()`.
 *
 * ponytail: no lock — Node runs one JS thread, so the Python `threading.Lock`
 * has nothing to guard here. A Map preserves insertion order, which is all the
 * LRU needs; re-inserting on a hit moves an entry to the end.
 */
export class InMemoryCache {
  constructor(maxSize = 1000) {
    this._cache = new Map();
    this._maxSize = maxSize;
    this._hits = 0;
    this._misses = 0;
  }

  /** Return the cached value for *key*, or `null` on miss / expiry. */
  get(key) {
    const entry = this._cache.get(key);
    if (entry !== undefined) {
      const [value, expiry] = entry;
      if (Date.now() / 1000 < expiry) {
        this._cache.delete(key);
        this._cache.set(key, entry);
        this._hits += 1;
        logger.debug('Cache HIT  key=%s  (hits=%d misses=%d)', key, this._hits, this._misses);
        return value;
      }
      this._cache.delete(key);
    }
    this._misses += 1;
    logger.debug('Cache MISS key=%s  (hits=%d misses=%d)', key, this._hits, this._misses);
    return null;
  }

  /** Store *value* under *key* with a TTL of *ttl* seconds. */
  set(key, value, ttl = 60) {
    const expiry = Date.now() / 1000 + ttl;
    this._cache.delete(key);
    this._cache.set(key, [value, expiry]);
    if (this._cache.size > this._maxSize) {
      this._cache.delete(this._cache.keys().next().value);
    }
  }

  /** Remove *key* from the cache (no-op if the key does not exist). */
  delete(key) {
    this._cache.delete(key);
  }

  /** Remove every entry from the cache. */
  clear() {
    this._cache.clear();
  }

  /** Snapshot of hit/miss counters. */
  stats() {
    const total = this._hits + this._misses;
    return {
      hits: this._hits,
      misses: this._misses,
      size: this._cache.size,
      hit_rate: total ? `${((this._hits / total) * 100).toFixed(1)}%` : 'n/a',
    };
  }
}

// Global cache instance with safe default limit
export const cache = new InMemoryCache(1000);
