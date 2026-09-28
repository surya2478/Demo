/**
 * --- Application Discovery & Ground Truth Model -------------------------
 *
 * Dedicated Application Discovery page for exploring Knowledge Base domain models,
 * inspecting full URL routes and query parameters, reviewing flow blueprints,
 * testing live element discovery crawls, and exporting the Application Model JSON.
 *
 * Everything on this screen is read for one selected application. It used to be
 * read for `'eand_ae'`, written into the source in two places, beside stat
 * tiles that fell back to that application's real numbers when nothing loaded
 * -- so an empty or broken Knowledge Base still rendered a confident-looking
 * dashboard. The application picker is now the top-level control, and the
 * fallbacks are gone: a value that did not load shows as not loaded.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  HiOutlineSearch,
  HiOutlineRefresh,
  HiOutlineTrash,
  HiOutlineExclamationCircle,
  HiOutlineCheckCircle,
  HiOutlineExternalLink,
  HiOutlineGlobeAlt,
  HiOutlineLink,
  HiOutlineDownload,
  HiOutlineClipboardCopy,
  HiOutlineCheck,
  HiOutlineCollection,
  HiOutlineDeviceMobile,
  HiOutlineCode,
  HiOutlineShieldCheck,
  HiOutlinePlus,
  HiOutlineX,
  HiOutlineOfficeBuilding,
  HiOutlineDatabase,
  HiOutlineSave
} from 'react-icons/hi'
import automationService from '../../services/automationService'
import { useAuth } from '../../hooks/useAuth'
import { usePageHeader } from '../../components/layout/PageHeaderContext'
import SectionCard from '../../components/ui/SectionCard'
import EmptyState from '../../components/ui/EmptyState'
import LoadingSkeleton from '../../components/ui/LoadingSkeleton'
import StatusBadge from '../../components/ui/StatusBadge'
import CodeViewer from '../../components/automation/CodeViewer'
import { StatTile, JobProgress } from '../../components/automation/workbenchPresentation'
import { GroundingBadge } from '../../components/automation/groundingPresentation'
import { isDiscoverySettled, SELECTED_APP_STORAGE_KEY } from '../../types/automation'
import type {
  DiscoveredElement,
  DiscoveryRun,
  GroundResult,
  KnowledgeBaseDraftResult,
  RegisteredApplication,
  WorkbenchCase,
  RuntimeStatusResponse
} from '../../types/automation'

/** A Knowledge Base folder name: lower-case slug, matching the API's pattern. */
const APP_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

const slugifyAppKey = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100)

/**
 * --- Routes, not absolute URLs ------------------------------------------
 *
 * A blueprint step used to carry a fully-qualified URL, and the compiler turned
 * every one into `page.goto(<absolute>)` -- a cold deep link per step, with the
 * session dropped between them. Steps now carry a route, and an `href` when the
 * Knowledge Base or a crawl recorded the link that reaches it, so the script
 * clicks through the application instead.
 *
 * This screen shows both: the route as stored, and how the step will actually
 * be reached. Absolute URLs still appear for a genuinely external destination,
 * which is the one case that cannot be routed.
 */
const isNavigationTarget = (target?: string | null): boolean => {
  const raw = (target ?? '').trim()
  // `//cdn...` is protocol-relative and `//div[...]` is an XPath; neither is a
  // route, which is why a bare leading-slash test is not enough.
  return /^https?:\/\//i.test(raw) || (raw.startsWith('/') && !raw.startsWith('//'))
}

