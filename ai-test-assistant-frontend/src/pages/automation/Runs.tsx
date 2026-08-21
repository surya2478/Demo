/**
 * --- Automation Module: runs --------------------------------------------
 *
 * Execution history for this deployment.
 *
 * The list refreshes on a timer only while something is actually live. A
 * finished run cannot change, so polling a settled table is a request every
 * few seconds per open tab, on a host that is also running browsers.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  HiOutlineRefresh,
  HiOutlinePlay,
  HiOutlineStop,
  HiOutlineExclamationCircle,
  HiOutlineChartBar,
  HiOutlineClock,
  HiOutlineLightningBolt,
  HiOutlineCollection
} from 'react-icons/hi'
import automationService from '../../services/automationService'
import { useAutomationContext } from '../../components/automation/AutomationContext'
import MetricCard from '../../components/ui/MetricCard'
import SectionCard from '../../components/ui/SectionCard'
import EmptyState from '../../components/ui/EmptyState'
import LoadingSkeleton from '../../components/ui/LoadingSkeleton'
import RunSpecModal from '../../components/automation/RunSpecModal'
import {
  OutcomeBadge,
  RunStatusBadge,
  formatAge,
  formatDuration
} from '../../components/automation/runPresentation'
import { isTerminal } from '../../types/automation'
import type { RunSummary, RunsSummary } from '../../types/automation'

const POLL_MS = 3000

const EMPTY_SUMMARY: RunsSummary = {
  total_runs: 0,
  pass_rate: null,
  avg_duration_seconds: null,
  active: 0,
  capacity: 0
}

const Runs: React.FC = () => {
  const navigate = useNavigate()
  const { runtime, canExecute } = useAutomationContext()

  const [runs, setRuns] = useState<RunSummary[]>([])
  const [summary, setSummary] = useState<RunsSummary>(EMPTY_SUMMARY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [runModalOpen, setRunModalOpen] = useState(false)

  const timerRef = useRef<number | null>(null)
  const mountedRef = useRef(true)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const load = useCallback(
    async (isFirst: boolean) => {
      try {
        const data = await automationService.listRuns(50)
        if (!mountedRef.current) return

        setRuns(data.runs ?? [])
        setSummary(data.summary ?? EMPTY_SUMMARY)
        setError(null)

        // Keep polling only while something can still change.
        const live = (data.runs ?? []).some(r => !isTerminal(r.status))
        clearTimer()
        if (live && !document.hidden) {
          timerRef.current = window.setTimeout(() => void load(false), POLL_MS)
        }
      } catch (err: any) {
        if (!mountedRef.current) return
        setError(err?.message ?? 'Runs could not be loaded.')
        clearTimer()
      } finally {
        if (mountedRef.current && isFirst) setLoading(false)
      }
    },
    [clearTimer]
  )

  useEffect(() => {
    mountedRef.current = true
    void load(true)
    return () => {
      mountedRef.current = false
      clearTimer()
    }
  }, [load, clearTimer])

  // A backgrounded tab should cost nothing; catch up on return.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        clearTimer()
      } else {
        void load(false)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [load, clearTimer])

  const handleCancel = async (runKey: string) => {
    setCancelling(runKey)
    setError(null)
    try {
      await automationService.cancelRun(runKey)
      await load(false)
    } catch (err: any) {
      setError(err?.message ?? 'That run could not be cancelled.')
    } finally {
      setCancelling(null)
    }
  }

  const handleQueued = (runKey: string) => {
    setRunModalOpen(false)
    navigate(`/automation/runs/${runKey}`)
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Total runs"
          value={loading ? '—' : summary.total_runs}
          tone="brand"
          icon={<HiOutlineCollection className="h-4 w-4" />}
        />
        <MetricCard
          label="Pass rate"
          value={loading || summary.pass_rate === null ? '—' : `${summary.pass_rate}%`}
          tone="success"
          icon={<HiOutlineChartBar className="h-4 w-4" />}
          tooltip="Across runs that finished — cancelled and blocked runs are excluded"
        />
        <MetricCard
          label="Average duration"
          value={loading ? '—' : formatDuration(summary.avg_duration_seconds)}
          tone="neutral"
          icon={<HiOutlineClock className="h-4 w-4" />}
        />
        <MetricCard
          label="Active"
          value={loading ? '—' : `${summary.active} / ${summary.capacity}`}
          tone={summary.active >= summary.capacity && summary.capacity > 0 ? 'warning' : 'violet'}
          icon={<HiOutlineLightningBolt className="h-4 w-4" />}
          tooltip="Runs executing on this host right now, against the concurrency limit"
        />
      </div>

      <SectionCard
        title="Run history"
        description="The 50 most recent runs. Select one to see its results and the evidence it captured."
        noPadding
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void load(false)}
              className="app-btn app-btn-secondary inline-flex items-center gap-1.5"
            >
              <HiOutlineRefresh className="h-4 w-4" />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setRunModalOpen(true)}
              disabled={!canExecute}
              title={canExecute ? undefined : 'You do not have permission to execute runs.'}
              className="app-btn app-btn-primary inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <HiOutlinePlay className="h-4 w-4" />
              Run a spec
            </button>
          </div>
        }
      >
        {error ? (
          <div className="m-5 flex items-start gap-2 rounded-app border border-red-200 bg-app-danger-bg px-3 py-3 text-[13px] text-app-danger">
            <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 5 }, (_, i) => (
              <LoadingSkeleton key={i} className="h-12 w-full" rounded="lg" />
            ))}
          </div>
        ) : null}

        {!loading && runs.length === 0 && !error ? (
          <div className="p-5">
            <EmptyState
              title="No runs yet"
              description="Queue a Playwright spec from here or from a candidate. The run executes headlessly on this host and its evidence lands on the detail page."
              icon={<HiOutlinePlay className="h-5 w-5" />}
              action={
                canExecute ? (
                  <button
                    type="button"
                    onClick={() => setRunModalOpen(true)}
                    className="app-btn app-btn-primary"
                  >
                    Run a spec
                  </button>
                ) : undefined
              }
            />
          </div>
        ) : null}

        {!loading && runs.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="app-table">
              <thead>
                <tr>
                  <th className="text-left">Run</th>
                  <th className="text-left">Status</th>
                  <th className="text-left">Outcome</th>
                  <th className="text-left">Tests</th>
                  <th className="text-left">Duration</th>
                  <th className="text-left">Triggered by</th>
                  <th className="text-left">Started</th>
                  <th className="text-right"></th>
                </tr>
              </thead>
              <tbody>
                {runs.map(run => {
                  const live = !isTerminal(run.status)
                  return (
                    <tr
                      key={run.run_key}
                      onClick={() => navigate(`/automation/runs/${run.run_key}`)}
                      className="cursor-pointer"
                    >
                      <td>
                        <div className="min-w-0">
                          <div className="truncate font-mono text-[12px] font-semibold text-app-primary">
                            {run.run_key}
                          </div>
                          <div className="truncate text-[11px] text-app-secondary">
                            {run.framework}
                            {run.environment ? ` · ${run.environment}` : ''}
                          </div>
                        </div>
                      </td>
                      <td>
                        <RunStatusBadge status={run.status} live={run.is_active} />
                      </td>
                      <td>
                        <OutcomeBadge outcome={run.outcome} status={run.status} />
                      </td>
                      <td className="text-[12px] text-app-secondary">
                        {run.total_tests > 0 ? (
                          <span>
                            <span className="font-semibold text-app-success">{run.passed}</span>
                            {' / '}
                            <span
                              className={
                                run.failed > 0 ? 'font-semibold text-app-danger' : undefined
                              }
                            >
                              {run.failed}
                            </span>
                            {' / '}
                            <span>{run.total_tests}</span>
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="text-[13px] text-app-secondary">
                        {formatDuration(run.duration_seconds)}
                      </td>
                      <td className="text-[13px] text-app-secondary">
                        {run.triggered_by ?? '—'}
                      </td>
                      <td
                        className="whitespace-nowrap text-[13px] text-app-secondary"
                        title={run.started_at ?? run.created_at ?? ''}
                      >
                        {formatAge(run.started_at ?? run.created_at)}
                      </td>
                      <td className="text-right">
                        {live && run.is_active && canExecute ? (
                          <button
                            type="button"
                            onClick={e => {
                              e.stopPropagation()
                              void handleCancel(run.run_key)
                            }}
                            disabled={cancelling === run.run_key}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-semibold text-app-danger transition hover:bg-app-danger-bg disabled:opacity-50"
                          >
                            <HiOutlineStop className="h-4 w-4" />
                            {cancelling === run.run_key ? 'Cancelling…' : 'Cancel'}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </SectionCard>

      <RunSpecModal
        open={runModalOpen}
        onClose={() => setRunModalOpen(false)}
        candidate={null}
        runtime={runtime}
        canExecute={canExecute}
        onQueued={handleQueued}
      />
    </div>
  )
}

export default Runs
