import { Request, Response } from 'express';
import { z } from 'zod';
import { withTimeout } from '../config/redis';
import { getAuthUser } from '../middlewares/auth.middleware';
import { addEmailToQueue, JobActiveError, removeEmailFromQueue } from '../queues/emailQueue';
import * as EmailService from '../services/email.service';
import * as EmailLogService from '../services/emailLog.service';
import * as SenderService from '../services/sender.service';
import { logger } from '../utils/logger';
import {
  ALLOWED_SMTP_PORTS,
  SmtpHostLookupError,
  SmtpHostNotAllowedError,
  resolveSmtpHost,
} from '../utils/smtpHost';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Small tolerance so a time picked "now" in the browser isn't rejected by clock skew. */
const PAST_TOLERANCE_MS = 2 * 60 * 1000;
const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 3600 * 1000;
const MAX_BULK_RECIPIENTS = 500;
const QUEUE_TIMEOUT_MS = 5000;

// Bulk requests can take a while; at most this many recipients are scheduled at once.
const BULK_CONCURRENCY = 10;

/**
 * `now` is fixed per request, so in a long bulk request the last recipients
 * are judged against the same time as the first.
 */
const scheduledAtSchemaAt = (now: number) =>
  z
    .string()
    .datetime({ offset: true })
    .refine((value) => new Date(value).getTime() >= now - PAST_TOLERANCE_MS, {
      message: 'scheduledAt must not be in the past',
    })
    .refine((value) => new Date(value).getTime() <= now + MAX_SCHEDULE_AHEAD_MS, {
      message: 'scheduledAt must be within one year',
    });

const contentSchema = {
  subject: z.string().trim().min(1).max(998),
  body: z.string().trim().min(1).max(500_000),
  htmlBody: z.string().max(1_000_000).optional(),
};

const recipientSchemaAt = (now: number) => ({
  recipientEmail: z.string().trim().email(),
  recipientName: z.string().trim().max(200).optional(),
  scheduledAt: scheduledAtSchemaAt(now),
  idempotencyKey: z.string().trim().min(1).max(320).optional(),
});

const scheduleEmailSchemaAt = (now: number) =>
  z.object({
    senderId: z.string().uuid(),
    ...contentSchema,
    ...recipientSchemaAt(now),
  });

const bulkRecipientSchemaAt = (now: number) => z.object(recipientSchemaAt(now));

// Recipients are validated one by one, so one bad address doesn't reject the whole batch.
const bulkScheduleSchema = z.object({
  senderId: z.string().uuid(),
  ...contentSchema,
  recipients: z.array(z.unknown()).min(1).max(MAX_BULK_RECIPIENTS),
});

const describeRecipient = (raw: unknown): string =>
  typeof raw === 'object' && raw !== null && typeof (raw as any).recipientEmail === 'string'
    ? (raw as any).recipientEmail
    : String(raw);

const listEmailsQuerySchema = z.object({
  senderId: z.string().uuid().optional(),
  status: z
    .string()
    .optional()
    .transform((value) =>
      value ? value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : undefined
    )
    .pipe(z.array(z.enum(EmailService.EMAIL_STATUSES)).optional()),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const statsQuerySchema = z.object({
  // Minutes, as returned by the browser's Date#getTimezoneOffset (UTC minus local time).
  tzOffset: z.coerce.number().int().min(-840).max(840).default(0),
});

const idParamSchema = z.string().uuid();

const smtpFields = {
  // Empty or null clears it: the sender then uses the shared mail server.
  smtpHost: z.string().trim().max(255).nullable().optional(),
  smtpPort: z
    .number()
    .int()
    .refine((port) => (ALLOWED_SMTP_PORTS as readonly number[]).includes(port), {
      message: `smtpPort must be one of ${ALLOWED_SMTP_PORTS.join(', ')}`,
    })
    .optional(),
  smtpUser: z.string().trim().max(255).nullable().optional(),
  smtpPass: z.string().max(255).nullable().optional(),
};

const createSenderSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email(),
  ...smtpFields,
});

const updateSenderSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().optional(),
  ...smtpFields,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

class QueueUnavailableError extends Error {}

const parseId = (value: string | undefined, label: string): string => {
  const result = idParamSchema.safeParse(value);
  if (!result.success) throw new HttpError(400, `Invalid ${label}`);
  return result.data;
};