const absoluteUrl = (target?: string | null, baseUrl?: string | null): string => {
  const raw = (target ?? '').trim()
  if (!raw || /^https?:\/\//i.test(raw)) return raw
  const origin = (baseUrl ?? '').trim().match(/^https?:\/\/[^/?#]+/i)?.[0]
  return origin ? `${origin}${raw}` : raw
}

/** Whether a step clicks the application's own link or navigates to the route. */
const NavigationMode: React.FC<{ step: any }> = ({ step }) => {
  const href = (step?.href ?? '').trim()
  if (href) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-app bg-app-success-bg px-1.5 py-0.5 text-[10px] font-medium text-app-success"
        title={`Clicks the in-app link a[href="${href}"], falling back to navigation if it is not on the page`}
      >
        <HiOutlineLink className="h-3 w-3" />
        clicks {href}
      </span>
    )
  }
  if (/^https?:\/\//i.test((step?.target ?? '').trim())) {
    return (
      <span className="text-[10px] text-app-warning" title="An external host cannot be reached relative to the application's base URL">
        external — navigates to the full URL
      </span>
    )
  }
  return (
    <span className="text-[10px] text-app-secondary" title="Navigates relative to the application's base URL, after looking for a link to this route">
      navigates to route
    </span>
  )
}

const hasPermission = (user: any, permission: string): boolean => {
  if (!user) return false
  const roles: string[] = (user.roles as string[]) || (user.role ? [user.role] : [])
  if (roles.some(r => String(r).toLowerCase() === 'admin')) return true
  const perms: string[] = (user.permissions as string[]) || []
  return perms.includes(permission)
}

const STRATEGY_TONE: Record<string, 'success' | 'info' | 'warning' | 'neutral'> = {
  testid: 'success',
  label: 'success',
  role: 'info',
  placeholder: 'warning',
  text: 'warning'
}

export type DiscoveryTab = 'urls' | 'flows' | 'products' | 'crawler' | 'json_model'

/**
 * `embedded` renders this screen inside a Knowledge Base page stage: no hero or
 * stat tiles (the host page has its own), only the `tabs` the stage asks for,
 * and the application the host has selected (`appId`). The page header is left
 * to the host too -- see the Discovery wrapper below for why that matters.
 */
export interface DiscoveryBodyProps {
  embedded?: boolean
  appId?: number | null
  tabs?: DiscoveryTab[]
}

export const DiscoveryBody: React.FC<DiscoveryBodyProps> = ({ embedded = false, appId = null, tabs }) => {
  const { user } = useAuth()
  const canExecute = hasPermission(user, 'automation.execute')

  const [activeTab, setActiveTab] = useState<DiscoveryTab>(tabs?.[0] ?? 'urls')
  const [appModel, setAppModel] = useState<any | null>(null)
  const [modelLoading, setModelLoading] = useState(true)
  const [modelError, setModelError] = useState<string | null>(null)
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const [copiedJson, setCopiedJson] = useState(false)

  // Applications: the identity everything below is scoped to.
  const [applications, setApplications] = useState<RegisteredApplication[]>([])
  const [selectedAppId, setSelectedAppId] = useState<number | null>(null)
  const [appsLoading, setAppsLoading] = useState(true)
  const [appsError, setAppsError] = useState<string | null>(null)
  const [draft, setDraft] = useState<KnowledgeBaseDraftResult | null>(null)
  const [showAddApp, setShowAddApp] = useState(false)
  const [newApp, setNewApp] = useState({ name: '', app_key: '', base_url: '', environment: 'SIT' })
  const [addingApp, setAddingApp] = useState(false)

  // Crawler State
  const [runtime, setRuntime] = useState<RuntimeStatusResponse | null>(null)
  const [discovery, setDiscovery] = useState<DiscoveryRun | null>(null)
  const [elements, setElements] = useState<DiscoveredElement[]>([])
  const [roles, setRoles] = useState<string[]>([])
  const [crawlLoading, setCrawlLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Blank means "use whatever the application is registered with", which is
  // the normal case -- these two only exist for crawling one application in a
  // different environment.
  const [url, setUrl] = useState('')
  const [environment, setEnvironment] = useState('')
  const [maxPages, setMaxPages] = useState(8)
  // On by default: a structural-only draft leaves every key the model compiler
  // reads blank, which is what made onboarding a new application an afternoon
  // of hand-editing. Off is the escape hatch for an air-gapped deployment, or
  // when a reviewer wants only what the crawl can state without inference.
  const [synthesiseDraft, setSynthesiseDraft] = useState(true)

  const [urlSearch, setUrlSearch] = useState('')
  const [urlTypeFilter, setUrlTypeFilter] = useState('all')

  const [crawlerSearch, setCrawlerSearch] = useState('')
  const [crawlerRoleFilter, setCrawlerRoleFilter] = useState('')

  const [selectedFlowId, setSelectedFlowId] = useState<string>('')
  const [grounding, setGrounding] = useState<GroundResult | null>(null)
  const [expandedGroundCase, setExpandedGroundCase] = useState<number | null>(null)

  const pollRef = useRef<number | null>(null)

  const selectedApp = useMemo(
    () => applications.find(a => a.id === selectedAppId) ?? null,
    [applications, selectedAppId]
  )

  // Load the registered applications, and settle on one.
  const loadApplications = useCallback(async (preferId?: number | null) => {
    setAppsLoading(true)
    setAppsError(null)
    try {
      const data = await automationService.listApplications()
      const list = data.applications ?? []
      setApplications(list)

      setSelectedAppId(current => {
        const wanted = preferId ?? current
        if (wanted && list.some(a => a.id === wanted)) return wanted
        const stored = Number(window.localStorage.getItem(SELECTED_APP_STORAGE_KEY))
        if (stored && list.some(a => a.id === stored)) return stored
        return list[0]?.id ?? null
      })
    } catch (err: any) {
      setAppsError(err?.message ?? 'Registered applications could not be read.')
    } finally {
      setAppsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadApplications()
    void automationService
      .getRuntime()
      .then(setRuntime)
      .catch(() => undefined)
    return () => {
      if (pollRef.current !== null) window.clearTimeout(pollRef.current)
    }
  }, [loadApplications])

  useEffect(() => {
    if (selectedAppId) {
      window.localStorage.setItem(SELECTED_APP_STORAGE_KEY, String(selectedAppId))
    }
  }, [selectedAppId])

  // Embedded: the host page owns the choice of application.
  useEffect(() => {
    if (embedded && appId && applications.some(a => a.id === appId)) setSelectedAppId(appId)
  }, [embedded, appId, applications])

  // Embedded: a stage that shows different tabs keeps a tab it offers.
  useEffect(() => {
    if (tabs?.length && !tabs.includes(activeTab)) setActiveTab(tabs[0])
  }, [tabs, activeTab])

  // Load the selected application's compiled model from its Knowledge Base.
  const loadAppModel = useCallback(async () => {
    if (!selectedApp) {
      setAppModel(null)
      setModelLoading(false)
      return
    }
    setModelLoading(true)
    setModelError(null)
    try {
      const data = await automationService.getApplicationModel(selectedApp.app_key)
      setAppModel(data)
      setSelectedFlowId(data?.flows?.[0]?.flow_id ?? '')
    } catch (err: any) {
      setAppModel(null)
      setModelError(
        err?.message ??
          `No Application Model could be compiled for "${selectedApp.app_key}".`
      )
    } finally {
      setModelLoading(false)
    }
  }, [selectedApp])

  // Load this application's own discovery state and element catalogue.
  const loadCrawlState = useCallback(async () => {
    if (!selectedAppId) {
      setDiscovery(null)
      setElements([])
      setRoles([])
      setCrawlLoading(false)
      return
    }
    setError(null)
    setCrawlLoading(true)
    try {
      const state = await automationService.getDiscovery(selectedAppId)
      setDiscovery(state.discovery)
      if (state.discovery?.status === 'completed') {
        const catalog = await automationService.listDiscoveredElements({
          applicationId: selectedAppId
        })
        setElements(catalog.elements ?? [])
        setRoles(catalog.roles ?? [])
      } else {
        setElements([])
        setRoles([])
      }
    } catch (err: any) {
      setError(err?.message ?? 'Discovery state could not be read.')
    } finally {
      setCrawlLoading(false)
    }
  }, [selectedAppId])

  // Switching application reloads both halves and drops the previous
  // application's grounding result, which does not describe this one.
  useEffect(() => {
    setGrounding(null)
    setDraft(null)
    setUrl('')
    setEnvironment('')
    void loadAppModel()
    void loadCrawlState()
  }, [loadAppModel, loadCrawlState])

  const poll = useCallback(async () => {
    if (!selectedAppId) return
    try {
      const state = await automationService.getDiscovery(selectedAppId)
      setDiscovery(state.discovery)
      if (state.discovery && isDiscoverySettled(state.discovery.status)) {
        await loadCrawlState()
        await loadApplications()
        return
      }
      pollRef.current = window.setTimeout(() => void poll(), 2000)
    } catch {
      await loadCrawlState()
    }
  }, [loadApplications, loadCrawlState, selectedAppId])

  const handleDiscover = async () => {
    if (!selectedAppId) return
    setBusy('discover')
    setError(null)
    setGrounding(null)
    try {
      const started = await automationService.startDiscovery({
        application_id: selectedAppId,
        // Blank inherits the registered base URL and environment.
        application_url: url.trim() || null,
        application_environment: environment.trim() || null,
        max_pages: maxPages
      })
      setDiscovery(started)
      void poll()
    } catch (err: any) {
      setError(err?.message ?? 'Discovery crawl could not be started.')
    } finally {
      setBusy(null)
    }
  }

  /**
   * Turn the current crawl into Knowledge Base files.
   *
   * A crawl catalogues elements into the database; the URL registry, flow
   * blueprints and product tabs are compiled from files on disk. Nothing
   * carried anything between the two, which is why a 476-element crawl moved
   * one tile and left the other three alone. This writes the half a crawl can
   * honestly state — the routes it walked, the locators it verified — for a
   * person to edit into ground truth.
   */
  const handleDraftKnowledgeBase = async () => {
    if (!selectedAppId) return
    setBusy('draft')
    setError(null)
    try {
      const result = await automationService.draftKnowledgeBase(
        selectedAppId,
        false,
        synthesiseDraft
      )
      setDraft(result)
      // The model is compiled from those files, so re-read both.
      await loadAppModel()
      await loadApplications()
    } catch (err: any) {
      setError(err?.message ?? 'The Knowledge Base draft could not be written.')
    } finally {
      setBusy(null)
    }
  }

  const handleAddApplication = async () => {
    const name = newApp.name.trim()
    const appKey = (newApp.app_key.trim() || slugifyAppKey(name))
    const baseUrl = newApp.base_url.trim()
    if (!name || !appKey || !baseUrl) return
    if (!APP_KEY_PATTERN.test(appKey)) {
      setAppsError('The Knowledge Base key must be lower-case letters, digits, "_" or "-".')
      return
    }
    setAddingApp(true)
    setAppsError(null)
    try {
      const created = await automationService.createApplication({
        name,
        app_key: appKey,
        base_url: baseUrl,
        environment: newApp.environment.trim() || 'SIT'
      })
      setShowAddApp(false)
      setNewApp({ name: '', app_key: '', base_url: '', environment: 'SIT' })
      await loadApplications(created.id)
    } catch (err: any) {
      setAppsError(err?.message ?? 'The application could not be registered.')
    } finally {
      setAddingApp(false)
    }
  }

  const handleCopyUrl = async (targetUrl: string) => {
    try {
      await navigator.clipboard.writeText(targetUrl)
      setCopiedUrl(targetUrl)
      setTimeout(() => setCopiedUrl(null), 1800)
    } catch {
      setCopiedUrl(null)
    }
  }

  const handleCopyJson = async () => {
    if (!appModel) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(appModel, null, 2))
      setCopiedJson(true)
      setTimeout(() => setCopiedJson(false), 2000)
    } catch {
      setCopiedJson(false)
    }
  }

  const handleDownloadJson = async () => {
    if (!selectedApp) return
    const fileName = `${selectedApp.app_key}_application_model.json`
    const save = (blob: Blob) => {
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(blobUrl)
    }
    try {
      save(await automationService.exportApplicationModelJson(selectedApp.app_key))
    } catch (err: any) {
      // Only fall back to what is already on screen -- and only when there is
      // something, so a failed export cannot save an empty or foreign model
      // under this application's name.
      if (!appModel) {
        setModelError(err?.message ?? 'The Application Model could not be exported.')
        return
      }
      save(new Blob([JSON.stringify(appModel, null, 2)], { type: 'application/json' }))
    }
  }

  // Filtered URL Registry
  const filteredUrls = useMemo(() => {
    const list: any[] = appModel?.url_registry || []
    const needle = urlSearch.trim().toLowerCase()
    return list.filter(u => {
      if (urlTypeFilter !== 'all' && u.url_type !== urlTypeFilter) return false
      if (!needle) return true
      return (
        u.name?.toLowerCase().includes(needle) ||
        u.url?.toLowerCase().includes(needle) ||
        u.category?.toLowerCase().includes(needle) ||
        u.description?.toLowerCase().includes(needle)
      )
    })
  }, [appModel, urlSearch, urlTypeFilter])

  // Filtered Elements
  const visibleElements = useMemo(() => {
    const needle = crawlerSearch.trim().toLowerCase()
    return elements.filter(e => {
      if (crawlerRoleFilter && e.role !== crawlerRoleFilter) return false
      if (!needle) return true
      return (
        (e.accessible_name ?? '').toLowerCase().includes(needle) ||
        e.element_name.toLowerCase().includes(needle) ||
        e.recommended_locator.toLowerCase().includes(needle)
      )
    })
  }, [elements, crawlerSearch, crawlerRoleFilter])

  const running = discovery ? !isDiscoverySettled(discovery.status) : false
  const activeFlow = useMemo(() => {
    return appModel?.flows?.find((f: any) => f.flow_id === selectedFlowId) || appModel?.flows?.[0]
  }, [appModel, selectedFlowId])

  // The origin the model's routes are relative to. Falls back to the selected
  // application's registered URL so the copy button still yields something
  // pasteable when the model has not loaded.
  const modelBaseUrl: string =
    appModel?.application_info?.base_url || selectedApp?.base_url || ''

  return (
    <div className="space-y-4">
      {!embedded && (<>
      {/* Dedicated Page Hero */}
      <section className="overflow-hidden rounded-[20px] border border-app bg-app-surface shadow-app-card">
        <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_auto]">
          <div className="px-6 py-5">
            <div className="flex flex-wrap items-center gap-2">
              {selectedApp?.knowledge_base.linked ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Knowledge Base linked · {selectedApp.knowledge_base.flows} flow
                  {selectedApp.knowledge_base.flows === 1 ? '' : 's'}
                </span>
              ) : selectedApp ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-orange-200 bg-app-warning-bg px-2.5 py-0.5 text-[11px] font-semibold text-app-warning">
                  <HiOutlineDatabase className="h-3 w-3" />
                  No Knowledge Base folder for "{selectedApp.app_key}"
                </span>
              ) : null}
              {appModel?.model_version && (
                <span className="text-[11px] font-medium text-app-secondary">
                  Model Version {appModel.model_version}
                </span>
              )}
            </div>
            <h1 className="mt-2 text-[26px] font-bold leading-tight tracking-[-0.02em] text-app-primary">
              <span className="text-app-brand-700">Application Discovery</span> & Model
            </h1>
            <p className="mt-1.5 max-w-2xl text-[13px] leading-5 text-app-secondary">
              Canonical URL matrix, interactive component blueprints, and configuration parameters
              compiled from the selected application's Knowledge Base for deterministic grounding.
            </p>

            {/* The application picker: everything on this page reads from it. */}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <HiOutlineOfficeBuilding className="h-4 w-4 text-app-secondary" />
              <select
                value={selectedAppId ?? ''}
                onChange={e => setSelectedAppId(Number(e.target.value) || null)}
                disabled={appsLoading || applications.length === 0}
                className="app-input min-w-[240px] font-semibold"
                aria-label="Application"
              >
                {applications.length === 0 && (
                  <option value="">
                    {appsLoading ? 'Loading applications…' : 'No application registered'}
                  </option>
                )}
                {applications.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.environment}
                  </option>
                ))}
              </select>
              {selectedApp && (
                <span className="font-mono text-[11px] text-app-secondary truncate max-w-[320px]">
                  {selectedApp.base_url}
                </span>
              )}
              <button
                type="button"
                onClick={() => setShowAddApp(v => !v)}
                disabled={!canExecute}
                className="app-btn app-btn-secondary inline-flex items-center gap-1 text-[12px] disabled:opacity-50"
              >
                {showAddApp ? <HiOutlineX className="h-3.5 w-3.5" /> : <HiOutlinePlus className="h-3.5 w-3.5" />}
                {showAddApp ? 'Cancel' : 'Add application'}
              </button>
            </div>

            {appsError && (
              <div className="mt-2 flex items-start gap-2 rounded-app border border-red-200 bg-app-danger-bg px-3 py-2 text-[12px] text-app-danger">
                <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>{appsError}</span>
              </div>
            )}

            {showAddApp && (
              <div className="mt-3 grid gap-2 rounded-app border border-app bg-app-surface-muted/40 p-3 sm:grid-cols-2">
                <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-app-secondary sm:col-span-2">
                  Register an application
                </label>
                <input
                  value={newApp.name}
                  onChange={e => setNewApp({ ...newApp, name: e.target.value })}
                  placeholder="Display name"
                  className="app-input"
                  aria-label="Application name"
                />
                <input
                  value={newApp.base_url}
                  onChange={e => setNewApp({ ...newApp, base_url: e.target.value })}
                  placeholder="Base URL"
                  className="app-input"
                  aria-label="Base URL"
                />
                <input
                  value={newApp.app_key}
                  onChange={e => setNewApp({ ...newApp, app_key: e.target.value })}
                  placeholder={
                    newApp.name
                      ? `Knowledge Base key (default: ${slugifyAppKey(newApp.name)})`
                      : 'Knowledge Base key'
                  }
                  className="app-input font-mono"
                  aria-label="Knowledge Base key"
                />
                <input
                  value={newApp.environment}
                  onChange={e => setNewApp({ ...newApp, environment: e.target.value })}
                  placeholder="Environment"
                  className="app-input"
                  aria-label="Environment"
                />
                <p className="text-[11px] leading-4 text-app-secondary sm:col-span-2">
                  The key names the folder under <code className="font-mono">knowledge_base/applications/</code>{' '}
                  holding this application's profile and flow blueprints. It can be crawled before that
                  folder exists — the model tabs stay empty until it does.
                </p>
                <div className="sm:col-span-2">
                  <button
                    type="button"
                    onClick={() => void handleAddApplication()}
                    disabled={
                      addingApp ||
                      !newApp.name.trim() ||
                      !newApp.base_url.trim()
                    }
                    className="app-btn app-btn-primary inline-flex items-center gap-1.5 text-[12px] disabled:opacity-50"
                  >
                    <HiOutlinePlus className="h-3.5 w-3.5" />
                    {addingApp ? 'Registering…' : 'Register application'}
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-app bg-app-surface-muted/30 px-6 py-4 lg:border-l lg:border-t-0">
            <button
              type="button"
              onClick={handleDownloadJson}
              disabled={!selectedApp}
              className="app-btn app-btn-primary inline-flex items-center gap-1.5 shadow-sm disabled:opacity-50"
              title="Download the Application Model JSON"
            >
              <HiOutlineDownload className="h-4 w-4" />
              Download Model (JSON)
            </button>
            <button
              type="button"
              onClick={handleCopyJson}
              className="app-btn app-btn-secondary inline-flex items-center gap-1.5"
              title="Copy Model JSON to clipboard"
            >
              {copiedJson ? (
                <>
                  <HiOutlineCheck className="h-4 w-4 text-emerald-600" />
                  Copied!
                </>
              ) : (
                <>
                  <HiOutlineClipboardCopy className="h-4 w-4" />
                  Copy JSON
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                void loadApplications()
                void loadAppModel()
                void loadCrawlState()
              }}
              className="app-btn app-btn-secondary inline-flex items-center gap-1.5"
              title="Reload data"
            >
              <HiOutlineRefresh className="h-4 w-4" />
            </button>
          </div>
        </div>
      </section>

      {/* Top Stat Metrics */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile
          label="Target Application"
          value={selectedApp?.name ?? (appsLoading ? '—' : 'None registered')}
          hint={selectedApp ? `${selectedApp.app_key} · ${selectedApp.environment}` : 'Add one to begin'}
        />
        <StatTile
          label="Flow Blueprints"
          value={modelLoading ? '—' : appModel?.summary?.total_flows ?? 0}
          tone="default"
          hint={
            appModel?.flows?.length
              ? appModel.flows.map((f: any) => f.category).join(', ')
              : 'None in the Knowledge Base'
          }
        />
        <StatTile
          label="Catalog Products / SKUs"
          value={modelLoading ? '—' : appModel?.summary?.total_known_products ?? 0}
          tone={appModel?.summary?.total_known_products ? 'success' : 'default'}
          hint="Direct configuration routes mapped"
        />
        <StatTile
          label="Canonical URL Routes"
          value={modelLoading ? '—' : appModel?.summary?.total_registered_urls ?? 0}
          tone="default"
          hint="Compiled endpoints & queries"
        />
        <StatTile
          label="Live Elements Discovered"
          value={crawlLoading ? '—' : elements.length}
          tone={elements.length ? 'success' : 'default'}
          hint={discovery?.version ? `Crawl v${discovery.version}` : 'Ready to crawl'}
        />
      </div>
      </>)}

      {/* Navigation Sub-Tabs */}
      <div className="flex border-b border-app bg-app-surface px-4 pt-2">
        <nav className="flex space-x-4">
          {[
            { id: 'urls', label: 'Full URL Registry', icon: HiOutlineGlobeAlt, badge: appModel?.summary?.total_registered_urls },
            { id: 'flows', label: 'Flow Blueprints & Canonical Steps', icon: HiOutlineCollection, badge: appModel?.summary?.total_flows },
            { id: 'products', label: 'Device & SKU Catalog', icon: HiOutlineDeviceMobile, badge: appModel?.summary?.total_known_products },
            { id: 'crawler', label: 'Live Crawl & Grounding', icon: HiOutlineLink, badge: elements.length || undefined },
            { id: 'json_model', label: 'Application Model JSON', icon: HiOutlineCode }
          ].filter(tab => !tabs || tabs.includes(tab.id as DiscoveryTab)).map(tab => {
            const Icon = tab.icon
            const active = activeTab === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id as DiscoveryTab)}
                className={`flex items-center gap-2 border-b-2 py-3 px-2 text-sm font-semibold transition ${
                  active
                    ? 'border-app-brand-700 text-app-brand-700'
                    : 'border-transparent text-app-secondary hover:border-app-secondary/30 hover:text-app-primary'
                }`}
              >
                <Icon className="h-4 w-4" />
                <span>{tab.label}</span>
                {tab.badge !== undefined && (
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                    active ? 'bg-app-brand-50 text-app-brand-700 border border-app-brand-200' : 'bg-app-surface-muted text-app-secondary'
                  }`}>
                    {tab.badge}
                  </span>
                )}
              </button>
            )
          })}
        </nav>
      </div>

      {/* ── TAB 1: FULL URL REGISTRY ────────────────────────────────────── */}
      {activeTab === 'urls' && (
        <div className="space-y-3">
          {/* Security & Overlay Banner Alert */}
          {appModel?.application_info?.security_profile && (
            <div className="flex items-center justify-between rounded-app border border-blue-200 bg-blue-50/50 p-3.5 text-[12px] text-blue-900">
              <div className="flex items-center gap-2.5">
                <HiOutlineShieldCheck className="h-5 w-5 text-blue-700 flex-shrink-0" />
                <div>
                  <span className="font-semibold">Security & Cookie Policy Grounding: </span>
                  WAF Provider: <span className="font-medium">{appModel.application_info.security_profile.waf_provider}</span> · 
                  Cookie Shadow DOM Host: <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-blue-800">{appModel.application_info.security_profile.cookie_overlay?.host_selector}</code>
                </div>
              </div>
              <span className="rounded bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-800">
                Min Inter-step Delay: {appModel.application_info.security_profile.rate_limit_policy?.min_inter_step_delay_ms}ms
              </span>
            </div>
          )}

          <SectionCard
            title="Registered URL Routing Matrix"
            description="Complete directory of canonical URLs, query parameter schemas, and interactable component selectors."
            noPadding
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <HiOutlineSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-app-secondary" />
                  <input
                    value={urlSearch}
                    onChange={e => setUrlSearch(e.target.value)}
                    placeholder="Search URL or product..."
                    className="app-input w-[220px] pl-8"
                  />
                </div>
                <select
                  value={urlTypeFilter}
                  onChange={e => setUrlTypeFilter(e.target.value)}
                  className="app-input"
                  aria-label="Filter by URL type"
                >
                  <option value="all">All URL Types</option>
                  <option value="Homepage">Homepage</option>
                  <option value="Catalog_Listing">Catalog Listings</option>
                  <option value="Product_Configuration">Product Configuration (PDP)</option>
                  <option value="Cart_Checkout">Shopping Cart & Checkout</option>
                </select>
              </div>
            }
          >
            {modelLoading ? (
              <div className="p-6">
                <LoadingSkeleton className="h-28 w-full" rounded="lg" />
              </div>
            ) : filteredUrls.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  title="No URLs found"
                  description={
                    modelError ??
                    (appModel
                      ? 'Try adjusting your filter or search criteria.'
                      : selectedApp
                      ? `No Knowledge Base profile is compiled for "${selectedApp.app_key}" yet.`
                      : 'Register an application to see its URL registry.')
                  }
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="app-table">
                  <thead>
                    <tr>
                      <th className="text-left">Type</th>
                      <th className="text-left">Endpoint Name / Description</th>
                      <th className="text-left">Full URL Route</th>
                      <th className="text-left">Query Parameters</th>
                      <th className="text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUrls.map((u, i) => (
                      <tr key={i} className="hover:bg-app-surface-muted/50">
                        <td className="align-top whitespace-nowrap">
                          <StatusBadge
                            tone={
                              u.url_type === 'Homepage'
                                ? 'neutral'
                                : u.url_type === 'Catalog_Listing'
                                ? 'info'
                                : u.url_type === 'Product_Configuration'
                                ? 'success'
                                : 'warning'
                            }
                            size="sm"
                          >
                            {u.url_type.replace('_', ' ')}
                          </StatusBadge>
                          <div className="mt-1 text-[11px] text-app-secondary font-medium">{u.category}</div>
                        </td>
                        <td className="align-top max-w-[240px]">
                          <div className="font-semibold text-app-primary text-[12px]">{u.name}</div>
                          <div className="text-[11px] text-app-secondary mt-0.5 leading-snug">{u.description}</div>
                        </td>
                        <td className="align-top">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-[11px] text-app-brand-800 break-all bg-app-surface-muted px-2 py-1 rounded border border-app">
                              {u.url}
                            </span>
                            <a
                              href={u.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-app-secondary hover:text-app-brand-700 p-1 flex-shrink-0"
                              title="Open URL in new tab"
                            >
                              <HiOutlineExternalLink className="h-3.5 w-3.5" />
                            </a>
                          </div>
                          {u.associated_selectors?.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap items-center gap-1">
                              <span className="text-[10px] uppercase font-semibold text-app-secondary">Selectors:</span>
                              {u.associated_selectors.slice(0, 2).map((sel: string, si: number) => (
                                <code key={si} className="rounded bg-app-surface-muted px-1 py-0.5 font-mono text-[10px] text-app-secondary truncate max-w-[200px]" title={sel}>
                                  {sel}
                                </code>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="align-top whitespace-nowrap">
                          {Object.keys(u.query_parameters || {}).length > 0 ? (
                            <div className="space-y-0.5 text-[11px] font-mono">
                              {Object.entries(u.query_parameters).map(([k, v]) => (
                                <div key={k} className="text-app-secondary">
                                  <span className="font-semibold text-app-primary">{k}:</span> {String(v)}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <span className="text-[11px] text-app-secondary/60">—</span>
                          )}
                        </td>
                        <td className="align-top text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => handleCopyUrl(u.url)}
                            className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold text-app-secondary hover:bg-app-surface-muted hover:text-app-primary border border-app transition"
                            title="Copy full URL"
                          >
                            {copiedUrl === u.url ? (
                              <>
                                <HiOutlineCheck className="h-3 w-3 text-emerald-600" />
                                Copied
                              </>
                            ) : (
                              <>
                                <HiOutlineClipboardCopy className="h-3 w-3" />
                                Copy
                              </>
                            )}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </div>
      )}

      {/* ── TAB 2: FLOW BLUEPRINTS & CANONICAL STEPS ─────────────────────── */}
      {activeTab === 'flows' && (
        <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          {/* Flow Selection Sidebar */}
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-app-secondary px-1">
              Registered Flows ({appModel?.flows?.length ?? 0})
            </div>
            {appModel?.flows?.map((f: any) => {
              const selected = f.flow_id === (activeFlow?.flow_id || '')
              return (
                <button
                  key={f.flow_id}
                  type="button"
                  onClick={() => setSelectedFlowId(f.flow_id)}
                  className={`w-full rounded-app border p-3 text-left transition ${
                    selected
                      ? 'border-app-brand-300 bg-white shadow-sm ring-1 ring-app-brand-200'
                      : 'border-app bg-app-surface hover:border-app-brand-100 hover:bg-app-surface-muted'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase text-app-brand-700">{f.category}</span>
                    <span className="text-[10px] text-app-secondary">{f.canonical_steps?.length} steps</span>
                  </div>
                  <div className="mt-1 font-semibold text-app-primary text-[13px]">{f.flow_name}</div>
                  <div className="mt-1 text-[11px] text-app-secondary truncate">{f.catalog_entrypoint_url}</div>
                </button>
              )
            })}
          </div>

          {/* Active Flow Inspection */}
          {activeFlow ? (
            <div className="space-y-3">
              <SectionCard
                title={activeFlow.flow_name}
                description={`Category: ${activeFlow.category} · Flow ID: ${activeFlow.flow_id}`}
                actions={
                  <a
                    href={activeFlow.catalog_entrypoint_url}
                    target="_blank"
                    rel="noreferrer"
                    className="app-btn app-btn-secondary inline-flex items-center gap-1 text-[12px]"
                  >
                    Open Catalog <HiOutlineExternalLink className="h-3.5 w-3.5" />
                  </a>
                }
              >
                {/* Automation Boundary */}
                <div className="mb-4 rounded-app border border-emerald-200 bg-emerald-50/50 p-3 text-[12px]">
                  <div className="font-semibold text-emerald-900">Automation Scope Boundary:</div>
                  <div className="text-emerald-800 mt-0.5">{activeFlow.automation_boundary?.automated_scope}</div>
                  <div className="text-[11px] text-emerald-700/80 mt-1 italic">{activeFlow.automation_boundary?.external_boundary}</div>
                </div>

                {/* Canonical Steps Table */}
                <div className="overflow-x-auto rounded-app border border-app">
                  <table className="app-table">
                    <thead>
                      <tr>
                        <th className="text-center w-12">#</th>
                        <th className="text-left">Action & Description</th>
                        <th className="text-left">Target Route / Selector</th>
                        <th className="text-left">Expected Verification Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeFlow.canonical_steps?.map((step: any) => (
                        <tr key={step.step_number} className="hover:bg-app-surface-muted/50">
                          <td className="text-center font-semibold text-app-secondary">{step.step_number}</td>
                          <td className="text-[12px] font-semibold text-app-primary max-w-[260px]">{step.action}</td>
                          <td className="text-[11px]">
                            {isNavigationTarget(step.target) ? (
                              <div className="space-y-1">
                                <div className="flex items-center gap-1 font-mono text-app-brand-700 break-all">
                                  <span>{step.target}</span>
                                  <button
                                    type="button"
                                    // The route is what the script navigates by;
                                    // what a person wants on their clipboard is
                                    // a URL they can paste into a browser.
                                    onClick={() => handleCopyUrl(absoluteUrl(step.target, modelBaseUrl))}
                                    className="text-app-secondary hover:text-app-primary p-0.5"
                                    title="Copy the full URL"
                                  >
                                    <HiOutlineClipboardCopy className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                                <NavigationMode step={step} />
                              </div>
                            ) : (
                              <code className="rounded bg-app-surface-muted px-1.5 py-0.5 font-mono text-app-secondary">{step.target || '—'}</code>
                            )}
                          </td>
                          <td className="text-[12px] text-app-secondary">{step.expected_result}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Target Match Keywords */}
                {activeFlow.target_match_keywords?.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-app">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-app-secondary mb-1.5">
                      Grounding Match Keywords
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {activeFlow.target_match_keywords.map((kw: string, i: number) => (
                        <span key={i} className="rounded-full border border-app bg-app-surface-muted px-2.5 py-0.5 text-[11px] text-app-secondary font-mono">
                          {kw}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </SectionCard>
            </div>
          ) : (
            <EmptyState title="No flow selected" description="Select a flow blueprint from the left list." />
          )}
        </div>
      )}

      {/* ── TAB 3: DEVICE & SKU CATALOG ─────────────────────────────────── */}
      {activeTab === 'products' && (
        <div className="space-y-4">
          {Object.entries(appModel?.products_catalog || {}).map(([category, products]: [string, any]) => (
            <SectionCard
              key={category}
              title={`${category} Products & SKUs`}
              description={`Registered catalog items with resolved direct configuration URLs (${products.length} devices)`}
              noPadding
            >
              <div className="overflow-x-auto">
                <table className="app-table">
                  <thead>
                    <tr>
                      <th className="text-left">Device Name</th>
                      <th className="text-left">Identifiers</th>
                      <th className="text-left">Variants (Storage & Colors)</th>
                      <th className="text-left">Payment Options</th>
                      <th className="text-left">Direct Configuration Route</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p: any, idx: number) => (
                      <tr key={idx} className="hover:bg-app-surface-muted/50">
                        <td className="align-top">
                          <div className="font-bold text-[13px] text-app-primary">{p.product_name}</div>
                          <div className="text-[11px] text-emerald-700 font-semibold mt-0.5">Price: {p.default_price}</div>
                        </td>
                        <td className="align-top whitespace-nowrap font-mono text-[11px] text-app-secondary">
                          <div><span className="font-semibold text-app-primary">PID:</span> {p.product_id}</div>
                          <div><span className="font-semibold text-app-primary">SKU:</span> {p.sku_id}</div>
                        </td>
                        <td className="align-top text-[11px]">
                          {p.available_storage?.length > 0 && (
                            <div className="mb-1">
                              <span className="font-semibold text-app-secondary">Storage: </span>
                              {p.available_storage.join(', ')}
                            </div>
                          )}
                          {p.available_colors?.length > 0 && (
                            <div>
                              <span className="font-semibold text-app-secondary">Colors: </span>
                              {p.available_colors.join(', ')}
                            </div>
                          )}
                        </td>
                        <td className="align-top text-[11px] text-app-secondary">
                          {p.payment_plans?.slice(0, 2).map((plan: string, pi: number) => (
                            <div key={pi}>• {plan}</div>
                          ))}
                        </td>
                        <td className="align-top">
                          <div className="flex items-center gap-1 font-mono text-[11px] text-app-brand-800 break-all bg-app-surface-muted p-1.5 rounded border border-app">
                            <span>{p.direct_configuration_url}</span>
                            <button
                              type="button"
                              onClick={() => handleCopyUrl(p.direct_configuration_url)}
                              className="text-app-secondary hover:text-app-primary p-0.5 flex-shrink-0"
                              title="Copy URL"
                            >
                              <HiOutlineClipboardCopy className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          ))}
        </div>
      )}

      {/* ── TAB 4: LIVE CRAWLER & GROUNDING ─────────────────────────────── */}
      {activeTab === 'crawler' && (
        <div className="space-y-4">
          <SectionCard
            title="Live Application Discovery Crawler"
            description="Crawls the selected application's registered URL, cataloguing its controls and verifying accessible locators. The catalogue is stored against that application alone."
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  placeholder={selectedApp?.base_url ?? 'Register an application first'}
                  className="app-input w-[280px]"
                  aria-label="Crawl URL, overriding the registered base URL"
                  title="Leave blank to crawl the application's registered base URL"
                />
                <input
                  value={environment}
                  onChange={e => setEnvironment(e.target.value)}
                  placeholder={selectedApp?.environment ?? 'Environment'}
                  className="app-input w-24"
                  aria-label="Environment, overriding the registered one"
                  title="Leave blank to use the application's registered environment"
                />
                <input
                  type="number"
                  min={1}
                  max={40}
                  value={maxPages}
                  onChange={e => setMaxPages(Number(e.target.value) || 8)}
                  className="app-input w-20"
                  aria-label="Max pages"
                />
                <button
                  type="button"
                  onClick={handleDiscover}
                  disabled={!canExecute || !selectedAppId || busy !== null || running}
                  className="app-btn app-btn-primary inline-flex items-center gap-1.5 disabled:opacity-50"
                >
                  <HiOutlineGlobeAlt className="h-4 w-4" />
                  {running ? 'Crawling...' : 'Crawl Application'}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setBusy('ground')
                    try {
                      const res = await automationService.groundCases([], selectedAppId)
                      setGrounding(res)
                    } catch (e: any) {
                      setError(e.message)
                    } finally {
                      setBusy(null)
                    }
                  }}
                  disabled={!canExecute || busy !== null || !discovery || discovery.status !== 'completed'}
                  className="app-btn app-btn-secondary inline-flex items-center gap-1.5 disabled:opacity-50"
                >
                  <HiOutlineLink className="h-4 w-4" />
                  Check Grounding
                </button>
                <label
                  className="inline-flex items-center gap-1.5 text-[11px] text-app-secondary"
                  title="Ask a model to classify the crawl into url_templates, endpoints, selector groups and grounding rules. Every proposal is checked back against the crawl, so a selector it never verified is dropped."
                >
                  <input
                    type="checkbox"
                    checked={synthesiseDraft}
                    onChange={e => setSynthesiseDraft(e.target.checked)}
                    disabled={busy !== null}
                  />
                  Synthesise profile
                </label>
                <button
                  type="button"
                  onClick={() => void handleDraftKnowledgeBase()}
                  disabled={
                    !canExecute || busy !== null || !discovery || discovery.status !== 'completed'
                  }
                  className="app-btn app-btn-secondary inline-flex items-center gap-1.5 disabled:opacity-50"
                  title="Write Knowledge Base files from this crawl, for review"
                >
                  <HiOutlineSave className="h-4 w-4" />
                  {busy === 'draft' ? 'Drafting…' : 'Draft Knowledge Base'}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    // Scoped: clears this application's catalogue only.
                    await automationService.deleteDiscovery(selectedAppId)
                    setGrounding(null)
                    await loadCrawlState()
                    await loadApplications()
                  }}
                  disabled={!canExecute || busy !== null || !discovery}
                  className="app-btn app-btn-secondary text-app-danger inline-flex items-center gap-1.5 disabled:opacity-50"
                >
                  <HiOutlineTrash className="h-4 w-4" />
                  Clear
                </button>
              </div>
            }
          >
            {runtime && !runtime.ready && (
              <div className="mb-3 flex items-start gap-2 rounded-app border border-orange-200 bg-app-warning-bg px-3 py-2.5 text-[12px] text-app-warning">
                <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>The browser runtime is unavailable, so a live crawl would be refused.</span>
              </div>
            )}

            {running && (
              <div className="mb-3">
                <JobProgress
                  percent={discovery?.status === 'queued' ? 5 : 55}
                  message={`Crawling ${discovery?.application_url ?? url ?? selectedApp?.base_url ?? ''}…`}
                />
              </div>
            )}

            {error && (
              <div className="mb-3 flex items-start gap-2 rounded-app border border-red-200 bg-app-danger-bg px-3 py-3 text-[13px] text-app-danger">
                <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {draft && (
              <div className="mb-3 rounded-app border border-blue-200 bg-blue-50/50 p-3 text-[12px] text-blue-900">
                <div className="flex items-center gap-2 font-semibold">
                  <HiOutlineDatabase className="h-4 w-4 flex-shrink-0" />
                  Knowledge Base draft from crawl v{draft.crawl_version} —{' '}
                  {draft.pages_crawled} page(s), {draft.elements_catalogued} element(s)
                  {draft.pages_blocked > 0 && `, ${draft.pages_blocked} page(s) blocked`}
                </div>
                <div className="mt-1.5 font-mono text-[11px] break-all">{draft.kb_dir}</div>
                {draft.written.map(path => (
                  <div key={path} className="mt-1 flex items-start gap-1.5">
                    <HiOutlineCheckCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-emerald-600" />
                    <span className="font-mono text-[11px] break-all">{path}</span>
                  </div>
                ))}
                {draft.skipped.map(entry => (
                  <div key={entry.path} className="mt-1 flex items-start gap-1.5 text-blue-800/80">
                    <HiOutlineExclamationCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                    <span>
                      <span className="font-mono text-[11px] break-all">{entry.path}</span>
                      <span className="block text-[11px] leading-4">{entry.reason}</span>
                    </span>
                  </div>
                ))}
                {draft.synthesis_requested && !draft.synthesis && (
                  <div className="mt-2 flex items-start gap-1.5 text-app-warning">
                    <HiOutlineExclamationCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                    <span className="text-[11px] leading-4">
                      Profile synthesis was requested but no model could be reached, so this is
                      the plain structural draft. Check the LLM provider configuration if you
                      expected url_templates, selector groups and grounding rules to be filled in.
                    </span>
                  </div>
                )}
                {draft.synthesis && (
                  <div className="mt-2 border-t border-blue-200 pt-2">
                    <div className="text-[11px] font-semibold">
                      Synthesised from the crawl — {draft.synthesis.flows_proposed} flow(s)
                      proposed
                      {draft.synthesis.rejected.length > 0 &&
                        `, ${draft.synthesis.rejected.length} proposal(s) rejected`}
                    </div>
                    {draft.synthesis.notes.map((note, index) => (
                      <div key={`note-${index}`} className="mt-0.5 text-[11px] leading-4 text-blue-800/80">
                        • {note}
                      </div>
                    ))}
                    {draft.synthesis.rejected.length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-[11px] text-blue-800/80">
                          Rejected because the crawl could not vouch for them
                        </summary>
                        {draft.synthesis.rejected.map((entry, index) => (
                          <div key={`rejected-${index}`} className="mt-0.5 font-mono text-[10px] leading-4 break-all text-blue-800/70">
                            {entry}
                          </div>
                        ))}
                      </details>
                    )}
                  </div>
                )}
                <p className="mt-2 text-[11px] leading-4 text-blue-800/80">
                  These are drafts. Review and edit them before relying on the compiled model —
                  a crawl records the routes it walked and the locators it verified, and cannot
                  work out a flow's intent or a product's identifiers.
                </p>
              </div>
            )}

            {discovery && (
              <div className="flex flex-wrap items-center gap-2 text-[12px] mb-3">
                <StatusBadge tone={discovery.status === 'completed' ? 'success' : discovery.status === 'failed' ? 'danger' : 'info'} size="sm" dot={running}>
                  {discovery.status}
                </StatusBadge>
                <span className="font-mono text-app-primary">{discovery.application_url}</span>
                <span className="text-app-secondary">· v{discovery.version}</span>
                {discovery.run_key && (
                  <Link to={`/automation/runs/${discovery.run_key}`} className="inline-flex items-center gap-0.5 font-semibold text-app-brand-700 hover:underline">
                    view crawl log <HiOutlineExternalLink className="h-3 w-3" />
                  </Link>
                )}
              </div>
            )}
          </SectionCard>

          {/* Grounding Results Card */}
          {grounding && (
            <SectionCard title="Grounding Breakdown" description="Verification of refined test cases against current element catalogue." noPadding>
              <div className="flex flex-wrap items-center gap-3 border-b border-app px-5 py-3 text-[12px]">
                <span className="text-app-secondary">{grounding.checked} case(s) checked</span>
                <GroundingBadge status="grounded" />
                <span className="font-semibold text-app-primary">{grounding.counts.grounded ?? 0}</span>
                <GroundingBadge status="partially_grounded" />
                <span className="font-semibold text-app-primary">{grounding.counts.partially_grounded ?? 0}</span>
                <GroundingBadge status="ungrounded" />
                <span className="font-semibold text-app-primary">{grounding.counts.ungrounded ?? 0}</span>
              </div>

              <div className="divide-y divide-app">
                {grounding.test_cases.map((tc: WorkbenchCase) => {
                  const summary = tc.grounding_summary
                  const open = expandedGroundCase === tc.id
                  return (
                    <div key={tc.id} className="p-3">
                      <button
                        type="button"
                        onClick={() => setExpandedGroundCase(open ? null : tc.id)}
                        className="flex w-full items-center justify-between text-left"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[12px] font-semibold text-app-primary">{tc.tc_display_id}</span>
                          <GroundingBadge status={tc.grounding_status} />
                          {summary && (
                            <span className="text-[11px] text-app-secondary">
                              {summary.matched.length} matched · {summary.unresolved.length} unresolved
                            </span>
                          )}
                        </div>
                        <span className="text-[11px] text-app-secondary">{open ? 'Hide' : 'Details'}</span>
                      </button>
                    </div>
                  )
                })}
              </div>
            </SectionCard>
          )}

          {/* Discovered Elements Table */}
          <SectionCard
            title="Discovered Elements Catalogue"
            description="Verified locators extracted during application discovery crawl."
            noPadding
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={crawlerSearch}
                  onChange={e => setCrawlerSearch(e.target.value)}
                  placeholder="Search elements..."
                  className="app-input w-[200px]"
                />
                <select
                  value={crawlerRoleFilter}
                  onChange={e => setCrawlerRoleFilter(e.target.value)}
                  className="app-input"
                >
                  <option value="">All Roles</option>
                  {roles.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            }
          >
            {elements.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  title="No live crawled elements"
                  description={
                    selectedApp
                      ? `${selectedApp.name} has not been crawled yet. Click "Crawl Application" above.`
                      : 'Register an application first, then crawl it.'
                  }
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="app-table">
                  <thead>
                    <tr>
                      <th className="text-left">Role</th>
                      <th className="text-left">Accessible Name</th>
                      <th className="text-left">Recommended Locator</th>
                      <th className="text-left">Strategy & Confidence</th>
                      <th className="text-left">Page Origin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleElements.map(el => (
                      <tr key={el.id} className="hover:bg-app-surface-muted/50">
                        <td><StatusBadge tone="neutral" size="sm">{el.role || '—'}</StatusBadge></td>
                        <td className="text-[12px] text-app-primary font-medium">{el.accessible_name}</td>
                        <td className="font-mono text-[11px] text-app-brand-700">{el.recommended_locator}</td>
                        <td>
                          <StatusBadge tone={STRATEGY_TONE[el.recommended_strategy] || 'neutral'} size="sm">
                            {el.recommended_strategy} · {el.confidence_score}
                          </StatusBadge>
                        </td>
                        <td className="text-[11px] text-app-secondary truncate max-w-[200px]">{el.page_title || el.page_url}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </div>
      )}

      {/* ── TAB 5: APPLICATION MODEL JSON INSPECTOR ─────────────────────── */}
      {activeTab === 'json_model' && (
        <SectionCard
          title="Master Application Model JSON"
          description="The compiled JSON model for the selected application, exactly as the backend serves it."
          actions={
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleDownloadJson}
                className="app-btn app-btn-primary inline-flex items-center gap-1.5 text-[12px]"
              >
                <HiOutlineDownload className="h-3.5 w-3.5" />
                Download JSON File
              </button>
            </div>
          }
        >
          {modelLoading ? (
            <LoadingSkeleton className="h-64 w-full" rounded="lg" />
          ) : appModel ? (
            <CodeViewer
              code={JSON.stringify(appModel, null, 2)}
              language="json"
              fileName={`${selectedApp?.app_key ?? 'application'}_model.json`}
              maxHeight="600px"
              downloadable
            />
          ) : (
            <EmptyState
              title="No Application Model"
              description={
                modelError ??
                (selectedApp
                  ? `Add a Knowledge Base profile at knowledge_base/applications/${selectedApp.app_key}/ to compile a model for this application.`
                  : 'Register an application to compile its model.')
              }
            />
          )}
        </SectionCard>
      )}
    </div>
  )
}


/**
 * The standalone page. The header lives here, not in DiscoveryBody: usePageHeader
 * clears the header on unmount, so an embedded body that set it would blank the
 * Knowledge Base page's header every time its stage was left.
 */
const Discovery: React.FC = () => {
  usePageHeader({
    title: 'Application Discovery & Model',
    subtitle: 'Knowledge Base routes, flow blueprints, and application model',
    showSearch: false,
    showAssistant: false,
    showNotifications: true,
    showDateRange: false
  })
  return <DiscoveryBody />
}

export default Discovery
