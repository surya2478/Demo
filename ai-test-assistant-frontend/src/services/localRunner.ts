import api from './api'

const LOCAL_RUNNER_URL = 'http://127.0.0.1:8765'

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
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 3000)
  try {
    const options: RequestInit & { targetAddressSpace?: 'loopback' } = {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairing }), signal: controller.signal,
      targetAddressSpace: 'loopback'
    }
    const response = await fetch(`${LOCAL_RUNNER_URL}/run`, options)
    const result = await response.json().catch(() => ({})) as { accepted?: boolean; message?: string }
    if (!response.ok || !result.accepted) throw new Error(result.message || 'The local runner did not accept this run.')
  } finally {
    window.clearTimeout(timer)
  }
}
