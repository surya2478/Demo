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
  HiOutlineExclamationCircle,
  HiOutlineCursorClick,
  HiOutlineEye,
  HiOutlineStar,
  HiOutlineShieldCheck
} from 'react-icons/hi'
import automationService from '../../services/automationService'
import { useAutomationContext } from '../../components/automation/AutomationContext'
import SectionCard from '../../components/ui/SectionCard'
import EmptyState from '../../components/ui/EmptyState'
import LoadingSkeleton from '../../components/ui/LoadingSkeleton'
import StatusBadge from '../../components/ui/StatusBadge'
import TestCaseEditor from '../../components/automation/TestCaseEditor'
import DocumentIntake from '../../components/automation/DocumentIntake'
import { GroundingBadge } from '../../components/automation/groundingPresentation'
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
  RecordedFlowObject,
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

  const [activeDiscoveryCase, setActiveDiscoveryCase] = useState<WorkbenchCase | null>(null)
  const [activeDiscoveryStatus, setActiveDiscoveryStatus] = useState<string | null>(null)
  const [flowObjectsCase, setFlowObjectsCase] = useState<WorkbenchCase | null>(null)
  const [flowObjects, setFlowObjects] = useState<RecordedFlowObject[]>([])
  const [loadingObjects, setLoadingObjects] = useState<boolean>(false)
  const [objectsNotice, setObjectsNotice] = useState<string | null>(null)

  const [reviewModalCase, setReviewModalCase] = useState<WorkbenchCase | null>(null)
  const [reviewingCaseId, setReviewingCaseId] = useState<number | null>(null)
  const [improvingCaseId, setImprovingCaseId] = useState<number | null>(null)
  const [reviewingAll, setReviewingAll] = useState<boolean>(false)

  const pollRef = useRef<number | null>(null)
  const discoveryPollRef = useRef<number | null>(null)

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
      if (discoveryPollRef.current !== null) window.clearTimeout(discoveryPollRef.current)
    }
  }, [load])

  const pollDiscoveryStatus = useCallback(
    async (caseId: number) => {
      try {
        const res = await automationService.getGuidedDiscoveryStatus(caseId)
        setActiveDiscoveryStatus(res.status)
        if (res.status !== 'starting' && res.status !== 'recording') {
          setActiveDiscoveryCase(null)
          await load()
          if (res.status === 'completed' || res.status === 'captured') {
            setNotice(`Guided Discovery completed: ${res.objects_count} flow objects captured for ${res.display_id}`)
          }
          return
        }
        discoveryPollRef.current = window.setTimeout(() => void pollDiscoveryStatus(caseId), 2000)
      } catch {
        setActiveDiscoveryCase(null)
        await load()
      }
    },
    [load]
  )

  const handleStartGuidedDiscovery = async (testCase: WorkbenchCase) => {
    setError(null)
    setNotice(null)
    try {
      await automationService.startGuidedDiscovery(testCase.id)
      setActiveDiscoveryCase(testCase)
      setActiveDiscoveryStatus('recording')
      setNotice(
        `Launched Guided Live Browser for ${testCase.tc_display_id}. Interact with the web page to record flow objects, then click 'Finish & Save' in the browser HUD when done.`
      )
      discoveryPollRef.current = window.setTimeout(() => void pollDiscoveryStatus(testCase.id), 2000)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to launch Guided Discovery session.')
    }
  }

  const handleStopGuidedDiscovery = async (caseId: number) => {
    if (discoveryPollRef.current !== null) window.clearTimeout(discoveryPollRef.current)
    try {
      const res = await automationService.stopGuidedDiscovery(caseId)
      setActiveDiscoveryCase(null)
      await load()
      setNotice(`Saved ${res.objects_count} flow objects for test case.`)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to stop Guided Discovery.')
    }
  }

  const handleOpenFlowObjects = async (testCase: WorkbenchCase) => {
    setFlowObjectsCase(testCase)
    setLoadingObjects(true)
    setObjectsNotice(null)
    try {
      const res = await automationService.getGuidedDiscoveryObjects(testCase.id)
      setFlowObjects(res.objects || [])
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load recorded flow objects.')
    } finally {
      setLoadingObjects(false)
    }
  }

  const handleClearFlowObjects = async (caseId: number) => {
    try {
      await automationService.clearGuidedDiscoveryObjects(caseId)
      setFlowObjects([])
      if (flowObjectsCase) {
        setFlowObjectsCase({
          ...flowObjectsCase,
          recorded_flow_objects: [],
          flow_discovery_status: 'none'
        })
      }
      await load()
      setNotice('Cleared recorded flow objects.')
    } catch (err: any) {
      setError(err?.message ?? 'Failed to clear flow objects.')
    }
  }

  // ── Quality Review Handlers ──────────────────────────────────────────

  const handleOpenReviewModal = (testCase: WorkbenchCase) => {
    setReviewModalCase(testCase)
    if (!testCase.review_score) {
      void handleRunReview(testCase)
    }
  }

  const handleRunReview = async (testCase: WorkbenchCase) => {
    setReviewingCaseId(testCase.id)
    try {
      const res = await automationService.reviewTestCase(testCase.id)
      const updatedCase: WorkbenchCase = {
        ...testCase,
        review_score: res.overall_score,
        review_verdict: res.verdict,
        review_scores: res.scores,
        review_findings: res.findings,
        reviewed_at: res.reviewed_at,
      }
      setReviewModalCase(updatedCase)
      setCases(prev => prev.map(c => (c.id === testCase.id ? updatedCase : c)))
      setNotice(`Quality Review completed for ${testCase.tc_display_id}: ★ ${res.overall_score.toFixed(1)} / 5.0 (${res.verdict})`)
    } catch (err: any) {
      setError(err?.message ?? 'Review evaluation failed.')
    } finally {
      setReviewingCaseId(null)
    }
  }

  const handleRunReviewAll = async () => {
    setReviewingAll(true)
    setError(null)
    try {
      const res = await automationService.reviewAllTestCases()
      await load()
      setNotice(`Quality Review completed across ${res.reviewed_count} test case(s).`)
    } catch (err: any) {
      setError(err?.message ?? 'Bulk quality review failed.')
    } finally {
      setReviewingAll(false)
    }
  }

  const handleAutoImprove = async (caseId: number) => {
    setImprovingCaseId(caseId)
    setError(null)
    try {
      const res = await automationService.autoImproveTestCase(caseId)
      await load()
      const reloaded = await automationService.listWorkbenchCases('all')
      const target = (reloaded.test_cases || []).find((c: WorkbenchCase) => c.id === caseId)
      if (target) setReviewModalCase(target)
      setNotice(`Auto-improved ${res.display_id} to 5-star quality! New Score: ★ ${res.review.overall_score.toFixed(1)} / 5.0`)
    } catch (err: any) {
      setError(err?.message ?? 'Auto-improvement failed.')
    } finally {
      setImprovingCaseId(null)
    }
  }

  // ── On-Demand In-Place AI Refinement Handlers ─────────────────────────

  const [refining, setRefining] = useState<boolean>(false)
  const [refiningCaseId, setRefiningCaseId] = useState<number | null>(null)

  const handleRefineBulk = async () => {
    if (selectedCases.size === 0) return
    setRefining(true)
    setError(null)
    setNotice(null)
    try {
      const res = await automationService.refineBulkTestCases(
        Array.from(selectedCases),
        applicationUrl.trim() || undefined
      )
      await load()
      setNotice(`AI Refinement complete: ${res.refined_count} test case(s) updated with high fidelity.`)
    } catch (err: any) {
      setError(err?.message ?? 'AI Refinement failed.')
    } finally {
      setRefining(false)
    }
  }

  const handleRefineSingle = async (testCase: WorkbenchCase) => {
    setRefiningCaseId(testCase.id)
    setError(null)
    setNotice(null)
    try {
      await automationService.refineTestCase(testCase.id, {
        application_url: applicationUrl.trim() || undefined
      })
      await load()
      setNotice(`AI Refinement complete for ${testCase.tc_display_id}.`)
    } catch (err: any) {
      setError(err?.message ?? 'Refinement failed.')
    } finally {
      setRefiningCaseId(null)
    }
  }

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
      // The two origins go into different request fields. An approved case's
      // id is a review-workflow test case id; a studio case's is an
      // automation_test_cases primary key. The backend looks each up in its own
      // table, so a misfiled id matches nothing and the case is skipped in
      // silence — hence splitting here rather than sending one flat list.
      const selected = sources.filter(source => selectedSources.has(source.id))
      const started = await automationService.generateRefinedCases({
        source_test_case_ids: selected
          .filter(source => source.origin !== 'studio')
          .map(source => source.id),
        case_ids: selected
          .filter(source => source.origin === 'studio')
          .map(source => Number(source.id)),
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

  const handleDeleteSources = (sourceToDelete?: WorkbenchSource) => {
    const toDelete = sourceToDelete
      ? [sourceToDelete]
      : sources.filter(source => selectedSources.has(source.id))
    if (toDelete.length === 0) return

    const count = toDelete.length
    if (
      !window.confirm(
        `Are you sure you want to delete ${
          count === 1
            ? `test case "${toDelete[0].tc_display_id}"`
            : `${count} selected test cases`
        }?`
      )
    ) {
      return
    }

    runAction('delete-sources', async () => {
      await automationService.deleteWorkbenchSources({
        source_test_case_ids: toDelete
          .filter(source => source.origin !== 'studio')
          .map(source => source.id),
        case_ids: toDelete
          .filter(source => source.origin === 'studio')
          .map(source => Number(source.id))
      })
      if (sourceToDelete) {
        setSelectedSources(prev => {
          const next = new Set(prev)
          next.delete(sourceToDelete.id)
          return next
        })
      } else {
        setSelectedSources(new Set())
      }
    })
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

      {/* ── Document intake ────────────────────────────────────────────── */}
      {/*
        The second way in. Test cases read out of an uploaded document land in
        the same table the panel below reads, so `load` is all that is needed
        to make them appear -- there is no separate intake list to reconcile.
      */}
      <DocumentIntake onCasesHarvested={() => void load()} />

      {/* ── Test Cases Workbench ────────────────────────────────────────── */}
      <SectionCard
        title="Test Cases Workbench"
        description="Classify against automation rules, review quality, edit steps, approve, or AI refine on demand."
        noPadding
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={applicationUrl}
              onChange={e => setApplicationUrl(e.target.value)}
              placeholder="Target URL: https://..."
              className="app-input h-8 text-xs w-48"
              title="Grounding application URL for test cases & refinement"
            />
            <button
              type="button"
              onClick={handleRefineBulk}
              disabled={!anySelected || !canExecute || refining}
              title="Refine selected test cases with AI on-demand"
              className="app-btn bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100 inline-flex items-center gap-1.5 disabled:opacity-50 text-xs font-semibold"
            >
              <HiOutlineSparkles className={`h-4 w-4 text-purple-600 ${refining ? 'animate-spin' : ''}`} />
              {refining ? 'Refining...' : 'AI Refine'}
            </button>
            <button
              type="button"
              onClick={handleRunReviewAll}
              disabled={!canExecute || reviewingAll || cases.length === 0}
              title="Evaluate quality across all test cases using the eSMART Review Agent"
              className="app-btn bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 inline-flex items-center gap-1.5 disabled:opacity-50 text-xs font-semibold"
            >
              <HiOutlineShieldCheck className={`h-4 w-4 text-indigo-600 ${reviewingAll ? 'animate-spin' : ''}`} />
              {reviewingAll ? 'Reviewing...' : 'Review Quality'}
            </button>
            <button
              type="button"
              onClick={() =>
                runAction('classify', () =>
                  automationService.classifyCases(Array.from(selectedCases))
                )
              }
              disabled={!anySelected || !canExecute || busy !== null}
              title="Classify by the automation rules: blockers and steps needing a human go to Manual"
              className="app-btn app-btn-secondary inline-flex items-center gap-1.5 disabled:opacity-50 text-xs font-medium"
            >
              Bulk classify
            </button>
            <button
              type="button"
              onClick={() =>
                runAction('classify', () =>
                  automationService.classifyCases(Array.from(selectedCases), 'automation')
                )
              }
              disabled={!anySelected || !canExecute || busy !== null}
              className="app-btn app-btn-secondary disabled:opacity-50 text-xs font-medium"
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
              className="app-btn app-btn-secondary disabled:opacity-50 text-xs font-medium"
            >
              Set Manual
            </button>
            <button
              type="button"
              onClick={() => handleDecide('approve')}
              disabled={!anySelected || !canExecute || busy !== null}
              className="app-btn bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 inline-flex items-center gap-1 text-xs font-semibold disabled:opacity-50"
            >
              <HiOutlineCheck className="h-4 w-4" />
              Approve
            </button>
            <button
              type="button"
              onClick={() => handleDecide('reject')}
              disabled={!anySelected || !canExecute || busy !== null}
              className="app-btn app-btn-secondary inline-flex items-center gap-1 text-app-danger disabled:opacity-50 text-xs font-medium"
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
              className="app-btn app-btn-secondary inline-flex items-center gap-1 text-app-danger disabled:opacity-50 text-xs font-medium"
            >
              <HiOutlineTrash className="h-4 w-4" />
              Delete
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="app-btn app-btn-secondary inline-flex items-center gap-1.5 text-xs font-medium"
              title="Reload"
            >
              <HiOutlineRefresh className="h-4 w-4" />
            </button>
          </div>
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-app px-5 py-3">
          <div className="flex flex-wrap items-center gap-2">
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

            <div className="ml-2 flex items-center gap-2 border-l border-app pl-3">
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-app-secondary">
                Filter:
              </span>
              <select
                value={filter}
                onChange={e => setFilter(e.target.value as 'all' | Classification)}
                className="app-input h-8 text-xs min-w-[130px]"
                aria-label="Filter by classification"
              >
                <option value="all">All</option>
                <option value="automation">Automation</option>
                <option value="manual">Manual</option>
                <option value="undecided">Unclassified</option>
              </select>
            </div>
          </div>
        </div>

        {activeDiscoveryCase ? (
          <div className="mx-5 mt-4 flex items-center justify-between rounded-xl border border-amber-300 bg-amber-50/95 p-4 text-amber-950 shadow-md">
            <div className="flex items-center gap-3">
              <span className="relative flex h-3.5 w-3.5 flex-shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-red-600"></span>
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-sm">Guided Flow Discovery Live:</span>
                  <span className="font-mono font-bold text-xs bg-amber-200 px-2 py-0.5 rounded text-amber-900 border border-amber-300">
                    {activeDiscoveryCase.tc_display_id}
                  </span>
                </div>
                <p className="text-xs text-amber-800 mt-0.5">
                  Live headed browser is recording user interactions on <strong>{activeDiscoveryCase.application_url}</strong>. Click <strong>"Finish & Save"</strong> in the browser overlay when your flow is completed.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => handleStopGuidedDiscovery(activeDiscoveryCase.id)}
              className="app-btn bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold py-2 px-4 rounded-xl shadow inline-flex items-center gap-1.5 flex-shrink-0"
            >
              <HiOutlineCheck className="h-4 w-4" />
              Finish & Save Objects
            </button>
          </div>
        ) : null}

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
                        {testCase.objective && testCase.objective !== testCase.title ? (
                          <p className="mt-0.5 truncate text-[11px] text-app-secondary">
                            {testCase.objective}
                          </p>
                        ) : null}
                        {testCase.application_url ? (
                          <p className="mt-0.5 truncate text-[11px] text-app-secondary/70">
                            {testCase.application_url}
                          </p>
                        ) : null}
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {testCase.review_score ? (
                            <button
                              type="button"
                              onClick={() => handleOpenReviewModal(testCase)}
                              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold transition border shadow-sm ${
                                testCase.review_verdict === 'pass'
                                  ? 'bg-emerald-50 text-emerald-700 border-emerald-300 hover:bg-emerald-100'
                                  : testCase.review_verdict === 'fail'
                                  ? 'bg-red-50 text-red-700 border-red-300 hover:bg-red-100'
                                  : 'bg-amber-50 text-amber-700 border-amber-300 hover:bg-amber-100'
                              }`}
                              title="Click to view eSMART Quality Review insights & Auto-Improve"
                            >
                              <HiOutlineStar className="h-3 w-3 text-amber-500 fill-amber-400" />
                              Quality: ★ {testCase.review_score.toFixed(1)} / 5.0
                              <span className="opacity-75 uppercase text-[9px] font-bold ml-0.5">
                                ({testCase.review_verdict || 'Reviewed'})
                              </span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleOpenReviewModal(testCase)}
                              className="inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-600 border border-slate-200 px-2 py-0.5 text-[11px] font-medium hover:bg-slate-200 transition"
                              title="Evaluate test case quality with Review Agent"
                            >
                              <HiOutlineShieldCheck className="h-3 w-3 text-slate-500" />
                              Review Quality
                            </button>
                          )}
                          {(testCase.recorded_flow_objects_count ?? testCase.recorded_flow_objects?.length ?? 0) > 0 ? (
                            <button
                              type="button"
                              onClick={() => handleOpenFlowObjects(testCase)}
                              className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-500/20 transition shadow-sm"
                              title="View user-recorded ground-truth flow objects for this test case"
                            >
                              <HiOutlineCursorClick className="h-3 w-3 text-emerald-600 animate-pulse" />
                              {testCase.recorded_flow_objects_count ?? testCase.recorded_flow_objects?.length} flow objects recorded
                            </button>
                          ) : null}
                        </div>
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
                        <button
                          type="button"
                          onClick={() => handleRefineSingle(testCase)}
                          disabled={!canExecute || refiningCaseId === testCase.id}
                          className="rounded-md p-1.5 text-app-secondary transition hover:bg-purple-500/10 hover:text-purple-600 disabled:opacity-40"
                          title={`Refine ${testCase.tc_display_id} with AI`}
                        >
                          <HiOutlineSparkles className={`h-4 w-4 ${refiningCaseId === testCase.id ? 'animate-spin text-purple-600' : ''}`} />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleOpenReviewModal(testCase)}
                          disabled={!canExecute || reviewingCaseId === testCase.id}
                          className="rounded-md p-1.5 text-app-secondary transition hover:bg-indigo-500/10 hover:text-indigo-600 disabled:opacity-40"
                          title={`Quality Review for ${testCase.tc_display_id}`}
                        >
                          <HiOutlineShieldCheck className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleStartGuidedDiscovery(testCase)}
                          disabled={!canExecute || busy !== null || activeDiscoveryCase?.id === testCase.id}
                          className={`rounded-md p-1.5 transition disabled:opacity-40 ${
                            activeDiscoveryCase?.id === testCase.id
                              ? 'bg-amber-500/20 text-amber-600 animate-pulse'
                              : 'text-app-secondary hover:bg-emerald-500/10 hover:text-emerald-600'
                          }`}
                          title={`Guided Discovery: Launch live browser to record page objects for ${testCase.tc_display_id}`}
                        >
                          <HiOutlineCursorClick className="h-4 w-4" />
                        </button>
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

      {flowObjectsCase ? (
        <div
          className="fixed inset-0 z-[75] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
          onClick={e => {
            if (e.target === e.currentTarget) setFlowObjectsCase(null)
          }}
          role="dialog"
          aria-modal="true"
        >
          <div className="flex h-[88vh] w-full max-w-[950px] flex-col overflow-hidden rounded-[24px] border border-app bg-app-surface shadow-[0_28px_70px_rgba(15,23,42,0.22)]">
            <div className="flex items-start justify-between gap-3 border-b border-app bg-app-surface-muted px-5 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600">
                    <HiOutlineCursorClick className="h-4 w-4" />
                  </span>
                  <h2 className="truncate text-[15px] font-bold text-app-primary">
                    Captured Flow Objects · {flowObjectsCase.tc_display_id}
                  </h2>
                </div>
                <p className="text-xs text-app-secondary mt-1">
                  {flowObjects.length} ground-truth page objects captured during guided live browser discovery.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setFlowObjectsCase(null)}
                className="rounded-md p-1.5 text-app-secondary transition hover:bg-app-surface hover:text-app-primary"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="app-scroll flex-1 space-y-3 overflow-y-auto px-5 py-4">
              {loadingObjects ? (
                <div className="space-y-2 p-4">
                  {Array.from({ length: 3 }, (_, i) => (
                    <LoadingSkeleton key={i} className="h-16 w-full" rounded="lg" />
                  ))}
                </div>
              ) : flowObjects.length === 0 ? (
                <EmptyState
                  title="No flow objects captured yet"
                  description="Click 'Start Guided Discovery' to launch a headed browser session and record elements."
                />
              ) : (
                <div className="space-y-3">
                  {flowObjects.map((obj, idx) => (
                    <div
                      key={idx}
                      className="rounded-xl border border-app bg-app-surface-muted/30 p-4 transition hover:border-emerald-500/40 shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-600 font-bold text-xs text-white">
                            {obj.step_number || idx + 1}
                          </span>
                          <span className="font-semibold text-sm text-app-primary">
                            {(obj.action || 'action').toUpperCase()}: {obj.target_name || obj.accessible_name || 'Element'}
                          </span>
                          {obj.role ? (
                            <StatusBadge tone="info" size="sm">
                              {obj.role}
                            </StatusBadge>
                          ) : null}
                          {obj.tag_name ? (
                            <span className="font-mono text-[11px] text-app-secondary bg-app-surface px-1.5 py-0.5 rounded border border-app">
                              &lt;{obj.tag_name}&gt;
                            </span>
                          ) : null}
                        </div>
                        {obj.timestamp ? (
                          <span className="text-[11px] text-app-secondary">
                            {new Date(obj.timestamp).toLocaleTimeString()}
                          </span>
                        ) : null}
                      </div>

                      <div className="mt-2.5 space-y-1.5">
                        <div>
                          <div className="text-[11px] font-semibold text-app-secondary uppercase tracking-wider">
                            Recommended Playwright Locator:
                          </div>
                          <div className="mt-0.5 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-emerald-400 overflow-x-auto selection:bg-emerald-500/30 selection:text-white">
                            {obj.recommended_locator}
                          </div>
                        </div>

                        {obj.alternative_locators && obj.alternative_locators.length > 1 ? (
                          <div className="mt-2">
                            <div className="text-[10px] font-semibold text-app-secondary uppercase tracking-wider">
                              Alternative Locators:
                            </div>
                            <ul className="mt-1 space-y-1">
                              {obj.alternative_locators.slice(1).map((alt, aIdx) => (
                                <li
                                  key={aIdx}
                                  className="font-mono text-[11px] text-slate-300 bg-slate-900 px-2 py-1 rounded border border-slate-800 overflow-x-auto"
                                >
                                  {alt}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-app bg-app-surface-muted px-5 py-3.5">
              <button
                type="button"
                onClick={() => handleClearFlowObjects(flowObjectsCase.id)}
                disabled={flowObjects.length === 0}
                className="text-xs text-app-danger hover:underline disabled:opacity-40"
              >
                Clear All Recorded Objects
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const target = flowObjectsCase
                    setFlowObjectsCase(null)
                    void handleStartGuidedDiscovery(target)
                  }}
                  className="app-btn app-btn-secondary inline-flex items-center gap-1.5"
                >
                  <HiOutlineCursorClick className="h-4 w-4 text-emerald-600" />
                  Re-record Flow
                </button>
                <button
                  type="button"
                  onClick={() => setFlowObjectsCase(null)}
                  className="app-btn app-btn-primary"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {reviewModalCase ? (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
          onClick={e => {
            if (e.target === e.currentTarget) setReviewModalCase(null)
          }}
          role="dialog"
          aria-modal="true"
        >
          <div className="flex h-[90vh] w-full max-w-[900px] flex-col overflow-hidden rounded-[24px] border border-app bg-app-surface shadow-[0_28px_70px_rgba(15,23,42,0.22)]">
            <div className="flex items-start justify-between gap-3 border-b border-app bg-app-surface-muted px-6 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600">
                    <HiOutlineShieldCheck className="h-5 w-5" />
                  </span>
                  <h2 className="truncate text-[16px] font-bold text-app-primary">
                    eSMART Quality Review · {reviewModalCase.tc_display_id}
                  </h2>
                </div>
                <p className="text-xs text-app-secondary mt-1">
                  Multi-dimensional QA evaluation analyzing step quality, data readiness, verifiable post-conditions, and coverage.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReviewModalCase(null)}
                className="rounded-md p-1.5 text-app-secondary transition hover:bg-app-surface hover:text-app-primary"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="app-scroll flex-1 space-y-5 overflow-y-auto px-6 py-5">
              {reviewingCaseId === reviewModalCase.id ? (
                <div className="space-y-3 p-4">
                  <div className="flex items-center gap-3 text-indigo-600 font-semibold text-sm">
                    <span className="h-4 w-4 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin" />
                    Review Agent is analyzing test case against eSMART QA dimensions...
                  </div>
                  <LoadingSkeleton className="h-20 w-full" rounded="lg" />
                  <LoadingSkeleton className="h-32 w-full" rounded="lg" />
                </div>
              ) : (
                <>
                  {/* Overall Score Header */}
                  <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-indigo-100 bg-gradient-to-r from-indigo-50/60 to-purple-50/60 p-5">
                    <div className="flex items-center gap-4">
                      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-600 text-white font-extrabold text-2xl shadow-md">
                        {reviewModalCase.review_score ? reviewModalCase.review_score.toFixed(1) : '—'}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold uppercase tracking-wider text-indigo-900">
                            Overall QA Score
                          </span>
                          <span
                            className={`px-2.5 py-0.5 rounded-full text-xs font-bold uppercase ${
                              reviewModalCase.review_verdict === 'pass'
                                ? 'bg-emerald-100 text-emerald-800'
                                : reviewModalCase.review_verdict === 'fail'
                                ? 'bg-red-100 text-red-800'
                                : 'bg-amber-100 text-amber-800'
                            }`}
                          >
                            {reviewModalCase.review_verdict || 'Evaluated'}
                          </span>
                        </div>
                        <p className="text-xs text-indigo-800/80 mt-1">
                          {reviewModalCase.review_score && reviewModalCase.review_score >= 4.0
                            ? 'High-fidelity test case meeting automated QA criteria.'
                            : 'Actionable improvements identified to reach 5-star quality standard.'}
                        </p>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleAutoImprove(reviewModalCase.id)}
                      disabled={improvingCaseId === reviewModalCase.id}
                      className="app-btn bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white font-semibold text-xs py-2.5 px-4 rounded-xl shadow-md inline-flex items-center gap-2"
                    >
                      <HiOutlineSparkles className={`h-4 w-4 ${improvingCaseId === reviewModalCase.id ? 'animate-spin' : ''}`} />
                      {improvingCaseId === reviewModalCase.id ? 'Upgrading Test Case...' : '✨ Auto-Improve to 5-Star Quality'}
                    </button>
                  </div>

                  {/* 4 Dimension Score Bars */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="rounded-xl border border-app bg-app-surface p-4 shadow-sm">
                      <div className="flex items-center justify-between text-xs font-semibold text-app-primary mb-2">
                        <span>Step Quality & Atomicity</span>
                        <span className="text-indigo-600 font-bold">{reviewModalCase.review_scores?.step_quality?.toFixed(1) || '4.0'} / 5.0</span>
                      </div>
                      <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                          style={{ width: `${((reviewModalCase.review_scores?.step_quality || 4.0) / 5) * 100}%` }}
                        />
                      </div>
                      <p className="text-[11px] text-app-secondary mt-1.5">
                        Evaluates concrete parameters, variants, UI element targets, and absence of over-generalization.
                      </p>
                    </div>

                    <div className="rounded-xl border border-app bg-app-surface p-4 shadow-sm">
                      <div className="flex items-center justify-between text-xs font-semibold text-app-primary mb-2">
                        <span>Data Readiness</span>
                        <span className="text-emerald-600 font-bold">{reviewModalCase.review_scores?.data_readiness?.toFixed(1) || '4.0'} / 5.0</span>
                      </div>
                      <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                          style={{ width: `${((reviewModalCase.review_scores?.data_readiness || 4.0) / 5) * 100}%` }}
                        />
                      </div>
                      <p className="text-[11px] text-app-secondary mt-1.5">
                        Evaluates parameter completeness, synthetic default values, and sensitive data handling.
                      </p>
                    </div>

                    <div className="rounded-xl border border-app bg-app-surface p-4 shadow-sm">
                      <div className="flex items-center justify-between text-xs font-semibold text-app-primary mb-2">
                        <span>Expected Result Clarity</span>
                        <span className="text-blue-600 font-bold">{reviewModalCase.review_scores?.expected_result_clarity?.toFixed(1) || '4.0'} / 5.0</span>
                      </div>
                      <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full transition-all duration-500"
                          style={{ width: `${((reviewModalCase.review_scores?.expected_result_clarity || 4.0) / 5) * 100}%` }}
                        />
                      </div>
                      <p className="text-[11px] text-app-secondary mt-1.5">
                        Evaluates whether each step has an unambiguous, verifiable post-condition for assertions.
                      </p>
                    </div>

                    <div className="rounded-xl border border-app bg-app-surface p-4 shadow-sm">
                      <div className="flex items-center justify-between text-xs font-semibold text-app-primary mb-2">
                        <span>Scenario Coverage</span>
                        <span className="text-purple-600 font-bold">{reviewModalCase.review_scores?.coverage?.toFixed(1) || '4.0'} / 5.0</span>
                      </div>
                      <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-purple-500 rounded-full transition-all duration-500"
                          style={{ width: `${((reviewModalCase.review_scores?.coverage || 4.0) / 5) * 100}%` }}
                        />
                      </div>
                      <p className="text-[11px] text-app-secondary mt-1.5">
                        Evaluates 100% preservation of all positive, negative, and verification aspects from the source.
                      </p>
                    </div>
                  </div>

                  {/* Findings & Suggestions */}
                  <div className="space-y-4">
                    {reviewModalCase.review_findings?.suggestions && reviewModalCase.review_findings.suggestions.length > 0 ? (
                      <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-4">
                        <h4 className="text-xs font-bold uppercase tracking-wider text-indigo-900 mb-2 flex items-center gap-1.5">
                          <span>💡 Actionable Improvement Suggestions</span>
                        </h4>
                        <ul className="space-y-1.5">
                          {reviewModalCase.review_findings.suggestions.map((sug, sIdx) => (
                            <li key={sIdx} className="text-xs text-indigo-950 flex items-start gap-2">
                              <span className="text-indigo-600 font-bold">•</span>
                              <span>{sug}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {reviewModalCase.review_findings?.issues && reviewModalCase.review_findings.issues.length > 0 ? (
                      <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4">
                        <h4 className="text-xs font-bold uppercase tracking-wider text-amber-900 mb-2 flex items-center gap-1.5">
                          <span>⚠️ Identified Quality Gaps</span>
                        </h4>
                        <ul className="space-y-1.5">
                          {reviewModalCase.review_findings.issues.map((iss, iIdx) => (
                            <li key={iIdx} className="text-xs text-amber-950 flex items-start gap-2">
                              <span className="text-amber-600 font-bold">•</span>
                              <span>{iss}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                </>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-app bg-app-surface-muted px-6 py-3.5">
              <button
                type="button"
                onClick={() => handleRunReview(reviewModalCase)}
                disabled={reviewingCaseId === reviewModalCase.id}
                className="app-btn app-btn-secondary inline-flex items-center gap-1.5 text-xs font-semibold"
              >
                <HiOutlineRefresh className={`h-4 w-4 ${reviewingCaseId === reviewModalCase.id ? 'animate-spin' : ''}`} />
                Re-Evaluate Quality
              </button>

              <button
                type="button"
                onClick={() => setReviewModalCase(null)}
                className="app-btn app-btn-primary"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default Workbench
