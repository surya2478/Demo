/**
 * --- Automation Module: runs --------------------------------------------
 *
 * Execution history for this deployment.
 *
 * The list refreshes on a timer only while something is actually live. A
 * finished run cannot change, so polling a settled table is a request every
 * few seconds per open tab, on a host that is also running browsers.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  HiOutlineRefresh,
  HiOutlinePlay,
  HiOutlineStop,
  HiOutlineExclamationCircle,
  HiOutlineChartBar,
  HiOutlineClock,
  HiOutlineLightningBolt,
  HiOutlineCollection,
  HiOutlineTrash,
  HiOutlineSparkles
} from 'react-icons/hi'
import automationService from '../../services/automationService'
import { useAutomationContext } from '../../components/automation/AutomationContext'
import MetricCard from '../../components/ui/MetricCard'
import SectionCard from '../../components/ui/SectionCard'
import EmptyState from '../../components/ui/EmptyState'
import LoadingSkeleton from '../../components/ui/LoadingSkeleton'
import StatusBadge from '../../components/ui/StatusBadge'
import { useConfirm } from '../../components/ui/ConfirmDialog'
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


/**
 * Hidden for now, not deleted.
 *
 * The tiles still compute correctly and the data behind them is still fetched,
 * so this is one line to put back when the row is wanted again -- which is why
 * it is a flag rather than a commented-out block or a deletion.
 */
const SHOW_STAT_TILES = false

