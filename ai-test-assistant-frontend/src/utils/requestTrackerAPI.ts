/**
 * Request Tracker API Client
 * Handles communication with backend request tracking endpoints
 */

import { RequestLog, TabName } from './requestTracker';

const BASE_PATH = '/request-tracker';

// Lazy import to avoid circular dependency
let apiInstance: any = null;
const getApi = async () => {
  if (!apiInstance) {
    const module = await import('../services/api');
    apiInstance = module.default;
  }
  return apiInstance;
};

export class RequestTrackerAPI {
  /**
   * Log a new request
   */
  static async logRequest(log: Omit<RequestLog, 'id'> & { id: string }): Promise<RequestLog> {
    try {
      const payload = {
        id: log.id,
        timestamp: log.timestamp,
        tab: log.tab,
        method: log.method,
        url: log.url,
        endpoint: log.endpoint,
        requestPayload: log.requestPayload,
        user: log.user,
        sessionId: log.sessionId,
      };
      
      console.log(`[RequestTrackerAPI] Sending log to ${BASE_PATH}/logs:`, payload);
      
      const api = await getApi();
      const response = await api.post(`${BASE_PATH}/logs`, payload);
      
      console.log(`[RequestTrackerAPI] Log saved successfully:`, response.data);
      return response.data;
    } catch (error: any) {
      console.error('Failed to log request:', error);
      if (error.response?.data) {
        console.error('Server error:', error.response.data);
      }
      throw error;
    }
  }

  /**
   * Update request with response data
   */
  static async updateRequest(
    logId: string,
    update: {
      response_status?: number;
      response_data?: any;
      duration?: number;
      promptTokens?: number;
      responseTokens?: number;
      totalTokens?: number;
      error?: string;
    }
  ): Promise<RequestLog> {
    try {
      const api = await getApi();
      const response = await api.put(`${BASE_PATH}/logs/${logId}`, {
        response_status: update.response_status,
        response_data: update.response_data,
        duration: update.duration,
        prompt_tokens: update.promptTokens,
        response_tokens: update.responseTokens,
        total_tokens: update.totalTokens,
        error: update.error,
      });
      return response.data;
    } catch (error) {
      console.error('Failed to update request:', error);
      throw error;
    }
  }

  /**
   * Get logs with optional filters
   */
  static async getLogs(params?: {
    tab?: TabName;
    user?: string;
    status?: 'success' | 'failed' | 'pending';
    start_time?: Date;
    end_time?: Date;
    limit?: number;
    offset?: number;
  }): Promise<{ logs: RequestLog[]; total: number; limit: number; offset: number }> {
    try {
      const queryParams: any = {};
      if (params?.tab) queryParams.tab = params.tab;
      if (params?.user) queryParams.user = params.user;
      if (params?.status) queryParams.status = params.status;
      if (params?.start_time) queryParams.start_time = params.start_time.toISOString();
      if (params?.end_time) queryParams.end_time = params.end_time.toISOString();
      if (params?.limit) queryParams.limit = params.limit;
      if (params?.offset) queryParams.offset = params.offset;

      const api = await getApi();
      const response = await api.get(`${BASE_PATH}/logs`, { params: queryParams });
      return response.data;
    } catch (error) {
      console.error('Failed to fetch logs:', error);
      throw error;
    }
  }

  /**
   * Get statistics by tab
   */
  static async getStats(tab?: string): Promise<Record<string, any>> {
    try {
      const params = tab ? { tab } : {};
      const api = await getApi();
      const response = await api.get(`${BASE_PATH}/stats`, { params });
      return response.data;
    } catch (error) {
      console.error('Failed to fetch stats:', error);
      throw error;
    }
  }

  /**
   * Get overall summary
   */
  static async getSummary(): Promise<{
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    byTab: Record<string, { total: number; success: number; failed: number }>;
  }> {
    try {
      const api = await getApi();
      const response = await api.get(`${BASE_PATH}/summary`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch summary:', error);
      throw error;
    }
  }

  /**
   * Delete logs
   */
  static async deleteLogs(params?: { tab?: TabName; older_than_days?: number }): Promise<{ deleted: number }> {
    try {
      const queryParams: any = {};
      if (params?.tab) queryParams.tab = params.tab;
      if (params?.older_than_days) queryParams.older_than_days = params.older_than_days;

      const api = await getApi();
      const response = await api.delete(`${BASE_PATH}/logs`, { params: queryParams });
      return response.data;
    } catch (error) {
      console.error('Failed to delete logs:', error);
      throw error;
    }
  }

  /**
   * Prune old logs (overloaded for number parameter)
   */
  static async pruneLogs(daysOld: number): Promise<{ pruned: number }>;
  /**
   * Prune old logs (overloaded for options object)
   */
  static async pruneLogs(options?: { keep_days?: number; max_logs?: number }): Promise<{ pruned: number }>;
  /**
   * Prune old logs - implementation
   */
  static async pruneLogs(
    daysOldOrOptions?: number | { keep_days?: number; max_logs?: number }
  ): Promise<{ pruned: number }> {
    try {
      let queryParams: any = {};
      
      if (typeof daysOldOrOptions === 'number') {
        queryParams.keep_days = daysOldOrOptions;
      } else if (daysOldOrOptions) {
        if (daysOldOrOptions.keep_days) queryParams.keep_days = daysOldOrOptions.keep_days;
        if (daysOldOrOptions.max_logs) queryParams.max_logs = daysOldOrOptions.max_logs;
      }

      const api = await getApi();
      const response = await api.post(`${BASE_PATH}/prune`, {}, { params: queryParams });
      return response.data;
    } catch (error) {
      console.error('Failed to prune logs:', error);
      throw error;
    }
  }
}

export default RequestTrackerAPI;
