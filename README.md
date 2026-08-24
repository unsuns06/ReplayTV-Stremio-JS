# ReplayTV-Stremio (JS) — Catch-up TV & More for Stremio

A Node/Express [Stremio](https://www.stremio.com/) addon serving French and
Canadian live TV and replay (catch-up) content. A port of the Python/FastAPI
addon: same endpoints, same composite IDs, same `programs.json` and
`credentials.json` formats, verified to answer identically.

| Provider | Country | Live TV | Replays | Account needed |
|---|---|---|---|---|
| **France TV** (france.tv) | 🇫🇷 | ✅ France 2/3/4/5, franceinfo: | ✅ | No |
| **TF1+** (tf1.fr) | 🇫🇷 | ✅ TF1, TMC, TFX, TF1 Séries Films | ✅ | Free TF1+ account |
| **6play** (6play.fr) | 🇫🇷 | ✅ M6, W9, 6ter, Gulli | ✅ | Free 6play account |
| **CBC Gem** (gem.cbc.ca) | 🇨🇦 | — | ✅ | Free CBC account |

The show list served by the catalogs lives in [`programs.json`](programs.json).

## Quick start

Double-click the batch files, or run the commands:

| File | What it does |
|---|---|
| `install.bat` | `npm install` — run once after cloning |
| `start-server.bat` | Starts the addon on http://localhost:7860 |
| `edit-programs.bat` | Starts the addon **and** opens the shows editor |
| `force_push.bat` | Commits everything and force-pushes to GitHub |

```bash
npm install
npm start                     # serves http://127.0.0.1:7860
npm run dev                   # the same, restarting on file changes
```

Then add `http://127.0.0.1:7860/manifest.json` as an addon in Stremio.

Requires **Node.js 18 or newer** (it uses the built-in `fetch`). The only
dependency is Express.

Useful endpoints:

| Endpoint | Purpose |
|---|---|
| `/` | Shows editor — add or remove entries in `programs.json` (local only) |
| `/manifest.json` | Stremio addon manifest (generated from the provider registry) |
| `/catalog/{type}/{id}.json` | Live channel list and per-provider replay catalogues |
| `/meta/{type}/{id}.json` | Channel or series detail, including the episode list |
| `/stream/{type}/{id}.json` | Resolved stream URLs |
| `/configure` | Provider credential status page |
| `/configure/status` | Same, as JSON |
| `/health` | Health check: provider config status + cache stats |

## Editing the show list

`/` serves an editor for [`programs.json`](programs.json): pick a provider, pick
a show from its live catalogue, and the slug fills itself in. Saving rewrites the
file; the catalogue caches expire within ten minutes, or restart the server to
see the change at once.

**It answers to the local machine only.** The routes write to disk, so from any
other address `/` returns the plain API greeting and the editor's own endpoints
return 403. On a deployment every request arrives through a proxy and therefore
looks remote — set `enable_remote_editor=1` to serve it anyway, but only where
reaching the addon already requires authentication (a private Hugging Face
Space, a VPN, an authenticating reverse proxy). Turned on with the URL public,
anyone who finds it can rewrite your catalogue.

Hosts with an ephemeral filesystem (Hugging Face Spaces among them) lose the
edit on the next restart or rebuild unless persistent storage is attached.
Editing locally and committing the file is the durable route.

## Configuration

### Credentials

Credentials are read from **one** of (first match wins):

1. The `CREDENTIALS_JSON` environment variable (full JSON document — recommended for deployments)
2. `credentials.json` in this folder
3. `credentials-test.json` in this folder (fallback)

```json
{
  "mytf1":  {"login": "user@example.com", "password": "secret"},
  "6play":  {"login": "user@example.com", "password": "secret"},
  "cbcgem": {"login": "user@example.com", "password": "secret"},
  "mediaflow": {"url": "https://my-mediaflow", "password": "secret"},
  "proxies": {
    "fr_default": "https://my-fr-proxy/?url=",
    "fr_router": "https://my-fr-router/?url=",
    "nm3u8_processor": "https://my-processor",
    "dash_proxy": "https://my-dash-proxy"
  },
  "drm_processing": false,
  "realdebridfolder": "https://my-rd-folder/",
  "torbox": {
    "tb_webdav_url": "https://webdav.torbox.app/",
    "tb_webdav_username": "torbox",
    "tb_webdav_password": "..."
  }
}
```

All sections are optional — providers degrade gracefully (FranceTV needs no
credentials at all; DRM content needs the relevant account + proxy entries).

### Environment variables

`.env` in this folder is loaded at startup.

| Variable | Purpose | Default |
|---|---|---|
| `HOST` / `PORT` | Bind address | `127.0.0.1` / `7860` |
| `ADDON_BASE_URL` | Public base URL for static assets (logos) | derived from request |
| `CREDENTIALS_JSON` | Full credentials document (overrides files) | — |
| `PROXY_<NAME>` | Override a single proxy, e.g. `PROXY_FR_DEFAULT` | from credentials |
| `MEDIAFLOW_PROXY_URL` / `MEDIAFLOW_API_PASSWORD` | MediaFlow proxy (overrides credentials section) | — |
| `DRM_PROCESSING` | Enable nm3u8 + TorBox/Real-Debrid lookups | off |
| `LOG_LEVEL` | `debug`, `info`, `warning`, `error` | `info` |
| `LOG_TO_FILE` / `LOG_FILE` | Optional file logging | off |
| `ENABLE_DEBUG_ENDPOINTS` | Expose `/debug/*` endpoints | off |
| `enable_remote_editor` | Serve the shows editor to non-local clients — see above | off |

### DRM (optional)

DRM-protected replays and live channels (TF1+, 6play) use a `device.wvd`
pywidevine device file, looked up at `src/providers/fr/device.wvd`,
`./device.wvd`, or `~/.pywidevine/device.wvd`. Background processing into
DRM-free files additionally uses the `nm3u8_processor` proxy entry, plus
optionally a TorBox account or a Real-Debrid folder (`realdebridfolder`) holding
pre-processed files; that whole path stays off unless `drm_processing` is
enabled.

Without a device file, the addon falls back to license-URL streams or HLS
variants where available.

## Architecture

```
routers/ (catalog, meta, stream, configure, editor)   Express endpoints
   |
   v
providers/factory.js                            per-request instance cache
   |
providers/registry.js --> config/providerConfig.PROVIDER_REGISTRY
   |                                            (derived, single source of truth;
   v                                            the manifest is generated from it)
providers/baseProvider.BaseProvider             template methods: getPrograms /
   |- static supportsLive                       getEpisodes hooks, header/proxy
   |- withDrmProcessedFiles(Base)               helpers, MediaFlow URL building
   |- fr/francetv.js  fr/mytf1.js  fr/sixplay.js  ca/cbc.js
   v
utils/     apiClient (retrying fetch + cookie jar), cache + cacheKeys,
           authCache, ids, clientIp, drm/, mediaflow, ...
widevine/  a Widevine CDM: wvd device, protobuf, AES-CMAC key derivation
```

### Subtitles (6play)

6play replays and live channels are served with French subtitles, including the
hard-of-hearing (SDH) track. Stremio gets them as a `subtitles` entry on the
stream, pointing at `/subtitles/6play/{id}/{lang}.vtt` on this server.

The subtitles are *not* the sidecar `subtitle_vtt` asset older clients looked
for — 6play no longer publishes one. They are a segmented TTML track inside the
same DASH manifest the video comes from, which MediaFlow drops when it converts
DASH to HLS. So `src/utils/subtitles/` reads the text `AdaptationSet` out of the
manifest already fetched for the DRM key (no extra request), and the route
fetches its TTML fragments, unwraps each `mdat`, and concatenates the cues into
one WebVTT file.

Nothing is downloaded while resolving a stream: the file is built on the first
request for it (a 92-minute episode is ~90 fragments, about 2s, 8 at a time)
and cached, so pressing play stays as fast as it was.

**Live is best-effort.** A live manifest only carries a rolling window, so the
generated file covers the last few minutes and is timed from the start of that
window rather than the player's clock — expect drift, and expect the plain
(non-SDH) track to be empty while French-language programming is on air.

### Keeping playback fast

Two things dominate the time between pressing play and a stream URL coming back,
and both are handled off the request path:

- **Auth is pre-cached.** `src/utils/authWarmer.js` logs into every provider at
  startup and re-logs-in every 4 minutes — inside the 5-minute buffer the token
  cache already applies to each JWT's `exp`, so a request never finds an empty
  cache. Logging in costs ~1-3s per provider (MyTF1 and 6play are three serial
  round trips each, CBC's ROPC grant alone is ~2s); a viewer now pays none of it.
  Verified end to end: after the startup sweep, repeated stream resolutions across
  all four providers issue **zero** further auth requests.
- **Independent calls run together.** Within one stream resolution the
  pre-processed-file lookup, the login and the asset list are unrelated, as are
  the manifest read and the DRM upfront token; each pair now runs concurrently.
  The season/channel probes (CBC seasons 1-10, France TV's five channels, TF1's
  five programme lists) try the usual answer alone first and only fan out on a
  miss, so the common case still costs one request and the rare case costs one
  round trip instead of up to nine.

Measured against the same code before these changes, first play after startup:

| | before | after | upstream calls |
|---|---|---|---|
| MyTF1 replay | 6055 ms | 931 ms | 6 → 3 |
| 6play replay | 4635 ms | 1822 ms | 9 → 6 |
| CBC replay | 3316 ms | 87 ms | 5 → 2 |

Key conventions:

- **Composite IDs**: `cutam:{country}:{provider}:{slug}[ :episode:{id} ]` —
  parsed exclusively via `src/utils/ids.js` (grammar documented in
  `src/schemas/typeDefs.js`).
- **Stream contract**: provider stream methods return an array of stream
  objects, or `null` — never a bare object.
- **Caching**: all shared-cache keys and TTLs are declared in
  `src/utils/cacheKeys.js`; auth tokens persist across requests via
  `src/utils/authCache.js` with TTLs derived from JWT expiry.
- **Adding a provider**: subclass `BaseProvider` (wrapping it in
  `withDrmProcessedFiles` if needed), set the static class fields
  (`providerName`, `idPrefix`, `catalogId`, ...), implement the template hooks,
  and register the class in `src/providers/registry.js`. The manifest, routing,
  `/health` and `/configure` pick it up automatically.

### Notes on the port

Where the runtime forced a different approach — the observable behaviour is the
same either way.

| Python | Here | Why |
|---|---|---|
| FastAPI + `run_in_threadpool` | Express + `async`/`await` | Provider I/O is already non-blocking in Node, so there is nothing to move off the event loop. |
| `requests.Session` | `fetch` + `utils/cookieJar.js` | `fetch` keeps no cookies, and TF1's Gigya login needs the one its bootstrap call sets. |
| `pywidevine` | `src/widevine/` | No maintained JS equivalent. ~400 lines: a `.wvd` reader, the four protobuf messages the exchange uses, AES-CMAC, and the key derivation. Verified against pywidevine — same challenge structure, same recovered keys. |
| pydantic models | `schemas/stremio.js` builders | Same field projection and `null` rendering, without a validation library. |
| `xml.etree` for MPDs | `utils/drm/mpdXml.js` | Two attribute lookups on one element type do not need an XML parser dependency. |
| `contextvars` for the viewer IP | `AsyncLocalStorage` | The direct equivalent. |
| `logging` | `utils/logger.js` | ~30 lines over `console`, same level gate and line shape. |
| `uvicorn --reload` | `node --watch` | Built in. |

## Development

```bash
npm test                       # node:test — no network, no fixtures
```

The suite covers the pure logic (ID grammar, cache eviction, IP resolution, key
encoding, the programs.json round-trip), the HTTP surface in-process, and the
Widevine CDM against the RFC 4493 CMAC vectors plus a synthetic license
exchange.
