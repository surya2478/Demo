import React, { useCallback, useEffect, useMemo, useState } from 'react'
import knowledgeBaseService, { errorText, type CrawlOutcome, type CrawlPlan, type JourneyCrawl } from '../../services/knowledgeBaseService'
import { Card, CardHead, Chip, Failed, Loading, Note, TONE, useLoad } from './kbUi'

const OUTCOME: Record<CrawlOutcome, { label: string; tone: keyof typeof TONE; hint: string }> = {
  confirmed: { label: 'Confirmed', tone: 'good', hint: 'The Automation KB selector still finds it' },
  healed: { label: 'Healed', tone: 'warn', hint: 'The Automation KB selector failed; another way found it' },
  new: { label: 'New', tone: 'info', hint: 'Captured; the Automation KB has no selector for it yet' },
  kb_failed: { label: 'KB selector failed', tone: 'bad', hint: 'Neither the Automation KB selector nor the design found it' },
  not_found: { label: 'Not found', tone: 'idle', hint: 'Looked for on its screen and not there. Nothing is invented' },
  not_applicable: { label: 'Not shown', tone: 'idle', hint: 'An optional step whose screen this account does not see' },
  not_reached: { label: 'Not reached', tone: 'idle', hint: 'The crawl never got to its screen' }
}
const ORDER: CrawlOutcome[] = ['kb_failed', 'healed', 'new', 'confirmed', 'not_found', 'not_applicable', 'not_reached']
const KIND: Record<string, string> = { goto: 'Open', screen: 'Screen', fill: 'Fill', otp: 'Enter OTP', click: 'Click', capture: 'Look for', skip: 'Skip' }
const STATUS_TONE: Record<JourneyCrawl['status'], keyof typeof TONE> = { queued: 'idle', running: 'info', completed: 'good', failed: 'bad' }

const SELECT = 'h-[34px] rounded-[10px] border border-[#E8EAEE] bg-white px-2.5 text-[12.5px] font-semibold text-[#374151]'

