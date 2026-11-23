import { DelayedError, Job, UnrecoverableError, Worker } from 'bullmq';
import { Transporter } from 'nodemailer';
import redis from '../config/redis';
import {
  SHARED_SMTP_HOST,
  SHARED_SMTP_USER,
  buildMailConfig,
  createMailTransporter,
  defaultTransporter,
  sendEmail,
} from '../config/mailer';
import { EMAIL_QUEUE_NAME, EmailJobData } from '../queues/emailQueue';
import * as EmailService from '../services/email.service';
import * as EmailLogService from '../services/emailLog.service';
import * as SenderService from '../services/sender.service';
import * as UserService from '../services/user.service';
import {
  SEND_LOCK_RETRY_MS,
  acquireSendLock,
  markSent,
  releaseRateLimit,
  releaseSendLock,
  reserveRateLimit,
} from '../services/rateLimit.service';
import { logger } from '../utils/logger';
import { SmtpHostNotAllowedError, assertSmtpPortAllowed, resolveSmtpHost } from '../utils/smtpHost';

const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '5', 10);
// Minimum gap between any two sends, across all workers (mimics provider throttling).
const MIN_DELAY_MS = parseInt(process.env.MIN_DELAY_BETWEEN_EMAILS_MS || '2000', 10);

const TRANSPORTER_CACHE_SIZE = 100;

/** Least recently used first (Map keeps insertion order). */
const transporterCache = new Map<string, { version: string; transporter: Transporter }>();

const cacheTransporter = (senderId: string, version: string, transporter: Transporter) => {
  const previous = transporterCache.get(senderId);
  if (previous) {
    transporterCache.delete(senderId);
    previous.transporter.close();
  }
  transporterCache.set(senderId, { version, transporter });
  if (transporterCache.size > TRANSPORTER_CACHE_SIZE) {
    const [oldestId, oldest] = transporterCache.entries().next().value!;
    transporterCache.delete(oldestId);
    oldest.transporter.close();
  }
};

/**
 * A sender without an SMTP host uses the server's shared account, and may only
 * send as its owner's own address (the API enforces this; rows from before it
 * did are checked here). A sender with a host must have complete settings.
 */
/**
 * Default senders made by the old sign-in code copied the shared account's host
 * and credentials into the row (with no user or password when those weren't
 * set). They mean "use the shared account", and the copied credentials may be
 * stale, so they are treated as shared. The 2026-11-23 migration clears them.
 */
const isLegacyDefaultSender = (sender: SenderService.Sender) =>
  sender.smtpHost?.toLowerCase() === SHARED_SMTP_HOST.toLowerCase() &&
  (!sender.smtpUser || !sender.smtpPass || sender.smtpUser === SHARED_SMTP_USER);

const transporterFor = async (sender: SenderService.Sender): Promise<Transporter> => {
  if (!sender.smtpHost || isLegacyDefaultSender(sender)) {
    const owner = await UserService.getUserById(sender.userId);
    if (!owner || owner.email.toLowerCase() !== sender.email.toLowerCase()) {
      // A legacy row for another address keeps its own (possibly incomplete) settings.
      if (sender.smtpHost) return customTransporter(sender, sender.smtpHost);
      throw new UnrecoverableError(
        'This sender uses the shared mail server, so its email must be your account email'
      );
    }
    return defaultTransporter;
  }
  return customTransporter(sender, sender.smtpHost);
};

const customTransporter = async (sender: SenderService.Sender, smtpHost: string): Promise<Transporter> => {
  if (!sender.smtpUser || !sender.smtpPass) {
    throw new UnrecoverableError("This sender's SMTP settings are incomplete: add the SMTP user and password");
  }

  const port = sender.smtpPort || 587;
  let address: string;
  try {
    assertSmtpPortAllowed(port);
    // Resolve and check here, then connect to that exact address, so a DNS
    // answer can't switch to a private address between the check and the send.
    address = await resolveSmtpHost(smtpHost);
  } catch (error) {
    if (error instanceof SmtpHostNotAllowedError) throw new UnrecoverableError(error.message);
    throw error;
  }

  const version = `${sender.updatedAt}|${address}`;
  const cached = transporterCache.get(sender.id);
  if (cached && cached.version === version) {
    // Mark as recently used.
    transporterCache.delete(sender.id);
    transporterCache.set(sender.id, cached);
    return cached.transporter;
  }

  const transporter = createMailTransporter(
    buildMailConfig(address, port, sender.smtpUser, sender.smtpPass, smtpHost)
  );
  cacheTransporter(sender.id, version, transporter);
  return transporter;
};

/**
 * The email went out (and Redis knows it) but the SENT status couldn't be
 * saved. Thrown so BullMQ runs the job again: that run sees the 'sent' lock
 * and only repairs the row. Never recorded as a send failure.
 */
class SentButNotSavedError extends Error {}

const isFinalAttempt = (job: Job, error: unknown) =>
  error instanceof UnrecoverableError || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

