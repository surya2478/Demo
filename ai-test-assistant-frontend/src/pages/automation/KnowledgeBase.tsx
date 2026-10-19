/**
 * --- Knowledge Base ---------------------------------------------------------------
 *
 * One page for both Knowledge Bases of an application, in four phases, in the
 * order the work happens:
 *
 *   1 Register         Start here (name, key, environments, what is left to do)
 *   2 Design journeys  Sources · Journey KB · App Model
 *   3 Crawl the app    Test Data · Walk & Dry run · Automation KB
 *   4 Confirm mapping  Journey Map · Reconcile · Change & Heal
 *
 * A new application is registered here in one step (NewApplicationDialog):
 * Test Data entry, crawl registry and an empty Journey KB, optionally with its
 * master topic list. Renaming changes the name everywhere; the key stays.
 *
 * Journey Map is where a journey's steps are edited: beside each step, the
 * Automation KB selector that carries it out and the flow blueprint's step,
 * which is generated from the journey (components/knowledge-base/JourneyMapStage).
 *
 * It replaces the Application Discovery page at the same route. Crawl and
 * Automation KB are that page's own tabs, embedded (DiscoveryBody), so nothing
 * it did is lost. Nothing on the page edits a file directly: Reconcile
 * decisions (and later extraction and Change & Heal) create change sets, which
 * the Change sets drawer reviews, publishes as versions, and can revert.
 * Uploaded PDFs and BRDs (Sources) and journey crawls propose change sets the
 * same way.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import automationService from '../../services/automationService'
import knowledgeBaseService, { type JourneyKbApp, type KbOverview } from '../../services/knowledgeBaseService'
import { usePageHeader } from '../../components/layout/PageHeaderContext'
import { useAuth } from '../../hooks/useAuth'
import ChangeSetsDrawer from '../../components/knowledge-base/ChangeSetsDrawer'
import { SELECTED_APP_STORAGE_KEY, type RegisteredApplication } from '../../types/automation'
import testDataService from '../../services/testDataService'
import { DiscoveryBody } from './Discovery'
import { Card, Note } from '../../components/knowledge-base/kbUi'
import SourcesStage from '../../components/knowledge-base/SourcesStage'
import JourneysStage from '../../components/knowledge-base/JourneysStage'
import ModelStage from '../../components/knowledge-base/ModelStage'
import TestDataStage from '../../components/knowledge-base/TestDataStage'
import ReconcileStage from '../../components/knowledge-base/ReconcileStage'
import JourneyCrawlStage from '../../components/knowledge-base/JourneyCrawlStage'
import HealStage from '../../components/knowledge-base/HealStage'
import JourneyMapStage from '../../components/knowledge-base/JourneyMapStage'
import { CreateJourneyKbCard, DeleteApplication, NewApplicationDialog, RenameApplication, SetupStage } from '../../components/knowledge-base/ApplicationSetup'

type StageId = 'setup' | 'sources' | 'journeys' | 'map' | 'model' | 'testdata' | 'crawl' | 'automation' | 'reconcile' | 'heal'
type StageState = 'done' | 'attn' | 'idle'

const SELECTION_STORAGE_KEY = 'automation.knowledgeBase.selection'

const STAGE_IDS: StageId[] = ['setup', 'sources', 'journeys', 'model', 'testdata', 'crawl', 'automation', 'map', 'reconcile', 'heal']

// The stages grouped as the work goes: what a new engineer does first is on the left.
const PHASES: { title: string; hint: string; stages: StageId[] }[] = [
  { title: 'Register', hint: 'Application · environments', stages: ['setup'] },
  { title: 'Design journeys', hint: 'Documents in, journeys out', stages: ['sources', 'journeys', 'model'] },
  { title: 'Crawl the application', hint: 'Live pages give each element a selector', stages: ['testdata', 'crawl', 'automation'] },
  { title: 'Confirm the mapping', hint: 'Every step beside the selector doing it', stages: ['map', 'reconcile', 'heal'] }
]

// One line under the stages: what this one is for, and where to go after it.
const GUIDE: Record<StageId, { what: string; next?: StageId }> = {
  setup: { what: 'Where the application stands and what to do next: its name, environments and the four steps from documents to mapped journeys.', next: 'sources' },
  sources: { what: 'Upload screen-flow PDFs or BRDs. The model proposes journeys, screens and rules; keep what is right and approve it as a change set.', next: 'journeys' },
  journeys: { what: 'The master topic list. Add chapters and journeys here; open a journey to read or edit its steps. Extracted journeys land on these.', next: 'model' },
  model: { what: 'The screens and elements the documents describe, with their exact labels. No locators here: those come from crawling.', next: 'testdata' },
  testdata: { what: 'Which test accounts and values each journey needs, per environment. Values stay in Test Data and never enter the Knowledge Base.', next: 'crawl' },
  crawl: { what: 'Walk a journey in a real browser: each step finds its element on the live page and proposes its selector. Or crawl page by page.', next: 'automation' },
  automation: { what: 'What crawling found: flows, pages and selectors — the objects generated scripts use.', next: 'map' },
  map: { what: 'Each journey step beside the selector that performs it and the flow step generated from it. A journey is mapped when a walk confirms every step.', next: 'reconcile' },
  reconcile: { what: 'Where the design and the application disagree — a label that changed, an element that is missing. Decide which side is right.', next: 'heal' },
  heal: { what: 'After a BRD change is approved: the journeys, test cases and selectors it touched, and what to re-run.' }
}

const DOT: Record<StageState, string> = {
  done: 'bg-[#B71920] text-white',
  attn: 'border-[1.5px] border-[#EBCFA4] bg-[#FFF4E5] text-[#8A5000]',
  idle: 'bg-[#F4F5F7] text-[#6B7280]'
}

const KnowledgeBase: React.FC = () => {
  usePageHeader({
    title: 'Knowledge Base',
    subtitle: 'Design journeys and the crawled application, side by side',
    showSearch: false,
    showAssistant: false,
    showNotifications: true,
    showDateRange: false
  })

  const { user } = useAuth()
  // Same rule as the API's user_has_permission: admin, or the permission itself.
  const can = (permission: string) => {
    const u: any = user
    const roles: string[] = (u?.roles as string[]) || (u?.role ? [u.role] : [])
    return roles.some(r => String(r).toLowerCase() === 'admin') || ((u?.permissions as string[]) || []).includes(permission)
  }
  const canApprove = can('automation.approve')
  const canExecute = can('automation.execute')

  const [params, setParams] = useSearchParams()
  const stage: StageId = STAGE_IDS.includes(params.get('stage') as StageId) ? (params.get('stage') as StageId) : 'setup'
  // `extra` carries what the next stage should open on, e.g. { journey: id }.
  const openStage = useCallback((next: string, extra?: Record<string, string>) => {
    setParams(prev => {
      const p = new URLSearchParams(prev)
      p.set('stage', next)
      Object.entries(extra ?? {}).forEach(([k, v]) => (v ? p.set(k, v) : p.delete(k)))
      return p
    })
  }, [setParams])

  const [applications, setApplications] = useState<RegisteredApplication[]>([])
  const [journeyApps, setJourneyApps] = useState<JourneyKbApp[]>([])
  // One picker for two kinds of application: those registered for crawling
  // ("reg:<id>") and Journey KBs with no registration yet ("kb:<app_id>").
  // Requiring a registration hid a Journey KB entirely -- the B2B Portal has
  // one and was not registered, so the page could not reach it.
  const [selection, setSelection] = useState<string | null>(null)
  const [appsError, setAppsError] = useState<string | null>(null)
  const [overview, setOverview] = useState<KbOverview | null>(null)
  // Bumped after registering or renaming, so the picker and environments reload.
  const [appsTick, setAppsTick] = useState(0)
  const [newApp, setNewApp] = useState<null | { existingKb: { app_key: string; name: string } | null }>(null)

  useEffect(() => {
    let live = true
    Promise.all([automationService.listApplications(), knowledgeBaseService.listApps().catch(() => [])])
      .then(([registered, kbApps]) => {
        if (!live) return
        const list = registered.applications ?? []
        setApplications(list)
        setJourneyApps(kbApps)
        const requested = params.get('app')
        const requestedSelection = requested && (list.find(a => a.app_key === requested) ? `reg:${list.find(a => a.app_key === requested)!.id}` : kbApps.some(k => k.app_id === requested) ? `kb:${requested}` : null)
        const stored = window.localStorage.getItem(SELECTION_STORAGE_KEY)
        const valid = (key: string | null) =>
          !!key && (list.some(a => `reg:${a.id}` === key) || kbApps.some(k => `kb:${k.app_id}` === key))
        const firstWithKb = list.find(a => kbApps.some(k => k.app_id === a.app_key))
        setSelection(
          valid(requestedSelection) ? requestedSelection
            : valid(stored) ? stored
            : firstWithKb ? `reg:${firstWithKb.id}`
              : kbApps[0] ? `kb:${kbApps[0].app_id}`
                : list[0] ? `reg:${list[0].id}` : null
        )
      })
      .catch((err: any) => live && setAppsError(err?.message ?? 'Registered applications could not be read.'))
    return () => { live = false }
  }, [appsTick]) // URL application selection is read on the initial load.

  const selectedApp = selection?.startsWith('reg:') ? applications.find(a => `reg:${a.id}` === selection) ?? null : null
  const selectedAppId = selectedApp?.id ?? null
  // The Journey KB folder is keyed like the Automation KB's: the app_key.
  const kbKey = selectedApp?.app_key ?? (selection?.startsWith('kb:') ? selection.slice(3) : null)
  const appKey = kbKey && journeyApps.some(k => k.app_id === kbKey) ? kbKey : null
  const unregisteredKbs = journeyApps.filter(k => !applications.some(a => a.app_key === k.app_id))

  // The environment the page's URLs are for. Hosts come from Test Data (the
  // application's address per environment); the Knowledge Base holds routes.
  const [envAddresses, setEnvAddresses] = useState<Record<string, string>>({})
  const [envDefault, setEnvDefault] = useState<string | null>(null)
  const [kbEnv, setKbEnv] = useState<string | null>(null)
  const [dataAppId, setDataAppId] = useState<number | null>(null)
  const envKey = kbKey ? `kb_environment:${kbKey}` : null
  useEffect(() => {
    if (!kbKey) { setEnvAddresses({}); setEnvDefault(null); setKbEnv(null); setDataAppId(null); return }
    let live = true
    testDataService.apps()
      .then(({ apps }) => {
        if (!live) return
        const dataApp = apps.find(a => a.kb_app_id === kbKey) ?? null
        const addresses = dataApp?.addresses ?? {}
        const fallback = dataApp?.run_environment || Object.keys(addresses)[0] || null
        let stored: string | null = null
        try { stored = envKey ? window.localStorage.getItem(envKey) : null } catch { stored = null }
        setDataAppId(dataApp?.id ?? null)
        setEnvAddresses(addresses)
        setEnvDefault(dataApp?.run_environment ?? null)
        setKbEnv(stored && addresses[stored] ? stored : fallback)
      })
      .catch(() => { if (live) { setEnvAddresses({}); setKbEnv(null) } })
    return () => { live = false }
  }, [kbKey, envKey, appsTick])
  const chooseEnv = (value: string) => {
    setKbEnv(value)
    try { if (envKey) window.localStorage.setItem(envKey, value) } catch { /* per-visit only */ }
  }
  const envAddress = kbEnv ? envAddresses[kbEnv] ?? null : null

  useEffect(() => {
    if (!selection) return
    window.localStorage.setItem(SELECTION_STORAGE_KEY, selection)
    // Keep the Test Data and Discovery screens on the same application.
    if (selectedAppId) window.localStorage.setItem(SELECTED_APP_STORAGE_KEY, String(selectedAppId))
  }, [selection, selectedAppId])

  // Bumped after a publish or revert, so every stage reloads what changed.
  const [revision, setRevision] = useState(0)
  const [dataCoverage, setDataCoverage] = useState<{ profiles: number; ready: number; missing: number } | null>(null)
  const [pending, setPending] = useState(0)
  const [drawer, setDrawer] = useState<null | 'review' | 'history'>(null)
  useEffect(() => { if (params.get('review') === '1' && appKey) setDrawer('review') }, [params, appKey])

  const loadPending = useCallback(() => {
    if (!appKey) { setPending(0); return }
    knowledgeBaseService.changeSets(appKey, 'draft,conflicted').then(r => setPending(r.pending)).catch(() => undefined)
  }, [appKey])
  useEffect(loadPending, [loadPending])

  useEffect(() => {
    setOverview(null)
    setDataCoverage(null)
    if (!appKey) return
    let live = true
    knowledgeBaseService.overview(appKey).then(o => live && setOverview(o)).catch(() => undefined)
    knowledgeBaseService.testData(appKey).then(c => live && setDataCoverage({ profiles: c.profiles.length, ready: c.totals.ready, missing: c.totals.missing })).catch(() => undefined)
    return () => { live = false }
  }, [appKey, revision])

  const appName = selectedApp?.name ?? overview?.app_name ?? journeyApps.find(k => k.app_id === kbKey)?.app_name ?? kbKey ?? 'Knowledge Base'
  const registered = (result: { app_key: string; crawl_app_id: number | null }) => {
    setNewApp(null)
    const key = result.crawl_app_id ? `reg:${result.crawl_app_id}` : `kb:${result.app_key}`
    window.localStorage.setItem(SELECTION_STORAGE_KEY, key)
    setSelection(key)
    setAppsTick(t => t + 1)
    setRevision(r => r + 1)
    openStage('setup')
  }
  const refreshApp = () => { setAppsTick(t => t + 1); setRevision(r => r + 1) }
  const [deletedNote, setDeletedNote] = useState<string | null>(null)
  const deleted = (result: { name: string; archived_to: string | null }) => {
    try { window.localStorage.removeItem(SELECTION_STORAGE_KEY) } catch { /* storage unavailable */ }
    setSelection(null)
    setOverview(null)
    setDeletedNote(`${result.name} was deleted.${result.archived_to ? ` Its Knowledge Base folders were moved to knowledge_base/_deleted/${result.archived_to}.` : ''}`)
    openStage('setup')
    refreshApp()
  }

  const stages = useMemo(() => {
    const r = overview?.reconcile ?? {}
    const j = overview?.journeys
    const drift = (r.LABEL_DRIFT ?? 0) + (r.REF_BROKEN ?? 0)
    const s = (id: StageId, label: string, sub: string, state: StageState) => ({ id, label, sub, state })
    const registeredForCrawl = !!selectedApp && Object.keys(envAddresses).length > 0
    return [
      s('setup', 'Start here', !kbKey ? 'Register an application' : registeredForCrawl && appKey ? 'Registered · ready' : 'Finish registering', registeredForCrawl && appKey ? 'done' : kbKey ? 'attn' : 'idle'),
      s('sources', 'Sources', overview ? `${overview.sources.documents} document${overview.sources.documents === 1 ? '' : 's'}` : '—', overview ? 'done' : 'idle'),
      s('journeys', 'Journey KB', j ? `${j.authored} authored · ${overview?.sources.documents ?? 0} source documents` : '—', j?.authored ? 'done' : j ? 'attn' : 'idle'),
      s('model', 'App Model', overview ? `${overview.screens.catalogued} screens · ${overview.screens.observed ?? 0} observed controls` : '—', overview ? 'done' : 'idle'),
      s('testdata', 'Test Data', dataCoverage ? `${dataCoverage.profiles} profiles · ${dataCoverage.ready} ready · ${dataCoverage.missing} missing` : 'Checking coverage', dataCoverage?.ready ? 'done' : appKey ? 'attn' : 'idle'),
      s('crawl', 'Walk & Dry run', selectedApp ? 'Journeys and flows, live' : 'Add it in Test Data', selectedApp?.discovery ? 'done' : 'idle'),
      s('automation', 'Automation KB', overview ? `${overview.automation.flows} flows · ${overview.automation.selectors} selectors` : `${selectedApp?.knowledge_base.flows ?? 0} flow${selectedApp?.knowledge_base.flows === 1 ? '' : 's'}`, (overview?.automation.flows ?? selectedApp?.knowledge_base.flows ?? 0) > 0 ? 'done' : 'idle'),
      s('map', 'Journey Map', 'Steps · selectors · flows', j?.authored ? 'attn' : 'idle'),
      s('reconcile', 'Reconcile', overview ? `${drift} to decide · ${overview.screens.captured_unmapped ?? 0} captured, unmapped · ${Math.max(0, (r.NOT_CRAWLED ?? 0) - (overview.screens.captured_unmapped ?? 0))} not captured` : '—', drift || (r.NOT_CRAWLED ?? 0) ? 'attn' : overview ? 'done' : 'idle'),
      s('heal', 'Change & Heal', 'BRD changes · follow-ups', appKey ? 'done' : 'idle')
    ]
  }, [overview, dataCoverage, selectedApp, appKey, kbKey, envAddresses])
  const stageById = useMemo(() => new Map(stages.map((s, i) => [s.id, { ...s, n: i + 1 }])), [stages])

  const needsJourneyKb = ['sources', 'journeys', 'map', 'model', 'testdata', 'reconcile', 'heal'].includes(stage)

  return (
    <div className="flex flex-col gap-[18px]">
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-bold tracking-[0.14em] text-[#6B7280]">AUTOMATION · KNOWLEDGE BASE</span>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="m-0 text-[26px] font-bold tracking-[-0.02em] text-[#1F2937]">{appName}</h1>
            {kbKey && <RenameApplication appKey={kbKey} name={appName} canEdit={canExecute} onRenamed={refreshApp} />}
            {kbKey && <DeleteApplication appKey={kbKey} name={appName} canDelete={canApprove} onDeleted={deleted} />}
            <select
              aria-label="Application"
              value={selection ?? ''}
              onChange={e => { setSelection(e.target.value || null); setDeletedNote(null) }}
              className="h-[30px] rounded-[10px] border border-[#E8EAEE] bg-white px-2.5 text-[12.5px] font-semibold text-[#374151]"
            >
              {applications.length === 0 && unregisteredKbs.length === 0 && <option value="">No application</option>}
              {applications.map(a => (
                <option key={a.id} value={`reg:${a.id}`}>
                  {a.name}{journeyApps.some(k => k.app_id === a.app_key) ? '' : ' · no Journey KB'}
                </option>
              ))}
              {unregisteredKbs.map(k => (
                <option key={k.app_id} value={`kb:${k.app_id}`}>{k.app_name} · Journey KB · not registered</option>
              ))}
            </select>
            {Object.keys(envAddresses).length > 0 && (
              <select
                aria-label="Environment"
                value={kbEnv ?? ''}
                onChange={e => chooseEnv(e.target.value)}
                title="URLs on this page are built on this environment's address in Test Data"
                className="h-[30px] rounded-[10px] border border-[#E8EAEE] bg-white px-2.5 text-[12.5px] font-semibold text-[#374151]"
              >
                {Object.keys(envAddresses).map(e => <option key={e} value={e}>{e}{e === envDefault ? ' (default)' : ''}</option>)}
              </select>
            )}
            <Link to={dataAppId ? `/test-data?app=${dataAppId}` : '/test-data'} className="text-[12px] font-semibold text-[#B71920] hover:underline"
              title="Addresses per environment are managed in Test Data">
              {Object.keys(envAddresses).length ? 'Environments' : 'Add its addresses in Test Data'}
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-[#6B7280]">
            <span>{envAddress ?? selectedApp?.base_url ?? overview?.base_url ?? '—'}</span>
            {envAddress && (selectedApp?.base_url ?? overview?.base_url) && !String(selectedApp?.base_url ?? overview?.base_url).startsWith(envAddress.split('/').slice(0, 3).join('/')) && (
              <span title="The Knowledge Base was crawled on this host; its routes are the same on every environment">· crawled on {(selectedApp?.base_url ?? overview?.base_url ?? '').split('/').slice(0, 3).join('/')}</span>
            )}
            {overview && <><span>·</span><span>Journey KB {overview.app_id} · Automation KB {overview.automation_app_id}</span></>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setNewApp({ existingKb: null })} disabled={!canExecute}
            title={canExecute ? 'Register an application and create its Journey KB' : 'Needs the automation.execute permission'}
            className="h-[38px] rounded-[12px] border border-[#E8EAEE] bg-white px-4 text-[13px] font-bold text-[#B71920] hover:border-[#F6D4D5] disabled:cursor-not-allowed disabled:text-[#9CA3AF]">+ New application</button>
          <button type="button" onClick={() => setDrawer('history')} disabled={!appKey}
            className="h-[38px] rounded-[12px] border border-[#E8EAEE] bg-white px-4 text-[13px] font-bold text-[#1F2937] hover:border-[#F6D4D5] disabled:cursor-not-allowed disabled:text-[#9CA3AF]">History</button>
          <button type="button" onClick={() => setDrawer('review')} disabled={!appKey}
            className={`h-[38px] rounded-[12px] px-4 text-[13px] font-bold disabled:cursor-not-allowed ${pending ? 'bg-[#B71920] text-white hover:opacity-95' : 'border border-[#E8EAEE] bg-white text-[#1F2937] hover:border-[#F6D4D5]'}`}>
            {pending ? `Review ${pending} change set${pending === 1 ? '' : 's'}` : 'Change sets'}
          </button>
        </div>
      </header>

      {appsError && <Note tone="warn">{appsError}</Note>}
      {deletedNote && <Note>{deletedNote}</Note>}
      {overview && <div role="status" className="rounded-[14px] border border-[#D7E2F0] bg-[#F5F9FF] px-4 py-3 text-[12px] text-[#344054]">
        <strong className="block text-[13px] text-[#1F2937]">What this project has now</strong>
        <span>{overview.journeys.authored} authored journeys · {overview.screens.catalogued} catalogued screens · {overview.screens.observed ?? 0} browser-observed controls · {overview.screens.linked} approved control mappings · {overview.screens.captured_unmapped ?? 0} captured controls still unmapped · {dataCoverage?.profiles ?? 0} Test Data profiles ({dataCoverage?.ready ?? 0} ready for an environment).</span>
        <span className="mt-1 block">Captured controls are evidence, not executable locators. Unmapped controls must be reconciled and verified on the correct application screen. An authored journey may still need a linked source document.</span>
      </div>}

      <nav aria-label="Knowledge Base stages" className="grid gap-2 md:grid-cols-2 xl:grid-cols-[minmax(150px,0.7fr)_repeat(3,minmax(0,2fr))]">
        {PHASES.map((phase, p) => (
          <div key={phase.title} className="flex flex-col gap-1.5 rounded-[16px] border border-[#EEF0F3] bg-[#FAFAFB] p-2">
            <div className="flex items-baseline gap-2 px-1">
              <span className="whitespace-nowrap text-[10.5px] font-bold uppercase tracking-[0.12em] text-[#B71920]">Step {p + 1}</span>
              <span className="truncate text-[12px] font-bold text-[#1F2937]">{phase.title}</span>
              <span className="hidden truncate text-[11px] text-[#6B7280] 2xl:inline">· {phase.hint}</span>
            </div>
            <div className={`grid gap-1.5 ${phase.stages.length > 1 ? 'sm:grid-cols-3 xl:grid-cols-1' : ''}`}>
              {phase.stages.map(id => {
                const s = stageById.get(id)!
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => openStage(s.id)}
                    aria-current={stage === s.id ? 'step' : undefined}
                    className={`flex min-h-[48px] items-center gap-2 rounded-[12px] border px-2.5 text-left xl:min-h-[44px] ${stage === s.id ? 'border-[#F1A4A6] bg-[#FFF5F5] shadow-[0_0_0_1px_#F1A4A6]' : 'border-[#E8EAEE] bg-white hover:border-[#F6D4D5]'}`}
                  >
                    <span className={`box-border flex h-[24px] w-[24px] flex-shrink-0 items-center justify-center rounded-full text-[11.5px] font-bold ${DOT[s.state]}`}>{s.n}</span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[12.5px] font-bold text-[#1F2937]">{s.label}</span>
                      <span className="truncate text-[11px] text-[#6B7280]" title={s.sub}>{s.sub}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-[#F4F5F7] px-4 py-2.5 text-[12.5px] text-[#374151]">
        <span className="min-w-0 flex-1"><strong className="text-[#1F2937]">{stageById.get(stage)?.label}:</strong> {GUIDE[stage].what}</span>
        {GUIDE[stage].next && (
          <button type="button" onClick={() => openStage(GUIDE[stage].next!)} className="font-bold text-[#B71920] hover:underline">
            Next: {stageById.get(GUIDE[stage].next!)?.label} →
          </button>
        )}
      </div>

      {stage === 'setup' && !kbKey ? (
        <Card className="flex flex-col items-start gap-3 p-6">
          <h2 className="m-0 text-[16px] font-bold text-[#1F2937]">No application yet</h2>
          <p className="m-0 text-[12.5px] text-[#6B7280]">Register one to start: its name, its address in each environment and, if you have it, the list of its journeys.</p>
          <button type="button" onClick={() => setNewApp({ existingKb: null })} disabled={!canExecute}
            className="rounded-[12px] bg-[#B71920] px-4 py-2 text-[13px] font-bold text-white hover:opacity-95 disabled:opacity-50">+ New application</button>
        </Card>
      ) : stage === 'setup' && kbKey ? (
        <SetupStage key={`${kbKey}:${revision}`} appKey={appKey} kbKey={kbKey} name={appName} overview={overview} crawledFlows={selectedApp?.knowledge_base.flows ?? 0} canExecute={canExecute}
          onOpenStage={next => openStage(next)} onChanged={refreshApp}
          onRegister={() => setNewApp({ existingKb: { app_key: kbKey, name: appName } })} />
      ) : needsJourneyKb && !appKey ? (
        selectedApp && kbKey
          ? <CreateJourneyKbCard appKey={kbKey} name={appName} canExecute={canExecute} onCreated={refreshApp} />
          : <Card className="p-6"><Note tone="warn">Select an application.</Note></Card>
      ) : (
        <>
          {stage === 'sources' && appKey && (
            <SourcesStage key={revision} appKey={appKey} overview={overview} canExecute={canExecute}
              onDrafted={() => { loadPending(); setDrawer('review') }} onOpenChangeSets={() => setDrawer('review')} />
          )}
          {stage === 'journeys' && appKey && <JourneysStage key={revision} appKey={appKey} onOpenStage={openStage} canExecute={canExecute} canApprove={canApprove} onEdited={loadPending} />}
          {stage === 'map' && appKey && <JourneyMapStage key={`${appKey}:${revision}`} appKey={appKey} onOpenStage={openStage} canExecute={canExecute} canApprove={canApprove} onEdited={loadPending} />}
          {stage === 'model' && appKey && <ModelStage key={revision} appKey={appKey} canExecute={canExecute} canApprove={canApprove} onEdited={loadPending} />}
          {stage === 'testdata' && appKey && <TestDataStage key={revision} appKey={appKey} />}
          {stage === 'reconcile' && appKey && (
            <ReconcileStage key={revision} appKey={appKey} onDrafted={() => { loadPending(); setDrawer('review') }} />
          )}
          {(stage === 'crawl' || stage === 'automation') && !selectedApp && appKey && (
            <Card className="flex flex-col gap-3 p-6">
              <Note tone="warn">
                <strong>{overview?.app_name ?? appKey}</strong> has a Journey KB but is not an application yet.
                Crawling and the Automation KB screens need one: register it with its address for each environment.
              </Note>
              <button
                type="button"
                onClick={() => setNewApp({ existingKb: { app_key: appKey, name: appName } })}
                disabled={!canExecute}
                className="w-fit rounded-[12px] bg-[#B71920] px-4 py-2 text-[13px] font-bold text-white hover:opacity-95 disabled:opacity-50"
              >
                Register this application
              </button>
            </Card>
          )}
          {stage === 'crawl' && selectedApp && (
            <div className="flex flex-col gap-4">
              {appKey
                ? <JourneyCrawlStage key={`${appKey}.${selectedApp.id}.${kbEnv ?? ''}`} appKey={appKey} application={{ ...selectedApp, environment: kbEnv ?? selectedApp.environment, base_url: envAddress ?? selectedApp.base_url }} canExecute={canExecute} canApprove={canApprove}
                    onProposed={() => { loadPending(); setDrawer('review') }}
                    onAutomationReady={() => { setRevision(value => value + 1); openStage('automation') }} />
                : <Note>{selectedApp.name} has no Journey KB, so only the page-by-page crawl below applies.</Note>}
              <details className="rounded-[20px] border border-[#E8EAEE] bg-white" open={!appKey}>
                <summary className="cursor-pointer px-5 py-4 text-[14px] font-bold text-[#1F2937]">
                  Page-by-page crawl <span className="font-normal text-[12.5px] text-[#6B7280]">· walks every reachable page and builds the Automation KB flows</span>
                </summary>
                <div className="px-3 pb-3"><DiscoveryBody embedded appId={selectedAppId} environment={kbEnv} tabs={['crawler']} /></div>
              </details>
            </div>
          )}
          {stage === 'automation' && selectedApp && <DiscoveryBody embedded appId={selectedAppId} environment={kbEnv} tabs={['flows', 'urls', 'products', 'json_model']} />}
          {stage === 'heal' && appKey && (
            <HealStage key={revision} appKey={appKey} canExecute={canExecute}
              application={selectedApp ? { id: selectedApp.id, environment: selectedApp.environment } : null}
              onOpenStage={openStage} />
          )}
        </>
      )}
      {newApp && <NewApplicationDialog existingKb={newApp.existingKb} onClose={() => setNewApp(null)} onCreated={registered} />}
      {drawer && appKey && (
        <ChangeSetsDrawer
          appKey={appKey}
          tab={drawer}
          onTab={setDrawer}
          onClose={() => setDrawer(null)}
          onPublished={() => setRevision(r => r + 1)}
          onQueueChanged={loadPending}
          canDecide={canApprove}
          canEdit={canExecute}
        />
      )}
    </div>
  )
}

export default KnowledgeBase