const sendError = (res: Response, error: unknown, fallback: string) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ success: false, error: 'Validation error', details: error.errors });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ success: false, error: error.message });
    return;
  }
  logger.error(`❌ ${fallback}:`, error);
  res.status(500).json({ success: false, error: fallback });
};

/**
 * Senders on the server's shared SMTP account may only send as the user's own
 * (Google-verified) address. Senders with their own SMTP account are trusted to
 * the extent that account lets them.
 */
const assertSenderAllowed = async (
  data: { email: string; smtpHost?: string | null; smtpUser?: string | null; smtpPass?: string | null },
  userEmail: string
) => {
  const hasOwnSmtp = Boolean(data.smtpHost);
  if (hasOwnSmtp && (!data.smtpUser || !data.smtpPass)) {
    throw new HttpError(
      400,
      'smtpUser and smtpPass are required when smtpHost is set (or clear smtpHost to use the shared mail server)'
    );
  }
  if (!hasOwnSmtp && data.email.toLowerCase() !== userEmail.toLowerCase()) {
    throw new HttpError(
      400,
      'Without your own SMTP server, the sender email must be your account email'
    );
  }
  if (data.smtpHost) {
    // Early, friendly check. The worker checks again right before connecting,
    // since the host's DNS can change after this.
    try {
      await resolveSmtpHost(data.smtpHost);
    } catch (error) {
      if (error instanceof SmtpHostNotAllowedError || error instanceof SmtpHostLookupError) {
        throw new HttpError(400, error.message);
      }
      throw error;
    }
  }
};

/** A second sender on the shared SMTP account (blocked by a unique index). */
const SHARED_SENDER_EXISTS = 'You already have a sender that uses the shared mail server';

const queueEmail = async (email: EmailService.Email, options?: { replaceCompleted?: boolean }) => {
  try {
    return await withTimeout(
      addEmailToQueue(email.id, new Date(email.scheduledAt), options),
      QUEUE_TIMEOUT_MS,
      'Queue did not respond in time'
    );
  } catch (error) {
    if (error instanceof JobActiveError) throw error;
    logger.error(`❌ Failed to queue email ${email.id}:`, error);
    throw new QueueUnavailableError((error as Error).message);
  }
};

/**
 * The idempotency key was used before. The earlier email must be the same
 * message (same sender and recipient), and only counts as done if it is still
 * on its way or was sent; a failed one is reported as failed.
 */
const reuseExisting = async (
  existing: EmailService.Email,
  senderId: string,
  recipientEmail: string
): Promise<{ email: EmailService.Email; created: false }> => {
  if (
    existing.senderId !== senderId ||
    existing.recipientEmail.toLowerCase() !== recipientEmail.trim().toLowerCase()
  ) {
    throw new HttpError(409, 'This idempotency key was already used for a different email');
  }
  if (existing.status === 'FAILED') {
    throw new HttpError(409, 'This email was already tried and failed; retry it from the Failed folder');
  }
  if (EmailService.PENDING_STATUSES.includes(existing.status)) {
    // An unsent email must have a job; queueing again is a no-op if it does.
    try {
      await queueEmail(existing);
    } catch (error) {
      if (!(error instanceof JobActiveError)) throw error;
    }
  }
  return { email: existing, created: false };
};

interface ScheduleInput {
  recipientEmail: string;
  recipientName?: string;
  subject: string;
  body: string;
  htmlBody?: string;
  scheduledAt: string;
  idempotencyKey?: string;
}

/**
 * Create and queue one email. Returns the existing email instead if the
 * idempotency key was already used by this user.
 */
const scheduleOne = async (
  userId: string,
  senderId: string,
  input: ScheduleInput
): Promise<{ email: EmailService.Email; created: boolean }> => {
  const scopedKey = input.idempotencyKey
    ? EmailService.scopeIdempotencyKey(userId, input.idempotencyKey)
    : undefined;

  if (scopedKey) {
    const existing = await EmailService.getEmailByIdempotencyKey(scopedKey);
    if (existing) return reuseExisting(existing, senderId, input.recipientEmail);
  }

  let email: EmailService.Email;
  try {
    email = await EmailService.createEmail({
      ...input,
      senderId,
      scheduledAt: new Date(input.scheduledAt).toISOString(),
      idempotencyKey: scopedKey,
    });
  } catch (error: any) {
    // Two requests with the same key raced; the other one won.
    if (scopedKey && error?.code === EmailService.UNIQUE_VIOLATION) {
      const existing = await EmailService.getEmailByIdempotencyKey(scopedKey);
      if (existing) return reuseExisting(existing, senderId, input.recipientEmail);
    }
    // The sender was deleted between the ownership check and the insert.
    if (error?.code === EmailService.FOREIGN_KEY_VIOLATION) throw new HttpError(404, 'Sender not found');
    throw error;
  }

  try {
    await queueEmail(email);
  } catch (error) {
    // Don't leave a row that looks scheduled but will never be sent. Deleting it
    // (rather than marking it FAILED) lets the client retry with the same key.
    try {
      await EmailService.deleteEmail(email.id);
    } catch {
      // Couldn't delete it either: mark it FAILED so it shows up in Failed and
      // can be retried, instead of sitting in Scheduled with no job.
      await markUnqueued(email.id, 'Could not be queued for sending');
    }
    throw error;
  }

  await EmailLogService.tryCreateEmailLog({
    emailId: email.id,
    status: 'SCHEDULED',
    message: 'Email scheduled successfully',
  });

  return { email, created: true };
};

