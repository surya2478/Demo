/**
 * --- Automation Module: workspace shell ---------------------------------
 *
 * The top bar and the Workspace hero, on every screen. Under them sits the
 * Automation Lab -- projects, then one project's workspace -- which is the
 * only page now: the Runs page is retired and everything it did (live
 * progress, evidence, history, deleting runs) lives with the case it ran.
 *
 * Only manager-approved Automation cases reach the Script Lab now -- AI
 * Checks refines, reviews and classifies them before approval -- so the
 * Automation Workspace (Workbench) is no longer a step of the journey and has
 * no tab. It still works, at /automation/workbench, for cases that arrive
 * any other way.
 *
 * Runtime status is fetched once here and handed down through outlet context.
 * Every screen needs it, and asking twice for the same answer would put two
 * subprocess probes on a host that is also running browsers.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Outlet, useMatch } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { usePageHeader } from '../components/layout/PageHeaderContext'
import automationService from '../services/automationService'
import type { AutomationContext } from '../components/automation/AutomationContext'
import type { RuntimeStatusResponse } from '../types/automation'

const hasPermission = (user: any, permission: string): boolean => {
  if (!user) return false
  const roles: string[] = (user.roles as string[]) || (user.role ? [user.role] : [])
  if (roles.some(r => String(r).toLowerCase() === 'admin')) return true
  const perms: string[] = (user.permissions as string[]) || []
  return perms.includes(permission)
}

type GlyphProps = { className?: string }

const HeroBrowserGlyph: React.FC<GlyphProps> = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden>
    <rect x="3.5" y="5" width="17" height="14" rx="2.25" />
    <path strokeLinecap="round" d="M3.5 9h17" />
  </svg>
)

const HeroCheckGlyph: React.FC<GlyphProps> = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 12.5l4.25 4.25L19 7.25" />
  </svg>
)

/** "Playwright ready · Katalon, Appium generate only", in the top header. */
const RuntimeChip: React.FC<{ runtime: RuntimeStatusResponse | null; loading: boolean; error: string | null }> = ({
  runtime,
  loading,
  error
}) => {
  const label = (name: string) => name.charAt(0).toUpperCase() + name.slice(1)
  if (loading && !runtime) {
    return (
      <span className="hidden h-9 items-center rounded-[12px] border border-[#E8EAEE] bg-white px-3 text-[12.5px] text-[#6B7280] md:inline-flex">
        Checking runtime…
      </span>
    )
  }
  const ready = Boolean(runtime?.ready)
  const runnable = (runtime?.runnable_frameworks ?? ['playwright']).map(label).join(', ')
  const generateOnly = (runtime?.generate_only_frameworks ?? []).map(label).join(', ')
  return (
    <span
      title={error ?? (ready ? 'Scripts can be run on this host' : 'The browser runtime is unavailable, so runs are refused')}
      className={`hidden h-9 items-center gap-2 whitespace-nowrap rounded-[12px] border px-3 text-[12.5px] md:inline-flex ${
        ready ? 'border-[#BBDFC8] bg-[#F5FBF7]' : 'border-[#EBCFA4] bg-[#FFFBF4]'
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${ready ? 'bg-[#15803D]' : 'bg-[#D97706]'}`} />
      <strong className={ready ? 'text-[#136B34]' : 'text-[#8A5000]'}>
        {ready ? `${runnable} ready` : `${runnable} unavailable`}
      </strong>
      {generateOnly ? <span className="text-[#374151]">· {generateOnly} generate only</span> : null}
    </span>
  )
}

