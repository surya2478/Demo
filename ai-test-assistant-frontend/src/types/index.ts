// src/types/index.ts

export type RoleName = "Admin" | "QA" | "Manager" | "Tester";

export type UserRole = "admin" | "manager" | "user";

export interface User {
  id: number;
  username: string;
  email: string;
  role?: UserRole;
  roles?: UserRole[];
  // permissions array returned by /user/me (page keys or permission strings)
  permissions?: string[];
  // server sends must_change_password; map to mustChangePassword in client
  must_change_password?: boolean;
  token_allocation?: number;
  allowed_time_start?: string | null;
  allowed_time_end?: string | null;
  category?: string;
  is_active?: boolean;
  created_at?: string;
  modified_at?: string;
  auth_source?: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface DashboardData {
  // Define the structure of the data to be displayed on the dashboard
  totalUsers: number;
  totalSales: number;
  // Add more fields as necessary
}

export interface AuditLog {
  id: number;
  actor: string;
  action: string;
  resource: string;
  details: string;
  timestamp: string;
}

export interface Setting {
  id: number;
  key: string;
  value: string;
}

export interface SessionRecord {
  id: number;
  username: string;
  token_id: string;
  created_at: string;
  expires_at: string;
  is_active: boolean;
}

export interface DashboardStats {
  users: number;
  active_sessions: number;
  recent_audits: {
    actor: string;
    action: string;
    resource: string;
    timestamp: string;
  }[];
}

export interface MenuItem {
  path: string;
  label: string;
  icon?: string;
  permission?: string; // permission required to show this item
  allowedRoles?: UserRole[];
}
