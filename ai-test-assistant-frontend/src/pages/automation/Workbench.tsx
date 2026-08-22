/**
 * --- Automation TC Coverage Assessment ----------------------------------
 *
 * Approved test cases land here, get refined in place keeping their ID and
 * name, are classified, and go through approval on their way to the Script Lab.
 *
 * Ported in behaviour from stlc-platform's test-cases view. Two departures:
 * there is no project scope, and grounding is absent because Application
 * Discovery is a separate screen.
 *
 * The one thing worth defending here is the grounding warning above the
 * Generate button. Without an application URL the refinement writes
 * "Application URL not configured" into the first precondition of every case
 * it produces and still reports success, so the only way to find out used to
 * be opening one and reading it — then regenerating the lot. Saying it before
 * the call costs a line of text and saves the batch.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  HiOutlineSparkles,
  HiOutlineRefresh,
  HiOutlineTrash,
  HiOutlinePencil,
  HiOutlineReply,
  HiOutlineDownload,
  HiOutlineCheck,
  HiOutlineX,
  HiOutlineExclamationCircle
} from 'react-icons/hi'
import automationService from '../../services/automationService'
import { useAutomationContext } from '../../components/automation/AutomationContext'
import SectionCard from '../../components/ui/SectionCard'
import EmptyState from '../../components/ui/EmptyState'
import LoadingSkeleton from '../../components/ui/LoadingSkeleton'
import StatusBadge from '../../components/ui/StatusBadge'
import TestCaseEditor from '../../components/automation/TestCaseEditor'
import {
  ApprovalBadge,
  ClassificationBadge,
  JobProgress,
  OriginBadge,
  StatTile,
  TestDataBadge
} from '../../components/automation/workbenchPresentation'
import { isJobSettled } from '../../types/automation'
import type {
  Classification,
  GenerationJob,
  WorkbenchCase,
  WorkbenchCounts,
  WorkbenchSource
} from '../../types/automation'

const EMPTY_COUNTS: WorkbenchCounts = {
  total: 0,
  automation: 0,
  manual: 0,
  undecided: 0,
  approved: 0,
  rejected: 0,
  needs_data: 0
}

const ENVIRONMENTS = ['SIT', 'UAT', 'QA', 'DEV']

/** Hand the browser a blob as a download. */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

