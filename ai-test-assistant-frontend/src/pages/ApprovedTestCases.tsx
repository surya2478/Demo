import React, { useEffect, useMemo, useState } from 'react'
import { HiOutlineChevronDown, HiOutlineChevronRight } from 'react-icons/hi'
import api from '../services/api'
import { getTimestampedFilename } from '../utils/DynamicFileName-DateTime'
import { usePageHeader } from '../components/layout/PageHeaderContext'

interface ApprovedTestCaseItem {
  test_case_id: string
  request_id: string
  document_id?: string | null
  test_case_details: Record<string, string>
  status: string
  rejection_reason?: string | null
  reviewed_by?: string | null
  reviewed_datetime?: string | null
  generated_by?: string | null
}

interface ApprovedRequestGroup {
  request_id: string
  document_id: string
  reviewed_by: string
  reviewed_datetime: string | null
  test_case_count: number
  test_cases: ApprovedTestCaseItem[]
}

const collectDetailColumns = (records: ApprovedTestCaseItem[]): string[] => {
  const keys = new Set<string>()
  records.forEach((item) => {
    Object.keys(item.test_case_details ?? {}).forEach((key) => keys.add(key))
  })
  return Array.from(keys).filter((key) => {
    const normalized = String(key).toLowerCase()
    return normalized !== 'id' && normalized !== 'test_case_id' && normalized !== 'sourcerowid' && normalized !== 'source_row_id' && normalized !== 'sourcerowid_'
  })
}

const getTestCaseTitle = (item: ApprovedTestCaseItem): string => {
  const details = item.test_case_details ?? {}
  const titleKey = Object.keys(details).find((key) => /title|name|summary|description/i.test(key))
  return titleKey ? String(details[titleKey] ?? '') : ''
}

const downloadFile = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

