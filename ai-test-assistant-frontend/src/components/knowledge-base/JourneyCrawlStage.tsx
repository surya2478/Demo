import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import knowledgeBaseService, {
  errorText, type CrawlOutcome, type CrawlPlan, type CrawlPlanItem, type CrawlStep, type InventoryPage, type JourneyCrawl, type WalkCapabilities, type WalkFlow, type WalkLive
} from '../../services/knowledgeBaseService'
import automationService from '../../services/automationService'
import { Card, CardHead, Chip, Failed, Loading, Note, TONE, useLoad } from './kbUi'
import { RecordingLive, RecordingReview } from './JourneyRecording'
import { useAuthedImage } from './walkImage'

const OUTCOME: Record<CrawlOutcome, { label: string; tone: keyof typeof TONE; hint: string }> = {
  confirmed: { label: 'Confirmed', tone: 'good', hint: 'The Automation KB selector still finds it' },
  healed: { label: 'Healed', tone: 'warn', hint: 'The Automation KB selector failed; another way found it' },
  new: { label: 'New', tone: 'info', hint: 'Captured; the Automation KB has no selector for it yet' },
  kb_failed: { label: 'KB selector failed', tone: 'bad', hint: 'Neither the Automation KB selector nor the design found it' },
  not_found: { label: 'Not found', tone: 'idle', hint: 'Looked for on its screen and not there. Nothing is invented' },
  not_applicable: { label: 'Not shown', tone: 'idle', hint: 'An optional step whose screen this account does not see' },
  not_reached: { label: 'Not reached', tone: 'idle', hint: 'The walk never got to it' }
}
const ORDER: CrawlOutcome[] = ['kb_failed', 'healed', 'new', 'confirmed', 'not_found', 'not_applicable', 'not_reached']
const KIND: Record<string, string> = { goto: 'Open', screen: 'Screen', fill: 'Fill', otp: 'Enter OTP', click: 'Click', capture: 'Look for', skip: 'Skip' }
const STATUS_TONE: Record<JourneyCrawl['status'], keyof typeof TONE> = { queued: 'idle', running: 'info', completed: 'good', failed: 'bad' }
const STEP_STATUS: Record<CrawlStep['status'], { label: string; tone: keyof typeof TONE }> = {
  done: { label: 'Done', tone: 'good' },
  skipped: { label: 'Skipped', tone: 'idle' },
  not_found: { label: 'Not found', tone: 'bad' },
  not_applicable: { label: 'Not shown', tone: 'idle' },
  error: { label: 'Failed', tone: 'bad' },
  stopped: { label: 'Not run', tone: 'idle' },
  not_reached: { label: 'Not reached', tone: 'bad' },
  blocked: { label: 'Blocked', tone: 'idle' },
  off_path: { label: 'Off the path', tone: 'bad' },
  auto: { label: 'Moved on by itself', tone: 'good' }
}

/** A step is shown with the journey's own number; setup steps (another journey run first) as "setup". */
const stepNo = (item: CrawlPlanItem | undefined, order: number) => !item ? String(order) : item.setup ? 'setup' : String(item.step_number)
const beforeLabel = (item: CrawlPlanItem | undefined, order: number) => stepNo(item, order) === 'setup' ? 'a setup step' : `step ${stepNo(item, order)}`

const SELECT = 'h-[34px] rounded-[10px] border border-[#E8EAEE] bg-white px-2.5 text-[12.5px] font-semibold text-[#374151]'
const LABEL = 'flex min-w-0 flex-col gap-1 text-[11px] font-bold uppercase tracking-[0.1em] text-[#6B7280]'
const PLAIN = 'h-[32px] rounded-[10px] border border-[#E8EAEE] bg-white px-3 text-[12.5px] font-bold text-[#1F2937] hover:border-[#F6D4D5] disabled:opacity-50'


// --- The walk as it runs ------------------------------------------------------------------

