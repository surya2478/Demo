import React, { useEffect, useMemo, useRef, useState } from 'react'
import { format } from 'date-fns'
import DatePicker from 'react-datepicker'
import 'react-datepicker/dist/react-datepicker.css'
import {
  HiOutlineClipboardList,
  HiOutlineUser,
  HiOutlineShieldCheck,
  HiOutlineExclamationCircle,
  HiOutlineRefresh,
  HiOutlineFilter,
  HiOutlineSearch,
  HiOutlineX,
  HiOutlineArrowsExpand,
  HiOutlineChevronDown,
  HiOutlineChevronRight
} from 'react-icons/hi'
import auditService, { AuditLogResponse } from '../services/auditService'
import Loader from '../components/Loader'
import { useAuth } from '../hooks/useAuth'
import Notification from '../components/Notification'
import MarkdownViewer from '../components/MarkdownViewer'
import SectionCard from '../components/ui/SectionCard'
import StatusBadge from '../components/ui/StatusBadge'
import MetricCard from '../components/ui/MetricCard'
import IconBadge from '../components/ui/IconBadge'
import EmptyState from '../components/ui/EmptyState'
import { usePageHeader } from '../components/layout/PageHeaderContext'
import { theme } from '../styles/theme'

interface AuditFilter {
  user?: string
  module?: string
  action?: string
  status?: string
  startDate?: Date
  endDate?: Date
}

type SortBy = 'date' | 'timestamp' | 'user' | 'module' | 'action' | 'status'
type SortDir = 'asc' | 'desc'

const actionOptions = [
  { value: 'Ask', label: 'Ask Query' },
  { value: 'Create User', label: 'Create' },
  { value: 'Update User', label: 'Update' },
  { value: 'Delete User', label: 'Delete' },
  { value: 'Change Password', label: 'Change Password' },
  { value: 'Export to Excel', label: 'Export to Excel' },
  { value: 'Generate Test Case', label: 'Generate Test Case' },
  { value: 'Generate Test Data', label: 'Generate Test Data' },
  { value: 'Login', label: 'Login' },
  { value: 'Logout', label: 'Logout' },
  { value: 'Extend', label: 'Extend' },
  { value: 'Terminate', label: 'Terminate' }
]

const moduleOptions = [
  { value: 'User Management', label: 'User Management' },
  { value: 'Authentication', label: 'Authentication' },
  { value: 'Sessions', label: 'Sessions' },
  { value: 'Settings', label: 'Settings' },
  { value: 'Test Cases', label: 'Test Cases' },
  { value: 'Visual', label: 'Visual' },
  { value: 'Test Data', label: 'Test Data' },
  { value: 'Changes', label: 'Changes' },
  { value: 'Unit', label: 'Unit' },
  { value: 'Knowledge Base', label: 'Knowledge Base' }
]

const isEmptyValue = (v: any): boolean => {
  if (v === null || v === undefined) return true
  if (typeof v === 'string' && v.trim() === '') return true
  if (Array.isArray(v) && v.length === 0) return true
  if (typeof v === 'object' && Object.keys(v).length === 0) return true
  return false
}

