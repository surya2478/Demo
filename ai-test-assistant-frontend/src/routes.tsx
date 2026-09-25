import React, { useEffect } from 'react'
import { Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { useAuth } from './hooks/useAuth'
import Loader from './components/Loader'
import Sidebar from './components/Sidebar'
import TopHeader from './components/layout/TopHeader'
import { PageHeaderProvider, usePageHeaderMeta } from './components/layout/PageHeaderContext'
import ProtectedRoute from './components/auth/ProtectedRoute'

// pages
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Users from './pages/Users'
import Sessions from './pages/Sessions'
import Settings from './pages/Settings'
import AuditLogs from './pages/AuditLogs'
import Reports from './pages/Reports'
import Team from './pages/Team'
import Unauthorized from './pages/Unauthorized'
import UserTimeSlots from './pages/UserTimeSlots'
import ReviewAndApproval from './pages/ReviewAndApproval'
import ReviewApprovalPage from './pages/review/ReviewApproval'
import RequestReview from './pages/review/RequestReview'
import ApprovedTestCases from './pages/ApprovedTestCases'

// Test Assistant and tabs
import RequestTrackerDashboard from './components/RequestTrackerDashboard';
import RequestTrackerReport from './pages/RequestTrackerReport';

import TestAssistant from './pages/TestAssistant'
import TestCases from './pages/test-assistant/TestCases'
// Automation Studio and tabs
import Automation from './pages/Automation'
import Runs from './pages/automation/Runs'
import Workbench from './pages/automation/Workbench'
import ScriptLab from './pages/automation/ScriptLab'
import Discovery from './pages/automation/Discovery'
import Visual from './pages/test-assistant/Visual'
import DataTab from './pages/test-assistant/DataTab'
import Changes from './pages/test-assistant/Changes'
import Unit from './pages/test-assistant/Unit'
import KB from './pages/test-assistant/KB'
import FigmaVlmPrompt from './pages/FigmaVlmPrompt'
import SquadKnowledgeBaseIngestion from './pages/SquadKnowledgeBaseIngestion'

const LayoutShell: React.FC = () => {
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false)
  const meta = usePageHeaderMeta()
  return (
    <div className="min-h-screen bg-app-canvas text-app-primary lg:flex">
      <Sidebar mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopHeader
          title={meta.title}
          subtitle={meta.subtitle}
          welcomeText={meta.welcomeText}
          actions={meta.actions}
          leading={meta.leading}
          eyebrow={meta.eyebrow}
          onSearch={meta.onSearch}
          searchPlaceholder={meta.searchPlaceholder}
          showSearch={meta.showSearch}
          showAssistant={meta.showAssistant}
          showNotifications={meta.showNotifications}
          notificationCount={meta.notificationCount}
          showDateRange={meta.showDateRange}
          dateRangeLabel={meta.dateRangeLabel}
          onDateRangeClick={meta.onDateRangeClick}
          onNotificationsClick={meta.onNotificationsClick}
          onAssistantClick={meta.onAssistantClick}
          onMobileMenuOpen={() => setMobileNavOpen(true)}
        />
        <main className="flex-1 px-4 py-4 sm:px-6 lg:px-7 lg:py-5">
          <div className="mx-auto w-full max-w-[1600px]">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}

const ProtectedLayout: React.FC = () => {
  const { isAuthenticated, loading, logout } = useAuth()

  useEffect(() => {
    const onLogout = (ev: any) => {
      console.debug('Received app:logout event', ev?.detail)
      logout()
    }
    window.addEventListener('app:logout', onLogout)
    return () => window.removeEventListener('app:logout', onLogout)
  }, [logout])

  if (loading) return <Loader />
  if (!isAuthenticated) return <Navigate to="/login" replace />

  return (
    <PageHeaderProvider>
      <LayoutShell />
    </PageHeaderProvider>
  )
}

const AppRoutes: React.FC = () => {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/unauthorized" element={<Unauthorized />} />

      <Route element={<ProtectedLayout />}>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />

        <Route
          path="dashboard"
          element={
            <ProtectedRoute allowedPermissions={['dashboard.view']}>
              <Dashboard />
            </ProtectedRoute>
          }
        />

        <Route
          path="users"
          element={
            <ProtectedRoute allowedPermissions={['user.manage', 'users.list']}>
              <Users />
            </ProtectedRoute>
          }
        />

        <Route
          path="user-time-slots"
          element={
            <ProtectedRoute allowedPermissions={['user.manage', 'users.list']}>
              <UserTimeSlots />
            </ProtectedRoute>
          }
        />

        <Route
          path="sessions"
          element={
            <ProtectedRoute allowedPermissions={['sessions.manage']}>
              <Sessions />
            </ProtectedRoute>
          }
        />

        <Route
          path="settings"
          element={
            <ProtectedRoute allowedPermissions={['settings.view', 'settings.manage']}>
              <Settings />
            </ProtectedRoute>
          }
        />

        <Route
          path="audit-logs"
          element={
            <ProtectedRoute allowedPermissions={['audit.view']}>
              <AuditLogs />
            </ProtectedRoute>
          }
        />

        <Route
          path="reports"
          element={
            <ProtectedRoute allowedPermissions={['reports.view']}>
              <Reports />
            </ProtectedRoute>
          }
        />

        <Route
          path="request-tracker-report"
          element={
            <ProtectedRoute allowedPermissions={['dashboard.view', 'admin']}>
              <RequestTrackerReport />
            </ProtectedRoute>
          }
        />

        <Route
          path="team"
          element={
            <ProtectedRoute allowedPermissions={['team.view']}>
              <Team />
            </ProtectedRoute>
          }
        />

        <Route
          path="manager-review"
          element={
            <ProtectedRoute allowedRoles={['admin', 'manager']}>
              <ReviewApprovalPage />
            </ProtectedRoute>
          }
        />
        {/* The previous Review & Approval page, kept reachable while the
            redesign beds in. */}
        <Route
          path="manager-review/classic"
          element={
            <ProtectedRoute allowedRoles={['admin', 'manager']}>
              <ReviewAndApproval />
            </ProtectedRoute>
          }
        />
        <Route
          path="manager-review/:requestId"
          element={
            <ProtectedRoute allowedRoles={['admin', 'manager']}>
              <RequestReview />
            </ProtectedRoute>
          }
        />

        <Route
          path="approved-test-cases"
          element={
            <ProtectedRoute allowedRoles={['admin', 'manager', 'user']}>
              <ApprovedTestCases />
            </ProtectedRoute>
          }
        />

        {/* Test Assistant with nested tab routes */}
        <Route
          path="test-assistant"
          element={
            <ProtectedRoute allowedPermissions={['testassistant.view']}>
              <TestAssistant />
            </ProtectedRoute>
          }
        >
          <Route index element={<DynamicTestAssistantIndex />} />
          <Route path="testcases" element={<TestCases />} />
          <Route path="visual" element={<Visual />} />
          <Route path="data" element={<DataTab />} />
          <Route path="changes" element={<Changes />} />
          <Route path="unit" element={<Unit />} />
          <Route path="kb" element={<KB />} />
        </Route>

        <Route
          path="settings/figma-vlm-prompt"
          element={
            <ProtectedRoute allowedPermissions={['testassistant.view']}>
              <FigmaVlmPrompt />
            </ProtectedRoute>
          }
        />

        <Route
          path="settings/squad-knowledge-base-ingestion"
          element={
            <ProtectedRoute allowedPermissions={['testassistant.view']}>
              <SquadKnowledgeBaseIngestion />
            </ProtectedRoute>
          }
        />

        {/* Dedicated Application Discovery & Application Model Route */}
        <Route
          path="discovery"
          element={<Navigate to="/automation/discovery" replace />}
        />
        <Route
          path="automation/discovery"
          element={
            <ProtectedRoute allowedPermissions={['automation.view']}>
              <Discovery />
            </ProtectedRoute>
          }
        />

        {/* Automation Studio with nested tab routes */}
        <Route
          path="automation"
          element={
            <ProtectedRoute allowedPermissions={['automation.view']}>
              <Automation />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="script-lab" replace />} />
          <Route path="candidates" element={<Navigate to="../workbench" replace />} />
          <Route path="workbench" element={<Workbench />} />
          <Route path="script-lab" element={<ScriptLab />} />
          <Route path="runs" element={<Runs />} />
          <Route path="runs/:runKey" element={<Runs />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

const DynamicTestAssistantIndex: React.FC = () => {
  const { user } = useAuth();
  const defaultTab = getDefaultTab(user);
  return <Navigate to={defaultTab} replace />;
};

const getDefaultTab = (user: any) => {
  // Priority order for tabs
  const tabPriority = ['testcases', 'visual', 'data', 'changes', 'unit','kb'];
  
  for (const tab of tabPriority) {
    const permission = `view_${tab}`;
    if (hasPermission(user, permission)) {
      return tab;
    }
  }
  return 'unauthorized'; // Fallback if no permissions
};

const hasPermission = (user: any, permission: string) => {
  if (!user) return false;
  const roles: string[] = (user.roles as string[]) || (user.role ? [user.role] : []);
  if (roles.some(r => String(r).toLowerCase() === 'admin')) return true;
  const perms: string[] = (user.permissions as string[]) || [];
  return perms.includes(permission) || roles.includes(permission);
};

export default AppRoutes
