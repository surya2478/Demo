/**
 * --- Automation Module: evidence panel ----------------------------------
 *
 * Screenshot, video and trace for one test result.
 *
 * The artifact route is authenticated, so nothing here can be a plain URL —
 * an <img src> or <video src> pointing at it sends no Authorization header and
 * renders as a broken asset. Each artifact is fetched as a blob and shown
 * through an object URL instead.
 *
 * Object URLs are held in a ref-backed cache so switching tabs does not refetch
 * a video, and every URL is revoked when the result changes or the component
 * unmounts. Leaking them pins the whole blob in memory for the life of the tab,
 * which for a run video is tens of megabytes.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  HiOutlineCamera,
  HiOutlineFilm,
  HiOutlineDocumentSearch,
  HiOutlineDownload,
  HiOutlineExclamationCircle
} from 'react-icons/hi'
import automationService from '../../services/automationService'
import type { ArtifactKind, RunResultRow } from '../../types/automation'
import EmptyState from '../ui/EmptyState'
import LoadingSkeleton from '../ui/LoadingSkeleton'

interface EvidencePanelProps {
  runKey: string
  result: RunResultRow
  className?: string
}

const KIND_META: Record<
  ArtifactKind,
  { label: string; icon: React.ComponentType<any>; hint: string }
> = {
  screenshot: {
    label: 'Screenshot',
    icon: HiOutlineCamera,
    hint: 'The page at the moment the test ended.'
  },
  video: {
    label: 'Video',
    icon: HiOutlineFilm,
    hint: 'The full session, recorded headlessly.'
  },
  trace: {
    label: 'Trace',
    icon: HiOutlineDocumentSearch,
    hint: 'A Playwright trace archive — every action, snapshot and network call.'
  }
}

const KIND_ORDER: ArtifactKind[] = ['screenshot', 'video', 'trace']

export const EvidencePanel: React.FC<EvidencePanelProps> = ({
  runKey,
  result,
  className = ''
}) => {
  const available = KIND_ORDER.filter(kind => result.evidence?.[kind])

  const [active, setActive] = useState<ArtifactKind | null>(available[0] ?? null)
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cacheRef = useRef<Partial<Record<ArtifactKind, string>>>({})
  const mountedRef = useRef(true)

  const revokeAll = useCallback(() => {
    Object.values(cacheRef.current).forEach(objectUrl => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    })
    cacheRef.current = {}
  }, [])

  // A different result means a different set of artifacts. Drop the cache and
  // start again at the first available kind.
  useEffect(() => {
    revokeAll()
    setUrl(null)
    setError(null)
    const first = KIND_ORDER.filter(kind => result.evidence?.[kind])[0] ?? null
    setActive(first)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.id, revokeAll])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      revokeAll()
    }
  }, [revokeAll])

  useEffect(() => {
    if (!active) {
      setUrl(null)
      return
    }

    const cached = cacheRef.current[active]
    if (cached) {
      setUrl(cached)
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    automationService
      .getArtifactUrl(runKey, result.id, active)
      .then(objectUrl => {
        if (cancelled || !mountedRef.current) {
          // The user moved on mid-flight; do not leak the blob we just made.
          URL.revokeObjectURL(objectUrl)
          return
        }
        cacheRef.current[active] = objectUrl
        setUrl(objectUrl)
      })
      .catch(err => {
        if (cancelled || !mountedRef.current) return
        setUrl(null)
        setError(err?.message ?? 'That artifact could not be loaded.')
      })
      .finally(() => {
        if (!cancelled && mountedRef.current) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [active, runKey, result.id])

  const handleDownload = () => {
    if (!url || !active) return
    const extension =
      active === 'screenshot' ? 'png' : active === 'video' ? 'webm' : 'zip'
    const link = document.createElement('a')
    link.href = url
    link.download = `${runKey}-${result.id}-${active}.${extension}`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  if (available.length === 0) {
    return (
      <EmptyState
        className={className}
        title="No evidence captured"
        description="This test produced no screenshot, video or trace. Playwright captures evidence on failure by default, so a clean pass often has none."
        icon={<HiOutlineCamera className="h-5 w-5" />}
      />
    )
  }

  return (
    <div
      className={`overflow-hidden rounded-app border border-app bg-app-surface ${className}`.trim()}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-app bg-app-surface-muted px-3 py-2">
        <div className="flex flex-wrap items-center gap-1">
          {available.map(kind => {
            const meta = KIND_META[kind]
            const Icon = meta.icon
            const isActive = kind === active
            return (
              <button
                key={kind}
                type="button"
                onClick={() => setActive(kind)}
                className={[
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-semibold transition',
                  isActive
                    ? 'bg-app-surface text-app-brand-800 shadow-app-card'
                    : 'text-app-secondary hover:bg-app-surface hover:text-app-primary'
                ].join(' ')}
              >
                <Icon className="h-4 w-4" />
                {meta.label}
              </button>
            )
          })}
        </div>
        {url ? (
          <button
            type="button"
            onClick={handleDownload}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-app-secondary transition hover:bg-app-surface hover:text-app-primary"
          >
            <HiOutlineDownload className="h-3.5 w-3.5" />
            Download
          </button>
        ) : null}
      </div>

      <div className="px-4 py-4">
        {active ? (
          <p className="mb-3 text-[12px] text-app-secondary">{KIND_META[active].hint}</p>
        ) : null}

        {loading ? <LoadingSkeleton className="h-64 w-full" rounded="lg" /> : null}

        {!loading && error ? (
          <div className="flex items-start gap-2 rounded-app border border-red-200 bg-app-danger-bg px-3 py-3 text-[13px] text-app-danger">
            <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {!loading && !error && url && active === 'screenshot' ? (
          <img
            src={url}
            alt={`Screenshot from ${result.test_name}`}
            className="max-h-[520px] w-full rounded-app border border-app object-contain"
          />
        ) : null}

        {!loading && !error && url && active === 'video' ? (
          <video
            src={url}
            controls
            className="max-h-[520px] w-full rounded-app border border-app bg-black"
          />
        ) : null}

        {!loading && !error && url && active === 'trace' ? (
          // A trace is a zip that only the Playwright trace viewer can open.
          <div className="rounded-app border border-dashed border-app bg-app-surface-muted/50 px-4 py-6 text-center">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-app bg-app-surface text-app-brand-700 shadow-app-card">
              <HiOutlineDocumentSearch className="h-5 w-5" />
            </div>
            <h4 className="text-sm font-semibold text-app-primary">Playwright Trace Archive Ready</h4>
            <p className="mx-auto mt-1.5 max-w-lg text-[13px] text-app-secondary">
              Inspect DOM snapshots, network waterfalls, action timelines, and console logs at any millisecond of test execution.
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={handleDownload}
                className="app-btn app-btn-primary inline-flex items-center gap-1.5 text-xs"
              >
                <HiOutlineDownload className="h-4 w-4" />
                Download Trace (.zip)
              </button>
              <a
                href="https://trace.playwright.dev"
                target="_blank"
                rel="noreferrer"
                className="app-btn app-btn-secondary inline-flex items-center gap-1.5 text-xs"
              >
                <HiOutlineDocumentSearch className="h-4 w-4" />
                Open Trace Viewer (trace.playwright.dev)
              </a>
            </div>
            <p className="mt-3 text-[11px] text-app-secondary">
              Or inspect locally in terminal with <code className="rounded bg-app-surface px-1.5 py-0.5 font-mono text-app-primary">npx playwright show-trace &lt;path-to-trace.zip&gt;</code>
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default EvidencePanel