const escapeCsvValue = (value: string): string => {
  const needsQuotes = /[",\n\r]/.test(value)
  const escaped = value.replace(/"/g, '""')
  return needsQuotes ? `"${escaped}"` : escaped
}

const buildExportRows = (records: ApprovedTestCaseItem[], columns: string[]) =>
  records.map((item) => {
    const record: Record<string, string> = {
      'Document ID': item.document_id ?? '',
      'Request ID': item.request_id,
      'Test Case ID': item.test_case_id,
      'Title': getTestCaseTitle(item),
      'Approved By': item.reviewed_by ?? '',
      'Approved Date': item.reviewed_datetime ? new Date(item.reviewed_datetime).toLocaleString() : ''
    }
    columns.forEach((column) => {
      record[column] = String(item.test_case_details?.[column] ?? '')
    })
    return record
  })

const exportRecordsAsCsv = (records: ApprovedTestCaseItem[], columns: string[], baseName: string) => {
  const headers = ['Document ID', 'Request ID', 'Test Case ID', 'Title', 'Approved By', 'Approved Date', ...columns]
  const rows = buildExportRows(records, columns)
  const lines = [headers.map(escapeCsvValue).join(',')]
  rows.forEach((row) => {
    lines.push(headers.map((header) => escapeCsvValue(row[header] ?? '')).join(','))
  })
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  downloadFile(blob, getTimestampedFilename(baseName).replace(/\.xlsx$/i, '.csv'))
}

const exportRecordsAsExcel = async (records: ApprovedTestCaseItem[], columns: string[], baseName: string) => {
  const XLSX = await import('xlsx')
  const rows = buildExportRows(records, columns)
  const worksheet = XLSX.utils.json_to_sheet(rows)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Approved Test Cases')
  XLSX.writeFile(workbook, getTimestampedFilename(baseName))
}

interface ApprovedGroupsTableProps {
  title: string
  groups: ApprovedRequestGroup[]
  loading: boolean
  downloadingRequestId: string | null
  onView: (group: ApprovedRequestGroup) => void
  onDownload: (requestId: string) => void
  showCount?: boolean
  showHeader?: boolean
}

const ApprovedGroupsTable: React.FC<ApprovedGroupsTableProps> = ({ title, groups, loading, downloadingRequestId, onView, onDownload, showCount = false, showHeader = true }) => (
  <section className="overflow-hidden rounded-[14px] border border-slate-200">
    {showHeader && <div className="flex items-center justify-between gap-3 border-b border-red-200 bg-white px-3 py-2">
      <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-red-700">{title}</h2>
      {showCount && <span className="text-[11px] font-semibold text-slate-500">{groups.length} approved request{groups.length === 1 ? '' : 's'}</span>}
    </div>}
    <div className="max-h-[420px] overflow-auto">
      <table className="min-w-full border-collapse text-left text-xs text-slate-700">
        <thead className="sticky top-0 z-10 bg-white"><tr>
          {['Seq. No', 'Document ID', 'Request ID', 'Test Cases', 'Approved By', 'Approved Date', 'Download'].map((column) => (
            <th key={column} className="border-b border-red-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-red-700">{column}</th>
          ))}
        </tr></thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-500">Loading approved test cases...</td></tr>
          ) : groups.length === 0 ? (
            <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-500">No records available.</td></tr>
          ) : groups.map((group, index) => (
            <tr key={group.request_id} className="odd:bg-white even:bg-slate-50">
              <td className="border-b border-slate-200 px-3 py-3 font-semibold text-slate-700">{index + 1}</td>
              <td className="border-b border-slate-200 px-3 py-3 text-slate-700">{group.document_id || '—'}</td>
              <td className="border-b border-slate-200 px-3 py-3 font-semibold text-slate-800">{group.request_id}</td>
              <td className="border-b border-slate-200 px-3 py-3"><button type="button" onClick={() => onView(group)} className="font-semibold text-red-600 underline decoration-red-200 underline-offset-2 hover:text-red-700">View ({group.test_case_count})</button></td>
              <td className="border-b border-slate-200 px-3 py-3 text-slate-700">{group.reviewed_by || '—'}</td>
              <td className="border-b border-slate-200 px-3 py-3 text-slate-700">{group.reviewed_datetime ? new Date(group.reviewed_datetime).toLocaleString() : '—'}</td>
              <td className="border-b border-slate-200 px-3 py-3"><button type="button" disabled={downloadingRequestId === group.request_id} onClick={() => onDownload(group.request_id)} className="font-semibold text-red-600 underline decoration-red-200 underline-offset-2 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40">Excel</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
)

const ApprovedTestCases: React.FC = () => {
  const [groups, setGroups] = useState<ApprovedRequestGroup[]>([])
  const [adoGroups, setAdoGroups] = useState<ApprovedRequestGroup[]>([])
  const [historyGroups, setHistoryGroups] = useState<ApprovedRequestGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [downloadingRequestId, setDownloadingRequestId] = useState<string | null>(null)
  const [viewingGroup, setViewingGroup] = useState<ApprovedRequestGroup | null>(null)
  const [tableSearch, setTableSearch] = useState('')
  const [pageSize, setPageSize] = useState(5)
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(false)

  usePageHeader({
    title: 'Approved Test Cases',
    subtitle: 'Browse manager-approved test case requests and export them for execution.'
  })

  const fetchApprovedData = async () => {
    setLoading(true)
    setError(null)
    try {
      const [currentResponse, adoResponse, historyResponse] = await Promise.all([
        api.get('/test-case-reviews/approved/details/current'),
        api.get('/test-case-reviews/approved/details/ado'),
        api.get('/test-case-reviews/approved/details/history')
      ])
      const toGroups = (items: any[]): ApprovedRequestGroup[] => items.map((item) => ({
        request_id: item.request_id,
        document_id: item.document_id ?? '',
        reviewed_by: item.reviewed_by ?? '',
        reviewed_datetime: item.reviewed_date_time ?? null,
        test_case_count: item.no_of_test_cases ?? 0,
        test_cases: []
      }))
      setGroups(toGroups(currentResponse.data?.items ?? []))
      setAdoGroups(toGroups(adoResponse.data?.items ?? []))
      setHistoryGroups(toGroups(historyResponse.data?.items ?? []))
      setCurrentPage(1)
    } catch (err) {
      console.error('Failed to load approved test cases', err)
      setError('Failed to load approved test cases.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchApprovedData()
    const refreshApprovedData = () => { fetchApprovedData() }
    window.addEventListener('test-case-review-updated', refreshApprovedData)
    return () => {
      window.removeEventListener('test-case-review-updated', refreshApprovedData)
    }
  }, [])

  const filteredGroups = useMemo(() => {
    const term = tableSearch.trim().toLowerCase()
    if (!term) return historyGroups
    return historyGroups.filter((group) =>
      [group.request_id, group.document_id, group.reviewed_by, String(group.test_case_count)]
        .some((value) => (value ?? '').toString().toLowerCase().includes(term))
    )
  }, [historyGroups, tableSearch])

  const totalPages = Math.max(1, Math.ceil(filteredGroups.length / pageSize))
  const safeCurrentPage = Math.min(currentPage, totalPages)
  const paginatedGroups = useMemo(() => {
    const start = (safeCurrentPage - 1) * pageSize
    return filteredGroups.slice(start, start + pageSize)
  }, [filteredGroups, safeCurrentPage, pageSize])

  const viewingColumns = useMemo(
    () => (viewingGroup ? collectDetailColumns(viewingGroup.test_cases) : []),
    [viewingGroup]
  )

  const handleViewGroup = async (group: ApprovedRequestGroup) => {
    setError(null)
    try {
      const response = await api.get(`/test-case-reviews/approved/request/${encodeURIComponent(group.request_id)}`)
      setViewingGroup({ ...group, test_cases: response.data?.items ?? [] })
    } catch (err: any) {
      console.error('Failed to load approved test cases for request', group.request_id, err)
      setError(err?.response?.data?.detail || `Failed to load test cases for request ${group.request_id}.`)
    }
  }

  const handleDownloadRequest = async (requestId: string, format: 'xlsx' | 'csv') => {
    if (!requestId || downloadingRequestId) return
    setDownloadingRequestId(requestId)
    setError(null)
    try {
      const response = await api.get(`/test-case-reviews/approved/request/${encodeURIComponent(requestId)}`)
      const records: ApprovedTestCaseItem[] = response.data?.items ?? []
      if (records.length === 0) {
        setError(`No approved test cases found for request ${requestId}.`)
        return
      }
      const columns = collectDetailColumns(records)
      const baseName = `approved-test-cases-${requestId}`
      if (format === 'csv') {
        exportRecordsAsCsv(records, columns, baseName)
      } else {
        await exportRecordsAsExcel(records, columns, baseName)
      }
    } catch (err: any) {
      console.error('Failed to download approved test cases for request', requestId, err)
      setError(err?.response?.data?.detail || `Failed to download test cases for request ${requestId}.`)
    } finally {
      setDownloadingRequestId(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-[20px] border border-slate-200 bg-white p-5 shadow-sm">
        {error && (
          <div className="mb-4 rounded-[10px] border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</div>
        )}

        {loading ? (
          <div className="text-sm text-slate-600">Loading approved test cases...</div>
        ) : (
          <div className="overflow-hidden rounded-[14px] border border-slate-200">
            <div className="border-b border-red-200 bg-white px-3 py-2"><h2 className="text-xs font-bold uppercase tracking-[0.14em] text-red-700">Recent / Current Records</h2></div>
            <div className="max-h-[60vh] overflow-auto">
              <table className="min-w-full border-collapse text-left text-xs text-slate-700">
                <thead className="sticky top-0 z-10 bg-white">
                  <tr>
                    <th className="border-b border-red-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-red-700">Seq. No</th>
                    <th className="border-b border-red-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-red-700">Document ID</th>
                    <th className="border-b border-red-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-red-700">Request ID</th>
                    <th className="border-b border-red-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-red-700">View Test Cases</th>
                    <th className="border-b border-red-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-red-700">Approved By</th>
                    <th className="border-b border-red-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-red-700">Approved Date</th>
                    <th className="border-b border-red-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-red-700">Download</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.length === 0 ? (
                    <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-500">No records available.</td></tr>
                  ) : groups.map((group, index) => (
                    <tr key={group.request_id} className="odd:bg-white even:bg-slate-50">
                      <td className="border-b border-slate-200 px-3 py-3 font-semibold text-slate-700">{index + 1}</td>
                      <td className="border-b border-slate-200 px-3 py-3 text-slate-700">{group.document_id || '—'}</td>
                      <td className="border-b border-slate-200 px-3 py-3 font-semibold text-slate-800">{group.request_id}</td>
                      <td className="border-b border-slate-200 px-3 py-3">
                        <button
                          type="button"
                          onClick={() => handleViewGroup(group)}
                          className="font-semibold text-red-600 underline decoration-red-200 underline-offset-2 hover:text-red-700"
                        >
                          View ({group.test_case_count})
                        </button>
                      </td>
                      <td className="border-b border-slate-200 px-3 py-3 text-slate-700">{group.reviewed_by || '—'}</td>
                      <td className="border-b border-slate-200 px-3 py-3 text-slate-700">
                        {group.reviewed_datetime ? new Date(group.reviewed_datetime).toLocaleString() : '—'}
                      </td>
                      <td className="border-b border-slate-200 px-3 py-3">
                        <button
                          type="button"
                          disabled={downloadingRequestId === group.request_id}
                          onClick={() => handleDownloadRequest(group.request_id, 'xlsx')}
                          className="font-semibold text-red-600 underline decoration-red-200 underline-offset-2 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Excel
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

          </div>
        )}

        <div className="mt-6 space-y-6">
          <ApprovedGroupsTable title="ADO Repository Records" groups={adoGroups} loading={loading} downloadingRequestId={downloadingRequestId} onView={handleViewGroup} onDownload={(requestId) => handleDownloadRequest(requestId, 'xlsx')} />
          <section className="overflow-hidden rounded-[14px] border border-slate-200">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-red-200 bg-white px-3 py-2">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-red-700"><span>All History Records: {filteredGroups.length}</span><button type="button" onClick={() => setIsHistoryExpanded((expanded) => !expanded)} aria-label={isHistoryExpanded ? 'Collapse history records' : 'Expand history records'} title={isHistoryExpanded ? 'Collapse history records' : 'Expand history records'} className="flex h-7 w-7 items-center justify-center rounded-[6px] border border-red-200 text-red-700 hover:bg-red-50">{isHistoryExpanded ? <HiOutlineChevronDown className="h-4 w-4" /> : <HiOutlineChevronRight className="h-4 w-4" />}</button></div>
              {isHistoryExpanded && <input type="text" value={tableSearch} onChange={(event) => { setTableSearch(event.target.value); setCurrentPage(1) }} placeholder="Search requests..." className="w-64 rounded-[8px] border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 outline-none focus:border-slate-400" />}
            </div>
            {isHistoryExpanded && <><ApprovedGroupsTable title="All History Records" groups={paginatedGroups} loading={loading} downloadingRequestId={downloadingRequestId} showHeader={false} onView={handleViewGroup} onDownload={(requestId) => handleDownloadRequest(requestId, 'xlsx')} />
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-3 py-2"><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setCurrentPage(1) }} className="rounded-[6px] border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"><option value={10}>10</option><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select><div className="flex items-center gap-2"><button type="button" disabled={safeCurrentPage <= 1} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} className="rounded-[6px] border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 disabled:opacity-40">Previous</button><span className="text-xs text-slate-600">Page {safeCurrentPage} of {totalPages}</span><button type="button" disabled={safeCurrentPage >= totalPages} onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))} className="rounded-[6px] border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 disabled:opacity-40">Next</button></div></div></>}
          </section>
        </div>
      </div>

      {viewingGroup && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
          onClick={(event) => {
            if (event.target === event.currentTarget) setViewingGroup(null)
          }}
        >
          <div className="flex max-h-[90vh] w-[95vw] max-w-[1500px] flex-col overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-[0_28px_70px_rgba(15,23,42,0.16)]">
            <div className="flex items-center justify-between border-b border-slate-200 bg-red-50 px-5 py-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="inline-flex items-center rounded-full bg-red-600 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-white">Approved</div>
                <div className="text-lg font-bold text-slate-900">
                  Request <span className="text-red-600">#{viewingGroup.request_id}</span>
                </div>
                <span className="text-sm font-semibold text-slate-700">{viewingGroup.test_cases.length} test cases</span>
                <span className="text-sm text-slate-500">Document: {viewingGroup.document_id || '—'}</span>
              </div>
              <button
                type="button"
                onClick={() => setViewingGroup(null)}
                aria-label="Close test case details"
                className="rounded-full p-2 text-slate-500 transition hover:bg-white hover:text-slate-900"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M6.28 5.22a.75.75 0 011.06 0L10 7.88l2.66-2.66a.75.75 0 111.06 1.06L11.06 8.94l2.66 2.66a.75.75 0 11-1.06 1.06L10 10l-2.66 2.66a.75.75 0 11-1.06-1.06L8.94 8.94 6.28 6.28a.75.75 0 010-1.06z" clipRule="evenodd" />
                </svg>
              </button>
            </div>

            <div className="flex-1 overflow-auto bg-slate-50 p-4">
              <div className="overflow-hidden rounded-[12px] border border-slate-200 bg-white">
                <div className="max-h-[70vh] overflow-auto">
                  <table className="min-w-full border-collapse text-left text-xs text-slate-700">
                    <thead className="sticky top-0 z-10 bg-slate-100">
                      <tr>
                        <th className="border-b border-slate-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-slate-700">#</th>
                        <th className="border-b border-slate-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-slate-700">Test Case ID</th>
                        {viewingColumns.map((column) => (
                          <th key={column} className="border-b border-slate-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-slate-700">{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {viewingGroup.test_cases.map((item, index) => (
                        <tr key={item.test_case_id} className="odd:bg-white even:bg-slate-50">
                          <td className="border-b border-slate-200 px-3 py-3 font-semibold text-slate-700">{index + 1}</td>
                          <td className="border-b border-slate-200 px-3 py-3 font-semibold text-slate-800">{item.test_case_id}</td>
                          {viewingColumns.map((column) => (
                            <td key={`${item.test_case_id}-${column}`} className="border-b border-slate-200 px-3 py-3 align-top">
                              <div className="whitespace-pre-wrap break-words leading-5 text-slate-700">
                                {String(item.test_case_details?.[column] ?? '—')}
                              </div>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ApprovedTestCases
