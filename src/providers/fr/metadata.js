/**
 * Metadata utility module for FranceTV replays.
 * Based on the reference plugin.video.catchuptvandmore implementation.
 */

/** Decode the HTML entities that appear in France TV copy.
 *
 * ponytail: the named set below plus numeric escapes — Node has no
 * `html.unescape`, and pulling in a full entity table for text that only ever
 * carries these is not worth a dependency.
 */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â',
  ccedil: 'ç', ugrave: 'ù', ucirc: 'û', uuml: 'ü', icirc: 'î', iuml: 'ï',
  ocirc: 'ô', ouml: 'ö', laquo: '«', raquo: '»', hellip: '…', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', deg: '°',
  euro: '€', copy: '©', reg: '®', trade: '™', middot: '·', times: '×',
};

export function htmlUnescape(text) {
  if (!text) return text;
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Process and enhance metadata for FranceTV replays. */
export class FranceTVMetadataProcessor {
  constructor() {
    // Image type mappings based on the reference plugin
    this.imageTypes = {
      carre: 'w:400', // Square thumbnail
      vignette_16x9: 'w:1024', // 16:9 poster
      background_16x9: 'w:2500', // 16:9 fanart
      vignette_3x4: 'w:1024', // 3:4 poster
      logo: 'w:400', // Logo
      banner: 'w:1200', // Banner
      clearart: 'w:800', // Clear art
      clearlogo: 'w:400', // Clear logo
    };
  }

  /** Populate image metadata based on the France TV API response. */
  populateImages(itemData, images) {
    if (!images || !images.length) return itemData;

    const allImages = {};

    for (const image of images) {
      if (image && image.type && image.urls) {
        const imageType = image.type;
        const sizeKey = this.imageTypes[imageType];
        if (sizeKey && image.urls[sizeKey]) {
          const relativeUrl = image.urls[sizeKey];
          allImages[imageType] = relativeUrl.startsWith('/')
            ? `https://www.france.tv${relativeUrl}`
            : relativeUrl;
        }
      }
    }

    // Poster/thumbnail (priority: vignette_3x4 > carre > vignette_16x9)
    for (const key of ['vignette_3x4', 'carre', 'vignette_16x9']) {
      if (allImages[key]) {
        itemData.poster = allImages[key];
        itemData.landscape = allImages[key];
        break;
      }
    }

    // Fanart/background (priority: background_16x9 > vignette_16x9)
    for (const key of ['background_16x9', 'vignette_16x9']) {
      if (allImages[key]) {
        itemData.fanart = allImages[key];
        itemData.background = allImages[key];
        break;
      }
    }

    for (const key of ['logo', 'banner', 'clearart', 'clearlogo']) {
      if (allImages[key]) itemData[key] = allImages[key];
    }

    return itemData;
  }

  /** Populate video metadata based on the France TV API response. */
  populateVideoMetadata(videoData, video) {
    videoData.title = video.episode_title ?? video.title ?? 'Unknown Title';

    let description = video.description || video.text || '';
    if (description) {
      description = htmlUnescape(description.replace(/<[^>]+>/g, ''));
      videoData.description = description;
    }

    if ('begin_date' in video) {
      // begin_date is a Unix timestamp rendered in server-local time, as
      // time.localtime() did on the Python side.
      const date = new Date(video.begin_date * 1000);
      if (!Number.isNaN(date.getTime())) {
        const pad = (n) => String(n).padStart(2, '0');
        const broadcastDate = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
        videoData.broadcast_date = broadcastDate;
        videoData.year = date.getFullYear();
      }
    }

    if (video.program && video.program.label) {
      videoData.program = video.program.label;
      if (video.episode_title) videoData.title = `${video.program.label} - ${video.episode_title}`;
    }

    const videoType = video.type || '';
    if (videoType === 'extrait') {
      videoData.title = `[extrait] ${videoData.title}`;
      videoData.type = 'extrait';
    } else if (videoType === 'integrale') {
      videoData.type = 'integrale';
    }

    const rating = video.rating_csa_code || '';
    if (rating && /^\d+$/.test(String(rating))) videoData.rating = `-${rating}`;

    if ('duration' in video) videoData.duration = video.duration;
    if (video.director) videoData.director = video.director;

    if (video.saison) videoData.season = video.saison;
    if (video.episode) {
      videoData.episode = video.episode;
      videoData.mediatype = 'episode';
    }

    let actors = [];
    if (video.casting) actors = String(video.casting).split(',').map((a) => a.trim());
    else if (video.presenter) actors = [video.presenter];

    if (actors.length) {
      videoData.cast = actors;
      if (video.characters) {
        const characters = String(video.characters).split(',').map((r) => r.trim());
        if (characters.length) {
          const castandrole = [];
          for (let i = 0; i < Math.max(actors.length, characters.length); i += 1) {
            castandrole.push([actors[i] || '', characters[i] || '']);
          }
          videoData.castandrole = castandrole;
        }
      }
    }

    return videoData;
  }

  /** Enhanced metadata for a show/series. */
  getShowMetadata(showId, showInfo) {
    const metadata = {
      id: showId,
      type: 'series',
      name: showInfo.name ?? 'Unknown Show',
      description: showInfo.description ?? '',
      channel: showInfo.channel ?? 'France 2',
      genres: showInfo.genres ?? ['Documentary', 'News', 'Investigation'],
      year: showInfo.year ?? 2024,
      rating: showInfo.rating ?? 'Tous publics',
    };

    if ('logo' in showInfo) {
      metadata.logo = showInfo.logo;
      metadata.poster = showInfo.logo; // use the logo as poster for now
    }

    // Copy all additional fields from showInfo to preserve them
    for (const [key, value] of Object.entries(showInfo)) {
      if (!(key in metadata) && value !== null && value !== undefined) metadata[key] = value;
    }

    return metadata;
  }

  /** Enhance metadata with additional API data. */
  enhanceMetadataWithApi(metadata, apiData) {
    if (apiData && 'images' in apiData) {
      metadata = this.populateImages(metadata, apiData.images);
    }
    if (apiData && ['integrale', 'extrait'].includes(apiData.type)) {
      metadata = this.populateVideoMetadata(metadata, apiData);
    }
    return metadata;
  }
}

export const metadataProcessor = new FranceTVMetadataProcessor();

/** Centralises FranceTV API image URL extraction. */
export class FranceTVImageExtractor {
  static BASE_URL = 'https://www.france.tv';

  // Maps pattern type substring → preferred width keys tried in order
  static TYPE_WIDTH_PREFS = {
    vignette_16x9: ['w:1024', 'w:400'],
    background_16x9: ['w:2500', 'w:1024'],
    vignette_3x4: ['w:1024', 'w:400'],
    carre: ['w:400', 'w:200'],
    logo: ['w:450', 'w:300', 'w:150'],
    banner: ['w:1200', 'w:400'],
    clearart: ['w:800', 'w:400'],
    clearlogo: ['w:400', 'w:200'],
  };

  /** Prepend the France.tv base URL to a relative path if needed. */
  resolveUrl(url) {
    if (!url) return '';
    return url.startsWith('/') ? `${FranceTVImageExtractor.BASE_URL}${url}` : url;
  }

  /** The best available URL from a single image pattern object. */
  bestUrl(pattern, typeKey) {
    const urls = pattern.urls || {};
    for (const width of FranceTVImageExtractor.TYPE_WIDTH_PREFS[typeKey] || ['w:400']) {
      if (urls[width]) return this.resolveUrl(urls[width]);
    }
    return '';
  }

  /**
   * Extract image URLs from a list of API patterns.
   *
   * @param {Array} patterns  the `media_image.patterns` list from the API
   * @param {Object} wanted   `{resultKey: typeSubstring}` — which types to look
   *                          for and what to call them in the result
   * @returns {Object} `{resultKey: absoluteUrl}` for every type found
   */
  extract(patterns, wanted) {
    const result = {};
    const wantedEntries = Object.entries(wanted);
    for (const pattern of patterns || []) {
      const ptype = pattern.type || '';
      for (const [resultKey, typeKey] of wantedEntries) {
        if (!(resultKey in result) && ptype.includes(typeKey)) {
          const url = this.bestUrl(pattern, typeKey);
          if (url) result[resultKey] = url;
        }
      }
      if (Object.keys(result).length === wantedEntries.length) break;
    }
    return result;
  }
}

export const imageExtractor = new FranceTVImageExtractor();
