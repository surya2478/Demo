/**
 * --- Runs (screens 7 and 7a) --------------------------------------------------
 *
 * Run history on the left; the selected run on the right, at /automation/runs
 * and /automation/runs/:runKey alike. A live run shows its execution pipeline,
 * the test case's steps as they pass, and the runner log streaming. A finished
 * run keeps the pipeline and steps and swaps the log for its evidence --
 * screenshot, video, trace, console, network and log -- with the failure and
 * the AI's suggestion under the steps, and Rerun / Heal & rerun above.
 *
 * Runs can still be deleted: "Select" in the history turns on checkboxes.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import automationService from '../../services/automationService'
import useRunPolling from '../../hooks/useRunPolling'
import { useAutomationContext } from '../../components/automation/AutomationContext'
import { useConfirm } from '../../components/ui/ConfirmDialog'
import { CodeViewer } from '../../components/automation/CodeViewer'
import { parseServerTime } from '../../components/automation/runPresentation'
import { isTerminal } from '../../types/automation'
import type { ArtifactKind, RunDetail, RunResultRow, RunSummary } from '../../types/automation'

const CARD = 'rounded-[20px] border border-[#E8EAEE] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]'
const CHIP = 'inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12.5px] font-semibold'
const BTN = 'flex h-10 items-center gap-2 whitespace-nowrap rounded-[12px] border border-[#E8EAEE] bg-white px-4 text-[14px] font-bold transition hover:border-[#F6D4D5] disabled:cursor-not-allowed disabled:opacity-50'
const PRIMARY = 'flex h-10 items-center gap-2 whitespace-nowrap rounded-[12px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-4 text-[14px] font-bold text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50'

// --- Formatting ------------------------------------------------------------------

const baseId = (id: string | null | undefined) => String(id ?? '').replace(/\s*\(#[^)]*\)\s*$/, '')

const clock = (seconds: number | null | undefined) => {
  if (seconds == null || !Number.isFinite(seconds)) return '00:00'
  const s = Math.max(0, Math.round(seconds))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

const hhmm = (value: string | null | undefined) => {
  const date = parseServerTime(value)
  if (!date) return ''
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

const dubaiDay = (value: string | null | undefined) => {
  const date = parseServerTime(value)
  return date ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(date) : ''
}

const elapsedSeconds = (run: RunSummary, now: number) => {
  if (run.duration_seconds != null && isTerminal(run.status)) return run.duration_seconds
  const started = parseServerTime(run.started_at ?? run.created_at)
  return started ? (now - started.getTime()) / 1000 : null
}

const frameworkLabel = (name: string) => name.charAt(0).toUpperCase() + name.slice(1)

const speedLabel = (ms: number | null | undefined) =>
  ms == null ? null : ms >= 2000 ? `Debug (${ms / 1000}s)` : ms >= 1000 ? `Safe / WAF (${ms / 1000}s)` : ms > 0 ? `Balanced (${ms / 1000}s)` : 'Fast / CI (0s)'

const modeLabel = (mode: string | null | undefined) =>
  mode === 'dry_run' ? 'dry run' : mode === 'rerun' ? 'rerun' : mode === 'discovery' ? 'discovery' : null

// --- A run's state, as the history and the header show it ----------------------

type Tone = 'running' | 'failed' | 'passed' | 'blocked' | 'queued' | 'cancelled'

const toneOf = (run: RunSummary): Tone => {
  if (run.status === 'running') return 'running'
  if (run.status === 'queued') return 'queued'
  if (run.status === 'cancelled') return 'cancelled'
  if (run.outcome === 'passed') return 'passed'
  if (run.outcome === 'blocked') return 'blocked'
  return 'failed'
}

const TONE_CHIP: Record<Tone, string> = {
  running: 'bg-[#EEF4FF] text-[#1D4ED8]',
  queued: 'bg-[#EEF4FF] text-[#1D4ED8]',
  failed: 'bg-[#FEEBEC] text-[#A3231C]',
  passed: 'bg-[#EAF7EF] text-[#136B34]',
  blocked: 'bg-[#FFF4E5] text-[#8A5000]',
  cancelled: 'bg-[#F4F5F7] text-[#374151]'
}

const TONE_LABEL: Record<Tone, string> = {
  running: 'Running',
  queued: 'Queued',
  failed: 'Failed',
  passed: 'Passed',
  blocked: 'Blocked',
  cancelled: 'Cancelled'
}

const Spinner: React.FC<{ className?: string }> = ({ className = 'h-3 w-3' }) => (
  <span className={`box-border inline-block flex-shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} />
)

const StatusChip: React.FC<{ run: RunSummary }> = ({ run }) => {
  const tone = toneOf(run)
  return (
    <span className={`${CHIP} ${TONE_CHIP[tone]}`}>
      {(tone === 'running' || tone === 'queued') && <Spinner className="h-2.5 w-2.5" />}
      {TONE_LABEL[tone]}
    </span>
  )
}

// --- Steps, from the spec and the runner's progress -----------------------------

interface StepHistory {
  n: number
  title?: string | null
  ok?: boolean
  ms?: number | null
  error?: string | null
}

interface StepProgress {
  total?: number | null
  current?: number | null
  title?: string | null
  status?: string | null
  healed?: boolean | null
  history?: StepHistory[] | null
}

const cleanTitle = (title: string) => title.replace(/^\s*\d+[.)]\s*/, '').trim()

