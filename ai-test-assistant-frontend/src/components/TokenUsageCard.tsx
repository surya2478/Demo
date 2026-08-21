import React, { useEffect, useState } from 'react'
import api from '../services/api'
import Button from './shared/Button'
import EmptyState from './ui/EmptyState'
import SectionCard from './ui/SectionCard'
import StatCard from './ui/StatCard'

interface TokenStats {
  period_days: number
  total_tokens: number
  total_prompt_tokens: number
  total_response_tokens: number
  per_user: Array<{
    user: string
    total_tokens: number
    prompt_tokens: number
    response_tokens: number
    request_count: number
  }>
  per_session: Array<{
    session_id: string
    user: string
    total_tokens: number
    prompt_tokens: number
    response_tokens: number
    request_count: number
  }>
  by_tab: Array<{
    tab: string
    total_tokens: number
    prompt_tokens: number
    response_tokens: number
  }>
}

interface TokenUsageCardProps {
  refreshInterval?: number
}

const TokenUsageCard: React.FC<TokenUsageCardProps> = ({ refreshInterval = 30000 }) => {
  const [tokenStats, setTokenStats] = useState<TokenStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadTokenStats = async () => {
    try {
      setError(null)
      const response = await api.get('/request-tracker/token-stats?days=1')
      setTokenStats(response.data)
    } catch (err: any) {
      console.error('Failed to load token stats:', err)
      setError('Failed to load token usage data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadTokenStats()

    if (refreshInterval && refreshInterval > 0) {
      const interval = setInterval(loadTokenStats, refreshInterval)
      return () => clearInterval(interval)
    }
  }, [refreshInterval])

  if (loading) {
    return (
      <SectionCard title="Token Usage" description="Loading the latest 24-hour token statistics.">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, idx) => (
            <div key={idx} className="h-28 animate-pulse rounded-3xl bg-app-brand-50" />
          ))}
        </div>
      </SectionCard>
    )
  }

  if (error || !tokenStats) {
    return (
      <SectionCard title="Token Usage" description="Last 24 hours">
        <EmptyState title={error || 'No token data available'} />
      </SectionCard>
    )
  }

  const avgTokensPerUser = tokenStats.per_user.length > 0 ? Math.round(tokenStats.total_tokens / tokenStats.per_user.length) : 0

  return (
    <SectionCard
      title="Token Usage - Last 24 Hours"
      description="Tracks prompt, response, and total tokens per user and session."
      actions={<Button onClick={loadTokenStats} variant="secondary">Refresh</Button>}
    >
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Total Tokens" value={tokenStats.total_tokens.toLocaleString()} hint="All tracked tokens" />
          <StatCard label="Prompt Tokens" value={tokenStats.total_prompt_tokens.toLocaleString()} hint="Input usage" tone="success" />
          <StatCard label="Response Tokens" value={tokenStats.total_response_tokens.toLocaleString()} hint="Output usage" tone="warning" />
          <StatCard label="Average Per User" value={avgTokensPerUser.toLocaleString()} hint="Average token spend" tone="neutral" />
        </div>

        <div className="grid gap-6 xl:grid-cols-3">
          <div className="rounded-3xl border border-app bg-app-brand-50/50 p-4">
            <h4 className="text-sm font-semibold text-app-primary">Token Usage by User</h4>
            <div className="mt-4 space-y-2 max-h-64 overflow-y-auto pr-1">
              {tokenStats.per_user.length > 0 ? (
                tokenStats.per_user.map((user, idx) => (
                  <div key={idx} className="rounded-2xl border border-app bg-app-surface px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-app-primary">{user.user}</div>
                        <div className="mt-1 text-xs text-app-secondary">
                          {user.request_count} request{user.request_count !== 1 ? 's' : ''}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-app-primary">{user.total_tokens.toLocaleString()}</div>
                        <div className="text-xs text-app-secondary">
                          <span className="text-green-700">P: {user.prompt_tokens}</span> | <span className="text-app-brand-700">R: {user.response_tokens}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-app-secondary">No user token data available</p>
              )}
            </div>
          </div>

          <div className="rounded-3xl border border-app bg-app-brand-50/50 p-4">
            <h4 className="text-sm font-semibold text-app-primary">Token Usage by Session</h4>
            <div className="mt-4 space-y-2 max-h-64 overflow-y-auto pr-1">
              {tokenStats.per_session.length > 0 ? (
                tokenStats.per_session.map((session, idx) => (
                  <div key={idx} className="rounded-2xl border border-app bg-app-surface px-4 py-3">
                    <div className="text-sm font-medium text-app-primary truncate">{session.session_id}</div>
                    <div className="mt-1 text-xs text-app-secondary">
                      User: {session.user} | {session.request_count} request{session.request_count !== 1 ? 's' : ''}
                    </div>
                    <div className="mt-2 text-sm font-semibold text-app-primary">{session.total_tokens.toLocaleString()}</div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-app-secondary">No session token data available</p>
              )}
            </div>
          </div>

          <div className="rounded-3xl border border-app bg-app-brand-50/50 p-4">
            <h4 className="text-sm font-semibold text-app-primary">Token Usage by Tab</h4>
            <div className="mt-4 space-y-4">
              {tokenStats.by_tab.length > 0 ? (
                tokenStats.by_tab.map((tab, idx) => {
                  const percentage = tokenStats.total_tokens > 0 ? (tab.total_tokens / tokenStats.total_tokens) * 100 : 0
                  return (
                    <div key={idx} className="space-y-1">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium capitalize text-app-primary">{tab.tab}</div>
                        <div className="text-xs text-app-secondary">
                          {tab.total_tokens.toLocaleString()} ({percentage.toFixed(1)}%)
                        </div>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-app-brand-100">
                        <div className="h-full rounded-full bg-app-brand-700" style={{ width: `${percentage}%` }} />
                      </div>
                      <div className="text-xs text-app-secondary">
                        Prompt: {tab.prompt_tokens} | Response: {tab.response_tokens}
                      </div>
                    </div>
                  )
                })
              ) : (
                <p className="text-sm text-app-secondary">No tab data available</p>
              )}
            </div>
          </div>
        </div>

        <div className="border-t border-app pt-4 text-xs text-app-muted">
          Last updated: {new Date().toLocaleTimeString()}
        </div>
      </div>
    </SectionCard>
  )
}

export default TokenUsageCard
