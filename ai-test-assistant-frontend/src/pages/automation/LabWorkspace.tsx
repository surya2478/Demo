/**
 * --- Automation Lab: one project's workspace (mockups B to B6) -------------------
 *
 * Like /manager-review/:requestId: breadcrumb, bulk actions and keyboard
 * shortcuts on top, the case list on the left with status filters, the chosen
 * case on the right. Script, Latest run and History switch in place; only jobs
 * open popups -- dry run (live), bulk dry run, heal, generate, edit -- and a
 * popup never opens another.
 *
 * /automation/script-lab/:projectId?case=TC-001 lands on a case, and
 * &view=latest&run=KEY on one of its runs, so a notification or an old Runs
 * link arrives where the run is. projectId is the project's id, or "none" for
 * cases approved before projects existed.
 *
 * Batch jobs (bulk dry run, generate) belong to this page, not their popup:
 * closing the popup leaves them going, one case after another, and each row
 * in the list shows where its case got to.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import automationService from '../../services/automationService'
import testDataService, { environmentLabel, readableName, type ScriptDataCheck } from '../../services/testDataService'
import { startDeviceRunner } from '../../services/localRunner'
import TestDataFill from '../../components/automation/TestDataFill'
import LabTestSteps, { stepsNeedingAttention } from '../../components/automation/LabTestSteps'
import useRunPolling from '../../hooks/useRunPolling'
import { useAutomationContext } from '../../components/automation/AutomationContext'
import { useConfirm } from '../../components/ui/ConfirmDialog'
import { readSelectedApplicationId, isTerminal } from '../../types/automation'
import type { FrameworkInfo, RegisteredApplication, RunSummary, ScriptAsset, ScriptLabCase } from '../../types/automation'
import {
  BTN, CARD, CHIP, PRIMARY, CheckIcon, ChevronGlyph, CodeBlock, PlayGlyph, StarGlyph, beforeRunning, caseState, dryRunChip,
  failedLines, needsData, projectKeyOf, readFramework, saveBlob, scriptOf, writeFramework, type CaseState
} from '../../components/automation/labShared'
import {
  DoneDot, EmptyDot, Evidence, FailDot, FailureBox, LiveLog, Pipeline, SpinDot, StepsCard, TONE_CHIP,
  baseId, clock, dayMonth, dayTime, failedStepOf, frameworkLabel, fullStamp, modeLabel, progressOf, resultOf,
  shortDuration, stepRows, toneOf
} from '../../components/automation/labRun'
import { parseServerTime } from '../../components/automation/runPresentation'
import {
  BulkPopup, EditPopup, GeneratePopup, HealPopup, RunPopup, bulkActive, genActive,
  type BulkJob, type BulkSkip, type GenJob, type HealSource
} from '../../components/automation/LabPopups'

type Filter = 'all' | 'failing' | 'running' | 'passed' | 'not_run' | 'test_data' | 'no_script'
type View = 'steps' | 'script' | 'latest' | 'history'
type PopupState =
  | { kind: 'run'; runKey: string }
  | { kind: 'heal'; source: HealSource }
  | { kind: 'bulk' }
  | { kind: 'generate' }
  | { kind: 'edit'; script: ScriptAsset }
  | null

const FILTERS: { key: Filter; label: string; on: string; off: string }[] = [
  { key: 'all', label: 'All', on: 'bg-[#1F2937] text-white', off: 'bg-[#F4F5F7] text-[#374151]' },
  { key: 'failing', label: 'Failing', on: 'bg-[#DC2626] text-white', off: 'bg-[#FEEBEC] text-[#A3231C]' },
  { key: 'running', label: 'Running', on: 'bg-[#2563EB] text-white', off: 'bg-[#EEF4FF] text-[#1D4ED8]' },
  { key: 'passed', label: 'Passed', on: 'bg-[#16A34A] text-white', off: 'bg-[#EAF7EF] text-[#136B34]' },
  { key: 'not_run', label: 'Not run', on: 'bg-[#374151] text-white', off: 'border border-[#E8EAEE] bg-white text-[#374151]' },
  { key: 'test_data', label: 'Test data', on: 'bg-[#D97706] text-white', off: 'bg-[#FFF4E5] text-[#8A5000]' },
  { key: 'no_script', label: 'No script', on: 'bg-[#6B7280] text-white', off: 'border border-dashed border-[#D6D9DF] bg-white text-[#6B7280]' }
]

const matches = (filter: Filter, state: CaseState, testCase: ScriptLabCase) =>
  filter === 'all' ? true : filter === 'test_data' ? needsData(testCase) : filter === state

const typing = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))
}

const PlayCircle = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden><circle cx="12" cy="12" r="8.5" /><path d="M10.5 9l4.5 3-4.5 3z" /></svg>
)
const MonitorGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden><rect x="4" y="3" width="16" height="13" rx="2" /><path d="M8 21h8M12 16v5" /></svg>
)
const RerunGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v4h-4" /></svg>
)
const EditGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
)
const DownGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden><path d="M12 4v11M7 10l5 5 5-5M5 19h14" /></svg>
)
const ICON_BTN = 'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px] border border-[#E8EAEE] bg-white text-[#6B7280] transition hover:border-[#F6D4D5] hover:text-[#B71920] disabled:cursor-not-allowed disabled:opacity-40'
const DEVICE_BTN = 'inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-[10px] border border-[#B71920] bg-white px-3.5 text-[13px] font-bold text-[#B71920] transition hover:bg-[#FFF5F5] disabled:cursor-not-allowed disabled:opacity-50'

/** Headless or headed, for a run on this device -- as the Script Lab and Runs drawer had it. */
const DeviceMode: React.FC<{ headed: boolean; onChange: (headed: boolean) => void; disabled?: boolean; label: string }> = ({ headed, onChange, disabled, label }) => (
  <select
    aria-label={label}
    value={headed ? 'headed' : 'headless'}
    onChange={e => onChange(e.target.value === 'headed')}
    disabled={disabled}
    className="h-9 rounded-[10px] border border-[#E8EAEE] bg-white px-2.5 text-[12.5px] font-semibold text-[#374151] disabled:opacity-50"
  >
    <option value="headless">Headless</option>
    <option value="headed">Headed</option>
  </select>
)

const Kbd: React.FC<{ k: string }> = ({ k }) => (
  <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-[#D6D9DF] bg-white px-1 font-sans text-[10.5px] font-bold text-[#1F2937] shadow-[0_1px_0_#D6D9DF]">{k}</kbd>
)

/** The row's mark: what its last dry run did, or that it has no script. */
const RowMark: React.FC<{ state: CaseState; onWatch?: () => void }> = ({ state, onWatch }) =>
  state === 'passed' ? <DoneDot size={18} />
    : state === 'failing' ? <FailDot size={18} />
      : state === 'running' ? (
        <button type="button" onClick={e => { e.stopPropagation(); onWatch?.() }} title="Watch the run" aria-label="Watch the run"><SpinDot size={18} /></button>
      )
        : <EmptyDot size={18} dashed={state === 'no_script'} />

// --- Latest run, inline (B2) -------------------------------------------------------------

const LatestRunView: React.FC<{ runKey: string; onSettled: () => void }> = ({ runKey, onSettled }) => {
  const { run, loading, error } = useRunPolling(runKey, { onSettled })
  if (!run) return <div className={`px-4 py-6 text-[13px] ${loading ? 'text-[#6B7280]' : 'text-[#A3231C]'}`}>{loading ? 'Loading the run…' : error ?? 'That run could not be found.'}</div>
  const rows = stepRows(run)
  const live = !isTerminal(run.status)
  const tone = toneOf(run)
  const result = resultOf(run)
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <Pipeline run={run} rows={rows} />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <StepsCard rows={rows} />
          {!live && (tone === 'failed' || tone === 'blocked') && <FailureBox run={run} rows={rows} result={result} />}
        </div>
        {live ? <LiveLog run={run} rows={rows} live /> : <Evidence run={run} result={result} />}
      </div>
      <div className="text-[11.5px] text-[#6B7280]">
        {[run.run_key.toUpperCase(), modeLabel(run), run.triggered_by ? `by ${run.triggered_by}` : null, dayTime(run.started_at ?? run.created_at), live ? null : clock(run.duration_seconds)].filter(Boolean).join(' · ')}
      </div>
    </div>
  )
}