/**
 * Last resort when a row is SCHEDULED but has no job and couldn't be fixed
 * otherwise. If even this fails, the startup requeue picks the row up.
 */
const markUnqueued = async (emailId: string, message: string) => {
  try {
    await EmailService.updateEmailIfStatus(emailId, ['SCHEDULED'], { status: 'FAILED', errorMessage: message });
  } catch (error) {
    logger.error(`❌ Email ${emailId} is scheduled without a job and could not be marked failed:`, error);
  }
};

/** Load an email and check it belongs to one of the user's senders. */
const getOwnedEmail = async (emailId: string, userId: string) => {
  const email = await EmailService.getEmailById(emailId);
  if (!email) throw new HttpError(404, 'Email not found');

  const sender = await SenderService.getSenderById(email.senderId, userId);
  if (!sender) throw new HttpError(404, 'Email not found');

  return email;
};

const getOwnedSender = async (senderId: string, userId: string) => {
  const sender = await SenderService.getSenderById(senderId, userId);
  if (!sender) throw new HttpError(404, 'Sender not found');
  return sender;
};

// ---------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------

/** POST /api/emails/schedule */
export const scheduleEmailController = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = getAuthUser(req);
    const { senderId, ...input } = scheduleEmailSchemaAt(Date.now()).parse(req.body);
    await getOwnedSender(senderId, userId);

    const { email, created } = await scheduleOne(userId, senderId, input);

    res.status(created ? 201 : 200).json({
      success: true,
      message: created
        ? 'Email scheduled successfully'
        : email.status === 'SENT'
          ? 'Email already sent'
          : 'Email already scheduled',
      data: { email },
    });
  } catch (error) {
    if (error instanceof QueueUnavailableError) {
      res.status(503).json({ success: false, error: 'Email queue is unavailable, please try again' });
      return;
    }
    sendError(res, error, 'Failed to schedule email');
  }
};

/**
 * Schedule the same message to many recipients in one request.
 * Each recipient carries its own time, so the client controls the spacing.
 * POST /api/emails/schedule/bulk
 */
