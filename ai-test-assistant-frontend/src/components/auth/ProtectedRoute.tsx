import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import Loader from '../Loader';

interface ProtectedRouteProps {
  children: React.ReactElement;
  allowedPermissions?: string[]; // permission keys, e.g. 'users.view'
  allowedRoles?: string[]; // fallback role check
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children, allowedPermissions = [], allowedRoles = [] }) => {
  const { user, isAuthenticated, loading } = useAuth();

  if (!isAuthenticated) return <Navigate to="/login" replace />;

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