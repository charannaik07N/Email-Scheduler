import winston from 'winston';

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

/**
 * Extra arguments arrive as "meta". Winston spreads a string argument into
 * one key per character ({ "0": "R", "1": "e", ... }); put it back together.
 * An error contributes its code and stack; its message is already appended
 * to the log message by winston.
 */
const describeMeta = (meta: Record<string, unknown>): string => {
  const keys = Object.keys(meta);
  if (keys.length === 0) return '';

  const charKeys = keys.filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
  const text = charKeys.map((k) => String(meta[k])).join('');
  const rest = Object.fromEntries(keys.filter((k) => !/^\d+$/.test(k)).map((k) => [k, meta[k]]));

  const parts: string[] = [];
  if (text) parts.push(text);
  if (typeof rest.code === 'string') parts.push(`(${rest.code})`);
  const { stack, code: _code, ...others } = rest;
  if (Object.keys(others).length > 0) parts.push(JSON.stringify(others, null, 2));
  // Stacks only when debugging: a down dependency would otherwise print one per retry.
  if (typeof stack === 'string' && process.env.LOG_LEVEL === 'debug') parts.push(`\n${stack}`);
  return parts.join(' ');
};

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const details = describeMeta(meta);
    return details ? `${timestamp} [${level}]: ${message} ${details}` : `${timestamp} [${level}]: ${message}`;
  })
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    new winston.transports.Console({
      format: consoleFormat,
    }),
  ],
});

export default logger;
