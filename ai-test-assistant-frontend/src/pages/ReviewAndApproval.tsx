import React, { useEffect, useMemo, useState } from 'react'
import MarkdownViewer from '../components/MarkdownViewer'
import api from '../services/api'
import { useAuth } from '../hooks/useAuth'

interface ReviewRequestItem {
  request_id: string
  request_by: string
  request_date_time?: string | null
  brd_document?: any
  no_of_test_cases: number
  approved_count: number
  rejected_count: number
  overall_status: string
  review_notes?: string | null
  reviewed_by?: string | null
  reviewed_date_time?: string | null
}

interface ReviewTestCaseItem {
  test_case_id: string
  request_id: string
  test_case_details: Record<string, string>
  status: string
  rejection_reason?: string | null
  reviewed_by?: string | null
  reviewed_datetime?: string | null
  generated_by?: string | null
}

type RowDecision = 'pending' | 'approved' | 'rejected'

const getStatusClasses = (status?: string) => {
  const normalized = (status ?? '').toLowerCase()
  if (normalized === 'pending' || normalized === 'pending_review') {
    return 'bg-orange-100 text-orange-700'
  }
  if (normalized === 'approve' || normalized === 'approved' || normalized === 'partially_approved') {
    return 'bg-green-100 text-green-700'
  }
  if (normalized === 'reject' || normalized === 'rejected') {
    return 'bg-red-100 text-red-700'
  }
  return 'bg-slate-100 text-slate-700'
}

const buildDocumentText = (value: any): string => {
  const parts: string[] = []

  const collect = (entry: any) => {
    if (!entry || typeof entry === 'undefined') return

    if (typeof entry === 'string') {
      const normalized = entry.trim()
      if (normalized) parts.push(normalized)
      return
    }

    if (Array.isArray(entry)) {
      entry.forEach(collect)
      return
    }

    if (typeof entry === 'object') {
      if (typeof entry.content === 'string') {
        collect(entry.content)
        return
      }
      if (typeof entry.text === 'string') {
        collect(entry.text)
        return
      }
      if (typeof entry.body === 'string') {
        collect(entry.body)
        return
      }

      Object.values(entry).forEach(collect)
    }
  }

  collect(value)

  const uniqueParts = Array.from(new Set(parts.map((part) => part.trim()).filter(Boolean)))
  return uniqueParts.length > 0 ? uniqueParts.join('\n\n---\n\n') : 'No content available.'
}

