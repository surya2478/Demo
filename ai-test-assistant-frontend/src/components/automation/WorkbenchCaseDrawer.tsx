/**
 * --- One test case, and the findings against it -------------------------
 *
 * Opens from the row, on the right -- the left is where the app's own
 * navigation lives, and a panel over it hides the way out of the screen.
 * The grid can only afford a badge and a sentence per
 * case, so everything behind them lived in three separate dialogs -- the
 * editor, the rule report, the quality review -- and none of them could say
 * "this finding is about that step". Reading a finding meant closing the
 * report, opening the editor, and counting rows.
 *
 * So the two live in one panel here, joined: every rule finding that names a
 * step is a link to that step, the header steps through them one at a time,
 * and the step opens for editing where it lands. Fix it, save, done.
 *
 * Deliberately not a tabbed workspace. Findings, details, steps -- one column,
 * in the order someone works through them.
 *
 * The quality review sits at the bottom and is NOT navigable, because its
 * findings are prose with no step attached to them (`review_findings` is three
 * lists of strings). Guessing which step an issue meant would put a wrong
 * number under a real sentence, so it stays a list.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  HiOutlineX,
  HiOutlineChevronLeft,
  HiOutlineChevronRight,
  HiOutlinePencil,
  HiOutlineSave,
  HiOutlineExclamationCircle,
  HiOutlineLightBulb,
  HiOutlineInformationCircle,
  HiOutlineStar
} from 'react-icons/hi'
import { ApprovalBadge, ClassificationBadge, TestDataBadge } from './workbenchPresentation'
import type {
  ClassificationFinding,
  FindingSeverity,
  RefinedStep,
  WorkbenchCase
} from '../../types/automation'

interface WorkbenchCaseDrawerProps {
  testCase: WorkbenchCase | null
  saving: boolean
  error: string | null
  canExecute: boolean
  onClose: () => void
  onSave: (steps: RefinedStep[]) => void
}

const SEVERITY: Record<
  FindingSeverity,
  { label: string; chip: string; icon: React.ComponentType<{ className?: string }> }
> = {
  blocker: {
    label: 'Blocker',
    chip: 'border-app-danger-border bg-app-danger-bg text-app-danger',
    icon: HiOutlineExclamationCircle
  },
  fixable: {
    label: 'Fixable',
    chip: 'border-app-warning-border bg-app-warning-bg text-app-warning',
    icon: HiOutlineLightBulb
  },
  note: {
    label: 'Note',
    chip: 'border-app bg-app-surface-muted text-app-secondary',
    icon: HiOutlineInformationCircle
  }
}

/** Blockers first: they are what stops the case, and what to read first. */
const ORDER: FindingSeverity[] = ['blocker', 'fixable', 'note']

/** Stable per-step anchor, so a jump does not depend on a ref map. */
const stepDomId = (caseId: number, stepNumber: number) => `wb-case-${caseId}-step-${stepNumber}`

const Field: React.FC<{ label: string; value?: string | null }> = ({ label, value }) =>
  value ? (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-app-secondary">
        {label}
      </p>
      <p className="mt-0.5 whitespace-pre-line text-[13px] leading-relaxed text-app-primary">
        {value}
      </p>
    </div>
  ) : null