/** Mark the email RETRYING or FAILED, unless it's no longer pending (sent, cancelled). */
const recordFailure = async (job: Job<EmailJobData>, error: Error) => {
  const { emailId } = job.data;
  const final = isFinalAttempt(job, error);
  const status = final ? 'FAILED' : 'RETRYING';
  let updated;
  try {
    updated = await EmailService.updateEmailIfStatus(emailId, EmailService.PENDING_STATUSES, {
      status,
      errorMessage: error.message,
      attemptCount: job.attemptsMade + 1,
    });
  } catch {
    // Already logged by the service. The row stays pending and is requeued on restart.
    return;
  }
  if (!updated) return;
  await EmailLogService.tryCreateEmailLog({
    emailId,
    status,
    message: final
      ? `Send failed permanently: ${error.message}`
      : `Attempt ${job.attemptsMade + 1} failed, will retry: ${error.message}`,
  });
};

const SAVE_SENT_ATTEMPTS = 3;

/** Save SENT, retrying briefly. Only touches a row that is still pending. */
const saveSent = async (emailId: string, sentAt: string, attemptCount?: number): Promise<boolean> => {
  for (let attempt = 1; attempt <= SAVE_SENT_ATTEMPTS; attempt++) {
    try {
      await EmailService.updateEmailIfStatus(emailId, EmailService.PENDING_STATUSES, {
        status: 'SENT',
        sentAt,
        errorMessage: null,
        ...(attemptCount !== undefined ? { attemptCount } : {}),
      });
      return true;
    } catch {
      // already logged by the service
      if (attempt < SAVE_SENT_ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
  return false;
};

const MARK_SENT_ATTEMPTS = 3;

/** Record the send in Redis, retrying a transient failure. False if it never worked. */
const markSentWithRetry = async (emailId: string, options?: { untilSaved?: boolean }): Promise<boolean> => {
  for (let attempt = 1; attempt <= MARK_SENT_ATTEMPTS; attempt++) {
    if (await markSent(emailId, options)) return true;
    if (attempt < MARK_SENT_ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 500));
  }
  return false;
};

const REPAIR_INTERVAL_MS = 30 * 1000;
const REPAIR_ATTEMPTS = 120; // an hour

/**
 * Keep trying to record a send that neither Redis nor the database saved.
 *
 * First a 'sent' marker that doesn't expire, so no later job can send the email
 * again; it is kept trying for as long as the process runs, since the completed
 * job's result is trimmed by BullMQ and can't be relied on. Then the SENT status;
 * once saved, the marker is given its normal expiry. If saving keeps failing for
 * an hour, the marker stays, and the startup requeue's job sees it and only
 * saves SENT.
 */
const repairInBackground = (emailId: string, sentAt: string, attemptCount: number) => {
  let marked = false;
  let saveTries = 0;
  const attempt = async () => {
    if (!marked) marked = await markSent(emailId, { untilSaved: true });
    if (marked) {
      saveTries++;
      if (await saveSent(emailId, sentAt, attemptCount)) {
        await markSent(emailId);
        logger.info(`✅ Saved the SENT status of email ${emailId}`);
        return;
      }
      if (saveTries >= REPAIR_ATTEMPTS) {
        logger.error(`❌ Gave up saving the SENT status of email ${emailId}; its 'sent' marker stops a resend and the startup requeue will save it`);
        return;
      }
    }
    setTimeout(attempt, REPAIR_INTERVAL_MS).unref();
  };
  // The job is being completed, which needs Redis, so the marker usually works right away.
  setTimeout(attempt, 1000).unref();
};

const sendEmailJob = async (job: Job<EmailJobData>, token?: string) => {
  const { emailId } = job.data;
  logger.info(`🔄 Processing job ${job.id} for email ${emailId}`);

  // The row is the source of truth: skip emails that were cancelled or already sent.
  const email = await EmailService.getEmailById(emailId);
  if (!email) {
    logger.info(`⏭️  Email ${emailId} no longer exists (cancelled), skipping`);
    return { skipped: 'deleted' };
  }
  if (!EmailService.PENDING_STATUSES.includes(email.status)) {
    logger.info(`⏭️  Email ${emailId} is ${email.status}, skipping`);
    return { skipped: email.status };
  }

  const sender = await SenderService.getSenderById(email.senderId);
  if (!sender) throw new UnrecoverableError(`Sender ${email.senderId} not found`);

  const lock = await acquireSendLock(emailId);
  if (lock === 'sent') {
    // An earlier run sent it but couldn't save SENT. Repair the row; never send twice.
    logger.warn(`⏭️  Email ${emailId} was already sent, saving its SENT status`);
    if (!(await saveSent(emailId, email.sentAt || new Date().toISOString()))) {
      throw new SentButNotSavedError(`Email ${emailId} was sent but its status could not be saved`);
    }
    // The marker may have been set not to expire until this was saved.
    await markSent(emailId);
    await EmailLogService.tryCreateEmailLog({ emailId, status: 'SENT', message: 'Email was already sent' });
    return { skipped: 'already-sent' };
  }
  if (lock === 'busy') {
    // Another job holds the lock, or a crashed one does until it expires. Check
    // again later rather than completing: if that job never finishes, this one sends.
    logger.warn(`⏳ Email ${emailId} is locked by another job, checking again later`);
    await job.moveToDelayed(Date.now() + SEND_LOCK_RETRY_MS, token);
    throw new DelayedError();
  }

  let reservationKey: string | undefined;
  let info;
  try {
    const reservation = await reserveRateLimit(sender.id);
    if (!reservation.allowed) {
      // Wait for the next hour window without using up a retry attempt.
      await releaseSendLock(emailId);
      logger.warn(
        `⚠️  Sender ${sender.id} reached ${reservation.limit}/hour; email ${emailId} moved to ${reservation.resetAt.toISOString()}`
      );
      try {
        await EmailService.updateEmailIfStatus(emailId, EmailService.PENDING_STATUSES, {
          status: 'RETRYING',
          errorMessage: `Hourly sending limit reached; rescheduled to ${reservation.resetAt.toISOString()}`,
        });
      } catch {
        // already logged by the service
      }
      await job.moveToDelayed(reservation.resetAt.getTime(), token);
      throw new DelayedError();
    }
    reservationKey = reservation.key;

    info = await sendEmail(
      {
        from: `"${(sender.name || 'Email Scheduler').replace(/"/g, '')}" <${sender.email}>`,
        to: email.recipientEmail,
        subject: email.subject,
        text: email.body,
        html: email.htmlBody || undefined,
      },
      await transporterFor(sender)
    );
  } catch (error) {
    if (error instanceof DelayedError) throw error;
    if (reservationKey) await releaseRateLimit(reservationKey);
    await releaseSendLock(emailId);
    throw error;
  }

  // The email has gone out. From here on, it must never be sent again.
  const sentAt = new Date().toISOString();
  // The marker doesn't expire until SENT is saved: if saving fails for longer
  // than a week, a rerun must still see that the email went out.
  const marked = await markSentWithRetry(emailId, { untilSaved: true });
  if (!(await saveSent(emailId, sentAt, job.attemptsMade + 1))) {
    logger.error(`❌ Email ${emailId} was sent but its status could not be saved`);
    // Redis knows it was sent: a rerun sees the 'sent' lock and only repairs the row.
    if (marked) throw new SentButNotSavedError(`Email ${emailId} was sent but its status could not be saved`);
    // Neither Redis nor the database recorded it, so a rerun could send again.
    // Complete the job instead: its result ({ success: true }) is the record,
    // and the startup requeue saves SENT for it rather than running it again.
    // Meanwhile keep trying to save SENT in the background.
    repairInBackground(emailId, sentAt, job.attemptsMade + 1);
    return { success: true, emailId, messageId: info.messageId, statusSaved: false };
  }
  if (marked) await markSent(emailId);
  await EmailLogService.tryCreateEmailLog({
    emailId,
    status: 'SENT',
    message: `Email sent successfully. Message ID: ${info.messageId}`,
  });

  logger.info(`✅ Email ${emailId} sent to ${email.recipientEmail}`);
  return { success: true, emailId, messageId: info.messageId };
};

/**
 * Every failure, wherever it happens (Supabase, Redis, SMTP), is recorded on the
 * row, so an email whose job has failed for good shows as FAILED and can be
 * retried instead of looking scheduled forever.
 */
const processEmailJob = async (job: Job<EmailJobData>, token?: string) => {
  try {
    return await sendEmailJob(job, token);
  } catch (error) {
    if (error instanceof DelayedError || error instanceof SentButNotSavedError) throw error;
    logger.error(`❌ Failed to send email ${job.data.emailId}:`, error);
    await recordFailure(job, error as Error);
    throw error;
  }
};

let worker: Worker<EmailJobData> | null = null;

/** Start the worker. Call once per process that should send email. */
export const startEmailWorker = (): Worker<EmailJobData> => {
  if (worker) return worker;

  worker = new Worker<EmailJobData>(EMAIL_QUEUE_NAME, processEmailJob, {
    connection: redis,
    concurrency: WORKER_CONCURRENCY,
    // The limiter is enforced through Redis, so it spaces sends across all workers.
    limiter: MIN_DELAY_MS > 0 ? { max: 1, duration: MIN_DELAY_MS } : { max: 10, duration: 1000 },
  });

  worker.on('ready', () => logger.info(`🚀 Email worker started (concurrency ${WORKER_CONCURRENCY})`));
  worker.on('completed', (job) => logger.info(`✅ Worker completed job ${job.id}`));
  worker.on('failed', (job, error) => logger.error(`❌ Worker failed job ${job?.id}: ${error.message}`));
  worker.on('error', (error) => logger.error('❌ Worker error:', error));

  return worker;
};

export const closeWorker = async (): Promise<void> => {
  if (!worker) return;
  await worker.close();
  worker = null;
  logger.info('✅ Email worker closed');
};
