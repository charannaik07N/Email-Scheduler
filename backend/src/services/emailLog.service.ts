import { supabaseServiceClient } from '../config/supabase';
import { logger } from '../utils/logger';

export interface EmailLog {
  id: string;
  emailId: string;
  status: string;
  message: string | null;
  createdAt: string;
}

export interface CreateEmailLogData {
  emailId: string;
  status: 'SCHEDULED' | 'RETRYING' | 'SENT' | 'FAILED';
  message: string;
}

const transformLog = (row: any): EmailLog => ({
  id: row.id,
  emailId: row.email_id,
  status: row.status,
  message: row.message,
  createdAt: row.created_at,
});

export const createEmailLog = async (data: CreateEmailLogData): Promise<EmailLog> => {
  const { data: log, error } = await supabaseServiceClient
    .from('email_logs')
    .insert([
      {
        email_id: data.emailId,
        status: data.status,
        message: data.message,
        created_at: new Date().toISOString(),
      },
    ])
    .select()
    .single();

  if (error) {
    logger.error('❌ Create email log error:', error);
    throw error;
  }
  return transformLog(log);
};

/**
 * Audit logging must never fail the operation it describes, so this variant
 * only reports errors.
 */
export const tryCreateEmailLog = async (data: CreateEmailLogData): Promise<void> => {
  try {
    await createEmailLog(data);
  } catch {
    // already logged
  }
};

export const getEmailLogs = async (emailId: string): Promise<EmailLog[]> => {
  const { data: logs, error } = await supabaseServiceClient
    .from('email_logs')
    .select('*')
    .eq('email_id', emailId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('❌ Get email logs error:', error);
    throw error;
  }
  return (logs || []).map(transformLog);
};
