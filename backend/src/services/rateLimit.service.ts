import { redisCommands } from '../config/redis';
import { getCurrentHourWindow, getNextHourTimestamp } from '../utils/time';
import { logger } from '../utils/logger';

const MAX_EMAILS_PER_HOUR = parseInt(process.env.MAX_EMAILS_PER_HOUR_PER_SENDER || '100', 10);

// Window keys live a little longer than the hour they count.
const WINDOW_TTL_SECONDS = 2 * 3600;

export interface RateLimitReservation {
  allowed: boolean;
  current: number;
  limit: number;
  resetAt: Date;
  /** Key to pass to releaseRateLimit if the send doesn't happen. */
  key: string;
}

/**
 * Atomically take one slot in the sender's hourly window: INCR, set the TTL on
 * first use, and give the slot back if the limit is already reached. Concurrent
 * workers can't overshoot the limit.
 */
const RESERVE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
if count > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return -count
end
return count
`;

const rateLimitKey = (senderId: string, now: Date) =>
  `rate_limit:${senderId}:${getCurrentHourWindow(now)}`;

export const reserveRateLimit = async (senderId: string): Promise<RateLimitReservation> => {
  const now = new Date();
  const key = rateLimitKey(senderId, now);
  const result = (await redisCommands.eval(
    RESERVE_SCRIPT,
    1,
    key,
    MAX_EMAILS_PER_HOUR,
    WINDOW_TTL_SECONDS
  )) as number;

  return {
    allowed: result > 0,
    current: Math.abs(result) - (result > 0 ? 0 : 1),
    limit: MAX_EMAILS_PER_HOUR,
    resetAt: getNextHourTimestamp(now),
    key,
  };
};

/** Give back a reserved slot (the email wasn't actually sent). */
export const releaseRateLimit = async (key: string): Promise<void> => {
  try {
    await redisCommands.decr(key);
  } catch (error) {
    logger.error('❌ Failed to release rate limit slot:', error);
  }
};

const SEND_LOCK_TTL_SECONDS = 10 * 60;
const sendLockKey = (emailId: string) => `email_send_lock:${emailId}`;

/**
 * Per-email lock so two jobs for the same email (e.g. a leftover job from
 * before a restart) can never send it twice at the same time.
 */
export type SendLockResult = 'acquired' | 'busy' | 'sent';

/** 'busy': another job holds the lock. 'sent': the email was already sent. */
export const acquireSendLock = async (emailId: string): Promise<SendLockResult> => {
  const key = sendLockKey(emailId);
  const result = await redisCommands.set(key, 'sending', 'EX', SEND_LOCK_TTL_SECONDS, 'NX');
  if (result === 'OK') return 'acquired';
  return (await redisCommands.get(key)) === 'sent' ? 'sent' : 'busy';
};

export const SEND_LOCK_RETRY_MS = 60 * 1000;

const SENT_MARKER_TTL_SECONDS = 7 * 24 * 3600;

/**
 * After a successful send, keep the lock for a week. Even if saving the SENT
 * status fails, a later job for the same email then sees 'sent' and only
 * repairs the row instead of sending again. Returns false if Redis failed.
 *
 * `untilSaved`: the SENT status isn't in the database yet, so the marker must
 * not expire; it is the only record of the send. Call markSent again without
 * it once the status is saved, so the marker expires as usual.
 */
export const markSent = async (emailId: string, { untilSaved = false } = {}): Promise<boolean> => {
  try {
    if (untilSaved) await redisCommands.set(sendLockKey(emailId), 'sent');
    else await redisCommands.set(sendLockKey(emailId), 'sent', 'EX', SENT_MARKER_TTL_SECONDS);
    return true;
  } catch (error) {
    logger.error('❌ Failed to mark email as sent in Redis:', error);
    return false;
  }
};

export const releaseSendLock = async (emailId: string): Promise<void> => {
  try {
    await redisCommands.del(sendLockKey(emailId));
  } catch (error) {
    logger.error('❌ Failed to release send lock:', error);
  }
};