const toTitleCase = (s: string) => {
  if (!s || s === null || s === undefined) return ''
  const str = String(s || '')
  if (!str || str.trim() === '') return ''
  const spaced = str
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
  if (!spaced) return ''
  return spaced
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

const parseJsonSafely = (input: any): any => {
  if (input === null || input === undefined) return input
  if (typeof input === 'object') return input
  if (typeof input !== 'string') return input
  const s = input.trim()
  if (s === '') return s
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

const extractTokenCounts = (responseStr: string | null | undefined) => {
  if (!responseStr) return null
  try {
    const str = String(responseStr)
    const pattern = /\[TOKEN_COUNTS:Prompt=(\d+),Response=(\d+),Total=(\d+)\]/
    const match = str.match(pattern)
    if (match) {
      return {
        prompt: parseInt(match[1], 10),
        response: parseInt(match[2], 10),
        total: parseInt(match[3], 10)
      }
    }
  } catch (e) {
    console.error('Error extracting token counts:', e)
  }
  return null
}

const isJsonObject = (val: any): boolean => {
  if (val === null || val === undefined) return false
  const parsed = parseJsonSafely(val)
  return typeof parsed === 'object' && !Array.isArray(parsed) && parsed !== null
}

const moduleTone = (module: string): 'brand' | 'success' | 'warning' | 'info' | 'neutral' => {
  const m = (module || '').toLowerCase()
  if (m.includes('user') || m.includes('auth')) return 'brand'
  if (m.includes('session')) return 'success'
  if (m.includes('setting')) return 'warning'
  if (m.includes('test') || m.includes('knowledge')) return 'info'
  return 'neutral'
}

const statusTone = (status: string): 'success' | 'danger' | 'warning' | 'neutral' => {
  switch (status) {
    case 'success':
      return 'success'
    case 'failure':
      return 'danger'
    case 'warning':
      return 'warning'
    default:
      return 'neutral'
  }
}

const AuditLogs: React.FC = () => {
  const { user } = useAuth()
  const didLoadRef = useRef(false)

  const [fullScreenContent, setFullScreenContent] = useState<string | null>(null)
  const [fullScreenTitle, setFullScreenTitle] = useState<string>('Full Screen View')

  const [logs, setLogs] = useState<AuditLogResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'user' | 'admin'>('user')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [totalCount, setTotalCount] = useState(0)
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [showDetails, setShowDetails] = useState<number | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(true)

  const [userFilters, setUserFilters] = useState<AuditFilter>({})
  const [userFilterForm, setUserFilterForm] = useState<AuditFilter>({})
  const [adminFilters, setAdminFilters] = useState<AuditFilter>({})
  const [adminFilterForm, setAdminFilterForm] = useState<AuditFilter>({})

  const filters = activeTab === 'admin' ? adminFilters : userFilters
  const setFilters = activeTab === 'admin' ? setAdminFilters : setUserFilters
  const filterForm = activeTab === 'admin' ? adminFilterForm : userFilterForm
  const setFilterForm = activeTab === 'admin' ? setAdminFilterForm : setUserFilterForm

  const availableModules =
    activeTab === 'admin' ? moduleOptions : moduleOptions.filter(m => m.value !== 'Settings')
  const availableActions =
    activeTab === 'admin'
      ? actionOptions
      : actionOptions.filter(
          a =>
            a.value !== 'Create User' &&
            a.value !== 'Update User' &&
            a.value !== 'Delete User' &&
            a.value !== 'Terminate'
        )

  const [sortBy, setSortBy] = useState<SortBy>('timestamp')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const isAdmin = useMemo(() => {
    if (!user) return false
    const roles = typeof user === 'object' ? (user as any).roles || [] : []
    return Array.isArray(roles) ? roles.some(r => String(r).toLowerCase() === 'admin') : false
  }, [user])

  const applySorting = (items: AuditLogResponse[]) => {
    const sorted = [...items]
    sorted.sort((a, b) => {
      let av: any = null
      let bv: any = null

      switch (sortBy) {
        case 'timestamp':
          av =
            a.details && (a.details as any).timestamp
              ? new Date((a.details as any).timestamp).getTime()
              : new Date(a.created_at).getTime()
          bv =
            b.details && (b.details as any).timestamp
              ? new Date((b.details as any).timestamp).getTime()
              : new Date(b.created_at).getTime()
          break
        case 'date': {
          const da = new Date(a.created_at)
          da.setHours(0, 0, 0, 0)
          const db = new Date(b.created_at)
          db.setHours(0, 0, 0, 0)
          av = da.getTime()
          bv = db.getTime()
          break
        }
        case 'user':
          av = String(a.actor_username || '').toLowerCase()
          bv = String(b.actor_username || '').toLowerCase()
          break
        case 'module':
          av = String(a.module || '').toLowerCase()
          bv = String(b.module || '').toLowerCase()
          break
        case 'action':
          av = String(a.action || '').toLowerCase()
          bv = String(b.action || '').toLowerCase()
          break
        case 'status':
          av = String(a.status || '').toLowerCase()
          bv = String(b.status || '').toLowerCase()
          break
        default:
          av = String(a.created_at || '').toLowerCase()
          bv = String(b.created_at || '').toLowerCase()
      }

      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av
      }
      const sa = av == null ? '' : String(av)
      const sb = bv == null ? '' : String(bv)
      return sortDir === 'asc' ? sa.localeCompare(sb) : sb.localeCompare(sa)
    })
    return sorted
  }

  const loadLogs = async () => {
    setLoading(true)
    try {
      let response
      if (activeTab === 'admin') {
        response = await auditService.fetchAdminLogs(page, pageSize, {
          module: filters.module,
          action: filters.action
        })
      } else {
        response = await auditService.fetchUserLogs(page, pageSize, {
          module: filters.module,
          action: filters.action
        })
      }

      const items: AuditLogResponse[] = response.items || []
      let filtered = items.slice()

      if (filters.startDate) filtered = filtered.filter(l => new Date(l.created_at) >= filters.startDate!)
      if (filters.endDate) {
        const ed = new Date(filters.endDate)
        ed.setHours(23, 59, 59, 999)
        filtered = filtered.filter(l => new Date(l.created_at) <= ed)
      }
      if (filters.status) filtered = filtered.filter(l => l.status === filters.status)
      if (filters.user) {
        const needle = filters.user.trim().toLowerCase()
        filtered = filtered.filter(l => String(l.actor_username || '').toLowerCase().includes(needle))
      }
      if (filters.module) {
        filtered = filtered.filter(l => String(l.module || '').toLowerCase() === String(filters.module).toLowerCase())
      }
      if (filters.action) {
        filtered = filtered.filter(l => String(l.action || '').toLowerCase() === String(filters.action).toLowerCase())
      }

      setLogs(applySorting(filtered))
      setTotalCount(response.total)
    } catch (error) {
      console.error('[AuditLogs] Failed to load logs:', error)
      setNotification({ message: 'Failed to load audit logs', type: 'error' })
      setLogs([])
      setTotalCount(0)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (didLoadRef.current) return
    didLoadRef.current = true
    loadLogs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!didLoadRef.current) return
    if (page === 1) loadLogs()
    else setPage(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, filters, sortBy, sortDir])

  useEffect(() => {
    if (!didLoadRef.current) return
    loadLogs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page])

  useEffect(() => {
    if (!didLoadRef.current) return
    if (page === 1) loadLogs()
    else setPage(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize])

  const totalPages = Math.ceil(totalCount / pageSize)

  // KPI counts derived from current loaded page (best we can do without a dedicated summary endpoint)
  const kpis = useMemo(() => {
    let failures = 0
    let warnings = 0
    const userSet = new Set<string>()
    logs.forEach(l => {
      if (l.status === 'failure') failures++
      else if (l.status === 'warning') warnings++
      if (l.actor_username) userSet.add(l.actor_username)
    })
    return { failures, warnings, distinctUsers: userSet.size }
  }, [logs])

  // Wire header
  usePageHeader({
    title: 'Audit Logs',
    subtitle: 'Track all user and admin activities across the system.',
    showSearch: false,
    actions: (
      <button
        type="button"
        onClick={() => {
          setPage(1)
          loadLogs()
        }}
        disabled={loading}
        className={theme.button.primary}
      >
        <HiOutlineRefresh size={14} />
        {loading ? 'Refreshing…' : 'Refresh'}
      </button>
    )
  })

  // Detail / fullscreen renderers (preserve original behavior, restyled)
  const isFilesKey = (k: string) => String(k || '').trim().toLowerCase() === 'files'

  const renderFilesValue = (filesVal: any) => {
    if (!Array.isArray(filesVal) || filesVal.length === 0) {
      return <span className="text-xs text-app-muted">[empty]</span>
    }
    return (
      <div className="space-y-2">
        {filesVal.map((file, idx) => {
          const entries =
            typeof file === 'object' && file !== null ? Object.entries(file) : [['Value', String(file ?? '')]]
          return (
            <div key={idx} className="rounded-app border border-app bg-app-surface px-3 py-2">
              <div className="mb-1 text-xs font-semibold text-app-secondary">File {idx + 1}</div>
              <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm text-app-primary sm:grid-cols-2">
                {entries.map(([fk, fv]) => (
                  <React.Fragment key={fk}>
                    <dt className="font-medium text-app-secondary">{toTitleCase(fk)}</dt>
                    <dd className="whitespace-pre-wrap break-words text-app-primary">{String(fv ?? '')}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </div>
          )
        })}
      </div>
    )
  }

  const renderJsonKeyValueTable = (obj: any) => {
    if (obj === null || obj === undefined) return <span className="text-xs text-app-muted">[empty]</span>
    const parsed = parseJsonSafely(obj)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const s = parsed === null || parsed === undefined ? '' : String(parsed)
      if (s.trim() === '') return <span className="text-xs text-app-muted">[empty]</span>
      return (
        <div className="whitespace-pre-wrap break-words text-sm text-app-primary">{s}</div>
      )
    }

    const rows = Object.entries(parsed).filter(([_, v]) => !isEmptyValue(v))
    if (rows.length === 0) return <span className="text-xs text-app-muted">[empty]</span>

    if (rows.length === 1) {
      const [k, v] = rows[0]
      const label = toTitleCase(k)
      if (isFilesKey(k) && Array.isArray(v)) {
        return (
          <div className="rounded-app border border-app bg-app-surface p-3">{renderFilesValue(v)}</div>
        )
      }
      const displayValue = typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)
      const isLongValue = displayValue.length > 300
      return (
        <div className="rounded-app border border-app bg-app-surface">
          {isLongValue ? (
            <div className="max-h-40 overflow-auto rounded-app bg-app-surface-muted p-3">
              <MarkdownViewer content={displayValue} className="text-sm break-words" />
            </div>
          ) : (
            <div className="p-3">
              <MarkdownViewer content={displayValue} className="text-sm break-words" />
            </div>
          )}
        </div>
      )
    }

    return (
      <div className="overflow-hidden rounded-app border border-app bg-app-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-app-surface-muted">
              <th className="px-3 py-2 text-left font-semibold text-app-secondary">Key</th>
              <th className="px-3 py-2 text-left font-semibold text-app-secondary">Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, v]) => {
              const label = toTitleCase(k)
              if (isFilesKey(k) && Array.isArray(v)) {
                return (
                  <tr key={k} className="border-t border-app">
                    <td className="w-44 whitespace-nowrap px-3 py-2 align-top font-medium text-app-secondary">
                      {label}
                    </td>
                    <td className="px-3 py-2 align-top text-app-primary">{renderFilesValue(v)}</td>
                  </tr>
                )
              }
              const displayValue = typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)
              const isLongValue = displayValue.length > 300
              return (
                <tr key={k} className="border-t border-app">
                  <td className="w-44 whitespace-nowrap px-3 py-2 align-top font-medium text-app-secondary">
                    {label}
                  </td>
                  <td className="px-3 py-2 align-top text-app-primary">
                    {isLongValue ? (
                      <div>
                        <div className="mb-1 flex justify-end">
                          <button
                            type="button"
                            onClick={() => {
                              setFullScreenTitle(`Request Payload – ${label}`)
                              setFullScreenContent(displayValue)
                            }}
                            className="inline-flex items-center gap-1 rounded-md border border-app bg-app-surface px-2 py-1 text-xs font-medium text-app-secondary hover:bg-app-surface-muted"
                            title="View fullscreen"
                          >
                            <HiOutlineArrowsExpand size={12} />
                            Fullscreen
                          </button>
                        </div>
                        <div className="max-h-32 overflow-auto rounded-app border border-app bg-app-surface-muted p-2">
                          <MarkdownViewer content={displayValue} className="text-sm break-words" />
                        </div>
                      </div>
                    ) : (
                      <MarkdownViewer content={displayValue} className="text-sm break-words" />
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  const renderResponseCard = (val: any) => {
    if (val === null || val === undefined) return null
    const parsed = parseJsonSafely(val)
    const contentStr = typeof parsed === 'object' ? JSON.stringify(parsed, null, 2) : String(parsed)
    if (isEmptyValue(contentStr)) return null
    const isJsonObj = isJsonObject(val)
    const isLongResponse = isJsonObj ? false : contentStr.length > 300

    return (
      <div className="rounded-app border border-app bg-app-surface p-3">
        {isLongResponse && (
          <div className="mb-2 flex justify-end">
            <button
              type="button"
              onClick={() => {
                setFullScreenTitle('Response Payload')
                setFullScreenContent(contentStr)
              }}
              className="inline-flex items-center gap-1 rounded-md border border-app bg-app-surface px-2 py-1 text-xs font-medium text-app-secondary hover:bg-app-surface-muted"
            >
              <HiOutlineArrowsExpand size={12} />
              Fullscreen
            </button>
          </div>
        )}
        <div className="max-h-48 overflow-auto rounded-app bg-app-surface-muted p-2">
          {isJsonObj ? (
            renderJsonKeyValueTable(parsed)
          ) : (
            <MarkdownViewer content={contentStr} className="text-sm break-words" />
          )}
        </div>
      </div>
    )
  }

  const renderDetailsPanel = (log: AuditLogResponse) => {
    if (!log.details) return null
    const details: any = log.details
    const ctx = details.context || {}
    const req = ctx.request_payload || ctx.request || null
    const resp = ctx.response_payload || ctx.response || null
    const reqParsed = !isEmptyValue(req) ? parseJsonSafely(req) : null
    const respParsed = !isEmptyValue(resp) ? parseJsonSafely(resp) : null
    const shouldRenderContext =
      (reqParsed && !isEmptyValue(reqParsed)) || (respParsed && !isEmptyValue(respParsed))

    return (
      <div className="space-y-4">
        {/* meta strip */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-app-brand-700">Event time</span>
            <span className="rounded-md bg-app-surface-muted px-2 py-1 text-xs text-app-primary">
              {(() => {
                let formatted = '—'
                if (details.timestamp) {
                  try {
                    const dateObj = new Date(details.timestamp)
                    formatted = !isNaN(dateObj.getTime())
                      ? format(dateObj, 'MMM dd, yyyy hh:mm:ss a')
                      : String(details.timestamp)
                  } catch {
                    formatted = String(details.timestamp)
                  }
                } else if (log.created_at) {
                  try {
                    const dateObj = new Date(log.created_at)
                    formatted = !isNaN(dateObj.getTime())
                      ? format(dateObj, 'MMM dd, yyyy hh:mm:ss a')
                      : String(log.created_at)
                  } catch {
                    formatted = String(log.created_at)
                  }
                }
                return formatted
              })()}
            </span>
          </div>
          {details.description && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-app-brand-700">Description</span>
              <span className="text-sm text-app-primary">{details.description}</span>
            </div>
          )}
        </div>

        {shouldRenderContext && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {reqParsed && (
              <div>
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-app-brand-700">Request payload</div>
                {isJsonObject(reqParsed) ? (
                  renderJsonKeyValueTable(reqParsed)
                ) : (
                  <div className="rounded-app border border-app bg-app-surface p-3">
                    <MarkdownViewer content={JSON.stringify(reqParsed)} className="text-sm break-words" />
                  </div>
                )}
              </div>
            )}
            {respParsed && (
              <div>
                {(() => {
                  const respContentStr =
                    typeof respParsed === 'object' ? JSON.stringify(respParsed, null, 2) : String(respParsed)
                  const FULLSCREEN_THRESHOLD = 100
                  const showFullScreen = typeof respParsed === 'object' ? false : respContentStr.length > FULLSCREEN_THRESHOLD
                  const fullScreenMarkdown =
                    typeof respParsed === 'object' ? '```json\n' + JSON.stringify(respParsed, null, 2) + '\n```' : respContentStr
                  const tokenCounts = extractTokenCounts(respContentStr)
                  return (
                    <>
                      <div className="mb-2 flex items-center justify-between">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-app-brand-700">Response payload</div>
                        {showFullScreen && (
                          <button
                            type="button"
                            onClick={() => {
                              setFullScreenTitle('Response Payload')
                              setFullScreenContent(fullScreenMarkdown)
                            }}
                            className="inline-flex items-center gap-1 rounded-md border border-app bg-app-surface px-2 py-1 text-xs font-medium text-app-secondary hover:bg-app-surface-muted"
                          >
                            <HiOutlineArrowsExpand size={12} />
                            Fullscreen
                          </button>
                        )}
                      </div>
                      {isJsonObject(respParsed) ? (
                        renderResponseCard(respParsed)
                      ) : (
                        <div className="rounded-app border border-app bg-app-surface p-3">
                          <div className="max-h-48 overflow-auto rounded-app bg-app-surface-muted p-2">
                            <MarkdownViewer content={respContentStr} className="text-sm break-words" />
                          </div>
                        </div>
                      )}
                      {tokenCounts && (
                        <div className="mt-3 rounded-app border border-app-brand-200 bg-app-brand-50 p-3">
                          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-app-brand-700">
                            Tokens consumed
                          </div>
                          <div className="grid grid-cols-3 gap-2 text-center">
                            <div className="rounded-app bg-app-surface p-2">
                              <div className="text-[10px] uppercase tracking-wider text-app-secondary">Prompt</div>
                              <div className="text-sm font-semibold text-app-brand-700">
                                {tokenCounts.prompt?.toLocaleString()}
                              </div>
                            </div>
                            <div className="rounded-app bg-app-surface p-2">
                              <div className="text-[10px] uppercase tracking-wider text-app-secondary">Response</div>
                              <div className="text-sm font-semibold text-app-brand-700">
                                {tokenCounts.response?.toLocaleString()}
                              </div>
                            </div>
                            <div className="rounded-app bg-app-surface p-2">
                              <div className="text-[10px] uppercase tracking-wider text-app-secondary">Total</div>
                              <div className="text-sm font-semibold text-app-brand-700">
                                {tokenCounts.total?.toLocaleString()}
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </>
                  )
                })()}
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {details.session && (
            <div className="rounded-app border border-app bg-app-surface p-4">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-app-brand-700">Session</div>
              {renderJsonKeyValueTable(details.session)}
            </div>
          )}
          {details.environment && (
            <div className="rounded-app border border-app bg-app-surface p-4">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-app-brand-700">Environment</div>
              {renderJsonKeyValueTable(details.environment)}
            </div>
          )}
        </div>

        {(() => {
          const commonKeys = ['from_tab', 'to_tab', 'from_label', 'to_label', 'reason', 'error', 'before', 'after']
          const otherKeys = Object.keys(details).filter(
            k => !commonKeys.includes(k) && !['timestamp', 'description', 'context', 'session', 'environment'].includes(k)
          )
          return otherKeys.length > 0 ? (
            <div className="rounded-app border border-app bg-app-surface-muted/40 p-4">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-app-brand-700">
                Additional information
              </div>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                {otherKeys.map(key => (
                  <React.Fragment key={key}>
                    <dt className="text-xs font-semibold text-app-secondary">
                      {key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                    </dt>
                    <dd className="text-xs text-app-primary">
                      {details[key] === null || details[key] === undefined || details[key] === '' ? (
                        <span className="text-app-muted">[empty]</span>
                      ) : (
                        String(details[key])
                      )}
                    </dd>
                  </React.Fragment>
                ))}
              </dl>
            </div>
          ) : null
        })()}
      </div>
    )
  }

  const hasActiveFilters =
    !!filterForm.user ||
    !!filterForm.module ||
    !!filterForm.action ||
    !!filterForm.status ||
    !!filterForm.startDate ||
    !!filterForm.endDate

  return (
    <div className="space-y-6">
      {/* KPI ROW */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard
          label="Events on page"
          value={totalCount.toLocaleString()}
          icon={<HiOutlineClipboardList size={18} />}
          tone="brand"
        />
        <MetricCard
          label="Failures"
          value={kpis.failures}
          icon={<HiOutlineExclamationCircle size={18} />}
          tone={kpis.failures > 0 ? 'danger' : 'success'}
        />
        <MetricCard
          label="Warnings"
          value={kpis.warnings}
          icon={<HiOutlineExclamationCircle size={18} />}
          tone={kpis.warnings > 0 ? 'warning' : 'neutral'}
        />
        <MetricCard
          label="Active users"
          value={kpis.distinctUsers}
          icon={<HiOutlineUser size={18} />}
          tone="neutral"
        />
      </section>

      {notification && (
        <Notification
          message={notification.message}
          type={notification.type}
          onClose={() => setNotification(null)}
          duration={3500}
        />
      )}

      {/* Tabs (admin only) */}
      {isAdmin && (
        <div className="inline-flex items-center gap-1 rounded-app border border-app bg-app-surface p-1 shadow-app-card">
          <button
            type="button"
            onClick={() => setActiveTab('user')}
            className={`inline-flex items-center gap-2 rounded-app-sm px-3 py-1.5 text-sm font-semibold transition ${
              activeTab === 'user'
                ? 'bg-app-brand-700 text-white shadow-sm'
                : 'text-app-secondary hover:bg-app-surface-muted'
            }`}
          >
            <HiOutlineUser size={14} />
            User Activities
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('admin')}
            className={`inline-flex items-center gap-2 rounded-app-sm px-3 py-1.5 text-sm font-semibold transition ${
              activeTab === 'admin'
                ? 'bg-app-brand-700 text-white shadow-sm'
                : 'text-app-secondary hover:bg-app-surface-muted'
            }`}
          >
            <HiOutlineShieldCheck size={14} />
            Admin Activities
          </button>
        </div>
      )}

      {/* Filter bar */}
      <SectionCard
        title="Filters"
        description="Narrow logs by user, module, action, status, or date range."
        actions={
          <button
            type="button"
            onClick={() => setFiltersOpen(o => !o)}
            className={theme.button.secondary}
          >
            {filtersOpen ? <HiOutlineChevronDown size={14} /> : <HiOutlineChevronRight size={14} />}
            {filtersOpen ? 'Hide' : 'Show'}
          </button>
        }
      >
        {filtersOpen && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-app-secondary">
                  User
                </label>
                <div className="relative">
                  <HiOutlineSearch
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-app-muted"
                    size={14}
                  />
                  <input
                    value={filterForm.user || ''}
                    onChange={e =>
                      setFilterForm(prev => ({ ...prev, user: e.target.value || undefined }))
                    }
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        setFilters(filterForm)
                        setPage(1)
                      }
                    }}
                    placeholder="Username"
                    className="w-full rounded-app border border-app bg-app-surface py-2 pl-8 pr-3 text-sm placeholder:text-app-muted focus:border-app-brand-600 focus:outline-none focus:ring-2 focus:ring-app-brand-100"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-app-secondary">
                  Module
                </label>
                <select
                  value={filterForm.module || ''}
                  onChange={e =>
                    setFilterForm(prev => ({ ...prev, module: e.target.value || undefined }))
                  }
                  className="w-full rounded-app border border-app bg-app-surface px-3 py-2 text-sm focus:border-app-brand-600 focus:outline-none focus:ring-2 focus:ring-app-brand-100"
                >
                  <option value="">All modules</option>
                  {availableModules.map(mod => (
                    <option key={mod.value} value={mod.value}>
                      {mod.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-app-secondary">
                  Action
                </label>
                <select
                  value={filterForm.action || ''}
                  onChange={e =>
                    setFilterForm(prev => ({ ...prev, action: e.target.value || undefined }))
                  }
                  className="w-full rounded-app border border-app bg-app-surface px-3 py-2 text-sm focus:border-app-brand-600 focus:outline-none focus:ring-2 focus:ring-app-brand-100"
                >
                  <option value="">All actions</option>
                  {availableActions.map(act => (
                    <option key={act.value} value={act.value}>
                      {act.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-app-secondary">
                  Status
                </label>
                <select
                  value={filterForm.status || ''}
                  onChange={e =>
                    setFilterForm(prev => ({ ...prev, status: e.target.value || undefined }))
                  }
                  className="w-full rounded-app border border-app bg-app-surface px-3 py-2 text-sm focus:border-app-brand-600 focus:outline-none focus:ring-2 focus:ring-app-brand-100"
                >
                  <option value="">All status</option>
                  <option value="success">Success</option>
                  <option value="failure">Failure</option>
                  <option value="warning">Warning</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-app-secondary">
                  From
                </label>
                <DatePicker
                  selected={filterForm.startDate}
                  onChange={date =>
                    setFilterForm(prev => ({ ...prev, startDate: date || undefined }))
                  }
                  placeholderText="Start"
                  dateFormat="MMM dd, yyyy"
                  className="w-full rounded-app border border-app bg-app-surface px-3 py-2 text-sm focus:border-app-brand-600 focus:outline-none focus:ring-2 focus:ring-app-brand-100"
                />
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-app-secondary">
                  To
                </label>
                <DatePicker
                  selected={filterForm.endDate}
                  onChange={date =>
                    setFilterForm(prev => ({ ...prev, endDate: date || undefined }))
                  }
                  placeholderText="End"
                  dateFormat="MMM dd, yyyy"
                  className="w-full rounded-app border border-app bg-app-surface px-3 py-2 text-sm focus:border-app-brand-600 focus:outline-none focus:ring-2 focus:ring-app-brand-100"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={() => {
                    if (activeTab === 'admin') {
                      setAdminFilterForm({})
                      setAdminFilters({})
                    } else {
                      setUserFilterForm({})
                      setUserFilters({})
                    }
                    setPage(1)
                  }}
                  className={theme.button.secondary}
                >
                  <HiOutlineX size={14} />
                  Clear
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setFilters(filterForm)
                  setPage(1)
                }}
                className={theme.button.primary}
              >
                <HiOutlineFilter size={14} />
                Apply
              </button>
            </div>
          </div>
        )}
      </SectionCard>

      {/* Logs table */}
      <SectionCard
        title={activeTab === 'admin' ? 'Admin activities' : 'User activities'}
        description={`Sorted by ${sortBy === 'timestamp' ? 'timestamp' : sortBy}, ${sortDir}ending`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-1.5 rounded-app border border-app bg-app-surface px-2.5 py-1.5 text-xs">
              <span className="text-app-secondary">Sort</span>
              <select
                value={sortBy}
                onChange={e => setSortBy(e.target.value as SortBy)}
                className="bg-transparent font-medium text-app-primary focus:outline-none"
              >
                <option value="timestamp">Timestamp</option>
                <option value="date">Date</option>
                <option value="user">User</option>
                <option value="module">Module</option>
                <option value="action">Action</option>
                <option value="status">Status</option>
              </select>
              <button
                type="button"
                onClick={() => setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))}
                className="text-app-secondary hover:text-app-primary"
                aria-label="Toggle sort direction"
                title="Toggle sort direction"
              >
                {sortDir === 'asc' ? '↑' : '↓'}
              </button>
            </div>

            <div className="inline-flex items-center gap-1.5 rounded-app border border-app bg-app-surface px-2.5 py-1.5 text-xs">
              <span className="text-app-secondary">Per page</span>
              <select
                value={pageSize}
                onChange={e => setPageSize(Math.max(1, parseInt(e.target.value || '50', 10)))}
                className="bg-transparent font-medium text-app-primary focus:outline-none"
              >
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </div>
          </div>
        }
        contentClassName="px-0 py-0"
      >
        {loading ? (
          <div className="p-8">
            <Loader />
          </div>
        ) : logs.length === 0 ? (
          <div className="px-5 py-10">
            <EmptyState
              title="No audit logs found"
              description="Adjust filters or wait for new activity to appear."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="app-table">
              <thead>
                <tr>
                  <th className="text-left">Timestamp</th>
                  <th className="text-left">User</th>
                  <th className="text-left">Role</th>
                  <th className="text-left">Module</th>
                  <th className="text-left">Action</th>
                  <th className="text-left">Status</th>
                  <th className="text-right">Details</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(log => {
                  const expanded = showDetails === log.id
                  return (
                    <React.Fragment key={`${log.id}-${log.created_at}`}>
                      <tr>
                        <td className="whitespace-nowrap text-xs text-app-secondary">
                          {format(new Date(log.created_at), 'MMM dd, yyyy hh:mm:ss a')}
                        </td>
                        <td className="whitespace-nowrap text-sm font-medium text-app-primary">
                          {log.actor_username || '—'}
                        </td>
                        <td>
                          <StatusBadge tone={log.actor_role === 'admin' ? 'warning' : 'brand'} size="sm">
                            {log.actor_role ? log.actor_role.toUpperCase() : 'N/A'}
                          </StatusBadge>
                        </td>
                        <td>
                          <StatusBadge tone={moduleTone(log.module)} size="sm">
                            {log.module || '—'}
                          </StatusBadge>
                        </td>
                        <td className="text-sm text-app-primary">{log.action || '—'}</td>
                        <td>
                          <StatusBadge tone={statusTone(log.status)} size="sm" dot>
                            {log.status || 'unknown'}
                          </StatusBadge>
                        </td>
                        <td className="text-right">
                          {log.details ? (
                            <button
                              type="button"
                              onClick={() => setShowDetails(expanded ? null : log.id)}
                              className="inline-flex items-center gap-1 rounded-app px-2.5 py-1.5 text-xs font-semibold text-app-brand-700 transition hover:bg-app-brand-50"
                            >
                              {expanded ? (
                                <>
                                  <HiOutlineChevronDown size={14} />
                                  Hide
                                </>
                              ) : (
                                <>
                                  <HiOutlineChevronRight size={14} />
                                  Show
                                </>
                              )}
                            </button>
                          ) : (
                            <span className="text-xs text-app-muted">—</span>
                          )}
                        </td>
                      </tr>
                      {expanded && log.details && (
                        <tr className="bg-app-surface-muted/40">
                          <td colSpan={7} className="p-5">
                            {renderDetailsPanel(log)}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex flex-col items-center justify-between gap-3 border-t border-app px-5 py-3 sm:flex-row">
            <p className="text-xs text-app-secondary">
              Showing <span className="font-semibold text-app-primary">{(page - 1) * pageSize + 1}</span> to{' '}
              <span className="font-semibold text-app-primary">{Math.min(page * pageSize, totalCount)}</span> of{' '}
              <span className="font-semibold text-app-primary">{totalCount}</span> results
            </p>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page === 1}
                className={`${theme.button.secondary} px-2.5 py-1.5`}
              >
                Prev
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter(p => Math.abs(p - page) <= 2 || p === 1 || p === totalPages)
                .map((p, i, arr) => (
                  <React.Fragment key={p}>
                    {i > 0 && arr[i - 1] !== p - 1 && <span className="px-1 text-app-muted">…</span>}
                    <button
                      type="button"
                      onClick={() => setPage(p)}
                      className={`inline-flex h-8 min-w-[2rem] items-center justify-center rounded-app px-2 text-xs font-semibold transition ${
                        p === page
                          ? 'bg-app-brand-700 text-white shadow-sm'
                          : 'border border-app bg-app-surface text-app-secondary hover:bg-app-surface-muted'
                      }`}
                    >
                      {p}
                    </button>
                  </React.Fragment>
                ))}
              <button
                type="button"
                onClick={() => setPage(Math.min(totalPages, page + 1))}
                disabled={page === totalPages}
                className={`${theme.button.secondary} px-2.5 py-1.5`}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </SectionCard>

      {/* Fullscreen modal */}
      {fullScreenContent && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          onClick={() => setFullScreenContent(null)}
        >
          <div
            className="w-full max-w-5xl overflow-hidden rounded-app-lg border border-app bg-app-surface shadow-app-card-lg"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-app px-5 py-3">
              <h3 className="text-sm font-semibold text-app-primary">{fullScreenTitle}</h3>
              <button
                type="button"
                onClick={() => setFullScreenContent(null)}
                className="rounded-md p-1 text-app-muted transition hover:bg-app-surface-muted hover:text-app-primary"
                aria-label="Close"
              >
                <HiOutlineX size={18} />
              </button>
            </div>
            <div className="p-5">
              <div className="max-h-[70vh] overflow-auto rounded-app bg-app-surface-muted p-3">
                <MarkdownViewer content={fullScreenContent || ''} className="text-sm break-words" />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default AuditLogs
