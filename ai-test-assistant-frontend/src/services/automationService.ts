/**
 * --- Automation Module: API client --------------------------------------
 *
 * A thin binding over the Phase 0 endpoints. Two things here are deliberate:
 *
 *  - Errors are unwrapped to the backend's `detail` string and re-thrown.
 *    The backend refuses a run *before* queueing it and explains why (runtime
 *    missing, module disabled, no free slot). Swallowing that into a generic
 *    "Request failed" would throw away the only actionable part.
 *
 *  - Evidence is fetched as a blob, not linked. The artifact route is
 *    authenticated, and an <img src> cannot carry the Authorization header,
 *    so a plain URL would render a broken image for every user.
 */
import api, { LONG_REQUEST_MS } from './api'
import type {
  ProjectDeletePreview,
  ApprovedCandidateDetail,
  ArtifactKind,
  CreateRunRequest,
  CreateRunResponse,
  CreateDeviceRunResponse,
  Classification,
  DecideResult,
  GenerationJob,
  RefinedStep,
  RunDetail,
  RuntimeStatusResponse,
  RunsResponse,
  StudioCase,
  TestDataStatus,
  Verdict,
  WorkbenchCase,
  WorkbenchGrid,
  WorkbenchSource,
  DryRunResult,
  DryRunState,
  FrameworkInfo,
  GenerateScriptsResult,
  ScriptAsset,
  ScriptLabListing,
  LabCaseSteps,
  LabCaseStepsSave,
  LabStepsPreview,
  LabStepsPreviewIn,
  DiscoveredElement,
  DiscoveryRun,
  RegisteredApplication,
  KnowledgeBaseDraftResult,
  IntakeBatch,
  IntakeRole,
  IntakeRoleResult,
  IntakeUploadResult,
  DiscoveryState,
  HealRunResponse,
  ElementCatalog,
  GroundResult,
  RecordedFlowObject,
  CaseReviewResult,
  BitbucketScriptSyncResult
} from '../types/automation'
import { makeLocalPairing } from './localRunner'

const BASE = '/automation'

/**
 * Spread into any call that runs a language model or drives a real browser.
 * See the timeout note in ./api -- the client default is 30s, which is right
 * for the CRUD on this module and far too short for the rest of it.
 */
const LONG = { timeout: LONG_REQUEST_MS }

/** Pull the human-readable reason out of a FastAPI error response. */
export function automationError(err: any): string {
  const detail = err?.response?.data?.detail
  if (typeof detail === 'string' && detail.trim()) return detail
  // Pydantic validation errors arrive as a list of objects.
  if (Array.isArray(detail) && detail.length) {
    return detail
      .map((d: any) => d?.msg ?? JSON.stringify(d))
      .join('; ')
  }
  if (typeof err?.response?.data === 'string' && err.response.data.trim()) {
    return err.response.data
  }
  return err?.message ?? 'The request failed.'
}

/** Wrap a call so callers only ever see a readable Error. */
async function call<T>(fn: () => Promise<{ data: T }>): Promise<T> {
  try {
    const res = await fn()
    return res.data
  } catch (err: any) {
    throw new Error(automationError(err))
  }
}

