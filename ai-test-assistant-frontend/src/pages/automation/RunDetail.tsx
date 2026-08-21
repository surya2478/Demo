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
import { Link, useParams } from 'react-router-dom'
import {
  HiOutlineArrowLeft,
  HiOutlineRefresh,
  HiOutlineStop,
  HiOutlineExclamationCircle,
  HiOutlineTerminal,
  HiOutlineChevronDown,
  HiOutlineChevronRight,
  HiOutlineBeaker
} from 'react-icons/hi'
import automationService from '../../services/automationService'
import useRunPolling from '../../hooks/useRunPolling'
import { useAutomationContext } from '../../components/automation/AutomationContext'
import SectionCard from '../../components/ui/SectionCard'
import EmptyState from '../../components/ui/EmptyState'
import LoadingSkeleton from '../../components/ui/LoadingSkeleton'
import EvidencePanel from '../../components/automation/EvidencePanel'
import { CodeViewer } from '../../components/automation/CodeViewer'
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

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const [log, setLog] = useState<string | null>(null)
  const [logLoading, setLogLoading] = useState(false)
  const [logError, setLogError] = useState<string | null>(null)
  const [logOpen, setLogOpen] = useState(false)

  const results = run?.results ?? []

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
              <OutcomeBadge outcome={run.outcome} status={run.status} />
              {polling ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-app-info">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-app-info" />
                  Live
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
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
            <div className="p-5">
              <EmptyState
                title={live ? 'Waiting for results' : 'No tests reported'}
                description={
                  live
                    ? 'The runner has not reported a test yet. This page updates on its own.'
                    : 'The run produced no per-test results. If the outcome is blocked, the runner log below explains why it never reached the tests.'
                }
                icon={<HiOutlineBeaker className="h-5 w-5" />}
              />
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
    </div>
  )
}

export default RunDetail
