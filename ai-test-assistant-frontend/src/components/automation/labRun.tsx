/**
 * --- One run, as the Automation Lab shows it ------------------------------------
 *
 * The pieces the Runs drawer used to own -- the five-stage pipeline, the test
 * case's steps, the live runner log, the evidence and the failure -- now shown
 * in two places: the live dry-run popup, and the case's Latest run view once
 * the run settles. Same data, same rules; the cards are the compact ones the
 * Lab's mockups draw.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import automationService from '../../services/automationService'
import { parseServerTime } from './runPresentation'
import { isTerminal } from '../../types/automation'
import type { ArtifactKind, RunDetail, RunResultRow, RunSummary } from '../../types/automation'

// --- Formatting -------------------------------------------------------------------

export const baseId = (id: string | null | undefined) => String(id ?? '').replace(/\s*\(#[^)]*\)\s*$/, '')

export const clock = (seconds: number | null | undefined) => {
  if (seconds == null || !Number.isFinite(seconds)) return '00:00'
  const s = Math.max(0, Math.round(seconds))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** "10s" under a minute, else "01:05": how long a settled run took. */
export const shortDuration = (seconds: number | null | undefined) => {
  if (seconds == null || !Number.isFinite(seconds)) return ''
  const s = Math.max(0, Math.round(seconds))
  return s < 60 ? `${s}s` : clock(s)
}

export const hhmm = (value: string | null | undefined) => {
  const date = parseServerTime(value)
  if (!date) return ''
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The date's parts in Dubai time; Intl's en-GB would say "Sept". */
const dubaiParts = (value: string | null | undefined) => {
  const date = parseServerTime(value)
  if (!date) return null
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'numeric', year: 'numeric' })
      .formatToParts(date).map(p => [p.type, p.value])
  )
  return { day: parts.day, month: MONTHS[Number(parts.month) - 1], year: parts.year }
}

/** "14 Oct" in Dubai time. */
export const dayMonth = (value: string | null | undefined) => {
  const p = dubaiParts(value)
  return p ? `${p.day} ${p.month}` : ''
}

/** "14 Oct 09:55" in Dubai time. */
export const dayTime = (value: string | null | undefined) => {
  const day = dayMonth(value)
  return day ? `${day} ${hhmm(value)}` : ''
}

/** "07 Oct 2026, 14:05" in Dubai time. */
export const fullStamp = (value: string | null | undefined) => {
  const p = dubaiParts(value)
  return p ? `${p.day} ${p.month} ${p.year}, ${hhmm(value)}` : ''
}

export const elapsedSeconds = (run: RunSummary, now: number) => {
  if (run.duration_seconds != null && isTerminal(run.status)) return run.duration_seconds
  const started = parseServerTime(run.started_at ?? run.created_at)
  return started ? (now - started.getTime()) / 1000 : null
}

export const frameworkLabel = (name: string) => name.charAt(0).toUpperCase() + name.slice(1)

export const speedLabel = (ms: number | null | undefined) =>
  ms == null ? null : ms >= 2000 ? `Debug (${ms / 1000}s)` : ms >= 1000 ? `Safe / WAF (${ms / 1000}s)` : ms > 0 ? `Balanced (${ms / 1000}s)` : 'Fast / CI (0s)'

/** "dry run", "rerun", "heal & rerun" -- how a run was started. */
export const modeLabel = (run: RunSummary) =>
  run.is_healed ? 'heal & rerun' : run.mode === 'dry_run' ? 'dry run' : run.mode === 'rerun' ? 'rerun' : run.mode === 'discovery' ? 'discovery' : 'run'

// --- A run's state ------------------------------------------------------------------

export type Tone = 'running' | 'failed' | 'passed' | 'blocked' | 'queued' | 'cancelled'

