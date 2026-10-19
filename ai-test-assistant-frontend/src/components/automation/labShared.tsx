/**
 * --- Automation Lab: what the projects list and the workspace share -------------
 *
 * A case's state (failing, running, passed, not run, test data, no script), a
 * project's summary computed from the Lab listing -- no backend of its own --
 * the checks a script passes before it runs, the code with its failing step
 * marked, and the popup frame every job opens in.
 */
import React, { useEffect, useRef } from 'react'
import { parseServerTime } from './runPresentation'
import type { DryRunBrief, ScriptAsset, ScriptLabCase } from '../../types/automation'

export const CARD = 'rounded-[16px] border border-[#E8EAEE] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]'
export const BTN = 'inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-[10px] border border-[#E8EAEE] bg-white px-3.5 text-[13px] font-bold text-[#1F2937] transition hover:border-[#F6D4D5] disabled:cursor-not-allowed disabled:opacity-50'
export const PRIMARY = 'inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-[10px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-3.5 text-[13px] font-bold text-white shadow-[0_6px_16px_rgba(183,25,32,0.22)] transition hover:opacity-95 disabled:cursor-not-allowed'
export const PURPLE = 'inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-[10px] bg-[#6D28D9] px-3.5 text-[13px] font-bold text-white shadow-[0_6px_16px_rgba(109,40,217,0.22)] transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50'
export const CHIP = 'inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-[11.5px] font-semibold'

export const FRAMEWORK_KEY = 'automationLab.framework'
export const readFramework = () => {
  try { return window.localStorage.getItem(FRAMEWORK_KEY) || 'playwright' } catch { return 'playwright' }
}
export const writeFramework = (name: string) => {
  try { window.localStorage.setItem(FRAMEWORK_KEY, name) } catch { /* a convenience only */ }
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

// --- Glyphs --------------------------------------------------------------------------

export const PlayGlyph = () => (
  <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M6 4l14 8-14 8z" /></svg>
)
export const StarGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 3l1.8 4.9L19 9.7l-4.2 3.1 1.5 5.2L12 15l-4.3 3 1.5-5.2L5 9.7l5.2-1.8z" /></svg>
)
export const DownloadGlyph = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 4v11M7 10l5 5 5-5M5 19h14" /></svg>
)
export const CloseGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
)
export const ChevronGlyph = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M6 9h12l-6 7z" /></svg>
)

// --- A case's script and state ---------------------------------------------------------

/** The current script for the framework: the highest version. */
export const scriptOf = (testCase: ScriptLabCase, framework: string): ScriptAsset | null =>
  testCase.scripts.filter(s => s.framework === framework).sort((a, b) => b.version - a.version)[0] ?? null

export type CaseState = 'failing' | 'running' | 'passed' | 'not_run' | 'no_script'

export const caseState = (testCase: ScriptLabCase, framework: string): CaseState => {
  const script = scriptOf(testCase, framework)
  if (!script) return 'no_script'
  const status = script.dry_run_status
  if (status === 'running' || status === 'queued') return 'running'
  if (status === 'failed' || status === 'blocked') return 'failing'
  if (status === 'passed') return 'passed'
  if (script.static_gate_result && !script.static_gate_result.passed) return 'failing'
  return 'not_run'
}

export const needsData = (testCase: ScriptLabCase) => testCase.test_data_status === 'pending'

/** "Dry run failed · step 1", "Dry run passed", "Not run"... and its colours. */
export const dryRunChip = (script: ScriptAsset | null): { label: string; tone: string } => {
  if (!script) return { label: 'No script', tone: 'border border-dashed border-[#D6D9DF] bg-white text-[#6B7280]' }
  const status = script.dry_run_status
  const brief: DryRunBrief | null = script.dry_run ?? null
  if (status === 'passed') return { label: brief?.is_healed ? 'Dry run passed · healed' : 'Dry run passed', tone: 'bg-[#EAF7EF] text-[#136B34]' }
  if (status === 'failed') return { label: brief?.failed_step ? `Dry run failed · step ${brief.failed_step}` : 'Dry run failed', tone: 'bg-[#FEEBEC] text-[#A3231C]' }
  if (status === 'running') return { label: 'Dry run running', tone: 'bg-[#EEF4FF] text-[#1D4ED8]' }
  if (status === 'queued') return { label: 'Dry run queued', tone: 'bg-[#EEF4FF] text-[#1D4ED8]' }
  if (status === 'blocked') return { label: 'Dry run blocked', tone: 'bg-[#FFF4E5] text-[#8A5000]' }
  if (script.static_gate_result && !script.static_gate_result.passed) return { label: 'Static gate failed', tone: 'bg-[#FFF4E5] text-[#8A5000]' }
  return { label: 'Not run', tone: 'bg-[#F4F5F7] text-[#374151]' }
}

// --- Projects, computed from the Lab listing ----------------------------------------------

export interface ProjectSummary {
  key: string
  id: number | null
  ppm: string | null
  name: string
  cases: ScriptLabCase[]
  scripted: number
  passed: number
  failed: number
  running: number
  notRun: number
  needScripts: number
  testData: number
  approvedAt: string | null
  approvedBy: string | null
  lastRunAt: string | null
  /** The latest change to any case, script or dry run in the project. */
  lastUpdatedAt: string | null
}

export const projectKeyOf = (testCase: ScriptLabCase) => (testCase.project ? String(testCase.project.id) : 'none')

