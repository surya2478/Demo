import api from './api'

// AI Test Automation > Test Data: the values generated scripts read from
// TESTDATA_* (usernames, passwords, OTPs, record names), per application and
// environment -- the one data source for automation test cases, which the
// Knowledge Base's data profiles are checked against. Secret values are
// encrypted by the server and never returned.

export const ALL_ENVIRONMENTS = '*'

// How an environment is shown. Stored names are upper case (SIT, RC,
// PREPRODUCTION); this matches the Generate Test Cases dropdown's labels.
const ENVIRONMENT_LABELS: Record<string, string> = { [ALL_ENVIRONMENTS]: 'All environments', PREPRODUCTION: 'Preproduction' }
export const environmentLabel = (env: string | null | undefined) => (env ? ENVIRONMENT_LABELS[env.toUpperCase()] ?? env : '')

export interface TestDataEntry {
  id: number
  environment: string
  key: string
  /** null for a secret: the server never sends one back. */
  value: string | null
  has_value: boolean
  is_secret: boolean
  aliases: string
  updated_by: string | null
  updated_at: string | null
}

export interface DataApp {
  id: number
  name: string
  kb_app_id: string | null
  url_prefix: string | null
  /** The environment its scripts run against and read values for. */
  run_environment: string
  created_by: string | null
  entries: TestDataEntry[]
  /** {environment: address} */
  addresses: Record<string, string>
  environment_summary: EnvironmentSummary[]
}

/** A Knowledge Base data profile (roles.json), checked against the values. */
export interface KbProfile {
  profile_id: string
  name: string
  description: string | null
  /** vault: values live here; external: held outside (e.g. a UAE PASS app). */
  kind: 'vault' | 'file' | 'external' | string
  fields: { name: string; variable?: string }[]
  state: string | null
  used_by: string[]
  cells: Record<string, { status: 'ready' | 'missing' | 'external'; missing: string[]; matched_keys?: Record<string, string> }>
}

export interface KbUsage {
  journey_app: { id: string; name: string } | null
  run_environment: string
  environments: string[]
  profiles: KbProfile[]
  totals: Partial<Record<'ready' | 'missing' | 'external', number>>
}

/** {environment: address}; "" removes that environment's address. */
export type AppBody = {
  name: string
  kb_app_id?: string | null
  url_prefix?: string | null
  run_environment?: string | null
  addresses?: Record<string, string>
}

export interface EnvironmentSummary {
  environment: string
  address: string | null
  values: number
  values_set: number
  is_default: boolean
}

export interface KbApp {
  kb_app_id: string
  name: string
  url_prefix: string | null
  suggested: { key: string; is_secret: boolean; environment: string; aliases: string }[]
}

export interface EntryInput {
  id?: number
  environment: string
  key: string
  /** Omit to keep a stored secret unchanged. */
  value?: string
  is_secret: boolean
  aliases?: string
}

export interface ScriptDataCheck {
  environment: string
  application: { id: number; name: string } | null
  needed: string[]
  matches: Record<string, string>
  missing: string[]
  message: string | null
}

const BASE = '/automation/test-data'

const testDataService = {
  apps: async (): Promise<{ apps: DataApp[]; environments: string[] }> => (await api.get(`${BASE}/apps`)).data,
  kbApps: async (): Promise<KbApp[]> => (await api.get(`${BASE}/kb-apps`)).data.apps,
  createApp: async (body: AppBody): Promise<DataApp & { warnings?: string[] }> =>
    (await api.post(`${BASE}/apps`, body)).data,
  updateApp: async (id: number, body: AppBody): Promise<DataApp & { warnings?: string[] }> =>
    (await api.put(`${BASE}/apps/${id}`, body)).data,
  deleteApp: async (id: number): Promise<void> => {
    await api.delete(`${BASE}/apps/${id}`)
  },
  saveEntries: async (id: number, entries: EntryInput[], deletedIds: number[]): Promise<DataApp> =>
    (await api.put(`${BASE}/apps/${id}/entries`, { entries, deleted_ids: deletedIds })).data,
  /** No environment: the application's own, which is what a dry run uses. */
  check: async (scriptId: number): Promise<ScriptDataCheck> =>
    (await api.get(`${BASE}/check`, { params: { script_id: scriptId } })).data,
  knowledgeBase: async (appId: number): Promise<KbUsage> => (await api.get(`${BASE}/apps/${appId}/knowledge-base`)).data
}

/** A stored key for a KB variable: TESTDATA_DEFAULT_ORG_EMAIL -> default_org.email. */
export const keyForVariable = (variable: string) => {
  const parts = variable.replace(/^TESTDATA_/, '').toLowerCase().split('_').filter(Boolean)
  return parts.length > 1 ? `${parts.slice(0, -1).join('_')}.${parts[parts.length - 1]}` : parts[0] || variable.toLowerCase()
}

/** Whether a variable holds a secret, by its name. */
export const isSecretVariable = (variable: string) => /PASSWORD|SECRET|TOKEN|PIN/i.test(variable)

/** "TESTDATA_ADMIN_PASSWORD" -> "admin password". */
export const readableName = (name: string) =>
  name.replace(/^TESTDATA_/, '').toLowerCase().split('_').filter(Boolean).join(' ')

export default testDataService