export const toneOf = (run: RunSummary): Tone => {
  if (run.status === 'running') return 'running'
  if (run.status === 'queued') return 'queued'
  if (run.status === 'cancelled') return 'cancelled'
  if (run.outcome === 'passed') return 'passed'
  if (run.outcome === 'blocked') return 'blocked'
  return 'failed'
}

export const TONE_CHIP: Record<Tone, string> = {
  running: 'bg-[#EEF4FF] text-[#1D4ED8]',
  queued: 'bg-[#EEF4FF] text-[#1D4ED8]',
  failed: 'bg-[#FEEBEC] text-[#A3231C]',
  passed: 'bg-[#EAF7EF] text-[#136B34]',
  blocked: 'bg-[#FFF4E5] text-[#8A5000]',
  cancelled: 'bg-[#F4F5F7] text-[#374151]'
}

export const TONE_LABEL: Record<Tone, string> = {
  running: 'Running',
  queued: 'Queued',
  failed: 'Failed',
  passed: 'Passed',
  blocked: 'Blocked',
  cancelled: 'Cancelled'
}

// --- Steps, from the spec and the runner's progress ------------------------------------

interface StepHistory {
  n: number
  title?: string | null
  ok?: boolean
  ms?: number | null
  error?: string | null
}

export interface StepProgress {
  total?: number | null
  current?: number | null
  title?: string | null
  status?: string | null
  healed?: boolean | null
  history?: StepHistory[] | null
}

export const progressOf = (run: RunSummary): StepProgress | null =>
  ((run.run_metadata as any)?.step_progress ?? null) as StepProgress | null

/** The step a failed run stopped at, from its progress. */
export const failedStepOf = (run: RunSummary): number | null =>
  progressOf(run)?.history?.find(h => h.ok === false)?.n ?? null

const cleanTitle = (title: string) => title.replace(/^\s*\d+[.)]\s*/, '').trim()

const specStepTitles = (code: string | null | undefined): string[] => {
  const titles: string[] = []
  const pattern = /test\.step\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(code || ''))) {
    const text = match[2].replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\\(.)/g, '$1')
    titles.push(cleanTitle(text))
  }
  return titles
}

export type StepRow = { n: number; title: string; state: 'passed' | 'failed' | 'running' | 'pending'; ms: number | null; error: string | null }

export const stepRows = (run: RunDetail): StepRow[] => {
  const progress = progressOf(run)
  const titles = specStepTitles(run.spec?.code ?? (run.run_metadata as any)?.code)
  const history = new Map((progress?.history ?? []).map(h => [h.n, h]))
  const resultFallback = isTerminal(run.status) && !titles.length && !(progress?.history?.length)
    ? run.results
    : []
  const total = Math.max(progress?.total ?? 0, titles.length, progress?.history?.length ?? 0, resultFallback.length)
  const live = !isTerminal(run.status)
  const current = progress?.current ?? 0
  return Array.from({ length: total }, (_, i) => {
    const n = i + 1
    const done = history.get(n)
    const fallback = resultFallback[i]
    const title = titles[i] || (done?.title ? cleanTitle(done.title) : fallback?.test_name ? cleanTitle(fallback.test_name) : n === current && progress?.title ? cleanTitle(progress.title) : `Step ${n}`)
    if (done) return { n, title, state: done.ok === false ? 'failed' : 'passed', ms: done.ms ?? null, error: done.error ?? null }
    if (fallback) return { n, title, state: fallback.status === 'pass' ? 'passed' : fallback.status === 'skip' ? 'pending' : 'failed', ms: fallback.duration_ms ?? null, error: fallback.error_message ?? null }
    if (live && n === current) return { n, title, state: 'running', ms: null, error: null }
    return { n, title, state: 'pending', ms: null, error: null }
  })
}

// --- Icons ------------------------------------------------------------------------------

export const DoneDot: React.FC<{ size?: number }> = ({ size = 20 }) => (
  <span className="flex flex-shrink-0 items-center justify-center rounded-full bg-[#15803D]" style={{ width: size, height: size }}>
    <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" aria-hidden><path d="M5 12l5 5 9-10" /></svg>
  </span>
)

