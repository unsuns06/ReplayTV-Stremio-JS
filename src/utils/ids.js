/** Composite Stremio ID parsing.
 *
 * All IDs in this addon follow the grammar documented in
 * `src/schemas/typeDefs.js`:
 *
 *     cutam:{country}:{provider}:{rest}
 *
 * where `rest` is a show slug, a channel slug, or
 * `{slug}:episode:{broadcast_id}` / `episode:{broadcast_id}` for episodes.
 *
 * This module is the single place that splits those strings.  Routers and
 * providers should use `parseStremioId` instead of ad-hoc `id.split(':')` or
 * substring matching, which silently mis-routes malformed IDs (e.g. a provider
 * key appearing anywhere inside an unrelated ID).
 */

export const NAMESPACE = 'cutam';

/** Parsed composite ID. `rest` holds everything after the provider key. */
export class StremioId {
  constructor(country, provider, rest, raw) {
    this.country = country;
    this.provider = provider;
    this.rest = rest;
    this.raw = raw;
    Object.freeze(this);
  }

  /** Trailing slug — the last colon-separated segment of `rest`. */
  get slug() {
    return this.rest ? this.rest.split(':').pop() : '';
  }

  /** The portion of `rest` after *marker* (e.g. `"episode:"`), or null. */
  afterMarker(marker) {
    if (marker && this.rest.includes(marker)) {
      const idx = this.rest.indexOf(marker);
      return this.rest.slice(idx + marker.length);
    }
    return null;
  }
}

/** Parse *raw* into a StremioId, or `null` if malformed.
 *
 * A valid ID has at least four colon-separated parts and starts with the
 * `cutam` namespace: `cutam:{country}:{provider}:{rest...}`.
 */
export function parseStremioId(raw) {
  if (!raw) return null;
  const parts = String(raw).split(':');
  if (parts.length < 4 || parts[0] !== NAMESPACE || !parts[1] || !parts[2]) return null;
  return new StremioId(parts[1], parts[2], parts.slice(3).join(':'), raw);
}
