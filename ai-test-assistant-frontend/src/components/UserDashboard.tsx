import React, { useEffect, useState } from 'react';
import { formatToDubaiTime } from '../utils/formatToDubaiTime';
import RequestTrackerAPI from '../utils/requestTrackerAPI';
import useAuth from '../hooks/useAuth';

interface UserRequest {
  id: number;
  user: string;
  tab: string;
  endpoint: string;
  method: string;
  responseStatus: number;
  duration: number;
  promptTokens: number;
  responseTokens: number;
  totalTokens: number;
  timestamp: string;
}

interface UserStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalTokens: number;
  promptTokens: number;
  responseTokens: number;
  avgTokensPerRequest: number;
  successRate: string;
  recentRequests: UserRequest[];
}

const getStatusMessage = (statusCode: number): string => {
  if (statusCode >= 200 && statusCode < 300) return 'Success';
  if (statusCode >= 400 && statusCode < 500) return 'Client Error';
  if (statusCode >= 500) return 'Server Error';
  if (statusCode >= 300 && statusCode < 400) return 'Redirect';
  return 'Unknown';
};

const getStatusColorClass = (statusCode: number): string => {
  if (statusCode >= 200 && statusCode < 300) return 'bg-green-100 text-green-700';
  if (statusCode >= 400 && statusCode < 500) return 'bg-red-100 text-red-700';
  if (statusCode >= 500) return 'bg-red-200 text-red-900';
  if (statusCode >= 300 && statusCode < 400) return 'bg-yellow-100 text-yellow-700';
  return 'bg-gray-100 text-gray-700';
};

