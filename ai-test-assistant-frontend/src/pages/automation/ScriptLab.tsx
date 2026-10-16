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
import { startDeviceRunner } from '../../services/localRunner'
import { useAutomationContext } from '../../components/automation/AutomationContext'
import { useConfirm } from '../../components/ui/ConfirmDialog'
import SideDrawer, { DrawerNav } from '../../components/automation/SideDrawer'
import { OutcomeBar, ProjectBadge, StatusMark, type MarkTone } from '../../components/automation/listPresentation'
import { readSelectedApplicationId } from '../../types/automation'
import testDataService, { environmentLabel, readableName, type ScriptDataCheck } from '../../services/testDataService'
import type { DryRunBrief, FrameworkInfo, ScriptAsset, ScriptLabCase } from '../../types/automation'

const CARD = 'rounded-[20px] border border-[#E8EAEE] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]'
const CHIP = 'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12.5px] font-semibold'
const ICON_BTN = 'flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[12px] border border-[#E8EAEE] bg-white text-[#6B7280] transition hover:border-[#F6D4D5] hover:text-[#B71920] disabled:cursor-not-allowed disabled:opacity-40'
const ROW = 'grid grid-cols-[28px_40px_112px_minmax(0,1fr)_120px_150px_170px_70px_170px] items-center gap-3 pl-4 pr-5'


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
        ? { tone: 'ok', text: 'Static gate passed — compiles, every step emitted' }
        : { tone: 'bad', text: `Static gate failed — ${gate.errors[0] ?? 'see the script'}${gate.errors.length > 1 ? ` (+${gate.errors.length - 1} more)` : ''}` }
    )
  }
  const blocks = stepBlocks(script.code || '')
  if (blocks.length) {
    // A warning "Step N: …" is a step whose element neither the Knowledge Base
    // nor discovery named, so its locator was inferred from prose.
    const unresolved = new Set(
      (gate?.warnings ?? []).map(w => /^Step (\d+):/.exec(w)?.[1]).filter(Boolean) as string[]
    ).size
    const found = Math.max(0, blocks.length - unresolved)
    checks.push({
      tone: unresolved ? 'warn' : 'ok',
      text: `${found} of ${blocks.length} controls found in the Knowledge Base`
    })
  }
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
  if (status === 'passed') {
    return (
      <span className={`${CHIP} bg-[#EAF7EF] text-[#136B34]`}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" aria-hidden><path d="M5 12l5 5 9-10" /></svg>
        Dry run passed
      </span>
    )
  }
  if (status === 'failed') return <span className={`${CHIP} bg-[#FEEBEC] text-[#A3231C]`}>Dry run failed</span>
  if (status === 'running' || status === 'queued') {
    return (
      <span className={`${CHIP} bg-[#EEF4FF] text-[#1D4ED8]`}>
        <Spinner />
        {status === 'running' ? 'Dry run running' : 'Dry run queued'}
      </span>
    )
  }
  if (status === 'blocked') return <span className={`${CHIP} bg-[#FFF4E5] text-[#8A5000]`}>Dry run blocked</span>
  if (script.static_gate_result && !script.static_gate_result.passed) {
    return <span className={`${CHIP} bg-[#FFF4E5] text-[#8A5000]`}>Static gate failed</span>
  }
  return <span className={`${CHIP} bg-[#F4F5F7] text-[#374151]`}>Not run</span>
}

