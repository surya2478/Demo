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
  RunDetail,
  RuntimeStatusResponse,
  RunsResponse,
  Verdict
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
  }
}

export default automationService
