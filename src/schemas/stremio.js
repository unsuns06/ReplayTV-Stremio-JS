/** Stremio response shapes.
 *
 * The Python addon declares these as pydantic models, which drop unknown keys
 * and render unset optional fields as `null`.  These builders do the same by
 * projecting onto a fixed field list, so the JSON on the wire is identical.
 */

function project(fields, source, coercions = {}) {
  const out = {};
  for (const field of fields) {
    let value = source?.[field];
    if (value === undefined) value = null;
    if (value !== null && coercions[field]) value = coercions[field](value);
    out[field] = value;
  }
  return out;
}

const toInt = (v) => {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isNaN(n) ? null : n;
};
const toStr = (v) => String(v);

const META_PREVIEW_FIELDS = [
  'id', 'type', 'name', 'poster', 'logo', 'description', 'genres', 'background',
  // Enhanced metadata fields for FranceTV
  'fanart', 'banner', 'clearart', 'clearlogo', 'landscape',
  // Additional metadata
  'year', 'rating', 'runtime',
];

const META_DETAIL_FIELDS = [
  'id', 'type', 'name', 'poster', 'logo', 'description', 'genres', 'background', 'videos',
  'fanart', 'banner', 'clearart', 'clearlogo', 'landscape',
  'year', 'rating', 'runtime',
  // Series specific fields
  'season', 'episode', 'director', 'cast', 'castandrole',
  // FranceTV specific fields
  'channel', 'broadcast_date', 'duration',
];

const STREAM_FIELDS = [
  'url', 'title',
  // Stremio-spec hints (stock clients read headers from
  // behaviorHints.proxyHeaders; the flat fields below are kept for custom
  // players that consume them directly).
  'behaviorHints', 'headers', 'externalUrl', 'manifest_type', 'licenseUrl', 'licenseHeaders',
];

const NUMERIC = { year: toInt, runtime: toInt, season: toInt, episode: toInt, rating: toStr };

export const metaPreview = (data) => project(META_PREVIEW_FIELDS, data, NUMERIC);
export const metaDetail = (data) => project(META_DETAIL_FIELDS, data, NUMERIC);
export const stream = (data) => project(STREAM_FIELDS, data);

export const catalogResponse = (metas) => ({ metas: (metas || []).map(metaPreview) });
/** `null` meta means "not found" — Stremio treats it as an empty result. */
export const metaResponse = (meta = null) => ({ meta: meta ? metaDetail(meta) : null });
export const streamResponse = (streams) => ({ streams: (streams || []).map(stream) });
