/**
 * --- What the rule pass is doing, while it does it -----------------------
 *
 * Classifying a batch is one POST that can sit for a while on thirty cases,
 * and until it came back the toolbar said nothing beyond a greyed-out row.
 * This is the window onto it: the four checks the rules actually run, in the
 * order they run them, and the real breakdown once the answer is in.
 *
 * Two things about the numbers here are worth keeping honest:
 *
 *  - The stage clock is an *estimate*. The endpoint does not stream, so there
 *    is no per-case progress to read; the checklist advances on elapsed time,
 *    the way AIProcessingModal already does. It deliberately never marks the
 *    last check complete before the response lands, so the modal cannot show
 *    a finished pass that is still running.
 *  - Everything on the result screen is server data -- `updated`, `counts` and
 *    the reports themselves, straight off /workbench/classify. The one derived
 *    number is confidence, and `summariseConfidence` below shows its whole
 *    working: it reads named report fields and nothing else.
 */
import React, { useEffect, useMemo, useState } from 'react'
import {
  HiOutlineSparkles,
  HiOutlineShieldCheck,
  HiOutlineCheckCircle,
  HiOutlineExclamationCircle,
  HiOutlineMinus,
  HiOutlineX
} from 'react-icons/hi'
import type { Classification, ClassificationReport } from '../../types/automation'

export type ClassifyProgressStatus = 'running' | 'done' | 'error'

export interface ClassifyProgressModalProps {
  open: boolean
  status: ClassifyProgressStatus
  /** How many cases were sent, so the header can say what is being judged. */
  total: number
  startedAt: number | null
  /** Server truth, present once the pass has returned. */
  updated?: number
  counts?: Partial<Record<Classification, number>>
  /** The rule reports the pass just wrote -- what confidence is read out of. */
  reports?: ClassificationReport[]
  error?: string | null
  onClose: () => void
  /**
   * Approve the same cases the pass just classified. Optional: without it the
   * footer is the Close button it always was.
   */
  onApprove?: () => void
  /** False greys the approve action rather than hiding it, so the next step is
   *  still visible to someone whose role cannot take it. */
  canApprove?: boolean
}

/*
 * --- Confidence ---------------------------------------------------------
 *
 * The engine emits no score of its own, so this is derived -- and derived only
 * from places the report itself admits the rules were working without evidence.
 * A blocker or a fixable is *not* one of those: those are things the engine
 * positively found, and a case full of them is a verdict it is sure about.
 * What lowers confidence is missing ground truth:
 *
 *   undecided      the engine said outright it could not judge the case
 *   no catalogue   judged with nothing crawled -- the KB check's own words are
 *                  "every locator would be guessed"
 *   unresolved     steps naming a control the catalogue does not have
 *   unreadable     steps that do not read as instructions at all
 *
 * The weights are a judgement call; the inputs are not. Both the tile's caption
 * and its tooltip name the drivers, so the number can always be traced back to
 * the reports it came from.
 */
const WEIGHT_UNRESOLVED = 0.35
const WEIGHT_NO_CATALOG = 0.25
const WEIGHT_UNREADABLE = 0.2

export interface ConfidenceSummary {
  percent: number
  /** How many reports went into it. Zero means there is nothing to show. */
  scored: number
  /** What pulled it below 100, worst first, already worded for the caption. */
  drivers: string[]
}

