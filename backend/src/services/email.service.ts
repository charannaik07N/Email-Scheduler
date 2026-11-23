import { supabaseServiceClient } from '../config/supabase';
import { logger } from '../utils/logger';

export const EMAIL_STATUSES = ['SCHEDULED', 'RETRYING', 'SENT', 'FAILED'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/** Statuses of an email that hasn't been sent yet and can still be cancelled. */
export const PENDING_STATUSES: EmailStatus[] = ['SCHEDULED', 'RETRYING'];

export interface Email {
  id: string;
  senderId: string;
  recipientEmail: string;
  recipientName?: string | null;
  subject: string;
  body: string;
  htmlBody?: string | null;
  scheduledAt: string;
  sentAt?: string | null;
  status: EmailStatus;
  attemptCount: number;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
}

const NO_ROWS = 'PGRST116';
export const UNIQUE_VIOLATION = '23505';
export const FOREIGN_KEY_VIOLATION = '23503';

const transformEmailFromDB = (row: any): Email => ({
  id: row.id,
  senderId: row.sender_id,
  recipientEmail: row.recipient_email,
  recipientName: row.recipient_name,
  subject: row.subject,
  body: row.body,
  htmlBody: row.html_body,
  scheduledAt: row.scheduled_at,
  sentAt: row.sent_at,
  status: row.status,
  attemptCount: row.attempt_count ?? 0,
  errorMessage: row.error_message,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Idempotency keys are unique across the whole table, so they are stored
 * prefixed with the owner's user ID. Two users can then use the same key
 * without seeing (or blocking) each other's emails.
 */
export const scopeIdempotencyKey = (userId: string, key: string) => `${userId}:${key}`;

export interface CreateEmailData {
  senderId: string;
  recipientEmail: string;
  recipientName?: string;
  subject: string;
  body: string;
  htmlBody?: string;
  scheduledAt: string;
  /** Already scoped with scopeIdempotencyKey. */
  idempotencyKey?: string;
}

export interface UpdateEmailData {
  status?: EmailStatus;
  sentAt?: string | null;
  errorMessage?: string | null;
  attemptCount?: number;
  scheduledAt?: string;
}

export const createEmail = async (data: CreateEmailData): Promise<Email> => {
  const now = new Date().toISOString();
  const { data: email, error } = await supabaseServiceClient
    .from('emails')
    .insert([
      {
        sender_id: data.senderId,
        recipient_email: data.recipientEmail,
        recipient_name: data.recipientName || null,
        subject: data.subject,
        body: data.body,
        html_body: data.htmlBody || null,
        scheduled_at: data.scheduledAt,
        status: 'SCHEDULED',
        attempt_count: 0,
        idempotency_key: data.idempotencyKey || null,
        created_at: now,
        updated_at: now,
      },
    ])
    .select()
    .single();

  if (error) {
    if (error.code !== UNIQUE_VIOLATION) logger.error('❌ Create email error:', error);
    throw error;
  }
  return transformEmailFromDB(email);
};

export const getEmailById = async (id: string): Promise<Email | null> => {
  const { data: email, error } = await supabaseServiceClient
    .from('emails')
    .select('*')
    .eq('id', id)
    .single();

  if (error && error.code !== NO_ROWS) {
    logger.error('❌ Get email by ID error:', error);
    throw error;
  }
  return email ? transformEmailFromDB(email) : null;
};

export interface ListEmailsOptions {
  senderIds: string[];
  statuses?: EmailStatus[];
  limit: number;
  offset: number;
  /** By scheduled time: 'desc' (latest first, the default) or 'asc' (soonest first). */
  order?: 'asc' | 'desc';
}

/** One page of emails for the given senders, plus the total match count. */
export const listEmails = async ({
  senderIds,
  statuses,
  limit,
  offset,
  order = 'desc',
}: ListEmailsOptions): Promise<{ emails: Email[]; total: number }> => {
  if (senderIds.length === 0) return { emails: [], total: 0 };

  let query = supabaseServiceClient
    .from('emails')
    .select('*', { count: 'exact' })
    .in('sender_id', senderIds);

  if (statuses && statuses.length > 0) {
    query = query.in('status', statuses);
  }

  const { data, error, count } = await query
    .order('scheduled_at', { ascending: order === 'asc' })
    .order('id', { ascending: true }) // stable pages when times are equal
    .range(offset, offset + limit - 1);

  if (error) {
    logger.error('❌ List emails error:', error);
    throw error;
  }
  return { emails: (data || []).map(transformEmailFromDB), total: count ?? 0 };
};

export interface CountEmailsOptions {
  senderIds: string[];
  statuses: EmailStatus[];
  scheduledFrom?: Date;
  scheduledBefore?: Date;
}

export const countEmails = async ({
  senderIds,
  statuses,
  scheduledFrom,
  scheduledBefore,
}: CountEmailsOptions): Promise<number> => {
  if (senderIds.length === 0) return 0;

  let query = supabaseServiceClient
    .from('emails')
    .select('id', { count: 'exact', head: true })
    .in('sender_id', senderIds)
    .in('status', statuses);

  if (scheduledFrom) query = query.gte('scheduled_at', scheduledFrom.toISOString());
  if (scheduledBefore) query = query.lt('scheduled_at', scheduledBefore.toISOString());

  const { count, error } = await query;
  if (error) {
    logger.error('❌ Count emails error:', error);
    throw error;
  }
  return count ?? 0;
};

const toUpdateRow = (data: UpdateEmailData): Record<string, unknown> => {
  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (data.status !== undefined) updateData.status = data.status;
  if (data.sentAt !== undefined) updateData.sent_at = data.sentAt;
  if (data.errorMessage !== undefined) updateData.error_message = data.errorMessage;
  if (data.attemptCount !== undefined) updateData.attempt_count = data.attemptCount;
  if (data.scheduledAt !== undefined) updateData.scheduled_at = data.scheduledAt;
  return updateData;
};

/**
 * Update only while the email still has one of `statuses`, in one statement,
 * so a status that changed in the meantime (sent, cancelled, retried) is never
 * overwritten. Returns null when the row is gone or its status moved on.
 */
export const updateEmailIfStatus = async (
  id: string,
  statuses: readonly EmailStatus[],
  data: UpdateEmailData
): Promise<Email | null> => {
  const { data: email, error } = await supabaseServiceClient
    .from('emails')
    .update(toUpdateRow(data))
    .eq('id', id)
    .in('status', [...statuses])
    .select()
    .maybeSingle();

  if (error) {
    logger.error('❌ Update email error:', error);
    throw error;
  }
  return email ? transformEmailFromDB(email) : null;
};

export const updateEmail = async (id: string, data: UpdateEmailData): Promise<Email> => {
  const updateData = toUpdateRow(data);

  const { data: email, error } = await supabaseServiceClient
    .from('emails')
    .update(updateData)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    logger.error('❌ Update email error:', error);
    throw error;
  }
  return transformEmailFromDB(email);
};

/** Hard delete. The emails table has no CANCELLED status; its logs cascade. */
export const deleteEmail = async (id: string): Promise<void> => {
  const { error } = await supabaseServiceClient.from('emails').delete().eq('id', id);
  if (error) {
    logger.error('❌ Delete email error:', error);
    throw error;
  }
};

/**
 * Delete only while the email still has one of `statuses`, in one statement,
 * so an email the worker sent in the meantime is never deleted. Returns false
 * when no row matched (gone, or its status moved on).
 */
export const deleteEmailIfStatus = async (id: string, statuses: readonly EmailStatus[]): Promise<boolean> => {
  const { data, error } = await supabaseServiceClient
    .from('emails')
    .delete()
    .eq('id', id)
    .in('status', [...statuses])
    .select('id');
  if (error) {
    logger.error('❌ Delete email error:', error);
    throw error;
  }
  return (data || []).length > 0;
};

/** Delete a sender's sent and failed emails (its history), before deleting the sender. */
export const deleteFinishedEmailsBySender = async (senderId: string): Promise<void> => {
  const { error } = await supabaseServiceClient
    .from('emails')
    .delete()
    .eq('sender_id', senderId)
    .in('status', ['SENT', 'FAILED']);
  if (error) {
    logger.error('❌ Delete sender history error:', error);
    throw error;
  }
};

/** Below Supabase's default max-rows (1000), so a page is never cut short by the server. */
const PENDING_PAGE_SIZE = 500;

/**
 * Every unsent email, used to rebuild the queue on startup. Pages by ID (not by
 * offset), so rows that change status during the walk can't make it skip others.
 */
export async function* getPendingEmails(): AsyncGenerator<Email[]> {
  let afterId: string | undefined;
  for (;;) {
    let query = supabaseServiceClient
      .from('emails')
      .select('*')
      .in('status', PENDING_STATUSES)
      .order('id', { ascending: true })
      .limit(PENDING_PAGE_SIZE);
    if (afterId) query = query.gt('id', afterId);

    const { data, error } = await query;
    if (error) throw error;
    const page = (data || []).map(transformEmailFromDB);
    if (page.length > 0) yield page;
    if (page.length < PENDING_PAGE_SIZE) return;
    afterId = page[page.length - 1].id;
  }
}

/** Looks up by an already-scoped idempotency key. */
export const getEmailByIdempotencyKey = async (scopedKey: string): Promise<Email | null> => {
  const { data: email, error } = await supabaseServiceClient
    .from('emails')
    .select('*')
    .eq('idempotency_key', scopedKey)
    .single();

  if (error && error.code !== NO_ROWS) {
    logger.error('❌ Get email by idempotency key error:', error);
    throw error;
  }
  return email ? transformEmailFromDB(email) : null;
};