export const bulkScheduleEmailController = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = getAuthUser(req);
    // One "now" for the whole request, taken before any slow work.
    const recipientSchema = bulkRecipientSchemaAt(Date.now());
    const { senderId, recipients, ...content } = bulkScheduleSchema.parse(req.body);
    await getOwnedSender(senderId, userId);

    // Validate every recipient first; it's fast and doesn't depend on how long scheduling takes.
    type Outcome = { email: EmailService.Email } | { recipientEmail: string; error: string };
    const outcomes: (Outcome | undefined)[] = new Array(recipients.length);
    const valid: { index: number; recipient: z.infer<typeof recipientSchema> }[] = [];
    recipients.forEach((raw, index) => {
      const parsed = recipientSchema.safeParse(raw);
      if (parsed.success) {
        valid.push({ index, recipient: parsed.data });
      } else {
        const issue = parsed.error.errors[0];
        outcomes[index] = {
          recipientEmail: describeRecipient(raw),
          error: `Invalid ${issue?.path.join('.') || 'recipient'}: ${issue?.message ?? 'invalid'}`,
        };
      }
    });

    // Schedule several at a time, keeping results in the request's order.
    let queueDown = false;
    let serverError = false;
    let next = 0;
    const runner = async () => {
      while (next < valid.length) {
        const { index, recipient } = valid[next++];
        if (queueDown) {
          outcomes[index] = { recipientEmail: recipient.recipientEmail, error: 'Email queue is unavailable' };
          continue;
        }
        try {
          const { email } = await scheduleOne(userId, senderId, { ...content, ...recipient });
          outcomes[index] = { email };
        } catch (error) {
          if (error instanceof QueueUnavailableError) queueDown = true;
          else if (!(error instanceof HttpError) || error.status >= 500) {
            serverError = true;
            logger.error('❌ Bulk schedule item failed:', error);
          }
          outcomes[index] = {
            recipientEmail: recipient.recipientEmail,
            error:
              error instanceof QueueUnavailableError
                ? 'Email queue is unavailable'
                : error instanceof HttpError
                  ? error.message
                  : 'Failed to schedule',
          };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, valid.length) }, runner));

    const scheduled: EmailService.Email[] = [];
    const failed: { recipientEmail: string; error: string }[] = [];
    for (const outcome of outcomes) {
      if (!outcome) continue;
      if ('email' in outcome) scheduled.push(outcome.email);
      else failed.push(outcome);
    }

    // All failed: 503 if the queue was down, 500 if anything failed on our side,
    // otherwise every failure was the request's fault (invalid or conflicting) -> 400.
    const status =
      failed.length === 0
        ? 201
        : scheduled.length > 0
          ? 207
          : queueDown
            ? 503
            : serverError
              ? 500
              : 400;
    res.status(status).json({
      success: failed.length === 0,
      message: `${scheduled.length} of ${recipients.length} emails scheduled`,
      error: failed.length > 0 ? `${failed.length} emails could not be scheduled` : undefined,
      data: { scheduled, failed },
    });
  } catch (error) {
    sendError(res, error, 'Failed to schedule emails');
  }
};

/** GET /api/emails?status=SENT,FAILED&page=1&limit=50&order=desc */
export const getEmailsController = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = getAuthUser(req);
    const query = listEmailsQuerySchema.parse(req.query);

    let senderIds: string[];
    if (query.senderId) {
      await getOwnedSender(query.senderId, userId);
      senderIds = [query.senderId];
    } else {
      senderIds = await SenderService.getSenderIdsByUserId(userId);
    }

    const offset = query.offset ?? (query.page - 1) * query.limit;
    const { emails, total } = await EmailService.listEmails({
      senderIds,
      statuses: query.status,
      limit: query.limit,
      offset,
      order: query.order,
    });

    res.json({
      success: true,
      data: {
        data: emails,
        total,
        page: Math.floor(offset / query.limit) + 1,
        pageSize: query.limit,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    });
  } catch (error) {
    sendError(res, error, 'Failed to get emails');
  }
};

/** GET /api/emails/stats?tzOffset=-330 */
export const getEmailStatsController = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = getAuthUser(req);
    const { tzOffset } = statsQuerySchema.parse(req.query);
    const senderIds = await SenderService.getSenderIdsByUserId(userId);

    // Midnight today in the user's timezone, as a UTC instant.
    const offsetMs = tzOffset * 60 * 1000;
    const localNow = new Date(Date.now() - offsetMs);
    localNow.setUTCHours(0, 0, 0, 0);
    const startOfToday = new Date(localNow.getTime() + offsetMs);
    const startOfTomorrow = new Date(startOfToday.getTime() + 24 * 3600 * 1000);

    const [totalScheduled, totalSent, totalFailed, pendingToday] = await Promise.all([
      EmailService.countEmails({ senderIds, statuses: EmailService.PENDING_STATUSES }),
      EmailService.countEmails({ senderIds, statuses: ['SENT'] }),
      EmailService.countEmails({ senderIds, statuses: ['FAILED'] }),
      EmailService.countEmails({
        senderIds,
        statuses: EmailService.PENDING_STATUSES,
        scheduledFrom: startOfToday,
        scheduledBefore: startOfTomorrow,
      }),
    ]);

    res.json({ success: true, data: { totalScheduled, totalSent, totalFailed, pendingToday } });
  } catch (error) {
    sendError(res, error, 'Failed to get stats');
  }
};

/** GET /api/emails/:emailId */
export const getEmailController = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = getAuthUser(req);
    const email = await getOwnedEmail(parseId(req.params.emailId, 'email ID'), userId);
    const logs = await EmailLogService.getEmailLogs(email.id);
    res.json({ success: true, data: { email, logs } });
  } catch (error) {
    sendError(res, error, 'Failed to get email');
  }
};

/**
 * Cancel an unsent email: remove its queued job, then delete it.
 * DELETE /api/emails/:emailId
 */
