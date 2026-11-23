import { supabaseServiceClient } from '../config/supabase';
import { logger } from '../utils/logger';

// Database row (snake_case, matches the Supabase `senders` table)
interface SenderRow {
  id: string;
  user_id: string;
  name: string;
  email: string;
  smtp_host?: string | null;
  smtp_port?: number | null;
  smtp_user?: string | null;
  smtp_pass?: string | null;
  created_at: string;
  updated_at: string;
}

/** Internal sender, including SMTP credentials. Never send this to a client. */
export interface Sender {
  id: string;
  userId: string;
  name: string;
  email: string;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpUser?: string | null;
  smtpPass?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Sender as returned by the API: no password, only whether one is set. */
export type PublicSender = Omit<Sender, 'smtpPass'> & { hasSmtpPassword: boolean };

export interface CreateSenderData {
  userId: string;
  name: string;
  email: string;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpUser?: string | null;
  smtpPass?: string | null;
}

export type UpdateSenderData = Partial<Omit<CreateSenderData, 'userId'>>;

const NO_ROWS = 'PGRST116';

export const transformSender = (row: SenderRow): Sender => ({
  id: row.id,
  userId: row.user_id,
  name: row.name,
  email: row.email,
  smtpHost: row.smtp_host,
  smtpPort: row.smtp_port,
  smtpUser: row.smtp_user,
  smtpPass: row.smtp_pass,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toPublicSender = ({ smtpPass, ...rest }: Sender): PublicSender => ({
  ...rest,
  hasSmtpPassword: Boolean(smtpPass),
});

export const createSender = async (data: CreateSenderData): Promise<Sender> => {
  const now = new Date().toISOString();
  const { data: sender, error } = await supabaseServiceClient
    .from('senders')
    .insert([
      {
        user_id: data.userId,
        name: data.name,
        email: data.email,
        smtp_host: data.smtpHost || null,
        smtp_port: data.smtpPort || null,
        smtp_user: data.smtpUser || null,
        smtp_pass: data.smtpPass || null,
        created_at: now,
        updated_at: now,
      },
    ])
    .select()
    .single();

  if (error) {
    logger.error('❌ Create sender error:', error);
    throw error;
  }
  return transformSender(sender as SenderRow);
};

/** Looks up a sender, optionally only if it belongs to `userId`. */
export const getSenderById = async (id: string, userId?: string): Promise<Sender | null> => {
  let query = supabaseServiceClient.from('senders').select('*').eq('id', id);
  if (userId) {
    query = query.eq('user_id', userId);
  }

  const { data: sender, error } = await query.single();

  if (error && error.code !== NO_ROWS) {
    logger.error('❌ Get sender by ID error:', error);
    throw error;
  }
  return sender ? transformSender(sender as SenderRow) : null;
};

export const getSendersByUserId = async (userId: string): Promise<Sender[]> => {
  const { data: senders, error } = await supabaseServiceClient
    .from('senders')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('❌ Get senders by user ID error:', error);
    throw error;
  }
  return (senders || []).map((row) => transformSender(row as SenderRow));
};

export const getSenderIdsByUserId = async (userId: string): Promise<string[]> => {
  const { data, error } = await supabaseServiceClient
    .from('senders')
    .select('id')
    .eq('user_id', userId);

  if (error) {
    logger.error('❌ Get sender IDs error:', error);
    throw error;
  }
  return (data || []).map((row) => row.id as string);
};

/**
 * Makes sure the user has at least one sender. The default sender uses the
 * user's own (Google-verified) address and the server's shared SMTP settings,
 * which are never copied into the row.
 */
export const ensureDefaultSender = async (
  userId: string,
  email: string,
  name?: string | null
): Promise<Sender[]> => {
  const senders = await getSendersByUserId(userId);
  if (senders.length > 0) return senders;

  try {
    const sender = await createSender({ userId, email, name: name || email });
    logger.info(`✅ Default sender created for user ${userId}`);
    return [sender];
  } catch (error: any) {
    // A parallel request created it first; the unique index on shared-SMTP
    // senders (senders_one_shared_per_user) rejected this one. Use theirs.
    if (error?.code === '23505') return getSendersByUserId(userId);
    throw error;
  }
};

export const updateSender = async (
  id: string,
  userId: string,
  data: UpdateSenderData
): Promise<Sender> => {
  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (data.name !== undefined) updateData.name = data.name;
  if (data.email !== undefined) updateData.email = data.email;
  if (data.smtpHost !== undefined) updateData.smtp_host = data.smtpHost || null;
  if (data.smtpPort !== undefined) updateData.smtp_port = data.smtpPort || null;
  if (data.smtpUser !== undefined) updateData.smtp_user = data.smtpUser || null;
  if (data.smtpPass !== undefined) updateData.smtp_pass = data.smtpPass || null;

  const { data: sender, error } = await supabaseServiceClient
    .from('senders')
    .update(updateData)
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) {
    logger.error('❌ Update sender error:', error);
    throw error;
  }
  return transformSender(sender as SenderRow);
};

export const deleteSender = async (id: string, userId: string): Promise<void> => {
  const { error } = await supabaseServiceClient
    .from('senders')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);

  if (error) {
    logger.error('❌ Delete sender error:', error);
    throw error;
  }
};
