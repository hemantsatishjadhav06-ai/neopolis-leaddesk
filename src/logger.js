const fmt = (level, msg, extra) => {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  return extra !== undefined ? `${line} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : line;
};
export const log = {
  info: (m, e) => console.log(fmt('info', m, e)),
  warn: (m, e) => console.warn(fmt('warn', m, e)),
  error: (m, e) => console.error(fmt('error', m, e instanceof Error ? (e.stack || e.message) : e)),
  debug: (m, e) => { if (process.env.DEBUG) console.log(fmt('debug', m, e)); },
};
