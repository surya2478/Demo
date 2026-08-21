/**
 * Request Tracker Management Report
 * High-level statistics and analytics for management review
 * Professional red-themed dashboard with charts
 */

import React, { useState, useEffect, useMemo } from 'react';
import { format, parseISO } from 'date-fns';
import api from '../services/api';
import { HiArrowUp, HiArrowDown, HiTrendingUp, HiUsers, HiChartBar, HiCheckCircle, HiExclamationCircle } from 'react-icons/hi';
import ReactECharts from 'echarts-for-react';
import * as echarts from 'echarts';

interface AnalyticsData {
  summary: {
    total_requests: number;
    successful: number;
    failed: number;
    period_days: number;
  };
  requests_per_day: Array<{ date: string; count: number }>;
  top_endpoints: Array<{ endpoint: string; count: number; tab: string }>;
  top_users: Array<{ user: string; count: number; success: number }>;
  tab_distribution: Array<{ tab: string; count: number }>;
  status_distribution: Array<{ status: string; count: number }>;
}

const RequestTrackerReport: React.FC = () => {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [refreshing, setRefreshing] = useState(false);
  const [live, setLive] = useState(false);

  const loadReport = async (silent = false) => {
    if (!silent && !data) setLoading(true);
    if (silent) setRefreshing(true);
    setError(null);
    try {
      const response = await api.get<AnalyticsData>(
        `/request-tracker/analytics/report?days=${days}`
      );
      setData(response.data);
    } catch (err) {
      console.error('Failed to load analytics report:', err);
      setError('Failed to load analytics report. Please try again.');
    } finally {
      if (!silent || !data) setLoading(false);
      if (silent) setRefreshing(false);
    }
  };

  useEffect(() => {
    loadReport();
  }, [days]);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      loadReport(true);
    }, 15000);
    return () => clearInterval(id);
  }, [live, days]);

  // Build chart options with safe fallbacks (hooks must run unconditionally)
  const dailyChartOption = useMemo(() => {
    const rp = data?.requests_per_day ?? [];
    const dates = rp.map(d => format(parseISO(d.date), 'MMM d'));
    const counts = rp.map(d => d.count);
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 40, right: 10, top: 30, bottom: 40 },
      xAxis: {
        type: 'category',
        data: dates,
        axisTick: { show: false },
        axisLabel: { color: '#6b7280' }
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: '#6b7280' },
        splitLine: { lineStyle: { color: '#e5e7eb' } }
      },
      series: [
        {
          type: 'bar',
          data: counts,
          barWidth: '55%',
          itemStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: '#ef4444' },
              { offset: 1, color: '#dc2626' },
            ]),
            borderRadius: [6, 6, 0, 0],
          }
        }
      ]
    };
  }, [data?.requests_per_day]);

  const pieChartOption = useMemo(() => {
    const td = data?.tab_distribution ?? [];
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { orient: 'vertical', right: 10, top: 'center', textStyle: { color: '#374151' } },
      series: [
        {
          name: 'Requests by Tab',
          type: 'pie',
          radius: ['40%', '70%'],
          avoidLabelOverlap: false,
          itemStyle: { borderRadius: 8, borderColor: '#fff', borderWidth: 2 },
          label: { show: true, formatter: '{b}\n{c} ({d}%)', color: '#374151' },
          data: td.map(tab => ({ value: tab.count, name: (tab.tab ?? '').toUpperCase() || tab.tab }))
        }
      ],
      color: ['#dc2626', '#f97316', '#eab308', '#22c55e', '#0ea5e9', '#8b5cf6']
    };
  }, [data?.tab_distribution]);

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-2 border-app border-t-app-brand-700" />
          <p className="text-sm text-app-secondary">Loading analytics report…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-[18px] border border-red-100 bg-red-50 p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-red-700">{error}</p>
          <button
            onClick={() => loadReport()}
            className="inline-flex items-center rounded-[10px] bg-app-brand-800 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-app-brand-600"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-[18px] border border-dashed border-app bg-app-surface-muted/50 p-8 text-center text-sm text-app-secondary">
        No data available
      </div>
    );
  }

  const successRate = data.summary.total_requests > 0
    ? ((data.summary.successful / data.summary.total_requests) * 100).toFixed(1)
    : 0;

  const dailyAverage = data.requests_per_day.length > 0
    ? (data.requests_per_day.reduce((sum, d) => sum + d.count, 0) / data.requests_per_day.length).toFixed(1)
    : (data.summary.total_requests / Math.max(data.summary.period_days, 1)).toFixed(1);

  const maxUserCount = Math.max(...data.top_users.map(u => u.count), 1);

  return (
    <div className="space-y-5">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-4 rounded-[26px] border border-app bg-app-surface px-5 py-5 shadow-app-card sm:px-6">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-app-brand-700 mb-1">Analytics</p>
            <h1 className="text-[22px] font-bold tracking-[-0.02em] text-app-primary sm:text-[26px]">
              Test Assistant Report
            </h1>
            <p className="mt-0.5 text-sm text-app-secondary">Management dashboard for Test Assistant request tracking</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {[7, 14, 30, 90].map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`inline-flex items-center rounded-[12px] border px-3.5 py-1.5 text-[13px] font-semibold transition-all ${
                  days === d
                    ? 'border-app-brand-200 bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] text-white shadow-[0_6px_16px_rgba(183,25,32,0.2)]'
                    : 'border-app bg-white text-app-primary hover:border-app-brand-100 hover:bg-app-brand-50/40'
                }`}
              >
                {d}d
              </button>
            ))}
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-[12px] border border-app bg-white px-3 py-1.5 text-[13px] font-semibold text-app-primary">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-app-brand-700"
                checked={live}
                onChange={(e) => setLive(e.target.checked)}
              />
              Live
              {refreshing && <span className="text-app-brand-700 text-[11px]">•</span>}
            </label>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          {/* Total Requests */}
          <div className="rounded-[22px] border-l-4 border-l-app-brand-600 border-y border-r border-app bg-app-surface p-5 shadow-app-card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-app-secondary text-sm font-medium mb-1">Total Requests</p>
                <p className="text-3xl font-bold text-app-primary">{data.summary.total_requests.toLocaleString()}</p>
                <p className="text-xs text-app-muted mt-1">Last {data.summary.period_days} days</p>
              </div>
              <div className="text-app-brand-700 text-4xl opacity-20">
                <HiChartBar />
              </div>
            </div>
          </div>

          {/* Successful */}
          <div className="rounded-[22px] border-l-4 border-l-green-600 border-y border-r border-app bg-app-surface p-5 shadow-app-card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-app-secondary text-sm font-medium mb-1">Successful</p>
                <p className="text-3xl font-bold text-green-600">{data.summary.successful.toLocaleString()}</p>
                <p className="text-xs text-app-muted mt-1">{successRate}% success rate</p>
              </div>
              <div className="text-green-600 text-4xl opacity-20">
                <HiCheckCircle />
              </div>
            </div>
          </div>

          {/* Failed */}
          <div className="rounded-[22px] border-l-4 border-l-orange-600 border-y border-r border-app bg-app-surface p-5 shadow-app-card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-app-secondary text-sm font-medium mb-1">Failed</p>
                <p className="text-3xl font-bold text-orange-600">{data.summary.failed.toLocaleString()}</p>
                <p className="text-xs text-app-muted mt-1">
                  {data.summary.total_requests > 0 
                    ? ((data.summary.failed / data.summary.total_requests) * 100).toFixed(1)
                    : 0}% failure rate
                </p>
              </div>
              <div className="text-orange-600 text-4xl opacity-20">
                <HiExclamationCircle />
              </div>
            </div>
          </div>

          {/* Avg Daily */}
          <div className="rounded-3xl border border-app bg-app-surface p-6 shadow-app-card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-app-secondary text-sm font-medium mb-1">Daily Average</p>
                <p className="text-3xl font-bold text-app-brand-700">{dailyAverage}</p>
                <p className="text-xs text-app-muted mt-1">requests per day</p>
              </div>
              <div className="text-app-brand-700 text-4xl opacity-20">
                <HiTrendingUp />
              </div>
            </div>
          </div>
        </div>

        {/* Charts Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          {/* Daily Requests Chart */}
          <div className="rounded-[22px] border border-app bg-app-surface p-5 shadow-app-card">
            <h2 className="text-lg font-bold text-app-primary mb-4 flex items-center gap-2">
              <span className="w-1 h-6 bg-red-600 rounded"></span>
              Requests per Day
            </h2>
            <ReactECharts option={dailyChartOption} style={{ height: 320 }} notMerge lazyUpdate />
          </div>

          {/* Tab Distribution - Pie Chart */}
          <div className="rounded-[22px] border border-app bg-app-surface p-5 shadow-app-card">
            <h2 className="text-lg font-bold text-app-primary mb-4 flex items-center gap-2">
              <span className="w-1 h-6 bg-red-600 rounded"></span>
              Requests by Tab
            </h2>
            <ReactECharts option={pieChartOption} style={{ height: 320 }} notMerge lazyUpdate />
          </div>
        </div>

        {/* Bottom Row - Tables */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Top Endpoints */}
          <div className="rounded-[22px] border border-app bg-app-surface p-5 shadow-app-card">
            <h2 className="text-lg font-bold text-app-primary mb-4 flex items-center gap-2">
              <span className="w-1 h-6 bg-red-600 rounded"></span>
              Most Triggered Endpoints
            </h2>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {data.top_endpoints.map((endpoint, idx) => (
                <div key={idx} className="flex items-center gap-3 p-3 rounded bg-app-surface-muted/40 hover:bg-app-brand-50 transition-colors">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-app-primary truncate">{endpoint.endpoint}</p>
                    <p className="text-xs text-app-secondary uppercase">{endpoint.tab}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-app-brand-700">{endpoint.count}</p>
                    <div className="w-20 h-2 bg-app-surface-muted rounded-full overflow-hidden mt-1">
                      <div
                        className="h-full bg-gradient-to-r from-app-brand-700 to-app-brand-600"
                        style={{ width: `${(endpoint.count / (data.top_endpoints[0]?.count || 1)) * 100}%` }}
                      ></div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Top Users */}
          <div className="rounded-[22px] border border-app bg-app-surface p-5 shadow-app-card">
            <h2 className="text-lg font-bold text-app-primary mb-4 flex items-center gap-2">
              <span className="w-1 h-6 bg-red-600 rounded"></span>
              Top Active Users
            </h2>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {data.top_users.map((user, idx) => {
                const successRate = user.count > 0 ? ((user.success / user.count) * 100).toFixed(0) : 0;
                const failedCount = user.count - user.success;
                const failureRate = user.count > 0 ? ((failedCount / user.count) * 100).toFixed(0) : 0;
                return (
                  <div key={idx} className="flex items-center gap-3 p-3 rounded bg-app-surface-muted/40 hover:bg-app-brand-50 transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <HiUsers className="text-app-brand-700" />
                        <p className="text-sm font-medium text-app-primary truncate">{user.user}</p>
                      </div>
                      <div className="flex flex-wrap gap-3 text-xs text-app-secondary mt-2 items-center">
                        <span className="font-semibold text-app-secondary">{user.count} requests</span>
                        <span className="px-2 py-1 rounded-full bg-green-100 text-green-700 font-medium">{successRate}% success ({user.success})</span>
                        {failedCount > 0 && (
                          <span className="px-2 py-1 rounded-full bg-app-brand-75 text-app-brand-800 font-medium">{failureRate}% failed ({failedCount})</span>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-bold text-app-brand-700">{user.count}</p>
                      <div className="w-24 h-2 bg-app-surface-muted rounded-full overflow-hidden mt-1 flex">
                        <div
                          className="h-full bg-gradient-to-r from-green-500 to-green-600"
                          style={{ width: `${(user.success / user.count) * 100}%` }}
                        ></div>
                        <div
                          className="h-full bg-gradient-to-r from-app-brand-700 to-app-brand-600"
                          style={{ width: `${(failedCount / user.count) * 100}%` }}
                        ></div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Status Distribution */}
        <div className="rounded-[22px] border border-app bg-app-surface p-5 shadow-app-card mt-6">
          <h2 className="text-lg font-bold text-app-primary mb-4 flex items-center gap-2">
            <span className="w-1 h-6 bg-red-600 rounded"></span>
            Status Distribution
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {data.status_distribution.map((status, idx) => {
              const statusColors: Record<string, { bg: string; text: string; icon: React.ReactNode }> = {
                'success': { bg: 'bg-green-50', text: 'text-green-600', icon: <HiCheckCircle /> },
                'error': { bg: 'bg-app-brand-50', text: 'text-app-brand-700', icon: <HiExclamationCircle /> },
                'pending': { bg: 'bg-app-surface-muted/40', text: 'text-app-secondary', icon: <HiArrowDown /> }
              };
              const style = statusColors[status.status] || statusColors['pending'];
              const percentage = ((status.count / data.summary.total_requests) * 100).toFixed(1);
              
              return (
                <div key={idx} className={`${style.bg} rounded-lg p-4`}>
                  <div className="flex items-center gap-3 mb-3">
                    <div className={`${style.text} text-2xl`}>{style.icon}</div>
                    <p className="text-sm font-medium text-app-secondary capitalize">{status.status}</p>
                  </div>
                  <p className={`${style.text} text-2xl font-bold`}>{status.count.toLocaleString()}</p>
                  <p className="text-sm text-app-secondary mt-1">{percentage}% of total</p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-app pt-5 text-center text-sm text-app-secondary">
          <p>Report generated on {format(new Date(), 'PPpp')}</p>
        </div>
    </div>
  );
};

export default RequestTrackerReport;
