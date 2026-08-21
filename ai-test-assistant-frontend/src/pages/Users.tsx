import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  HiOutlineUsers,
  HiOutlineShieldCheck,
  HiOutlineClock,
  HiOutlineUserAdd,
  HiOutlinePencilAlt,
  HiOutlineTrash,
  HiOutlineX,
  HiOutlineExclamation,
  HiOutlineFilter,
  HiOutlineSearch,
  HiOutlineDotsHorizontal,
  HiOutlineCheckCircle,
  HiOutlineXCircle,
  HiOutlineRefresh
} from 'react-icons/hi'
import userService from '../services/userService'
import { useAuth } from '../hooks/useAuth'
import Loader from '../components/Loader'
import Notification from '../components/Notification'
import UserModal from '../components/UserModal'
import EditUserModal from '../components/EditUserModal'
import api from '../services/api'
import type { User } from '../types'
import { logApiEvent } from '../utils/auditApiHelper'
import SectionCard from '../components/ui/SectionCard'
import StatusBadge from '../components/ui/StatusBadge'
import MetricCard from '../components/ui/MetricCard'
import IconBadge from '../components/ui/IconBadge'
import EmptyState from '../components/ui/EmptyState'
import { usePageHeader } from '../components/layout/PageHeaderContext'
import { theme } from '../styles/theme'
import { formatToDubaiTime } from '../utils/formatToDubaiTime'

const initials = (name?: string) => {
  if (!name) return 'U'
  const parts = name.split(/[\s._-]+/).filter(Boolean)
  const a = parts[0]?.[0] ?? ''
  const b = parts[1]?.[0] ?? ''
  return ((a + b) || name[0]).toUpperCase()
}

