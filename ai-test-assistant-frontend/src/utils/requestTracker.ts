/**
 * Request Tracker Utility (Backend-backed with SQLite)
 * Captures and tracks all API requests made from Test Assistant tabs
 * Data is persisted to SQLite backend, not localStorage
 * 
 * Tracks:
 * - What requests are being hit (URL, method, payload)
 * - What requests are sent (request details)
 * - Number of requests per tab (test cases, visual, test data, changes, unit, kb)
 */

import RequestTrackerAPI from './requestTrackerAPI';

export type TabName = 'testcases' | 'visual' | 'data' | 'changes' | 'unit' | 'kb';

export interface RequestLog {
  id: string;
  timestamp: string;
  tab: TabName;
  method: string;
  url: string;
  endpoint: string;
  requestPayload: any;
  responseStatus?: number;
  responseData?: any;
  duration?: number;
  error?: string;
  user?: string;
  sessionId?: string;
  prompt_tokens?: number;
  response_tokens?: number;
  total_tokens?: number;
}

export interface RequestStats {
  tab: TabName;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  lastRequestTime: string | null;
  endpoints: Record<string, number>; // endpoint -> count
}

class RequestTracker {
  // In-memory cache for current session
  private logCache: RequestLog[] = [];
  private statsCache: Map<TabName, RequestStats> = new Map();
  private enabled: boolean = true;
  private listeners: Array<(log: RequestLog) => void> = [];

  constructor() {
    this.initializeStats();
    // Try to load from backend on init
    this.loadFromBackend().catch(() => {
      console.warn('Request tracker API not available yet');
    });
  }

  /**
   * Initialize stats for all tabs
   */
  private initializeStats() {
    const tabs: TabName[] = ['testcases', 'visual', 'data', 'changes', 'unit', 'kb'];
    tabs.forEach(tab => {
      this.statsCache.set(tab, {
        tab,
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        averageResponseTime: 0,
        lastRequestTime: null,
        endpoints: {}
      });
    });
  }

  /**
   * Load logs from backend
   */
  private async loadFromBackend() {
    try {
      const response = await RequestTrackerAPI.getLogs({ limit: 100 });
      this.logCache = response.logs;
      
      const stats = await RequestTrackerAPI.getStats();
      for (const [tab, tabStats] of Object.entries(stats)) {
        this.statsCache.set(tab as TabName, tabStats as RequestStats);
      }
    } catch (error) {
      console.warn('Failed to load request tracker data from backend:', error);
    }
  }

  /**
   * Enable or disable request tracking
   */
  public setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  /**
   * Check if tracking is enabled
   */
  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Log a new request
   */
  public logRequest(params: {
    tab: TabName;
    method: string;
    url: string;
    requestPayload?: any;
    user?: string;
    sessionId?: string;
  }): string {
    if (!this.enabled) return '';

    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = new Date().toISOString();
    const endpoint = this.extractEndpoint(params.url);

    const log: RequestLog = {
      id,
      timestamp,
      tab: params.tab,
      method: params.method,
      url: params.url,
      endpoint,
      requestPayload: params.requestPayload,
      user: params.user,
      sessionId: params.sessionId
    };

    // Add to in-memory cache
    this.logCache.push(log);
    this.updateStats(params.tab, endpoint);

    // Send to backend asynchronously (non-blocking)
    console.log(`[RequestTracker] Queuing for backend sync: ${id}`);
    RequestTrackerAPI.logRequest(log).catch(err => {
      console.error(`[RequestTracker ERROR] Failed to sync log ${id} to backend:`, err);
      if (err.response?.data?.detail) {
        console.error('[RequestTracker ERROR] Server message:', err.response.data.detail);
      }
    });

    // Notify listeners immediately
    this.notifyListeners(log);

    return id;
  }

