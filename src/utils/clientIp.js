/** Viewer IP extraction, normalization and forwarding.
 *
 * One resolution pipeline (`resolveViewerIp`) with a single header priority:
 *
 * 1. `x-ip-token`  — signed JWT-shaped token carrying the user's external IP
 * 2. `cf-connecting-ip` / `true-client-ip` — CDN-provided single values
 * 3. `x-real-ip`  — reverse-proxy single value
 * 4. `x-forwarded-for` — first (public, when filtering) hop in the chain
 * 5. The raw connection address (`req.socket.remoteAddress`) / request context
 *
 * The per-request "current IP" lives in an AsyncLocalStorage store — Node's
 * equivalent of Python's ContextVar, and the reason provider code deep in the
 * call stack can reach the viewer IP without it being threaded through.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import net from 'node:net';

const ipStore = new AsyncLocalStorage();

// Fallback holder for code paths not wrapped in a store (tests, scripts).
let fallbackIp = null;

// Single-value forwarding headers, in trust order
const SINGLE_IP_HEADERS = ['cf-connecting-ip', 'true-client-ip', 'x-real-ip'];

/** Decode the `ip` claim from an unsigned JWT-shaped token header.
 *
 * The token is NOT verified — it is trusted as far as the proxy chain is
 * trusted (same assumption used throughout this addon for IP forwarding).
 */
function decodeIpToken(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    return payload.ip ?? null;
  } catch {
    return null;
  }
}

/** Normalize IP strings from headers: strip ports, brackets, IPv6-mapped IPv4.
 *
 * - "203.0.113.5:1234" -> "203.0.113.5"
 * - "[2001:db8::1]:443" -> "2001:db8::1"
 * - "::ffff:192.0.2.10" -> "192.0.2.10"
 */
export function normalizeIp(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  try {
    if (s.startsWith('[') && s.includes(']')) {
      return s.slice(1, s.indexOf(']'));
    }
    const colons = (s.match(/:/g) || []).length;
    if (colons === 1 && s.includes('.') && /^\d+$/.test(s.split(':').pop())) {
      s = s.slice(0, s.lastIndexOf(':'));
    }
    if (s.toLowerCase().startsWith('::ffff:') && (s.match(/\./g) || []).length === 3) {
      return s.split(':').pop();
    }
    return s;
  } catch {
    return s;
  }
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

/** Check if an IP address is public (not private/local/loopback/reserved). */
export function isPublicIp(ipStr) {
  if (!ipStr) return false;
  const version = net.isIP(ipStr);
  if (version === 4) {
    const n = ipv4ToInt(ipStr);
    const inRange = (cidrStart, bits) => (n >>> (32 - bits)) === (ipv4ToInt(cidrStart) >>> (32 - bits));
    if (inRange('10.0.0.0', 8)) return false; // private
    if (inRange('172.16.0.0', 12)) return false; // private
    if (inRange('192.168.0.0', 16)) return false; // private
    if (inRange('127.0.0.0', 8)) return false; // loopback
    if (inRange('169.254.0.0', 16)) return false; // link-local
    if (inRange('100.64.0.0', 10)) return false; // CGNAT / shared
    if (inRange('192.0.0.0', 24)) return false; // IETF protocol assignments
    if (inRange('192.0.2.0', 24)) return false; // TEST-NET-1
    if (inRange('198.18.0.0', 15)) return false; // benchmarking
    if (inRange('198.51.100.0', 24)) return false; // TEST-NET-2
    if (inRange('203.0.113.0', 24)) return false; // TEST-NET-3
    if (inRange('224.0.0.0', 4)) return false; // multicast
    if (inRange('240.0.0.0', 4)) return false; // reserved / broadcast
    if (inRange('0.0.0.0', 8)) return false; // "this network"
    return true;
  }
  if (version === 6) {
    const lower = ipStr.toLowerCase();
    if (lower === '::1' || lower === '::') return false;
    if (/^f[cd]/.test(lower)) return false; // unique local
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return false; // link-local
    }
    if (lower.startsWith('ff')) return false; // multicast
    if (lower.startsWith('2001:db8')) return false; // documentation
    return true;
  }
  return false;
}

