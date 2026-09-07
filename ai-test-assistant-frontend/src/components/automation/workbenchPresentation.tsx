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
  CheckStatus,
  Classification,
  ClassificationFinding,
  ClassificationReport,
  FindingSeverity,
  TestDataStatus
} from '../../types/automation'

type Tone = 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'neutral'

/**
 * Four outcomes, and the tones say which way each one points. Partial is
 * `info` rather than `warning`: it is not a problem with the case, it is a
 * short list of edits, and giving it Manual's colour would send reviewers
 * hunting for something wrong.
 */
const CLASSIFICATION: Record<
  Classification,
  { tone: Tone; label: string; title: string }
> = {
  automation: {
    tone: 'success',
    label: 'Automation',
    title: 'Every step is executable, the channel is drivable, and the controls were found.'
  },
  partial: {
    tone: 'info',
    label: 'Needs minor changes',
    title: 'Automatable once the listed edits are made — no part of it needs a person.'
  },
  manual: {
    tone: 'warning',
    label: 'Manual',
    title: 'Something in it cannot run unattended.'
  },
  undecided: {
    tone: 'neutral',
    label: 'Unclassified',
    title: 'There is not enough here to judge yet.'
  }
}

export const ClassificationBadge: React.FC<{ classification: Classification }> = ({
  classification
}) => {
  const meta = CLASSIFICATION[classification] ?? CLASSIFICATION.undecided
  return (
    <span title={meta.title}>
      <StatusBadge tone={meta.tone} size="sm" dot>
        {meta.label}
      </StatusBadge>
    </span>
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
  if (status === 'user_provided') {
    // Distinguished from "Ready" on purpose: Ready is derived from the
    // requirements list, this one is a person's word that the data exists.
    // Anyone auditing an approval wants to see which of the two it was.
    return (
      <span title="A user confirmed the test data has been provided">
        <StatusBadge tone="success" size="sm" dot>
          Provided
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

/**
 * --- The rules, shown ----------------------------------------------------
 *
 * A verdict a person is about to accept for thirty test cases at once has to
 * be checkable, and one sentence under a badge is not enough to check. This
 * lays out the four questions the rules asked -- every step, the channel, the
 * knowledge base, the test data -- with their answers and, for anything that
 * needs work, the step it happened on and what to do about it.
 *
 * Findings are grouped by what they cost: blockers first, because they are the
 * reason a case is Manual and no amount of editing changes them, then the
 * fixables, which are the work. Notes come last and are muted -- they explain
 * a verdict rather than qualify it.
 */
const CHECK_LABELS: Record<string, { title: string; blurb: string }> = {
  steps: {
    title: 'Steps',
    blurb: 'Is every step an instruction a runner could execute?'
  },
  channel: {
    title: 'Channel',
    blurb: 'Does this case happen somewhere the runner can reach?'
  },
  knowledge_base: {
    title: 'Knowledge base',
    blurb: 'Do the controls these steps name exist in what we discovered?'
  },
  test_data: {
    title: 'Test data',
    blurb: 'Do the steps ask for data the case does not carry?'
  }
}

const CHECK_TONE: Record<CheckStatus, { dot: string; text: string }> = {
  pass: { dot: 'bg-app-success', text: 'text-app-success' },
  attention: { dot: 'bg-app-warning', text: 'text-app-warning' },
  blocked: { dot: 'bg-app-danger', text: 'text-app-danger' }
}

const SEVERITY_STYLE: Record<FindingSeverity, string> = {
  blocker: 'border-l-2 border-app-danger bg-red-500/[0.04]',
  fixable: 'border-l-2 border-app-warning bg-amber-500/[0.04]',
  note: 'border-l-2 border-app bg-app-surface-muted/40'
}

const FindingRow: React.FC<{ finding: ClassificationFinding }> = ({ finding }) => (
  <li className={`rounded-r-md px-3 py-2 ${SEVERITY_STYLE[finding.severity]}`}>
    <p className="text-[12px] leading-5 text-app-primary">
      {finding.step_number ? (
        <span className="mr-1.5 rounded bg-app-surface px-1.5 py-0.5 text-[11px] font-semibold text-app-secondary">
          Step {finding.step_number}
        </span>
      ) : null}
      {finding.message}
    </p>
    {finding.remedy ? (
      <p className="mt-1 text-[11px] leading-4 text-app-secondary">→ {finding.remedy}</p>
    ) : null}
    {finding.evidence ? (
      <p className="mt-1 truncate text-[11px] italic leading-4 text-app-secondary/80">
        “{finding.evidence}”
      </p>
    ) : null}
  </li>
)

export const ClassificationReportPanel: React.FC<{ report: ClassificationReport }> = ({
  report
}) => {
  const ordered: FindingSeverity[] = ['blocker', 'fixable', 'note']
  const grouped = {
    blocker: report.blockers,
    fixable: report.fixables,
    note: report.notes
  }
  const heading: Record<FindingSeverity, string> = {
    blocker: 'Cannot be automated',
    fixable: 'Needs a change first',
    note: 'Worth knowing'
  }

  return (
    <div className="space-y-4">
      <div className="rounded-app-lg border border-app bg-app-surface-muted/50 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <ClassificationBadge classification={report.classification} />
          <span className="text-[12px] text-app-secondary">
            {report.counts.steps} step(s) · {report.counts.blockers} blocker(s) ·{' '}
            {report.counts.fixables} change(s) needed
          </span>
        </div>
        <p className="mt-1.5 text-[13px] leading-5 text-app-primary">{report.reason}</p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {(Object.keys(CHECK_LABELS) as (keyof typeof report.checks)[]).map(key => {
          const check = report.checks[key]
          if (!check) return null
          const tone = CHECK_TONE[check.status] ?? CHECK_TONE.pass
          return (
            <div key={key} className="rounded-app border border-app bg-app-surface px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 flex-shrink-0 rounded-full ${tone.dot}`} />
                <span className="text-[12px] font-semibold text-app-primary">
                  {CHECK_LABELS[key].title}
                </span>
                <span className={`ml-auto text-[11px] font-medium capitalize ${tone.text}`}>
                  {check.status}
                </span>
              </div>
              <p className="mt-1 text-[12px] leading-4 text-app-secondary">{check.summary}</p>
              <p className="mt-1 text-[11px] leading-4 text-app-secondary/70">
                {CHECK_LABELS[key].blurb}
              </p>
            </div>
          )
        })}
      </div>

      {ordered.map(severity =>
        grouped[severity].length ? (
          <div key={severity}>
            <h4 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-app-secondary">
              {heading[severity]} ({grouped[severity].length})
            </h4>
            <ul className="space-y-1.5">
              {grouped[severity].map((finding, index) => (
                <FindingRow key={`${finding.code}-${finding.step_number}-${index}`} finding={finding} />
              ))}
            </ul>
          </div>
        ) : null
      )}

      {report.checked_at ? (
        <p className="text-[11px] text-app-secondary">
          Checked {new Date(report.checked_at + 'Z').toLocaleString()} · rules only, no model call.
        </p>
      ) : null}
    </div>
  )
}

/*
 * --- The guided run ------------------------------------------------------
 *
 * Four of the toolbar's actions are a sequence, not a menu, and nothing on
 * the screen used to say so: approving before classifying puts a manual case
 * in the Script Lab's queue where it will never generate, and refining after
 * approval rewrites a case someone has already signed off. The number lives
 * on the button rather than in a legend beside it, because the legend is not
 * where the decision gets made.
 *
 * Steps stay numbered when they are disabled. A greyed-out "3" still tells
 * someone the order they are working in; hiding it would leave them guessing
 * why the row looks different from the last time they were here.
 */
export const StepBadge: React.FC<{ n: number; done?: boolean }> = ({ n, done = false }) => (
  <span
    aria-hidden
    className={`flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold leading-none ${
      done ? 'bg-app-success text-white' : 'bg-app-brand-700 text-white'
    }`}
  >
    {n}
  </span>
)

/** The connector between two steps -- reads as "then", costs 10px of width. */
export const StepChevron: React.FC = () => (
  <svg
    viewBox="0 0 12 12"
    aria-hidden
    className="h-2.5 w-2.5 flex-shrink-0 text-app-brand-200"
  >
    <path
      d="M4.5 2.5 8 6l-3.5 3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

/**
 * The pointer to whatever comes next.
 *
 * Anchored inside the wrapper of the step it is pointing at rather than
 * positioned by measurement: the toolbar wraps at laptop width, and a callout
 * placed from a bounding rect ends up beside the wrong button the moment the
 * row reflows. Absolute-inside-relative follows the button wherever it lands.
 */
export const StepHint: React.FC<{
  title: string
  body: string
  onDismiss: () => void
  actionLabel?: string
  onAction?: () => void
  align?: 'left' | 'right'
}> = ({ title, body, onDismiss, actionLabel, onAction, align = 'left' }) => (
  <div
    role="status"
    className={`absolute top-full z-[60] mt-2.5 w-[248px] rounded-app border border-app-brand-200 bg-app-surface p-3 text-left shadow-app-card-lg ${
      align === 'right' ? 'right-0' : 'left-0'
    }`}
  >
    <span
      aria-hidden
      className={`absolute -top-[7px] h-3 w-3 rotate-45 border-l border-t border-app-brand-200 bg-app-surface ${
        align === 'right' ? 'right-6' : 'left-6'
      }`}
    />
    <p className="text-[12px] font-semibold leading-snug text-app-primary">{title}</p>
    <p className="mt-1 text-[11px] leading-snug text-app-secondary">{body}</p>
    <div className="mt-2.5 flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={onDismiss}
        className="rounded-app px-1.5 py-1 text-[11px] font-medium text-app-secondary transition hover:text-app-primary"
      >
        {actionLabel && onAction ? 'Not now' : 'Got it'}
      </button>
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="app-btn app-btn-primary !px-2.5 !py-1 text-[11px] font-semibold"
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  </div>
)
