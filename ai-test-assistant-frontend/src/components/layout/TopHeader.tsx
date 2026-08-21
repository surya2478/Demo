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
  actions?: React.ReactNode
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
  actions,
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

  return (
    <header className="sticky top-0 z-30 border-b border-app bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85">
      <div className="flex flex-wrap items-center gap-2.5 px-4 py-3 sm:px-6 lg:px-8">
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

        <div className="ml-auto flex flex-wrap items-center gap-2 lg:gap-3">
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
                className="w-[240px] rounded-app border border-app bg-app-surface py-1.5 pl-9 pr-3 text-sm text-app-primary placeholder:text-app-muted focus:border-app-brand-600 focus:outline-none focus:ring-2 focus:ring-app-brand-100 xl:w-[320px]"
              />
            </div>
          )}

          {showAssistant && (
            <button
              type="button"
              className="hidden items-center gap-2 rounded-app border border-app-brand-200 bg-app-brand-50 px-3 py-1.5 text-sm font-semibold text-app-brand-800 transition hover:bg-app-brand-100 sm:inline-flex"
            >
              <HiOutlineSparkles className="text-app-brand-700" size={15} />
              AI Assistant
            </button>
          )}

          {showNotifications && (
            <button
              type="button"
              className="relative inline-flex h-[34px] w-[34px] items-center justify-center rounded-app border border-app bg-app-surface text-app-secondary transition hover:bg-app-surface-muted"
              aria-label="Notifications"
            >
              <HiOutlineBell size={18} />
              {notificationCount > 0 && (
                <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-app-brand-700 px-1 text-[10px] font-semibold text-white">
                  {notificationCount > 9 ? '9+' : notificationCount}
                </span>
              )}
            </button>
          )}

          {showDateRange && (
            <button
              type="button"
              onClick={onDateRangeClick}
              className="hidden items-center gap-2 rounded-app border border-app bg-app-surface px-3 py-1.5 text-sm font-medium text-app-secondary transition hover:bg-app-surface-muted sm:inline-flex"
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
