import React, { useEffect, useState } from 'react'
import knowledgeBaseService, {
  errorText, type JourneyCrawl, type RecordedAction, type RecordedStep, type RecordingEvent, type WalkLive
} from '../../services/knowledgeBaseService'
import automationService from '../../services/automationService'
import { Chip, Note, useLoad } from './kbUi'
import { EDIT_BTN, FIELD, ICON, PLAIN_BTN, PublishToggle, useKbEdit } from './kbEdit'
import { useAuthedImage } from './walkImage'

// --- Recording a journey ----------------------------------------------------------------------
// A browser opens on the backend's machine at the environment's address; the
// person does the journey there. Each click, field, choice and key press comes
// back here as a step, with the selector it was done with. Reviewed, it becomes
// the journey's steps and its flow blueprint (backend: services/journeys/journey_record.py).

const KIND: Record<RecordedAction['kind'], string> = {
  goto: 'Open', click: 'Click', fill: 'Fill', otp: 'Enter OTP', select: 'Choose', check: 'Tick', press: 'Press', verify: 'Check'
}
const FIELDS = ['username', 'email', 'password', 'otp', 'mobile', 'search', 'text']

const Shot: React.FC<{ crawlId: number; name: string; alt: string }> = ({ crawlId, name, alt }) => {
  const url = useAuthedImage(() => knowledgeBaseService.crawlImage(crawlId, name), name)
  return url ? <img src={url} alt={alt} className="w-full" /> : <div className="p-3 text-[12px] text-[#6B7280]">Loading…</div>
}

