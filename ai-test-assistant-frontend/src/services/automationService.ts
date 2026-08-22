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
  CandidatesResponse,
  CreateRunRequest,
  CreateRunResponse,
  ImportResult,
  LlmStatus,
  ManualCaseInput,
  Classification,
  DecideResult,
  GenerationJob,
  RefineResult,
  RunDetail,
  RuntimeStatusResponse,
  RunsResponse,
  StudioCase,
  Verdict,
  WorkbenchCase,
  WorkbenchGrid,
  WorkbenchSource,
  DryRunResult,
  DryRunState,
  FrameworkInfo,
  GenerateScriptsResult,
  ScriptAsset,
  ScriptLabListing
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

export interface CandidateFilters {
  source?: 'all' | 'approved' | 'manual'
  verdict?: Verdict | null
  search?: string | null
}

const automationService = {
  /**
   * Whether this deployment can execute a browser test right now.
   * Called on load so a missing toolchain is visible before anyone clicks Run.
   */
  getRuntime: (): Promise<RuntimeStatusResponse> =>
    call<RuntimeStatusResponse>(() => api.get(`${BASE}/runtime`)),

  listCandidates: (filters: CandidateFilters = {}): Promise<CandidatesResponse> => {
    const params: Record<string, string> = {}
    if (filters.source && filters.source !== 'all') params.source = filters.source
    if (filters.verdict) params.verdict = filters.verdict
    if (filters.search && filters.search.trim()) params.search = filters.search.trim()
    return call<CandidatesResponse>(() => api.get(`${BASE}/candidates`, { params }))
  },

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

  // ── Intake and refinement ──────────────────────────────────────────────

  /** Whether refinement could run right now, and through which provider. */
  getLlmStatus: (): Promise<LlmStatus> => call<LlmStatus>(() => api.get(`${BASE}/llm`)),

  createCase: (body: ManualCaseInput): Promise<StudioCase> =>
    call<StudioCase>(() => api.post(`${BASE}/candidates`, body)),

  getCase: (caseId: number): Promise<StudioCase> =>
    call<StudioCase>(() => api.get(`${BASE}/candidates/manual/${caseId}`)),

  updateCase: (caseId: number, body: ManualCaseInput): Promise<StudioCase> =>
    call<StudioCase>(() => api.put(`${BASE}/candidates/manual/${caseId}`, body)),

  deleteCase: (caseId: number): Promise<void> =>
    call<void>(() => api.delete(`${BASE}/candidates/manual/${caseId}`)),

  /**
   * Bulk intake from a CSV file.
   *
   * Content-Type is deleted rather than set: the browser has to generate the
   * multipart boundary itself, and the axios instance's default JSON header
   * would override it and make the upload unparseable server-side.
   */
  importCases: (file: File): Promise<ImportResult> => {
    const form = new FormData()
    form.append('file', file)
    return call<ImportResult>(() =>
      api.post(`${BASE}/candidates/import`, form, {
        headers: { 'Content-Type': undefined as unknown as string }
      })
    )
  },

  /**
   * Rewrite a case into automation-ready form.
   *
   * Returns both sides: the rewrite is a model judgement and lands as a new
   * row rather than overwriting, so it can be compared before it is trusted.
   */
  refineCase: (
    caseId: number,
    body: {
      application_url?: string | null
      application_name?: string | null
      requirement?: string | null
    } = {}
  ): Promise<RefineResult> =>
    call<RefineResult>(() => api.post(`${BASE}/candidates/manual/${caseId}/refine`, body)),

  /**
   * Split a pasted test case into fields.
   *
   * Deliberately deterministic and local: pasting is the fastest way in, and
   * spending an LLM call to parse text a label already delimits would be slow,
   * costly and less predictable than matching the labels. Anything it cannot
   * attribute to a section becomes the steps, which is the field a reviewer is
   * most likely to correct anyway.
   */
  parsePastedCase: (text: string): ManualCaseInput => {
    const SECTIONS: Array<[keyof ManualCaseInput, RegExp]> = [
      ['display_id', /^\s*(?:test\s*case\s*(?:id|no|number)|tc\s*id|id|ref)\s*[:\-]\s*(.*)$/i],
      ['category', /^\s*(?:category|module|feature|area)\s*[:\-]\s*(.*)$/i],
      ['description', /^\s*(?:description|test\s*case\s*description|summary|title|objective)\s*[:\-]\s*(.*)$/i],
      ['preconditions', /^\s*(?:pre-?conditions?|pre-?requisites?|setup)\s*[:\-]\s*(.*)$/i],
      ['steps_raw', /^\s*(?:test\s*steps|steps|procedure|actions?)\s*[:\-]\s*(.*)$/i],
      ['test_data', /^\s*(?:test\s*data|data|inputs?)\s*[:\-]\s*(.*)$/i],
      ['expected_result', /^\s*(?:expected\s*(?:result|outcome|behaviou?r)?|expected)\s*[:\-]\s*(.*)$/i]
    ]

    const out: Record<string, string[]> = {}
    let current: keyof ManualCaseInput | null = null

    for (const line of (text || '').split(/\r?\n/)) {
      let matched = false
      for (const [field, pattern] of SECTIONS) {
        const m = line.match(pattern)
        if (m) {
          current = field
          out[field] = out[field] ?? []
          if (m[1]?.trim()) out[field].push(m[1].trim())
          matched = true
          break
        }
      }
      if (matched) continue
      if (!line.trim()) continue
      // Unlabelled content before any heading is most useful as steps.
      const target = current ?? 'steps_raw'
      out[target] = out[target] ?? []
      out[target].push(line.trim())
    }

    const join = (field: string) => {
      const value = (out[field] ?? []).join('\n').trim()
      return value || null
    }

    return {
      display_id: (join('display_id') ?? '').slice(0, 100),
      category: join('category'),
      description: join('description'),
      preconditions: join('preconditions'),
      steps_raw: join('steps_raw'),
      test_data: join('test_data'),
      expected_result: join('expected_result')
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
    }>
  ): Promise<WorkbenchCase> =>
    call<WorkbenchCase>(() => api.patch(`${BASE}/workbench/test-cases/${caseId}`, body)),

  deleteWorkbenchCases: (
    caseIds: number[]
  ): Promise<{ deleted: number; scripts_removed: number }> =>
    call(() => api.post(`${BASE}/workbench/delete`, { case_ids: caseIds })),

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
  }
}

export default automationService
