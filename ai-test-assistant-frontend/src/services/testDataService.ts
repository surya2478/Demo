import api from './api'

// Automation Studio > Test data: the values generated scripts read from
// TESTDATA_* (usernames, passwords, OTPs, record names), per application and
// environment. Secret values are encrypted by the server and never returned.

export const ALL_ENVIRONMENTS = '*'

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
  created_by: string | null
  entries: TestDataEntry[]
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
  createApp: async (body: { name: string; kb_app_id?: string | null; url_prefix?: string | null }): Promise<DataApp> =>
    (await api.post(`${BASE}/apps`, body)).data,
  updateApp: async (id: number, body: { name: string; kb_app_id?: string | null; url_prefix?: string | null }): Promise<DataApp> =>
    (await api.put(`${BASE}/apps/${id}`, body)).data,
  deleteApp: async (id: number): Promise<void> => {
    await api.delete(`${BASE}/apps/${id}`)
  },
  saveEntries: async (id: number, entries: EntryInput[], deletedIds: number[]): Promise<DataApp> =>
    (await api.put(`${BASE}/apps/${id}/entries`, { entries, deleted_ids: deletedIds })).data,
  check: async (scriptId: number, environment: string): Promise<ScriptDataCheck> =>
    (await api.get(`${BASE}/check`, { params: { script_id: scriptId, environment } })).data
}

/** "TESTDATA_ADMIN_PASSWORD" -> "admin password". */
export const readableName = (name: string) =>
  name.replace(/^TESTDATA_/, '').toLowerCase().split('_').filter(Boolean).join(' ')

const ENV_KEY = 'automation_environment'

export const readEnvironment = (): string => {
  try {
    return localStorage.getItem(ENV_KEY) || 'SIT'
  } catch {
    return 'SIT'
  }
}

export const writeEnvironment = (environment: string) => {
  try {
    localStorage.setItem(ENV_KEY, environment)
  } catch {
    /* storage unavailable: the choice lasts for this visit */
  }
}

export default testDataService
