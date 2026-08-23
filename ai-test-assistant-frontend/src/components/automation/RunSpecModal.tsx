/**
 * --- Automation Module: run a spec --------------------------------------
 *
 * Phase 0's execution entry point. Generation does not exist yet, so what runs
 * is a spec the user supplies — which is the point: a green result here means
 * the runtime is genuinely correct, rather than that a model happened to
 * behave.
 *
 * When opened from a candidate, the editor is seeded with a scaffold built
 * from that case's real steps. The steps arrive as one numbered string, so the
 * same splitting the backend scorer does is done here before they become
 * comments — a scaffold with one giant comment line would be useless.
 *
 * Refusals from the backend are surfaced verbatim. It refuses *before*
 * queueing (module disabled, runtime missing, no free slot) and the reason is
 * the actionable part.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { HiOutlineX, HiOutlinePlay, HiOutlineExclamationCircle } from 'react-icons/hi'
import automationService from '../../services/automationService'
import { CodeEditor } from './CodeViewer'
import type { Candidate, RuntimeStatusResponse } from '../../types/automation'

interface RunSpecModalProps {
  open: boolean
  onClose: () => void
  /** Seeds the scaffold. Omitted for a run started from the Runs tab. */
  candidate?: Candidate | null
  initialCode?: string | null
  initialFileName?: string | null
  initialBaseUrl?: string | null
  initialEnvironment?: string | null
  initialSlowMoMs?: number | null
  initialTestCaseId?: number | null
  runtime: RuntimeStatusResponse | null
  canExecute: boolean
  onQueued: (runKey: string) => void
}

const ENVIRONMENTS = ['SIT', 'UAT', 'QA', 'DEV']

/** Mirrors split_steps in services/automation/eligibility.py. */
function splitSteps(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map(s => String(s).trim()).filter(Boolean)
  }
  const text = String(raw ?? '').trim()
  if (!text) return []

  // "Step 1:" / "Step 1." — normalise so the numeric pass below sees it.
  const normalised = text.replace(/\bstep\s+(\d+)\s*[:.)]/gi, '$1.')

  // Split before a number followed by . ) or : that starts a step. The number
  // must be at the start or preceded by whitespace, so "wait 1.5 seconds"
  // does not split.
  const parts = normalised.split(/(?:(?<=^)|(?<=\s))(?=\d{1,2}\s*[.):]\s+)/)
  const steps = parts
    .map(part => part.replace(/^\d{1,2}\s*[.):]\s*/, '').trim().replace(/^[.;\s]+|[.;\s]+$/g, ''))
    .filter(Boolean)

  if (steps.length > 1) return steps

  const lines = normalised
    .split('\n')
    .map(line => line.replace(/^[-•\t\s]+/, '').trim())
    .filter(Boolean)
  if (lines.length > 1) return lines

  const sentences = normalised.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean)
  return sentences.length > 1 ? sentences : [normalised]
}

/**
 * Keep a value inside a single-quoted JS string literal. Newlines are folded
 * too — a description that wraps would otherwise terminate the literal and
 * hand the runner a spec that cannot parse.
 */
const quoteSafe = (value: string) =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\s+/g, ' ')
    .trim()

function buildScaffold(candidate: Candidate | null | undefined, steps: string[], baseUrl: string) {
  const title = candidate
    ? `${candidate.display_id}${candidate.description ? ` — ${candidate.description}` : ''}`
    : 'Runtime smoke test'

  const stepComments = steps.length
    ? steps.map((step, i) => `  // ${i + 1}. ${step.replace(/\s+/g, ' ')}`).join('\n')
    : '  // Add the actions this test should perform.'

  const target = baseUrl.trim() || 'https://example.com'

  return `import { test, expect } from '@playwright/test';

test('${quoteSafe(title.slice(0, 160))}', async ({ page }) => {
  await page.goto('${quoteSafe(target)}');

${stepComments}

  await expect(page).toHaveTitle(/.*/);
});
`
}

