/**
 * --- Automation Script Lab ----------------------------------------------
 *
 * Generate, review, dry-run and download scripts for approved automation test
 * cases.
 *
 * Two things are deliberate here. The working set is only cases that are both
 * approved AND classified Automation — generating from anything else produces
 * a script nobody agreed should exist. And a dry run links straight through to
 * the Runs tab rather than rendering its own evidence panel: a dry run IS an
 * ordinary run, so its screenshot, video, trace and log already have a home.
 *
 * Katalon and Appium are generate-only. That is stated on the row rather than
 * discovered on a disabled button, because no runner exists for them here or
 * upstream.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  HiOutlineCode,
  HiOutlinePlay,
  HiOutlineDownload,
  HiOutlineTrash,
  HiOutlineRefresh,
  HiOutlineExclamationCircle,
  HiOutlineCheckCircle,
  HiOutlineEye,
  HiOutlineExternalLink
} from 'react-icons/hi'
import automationService from '../../services/automationService'
import { useAutomationContext } from '../../components/automation/AutomationContext'
import SectionCard from '../../components/ui/SectionCard'
import EmptyState from '../../components/ui/EmptyState'
import LoadingSkeleton from '../../components/ui/LoadingSkeleton'
import StatusBadge from '../../components/ui/StatusBadge'
import { CodeViewer } from '../../components/automation/CodeViewer'
import { StatTile } from '../../components/automation/workbenchPresentation'
import { isDryRunSettled } from '../../types/automation'
import type {
  DryRunStatus,
  FrameworkInfo,
  ScriptAsset,
  ScriptLabCase
} from '../../types/automation'

const DRY_RUN_TONE: Record<DryRunStatus, 'success' | 'danger' | 'warning' | 'info' | 'neutral'> = {
  not_run: 'neutral',
  queued: 'info',
  running: 'info',
  passed: 'success',
  failed: 'danger',
  blocked: 'warning'
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/** The static gate's verdict, with its reasons — never a bare tick. */
const GateBadge: React.FC<{ script: ScriptAsset }> = ({ script }) => {
  const gate = script.static_gate_result
  if (!gate) return <span className="text-[11px] text-app-secondary">—</span>
  const title = [...(gate.errors ?? []), ...(gate.warnings ?? [])].join(' · ')
  return (
    <span title={title || 'All static checks passed'}>
      <StatusBadge tone={gate.passed ? 'success' : 'danger'} size="sm">
        {gate.passed ? 'Gate passed' : `Gate failed (${gate.errors.length})`}
      </StatusBadge>
    </span>
  )
}

