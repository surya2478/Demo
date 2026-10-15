import api from './api'
import type { Project } from './projectService'

/**
 * Bitbucket sync service
 *
 * This client follows the existing pattern used in reviewService and
 * automationService: a thin wrapper over backend endpoints that exposes
 * typed helpers to the UI. The backend is expected to provide endpoints
 * that accept a review request and its test cases and persist them into
 * Bitbucket (one file per test case, or another mapping), using runtime
 * configuration for proxy / direct connectivity.
 */

export interface BitbucketSyncConfigSummary {
  /** Which Bitbucket configuration was applied (e.g. "direct" or "proxy"). */
  profile: string
  /** Repository slug the cases were written to. */
  repo_slug: string
  /** Branch used for commits. */
  branch: string
}

export interface BitbucketSyncResult {
  request_id: string
  project: Project | null
  /** Number of test cases sent to Bitbucket for this request. */
  synced_cases: number
  /** Per-case status keyed by test_case_id. */
  cases: Record<string, { path: string; committed: boolean; error?: string | null }>
  /** Summary of the Bitbucket configuration applied server-side. */
  config: BitbucketSyncConfigSummary
}

/**
 * Payload sent to the backend when syncing after review.
 * The backend owns the actual Bitbucket API calls and proxy handling;
 * the frontend only passes identifiers and lets the server decide how
 * to route each case based on project metadata.
 */
export interface BitbucketSyncRequestBody {
  request_id: string
  project_id: number | null
  /**
   * The profile name corresponds to a server-side Bitbucket config
   * (for example, "direct" vs "proxy"). When omitted, the backend
   * applies its default.
   */
  profile?: string | null
  /** Optional explicit repo slug override; often left undefined so the
   * server maps from the project or request metadata.
   */
  repo_slug?: string | null
}

const bitbucketSyncService = {
  /**
   * Trigger Bitbucket sync for a reviewed request.
   *
   * The backend should expose an endpoint like
   *   POST /test-case-reviews/detail/{request_id}/bitbucket-sync
   * which:
   *   - looks up the request and its test cases,
   *   - determines the related Bitbucket repository from the project,
   *   - applies proxy / direct config based on the selected profile,
   *   - and commits the cases into Bitbucket.
   */
  syncRequest: async (body: BitbucketSyncRequestBody): Promise<BitbucketSyncResult> => {
    const res = await api.post(
      `/test-case-reviews/detail/${encodeURIComponent(body.request_id)}/bitbucket-sync`,
      body
    )
    return res.data as BitbucketSyncResult
  }
}

export default bitbucketSyncService