const Workbench: React.FC = () => {
  const { canExecute } = useAutomationContext()

  const [sources, setSources] = useState<WorkbenchSource[]>([])
  const [cases, setCases] = useState<WorkbenchCase[]>([])
  const [counts, setCounts] = useState<WorkbenchCounts>(EMPTY_COUNTS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set())
  const [selectedCases, setSelectedCases] = useState<Set<number>>(new Set())

  const [applicationUrl, setApplicationUrl] = useState('')
  const [environment, setEnvironment] = useState('SIT')
  const [regenerate, setRegenerate] = useState(false)

  const [job, setJob] = useState<GenerationJob | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | Classification>('all')

  const [editing, setEditing] = useState<WorkbenchCase | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)

  const pollRef = useRef<number | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [sourceRes, gridRes] = await Promise.all([
        automationService.listWorkbenchSources(),
        automationService.listWorkbenchCases('all')
      ])
      setSources(sourceRes.sources ?? [])
      setCases(gridRes.test_cases ?? [])
      setCounts(gridRes.counts ?? EMPTY_COUNTS)
    } catch (err: any) {
      setError(err?.message ?? 'The workbench could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    return () => {
      if (pollRef.current !== null) window.clearTimeout(pollRef.current)
    }
  }, [load])

  // Poll a running batch. Stops the moment it settles — a finished job cannot
  // change, and the screen reloads once from the terminal state.
  const pollJob = useCallback(
    async (jobId: string) => {
      try {
        const next = await automationService.getGenerationJob(jobId)
        setJob(next)
        if (isJobSettled(next.status)) {
          await load()
          return
        }
        pollRef.current = window.setTimeout(() => void pollJob(jobId), 1200)
      } catch (err: any) {
        setError(err?.message ?? 'Lost track of the refinement job.')
        setJob(null)
      }
    },
    [load]
  )

  const runAction = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    setNotice(null)
    try {
      await fn()
      await load()
    } catch (err: any) {
      setError(err?.message ?? `${label} failed.`)
    } finally {
      setBusy(null)
    }
  }

  const handleGenerate = async () => {
    if (selectedSources.size === 0) return
    setBusy('generate')
    setError(null)
    setNotice(null)
    try {
      const started = await automationService.generateRefinedCases({
        source_test_case_ids: Array.from(selectedSources),
        application_url: applicationUrl.trim() || null,
        environment: environment.trim() || null,
        regenerate
      })
      setJob(started)
      setSelectedSources(new Set())
      void pollJob(started.job_id)
    } catch (err: any) {
      setError(err?.message ?? 'Refinement could not be started.')
    } finally {
      setBusy(null)
    }
  }

  const handleDecide = (decision: 'approve' | 'reject') =>
    runAction(decision, async () => {
      const res = await automationService.decideCases(Array.from(selectedCases), decision)
      setSelectedCases(new Set())
      if (res.refused?.length) {
        // Named, not counted: "3 refused" leaves someone hunting for which.
        setNotice(
          `${res.updated} ${decision}d. ${res.refused.length} refused — ` +
            res.refused.map(r => `${r.display_id}: ${r.reason}`).join(' · ')
        )
      }
    })

  const visibleCases = useMemo(
    () => (filter === 'all' ? cases : cases.filter(c => c.classification === filter)),
    [cases, filter]
  )

  const allSourcesSelected =
    sources.length > 0 && sources.every(s => selectedSources.has(s.id))
  const someSourcesSelected = selectedSources.size > 0 && !allSourcesSelected

  const alreadyRefinedSelected = useMemo(
    () => Array.from(selectedSources).filter(id => sources.find(s => s.id === id)?.refined_test_case_id),
    [selectedSources, sources]
  )

  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  }

  const anySelected = selectedCases.size > 0

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile label="Test cases" value={loading ? '—' : counts.total} />
        <StatTile label="Automation" value={loading ? '—' : counts.automation} />
        <StatTile label="Manual" value={loading ? '—' : counts.manual} />
        <StatTile label="Approved" value={loading ? '—' : counts.approved} tone="success" />
        <StatTile
          label="Awaiting test data"
          value={loading ? '—' : counts.needs_data}
          tone={counts.needs_data ? 'warning' : 'default'}
          hint={counts.needs_data ? 'Blocks approval' : undefined}
        />
      </div>

      {/* ── What to refine ─────────────────────────────────────────────── */}
      <SectionCard
        title="What to refine"
        description="Approved test cases are refined in place and keep their ID and name — the originals in the review workflow are never modified."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={applicationUrl}
              onChange={e => setApplicationUrl(e.target.value)}
              placeholder="Application URL"
              className="app-input w-[210px]"
              aria-label="Application URL"
            />
            <input
              value={environment}
              onChange={e => setEnvironment(e.target.value)}
              list="tas-workbench-environments"
              placeholder="qa"
              className="app-input w-24"
              aria-label="Environment"
            />
            <datalist id="tas-workbench-environments">
              {ENVIRONMENTS.map(name => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-app-secondary">
              <input
                type="checkbox"
                checked={regenerate}
                onChange={e => setRegenerate(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Regenerate existing
            </label>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!canExecute || selectedSources.size === 0 || busy === 'generate'}
              className="app-btn app-btn-primary inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <HiOutlineSparkles className="h-4 w-4" />
              {busy === 'generate'
                ? 'Starting…'
                : selectedSources.size
                  ? `Generate ${selectedSources.size} test case(s)`
                  : 'Generate refined test cases'}
            </button>
          </div>
        }
      >
        {job && !isJobSettled(job.status) ? (
          <div className="mb-3">
            <JobProgress percent={job.percent} message={job.message} />
          </div>
        ) : null}

        {job && isJobSettled(job.status) ? (
          <div
            className={`mb-3 rounded-app border px-3 py-2.5 text-[12px] ${
              job.errors.length
                ? 'border-orange-200 bg-app-warning-bg text-app-warning'
                : 'border-green-200 bg-app-success-bg text-app-success'
            }`}
          >
            {job.message}
            {job.errors.length ? (
              <ul className="mt-1 space-y-0.5">
                {job.errors.map((e, i) => (
                  <li key={i}>
                    <span className="font-semibold">{e.display_id}</span>: {e.error}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {selectedSources.size > 0 ? (
          applicationUrl.trim() ? (
            <p className="mb-3 text-[11px] text-app-secondary">
              Grounding in <span className="font-medium text-app-primary">{applicationUrl}</span>
              {environment ? ` (${environment})` : null}
            </p>
          ) : (
            <p className="mb-3 rounded-app border border-orange-200 bg-app-warning-bg px-3 py-2 text-[11px] text-app-warning">
              No application URL set, so every refined test case will carry “Application URL not
              configured” as its first precondition. Set one above to ground them.
            </p>
          )
        ) : null}

        {alreadyRefinedSelected.length > 0 && !regenerate ? (
          <p className="mb-3 rounded-app border border-orange-200 bg-app-warning-bg px-3 py-2 text-[11px] text-app-warning">
            {alreadyRefinedSelected.length} of the selected case(s) have already been refined and
            will be skipped. Tick <span className="font-semibold">Regenerate existing</span> to
            replace them instead.
          </p>
        ) : null}

        {loading ? (
          <LoadingSkeleton className="h-40 w-full" rounded="lg" />
        ) : sources.length === 0 ? (
          <EmptyState
            title="No approved test cases"
            description="Approve a test case in Review & Approve and it appears here, ready to refine."
          />
        ) : (
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <label className="flex min-w-0 cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={allSourcesSelected}
                  ref={node => {
                    // Some-but-not-all reads as "clicking this clears the
                    // selection", which an unticked box does not convey.
                    if (node) node.indeterminate = someSourcesSelected
                  }}
                  onChange={e =>
                    setSelectedSources(e.target.checked ? new Set(sources.map(s => s.id)) : new Set())
                  }
                  className="h-3.5 w-3.5"
                  aria-label="Select all approved test cases"
                />
                <h4 className="truncate text-[12px] font-semibold text-app-primary">
                  Approved test cases
                  <span className="ml-1.5 font-normal text-app-secondary">({sources.length})</span>
                </h4>
              </label>
              <span className="flex-shrink-0 text-[11px] text-app-secondary">
                {selectedSources.size > 0
                  ? `${selectedSources.size} selected`
                  : 'ID and name preserved'}
              </span>
            </div>
            <div className="app-scroll max-h-64 space-y-1 overflow-y-auto">
              {sources.map(source => (
                <label
                  key={source.id}
                  className="flex cursor-pointer items-start gap-2 rounded-app border border-transparent px-2 py-1.5 text-[12px] transition hover:border-app hover:bg-app-surface-muted"
                >
                  <input
                    type="checkbox"
                    checked={selectedSources.has(source.id)}
                    onChange={() => setSelectedSources(prev => toggle(prev, source.id))}
                    className="mt-0.5 h-3.5 w-3.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-mono text-[11px] text-app-secondary">
                      {source.tc_display_id}
                    </span>
                    <span className="ml-2 font-medium text-app-primary">{source.title}</span>
                  </span>
                  {source.refined_test_case_id ? (
                    <StatusBadge tone="info" size="sm">
                      Refined
                    </StatusBadge>
                  ) : null}
                </label>
              ))}
            </div>
          </div>
        )}
      </SectionCard>

      {/* ── Refined test cases ─────────────────────────────────────────── */}
      <SectionCard
        title="Refined test cases"
        description="Classify against the automation rules, edit, approve, and download Manual and Automation separately."
        noPadding
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={filter}
              onChange={e => setFilter(e.target.value as 'all' | Classification)}
              className="app-input"
              aria-label="Filter by classification"
            >
              <option value="all">All</option>
              <option value="automation">Automation</option>
              <option value="manual">Manual</option>
              <option value="undecided">Unclassified</option>
            </select>
            <button
              type="button"
              onClick={() =>
                runAction('classify', () =>
                  automationService.classifyCases(Array.from(selectedCases))
                )
              }
              disabled={!anySelected || !canExecute || busy !== null}
              title="Classify by the automation rules: blockers and steps needing a human go to Manual"
              className="app-btn app-btn-secondary inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <HiOutlineSparkles className="h-4 w-4" />
              Bulk classify by policy
            </button>
            <button
              type="button"
              onClick={() =>
                runAction('classify', () =>
                  automationService.classifyCases(Array.from(selectedCases), 'automation')
                )
              }
              disabled={!anySelected || !canExecute || busy !== null}
              className="app-btn app-btn-secondary disabled:opacity-50"
            >
              Set Automation
            </button>
            <button
              type="button"
              onClick={() =>
                runAction('classify', () =>
                  automationService.classifyCases(Array.from(selectedCases), 'manual')
                )
              }
              disabled={!anySelected || !canExecute || busy !== null}
              className="app-btn app-btn-secondary disabled:opacity-50"
            >
              Set Manual
            </button>
            <button
              type="button"
              onClick={() => handleDecide('reject')}
              disabled={!anySelected || !canExecute || busy !== null}
              className="app-btn app-btn-secondary inline-flex items-center gap-1.5 text-app-danger disabled:opacity-50"
            >
              <HiOutlineX className="h-4 w-4" />
              Reject
            </button>
            <button
              type="button"
              onClick={() =>
                runAction('delete', async () => {
                  await automationService.deleteWorkbenchCases(Array.from(selectedCases))
                  setSelectedCases(new Set())
                })
              }
              disabled={!anySelected || !canExecute || busy !== null}
              title="Delete the selected test cases and any scripts generated from them"
              className="app-btn app-btn-secondary inline-flex items-center gap-1.5 text-app-danger disabled:opacity-50"
            >
              <HiOutlineTrash className="h-4 w-4" />
              Delete
            </button>
            <button
              type="button"
              onClick={() => handleDecide('approve')}
              disabled={!anySelected || !canExecute || busy !== null}
              className="app-btn app-btn-primary inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <HiOutlineCheck className="h-4 w-4" />
              Approve
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="app-btn app-btn-secondary inline-flex items-center gap-1.5"
              title="Reload"
            >
              <HiOutlineRefresh className="h-4 w-4" />
            </button>
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-app px-5 py-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-app-secondary">
            Download
          </span>
          <button
            type="button"
            onClick={() =>
              runAction('export', async () => {
                // The workbook is built client-side from the two CSVs: SheetJS
                // already ships with this app, so the backend does not need an
                // xlsx dependency just to format a download.
                const XLSX = await import('xlsx')
                const [automation, manual] = await Promise.all([
                  automationService.exportWorkbenchCsv('automation'),
                  automationService.exportWorkbenchCsv('manual')
                ])
                const book = XLSX.utils.book_new()
                XLSX.utils.book_append_sheet(
                  book,
                  XLSX.read(await automation.text(), { type: 'string' }).Sheets.Sheet1,
                  'Automation'
                )
                XLSX.utils.book_append_sheet(
                  book,
                  XLSX.read(await manual.text(), { type: 'string' }).Sheets.Sheet1,
                  'Manual'
                )
                XLSX.writeFile(book, 'automation-test-cases.xlsx')
              })
            }
            disabled={busy !== null}
            className="app-btn app-btn-secondary inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <HiOutlineDownload className="h-4 w-4" />
            Workbook (both sheets)
          </button>
          <button
            type="button"
            onClick={() =>
              runAction('export', async () =>
                saveBlob(
                  await automationService.exportWorkbenchCsv('automation'),
                  'automation-test-cases-automation.csv'
                )
              )
            }
            disabled={busy !== null}
            className="app-btn app-btn-secondary inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <HiOutlineDownload className="h-4 w-4" />
            Automation CSV
          </button>
          <button
            type="button"
            onClick={() =>
              runAction('export', async () =>
                saveBlob(
                  await automationService.exportWorkbenchCsv('manual'),
                  'automation-test-cases-manual.csv'
                )
              )
            }
            disabled={busy !== null}
            className="app-btn app-btn-secondary inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <HiOutlineDownload className="h-4 w-4" />
            Manual CSV
          </button>
        </div>

        {notice ? (
          <div className="mx-5 mt-4 flex items-start gap-2 rounded-app border border-orange-200 bg-app-warning-bg px-3 py-3 text-[12px] text-app-warning">
            <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{notice}</span>
          </div>
        ) : null}

        {error ? (
          <div className="mx-5 mt-4 flex items-start gap-2 rounded-app border border-red-200 bg-app-danger-bg px-3 py-3 text-[13px] text-app-danger">
            <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 4 }, (_, i) => (
              <LoadingSkeleton key={i} className="h-12 w-full" rounded="lg" />
            ))}
          </div>
        ) : visibleCases.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No refined test cases"
              description="Select approved test cases above and generate refined ones to populate this grid."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="app-table">
              <thead>
                <tr>
                  <th className="text-left">
                    <input
                      type="checkbox"
                      checked={
                        visibleCases.length > 0 &&
                        visibleCases.every(c => selectedCases.has(c.id))
                      }
                      onChange={e =>
                        setSelectedCases(
                          e.target.checked ? new Set(visibleCases.map(c => c.id)) : new Set()
                        )
                      }
                      className="h-3.5 w-3.5"
                      aria-label="Select all test cases"
                    />
                  </th>
                  <th className="text-left">TC ID</th>
                  <th className="text-left">Title</th>
                  <th className="text-left">Origin</th>
                  <th className="text-left">Steps</th>
                  <th className="text-left">Classification</th>
                  <th className="text-left">Test Data Required</th>
                  <th className="text-left">Status</th>
                  <th className="text-right"></th>
                </tr>
              </thead>
              <tbody>
                {visibleCases.map(testCase => (
                  <tr key={testCase.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedCases.has(testCase.id)}
                        onChange={() => setSelectedCases(prev => toggle(prev, testCase.id))}
                        className="h-3.5 w-3.5"
                        aria-label={`Select ${testCase.tc_display_id}`}
                      />
                    </td>
                    <td className="whitespace-nowrap font-mono text-[12px] text-app-primary">
                      {testCase.tc_display_id}
                      {testCase.version > 1 ? (
                        <span className="ml-1 text-app-secondary">v{testCase.version}</span>
                      ) : null}
                    </td>
                    <td>
                      <div className="max-w-sm">
                        <p className="font-medium text-app-primary">{testCase.title}</p>
                        {testCase.objective ? (
                          <p className="mt-0.5 truncate text-[11px] text-app-secondary">
                            {testCase.objective}
                          </p>
                        ) : null}
                        {testCase.application_url ? (
                          <p className="mt-0.5 truncate text-[11px] text-app-secondary/70">
                            {testCase.application_url}
                          </p>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <OriginBadge origin={testCase.origin} />
                      {testCase.source_missing ? (
                        <p
                          className="mt-0.5 max-w-[150px] text-[10px] text-app-warning"
                          title="Generating again would build a second test case alongside this one unless you tick Regenerate existing."
                        >
                          Source deleted
                        </p>
                      ) : null}
                    </td>
                    <td className="text-[12px] text-app-secondary">{testCase.steps.length}</td>
                    <td>
                      <ClassificationBadge classification={testCase.classification} />
                      {testCase.classification_reason ? (
                        <p className="mt-0.5 max-w-[220px] text-[10px] leading-4 text-app-secondary">
                          {testCase.classification_reason}
                        </p>
                      ) : null}
                    </td>
                    <td>
                      <TestDataBadge
                        required={testCase.test_data_required}
                        status={testCase.test_data_status}
                      />
                      {testCase.test_data_notes ? (
                        <p className="mt-0.5 max-w-[220px] text-[10px] leading-4 text-app-warning">
                          {testCase.test_data_notes}
                        </p>
                      ) : null}
                    </td>
                    <td>
                      <ApprovalBadge status={testCase.approval_status} />
                    </td>
                    <td className="text-right">
                      <div className="inline-flex items-center gap-0.5">
                        {testCase.approval_status === 'approved' ? (
                          <button
                            type="button"
                            onClick={() =>
                              runAction('reopen', () =>
                                automationService.reopenCase(testCase.id)
                              )
                            }
                            disabled={!canExecute || busy !== null}
                            className="rounded-md p-1.5 text-app-secondary transition hover:bg-app-surface-muted hover:text-app-primary disabled:opacity-40"
                            title="Reopen for editing"
                          >
                            <HiOutlineReply className="h-4 w-4" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setEditError(null)
                              setEditing(testCase)
                            }}
                            disabled={!canExecute}
                            className="rounded-md p-1.5 text-app-secondary transition hover:bg-app-surface-muted hover:text-app-primary disabled:opacity-40"
                            title="Edit"
                          >
                            <HiOutlinePencil className="h-4 w-4" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            runAction('delete', () =>
                              automationService.deleteWorkbenchCases([testCase.id])
                            )
                          }
                          disabled={!canExecute || busy !== null}
                          className="rounded-md p-1.5 text-app-secondary transition hover:bg-app-danger-bg hover:text-app-danger disabled:opacity-40"
                          title={`Delete ${testCase.tc_display_id}`}
                        >
                          <HiOutlineTrash className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <TestCaseEditor
        testCase={editing}
        saving={savingEdit}
        error={editError}
        onCancel={() => setEditing(null)}
        onSave={async patch => {
          if (!editing) return
          setSavingEdit(true)
          setEditError(null)
          try {
            await automationService.editWorkbenchCase(editing.id, patch)
            setEditing(null)
            await load()
          } catch (err: any) {
            setEditError(err?.message ?? 'The edit could not be saved.')
          } finally {
            setSavingEdit(false)
          }
        }}
      />
    </div>
  )
}

export default Workbench