export const FailDot: React.FC<{ size?: number }> = ({ size = 20 }) => (
  <span className="flex flex-shrink-0 items-center justify-center rounded-full bg-[#DC2626]" style={{ width: size, height: size }}>
    <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
  </span>
)

export const SpinDot: React.FC<{ size?: number }> = ({ size = 20 }) => (
  <span className="box-border block flex-shrink-0 animate-spin rounded-full border-[2.5px] border-[#DBE7FE] border-t-[#2563EB]" style={{ width: size, height: size }} />
)

export const EmptyDot: React.FC<{ size?: number; dashed?: boolean }> = ({ size = 20, dashed }) => (
  <span className={`box-border block flex-shrink-0 rounded-full border-2 ${dashed ? 'border-dashed' : ''} border-[#D6D9DF] bg-white`} style={{ width: size, height: size }} />
)

export const SuggestDot: React.FC<{ size?: number }> = ({ size = 20 }) => (
  <span className="flex flex-shrink-0 items-center justify-center rounded-full bg-[#7C3AED]" style={{ width: size, height: size }}>
    <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="#fff" aria-hidden><path d="M12 3l1.8 4.9L19 9.7l-4.2 3.1 1.5 5.2L12 15l-4.3 3 1.5-5.2L5 9.7l5.2-1.8z" /></svg>
  </span>
)

// --- Pipeline -------------------------------------------------------------------------------

type StageState = 'done' | 'running' | 'failed' | 'suggest' | 'pending'

const StageIcon: React.FC<{ state: StageState }> = ({ state }) =>
  state === 'done' ? <DoneDot size={18} />
    : state === 'failed' ? <FailDot size={18} />
      : state === 'suggest' ? <SuggestDot size={18} />
        : state === 'running' ? <SpinDot size={18} />
          : <EmptyDot size={18} />

