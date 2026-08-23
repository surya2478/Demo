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
import api from './api'
import type {
  ApprovedCandidateDetail,
  ArtifactKind,
  CreateRunRequest,
  CreateRunResponse,
  Classification,
  DecideResult,
  GenerationJob,
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
  DiscoveredElement,
  DiscoveryRun,
  IntakeBatch,
  IntakeRole,
  IntakeRoleResult,
  IntakeUploadResult,
  DiscoveryState,
  HealRunResponse,
  ElementCatalog,
  GroundResult,
  RecordedFlowObject,
  CaseReviewResult
} from '../types/automation'

const BASE = '/automation'

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

  listRuns: (limit = 50): Promise<RunsResponse> =>
    call<RunsResponse>(() => api.get(`${BASE}/runs`, { params: { limit } })),

  getRun: (runKey: string): Promise<RunDetail> =>
    call<RunDetail>(() => api.get(`${BASE}/runs/${encodeURIComponent(runKey)}`)),

  cancelRun: (runKey: string): Promise<{ run_key: string; cancelling: boolean }> =>
    call(() => api.post(`${BASE}/runs/${encodeURIComponent(runKey)}/cancel`)),

  deleteRuns: (runKeys: string[]): Promise<{ deleted: number }> =>
    call(() => api.post(`${BASE}/runs/delete`, { run_keys: runKeys })),

  deleteRun: (runKey: string): Promise<{ deleted: number }> =>
    call(() => api.delete(`${BASE}/runs/${encodeURIComponent(runKey)}`)),

  healRun: (runKey: string): Promise<HealRunResponse> =>
    call(() => api.post(`${BASE}/runs/${encodeURIComponent(runKey)}/heal`)),

  healScript: (scriptId: number): Promise<HealRunResponse> =>
    call(() => api.post(`${BASE}/scripts/${scriptId}/heal`)),

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
  classifyCases: (
    caseIds: number[],
    classification?: Classification
  ): Promise<{ updated: number; test_cases: WorkbenchCase[] }> =>
    call(() =>
      api.post(`${BASE}/workbench/classify`, {
        case_ids: caseIds,
        ...(classification ? { classification } : {})
      })
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
    call<CaseReviewResult>(() => api.post(`${BASE}/workbench/test-cases/${caseId}/review`)),

  reviewAllTestCases: (): Promise<{ reviewed_count: number; reviews: CaseReviewResult[] }> =>
    call(() => api.post(`${BASE}/workbench/test-cases/review-all`)),

  autoImproveTestCase: (
    caseId: number
  ): Promise<{ case_id: number; display_id: string; improved: boolean; review: CaseReviewResult }> =>
    call(() => api.post(`${BASE}/workbench/test-cases/${caseId}/auto-improve`)),

  // ── On-Demand In-Place Refinement ────────────────────────────────────

  refineTestCase: (
    caseId: number,
    options?: { application_url?: string }
  ): Promise<WorkbenchCase> =>
    call<WorkbenchCase>(() => api.post(`${BASE}/workbench/test-cases/${caseId}/refine`, options || {})),

  refineBulkTestCases: (
    caseIds: number[],
    applicationUrl?: string
  ): Promise<{ refined_count: number; test_cases: WorkbenchCase[] }> =>
    call(() =>
      api.post(`${BASE}/workbench/test-cases/refine-bulk`, {
        case_ids: caseIds,
        application_url: applicationUrl
      })
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

  generateScripts: (body: {
    case_ids: number[]
    framework: string
    base_url?: string | null
    regenerate?: boolean
  }): Promise<GenerateScriptsResult> =>
    call<GenerateScriptsResult>(() => api.post(`${BASE}/scripts/generate`, body)),

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
    call<DryRunResult>(() => api.post(`${BASE}/scripts/dry-run`, body)),

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

  downloadScriptBundle: async (framework?: string | null): Promise<Blob> => {
    try {
      const res = await api.get(`${BASE}/scripts/download/bundle`, {
        params: framework ? { framework } : {},
        responseType: 'blob'
      })
      return res.data as Blob
    } catch (err: any) {
      throw new Error(automationError(err))
    }
  },

  // ── Application Discovery and Grounding ────────────────────────────────

  /** Crawl the application. Resolves with the run to poll, not the catalogue. */
  startDiscovery: (body: {
    application_url: string
    application_environment?: string | null
    application_id?: number | null
    max_pages?: number
  }): Promise<DiscoveryRun> =>
    call<DiscoveryRun>(() => api.post(`${BASE}/discovery/run`, body)),

  /** Current catalogue state. Folds in a finished crawl on the way. */
  getDiscovery: (): Promise<DiscoveryState> =>
    call<DiscoveryState>(() => api.get(`${BASE}/discovery`)),

  listDiscoveredElements: (params: { search?: string | null; role?: string | null } = {}) => {
    const query: Record<string, string> = {}
    if (params.search && params.search.trim()) query.search = params.search.trim()
    if (params.role) query.role = params.role
    return call<ElementCatalog>(() => api.get(`${BASE}/discovery/elements`, { params: query }))
  },

  /** Discards the catalogue and resets every case grounded against it. */
  deleteDiscovery: (): Promise<{
    discovery_runs_removed: number
    elements_removed: number
    test_cases_reset: number
  }> => call(() => api.delete(`${BASE}/discovery`)),

  /** Match test case steps against the catalogue. Empty list means all of them. */
  groundCases: (caseIds: number[] = []): Promise<GroundResult> =>
    call<GroundResult>(() => api.post(`${BASE}/workbench/ground`, { case_ids: caseIds })),

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
      api.post(`${BASE}/intake/batches/${batchId}/documents`, form, {
        headers: { 'Content-Type': undefined as unknown as string }
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
    call<GenerationJob>(() => api.post(`${BASE}/intake/batches/${batchId}/extract`))
}

export default automationService
