/**
 * Request Tracker Dashboard Component
 * Displays real-time statistics and logs of API requests from Test Assistant tabs
 */

import React, { useState, useEffect, useRef } from 'react';
import requestTracker, { RequestLog, RequestStats, TabName } from '../utils/requestTracker';

interface RequestTrackerDashboardProps {
  autoRefresh?: boolean;
  refreshInterval?: number; // in milliseconds
}

const RequestTrackerDashboard: React.FC<RequestTrackerDashboardProps> = ({
  autoRefresh = true,
  refreshInterval = 3000
}) => {
  const [stats, setStats] = useState<RequestStats[]>([]);
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [selectedTab, setSelectedTab] = useState<TabName | 'all'>('all');
  const [showLogs, setShowLogs] = useState(false);
  const [filterStatus, setFilterStatus] = useState<'all' | 'success' | 'failed' | 'pending'>('all');
  const [loading, setLoading] = useState(false);
  // Track whether updates are coming from auto refresh to avoid UI flicker
  const isAutoRefreshRef = useRef(false);
  // Keep previous snapshots for soft diffing
  const prevLogsRef = useRef<RequestLog[]>([]);
  const prevStatsRef = useRef<RequestStats[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Load data from backend with fallback to cache
  const loadData = async (opts?: { silent?: boolean }) => {
    // Silent means called by auto-refresh; avoid showing loading indicator
    const silent = !!opts?.silent;
    if (!silent) setLoading(true);
    setError(null);
    try {
      // Try to load from backend
      try {
        const statsFromBackend = await requestTracker.getStatsFromBackend();
        const incomingStats: RequestStats[] = statsFromBackend && typeof statsFromBackend === 'object'
          ? (Object.values(statsFromBackend) as RequestStats[])
          : requestTracker.getAllStats();
        // Soft update: only set if changed
        const hasStatsChanged = () => {
          const prev = prevStatsRef.current;
          if (prev.length !== incomingStats.length) return true;
          for (let i = 0; i < prev.length; i++) {
            const a = prev[i];
            const b = incomingStats[i];
            if (a.tab !== b.tab || a.totalRequests !== b.totalRequests || a.successfulRequests !== b.successfulRequests || a.failedRequests !== b.failedRequests || a.averageResponseTime !== b.averageResponseTime || a.lastRequestTime !== b.lastRequestTime) {
              return true;
            }
          }
          return false;
        };
        if (hasStatsChanged()) {
          prevStatsRef.current = incomingStats;
          setStats(incomingStats);
        }

        const filter = selectedTab === 'all' 
          ? { status: filterStatus === 'all' ? undefined : filterStatus }
          : { 
              tab: selectedTab, 
              status: filterStatus === 'all' ? undefined : filterStatus 
            };
        
        const logsResult = await requestTracker.getLogsFromBackend(filter as any);
        const incomingLogs = logsResult?.logs || requestTracker.getLogs(filter as any);
        // Soft update: diff by id and status to avoid flicker
        const hasLogsChanged = () => {
          const prev = prevLogsRef.current;
          if (prev.length !== incomingLogs.length) return true;
          for (let i = 0; i < prev.length; i++) {
            const a = prev[i];
            const b = incomingLogs[i];
            if (a.id !== b.id || a.responseStatus !== b.responseStatus || a.error !== b.error || a.duration !== b.duration) {
              return true;
            }
          }
          return false;
        };
        if (hasLogsChanged()) {
          prevLogsRef.current = incomingLogs;
          setLogs(incomingLogs);
        }
      } catch (backendError) {
        console.warn('Backend load failed, using cache:', backendError);
        // Fallback to cache if backend is unavailable
        const fallbackStats = requestTracker.getAllStats();
        prevStatsRef.current = fallbackStats;
        setStats(fallbackStats);
        
        const filter = selectedTab === 'all' 
          ? { status: filterStatus === 'all' ? undefined : filterStatus }
          : { 
              tab: selectedTab, 
              status: filterStatus === 'all' ? undefined : filterStatus 
            };
        
        const fallbackLogs = requestTracker.getLogs(filter as any);
        prevLogsRef.current = fallbackLogs;
        setLogs(fallbackLogs);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    loadData();

    if (autoRefresh) {
      const interval = setInterval(() => {
        isAutoRefreshRef.current = true;
        loadData({ silent: true }).finally(() => {
          isAutoRefreshRef.current = false;
        });
      }, refreshInterval);
      return () => clearInterval(interval);
    }
  }, [selectedTab, filterStatus, autoRefresh, refreshInterval]);

  // Add real-time listener
  useEffect(() => {
    const listener = (log: RequestLog) => {
      // Real-time new log; avoid heavy refresh, merge optimistically
      const current = prevLogsRef.current;
      const exists = current.findIndex(l => l.id === log.id) !== -1;
      if (!exists) {
        const merged = [...current, log];
        prevLogsRef.current = merged;
        setLogs(merged);
      }
      // Stats may change for the tab; trigger a silent refresh
      loadData({ silent: true });
    };
    
    requestTracker.addListener(listener);
    return () => requestTracker.removeListener(listener);
  }, [selectedTab, filterStatus]);

  const handleExport = (format: 'json' | 'csv') => {
    const data = format === 'json' 
      ? requestTracker.exportLogs()
      : requestTracker.exportLogsCSV();
    
    const blob = new Blob([data], { type: format === 'json' ? 'application/json' : 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `request-tracker-${new Date().toISOString()}.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleClear = async () => {
    if (confirm(`Are you sure you want to clear ${selectedTab === 'all' ? 'all' : selectedTab} logs?`)) {
      try {
        setLoading(true);
        await requestTracker.clear(selectedTab === 'all' ? undefined : selectedTab);
        await loadData();
      } catch (err) {
        console.error('Error clearing logs:', err);
        setError('Failed to clear logs');
      } finally {
        setLoading(false);
      }
    }
  };

  const handlePrune = async () => {
    const daysStr = prompt('Delete logs older than how many days?', '30');
    if (daysStr) {
      const days = parseInt(daysStr, 10);
      if (isNaN(days) || days < 1) {
        setError('Invalid number of days');
        return;
      }
      
      try {
        setLoading(true);
        await requestTracker.prune(days);
        await loadData();
        setError(null);
      } catch (err) {
        console.error('Error pruning logs:', err);
        setError('Failed to prune logs');
      } finally {
        setLoading(false);
      }
    }
  };

  const getStatusColor = (stat: RequestStats) => {
    const successRate = stat.totalRequests > 0 
      ? (stat.successfulRequests / stat.totalRequests) * 100 
      : 0;
    
    if (successRate >= 90) return 'text-green-600';
    if (successRate >= 70) return 'text-yellow-600';
    return 'text-red-600';
  };

  const formatDuration = (ms?: number) => {
    if (!ms) return 'N/A';
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
  };

  const summary = requestTracker.getSummary();

  return (
    <div className="p-6 bg-gray-50 min-h-screen">
      <div className="max-w-7xl mx-auto">
        {/* Error Message */}
        {error && (
          <div className="mb-4 p-4 bg-red-100 border border-red-400 text-red-700 rounded">
            {error}
            <button 
              onClick={() => setError(null)}
              className="ml-2 text-red-700 font-bold"
            >
              ✕
            </button>
          </div>
        )}

        {/* Loading State */}
        {loading && (
          <div className="mb-4 rounded-2xl border border-app-brand-100 bg-app-brand-75 p-4 text-app-brand-800">
            Loading...
          </div>
        )}

        {/* Header */}
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-bold text-gray-800">
            Request Tracker Dashboard
          </h1>
          <div className="flex gap-2">
            <button
              onClick={() => handleExport('json')}
              className="rounded-2xl bg-app-brand-800 px-4 py-2 text-white hover:bg-app-brand-700 disabled:opacity-50"
              disabled={loading}
            >
              Export JSON
            </button>
            <button
              onClick={() => handleExport('csv')}
              className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
              disabled={loading}
            >
              Export CSV
            </button>
            <button
              onClick={handlePrune}
              className="px-4 py-2 bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50"
              disabled={loading}
            >
              Prune Old
            </button>
            <button
              onClick={handleClear}
              className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              disabled={loading}
            >
              Clear Logs
            </button>
            <button
              onClick={() => loadData()}
              className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700 disabled:opacity-50"
              disabled={loading}
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="bg-white p-6 rounded-lg shadow">
            <h3 className="text-gray-500 text-sm font-medium">Total Requests</h3>
            <p className="text-3xl font-bold text-gray-800 mt-2">
              {summary.totalRequests}
            </p>
          </div>
          <div className="bg-white p-6 rounded-lg shadow">
            <h3 className="text-gray-500 text-sm font-medium">Successful</h3>
            <p className="text-3xl font-bold text-green-600 mt-2">
              {summary.successfulRequests}
            </p>
          </div>
          <div className="bg-white p-6 rounded-lg shadow">
            <h3 className="text-gray-500 text-sm font-medium">Failed</h3>
            <p className="text-3xl font-bold text-red-600 mt-2">
              {summary.failedRequests}
            </p>
          </div>
        </div>

        {/* Tab Statistics */}
        <div className="bg-white rounded-lg shadow mb-6">
          <div className="p-4 border-b">
            <h2 className="text-xl font-semibold text-gray-800">
              Statistics by Tab
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Tab
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Total
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Success
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Failed
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Success Rate
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Avg Response
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Last Request
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {stats.map((stat) => {
                  const successRate = stat.totalRequests > 0
                    ? ((stat.successfulRequests / stat.totalRequests) * 100).toFixed(1)
                    : '0.0';
                  
                  return (
                    <tr 
                      key={stat.tab}
                      className="hover:bg-gray-50 cursor-pointer"
                      onClick={() => {
                        setSelectedTab(stat.tab);
                        setShowLogs(true);
                      }}
                    >
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="font-medium text-gray-900 uppercase">
                          {stat.tab}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-gray-700">
                        {stat.totalRequests}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-green-600">
                        {stat.successfulRequests}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-red-600">
                        {stat.failedRequests}
                      </td>
                      <td className={`px-6 py-4 whitespace-nowrap font-medium ${getStatusColor(stat)}`}>
                        {successRate}%
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-gray-700">
                        {formatDuration(stat.averageResponseTime)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-gray-500 text-sm">
                        {stat.lastRequestTime 
                          ? new Date(stat.lastRequestTime).toLocaleString() 
                          : 'N/A'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Request Logs */}
        {showLogs && (
          <div className="bg-white rounded-lg shadow">
            <div className="p-4 border-b flex justify-between items-center">
              <div className="flex items-center gap-4">
                <h2 className="text-xl font-semibold text-gray-800">
                  Request Logs
                </h2>
                <select
                  value={selectedTab}
                  onChange={(e) => setSelectedTab(e.target.value as TabName | 'all')}
                  className="px-3 py-1 border rounded"
                >
                  <option value="all">All Tabs</option>
                  <option value="testcases">Test Cases</option>
                  <option value="visual">Visual</option>
                  <option value="data">Test Data</option>
                  <option value="changes">Changes</option>
                  <option value="unit">Unit</option>
                  <option value="kb">KB</option>
                </select>
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value as any)}
                  className="px-3 py-1 border rounded"
                >
                  <option value="all">All Status</option>
                  <option value="success">Success</option>
                  <option value="failed">Failed</option>
                  <option value="pending">Pending</option>
                </select>
              </div>
              <button
                onClick={() => setShowLogs(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                ✕
              </button>
            </div>
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Time
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Tab
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      User
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Session
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Method
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Endpoint
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Status
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Duration
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {logs.slice().reverse().map((log) => (
                    <tr key={log.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-sm font-medium text-gray-900 uppercase">
                        {log.tab}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-700">
                        {log.user || '—'}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-700">
                        {log.sessionId || '—'}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-sm">
                        <span className={`px-2 py-1 rounded text-xs font-medium ${
                          log.method === 'GET' ? 'bg-app-brand-75 text-app-brand-800' :
                          log.method === 'POST' ? 'bg-green-100 text-green-800' :
                          log.method === 'PUT' ? 'bg-yellow-100 text-yellow-800' :
                          log.method === 'DELETE' ? 'bg-red-100 text-red-800' :
                          'bg-gray-100 text-gray-800'
                        }`}>
                          {log.method}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-700 truncate max-w-xs">
                        {log.endpoint}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-sm">
                        {log.responseStatus ? (
                          <span className={`px-2 py-1 rounded text-xs font-medium ${
                            log.responseStatus >= 200 && log.responseStatus < 300
                              ? 'bg-green-100 text-green-800'
                              : log.responseStatus >= 400
                              ? 'bg-red-100 text-red-800'
                              : 'bg-yellow-100 text-yellow-800'
                          }`}>
                            {log.responseStatus}
                          </span>
                        ) : log.error ? (
                          <span className="px-2 py-1 rounded text-xs font-medium bg-red-100 text-red-800">
                            Error
                          </span>
                        ) : (
                          <span className="px-2 py-1 rounded text-xs font-medium bg-gray-100 text-gray-800">
                            Pending
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-700">
                        {formatDuration(log.duration)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default RequestTrackerDashboard;
