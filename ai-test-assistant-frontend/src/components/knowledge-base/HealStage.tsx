import React, { useCallback, useEffect, useState } from 'react'
import knowledgeBaseService, { errorText, type HealCrawlMode, type KbHeal } from '../../services/knowledgeBaseService'
import { startDeviceRunner } from '../../services/localRunner'
import { COLLECTOR_VERSION, startInstalledCollector } from '../../services/browserCollector'
import ImpactSummary from './ImpactSummary'
import { Card, CardHead, Chip, Failed, Loading, Note, TONE } from './kbUi'

// Change & Heal: every published Journey KB change -- from a BRD, a design PDF,
// a Reconcile decision, a crawl's links or a revert -- with what it touched.
// The affected test cases' KB diffs were refreshed when it was approved; the
// two follow-ups that cost model calls or drive the application are offered
// here and run only when someone asks.

const SOURCE: Record<string, string> = {
  brd: 'BRD', extraction: 'Design document', reconcile: 'Reconcile', crawl: 'Journey crawl', revert: 'Revert', manual: 'Manual'
}
const BTN = 'h-[32px] rounded-[10px] px-3 text-[12.5px] font-bold disabled:cursor-not-allowed disabled:opacity-50'
const when = (iso: string | null) => (iso ? new Date(iso.endsWith('Z') ? iso : `${iso}Z`).toLocaleString() : '—')
const summaryText = (s: Record<string, number>) =>
  Object.entries(s).filter(([, n]) => n).map(([k, n]) => `${k.replace(/_/g, ' ').toLowerCase()} ${n}`).join(' · ') || '—'
const CRAWL_TONE: Record<string, keyof typeof TONE> = { queued: 'idle', running: 'info', completed: 'good', failed: 'bad', deleted: 'idle' }
const CRAWL_LABEL: Record<HealCrawlMode, string> = {
  server: 'Normal · server',
  collector: 'Browser collector',
  device: 'Run on this device'
}

