import React, { useState, useEffect } from 'react';
import RequestTrackerAPI from '../utils/requestTrackerAPI';
import { formatToDubaiTime } from '../utils/formatToDubaiTime';
import { 
  startOfWeek, 
  endOfWeek, 
  startOfMonth, 
  endOfMonth, 
  format, 
  parseISO,
  eachWeekOfInterval,
  eachMonthOfInterval,
  isWithinInterval
} from 'date-fns';

interface UserTokenDrilldownProps {
  username: string;
  onClose: () => void;
}

interface RequestLog {
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
  request_data?: any;
  response_data?: any;
}

interface WeeklyData {
  weekStart: string;
  weekEnd: string;
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  totalTokens: number;
  promptTokens: number;
  responseTokens: number;
  avgTokensPerRequest: number;
}

interface MonthlyData {
  month: string;
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  totalTokens: number;
  promptTokens: number;
  responseTokens: number;
  avgTokensPerRequest: number;
}

// Helper function to convert status code to user-friendly message
const getStatusMessage = (statusCode: number): string => {
  if (statusCode >= 200 && statusCode < 300) return 'Success';
  if (statusCode >= 400 && statusCode < 500) return 'Client Error';
  if (statusCode >= 500) return 'Server Error';
  if (statusCode >= 300 && statusCode < 400) return 'Redirect';
  return 'Unknown';
};

// Helper function to get status color classes
const getStatusColorClass = (statusCode: number): string => {
  if (statusCode >= 200 && statusCode < 300) return 'bg-green-100 text-green-700';
  if (statusCode >= 400 && statusCode < 500) return 'bg-red-100 text-red-700';
  if (statusCode >= 500) return 'bg-red-200 text-red-900';
  if (statusCode >= 300 && statusCode < 400) return 'bg-yellow-100 text-yellow-700';
  return 'bg-gray-100 text-gray-700';
};

