import React, { useEffect, useState } from 'react'
import { HiOutlineSearch, HiOutlineBell, HiOutlineSparkles, HiOutlineClock, HiOutlineChevronDown } from 'react-icons/hi'
import { useAuth } from '../../hooks/useAuth'
import { MobileMenuButton } from '../Sidebar'

export interface TopHeaderProps {
  title?: string
  subtitle?: string
  welcomeText?: string
  onSearch?: (q: string) => void
  searchPlaceholder?: string
  showSearch?: boolean
  showAssistant?: boolean
  showNotifications?: boolean
  notificationCount?: number
  showDateRange?: boolean
  dateRangeLabel?: string
  onDateRangeClick?: () => void
  onNotificationsClick?: () => void
  onAssistantClick?: () => void
  actions?: React.ReactNode
  /** Controls placed before the search box, e.g. a page's tools menu. */
  leading?: React.ReactNode
  onMobileMenuOpen?: () => void
}

const TopHeader: React.FC<TopHeaderProps> = ({
  title,
  subtitle,
  welcomeText,
  onSearch,
  searchPlaceholder = 'Search users, logs, test activity…',
  showSearch = true,
  showAssistant = true,
  showNotifications = true,
  notificationCount = 0,
  showDateRange = true,
  dateRangeLabel = 'Last 24 hours',
  onDateRangeClick,
  onNotificationsClick,
  onAssistantClick,
  actions,
  leading,
  onMobileMenuOpen
}) => {
  const { user } = useAuth()
  const [q, setQ] = useState('')

  useEffect(() => {
    if (!onSearch) return
    const id = setTimeout(() => onSearch(q), 220)
    return () => clearTimeout(id)
  }, [q, onSearch])

  const hasTitle = !!(title || subtitle || welcomeText)

  /*
   * --- A control needs somewhere to go before it may appear ---------------
   *
   * All three of these used to render on a `show*` flag alone, and all three
   * of those flags default to `true` -- so the bell, the AI Assistant button
   * and the date-range picker appeared on any page that published no header
   * meta, and not one of them had a handler anywhere in the app. Clicking
   * them did nothing, which is how a user learns to distrust every other
   * control on the screen.
   *
   * Requiring the handler makes that unshippable rather than merely fixed:
   * there is no longer a way to render one of these without a destination.
   * Pages that want them back supply an onClick and they return.
   */
  const canShowAssistant = showAssistant && !!onAssistantClick
  const canShowNotifications = showNotifications && !!onNotificationsClick
  const canShowDateRange = showDateRange && !!onDateRangeClick

  /*
   * With dead controls gone, a page that publishes no header meta (Automation
   * is one) has nothing left to put in this band -- and an empty 58px sticky
   * bar above the content is worse than no bar. The mobile menu button still
   * lives here, so the band collapses on large screens only.
   */
  const hasContent =
    hasTitle || !!actions || !!leading || showSearch || canShowAssistant || canShowNotifications || canShowDateRange

  return (
    <header
      className={`sticky top-0 z-30 border-b border-app bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85 ${
        hasContent ? '' : 'lg:hidden'
      }`}
    >
      <div className="flex min-h-[63px] flex-wrap items-center gap-2.5 px-4 py-3 sm:px-6 lg:px-7">
        {onMobileMenuOpen && <MobileMenuButton onClick={onMobileMenuOpen} />}

        {hasTitle && (
          <div className="min-w-0 flex-1 lg:flex-none lg:pr-6">
            {welcomeText && (
              <div className="text-[12px] font-medium text-app-secondary leading-tight mb-0.5">
                {welcomeText}
              </div>
            )}
            {title && (
              <h1 className="truncate text-[22px] font-bold leading-tight tracking-tight text-app-primary sm:text-[26px]">
                {title}
              </h1>
            )}
            {subtitle && (
              <p className="mt-0.5 truncate text-sm text-app-secondary">{subtitle}</p>
            )}
          </div>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2 lg:gap-2.5">
          {leading}

          {showSearch && (
            <div className="relative hidden md:block">
              <HiOutlineSearch
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-app-muted"
                size={16}
              />
              <input
                type="search"
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder={searchPlaceholder}
                className="h-9 w-[240px] rounded-[12px] border border-app bg-app-surface pl-9 pr-3 text-[13px] text-app-primary placeholder:text-app-muted focus:border-app-brand-600 focus:outline-none focus:ring-2 focus:ring-app-brand-100 xl:w-[320px]"
              />
            </div>
          )}

          {canShowAssistant && (
            <button
              type="button"
              onClick={onAssistantClick}
              className="hidden items-center gap-2 rounded-app border border-app-brand-200 bg-app-brand-50 px-3 py-1.5 text-sm font-semibold text-app-brand-800 transition hover:bg-app-brand-100 active:bg-app-brand-200 sm:inline-flex"
            >
              <HiOutlineSparkles className="text-app-brand-700" size={15} />
              AI Assistant
            </button>
          )}

          {canShowNotifications && (
            <button
              type="button"
              onClick={onNotificationsClick}
              className="relative inline-flex h-[34px] w-[34px] items-center justify-center rounded-app border border-app bg-app-surface text-app-secondary transition hover:bg-app-surface-muted active:bg-app-border"
              aria-label={
                notificationCount > 0
                  ? `Notifications, ${notificationCount} unread`
                  : 'Notifications'
              }
            >
              <HiOutlineBell size={18} />
              {notificationCount > 0 && (
                <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-app-brand-700 px-1 text-[10px] font-semibold text-white">
                  {notificationCount > 9 ? '9+' : notificationCount}
                </span>
              )}
            </button>
          )}

          {canShowDateRange && (
            <button
              type="button"
              onClick={onDateRangeClick}
              className="hidden items-center gap-2 rounded-app border border-app bg-app-surface px-3 py-1.5 text-sm font-medium text-app-secondary transition hover:bg-app-surface-muted active:bg-app-border sm:inline-flex"
            >
              <HiOutlineClock size={15} />
              {dateRangeLabel}
              <HiOutlineChevronDown size={14} />
            </button>
          )}

          {actions}
        </div>
      </div>
    </header>
  )
}

export default TopHeader
