import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import knowledgeBaseService, {
  errorText, type BrowserTabPreview, type CaptureInfo, type CoverageProfile, type CrawlBrowser, type CrawlOutcome, type CrawlPlan, type CrawlPlanItem, type CrawlStep, type InventoryPage, type JourneyCrawl, type WalkCapabilities, type WalkFlow, type WalkLive
} from '../../services/knowledgeBaseService'
import automationService from '../../services/automationService'
import { startDeviceRunner } from '../../services/localRunner'
import { COLLECTOR_VERSION, installedCollectorVersion, resumeInstalledCollector, startInstalledCollector, stopInstalledCollector } from '../../services/browserCollector'
import { Card, CardHead, Chip, Failed, Loading, Note, TONE, useLoad } from './kbUi'
import { RecordingLive, RecordingReview } from './JourneyRecording'
import { useAuthedImage } from './walkImage'
import CaptureInbox from './CaptureFlow'

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
const KIND: Record<string, string> = { goto: 'Open', screen: 'Screen', fill: 'Fill', otp: 'Enter OTP', click: 'Click', dblclick: 'Double-click', hover: 'Hover', focus: 'Focus', check: 'Check', uncheck: 'Uncheck', press: 'Press key', select: 'Select', capture: 'Look for', skip: 'Skip' }
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