export const summarise = (cases: ScriptLabCase[], framework: string): ProjectSummary[] => {
  const byKey = new Map<string, ProjectSummary>()
  cases.forEach(c => {
    const key = projectKeyOf(c)
    if (!byKey.has(key)) {
      byKey.set(key, {
        key, id: c.project?.id ?? null, ppm: c.project?.ppm_id ?? null, name: c.project?.name ?? 'No project', cases: [],
        scripted: 0, passed: 0, failed: 0, running: 0, notRun: 0, needScripts: 0, testData: 0,
        approvedAt: null, approvedBy: null, lastRunAt: null, lastUpdatedAt: null
      })
    }
    const p = byKey.get(key)!
    p.cases.push(c)
    const state = caseState(c, framework)
    const script = scriptOf(c, framework)
    if (script) p.scripted += 1
    if (state === 'passed') p.passed += 1
    else if (state === 'failing') p.failed += 1
    else if (state === 'running') p.running += 1
    else if (state === 'not_run') p.notRun += 1
    else p.needScripts += 1
    if (needsData(c)) p.testData += 1
    // The earliest arrival is when the project was approved into the Lab.
    if (c.created_at && (!p.approvedAt || c.created_at < p.approvedAt)) { p.approvedAt = c.created_at; p.approvedBy = c.created_by ?? p.approvedBy }
    if (!p.approvedBy && c.created_by) p.approvedBy = c.created_by
    if (script?.dry_run_at && (!p.lastRunAt || script.dry_run_at > p.lastRunAt)) p.lastRunAt = script.dry_run_at
    const stamps = [c.created_at, c.updated_at, ...c.scripts.flatMap(s => [s.created_at, s.updated_at, s.dry_run_at, s.dry_run?.completed_at])]
    for (const stamp of stamps) {
      const at = parseServerTime(stamp)
      if (at && (!p.lastUpdatedAt || at.getTime() > (parseServerTime(p.lastUpdatedAt)?.getTime() ?? 0))) p.lastUpdatedAt = stamp!
    }
  })
  const list = Array.from(byKey.values())
  return [...list.filter(p => p.key !== 'none'), ...list.filter(p => p.key === 'none')]
}

export const attentionOf = (p: ProjectSummary) => p.failed + p.testData + p.needScripts

/** "2 min ago", "3 h ago", or null when it was more than a day ago. */
export const ago = (value: string | null | undefined, now = Date.now()) => {
  const date = parseServerTime(value)
  if (!date) return null
  const minutes = Math.max(0, Math.round((now - date.getTime()) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`
  return null
}

// --- What the script says before it runs ----------------------------------------------------

/** Each `await test.step(` opens one step; returns the lines of each block. */
export const stepBlocks = (code: string): { start: number; end: number }[] => {
  const lines = code.split('\n')
  // Only real step calls: helper comments above the test mention test.step() too.
  const starts = lines.map((line, i) => (/^\s*await test\.step\(/.test(line) ? i : -1)).filter(i => i >= 0)
  return starts.map((start, index) => ({ start, end: (starts[index + 1] ?? lines.length) - 1 }))
}

export type Check = { tone: 'ok' | 'warn' | 'bad'; text: React.ReactNode }

export const beforeRunning = (script: ScriptAsset): Check[] => {
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
    checks.push({ tone: unresolved ? 'warn' : 'ok', text: `${found} of ${blocks.length} controls found in the Knowledge Base` })
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

export const CheckIcon: React.FC<{ tone: Check['tone'] }> = ({ tone }) =>
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

/** The action lines of the step a dry run failed on. */
export const failedLines = (code: string, step: number | null | undefined): Set<number> => {
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

/** The script, dark, with the failing step's lines marked. */
export const CodeBlock: React.FC<{ code: string; highlight: Set<number>; className?: string }> = ({ code, highlight, className = '' }) => {
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
    const box = ref.current
    const offset = row.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
    box.scrollTop = Math.max(0, offset - (Number.isFinite(marked) ? 60 : 0))
  }, [first, marked, code])
  return (
    <div ref={ref} className={`app-scroll overflow-auto bg-[#1B1B1F] py-3 font-mono text-[12px] leading-[1.75] ${className}`}>
      {lines.map((line, i) => {
        const comment = line.trim().startsWith('//')
        const keyword = /^\s*(test\(|import |export |const |\}\);)/.test(line)
        return (
          <div
            key={i}
            data-line={i}
            className={`whitespace-pre px-4 ${highlight.has(i) ? 'bg-[rgba(220,38,38,0.32)] shadow-[inset_3px_0_0_#EF4444]' : ''} ${
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

// --- Popup frame --------------------------------------------------------------------------------

/**
 * A job's popup, over the page. Esc and the backdrop close it -- or, for a
 * live run, minimise it: the run keeps going either way. One at a time: a
 * popup never opens another, it is replaced.
 */
export const Popup: React.FC<{
  label: string
  width?: string
  onClose: () => void
  /** While the job is busy, the backdrop and Esc leave it alone. */
  locked?: boolean
  children: React.ReactNode
}> = ({ label, width = 'max-w-[800px]', onClose, locked, children }) => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !locked) { event.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, locked])
  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-[rgba(17,24,39,0.42)] px-4 pb-6 pt-[12vh]"
      onMouseDown={e => { if (e.target === e.currentTarget && !locked) onClose() }}
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <div className={`flex w-full ${width} flex-col overflow-hidden rounded-[18px] border border-[#E8EAEE] bg-white shadow-[0_28px_70px_rgba(15,23,42,0.24)]`}>
        {children}
      </div>
    </div>
  )
}

export const PopupClose: React.FC<{ onClick: () => void; label?: string }> = ({ onClick, label = 'Close' }) => (
  <button type="button" onClick={onClick} aria-label={label} className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-[#E8EAEE] text-[#6B7280] hover:bg-[#F4F5F7]">
    <CloseGlyph />
  </button>
)
