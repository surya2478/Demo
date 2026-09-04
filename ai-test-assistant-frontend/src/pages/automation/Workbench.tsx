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
  HiOutlineCheck,
  HiOutlineX,
  HiOutlineExclamationCircle,
  HiOutlineCursorClick,
  HiOutlineEye,
  HiOutlineStar,
  HiOutlineShieldCheck,
  HiOutlineClipboardCheck
} from 'react-icons/hi'
import automationService from '../../services/automationService'
import { useAutomationContext } from '../../components/automation/AutomationContext'
import SectionCard from '../../components/ui/SectionCard'
import EmptyState from '../../components/ui/EmptyState'
import LoadingSkeleton from '../../components/ui/LoadingSkeleton'
import StatusBadge from '../../components/ui/StatusBadge'
import { useToast } from '../../components/ui/Toast'
import { useConfirm } from '../../components/ui/ConfirmDialog'
import MenuButton from '../../components/ui/MenuButton'
import TestCaseEditor from '../../components/automation/TestCaseEditor'
import ClassifyProgressModal from '../../components/automation/ClassifyProgressModal'
import WorkbenchCaseDrawer from '../../components/automation/WorkbenchCaseDrawer'
import type { ClassifyProgressStatus } from '../../components/automation/ClassifyProgressModal'
// Hidden on request -- restore together with the element below.
// import DocumentIntake from '../../components/automation/DocumentIntake'
import { GroundingBadge } from '../../components/automation/groundingPresentation'
import { formatWhen } from '../../components/automation/runPresentation'
import {
  ApprovalBadge,
  ClassificationBadge,
  ClassificationReportPanel,
  JobProgress,
  StatTile
} from '../../components/automation/workbenchPresentation'
import { isJobSettled } from '../../types/automation'
import type {
  Classification,
  ClassificationReport,
  GenerationJob,
  RecordedFlowObject,
  WorkbenchCase,
  WorkbenchCounts,
  WorkbenchSource
} from '../../types/automation'

const EMPTY_COUNTS: WorkbenchCounts = {
  total: 0,
  automation: 0,
  partial: 0,
  manual: 0,
  undecided: 0,
  approved: 0,
  rejected: 0,
  needs_data: 0
}

const ENVIRONMENTS = ['SIT', 'UAT', 'QA', 'DEV']



/**
 * Hidden for now, not deleted.
 *
 * The tiles still compute correctly and the data behind them is still fetched,
 * so this is one line to put back when the row is wanted again -- which is why
 * it is a flag rather than a commented-out block or a deletion.
 */
const SHOW_STAT_TILES = false

/** `busy` holds the runAction label; these are what a person should read. */
const BUSY_LABELS: Record<string, string> = {
  classify: 'Classifying',
  approve: 'Approving',
  delete: 'Deleting test cases',
  'delete-sources': 'Deleting test cases',
  generate: 'Generating',
  reopen: 'Reopening'
}

/** How each outcome is named in a notice — the same words as the badge. */
const CLASSIFICATION_NOUNS: Record<Classification, string> = {
  automation: 'Automation',
  partial: 'needing minor changes',
  manual: 'Manual',
  undecided: 'still unclassified'
}

