/** Keeps every provider's auth token hot, so no viewer ever pays for a login.
 *
 * Logging in is the single most expensive thing this addon does, and it used to
 * happen on the request that wanted to play something:
 *
 *   MyTF1  ~2.3s (bootstrap → login → Gigya JWT, three serial round trips)
 *   6play  ~1.9s (API-key scrape → Gigya login → 6cloud JWT)
 *   CBC    ~2.8s (ROPC settings → OAuth password grant)
 *
 * The tokens are cached with a TTL derived from their own `exp` claim, so the
 * work only needs doing once per token lifetime — the problem was purely *when*
 * it happened. This module moves it off the request path entirely: once at
 * startup, then on a timer that re-logs-in while the old token is still valid.
 *
 * The cache TTL already sheds a token `EXPIRY_BUFFER` (5 min) before it truly
 * expires, so a sweep interval below that guarantees a request never finds an
 * empty cache.
 */
import { getLogger } from './logger.js';
import { PROVIDER_CLASSES } from '../providers/registry.js';
import { ProviderFactory } from '../providers/factory.js';
import { runWithClientIp } from './clientIp.js';

const logger = getLogger('utils.authWarmer');

/** How often to re-check every provider. Must stay under authCache's
 *  EXPIRY_BUFFER (300s) so a token is replaced before requests can miss it. */
export const WARM_INTERVAL_MS = 4 * 60 * 1000;

/** Set AUTH_WARM=0 to switch pre-caching off and authenticate per request. */
export function warmingEnabled() {
  const env = process.env.AUTH_WARM;
  if (env === undefined) return true;
  return !['0', 'false', 'no', 'off'].includes(env.trim().toLowerCase());
}

let timer = null;
let inFlight = null;

/** Authenticate one provider, swallowing every failure. */
async function warmOne(key) {
  const started = Date.now();
  try {
    const provider = ProviderFactory.createProvider(key, null);
    const outcome = await provider.warmAuth();
    const ms = Date.now() - started;
    if (outcome === null) return { key, state: 'no-auth', ms };
    return { key, state: outcome ? 'ready' : 'failed', ms };
  } catch (e) {
    logger.warning('⚠️ [auth-warm] %s failed: %s', key, e.message);
    return { key, state: 'error', ms: Date.now() - started, error: e.message };
  }
}

/**
 * Authenticate every provider at once.
 *
 * Providers are independent, so this is a full fan-out rather than the serial
 * loop a per-request login implies: the whole sweep costs the slowest single
 * login, not their sum.
 */
export async function warmAllProviders() {
  // A sweep already running is joined rather than duplicated — the startup call
  // and the first timer tick must never double-login.
  if (inFlight) return inFlight;
  const keys = Object.keys(PROVIDER_CLASSES);
  // Explicitly no viewer: a warm-up must never borrow one visitor's IP and
  // mint a token the next visitor then gets 403s with. MyTF1's login forwards
  // whatever IP is in context, so this is load-bearing, not decoration.
  inFlight = runWithClientIp(null, () => Promise.all(keys.map(warmOne)))
    .finally(() => { inFlight = null; });
  const results = await inFlight;

  const summary = results
    .filter((r) => r.state !== 'no-auth')
    .map((r) => `${r.key}=${r.state} (${r.ms}ms)`)
    .join(', ');
  if (summary) logger.info('🔑 [auth-warm] %s', summary);
  return results;
}

/**
 * Warm now, then keep warming on an interval. Returns a stop function.
 *
 * Never throws and never blocks the caller: a provider that is down at boot
 * simply retries on the next sweep.
 */
export function startAuthWarmer({ intervalMs = WARM_INTERVAL_MS, immediate = true } = {}) {
  stopAuthWarmer();

  if (!warmingEnabled()) {
    logger.info('🔑 [auth-warm] disabled (AUTH_WARM=0) — providers authenticate per request');
    return stopAuthWarmer;
  }

  if (immediate) {
    warmAllProviders().catch((e) => logger.warning('⚠️ [auth-warm] startup sweep failed: %s', e.message));
  }

  timer = setInterval(() => {
    warmAllProviders().catch((e) => logger.warning('⚠️ [auth-warm] sweep failed: %s', e.message));
  }, intervalMs);
  // Don't hold the process open just for the warmer.
  timer.unref?.();

  return stopAuthWarmer;
}

export function stopAuthWarmer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
