export const COLLECTOR_CHANNEL = 'automation-studio-browser-collector'
export const COLLECTOR_VERSION = '1.7.0'

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
