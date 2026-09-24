import api from './api'

export type CheckStepName = 'refine' | 'review' | 'improve' | 'classify'
export type CheckStepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

export interface CheckedStep {
  step_number: number
  action: string
  action_type: string | null
  target: string | null
  test_data_ref: string | null
  expected_result: string | null
}

export interface CheckItem {
  check_id: number
  case_id: number | null
  display_id: string | null
  title: string | null
  status: 'queued' | 'running' | 'done' | 'failed'
  steps: Record<CheckStepName, CheckStepState>
  error: string | null
  score_before: number | null
  score_after: number | null
  improved: boolean
  classification: 'automation' | 'manual' | null
  classification_detail: string | null
  classification_reason: string | null
  test_data_pending: boolean
  test_data_notes: string | null
  review_verdict: string | null
  application_url: string | null
  preconditions: string | null
  expected_result: string | null
  test_data: string | null
  steps_structured: CheckedStep[] | null
  source_row: Record<string, string>
}

export interface CheckBatch {
  batch_id: string
  status: 'running' | 'complete'
  total: number
  started_at: string | null
  finished_at: string | null
  knowledge_base: string | null
  pipeline: Record<CheckStepName, Record<CheckStepState, number>>
  summary: {
    automation: number
    manual: number
    needs_minor_changes: number
    improved: number
    test_data_pending: number
    not_checked: number
    avg_before: number | null
    avg_after: number | null
  }
  items: CheckItem[]
}

export interface EditedStep {
  action: string
  action_type: string | null
  expected_result: string | null
  target?: string | null
  test_data_ref?: string | null
}

const BASE = '/test-assistant/ai-checks'

const aiChecksService = {
  start: async (rows: Record<string, string>[], knowledgeBase?: string): Promise<string> => {
    const res = await api.post(`${BASE}/start`, { rows, knowledge_base: knowledgeBase || null })
    return res.data.batch_id
  },
  get: async (batchId: string): Promise<CheckBatch> => {
    const res = await api.get(`${BASE}/${encodeURIComponent(batchId)}`, { params: { include_steps: true } })
    return res.data
  },
  retry: async (batchId: string, checkId: number): Promise<void> => {
    await api.post(`${BASE}/${encodeURIComponent(batchId)}/checks/${checkId}/retry`)
  },
  saveSteps: async (batchId: string, checkId: number, steps: EditedStep[]): Promise<void> => {
    await api.put(`${BASE}/${encodeURIComponent(batchId)}/checks/${checkId}/steps`, { steps })
  }
}

export default aiChecksService