// --- History, inline (B5) --------------------------------------------------------------------

const historyChip = (run: RunSummary) => {
  const tone = toneOf(run)
  const step = failedStepOf(run)
  const label =
    tone === 'passed' ? (run.is_healed ? 'Passed · healed' : 'Passed')
      : tone === 'failed' ? (step ? `Failed · step ${step}` : 'Failed')
        : tone === 'blocked' ? (step ? `Blocked · step ${step}` : 'Blocked')
          : tone === 'running' ? 'Running' : tone === 'queued' ? 'Queued' : 'Cancelled'
  return { label, tone: TONE_CHIP[tone] }
}

// --- Page --------------------------------------------------------------------------------------

const LabWorkspace: React.FC = () => {
  const { projectId = 'none' } = useParams<{ projectId: string }>()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const { canExecute, runtime, query } = useAutomationContext()

  const [all, setAll] = useState<ScriptLabCase[]>([])
  const [frameworks, setFrameworks] = useState<FrameworkInfo[]>([])
  const [framework, setFrameworkState] = useState(readFramework)
  const [applications, setApplications] = useState<RegisteredApplication[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [openId, setOpenId] = useState<number | null>(null)
  const [view, setView] = useState<View>(params.get('view') === 'latest' ? 'latest' : params.get('view') === 'history' ? 'history' : params.get('view') === 'steps' ? 'steps' : 'script')
  // Test steps: the step whose lines the Script view marks, and whether its editor is open.
  const [focusStep, setFocusStep] = useState<number | null>(null)
  const [stepsEditing, setStepsEditing] = useState(false)
  const [viewRunKey, setViewRunKey] = useState<string | null>(params.get('run'))
  const [history, setHistory] = useState<RunSummary[]>([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [pickedRuns, setPickedRuns] = useState<Set<string>>(new Set())
  const [dataCheck, setDataCheck] = useState<ScriptDataCheck | null>(null)
  const [popup, setPopup] = useState<PopupState>(null)
  const [bulk, setBulk] = useState<BulkJob | null>(null)
  const [gen, setGen] = useState<GenJob | null>(null)
  const [deviceHeaded, setDeviceHeaded] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const setFramework = (name: string) => { setFrameworkState(name); writeFramework(name) }

  const load = useCallback(async (): Promise<ScriptLabCase[]> => {
    try {
      const [listing, fw] = await Promise.all([automationService.listScriptLabCases(), automationService.listFrameworks()])
      const list = listing.cases ?? []
      setAll(list)
      setFrameworks(fw.frameworks ?? [])
      setError(null)
      return list
    } catch (err: any) {
      setError(err?.message ?? 'The project could not be loaded.')
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const cases = useMemo(() => all.filter(c => projectKeyOf(c) === projectId), [all, projectId])
  const project = cases[0]?.project ?? null
  const projectLabel = project ? `${project.ppm_id} · ${project.name}` : 'No project'
  const projectTitle = project ? `${project.ppm_id} - ${project.name}` : 'No project'
  const approvedAt = cases.reduce<string | null>((min, c) => (c.created_at && (!min || c.created_at < min) ? c.created_at : min), null)
  const approvedBy = cases.find(c => c.created_at === approvedAt)?.created_by ?? cases.find(c => c.created_by)?.created_by ?? null

  const fwInfo = frameworks.find(f => f.name === framework)
  const fwLabel = fwInfo?.label ?? frameworkLabel(framework)
  const runnable = (fwInfo?.runnable ?? framework === 'playwright') && (runtime ? runtime.ready : true)

  const stateOf = useCallback((c: ScriptLabCase) => caseState(c, framework), [framework])
  const searched = useMemo(
    () => (query ? cases.filter(c => [c.tc_display_id, c.title, c.request_id].some(v => String(v ?? '').toLowerCase().includes(query))) : cases),
    [cases, query]
  )
  const visible = useMemo(() => searched.filter(c => matches(filter, stateOf(c), c)), [searched, filter, stateOf])
  const countOf = (f: Filter) => searched.filter(c => matches(f, stateOf(c), c)).length
  const missing = cases.filter(c => !scriptOf(c, framework))

  // Follow dry runs and batch jobs until they settle.
  const anyLive = cases.some(c => stateOf(c) === 'running') || bulkActive(bulk) || genActive(gen)
  useEffect(() => {
    if (!anyLive) return
    const poll = window.setInterval(() => void load(), 3000)
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    return () => { window.clearInterval(poll); window.clearInterval(tick) }
  }, [anyLive, load])

  // ?case=TC-001 picks the case; else the first one.
  const caseParam = params.get('case')
  useEffect(() => {
    if (loading || !cases.length) return
    if (openId !== null && cases.some(c => c.id === openId)) return
    const wanted = caseParam
      ? cases.find(c => c.tc_display_id === caseParam) ?? cases.find(c => baseId(c.tc_display_id) === caseParam) ?? cases.find(c => String(c.id) === caseParam)
      : null
    setOpenId((wanted ?? cases[0]).id)
  }, [loading, cases, caseParam, openId])

  const openCase = cases.find(c => c.id === openId) ?? null
  const openScript = openCase ? scriptOf(openCase, framework) : null
  const openState = openCase ? stateOf(openCase) : 'no_script'

  // "TC-002" in the link, unless two requests in this project both have one.
  const caseRef = useCallback(
    (testCase: ScriptLabCase) => {
      const base = baseId(testCase.tc_display_id)
      return cases.filter(c => baseId(c.tc_display_id) === base).length > 1 ? testCase.tc_display_id : base
    },
    [cases]
  )

  const pick = useCallback((testCase: ScriptLabCase, nextView: View = 'script') => {
    if (stepsEditing && testCase.id !== openId && !window.confirm('Discard your unsaved edits to the test steps?')) return
    setFocusStep(null)
    setOpenId(testCase.id)
    setView(nextView)
    setViewRunKey(null)
    setPickedRuns(new Set())
    const next = new URLSearchParams()
    next.set('case', caseRef(testCase))
    if (nextView !== 'script') next.set('view', nextView)
    setParams(next, { replace: true })
  }, [setParams, caseRef, stepsEditing, openId])

  const switchView = (next: View) => {
    if (stepsEditing && next !== 'steps' && !window.confirm('Discard your unsaved edits to the test steps?')) return
    setFocusStep(null)
    setView(next)
    if (next !== 'latest') setViewRunKey(null)
    setPickedRuns(new Set())
    const p = new URLSearchParams(params)
    p.delete('run')
    if (next === 'script') p.delete('view'); else p.set('view', next)
    setParams(p, { replace: true })
  }

  // The case's runs, newest first: History, and the run Latest run shows.
  const openScriptStatus = openScript?.dry_run_status
  const openScriptKey = openScript?.dry_run_key
  const loadHistory = useCallback(async (caseId: number) => {
    try {
      const res = await automationService.listRuns(100, caseId)
      setHistory((res.runs ?? []).filter(r => r.test_case_id === caseId))
    } catch {
      setHistory([])
    } finally {
      setHistoryLoaded(true)
    }
  }, [])
  useEffect(() => {
    setHistoryLoaded(false)
    setHistory([])
    if (openId === null) return
    void loadHistory(openId)
  }, [openId, loadHistory])
  useEffect(() => {
    if (openId !== null) void loadHistory(openId)
  }, [openScriptStatus, openScriptKey, openId, loadHistory])

  // What the open script needs from Test Data, in its application's environment.
  const openScriptId = openScript?.id ?? null
  const openScriptCode = openScript?.code ?? ''
  useEffect(() => {
    setDataCheck(null)
    if (openScriptId === null) return
    let cancelled = false
    testDataService.check(openScriptId).then(r => { if (!cancelled) setDataCheck(r) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [openScriptId, openScriptCode])

  const environment = openCase?.environment || dataCheck?.environment || null
  const latestKey = viewRunKey ?? history[0]?.run_key ?? null

  // --- Actions --------------------------------------------------------------------------------

  const runAction = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    setNotice(null)
    try {
      await fn()
    } catch (err: any) {
      setError(err?.message ?? `${label} failed.`)
    } finally {
      setBusy(null)
    }
  }

  const dryRun = (script: ScriptAsset) =>
    runAction('dry-run', async () => {
      const res = await automationService.dryRunScripts({ script_ids: [script.id], environment: null, base_url: null, slow_mo_ms: 1000 })
      if (res.refused?.length) throw new Error(`Dry run refused — ${res.refused.map(r => r.reason).join(' · ')}`)
      setPopup({ kind: 'run', runKey: res.queued[0].run_key })
      void load()
    })

  const heal = (testCase: ScriptLabCase, script: ScriptAsset | null, runKey: string | null) =>
    setPopup({ kind: 'heal', source: { caseId: testCase.id, tc: baseId(testCase.tc_display_id), scriptId: script?.id ?? null, runKey, environment } })

  const deviceDryRun = (script: ScriptAsset, headed: boolean) =>
    runAction('device', async () => {
      const res = await automationService.createDeviceDryRun(script.id, !headed)
      try {
        await startDeviceRunner(res.pairing)
      } catch (err) {
        await automationService.cancelRun(res.run_key).catch(() => undefined)
        throw new Error(err instanceof Error && err.message
          ? `${err.message} Start the downloaded device runner, then try again.`
          : 'The local Playwright runner is not available. Start it, then try again.')
      }
      setPopup({ kind: 'run', runKey: res.run_key })
      void load()
    })

  // Rerun on device: the run's own spec, settings and case, run by Playwright on
  // this device -- what the Runs drawer's "Rerun on device" did.
  const rerunOnDevice = (runKey: string, headed: boolean) =>
    runAction('device-rerun', async () => {
      const run = await automationService.getRun(runKey)
      if (!run.spec?.code) throw new Error('This run has no spec to run again.')
      const res = await automationService.createDeviceRun({
        code: run.spec.code,
        environment: run.environment || 'SIT',
        base_url: run.spec.base_url || null,
        file_name: run.spec.file_name || 'spec.ts',
        test_case_id: run.test_case_id ?? null,
        slow_mo_ms: run.slow_mo_ms ?? 1000,
        headless: !headed,
        mode: 'rerun'
      })
      try {
        await startDeviceRunner(res.pairing)
      } catch (err) {
        await automationService.cancelRun(res.run_key).catch(() => undefined)
        throw new Error(err instanceof Error && err.message
          ? `${err.message} Start the device runner, then try again.`
          : 'The local Playwright runner is not available. Start the device runner, then try again.')
      }
      setPopup({ kind: 'run', runKey: res.run_key })
      void load()
      if (openId !== null) void loadHistory(openId)
    })

  /** The project's scripts as one zip -- or only the ticked cases'. */
  const downloadProject = () =>
    runAction('bundle', async () => {
      const ids = selected.size ? Array.from(selected) : cases.map(c => c.id)
      saveBlob(await automationService.downloadScriptBundle(framework, ids), `automation-scripts-${framework}-${project?.ppm_id ?? 'no-project'}.zip`)
    })

  const downloadOne = (script: ScriptAsset) =>
    runAction('download', async () => saveBlob(await automationService.downloadScript(script.id), script.file_name))

  const syncBitbucket = (ids: number[]) =>
    runAction('bitbucket', async () => {
      const result = await automationService.syncScriptsToBitbucket(ids, framework)
      if (!result.synced) throw new Error(result.results.find(item => item.error)?.error || 'None of the scripts could be synced to Bitbucket.')
      setNotice(`${result.synced} script${result.synced === 1 ? '' : 's'} synced to Bitbucket${result.failed ? `; ${result.failed} failed` : ''}.`)
    })

  const deleteCases = async (ids: number[]) => {
    const chosen = cases.filter(c => ids.includes(c.id))
    if (!chosen.length) return
    const ok = await confirm({
      title: chosen.length === 1 ? `Delete ${baseId(chosen[0].tc_display_id)}?` : `Delete ${chosen.length} test cases?`,
      body: chosen.length === 1 ? chosen[0].title : `${chosen.length} test cases will be removed from the Automation Lab.`,
      consequences: [`Every script generated from ${chosen.length === 1 ? 'it' : 'them'} is deleted too.`, 'This cannot be undone.'],
      confirmLabel: chosen.length === 1 ? 'Delete test case' : `Delete ${chosen.length} test cases`
    })
    if (!ok) return
    void runAction('delete', async () => {
      const res = await automationService.deleteWorkbenchCases(ids)
      setSelected(new Set())
      if (openId !== null && ids.includes(openId)) setOpenId(null)
      setNotice(`${res.deleted} test case(s) deleted` + (res.scripts_removed ? `, with ${res.scripts_removed} script(s).` : '.'))
      await load()
    })
  }

  const deleteRuns = async () => {
    const keys = Array.from(pickedRuns)
    if (!keys.length) return
    const ok = await confirm({
      title: keys.length === 1 ? 'Delete this run?' : `Delete ${keys.length} runs?`,
      body: 'Their results and evidence are removed from this host.',
      consequences: ['This cannot be undone.'],
      confirmLabel: keys.length === 1 ? 'Delete run' : `Delete ${keys.length} runs`
    })
    if (!ok) return
    void runAction('delete-runs', async () => {
      await automationService.deleteRuns(keys)
      setPickedRuns(new Set())
      if (viewRunKey && keys.includes(viewRunKey)) setViewRunKey(null)
      if (openId !== null) await loadHistory(openId)
      await load()
    })
  }

  // --- Bulk dry run (B4) ---------------------------------------------------------------------------

  const startBulk = useCallback(async (ids: number[], source: ScriptLabCase[]) => {
    const chosen = source.filter(c => ids.includes(c.id))
    const env = chosen.find(c => c.environment)?.environment ?? null
    setBulk({
      projectLabel,
      title: `Dry run ${chosen.length} selected case${chosen.length === 1 ? '' : 's'}`,
      subtitle: ['One after another on this host', fwLabel, env ? environmentLabel(env) : null, 'Safe / WAF speed'].filter(Boolean).join(' · '),
      items: [],
      skipped: [],
      checking: true
    })
    setPopup({ kind: 'bulk' })
    const items: BulkJob['items'] = []
    const skipped: BulkSkip[] = []
    await Promise.all(chosen.map(async c => {
      const tc = baseId(c.tc_display_id)
      const script = scriptOf(c, framework)
      if (!script) { skipped.push({ caseId: c.id, tc, reason: `no ${fwLabel} script yet`, fix: { label: 'Generate', action: 'generate' } }); return }
      if (!runnable) { skipped.push({ caseId: c.id, tc, reason: `${fwLabel} is generate-only here`, fix: null }); return }
      if (script.static_gate_result && !script.static_gate_result.passed) { skipped.push({ caseId: c.id, tc, reason: 'the static gate failed', fix: { label: 'Edit', action: 'edit' } }); return }
      if (script.dry_run_status === 'running' || script.dry_run_status === 'queued') { skipped.push({ caseId: c.id, tc, reason: 'a dry run is already going', fix: null }); return }
      try {
        const check = await testDataService.check(script.id)
        if (check.missing.length) {
          skipped.push({
            caseId: c.id, tc,
            reason: `test data pending (${check.missing.map(m => m.replace(/^TESTDATA_/, '')).join(', ')} for ${environmentLabel(check.environment)})`,
            fix: { label: 'Fill it in', action: 'data' }
          })
          return
        }
      } catch {
        /* the server checks again when it queues */
      }
      items.push({ caseId: c.id, tc, title: c.title, scriptId: script.id, state: 'queued', runKey: null, detail: null })
    }))
    const order = (id: number) => chosen.findIndex(c => c.id === id)
    items.sort((a, b) => order(a.caseId) - order(b.caseId))
    skipped.sort((a, b) => order(a.caseId) - order(b.caseId))
    setBulk(prev => prev && { ...prev, title: `Dry run ${items.length} selected case${items.length === 1 ? '' : 's'}`, items, skipped, checking: false })
  }, [framework, fwLabel, projectLabel, runnable])

  // One after another: when nothing is running, queue the next.
  const bulkRunning = bulk?.items.find(i => i.state === 'running') ?? null
  const bulkNext = !bulk || bulk.checking || bulkRunning ? null : bulk.items.find(i => i.state === 'queued') ?? null
  const startingRef = useRef(false)
  useEffect(() => {
    if (!bulkNext || startingRef.current) return
    startingRef.current = true
    const item = bulkNext
    automationService
      .dryRunScripts({ script_ids: [item.scriptId], environment: null, base_url: null, slow_mo_ms: 1000 })
      .then(res => {
        const queued = res.queued?.[0]
        setBulk(prev => {
          if (!prev) return prev
          if (!queued) {
            const reason = res.refused?.[0]?.reason ?? 'refused'
            return { ...prev, items: prev.items.filter(i => i.caseId !== item.caseId), skipped: [...prev.skipped, { caseId: item.caseId, tc: item.tc, reason, fix: null }] }
          }
          return { ...prev, items: prev.items.map(i => (i.caseId === item.caseId ? { ...i, state: 'running', runKey: queued.run_key, detail: 'Running' } : i)) }
        })
        void load()
      })
      .catch(err => {
        setBulk(prev => prev && { ...prev, items: prev.items.map(i => (i.caseId === item.caseId ? { ...i, state: 'failed', detail: err?.message ?? 'Could not start' } : i)) })
      })
      .finally(() => { startingRef.current = false })
  }, [bulkNext, load])

  const followed = useRunPolling(bulkRunning?.runKey ?? null)
  const followedRun = followed.run
  useEffect(() => {
    if (!followedRun || !bulkRunning || followedRun.run_key !== bulkRunning.runKey) return
    const progress = progressOf(followedRun)
    if (!isTerminal(followedRun.status)) {
      const detail = progress?.current && progress?.total ? `Running · step ${progress.current} of ${progress.total}` : 'Running'
      if (detail !== bulkRunning.detail) setBulk(prev => prev && { ...prev, items: prev.items.map(i => (i.caseId === bulkRunning.caseId ? { ...i, detail } : i)) })
      return
    }
    const tone = toneOf(followedRun)
    const step = failedStepOf(followedRun)
    const state = tone === 'passed' ? 'passed' : tone === 'cancelled' ? 'cancelled' : 'failed'
    const detail = tone === 'passed' ? 'Passed' : tone === 'cancelled' ? 'Cancelled' : step ? `Failed at step ${step}` : 'Failed'
    setBulk(prev => prev && { ...prev, items: prev.items.map(i => (i.caseId === bulkRunning.caseId ? { ...i, state, detail } : i)) })
    void load()
  }, [followedRun, bulkRunning, load])

  const cancelRemaining = () =>
    setBulk(prev => prev && { ...prev, items: prev.items.map(i => (i.state === 'queued' ? { ...i, state: 'cancelled', detail: 'Cancelled' } : i)) })

  // --- Generate (B6) ---------------------------------------------------------------------------------

  const openGenerate = (only?: ScriptLabCase[]) => {
    if (!gen || !genActive(gen)) {
      const list = only ?? cases
      setGen({
        projectLabel,
        framework,
        applicationId: readSelectedApplicationId(),
        regenerate: Boolean(only && only.every(c => scriptOf(c, framework))),
        started: false,
        items: list.map(c => ({ caseId: c.id, tc: baseId(c.tc_display_id), title: c.title, existing: Boolean(scriptOf(c, framework)), state: 'ready', detail: null, scriptId: null }))
      })
    }
    setPopup({ kind: 'generate' })
    if (!applications.length) {
      automationService.listApplications().then(res => setApplications(res.applications ?? [])).catch(() => undefined)
    }
  }

  const changeGen = (patch: Partial<Pick<GenJob, 'framework' | 'applicationId' | 'regenerate'>>) =>
    setGen(prev => {
      if (!prev) return prev
      const next = { ...prev, ...patch }
      // Another framework: which cases already have a script changes with it.
      if (patch.framework) next.items = prev.items.map(i => {
        const c = cases.find(x => x.id === i.caseId)
        return { ...i, existing: Boolean(c && scriptOf(c, patch.framework!)) }
      })
      return next
    })

  const startGenerate = async () => {
    if (!gen) return
    const job = gen
    const todo = job.items.filter(i => !i.existing || job.regenerate)
    setGen({ ...job, started: true })
    for (const item of todo) {
      setGen(prev => prev && { ...prev, items: prev.items.map(i => (i.caseId === item.caseId ? { ...i, state: 'generating' } : i)) })
      try {
        const res = await automationService.generateScripts({
          case_ids: [item.caseId], framework: job.framework, application_id: job.applicationId, base_url: null, regenerate: item.existing
        })
        const script = res.scripts?.[0]
        const skip = res.skipped?.[0]
        const patch = skip
          ? { state: 'skipped' as const, detail: `Skipped — ${skip.reason}` }
          : !script ? { state: 'error' as const, detail: 'Nothing was generated' }
            : script.static_gate_result && !script.static_gate_result.passed
              ? { state: 'gate_failed' as const, detail: `Static gate failed — ${script.static_gate_result.errors[0] ?? ''}`, scriptId: script.id }
              : { state: 'passed' as const, detail: 'Static gate passed', scriptId: script.id }
        setGen(prev => prev && { ...prev, items: prev.items.map(i => (i.caseId === item.caseId ? { ...i, ...patch } : i)) })
      } catch (err: any) {
        setGen(prev => prev && { ...prev, items: prev.items.map(i => (i.caseId === item.caseId ? { ...i, state: 'error', detail: err?.message ?? 'Failed' } : i)) })
      }
      void load()
    }
    if (job.framework !== framework) setFramework(job.framework)
  }

  const dryRunGenerated = async () => {
    if (!gen) return
    const ids = gen.items.filter(i => i.state === 'passed').map(i => i.caseId)
    const fresh = await load()
    setGen(null)
    void startBulk(ids, fresh)
  }

  // --- Keyboard: D dry run · H heal · E edit · J / K next ---------------------------------------------

  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const keysRef = useRef<(event: KeyboardEvent) => void>(() => undefined)
  keysRef.current = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return
    if (popup || document.querySelector('[aria-modal="true"]')) return
    const key = event.key.toLowerCase()
    const list = visibleRef.current
    const index = openCase ? list.findIndex(c => c.id === openCase.id) : -1
    if (key === 'j' || key === 'k') {
      const next = list[key === 'j' ? Math.min(list.length - 1, index + 1) : Math.max(0, index - 1)]
      if (next) { event.preventDefault(); pick(next, view === 'history' ? 'script' : view) }
    } else if (key === 'd' && openScript && canExecute && runnable && openState !== 'running' && !busy) {
      event.preventDefault(); void dryRun(openScript)
    } else if (key === 'h' && openCase && openScript && canExecute && openState === 'failing') {
      event.preventDefault(); heal(openCase, openScript, view === 'latest' ? latestKey : openScript.dry_run_key)
    } else if (key === 'e' && openScript && canExecute) {
      event.preventDefault(); setPopup({ kind: 'edit', script: openScript })
    }
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keysRef.current(event)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // --- Rendering ---------------------------------------------------------------------------------------

  const allOn = visible.length > 0 && visible.every(c => selected.has(c.id))
  const toggle = (id: number) => setSelected(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const elapsed = (script: ScriptAsset | null) => {
    const at = parseServerTime(script?.dry_run_at)
    return at ? clock((now - at.getTime()) / 1000) : ''
  }

  const chip = dryRunChip(openScript)
  const failing = openState === 'failing'
  const attention = openScript ? stepsNeedingAttention(openScript.code || '') : 0

  // After the Test steps editor saves: the script follows the edited steps,
  // unless someone edited it by hand -- generation refuses to discard that.
  const regenerateAfterEdit = async (testCase: ScriptLabCase, script: ScriptAsset | null) => {
    const ref = baseId(testCase.tc_display_id)
    if (script?.edited_by_user) {
      setNotice(`${ref} saved. Its script was edited by hand, so it was not regenerated.`)
      await load()
      return
    }
    try {
      const res = await automationService.generateScripts({
        case_ids: [testCase.id], framework, application_id: readSelectedApplicationId(), base_url: null, regenerate: Boolean(script)
      })
      const made = res.scripts?.[0]
      const skip = res.skipped?.[0]
      if (skip) setError(`${ref} saved, but the script was not regenerated: ${skip.reason}`)
      else if (made?.static_gate_result && !made.static_gate_result.passed) setError(`${ref} saved; script v${made.version} failed the static gate: ${made.static_gate_result.errors[0] ?? 'see the script'}`)
      else if (made) setNotice(`${ref} saved; script v${made.version} generated and passed the static gate.`)
    } catch (err: any) {
      setError(`${ref} saved, but the script could not be regenerated: ${err?.message ?? 'unknown error'}`)
    }
    await load()
  }
  const latestRun = history.find(r => r.run_key === latestKey) ?? null
  const latestFailed = latestRun ? ['failed', 'blocked'].includes(toneOf(latestRun)) : failing

  if (!loading && !cases.length) {
    return (
      <section className={`${CARD} px-6 py-10 text-center text-[13px] text-[#6B7280]`}>
        {error ?? 'This project has no Automation cases.'}{' '}
        <Link to="/automation/script-lab" className="font-semibold text-[#B71920] hover:underline">Back to the Automation Lab</Link>
      </section>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Breadcrumb, shortcuts and bulk actions */}
      <section className={`${CARD} flex flex-wrap items-center gap-3 px-4 py-3`}>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] leading-[1.5] text-[#6B7280]">
            <Link to="/automation/script-lab" className="font-semibold text-[#B71920] hover:underline">Automation Lab</Link>
            <span className="text-[#9CA3AF]"> / </span>
            <span className="font-bold text-[#B71920]">{projectLabel}</span>
            <span> · {cases.length} case{cases.length === 1 ? '' : 's'}{approvedAt ? ` · approved ${dayMonth(approvedAt)}${approvedBy ? ` by ${approvedBy}` : ''}` : ''}</span>
          </div>
          <h1 className="m-0 mt-0.5 truncate text-[17px] font-extrabold text-[#1F2937]">{projectTitle}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 hidden items-center gap-1 text-[11px] text-[#6B7280] lg:flex">
            <Kbd k="D" /> dry run <Kbd k="H" /> heal <Kbd k="J" /><Kbd k="K" /> next
          </span>
          <Link to={dataCheck?.application ? `/test-data?app=${dataCheck.application.id}` : '/test-data'} className={BTN}>Test Data</Link>
          <span className="relative">
            <select
              value={framework}
              onChange={e => setFramework(e.target.value)}
              aria-label="Framework"
              className="h-9 appearance-none rounded-[10px] border border-[#E8EAEE] bg-white pl-3.5 pr-8 text-[13px] font-semibold text-[#1F2937] outline-none hover:border-[#F6D4D5]"
            >
              {(frameworks.length ? frameworks : [{ name: 'playwright', label: 'Playwright', runnable: true }]).map(fw => <option key={fw.name} value={fw.name}>{fw.label}</option>)}
            </select>
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#1F2937]"><ChevronGlyph /></span>
          </span>
          <button type="button" onClick={() => openGenerate()} disabled={!canExecute} className={BTN}>
            <StarGlyph />
            {genActive(gen) ? 'Generating…' : `Generate ${missing.length} missing`}
          </button>
          <button
            type="button"
            onClick={() => void downloadProject()}
            disabled={busy !== null}
            title={selected.size ? `Download the ${selected.size} selected ${fwLabel} script(s) as one zip` : `Download this project's ${fwLabel} scripts as one zip`}
            aria-label="Download scripts"
            className={ICON_BTN}
          >
            <DownGlyph />
          </button>
          <button
            type="button"
            onClick={() => void syncBitbucket(Array.from(selected))}
            disabled={!selected.size || busy !== null}
            title={!selected.size ? 'Select one or more test cases to sync' : `Sync ${selected.size} selected ${fwLabel} script(s) to their PPM repositories`}
            aria-label="Sync selected scripts to Bitbucket"
            className={ICON_BTN}
          >
            {busy === 'bitbucket' ? (
              <span className="box-border block h-3 w-3 animate-spin rounded-full border-2 border-[#B71920] border-t-transparent" />
            ) : (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden><path d="M7 5h10l-1.2 14H8.2L7 5Z" /><path d="M9.5 8h5l-.5 6h-4l-.5-6ZM5 5h14" /></svg>
            )}
          </button>
          <button
            type="button"
            onClick={() => void deleteCases(Array.from(selected))}
            disabled={!selected.size || !canExecute || busy !== null}
            title="Delete the selected test cases and their scripts"
            aria-label="Delete selected test cases"
            className={`${ICON_BTN} !text-[#B71920]`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
          </button>
          <button
            type="button"
            onClick={() => void startBulk(Array.from(selected), cases)}
            disabled={!selected.size || !canExecute || bulkActive(bulk)}
            title={!selected.size ? 'Tick the cases to dry run' : bulkActive(bulk) ? 'A bulk dry run is already going' : undefined}
            className={PRIMARY}
          >
            <PlayGlyph />
            Dry run {selected.size} selected
          </button>
          {bulk && popup?.kind !== 'bulk' && (
            <button type="button" onClick={() => setPopup({ kind: 'bulk' })} className="text-[12px] font-semibold text-[#1D4ED8] hover:underline">{bulkActive(bulk) ? 'Show progress' : 'Last bulk run'}</button>
          )}
        </div>
      </section>

      {(notice || error || (runtime && !runtime.ready) || (fwInfo && !fwInfo.runnable)) && (
        <div className="flex flex-col gap-2">
          {fwInfo && !fwInfo.runnable && <div className="rounded-[12px] border border-[#EBCFA4] bg-[#FFFBF4] px-3.5 py-2 text-[12.5px] text-[#8A5000]">{fwInfo.label} is generate-only here: scripts can be generated and downloaded, not run.</div>}
          {runtime && !runtime.ready && <div className="rounded-[12px] border border-[#EBCFA4] bg-[#FFFBF4] px-3.5 py-2 text-[12.5px] text-[#8A5000]">The browser runtime is unavailable, so a dry run would be refused.</div>}
          {notice && <div className="rounded-[12px] border border-[#E8EAEE] bg-white px-3.5 py-2 text-[12.5px] text-[#374151]">{notice}</div>}
          {error && <div role="alert" className="rounded-[12px] border border-[#F6D4D5] bg-[#FFF8F8] px-3.5 py-2 text-[12.5px] text-[#7A0B0D]">{error}</div>}
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-[290px_minmax(0,1fr)]">
        {/* Case list */}
        <section className={`${CARD} overflow-hidden`}>
          <div className="flex flex-wrap gap-1 px-3 pb-2.5 pt-3">
            {FILTERS.map(f => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                aria-pressed={filter === f.key}
                className={`${CHIP} h-[20px] gap-0.5 px-[7px] text-[10px] transition ${filter === f.key ? f.on : f.off}`}
              >
                {f.label} {countOf(f.key)}
              </button>
            ))}
          </div>
          <label className="flex h-9 cursor-pointer items-center gap-2.5 border-y border-[#E8EAEE] bg-[#FCFCFD] px-3 text-[11.5px] font-bold text-[#1F2937]">
            <input type="checkbox" aria-label="Select every case shown" checked={allOn} disabled={!visible.length} onChange={() => setSelected(allOn ? new Set() : new Set(visible.map(c => c.id)))} className="h-4 w-4 accent-[#B71920]" />
            {selected.size ? `${selected.size} selected` : 'Select all'}
            {selected.size > 0 && (
              <button type="button" onClick={e => { e.preventDefault(); setSelected(new Set()) }} className="ml-auto text-[11.5px] font-bold text-[#B71920] hover:underline">Clear</button>
            )}
          </label>
          <ul className="app-scroll max-h-[640px] overflow-y-auto">
            {loading ? (
              <li className="px-3 py-6 text-[12.5px] text-[#6B7280]">Loading…</li>
            ) : visible.length === 0 ? (
              <li className="px-3 py-6 text-[12.5px] text-[#6B7280]">No cases match this filter.</li>
            ) : visible.map(c => {
              const script = scriptOf(c, framework)
              const state = stateOf(c)
              const open = c.id === openId
              const time = state === 'running' ? elapsed(script) : script?.dry_run?.duration_seconds != null && (state === 'passed' || state === 'failing') ? shortDuration(script.dry_run.duration_seconds) : '—'
              return (
                <li
                  key={c.id}
                  onClick={() => pick(c, view === 'history' ? 'script' : view)}
                  className={`grid cursor-pointer grid-cols-[18px_minmax(0,1fr)_auto_18px] items-center gap-2.5 border-b border-[#F1F2F4] py-2 pl-3 pr-3 transition ${
                    open ? 'bg-[#FFF5F5] shadow-[inset_3px_0_0_#B71920]' : 'hover:bg-[#FAFAFB]'
                  }`}
                  title={[c.created_by && `Created by ${c.created_by}`, c.created_at && `Created ${fullStamp(c.created_at)}`, `${c.steps} step${c.steps === 1 ? '' : 's'}`, c.request_id && `Request ${c.request_id}`].filter(Boolean).join('\n')}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${baseId(c.tc_display_id)}`}
                    checked={selected.has(c.id)}
                    onClick={e => e.stopPropagation()}
                    onChange={() => toggle(c.id)}
                    className="h-4 w-4 accent-[#B71920]"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="text-[11.5px] font-bold text-[#1F2937]">{baseId(c.tc_display_id)}</span>
                      {script ? <span className="rounded-[4px] bg-[#F4F5F7] px-1 text-[9.5px] font-semibold text-[#374151]">v{script.version}</span> : <span className="rounded-full border border-dashed border-[#D6D9DF] px-1.5 text-[9.5px] text-[#6B7280]">No script</span>}
                      {needsData(c) && <span className="rounded-[4px] bg-[#FFF4E5] px-1 text-[9.5px] font-semibold text-[#8A5000]">Data</span>}
                    </span>
                    <span className="block truncate text-[11px] text-[#6B7280]">{c.title}</span>
                  </span>
                  <span className="text-[11px] tabular-nums text-[#6B7280]">{time}</span>
                  <RowMark state={state} onWatch={() => script?.dry_run_key && setPopup({ kind: 'run', runKey: script.dry_run_key })} />
                </li>
              )
            })}
          </ul>
          <div className="flex items-center justify-between px-3 py-2.5 text-[10.5px] text-[#6B7280]">
            <span>Created by · Created · Steps</span>
            <span>shown in the detail</span>
          </div>
        </section>

        {/* The chosen case */}
        <section className={`${CARD} flex min-w-0 flex-col overflow-hidden`}>
          {!openCase ? (
            <div className="px-6 py-10 text-center text-[13px] text-[#6B7280]">{loading ? 'Loading…' : 'Choose a case on the left.'}</div>
          ) : (
            <>
              <div className="border-b border-[#E8EAEE] px-4 pb-3 pt-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-0.5 text-[11.5px] font-bold text-[#B71920]">{baseId(openCase.tc_display_id)}</span>
                  <span className={`${CHIP} h-[22px] px-2 text-[10.5px] ${chip.tone}`}>{chip.label}</span>
                  {openScript && <span className={`${CHIP} h-[22px] border border-[#E8EAEE] bg-white px-2 text-[10.5px] text-[#1F2937]`}>{fwLabel} v{openScript.version}</span>}
                  <span className={`${CHIP} h-[22px] border border-[#E8EAEE] bg-white px-2 text-[10.5px] text-[#1F2937]`}>{openCase.steps} step{openCase.steps === 1 ? '' : 's'}</span>
                  {environment && <span className={`${CHIP} h-[22px] border border-[#E8EAEE] bg-white px-2 text-[10.5px] text-[#1F2937]`}>runs on {environmentLabel(environment)}</span>}
                  {needsData(openCase) && <span className={`${CHIP} h-[22px] bg-[#FFF4E5] px-2 text-[10.5px] text-[#8A5000]`}>Test data pending</span>}
                  <div className="ml-auto flex items-center rounded-[10px] bg-[#F4F5F7] p-[3px]" role="tablist" aria-label="Case view">
                    {([['steps', 'Test steps'], ['script', 'Script'], ['latest', 'Latest run'], ['history', 'History']] as const).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        role="tab"
                        aria-selected={view === key}
                        onClick={() => switchView(key)}
                        className={`h-[26px] rounded-[8px] px-2.5 text-[11.5px] font-semibold transition ${view === key ? 'bg-white text-[#1F2937] shadow-[0_1px_2px_rgba(16,24,40,0.12)]' : 'text-[#6B7280] hover:text-[#1F2937]'}`}
                      >
                        {label}
                        {key === 'steps' && attention > 0 && <span className="rounded-full bg-[#FFF4E5] px-1.5 text-[10px] font-bold text-[#8A5000]" title="Steps whose element was guessed or not found">{attention}</span>}
                      </button>
                    ))}
                  </div>
                </div>
                <h2 className="m-0 mt-2 text-[15px] font-bold leading-[1.35] text-[#1F2937]">{openCase.title}</h2>
                <div className="mt-0.5 truncate text-[11.5px] text-[#6B7280]">
                  {[openCase.created_by ? `Created by ${openCase.created_by}` : null, openCase.created_at ? `Created ${fullStamp(openCase.created_at)}` : null, openScript?.file_name].filter(Boolean).join(' · ')}
                </div>
              </div>

              {/* Script (B) */}
              {view === 'script' && (
                !openScript ? (
                  <div className="px-6 py-12 text-center">
                    <div className="text-[14px] font-bold text-[#1F2937]">{baseId(openCase.tc_display_id)} has no {fwLabel} script yet</div>
                    <p className="mt-1 text-[12.5px] text-[#6B7280]">Generate it; the static gate checks it before anything runs.</p>
                  </div>
                ) : (
                  <>
                    <div className="px-4 py-3">
                      <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#6B7280]">Before running</div>
                      <ul className="flex flex-col gap-1.5">
                        {beforeRunning(openScript).map((check, i) => (
                          <li key={i} className="flex items-start gap-2 text-[12.5px] text-[#1F2937]"><CheckIcon tone={check.tone} /><span className="leading-[1.4]">{check.text}</span></li>
                        ))}
                        {dataCheck && dataCheck.needed.length > 0 && dataCheck.missing.length === 0 && (
                          <li className="flex items-start gap-2 text-[12.5px] text-[#1F2937]">
                            <CheckIcon tone="ok" />
                            <span className="leading-[1.4]">
                              {dataCheck.needed.length} test data value{dataCheck.needed.length === 1 ? '' : 's'} found for {environmentLabel(dataCheck.environment)}{dataCheck.application ? ` in ${dataCheck.application.name}` : ''}
                            </span>
                          </li>
                        )}
                      </ul>
                      {/* Missing values: filled in here, saved to Test Data. */}
                      {dataCheck && dataCheck.missing.length > 0 && (
                        <div className="mt-2.5">
                          <TestDataFill
                            check={dataCheck}
                            canExecute={canExecute}
                            onSaved={() => {
                              setNotice('Saved to Test Data. The script was checked again.')
                              testDataService.check(openScript.id).then(setDataCheck).catch(() => undefined)
                              void load()
                            }}
                          />
                        </div>
                      )}
                    </div>
                    <CodeBlock code={openScript.code || ''} highlight={focusStep ? failedLines(openScript.code || '', focusStep) : openState === 'failing' ? failedLines(openScript.code || '', openScript.dry_run?.failed_step) : new Set()} className="max-h-[460px] min-h-[260px]" />
                  </>
                )
              )}

              {/* Test steps: step -> test data -> element -> check, and editing them */}
              {view === 'steps' && (
                <LabTestSteps
                  key={openCase.id}
                  caseId={openCase.id}
                  script={openScript}
                  canExecute={canExecute}
                  applicationId={readSelectedApplicationId()}
                  onJump={(step) => { switchView('script'); setFocusStep(step) }}
                  onEditingChange={setStepsEditing}
                  onSaved={() => regenerateAfterEdit(openCase, openScript)}
                />
              )}

              {/* Latest run (B2) */}
              {view === 'latest' && (
                latestKey ? (
                  <LatestRunView key={latestKey} runKey={latestKey} onSettled={() => { void load(); if (openId !== null) void loadHistory(openId) }} />
                ) : (
                  <div className="px-6 py-12 text-center text-[13px] text-[#6B7280]">{historyLoaded ? `${baseId(openCase.tc_display_id)} has not been dry run yet.` : 'Loading…'}</div>
                )
              )}

              {/* History (B5) */}
              {view === 'history' && (
                <div className="px-4 py-3">
                  {!historyLoaded ? (
                    <div className="py-6 text-[13px] text-[#6B7280]">Loading…</div>
                  ) : history.length === 0 ? (
                    <div className="py-6 text-center text-[13px] text-[#6B7280]">No runs of this case yet.</div>
                  ) : (
                    <ol className="overflow-hidden rounded-[12px] border border-[#E8EAEE]">
                      {history.map(run => {
                        const tone = toneOf(run)
                        const hc = historyChip(run)
                        const ticked = pickedRuns.has(run.run_key)
                        return (
                          <li
                            key={run.run_key}
                            onClick={() => { setViewRunKey(run.run_key); setView('latest'); const p = new URLSearchParams(params); p.set('view', 'latest'); p.set('run', run.run_key); setParams(p, { replace: true }) }}
                            className="group grid cursor-pointer grid-cols-[20px_minmax(0,1fr)_minmax(130px,0.6fr)_100px_50px] items-center gap-3 border-b border-[#F1F2F4] px-3 py-2.5 last:border-b-0 hover:bg-[#FAFAFB]"
                          >
                            <span className="relative flex h-5 w-5 items-center justify-center">
                              {canExecute && (
                                <input
                                  type="checkbox"
                                  aria-label={`Select ${run.run_key}`}
                                  checked={ticked}
                                  onClick={e => e.stopPropagation()}
                                  onChange={() => setPickedRuns(prev => { const next = new Set(prev); if (next.has(run.run_key)) next.delete(run.run_key); else next.add(run.run_key); return next })}
                                  className={`absolute h-4 w-4 accent-[#B71920] ${ticked || pickedRuns.size ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                                />
                              )}
                              <span className={ticked || pickedRuns.size ? 'invisible' : 'group-hover:invisible'}>
                                {tone === 'passed' ? <DoneDot size={18} /> : tone === 'running' || tone === 'queued' ? <SpinDot size={18} /> : tone === 'cancelled' ? <EmptyDot size={18} /> : <FailDot size={18} />}
                              </span>
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate font-mono text-[11.5px] font-bold text-[#1F2937]">{run.run_key}</span>
                              <span className="block truncate text-[11px] text-[#6B7280]">{[modeLabel(run), run.script_version ? `v${run.script_version}` : null, run.triggered_by].filter(Boolean).join(' · ')}</span>
                            </span>
                            <span className={`${CHIP} h-[22px] w-full rounded-[6px] px-2 text-[10.5px] ${hc.tone}`}>{hc.label}</span>
                            <span className="text-[11.5px] tabular-nums text-[#374151]">{dayTime(run.started_at ?? run.created_at)}</span>
                            <span className="text-right text-[12px] font-bold tabular-nums text-[#1F2937]">{isTerminal(run.status) ? clock(run.duration_seconds) : '—'}</span>
                          </li>
                        )
                      })}
                    </ol>
                  )}
                  <p className="mt-2 text-[11.5px] text-[#6B7280]">Opening a row shows it in Latest run. Tick runs to delete them; the evidence goes with them.</p>
                </div>
              )}

              {/* Action bar: Edit and Download, where the last dry run got to, then
                  the runs -- on this host or on this device, headless or headed --
                  and the AI fix, as the Script Lab drawer and Runs drawer had them. */}
              {!(view === 'steps' && stepsEditing) && <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-[#E8EAEE] px-4 py-3">
                <button type="button" onClick={() => openScript && setPopup({ kind: 'edit', script: openScript })} disabled={!openScript || !canExecute || busy !== null} title="Edit the script" className={BTN}><EditGlyph />Edit</button>
                <button type="button" onClick={() => openScript && void downloadOne(openScript)} disabled={!openScript || busy !== null} title="Download the script" className={BTN}>
                  <DownGlyph />{busy === 'download' ? 'Downloading…' : 'Download'}
                </button>
                {view === 'script' && openScript ? (
                  <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-[#6B7280]">
                    <PlayCircle />
                    {openScript.dry_run && (openScript.dry_run_status === 'running' || openScript.dry_run_status === 'queued') ? (
                      <>Dry run in progress · <button type="button" onClick={() => setPopup({ kind: 'run', runKey: openScript.dry_run!.run_key })} className="font-semibold text-[#B71920] hover:underline">Watch it</button></>
                    ) : openScript.dry_run ? (
                      <>
                        {openScript.dry_run_status === 'passed' ? 'Last dry run passed' : openScript.dry_run.failed_step ? `Last dry run failed at step ${openScript.dry_run.failed_step}` : 'Last dry run failed'}
                        {openScript.dry_run.duration_seconds != null ? ` · ${clock(openScript.dry_run.duration_seconds)}` : ''} ·{' '}
                        <button type="button" onClick={() => { switchView('latest'); setViewRunKey(openScript.dry_run!.run_key) }} className="font-semibold text-[#B71920] hover:underline">Open evidence</button>
                      </>
                    ) : (
                      <span>Not dry-run yet.</span>
                    )}
                  </span>
                ) : (
                  <span className="text-[11.5px] text-[#6B7280]">Actions open in a popup; the list stays where it is.</span>
                )}
                <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                  {!openScript ? (
                    <button type="button" onClick={() => openGenerate([openCase])} disabled={!canExecute} className={PRIMARY}><StarGlyph />Generate</button>
                  ) : view === 'latest' && latestKey ? (
                    <>
                      <button type="button" onClick={() => void dryRun(openScript)} disabled={!canExecute || !runnable || openState === 'running' || busy !== null} title="Run the script again on this host" className={BTN}>
                        <RerunGlyph />{busy === 'dry-run' ? 'Queueing…' : 'Rerun'}
                      </button>
                      <DeviceMode headed={deviceHeaded} onChange={setDeviceHeaded} disabled={busy !== null} label="Rerun on device browser mode" />
                      <button
                        type="button"
                        onClick={() => void rerunOnDevice(latestKey, deviceHeaded)}
                        disabled={!canExecute || busy !== null}
                        title={`Run this run's spec again ${deviceHeaded ? 'with a visible browser' : 'headlessly'} using Playwright on this device`}
                        className={BTN}
                      >
                        <MonitorGlyph />{busy === 'device-rerun' ? 'Connecting…' : 'Rerun on device'}
                      </button>
                      {latestFailed && (
                        <button type="button" onClick={() => heal(openCase, openScript, latestKey)} disabled={!canExecute || openState === 'running' || busy !== null} className={PRIMARY}><StarGlyph />Heal &amp; rerun</button>
                      )}
                    </>
                  ) : (
                    <>
                      {view === 'history' && pickedRuns.size > 0 && (
                        <button type="button" onClick={() => void deleteRuns()} disabled={busy !== null} className={`${BTN} !text-[#B71920]`}>Delete {pickedRuns.size} run{pickedRuns.size === 1 ? '' : 's'}</button>
                      )}
                      {view === 'script' && failing && (
                        <button type="button" onClick={() => heal(openCase, openScript, openScript.dry_run_key)} disabled={!canExecute || busy !== null} className={PRIMARY}><StarGlyph />Heal with AI</button>
                      )}
                      <button
                        type="button"
                        onClick={() => void dryRun(openScript)}
                        disabled={!canExecute || !runnable || openState === 'running' || busy !== null}
                        title={!runnable ? `${fwLabel} is generate-only — no runner exists for it.` : 'Run the script once on this host'}
                        className={view === 'script' && failing ? BTN : PRIMARY}
                      >
                        <PlayCircle />{busy === 'dry-run' ? 'Queueing…' : 'Dry run'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void deviceDryRun(openScript, deviceHeaded)}
                        disabled={!canExecute || !runnable || openState === 'running' || busy !== null}
                        title={!runnable ? `${fwLabel} is generate-only — no runner exists for it.` : `Run ${deviceHeaded ? 'with a visible browser' : 'headlessly'} using Playwright installed on this device; the server only coordinates the run`}
                        className={DEVICE_BTN}
                      >
                        <MonitorGlyph />{busy === 'device' ? 'Connecting…' : 'Run on device'}
                      </button>
                      <DeviceMode headed={deviceHeaded} onChange={setDeviceHeaded} disabled={busy !== null} label="Run on device browser mode" />
                    </>
                  )}
                </div>
              </div>}
            </>
          )}
        </section>
      </div>

      {/* Popups */}
      {popup?.kind === 'run' && (
        <RunPopup
          runKey={popup.runKey}
          projectLabel={projectLabel}
          canExecute={canExecute}
          onChanged={() => { void load(); if (openId !== null) void loadHistory(openId) }}
          onMinimise={() => setPopup(null)}
          onClose={settled => {
            setPopup(null)
            if (!settled) return
            const run = popup.runKey
            const owner = all.find(c => c.scripts.some(s => s.dry_run_key === run)) ?? openCase
            if (owner) { pick(owner, 'latest'); setViewRunKey(run) }
          }}
        />
      )}
      {popup?.kind === 'heal' && (
        <HealPopup
          source={popup.source}
          canExecute={canExecute}
          onDiscard={() => setPopup(null)}
          onSaved={() => void load()}
          onRunning={runKey => { setPopup({ kind: 'run', runKey }); void load(); if (openId !== null) void loadHistory(openId) }}
        />
      )}
      {popup?.kind === 'bulk' && bulk && (
        <BulkPopup
          job={bulk}
          onClose={() => setPopup(null)}
          onCancelRemaining={cancelRemaining}
          onOpen={caseId => { const c = cases.find(x => x.id === caseId); setPopup(null); if (c) pick(c, 'latest') }}
          onWatch={runKey => setPopup({ kind: 'run', runKey })}
          onFix={skip => {
            const c = cases.find(x => x.id === skip.caseId)
            if (!c) return
            if (skip.fix?.action === 'generate') openGenerate([c])
            else if (skip.fix?.action === 'data') { setPopup(null); pick(c, 'script') }
            else if (skip.fix?.action === 'edit') { const s = scriptOf(c, framework); pick(c); if (s) setPopup({ kind: 'edit', script: s }) }
          }}
        />
      )}
      {popup?.kind === 'generate' && gen && (
        <GeneratePopup
          job={gen}
          frameworks={frameworks}
          applications={applications}
          canExecute={canExecute}
          onChange={changeGen}
          onStart={() => void startGenerate()}
          onClose={() => { setPopup(null); if (gen.started && !genActive(gen)) setGen(null) }}
          onDryRun={() => void dryRunGenerated()}
        />
      )}
      {popup?.kind === 'edit' && (
        <EditPopup
          title={`Edit script · ${baseId(popup.script.test_case_display_id ?? '')}`}
          fileName={popup.script.file_name}
          version={popup.script.version}
          code={popup.script.code || ''}
          canExecute={canExecute}
          onClose={() => setPopup(null)}
          onSave={async code => { await automationService.editScript(popup.script.id, code); setPopup(null); await load() }}
        />
      )}
    </div>
  )
}

export default LabWorkspace

/** /automation/runs/:runKey, from before the Runs page was retired: to the case it ran. */
export const RunRedirect: React.FC = () => {
  const { runKey } = useParams<{ runKey: string }>()
  const navigate = useNavigate()
  useEffect(() => {
    if (!runKey) { navigate('/automation/script-lab', { replace: true }); return }
    let cancelled = false
    const go = async () => {
      try {
        const [run, listing] = await Promise.all([automationService.getRun(runKey), automationService.listScriptLabCases()])
        if (cancelled) return
        const testCase = (listing.cases ?? []).find(c => c.id === run.test_case_id)
        if (!testCase) { navigate(`/automation/script-lab?run=${encodeURIComponent(runKey)}`, { replace: true }); return }
        navigate(`/automation/script-lab/${projectKeyOf(testCase)}?case=${encodeURIComponent(testCase.tc_display_id)}&view=latest&run=${encodeURIComponent(runKey)}`, { replace: true })
      } catch {
        if (!cancelled) navigate(`/automation/script-lab?run=${encodeURIComponent(runKey)}`, { replace: true })
      }
    }
    void go()
    return () => { cancelled = true }
  }, [runKey, navigate])
  return <div className={`${CARD} px-6 py-8 text-[13px] text-[#6B7280]`}>Opening the run…</div>
}
