/**
 * --- Automation Module: workbench presentation --------------------------
 *
 * Badges and the job progress bar for the Automation TC Coverage Assessment
 * screen, ported from stlc-platform's shared.tsx onto this app's tokens.
 *
 * Every badge that can carry a reason does: a classification or a blocked
 * approval is a judgement someone is about to act on in bulk, and a bare
 * coloured word gives them nothing to check it against.
 */
import React from 'react'
import StatusBadge from '../ui/StatusBadge'
import type {
  ApprovalStatus,
  CaseOrigin,
  Classification,
  TestDataStatus
} from '../../types/automation'

type Tone = 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'neutral'

const CLASSIFICATION: Record<Classification, { tone: Tone; label: string }> = {
  automation: { tone: 'success', label: 'Automation' },
  manual: { tone: 'warning', label: 'Manual' },
  undecided: { tone: 'neutral', label: 'Unclassified' }
}

export const ClassificationBadge: React.FC<{ classification: Classification }> = ({
  classification
}) => {
  const meta = CLASSIFICATION[classification] ?? CLASSIFICATION.undecided
  return (
    <StatusBadge tone={meta.tone} size="sm" dot>
      {meta.label}
    </StatusBadge>
  )
}

const APPROVAL: Record<ApprovalStatus, { tone: Tone; label: string }> = {
  draft: { tone: 'neutral', label: 'Draft' },
  approved: { tone: 'success', label: 'Approved' },
  rejected: { tone: 'danger', label: 'Rejected' }
}

export const ApprovalBadge: React.FC<{ status: ApprovalStatus }> = ({ status }) => {
  const meta = APPROVAL[status] ?? APPROVAL.draft
  return (
    <StatusBadge tone={meta.tone} size="sm">
      {meta.label}
    </StatusBadge>
  )
}

const ORIGIN: Record<CaseOrigin, { label: string; title: string }> = {
  existing: {
    label: 'Existing',
    title: 'Refined in place from an approved test case — its ID and name were preserved.'
  },
  imported: { label: 'Imported', title: 'Came in through Studio intake.' },
  derived: { label: 'Derived', title: 'Generated to fill a coverage gap; had no prior test case.' }
}

export const OriginBadge: React.FC<{ origin: CaseOrigin }> = ({ origin }) => {
  const meta = ORIGIN[origin] ?? ORIGIN.imported
  return (
    <span title={meta.title}>
      <StatusBadge tone="info" size="sm">
        {meta.label}
      </StatusBadge>
    </span>
  )
}

/**
 * `pending` is the only one that means anything urgent — it blocks approval,
 * because a case that cannot run until someone provisions an account would
 * otherwise sail through review and fail on its first execution.
 */
export const TestDataBadge: React.FC<{
  required: boolean
  status: TestDataStatus
}> = ({ required, status }) => {
  if (!required && status === 'not_required') {
    return <span className="text-[12px] text-app-secondary">Not required</span>
  }
  if (status === 'pending') {
    return (
      <span title="Blocks approval until the data is provided">
        <StatusBadge tone="warning" size="sm" dot>
          Pending
        </StatusBadge>
      </span>
    )
  }
  return (
    <StatusBadge tone="success" size="sm">
      Ready
    </StatusBadge>
  )
}

/**
 * Progress for a refinement batch.
 *
 * Shows the message as well as the bar: "Refining TC-AUTH-04 (3 of 12)" tells
 * someone whether a slow batch is moving, which a percentage alone does not
 * when one case takes fifteen seconds.
 */
export const JobProgress: React.FC<{
  percent: number
  message: string
  tone?: 'running' | 'failed'
}> = ({ percent, message, tone = 'running' }) => (
  <div className="rounded-app border border-app bg-app-surface-muted/50 px-3 py-2.5">
    <div className="mb-1.5 flex items-center justify-between gap-3">
      <span className="min-w-0 truncate text-[12px] text-app-primary">{message}</span>
      <span className="flex-shrink-0 text-[12px] font-semibold text-app-secondary">
        {percent}%
      </span>
    </div>
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-app-surface">
      <div
        className={`h-full rounded-full transition-all duration-300 ${
          tone === 'failed' ? 'bg-app-danger' : 'bg-app-brand-600'
        }`}
        style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
      />
    </div>
  </div>
)

export const StatTile: React.FC<{
  label: string
  value: React.ReactNode
  tone?: 'default' | 'success' | 'warning'
  hint?: string
}> = ({ label, value, tone = 'default', hint }) => (
  <div
    className={[
      'rounded-app-lg border bg-app-surface px-4 py-3 shadow-app-card',
      tone === 'warning'
        ? 'border-orange-200'
        : tone === 'success'
          ? 'border-green-200'
          : 'border-app'
    ].join(' ')}
  >
    <div className="text-[12px] font-medium text-app-secondary">{label}</div>
    <div
      className={[
        'mt-1 text-[24px] font-bold leading-none tracking-tight',
        tone === 'warning'
          ? 'text-app-warning'
          : tone === 'success'
            ? 'text-app-success'
            : 'text-app-primary'
      ].join(' ')}
    >
      {value}
    </div>
    {hint ? <div className="mt-1 text-[11px] text-app-warning">{hint}</div> : null}
  </div>
)