// Walks one documented journey in the running application with values from the
// test-data vault, looks for every element the design says each screen has, and
// turns what it finds into paired change sets. Nothing is written until a
// reviewer approves them in the Change sets drawer.
const JourneyCrawlStage: React.FC<{
  appKey: string
  application: { id: number; environment: string; base_url: string }
  canExecute: boolean
  onProposed: () => void
}> = ({ appKey, application, canExecute, onProposed }) => {
  const [taxonomy, taxError] = useLoad(appKey, () => knowledgeBaseService.taxonomy(appKey))
  const [coverage] = useLoad(appKey, () => knowledgeBaseService.testData(appKey))
  const journeys = useMemo(() => {
    if (!taxonomy) return []
    const byId = new Map(taxonomy.nodes.map(n => [n.id, n]))
    return taxonomy.authored.map(id => ({ id, title: byId.get(id)?.title ?? id }))
  }, [taxonomy])

  const [journeyId, setJourneyId] = useState<string>('')
  const [profileId, setProfileId] = useState<string>('')
  useEffect(() => { if (!journeyId && journeys.length) setJourneyId(journeys[journeys.length - 1].id) }, [journeys, journeyId])

  const [plan, setPlan] = useState<CrawlPlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  useEffect(() => {
    if (!journeyId) return
    let live = true
    setPlan(null)
    setPlanError(null)
    knowledgeBaseService.crawlPlan(appKey, journeyId, profileId || null)
      .then(p => { if (live) setPlan(p) })
      .catch(err => { if (live) setPlanError(errorText(err)) })
    return () => { live = false }
  }, [appKey, journeyId, profileId])

  const [crawls, setCrawls] = useState<JourneyCrawl[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const loadCrawls = useCallback(() => {
    knowledgeBaseService.crawls(appKey).then(c => { setCrawls(c); setListError(null) }).catch(err => setListError(errorText(err)))
  }, [appKey])
  useEffect(loadCrawls, [loadCrawls])
  // The newest crawl is absorbed on each list call, so polling the list is enough.
  const active = crawls?.[0] && ['queued', 'running'].includes(crawls[0].status)
  useEffect(() => {
    if (!active) return
    const t = window.setInterval(loadCrawls, 4000)
    return () => window.clearInterval(t)
  }, [active, loadCrawls])

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

  const [busy, setBusy] = useState<null | 'start' | 'propose'>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const missing = useMemo(() => {
    // Every value the plan reads, whichever profile defines it (the OTP has its own).
    if (!plan || !coverage) return []
    const gaps = new Set(coverage.profiles.flatMap(p => p.cells[application.environment]?.missing ?? []))
    return plan.variables.filter(v => gaps.has(v))
  }, [plan, coverage, application.environment])

  const start = async () => {
    setBusy('start')
    setActionError(null)
    try {
      const run = await knowledgeBaseService.startCrawl(appKey, {
        journey_id: journeyId, application_id: application.id, profile_id: plan?.profile_id ?? (profileId || null), environment: application.environment
      })
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
      const updated = await knowledgeBaseService.proposeFromCrawl(id)
      setDetail(updated)
      loadCrawls()
      onProposed()
    } catch (err) {
      setActionError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const rows = useMemo(() => {
    const all = detail?.result?.rows ?? []
    return [...all].sort((a, b) => ORDER.indexOf(a.outcome) - ORDER.indexOf(b.outcome) || a.screen_id.localeCompare(b.screen_id))
  }, [detail])
  const proposable = rows.some(r => ['new', 'healed'].includes(r.outcome) && !r.data_dependent && !r.ambiguous)

  if (taxError) return <Card><Failed message={taxError} /></Card>
  if (!taxonomy) return <Card><Loading what="journeys" /></Card>

  return (
    <div className="flex flex-col gap-4">
      <Card label="Journey-guided crawl">
        <CardHead
          title="Journey-guided crawl"
          hint={`Walks a documented journey at ${application.base_url} (${application.environment}) and looks for every element the design says each screen has`}
        />
        <div className="flex flex-col gap-3 px-5 pb-5">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-0 flex-col gap-1 text-[11px] font-bold uppercase tracking-[0.1em] text-[#6B7280]">
              Journey
              <select aria-label="Journey" value={journeyId} onChange={e => { setJourneyId(e.target.value); setProfileId('') }} className={`${SELECT} max-w-[360px]`}>
                {journeys.map(j => <option key={j.id} value={j.id}>{j.title}</option>)}
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-[11px] font-bold uppercase tracking-[0.1em] text-[#6B7280]">
              Test data
              <select aria-label="Test data profile" value={profileId || plan?.profile_id || ''} onChange={e => setProfileId(e.target.value)} className={`${SELECT} max-w-[300px]`}>
                {(coverage?.profiles ?? []).filter(p => p.kind === 'vault').map(p => <option key={p.profile_id} value={p.profile_id}>{p.name}</option>)}
                {!coverage && plan?.profile_id && <option value={plan.profile_id}>{plan.profile_id}</option>}
              </select>
            </label>
            <button
              type="button"
              onClick={() => void start()}
              disabled={!canExecute || !plan || busy !== null || !!active || missing.length > 0}
              title={!canExecute ? 'Needs the automation.execute permission' : active ? 'A crawl is already running' : missing.length ? 'The vault is missing values this crawl needs' : undefined}
              className="h-[34px] rounded-[10px] bg-[#B71920] px-4 text-[13px] font-bold text-white hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === 'start' ? 'Starting…' : 'Start crawl'}
            </button>
          </div>
          {planError && <Note tone="warn">{planError}</Note>}
          {missing.length > 0 && (
            <Note tone="warn">The vault has no value in {application.environment} for {missing.join(', ')}. Add it on the Test Data stage's vault screen, then start the crawl.</Note>
          )}
          {actionError && <Note tone="warn">{actionError}</Note>}
          {plan && (
            <details className="rounded-[12px] border border-[#E8EAEE]">
              <summary className="cursor-pointer px-3.5 py-2.5 text-[12.5px] font-semibold text-[#374151]">
                Plan · {plan.items.length} steps across {plan.scope.length} journey{plan.scope.length === 1 ? '' : 's'} · reads {plan.variables.join(', ') || 'no test data'}
              </summary>
              <ol className="m-0 flex list-none flex-col p-0">
                {plan.items.map((item, i) => (
                  <li key={i} className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 border-t border-[#F1F2F4] px-3.5 py-2 text-[12.5px] sm:grid-cols-[72px_minmax(0,1fr)_minmax(0,220px)]">
                    <span className="font-semibold text-[#6B7280]">{KIND[item.kind] ?? item.kind}</span>
                    <span className={`min-w-0 ${item.kind === 'skip' ? 'text-[#9CA3AF] line-through' : 'text-[#1F2937]'}`} title={item.reason}>
                      {item.step_number}. {item.text}{item.optional && <span className="ml-1.5 text-[11px] text-[#6B7280]">(if shown)</span>}
                    </span>
                    <span className="hidden truncate font-mono text-[11px] text-[#6B7280] sm:block">{item.variable || item.text_variable || item.screen_id || ''}</span>
                  </li>
                ))}
              </ol>
            </details>
          )}
          <p className="m-0 text-[12px] text-[#6B7280]">
            Values come from the encrypted test-data vault at run time and are never recorded in the result. A selector is kept only if it matched exactly one element.
          </p>
        </div>
      </Card>

      <Card label="Crawl results">
        <CardHead
          title={detail ? `Crawl #${detail.id} · ${detail.journey_name ?? detail.journey_id}` : 'Crawl results'}
          hint={detail ? `${detail.environment ?? ''} · ${detail.profile_id ?? 'no profile'} · started ${detail.created_at ? new Date(detail.created_at + 'Z').toLocaleString() : '—'}${detail.created_by ? ` by ${detail.created_by}` : ''}` : 'No crawl has run for this application yet'}
          right={
            <div className="flex flex-wrap items-center gap-2">
              {crawls && crawls.length > 1 && (
                <select aria-label="Crawl" value={shownId ?? ''} onChange={e => setSelectedId(Number(e.target.value))} className={SELECT}>
                  {crawls.map(c => <option key={c.id} value={c.id}>#{c.id} · {c.journey_name ?? c.journey_id} · {c.status}</option>)}
                </select>
              )}
              {detail && <Chip tone={STATUS_TONE[detail.status]}>{detail.status}</Chip>}
              {detail?.status === 'completed' && !detail.automation_change_set_id && !detail.journey_change_set_id && (
                <button type="button" onClick={() => void propose(detail.id)} disabled={!canExecute || busy !== null || !proposable}
                  title={!proposable ? 'Nothing new or healed to propose' : undefined}
                  className="h-[34px] rounded-[10px] bg-[#B71920] px-4 text-[13px] font-bold text-white hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50">
                  {busy === 'propose' ? 'Proposing…' : 'Propose changes'}
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
        {!crawls && !listError && <Loading what="crawls" />}
        {detail && ['queued', 'running'].includes(detail.status) && (
          <div className="px-5 pb-5"><Note>The browser is walking the journey. This refreshes on its own; the run also appears in Automation runs as <code>{detail.run_key}</code>.</Note></div>
        )}
        {detail?.status === 'failed' && <div className="px-5 pb-5"><Note tone="warn">{detail.error}</Note></div>}
        {detail?.result && (
          <>
            <div className="flex flex-wrap gap-1.5 px-5 pb-3">
              {ORDER.filter(o => detail.result?.summary[o]).map(o => (
                <Chip key={o} tone={OUTCOME[o].tone} title={OUTCOME[o].hint}>{OUTCOME[o].label} · {detail.result?.summary[o]}</Chip>
              ))}
            </div>
            {detail.result.blockers.length > 0 && <div className="px-5 pb-3"><Note tone="warn">Stopped early: {detail.result.blockers.join('; ')}</Note></div>}
            {detail.result.steps.some(s => s.status === 'error') && (
              <div className="px-5 pb-3">
                <Note tone="warn">
                  {detail.result.steps.filter(s => s.status === 'error').map(s => `Step ${s.step_number} (${s.kind}): ${s.error}`).join(' · ')}
                </Note>
              </div>
            )}
            <div className="hidden h-8 grid-cols-[minmax(0,1.1fr)_130px_minmax(0,1.6fr)] items-center gap-3 bg-[#F4F5F7] px-5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-[#374151] md:grid">
              <span>Design element</span><span>Outcome</span><span>Selector · how it was found</span>
            </div>
            <ul className="m-0 list-none p-0">
              {rows.map(r => (
                <li key={`${r.screen_id}.${r.element_id}`} className="grid grid-cols-1 gap-1.5 border-t border-[#F1F2F4] px-5 py-2.5 text-[12.5px] md:grid-cols-[minmax(0,1.1fr)_130px_minmax(0,1.6fr)] md:gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-[#1F2937]" title={r.design_label ?? r.element_id}>{r.design_label ?? r.element_id}</div>
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
                      {r.strategy && <span>via {r.strategy === 'kb' ? 'Automation KB' : r.strategy}</span>}
                      {r.label_differs && r.app_label && <span className="text-[#8A5000]">app says “{r.app_label}”</span>}
                      {r.data_dependent && <span title="Found by a test-data value; not proposed as a lasting selector">found through test data · not proposed</span>}
                      {r.ambiguous && <span className="text-[#8A5000]">matched more than one element · not proposed</span>}
                      {r.kb_target && r.outcome !== 'confirmed' && <span className="truncate" title={r.kb_target}>KB had {r.kb_ref}</span>}
                    </div>
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
