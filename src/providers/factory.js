import { getProviderClass } from './registry.js';

/** Factory that creates provider instances using the dynamic registry. */
export class ProviderFactory {
  /**
   * Return a provider instance, reusing one cached on the request within a
   * single request cycle.
   *
   * Per-request caching avoids rebuilding a provider (and re-reading its
   * programs.json slice) several times for the same provider in one request.
   */
  static createProvider(providerName, req = null) {
    if (req) {
      req._providers ||= {};
      const cached = req._providers[providerName];
      if (cached) return cached;
    }

    const ProviderCls = getProviderClass(providerName);
    if (!ProviderCls) throw new Error(`Unknown provider: ${providerName}`);

    const provider = new ProviderCls(req);

    if (req) req._providers[providerName] = provider;

    return provider;
  }
}
