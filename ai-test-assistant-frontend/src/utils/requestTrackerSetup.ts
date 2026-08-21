/**
 * Request Tracker Integration
 * 
 * This file sets up the request tracker with the axios instance
 * Import this file early in your application (e.g., in main.tsx or App.tsx)
 * 
 * Usage:
 * import './utils/requestTrackerSetup';
 */

import api from '../services/api';
import { setupRequestTrackerInterceptor } from './requestTrackerInterceptor';
import setupFetchTracker from './fetchTracker';
import './requestTrackerConsole'; // Load console utilities

// Ensure a client session id exists for tracking
try {
	if (!sessionStorage.getItem('client_session_id')) {
		const sid = `sess-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
		sessionStorage.setItem('client_session_id', sid);
	}
} catch {}

// Setup the axios interceptor and fetch tracker
setupRequestTrackerInterceptor(api);
setupFetchTracker();

// console.log(`
// ╔═══════════════════════════════════════════════════════════════╗
// ║                                                               ║
// ║          🎯 Request Tracker Initialized                      ║
// ║                                                               ║
// ║  All API requests will be automatically tracked               ║
// ║                                                               ║
// ║  Console Commands:                                            ║
// ║    rtUtils.help()           - Show all commands               ║
// ║    rtUtils.printSummary()   - View summary                    ║
// ║    rtUtils.printAllStats()  - View all tab stats              ║
// ║                                                               ║
// ║  Dashboard: Navigate to /request-tracker                      ║
// ║                                                               ║
// ╚═══════════════════════════════════════════════════════════════╝
// `);

export { default as requestTracker } from './requestTracker';
export { default as RequestTrackerUtils } from './requestTrackerConsole';