  /**
   * Update request with response data
   */
  public updateRequest(id: string, params: {
    responseStatus?: number;
    responseData?: any;
    duration?: number;
    error?: string;
  }) {
    if (!this.enabled) return;

    // Update in-memory cache
    const log = this.logCache.find(l => l.id === id);
    if (log) {
      Object.assign(log, params);
      
      const stat = this.statsCache.get(log.tab);
      if (stat) {
        if (params.responseStatus && params.responseStatus >= 200 && params.responseStatus < 300) {
          stat.successfulRequests++;
        } else if (params.error || (params.responseStatus && params.responseStatus >= 400)) {
          stat.failedRequests++;
        }

        if (params.duration !== undefined) {
          const totalTime = stat.averageResponseTime * (stat.totalRequests - 1);
          stat.averageResponseTime = (totalTime + params.duration) / stat.totalRequests;
        }

        stat.lastRequestTime = log.timestamp;
      }

      // Notify listeners immediately
      this.notifyListeners(log);
    }

    // Send update to backend asynchronously (non-blocking)
    RequestTrackerAPI.updateRequest(id, {
      response_status: params.responseStatus,
      response_data: params.responseData,
      duration: params.duration,
      error: params.error,
    }).catch(err => {
      console.error('Failed to update request log on backend:', err);
    });
  }

