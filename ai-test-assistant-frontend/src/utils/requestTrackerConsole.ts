/**
 * Request Tracker Console Utilities
 * Helper functions to use in browser console for quick insights
 * 
 * Usage in browser console:
 * 
 * // Import the tracker
 * import requestTracker from './utils/requestTracker'
 * 
 * // Or if exposed globally (see below)
 * window.requestTracker.getSummary()
 * window.requestTracker.getStats('testcases')
 * window.requestTracker.generateReport()
 */

import requestTracker from './requestTracker';

// Expose to window for console access
declare global {
  interface Window {
    requestTracker: typeof requestTracker;
    rtUtils: typeof RequestTrackerUtils;
  }
}

export class RequestTrackerUtils {
  /**
   * Print summary to console
   */
  static printSummary() {
    const summary = requestTracker.getSummary();
    console.log('\n=== REQUEST TRACKER SUMMARY ===\n');
    console.log(`Total Requests: ${summary.totalRequests}`);
    console.log(`Successful: ${summary.successfulRequests}`);
    console.log(`Failed: ${summary.failedRequests}`);
    console.log(`Success Rate: ${summary.totalRequests > 0 ? ((summary.successfulRequests / summary.totalRequests) * 100).toFixed(2) : 0}%\n`);
    
    console.log('By Tab:');
    console.table(summary.byTab);
  }

  /**
   * Print detailed stats for all tabs
   */
  static printAllStats() {
    const stats = requestTracker.getAllStats();
    console.log('\n=== REQUEST STATISTICS BY TAB ===\n');
    console.table(stats.map(s => ({
      Tab: s.tab.toUpperCase(),
      Total: s.totalRequests,
      Success: s.successfulRequests,
      Failed: s.failedRequests,
      'Success %': s.totalRequests > 0 ? ((s.successfulRequests / s.totalRequests) * 100).toFixed(1) + '%' : '0%',
      'Avg Response': s.averageResponseTime.toFixed(2) + 'ms',
      'Last Request': s.lastRequestTime || 'N/A'
    })));
  }

  /**
   * Print stats for a specific tab
   */
  static printTabStats(tab: string) {
    const stat = requestTracker.getStats(tab as any);
    if (!stat) {
      console.error(`Tab "${tab}" not found`);
      return;
    }

    console.log(`\n=== ${tab.toUpperCase()} TAB STATISTICS ===\n`);
    console.log(`Total Requests: ${stat.totalRequests}`);
    console.log(`Successful: ${stat.successfulRequests}`);
    console.log(`Failed: ${stat.failedRequests}`);
    console.log(`Success Rate: ${stat.totalRequests > 0 ? ((stat.successfulRequests / stat.totalRequests) * 100).toFixed(2) : 0}%`);
    console.log(`Average Response Time: ${stat.averageResponseTime.toFixed(2)}ms`);
    console.log(`Last Request: ${stat.lastRequestTime || 'N/A'}\n`);
    
    if (Object.keys(stat.endpoints).length > 0) {
      console.log('Endpoints:');
      console.table(
        Object.entries(stat.endpoints)
          .sort((a, b) => b[1] - a[1])
          .map(([endpoint, count]) => ({ Endpoint: endpoint, Requests: count }))
      );
    }
  }

  /**
   * Print recent logs
   */
  static printRecentLogs(limit = 10) {
    const logs = requestTracker.getLogs();
    const recent = logs.slice(-limit).reverse();
    
    console.log(`\n=== RECENT ${limit} REQUESTS ===\n`);
    console.table(recent.map(log => ({
      Time: new Date(log.timestamp).toLocaleTimeString(),
      Tab: log.tab.toUpperCase(),
      Method: log.method,
      Endpoint: log.endpoint,
      Status: log.responseStatus || (log.error ? 'Error' : 'Pending'),
      Duration: log.duration ? `${log.duration}ms` : 'N/A'
    })));
  }

  /**
   * Print logs for specific tab
   */
  static printTabLogs(tab: string, limit = 20) {
    const logs = requestTracker.getLogs({ tab: tab as any });
    const recent = logs.slice(-limit).reverse();
    
    console.log(`\n=== ${tab.toUpperCase()} TAB - RECENT ${limit} REQUESTS ===\n`);
    console.table(recent.map(log => ({
      Time: new Date(log.timestamp).toLocaleTimeString(),
      Method: log.method,
      Endpoint: log.endpoint,
      Status: log.responseStatus || (log.error ? 'Error' : 'Pending'),
      Duration: log.duration ? `${log.duration}ms` : 'N/A'
    })));
  }