export const summariseConfidence = (reports: ClassificationReport[]): ConfidenceSummary => {
  if (reports.length === 0) return { percent: 0, scored: 0, drivers: [] }

  let undecided = 0
  let noCatalog = 0
  let unresolvedTargets = 0
  let unreadableSteps = 0
  let total = 0

  for (const report of reports) {
    if (report.classification === 'undecided') {
      undecided += 1
      continue // Scores zero: the engine declined to judge it at all.
    }

    let score = 1
    const steps = report.checks.steps
    if (steps.total > 0 && steps.actionable < steps.total) {
      unreadableSteps += steps.total - steps.actionable
      score -= WEIGHT_UNREADABLE * (1 - steps.actionable / steps.total)
    }

    const kb = report.checks.knowledge_base
    const resolvable = kb.matched + kb.unresolved.length
    if (resolvable > 0 && kb.unresolved.length > 0) {
      unresolvedTargets += kb.unresolved.length
      score -= WEIGHT_UNRESOLVED * (kb.unresolved.length / resolvable)
    }
    if (kb.catalog_size === 0) {
      noCatalog += 1
      score -= WEIGHT_NO_CATALOG
    }

    total += Math.max(0, Math.min(1, score))
  }

  const drivers: { weight: number; text: string }[] = []
  if (undecided > 0) {
    drivers.push({ weight: undecided * 100, text: `${undecided} could not be judged` })
  }
  if (noCatalog > 0) {
    drivers.push({
      weight: noCatalog * WEIGHT_NO_CATALOG * 100,
      text: `${noCatalog} judged with no catalogue`
    })
  }
  if (unresolvedTargets > 0) {
    drivers.push({
      weight: unresolvedTargets * WEIGHT_UNRESOLVED * 10,
      text: `${unresolvedTargets} target${unresolvedTargets === 1 ? '' : 's'} not in the catalogue`
    })
  }
  if (unreadableSteps > 0) {
    drivers.push({
      weight: unreadableSteps * WEIGHT_UNREADABLE * 10,
      text: `${unreadableSteps} step${unreadableSteps === 1 ? '' : 's'} unreadable`
    })
  }
  drivers.sort((a, b) => b.weight - a.weight)

  return {
    percent: Math.round((total / reports.length) * 100),
    scored: reports.length,
    drivers: drivers.map(d => d.text)
  }
}

/** The four checks behind the badge -- same order, same words, as the report. */
const CHECKS: { label: string; detail: string }[] = [
  { label: 'Step coverage', detail: 'Reading every step for an actionable UI action' },
  { label: 'Channel support', detail: 'Judging the channel the case runs on' },
  { label: 'Knowledge Base', detail: 'Matching targets against the discovery catalogue' },
  { label: 'Test data', detail: 'Checking the data each step needs' }
]

/** Roughly how long one check takes to narrate. Pacing only, never a verdict. */
const STAGE_SECONDS = 4

const OUTCOMES: { key: Classification; label: string; tone: string }[] = [
  { key: 'automation', label: 'Automation', tone: 'text-app-success' },
  { key: 'partial', label: 'Needs minor changes', tone: 'text-app-warning' },
  { key: 'manual', label: 'Manual', tone: 'text-app-primary' },
  { key: 'undecided', label: 'Unclassified', tone: 'text-app-secondary' }
]

/** Spelled out on the tile, so the derived number is never a black box. */
const CONFIDENCE_TOOLTIP =
  'Derived from the rule reports: how much of each case the engine judged on evidence. ' +
  'Cases it could not judge score zero; unresolved targets, a missing crawl catalogue and ' +
  'steps that do not read as instructions each reduce it. Blockers and fixables do not -- ' +
  'those are findings the engine is sure of.'

