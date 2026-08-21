/**
 * --- Automation Module: runtime strip -----------------------------------
 *
 * The degraded-mode surface, rendered above the workspace.
 *
 * This exists so a missing toolchain is visible *before* anyone clicks Run,
 * rather than surfacing as an opaque failure five seconds later. Every
 * unavailable framework carries a `detail` from the backend that names what to
 * install, and it is shown verbatim — paraphrasing it would strip the only
 * actionable part.
 */
import React from 'react'
import {
  HiOutlineCheckCircle,
  HiOutlineExclamation,
  HiOutlineRefresh,
  HiOutlineChip
} from 'react-icons/hi'
import StatusBadge from '../ui/StatusBadge'
import LoadingSkeleton from '../ui/LoadingSkeleton'
import type { RuntimeStatusResponse } from '../../types/automation'

interface RuntimeStripProps {
  runtime: RuntimeStatusResponse | null
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  /** Live run count, when the caller already knows it. */
  activeRuns?: number | null
  className?: string
}

export const RuntimeStrip: React.FC<RuntimeStripProps> = ({
  runtime,
  loading = false,
  error = null,
  onRetry,
  activeRuns = null,
  className = ''
}) => {
  if (loading && !runtime) {
    return <LoadingSkeleton className={`h-14 w-full ${className}`.trim()} rounded="lg" />
  }

  if (error && !runtime) {
    return (
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-app-lg border border-red-200 bg-app-danger-bg px-4 py-3 ${className}`.trim()}
      >
        <div className="flex items-start gap-2 text-[13px] text-app-danger">
          <HiOutlineExclamation className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>Could not read the runtime status. {error}</span>
        </div>
        {onRetry ? (
          <button type="button" onClick={onRetry} className="app-btn app-btn-secondary">
            <HiOutlineRefresh className="mr-1.5 inline h-4 w-4" />
            Retry
          </button>
        ) : null}
      </div>
    )
  }

  if (!runtime) return null

  const unavailable = Object.entries(runtime.frameworks).filter(
    ([, support]) => !support.available
  )

  const tone = !runtime.enabled ? 'neutral' : runtime.ready ? 'success' : 'warning'
  const label = !runtime.enabled
    ? 'Module disabled'
    : runtime.ready
      ? 'Runtime ready'
      : 'Runtime unavailable'

  return (
    <div
      className={`rounded-app-lg border border-app bg-app-surface px-4 py-3 shadow-app-card ${className}`.trim()}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span
            className={`flex h-8 w-8 items-center justify-center rounded-app ${
              runtime.ready
                ? 'bg-app-success-bg text-app-success'
                : 'bg-app-warning-bg text-app-warning'
            }`}
            aria-hidden
          >
            {runtime.ready ? (
              <HiOutlineCheckCircle className="h-4 w-4" />
            ) : (
              <HiOutlineExclamation className="h-4 w-4" />
            )}
          </span>
          <StatusBadge tone={tone} dot>
            {label}
          </StatusBadge>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {Object.entries(runtime.frameworks).map(([name, support]) => (
            <span
              key={name}
              title={support.detail}
              className={[
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold',
                support.available
                  ? 'border-green-200 bg-app-success-bg text-app-success'
                  : 'border-orange-200 bg-app-warning-bg text-app-warning'
              ].join(' ')}
            >
              <HiOutlineChip className="h-3.5 w-3.5" />
              {name}
            </span>
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-app-secondary">
          {activeRuns !== null ? (
            <span>
              <span className="font-semibold text-app-primary">{activeRuns}</span> of{' '}
              <span className="font-semibold text-app-primary">
                {runtime.max_concurrent_runs}
              </span>{' '}
              slots in use
            </span>
          ) : (
            <span>
              Capacity{' '}
              <span className="font-semibold text-app-primary">
                {runtime.max_concurrent_runs}
              </span>{' '}
              concurrent
            </span>
          )}
          <span>
            Runs{' '}
            <span className="font-semibold text-app-primary">
              {runtime.runnable_frameworks.join(', ') || 'nothing'}
            </span>
          </span>
          {runtime.generate_only_frameworks.length > 0 ? (
            // Stated up front rather than discovered on a disabled button:
            // no runner exists for these anywhere, upstream included.
            <span title="No runner exists for these frameworks. The Studio can generate scripts for them, but cannot execute them.">
              Generate-only{' '}
              <span className="font-semibold text-app-primary">
                {runtime.generate_only_frameworks.join(', ')}
              </span>
            </span>
          ) : null}
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-semibold text-app-secondary transition hover:bg-app-surface-muted hover:text-app-primary"
              title="Re-check the runtime"
            >
              <HiOutlineRefresh className="h-3.5 w-3.5" />
              Re-check
            </button>
          ) : null}
        </div>
      </div>

      {!runtime.enabled ? (
        <p className="mt-2.5 border-t border-app pt-2.5 text-[12px] text-app-secondary">
          The Automation Module is disabled on this deployment. Set{' '}
          <span className="font-mono text-app-primary">AUTOMATION_ENABLED=true</span> to allow
          runs. Everything else on this page stays readable.
        </p>
      ) : null}

      {runtime.enabled && unavailable.length > 0 ? (
        <div className="mt-2.5 space-y-1 border-t border-app pt-2.5">
          {unavailable.map(([name, support]) => (
            <p key={name} className="text-[12px] text-app-secondary">
              <span className="font-semibold capitalize text-app-warning">{name}:</span>{' '}
              {support.detail}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export default RuntimeStrip