  /**
   * Print failed requests
   */
  static printFailedRequests() {
    const logs = requestTracker.getLogs({ status: 'failed' });
    
    console.log(`\n=== FAILED REQUESTS (${logs.length}) ===\n`);
    console.table(logs.map(log => ({
      Time: new Date(log.timestamp).toLocaleTimeString(),
      Tab: log.tab.toUpperCase(),
      Method: log.method,
      Endpoint: log.endpoint,
      Status: log.responseStatus || 'Error',
      Error: log.error || 'N/A'
    })));
  }

  /**
   * Print pending requests
   */
  static printPendingRequests() {
    const logs = requestTracker.getLogs({ status: 'pending' });
    
    console.log(`\n=== PENDING REQUESTS (${logs.length}) ===\n`);
    console.table(logs.map(log => ({
      Time: new Date(log.timestamp).toLocaleTimeString(),
      Tab: log.tab.toUpperCase(),
      Method: log.method,
      Endpoint: log.endpoint
    })));
  }

  /**
   * Get top endpoints across all tabs
   */
  static printTopEndpoints(limit = 10) {
    const stats = requestTracker.getAllStats();
    const endpointCounts: Record<string, number> = {};
    
    stats.forEach(stat => {
      Object.entries(stat.endpoints).forEach(([endpoint, count]) => {
        endpointCounts[endpoint] = (endpointCounts[endpoint] || 0) + count;
      });
    });
    
    const sorted = Object.entries(endpointCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);
    
    console.log(`\n=== TOP ${limit} ENDPOINTS ===\n`);
    console.table(sorted.map(([endpoint, count]) => ({ Endpoint: endpoint, Requests: count })));
  }

  /**
   * Export report to console
   */
  static printReport() {
    const report = requestTracker.generateReport();
    console.log(report);
  }

  /**
   * Download logs as JSON
   */
  static downloadJSON() {
    const data = requestTracker.exportLogs();
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `request-tracker-${new Date().toISOString()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log('✓ Downloaded request logs as JSON');
  }

  /**
   * Download logs as CSV
   */
  static downloadCSV() {
    const data = requestTracker.exportLogsCSV();
    const blob = new Blob([data], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `request-tracker-${new Date().toISOString()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log('✓ Downloaded request logs as CSV');
  }

  /**
   * Enable/disable tracking
   */
  static enable() {
    requestTracker.setEnabled(true);
    console.log('✓ Request tracking enabled');
  }

  static disable() {
    requestTracker.setEnabled(false);
    console.log('✓ Request tracking disabled');
  }

  /**
   * Clear all logs
   */
  static clearAll() {
    if (confirm('Are you sure you want to clear all request logs?')) {
      requestTracker.clear();
      console.log('✓ All request logs cleared');
    }
  }

  /**
   * Clear logs for specific tab
   */
  static clearTab(tab: string) {
    if (confirm(`Are you sure you want to clear logs for ${tab}?`)) {
      requestTracker.clear(tab as any);
      console.log(`✓ Logs cleared for ${tab}`);
    }
  }

  /**
   * Print help
   */
  static help() {
    console.log(`
=== REQUEST TRACKER CONSOLE UTILITIES ===

Available commands:

  rtUtils.printSummary()              - Print overall summary
  rtUtils.printAllStats()             - Print stats for all tabs
  rtUtils.printTabStats(tab)          - Print stats for specific tab
  rtUtils.printRecentLogs(limit)      - Print recent requests
  rtUtils.printTabLogs(tab, limit)    - Print requests for specific tab
  rtUtils.printFailedRequests()       - Print all failed requests
  rtUtils.printPendingRequests()      - Print pending requests
  rtUtils.printTopEndpoints(limit)    - Print most requested endpoints
  rtUtils.printReport()               - Print full report
  rtUtils.downloadJSON()              - Download logs as JSON
  rtUtils.downloadCSV()               - Download logs as CSV
  rtUtils.enable()                    - Enable tracking
  rtUtils.disable()                   - Disable tracking
  rtUtils.clearAll()                  - Clear all logs
  rtUtils.clearTab(tab)               - Clear logs for specific tab
  rtUtils.help()                      - Show this help

Tabs: testcases, visual, data, changes, unit, kb

Examples:
  rtUtils.printSummary()
  rtUtils.printTabStats('testcases')
  rtUtils.printRecentLogs(20)
  rtUtils.printFailedRequests()
  rtUtils.downloadJSON()
    `);
  }
}

// Expose to window for global access
if (typeof window !== 'undefined') {
  window.requestTracker = requestTracker;
  window.rtUtils = RequestTrackerUtils;
  
  console.log(`
✓ Request Tracker utilities loaded!
  Type 'rtUtils.help()' in console for available commands
  `);
}

export default RequestTrackerUtils;
