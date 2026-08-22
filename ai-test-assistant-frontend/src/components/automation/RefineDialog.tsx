/**
 * --- Automation Module: refinement and its diff -------------------------
 *
 * Refinement is a model judgement, so the rewrite is never presented as the
 * answer: it lands as a NEW case with the original kept beside it, and this
 * dialog shows both so a reviewer can reject it.
 *
 * The comparison is field-level, not character-level. A word-diff of two
 * differently-worded test cases is noise — almost every character changes,
 * because rewriting is the point. What a reviewer actually needs to judge is
 * "did the steps get more atomic, did the expected result survive, did the
 * score move", and that reads better as two columns than as red and green
 * fragments.
 */
import React, { useCallback, useEffect, useState } from 'react'
import {
  HiOutlineX,
  HiOutlineSparkles,
  HiOutlineExclamationCircle,
  HiOutlineArrowRight,
  HiOutlineBan,
  HiOutlineDatabase
} from 'react-icons/hi'
import automationService from '../../services/automationService'
import StatusBadge from '../ui/StatusBadge'
import LoadingSkeleton from '../ui/LoadingSkeleton'
import { verdictLabel, verdictTone } from './EligibilityMeter'
import type { Candidate, LlmStatus, RefineResult, StudioCase } from '../../types/automation'

interface RefineDialogProps {
  /** The Studio case to refine. Approved cases have no id and cannot be refined yet. */
  candidate: Candidate | null
  onClose: () => void
  canExecute: boolean
  /** Called once a refined case exists, so the caller can refresh its list. */
  onRefined: (result: RefineResult) => void
}

const COMPARED: Array<{ key: keyof StudioCase; label: string }> = [
  { key: 'description', label: 'Description' },
  { key: 'preconditions', label: 'Preconditions' },
  { key: 'steps_raw', label: 'Steps' },
  { key: 'test_data', label: 'Test data' },
  { key: 'expected_result', label: 'Expected result' }
]

const RESOLUTION_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  agent_generated: 'success',
  existing_record: 'warning',
  user_required: 'danger'
}

const Side: React.FC<{ label: string; value: unknown; changed: boolean; tone: 'before' | 'after' }> = ({
  label,
  value,
  changed,
  tone
}) => {
  const text = (value ?? '') as string
  return (
    <div
      className={[
        'rounded-app border px-3 py-2.5',
        changed && tone === 'after'
          ? 'border-green-200 bg-app-success-bg/40'
          : 'border-app bg-app-surface-muted/30'
      ].join(' ')}
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-app-secondary">
        {label}
      </div>
      {text ? (
        <p className="whitespace-pre-wrap text-[12px] leading-5 text-app-primary">{text}</p>
      ) : (
        <p className="text-[12px] italic text-app-secondary/70">empty</p>
      )}
    </div>
  )
}

