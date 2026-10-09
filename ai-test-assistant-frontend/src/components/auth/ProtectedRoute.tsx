import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import Loader from '../Loader';

export const AFTER_LOGIN_KEY = 'afterLogin';
const AFTER_LOGIN_PATHS = '/automation/knowledge-base/capture-receive';

interface ProtectedRouteProps {
  children: React.ReactElement;
  allowedPermissions?: string[]; // permission keys, e.g. 'users.view'
  allowedRoles?: string[]; // fallback role check
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children, allowedPermissions = [], allowedRoles = [] }) => {
  const { user, isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    // The capture tool's receiving page must come back after sign-in: the tab
    // the tool opened is waiting there with the capture (Login reads this).
    if (location.pathname.startsWith(AFTER_LOGIN_PATHS)) {
      try { sessionStorage.setItem(AFTER_LOGIN_KEY, location.pathname + location.search) } catch { /* private mode */ }
    }
    return <Navigate to="/login" replace />;
  }

  // still loading user details -> show loader instead of redirecting
  if (loading) return <Loader />;

  // if allowedPermissions provided, require at least one permission
  if (allowedPermissions.length > 0) {
    const userPerms = user?.permissions ?? [];
    const has = allowedPermissions.some((p) => userPerms.includes(p));
    if (!has) return <Navigate to="/unauthorized" replace />;
  }

  // fallback: allowedRoles check (supports role or roles[])
  if (allowedRoles.length > 0) {
    const userRoles: string[] = [];
    if ((user as any)?.role) userRoles.push(String((user as any).role));
    if (Array.isArray((user as any)?.roles)) userRoles.push(...((user as any).roles as string[]));
    const hasRole = allowedRoles.some((r) => userRoles.includes(r));
    if (!hasRole) return <Navigate to="/unauthorized" replace />;
  }

  return children;
};

export default ProtectedRoute;