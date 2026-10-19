import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import aiChecksService, { type CheckItem } from '../../services/aiChecksService'
import type { AgentResolution } from '../../services/reviewService'
import reviewService from '../../services/reviewService'
import AgentTestDataSetup from './AgentTestDataSetup'
import AgentControlCapture from './AgentControlCapture'
import ChangeSetsDrawer from '../knowledge-base/ChangeSetsDrawer'
import ReviewLoginCapture from './ReviewLoginCapture'
import { blockerSummary } from './agentPresentation'
import type { AgentName } from '../../services/aiChecksService'

/** Human input belongs beside the review, with the original agent checkpoint. */
export default function AgentResolutionPanel({ resolution, onUpdated, editable, requestId, caseId }: {
  resolution: AgentResolution; onUpdated: () => void; editable: boolean; requestId: string; caseId: string
}) {
  const [item, setItem] = useState<CheckItem | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [panel, setPanel] = useState<'data' | 'capture' | 'page' | 'steps' | 'login' | null>(null)
  const [stepsText, setStepsText] = useState('')
  const [pageUrl, setPageUrl] = useState('')
  const [drafts, setDrafts] = useState<number[] | null>(null)
  const updated = useRef(onUpdated)
  updated.current = onUpdated
  const inFlight = useRef(false)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const batch = await aiChecksService.get(resolution.batch_id)
      const found = batch.items.find(value => value.check_id === resolution.check_id)
      if (!found) throw new Error('The linked agent session was not found.')
      setItem(found)
      setCheckedAt(new Date().toLocaleTimeString())
      setError('')
      updated.current()
    } finally { inFlight.current = false }
  }, [resolution.batch_id, resolution.check_id])
  useEffect(() => { void refresh().catch(err => setError(err?.response?.data?.detail || 'Agent work could not be loaded.')) }, [refresh])
  const active = item?.status === 'queued' || item?.status === 'running'
  useEffect(() => {
    if (!active && item?.status !== 'awaiting_approval') return
    const timer = window.setInterval(() => void refresh().catch(() => setError('Live updates are unavailable. The last saved status is shown; refresh status to reconnect.')), 3000)
    return () => window.clearInterval(timer)
  }, [active, item?.status, refresh])
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await action(); await refresh() } catch (err: any) { setError(err?.response?.data?.detail || 'The agents could not resume. Your saved work is retained.') }
    finally { setBusy(false) }
  }
  const resume = () => run(() => reviewService.resumeAgents(requestId, caseId))
  const allDrafts = Array.from(new Set(Object.values(item?.agents || {}).flatMap(agent => agent.change_set_ids || [])))
  const journeyId = item?.agents?.navigation_guide?.journey_id || resolution.evidence.navigation_guide?.journey_id
  const ready = resolution.state === 'ready' && !active && (!item || (item.status === 'done' && item.classification === 'automation' && !item.test_data_pending && !item.kb_publication_held))
  const stageEntries = Object.entries(item?.agents || {}) as [AgentName, NonNullable<CheckItem['agents']>[AgentName]][]
  const owner = stageEntries.find(([, agent]) => agent && ['working', 'queued', 'retry_wait'].includes(agent.status))
    || stageEntries.find(([, agent]) => agent?.status === 'failed')
  const stageName = owner?.[0].split('_').map(word => word[0].toUpperCase() + word.slice(1)).join(' ')
  const reason = item?.error || resolution.reason || ''
  const loginCaptureNeeded = /login prerequisite|sign.in.*(?:capture|observ)|login form|sign.in form/i.test(reason)
  const pausedForApproval = item?.status === 'awaiting_approval'
  const recovery = (item?.recovery || resolution.recovery || []).at(-1)
  const browserSummary = item?.authoring ? {
    observed_instructions: item.authoring.completed_steps?.length || 0,
    total_instructions: item.authoring.source_actions?.length || 0,
    replay_status: item.authoring.script_verification?.status || 'not_verified'
  } : resolution.browser_summary
  const dataNeeded = /data|credential|phone|login|sign.in|password|otp|identity/i.test(item?.error || resolution.reason || '')
  const button = 'rounded-lg border border-[#D9DDE5] bg-white px-3 py-2 text-[12px] font-semibold disabled:opacity-50'
  return <div className="m-4 rounded-xl border border-[#EBCFA4] bg-[#FFFBF4] p-4">
    <h3 className="m-0 text-[14px] font-bold">{active ? `${item?.status === 'queued' ? 'Queued' : 'Running'}${stageName ? ` · ${stageName}` : ''}` : ready ? editable ? 'Ready for automation approval' : 'Automation checks complete' : pausedForApproval ? 'Waiting for a Knowledge Base decision' : loginCaptureNeeded ? 'Sign-in evidence is missing' : 'Agent work stopped · input needed'}</h3>
    <p role="status" className="mb-2 mt-1 text-[12px]">{active ? owner?.[1]?.message || 'Waiting for the next agent update. Progress will appear here automatically.' : ready ? editable ? 'Review the updated steps below, then approve the case for script generation.' : 'The verified steps and reusable evidence are retained with this case.' : loginCaptureNeeded ? 'The agent has not observed the complete sign-in flow. Retrying without new evidence may stop at the same point. Capture the authorized login here; later steps remain on hold until it is verified.' : pausedForApproval ? 'The prepared changes need a decision before execution can continue. This is not an active browser run.' : blockerSummary(owner?.[0] || 'navigation_guide', reason) || 'Add the missing evidence below before retrying the saved checkpoint.'}</p>
    {!ready && !active && <details className="my-2 text-[12px] text-[#805000]"><summary>Technical details</summary><p>{reason}</p></details>}
    <div className="my-2 flex flex-wrap items-center gap-2 text-[11px] text-[#667085]">{checkedAt ? `Status checked ${checkedAt}` : 'Loading saved agent status…'}<button type="button" className="underline" disabled={busy} onClick={() => void refresh().catch(() => setError('Could not refresh agent status.'))}>Refresh status</button></div>
    <div className="text-[11px] text-[#667085]">{resolution.completed_agents.length} completed agent handoffs retained · {resolution.setup.environment} · {resolution.setup.app_key}</div>
    {!!browserSummary?.total_instructions && <p className="my-2 text-[12px]" aria-label="Browser verification summary">
      {browserSummary.observed_instructions}/{browserSummary.total_instructions} original instructions observed · {browserSummary.replay_status === 'passed' ? 'Clean browser replay passed' : 'Clean browser replay not verified'}
    </p>}
    {recovery && <div className="my-3 rounded-lg border bg-white p-3 text-[12px]" role="status">
      <strong>{recovery.status === 'verified' ? 'Automatic recovery verified' : recovery.status === 'working' ? 'Agents are checking changed pages' : 'Automatic recovery needs review'}</strong>
      <p className="mb-0 mt-1">{recovery.status === 'verified' ? 'The agents checked live pages against the original instructions and replayed the replacement steps. Review the updated test steps below; approval is still required before script generation.' : recovery.status === 'working' ? 'Wait for the updated steps and replay result before deciding this case.' : 'No verified replacement was found within the retry limit. Saved evidence is retained; use the inputs here to resolve the remaining gap.'}</p>
      {recovery.change_set_id && <span>Reusable journey update #{recovery.change_set_id} · publication remains subject to the assigned approval policy.</span>}
    </div>}
    <Link className="mt-2 inline-block text-[12px] font-semibold underline" to={`/test-assistant/testcases?request=${encodeURIComponent(requestId)}&batch=${encodeURIComponent(resolution.batch_id)}&check=${resolution.check_id}`}>Open this case in AI Checks</Link>
    {error && <p role="alert" className="text-[12px] text-red-700">{error}</p>}
    {editable && !ready && <div className="mt-3 flex flex-wrap gap-2">
      <button className={button} disabled={busy || active || pausedForApproval || !item} onClick={() => void resume()}>{busy ? 'Starting…' : active ? item?.status === 'queued' ? 'Queued' : 'Running' : 'Retry saved checkpoint'}</button>
      <button className={button} disabled={active} onClick={() => setPanel(panel === 'data' ? null : 'data')}>{dataNeeded ? 'Add or select missing test data' : 'Test data'}</button>
      <button className={button} disabled={active} onClick={() => setPanel(panel === 'page' ? null : 'page')}>Provide a missing page</button>
      <button className={button} disabled={active} onClick={() => setPanel(panel === 'steps' ? null : 'steps')}>Clarify intended steps</button>
      <button className={button} disabled={active} onClick={() => setPanel(panel === 'login' ? null : 'login')}>Capture login / OTP here</button>
      {!!allDrafts.length && <button className={button} disabled={active} onClick={() => setDrafts(allDrafts)}>Review proposed changes here</button>}
      {journeyId && item && <button className={button} disabled={active} onClick={() => setPanel(panel === 'capture' ? null : 'capture')}>Show the missing page or control</button>}
      {item?.safety_pause && <button className={button} disabled={busy || active} onClick={() => void run(() => aiChecksService.continueBrowserReplay(resolution.batch_id, resolution.check_id))}>Allow the paused browser action</button>}
    </div>}
    {panel === 'page' && editable && <form className="mt-3 text-[12px]" onSubmit={event => { event.preventDefault(); void run(() => reviewService.resumeAgents(requestId, caseId, pageUrl)) }}>
      <label className="block font-semibold">Page address on this application<input type="url" required value={pageUrl} onChange={event => setPageUrl(event.target.value)} className="mt-1 block w-full rounded border p-2" placeholder="https://application.example/path" /></label>
      <p>The agents will inspect this page, save observed controls, and continue the case. Providing an address does not mark its controls as verified.</p>
      <button className={button} disabled={busy || active}>Inspect page and continue</button>
    </form>}
    {panel === 'steps' && editable && <form className="mt-3 text-[12px]" onSubmit={event => { event.preventDefault(); void run(() => reviewService.resumeAgents(requestId, caseId, undefined, stepsText)) }}>
      <label className="block font-semibold">Intended steps<textarea required maxLength={20000} rows={5} value={stepsText} onChange={event => setStepsText(event.target.value)} className="mt-1 block w-full rounded border p-2" /></label>
      <p>The original is retained for comparison. Agents will recheck these steps using browser evidence; this does not approve an unverified control.</p>
      <button className={button} disabled={busy || active}>Save clarification and recheck</button>
    </form>}
    {panel === 'login' && editable && <ReviewLoginCapture requestId={requestId} caseId={caseId} recordingId={resolution.recording_id} onDrafts={setDrafts} />}
    {panel === 'data' && editable && <div className="mt-3"><AgentTestDataSetup batchId={resolution.batch_id} checkId={resolution.check_id} onSaved={() => void refresh()} onProfileDraft={id => setDrafts([id])} /></div>}
    {panel === 'capture' && item && journeyId && editable && <AgentControlCapture item={item} batchId={resolution.batch_id} setup={resolution.setup} journeyId={journeyId} onClose={() => setPanel(null)} onDraft={setDrafts} onRetryNavigation={() => void resume()} />}
    {drafts && <ChangeSetsDrawer appKey={resolution.setup.app_key} tab="review" onTab={() => undefined} onClose={() => { setDrafts(null); void refresh() }} onPublished={() => void refresh()} onQueueChanged={() => void refresh()} canDecide={editable} canEdit={editable} presentation="modal" changeSetIds={drafts} />}
  </div>
}
