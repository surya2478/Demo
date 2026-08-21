export interface Session {
  sessionId: string
  username: string
  ipAddress?: string
  userAgent?: string
  startedAt?: string
  lastActiveAt?: string
  expiresAt?: string
  status?: 'active' | 'expired' | 'revoked'
}