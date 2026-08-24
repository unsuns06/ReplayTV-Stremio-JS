/** Minimal levelled logger — the stdlib `console` with a level gate.
 *
 * Replaces Python's `logging`: same five levels, the same
 * "timestamp - name - LEVEL - message" line shape, and `%s`/`%d` placeholders
 * handled by console's own formatting.
 */
const LEVELS = { debug: 10, info: 20, warning: 30, error: 40, critical: 50 };

const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
export const LOG_LEVEL_NAME = envLevel.toUpperCase();
const threshold = LEVELS[envLevel] ?? LEVELS.info;

function emit(level, name, args) {
  if (LEVELS[level] < threshold) return;
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const prefix = `${stamp} - ${name} - ${level.toUpperCase()} -`;
  const sink = LEVELS[level] >= LEVELS.warning ? console.error : console.log;
  const [first, ...rest] = args;
  if (typeof first === 'string') sink(`${prefix} ${first}`, ...rest);
  else sink(prefix, ...args);
}

export function getLogger(name) {
  return {
    debug: (...a) => emit('debug', name, a),
    info: (...a) => emit('info', name, a),
    warning: (...a) => emit('warning', name, a),
    warn: (...a) => emit('warning', name, a),
    error: (...a) => emit('error', name, a),
    /** error + stack, mirroring logging.exception */
    exception: (...a) => {
      const err = a.find((x) => x instanceof Error);
      emit('error', name, a.filter((x) => !(x instanceof Error)));
      if (err) emit('error', name, [err.stack || String(err)]);
    },
  };
}