const Automation: React.FC = () => {
  const { user } = useAuth()
  const [runtime, setRuntime] = useState<RuntimeStatusResponse | null>(null)
  const [runtimeLoading, setRuntimeLoading] = useState(true)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // A project's workspace is full page, like /manager-review/:requestId: it
  // puts its breadcrumb, title and actions in the top bar itself, so the
  // shell publishes no header there and shows no Workspace hero.
  const fullPage = useMatch('/automation/script-lab/:projectId') !== null

  const onSearch = useCallback((q: string) => setQuery(q.trim().toLowerCase()), [])

  usePageHeader({
    showSearch: true,
    onSearch,
    searchPlaceholder: 'Search scripts, runs, test cases…',
    showAssistant: false,
    showNotifications: false,
    showDateRange: false,
    leading: <RuntimeChip runtime={runtime} loading={runtimeLoading} error={runtimeError} />,
    contentKey: `${runtimeLoading}|${runtime?.ready}|${(runtime?.runnable_frameworks ?? []).join()}|${(runtime?.generate_only_frameworks ?? []).join()}`
  }, { enabled: !fullPage })

  const loadRuntime = useCallback(async () => {
    setRuntimeLoading(true)
    setRuntimeError(null)
    try {
      setRuntime(await automationService.getRuntime())
    } catch (err: any) {
      setRuntimeError(err?.message ?? 'The runtime status is unavailable.')
    } finally {
      setRuntimeLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadRuntime()
  }, [loadRuntime])

  const canExecute = hasPermission(user, 'automation.execute')

  const context: AutomationContext = useMemo(
    () => ({
      runtime,
      runtimeLoading,
      runtimeError,
      reloadRuntime: loadRuntime,
      canExecute,
      query
    }),
    [runtime, runtimeLoading, runtimeError, loadRuntime, canExecute, query]
  )

  return (
    <div className="relative flex flex-col gap-3">
      {/* Hero */}
      {!fullPage && (
      <section className="overflow-hidden rounded-[20px] border border-[#E8EAEE] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
        <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.72fr)]">
          <div className="px-6 py-5">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-[#B71920]">Workspace</p>
            <h1 className="mt-1 text-[27px] font-extrabold leading-tight tracking-[-0.02em] text-[#1F2937]">
              <span className="text-[#B71920]">AI</span> Test Automation Studio
            </h1>
            <p className="mt-2 max-w-[620px] text-[13.5px] leading-[1.6] text-[#4B5563]">
              Generate scripts for manager-approved Automation cases, run them on this host, and review the evidence
              each run leaves behind.
            </p>
          </div>

          <div className="relative h-[140px] overflow-hidden border-t border-[#E8EAEE] bg-[radial-gradient(circle_at_50%_42%,#ffffff_0,#ffffff_30%,rgba(253,235,236,0.8)_62%,#fff5f5_100%)] lg:h-auto lg:border-l lg:border-t-0">
            <div className="absolute left-1/2 top-1/2 h-[170px] w-[170px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#F6D4D5]/70" />
            <div className="absolute left-1/2 top-1/2 h-[118px] w-[118px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#F6D4D5]" />
            <div className="absolute left-1/2 top-1/2 flex h-[84px] w-[84px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-[radial-gradient(circle_at_32%_28%,#ff7b80_0,#e0242a_45%,#9b0f15_100%)] text-[28px] font-extrabold tracking-[-0.04em] text-white shadow-[0_0_0_10px_rgba(183,25,32,0.06),0_12px_26px_rgba(148,18,22,0.28)]">
              ATS
            </div>
            <div className="absolute left-[14%] top-[24%] flex h-10 w-10 rotate-[-14deg] items-center justify-center rounded-[12px] bg-white text-[#B71920] shadow-[0_8px_18px_rgba(183,25,32,0.12)]">
              <HeroBrowserGlyph className="h-5 w-5" />
            </div>
            <div className="absolute right-[12%] top-[28%] flex h-10 w-10 rotate-[12deg] items-center justify-center rounded-[12px] bg-white text-[#B71920] shadow-[0_8px_18px_rgba(183,25,32,0.12)]">
              <HeroCheckGlyph className="h-5 w-5" />
            </div>
            <div className="absolute left-[17%] top-[64%] h-3 w-3 rounded-full bg-[#DC2626] shadow-[0_0_0_6px_rgba(220,38,38,0.1)]" />
            <div className="absolute right-[20%] top-[14%] h-2 w-2 rounded-full bg-[#DC2626]" />
            <div className="absolute right-[27%] top-[70%] h-2.5 w-2.5 rounded-full bg-[#F1A4A6]" />
          </div>
        </div>
      </section>
      )}

      <Outlet context={context} />
    </div>
  )
}

export default Automation