export const RunSpecModal: React.FC<RunSpecModalProps> = ({
  open,
  onClose,
  candidate,
  initialCode,
  initialFileName,
  initialBaseUrl,
  initialEnvironment,
  initialSlowMoMs,
  initialTestCaseId,
  runtime,
  canExecute,
  onQueued
}) => {
  const [code, setCode] = useState('')
  const [environment, setEnvironment] = useState('SIT')
  const [baseUrl, setBaseUrl] = useState('')
  const [fileName, setFileName] = useState('spec.ts')
  const [slowMoMs, setSlowMoMs] = useState<number>(1000)
  const [steps, setSteps] = useState<string[]>([])
  const [loadingSteps, setLoadingSteps] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Once the user edits, a later steps fetch must not overwrite their work.
  const [touched, setTouched] = useState(false)

  const blockedReason = useMemo(() => {
    if (!canExecute) return 'You do not have permission to execute automation runs.'
    if (runtime && !runtime.enabled) {
      return 'The Automation Module is disabled on this deployment (AUTOMATION_ENABLED=false).'
    }
    if (runtime && !runtime.ready) {
      const missing = Object.entries(runtime.frameworks)
        .filter(([, s]) => !s.available)
        .map(([name, s]) => `${name}: ${s.detail}`)
        .join('; ')
      return `The browser runtime is not available. ${missing}`
    }
    return null
  }, [canExecute, runtime])

  // Reset per opening, so a previous run's edits never leak into a new one.
  useEffect(() => {
    if (!open) return
    setError(null)
    setSubmitting(false)
    setTouched(false)
    setSteps([])
    setEnvironment(initialEnvironment || 'SIT')
    setBaseUrl(initialBaseUrl || '')
    setSlowMoMs(initialSlowMoMs !== undefined && initialSlowMoMs !== null ? initialSlowMoMs : 1000)
    setFileName(
      initialFileName ||
      (candidate
        ? `${candidate.display_id.replace(/[^A-Za-z0-9_-]+/g, '-').toLowerCase()}.spec.ts`
        : 'smoke.spec.ts')
    )
    if (initialCode) {
      setCode(initialCode)
    } else {
      setCode(buildScaffold(candidate, [], initialBaseUrl || ''))
    }
  }, [open, candidate, initialCode, initialFileName, initialBaseUrl, initialEnvironment, initialSlowMoMs])

  // Approved cases carry their steps on the detail endpoint, not the list.
  useEffect(() => {
    if (!open || !candidate) return
    if (candidate.source !== 'approved' || !candidate.origin_test_case_id) return

    let cancelled = false
    setLoadingSteps(true)
    automationService
      .getApprovedCandidate(candidate.origin_test_case_id)
      .then(detail => {
        if (cancelled) return
        const raw =
          (detail.details as any)?.['Test Steps'] ??
          (detail.details as any)?.steps_raw ??
          (detail.details as any)?.steps
        setSteps(splitSteps(raw))
      })
      .catch(() => {
        // A scaffold without steps is still usable; do not block the run on it.
        if (!cancelled) setSteps([])
      })
      .finally(() => {
        if (!cancelled) setLoadingSteps(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, candidate])

  // Re-seed once the steps land, unless the user has already started typing or initialCode was passed.
  useEffect(() => {
    if (!open || touched || initialCode) return
    setCode(buildScaffold(candidate, steps, baseUrl))
  }, [open, touched, initialCode, candidate, steps, baseUrl])

  const handleCodeChange = useCallback((next: string) => {
    setTouched(true)
    setCode(next)
  }, [])

  const handleSubmit = async () => {
    if (!code.trim()) {
      setError('The spec is empty. Paste or write the test to run.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await automationService.createRun({
        code,
        environment: environment.trim() || null,
        base_url: baseUrl.trim() || null,
        file_name: fileName.trim() || null,
        slow_mo_ms: slowMoMs,
        // Only the Studio's own cases have an id. An approved case is not
        // mirrored into automation_test_cases yet, so sending its origin id
        // here would violate the foreign key.
        test_case_id: candidate?.id ?? null
      })
      onQueued(res.run_key)
    } catch (err: any) {
      setError(err?.message ?? 'The run could not be queued.')
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
      onClick={event => {
        if (event.target === event.currentTarget && !submitting) onClose()
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="flex h-[92vh] w-full max-w-[1100px] flex-col overflow-hidden rounded-[24px] border border-app bg-app-surface shadow-[0_28px_70px_rgba(15,23,42,0.18)]">
        <div className="flex items-center justify-between border-b border-app bg-app-surface-muted px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-bold text-app-primary">
              Run a Playwright spec
            </h2>
            <p className="mt-0.5 truncate text-[12px] text-app-secondary">
              {candidate
                ? `Scaffolded from ${candidate.display_id}`
                : 'Executes headlessly on this host'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md p-1.5 text-app-secondary transition hover:bg-app-surface hover:text-app-primary disabled:opacity-50"
            aria-label="Close"
          >
            <HiOutlineX className="h-5 w-5" />
          </button>
        </div>

        <div className="app-scroll flex-1 overflow-y-auto px-5 py-4">
          {blockedReason ? (
            <div className="mb-4 flex items-start gap-2 rounded-app border border-orange-200 bg-app-warning-bg px-3 py-3 text-[13px] text-app-warning">
              <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{blockedReason}</span>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="mb-1 block text-[12px] font-semibold text-app-primary">
                Environment
              </label>
              <input
                list="automation-environments"
                value={environment}
                onChange={e => setEnvironment(e.target.value)}
                className="app-input w-full"
                placeholder="SIT"
                maxLength={50}
              />
              <datalist id="automation-environments">
                {ENVIRONMENTS.map(env => (
                  <option key={env} value={env} />
                ))}
              </datalist>
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-semibold text-app-primary">
                Execution speed
              </label>
              <select
                value={slowMoMs}
                onChange={e => setSlowMoMs(Number(e.target.value))}
                className="app-input w-full"
                title="Delay between actions. Safe/Anti-Bot is recommended for public sites with WAFs (like eand.ae)"
              >
                <option value={1000}>Safe / Anti-Bot (1000ms)</option>
                <option value={0}>Fast / CI (0ms)</option>
                <option value={500}>Balanced (500ms)</option>
                <option value={2000}>Debug / Slow (2000ms)</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-semibold text-app-primary">
                Base URL
              </label>
              <input
                value={baseUrl}
                onChange={e => setBaseUrl(e.target.value)}
                className="app-input w-full"
                placeholder="https://sit.example.corp.ae"
                maxLength={2000}
              />
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-semibold text-app-primary">
                File name
              </label>
              <input
                value={fileName}
                onChange={e => setFileName(e.target.value)}
                className="app-input w-full font-mono text-[12px]"
                placeholder="spec.ts"
                maxLength={255}
              />
            </div>
          </div>

          <div className="mt-4">
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-[12px] font-semibold text-app-primary">Spec</label>
              {loadingSteps ? (
                <span className="text-[11px] text-app-secondary">Loading test steps…</span>
              ) : steps.length > 0 && !touched ? (
                <span className="text-[11px] text-app-secondary">
                  Scaffolded from {steps.length} {steps.length === 1 ? 'step' : 'steps'}
                </span>
              ) : null}
            </div>
            <CodeEditor
              value={code}
              onChange={handleCodeChange}
              fileName={fileName || 'spec.ts'}
              rows={20}
              disabled={submitting}
              placeholder="import { test, expect } from '@playwright/test';"
            />
            <p className="mt-1.5 text-[11px] text-app-secondary">
              The spec runs headlessly with a video, trace and failure screenshot captured. Base
              URL is passed to the runner; a spec can also navigate to an absolute URL itself.
            </p>
          </div>

          {error ? (
            <div className="mt-4 flex items-start gap-2 rounded-app border border-red-200 bg-app-danger-bg px-3 py-3 text-[13px] text-app-danger">
              <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-app bg-app-surface-muted px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="app-btn app-btn-secondary disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || Boolean(blockedReason) || !code.trim()}
            className="app-btn app-btn-primary inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <HiOutlinePlay className="h-4 w-4" />
            {submitting ? 'Queueing…' : 'Queue run'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default RunSpecModal