const Workbench: React.FC = () => {
  const { canExecute } = useAutomationContext()

  const [sources, setSources] = useState<WorkbenchSource[]>([])
  const [cases, setCases] = useState<WorkbenchCase[]>([])
  const [counts, setCounts] = useState<WorkbenchCounts>(EMPTY_COUNTS)
  const [loading, setLoading] = useState(true)
  /*
   * `notice` and `error` used to render as banners nailed inside this card,
   * below a toolbar the user has usually scrolled past by the time a job
   * finishes -- and the success banner rendered in warning orange, so a good
   * result and a problem looked alike. Both now surface as toasts.
   *
   * Keeping the setter names means the ~25 existing call sites report to the
   * right place without being rewritten, and `setError(null)` stays the no-op
   * clear it always was.
   */
  const toast = useToast()
  const confirm = useConfirm()
  const setNotice = useCallback(
    (message: string | null, detail?: string) => {
      if (message) toast.success(message, detail)
    },
    [toast]
  )
  const setError = useCallback(
    (message: string | null, detail?: string) => {
      if (message) toast.error(message, detail)
    },
    [toast]
  )
  /** Partial success: the batch ran, but not every case came through it. */
  const setWarning = useCallback(
    (message: string, detail?: string) => toast.warning(message, detail),
    [toast]
  )

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

  // Which case's rule report is open. Held as the case rather than the report
  // so a reclassify while the panel is open replaces what it shows.
  const [reportCaseId, setReportCaseId] = useState<number | null>(null)

  // The row drawer. An id, not the case, so a save or a reclassify behind it
  // shows the new findings instead of the ones that were open when it opened.
  const [drawerCaseId, setDrawerCaseId] = useState<number | null>(null)
  const [drawerSaving, setDrawerSaving] = useState(false)
  const [drawerError, setDrawerError] = useState<string | null>(null)

  /*
   * The rule pass runs behind one POST, so this is the only place a person can
   * see it happening. Held as one object rather than five useStates because
   * every field changes together, at exactly two moments: the click, and the
   * response.
   */
  const [classifyProgress, setClassifyProgress] = useState<{
    open: boolean
    status: ClassifyProgressStatus
    total: number
    startedAt: number | null
    updated?: number
    counts?: Partial<Record<Classification, number>>
    reports?: ClassificationReport[]
    error?: string | null
  }>({ open: false, status: 'running', total: 0, startedAt: null })

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
      const requested = selectedCases.size
      const res = await automationService.refineBulkTestCases(
        Array.from(selectedCases),
        applicationUrl.trim() || undefined
      )
      await load()
      const missed = requested - res.refined_count
      if (missed > 0) {
        setWarning(
          `Refined ${res.refined_count} of ${requested} test cases`,
          `${missed} came back unchanged. Open one to see what the refiner could not resolve.`
        )
      } else {
        setNotice(
          `Refined ${res.refined_count} test case${res.refined_count === 1 ? '' : 's'}`
        )
      }
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

  /**
   * Delete refined cases outright, scripts and all.
   *
   * Both entry points -- the toolbar button and the per-row trash icon -- come
   * through here so they cannot disagree about what a delete does or whether
   * it asks first. Neither used to ask, while the Sources tab beside them
   * always has, so the more destructive of the two paths was the quieter one:
   * this removes the case from Automation Studio and every script generated
   * from it, and nothing brings either back.
   */
  const handleDeleteCases = async (caseToDelete?: WorkbenchCase) => {
    const toDelete = caseToDelete
      ? [caseToDelete]
      : cases.filter(testCase => selectedCases.has(testCase.id))
    if (toDelete.length === 0) return

    const count = toDelete.length
    const ok = await confirm({
      title: count === 1 ? `Delete ${toDelete[0].tc_display_id}?` : `Delete ${count} test cases?`,
      body:
        count === 1
          ? toDelete[0].title
          : `${count} selected test cases will be removed from Automation Studio.`,
      consequences: [
        `Every script generated from ${count === 1 ? 'it' : 'them'} is deleted too.`,
        // The tombstone is the surprising half: without saying so, people
        // expect a re-sync from Review & Approval to bring the case back.
        `${count === 1 ? 'It' : 'They'} will not reappear when the workbench next syncs from Review & Approval.`,
        'This cannot be undone.'
      ],
      confirmLabel: count === 1 ? 'Delete test case' : `Delete ${count} test cases`
    })
    if (!ok) return

    void runAction('delete', async () => {
      const res = await automationService.deleteWorkbenchCases(
        toDelete.map(testCase => testCase.id)
      )
      if (!caseToDelete) setSelectedCases(new Set())
      setNotice(
        `Deleted ${res.deleted} test case${res.deleted === 1 ? '' : 's'}`,
        res.scripts_removed
          ? `${res.scripts_removed} generated script${
              res.scripts_removed === 1 ? '' : 's'
            } removed with them.`
          : undefined
      )
    })
  }

  const handleDeleteSources = async (sourceToDelete?: WorkbenchSource) => {
    const toDelete = sourceToDelete
      ? [sourceToDelete]
      : sources.filter(source => selectedSources.has(source.id))
    if (toDelete.length === 0) return

    const count = toDelete.length
    const refined = toDelete.filter(source => source.refined_test_case_id).length

    /*
     * This prompt used to read "Are you sure you want to delete N test
     * cases?" -- in front of a call that deletes the approved test case rows
     * themselves, then cascades to every refined case linked to them and
     * every script generated from those. The quietest dialog in the app was
     * guarding its most destructive action; all of it is named now.
     */
    const ok = await confirm({
      title:
        count === 1
          ? `Delete approved test case ${toDelete[0].tc_display_id}?`
          : `Delete ${count} approved test cases?`,
      body:
        count === 1
          ? toDelete[0].title
          : `${count} selected test cases will be deleted.`,
      consequences: [
        `This deletes the approved test ${
          count === 1 ? 'case itself' : 'cases themselves'
        }, not just ${count === 1 ? 'its' : 'their'} entry in Automation Studio.`,
        ...(refined > 0
          ? [
              `${
                refined === 1
                  ? '1 of these has already been refined — that refined case'
                  : `${refined} of these have already been refined — those refined cases`
              } and every script generated from ${
                refined === 1 ? 'it' : 'them'
              } are deleted too.`
            ]
          : []),
        'This cannot be undone.'
      ],
      confirmLabel: count === 1 ? 'Delete test case' : `Delete ${count} test cases`
    })
    if (!ok) return

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

  /**
   * Omit `classification` to classify by the automation rules; pass one to
   * override by hand. Both report the same way -- a bulk classification that
   * silently changed nothing used to look exactly like one that worked.
   */
  const handleClassify = (classification?: Classification) => {
    // Only the rule pass gets the window: a hand override is one field write
    // that has already happened by the time a modal could finish opening.
    const byRule = !classification
    if (byRule) {
      setClassifyProgress({
        open: true,
        status: 'running',
        total: selectedCases.size,
        startedAt: Date.now(),
        error: null
      })
    }
    return runAction('classify', async () => {
      let res: Awaited<ReturnType<typeof automationService.classifyCases>>
      try {
        res = await automationService.classifyCases(Array.from(selectedCases), classification)
      } catch (err: any) {
        if (byRule) {
          setClassifyProgress(prev => ({
            ...prev,
            status: 'error',
            error: err?.message ?? 'The classification pass could not be completed.'
          }))
        }
        throw err
      }
      const noun = res.updated === 1 ? 'test case' : 'test cases'
      if (byRule) {
        setClassifyProgress(prev => ({
          ...prev,
          status: 'done',
          updated: res.updated,
          counts: res.counts,
          // A case whose verdict was overridden by hand carries no report, so
          // confidence is averaged over the ones the rules actually wrote.
          reports: (res.test_cases ?? [])
            .map(testCase => testCase.classification_report)
            .filter((report): report is ClassificationReport => report !== null)
        }))
      }
      if (classification) {
        setNotice(`Set ${res.updated} ${noun} to ${CLASSIFICATION_NOUNS[classification]}`)
        return
      }
      // A rule pass now has three possible outcomes, so the count alone hides
      // the answer someone ran it for. Broken out per outcome, in the order
      // they matter to whoever is about to approve them.
      const breakdown = (['automation', 'partial', 'manual', 'undecided'] as Classification[])
        .filter(key => res.counts?.[key])
        .map(key => `${res.counts?.[key]} ${CLASSIFICATION_NOUNS[key]}`)
        .join(' · ')
      setNotice(
        breakdown
          ? `Checked ${res.updated} ${noun}: ${breakdown}`
          : `Classified ${res.updated} ${noun} by rule`
      )
    })
  }

  const handleApprove = () =>
    runAction('approve', async () => {
      const requested = selectedCases.size
      const res = await automationService.decideCases(Array.from(selectedCases), 'approve')
      setSelectedCases(new Set())
      const verb = 'Approved'
      if (res.refused?.length) {
        // Named, not counted: "3 refused" leaves someone hunting for which.
        setWarning(
          `${verb} ${res.updated} of ${requested} — ${res.refused.length} refused`,
          res.refused.map(r => `${r.display_id}: ${r.reason}`).join(' · ')
        )
      } else {
        // A silent success is why people used to reload the page to check.
        setNotice(`${verb} ${res.updated} test case${res.updated === 1 ? '' : 's'}`)
      }
    })

  /*
   * --- One table, two groups ---------------------------------------------
   *
   * What still needs a decision on top, what is settled underneath. Done by
   * ordering the rows and emitting a band where the group changes, rather than
   * rendering two <table>s: a second table has its own column widths, so the
   * two would drift out of alignment the moment their content differed, and
   * the pinned first and last columns would have to be solved twice.
   *
   * Settled means no decision is outstanding. Rejection is a decision, so a
   * rejected case belongs below whatever its classification says -- nobody is
   * going to classify a case that has already been turned down, and leaving it
   * in the top group would make the work queue read longer than it is.
   */
  const isSettled = (testCase: WorkbenchCase) =>
    testCase.approval_status === 'rejected' ||
    (testCase.classification !== 'undecided' && testCase.approval_status === 'approved')

  const visibleCases = useMemo(
    () => (filter === 'all' ? cases : cases.filter(c => c.classification === filter)),
    [cases, filter]
  )

  /** The group a row belongs to -- what its band's checkbox selects. */
  const groupOf = (testCase: WorkbenchCase) =>
    isSettled(testCase) ? groupedCases.settled : groupedCases.pending

  /*
   * Adds or removes one group without touching the other, so a selection made
   * in the pending band survives a select-all in the settled one.
   */
  const toggleGroup = (group: WorkbenchCase[], checked: boolean) =>
    setSelectedCases(prev => {
      const next = new Set(prev)
      group.forEach(testCase => (checked ? next.add(testCase.id) : next.delete(testCase.id)))
      return next
    })

  const groupedCases = useMemo(() => {
    const pending = visibleCases.filter(testCase => !isSettled(testCase))
    const settled = visibleCases.filter(isSettled)
    return { pending, settled, rows: [...pending, ...settled] }
  }, [visibleCases])

  // Looked up from the list rather than held in state, so a reclassify while
  // the dialog is open shows the new findings instead of the ones that led
  // someone to reclassify.
  const reportCase = useMemo(
    () => (reportCaseId === null ? null : cases.find(c => c.id === reportCaseId) ?? null),
    [cases, reportCaseId]
  )

  const drawerCase = useMemo(
    () => (drawerCaseId === null ? null : cases.find(c => c.id === drawerCaseId) ?? null),
    [cases, drawerCaseId]
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

  /*
   * --- Why the toolbar is grey ------------------------------------------
   *
   * Nine controls in the card header disable together, on three different
   * conditions, and none of them said which. People found the rule by ticking
   * a checkbox to see what would happen. This names the blocker in the same
   * order the buttons test it: permission first, then a run in flight, then
   * an empty selection. Null means nothing is blocking, and the bar shows the
   * selection count instead.
   */
  const busyLabel = refining
    ? 'Refining test cases'
    : reviewingAll
      ? 'Reviewing quality'
      : busy
        ? BUSY_LABELS[busy] ?? 'Working'
        : null

  /*
   * The idle "Select test cases to..." line is gone by request: with the
   * toolbar directly above it, it restated what the greyed-out buttons
   * already imply, on every visit. What is left is the two things a person
   * cannot work out by looking -- that their role forbids the action, or that
   * a batch is still running -- plus the selection count once there is one.
   * When there is none of that to say, the bar does not render at all.
   */
  const toolbarBlocker = !canExecute
    ? 'Your role can review these test cases but not change them, so the actions above stay disabled.'
    : busyLabel
      ? `${busyLabel}… the actions above unlock when it finishes.`
      : null

  return (
    <div className="space-y-3">
      {SHOW_STAT_TILES && (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <StatTile label="Test cases" value={loading ? '—' : counts.total} />
        <StatTile label="Automation" value={loading ? '—' : counts.automation} />
        <StatTile
          label="Needs minor changes"
          value={loading ? '—' : counts.partial ?? 0}
          hint={counts.partial ? 'Automatable after the listed edits' : undefined}
        />
        <StatTile label="Manual" value={loading ? '—' : counts.manual} />
        <StatTile label="Approved" value={loading ? '—' : counts.approved} tone="success" />
        <StatTile
          label="Awaiting test data"
          value={loading ? '—' : counts.needs_data}
          tone={counts.needs_data ? 'warning' : 'default'}
          hint={counts.needs_data ? 'Blocks approval' : undefined}
        />
      </div>
      )}

      {/* ── Document intake ────────────────────────────────────────────── */}
      {/*
        The second way in. Test cases read out of an uploaded document land in
        the same table the panel below reads, so `load` is all that is needed
        to make them appear -- there is no separate intake list to reconcile.
      */}
      {/* Hidden on request. Restore by uncommenting this line and its import. */}
      {/* <DocumentIntake onCasesHarvested={() => void load()} /> */}

      {/* ── Test Cases Workbench ────────────────────────────────────────── */}
      {/*
       * No card title: the hero already says "AI Test Automation Studio" and
       * the active tab says "Automation Workspace", so a third name for the
       * same screen was costing a band of vertical space to repeat itself.
       *
       * The toolbar is one left-aligned row rather than scope-left /
       * actions-right -- `justify-between` opened a wide void in the middle at
       * laptop width, which read as a missing control rather than as spacing.
       * A divider separates scope from actions instead.
       */}
      <SectionCard noPadding>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-app px-5 py-3">
          {/* scope -- what the batch is aimed at */}
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={applicationUrl}
              onChange={e => setApplicationUrl(e.target.value)}
              placeholder="Target URL: https://..."
              className="app-input h-8 w-40 py-0 text-xs"
              title="Grounding application URL for test cases & refinement"
            />
            <select
              value={filter}
              onChange={e => setFilter(e.target.value as 'all' | Classification)}
              className="app-input h-8 w-[150px] py-0 text-xs"
              aria-label="Filter by classification"
            >
              <option value="all">All classifications</option>
              <option value="automation">Automation</option>
              <option value="partial">Needs minor changes</option>
              <option value="manual">Manual</option>
              <option value="undecided">Unclassified</option>
            </select>

            {/*
              The rule pass sits beside the filter rather than in the Manual
              Classify menu: it is the one classification action a person runs
              on purpose, and burying the automatic verdict inside a menu of
              hand overrides made it look like a fourth override.
            */}
            <button
              type="button"
              onClick={() => void handleClassify()}
              disabled={!anySelected || !canExecute || busy !== null}
              title={
                anySelected
                  ? 'Classify the selected test cases by rule -- steps, channel, Knowledge Base and test data'
                  : 'Select test cases to classify them by rule'
              }
              className="app-btn app-btn-secondary inline-flex items-center gap-1.5 !px-2.5 border-app-brand-200 text-xs font-semibold text-app-brand-700 hover:bg-app-brand-75 hover:text-app-brand-800"
            >
              <HiOutlineSparkles
                className={`h-4 w-4 ${busy === 'classify' ? 'animate-spin' : ''}`}
              />
              AI Classify
            </button>
          </div>

          {/*
           * Reject and Delete are back as their own buttons, by request. Only
           * the three classification verbs stay collapsed -- they are one
           * choice, so one control -- which is what keeps the row on a single
           * line at laptop width with the destructive pair visible.
           */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-l border-app pl-2">
            <button
              type="button"
              onClick={handleRefineBulk}
              disabled={!anySelected || !canExecute || refining}
              title="Refine selected test cases with AI on-demand"
              className="app-btn app-btn-primary inline-flex items-center gap-1.5 !px-2.5 text-xs font-semibold"
            >
              <HiOutlineSparkles className={`h-4 w-4 ${refining ? 'animate-spin' : ''}`} />
              {refining ? 'Refining...' : 'AI Refine'}
            </button>

            <button
              type="button"
              onClick={handleRunReviewAll}
              disabled={!canExecute || reviewingAll || cases.length === 0}
              title="Evaluate quality across all test cases using the eSMART Review Agent"
              className="app-btn app-btn-secondary inline-flex items-center gap-1.5 !px-2.5 text-xs font-medium"
            >
              <HiOutlineShieldCheck className={`h-4 w-4 ${reviewingAll ? 'animate-spin' : ''}`} />
              {reviewingAll ? 'Reviewing...' : 'Review Quality'}
            </button>

            <MenuButton
              label="Manual Classify"
              className="app-btn app-btn-secondary !px-2.5 text-xs font-medium"
              title="Override the classification of the selected test cases by hand"
              disabled={!anySelected || !canExecute || busy !== null}
              actions={[
                {
                  label: 'Set Automation',
                  detail: 'Override the rules by hand',
                  onSelect: () => void handleClassify('automation')
                },
                {
                  label: 'Set Needs minor changes',
                  detail: 'Override the rules by hand',
                  onSelect: () => void handleClassify('partial')
                },
                {
                  label: 'Set Manual',
                  detail: 'Override the rules by hand',
                  onSelect: () => void handleClassify('manual')
                }
              ]}
            />

            <button
              type="button"
              onClick={handleApprove}
              disabled={!anySelected || !canExecute || busy !== null}
              title="Approve the selected test cases for the Script Lab"
              className="app-btn app-btn-secondary inline-flex items-center gap-1 !px-2.5 text-xs font-medium"
            >
              {/* Tone on the glyph, not the whole button: a green fill here
                  read as a second primary and competed with AI Refine. */}
              <HiOutlineCheck className="h-4 w-4 text-app-success" />
              Approve
            </button>

            {/* risk -- still set apart by a divider and danger-toned text, so
                the irreversible verb does not read like the rest. Reject went
                with the approval flow that used to send cases back from here. */}
            <div className="flex items-center gap-1 border-l border-app pl-2">
              <button
                type="button"
                onClick={() => void handleDeleteCases()}
                disabled={!anySelected || !canExecute || busy !== null}
                title="Delete the selected test cases and any scripts generated from them"
                className="app-btn app-btn-ghost inline-flex items-center gap-1 !px-2.5 text-xs font-medium text-app-danger hover:bg-app-danger-bg hover:text-app-danger"
              >
                <HiOutlineTrash className="h-4 w-4" />
                Delete
              </button>
              <button
                type="button"
                onClick={() => void load()}
                className="app-btn app-btn-ghost"
                title="Reload the workbench"
                aria-label="Reload the workbench"
              >
                <HiOutlineRefresh className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
        {toolbarBlocker || anySelected ? (
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-app bg-app-surface-subtle px-5 py-2.5">
            {toolbarBlocker ? (
              <p
                className={`text-[12px] ${
                  !canExecute ? 'text-app-warning' : 'text-app-secondary'
                }`}
              >
                {toolbarBlocker}
              </p>
            ) : (
              <p className="text-[12px] font-medium text-app-primary">
                {selectedCases.size} test case{selectedCases.size === 1 ? '' : 's'} selected
              </p>
            )}
            {anySelected ? (
              <button
                type="button"
                onClick={() => setSelectedCases(new Set())}
                className="app-btn app-btn-ghost !py-1 text-[12px] font-medium"
              >
                Clear selection
              </button>
            ) : null}
          </div>
        ) : null}

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
                  {/* Checkbox and ID share one pinned cell: they are the same
                      question -- which row is this -- and merging them buys
                      back a column's worth of gutters. */}
                  {/* No select-all here: it selected across both groups at
                      once, which is never what someone acting on one of them
                      wants. Each band carries its own instead. */}
                  <th className="app-table-pin-start text-center">TC ID</th>
                  {/* Every heading is centred over its column. The two pinned
                      columns centre their contents too, because their headings
                      have to line up with a checkbox column and a button group
                      rather than with text. */}
                  <th className="text-center">Title</th>
                  <th className="text-center">Steps</th>
                  <th className="text-center">Classification</th>
                  <th className="text-center">Status</th>
                  <th className="text-center">Added</th>
                  <th className="app-table-pin-end text-center">Actions</th>
                </tr>
              </thead>
              <tbody>
                {groupedCases.rows.map((testCase, index) => (
                  <React.Fragment key={testCase.id}>
                    {/* A band only where the group actually changes, so a grid
                        that is entirely one or the other shows one heading and
                        not an empty section. */}
                    {index === 0 || isSettled(groupedCases.rows[index - 1]) !== isSettled(testCase) ? (
                      /*
                       * One cell across the whole row, with the checkbox and
                       * the heading in a flex. Splitting them into two cells
                       * put the heading at the start of the Title column,
                       * leaving a column's width of dead space after the
                       * checkbox it belongs to.
                       *
                       * A plain block comment: this is the ternary's expression
                       * slot, where a JSX container would be a syntax error.
                       */
                      <tr className="bg-app-surface-muted">
                        <td colSpan={7} className="border-b border-app bg-app-surface-muted px-3 py-2">
                          <div className="flex items-center gap-2.5">
                            <input
                              type="checkbox"
                              checked={groupOf(testCase).length > 0 && groupOf(testCase).every(c => selectedCases.has(c.id))}
                              onChange={event => toggleGroup(groupOf(testCase), event.target.checked)}
                              className="h-3.5 w-3.5 flex-shrink-0"
                              aria-label={
                                isSettled(testCase)
                                  ? 'Select every approved or rejected test case'
                                  : 'Select every test case awaiting classification or approval'
                              }
                            />
                            <span
                              className={`text-[13px] font-bold uppercase tracking-[0.08em] ${
                                isSettled(testCase) ? 'text-emerald-600' : 'text-app-brand-600'
                              }`}
                            >
                              {isSettled(testCase)
                                ? `Approved or rejected (${groupedCases.settled.length})`
                                : `Awaiting classification or approval (${groupedCases.pending.length})`}
                            </span>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                    {/*
                      * The whole row opens the drawer. The guard is one line
                      * rather than a stopPropagation on each of the dozen
                      * controls inside a row -- a new button in a cell would
                      * otherwise open the drawer as a side effect of being added.
                      *
                      * In an expression slot, not a bare /* *\/ block: inside
                      * the Fragment this is JSX children, where a bare comment
                      * renders as literal text on every row.
                      */}
                    <tr
                    key={testCase.id}
                    onClick={event => {
                      if ((event.target as HTMLElement).closest('button, input, a, select, textarea')) {
                        return
                      }
                      setDrawerError(null)
                      setDrawerCaseId(testCase.id)
                    }}
                    className="cursor-pointer transition hover:bg-app-surface-muted/60"
                    title={`Open ${testCase.tc_display_id}`}
                  >
                    <td className="app-table-pin-start">
                      <div className="flex items-center gap-2.5">
                        <input
                          type="checkbox"
                          checked={selectedCases.has(testCase.id)}
                          onChange={() => setSelectedCases(prev => toggle(prev, testCase.id))}
                          className="h-3.5 w-3.5 flex-shrink-0"
                          aria-label={`Select ${testCase.tc_display_id}`}
                        />
                        <span className="flex-1 whitespace-nowrap text-center font-mono text-app-primary">
                          {testCase.tc_display_id}
                          {testCase.version > 1 ? (
                            <span className="ml-1 text-app-secondary">v{testCase.version}</span>
                          ) : null}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="min-w-[240px] max-w-[340px]">
                        <p className="font-medium text-app-primary">{testCase.title}</p>
                        {testCase.objective && testCase.objective !== testCase.title ? (
                          <p className="mt-0.5 truncate text-[12px] text-app-secondary">
                            {testCase.objective}
                          </p>
                        ) : null}
                        {testCase.application_url ? (
                          <p className="mt-0.5 truncate text-[12px] text-app-secondary/70">
                            {testCase.application_url}
                          </p>
                        ) : (
                          /* Blank is a real state, not a rendering gap: a case the
                             Knowledge Base does not cover carries no URL, and script
                             generation refuses it. Say so here rather than at the
                             point of failure. */
                          <p className="mt-0.5 truncate text-[12px] font-medium text-amber-600">
                            Application URL required before script generation
                          </p>
                        )}
                        {/* Rehomed when the Origin column went: this warns that
                            regenerating would build a second case rather than
                            replace this one, which is about the case, not about
                            where it came from. */}
                        {testCase.source_missing ? (
                          <p
                            className="mt-0.5 text-[12px] leading-4 text-app-warning"
                            title="Generating again would build a second test case alongside this one unless you tick Regenerate existing."
                          >
                            Source deleted
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
                              <span className="ml-0.5 uppercase opacity-75">
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
                    <td className="text-app-secondary">{testCase.steps.length}</td>
                    <td>
                      <ClassificationBadge classification={testCase.classification} />
                      {testCase.classification_reason ? (
                        <p className="mt-0.5 max-w-[170px] text-[12px] leading-4 text-app-secondary">
                          {testCase.classification_reason}
                        </p>
                      ) : null}
                      {/*
                        * The badge carries one sentence; the report carries the
                        * step, the channel and the missing locator behind it.
                        * Only offered where there is one -- a hand-set
                        * classification has no findings to show.
                        */}
                      {testCase.classification_report ? (
                        <button
                          type="button"
                          onClick={() => setReportCaseId(testCase.id)}
                          className="mt-1 inline-flex items-center gap-1 rounded-full border border-app px-2 py-0.5 text-[11px] font-medium text-app-secondary transition hover:border-app-brand-600 hover:text-app-brand-600"
                          title="What the rules checked, and what they found"
                        >
                          <HiOutlineClipboardCheck className="h-3 w-3" />
                          {(testCase.classification_report.counts.blockers +
                            testCase.classification_report.counts.fixables) > 0
                            ? `${
                                testCase.classification_report.counts.blockers +
                                testCase.classification_report.counts.fixables
                              } finding(s)`
                            : 'Why?'}
                        </button>
                      ) : null}
                    </td>
                    <td>
                      <ApprovalBadge status={testCase.approval_status} />
                    </td>
                    {/* When it landed here. The grid is sorted on this, so the
                        column is what makes that order legible. */}
                    <td className="whitespace-nowrap text-[12px] text-app-secondary">
                      {formatWhen(testCase.created_at)}
                    </td>
                    <td className="app-table-pin-end text-center">
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
                          onClick={() => void handleDeleteCases(testCase)}
                          disabled={!canExecute || busy !== null}
                          className="rounded-md p-1.5 text-app-secondary transition hover:bg-app-danger-bg hover:text-app-danger disabled:opacity-40"
                          title={`Delete ${testCase.tc_display_id}`}
                        >
                          <HiOutlineTrash className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                  </React.Fragment>
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

      {/*
        * The rule report. A dialog rather than an expanding row: the findings
        * run to a paragraph each, and pushing the grid apart by that much made
        * the batch under review impossible to scan.
        */}
      {reportCase ? (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
          onClick={e => {
            if (e.target === e.currentTarget) setReportCaseId(null)
          }}
          role="dialog"
          aria-modal="true"
        >
          <div className="flex max-h-[88vh] w-full max-w-[820px] flex-col overflow-hidden rounded-[24px] border border-app bg-app-surface shadow-[0_28px_70px_rgba(15,23,42,0.22)]">
            <div className="flex items-start justify-between gap-3 border-b border-app bg-app-surface-muted px-6 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-app-brand-600/10 text-app-brand-600">
                    <HiOutlineClipboardCheck className="h-5 w-5" />
                  </span>
                  <h2 className="truncate text-[16px] font-bold text-app-primary">
                    Automation assessment · {reportCase.tc_display_id}
                  </h2>
                </div>
                <p className="mt-1 text-xs text-app-secondary">
                  Rules only — every step, the channel it runs on, what the knowledge base
                  knows about its controls, and whether its test data exists.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReportCaseId(null)}
                className="rounded-md p-1.5 text-app-secondary transition hover:bg-app-surface hover:text-app-primary"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="app-scroll flex-1 overflow-y-auto px-6 py-5">
              {reportCase.classification_report ? (
                <ClassificationReportPanel report={reportCase.classification_report} />
              ) : (
                <p className="text-[13px] text-app-secondary">
                  This case has no rule report — its classification was set by hand.
                  Classify it by rule to see the findings.
                </p>
              )}
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

      <WorkbenchCaseDrawer
        testCase={drawerCase}
        saving={drawerSaving}
        error={drawerError}
        canExecute={canExecute}
        onClose={() => setDrawerCaseId(null)}
        onSave={async steps => {
          if (!drawerCase) return
          setDrawerSaving(true)
          setDrawerError(null)
          try {
            await automationService.editWorkbenchCase(drawerCase.id, {
              steps_structured: steps
            })
            await load()
            setNotice(`Saved steps on ${drawerCase.tc_display_id}`)
          } catch (err: any) {
            setDrawerError(err?.message ?? 'The step edits could not be saved.')
          } finally {
            setDrawerSaving(false)
          }
        }}
      />

      {/* The rule pass, narrated. Rendered last so it sits over the grid. */}
      <ClassifyProgressModal
        open={classifyProgress.open}
        status={classifyProgress.status}
        total={classifyProgress.total}
        startedAt={classifyProgress.startedAt}
        updated={classifyProgress.updated}
        counts={classifyProgress.counts}
        reports={classifyProgress.reports}
        error={classifyProgress.error}
        canApprove={canExecute && busy === null && selectedCases.size > 0}
        onApprove={() => {
          setClassifyProgress(prev => ({ ...prev, open: false }))
          void handleApprove()
        }}
        onClose={() => setClassifyProgress(prev => ({ ...prev, open: false }))}
      />
    </div>
  )
}

export default Workbench
