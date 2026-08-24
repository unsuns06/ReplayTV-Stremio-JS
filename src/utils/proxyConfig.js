/** Geo-proxy configuration.
 *
 * Proxies live under the `proxies` key of the credentials document — loaded
 * through `loadCredentials()`, so both the `credentials.json` file *and* the
 * `CREDENTIALS_JSON` environment variable work.
 *
 * Each proxy is keyed by a short name (e.g. `fr_default`, `nm3u8_processor`)
 * and can be overridden per-proxy with a `PROXY_<NAME_UPPER>` environment
 * variable, making it easy to adjust containerised deployments without
 * changing the credentials document.
 */
import { getLogger } from './logger.js';
import { loadCredentials } from './credentials.js';

const logger = getLogger('utils.proxyConfig');

/** Read-through view over the `proxies` section of the credentials doc. */
export class ProxyConfig {
  /** The `proxies` object from the credentials document.
   *
   * `loadCredentials` caches the parsed document for the process lifetime, so
   * this getter is cheap to call repeatedly.
   */
  get proxies() {
    const proxies = loadCredentials().proxies ?? {};
    if (typeof proxies !== 'object' || Array.isArray(proxies) || proxies === null) {
      logger.error("proxy_config: 'proxies' section is not an object");
      return {};
    }
    return proxies;
  }

  /** Return a proxy URL by name, or `null` if not configured.
   *
   * Checks the `PROXY_<NAME_UPPER>` environment variable first, then falls
   * back to the value from the credentials document.
   */
  getProxy(name) {
    const envValue = process.env[`PROXY_${name.toUpperCase()}`];
    if (envValue) return envValue;
    return this.proxies[name] ?? null;
  }
}

// Module-level instance — same pattern as utils/cache.js
const proxyConfig = new ProxyConfig();

export function getProxyConfig() {
  return proxyConfig;
}
