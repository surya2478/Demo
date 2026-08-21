/**
 * --- Automation Module: API types ---------------------------------------
 *
 * These mirror the Phase 0 responses in app/routers/automation.py exactly.
 * Hand-written rather than generated, on purpose: the backend is the contract
 * and a drift here should fail at compile time, not at render time.
 */

export type Verdict = 'ready' | 'review' | 'needs_enhancement'

/** Run lifecycle — where the process got to. */
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * What the tests actually said. Distinct from status on purpose: a run that
 * never started tested nothing, so it is `blocked` rather than `failed`.
 * `null` means the run was cancelled, or has not finished yet.
 */
export type RunOutcome = 'passed' | 'failed' | 'blocked' | null

/** Per-test status, already normalised from Playwright's vocabulary. */
export type ResultStatus = 'pass' | 'fail' | 'skip' | 'error' | 'blocked'

export type ArtifactKind = 'screenshot' | 'video' | 'trace'

export interface Eligibility {
  score: number
  verdict: Verdict
  /** Named shortfalls. A score without these is not actionable. */
  reasons: string[]
  step_count: number
  can_generate: boolean
}

export interface Candidate {
  source: 'approved' | 'manual' | 'refined'
  /** Studio row id. Null for approved cases — they are not mirrored yet. */
  id: number | null
  origin_test_case_id: string | null
  origin_request_id: string | null
  display_id: string
  category: string | null
  description: string
  approved_by: string | null
  approved_at: string | null
  generated_by: string | null
  eligibility: Eligibility
  script_count: number
}

export interface CandidateSummary {
  total: number
  ready: number
  review: number
  needs_enhancement: number
  scripted: number
}

export interface CandidatesResponse {
  summary: CandidateSummary
  candidates: Candidate[]
}

export interface ApprovedCandidateDetail {
  source: 'approved'
  origin_test_case_id: string
  origin_request_id: string | null
  /** Raw stored shape — title-case keys with spaces, as generation wrote them. */
  details: Record<string, unknown>
  eligibility: Eligibility
  approved_by: string | null
  approved_at: string | null
  generated_by: string | null
}

export interface FrameworkSupport {
  available: boolean
  /** Short, human-readable, and actionable when unavailable. */
  detail: string
}

export interface RuntimeStatusResponse {
  enabled: boolean
  ready: boolean
  frameworks: Record<string, FrameworkSupport>
  runnable_frameworks: string[]
  generate_only_frameworks: string[]
  max_concurrent_runs: number
  storage_path: string
}

export interface RunSummary {
  run_key: string
  status: RunStatus
  outcome: RunOutcome
  framework: string
  environment: string | null
  error_message: string | null
  total_tests: number
  passed: number
  failed: number
  skipped: number
  blocked: number
  duration_seconds: number | null
  started_at: string | null
  completed_at: string | null
  created_at: string | null
  triggered_by: string | null
  /** Whether this process is executing the run right now. */
  is_active: boolean
}

export interface RunResultRow {
  id: number
  test_name: string
  status: ResultStatus
  duration_ms: number | null
  error_message: string | null
  stack_trace: string | null
  /** Which evidence exists. Paths are never returned to the client. */
  evidence: Record<ArtifactKind, boolean>
  console_logs: unknown
  network_logs: unknown
}

export interface RunSpec {
  code: string | null
  file_name: string | null
  base_url: string | null
}

export interface RunDetail extends RunSummary {
  has_log: boolean
  /** Returned only by the single-run endpoint, never by the list. */
  spec: RunSpec | null
  results: RunResultRow[]
}

export interface RunsSummary {
  total_runs: number
  pass_rate: number | null
  avg_duration_seconds: number | null
  active: number
  capacity: number
}

export interface RunsResponse {
  summary: RunsSummary
  runs: RunSummary[]
}

export interface CreateRunRequest {
  code: string
  environment?: string | null
  base_url?: string | null
  file_name?: string | null
  test_case_id?: number | null
}

export interface CreateRunResponse {
  run_key: string
  status: RunStatus
  poll: string
}

/** A run is worth polling only while it can still change. */
export const isTerminal = (status: RunStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'cancelled'
