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
  /** The project its test case was generated for (PPM ID and name). */
  project?: { id: number; ppm_id: string; name: string } | null
  test_case_id?: number | null
  tc_display_id?: string | null
  tc_title?: string | null
  file_name?: string | null
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
  is_healed?: boolean
  /** How it was started: dry_run, rerun, discovery -- or null for a spec run. */
  mode?: string | null
  /** Pause between actions; 1000 is "Safe / WAF (1s)". */
  slow_mo_ms?: number | null
  healing_diagnosis?: string | null
  healing_changes?: string[] | null
  original_code?: string | null
  healed_code?: string | null
  run_metadata?: Record<string, any> | null
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

export interface HealRunResponse {
  healed_code: string
  diagnosis: string
  changes_made: string[]
  original_code: string
  confidence: number
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
  slow_mo_ms?: number | null
  headless?: boolean | null
  /** "rerun" when a finished run's spec is run again from Runs. */
  mode?: 'standard' | 'rerun' | null
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

// ── Automation TC Coverage Assessment ────────────────────────────────────────

/**
 * 'partial' is "automatable once these named edits are made" — a step with no
 * verb, a control the catalogue does not have, a value nobody supplied. It
 * exists because the two-way split forced those cases into one of two wrong
 * answers: Automation, which compiles a script that fails on its first run, or
 * Manual, which retires a case that only needed a sentence rewritten.
 */
export type Classification = 'automation' | 'partial' | 'manual' | 'undecided'

/** How a single rule finding weighs on the verdict. */
export type FindingSeverity = 'blocker' | 'fixable' | 'note'

/** The state of one of the four checks behind the badge. */
export type CheckStatus = 'pass' | 'attention' | 'blocked'

/** One thing the rules noticed, and what to do about it. */
export interface ClassificationFinding {
  code: string
  severity: FindingSeverity
  scope: 'steps' | 'channel' | 'knowledge_base' | 'test_data'
  message: string
  step_number: number | null
  /** Filled for fixables only — an instruction, not a description. */
  remedy: string | null
  evidence: string | null
}

interface ClassificationCheck {
  status: CheckStatus
  summary: string
  findings: ClassificationFinding[]
}

export interface StepsCheck extends ClassificationCheck {
  total: number
  actionable: number
}

export interface ChannelCheck extends ClassificationCheck {
  detected: string
  label: string
  support: 'supported' | 'needs_change' | 'unsupported'
  evidence: string[]
}

export interface KnowledgeBaseCheck extends ClassificationCheck {
  app_id: string | null
  profile: boolean
  application_name: string | null
  catalog_size: number
  matched: number
  unresolved: { step_number: number; target: string | null; reason: string }[]
  skipped: number
  grounding_status: GroundingStatus
}

export interface TestDataCheck extends ClassificationCheck {
  has_test_data: boolean
  steps_needing_data: number[]
}

/**
 * The whole rule report behind the badge. Null until the case is classified by
 * rule, and null again after a human overrides the verdict — the findings
 * described a decision that no longer stands.
 */
export interface ClassificationReport {
  classification: Classification
  reason: string
  checks: {
    steps: StepsCheck
    channel: ChannelCheck
    knowledge_base: KnowledgeBaseCheck
    test_data: TestDataCheck
  }
  blockers: ClassificationFinding[]
  fixables: ClassificationFinding[]
  notes: ClassificationFinding[]
  counts: { steps: number; blockers: number; fixables: number }
  checked_at: string
  engine: string
}
export type ApprovalStatus = 'draft' | 'approved' | 'rejected'
/**
 * 'pending' is the only value that blocks approval.
 *
 * 'user_provided' is a human decision rather than a derived fact: someone
 * confirmed the data now exists. The backend preserves it through rescore
 * instead of recomputing it from the requirements list, which is what lets a
 * case stay unblocked after an unrelated edit.
 */
export type TestDataStatus = 'not_required' | 'pending' | 'ready' | 'user_provided'
/** Where the case came from: refined in place, typed in, or built to fill a gap. */
export type CaseOrigin = 'existing' | 'imported' | 'derived'

/** A row in the "what to refine" panels. */
export interface WorkbenchSource {
  id: string
  /**
   * Which of the two ways this case arrived, and which request field its id
   * belongs in when refining. 'approved' ids are review-workflow test case ids
   * and go in source_test_case_ids; 'studio' ids are automation_test_cases
   * primary keys (CSV import, manual authoring, document intake) and go in
   * case_ids. Sending one as the other silently matches nothing.
   */
  origin: 'approved' | 'studio'
  tc_display_id: string
  title: string
  category: string | null
  eligibility: Eligibility
  /** Set once refined — drives the "Refined" badge and the regenerate guard. */
  refined_test_case_id: number | null
}

export interface WorkbenchCase extends StudioCase {
  /** The project it was generated for (PPM ID and name). */
  project?: { id: number; ppm_id: string; name: string } | null
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
  classification_report: ClassificationReport | null
  classified_at: string | null
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
  /** Whether the steps resolve to controls the discovered application really has. */
  grounding_status: GroundingStatus
  grounding_summary: GroundingSummary | null
  grounded_at: string | null
  /** Which catalogue version the verdict belongs to. */
  discovery_run_id: number | null
  /** Guided Live Browser Discovery */
  flow_discovery_status?: 'none' | 'starting' | 'recording' | 'captured' | 'completed' | 'error' | string
  recorded_flow_objects?: RecordedFlowObject[] | null
  recorded_flow_objects_count?: number
  /** Quality Review (eSMART Review Agent) */
  review_score?: number | null
  review_verdict?: 'pass' | 'needs_revision' | 'fail' | string | null
  review_scores?: {
    step_quality?: number
    data_readiness?: number
    expected_result_clarity?: number
    coverage?: number
  } | null
  review_findings?: {
    issues?: string[]
    suggestions?: string[]
    coverage_gaps?: string[]
  } | null
  reviewed_at?: string | null
}

export interface CaseReviewResult {
  case_id: number
  display_id: string
  overall_score: number
  verdict: 'pass' | 'needs_revision' | 'fail' | string
  scores: {
    step_quality: number
    data_readiness: number
    expected_result_clarity: number
    coverage: number
  }
  findings: {
    issues: string[]
    suggestions: string[]
    coverage_gaps: string[]
  }
  reviewed_at?: string | null
}

export interface RecordedFlowObject {
  step_number?: number
  action?: string
  target_name?: string
  recommended_locator?: string
  alternative_locators?: string[]
  page_url?: string
  tag_name?: string
  role?: string
  accessible_name?: string
  timestamp?: string
  value?: string
}

export interface WorkbenchCounts {
  total: number
  automation: number
  /** Automatable once the findings the rules named are addressed. */
  partial: number
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
  /** The last dry run, read through its run (Script Lab listing only). */
  dry_run?: DryRunBrief | null
  generation_error: string | null
  runnable: boolean
  created_by: string | null
  created_at: string | null
  updated_at: string | null
}

/** Where a script's last dry run got to: "failed at step 5 · 00:48". */
export interface DryRunBrief {
  run_key: string
  status: RunStatus
  outcome: RunOutcome
  duration_seconds: number | null
  completed_at: string | null
  failed_step: number | null
  failed_title: string | null
  error_message: string | null
  is_healed: boolean
}

export interface ScriptLabCase {
  id: number
  /** The project it was generated for (PPM ID and name). */
  project?: { id: number; ppm_id: string; name: string } | null
  tc_display_id: string
  title: string
  priority: string
  steps: number
  test_data_status: TestDataStatus
  application_url: string | null
  /** Who generated the review request it came from. */
  created_by?: string | null
  /** SIT, UAT...: chosen on Generate Test Cases; its runs use it. */
  environment?: string | null
  /** When the case landed in the automation module; the Lab is sorted on it. */
  created_at: string | null
  scripts: ScriptAsset[]
  /** The review request it was approved in, and that request's source. */
  request_id?: string | null
  source_group?: string | null
}

export interface ScriptLabListing {
  counts: {
    approved_cases: number
    by_framework: Record<string, number>
    /** How many approved requests the cases came from. */
    requests?: number
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

// ── Application Discovery and Grounding ──────────────────────────────────────

export type GroundingStatus = 'not_checked' | 'grounded' | 'partially_grounded' | 'ungrounded'
export type LocatorStrategy = 'role' | 'label' | 'text' | 'placeholder' | 'testid'

/**
 * Which application the user last selected on Application Discovery.
 *
 * Shared rather than private to that screen: the Script Lab compiles against a
 * discovery catalogue, and it has to be the catalogue of the application the
 * user is actually working on. Without this the Lab fell back to whatever the
 * backend picked, which is only unambiguous while exactly one application is
 * registered.
 */
export const SELECTED_APP_STORAGE_KEY = 'automation.discovery.applicationId'

/** The selected application id, or null if none has been chosen or it is unset. */
export const readSelectedApplicationId = (): number | null => {
  if (typeof window === 'undefined') return null
  const stored = Number(window.localStorage.getItem(SELECTED_APP_STORAGE_KEY))
  return Number.isFinite(stored) && stored > 0 ? stored : null
}

/**
 * A registered target application — the identity Discovery, its element
 * catalogue and grounding all hang off.
 *
 * `app_key` names the Knowledge Base folder holding the application's profile
 * and flow blueprints; `knowledge_base.linked` says whether that folder
 * actually resolved, so the picker can show an application that is registered
 * but has no ground truth behind it yet.
 */
export interface RegisteredApplication {
  id: number
  name: string
  app_key: string
  base_url: string
  environment: string
  description: string | null
  is_active: boolean
  auth_mode: string
  /** Whether a password is stored. The password itself is never returned. */
  has_credentials: boolean
  knowledge_base: {
    linked: boolean
    app_name: string | null
    domain: string | null
    flows: number
  }
  /** This application's current crawl, or null if it has never been crawled. */
  discovery: {
    id: number
    status: DiscoveryRun['status']
    version: number
    elements_discovered: number
    pages_discovered: number
    updated_at: string | null
  } | null
  created_by: string | null
  created_at: string | null
  updated_at: string | null
}

/**
 * What drafting a Knowledge Base from a crawl actually wrote.
 *
 * `skipped` matters as much as `written`: a curated app_profile.json is never
 * replaced without being asked, and the reason says so rather than leaving the
 * caller to wonder why one file appeared and another did not.
 */
export interface KnowledgeBaseDraftResult {
  application_id: number
  app_key: string
  kb_dir: string
  crawl_version: number
  written: string[]
  skipped: Array<{ path: string; reason: string }>
  pages_crawled: number
  elements_catalogued: number
  pages_blocked: number
  /** Whether the draft asked a model to classify the crawl into profile keys. */
  synthesis_requested: boolean
  /**
   * The outcome of that classification, or null when it was not asked for OR
   * no model could be reached — `synthesis_requested` separates the two, and
   * the second case is the one worth fixing.
   *
   * `rejected` is what the model proposed and the crawl would not vouch for. A
   * long list points at a crawl that was too shallow, not at a bad model.
   */
  synthesis: {
    requested: boolean
    rejected: string[]
    notes: string[]
    flows_proposed: number
  } | null
}

export interface DiscoveryRun {
  id: number
  /** Which application was crawled. Null only for runs predating scoping. */
  application_id: number | null
  /** Catalogues are versioned per application, so a grounding verdict stays
   *  tied to its crawl and another application's crawl cannot retire it. */
  version: number
  is_current: boolean
  status: 'queued' | 'running' | 'completed' | 'failed'
  application_url: string | null
  application_environment: string | null
  auth_mode: string
  auth_status: string
  auth_detail: string | null
  pages_discovered: number
  elements_discovered: number
  explored_pages: Array<{ url: string; title: string; status: number | null }>
  /** Why a page could not be crawled — a thin catalogue explains itself. */
  blockers: Array<{ url: string; reason: string }>
  error: string | null
  /** The crawl is an ordinary run, so it has a run_key with a log and evidence. */
  run_key: string | null
  created_by: string | null
  created_at: string | null
  updated_at: string | null
}

export interface DiscoveredElement {
  id: number
  page_url: string
  page_title: string | null
  element_name: string
  role: string | null
  accessible_name: string | null
  business_meaning: string | null
  /** Verified to resolve uniquely at crawl time — not a guess. */
  recommended_locator: string
  recommended_strategy: LocatorStrategy
  confidence_score: number
  href: string | null
}

export interface DiscoveryState {
  discovery: DiscoveryRun | null
  elements: number
  /** Which application this state describes — echoed back when it was resolved. */
  application_id?: number
}

export interface ElementCatalog {
  elements: DiscoveredElement[]
  total: number
  roles: string[]
}

export interface GroundingMatch {
  step_number: number
  target: string | null
  element_name: string
  locator: string
  strategy: LocatorStrategy
  page: string
  confidence: number
}

export interface GroundingGap {
  step_number: number
  action: string | null
  target: string | null
  /** Actionable: says whether the page was missed or the label differs. */
  reason: string
}

export interface GroundingSummary {
  status: GroundingStatus
  note: string | null
  matched: GroundingMatch[]
  unresolved: GroundingGap[]
  /** Steps needing no control at all — skipped rather than counted as failures. */
  skipped: number
  catalog_size: number
}

export interface GroundResult {
  grounded_against: DiscoveryRun
  checked: number
  counts: Record<GroundingStatus, number>
  test_cases: WorkbenchCase[]
}

export const isDiscoverySettled = (status: DiscoveryRun['status']): boolean =>
  status === 'completed' || status === 'failed'

/* --- Automation Module: Document Intake ---------------------------------- */

/** What a document is, which decides what intake does with its text. */
export type IntakeRole = 'brd' | 'srd' | 'test_cases'

/** Extraction outcome for one document — the "TEXT" column in the table. */
export type IntakeExtractStatus = 'pending' | 'ready' | 'failed'

export interface IntakeDocument {
  id: number
  filename: string
  file_type: string
  size_bytes: number | null
  role: IntakeRole
  extract_status: IntakeExtractStatus
  /**
   * Why extraction failed — or, on a 'ready' test case document that yielded
   * nothing, why it found no table. Present on a successful extraction too,
   * which is the point: "Ready" beside "0 test case(s)" needs an explanation.
   */
  extract_error: string | null
  page_count: number | null
  cases_found: number
  text_chars: number
  uploaded_by: string | null
  created_at: string | null
}

export interface IntakeBatch {
  id: number
  name: string
  status: string
  document_count: number
  cases_found: number
  created_by: string | null
  created_at: string | null
  documents: IntakeDocument[]
}

/** A file refused before it was ever stored — bad extension, empty upload. */
export interface IntakeRejection {
  filename: string | null
  reason: string
}

export interface IntakeUploadResult {
  batch: IntakeBatch
  rejected: IntakeRejection[]
}

/** Role changes answer with the batch, plus a note when re-harvesting failed. */
export interface IntakeRoleResult {
  batch: IntakeBatch
  note: string | null
}

export const INTAKE_ROLE_LABELS: Record<IntakeRole, string> = {
  brd: 'BRD',
  srd: 'SRD',
  test_cases: 'Test Cases'
}

/** Extensions the backend's extractor accepts. Mirrors extraction.py. */
export const INTAKE_ACCEPTED_EXTENSIONS = '.pdf,.docx,.xlsx,.csv,.txt,.md'
