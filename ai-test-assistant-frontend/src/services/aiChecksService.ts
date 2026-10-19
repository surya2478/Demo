import api from './api'

export type CheckStepName = 'refine' | 'review' | 'improve' | 'diff' | 'classify'
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
  status: 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'awaiting_approval'
  steps: Record<CheckStepName, CheckStepState>
  agents?: Record<AgentName, AgentProgress> | null
  recovery?: { crawl_id: number | null; status: 'working' | 'verified' | 'unresolved'; at: string; change_set_id?: number }[]
  authoring?: { source_actions?: string[]; completed_steps?: number[]; status?: string; issue?: string; trace?: NonNullable<AgentProgress['navigation_trace']>; script_verification?: { status: string } } | null
  safety_pause?: { crawl_id: number; step_order: number; journey_id: string; app_key: string } | null
  agent_decision?: AgentDecisionResult | null
  kb_publication_held?: boolean
  error: string | null
  score_before: number | null
  score_after: number | null
  improved: boolean
  classification: 'automation' | 'manual' | null
  classification_detail: string | null
  classification_reason: string | null
  test_data_pending: boolean
  test_data_notes: string | null
  test_data_requirements?: { key?: string; description?: string; resolution?: string; sensitive?: boolean }[]
  review_verdict: string | null
  application_url: string | null
  preconditions: string | null
  expected_result: string | null
  test_data: string | null
  steps_structured: CheckedStep[] | null
  /** KB Diff (Automation KB cases a design journey recognises): counts per status for the row. */
  journey_diff: JourneyDiffBrief | null
  /** The step-by-step diff, sent with the edit view. */
  journey_diff_steps?: JourneyDiffStep[] | null
  source_row: Record<string, string>
  /** Already sent for approval. */
  sent?: boolean
  evaluation_handoff?: { request_id: string; test_case_id: string; updated_at: string } | null
}

export type AgentName = 'requirements_guide' | 'crawl_guide' | 'navigation_guide' | 'expert_editor' | 'evidence_coordinator' | 'automation' | 'analysis' | 'audit' | 'data_entry' | 'approval_manager'
export interface AgentProgress {
  status: 'waiting' | 'queued' | 'retry_wait' | 'working' | 'done' | 'failed' | 'needs_approval'
  message: string | null
  attempt?: number
  max_attempts?: number
  crawl_id?: number
  discovery_id?: number
  journey_id?: string
  change_set_ids?: number[]
  summary?: Record<string, unknown>
  navigation_trace?: { from_url: string; to_url: string; role?: string; label?: string; outcome: string; source_step?: number; operation?: string; kind?: string; value?: string; data_ref?: string }[]
  authoring_status?: 'authored' | 'incomplete'
  completed_source_steps?: number[]
  script_verification?: { status: 'passed' | 'failed'; script_path?: string; report_path?: string }
  capture_issue?: string | null
  readiness?: {
    ready: boolean
    code_generated: boolean
    planned_steps: number
    browser_verification_steps: number[]
    risky_step?: number | null
    issues: string[]
  }
  events?: { at: string; status: string; message: string }[]
}
export interface AgentDecisionResult {
  check_id: number
  approved: number[]
  held: string[]
}
export interface AgentScanProgress {
  status: 'idle' | 'scanning' | 'prepared' | 'failed'
  run_id?: number
  change_set_id?: number
  observed_pages?: number
  observed_controls?: number
  blockers?: number
  max_pages?: number
  phase?: string
  current_url?: string
  recent_pages?: { url: string; title: string }[]
  unresolved?: string[]
  message?: string
  reused_capture?: boolean
}
export interface AgentTestDataSuggestion {
  app_key: string
  environment: string
  profile_id: string
  profile_exists: boolean
  fields: { name: string; variable: string; is_secret: boolean }[]
  profiles: { profile_id: string; name: string; fields: { name: string; variable: string }[]; cells: Record<string, { status: string; missing: string[] }> }[]
  observed_pages: number
  requirements: string[]
  ready_profile_ids: string[]
  recommended_profile_id: string | null
  requires_existing_account: boolean
  synthetic_safe: boolean
}
export interface AgentSetup {
  app_key: string
  application_id: number
  profile_id: string | null
  environment: string
  reuse_kb_evidence: boolean
  headed?: boolean
}

/** How a step compares between the Journey KB (design) and the Automation KB (crawled). */
export type JourneyDiffStatus = 'MATCH' | 'LABEL_DRIFT' | 'REF_BROKEN' | 'NOT_CRAWLED' | 'NOT_IN_DESIGN' | 'NO_ELEMENT' | 'UNRESOLVED'

export interface JourneyDiffBrief {
  journey_id: string | null
  summary: Partial<Record<JourneyDiffStatus, number>>
  automatable: boolean | null
  reason?: string | null
}

export interface JourneyDiffStep {
  step_number: number | null
  action: string
  status: JourneyDiffStatus
  screen_id: string | null
  element_id: string | null
  design_label: string | null
  app_labels: string[]
  automation_target: string | null
  suggestion: string | null
  corrected_action?: string
}