/** While recording: what the browser shows, the actions so far, and Finish. */
export const RecordingLive: React.FC<{ crawl: JourneyCrawl; canStop: boolean; onFinished: () => void }> = ({ crawl, canStop, onFinished }) => {
  const [live, setLive] = useState<WalkLive | null>(null)
  const [ending, setEnding] = useState<null | 'finish' | 'discard'>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const tick = () => knowledgeBaseService.crawlLive(crawl.id).then(next => {
      if (!alive) return
      setLive(next)
      if (['completed', 'failed'].includes(next.status)) onFinished()
    }).catch(() => undefined)
    void tick()
    const t = window.setInterval(tick, 1200)
    return () => { alive = false; window.clearInterval(t) }
  }, [crawl.id, onFinished])
  const frame = useAuthedImage(live?.frame_at ? () => knowledgeBaseService.crawlImage(crawl.id, 'live.png') : null, live?.frame_at ? String(live.frame_at) : null)
  const events = (live?.steps ?? []) as unknown as RecordingEvent[]
  const finish = async () => {
    setEnding('finish')
    setError(null)
    try { await knowledgeBaseService.finishRecording(crawl.id) } catch (err) { setError(errorText(err)); setEnding(null) }
  }
  const onDevice = crawl.execution_target === 'local'
  const discard = async () => {
    if (!crawl.run_key) return
    setEnding('discard')
    try {
      if (onDevice) await knowledgeBaseService.cancelLocalCrawl(crawl.id)
      else await automationService.cancelRun(crawl.run_key)
    } catch { /* it ends on its own */ }
  }
  return (
    <div className="flex flex-col gap-3 px-5 pb-5">
      <Note>
        A browser window has opened {onDevice ? 'on this device, through the device runner' : 'on the machine the backend runs on'}, at {crawl.base_url}. Do the journey there yourself,
        signing in, entering the OTP and getting past anything that needs a person, then press <b>Finish recording</b>. Each action
        appears on the right as you go. Values you type are never recorded, only which kind of field they went into.
      </Note>
      {error && <Note tone="warn">{error}</Note>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 text-[12px] text-[#6B7280]">
            <span>
              <span className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-[#B71920] align-middle" aria-hidden />
              Recording · {crawl.environment} · {events.length} action{events.length === 1 ? '' : 's'} so far
            </span>
            {canStop && (
              <span className="flex gap-2">
                <button type="button" onClick={() => void discard()} disabled={!!ending} className={PLAIN_BTN}>{ending === 'discard' ? 'Discarding…' : 'Discard'}</button>
                <button type="button" onClick={() => void finish()} disabled={!!ending} className={EDIT_BTN}>{ending === 'finish' ? 'Finishing…' : 'Finish recording'}</button>
              </span>
            )}
          </div>
          <div className="flex aspect-[16/9] items-center justify-center overflow-hidden rounded-[12px] border border-[#E8EAEE] bg-[#F4F5F7]">
            {frame ? <img src={frame} alt="The page being recorded" className="h-full w-full object-contain" /> : <span className="px-4 text-center text-[12.5px] text-[#6B7280]">{onDevice ? 'The browser is on this device; its screen is not streamed. Actions appear on the right as you go.' : 'Waiting for the browser…'}</span>}
          </div>
        </div>
        <ol className="m-0 flex max-h-[420px] list-none flex-col overflow-auto rounded-[12px] border border-[#E8EAEE] p-0">
          {events.length === 0 && <li className="px-3 py-3 text-[12px] text-[#6B7280]">Nothing yet: click, type or choose something in the browser window.</li>}
          {events.map(e => (
            <li key={e.order} className="flex items-start gap-2 border-b border-[#F1F2F4] px-3 py-2 text-[12px]">
              <span className="w-5 flex-shrink-0 text-right font-semibold text-[#6B7280]">{e.order}</span>
              <span className="min-w-0 flex-1">
                <span className="font-semibold text-[#6B7280]">{KIND[e.kind] ?? e.kind}</span>{' '}
                {e.kind === 'select' ? `“${e.option ?? ''}” in ` : ''}{e.label || '(no label)'}
                {e.field && <span className="ml-1.5 text-[11px] text-[#6B7280]">· {e.field}</span>}
                {e.url && <span className="block truncate font-mono text-[11px] text-[#9CA3AF]">{e.url}</span>}
              </span>
              {!e.unique && <Chip tone="warn" title="No selector matched this element alone; check it before saving">check selector</Chip>}
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

/** After recording: the steps to keep, reworded and corrected, saved as the journey's steps. */
export const RecordingReview: React.FC<{
  appKey: string; crawl: JourneyCrawl; canExecute: boolean; canApprove: boolean; onSaved: () => void
}> = ({ appKey, crawl, canExecute, canApprove, onSaved }) => {
  const recorded = crawl.result?.recording ?? []
  const [steps, setSteps] = useState<RecordedStep[]>(recorded)
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => { setSteps(crawl.result?.recording ?? []) }, [crawl.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const [map] = useLoad(`${appKey}:${crawl.journey_id}:rec`, () => knowledgeBaseService.journeyMap(appKey, crawl.journey_id))
  const [linkFlow, setLinkFlow] = useState('new')
  const { publish, publishNow, setPublishNow, busy, run } = useKbEdit(canApprove, onSaved)
  const saved = !!(crawl.journey_change_set_id || crawl.automation_change_set_id)

  const update = (i: number, patch: Partial<RecordedStep>) => setSteps(prev => prev.map((s, k) => (k === i ? { ...s, ...patch } : s)))
  const move = (i: number, by: number) => setSteps(prev => {
    const next = [...prev]
    const [s] = next.splice(i, 1)
    next.splice(i + by, 0, s)
    return next
  })
  const remove = (i: number) => setSteps(prev => prev.filter((_, k) => k !== i))
  const invalid = steps.length === 0 ? 'Keep at least one step' : steps.some(s => !s.action.trim()) ? 'Every step needs its words' : null
  const save = () => void run('Recorded steps', p => knowledgeBaseService.saveRecording(crawl.id, {
    steps, link_flow: map?.flow ? null : linkFlow, publish: p
  }))

  return (
    <div className="flex flex-col gap-3 pb-5">
      <div className="px-5">
        <Note>
          {recorded.length} step{recorded.length === 1 ? '' : 's'} recorded{crawl.result?.ended ? ` · ended: ${crawl.result.ended}` : ''}.
          Reword, reorder or delete them, then save: they replace the steps of <b>{crawl.journey_name ?? crawl.journey_id}</b>, and its
          flow blueprint is regenerated from them with the recorded selectors, as one change set pair for review.
          Test scenarios that pointed at the old step numbers keep their names and rules; their step lists are cleared.
        </Note>
      </div>
      {saved && (
        <div className="px-5"><Note>Saved as change set{crawl.journey_change_set_id && crawl.automation_change_set_id ? 's' : ''} {[crawl.journey_change_set_id, crawl.automation_change_set_id].filter(Boolean).map(id => `#${id}`).join(' + ')}.</Note></div>
      )}
      <ol className="m-0 list-none p-0">
        {steps.map((s, i) => (
          <li key={i} className="border-t border-[#F1F2F4] px-5 py-2.5 text-[12.5px]">
            <div className="grid grid-cols-[24px_74px_minmax(0,1fr)_auto] items-start gap-2">
              <span className="pt-1.5 text-right font-semibold text-[#6B7280]">{i + 1}</span>
              <span className="pt-1.5 font-semibold text-[#6B7280]">{KIND[s.recorded.kind] ?? s.recorded.kind}</span>
              <div className="flex min-w-0 flex-col gap-1.5">
                <input aria-label={`Step ${i + 1}`} value={s.action} disabled={saved} onChange={e => update(i, { action: e.target.value })} className={FIELD} />
                <input aria-label={`Step ${i + 1} expected result`} value={s.expected_result} disabled={saved} placeholder="Expected result (optional)"
                  onChange={e => update(i, { expected_result: e.target.value })} className={`${FIELD} text-[12px] text-[#4B5563]`} />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[#6B7280]">
                  {(s.recorded.target || s.recorded.route) && (
                    <span className="max-w-full truncate font-mono text-[11px] text-[#1F2937]" title={s.recorded.target ?? s.recorded.route}>{s.recorded.target ?? s.recorded.route}</span>
                  )}
                  {s.recorded.unique === false && <Chip tone="warn" title="No selector matched this element alone when it was recorded">selector not unique</Chip>}
                  {(s.recorded.kind === 'fill' || s.recorded.kind === 'otp') && (
                    <label className="flex items-center gap-1.5">
                      Test Data field
                      <select aria-label="Field" value={s.recorded.field ?? 'text'} disabled={saved}
                        onChange={e => update(i, { recorded: { ...s.recorded, field: e.target.value } })}
                        className="h-[24px] rounded-[6px] border border-[#E8EAEE] bg-white px-1 text-[11.5px]">
                        {FIELDS.map(f => <option key={f} value={f}>{f}</option>)}
                      </select>
                    </label>
                  )}
                  {s.recorded.led_to && <span>→ {s.recorded.led_to}</span>}
                  {s.recorded.screenshot && (
                    <button type="button" onClick={() => setOpen(open === i ? null : i)} className="font-semibold text-[#B71920] hover:underline">
                      {open === i ? 'Hide screenshot' : 'Screenshot'}
                    </button>
                  )}
                </div>
              </div>
              {!saved && (
                <span className="flex gap-1">
                  <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} className={ICON}>↑</button>
                  <button type="button" aria-label="Move down" disabled={i === steps.length - 1} onClick={() => move(i, 1)} className={ICON}>↓</button>
                  <button type="button" aria-label="Delete step" onClick={() => remove(i)} className={ICON}>✕</button>
                </span>
              )}
            </div>
            {open === i && s.recorded.screenshot && (
              <div className="ml-8 mt-2 overflow-hidden rounded-[10px] border border-[#E8EAEE]">
                <Shot crawlId={crawl.id} name={s.recorded.screenshot} alt={`After step ${i + 1}`} />
              </div>
            )}
          </li>
        ))}
      </ol>
      {!saved && canExecute && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#F1F2F4] px-5 pt-3">
          <div className="flex flex-wrap items-center gap-3 text-[12px] text-[#4B5563]">
            {map && (map.flow
              ? <span>Regenerates the flow blueprint <span className="font-mono">{map.flow.flow_id}</span></span>
              : (
                <label className="flex items-center gap-2">
                  Flow blueprint
                  <select aria-label="Flow blueprint" value={linkFlow} onChange={e => setLinkFlow(e.target.value)}
                    className="h-[30px] rounded-[8px] border border-[#E8EAEE] bg-white px-2 text-[12px]">
                    <option value="new">Create a new one</option>
                    {map.suggested_flows.map(f => <option key={f.flow_id} value={f.flow_id}>Replace {f.flow_name ?? f.flow_id}</option>)}
                  </select>
                </label>
              ))}
            <PublishToggle canApprove={canApprove} publishNow={publishNow} onChange={setPublishNow} />
          </div>
          <span className="flex items-center gap-2">
            {invalid && <span className="text-[11.5px] text-[#A3231C]">{invalid}</span>}
            <button type="button" onClick={save} disabled={busy || !!invalid} className={EDIT_BTN}>
              {busy ? 'Saving…' : publish ? 'Save as the journey’s steps & publish' : 'Save as the journey’s steps'}
            </button>
          </span>
        </div>
      )}
    </div>
  )
}
