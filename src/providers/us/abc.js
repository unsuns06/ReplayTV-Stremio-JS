import { getLogger } from '../../utils/logger.js';
import { BaseProvider, safeProviderCall } from '../baseProvider.js';
import { cache } from '../../utils/cache.js';
import { CacheKeys, CacheTTL } from '../../utils/cacheKeys.js';
import { getProgramsForProvider } from '../../utils/programsLoader.js';

// Widevine and DRM imports
import { Device } from '../../widevine/device.js'; // Adjust path based on your folder structure
import { Cdm } from '../../widevine/cdm.js';
import { PSSH } from '../../widevine/pssh.js';
import { withDrmProcessedFiles } from '../drmMixin.js';
import { buildCencPlaylistUrl } from '../../routers/hlsCenc.js';
import { getBaseUrl } from '../../utils/baseUrl.js';

const logger = getLogger('providers.abc');

// ABC's own web app constants, read out of its JS bundle (BRANDS_CLIENT_IDS /
// BRANDS_API_KEYS_PROD, brand "001"). Static and public — no account, no login.
const BRAND = '001';
const BAM_CLIENT_ID = 'abc-a9045cb5';
const BAM_API_KEY = 'YWJjJmJyb3dzZXImMS4wLjA.B1avqvrcbTb6GRneixWJGLgLCyVkVzOulkgaeD75Bys';

const CONTENTS_API = 'https://api.contents.watchabc.go.com/vp2/ws/contents/3000';
const GATEKEEPER_API = 'https://prod.gatekeeper.us-abc.symphony.edgedatg.com/api/ws';
const BAM_API = 'https://disney-entertainment.api.edge.bamgrid.com';
const BAM_PLAYBACK = 'https://disney-entertainment.playback.edge.bamgrid.com';

