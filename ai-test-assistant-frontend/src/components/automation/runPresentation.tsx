/**
 * --- Automation Module: run presentation --------------------------------
 *
 * Shared formatting for the Runs table and the Run Detail page, so a status
 * never reads one way in the list and another way on the page it links to.
 */
import React from 'react'
import StatusBadge from '../ui/StatusBadge'
import { formatToDubaiTime } from '../../utils/formatToDubaiTime'
import type { ResultStatus, RunOutcome, RunStatus } from '../../types/automation'

/**
 * Timestamps arrive from `datetime.utcnow().isoformat()` — UTC, but with no
 * trailing Z and no offset. `new Date()` reads a bare datetime like that as
 * *local* time, which silently shifts every run by the UTC offset. Marking it
 * as UTC before parsing is what keeps Dubai time correct.
 */
export function parseServerTime(value: string | null | undefined): Date | null {
  if (!value) return null
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
  const date = new Date(hasZone ? value : `${value}Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatWhen(value: string | null | undefined): string {
  const date = parseServerTime(value)
  return date ? formatToDubaiTime(date) : '—'
}

/** Compact relative age, for a column where a full timestamp is too wide. */
export function formatAge(value: string | null | undefined): string {
  const date = parseServerTime(value)
  if (!date) return '—'
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`
}

export function formatMillis(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

const STATUS_TONE: Record<RunStatus, 'info' | 'brand' | 'success' | 'danger' | 'neutral'> = {
  queued: 'neutral',
  running: 'info',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral'
}

const OUTCOME_TONE: Record<'passed' | 'failed' | 'blocked', 'success' | 'danger' | 'warning'> = {
  passed: 'success',
  failed: 'danger',
  blocked: 'warning'
}

const RESULT_TONE: Record<ResultStatus, 'success' | 'danger' | 'warning' | 'neutral'> = {
  pass: 'success',
  fail: 'danger',
  error: 'danger',
  skip: 'neutral',
  blocked: 'warning'
}

export const RunStatusBadge: React.FC<{ status: RunStatus; live?: boolean }> = ({
  status,
  live = false
}) => (
  <StatusBadge tone={STATUS_TONE[status] ?? 'neutral'} size="sm" dot>
    <span className={live && status === 'running' ? 'animate-pulse' : undefined}>{status}</span>
  </StatusBadge>
)

/**
 * Outcome is deliberately distinct from status. A run that never started
 * tested nothing, so it reads `blocked` rather than `failed` — calling it
 * failed would blame the application for an infrastructure problem.
 */
export const OutcomeBadge: React.FC<{ outcome: RunOutcome; status?: RunStatus }> = ({
  outcome,
  status
}) => {
  if (!outcome) {
    if (status === 'cancelled') {
      return (
        <span className="text-[12px] text-app-secondary" title="Cancelled before it could report">
          cancelled
        </span>
      )
    }
    return <span className="text-[12px] text-app-secondary">—</span>
  }

  const title =
    outcome === 'blocked'
      ? 'The run never reached the tests — an infrastructure problem, not a test failure.'
      : undefined

  return (
    <span title={title}>
      <StatusBadge tone={OUTCOME_TONE[outcome] ?? 'neutral'} size="sm">
        {outcome}
      </StatusBadge>
    </span>
  )
}

export const ResultStatusBadge: React.FC<{ status: ResultStatus }> = ({ status }) => (
  <StatusBadge tone={RESULT_TONE[status] ?? 'neutral'} size="sm">
    {status}
  </StatusBadge>
)
