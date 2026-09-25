import api from './api'
import { getTimestampedFilename } from '../utils/DynamicFileName-DateTime'

// Review & Approval (screens 4 and 5). Every request has been through AI Checks
// when it comes from the Test Assistant; each case then carries the checks'
// results under test_case_details._ai, attached by the server at send time.

export type SourceGroup = 'BRD' | 'SDD' | 'ADO' | 'e2e Spark'

export interface RequestSummary {
  request_id: string
  document_id: string | null
  document_name: string
  brd_document?: { name?: string }[] | null
  source: string | null
  source_group: SourceGroup
  request_by: string | null
  request_date_time: string | null
  overall_status: 'PENDING_REVIEW' | 'PARTIALLY_APPROVED' | 'APPROVED' | 'REJECTED' | string
  reviewed_by: string | null
  reviewed_date_time: string | null
  approved_count: number
  rejected_count: number
  cases: number
  pending_cases: number
  ai_checked: number
  automation: number
  manual: number
  test_data_pending: number
  avg_before: number | null
  avg_after: number | null
  sent_to_lab: number
  /** The project it was generated for; null for requests from before projects. */
  project?: { id: number; ppm_id: string; name: string } | null
}

export interface Overview {
  now: string
  kpis: {
    pending_requests: number
    pending_cases: number
    automation_ready: number
    checked_cases: number
    avg_after: number | null
    avg_before: number | null
    oldest_request_id: string | null
    oldest_request_time: string | null
    oldest_document: string | null
  }
  requests: RequestSummary[]
}

export interface AIResults {
  check_id: number
  classification: 'automation' | 'manual' | null
  classification_detail: string | null
  classification_reason: string | null
  score_before: number | null
  score_after: number | null
  improved: boolean
  review_verdict: string | null
  review_scores: Partial<Record<'step_quality' | 'data_readiness' | 'expected_result_clarity' | 'coverage', number>> | null
  coverage_basis: string | null
  test_data_pending: boolean
  test_data_notes: string | null
  test_type: string | null
  steps: { step_number: number; action: string; action_type: string | null; expected_result: string | null }[]
  original: Record<string, string> | null
}

export interface ReviewCase {
  test_case_id: string
  request_id: string
  document_id: string | null
  test_case_details: Record<string, any>
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | string
  rejection_reason: string | null
  reviewed_by: string | null
  reviewed_datetime: string | null
}

export const PENDING = ['PENDING_REVIEW', 'PARTIALLY_APPROVED']

export const aiOf = (item: ReviewCase): AIResults | null => {
  const ai = item.test_case_details?._ai
  return ai && typeof ai === 'object' ? (ai as AIResults) : null
}

/** A value from the case's own columns, matched on shape rather than spelling. */
export const detailOf = (item: ReviewCase, ...names: string[]): string => {
  const index = new Map<string, unknown>()
  Object.entries(item.test_case_details || {}).forEach(([key, value]) => {
    if (!key.startsWith('_')) index.set(key.toLowerCase().replace(/[^a-z0-9]/g, ''), value)
  })
  for (const name of names) {
    const value = index.get(name.toLowerCase().replace(/[^a-z0-9]/g, ''))
    if (value != null && String(value).trim()) return String(value)
  }
  return ''
}

export const caseTitle = (item: ReviewCase) =>
  detailOf(item, 'Test Case Description', 'Description', 'Title', 'Test Case Title', 'Objective') || item.test_case_id

export const caseDisplayId = (item: ReviewCase) =>
  detailOf(item, 'Test Case ID', 'TC ID', 'Case ID') || item.test_case_id

const reviewService = {
  overview: async (): Promise<Overview> => (await api.get('/test-case-reviews/overview')).data,
  detail: async (requestId: string): Promise<{ data: RequestSummary; test_cases: ReviewCase[] }> =>
    (await api.get(`/test-case-reviews/detail/${encodeURIComponent(requestId)}`)).data,
  decide: async (
    requestId: string,
    decision: 'APPROVE' | 'REJECT',
    rows: { test_case_id: string; rejection_reason?: string }[],
    reviewNotes?: string
  ) => {
    await api.post(`/test-case-reviews/detail/${encodeURIComponent(requestId)}/decision`, {
      decision,
      rows,
      review_notes: reviewNotes || undefined
    })
    window.dispatchEvent(new Event('test-case-review-updated'))
  },
  /** Delete requests and their test cases. Manager only. */
  remove: async (requestIds: string[]): Promise<{ deleted: number; test_cases: number; drafts: number }> => {
    const res = await api.post('/test-case-reviews/delete', { request_ids: requestIds })
    window.dispatchEvent(new Event('test-case-review-updated'))
    return res.data
  }
}