const UserDashboard: React.FC = () => {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<UserStats | null>(null);

  useEffect(() => {
    fetchUserData();
  }, [user]);

  const fetchUserData = async () => {
    setLoading(true);
    try {
      const logsResponse = await RequestTrackerAPI.getLogs();
      const logs = Array.isArray(logsResponse) ? logsResponse : logsResponse.logs || [];
      
      // Filter logs for current user
      const userLogs = logs.filter((log: UserRequest) => log.user === user?.username);

      // Calculate statistics
      const totalRequests = userLogs.length;
      const successfulRequests = userLogs.filter((log: UserRequest) => 
        log.responseStatus >= 200 && log.responseStatus < 300
      ).length;
      const failedRequests = totalRequests - successfulRequests;
      const totalTokens = userLogs.reduce((sum: number, log: UserRequest) => 
        sum + (log.totalTokens || 0), 0
      );
      const promptTokens = userLogs.reduce((sum: number, log: UserRequest) => 
        sum + (log.promptTokens || 0), 0
      );
      const responseTokens = userLogs.reduce((sum: number, log: UserRequest) => 
        sum + (log.responseTokens || 0), 0
      );
      const avgTokensPerRequest = totalRequests > 0 
        ? Math.round(totalTokens / totalRequests) 
        : 0;
      const successRate = totalRequests > 0 
        ? ((successfulRequests / totalRequests) * 100).toFixed(1) 
        : '0';

      // Get recent 10 requests
      const recentRequests = userLogs
        .sort((a: UserRequest, b: UserRequest) => 
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        )
        .slice(0, 10);

      setStats({
        totalRequests,
        successfulRequests,
        failedRequests,
        totalTokens,
        promptTokens,
        responseTokens,
        avgTokensPerRequest,
        successRate,
        recentRequests
      });
    } catch (error) {
      console.error('Error fetching user data:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-600"></div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header - Compact & Professional */}
      <div className="bg-white rounded-lg shadow border border-gray-200">
        <div className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-red-50">
                <svg className="w-5 h-5 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
              </div>
              <div>
                <h1 className="text-lg font-semibold text-red-600">Welcome, {user?.username}!</h1>
                <p className="text-xs text-gray-500">Your personal activity dashboard</p>
              </div>
            </div>
            <div className="text-right">
              <div className="text-gray-500 text-xs">Last Login</div>
              <div className="text-red-600 font-medium text-xs">{formatToDubaiTime(new Date().toISOString())}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Statistics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-4 border-t-4 border-red-600">
          <div className="text-sm text-gray-500 mb-1">Total Requests</div>
          <div className="text-3xl font-bold text-gray-900">{stats?.totalRequests || 0}</div>
          <div className="text-xs text-gray-400 mt-1">All time</div>
        </div>

        <div className="bg-white rounded-lg shadow p-4 border-t-4 border-green-600">
          <div className="text-sm text-gray-500 mb-1">Success Rate</div>
          <div className="text-3xl font-bold text-green-600">{stats?.successRate || 0}%</div>
          <div className="text-xs text-gray-400 mt-1">{stats?.successfulRequests || 0} successful</div>
        </div>

        <div className="rounded-3xl border border-app bg-app-surface p-4 shadow-app-card">
          <div className="text-sm text-gray-500 mb-1">Total Tokens</div>
          <div className="text-3xl font-bold text-app-brand-700">{(stats?.totalTokens || 0).toLocaleString()}</div>
          <div className="text-xs text-gray-400 mt-1">Consumed</div>
        </div>

        <div className="bg-white rounded-lg shadow p-4 border-t-4 border-purple-600">
          <div className="text-sm text-gray-500 mb-1">Avg Per Request</div>
          <div className="text-3xl font-bold text-purple-600">{(stats?.avgTokensPerRequest || 0).toLocaleString()}</div>
          <div className="text-xs text-gray-400 mt-1">Tokens</div>
        </div>
      </div>

      {/* Token Breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold text-gray-800 mb-4">Token Usage Breakdown</h3>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-3 w-3 rounded-full bg-app-brand-700"></div>
                <span className="text-sm text-gray-600">Prompt Tokens</span>
              </div>
              <span className="text-lg font-semibold text-app-brand-700">
                {(stats?.promptTokens || 0).toLocaleString()}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-purple-500"></div>
                <span className="text-sm text-gray-600">Response Tokens</span>
              </div>
              <span className="text-lg font-semibold text-purple-600">
                {(stats?.responseTokens || 0).toLocaleString()}
              </span>
            </div>
            <div className="pt-3 border-t">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">Total</span>
                <span className="text-xl font-bold text-red-600">
                  {(stats?.totalTokens || 0).toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold text-gray-800 mb-4">Request Status</h3>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-green-500"></div>
                <span className="text-sm text-gray-600">Successful</span>
              </div>
              <span className="text-lg font-semibold text-green-600">
                {stats?.successfulRequests || 0}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-red-500"></div>
                <span className="text-sm text-gray-600">Failed</span>
              </div>
              <span className="text-lg font-semibold text-red-600">
                {stats?.failedRequests || 0}
              </span>
            </div>
            <div className="pt-3 border-t">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">Total</span>
                <span className="text-xl font-bold text-gray-900">
                  {stats?.totalRequests || 0}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Requests Table - Compact & Professional */}
      <div className="bg-white rounded-lg shadow border border-gray-200">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-sm font-semibold text-red-600">Recent Requests</h3>
          <p className="text-xs text-gray-500">Your last 10 API requests</p>
        </div>

        <div className="overflow-x-auto">
          {stats?.recentRequests && stats.recentRequests.length > 0 ? (
            <table className="w-full">
              <thead className="bg-red-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-red-600 uppercase tracking-wide">Date & Time</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-red-600 uppercase tracking-wide">Tab</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-red-600 uppercase tracking-wide">Endpoint</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-red-600 uppercase tracking-wide">Status</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-red-600 uppercase tracking-wide">Duration</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-red-600 uppercase tracking-wide">Tokens</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {stats.recentRequests.map((req) => (
                  <tr key={req.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">
                      {formatToDubaiTime(req.timestamp)}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className="rounded-full bg-app-brand-75 px-2 py-0.5 text-xs font-medium text-app-brand-700">
                        {req.tab}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-700 font-mono truncate max-w-xs">
                      {req.endpoint}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${getStatusColorClass(req.responseStatus)}`}>
                        {getStatusMessage(req.responseStatus)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {req.duration} ms
                    </td>
                    <td className="px-3 py-2 text-xs text-right">
                      <div className="text-red-600 font-semibold">
                        {(req.totalTokens || 0).toLocaleString()}
                      </div>
                      <div className="text-xs text-gray-400">
                        P: {(req.promptTokens || 0).toLocaleString()} | R: {(req.responseTokens || 0).toLocaleString()}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-center py-8">
              <svg className="w-12 h-12 text-gray-300 mx-auto mb-3" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M4 4a2 2 0 00-2 2v4a2 2 0 002 2V6h10a2 2 0 00-2-2H4zm2 6a2 2 0 012-2h8a2 2 0 012 2v4a2 2 0 01-2 2H8a2 2 0 01-2-2v-4zm6 4a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
              </svg>
              <p className="text-gray-500 text-sm font-medium">No requests found</p>
              <p className="text-gray-400 text-xs mt-1">Start using the AI Assistant to see your activity here</p>
            </div>
          )}
        </div>
      </div>

      {/* Help Section */}
      {/* <div className="bg-blue-50 border-l-4 border-blue-500 p-4 rounded-lg">
        <div className="flex">
          <div className="flex-shrink-0">
            <svg className="h-5 w-5 text-blue-500" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="ml-3">
            <h3 className="text-sm font-medium text-blue-800">Need more features?</h3>
            <div className="mt-2 text-sm text-blue-700">
              <p>For advanced analytics, user management, and system monitoring, contact your administrator for admin access.</p>
            </div>
          </div>
        </div>
      </div> */}
    </div>
  );
};

export default UserDashboard;
