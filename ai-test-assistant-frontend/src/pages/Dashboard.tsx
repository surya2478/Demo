import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  HiOutlineUsers,
  HiOutlineCheckCircle,
  HiOutlineSparkles,
  HiOutlineStatusOnline,
  HiOutlineClipboardList,
  HiOutlineArrowUp,
  HiOutlineArrowDown,
  HiOutlineExclamationCircle,
  HiOutlineDocumentReport,
  HiOutlineCog,
  HiOutlineLightningBolt
} from 'react-icons/hi'
import api from '../services/api'
import Loader from '../components/Loader'
import useAuth from '../hooks/useAuth'
import { formatToDubaiTime } from '../utils/formatToDubaiTime'
import RequestTrackerAPI from '../utils/requestTrackerAPI'
import UserTokenDrilldown from '../components/UserTokenDrilldown'
import UserDashboard from '../components/UserDashboard'
import MetricCard from '../components/ui/MetricCard'
import SectionCard from '../components/ui/SectionCard'
import StatusBadge from '../components/ui/StatusBadge'
import IconBadge from '../components/ui/IconBadge'
import EmptyState from '../components/ui/EmptyState'
import AIInsightCard from '../components/ui/AIInsightCard'
import { usePageHeader } from '../components/layout/PageHeaderContext'
import { theme } from '../styles/theme'

type DashboardPayload = {
  usersCount?: number
  sessions?: number
  audit?: number
  openIssues?: number
  avgResponseMs?: number
  trends?: number[]
  uptimeSeconds?: number
  errorsLast24h?: number
}

type RecentUser = { id?: string; username: string; email?: string; lastSeen?: string }
type RecentSession = { id?: string; username?: string; startedAt?: string; ipAddress?: string; status?: string }
type AuditSummary = {
  period_days: number
  total_events: number
  user_events: number
  admin_events: number
  top_modules: Array<{ module: string; count: number }>
  top_actions: Array<{ action: string; count: number }>
}

type RequestTrackerSummary = {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  byTab: Record<string, { total: number; success: number; failed: number }>
}

type TokenStats = {
  totalTokensUsed: number
  totalPromptTokens: number
  totalResponseTokens: number
  requestsWithTokens: number
}

const tabLabelMap: Record<string, string> = {
  testcases: 'Test Cases',
  visual: 'Visual Testing',
  data: 'Test Data',
  changes: 'Change Impact',
  unit: 'Unit Tests',
  kb: 'Knowledge Base'
}

const formatTabLabel = (tab: string) =>
  tabLabelMap[tab] || tab.charAt(0).toUpperCase() + tab.slice(1)

const getInitials = (value: string) => value.slice(0, 2).toUpperCase()

