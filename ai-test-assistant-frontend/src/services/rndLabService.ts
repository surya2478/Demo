import api, { LONG_REQUEST_MS } from './api'

// AI R&D Lab: per project, map approved automation cases against their BRD,
// design (Figma), the Journey KB and the generated script.

export type CellStatus = 'mapped' | 'weak' | 'missing' | 'conflict' | 'unverified' | 'na' | 'pending'

export interface EvidenceCell {
  status: CellStatus
  ref?: string | null
  evidence?: string | null
  note?: string | null
  source?: 'rules' | 'ai'
  /** What the rules pass said, when the AI changed it. */
  rules?: CellStatus
}

export interface MatrixRow {
  step_number: number
  action: string
  target?: string | null
  expected_result: string
  test_data_ref?: string | null
  requirement: EvidenceCell
  design?: EvidenceCell
  kb: EvidenceCell
  script_action: EvidenceCell
  assertion: EvidenceCell
}

export type GapModule = 'script_lab' | 'workbench' | 'knowledge_base' | 'test_data' | null

export interface Gap {
  type: string
  label: string
  severity: 'high' | 'medium' | 'info'
  step_number?: number | null
  detail: string
  action: string
  module?: GapModule
}

export interface ScriptBrief {
  id: number
  framework: string
  file_name: string
  status: string
  version: number
  dry_run: string
}

export interface LabCase {
  id: number
  display_id: string
  title: string
  priority?: string | null
  steps: number
  project_id: number | null
  request_id?: string | null
  has_brd: boolean
  script: ScriptBrief | null
}

export interface StudyDocument {
  id: number
  role: string
  origin: 'linked' | 'upload'
  origin_request_id?: string | null
  filename: string
  file_type?: string | null
  size_bytes?: number | null
  page_count?: number | null
  text_chars?: number | null
  status: 'stored' | 'extracting' | 'ready' | 'failed'
  notes: string[]
  error?: string | null
  created_at?: string | null
}

export interface Requirement {
  id: string
  statement: string
  quote: string
  kind: string
  doc: string
  page?: number | null
  verified: boolean
  method: 'rules' | 'ai'
  covered_by: string[]
}

export interface StudyBrief {
  id: number
  name: string
  project_id: number
  ppm_id?: string | null
  project_name?: string | null
  kb_app_id?: string | null
  has_design: boolean
  case_ids?: number[] | null
  status: 'draft' | 'analysing' | 'ready' | 'failed' | 'interrupted'
  progress?: { phase: string; done: number; total: number; message: string } | null
  error?: string | null
  created_by?: string | null
  created_at?: string | null
  analysed_at?: string | null
  cases?: number | null
  avg_readiness?: number | null
}

export interface StudySummary {
  cases: number
  avg_readiness: number
  verdicts: Record<string, number>
  gaps: Record<string, number>
  cells: Record<string, Record<string, number>>
  requirements: { total: number; covered: number; method: string | null }
  sources: { documents: number; brd: number; design: number; kb?: string | null; kb_elements: number }
  use_ai: boolean
  notes: string[]
}

export interface StudyCaseRow {
  test_case_id: number
  display_id: string
  title: string
  readiness: number | null
  verdict: string | null
  method: string | null
  steps: number
  gaps: number
  high_gaps: number
  script: ScriptBrief | null
  error?: string | null
}

export interface StudyDetail extends StudyBrief {
  summary: StudySummary | null
  requirements: Requirement[]
  documents: StudyDocument[]
  case_rows: StudyCaseRow[]
  work: (Gap & { test_case_id: number; display_id: string })[]
}

export interface CaseMap {
  test_case_id: number
  display_id: string
  title: string
  readiness: number | null
  verdict: string | null
  method: string | null
  matrix: MatrixRow[]
  gaps: Gap[]
  script: ScriptBrief | null
  error?: string | null
}

export interface LabStatus {
  enabled: boolean
  llm: { provider?: string; configured?: boolean; detail?: string; error?: string }
  vision_available: boolean
  max_upload_mb: number
  roles: string[]
}

const rndLabService = {
  status: async (): Promise<LabStatus> => (await api.get('/rnd-lab/status')).data,
  kbApps: async (): Promise<{ app_id: string; app_name: string }[]> => (await api.get('/rnd-lab/kb-apps')).data.items,
  projectCases: async (projectId: number, includeUnassigned = false): Promise<LabCase[]> =>
    (await api.get(`/rnd-lab/projects/${projectId}/cases`, { params: { include_unassigned: includeUnassigned } })).data.items,
  studies: async (projectId: number): Promise<StudyBrief[]> =>
    (await api.get('/rnd-lab/studies', { params: { project_id: projectId } })).data.items,
  createStudy: async (body: { project_id: number; name: string; kb_app_id?: string | null; case_ids?: number[] | null; has_design: boolean }): Promise<StudyBrief> =>
    (await api.post('/rnd-lab/studies', body)).data,
  study: async (id: number): Promise<StudyDetail> => (await api.get(`/rnd-lab/studies/${id}`)).data,
  updateStudy: async (id: number, body: Partial<{ name: string; kb_app_id: string | null; case_ids: number[]; has_design: boolean; clear_case_ids: boolean }>): Promise<StudyBrief> =>
    (await api.patch(`/rnd-lab/studies/${id}`, body)).data,
  deleteStudy: async (id: number) => (await api.delete(`/rnd-lab/studies/${id}`)).data,
  caseMap: async (studyId: number, caseId: number): Promise<CaseMap> =>
    (await api.get(`/rnd-lab/studies/${studyId}/cases/${caseId}`)).data,
  upload: async (studyId: number, role: string, file: File, onProgress?: (percent: number) => void): Promise<StudyDocument> => {
    const form = new FormData()
    form.append('role', role)
    form.append('file', file)
    // A 25MB design takes a while to send; the reading itself is a background job.
    return (await api.post(`/rnd-lab/studies/${studyId}/documents`, form, {
      timeout: LONG_REQUEST_MS,
      onUploadProgress: (e) => { if (onProgress && e.total) onProgress(Math.round((100 * e.loaded) / e.total)) },
    })).data
  },
  retryDocument: async (studyId: number, docId: number) => (await api.post(`/rnd-lab/studies/${studyId}/documents/${docId}/retry`)).data,
  deleteDocument: async (studyId: number, docId: number) => (await api.delete(`/rnd-lab/studies/${studyId}/documents/${docId}`)).data,
  analyse: async (studyId: number, useAi: boolean): Promise<StudyBrief> =>
    (await api.post(`/rnd-lab/studies/${studyId}/analyse`, { use_ai: useAi })).data,
  downloadGaps: async (studyId: number, filename: string) => {
    const response = await api.get(`/rnd-lab/studies/${studyId}/gaps.csv`, { responseType: 'blob' })
    const url = URL.createObjectURL(response.data)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  },
}

export default rndLabService
