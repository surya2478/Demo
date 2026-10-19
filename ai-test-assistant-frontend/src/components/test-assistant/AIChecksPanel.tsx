import React, { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useSearchParams } from 'react-router-dom'
import RqmDownload, { type RqmVersion } from './RqmDownload'
import type { AgentName, CheckBatch, CheckItem, CheckStepName, CheckStepState } from '../../services/aiChecksService'
import AgentTestDataSetup from './AgentTestDataSetup'
import aiChecksService from '../../services/aiChecksService'
import { agentState, blockerSummary, caseStatus, parallelAgent } from './agentPresentation'

// Screen 3: AI Checks results, in the Output card. Refine -> Quality Review ->
// Auto-Improve (only when the review did not pass) -> AI Classify.

type Filter = 'all' | 'automation' | 'manual' | 'improved' | 'test_data' | 'not_checked' | 'stopped'

const STAGES: { key: CheckStepName; label: string; letter: string }[] = [
  { key: 'refine', label: '1 · AI Refine', letter: 'R' },
  { key: 'review', label: '2 · Quality Check', letter: 'Q' },
  { key: 'improve', label: '3 · Auto-Improve', letter: 'I' },
  { key: 'classify', label: '4 · AI Classify', letter: 'C' }
]

const CHIP = 'inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-[9px] text-[11.5px] font-semibold'
const C_AUTO = 'bg-[#EAF7EF] text-[#136B34]'
const C_MAN = 'bg-[#F4F5F7] text-[#374151]'
const C_WARN = 'bg-[#FFF4E5] text-[#8A5000]'
const C_BAD = 'bg-[#FEEBEC] text-[#A3231C]'
const C_BRAND = 'bg-[#FFF5F5] text-[#941216]'
const ROW = 'grid grid-cols-[22px_70px_minmax(190px,1fr)_104px_90px_130px_245px] items-center gap-3 border-b border-[#F1F2F4] px-4'

