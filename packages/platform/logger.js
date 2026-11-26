'use strict';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function createLogger({ level = 'info', stream = process.stdout } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(name, message, fields = {}) {
    if ((LEVELS[name] ?? 9) > threshold) return;
    const entry = {
      time: new Date().toISOString(),
      level: name,
      msg: String(message),
      ...fields
    };
    // Never log cookies or bearer tokens, even at debug level.
    for (const key of Object.keys(entry)) {
      if (/cookie|authorization|token|secret/i.test(key)) entry[key] = '[redacted]';
    }
    try {
      stream.write(`${JSON.stringify(entry)}\n`);
    } catch {}
  }

  return {
    error: (msg, fields) => write('error', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    debug: (msg, fields) => write('debug', msg, fields),
    child: (fields) =>
      createLogger({
        level,
        stream: {
          write: (line) => {
            try {
              const entry = JSON.parse(line);
              stream.write(`${JSON.stringify({ ...entry, ...fields })}\n`);
            } catch {}
          }
        }
      })
  };
}

module.exports = { createLogger };
