import api from './api'

// Projects (PPM ID + name) and the generation sessions saved under them.

export interface Project {
  id: number
  ppm_id: string
  name: string
  created_by?: string | null
  created_at?: string | null
  /** Set by create: true when the PPM ID already existed and was opened instead. */
  existing?: boolean
}

export type SessionStage = 'generated' | 'ai_checks' | 'partly_sent' | 'sent'

export interface SessionSummary {
  request_id: string
  project: Project | null
  document_name: string
  source_group: string
  input_type: string | null
  knowledge_base_label: string | null
  request_by: string
  request_date_time: string | null
  overall_status: string
  stage: SessionStage
  cases: number
  draft: number
  pending: number
  approved: number
  rejected: number
  ai_batch_id: string | null
  checks: { total: number; done: number; failed: number; stopped: number; running: number } | null
  restorable: boolean
}

/** What the Test Cases page saves to reopen a session. */
export interface GenerationSnapshot {
  output?: string
  input_type?: string
  knowledge_base?: string
  knowledge_base_label?: string
  environment?: string
  focus?: string
  document_text?: string
  document_names?: string[]
  text_input?: string
  ppm_id?: string
  stopped?: boolean
  /** The application(s) chosen on Generate Test Cases (Test Data applications). */
  applications?: { id: number; name: string }[]
}

export interface SessionDetail extends SessionSummary {
  generation: GenerationSnapshot
  brd_document: { name?: string }[] | null
  /** `application`: the chosen application the case is linked to, null when unassigned. */
  rows: { test_case_id: string; display_id: string; status: string; application?: string | null }[]
}

const projectService = {
  list: async (q?: string): Promise<Project[]> =>
    (await api.get('/projects', { params: { q: q || undefined, limit: 50 } })).data.items,
  get: async (id: number): Promise<Project> => (await api.get(`/projects/${id}`)).data,
  byPpm: async (ppmId: string): Promise<Project | null> => {
    try {
      return (await api.get(`/projects/by-ppm/${encodeURIComponent(ppmId)}`)).data
    } catch (error: any) {
      if (error?.response?.status === 404) return null
      throw error
    }
  },
  createOrOpen: async (ppmId: string, name: string): Promise<Project> =>
    (await api.post('/projects', { ppm_id: ppmId, name })).data,
  /** Correct a project's name; its PPM ID stays. */
  rename: async (id: number, ppmId: string, name: string): Promise<Project> =>
    (await api.put(`/projects/${id}`, { ppm_id: ppmId, name })).data,

  sessions: async (params: { projectId?: number | null; mine?: boolean; open?: boolean; limit?: number }): Promise<SessionSummary[]> =>
    (await api.get('/test-case-reviews/sessions', {
      params: {
        project_id: params.projectId || undefined,
        mine: params.mine || undefined,
        open: params.open || undefined,
        limit: params.limit ?? 20
      }
    })).data.items,
  session: async (requestId: string): Promise<SessionDetail> =>
    (await api.get(`/test-case-reviews/sessions/${encodeURIComponent(requestId)}`)).data,
  updateSession: async (requestId: string, body: { generation?: GenerationSnapshot; project_id?: number | null }) => {
    await api.patch(`/test-case-reviews/saved/${encodeURIComponent(requestId)}`, body)
  }
}

export const projectLabel = (project: Pick<Project, 'ppm_id' | 'name'> | null | undefined) =>
  project ? `${project.ppm_id} · ${project.name}` : ''

export default projectService
