import api, { LONG_REQUEST_MS } from './api'

// Katalon Import: the QA team's Katalon exports -> findings, a draft Automation KB,
// a manual test case per data row, and Playwright/Katalon scripts from the same steps.

const BASE = '/automation/katalon-import'

export type Severity = 'high' | 'medium' | 'info'
export type CaseStatus = 'ready' | 'incomplete' | 'excluded'

export interface ImportFile {
  path: string
  kind: 'converter_md' | 'object_repository' | 'test_data' | 'keywords' | 'profile' | 'scripts' | null
  size: number
  from: string
  note?: string
}

export interface ImportMeta {
  id: string
  name: string
  created_by?: string | null
  created_at: string
  updated_at: string
  status: 'empty' | 'uploaded' | 'analysed' | 'failed'
  app_key?: string | null
  app_name?: string | null
  files: ImportFile[]
  change_sets?: { id: number; app_key: string; at: string; by?: string | null }[]
  error?: string | null
}

export interface ImportBrief {
  id: string
  name: string
  created_by?: string | null
  created_at: string
  updated_at: string
  status: ImportMeta['status']
  app_key?: string | null
  files: number
  summary?: Summary | null
}

export interface Summary {
  findings: Partial<Record<Severity, number>>
  test_cases: number
  components: number
  steps: number
  locators: number
  locators_with_issues: number
  db_steps: number
  rows: number
  cases: Partial<Record<CaseStatus, number>>
}

export interface Finding {
  id: string
  severity: Severity
  category: string
  title: string
  detail: string
  action: string
  refs?: string[]
}

export interface LocatorIssue { code: string; text: string; severity: Severity }

export interface LocatorRow {
  path: string
  label: string
  xpath?: string | null
  method?: string | null
  params: string[]
  source?: string | null
  used_by: string[]
  uses: number
  issues: LocatorIssue[]
  status: string
}

export interface DbStep {
  id: string
  component: string
  type: 'db_prep' | 'db_check'
  name: string
  keyword?: string | null
  statements: string[]
  systems: { variable: string; host?: string; port?: string; service?: string; type?: string }[]
  source_known: boolean
  count_guard_missing: boolean
}

export interface Analysis {
  checklist: { key: string; label: string; why: string; present: boolean; count: number }[]
  findings: Finding[]
  summary: Summary
  locators: LocatorRow[]
  db_steps: DbStep[]
  data: { name: string; columns: string[]; rows: number; distribution: Record<string, Record<string, number>>; sensitive_columns: string[] }[]
  environment: {
    app_url?: string | null
    env?: string | null
    grid?: string | null
    systems: { variable: string; host?: string; port?: string; service?: string; type?: string }[]
    settings: Record<string, string>
  }
}

export interface Condition {
  id: string
  kind: string
  text: string
  label?: string
  target?: string | null
  expr?: string
}

export interface ModelStep {
  id: string
  source?: string | null
  type: string
  action: string
  expected?: string
  target?: string | null
  object?: string | null
  label?: string
  conds: string[]
  via?: string | null
  keyword?: string | null
  note?: string | null
}

export interface Component {
  id: string
  name: string
  katalon?: { type: string; ref: string } | null
  source?: string | null
  steps: ModelStep[]
  gaps: { expr: string; steps_skipped: number }[]
  when: string[]
  requires: string
  leaves: string
}

export interface Model {
  components: Component[]
  flow: { component: string; when: string[] }[]
  conditions: Record<string, Condition>
  test_case: { title: string; katalon_test_case?: string | null; data_sheet?: string | null; data_key?: string | null; file?: string; format?: string }
  data: { table?: string | null; key_column?: string | null; rows: number }
}

export interface CaseBrief {
  case_id: string
  title: string
  status: CaseStatus
  problems: { severity: Severity; component?: string | null; text: string }[]
  model: number
  steps: number
}

export interface ImportResult {
  generated_at: string
  analysis: Analysis
  models: Model[]
  kb: Record<string, any>
  cases: CaseBrief[]
  suggested: { app_key: string; app_name: string }
  exports?: { file: string; role: 'primary' | 'branch_source' | 'superseded'; data_key?: string | null; test_case: string; branches: { expr: string; steps: number }[] }[]
}

