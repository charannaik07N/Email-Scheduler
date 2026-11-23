import Redis, { RedisOptions } from 'ioredis';
import { logger } from '../utils/logger';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const baseOptions: RedisOptions = {
  retryStrategy: (times: number) => Math.min(times * 50, 2000),
  reconnectOnError: (err) => err.message.includes('READONLY'),
};

const attachLogging = (client: Redis, label: string) => {
  client.on('connect', () => logger.info(`✅ Redis (${label}) connected`));
  client.on('error', (error) => logger.error(`❌ Redis (${label}) error:`, error.message));
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