const ReviewAndApproval: React.FC = () => {
  const { user } = useAuth()
  const [requests, setRequests] = useState<ReviewRequestItem[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null)
  const [selectedRequest, setSelectedRequest] = useState<ReviewRequestItem | null>(null)
  const [selectedTestCases, setSelectedTestCases] = useState<ReviewTestCaseItem[]>([])
  const [rowDecisions, setRowDecisions] = useState<Record<string, RowDecision>>({})
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({})
  const [rejectReasonErrors, setRejectReasonErrors] = useState<Record<string, boolean>>({})
  const [rejectionError, setRejectionError] = useState<string | null>(null)
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([])
  const [isSelectAllChecked, setIsSelectAllChecked] = useState(false)
  const [reviewNote, setReviewNote] = useState('')
  const [documentViewer, setDocumentViewer] = useState<{ name: string; content: string } | null>(null)
  const [isReviewModalOpen, setIsReviewModalOpen] = useState(false)
  const [tableSearch, setTableSearch] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const fetchRequests = async () => {
    setLoading(true)
    try {
      const response = await api.get('/test-case-reviews/details')
      const items = response.data?.items ?? []
      setRequests(items)
      if (items.length > 0 && !selectedRequestId) {
        setSelectedRequestId(items[0].request_id)
      }
    } catch (error) {
      console.error('Failed to load review requests', error)
    } finally {
      setLoading(false)
    }
  }

  const fetchRequestDetail = async (requestId: string) => {
    try {
      const response = await api.get(`/test-case-reviews/detail/${requestId}`)
      const detail = response.data?.data ?? null
      const testCases = response.data?.test_cases ?? []
      setSelectedRequest(detail)
      setSelectedTestCases(testCases)
      setReviewNote('')
      setRejectReasons({})
      setRejectReasonErrors({})
      setRejectionError(null)
      setSelectedRowIds([])
      setIsSelectAllChecked(false)

      const nextDecisions: Record<string, RowDecision> = {}
      testCases.forEach((item: ReviewTestCaseItem) => {
        const status = String(item.status || 'PENDING').toUpperCase()
        nextDecisions[item.test_case_id] =
          status === 'APPROVED' ? 'approved' : status === 'REJECTED' ? 'rejected' : 'pending'
      })
      setRowDecisions(nextDecisions)
    } catch (error) {
      console.error('Failed to load review request detail', error)
    }
  }

  useEffect(() => {
    fetchRequests()
  }, [])

  useEffect(() => {
    if (selectedRequestId) {
      fetchRequestDetail(selectedRequestId)
    }
  }, [selectedRequestId])

  const requestColumns = useMemo(() => {
    const keys = new Set<string>()
    selectedTestCases.forEach((item) => {
      Object.keys(item.test_case_details ?? {}).forEach((key) => keys.add(key))
    })

    return Array.from(keys).filter((key) => {
      const normalized = String(key).toLowerCase()
      return normalized !== 'id' && normalized !== 'test_case_id' && normalized !== 'sourcerowid' && normalized !== 'source_row_id' && normalized !== 'sourcerowid_'
    })
  }, [selectedTestCases])

  const pendingTestCaseIds = useMemo(
    () => selectedTestCases.filter((item) => (rowDecisions[item.test_case_id] ?? 'pending') === 'pending').map((item) => item.test_case_id),
    [selectedTestCases, rowDecisions]
  )

  const handleRowDecision = async (event: React.MouseEvent<HTMLButtonElement>, decision: 'APPROVE' | 'REJECT', testCaseId: string) => {
    event.preventDefault()
    event.stopPropagation()
    if (!selectedRequestId) return

    const row = selectedTestCases.find((item) => item.test_case_id === testCaseId)
    if (!row) return

    const rejectReason = (rejectReasons[testCaseId] ?? '').trim()
    if (decision === 'REJECT' && !rejectReason) {
      setRejectReasonErrors((current) => ({ ...current, [testCaseId]: true }))
      setRejectionError('Reject Reason is required before rejecting a test case.')
      return
    }

    try {
      await api.post(`/test-case-reviews/detail/${selectedRequestId}/decision`, {
        decision,
        review_notes: reviewNote || undefined,
        rows: [{
          test_case_id: testCaseId,
          rejection_reason: decision === 'REJECT' ? rejectReason : undefined
        }]
      })

      setRejectReasonErrors((current) => {
        const { [testCaseId]: _removed, ...rest } = current
        return rest
      })
      setRejectionError(null)

      const nextDecision: RowDecision = decision === 'APPROVE' ? 'approved' : 'rejected'
      const nextRowDecisions = {
        ...rowDecisions,
        [testCaseId]: nextDecision
      }
      setRowDecisions(nextRowDecisions)
      setSelectedRowIds((current) => current.filter((id) => id !== testCaseId))
      setIsSelectAllChecked(false)

      const nextSelectedTestCases = selectedTestCases.map((item) =>
        item.test_case_id === testCaseId
          ? {
              ...item,
              status: nextDecision === 'approved' ? 'APPROVED' : 'REJECTED',
              rejection_reason: nextDecision === 'rejected' ? rejectReason : item.rejection_reason
            }
          : item
      )
      setSelectedTestCases(nextSelectedTestCases)

      const approvedCount = nextSelectedTestCases.filter((item) => (nextRowDecisions[item.test_case_id] ?? 'pending') === 'approved').length
      const rejectedCount = nextSelectedTestCases.filter((item) => (nextRowDecisions[item.test_case_id] ?? 'pending') === 'rejected').length
      const totalCount = nextSelectedTestCases.length
      const nextOverallStatus =
        approvedCount === totalCount ? 'APPROVED'
          : rejectedCount === totalCount ? 'REJECTED'
            : approvedCount > 0 || rejectedCount > 0 ? 'PARTIALLY_APPROVED'
              : 'PENDING_REVIEW'

      setSelectedRequest((current) => current ? {
        ...current,
        approved_count: approvedCount,
        rejected_count: rejectedCount,
        overall_status: nextOverallStatus
      } : current)

      await fetchRequests()
    } catch (error) {
      console.error('Failed to update row decision', error)
    }
  }

  const handleBulkDecision = async (event: React.MouseEvent<HTMLButtonElement>, decision: 'APPROVE' | 'REJECT') => {
    event.preventDefault()
    event.stopPropagation()
    if (!selectedRequestId || !isSelectAllChecked || selectedRowIds.length === 0) return

    if (decision === 'REJECT') {
      const missingReasonIds = selectedRowIds.filter((testCaseId) => !(rejectReasons[testCaseId] ?? '').trim())
      if (missingReasonIds.length > 0) {
        setRejectReasonErrors((current) => {
          const next = { ...current }
          missingReasonIds.forEach((testCaseId) => { next[testCaseId] = true })
          return next
        })
        setRejectionError('Reject Reason is required for every selected test case before bulk rejection.')
        return
      }
    }

    try {
      await api.post(`/test-case-reviews/detail/${selectedRequestId}/decision`, {
        decision,
        review_notes: reviewNote || undefined,
        rows: selectedRowIds.map((testCaseId) => ({
          test_case_id: testCaseId,
          rejection_reason: decision === 'REJECT' ? rejectReasons[testCaseId].trim() : undefined
        }))
      })

      setRejectionError(null)
      const nextMap: Record<string, RowDecision> = { ...rowDecisions }
      selectedRowIds.forEach((testCaseId) => {
        nextMap[testCaseId] = decision === 'APPROVE' ? 'approved' : 'rejected'
      })
      setRowDecisions(nextMap)

      const nextSelectedTestCases = selectedTestCases.map((item) =>
        selectedRowIds.includes(item.test_case_id)
          ? {
              ...item,
              status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
              rejection_reason: decision === 'REJECT' ? rejectReasons[item.test_case_id].trim() : item.rejection_reason
            }
          : item
      )
      setSelectedTestCases(nextSelectedTestCases)
      setSelectedRowIds([])
      setIsSelectAllChecked(false)

      const approvedCount = nextSelectedTestCases.filter((item) => (nextMap[item.test_case_id] ?? 'pending') === 'approved').length
      const rejectedCount = nextSelectedTestCases.filter((item) => (nextMap[item.test_case_id] ?? 'pending') === 'rejected').length
      const totalCount = nextSelectedTestCases.length
      const nextOverallStatus =
        approvedCount === totalCount ? 'APPROVED'
          : rejectedCount === totalCount ? 'REJECTED'
            : approvedCount > 0 || rejectedCount > 0 ? 'PARTIALLY_APPROVED'
              : 'PENDING_REVIEW'

      setSelectedRequest((current) => current ? {
        ...current,
        approved_count: approvedCount,
        rejected_count: rejectedCount,
        overall_status: nextOverallStatus
      } : current)

      await fetchRequests()
    } catch (error) {
      console.error('Failed to update bulk decision', error)
    }
  }

  const toggleSelectAll = () => {
    const nextState = !isSelectAllChecked
    setIsSelectAllChecked(nextState)
    setSelectedRowIds(nextState ? pendingTestCaseIds : [])
  }

  const toggleSelectRow = (testCaseId: string) => {
    const existing = rowDecisions[testCaseId] ?? 'pending'
    if (existing !== 'pending') return

    setIsSelectAllChecked(false)
    setSelectedRowIds((current) =>
      current.includes(testCaseId) ? current.filter((item) => item !== testCaseId) : [...current, testCaseId]
    )
  }

  const handleRejectReasonChange = (testCaseId: string, value: string) => {
    setRejectReasons((current) => ({ ...current, [testCaseId]: value }))
    if (value.trim()) {
      setRejectReasonErrors((current) => {
        const { [testCaseId]: _removed, ...rest } = current
        return rest
      })
      setRejectionError(null)
    }
  }

  const actionButtonClasses = 'rounded-[10px] border px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40'
  const canSubmitToKnowledgeBase =
    !!selectedRequest &&
    selectedTestCases.length > 0 &&
    selectedRequest.approved_count === selectedTestCases.length &&
    String(selectedRequest.overall_status || '').toUpperCase() === 'APPROVED'
  const bulkActionsEnabled = isSelectAllChecked && pendingTestCaseIds.length > 0

  const filteredRequests = useMemo(() => {
    const term = tableSearch.trim().toLowerCase()
    if (!term) return requests
    return requests.filter((request) => {
      const searchable = [
        request.request_id,
        request.request_by,
        request.overall_status,
        request.reviewed_by,
        request.review_notes,
        String(request.no_of_test_cases),
        String(request.approved_count),
        String(request.rejected_count),
        request.request_date_time ? new Date(request.request_date_time).toLocaleString() : '',
        buildDocumentText(request.brd_document)
      ]
      return searchable.some((value) => (value ?? '').toString().toLowerCase().includes(term))
    })
  }, [requests, tableSearch])

  const totalPages = Math.max(1, Math.ceil(filteredRequests.length / pageSize))
  const safeCurrentPage = Math.min(currentPage, totalPages)
  const paginatedRequests = useMemo(() => {
    const start = (safeCurrentPage - 1) * pageSize
    return filteredRequests.slice(start, start + pageSize)
  }, [filteredRequests, safeCurrentPage, pageSize])

  const handleTableSearchChange = (value: string) => {
    setTableSearch(value)
    setCurrentPage(1)
  }

  return (
    <div className="space-y-6">
      <div className="rounded-[20px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-4 rounded-[16px] border border-red-200 bg-gradient-to-r from-red-600 to-red-700 p-4 text-white shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[20px] font-bold text-white">Review & Approval</div>
              <div className="mt-1 text-sm text-red-50">Review submitted test case requests and approve or reject them before knowledge base sync.</div>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="text-sm text-slate-600">Loading review queue...</div>
        ) : requests.length === 0 ? (
          <div className="rounded-[14px] border border-dashed border-slate-200 bg-slate-50 p-8 text-sm text-slate-600">
            No review requests pending.
          </div>
        ) : (
          <div className="space-y-6">
            <div className="overflow-hidden rounded-[14px] border border-slate-200">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-600">
                  {filteredRequests.length} request{filteredRequests.length === 1 ? '' : 's'}
                </div>
                <input
                  type="text"
                  value={tableSearch}
                  onChange={(event) => handleTableSearchChange(event.target.value)}
                  placeholder="Search all fields..."
                  className="w-64 rounded-[8px] border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 outline-none focus:border-slate-400"
                />
              </div>
              <div className="max-h-[640px] overflow-auto">
                <table className="min-w-full border-collapse text-left text-xs text-slate-700">
                  <thead className="sticky top-0 bg-slate-100">
                    <tr>
                      <th className="border-b border-slate-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-slate-700">S. No</th>
                      <th className="border-b border-slate-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-slate-700">Request ID</th>
                      <th className="border-b border-slate-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-slate-700">BRD Document</th>
                      <th className="border-b border-slate-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-slate-700">TestCase</th>
                      <th className="border-b border-slate-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-slate-700">Approved</th>
                      <th className="border-b border-slate-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-slate-700">Rejected</th>
                      <th className="border-b border-slate-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-slate-700">Overall Status</th>
                      <th className="border-b border-slate-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-slate-700">Requested By</th>
                      <th className="border-b border-slate-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-slate-700">Requested Date &amp; Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedRequests.map((request, index) => (
                      <tr key={request.request_id} className="odd:bg-white even:bg-slate-50">
                        <td className="border-b border-slate-200 px-3 py-3 font-semibold text-slate-700">{(safeCurrentPage - 1) * pageSize + index + 1}</td>
                        <td className="border-b border-slate-200 px-3 py-3 font-semibold text-slate-800">{request.request_id}</td>
                        <td className="border-b border-slate-200 px-3 py-3">
                          {request.brd_document ? (
                            <button
                              type="button"
                              onClick={() => setDocumentViewer({ name: request.request_id, content: buildDocumentText(request.brd_document) })}
                              className="inline-flex items-center gap-2 rounded-[8px] border border-slate-200 bg-slate-50 px-2 py-1.5 text-slate-700 hover:bg-slate-100"
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M7 3h7l5 5v13a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2zm7 1v5h5" />
                              </svg>
                              View
                            </button>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td className="border-b border-slate-200 px-3 py-3">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedRequestId(request.request_id)
                              setIsReviewModalOpen(true)
                            }}
                            className="font-semibold text-red-600 underline decoration-red-200 underline-offset-2 hover:text-red-700"
                          >
                            Open Review ({request.no_of_test_cases})
                          </button>
                        </td>
                        <td className="border-b border-slate-200 px-3 py-3 text-slate-700">{request.approved_count}</td>
                        <td className="border-b border-slate-200 px-3 py-3 text-slate-700">{request.rejected_count}</td>
                        <td className="border-b border-slate-200 px-3 py-3">
                          <span className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${getStatusClasses(request.overall_status)}`}>
                            {request.overall_status || 'PENDING_REVIEW'}
                          </span>
                        </td>
                        <td className="border-b border-slate-200 px-3 py-3 text-slate-700">{request.request_by}</td>
                        <td className="border-b border-slate-200 px-3 py-3 text-slate-700">
                          {request.request_date_time ? new Date(request.request_date_time).toLocaleString() : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-slate-600">
                  <span>Rows per page:</span>
                  <select
                    value={pageSize}
                    onChange={(event) => { setPageSize(Number(event.target.value)); setCurrentPage(1) }}
                    className="rounded-[6px] border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 outline-none focus:border-slate-400"
                  >
                    {[10, 25, 50, 100].map((size) => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
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

            {isReviewModalOpen && selectedRequest && (
              <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm" onClick={(event) => { if (event.target === event.currentTarget) { setIsReviewModalOpen(false) } }}>
                <div className="flex max-h-[95vh] w-[95vw] max-w-[1800px] flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-[0_28px_70px_rgba(15,23,42,0.18)]">
                  <div className="flex items-center justify-between border-b border-slate-200 bg-red-50 px-5 py-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="inline-flex items-center rounded-full bg-red-600 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-white">Review Request</div>
                      <div className="text-xl font-bold text-slate-900">Request <span className="text-red-600">#{selectedRequest.request_id}</span></div>
                      <span className="text-sm font-semibold text-slate-700">{selectedTestCases.length} test cases</span>
                      <span className={`inline-flex rounded-full px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${getStatusClasses(selectedRequest.overall_status)}`}>
                        {selectedRequest.overall_status || 'PENDING_REVIEW'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      {selectedRequest.brd_document && (
                        <button
                          type="button"
                          onClick={() => setDocumentViewer({ name: selectedRequest.request_id, content: buildDocumentText(selectedRequest.brd_document) })}
                          className="inline-flex items-center gap-2 rounded-[10px] bg-red-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-700"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M7 3h7l5 5v13a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2zm7 1v5h5" />
                          </svg>
                          BRD Reference
                        </button>
                      )}
                      <button type="button" onClick={() => setIsReviewModalOpen(false)} className="rounded-full p-2 text-slate-500 transition hover:bg-white hover:text-slate-900">Close</button>
                    </div>
                  </div>

                  <div className="flex-1 overflow-hidden bg-slate-50 p-4">
                    <div className="mb-4 rounded-[12px] border border-slate-200 bg-white p-3">
                      <div className="overflow-hidden rounded-[10px] border border-slate-200">
                        <div className="max-h-[53vh] overflow-y-auto">
                          <table className="w-full table-fixed border-collapse text-left text-xs text-slate-700">
                            <thead className="sticky top-0 z-10 bg-slate-100">
                              <tr>
                                <th className="w-[56px] min-w-[56px] border-b border-slate-200 px-1 py-2 font-semibold uppercase tracking-[0.12em] text-slate-700">
                                  <div className="flex items-center justify-center gap-0.5 whitespace-nowrap">
                                    <input
                                      type="checkbox"
                                      checked={isSelectAllChecked}
                                      onChange={toggleSelectAll}
                                      disabled={pendingTestCaseIds.length === 0}
                                      className="h-4 w-4 shrink-0 rounded border-slate-300 text-red-600 focus:ring-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                                    />
                                    <span className="leading-none">Select</span>
                                  </div>
                                </th>
                                <th className="w-10 min-w-[40px] border-b border-slate-200 px-1 py-2 font-semibold uppercase tracking-[0.12em] text-slate-700">#</th>
                                {requestColumns.map((column) => (
                                  <th key={column} className="border-b border-slate-200 px-3 py-2 font-semibold uppercase tracking-[0.12em] text-slate-700">
                                    {column}
                                  </th>
                                ))}
                                <th className="w-48 border-b border-slate-200 px-3 py-2 font-semibold uppercase tracking-[0.12em] text-slate-700">Reject Reason</th>
                                <th className="w-32 border-b border-slate-200 px-3 py-2 font-semibold uppercase tracking-[0.12em] text-slate-700">Decision</th>
                              </tr>
                            </thead>
                            <tbody>
                              {selectedTestCases.map((item, index) => {
                                const rowDecision = rowDecisions[item.test_case_id] ?? 'pending'
                                const isPending = rowDecision === 'pending'

                                return (
                                  <tr key={item.test_case_id} className="align-top odd:bg-white even:bg-slate-50">
                                    <td className="w-[56px] min-w-[56px] border-b border-slate-200 px-1 py-2 align-middle">
                                      <div className="flex items-center justify-center">
                                        <input
                                          type="checkbox"
                                          checked={selectedRowIds.includes(item.test_case_id)}
                                          disabled={!isPending}
                                          onChange={() => toggleSelectRow(item.test_case_id)}
                                          className="h-4 w-4 rounded border-slate-300 text-red-600 focus:ring-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                                        />
                                      </div>
                                    </td>
                                    <td className="w-10 min-w-[40px] border-b border-slate-200 px-1 py-2 font-semibold text-slate-600">{index + 1}</td>
                                    {requestColumns.map((column) => (
                                      <td key={`${item.test_case_id}-${column}`} className="border-b border-slate-200 px-3 py-2 align-top">
                                        <div className="whitespace-pre-wrap break-words leading-5 text-slate-700">
                                          {String(item.test_case_details?.[column] ?? '—')}
                                        </div>
                                      </td>
                                    ))}
                                    <td className="border-b border-slate-200 px-3 py-2 align-middle">
                                      {isPending ? (
                                        <div>
                                          <input
                                            type="text"
                                            value={rejectReasons[item.test_case_id] ?? ''}
                                            onChange={(event) => handleRejectReasonChange(item.test_case_id, event.target.value)}
                                            placeholder="Required to reject"
                                            className={`w-full rounded-[8px] border px-2 py-1.5 text-[11px] text-slate-700 outline-none focus:border-slate-400 ${rejectReasonErrors[item.test_case_id] ? 'border-red-400 bg-red-50' : 'border-slate-200 bg-slate-50'}`}
                                          />
                                          {rejectReasonErrors[item.test_case_id] && (
                                            <div className="mt-1 text-[10px] font-semibold text-red-600">Reject Reason is required.</div>
                                          )}
                                        </div>
                                      ) : (
                                        <span className="text-slate-500">{item.rejection_reason || '—'}</span>
                                      )}
                                    </td>
                                    <td className="border-b border-slate-200 px-3 py-2 align-middle">
                                      {isPending ? (
                                        <div className="flex flex-wrap gap-2">
                                          <button type="button" onClick={(event) => handleRowDecision(event, 'REJECT', item.test_case_id)} className="rounded-[8px] border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] font-semibold text-red-700 hover:bg-red-100">Reject</button>
                                          <button type="button" onClick={(event) => handleRowDecision(event, 'APPROVE', item.test_case_id)} className="rounded-[8px] bg-red-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-red-700">Approve</button>
                                        </div>
                                      ) : (
                                        <span className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${getStatusClasses(rowDecision === 'approved' ? 'Approved' : 'Rejected')}`}>
                                          {rowDecision === 'approved' ? 'Approved' : 'Rejected'}
                                        </span>
                                      )}
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 flex items-center justify-between gap-3 rounded-[12px] border border-slate-200 bg-white px-3 py-3">
                      <div className="flex-1">
                        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Review Notes</label>
                        <textarea
                          value={reviewNote}
                          onChange={(event) => setReviewNote(event.target.value)}
                          rows={2}
                          className="w-full resize-none rounded-[10px] border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 outline-none focus:border-slate-400"
                          placeholder="Add any approval or rejection notes..."
                        />
                        {rejectionError && (
                          <div className="mt-1 text-xs font-semibold text-red-600">{rejectionError}</div>
                        )}
                      </div>

                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          disabled={!bulkActionsEnabled}
                          onClick={(event) => handleBulkDecision(event, 'REJECT')}
                          className={`${actionButtonClasses} border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:hover:bg-red-50`}
                        >
                          Reject Selected
                        </button>
                        <button
                          type="button"
                          disabled={!bulkActionsEnabled}
                          onClick={(event) => handleBulkDecision(event, 'APPROVE')}
                          className={`${actionButtonClasses} border-red-600 bg-red-600 text-white hover:bg-red-700 disabled:hover:bg-red-600`}
                        >
                          Approve Selected
                        </button>
                        <button
                          type="button"
                          disabled={!canSubmitToKnowledgeBase}
                          onClick={() => console.log('[ReviewAndApproval] Transfer to KB:', selectedRequest.request_id)}
                          className={`rounded-[10px] px-4 py-2.5 text-sm font-semibold ${canSubmitToKnowledgeBase ? 'bg-red-600 text-white hover:bg-red-700' : 'cursor-not-allowed bg-slate-200 text-slate-500'}`}
                        >
                          Transfer to KB
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {documentViewer && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
          onClick={(event) => {
            if (event.target === event.currentTarget) setDocumentViewer(null)
          }}
        >
          <div className="flex h-[80vh] w-full max-w-5xl flex-col overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-[0_28px_70px_rgba(15,23,42,0.16)]">
            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-5 py-3">
              <div className="text-[14px] font-bold text-slate-900">{documentViewer.name}</div>
              <button type="button" onClick={() => setDocumentViewer(null)} className="rounded-full p-2 text-slate-500 transition hover:bg-white hover:text-slate-900">Close</button>
            </div>
            <div className="flex-1 overflow-auto bg-slate-50 p-5">
              <div className="rounded-[16px] border border-slate-200 bg-white p-4 text-[13px] leading-7 text-slate-800">
                <MarkdownViewer content={documentViewer.content || 'No content available.'} className="prose prose-sm max-w-none" />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ReviewAndApproval
