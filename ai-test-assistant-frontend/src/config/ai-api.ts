export interface AiEndpoints {
  generateTestCases: string;
  /** Absolute URL overriding BASE_URL+generateTestCases for the Generate
   *  button only. Empty means "use the shared BASE_URL", which is what
   *  every other endpoint and every other caller still does. */
  generateVisual: string;
  generateTestData: string;
  codeChanges: string;
  codeGenerateTestCase: string;
  codeGenerateUnitTest: string;
  kbGenerate: string;  
  exportExcel: string;
  exportText: string;
  kbUploadZip: string;
  chatInitiate: string;
  chatStream: string;
  chatSessions: string;
  chatDelete: string;
}

export interface AiParameters {
  provider: string;
  embed_provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface SsdAuthConfig {
  loginUrl: string;
  email: string;
  password: string;
}

export interface AiConfig {
  BASE_URL: string;
  ENDPOINTS: AiEndpoints;
  PARAMETERS: AiParameters;
  SSD_AUTH: SsdAuthConfig;
}

// Minimal fallback BASE_URL only (no hardcoded endpoints/parameters)
const ENV_BASE_URL = (import.meta as any).env?.VITE_API_URL ?? '';
const ENV_SSD_AUTH_LOGIN_URL = (import.meta as any).env?.VITE_SSD_AUTH_LOGIN_URL ?? '';
const ENV_SSD_AUTH_LOGIN_EMAIL = (import.meta as any).env?.VITE_SSD_AUTH_LOGIN_EMAIL ?? '';
const ENV_SSD_AUTH_LOGIN_PASSWORD = (import.meta as any).env?.VITE_SSD_AUTH_LOGIN_PASSWORD ?? '';

// storage key
const STORAGE_KEY = 'ai-config';

// cachedConfig initialized from localStorage if present, otherwise minimal shape
let cachedConfig: AiConfig = (() => {
  const envSsdAuth = {
    loginUrl: ENV_SSD_AUTH_LOGIN_URL,
    email: ENV_SSD_AUTH_LOGIN_EMAIL,
    password: ENV_SSD_AUTH_LOGIN_PASSWORD,
  };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AiConfig;
      if (parsed && typeof parsed.BASE_URL === 'string' && parsed.ENDPOINTS && parsed.PARAMETERS) {
        return {
          ...parsed,
          SSD_AUTH: envSsdAuth,
        };
      }
    }
  } catch (e) {
    // ignore
  }

  // minimal empty config (NOT a meaningful default) — will be replaced by server fetch
  return {
    BASE_URL: ENV_BASE_URL,
    ENDPOINTS: {
      generateTestCases: '',
      generateVisual: '',
      generateTestData: '',
      codeChanges: '',
      codeGenerateTestCase: '',
      codeGenerateUnitTest: '',
      kbGenerate: '',
      exportExcel: '',
      exportText: '',
      kbUploadZip: '',
      chatInitiate: '',
      chatStream: '',
      chatSessions: '',
      chatDelete: '',
    },
    PARAMETERS: {
      provider: '',
      embed_provider: '',
      model: '',
      temperature: 0,
      maxTokens: 0,
    },
    SSD_AUTH: envSsdAuth,
  };
})();

/**
 * Synchronous getter for the current (cached) AI config.
 * callers should call loadConfigFromServer() to refresh from backend.
 */
export const getConfig = (): AiConfig => cachedConfig;

/**
 * Persist config to localStorage (synchronous).
 */
export const saveConfig = (cfg: AiConfig): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    cachedConfig = cfg;
  } catch (e) {
    console.error('Failed to save ai-config to localStorage', e);
  }
};

/**
 * Remove persisted config and reset cache to minimal empty config
 */