const WorkbenchCaseDrawer: React.FC<WorkbenchCaseDrawerProps> = ({
  testCase,
  saving,
  error,
  canExecute,
  onClose,
  onSave
}) => {
  const [steps, setSteps] = useState<RefinedStep[]>([])
  const [dirty, setDirty] = useState(false)
  /** Which step is open for editing -- at most one, by step_number. */
  const [openStep, setOpenStep] = useState<number | null>(null)
  /** Where the finding cursor is, so the header can say "2 of 4". */
  const [cursor, setCursor] = useState(0)
  /** Bumped on every jump, so repeat jumps to one step still scroll. */
  const [jumpNonce, setJumpNonce] = useState(0)


  // A different case means a different set of edits; nothing carries over.
  useEffect(() => {
    setSteps(testCase?.steps ? JSON.parse(JSON.stringify(testCase.steps)) : [])
    setDirty(false)
    setOpenStep(null)
    setCursor(0)
    setJumpNonce(0)
  }, [testCase?.id])

  /*
   * Findings that name a step, in severity order. Only these are navigable:
   * the rest still render, but a "go to step" on a finding with no step number
   * would have nowhere to go.
   */
  const findings = useMemo(() => {
    const report = testCase?.classification_report
    if (!report) return []
    return ORDER.flatMap(severity =>
      severity === 'blocker'
        ? report.blockers
        : severity === 'fixable'
          ? report.fixables
          : report.notes
    )
  }, [testCase?.classification_report])

  const anchored = useMemo(
    () => findings.filter(finding => finding.step_number !== null),
    [findings]
  )

  /*
   * Scrolling is an effect rather than part of the click, because opening a
   * step grows it by a few hundred pixels: a scroll issued in the same tick
   * aims at where the step was before it expanded and lands short of it. The
   * nonce is what makes a second jump to the SAME step scroll again -- two
   * findings on step 5 leave `openStep` unchanged, and without it the second
   * one would do nothing.
   */
  const goToStep = useCallback((stepNumber: number) => {
    setOpenStep(stepNumber)
    setJumpNonce(n => n + 1)
  }, [])

  useEffect(() => {
    if (openStep === null || jumpNonce === 0 || !testCase) return
    document
      .getElementById(stepDomId(testCase.id, openStep))
      // Instant, not smooth: this is a jump to a named step, and an animated
      // scroll past four other steps is slower to read than arriving.
      ?.scrollIntoView({ block: 'center' })
  }, [openStep, jumpNonce, testCase])

  /*
   * A save that worked leaves the panel open on the same case, so nothing else
   * clears the dirty flag -- `testCase.id` has not changed, and the reset
   * effect keys on that. Without this the footer went on claiming unsaved
   * edits over edits that were already on the server.
   */
  const wasSaving = useRef(false)
  useEffect(() => {
    if (wasSaving.current && !saving && !error) setDirty(false)
    wasSaving.current = saving
  }, [saving, error])

  const goToFinding = useCallback(
    (index: number) => {
      if (anchored.length === 0) return
      const next = (index + anchored.length) % anchored.length
      setCursor(next)
      const step = anchored[next].step_number
      if (step !== null) goToStep(step)
    },
    [anchored, goToStep]
  )

  useEffect(() => {
    if (!testCase) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [testCase, onClose])

  if (!testCase) return null

  const updateStep = (index: number, field: keyof RefinedStep, value: string | null) => {
    setSteps(prev => {
      const next = [...prev]
      next[index] = { ...next[index], [field]: value }
      return next
    })
    setDirty(true)
  }

  const review = testCase.review_findings
  const reviewCount =
    (review?.issues?.length ?? 0) +
    (review?.suggestions?.length ?? 0) +
    (review?.coverage_gaps?.length ?? 0)

  return (
    <div
      className="fixed inset-0 z-[70] flex justify-end bg-slate-900/40 backdrop-blur-[1px]"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
      role="presentation"
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`${testCase.tc_display_id} details`}
        className="flex h-full w-full max-w-[580px] flex-col border-l border-app bg-app-surface shadow-app-card-lg"
      >
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="flex items-start gap-3 border-b border-app bg-app-surface-muted px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-semibold text-app-primary">
                {testCase.tc_display_id}
              </span>
              {testCase.version > 1 ? (
                <span className="text-xs text-app-secondary">v{testCase.version}</span>
              ) : null}
            </div>
            <p className="mt-0.5 text-[13px] font-medium leading-snug text-app-primary">
              {testCase.title}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <ClassificationBadge classification={testCase.classification} />
              <ApprovalBadge status={testCase.approval_status} />
              <TestDataBadge
                required={testCase.test_data_required}
                status={testCase.test_data_status}
              />
              {testCase.review_score ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-app bg-app-surface px-2 py-0.5 text-[11px] font-semibold text-app-secondary">
                  <HiOutlineStar className="h-3 w-3 text-amber-500" />
                  {testCase.review_score.toFixed(1)} / 5.0
                </span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="app-btn app-btn-ghost !px-1.5 !py-1"
            aria-label="Close"
          >
            <HiOutlineX className="h-4 w-4" />
          </button>
        </div>

        <div className="app-scroll flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* ── Findings ──────────────────────────────────────────────── */}
          {findings.length > 0 ? (
            <section>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-app-secondary">
                  {findings.length} finding{findings.length === 1 ? '' : 's'}
                  {/* Said out loud, because the two counts differ whenever a
                      finding is about the case rather than about one step. */}
                  {anchored.length !== findings.length ? (
                    <span className="ml-1 font-normal normal-case tracking-normal">
                      · {anchored.length} on steps
                    </span>
                  ) : null}
                </h3>
                {anchored.length > 0 ? (
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] text-app-secondary">
                      {cursor + 1} of {anchored.length}
                    </span>
                    <button
                      type="button"
                      onClick={() => goToFinding(cursor - 1)}
                      className="app-btn app-btn-ghost !px-1 !py-0.5"
                      aria-label="Previous finding"
                      title="Previous finding"
                    >
                      <HiOutlineChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => goToFinding(cursor + 1)}
                      className="app-btn app-btn-ghost !px-1 !py-0.5"
                      aria-label="Next finding"
                      title="Next finding"
                    >
                      <HiOutlineChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : null}
              </div>

              <ul className="mt-2 space-y-1.5">
                {findings.map((finding, index) => (
                  <FindingRow
                    key={`${finding.code}-${index}`}
                    finding={finding}
                    active={
                      finding.step_number !== null &&
                      anchored[cursor]?.step_number === finding.step_number &&
                      openStep === finding.step_number
                    }
                    onGoToStep={() => {
                      const at = anchored.indexOf(finding)
                      if (at >= 0) setCursor(at)
                      if (finding.step_number !== null) goToStep(finding.step_number)
                    }}
                  />
                ))}
              </ul>
            </section>
          ) : (
            <p className="rounded-app border border-dashed border-app bg-app-surface-muted/50 px-3.5 py-3 text-[12px] text-app-secondary">
              {testCase.classification_report
                ? 'The rules found nothing to fix on this case.'
                : 'Not classified by rule yet, so there are no findings to work through. Run AI Classify.'}
            </p>
          )}

          {/* ── Details ───────────────────────────────────────────────── */}
          <section className="space-y-3 border-t border-app pt-4">
            <Field label="Objective" value={testCase.objective} />
            <Field label="Preconditions" value={testCase.preconditions} />
            <Field label="Test data" value={testCase.test_data} />
            <Field label="Expected result" value={testCase.expected_result} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Priority" value={testCase.priority} />
              <Field label="Test type" value={testCase.test_type} />
            </div>
            <Field label="Application URL" value={testCase.application_url} />
            {testCase.test_data_notes ? (
              <Field label="Test data notes" value={testCase.test_data_notes} />
            ) : null}
          </section>

          {/* ── Steps ─────────────────────────────────────────────────── */}
          <section className="border-t border-app pt-4">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-app-secondary">
              {steps.length} step{steps.length === 1 ? '' : 's'}
            </h3>
            <div className="mt-2 space-y-1.5">
              {steps.map((step, index) => {
                const stepFindings = findings.filter(f => f.step_number === step.step_number)
                const open = openStep === step.step_number
                return (
                  <div
                    key={step.step_number}
                    id={stepDomId(testCase.id, step.step_number)}
                    className={`rounded-app border px-3 py-2.5 transition ${
                      open
                        ? 'border-app-brand-300 bg-app-brand-75'
                        : stepFindings.length > 0
                          ? 'border-app-warning-border bg-app-warning-bg/30'
                          : 'border-app bg-app-surface'
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-app-surface-muted text-[11px] font-semibold text-app-secondary">
                        {step.step_number}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] leading-snug text-app-primary">{step.action}</p>
                        {step.target ? (
                          <p className="mt-0.5 truncate font-mono text-[11px] text-app-secondary">
                            {step.target}
                          </p>
                        ) : null}
                        {stepFindings.length > 0 && !open ? (
                          <p className="mt-1 text-[11px] font-medium text-app-warning">
                            {stepFindings.length} finding
                            {stepFindings.length === 1 ? '' : 's'} on this step
                          </p>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        onClick={() => setOpenStep(open ? null : step.step_number)}
                        disabled={!canExecute}
                        className="app-btn app-btn-ghost !px-1.5 !py-1 flex-shrink-0 disabled:opacity-40"
                        title={canExecute ? 'Edit this step' : 'Your role cannot edit test cases'}
                        aria-label={`Edit step ${step.step_number}`}
                      >
                        <HiOutlinePencil className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {open ? (
                      <div className="mt-3 space-y-2.5 border-t border-app-brand-200 pt-3">
                        {/* The finding is repeated here on purpose: it is the
                            instruction being carried out, and scrolling back
                            up to re-read it is how the old flow went wrong. */}
                        {stepFindings.map((finding, i) => (
                          <p
                            key={i}
                            className="rounded-app-sm bg-app-surface px-2.5 py-2 text-[12px] leading-snug text-app-primary"
                          >
                            <span className="font-semibold">{SEVERITY[finding.severity].label}:</span>{' '}
                            {finding.message}
                            {finding.remedy ? (
                              <span className="mt-1 block text-app-secondary">{finding.remedy}</span>
                            ) : null}
                          </p>
                        ))}
                        <StepField
                          label="Action"
                          value={step.action}
                          rows={2}
                          onChange={value => updateStep(index, 'action', value)}
                        />
                        <StepField
                          label="Target"
                          value={step.target ?? ''}
                          onChange={value => updateStep(index, 'target', value || null)}
                        />
                        <StepField
                          label="Expected result"
                          value={step.expected_result ?? ''}
                          rows={2}
                          onChange={value => updateStep(index, 'expected_result', value)}
                        />
                        <StepField
                          label="Test data reference"
                          value={step.test_data_ref ?? ''}
                          mono
                          onChange={value => updateStep(index, 'test_data_ref', value || null)}
                        />
                      </div>
                    ) : null}
                  </div>
                )
              })}
              {steps.length === 0 ? (
                <p className="rounded-app border border-dashed border-app px-3.5 py-3 text-[12px] text-app-secondary">
                  No structured steps on this case yet. Refine it first.
                </p>
              ) : null}
            </div>
          </section>

          {/* ── Quality review ────────────────────────────────────────── */}
          {reviewCount > 0 ? (
            <section className="border-t border-app pt-4">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-app-secondary">
                Quality review
              </h3>
              <p className="mt-1 text-[11px] text-app-secondary">
                The review agent writes prose, not step numbers, so these are not linked to steps.
              </p>
              <ul className="mt-2 space-y-1.5">
                {[
                  ...(review?.issues ?? []).map(text => ({ text, tone: 'text-app-danger' })),
                  ...(review?.suggestions ?? []).map(text => ({ text, tone: 'text-app-warning' })),
                  ...(review?.coverage_gaps ?? []).map(text => ({ text, tone: 'text-app-secondary' }))
                ].map((item, index) => (
                  <li
                    key={index}
                    className="flex gap-2 rounded-app border border-app bg-app-surface px-3 py-2 text-[12px] leading-snug text-app-primary"
                  >
                    <span className={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-current ${item.tone}`} />
                    {item.text}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {error ? (
            <p className="flex items-start gap-2 rounded-app border border-app-danger-border bg-app-danger-bg px-3.5 py-2.5 text-[12px] text-app-danger">
              <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              {error}
            </p>
          ) : null}
        </div>

        {/* ── Footer ──────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-2 border-t border-app bg-app-surface-muted px-5 py-3">
          <p className="text-[11px] text-app-secondary">
            {dirty ? 'Unsaved step edits' : 'Saving re-scores the case'}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="app-btn app-btn-secondary !px-2.5 text-xs font-medium disabled:opacity-50"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => onSave(steps)}
              disabled={!dirty || saving || !canExecute}
              className="app-btn app-btn-primary !px-2.5 inline-flex items-center gap-1.5 text-xs font-semibold disabled:opacity-50"
            >
              {saving ? (
                <span className="h-3.5 w-3.5 rounded-full border-2 border-white/40 border-t-white motion-safe:animate-spin" />
              ) : (
                <HiOutlineSave className="h-3.5 w-3.5" />
              )}
              {saving ? 'Saving' : 'Save steps'}
            </button>
          </div>
        </div>
      </aside>
    </div>
  )
}

const FindingRow: React.FC<{
  finding: ClassificationFinding
  active: boolean
  onGoToStep: () => void
}> = ({ finding, active, onGoToStep }) => {
  const tone = SEVERITY[finding.severity]
  const Icon = tone.icon
  const anchored = finding.step_number !== null
  return (
    <li>
      <button
        type="button"
        onClick={onGoToStep}
        disabled={!anchored}
        className={`flex w-full items-start gap-2 rounded-app border px-3 py-2 text-left transition ${
          active ? 'border-app-brand-300 bg-app-brand-75' : 'border-app bg-app-surface'
        } ${anchored ? 'hover:border-app-brand-300 hover:bg-app-brand-75' : 'cursor-default'}`}
      >
        <Icon
          className={`mt-0.5 h-4 w-4 flex-shrink-0 ${
            finding.severity === 'blocker'
              ? 'text-app-danger'
              : finding.severity === 'fixable'
                ? 'text-app-warning'
                : 'text-app-secondary'
          }`}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] leading-snug text-app-primary">{finding.message}</span>
          {finding.remedy ? (
            <span className="mt-0.5 block text-[11px] leading-snug text-app-secondary">
              {finding.remedy}
            </span>
          ) : null}
        </span>
        {anchored ? (
          <span className={`flex-shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${tone.chip}`}>
            Step {finding.step_number}
          </span>
        ) : null}
      </button>
    </li>
  )
}

const StepField: React.FC<{
  label: string
  value: string
  rows?: number
  mono?: boolean
  onChange: (value: string) => void
}> = ({ label, value, rows, mono, onChange }) => (
  <div>
    <label className="mb-1 block text-[11px] font-semibold text-app-secondary">{label}</label>
    {rows ? (
      <textarea
        value={value}
        rows={rows}
        onChange={event => onChange(event.target.value)}
        className="app-input app-scroll w-full resize-y py-1.5 text-[12px]"
      />
    ) : (
      <input
        value={value}
        onChange={event => onChange(event.target.value)}
        className={`app-input w-full py-1.5 text-[12px] ${mono ? 'font-mono' : ''}`}
      />
    )}
  </div>
)

export default WorkbenchCaseDrawer
