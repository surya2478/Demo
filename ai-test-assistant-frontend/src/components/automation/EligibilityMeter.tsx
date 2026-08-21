/**
 * --- Automation Module: eligibility meter -------------------------------
 *
 * A score with its reasons, never a score alone.
 *
 * The backend scorer is deterministic and names every shortfall precisely so
 * an author can act on it. Showing "55" without "no discrete steps, mentions
 * OTP" would throw that away and leave the number looking arbitrary.
 */
import React from 'react'
import StatusBadge from '../ui/StatusBadge'
import type { Eligibility, Verdict } from '../../types/automation'

interface EligibilityMeterProps {
  eligibility: Eligibility | null | undefined
  compact?: boolean
  className?: string
}

const VERDICT_TONE: Record<Verdict, 'success' | 'warning' | 'danger'> = {
  ready: 'success',
  review: 'warning',
  needs_enhancement: 'danger'
}

const VERDICT_LABEL: Record<Verdict, string> = {
  ready: 'Ready',
  review: 'Needs review',
  needs_enhancement: 'Needs enhancement'
}

const VERDICT_BAR: Record<Verdict, string> = {
  ready: 'bg-app-success',
  review: 'bg-app-warning',
  needs_enhancement: 'bg-app-danger'
}

export const verdictTone = (verdict: Verdict | string | null | undefined) =>
  VERDICT_TONE[(verdict as Verdict) ?? 'needs_enhancement'] ?? 'neutral'

export const verdictLabel = (verdict: Verdict | string | null | undefined) =>
  VERDICT_LABEL[(verdict as Verdict) ?? 'needs_enhancement'] ?? String(verdict ?? '—')

export const EligibilityMeter: React.FC<EligibilityMeterProps> = ({
  eligibility,
  compact = false,
  className = ''
}) => {
  if (!eligibility) return null

  const verdict = (eligibility.verdict ?? 'needs_enhancement') as Verdict
  const score = Math.max(0, Math.min(100, eligibility.score ?? 0))
  const reasons = eligibility.reasons ?? []

  return (
    <div
      className={`rounded-app border border-app bg-app-surface-muted/40 px-3 py-3 ${className}`.trim()}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StatusBadge tone={VERDICT_TONE[verdict] ?? 'neutral'} dot size="sm">
            {VERDICT_LABEL[verdict] ?? verdict}
          </StatusBadge>
          <span className="text-[12px] text-app-secondary">
            {eligibility.step_count} {eligibility.step_count === 1 ? 'step' : 'steps'}
          </span>
        </div>
        <span className="text-[18px] font-bold leading-none text-app-primary">
          {score}
          <span className="text-[12px] font-semibold text-app-secondary">/100</span>
        </span>
      </div>

      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-app-surface">
        <div
          className={`h-full rounded-full transition-all ${VERDICT_BAR[verdict] ?? 'bg-app-secondary'}`}
          style={{ width: `${score}%` }}
        />
      </div>

      {!compact && reasons.length > 0 ? (
        <ul className="mt-2.5 space-y-1">
          {reasons.map((reason, i) => (
            <li key={i} className="flex items-start gap-1.5 text-[12px] text-app-secondary">
              <span className="mt-[7px] h-1 w-1 flex-shrink-0 rounded-full bg-app-secondary" />
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {!compact && reasons.length === 0 ? (
        <p className="mt-2.5 text-[12px] text-app-secondary">
          Nothing is missing — this case has steps, expected results, test data and
          preconditions, and no step that needs a human.
        </p>
      ) : null}
    </div>
  )
}

export default EligibilityMeter