const pipelineOf = (run: RunDetail, rows: StepRow[]) => {
  const meta = (run.run_metadata ?? {}) as any
  const phase = Number(meta.phase_step) || (run.status === 'queued' ? 1 : 4)
  const code: string = run.spec?.code ?? meta.code ?? ''
  const assertions = (code.match(/expect\(/g) ?? []).length
  const env = run.environment || 'Environment'
  const failedStep = rows.find(r => r.state === 'failed')
  const tone = toneOf(run)
  const finished = isTerminal(run.status)
  const onDevice = run.execution_target === 'device'

  const state = (n: number): StageState => {
    // A step already failed: Execute is red even while evidence is still being saved.
    if (!finished) return n === 4 && failedStep && phase > 4 ? 'failed' : n < phase ? 'done' : n === phase ? 'running' : 'pending'
    if (tone === 'passed') return 'done'
    if (tone === 'cancelled') return n < phase ? 'done' : n === phase ? 'failed' : 'pending'
    // Failed or blocked: where it stopped is red; self-heal after it.
    const stoppedAt = run.total_tests > 0 || rows.some(r => r.state !== 'pending') ? 4 : Math.min(phase, 4)
    if (n < stoppedAt) return 'done'
    if (n === stoppedAt) return 'failed'
    if (n === 5 && stoppedAt === 4) return run.healing_diagnosis && !run.is_healed ? 'suggest' : 'done'
    return 'pending'
  }

  return [
    { n: 1, title: 'Readiness', detail: state(1) === 'running' ? 'Checking the toolchain' : `${env} reachable` },
    { n: 2, title: 'Grounding', detail: rows.length ? `${rows.length} of ${rows.length} controls` : 'Resolving controls' },
    { n: 3, title: 'Spec', detail: `${assertions} assertion${assertions === 1 ? '' : 's'}` },
    {
      n: 4,
      title: 'Execute',
      detail:
        state(4) === 'running' ? (onDevice ? 'Running on the device' : 'Browser running')
          : state(4) === 'failed' ? (failedStep ? `Failed at step ${failedStep.n}` : tone === 'cancelled' ? 'Cancelled' : 'Did not complete')
            : state(4) === 'done' ? `${rows.filter(r => r.state === 'passed').length} of ${rows.length} steps passed`
              : 'Waiting'
    },
    {
      n: 5,
      title: 'Self-heal & evidence',
      detail:
        state(5) === 'suggest' ? 'Fix suggested'
          : state(5) === 'done' ? (run.is_healed ? 'Healed · evidence saved' : 'Evidence saved')
            : 'Waiting'
    }
  ].map(stage => ({ ...stage, state: state(stage.n) }))
}

export const Pipeline: React.FC<{ run: RunDetail; rows: StepRow[] }> = ({ run, rows }) => (
  <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
    {pipelineOf(run, rows).map(stage => (
      <div key={stage.n} className="min-w-0 rounded-[12px] border border-[#E8EAEE] bg-white px-3 py-2.5">
        <div className="flex items-center gap-2 text-[12.5px] font-bold text-[#1F2937]">
          <StageIcon state={stage.state} />
          <span className="leading-tight">{stage.title}</span>
        </div>
        <div className="mt-1 truncate text-[11.5px] text-[#6B7280]" title={stage.detail}>{stage.detail}</div>
      </div>
    ))}
  </div>
)

// --- Steps ------------------------------------------------------------------------------------

export const StepsCard: React.FC<{ rows: StepRow[] }> = ({ rows }) => {
  const passed = rows.filter(r => r.state === 'passed').length
  return (
    <div className="rounded-[14px] border border-[#E8EAEE] bg-white px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#6B7280]">Test case steps</span>
        <span className="text-[13px] font-bold text-[#1F2937]">{passed} / {rows.length} passed</span>
      </div>
      {rows.length === 0 ? (
        <div className="px-1 py-3 text-[12.5px] text-[#9CA3AF]">Steps appear once the spec starts.</div>
      ) : (
        <ol className="flex flex-col gap-0.5">
          {rows.map(row => (
            <li
              key={row.n}
              className={`grid grid-cols-[20px_16px_minmax(0,1fr)_auto] items-center gap-2 rounded-[10px] px-1.5 py-[6px] text-[13px] ${
                row.state === 'running' ? 'bg-[#EEF4FF]' : row.state === 'failed' ? 'bg-[#FEF2F2]' : ''
              }`}
            >
              {row.state === 'passed' ? <DoneDot size={18} /> : row.state === 'failed' ? <FailDot size={18} /> : row.state === 'running' ? <SpinDot size={18} /> : <EmptyDot size={18} />}
              <span className="text-[12px] text-[#9CA3AF]">{row.n}</span>
              <span className={`truncate ${row.state === 'pending' ? 'text-[#374151]' : 'text-[#1F2937]'}`} title={row.title}>{row.title}</span>
              <span className="text-[12px] tabular-nums text-[#9CA3AF]">
                {row.state === 'running' ? 'now' : row.ms != null ? `${(row.ms / 1000).toFixed(1)}s` : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

// --- Live log --------------------------------------------------------------------------------

export const LiveLog: React.FC<{ run: RunDetail; rows: StepRow[]; live: boolean }> = ({ run, rows, live }) => {
  const runKey = run.run_key
  const [text, setText] = useState('')
  const boxRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    let cancelled = false
    let timer: number | null = null
    const tick = async () => {
      try {
        const next = await automationService.getRunLog(runKey)
        if (!cancelled) setText(next)
      } catch {
        /* the log may not exist yet */
      }
      if (!cancelled && live) timer = window.setTimeout(tick, 2000)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [runKey, live])
  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [text])
  const lines = text.split('\n').slice(-400)
  const fallbackLines = rows.map(row => {
    const mark = row.state === 'passed' ? 'PASS' : row.state === 'failed' ? 'FAIL' : row.state === 'running' ? 'RUN ' : 'WAIT'
    return `[${mark}] ${row.n}. ${row.title}${row.ms != null ? ` (${row.ms} ms)` : ''}`
  })
  const fallback = fallbackLines.length
    ? fallbackLines
    : [`[RUN ] ${(run.run_metadata as any)?.execution_phase || (run.run_metadata as any)?.device_agent?.message || (run.execution_target === 'device' ? 'Running locally on this device. Browser video is not streamed to Studio.' : 'Runner connected; waiting for the first step.')}`]
  return (
    <div className="flex min-h-[150px] flex-col overflow-hidden rounded-[14px] bg-[#1B1B1F]">
      <div className="flex items-center justify-between px-3.5 pb-1 pt-2.5">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-[#FCA5A5]">
          {run.execution_target === 'device' ? 'Device execution status' : 'Live runner log'}
        </span>
        {live && (
          <span className="flex items-center gap-1.5 text-[11px] text-[#D1D5DB]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#EF4444]" />{run.execution_target === 'device' ? 'local progress' : 'streaming'}
          </span>
        )}
      </div>
      <div ref={boxRef} className="app-scroll max-h-[240px] min-h-0 flex-1 overflow-auto px-3.5 pb-3 font-mono text-[11.5px] leading-[1.7] text-[#E5E7EB]">
        {(text ? lines : fallback).map((line, i) => (
          <div key={i} className={`whitespace-pre-wrap break-words ${/✓|\bPASS\b/.test(line) ? 'text-[#86EFAC]' : ''}`}>{line || ' '}</div>
        ))}
        {live && <span className="inline-block h-3.5 w-1.5 animate-pulse bg-[#60A5FA] align-middle" />}
      </div>
    </div>
  )
}

// --- Evidence ---------------------------------------------------------------------------------

type EvidenceTab = ArtifactKind | 'console' | 'network' | 'log'

const asList = (value: unknown): unknown[] => {
  if (value == null || value === '') return []
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      return value.split('\n').filter(Boolean)
    }
  }
  return [value]
}

const entryText = (entry: unknown) => {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object') {
    const e = entry as Record<string, unknown>
    const main = [e.type ?? e.level ?? e.method, e.status, e.text ?? e.message ?? e.url].filter(v => v != null && v !== '').join(' ')
    return main || JSON.stringify(entry)
  }
  return String(entry)
}

const saveHref = (href: string, name: string) => {
  const link = document.createElement('a')
  link.href = href
  link.download = name
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

export const Evidence: React.FC<{ run: RunDetail; result: RunResultRow | null }> = ({ run, result }) => {
  const consoleLogs = useMemo(() => asList(result?.console_logs), [result])
  const networkLogs = useMemo(() => asList(result?.network_logs), [result])
  const tabs: { key: EvidenceTab; label: string; enabled: boolean }[] = [
    { key: 'screenshot', label: 'Screenshot', enabled: Boolean(result?.evidence?.screenshot) },
    { key: 'video', label: 'Video', enabled: Boolean(result?.evidence?.video) },
    { key: 'trace', label: 'Trace', enabled: Boolean(result?.evidence?.trace) },
    { key: 'console', label: `Console · ${consoleLogs.length}`, enabled: consoleLogs.length > 0 },
    { key: 'network', label: `Network · ${networkLogs.length}`, enabled: networkLogs.length > 0 },
    { key: 'log', label: 'Log', enabled: run.has_log }
  ]
  const firstEnabled = tabs.find(t => t.enabled)?.key ?? 'log'
  const [tab, setTab] = useState<EvidenceTab>(firstEnabled)
  const [urls, setUrls] = useState<Partial<Record<ArtifactKind, string>>>({})
  const urlsRef = useRef(urls)
  urlsRef.current = urls
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<string | null>(null)

  // A different result has different artifacts: start again, and let go of
  // the object URLs held for the last one.
  useEffect(() => {
    setTab(firstEnabled)
    setError(null)
    setLog(null)
    return () => {
      Object.values(urlsRef.current).forEach(url => url && URL.revokeObjectURL(url))
      setUrls({})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.id, run.run_key])

  useEffect(() => {
    if (!result || (tab !== 'screenshot' && tab !== 'video') || urls[tab]) return
    let cancelled = false
    setLoading(true)
    setError(null)
    automationService
      .getArtifactUrl(run.run_key, result.id, tab)
      .then(url => { if (!cancelled) setUrls(prev => ({ ...prev, [tab]: url })) })
      .catch(err => { if (!cancelled) setError(err?.message ?? 'The evidence could not be loaded.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [tab, result, run.run_key, urls])

  useEffect(() => {
    if (tab !== 'log' || log !== null) return
    automationService.getRunLog(run.run_key).then(setLog).catch(() => setLog(''))
  }, [tab, log, run.run_key])

  // Whatever tab is open, as a file: the artifact, or the log / console / network as text.
  const download = async () => {
    try {
      if (result && (tab === 'screenshot' || tab === 'video' || tab === 'trace')) {
        const held = urls[tab]
        const url = held ?? (await automationService.getArtifactUrl(run.run_key, result.id, tab))
        saveHref(url, `${run.run_key}-${tab}.${tab === 'screenshot' ? 'png' : tab === 'video' ? 'webm' : 'zip'}`)
        if (!held) URL.revokeObjectURL(url)
        return
      }
      const text = tab === 'log' ? log ?? (await automationService.getRunLog(run.run_key)) : (tab === 'console' ? consoleLogs : networkLogs).map(entryText).join('\n')
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
      saveHref(url, `${run.run_key}-${tab}.txt`)
      URL.revokeObjectURL(url)
    } catch (err: any) {
      setError(err?.message ?? 'The evidence could not be downloaded.')
    }
  }
  const downloadTrace = download

  const baseUrl = run.spec?.base_url || ''

  return (
    <div className="flex min-h-[280px] flex-col overflow-hidden rounded-[14px] border border-[#E8EAEE] bg-white">
      <div className="flex items-center gap-0.5 overflow-x-auto border-b border-[#E8EAEE] px-1.5 py-1.5">
        {tabs.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            disabled={!t.enabled}
            className={`h-7 whitespace-nowrap rounded-[8px] px-2 text-[12px] font-semibold transition disabled:cursor-not-allowed disabled:text-[#9CA3AF] ${
              tab === t.key ? 'bg-[#FDEBEC] text-[#B71920]' : 'text-[#374151] hover:bg-[#F4F5F7]'
            }`}
          >
            {t.label}
          </button>
        ))}
        <button type="button" onClick={() => void download()} aria-label="Download this evidence" title="Download this evidence" className="ml-auto flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[8px] border border-[#E8EAEE] text-[#6B7280] hover:text-[#B71920]">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden><path d="M12 4v11M7 10l5 5 5-5M5 19h14" /></svg>
        </button>
      </div>
      <div className="min-h-0 flex-1 p-2.5">
        {error ? (
          <div className="rounded-[12px] border border-[#F6D4D5] bg-[#FFF8F8] px-3.5 py-2 text-[12.5px] text-[#7A0B0D]">{error}</div>
        ) : tab === 'screenshot' ? (
          <div className="flex h-full flex-col overflow-hidden rounded-[10px] border border-[#E8EAEE] bg-white">
            <div className="truncate border-b border-[#F1F2F4] px-2.5 py-1.5 font-mono text-[11px] text-[#6B7280]">
              {baseUrl.replace(/^https?:\/\//, '') || 'the page when the test ended'}
            </div>
            {loading || !urls.screenshot
              ? <div className="min-h-[200px] flex-1 animate-pulse bg-[repeating-linear-gradient(135deg,#F4F5F7_0,#F4F5F7_8px,#EEF0F3_8px,#EEF0F3_16px)]" />
              : <img src={urls.screenshot} alt="The page when the test ended" className="block max-h-[340px] w-full object-contain object-top" />}
          </div>
        ) : tab === 'video' ? (
          loading || !urls.video ? <div className="h-[220px] animate-pulse rounded-[10px] bg-[#F4F5F7]" /> : <video src={urls.video} controls className="max-h-[340px] w-full rounded-[10px] bg-black" />
        ) : tab === 'trace' ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-8 text-center text-[12.5px] text-[#6B7280]">
            <span>Every action, DOM snapshot and network call, as a Playwright trace.</span>
            <button type="button" onClick={() => void downloadTrace()} className="flex h-9 items-center rounded-[10px] border border-[#E8EAEE] bg-white px-3.5 text-[13px] font-bold text-[#1F2937] hover:border-[#F6D4D5]">Download trace</button>
            <span className="text-[11.5px]">Open it at trace.playwright.dev</span>
          </div>
        ) : tab === 'log' ? (
          <pre className="app-scroll max-h-[340px] overflow-auto whitespace-pre-wrap rounded-[10px] bg-[#1B1B1F] p-3 font-mono text-[11.5px] leading-[1.7] text-[#E5E7EB]">{log === null ? 'Loading…' : log || 'The log is empty.'}</pre>
        ) : (
          <ol className="app-scroll max-h-[340px] overflow-auto rounded-[10px] border border-[#E8EAEE] bg-white font-mono text-[11.5px]">
            {(tab === 'console' ? consoleLogs : networkLogs).map((entry, i) => (
              <li key={i} className="border-b border-[#F1F2F4] px-3 py-1.5 text-[#374151] last:border-b-0">{entryText(entry)}</li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

// --- Failure ------------------------------------------------------------------------------------

export const failureOf = (run: RunDetail, rows: StepRow[], result: RunResultRow | null) => {
  const step = rows.find(r => r.state === 'failed')
  const message = (step?.error || result?.error_message || run.error_message || '').replace(/\s*Call log:[\s\S]*$/, '').trim()
  const suggestion = run.healing_diagnosis ? run.healing_diagnosis.split(/(?<=\.)\s/)[0] : null
  return { message, suggestion }
}

export const FailureBox: React.FC<{ run: RunDetail; rows: StepRow[]; result: RunResultRow | null }> = ({ run, rows, result }) => {
  const [open, setOpen] = useState(false)
  const { message, suggestion } = failureOf(run, rows, result)
  const stack = result?.stack_trace || rows.find(r => r.state === 'failed')?.error || ''
  if (!message && !suggestion && !stack) return null
  return (
    <div className="rounded-[14px] border border-[#F3C2C0] bg-[#FFF8F8] px-3.5 py-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-[#A3231C]">Failure</span>
        {stack && (
          <button type="button" onClick={() => setOpen(v => !v)} className="flex items-center gap-1 text-[12px] font-semibold text-[#B71920]">
            Stack trace
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d={open ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'} /></svg>
          </button>
        )}
      </div>
      <p className="mt-1 line-clamp-3 break-words font-mono text-[11.5px] leading-[1.55] text-[#A3231C]">{message || 'The test did not complete.'}</p>
      {open && <pre className="app-scroll mt-2 max-h-[200px] overflow-auto whitespace-pre-wrap rounded-[10px] bg-white p-2.5 font-mono text-[11px] text-[#6B7280]">{stack}</pre>}
      {suggestion && <p className="mt-1.5 text-[12px] font-medium text-[#6D28D9]">AI suggestion: {suggestion}</p>}
    </div>
  )
}

/** The result a settled run's evidence and failure come from. */
export const resultOf = (run: RunDetail): RunResultRow | null =>
  run.results.find(r => r.status === 'fail' || r.status === 'error') ?? run.results[0] ?? null