// ABC's JSON APIs publish only a 16x9 crop per show. The title-treatment logo,
// the 3:4 poster and the wide background exist solely in the show page's
// server-rendered payload, as a typed image array.
const SHOW_PAGE = 'https://abc.com/shows';
const HEADER_LOGO_RE = /class="Header__Logo__img"[^>]*?src="([^"]+)"/;
const TYPED_IMAGE_RE = /"value":"(https:\/\/cdn1\.edgedatg\.com\/[^"]+)","type":"([^"]+)","width":(\d+),"height":(\d+)/g;
// Backgrounds are published up to 4300x2430; nothing in Stremio wants that.
const MAX_ART_WIDTH = 2560;
// The page only ever lists the poster at 196x261, too small for a Stremio
// grid — but the CDN renders the same asset at 454x606 (checked across eight
// shows), so the size token is rewritten rather than probed for.
const POSTER_SIZE_RE = /\/\d+x\d+-Q(\d+)_/;

// Disney publishes one EXT-X-KEY per DRM system — Widevine, PlayReady and
// PRMNAGRA all carry a `data:` URI, and only the Widevine one holds a PSSH the
// CDM can read, so it is matched by its own KEYFORMAT rather than by position.
const WIDEVINE_KEY_RE = /KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"[^\r\n]*URI="data:text\/plain;base64,([^"]+)"/;

const TOKEN_CACHE_KEY = CacheKeys.providerResource('abc', 'bam_token');
// The grant says 14400s; refresh early so a token never expires mid-request.
const TOKEN_TTL = 13800;

/** Headers every BAM service insists on; omitting any one is a 400. */
const BAM_HEADERS = {
  'x-bamsdk-client-id': BAM_CLIENT_ID,
  'x-bamsdk-platform': 'browser',
  'x-bamsdk-version': '35.2',
  'x-application-version': '1.0.0',
};

export class ABCProvider extends withDrmProcessedFiles(BaseProvider) {
  static providerName = 'abc';
  static baseUrl = 'https://abc.com';
  static country = 'us';

  // Metadata
  static displayName = 'ABC';
  static idPrefix = 'cutam:us:abc';
  static episodeMarker = 'episode:';
  static catalogId = 'us-abc-replay';
  static supportsLive = false;
  static defaultChannel = 'abc';
  static defaultRating = 'TV-PG';
  static defaultLocale = 'en-US,en;q=0.9';
  // Nothing here routes through the geo proxy: every ABC endpoint — catalogue,
  // layout, BAM token, playback, and the CDN itself — answered a Canadian IP.
  // The key is set anyway so the inherited `fr_default` cannot be picked up by
  // mistake if some call ever does need `_fetchWithProxyFallback`.
  static geoProxyKey = 'us_default';

  /** ABC only publishes 16x9 art at show level, largest last in the array. */
  static SHOW_IMAGE_TYPES = ['casting-image', 'main', 'casting-thumb'];

  get needsIpForwarding() {
    return true;
  }

  constructor(req = null) {
    super(req);
    this.shows = getProgramsForProvider('abc');
  }

  /** Extract DRM keys using the local Widevine CDM and BAM token. */
  async _extractDrmKeys(psshB64, licenseUrl, licenseHeaders) {
    try {
      logger.debug('✅ [ABC] Extracting DRM keys for ABC replay...');
      
      // Note: Adjust the device path to match where your .wvd file is located
      const device = Device.load('./src/providers/us/device.wvd');
      const cdm = Cdm.fromDevice(device);
      const sid = cdm.open();
      const challenge = cdm.getLicenseChallenge(sid, new PSSH(psshB64));

      // `apiClient.post` JSON-encodes its body and JSON-parses the reply —
      // both fatal here: the challenge would go out as `{"type":"Buffer",…}`
      // (BAM: 400 bad-license-request) and the binary license would come back
      // null. `rawRequest` passes bytes through in both directions.
      const r = await this.apiClient.rawRequest('POST', licenseUrl, {
        headers: {
          'Content-Type': 'application/octet-stream',
          Accept: 'application/octet-stream, */*',
          ...licenseHeaders
        },
        body: challenge,
      });

      if (!r || r.status !== 200) {
        const detail = r ? `HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}` : 'no response';
        logger.error('⚠️ [ABC] License request refused (%s)', detail);
        cdm.close(sid);
        return { keys: {} };
      }

      cdm.parseLicense(sid, Buffer.from(await r.arrayBuffer()));
      
      const keys = {};
      for (const k of cdm.getKeys(sid, 'CONTENT')) {
        const kid = k.kid.replace(/-/g, '');
        const key = k.key.toString('hex');
        keys[kid] = key;
        logger.debug('   KID: %s -> KEY: %s', kid, key);
      }
      
      cdm.close(sid);
      return { keys };
    } catch (drmError) {
      logger.error('⚠️ [ABC] DRM key extraction failed: %s', drmError.message);
      return { keys: {} };
    }
  }

  async _selectDrmKey(drmKeys) {
    const kids = Object.keys(drmKeys || {});
    if (!kids.length) return null;
    return { key_id: kids[0], key: drmKeys[kids[0]] };
  }

  async _buildDirectStream(videoUrl, licenseUrl, licenseHeaders, headers, drmKeys, manifestType = 'hls') {
    const keyParams = await this._selectDrmKey(drmKeys);

    // ABC is CMAF-CENC packaged as HLS, which MediaFlow's HLS proxy cannot
    // decrypt: it accepts no key_id/key and turns the `data:` EXT-X-KEY URIs
    // into segment fetches that 502. `/hls-cenc` rewrites the playlist onto
    // MediaFlow's MPD segment endpoint, which does decrypt CENC.
    let proxied;
    if (keyParams && this.mediaflowUrl && this.mediaflowPassword) {
      logger.debug('✅ [ABC] Direct stream decrypted by MediaFlow (KID %s)', keyParams.key_id);
      licenseUrl = null;
      licenseHeaders = null;
      proxied = buildCencPlaylistUrl(getBaseUrl(this.req), videoUrl, keyParams);
    } else {
      proxied = this._buildMediaflowProxiedUrl(videoUrl, manifestType, {
        licenseUrl,
        licenseHeaders,
      });
    }

    const stream = {
      url: proxied || videoUrl,
      manifest_type: manifestType,
      title: `🌐 [${manifestType.toUpperCase()}] Direct source (MediaFlow)`,
      headers,
    };
    
    if (licenseUrl) {
      stream.licenseUrl = licenseUrl;
      if (licenseHeaders && Object.keys(licenseHeaders).length) stream.licenseHeaders = licenseHeaders;
    }
    return stream;
  }

  /** Basic extractor for PSSH from HLS manifests */
  async _extractPsshFromHls(videoUrl) {
    try {
      const resp = await this.apiClient.rawRequest('GET', videoUrl);
      const text = await resp.text();
      
      const match = text.match(WIDEVINE_KEY_RE);
      if (match) return match[1];

      // If it's a master playlist, fetch the highest bandwidth variant
      const variantMatch = text.match(/^(https?:\/\/[^\s]+)/m) || text.match(/^([^\s]+\.m3u8)/m);
      if (variantMatch) {
          const variantUrl = new URL(variantMatch[1], videoUrl).toString();
          const vResp = await this.apiClient.rawRequest('GET', variantUrl);
          const vText = await vResp.text();
          const psshMatch = vText.match(WIDEVINE_KEY_RE);
          if (psshMatch) return psshMatch[1];
      }
    } catch (e) {
      logger.error('⚠️ [ABC] Failed to extract PSSH from HLS: %s', e.message);
    }
    return null;
  }

  /** The full ABC show catalogue (396 shows), cached for the programs TTL.
   *
   * One request answers every slug lookup, so programs.json can name shows the
   * way abc.com's own URLs do (`shark-tank`) instead of forcing users to dig
   * out an internal `SH…` id.
   */
  async _showIndex() {
    return this._cachedPayload('shows', () => this.apiClient.get(
      `${CONTENTS_API}/shows/${BRAND}/001/-1/-1.json`,
      { headers: this._buildIpHeaders() },
    ));
  }

  /** The show record whose `urltitle` (or id) matches *slug*, or null. */
  async _findShow(slug) {
    const data = await this._showIndex();
    const shows = (data || {}).show || [];
    return shows.find((s) => s.urltitle === slug || s.id === slug) || null;
  }

  /** Largest published thumbnail, preferring the widest crop ABC offers. */
  static _thumbnail(record) {
    const thumbs = ((record || {}).thumbnails || {}).thumbnail || [];
    for (const type of ABCProvider.SHOW_IMAGE_TYPES) {
      const match = thumbs.filter((t) => t.type === type)
        .sort((a, b) => Number(b.width) - Number(a.width))[0];
      if (match && match.value) return match.value;
    }
    // No typed match: fall back to the widest of whatever is there.
    const widest = [...thumbs].sort((a, b) => Number(b.width) - Number(a.width))[0];
    return (widest || {}).value || null;
  }

  /** Largest rendition that is not absurdly large, or null. */
  static _pickSize(images) {
    if (!images || !images.length) return null;
    const bySize = [...images].sort((a, b) => b.width - a.width);
    return (bySize.find((i) => i.width <= MAX_ART_WIDTH) || bySize[bySize.length - 1]).url;
  }

  /** Logo, poster and background from the show page, or null.
   *
   * Everything is scoped to the show's own CDN folder. The page renders rails
   * of *other* shows and their art sits in the very same image array, so an
   * unscoped "largest showLogoCentered" picks up whatever was recommended
   * alongside — the header logo is the one image guaranteed to be this show's,
   * which makes it both the logo and the scope for the rest.
   */
  async _showArtwork(urlTitle) {
    return this._cachedPayload(`artwork:${urlTitle}`, async () => {
      const resp = await this.apiClient.rawRequest('GET', `${SHOW_PAGE}/${urlTitle}`);
      if (!resp || resp.status !== 200) {
        logger.debug('⚠️ [ABC] No show page for %s', urlTitle);
        return null;
      }
      const html = await resp.text();

      const header = html.match(HEADER_LOGO_RE);
      if (!header) {
        logger.debug('⚠️ [ABC] No header logo on the %s page', urlTitle);
        return null;
      }
      const folder = `${header[1].split('/showimages/')[0]}/`;

      const byType = {};
      for (const [, url, type, width, height] of html.matchAll(TYPED_IMAGE_RE)) {
        if (!url.startsWith(folder)) continue;
        (byType[type] ||= []).push({ url, width: Number(width), height: Number(height) });
      }

      const poster = ABCProvider._pickSize(byType.auth);
      return {
        logo: header[1],
        poster: poster ? poster.replace(POSTER_SIZE_RE, '/454x606-Q$1_') : null,
        // `showdetails` is the key art. NOT `show-background`, which sounds
        // right and is the bigger image but is ABC's page backdrop — a nearly
        // black decorative wash meant to sit behind their site chrome, so it
        // reads as "no background at all" in a Stremio detail page.
        background: ABCProvider._pickSize(byType.showdetails),
      };
    });
  }

  async _getShowApiMetadata(showId, showInfo) {
    return safeProviderCall(this, '_getShowApiMetadata', {}, async () => {
      const show = await this._findShow(showId);
      if (!show) return {};
      // The 16x9 crop from the catalogue API, used wherever the page had nothing.
      const art = ABCProvider._thumbnail(show);
      const page = (await this._showArtwork(show.urltitle || showId)) || {};
      const airYear = String(show.latestepisodeairdate || '').match(/\b(\d{4})\b/);
      return this._pickFields({
        // `description` is the one-liner; longdescription is the fuller pitch.
        description: [show.longdescription, show.description, show.abouttheshowsummaryplaintext],
        channel: [show.title ? this.displayName : null],
        genres: [[show.genre].filter(Boolean)],
        year: [airYear ? parseInt(airYear[1], 10) : null],
        // ABC rates episodes, not shows — leave it to defaultRating.
        logo: [page.logo, art],
        poster: [page.poster, art],
        background: [page.background, art],
        fanart: [page.background, art],
      }, showInfo);
    });
  }

  /** Every free episode ABC currently publishes for *slug*.
   *
   * ABC keeps a rolling free window (about five episodes); the API returns
   * exactly that set, so there is no season walking to do.
   */
  async _fetchEpisodesRaw(slug) {
    const show = await this._findShow(slug);
    if (!show) {
      logger.warning('⚠️ [ABC] Unknown show slug: %s', slug);
      return null;
    }
    const data = await this.apiClient.get(
      `${CONTENTS_API}/videos/${BRAND}/001/-1/${show.id}/-1/-1/-1/-1.json`,
      { headers: this._buildIpHeaders() },
    );
    const videos = (data || {}).video || [];
    // `lf` is a long-form full episode; the same feed also carries clips.
    const episodes = videos.filter((v) => v.type === 'lf');
    if (!episodes.length) logger.warning('⚠️ [ABC] No free episodes for %s', slug);
    return episodes.length ? episodes : null;
  }

  async _parseEpisode(video, index) {
    return safeProviderCall(this, '_parseEpisode', null, async () => {
      const videoId = video.id;
      if (!videoId) return null;

      const season = parseInt((video.season || {}).num, 10) || 1;
      const episode = parseInt(video.episodenumber, 10) || index;
      const thumbnail = ABCProvider._thumbnail(video);

      // ABC reports duration in milliseconds; the addon speaks seconds.
      const durationMs = parseInt(((video.duration || {}).value) || '0', 10);

      const airDate = ((video.airdates || {}).airdate || [])[0];
      const airedRaw = (typeof airDate === 'object' ? airDate.value : airDate) || '';
      const aired = airedRaw ? new Date(airedRaw) : null;
      const released = aired && !Number.isNaN(aired.valueOf()) ? aired.toISOString() : '';

      return {
        // The VDKA id is what every downstream ABC endpoint keys on, so it is
        // the id itself — no episode-list round trip to resolve a stream.
        id: `${this.idPrefix}:episode:${videoId}`,
        title: video.title || `Season ${season}, Episode ${episode}`,
        description: video.longdescription || video.description || '',
        season,
        episode,
        episode_number: episode,
        duration: String(Math.round(durationMs / 1000)),
        broadcast_date: released ? released.slice(0, 10) : '',
        released,
        rating: (video.tvrating || {}).rating || this.defaultRating,
        channel: this.displayName,
        type: 'episode',
        poster: thumbnail,
        thumbnail,
      };
    });
  }

  /** Episodes for an ABC series, keeping ABC's own numbering.
   *
   * The base template renumbers episodes 1..n by air date, which is right for
   * a provider that publishes none. ABC publishes real numbers, and its free
   * window is a rolling subset with holes in it (S17 currently offers 5, 6, 8,
   * 9, 10) — renumbering those would label episode 8 as episode 3.
   */
  async getEpisodes(showId) {
    const slug = this._extractSlug(showId);
    if (!(slug in this.shows)) return [];
    const raw = await this._fetchEpisodesRaw(slug);
    if (!raw || !raw.length) return [];
    const parsed = await Promise.all(raw.map((item, i) => this._parseEpisode(item, i + 1)));
    return parsed.filter(Boolean)
      .sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
  }

  /** An anonymous BAM access token, shared across viewers and cached.
   *
   * Two round trips: register a throwaway device, then exchange the grant.
   * Both are unauthenticated — ABC asks for no account for its free window.
   */
  async _accessToken() {
    const cached = cache.get(TOKEN_CACHE_KEY);
    if (cached) return cached;

    const grantBody = {
      query: 'mutation registerDevice($registerDevice: RegisterDeviceInput!) { registerDevice(registerDevice: $registerDevice) { grant { grantType assertion } } }',
      variables: {
        registerDevice: {
          applicationRuntime: 'chrome',
          attributes: {
            osDeviceIds: [],
            manufacturer: 'microsoft',
            model: null,
            operatingSystem: 'windows',
            operatingSystemVersion: '10.0',
            browserName: 'chrome',
            browserVersion: '120.0.0',
          },
          deviceFamily: 'browser',
          deviceLanguage: 'en',
          deviceProfile: 'windows',
        },
      },
    };

    const grant = await this.apiClient.post(`${BAM_API}/graph/v1/device/graphql`, {
      jsonData: grantBody,
      headers: this._mergeIpHeaders({
        authorization: `Bearer ${BAM_API_KEY}`,
        accept: 'application/json',
        ...BAM_HEADERS,
      }),
    });

    const assertion = grant?.data?.registerDevice?.grant?.assertion;
    if (!assertion) {
      logger.error('❌ [ABC] Device registration returned no grant');
      return null;
    }

    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      latitude: '0',
      longitude: '0',
      platform: 'browser',
      subject_token: assertion,
      subject_token_type: 'urn:bamtech:params:oauth:token-type:device',
    }).toString();

    const token = await this.apiClient.post(`${BAM_API}/token`, {
      data: form,
      headers: this._mergeIpHeaders({
        authorization: `Bearer ${BAM_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        ...BAM_HEADERS,
      }),
    });

    const accessToken = (token || {}).access_token;
    if (!accessToken) {
      logger.error('❌ [ABC] Token exchange returned no access_token');
      return null;
    }
    cache.set(TOKEN_CACHE_KEY, accessToken, TOKEN_TTL);
    logger.info('✅ [ABC] Anonymous BAM token acquired');
    return accessToken;
  }

  /** Mint the token off the request path, like CBC's login warm-up. */
  async warmAuth() {
    return Boolean(await this._accessToken());
  }

  /** Disney's playback id for a VDKA video.
   *
   * ABC's layout service hands out a `dmpPlaybackToken`; the playback API wants
   * that token verbatim, not the media id inside it — decoding it and sending
   * the UUID is rejected as an invalid playback id.
   */
  async _playbackToken(videoId) {
    return this._cachedPayload(`playback_token:${videoId}`, async () => {
      const layout = await this.apiClient.get(`${GATEKEEPER_API}/pluto/v1/layout`, {
        params: {
          type: 'video', brand: BRAND, device: '001', authlevel: 0, video: videoId,
        },
        headers: this._buildIpHeaders({ accept: 'application/json', appversion: '9.25.0' }),
      });
      const token = ((layout || {}).video || {}).dmpPlaybackToken;
      if (!token) logger.error('❌ [ABC] No dmpPlaybackToken for %s', videoId);
      return token || null;
    });
  }

  async getEpisodeStreamUrl(episodeId) {
    return safeProviderCall(this, 'getEpisodeStreamUrl', null, async () => {
      const videoId = this._extractAfterMarker(episodeId);
      if (!videoId) return null;

      const cacheKey = CacheKeys.stream(episodeId);
      const cached = cache.get(cacheKey);
      if (cached) {
        logger.info('✅ [ABC] Using cached stream for %s', videoId);
        return cached;
      }

      // 1. Check for existing processed files (TorBox/Debrid cache)
      const existingResult = await this._checkProcessedFile(videoId);
      const existing = existingResult || [];

      // 2. Fetch BAM Auth and Playback tokens
      const [playbackToken, accessToken] = await Promise.all([
        this._playbackToken(videoId),
        this._accessToken(),
      ]);
      if (!playbackToken || !accessToken) return existing.length ? existing : null;

      const playback = await this.apiClient.post(`${BAM_PLAYBACK}/v7/playback/tve/ctr-regular`, {
        jsonData: {
          playback: {
            attributes: {
              resolution: { max: ['1920x1080'] },
              protocol: 'HTTPS',
              assetInsertionStrategy: 'SGAI',
              playbackInitiationContext: 'ONLINE',
              frameRates: [60],
              slugDuration: 'SLUG_500_MS',
            },
          },
          playbackId: playbackToken,
        },
        headers: this._mergeIpHeaders({
          authorization: `Bearer ${accessToken}`,
          accept: 'application/vnd.media-service+json; version=7',
          'x-dss-feature-filtering': 'true',
          ...BAM_HEADERS,
        }),
      });

      const sources = ((playback || {}).stream || {}).sources || [];
      // Sources come priority-ordered; the first complete URL is the one the web player picks.
      const videoUrl = sources.map((s) => (s.complete || {}).url).find(Boolean);
      if (!videoUrl) {
        logger.error('❌ [ABC] Playback response carried no source URL');
        return existing.length ? existing : null;
      }

      const licenseUrl = `${BAM_PLAYBACK}/widevine/v1/obtain-license`;
      // The BAM token alone is not entitlement: this playback's rights JWT is
      // what the license endpoint checks, and without it every request — ours
      // or the player's — is refused with 403 not-entitled.
      const rights = ((playback.stream || {}).playbackRights || {}).playbackRightsContext;
      const licenseHeaders = {
        Authorization: `Bearer ${accessToken}`,
        ...BAM_HEADERS,
        ...(rights ? { 'x-playback-rights-authorization': rights } : {}),
      };
      if (!rights) logger.warning('⚠️ [ABC] Playback carried no rights context; the license will 403');
      const headers = this._buildStreamHeaders();

      // 3. Attempt PSSH Extraction and DRM local decryption
      const psshB64 = await this._extractPsshFromHls(videoUrl); 
      
      if (psshB64) {
        const { keys: drmKeys } = await this._extractDrmKeys(psshB64, licenseUrl, licenseHeaders);
        const streams = [await this._buildDirectStream(videoUrl, licenseUrl, licenseHeaders, headers, drmKeys, 'hls')];

        // 4. Background DRM processing
        if (Object.keys(drmKeys).length && !existing.length) {
          try {
            const placeholder = await this._startDrmProcessing(videoUrl, videoId, {
              keys: Object.entries(drmKeys).map(([kid, key]) => `${kid}:${key}`),
            });
            if (placeholder) streams.push(placeholder);
          } catch (e) {
            logger.error('⚠️ [ABC] Background processing failed: %s', e.message);
          }
        }
        
        const finalStreams = [...existing, ...streams];
        cache.set(cacheKey, finalStreams, CacheTTL.STREAM);
        return finalStreams;
      }

      // 5. Fallback stream if PSSH extraction fails
      const proxied = this._buildMediaflowProxiedUrl(videoUrl, 'hls', { licenseUrl, licenseHeaders });
      const fallbackStreams = [...existing, {
        url: proxied || videoUrl,
        manifest_type: 'hls',
        headers,
        licenseUrl,
        licenseHeaders,
        title: 'ABC Stream',
      }];

      cache.set(cacheKey, fallbackStreams, CacheTTL.STREAM);
      logger.info('✅ [ABC] Got stream for %s', videoId);
      return fallbackStreams;
    });
  }
}