const Runs: React.FC = () => {
  const navigate = useNavigate()
  const { runtime, canExecute } = useAutomationContext()
  const confirm = useConfirm()

  const [runs, setRuns] = useState<RunSummary[]>([])
  const [summary, setSummary] = useState<RunsSummary>(EMPTY_SUMMARY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [selectedRuns, setSelectedRuns] = useState<Set<string>>(new Set())
  const [runModalOpen, setRunModalOpen] = useState(false)
  const [rerunSpec, setRerunSpec] = useState<{
    code?: string | null
    fileName?: string | null
    baseUrl?: string | null
    environment?: string | null
  } | null>(null)
  const [healLoadingKey, setHealLoadingKey] = useState<string | null>(null)

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

  const handleDeleteRuns = async (runKeyToDelete?: string) => {
    const keysToDelete = runKeyToDelete ? [runKeyToDelete] : Array.from(selectedRuns)
    if (keysToDelete.length === 0) return

    const count = keysToDelete.length
    // A run still in flight is cancelled before it is removed -- worth saying,
    // because cancelling is not what the button appears to offer.
    const active = runs.filter(
      run => keysToDelete.includes(run.run_key) && !isTerminal(run.status)
    ).length
    const ok = await confirm({
      title: count === 1 ? 'Delete this run?' : `Delete ${count} runs?`,
      body: count === 1 ? keysToDelete[0] : `${count} selected runs will be removed.`,
      consequences: [
        ...(active > 0
          ? [
              `${
                active === 1 ? '1 of these is still running and is' : `${active} are still running and are`
              } cancelled first.`
            ]
          : []),
        'The run workspace is deleted from disk — traces, screenshots and every other artefact it captured.',
        'This cannot be undone.'
      ],
      confirmLabel: count === 1 ? 'Delete run' : `Delete ${count} runs`
    })
    if (!ok) return

    setDeleting(true)
    setError(null)
    try {
      await automationService.deleteRuns(keysToDelete)
      if (runKeyToDelete) {
        setSelectedRuns(prev => {
          const next = new Set(prev)
          next.delete(runKeyToDelete)
          return next
        })
      } else {
        setSelectedRuns(new Set())
      }
      await load(false)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to delete runs.')
    } finally {
      setDeleting(false)
    }
  }

  const handleQueued = (runKey: string) => {
    setRunModalOpen(false)
    setRerunSpec(null)
    navigate(`/automation/runs/${runKey}`)
  }

  const handleRerunClick = async (e: React.MouseEvent, runKey: string) => {
    e.stopPropagation()
    try {
      const detail = await automationService.getRun(runKey)
      setRerunSpec({
        code: detail.spec?.code || detail.original_code || '',
        fileName: detail.spec?.file_name || detail.file_name || 'spec.ts',
        baseUrl: detail.spec?.base_url || '',
        environment: detail.environment || 'SIT',
      })
      setRunModalOpen(true)
    } catch {
      setRerunSpec(null)
      setRunModalOpen(true)
    }
  }

  const handleHealClick = async (e: React.MouseEvent, runKey: string) => {
    e.stopPropagation()
    setHealLoadingKey(runKey)
    try {
      const healRes = await automationService.healRun(runKey)
      setRerunSpec({
        code: healRes.healed_code,
        fileName: 'healed_spec.ts',
        baseUrl: '',
        environment: 'SIT',
      })
      setRunModalOpen(true)
    } catch (err: any) {
      setError(err?.message ?? 'Healer failed to repair this run.')
    } finally {
      setHealLoadingKey(null)
    }
  }

  const allSelected = useMemo(
    () => runs.length > 0 && runs.every(r => selectedRuns.has(r.run_key)),
    [runs, selectedRuns]
  )
  const someSelected = useMemo(
    () => runs.some(r => selectedRuns.has(r.run_key)) && !allSelected,
    [runs, selectedRuns, allSelected]
  )

  return (
    <div className="space-y-3">
      {SHOW_STAT_TILES && (
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
      )}

      <SectionCard
        title="Run history"
        description="The 50 most recent runs. Select one to see its results and the evidence it captured."
        noPadding
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {selectedRuns.size > 0 && canExecute ? (
              <button
                type="button"
                onClick={() => handleDeleteRuns()}
                disabled={deleting}
                className="app-btn app-btn-secondary inline-flex items-center gap-1.5 text-app-danger disabled:opacity-50"
                title="Delete selected runs and their workspace logs"
              >
                <HiOutlineTrash className="h-4 w-4" />
                {deleting ? 'Deleting…' : `Delete (${selectedRuns.size})`}
              </button>
            ) : null}
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
                  <th className="w-10 text-center">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={node => {
                        if (node) node.indeterminate = someSelected
                      }}
                      onChange={e =>
                        setSelectedRuns(
                          e.target.checked ? new Set(runs.map(r => r.run_key)) : new Set()
                        )
                      }
                      className="h-3.5 w-3.5 rounded"
                      aria-label="Select all runs"
                    />
                  </th>
                  <th className="text-left">Test Case / Script</th>
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
                  const displayName =
                    run.tc_title || run.tc_display_id || run.file_name || run.run_key
                  const displaySubtitle = [
                    run.tc_display_id && run.tc_display_id !== displayName
                      ? run.tc_display_id
                      : null,
                    run.run_key,
                    run.framework,
                    run.environment ? run.environment : null
                  ]
                    .filter(Boolean)
                    .join(' · ')

                  return (
                    <tr
                      key={run.run_key}
                      onClick={() => navigate(`/automation/runs/${run.run_key}`)}
                      className="cursor-pointer"
                    >
                      <td
                        onClick={e => e.stopPropagation()}
                        className="text-center"
                      >
                        <input
                          type="checkbox"
                          checked={selectedRuns.has(run.run_key)}
                          onChange={() =>
                            setSelectedRuns(prev => {
                              const next = new Set(prev)
                              if (next.has(run.run_key)) {
                                next.delete(run.run_key)
                              } else {
                                next.add(run.run_key)
                              }
                              return next
                            })
                          }
                          className="h-3.5 w-3.5 rounded"
                        />
                      </td>
                      <td>
                        <div className="min-w-0 max-w-[340px]">
                          <div
                            className="truncate font-semibold text-app-primary"
                            title={displayName}
                          >
                            {displayName}
                          </div>
                          <div
                            className="truncate font-mono text-[12px] text-app-secondary"
                            title={displaySubtitle}
                          >
                            {displaySubtitle}
                          </div>
                        </div>
                      </td>
                      <td>
                        <RunStatusBadge status={run.status} live={run.is_active} />
                      </td>
                      <td>
                        <div className="flex items-center gap-1.5">
                          <OutcomeBadge outcome={run.outcome} status={run.status} />
                          {run.is_healed ? (
                            <span title={run.healing_diagnosis || 'Auto-repaired at runtime by Healer Agent'}>
                              <StatusBadge tone="success" size="sm">
                                Healed
                              </StatusBadge>
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="text-app-secondary">
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
                      <td className="text-app-secondary">
                        {formatDuration(run.duration_seconds)}
                      </td>
                      <td className="text-app-secondary">
                        {run.triggered_by ?? '—'}
                      </td>
                      <td
                        className="whitespace-nowrap text-app-secondary"
                        title={run.started_at ?? run.created_at ?? ''}
                      >
                        {formatAge(run.started_at ?? run.created_at)}
                      </td>
                      <td className="text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {canExecute && run.outcome === 'failed' ? (
                            <button
                              type="button"
                              onClick={e => void handleHealClick(e, run.run_key)}
                              disabled={healLoadingKey === run.run_key}
                              title="Regenerate & Heal this failed spec with AI"
                              className="app-btn app-btn-secondary inline-flex items-center gap-1 px-2 py-1 text-[12px] font-medium"
                            >
                              <HiOutlineSparkles className={`h-3.5 w-3.5 text-app-success ${healLoadingKey === run.run_key ? 'animate-spin' : ''}`} />
                              {healLoadingKey === run.run_key ? 'Healing…' : 'Heal'}
                            </button>
                          ) : null}
                          {canExecute ? (
                            <button
                              type="button"
                              onClick={e => void handleRerunClick(e, run.run_key)}
                              title="Rerun this spec"
                              className="rounded p-1 text-app-secondary transition hover:bg-app-surface hover:text-app-primary"
                            >
                              <HiOutlinePlay className="h-4 w-4" />
                            </button>
                          ) : null}
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
                          {canExecute ? (
                            <button
                              type="button"
                              onClick={e => {
                                e.stopPropagation()
                                void handleDeleteRuns(run.run_key)
                              }}
                              disabled={deleting}
                              title={`Delete run ${run.run_key}`}
                              className="rounded p-1 text-app-secondary transition hover:bg-app-surface hover:text-app-danger disabled:opacity-40"
                            >
                              <HiOutlineTrash className="h-4 w-4" />
                            </button>
                          ) : null}
                        </div>
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
        onClose={() => {
          setRunModalOpen(false)
          setRerunSpec(null)
        }}
        candidate={null}
        initialCode={rerunSpec?.code}
        initialFileName={rerunSpec?.fileName}
        initialBaseUrl={rerunSpec?.baseUrl}
        initialEnvironment={rerunSpec?.environment}
        runtime={runtime}
        canExecute={canExecute}
        onQueued={handleQueued}
      />
    </div>
  )
}

export default Runs
