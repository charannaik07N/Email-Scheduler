import { randomUUID } from 'node:crypto';
import { describeRedisError, redisCommands } from '../config/redis';
import { addEmailToQueue, getCompletedJobResult, JobActiveError } from '../queues/emailQueue';
import * as EmailService from '../services/email.service';
import { logger } from '../utils/logger';

const REQUEUE_LOCK_KEY = 'email_requeue_lock';
const REQUEUE_LOCK_TTL_SECONDS = 10 * 60;

/** A completed job that reported a send: the email went out but SENT wasn't saved. */
const wasSent = (result: unknown) =>
  typeof result === 'object' && result !== null && (result as { success?: unknown }).success === true;

// Only the holder may extend or release the lock (another process may hold it
// after ours expired).
const RELEASE_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const EXTEND_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) end return 0`;

type RequeueOutcome = 'done' | 'skipped' | 'unavailable';

/**
 * Rebuild the queue from the database, in case Redis lost jobs.
 *
 * Every unsent email (SCHEDULED or RETRYING) is queued again under its own ID,
 * so emails already in the queue are left alone. Emails whose time passed while
 * the server was down are sent right away instead of being dropped. If the
 * email's job already completed, it's never run again: a job that sent the
 * email gets its row saved as SENT instead.
 *
 * Only one process runs this at a time (a Redis lock), so parallel starts don't
 * remove and re-add each other's jobs. Returns 'unavailable' when Redis or the
 * database couldn't be reached, so the caller can try again.
 */
export const requeuePendingEmails = async (): Promise<RequeueOutcome> => {
  const token = `${process.pid}:${randomUUID()}`;
  let locked: string | null;
  try {
    locked = await redisCommands.set(REQUEUE_LOCK_KEY, token, 'EX', REQUEUE_LOCK_TTL_SECONDS, 'NX');
  } catch (error) {
    logger.error(`❌ Could not reach Redis to requeue unsent emails: ${describeRedisError(error as Error)}`);
    return 'unavailable';
  }
  if (locked !== 'OK') {
    logger.info('ℹ️  Another process is requeueing unsent emails, skipping');
    return 'skipped';
  }

  const extendLock = () =>
    redisCommands.eval(EXTEND_SCRIPT, 1, REQUEUE_LOCK_KEY, token, REQUEUE_LOCK_TTL_SECONDS).catch(() => undefined);
  try {
    return (await requeueAll(extendLock)) ? 'done' : 'unavailable';
  } finally {
    await redisCommands.eval(RELEASE_SCRIPT, 1, REQUEUE_LOCK_KEY, token).catch(() => undefined);
  }
};

const FIRST_RETRY_MS = 5 * 1000;
const MAX_RETRY_MS = 60 * 1000;

/**
 * Run the requeue at startup, and keep trying (5s, 10s, ... up to every minute)
 * while Redis or the database is unreachable, so emails aren't stranded just
 * because Redis came up after the server.
 */
export const requeuePendingEmailsWithRetry = async (): Promise<void> => {
  let wait = FIRST_RETRY_MS;
  for (;;) {
    if ((await requeuePendingEmails()) !== 'unavailable') return;
    logger.warn(`⏳ Will try requeueing unsent emails again in ${wait / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, wait).unref());
    wait = Math.min(wait * 2, MAX_RETRY_MS);
  }
};

/** Returns false if the emails couldn't be loaded (try again later). */
const requeueAll = async (extendLock: () => Promise<unknown>): Promise<boolean> => {
  logger.info('🔄 Checking for unsent emails to requeue...');

  let queued = 0;
  let overdue = 0;
  let repaired = 0;
  let failed = 0;
  const now = Date.now();

  try {
    for await (const page of EmailService.getPendingEmails()) {
      await extendLock(); // a large backlog can take longer than the lock's TTL
      for (const email of page) {
        try {
          const scheduledAt = new Date(email.scheduledAt);
          const result = await addEmailToQueue(email.id, scheduledAt);
          if (result !== 'completed') {
            queued++;
            if (scheduledAt.getTime() < now) overdue++;
            continue;
          }
          const jobResult = await getCompletedJobResult(email.id);
          if (wasSent(jobResult)) {
            const updated = await EmailService.updateEmailIfStatus(email.id, EmailService.PENDING_STATUSES, {
              status: 'SENT',
              sentAt: email.sentAt || new Date().toISOString(),
              errorMessage: null,
            });
            if (updated) repaired++;
          } else {
            logger.warn(`⚠️  Email ${email.id} is unsent but its job already finished; leaving it for review`);
          }
        } catch (error) {
          if (error instanceof JobActiveError) {
            queued++; // a worker is sending it right now
            continue;
          }
          failed++;
          logger.error(`❌ Failed to requeue email ${email.id}:`, error);
        }
      }
    }
  } catch (error) {
    logger.error('❌ Failed to load unsent emails for requeue:', error);
    return false;
  }

  logger.info(
    `✅ Requeue complete: ${queued} queued (${overdue} overdue, sending now), ${repaired} already sent and saved, ${failed} failed`
  );
  return true;
};