const ScriptLab: React.FC = () => {
  const { canExecute, runtime } = useAutomationContext()

  const [cases, setCases] = useState<ScriptLabCase[]>([])
  const [counts, setCounts] = useState<{ approved_cases: number; by_framework: Record<string, number> }>({
    approved_cases: 0,
    by_framework: {}
  })
  const [frameworks, setFrameworks] = useState<FrameworkInfo[]>([])
  const [framework, setFramework] = useState('playwright')
  const [baseUrl, setBaseUrl] = useState('')
  const [environment, setEnvironment] = useState('SIT')

  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [selectedCases, setSelectedCases] = useState<Set<number>>(new Set())
  const [viewing, setViewing] = useState<ScriptAsset | null>(null)

  const pollRef = useRef<number | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [listing, fw] = await Promise.all([
        automationService.listScriptLabCases(),
        automationService.listFrameworks()
      ])
      setCases(listing.cases ?? [])
      setCounts(listing.counts ?? { approved_cases: 0, by_framework: {} })
      setFrameworks(fw.frameworks ?? [])
    } catch (err: any) {
      setError(err?.message ?? 'The Script Lab could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    return () => {
      if (pollRef.current !== null) window.clearTimeout(pollRef.current)
    }
  }, [load])

  /** Follow a dry run until it settles, then refresh once from the real state. */
  const pollDryRun = useCallback(
    async (scriptId: number) => {
      try {
        const state = await automationService.getDryRun(scriptId)
        if (isDryRunSettled(state.dry_run_status) && state.dry_run_status !== 'not_run') {
          await load()
          return
        }
        pollRef.current = window.setTimeout(() => void pollDryRun(scriptId), 2000)
      } catch {
        await load()
      }
    },
    [load]
  )

  const scriptsOf = (testCase: ScriptLabCase) =>
    testCase.scripts.filter(s => s.framework === framework)

  const selectedScriptIds = useMemo(() => {
    const ids: number[] = []
    cases
      .filter(c => selectedCases.has(c.id))
      .forEach(c => scriptsOf(c).forEach(s => ids.push(s.id)))
    return ids
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cases, selectedCases, framework])

  const runAction = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    setNotice(null)
    try {
      await fn()
      await load()
    } catch (err: any) {
      setError(err?.message ?? `${label} failed.`)
    } finally {
      setBusy(null)
    }
  }

  const handleGenerate = () =>
    runAction('generate', async () => {
      const res = await automationService.generateScripts({
        case_ids: Array.from(selectedCases),
        framework,
        base_url: baseUrl.trim() || null,
        regenerate: true
      })
      if (res.skipped?.length) {
        setNotice(
          `${res.generated} generated. ${res.skipped.length} skipped — ` +
            res.skipped.map(s => `${s.display_id}: ${s.reason}`).join(' · ')
        )
      }
    })

  const handleDryRun = () =>
    runAction('dry-run', async () => {
      const res = await automationService.dryRunScripts({
        script_ids: selectedScriptIds,
        environment: environment.trim() || null,
        base_url: baseUrl.trim() || null
      })
      if (res.refused?.length) {
        setNotice(
          `${res.queued.length} queued. ${res.refused.length} refused — ` +
            res.refused.map(r => r.reason).join(' · ')
        )
      }
      if (res.queued?.length) void pollDryRun(res.queued[0].script_id)
    })

  const activeFramework = frameworks.find(f => f.name === framework)
  const runnable = activeFramework?.runnable ?? framework === 'playwright'
  const anySelected = selectedCases.size > 0

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Approved automation TCs" value={loading ? '—' : counts.approved_cases} />
        {(frameworks.length ? frameworks : [{ name: 'playwright', label: 'Playwright', runnable: true }]).map(
          fw => (
            <StatTile
              key={fw.name}
              label={`${fw.label} scripts`}
              value={loading ? '—' : counts.by_framework?.[fw.name] ?? 0}
            />
          )
        )}
      </div>

      <SectionCard
        title="Approved automation test cases"
        description="Only cases that are approved and classified Automation appear here. Generating from anything else would produce a script nobody agreed should exist."
        noPadding
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={framework}
              onChange={e => setFramework(e.target.value)}
              className="app-input"
              aria-label="Framework"
            >
              {(frameworks.length
                ? frameworks
                : [{ name: 'playwright', label: 'Playwright', runnable: true }]
              ).map(fw => (
                <option key={fw.name} value={fw.name}>
                  {fw.label}
                  {fw.runnable ? '' : ' (generate only)'}
                </option>
              ))}
            </select>
            <input
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder="Base URL (optional)"
              className="app-input w-[190px]"
              aria-label="Base URL"
            />
            <input
              value={environment}
              onChange={e => setEnvironment(e.target.value)}
              placeholder="SIT"
              className="app-input w-20"
              aria-label="Environment"
              title="Recorded on the dry run, so its history says which environment it hit"
            />
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!anySelected || !canExecute || busy !== null}
              className="app-btn app-btn-primary inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <HiOutlineCode className="h-4 w-4" />
              {busy === 'generate' ? 'Generating…' : `Generate ${activeFramework?.label ?? ''}`}
            </button>
            <button
              type="button"
              onClick={handleDryRun}
              disabled={
                selectedScriptIds.length === 0 || !canExecute || !runnable || busy !== null
              }
              title={
                !runnable
                  ? `${activeFramework?.label} is generate-only — no runner exists for it.`
                  : 'Execute the selected scripts once, against the real application'
              }
              className="app-btn app-btn-secondary inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <HiOutlinePlay className="h-4 w-4" />
              {busy === 'dry-run' ? 'Queueing…' : 'Dry run'}
              {selectedScriptIds.length ? ` (${selectedScriptIds.length})` : ''}
            </button>
            <button
              type="button"
              onClick={() =>
                runAction('download', async () =>
                  saveBlob(
                    await automationService.downloadScriptBundle(framework),
                    `automation-scripts-${framework}.zip`
                  )
                )
              }
              disabled={busy !== null}
              className="app-btn app-btn-secondary inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <HiOutlineDownload className="h-4 w-4" />
              Download all
            </button>
            <button
              type="button"
              onClick={() =>
                runAction('delete', async () => {
                  await automationService.deleteScripts(selectedScriptIds)
                  setSelectedCases(new Set())
                })
              }
              disabled={selectedScriptIds.length === 0 || !canExecute || busy !== null}
              title="Delete every script generated for the selected test cases"
              className="app-btn app-btn-secondary inline-flex items-center gap-1.5 text-app-danger disabled:opacity-50"
            >
              <HiOutlineTrash className="h-4 w-4" />
              Delete
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="app-btn app-btn-secondary inline-flex items-center gap-1.5"
              title="Reload"
            >
              <HiOutlineRefresh className="h-4 w-4" />
            </button>
          </div>
        }
      >
        {!runnable ? (
          <div className="mx-5 mt-4 flex items-start gap-2 rounded-app border border-orange-200 bg-app-warning-bg px-3 py-2.5 text-[12px] text-app-warning">
            <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>
              {activeFramework?.label} is generate-only in this deployment. Scripts are produced
              and downloadable, but no runner exists for them, so Dry run stays disabled.
            </span>
          </div>
        ) : null}

        {runtime && !runtime.ready ? (
          <div className="mx-5 mt-4 flex items-start gap-2 rounded-app border border-orange-200 bg-app-warning-bg px-3 py-2.5 text-[12px] text-app-warning">
            <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>The browser runtime is unavailable, so a dry run would be refused.</span>
          </div>
        ) : null}

        {notice ? (
          <div className="mx-5 mt-4 flex items-start gap-2 rounded-app border border-orange-200 bg-app-warning-bg px-3 py-3 text-[12px] text-app-warning">
            <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{notice}</span>
          </div>
        ) : null}

        {error ? (
          <div className="mx-5 mt-4 flex items-start gap-2 rounded-app border border-red-200 bg-app-danger-bg px-3 py-3 text-[13px] text-app-danger">
            <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 4 }, (_, i) => (
              <LoadingSkeleton key={i} className="h-12 w-full" rounded="lg" />
            ))}
          </div>
        ) : cases.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No approved automation test cases"
              description="Approve cases classified as Automation in the TC Coverage Assessment tab, and they arrive here ready to generate."
              icon={<HiOutlineCode className="h-5 w-5" />}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="app-table">
              <thead>
                <tr>
                  <th className="text-left">
                    <input
                      type="checkbox"
                      checked={cases.length > 0 && cases.every(c => selectedCases.has(c.id))}
                      onChange={e =>
                        setSelectedCases(e.target.checked ? new Set(cases.map(c => c.id)) : new Set())
                      }
                      className="h-3.5 w-3.5"
                      aria-label="Select all test cases"
                    />
                  </th>
                  <th className="text-left">TC ID</th>
                  <th className="text-left">Title</th>
                  <th className="text-left">Steps</th>
                  <th className="text-left">{activeFramework?.label ?? 'Script'}</th>
                  <th className="text-left">Static gate</th>
                  <th className="text-left">Dry run</th>
                  <th className="text-right"></th>
                </tr>
              </thead>
              <tbody>
                {cases.map(testCase => {
                  const scripts = scriptsOf(testCase)
                  const script = scripts[0]
                  return (
                    <tr key={testCase.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedCases.has(testCase.id)}
                          onChange={() =>
                            setSelectedCases(prev => {
                              const next = new Set(prev)
                              if (next.has(testCase.id)) next.delete(testCase.id)
                              else next.add(testCase.id)
                              return next
                            })
                          }
                          className="h-3.5 w-3.5"
                          aria-label={`Select ${testCase.tc_display_id}`}
                        />
                      </td>
                      <td className="whitespace-nowrap font-mono text-[12px] text-app-primary">
                        {testCase.tc_display_id}
                      </td>
                      <td>
                        <div className="max-w-sm">
                          <p className="truncate font-medium text-app-primary">{testCase.title}</p>
                          {testCase.application_url ? (
                            <p className="truncate text-[11px] text-app-secondary/70">
                              {testCase.application_url}
                            </p>
                          ) : null}
                        </div>
                      </td>
                      <td className="text-[12px] text-app-secondary">{testCase.steps}</td>
                      <td>
                        {script ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-[11px] text-app-primary">
                              {script.file_name}
                            </span>
                            {script.version > 1 ? (
                              <span className="text-[11px] text-app-secondary">
                                v{script.version}
                              </span>
                            ) : null}
                            {script.edited_by_user ? (
                              <StatusBadge tone="warning" size="sm">
                                edited
                              </StatusBadge>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-[12px] text-app-secondary">Not generated</span>
                        )}
                      </td>
                      <td>{script ? <GateBadge script={script} /> : <span className="text-[11px] text-app-secondary">—</span>}</td>
                      <td>
                        {script ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <StatusBadge
                              tone={DRY_RUN_TONE[script.dry_run_status] ?? 'neutral'}
                              size="sm"
                              dot={script.dry_run_status === 'running'}
                            >
                              {script.dry_run_status.replace('_', ' ')}
                            </StatusBadge>
                            {/* A dry run IS a run, so its evidence lives on the
                                Runs tab rather than in a second panel here. */}
                            {script.dry_run_key ? (
                              <Link
                                to={`/automation/runs/${script.dry_run_key}`}
                                className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-app-brand-700 hover:underline"
                                title="Open the run, with its screenshot, video, trace and log"
                              >
                                evidence
                                <HiOutlineExternalLink className="h-3 w-3" />
                              </Link>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-[11px] text-app-secondary">—</span>
                        )}
                      </td>
                      <td className="text-right">
                        <div className="inline-flex items-center gap-0.5">
                          {script ? (
                            <>
                              <button
                                type="button"
                                onClick={() => setViewing(script)}
                                className="rounded-md p-1.5 text-app-secondary transition hover:bg-app-surface-muted hover:text-app-primary"
                                title="View the generated code"
                              >
                                <HiOutlineEye className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  runAction('download', async () =>
                                    saveBlob(
                                      await automationService.downloadScript(script.id),
                                      script.file_name
                                    )
                                  )
                                }
                                disabled={busy !== null}
                                className="rounded-md p-1.5 text-app-secondary transition hover:bg-app-surface-muted hover:text-app-primary disabled:opacity-40"
                                title={`Download ${script.file_name}`}
                              >
                                <HiOutlineDownload className="h-4 w-4" />
                              </button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {viewing ? (
        <div
          className="fixed inset-0 z-[65] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
          onClick={e => {
            if (e.target === e.currentTarget) setViewing(null)
          }}
          role="dialog"
          aria-modal="true"
        >
          <div className="flex h-[92vh] w-full max-w-[1000px] flex-col overflow-hidden rounded-[24px] border border-app bg-app-surface shadow-[0_28px_70px_rgba(15,23,42,0.18)]">
            <div className="flex items-start justify-between gap-3 border-b border-app bg-app-surface-muted px-5 py-4">
              <div className="min-w-0">
                <h2 className="truncate text-[15px] font-bold text-app-primary">
                  {viewing.test_case_display_id} · {viewing.file_name}
                </h2>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <StatusBadge tone="info" size="sm">
                    {viewing.framework}
                  </StatusBadge>
                  <StatusBadge tone="neutral" size="sm">
                    {viewing.generation_mode}
                  </StatusBadge>
                  <GateBadge script={viewing} />
                </div>
              </div>
              <button
                type="button"
                onClick={() => setViewing(null)}
                className="rounded-md p-1.5 text-app-secondary transition hover:bg-app-surface hover:text-app-primary"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="app-scroll flex-1 space-y-3 overflow-y-auto px-5 py-4">
              {viewing.static_gate_result && !viewing.static_gate_result.passed ? (
                <div className="rounded-app border border-red-200 bg-app-danger-bg px-3 py-3 text-[12px] text-app-danger">
                  <div className="font-semibold">Static gate failed</div>
                  <ul className="mt-1 space-y-0.5">
                    {viewing.static_gate_result.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {viewing.static_gate_result?.warnings?.length ? (
                <div className="rounded-app border border-orange-200 bg-app-warning-bg px-3 py-3 text-[12px] text-app-warning">
                  <div className="font-semibold">
                    {viewing.static_gate_result.warnings.length} locator warning(s)
                  </div>
                  <ul className="mt-1 space-y-0.5">
                    {viewing.static_gate_result.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {viewing.setup_notes?.length ? (
                <div className="rounded-app border border-app bg-app-surface-muted/40 px-3 py-3 text-[12px] text-app-secondary">
                  <div className="font-semibold text-app-primary">Before running</div>
                  <ul className="mt-1 space-y-0.5">
                    {viewing.setup_notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <CodeViewer
                code={viewing.code}
                language={viewing.language === 'typescript' ? 'typescript' : 'javascript'}
                fileName={viewing.file_name}
                downloadable
                maxHeight="52vh"
              />

              {viewing.execution_command ? (
                <p className="text-[12px] text-app-secondary">
                  Runs with{' '}
                  <span className="font-mono text-app-primary">{viewing.execution_command}</span>
                </p>
              ) : null}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-app bg-app-surface-muted px-5 py-3">
              {viewing.dry_run_key ? (
                <Link
                  to={`/automation/runs/${viewing.dry_run_key}`}
                  className="app-btn app-btn-secondary inline-flex items-center gap-1.5"
                >
                  <HiOutlineExternalLink className="h-4 w-4" />
                  Open the run
                </Link>
              ) : null}
              <button
                type="button"
                onClick={() =>
                  runAction('approve-script', async () => {
                    await automationService.decideScript(viewing.id, 'approve')
                    setViewing(null)
                  })
                }
                disabled={
                  !canExecute ||
                  busy !== null ||
                  viewing.static_gate_result?.passed === false ||
                  viewing.status === 'approved'
                }
                title={
                  viewing.static_gate_result?.passed === false
                    ? 'The static gate failed — fix it before approving.'
                    : undefined
                }
                className="app-btn app-btn-primary inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <HiOutlineCheckCircle className="h-4 w-4" />
                {viewing.status === 'approved' ? 'Approved' : 'Approve script'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default ScriptLab
