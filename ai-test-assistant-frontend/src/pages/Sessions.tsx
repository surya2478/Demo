import React, { useEffect, useMemo, useRef, useState } from 'react'
import { format, formatDistanceToNowStrict } from 'date-fns'
import {
  HiOutlineStatusOnline,
  HiOutlineUserGroup,
  HiOutlineClock,
  HiOutlineExclamationCircle,
  HiOutlineSearch,
  HiOutlineX,
  HiOutlineRefresh,
  HiOutlineTrash,
  HiOutlineLogout,
  HiOutlineDesktopComputer,
  HiOutlineGlobeAlt
} from 'react-icons/hi'
import sessionService from '../services/sessionService'
import Loader from '../components/Loader'
import Notification from '../components/Notification'
import { useAuth } from '../hooks/useAuth'
import type { Session } from '../types/session'
import { logApiEvent } from '../utils/auditApiHelper'
import { maskValue } from '../utils/auditDetailsHelper'
import SectionCard from '../components/ui/SectionCard'
import StatusBadge from '../components/ui/StatusBadge'
import MetricCard from '../components/ui/MetricCard'
import IconBadge from '../components/ui/IconBadge'
import EmptyState from '../components/ui/EmptyState'
import { usePageHeader } from '../components/layout/PageHeaderContext'
import { theme } from '../styles/theme'

const initials = (name?: string) => {
  if (!name) return 'U'
  const parts = name.split(/[\s._-]+/).filter(Boolean)
  const a = parts[0]?.[0] ?? ''
  const b = parts[1]?.[0] ?? ''
  return ((a + b) || name[0]).toUpperCase()
}

