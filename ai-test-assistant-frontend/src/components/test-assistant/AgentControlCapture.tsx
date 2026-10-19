import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSetup, CheckItem } from '../../services/aiChecksService'
import aiChecksService from '../../services/aiChecksService'
import knowledgeBaseService, { errorText, type CrawlPlan, type JourneyCrawl, type WalkLive } from '../../services/knowledgeBaseService'
import { getLocalRunnerStatus, startDeviceRunner } from '../../services/localRunner'

interface Props {
  item: CheckItem
  batchId: string
  setup: AgentSetup
  journeyId: string
  onClose: () => void
  onDraft: (ids: number[]) => void
  onRetryNavigation: () => void
}

const missingSteps = (item: CheckItem): number[] => {
  const match = (item.error || '').match(/journey steps?\s+([\d,\s]+)/i)
  return match ? Array.from(new Set((match[1].match(/\d+/g) || []).map(Number))).filter(Number.isFinite) : []
}

/** A headed, evidence-backed recapture without sending the person to the KB page. */
const AgentControlCapture: React.FC<Props> = ({ item, batchId, setup, journeyId, onClose, onDraft, onRetryNavigation }) => {
  const missing = useMemo(() => missingSteps(item), [item])
  const [plan, setPlan] = useState<CrawlPlan | null>(null)
  const [step, setStep] = useState<number>(missing[0] || 1)
  const [allowEarlierChanges, setAllowEarlierChanges] = useState(false)
  const [runnerReady, setRunnerReady] = useState<boolean | null>(null)
  const [crawl, setCrawl] = useState<JourneyCrawl | null>(null)
  const [live, setLive] = useState<WalkLive | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const proposing = useRef(false)

  useEffect(() => {
    let active = true
    void knowledgeBaseService.crawlPlan(setup.app_key, journeyId, setup.profile_id).then(value => {
      if (active) setPlan(value)
    }).catch(err => { if (active) setError(`${errorText(err)} Approve the Journey KB draft first if this journey is not published yet.`) })
    void getLocalRunnerStatus().then(status => { if (active) setRunnerReady(status.ready) })
    return () => { active = false }
  }, [setup.app_key, setup.profile_id, journeyId])

  useEffect(() => {
    if (!crawl || crawl.status !== 'running') return
    let active = true
    const poll = async () => {
      try {
        const [next, progress] = await Promise.all([knowledgeBaseService.crawl(crawl.id), knowledgeBaseService.crawlLive(crawl.id)])
        if (!active) return
        setCrawl(next); setLive(progress)
        if (next.status === 'failed') setError(next.error || 'The browser replay stopped before a control was captured.')
        if (next.status === 'completed' && !proposing.current) {
          proposing.current = true
          const captured = next.result?.steps?.find(row => row.order === selectedOrder && row.status === 'done')
          if (!captured) {
            setError('No control was selected. Start again and click the highlighted control in the opened browser.')
            return
          }
          setMessage('Control captured. Preparing your Knowledge Base changes for review…')
          try {
            const proposed = await knowledgeBaseService.proposeFromCrawl(next.id)
            const ids = [proposed.journey_change_set_id, proposed.automation_change_set_id].filter((id): id is number => typeof id === 'number')
            if (!ids.length) throw new Error('The capture did not produce a reviewable Knowledge Base change.')
            setCrawl(proposed)
            setMessage('Control captured and saved as a draft. Review and approve the changes here, then restart this case.')
            onDraft(ids)
          } catch (err) { setError(errorText(err)) }
        }
      } catch (err) { if (active) setError(errorText(err)) }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 2500)
    return () => { active = false; window.clearInterval(timer) }
  }, [crawl?.id, crawl?.status])

  const selected = plan?.items.find(item => !item.setup && item.step_number === step)
  const entryNavigation = !!selected && /^(?:open|visit|go to|navigate)\b/i.test(selected.text) && (() => {
    try {
      const route = selected.screen_id && plan?.signatures?.[selected.screen_id]?.route
      return !!route && new URL(route, plan?.base_url).pathname === new URL(plan?.entry || plan?.base_url || '').pathname
    } catch { return false }
  })()
  const selectedOrder = selected ? plan!.items.indexOf(selected) + 1 : 0
  const riskyBefore = !!(plan?.first_risky && selectedOrder && plan.first_risky < selectedOrder)
  const combinedField = !!selected && /^(enter|fill|type)\b/i.test(selected.text) && /,|\band\b/i.test(selected.text)
  const choices = Array.from(new Set([...missing, ...(plan?.items.filter(row => !row.setup && row.kind === 'screen' && /^(click|tap|enter|fill|type|select|choose|press)\b/i.test(row.text)).map(row => row.step_number) || [])])).sort((a, b) => a - b)

  const align = async () => {
    setBusy(true); setError('')
    try {
      const result = await aiChecksService.alignJourneySteps(batchId, item.check_id)
      setMessage(`Prepared ${result.steps} single-control steps for approval. ${result.unmapped} still need browser evidence.`)
      onDraft([result.change_set_id])
    } catch (err) { setError(errorText(err)) }
    finally { setBusy(false) }
  }

  const start = async () => {
    if (!selectedOrder) { setError('This step is not in the published journey. Approve its journey draft first.'); return }
    if (entryNavigation) { setError('This step opens the registered entry page. It needs no clicked control; retry Navigation Guide to repair its mapping from the saved case and browser evidence.'); return }
    if (combinedField) { setError('This step names more than one field. First prepare and approve separate steps so each control gets its own verified locator.'); return }
    setBusy(true); setError(''); setMessage('Opening the headed browser and replaying the earlier steps…'); proposing.current = false
    let made: Awaited<ReturnType<typeof knowledgeBaseService.startLocalCrawl>> | null = null
    try {
      const runner = await getLocalRunnerStatus()
      setRunnerReady(runner.ready)
      if (!runner.ready) throw new Error('The local browser runner is not connected. Start it on this device, then check the connection here.')
      made = await knowledgeBaseService.startLocalCrawl(setup.app_key, {
        journey_id: journeyId, application_id: setup.application_id, profile_id: setup.profile_id,
        environment: setup.environment, capture_step: selectedOrder, headed: true,
        allow_risky: allowEarlierChanges,
      })
      setCrawl(made.crawl)
      await startDeviceRunner(made.pairing)
      setMessage(`Replaying to step ${step}. When the browser pauses, click the correct control there. Return here to review the saved draft.`)
    } catch (err) {
      if (made) await knowledgeBaseService.cancelLocalCrawl(made.crawl.id).catch(() => undefined)
      setCrawl(null); setError(errorText(err))
    } finally { setBusy(false) }
  }

  const downloadRunner = async () => {
    try {
      const url = await knowledgeBaseService.downloadLocalRunner()
      const link = document.createElement('a'); link.href = url; link.download = 'automation-studio-local-runner.zip'; link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch (err) { setError(errorText(err)) }
  }

  return <section aria-label="Capture missing controls" className="mx-[22px] mt-3 rounded-[14px] border border-[#D8C6E8] bg-[#FCFAFF] p-4 text-[12px] text-[#344054]">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-[13px] font-bold text-[#492368]">Capture missing controls · {item.display_id || item.title}</div><p className="mb-0 mt-1 text-[#667085]">Replay the journey up to a missing step. A visible browser pauses so you can click its control; the locator and screen are saved as a draft for your approval.</p></div><button type="button" onClick={onClose} disabled={crawl?.status === 'running'} className="font-bold text-[#7135A5] underline disabled:opacity-40">Close</button></div>
    <div className="mt-3 flex flex-wrap items-end gap-3"><label className="font-semibold">Missing step <select value={step} onChange={event => { setStep(Number(event.target.value)); setCrawl(null); setLive(null); setError(''); setMessage(''); proposing.current = false }} disabled={crawl?.status === 'running'} className="ml-2 rounded-[8px] border border-[#D8C6E8] bg-white px-2 py-1.5">{(choices.length ? choices : (plan?.items.filter(row => !row.setup).map(row => row.step_number) || [])).map(number => <option key={number} value={number}>{number}</option>)}</select></label><span className="min-w-[240px] flex-1 text-[#667085]">{selected?.text || 'Loading approved journey…'}</span><button type="button" onClick={() => void start()} disabled={busy || crawl?.status === 'running' || !selectedOrder || combinedField || entryNavigation || (riskyBefore && !allowEarlierChanges)} className="rounded-[9px] bg-[#B71920] px-3 py-2 font-bold text-white disabled:opacity-40">{busy ? 'Starting…' : 'Replay & select control'}</button></div>
    {entryNavigation && <div className="mt-3 rounded-[8px] border border-[#C9D6E8] bg-[#F5F8FC] p-2">This step opens the registered entry page; there is no control to click. <button type="button" onClick={onRetryNavigation} className="font-bold text-[#244B7D] underline">Retry Navigation Guide automatically</button> to refresh its browser-grounded mapping.</div>}
    {combinedField && <div className="mt-3 rounded-[8px] border border-[#EBCFA4] bg-[#FFFBF4] p-2 text-[#805000]">This action names multiple fields. One clicked control cannot verify all of them. <button type="button" onClick={() => void align()} disabled={busy} className="font-bold text-[#B71920] underline disabled:opacity-40">Prepare separate steps for approval</button>, then capture each missing field here.</div>}
    {riskyBefore && <label className="mt-3 flex items-start gap-2 rounded-[8px] border border-[#EBCFA4] bg-[#FFFBF4] p-2 text-[#805000]"><input type="checkbox" checked={allowEarlierChanges} onChange={event => setAllowEarlierChanges(event.target.checked)} className="mt-0.5" /><span>Step {plan?.first_risky} may submit or change application data before this control. I reviewed the earlier steps and allow this replay to continue.</span></label>}
    {runnerReady === false && <div className="mt-3 rounded-[8px] border border-[#EBCFA4] bg-[#FFFBF4] p-2">The local browser runner is not connected. <button type="button" onClick={() => void downloadRunner()} className="font-bold text-[#B71920] underline">Download runner</button>, start it on this device, then <button type="button" onClick={() => void getLocalRunnerStatus().then(status => setRunnerReady(status.ready))} className="font-bold text-[#B71920] underline">check connection</button>.</div>}
    {(message || live) && <div role="status" aria-live="polite" className="mt-3 rounded-[8px] border border-[#DDC8EE] bg-white p-2"><div className="font-semibold text-[#492368]">{message || 'Browser replay running…'}</div>{live?.current && <div className="mt-1">Step {live.current.step_number}: {live.current.text}</div>}{live?.phase && <div className="mt-1 text-[#667085]">{live.phase}</div>}</div>}
    {error && <div role="alert" className="mt-3 rounded-[8px] border border-[#F0C2C0] bg-[#FFF7F7] p-2 text-[#A3231C]">{error}</div>}
  </section>
}

export default AgentControlCapture
