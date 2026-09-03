/**
 * --- Automation Module: workspace shell ---------------------------------
 *
 * Mirrors the Test Assistant's nested-tab pattern: a hero, a tab card, and an
 * Outlet. It does not copy that page's outlet cache — the cache keys on
 * pathname, and Run Detail is a parameterised child route, so every run key
 * would leak another retained subtree.
 *
 * Runtime status is fetched once here and handed down through outlet context.
 * Both tabs need it, and asking twice for the same answer would put two
 * subprocess probes on a host that is also running browsers.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
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

type TabGlyphProps = { className?: string }

const RunsGlyph: React.FC<TabGlyphProps> = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
    <circle cx="12" cy="12" r="8.25" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M10.25 9.25l5 2.75-5 2.75V9.25z" />
  </svg>
)

const HeroBrowserGlyph: React.FC<TabGlyphProps> = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
    <rect x="3.5" y="5" width="17" height="14" rx="2.25" />
    <path strokeLinecap="round" d="M3.5 9h17" />
    <circle cx="6.4" cy="7" r="0.6" fill="currentColor" />
    <circle cx="8.4" cy="7" r="0.6" fill="currentColor" />
  </svg>
)

const HeroCheckGlyph: React.FC<TabGlyphProps> = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 12.5l4.25 4.25L19 7.25" />
  </svg>
)

const WorkbenchGlyph: React.FC<TabGlyphProps> = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 6.5h9M4 12h13M4 17.5h7" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 18.5l1.75 1.75L21.5 16.5" />
  </svg>
)

const ScriptLabGlyph: React.FC<TabGlyphProps> = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 7L4.5 12 9 17M15 7l4.5 5-4.5 5" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M13.25 4.5l-2.5 15" />
  </svg>
)

const DiscoveryGlyph: React.FC<TabGlyphProps> = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
    <circle cx="11" cy="11" r="6.5" />
    <path strokeLinecap="round" d="M15.8 15.8L20 20" />
    <circle cx="11" cy="11" r="2.25" />
  </svg>
)

const tabs = [
  {
    to: 'workbench',
    label: 'Automation Workspace',
    detail: 'Refine, classify and approve',
    Icon: WorkbenchGlyph
  },
  {
    to: 'script-lab',
    label: 'Automation Script Lab',
    detail: 'Generate, dry run and download',
    Icon: ScriptLabGlyph
  },
  { to: 'runs', label: 'Runs', detail: 'Execution history and evidence', Icon: RunsGlyph }
]

const Automation: React.FC = () => {
  const { user } = useAuth()
  const [runtime, setRuntime] = useState<RuntimeStatusResponse | null>(null)
  const [runtimeLoading, setRuntimeLoading] = useState(true)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)

  usePageHeader({
    showSearch: false,
    showAssistant: false,
    showNotifications: true,
    showDateRange: false
  })

  const loadRuntime = useCallback(async () => {
    setRuntimeLoading(true)
    setRuntimeError(null)
    try {
      const data = await automationService.getRuntime()
      setRuntime(data)
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

  const context: AutomationContext = {
    runtime,
    runtimeLoading,
    runtimeError,
    reloadRuntime: loadRuntime,
    canExecute
  }

  return (
    <div className="relative space-y-3">
      {/* Hero — compact two-column header, matching the Test Assistant */}
      <section className="overflow-hidden rounded-[20px] border border-app bg-app-surface shadow-app-card">
        <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.7fr)]">
          <div className="px-5 py-4 sm:px-6">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-app-brand-700">
              Workspace
            </p>
            <h1 className="mt-1 text-[26px] font-bold leading-tight tracking-[-0.02em] text-app-primary">
              <span className="text-app-brand-700">AI</span> Test Automation Studio
            </h1>
            <p className="mt-1.5 max-w-xl text-[13px] leading-5 text-app-secondary">
              Score approved test cases for automation, execute Playwright specs on this host,
              and review the evidence each run leaves behind.
            </p>
          </div>

          <div className="relative h-[140px] overflow-hidden border-t border-app bg-[radial-gradient(circle_at_50%_38%,rgba(255,255,255,1),rgba(255,255,255,0.96)_35%,rgba(253,235,236,0.78)_58%,rgba(255,255,255,0.98)_100%)] lg:h-auto lg:border-l lg:border-t-0">
            <div className="absolute inset-0">
              <div className="absolute left-1/2 top-1/2 h-[150px] w-[150px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-app-brand-200/60" />
              <div className="absolute left-1/2 top-1/2 h-[118px] w-[118px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-app-brand-100/70" />
              <div className="absolute left-1/2 top-1/2 h-[88px] w-[88px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-app-brand-200/70 shadow-[0_0_0_10px_rgba(183,25,32,0.04)]" />
              <div className="absolute left-1/2 top-1/2 h-[68px] w-[68px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle_at_32%_28%,#ff9296_0,#d71e23_48%,#880d13_100%)] shadow-[0_10px_24px_rgba(148,18,22,0.26)]" />
              <div className="absolute left-1/2 top-1/2 flex h-[68px] w-[68px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-[26px] font-bold tracking-[-0.06em] text-white">
                ATS
              </div>

              <div className="absolute left-[14%] top-[24%] flex h-9 w-9 rotate-[-18deg] items-center justify-center rounded-[12px] border border-app-brand-100 bg-white/90 text-app-brand-700 shadow-[0_8px_18px_rgba(183,25,32,0.1)]">
                <HeroBrowserGlyph className="h-5 w-5" />
              </div>
              <div className="absolute right-[12%] top-[28%] flex h-9 w-9 rotate-[14deg] items-center justify-center rounded-[12px] border border-app-brand-100 bg-white/90 text-app-brand-700 shadow-[0_8px_18px_rgba(183,25,32,0.1)]">
                <HeroCheckGlyph className="h-5 w-5" />
              </div>
              <div className="absolute left-[16%] top-[64%] h-2.5 w-2.5 rounded-md bg-app-brand-500 shadow-[0_0_0_6px_rgba(183,25,32,0.08)]" />
              <div className="absolute right-[20%] top-[16%] h-2 w-2 rounded-[3px] bg-app-brand-500" />
              <div className="absolute right-[26%] top-[70%] h-2.5 w-2.5 rounded-md bg-app-brand-300" />
            </div>
          </div>
        </div>
      </section>

      {/* Tabs */}
      <section className="rounded-[20px] border border-app bg-app-surface p-3 shadow-app-card">
        <nav className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {tabs.map(t => {
            const TabIcon = t.Icon
            return (
              <NavLink
                key={t.to}
                to={t.to}
                /*
                 * Active and inactive used to share `bg-white` on a white card,
                 * separated by a border of #F6D4D5 against #E8EAEE -- 1.14:1,
                 * i.e. nothing. Three signals now carry it: the selected tab is
                 * raised (white on recessed siblings), it is the only one with a
                 * solid brand rail, and it keeps the shadow. The rail is a hard
                 * 6.6:1 edge, which is what actually reads at a glance; the fill
                 * and elevation only support it. Both states declare the same
                 * 3px left border so selecting one shifts nothing.
                 */
                className={({ isActive }) =>
                  [
                    'group flex items-center gap-3 rounded-[14px] border border-l-[3px] px-3 py-2.5 transition-all duration-200',
                    isActive
                      ? 'border-app-brand-200 border-l-app-brand-600 bg-white shadow-[0_4px_12px_rgba(183,25,32,0.10)]'
                      : 'border-app border-l-transparent bg-app-surface-muted hover:border-app-brand-100 hover:border-l-app-brand-200 hover:bg-app-brand-50 active:bg-app-brand-100'
                  ].join(' ')
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      className={[
                        'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px] transition-all',
                        isActive
                          ? 'bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] text-white shadow-[0_6px_14px_rgba(183,25,32,0.22)]'
                          : 'border border-app bg-app-surface text-app-secondary group-hover:border-app-brand-100 group-hover:text-app-brand-700'
                      ].join(' ')}
                    >
                      <TabIcon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span
                        className={`block text-[12px] font-semibold leading-tight ${
                          isActive ? 'text-app-brand-800' : 'text-app-primary'
                        }`}
                      >
                        {t.label}
                      </span>
                      <span className="block truncate text-[11px] text-app-secondary">
                        {t.detail}
                      </span>
                    </span>
                  </>
                )}
              </NavLink>
            )
          })}
        </nav>
      </section>

      <Outlet context={context} />
    </div>
  )
}

export default Automation
