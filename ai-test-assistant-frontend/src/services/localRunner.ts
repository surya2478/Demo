import api from './api'

const LOCAL_RUNNER_URL = 'http://127.0.0.1:8765'

export interface LocalRunnerStatus { ready: boolean; version?: string; reason?: 'not_running' | 'blocked' | 'timeout' }

const fetchWithTimeout = async (url: string, options: RequestInit & { targetAddressSpace?: 'loopback' }, timeout = 3000) => {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeout)
  try { return await fetch(url, { ...options, signal: controller.signal }) }
  finally { window.clearTimeout(timer) }
}

/** Detect the loopback companion before a server-side device session is created. */
export const getLocalRunnerStatus = async (): Promise<LocalRunnerStatus> => {
  try {
    const response = await fetchWithTimeout(`${LOCAL_RUNNER_URL}/health`, { method: 'GET', targetAddressSpace: 'loopback' })
    if (!response.ok) return { ready: false, reason: 'blocked' }
    const value = await response.json().catch(() => ({})) as { ready?: boolean; version?: string }
    return { ready: value.ready === true, version: value.version, reason: value.ready === true ? undefined : 'blocked' }
  } catch (error) {
    return { ready: false, reason: error instanceof DOMException && error.name === 'AbortError' ? 'timeout' : 'not_running' }
  }
}

export const makeLocalPairing = (input: { id: string | number; token: string; endpoint?: string }): string => {
  const apiBase = new URL(String(api.defaults.baseURL || '/'), window.location.origin).toString().replace(/\/$/, '')
  const raw = JSON.stringify({
    api: apiBase, id: input.id, token: input.token, endpoint: input.endpoint,
    studio: window.location.origin
  })
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Start the loopback-only companion without opening a browser tab. */
export const startDeviceRunner = async (pairing: string): Promise<void> => {
  try {
    const options: RequestInit & { targetAddressSpace?: 'loopback' } = {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairing }),
      targetAddressSpace: 'loopback'
    }
    const response = await fetchWithTimeout(`${LOCAL_RUNNER_URL}/run`, options)
    const result = await response.json().catch(() => ({})) as { accepted?: boolean; message?: string }
    if (!response.ok || !result.accepted) throw new Error(result.message || 'The local runner did not accept this run.')
  } catch (error) {
    if (error instanceof Error && !/fetch|abort/i.test(error.message)) throw error
    throw new Error('Device runner not detected. Open the downloaded runner and select Check connection before starting the run.')
  }
}