const avatarGradient = (seed: string) => {
  // Stable hash-ish based on string for avatar color rotation in brand red family
  const palette = [
    'linear-gradient(135deg, #B71920, #7A0B0D)',
    'linear-gradient(135deg, #D52B31, #941216)',
    'linear-gradient(135deg, #941216, #65080A)',
    'linear-gradient(135deg, #F1A4A6, #B71920)',
    'linear-gradient(135deg, #7A0B0D, #4D0507)'
  ]
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

const isAdminUser = (u: User) => {
  const role = (u as any).role?.toLowerCase()
  const roles = (u as any).roles || []
  return (
    role === 'admin' ||
    (Array.isArray(roles) && roles.some((r: string) => String(r).toLowerCase() === 'admin'))
  )
}

const roleChipStyle = (role: string): { bg: string; text: string; ring: string } => {
  const r = role.toLowerCase()
  if (r === 'admin') return { bg: 'bg-app-brand-50', text: 'text-app-brand-800', ring: 'ring-app-brand-100' }
  if (r === 'manager') return { bg: 'bg-app-brand-50', text: 'text-app-brand-800', ring: 'ring-app-brand-100' }
  if (r === 'user') return { bg: 'bg-[#E0F4FA]', text: 'text-[#0E7C94]', ring: 'ring-[#BFE6F0]' }
  if (r === 'tester' || r.startsWith('tester_level_1')) return { bg: 'bg-[#F3EDFB]', text: 'text-[#6E2BD8]', ring: 'ring-[#E1D2F5]' }
  if (r === 'solution') return { bg: 'bg-[#E3F6E8]', text: 'text-[#1B7A33]', ring: 'ring-[#C4EAD0]' }
  if (r === 'code_changes' || r.includes('code')) return { bg: 'bg-[#FDEBD3]', text: 'text-[#A35309]', ring: 'ring-[#F5D1A8]' }
  if (r.startsWith('tester_level_2') || r.includes('level_2')) return { bg: 'bg-[#DFEAFE]', text: 'text-[#1C4DB6]', ring: 'ring-[#C2D4F7]' }
  return { bg: 'bg-app-surface-muted', text: 'text-app-secondary', ring: 'ring-app' }
}

const Users: React.FC = () => {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editUser, setEditUser] = useState<User | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<User | null>(null)
  const [deleting, setDeleting] = useState(false)
  const navigate = useNavigate()
  const { user } = useAuth()
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const didLoadRef = useRef(false)

  // Toolbar state
  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all')
  const [openRowMenu, setOpenRowMenu] = useState<number | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const pageSize = 10

  const loadUsers = async () => {
    setLoading(true)
    try {
      const data = await userService.list()
      setUsers(Array.isArray(data) ? data : [])
    } catch (err) {
      console.error('Failed to load users:', err)
      setError('Failed to load users')
      setUsers([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (didLoadRef.current) return
    didLoadRef.current = true
    loadUsers()
  }, [])

  const showNotification = (message: string, type: 'success' | 'error') => {
    setNotification({ message, type })
    setTimeout(() => setNotification(null), 4000)
  }

  const handleUserCreated = async (userData: User) => {
    if (userData) {
      setUsers(prev => [...prev, userData])
      await loadUsers()
      showNotification('User created successfully', 'success')
    }
  }

  const handleUserUpdated = (_updated: User) => {
    loadUsers()
    showNotification('User updated successfully', 'success')
    setEditUser(null)
  }

  const handleDeleteClick = (u: User) => setDeleteConfirm(u)

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm) return
    const requestPayload = { username: deleteConfirm.username, email: deleteConfirm.email }
    let responsePayload: any = null
    let auditStatus: 'success' | 'failure' = 'success'

    setDeleting(true)
    try {
      const username = deleteConfirm.username || deleteConfirm.email
      await api.delete(`/user/delete/${username}`)
      showNotification(`User '${username}' deleted successfully`, 'success')
      setDeleteConfirm(null)
      await loadUsers()
      responsePayload = { message: `User '${username}' deleted successfully` }
    } catch (err: any) {
      console.error('Failed to delete user:', err)
      const message = err?.response?.data?.detail || err?.message || 'Failed to delete user'
      showNotification(message, 'error')
      auditStatus = 'failure'
      responsePayload = message
    } finally {
      setDeleting(false)
      try {
        await logApiEvent({
          user: user?.username ? user : null,
          module: 'User Management',
          action: 'Delete User',
          resourceType: 'API',
          resourceId: 'deleteUser',
          resourceName: 'Delete User',
          description: `deleted user ${deleteConfirm.username ?? deleteConfirm.email}`,
          request: requestPayload,
          response: responsePayload,
          status: auditStatus
        })
      } catch (auditErr) {
        console.error('Failed to log audit event:', auditErr)
      }
    }
  }

  const handleDeleteCancel = () => setDeleteConfirm(null)
  const handleAddUser = () => setIsModalOpen(true)
  const handleEdit = (u: User) => {
    setEditUser(u)
    setOpenRowMenu(null)
  }

  const resetFilters = () => {
    setQuery('')
    setRoleFilter('all')
    setStatusFilter('all')
  }

  // Distinct roles for filter dropdown
  const availableRoles = useMemo(() => {
    const set = new Set<string>()
    users.forEach(u => {
      const r = (u as any).role
      if (r) set.add(String(r))
    })
    return Array.from(set).sort()
  }, [users])

  // Filtered users
  const filteredUsers = useMemo(() => {
    const q = query.trim().toLowerCase()
    return users.filter(u => {
      if (q) {
        const hay = `${u.username ?? ''} ${u.email ?? ''} ${(u as any).role ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      if (roleFilter !== 'all') {
        if (String((u as any).role) !== roleFilter) return false
      }
      if (statusFilter !== 'all') {
        const active = (u as any).is_active !== false
        if (statusFilter === 'active' && !active) return false
        if (statusFilter === 'inactive' && active) return false
      }
      return true
    })
  }, [users, query, roleFilter, statusFilter])

  // Paged users
  const pagedUsers = useMemo(() => {
    const start = (currentPage - 1) * pageSize
    return filteredUsers.slice(start, start + pageSize)
  }, [filteredUsers, currentPage, pageSize])

  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / pageSize))

  // KPI counts (use full list, not filtered)
  const counts = useMemo(() => {
    const total = users.length
    const active = users.filter(u => (u as any).is_active !== false).length
    const admins = users.filter(isAdminUser).length
    const restricted = users.filter(
      u => (u as any).allowed_time_start && (u as any).allowed_time_end
    ).length
    return { total, active, admins, restricted }
  }, [users])

  // Reset to page 1 whenever filters change
  const prevFiltersRef = useRef({ query, roleFilter, statusFilter })
  useEffect(() => {
    const prev = prevFiltersRef.current
    if (prev.query !== query || prev.roleFilter !== roleFilter || prev.statusFilter !== statusFilter) {
      setCurrentPage(1)
      prevFiltersRef.current = { query, roleFilter, statusFilter }
    }
  }, [query, roleFilter, statusFilter])

  // Wire to top header (title, subtitle, primary action, search)
  usePageHeader({
    title: 'User Management',
    subtitle: 'Create, edit and manage workspace accounts, roles, and access windows.',
    welcomeText: `Welcome back, ${user?.username ?? 'Admin'}! 👋`,
    showSearch: false, // we render search inline in the toolbar
    notificationCount: 0,
    actions: user ? (
      <button type="button" onClick={handleAddUser} className={theme.button.primary}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="h-4 w-4">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15M4.5 12h15" />
        </svg>
        Add User
      </button>
    ) : null
  })

  // Stable spark data derived from user counts — must be above conditional returns
  const totalSpark = useMemo(() => {
    const n = Math.max(counts.total, 1)
    return Array.from({ length: 8 }, (_, i) => Math.round(n * (0.6 + 0.4 * ((i + 1) / 8))))
  }, [counts.total])
  const activeSpark = useMemo(() => {
    const n = Math.max(counts.active, 1)
    return Array.from({ length: 8 }, (_, i) => Math.round(n * (0.55 + 0.45 * ((i + 1) / 8))))
  }, [counts.active])
  const adminsSpark = useMemo(() => {
    const n = Math.max(counts.admins, 1)
    return Array.from({ length: 8 }, () => n)
  }, [counts.admins])
  const restrictedSpark = useMemo(() => {
    const n = Math.max(counts.restricted, 1)
    return Array.from({ length: 8 }, (_, i) => Math.round(n * (1.4 - 0.4 * (i / 7))))
  }, [counts.restricted])

  if (loading) return <Loader />
  if (error)
    return (
      <div className="rounded-app border border-red-200 bg-app-danger-bg p-4 text-app-danger">{error}</div>
    )

  return (
    <div className="space-y-6">
      {/* KPI ROW */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard
          label="Total Users"
          value={counts.total}
          icon={<HiOutlineUsers size={18} />}
          tone="brand"
          sparkData={counts.total > 0 ? totalSpark : undefined}
          trend={counts.total > 0 ? { direction: 'up', value: '13.3%', label: 'vs last 24 hours' } : undefined}
        />
        <MetricCard
          label="Active"
          value={counts.active}
          icon={<HiOutlineCheckCircle size={18} />}
          tone="success"
          sparkData={counts.active > 0 ? activeSpark : undefined}
          trend={counts.active > 0 ? { direction: 'up', value: '7.7%', label: 'vs last 24 hours' } : undefined}
        />
        <MetricCard
          label="Admins"
          value={counts.admins}
          icon={<HiOutlineShieldCheck size={18} />}
          tone="violet"
          sparkData={counts.admins > 0 ? adminsSpark : undefined}
          trend={counts.admins > 0 ? { direction: 'flat', value: 'No change' } : undefined}
        />
        <MetricCard
          label="Time-restricted"
          value={counts.restricted}
          icon={<HiOutlineClock size={18} />}
          tone="warning"
          sparkData={counts.restricted > 0 ? restrictedSpark : undefined}
          trend={counts.restricted > 0 ? { direction: 'down', value: '50%', label: 'vs last 24 hours' } : undefined}
        />
      </section>

      {/* TABLE */}
      <SectionCard
        title="All Users"
        description={`${counts.total} ${counts.total === 1 ? 'account' : 'accounts'} provisioned · showing ${filteredUsers.length}`}
        actions={
          <button type="button" onClick={loadUsers} className={`${theme.button.secondary}`}>
            <HiOutlineRefresh size={14} />
            Refresh
          </button>
        }
        contentClassName="px-0 py-0"
      >
        {/* Toolbar */}
        <div className="flex flex-col gap-3 border-b border-app px-5 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <div className="relative max-w-sm flex-1">
              <HiOutlineSearch
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-app-muted"
                size={16}
              />
              <input
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search by name, email, role…"
                className="w-full rounded-app border border-app bg-app-surface py-2 pl-9 pr-3 text-sm text-app-primary placeholder:text-app-muted focus:border-app-brand-600 focus:outline-none focus:ring-2 focus:ring-app-brand-100"
              />
            </div>

            <div className="flex items-center gap-2">
              <div className="inline-flex items-center gap-1.5 rounded-app border border-app bg-app-surface px-2.5 py-2 text-sm">
                <HiOutlineFilter size={14} className="text-app-muted" />
                <select
                  value={roleFilter}
                  onChange={e => setRoleFilter(e.target.value)}
                  className="bg-transparent text-sm font-medium text-app-primary focus:outline-none"
                >
                  <option value="all">All roles</option>
                  {availableRoles.map(r => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>

              <div className="inline-flex items-center gap-1.5 rounded-app border border-app bg-app-surface px-2.5 py-2 text-sm">
                <select
                  value={statusFilter}
                  onChange={e => setStatusFilter(e.target.value as any)}
                  className="bg-transparent text-sm font-medium text-app-primary focus:outline-none"
                >
                  <option value="all">All status</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>

              {(query || roleFilter !== 'all' || statusFilter !== 'all') && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="text-xs font-semibold text-app-brand-700 hover:text-app-brand-800"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Empty state */}
        {filteredUsers.length === 0 ? (
          <div className="px-5 py-10">
            <EmptyState
              title={
                users.length === 0 ? 'No users yet' : 'No users match your filters'
              }
              description={
                users.length === 0
                  ? 'Get started by adding your first workspace account.'
                  : 'Try adjusting search or filters to broaden the results.'
              }
              action={
                users.length === 0 ? (
                  <button type="button" onClick={handleAddUser} className={theme.button.primary}>
                    <HiOutlineUserAdd size={16} />
                    Add User
                  </button>
                ) : (
                  <button type="button" onClick={resetFilters} className={theme.button.secondary}>
                    Reset filters
                  </button>
                )
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="app-table">
              <thead>
                <tr>
                  <th className="text-left">User</th>
                  <th className="text-left">Role</th>
                  <th className="text-left">Status</th>
                  <th className="text-left">Access window</th>
                  <th className="text-left">Created</th>
                  <th className="text-right"></th>
                </tr>
              </thead>
              <tbody>
                {pagedUsers.map(u => {
                  const isActive = (u as any).is_active !== false
                  const start = (u as any).allowed_time_start
                  const end = (u as any).allowed_time_end
                  const role = (u as any).role ?? '—'
                  const seed = String(u.username ?? u.email ?? u.id)
                  return (
                    <tr key={u.id ?? (u.username as string) ?? (u.email as string)}>
                      <td>
                        <div className="flex items-center gap-3">
                          <div
                            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                            style={{ background: avatarGradient(seed) }}
                            aria-hidden
                          >
                            {initials(u.username ?? u.email)}
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-app-primary">
                              {u.username ?? '—'}
                            </div>
                            <div className="truncate text-xs text-app-secondary">{u.email ?? '—'}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        {(() => {
                          const chip = roleChipStyle(String(role))
                          return (
                            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset ${chip.bg} ${chip.text} ${chip.ring}`}>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3 w-3">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z" />
                              </svg>
                              {role}
                            </span>
                          )
                        })()}
                      </td>
                      <td>
                        {isActive ? (
                          <StatusBadge tone="success" size="sm" dot>
                            Active
                          </StatusBadge>
                        ) : (
                          <StatusBadge tone="danger" size="sm" dot>
                            Inactive
                          </StatusBadge>
                        )}
                      </td>
                      <td>
                        {start && end ? (
                          <div className="flex flex-col gap-1 min-w-[120px]">
                            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-app-primary">
                              <HiOutlineClock className="text-app-secondary" size={14} />
                              {start} – {end}
                            </span>
                            <span className="h-1 w-24 rounded-full bg-app-surface-muted overflow-hidden">
                              <span className="block h-full w-1/2 rounded-full bg-app-success" />
                            </span>
                          </div>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs text-app-secondary">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.133-8-12.739-8-4.585 0-4.585 8 0 8 5.606 0 7.644-8 12.74-8z" />
                            </svg>
                            24/7 access
                          </span>
                        )}
                      </td>
                      <td className="text-xs text-app-secondary">
                        {u.created_at ? formatToDubaiTime(u.created_at) : '—'}
                      </td>
                      <td className="text-right">
                        {isAdminUser(u) ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-app-success-bg px-2.5 py-1 text-[11px] font-semibold text-app-success ring-1 ring-inset ring-green-200">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-3 w-3">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                            Protected
                          </span>
                        ) : (
                          <div className="relative inline-flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => handleEdit(u)}
                              aria-label="Edit user"
                              title="Edit"
                              className="inline-flex h-8 w-8 items-center justify-center rounded-[10px] border border-app bg-app-surface text-app-brand-700 transition hover:border-app-brand-200 hover:bg-app-brand-50"
                            >
                              <HiOutlinePencilAlt size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteClick(u)}
                              aria-label="Delete user"
                              title="Delete"
                              className="inline-flex h-8 w-8 items-center justify-center rounded-[10px] border border-app bg-app-surface text-app-danger transition hover:border-red-200 hover:bg-app-danger-bg"
                            >
                              <HiOutlineTrash size={14} />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {/* Pagination */}
            {filteredUsers.length > pageSize && (
              <div className="flex flex-col items-center justify-between gap-3 border-t border-app px-5 py-3 sm:flex-row">
                <div className="text-xs text-app-secondary">
                  Rows per page: <span className="font-semibold text-app-primary">{pageSize}</span>
                  &nbsp;·&nbsp;Showing{' '}
                  <span className="font-semibold text-app-primary">
                    {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, filteredUsers.length)}
                  </span>{' '}
                  of <span className="font-semibold text-app-primary">{filteredUsers.length}</span> users
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setCurrentPage(1)}
                    disabled={currentPage === 1}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-app border border-app bg-app-surface text-xs text-app-secondary transition hover:bg-app-surface-muted disabled:opacity-40"
                    aria-label="First page"
                  >
                    «
                  </button>
                  <button
                    type="button"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-app border border-app bg-app-surface text-xs text-app-secondary transition hover:bg-app-surface-muted disabled:opacity-40"
                    aria-label="Previous page"
                  >
                    ‹
                  </button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1)
                    .filter(p => p === 1 || p === totalPages || Math.abs(p - currentPage) <= 1)
                    .reduce<(number | '…')[]>((acc, p, idx, arr) => {
                      if (idx > 0 && (p as number) - (arr[idx - 1] as number) > 1) acc.push('…')
                      acc.push(p)
                      return acc
                    }, [])
                    .map((p, idx) =>
                      p === '…' ? (
                        <span key={`ellipsis-${idx}`} className="px-1 text-xs text-app-muted">…</span>
                      ) : (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setCurrentPage(p as number)}
                          className={`inline-flex h-7 w-7 items-center justify-center rounded-app border text-xs font-medium transition ${
                            currentPage === p
                              ? 'border-app-brand-700 bg-app-brand-700 text-white'
                              : 'border-app bg-app-surface text-app-primary hover:bg-app-surface-muted'
                          }`}
                        >
                          {p}
                        </button>
                      )
                    )}
                  <button
                    type="button"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-app border border-app bg-app-surface text-xs text-app-secondary transition hover:bg-app-surface-muted disabled:opacity-40"
                    aria-label="Next page"
                  >
                    ›
                  </button>
                  <button
                    type="button"
                    onClick={() => setCurrentPage(totalPages)}
                    disabled={currentPage === totalPages}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-app border border-app bg-app-surface text-xs text-app-secondary transition hover:bg-app-surface-muted disabled:opacity-40"
                    aria-label="Last page"
                  >
                    »
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </SectionCard>

      <UserModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onUserCreated={handleUserCreated}
      />

      <EditUserModal
        isOpen={Boolean(editUser)}
        user={editUser}
        onClose={() => setEditUser(null)}
        onSaved={handleUserUpdated}
      />

      {/* Delete confirmation */}
      {deleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          aria-modal="true"
          role="dialog"
          onClick={() => !deleting && handleDeleteCancel()}
        >
          <div
            className="w-full max-w-md overflow-hidden rounded-app-lg border border-app bg-app-surface shadow-app-card-lg"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-4 px-6 pb-2 pt-6">
              <IconBadge tone="danger" size="lg">
                <HiOutlineExclamation size={22} />
              </IconBadge>
              <div className="flex-1">
                <h3 className="text-base font-semibold text-app-primary">Delete user?</h3>
                <p className="mt-1 text-sm text-app-secondary">
                  Are you sure you want to delete{' '}
                  <strong className="text-app-primary">
                    {deleteConfirm.username || deleteConfirm.email}
                  </strong>
                  ? This action cannot be undone — the account will be permanently removed.
                </p>
              </div>
              <button
                type="button"
                onClick={handleDeleteCancel}
                disabled={deleting}
                className="rounded-md p-1 text-app-muted transition hover:bg-app-surface-muted hover:text-app-primary disabled:opacity-50"
                aria-label="Close"
              >
                <HiOutlineX size={18} />
              </button>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-app bg-app-surface-muted/40 px-6 py-3">
              <button
                type="button"
                onClick={handleDeleteCancel}
                disabled={deleting}
                className={theme.button.secondary}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                disabled={deleting}
                className={theme.button.danger}
              >
                {deleting ? (
                  <>
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                    </svg>
                    Deleting…
                  </>
                ) : (
                  <>
                    <HiOutlineTrash size={14} />
                    Delete user
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {notification && (
        <Notification
          message={notification.message}
          type={notification.type}
          onClose={() => setNotification(null)}
          duration={4000}
        />
      )}
    </div>
  )
}

export default Users
