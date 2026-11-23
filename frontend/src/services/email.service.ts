import { apiClient } from './api.service';
import type {
  ApiResponse,
  BulkScheduleRequest,
  BulkScheduleResult,
  Email,
  EmailStats,
  PaginatedResponse,
  Sender,
} from '../types';

export const PAGE_SIZE = 50;

export const emailService = {
  /** Scheduled = waiting to send, including emails waiting for a retry. Soonest first. */
  getScheduledEmails(page = 1, signal?: AbortSignal): Promise<ApiResponse<PaginatedResponse<Email>>> {
    return apiClient.get('/emails', { status: 'SCHEDULED,RETRYING', page, limit: PAGE_SIZE, order: 'asc' }, signal);
  },

  getSentEmails(page = 1, signal?: AbortSignal): Promise<ApiResponse<PaginatedResponse<Email>>> {
    return apiClient.get('/emails', { status: 'SENT', page, limit: PAGE_SIZE }, signal);
  },

  /** Emails that gave up after all attempts; they can be retried. */
  getFailedEmails(page = 1, signal?: AbortSignal): Promise<ApiResponse<PaginatedResponse<Email>>> {
    return apiClient.get('/emails', { status: 'FAILED', page, limit: PAGE_SIZE }, signal);
  },

  /** Sends the browser's timezone so "pending today" means the user's today. */
  getEmailStats(signal?: AbortSignal): Promise<ApiResponse<EmailStats>> {
    return apiClient.get('/emails/stats', { tzOffset: new Date().getTimezoneOffset() }, signal);
  },

  getSenders(): Promise<ApiResponse<{ senders: Sender[] }>> {
    return apiClient.get('/emails/senders');
  },

  scheduleBulk(request: BulkScheduleRequest): Promise<ApiResponse<BulkScheduleResult>> {
    return apiClient.post('/emails/schedule/bulk', request);
  },

  cancelScheduledEmail(emailId: string): Promise<ApiResponse<void>> {
    return apiClient.delete(`/emails/${emailId}`);
  },

  retryFailedEmail(emailId: string): Promise<ApiResponse<{ email: Email }>> {
    return apiClient.post(`/emails/${emailId}/retry`);
  },
};