const formatElapsed = (seconds: number) => {
  const mins = Math.floor(seconds / 60).toString().padStart(2, '0')
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${mins}:${secs}`
}

const RING_RADIUS = 26
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

const ProgressRing: React.FC<{ percent: number; status: ClassifyProgressStatus }> = ({
  percent,
  status
}) => {
  const stroke =
    status === 'error' ? 'var(--danger)' : status === 'done' ? 'var(--success)' : '#B71920'
  return (
    <div className="relative flex h-[68px] w-[68px] flex-shrink-0 items-center justify-center">
      <svg viewBox="0 0 68 68" aria-hidden className="absolute h-[68px] w-[68px] -rotate-90">
        <circle cx="34" cy="34" r={RING_RADIUS} fill="none" stroke="#F6D4D5" strokeWidth="4" />
        <circle
          cx="34"
          cy="34"
          r={RING_RADIUS}
          fill="none"
          stroke={stroke}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={RING_LENGTH}
          strokeDashoffset={RING_LENGTH * (1 - percent / 100)}
          style={{ transition: 'stroke-dashoffset 600ms ease' }}
        />
      </svg>
      {status === 'error' ? (
        <HiOutlineExclamationCircle className="h-7 w-7 text-app-danger" />
      ) : status === 'done' ? (
        <HiOutlineCheckCircle className="h-7 w-7 text-app-success" />
      ) : (
        <HiOutlineShieldCheck className="h-7 w-7 text-app-brand-700" />
      )}
    </div>
  )
}

const ClassifyProgressModal: React.FC<ClassifyProgressModalProps> = ({
  open,
  status,
  total,
  startedAt,
  updated,
  counts,
  reports,
  error,
  onClose,
  onApprove,
  canApprove = true
}) => {
  const [elapsed, setElapsed] = useState(0)
  const [minimised, setMinimised] = useState(false)

  const confidence = useMemo(() => summariseConfidence(reports ?? []), [reports])

  // The clock stops when the pass does, so the result screen keeps the time
  // the run actually took rather than counting on while nobody reads it.
  useEffect(() => {
    if (!open || !startedAt) {
      setElapsed(0)
      return
    }
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    tick()
    if (status !== 'running') return
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [open, startedAt, status])

  // A fresh run must not open collapsed because the last one was minimised.
  useEffect(() => {
    if (status === 'running') setMinimised(false)
  }, [status, startedAt])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      // Escape hides the window; it cannot cancel a pass already in flight.
      if (status === 'running') setMinimised(true)
      else onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, status, onClose])

  if (!open) return null

  /*
   * The next step is only ever "approve" when the pass actually produced
   * something automatable. Offering it on a batch that came back Manual or
   * Unclassified would be pointing at a door that is not there -- those cases
   * need editing and reclassifying, not a decision.
   */
  const hasAutomation = (counts?.automation ?? 0) > 0

  const settled = status !== 'running'
  /*
   * The check the pass is on, capped one short of the end: the last check is
   * only ever "in progress" until the server answers, so nothing here can
   * claim a completed pass on the strength of a timer. A failure freezes on
   * this index -- a run that died on the third check did not do the fourth,
   * and showing four ticks over a red ring said that it had.
   */
  const stageIndex = Math.min(CHECKS.length - 1, Math.floor(elapsed / STAGE_SECONDS))
  const completed = status === 'done' ? CHECKS.length : stageIndex

  const percent =
    status === 'done' ? 100 : Math.round(((stageIndex + 0.5) / CHECKS.length) * 100)

  const headline =
    status === 'done'
      ? 'Classification complete'
      : status === 'error'
        ? 'Classification failed'
        : CHECKS[stageIndex].label

  const subline =
    status === 'done'
      ? `${updated ?? 0} of ${total} test case${total === 1 ? '' : 's'} judged by rule`
      : status === 'error'
        ? error ?? 'The classification pass could not be completed.'
        : CHECKS[stageIndex].detail

  if (minimised) {
    return (
      <div className="fixed bottom-5 right-5 z-[1000]">
        <button
          type="button"
          onClick={() => setMinimised(false)}
          className="flex items-center gap-2.5 rounded-app-lg border border-app bg-app-surface py-2.5 pl-3 pr-4 shadow-app-card-lg transition hover:bg-app-surface-muted"
        >
          <HiOutlineSparkles
            className={`h-4 w-4 text-app-brand-700 ${
              status === 'running' ? 'motion-safe:animate-pulse' : ''
            }`}
          />
          <span className="text-left">
            <span className="block text-xs font-semibold leading-tight text-app-primary">
              AI Classify
            </span>
            <span className="block text-[11px] leading-tight text-app-secondary">
              {status === 'running' ? `${headline}... ${formatElapsed(elapsed)}` : headline}
            </span>
          </span>
        </button>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-900/35 px-4 py-6 backdrop-blur-[1px]"
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="classify-progress-title"
        className="w-full max-w-[460px] overflow-hidden rounded-app-xl border border-app bg-app-surface shadow-app-card-lg"
      >
        {/* -- Header ------------------------------------------------------ */}
        <div className="flex items-start gap-3 border-b border-app bg-gradient-to-r from-app-brand-75 to-app-surface px-5 py-4">
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-app bg-app-brand-100 text-app-brand-700">
            <HiOutlineSparkles
              className={`h-5 w-5 ${status === 'running' ? 'motion-safe:animate-pulse' : ''}`}
            />
          </span>
          <div className="min-w-0 flex-1">
            <p id="classify-progress-title" className="text-sm font-semibold text-app-primary">
              AI Classify
            </p>
            <p
              className={`truncate text-xs ${
                status === 'done'
                  ? 'text-app-success'
                  : status === 'error'
                    ? 'text-app-danger'
                    : 'text-app-brand-700'
              }`}
              aria-live="polite"
            >
              {status === 'running' ? `${headline}...` : headline}
            </p>
          </div>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setMinimised(true)}
              title="Hide this window - the pass keeps running"
              aria-label="Minimise"
              className="app-btn app-btn-ghost !px-1.5 !py-1"
            >
              <HiOutlineMinus className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => (status === 'running' ? setMinimised(true) : onClose())}
              title={status === 'running' ? 'Hide this window - the pass keeps running' : 'Close'}
              aria-label="Close"
              className="app-btn app-btn-ghost !px-1.5 !py-1"
            >
              <HiOutlineX className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* -- Stage ------------------------------------------------------- */}
        <div className="px-5 py-4">
          <div className="flex items-center gap-4">
            <ProgressRing percent={percent} status={status} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className="truncate text-sm font-semibold text-app-primary">{headline}</p>
                <span className="flex-shrink-0 font-mono text-xs text-app-secondary">
                  {formatElapsed(elapsed)}
                </span>
              </div>
              <p className="mt-0.5 text-xs leading-snug text-app-secondary">{subline}</p>
              <div className="mt-2.5 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-app-brand-100">
                  <div
                    className={`h-full rounded-full ${
                      status === 'error'
                        ? 'bg-app-danger'
                        : status === 'done'
                          ? 'bg-app-success'
                          : 'bg-[linear-gradient(90deg,#D52B31,#941216)]'
                    }`}
                    style={{ width: `${percent}%`, transition: 'width 600ms ease' }}
                  />
                </div>
                <span className="w-9 flex-shrink-0 text-right text-[11px] font-semibold text-app-secondary">
                  {percent}%
                </span>
              </div>
            </div>
          </div>

          {/* -- Tiles ----------------------------------------------------- */}
          {status === 'done' ? (
            <div className="mt-4 grid grid-cols-2 gap-2">
              {OUTCOMES.map(outcome => (
                <div
                  key={outcome.key}
                  className="rounded-app border border-app bg-app-surface-subtle px-3 py-2"
                >
                  <p className={`text-lg font-semibold leading-none ${outcome.tone}`}>
                    {counts?.[outcome.key] ?? 0}
                  </p>
                  <p className="mt-1 text-[11px] leading-tight text-app-secondary">
                    {outcome.label}
                  </p>
                </div>
              ))}
              {confidence.scored > 0 ? (
                <div
                  className="col-span-2 flex items-center gap-3 rounded-app border border-app bg-app-surface-subtle px-3 py-2"
                  title={CONFIDENCE_TOOLTIP}
                >
                  <HiOutlineShieldCheck
                    className={`h-5 w-5 flex-shrink-0 ${
                      confidence.percent >= 80
                        ? 'text-app-success'
                        : confidence.percent >= 50
                          ? 'text-app-warning'
                          : 'text-app-danger'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-[11px] font-medium text-app-secondary">AI Confidence</p>
                      <p className="text-lg font-semibold leading-none text-app-primary">
                        {confidence.percent}%
                      </p>
                    </div>
                    {/* The number alone invites trust it has not earned; the
                        caption says which reports pulled it down. */}
                    <p className="mt-1 truncate text-[11px] leading-tight text-app-secondary">
                      {confidence.drivers.length === 0
                        ? `Every check settled on evidence across ${confidence.scored} report${
                            confidence.scored === 1 ? '' : 's'
                          }`
                        : confidence.drivers.slice(0, 2).join(' · ')}
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-3 gap-2">
              <div className="rounded-app border border-app bg-app-surface-subtle px-3 py-2">
                <p className="text-lg font-semibold leading-none text-app-primary">{total}</p>
                <p className="mt-1 text-[11px] leading-tight text-app-secondary">
                  Test case{total === 1 ? '' : 's'}
                </p>
              </div>
              <div className="rounded-app border border-app bg-app-surface-subtle px-3 py-2">
                {/* Checks *finished*. Counting the one in flight would read
                    as 4/4 while the last check is still spinning. */}
                <p className="text-lg font-semibold leading-none text-app-primary">
                  {completed}
                  <span className="text-xs font-medium text-app-secondary">/{CHECKS.length}</span>
                </p>
                <p className="mt-1 text-[11px] leading-tight text-app-secondary">Checks done</p>
              </div>
              <div className="rounded-app border border-app bg-app-surface-subtle px-3 py-2">
                <p className="font-mono text-lg font-semibold leading-none text-app-primary">
                  {formatElapsed(elapsed)}
                </p>
                <p className="mt-1 text-[11px] leading-tight text-app-secondary">Elapsed</p>
              </div>
            </div>
          )}

          {/* -- Checklist ------------------------------------------------- */}
          <div
            className={`mt-4 rounded-app border border-dashed px-3.5 py-3 ${
              status === 'done'
                ? 'border-app-success-border bg-app-success-bg/50'
                : status === 'error'
                  ? 'border-app-danger-border bg-app-danger-bg/40'
                  : 'border-app bg-app-surface-muted/50'
            }`}
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-app-secondary">
              Rule checks
            </p>
            <ul className="mt-2 space-y-1.5">
              {CHECKS.map((check, index) => {
                const complete = index < completed
                const failed = status === 'error' && index === stageIndex
                const inFlight = !settled && index === stageIndex
                return (
                  <li key={check.label} className="flex items-center gap-2 text-xs">
                    {complete ? (
                      <HiOutlineCheckCircle className="h-4 w-4 flex-shrink-0 text-app-success" />
                    ) : failed ? (
                      <HiOutlineExclamationCircle className="h-4 w-4 flex-shrink-0 text-app-danger" />
                    ) : inFlight ? (
                      <span className="h-4 w-4 flex-shrink-0 rounded-full border-2 border-app-brand-200 border-t-app-brand-700 motion-safe:animate-spin" />
                    ) : (
                      <span className="h-4 w-4 flex-shrink-0 rounded-full border-2 border-app-border" />
                    )}
                    <span
                      className={
                        complete
                          ? 'font-medium text-app-primary'
                          : failed
                            ? 'font-medium text-app-danger'
                            : inFlight
                              ? 'font-medium text-app-brand-700'
                              : 'text-app-muted'
                      }
                    >
                      {check.label}
                    </span>
                    {failed ? (
                      <span className="ml-auto text-[11px] text-app-danger">did not finish</span>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </div>

          {status === 'running' ? (
            <p className="mt-3 text-[11px] leading-snug text-app-secondary">
              You can hide this window - the pass keeps running and reports when it finishes.
            </p>
          ) : (
            <div className="mt-4 flex items-center justify-between gap-3">
              {/*
                * Classifying is half the gate -- a case still needs approving
                * before the Script Lab will touch it. Saying so here, with the
                * action attached, is what stops someone classifying a batch and
                * then wondering why the Lab is empty.
                */}
              {status === 'done' && onApprove && hasAutomation ? (
                <p className="text-[11px] leading-snug text-app-secondary">
                  Next: approve them, and the Automation Lab can generate.
                </p>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="app-btn app-btn-secondary !px-2.5 text-xs font-medium"
                >
                  {status === 'error' ? 'Close' : 'View results'}
                </button>
                {status === 'done' && onApprove && hasAutomation ? (
                  <button
                    type="button"
                    onClick={onApprove}
                    disabled={!canApprove}
                    title={
                      canApprove
                        ? 'Approve these test cases for the Automation Lab'
                        : 'Your role can review these test cases but not approve them'
                    }
                    className="inline-flex items-center gap-1.5 rounded-app bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-3.5 py-2 text-xs font-bold text-white shadow-[0_8px_20px_rgba(183,25,32,0.28)] transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <HiOutlineSparkles className="h-4 w-4" />
                    Approve
                  </button>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default ClassifyProgressModal
