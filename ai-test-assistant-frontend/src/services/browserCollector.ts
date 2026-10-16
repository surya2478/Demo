export const COLLECTOR_CHANNEL = 'automation-studio-browser-collector'
export const COLLECTOR_VERSION = '1.10.2'

/** Read the installed collector version without creating a crawl or opening a tab. */
export const installedCollectorVersion = (): Promise<string | null> => new Promise(resolve => {
  const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  let settled = false
  const finish = (version: string | null) => {
    if (settled) return
    settled = true
    window.removeEventListener('message', receive)
    window.clearTimeout(timer)
    resolve(version)
  }
  const receive = (event: MessageEvent) => {
    const value = event.data
    if (event.source !== window || event.origin !== window.location.origin || value?.channel !== COLLECTOR_CHANNEL || value?.nonce !== nonce || value?.type !== 'probe-result') return
    finish(typeof value.version === 'string' ? value.version : null)
  }
  const timer = window.setTimeout(() => finish(null), 1800)
  window.addEventListener('message', receive)
  window.postMessage({ channel: COLLECTOR_CHANNEL, type: 'probe', nonce }, window.location.origin)
})

/** Tell the installed collector to close only the tab owned by this crawl. */
export const stopInstalledCollector = (crawlId: number): Promise<boolean> => new Promise(resolve => {
  const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  let settled = false
  const finish = (stopped: boolean) => {
    if (settled) return
    settled = true
    window.removeEventListener('message', receive)
    window.clearTimeout(timer)
    resolve(stopped)
  }
  const receive = (event: MessageEvent) => {
    const value = event.data
    if (event.source !== window || event.origin !== window.location.origin || value?.channel !== COLLECTOR_CHANNEL || value?.nonce !== nonce || value?.type !== 'stop-result') return
    finish(value.active === false)
  }
  const timer = window.setTimeout(() => finish(false), 5000)
  window.addEventListener('message', receive)
  window.postMessage({ channel: COLLECTOR_CHANNEL, type: 'stop', nonce, crawlId }, window.location.origin)
})

/** Ask the already-paired extension to start an origin-bound crawl. */
export const startInstalledCollector = (pairing: string, maxPages = 20): Promise<boolean> => new Promise(resolve => {
  const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  let settled = false
  const finish = (started: boolean) => {
    if (settled) return
    settled = true
    window.removeEventListener('message', receive)
    window.clearTimeout(timer)
    resolve(started)
  }
  const receive = (event: MessageEvent) => {
    const value = event.data
    if (event.source !== window || event.origin !== window.location.origin || value?.channel !== COLLECTOR_CHANNEL || value?.nonce !== nonce || value?.type !== 'start-result') return
    finish(value.active === true && value.version === COLLECTOR_VERSION)
  }
  const timer = window.setTimeout(() => finish(false), 3500)
  window.addEventListener('message', receive)
  window.postMessage({ channel: COLLECTOR_CHANNEL, type: 'start', nonce, pairing, maxPages }, window.location.origin)
})

/** Restart an active guided crawl from its application start page. */
export const resumeInstalledCollector = (crawlId: number): Promise<boolean> => new Promise(resolve => {
  const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  let settled = false
  const finish = (started: boolean) => {
    if (settled) return
    settled = true
    window.removeEventListener('message', receive)
    window.clearTimeout(timer)
    resolve(started)
  }
  const receive = (event: MessageEvent) => {
    const value = event.data
    if (event.source !== window || event.origin !== window.location.origin || value?.channel !== COLLECTOR_CHANNEL || value?.nonce !== nonce || value?.type !== 'resume-result') return
    finish(value.active === true && value.version === COLLECTOR_VERSION)
  }
  const timer = window.setTimeout(() => finish(false), 3500)
  window.addEventListener('message', receive)
  window.postMessage({ channel: COLLECTOR_CHANNEL, type: 'resume', nonce, crawlId }, window.location.origin)
})