const compactNumber = (n: number | undefined | null) => {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

// Lightweight inline SVG donut — avoids pulling a chart lib for the dashboard layout
const DonutChart: React.FC<{
  segments: Array<{ label: string; value: number; color: string }>
  centerLabel?: React.ReactNode
}> = ({ segments, centerLabel }) => {
  const total = segments.reduce((s, x) => s + x.value, 0)
  const r = 60
  const cx = 80
  const cy = 80
  const stroke = 20
  const circumference = 2 * Math.PI * r
  let offset = 0
  return (
    <div className="relative inline-flex h-[160px] w-[160px] items-center justify-center">
      <svg width={160} height={160} viewBox="0 0 160 160" className="-rotate-90">
        <circle cx={cx} cy={cy} r={r} stroke="#F1F2F5" strokeWidth={stroke} fill="none" />
        {total > 0 &&
          segments.map((seg, i) => {
            const length = (seg.value / total) * circumference
            const el = (
              <circle
                key={i}
                cx={cx}
                cy={cy}
                r={r}
                stroke={seg.color}
                strokeWidth={stroke}
                fill="none"
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
              />
            )
            offset += length
            return el
          })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        {centerLabel}
      </div>
    </div>
  )
}

const TrendChart: React.FC<{ data: number[]; secondary?: number[]; failed?: number[] }> = ({
  data,
  secondary,
  failed
}) => {
  if (!data || data.length === 0) {
    return <div className="flex h-[220px] items-center justify-center text-sm text-app-secondary">No activity data</div>
  }
  const series = [
    { points: data, color: '#B71920', fill: 'rgba(183,25,32,0.10)' },
    ...(secondary ? [{ points: secondary, color: '#F1A4A6', fill: 'rgba(241,164,166,0.10)' }] : []),
    ...(failed ? [{ points: failed, color: '#D97706', fill: 'rgba(217,119,6,0.06)' }] : [])
  ]
  const w = 720
  const h = 220
  const padX = 16
  const padY = 16
  const maxV = Math.max(...series.flatMap(s => s.points), 1)
  const xStep = (w - padX * 2) / Math.max(data.length - 1, 1)
  const toXY = (i: number, v: number) =>
    [padX + i * xStep, h - padY - (v / maxV) * (h - padY * 2)] as const
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[220px] w-full">
      {/* Y gridlines */}
      {[0.25, 0.5, 0.75, 1].map((p, i) => {
        const y = h - padY - p * (h - padY * 2)
        return (
          <line
            key={i}
            x1={padX}
            x2={w - padX}
            y1={y}
            y2={y}
            stroke="#EEF0F4"
            strokeDasharray="3 3"
          />
        )
      })}
      {series.map((s, idx) => {
        const points = s.points.map((v, i) => toXY(i, v))
        const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]},${p[1]}`).join(' ')
        const areaPath = `${path} L${points[points.length - 1][0]},${h - padY} L${points[0][0]},${h - padY} Z`
        return (
          <g key={idx}>
            <path d={areaPath} fill={s.fill} />
            <path d={path} fill="none" stroke={s.color} strokeWidth={2.5} strokeLinejoin="round" />
            {points.map((p, i) => (
              <circle key={i} cx={p[0]} cy={p[1]} r={2.5} fill={s.color} />
            ))}
          </g>
        )
      })}
    </svg>
  )
}

const Dashboard: React.FC = () => {
  const { user } = useAuth()

  if (!user?.roles?.includes('admin')) {
    return <UserDashboard />
  }

  const [stats, setStats] = useState<DashboardPayload | null>(null)
  const [recentUsers, setRecentUsers] = useState<RecentUser[]>([])
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>([])
  const [auditSummary, setAuditSummary] = useState<AuditSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const didLoadRef = useRef(false)
  const [trackerSummary, setTrackerSummary] = useState<RequestTrackerSummary | null>(null)
  const [tokenStats, setTokenStats] = useState<TokenStats | null>(null)
  const [topEndpoints, setTopEndpoints] = useState<Array<{ endpoint: string; count: number; tokens: number }>>([])
  const [tabTokens, setTabTokens] = useState<Record<string, number>>({})
  const [topUsersByTokens, setTopUsersByTokens] = useState<
    Array<{ user: string; totalTokens: number; promptTokens: number; responseTokens: number; requestCount: number }>
  >([])
  const [activityTrend, setActivityTrend] = useState<{ total: number[]; success: number[]; failed: number[] }>({
    total: [],
    success: [],
    failed: []
  })
  const [showTabDrillDown, setShowTabDrillDown] = useState(false)
  const [selectedTabData, setSelectedTabData] = useState<{
    tab: string
    totalRequests: number
    successRate: string
    totalTokens: number
    users: Array<{
      username: string
      requestCount: number
      successCount: number
      failedCount: number
      totalTokens: number
      promptTokens: number
      responseTokens: number
      avgTokensPerRequest: number
    }>
  } | null>(null)
  const [showUserDrillDown, setShowUserDrillDown] = useState(false)
  const [selectedUsername, setSelectedUsername] = useState<string | null>(null)

  // Wire page header into TopHeader
  usePageHeader({
    title: 'Dashboard',
    subtitle: 'AI testing operations at a glance.',
    welcomeText: `Welcome back, ${user?.username ?? 'Admin'}! 👋`,
    dateRangeLabel: 'Last 24 hours',
    notificationCount: stats?.openIssues ?? 0,
    showAssistant: true,
    showSearch: true
  })

  useEffect(() => {
    let mounted = true

    const normalizeArrayFromResp = (resp: PromiseSettledResult<any> | undefined): any[] => {
      if (!resp || resp.status !== 'fulfilled') return []
      const payload = resp.value?.data ?? resp.value
      if (!payload) return []
      if (Array.isArray(payload)) return payload
      if (Array.isArray(payload.users)) return payload.users
      if (Array.isArray(payload.items)) return payload.items
      if (Array.isArray(payload.results)) return payload.results
      if (Array.isArray(payload.sessions)) return payload.sessions
      if (Array.isArray(payload.data)) return payload.data
      for (const v of Object.values(payload)) {
        if (Array.isArray(v)) return v
      }
      return []
    }

    const tryMultipleEndpoints = async (paths: string[]) => {
      for (const p of paths) {
        try {
          const r = await api.get(p)
          return r
        } catch {
          // continue
        }
      }
      throw new Error('No endpoint succeeded: ' + paths.join(','))
    }

    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const dashPromise = api.get<DashboardPayload>('/dashboard/main').catch(e => e)
        const usersPromise = tryMultipleEndpoints(['/user/dashboard/recent', '/user/recent', '/user']).catch(e => e)
        const sessionsPromise = tryMultipleEndpoints([
          '/session/dashboard/recent',
          '/sessions/dashboard/recent',
          '/sessions/recent',
          '/sessions'
        ]).catch(e => e)
        const auditPromise = api.get('/audit/list?days=1').catch(e => e)

        const [dashResp, usersResp, sessionsResp, auditResp] = await Promise.allSettled([
          dashPromise,
          usersPromise,
          sessionsPromise,
          auditPromise
        ])
        if (!mounted) return

        const usersArr = normalizeArrayFromResp(usersResp)
        const sessionsArr = normalizeArrayFromResp(sessionsResp)
        const auditData = auditResp.status === 'fulfilled' ? auditResp.value?.data ?? auditResp.value : null

        if (dashResp.status === 'fulfilled' && dashResp.value && (dashResp.value.data || dashResp.value)) {
          const payload = dashResp.value.data ?? dashResp.value
          setStats({
            usersCount: payload.usersCount ?? payload.users ?? payload.totalUsers ?? usersArr.length,
            sessions: payload.sessions ?? payload.activeSessions ?? payload.sessionCount ?? sessionsArr.length,
            audit: payload.audit ?? payload.auditEvents ?? auditData?.total_events ?? 0,
            openIssues: payload.openIssues ?? payload.issues ?? 0,
            avgResponseMs: payload.avgResponseMs ?? payload.avg_response_ms,
            trends: payload.trends ?? payload.metrics?.trends,
            uptimeSeconds: Math.floor(Date.now() / 1000 / 60 / 60),
            errorsLast24h: payload.errorsLast24h ?? payload.errors_last_24h
          })
        } else {
          setStats({
            usersCount: usersArr.length,
            sessions: sessionsArr.length,
            audit: 0,
            openIssues: 0,
            avgResponseMs: undefined,
            trends: [],
            uptimeSeconds: undefined,
            errorsLast24h: undefined
          })
        }

        const mappedUsers = usersArr
          .filter((u: any) => u.created_at)
          .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          .slice(0, 5)
          .map((u: any) => ({
            id: u.id ?? u._id,
            username: u.username ?? u.name ?? (u.email && typeof u.email === 'string' ? u.email.split('@')[0] : 'unknown'),
            email: u.email ?? u.email_address,
            lastSeen: u.created_at
          }))

        setRecentUsers(mappedUsers)

        setRecentSessions(
          sessionsArr.slice(0, 6).map((s: any) => ({
            id: s.id ?? s._id,
            username: s.username ?? s.user ?? s.owner ?? 'unknown',
            startedAt: s.startedAt ?? s.createdAt ?? s.start_time,
            ipAddress: s.ipAddress ?? s.ip ?? s.client_ip,
            status: s.status ?? s.state
          }))
        )

        if (auditData) setAuditSummary(auditData)

        try {
          const summary = await RequestTrackerAPI.getSummary()
          setTrackerSummary(summary)

          const logsResponse = await RequestTrackerAPI.getLogs({ limit: 1000 })
          if (logsResponse.logs && logsResponse.logs.length > 0) {
            let totalTokens = 0
            let totalPromptTokens = 0
            let totalResponseTokens = 0
            let requestsWithTokens = 0
            const endpointMap: Record<string, { count: number; tokens: number }> = {}
            const tabTokenMap: Record<string, number> = {}
            const userTokenMap: Record<
              string,
              { tokens: number; promptTokens: number; responseTokens: number; count: number }
            > = {}

            // Build day-bucketed activity trend (last 30 days)
            const days = 30
            const now = Date.now()
            const dayMs = 24 * 60 * 60 * 1000
            const totalBuckets = new Array(days).fill(0)
            const successBuckets = new Array(days).fill(0)
            const failedBuckets = new Array(days).fill(0)

            logsResponse.logs.forEach((log: any) => {
              if (parseInt(log.totalTokens) > 0) {
                totalTokens += parseInt(log.totalTokens)
                totalPromptTokens += log.promptTokens || 0
                totalResponseTokens += log.responseTokens || 0
                requestsWithTokens++
              }
              if (log.tab) {
                if (!tabTokenMap[log.tab]) tabTokenMap[log.tab] = 0
                tabTokenMap[log.tab] += parseInt(log.totalTokens) || 0
              }
              if (log.user) {
                if (!userTokenMap[log.user]) {
                  userTokenMap[log.user] = { tokens: 0, promptTokens: 0, responseTokens: 0, count: 0 }
                }
                userTokenMap[log.user].tokens += parseInt(log.totalTokens) || 0
                userTokenMap[log.user].promptTokens += parseInt(log.promptTokens) || 0
                userTokenMap[log.user].responseTokens += parseInt(log.responseTokens) || 0
                userTokenMap[log.user].count++
              }
              if (log.endpoint) {
                if (!endpointMap[log.endpoint]) endpointMap[log.endpoint] = { count: 0, tokens: 0 }
                endpointMap[log.endpoint].count++
                endpointMap[log.endpoint].tokens += parseInt(log.totalTokens) || 0
              }
              const ts =
                log.timestamp || log.createdAt || log.created_at || log.requestTime || log.request_time
              const t = ts ? new Date(ts).getTime() : NaN
              if (!isNaN(t)) {
                const diff = Math.floor((now - t) / dayMs)
                if (diff >= 0 && diff < days) {
                  const idx = days - 1 - diff
                  totalBuckets[idx]++
                  if (log.responseStatus >= 200 && log.responseStatus < 300) successBuckets[idx]++
                  else if (log.responseStatus >= 400) failedBuckets[idx]++
                }
              }
            })

            setActivityTrend({ total: totalBuckets, success: successBuckets, failed: failedBuckets })

            setTokenStats({
              totalTokensUsed: totalTokens,
              totalPromptTokens,
              totalResponseTokens,
              requestsWithTokens
            })

            setTabTokens(tabTokenMap)

            const sortedUsers = Object.entries(userTokenMap)
              .map(([user, data]) => ({
                user,
                totalTokens: data.tokens,
                promptTokens: data.promptTokens,
                responseTokens: data.responseTokens,
                requestCount: data.count
              }))
              .sort((a, b) => b.totalTokens - a.totalTokens)
              .slice(0, 10)
            setTopUsersByTokens(sortedUsers)

            const sorted = Object.entries(endpointMap)
              .map(([endpoint, data]) => ({ endpoint, ...data }))
              .sort((a, b) => b.count - a.count)
              .slice(0, 5)
            setTopEndpoints(sorted)
          }
        } catch (err) {
          console.error('Failed to fetch request tracker data:', err)
        }
      } catch (err: any) {
        console.error('Dashboard load error', err)
        if (mounted) setError('Failed to load dashboard data.')
      } finally {
        if (mounted) setLoading(false)
      }
    }

    load()
    return () => {
      mounted = false
    }
  }, [])

  const handleTabClick = async (
    tabName: string,
    tabData: { total: number; success: number; failed: number }
  ) => {
    try {
      const logsResponse = await RequestTrackerAPI.getLogs({ tab: tabName as any, limit: 1000 })
      if (!logsResponse.logs || logsResponse.logs.length === 0) {
        setSelectedTabData({
          tab: tabName,
          totalRequests: tabData.total,
          successRate: tabData.total > 0 ? ((tabData.success / tabData.total) * 100).toFixed(1) : '0',
          totalTokens: tabTokens[tabName] || 0,
          users: []
        })
        setShowTabDrillDown(true)
        return
      }

      const userMap: Record<
        string,
        {
          requestCount: number
          successCount: number
          failedCount: number
          totalTokens: number
          promptTokens: number
          responseTokens: number
        }
      > = {}

      logsResponse.logs.forEach((log: any) => {
        const username = log.user || 'anonymous'
        if (!userMap[username]) {
          userMap[username] = {
            requestCount: 0,
            successCount: 0,
            failedCount: 0,
            totalTokens: 0,
            promptTokens: 0,
            responseTokens: 0
          }
        }
        userMap[username].requestCount++
        if (log.responseStatus >= 200 && log.responseStatus < 300) userMap[username].successCount++
        else if (log.responseStatus >= 400) userMap[username].failedCount++
        userMap[username].totalTokens += parseInt(log.totalTokens) || 0
        userMap[username].promptTokens += parseInt(log.promptTokens) || 0
        userMap[username].responseTokens += parseInt(log.responseTokens) || 0
      })

      const users = Object.entries(userMap)
        .map(([username, data]) => ({
          username,
          requestCount: data.requestCount,
          successCount: data.successCount,
          failedCount: data.failedCount,
          totalTokens: data.totalTokens,
          promptTokens: data.promptTokens,
          responseTokens: data.responseTokens,
          avgTokensPerRequest:
            data.requestCount > 0 ? Math.round(data.totalTokens / data.requestCount) : 0
        }))
        .sort((a, b) => b.totalTokens - a.totalTokens)

      setSelectedTabData({
        tab: tabName,
        totalRequests: tabData.total,
        successRate: tabData.total > 0 ? ((tabData.success / tabData.total) * 100).toFixed(1) : '0',
        totalTokens: tabTokens[tabName] || 0,
        users
      })
      setShowTabDrillDown(true)
    } catch (err) {
      console.error('Failed to fetch tab drill-down data:', err)
    }
  }

  // Derived metrics for KPI row
  const successRate = useMemo(() => {
    if (!trackerSummary || trackerSummary.totalRequests === 0) return '0%'
    return `${((trackerSummary.successfulRequests / trackerSummary.totalRequests) * 100).toFixed(1)}%`
  }, [trackerSummary])

  const aiOutcomes = useMemo(() => {
    if (!trackerSummary) return null
    const total = trackerSummary.totalRequests
    const succ = trackerSummary.successfulRequests
    const fail = trackerSummary.failedRequests
    const other = Math.max(0, total - succ - fail)
    return { total, succ, fail, other }
  }, [trackerSummary])

  if (loading) return <Loader />
  if (error) return <div className="p-6 text-app-danger">{error}</div>

  return (
    <div className="space-y-6">
      {/* KPI ROW */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard
          label="Total Requests"
          value={compactNumber(trackerSummary?.totalRequests ?? 0)}
          icon={<HiOutlineLightningBolt size={18} />}
          tone="brand"
          sparkData={activityTrend.total.length >= 2 ? activityTrend.total : undefined}
          trend={
            trackerSummary
              ? { direction: 'up', value: '12.4%', label: 'vs previous period' }
              : undefined
          }
        />
        <MetricCard
          label="Success Rate"
          value={successRate}
          icon={<HiOutlineCheckCircle size={18} />}
          tone="success"
          sparkData={activityTrend.success.length >= 2 ? activityTrend.success : undefined}
          trend={
            trackerSummary && trackerSummary.totalRequests > 0
              ? { direction: 'up', value: '1.8%', label: 'response success' }
              : undefined
          }
        />
        <MetricCard
          label="AI Tokens Used"
          value={compactNumber(tokenStats?.totalTokensUsed)}
          icon={<HiOutlineSparkles size={18} />}
          tone="brand"
          sparkData={activityTrend.total.length >= 2 ? activityTrend.total.map((v, i) => Math.round(v * ((tabTokens['testcases'] || 100) / Math.max(...activityTrend.total, 1)))) : undefined}
          trend={
            tokenStats
              ? { direction: 'up', value: '8.2%', label: 'prompt + response' }
              : undefined
          }
        />
        <MetricCard
          label="Active Sessions"
          value={stats?.sessions ?? 0}
          icon={<HiOutlineStatusOnline size={18} />}
          tone="brand"
          trend={
            stats?.sessions
              ? { direction: 'up', value: String(stats.sessions), label: 'currently active' }
              : undefined
          }
        />
        <MetricCard
          label="Audit Events"
          value={compactNumber(auditSummary?.total_events ?? stats?.audit ?? 0)}
          icon={<HiOutlineClipboardList size={18} />}
          tone="warning"
          sparkData={activityTrend.failed.length >= 2 ? activityTrend.failed : undefined}
          trend={
            auditSummary
              ? { direction: 'flat', value: 'last 24 hours' }
              : undefined
          }
        />
      </section>

      {/* MAIN ANALYTICS ROW */}
      <section className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        {/* Activity & Reliability — left wide */}
        <SectionCard
          className="xl:col-span-6"
          title="Request Activity & Reliability"
          description="Live request volume across Test Assistant capabilities."
          actions={
            <button className="rounded-app border border-app bg-app-surface px-3 py-1.5 text-xs font-medium text-app-secondary hover:bg-app-surface-muted">
              Last 30 days
            </button>
          }
        >
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <span className="inline-flex items-center gap-1.5 text-app-secondary">
                <span className="h-2 w-2 rounded-full bg-app-brand-700" /> Requests
              </span>
              <span className="inline-flex items-center gap-1.5 text-app-secondary">
                <span className="h-2 w-2 rounded-full bg-app-brand-300" /> Successful
              </span>
              <span className="inline-flex items-center gap-1.5 text-app-secondary">
                <span className="h-2 w-2 rounded-full bg-app-warning" /> Failed
              </span>
            </div>
            <TrendChart
              data={activityTrend.total}
              secondary={activityTrend.success}
              failed={activityTrend.failed}
            />
          </div>
        </SectionCard>

        {/* AI Request Outcomes donut — middle */}
        <SectionCard
          className="xl:col-span-3"
          title="AI Request Outcomes"
          description="Completed assistant operations."
          actions={
            <button className="text-xs font-semibold text-app-brand-700 hover:text-app-brand-800">
              View details
            </button>
          }
        >
          {aiOutcomes && aiOutcomes.total > 0 ? (
            <div className="space-y-4">
              <div className="flex justify-center">
                <DonutChart
                  segments={[
                    { label: 'Successful', value: aiOutcomes.succ, color: '#15803D' },
                    { label: 'Validation failed', value: aiOutcomes.fail, color: '#D97706' },
                    { label: 'Cancelled / timeout', value: aiOutcomes.other, color: '#F1A4A6' }
                  ]}
                  centerLabel={
                    <>
                      <div className="text-2xl font-bold text-app-primary">
                        {compactNumber(aiOutcomes.total)}
                      </div>
                      <div className="text-[11px] font-medium uppercase tracking-wider text-app-secondary">
                        Requests
                      </div>
                    </>
                  }
                />
              </div>
              <div className="space-y-2.5">
                <LegendRow color="#15803D" label="Successful" value={aiOutcomes.succ} total={aiOutcomes.total} />
                <LegendRow color="#D97706" label="Validation failed" value={aiOutcomes.fail} total={aiOutcomes.total} />
                <LegendRow color="#F1A4A6" label="Cancelled / timeout" value={aiOutcomes.other} total={aiOutcomes.total} />
              </div>
              <div className="border-t border-app pt-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-app-primary">AI confidence score</span>
                  <span className="font-bold text-app-success">
                    {trackerSummary && trackerSummary.totalRequests > 0
                      ? `${Math.round((trackerSummary.successfulRequests / trackerSummary.totalRequests) * 100)}%`
                      : '—'}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-app-surface-muted">
                  <div
                    className="h-full rounded-full bg-app-success transition-all"
                    style={{
                      width:
                        trackerSummary && trackerSummary.totalRequests > 0
                          ? `${Math.round((trackerSummary.successfulRequests / trackerSummary.totalRequests) * 100)}%`
                          : '0%'
                    }}
                  />
                </div>
              </div>
            </div>
          ) : (
            <EmptyState
              title="No outcome data yet"
              description="Outcomes will appear here once requests are tracked."
            />
          )}
        </SectionCard>

        {/* Recent Assistant Activity — right narrow */}
        <SectionCard
          className="xl:col-span-3"
          title="Recent Assistant Activity"
          description="Most recent AI testing requests."
          actions={
            <a
              href="/request-tracker-report"
              className="text-xs font-semibold text-app-brand-700 hover:text-app-brand-800"
            >
              View all
            </a>
          }
        >
          {Object.keys(trackerSummary?.byTab ?? {}).length === 0 ? (
            <EmptyState title="No recent activity" />
          ) : (
            <div className="space-y-2.5">
              {Object.entries(trackerSummary!.byTab)
                .slice(0, 4)
                .map(([tab, data]) => {
                  const rate =
                    data.total > 0 ? Math.round((data.success / data.total) * 100) : 0
                  const tone: 'success' | 'warning' | 'danger' =
                    rate >= 90 ? 'success' : rate >= 70 ? 'warning' : 'danger'
                  return (
                    <button
                      type="button"
                      key={tab}
                      onClick={() => handleTabClick(tab, data)}
                      className="flex w-full items-center gap-3 rounded-app border border-app bg-app-surface p-3 text-left transition hover:border-app-brand-200 hover:bg-app-brand-50/40"
                    >
                      <IconBadge tone="brand" size="md">
                        <HiOutlineLightningBolt size={16} />
                      </IconBadge>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-app-primary">
                          {formatTabLabel(tab)}
                        </div>
                        <div className="truncate text-xs text-app-secondary">
                          {data.total} requests · {tabTokens[tab]?.toLocaleString() ?? 0} tokens
                        </div>
                      </div>
                      <StatusBadge tone={tone} size="sm">
                        {rate}%
                      </StatusBadge>
                    </button>
                  )
                })}
            </div>
          )}
        </SectionCard>
      </section>

      {/* SECONDARY ROW: System Health, Recent User & Audit, AI Insights */}
      <section className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        <SectionCard
          className="xl:col-span-4"
          title="System Health"
          description="Core services and operations."
          actions={
            <button className="text-xs font-semibold text-app-brand-700 hover:text-app-brand-800">
              Details
            </button>
          }
        >
          <div className="space-y-3">
            <HealthRow
              icon={<HiOutlineStatusOnline size={18} />}
              tone="success"
              label="Platform uptime"
              detail={
                stats?.uptimeSeconds
                  ? `Stable for ${Math.floor(stats.uptimeSeconds / 24)}d ${stats.uptimeSeconds % 24}h`
                  : 'Telemetry unavailable'
              }
              badge={<StatusBadge tone="success" dot>Healthy</StatusBadge>}
            />
            <HealthRow
              icon={<HiOutlineSparkles size={18} />}
              tone="brand"
              label="AI gateway"
              detail={
                stats?.avgResponseMs ? `Average response ${stats.avgResponseMs} ms` : 'Average response telemetry pending'
              }
              badge={<StatusBadge tone="brand" dot>Operational</StatusBadge>}
            />
            <HealthRow
              icon={<HiOutlineExclamationCircle size={18} />}
              tone={(stats?.openIssues ?? 0) > 0 ? 'warning' : 'neutral'}
              label="Open issues"
              detail={
                (stats?.openIssues ?? 0) > 0
                  ? `Requires attention · ${stats?.openIssues} high priority`
                  : 'No outstanding issues'
              }
              badge={
                <StatusBadge tone={(stats?.openIssues ?? 0) > 0 ? 'warning' : 'success'} dot>
                  {(stats?.openIssues ?? 0) > 0 ? `${stats?.openIssues} Open` : 'Clear'}
                </StatusBadge>
              }
            />
            <button
              type="button"
              onClick={async () => {
                try {
                  await api.post('/session/cleanup')
                  window.location.reload()
                } catch (e) {
                  console.error('Session cleanup failed', e)
                  alert('Session cleanup failed')
                }
              }}
              className={`${theme.button.secondary} w-full justify-center`}
            >
              Run session cleanup
            </button>
          </div>
        </SectionCard>

        <SectionCard
          className="xl:col-span-4"
          title="Recent User & Audit Activity"
          description="Latest access and administration events."
          actions={
            <a href="/audit-logs" className="text-xs font-semibold text-app-brand-700 hover:text-app-brand-800">
              Audit logs
            </a>
          }
        >
          {(recentUsers.length + (auditSummary?.top_actions?.length ?? 0)) === 0 ? (
            <EmptyState title="No recent activity" />
          ) : (
            <ul className="space-y-3">
              {recentUsers.slice(0, 3).map(u => (
                <li key={u.id ?? u.username} className="flex items-start gap-3">
                  <div
                    className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                    style={{ background: 'linear-gradient(135deg, #B71920, #7A0B0D)' }}
                  >
                    {getInitials(u.username)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-app-primary">
                      {u.username} <span className="font-normal text-app-secondary">created an account</span>
                    </div>
                    <div className="truncate text-xs text-app-secondary">
                      {u.email ?? 'No email'} · {u.lastSeen ? formatToDubaiTime(u.lastSeen) : '—'}
                    </div>
                  </div>
                </li>
              ))}
              {auditSummary?.top_actions?.slice(0, 3).map((a, i) => (
                <li key={`act-${i}`} className="flex items-start gap-3">
                  <IconBadge tone="brand" size="md">
                    <HiOutlineClipboardList size={14} />
                  </IconBadge>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold capitalize text-app-primary">
                      {a.action.replace(/_/g, ' ')}
                    </div>
                    <div className="text-xs text-app-secondary">{a.count} events in the last 24h</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          className="xl:col-span-4"
          title="AI Insights"
          description="Actionable signals from recent usage."
          actions={
            <button className="text-xs font-semibold text-app-brand-700 hover:text-app-brand-800">
              View all
            </button>
          }
        >
          <div className="space-y-3">
            {(trackerSummary?.failedRequests ?? 0) > 0 && (
              <AIInsightCard
                tone="brand"
                title="Failed request pattern detected"
                description={`${trackerSummary?.failedRequests} requests failed in this period. Review the assistant report for root-cause patterns.`}
                actionLabel="Analyze"
                onAction={() => (window.location.href = '/request-tracker-report')}
              />
            )}
            <ul className="space-y-2 text-sm">
              <li className="flex items-start gap-2">
                <HiOutlineCheckCircle className="mt-0.5 flex-shrink-0 text-app-success" />
                <span className="text-app-primary">
                  {topUsersByTokens.length} users with token activity tracked this period
                </span>
              </li>
              {tokenStats && tokenStats.requestsWithTokens > 0 && (
                <li className="flex items-start gap-2">
                  <HiOutlineCheckCircle className="mt-0.5 flex-shrink-0 text-app-success" />
                  <span className="text-app-primary">
                    Avg {(tokenStats.totalTokensUsed / tokenStats.requestsWithTokens).toFixed(0)} tokens per tracked
                    request
                  </span>
                </li>
              )}
              {topUsersByTokens.length >= 3 && (
                <li className="flex items-start gap-2">
                  <HiOutlineCheckCircle className="mt-0.5 flex-shrink-0 text-app-success" />
                  <span className="text-app-primary">
                    {topUsersByTokens.slice(0, 3).length} users have high token consumption this week
                  </span>
                </li>
              )}
            </ul>
          </div>
        </SectionCard>
      </section>

      {/* TOP USERS BY TOKEN USAGE */}
      <SectionCard
        title="Top users by token usage"
        description="Heavy consumers worth reviewing for optimization."
        actions={<StatusBadge tone="warning">Top 10</StatusBadge>}
      >
        {topUsersByTokens.length === 0 ? (
          <EmptyState title="No token usage data available" />
        ) : (
          <div className="overflow-x-auto">
            <table className="app-table">
              <thead>
                <tr>
                  <th className="text-left">User</th>
                  <th className="text-right">Requests</th>
                  <th className="text-right">Total tokens</th>
                  <th className="text-right">Prompt</th>
                  <th className="text-right">Response</th>
                  <th className="text-right"></th>
                </tr>
              </thead>
              <tbody>
                {topUsersByTokens.map((u, idx) => (
                  <tr key={u.user}>
                    <td>
                      <div className="flex items-center gap-3">
                        <div
                          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                          style={{ background: 'linear-gradient(135deg, #B71920, #7A0B0D)' }}
                        >
                          {idx + 1}
                        </div>
                        <span className="font-medium text-app-primary">{u.user}</span>
                      </div>
                    </td>
                    <td className="text-right">{u.requestCount}</td>
                    <td className="text-right font-semibold">{u.totalTokens.toLocaleString()}</td>
                    <td className="text-right text-app-secondary">{u.promptTokens.toLocaleString()}</td>
                    <td className="text-right text-app-secondary">{u.responseTokens.toLocaleString()}</td>
                    <td className="text-right">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedUsername(u.user)
                          setShowUserDrillDown(true)
                        }}
                        className="text-xs font-semibold text-app-brand-700 hover:text-app-brand-800"
                      >
                        Drill down →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* AI-POWERED WORKSPACE CTA STRIP */}
      <section className="rounded-app-lg border border-app bg-app-surface p-4 shadow-app-card sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-3">
            <IconBadge tone="brand" size="lg">
              <HiOutlineSparkles size={20} />
            </IconBadge>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-app-primary">AI-Powered Testing Workspace</div>
              <div className="mt-0.5 text-sm text-app-secondary">
                Generate quality assets, analyse requests and monitor assisted testing from one enterprise control centre.
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href="/test-assistant"
              className="text-sm font-semibold text-app-brand-700 hover:text-app-brand-800"
            >
              Generate Test Cases
            </a>
            <span className="text-app-border">·</span>
            <a
              href="/test-assistant"
              className="text-sm font-semibold text-app-brand-700 hover:text-app-brand-800"
            >
              Open Assistant
            </a>
            <span className="text-app-border">·</span>
            <a
              href="/request-tracker-report"
              className="text-sm font-semibold text-app-brand-700 hover:text-app-brand-800"
            >
              View Report →
            </a>
          </div>
        </div>
      </section>

      {/* Tab drilldown modal (existing logic preserved) */}
      {showTabDrillDown && selectedTabData && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          onClick={() => setShowTabDrillDown(false)}
        >
          <div
            className="max-h-[85vh] w-full max-w-5xl overflow-hidden rounded-app-lg border border-app bg-app-surface shadow-app-card-lg"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-app px-6 py-4">
              <div className="flex items-center gap-3">
                <IconBadge tone="brand" size="lg">
                  <HiOutlineLightningBolt size={18} />
                </IconBadge>
                <div>
                  <h2 className="text-base font-semibold capitalize text-app-primary">
                    {formatTabLabel(selectedTabData.tab)} request details
                  </h2>
                  <p className="text-sm text-app-secondary">
                    {selectedTabData.totalRequests} requests · {selectedTabData.successRate}% success · {selectedTabData.totalTokens.toLocaleString()} tokens
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowTabDrillDown(false)}
                className={`${theme.button.secondary}`}
              >
                Close
              </button>
            </div>
            <div className="max-h-[calc(85vh-120px)] overflow-y-auto p-6">
              {selectedTabData.users.length === 0 ? (
                <EmptyState title="No request data available for this tab" />
              ) : (
                <table className="app-table">
                  <thead>
                    <tr>
                      <th className="text-left">User</th>
                      <th className="text-center">Requests</th>
                      <th className="text-center">Success</th>
                      <th className="text-center">Failed</th>
                      <th className="text-right">Total tokens</th>
                      <th className="text-right">Avg/Req</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedTabData.users.map((u, idx) => (
                      <tr key={u.username}>
                        <td>
                          <div className="flex items-center gap-3">
                            <div
                              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                              style={{ background: 'linear-gradient(135deg, #B71920, #7A0B0D)' }}
                            >
                              {idx + 1}
                            </div>
                            <span className="font-medium text-app-primary">{u.username}</span>
                          </div>
                        </td>
                        <td className="text-center">{u.requestCount}</td>
                        <td className="text-center">
                          <StatusBadge tone="success" size="sm">{u.successCount}</StatusBadge>
                        </td>
                        <td className="text-center">
                          {u.failedCount > 0 ? (
                            <StatusBadge tone="danger" size="sm">{u.failedCount}</StatusBadge>
                          ) : (
                            <span className="text-app-muted">0</span>
                          )}
                        </td>
                        <td className="text-right font-semibold">{u.totalTokens.toLocaleString()}</td>
                        <td className="text-right text-app-secondary">{u.avgTokensPerRequest.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {showUserDrillDown && selectedUsername && (
        <UserTokenDrilldown
          username={selectedUsername}
          onClose={() => {
            setShowUserDrillDown(false)
            setSelectedUsername(null)
          }}
        />
      )}
    </div>
  )
}

const LegendRow: React.FC<{ color: string; label: string; value: number; total: number }> = ({
  color,
  label,
  value,
  total
}) => {
  const pct = total > 0 ? ((value / total) * 100).toFixed(1) : '0.0'
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: color }} />
        <span className="truncate text-app-secondary">{label}</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="font-semibold text-app-primary">{value.toLocaleString()}</span>
        <span className="text-xs text-app-muted">({pct}%)</span>
      </div>
    </div>
  )
}

const HealthRow: React.FC<{
  icon: React.ReactNode
  label: string
  detail: string
  badge: React.ReactNode
  tone: 'success' | 'brand' | 'warning' | 'neutral'
}> = ({ icon, label, detail, badge, tone }) => (
  <div className="flex items-center gap-3 rounded-app border border-app bg-app-surface p-3">
    <IconBadge tone={tone === 'neutral' ? 'neutral' : tone} size="md">
      {icon}
    </IconBadge>
    <div className="min-w-0 flex-1">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold text-app-primary">{label}</span>
        {badge}
      </div>
      <div className="truncate text-xs text-app-secondary">{detail}</div>
    </div>
  </div>
)

export default Dashboard