const avatarGradient = (seed: string) => {
  const palette = [
    'linear-gradient(135deg, #B71920, #7A0B0D)',
    'linear-gradient(135deg, #D52B31, #941216)',
    'linear-gradient(135deg, #941216, #65080A)',
    'linear-gradient(135deg, #F1A4A6, #B71920)',
    'linear-gradient(135deg, #7A0B0D, #4D0507)'
  ]
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

const parseBrowser = (ua?: string): string => {
  if (!ua) return 'Unknown device'
  const lower = ua.toLowerCase()
  if (lower.includes('edg/')) return 'Edge'
  if (lower.includes('chrome/') && !lower.includes('chromium')) return 'Chrome'
  if (lower.includes('safari/') && !lower.includes('chrome')) return 'Safari'
  if (lower.includes('firefox/')) return 'Firefox'
  if (lower.includes('opr/') || lower.includes('opera')) return 'Opera'
  return 'Browser'
}

const parseOS = (ua?: string): string => {
  if (!ua) return ''
  const lower = ua.toLowerCase()
  if (lower.includes('windows')) return 'Windows'
  if (lower.includes('mac os')) return 'macOS'
  if (lower.includes('iphone') || lower.includes('ios')) return 'iOS'
  if (lower.includes('android')) return 'Android'
  if (lower.includes('linux')) return 'Linux'
  return ''
}

const Sessions: React.FC = () => {
  const { user, logout } = useAuth()
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)
  const pollingRef = useRef<number | null>(null)

  const [error, setError] = useState<string | null>(null)
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [query, setQuery] = useState('')
  const didLoadRef = useRef(false)

  const [modalVisible, setModalVisible] = useState(false)
  const [modalMessage, setModalMessage] = useState<string>('')
  const [modalCountdown, setModalCountdown] = useState<number | null>(null)
  const logoutTimerRef = useRef<number | null>(null)
  const countdownIntervalRef = useRef<number | null>(null)

  // Confirm dialogs for terminate / terminate-all / purge
  const [confirmAction, setConfirmAction] = useState<{
    kind: 'terminate' | 'terminateAll' | 'purge'
    label: string
    description: string
    onConfirm: () => void
  } | null>(null)

  const showNotification = (msg: string, type: 'success' | 'error') => {
    setNotification({ message: msg, type })
    setTimeout(() => setNotification(null), 3500)
  }

  const clearModalAndTimers = () => {
    setModalVisible(false)
    setModalMessage('')
    setModalCountdown(null)
    if (logoutTimerRef.current) {
      clearTimeout(logoutTimerRef.current)
      logoutTimerRef.current = null
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current)
      countdownIntervalRef.current = null
    }
  }

  const triggerLogoutWithModal = (message: string, autoSeconds = 5) => {
    clearModalAndTimers()
    setModalMessage(message)
    setModalCountdown(autoSeconds)
    setModalVisible(true)
    countdownIntervalRef.current = window.setInterval(() => {
      setModalCountdown(prev => {
        if (prev === null) return prev
        const next = prev - 1
        if (next <= 0) return 0
        return next
      })
    }, 1000)
  }

  const loadSessions = async (q?: string) => {
    const qTrim = (q ?? '').trim().toLowerCase()
    setLoading(true)
    try {
      const params: any = { q: qTrim, include_expired: false }
      const data = await sessionService.list(params)
      let items: Session[] = Array.isArray(data) ? data : []
      items = items.filter(s => (s.status ?? 'active') === 'active')
      if (qTrim) {
        items = items.filter(s => {
          const username = (s.username ?? '').toLowerCase()
          const ip = (s.ipAddress ?? '').toLowerCase()
          const sid = (s.sessionId ?? '').toLowerCase()
          return username.includes(qTrim) || ip.includes(qTrim) || sid.includes(qTrim)
        })
      }
      setSessions(items)
      setLoading(false)
    } catch (err) {
      console.error('Failed to load sessions', err)
      setError('Failed to load sessions')
      setSessions([])
      setLoading(false)
    }
  }

  useEffect(() => {
    const userRoles = (user as any)?.roles ?? (user as any)?.role ?? []
    const rolesArray = Array.isArray(userRoles) ? userRoles : [userRoles]
    setIsAdmin(rolesArray.some((r: string) => r && r.toLowerCase() === 'admin'))
  }, [user])

  useEffect(() => {
    if (didLoadRef.current) return
    didLoadRef.current = true
    loadSessions()
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, isAdmin])

  // Existing expiry / revoke watcher (preserved verbatim)
  useEffect(() => {
    if (!user) return
    const currentUsername = (user as any).username ?? (user as any).email
    if (!currentUsername) return

    const getCookie = (name: string) => {
      if (typeof document === 'undefined') return null
      const match = document.cookie.match(new RegExp('(^|; )' + name + '=([^;]*)'))
      return match ? decodeURIComponent(match[2]) : null
    }

    const parseJwt = (token: string | null) => {
      try {
        if (!token || typeof token !== 'string') return null
        const parts = token.split('.')
        if (parts.length < 2) return null
        const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
        const json = decodeURIComponent(
          Array.prototype.map
            .call(atob(payload), (c: string) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
            .join('')
        )
        return JSON.parse(json)
      } catch (e) {
        return null
      }
    }

    const getCurrentSessionId = () => {
      const fromUser = (user as any)?.sessionId ?? (user as any)?.currentSessionId ?? (user as any)?.sid
      if (fromUser) return String(fromUser)
      const storageCandidates = [
        localStorage.getItem('sessionId'),
        sessionStorage.getItem('sessionId'),
        localStorage.getItem('currentSessionId'),
        sessionStorage.getItem('currentSessionId'),
        localStorage.getItem('authToken'),
        sessionStorage.getItem('authToken'),
        localStorage.getItem('token'),
        sessionStorage.getItem('token')
      ]
      try {
        console.debug('Session candidates from storage:', storageCandidates)
      } catch {}
      const cookieNames = ['sessionId', 'currentSessionId', 'connect.sid', 'sid', 'authToken', 'token']
      for (const name of cookieNames) {
        const val = getCookie(name)
        if (val) return val
      }
      try {
        const navUA = typeof navigator !== 'undefined' ? navigator.userAgent : ''
        const userSessions = sessions.filter(s => s.username === currentUsername)
        if (userSessions.length === 1) return userSessions[0].sessionId
        if (navUA && userSessions.length > 0) {
          for (const s of userSessions) {
            if (!s.userAgent || typeof s.userAgent !== 'string') continue
            const su = s.userAgent.toLowerCase()
            const nu = navUA.toLowerCase()
            if (su.includes(nu) || nu.includes(su) || su.split(' ').slice(0, 3).some(tok => nu.includes(tok))) {
              return s.sessionId
            }
          }
        }
      } catch (err) {
        // noop
      }
      return null
    }

    const currentSessionId = getCurrentSessionId()
    if (!currentSessionId) {
      console.log('No current session id found - skipping session expiry check.')
      return
    }
    const now = new Date()
    const currentSession = sessions.find(s => s.sessionId === currentSessionId && s.username === currentUsername)
    if (!currentSession) return

    const expiredFlag = currentSession.status === 'expired' || currentSession.status === 'revoked'
    const expiresAt = currentSession.expiresAt ? new Date(currentSession.expiresAt) : null
    const expiredByTime = expiresAt ? expiresAt <= now : false
    if (expiredFlag || expiredByTime) {
      triggerLogoutWithModal('Your session has expired or was revoked. You will be redirected to login.', 5)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, user, logout])

  // 10s pre-expiry warning poll (preserved verbatim)
  useEffect(() => {
    if (!user) return
    const currentUsername = (user as any).username ?? (user as any).email
    if (!currentUsername) return

    let warnedForSessionId: string | null = null
    let intervalHandle: number | null = null

    const performCheck = () => {
      const getCurrentSessionIdLocal = () => {
        const fromUser = (user as any)?.sessionId ?? (user as any)?.currentSessionId ?? (user as any)?.sid
        if (fromUser) return String(fromUser)
        const storageCandidates = [
          localStorage.getItem('sessionId'),
          sessionStorage.getItem('sessionId'),
          localStorage.getItem('currentSessionId'),
          sessionStorage.getItem('currentSessionId'),
          localStorage.getItem('authToken'),
          sessionStorage.getItem('authToken'),
          localStorage.getItem('token'),
          sessionStorage.getItem('token')
        ]
        for (const c of storageCandidates) {
          if (c && typeof c === 'string') {
            if (!c.includes('.') && c.length > 5 && c.length < 200) return c
            try {
              const parts = c.split('.')
              if (parts.length >= 2) {
                const payload = JSON.parse(
                  decodeURIComponent(
                    Array.prototype.map
                      .call(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')), (ch: string) =>
                        '%' + ('00' + ch.charCodeAt(0).toString(16)).slice(-2)
                      )
                      .join('')
                  )
                )
                const claim =
                  payload.sid ?? payload.sessionId ?? payload.session_id ?? payload.jti ?? payload.sess ?? payload.sub
                if (claim) return String(claim)
              }
            } catch {}
          }
        }
        return null
      }

      const currentSessionId = getCurrentSessionIdLocal()
      if (!currentSessionId) {
        console.log('No current session id found - skipping session expiry check.')
        return
      }

      if (warnedForSessionId && warnedForSessionId !== currentSessionId) {
        warnedForSessionId = null
      }

      const cur = sessions.find(s => s.sessionId === currentSessionId && s.username === currentUsername)
      if (!cur) return
      if (cur.status === 'expired' || cur.status === 'revoked') {
        triggerLogoutWithModal('Your session was revoked. Redirecting to login...', 5)
        return
      }
      if (!cur.expiresAt) return

      const now = Date.now()
      const expiresAt = new Date(cur.expiresAt).getTime()
      const msLeft = expiresAt - now

      if (msLeft <= 0) {
        triggerLogoutWithModal('Your session has expired. Redirecting to login...', 5)
        return
      }

      if (msLeft <= 10_000 && warnedForSessionId !== currentSessionId) {
        warnedForSessionId = currentSessionId
        showNotification('Your session will expire in 10 seconds. Saving your work is recommended.', 'error')
        console.log('Notified user of imminent session expiry (10s):', currentSessionId)
      }
    }

    performCheck()
    intervalHandle = window.setInterval(performCheck, 1000)

    return () => {
      if (intervalHandle) clearInterval(intervalHandle)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, user, logout])

  const handleTerminate = async (sessionId: string) => {
    const requestPayload = { sessionId }
    let responsePayload: any = null
    let auditStatus: 'success' | 'failure' = 'success'
    setLoading(true)
    try {
      await sessionService.terminate(sessionId)
      showNotification('Session terminated', 'success')
      await loadSessions()
      responsePayload = { success: true }
    } catch (err: any) {
      console.error(err)
      const msg = err?.response?.data?.message ?? 'Failed to terminate session'
      showNotification(msg, 'error')
      auditStatus = 'failure'
      responsePayload = { success: false, error: msg }
    } finally {
      setLoading(false)
      const masked = maskValue('session', sessionId)
      try {
        await logApiEvent({
          user: user?.username ? user : undefined,
          module: 'Session Management',
          action: 'Terminate Session',
          resourceType: 'API',
          resourceId: 'terminateSession',
          resourceName: 'Terminate Session',
          description: `Terminate session attempt for session ID ${masked}`,
          request: requestPayload,
          response: responsePayload,
          status: auditStatus
        })
      } catch (auditErr) {
        console.error('Failed to log audit event:', auditErr)
      }
    }
  }

  const handleTerminateAllForUser = async (username: string) => {
    let auditStatus: 'success' | 'failure' = 'success'
    const requestPayload = { username }
    let responsePayload: any = null
    setLoading(true)
    try {
      await sessionService.terminateAllForUser(username)
      showNotification(`All sessions for ${username} terminated`, 'success')
      await loadSessions()
      responsePayload = { success: true }
    } catch (err: any) {
      console.error(err)
      const msg = err?.response?.data?.message ?? 'Failed to terminate sessions for user'
      showNotification(msg, 'error')
      auditStatus = 'failure'
      responsePayload = { success: false, error: msg }
    } finally {
      setLoading(false)
      try {
        await logApiEvent({
          user: user?.username ? user : undefined,
          module: 'Session Management',
          action: 'Terminate Sessions',
          resourceType: 'API',
          resourceId: 'terminateSession',
          resourceName: 'Terminate Sessions',
          description: `Terminate session attempt for sessions of user ${username}`,
          request: requestPayload,
          response: responsePayload,
          status: auditStatus
        })
      } catch (auditErr) {
        console.error('Failed to log audit event:', auditErr)
      }
    }
  }

  const handlePurgeExpiredSessions = async () => {
    setLoading(true)
    const PYTHON_API_BASE = (import.meta as any).env?.VITE_API_URL ?? 'http://localhost:8002'
    try {
      if (typeof (sessionService as any).cleanup === 'function') {
        await (sessionService as any).cleanup()
      } else {
        const token = localStorage.getItem('authToken') || sessionStorage.getItem('authToken') || ''
        const headers: Record<string, string> = {}
        if (token) headers['Authorization'] = `Bearer ${token}`
        const res = await fetch(`${PYTHON_API_BASE}/session/cleanup`, { method: 'POST', headers })
        if (!res.ok) throw new Error(`Server responded ${res.status}`)
      }
      showNotification('Expired sessions purged', 'success')
      await loadSessions()
    } catch (err: any) {
      console.error('Failed to purge expired sessions', err)
      showNotification(err?.message ?? 'Failed to purge expired sessions', 'error')
    } finally {
      setLoading(false)
    }
  }

  // KPIs computed from real data
  const kpis = useMemo(() => {
    const distinctUsers = new Set(sessions.map(s => s.username)).size
    const now = Date.now()
    let oldestMs = 0
    let imminent = 0
    sessions.forEach(s => {
      if (s.startedAt) {
        const age = now - new Date(s.startedAt).getTime()
        if (age > oldestMs) oldestMs = age
      }
      if (s.expiresAt) {
        const ms = new Date(s.expiresAt).getTime() - now
        if (ms > 0 && ms <= 10 * 60 * 1000) imminent++
      }
    })
    return {
      total: sessions.length,
      distinctUsers,
      oldestMs,
      imminent
    }
  }, [sessions])

  const formatAge = (ms: number) => {
    if (!ms || ms <= 0) return '—'
    const minutes = Math.floor(ms / 60000)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    const remM = minutes % 60
    if (hours < 24) return `${hours}h${remM ? ` ${remM}m` : ''}`
    const days = Math.floor(hours / 24)
    return `${days}d ${hours % 24}h`
  }

  // Wire header
  usePageHeader({
    title: 'Sessions',
    subtitle: 'Monitor active workspace sessions and terminate suspicious ones.',
    showSearch: false,
    actions: (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => loadSessions(query)}
          className={theme.button.secondary}
        >
          <HiOutlineRefresh size={14} />
          Refresh
        </button>
        <button
          type="button"
          onClick={() =>
            setConfirmAction({
              kind: 'purge',
              label: 'Purge expired sessions',
              description:
                'This will permanently remove all expired or revoked sessions from the server.',
              onConfirm: handlePurgeExpiredSessions
            })
          }
          className={theme.button.primary}
        >
          <HiOutlineTrash size={14} />
          Purge Expired
        </button>
      </div>
    )
  })

  if (error) {
    return (
      <div className="rounded-app border border-red-200 bg-app-danger-bg p-4 text-app-danger">{error}</div>
    )
  }

  return (
    <div className="space-y-6">
      {/* KPI ROW */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard
          label="Active sessions"
          value={kpis.total}
          icon={<HiOutlineStatusOnline size={18} />}
          tone="brand"
        />
        <MetricCard
          label="Active users"
          value={kpis.distinctUsers}
          icon={<HiOutlineUserGroup size={18} />}
          tone="success"
        />
        <MetricCard
          label="Oldest session"
          value={formatAge(kpis.oldestMs)}
          icon={<HiOutlineClock size={18} />}
          tone="neutral"
        />
        <MetricCard
          label="Expiring soon"
          value={kpis.imminent}
          icon={<HiOutlineExclamationCircle size={18} />}
          tone={kpis.imminent > 0 ? 'warning' : 'neutral'}
        />
      </section>

      {/* TABLE */}
      <SectionCard
        title="Active sessions"
        description={`${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'} live`}
        actions={<StatusBadge tone="success" dot>Live</StatusBadge>}
        contentClassName="px-0 py-0"
      >
        {/* Toolbar */}
        <div className="flex flex-col gap-3 border-b border-app px-5 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <div className="relative max-w-sm flex-1">
              <HiOutlineSearch
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-app-muted"
                size={16}
              />
              <input
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') loadSessions(query)
                }}
                placeholder="Search by username, IP or session ID…"
                className="w-full rounded-app border border-app bg-app-surface py-2 pl-9 pr-3 text-sm text-app-primary placeholder:text-app-muted focus:border-app-brand-600 focus:outline-none focus:ring-2 focus:ring-app-brand-100"
              />
            </div>
            <button
              type="button"
              onClick={() => loadSessions(query)}
              className={theme.button.primary}
            >
              Search
            </button>
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery('')
                  loadSessions('')
                }}
                className="text-xs font-semibold text-app-brand-700 hover:text-app-brand-800"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="p-8">
            <Loader />
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-5 py-10">
            <EmptyState
              title={query ? 'No sessions match your search' : 'No active sessions'}
              description={
                query
                  ? 'Try a different username, IP, or session ID.'
                  : 'Active sessions will appear here as users sign in.'
              }
              action={
                query ? (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery('')
                      loadSessions('')
                    }}
                    className={theme.button.secondary}
                  >
                    Clear search
                  </button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="app-table">
              <thead>
                <tr>
                  <th className="text-left">User</th>
                  <th className="text-left">Session ID</th>
                  <th className="text-left">Started</th>
                  <th className="text-left">Last active</th>
                  <th className="text-left">Device / IP</th>
                  <th className="text-left">Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s, idx) => {
                  const browser = parseBrowser(s.userAgent)
                  const os = parseOS(s.userAgent)
                  const started = s.startedAt ? new Date(s.startedAt) : null
                  const lastActive = s.lastActiveAt ? new Date(s.lastActiveAt) : null
                  const expiresAt = s.expiresAt ? new Date(s.expiresAt) : null
                  const now = Date.now()
                  const isImminent =
                    expiresAt &&
                    expiresAt.getTime() - now > 0 &&
                    expiresAt.getTime() - now <= 10 * 60 * 1000
                  return (
                    <tr key={`${s.sessionId}-${idx}`}>
                      <td>
                        <div className="flex items-center gap-3">
                          <div
                            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                            style={{ background: avatarGradient(s.username || 'u') }}
                            aria-hidden
                          >
                            {initials(s.username)}
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-app-primary">
                              {s.username || '—'}
                            </div>
                            <div className="text-xs text-app-secondary">Session #{idx + 1}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <code className="rounded-md bg-app-surface-muted px-1.5 py-0.5 text-[11px] text-app-secondary">
                          {s.sessionId
                            ? s.sessionId.length > 18
                              ? `${s.sessionId.slice(0, 8)}…${s.sessionId.slice(-6)}`
                              : s.sessionId
                            : '—'}
                        </code>
                      </td>
                      <td>
                        <div className="text-xs text-app-primary">
                          {started ? format(started, 'MMM dd, HH:mm:ss') : '—'}
                        </div>
                        <div className="text-[11px] text-app-secondary">
                          {started ? `${formatDistanceToNowStrict(started)} ago` : ''}
                        </div>
                      </td>
                      <td>
                        <div className="text-xs text-app-primary">
                          {lastActive ? format(lastActive, 'MMM dd, HH:mm:ss') : '—'}
                        </div>
                        <div className="text-[11px] text-app-secondary">
                          {lastActive ? `${formatDistanceToNowStrict(lastActive)} ago` : ''}
                        </div>
                      </td>
                      <td>
                        <div className="flex items-center gap-1.5 text-xs text-app-primary">
                          <HiOutlineDesktopComputer size={13} className="text-app-secondary" />
                          {browser}
                          {os ? ` · ${os}` : ''}
                        </div>
                        <div className="flex items-center gap-1.5 text-[11px] text-app-secondary">
                          <HiOutlineGlobeAlt size={11} />
                          {s.ipAddress ?? '—'}
                        </div>
                      </td>
                      <td>
                        <div className="flex flex-col items-start gap-1">
                          <StatusBadge tone={s.status === 'active' ? 'success' : 'neutral'} size="sm" dot>
                            {s.status ?? 'active'}
                          </StatusBadge>
                          {isImminent && (
                            <StatusBadge tone="warning" size="sm">
                              Expiring soon
                            </StatusBadge>
                          )}
                        </div>
                      </td>
                      <td className="text-right">
                        <div className="inline-flex flex-wrap items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() =>
                              setConfirmAction({
                                kind: 'terminate',
                                label: `Terminate session for ${s.username}?`,
                                description: `Session ${s.sessionId} will be revoked immediately.`,
                                onConfirm: () => handleTerminate(s.sessionId)
                              })
                            }
                            className="inline-flex items-center gap-1 rounded-app px-2.5 py-1.5 text-xs font-semibold text-app-danger transition hover:bg-app-danger-bg"
                          >
                            <HiOutlineLogout size={14} />
                            Terminate
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setConfirmAction({
                                kind: 'terminateAll',
                                label: `Terminate all sessions for ${s.username}?`,
                                description: `Every active session for this user will be revoked. This action cannot be undone.`,
                                onConfirm: () => handleTerminateAllForUser(s.username)
                              })
                            }
                            className="inline-flex items-center gap-1 rounded-app px-2.5 py-1.5 text-xs font-semibold text-app-secondary transition hover:bg-app-surface-muted"
                          >
                            Terminate all
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {notification && (
        <Notification
          message={notification.message}
          type={notification.type}
          onClose={() => setNotification(null)}
          duration={3500}
        />
      )}

      {/* Generic confirm dialog */}
      {confirmAction && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onClick={() => setConfirmAction(null)}
        >
          <div
            className="w-full max-w-md overflow-hidden rounded-app-lg border border-app bg-app-surface shadow-app-card-lg"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 px-6 pt-6 pb-2">
              <IconBadge tone="warning" size="lg">
                <HiOutlineExclamationCircle size={22} />
              </IconBadge>
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-semibold text-app-primary">{confirmAction.label}</h3>
                <p className="mt-1 text-sm text-app-secondary">{confirmAction.description}</p>
              </div>
              <button
                type="button"
                onClick={() => setConfirmAction(null)}
                className="rounded-md p-1 text-app-muted transition hover:bg-app-surface-muted hover:text-app-primary"
                aria-label="Close"
              >
                <HiOutlineX size={18} />
              </button>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-app bg-app-surface-muted/40 px-6 py-3">
              <button
                type="button"
                onClick={() => setConfirmAction(null)}
                className={theme.button.secondary}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const fn = confirmAction.onConfirm
                  setConfirmAction(null)
                  fn()
                }}
                className={theme.button.danger}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Session expiry modal (kept commented from original — restyled if uncommented) */}
      {modalVisible && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md overflow-hidden rounded-app-lg border border-app bg-app-surface shadow-app-card-lg">
            <div className="flex items-start gap-3 px-6 pt-6">
              <IconBadge tone="danger" size="lg">
                <HiOutlineExclamationCircle size={22} />
              </IconBadge>
              <div className="flex-1">
                <h3 className="text-base font-semibold text-app-primary">Session expired</h3>
                <p className="mt-1 text-sm text-app-secondary">{modalMessage}</p>
                {modalCountdown !== null && (
                  <p className="mt-2 text-xs text-app-secondary">
                    You will be redirected in {modalCountdown} second{modalCountdown !== 1 ? 's' : ''}.
                  </p>
                )}
              </div>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2 border-t border-app bg-app-surface-muted/40 px-6 py-3">
              <button type="button" onClick={clearModalAndTimers} className={theme.button.secondary}>
                Stay
              </button>
              <button
                type="button"
                onClick={() => {
                  clearModalAndTimers()
                  logout()
                }}
                className={theme.button.danger}
              >
                Logout now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Sessions