const HealCard: React.FC<{
  heal: KbHeal
  application: { id: number; environment: string } | null
  canExecute: boolean
  onChanged: (heal: KbHeal) => void
  onOpenCrawl: () => void
}> = ({ heal, application, canExecute, onChanged, onOpenCrawl }) => {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [crawlModes, setCrawlModes] = useState<Record<string, HealCrawlMode>>({})
  const run = async (key: string, action: () => Promise<KbHeal>) => {
    setBusy(key)
    setError(null)
    try { onChanged(await action()) } catch (err) { setError(errorText(err)) } finally { setBusy(null) }
  }
  const moved = heal.rediff.filter(r => r.changed)
  const crawled = new Map(heal.crawls.map(c => [c.journey_id, c]))
  const rechecking = heal.recheck?.progress && Object.values(heal.recheck.progress).some(s => s === 'queued' || s === 'running')
  const startCrawl = async (journeyId: string): Promise<KbHeal> => {
    if (!application) throw new Error('Register the application before starting a crawl.')
    const mode = crawlModes[journeyId] ?? 'server'
    const started = await knowledgeBaseService.healCrawl(heal.id, {
      journey_id: journeyId,
      application_id: application.id,
      environment: application.environment,
      mode,
      max_pages: 20,
      wait_seconds: 20,
      retry_count: 2
    })
    onChanged(started.heal)
    try {
      if (mode === 'device') {
        if (!started.pairing) throw new Error('The device runner pairing code was not returned.')
        await startDeviceRunner(started.pairing)
      } else if (mode === 'collector') {
        if (!started.pairing || !await startInstalledCollector(started.pairing, 20)) {
          throw new Error(`The installed collector did not respond. Reload extension version ${COLLECTOR_VERSION}, then try again.`)
        }
      }
    } catch (err) {
      if (mode === 'device') await knowledgeBaseService.cancelLocalCrawl(started.crawl.id).catch(() => undefined)
      if (mode === 'collector') await knowledgeBaseService.cancelBrowserCrawl(started.crawl.id).catch(() => undefined)
      const refreshed = await knowledgeBaseService.heal(heal.id).catch(() => started.heal)
      onChanged(refreshed)
      throw err
    }
    return started.heal
  }

  return (
    <Card label={heal.title}>
      <CardHead
        title={heal.title}
        hint={`${SOURCE[heal.source ?? ''] ?? heal.source ?? 'Change'} · ${heal.change_set_id ? `change set #${heal.change_set_id} · ` : ''}published ${when(heal.created_at)}${heal.created_by ? ` by ${heal.created_by}` : ''}`}
        right={heal.impact.counts?.test_cases
          ? <Chip tone="warn">{heal.impact.counts.test_cases} case(s) to heal</Chip>
          : heal.impact.crawl_journeys.length || heal.impact.automation.selectors_to_reverify.length
            ? <Chip tone="info">Confirm with a crawl</Chip>
            : <Chip tone="good">Nothing to heal</Chip>}
      />
      <div className="grid gap-4 px-5 pb-5 xl:grid-cols-2">
        <div className="flex flex-col gap-2">
          <h3 className="m-0 text-[13px] font-bold text-[#1F2937]">What it touched</h3>
          <ImpactSummary impact={heal.impact} />
        </div>

        <div className="flex flex-col gap-4">
          <section className="flex flex-col gap-2">
            <h3 className="m-0 text-[13px] font-bold text-[#1F2937]">1 · KB diff refreshed <span className="font-normal text-[#6B7280]">— done on approval</span></h3>
            {heal.rediff.length === 0
              ? <span className="text-[12.5px] text-[#6B7280]">No test case to refresh.</span>
              : (
                <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12px]">
                  {heal.rediff.map(r => (
                    <li key={r.case_id} className="flex flex-col rounded-[8px] bg-[#F9FAFB] px-2.5 py-1.5">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[11.5px] font-semibold text-[#1F2937]">{r.display_id}</span>
                        <Chip tone={r.changed ? 'warn' : 'idle'}>{r.changed ? 'moved' : 'unchanged'}</Chip>
                        {r.automatable_before !== r.automatable_after && r.automatable_after === false && <Chip tone="bad">no longer automatable</Chip>}
                      </span>
                      <span className="text-[#6B7280]">{summaryText(r.before)} → <span className="text-[#1F2937]">{summaryText(r.after)}</span></span>
                    </li>
                  ))}
                </ul>
              )}
            {moved.length > 0 && <span className="text-[11.5px] text-[#8A5000]">{moved.length} case(s) now compare differently with the Knowledge Bases.</span>}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="m-0 text-[13px] font-bold text-[#1F2937]">2 · Re-run AI Checks <span className="font-normal text-[#6B7280]">— review, KB diff and classify again; edits are kept</span></h3>
            {heal.recheck ? (
              <div className="text-[12px] text-[#4B5563]">
                Requested {when(heal.recheck.requested_at)}{heal.recheck.requested_by ? ` by ${heal.recheck.requested_by}` : ''} · {heal.recheck.queued} queued
                {heal.recheck.skipped.length > 0 && <> · {heal.recheck.skipped.length} skipped ({Array.from(new Set(heal.recheck.skipped.map(s => s.reason))).join('; ')})</>}
                {heal.recheck.progress && Object.keys(heal.recheck.progress).length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {Object.entries(heal.recheck.progress).map(([cid, status]) => (
                      <Chip key={cid} tone={status === 'done' ? 'good' : status === 'failed' ? 'bad' : 'info'}>#{cid} {status}</Chip>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
            <button type="button" className={`${BTN} w-fit border border-[#E8EAEE] bg-white text-[#1F2937] hover:border-[#F6D4D5]`}
              disabled={!canExecute || busy !== null || !heal.impact.test_cases.length || !!rechecking}
              title={!heal.impact.test_cases.length ? 'No test case is affected' : 'Calls the AI reviewer once per case'}
              onClick={() => void run('recheck', () => knowledgeBaseService.healRecheck(heal.id))}>
              {busy === 'recheck' ? 'Queuing…' : heal.recheck ? 'Re-run AI Checks again' : `Re-run AI Checks on ${heal.impact.test_cases.length} case(s)`}
            </button>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="m-0 text-[13px] font-bold text-[#1F2937]">3 · Confirm in the application <span className="font-normal text-[#6B7280]">— a journey-guided crawl per journey</span></h3>
            {heal.impact.crawl_journeys.length === 0 && <span className="text-[12.5px] text-[#6B7280]">No journey to crawl for this change.</span>}
            {!application && heal.impact.crawl_journeys.length > 0 && <Note>Register the application (Journey Crawl stage) to crawl from here.</Note>}
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {heal.impact.crawl_journeys.map(jid => {
                const done = crawled.get(jid)
                const name = heal.impact.journeys.find(j => j.journey_id === jid)?.name ?? jid
                return (
                  <li key={jid} className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
                    <span className="min-w-0 truncate text-[#1F2937]" title={jid}>{name}</span>
                    <span className="flex items-center gap-1.5">
                      {done && <Chip tone={CRAWL_TONE[done.status] ?? 'idle'}>{done.mode ? CRAWL_LABEL[done.mode] : 'crawl'} #{done.crawl_id} {done.status}</Chip>}
                      {done && <button type="button" className="text-[12px] font-semibold text-[#1D4ED8] hover:underline" onClick={onOpenCrawl}>Results</button>}
                      <select
                        aria-label={`Crawl type for ${name}`}
                        value={crawlModes[jid] ?? 'server'}
                        onChange={event => setCrawlModes(current => ({ ...current, [jid]: event.target.value as HealCrawlMode }))}
                        disabled={!canExecute || !application || busy !== null || (!!done && ['queued', 'running'].includes(done.status))}
                        title="Choose where this confirmation crawl runs"
                        className="h-[32px] rounded-[10px] border border-[#E8EAEE] bg-white px-2 text-[12px] font-semibold text-[#374151] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <option value="server">Normal · server</option>
                        <option value="collector">Browser collector</option>
                        <option value="device">Run on this device</option>
                      </select>
                      <button type="button" className={`${BTN} bg-[#B71920] text-white hover:opacity-95`}
                        disabled={!canExecute || !application || busy !== null || (!!done && ['queued', 'running'].includes(done.status))}
                        title={`Walks the journey using ${CRAWL_LABEL[crawlModes[jid] ?? 'server']}`}
                        onClick={() => application && void run(`crawl:${jid}`, () => startCrawl(jid))}>
                        {busy === `crawl:${jid}` ? 'Starting…' : done ? 'Crawl again' : 'Crawl'}
                      </button>
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
          {error && <Note tone="warn">{error}</Note>}
        </div>
      </div>
    </Card>
  )
}

const HealStage: React.FC<{
  appKey: string
  application: { id: number; environment: string } | null
  canExecute: boolean
  onOpenStage: (stage: 'sources' | 'crawl') => void
}> = ({ appKey, application, canExecute, onOpenStage }) => {
  const [heals, setHeals] = useState<KbHeal[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    knowledgeBaseService.heals(appKey).then(h => { setHeals(h); setError(null) }).catch(err => setError(errorText(err)))
  }, [appKey])
  useEffect(load, [load])
  // Follow re-checks and crawls while any is under way.
  const busy = heals?.some(h => h.crawls.some(c => ['queued', 'running'].includes(c.status))
    || Object.values(h.recheck?.progress ?? {}).some(s => s === 'queued' || s === 'running'))
  useEffect(() => {
    if (!busy) return
    const t = window.setInterval(load, 5000)
    return () => window.clearInterval(t)
  }, [busy, load])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="m-0 text-[18px] font-bold text-[#1F2937]">Change &amp; Heal</h2>
          <p className="m-0 mt-0.5 max-w-3xl text-[12.5px] text-[#6B7280]">
            Every approved Journey KB change, with what it touched. Test cases' KB diffs are refreshed on approval; re-running AI Checks and
            confirming crawls are one click each. To bring in a change, upload its BRD on Sources — a BRD may rename, revise and restate what exists.
          </p>
        </div>
        <button type="button" onClick={() => onOpenStage('sources')} className={`${BTN} border border-[#E8EAEE] bg-white text-[#1F2937] hover:border-[#F6D4D5]`}>Upload a BRD</button>
      </div>
      {error && <Card><Failed message={error} onRetry={load} /></Card>}
      {!heals && !error && <Card><Loading what="changes" /></Card>}
      {heals?.length === 0 && <Card className="p-6"><Note>No Journey KB change has been approved yet. Approved change sets appear here with their impact.</Note></Card>}
      {heals?.map(h => (
        <HealCard key={h.id} heal={h} application={application} canExecute={canExecute}
          onChanged={updated => setHeals(prev => prev?.map(x => (x.id === updated.id ? updated : x)) ?? null)}
          onOpenCrawl={() => onOpenStage('crawl')} />
      ))}
    </div>
  )
}

export default HealStage
