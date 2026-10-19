/**
 * --- Automation Script Lab (screen 6) -------------------------------------
 *
 * Manager-approved Automation cases across the whole page; a case opens in a
 * drawer on the right with Heal with AI, Dry run, edit and download first,
 * then what its last dry run did, what the static gate and the Knowledge Base
 * said before it ran, and the code. Up / down step through the list from there.
 *
 * The working set is only cases that are both approved AND classified
 * Automation: generating from anything else produces a script nobody agreed
 * should exist. A dry run IS an ordinary run, so its evidence lives on the Runs
 * tab and "Open evidence" goes there.
 *
 * Katalon and Appium are generate-only: no runner exists for them here or
 * upstream, and the header chip says so.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import automationService from '../../services/automationService'
import { getLocalRunnerStatus, startDeviceRunner, type LocalRunnerStatus } from '../../services/localRunner'
import { useAutomationContext } from '../../components/automation/AutomationContext'
import { useConfirm } from '../../components/ui/ConfirmDialog'
import SideDrawer, { DrawerNav } from '../../components/automation/SideDrawer'
import { OutcomeBar, ProjectBadge, StatusMark, type MarkTone } from '../../components/automation/listPresentation'
import JourneyCrawlStage from '../../components/knowledge-base/JourneyCrawlStage'
import { Evidence } from './Runs'
import { readSelectedApplicationId } from '../../types/automation'
import testDataService, { environmentLabel, isSecretVariable, keyForVariable, readableName, type DataApp, type EntryInput, type ScriptDataCheck } from '../../services/testDataService'
import knowledgeBaseService from '../../services/knowledgeBaseService'
import { useAuth } from '../../hooks/useAuth'
import { useRunPolling } from '../../hooks/useRunPolling'
import type { DryRunBrief, ExecutionQueueState, FrameworkInfo, RegisteredApplication, RunDetail, ScriptAsset, ScriptLabCase, ScriptLocatorAudit } from '../../types/automation'

const CARD = 'rounded-[20px] border border-[#E8EAEE] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]'
const CHIP = 'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12.5px] font-semibold'
const ICON_BTN = 'flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[12px] border border-[#E8EAEE] bg-white text-[#6B7280] transition hover:border-[#F6D4D5] hover:text-[#B71920] disabled:cursor-not-allowed disabled:opacity-40'
const ROW = 'grid grid-cols-[24px_28px_88px_minmax(240px,1fr)_100px_130px_150px_44px_70px] items-center gap-3 px-4'

interface DeviceQueue {
  id: string
  scriptIds: number[]
  cursor: number
  runKey: string | null
  passed: number
  failed: number
  skipped: number
  paused: boolean
  stopped: boolean
  headed: boolean
  nextAt: number
  startFailures?: { scriptId: number; message: string }[]
}

const deviceQueueKey = 'automation-studio.device-queue'


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

/** "TC-001 (#606123)" -> "TC-001": the request is its own column. */
const baseId = (displayId: string) => displayId.replace(/\s*\(#[^)]*\)\s*$/, '')

const clock = (seconds: number | null | undefined) => {
  if (seconds == null) return ''
  const s = Math.max(0, Math.round(seconds))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

const stamp = (iso: string | null | undefined) => {
  if (!iso) return ''
  const date = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`)
  return date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
}

/** "07 Oct 2026, 14:05" in Dubai time; the server writes UTC without a zone. */
const fullStamp = (iso: string | null | undefined) => {
  if (!iso) return ''
  const date = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date)
}

const briefOf = (script: ScriptAsset): DryRunBrief | null => script.dry_run ?? null

type LiveStep = { n: number; title?: string | null; ok?: boolean; error?: string | null }
type LiveProgress = { total?: number | null; current?: number | null; title?: string | null; history?: LiveStep[] | null }

const executionStepTitles = (code: string): string[] => {
  const titles: string[] = []
  const pattern = /test\.step\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(code))) titles.push(match[2].replace(/\\(.)/g, '$1').replace(/^\s*\d+[.)]\s*/, '').trim())
  return titles
}

const ExecutionProgress: React.FC<{ run: RunDetail; scriptCode: string }> = ({ run, scriptCode }) => {
  const metadata = run.run_metadata ?? {}
  const progress = (metadata.step_progress ?? {}) as LiveProgress
  const titles = executionStepTitles(run.spec?.code ?? scriptCode)
  const history = new Map((progress.history ?? []).map(step => [step.n, step]))
  const total = Math.max(progress.total ?? 0, titles.length, ...Array.from(history.keys()), 0)
  const current = progress.current ?? 0
  const finished = run.status !== 'queued' && run.status !== 'running'
  const completed = Array.from(history.values()).filter(step => step.ok !== false).length
  const percent = total ? Math.round(100 * Math.min(total, completed) / total) : 0
  const liveLog = typeof metadata.live_log === 'string' ? metadata.live_log : ''
  return <>
    <div className="rounded-[14px] border border-[#DCE5F2] bg-[#F8FBFF] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${finished ? run.status === 'completed' ? 'bg-[#15803D]' : 'bg-[#DC2626]' : 'animate-pulse bg-[#2563EB]'}`} />
        <span className="text-[13px] font-bold text-[#1F2937]">{finished ? 'Execution finished' : run.status === 'queued' ? 'Waiting in queue' : 'Execution in progress'}</span>
        <span className="ml-auto text-[12px] font-semibold text-[#53657A]">{completed} of {total || '—'} steps complete</span>
      </div>
      <div className="mt-1 text-[12px] text-[#53657A]">{metadata.execution_phase || metadata.device_agent?.message || (run.status === 'queued' ? 'The runner will start this case when its turn arrives.' : progress.title || 'Waiting for the next update from the runner.')}</div>
      {total > 0 && <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#DCE5F2]" role="progressbar" aria-valuenow={completed} aria-valuemax={total} aria-label="Completed test steps"><div className="h-full rounded-full bg-[#2563EB] transition-all" style={{ width: `${percent}%` }} /></div>}
    </div>
    {total > 0 && <div className="overflow-hidden rounded-[14px] border border-[#E8EAEE]" aria-label="Execution steps">
      <div className="border-b border-[#E8EAEE] bg-[#F4F5F7] px-3 py-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#6B7280]">Steps</div>
      {Array.from({ length: total }, (_, index) => {
        const n = index + 1
        const step = history.get(n)
        const state = step ? step.ok === false ? 'Failed' : 'Done' : !finished && current === n ? 'Running' : 'Pending'
        const title = titles[index] || step?.title || (current === n ? progress.title : null) || `Step ${n}`
        return <div key={n} className="flex items-start gap-3 border-b border-[#F0F1F3] px-3 py-2.5 last:border-0">
          <span className="w-5 flex-shrink-0 text-[11px] font-bold text-[#9CA3AF]">{n}</span>
          <span className="min-w-0 flex-1 text-[12.5px] text-[#1F2937]">{title}{step?.error && <span className="mt-1 block break-words text-[#A3231C]">{step.error}</span>}</span>
          <span className={`text-[11.5px] font-bold ${state === 'Done' ? 'text-[#15803D]' : state === 'Failed' ? 'text-[#B71920]' : state === 'Running' ? 'text-[#1D4ED8]' : 'text-[#9CA3AF]'}`}>{state}</span>
        </div>
      })}
    </div>}
    {liveLog && !finished && <details className="rounded-[14px] border border-[#E8EAEE] p-3" open><summary className="cursor-pointer text-[12.5px] font-bold text-[#1F2937]">Live runner log</summary><pre className="app-scroll mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-[10px] bg-[#1B1B1F] p-3 font-mono text-[11px] text-white">{liveLog}</pre></details>}
  </>
}

const failureExplanation = (message: string | null | undefined) => {
  if (!message) return null
  if (/SyntaxError:[\s\S]*Invalid left-hand side in assignment expression/.test(message) && /await\s+\[data-test=/.test(message))
    return 'The generated script treated a CSS selector as JavaScript instead of a Playwright locator. The browser did not reach the test page. Newly generated scripts are corrected automatically; run this case again to repair its saved generated script.'
  if (/SyntaxError|does not parse|unterminated string/i.test(message))
    return 'The test script has a code syntax error, so Playwright could not start the test. Open Code to inspect the line shown below, correct it, then run again.'
  if (/timed? out|TimeoutError/i.test(message))
    return 'The test waited for a page or element longer than allowed. Check the target page, test data and locator, then retry.'
  return null
}

// --- What the script says before it runs ------------------------------------

/** Each `await test.step(` opens one step; returns the lines of each block. */
const stepBlocks = (code: string): { start: number; end: number }[] => {
  const lines = code.split('\n')
  // Only real step calls: helper comments above the test mention test.step() too.
  const starts = lines.map((line, i) => (/^\s*await test\.step\(/.test(line) ? i : -1)).filter(i => i >= 0)
  return starts.map((start, index) => ({ start, end: (starts[index + 1] ?? lines.length) - 1 }))
}

type Check = { tone: 'ok' | 'warn' | 'bad'; text: React.ReactNode }

const beforeRunning = (script: ScriptAsset): Check[] => {
  const checks: Check[] = []
  const gate = script.static_gate_result
  if (gate) {
    checks.push(
      gate.passed
        ? { tone: 'ok', text: 'Basic code checks passed' }
        : { tone: 'bad', text: `Static gate failed — ${gate.errors[0] ?? 'see the script'}${gate.errors.length > 1 ? ` (+${gate.errors.length - 1} more)` : ''}` }
    )
  }
  const blocks = stepBlocks(script.code || '')
  const lines = (script.code || '').split('\n')
  const todoSteps = blocks
    .map((block, index) => (lines.slice(block.start, block.end + 1).some(line => line.includes('<<TODO')) ? index + 1 : 0))
    .filter(Boolean)
  if (todoSteps.length) {
    checks.push({
      tone: 'warn',
      text: (
        <>
          {todoSteps.length === 1 ? `Step ${todoSteps[0]} still has a ` : `Steps ${todoSteps.join(', ')} still have a `}
          <code className="rounded bg-[#F4F5F7] px-1 font-mono text-[12px]">{'<<TODO>>'}</code> test data value
        </>
      )
    })
  }
  return checks
}

const CheckIcon: React.FC<{ tone: Check['tone'] }> = ({ tone }) =>
  tone === 'ok' ? (
    <span className="flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full bg-[#15803D]">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" aria-hidden><path d="M5 12l5 5 9-10" /></svg>
    </span>
  ) : tone === 'warn' ? (
    <span className="flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full bg-[#D97706] text-[11px] font-extrabold text-white">!</span>
  ) : (
    <span className="flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full bg-[#DC2626]">
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
    </span>
  )

// --- Status chips -------------------------------------------------------------

const Spinner: React.FC<{ color?: string }> = ({ color = '#1D4ED8' }) => (
  <span className="box-border h-3 w-3 flex-shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" style={{ color }} />
)

const ScriptStatus: React.FC<{ script: ScriptAsset }> = ({ script }) => {
  const status = script.dry_run_status
  const kind = script.dry_run?.execution_target === 'device' ? 'Device run' : 'Dry run'
  if (status === 'passed') {
    return (
      <span className={`${CHIP} bg-[#EAF7EF] text-[#136B34]`}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" aria-hidden><path d="M5 12l5 5 9-10" /></svg>
        {kind} passed
      </span>
    )
  }
  if (status === 'failed') return <span className={`${CHIP} bg-[#FEEBEC] text-[#A3231C]`}>{kind} failed</span>
  if (status === 'running' || status === 'queued') {
    return (
      <span className={`${CHIP} bg-[#EEF4FF] text-[#1D4ED8]`}>
        <Spinner />
        {status === 'running' ? `${kind} running` : `${kind} queued`}
      </span>
    )
  }
  if (status === 'blocked') return <span className={`${CHIP} bg-[#FFF4E5] text-[#8A5000]`}>{kind} blocked</span>
  if (script.static_gate_result && !script.static_gate_result.passed) {
    return <span className={`${CHIP} bg-[#FFF4E5] text-[#8A5000]`}>Static gate failed</span>
  }
  return <span className={`${CHIP} bg-[#F4F5F7] text-[#374151]`}>Not run</span>
}

const PanelStatus: React.FC<{ script: ScriptAsset }> = ({ script }) => {
  const status = script.dry_run_status
  const kind = script.dry_run?.execution_target === 'device' ? 'Device run' : 'Dry run'
  const tone =
    status === 'passed' ? 'bg-[#EAF7EF] text-[#136B34]'
      : status === 'failed' ? 'bg-[#FEEBEC] text-[#A3231C]'
        : status === 'running' || status === 'queued' ? 'bg-[#EEF4FF] text-[#1D4ED8]'
          : status === 'blocked' || (script.static_gate_result && !script.static_gate_result.passed) ? 'bg-[#FFF4E5] text-[#8A5000]'
            : 'bg-[#F4F5F7] text-[#374151]'
  const label =
    status === 'passed' ? `${kind} passed`
      : status === 'failed' ? `${kind} failed`
        : status === 'running' ? `${kind} running`
          : status === 'queued' ? `${kind} queued`
            : status === 'blocked' ? `${kind} blocked`
              : script.static_gate_result && !script.static_gate_result.passed ? 'Static gate failed' : 'Not run'
  return <span className={`${CHIP} flex-shrink-0 ${tone}`}>{label}</span>
}

/** The row's status mark: the last dry run, else whether the static gate held. */
const markOf = (script: ScriptAsset | null): MarkTone => {
  if (!script) return 'none'
  const status = script.dry_run_status
  if (status === 'passed' || status === 'failed' || status === 'blocked' || status === 'running' || status === 'queued') return status
  if (script.static_gate_result && !script.static_gate_result.passed) return 'blocked'
  return 'none'
}

// --- Code, with the failing step marked ----------------------------------------

const CodeBlock: React.FC<{ code: string; highlight: Set<number> }> = ({ code, highlight }) => {
  const ref = useRef<HTMLDivElement | null>(null)
  const lines = code.split('\n')
  const marked = Math.min(...Array.from(highlight))
  // The failing step, else the test itself -- its header comment first -- not
  // the file's imports and helpers.
  const testLine = lines.findIndex(line => /^\s*test\(/.test(line))
  const commentAbove = testLine > 0 && lines[testLine - 1].trim().startsWith('//') ? testLine - 1 : testLine
  const first = Number.isFinite(marked) ? marked : commentAbove
  useEffect(() => {
    if (!ref.current || first < 0) return
    const row = ref.current.querySelector<HTMLElement>(`[data-line="${first}"]`)
    if (!row) return
    // Measured against the box itself: offsetTop is relative to whichever
    // ancestor is positioned, which is not this scroller.
    const box = ref.current
    const offset = row.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
    box.scrollTop = Math.max(0, offset - (Number.isFinite(marked) ? 120 : 12))
  }, [first, marked, code])
  return (
    <div ref={ref} className="app-scroll min-h-[320px] flex-1 overflow-auto bg-[#1B1B1F] py-3 font-mono text-[12.5px] leading-[1.75]">
      {lines.map((line, i) => {
        const comment = line.trim().startsWith('//')
        const keyword = /^\s*(test\(|import |export |const |await expect)/.test(line)
        return (
          <div
            key={i}
            data-line={i}
            className={`whitespace-pre px-4 ${highlight.has(i) ? 'bg-[rgba(220,38,38,0.28)] shadow-[inset_3px_0_0_#EF4444]' : ''} ${
              comment ? 'text-[#9CA3AF]' : keyword ? 'text-[#FCA5A5]' : 'text-[#E5E7EB]'
            }`}
          >
            {line || ' '}
          </div>
        )
      })}
    </div>
  )
}

/** The action lines of the step a dry run failed on. */
const failedLines = (code: string, step: number | null | undefined): Set<number> => {
  const out = new Set<number>()
  if (!step) return out
  const block = stepBlocks(code)[step - 1]
  if (!block) return out
  const lines = code.split('\n')
  for (let i = block.start + 1; i <= block.end; i++) {
    if (/\b(page|expect)\b/.test(lines[i]) && !lines[i].trim().startsWith('//')) out.add(i)
  }
  if (!out.size) out.add(block.start)
  return out
}

// --- Page -----------------------------------------------------------------------

const ScriptLab: React.FC = () => {
  const { canExecute, runtime, query, setLabCount } = useAutomationContext()
  const { user } = useAuth()
  const confirm = useConfirm()

  const [cases, setCases] = useState<ScriptLabCase[]>([])
  const [frameworks, setFrameworks] = useState<FrameworkInfo[]>([])
  const [framework, setFramework] = useState('playwright')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [mineOnly, setMineOnly] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [openId, setOpenId] = useState<number | null>(null)
  const [projectFilter, setProjectFilter] = useState('all')
  const [projectMenu, setProjectMenu] = useState(false)
  const [heal, setHeal] = useState<{ scriptId: number; code: string; diagnosis: string; changes: string[] } | null>(null)
  const [healFeedback, setHealFeedback] = useState<string | null>(null)
  const [healElapsed, setHealElapsed] = useState(0)
  const [locatorAudit, setLocatorAudit] = useState<ScriptLocatorAudit | null>(null)
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditError, setAuditError] = useState<string | null>(null)
  const compareRef = useRef<HTMLDivElement | null>(null)
  const [editingScript, setEditingScript] = useState<ScriptAsset | null>(null)
  const [editCode, setEditCode] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  // What the open script needs from Test Data. The environment is not picked
  // here: each application's Test Data says which one its scripts run against.
  const [dataCheck, setDataCheck] = useState<ScriptDataCheck | null>(null)
  const [panel, setPanel] = useState<'readiness' | 'code' | 'compare' | 'execution' | 'crawl'>('readiness')
  const [quickValues, setQuickValues] = useState<Record<string, string>>({})
  const [savingData, setSavingData] = useState(false)
  const [crawlApplication, setCrawlApplication] = useState<RegisteredApplication | null>(null)
  const [creatingCrawlKb, setCreatingCrawlKb] = useState(false)
  const [applications, setApplications] = useState<RegisteredApplication[]>([])
  const [dataApps, setDataApps] = useState<DataApp[]>([])
  const [applicationChoice, setApplicationChoice] = useState('')
  const [showRegister, setShowRegister] = useState(false)
  const [newApplication, setNewApplication] = useState({ name: '', url: '', environment: 'SIT' })
  const [runDialog, setRunDialog] = useState<{ scriptIds: number[]; label: string } | null>(null)
  const [runTarget, setRunTarget] = useState<'server' | 'device'>('device')
  const [runHeaded, setRunHeaded] = useState(true)
  const [runnerStatus, setRunnerStatus] = useState<LocalRunnerStatus | null>(null)
  const [queueState, setQueueState] = useState<ExecutionQueueState | null>(null)
  const [deviceQueue, setDeviceQueue] = useState<DeviceQueue | null>(() => {
    try {
      const stored = window.sessionStorage.getItem(deviceQueueKey)
      return stored ? JSON.parse(stored) as DeviceQueue : null
    } catch { return null }
  })
  const deviceDispatching = useRef(false)
  const [fullLog, setFullLog] = useState<string | null>(null)
  const [logLoading, setLogLoading] = useState(false)

  const load = useCallback(async () => {
    try {
      const [listing, fw] = await Promise.all([automationService.listScriptLabCases(), automationService.listFrameworks()])
      setCases(listing.cases ?? [])
      setFrameworks(fw.frameworks ?? [])
      setLabCount(listing.cases?.length ?? 0)
      setError(null)
    } catch (err: any) {
      setError(err?.message ?? 'The Automation Lab could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [setLabCount])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const queueId = window.sessionStorage.getItem('automation-studio.queue-id')
    if (!queueId) return
    automationService.getExecutionQueue(queueId).then(setQueueState).catch(() => window.sessionStorage.removeItem('automation-studio.queue-id'))
  }, [])
  useEffect(() => {
    Promise.all([automationService.listApplications(), testDataService.apps()])
      .then(([registered, data]) => { setApplications(registered.applications); setDataApps(data.apps) })
      .catch(() => undefined)
  }, [])

  const scriptOf = useCallback(
    (testCase: ScriptLabCase) =>
      testCase.scripts.filter(s => s.framework === framework).sort((a, b) => b.version - a.version)[0] ?? null,
    [framework]
  )

  // Follow dry runs until they settle.
  const anyLive = cases.some(c => c.scripts.some(s => s.dry_run_status === 'running' || s.dry_run_status === 'queued'))
  useEffect(() => {
    if (!anyLive) return
    const id = window.setInterval(() => void load(), 3000)
    return () => window.clearInterval(id)
  }, [anyLive, load])

  useEffect(() => {
    if (!queueState?.remaining) return
    const id = window.setInterval(() => {
      automationService.getExecutionQueue(queueState.queue_id).then(setQueueState).catch(() => undefined)
    }, 2500)
    return () => window.clearInterval(id)
  }, [queueState?.queue_id, queueState?.remaining])

  useEffect(() => {
    if (deviceQueue) window.sessionStorage.setItem(deviceQueueKey, JSON.stringify(deviceQueue))
    else window.sessionStorage.removeItem(deviceQueueKey)
  }, [deviceQueue])
  useEffect(() => {
    if (!deviceQueue || deviceQueue.stopped || deviceQueue.cursor >= deviceQueue.scriptIds.length) {
      setNotice(current => current?.includes('queued on this device. Keep Automation Studio open') ? null : current)
    }
  }, [deviceQueue?.id, deviceQueue?.cursor, deviceQueue?.stopped, deviceQueue?.scriptIds.length])

  // The local runner accepts exactly one run. Never create the next run until
  // the prior run is terminal (or cancellation has had time to reach it).
  useEffect(() => {
    if (!deviceQueue || deviceQueue.stopped || deviceQueue.paused || deviceQueue.runKey || deviceQueue.cursor >= deviceQueue.scriptIds.length) return
    const delay = Math.max(0, deviceQueue.nextAt - Date.now())
    const timer = window.setTimeout(async () => {
      if (deviceDispatching.current) return
      deviceDispatching.current = true
      try {
        const scriptId = deviceQueue.scriptIds[deviceQueue.cursor]
        const created = await automationService.createDeviceDryRun(scriptId, !deviceQueue.headed)
        setDeviceQueue(current => current?.id === deviceQueue.id && current.cursor === deviceQueue.cursor ? { ...current, runKey: created.run_key } : current)
        try {
          await startDeviceRunner(created.pairing)
        } catch (err) {
          await automationService.cancelRun(created.run_key).catch(() => undefined)
          throw err
        }
        await load()
      } catch (err: any) {
        const busyRunner = /runner is busy|another local Playwright run is already active/i.test(String(err?.message ?? ''))
        const message = String(err?.message ?? 'This test could not start.')
        setError(busyRunner ? 'Device runner is finishing the previous test. The queue will retry.' : `Device queue: ${message}`)
        setDeviceQueue(current => current?.id === deviceQueue.id && current.cursor === deviceQueue.cursor && !current.stopped
          ? { ...current, failed: current.failed + (busyRunner ? 0 : 1), cursor: current.cursor + (busyRunner ? 0 : 1), runKey: null, nextAt: Date.now() + 4000,
            startFailures: busyRunner ? current.startFailures : [...(current.startFailures || []), { scriptId: deviceQueue.scriptIds[deviceQueue.cursor], message }] } : current)
      } finally { deviceDispatching.current = false }
    }, delay)
    return () => window.clearTimeout(timer)
  }, [deviceQueue, load])

  useEffect(() => {
    if (!deviceQueue?.runKey || deviceQueue.stopped) return
    let live = true
    const read = async () => {
      try {
        const detail = await automationService.getRun(deviceQueue.runKey!)
        if (!live || detail.status === 'queued' || detail.status === 'running') return
        setDeviceQueue(current => current?.id === deviceQueue.id && current.runKey === detail.run_key
          ? { ...current, runKey: null, cursor: current.cursor + 1,
            passed: current.passed + (detail.outcome === 'passed' ? 1 : 0),
            skipped: current.skipped + (detail.status === 'cancelled' ? 1 : 0),
            failed: current.failed + (detail.outcome !== 'passed' && detail.status !== 'cancelled' ? 1 : 0),
            nextAt: Date.now() + 4000 } : current)
        void load()
      } catch { /* try again on the next poll */ }
    }
    void read()
    const timer = window.setInterval(() => void read(), 2500)
    return () => { live = false; window.clearInterval(timer) }
  }, [deviceQueue?.id, deviceQueue?.runKey, deviceQueue?.stopped, load])

  const projects = useMemo(() => {
    const byId = new Map<number, { id: number; ppm_id: string; name: string }>()
    cases.forEach(c => { if (c.project) byId.set(c.project.id, c.project) })
    return Array.from(byId.values())
  }, [cases])

  const visible = useMemo(
    () =>
      cases.filter(c => {
        if (projectFilter === 'none' ? c.project : projectFilter !== 'all' && String(c.project?.id) !== projectFilter) return false
        if (mineOnly && String(c.created_by ?? '').toLowerCase() !== String(user?.username ?? '').toLowerCase()) return false
        const terms = [query, search].map(value => value.trim().toLowerCase()).filter(Boolean)
        if (!terms.length) return true
        const haystack = [c.tc_display_id, c.title, c.request_id, c.project?.ppm_id, c.project?.name].join(' ').toLowerCase()
        return terms.every(term => haystack.includes(term))
      }),
    [cases, projectFilter, query, search, mineOnly, user?.username]
  )

  // Grouped by project -- "PPM ID - Project name" -- in the order the listing
  // gives them; cases with no project come last.
  const groups = useMemo(() => {
    const byKey = new Map<string, { key: string; ppm: string | null; name: string; cases: ScriptLabCase[] }>()
    visible.forEach(c => {
      const key = c.project ? String(c.project.id) : 'none'
      if (!byKey.has(key)) byKey.set(key, { key, ppm: c.project?.ppm_id ?? null, name: c.project?.name ?? 'No project', cases: [] })
      byKey.get(key)!.cases.push(c)
    })
    const list = Array.from(byKey.values())
    return [...list.filter(g => g.key !== 'none'), ...list.filter(g => g.key === 'none')]
  }, [visible])
  // The order the list reads in, which is the order up / down walk in the drawer.
  const ordered = useMemo(() => groups.flatMap(g => g.cases), [groups])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleGroup = (key: string) =>
    setCollapsed(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next })

  // A case opens when its row is clicked; one that drops out of the list closes.
  useEffect(() => {
    if (openId !== null && !loading && !visible.some(c => c.id === openId)) setOpenId(null)
  }, [visible, openId, loading])

  const openCase = visible.find(c => c.id === openId) ?? null
  const openIndex = openCase ? ordered.indexOf(openCase) : -1
  const openAt = (i: number) => { setOpenId(ordered[i].id); setHeal(null); setHealFeedback(null); setEditingScript(null); setPanel('readiness') }
  const onPrev = openIndex > 0 ? () => openAt(openIndex - 1) : null
  const onNext = openIndex >= 0 && openIndex < ordered.length - 1 ? () => openAt(openIndex + 1) : null
  const closeCase = () => { setOpenId(null); setHeal(null); setHealFeedback(null); setEditingScript(null); setCrawlApplication(null) }
  const openScript = openCase ? scriptOf(openCase) : null
  const { run: polledRun, loading: runLoading, error: runError, refreshing: runRefreshing, refresh: refreshRun } = useRunPolling(
    openScript?.dry_run_key,
    { intervalMs: 2000, onSettled: () => { void load() } }
  )
  const runDetail = polledRun?.run_key === openScript?.dry_run_key ? polledRun : null
  const openExecution = () => { setPanel('execution'); refreshRun() }

  // What the open script needs from Test Data, in its application's environment.
  const openScriptId = openScript?.id ?? null
  const openScriptCode = openScript?.code ?? ''
  const refreshLocatorAudit = useCallback(async (scriptId: number) => {
    setAuditLoading(true)
    setAuditError(null)
    try { setLocatorAudit(await automationService.auditScript(scriptId)) }
    catch (err: any) { setLocatorAudit(null); setAuditError(err?.message ?? 'The locator audit could not be completed.') }
    finally { setAuditLoading(false) }
  }, [])
  useEffect(() => {
    setLocatorAudit(null)
    if (openScriptId !== null) void refreshLocatorAudit(openScriptId)
  }, [openScriptId, openScriptCode, refreshLocatorAudit])
  useEffect(() => {
    setDataCheck(null)
    if (openScriptId === null) return
    let cancelled = false
    testDataService
      .check(openScriptId)
      .then(result => { if (!cancelled) setDataCheck(result) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [openScriptId, openScriptCode])
  useEffect(() => {
    const missing = dataCheck?.missing ?? []
    setQuickValues(current => Object.fromEntries(missing.map(name => [name, current[name] ?? ''])))
  }, [dataCheck?.missing.join('|')])

  useEffect(() => { setFullLog(null) }, [openScript?.dry_run_key])

  useEffect(() => {
    setCrawlApplication(null)
    if (!openCase?.application_id) return
    let live = true
    automationService.getApplication(openCase.application_id)
      .then(app => { if (live) setCrawlApplication(app) })
      .catch(err => { if (live) setError(err?.message ?? 'The application could not be loaded for crawling.') })
    return () => { live = false }
  }, [openCase?.application_id])
  useEffect(() => {
    setApplicationChoice(openCase?.application_id ? String(openCase.application_id) : '')
    setShowRegister(false)
  }, [openCase?.id, openCase?.application_id])
  const healing = heal && openScript && heal.scriptId === openScript.id ? heal : null
  const displayedScriptSteps = openScript ? stepBlocks(healing?.code || openScript.code || '').length : 0
  const selectedCases = cases.filter(testCase => selected.has(testCase.id))
  const selectedExisting = selectedCases.filter(testCase => Boolean(scriptOf(testCase)))
  const brief = openScript ? briefOf(openScript) : null
  const failedStepCode = openScript && brief?.failed_step
    ? (() => { const block = stepBlocks(openScript.code || '')[brief.failed_step - 1]; return block ? (openScript.code || '').split('\n').slice(block.start, block.end + 1).join('\n') : '' })()
    : ''
  const failedLocator = failedStepCode?.match(/page\.(?:getBy\w+|locator)\([^\n;]+?\)(?:\.first\(\))?/)?.[0] ?? null
  const activeFramework = frameworks.find(f => f.name === framework)
  const runnable = activeFramework?.runnable ?? framework === 'playwright'

  useEffect(() => {
    if (busy !== 'heal') return
    setHealElapsed(0)
    const started = Date.now()
    const timer = window.setInterval(() => setHealElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [busy])

  useEffect(() => {
    if (panel !== 'compare' || !healing || !compareRef.current) return
    const box = compareRef.current
    const firstChange = box.querySelector<HTMLElement>('[data-heal-change="first"]')
    if (!firstChange) return
    box.scrollTop += firstChange.getBoundingClientRect().top - box.getBoundingClientRect().top - 88
  }, [panel, healing])

  const runAction = async (label: string, fn: () => Promise<void>) => {
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
    const replacing = selectedCases.filter(testCase => Boolean(scriptOf(testCase)))
    const edited = replacing.filter(testCase => scriptOf(testCase)?.edited_by_user)
    if (replacing.length) {
      const ok = await confirm({
        title: `Regenerate ${replacing.length} existing script${replacing.length === 1 ? '' : 's'}?`,
        body: 'New scripts will use the latest captured controls. Existing versions and their run history are retained.',
        consequences: edited.length ? [`${edited.length} script${edited.length === 1 ? ' has' : 's have'} edits that will be replaced in the new version.`] : [],
        confirmLabel: 'Regenerate scripts'
      })
      if (!ok) return
    }
    void runAction('generate', async () => {
      const res = await automationService.generateScripts({
        case_ids: Array.from(selected),
        framework,
        application_id: readSelectedApplicationId(),
        base_url: null,
        regenerate: replacing.length > 0,
        replace_edited: edited.length > 0
      })
      setSelected(new Set())
      if (res.generated > 0 && !res.skipped?.length) setNotice(`${res.generated} script${res.generated === 1 ? '' : 's'} ${replacing.length ? 'regenerated' : 'generated'}. Open the case to review the new version.`)
      if (res.skipped?.length) {
        setNotice(`${res.generated} generated. ${res.skipped.length} skipped — ` + res.skipped.map(s => `${baseId(s.display_id)}: ${s.reason}`).join(' · '))
      }
    })
  }

  const handleGenerateCase = (testCase: ScriptLabCase) =>
    runAction('generate', async () => {
      const res = await automationService.generateScripts({
        case_ids: [testCase.id],
        framework,
        application_id: testCase.application_id ?? readSelectedApplicationId(),
        base_url: null,
        regenerate: false
      })
      if (res.skipped?.length) setNotice(res.skipped.map(item => `${baseId(item.display_id)}: ${item.reason}`).join(' · '))
      else setNotice(res.generated > 0 ? `Script generated for ${baseId(testCase.tc_display_id)}.` : `No script was generated for ${baseId(testCase.tc_display_id)}.`)
    })

  const handleBitbucketSync = () =>
    runAction('bitbucket-sync', async () => {
      const result = await automationService.syncScriptsToBitbucket(Array.from(selected), framework)
      const created = result.projects.filter(project => project.repository_created).length
      if (!result.synced) {
        const reason = result.results.find(item => item.error)?.error
        throw new Error(reason || 'None of the selected scripts could be synced to Bitbucket.')
      }
      setNotice(
        `${result.synced} selected script${result.synced === 1 ? '' : 's'} synced across `
        + `${result.projects.length} project repositor${result.projects.length === 1 ? 'y' : 'ies'}`
        + `${created ? `; ${created} new repositor${created === 1 ? 'y was' : 'ies were'} created` : ''}`
        + `${result.failed ? `. ${result.failed} failed and can be retried without resyncing the selection manually.` : '.'}`
      )
    })

  const handleDelete = async () => {
    const chosen = cases.filter(c => selected.has(c.id))
    if (!chosen.length) return
    const count = chosen.length
    const ok = await confirm({
      title: count === 1 ? `Delete ${baseId(chosen[0].tc_display_id)}?` : `Delete ${count} test cases?`,
      body: count === 1 ? chosen[0].title : `${count} selected test cases will be removed from the Automation Lab.`,
      consequences: [
        `Every script generated from ${count === 1 ? 'it' : 'them'} is deleted too.`,
        'This cannot be undone.'
      ],
      confirmLabel: count === 1 ? 'Delete test case' : `Delete ${count} test cases`
    })
    if (!ok) return
    void runAction('delete', async () => {
      const res = await automationService.deleteWorkbenchCases(Array.from(selected))
      setSelected(new Set())
      setNotice(`${res.deleted} test case(s) deleted` + (res.scripts_removed ? `, with ${res.scripts_removed} script(s).` : '.'))
    })
  }

  const handleRunSelected = (scriptIds: number[], headless: boolean) =>
    runAction('run-selected', async () => {
      if (!scriptIds.length) throw new Error('The selected test cases do not have runnable scripts yet.')
      const result = await automationService.dryRunScripts({ script_ids: scriptIds, environment: null, base_url: null, slow_mo_ms: 1000, headless })
      window.sessionStorage.setItem('automation-studio.queue-id', result.queue_id)
      setQueueState(await automationService.getExecutionQueue(result.queue_id))
      setNotice(
        `${result.queued.length} run${result.queued.length === 1 ? '' : 's'} added to the queue` +
        (result.refused.length ? `; ${result.refused.length} need attention before they can run.` : '.')
      )
    })

  const openRunOptions = (scripts: ScriptAsset[], label: string) => {
    const ids = scripts.filter(script => script.runnable).map(script => script.id)
    if (!ids.length) { setError('No runnable script is available for this selection.'); return }
    if ((deviceQueue && !deviceQueue.stopped && deviceQueue.cursor < deviceQueue.scriptIds.length) || (queueState && queueState.remaining > 0)) {
      setError('Finish or stop the current queue before starting another one.')
      return
    }
    setRunTarget('device')
    void checkRunner()
    setRunHeaded(true)
    setRunDialog({ scriptIds: ids, label })
  }

  const submitRun = () => {
    if (!runDialog) return
    if (openScript && runDialog.scriptIds.length === 1 && runDialog.scriptIds[0] === openScript.id) setPanel('execution')
    if (runTarget === 'server') {
      void handleRunSelected(runDialog.scriptIds, !runHeaded)
      setRunDialog(null)
      return
    }
    if (!runnerStatus?.ready) { setError('Connect the device runner before starting.'); return }
    setDeviceQueue({ id: `device-${Date.now()}`, scriptIds: runDialog.scriptIds, cursor: 0, runKey: null, passed: 0, failed: 0, skipped: 0, paused: false, stopped: false, headed: runHeaded, nextAt: Date.now(), startFailures: [] })
    setNotice(`${runDialog.scriptIds.length} test case${runDialog.scriptIds.length === 1 ? '' : 's'} queued on this device. Keep Automation Studio open until the queue finishes.`)
    setRunDialog(null)
  }

  const controlDeviceQueue = async (action: 'pause' | 'resume' | 'skip' | 'stop') => {
    if (!deviceQueue) return
    if (action === 'pause' || action === 'resume') {
      setDeviceQueue(current => current ? { ...current, paused: action === 'pause' } : current)
      return
    }
    const currentRun = deviceQueue.runKey
    if (action === 'stop') setDeviceQueue(current => current ? { ...current, stopped: true, paused: false } : current)
    else setDeviceQueue(current => current ? { ...current, runKey: null, cursor: current.cursor + 1, skipped: current.skipped + 1, nextAt: Date.now() + 4000 } : current)
    if (currentRun) await automationService.cancelRun(currentRun).catch(err => setError(err?.message ?? 'Could not cancel the device run.'))
    await load()
  }

  const controlQueue = async (action: 'pause' | 'resume' | 'skip' | 'stop') => {
    if (!queueState) return
    setBusy(`queue-${action}`)
    setError(null)
    try {
      const next = action === 'pause'
        ? await automationService.pauseExecutionQueue(queueState.queue_id)
        : action === 'resume'
          ? await automationService.resumeExecutionQueue(queueState.queue_id)
          : action === 'skip'
            ? await automationService.skipCurrentQueueRun(queueState.queue_id)
            : await automationService.stopExecutionQueue(queueState.queue_id)
      setQueueState(next)
      setNotice(action === 'pause' ? 'Queue paused. The test already running may finish.' : action === 'resume' ? 'Queue resumed.' : action === 'skip' ? 'Current test skipped; the next queued test will start.' : 'Current and remaining queued tests are stopping.')
      await load()
    } catch (err: any) { setError(err?.message ?? 'The queue could not be updated.') }
    finally { setBusy(null) }
  }

  const checkRunner = async () => {
    setBusy('runner-check')
    try { setRunnerStatus(await getLocalRunnerStatus()) }
    catch (err: any) { setRunnerStatus(null); setError(err?.message ?? 'The device runner could not be checked.') }
    finally { setBusy(null) }
  }

  const downloadRunner = () => runAction('runner-download', async () => {
    saveBlob(await automationService.downloadLocalRunnerPackage(), 'automation-studio-local-runner.zip')
    setNotice('Device runner downloaded. Extract and start it, then choose Check connection.')
  })

  const ensureDataApplication = async (application: RegisteredApplication) => {
    const same = dataApps.find(app => app.kb_app_id === application.app_key || Object.values(app.addresses).includes(application.base_url))
    if (same) return same
    const created = await testDataService.createApp({
      name: application.name,
      kb_app_id: application.app_key,
      run_environment: application.environment,
      addresses: { [application.environment]: application.base_url }
    })
    setDataApps(current => [...current, created])
    return created
  }

  const assignOpenApplication = async (applicationId: number) => {
    if (!openCase) return
    const application = applications.find(item => item.id === applicationId)
    if (!application) { setError('Choose an application.'); return }
    setSavingData(true)
    setError(null)
    try {
      await ensureDataApplication(application)
      await automationService.assignCaseApplication(openCase.id, application.id)
      await load()
      if (openScript) setDataCheck(await testDataService.check(openScript.id))
      setNotice(`${application.name} is linked to this test case and Test Data.`)
    } catch (err: any) {
      setError(err?.message ?? 'The application could not be linked.')
    } finally {
      setSavingData(false)
    }
  }

  const registerOpenApplication = async () => {
    if (!openCase) return
    const name = newApplication.name.trim()
    const url = newApplication.url.trim()
    if (!name || !url) { setError('Enter an application name and address.'); return }
    setSavingData(true)
    setError(null)
    try {
      const registered = await knowledgeBaseService.registerApplication({
        name,
        app_key: name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
        addresses: { [newApplication.environment]: url },
        default_environment: newApplication.environment
      })
      const listing = await automationService.listApplications()
      setApplications(listing.applications)
      if (!registered.application?.id) throw new Error('The application was registered but could not be linked.')
      setApplicationChoice(String(registered.application.id))
      await automationService.assignCaseApplication(openCase.id, registered.application.id)
      await load()
      if (openScript) setDataCheck(await testDataService.check(openScript.id))
      setShowRegister(false)
      setNotice(`${name} was registered and linked to this test case.`)
    } catch (err: any) {
      setError(err?.message ?? 'The application could not be registered.')
    } finally {
      setSavingData(false)
    }
  }

  const createCrawlKnowledgeBase = async () => {
    if (!crawlApplication || !openCase) return
    setCreatingCrawlKb(true)
    setError(null)
    try {
      await knowledgeBaseService.createJourneyKb(crawlApplication.app_key, { name: crawlApplication.name, outline: `TEST CASE | Automation cases\n  ${openCase.title}` })
      setCrawlApplication(await automationService.getApplication(crawlApplication.id))
      setNotice('Journey Knowledge Base created. Choose the journey below and start the browser collector.')
    } catch (err: any) { setError(err?.message ?? 'The Journey Knowledge Base could not be created.') }
    finally { setCreatingCrawlKb(false) }
  }

  const handleHeal = (script: ScriptAsset) =>
    runAction('heal', async () => {
      setHealFeedback(null)
      const res = await automationService.healScript(script.id)
      if (!res.healed_code || res.healed_code.trim() === (script.code || '').trim()) {
        setHeal(null)
        setHealFeedback(res.diagnosis || 'No verified code repair is available for this failure.')
        return
      }
      setHeal({ scriptId: script.id, code: res.healed_code, diagnosis: res.diagnosis, changes: res.changes_made ?? [] })
      setPanel('compare')
    })

  const keepHeal = () => {
    if (!healing) return
    void runAction('keep-heal', async () => {
      await automationService.editScript(healing.scriptId, healing.code)
      setHeal(null)
      setHealFeedback(null)
      setNotice('The AI fix is saved to the script. Dry run it to check.')
    })
  }

  const handleSaveEdit = async () => {
    if (!editingScript) return
    setSavingEdit(true)
    setEditError(null)
    try {
      await automationService.editScript(editingScript.id, editCode)
      setEditingScript(null)
      await load()
    } catch (err: any) {
      setEditError(err?.message ?? 'The edits could not be saved.')
    } finally {
      setSavingEdit(false)
    }
  }

  const saveMissingData = async () => {
    if (!dataCheck?.application || !dataCheck.missing.length) return
    const empty = dataCheck.missing.filter(name => !(quickValues[name] ?? '').trim())
    if (empty.length) { setError(`Enter ${empty.map(readableName).join(', ')}.`); return }
    setSavingData(true)
    setError(null)
    try {
      const entries: EntryInput[] = dataCheck.missing.map(variable => ({
        environment: dataCheck.environment,
        key: keyForVariable(variable),
        value: quickValues[variable],
        is_secret: isSecretVariable(variable),
        aliases: variable
      }))
      await testDataService.saveEntries(dataCheck.application.id, entries, [])
      if (openScript) setDataCheck(await testDataService.check(openScript.id))
      await load()
      setNotice('Test data saved and the script variables were linked automatically.')
    } catch (err: any) {
      setError(err?.message ?? 'The test data could not be saved.')
    } finally {
      setSavingData(false)
    }
  }

  const allOn = visible.length > 0 && visible.every(c => selected.has(c.id))
  const toggle = (id: number) =>
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const pickMany = (ids: number[], on: boolean) =>
    setSelected(prev => { const next = new Set(prev); ids.forEach(id => (on ? next.add(id) : next.delete(id))); return next })

  const filterLabel = projectFilter === 'all' ? 'All' : projectFilter === 'none' ? 'No project' : projects.find(p => String(p.id) === projectFilter)?.ppm_id ?? 'All'
  const code = healing ? healing.code : openScript?.code ?? ''
  const highlight = healing || !openScript ? new Set<number>() : failedLines(openScript.code || '', brief?.failed_step)
  const failed = openScript?.dry_run_status === 'failed' || openScript?.dry_run_status === 'blocked'
  const executionBlocked = Boolean(
    openScript?.static_gate_result?.passed === false || (dataCheck && dataCheck.missing.length > 0)
  )
  const openNeedsCrawl = Boolean(openCase && (
    openScript
      ? openScript.static_gate_result?.warnings?.some(warning => /^Step \d+:/.test(warning))
      : openCase.grounding_status === 'partially_grounded' || openCase.grounding_status === 'ungrounded'
  ))

  return (
    <section className={`${CARD} overflow-hidden`}>
      {/* Cases */}
      <div className="flex min-w-0 flex-col">
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <div className="min-w-0">
            <div className="whitespace-nowrap text-[16px] font-bold text-[#1F2937]">Automation cases</div>
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={() => setProjectMenu(v => !v)}
              aria-haspopup="menu"
              aria-expanded={projectMenu}
              title="Filter by project"
              className="inline-flex h-8 items-center gap-1 rounded-full bg-[#1F2937] px-3 text-[13px] font-bold text-white"
            >
              {filterLabel} {visible.length}
            </button>
            {projectMenu && (
              <div role="menu" className="absolute left-0 top-10 z-20 min-w-[240px] overflow-hidden rounded-[14px] border border-[#E8EAEE] bg-white py-1 shadow-[0_12px_32px_rgba(16,24,40,0.14)]">
                {[{ key: 'all', label: 'All projects' }, ...projects.map(p => ({ key: String(p.id), label: `${p.ppm_id} · ${p.name}` })), { key: 'none', label: 'No project' }].map(item => (
                  <button
                    key={item.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={projectFilter === item.key}
                    onClick={() => { setProjectFilter(item.key); setProjectMenu(false) }}
                    className={`block w-full truncate px-3.5 py-2 text-left text-[13px] hover:bg-[#FFF8F8] ${projectFilter === item.key ? 'font-bold text-[#941216]' : 'text-[#1F2937]'}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="relative min-w-[220px] flex-1 sm:max-w-[340px]">
            <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4 4" /></svg>
            <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search test case, ID or project" className="h-10 w-full rounded-[12px] border border-[#E8EAEE] bg-white pl-9 pr-3 text-[13px] outline-none focus:border-[#B71920]" />
          </div>
          <label className="flex h-10 cursor-pointer items-center gap-2 rounded-[12px] border border-[#E8EAEE] bg-white px-3 text-[13px] font-semibold text-[#374151]">
            <input type="checkbox" checked={mineOnly} onChange={event => setMineOnly(event.target.checked)} className="h-4 w-4 accent-[#B71920]" />
            Created by me
          </label>

          <div className="ml-auto flex items-center gap-2">
            <label className="flex h-10 cursor-pointer items-center gap-2 whitespace-nowrap rounded-[12px] border border-[#E8EAEE] bg-white px-3 text-[13.5px] font-semibold text-[#1F2937] hover:border-[#F6D4D5]">
              <input type="checkbox" aria-label="Select all cases" checked={allOn} disabled={!visible.length} onChange={() => setSelected(allOn ? new Set() : new Set(visible.map(c => c.id)))} className="h-4 w-4 accent-[#B71920]" />
              {selected.size ? `${selected.size} selected` : 'Select all'}
            </label>
            {runnable && (
              <button
                type="button"
                onClick={() => openRunOptions(
                  cases.filter(testCase => selected.has(testCase.id)).map(testCase => scriptOf(testCase)).filter((script): script is ScriptAsset => Boolean(script)),
                  `${selected.size} selected test case${selected.size === 1 ? '' : 's'}`
                )}
                disabled={!selected.size || busy !== null || !canExecute}
                title={!selected.size ? 'Select test cases with generated scripts' : 'Choose where and how to run the selection'}
                className="flex h-10 items-center gap-2 whitespace-nowrap rounded-[12px] border border-[#B71920] bg-white px-3.5 text-[13.5px] font-bold text-[#B71920] transition hover:bg-[#FFF5F5] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden><circle cx="12" cy="12" r="8.5" /><path d="M10.5 9l4.5 3-4.5 3z" /></svg>
                {busy === 'run-selected' ? 'Queueing…' : selected.size ? `Run ${selected.size}` : 'Run selected'}
              </button>
            )}
            <div className="relative">
              <select
                value={framework}
                onChange={e => { setFramework(e.target.value); setHeal(null) }}
                aria-label="Framework"
                className="h-10 appearance-none rounded-[12px] border border-[#E8EAEE] bg-white pl-3.5 pr-9 text-[14px] font-semibold text-[#1F2937] outline-none focus:border-[#F1A4A6]"
              >
                {(frameworks.length ? frameworks : [{ name: 'playwright', label: 'Playwright', runnable: true }]).map(fw => (
                  <option key={fw.name} value={fw.name}>{fw.label}</option>
                ))}
              </select>
              <svg className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
            </div>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!selected.size || !canExecute || busy !== null}
              title={!selected.size ? 'Tick the cases to generate scripts for' : undefined}
              className="flex h-10 items-center gap-2 rounded-[12px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-4 text-[14px] font-bold text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3l1.8 4.9L19 9.7l-4.2 3.1 1.5 5.2L12 15l-4.3 3 1.5-5.2L5 9.7l5.2-1.8z" /></svg>
              {busy === 'generate' ? 'Generating…' : selected.size ? `${selectedExisting.length === selected.size ? 'Regenerate' : selectedExisting.length ? 'Generate / Regenerate' : 'Generate'} ${selected.size}` : 'Generate'}
            </button>
            <button
              type="button"
              onClick={() => runAction('download', async () => saveBlob(await automationService.downloadScriptBundle(framework), `automation-scripts-${framework}.zip`))}
              disabled={busy !== null}
              title={`Download every ${activeFramework?.label ?? framework} script as one zip`}
              aria-label="Download scripts"
              className={ICON_BTN}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden><path d="M12 4v11M7 10l5 5 5-5M5 19h14" /></svg>
            </button>
            <button
              type="button"
              onClick={handleBitbucketSync}
              disabled={!selected.size || busy !== null}
              title={!selected.size ? 'Select one or more test cases to sync' : `Sync ${selected.size} selected ${activeFramework?.label ?? framework} script(s) to their PPM repositories`}
              aria-label="Sync selected scripts to Bitbucket"
              className={ICON_BTN}
            >
              {busy === 'bitbucket-sync' ? (
                <Spinner color="#B71920" />
              ) : (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden>
                  <path d="M7 5h10l-1.2 14H8.2L7 5Z" /><path d="M9.5 8h5l-.5 6h-4l-.5-6ZM5 5h14" />
                </svg>
              )}
            </button>
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={!selected.size || !canExecute || busy !== null}
              title="Delete the selected test cases and their scripts"
              aria-label="Delete selected test cases"
              className={`${ICON_BTN} !text-[#B71920]`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
            </button>
          </div>
        </div>

        {deviceQueue && deviceQueue.cursor < deviceQueue.scriptIds.length && !deviceQueue.stopped && (
          <div className="mx-5 mb-3 rounded-[14px] border border-[#CFE0F6] bg-[#F5F9FF] px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className={`h-2.5 w-2.5 rounded-full ${deviceQueue.paused ? 'bg-[#D97706]' : 'animate-pulse bg-[#2563EB]'}`} />
              <div className="min-w-[210px] flex-1"><div className="text-[13.5px] font-bold text-[#1F2937]">Device queue · {deviceQueue.cursor + 1} of {deviceQueue.scriptIds.length}</div><div className="text-[12px] text-[#6B7280]">{deviceQueue.paused ? 'Paused after the current test.' : deviceQueue.runKey ? 'Running one test; the rest wait in order.' : 'Preparing the next test.'} Keep this page open.</div></div>
              <div className="flex flex-wrap gap-2 text-[12px] font-semibold"><span className="rounded-full bg-white px-2 py-1">{deviceQueue.passed} passed</span><span className="rounded-full bg-white px-2 py-1">{deviceQueue.failed} failed</span><span className="rounded-full bg-white px-2 py-1">{deviceQueue.scriptIds.length - deviceQueue.cursor - (deviceQueue.runKey ? 1 : 0)} waiting</span></div>
              <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void controlDeviceQueue(deviceQueue.paused ? 'resume' : 'pause')} className="h-9 rounded-[10px] border border-[#B9CBE3] bg-white px-3 text-[12.5px] font-bold">{deviceQueue.paused ? 'Resume' : 'Pause after current'}</button><button type="button" onClick={() => void controlDeviceQueue('skip')} className="h-9 rounded-[10px] border border-[#B9CBE3] bg-white px-3 text-[12.5px] font-bold">Skip current</button><button type="button" onClick={() => void controlDeviceQueue('stop')} className="h-9 rounded-[10px] bg-[#B71920] px-3 text-[12.5px] font-bold text-white">Stop all</button></div>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#DFEAF8]"><div className="h-full bg-[#2563EB]" style={{ width: `${Math.round(100 * deviceQueue.cursor / deviceQueue.scriptIds.length)}%` }} /></div>
          </div>
        )}
        {deviceQueue && (deviceQueue.stopped || deviceQueue.cursor >= deviceQueue.scriptIds.length) && (
          <div className="mx-5 mb-3 rounded-[12px] border border-[#E8EAEE] bg-[#FCFCFD] px-4 py-2 text-[12.5px] text-[#374151]"><div className="flex flex-wrap items-center gap-2">Device queue {deviceQueue.stopped ? 'stopped' : 'finished'} · {deviceQueue.passed} passed · {deviceQueue.failed} failed or could not start · {deviceQueue.skipped} skipped <button type="button" onClick={() => setDeviceQueue(null)} className="ml-auto font-bold text-[#941216]">Dismiss</button></div>{!!deviceQueue.startFailures?.length && <div className="mt-2 space-y-1 text-[#A3231C]">{deviceQueue.startFailures.map((failure, index) => <div key={`${failure.scriptId}-${index}`} role="alert">Script #{failure.scriptId} could not start: {failure.message}</div>)}</div>}</div>
        )}
        {queueState && (
          <div className="mx-5 mb-3 flex flex-wrap items-center gap-3 rounded-[14px] border border-[#CFE0F6] bg-[#F5F9FF] px-4 py-3">
            <span className={`h-2.5 w-2.5 rounded-full ${queueState.paused ? 'bg-[#D97706]' : queueState.remaining ? 'animate-pulse bg-[#2563EB]' : 'bg-[#16A34A]'}`} />
            <div className="min-w-[210px] flex-1"><div className="text-[13.5px] font-bold text-[#1F2937]">Server queue · {queueState.remaining ? `${queueState.remaining} remaining` : 'finished'}</div><div className="text-[12px] text-[#6B7280]">{queueState.paused ? 'Paused before the next test starts.' : queueState.active_run_key ? 'One test is running; the rest wait in order.' : 'No tests running.'} · {queueState.outcomes?.passed ?? 0} passed · {(queueState.outcomes?.failed ?? 0) + (queueState.outcomes?.blocked ?? 0)} failed · {queueState.counts.queued ?? 0} waiting</div></div>
            <div className="flex flex-wrap gap-2">
              {queueState.remaining > 0 ? <>
              <button type="button" onClick={() => void controlQueue(queueState.paused ? 'resume' : 'pause')} disabled={busy !== null} className="h-9 rounded-[10px] border border-[#B9CBE3] bg-white px-3 text-[12.5px] font-bold text-[#1F2937]">{queueState.paused ? 'Resume queue' : 'Pause after current'}</button>
              <button type="button" onClick={() => void controlQueue('skip')} disabled={busy !== null} className="h-9 rounded-[10px] border border-[#B9CBE3] bg-white px-3 text-[12.5px] font-bold text-[#1F2937]">Skip current</button>
              <button type="button" onClick={() => void controlQueue('stop')} disabled={busy !== null} className="h-9 rounded-[10px] bg-[#B71920] px-3 text-[12.5px] font-bold text-white">Stop all</button>
              </> : <button type="button" onClick={() => { setQueueState(null); window.sessionStorage.removeItem('automation-studio.queue-id') }} className="font-bold text-[#941216]">Dismiss</button>}
            </div>
          </div>
        )}

        {(notice || error || !runnable || (runtime && !runtime.ready)) && (
          <div className="mx-5 mb-3 flex flex-col gap-2">
            {!runnable && <div className="rounded-[12px] border border-[#EBCFA4] bg-[#FFFBF4] px-3.5 py-2 text-[12.5px] text-[#8A5000]">{activeFramework?.label} is generate-only here: scripts can be generated and downloaded, not run.</div>}
            {runnable && runtime && !runtime.ready && <div className="rounded-[12px] border border-[#E8EAEE] bg-[#FCFCFD] px-3.5 py-2 text-[12.5px] text-[#6B7280]">Server execution is unavailable on this deployment. Server dry-run controls are hidden; use Run on device from a test case.</div>}
            {notice && <div className="rounded-[12px] border border-[#E8EAEE] bg-[#FCFCFD] px-3.5 py-2 text-[12.5px] text-[#374151]">{notice}</div>}
            {error && <div role="alert" className="rounded-[12px] border border-[#F6D4D5] bg-[#FFF8F8] px-3.5 py-2 text-[12.5px] text-[#7A0B0D]">{error}</div>}
          </div>
        )}

        <div className="app-scroll overflow-x-auto border-t border-[#E8EAEE] bg-[#F8F9FA] px-4 pb-4 pt-3.5">
          <div className="flex min-w-[1120px] flex-col gap-3.5">
            {loading ? (
              <div className="rounded-[16px] bg-white px-6 py-8 text-[13px] text-[#6B7280]">Loading the Automation Lab…</div>
            ) : visible.length === 0 ? (
              <div className="rounded-[16px] bg-white px-6 py-10 text-center text-[13px] text-[#6B7280]">
                {cases.length
                  ? 'No cases match this filter.'
                  : <>No approved Automation cases yet. Cases arrive here once a manager approves them in Review &amp; Approval. Cases from other sources are prepared in the <Link to="/automation/workbench" className="font-semibold text-[#B71920] hover:underline">Automation Workspace</Link>.</>}
              </div>
            ) : (
              groups.map(group => {
                const shut = collapsed.has(group.key)
                const marks = group.cases.map(c => markOf(scriptOf(c)))
                const count = (tone: MarkTone) => marks.filter(m => m === tone).length
                const scripted = group.cases.filter(c => scriptOf(c)).length
                const ids = group.cases.map(c => c.id)
                const groupOn = ids.every(id => selected.has(id))
                const n = group.cases.length
                return (
                  <div key={group.key} className="overflow-hidden rounded-[16px] border border-[#E8EAEE] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
                    {/* Project header */}
                    <div className="flex items-center gap-3 border-b border-[#F1F2F4] py-3 pl-4 pr-5">
                      <span className="flex w-[28px] justify-center">
                        <input type="checkbox" aria-label={`Select every case in ${group.name}`} checked={groupOn} onChange={e => pickMany(ids, e.target.checked)} className="h-4 w-4 accent-[#B71920]" />
                      </span>
                      <button type="button" onClick={() => toggleGroup(group.key)} aria-expanded={!shut} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                        <ProjectBadge name={group.name} hasProject={Boolean(group.ppm)} />
                        <span className="min-w-0">
                          <span className="block truncate text-[15px] font-bold text-[#1F2937]">
                            {group.ppm ? <><span className="font-mono text-[#941216]">{group.ppm}</span> - {group.name}</> : <span className="text-[#6B7280]">{group.name}</span>}
                          </span>
                          <span className="block text-[12.5px] text-[#6B7280]">
                            {n} case{n === 1 ? '' : 's'} · {scripted} with a {activeFramework?.label ?? framework} script
                          </span>
                        </span>
                      </button>
                      {/* How the project's dry runs went, as one bar */}
                      <OutcomeBar
                        total={n}
                        parts={[
                          { label: 'passed', count: count('passed'), bar: 'bg-[#16A34A]', text: 'text-[#136B34]' },
                          { label: 'failed', count: count('failed'), bar: 'bg-[#DC2626]', text: 'text-[#A3231C]' },
                          { label: 'blocked', count: count('blocked'), bar: 'bg-[#D97706]', text: 'text-[#8A5000]' },
                          { label: 'running', count: count('running') + count('queued'), bar: 'bg-[#3B82F6]', text: 'text-[#1D4ED8]' },
                          { label: 'not run', count: count('none'), bar: 'bg-[#D6D9DF]', text: 'text-[#374151]' }
                        ]}
                      />
                      <button type="button" onClick={() => toggleGroup(group.key)} aria-label={shut ? 'Show cases' : 'Hide cases'} className="flex h-8 w-8 items-center justify-center rounded-[10px] text-[#6B7280] hover:bg-[#F4F5F7]">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden className={`transition ${shut ? '-rotate-90' : ''}`}><path d="M6 9l6 6 6-6" /></svg>
                      </button>
                    </div>

                    {!shut && (
                      <>
                        <div className={`${ROW} h-8 bg-[#FCFCFD] text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9CA3AF]`}>
                          <span />
                          <span />
                          <span>TC ID</span>
                          <span>Title</span>
                          <span>Created by</span>
                          <span>Created</span>
                          <span>Last run</span>
                          <span className="text-right">Steps</span>
                          <span>Actions</span>
                        </div>
                        {group.cases.map(testCase => {
                          const script = scriptOf(testCase)
                          const startFailure = script ? deviceQueue?.startFailures?.find(failure => failure.scriptId === script.id) : undefined
                          const open = testCase.id === openId
                          const request = String(testCase.request_id ?? '')
                          const dataMissing = testCase.test_data_status === 'pending'
                          const gateFailed = Boolean(script?.static_gate_result && !script.static_gate_result.passed)
                          const crawlNeeded = Boolean(script
                            ? script.static_gate_result?.warnings?.some(warning => /^Step \d+:/.test(warning))
                            : testCase.grounding_status === 'partially_grounded' || testCase.grounding_status === 'ungrounded')
                          const needsAttention = dataMissing || gateFailed || crawlNeeded || Boolean(startFailure) || script?.dry_run_status === 'failed' || script?.dry_run_status === 'blocked'
                          const openRow = () => { setOpenId(testCase.id); setHeal(null); setHealFeedback(null); setPanel('readiness') }
                          return (
                            <div
                              key={testCase.id}
                              onClick={openRow}
                              className={`group ${ROW} min-h-[64px] cursor-pointer border-t border-[#F1F2F4] py-2 text-[14px] text-[#1F2937] transition ${
                                open ? 'bg-[#FFF5F5] shadow-[inset_3px_0_0_#B71920]' : selected.has(testCase.id) ? 'bg-[#FFFAFA]' : needsAttention ? 'bg-[#FFFBF4] hover:bg-[#FFF8EA]' : 'hover:bg-[#FAFAFB]'
                              }`}
                            >
                              <span className="flex justify-center">
                                <input
                                  type="checkbox"
                                  aria-label={`Select ${baseId(testCase.tc_display_id)}`}
                                  checked={selected.has(testCase.id)}
                                  onClick={e => e.stopPropagation()}
                                  onChange={() => toggle(testCase.id)}
                                  className="h-4 w-4 accent-[#B71920]"
                                />
                              </span>
                              <StatusMark tone={markOf(script)} title={script ? undefined : 'No script yet'} />
                              <span>
                                <span className="inline-flex h-7 max-w-full items-center truncate rounded-[8px] bg-[#F4F5F7] px-2 font-mono text-[12.5px] font-bold text-[#1F2937]" title={testCase.tc_display_id}>
                                  {baseId(testCase.tc_display_id)}
                                </span>
                              </span>
                              <span className="min-w-0">
                                <span className="block truncate font-semibold group-hover:text-[#B71920]" title={testCase.title}>{testCase.title}</span>
                                {startFailure ? (
                                  <span className="block truncate text-[12px] font-semibold text-[#A3231C]" title={startFailure.message}>Could not start · {startFailure.message}</span>
                                ) : testCase.test_data_status === 'pending' ? (
                                  <span className="block text-[12px] font-semibold text-[#B45309]" title="A test data value is still missing; fill it in before running.">Test data pending</span>
                                ) : crawlNeeded ? (
                                  <span className="block text-[12px] font-semibold text-[#B45309]">Crawl needs attention</span>
                                ) : script ? (
                                  <span className="block truncate font-mono text-[11.5px] text-[#9CA3AF]">{script.file_name}</span>
                                ) : null}
                              </span>
                              <span
                                className="min-w-0 truncate text-[13px] text-[#374151]"
                                title={[testCase.created_by && `Created by ${testCase.created_by}`, testCase.project && `${testCase.project.ppm_id} · ${testCase.project.name}`, request && `${testCase.source_group ? `${testCase.source_group} · ` : ''}${request}`].filter(Boolean).join('\n')}
                              >
                                {testCase.created_by || '—'}
                              </span>
                              <span className="min-w-0 text-[12.5px] tabular-nums text-[#374151]" title="When this case reached Automation Studio (Dubai time)">
                                {fullStamp(testCase.created_at) || '—'}
                              </span>
                              <span className="flex min-w-0 flex-col items-start gap-0.5">
                                {startFailure ? <span className={`${CHIP} bg-[#FEEBEC] text-[#A3231C]`}>Could not start</span> : script ? <ScriptStatus script={script} /> : <span className="text-[13px] text-[#9CA3AF]">—</span>}
                                {script?.dry_run?.failed_step && script.dry_run_status === 'failed' ? (
                                  <span className="text-[12px] text-[#A3231C]">at step {script.dry_run.failed_step}</span>
                                ) : script?.dry_run?.duration_seconds != null && script.dry_run_status === 'passed' ? (
                                  <span className="text-[12px] tabular-nums text-[#6B7280]">{clock(script.dry_run.duration_seconds)}</span>
                                ) : null}
                                {script?.dry_run_at && <span className="text-[11.5px] tabular-nums text-[#9CA3AF]">{fullStamp(script.dry_run_at)}</span>}
                              </span>
                              <span className="text-right text-[13.5px] font-semibold tabular-nums text-[#1F2937]" title={script ? `${testCase.steps} authored case steps` : undefined}>{script ? stepBlocks(script.code || '').length || testCase.steps : testCase.steps}</span>
                              <span className="flex min-w-0 items-center gap-1.5">
                                {script ? (
                                  <button
                                      type="button"
                                      onClick={e => { e.stopPropagation(); openRunOptions([script], baseId(testCase.tc_display_id)) }}
                                      disabled={busy !== null || !canExecute || !script.runnable || dataMissing || gateFailed || script.dry_run_status === 'running' || script.dry_run_status === 'queued'}
                                      title={dataMissing ? 'Add the missing test data first' : gateFailed ? 'Fix the static gate first' : 'Choose server or device, then headed or headless'}
                                      className="inline-flex h-7 items-center gap-1 rounded-full border border-[#B71920] bg-white px-2.5 text-[12px] font-bold text-[#B71920] hover:bg-[#FFF5F5] disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M9 7l8 5-8 5z" /></svg>
                                      Run
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={event => { event.stopPropagation(); void handleGenerateCase(testCase) }}
                                    disabled={busy !== null}
                                    title={`Generate a ${framework} script for ${baseId(testCase.tc_display_id)}`}
                                    className="inline-flex h-7 items-center rounded-full border border-[#B71920] bg-white px-2.5 text-[12px] font-bold text-[#B71920] hover:bg-[#FFF5F5] disabled:cursor-not-allowed disabled:opacity-40"
                                  >
                                    {busy === 'generate' ? 'Generating…' : 'Generate'}
                                  </button>
                                )}
                              </span>
                            </div>
                          )
                        })}
                      </>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>

      {/* The chosen case's script */}
      {openCase && (
      <SideDrawer label={`${baseId(openCase.tc_display_id)} test case`} variant="centered" width="max-w-[1280px]" onClose={closeCase} onPrev={onPrev} onNext={onNext}>
        <div className="flex-shrink-0 border-b border-[#E8EAEE] bg-[linear-gradient(110deg,#FFF5F5_0%,#FFFFFF_52%)] px-5 pb-4 pt-4 sm:px-7">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="mb-1 text-[10.5px] font-extrabold uppercase tracking-[0.15em] text-[#A3231C]">Test case workspace</div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-[#6B7280]">
                <span className="text-[15px] font-bold text-[#B71920]">{baseId(openCase.tc_display_id)}</span>
                {openCase.project && (
                  <span className="truncate" title={`${openCase.project.ppm_id} - ${openCase.project.name}`}>
                    <span className="font-mono font-semibold text-[#941216]">{openCase.project.ppm_id}</span> - {openCase.project.name}
                  </span>
                )}
                {openCase.created_by && <span>· by {openCase.created_by}</span>}
                <span>· {openScript ? `${displayedScriptSteps || openCase.steps} script step${(displayedScriptSteps || openCase.steps) === 1 ? '' : 's'}` : `${openCase.steps} case step${openCase.steps === 1 ? '' : 's'}`}</span>
              </div>
              <h2 className="m-0 mt-1 max-w-[880px] text-[19px] font-bold leading-[1.3] text-[#1F2937]">{openCase.title}</h2>
              {openCase.test_data_status === 'pending' && (
                <div className="mt-1 text-[12.5px] font-semibold text-[#B45309]">Test data pending — fill it in before running.</div>
              )}
            </div>
            <DrawerNav index={openIndex} total={ordered.length} onPrev={onPrev} onNext={onNext} onClose={closeCase} />
          </div>
        </div>
        {!openScript ? (
          <div className="m-auto max-w-[360px] px-6 text-center">
            <div className="text-[15px] font-bold text-[#1F2937]">{baseId(openCase.tc_display_id)} has no {activeFramework?.label ?? framework} script yet</div>
            <p className="mt-1.5 text-[13px] text-[#6B7280]">Tick it in the list and press Generate. The script is checked by the static gate before anything runs.</p>
          </div>
        ) : (
          <>
            <div className="flex flex-shrink-0 items-start gap-3 border-b border-[#E8EAEE] bg-[#FCFCFD] px-6 py-3">
              <span className="mt-0.5 text-[#B71920]">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden><path d="M9 7L4.5 12 9 17M15 7l4.5 5-4.5 5" /></svg>
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[14px] font-semibold text-[#1F2937]" title={openScript.file_name}>{openScript.file_name}</div>
                <div className="text-[12.5px] text-[#6B7280]">
                  {activeFramework?.label ?? openScript.framework} · v{openScript.version} · generated {stamp(openScript.created_at)}
                  {openCase.environment ? <> · runs on <span className="font-semibold text-[#1F2937]">{environmentLabel(openCase.environment)}</span></> : ''}
                  {openScript.edited_by_user ? ' · edited' : ''}
                </div>
              </div>
              <PanelStatus script={openScript} />
            </div>

            {/* Actions sit under the script's name, where the eye already is. */}
            <div className="flex-shrink-0 border-b border-[#E8EAEE] px-5 py-3 sm:px-7">
              <div className="mb-2.5 flex flex-wrap items-center gap-1.5 text-[13px] text-[#6B7280]">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><circle cx="12" cy="12" r="8.5" /><path d="M10.5 9l4.5 3-4.5 3z" /></svg>
                {healing ? (
                  <span>Review the fix, then keep it and dry run again.</span>
                ) : openScript.dry_run_key && (openScript.dry_run_status === 'running' || openScript.dry_run_status === 'queued') ? (
                  <>Run in progress · <button type="button" onClick={openExecution} className="font-semibold text-[#B71920] hover:underline">Watch here</button></>
                ) : openScript.dry_run_key ? (
                  <>
                    {openScript.dry_run_status === 'passed'
                      ? `Last ${brief?.execution_target === 'device' ? 'device run' : 'dry run'} passed`
                      : brief?.failed_step
                        ? `Last ${brief.execution_target === 'device' ? 'device run' : 'dry run'} failed at step ${brief.failed_step}`
                        : `Last ${brief?.execution_target === 'device' ? 'device run' : 'dry run'} ${openScript.dry_run_status}`}
                    {brief?.duration_seconds != null ? ` · ${clock(brief.duration_seconds)}` : ''} ·{' '}
                    <button type="button" onClick={openExecution} className="font-semibold text-[#B71920] hover:underline">View details here</button>
                  </>
                ) : (
                  <span>Not run yet.</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {healing ? (
                  <>
                    <button type="button" onClick={() => setPanel('compare')} className="flex h-10 items-center rounded-[12px] border border-[#C4B5FD] bg-[#F6F2FF] px-4 text-[14px] font-bold text-[#5B21B6]">Compare code</button>
                    <button type="button" onClick={keepHeal} disabled={busy !== null || !canExecute} className="flex h-10 items-center justify-center gap-2 rounded-[12px] bg-[#6D28D9] px-4 text-[14px] font-bold text-white shadow-[0_8px_20px_rgba(109,40,217,0.22)] disabled:opacity-50">
                      {busy === 'keep-heal' ? 'Saving…' : 'Keep fix'}
                    </button>
                    <button type="button" onClick={() => setHeal(null)} className="flex h-10 items-center rounded-[12px] border border-[#E8EAEE] bg-white px-4 text-[14px] font-bold text-[#1F2937] hover:border-[#F6D4D5]">
                      Discard
                    </button>
                  </>
                ) : (
                  <>
                    {failed ? (
                      <button
                        type="button"
                        onClick={() => handleHeal(openScript)}
                        disabled={busy !== null || !canExecute}
                        className="flex h-10 items-center justify-center gap-2 rounded-[12px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-4 text-[14px] font-bold text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] disabled:opacity-50"
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3l1.8 4.9L19 9.7l-4.2 3.1 1.5 5.2L12 15l-4.3 3 1.5-5.2L5 9.7l5.2-1.8z" /></svg>
                        {busy === 'heal' ? 'Healing…' : 'Heal with AI'}
                      </button>
                    ) : null}
                    {!executionBlocked && <button
                      type="button"
                      onClick={() => openRunOptions([openScript], baseId(openCase.tc_display_id))}
                      disabled={busy !== null || !canExecute || !runnable || openScript.dry_run_status === 'running' || openScript.dry_run_status === 'queued'}
                      title={!runnable ? `${activeFramework?.label} is generate-only — no runner exists for it.` : 'Choose where and how this script runs'}
                      className={
                        failed
                          ? 'flex h-10 items-center gap-2 rounded-[12px] border border-[#E8EAEE] bg-white px-4 text-[14px] font-bold text-[#1F2937] transition hover:border-[#F6D4D5] disabled:opacity-50'
                          : 'flex h-10 items-center justify-center gap-2 rounded-[12px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-4 text-[14px] font-bold text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] disabled:opacity-50'
                      }
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden><circle cx="12" cy="12" r="8.5" /><path d="M10.5 9l4.5 3-4.5 3z" /></svg>
                      Run
                    </button>}
                  </>
                )}
                <button
                  type="button"
                  onClick={() => { setEditingScript(openScript); setEditCode(openScript.code || ''); setEditError(null); setPanel('code') }}
                  disabled={!canExecute || busy !== null || Boolean(healing)}
                  title="Edit the script"
                  className="flex h-10 items-center gap-2 whitespace-nowrap rounded-[12px] border border-[#E8EAEE] bg-white px-3.5 text-[14px] font-bold text-[#1F2937] transition hover:border-[#F6D4D5] hover:text-[#B71920] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => runAction('download-one', async () => saveBlob(await automationService.downloadScript(openScript.id), openScript.file_name))}
                  disabled={busy !== null}
                  title="Download the script"
                  className="flex h-10 items-center gap-2 whitespace-nowrap rounded-[12px] border border-[#E8EAEE] bg-white px-3.5 text-[14px] font-bold text-[#1F2937] transition hover:border-[#F6D4D5] hover:text-[#B71920] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden><path d="M12 4v11M7 10l5 5 5-5M5 19h14" /></svg>
                  {busy === 'download-one' ? 'Downloading…' : 'Download'}
                </button>
              </div>
            </div>

            {busy === 'heal' && (
              <div className="flex-shrink-0 border-b border-[#D9CCF5] bg-[#F6F2FF] px-6 py-3" role="status" aria-live="polite">
                <div className="flex items-center gap-2 text-[12.5px] font-bold text-[#5B21B6]"><Spinner /> Inspecting failed step {brief?.failed_step ?? 'and script'} · {healElapsed}s elapsed</div>
                <p className="mt-1 text-[12px] text-[#4C1D95]">Checking {failedLocator ? <code className="rounded bg-white/75 px-1 font-mono">{failedLocator}</code> : 'the failed locator'} against captured application controls, then validating the proposed code. The script is not changed until you choose Keep fix.</p>
              </div>
            )}

            {healFeedback && !healing && (
              <div className="flex-shrink-0 border-b border-[#EBCFA4] bg-[#FFFBF4] px-6 py-3 text-[12.5px] text-[#805000]" role="status">
                <strong className="block">No code change proposed</strong>
                <span>{healFeedback}</span>
              </div>
            )}

            {healing && (
              <div className="flex-shrink-0 border-b border-[#D9CCF5] bg-[#F6F2FF] px-6 py-3">
                <div className="text-[11.5px] font-semibold uppercase tracking-[0.12em] text-[#6D28D9]">AI fix ready</div>
                <p className="mt-1 text-[13px] text-[#4C1D95]">{healing.diagnosis}</p>
                {healing.changes.length > 0 && (
                  <details className="mt-1 text-[12.5px] text-[#5B21B6]">
                    <summary className="cursor-pointer font-bold">View all {healing.changes.length} proposed changes</summary>
                    <ul className="app-scroll mt-1 max-h-32 list-disc overflow-y-auto pl-5">
                      {healing.changes.map((change, i) => <li key={i}>{change}</li>)}
                    </ul>
                  </details>
                )}
              </div>
            )}

            <div className="app-scroll flex flex-shrink-0 gap-1 overflow-x-auto border-b border-[#E8EAEE] bg-[#FCFCFD] px-5 pt-2.5 sm:px-7">
              {([
                ['readiness', 'Readiness'],
                ['code', `Code · ${code.split('\n').length}`],
                ...(healing ? [['compare', 'Before / after'] as const] : []),
                ['execution', openScript.dry_run_status === 'not_run' ? 'Execution' : `Execution · ${openScript.dry_run_status}`],
                ...(openNeedsCrawl ? [['crawl', 'Crawl · needed'] as const] : [])
              ] as const).map(([id, label]) => (
                <button key={id} type="button" onClick={() => setPanel(id)}
                  className={`rounded-t-[10px] border-b-2 px-3 py-2 text-[12.5px] font-bold ${panel === id ? 'border-[#B71920] bg-white text-[#941216]' : 'border-transparent text-[#6B7280] hover:text-[#1F2937]'}`}>
                  {label}
                </button>
              ))}
            </div>

            {panel === 'readiness' && (
              <div className="app-scroll flex-1 overflow-auto bg-[#FAFBFC] px-5 py-5 sm:px-7">
                <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_250px]">
                <div className="min-w-0 rounded-[16px] border border-[#E8EAEE] bg-white p-4 sm:p-5">
                <div className="mb-2 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[#6B7280]">Before running</div>
                <ul className="flex flex-col gap-2">
                  {beforeRunning(openScript).map((check, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-[14px] text-[#1F2937]">
                      <CheckIcon tone={check.tone} />
                      <span className="leading-[1.3]">{check.text}</span>
                    </li>
                  ))}
                  {dataCheck && dataCheck.needed.length > 0 && (
                    <li className="flex items-start gap-2.5 text-[14px] text-[#1F2937]">
                      <CheckIcon tone={dataCheck.missing.length ? 'bad' : 'ok'} />
                      <span className="leading-[1.3]">
                        {dataCheck.missing.length ? (
                          <>Test data missing for {environmentLabel(dataCheck.environment)}: {dataCheck.missing.map(readableName).join(', ')}.</>
                        ) : (
                          <>
                            {dataCheck.needed.length} test data value{dataCheck.needed.length === 1 ? '' : 's'} found for {environmentLabel(dataCheck.environment)}
                            {dataCheck.application ? ` in ${dataCheck.application.name}` : ''}
                          </>
                        )}
                      </span>
                    </li>
                  )}
                </ul>
                <div className="mt-5 rounded-[14px] border border-[#D9CCF5] bg-[#FAF8FF] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-[13px] font-bold text-[#4C1D95]">Locator &amp; Code Audit Agent</div>
                      <p className="mt-0.5 text-[11.5px] text-[#6B5D80]">Checks every saved Playwright action against captured controls for this application and screen. This is not a live browser check.</p>
                    </div>
                    <button type="button" onClick={() => openScriptId !== null && void refreshLocatorAudit(openScriptId)} disabled={auditLoading}
                      className="rounded-[9px] border border-[#C9B8ED] bg-white px-3 py-1.5 text-[12px] font-bold text-[#5B21B6] disabled:opacity-50">
                      {auditLoading ? 'Checking…' : 'Recheck'}
                    </button>
                  </div>
                  {auditError && <p className="mt-3 text-[12px] text-[#B71920]">{auditError}</p>}
                  {locatorAudit && <>
                    <div className="mt-3 flex flex-wrap gap-2 text-[12px] font-semibold">
                      <span className="rounded-full bg-[#E9F7EE] px-2.5 py-1 text-[#166534]">{locatorAudit.matched} match captured evidence</span>
                      <span className="rounded-full bg-[#FFF0DD] px-2.5 py-1 text-[#8A5000]">{locatorAudit.needs_update} need update</span>
                      <span className="rounded-full bg-[#FDEBEC] px-2.5 py-1 text-[#941216]">{locatorAudit.unverified} unverified</span>
                      <span className="rounded-full bg-white px-2.5 py-1 text-[#374151]">{locatorAudit.code_errors.length} basic code errors</span>
                    </div>
                    {locatorAudit.code_errors.map((message, i) => <p key={`code-${i}`} className="mt-2 text-[12px] text-[#B71920]">Code: {message}</p>)}
                    {locatorAudit.actions.some(action => action.status !== 'matched') && <details className="mt-3 text-[12px] text-[#4C1D95]">
                      <summary className="cursor-pointer font-bold">Review locator findings</summary>
                      <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto">
                        {locatorAudit.actions.filter(action => action.status !== 'matched').map((action, i) =>
                          <li key={`${action.line}-${i}`} className="rounded-[8px] bg-white p-2">
                            Step {action.step}, line {action.line} · {action.status === 'needs_update' ? 'Captured control differs' : 'No unique captured match'}
                            <code className="mt-1 block break-all text-[11px] text-[#374151]">{action.locator}</code>
                            {action.suggested_locator && <code className="mt-1 block break-all text-[11px] text-[#166534]">Captured: {action.suggested_locator}</code>}
                          </li>
                        )}
                      </ul>
                    </details>}
                  </>}
                </div>
                {dataCheck?.missing.length ? (
                  dataCheck.application ? (
                    <div className="mt-4 rounded-[14px] border border-[#F1D39A] bg-[#FFFBF4] p-4">
                      <div className="text-[13.5px] font-bold text-[#7A4A00]">Add the missing data here</div>
                      <p className="mt-1 text-[12.5px] text-[#6B4A16]">Saved directly to {dataCheck.application.name} in Test Data. Script variables and secret handling are set automatically.</p>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        {dataCheck.missing.map(variable => (
                          <label key={variable} className="flex flex-col gap-1 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-[#6B7280]">
                            {readableName(variable)}
                            <input
                              type={isSecretVariable(variable) ? 'password' : 'text'}
                              value={quickValues[variable] ?? ''}
                              onChange={event => setQuickValues(current => ({ ...current, [variable]: event.target.value }))}
                              autoComplete="off"
                              placeholder={isSecretVariable(variable) ? 'Stored securely' : `Enter ${readableName(variable)}`}
                              className="h-10 rounded-[10px] border border-[#E8EAEE] bg-white px-3 text-[13px] font-normal normal-case tracking-normal text-[#1F2937] outline-none focus:border-[#B71920]"
                            />
                          </label>
                        ))}
                      </div>
                      <button type="button" onClick={() => void saveMissingData()} disabled={savingData || !canExecute}
                        className="mt-3 h-9 rounded-[10px] bg-[#B71920] px-4 text-[13px] font-bold text-white disabled:opacity-50">
                        {savingData ? 'Saving…' : 'Save data & recheck'}
                      </button>
                    </div>
                  ) : (
                    <div className="mt-4 overflow-hidden rounded-[14px] border border-[#F1D39A] bg-[#FFFBF4]">
                      <div className="p-4">
                        <div className="text-[13.5px] font-bold text-[#7A4A00]">Choose the application for this test case</div>
                        <p className="mt-1 text-[12.5px] text-[#6B4A16]">This links the script, environment and Test Data in one step. You can also register a new application here.</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <select value={applicationChoice} onChange={event => setApplicationChoice(event.target.value)} className="h-10 min-w-[260px] flex-1 rounded-[10px] border border-[#E8EAEE] bg-white px-3 text-[13px] font-semibold text-[#1F2937] outline-none focus:border-[#B71920]">
                            <option value="">Select an application</option>
                            {applications.map(application => <option key={application.id} value={application.id}>{application.name} · {application.environment}</option>)}
                          </select>
                          <button type="button" onClick={() => void assignOpenApplication(Number(applicationChoice))} disabled={!applicationChoice || savingData || !canExecute} className="h-10 rounded-[10px] bg-[#B71920] px-4 text-[13px] font-bold text-white disabled:opacity-40">Select &amp; link</button>
                          <button type="button" onClick={() => setShowRegister(value => !value)} className="h-10 rounded-[10px] border border-[#E8EAEE] bg-white px-4 text-[13px] font-bold text-[#1F2937]">Register new</button>
                        </div>
                      </div>
                      {showRegister && (
                        <div className="grid gap-2 border-t border-[#F1D39A] bg-white p-3 sm:grid-cols-2">
                          <input value={newApplication.name} onChange={event => setNewApplication(value => ({ ...value, name: event.target.value }))} placeholder="Application name" className="h-10 rounded-[10px] border border-[#E8EAEE] px-3 text-[13px] outline-none focus:border-[#B71920]" />
                          <input value={newApplication.url} onChange={event => setNewApplication(value => ({ ...value, url: event.target.value }))} placeholder="https://application.example" className="h-10 rounded-[10px] border border-[#E8EAEE] px-3 text-[13px] outline-none focus:border-[#B71920]" />
                          <input value={newApplication.environment} onChange={event => setNewApplication(value => ({ ...value, environment: event.target.value.toUpperCase() }))} placeholder="SIT" className="h-10 rounded-[10px] border border-[#E8EAEE] px-3 text-[13px] font-semibold outline-none focus:border-[#B71920]" />
                          <button type="button" onClick={() => void registerOpenApplication()} disabled={savingData || !canExecute} className="h-10 rounded-[10px] bg-[#1F2937] px-4 text-[13px] font-bold text-white disabled:opacity-50">Register &amp; link</button>
                        </div>
                      )}
                    </div>
                  )
                ) : null}

                {openNeedsCrawl && (
                  <button type="button" onClick={() => setPanel('crawl')} className="mt-4 flex h-10 items-center rounded-[12px] border border-[#B71920] bg-white px-4 text-[13px] font-bold text-[#B71920] hover:bg-[#FFF5F5]">
                    Open crawl tools here
                  </button>
                )}
                </div>
                <aside className="h-fit rounded-[16px] border border-[#E8EAEE] bg-white p-4 text-[12.5px] text-[#6B7280]">
                  <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#9CA3AF]">At a glance</div>
                  <div className="mt-3 space-y-3">
                    <div><span className="block text-[11px] uppercase tracking-wide">Project</span><span className="font-semibold text-[#1F2937]">{openCase.project?.name || 'Not linked'}</span></div>
                    <div><span className="block text-[11px] uppercase tracking-wide">Environment</span><span className="font-semibold text-[#1F2937]">{openCase.environment ? environmentLabel(openCase.environment) : 'Not set'}</span></div>
                    <div><span className="block text-[11px] uppercase tracking-wide">Automation</span><span className="font-semibold text-[#1F2937]">{openScript.framework} · version {openScript.version}</span></div>
                    <div><span className="block text-[11px] uppercase tracking-wide">Last run</span><span className="font-semibold capitalize text-[#1F2937]">{openScript.dry_run_status.replaceAll('_', ' ')}</span></div>
                  </div>
                  {openScript.dry_run_key && <button type="button" onClick={openExecution} className="mt-4 w-full rounded-[10px] border border-[#F6D4D5] bg-[#FFF8F8] px-3 py-2 text-left font-bold text-[#941216] hover:bg-[#FDEBEC]">Review execution →</button>}
                </aside>
                </div>
              </div>
            )}

            {panel === 'code' && (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#1B1B1F]">
                <div className="flex items-center gap-3 border-b border-[#34343A] bg-[#242429] px-4 py-2.5 text-[12px] text-[#D1D5DB]">
                  <span className="font-mono font-semibold">{openScript.file_name}</span>
                  <span className="text-[#9CA3AF]">{code.split('\n').length} lines</span>
                  {highlight.size > 0 && <span className="rounded-full bg-[rgba(220,38,38,0.2)] px-2 py-1 font-semibold text-[#FCA5A5]">Failed step highlighted</span>}
                  {editingScript ? <span className="ml-auto rounded-full bg-[#7A2E10] px-2 py-1 font-semibold text-[#FED7AA]">Editing</span> : <button type="button" onClick={() => { void navigator.clipboard.writeText(code); setNotice('Code copied to clipboard.') }} className="ml-auto rounded-[8px] border border-[#4B4B53] px-2.5 py-1 font-semibold text-white hover:bg-[#34343A]">Copy code</button>}
                </div>
                {editingScript ? <>
                  {editError && <div className="border-b border-[#7F1D1D] bg-[#3F1719] px-4 py-2 text-[12.5px] text-[#FCA5A5]">{editError}</div>}
                  <textarea value={editCode} onChange={e => setEditCode(e.target.value)} spellCheck={false} className="m-0 min-h-0 flex-1 resize-none bg-[#1B1B1F] p-4 font-mono text-[13px] leading-[1.7] text-[#E5E7EB] outline-none" />
                  <div className="flex items-center gap-2 border-t border-[#34343A] bg-[#242429] px-4 py-3"><button type="button" onClick={() => setEditCode(editingScript.code || '')} disabled={savingEdit || editCode === editingScript.code} className="text-[12.5px] font-semibold text-[#9CA3AF] disabled:opacity-40">Reset</button><div className="ml-auto flex gap-2"><button type="button" onClick={() => { setEditingScript(null); setEditError(null) }} disabled={savingEdit} className="h-9 rounded-[10px] border border-[#4B4B53] px-4 text-[13px] font-bold text-white">Cancel</button><button type="button" onClick={() => void handleSaveEdit()} disabled={savingEdit || !canExecute} className="h-9 rounded-[10px] bg-[#B71920] px-4 text-[13px] font-bold text-white disabled:opacity-50">{savingEdit ? 'Saving…' : 'Save changes'}</button></div></div>
                </> : <CodeBlock code={code} highlight={highlight} />}
              </div>
            )}

            {panel === 'compare' && healing && (
              <div ref={compareRef} className="app-scroll min-h-0 flex-1 overflow-auto bg-[#F8F9FB] p-4">
                <p className="mb-3 text-[12.5px] text-[#53657A]">Showing the first changed line. The original script stays saved until you choose Keep fix.</p>
                <div className="grid min-w-[900px] grid-cols-2 gap-3">
                  {([
                    ['Before · current script', openScript.code || '', healing.code || ''],
                    ['After · proposed fix', healing.code || '', openScript.code || '']
                  ] as const).map(([title, source, other]) => {
                    const sourceLines = source.split('\n')
                    const otherLines = other.split('\n')
                    const firstChanged = sourceLines.findIndex((line, index) => line !== otherLines[index])
                    return <div key={title} className="min-w-0 overflow-hidden rounded-[12px] border border-[#DCE1E8] bg-[#1B1B1F]">
                      <div className="sticky top-0 z-10 border-b border-[#3D4149] bg-[#27272E] px-3 py-2 text-[12px] font-bold text-white">{title}</div>
                      <div className="overflow-x-auto py-2 font-mono text-[11.5px] leading-[1.7]">
                        {sourceLines.map((line, index) => <div key={index} data-heal-change={index === firstChanged && title.startsWith('Before') ? 'first' : undefined} className={`flex min-w-max whitespace-pre px-2 ${line !== otherLines[index] ? 'bg-[#49313B] text-[#FFD7DC]' : 'text-[#E5E7EB]'}`}><span className="mr-3 w-8 select-none text-right text-[#858A96]">{index + 1}</span><span>{line || ' '}</span></div>)}
                      </div>
                    </div>
                  })}
                </div>
              </div>
            )}

            {panel === 'execution' && (
              <div className="app-scroll flex-1 overflow-auto px-6 py-4">
                {openScript.dry_run_key && <div className="mb-3 flex justify-end"><Link to={`/automation/runs/${encodeURIComponent(openScript.dry_run_key)}`} className="rounded-[9px] border border-[#E8EAEE] bg-white px-3 py-2 text-[12px] font-bold text-[#941216] hover:border-[#F6D4D5]">Switch to full execution page →</Link></div>}
                {!openScript.dry_run_key && <div className="rounded-[14px] bg-[#F4F5F7] p-4 text-[13px] text-[#6B7280]">This script has not run yet.</div>}
                {openScript.dry_run_key && !runDetail && <div className="rounded-[14px] bg-[#F4F5F7] p-4 text-[13px] text-[#6B7280]">{runError ? <>Execution details are temporarily unavailable: {runError} <button type="button" onClick={refreshRun} className="ml-2 font-bold text-[#B71920] hover:underline">Try again</button></> : runLoading ? 'Loading execution details…' : 'Waiting for the run to appear…'}</div>}
                {runDetail && (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-2 text-[12px] text-[#6B7280]"><span className="min-w-0 flex-1 break-all">{runDetail.execution_target === 'device' ? 'Running on this device' : 'Server dry run'} · {runDetail.run_key}</span><span className="flex items-center gap-2">{runRefreshing && <><Spinner /> Updating</>}<button type="button" onClick={refreshRun} className="font-bold text-[#941216] hover:underline">Refresh</button></span></div>
                    {runError && <div className="rounded-[10px] border border-[#F1D39A] bg-[#FFFBF4] p-2.5 text-[12px] text-[#6B4A16]">Live updates paused briefly: {runError}. Retrying automatically.</div>}
                    <div className="grid gap-2 sm:grid-cols-4">
                      {[
                        ['Status', runDetail.status],
                        ['Outcome', runDetail.outcome ?? 'In progress'],
                        ['Environment', runDetail.environment ?? '—'],
                        ['Duration', runDetail.duration_seconds == null ? '—' : clock(runDetail.duration_seconds)]
                      ].map(([label, value]) => <div key={label} className="rounded-[12px] border border-[#E8EAEE] bg-[#FCFCFD] p-3"><div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#9CA3AF]">{label}</div><div className="mt-1 text-[13.5px] font-bold capitalize text-[#1F2937]">{value}</div></div>)}
                    </div>
                    <ExecutionProgress run={runDetail} scriptCode={openScript.code || ''} />
                    {runDetail.error_message && <div className="rounded-[12px] border border-[#F6D4D5] bg-[#FFF8F8] px-3.5 py-3 text-[12.5px] text-[#7A0B0D]">
                      <div className="font-bold">Why this run failed</div>
                      {failureExplanation(runDetail.error_message) && <p className="mt-1 leading-relaxed">{failureExplanation(runDetail.error_message)}</p>}
                      <details className="mt-2"><summary className="cursor-pointer font-bold">Technical error</summary><pre className="app-scroll mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11.5px]">{runDetail.error_message}</pre></details>
                    </div>}
                    {runDetail.has_log && <div className="rounded-[12px] border border-[#E8EAEE] p-3">
                      <div className="flex flex-wrap items-center gap-2"><span className="font-bold text-[#1F2937]">Complete execution log</span><button type="button" onClick={async () => { setLogLoading(true); try { setFullLog(await automationService.getRunLog(runDetail.run_key)) } catch (err: any) { setError(err?.message ?? 'The log could not be loaded.') } finally { setLogLoading(false) } }} className="ml-auto rounded-[9px] border border-[#E8EAEE] px-3 py-1.5 text-[12px] font-bold text-[#941216]">{logLoading ? 'Loading…' : fullLog === null ? 'View full log' : 'Refresh log'}</button></div>
                      {fullLog !== null && <><pre className="app-scroll mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap break-all rounded-[10px] bg-[#1B1B1F] p-3 font-mono text-[11.5px] text-white">{fullLog || 'The runner did not write any log output.'}</pre><button type="button" onClick={() => saveBlob(new Blob([fullLog], { type: 'text/plain' }), `${runDetail.run_key}.log`)} className="mt-2 text-[12px] font-bold text-[#941216]">Download log</button></>}
                    </div>}
                    <div className="overflow-hidden rounded-[14px] border border-[#E8EAEE]">
                      <div className="grid grid-cols-[minmax(0,1fr)_100px_90px] bg-[#F4F5F7] px-3 py-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#6B7280]"><span>Test</span><span>Status</span><span>Time</span></div>
                      {runDetail.results.length === 0 ? <div className="px-3 py-4 text-[12.5px] text-[#6B7280]">Waiting for test results…</div> : runDetail.results.map(result => (
                        <div key={result.id} className="grid grid-cols-[minmax(0,1fr)_100px_90px] border-t border-[#E8EAEE] px-3 py-2.5 text-[12.5px]">
                          <span className="min-w-0"><span className="block truncate font-semibold text-[#1F2937]">{result.test_name}</span>{result.error_message && <span className="block text-[#A3231C]">{result.error_message}</span>}</span>
                          <span className="font-semibold capitalize text-[#374151]">{result.status}</span>
                          <span className="tabular-nums text-[#6B7280]">{result.duration_ms == null ? '—' : `${(result.duration_ms / 1000).toFixed(1)}s`}</span>
                        </div>
                      ))}
                    </div>
                    {runDetail.status !== 'queued' && runDetail.status !== 'running' && <div>
                      <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-[#6B7280]">Recorded evidence</div>
                      <Evidence run={runDetail} result={runDetail.results.find(result => result.status === 'fail' || result.status === 'error') ?? runDetail.results[0] ?? null} />
                    </div>}
                  </div>
                )}
              </div>
            )}

            {panel === 'crawl' && (
              <div className="app-scroll flex-1 overflow-auto bg-[#F8F9FA] p-4">
                {!openCase.application_id ? (
                  <div className="rounded-[14px] border border-[#F1D39A] bg-[#FFFBF4] p-4 text-[13px] text-[#6B4A16]"><div className="font-bold">Choose the application to crawl</div><p className="mt-1">Link the test case here; you do not need to leave Automation Studio.</p><div className="mt-3 flex flex-wrap gap-2"><select value={applicationChoice} onChange={event => setApplicationChoice(event.target.value)} className="h-9 min-w-[220px] flex-1 rounded-[9px] border border-[#E8EAEE] bg-white px-2"><option value="">Select an application</option>{applications.map(application => <option key={application.id} value={application.id}>{application.name}</option>)}</select><button type="button" onClick={() => void assignOpenApplication(Number(applicationChoice))} disabled={!applicationChoice || savingData} className="rounded-[9px] bg-[#B71920] px-3 font-bold text-white disabled:opacity-50">Link application</button></div></div>
                ) : !crawlApplication ? (
                  <div className="rounded-[14px] bg-white p-4 text-[13px] text-[#6B7280]">Loading crawl tools…</div>
                ) : !crawlApplication.knowledge_base.linked ? (
                  <div className="rounded-[14px] border border-[#F1D39A] bg-[#FFFBF4] p-4 text-[13px] text-[#6B4A16]"><div className="font-bold">This application needs a Journey Knowledge Base</div><p className="mt-1">Create it here using this test case as the starting outline, then use the browser collector to capture the missing page.</p><button type="button" onClick={() => void createCrawlKnowledgeBase()} disabled={!canExecute || creatingCrawlKb} className="mt-3 rounded-[10px] bg-[#B71920] px-4 py-2 text-[12.5px] font-bold text-white disabled:opacity-50">{creatingCrawlKb ? 'Creating…' : 'Create for this test case'}</button></div>
                ) : (
                  <JourneyCrawlStage
                    appKey={crawlApplication.app_key}
                    application={crawlApplication}
                    canExecute={canExecute}
                    canApprove={false}
                    initialJourneyId={openCase.journey_id}
                    serverRuntimeReady={Boolean(runtime?.ready)}
                    onProposed={() => { setNotice('Crawl changes were proposed for review.'); void load() }}
                    onAutomationReady={() => { setNotice('Automation Knowledge Base updated from this crawl.'); void load() }}
                  />
                )}
              </div>
            )}

          </>
        )}
      </SideDrawer>
      )}

      {runDialog ? (
        <div className="fixed inset-0 z-[75] flex items-center justify-center bg-[rgba(17,24,39,0.55)] p-4" role="dialog" aria-modal="true" aria-label="Run options" onMouseDown={event => { if (event.target === event.currentTarget) setRunDialog(null) }}>
          <div className="w-full max-w-[560px] overflow-hidden rounded-[20px] border border-[#E8EAEE] bg-white shadow-[0_28px_70px_rgba(15,23,42,0.22)]">
            <div className="border-b border-[#E8EAEE] px-5 py-4">
              <div className="text-[16px] font-bold text-[#1F2937]">Run {runDialog.label}</div>
              <div className="mt-1 text-[12.5px] text-[#6B7280]">Choose where the run happens and whether the browser is visible.</div>
            </div>
            <div className="space-y-4 p-5">
              <div className="grid gap-2 sm:grid-cols-2">
                {runtime?.ready && (
                  <button type="button" onClick={() => setRunTarget('server')} className={`rounded-[14px] border p-4 text-left ${runTarget === 'server' ? 'border-[#B71920] bg-[#FFF5F5]' : 'border-[#E8EAEE] bg-white'}`}>
                    <span className="block text-[13.5px] font-bold text-[#1F2937]">Server dry run</span>
                    <span className="mt-1 block text-[12px] leading-[1.4] text-[#6B7280]">Production-safe queue; selected tests run one at a time.</span>
                  </button>
                )}
                <button type="button" onClick={() => { setRunTarget('device'); if (!runnerStatus) void checkRunner() }} className={`rounded-[14px] border p-4 text-left ${runTarget === 'device' ? 'border-[#B71920] bg-[#FFF5F5]' : 'border-[#E8EAEE] bg-white'}`}>
                  <span className="block text-[13.5px] font-bold text-[#1F2937]">Run on this device</span>
                  <span className="mt-1 block text-[12px] leading-[1.4] text-[#6B7280]">Uses the local runner. Multiple cases run one by one, even across projects.</span>
                </button>
              </div>
              {runTarget === 'device' && <div className={`rounded-[13px] border px-4 py-3 ${runnerStatus?.ready ? 'border-[#CDE8D3] bg-[#F3FAF5]' : 'border-[#F1D39A] bg-[#FFFBF4]'}`}>
                <div className="flex flex-wrap items-center gap-2"><span className={`text-[13px] font-bold ${runnerStatus?.ready ? 'text-[#136B34]' : 'text-[#7A4A00]'}`}>{runnerStatus?.ready ? `Device runner connected${runnerStatus.version ? ` · ${runnerStatus.version}` : ''}` : runnerStatus ? 'Device runner not detected' : 'Check the device runner before starting'}</span><div className="ml-auto flex gap-2"><button type="button" onClick={() => void checkRunner()} disabled={busy !== null} className="h-8 rounded-[9px] border border-current px-3 text-[12px] font-bold">{busy === 'runner-check' ? 'Checking…' : 'Check connection'}</button>{(!runnerStatus?.ready || runnerStatus.version !== '1.3.3') && <button type="button" onClick={() => void downloadRunner()} disabled={busy !== null} className="h-8 rounded-[9px] bg-[#B71920] px-3 text-[12px] font-bold text-white">{runnerStatus?.ready ? 'Update runner' : 'Download runner'}</button>}</div></div>
                {runnerStatus?.ready && runnerStatus.version !== '1.3.3' && <p className="mt-1 text-[11.5px] text-[#7A4A00]">Update to runner 1.3.3 for reliable queue controls and complete failure logs.</p>}
                {!runnerStatus?.ready && <p className="mt-1 text-[11.5px] text-[#6B4A16]">Open the extracted runner and allow local-network access if your browser asks. <Link to="/guides/local-tools" className="font-bold text-[#941216] underline">View setup guide</Link></p>}
              </div>}
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]">Browser mode</div>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setRunHeaded(false)} className={`h-10 rounded-[11px] border text-[13px] font-bold ${!runHeaded ? 'border-[#B71920] bg-[#FFF5F5] text-[#941216]' : 'border-[#E8EAEE] text-[#374151]'}`}>Headless</button>
                  <button type="button" onClick={() => setRunHeaded(true)} className={`h-10 rounded-[11px] border text-[13px] font-bold ${runHeaded ? 'border-[#B71920] bg-[#FFF5F5] text-[#941216]' : 'border-[#E8EAEE] text-[#374151]'}`}>Headed</button>
                </div>
                <p className="mt-2 text-[12px] text-[#6B7280]">Headless runs in the background. Headed opens a visible browser.</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-[#E8EAEE] bg-[#FCFCFD] px-5 py-3">
              <button type="button" onClick={() => setRunDialog(null)} className="h-9 rounded-[10px] border border-[#E8EAEE] bg-white px-4 text-[13px] font-bold text-[#1F2937]">Cancel</button>
              <button type="button" onClick={submitRun} disabled={(runTarget === 'server' && !runtime?.ready) || (runTarget === 'device' && !runnerStatus?.ready)} className="h-9 rounded-[10px] bg-[#B71920] px-5 text-[13px] font-bold text-white disabled:opacity-40">{runDialog.scriptIds.length > 1 ? 'Start queue' : 'Start run'}</button>
            </div>
          </div>
        </div>
      ) : null}

    </section>
  )
}

export default ScriptLab
