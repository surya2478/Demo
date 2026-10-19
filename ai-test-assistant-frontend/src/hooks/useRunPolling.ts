/**
 * --- Automation Module: run polling -------------------------------------
 *
 * Deliberately not AIProcessingContext. That context is built for short modal
 * work with a spinner in front of it; a run is long, backgrounded, survives
 * navigation, and has to keep updating a full page of results.
 *
 * Three things this gets right that a bare setInterval does not:
 *
 *  - It chains setTimeout after each response, so a slow backend can never
 *    stack overlapping requests.
 *  - It stops the moment the run reaches a terminal status. A finished run
 *    cannot change, and polling it forever is a request every two seconds
 *    per open tab, on a host that is also running browsers.
 *  - It pauses while the document is hidden and refreshes immediately on
 *    return, so a backgrounded tab costs nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import automationService from '../services/automationService'
import { isTerminal } from '../types/automation'
import type { RunDetail } from '../types/automation'

interface UseRunPollingOptions {
  /** Milliseconds between polls while the run is live. */
  intervalMs?: number
  /** Called once, when the run first reaches a terminal status. */
  onSettled?: (run: RunDetail) => void
}

interface UseRunPollingState {
  run: RunDetail | null
  /** True only for the first load — a poll must not blank the page. */
  loading: boolean
  error: string | null
  /** True while a poll is in flight, for a subtle live indicator. */
  refreshing: boolean
  polling: boolean
  refresh: () => void
}

export function useRunPolling(
  runKey: string | null | undefined,
  options: UseRunPollingOptions = {}
): UseRunPollingState {
  const { intervalMs = 2000, onSettled } = options

  const [run, setRun] = useState<RunDetail | null>(null)
  const [loading, setLoading] = useState<boolean>(Boolean(runKey))
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [polling, setPolling] = useState(false)

  const timerRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  const settledRef = useRef(false)
  // Held in a ref so a caller passing an inline arrow does not restart polling
  // on every render.
  const onSettledRef = useRef(onSettled)
  onSettledRef.current = onSettled

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const poll = useCallback(
    async (isFirst: boolean) => {
      if (!runKey) return
      if (!isFirst) setRefreshing(true)

      try {
        const data = await automationService.getRun(runKey)
        if (!mountedRef.current) return

        setRun(data)
        setError(null)

        if (isTerminal(data.status)) {
          setPolling(false)
          if (!settledRef.current) {
            settledRef.current = true
            onSettledRef.current?.(data)
          }
          return
        }

        setPolling(true)
        // Only schedule the next poll while the tab is visible. The
        // visibilitychange listener below picks it back up on return.
        if (!document.hidden) {
          clearTimer()
          timerRef.current = window.setTimeout(() => poll(false), intervalMs)
        }
      } catch (err: any) {
        if (!mountedRef.current) return
        // Transient network/auth-refresh failures should not strand the
        // Execution drawer on "Loading" or freeze an in-progress run.
        setError(err?.message ?? 'Could not load this run.')
        setPolling(true)
        if (!document.hidden) {
          clearTimer()
          timerRef.current = window.setTimeout(() => poll(false), Math.max(intervalMs, 3000))
        }
      } finally {
        if (mountedRef.current) {
          setRefreshing(false)
          if (isFirst) setLoading(false)
        }
      }
    },
    [runKey, intervalMs, clearTimer]
  )

  const refresh = useCallback(() => {
    clearTimer()
    void poll(false)
  }, [clearTimer, poll])

  useEffect(() => {
    mountedRef.current = true
    settledRef.current = false

    if (!runKey) {
      setRun(null)
      setLoading(false)
      setPolling(false)
      return
    }

    setRun(null)
    setError(null)
    setLoading(true)
    void poll(true)

    return () => {
      mountedRef.current = false
      clearTimer()
    }
  }, [runKey, poll, clearTimer])

  // Resume on return to the tab. Also covers the case where the run finished
  // while the tab was hidden — the immediate poll shows the final state.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        clearTimer()
        return
      }
      if (runKey && (!run || !isTerminal(run.status))) {
        void poll(false)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [runKey, run, poll, clearTimer])

  return { run, loading, error, refreshing, polling, refresh }
}

export default useRunPolling
