/** Canonical builder for Stremio series objects derived from programs.json data.
 *
 * One implementation shared by `BaseProvider._buildShowMetadata`, the catalog
 * router's programs.json fallback, the meta router and CBC's catalogue.
 */

export const DEFAULT_YEAR = 2024;
export const DEFAULT_RATING = 'Tous publics';

/** Everything a provider's `_getShowApiMetadata` may contribute to a show.
 *
 * programs.json only pins `provider`/`slug`/`name`; these fields come from the
 * provider's own metadata endpoint. Anything else in an API-metadata object
 * (FranceTV's raw `images` patterns, say) is provider-internal and never
 * merged into the Stremio meta.
 */
export const API_FIELDS = [
  'description', 'channel', 'genres', 'year', 'rating',
  'logo', 'poster', 'background', 'fanart',
];

/**
 * Build a Stremio-compatible series object from a programs.json entry.
 *
 * @param {string} idPrefix      provider ID prefix, e.g. "cutam:fr:francetv"
 * @param {string} slug          show slug (becomes the last ID segment)
 * @param {Object} info          the show's entry from programs.json
 * @param {string} fallbackLogo  used for logo/poster when the entry has none
 * @param {string} defaultRating rating used when the entry has none
 */
export function buildShowDict(idPrefix, slug, info, fallbackLogo = null, defaultRating = DEFAULT_RATING) {
  return {
    id: `${idPrefix}:${slug}`,
    type: 'series',
    name: info.name ?? slug,
    description: info.description ?? '',
    channel: info.channel ?? '',
    genres: info.genres ?? [],
    year: info.year ?? DEFAULT_YEAR,
    rating: info.rating ?? defaultRating,
    logo: info.logo || fallbackLogo,
    poster: info.poster || fallbackLogo,
    background: info.background ?? '',
  };
}
