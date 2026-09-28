import React, { useEffect, useMemo, useState } from 'react'
import api from '../services/api'
import { getTimestampedFilename } from '../utils/DynamicFileName-DateTime'

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
  test_cases: ApprovedTestCaseItem[]
}

const PAGE_SIZE = 25

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

const ApprovedTestCases: React.FC = () => {
  const [groups, setGroups] = useState<ApprovedRequestGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [downloadingRequestId, setDownloadingRequestId] = useState<string | null>(null)
  const [viewingGroup, setViewingGroup] = useState<ApprovedRequestGroup | null>(null)
  const [tableSearch, setTableSearch] = useState('')

  const fetchApprovedData = async () => {
    setLoading(true)
    setError(null)
    try {
      const docsResponse = await api.get('/test-case-reviews/approved/documents')
      const ids: string[] = docsResponse.data?.items ?? []

      const responses = await Promise.all(
        ids.map((documentId) => api.get(`/test-case-reviews/approved/${encodeURIComponent(documentId)}`))
      )

      const byRequest = new Map<string, ApprovedRequestGroup>()
      responses.forEach((response) => {
        const records: ApprovedTestCaseItem[] = response.data?.items ?? []
        records.forEach((record) => {
          const existing = byRequest.get(record.request_id)
          if (existing) {
            existing.test_cases.push(record)
            if (!existing.reviewed_by && record.reviewed_by) existing.reviewed_by = record.reviewed_by
            if (!existing.reviewed_datetime && record.reviewed_datetime) existing.reviewed_datetime = record.reviewed_datetime
          } else {
            byRequest.set(record.request_id, {
              request_id: record.request_id,
              document_id: record.document_id ?? '',
              reviewed_by: record.reviewed_by ?? '',
              reviewed_datetime: record.reviewed_datetime ?? null,
              test_cases: [record]
            })
          }
        })
      })
      setGroups(Array.from(byRequest.values()))
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
  }, [])

  const filteredGroups = useMemo(() => {
    const term = tableSearch.trim().toLowerCase()
    if (!term) return groups
    return groups.filter((group) =>
      [group.request_id, group.document_id, group.reviewed_by, String(group.test_cases.length)]
        .some((value) => (value ?? '').toString().toLowerCase().includes(term))
    )
  }, [groups, tableSearch])

  const totalPages = Math.max(1, Math.ceil(filteredGroups.length / PAGE_SIZE))
  const safeCurrentPage = Math.min(currentPage, totalPages)
  const paginatedGroups = useMemo(() => {
    const start = (safeCurrentPage - 1) * PAGE_SIZE
    return filteredGroups.slice(start, start + PAGE_SIZE)
  }, [filteredGroups, safeCurrentPage])

  const viewingColumns = useMemo(
    () => (viewingGroup ? collectDetailColumns(viewingGroup.test_cases) : []),
    [viewingGroup]
  )

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
        <div className="mb-4 rounded-[16px] border border-red-200 bg-gradient-to-r from-red-600 to-red-700 p-4 text-white shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[20px] font-bold text-white">Approved Test Cases</div>
              <div className="mt-1 text-sm text-red-50">Browse manager-approved test case requests and export them for execution.</div>
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-[10px] border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</div>
        )}

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            {filteredGroups.length} approved request{filteredGroups.length === 1 ? '' : 's'}
          </div>
          <input
            type="text"
            value={tableSearch}
            onChange={(event) => { setTableSearch(event.target.value); setCurrentPage(1) }}
            placeholder="Search requests..."
            className="w-64 rounded-[8px] border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 outline-none focus:border-slate-400"
          />
        </div>

        {loading ? (
          <div className="text-sm text-slate-600">Loading approved test cases...</div>
        ) : groups.length === 0 ? (
          <div className="rounded-[14px] border border-dashed border-slate-200 bg-slate-50 p-8 text-sm text-slate-600">
            No approved test case requests found.
          </div>
        ) : (
          <div className="overflow-hidden rounded-[14px] border border-slate-200">
            <div className="max-h-[60vh] overflow-auto">
              <table className="min-w-full border-collapse text-left text-xs text-slate-700">
                <thead className="sticky top-0 z-10 bg-slate-100">
                  <tr>
                    <th className="border-b border-slate-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-slate-700">Seq. No</th>
                    <th className="border-b border-slate-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-slate-700">Document ID</th>
                    <th className="border-b border-slate-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-slate-700">Request ID</th>
                    <th className="border-b border-slate-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-slate-700">View Test Cases</th>
                    <th className="border-b border-slate-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-slate-700">Approved By</th>
                    <th className="border-b border-slate-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-slate-700">Approved Date</th>
                    <th className="border-b border-slate-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-slate-700">Download</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedGroups.map((group, index) => (
                    <tr key={group.request_id} className="odd:bg-white even:bg-slate-50">
                      <td className="border-b border-slate-200 px-3 py-3 font-semibold text-slate-700">{(safeCurrentPage - 1) * PAGE_SIZE + index + 1}</td>
                      <td className="border-b border-slate-200 px-3 py-3 text-slate-700">{group.document_id || '—'}</td>
                      <td className="border-b border-slate-200 px-3 py-3 font-semibold text-slate-800">{group.request_id}</td>
                      <td className="border-b border-slate-200 px-3 py-3">
                        <button
                          type="button"
                          onClick={() => setViewingGroup(group)}
                          className="font-semibold text-red-600 underline decoration-red-200 underline-offset-2 hover:text-red-700"
                        >
                          View ({group.test_cases.length})
                        </button>
                      </td>
                      <td className="border-b border-slate-200 px-3 py-3 text-slate-700">{group.reviewed_by || '—'}</td>
                      <td className="border-b border-slate-200 px-3 py-3 text-slate-700">
                        {group.reviewed_datetime ? new Date(group.reviewed_datetime).toLocaleString() : '—'}
                      </td>
                      <td className="border-b border-slate-200 px-3 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={downloadingRequestId === group.request_id}
                            onClick={() => handleDownloadRequest(group.request_id, 'xlsx')}
                            className="font-semibold text-red-600 underline decoration-red-200 underline-offset-2 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            Excel
                          </button>
                          <span className="text-slate-300">|</span>
                          <button
                            type="button"
                            disabled={downloadingRequestId === group.request_id}
                            onClick={() => handleDownloadRequest(group.request_id, 'csv')}
                            className="font-semibold text-red-600 underline decoration-red-200 underline-offset-2 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            CSV
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-3 py-2">
              <div className="text-xs text-slate-600">
                {groups.length} approved request{groups.length === 1 ? '' : 's'}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={safeCurrentPage <= 1}
                  onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                  className="rounded-[6px] border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="text-xs text-slate-600">Page {safeCurrentPage} of {totalPages}</span>
                <button
                  type="button"
                  disabled={safeCurrentPage >= totalPages}
                  onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                  className="rounded-[6px] border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        )}
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