export const RefineDialog: React.FC<RefineDialogProps> = ({
  candidate,
  onClose,
  canExecute,
  onRefined
}) => {
  const [llm, setLlm] = useState<LlmStatus | null>(null)
  const [applicationUrl, setApplicationUrl] = useState('')
  const [applicationName, setApplicationName] = useState('')
  const [requirement, setRequirement] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RefineResult | null>(null)

  const open = Boolean(candidate)

  useEffect(() => {
    if (!open) return
    setResult(null)
    setError(null)
    setRunning(false)
    automationService
      .getLlmStatus()
      .then(setLlm)
      .catch(() => setLlm(null))
  }, [open, candidate?.id])

  const close = useCallback(() => {
    if (running) return
    onClose()
  }, [running, onClose])

  const handleRefine = async () => {
    if (!candidate?.id) return
    setRunning(true)
    setError(null)
    try {
      const res = await automationService.refineCase(candidate.id, {
        application_url: applicationUrl.trim() || null,
        application_name: applicationName.trim() || null,
        requirement: requirement.trim() || null
      })
      setResult(res)
      onRefined(res)
    } catch (err: any) {
      setError(err?.message ?? 'Refinement failed.')
    } finally {
      setRunning(false)
    }
  }

  if (!candidate) return null

  const notStudioOwned = candidate.id === null
  const scoreBefore = result?.original.eligibility?.score
  const scoreAfter = result?.refined.eligibility?.score

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
      onClick={e => {
        if (e.target === e.currentTarget) close()
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="flex h-[92vh] w-full max-w-[1100px] flex-col overflow-hidden rounded-[24px] border border-app bg-app-surface shadow-[0_28px_70px_rgba(15,23,42,0.18)]">
        <div className="flex items-center justify-between border-b border-app bg-app-surface-muted px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-bold text-app-primary">
              Refine {candidate.display_id}
            </h2>
            <p className="mt-0.5 text-[12px] text-app-secondary">
              Rewrites the case into atomic steps with its test data named. Saved as a new
              case — the original is kept.
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={running}
            className="rounded-md p-1.5 text-app-secondary transition hover:bg-app-surface hover:text-app-primary disabled:opacity-50"
            aria-label="Close"
          >
            <HiOutlineX className="h-5 w-5" />
          </button>
        </div>

        <div className="app-scroll flex-1 overflow-y-auto px-5 py-4">
          {notStudioOwned ? (
            <div className="mb-4 flex items-start gap-2 rounded-app border border-orange-200 bg-app-warning-bg px-3 py-3 text-[13px] text-app-warning">
              <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>
                This case lives in the review workflow, which the Studio never writes to. Add
                it to the Studio first, then refine that copy.
              </span>
            </div>
          ) : null}

          {llm && !llm.configured ? (
            <div className="mb-4 flex items-start gap-2 rounded-app border border-orange-200 bg-app-warning-bg px-3 py-3 text-[13px] text-app-warning">
              <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{llm.detail}</span>
            </div>
          ) : null}

          {!result ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-[12px] font-semibold text-app-primary">
                    Application URL
                  </label>
                  <input
                    value={applicationUrl}
                    onChange={e => setApplicationUrl(e.target.value)}
                    placeholder="http://localhost:5175"
                    className="app-input w-full"
                  />
                  {/* Grounding, not decoration: without a real URL the model is told to
                      say so in the preconditions rather than invent example.com. */}
                  <p className="mt-1 text-[11px] text-app-secondary">
                    Used verbatim in the first step. Left empty, the refined case says the
                    URL is unset instead of inventing one.
                  </p>
                </div>
                <div>
                  <label className="mb-1 block text-[12px] font-semibold text-app-primary">
                    Application name
                  </label>
                  <input
                    value={applicationName}
                    onChange={e => setApplicationName(e.target.value)}
                    placeholder="Self Care Portal"
                    className="app-input w-full"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="mb-1 block text-[12px] font-semibold text-app-primary">
                    Requirement <span className="font-normal text-app-secondary">(optional)</span>
                  </label>
                  <textarea
                    value={requirement}
                    onChange={e => setRequirement(e.target.value)}
                    rows={3}
                    placeholder="The requirement this test case must verify"
                    className="app-input app-scroll w-full resize-y"
                  />
                </div>
              </div>

              {running ? (
                <div className="mt-4 space-y-2">
                  <p className="text-[12px] text-app-secondary">
                    Refining — this is a single model call and usually takes a few seconds.
                  </p>
                  <LoadingSkeleton className="h-24 w-full" rounded="lg" />
                </div>
              ) : null}
            </>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3 rounded-app border border-app bg-app-surface-muted/40 px-3 py-3">
                <span className="text-[12px] font-semibold text-app-secondary">Eligibility</span>
                <StatusBadge tone={verdictTone(result.original.eligibility?.verdict)} size="sm">
                  {verdictLabel(result.original.eligibility?.verdict)} {scoreBefore}
                </StatusBadge>
                <HiOutlineArrowRight className="h-4 w-4 text-app-secondary" />
                <StatusBadge tone={verdictTone(result.refined.eligibility?.verdict)} size="sm" dot>
                  {verdictLabel(result.refined.eligibility?.verdict)} {scoreAfter}
                </StatusBadge>
                {typeof scoreBefore === 'number' && typeof scoreAfter === 'number' ? (
                  <span
                    className={`text-[12px] font-semibold ${
                      scoreAfter > scoreBefore
                        ? 'text-app-success'
                        : scoreAfter < scoreBefore
                          ? 'text-app-danger'
                          : 'text-app-secondary'
                    }`}
                  >
                    {scoreAfter > scoreBefore ? '+' : ''}
                    {scoreAfter - scoreBefore}
                  </span>
                ) : null}
                <span className="ml-auto text-[11px] text-app-secondary">
                  Saved as case #{result.refined.id}
                </span>
              </div>

              <div className="grid gap-2 lg:grid-cols-2">
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-app-secondary">
                  Original
                </div>
                <div className="hidden text-[11px] font-semibold uppercase tracking-[0.12em] text-app-success lg:block">
                  Refined
                </div>
                {COMPARED.map(field => {
                  const before = result.original[field.key]
                  const after = result.refined[field.key]
                  const changed = (before ?? '') !== (after ?? '')
                  return (
                    <React.Fragment key={String(field.key)}>
                      <Side label={field.label} value={before} changed={changed} tone="before" />
                      <Side label={field.label} value={after} changed={changed} tone="after" />
                    </React.Fragment>
                  )
                })}
              </div>

              {result.refined.steps_structured?.length ? (
                <div>
                  <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-app-secondary">
                    Structured steps — what a generator compiles against
                  </h3>
                  <div className="overflow-x-auto rounded-app border border-app">
                    <table className="app-table">
                      <thead>
                        <tr>
                          <th className="text-left">#</th>
                          <th className="text-left">Action</th>
                          <th className="text-left">Target</th>
                          <th className="text-left">Data</th>
                          <th className="text-left">Expected</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.refined.steps_structured.map(step => (
                          <tr key={step.step_number}>
                            <td className="text-[12px] text-app-secondary">{step.step_number}</td>
                            <td className="text-[12px] text-app-primary">{step.action}</td>
                            <td className="text-[12px] text-app-secondary">{step.target ?? '—'}</td>
                            <td className="font-mono text-[11px] text-app-brand-700">
                              {step.test_data_ref ?? '—'}
                            </td>
                            <td className="text-[12px] text-app-secondary">
                              {step.expected_result ?? '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              {result.refined.test_data_requirements?.length ? (
                <div>
                  <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-app-secondary">
                    <HiOutlineDatabase className="h-3.5 w-3.5" />
                    Test data required
                  </h3>
                  <div className="space-y-1.5">
                    {result.refined.test_data_requirements.map(req => (
                      <div
                        key={req.key}
                        className="flex flex-wrap items-center gap-2 rounded-app border border-app px-3 py-2"
                      >
                        <span className="font-mono text-[12px] font-semibold text-app-primary">
                          {req.key}
                        </span>
                        <StatusBadge tone={RESOLUTION_TONE[req.resolution] ?? 'neutral'} size="sm">
                          {req.resolution.replace('_', ' ')}
                        </StatusBadge>
                        {req.sensitive ? (
                          <StatusBadge tone="danger" size="sm">
                            sensitive
                          </StatusBadge>
                        ) : null}
                        <span className="min-w-0 flex-1 truncate text-[12px] text-app-secondary">
                          {req.description ?? ''}
                        </span>
                      </div>
                    ))}
                  </div>
                  {result.test_data_required ? (
                    <p className="mt-2 text-[12px] text-app-warning">
                      {result.test_data_notes ??
                        'This case cannot run until a human provides the data above.'}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {result.refined.automation_blockers?.length ? (
                <div className="rounded-app border border-red-200 bg-app-danger-bg px-3 py-3">
                  <h3 className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-app-danger">
                    <HiOutlineBan className="h-3.5 w-3.5" />
                    Cannot be automated
                  </h3>
                  <ul className="space-y-0.5">
                    {result.refined.automation_blockers.map((blocker, i) => (
                      <li key={i} className="text-[12px] text-app-danger">
                        {blocker}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {result.bdd_scenario ? (
                <div>
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-app-secondary">
                    BDD scenario
                  </h3>
                  <pre className="app-scroll overflow-x-auto whitespace-pre-wrap rounded-app border border-app bg-app-surface-muted/40 px-3 py-2.5 font-mono text-[11px] leading-5 text-app-primary">
                    {result.bdd_scenario}
                  </pre>
                </div>
              ) : null}
            </div>
          )}

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
            onClick={close}
            disabled={running}
            className="app-btn app-btn-secondary disabled:opacity-50"
          >
            {result ? 'Done' : 'Cancel'}
          </button>
          {!result ? (
            <button
              type="button"
              onClick={handleRefine}
              disabled={
                running || !canExecute || notStudioOwned || (llm ? !llm.configured : false)
              }
              className="app-btn app-btn-primary inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <HiOutlineSparkles className="h-4 w-4" />
              {running ? 'Refining…' : 'Refine'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export default RefineDialog