const UserTokenDrilldown: React.FC<UserTokenDrilldownProps> = ({ username, onClose }) => {
  const [loading, setLoading] = useState(true);
  const [requests, setRequests] = useState<RequestLog[]>([]);
  const [weeklyData, setWeeklyData] = useState<WeeklyData[]>([]);
  const [monthlyData, setMonthlyData] = useState<MonthlyData[]>([]);
  const [activeView, setActiveView] = useState<'requests' | 'weekly' | 'monthly'>('requests');

  useEffect(() => {
    fetchUserData();
  }, [username]);

  const fetchUserData = async () => {
    setLoading(true);
    try {
      const logsResponse = await RequestTrackerAPI.getLogs();
    //   console.log('Logs response:', logsResponse);
      const logs = Array.isArray(logsResponse) ? logsResponse : logsResponse.logs || [];
      const userLogs = logs.filter((log: RequestLog) => log.user === username);
      setRequests(userLogs);

    //   console.log('Fetched logs for user:', username, userLogs);
      // Process weekly data
      if (userLogs.length > 0) {
        const dates = userLogs.map((log: RequestLog) => parseISO(log.timestamp));
        const minDate = new Date(Math.min(...dates.map((d: Date) => d.getTime())));
        const maxDate = new Date(Math.max(...dates.map((d: Date) => d.getTime())));

        // Weekly aggregation
        const weeks = eachWeekOfInterval({ start: minDate, end: maxDate }, { weekStartsOn: 1 });
        const weeklyAgg: WeeklyData[] = weeks.map(weekStart => {
          const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
          const weekLogs = userLogs.filter((log: RequestLog) => {
            const logDate = parseISO(log.timestamp);
            return isWithinInterval(logDate, { start: weekStart, end: weekEnd });
          });

          const totalTokens = weekLogs.reduce((sum: number, log: RequestLog) => sum + (log.totalTokens || 0), 0);
          const promptTokens = weekLogs.reduce((sum: number, log: RequestLog) => sum + (log.promptTokens || 0), 0);
          const responseTokens = weekLogs.reduce((sum: number, log: RequestLog) => sum + (log.responseTokens || 0), 0);
          const successful = weekLogs.filter((log: RequestLog) => log.responseStatus >= 200 && log.responseStatus < 300).length;

          return {
            weekStart: format(weekStart, 'MMM dd, yyyy'),
            weekEnd: format(weekEnd, 'MMM dd, yyyy'),
            requests: weekLogs.length,
            successfulRequests: successful,
            failedRequests: weekLogs.length - successful,
            totalTokens,
            promptTokens,
            responseTokens,
            avgTokensPerRequest: weekLogs.length > 0 ? Math.round(totalTokens / weekLogs.length) : 0
          };
        }).filter(week => week.requests > 0);

        setWeeklyData(weeklyAgg);

        // Monthly aggregation
        const months = eachMonthOfInterval({ start: minDate, end: maxDate });
        const monthlyAgg: MonthlyData[] = months.map(monthStart => {
          const monthEnd = endOfMonth(monthStart);
          const monthLogs = userLogs.filter((log: RequestLog) => {
            const logDate = parseISO(log.timestamp);
            return isWithinInterval(logDate, { start: monthStart, end: monthEnd });
          });

          const totalTokens = monthLogs.reduce((sum: number, log: RequestLog) => sum + (log.totalTokens || 0), 0);
          const promptTokens = monthLogs.reduce((sum: number, log: RequestLog) => sum + (log.promptTokens || 0), 0);
          const responseTokens = monthLogs.reduce((sum: number, log: RequestLog) => sum + (log.responseTokens || 0), 0);
          const successful = monthLogs.filter((log: RequestLog) => log.responseStatus >= 200 && log.responseStatus < 300).length;

          return {
            month: format(monthStart, 'MMMM yyyy'),
            requests: monthLogs.length,
            successfulRequests: successful,
            failedRequests: monthLogs.length - successful,
            totalTokens,
            promptTokens,
            responseTokens,
            avgTokensPerRequest: monthLogs.length > 0 ? Math.round(totalTokens / monthLogs.length) : 0
          };
        }).filter(month => month.requests > 0);

        setMonthlyData(monthlyAgg);
      }
    } catch (error) {
      console.error('Error fetching user data:', error);
    } finally {
      setLoading(false);
    }
  };

//   console.log('Rendering UserTokenDrilldown with requests:', requests);
  const totalTokens = requests.reduce((sum, req) => sum + (req.totalTokens || 0), 0);
  const totalPrompt = requests.reduce((sum, req) => sum + (req.promptTokens || 0), 0);
  const totalResponse = requests.reduce((sum, req) => sum + (req.responseTokens || 0), 0);
  const successfulRequests = requests.filter(req => req.responseStatus >= 200 && req.responseStatus < 300).length;
  const successRate = requests.length > 0 ? ((successfulRequests / requests.length) * 100).toFixed(1) : '0';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-hidden">
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-7xl h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="bg-white border-b-2 border-red-600 px-6 py-4 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-red-100 rounded-lg">
              <svg className="w-6 h-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            </div>
            <div>
              <h2 className="text-xl font-bold text-red-600">{username} - Token Usage Details</h2>
              <p className="text-sm text-gray-600">Comprehensive request and token consumption analysis</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
            aria-label="Close modal"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Summary Stats */}
        <div className="px-6 py-4 bg-gray-50 border-b flex-shrink-0">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="bg-white p-3 rounded-lg border border-gray-200">
              <div className="text-xs text-gray-500 mb-1">Total Requests</div>
              <div className="text-2xl font-bold text-gray-900">{requests.length}</div>
            </div>
            <div className="bg-white p-3 rounded-lg border border-gray-200">
              <div className="text-xs text-gray-500 mb-1">Success Rate</div>
              <div className="text-2xl font-bold text-green-600">{successRate}%</div>
            </div>
            <div className="bg-white p-3 rounded-lg border border-gray-200">
              <div className="text-xs text-gray-500 mb-1">Total Tokens</div>
              <div className="text-2xl font-bold text-red-600">{totalTokens.toLocaleString()}</div>
            </div>
            <div className="bg-white p-3 rounded-lg border border-gray-200">
              <div className="text-xs text-gray-500 mb-1">Prompt Tokens</div>
              <div className="text-2xl font-bold text-app-brand-700">{totalPrompt.toLocaleString()}</div>
            </div>
            <div className="bg-white p-3 rounded-lg border border-gray-200">
              <div className="text-xs text-gray-500 mb-1">Response Tokens</div>
              <div className="text-2xl font-bold text-purple-600">{totalResponse.toLocaleString()}</div>
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="px-6 py-3 bg-white border-b flex-shrink-0">
          <div className="flex gap-2">
            <button
              onClick={() => setActiveView('requests')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                activeView === 'requests'
                  ? 'bg-red-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              All Requests ({requests.length})
            </button>
            <button
              onClick={() => setActiveView('weekly')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                activeView === 'weekly'
                  ? 'bg-red-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              Weekly Analysis ({weeklyData.length})
            </button>
            <button
              onClick={() => setActiveView('monthly')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                activeView === 'monthly'
                  ? 'bg-red-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              Monthly Analysis ({monthlyData.length})
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-hidden min-h-0">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-600"></div>
            </div>
          ) : (
            <>
              {/* All Requests View */}
              {activeView === 'requests' && (
                <div className="h-full overflow-y-auto overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead className="sticky top-0 z-10 shadow-md">
                      <tr className="bg-white border-b-2 border-red-600">
                        <th className="px-4 py-3 text-left text-xs font-semibold text-red-600 uppercase tracking-wider bg-white border-b-2 border-red-600">S.No</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-red-600 uppercase tracking-wider bg-white border-b-2 border-red-600">Timestamp</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-red-600 uppercase tracking-wider bg-white border-b-2 border-red-600">Tab</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-red-600 uppercase tracking-wider bg-white border-b-2 border-red-600">Endpoint</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-red-600 uppercase tracking-wider bg-white border-b-2 border-red-600">Status</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-red-600 uppercase tracking-wider bg-white border-b-2 border-red-600">Duration</th>
                        <th className="px-4 py-3 text-right text-xs font-semibold text-red-600 uppercase tracking-wider bg-white border-b-2 border-red-600">Prompt</th>
                        <th className="px-4 py-3 text-right text-xs font-semibold text-red-600 uppercase tracking-wider bg-white border-b-2 border-red-600">Response</th>
                        <th className="px-4 py-3 text-right text-xs font-semibold text-red-600 uppercase tracking-wider bg-white border-b-2 border-red-600">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {requests.map((req, index) => (
                        <tr key={req.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-sm text-gray-900 font-semibold">
                            {index + 1}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600">
                            {formatToDubaiTime(req.timestamp)}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            <span className="rounded-full bg-app-brand-75 px-2 py-1 text-xs font-medium text-app-brand-800">
                              {req.tab}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-900 font-mono text-xs">
                            {req.endpoint}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            <span className={`px-2 py-1 rounded text-xs font-medium ${getStatusColorClass(req.responseStatus)}`}>
                              {getStatusMessage(req.responseStatus)}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600">
                            {req.duration} ms
                          </td>
                          <td className="px-4 py-3 text-right text-sm font-medium text-app-brand-700">
                            {(req.promptTokens || 0).toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-sm text-right text-purple-600 font-medium">
                            {(req.responseTokens || 0).toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-sm text-right text-red-600 font-bold">
                            {(req.totalTokens || 0).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {requests.length === 0 && (
                    <div className="text-center py-12">
                      <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M4 4a2 2 0 00-2 2v4a2 2 0 002 2V6h10a2 2 0 00-2-2H4zm2 6a2 2 0 012-2h8a2 2 0 012 2v4a2 2 0 01-2 2H8a2 2 0 01-2-2v-4zm6 4a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
                      </svg>
                      <p className="text-gray-500">No requests found for this user</p>
                    </div>
                  )}
                </div>
              )}

              {/* Weekly Analysis View */}
              {activeView === 'weekly' && (
                <div className="h-full overflow-y-auto overflow-x-hidden p-6">
                  <div className="space-y-4">
                  {weeklyData.map((week, idx) => (
                    <div key={idx} className="bg-white border-2 border-gray-200 rounded-lg p-4 hover:border-red-300 transition-colors">
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <h3 className="font-semibold text-gray-900">
                            Week: {week.weekStart} - {week.weekEnd}
                          </h3>
                          <p className="text-sm text-gray-500 mt-1">
                            {week.requests} requests • {((week.successfulRequests / week.requests) * 100).toFixed(1)}% success rate
                          </p>
                        </div>
                        <div className="text-right">
                          <div className="text-2xl font-bold text-red-600">
                            {week.totalTokens.toLocaleString()}
                          </div>
                          <div className="text-xs text-gray-500">total tokens</div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                        <div className="bg-gray-50 p-3 rounded">
                          <div className="text-xs text-gray-500 mb-1">Successful</div>
                          <div className="text-lg font-semibold text-green-600">{week.successfulRequests}</div>
                        </div>
                        <div className="bg-gray-50 p-3 rounded">
                          <div className="text-xs text-gray-500 mb-1">Failed</div>
                          <div className="text-lg font-semibold text-red-600">{week.failedRequests}</div>
                        </div>
                        <div className="bg-gray-50 p-3 rounded">
                          <div className="text-xs text-gray-500 mb-1">Prompt Tokens</div>
                          <div className="text-lg font-semibold text-app-brand-700">{week.promptTokens.toLocaleString()}</div>
                        </div>
                        <div className="bg-gray-50 p-3 rounded">
                          <div className="text-xs text-gray-500 mb-1">Response Tokens</div>
                          <div className="text-lg font-semibold text-purple-600">{week.responseTokens.toLocaleString()}</div>
                        </div>
                        <div className="bg-gray-50 p-3 rounded">
                          <div className="text-xs text-gray-500 mb-1">Avg/Request</div>
                          <div className="text-lg font-semibold text-gray-900">{week.avgTokensPerRequest}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                  {weeklyData.length === 0 && (
                    <div className="text-center py-12">
                      <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clipRule="evenodd" />
                      </svg>
                      <p className="text-gray-500">No weekly data available</p>
                    </div>
                  )}
                  </div>
                </div>
              )}

              {/* Monthly Analysis View */}
              {activeView === 'monthly' && (
                <div className="h-full overflow-y-auto overflow-x-hidden p-6">
                  <div className="space-y-4">
                  {monthlyData.map((month, idx) => (
                    <div key={idx} className="bg-white border-2 border-gray-200 rounded-lg p-4 hover:border-red-300 transition-colors">
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <h3 className="font-semibold text-gray-900 text-lg">
                            {month.month}
                          </h3>
                          <p className="text-sm text-gray-500 mt-1">
                            {month.requests} requests • {((month.successfulRequests / month.requests) * 100).toFixed(1)}% success rate
                          </p>
                        </div>
                        <div className="text-right">
                          <div className="text-3xl font-bold text-red-600">
                            {month.totalTokens.toLocaleString()}
                          </div>
                          <div className="text-xs text-gray-500">total tokens</div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                        <div className="bg-gray-50 p-3 rounded">
                          <div className="text-xs text-gray-500 mb-1">Successful</div>
                          <div className="text-lg font-semibold text-green-600">{month.successfulRequests}</div>
                        </div>
                        <div className="bg-gray-50 p-3 rounded">
                          <div className="text-xs text-gray-500 mb-1">Failed</div>
                          <div className="text-lg font-semibold text-red-600">{month.failedRequests}</div>
                        </div>
                        <div className="bg-gray-50 p-3 rounded">
                          <div className="text-xs text-gray-500 mb-1">Prompt Tokens</div>
                          <div className="text-lg font-semibold text-app-brand-700">{month.promptTokens.toLocaleString()}</div>
                        </div>
                        <div className="bg-gray-50 p-3 rounded">
                          <div className="text-xs text-gray-500 mb-1">Response Tokens</div>
                          <div className="text-lg font-semibold text-purple-600">{month.responseTokens.toLocaleString()}</div>
                        </div>
                        <div className="bg-gray-50 p-3 rounded">
                          <div className="text-xs text-gray-500 mb-1">Avg/Request</div>
                          <div className="text-lg font-semibold text-gray-900">{month.avgTokensPerRequest}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                  {monthlyData.length === 0 && (
                    <div className="text-center py-12">
                      <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clipRule="evenodd" />
                      </svg>
                      <p className="text-gray-500">No monthly data available</p>
                    </div>
                  )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default UserTokenDrilldown;