export interface ImportDetail {
  meta: ImportMeta
  result: ImportResult | null
}

export interface ManualStep {
  n: number
  component: string
  key: string
  source?: string | null
  when: string[]
  action: string
  data: string
  expected: string
  type: string
  target?: string | null
}

export interface Conformance {
  framework: 'playwright' | 'katalon'
  ok: boolean
  tc_steps: number
  script_steps: number
  issues: { n: number | null; key: string | null; problem: string }[]
}

export interface CaseDetail {
  case_id: string
  title: string
  status: CaseStatus
  problems: CaseBrief['problems']
  row: Record<string, string>
  steps: ManualStep[]
  scripts: { playwright: string; katalon: string }
  conformance: { playwright: Conformance; katalon: Conformance }
}

const download = async (path: string, filename: string, params?: Record<string, string>) => {
  const response = await api.get(`${BASE}${path}`, { responseType: 'blob', params, timeout: LONG_REQUEST_MS })
  const url = URL.createObjectURL(response.data)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

const katalonImportService = {
  list: async (): Promise<ImportBrief[]> => (await api.get(`${BASE}/imports`)).data.items,
  create: async (name: string): Promise<ImportMeta> => (await api.post(`${BASE}/imports`, { name })).data,
  get: async (id: string): Promise<ImportDetail> => (await api.get(`${BASE}/imports/${id}`)).data,
  update: async (id: string, body: { name?: string; app_key?: string; app_name?: string }): Promise<ImportDetail> =>
    (await api.patch(`${BASE}/imports/${id}`, body, { timeout: LONG_REQUEST_MS })).data,
  remove: async (id: string) => (await api.delete(`${BASE}/imports/${id}`)).data,
  upload: async (id: string, files: File[], onProgress?: (percent: number) => void): Promise<ImportDetail> => {
    const form = new FormData()
    files.forEach((f) => form.append('files', f))
    return (await api.post(`${BASE}/imports/${id}/files`, form, {
      timeout: LONG_REQUEST_MS,
      onUploadProgress: (e) => { if (onProgress && e.total) onProgress(Math.round((100 * e.loaded) / e.total)) },
    })).data
  },
  removeFile: async (id: string, path: string): Promise<ImportDetail> =>
    (await api.delete(`${BASE}/imports/${id}/files`, { params: { path }, timeout: LONG_REQUEST_MS })).data,
  analyse: async (id: string): Promise<ImportDetail> => (await api.post(`${BASE}/imports/${id}/analyse`, {}, { timeout: LONG_REQUEST_MS })).data,
  caseDetail: async (id: string, caseId: string): Promise<CaseDetail> =>
    (await api.get(`${BASE}/imports/${id}/cases/${encodeURIComponent(caseId)}`)).data,
  checkScript: async (id: string, caseId: string, framework: 'playwright' | 'katalon', script: string): Promise<Conformance> =>
    (await api.post(`${BASE}/imports/${id}/cases/${encodeURIComponent(caseId)}/conformance`, { framework, script })).data,
  draftChangeSet: async (id: string, appKey: string, appName: string): Promise<{ change_set_id: number; app_key: string }> =>
    (await api.post(`${BASE}/imports/${id}/kb-change-set`, { app_key: appKey, app_name: appName }, { timeout: LONG_REQUEST_MS })).data,
  approveChangeSet: async (changeSetId: number, note?: string) =>
    (await api.post(`/automation/knowledge-base/change-sets/${changeSetId}/approve`, { note: note || null })).data,
  downloadKb: (id: string, appKey: string) => download(`/imports/${id}/download/kb.zip`, `${appKey}-automation-kb.zip`),
  downloadCases: (id: string, status: string, ids?: string[]) =>
    download(`/imports/${id}/download/test-cases.xlsx`, `${id}-test-cases.xlsx`, ids?.length ? { ids: ids.join(',') } : { status }),
  downloadScripts: (id: string, status: string, frameworks: string[], ids?: string[]) =>
    download(`/imports/${id}/download/scripts.zip`, `${id}-scripts.zip`,
      { frameworks: frameworks.join(','), ...(ids?.length ? { ids: ids.join(',') } : { status }) }),
  downloadReport: (id: string) => download(`/imports/${id}/download/report.md`, `${id}-report.md`),
}

export default katalonImportService
