import { Queue } from 'bullmq';
import redis, { describeRedisError, isConnectionError } from '../config/redis';
import { logger } from '../utils/logger';

export const EMAIL_QUEUE_NAME = 'email-queue';

/**
 * Job payload: only the email's ID. The worker reads everything else from the
 * row, which stays the source of truth (a cancelled or already-sent email is
 * skipped), and Redis doesn't hold a copy of every message body.
 */
export interface EmailJobData {
  emailId: string;
}

export const EMAIL_JOB_ATTEMPTS = 3;

/** The email's job is being processed right now, so it can't be replaced or removed. */
export class JobActiveError extends Error {
  constructor(emailId: string) {
    super(`Email ${emailId} is being processed right now`);
  }
}

export const emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: EMAIL_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
});

emailQueue.on('error', (error) => {
  // Its connection already reports an unreachable Redis, once per outage.
  if (isConnectionError(error)) return;
  logger.error(`❌ Email queue error: ${describeRedisError(error)}`);
});

export type AddJobResult = 'queued' | 'already-queued' | 'completed';

/**
 * Queue an email to be sent at `scheduledAt` (immediately if that's in the past).
 *
 * The job ID is always the email ID, so the same email can never be queued
 * twice. A failed job kept by BullMQ is replaced, so the email runs again (its
 * send lock still stops a second send). A completed job is left alone and
 * 'completed' is returned: it may have sent the email without saving SENT, and
 * running it again could send twice. Only an explicit retry of a FAILED email
 * passes `replaceCompleted`.
 */
export const addEmailToQueue = async (
  emailId: string,
  scheduledAt: Date,
  { replaceCompleted = false }: { replaceCompleted?: boolean } = {}
): Promise<AddJobResult> => {
  const existing = await emailQueue.getJob(emailId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'active') throw new JobActiveError(emailId);
    if (state === 'completed' && !replaceCompleted) return 'completed';
    if (state === 'completed' || state === 'failed') {
      try {
        await existing.remove();
      } catch (error) {
        if ((await existing.getState()) === 'active') throw new JobActiveError(emailId);
        throw error;
      }
    } else if (state !== 'unknown') {
      logger.info(`ℹ️  Email ${emailId} already queued (${state})`);
      return 'already-queued';
    }
  }

  const delay = Math.max(0, scheduledAt.getTime() - Date.now());
  // Adding with an existing ID is a no-op in BullMQ, so a job another process
  // added in the meantime is kept rather than duplicated.
  await emailQueue.add('send-email', { emailId }, { delay, jobId: emailId });
  logger.info(`📧 Email job ${emailId} queued with delay ${delay}ms`);
  return 'queued';
};

/** What a completed job returned, or undefined if there is no completed job. */
export const getCompletedJobResult = async (emailId: string): Promise<unknown> => {
  const job = await emailQueue.getJob(emailId);
  if (!job || (await job.getState()) !== 'completed') return undefined;
  return job.returnvalue ?? null;
};

export type RemoveJobResult = 'removed' | 'not_found' | 'active' | 'completed';

/**
 * Remove an email's waiting job. Returns 'active' if a worker is sending it
 * right now and 'completed' if the job already finished (the email was most
 * likely sent); neither is removed.
 */
export const removeEmailFromQueue = async (emailId: string): Promise<RemoveJobResult> => {
  const job = await emailQueue.getJob(emailId);
  if (!job) return 'not_found';
  const state = await job.getState();
  if (state === 'active') return 'active';
  if (state === 'completed') return 'completed';

  try {
    await job.remove();
  } catch (error) {
    // It became active between the check and the removal.
    if ((await job.getState()) === 'active') return 'active';
    throw error;
  }
  logger.info(`🗑️  Job ${emailId} removed from queue`);
  return 'removed';
};

export const closeQueue = async (): Promise<void> => {
  await emailQueue.close();
  logger.info('✅ Email queue closed');
};

export default emailQueue;
