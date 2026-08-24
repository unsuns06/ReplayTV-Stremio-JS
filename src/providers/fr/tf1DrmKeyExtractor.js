/** TF1+ DRM Key Extractor — Widevine keys via the local CDM. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Cdm } from '../../widevine/cdm.js';
import { Device } from '../../widevine/device.js';
import { PSSH } from '../../widevine/pssh.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  Origin: 'https://www.tf1.fr',
  Referer: 'https://www.tf1.fr/',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'cross-site',
};

export class TF1DRMExtractor {
  constructor(wvdPath = null) {
    this.wvdPath = wvdPath;
    this.headers = { ...DEFAULT_HEADERS };
  }

  /** Extract PSSH from an MPD manifest. Returns base64-encoded PSSH or null. */
  async extractPsshFromMpd(mpdUrl) {
    try {
      const response = await fetch(mpdUrl, {
        headers: this.headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return null;
      const content = await response.text();

      // Method 1: Widevine ContentProtection elements
      const cpRe = /<(?:[\w.-]+:)?ContentProtection\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?ContentProtection>)/gi;
      for (const m of content.matchAll(cpRe)) {
        const attrs = m[1] || '';
        const body = m[2] || '';
        const scheme = (attrs.match(/schemeIdUri\s*=\s*"([^"]*)"/i)?.[1] || '').toLowerCase();
        if (scheme.includes('edef8ba9') || scheme.includes('widevine')) {
          const child = body.match(/<(?:[\w.-]+:)?pssh\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?pssh>/i);
          if (child && child[1].trim()) return child[1].trim();
          const attrPssh = attrs.match(/(?:[\w.-]+:)?pssh\s*=\s*"([^"]+)"/i);
          if (attrPssh) return attrPssh[1].trim();
        }
      }

      // Method 2: regex search for PSSH elements anywhere
      const psshPatterns = [
        /<(?:cenc:)?pssh[^>]*>([A-Za-z0-9+/=]+)<\/(?:cenc:)?pssh>/i,
        /"pssh"\s*:\s*"([A-Za-z0-9+/=]+)"/i,
        /pssh="([A-Za-z0-9+/=]+)"/i,
      ];
      for (const pattern of psshPatterns) {
        const match = content.match(pattern);
        if (match) return match[1].trim();
      }

      // Method 3: PSSH box format (starts with AAAA)
      const boxMatch = content.match(/(AAAA[A-Za-z0-9+/=]{40,})/);
      if (boxMatch) return boxMatch[1];

      // Method 4: base64 blob near "widevine" or "edef8ba9"
      const widevineSection = content.match(/(?:edef8ba9|widevine)[\s\S]{0,500}?([A-Za-z0-9+/=]{100,})/i);
      if (widevineSection && widevineSection[1].startsWith('AAAA')) return widevineSection[1];

      return null;
    } catch {
      return null;
    }
  }

  /** Load the Widevine device from a WVD file. Returns a Device or null. */
  loadDevice() {
    const candidates = [];
    if (this.wvdPath) candidates.push(this.wvdPath);
    candidates.push(
      path.join(HERE, 'device.wvd'),
      './device.wvd',
      './device_client_id_blob.wvd',
      './client_id.wvd',
      path.join(os.homedir(), '.pywidevine', 'device.wvd'),
      path.join(os.homedir(), 'device.wvd'),
    );
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try {
          return Device.load(candidate);
        } catch { /* try the next candidate */ }
      }
    }
    return null;
  }

  /** Extract DRM keys from a TF1+ video. Returns an object mapping KID to KEY. */
  async getKeys({ videoUrl, licenseUrl }) {
    let cdm = null;
    let sessionId = null;
    try {
      const psshB64 = await this.extractPsshFromMpd(videoUrl);
      if (!psshB64) return {};

      let pssh;
      try {
        pssh = new PSSH(psshB64);
      } catch {
        return {};
      }

      const device = this.loadDevice();
      if (!device) return {};

      cdm = Cdm.fromDevice(device);
      sessionId = cdm.open();
      const challenge = cdm.getLicenseChallenge(sessionId, pssh);

      const response = await fetch(licenseUrl, {
        method: 'POST',
        headers: {
          ...this.headers,
          'Content-Type': 'application/octet-stream',
          Accept: 'application/octet-stream, */*',
        },
        body: challenge,
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status !== 200) return {};

      cdm.parseLicense(sessionId, Buffer.from(await response.arrayBuffer()));

      const keys = {};
      for (const key of cdm.getKeys(sessionId, 'CONTENT')) {
        keys[key.kid.replace(/-/g, '')] = key.key.toString('hex');
      }
      return keys;
    } catch {
      return {};
    } finally {
      if (cdm && sessionId) {
        try {
          cdm.close(sessionId);
        } catch { /* already closed */ }
      }
    }
  }
}
