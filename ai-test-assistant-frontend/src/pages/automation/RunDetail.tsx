/**
 * --- Automation Module: run detail --------------------------------------
 *
 * One run, its per-test results, and the evidence each test left behind.
 *
 * The page polls through useRunPolling, which stops the moment the run
 * settles. Selection is held by result id rather than by index or object
 * identity, because every poll returns a fresh array — keying on either would
 * make the selected row jump while a run is still producing results.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  HiOutlineArrowLeft,
  HiOutlineRefresh,
  HiOutlineStop,
  HiOutlineExclamationCircle,
  HiOutlineTerminal,
  HiOutlineChevronDown,
  HiOutlineChevronRight,
  HiOutlineBeaker,
  HiOutlineSparkles,
  HiOutlinePlay,
  HiOutlineX,
  HiOutlineCheckCircle
} from 'react-icons/hi'
import automationService from '../../services/automationService'
import useRunPolling from '../../hooks/useRunPolling'
import { useAutomationContext } from '../../components/automation/AutomationContext'
import SectionCard from '../../components/ui/SectionCard'
import EmptyState from '../../components/ui/EmptyState'
import LoadingSkeleton from '../../components/ui/LoadingSkeleton'
import EvidencePanel from '../../components/automation/EvidencePanel'
import { CodeViewer } from '../../components/automation/CodeViewer'
import { RunSpecModal } from '../../components/automation/RunSpecModal'
import type { HealRunResponse } from '../../types/automation'
import {
  OutcomeBadge,
  ResultStatusBadge,
  RunStatusBadge,
  formatDuration,
  formatMillis,
  formatWhen
} from '../../components/automation/runPresentation'
import { isTerminal } from '../../types/automation'
import type { RunResultRow } from '../../types/automation'

/** Logs arrive as JSON, a JSON string, or nothing. Normalise for display. */
function stringifyLogs(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * What the runner publishes into run_metadata.step_progress as a spec runs.
 *
 * `history` is append-only and authoritative; `current` is only a hint. A step
 * that starts and finishes between two polls is never observed as running, so
 * rendering from `current` alone would silently skip it — on a fast page most
 * steps would never appear at all.
 */
interface StepProgress {
  total?: number | null
  current?: number | null
  title?: string | null
  status?: string | null
  attempt?: number | null
  healed?: boolean | null
  history?: Array<{
    n: number
    attempt?: number
    title?: string | null
    ok?: boolean
    ms?: number | null
    error?: string | null
  }> | null
}

/**
 * The steps of the test case, inside stage 4 of the pipeline.
 *
 * Rows come from the union of what has finished (history) and what is in
 * flight (current), padded out to `total` so the remaining work is visible as
 * pending rather than absent — "3 of 6" reads very differently from "3".
 */
const StepProgressList: React.FC<{ progress: StepProgress; live: boolean }> = ({
  progress,
  live,
}) => {
  const history = progress.history ?? []
  const total = progress.total ?? 0
  const current = progress.current ?? 0
  const failedOverall = progress.status === 'failed'

  const rowCount = Math.max(total, history.length, current)
  if (rowCount === 0) return null

  const byIndex = new Map(history.map(h => [h.n, h]))
  const rows = Array.from({ length: rowCount }, (_, i) => {
    const n = i + 1
    const done = byIndex.get(n)
    // A step in flight is the current one with nothing recorded against it.
    // Once the run stops being live it cannot still be running, so an
    // unrecorded step there was never reached rather than still going.
    const running = !done && n === current && live && !failedOverall
    return { n, done, running, title: done?.title ?? (n === current ? progress.title : null) }
  })

  const doneCount = history.filter(h => h.ok).length

  return (
    <div className="mt-2.5 rounded-lg border border-gray-100 bg-gray-50/70 px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          Test Case Steps
          {progress.healed ? (
            <span className="ml-1.5 rounded bg-violet-100 px-1.5 py-px text-[10px] font-semibold normal-case tracking-normal text-violet-700">
              healed retry
            </span>
          ) : null}
        </span>
        <span className="text-[11px] font-semibold tabular-nums text-gray-600">
          {doneCount} / {total || rowCount} passed
        </span>
      </div>

      <ol className="space-y-1">
        {rows.map(row => {
          const failed = row.done && !row.done.ok
          return (
            <li
              key={row.n}
              className={`flex items-start gap-2 text-[12px] leading-snug ${
                row.done || row.running ? 'opacity-100' : 'opacity-45'
              }`}
            >
              <span
                className={`mt-px flex h-4 w-4 flex-none items-center justify-center rounded-full text-[9px] font-bold ${
                  failed
                    ? 'bg-red-100 text-red-700'
                    : row.done
                    ? 'bg-emerald-100 text-emerald-700'
                    : row.running
                    ? 'bg-red-500 text-white animate-pulse'
                    : 'bg-gray-200 text-gray-500'
                }`}
              >
                {failed ? '✕' : row.done ? '✓' : row.n}
              </span>

              <span
                className={`min-w-0 flex-1 truncate ${
                  failed
                    ? 'font-medium text-red-700'
                    : row.running
                    ? 'font-medium text-gray-900'
                    : 'text-gray-600'
                }`}
                title={row.title ?? undefined}
              >
                {row.title ?? `Step ${row.n}`}
              </span>

              {row.running ? (
                <span className="flex-none text-[10px] font-medium text-red-500">running…</span>
              ) : row.done?.ms != null ? (
                <span className="flex-none text-[10px] tabular-nums text-gray-400">
                  {(row.done.ms / 1000).toFixed(1)}s
                </span>
              ) : null}
            </li>
          )
        })}
      </ol>

      {rows.some(r => r.done && !r.done.ok) ? (
        <p className="mt-2 border-t border-gray-200 pt-2 text-[11px] leading-snug text-red-600">
          {rows.find(r => r.done && !r.done.ok)?.done?.error ?? 'Step failed.'}
        </p>
      ) : null}
    </div>
  )
}

const Collapsible: React.FC<{
  title: string
  count?: number | null
  children: React.ReactNode
}> = ({ title, count, children }) => {
  const [open, setOpen] = useState(false)
  return (
    <div className="overflow-hidden rounded-app border border-app">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 bg-app-surface-muted px-3 py-2 text-left text-[12px] font-semibold text-app-primary transition hover:bg-app-surface"
      >
        {open ? (
          <HiOutlineChevronDown className="h-4 w-4 text-app-secondary" />
        ) : (
          <HiOutlineChevronRight className="h-4 w-4 text-app-secondary" />
        )}
        {title}
        {count !== null && count !== undefined ? (
          <span className="text-app-secondary">({count})</span>
        ) : null}
      </button>
      {open ? <div className="px-3 py-3">{children}</div> : null}
    </div>
  )
}

const RunDetail: React.FC = () => {
  const { runKey } = useParams<{ runKey: string }>()
  const { canExecute } = useAutomationContext()

  const { run, loading, error, refreshing, polling, refresh } = useRunPolling(runKey)
  const { runtime } = useAutomationContext()
  const navigate = useNavigate()

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const [log, setLog] = useState<string | null>(null)
  const [logLoading, setLogLoading] = useState(false)
  const [logError, setLogError] = useState<string | null>(null)
  const [logOpen, setLogOpen] = useState(false)

  // Rerun and Healer states
  const [rerunModalOpen, setRerunModalOpen] = useState(false)
  const [rerunOverride, setRerunOverride] = useState<{
    code?: string | null
    fileName?: string | null
    baseUrl?: string | null
  } | null>(null)
  const [healModalOpen, setHealModalOpen] = useState(false)
  const [healing, setHealing] = useState(false)
  const [healResult, setHealResult] = useState<HealRunResponse | null>(null)
  const [healError, setHealError] = useState<string | null>(null)
  const [healSubmitting, setHealSubmitting] = useState(false)

  const results = run?.results ?? []
  // Written by the runner as the spec advances; absent on runs recorded before
  // step reporting existed, which is why every use below is guarded.
  const stepProgress = ((run?.run_metadata as any)?.step_progress ?? null) as StepProgress | null

  const handleTriggerHeal = async () => {
    if (!runKey) return
    setHealing(true)
    setHealError(null)
    setHealResult(null)
    setHealModalOpen(true)
    try {
      const data = await automationService.healRun(runKey)
      setHealResult(data)
    } catch (err: any) {
      setHealError(err?.message ?? 'Failed to diagnose and heal script.')
    } finally {
      setHealing(false)
    }
  }

  const handleQueueHealedRun = async () => {
    if (!healResult?.healed_code) return
    setHealSubmitting(true)
    try {
      const res = await automationService.createRun({
        code: healResult.healed_code,
        environment: run?.environment || 'SIT',
        base_url: run?.spec?.base_url || null,
        file_name: run?.spec?.file_name || 'healed_spec.ts',
        slow_mo_ms: 1000,
        headless: true,
      })
      setHealModalOpen(false)
      navigate(`/automation/runs/${res.run_key}`)
    } catch (err: any) {
      setHealError(err?.message ?? 'Failed to queue healed run.')
    } finally {
      setHealSubmitting(false)
    }
  }

  // Default to the first failure — on a red run that is the row anyone opened
  // this page to read. Falls back to the first result on a clean run.
  useEffect(() => {
    if (selectedId !== null && results.some(r => r.id === selectedId)) return
    if (results.length === 0) {
      setSelectedId(null)
      return
    }
    const firstBad = results.find(r => r.status === 'fail' || r.status === 'error')
    setSelectedId((firstBad ?? results[0]).id)
  }, [results, selectedId])

  const selected: RunResultRow | null = useMemo(
    () => results.find(r => r.id === selectedId) ?? null,
    [results, selectedId]
  )

  const handleCancel = async () => {
    if (!runKey) return
    setCancelling(true)
    setActionError(null)
    try {
      await automationService.cancelRun(runKey)
      refresh()
    } catch (err: any) {
      setActionError(err?.message ?? 'That run could not be cancelled.')
    } finally {
      setCancelling(false)
    }
  }

  const loadLog = useCallback(async () => {
    if (!runKey) return
    setLogLoading(true)
    setLogError(null)
    try {
      setLog(await automationService.getRunLog(runKey))
    } catch (err: any) {
      setLogError(err?.message ?? 'The runner log could not be read.')
    } finally {
      setLogLoading(false)
    }
  }, [runKey])

  const toggleLog = () => {
    const next = !logOpen
    setLogOpen(next)
    if (next && log === null && !logLoading) void loadLog()
  }

  const specCode = run?.spec?.code ?? null

  if (loading) {
    return (
      <div className="space-y-3">
        <LoadingSkeleton className="h-28 w-full" rounded="lg" />
        <LoadingSkeleton className="h-64 w-full" rounded="lg" />
      </div>
    )
  }

  if (!run) {
    return (
      <SectionCard>
        <EmptyState
          title="Run not found"
          description={error ?? 'That run key does not exist, or it belongs to another deployment.'}
          icon={<HiOutlineExclamationCircle className="h-5 w-5" />}
          action={
            <Link to="/automation/runs" className="app-btn app-btn-secondary">
              Back to runs
            </Link>
          }
        />
      </SectionCard>
    )
  }

  const live = !isTerminal(run.status)

  return (
    <div className="space-y-3">
      {/* Header */}
      <SectionCard>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link
              to="/automation/runs"
              className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-app-secondary transition hover:text-app-primary"
            >
              <HiOutlineArrowLeft className="h-4 w-4" />
              All runs
            </Link>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <h2 className="truncate font-mono text-[16px] font-bold text-app-primary">
                {run.run_key}
              </h2>
              <RunStatusBadge status={run.status} live={run.is_active} />
              <div className="flex items-center gap-1.5">
                <OutcomeBadge outcome={run.outcome} status={run.status} />
                {run.is_healed ? (
                  <span
                    className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 border border-emerald-200"
                    title={run.healing_diagnosis || "Auto-repaired at runtime by Healer Agent"}
                  >
                    ✨ Healed
                  </span>
                ) : null}
              </div>
              {polling ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-app-info">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-app-info" />
                  Live
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canExecute ? (
              <>
                <button
                  type="button"
                  onClick={handleTriggerHeal}
                  className="app-btn inline-flex items-center gap-1.5 bg-gradient-to-r from-emerald-600 to-teal-600 text-white font-medium shadow-sm hover:from-emerald-700 hover:to-teal-700"
                >
                  <HiOutlineSparkles className="h-4 w-4" />
                  Regenerate with Healer
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRerunOverride(null)
                    setRerunModalOpen(true)
                  }}
                  className="app-btn app-btn-secondary inline-flex items-center gap-1.5"
                >
                  <HiOutlinePlay className="h-4 w-4" />
                  Rerun Spec
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing}
              className="app-btn app-btn-secondary inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <HiOutlineRefresh className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            {live && run.is_active && canExecute ? (
              <button
                type="button"
                onClick={() => void handleCancel()}
                disabled={cancelling}
                className="app-btn app-btn-secondary inline-flex items-center gap-1.5 text-app-danger disabled:opacity-50"
              >
                <HiOutlineStop className="h-4 w-4" />
                {cancelling ? 'Cancelling…' : 'Cancel run'}
              </button>
            ) : null}
          </div>
        </div>

        <dl className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label: 'Framework', value: run.framework },
            { label: 'Environment', value: run.environment ?? '—' },
            { label: 'Triggered by', value: run.triggered_by ?? '—' },
            { label: 'Duration', value: formatDuration(run.duration_seconds) },
            { label: 'Queued', value: formatWhen(run.created_at) },
            { label: 'Started', value: formatWhen(run.started_at) },
            { label: 'Completed', value: formatWhen(run.completed_at) },
            {
              label: 'Results',
              value:
                run.total_tests > 0
                  ? `${run.passed} passed · ${run.failed} failed · ${run.skipped} skipped · ${run.blocked} blocked`
                  : '—'
            }
          ].map(item => (
            <div key={item.label} className="rounded-app border border-app px-3 py-2.5">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-app-secondary">
                {item.label}
              </dt>
              <dd className="mt-0.5 truncate text-[13px] text-app-primary" title={String(item.value)}>
                {item.value}
              </dd>
            </div>
          ))}
        </dl>

        {run.is_healed || run.healing_diagnosis ? (
          <div className="mt-4 rounded-app border border-emerald-300 bg-emerald-50/80 p-4 text-emerald-950">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600 text-white text-[10px] font-bold">
                ✨
              </span>
              <h3 className="text-[13px] font-bold text-emerald-900">
                Self-Healing Agent: {run.is_healed ? 'Test Auto-Repaired & Passed' : 'Repair Attempted'}
              </h3>
            </div>
            {run.healing_diagnosis ? (
              <p className="mt-1.5 text-[12px] text-emerald-800 leading-relaxed">
                <strong>Diagnosis:</strong> {run.healing_diagnosis}
              </p>
            ) : null}
            {run.healing_changes && run.healing_changes.length > 0 ? (
              <div className="mt-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-800">
                  Changes Applied:
                </span>
                <ul className="mt-1 list-inside list-disc text-[12px] text-emerald-700 space-y-0.5">
                  {run.healing_changes.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {run.error_message ? (
          <div className="mt-3 flex items-start gap-2 rounded-app border border-red-200 bg-app-danger-bg px-3 py-3 text-[13px] text-app-danger">
            <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span className="whitespace-pre-wrap">{run.error_message}</span>
          </div>
        ) : null}

        {error ? (
          <div className="mt-3 flex items-start gap-2 rounded-app border border-orange-200 bg-app-warning-bg px-3 py-2.5 text-[12px] text-app-warning">
            <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>Polling paused — {error}</span>
          </div>
        ) : null}

        {actionError ? (
          <div className="mt-3 flex items-start gap-2 rounded-app border border-red-200 bg-app-danger-bg px-3 py-2.5 text-[12px] text-app-danger">
            <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{actionError}</span>
          </div>
        ) : null}
      </SectionCard>

      {/* Results and evidence */}
      <div className="grid gap-3 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <SectionCard
          title="Tests"
          description={
            live
              ? 'Results appear as the runner reports them.'
              : `${results.length} ${results.length === 1 ? 'test' : 'tests'} reported.`
          }
          noPadding
        >
          {results.length === 0 ? (
            <div className="p-5 space-y-5">
              {/* Execution Pipeline Stepper Card (Ahmed-App Style) */}
              <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 pb-4 mb-4">
                  <div>
                    <h3 className="text-[14px] font-bold text-gray-900 flex items-center gap-2">
                      <span>Execution Pipeline</span>
                      {live ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-0.5 text-[11px] font-semibold text-red-600 border border-red-200">
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-600" />
                          Live Stage {Math.min(5, Math.max(1, (run.run_metadata as any)?.phase_step || (run.status === 'queued' ? 1 : 4)))} of 5
                          {stepProgress && (stepProgress.total ?? 0) > 0 && (stepProgress.current ?? 0) > 0 ? (
                            <span className="tabular-nums opacity-80">
                              {' '}· Step {stepProgress.current}/{stepProgress.total}
                            </span>
                          ) : null}
                        </span>
                      ) : run.status === 'completed' ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 border border-emerald-200">
                          ✓ All Stages Complete
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-0.5 text-[11px] font-semibold text-red-700 border border-red-200">
                          ✕ Execution Terminated
                        </span>
                      )}
                    </h3>
                    <p className="text-[12px] text-gray-500 mt-0.5">
                      {live ? 'Real-time automation engine state machine' : 'Final execution pipeline trace'}
                    </p>
                  </div>
                  {live ? (
                    <div className="flex items-center space-x-1">
                      <div className="w-2 h-2 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <div className="w-2 h-2 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <div className="w-2 h-2 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  ) : null}
                </div>

                {/* Stepper list */}
                <div className="space-y-4">
                  {[
                    { num: 1, label: 'Assessing Readiness & Workspace', icon: '🔍', desc: 'Validating Playwright toolchain, permissions & target environment' },
                    { num: 2, label: 'Autonomous Element Discovery & Grounding', icon: '🤖', desc: 'Resolving UI controls against active element catalogue' },
                    { num: 3, label: 'Materializing Playwright Spec', icon: '📝', desc: 'Compiling test scenarios, assertions & cookie consent guards' },
                    { num: 4, label: 'Executing Playwright Test Engine', icon: '🚀', desc: 'Running browser automation with traces & video recording' },
                    { num: 5, label: 'Self-Healing Agent & Finalizing Evidence', icon: '✨', desc: 'Auto-repairing failures and persisting execution reports' },
                  ].map((step) => {
                    const rawStep = (run.run_metadata as any)?.phase_step;
                    let activeStep = 1;
                    if (run.status === 'queued') {
                      activeStep = 1;
                    } else if (run.status === 'running') {
                      activeStep = rawStep || 4;
                    } else if (run.status === 'completed') {
                      activeStep = 6;
                    } else {
                      activeStep = rawStep || 4;
                    }

                    const isCompleted = step.num < activeStep;
                    const isActive = step.num === activeStep && live;
                    const isFailed = step.num === activeStep && (run.status === 'failed' || run.status === 'cancelled');

                    return (
                      <div
                        key={step.num}
                        className={`flex items-start space-x-3.5 transition-all duration-300 ${
                          isActive ? 'opacity-100 scale-[1.01]' : isCompleted ? 'opacity-95' : 'opacity-40'
                        }`}
                      >
                        <div
                          className={`flex items-center justify-center w-9 h-9 rounded-full text-sm shadow-sm border-2 flex-shrink-0 transition-all ${
                            isCompleted
                              ? 'bg-emerald-50 border-emerald-500 text-emerald-600 font-bold'
                              : isActive
                              ? 'bg-red-50 border-red-500 text-red-600 ring-2 ring-red-200'
                              : isFailed
                              ? 'bg-red-100 border-red-600 text-red-700 font-bold'
                              : 'bg-gray-50 border-gray-200 text-gray-400'
                          }`}
                        >
                          {isCompleted ? '✓' : isFailed ? '✕' : step.icon}
                        </div>
                        <div className="flex-1 min-w-0 pt-0.5">
                          <div className="flex items-center justify-between">
                            <p
                              className={`text-[13px] font-semibold ${
                                isActive ? 'text-red-600' : isCompleted ? 'text-emerald-700' : isFailed ? 'text-red-700' : 'text-gray-600'
                              }`}
                            >
                              {step.label}
                            </p>
                            {isActive && (
                              <span className="text-[11px] font-medium text-red-500 animate-pulse">Running…</span>
                            )}
                            {isCompleted && (
                              <span className="text-[11px] font-medium text-emerald-600">Passed</span>
                            )}
                          </div>
                          <p className="text-[11px] text-gray-500 mt-0.5 line-clamp-1">{step.desc}</p>

                          {/* Stage 4 is where the time goes, and it used to be
                              a single boolean. The per-step list turns it from
                              "executing" into "step 3 of 6, and here is which
                              one". Rendered once the stage has been reached so
                              a finished run keeps its step trail. */}
                          {step.num === 4 && stepProgress && activeStep >= 4 ? (
                            <StepProgressList progress={stepProgress} live={live && activeStep === 4} />
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Accordion Log View */}
                <div className="mt-5 border-t border-gray-100 pt-4">
                  <button
                    type="button"
                    onClick={toggleLog}
                    className="flex w-full items-center justify-between rounded-lg bg-gray-50 px-3.5 py-2.5 text-left text-[12px] font-semibold text-gray-700 hover:bg-gray-100 transition"
                  >
                    <span className="flex items-center gap-1.5">
                      <span>Live Runner Logs & Stream</span>
                      {live ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> : null}
                    </span>
                    <span>{logOpen ? '▲ Hide' : '▼ Show'}</span>
                  </button>

                  {logOpen && (
                    <div className="mt-2 rounded-lg bg-gray-900 p-3 font-mono text-[11px] leading-relaxed text-emerald-400 max-h-[220px] overflow-y-auto whitespace-pre-wrap">
                      {logLoading ? (
                        <div className="py-2 text-center text-gray-400">Streaming logs…</div>
                      ) : log ? (
                        log
                      ) : (
                        <div className="py-2 text-center text-gray-500">No output recorded yet.</div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="app-scroll max-h-[560px] overflow-y-auto">
              <ul>
                {results.map(result => {
                  const isSelected = result.id === selectedId
                  return (
                    <li key={result.id} className="border-b border-app last:border-b-0">
                      <button
                        type="button"
                        onClick={() => setSelectedId(result.id)}
                        className={[
                          'flex w-full items-start gap-3 px-4 py-3 text-left transition',
                          isSelected
                            ? 'bg-app-brand-50/50'
                            : 'hover:bg-app-surface-muted'
                        ].join(' ')}
                      >
                        <span className="mt-0.5 flex-shrink-0">
                          <ResultStatusBadge status={result.status} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold text-app-primary">
                            {result.test_name}
                          </span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-app-secondary">
                            <span>{formatMillis(result.duration_ms)}</span>
                            {result.evidence?.screenshot ? <span>screenshot</span> : null}
                            {result.evidence?.video ? <span>video</span> : null}
                            {result.evidence?.trace ? <span>trace</span> : null}
                          </span>
                          {result.error_message ? (
                            <span className="mt-1 block truncate text-[11px] text-app-danger">
                              {result.error_message}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </SectionCard>

        <div className="space-y-3">
          {selected ? (
            <>
              <SectionCard title="Evidence" description={selected.test_name} noPadding>
                <div className="p-4">
                  <EvidencePanel runKey={run.run_key} result={selected} />
                </div>
              </SectionCard>

              {selected.error_message || selected.stack_trace ? (
                <SectionCard title="Failure" noPadding>
                  <div className="space-y-3 p-4">
                    {selected.error_message ? (
                      <div className="rounded-app border border-red-200 bg-app-danger-bg px-3 py-3 text-[12px] text-app-danger">
                        <pre className="app-scroll overflow-x-auto whitespace-pre-wrap font-mono">
                          {selected.error_message}
                        </pre>
                      </div>
                    ) : null}
                    {selected.stack_trace ? (
                      <Collapsible title="Stack trace">
                        <pre className="app-scroll overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-app-secondary">
                          {selected.stack_trace}
                        </pre>
                      </Collapsible>
                    ) : null}
                  </div>
                </SectionCard>
              ) : null}

              {stringifyLogs(selected.console_logs) || stringifyLogs(selected.network_logs) ? (
                <SectionCard title="Captured logs" noPadding>
                  <div className="space-y-2 p-4">
                    {stringifyLogs(selected.console_logs) ? (
                      <Collapsible title="Console">
                        <pre className="app-scroll max-h-80 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-app-secondary">
                          {stringifyLogs(selected.console_logs)}
                        </pre>
                      </Collapsible>
                    ) : null}
                    {stringifyLogs(selected.network_logs) ? (
                      <Collapsible title="Network">
                        <pre className="app-scroll max-h-80 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-app-secondary">
                          {stringifyLogs(selected.network_logs)}
                        </pre>
                      </Collapsible>
                    ) : null}
                  </div>
                </SectionCard>
              ) : null}
            </>
          ) : null}

          {specCode ? (
            <SectionCard
              title="Spec"
              description={
                run.spec?.base_url
                  ? `The code this run executed, against ${run.spec.base_url}.`
                  : 'The code this run executed.'
              }
              noPadding
            >
              <div className="p-4">
                <CodeViewer
                  code={specCode}
                  language="typescript"
                  fileName={run.spec?.file_name ?? 'spec.ts'}
                  downloadable
                  maxHeight="360px"
                />
              </div>
            </SectionCard>
          ) : null}

          {/* Runner output. Fetched on demand — a log can be large, and on a
              healthy run nobody needs it. */}
          <SectionCard noPadding>
            <div className="p-4">
              <button
                type="button"
                onClick={toggleLog}
                disabled={!run.has_log}
                title={run.has_log ? undefined : 'This run has no log on disk.'}
                className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-app-primary transition hover:text-app-brand-700 disabled:opacity-50"
              >
                <HiOutlineTerminal className="h-4 w-4" />
                {logOpen ? 'Hide runner log' : 'Show runner log'}
              </button>

              {logOpen ? (
                <div className="mt-3">
                  {logLoading ? <LoadingSkeleton className="h-40 w-full" rounded="lg" /> : null}
                  {logError ? (
                    <div className="flex items-start gap-2 rounded-app border border-red-200 bg-app-danger-bg px-3 py-3 text-[12px] text-app-danger">
                      <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                      <span>{logError}</span>
                    </div>
                  ) : null}
                  {!logLoading && !logError && log !== null ? (
                    <pre className="app-scroll max-h-[420px] overflow-auto whitespace-pre-wrap rounded-app border border-app bg-app-surface-muted px-3 py-3 font-mono text-[11px] leading-5 text-app-secondary">
                      {log || 'The log is empty.'}
                    </pre>
                  ) : null}
                </div>
              ) : null}
            </div>
          </SectionCard>
        </div>
      </div>

      {/* Rerun Spec Modal prefilled with this run's spec */}
      <RunSpecModal
        open={rerunModalOpen}
        onClose={() => {
          setRerunModalOpen(false)
          setRerunOverride(null)
        }}
        initialCode={rerunOverride ? rerunOverride.code : run.spec?.code}
        initialFileName={rerunOverride ? rerunOverride.fileName : run.spec?.file_name}
        initialBaseUrl={rerunOverride ? rerunOverride.baseUrl : run.spec?.base_url}
        initialEnvironment={run.environment}
        runtime={runtime}
        canExecute={canExecute}
        onQueued={key => {
          setRerunModalOpen(false)
          setRerunOverride(null)
          navigate(`/automation/runs/${key}`)
        }}
      />

      {/* Healer Diagnosis & Regeneration Modal */}
      {healModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-2xl border border-app bg-app-surface shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-app bg-app-surface px-6 py-4">
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-500 text-white shadow-sm font-bold text-sm">
                  ✨
                </span>
                <div>
                  <h3 className="text-base font-bold text-app-primary">
                    Self-Healing Agent: Script Diagnosis & Regeneration
                  </h3>
                  <p className="text-xs text-app-secondary">
                    AI diagnostic engine analyzed failure logs, DOM state, and active Discovery locators
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setHealModalOpen(false)}
                className="rounded-lg p-1.5 text-app-secondary transition hover:bg-app-surface-muted hover:text-app-primary"
              >
                <HiOutlineX className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4 app-scroll">
              {healing ? (
                <div className="py-12 text-center space-y-3">
                  <div className="mx-auto h-9 w-9 animate-spin rounded-full border-4 border-emerald-600 border-t-transparent" />
                  <p className="text-sm font-semibold text-app-primary">
                    Healer Agent is analyzing runtime failures & repairing script...
                  </p>
                  <p className="text-xs text-app-secondary">
                    Matching against active element locators and resolving actionability checks
                  </p>
                </div>
              ) : null}

              {healError ? (
                <div className="flex items-start gap-2 rounded-app border border-red-200 bg-app-danger-bg p-4 text-xs text-app-danger">
                  <HiOutlineExclamationCircle className="h-5 w-5 flex-shrink-0" />
                  <span>{healError}</span>
                </div>
              ) : null}

              {!healing && healResult ? (
                <>
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-4">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-emerald-900">
                      Root Cause Diagnosis
                    </h4>
                    <p className="mt-1 text-sm text-emerald-800 leading-relaxed">
                      {healResult.diagnosis}
                    </p>
                    {healResult.changes_made && healResult.changes_made.length > 0 ? (
                      <div className="mt-3">
                        <h5 className="text-[11px] font-bold uppercase tracking-wider text-emerald-800">
                          Repairs Applied
                        </h5>
                        <ul className="mt-1 list-inside list-disc text-xs text-emerald-700 space-y-0.5">
                          {healResult.changes_made.map((c, i) => (
                            <li key={i}>{c}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>

                  <div>
                    <h4 className="text-xs font-bold uppercase tracking-wider text-app-secondary mb-2">
                      Healed Playwright Test Script
                    </h4>
                    <CodeViewer
                      code={healResult.healed_code}
                      language="typescript"
                      fileName={run.spec?.file_name ?? 'healed_spec.ts'}
                      maxHeight="320px"
                      downloadable
                    />
                  </div>
                </>
              ) : null}
            </div>

            <div className="flex items-center justify-end gap-2.5 border-t border-app bg-app-surface-muted px-6 py-3.5">
              <button
                type="button"
                onClick={() => setHealModalOpen(false)}
                className="app-btn app-btn-secondary"
              >
                Close
              </button>
              {!healing && healResult ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setRerunOverride({
                        code: healResult.healed_code,
                        fileName: run.spec?.file_name || 'healed_spec.ts',
                        baseUrl: run.spec?.base_url || '',
                      })
                      setHealModalOpen(false)
                      setRerunModalOpen(true)
                    }}
                    className="app-btn app-btn-secondary inline-flex items-center gap-1.5"
                  >
                    Edit in Spec Runner
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleQueueHealedRun()}
                    disabled={healSubmitting}
                    className="app-btn inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold disabled:opacity-50"
                  >
                    <HiOutlinePlay className="h-4 w-4" />
                    {healSubmitting ? 'Queueing...' : 'Queue Healed Run Now'}
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default RunDetail