export const cancelEmailController = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = getAuthUser(req);
    const email = await getOwnedEmail(parseId(req.params.emailId, 'email ID'), userId);

    if (!EmailService.PENDING_STATUSES.includes(email.status)) {
      throw new HttpError(409, `A ${email.status.toLowerCase()} email can't be cancelled`);
    }

    let removal;
    const pendingRemoval = removeEmailFromQueue(email.id);
    try {
      removal = await withTimeout(pendingRemoval, QUEUE_TIMEOUT_MS, 'Queue timeout');
    } catch (error) {
      logger.error(`❌ Could not reach the queue to cancel ${email.id}:`, error);
      // The queue's connection holds commands while Redis is down, so the timed-out
      // removal can still run once Redis is back. The user was told the cancel
      // failed, so if it does remove the job, put the job back for the email that
      // still exists.
      pendingRemoval
        .then(async (late) => {
          if (late !== 'removed') return;
          const current = await EmailService.getEmailById(email.id);
          if (!current || !EmailService.PENDING_STATUSES.includes(current.status)) return;
          logger.warn(`↩️  A late cancel removed the job of email ${email.id}; queuing it again`);
          try {
            await queueEmail(current);
          } catch (requeueError) {
            if (!(requeueError instanceof JobActiveError)) {
              await markUnqueued(email.id, 'Cancelling failed part-way; retry or cancel it again');
            }
          }
        })
        .catch((lateError) => logger.error(`❌ Late cancel of email ${email.id} failed:`, lateError));
      res.status(503).json({ success: false, error: 'Email queue is unavailable, please try again' });
      return;
    }
    if (removal === 'active') {
      throw new HttpError(409, 'This email is being sent right now and can no longer be cancelled');
    }
    if (removal === 'completed') {
      throw new HttpError(409, 'This email was already sent; refresh to see its status');
    }

    // Delete only while still unsent: the worker may have sent it since it was read.
    // Deleting the row also stops any older job for it: the worker skips missing emails.
    let deleted: boolean;
    try {
      deleted = await EmailService.deleteEmailIfStatus(email.id, EmailService.PENDING_STATUSES);
    } catch (error) {
      // The job is gone but the row isn't: put the job back so the email still
      // sends as scheduled, and let the user try cancelling again.
      try {
        await queueEmail(email);
      } catch (requeueError) {
        if (!(requeueError instanceof JobActiveError)) {
          await markUnqueued(email.id, 'Cancelling failed part-way; retry or cancel it again');
        }
      }
      throw error;
    }
    if (!deleted) {
      throw new HttpError(409, 'This email was already sent or removed; refresh to see its status');
    }
    logger.info(`✅ Email cancelled: ${email.id}`);

    res.json({ success: true, message: 'Email cancelled successfully' });
  } catch (error) {
    sendError(res, error, 'Failed to cancel email');
  }
};

/**
 * Send a failed email again, now.
 * POST /api/emails/:emailId/retry
 */
export const retryEmailController = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = getAuthUser(req);
    const email = await getOwnedEmail(parseId(req.params.emailId, 'email ID'), userId);

    if (email.status !== 'FAILED') {
      throw new HttpError(409, 'Only failed emails can be retried');
    }

    // The row must say SCHEDULED before the job exists, or the worker would
    // skip it as FAILED. Only a row that is still FAILED is changed, so two
    // clicks can't queue it twice.
    const updated = await EmailService.updateEmailIfStatus(email.id, ['FAILED'], {
      status: 'SCHEDULED',
      errorMessage: null,
      attemptCount: 0,
      scheduledAt: new Date().toISOString(),
    });
    if (!updated) throw new HttpError(409, 'This email is no longer failed; refresh to see its status');

    try {
      await queueEmail(updated, { replaceCompleted: true });
    } catch (error) {
      // Put every field back as it was, unless the row moved on meanwhile.
      try {
        await EmailService.updateEmailIfStatus(email.id, ['SCHEDULED'], {
          status: 'FAILED',
          errorMessage: email.errorMessage ?? 'Could not be queued for sending',
          attemptCount: email.attemptCount,
          scheduledAt: email.scheduledAt,
        });
      } catch (rollbackError) {
        // The row stays SCHEDULED without a job; it is requeued on the next restart.
        logger.error(`❌ Could not restore email ${email.id} after a failed retry:`, rollbackError);
      }
      if (error instanceof JobActiveError) {
        throw new HttpError(409, 'The last attempt is still finishing; try again in a moment');
      }
      res.status(503).json({ success: false, error: 'Email queue is unavailable, please try again' });
      return;
    }

    await EmailLogService.tryCreateEmailLog({
      emailId: email.id,
      status: 'SCHEDULED',
      message: 'Retry requested',
    });

    res.json({ success: true, message: 'Email queued for retry', data: { email: updated } });
  } catch (error) {
    sendError(res, error, 'Failed to retry email');
  }
};

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------

