/** Cross-request persistence for provider auth tokens.
 *
 * Provider instances are created per request (see `ProviderFactory`), so any
 * token stored on the instance is discarded when the request ends.  Without
 * this module, MyTF1 and 6play performed a full multi-round-trip login on
 * *every* stream request.
 *
 * Usage:
 *
 *     const state = loadAuthState('mytf1');
 *     if (state) this.authToken = state.auth_token;
 *     ...
 *     storeAuthState('mytf1', { auth_token: token }, token);
 *
 * The TTL is derived from the JWT `exp` claim when possible (minus a safety
 * buffer), falling back to a conservative default.
 */
import { getLogger } from './logger.js';
import { cache } from './cache.js';
import { CacheKeys } from './cacheKeys.js';

const logger = getLogger('utils.authCache');

export const DEFAULT_TOKEN_TTL = 4 * 3600; // 4 hours when the token carries no usable exp
export const EXPIRY_BUFFER = 300; // refresh 5 minutes before actual expiry

/** Decode a JWT payload without verifying the signature.
 *
 * We only need the claims to pick a cache TTL, never to trust the token —
 * which is why this is 3 lines of base64url instead of a JWT library.
 */
export function decodeJwt(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

/** Seconds until *token* expires (minus a buffer), or *fallback*. */
export function ttlFromJwt(token, fallback = DEFAULT_TOKEN_TTL) {
  if (!token) return fallback;
  const decoded = decodeJwt(token);
  const exp = decoded?.exp;
  if (exp) return Math.max(Math.floor(exp - Date.now() / 1000) - EXPIRY_BUFFER, 0);
  if (!decoded) logger.debug('auth_cache: could not decode JWT for TTL');
  return fallback;
}

/** Persist *state* (an object of tokens/IDs) for *provider*. */
export function storeAuthState(provider, state, tokenForTtl = null, ttl = null) {
  const effectiveTtl = ttl !== null && ttl !== undefined ? ttl : ttlFromJwt(tokenForTtl);
  if (effectiveTtl <= 0) {
    logger.debug('auth_cache: %s token already expired — not caching', provider);
    return;
  }
  cache.set(CacheKeys.authState(provider), state, effectiveTtl);
  logger.debug('auth_cache: stored %s auth state (ttl=%ds)', provider, effectiveTtl);
}

/** The cached auth state for *provider*, or `null`. */
export function loadAuthState(provider) {
  const state = cache.get(CacheKeys.authState(provider));
  if (state !== null && (typeof state !== 'object' || Array.isArray(state))) return null;
  return state;
}

/** Drop the cached auth state for *provider* (e.g. after a 401). */
export function clearAuthState(provider) {
  cache.delete(CacheKeys.authState(provider));
}
