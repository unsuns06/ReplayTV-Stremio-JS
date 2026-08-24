/**
 * Shape documentation for provider return values.
 *
 * Composite ID format
 * -------------------
 * All Stremio IDs in this addon follow this colon-separated convention:
 *
 *   cutam:{country}:{provider}:{slug}[:{episode_marker}{broadcast_id}]
 *
 * Examples:
 *   cutam:fr:francetv:cash-investigation          — series (show slug)
 *   cutam:fr:francetv:episode:006194ea-117d-...   — episode (episodeMarker="episode:")
 *   cutam:fr:mytf1:episode:V_123456789            — MyTF1 episode
 *   cutam:ca:cbc:dragons-den                      — CBC series
 *   cutam:ca:cbc:dragons-den:episode:S:E          — CBC episode
 *   cutam:fr:francetv:france-2                    — live channel
 *
 * Fields:
 *   cutam     — static namespace prefix
 *   country   — ISO 3166-1 alpha-2 code (fr, ca)
 *   provider  — lowercase provider key (francetv, mytf1, 6play, cbc)
 *   slug      — show slug or channel slug (from programs.json or provider API)
 *   episode_marker — provider-specific separator before the broadcast ID;
 *                    defined as BaseProvider.episodeMarker
 *   broadcast_id   — opaque ID used by the upstream provider API
 *
 * @typedef {Object} StreamInfo   returned by getEpisodeStreamUrl()
 * @property {string} url
 * @property {string} [manifest_type]  'hls', 'mpd' or 'video' (pre-processed file)
 * @property {string} [title]
 * @property {string} [description]
 * @property {Object} [headers]
 * @property {string} [filename]       pre-processed file name (DRM providers)
 * @property {string} [externalUrl]
 * @property {boolean} [drm_protected]
 * @property {string} [drm_token]
 * @property {Object} [drm_keys]       kid -> key (MyTF1)
 * @property {string} [licenseUrl]
 * @property {Object} [licenseHeaders]
 * @property {string} [decryption_key]
 * @property {string} [default_kid]
 * @property {string} [pssh]
 * @property {string} [pssh_system_id]
 * @property {string} [pssh_source]
 * @property {boolean} [proxied]
 * @property {string} [quality]
 *
 * @typedef {Object} EpisodeInfo  returned by getEpisodes()
 * @property {string} id
 * @property {string} type            always "episode"
 * @property {string} title
 * @property {number} [season]
 * @property {number} [episode]
 * @property {number} [episode_number] provisional number before chronological sort
 * @property {string} [description]
 * @property {string} [poster]
 * @property {string} [fanart]
 * @property {string} [thumbnail]
 * @property {string} [duration]      in seconds as a string
 * @property {string} [broadcast_date]
 * @property {string} [broadcast_id]  FranceTV upstream media ID
 * @property {string} [air_date]
 * @property {string} [released]      ISO 8601 — consumed by Stremio
 * @property {string} [rating]
 * @property {string} [channel]
 * @property {string} [program]
 * @property {string[]} [genres]
 * @property {string[]} [cast]
 * @property {string} [note]          fallback-episode marker
 * @property {string} [gem_url]       CBC web URL
 * @property {string} [cbc_media_id]  CBC stream-resolution ID
 *
 * @typedef {Object} ShowInfo     returned by getPrograms()
 * @typedef {Object} LiveChannelInfo returned by getLiveChannels()
 */
export {};
