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

// ── Intake and refinement ────────────────────────────────────────────────────

/** A step as refinement produces it — one observable interaction each. */
export interface RefinedStep {
  step_number: number
  action: string
  target: string | null
  /** Key of the test data item this step consumes; never an inline literal. */
  test_data_ref: string | null
  expected_result: string | null
}

export type DataResolution = 'agent_generated' | 'existing_record' | 'user_required'

export interface TestDataRequirement {
  key: string
  description: string | null
  example_value: string | null
  sensitive: boolean
  resolution: DataResolution
}

/** A case owned by the Studio: authored, imported, or produced by refinement. */
export interface StudioCase {
  id: number
  source: 'manual' | 'refined'
  /** Set on a refined case: the case it was rewritten from. */
  parent_id: number | null
  origin_test_case_id: string | null
  display_id: string
  category: string | null
  description: string | null
  preconditions: string | null
  steps_raw: string | null
  test_data: string | null
  expected_result: string | null
  steps_structured: RefinedStep[]
  test_data_requirements: TestDataRequirement[]
  automation_blockers: string[]
  eligibility: Eligibility
  created_by: string | null
  created_at: string | null
  updated_at: string | null
}

/** What the intake form, the paste parser and one CSV row all produce. */
export interface ManualCaseInput {
  display_id: string
  category?: string | null
  description?: string | null
  preconditions?: string | null
  steps_raw?: string | null
  test_data?: string | null
  expected_result?: string | null
  origin_test_case_id?: string | null
}

export interface ImportSkip {
  line: number
  reason: string
}

export interface ImportResult {
  imported: number
  /** Rows the import refused, by line number — never silently dropped. */
  skipped: ImportSkip[]
  cases: StudioCase[]
}

/** Both sides of a refinement, so the rewrite can be reviewed before it is used. */
export interface RefineResult {
  original: StudioCase
  refined: StudioCase
  bdd_scenario: string | null
  test_data_required: boolean
  test_data_notes: string | null
}

export interface LlmStatus {
  provider: string
  configured: boolean
  detail: string
}

// ── Automation TC Coverage Assessment ────────────────────────────────────────

export type Classification = 'automation' | 'manual' | 'undecided'
export type ApprovalStatus = 'draft' | 'approved' | 'rejected'
export type TestDataStatus = 'not_required' | 'pending' | 'ready'
/** Where the case came from: refined in place, typed in, or built to fill a gap. */
export type CaseOrigin = 'existing' | 'imported' | 'derived'

/** A row in the "what to refine" panels. */
export interface WorkbenchSource {
  id: string
  tc_display_id: string
  title: string
  category: string | null
  eligibility: Eligibility
  /** Set once refined — drives the "Refined" badge and the regenerate guard. */
  refined_test_case_id: number | null
}

export interface WorkbenchCase extends StudioCase {
  tc_display_id: string
  title: string
  objective: string | null
  bdd_scenario: string | null
  priority: string
  test_type: string | null
  origin: CaseOrigin
  classification: Classification
  /** `policy` = decided by rule, `user` = a human overrode it. */
  classification_source: string | null
  classification_reason: string | null
  manual_only_reasons: string[]
  test_data_required: boolean
  test_data_status: TestDataStatus
  test_data_notes: string | null
  approval_status: ApprovalStatus
  decision_reason: string | null
  approved_by: string | null
  approved_at: string | null
  version: number
  application_url: string | null
  steps: RefinedStep[]
  /** The source it was refined from is gone, so regenerating would duplicate it. */
  source_missing: boolean
  can_approve: boolean
  approve_blocked_reason: string | null
}

export interface WorkbenchCounts {
  total: number
  automation: number
  manual: number
  undecided: number
  approved: number
  rejected: number
  /** Pending test data — these cannot be approved until a human supplies it. */
  needs_data: number
}

export interface WorkbenchGrid {
  counts: WorkbenchCounts
  test_cases: WorkbenchCase[]
}

export interface GenerationJob {
  job_id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  percent: number
  message: string
  total: number
  completed: number
  created_ids: number[]
  errors: Array<{ display_id: string; error: string }>
  started_at: string
  finished_at: string | null
}

export interface DecideResult {
  updated: number
  /** Cases the server would not approve, each saying why. */
  refused: Array<{ id: number; display_id: string; reason: string }>
  test_cases: WorkbenchCase[]
}

export const isJobSettled = (status: GenerationJob['status']): boolean =>
  status === 'completed' || status === 'failed'

// ── Automation Script Lab ────────────────────────────────────────────────────

export type DryRunStatus = 'not_run' | 'queued' | 'running' | 'passed' | 'failed' | 'blocked'

export interface FrameworkInfo {
  name: string
  label: string
  /** False for Katalon and Appium — generated and downloadable, never executed. */
  runnable: boolean
}

/** Cheap checks run before anything spends a browser. */
export interface StaticGateResult {
  passed: boolean
  errors: string[]
  warnings: string[]
  checked: string[]
}

export interface ScriptAsset {
  id: number
  test_case_id: number
  test_case_display_id: string | null
  test_case_title: string | null
  framework: string
  language: string
  file_name: string
  script_key: string | null
  code: string
  entry_path: string | null
  execution_command: string | null
  setup_notes: string[]
  generation_mode: 'compiled' | 'freeform'
  static_gate_result: StaticGateResult | null
  dry_run_status: DryRunStatus
  dry_run_summary: Record<string, unknown> | null
  dry_run_at: string | null
  /** The run_key of the AutomationRun that executed it — a dry run IS a run. */
  dry_run_key: string | null
  status: string
  version: number
  is_current: boolean
  /** Set once a human edits the code; regeneration refuses to discard it. */
  edited_by_user: boolean
  generation_error: string | null
  runnable: boolean
  created_by: string | null
  created_at: string | null
  updated_at: string | null
}

export interface ScriptLabCase {
  id: number
  tc_display_id: string
  title: string
  priority: string
  steps: number
  test_data_status: TestDataStatus
  application_url: string | null
  scripts: ScriptAsset[]
}

export interface ScriptLabListing {
  counts: {
    approved_cases: number
    by_framework: Record<string, number>
  }
  cases: ScriptLabCase[]
}

export interface GenerateScriptsResult {
  generated: number
  skipped: Array<{ display_id: string; reason: string }>
  scripts: ScriptAsset[]
}

export interface DryRunResult {
  queued: Array<{ script_id: number; run_key: string }>
  refused: Array<{ script_id: number; reason: string }>
}

export interface DryRunState {
  script_id: number
  dry_run_status: DryRunStatus
  run: RunSummary | null
  summary?: Record<string, unknown> | null
}

export const isDryRunSettled = (status: DryRunStatus): boolean =>
  status === 'passed' || status === 'failed' || status === 'blocked' || status === 'not_run'