const specStepTitles = (code: string | null | undefined): string[] => {
  const titles: string[] = []
  const pattern = /test\.step\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(code || ''))) titles.push(cleanTitle(match[2].replace(/\\(.)/g, '$1')))
  return titles
}

type StepRow = { n: number; title: string; state: 'passed' | 'failed' | 'running' | 'pending'; ms: number | null; error: string | null }

const stepRows = (run: RunDetail): StepRow[] => {
  const progress = ((run.run_metadata as any)?.step_progress ?? null) as StepProgress | null
  const titles = specStepTitles(run.spec?.code ?? (run.run_metadata as any)?.code)
  const history = new Map((progress?.history ?? []).map(h => [h.n, h]))
  const total = Math.max(progress?.total ?? 0, titles.length, progress?.history?.length ?? 0)
  const live = !isTerminal(run.status)
  const current = progress?.current ?? 0
  return Array.from({ length: total }, (_, i) => {
    const n = i + 1
    const done = history.get(n)
    const title = titles[i] || (done?.title ? cleanTitle(done.title) : n === current && progress?.title ? cleanTitle(progress.title) : `Step ${n}`)
    if (done) return { n, title, state: done.ok === false ? 'failed' : 'passed', ms: done.ms ?? null, error: done.error ?? null }
    if (live && n === current) return { n, title, state: 'running', ms: null, error: null }
    return { n, title, state: 'pending', ms: null, error: null }
  })
}

// --- Pipeline ---------------------------------------------------------------------

type StageState = 'done' | 'running' | 'failed' | 'suggest' | 'pending'

const STAGE_STYLE: Record<StageState, string> = {
  done: 'border-[#BBDFC8] bg-[#F5FBF7]',
  running: 'border-[#C9D8F5] bg-[#F3F7FF]',
  failed: 'border-[#F3C2C0] bg-[#FEF2F2]',
  suggest: 'border-[#D9CCF5] bg-[#F7F3FF]',
  pending: 'border-[#E8EAEE] bg-[#FAFAFB]'
}

const StageIcon: React.FC<{ state: StageState }> = ({ state }) => {
  if (state === 'done') {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#15803D]">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" aria-hidden><path d="M5 12l5 5 9-10" /></svg>
      </span>
    )
  }
  if (state === 'failed') {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#DC2626]">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
      </span>
    )
  }
  if (state === 'suggest') {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#7C3AED]">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="#fff" aria-hidden><path d="M12 3l1.8 4.9L19 9.7l-4.2 3.1 1.5 5.2L12 15l-4.3 3 1.5-5.2L5 9.7l5.2-1.8z" /></svg>
      </span>
    )
  }
  if (state === 'running') return <span className="box-border h-5 w-5 animate-spin rounded-full border-[2.5px] border-[#FCD9DA] border-t-[#DC2626]" />
  return <span className="box-border h-5 w-5 rounded-full border-2 border-[#D6D9DF] bg-white" />
}