const LivePanel: React.FC<{ crawl: JourneyCrawl; plan: CrawlPlan | null; onFinished: () => void; canStop: boolean }> = ({ crawl, plan, onFinished, canStop }) => {
  const [live, setLive] = useState<WalkLive | null>(null)
  const [stopping, setStopping] = useState(false)
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
  const done = new Map((live?.steps ?? []).map(s => [s.order, s]))
  const items = plan?.items ?? []
  const stop = async () => {
    if (!crawl.run_key) return
    setStopping(true)
    try { await automationService.cancelRun(crawl.run_key) } catch { /* the run finishes on its own */ }
  }
  return (
    <div className="grid gap-4 px-5 pb-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2 text-[12px] text-[#6B7280]">
          <span>
            <span className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-[#B71920] align-middle" aria-hidden />
            Live · {crawl.environment} · {live?.current ? `${beforeLabel(items[live.current.order - 1], live.current.order).replace('a setup step', 'setup')}: ${live.current.text}` : live?.phase ?? 'starting the browser…'}
          </span>
          {canStop && (
            <button type="button" onClick={() => void stop()} disabled={stopping} className={PLAIN}>{stopping ? 'Stopping…' : 'Stop'}</button>
          )}
        </div>
        <div className="flex aspect-[16/9] items-center justify-center overflow-hidden rounded-[12px] border border-[#E8EAEE] bg-[#F4F5F7]">
          {frame ? <img src={frame} alt="The page the walk is on" className="h-full w-full object-contain" /> : <span className="text-[12.5px] text-[#6B7280]">Waiting for the first frame…</span>}
        </div>
      </div>
      <ol className="m-0 flex max-h-[420px] list-none flex-col overflow-auto rounded-[12px] border border-[#E8EAEE] p-0">
        {items.map((item, i) => {
          const order = i + 1
          const step = done.get(order)
          const now = live?.current?.order === order
          const status = step ? STEP_STATUS[step.status] : null
          return (
            <li key={order} className={`flex items-start gap-2 border-b border-[#F1F2F4] px-3 py-2 text-[12px] ${now ? 'bg-[#FFF5F5]' : ''}`}>
              <span className={`flex-shrink-0 text-right font-semibold text-[#6B7280] ${item.setup ? 'w-10 text-[10.5px] uppercase' : 'w-5'}`}>{stepNo(item, order)}</span>
              <span className={`min-w-0 flex-1 ${item.kind === 'skip' || item.setup ? 'text-[#9CA3AF]' : ''}`}>
                <span className="font-semibold text-[#6B7280]">{KIND[item.kind] ?? item.kind}</span> {item.text}
                {step?.error && <span className="block text-[11.5px] text-[#A3231C]">{step.error}</span>}
              </span>
              {now ? <Chip tone="info">Running</Chip> : status ? <Chip tone={status.tone}>{status.label}</Chip> : <span className="text-[11px] text-[#9CA3AF]">waiting</span>}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

// --- After the walk ------------------------------------------------------------------------

const StepRow: React.FC<{ crawlId: number; step: CrawlStep; item?: CrawlPlanItem; screenNames: Record<string, string> }> = ({ crawlId, step, item, screenNames }) => {
  const text = item?.text ?? ''
  const [open, setOpen] = useState(false)
  const shot = useAuthedImage(open && step.screenshot ? () => knowledgeBaseService.crawlImage(crawlId, step.screenshot as string) : null, open ? step.screenshot ?? null : null)
  const status = STEP_STATUS[step.status]
  return (
    <li className="border-t border-[#F1F2F4] px-5 py-2 text-[12.5px]">
      <div className="flex items-start gap-3">
        <span className={`flex-shrink-0 text-right font-semibold text-[#6B7280] ${item?.setup ? 'w-10 text-[10.5px] uppercase' : 'w-6'}`}>{item ? stepNo(item, step.order) : step.step_number}</span>
        <span className={`min-w-0 flex-1 ${item?.setup ? 'text-[#6B7280]' : ''}`}>
          <span className="font-semibold text-[#6B7280]">{KIND[step.kind] ?? step.kind}</span> {text}
          {(step.error || step.reason) && (
            <span className={`block text-[11.5px] ${step.error || step.status === 'off_path' || step.status === 'not_reached' ? 'text-[#A3231C]' : 'text-[#6B7280]'}`}>{step.error ?? step.reason}</span>
          )}
          {step.outcome?.kind === 'expected' && step.outcome.screen && step.status !== 'auto' && (
            <span className="block text-[11.5px] text-[#1F7A4D]">→ {screenNames[step.outcome.screen] ?? step.outcome.screen}{step.outcome.rule ? ` · ${step.outcome.rule}` : ''}, as expected</span>
          )}
          {step.screen && !step.outcome && <span className="block text-[11.5px] text-[#1F7A4D]">On {screenNames[step.screen] ?? step.screen}</span>}
          {step.note && <span className="block text-[11.5px] text-[#6B7280]">{step.note}</span>}
          {step.url && <span className="block truncate font-mono text-[11px] text-[#9CA3AF]" title={step.url}>{step.url}</span>}
        </span>
        <Chip tone={status.tone}>{status.label}</Chip>
        {step.screenshot && (
          <button type="button" onClick={() => setOpen(o => !o)} className="text-[12px] font-semibold text-[#B71920] hover:underline">{open ? 'Hide' : 'Screenshot'}</button>
        )}
      </div>
      {open && (
        <div className="ml-9 mt-2 overflow-hidden rounded-[10px] border border-[#E8EAEE]">
          {shot ? <img src={shot} alt={`After ${beforeLabel(item, step.order)}`} className="w-full" /> : <div className="p-3 text-[12px] text-[#6B7280]">Loading…</div>}
        </div>
      )}
    </li>
  )
}

const Replay: React.FC<{ runKey: string }> = ({ runKey }) => {
  const [evidence, setEvidence] = useState<{ id: number; video: boolean; trace: boolean } | null>(null)
  const [video, setVideo] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    automationService.getRun(runKey).then((run: any) => {
      const result = (run?.results ?? []).find((r: any) => r?.evidence?.video || r?.evidence?.trace)
      if (live && result) setEvidence({ id: result.id, video: !!result.evidence.video, trace: !!result.evidence.trace })
    }).catch(() => undefined)
    return () => { live = false }
  }, [runKey])
  useEffect(() => () => { if (video) URL.revokeObjectURL(video) }, [video])
  if (!evidence) return null
  const watch = async () => {
    setBusy('video')
    try { setVideo(await automationService.getArtifactUrl(runKey, evidence.id, 'video')) } finally { setBusy(null) }
  }
  const trace = async () => {
    setBusy('trace')
    try {
      const url = await automationService.getArtifactUrl(runKey, evidence.id, 'trace')
      const a = document.createElement('a')
      a.href = url
      a.download = `walk-${runKey}-trace.zip`
      a.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 10000)
    } finally { setBusy(null) }
  }
  return (
    <div className="flex flex-col gap-2 px-5 pb-4">
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-[#6B7280]">
        <span className="font-bold uppercase tracking-[0.1em]">Replay</span>
        {evidence.video && <button type="button" onClick={() => void watch()} disabled={busy !== null || !!video} className={PLAIN}>{busy === 'video' ? 'Loading…' : 'Watch the video'}</button>}
        {evidence.trace && (
          <button type="button" onClick={() => void trace()} disabled={busy !== null} className={PLAIN}
            title="Open it at trace.playwright.dev, or with npx playwright show-trace: every step with the page, network and console">
            {busy === 'trace' ? 'Downloading…' : 'Download the trace'}
          </button>
        )}
      </div>
      {video && <video src={video} controls className="max-h-[420px] w-full rounded-[12px] border border-[#E8EAEE] bg-black" />}
    </div>
  )
}

// --- Every element on every screen -------------------------------------------------------

const ScreenInventory: React.FC<{
  pages: InventoryPage[]
  selectable: boolean
  chosen: Set<string>
  onToggle: (key: string) => void
}> = ({ pages, selectable, chosen, onToggle }) => {
  const [showSiteWide, setShowSiteWide] = useState(false)
  if (!pages.length) return null
  return (
    <div className="flex flex-col gap-3 px-5 pb-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-[#6B7280]">On each screen · everything the walk saw</span>
        <label className="flex items-center gap-2 text-[12px] text-[#4B5563]">
          <input type="checkbox" checked={showSiteWide} onChange={e => setShowSiteWide(e.target.checked)} className="accent-[#B71920]" />
          Show header, footer and menu links
        </label>
      </div>
      {pages.map(page => {
        const main = page.elements.filter(e => !e.chrome)
        const siteWide = page.elements.length - main.length
        const shown = showSiteWide ? page.elements : main
        return (
          <div key={`${page.screen_id ?? ''}${page.page}`} className="overflow-hidden rounded-[12px] border border-[#E8EAEE]">
            <div className="flex flex-wrap items-center gap-2 border-b border-[#F1F2F4] bg-[#FCFCFD] px-3.5 py-2 text-[12.5px]">
              <strong className="text-[#1F2937]">{page.screen_id ?? 'Page'}</strong>
              <code className="truncate text-[11.5px] text-[#6B7280]" title={page.url ?? ''}>{page.page}</code>
              <span className="ml-auto text-[#6B7280]">
                {main.length} on the screen · <span className={page.app_only ? 'font-semibold text-[#8A5000]' : ''}>{page.app_only} not in the design</span> · {siteWide} site-wide
              </span>
            </div>
            <ul className="m-0 list-none p-0">
              {shown.map(e => {
                const key = `${page.screen_id}|${e.selector}`
                const addable = selectable && !!page.screen_id && !e.matched && !e.chrome
                return (
                  <li key={e.selector} className={`grid grid-cols-[22px_86px_minmax(0,1fr)_auto] items-center gap-2 border-t border-[#F1F2F4] px-3.5 py-1.5 text-[12.5px] first:border-t-0 ${e.chrome ? 'text-[#9CA3AF]' : ''}`}>
                    {addable
                      ? <input type="checkbox" checked={chosen.has(key)} onChange={() => onToggle(key)} aria-label={`Add ${e.name || e.selector} to the Journey KB`} className="accent-[#B71920]" />
                      : <span />}
                    <span className="text-[11.5px] font-semibold text-[#6B7280]">{e.role}</span>
                    <span className="min-w-0">
                      <span className="block truncate" title={e.name}>{e.name || <em className="text-[#9CA3AF]">no name</em>}</span>
                      <span className="block truncate font-mono text-[10.5px] text-[#9CA3AF]" title={e.selector}>{e.selector}</span>
                    </span>
                    {e.matched
                      ? <Chip tone="good" title="This is a design element">In design · {e.matched}</Chip>
                      : e.chrome ? <Chip tone="idle">site-wide</Chip>
                        : <Chip tone="warn" title="In the application, not in the Journey KB">Not in design</Chip>}
                  </li>
                )
              })}
              {shown.length === 0 && <li className="px-3.5 py-2 text-[12px] text-[#6B7280]">Only header, footer and menu links on this page.</li>}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

// --- The stage -----------------------------------------------------------------------------

// Walks a documented journey -- or a flow blueprint -- in the running
// application with values from Test Data, on the environment chosen in the
// page header. Watch it live (or in a real browser, where the server can show
// one), stop before anything that changes data, then replay it. A journey walk
// also looks for every element the design says each screen has and proposes
// what it captured as change sets; nothing is written until approved.
// --- A capture from the person's own browser -------------------------------------------
//
// Where Playwright cannot run, the capture tool does the walk's browser half in
// the person's own browser: they open each page of the journey, capture it
// (every control, heading, column header and message, with a selector that
// matches only that element) and pick and name anything else. The zip it
// downloads is uploaded here against the journey and reviewed like a walk.

const CaptureUpload: React.FC<{
  appKey: string
  journeyId: string
  application: { id: number; environment: string; base_url: string }
  canExecute: boolean
  onImported: (id: number) => void
}> = ({ appKey, journeyId, application, canExecute, onImported }) => {
  const [code, setCode] = useState<string | null>(null)
  const [codeError, setCodeError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bookmarklet = useRef<HTMLAnchorElement | null>(null)
  useEffect(() => {
    knowledgeBaseService.captureTool().then(setCode).catch(err => setCodeError(errorText(err)))
  }, [])
  // Set outside React: it refuses javascript: URLs in href, and a bookmarklet is one.
  useEffect(() => {
    if (bookmarklet.current && code) bookmarklet.current.setAttribute('href', `javascript:${encodeURIComponent(code)}`)
  }, [code])
  const copy = async () => {
    if (!code) return
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2500) } catch { setCodeError('Copy failed; the browser blocked the clipboard.') }
  }
  const upload = async () => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const crawl = await knowledgeBaseService.importCapture(appKey, { file, journey_id: journeyId, application_id: application.id, environment: application.environment })
      setFile(null)
      onImported(crawl.id)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-3 rounded-[12px] border border-[#E8EAEE] p-4 text-[12.5px] text-[#374151]">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#6B7280]">1 · Capture in your browser</span>
          <ol className="m-0 flex list-decimal flex-col gap-1 pl-5">
            <li>Open {application.base_url} ({application.environment}) in your own Edge or Chrome and sign in.</li>
            <li>Start the tool: drag <a ref={bookmarklet} href="#capture-tool" onClick={e => e.preventDefault()} draggable
              className="rounded-[6px] bg-[#B71920] px-1.5 py-0.5 font-bold text-white no-underline" title="Drag me to the bookmarks bar, then click the bookmark on the application's page">KB capture</a> to your bookmarks bar and click it there, or paste the copied code into the DevTools Console.</li>
            <li>On every page of the journey — and every dialog, open — press <strong>Capture page</strong>. Use <strong>Pick element</strong> to name anything the journey needs that is not a button or field.</li>
            <li>Press <strong>Download zip</strong>. Nothing you type is recorded.</li>
          </ol>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void copy()} disabled={!code}
              className="h-[30px] rounded-[9px] border border-[#E8EAEE] bg-white px-3 text-[12.5px] font-bold text-[#1F2937] hover:border-[#F6D4D5] disabled:opacity-50">
              {copied ? 'Copied' : 'Copy for the DevTools Console'}
            </button>
          </div>
          {codeError && <Note tone="warn">{codeError}</Note>}
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#6B7280]">2 · Upload it against this journey</span>
          <input type="file" accept=".zip,.json,application/zip,application/json" aria-label="Capture file"
            onChange={e => { setFile(e.target.files?.[0] ?? null); setError(null) }}
            className="text-[12.5px] file:mr-3 file:h-[30px] file:rounded-[9px] file:border file:border-[#E8EAEE] file:bg-white file:px-3 file:font-bold" />
          <span className="text-[#6B7280]">
            Each page is matched to a screen of the journey by its address and what is on it; each step's element is found by its label.
            The result opens below like a walk: pick suggestions, propose changes, then Generate flow. A zip in the page-object layout (journey.json + pages/*.json) is read too.
          </span>
          <button type="button" onClick={() => void upload()} disabled={!canExecute || !file || !journeyId || busy}
            title={!canExecute ? 'Needs the automation.execute permission' : undefined}
            className="h-[34px] w-fit rounded-[10px] bg-[#B71920] px-4 text-[13px] font-bold text-white hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? 'Matching…' : 'Upload and match'}
          </button>
          {error && <Note tone="warn">{error}</Note>}
        </div>
      </div>
    </div>
  )
}

const JourneyCrawlStage: React.FC<{
  appKey: string
  application: { id: number; environment: string; base_url: string }
  canExecute: boolean
  canApprove?: boolean
  onProposed: () => void
}> = ({ appKey, application, canExecute, canApprove = false, onProposed }) => {
  const [params] = useSearchParams()
  const [taxonomy, taxError] = useLoad(appKey, () => knowledgeBaseService.taxonomy(appKey))
  const [coverage] = useLoad(appKey, () => knowledgeBaseService.testData(appKey))
  const [flowList] = useLoad(appKey, () => knowledgeBaseService.walkFlows(appKey).catch(() => [] as WalkFlow[]))
  const [caps] = useLoad('walk-capabilities', () => knowledgeBaseService.walkCapabilities().catch(() => ({ headed_available: false, blocked_environments: [] }) as WalkCapabilities))
  const journeys = useMemo(() => {
    if (!taxonomy) return []
    const byId = new Map(taxonomy.nodes.map(n => [n.id, n]))
    return taxonomy.authored.map(id => ({ id, title: byId.get(id)?.title ?? id }))
  }, [taxonomy])

  // What to do: walk a journey or a flow blueprint (?flow=<id> opens on one),
  // or record a journey by doing it (?record=1, from the Journey Map).
  const askedFlow = params.get('flow')
  const [source, setSource] = useState<'journey' | 'flow' | 'record' | 'capture'>(askedFlow ? 'flow' : params.get('record') ? 'record' : params.get('capture') ? 'capture' : 'journey')
  const [journeyId, setJourneyId] = useState<string>('')
  const [flowId, setFlowId] = useState<string>(askedFlow ?? '')
  const [profileId, setProfileId] = useState<string>('')
  const [stopBefore, setStopBefore] = useState<number | null>(null)
  const [allowRisky, setAllowRisky] = useState(false)
  const [headed, setHeaded] = useState(false)
  // ?journey= (from the Journey Map) picks the journey to walk; else the last one.
  const askedJourney = params.get('journey')
  useEffect(() => {
    if (journeyId || !journeys.length) return
    setJourneyId(journeys.some(j => j.id === askedJourney) ? (askedJourney as string) : journeys[journeys.length - 1].id)
  }, [journeys, journeyId, askedJourney])
  useEffect(() => { if (!flowId && flowList?.length) setFlowId(flowList[0].flow_id) }, [flowList, flowId])
  const sourceId = source === 'flow' ? (flowId ? `flow:${flowId}` : '') : journeyId
  const recording = source === 'record'
  // A capture is uploaded, not run: none of the walk's run controls apply.
  const capturing = source === 'capture'
  useEffect(() => { setStopBefore(null); setAllowRisky(false) }, [sourceId])

  const [plan, setPlan] = useState<CrawlPlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  useEffect(() => {
    if (!sourceId) return
    let live = true
    setPlanError(null)
    knowledgeBaseService.crawlPlan(appKey, sourceId, profileId || null, { stop_before: stopBefore, allow_risky: allowRisky })
      .then(p => { if (live) setPlan(p) })
      .catch(err => { if (live) { setPlan(null); setPlanError(errorText(err)) } })
    return () => { live = false }
  }, [appKey, sourceId, profileId, stopBefore, allowRisky])

  const [crawls, setCrawls] = useState<JourneyCrawl[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const loadCrawls = useCallback(() => {
    knowledgeBaseService.crawls(appKey).then(c => { setCrawls(c); setListError(null) }).catch(err => setListError(errorText(err)))
  }, [appKey])
  useEffect(loadCrawls, [loadCrawls])
  const active = !!crawls?.[0] && ['queued', 'running'].includes(crawls[0].status)

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<JourneyCrawl | null>(null)
  const shownId = selectedId ?? crawls?.[0]?.id ?? null
  useEffect(() => {
    if (shownId == null) { setDetail(null); return }
    const fromList = crawls?.find(c => c.id === shownId && c.result !== undefined)
    if (fromList) { setDetail(fromList); return }
    let live = true
    knowledgeBaseService.crawl(shownId).then(c => { if (live) setDetail(c) }).catch(() => undefined)
    return () => { live = false }
  }, [shownId, crawls])
  const [detailPlan, setDetailPlan] = useState<CrawlPlan | null>(null)
  useEffect(() => {
    // The live panel lists the walk's own plan, not whatever is selected above.
    if (!detail || detail.source === 'record') { setDetailPlan(null); return }
    knowledgeBaseService.crawlPlan(appKey, detail.journey_id, detail.profile_id, { stop_before: detail.stop_before ?? null, allow_risky: true })
      .then(setDetailPlan).catch(() => setDetailPlan(null))
  }, [appKey, detail?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const [busy, setBusy] = useState<null | 'start' | 'record' | 'propose' | 'generate'>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNote, setActionNote] = useState<string | null>(null)
  // What the reviewer chose from a finished walk: app-only elements to add,
  // and a candidate for each element (or flow step) the walk could not find.
  const [additions, setAdditions] = useState<Set<string>>(new Set())
  const [picks, setPicks] = useState<Record<string, string>>({})
  const [showOthers, setShowOthers] = useState(false)
  useEffect(() => { setAdditions(new Set()); setPicks({}); setActionNote(null) }, [detail?.id])
  const toggleAddition = (key: string) => setAdditions(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const missing = useMemo(() => {
    if (!plan || !coverage) return []
    const gaps = new Set(coverage.profiles.flatMap(p => p.cells[application.environment]?.missing ?? []))
    return plan.variables.filter(v => gaps.has(v))
  }, [plan, coverage, application.environment])
  const blocked = (caps?.blocked_environments ?? []).includes((application.environment || '').toUpperCase())

  const start = async () => {
    setBusy('start')
    setActionError(null)
    try {
      const run = await knowledgeBaseService.startCrawl(appKey, {
        journey_id: sourceId, application_id: application.id, profile_id: plan?.profile_id ?? (profileId || null),
        environment: application.environment, stop_before: stopBefore, allow_risky: allowRisky, headed: headed && !!caps?.headed_available
      })
      setSelectedId(run.id)
      loadCrawls()
    } catch (err) {
      setActionError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const startRecording = async () => {
    setBusy('record')
    setActionError(null)
    try {
      const run = await knowledgeBaseService.startRecording(appKey, { journey_id: journeyId, application_id: application.id, environment: application.environment })
      setSelectedId(run.id)
      loadCrawls()
    } catch (err) {
      setActionError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const propose = async (id: number) => {
    setBusy('propose')
    setActionError(null)
    try {
      const updated = await knowledgeBaseService.proposeFromCrawl(id, {
        additions: Array.from(additions),
        picks: Object.entries(picks).map(([key, selector]) => {
          const [screen_id, element_id] = key.split('|')
          return { screen_id, element_id, selector }
        })
      })
      setDetail(updated)
      loadCrawls()
      onProposed()
    } catch (err) {
      setActionError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const generateFlow = async (id: number) => {
    setBusy('generate')
    setActionError(null)
    try {
      const made = await knowledgeBaseService.generateFlow(id)
      setActionNote(`The journey's flow blueprint ${made.flow.flow_id ?? ''} is regenerated from its steps and confirmed selectors, waiting for review as change set #${made.change_set.id}.`)
      onProposed()
    } catch (err) {
      setActionError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const allRows = useMemo(() => detail?.result?.rows ?? [], [detail])
  // A journey walk's results read step by step: the element each journey step
  // used, in step order; the other elements on its screens are one click away.
  const stepTied = detail?.source !== 'flow' && allRows.some(r => r.step != null || r.setup)
  const rows = useMemo(() => {
    if (!stepTied) return [...allRows].sort((a, b) => ORDER.indexOf(a.outcome) - ORDER.indexOf(b.outcome) || a.screen_id.localeCompare(b.screen_id))
    const shown = allRows.filter(r => r.step != null || r.setup || showOthers)
    return [...shown].sort((a, b) => Number(!a.setup) - Number(!b.setup) || (a.step ?? 9999) - (b.step ?? 9999) || a.screen_id.localeCompare(b.screen_id))
  }, [allRows, stepTied, showOthers])
  const others = stepTied ? allRows.filter(r => r.step == null && !r.setup).length : 0
  const shownSummary = useMemo(() => {
    const out: Partial<Record<CrawlOutcome, number>> = {}
    for (const r of rows) out[r.outcome] = (out[r.outcome] ?? 0) + 1
    return out
  }, [rows])
  const setupItems = (plan?.items ?? []).filter(i => i.setup)
  const captured = allRows.some(r => ['new', 'healed'].includes(r.outcome) && !r.data_dependent && !r.ambiguous)
  const pickCount = Object.keys(picks).length
  const proposable = captured || additions.size > 0 || pickCount > 0 || (detail?.source !== 'flow' && !!detail?.result?.summary.routes_new)
  const alreadyProposed = detail?.source !== 'flow' && !!(detail?.automation_change_set_id || detail?.journey_change_set_id)
  const ranSteps = (detail?.result?.steps ?? []).some(s => s.status === 'done')
  const running = !!detail && ['queued', 'running'].includes(detail.status)

  if (taxError) return <Card><Failed message={taxError} /></Card>
  if (!taxonomy) return <Card><Loading what="journeys" /></Card>

  return (
    <div className="flex flex-col gap-4">
      <Card label="Walk and dry run">
        <CardHead
          title="Walk & dry run"
          hint={`Walks a journey or a flow in the running application at ${application.base_url} (${application.environment}), with values from Test Data`}
        />
        <div className="flex flex-col gap-3 px-5 pb-5">
          <div className="flex flex-wrap items-end gap-3">
            <div className={LABEL}>
              Walk
              <div role="radiogroup" aria-label="What to walk" className="flex h-[34px] overflow-hidden rounded-[10px] border border-[#E8EAEE]">
                {(['journey', 'flow', 'record', 'capture'] as const).map(s => (
                  <button key={s} type="button" role="radio" aria-checked={source === s} onClick={() => setSource(s)}
                    className={`px-3 text-[12.5px] font-semibold normal-case tracking-normal ${source === s ? 'bg-[#1F2937] text-white' : 'bg-white text-[#374151]'}`}>
                    {s === 'journey' ? 'A journey' : s === 'flow' ? 'A flow blueprint' : s === 'record' ? 'Record it myself' : 'Upload a capture'}
                  </button>
                ))}
              </div>
            </div>
            {source !== 'flow' ? (
              <label className={LABEL}>
                Journey
                <select aria-label="Journey" value={journeyId} onChange={e => { setJourneyId(e.target.value); setProfileId('') }} className={`${SELECT} max-w-[360px]`}>
                  {journeys.map(j => <option key={j.id} value={j.id}>{j.title}</option>)}
                </select>
              </label>
            ) : (
              <label className={LABEL}>
                Flow blueprint
                <select aria-label="Flow blueprint" value={flowId} onChange={e => setFlowId(e.target.value)} className={`${SELECT} max-w-[360px]`}>
                  {(flowList ?? []).map(f => <option key={f.flow_id} value={f.flow_id}>{f.flow_name} · {f.steps} steps</option>)}
                </select>
              </label>
            )}
            {!recording && !capturing && <>
            <label className={LABEL}>
              Test data
              <select aria-label="Test data profile" value={profileId || plan?.profile_id || ''} onChange={e => setProfileId(e.target.value)} className={`${SELECT} max-w-[300px]`}>
                {(coverage?.profiles ?? []).filter(p => p.kind === 'vault').map(p => <option key={p.profile_id} value={p.profile_id}>{p.name}</option>)}
                {!coverage && plan?.profile_id && <option value={plan.profile_id}>{plan.profile_id}</option>}
              </select>
            </label>
            <label className={LABEL}>
              Stop
              <select aria-label="Stop before" value={stopBefore ?? ''} onChange={e => setStopBefore(e.target.value ? Number(e.target.value) : null)} className={`${SELECT} max-w-[280px]`}>
                <option value="">{plan?.first_risky && !allowRisky ? `Before ${beforeLabel(plan.items[plan.first_risky - 1], plan.first_risky)} (changes data)` : 'Run every step'}</option>
                {(plan?.items ?? []).map((item, i) => i > 0 && item.kind !== 'skip' && (
                  <option key={i} value={i + 1}>Before {beforeLabel(item, i + 1)}: {item.text.slice(0, 40)}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => void start()}
              disabled={!canExecute || !plan || busy !== null || active || missing.length > 0 || blocked}
              title={!canExecute ? 'Needs the automation.execute permission' : active ? 'A walk is already running' : blocked ? `Walks do not run against ${application.environment}` : missing.length ? 'Test Data is missing values this walk needs' : undefined}
              className="h-[34px] rounded-[10px] bg-[#B71920] px-4 text-[13px] font-bold text-white hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === 'start' ? 'Starting…' : 'Start dry run'}
            </button>
            </>}
            {recording && (
              <button
                type="button"
                onClick={() => void startRecording()}
                disabled={!canExecute || !journeyId || busy !== null || active || blocked || !caps?.headed_available}
                title={!canExecute ? 'Needs the automation.execute permission' : !caps?.headed_available ? 'This server cannot open a browser window' : active ? 'A walk or recording is already running' : undefined}
                className="h-[34px] rounded-[10px] bg-[#B71920] px-4 text-[13px] font-bold text-white hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === 'record' ? 'Opening the browser…' : 'Start recording'}
              </button>
            )}
          </div>
          {recording && (
            <Note tone={caps && !caps.headed_available ? 'warn' : undefined}>
              {caps && !caps.headed_available
                ? 'Recording opens a browser window for you to use, and this server has no screen. Record from a backend running on your own machine.'
                : `Opens a browser window on this machine at ${application.base_url} (${application.environment}). Do the journey yourself: every click, field and choice becomes a step with the selector it used, and nothing you type is kept. Afterwards you review the steps and save them as this journey's steps.`}
            </Note>
          )}
          {capturing && (
            <CaptureUpload appKey={appKey} journeyId={journeyId} application={application} canExecute={canExecute}
              onImported={id => { setSelectedId(id); loadCrawls() }} />
          )}
          {!recording && !capturing && <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-[#374151]">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={allowRisky} onChange={e => setAllowRisky(e.target.checked)} className="accent-[#B71920]" />
              Allow steps that change data
              {plan?.first_risky ? <span className="text-[#8A5000]">({beforeLabel(plan.items[plan.first_risky - 1], plan.first_risky)}: {plan.items[plan.first_risky - 1]?.text.slice(0, 50)})</span> : <span className="text-[#9CA3AF]">(none in this walk)</span>}
            </label>
            {caps?.headed_available ? (
              <label className="flex items-center gap-2" title="Opens a real browser window on the machine the backend runs on, slowed down so you can follow it">
                <input type="checkbox" checked={headed} onChange={e => setHeaded(e.target.checked)} className="accent-[#B71920]" />
                Show the browser on this machine
              </label>
            ) : (
              <span className="text-[#6B7280]" title="The server runs without a screen; the walk is shown live on this page instead">Watch it live below (this server cannot open a browser window)</span>
            )}
          </div>}
          {blocked && <Note tone="warn">Walks do not run against {application.environment}: they fill in forms and click through journeys. Choose SIT, QA, UAT or RC in the header.</Note>}
          {planError && <Note tone="warn">{planError}</Note>}
          {missing.length > 0 && !capturing && (
            <Note tone="warn">Test Data has no value in {application.environment} for {missing.join(', ')}. Add it on the Test Data stage, or stop the walk before the step that needs it.</Note>
          )}
          {actionError && <Note tone="warn">{actionError}</Note>}
          {!recording && plan?.scenario && (
            <Note>
              This test data is for {plan.scenario.scenario_id} ({plan.scenario.type}): {plan.scenario.title}. The walk runs steps {plan.scenario.steps.join(', ')} and expects that outcome.
            </Note>
          )}
          {!recording && (plan?.warnings ?? []).map(w => <Note key={w} tone="warn">{w}</Note>)}
          {!recording && plan && (
            <details className="rounded-[12px] border border-[#E8EAEE]">
              <summary className="cursor-pointer px-3.5 py-2.5 text-[12.5px] font-semibold text-[#374151]">
                Plan · {plan.items.filter(i => !i.setup).length} steps{setupItems.length ? ` after ${setupItems.length} setup steps (${Array.from(new Set(setupItems.map(i => i.journey_name))).join(', ')})` : ''} · reads {plan.variables.join(', ') || 'no test data'}
                {plan.stop_before ? ` · stops before ${beforeLabel(plan.items[plan.stop_before - 1], plan.stop_before)}` : ''}
              </summary>
              <ol className="m-0 flex list-none flex-col p-0">
                {plan.items.map((item, i) => {
                  const notRun = !!plan.stop_before && i + 1 >= plan.stop_before
                  const prev = plan.items[i - 1]
                  const heading = plan.source !== 'flow' && setupItems.length && (!prev || prev.journey_id !== item.journey_id)
                    ? (item.setup ? `Setup · ${item.journey_name} · run first to reach the journey` : item.journey_name)
                    : null
                  return (
                    <React.Fragment key={i}>
                    {heading && <li className="border-t border-[#F1F2F4] bg-[#FCFCFD] px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[#6B7280]">{heading}</li>}
                    <li className={`grid grid-cols-[28px_72px_minmax(0,1fr)] gap-3 border-t border-[#F1F2F4] px-3.5 py-2 text-[12.5px] sm:grid-cols-[28px_72px_minmax(0,1fr)_minmax(0,220px)] ${notRun ? 'opacity-50' : ''}`}>
                      <span className="text-right text-[#9CA3AF]">{item.setup ? '·' : item.step_number}</span>
                      <span className="font-semibold text-[#6B7280]">{KIND[item.kind] ?? item.kind}</span>
                      <span className={`min-w-0 ${item.kind === 'skip' || item.setup ? 'text-[#9CA3AF]' : 'text-[#1F2937]'}`}>
                        {item.text}
                        {item.kind === 'skip' && item.reason && <span className="block text-[11px]">Not walked: {item.reason}</span>}
                        {item.risky && <span className="ml-1.5 text-[11px] font-semibold text-[#8A5000]">changes data</span>}
                        {plan.stop_before === i + 1 && <span className="ml-1.5 text-[11px] font-semibold text-[#B71920]">⏹ stops here</span>}
                        {(item.expect ?? []).filter(o => o.expected).map(o => (
                          <span key={o.to.join('|')} className="block text-[11px] text-[#1F7A4D]">
                            expects → {o.to.map(s => plan.screen_names?.[s] ?? s).join(' or ')}{o.effect ? ` (${o.effect})` : ''}{o.rule ? ` · ${o.rule}` : ''}
                          </span>
                        ))}
                      </span>
                      <span className="hidden truncate font-mono text-[11px] text-[#6B7280] sm:block">{item.variable || item.text_variable || item.screen_id || ''}</span>
                    </li>
                    </React.Fragment>
                  )
                })}
              </ol>
            </details>
          )}
          {!recording && !capturing && <p className="m-0 text-[12px] text-[#6B7280]">
            {plan?.source !== 'flow' && plan?.entry ? <>Starts at {plan.entry} and lets the application open its first screen; each screen is recognised by what is on it. </> : null}
            Values come from Test Data at run time and are never recorded; typed fields are painted over in screenshots and live frames (the video and trace still show them). A journey walk keeps a selector only if it matched exactly one element.
          </p>}
        </div>
      </Card>

      <Card label="Walk results">
        <CardHead
          title={detail ? `${detail.source === 'record' ? 'Recording' : detail.source === 'capture' ? 'Capture' : 'Walk'} #${detail.id} · ${detail.journey_name ?? detail.journey_id}` : 'Walk results'}
          hint={detail ? `${detail.source === 'flow' ? 'Flow blueprint' : detail.source === 'record' ? 'Recorded by a person' : detail.source === 'capture' ? 'Captured in a browser' : 'Journey'} · ${detail.environment ?? ''} · ${detail.source === 'capture' ? (detail.result?.capture?.file ?? 'uploaded') : (detail.profile_id ?? 'no profile')} · started ${detail.created_at ? new Date(detail.created_at + 'Z').toLocaleString() : '—'}${detail.created_by ? ` by ${detail.created_by}` : ''}` : 'Nothing has been walked for this application yet'}
          right={
            <div className="flex flex-wrap items-center gap-2">
              {crawls && crawls.length > 1 && (
                <select aria-label="Walk" value={shownId ?? ''} onChange={e => setSelectedId(Number(e.target.value))} className={SELECT}>
                  {crawls.map(c => <option key={c.id} value={c.id}>#{c.id} · {c.source === 'record' ? 'recording · ' : c.source === 'capture' ? 'capture · ' : ''}{c.journey_name ?? c.journey_id} · {c.environment} · {c.status}</option>)}
                </select>
              )}
              {detail && <Chip tone={STATUS_TONE[detail.status]}>{detail.status}</Chip>}
              {detail?.status === 'completed' && (detail.source === 'journey' || detail.source === 'capture') && ranSteps && (
                <button type="button" onClick={() => void generateFlow(detail.id)} disabled={!canExecute || busy !== null}
                  title="Regenerates the journey's own flow blueprint from its steps and the selectors walks confirmed (as the Journey Map does) — drafted for review"
                  className="h-[34px] rounded-[10px] border border-[#E8EAEE] bg-white px-4 text-[13px] font-bold text-[#1F2937] hover:border-[#F6D4D5] disabled:opacity-50">
                  {busy === 'generate' ? 'Generating…' : 'Generate flow'}
                </button>
              )}
              {detail?.status === 'completed' && detail.source !== 'record' && !alreadyProposed && (
                <button type="button" onClick={() => void propose(detail.id)} disabled={!canExecute || busy !== null || !proposable}
                  title={!proposable ? (detail.source === 'flow' ? 'Every step was found with the flow’s selector; pick a suggestion for one that was not' : 'Nothing captured yet: tick elements to add, or pick a suggestion') : undefined}
                  className="h-[34px] rounded-[10px] bg-[#B71920] px-4 text-[13px] font-bold text-white hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50">
                  {busy === 'propose' ? 'Proposing…'
                    : detail.source === 'flow' ? `Propose fixes${pickCount ? ` (${pickCount} picked)` : ''}`
                      : `Propose changes${additions.size || pickCount ? ` (${[additions.size && `${additions.size} to add`, pickCount && `${pickCount} picked`].filter(Boolean).join(', ')})` : ''}`}
                </button>
              )}
              {(detail?.automation_change_set_id || detail?.journey_change_set_id) && (
                <button type="button" onClick={onProposed} className="h-[34px] rounded-[10px] border border-[#E8EAEE] bg-white px-4 text-[13px] font-bold text-[#1F2937] hover:border-[#F6D4D5]">
                  Review change sets {[detail.automation_change_set_id, detail.journey_change_set_id].filter(Boolean).map(id => `#${id}`).join(' + ')}
                </button>
              )}
            </div>
          }
        />
        {listError && <Failed message={listError} onRetry={loadCrawls} />}
        {!crawls && !listError && <Loading what="walks" />}
        {actionNote && <div className="px-5 pb-3"><Note>{actionNote}</Note></div>}
        {detail && running && detail.source === 'record' && <RecordingLive crawl={detail} onFinished={loadCrawls} canStop={canExecute} />}
        {detail && running && detail.source !== 'record' && <LivePanel crawl={detail} plan={detailPlan} onFinished={loadCrawls} canStop={canExecute} />}
        {detail?.status === 'failed' && <div className="px-5 pb-5"><Note tone="warn">{detail.error}</Note></div>}
        {detail?.result && detail.source === 'record' && (
          <RecordingReview appKey={appKey} crawl={detail} canExecute={canExecute} canApprove={canApprove}
            onSaved={() => { loadCrawls(); onProposed() }} />
        )}
        {detail?.result && detail.source !== 'record' && (
          <>
            {detail.stop_before && (
              <div className="px-5 pb-3"><Note>Stopped before step {detail.stop_before}: {detail.stop_reason}.</Note></div>
            )}
            {detail.result.blockers.length > 0 && <div className="px-5 pb-3"><Note tone="warn">Stopped early: {detail.result.blockers.join('; ')}</Note></div>}
            {detail.result.capture && (
              <div className="flex flex-col gap-2 px-5 pb-3">
                {detail.result.capture.notes.map(n => <Note key={n} tone="warn">{n}</Note>)}
                <div className="flex flex-wrap gap-1.5 text-[12px] text-[#4B5563]">
                  <span className="font-semibold">Pages:</span>
                  {detail.result.capture.pages.map(p => (
                    <span key={p.page_id} title={p.url ?? undefined} className={`rounded-full border px-2 py-0.5 ${p.screen_id || p.steps?.length ? 'border-[#D5E9DD] bg-[#F1F8F4]' : 'border-[#F6D4D5] bg-[#FFF7F7]'}`}>
                      {p.name || p.page_id} → {p.screen_id ? (detailPlan?.screen_names?.[p.screen_id] ?? p.screen_id) : p.steps?.length ? `step${p.steps.length > 1 ? 's' : ''} ${p.steps.join(', ')}` : 'not used'} · {p.elements} elements
                    </span>
                  ))}
                </div>
              </div>
            )}
            {detail.result.entry && detail.source !== 'capture' && (
              <div className="px-5 pb-3 text-[12px] text-[#4B5563]">
                Started at <span className="font-mono">{detail.result.entry.address}</span>
                {detail.result.entry.landed && <> → the application opened <span className="font-mono">{detail.result.entry.landed}</span></>}
                {detail.result.entry.screen && <> · recognised as {detailPlan?.screen_names?.[detail.result.entry.screen] ?? detail.result.entry.screen}</>}
                {detail.result.entry.note && <span className="block text-[#8A5000]">{detail.result.entry.note}; the walk opened the first screen’s address instead.</span>}
              </div>
            )}
            {detail.result.scenario && (
              <div className="px-5 pb-3"><Note>Scenario {detail.result.scenario.scenario_id} ({detail.result.scenario.type}): {detail.result.scenario.title}. Steps outside it were skipped.</Note></div>
            )}
            {detail.result.derailed && (
              <div className="px-5 pb-3"><Note tone="warn">Left the journey’s path after step {detail.result.derailed.after}: {detail.result.derailed.reason}. The steps after it are blocked, not missing.</Note></div>
            )}
            {detail.run_key && <Replay runKey={detail.run_key} />}
            <div className="px-5 pb-1 text-[11px] font-bold uppercase tracking-[0.1em] text-[#6B7280]">Steps</div>
            <ol className="m-0 list-none p-0">
              {detail.result.steps.map(step => <StepRow key={step.order} crawlId={detail.id} step={step} item={detailPlan?.items[step.order - 1]} screenNames={detailPlan?.screen_names ?? {}} />)}
            </ol>
            <div className="pt-4">
              <ScreenInventory pages={detail.result.inventory ?? []} selectable={canExecute && detail.source !== 'flow' && !alreadyProposed}
                chosen={additions} onToggle={toggleAddition} />
            </div>
            {(detail.result.routes ?? []).length > 0 && (
              <div className="px-5 pt-4">
                <div className="pb-1 text-[11px] font-bold uppercase tracking-[0.1em] text-[#6B7280]">Screen addresses found</div>
                <ul className="m-0 list-none p-0 text-[12px]">
                  {(detail.result.routes ?? []).map(r => (
                    <li key={r.screen_id} className="flex flex-wrap items-center gap-2 py-0.5">
                      <span className="font-semibold text-[#1F2937]">{detailPlan?.screen_names?.[r.screen_id] ?? r.screen_id}</span>
                      <span className="font-mono text-[11.5px] text-[#4B5563]">{r.path}</span>
                      {r.state === 'same' && <Chip tone="good">As recorded</Chip>}
                      {r.state === 'new' && <Chip tone="info" title="Not recorded in the Knowledge Bases; Propose changes adds it">New</Chip>}
                      {r.state === 'differs' && <Chip tone="warn" title={`Recorded as ${r.known}`}>Moved · was {r.known}</Chip>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap gap-1.5 px-5 pb-3 pt-4">
              <span className="mr-1 text-[11px] font-bold uppercase tracking-[0.1em] text-[#6B7280]">{detail.source === 'flow' ? 'Flow selectors' : stepTied ? 'Elements of the journey steps' : 'Design elements'}</span>
              {ORDER.filter(o => shownSummary[o]).map(o => (
                <Chip key={o} tone={OUTCOME[o].tone} title={OUTCOME[o].hint}>{OUTCOME[o].label} · {shownSummary[o]}</Chip>
              ))}
              {others > 0 && (
                <button type="button" onClick={() => setShowOthers(v => !v)} className="ml-auto text-[12px] font-semibold text-[#B71920] hover:underline"
                  title="Elements on the journey's screens that no step uses; the walk captured them while it was there">
                  {showOthers ? 'Journey steps only' : `Also show ${others} other element${others === 1 ? '' : 's'} on these screens`}
                </button>
              )}
            </div>
            <div className="hidden h-8 grid-cols-[minmax(0,1.1fr)_130px_minmax(0,1.6fr)] items-center gap-3 bg-[#F4F5F7] px-5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-[#374151] md:grid">
              <span>{detail.source === 'flow' ? 'Flow step' : stepTied ? 'Journey step · element' : 'Design element'}</span><span>Outcome</span><span>Selector · how it was found</span>
            </div>
            <ul className="m-0 list-none p-0">
              {rows.map(r => (
                <li key={`${r.screen_id}.${r.element_id}`} className="grid grid-cols-1 gap-1.5 border-t border-[#F1F2F4] px-5 py-2.5 text-[12.5px] md:grid-cols-[minmax(0,1.1fr)_130px_minmax(0,1.6fr)] md:gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-[#1F2937]" title={r.design_label ?? r.element_id}>
                      {stepTied && <span className="mr-1.5 text-[#6B7280]">{r.setup ? 'Setup ·' : r.step != null ? `Step ${r.step} ·` : 'Not a step ·'}</span>}
                      {r.design_label ?? r.element_id}
                    </div>
                    <div className="truncate font-mono text-[11px] text-[#6B7280]">{r.screen_id} · {r.element_id}</div>
                  </div>
                  <div className="flex flex-wrap items-start gap-1">
                    <Chip tone={OUTCOME[r.outcome].tone} title={OUTCOME[r.outcome].hint}>{OUTCOME[r.outcome].label}</Chip>
                  </div>
                  <div className="min-w-0">
                    {r.selector
                      ? <div className="truncate font-mono text-[11.5px] text-[#1F2937]" title={r.selector}>{r.selector}</div>
                      : <div className="text-[#9CA3AF]">—</div>}
                    <div className="flex flex-wrap gap-x-2 text-[11.5px] text-[#6B7280]">
                      {r.strategy && <span>via {r.strategy === 'kb' ? (detail.source === 'flow' ? "the flow's selector" : 'Automation KB') : r.strategy}</span>}
                      {r.label_differs && r.app_label && <span className="text-[#8A5000]">app says “{r.app_label}”</span>}
                      {r.data_dependent && <span title="Found by a test-data value; not proposed as a lasting selector">found through test data · not proposed</span>}
                      {r.ambiguous && <span className="text-[#8A5000]">matched more than one element · not proposed</span>}
                      {r.kb_target && r.outcome !== 'confirmed' && <span className="truncate" title={r.kb_target}>{detail.source === 'flow' ? 'flow had' : 'KB had'} {r.kb_target}</span>}
                    </div>
                    {(r.candidates ?? []).length > 0 && !alreadyProposed && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px]">
                        <span className="text-[#6B7280]">Is it one of these?</span>
                        {(r.candidates ?? []).map(c => {
                          const key = `${r.screen_id}|${r.element_id}`
                          const on = picks[key] === c.selector
                          return (
                            <button key={c.selector} type="button" disabled={!canExecute} title={c.selector}
                              onClick={() => setPicks(prev => {
                                const next = { ...prev }
                                if (on) delete next[key]; else next[key] = c.selector
                                return next
                              })}
                              className={`rounded-full border px-2.5 py-0.5 font-semibold ${on ? 'border-[#B71920] bg-[#FFF5F5] text-[#B71920]' : 'border-[#E8EAEE] bg-white text-[#374151] hover:border-[#F6D4D5]'}`}>
                              {on ? '✓ ' : ''}{c.role} “{c.name}”
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  )
}

export default JourneyCrawlStage
