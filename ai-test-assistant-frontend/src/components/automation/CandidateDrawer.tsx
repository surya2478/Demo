/**
 * --- Automation Module: candidate drawer --------------------------------
 *
 * The full test case behind a row, with its eligibility breakdown.
 *
 * The detail endpoint returns the stored shape verbatim — title-case keys with
 * spaces, exactly as generation wrote them. Rather than mapping a fixed list of
 * fields and silently dropping anything unexpected, the known fields are
 * ordered first and everything else is rendered after, so a case with extra
 * content still shows all of it.
 */
import React, { useEffect, useState } from 'react'
import { HiOutlineX, HiOutlinePlay, HiOutlineExclamationCircle } from 'react-icons/hi'
import automationService from '../../services/automationService'
import StatusBadge from '../ui/StatusBadge'
import LoadingSkeleton from '../ui/LoadingSkeleton'
import EligibilityMeter from './EligibilityMeter'
import type { ApprovedCandidateDetail, Candidate } from '../../types/automation'

interface CandidateDrawerProps {
  candidate: Candidate | null
  onClose: () => void
  onRun: (candidate: Candidate) => void
  canExecute: boolean
}

/** Ordered first when present; anything else follows in its stored order. */
const PREFERRED_FIELDS = [
  'Test Case ID',
  'Category',
  'Test Case Description',
  'Preconditions',
  'Test Steps',
  'Test Data',
  'Expected Result'
]

const renderValue = (value: unknown): React.ReactNode => {
  if (value === null || value === undefined || value === '') {
    return <span className="italic text-app-secondary">Not provided</span>
  }
  if (Array.isArray(value)) {
    return (
      <ol className="list-decimal space-y-1 pl-5">
        {value.map((item, i) => (
          <li key={i}>{String(item)}</li>
        ))}
      </ol>
    )
  }
  if (typeof value === 'object') {
    return (
      <pre className="app-scroll overflow-x-auto rounded-app bg-app-surface-muted px-3 py-2 font-mono text-[11px]">
        {JSON.stringify(value, null, 2)}
      </pre>
    )
  }
  return <span className="whitespace-pre-wrap">{String(value)}</span>
}

export const CandidateDrawer: React.FC<CandidateDrawerProps> = ({
  candidate,
  onClose,
  onRun,
  canExecute
}) => {
  const [detail, setDetail] = useState<ApprovedCandidateDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDetail(null)
    setError(null)

    if (!candidate) return
    // Only approved cases have a detail endpoint in Phase 0. A Studio-authored
    // case already carries everything the list returned.
    if (candidate.source !== 'approved' || !candidate.origin_test_case_id) return

    let cancelled = false
    setLoading(true)
    automationService
      .getApprovedCandidate(candidate.origin_test_case_id)
      .then(data => {
        if (!cancelled) setDetail(data)
      })
      .catch(err => {
        if (!cancelled) setError(err?.message ?? 'That test case could not be loaded.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [candidate])

  useEffect(() => {
    if (!candidate) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [candidate, onClose])

  if (!candidate) return null

  const details = detail?.details ?? {}
  const keys = Object.keys(details)
  const ordered = [
    ...PREFERRED_FIELDS.filter(f => keys.includes(f)),
    ...keys.filter(k => !PREFERRED_FIELDS.includes(k))
  ]

  const eligibility = detail?.eligibility ?? candidate.eligibility

  return (
    <div
      className="fixed inset-0 z-[60] flex justify-end bg-slate-900/50 backdrop-blur-sm"
      onClick={e => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
    >
      <aside className="flex h-full w-full max-w-[620px] flex-col overflow-hidden border-l border-app bg-app-surface shadow-[0_28px_70px_rgba(15,23,42,0.18)]">
        <div className="flex items-start justify-between gap-3 border-b border-app bg-app-surface-muted px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-[15px] font-bold text-app-primary">
                {candidate.display_id}
              </h2>
              <StatusBadge tone={candidate.source === 'approved' ? 'info' : 'brand'} size="sm">
                {candidate.source}
              </StatusBadge>
            </div>
            {candidate.category ? (
              <p className="mt-0.5 truncate text-[12px] text-app-secondary">
                {candidate.category}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-app-secondary transition hover:bg-app-surface hover:text-app-primary"
            aria-label="Close"
          >
            <HiOutlineX className="h-5 w-5" />
          </button>
        </div>

        <div className="app-scroll flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <EligibilityMeter eligibility={eligibility} />

          {error ? (
            <div className="flex items-start gap-2 rounded-app border border-red-200 bg-app-danger-bg px-3 py-3 text-[13px] text-app-danger">
              <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          {loading ? (
            <div className="space-y-2">
              <LoadingSkeleton className="h-5 w-40" />
              <LoadingSkeleton className="h-24 w-full" rounded="lg" />
              <LoadingSkeleton className="h-24 w-full" rounded="lg" />
            </div>
          ) : null}

          {!loading && ordered.length > 0
            ? ordered.map(key => (
                <div key={key}>
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-app-secondary">
                    {key}
                  </h3>
                  <div className="rounded-app border border-app bg-app-surface-muted/40 px-3 py-2.5 text-[13px] leading-6 text-app-primary">
                    {renderValue(details[key])}
                  </div>
                </div>
              ))
            : null}

          {!loading && ordered.length === 0 && !error ? (
            <div className="space-y-3">
              <div>
                <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-app-secondary">
                  Description
                </h3>
                <div className="rounded-app border border-app bg-app-surface-muted/40 px-3 py-2.5 text-[13px] leading-6 text-app-primary">
                  {renderValue(candidate.description)}
                </div>
              </div>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-app border border-app px-3 py-2.5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-app-secondary">
                Approved by
              </div>
              <div className="mt-0.5 text-[13px] text-app-primary">
                {candidate.approved_by ?? '—'}
              </div>
            </div>
            <div className="rounded-app border border-app px-3 py-2.5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-app-secondary">
                Approved at
              </div>
              <div className="mt-0.5 text-[13px] text-app-primary">
                {candidate.approved_at ?? '—'}
              </div>
            </div>
            <div className="rounded-app border border-app px-3 py-2.5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-app-secondary">
                Generated by
              </div>
              <div className="mt-0.5 text-[13px] text-app-primary">
                {candidate.generated_by ?? '—'}
              </div>
            </div>
            <div className="rounded-app border border-app px-3 py-2.5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-app-secondary">
                Origin request
              </div>
              <div className="mt-0.5 break-all font-mono text-[12px] text-app-primary">
                {candidate.origin_request_id ?? '—'}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-app bg-app-surface-muted px-5 py-3">
          <button type="button" onClick={onClose} className="app-btn app-btn-secondary">
            Close
          </button>
          <button
            type="button"
            onClick={() => onRun(candidate)}
            disabled={!canExecute}
            title={canExecute ? undefined : 'You do not have permission to execute runs.'}
            className="app-btn app-btn-primary inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <HiOutlinePlay className="h-4 w-4" />
            Run a spec
          </button>
        </div>
      </aside>
    </div>
  )
}

export default CandidateDrawer
