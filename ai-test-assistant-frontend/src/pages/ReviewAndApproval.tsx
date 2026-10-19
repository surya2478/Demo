import React, { useEffect, useMemo, useRef, useState } from 'react'
import { HiOutlineChevronDown, HiOutlineChevronRight } from 'react-icons/hi'
import MarkdownViewer from '../components/MarkdownViewer'
import api from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { usePageHeader } from '../components/layout/PageHeaderContext'

interface ReviewRequestItem {
  request_id: string
  document_id?: string | null
  source?: string | null
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

const ADO_PAGE_SIZE = 5

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

interface ReviewRecordsTableProps {
  title: string
  records: ReviewRequestItem[]
  loading: boolean
  onOpenReview: (requestId: string) => void
  showCount?: boolean
  showHeader?: boolean
  startIndex?: number
}

const ReviewRecordsTable: React.FC<ReviewRecordsTableProps> = ({ title, records, loading, onOpenReview, showCount = false, showHeader = true, startIndex = 0 }) => (
  <section className="overflow-hidden rounded-[14px] border border-slate-200">
    {showHeader && <div className="flex items-center justify-between gap-3 border-b border-red-800 bg-red-700 px-3 py-2">
      <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-white">{title}</h2>
      {showCount && <span className="text-[11px] font-semibold text-slate-500">{records.length} record{records.length === 1 ? '' : 's'}</span>}
    </div>}
    <div className="max-h-[420px] overflow-auto">
      <table className="min-w-full border-collapse text-left text-xs text-slate-700">
        <thead className="sticky top-0 bg-white">
          <tr>
            {['S. No', 'Document ID', 'Request ID', 'Test Cases', 'Approved', 'Rejected', 'Status', 'Requested By', 'Requested At', 'Review'].map((column) => (
              <th key={column} className="border-b border-red-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-red-700">{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={10} className="px-3 py-6 text-center text-slate-500">Loading records...</td></tr>
          ) : records.length === 0 ? (
            <tr><td colSpan={10} className="px-3 py-6 text-center text-slate-500">No records available.</td></tr>
          ) : records.map((record, index) => (
            <tr key={record.request_id} className="odd:bg-white even:bg-slate-50">
              <td className="border-b border-slate-200 px-3 py-3 font-semibold">{startIndex + index + 1}</td>
              <td className="border-b border-slate-200 px-3 py-3">{record.document_id || '—'}</td>
              <td className="border-b border-slate-200 px-3 py-3 font-semibold text-slate-800">{record.request_id}</td>
              <td className="border-b border-slate-200 px-3 py-3">{record.no_of_test_cases}</td>
              <td className="border-b border-slate-200 px-3 py-3">{record.approved_count}</td>
              <td className="border-b border-slate-200 px-3 py-3">{record.rejected_count}</td>
              <td className="border-b border-slate-200 px-3 py-3"><span className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${getStatusClasses(record.overall_status)}`}>{record.overall_status || 'PENDING_REVIEW'}</span></td>
              <td className="border-b border-slate-200 px-3 py-3">{record.request_by}</td>
              <td className="border-b border-slate-200 px-3 py-3">{record.request_date_time ? new Date(record.request_date_time).toLocaleString() : '—'}</td>
              <td className="border-b border-slate-200 px-3 py-3"><button type="button" onClick={() => onOpenReview(record.request_id)} className="font-semibold text-red-600 underline decoration-red-200 underline-offset-2 hover:text-red-700">Open</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
)

const ReviewAndApproval: React.FC = () => {
  const { user } = useAuth()
  const [requests, setRequests] = useState<ReviewRequestItem[]>([])
  const [adoRequests, setAdoRequests] = useState<ReviewRequestItem[]>([])
  const [historyRequests, setHistoryRequests] = useState<ReviewRequestItem[]>([])
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
  const [pageSize, setPageSize] = useState(5)
  const [adoCurrentPage, setAdoCurrentPage] = useState(1)
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(false)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [successMessageDetail, setSuccessMessageDetail] = useState<string | null>(null)
  const [isSuccessMessageVisible, setIsSuccessMessageVisible] = useState(false)
  const [decisionInProgress, setDecisionInProgress] = useState<string | null>(null)
  const successMessageTimeouts = useRef<number[]>([])

  usePageHeader({
    title: 'Review & Approval',
    subtitle: 'Review submitted test case requests and approve or reject them before knowledge base sync.'
  })

  const fetchRequests = async (showLoading = true) => {
    if (showLoading) setLoading(true)
    try {
      const [currentResponse, adoResponse, historyResponse] = await Promise.all([
        api.get('/test-case-reviews/details/current'),
        api.get('/test-case-reviews/details/ado'),
        api.get('/test-case-reviews/details/history')
      ])
      const currentItems = currentResponse.data?.items ?? []
      setRequests(currentItems)
      const adoItems = adoResponse.data?.items ?? []
      setAdoRequests(adoItems)
      setHistoryRequests(historyResponse.data?.items ?? [])
      setAdoCurrentPage((page) => Math.min(page, Math.max(1, Math.ceil(adoItems.length / ADO_PAGE_SIZE))))
      if (currentItems.length > 0 && !selectedRequestId) {
        setSelectedRequestId(currentItems[0].request_id)
      }
    } catch (error) {
      console.error('Failed to load review requests', error)
    } finally {
      if (showLoading) setLoading(false)
    }
  }

  const fetchAdoRequests = async () => {
    try {
      const response = await api.get('/test-case-reviews/details/ado')
      const items = response.data?.items ?? []
      setAdoRequests(items)
      setAdoCurrentPage((page) => Math.min(page, Math.max(1, Math.ceil(items.length / ADO_PAGE_SIZE))))
    } catch (error) {
      console.error('Failed to refresh ADO review requests', error)
    }
  }

  const showSuccessMessage = (message: string, detail?: string) => {
    successMessageTimeouts.current.forEach((timeout) => window.clearTimeout(timeout))
    setSuccessMessage(message)
    setSuccessMessageDetail(detail ?? null)
    setIsSuccessMessageVisible(true)
    successMessageTimeouts.current = [
      window.setTimeout(() => setIsSuccessMessageVisible(false), 1700),
      window.setTimeout(() => { setSuccessMessage(null); setSuccessMessageDetail(null) }, 2000)
    ]
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
    const refreshRequests = () => { fetchAdoRequests() }
    window.addEventListener('test-case-review-updated', refreshRequests)
    const adoRefreshInterval = window.setInterval(fetchAdoRequests, 5000)
    return () => {
      window.removeEventListener('test-case-review-updated', refreshRequests)
      window.clearInterval(adoRefreshInterval)
    }
  }, [])

  useEffect(() => () => {
    successMessageTimeouts.current.forEach((timeout) => window.clearTimeout(timeout))
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
      setDecisionInProgress(testCaseId)
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

      await fetchRequests(false)
      showSuccessMessage(`1 TC ${decision === 'APPROVE' ? 'Approved' : 'Rejected'} successfully`)
      window.dispatchEvent(new Event('test-case-review-updated'))
    } catch (error) {
      console.error('Failed to update row decision', error)
    } finally {
      setDecisionInProgress(null)
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
      const selectedCount = selectedRowIds.length
      setDecisionInProgress('bulk')
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

      await fetchRequests(false)
      showSuccessMessage(
        `${selectedCount} TCs ${decision === 'APPROVE' ? 'Approved' : 'Rejected'} successfully`,
        decision === 'APPROVE' ? 'You can close this window or proceed to Transfer to KB.' : undefined
      )
      window.dispatchEvent(new Event('test-case-review-updated'))
    } catch (error) {
      console.error('Failed to update bulk decision', error)
    } finally {
      setDecisionInProgress(null)
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
  const bulkActionsEnabled = isSelectAllChecked && pendingTestCaseIds.length > 0 && !decisionInProgress

  const filteredRequests = useMemo(() => {
    const term = tableSearch.trim().toLowerCase()
    if (!term) return historyRequests
    return historyRequests.filter((request) => {
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
  }, [historyRequests, tableSearch])

  const totalPages = Math.max(1, Math.ceil(filteredRequests.length / pageSize))
  const safeCurrentPage = Math.min(currentPage, totalPages)
  const paginatedHistoryRequests = useMemo(() => {
    const start = (safeCurrentPage - 1) * pageSize
    return filteredRequests.slice(start, start + pageSize)
  }, [filteredRequests, safeCurrentPage, pageSize])

  const adoTotalPages = Math.max(1, Math.ceil(adoRequests.length / ADO_PAGE_SIZE))
  const safeAdoCurrentPage = Math.min(adoCurrentPage, adoTotalPages)
  const paginatedAdoRequests = useMemo(() => {
    const start = (safeAdoCurrentPage - 1) * ADO_PAGE_SIZE
    return adoRequests.slice(start, start + ADO_PAGE_SIZE)
  }, [adoRequests, safeAdoCurrentPage])

  const handleTableSearchChange = (value: string) => {
    setTableSearch(value)
    setCurrentPage(1)
  }

  return (
    <div className="space-y-6">
      <div className="rounded-[20px] border border-slate-200 bg-white p-5 shadow-sm">
        {loading ? (
          <div className="text-sm text-slate-600">Loading review queue...</div>
        ) : requests.length === 0 && adoRequests.length === 0 && historyRequests.length === 0 ? (
          <div className="rounded-[14px] border border-dashed border-slate-200 bg-slate-50 p-8 text-sm text-slate-600">
            No review requests pending.
          </div>
        ) : (
          <div className="space-y-6">
            <div className="overflow-hidden rounded-[14px] border border-slate-200">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-red-800 bg-red-700 px-3 py-2">
                <div className="text-xs font-bold uppercase tracking-[0.14em] text-white">
                  Recent / Current Records
                </div>
              </div>
              <div className="max-h-[640px] overflow-auto">
                <table className="min-w-full border-collapse text-left text-xs text-slate-700">
                  <thead className="sticky top-0 bg-white">
                    <tr>
                      <th className="border-b border-red-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-red-700">S. No</th>
                      <th className="border-b border-red-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-red-700">Document ID</th>
                      <th className="border-b border-red-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-red-700">Request ID</th>
                      <th className="border-b border-red-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-red-700">BRD Document</th>
                      <th className="border-b border-red-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-red-700">TestCase</th>
                      <th className="border-b border-red-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-red-700">Approved</th>
                      <th className="border-b border-red-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-red-700">Rejected</th>
                      <th className="border-b border-red-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-red-700">Overall Status</th>
                      <th className="border-b border-red-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-red-700">Requested By</th>
                      <th className="border-b border-red-200 px-3 py-3 font-semibold uppercase tracking-[0.12em] text-red-700">Requested Date &amp; Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requests.length === 0 ? (
                      <tr><td colSpan={10} className="px-3 py-6 text-center text-slate-500">No records available.</td></tr>
                    ) : requests.map((request, index) => (
                      <tr key={request.request_id} className="odd:bg-white even:bg-slate-50">
                        <td className="border-b border-slate-200 px-3 py-3 font-semibold text-slate-700">{index + 1}</td>
                        <td className="border-b border-slate-200 px-3 py-3 text-slate-700">{request.document_id || '—'}</td>
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
            </div>

            <ReviewRecordsTable
              title="ADO Repository Records"
              records={paginatedAdoRequests}
              loading={loading}
              startIndex={(safeAdoCurrentPage - 1) * ADO_PAGE_SIZE}
              onOpenReview={(requestId) => {
                setSelectedRequestId(requestId)
                setIsReviewModalOpen(true)
              }}
            />
            {adoRequests.length > ADO_PAGE_SIZE && (
              <div className="-mt-6 flex items-center justify-end gap-2 rounded-b-[14px] border border-t-0 border-slate-200 bg-slate-50 px-3 py-2">
                <button type="button" disabled={safeAdoCurrentPage <= 1} onClick={() => setAdoCurrentPage((page) => Math.max(1, page - 1))} className="rounded-[6px] border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40">Previous</button>
                <span className="text-xs text-slate-600">Page {safeAdoCurrentPage} of {adoTotalPages}</span>
                <button type="button" disabled={safeAdoCurrentPage >= adoTotalPages} onClick={() => setAdoCurrentPage((page) => Math.min(adoTotalPages, page + 1))} className="rounded-[6px] border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40">Next</button>
              </div>
            )}

            <section className="overflow-hidden rounded-[14px] border border-slate-200">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-red-800 bg-red-700 px-3 py-2">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-white"><span>All History Records: {filteredRequests.length}</span><button type="button" onClick={() => setIsHistoryExpanded((expanded) => !expanded)} aria-label={isHistoryExpanded ? 'Collapse history records' : 'Expand history records'} title={isHistoryExpanded ? 'Collapse history records' : 'Expand history records'} className="flex h-7 w-7 items-center justify-center rounded-[6px] border border-red-200 text-white hover:bg-red-900">{isHistoryExpanded ? <HiOutlineChevronDown className="h-4 w-4" /> : <HiOutlineChevronRight className="h-4 w-4" />}</button></div>
                {isHistoryExpanded && <input type="text" value={tableSearch} onChange={(event) => handleTableSearchChange(event.target.value)} placeholder="Search all fields..." className="w-64 rounded-[8px] border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 outline-none focus:border-slate-400" />}
              </div>
              {isHistoryExpanded && <><ReviewRecordsTable title="All History Records" records={paginatedHistoryRequests} loading={loading} showHeader={false} startIndex={(safeCurrentPage - 1) * pageSize} onOpenReview={(requestId) => { setSelectedRequestId(requestId); setIsReviewModalOpen(true) }} />
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-3 py-2">
                <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setCurrentPage(1) }} className="rounded-[6px] border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"><option value={5}>5</option><option value={10}>10</option><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select>
                <div className="flex items-center gap-2"><button type="button" disabled={safeCurrentPage <= 1} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} className="rounded-[6px] border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 disabled:opacity-40">Previous</button><span className="text-xs text-slate-600">Page {safeCurrentPage} of {totalPages}</span><button type="button" disabled={safeCurrentPage >= totalPages} onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))} className="rounded-[6px] border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 disabled:opacity-40">Next</button></div>
              </div></>}
            </section>

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
                                <th className="w-[100px] min-w-[56px] border-b border-slate-200 px-1 py-2 font-semibold uppercase tracking-[0.12em] text-slate-700">
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
                                    <td className="w-[56px] min-w-[56px] border-b border-slate-200 px-1 py-2 align-top">
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
                                          <button type="button" disabled={Boolean(decisionInProgress)} onClick={(event) => handleRowDecision(event, 'REJECT', item.test_case_id)} className="rounded-[8px] border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] font-semibold text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40">{decisionInProgress === item.test_case_id ? 'Saving...' : 'Reject'}</button>
                                          <button type="button" disabled={Boolean(decisionInProgress)} onClick={(event) => handleRowDecision(event, 'APPROVE', item.test_case_id)} className="rounded-[8px] bg-red-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40">{decisionInProgress === item.test_case_id ? 'Approving...' : 'Approve'}</button>
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
                          {decisionInProgress === 'bulk' ? 'Approving...' : 'Approve Selected'}
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

      {successMessage && (
        <div className={`pointer-events-none fixed left-1/2 top-1/2 z-[80] flex -translate-x-1/2 -translate-y-1/2 items-start gap-3 rounded-[10px] border border-red-200 bg-white px-4 py-3 text-sm font-semibold text-red-700 shadow-[0_12px_30px_rgba(15,23,42,0.14)] transition-all duration-300 ${isSuccessMessageVisible ? 'opacity-100' : 'translate-y-[calc(-50%+8px)] opacity-0'}`}>
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-700">OK</span>
          <div><div>{successMessage}</div>{successMessageDetail && <div className="mt-1 text-xs font-medium text-slate-600">{successMessageDetail}</div>}</div>
        </div>
      )}

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