const Tick: React.FC<{ size?: number; color?: string; width?: number }> = ({ size = 14, color = '#fff', width = 3 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={width} aria-hidden><path d="M5 12l5 5 9-10" /></svg>
)

const BTN = 'flex h-9 items-center gap-2 whitespace-nowrap rounded-[12px] border border-[#E8EAEE] bg-white px-4 text-[13px] font-bold transition hover:border-[#F6D4D5] disabled:cursor-not-allowed disabled:opacity-50'

const AGENT_STAGES: { key: AgentName; label: string; detail: string }[] = [
  { key: 'requirements_guide', label: 'Requirements Guide', detail: 'Crawls the registered entry and reviews your saved actions' },
  { key: 'crawl_guide', label: 'Crawl Guide', detail: 'Reviews browser evidence and coordinates a bounded recrawl or verified sign-in' },
  { key: 'navigation_guide', label: 'Navigation Guide', detail: 'Reuses saved evidence, then explores missing public routes in a live browser' },
  { key: 'evidence_coordinator', label: 'Evidence Coordinator', detail: 'Separates script prerequisites from results only the browser can observe after replay' },
  { key: 'automation', label: 'Automation Expert', detail: 'Checks script readiness, then verifies the journey in a browser' },
  { key: 'analysis', label: 'Analysis Expert', detail: 'Refines the case from captured evidence' },
  { key: 'audit', label: 'Audit Expert', detail: 'Checks quality and the journey mapping' },
  { key: 'data_entry', label: 'Data Entry Expert', detail: 'Prepares KB updates for your approval' }
]

const AgentProgressBoard: React.FC<{ batch: CheckBatch; onCheckChanges: () => void; onReviewChanges: (ids: number[]) => void; onAgentDecide: () => void; onRetryApprovalManager: (checkId: number) => void; onScanMissing: (checkId: number) => void; onRepair: (checkId: number) => void; onRetryDataEntry: (checkId: number) => void; onRetryAnalysis: (checkId: number) => void; onRetryAgent: (checkId: number, agent: AgentName) => void; onRetry: (checkId: number) => void; onSend: () => void; onSendOriginal: (checkId: number) => void; sendCount: number; sentIds: Set<number>; onContinueBrowserReplay: (checkId: number) => void; canAgentDecide: boolean }> = ({ batch, onRetryAgent, onCheckChanges, onReviewChanges }) => {
  const [expanded, setExpanded] = useState(false)
  const [work, setWork] = useState<AgentName | null>(null)
  const [selectedCase, setSelectedCase] = useState<number | null>(null)
  const [sessionParams] = useSearchParams()
  const requestedCheck = Number(sessionParams.get('check')) || null
  const [casesOpen, setCasesOpen] = useState(false)
  const [headed, setHeaded] = useState(Boolean(batch.agent_setup?.headed))
  const [modeBusy, setModeBusy] = useState(false)
  const [modeError, setModeError] = useState('')
  useEffect(() => { setHeaded(Boolean(batch.agent_setup?.headed)); setCasesOpen(false) }, [batch.batch_id, batch.agent_setup?.headed])
  useEffect(() => { setSelectedCase(requestedCheck); setWork(null) }, [batch.batch_id, requestedCheck])
  useEffect(() => { if (!work) return; const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setWork(null) }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close) }, [work])
  const current = batch.items.find(item => item.check_id === selectedCase) || batch.items.find(item => item.status === 'running' || item.status === 'queued')
    || batch.items[batch.items.length - 1]
  const stages = [...AGENT_STAGES, { key: 'expert_editor' as AgentName, label: 'Expert Editor', detail: 'Coordinates recovery' },
    { key: 'approval_manager' as AgentName, label: 'Approval Manager', detail: 'Reviews evidence-backed changes' }]
  const active = stages.filter(stage => ['working', 'queued', 'retry_wait'].includes(current?.agents?.[stage.key]?.status || ''))
  const handedOff = batch.items.filter(item => item.evaluation_handoff)
  const running = batch.status === 'running'
  const caseRunning = current?.status === 'running' || current?.status === 'queued'
  const recovering = running && batch.items.some(item => Object.values(item.agents || {}).some(agent => agent?.status === 'failed'))
  const sourceActions = current?.authoring?.source_actions || Object.entries(current?.source_row || {}).find(([key]) => /^(steps|test steps|test case steps)$/i.test(key))?.[1]?.split(/\n|(?=\d+[.)]\s)/).map(step => step.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean) || []
  const trace = current?.authoring?.trace || current?.agents?.navigation_guide?.navigation_trace || []
  const completed = current?.authoring?.completed_steps || current?.agents?.navigation_guide?.completed_source_steps || []
  const recovery = current?.recovery?.at(-1)
  const replayPassed = current?.authoring?.script_verification?.status === 'passed'
  return <section className="mx-[22px] mt-3.5 overflow-hidden rounded-[16px] border border-[#E4E8EF] bg-white p-4" aria-label="Agent team">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3"><strong className="text-[14px]">{running ? '● Running AI Checks' : 'AI Checks session'}</strong><span className="text-[12px] text-[#667085]">{batch.items.filter(item => ['done', 'failed', 'awaiting_approval'].includes(item.status)).length}/{batch.total} cases checked</span></div>
    <p role="status" aria-live="polite" className="my-2 text-[12px]">
      {running ? recovering ? 'Agents are repairing missing evidence automatically. No action is needed here.' : 'Agents are checking cases and gathering browser evidence. No action is needed here.'
        : handedOff.length === batch.items.length && handedOff.length ? 'Agent work saved in Human Evaluation.'
        : batch.items.some(item => item.status === 'stopped') ? 'Checks stopped. Completed evidence is retained.'
        : batch.items.every(item => item.status === 'done') ? 'Checks complete. Browser evidence and updated steps are saved.'
        : 'Checks finished with unresolved evidence. Details are retained for Human Evaluation.'}
    </p>
    <details className="my-2 text-[12px]"><summary className="cursor-pointer font-semibold">Browser settings · {headed ? 'Headed' : 'Headless'}</summary>
    <label className="my-2 block text-[12px] font-semibold">Agent browser mode <select aria-label="Agent browser mode" value={headed ? 'headed' : 'headless'} disabled={running || modeBusy} className="ml-2 rounded border bg-white p-1" onChange={async event => { const value = event.target.value === 'headed'; setModeBusy(true); setModeError(''); try { await aiChecksService.setHeaded(batch.batch_id, value); setHeaded(value) } catch (error: any) { setModeError(error?.response?.data?.detail || 'Browser mode could not be saved.') } finally { setModeBusy(false) } }}><option value="headless">Headless · background</option><option value="headed">Headed · show browser</option></select></label>
    <p className="my-1 text-[11px] text-[#667085]">Applies to fresh scans and replay on the next attempt, on the backend machine. Saved KB evidence may be reused without opening a browser. Locked while agents run.</p>
    {modeError && <p role="alert" className="text-[12px] text-red-700">{modeError}</p>}
    </details>
    <button type="button" aria-expanded={casesOpen} aria-controls="agent-case-list" onClick={() => setCasesOpen(!casesOpen)} className="my-2 rounded-full border bg-white px-3 py-1 text-[11px] font-bold">{casesOpen ? 'Hide case list' : `Show ${batch.total} cases`} · {batch.items.filter(item => item.status === 'failed').length} unresolved</button>
    {casesOpen && <div id="agent-case-list" className="my-3 max-h-[220px] overflow-auto rounded-[10px] border bg-white" aria-label="Test case agent status">
      <table className="w-full text-left text-[11px]"><thead className="sticky top-0 bg-[#F5F6F8]"><tr><th className="p-2">Case</th><th className="p-2">Status</th><th className="p-2">Active / blocked agent</th></tr></thead><tbody>
        {batch.items.map(item => {
          const owner = stages.find(stage => ['working', 'queued', 'retry_wait'].includes(agentState(stage.key, item.agents?.[stage.key])))
            || stages.find(stage => agentState(stage.key, item.agents?.[stage.key]) === 'failed')
          return <tr key={item.check_id} className={current?.check_id === item.check_id ? 'bg-[#FFF1F1]' : 'border-t'}><td className="p-2"><button type="button" aria-pressed={current?.check_id === item.check_id} title={item.title || ''} className="font-bold text-[#B71920] underline" onClick={() => { setSelectedCase(item.check_id); setWork(null); setExpanded(true) }}>{item.display_id || item.check_id}</button></td><td className="p-2">{caseStatus(item)}</td><td className="p-2">{owner?.label || '—'}</td></tr>
        })}
      </tbody></table>
    </div>}
    <p className="my-2 text-[12px] font-bold">Viewing {current?.display_id} · {current?.title}</p>
    <div className="my-3 flex flex-wrap gap-2 text-[11px]" aria-label="Session verification summary">
      <span className="rounded-full bg-[#F4F5F7] px-3 py-1.5">{completed.length}/{sourceActions.length} instructions observed</span>
      <span className="rounded-full bg-[#F4F5F7] px-3 py-1.5">{trace.filter(step => step.operation !== 'assert').length} browser actions</span>
      <span className={`rounded-full px-3 py-1.5 ${replayPassed ? C_AUTO : C_WARN}`}>{replayPassed ? 'Clean replay verified' : 'Clean replay not yet verified'}</span>
    </div>
    {recovery && <div role="status" className={`my-3 rounded-xl border p-3 text-[12px] ${recovery.status === 'unresolved' ? 'border-amber-200 bg-amber-50' : 'border-blue-200 bg-blue-50'}`}>
      <strong>{recovery.status === 'working' ? 'Adapting to live page changes' : recovery.status === 'verified' ? 'Updated steps verified' : 'Automatic recovery needs review'}</strong>
      <p className="mb-0 mt-1">{recovery.status === 'working' ? 'The agent is rechecking the original instructions against fresh browser evidence. No manual repair is needed while it works.' : recovery.status === 'verified' ? `Replacement steps passed a clean replay. ${recovery.change_set_id ? `Journey update #${recovery.change_set_id}` : 'The updated journey'} follows the assigned approval policy before the workflow resumes.` : 'The bounded recovery did not produce a verified replacement. Previous evidence is preserved; the case is not marked as passed.'}</p>
    </div>}
    <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]">
      <section className="min-w-0 rounded-xl border bg-[#FCFCFD] p-3" aria-label="Updated test steps">
        <div className="mb-3 flex items-center justify-between"><h3 className="m-0 text-[13px] font-bold">Test steps</h3><span className="text-[11px] text-[#667085]">{completed.length}/{sourceActions.length} observed</span></div>
        <p className="mb-3 text-[11px] text-[#667085]">Original instructions with the actions added by the browser agent. Observation is separate from script replay.</p>
        <div className="max-h-[600px] space-y-3 overflow-y-auto">
          {sourceActions.map((action, index) => {
            const number = index + 1
            const observed = trace.filter(step => step.source_step === number)
            const done = completed.includes(number)
            const isCurrent = caseRunning && !done && number === completed.length + 1
            return <details key={`${current?.check_id}-${number}-${isCurrent}`} open={isCurrent} className={`rounded-xl border bg-white ${isCurrent ? 'border-[#B71920]' : 'border-[#E4E8EF]'}`}>
              <summary className="cursor-pointer p-3 text-[12px] font-semibold"><span className="mr-2">{done ? '✓' : number}</span>{action}<span className={`ml-2 inline-block rounded-full px-2 py-0.5 text-[10px] ${done ? 'bg-[#EAF7EF] text-[#136B34]' : 'bg-[#F4F5F7] text-[#667085]'}`}>{done ? 'Observed' : isCurrent ? 'Analyzing' : caseRunning ? 'Queued' : 'Not observed'}</span></summary>
              <ol className="m-0 space-y-2 border-t p-3 text-[11px]">
                {observed.map((step, order) => <li key={order} className="list-none rounded-lg border bg-[#FAFBFD] p-2 [overflow-wrap:anywhere]"><span className="mr-2 text-[#136B34]">✓</span>{step.operation === 'assert' ? `Verify ${step.kind}: ${step.value}` : `${step.operation || 'click'} ${step.label || step.to_url}`}{step.data_ref && <div className="mt-1 text-[#667085]">Test Data: {step.data_ref} · value hidden</div>}</li>)}
                {!observed.length && <li className="list-none text-[#667085]">{isCurrent ? 'Analyzing the current browser page…' : 'Browser actions will appear here.'}</li>}
              </ol>
            </details>
          })}
          {!sourceActions.length && <p className="text-[12px] text-[#667085]">The saved test instructions will appear when the case is loaded.</p>}
        </div>
      </section>
      <section className="min-w-0 rounded-xl border bg-[#F8FAFC] p-3" aria-label="Session activity">
        <div className="mb-2 flex items-center gap-2"><strong className="text-[13px]">Agent activity</strong><span className="rounded-full bg-white px-2 py-1 text-[10px]">{caseRunning ? 'Live updates' : 'Saved session'}</span></div>
        <p className="text-[11px] text-[#667085]">Browser preview is not available for this backend session. Follow the agents here; headed windows open on the backend machine.</p>
    {caseRunning && active.map(stage => <p key={stage.key} className="my-1 text-[11px]"><strong>{stage.label}:</strong> {current?.agents?.[stage.key]?.message || stage.detail}</p>)}
    <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className="mt-3 rounded-full border bg-white px-3 py-1.5 text-[11px] font-bold">{expanded ? 'Hide agent details ↑' : 'Show all agents ↓'}</button>
    {expanded && <div>
      <div id="agent-team-details" className="mt-3 grid max-h-[600px] gap-2 overflow-y-auto xl:grid-cols-2">
        {stages.map((stage, index) => {
          const progress = current?.agents?.[stage.key]
          const state = agentState(stage.key, progress)
          const held = !caseRunning && state === 'waiting'
          return <div key={stage.key} className={`min-h-[130px] rounded-[12px] border p-3 ${state === 'done' ? 'border-[#BBDFC8] bg-[#F5FBF7]' : state === 'failed' ? 'border-[#F0C2C0] bg-[#FFF1F1]' : 'border-[#E4E8EF] bg-white'}`}>
            <div className="flex items-center gap-2"><span className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold ${state === 'done' ? 'bg-[#136B34] text-white' : 'bg-[#EFF1F4] text-[#667085]'}`}>{state === 'done' ? '✓' : parallelAgent(stage.key) ? '↔' : index + 1}</span><strong className="text-[12px]">{stage.label}</strong></div>
            <span className="mt-2 inline-block rounded-full bg-[#EFF1F4] px-2 py-0.5 text-[10px] font-semibold" title={parallelAgent(stage.key) ? 'Reviews available evidence alongside the sequential pipeline; this does not mean it is running now.' : 'Runs after its prerequisite handoff.'}>{parallelAgent(stage.key) ? 'Parallel reviewer' : 'Sequential'}</span>
            <div className="mt-2 text-[10px] font-bold uppercase text-[#667085]">{held ? 'On hold · upstream evidence required' : state === 'failed' ? caseRunning ? 'Recovery in progress' : stage.key === 'expert_editor' ? 'Recovery unresolved' : 'Unresolved · see Human Evaluation' : state.replaceAll('_', ' ')}</div>
            <p className={`my-2 ${state === 'failed' ? '' : 'line-clamp-3'} text-[11px] text-[#667085] [overflow-wrap:anywhere]`}>{held ? 'This stage cannot run until its prerequisite is resolved. Saved work is retained; it is not marked as passed.' : blockerSummary(stage.key, progress?.message || stage.detail)}</p>
            <button type="button" onClick={() => setWork(stage.key)} className="mt-2 text-[11px] font-bold text-[#B71920] underline" aria-label={`View ${stage.label} work`}>View work</button>
          </div>
        })}
      </div>
    </div>}
      </section>
    </div>
    {batch.items.filter(item => !running && item.status === 'failed' && /invalid credentials?|rejected the configured|missing username|test data is incomplete|incorrect password/i.test(item.error || '')).map(item =>
      <div key={item.check_id} className="mt-3 rounded-[12px] border border-[#EBCFA4] bg-[#FFFBF4] p-3">
        <strong>{item.display_id}: update the authorized test login</strong>
        <p className="text-[12px]">Dependent steps are on hold. Correct the saved credentials below; agents resume from the saved Navigation handoff after valid data is saved. Other evidence gaps remain in Human Evaluation.</p>
        <AgentTestDataSetup batchId={batch.batch_id} checkId={item.check_id} onSaved={() => {}} onProfileDraft={id => onReviewChanges([id])} onReady={() => onRetryAgent(item.check_id, AGENT_STAGES.find(stage => item.agents?.[stage.key]?.status === 'failed')?.key || 'navigation_guide')} />
      </div>)}
    {work && createPortal(<div className="fixed inset-0 z-[90] flex items-center justify-center bg-[#111827]/55 p-4" onMouseDown={event => { if (event.target === event.currentTarget) setWork(null) }}>
      <div role="dialog" aria-modal="true" aria-label={`${stages.find(stage => stage.key === work)?.label} work`} onClick={event => event.stopPropagation()} className="max-h-[80vh] w-full max-w-[760px] overflow-y-auto rounded-[16px] bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between"><h3 className="font-bold">{stages.find(stage => stage.key === work)?.label} · Work &amp; evidence</h3><button autoFocus type="button" onClick={() => setWork(null)} className="rounded border px-3 py-1">Close</button></div>
        <p className="text-[12px] font-bold">{current?.display_id} · {parallelAgent(work) ? 'Parallel reviewer' : 'Sequential stage'}</p>
        <p className="text-[12px] [overflow-wrap:anywhere]">{blockerSummary(work, current?.agents?.[work]?.message || 'Waiting for prerequisite evidence.')}</p>
        <details className="text-[12px]"><summary>Technical reason (original)</summary><p className="[overflow-wrap:anywhere]">{current?.agents?.[work]?.message}</p></details>
        {!!current?.agents?.[work]?.navigation_trace?.length && <section className="rounded border bg-[#F8FAFD] p-3 text-[12px]">
          <h4 className="font-bold">Browser-authored steps</h4>
          <p className="my-1 text-[#667085]">Each action is linked to its original testcase step. Captured evidence is not a passing test result until replay succeeds.</p>
          {current?.agents?.[work]?.script_verification && <p>Generated script replay: {current.agents[work]!.script_verification!.status}</p>}
          <ol className="list-decimal space-y-2 pl-5">{current.agents[work]!.navigation_trace!.map((step, index) => <li key={index}>
            <strong>{step.source_step ? `Source step ${step.source_step} · ` : ''}{step.operation || 'click'} {step.label || step.kind || ''}</strong>
            {step.data_ref && <div>Assigned Test Data: {step.data_ref} (value hidden)</div>}
            {step.operation === 'assert' && <div>{step.value}</div>}
            <div className="break-all text-[#667085]">{step.from_url} → {step.to_url}</div>
          </li>)}</ol>
        </section>}
        {current?.agents?.[work]?.capture_issue && <p role="status" className="text-[12px] text-[#A3231C] [overflow-wrap:anywhere]">Browser capture stopped: {current.agents[work]!.capture_issue}</p>}
        {(current?.agents?.[work]?.events || []).map((event, index) => <p key={index} className="border-t py-2 text-[12px] [overflow-wrap:anywhere]"><strong>{event.status}:</strong> {event.message}</p>)}
      </div>
    </div>, document.body)}
    <p className="mb-0 mt-3 text-[11px] text-[#667085]">Agents retry recoverable gaps within safety limits and retain completed evidence. Invalid credentials can be corrected here; OTPs, approvals, and unresolved controls are handled in Human Evaluation—not by guessing or marking them as passed.</p>
  </section>
}

/** A case can be selected once nothing is working on it: to send, delete or restart. */
export const isSettled = (item: CheckItem) => item.status === 'done' || item.status === 'failed' || item.status === 'stopped' || item.status === 'awaiting_approval'

const formatElapsed = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

const stageSummary = (batch: CheckBatch, key: CheckStepName) => {
  const p = batch.pipeline[key]
  switch (key) {
    case 'refine':
      return <>{p.done} of {batch.total} structured</>
    case 'review':
      return <>{p.done} scored{p.failed ? <> · <span className="font-semibold text-[#A3231C]">{p.failed} failed</span></> : null}</>
    case 'improve':
      return <>{p.done} improved · {p.skipped} already passed</>
    default:
      return <>{p.done} classified by rule</>
  }
}

// Only a stage something is working on spins. Once the batch is stopped (or
// stopping and this stage has nothing in flight), a stage left part-way shows
// as stopped rather than as still running.
const stageState = (batch: CheckBatch, key: CheckStepName): 'done' | 'running' | 'stopped' | 'pending' => {
  const p = batch.pipeline[key]
  const reached = p.done + p.skipped + p.failed > 0
  if (p.running > 0) return 'running'
  if (p.pending === 0) return reached ? 'done' : 'pending'
  if (batch.status !== 'running' || batch.stopping) return reached ? 'stopped' : 'pending'
  return reached ? 'running' : 'pending'
}

const Dot: React.FC<{ letter: string; state: CheckStepState | 'na' }> = ({ letter, state }) => {
  const cls =
    state === 'done' ? 'bg-[#B71920] text-white'
      : state === 'skipped' ? 'border-[1.5px] border-dashed border-[#C4C8CF] bg-white text-[#9CA3AF]'
        : state === 'failed' ? 'border-[1.5px] border-[#F0C2C0] bg-[#FEEBEC] text-[#A3231C]'
          : state === 'running' ? 'border-2 border-[#F6D4D5] border-t-[#B71920] bg-white text-[#B71920] animate-spin'
            : 'bg-[#F4F5F7] text-[#C4C8CF]'
  const title = state === 'skipped' && letter === 'I' ? 'Auto-Improve was not needed: Quality Check passed.' : { done: 'done', skipped: 'skipped', failed: 'failed', running: 'running', pending: 'waiting', na: 'not run' }[state]
  return (
    <span title={`${letter}: ${title}`} className={`box-border flex h-[18px] w-[18px] items-center justify-center rounded-full text-[9px] font-bold ${cls}`}>
      {state === 'running' ? '' : letter}
    </span>
  )
}

interface AIChecksPanelProps {
  batch: CheckBatch
  now: number
  selected: Set<number>
  onToggle: (checkId: number) => void
  onToggleAll: (checkIds: number[], on: boolean) => void
  onRetry: (checkId: number) => void
  onContinueBrowserReplay: (checkId: number) => void
  onRepair: (checkId: number) => void
  onScanMissing: (checkId: number) => void
  repairPanel?: React.ReactNode
  onRecheck: (checkId: number) => void
  onEdit: (checkId: number) => void
  onSend: () => void
  onSendOriginal: (checkId: number) => void
  onDownload: () => void
  onStop: () => void
  onRestart: () => void
  onDelete: () => void
  busy: 'stop' | 'restart' | 'delete' | null
  /** The request the generated cases were saved as. */
  savedAs?: string | null
  sendCount: number
  /** Checks already sent for approval; the rest can still be sent. */
  sentIds: Set<number>
  /** Download the cases in the RQM template, as generated or as AI Checks left them. */
  onDownloadCases?: (version: RqmVersion) => void
  downloadingCases?: boolean
  onCheckChanges: () => void
  onReviewChanges: (ids: number[]) => void
  onAgentDecide: () => void
  onRetryApprovalManager: (checkId: number) => void
  onRetryDataEntry: (checkId: number) => void
  onRetryAnalysis: (checkId: number) => void
  onRetryAgent: (checkId: number, agent: AgentName) => void
  onDataProfileDraft: (changeSetId: number) => void
  onDataSaved: () => void
  canAgentDecide: boolean
  onReuseKbEvidenceChange: (enabled: boolean) => Promise<void>
}

const AIChecksPanel: React.FC<AIChecksPanelProps> = ({
  batch, now, selected, onToggle, onToggleAll, onRetry, onContinueBrowserReplay, onRepair, repairPanel, onRecheck, onEdit, onSend, onSendOriginal, onDownload, onStop, onRestart, onDelete, busy, savedAs, sendCount, sentIds,
  onDownloadCases, downloadingCases = false, onCheckChanges, onReviewChanges, onAgentDecide, onRetryApprovalManager, onScanMissing, onRetryDataEntry, onRetryAnalysis, onRetryAgent, onDataProfileDraft, onDataSaved, canAgentDecide, onReuseKbEvidenceChange
}) => {
  const [filter, setFilter] = useState<Filter>('all')
  const [dataCheckId, setDataCheckId] = useState<number | null>(null)
  const [savingKbPreference, setSavingKbPreference] = useState(false)
  const [kbPreferenceError, setKbPreferenceError] = useState('')
  const s = batch.summary
  const running = batch.status === 'running'
  const started = batch.started_at ? Date.parse(batch.started_at.endsWith('Z') ? batch.started_at : `${batch.started_at}Z`) : now
  const finished = batch.finished_at ? Date.parse(batch.finished_at.endsWith('Z') ? batch.finished_at : `${batch.finished_at}Z`) : now
  const elapsed = formatElapsed((running ? now : finished) - started)
  const doneCount = batch.items.filter((item) => item.status === 'done' || item.status === 'failed' || item.status === 'awaiting_approval').length
  const inFlight = batch.items.filter((item) => item.status === 'running').length
  const restartable = batch.items.filter((item) => (item.status === 'stopped' || item.status === 'failed') && item.agents?.data_entry?.status !== 'needs_approval').length
  const deleteCount = batch.items.filter((item) => selected.has(item.check_id) && isSettled(item) && !sentIds.has(item.check_id)).length
  const sentTotal = sentIds.size
  const qualityStarted = batch.mode !== 'agents' || batch.items.some((item) =>
    STAGES.some((stage) => item.steps?.[stage.key] && item.steps[stage.key] !== 'pending'))

  const counts: Record<Filter, number> = {
    all: batch.total,
    automation: s.automation,
    manual: s.manual,
    improved: s.improved,
    test_data: s.test_data_pending,
    not_checked: s.not_checked,
    stopped: s.stopped ?? 0
  }

  const visible = useMemo(() => batch.items.filter((item) => {
    switch (filter) {
      case 'automation': return item.classification === 'automation'
      case 'manual': return item.classification === 'manual'
      case 'improved': return item.improved
      case 'test_data': return item.test_data_pending
      case 'not_checked': return item.status === 'failed' && item.agents?.data_entry?.status !== 'needs_approval'
      case 'stopped': return item.status === 'stopped'
      default: return true
    }
  }), [batch.items, filter])

  const selectable = visible.filter((item) => isSettled(item) && !sentIds.has(item.check_id)).map((item) => item.check_id)
  const allOn = selectable.length > 0 && selectable.every((id) => selected.has(id))
  const firstEditable = batch.items.find((item) => selected.has(item.check_id) && item.status === 'done') ?? batch.items.find((item) => item.status === 'done')

  const filterChip = (key: Filter, label: string, tone: string) => (
    <button
      key={key}
      type="button"
      onClick={() => setFilter(key)}
      aria-pressed={filter === key}
      className={`${CHIP} transition ${filter === key ? 'bg-[#1F2937] text-white' : tone}`}
    >
      {label} {counts[key]}
    </button>
  )

  return (
    <section className="flex flex-col overflow-hidden rounded-[20px] border border-[#E8EAEE] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2.5 px-[22px] pt-4">
        <span className="text-[15px] font-bold text-[#1F2937]">AI Checks</span>
        <span className="text-[12px] text-[#6B7280]">Compared with the saved generated test cases above</span>
        <span className={`${CHIP} bg-[#F4F5F7] text-[#1F2937]`}>{batch.total} test cases</span>
        {savedAs && (
          <span className={`${CHIP} ${C_AUTO}`} title="Saved when AI Checks started; Send for Evaluation sends this request">
            <Tick size={11} color="#136B34" width={3.5} />Saved · {savedAs}
          </span>
        )}
        {running && batch.stopping ? (
          <span className={`${CHIP} ${C_WARN}`}>
            <span className="box-border h-2.5 w-2.5 animate-spin rounded-full border-2 border-[#EBCFA4] border-t-[#8A5000]" />
            Stopping · finishing {inFlight} case{inFlight === 1 ? '' : 's'} in progress
          </span>
        ) : running ? (
          <span className={`${CHIP} bg-[#FDEBEC] text-[#941216]`}>
            <span className="h-1.5 w-1.5 rounded-full bg-[#B71920]" />AI Checks running · {doneCount}/{batch.total} · {elapsed}
          </span>
        ) : batch.status === 'awaiting_approval' ? (
          <span className={`${CHIP} ${C_WARN}`}>{batch.agent_auto_approval ? 'Agent resolving KB evidence' : 'Knowledge Base decision needed'}</span>
        ) : batch.status === 'stopped' ? (
          <span className={`${CHIP} ${C_WARN}`}>AI Checks stopped · {doneCount}/{batch.total} checked</span>
        ) : (
          <span className={`${CHIP} ${C_AUTO}`}><Tick size={11} color="#136B34" width={3.5} />AI Checks complete · {elapsed}</span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {running ? (
            <button
              type="button"
              onClick={onStop}
              disabled={batch.stopping || busy !== null}
              data-audit-name="Stop AI Checks"
              title="Waiting cases stop now; a case mid-step stops once that step finishes"
              className={`${BTN} text-[#A3231C]`}
            >
              <span className="h-2.5 w-2.5 rounded-[2px] bg-[#B71920]" aria-hidden />
              {batch.stopping || busy === 'stop' ? 'Stopping…' : 'Stop'}
            </button>
          ) : restartable > 0 ? (
            <button
              type="button"
              onClick={onRestart}
              disabled={busy !== null}
              data-audit-name="Restart AI Checks"
              title="Check the stopped and failed cases again; finished cases keep their results"
              className={`${BTN} text-[#1F2937]`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1F2937" strokeWidth="2" aria-hidden><path d="M4 12a8 8 0 1 0 2.3-5.7" /><path d="M4 4v4h4" /></svg>
              {busy === 'restart' ? 'Restarting…' : `Restart ${restartable}`}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => firstEditable && onEdit(firstEditable.check_id)}
            disabled={!firstEditable}
            className="flex h-9 items-center gap-2 rounded-[12px] border border-[#E8EAEE] bg-white px-4 text-[13px] font-bold text-[#1F2937] transition hover:border-[#F6D4D5] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1F2937" strokeWidth="1.8" aria-hidden><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
            Edit steps
          </button>
          <button
            type="button"
            onClick={onDownload}
            className="flex h-9 items-center rounded-[12px] border border-[#E8EAEE] bg-white px-4 text-[13px] font-bold text-[#1F2937] transition hover:border-[#F6D4D5]"
          >
            Download
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={deleteCount === 0 || busy !== null}
            data-audit-name="Delete AI Checks cases"
            title={deleteCount === 0 ? 'Select the cases to delete' : 'Remove the selected cases from this batch'}
            className={`${BTN} text-[#A3231C]`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
            {busy === 'delete' ? 'Deleting…' : deleteCount ? `Delete ${deleteCount}` : 'Delete'}
          </button>
          <button
            type="button"
            onClick={onSend}
            // Finished cases can go while the rest are still being checked.
            disabled={sendCount === 0}
            data-audit-name="Send for Evaluation"
            className={`flex h-9 items-center gap-2 whitespace-nowrap rounded-[12px] px-4 text-[13px] font-bold transition ${
              sendCount === 0 && sentTotal > 0
                ? 'cursor-not-allowed border border-[#F1A4A6] bg-white text-[#B71920]'
                : sendCount === 0
                  ? 'cursor-not-allowed bg-[#F4F5F7] text-[#9CA3AF]'
                  : 'bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] hover:opacity-95'
            }`}
          >
            {sendCount === 0 && sentTotal > 0 ? `${sentTotal} TCs Pending Evaluation` : `Send ${sendCount} for Evaluation`}
            {(sendCount > 0 || sentTotal === 0) && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>}
          </button>
        </div>
      </div>

      {batch.mode === 'agents' && batch.agent_setup && <div className="mx-[22px] mt-3 rounded-[12px] border border-[#DCE4EE] bg-[#F8FAFD] px-4 py-3 text-[12px] text-[#344054]">
        <label className="flex cursor-pointer items-center gap-2 font-semibold">
          <input type="checkbox" checked={batch.agent_setup.reuse_kb_evidence !== false} disabled={running || savingKbPreference} onChange={async event => {
            setSavingKbPreference(true)
            setKbPreferenceError('')
            try { await onReuseKbEvidenceChange(event.target.checked) }
            catch (error: any) { setKbPreferenceError(error?.response?.data?.detail || error?.message || 'Could not save the setting.') }
            finally { setSavingKbPreference(false) }
          }} />
          Check Knowledge Base evidence first
        </label>
        <p className="mt-1 text-[#667085]">{running ? 'Locked for this running batch. Change it after the run finishes or stops, before retrying.' : 'On: reuse matching saved browser evidence when valid. Off: collect fresh browser evidence on the next retry.'}</p>
        {kbPreferenceError && <p role="alert" className="mt-1 text-[#B71920]">{kbPreferenceError}</p>}
      </div>}
      {batch.mode !== 'agents' && repairPanel}
      {batch.mode === 'agents' && !qualityStarted && batch.items.filter(item => item.test_data_pending && item.status === 'awaiting_approval').map(item => <button key={item.check_id} type="button" onClick={() => setDataCheckId(item.check_id)} className="mx-[22px] mt-3 block text-[12px] font-bold text-[#805000] underline">Resolve Test Data · {item.display_id}</button>)}
      {batch.mode === 'agents' && !qualityStarted ? null : <>
      {/* The shared model-quality pipeline follows the agent handoffs. */}
      {batch.mode === 'agents' && <div className="mx-[22px] mt-3 text-[11px] font-bold uppercase tracking-wide text-[#667085]">After agent browser work · case quality checks</div>}
      <div className="mx-[22px] mt-3.5 flex flex-wrap items-center gap-3.5 rounded-[16px] border border-[#F6D4D5] bg-[linear-gradient(90deg,#FFF8F8,#FFFFFF_75%)] px-[18px] py-3.5">
        {STAGES.map((stage, index) => {
          const state = stageState(batch, stage.key)
          return (
            <React.Fragment key={stage.key}>
              {index > 0 && (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F1A4A6" strokeWidth="2" aria-hidden><path d="M9 6l6 6-6 6" /></svg>
              )}
              <div className="flex min-w-[180px] flex-1 items-center gap-2.5">
                {state === 'done' ? (
                  <div className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-full bg-[#B71920]"><Tick /></div>
                ) : state === 'running' ? (
                  <div className="box-border h-[30px] w-[30px] flex-shrink-0 animate-spin rounded-full border-[3px] border-[#F6D4D5] border-t-[#B71920]" />
                ) : state === 'stopped' ? (
                  <div title="Stopped part-way" className="box-border flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center gap-[3px] rounded-full border-2 border-[#EBCFA4] bg-[#FFFBF4]">
                    <span className="h-2.5 w-[3px] rounded-sm bg-[#8A5000]" /><span className="h-2.5 w-[3px] rounded-sm bg-[#8A5000]" />
                  </div>
                ) : (
                  <div className="box-border flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-full border-2 border-[#D6D9DF] text-[12px] font-bold text-[#9CA3AF]">{index + 1}</div>
                )}
                <div>
                  <div className="text-[13px] font-bold text-[#1F2937]">{stage.label}</div>
                  <div className="text-[12px] text-[#6B7280]">{stageSummary(batch, stage.key)}</div>
                </div>
              </div>
            </React.Fragment>
          )
        })}
      </div>

      {/* Outcome tiles */}
      <div className="mx-[22px] mt-3 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <div className="rounded-[16px] border border-[#BBDFC8] bg-[#F5FBF7] px-3.5 py-3">
          <div className="flex items-baseline gap-2"><span className="text-[24px] font-extrabold leading-none tracking-[-0.02em] text-[#136B34]">{s.automation}</span><span className="text-[13px] font-bold text-[#1F2937]">Automation</span></div>
          <div className="mt-1.5 text-[12px] text-[#6B7280]">Go to Automation Lab once the manager approves</div>
        </div>
        <div className="rounded-[16px] border border-[#E8EAEE] bg-[#FCFCFD] px-3.5 py-3">
          <div className="flex items-baseline gap-2"><span className="text-[24px] font-extrabold leading-none tracking-[-0.02em] text-[#1F2937]">{s.manual}</span><span className="text-[13px] font-bold text-[#1F2937]">Manual</span></div>
          <div className="mt-1.5 text-[12px] text-[#6B7280]">
            {s.needs_minor_changes ? `Includes ${s.needs_minor_changes} that need minor changes to automate` : 'Stay with the manual test team'}
          </div>
        </div>
        <div className="rounded-[16px] border border-[#E8EAEE] bg-[#FCFCFD] px-3.5 py-3">
          <div className="flex items-baseline gap-2">
            <span className="text-[24px] font-extrabold leading-none tracking-[-0.02em] text-[#1F2937]">{s.avg_after ?? '—'}</span>
            <span className="text-[13px] font-bold text-[#1F2937]">Avg quality</span><span className="text-[12px] text-[#6B7280]">/ 5</span>
          </div>
          <div className="mt-1.5 text-[12px] text-[#6B7280]">
            {s.avg_before != null && s.avg_after != null ? `Up from ${s.avg_before} before AI Checks` : 'Scored by Quality Check'}
          </div>
        </div>
        <div className="rounded-[16px] border border-[#EBCFA4] bg-[#FFFBF4] px-3.5 py-3">
          <div className="flex items-baseline gap-2"><span className="text-[24px] font-extrabold leading-none tracking-[-0.02em] text-[#8A5000]">{s.test_data_pending + s.not_checked}</span><span className="text-[13px] font-bold text-[#1F2937]">Need a look</span></div>
          <div className="mt-1.5 text-[12px] text-[#6B7280]">{s.test_data_pending} missing test data · {s.not_checked} not checked</div>
          {batch.items.filter(item => item.test_data_pending).slice(0, 3).map(item => <button key={item.check_id} type="button" onClick={() => { setFilter('test_data'); setDataCheckId(item.check_id) }} className="mt-2 block w-full text-left text-[11px] font-semibold text-[#805000] underline">{item.display_id}: {item.test_data_requirements?.map(requirement => requirement.description || requirement.key).filter(Boolean).join('; ') || item.test_data_notes || 'Open case to see missing data'}</button>)}
          {s.test_data_pending > 3 && <button type="button" onClick={() => setFilter('test_data')} className="mt-1 text-[11px] font-semibold text-[#805000] underline">See all {s.test_data_pending} cases below</button>}
        </div>
      </div>
      </>}
      {dataCheckId !== null && batch.items.some(item => item.check_id === dataCheckId && item.test_data_pending) && <div className="mx-[22px] mt-3 rounded-[12px] border border-[#EBCFA4] bg-[#FFFBF4] p-3"><div className="mb-2 flex items-center justify-between gap-2"><div className="text-[12px] font-bold text-[#805000]">Resolve missing Test Data · {batch.items.find(item => item.check_id === dataCheckId)?.display_id}</div><button type="button" onClick={() => setDataCheckId(null)} className="text-[11px] font-bold underline">Close</button></div><p className="mb-2 text-[11px] text-[#805000]">{batch.items.find(item => item.check_id === dataCheckId)?.test_data_notes}</p>{batch.mode === 'agents' && batch.items.find(item => item.check_id === dataCheckId)?.status === 'awaiting_approval' ? <AgentTestDataSetup batchId={batch.batch_id} checkId={dataCheckId} onSaved={onDataSaved} onProfileDraft={onDataProfileDraft} /> : <p className="text-[11px]">This case is not waiting for an agent data decision. Review its steps and Test Data before sending it onward.</p>}</div>}

      {/* Filters */}
      <div className="mx-[22px] mb-2.5 mt-3.5 flex flex-wrap items-center gap-1.5">
        {filterChip('all', 'All', 'bg-[#F4F5F7] text-[#1F2937]')}
        {filterChip('automation', 'Automation', C_AUTO)}
        {filterChip('manual', 'Manual', C_MAN)}
        {filterChip('improved', 'Improved by AI', C_BRAND)}
        {filterChip('test_data', 'Test data pending', C_WARN)}
        {filterChip('not_checked', 'Not checked', C_BAD)}
        {counts.stopped > 0 && filterChip('stopped', 'Stopped', C_WARN)}
        {onDownloadCases && (
          <span className="ml-2">
            <RqmDownload
              label={`Download ${batch.items.length} TCs`}
              checkedAvailable={batch.items.some((item) => item.status === 'done')}
              busy={downloadingCases}
              disabled={batch.items.length === 0}
              onPick={onDownloadCases}
            />
          </span>
        )}
        <span className="ml-auto flex items-center gap-2.5 text-[12px] text-[#6B7280]">
          <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-full bg-[#B71920]" />done</span>
          <span className="flex items-center gap-1"><span className="box-border h-3 w-3 rounded-full border-[1.5px] border-dashed border-[#C4C8CF]" />skipped</span>
          <span className="flex items-center gap-1"><span className="box-border h-3 w-3 rounded-full border-[1.5px] border-[#F0C2C0] bg-[#FEEBEC]" />failed</span>
        </span>
      </div>

      {/* Table */}
      <div className="mx-[22px] mb-4 overflow-hidden rounded-[16px] border border-[#E8EAEE]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E8EAEE] bg-white px-4 py-2.5">
          <span className="text-[12px] text-[#667085]">{sendCount > 0 ? `${sendCount} selected case${sendCount === 1 ? '' : 's'} ready for evaluation` : sentTotal > 0 ? `${sentTotal} case${sentTotal === 1 ? '' : 's'} pending evaluation` : 'Select a completed case to send for evaluation'}</span>
          <button
            type="button"
            onClick={onSend}
            disabled={sendCount === 0}
            data-audit-name="Send for Evaluation"
            className={`inline-flex h-8 items-center gap-1.5 rounded-[9px] px-3 text-[12px] font-bold transition ${sendCount > 0 ? 'bg-[#B71920] text-white hover:bg-[#941216]' : 'cursor-not-allowed bg-[#F4F5F7] text-[#9CA3AF]'}`}
          >
            {sendCount > 0 ? `Send ${sendCount} for Evaluation` : 'Send for Evaluation'}
            <span aria-hidden="true">→</span>
          </button>
        </div>
        <div className="max-h-[520px] overflow-auto">
          <div className="min-w-[860px]">
            <div className={`${ROW} sticky top-0 z-10 h-9 border-b-[#F6D4D5] bg-[#F4F5F7] text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1F2937]`}>
              <input
                type="checkbox"
                aria-label="Select all cases"
                title="Select all"
                checked={allOn}
                disabled={selectable.length === 0}
                onChange={() => onToggleAll(selectable, !allOn)}
                className="h-4 w-4 accent-[#B71920]"
              />
              <span>TC ID</span><span>Title</span><span>{batch.mode === 'agents' ? 'Case checks' : 'AI Checks'}</span><span>Quality</span><span>Classification</span><span>Flags</span>
            </div>
            {visible.map((item) => <Row key={item.check_id} item={item} agentMode={batch.mode === 'agents'} autoApproval={Boolean(batch.agent_auto_approval)} selected={selected.has(item.check_id)} sent={sentIds.has(item.check_id)} canRetry={!batch.stopping && busy === null} onToggle={onToggle} onRetry={onRetry} onRepair={onRepair} onRecheck={onRecheck} onEdit={onEdit} onCheckChanges={onCheckChanges} onResolveData={setDataCheckId} />)}
            {visible.length === 0 && <div className="px-4 py-6 text-center text-[13px] text-[#6B7280]">No test cases match this filter.</div>}
          </div>
        </div>
      </div>
      {batch.mode === 'agents' && <AgentProgressBoard batch={batch} onCheckChanges={onCheckChanges} onReviewChanges={onReviewChanges} onAgentDecide={onAgentDecide} onRetryApprovalManager={onRetryApprovalManager} onScanMissing={onScanMissing} onRepair={onRepair} onRetryDataEntry={onRetryDataEntry} onRetryAnalysis={onRetryAnalysis} onRetryAgent={onRetryAgent} onRetry={onRetry} onSend={onSend} onSendOriginal={onSendOriginal} sendCount={sendCount} sentIds={sentIds} onContinueBrowserReplay={onContinueBrowserReplay} canAgentDecide={canAgentDecide} />}
    </section>
  )
}

const Row: React.FC<{
  item: CheckItem
  agentMode: boolean
  autoApproval: boolean
  selected: boolean
  sent: boolean
  canRetry: boolean
  onToggle: (id: number) => void
  onRetry: (id: number) => void
  onRepair: (id: number) => void
  onRecheck: (id: number) => void
  onEdit: (id: number) => void
  onCheckChanges: () => void
  onResolveData: (checkId: number) => void
}> = ({ item, agentMode, autoApproval, selected, sent, canRetry, onToggle, onRetry, onRepair, onRecheck, onEdit, onCheckChanges, onResolveData }) => {
  const [showReason, setShowReason] = useState(false)
  const failed = item.status === 'failed'
  const stopped = item.status === 'stopped'
  const finished = item.status === 'done'
  const awaitingApproval = item.status === 'awaiting_approval'
  const stepState = (key: CheckStepName): CheckStepState | 'na' => {
    const state = item.steps?.[key] ?? 'pending'
    return (failed || stopped) && state === 'pending' ? 'na' : state
  }
  const before = item.score_before
  const after = item.score_after

  return (
    <div className={`${ROW} h-[46px] text-[13px] text-[#1F2937] ${failed ? 'bg-[#FFFAFA]' : ''}`}>
      <input
        type="checkbox"
        aria-label={`Select ${item.display_id}`}
        checked={selected}
        disabled={!isSettled(item) || sent}
        onChange={() => onToggle(item.check_id)}
        className="h-4 w-4 accent-[#B71920]"
      />
      <span className="font-semibold">{item.display_id}</span>
      <button
        type="button"
        onClick={() => finished && !sent && onEdit(item.check_id)}
        disabled={!finished || sent}
        title={finished ? 'Open to edit steps' : item.title ?? ''}
        className="truncate text-left hover:text-[#B71920] disabled:hover:text-inherit"
      >
        {item.title}
      </button>
      <span className="flex items-center gap-[5px]">
        {agentMode && STAGES.every((stage) => item.steps?.[stage.key] === 'pending')
          ? <span className="text-[11px] text-[#667085]">After agent work</span>
          : STAGES.map((stage) => <Dot key={stage.key} letter={stage.letter} state={stepState(stage.key)} />)}
      </span>
      <span>
        {after != null ? (
          <>
            {item.improved && before != null && before !== after && <span className="text-[#9CA3AF] line-through">{before.toFixed(1)}</span>}{' '}
            <strong>{after.toFixed(1)}</strong>
          </>
        ) : before != null ? <strong>{before.toFixed(1)}</strong> : <span className="text-[#9CA3AF]">—</span>}
      </span>
      <span>
        {awaitingApproval ? <span className={`${CHIP} ${C_WARN}`}>{autoApproval ? item.agent_decision?.held?.length ? 'Mapping held' : 'Agent checking KB' : 'KB decision needed'}</span>
          : failed ? <span className={`${CHIP} ${C_BAD}`}>{item.evaluation_handoff ? 'Needs human input' : 'Not checked'}</span>
          : stopped ? <span className={`${CHIP} ${C_WARN}`}>Stopped</span>
          : item.classification === 'automation' ? <span className={`${CHIP} ${C_AUTO}`}>Automation</span>
            : item.classification === 'manual' ? <span className={`${CHIP} ${C_MAN}`}>Manual</span>
              : <span className="text-[12px] text-[#9CA3AF]">{item.status === 'queued' ? 'Waiting' : 'Checking…'}</span>}
      </span>
      <span className="flex min-w-0 items-center gap-2">
        {item.evaluation_handoff ? <Link className="text-[12px] font-semibold text-[#B71920] underline" to={`/manager-review/${encodeURIComponent(item.evaluation_handoff.request_id)}`}>Continue in Human Evaluation</Link> : agentMode ? <span className="text-[11px] text-[#667085]">{['running', 'queued'].includes(item.status) ? 'Agents working automatically' : 'Evidence retained for Human Evaluation'}</span> : awaitingApproval ? autoApproval ? <span className="text-[11.5px] text-[#805000]">{item.agent_decision?.held?.length ? 'Repair mapping or send original' : 'Approval Manager working'}</span> : <button type="button" onClick={onCheckChanges} className="text-[11.5px] font-semibold text-[#805000] hover:underline">Review KB draft</button> : failed ? (
          <>
            <span className="text-[11.5px] text-[#A3231C]" title={item.error ?? ''}>Stays here</span>
            {!agentMode && <button type="button" onClick={() => onRetry(item.check_id)} disabled={!canRetry || sent} className="text-[12px] font-bold text-[#B71920] hover:text-[#941216] disabled:opacity-40">Retry</button>}
          </>
        ) : stopped ? (
          <button type="button" onClick={() => onRetry(item.check_id)} disabled={!canRetry || sent} className="text-[12px] font-bold text-[#B71920] hover:text-[#941216] disabled:opacity-40">Restart</button>
        ) : sent ? (
          <span className={`${CHIP} ${C_AUTO}`}><Tick size={11} color="#136B34" width={3.5} />Sent for evaluation</span>
        ) : item.test_data_pending ? (
          <button type="button" onClick={() => onResolveData(item.check_id)} className={`${CHIP} ${C_WARN} hover:underline`} title={item.test_data_notes ?? ''}>See missing data</button>
        ) : item.improved ? (
          <span className={`${CHIP} ${C_BRAND}`}>Improved</span>
        ) : item.classification_detail === 'partial' ? (
          <span className="flex min-w-0 items-center gap-2"><button type="button" onClick={() => setShowReason(true)} className="shrink-0 text-[11px] font-semibold text-[#805000] underline">Why minor?</button>{finished && !sent && <button type="button" onClick={() => onRecheck(item.check_id)} disabled={!canRetry} className="shrink-0 text-[11px] font-bold text-[#B71920] underline disabled:opacity-40">Agent recheck</button>}</span>
        ) : item.classification === 'manual' ? (
          <span className="truncate text-[11.5px] text-[#6B7280]" title={item.classification_reason ?? ''}>{shortReason(item.classification_reason)}</span>
        ) : null}
      </span>
      {showReason && <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[#111827]/55 p-4" role="presentation" onMouseDown={() => setShowReason(false)}><div role="dialog" aria-modal="true" aria-label="Why this case needs minor changes" onMouseDown={event => event.stopPropagation()} className="w-full max-w-[500px] rounded-[16px] bg-white p-5 shadow-2xl"><div className="flex items-start justify-between gap-3"><div><div className="text-[11px] font-bold uppercase tracking-wider text-[#A3231C]">{item.display_id} · Classification</div><h3 className="mt-1 text-[18px] font-bold text-[#1F2937]">Why this case needs minor changes</h3></div><button type="button" onClick={() => setShowReason(false)} className="rounded-lg border border-[#E8EAEE] px-2 py-1 text-[12px] text-[#667085]">Close</button></div><p className="mt-4 rounded-[10px] border border-[#EBCFA4] bg-[#FFFBF4] p-3 text-[13px] leading-6 text-[#805000]">{item.classification_reason || 'The classification rule identified a fixable gap.'}</p><p className="mt-3 text-[12px] leading-5 text-[#667085]">Quality Check and automation classification answer different questions. A passing quality score can skip Auto-Improve while an older Knowledge Base status still needs rechecking.</p>{finished && !sent && <button type="button" onClick={() => { setShowReason(false); onRecheck(item.check_id) }} disabled={!canRetry} className="mt-4 rounded-[9px] bg-[#B71920] px-4 py-2 text-[12px] font-bold text-white disabled:opacity-50">Agent recheck &amp; update status</button>}</div></div>}
    </div>
  )
}

const shortReason = (reason: string | null) => {
  if (!reason) return ''
  const first = reason.split(/[.;:]/)[0].trim()
  return first.length > 28 ? `${first.slice(0, 27)}…` : first
}

export default AIChecksPanel