export interface CheckBatch {
  batch_id: string
  mode?: 'agents' | 'knowledge_base'
  agent_setup?: AgentSetup | null
  agent_auto_approval?: boolean
  status: 'running' | 'stopped' | 'complete' | 'awaiting_approval'
  /** Stop was pressed; a case is finishing the step it was on. */
  stopping: boolean
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
    stopped: number
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
  start: async (rows: Record<string, string>[], knowledgeBase?: string, requestId?: string, environment?: string, applications?: number[], refineMode: 'knowledge_base' | 'agents' = 'knowledge_base', agentSetup?: AgentSetup, approvalManagerEnabled = false): Promise<string> => {
    const res = await api.post(`${BASE}/start`, {
      rows,
      knowledge_base: knowledgeBase || null,
      refine_mode: refineMode,
      request_id: requestId || null,
      environment: environment || null,
      applications: applications && applications.length ? applications : null,
      agent_setup: agentSetup || null,
      approval_manager_enabled: refineMode === 'agents' && approvalManagerEnabled
    })
    return res.data.batch_id
  },
  get: async (batchId: string): Promise<CheckBatch> => {
    const res = await api.get(`${BASE}/${encodeURIComponent(batchId)}`, { params: { include_steps: true } })
    return res.data
  },
  setReuseKbEvidence: async (batchId: string, enabled: boolean): Promise<void> => {
    await api.patch(`${BASE}/${encodeURIComponent(batchId)}/kb-evidence`, { enabled })
  },
  setHeaded: async (batchId: string, enabled: boolean): Promise<void> => {
    await api.patch(`${BASE}/${encodeURIComponent(batchId)}/headed`, { enabled })
  },
  retry: async (batchId: string, checkId: number): Promise<void> => {
    await api.post(`${BASE}/${encodeURIComponent(batchId)}/checks/${checkId}/retry`)
  },
  continueBrowserReplay: async (batchId: string, checkId: number): Promise<void> => {
    await api.post(`${BASE}/${encodeURIComponent(batchId)}/checks/${checkId}/continue-browser-replay`)
  },
  alignJourneySteps: async (batchId: string, checkId: number): Promise<{ change_set_id: number; steps: number; unmapped: number }> =>
    (await api.post(`${BASE}/${encodeURIComponent(batchId)}/checks/${checkId}/align-journey-steps`)).data,
  retryDataEntry: async (batchId: string, checkId: number): Promise<{ status: string; change_set_ids?: number[]; message?: string }> =>
    (await api.post(`${BASE}/${encodeURIComponent(batchId)}/checks/${checkId}/retry-data-entry`)).data,
  retryAnalysis: async (batchId: string, checkId: number): Promise<void> => {
    await api.post(`${BASE}/${encodeURIComponent(batchId)}/checks/${checkId}/retry-analysis`)
  },
  retryAgent: async (batchId: string, checkId: number, agent: AgentName): Promise<void> => {
    await api.post(`${BASE}/${encodeURIComponent(batchId)}/checks/${checkId}/retry-agent/${encodeURIComponent(agent)}`)
  },
  markUnverifiedSent: async (batchId: string, checkId: number): Promise<void> => {
    await api.post(`${BASE}/${encodeURIComponent(batchId)}/checks/${checkId}/mark-unverified-sent`)
  },
  recheck: async (batchId: string, checkId: number): Promise<void> => {
    await api.post(`${BASE}/${encodeURIComponent(batchId)}/checks/${checkId}/recheck`)
  },
  agentDecision: async (batchId: string, scope: 'one' | 'batch' | 'off', checkId?: number): Promise<{ scope: string; active: boolean; results: AgentDecisionResult[] }> => {
    const res = await api.post(`${BASE}/${encodeURIComponent(batchId)}/agent-decision`, { scope, check_id: checkId || null })
    return res.data
  },
  scanMissingAgentControls: async (batchId: string, checkId: number, reuseExisting = false): Promise<AgentScanProgress> => {
    const res = await api.post(`${BASE}/${encodeURIComponent(batchId)}/checks/${checkId}/scan-missing`, null, { params: { reuse_existing: reuseExisting } })
    return res.data
  },
  agentScanProgress: async (batchId: string, checkId: number): Promise<AgentScanProgress> => {
    const res = await api.get(`${BASE}/${encodeURIComponent(batchId)}/checks/${checkId}/scan-missing`)
    return res.data
  },
  agentTestDataSuggestion: async (batchId: string, checkId: number): Promise<AgentTestDataSuggestion> =>
    (await api.get(`${BASE}/${encodeURIComponent(batchId)}/checks/${checkId}/test-data`)).data,
  saveAgentTestData: async (batchId: string, checkId: number, profileId: string, values: Record<string, string>): Promise<{ profile_id: string; change_set_id: number | null; message: string }> =>
    (await api.post(`${BASE}/${encodeURIComponent(batchId)}/checks/${checkId}/test-data`, { profile_id: profileId, values })).data,
  assignExistingAgentTestData: async (batchId: string, checkId: number, profileId: string): Promise<{ profile_id: string; message: string }> =>
    (await api.post(`${BASE}/${encodeURIComponent(batchId)}/checks/${checkId}/test-data/existing`, { profile_id: profileId })).data,
  stop: async (batchId: string): Promise<void> => {
    await api.post(`${BASE}/${encodeURIComponent(batchId)}/stop`)
  },
  /** Re-runs the stopped and failed cases; finished ones keep their results. */
  restart: async (batchId: string): Promise<number> => {
    const res = await api.post(`${BASE}/${encodeURIComponent(batchId)}/restart`, { check_ids: [] })
    return res.data.queued
  },
  remove: async (batchId: string, checkIds: number[]): Promise<number> => {
    const res = await api.post(`${BASE}/${encodeURIComponent(batchId)}/delete`, { check_ids: checkIds })
    return res.data.deleted
  },
  saveSteps: async (batchId: string, checkId: number, steps: EditedStep[]): Promise<void> => {
    await api.put(`${BASE}/${encodeURIComponent(batchId)}/checks/${checkId}/steps`, { steps })
  }
}

export default aiChecksService