export const resetConfig = (): AiConfig => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.error('Failed to remove ai-config from localStorage', e);
  }
  cachedConfig = {
    BASE_URL: ENV_BASE_URL,
    ENDPOINTS: { generateTestCases: '', generateVisual: '', generateTestData: '', codeChanges: '', codeGenerateTestCase: '', codeGenerateUnitTest: '', kbGenerate: '', exportExcel: '', exportText: '', kbUploadZip: '', chatInitiate: '', chatStream: '', chatSessions: '', chatDelete: '' },
    PARAMETERS: { provider: '',  embed_provider: '', model: '', temperature: 0, maxTokens: 0 },
    SSD_AUTH: { loginUrl: ENV_SSD_AUTH_LOGIN_URL, email: ENV_SSD_AUTH_LOGIN_EMAIL, password: ENV_SSD_AUTH_LOGIN_PASSWORD },
  };
  return cachedConfig;
};

/**
 * Fetch config from backend /settings/ai-config and update cache + storage.
 * Uses BASE_URL from current cachedConfig (or ENV_BASE_URL) as base.
 */
export const loadConfigFromServer = async (): Promise<AiConfig> => {
  const base =  ENV_BASE_URL;
  if (!base) {
    console.warn('No BASE_URL available to load AI config from server');
    return cachedConfig;
  }

  // get auth token from storage (adjust key as needed)
  const token = localStorage.getItem('authToken') || sessionStorage.getItem('authToken') || '';
  console.log('Using auth token for AI config load:', token);
  // build headers and include Authorization when token available
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  console.log('Loading AI config from server with headers:', headers);
  console.log('Fetching from URL:', `${base.replace(/\/$/, '')}/settings/ai-config`);
  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}/settings/ai-config`, {
      method: 'GET',
      headers,
    });
    if (!resp.ok) {
      throw new Error(`Failed to load config from server: ${resp.status}`);
    }
    const json = (await resp.json()) as AiConfig;
    if (json && typeof json.BASE_URL === 'string' && json.ENDPOINTS && json.PARAMETERS) {
      cachedConfig = {
        ...json,
        SSD_AUTH: {
          loginUrl: ENV_SSD_AUTH_LOGIN_URL,
          email: ENV_SSD_AUTH_LOGIN_EMAIL,
          password: ENV_SSD_AUTH_LOGIN_PASSWORD,
        },
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedConfig));
      } catch (e) {
        console.error('Failed to persist ai-config to localStorage', e);
      }
      return cachedConfig;
    } else {
      throw new Error('Invalid config shape received from server');
    }
  } catch (err) {
    console.warn('loadConfigFromServer error, keeping cached config:', err);
    return cachedConfig;
  }
};

/**
 * Save AI config to backend via PUT /settings/ai-config and update cache + localStorage.
 */
export const saveConfigToServer = async (cfg: AiConfig): Promise<AiConfig> => {
  const base = cfg?.BASE_URL ?? cachedConfig?.BASE_URL ?? ENV_BASE_URL;
  if (!base) {
    throw new Error('No BASE_URL available to save AI config to server');
  }

  // get auth token from storage (adjust key as needed)
  const token = localStorage.getItem('authToken') || sessionStorage.getItem('authToken') || '';

  // build headers and include Authorization when token available
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}/settings/ai-config`, {
      method: 'PUT',
      credentials: 'include',
      headers,
      body: JSON.stringify(cfg),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`Failed to save config: ${resp.status} ${txt}`);
    }
    const saved = (await resp.json()) as AiConfig;
    cachedConfig = saved;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch (e) {
      console.error('Failed to persist ai-config to localStorage', e);
    }
    return saved;
  } catch (err) {
    console.error('saveConfigToServer error:', err);
    // update local cache so UI uses latest immediately
    cachedConfig = cfg;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    } catch (e) {
      console.error('Failed to persist ai-config to localStorage', e);
    }
    throw err;
  }
};

// attempt to refresh from server on module load (non-blocking)
// loadConfigFromServer().catch(() => { /* swallow - callers can call loadConfigFromServer explicitly */ });

export default getConfig;
