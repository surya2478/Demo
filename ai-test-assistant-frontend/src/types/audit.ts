export interface AuditLog {
  id: string;
  timestamp: string;
  event: string;
  detail: string;
  actor: string;
  action: string;
  status: 'success' | 'failure' | 'warning';
  resource: string;
  ipAddress?: string;
}

export type AuditFilter = {
  startDate?: Date;
  endDate?: Date;
  actor?: string;
  action?: string;
  status?: string;
  resource?: string;
}