/** Extract the first public IP from an X-Forwarded-For header chain. */
export function extractPublicIpFromXff(xffHeader) {
  if (!xffHeader) return null;
  for (const part of String(xffHeader).split(',')) {
    const normalized = normalizeIp(part.trim());
    if (normalized && isPublicIp(normalized)) return normalized;
  }
  return null;
}

function headerGetter(headers) {
  if (!headers) return () => null;
  if (typeof headers.get === 'function') {
    return (name) => headers.get(name) ?? headers.get(name.toLowerCase()) ?? null;
  }
  const lowered = {};
  for (const [k, v] of Object.entries(headers)) lowered[k.toLowerCase()] = v;
  return (name) => lowered[name.toLowerCase()] ?? null;
}

/** Resolve the viewer's IP from request data — the single extraction pipeline. */
export function resolveViewerIp(headers = null, clientHost = null, publicOnly = false) {
  const h = headerGetter(headers);

  const accept = (candidate) => {
    const ip = normalizeIp(candidate);
    if (!ip) return null;
    if (publicOnly && !isPublicIp(ip)) return null;
    return ip;
  };

  // 1. Signed token (contains the user's real external IP)
  const token = h('x-ip-token');
  if (token) {
    const ip = accept(decodeIpToken(token));
    if (ip) return ip;
  }

  // 2./3. CDN / reverse-proxy single-value headers
  for (const header of SINGLE_IP_HEADERS) {
    const ip = accept(h(header));
    if (ip) return ip;
  }

  // 4. X-Forwarded-For chain
  const xff = h('x-forwarded-for');
  if (xff) {
    const ip = publicOnly
      ? extractPublicIpFromXff(xff)
      : normalizeIp(String(xff).split(',')[0].trim());
    if (ip) return ip;
  }

  // 5. Direct connection IP (may be private/loopback in proxied setups)
  return accept(clientHost);
}

/** Extract the viewer IP from an incoming HTTP request (any IP accepted). */
export function extractRequestIp(headers, clientHost = null) {
  return resolveViewerIp(headers, clientHost, false);
}

/** Get the viewer's public IP, filtering out private/local addresses. */
export function getPublicClientIp(requestHeaders = null) {
  const ip = resolveViewerIp(requestHeaders, null, true);
  if (ip) return ip;
  const contextIp = normalizeIp(getClientIp());
  if (contextIp && isPublicIp(contextIp)) return contextIp;
  return null;
}

/** Run *fn* with *ip* as the current request context's viewer IP. */
export function runWithClientIp(ip, fn) {
  fallbackIp = ip;
  return ipStore.run({ ip }, fn);
}

/** Set the current viewer/client IP (outside a store this sets the fallback). */
export function setClientIp(ip) {
  const store = ipStore.getStore();
  if (store) store.ip = ip;
  else fallbackIp = ip;
}

/** Get the current viewer/client IP from context (if any). */
export function getClientIp(fallback = null) {
  const store = ipStore.getStore();
  const ip = store ? store.ip : fallbackIp;
  return ip || fallback;
}

/** Extract viewer IP from request data and set it in the request context. */
export function setIpFromRequest(headers, clientHost = null) {
  setClientIp(resolveViewerIp(headers, clientHost));
}

/** Headers that forward the viewer's public IP to upstreams.
 *
 * These headers are commonly honored by various upstreams/CDNs. Upstreams may
 * or may not trust them, but we always forward.
 */
export function makeIpHeaders(ip = null, requestHeaders = null) {
  const realIp = ip || getPublicClientIp(requestHeaders);
  if (!realIp) return {};
  return {
    'X-Forwarded-For': realIp,
    'X-Real-IP': realIp,
    'CF-Connecting-IP': realIp,
    'True-Client-IP': realIp,
    // Some stacks also use this legacy header
    'X-Client-IP': realIp,
    // RFC 7239 Forwarded header (minimal form)
    Forwarded: `for=${realIp}`,
  };
}

/** Merge IP forwarding headers into an existing headers object, overriding. */
export function mergeIpHeaders(headers = null, ip = null, requestHeaders = null) {
  return { ...(headers || {}), ...makeIpHeaders(ip, requestHeaders) };
}