/** Plan text is normally already a complete instruction such as "Click Login". */
const actionText = (kind: string | undefined, text: string | undefined) => {
  const value = (text ?? '').trim()
  if (value) return value
  return KIND[kind ?? ''] ?? kind ?? 'Step'
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
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
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
  const deviceOwned = crawl.execution_target === 'local'
  const frame = useAuthedImage(!deviceOwned && live?.frame_at ? () => knowledgeBaseService.crawlImage(crawl.id, 'live.png') : null, !deviceOwned && live?.frame_at ? String(live.frame_at) : null)
  const done = new Map((live?.steps ?? []).map(s => [s.order, s]))
  const items = plan?.items ?? []
  const browserOwned = crawl.source === 'browser'
  const collectorConnected = !!live?.connected_at || ['opening', 'capturing', 'completed'].includes(live?.collector_state ?? '')
  const pagesReceived = live?.pages_received ?? 0
  const confirmed = done.size
  const pending = Math.max(0, items.length - confirmed)
  const stop = async () => {
    setStopping(true)
    try {
      if (crawl.source === 'browser') {
        await stopInstalledCollector(crawl.id).catch(() => false)
        await knowledgeBaseService.cancelBrowserCrawl(crawl.id).catch(() => undefined)
      }
      else if (crawl.execution_target === 'local') await knowledgeBaseService.cancelLocalCrawl(crawl.id)
      else if (crawl.run_key) await automationService.cancelRun(crawl.run_key)
      onFinished()
    } catch { /* the run may have finished on its own */ }
    finally { setStopping(false) }
  }
  const retry = async () => {
    setRetrying(true); setRetryError(null)
    try {
      if (!await resumeInstalledCollector(crawl.id)) setRetryError(`The updated browser collector is not connected. Reload extension version ${COLLECTOR_VERSION}, then retry.`)
    } finally { setRetrying(false) }
  }
  return (
    <div className="grid gap-4 px-5 pb-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2 text-[12px] text-[#6B7280]">
          <span>
            <span className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-[#B71920] align-middle" aria-hidden />
            {deviceOwned ? 'Running on this device' : 'Live'} · {crawl.environment} · {live?.current ? `${beforeLabel(items[live.current.order - 1], live.current.order).replace('a setup step', 'setup')}: ${live.current.text}` : live?.phase ?? 'starting the browser…'}
          </span>
          {canStop && (
            <button type="button" onClick={() => void stop()} disabled={stopping} className={PLAIN}>{stopping ? 'Stopping…' : 'Stop'}</button>
          )}
        </div>
        {browserOwned ? (
          <div className="flex flex-col gap-3 text-[12px]">
            <div className="grid gap-2 sm:grid-cols-4">
              <CollectorMilestone label="Session" state="done" detail={`#${crawl.id} created`} />
              <CollectorMilestone label="Extension" state={collectorConnected ? 'done' : 'active'} detail={collectorConnected ? 'Connected' : 'Waiting for pairing'} />
              <CollectorMilestone label="Capture" state={pagesReceived > 0 ? 'done' : collectorConnected ? 'active' : 'waiting'} detail={`${pagesReceived} page${pagesReceived === 1 ? '' : 's'}`} />
              <CollectorMilestone label="Journey" state={pending === 0 ? 'done' : pagesReceived > 0 ? 'active' : 'waiting'} detail={`${confirmed} confirmed · ${pending} pending`} />
            </div>
            <BrowserTabView crawlId={crawl.id} preview={live?.preview ?? null} statusLabel={live?.finished ? 'Captured' : 'Live capture'} message={collectorConnected ? 'Waiting for the first captured screen…' : 'Waiting for the browser extension to connect…'} />
            {live?.current && (
              <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-[#E7D29B] bg-[#FFFBEB] px-3 py-2">
                <span className="min-w-0 flex-1 text-[11.5px] text-[#6B4A16]">
                  The preview is read-only. The collector will enter Test Data and continue until it reaches “{live.current.text}”.
                </span>
                <button type="button" onClick={() => void retry()} disabled={retrying} className="h-[32px] rounded-[9px] bg-[#B71920] px-3 text-[11.5px] font-bold text-white disabled:opacity-50">
                  {retrying ? 'Retrying setup…' : 'Retry setup & continue'}
                </button>
                {retryError && <span className="w-full text-[11px] text-[#A3231C]">{retryError}</span>}
              </div>
            )}
            <div className="rounded-[10px] border border-[#E8EAEE] bg-[#FCFCFD] px-3 py-2">
              <p className="m-0 font-semibold text-[#374151]">{live?.phase ?? 'Preparing the browser collector…'}</p>
              {live?.current_url && <code className="mt-1 block truncate text-[11px] text-[#6B7280]" title={live.current_url}>{live.current_url}</code>}
            </div>
          </div>
        ) : deviceOwned ? (
          <div className="flex min-h-[180px] flex-col items-center justify-center rounded-[12px] border border-[#D7E1F5] bg-[#F5F8FF] px-6 text-center">
            <strong className="text-[14px] text-[#1F3B70]">The browser is running locally on this device</strong>
            <p className="mb-0 mt-2 max-w-[560px] text-[12.5px] leading-5 text-[#52627A]">
              Studio receives step progress and final evidence, but it does not stream the local browser screen. Screenshots and other available evidence appear after the device runner finishes.
            </p>
          </div>
        ) : (
          <div className="flex aspect-[16/9] items-center justify-center overflow-hidden rounded-[12px] border border-[#E8EAEE] bg-[#F4F5F7]">
            {frame ? <img src={frame} alt="The page the walk is on" className="h-full w-full object-contain" /> : <span className="text-[12.5px] text-[#6B7280]">Waiting for the first frame…</span>}
          </div>
        )}
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
                {actionText(item.kind, item.text)}
                {step?.error && <span className="block text-[11.5px] text-[#A3231C]">{step.error}</span>}
              </span>
              {now ? <Chip tone="info">{browserOwned ? (live?.collector_state === 'waiting' ? 'Waiting for page' : 'Running now') : deviceOwned ? 'Running locally' : 'Running'}</Chip> : status ? <Chip tone={status.tone}>{status.label}</Chip> : <Chip tone="idle">Pending</Chip>}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

const CollectorMilestone: React.FC<{ label: string; state: 'waiting' | 'active' | 'done'; detail: string }> = ({ label, state, detail }) => (
  <div className={`rounded-[9px] border px-2.5 py-2 ${state === 'done' ? 'border-[#D5E9DD] bg-[#F1F8F4]' : state === 'active' ? 'border-[#F6D4D5] bg-[#FFF7F7]' : 'border-[#E8EAEE] bg-white'}`}>
    <span className="block text-[10px] font-bold uppercase tracking-[0.08em] text-[#6B7280]">{state === 'done' ? '✓ ' : state === 'active' ? '● ' : '○ '}{label}</span>
    <span className="mt-0.5 block font-semibold text-[#374151]">{detail}</span>
  </div>
)

const BrowserTabView: React.FC<{ crawlId: number; preview: BrowserTabPreview | null; message?: string; statusLabel?: string }> = ({ crawlId, preview, message, statusLabel = 'Captured' }) => {
  // Both views come from the same collector event: the screenshot is the
  // actual browser pixels and the map is its value-free locator annotation.
  const [mode, setMode] = useState<'page' | 'map'>('map')
  const screenshot = useAuthedImage(preview?.screenshot ? () => knowledgeBaseService.crawlImage(crawlId, preview.screenshot as string) : null, preview?.screenshot ? `${crawlId}:${preview.screenshot}` : null)
  useEffect(() => { setMode(preview?.screenshot ? 'page' : 'map') }, [preview?.screenshot, preview?.page_id])
  const width = Math.max(1, preview?.viewport.width ?? 1366)
  const height = Math.max(1, preview?.viewport.height ?? 768)
  return (
    <div className="overflow-hidden rounded-[12px] border border-[#D9DCE2] bg-white shadow-sm" aria-label="Live browser tab preview">
      <div className="flex h-9 items-center gap-2 border-b border-[#E8EAEE] bg-[#F4F5F7] px-3">
        <span className="h-2.5 w-2.5 rounded-full bg-[#F3A9AC]" /><span className="h-2.5 w-2.5 rounded-full bg-[#F0D18A]" /><span className="h-2.5 w-2.5 rounded-full bg-[#9BD2AF]" />
        <span className="ml-2 min-w-0 flex-1 truncate rounded-md bg-white px-2 py-1 text-[10.5px] text-[#6B7280]">{preview?.url ?? 'Browser tab'}</span>
        {preview?.screenshot && <button type="button" onClick={() => setMode(value => value === 'page' ? 'map' : 'page')} className="text-[10px] font-bold uppercase tracking-[0.08em] text-[#B71920]">{mode === 'page' ? 'Show annotations' : 'Show screen'}</button>}
        <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-[#1F7A4D]">{statusLabel}</span>
      </div>
      <div className="relative aspect-[16/9] max-h-[360px] overflow-hidden bg-[#FCFCFD]">
        {!preview ? (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-[12.5px] text-[#6B7280]">{message ?? 'Waiting for a captured screen…'}</div>
        ) : mode === 'page' && screenshot ? (
          <>
            <img src={screenshot} alt={`Captured browser screen: ${preview.title || preview.name || ''}`} className="h-full w-full object-contain bg-white" />
            <span className="pointer-events-none absolute bottom-2 right-2 rounded-md bg-[#111827]/80 px-2 py-1 text-[9.5px] font-bold uppercase tracking-[0.08em] text-white">Captured screen</span>
          </>
        ) : (
          <>
            <div className="absolute left-3 top-2 z-10 max-w-[70%] truncate rounded-md bg-white/90 px-2 py-1 text-[11px] font-semibold text-[#374151] shadow-sm">{preview.title || preview.name || 'Captured page'}</div>
            {preview.elements.map((element, index) => {
              const b = element.bounds
              const control = element.kind !== 'text'
              return (
                <div key={`${index}-${element.name ?? element.role ?? ''}`} title={`${element.role ?? 'element'}${element.name ? ` · ${element.name}` : ''}`}
                  className={`absolute overflow-hidden rounded-[3px] border px-1 text-[8px] leading-tight ${control ? 'border-[#C6CBD4] bg-white text-[#374151] shadow-sm' : 'border-transparent bg-transparent font-semibold text-[#1F2937]'}`}
                  style={{ left: `${Math.min(99, (b.x / width) * 100)}%`, top: `${Math.min(99, (b.y / height) * 100)}%`, width: `${Math.max(1.2, Math.min(100, (b.width / width) * 100))}%`, height: `${Math.max(1.4, Math.min(100, (b.height / height) * 100))}%` }}>
                  <span className="block truncate">{element.name || element.role || ''}</span>
                </div>
              )
            })}
          </>
        )}
      </div>
      <div className="border-t border-[#E8EAEE] bg-[#FCFCFD] px-3 py-1.5 text-[10.5px] text-[#6B7280]">{mode === 'page' ? 'Captured from this exact collector step · entered values are masked' : 'Locator annotations from the same captured step · typed values and passwords are never included'}</div>
    </div>
  )
}

const FailedBrowserPreview: React.FC<{
  crawl: JourneyCrawl
  plan: CrawlPlan | null
  busy: boolean
  onRecapture: (step: number) => Promise<void>
}> = ({ crawl, plan, busy, onRecapture }) => {
  const [live, setLive] = useState<WalkLive | null>(null)
  useEffect(() => { void knowledgeBaseService.crawlLive(crawl.id).then(setLive).catch(() => undefined) }, [crawl.id])
  const steps = new Map((live?.steps ?? []).map(step => [step.order, step]))
  const items = plan?.items ?? []
  const failedOrder = (live?.steps ?? []).find(step => step.status === 'error')?.order
    ?? (live?.action_index != null ? Number(live.action_index) + 1 : null)
  return (
    <div className="flex flex-col gap-3 px-5 pb-5">
      <div className="rounded-[12px] border border-[#F1C7C9] bg-[#FFF7F7] p-3 text-[12px] text-[#7A0B0D]">
        <strong className="block">Collector failed on the screen shown</strong>
        <p className="mb-0 mt-1">{crawl.error || live?.phase || 'The collector stopped.'}</p>
        {live?.current_url && <code className="mt-2 block break-all text-[10.5px] text-[#6B7280]">{live.current_url}</code>}
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.45fr)_minmax(360px,1fr)]">
        <BrowserTabView crawlId={crawl.id} preview={live?.preview ?? null} statusLabel="Failure screen" message="No screen was captured before the collector stopped." />
        <ol className="m-0 flex max-h-[430px] list-none flex-col overflow-auto rounded-[12px] border border-[#E8EAEE] p-0">
          {items.length === 0 && <li className="px-3 py-4 text-[12px] text-[#6B7280]">No journey steps were received before the collector stopped.</li>}
          {items.map((item, index) => {
            const order = index + 1
            const step = steps.get(order)
            const isFailed = step?.status === 'error' || (!step && failedOrder === order)
            const status = isFailed ? STEP_STATUS.error : step ? STEP_STATUS[step.status] : null
            return (
              <li key={order} className={`flex items-start gap-2 border-b border-[#F1F2F4] px-3 py-2 text-[12px] ${isFailed ? 'bg-[#FFF7F7]' : ''}`}>
                <span className={`flex-shrink-0 text-right font-semibold text-[#6B7280] ${item.setup ? 'w-10 text-[10.5px] uppercase' : 'w-5'}`}>{stepNo(item, order)}</span>
                <span className="min-w-0 flex-1">
                  {actionText(item.kind, item.text)}
                  {isFailed && <span className="block text-[11px] text-[#A3231C]">{step?.error || crawl.error}</span>}
                  {isFailed && (
                    <button type="button" onClick={() => void onRecapture(order)} disabled={busy}
                      className="mt-1.5 rounded-full border border-[#B71920] bg-white px-2.5 py-0.5 text-[11.5px] font-semibold text-[#B71920] hover:bg-[#FFF5F5] disabled:opacity-50">
                      {busy ? 'Opening…' : 'Recapture & select'}
                    </button>
                  )}
                </span>
                {status ? <Chip tone={status.tone}>{status.label}</Chip> : <Chip tone="idle">Not run</Chip>}
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}

const FailedDeviceRun: React.FC<{ crawl: JourneyCrawl; plan: CrawlPlan | null }> = ({ crawl, plan }) => {
  const [live, setLive] = useState<WalkLive | null>(null)
  useEffect(() => { void knowledgeBaseService.crawlLive(crawl.id).then(setLive).catch(() => undefined) }, [crawl.id])
  const steps = new Map((live?.steps ?? []).map(step => [step.order, step]))
  const items = plan?.items ?? []
  return (
    <div className="grid gap-3 px-5 pb-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,1fr)]">
      <div className="rounded-[12px] border border-[#F1C7C9] bg-[#FFF7F7] p-4 text-[12.5px] text-[#7A0B0D]">
        <strong className="block text-[14px]">The device run stopped</strong>
        <p className="mb-0 mt-1">{crawl.error || live?.phase || 'The local runner did not complete the journey.'}</p>
        <p className="mb-0 mt-3 text-[#6B4A4C]">A live browser recording is not expected for device execution. Completed step progress is kept here so the failed step remains visible.</p>
      </div>
      <ol className="m-0 flex max-h-[360px] list-none flex-col overflow-auto rounded-[12px] border border-[#E8EAEE] p-0">
        {items.length === 0 && <li className="px-3 py-4 text-[12px] text-[#6B7280]">No journey steps were received before the device run stopped.</li>}
        {items.map((item, index) => {
          const order = index + 1
          const step = steps.get(order)
          const status = step ? STEP_STATUS[step.status] : null
          return (
            <li key={order} className="flex items-start gap-2 border-b border-[#F1F2F4] px-3 py-2 text-[12px]">
              <span className={`flex-shrink-0 text-right font-semibold text-[#6B7280] ${item.setup ? 'w-10 text-[10.5px] uppercase' : 'w-5'}`}>{stepNo(item, order)}</span>
              <span className="min-w-0 flex-1">{actionText(item.kind, item.text)}{step?.error && <span className="block text-[11px] text-[#A3231C]">{step.error}</span>}</span>
              {status ? <Chip tone={status.tone}>{status.label}</Chip> : <Chip tone="idle">Not run</Chip>}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

const BrowserResultSummary: React.FC<{
  crawlId: number
  capture: CaptureInfo
  steps: CrawlStep[]
  items: CrawlPlanItem[]
  continuing: boolean
  recapturing: boolean
  recaptureStep: number | null
  onContinue: () => Promise<void>
  onRecapture: (step: number) => Promise<void>
}> = ({ crawlId, capture, steps, items, continuing, recapturing, recaptureStep, onContinue, onRecapture }) => {
  const [selected, setSelected] = useState(() => Math.max(0, capture.pages.length - 1))
  useEffect(() => { setSelected(Math.max(0, capture.pages.length - 1)) }, [capture.pages.length])
  const confirmed = steps.filter(step => ['done', 'auto'].includes(step.status)).length
  const inherited = steps.filter(step => Boolean(step.inherited_from_crawl_id)).length
  const unresolved = steps.filter(step => ['not_found', 'not_reached', 'blocked', 'off_path', 'error'].includes(step.status)).length
  const page = capture.pages[selected] ?? capture.pages[0]
  const next = steps.find(step => ['not_reached', 'blocked', 'off_path'].includes(step.status))
  const nextItem = next ? items[next.order - 1] : undefined
  return (
    <div className="flex flex-col gap-3 px-5 pb-4">
      <div className={`rounded-[12px] border p-3 ${unresolved ? 'border-[#F1C7C9] bg-[#FFF7F7]' : 'border-[#D5E9DD] bg-[#F1F8F4]'}`}>
        <div className="flex flex-wrap items-center gap-2">
          <strong className={unresolved ? 'text-[#9E1C22]' : 'text-[#17653F]'}>{unresolved ? 'Crawl finished — journey incomplete' : 'Crawl finished — every journey step confirmed'}</strong>
          <Chip tone={unresolved ? 'bad' : 'good'}>{confirmed} confirmed</Chip>
          {unresolved > 0 && <Chip tone="bad">{unresolved} unresolved</Chip>}
          {inherited > 0 && <Chip tone="info">{inherited} retained from previous crawl</Chip>}
          <Chip tone="idle">{capture.pages.length} screen{capture.pages.length === 1 ? '' : 's'} captured</Chip>
        </div>
        <p className="mb-0 mt-1 text-[11.5px] text-[#4B5563]">Nothing is still running. “Finished” means the collector stopped; unresolved steps below were not confirmed. During recapture, previously confirmed steps after the selected step are retained and clearly marked because that shortened replay does not run them again.</p>
      </div>
      {next && (
        <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-[#E7D29B] bg-[#FFFBEB] p-3">
          <div className="min-w-0 flex-1">
            <strong className="block text-[12.5px] text-[#7A4A00]">Action required to reach the next screen</strong>
            <span className="text-[11.5px] text-[#6B4A16]">Run the completed setup steps with Test Data, then capture the next screen: “{nextItem?.text || next.reason || `journey step ${next.step_number}`}”. The extension fills only the values required by this crawl and never returns them in the capture.</span>
          </div>
          <button type="button" onClick={() => void onContinue()} disabled={continuing} className="h-[34px] rounded-[10px] bg-[#B71920] px-4 text-[12.5px] font-bold text-white disabled:opacity-50">{continuing ? 'Running setup…' : 'Run setup & crawl next screen'}</button>
        </div>
      )}
      {capture.pages.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(300px,1fr)]">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5" aria-label="Captured screens">
              <span className="mr-1 text-[10.5px] font-bold uppercase tracking-[0.08em] text-[#6B7280]">Screens</span>
              {capture.pages.map((item, index) => (
                <button key={`${item.page_id}-${index}`} type="button" onClick={() => setSelected(index)} title={item.url ?? undefined}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${selected === index ? 'border-[#B71920] bg-[#FFF7F7] text-[#9E1C22]' : 'border-[#E8EAEE] bg-white text-[#4B5563]'}`}>
                  {index + 1}. {item.name || item.page_id}
                </button>
              ))}
            </div>
            <BrowserTabView crawlId={crawlId} preview={page?.preview ?? null} statusLabel="Saved capture" message="This crawl was made with an older extension, so no visual tab preview was saved." />
          </div>
          <ol className="m-0 flex max-h-[430px] list-none flex-col overflow-auto rounded-[12px] border border-[#E8EAEE] p-0" aria-label="Journey step status">
            {steps.map(step => {
              const item = items[step.order - 1]
              const status = STEP_STATUS[step.status]
              const retained = step.inherited_from_crawl_id
              const canRecapture = ['not_found', 'not_reached', 'blocked', 'off_path', 'error'].includes(step.status)
              return (
                <li key={step.order} className={`flex items-start gap-2 border-b border-[#F1F2F4] px-3 py-2 text-[12px] ${['not_reached', 'blocked', 'off_path'].includes(step.status) ? 'bg-[#FFFBEB]' : ''}`}>
                  <span className={`flex-shrink-0 text-right font-semibold text-[#6B7280] ${item?.setup ? 'w-10 text-[10.5px] uppercase' : 'w-5'}`}>{stepNo(item, step.order)}</span>
                  <span className="min-w-0 flex-1">
                    {actionText(step.kind, item?.text || step.reason)}
                    {(step.error || step.reason) && <span className="block text-[10.5px] text-[#8A5000]">{step.error ?? step.reason}</span>}
                    {retained && <span className="block text-[10.5px] text-[#4B5563]">Confirmed earlier in crawl #{retained}; not rerun in this recapture.</span>}
                    {canRecapture && (
                      <button type="button" onClick={() => void onRecapture(step.order)} disabled={recapturing}
                        className="mt-1.5 rounded-full border border-[#B71920] bg-white px-2.5 py-0.5 text-[11px] font-semibold text-[#B71920] hover:bg-[#FFF5F5] disabled:opacity-50">
                        {recapturing && recaptureStep === step.order ? 'Opening recapture…' : 'Recapture & select'}
                      </button>
                    )}
                  </span>
                  <Chip tone={retained ? 'good' : status.tone}>{retained ? 'Done previously' : status.label}</Chip>
                </li>
              )
            })}
          </ol>
        </div>
      )}
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
          {actionText(step.kind, text)}
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
// matches only that element) and pick and name anything else. "Send to
// Knowledge Base" hands it to this app (CaptureReceive) and it waits in the
// inbox below, shown as a flow to edit before it is imported as a walk;
// "Download zip" is the fallback, uploaded here against the journey.

const CaptureUpload: React.FC<{
  appKey: string
  journeyId: string
  application: { id: number; environment: string; base_url: string }
  canExecute: boolean
  openInbox?: number | null
  onImported: (id: number) => void
  onJourneyCreated?: (journeyId: string, title: string) => void
}> = ({ appKey, journeyId, application, canExecute, openInbox, onImported, onJourneyCreated }) => {
  const [code, setCode] = useState<string | null>(null)
  const [codeError, setCodeError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bookmarklet = useRef<HTMLAnchorElement | null>(null)
  useEffect(() => {
    // The tool's Send to Knowledge Base opens this app's receiving page.
    const receiver = `${window.location.origin}/automation/knowledge-base/capture-receive`
    knowledgeBaseService.captureTool().then(js => setCode(js.split('__KB_RECEIVER__').join(receiver))).catch(err => setCodeError(errorText(err)))
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
      <CaptureInbox appKey={appKey} journeyId={journeyId} application={application} canExecute={canExecute}
        openId={openInbox} onImported={onImported} onJourneyCreated={onJourneyCreated} />
      <div className="grid gap-4 border-t border-[#F1F2F4] pt-3 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#6B7280]">1 · Capture in your browser</span>
          <ol className="m-0 flex list-decimal flex-col gap-1 pl-5">
            <li>Open {application.base_url} ({application.environment}) in your own Edge or Chrome and sign in.</li>
            <li>Start the tool: drag <a ref={bookmarklet} href="#capture-tool" onClick={e => e.preventDefault()} draggable
              className="rounded-[6px] bg-[#B71920] px-1.5 py-0.5 font-bold text-white no-underline" title="Drag me to the bookmarks bar, then click the bookmark on the application's page">KB capture</a> to your bookmarks bar and click it there, or paste the copied code into the DevTools Console.</li>
            <li>On every page of the journey — and every dialog, open — press <strong>Capture page</strong>. Use <strong>Pick element</strong> to name anything the journey needs that is not a button or field.</li>
            <li>Press <strong>Send to Knowledge Base</strong>: this app opens in a new tab; press <strong>Save to inbox</strong> there. It appears in the inbox below as a flow to review. (Or <strong>Download zip</strong> and upload it on the right.) Nothing you type is recorded.</li>
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
          <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#6B7280]">Or upload a downloaded zip against this journey</span>
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

const BrowserCollectorSetup: React.FC<{
  appKey: string
  journeyId: string
  application: { id: number; environment: string; base_url: string }
  profileId: string
  profiles: CoverageProfile[]
  profileWarnings: string[]
  onProfileChange: (profileId: string) => void
  canExecute: boolean
  active: boolean
  onStarted: (id: number) => void
}> = ({ appKey, journeyId, application, profileId, profiles, profileWarnings, onProfileChange, canExecute, active, onStarted }) => {
  const [pairing, setPairing] = useState<string | null>(null)
  const [pendingCrawlId, setPendingCrawlId] = useState<number | null>(null)
  const [expires, setExpires] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [waitSeconds, setWaitSeconds] = useState(20)
  const [retryCount, setRetryCount] = useState(2)
  useEffect(() => {
    if (!pairing || pendingCrawlId == null) return
    let stopped = false
    const checkConnection = async () => {
      try {
        const live = await knowledgeBaseService.crawlLive(pendingCrawlId)
        if (!stopped && live.connected_at) {
          setPairing(null)
          setExpires(null)
          setPendingCrawlId(null)
          setError(null)
          setMessage('Collector connected. This browser is paired, and future crawls can start automatically.')
        }
      } catch { /* the ordinary crawl panel reports server errors */ }
    }
    void checkConnection()
    const timer = window.setInterval(() => void checkConnection(), 1250)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [pairing, pendingCrawlId])
  const create = async () => {
    setBusy('create'); setError(null); setMessage(null)
    try {
      const made = await knowledgeBaseService.startBrowserCrawl(appKey, {
        journey_id: journeyId, application_id: application.id, profile_id: profileId || null,
        environment: application.environment, max_pages: 20,
        wait_seconds: waitSeconds, retry_count: retryCount
      })
      setExpires(made.expires_in_minutes); setPendingCrawlId(made.crawl.id); onStarted(made.crawl.id)
      if (await startInstalledCollector(made.pairing)) {
        setPairing(null)
        setPendingCrawlId(null)
        setMessage('The installed browser collector started automatically. You can follow progress below.')
      } else {
        setPairing(made.pairing)
        setMessage('Waiting for the collector. Paste this one-time code into the extension; it disappears here as soon as the collector connects.')
      }
    } catch (err) { setError(errorText(err)) } finally { setBusy(null) }
  }
  const copy = async () => {
    if (!pairing) return
    try { await navigator.clipboard.writeText(pairing); setError(null); setMessage('Pairing code copied.') }
    catch { setError('The browser blocked clipboard access. Select and copy the code below.') }
  }
  const autoPair = async () => {
    if (!pairing) return
    setBusy('pair'); setError(null); setMessage('Connecting to the installed collector…')
    try {
      if (await startInstalledCollector(pairing)) {
        setPairing(null)
        setExpires(null)
        setPendingCrawlId(null)
        setMessage('Collector paired and the browser crawl started. You can follow progress below.')
        return
      }
      const installedVersion = await installedCollectorVersion()
      if (!installedVersion) {
        setError(`Collector not detected in this page. Reload collector ${COLLECTOR_VERSION}, then refresh this Automation Studio tab once and select Auto pair again.`)
      } else if (installedVersion !== COLLECTOR_VERSION) {
        setError(`Collector ${installedVersion} is installed, but this page requires ${COLLECTOR_VERSION}. Download and reload the collector, then try again.`)
      } else {
        setError('The collector was detected but could not accept this pairing code. Reload the extension and select Auto pair again, or use Copy code.')
      }
    } catch (err) { setError(errorText(err)) } finally { setBusy(null) }
  }
  const download = async (engine: 'chromium' | 'firefox' | 'safari') => {
    setBusy(engine); setError(null)
    try {
      const url = await knowledgeBaseService.downloadBrowserCollector(engine)
      const a = document.createElement('a'); a.href = url; a.download = `automation-studio-collector-${engine}.zip`; a.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 10000)
      setMessage(engine === 'firefox' ? 'Firefox package downloaded. Reload the extension, then refresh this Studio tab once.' : engine === 'safari' ? 'Safari WebExtension source downloaded; package it with Xcode on a Mac.' : 'Chromium package downloaded and bound to this Studio address. Reload the extension, then refresh this Studio tab once.')
    } catch (err) { setError(errorText(err)) } finally { setBusy(null) }
  }
  return (
    <div className="grid gap-4 rounded-[12px] border border-[#E8EAEE] p-4 text-[12.5px] text-[#374151] lg:grid-cols-2">
      <div className="flex flex-col gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#6B7280]">1 · Install once in your browser</span>
        <p className="m-0">The same collector works in the browser you already use and keeps its signed-in session. It requires no browser or Playwright installation on the server.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={PLAIN} disabled={busy !== null} onClick={() => void download('chromium')}>{busy === 'chromium' ? 'Downloading…' : 'Edge, Chrome, Brave, Opera'}</button>
          <button type="button" className={PLAIN} disabled={busy !== null} onClick={() => void download('firefox')}>{busy === 'firefox' ? 'Downloading…' : 'Firefox'}</button>
          <button type="button" className={PLAIN} disabled={busy !== null} onClick={() => void download('safari')}>{busy === 'safari' ? 'Downloading…' : 'Safari source'}</button>
        </div>
        <p className="m-0 text-[11.5px] text-[#6B7280]">Extract the zip and load it as a temporary or unpacked extension. Store-signed packages can use the same files later. Safari requires Apple’s WebExtension packaging step, but the collector protocol is browser-neutral.</p>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#6B7280]">2 · Start safe crawl</span>
        <p className="m-0">After the one-time installation and pairing, this starts the collector automatically. It follows same-site links only and captures locators that match exactly one element.</p>
        <label className={LABEL}>Test data
          <select aria-label="Browser crawl test data profile" value={profileId} onChange={e => onProfileChange(e.target.value)} className={`${SELECT} max-w-[320px]`}>
            {profiles.map(profile => {
              const missing = profile.cells[application.environment]?.missing?.length ?? 0
              return <option key={profile.profile_id} value={profile.profile_id}>{profile.name}{missing ? ` · ${missing} value${missing === 1 ? '' : 's'} missing` : ''}</option>
            })}
            {!profiles.length && profileId && <option value={profileId}>{profileId}</option>}
          </select>
        </label>
        {profileWarnings.map(warning => <Note key={warning} tone="warn">{warning}</Note>)}
        <div className="flex flex-wrap gap-3">
          <label className={LABEL}>Wait for each screen
            <select value={waitSeconds} onChange={e => setWaitSeconds(Number(e.target.value))} className={SELECT}>
              {[5, 10, 20, 30, 60, 90, 120].map(value => <option key={value} value={value}>{value} seconds</option>)}
            </select>
          </label>
          <label className={LABEL}>Retries
            <select value={retryCount} onChange={e => setRetryCount(Number(e.target.value))} className={SELECT}>
              {[0, 1, 2, 3, 5, 10].map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
        {!pairing ? (
          <button type="button" onClick={() => void create()} disabled={!canExecute || !journeyId || active || busy !== null}
            className="h-[34px] w-fit rounded-[10px] bg-[#B71920] px-4 text-[13px] font-bold text-white disabled:opacity-50">
            {busy === 'create' ? 'Starting…' : 'Start browser crawl'}
          </button>
        ) : (
          <>
            <textarea readOnly value={pairing} aria-label="Browser collector pairing code" rows={3}
              className="w-full resize-none rounded-[9px] border border-[#E8EAEE] p-2 font-mono text-[10.5px]" />
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={PLAIN} disabled={busy !== null} onClick={() => void autoPair()}>
                {busy === 'pair' ? 'Pairing…' : 'Auto pair'}
              </button>
              <button type="button" className={PLAIN} disabled={busy !== null} onClick={() => void copy()}>Copy code</button>
              <span className="text-[11.5px] text-[#6B7280]">Expires in {expires} minutes and works for this crawl only.</span>
            </div>
          </>
        )}
        {message && <Note>{message}</Note>}
        {error && <Note tone="warn">{error}</Note>}
      </div>
    </div>
  )
}

type BulkCrawlStatus = 'queued' | 'starting' | 'waiting_pairing' | 'running' | 'completed' | 'failed'
type BulkCrawlItem = {
  journeyId: string
  title: string
  profileId: string
  status: BulkCrawlStatus
  crawlId?: number
  error?: string
  pollFailures?: number
  kbStatus?: 'creating' | 'created' | 'failed'
}
type BulkCrawlQueue = { active: boolean; items: BulkCrawlItem[] }

const BulkBrowserCrawlSetup: React.FC<{
  appKey: string
  application: { id: number; environment: string }
  journeys: { id: string; title: string }[]
  profiles: CoverageProfile[]
  canExecute: boolean
  canApprove: boolean
  anotherRunActive: boolean
  onSelectRun: (id: number) => void
  onRunsChanged: () => void
  onAutomationReady: () => void
  onProposed: () => void
}> = ({ appKey, application, journeys, profiles, canExecute, canApprove, anotherRunActive, onSelectRun, onRunsChanged, onAutomationReady, onProposed }) => {
  const storageKey = `automation-studio:bulk-browser:${appKey}:${application.environment}`
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [profileByJourney, setProfileByJourney] = useState<Record<string, string>>({})
  const [queue, setQueue] = useState<BulkCrawlQueue>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null') as BulkCrawlQueue | null
      return saved?.items ? { ...saved, items: saved.items.map(item => item.status === 'starting' && !item.crawlId ? { ...item, status: 'queued' } : item) } : { active: false, items: [] }
    } catch { return { active: false, items: [] } }
  })
  const [error, setError] = useState<string | null>(null)
  const [collectorVersion, setCollectorVersion] = useState<string | null>(null)
  const [downloadBusy, setDownloadBusy] = useState<string | null>(null)
  const [manualPairing, setManualPairing] = useState<{ crawlId: number; journeyId: string; code: string; expires: number } | null>(null)
  const [kbSelected, setKbSelected] = useState<Set<number>>(new Set())
  const queueRef = useRef(queue)
  const workerRef = useRef(false)
  const probeCollector = useCallback(() => installedCollectorVersion().then(setCollectorVersion), [])
  useEffect(() => { void probeCollector() }, [probeCollector])
  useEffect(() => {
    queueRef.current = queue
    localStorage.setItem(storageKey, JSON.stringify(queue))
  }, [queue, storageKey])
  useEffect(() => {
    if (!profiles.length) return
    setProfileByJourney(previous => {
      const next = { ...previous }
      for (const journey of journeys) {
        if (next[journey.id]) continue
        const suggested = profiles.find(profile => profile.used_by?.includes(journey.id)) ?? profiles[0]
        next[journey.id] = suggested?.profile_id ?? ''
      }
      return next
    })
  }, [journeys, profiles])
  const patchItem = useCallback((journeyId: string, patch: Partial<BulkCrawlItem>) => {
    setQueue(previous => {
      const next = { ...previous, items: previous.items.map(item => item.journeyId === journeyId ? { ...item, ...patch } : item) }
      queueRef.current = next
      return next
    })
  }, [])
  const finishQueue = useCallback(() => setQueue(previous => {
    const next = { ...previous, active: false }
    queueRef.current = next
    return next
  }), [])
  useEffect(() => {
    if (!queue.active || workerRef.current) return
    let cancelled = false
    workerRef.current = true
    const wait = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms))
    const run = async () => {
      while (!cancelled) {
        const current = queueRef.current
        const inProgress = current.items.find(item => ['running', 'starting', 'waiting_pairing'].includes(item.status))
        if ((inProgress?.status === 'running' || inProgress?.status === 'waiting_pairing') && inProgress.crawlId) {
          try {
            const crawl = await knowledgeBaseService.crawl(inProgress.crawlId)
            if (crawl.status === 'completed' || crawl.status === 'failed') {
              patchItem(inProgress.journeyId, { status: crawl.status, error: crawl.error ?? undefined, pollFailures: 0 })
              onRunsChanged()
              continue
            }
            if (inProgress.status === 'waiting_pairing') {
              const live = await knowledgeBaseService.crawlLive(inProgress.crawlId)
              if (live.connected_at) {
                patchItem(inProgress.journeyId, { status: 'running', error: undefined })
                setManualPairing(value => value?.crawlId === inProgress.crawlId ? null : value)
                continue
              }
            }
            if (inProgress.pollFailures) patchItem(inProgress.journeyId, { pollFailures: 0, error: undefined })
          } catch (err) {
            const failures = (inProgress.pollFailures ?? 0) + 1
            if (failures >= 8) patchItem(inProgress.journeyId, { status: 'failed', pollFailures: failures, error: `Studio could not read this crawl after ${failures} attempts: ${errorText(err)}` })
            else patchItem(inProgress.journeyId, { pollFailures: failures })
            await wait(1500)
            continue
          }
          await wait(1300)
          continue
        }
        if (inProgress?.status === 'starting') { await wait(250); continue }
        const next = current.items.find(item => item.status === 'queued')
        if (!next) { finishQueue(); break }
        patchItem(next.journeyId, { status: 'starting', error: undefined })
        try {
          const made = await knowledgeBaseService.startBrowserCrawl(appKey, {
            journey_id: next.journeyId,
            application_id: application.id,
            profile_id: next.profileId || null,
            environment: application.environment,
            max_pages: 20,
            wait_seconds: 20,
            retry_count: 2,
          })
          patchItem(next.journeyId, { status: 'running', crawlId: made.crawl.id })
          onSelectRun(made.crawl.id)
          onRunsChanged()
          if (!await startInstalledCollector(made.pairing)) {
            patchItem(next.journeyId, { status: 'waiting_pairing', error: undefined })
            setManualPairing({ crawlId: made.crawl.id, journeyId: next.journeyId, code: made.pairing, expires: made.expires_in_minutes })
          }
        } catch (err) {
          patchItem(next.journeyId, { status: 'failed', error: errorText(err) })
        }
      }
    }
    void run().finally(() => { workerRef.current = false })
    return () => { cancelled = true; workerRef.current = false }
  }, [queue.active, appKey, application.id, application.environment, finishQueue, onRunsChanged, onSelectRun, patchItem])

  const allSelected = journeys.length > 0 && selected.size === journeys.length
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(journeys.map(journey => journey.id)))
  const startQueue = async () => {
    setError(null)
    const items = journeys.filter(journey => selected.has(journey.id)).map(journey => ({
      journeyId: journey.id,
      title: journey.title,
      profileId: profileByJourney[journey.id] || '',
      status: 'queued' as const,
    }))
    if (!items.length) { setError('Select at least one journey.'); return }
    const invalid = items.filter(item => {
      const profile = profiles.find(value => value.profile_id === item.profileId)
      return !profile || (profile.cells[application.environment]?.missing?.length ?? 0) > 0
    })
    if (invalid.length) {
      setError(`Choose complete Test Data for: ${invalid.map(item => item.title).join(', ')}.`)
      return
    }
    setKbSelected(new Set())
    const nextQueue = { active: true, items }
    queueRef.current = nextQueue
    setQueue(nextQueue)
  }
  const downloadCollector = async (engine: 'chromium' | 'firefox' | 'safari') => {
    setDownloadBusy(engine); setError(null)
    try {
      const url = await knowledgeBaseService.downloadBrowserCollector(engine)
      const link = document.createElement('a'); link.href = url; link.download = `automation-studio-collector-${engine}.zip`; link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 10000)
    } catch (err) { setError(errorText(err)) }
    finally { setDownloadBusy(null) }
  }
  const pairWaiting = async () => {
    if (!manualPairing) return
    setError(null)
    if (await startInstalledCollector(manualPairing.code)) {
      patchItem(manualPairing.journeyId, { status: 'running', error: undefined })
      setManualPairing(null); void probeCollector()
    } else setError(`Collector ${COLLECTOR_VERSION} did not accept the crawl. Reload the extension, then select Auto pair again or copy the code into it.`)
  }
  const copyPairing = async () => {
    if (!manualPairing) return
    try { await navigator.clipboard.writeText(manualPairing.code); setError(null) }
    catch { setError('The browser blocked clipboard access. Select and copy the pairing code.') }
  }
  const completed = queue.items.filter(item => item.status === 'completed' && item.crawlId)
  const allCompletedSelected = completed.length > 0 && completed.every(item => kbSelected.has(item.crawlId as number))
  const createSelected = async () => {
    setError(null)
    for (const item of completed.filter(row => kbSelected.has(row.crawlId as number))) {
      if (!item.crawlId || item.kbStatus === 'created') continue
      patchItem(item.journeyId, { kbStatus: 'creating' })
      try {
        const made = await knowledgeBaseService.generateFlow(item.crawlId)
        if (canApprove) await knowledgeBaseService.approve(made.change_set.id, `Published from bulk browser crawl #${item.crawlId}`)
        patchItem(item.journeyId, { kbStatus: 'created' })
      } catch (err) {
        patchItem(item.journeyId, { kbStatus: 'failed', error: errorText(err) })
      }
    }
    if (canApprove) onAutomationReady(); else onProposed()
  }
  return (
    <div className="flex flex-col gap-3 rounded-[12px] border border-[#E8EAEE] p-4 text-[12.5px]">
      <div className="grid gap-3 rounded-[10px] border border-[#E8EAEE] bg-[#FCFCFD] p-3 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <strong>1 · Install once in your browser</strong>
          <span className="text-[11.5px] text-[#6B7280]">The same collector handles single and queued journeys. Install or reload version {COLLECTOR_VERSION} once.</span>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={PLAIN} disabled={downloadBusy !== null} onClick={() => void downloadCollector('chromium')}>{downloadBusy === 'chromium' ? 'Downloading…' : 'Edge, Chrome, Brave, Opera'}</button>
            <button type="button" className={PLAIN} disabled={downloadBusy !== null} onClick={() => void downloadCollector('firefox')}>{downloadBusy === 'firefox' ? 'Downloading…' : 'Firefox'}</button>
            <button type="button" className={PLAIN} disabled={downloadBusy !== null} onClick={() => void downloadCollector('safari')}>Safari source</button>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <strong>2 · Pair if needed</strong>
          <span className={collectorVersion === COLLECTOR_VERSION ? 'text-[#136B34]' : 'text-[#8A5000]'}>{collectorVersion === COLLECTOR_VERSION ? `Collector ${collectorVersion} connected.` : collectorVersion ? `Collector ${collectorVersion} detected; reload ${COLLECTOR_VERSION}.` : 'Collector is not detected yet. The first queued crawl will provide a pairing code.'}</span>
          <button type="button" className={`${PLAIN} w-fit`} onClick={() => void probeCollector()}>Check collector</button>
          {manualPairing && <>
            <textarea readOnly value={manualPairing.code} aria-label="Queued crawl collector pairing code" rows={3} className="w-full resize-none rounded-[9px] border border-[#E8EAEE] p-2 font-mono text-[10.5px]" />
            <div className="flex flex-wrap items-center gap-2"><button type="button" className={PLAIN} onClick={() => void pairWaiting()}>Auto pair</button><button type="button" className={PLAIN} onClick={() => void copyPairing()}>Copy code</button><span className="text-[11px] text-[#6B7280]">Expires in {manualPairing.expires} minutes.</span></div>
          </>}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><strong className="block text-[14px] text-[#1F2937]">Bulk browser crawl</strong><span className="text-[11.5px] text-[#6B7280]">Journeys run one at a time. Each keeps its own Test Data, result, review and recapture history.</span></div>
        <button type="button" className={PLAIN} onClick={toggleAll}>{allSelected ? 'Clear all' : 'Select all journeys'}</button>
      </div>
      <div className="max-h-[330px] overflow-auto rounded-[10px] border border-[#E8EAEE]">
        {journeys.map(journey => {
          const checked = selected.has(journey.id)
          const profile = profiles.find(value => value.profile_id === profileByJourney[journey.id])
          const missing = profile?.cells[application.environment]?.missing?.length ?? 0
          return <div key={journey.id} className="grid items-center gap-2 border-b border-[#F1F2F4] px-3 py-2 sm:grid-cols-[24px_minmax(180px,1fr)_minmax(220px,320px)]">
            <input type="checkbox" checked={checked} onChange={() => setSelected(previous => { const next = new Set(previous); if (next.has(journey.id)) next.delete(journey.id); else next.add(journey.id); return next })} className="accent-[#B71920]" />
            <span className="min-w-0 truncate font-semibold text-[#1F2937]" title={journey.title}>{journey.title}</span>
            <select aria-label={`Test data for ${journey.title}`} value={profileByJourney[journey.id] || ''} onChange={event => setProfileByJourney(previous => ({ ...previous, [journey.id]: event.target.value }))} className={SELECT}>
              {profiles.map(value => { const gaps = value.cells[application.environment]?.missing?.length ?? 0; return <option key={value.profile_id} value={value.profile_id}>{value.name}{gaps ? ` · ${gaps} missing` : ''}</option> })}
            </select>
            {checked && missing > 0 && <span className="sm:col-start-3 text-[10.5px] text-[#A3231C]">This profile has {missing} missing value{missing === 1 ? '' : 's'}.</span>}
          </div>
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void startQueue()} disabled={!canExecute || queue.active || anotherRunActive || selected.size === 0} className="h-[34px] rounded-[10px] bg-[#B71920] px-4 font-bold text-white disabled:opacity-50">{queue.active ? 'Queue running…' : `Start ${selected.size || ''} queued crawl${selected.size === 1 ? '' : 's'}`}</button>
        {!queue.active && queue.items.length > 0 && <button type="button" className={PLAIN} onClick={() => { setQueue({ active: false, items: [] }); setKbSelected(new Set()) }}>Clear queue</button>}
        {error && <span className="text-[#A3231C]">{error}</span>}
      </div>
      {queue.items.length > 0 && <div className="overflow-hidden rounded-[10px] border border-[#E8EAEE]">
        <div className="flex flex-wrap items-center justify-between gap-2 bg-[#F8F9FB] px-3 py-2"><strong>Queue status</strong><span className="text-[#6B7280]">{queue.items.filter(item => item.status === 'completed').length} completed · {queue.items.filter(item => item.status === 'failed').length} failed · {queue.items.filter(item => ['queued', 'starting', 'waiting_pairing', 'running'].includes(item.status)).length} remaining</span></div>
        {queue.items.map((item, index) => <div key={item.journeyId} className="flex flex-wrap items-center gap-2 border-t border-[#F1F2F4] px-3 py-2">
          <span className="w-5 text-right text-[#9CA3AF]">{index + 1}</span>
          <span className="min-w-[180px] flex-1 font-semibold">{item.title}</span>
          <span className="text-[11px] text-[#6B7280]">{profiles.find(profile => profile.profile_id === item.profileId)?.name || item.profileId}</span>
          <Chip tone={item.status === 'completed' ? 'good' : item.status === 'failed' ? 'bad' : item.status === 'running' || item.status === 'starting' || item.status === 'waiting_pairing' ? 'info' : 'idle'}>{item.status === 'starting' ? 'Starting' : item.status === 'waiting_pairing' ? 'Waiting for pairing' : item.status}</Chip>
          {item.crawlId && <button type="button" className={PLAIN} onClick={() => onSelectRun(item.crawlId as number)}>Review</button>}
          {item.status === 'completed' && item.crawlId && <input aria-label={`Select ${item.title} for Automation KB`} type="checkbox" checked={kbSelected.has(item.crawlId)} onChange={() => setKbSelected(previous => { const next = new Set(previous); if (next.has(item.crawlId as number)) next.delete(item.crawlId as number); else next.add(item.crawlId as number); return next })} className="accent-[#B71920]" />}
          {item.kbStatus && <Chip tone={item.kbStatus === 'created' ? 'good' : item.kbStatus === 'failed' ? 'bad' : 'info'}>{item.kbStatus === 'created' ? 'Automation KB created' : item.kbStatus}</Chip>}
          {item.error && <span className="w-full pl-7 text-[11px] text-[#A3231C]">{item.error}</span>}
        </div>)}
        {completed.length > 0 && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#E8EAEE] bg-[#FCFCFD] px-3 py-2">
          <button type="button" className={PLAIN} onClick={() => setKbSelected(allCompletedSelected ? new Set() : new Set(completed.map(item => item.crawlId as number)))}>{allCompletedSelected ? 'Clear completed' : 'Select all completed'}</button>
          <button type="button" onClick={() => void createSelected()} disabled={kbSelected.size === 0 || queue.active} className="h-[34px] rounded-[10px] bg-[#B71920] px-4 font-bold text-white disabled:opacity-50">Create selected in Automation KB</button>
        </div>}
      </div>}
    </div>
  )
}

const JourneyCrawlStage: React.FC<{
  appKey: string
  application: { id: number; environment: string; base_url: string }
  canExecute: boolean
  canApprove?: boolean
  onProposed: () => void
  onAutomationReady: () => void
  /** Automation Studio hides a server action that this deployment cannot run. */
  serverRuntimeReady?: boolean
  initialJourneyId?: string | null
}> = ({ appKey, application, canExecute, canApprove = false, onProposed, onAutomationReady, serverRuntimeReady = true, initialJourneyId = null }) => {
  const [params] = useSearchParams()
  const [taxonomy, taxError] = useLoad(appKey, () => knowledgeBaseService.taxonomy(appKey))
  // Journeys built from a capture on this page: listed (and selected) without
  // reloading the taxonomy, which would close the capture being reviewed.
  const [builtJourneys, setBuiltJourneys] = useState<{ id: string; title: string }[]>([])
  const [coverage] = useLoad(appKey, () => knowledgeBaseService.testData(appKey))
  const [flowList] = useLoad(appKey, () => knowledgeBaseService.walkFlows(appKey).catch(() => [] as WalkFlow[]))
  const [caps] = useLoad('walk-capabilities', () => knowledgeBaseService.walkCapabilities().catch(() => ({ headed_available: false, blocked_environments: [] }) as WalkCapabilities))
  const journeys = useMemo(() => {
    if (!taxonomy) return []
    const byId = new Map(taxonomy.nodes.map(n => [n.id, n]))
    const listed = taxonomy.authored.map(id => ({ id, title: byId.get(id)?.title ?? id }))
    return [...listed, ...builtJourneys.filter(b => !listed.some(j => j.id === b.id))]
  }, [taxonomy, builtJourneys])

  // What to do: walk a journey or a flow blueprint (?flow=<id> opens on one),
  // or record a journey by doing it (?record=1, from the Journey Map).
  const askedFlow = params.get('flow')
  const [source, setSource] = useState<'journey' | 'flow' | 'record' | 'capture' | 'browser'>(askedFlow ? 'flow' : params.get('record') ? 'record' : params.get('capture') || params.get('inbox') ? 'capture' : 'journey')
  const [bulkBrowser, setBulkBrowser] = useState(false)
  const [journeyId, setJourneyId] = useState<string>('')
  const [flowId, setFlowId] = useState<string>(askedFlow ?? '')
  const [profileId, setProfileId] = useState<string>('')
  const [stopBefore, setStopBefore] = useState<number | null>(null)
  const [allowRisky, setAllowRisky] = useState(false)
  const [headed, setHeaded] = useState(false)
  // Installed Chrome passes enterprise endpoint protection where Playwright's Chromium is blocked.
  const [browser, setBrowser] = useState<CrawlBrowser | ''>('')
  const chosenBrowser: CrawlBrowser = browser || caps?.default_browser || 'chrome'
  const [localHeaded, setLocalHeaded] = useState(false)
  // ?journey= (from the Journey Map) picks the journey to walk; else the last one.
  const askedJourney = initialJourneyId || params.get('journey')
  useEffect(() => {
    if (journeyId || !journeys.length) return
    setJourneyId(journeys.some(j => j.id === askedJourney) ? (askedJourney as string) : journeys[journeys.length - 1].id)
  }, [journeys, journeyId, askedJourney])
  useEffect(() => { if (!flowId && flowList?.length) setFlowId(flowList[0].flow_id) }, [flowList, flowId])
  const sourceId = source === 'flow' ? (flowId ? `flow:${flowId}` : '') : journeyId
  const recording = source === 'record'
  // A capture is uploaded, not run: none of the walk's run controls apply.
  const capturing = source === 'capture'
  const browserCrawling = source === 'browser'
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
  const active = !!crawls?.some(c => ['queued', 'running'].includes(c.status))

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const selectCrawlRun = useCallback((id: number) => setSelectedId(id), [])
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
  const refreshFinishedCrawl = useCallback(() => {
    loadCrawls()
    if (shownId != null) {
      knowledgeBaseService.crawl(shownId).then(setDetail).catch(() => undefined)
    }
  }, [loadCrawls, shownId])
  const [detailPlan, setDetailPlan] = useState<CrawlPlan | null>(null)
  useEffect(() => {
    // The live panel lists the walk's own plan, not whatever is selected above.
    if (!detail || detail.source === 'record') { setDetailPlan(null); return }
    knowledgeBaseService.crawlPlan(appKey, detail.journey_id, detail.profile_id, { stop_before: detail.stop_before ?? null, allow_risky: true })
      .then(setDetailPlan).catch(() => setDetailPlan(null))
  }, [appKey, detail?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const [busy, setBusy] = useState<null | 'start' | 'local' | 'download' | 'record' | 'propose' | 'generate' | 'continue' | 'recapture'>(null)
  const [recaptureStep, setRecaptureStep] = useState<number | null>(null)
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
        environment: application.environment, stop_before: stopBefore, allow_risky: allowRisky, headed: headed && !!caps?.headed_available,
        browser: chosenBrowser
      })
      setSelectedId(run.id)
      loadCrawls()
    } catch (err) {
      setActionError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const startLocal = async () => {
    setBusy('local')
    setActionError(null)
    setActionNote(null)
    let crawlId: number | null = null
    try {
      const made = await knowledgeBaseService.startLocalCrawl(appKey, {
        journey_id: sourceId, application_id: application.id, profile_id: plan?.profile_id ?? (profileId || null),
        environment: application.environment, stop_before: stopBefore, allow_risky: allowRisky, headed: localHeaded
      })
      crawlId = made.crawl.id
      setSelectedId(crawlId)
      loadCrawls()
      try {
        await startDeviceRunner(made.pairing)
      } catch {
        await knowledgeBaseService.cancelLocalCrawl(crawlId).catch(() => undefined)
        throw new Error('The local Playwright runner is not available. Download it once, start it on this device, then click Run on this device again.')
      }
      setActionNote('Playwright is running on this device. Progress and evidence will appear below; the backend is only coordinating the run.')
    } catch (err) {
      setActionError(errorText(err))
      loadCrawls()
    } finally {
      setBusy(null)
    }
  }

  const downloadLocalRunner = async () => {
    setBusy('download')
    setActionError(null)
    try {
      const url = await knowledgeBaseService.downloadLocalRunner()
      const a = document.createElement('a')
      a.href = url; a.download = 'automation-studio-local-runner.zip'; a.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 10000)
      setActionNote('Local runner downloaded. Extract it and start the Windows or Linux launcher once on each device.')
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
      if (canApprove) {
        await knowledgeBaseService.approve(made.change_set.id, `Published from completed dry run #${id}`)
        setActionNote(`Flow blueprint ${made.flow.flow_id ?? ''} was published to the Automation KB.`)
        onAutomationReady()
      } else {
        setActionNote(`Flow blueprint ${made.flow.flow_id ?? ''} was created as change set #${made.change_set.id}. An approver must publish it before it appears in the Automation KB.`)
        onProposed()
      }
    } catch (err) {
      setActionError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const continueBrowserCrawl = async () => {
    setBusy('continue')
    setActionError(null)
    let made: Awaited<ReturnType<typeof knowledgeBaseService.startBrowserCrawl>> | null = null
    try {
      made = await knowledgeBaseService.startBrowserCrawl(appKey, {
        journey_id: detail?.journey_id || journeyId, application_id: application.id,
        environment: application.environment, max_pages: 20, wait_seconds: 20, retry_count: 2
      })
      setSelectedId(made.crawl.id)
      loadCrawls()
      if (!await startInstalledCollector(made.pairing)) {
        await knowledgeBaseService.cancelBrowserCrawl(made.crawl.id).catch(() => undefined)
        throw new Error(`The installed collector did not respond. Reload extension version ${COLLECTOR_VERSION}, then try again.`)
      }
    } catch (err) {
      setActionError(errorText(err))
      loadCrawls()
    } finally {
      setBusy(null)
    }
  }

  const recaptureOnDevice = async (step: number) => {
    if (!detail) return
    setBusy('recapture')
    setRecaptureStep(step)
    setActionError(null)
    setActionNote(null)
    let made: Awaited<ReturnType<typeof knowledgeBaseService.startLocalCrawl>> | null = null
    try {
      made = await knowledgeBaseService.startLocalCrawl(appKey, {
        journey_id: detail.journey_id,
        application_id: application.id,
        profile_id: detail.profile_id,
        environment: application.environment,
        allow_risky: true,
        headed: true,
        capture_step: step,
      })
      setSelectedId(made.crawl.id)
      loadCrawls()
      await startDeviceRunner(made.pairing)
      setActionNote(`Replaying steps before ${step}. In the opened browser, click the element for step ${step}; the selection will be captured automatically.`)
    } catch (err) {
      if (made) await knowledgeBaseService.cancelLocalCrawl(made.crawl.id).catch(() => undefined)
      setActionError(errorText(err))
      loadCrawls()
    } finally {
      setBusy(null)
      setRecaptureStep(null)
    }
  }

  const recaptureWithCollector = async (step: number) => {
    if (!detail) return
    setBusy('recapture'); setRecaptureStep(step); setActionError(null); setActionNote(null)
    let made: Awaited<ReturnType<typeof knowledgeBaseService.startBrowserCrawl>> | null = null
    try {
      const installed = await installedCollectorVersion()
      if (installed !== COLLECTOR_VERSION) {
        throw new Error(installed
          ? `Browser collector ${installed} is installed. Download and reload version ${COLLECTOR_VERSION} before recapturing.`
          : `Browser collector ${COLLECTOR_VERSION} was not detected. Download or reload it, refresh this page, then recapture.`)
      }
      made = await knowledgeBaseService.startBrowserCrawl(appKey, {
        journey_id: detail.journey_id,
        application_id: application.id,
        profile_id: detail.profile_id || null,
        environment: detail.environment || application.environment,
        max_pages: 20,
        wait_seconds: 120,
        retry_count: 2,
        capture_step: step,
        recapture_of: detail.id,
      })
      setSelectedId(made.crawl.id)
      loadCrawls()
      if (!await startInstalledCollector(made.pairing)) {
        throw new Error(`The installed collector did not respond. Reload extension version ${COLLECTOR_VERSION}, then try again.`)
      }
      setActionNote(`Replaying steps before ${step}. The collector will pause on step ${step}; click its element in the opened tab. Saved Test Data is entered automatically for fields and OTP steps.`)
    } catch (err) {
      if (made) {
        await stopInstalledCollector(made.crawl.id).catch(() => false)
        await knowledgeBaseService.cancelBrowserCrawl(made.crawl.id, 'Collector startup failed before the recapture began.').catch(() => undefined)
      }
      setActionError(errorText(err))
      loadCrawls()
    } finally {
      setBusy(null); setRecaptureStep(null)
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
  const proposable = captured || additions.size > 0 || pickCount > 0 || (detail?.source !== 'flow' && !!detail?.result?.summary?.routes_new)
  const alreadyProposed = detail?.source !== 'flow' && !!(detail?.automation_change_set_id || detail?.journey_change_set_id)
  const ranSteps = (detail?.result?.steps ?? []).some(s => s.status === 'done' || s.status === 'auto')
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
                {(['journey', 'flow', 'browser', 'record', 'capture'] as const).map(s => (
                  <button key={s} type="button" role="radio" aria-checked={source === s} onClick={() => setSource(s)}
                    className={`px-3 text-[12.5px] font-semibold normal-case tracking-normal ${source === s ? 'bg-[#1F2937] text-white' : 'bg-white text-[#374151]'}`}>
                    {s === 'journey' ? (serverRuntimeReady ? 'Server dry run' : 'Journey') : s === 'flow' ? 'A flow blueprint' : s === 'browser' ? 'Browser crawl' : s === 'record' ? 'Record it myself' : 'Upload a capture'}
                  </button>
                ))}
              </div>
            </div>
            {source === 'flow' ? (
              <label className={LABEL}>
                Flow blueprint
                <select aria-label="Flow blueprint" value={flowId} onChange={e => setFlowId(e.target.value)} className={`${SELECT} max-w-[360px]`}>
                  {(flowList ?? []).map(f => <option key={f.flow_id} value={f.flow_id}>{f.flow_name} · {f.steps} steps</option>)}
                </select>
              </label>
            ) : !(browserCrawling && bulkBrowser) ? (
              <label className={LABEL}>
                Journey
                <select aria-label="Journey" value={journeyId} onChange={e => { setJourneyId(e.target.value); setProfileId('') }} className={`${SELECT} max-w-[360px]`}>
                  {journeys.map(j => <option key={j.id} value={j.id}>{j.title}</option>)}
                </select>
              </label>
            ) : null}
            {!recording && !capturing && !browserCrawling && <>
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
            {serverRuntimeReady && <button
              type="button"
              onClick={() => void start()}
              disabled={!canExecute || !plan || busy !== null || active || missing.length > 0 || blocked}
              title={!canExecute ? 'Needs the automation.execute permission' : active ? 'A walk is already running' : blocked ? `Walks do not run against ${application.environment}` : missing.length ? 'Test Data is missing values this walk needs' : undefined}
              className="h-[34px] rounded-[10px] bg-[#B71920] px-4 text-[13px] font-bold text-white hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === 'start' ? 'Starting…' : 'Start dry run'}
            </button>}
            <label className={LABEL}>
              Device browser
              <select aria-label="Device browser mode" value={localHeaded ? 'headed' : 'headless'} onChange={event => setLocalHeaded(event.target.value === 'headed')} className={SELECT}>
                <option value="headless">Headless</option>
                <option value="headed">Headed · show browser</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => void startLocal()}
              disabled={!canExecute || !plan || busy !== null || active || missing.length > 0 || blocked}
              title={!canExecute ? 'Needs the automation.execute permission' : active ? 'A walk is already running' : blocked ? `Walks do not run against ${application.environment}` : missing.length ? 'Test Data is missing values this walk needs' : `Uses Playwright installed on this device in ${localHeaded ? 'headed' : 'headless'} mode; no browser automation runs on the backend server`}
              className="h-[34px] rounded-[10px] border border-[#B71920] bg-white px-4 text-[13px] font-bold text-[#B71920] hover:bg-[#FFF5F5] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === 'local' ? 'Connecting…' : 'Run on this device'}
            </button>
            <button type="button" onClick={() => void downloadLocalRunner()} disabled={busy !== null} className={PLAIN}>
              {busy === 'download' ? 'Downloading…' : 'Download device runner'}
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
          {browserCrawling && (
            <div className="flex flex-col gap-3">
              <div className="flex w-fit overflow-hidden rounded-[10px] border border-[#E8EAEE]">
                <button type="button" onClick={() => setBulkBrowser(false)} className={`h-[34px] px-3 text-[12.5px] font-semibold ${!bulkBrowser ? 'bg-[#1F2937] text-white' : 'bg-white text-[#374151]'}`}>One journey</button>
                <button type="button" onClick={() => setBulkBrowser(true)} className={`h-[34px] px-3 text-[12.5px] font-semibold ${bulkBrowser ? 'bg-[#1F2937] text-white' : 'bg-white text-[#374151]'}`}>Multiple journeys</button>
              </div>
              {bulkBrowser ? (
                <BulkBrowserCrawlSetup appKey={appKey} application={application} journeys={journeys}
                  profiles={(coverage?.profiles ?? []).filter(profile => profile.kind === 'vault')}
                  canExecute={canExecute} canApprove={canApprove} anotherRunActive={active}
                  onSelectRun={selectCrawlRun} onRunsChanged={loadCrawls}
                  onAutomationReady={onAutomationReady} onProposed={onProposed} />
              ) : (
                <BrowserCollectorSetup appKey={appKey} journeyId={journeyId} application={application}
                  profileId={profileId || plan?.profile_id || ''} profiles={(coverage?.profiles ?? []).filter(profile => profile.kind === 'vault')}
                  profileWarnings={plan?.warnings ?? []} onProfileChange={setProfileId} canExecute={canExecute} active={active}
                  onStarted={id => { setSelectedId(id); loadCrawls() }} />
              )}
            </div>
          )}
          {recording && (
            <Note tone={caps && !caps.headed_available ? 'warn' : undefined}>
              {caps && !caps.headed_available
                ? 'Recording opens a browser window for you to use, and this server has no screen. Record from a backend running on your own machine.'
                : `Opens a browser window on this machine at ${application.base_url} (${application.environment}). Do the journey yourself: every click, field and choice becomes a step with the selector it used, and nothing you type is kept. Afterwards you review the steps and save them as this journey's steps.`}
            </Note>
          )}
          {capturing && (
            <CaptureUpload appKey={appKey} journeyId={journeyId} application={application} canExecute={canExecute}
              openInbox={Number(params.get('inbox')) || null}
              onJourneyCreated={(id, title) => { setBuiltJourneys(cur => [...cur, { id, title }]); setJourneyId(id) }}
              onImported={id => { setSelectedId(id); loadCrawls() }} />
          )}
          {!recording && !capturing && !browserCrawling && <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-[#374151]">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={allowRisky} onChange={e => setAllowRisky(e.target.checked)} className="accent-[#B71920]" />
              Allow steps that change data
              {plan?.first_risky ? <span className="text-[#8A5000]">({beforeLabel(plan.items[plan.first_risky - 1], plan.first_risky)}: {plan.items[plan.first_risky - 1]?.text.slice(0, 50)})</span> : <span className="text-[#9CA3AF]">(none in this walk)</span>}
            </label>
            <label className="flex items-center gap-2" title="Installed Chrome is the signed browser IT already allows; Chromium is Playwright's own">
              Browser
              <select value={chosenBrowser} onChange={e => setBrowser(e.target.value as CrawlBrowser)}
                className="h-[28px] rounded-[8px] border border-[#D1D5DB] bg-white px-2 text-[12.5px]">
                <option value="chrome">Installed Chrome{caps && caps.chrome_installed === false ? ' (not found, uses Chromium)' : ''}</option>
                <option value="chromium">Chromium (Playwright)</option>
              </select>
            </label>
            {caps?.headed_available ? (
              <label className="flex items-center gap-2" title="Opens a real browser window on the machine the backend runs on, slowed down so you can follow it">
                <input type="checkbox" checked={headed} onChange={e => setHeaded(e.target.checked)} className="accent-[#B71920]" />
                Show the browser on this machine
              </label>
            ) : (
              <span className="text-[#6B7280]" title="The server runs without a screen; the walk is shown live on this page instead">Watch it live below (this server cannot open a browser window)</span>
            )}
            <span className="text-[#6B7280]">“Run on this device” uses the device's installed Playwright through a loopback-only runner.</span>
          </div>}
          {blocked && <Note tone="warn">Walks do not run against {application.environment}: they fill in forms and click through journeys. Choose SIT, QA, UAT or RC in the header.</Note>}
          {planError && <Note tone="warn">{planError}</Note>}
          {missing.length > 0 && !capturing && !browserCrawling && (
            <Note tone="warn">Test Data has no value in {application.environment} for {missing.join(', ')}. Add it on the Test Data stage, or stop the walk before the step that needs it.</Note>
          )}
          {actionError && <Note tone="warn">{actionError}</Note>}
          {!recording && !browserCrawling && plan?.scenario && (
            <Note>
              This test data is for {plan.scenario.scenario_id} ({plan.scenario.type}): {plan.scenario.title}. The walk runs steps {plan.scenario.steps.join(', ')} and expects that outcome.
            </Note>
          )}
          {!recording && !browserCrawling && (plan?.warnings ?? []).map(w => <Note key={w} tone="warn">{w}</Note>)}
          {!recording && !browserCrawling && plan && (
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
          {!recording && !capturing && !browserCrawling && <p className="m-0 text-[12px] text-[#6B7280]">
            {plan?.source !== 'flow' && plan?.entry ? <>Starts at {plan.entry} and lets the application open its first screen; each screen is recognised by what is on it. </> : null}
            Values come from Test Data at run time and are never recorded; typed fields are painted over in screenshots and live frames (the video and trace still show them). A journey walk keeps a selector only if it matched exactly one element.
          </p>}
        </div>
      </Card>

      <Card label="Walk results">
        <CardHead
          title={detail ? `${detail.source === 'record' ? 'Recording' : detail.source === 'capture' ? 'Capture' : detail.source === 'browser' ? 'Browser crawl' : detail.execution_target === 'local' ? 'Device walk' : 'Walk'} #${detail.id} · ${detail.journey_name ?? detail.journey_id}` : 'Walk results'}
          hint={detail ? `${detail.source === 'flow' ? 'Flow blueprint' : detail.source === 'record' ? 'Recorded by a person' : detail.source === 'capture' ? 'Uploaded browser capture' : detail.source === 'browser' ? 'Cross-browser collector' : detail.execution_target === 'local' ? 'Journey · local Playwright' : 'Journey'} · ${detail.environment ?? ''} · ${detail.source === 'capture' ? (detail.result?.capture?.file ?? 'uploaded') : (detail.profile_id ?? 'no profile')} · started ${detail.created_at ? new Date(detail.created_at + 'Z').toLocaleString() : '—'}${detail.created_by ? ` by ${detail.created_by}` : ''}` : 'Nothing has been walked for this application yet'}
          right={
            <div className="flex flex-wrap items-center gap-2">
              {crawls && crawls.length > 1 && (
                <select aria-label="Walk" value={shownId ?? ''} onChange={e => setSelectedId(Number(e.target.value))} className={SELECT}>
                  {crawls.map(c => <option key={c.id} value={c.id}>#{c.id} · {c.source === 'record' ? 'recording · ' : c.source === 'capture' ? 'capture · ' : c.source === 'browser' ? 'browser · ' : c.execution_target === 'local' ? 'device · ' : ''}{c.journey_name ?? c.journey_id} · {c.environment} · {c.status}</option>)}
                </select>
              )}
              {detail && <Chip tone={STATUS_TONE[detail.status]}>{detail.status}</Chip>}
              {detail?.status === 'completed' && (detail.source === 'journey' || detail.source === 'capture' || detail.source === 'browser') && ranSteps && (
                <button type="button" onClick={() => void generateFlow(detail.id)} disabled={!canExecute || busy !== null}
                  title={canApprove ? "Publishes the completed dry run as an Automation KB flow and opens step 7" : "Creates an Automation KB flow change set for an approver to publish"}
                  className="h-[34px] rounded-[10px] border border-[#E8EAEE] bg-white px-4 text-[13px] font-bold text-[#1F2937] hover:border-[#F6D4D5] disabled:opacity-50">
                  {busy === 'generate' ? 'Creating…' : canApprove ? 'Create in Automation KB →' : 'Submit to Automation KB'}
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
        {detail && running && detail.source === 'record' && <RecordingLive crawl={detail} onFinished={refreshFinishedCrawl} canStop={canExecute} />}
        {detail && running && detail.source !== 'record' && <LivePanel crawl={detail} plan={detailPlan} onFinished={refreshFinishedCrawl} canStop={canExecute} />}
        {detail?.status === 'failed' && detail.source === 'browser' && (
          <FailedBrowserPreview crawl={detail} plan={detailPlan} busy={busy === 'recapture'} onRecapture={recaptureWithCollector} />
        )}
        {detail?.status === 'failed' && detail.execution_target === 'local' && <FailedDeviceRun crawl={detail} plan={detailPlan} />}
        {detail?.status === 'failed' && detail.source !== 'browser' && detail.execution_target !== 'local' && <div className="px-5 pb-5"><Note tone="warn">{detail.error}</Note></div>}
        {detail?.result && detail.source === 'record' && (
          <RecordingReview appKey={appKey} crawl={detail} canExecute={canExecute} canApprove={canApprove}
            onSaved={() => { loadCrawls(); onProposed() }} />
        )}
        {detail?.status === 'completed' && detail?.result && detail.source !== 'record' && (
          <>
            {detail.browser_note && <div className="px-5 pb-3"><Note tone="warn">{detail.browser_note}</Note></div>}
            {detail.source === 'browser' && (
              detail.result.capture
                ? <BrowserResultSummary crawlId={detail.id} capture={detail.result.capture} steps={detail.result.steps} items={detailPlan?.items ?? []}
                    continuing={busy === 'continue'} recapturing={busy === 'recapture'} recaptureStep={recaptureStep}
                    onContinue={continueBrowserCrawl} onRecapture={recaptureWithCollector} />
                : <div className="px-5 pb-3"><Note tone="warn">The browser crawl finished without a captured-screen summary.</Note></div>
            )}
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
            {detail.source !== 'browser' && <>
              <div className="px-5 pb-1 text-[11px] font-bold uppercase tracking-[0.1em] text-[#6B7280]">Steps</div>
              <ol className="m-0 list-none p-0">
                {detail.result.steps.map(step => <StepRow key={step.order} crawlId={detail.id} step={step} item={detailPlan?.items[step.order - 1]} screenNames={detailPlan?.screen_names ?? {}} />)}
              </ol>
            </>}
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
                    {r.outcome === 'not_found' && r.step != null && !running && (
                      <button type="button" disabled={!canExecute || busy !== null}
                        title="Open a headed browser on this device, replay the earlier steps, then click the missing element"
                        onClick={() => void recaptureOnDevice(r.step as number)}
                        className="rounded-full border border-[#B71920] bg-white px-2.5 py-0.5 text-[11.5px] font-semibold text-[#B71920] hover:bg-[#FFF5F5] disabled:opacity-50">
                        {busy === 'recapture' && recaptureStep === r.step ? 'Opening…' : 'Recapture & select'}
                      </button>
                    )}
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