const automationService = {
  /**
   * Whether this deployment can execute a browser test right now.
   * Called on load so a missing toolchain is visible before anyone clicks Run.
   */
  getRuntime: (): Promise<RuntimeStatusResponse> =>
    call<RuntimeStatusResponse>(() => api.get(`${BASE}/runtime`)),

  getApprovedCandidate: (testCaseId: string): Promise<ApprovedCandidateDetail> =>
    call<ApprovedCandidateDetail>(() =>
      api.get(`${BASE}/candidates/approved/${encodeURIComponent(testCaseId)}`)
    ),

  /** Queue a run. Resolves with a run_key to poll; rejects with the refusal. */
  createRun: (body: CreateRunRequest): Promise<CreateRunResponse> =>
    call<CreateRunResponse>(() => api.post(`${BASE}/runs`, body)),

  createDeviceRun: async (body: CreateRunRequest): Promise<CreateDeviceRunResponse> => {
    const response = await call<CreateRunResponse & { runner_token: string; expires_in_minutes: number }>(
      () => api.post(`${BASE}/runs/local`, body)
    )
    return {
      ...response,
      pairing: makeLocalPairing({
        id: response.run_key, token: response.runner_token,
        endpoint: `${BASE}/local-runner/runs/${encodeURIComponent(response.run_key)}`
      })
    }
  },

  /** What deleting a project from the Automation Lab would remove ("none": no project). */
  previewProjectDelete: (projectKey: string): Promise<ProjectDeletePreview> =>
    call<ProjectDeletePreview>(() => api.get(`${BASE}/projects/${encodeURIComponent(projectKey)}/delete-preview`)),

  /** Refused unless confirm is the PPM ID and the case count still matches. */
  deleteProject: (
    projectKey: string,
    confirm: string,
    expectedCases: number
  ): Promise<{ cases_removed: number; scripts_removed: number; runs_removed: number }> =>
    call(() => api.post(`${BASE}/projects/${encodeURIComponent(projectKey)}/delete`, { confirm, expected_cases: expectedCases })),

  /** Newest first; testCaseId narrows it to one case's runs (its History). */
  listRuns: (limit = 50, testCaseId?: number | null): Promise<RunsResponse> =>
    call<RunsResponse>(() =>
      api.get(`${BASE}/runs`, { params: testCaseId != null ? { limit, test_case_id: testCaseId } : { limit } })
    ),

  getRun: (runKey: string): Promise<RunDetail> =>
    call<RunDetail>(() => api.get(`${BASE}/runs/${encodeURIComponent(runKey)}`)),

  cancelRun: (runKey: string): Promise<{ run_key: string; cancelling: boolean }> =>
    call(() => api.post(`${BASE}/runs/${encodeURIComponent(runKey)}/cancel`)),

  deleteRuns: (runKeys: string[]): Promise<{ deleted: number }> =>
    call(() => api.post(`${BASE}/runs/delete`, { run_keys: runKeys })),

  deleteRun: (runKey: string): Promise<{ deleted: number }> =>
    call(() => api.delete(`${BASE}/runs/${encodeURIComponent(runKey)}`)),

  healRun: (runKey: string): Promise<HealRunResponse> =>
    call(() => api.post(`${BASE}/runs/${encodeURIComponent(runKey)}/heal`, undefined, LONG)),

  healScript: (scriptId: number): Promise<HealRunResponse> =>
    call(() => api.post(`${BASE}/scripts/${scriptId}/heal`, undefined, LONG)),

  /** Runner stdout and stderr, as plain text. */
  getRunLog: async (runKey: string): Promise<string> => {
    try {
      const res = await api.get(`${BASE}/runs/${encodeURIComponent(runKey)}/log`, {
        responseType: 'text',
        transformResponse: [(d: any) => d]
      })
      return typeof res.data === 'string' ? res.data : String(res.data ?? '')
    } catch (err: any) {
      throw new Error(automationError(err))
    }
  },

  /**
   * Fetch one piece of evidence as an object URL.
   *
   * The caller owns the returned URL and must revoke it — see
   * EvidencePanel, which revokes on unmount and on every swap.
   */
  getArtifactUrl: async (
    runKey: string,
    resultId: number,
    kind: ArtifactKind
  ): Promise<string> => {
    try {
      const res = await api.get(
        `${BASE}/runs/${encodeURIComponent(runKey)}/results/${resultId}/artifact/${kind}`,
        { responseType: 'blob' }
      )
      return URL.createObjectURL(res.data as Blob)
    } catch (err: any) {
      // An error body arrives as a Blob under responseType: 'blob', so the
      // usual `detail` unwrapping finds nothing. Read it back as text first.
      const blob = err?.response?.data
      if (blob instanceof Blob) {
        try {
          const text = await blob.text()
          const parsed = JSON.parse(text)
          if (parsed?.detail) throw new Error(String(parsed.detail))
        } catch (inner: any) {
          if (inner instanceof Error && inner.message && !(inner instanceof SyntaxError)) {
            throw inner
          }
        }
      }
      throw new Error(automationError(err))
    }
  },

  // ── Automation TC Coverage Assessment ──────────────────────────────────

  /** Approved and Studio cases available to refine, with their refined link. */
  listWorkbenchSources: (search?: string | null): Promise<{ sources: WorkbenchSource[]; total: number }> =>
    call(() =>
      api.get(`${BASE}/workbench/sources`, {
        params: search && search.trim() ? { search: search.trim() } : {}
      })
    ),

  listWorkbenchCases: (
    classification: 'all' | Classification = 'all'
  ): Promise<WorkbenchGrid> =>
    call<WorkbenchGrid>(() =>
      api.get(`${BASE}/workbench/test-cases`, { params: { classification } })
    ),

  /** Queue a refinement batch. Resolves with a job to poll, not the result. */
  generateRefinedCases: (body: {
    source_test_case_ids?: string[]
    case_ids?: number[]
    application_url?: string | null
    application_name?: string | null
    environment?: string | null
    regenerate?: boolean
  }): Promise<GenerationJob> =>
    call<GenerationJob>(() => api.post(`${BASE}/workbench/generate`, body)),

  getGenerationJob: (jobId: string): Promise<GenerationJob> =>
    call<GenerationJob>(() => api.get(`${BASE}/workbench/jobs/${encodeURIComponent(jobId)}`)),

  /** Omit `classification` to classify by rule; pass one to override by hand. */
  /**
   * Omit `classification` to run the rules; pass one to override by hand.
   * `counts` comes back keyed by outcome, so a bulk run can report "18
   * Automation, 9 needing changes, 3 Manual" rather than "30 classified".
   */
  classifyCases: (
    caseIds: number[],
    classification?: Classification
  ): Promise<{
    updated: number
    counts: Partial<Record<Classification, number>>
    test_cases: WorkbenchCase[]
  }> =>
    call(() =>
      api.post(
        `${BASE}/workbench/classify`,
        {
          case_ids: caseIds,
          ...(classification ? { classification } : {})
        },
        LONG
      )
    ),

  decideCases: (
    caseIds: number[],
    decision: 'approve' | 'reject',
    reason?: string | null
  ): Promise<DecideResult> =>
    call<DecideResult>(() =>
      api.post(`${BASE}/workbench/decide`, {
        case_ids: caseIds,
        decision,
        reason: reason ?? null
      })
    ),

  reopenCase: (caseId: number): Promise<WorkbenchCase> =>
    call<WorkbenchCase>(() => api.post(`${BASE}/workbench/test-cases/${caseId}/reopen`)),

  editWorkbenchCase: (
    caseId: number,
    body: Partial<{
      title: string
      objective: string
      preconditions: string
      steps_raw: string
      test_data: string
      expected_result: string
      priority: string
      test_type: string
      test_data_notes: string
      /** The approval gate — see TestDataStatus. Set by a person, not derived. */
      test_data_required: boolean
      test_data_status: TestDataStatus
      /**
       * The structured steps, replaced wholesale. The endpoint renumbers them
       * and rewrites steps_raw from what lands here, so a partial list would
       * delete the steps left out of it.
       */
      steps_structured: RefinedStep[]
    }>
  ): Promise<WorkbenchCase> =>
    call<WorkbenchCase>(() => api.patch(`${BASE}/workbench/test-cases/${caseId}`, body)),

  deleteWorkbenchCases: (
    caseIds: number[]
  ): Promise<{ deleted: number; scripts_removed: number }> =>
    call(() => api.post(`${BASE}/workbench/delete`, { case_ids: caseIds })),

  // ── Guided Flow Discovery ─────────────────────────────────────────────

  startGuidedDiscovery: (caseId: number): Promise<{
    case_id: number
    display_id: string
    target_url: string
    status: string
    started_at: string
  }> => call(() => api.post(`${BASE}/workbench/test-cases/${caseId}/guided-discovery/start`)),

  /** Guided discovery in a browser opened by the loopback Playwright runner on this device. */
  startDeviceGuidedDiscovery: async (caseId: number, headed = true): Promise<{
    case_id: number
    display_id: string
    target_url: string
    run_key: string
    status: string
    pairing: string
  }> => {
    const response = await call<{ case_id: number; display_id: string; target_url: string; run_key: string; status: string; runner_token: string }>(
      () => api.post(`${BASE}/workbench/test-cases/${caseId}/guided-discovery/device`, { headed })
    )
    return {
      ...response,
      pairing: makeLocalPairing({
        id: response.run_key, token: response.runner_token,
        endpoint: `${BASE}/local-runner/guided/${encodeURIComponent(response.run_key)}`
      })
    }
  },

  getDeviceGuidedDiscovery: (runKey: string): Promise<{
    case_id: number
    display_id: string | null
    run_key: string
    status: string
    message: string | null
    error: string | null
    objects_count: number
    captured_objects: RecordedFlowObject[]
  }> => call(() => api.get(`${BASE}/workbench/guided-discovery/device/${encodeURIComponent(runKey)}`)),

  stopDeviceGuidedDiscovery: (runKey: string): Promise<{ status: string; objects_count: number }> =>
    call(() => api.post(`${BASE}/workbench/guided-discovery/device/${encodeURIComponent(runKey)}/stop`)),

  stopGuidedDiscovery: (caseId: number): Promise<{
    case_id: number
    status: string
    objects_count: number
    flow_discovery_status: string
  }> => call(() => api.post(`${BASE}/workbench/test-cases/${caseId}/guided-discovery/stop`)),

  getGuidedDiscoveryStatus: (caseId: number): Promise<{
    case_id: number
    display_id: string
    status: string
    objects_count: number
    captured_objects: RecordedFlowObject[]
  }> => call(() => api.get(`${BASE}/workbench/test-cases/${caseId}/guided-discovery/status`)),

  getGuidedDiscoveryObjects: (caseId: number): Promise<{
    case_id: number
    display_id: string
    flow_discovery_status: string
    objects: RecordedFlowObject[]
  }> => call(() => api.get(`${BASE}/workbench/test-cases/${caseId}/guided-discovery/objects`)),

  updateGuidedDiscoveryObjects: (
    caseId: number,
    objects: RecordedFlowObject[]
  ): Promise<{
    case_id: number
    objects_count: number
    objects: RecordedFlowObject[]
  }> => call(() => api.put(`${BASE}/workbench/test-cases/${caseId}/guided-discovery/objects`, { objects })),

  clearGuidedDiscoveryObjects: (caseId: number): Promise<{ case_id: number; cleared: boolean }> =>
    call(() => api.delete(`${BASE}/workbench/test-cases/${caseId}/guided-discovery/objects`)),

  // ── Quality Review (eSMART Review Agent) ──────────────────────────────

  reviewTestCase: (caseId: number): Promise<CaseReviewResult> =>
    call<CaseReviewResult>(() =>
      api.post(`${BASE}/workbench/test-cases/${caseId}/review`, undefined, LONG)
    ),

  // Kept for the committed Workbench, which still calls it; the server no
  // longer has the endpoint (see routers/automation.py), so it fails there.
  reviewAllTestCases: (): Promise<{ reviewed_count: number; reviews: CaseReviewResult[] }> =>
    call(() => api.post(`${BASE}/workbench/test-cases/review-all`)),

  autoImproveTestCase: (
    caseId: number
  ): Promise<{ case_id: number; display_id: string; improved: boolean; review: CaseReviewResult }> =>
    call(() => api.post(`${BASE}/workbench/test-cases/${caseId}/auto-improve`, undefined, LONG)),

  // ── On-Demand In-Place Refinement ────────────────────────────────────

  refineTestCase: (
    caseId: number,
    options?: { application_url?: string }
  ): Promise<WorkbenchCase> =>
    call<WorkbenchCase>(() =>
      api.post(`${BASE}/workbench/test-cases/${caseId}/refine`, options || {}, LONG)
    ),

  refineBulkTestCases: (
    caseIds: number[],
    applicationUrl?: string
  ): Promise<{
    refined_count: number
    test_cases: WorkbenchCase[]
    /* Per-case failures. Absent on a backend older than the fix that stopped
       reporting a failed batch as a successful one. */
    errors?: { display_id: string; error: string }[]
  }> =>
    call(() =>
      api.post(
        `${BASE}/workbench/test-cases/refine-bulk`,
        {
          case_ids: caseIds,
          application_url: applicationUrl
        },
        LONG
      )
    ),

  deleteWorkbenchSources: (payload: {
    source_test_case_ids?: string[]
    case_ids?: number[]
  }): Promise<{
    deleted: number
    deleted_approved: number
    deleted_studio: number
    scripts_removed: number
  }> => call(() => api.post(`${BASE}/workbench/sources/delete`, payload)),

  /**
   * Download refined cases as CSV.
   *
   * Fetched as a blob rather than linked, for the same reason evidence is: the
   * route is authenticated and a plain href sends no Authorization header.
   */
  exportWorkbenchCsv: async (
    classification: 'all' | 'automation' | 'manual' = 'all'
  ): Promise<Blob> => {
    try {
      const res = await api.get(`${BASE}/workbench/export`, {
        params: { classification },
        responseType: 'blob'
      })
      return res.data as Blob
    } catch (err: any) {
      throw new Error(automationError(err))
    }
  },

  // ── Automation Script Lab ──────────────────────────────────────────────

  listFrameworks: (): Promise<{ frameworks: FrameworkInfo[]; runnable: string[] }> =>
    call(() => api.get(`${BASE}/frameworks`)),

  /** Approved, Automation-classified cases — the Lab's working set. */
  listScriptLabCases: (): Promise<ScriptLabListing> =>
    call<ScriptLabListing>(() => api.get(`${BASE}/scripts/approved-cases`)),

  /** A Lab case's steps with the test data and Knowledge Base elements they use. */
  getLabCaseSteps: (caseId: number, applicationId?: number | null): Promise<LabCaseSteps> =>
    call<LabCaseSteps>(() => api.get(`${BASE}/lab/cases/${caseId}/steps`, { params: applicationId ? { application_id: applicationId } : {} })),

  /** Save edited steps, case fields and test data; the case stays approved. */
  saveLabCaseSteps: (caseId: number, body: LabCaseStepsSave, applicationId?: number | null): Promise<LabCaseSteps> =>
    call<LabCaseSteps>(() => api.put(`${BASE}/lab/cases/${caseId}/steps`, body, { params: applicationId ? { application_id: applicationId } : {} })),

  /** Compile unsaved steps without saving them: what the script would become. */
  previewLabCaseSteps: (caseId: number, body: LabStepsPreviewIn, applicationId?: number | null): Promise<LabStepsPreview> =>
    call<LabStepsPreview>(() => api.post(`${BASE}/lab/cases/${caseId}/steps/preview`, body, { params: applicationId ? { application_id: applicationId } : {} })),

  generateScripts: (body: {
    case_ids: number[]
    framework: string
    /** Whose discovery catalogue to compile against. */
    application_id?: number | null
    base_url?: string | null
    regenerate?: boolean
  }): Promise<GenerateScriptsResult> =>
    call<GenerateScriptsResult>(() => api.post(`${BASE}/scripts/generate`, body, LONG)),

  getScript: (scriptId: number): Promise<ScriptAsset> =>
    call<ScriptAsset>(() => api.get(`${BASE}/scripts/${scriptId}`)),

  editScript: (scriptId: number, code: string): Promise<ScriptAsset> =>
    call<ScriptAsset>(() => api.patch(`${BASE}/scripts/${scriptId}`, { code })),

  decideScript: (
    scriptId: number,
    decision: 'approve' | 'reject',
    reason?: string | null
  ): Promise<ScriptAsset> =>
    call<ScriptAsset>(() =>
      api.post(`${BASE}/scripts/${scriptId}/decide`, { decision, reason: reason ?? null })
    ),

  /** Execute scripts once through the ordinary run pipeline. */
  dryRunScripts: (body: {
    script_ids: number[]
    environment?: string | null
    base_url?: string | null
    slow_mo_ms?: number | null
    headless?: boolean | null
  }): Promise<DryRunResult> =>
    call<DryRunResult>(() => api.post(`${BASE}/scripts/dry-run`, body, LONG)),

  createDeviceDryRun: async (scriptId: number, headless = true): Promise<CreateDeviceRunResponse> => {
    const response = await call<CreateRunResponse & { runner_token: string; expires_in_minutes: number }>(
      () => api.post(`${BASE}/scripts/${encodeURIComponent(scriptId)}/dry-run-local`, { headless })
    )
    return {
      ...response,
      pairing: makeLocalPairing({
        id: response.run_key, token: response.runner_token,
        endpoint: `${BASE}/local-runner/runs/${encodeURIComponent(response.run_key)}`
      })
    }
  },

  getDryRun: (scriptId: number): Promise<DryRunState> =>
    call<DryRunState>(() => api.get(`${BASE}/scripts/${scriptId}/dry-run`)),

  deleteScripts: (scriptIds: number[]): Promise<{ deleted: number }> =>
    call(() => api.post(`${BASE}/scripts/delete`, { case_ids: scriptIds })),

  /** Both downloads go through axios so the Authorization header travels. */
  downloadScript: async (scriptId: number): Promise<Blob> => {
    try {
      const res = await api.get(`${BASE}/scripts/${scriptId}/download`, { responseType: 'blob' })
      return res.data as Blob
    } catch (err: any) {
      throw new Error(automationError(err))
    }
  },

  /** caseIds narrows the zip to those cases' scripts (one project, or the ticked ones). */
  downloadScriptBundle: async (framework?: string | null, caseIds?: number[] | null): Promise<Blob> => {
    try {
      const params: Record<string, string> = {}
      if (framework) params.framework = framework
      if (caseIds?.length) params.case_ids = caseIds.join(',')
      const res = await api.get(`${BASE}/scripts/download/bundle`, {
        params,
        responseType: 'blob',
        // The bundle is every generated script zipped, so its size is a
        // function of the workbench, not of any one request.
        timeout: LONG_REQUEST_MS
      })
      return res.data as Blob
    } catch (err: any) {
      throw new Error(automationError(err))
    }
  },

  syncScriptsToBitbucket: (
    caseIds: number[],
    framework: string
  ): Promise<BitbucketScriptSyncResult> =>
    call<BitbucketScriptSyncResult>(() =>
      api.post(`${BASE}/scripts/bitbucket-sync`, { case_ids: caseIds, framework }, LONG)
    ),

  // ── Application Discovery and Grounding ────────────────────────────────

  /** Crawl the application. Resolves with the run to poll, not the catalogue. */
  /**
   * Crawl a registered application.
   *
   * The URL and environment are optional because the application already
   * carries both — sending them per crawl is how the registered target and the
   * crawled one drift apart. Pass them only to crawl one application in a
   * different environment.
   */
  startDiscovery: (body: {
    application_id: number
    application_url?: string | null
    application_environment?: string | null
    max_pages?: number
    browser?: 'chrome' | 'chromium'
  }): Promise<DiscoveryRun> =>
    call<DiscoveryRun>(() => api.post(`${BASE}/discovery/run`, body, LONG)),

  /** The same crawl, run by Playwright on this device through the loopback runner. */
  startDeviceDiscovery: async (body: {
    application_id: number
    application_url?: string | null
    application_environment?: string | null
    max_pages?: number
    headless?: boolean
  }): Promise<{ discovery: DiscoveryRun; run_key: string; pairing: string; expires_in_minutes: number }> => {
    const response = await call<{ discovery: DiscoveryRun; run_key: string; runner_token: string; expires_in_minutes: number }>(
      () => api.post(`${BASE}/discovery/run-local`, body)
    )
    return {
      discovery: response.discovery, run_key: response.run_key, expires_in_minutes: response.expires_in_minutes,
      pairing: makeLocalPairing({
        id: response.run_key, token: response.runner_token,
        endpoint: `${BASE}/local-runner/runs/${encodeURIComponent(response.run_key)}`
      })
    }
  },

  /** One application's catalogue state. Folds in a finished crawl on the way. */
  getDiscovery: (applicationId?: number | null): Promise<DiscoveryState> =>
    call<DiscoveryState>(() =>
      api.get(`${BASE}/discovery`, { params: applicationId ? { application_id: applicationId } : {} })
    ),

  listDiscoveredElements: (
    params: { search?: string | null; role?: string | null; applicationId?: number | null } = {}
  ) => {
    const query: Record<string, string | number> = {}
    if (params.search && params.search.trim()) query.search = params.search.trim()
    if (params.role) query.role = params.role
    if (params.applicationId) query.application_id = params.applicationId
    return call<ElementCatalog>(() => api.get(`${BASE}/discovery/elements`, { params: query }))
  },

  /**
   * Discards one application's catalogue and resets the cases it grounded.
   * Scoped — this used to clear every application's discovery data at once.
   */
  deleteDiscovery: (
    applicationId?: number | null
  ): Promise<{
    application_id: number
    discovery_runs_removed: number
    elements_removed: number
    test_cases_reset: number
  }> =>
    call(() =>
      api.delete(`${BASE}/discovery`, {
        params: applicationId ? { application_id: applicationId } : {}
      })
    ),

  /** Match test case steps against the catalogue. Empty list means all of them. */
  groundCases: (caseIds: number[] = [], applicationId?: number | null): Promise<GroundResult> =>
    call<GroundResult>(() =>
      api.post(
        `${BASE}/workbench/ground`,
        {
          case_ids: caseIds,
          application_id: applicationId ?? null
        },
        LONG
      )
    ),

  /* --- Document intake --------------------------------------------------- */

  listIntakeBatches: (): Promise<{ batches: IntakeBatch[] }> =>
    call<{ batches: IntakeBatch[] }>(() => api.get(`${BASE}/intake/batches`)),

  createIntakeBatch: (name: string): Promise<IntakeBatch> =>
    call<IntakeBatch>(() => api.post(`${BASE}/intake/batches`, { name })),

  deleteIntakeBatch: (batchId: number): Promise<{ deleted: boolean; id: number }> =>
    call(() => api.delete(`${BASE}/intake/batches/${batchId}`)),

  /**
   * Upload documents into a batch.
   *
   * Content-Type is cleared, not set: the browser must generate the multipart
   * boundary itself, and the axios instance's default JSON header would
   * override it and make the upload unparseable server-side.
   *
   * The response carries the whole batch rather than just the new documents,
   * so the table re-renders from one call instead of merging state by hand.
   */
  uploadIntakeDocuments: (
    batchId: number,
    files: File[],
    role: IntakeRole
  ): Promise<IntakeUploadResult> => {
    const form = new FormData()
    files.forEach(file => form.append('files', file))
    form.append('role', role)
    return call<IntakeUploadResult>(() =>
      // A slow upload is not a stalled one -- the default 30s is a deadline
      // on someone's connection rather than on the server.
      api.post(`${BASE}/intake/batches/${batchId}/documents`, form, {
        headers: { 'Content-Type': undefined as unknown as string },
        timeout: LONG_REQUEST_MS
      })
    )
  },

  /** Correct what a document is. Becoming 'test_cases' re-reads the original. */
  setIntakeDocumentRole: (documentId: number, role: IntakeRole): Promise<IntakeRoleResult> =>
    call<IntakeRoleResult>(() => api.patch(`${BASE}/intake/documents/${documentId}`, { role })),

  deleteIntakeDocument: (documentId: number): Promise<{ batch: IntakeBatch }> =>
    call<{ batch: IntakeBatch }>(() => api.delete(`${BASE}/intake/documents/${documentId}`)),

  /**
   * Read the batch's test case documents into candidates.
   *
   * Returns the same GenerationJob shape the refine button uses, tracked in the
   * same registry — so progress is polled with getGenerationJob rather than a
   * second polling mechanism that would drift from it.
   */
  extractIntakeTestCases: (batchId: number): Promise<GenerationJob> =>
    call<GenerationJob>(() => api.post(`${BASE}/intake/batches/${batchId}/extract`)),

  /* --- Registered applications ------------------------------------------- */

  /**
   * Every registered application, each with its Knowledge Base link and the
   * state of its own discovery catalogue.
   */
  listApplications: (
    includeInactive = false
  ): Promise<{ applications: RegisteredApplication[]; total: number }> =>
    call(() =>
      api.get(`${BASE}/applications`, {
        params: includeInactive ? { include_inactive: true } : {}
      })
    ),

  getApplication: (applicationId: number): Promise<RegisteredApplication> =>
    call<RegisteredApplication>(() => api.get(`${BASE}/applications/${applicationId}`)),

  createApplication: (body: {
    name: string
    app_key: string
    base_url: string
    environment?: string
    description?: string | null
    is_active?: boolean
  }): Promise<RegisteredApplication> =>
    call<RegisteredApplication>(() => api.post(`${BASE}/applications`, body)),

  updateApplication: (
    applicationId: number,
    body: Partial<{
      name: string
      base_url: string
      environment: string
      description: string | null
      is_active: boolean
    }>
  ): Promise<RegisteredApplication> =>
    call<RegisteredApplication>(() => api.patch(`${BASE}/applications/${applicationId}`, body)),

  deleteApplication: (applicationId: number): Promise<{ deleted: boolean; id: number }> =>
    call(() => api.delete(`${BASE}/applications/${applicationId}`)),

  /**
   * Write Knowledge Base files from this application's current crawl.
   *
   * The seam between the two halves of the Discovery screen: the crawler fills
   * a database with elements, the Knowledge Base is files, and this carries
   * what a crawl can honestly state from one to the other. An existing
   * app_profile.json is left alone unless `overwriteProfile` is passed — it is
   * what every model and grounding rule compiles from.
   */
  /**
   * Write Knowledge Base files from an application's current crawl.
   *
   * `synthesise` asks a model to classify the crawl into the keys the model
   * compiler reads -- url_templates, endpoints, named selector groups,
   * grounding rules -- rather than leaving them blank for a person to type.
   * Every proposal is validated back against the crawl server-side, so a
   * selector it never verified never reaches the file; turning it off yields
   * the plain structural draft.
   */
  draftKnowledgeBase: (
    applicationId: number,
    overwriteProfile = false,
    synthesise = true
  ): Promise<KnowledgeBaseDraftResult> =>
    call<KnowledgeBaseDraftResult>(() =>
      api.post(
        `${BASE}/applications/${applicationId}/knowledge-base/draft`,
        {
          overwrite_profile: overwriteProfile,
          synthesise
        },
        LONG
      )
    ),

  // ── Knowledge Base & Application Model ─────────────────────────────────

  getKnowledgeBaseApplications: (): Promise<{ applications: any[]; total: number }> =>
    call(() => api.get(`${BASE}/knowledge-base/applications`)),

  getApplicationFlows: (appId: string): Promise<{ app_id: string; profile: any; flows: any[]; total: number }> =>
    call(() => api.get(`${BASE}/knowledge-base/applications/${encodeURIComponent(appId)}/flows`)),

  /**
   * The compiled Application Model for one Knowledge Base application.
   *
   * There is no client-side fallback compiler any more. The one that lived
   * here re-derived the model from raw flows with eand.ae URLs and selectors
   * written into the TypeScript — so when the real endpoint failed, the screen
   * quietly rendered another company's routes as though they were this
   * application's. A failure is now a failure, and the caller shows it.
   */
  /** URLs are built on `environment`'s address in Test Data (else the application's default). */
  getApplicationModel: (appKey: string, environment?: string | null): Promise<any> =>
    call(() => api.get(`${BASE}/knowledge-base/applications/${encodeURIComponent(appKey)}/model`, {
      params: environment ? { environment } : undefined
    })),

  exportApplicationModelJson: async (appKey: string, environment?: string | null): Promise<Blob> => {
    const res = await api.get(
      `${BASE}/knowledge-base/applications/${encodeURIComponent(appKey)}/model/export`,
      { responseType: 'blob', params: environment ? { environment } : undefined }
    )
    return res.data as Blob
  }
}

export default automationService