  /**
   * Extract endpoint from full URL
   */
  private extractEndpoint(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.pathname;
    } catch {
      return url;
    }
  }

  /**
   * Update statistics for a tab
   */
  private updateStats(tab: TabName, endpoint: string) {
    const stat = this.statsCache.get(tab);
    if (!stat) return;

    stat.totalRequests++;
    stat.endpoints[endpoint] = (stat.endpoints[endpoint] || 0) + 1;
  }

  /**
   * Get all logs from cache (with optional filters)
   */
  public getLogs(filter?: {
    tab?: TabName;
    startTime?: Date;
    endTime?: Date;
    status?: 'success' | 'failed' | 'pending';
  }): RequestLog[] {
    let filtered = [...this.logCache];

    if (filter?.tab) {
      filtered = filtered.filter(log => log.tab === filter.tab);
    }

    if (filter?.startTime) {
      filtered = filtered.filter(log => new Date(log.timestamp) >= filter.startTime!);
    }

    if (filter?.endTime) {
      filtered = filtered.filter(log => new Date(log.timestamp) <= filter.endTime!);
    }

    if (filter?.status === 'success') {
      filtered = filtered.filter(log => log.responseStatus && log.responseStatus >= 200 && log.responseStatus < 300);
    } else if (filter?.status === 'failed') {
      filtered = filtered.filter(log => log.error || (log.responseStatus && log.responseStatus >= 400));
    } else if (filter?.status === 'pending') {
      filtered = filtered.filter(log => !log.responseStatus && !log.error);
    }

    return filtered;
  }

  /**
   * Get logs from backend with optional filters
   */
  public async getLogsFromBackend(filter?: {
    tab?: TabName;
    user?: string;
    status?: 'success' | 'failed' | 'pending';
    startTime?: Date;
    endTime?: Date;
    limit?: number;
    offset?: number;
  }): Promise<{ logs: RequestLog[]; total: number; limit: number; offset: number }> {
    try {
      return await RequestTrackerAPI.getLogs({
        tab: filter?.tab,
        user: filter?.user,
        status: filter?.status,
        start_time: filter?.startTime,
        end_time: filter?.endTime,
        limit: filter?.limit ?? 100,
        offset: filter?.offset ?? 0,
      });
    } catch (error) {
      console.error('Failed to fetch logs from backend:', error);
      throw error;
    }
  }

  /**
   * Get statistics for a specific tab
   */
  public getStats(tab: TabName): RequestStats | undefined {
    return this.statsCache.get(tab);
  }

  /**
   * Get statistics from backend for a specific tab
   */
  public async getStatsFromBackend(tab?: TabName): Promise<any> {
    try {
      const stats = await RequestTrackerAPI.getStats(tab);
      return stats;
    } catch (error) {
      console.error('Failed to fetch stats from backend:', error);
      throw error;
    }
  }

  /**
   * Get statistics for all tabs
   */
  public getAllStats(): RequestStats[] {
    return Array.from(this.statsCache.values());
  }

  /**
   * Get summary of all tabs
   */
  public getSummary() {
    const summary = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      byTab: {} as Record<TabName, { total: number; success: number; failed: number }>
    };

    this.statsCache.forEach((stat, tab) => {
      summary.totalRequests += stat.totalRequests;
      summary.successfulRequests += stat.successfulRequests;
      summary.failedRequests += stat.failedRequests;
      summary.byTab[tab] = {
        total: stat.totalRequests,
        success: stat.successfulRequests,
        failed: stat.failedRequests
      };
    });

    return summary;
  }

  /**
   * Get summary from backend
   */
  public async getSummaryFromBackend(): Promise<any> {
    try {
      return await RequestTrackerAPI.getSummary();
    } catch (error) {
      console.error('Failed to fetch summary from backend:', error);
      throw error;
    }
  }

  /**
   * Clear all logs from memory and backend
   */
  public clearCache(tab?: TabName) {
    if (tab) {
      this.logCache = this.logCache.filter(log => log.tab !== tab);
      const stat = this.statsCache.get(tab);
      if (stat) {
        stat.totalRequests = 0;
        stat.successfulRequests = 0;
        stat.failedRequests = 0;
        stat.averageResponseTime = 0;
        stat.lastRequestTime = null;
        stat.endpoints = {};
      }
    } else {
      this.logCache = [];
      this.initializeStats();
    }
  }

  /**
   * Clear logs from memory and backend
   */
  public async clear(tab?: TabName) {
    this.clearCache(tab);
    
    // Also clear from backend
    try {
      if (tab) {
        await RequestTrackerAPI.deleteLogs({ tab });
      } else {
        await RequestTrackerAPI.deleteLogs({});
      }
    } catch (error) {
      console.error('Failed to clear logs from backend:', error);
      // Non-blocking - cache was already cleared
    }
  }

  /**
   * Export logs as JSON
   */
  public exportLogs(): string {
    return JSON.stringify({
      logs: this.logCache,
      stats: Array.from(this.statsCache.values()),
      exportedAt: new Date().toISOString()
    }, null, 2);
  }

  /**
   * Export logs as CSV
   */
  public exportLogsCSV(): string {
    const headers = [
      'ID', 'Timestamp', 'Tab', 'Method', 'Endpoint', 'URL',
      'Status', 'Duration (ms)', 'User', 'Error'
    ];
    
    const rows = this.logCache.map(log => [
      log.id,
      log.timestamp,
      log.tab,
      log.method,
      log.endpoint,
      log.url,
      log.responseStatus || 'pending',
      log.duration || '',
      log.user || '',
      log.error || ''
    ]);

    const csv = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    return csv;
  }

  /**
   * Prune old logs from backend
   */
  public async prune(daysOld: number = 7) {
    try {
      await RequestTrackerAPI.pruneLogs(daysOld);
      // Reload logs from backend after pruning
      await this.loadFromBackend();
    } catch (error) {
      console.error('Failed to prune logs:', error);
      // Non-blocking
    }
  }

  /**
   * Add a listener for new requests
   */
  public addListener(callback: (log: RequestLog) => void) {
    this.listeners.push(callback);
  }

  /**
   * Remove a listener
   */
  public removeListener(callback: (log: RequestLog) => void) {
    this.listeners = this.listeners.filter(cb => cb !== callback);
  }

  /**
   * Notify all listeners
   */
  private notifyListeners(log: RequestLog) {
    this.listeners.forEach(callback => {
      try {
        callback(log);
      } catch (error) {
        console.error('Error in request tracker listener:', error);
      }
    });
  }

  /**
   * Generate a report
   */
  public generateReport(): string {
    const summary = this.getSummary();
    const stats = this.getAllStats();

    let report = '=== REQUEST TRACKER REPORT ===\n\n';
    report += `Generated at: ${new Date().toISOString()}\n\n`;
    report += `Total Requests: ${summary.totalRequests}\n`;
    report += `Successful: ${summary.successfulRequests}\n`;
    report += `Failed: ${summary.failedRequests}\n`;
    report += `Success Rate: ${summary.totalRequests > 0 ? ((summary.successfulRequests / summary.totalRequests) * 100).toFixed(2) : 0}%\n\n`;

    report += '=== BY TAB ===\n\n';
    stats.forEach(stat => {
      report += `${stat.tab.toUpperCase()}:\n`;
      report += `  Total: ${stat.totalRequests}\n`;
      report += `  Success: ${stat.successfulRequests}\n`;
      report += `  Failed: ${stat.failedRequests}\n`;
      report += `  Avg Response Time: ${stat.averageResponseTime.toFixed(2)}ms\n`;
      report += `  Last Request: ${stat.lastRequestTime || 'N/A'}\n`;
      report += `  Endpoints:\n`;
      Object.entries(stat.endpoints)
        .sort((a, b) => b[1] - a[1])
        .forEach(([endpoint, count]) => {
          report += `    ${endpoint}: ${count} requests\n`;
        });
      report += '\n';
    });

    return report;
  }
}

// Create singleton instance
const requestTracker = new RequestTracker();

export default requestTracker;
