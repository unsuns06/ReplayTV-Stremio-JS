/** French egress for the France Télévisions CDNs.
 *
 * FranceTV splits cleanly in two: its APIs answer anybody, its media answers
 * only France. `k7.ftven.fr`, `hdfauth.ftven.fr` and the yatta APIs all serve a
 * Canadian address happily, and the Akamai token `hdfauth` mints is not bound
 * to the address that asked for it — a token minted from Ottawa is accepted
 * when the segment request comes from Paris. Only the CDNs themselves
 * (`simulcast-p` for live, `cloudreplay` for replays) check the caller, and
 * they refuse everything outside France with a bare Akamai 403, manifest and
 * segments alike. A US host is refused too, so the deployment's own address is
 * no help the way it is for ABC.
 *
 * So the manifest is fetched here through the `fr_default` proxy and its
 * `BaseURL` is repointed at this addon, which puts every segment through the
 * same French hop. Two details of that proxy shape this file:
 *
 *  - It is the only one of the two that can carry media. `fr_router` decodes
 *    bodies as UTF-8 and re-encodes them, so every byte above 0x7f comes back
 *    as U+FFFD — a 736-byte init segment arrives with `moov` preceded by three
 *    replacement bytes, unrecoverably corrupt.
 *  - It hands text back as-is but base64-encodes everything else, so segments
 *    have to be decoded here rather than streamed through.
 */
import express from 'express';

import { getLogger } from '../utils/logger.js';
import { getBaseUrl } from '../utils/baseUrl.js';
import { getProxyConfig } from '../utils/proxyConfig.js';

export const router = express.Router();
const logger = getLogger('routers.ftvGeo');

export const FTV_MANIFEST_PATH = '/ftv/manifest.mpd';
export const FTV_SEGMENT_PATH = '/ftv/s';

// Both the live and the replay CDN live here; nothing else may be fetched.
const ALLOWED_HOSTS = /(^|\.)ftven\.fr$/;

/** Public URL of the rewritten manifest for *signedUrl*. */
export function buildFtvManifestUrl(baseUrl, signedUrl) {
  return `${baseUrl.replace(/\/+$/, '')}${FTV_MANIFEST_PATH}?${new URLSearchParams({ u: signedUrl })}`;
}

/** The target URL, or null when it is not a France TV CDN over https. */
function allowedTarget(u) {
  let target;
  try {
    target = new URL(u);
  } catch {
    return null;
  }
  return target.protocol === 'https:' && ALLOWED_HOSTS.test(target.hostname) ? target : null;
}

/** A manifest is XML or M3U8; base64 can only ever be the alphabet, never `<`. */
const isText = (buf) => /^[<#]/.test(buf.subarray(0, 64).toString('latin1').trimStart());

/** Fetch *url* from France, returning the real bytes. */
async function fetchViaFrance(url) {
  const proxy = getProxyConfig().getProxy('fr_default');
  if (!proxy) throw new Error("proxy 'fr_default' is not configured");
  const response = await fetch(proxy + encodeURIComponent(url), {
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  return isText(body) ? body : Buffer.from(body.toString('latin1'), 'base64');
}

/** Point a manifest's segments at this addon. Exported for the tests.
 *
 * The signature travels in the context rather than in the `BaseURL`, so the
 * URLs the player builds stay free of a query string it would have to merge
 * with its own. Replays already carry a relative `<BaseURL>dash/</BaseURL>`;
 * resolving it here and replacing it is what keeps the player from appending
 * `dash/` a second time.
 */
export function rewriteMpd(xml, manifestUrl, addonBase) {
  const existing = xml.match(/<BaseURL>([^<]*)<\/BaseURL>/);
  const cdnBase = new URL(existing ? existing[1] : '.', manifestUrl);
  const context = Buffer.from(
    `${cdnBase.origin}${cdnBase.pathname}\n${new URL(manifestUrl).search}`,
  ).toString('base64url');
  const tag = `<BaseURL>${addonBase.replace(/\/+$/, '')}${FTV_SEGMENT_PATH}/${context}/</BaseURL>`;
  return existing
    ? xml.replace(existing[0], tag)
    : xml.replace(/(<MPD\b[^>]*>)/, `$1\n  ${tag}`);
}

router.get(FTV_MANIFEST_PATH, async (req, res) => {
  const { u } = req.query;
  if (!u || !allowedTarget(u)) {
    res.status(400).send('u must be an https URL on a France TV CDN');
    return;
  }
  try {
    const xml = (await fetchViaFrance(u)).toString('utf-8');
    res.type('application/dash+xml').send(rewriteMpd(xml, u, getBaseUrl(req)));
  } catch (exc) {
    logger.error('❌ Manifest fetch failed: %s', exc.message);
    res.status(502).send('upstream manifest unavailable');
  }
});

router.get(`${FTV_SEGMENT_PATH}/:context/*`, async (req, res) => {
  const [base, search] = Buffer.from(req.params.context, 'base64url').toString().split('\n');
  let target;
  try {
    target = new URL(req.params[0], base).toString() + (search || '');
  } catch {
    res.status(400).send('bad segment context');
    return;
  }
  if (!allowedTarget(target)) {
    res.status(400).send('segment must resolve to a France TV CDN');
    return;
  }
  try {
    res.type('video/mp4').send(await fetchViaFrance(target));
  } catch (exc) {
    logger.error('❌ Segment failed: %s', exc.message);
    res.status(502).send('segment unavailable');
  }
});
