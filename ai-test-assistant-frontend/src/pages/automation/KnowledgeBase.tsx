/**
 * --- Knowledge Base ---------------------------------------------------------------
 *
 * One page for both Knowledge Bases of an application, in the order the work
 * happens:
 *
 *   design side       1 Sources · 2 Journey KB · 3 App Model
 *   application side  4 Test Data · 5 Journey Crawl · 6 Automation KB
 *   bringing together 7 Reconcile · 8 Change & Heal
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
import { useSearchParams } from 'react-router-dom'
import automationService from '../../services/automationService'
import knowledgeBaseService, { type JourneyKbApp, type KbOverview } from '../../services/knowledgeBaseService'
import { usePageHeader } from '../../components/layout/PageHeaderContext'
import { useAuth } from '../../hooks/useAuth'
import ChangeSetsDrawer from '../../components/knowledge-base/ChangeSetsDrawer'
import { SELECTED_APP_STORAGE_KEY, type RegisteredApplication } from '../../types/automation'
import { DiscoveryBody } from './Discovery'
import { Card, Note } from '../../components/knowledge-base/kbUi'
import SourcesStage from '../../components/knowledge-base/SourcesStage'
import JourneysStage from '../../components/knowledge-base/JourneysStage'
import ModelStage from '../../components/knowledge-base/ModelStage'
import TestDataStage from '../../components/knowledge-base/TestDataStage'
import ReconcileStage from '../../components/knowledge-base/ReconcileStage'
import JourneyCrawlStage from '../../components/knowledge-base/JourneyCrawlStage'
import HealStage from '../../components/knowledge-base/HealStage'

type StageId = 'sources' | 'journeys' | 'model' | 'testdata' | 'crawl' | 'automation' | 'reconcile' | 'heal'
type StageState = 'done' | 'attn' | 'idle'

const SELECTION_STORAGE_KEY = 'automation.knowledgeBase.selection'

const STAGE_IDS: StageId[] = ['sources', 'journeys', 'model', 'testdata', 'crawl', 'automation', 'reconcile', 'heal']

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
  const stage: StageId = STAGE_IDS.includes(params.get('stage') as StageId) ? (params.get('stage') as StageId) : 'sources'
  const openStage = useCallback((next: string) => {
    setParams(prev => { const p = new URLSearchParams(prev); p.set('stage', next); return p })
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

  useEffect(() => {
    let live = true
    Promise.all([automationService.listApplications(), knowledgeBaseService.listApps().catch(() => [])])
      .then(([registered, kbApps]) => {
        if (!live) return
        const list = registered.applications ?? []
        setApplications(list)
        setJourneyApps(kbApps)
        const stored = window.localStorage.getItem(SELECTION_STORAGE_KEY)
        const valid = (key: string | null) =>
          !!key && (list.some(a => `reg:${a.id}` === key) || kbApps.some(k => `kb:${k.app_id}` === key))
        const firstWithKb = list.find(a => kbApps.some(k => k.app_id === a.app_key))
        setSelection(
          valid(stored) ? stored
            : firstWithKb ? `reg:${firstWithKb.id}`
              : kbApps[0] ? `kb:${kbApps[0].app_id}`
                : list[0] ? `reg:${list[0].id}` : null
        )
      })
      .catch((err: any) => live && setAppsError(err?.message ?? 'Registered applications could not be read.'))
    return () => { live = false }
  }, [])

  const selectedApp = selection?.startsWith('reg:') ? applications.find(a => `reg:${a.id}` === selection) ?? null : null
  const selectedAppId = selectedApp?.id ?? null
  // The Journey KB folder is keyed like the Automation KB's: the app_key.
  const kbKey = selectedApp?.app_key ?? (selection?.startsWith('kb:') ? selection.slice(3) : null)
  const appKey = kbKey && journeyApps.some(k => k.app_id === kbKey) ? kbKey : null
  const unregisteredKbs = journeyApps.filter(k => !applications.some(a => a.app_key === k.app_id))

  useEffect(() => {
    if (!selection) return
    window.localStorage.setItem(SELECTION_STORAGE_KEY, selection)
    // Keep the Test Data and Discovery screens on the same application.
    if (selectedAppId) window.localStorage.setItem(SELECTED_APP_STORAGE_KEY, String(selectedAppId))
  }, [selection, selectedAppId])

  // Bumped after a publish or revert, so every stage reloads what changed.
  const [revision, setRevision] = useState(0)
  const [pending, setPending] = useState(0)
  const [drawer, setDrawer] = useState<null | 'review' | 'history'>(null)

  const loadPending = useCallback(() => {
    if (!appKey) { setPending(0); return }
    knowledgeBaseService.changeSets(appKey, 'draft,conflicted').then(r => setPending(r.pending)).catch(() => undefined)
  }, [appKey])
  useEffect(loadPending, [loadPending])

  useEffect(() => {
    setOverview(null)
    if (!appKey) return
    let live = true
    knowledgeBaseService.overview(appKey).then(o => live && setOverview(o)).catch(() => undefined)
    return () => { live = false }
  }, [appKey, revision])

  const stages = useMemo(() => {
    const r = overview?.reconcile ?? {}
    const j = overview?.journeys
    const drift = (r.LABEL_DRIFT ?? 0) + (r.REF_BROKEN ?? 0)
    const s = (id: StageId, label: string, sub: string, state: StageState) => ({ id, label, sub, state })
    return [
      s('sources', 'Sources', overview ? `${overview.sources.documents} documents` : '—', overview ? 'done' : 'idle'),
      s('journeys', 'Journey KB', j ? `${j.authored} authored · ${j.by_status.source_available ?? 0} ready` : '—', j && (j.by_status.source_available ?? 0) > 0 ? 'attn' : j ? 'done' : 'idle'),
      s('model', 'App Model', overview ? `${overview.screens.catalogued} screens` : '—', overview ? 'done' : 'idle'),
      s('testdata', 'Test Data', 'Coverage per environment', appKey ? 'attn' : 'idle'),
      s('crawl', 'Journey Crawl', selectedApp ? (selectedApp.discovery ? `Last page crawl: ${selectedApp.discovery.status}` : 'Walk a journey') : 'Register to crawl', selectedApp?.discovery ? 'done' : 'idle'),
      s('automation', 'Automation KB', overview ? `${overview.automation.flows} flows · ${overview.automation.selectors} selectors` : `${selectedApp?.knowledge_base.flows ?? 0} flows`, 'done'),
      s('reconcile', 'Reconcile', overview ? `${drift} to decide · ${r.NOT_CRAWLED ?? 0} not crawled` : '—', drift ? 'attn' : overview ? 'done' : 'idle'),
      s('heal', 'Change & Heal', 'BRD changes · follow-ups', appKey ? 'done' : 'idle')
    ]
  }, [overview, selectedApp, appKey])

  const [registering, setRegistering] = useState(false)
  const [registerError, setRegisterError] = useState<string | null>(null)
  // Registers a Journey KB application with the values its Automation KB
  // profile already holds, so it can be crawled. The same call Discovery's own
  // "Add application" form makes.
  const registerApplication = async () => {
    if (!appKey || !overview?.base_url) return
    setRegistering(true)
    setRegisterError(null)
    try {
      const created = await automationService.createApplication({
        name: overview.app_name, app_key: appKey, base_url: overview.base_url, environment: 'SIT'
      })
      const registered = await automationService.listApplications()
      setApplications(registered.applications ?? [])
      setSelection(`reg:${created.id}`)
    } catch (err: any) {
      setRegisterError(err?.message ?? 'The application could not be registered.')
    } finally {
      setRegistering(false)
    }
  }

  const needsJourneyKb = ['sources', 'journeys', 'model', 'testdata', 'reconcile', 'heal'].includes(stage)

  return (
    <div className="flex flex-col gap-[18px]">
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-bold tracking-[0.14em] text-[#6B7280]">AUTOMATION · KNOWLEDGE BASE</span>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="m-0 text-[26px] font-bold tracking-[-0.02em] text-[#1F2937]">{selectedApp?.name ?? overview?.app_name ?? 'Knowledge Base'}</h1>
            <select
              aria-label="Application"
              value={selection ?? ''}
              onChange={e => setSelection(e.target.value || null)}
              className="h-[30px] rounded-[10px] border border-[#E8EAEE] bg-white px-2.5 text-[12.5px] font-semibold text-[#374151]"
            >
              {applications.length === 0 && unregisteredKbs.length === 0 && <option value="">No application</option>}
              {applications.map(a => (
                <option key={a.id} value={`reg:${a.id}`}>
                  {a.name} · {a.environment}{journeyApps.some(k => k.app_id === a.app_key) ? '' : ' · no Journey KB'}
                </option>
              ))}
              {unregisteredKbs.map(k => (
                <option key={k.app_id} value={`kb:${k.app_id}`}>{k.app_name} · Journey KB · not registered</option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-[#6B7280]">
            <span>{selectedApp?.base_url ?? overview?.base_url ?? '—'}</span>
            {overview && <><span>·</span><span>Journey KB {overview.app_id} · Automation KB {overview.automation_app_id}</span></>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setDrawer('history')} disabled={!appKey}
            className="h-[38px] rounded-[12px] border border-[#E8EAEE] bg-white px-4 text-[13px] font-bold text-[#1F2937] hover:border-[#F6D4D5] disabled:cursor-not-allowed disabled:text-[#9CA3AF]">History</button>
          <button type="button" onClick={() => setDrawer('review')} disabled={!appKey}
            className={`h-[38px] rounded-[12px] px-4 text-[13px] font-bold disabled:cursor-not-allowed ${pending ? 'bg-[#B71920] text-white hover:opacity-95' : 'border border-[#E8EAEE] bg-white text-[#1F2937] hover:border-[#F6D4D5]'}`}>
            {pending ? `Review ${pending} change set${pending === 1 ? '' : 's'}` : 'Change sets'}
          </button>
        </div>
      </header>

      {appsError && <Note tone="warn">{appsError}</Note>}

      <nav aria-label="Knowledge Base stages" className="grid grid-cols-2 gap-2 md:grid-cols-4 2xl:grid-cols-8">
        {stages.map((s, i) => (
          <button
            key={s.id}
            type="button"
            onClick={() => openStage(s.id)}
            aria-current={stage === s.id ? 'step' : undefined}
            className={`flex min-h-[64px] items-center gap-2 rounded-[14px] border px-2.5 text-left ${stage === s.id ? 'border-[#F1A4A6] bg-[#FFF5F5] shadow-[0_0_0_1px_#F1A4A6]' : 'border-[#E8EAEE] bg-white hover:border-[#F6D4D5]'}`}
          >
            <span className={`box-border flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-full text-[12px] font-bold ${DOT[s.state]}`}>{i + 1}</span>
            <span className="flex min-w-0 flex-col">
              <span className="whitespace-nowrap text-[13px] font-bold text-[#1F2937]">{s.label}</span>
              <span className="truncate text-[11.5px] text-[#6B7280]">{s.sub}</span>
            </span>
          </button>
        ))}
      </nav>

      {needsJourneyKb && !appKey ? (
        <Card className="p-6">
          <Note tone="warn">
            {selectedApp || kbKey
              ? <>No Journey KB exists for <code>{kbKey}</code> yet. Its design journeys appear here once a Journey KB folder is created under <code>knowledge_base/journeys/{kbKey}</code>. The Crawl and Automation KB stages work without one.</>
              : 'Select an application.'}
          </Note>
        </Card>
      ) : (
        <>
          {stage === 'sources' && appKey && (
            <SourcesStage key={revision} appKey={appKey} overview={overview} canExecute={canExecute}
              onDrafted={() => { loadPending(); setDrawer('review') }} onOpenChangeSets={() => setDrawer('review')} />
          )}
          {stage === 'journeys' && appKey && <JourneysStage key={revision} appKey={appKey} onOpenStage={openStage} canExecute={canExecute} canApprove={canApprove} onEdited={loadPending} />}
          {stage === 'model' && appKey && <ModelStage key={revision} appKey={appKey} canExecute={canExecute} canApprove={canApprove} onEdited={loadPending} />}
          {stage === 'testdata' && appKey && <TestDataStage key={revision} appKey={appKey} />}
          {stage === 'reconcile' && appKey && (
            <ReconcileStage key={revision} appKey={appKey} onDrafted={() => { loadPending(); setDrawer('review') }} />
          )}
          {(stage === 'crawl' || stage === 'automation') && !selectedApp && appKey && (
            <Card className="flex flex-col gap-3 p-6">
              <Note tone="warn">
                <strong>{overview?.app_name ?? appKey}</strong> has a Journey KB but is not registered as an application yet.
                Crawling and the Automation KB screens work from a registration (name, base URL, environment).
              </Note>
              {registerError && <Note tone="warn">{registerError}</Note>}
              <button
                type="button"
                onClick={() => void registerApplication()}
                disabled={registering || !overview?.base_url}
                title={overview?.base_url ? `Registers ${appKey} with ${overview.base_url}, environment SIT` : 'The Automation KB profile has no base_url to register with'}
                className="w-fit rounded-[12px] bg-[#B71920] px-4 py-2 text-[13px] font-bold text-white hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {registering ? 'Registering…' : 'Register this application'}
              </button>
            </Card>
          )}
          {stage === 'crawl' && selectedApp && (
            <div className="flex flex-col gap-4">
              {appKey
                ? <JourneyCrawlStage key={`${appKey}.${selectedApp.id}`} appKey={appKey} application={selectedApp} canExecute={canExecute}
                    onProposed={() => { loadPending(); setDrawer('review') }} />
                : <Note>{selectedApp.name} has no Journey KB, so only the page-by-page crawl below applies.</Note>}
              <details className="rounded-[20px] border border-[#E8EAEE] bg-white" open={!appKey}>
                <summary className="cursor-pointer px-5 py-4 text-[14px] font-bold text-[#1F2937]">
                  Page-by-page crawl <span className="font-normal text-[12.5px] text-[#6B7280]">· walks every reachable page and builds the Automation KB flows</span>
                </summary>
                <div className="px-3 pb-3"><DiscoveryBody embedded appId={selectedAppId} tabs={['crawler']} /></div>
              </details>
            </div>
          )}
          {stage === 'automation' && selectedApp && <DiscoveryBody embedded appId={selectedAppId} tabs={['flows', 'urls', 'products', 'json_model']} />}
          {stage === 'heal' && appKey && (
            <HealStage key={revision} appKey={appKey} canExecute={canExecute}
              application={selectedApp ? { id: selectedApp.id, environment: selectedApp.environment } : null}
              onOpenStage={openStage} />
          )}
        </>
      )}
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
