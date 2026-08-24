/** Standalone JSON parsing utilities with comprehensive error handling. */
import { getLogger } from './logger.js';

const logger = getLogger('utils.jsonParser');

/** Parse a JSON string, returning `null` (with a debug log) on failure.
 *
 * Note: an earlier "quote-fix" fallback (regex-quoting bare keys) was removed
 * because it corrupted any value containing a colon (e.g. every URL) while
 * hiding the real parse error.
 */
export function parseJsonText(text, context = '') {
  try {
    return JSON.parse(text);
  } catch (exc) {
    logger.debug('%s — JSON parse failed: %s', context, exc.message);
    return null;
  }
}

/** Safely parse a fetch Response body with multiple fallback strategies.
 *
 * @param {Response} response  an already-awaited fetch Response
 * @param {string} text        its body text (read once by the caller)
 * @param {string} context     caller context for log messages
 */
export function safeJsonParse(response, text, context = '') {
  try {
    if (response.status !== 200) {
      logger.warning('%s — HTTP %s: %s', context, response.status, response.statusText);
      return null;
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();

    if (!text || !text.trim()) {
      logger.warning('%s — empty response', context);
      return null;
    }

    // Allow "text/html, application/json" (FranceTV token endpoint quirk)
    if (contentType.includes('text/html') && !contentType.includes('application/json')) {
      logger.warning('%s — received HTML instead of JSON (likely error page)', context);
      return null;
    }

    let body = text.trim();

    // Unwrap JSONP
    if (body.startsWith('jsonp_') && body.endsWith(');')) {
      body = body.slice(body.indexOf('(') + 1, body.lastIndexOf(');'));
      logger.debug('%s — extracted JSON from JSONP wrapper', context);
    }

    const result = parseJsonText(body, context);
    if (result !== null) return result;

    // Strategy 3: extract outermost {...} from a mixed response
    try {
      const m = body.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
    } catch { /* fall through */ }

    // Strategy 4: strip JSONP/callback wrapper
    try {
      const start = body.indexOf('{');
      const end = body.lastIndexOf('}') + 1;
      if (start !== -1 && end > start) return JSON.parse(body.slice(start, end));
    } catch { /* fall through */ }

    logger.error('%s — all JSON parse strategies failed; response: %s', context, body.slice(0, 500));
    return null;
  } catch (exc) {
    logger.error('%s — unexpected error in JSON parsing: %s', context, exc.message);
    return null;
  }
}