// --- Downloads -----------------------------------------------------------------

const exportColumns = (records: ReviewCase[]) => {
  const columns: string[] = []
  records.forEach((record) =>
    Object.keys(record.test_case_details || {}).forEach((key) => {
      if (!key.startsWith('_') && !columns.includes(key)) columns.push(key)
    })
  )
  return columns
}

export const downloadRequestCases = async (requestId: string, records: ReviewCase[]) => {
  const XLSX = await import('xlsx')
  const columns = exportColumns(records)
  const rows = records.map((item) => {
    const ai = aiOf(item)
    const row: Record<string, string> = {
      'Request ID': item.request_id,
      'Test Case ID': item.test_case_id,
      Status: item.status,
      'AI classification': ai?.classification ?? '',
      'AI quality': ai?.score_after != null ? String(ai.score_after) : '',
      'Test data pending': ai?.test_data_pending ? 'Yes' : '',
      'Reviewed by': item.reviewed_by ?? '',
      'Reviewed at': item.reviewed_datetime ? new Date(item.reviewed_datetime).toLocaleString() : ''
    }
    columns.forEach((column) => { row[column] = String(item.test_case_details?.[column] ?? '') })
    return row
  })
  const sheet = XLSX.utils.json_to_sheet(rows)
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Test Cases')
  XLSX.writeFile(book, getTimestampedFilename(`test-cases-${requestId}`))
}

export const downloadRequestList = async (requests: RequestSummary[]) => {
  const XLSX = await import('xlsx')
  const rows = requests.map((item) => ({
    'Request ID': item.request_id,
    'PPM ID': item.project?.ppm_id ?? '',
    Project: item.project?.name ?? '',
    Document: item.document_name,
    Source: item.source_group,
    'Requested by': item.request_by ?? '',
    'Requested at': item.request_date_time ?? '',
    Status: item.overall_status,
    'Test cases': item.cases,
    Automation: item.automation,
    Manual: item.manual,
    'AI quality': item.avg_after ?? '',
    'Quality before AI Checks': item.avg_before ?? '',
    'Test data pending': item.test_data_pending,
    Approved: item.approved_count,
    Rejected: item.rejected_count,
    'Sent to Automation Lab': item.sent_to_lab
  }))
  const sheet = XLSX.utils.json_to_sheet(rows)
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Review requests')
  XLSX.writeFile(book, getTimestampedFilename('review-requests'))
}

// --- Compare: what the AI changed ------------------------------------------------

export interface DiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
  number?: number
  expected?: string | null
}

export const splitSteps = (text: string): string[] => {
  const clean = (text || '').replace(/\r/g, '').trim()
  if (!clean) return []
  const numbered = clean.split(/(?:^|\s)(?=\d+[.)]\s)/).map((part) => part.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean)
  if (numbered.length > 1) return numbered
  return clean.split(/\n+/).map((line) => line.replace(/^[-*•]\s*/, '').trim()).filter(Boolean)
}

const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Line diff by longest common subsequence over normalised step text. */
export const diffSteps = (original: string[], improved: AIResults['steps']): DiffLine[] => {
  const a = original.map(norm)
  const b = improved.map((step) => norm(step.action))
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: improved[j].action, number: j + 1, expected: improved[j].expected_result })
      i++; j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ kind: 'del', text: original[i] }); i++
    } else {
      lines.push({ kind: 'add', text: improved[j].action, number: j + 1, expected: improved[j].expected_result }); j++
    }
  }
  while (i < a.length) lines.push({ kind: 'del', text: original[i++] })
  while (j < b.length) { lines.push({ kind: 'add', text: improved[j].action, number: j + 1, expected: improved[j].expected_result }); j++ }
  return lines
}

/** Same grouping the server uses for the source filter (routers/test_case_reviews._source_group). */
export const sourceGroupOf = (summary: Pick<RequestSummary, 'source' | 'request_id' | 'brd_document'>): SourceGroup => {
  const source = String(summary.source || '').toUpperCase()
  if (source === 'ADO' || source === 'AZURE_DEVOPS' || summary.request_id.toUpperCase().startsWith('ADO-')) return 'ADO'
  if (source.includes('SPARK')) return 'e2e Spark'
  const names = (summary.brd_document || []).map((item) => item?.name || '').join(' ')
  return /(?<![A-Za-z])SDD(?![A-Za-z])/i.test(names) ? 'SDD' : 'BRD'
}

export const ageLabel = (iso: string | null, now: number) => {
  if (!iso) return ''
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m ago`
  return `${Math.floor(hours / 24)}d ago`
}

export default reviewService
