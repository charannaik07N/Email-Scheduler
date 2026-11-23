import Redis, { RedisOptions } from 'ioredis';
import { logger } from '../utils/logger';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const baseOptions: RedisOptions = {
  retryStrategy: (times: number) => Math.min(times * 50, 2000),
  reconnectOnError: (err) => err.message.includes('READONLY'),
};

/** Where Redis is, without the password a URL may carry. */
const redisHost = (() => {
  try {
    const url = new URL(REDIS_URL);
    return `${url.hostname}:${url.port || 6379}`;
  } catch {
    return 'the configured REDIS_URL';
  }
})();

/** A connection error's reason. A refused connection is an AggregateError with an empty message. */
export const describeRedisError = (error: Error & { code?: string }) =>
  // ioredis's way of saying a command gave up because there is no connection.
  error.name === 'MaxRetriesPerRequestError' ? `no connection to ${redisHost}` : error.code || error.message || error.name;

/** Errors that only mean "Redis is unreachable right now"; the client keeps retrying. */
export const isConnectionError = (error: Error & { code?: string }) =>
  ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EPIPE'].includes(error.code ?? '') ||
  error.name === 'AggregateError' ||
  /Connection is closed|connect ETIMEDOUT/.test(error.message);

/**
 * Log an outage once, not on every retry (ioredis retries every few hundred
 * milliseconds), and say when the connection is back.
 */
const attachLogging = (client: Redis, label: string) => {
  let down = false;
  client.on('ready', () => {
    logger.info(down ? `✅ Redis (${label}) reconnected to ${redisHost}` : `✅ Redis (${label}) connected to ${redisHost}`);
    down = false;
  });
  client.on('error', (error: Error & { code?: string }) => {
    if (isConnectionError(error)) {
      if (down) return;
      down = true;
      logger.error(
        `❌ Redis (${label}) is unreachable at ${redisHost} (${describeRedisError(error)}). Is Redis running? Retrying in the background.`
      );
      return;
    }
    logger.error(`❌ Redis (${label}) error: ${describeRedisError(error)}`);
  });
};

/**
 * Connection for BullMQ. BullMQ requires maxRetriesPerRequest: null, which makes
 * commands wait indefinitely while Redis is down — so don't use it for anything
 * a request handler awaits.
 */
export const redis = new Redis(REDIS_URL, { ...baseOptions, maxRetriesPerRequest: null });
attachLogging(redis, 'queue');

/** Connection for plain commands (rate limits, locks, health): fails fast when Redis is down. */
export const redisCommands = new Redis(REDIS_URL, {
  ...baseOptions,
  maxRetriesPerRequest: 1,
  connectTimeout: 5000,
});
attachLogging(redisCommands, 'commands');

const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

export const testRedisConnection = async (): Promise<void> => {
  await withTimeout(redisCommands.ping(), 5000, 'Redis ping timed out');
  logger.info('✅ Redis ping successful');
};

export const disconnectRedis = async (): Promise<void> => {
  await Promise.allSettled([redis.quit(), redisCommands.quit()]);
  logger.info('✅ Redis disconnected');
};

export { withTimeout };
export default redis;
