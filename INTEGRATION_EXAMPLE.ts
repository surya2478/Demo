/**
 * INTEGRATION EXAMPLE
 * 
 * This file shows how to integrate the Request Tracker into your existing app.
 * Follow these steps to get started.
 */

// ============================================================================
// STEP 1: Update src/main.tsx or src/index.tsx
// ============================================================================

/*
// Add this import at the top of your main entry file
import './utils/requestTrackerSetup';

// Example main.tsx:
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import './utils/requestTrackerSetup'; // <-- Add this line

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
*/

// ============================================================================
// STEP 2: Add Dashboard Route
// ============================================================================

/*
// In src/routes.tsx or your routing configuration:

import RequestTrackerDashboard from './components/RequestTrackerDashboard';

// Add this route:
{
  path: '/request-tracker',
  element: <RequestTrackerDashboard />
}

// Complete example:
export const routes = [
  {
    path: '/',
    element: <Layout />,
    children: [
      { path: 'dashboard', element: <Dashboard /> },
      { path: 'test-assistant', element: <TestAssistant /> },
      { path: 'request-tracker', element: <RequestTrackerDashboard /> }, // <-- Add this
      // ... other routes
    ]
  }
];
*/

// ============================================================================
// STEP 3: (Optional) Add to Navigation
// ============================================================================

/*
// Add to your navigation menu (e.g., Sidebar.tsx or Navbar.tsx):

import { Link } from 'react-router-dom';

<Link to="/request-tracker" className="nav-link">
  📊 Request Tracker
</Link>

// Or add to your navigation config:
const navigation = [
  { name: 'Dashboard', path: '/dashboard', icon: DashboardIcon },
  { name: 'Test Assistant', path: '/test-assistant', icon: TestIcon },
  { name: 'Request Tracker', path: '/request-tracker', icon: ChartIcon }, // <-- Add this
  // ... other items
];
*/

// ============================================================================
// STEP 4: (Optional) Use Explicit Tab Sources in Your Components
// ============================================================================

/*
// In your Test Assistant tab components, you can explicitly set the tab source
// for better tracking accuracy:

import api from '../../services/api';
import { withTabSource } from '../../utils/requestTrackerInterceptor';

// Example in TestCases.tsx:
const handleGenerate = async () => {
  try {
    const response = await api.post(
      '/generate-test-cases',
      requestData,
      withTabSource('testcases') // <-- Add this
    );
    // ... handle response
  } catch (error) {
    // ... handle error
  }
};

// Example in Visual.tsx:
const response = await api.post(
  '/visual-test',
  formData,
  withTabSource('visual') // <-- Add this
);

// Example in DataTab.tsx:
const response = await api.post(
  '/generate-test-data',
  data,
  withTabSource('data') // <-- Add this
);

// Same for other tabs: changes, unit, kb
*/

// ============================================================================
// STEP 5: That's it! You're done!
// ============================================================================

/*
Now you can:

1. View the dashboard at http://localhost:5173/request-tracker (or your URL)

2. Use console commands:
   - Open browser console (F12)
   - Type: rtUtils.help()
   - View summary: rtUtils.printSummary()
   - View stats: rtUtils.printAllStats()

3. Export data:
   - From dashboard: Click "Export JSON" or "Export CSV"
   - From console: rtUtils.downloadJSON() or rtUtils.downloadCSV()

4. Analyze with Python:
   - Export JSON file
   - Run: python analyze_requests.py <filename>.json
*/

// ============================================================================
// COMPLETE INTEGRATION CHECKLIST
// ============================================================================

/*
✅ Created files:
   - src/utils/requestTracker.ts
   - src/utils/requestTrackerInterceptor.ts
   - src/utils/requestTrackerConsole.ts
   - src/utils/requestTrackerSetup.ts
   - src/components/RequestTrackerDashboard.tsx
   - REQUEST_TRACKER_SETUP.md
   - REQUEST_TRACKER_README.md
   - analyze_requests.py

☐ TODO - Add to main entry file:
   import './utils/requestTrackerSetup';

☐ TODO - Add dashboard route:
   { path: '/request-tracker', element: <RequestTrackerDashboard /> }

☐ TODO - (Optional) Add to navigation menu

☐ TODO - (Optional) Add explicit tab sources with withTabSource()

☐ TODO - Test it out!
   - Make some requests from Test Assistant tabs
   - Check the dashboard
   - Try console commands
*/

// ============================================================================
// EXAMPLE: Minimal Integration
// ============================================================================

/*
// src/main.tsx (MINIMAL CHANGE):
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import './utils/requestTrackerSetup'; // <-- ONLY ADD THIS LINE

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// That's the MINIMUM required change!
// The tracker will work automatically.
// Dashboard and console are optional but recommended.
*/

// ============================================================================
// TROUBLESHOOTING
// ============================================================================

/*
If requests aren't being tracked:

1. Check console for initialization message:
   "🎯 Request Tracker Initialized"

2. Verify tracking is enabled:
   Open console, type: requestTracker.isEnabled()
   
3. Check if axios instance is correct:
   The interceptor is attached to the axios instance in src/services/api.ts
   Make sure your components use this instance

4. Check localStorage:
   localStorage.getItem('requestTracker_logs')
   
5. Make a test request and check:
   rtUtils.printSummary()
*/

export default {};