const pipelineOf = (run: RunDetail, rows: StepRow[]) => {
  const meta = (run.run_metadata ?? {}) as any
  const phase = Number(meta.phase_step) || (run.status === 'queued' ? 1 : 4)
  const code: string = run.spec?.code ?? meta.code ?? ''
  const assertions = (code.match(/expect\(/g) ?? []).length
  const env = run.environment || 'the environment'
  const failedStep = rows.find(r => r.state === 'failed')
  const passedSteps = rows.filter(r => r.state === 'passed').length
  const tone = toneOf(run)
  const finished = isTerminal(run.status)

  const state = (n: number): StageState => {
    if (!finished) return n < phase ? 'done' : n === phase ? 'running' : 'pending'
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
    { n: 1, title: 'Readiness & workspace', detail: state(1) === 'running' ? 'Checking the toolchain' : `Toolchain and ${env} reachable` },
    { n: 2, title: 'Element discovery & grounding', detail: rows.length ? `${rows.length} of ${rows.length} controls resolved` : 'Resolving controls' },
    { n: 3, title: 'Materialise Playwright spec', detail: `Spec compiled, ${assertions} assertion${assertions === 1 ? '' : 's'}` },
    {
      n: 4,
      title: 'Execute test engine',
      detail:
        state(4) === 'running' ? 'Browser running with video and trace'
          : state(4) === 'failed' ? (failedStep ? `Failed at step ${failedStep.n}` : tone === 'cancelled' ? 'Cancelled' : 'Did not complete')
            : state(4) === 'done' ? `${passedSteps || rows.length} of ${rows.length} steps passed`
              : 'Browser with video and trace'
    },
    {
      n: 5,
      title: 'Self-heal & finalise evidence',
      detail:
        state(5) === 'suggest' ? 'Fix suggested · evidence saved'
          : state(5) === 'done' ? (run.is_healed ? 'Healed · evidence saved' : 'Evidence saved')
            : 'Screenshot, video and trace saved here'
    }
  ].map(stage => ({ ...stage, state: state(stage.n) }))
}

const Pipeline: React.FC<{ run: RunDetail; rows: StepRow[] }> = ({ run, rows }) => (
  <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
    {pipelineOf(run, rows).map(stage => (
      <div key={stage.n} className={`min-h-[118px] rounded-[16px] border px-3.5 py-3 ${STAGE_STYLE[stage.state]}`}>
        <div className="flex items-center gap-2 text-[13px] font-bold text-[#374151]">
          <StageIcon state={stage.state} />
          {stage.n}
        </div>
        <div className={`mt-1.5 text-[14px] font-bold leading-[1.3] ${stage.state === 'pending' ? 'text-[#374151]' : 'text-[#1F2937]'}`}>{stage.title}</div>
        <div className="mt-1 text-[12.5px] leading-[1.35] text-[#6B7280]">{stage.detail}</div>
      </div>
    ))}
  </div>
)

const StepsCard: React.FC<{ rows: StepRow[] }> = ({ rows }) => {
  const passed = rows.filter(r => r.state === 'passed').length
  return (
    <div className="rounded-[16px] border border-[#E8EAEE] bg-white px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[#6B7280]">Test case steps</span>
        <span className="text-[14px] font-bold text-[#1F2937]">{passed} / {rows.length} passed</span>
      </div>
      {rows.length === 0 ? (
        <div className="py-4 text-[13px] text-[#9CA3AF]">Steps appear once the spec starts.</div>
      ) : (
        <ol className="flex flex-col gap-0.5">
          {rows.map(row => (
            <li
              key={row.n}
              className={`grid grid-cols-[22px_20px_minmax(0,1fr)_auto] items-center gap-2 rounded-[10px] px-2 py-[7px] text-[14px] ${
                row.state === 'running' ? 'bg-[#EEF4FF]' : row.state === 'failed' ? 'bg-[#FEF2F2]' : ''
              }`}
            >
              {row.state === 'passed' ? (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#15803D]">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" aria-hidden><path d="M5 12l5 5 9-10" /></svg>
                </span>
              ) : row.state === 'failed' ? (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#DC2626]">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
                </span>
              ) : row.state === 'running' ? (
                <span className="box-border h-5 w-5 animate-spin rounded-full border-[2.5px] border-[#FCD9DA] border-t-[#DC2626]" />
              ) : (
                <span className="box-border h-5 w-5 rounded-full border-2 border-[#D6D9DF]" />
              )}
              <span className="text-[13px] text-[#9CA3AF]">{row.n}</span>
              <span
                className={`truncate ${row.state === 'running' ? 'font-medium text-[#1D4ED8]' : row.state === 'failed' ? 'font-medium text-[#A3231C]' : row.state === 'pending' ? 'text-[#9CA3AF]' : 'text-[#1F2937]'}`}
                title={row.title}
              >
                {row.title}
              </span>
              <span className="text-[12.5px] tabular-nums text-[#9CA3AF]">
                {row.state === 'running' ? 'now' : row.ms != null ? `${(row.ms / 1000).toFixed(1)}s` : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

// --- Live log --------------------------------------------------------------------

const LiveLog: React.FC<{ runKey: string; live: boolean }> = ({ runKey, live }) => {
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
  return (
    <div className="flex min-h-[340px] flex-col overflow-hidden rounded-[16px] bg-[#1B1B1F]">
      <div className="flex items-center justify-between px-4 pb-1 pt-3">
        <span className="text-[11.5px] font-bold uppercase tracking-[0.14em] text-[#FCA5A5]">Live runner log</span>
        {live && (
          <span className="flex items-center gap-1.5 text-[12px] text-[#D1D5DB]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#EF4444]" />streaming
          </span>
        )}
      </div>
      <div ref={boxRef} className="app-scroll min-h-0 flex-1 overflow-auto px-4 pb-3 font-mono text-[12.5px] leading-[1.7] text-[#E5E7EB]">
        {text ? lines.map((line, i) => <div key={i} className="whitespace-pre-wrap break-words">{line || ' '}</div>) : <div className="text-[#9CA3AF]">Waiting for the runner…</div>}
        {live && <span className="inline-block h-4 w-2 animate-pulse bg-[#60A5FA] align-middle" />}
      </div>
    </div>
  )
}

// --- Evidence ----------------------------------------------------------------------

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

const Evidence: React.FC<{ run: RunDetail; result: RunResultRow | null }> = ({ run, result }) => {
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
    return () => {
      Object.values(urlsRef.current).forEach(url => url && URL.revokeObjectURL(url))
      setUrls({})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.id])

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

  const download = async () => {
    const save = (href: string, name: string) => {
      const link = document.createElement('a')
      link.href = href
      link.download = name
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    }
    try {
      if (result && (tab === 'screenshot' || tab === 'video' || tab === 'trace')) {
        const held = urls[tab]
        const url = held ?? (await automationService.getArtifactUrl(run.run_key, result.id, tab))
        save(url, `${run.run_key}-${tab}.${tab === 'screenshot' ? 'png' : tab === 'video' ? 'webm' : 'zip'}`)
        if (!held) URL.revokeObjectURL(url)
        return
      }
      const text = tab === 'log' ? log ?? '' : (tab === 'console' ? consoleLogs : networkLogs).map(entryText).join('\n')
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
      save(url, `${run.run_key}-${tab}.txt`)
      URL.revokeObjectURL(url)
    } catch (err: any) {
      setError(err?.message ?? 'The evidence could not be downloaded.')
    }
  }

  const baseUrl = run.spec?.base_url || ''

  return (
    <div className="flex min-h-[340px] flex-col overflow-hidden rounded-[16px] border border-[#E8EAEE] bg-white">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-[#E8EAEE] px-2.5 py-2">
        {tabs.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            disabled={!t.enabled}
            className={`h-8 whitespace-nowrap rounded-[10px] px-2.5 text-[13.5px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
              tab === t.key ? 'bg-[#FDEBEC] text-[#B71920]' : 'text-[#374151] hover:bg-[#F4F5F7]'
            }`}
          >
            {t.label}
          </button>
        ))}
        <button type="button" onClick={() => void download()} aria-label="Download this evidence" title="Download this evidence" className="ml-auto flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] border border-[#E8EAEE] text-[#6B7280] hover:text-[#B71920]">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden><path d="M12 4v11M7 10l5 5 5-5M5 19h14" /></svg>
        </button>
      </div>
      <div className="min-h-0 flex-1 bg-[#F8F9FA] p-3">
        {error ? (
          <div className="rounded-[12px] border border-[#F6D4D5] bg-[#FFF8F8] px-3.5 py-2 text-[12.5px] text-[#7A0B0D]">{error}</div>
        ) : tab === 'screenshot' ? (
          <div className="overflow-hidden rounded-[12px] border border-[#E8EAEE] bg-white shadow-[0_4px_14px_rgba(16,24,40,0.08)]">
            <div className="flex items-center gap-1.5 border-b border-[#F1F2F4] px-3 py-2">
              <span className="h-2.5 w-2.5 rounded-full bg-[#F87171]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#FBBF24]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#34D399]" />
              <span className="ml-2 truncate font-mono text-[12px] text-[#6B7280]">{baseUrl.replace(/^https?:\/\//, '') || 'the page when the test ended'}</span>
            </div>
            {loading || !urls.screenshot ? <div className="h-[260px] animate-pulse bg-[#F4F5F7]" /> : <img src={urls.screenshot} alt="The page when the test ended" className="block max-h-[360px] w-full object-contain object-top" />}
          </div>
        ) : tab === 'video' ? (
          loading || !urls.video ? <div className="h-[260px] animate-pulse rounded-[12px] bg-[#F4F5F7]" /> : <video src={urls.video} controls className="max-h-[360px] w-full rounded-[12px] bg-black" />
        ) : tab === 'trace' ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-10 text-center text-[13px] text-[#6B7280]">
            <span>Every action, DOM snapshot and network call, as a Playwright trace.</span>
            <button type="button" onClick={() => void download()} className={`${BTN} text-[#1F2937]`}>Download trace</button>
            <span className="text-[12px]">Open it at trace.playwright.dev</span>
          </div>
        ) : tab === 'log' ? (
          <pre className="app-scroll max-h-[360px] overflow-auto whitespace-pre-wrap rounded-[12px] bg-[#1B1B1F] p-3 font-mono text-[12px] leading-[1.7] text-[#E5E7EB]">{log === null ? 'Loading…' : log || 'The log is empty.'}</pre>
        ) : (
          <ol className="app-scroll max-h-[360px] overflow-auto rounded-[12px] border border-[#E8EAEE] bg-white font-mono text-[12px]">
            {(tab === 'console' ? consoleLogs : networkLogs).map((entry, i) => (
              <li key={i} className="border-b border-[#F1F2F4] px-3 py-1.5 text-[#374151] last:border-b-0">{entryText(entry)}</li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

const FailureBox: React.FC<{ run: RunDetail; rows: StepRow[]; result: RunResultRow | null }> = ({ run, rows, result }) => {
  const [open, setOpen] = useState(false)
  const step = rows.find(r => r.state === 'failed')
  const message = (step?.error || result?.error_message || run.error_message || '').replace(/\s*Call log:[\s\S]*$/, '').trim()
  const stack = result?.stack_trace || step?.error || ''
  if (!message && !stack) return null
  const suggestion = run.healing_diagnosis ? run.healing_diagnosis.split(/(?<=\.)\s/)[0] : null
  return (
    <div className="rounded-[16px] border border-[#F3C2C0] bg-[#FFF8F8] px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-[11.5px] font-bold uppercase tracking-[0.14em] text-[#A3231C]">Failure</span>
        {stack && (
          <button type="button" onClick={() => setOpen(v => !v)} className="flex items-center gap-1 text-[13px] font-semibold text-[#B71920]">
            Stack trace
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d={open ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'} /></svg>
          </button>
        )}
      </div>
      <p className="mt-1.5 line-clamp-3 break-words font-mono text-[12.5px] leading-[1.55] text-[#A3231C]">{message || 'The test did not complete.'}</p>
      {open && <pre className="app-scroll mt-2 max-h-[200px] overflow-auto whitespace-pre-wrap rounded-[10px] bg-white p-2.5 font-mono text-[11.5px] text-[#6B7280]">{stack}</pre>}
      {suggestion && <p className="mt-2 text-[13px] font-medium text-[#6D28D9]">AI suggestion: {suggestion}</p>}
    </div>
  )
}

// --- The selected run ----------------------------------------------------------------

const RunPanel: React.FC<{ runKey: string; onChanged: () => void }> = ({ runKey, onChanged }) => {
  const { canExecute } = useAutomationContext()
  const navigate = useNavigate()
  const { run, loading, error } = useRunPolling(runKey, { onSettled: onChanged })
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState<'cancel' | 'rerun' | 'heal' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [specOpen, setSpecOpen] = useState(false)

  const live = run ? !isTerminal(run.status) : false
  useEffect(() => {
    if (!live) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [live])

  if (loading && !run) return <div className="p-6 text-[13px] text-[#6B7280]">Loading the run…</div>
  if (!run) return <div className="p-6 text-[13px] text-[#A3231C]">{error ?? 'That run could not be found.'}</div>

  const rows = stepRows(run)
  const result = run.results.find(r => r.status === 'fail' || r.status === 'error') ?? run.results[0] ?? null
  const tone = toneOf(run)
  const failedLike = tone === 'failed' || tone === 'blocked'
  const phase = Number((run.run_metadata as any)?.phase_step) || 1

  // Rerun and Heal & rerun queue a new run with the same settings, marked as
  // a rerun, and open it.
  const queue = async (code: string | null | undefined) => {
    if (!code) throw new Error('This run has no spec to run again.')
    const res = await automationService.createRun({
      code,
      environment: run.environment || 'SIT',
      base_url: run.spec?.base_url || null,
      file_name: run.spec?.file_name || 'spec.ts',
      test_case_id: run.test_case_id ?? null,
      slow_mo_ms: run.slow_mo_ms ?? 1000,
      headless: true,
      mode: 'rerun'
    })
    onChanged()
    navigate(`/automation/runs/${res.run_key}`)
  }

  const act = async (which: 'cancel' | 'rerun' | 'heal') => {
    setBusy(which)
    setActionError(null)
    try {
      if (which === 'cancel') {
        await automationService.cancelRun(run.run_key)
        onChanged()
      } else if (which === 'rerun') {
        await queue(run.spec?.code)
      } else {
        await queue((await automationService.healRun(run.run_key)).healed_code)
      }
    } catch (err: any) {
      setActionError(err?.message ?? 'That did not work.')
    } finally {
      setBusy(null)
    }
  }

  const head = [
    run.run_key.toUpperCase(),
    frameworkLabel(run.framework),
    run.environment,
    live ? speedLabel(run.slow_mo_ms) : null,
    run.triggered_by ? `triggered by ${run.triggered_by}` : null
  ].filter(Boolean).join(' · ')
  const tail = live
    ? `started ${hhmm(run.started_at ?? run.created_at)} · ${clock(elapsedSeconds(run, now))} elapsed`
    : `${hhmm(run.started_at ?? run.created_at)} · ${clock(run.duration_seconds)} · ${run.passed} of ${run.total_tests || 1} test${(run.total_tests || 1) === 1 ? '' : 's'} passed`

  const specButton = (
    <button type="button" onClick={() => setSpecOpen(true)} disabled={!run.spec?.code} className={`${BTN} text-[#1F2937]`}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden><path d="M9 7L4.5 12 9 17M15 7l4.5 5-4.5 5" /></svg>
      Spec
    </button>
  )

  return (
    <div className="flex min-w-0 flex-col gap-3.5 p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="m-0 min-w-0 truncate text-[18px] font-bold text-[#1F2937]" title={run.tc_title ?? undefined}>
              {baseId(run.tc_display_id) || run.file_name || 'Run'}{run.tc_title ? ` · ${run.tc_title}` : ''}
            </h2>
            <StatusChip run={run} />
            {run.is_healed && <span className={`${CHIP} bg-[#F3EEFF] text-[#6D28D9]`}>Healed</span>}
          </div>
          <div className="mt-1 text-[13px] text-[#6B7280]">{head} · {tail}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {live ? (
            <>
              {specButton}
              {canExecute && run.is_active && (
                <button type="button" onClick={() => void act('cancel')} disabled={busy !== null} className={`${BTN} text-[#B71920]`}>
                  {busy === 'cancel' ? 'Cancelling…' : 'Cancel run'}
                </button>
              )}
            </>
          ) : (
            <>
              {!failedLike && specButton}
              {canExecute && (
                <button type="button" onClick={() => void act('rerun')} disabled={busy !== null || !run.spec?.code} className={`${BTN} text-[#1F2937]`}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v4h-4" /></svg>
                  {busy === 'rerun' ? 'Queueing…' : 'Rerun'}
                </button>
              )}
              {canExecute && failedLike && (
                <button type="button" onClick={() => void act('heal')} disabled={busy !== null || !run.spec?.code} className={PRIMARY}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3l1.8 4.9L19 9.7l-4.2 3.1 1.5 5.2L12 15l-4.3 3 1.5-5.2L5 9.7l5.2-1.8z" /></svg>
                  {busy === 'heal' ? 'Healing…' : 'Heal & rerun'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {actionError && <div role="alert" className="rounded-[12px] border border-[#F6D4D5] bg-[#FFF8F8] px-3.5 py-2 text-[12.5px] text-[#7A0B0D]">{actionError}</div>}

      {live && (
        <div className="-mb-1 flex items-center justify-between">
          <span className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[#6B7280]">Execution pipeline</span>
          <span className="text-[13px] text-[#6B7280]">Stage {Math.min(5, phase)} of 5</span>
        </div>
      )}
      <Pipeline run={run} rows={rows} />

      <div className={`grid grid-cols-1 gap-3.5 ${live ? 'xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]' : 'xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]'}`}>
        <div className="flex min-w-0 flex-col gap-3.5">
          <StepsCard rows={rows} />
          {!live && failedLike && <FailureBox run={run} rows={rows} result={result} />}
        </div>
        {live ? <LiveLog runKey={run.run_key} live={live} /> : <Evidence run={run} result={result} />}
      </div>

      {specOpen && run.spec?.code ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(17,24,39,0.55)] p-4" onMouseDown={e => { if (e.target === e.currentTarget) setSpecOpen(false) }} role="dialog" aria-modal="true" aria-label="Spec">
          <div className="flex max-h-[88vh] w-full max-w-[980px] flex-col overflow-hidden rounded-[20px] border border-[#E8EAEE] bg-white shadow-[0_28px_70px_rgba(15,23,42,0.22)]">
            <div className="flex items-center gap-3 border-b border-[#E8EAEE] px-5 py-3.5">
              <div className="min-w-0 flex-1 truncate font-mono text-[14px] font-semibold text-[#1F2937]">{run.spec.file_name ?? 'spec.ts'}</div>
              <button type="button" onClick={() => setSpecOpen(false)} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-[10px] text-[#6B7280] hover:bg-[#F4F5F7]">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <div className="app-scroll overflow-auto p-4">
              <CodeViewer code={run.spec.code} language="typescript" fileName={run.spec.file_name ?? 'spec.ts'} downloadable maxHeight="70vh" />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// --- Page -------------------------------------------------------------------------------

type Filter = 'all' | 'running' | 'failed' | 'passed' | 'blocked'

const Runs: React.FC = () => {
  const { runKey } = useParams<{ runKey: string }>()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const { canExecute, query, setLiveRuns } = useAutomationContext()
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [now, setNow] = useState(() => Date.now())
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    try {
      const data = await automationService.listRuns(100)
      setRuns(data.runs ?? [])
      setLiveRuns(data.summary?.active ?? (data.runs ?? []).filter(r => !isTerminal(r.status)).length)
      setError(null)
    } catch (err: any) {
      setError(err?.message ?? 'The runs could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [setLiveRuns])

  useEffect(() => { void load() }, [load])

  const anyLive = runs.some(r => !isTerminal(r.status))
  useEffect(() => {
    if (!anyLive) return
    const poll = window.setInterval(() => void load(), 4000)
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    return () => { window.clearInterval(poll); window.clearInterval(tick) }
  }, [anyLive, load])

  const counts = useMemo(() => {
    const c = { running: 0, failed: 0, passed: 0, blocked: 0 }
    runs.forEach(r => {
      const tone = toneOf(r)
      if (tone === 'running' || tone === 'queued') c.running++
      else if (tone === 'failed') c.failed++
      else if (tone === 'passed') c.passed++
      else if (tone === 'blocked') c.blocked++
    })
    return c
  }, [runs])

  const visible = useMemo(
    () =>
      runs.filter(r => {
        const tone = toneOf(r)
        if (filter === 'running' && tone !== 'running' && tone !== 'queued') return false
        if (filter !== 'all' && filter !== 'running' && tone !== filter) return false
        if (!query) return true
        return [r.tc_display_id, r.tc_title, r.run_key, r.file_name, r.triggered_by].some(v => String(v ?? '').toLowerCase().includes(query))
      }),
    [runs, filter, query]
  )

  // Nothing chosen: the live run if there is one, else the latest.
  useEffect(() => {
    if (runKey || !runs.length) return
    const pick = runs.find(r => !isTerminal(r.status)) ?? runs[0]
    navigate(`/automation/runs/${pick.run_key}`, { replace: true })
  }, [runKey, runs, navigate])

  const today = dubaiDay(new Date().toISOString())
  const todayCount = runs.filter(r => dubaiDay(r.created_at) === today).length

  const deletePicked = async () => {
    const keys = Array.from(picked)
    if (!keys.length) return
    const ok = await confirm({
      title: keys.length === 1 ? 'Delete this run?' : `Delete ${keys.length} runs?`,
      body: 'Their results and evidence are removed from this host.',
      consequences: ['This cannot be undone.'],
      confirmLabel: keys.length === 1 ? 'Delete run' : `Delete ${keys.length} runs`
    })
    if (!ok) return
    try {
      await automationService.deleteRuns(keys)
      setPicked(new Set())
      setSelecting(false)
      if (runKey && keys.includes(runKey)) navigate('/automation/runs', { replace: true })
      await load()
    } catch (err: any) {
      setError(err?.message ?? 'The runs could not be deleted.')
    }
  }

  const filterChip = (key: Filter, label: string, tone: string, count?: number) => (
    <button
      key={key}
      type="button"
      onClick={() => setFilter(key)}
      aria-pressed={filter === key}
      className={`${CHIP} h-7 transition ${filter === key ? 'bg-[#1F2937] text-white' : tone}`}
    >
      {label}{count != null ? ` ${count}` : ''}
    </button>
  )

  return (
    <section className={`${CARD} grid min-h-[700px] grid-cols-1 overflow-hidden lg:grid-cols-[400px_minmax(0,1fr)]`}>
      {/* History */}
      <div className="flex min-w-0 flex-col border-b border-[#E8EAEE] lg:border-b-0 lg:border-r">
        <div className="px-5 pb-3 pt-4">
          <div className="flex items-center gap-2">
            <span className="text-[17px] font-bold text-[#1F2937]">Run history</span>
            <span className="ml-auto text-[13px] text-[#6B7280]">Today · {todayCount} run{todayCount === 1 ? '' : 's'}</span>
            {canExecute && runs.length > 0 && (
              <button
                type="button"
                onClick={() => { setSelecting(v => !v); setPicked(new Set()) }}
                className="text-[12.5px] font-semibold text-[#B71920] hover:underline"
              >
                {selecting ? 'Done' : 'Select'}
              </button>
            )}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {filterChip('all', 'All', 'bg-[#F4F5F7] text-[#1F2937]')}
            {counts.running > 0 && filterChip('running', 'Running', TONE_CHIP.running, counts.running)}
            {counts.failed > 0 && filterChip('failed', 'Failed', TONE_CHIP.failed, counts.failed)}
            {counts.passed > 0 && filterChip('passed', 'Passed', TONE_CHIP.passed, counts.passed)}
            {counts.blocked > 0 && filterChip('blocked', 'Blocked', TONE_CHIP.blocked, counts.blocked)}
          </div>
          {selecting && (
            <div className="mt-2.5 flex items-center gap-2 rounded-[12px] bg-[#FCFCFD] px-2 py-1.5 text-[12.5px]">
              <input
                type="checkbox"
                aria-label="Select all runs"
                checked={visible.length > 0 && visible.every(r => picked.has(r.run_key))}
                onChange={e => setPicked(e.target.checked ? new Set(visible.map(r => r.run_key)) : new Set())}
                className="h-4 w-4 accent-[#B71920]"
              />
              <span className="font-semibold text-[#1F2937]">{picked.size ? `${picked.size} selected` : 'Select all'}</span>
              <button type="button" onClick={() => void deletePicked()} disabled={!picked.size} className="ml-auto font-bold text-[#B71920] disabled:opacity-40">
                Delete{picked.size ? ` ${picked.size}` : ''}
              </button>
            </div>
          )}
        </div>
        {error && <div role="alert" className="mx-5 mb-2 rounded-[12px] border border-[#F6D4D5] bg-[#FFF8F8] px-3 py-2 text-[12.5px] text-[#7A0B0D]">{error}</div>}
        <div className="app-scroll min-h-0 flex-1 overflow-y-auto border-t border-[#E8EAEE] lg:max-h-[780px]">
          {loading ? (
            <div className="px-5 py-6 text-[13px] text-[#6B7280]">Loading runs…</div>
          ) : visible.length === 0 ? (
            <div className="px-5 py-8 text-center text-[13px] text-[#6B7280]">{runs.length ? 'No runs match.' : 'No runs yet. Dry run a script in the Script Lab and it appears here.'}</div>
          ) : (
            visible.map(run => {
              const active = run.run_key === runKey
              const tone = toneOf(run)
              return (
                <div
                  key={run.run_key}
                  onClick={() => navigate(`/automation/runs/${run.run_key}`)}
                  className={`flex cursor-pointer gap-2.5 border-b border-[#F1F2F4] px-5 py-3.5 ${active ? 'bg-[#FFF5F5] shadow-[inset_3px_0_0_#B71920]' : 'hover:bg-[#FCFCFD]'}`}
                >
                  {selecting && (
                    <input
                      type="checkbox"
                      aria-label={`Select ${run.run_key}`}
                      checked={picked.has(run.run_key)}
                      onClick={e => e.stopPropagation()}
                      onChange={() => setPicked(prev => { const next = new Set(prev); if (next.has(run.run_key)) next.delete(run.run_key); else next.add(run.run_key); return next })}
                      className="mt-1 h-4 w-4 flex-shrink-0 accent-[#B71920]"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[15px] font-bold text-[#1F2937]">{baseId(run.tc_display_id) || run.file_name || run.run_key}</span>
                      <StatusChip run={run} />
                      {run.is_healed && <span className={`${CHIP} bg-[#F3EEFF] text-[#6D28D9]`}>Healed</span>}
                      <span className="ml-auto whitespace-nowrap text-[12.5px] tabular-nums text-[#6B7280]">
                        {tone === 'running' || tone === 'queued' ? `${clock(elapsedSeconds(run, now))} so far` : `${clock(run.duration_seconds)} · ${hhmm(run.started_at ?? run.created_at)}`}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-[14px] text-[#374151]" title={run.tc_title ?? undefined}>{run.tc_title || run.file_name || '—'}</div>
                    <div className="mt-0.5 truncate text-[12.5px] text-[#9CA3AF]">
                      {[frameworkLabel(run.framework), run.environment, modeLabel(run.mode), run.triggered_by].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* The selected run */}
      <div className="min-w-0">
        {runKey ? (
          <RunPanel key={runKey} runKey={runKey} onChanged={() => void load()} />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-[13px] text-[#6B7280]">{loading ? 'Loading…' : 'Select a run to see its progress and evidence.'}</div>
        )}
      </div>
    </section>
  )
}

export default Runs
