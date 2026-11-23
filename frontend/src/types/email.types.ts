export interface EmailRecipient {
  email: string;
  name?: string;
}

export type EmailStatus = 'SCHEDULED' | 'RETRYING' | 'SENT' | 'FAILED';

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

export interface Sender {
  id: string;
  name: string;
  email: string;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpUser?: string | null;
  hasSmtpPassword: boolean;
}

export interface EmailStats {
  totalScheduled: number;
  totalSent: number;
  totalFailed: number;
  pendingToday: number;
}

export interface BulkScheduleRecipient {
  recipientEmail: string;
  recipientName?: string;
  scheduledAt: string;
  idempotencyKey?: string;
}

export interface BulkScheduleRequest {
  senderId: string;
  subject: string;
  body: string;
  htmlBody?: string;
  recipients: BulkScheduleRecipient[];
}

export interface BulkScheduleResult {
  scheduled: Email[];
  failed: { recipientEmail: string; error: string }[];
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
  cancelled?: boolean;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