/**
 * Lists the user's senders, creating the default one if it's missing
 * (for example if that failed during sign-in).
 * GET /api/emails/senders
 */
export const getSendersController = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId, email } = getAuthUser(req);
    const senders = await SenderService.ensureDefaultSender(userId, email);
    res.json({
      success: true,
      data: { senders: senders.map(SenderService.toPublicSender), count: senders.length },
    });
  } catch (error) {
    sendError(res, error, 'Failed to get senders');
  }
};

/** POST /api/emails/senders */
export const createSenderController = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId, email: userEmail } = getAuthUser(req);
    const data = createSenderSchema.parse(req.body);
    await assertSenderAllowed(data, userEmail);

    let sender;
    try {
      sender = await SenderService.createSender({ ...data, userId });
    } catch (error: any) {
      if (error?.code === EmailService.UNIQUE_VIOLATION) throw new HttpError(409, SHARED_SENDER_EXISTS);
      throw error;
    }
    logger.info(`✅ Sender created: ${sender.id}`);

    res.status(201).json({
      success: true,
      message: 'Sender created successfully',
      data: { sender: SenderService.toPublicSender(sender) },
    });
  } catch (error) {
    sendError(res, error, 'Failed to create sender');
  }
};

/** PUT /api/emails/senders/:senderId */
export const updateSenderController = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId, email: userEmail } = getAuthUser(req);
    const senderId = parseId(req.params.senderId, 'sender ID');
    const data = updateSenderSchema.parse(req.body);
    const current = await getOwnedSender(senderId, userId);

    // Only re-check the sending rules when what they cover changes, so an old
    // sender that breaks a newer rule can still be renamed.
    const changesSending = (['email', 'smtpHost', 'smtpPort', 'smtpUser', 'smtpPass'] as const).some(
      (field) => data[field] !== undefined
    );
    if (changesSending) {
      await assertSenderAllowed(
        {
          email: data.email ?? current.email,
          smtpHost: data.smtpHost !== undefined ? data.smtpHost : current.smtpHost,
          smtpUser: data.smtpUser !== undefined ? data.smtpUser : current.smtpUser,
          smtpPass: data.smtpPass !== undefined ? data.smtpPass : current.smtpPass,
        },
        userEmail
      );
    }

    let sender;
    try {
      sender = await SenderService.updateSender(senderId, userId, data);
    } catch (error: any) {
      if (error?.code === EmailService.UNIQUE_VIOLATION) throw new HttpError(409, SHARED_SENDER_EXISTS);
      throw error;
    }
    logger.info(`✅ Sender updated: ${senderId}`);

    res.json({
      success: true,
      message: 'Sender updated successfully',
      data: { sender: SenderService.toPublicSender(sender) },
    });
  } catch (error) {
    sendError(res, error, 'Failed to update sender');
  }
};

/** DELETE /api/emails/senders/:senderId */
export const deleteSenderController = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = getAuthUser(req);
    const senderId = parseId(req.params.senderId, 'sender ID');
    await getOwnedSender(senderId, userId);

    const pending = await EmailService.countEmails({
      senderIds: [senderId],
      statuses: EmailService.PENDING_STATUSES,
    });
    if (pending > 0) {
      throw new HttpError(409, `Cancel this sender's ${pending} unsent emails before deleting it`);
    }

    // Emails reference their sender with ON DELETE RESTRICT, so the sender's
    // history goes first, and an email scheduled after the count above makes
    // the delete fail instead of being silently deleted with it.
    await EmailService.deleteFinishedEmailsBySender(senderId);
    try {
      await SenderService.deleteSender(senderId, userId);
    } catch (error: any) {
      if (error?.code === EmailService.FOREIGN_KEY_VIOLATION) {
        throw new HttpError(409, 'This sender has unsent emails; cancel them before deleting it');
      }
      throw error;
    }
    logger.info(`✅ Sender deleted: ${senderId}`);
    res.json({ success: true, message: 'Sender deleted successfully' });
  } catch (error) {
    sendError(res, error, 'Failed to delete sender');
  }
};
