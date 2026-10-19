/**
 * --- Automation Lab: the jobs, each in its popup ----------------------------------
 *
 * Dry run (live), heal, bulk dry run, generate and edit open here, over the
 * workspace; the case's Script, Latest run and History stay inline. A popup
 * never opens another popup -- moving from one job to the next replaces it.
 * Minimise (or Close, for the batch jobs) leaves the work running: the case
 * list row shows where it got to.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import automationService from '../../services/automationService'
import useRunPolling from '../../hooks/useRunPolling'
import { startDeviceRunner } from '../../services/localRunner'
import { isTerminal } from '../../types/automation'
import type { RegisteredApplication, RunSummary } from '../../types/automation'
import {
  BTN, CHIP, PRIMARY, PURPLE, ChevronGlyph, Popup, PopupClose, StarGlyph
} from './labShared'
import {
  DoneDot, EmptyDot, Evidence, FailDot, FailureBox, LiveLog, Pipeline, SpinDot, StepsCard,
  TONE_CHIP, TONE_LABEL, baseId, clock, dayTime, elapsedSeconds, frameworkLabel, hhmm, modeLabel,
  resultOf, speedLabel, stepRows, toneOf
} from './labRun'

// --- B1 · Dry run, live ---------------------------------------------------------------

const runTitle = (run: RunSummary) => {
  const label = modeLabel(run)
  return label === 'dry run' ? 'Dry run' : label === 'rerun' ? 'Rerun' : label === 'heal & rerun' ? 'Heal & rerun' : label === 'discovery' ? 'Discovery' : 'Run'
}

export const RunPopup: React.FC<{
  runKey: string
  /** "7899 · Testing", beside the run key. */
  projectLabel?: string | null
  canExecute: boolean
  /** Live: the popup goes, the run keeps going. */
  onMinimise: () => void
  /** Settled: closing hands over to the case's Latest run. */
  onClose: (settled: boolean) => void
  onChanged?: () => void
}> = ({ runKey: initialKey, projectLabel, canExecute, onMinimise, onClose, onChanged }) => {
  // Rerun, Rerun on device and Heal & rerun queue a new run; it replaces this one here.
  const [runKey, setRunKey] = useState(initialKey)
  useEffect(() => { setRunKey(initialKey) }, [initialKey])
  const { run, loading, error } = useRunPolling(runKey, { onSettled: () => onChanged?.() })
  const [now, setNow] = useState(() => Date.now())
  const [showSpec, setShowSpec] = useState(false)
  const [busy, setBusy] = useState<'cancel' | 'rerun' | 'device' | 'heal' | null>(null)
  const [deviceHeaded, setDeviceHeaded] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const live = run ? !isTerminal(run.status) : true

  useEffect(() => {
    if (!live) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [live])

  const close = () => (live ? onMinimise() : onClose(true))

  // What the Runs drawer did: cancel; rerun the same spec here or on this device;
  // or heal it and rerun the fix -- each a new run marked as a rerun.
  const act = async (which: 'cancel' | 'rerun' | 'device' | 'heal') => {
    if (!run) return
    setBusy(which)
    setActionError(null)
    const body = (code: string, headless: boolean) => ({
      code,
      environment: run.environment || 'SIT',
      base_url: run.spec?.base_url || null,
      file_name: run.spec?.file_name || 'spec.ts',
      test_case_id: run.test_case_id ?? null,
      slow_mo_ms: run.slow_mo_ms ?? 1000,
      headless,
      mode: 'rerun' as const
    })
    try {
      if (which === 'cancel') {
        await automationService.cancelRun(run.run_key)
      } else {
        if (!run.spec?.code) throw new Error('This run has no spec to run again.')
        if (which === 'device') {
          const res = await automationService.createDeviceRun(body(run.spec.code, !deviceHeaded))
          try {
            await startDeviceRunner(res.pairing)
          } catch (err) {
            await automationService.cancelRun(res.run_key).catch(() => undefined)
            throw new Error(err instanceof Error && err.message
              ? `${err.message} Start the device runner, then try again.`
              : 'The local Playwright runner is not available. Start the device runner, then try again.')
          }
          setRunKey(res.run_key)
        } else {
          const code = which === 'heal' ? (await automationService.healRun(run.run_key)).healed_code : run.spec.code
          const res = await automationService.createRun(body(code, true))
          setRunKey(res.run_key)
        }
        setShowSpec(false)
      }
      onChanged?.()
    } catch (err: any) {
      setActionError(err?.message ?? 'That did not work.')
    } finally {
      setBusy(null)
    }
  }

  if (!run) {
    return (
      <Popup label="Run" onClose={close}>
        <div className="flex items-center justify-between px-5 py-4">
          <span className={`text-[13px] ${loading ? 'text-[#6B7280]' : 'text-[#A3231C]'}`}>{loading ? 'Loading the run…' : error ?? 'That run could not be found.'}</span>
          <PopupClose onClick={() => onClose(false)} />
        </div>
      </Popup>
    )
  }

  const rows = stepRows(run)
  const tone = toneOf(run)
  const result = resultOf(run)
  const facts = [
    frameworkLabel(run.framework),
    run.environment,
    run.execution_target === 'device' ? 'on this device' : null,
    run.execution_target === 'device' ? (run.headless === false ? 'headed browser' : 'headless browser') : null,
    speedLabel(run.slow_mo_ms),
    run.triggered_by ? `by ${run.triggered_by}` : null,
    live
      ? `started ${hhmm(run.started_at ?? run.created_at)} · ${clock(elapsedSeconds(run, now))} elapsed`
      : `${dayTime(run.started_at ?? run.created_at)} · ${clock(run.duration_seconds)}`,
    live ? null : `${run.passed} of ${run.total_tests || 1} test${(run.total_tests || 1) === 1 ? '' : 's'} passed`
  ].filter(Boolean) as string[]

  return (
    <Popup label={`${baseId(run.tc_display_id) || 'Run'} ${runTitle(run)}`} width="max-w-[800px]" onClose={close}>
      <div className="flex items-start gap-3 border-b border-[#E8EAEE] px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
            <span className={`${CHIP} h-5 px-2 text-[11px] ${TONE_CHIP[tone]}`}>
              {live ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
              {TONE_LABEL[tone]}
            </span>
            {run.is_healed && <span className={`${CHIP} h-5 bg-[#F3EEFF] px-2 text-[11px] text-[#6D28D9]`}>Healed</span>}
            <span className="font-mono text-[#9CA3AF]">{run.run_key.toUpperCase()}</span>
            {projectLabel ? <span className="text-[#6B7280]">{projectLabel}</span> : null}
          </div>
          <h2 className="m-0 mt-1 text-[16px] font-bold text-[#1F2937]">
            <span className="text-[#B71920]">{baseId(run.tc_display_id) || run.file_name || 'Run'}</span> · {runTitle(run)}
          </h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {facts.map(fact => (
              <span key={fact} className="inline-flex h-6 items-center rounded-full border border-[#E8EAEE] bg-white px-2.5 text-[11.5px] font-medium text-[#374151]">{fact}</span>
            ))}
          </div>
        </div>
        <PopupClose onClick={close} label={live ? 'Minimise' : 'Close'} />
      </div>

      <div className="flex flex-col gap-3 bg-[#FAFAFB] px-5 py-3.5">
        {actionError && <div role="alert" className="rounded-[10px] border border-[#F6D4D5] bg-[#FFF8F8] px-3 py-2 text-[12.5px] text-[#7A0B0D]">{actionError}</div>}
        <Pipeline run={run} rows={rows} />
        {showSpec ? (
          <pre className="app-scroll max-h-[300px] overflow-auto rounded-[14px] bg-[#1B1B1F] p-3.5 font-mono text-[11.5px] leading-[1.7] text-[#E5E7EB]">{run.spec?.code || 'This run has no spec.'}</pre>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-3">
              <StepsCard rows={rows} />
              {!live && (tone === 'failed' || tone === 'blocked') && <FailureBox run={run} rows={rows} result={result} />}
            </div>
            {live ? <LiveLog run={run} rows={rows} live={live} /> : <Evidence run={run} result={result} />}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-[#E8EAEE] px-5 py-3">
        <button type="button" onClick={() => setShowSpec(v => !v)} disabled={!run.spec?.code} className={BTN}>
          {showSpec ? 'Steps' : 'Spec'}
        </button>
        <span className="text-[12px] text-[#6B7280]">
          {live ? <><b className="font-semibold text-[#374151]">Minimise</b> keeps it running in the case list</> : 'Finished — the result stays in the case’s Latest run'}
        </span>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {live ? (
            <>
              <button type="button" onClick={onMinimise} className={BTN}>Minimise</button>
              {canExecute && run.is_active && (
                <button type="button" onClick={() => void act('cancel')} disabled={busy !== null} className={`${BTN} !text-[#B71920]`}>
                  {busy === 'cancel' ? 'Cancelling…' : 'Cancel run'}
                </button>
              )}
            </>
          ) : (
            <>
              {canExecute && (
                <>
                  <button type="button" onClick={() => void act('rerun')} disabled={busy !== null || !run.spec?.code} className={BTN}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v4h-4" /></svg>
                    {busy === 'rerun' ? 'Queueing…' : 'Rerun'}
                  </button>
                  <select aria-label="Rerun on device browser mode" value={deviceHeaded ? 'headed' : 'headless'} onChange={e => setDeviceHeaded(e.target.value === 'headed')}
                    disabled={busy !== null} className="h-9 rounded-[10px] border border-[#E8EAEE] bg-white px-2.5 text-[12.5px] font-semibold text-[#374151] disabled:opacity-50">
                    <option value="headless">Headless</option>
                    <option value="headed">Headed</option>
                  </select>
                  <button type="button" onClick={() => void act('device')} disabled={busy !== null || !run.spec?.code} className={BTN}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden><rect x="4" y="3" width="16" height="13" rx="2" /><path d="M8 21h8M12 16v5" /></svg>
                    {busy === 'device' ? 'Connecting…' : 'Rerun on device'}
                  </button>
                  {(tone === 'failed' || tone === 'blocked') && (
                    <button type="button" onClick={() => void act('heal')} disabled={busy !== null || !run.spec?.code} className={PRIMARY}>
                      <StarGlyph />{busy === 'heal' ? 'Healing…' : 'Heal & rerun'}
                    </button>
                  )}
                </>
              )}
              <button type="button" onClick={() => onClose(true)} className={BTN}>Close</button>
            </>
          )}
        </div>
      </div>
    </Popup>
  )
}

// --- B3 · Heal & rerun ------------------------------------------------------------------------

type DiffLine = { kind: ' ' | '-' | '+' | '…'; text: string }

/** A line diff (longest common subsequence), cut to the changes with a line of context. */
export const lineDiff = (before: string, after: string, context = 1): DiffLine[] => {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const all: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { all.push({ kind: ' ', text: a[i] }); i++; j++ }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { all.push({ kind: '-', text: a[i] }); i++ }
    else { all.push({ kind: '+', text: b[j] }); j++ }
  }
  while (i < n) all.push({ kind: '-', text: a[i++] })
  while (j < m) all.push({ kind: '+', text: b[j++] })
  const keep = all.map(() => false)
  all.forEach((line, k) => {
    if (line.kind === ' ') return
    for (let d = -context; d <= context; d++) if (all[k + d]) keep[k + d] = true
  })
  const out: DiffLine[] = []
  all.forEach((line, k) => {
    if (keep[k]) out.push(line)
    else if (keep[k - 1]) out.push({ kind: '…', text: '' })
  })
  if (out.length && out[out.length - 1].kind === '…') out.pop()
  return out
}

export interface HealSource {
  caseId: number
  tc: string
  scriptId: number | null
  /** The run to heal from; without one the script's last dry run is used. */
  runKey: string | null
  environment: string | null
}

export const HealPopup: React.FC<{
  source: HealSource
  canExecute: boolean
  onDiscard: () => void
  /** The fix ran: the live popup takes over with this run. */
  onRunning: (runKey: string) => void
  onSaved: () => void
}> = ({ source, canExecute, onDiscard, onRunning, onSaved }) => {
  const [fix, setFix] = useState<{ code: string; original: string; diagnosis: string; changes: string[]; runKey: string | null; baseUrl: string | null; fileName: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [save, setSave] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const ask = async () => {
      try {
        if (source.runKey) {
          const [res, run] = await Promise.all([automationService.healRun(source.runKey), automationService.getRun(source.runKey)])
          if (!cancelled) setFix({ code: res.healed_code, original: res.original_code || run.spec?.code || '', diagnosis: res.diagnosis, changes: res.changes_made ?? [], runKey: source.runKey, baseUrl: run.spec?.base_url ?? null, fileName: run.spec?.file_name ?? null })
        } else if (source.scriptId) {
          const [res, script] = await Promise.all([automationService.healScript(source.scriptId), automationService.getScript(source.scriptId)])
          if (!cancelled) setFix({ code: res.healed_code, original: res.original_code || script.code, diagnosis: res.diagnosis, changes: res.changes_made ?? [], runKey: script.dry_run_key, baseUrl: null, fileName: script.file_name })
        } else {
          throw new Error('There is no script or run to heal.')
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? 'The AI could not suggest a fix.')
      }
    }
    void ask()
    return () => { cancelled = true }
  }, [source.runKey, source.scriptId])

  const diff = useMemo(() => (fix ? lineDiff(fix.original, fix.code) : []), [fix])
  const headline = fix ? (fix.diagnosis.split(/(?<=\.)\s/)[0] || fix.diagnosis).replace(/\.$/, '') : ''

  const go = async () => {
    if (!fix) return
    setBusy(true)
    setError(null)
    try {
      if (save && source.scriptId) {
        await automationService.editScript(source.scriptId, fix.code)
        onSaved()
        const res = await automationService.dryRunScripts({ script_ids: [source.scriptId], environment: null, base_url: null, slow_mo_ms: 1000 })
        if (res.refused?.length) throw new Error(`Saved, but the dry run was refused — ${res.refused.map(r => r.reason).join(' · ')}`)
        onRunning(res.queued[0].run_key)
      } else {
        // Unticked: run the fix once, as a rerun, and leave the script alone.
        const res = await automationService.createRun({
          code: fix.code,
          environment: source.environment || 'SIT',
          base_url: fix.baseUrl,
          file_name: fix.fileName || 'spec.ts',
          test_case_id: source.caseId,
          slow_mo_ms: 1000,
          headless: true,
          mode: 'rerun'
        })
        onRunning(res.run_key)
      }
    } catch (err: any) {
      setError(err?.message ?? 'The fix could not be run.')
      setBusy(false)
    }
  }

  return (
    <Popup label={`AI fix for ${source.tc}`} width="max-w-[770px]" onClose={onDiscard} locked={busy}>
      <div className="flex items-start gap-3 px-4 pb-3 pt-3.5">
        <div className="min-w-0 flex-1">
          <div className="text-[10.5px] font-bold uppercase tracking-[0.16em] text-[#6D28D9]">{fix ? 'AI fix ready' : 'AI fix'} · {source.tc}</div>
          <h2 className="m-0 mt-1 text-[15px] font-bold text-[#1F2937]">{fix ? headline : error ? 'No fix this time' : 'Asking the AI for a fix…'}</h2>
          <div className="mt-0.5 text-[11.5px] text-[#6B7280]">
            {fix?.runKey ? `From ${fix.runKey.toUpperCase()} · ` : ''}values come from Test Data{source.environment ? ` for ${source.environment}` : ''}
          </div>
        </div>
        <PopupClose onClick={onDiscard} />
      </div>
      {error && <div role="alert" className="mx-4 mb-3 rounded-[10px] border border-[#F6D4D5] bg-[#FFF8F8] px-3 py-2 text-[12.5px] text-[#7A0B0D]">{error}</div>}
      {fix ? (
        diff.length ? (
          <div className="app-scroll max-h-[320px] overflow-auto bg-[#1B1B1F] py-2 font-mono text-[11.5px] leading-[1.7]">
            {diff.map((line, k) => (
              <div
                key={k}
                className={`whitespace-pre px-3 ${line.kind === '-' ? 'bg-[rgba(220,38,38,0.32)] text-[#FECACA]' : line.kind === '+' ? 'bg-[rgba(22,163,74,0.32)] text-[#DCFCE7]' : line.kind === '…' ? 'text-[#6B7280]' : 'text-[#E5E7EB]'}`}
              >
                <span className="inline-block w-5 select-none text-[#9CA3AF]">{line.kind === ' ' ? '' : line.kind === '…' ? '' : line.kind}</span>
                {line.kind === '…' ? '⋯' : line.text || ' '}
              </div>
            ))}
          </div>
        ) : (
          <div className="mx-4 mb-3 rounded-[10px] bg-[#F4F5F7] px-3 py-2 text-[12.5px] text-[#374151]">The AI proposed no change to the code. {fix.diagnosis}</div>
        )
      ) : !error ? (
        <div className="h-[180px] animate-pulse bg-[#1B1B1F]" />
      ) : null}
      <div className="flex items-center gap-2 border-t border-[#E8EAEE] px-4 py-3">
        <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-[#1F2937]">
          <input type="checkbox" checked={save} disabled={!source.scriptId} onChange={e => setSave(e.target.checked)} className="h-4 w-4 accent-[#6D28D9]" />
          Save the fix to the script
        </label>
        <span className="text-[11.5px] text-[#6B7280]">Untick to try it once</span>
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={onDiscard} disabled={busy} className={BTN}>Discard</button>
          <button type="button" onClick={() => void go()} disabled={!fix || !diff.length || busy || !canExecute} className={PURPLE}>
            {busy ? 'Starting…' : save ? 'Save fix & dry run' : 'Dry run the fix once'}
          </button>
        </div>
      </div>
    </Popup>
  )
}

// --- B4 · Bulk dry run --------------------------------------------------------------------------

export interface BulkItem {
  caseId: number
  tc: string
  title: string
  scriptId: number
  state: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled'
  runKey: string | null
  /** "Failed at step 1", "Running · step 2 of 4". */
  detail: string | null
}

export interface BulkSkip {
  caseId: number
  tc: string
  reason: string
  fix: { label: string; to?: string; action?: 'generate' | 'edit' | 'data' } | null
}

export interface BulkJob {
  projectLabel: string
  title: string
  subtitle: string
  items: BulkItem[]
  skipped: BulkSkip[]
  /** Still working out who can run. */
  checking: boolean
}

export const bulkFinished = (job: BulkJob) => job.items.filter(i => i.state === 'passed' || i.state === 'failed' || i.state === 'cancelled').length
export const bulkActive = (job: BulkJob | null) => Boolean(job && (job.checking || job.items.some(i => i.state === 'queued' || i.state === 'running')))

export const BulkPopup: React.FC<{
  job: BulkJob
  onCancelRemaining: () => void
  onClose: () => void
  onOpen: (caseId: number) => void
  onWatch: (runKey: string) => void
  onFix: (skip: BulkSkip) => void
}> = ({ job, onCancelRemaining, onClose, onOpen, onWatch, onFix }) => {
  const finished = bulkFinished(job)
  const total = job.items.length
  const remaining = job.items.some(i => i.state === 'queued')
  return (
    <Popup label={job.title} width="max-w-[745px]" onClose={onClose}>
      <div className="flex items-start gap-3 px-4 pb-3 pt-3.5">
        <div className="min-w-0 flex-1">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[#6B7280]">{job.projectLabel}</div>
          <h2 className="m-0 mt-0.5 text-[15px] font-bold text-[#1F2937]">{job.title}</h2>
          <div className="mt-0.5 text-[11.5px] text-[#6B7280]">{job.subtitle}</div>
        </div>
        <PopupClose onClick={onClose} />
      </div>
      <div className="flex items-center gap-3 border-y border-[#E8EAEE] px-4 py-2.5">
        <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-[#E8EAEE]">
          {job.items.map(item => (
            <span
              key={item.caseId}
              className={item.state === 'passed' ? 'bg-[#16A34A]' : item.state === 'failed' ? 'bg-[#DC2626]' : item.state === 'running' ? 'bg-[#3B82F6]' : item.state === 'cancelled' ? 'bg-[#9CA3AF]' : 'bg-transparent'}
              style={{ width: `${100 / Math.max(1, total)}%` }}
            />
          ))}
        </span>
        <span className="whitespace-nowrap text-[11.5px] text-[#6B7280]">{job.checking ? 'Checking…' : `${finished} of ${total} finished`}</span>
      </div>
      <ol>
        {job.items.map(item => (
          <li key={item.caseId} className={`grid grid-cols-[22px_80px_minmax(0,1fr)_170px_56px] items-center gap-2 border-b border-[#F1F2F4] px-4 py-2.5 text-[12.5px] ${item.state === 'running' ? 'bg-[#F5F8FF]' : ''}`}>
            {item.state === 'passed' ? <DoneDot size={18} /> : item.state === 'failed' ? <FailDot size={18} /> : item.state === 'running' ? <SpinDot size={18} /> : <EmptyDot size={18} />}
            <span className="font-mono text-[11.5px] font-bold text-[#1F2937]">{item.tc}</span>
            <span className="truncate text-[#1F2937]" title={item.title}>{item.title}</span>
            <span className={`truncate font-semibold ${item.state === 'failed' ? 'text-[#B71920]' : item.state === 'running' ? 'text-[#1D4ED8]' : item.state === 'passed' ? 'text-[#136B34]' : 'font-normal text-[#6B7280]'}`}>
              {item.detail ?? (item.state === 'queued' ? 'Queued' : item.state === 'cancelled' ? 'Cancelled' : item.state === 'passed' ? 'Passed' : item.state === 'failed' ? 'Failed' : 'Running')}
            </span>
            <span className="text-right">
              {item.state === 'running' && item.runKey ? (
                <button type="button" onClick={() => onWatch(item.runKey!)} className="font-bold text-[#B71920] hover:underline">Watch</button>
              ) : item.state === 'passed' || item.state === 'failed' ? (
                <button type="button" onClick={() => onOpen(item.caseId)} className="font-bold text-[#B71920] hover:underline">Open</button>
              ) : null}
            </span>
          </li>
        ))}
        {job.skipped.map(skip => (
          <li key={`skip-${skip.caseId}`} className="border-b border-[#F3E3C3] bg-[#FFFBF2] px-4 py-2 text-[11.5px] text-[#B45309]">
            Skipped: {skip.tc} — {skip.reason}
            {skip.fix ? (
              <>
                {' · '}
                {skip.fix.to ? (
                  <Link to={skip.fix.to} className="font-bold text-[#B71920] hover:underline">{skip.fix.label}</Link>
                ) : (
                  <button type="button" onClick={() => onFix(skip)} className="font-bold text-[#B71920] hover:underline">{skip.fix.label}</button>
                )}
              </>
            ) : null}
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-2 px-4 py-3">
        <span className="text-[11.5px] text-[#6B7280]">Close any time — runs continue and each row in the case list shows its result.</span>
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={onCancelRemaining} disabled={!remaining} className={`${BTN} !text-[#B71920]`}>Cancel remaining</button>
          <button type="button" onClick={onClose} className={PRIMARY}>Close</button>
        </div>
      </div>
    </Popup>
  )
}

// --- B6 · Generate scripts -------------------------------------------------------------------

export interface GenItem {
  caseId: number
  tc: string
  title: string
  /** Has a script already: only generated when "Also regenerate" is ticked. */
  existing: boolean
  state: 'ready' | 'generating' | 'passed' | 'gate_failed' | 'skipped' | 'error'
  detail: string | null
  scriptId: number | null
}

export interface GenJob {
  projectLabel: string
  framework: string
  applicationId: number | null
  regenerate: boolean
  items: GenItem[]
  started: boolean
}

export const genActive = (job: GenJob | null) => Boolean(job && job.items.some(i => i.state === 'generating'))
const genDone = (job: GenJob) => job.started && !job.items.some(i => i.state === 'generating' || (i.state === 'ready' && (!i.existing || job.regenerate)))

const FieldBox: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="min-w-0 rounded-[10px] border border-[#E8EAEE] bg-white px-3 py-2">
    <div className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-[#6B7280]">{label}</div>
    <div className="mt-0.5 text-[12.5px] font-bold text-[#1F2937]">{children}</div>
  </div>
)

export const GeneratePopup: React.FC<{
  job: GenJob
  frameworks: { name: string; label: string; runnable: boolean }[]
  applications: RegisteredApplication[]
  canExecute: boolean
  onChange: (patch: Partial<Pick<GenJob, 'framework' | 'applicationId' | 'regenerate'>>) => void
  onStart: () => void
  onClose: () => void
  onDryRun: () => void
}> = ({ job, frameworks, applications, canExecute, onChange, onStart, onClose, onDryRun }) => {
  const fw = frameworks.find(f => f.name === job.framework)
  const fwLabel = fw?.label ?? frameworkLabel(job.framework)
  const missing = job.items.filter(i => !i.existing)
  const existing = job.items.filter(i => i.existing)
  const shown = job.items.filter(i => !i.existing || job.regenerate)
  const app = applications.find(a => a.id === job.applicationId) ?? null
  const controls = app?.discovery?.elements_discovered ?? 0
  const done = genDone(job)
  const ready = job.items.filter(i => i.state === 'passed').length
  const runnable = fw?.runnable ?? job.framework === 'playwright'
  const existingIds = existing.map(i => i.tc)
  const range = existingIds.length > 2 ? `${existingIds[0]}…${existingIds[existingIds.length - 1].replace(/^[A-Z]+-/, '')}` : existingIds.join(', ')
  const select = 'w-full appearance-none bg-transparent pr-4 text-[12.5px] font-bold text-[#1F2937] outline-none disabled:cursor-default'

  return (
    <Popup label={`Generate ${fwLabel} scripts`} width="max-w-[745px]" onClose={onClose}>
      <div className="flex items-start gap-3 px-4 pb-3 pt-3.5">
        <div className="min-w-0 flex-1">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[#6B7280]">{job.projectLabel}</div>
          <h2 className="m-0 mt-0.5 text-[15px] font-bold text-[#1F2937]">
            {job.regenerate ? `Generate ${shown.length} ${fwLabel} script${shown.length === 1 ? '' : 's'}` : `Generate ${missing.length} missing ${fwLabel} script${missing.length === 1 ? '' : 's'}`}
          </h2>
          <div className="mt-0.5 text-[11.5px] text-[#6B7280]">Each script is checked by the static gate before anything runs</div>
        </div>
        <PopupClose onClick={onClose} />
      </div>
      <div className="grid grid-cols-3 gap-2.5 border-t border-[#E8EAEE] bg-[#FAFAFB] px-4 py-2.5">
        <FieldBox label="Framework">
          <span className="relative flex items-center">
            <select aria-label="Framework" value={job.framework} disabled={job.started} onChange={e => onChange({ framework: e.target.value })} className={select}>
              {(frameworks.length ? frameworks : [{ name: 'playwright', label: 'Playwright', runnable: true }]).map(f => <option key={f.name} value={f.name}>{f.label}</option>)}
            </select>
            {!job.started && <span className="pointer-events-none absolute right-0 text-[#1F2937]"><ChevronGlyph /></span>}
          </span>
        </FieldBox>
        <FieldBox label="Application">
          <span className="relative flex items-center">
            <select aria-label="Application" value={job.applicationId ?? ''} disabled={job.started} onChange={e => onChange({ applicationId: e.target.value ? Number(e.target.value) : null })} className={select}>
              <option value="">Not chosen</option>
              {applications.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            {!job.started && <span className="pointer-events-none absolute right-0 text-[#1F2937]"><ChevronGlyph /></span>}
          </span>
        </FieldBox>
        <FieldBox label="Knowledge Base">
          <span className="block truncate" title={app ? `${app.name}'s discovery catalogue` : undefined}>
            {app ? (app.discovery ? `Automation KB · ${controls} control${controls === 1 ? '' : 's'}` : 'Automation KB · not crawled yet') : 'Choose an application'}
          </span>
        </FieldBox>
      </div>
      <ol>
        {shown.length === 0 ? (
          <li className="border-y border-[#F1F2F4] px-4 py-3 text-[12.5px] text-[#6B7280]">Every case here already has a {fwLabel} script. Tick below to regenerate them.</li>
        ) : shown.map(item => (
          <li key={item.caseId} className="grid grid-cols-[22px_80px_minmax(0,1fr)_minmax(150px,auto)] items-center gap-2 border-t border-[#F1F2F4] px-4 py-2.5 text-[12.5px]">
            {item.state === 'generating' ? <SpinDot size={18} /> : item.state === 'passed' ? <DoneDot size={18} /> : item.state === 'gate_failed' || item.state === 'error' ? <FailDot size={18} /> : <EmptyDot size={18} dashed={item.state === 'ready'} />}
            <span className="font-mono text-[11.5px] font-bold text-[#1F2937]">{item.tc}</span>
            <span className="truncate text-[#1F2937]" title={item.title}>{item.title}</span>
            <span className={`truncate text-right font-semibold ${item.state === 'generating' ? 'text-[#1D4ED8]' : item.state === 'passed' ? 'text-[#136B34]' : item.state === 'ready' ? 'font-normal text-[#6B7280]' : 'text-[#B45309]'}`} title={item.detail ?? undefined}>
              {item.state === 'generating' ? 'Generating… then static gate'
                : item.state === 'ready' ? (job.started ? 'Queued' : 'Ready')
                  : item.detail}
            </span>
          </li>
        ))}
        {existing.length > 0 && (
          <li className="border-t border-[#F1F2F4] px-4 py-2.5">
            <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-[#6B7280]">
              <input type="checkbox" checked={job.regenerate} disabled={job.started} onChange={e => onChange({ regenerate: e.target.checked })} className="h-3.5 w-3.5 accent-[#B71920]" />
              Also regenerate the {existing.length} case{existing.length === 1 ? '' : 's'} that already have a script ({range}) — edited scripts are flagged before they are replaced
            </label>
          </li>
        )}
      </ol>
      <div className="flex items-center gap-2 border-t border-[#E8EAEE] px-4 py-3">
        <span className="text-[11.5px] text-[#6B7280]">You can close this; generation continues and the case list fills in.</span>
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={onClose} className={BTN}>Close</button>
          {!job.started ? (
            <button type="button" onClick={onStart} disabled={!shown.length || !canExecute} className={`${PRIMARY} disabled:opacity-50`}>
              <StarGlyph />
              Generate {shown.length}
            </button>
          ) : (
            <button
              type="button"
              onClick={onDryRun}
              disabled={!done || !ready || !runnable || !canExecute}
              title={!runnable ? `${fwLabel} is generate-only — no runner exists for it.` : undefined}
              className={`${PRIMARY} disabled:bg-none disabled:bg-[#F3A3A6] disabled:shadow-none`}
            >
              Dry run when ready
            </button>
          )}
        </div>
      </div>
    </Popup>
  )
}

// --- Edit ---------------------------------------------------------------------------------------

export const EditPopup: React.FC<{
  title: string
  fileName: string
  version: number
  code: string
  canExecute: boolean
  onSave: (code: string) => Promise<void>
  onClose: () => void
}> = ({ title, fileName, version, code: initial, canExecute, onSave, onClose }) => {
  const [code, setCode] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await onSave(code)
    } catch (err: any) {
      setError(err?.message ?? 'The edits could not be saved.')
      setSaving(false)
    }
  }
  return (
    <Popup label={`Edit ${fileName}`} width="max-w-[1000px]" onClose={onClose} locked={saving}>
      <div className="flex items-center gap-3 border-b border-[#E8EAEE] px-5 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-bold text-[#1F2937]">{title}</div>
          <div className="truncate font-mono text-[12px] text-[#6B7280]">{fileName} · v{version} · {code.split('\n').length} lines</div>
        </div>
        <PopupClose onClick={onClose} />
      </div>
      {error && <div role="alert" className="mx-5 mt-3 rounded-[10px] border border-[#F6D4D5] bg-[#FFF8F8] px-3 py-2 text-[12.5px] text-[#7A0B0D]">{error}</div>}
      <textarea
        value={code}
        onChange={e => setCode(e.target.value)}
        onKeyDown={e => {
          if (e.key !== 'Tab') return
          e.preventDefault()
          const target = e.currentTarget
          const start = target.selectionStart
          const end = target.selectionEnd
          setCode(code.substring(0, start) + '  ' + code.substring(end))
          window.setTimeout(() => { target.selectionStart = target.selectionEnd = start + 2 }, 0)
        }}
        spellCheck={false}
        className="m-4 h-[60vh] resize-none rounded-[12px] bg-[#1B1B1F] p-4 font-mono text-[12.5px] leading-[1.7] text-[#E5E7EB] outline-none"
      />
      <div className="flex items-center gap-2 border-t border-[#E8EAEE] bg-[#FCFCFD] px-5 py-3">
        <button type="button" onClick={() => setCode(initial)} disabled={saving || code === initial} className="text-[12.5px] font-semibold text-[#6B7280] hover:text-[#1F2937] disabled:opacity-40">
          Reset to current code
        </button>
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={onClose} disabled={saving} className={BTN}>Cancel</button>
          <button type="button" onClick={() => void save()} disabled={saving || !canExecute || code === initial} className={`${PRIMARY} disabled:opacity-50`}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </Popup>
  )
}

// --- Other runs: no test case (discovery crawls, hand-written specs) ------------------------------

export const OtherRunsPopup: React.FC<{
  runs: RunSummary[]
  onOpen: (runKey: string) => void
  onClose: () => void
}> = ({ runs, onOpen, onClose }) => (
  <Popup label="Other runs" width="max-w-[680px]" onClose={onClose}>
    <div className="flex items-start gap-3 px-4 pb-3 pt-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[#6B7280]">Automation Lab</div>
        <h2 className="m-0 mt-0.5 text-[15px] font-bold text-[#1F2937]">Other runs</h2>
        <div className="mt-0.5 text-[11.5px] text-[#6B7280]">Runs with no test case: discovery crawls and hand-written specs</div>
      </div>
      <PopupClose onClick={onClose} />
    </div>
    <ol className="app-scroll max-h-[420px] overflow-auto border-t border-[#E8EAEE]">
      {runs.length === 0 ? (
        <li className="px-4 py-4 text-[12.5px] text-[#6B7280]">None yet.</li>
      ) : runs.map(run => {
        const tone = toneOf(run)
        return (
          <li key={run.run_key} className="grid grid-cols-[22px_minmax(0,1fr)_110px_90px_44px] items-center gap-2 border-b border-[#F1F2F4] px-4 py-2.5 text-[12.5px]">
            {tone === 'passed' ? <DoneDot size={18} /> : tone === 'running' || tone === 'queued' ? <SpinDot size={18} /> : tone === 'cancelled' ? <EmptyDot size={18} /> : <FailDot size={18} />}
            <span className="min-w-0">
              <span className="block truncate font-mono text-[11.5px] font-bold text-[#1F2937]">{run.run_key}</span>
              <span className="block truncate text-[11.5px] text-[#6B7280]">{[modeLabel(run), run.file_name, run.triggered_by].filter(Boolean).join(' · ')}</span>
            </span>
            <span className={`${CHIP} justify-self-start ${TONE_CHIP[tone]}`}>{TONE_LABEL[tone]}</span>
            <span className="text-[11.5px] tabular-nums text-[#6B7280]">{dayTime(run.started_at ?? run.created_at)}</span>
            <button type="button" onClick={() => onOpen(run.run_key)} className="text-right font-bold text-[#B71920] hover:underline">Open</button>
          </li>
        )
      })}
    </ol>
  </Popup>
)