const PanelStatus: React.FC<{ script: ScriptAsset }> = ({ script }) => {
  const status = script.dry_run_status
  const tone =
    status === 'passed' ? 'bg-[#EAF7EF] text-[#136B34]'
      : status === 'failed' ? 'bg-[#FEEBEC] text-[#A3231C]'
        : status === 'running' || status === 'queued' ? 'bg-[#EEF4FF] text-[#1D4ED8]'
          : status === 'blocked' || (script.static_gate_result && !script.static_gate_result.passed) ? 'bg-[#FFF4E5] text-[#8A5000]'
            : 'bg-[#F4F5F7] text-[#374151]'
  const label =
    status === 'passed' ? 'Dry run passed'
      : status === 'failed' ? 'Dry run failed'
        : status === 'running' ? 'Dry run running'
          : status === 'queued' ? 'Dry run queued'
            : status === 'blocked' ? 'Dry run blocked'
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
  const confirm = useConfirm()

  const [cases, setCases] = useState<ScriptLabCase[]>([])
  const [frameworks, setFrameworks] = useState<FrameworkInfo[]>([])
  const [framework, setFramework] = useState('playwright')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [deviceHeaded, setDeviceHeaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [openId, setOpenId] = useState<number | null>(null)
  const [projectFilter, setProjectFilter] = useState('all')
  const [projectMenu, setProjectMenu] = useState(false)
  const [heal, setHeal] = useState<{ scriptId: number; code: string; diagnosis: string; changes: string[] } | null>(null)
  const [editingScript, setEditingScript] = useState<ScriptAsset | null>(null)
  const [editCode, setEditCode] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  // What the open script needs from Test Data. The environment is not picked
  // here: each application's Test Data says which one its scripts run against.
  const [dataCheck, setDataCheck] = useState<ScriptDataCheck | null>(null)

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

  const projects = useMemo(() => {
    const byId = new Map<number, { id: number; ppm_id: string; name: string }>()
    cases.forEach(c => { if (c.project) byId.set(c.project.id, c.project) })
    return Array.from(byId.values())
  }, [cases])

  const visible = useMemo(
    () =>
      cases.filter(c => {
        if (projectFilter === 'none' ? c.project : projectFilter !== 'all' && String(c.project?.id) !== projectFilter) return false
        if (!query) return true
        return [c.tc_display_id, c.title, c.request_id, c.project?.ppm_id]
          .some(v => String(v ?? '').toLowerCase().includes(query))
      }),
    [cases, projectFilter, query]
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
  const openAt = (i: number) => { setOpenId(ordered[i].id); setHeal(null) }
  const onPrev = openIndex > 0 ? () => openAt(openIndex - 1) : null
  const onNext = openIndex >= 0 && openIndex < ordered.length - 1 ? () => openAt(openIndex + 1) : null
  const closeCase = () => { setOpenId(null); setHeal(null) }
  const openScript = openCase ? scriptOf(openCase) : null

  // What the open script needs from Test Data, in its application's environment.
  const openScriptId = openScript?.id ?? null
  const openScriptCode = openScript?.code ?? ''
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
  const healing = heal && openScript && heal.scriptId === openScript.id ? heal : null
  const brief = openScript ? briefOf(openScript) : null
  const activeFramework = frameworks.find(f => f.name === framework)
  const runnable = activeFramework?.runnable ?? framework === 'playwright'

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

  const handleGenerate = () =>
    runAction('generate', async () => {
      const res = await automationService.generateScripts({
        case_ids: Array.from(selected),
        framework,
        application_id: readSelectedApplicationId(),
        base_url: null,
        regenerate: false
      })
      setSelected(new Set())
      if (res.skipped?.length) {
        setNotice(`${res.generated} generated. ${res.skipped.length} skipped — ` + res.skipped.map(s => `${baseId(s.display_id)}: ${s.reason}`).join(' · '))
      }
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

  const handleDryRun = (script: ScriptAsset) =>
    runAction('dry-run', async () => {
      const res = await automationService.dryRunScripts({ script_ids: [script.id], environment: null, base_url: null, slow_mo_ms: 1000 })
      if (res.refused?.length) setNotice(`Dry run refused — ${res.refused.map((r: any) => r.reason).join(' · ')}`)
    })

  const handleDeviceDryRun = (script: ScriptAsset) =>
    runAction('device-dry-run', async () => {
      const res = await automationService.createDeviceDryRun(script.id, !deviceHeaded)
      try {
        await startDeviceRunner(res.pairing)
      } catch (err) {
        await automationService.cancelRun(res.run_key).catch(() => undefined)
        throw new Error(err instanceof Error && err.message
          ? `${err.message} Start the downloaded device runner, then try again.`
          : 'The local Playwright runner is not available. Start it, then try again.')
      }
      setNotice(`Device dry run started: ${res.run_key}`)
    })

  const handleHeal = (script: ScriptAsset) =>
    runAction('heal', async () => {
      const res = await automationService.healScript(script.id)
      setHeal({ scriptId: script.id, code: res.healed_code, diagnosis: res.diagnosis, changes: res.changes_made ?? [] })
    })

  const keepHeal = () => {
    if (!healing) return
    void runAction('keep-heal', async () => {
      await automationService.editScript(healing.scriptId, healing.code)
      setHeal(null)
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

          <div className="ml-auto flex items-center gap-2">
            <label className="flex h-10 cursor-pointer items-center gap-2 whitespace-nowrap rounded-[12px] border border-[#E8EAEE] bg-white px-3 text-[13.5px] font-semibold text-[#1F2937] hover:border-[#F6D4D5]">
              <input type="checkbox" aria-label="Select all cases" checked={allOn} disabled={!visible.length} onChange={() => setSelected(allOn ? new Set() : new Set(visible.map(c => c.id)))} className="h-4 w-4 accent-[#B71920]" />
              {selected.size ? `${selected.size} selected` : 'Select all'}
            </label>
            <Link
              to="/test-data"
              title="Logins, OTPs and other values scripts read, and the environment each application runs against"
              className="flex h-10 items-center gap-1.5 whitespace-nowrap rounded-[12px] border border-[#E8EAEE] bg-white px-3 text-[13.5px] font-semibold text-[#1F2937] transition hover:border-[#F6D4D5]"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#B71920" strokeWidth="1.9" aria-hidden><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3M15 8l2 2" /></svg>
              Test Data
            </Link>
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
              {busy === 'generate' ? 'Generating…' : selected.size ? `Generate ${selected.size}` : 'Generate'}
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

        {(notice || error || !runnable || (runtime && !runtime.ready)) && (
          <div className="mx-5 mb-3 flex flex-col gap-2">
            {!runnable && <div className="rounded-[12px] border border-[#EBCFA4] bg-[#FFFBF4] px-3.5 py-2 text-[12.5px] text-[#8A5000]">{activeFramework?.label} is generate-only here: scripts can be generated and downloaded, not run.</div>}
            {runnable && runtime && !runtime.ready && <div className="rounded-[12px] border border-[#EBCFA4] bg-[#FFFBF4] px-3.5 py-2 text-[12.5px] text-[#8A5000]">The browser runtime is unavailable, so a dry run would be refused.</div>}
            {notice && <div className="rounded-[12px] border border-[#E8EAEE] bg-[#FCFCFD] px-3.5 py-2 text-[12.5px] text-[#374151]">{notice}</div>}
            {error && <div role="alert" className="rounded-[12px] border border-[#F6D4D5] bg-[#FFF8F8] px-3.5 py-2 text-[12.5px] text-[#7A0B0D]">{error}</div>}
          </div>
        )}

        <div className="app-scroll overflow-x-auto border-t border-[#E8EAEE] bg-[#F8F9FA] px-4 pb-4 pt-3.5">
          <div className="flex min-w-[1060px] flex-col gap-3.5">
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
                          <span>Last dry run</span>
                          <span className="text-right">Steps</span>
                          <span>Script</span>
                        </div>
                        {group.cases.map(testCase => {
                          const script = scriptOf(testCase)
                          const open = testCase.id === openId
                          const request = String(testCase.request_id ?? '')
                          const openRow = () => { setOpenId(testCase.id); setHeal(null) }
                          return (
                            <div
                              key={testCase.id}
                              onClick={openRow}
                              className={`group ${ROW} min-h-[64px] cursor-pointer border-t border-[#F1F2F4] py-2 text-[14px] text-[#1F2937] transition ${
                                open ? 'bg-[#FFF5F5] shadow-[inset_3px_0_0_#B71920]' : selected.has(testCase.id) ? 'bg-[#FFFAFA]' : 'hover:bg-[#FAFAFB]'
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
                                {testCase.test_data_status === 'pending' ? (
                                  <span className="block text-[12px] font-semibold text-[#B45309]" title="A test data value is still missing; fill it in before running.">Test data pending</span>
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
                                {script ? <ScriptStatus script={script} /> : <span className="text-[13px] text-[#9CA3AF]">—</span>}
                                {script?.dry_run?.failed_step && script.dry_run_status === 'failed' ? (
                                  <span className="text-[12px] text-[#A3231C]">at step {script.dry_run.failed_step}</span>
                                ) : script?.dry_run?.duration_seconds != null && script.dry_run_status === 'passed' ? (
                                  <span className="text-[12px] tabular-nums text-[#6B7280]">{clock(script.dry_run.duration_seconds)}</span>
                                ) : null}
                                {script?.dry_run_at && <span className="text-[11.5px] tabular-nums text-[#9CA3AF]">{fullStamp(script.dry_run_at)}</span>}
                              </span>
                              <span className="text-right text-[13.5px] font-semibold tabular-nums text-[#1F2937]">{testCase.steps}</span>
                              <span className="min-w-0">
                                {script ? (
                                  // The script is the way into the case: it opens the drawer.
                                  <button
                                    type="button"
                                    onClick={e => { e.stopPropagation(); openRow() }}
                                    title="Open this script"
                                    className={`inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[12.5px] font-bold transition ${
                                      open
                                        ? 'border-[#B71920] bg-[#B71920] text-white'
                                        : 'border-[#F6D4D5] bg-[#FFF5F5] text-[#B71920] group-hover:border-[#B71920] group-hover:bg-[#B71920] group-hover:text-white'
                                    }`}
                                  >
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><path d="M9 7L4.5 12 9 17M15 7l4.5 5-4.5 5" /></svg>
                                    {activeFramework?.label ?? script.framework} v{script.version}
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><path d="M9 6l6 6-6 6" /></svg>
                                  </button>
                                ) : (
                                  <span className="inline-flex h-7 items-center rounded-full border border-dashed border-[#D6D9DF] px-2.5 text-[12.5px] font-semibold text-[#9CA3AF]">Not generated</span>
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
      <SideDrawer label={`${baseId(openCase.tc_display_id)} script`} width="lg:w-[56vw] lg:min-w-[720px] lg:max-w-[1040px]" onClose={closeCase} onPrev={onPrev} onNext={onNext} paused={Boolean(editingScript)}>
        <div className="flex-shrink-0 border-b border-[#E8EAEE] px-6 pb-3.5 pt-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-[#6B7280]">
                <span className="text-[15px] font-bold text-[#B71920]">{baseId(openCase.tc_display_id)}</span>
                {openCase.project && (
                  <span className="truncate" title={`${openCase.project.ppm_id} - ${openCase.project.name}`}>
                    <span className="font-mono font-semibold text-[#941216]">{openCase.project.ppm_id}</span> - {openCase.project.name}
                  </span>
                )}
                {openCase.created_by && <span>· by {openCase.created_by}</span>}
                <span>· {openCase.steps} step{openCase.steps === 1 ? '' : 's'}</span>
              </div>
              <h2 className="m-0 mt-1 text-[18px] font-bold leading-[1.3] text-[#1F2937]">{openCase.title}</h2>
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
            <div className="flex-shrink-0 border-b border-[#E8EAEE] px-6 py-3">
              <div className="mb-2.5 flex flex-wrap items-center gap-1.5 text-[13px] text-[#6B7280]">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><circle cx="12" cy="12" r="8.5" /><path d="M10.5 9l4.5 3-4.5 3z" /></svg>
                {healing ? (
                  <span>Review the fix, then keep it and dry run again.</span>
                ) : brief && (openScript.dry_run_status === 'running' || openScript.dry_run_status === 'queued') ? (
                  <>Dry run in progress · <Link to={`/automation/runs/${brief.run_key}`} className="font-semibold text-[#B71920] hover:underline">Watch it</Link></>
                ) : brief ? (
                  <>
                    {openScript.dry_run_status === 'passed'
                      ? 'Last dry run passed'
                      : brief.failed_step
                        ? `Last dry run failed at step ${brief.failed_step}`
                        : 'Last dry run failed'}
                    {brief.duration_seconds != null ? ` · ${clock(brief.duration_seconds)}` : ''} ·{' '}
                    <Link to={`/automation/runs/${brief.run_key}`} className="font-semibold text-[#B71920] hover:underline">Open evidence</Link>
                  </>
                ) : (
                  <span>Not dry-run yet.</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {healing ? (
                  <>
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
                    <button
                      type="button"
                      onClick={() => handleDryRun(openScript)}
                      disabled={busy !== null || !canExecute || !runnable || openScript.dry_run_status === 'running' || openScript.dry_run_status === 'queued'}
                      title={!runnable ? `${activeFramework?.label} is generate-only — no runner exists for it.` : 'Run the script once on this host; the run appears in Runs'}
                      className={
                        failed
                          ? 'flex h-10 items-center gap-2 rounded-[12px] border border-[#E8EAEE] bg-white px-4 text-[14px] font-bold text-[#1F2937] transition hover:border-[#F6D4D5] disabled:opacity-50'
                          : 'flex h-10 items-center justify-center gap-2 rounded-[12px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-4 text-[14px] font-bold text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] disabled:opacity-50'
                      }
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden><circle cx="12" cy="12" r="8.5" /><path d="M10.5 9l4.5 3-4.5 3z" /></svg>
                      {busy === 'dry-run' ? 'Queueing…' : 'Dry run'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeviceDryRun(openScript)}
                      disabled={busy !== null || !canExecute || !runnable || openScript.dry_run_status === 'running' || openScript.dry_run_status === 'queued'}
                      title={!runnable ? `${activeFramework?.label} is generate-only — no runner exists for it.` : `Run ${deviceHeaded ? 'with a visible browser' : 'headlessly'} using Playwright installed on this device; the Linux server only coordinates the run`}
                      className="flex h-10 items-center gap-2 whitespace-nowrap rounded-[12px] border border-[#B71920] bg-white px-4 text-[14px] font-bold text-[#B71920] transition hover:bg-[#FFF5F5] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden><rect x="4" y="3" width="16" height="13" rx="2" /><path d="M8 21h8M12 16v5" /></svg>
                      {busy === 'device-dry-run' ? 'Connecting…' : 'Run on device'}
                    </button>
                    <select aria-label="Run on device browser mode" value={deviceHeaded ? 'headed' : 'headless'} onChange={event => setDeviceHeaded(event.target.value === 'headed')}
                      disabled={busy !== null} className="h-10 rounded-[12px] border border-[#E8EAEE] bg-white px-2.5 text-[13px] font-semibold text-[#374151] disabled:opacity-50">
                      <option value="headless">Headless</option>
                      <option value="headed">Headed</option>
                    </select>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => { setEditingScript(openScript); setEditCode(openScript.code || ''); setEditError(null) }}
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

            {healing ? (
              <div className="flex-shrink-0 border-b border-[#D9CCF5] bg-[#F6F2FF] px-6 py-3">
                <div className="text-[11.5px] font-semibold uppercase tracking-[0.12em] text-[#6D28D9]">AI fix ready</div>
                <p className="mt-1 text-[13px] text-[#4C1D95]">{healing.diagnosis}</p>
                {healing.changes.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-[12.5px] text-[#5B21B6]">
                    {healing.changes.slice(0, 4).map((change, i) => <li key={i}>{change}</li>)}
                  </ul>
                )}
              </div>
            ) : (
              <div className="flex-shrink-0 px-6 py-3.5">
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
                          <>
                            Test data missing for {environmentLabel(dataCheck.environment)}: {dataCheck.missing.map(readableName).join(', ')} —{' '}
                            <Link to={dataCheck.application ? `/test-data?app=${dataCheck.application.id}` : '/test-data'} className="font-semibold text-[#B71920] hover:underline">set it in Test Data</Link>
                          </>
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
              </div>
            )}

            <CodeBlock code={code} highlight={highlight} />

          </>
        )}
      </SideDrawer>
      )}

      {editingScript ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(17,24,39,0.55)] p-4"
          onMouseDown={e => { if (e.target === e.currentTarget && !savingEdit) setEditingScript(null) }}
          role="dialog"
          aria-modal="true"
          aria-label={`Edit ${editingScript.file_name}`}
        >
          <div className="flex h-[88vh] w-full max-w-[1100px] flex-col overflow-hidden rounded-[20px] border border-[#E8EAEE] bg-white shadow-[0_28px_70px_rgba(15,23,42,0.22)]">
            <div className="flex items-center gap-3 border-b border-[#E8EAEE] px-5 py-3.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-bold text-[#1F2937]">Edit script · {baseId(editingScript.test_case_display_id ?? '')}</div>
                <div className="truncate font-mono text-[12px] text-[#6B7280]">{editingScript.file_name} · v{editingScript.version} · {editCode.split('\n').length} lines</div>
              </div>
              <button type="button" onClick={() => !savingEdit && setEditingScript(null)} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-[10px] text-[#6B7280] hover:bg-[#F4F5F7]">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            {editError && <div role="alert" className="mx-5 mt-3 rounded-[12px] border border-[#F6D4D5] bg-[#FFF8F8] px-3.5 py-2 text-[12.5px] text-[#7A0B0D]">{editError}</div>}
            <textarea
              value={editCode}
              onChange={e => setEditCode(e.target.value)}
              onKeyDown={e => {
                if (e.key !== 'Tab') return
                e.preventDefault()
                const target = e.currentTarget
                const start = target.selectionStart
                const end = target.selectionEnd
                setEditCode(editCode.substring(0, start) + '  ' + editCode.substring(end))
                window.setTimeout(() => { target.selectionStart = target.selectionEnd = start + 2 }, 0)
              }}
              spellCheck={false}
              className="m-5 flex-1 resize-none rounded-[14px] bg-[#1B1B1F] p-4 font-mono text-[13px] leading-[1.7] text-[#E5E7EB] outline-none"
            />
            <div className="flex items-center gap-2 border-t border-[#E8EAEE] bg-[#FCFCFD] px-5 py-3">
              <button type="button" onClick={() => setEditCode(editingScript.code || '')} disabled={savingEdit || editCode === editingScript.code} className="text-[12.5px] font-semibold text-[#6B7280] hover:text-[#1F2937] disabled:opacity-40">
                Reset to current code
              </button>
              <div className="ml-auto flex gap-2">
                <button type="button" onClick={() => setEditingScript(null)} disabled={savingEdit} className="flex h-9 items-center rounded-[12px] border border-[#E8EAEE] bg-white px-4 text-[13px] font-bold text-[#1F2937]">Cancel</button>
                <button type="button" onClick={() => void handleSaveEdit()} disabled={savingEdit || !canExecute} className="flex h-9 items-center rounded-[12px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-4 text-[13px] font-bold text-white disabled:opacity-50">
                  {savingEdit ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

export default ScriptLab
