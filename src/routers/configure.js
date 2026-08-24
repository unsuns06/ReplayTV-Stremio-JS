/** Configure endpoint — shows provider credential status and setup instructions. */
import express from 'express';

import { loadCredentials } from '../utils/credentials.js';
import { PROVIDER_REGISTRY } from '../config/providerConfig.js';
import { drmProcessingEnabled } from '../providers/drmMixin.js';

export const router = express.Router();

// Providers that require a login/password pair in credentials.json (or the
// CREDENTIALS_JSON env var), keyed by the credentials.json section name.
const PROVIDERS_REQUIRING_AUTH = new Set(['mytf1', '6play', 'cbc']);

const PROVIDER_NOTES = {
  francetv: 'No credentials required — public content.',
  mytf1: 'Requires a free TF1+ account (tf1.fr).',
  '6play': 'Requires a free 6play account (6play.fr).',
  cbc: 'Requires a free CBC Gem account (gem.cbc.ca).',
};

/** provider_key → configuration details. */
function getProviderStatus() {
  let creds;
  try {
    creds = loadCredentials();
  } catch {
    creds = {};
  }

  const status = {};
  for (const [key, config] of Object.entries(PROVIDER_REGISTRY)) {
    const credsKey = config.credentials_key || key;
    let providerCreds = creds[credsKey] ?? {};
    if (typeof providerCreds !== 'object' || Array.isArray(providerCreds) || providerCreds === null) {
      providerCreds = {};
    }
    const hasLogin = Boolean(providerCreds.login || providerCreds.email);
    const hasPassword = Boolean(providerCreds.password);
    const requiresAuth = PROVIDERS_REQUIRING_AUTH.has(key);

    let configured;
    let label;
    if (!requiresAuth) {
      configured = true;
      label = '✅ Ready (no auth needed)';
    } else if (hasLogin && hasPassword) {
      configured = true;
      label = '✅ Credentials configured';
    } else if (hasLogin) {
      configured = false;
      label = '⚠️ Password missing';
    } else {
      configured = false;
      label = '❌ Not configured';
    }

    status[key] = {
      display_name: config.display_name,
      configured,
      label,
      note: PROVIDER_NOTES[key] || '',
      credentials_key: requiresAuth ? credsKey : null,
    };
  }
  return status;
}

router.get('/configure', (req, res) => {
  const providerStatus = getProviderStatus();
  const allOk = Object.values(providerStatus).every((p) => p.configured);

  let rows = '';
  for (const info of Object.values(providerStatus)) {
    const credsHtml = info.credentials_key
      ? `<br><small>credentials key: <code>"${info.credentials_key}"</code>`
        + '&nbsp;(<code>login</code> / <code>password</code>)</small>'
      : '';
    rows += `
        <tr>
          <td><strong>${info.display_name}</strong></td>
          <td>${info.label}</td>
          <td>${info.note}${credsHtml}</td>
        </tr>`;
  }

  const overall = allOk
    ? '<span style="color:#22c55e">✅ All providers ready</span>'
    : '<span style="color:#f59e0b">⚠️ Some providers need credentials</span>';

  const drmLabel = drmProcessingEnabled()
    ? '<span style="color:#22c55e">enabled</span>'
    : '<span style="color:#94a3b8">disabled</span>';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Catch-up TV &amp; More — Configuration</title>
  <style>
    body {font-family: system-ui, sans-serif; max-width: 860px; margin: 40px auto;
           padding: 0 20px; background: #0f172a; color: #e2e8f0;}
    h1   {color: #f8fafc; margin-bottom: 4px;}
    p    {color: #94a3b8; margin-top: 0;}
    table {width: 100%; border-collapse: collapse; margin-top: 24px;}
    th   {text-align: left; padding: 10px 14px; background: #1e293b;
           color: #94a3b8; font-size: .85rem; text-transform: uppercase;
           letter-spacing: .05em;}
    td   {padding: 12px 14px; border-bottom: 1px solid #1e293b; vertical-align: top;}
    tr:last-child td {border-bottom: none;}
    code {background: #1e293b; padding: 2px 6px; border-radius: 4px;
           font-size: .85em; color: #7dd3fc;}
    .badge {display: inline-block; padding: 4px 10px; border-radius: 999px;
             font-size: .8rem; font-weight: 600;}
    .ok  {background: #14532d; color: #86efac;}
    .warn{background: #451a03; color: #fcd34d;}
    details {margin-top: 28px;}
    summary {cursor: pointer; color: #7dd3fc; font-weight: 600;}
    pre  {background: #1e293b; padding: 16px; border-radius: 8px;
           overflow-x: auto; font-size: .85rem; color: #e2e8f0;}
  </style>
</head>
<body>
  <h1>Catch-up TV &amp; More</h1>
  <p>Stremio addon — provider configuration status</p>

  <p>Overall: ${overall}</p>

  <p>DRM processing (nm3u8 + TorBox/Real-Debrid sources for 6play &amp; MyTF1):
    <strong>${drmLabel}</strong><br>
    <small>Toggle with <code>"drm_processing": true|false</code> in
    <code>credentials.json</code> or <code>DRM_PROCESSING=1|0</code>. Disabled by
    default — only the direct stream is offered.</small></p>

  <table>
    <thead>
      <tr><th>Provider</th><th>Status</th><th>Notes &amp; env vars</th></tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>

  <details>
    <summary>How to configure credentials</summary>
    <p>
      Set credentials via environment variables <em>or</em> in
      <code>credentials.json</code> at the project root.
    </p>
    <p><strong>Environment variable (recommended for deployments) — set
    <code>CREDENTIALS_JSON</code> to the full JSON document:</strong></p>
    <pre>CREDENTIALS_JSON='{"mytf1":{"login":"user@example.com","password":"secret"},
  "6play":{"login":"user@example.com","password":"secret"},
  "cbcgem":{"login":"user@example.com","password":"secret"}}'</pre>
    <p><strong>Or in <code>credentials.json</code>:</strong></p>
    <pre>{
  "mytf1":  {"login": "user@example.com", "password": "secret"},
  "6play":  {"login": "user@example.com", "password": "secret"},
  "cbcgem": {"login": "user@example.com", "password": "secret"}
}</pre>
  </details>
</body>
</html>`;

  res.type('html').send(html);
});

/** Provider configuration status as JSON (for programmatic checks). */
router.get('/configure/status', (req, res) => {
  const status = getProviderStatus();
  const providers = {};
  for (const [k, v] of Object.entries(status)) {
    providers[k] = { configured: v.configured, label: v.label };
  }
  res.json({
    all_configured: Object.values(status).every((p) => p.configured),
    drm_processing: drmProcessingEnabled(),
    providers,
  });
});
