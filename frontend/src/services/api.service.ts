import axios from 'axios';
import type { AxiosInstance } from 'axios';
import { API_BASE_URL } from '../config';
import type { ApiResponse } from '../types';

export const AUTH_TOKEN_KEY = 'authToken';

type UnauthorizedHandler = () => void;

class ApiClient {
  private client: AxiosInstance;
  private onUnauthorized: UnauthorizedHandler | null = null;

  constructor() {
    // Auth is a Bearer token, so no cookies (withCredentials) are needed.
    this.client = axios.create({
      baseURL: API_BASE_URL,
      headers: { 'Content-Type': 'application/json' },
    });

    this.client.interceptors.request.use((config) => {
      const token = localStorage.getItem(AUTH_TOKEN_KEY);
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      return config;
    });

    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        if (axios.isAxiosError(error) && error.response?.status === 401) {
          this.onUnauthorized?.();
        }
        return Promise.reject(error);
      }
    );
  }

  /** Called on any 401. The auth context uses it to sign out through React state. */
  setUnauthorizedHandler(handler: UnauthorizedHandler | null) {
    this.onUnauthorized = handler;
  }

  async get<T>(url: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<ApiResponse<T>> {
    return this.request(() => this.client.get<ApiResponse<T>>(url, { params, signal }));
  }

  async post<T>(url: string, data?: unknown): Promise<ApiResponse<T>> {
    return this.request(() => this.client.post<ApiResponse<T>>(url, data));
  }

  async put<T>(url: string, data?: unknown): Promise<ApiResponse<T>> {
    return this.request(() => this.client.put<ApiResponse<T>>(url, data));
  }

  async delete<T>(url: string): Promise<ApiResponse<T>> {
    return this.request(() => this.client.delete<ApiResponse<T>>(url));
  }

  /**
   * Never throws: failures come back as { success: false, error }. Callers must
   * check `success` and show `error`.
   */
  private async request<T>(call: () => Promise<{ data: ApiResponse<T> }>): Promise<ApiResponse<T>> {
    try {
      const response = await call();
      return response.data;
    } catch (error) {
      return this.toErrorResponse(error);
    }
  }

  private toErrorResponse<T>(error: unknown): ApiResponse<T> {
    if (axios.isCancel(error)) {
      return { success: false, error: 'Request cancelled', cancelled: true };
    }
    if (axios.isAxiosError(error)) {
      const body = error.response?.data as Partial<ApiResponse<T>> | undefined;
      if (!error.response) {
        return { success: false, error: 'Cannot reach the server. Check your connection and try again.' };
      }
      // Partial results (e.g. bulk scheduling) come back with a non-2xx status but still carry data.
      return {
        ...body,
        success: false,
        error: body?.error || body?.message || error.message,
      };
    }
    return { success: false, error: 'An unexpected error occurred' };
  }
}

export const apiClient = new ApiClient();
