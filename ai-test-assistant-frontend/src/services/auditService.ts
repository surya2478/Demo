import api from './api';

export interface AuditLogPayload {
  actor?: string;
  actor_id?: string;
  actor_role?: string;
  module: string;
  submodule?: string;
  action: string;
  resource_type?: string;
  resource_id?: string;
  resource_name?: string;
  status?: 'initiated' |'success' | 'failure' | 'warning';
  details?: Record<string, any>;
}

export interface AuditLogResponse {
  id: number;
  actor_username: string;
  actor_role: string;
  module: string;
  action: string;
  resource_type?: string;
  resource_id?: string;
  status: string;
  created_at: string;
  details?: Record<string, any>;
}

/**
 * Log an audit event (fire-and-forget, non-blocking)
 * Call from any module when user performs action
 */
export const logEvent = async (payload: AuditLogPayload): Promise<void> => {
  try {
    await api.post('/audit/log', payload);
    console.debug('[auditService] logged event:', payload.action, payload.module);
  } catch (error) {
    console.warn('[auditService] failed to log event:', payload, error);
    // non-blocking — do not throw
  }
};

/**
 * Fetch user (non-admin) audit logs with optional filters
 */
export const fetchUserLogs = async (page = 1, size = 50, filters?: {module?: string; action?: string}): Promise<{items: AuditLogResponse[]; total: number}> => {
  try {
    const params: any = { page, size };
    if (filters?.module) params.module = filters.module;
    if (filters?.action) params.action = filters.action;
    const resp = await api.get('/audit/users', { params });
    console.log('[auditService] fetched user logs:', resp.data);  

    return resp.data;
  } catch (error) {
    console.error('[auditService] fetch user logs failed', error);
    throw error;
  }
};

/**
 * Fetch admin audit logs
 */
export const fetchAdminLogs = async (page = 1, size = 50, filters?: {module?: string; action?: string}): Promise<{items: AuditLogResponse[]; total: number}> => {
  try {
    const params: any = { page, size };
    if (filters?.module) params.module = filters.module;
    if (filters?.action) params.action = filters.action;
    const resp = await api.get('/audit/admins', { params });
    return resp.data;
  } catch (error) {
    console.error('[auditService] fetch admin logs failed', error);
    throw error;
  }
};

/**
 * Fetch audit summary
 */
export const fetchSummary = async (days = 7): Promise<any> => {
  try {
    const resp = await api.get('/audit/list', { params: { days } });
    return resp.data;
  } catch (error) {
    console.error('[auditService] fetch summary failed', error);
    throw error;
  }
};

export default {
  logEvent,
  fetchUserLogs,
  fetchAdminLogs,
  fetchSummary
};