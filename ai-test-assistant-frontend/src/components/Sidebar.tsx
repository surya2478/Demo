import React, { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { HiOutlineChevronDown, HiOutlineLogout, HiOutlineX, HiOutlineMenu } from 'react-icons/hi'
import { menuIcons } from '../config/menuIcons'
import api from '../services/api'

interface MenuItem {
  path: string
  label: string
  permission?: string
  badge?: number | string
  /** Shown as a "Beta" tag: usable, still settling. */
  beta?: boolean
}

interface MenuGroup {
  heading: string
  items: MenuItem[]
}

interface SubMenuDef {
  parentPath: string
  items: MenuItem[]
}

const adminMenuGroups: MenuGroup[] = [
  {
    heading: 'Main Workspace',
    items: [
      { path: '/dashboard', label: 'Dashboard', permission: 'dashboard.view' },
      { path: '/users', label: 'Users', permission: 'user.manage' },
      { path: '/user-time-slots', label: 'User Time Slots', permission: 'user.manage' }
    ]
  },
  {
    heading: 'Monitoring',
    items: [
      { path: '/audit-logs', label: 'Audit Logs', permission: 'audit.view' },
      { path: '/sessions', label: 'Sessions', permission: 'sessions.manage' },
      { path: '/request-tracker-report', label: 'Assistant Report', permission: 'dashboard.view' }
    ]
  }
]

const aiTestGenerationItems: MenuItem[] = [
  { path: '/test-assistant', label: 'Test Assistant', permission: 'testassistant.view' },
  { path: '/manager-review', label: 'Review & Approve', permission: 'dashboard.view' },
  { path: '/coverage-analysis', label: 'Coverage Analysis', permission: 'testassistant.view' }
  // Approved Test Cases is hidden from the menu; its route still exists, and
  // its list and downloads move into Review & Approval.

     
    ]
  
const aiTestAutomationtems: MenuItem[] = [
    { path: '/automation', label: 'Automation Studio', permission: 'automation.view' },
    { path: '/automation/knowledge-base', label: 'Knowledge Base', permission: 'automation.view' },
    // The one source of test data for automation cases; the KB refers to it.
    { path: '/test-data', label: 'Test Data', permission: 'automation.view', beta: true }
    ]
    
 


const subMenus: SubMenuDef[] = []

const initials = (name?: string) => {
  if (!name || typeof name !== 'string' || name.trim() === '') return 'U'
  const parts = name.split(/[\s._-]+/).filter(Boolean)
  const a = parts[0]?.[0] ?? ''
  const b = parts[1]?.[0] ?? ''
  return (a + b).toUpperCase() || name[0].toUpperCase()
}

interface SidebarProps {
  mobileOpen?: boolean
  onMobileClose?: () => void
}

const Sidebar: React.FC<SidebarProps> = ({ mobileOpen = false, onMobileClose }) => {
  const { user, logout } = useAuth()
  const location = useLocation()
  const perms = (user as any)?.permissions ?? []
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [isAdminModuleOpen, setIsAdminModuleOpen] = useState(false)
  const [isAiTestGenerationOpen, setIsAiTestGenerationOpen] = useState(true)
  const [isAiTestAutomationOpen, setIsAiTestAutomationOpen] = useState(true)
  const [pendingReviews, setPendingReviews] = useState(0)

  // Review & Approve badge: requests waiting for a decision. Managers only --
  // anyone else gets a 403 and simply sees no badge.
  useEffect(() => {
    let cancelled = false
    const load = () => {
      api.get('/test-case-reviews/pending-count')
        .then((res: any) => { if (!cancelled) setPendingReviews(Number(res?.data?.pending) || 0) })
        .catch(() => { if (!cancelled) setPendingReviews(0) })
    }
    load()
    window.addEventListener('test-case-review-updated', load)
    return () => {
      cancelled = true
      window.removeEventListener('test-case-review-updated', load)
    }
  }, [location.pathname])

  // Close user menu on outside click
  useEffect(() => {
    if (!userMenuOpen) return
    const h = () => setUserMenuOpen(false)
    document.addEventListener('click', h)
    return () => document.removeEventListener('click', h)
  }, [userMenuOpen])

  const canSee = (item: MenuItem) => !item.permission || perms.includes(item.permission)

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    [
      'group relative flex items-center gap-3 rounded-app px-3 py-2.5 text-sm font-semibold transition',
      isActive
        ? 'bg-app-sidebar-active text-white shadow-sm'
        : 'text-white hover:bg-app-sidebar-hover hover:text-white'
    ].join(' ')

  const sectionButtonClass = 'flex w-full items-center justify-between rounded-app px-3 py-2.5 text-left text-[11px] font-bold uppercase tracking-[0.14em] text-white/75 transition hover:bg-white/[0.08] hover:text-white focus:outline-none focus:ring-2 focus:ring-white/30'

  const userRole =
    (user as any)?.roles?.[0] ??
    (user as any)?.role ??
    (user?.email ? 'Member' : '—')

  const SidebarBody = (
    <div className="flex h-full w-full flex-col">
      {/* Logo header */}
      <div className="flex items-center gap-3 px-5 pt-5 pb-4">
        <div className="flex h-11 w-11 items-center justify-center rounded-app bg-white/10 backdrop-blur">
          <img src="/etisalat-logo.svg" alt="Logo" className="h-7 w-7 object-contain" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold leading-tight text-white">
            Test Case Intelligence
          </div>
          <div className="truncate text-[10px] font-medium uppercase tracking-[0.14em] text-white/55">
            AI Testing Platform
          </div>
        </div>
        <button
          className="ml-auto rounded-md p-1.5 text-white/70 hover:bg-white/10 hover:text-white lg:hidden"
          onClick={onMobileClose}
          aria-label="Close menu"
        >
          <HiOutlineX size={18} />
        </button>
      </div>

      {/* Workspace selector */}
      <div className="px-4 pb-4">
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-app border border-white/10 bg-white/[0.04] px-3 py-2.5 text-left transition hover:bg-white/[0.08]"
        >
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/55">
              Workspace
            </div>
            <div className="truncate text-sm font-semibold text-white">Enterprise QA</div>
          </div>
          {/* <HiOutlineChevronDown className="text-white/60" /> */}
        </button>
      </div>

      {/* Nav */}
      <nav className="app-scroll flex-1 overflow-y-auto px-3 pb-4">
        <div className="mb-4">
          <button type="button" onClick={() => setIsAdminModuleOpen((open) => !open)} aria-expanded={isAdminModuleOpen} className={sectionButtonClass}>
            <span>Admin Module</span>
            <HiOutlineChevronDown className={`h-4 w-4 transition-transform ${isAdminModuleOpen ? 'rotate-180' : ''}`} />
          </button>
          {isAdminModuleOpen && (
            <div className="mt-1 border-l border-white/10 pl-3">
              {adminMenuGroups.map((group) => {
                const visible = group.items.filter(canSee)
                if (visible.length === 0) return null
                return (
                  <div key={group.heading} className="mb-3">
                    <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/45">{group.heading}</div>
                    <div className="space-y-0.5">
                      {visible.map((item) => {
                        const IconComponent = (menuIcons as any)[item.path.slice(1)]
                        return (
                          <NavLink key={item.path} to={item.path} className={linkClass} onClick={onMobileClose} end={item.path === '/dashboard'}>
                            {IconComponent && <IconComponent className="h-[18px] w-[18px] flex-shrink-0" />}
                            <span className="truncate">{item.label}</span>
                          </NavLink>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="mb-4">
          <button type="button" onClick={() => setIsAiTestGenerationOpen((open) => !open)} aria-expanded={isAiTestGenerationOpen} className={sectionButtonClass}>
            <span>AI Test Generation</span>
            <HiOutlineChevronDown className={`h-4 w-4 transition-transform ${isAiTestGenerationOpen ? 'rotate-180' : ''}`} />
          </button>
          {isAiTestGenerationOpen && (
            <div className="mt-1 space-y-0.5">
              {aiTestGenerationItems.filter(canSee).map((item) => {
                const IconComponent = (menuIcons as any)[item.path.slice(1)]
                const badge = item.path === '/manager-review' && pendingReviews > 0 ? pendingReviews : null
                return (
                  <NavLink key={item.path} to={item.path} className={linkClass} onClick={onMobileClose}>
                    {IconComponent && <IconComponent className="h-[18px] w-[18px] flex-shrink-0" />}
                    <span className="truncate">{item.label}</span>
                    {badge !== null && (
                      <span className="ml-auto flex h-5 min-w-[20px] items-center justify-center rounded-full bg-white px-1.5 text-[11px] font-bold text-[#941216]">
                        {badge > 99 ? '99+' : badge}
                      </span>
                    )}
                  </NavLink>
                )
              })}
            </div>
          )}
        </div>

        <div className="mb-4">
          <button type="button" onClick={() => setIsAiTestAutomationOpen((open) => !open)} aria-expanded={isAiTestAutomationOpen} className={sectionButtonClass}>
            <span>AI Test Automation</span>
            <HiOutlineChevronDown className={`h-4 w-4 transition-transform ${isAiTestAutomationOpen ? 'rotate-180' : ''}`} />
          </button>
          {isAiTestAutomationOpen && (
            <div className="mt-1 space-y-0.5">
              {aiTestAutomationtems.filter(canSee).map((item) => {
                const IconComponent = (menuIcons as any)[item.path.slice(1)]
                return (
                  <NavLink key={item.path} to={item.path} className={linkClass} onClick={onMobileClose}>
                    {IconComponent && <IconComponent className="h-[18px] w-[18px] flex-shrink-0" />}
                    <span className="truncate">{item.label}</span>
                    {item.beta && (
                      <span className="ml-auto rounded-full border border-white/40 px-1.5 py-px text-[9.5px] font-bold uppercase tracking-[0.08em] text-white/90">Beta</span>
                    )}
                  </NavLink>
                )
              })}
            </div>
          )}
        </div>
      </nav>

      {/* User card */}
      <div className="border-t border-white/10 p-3">
        <div className="relative">
          <button
            type="button"
            onClick={e => {
              e.stopPropagation()
              setUserMenuOpen(v => !v)
            }}
            className="flex w-full items-center gap-3 rounded-app px-2 py-2 text-left transition hover:bg-white/[0.06]"
          >
            <div
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white shadow-sm"
              style={{ background: 'linear-gradient(135deg, #D52B31, #941216)' }}
            >
              {initials(user?.username)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-white">
                {user?.username ?? 'User'}
              </div>
              <div className="truncate text-[11px] capitalize text-white/55">
                {String(userRole)}
              </div>
            </div>
            <HiOutlineChevronDown
              className={`text-white/55 transition-transform ${userMenuOpen ? 'rotate-180' : ''}`}
              size={16}
            />
          </button>
          {userMenuOpen && (
            <div
              className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-app border border-app bg-app-surface shadow-app-card-lg"
              onClick={e => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => {
                  setUserMenuOpen(false)
                  logout()
                }}
                className="flex w-full items-center gap-2 px-3.5 py-2.5 text-sm font-medium text-app-primary transition hover:bg-app-surface-muted"
              >
                <HiOutlineLogout className="text-app-secondary" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )

  return (
    <>
      {/* Desktop */}
      <aside
        className="hidden h-screen w-[260px] flex-shrink-0 flex-col text-white shadow-app-sidebar lg:sticky lg:top-0 lg:flex"
        style={{
          background: 'linear-gradient(180deg, var(--brand-800) 0%, var(--brand-900) 50%, var(--brand-950) 100%)'
        }}
      >
        {SidebarBody}
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={onMobileClose}
            aria-hidden
          />
          <aside
            className="absolute left-0 top-0 h-full w-[280px] text-white shadow-app-sidebar"
            style={{
              background: 'linear-gradient(180deg, var(--brand-800) 0%, var(--brand-900) 50%, var(--brand-950) 100%)'
            }}
          >
            {SidebarBody}
          </aside>
        </div>
      )}
    </>
  )
}

export default Sidebar

export const MobileMenuButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button
    onClick={onClick}
    className="inline-flex h-9 w-9 items-center justify-center rounded-app border border-app bg-app-surface text-app-primary transition hover:bg-app-surface-muted lg:hidden"
    aria-label="Open menu"
  >
    <HiOutlineMenu size={18} />
  </button>
)
