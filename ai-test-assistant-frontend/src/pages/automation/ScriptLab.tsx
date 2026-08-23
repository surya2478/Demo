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
  HiOutlineExternalLink,
  HiOutlineSparkles,
  HiOutlinePencil
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
  const errors = gate.errors ?? []
  const warnings = gate.warnings ?? []
  const title = [...errors, ...warnings].join(' · ')
  return (
    <span title={title || 'All static checks passed'}>
      <StatusBadge tone={gate.passed ? 'success' : 'danger'} size="sm">
        {gate.passed ? 'Gate passed' : `Gate failed (${errors.length})`}
      </StatusBadge>
    </span>
  )
}

/**
 * How the script was produced. "Compiled" means the deterministic compiler
 * built it from the structured steps; "LLM-authored" means a model wrote it,
 * which is the only route for the generate-only frameworks. Worth showing per
 * script rather than per framework: the distinction decides how much a reviewer
 * should trust the locators.
 */
const ModeBadge: React.FC<{ script: ScriptAsset }> = ({ script }) => (
  <StatusBadge tone={script.generation_mode === 'compiled' ? 'info' : 'neutral'} size="sm">
    {script.generation_mode === 'compiled' ? 'Compiled' : 'LLM-authored'}
  </StatusBadge>
)

const ScriptLab: React.FC = () => {
  const { canExecute, runtime } = useAutomationContext()

  const [cases, setCases] = useState<ScriptLabCase[]>([])
  const [counts, setCounts] = useState<{ approved_cases: number; by_framework: Record<string, number> }>({
    approved_cases: 0,
    by_framework: {}
  })
  const [frameworks, setFrameworks] = useState<FrameworkInfo[]>([])
  const [framework, setFramework] = useState('playwright')
  /**
   * Whether generating keeps the existing script and adds a version alongside
   * it. Was hardcoded true, so every Generate silently produced a v2, v3, v4 —
   * the user now decides, which is what the source studio does.
   */
  const [newVersion, setNewVersion] = useState(false)
  /** Recorded on the run so its history says which environment it hit. */
  const [environment, setEnvironment] = useState('SIT')
  const [slowMoMs, setSlowMoMs] = useState<number>(1000)

  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [selectedCases, setSelectedCases] = useState<Set<number>>(new Set())
  const [viewing, setViewing] = useState<ScriptAsset | null>(null)
  const [editingScript, setEditingScript] = useState<ScriptAsset | null>(null)
  const [editCode, setEditCode] = useState<string>('')
  const [savingEdit, setSavingEdit] = useState<boolean>(false)
  const [editError, setEditError] = useState<string | null>(null)

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

  /** Scripts for the selected framework — what Generate and Delete act on. */
  /**
   * Execute the selected scripts once.
   *
   * This is the only route by which a generated script becomes a run: the
   * backend turns each script into an AutomationRun, so its log, evidence and
   * cancellation behave like anything else on the Runs screen, and dry_run_key
   * is the join back to the script.
   */
  const handleDryRun = () =>
    runAction('dry-run', async () => {
      const res = await automationService.dryRunScripts({
        script_ids: selectedScriptIds,
        environment: environment.trim() || null,
        base_url: null,
        slow_mo_ms: slowMoMs
      })
      if (res.refused?.length) {
        setNotice(
          `${res.queued ?? 0} queued. ${res.refused.length} refused — ` +
            res.refused.map((r: any) => `${r.script_id}: ${r.reason}`).join(' · ')
        )
      }
    })

  const scriptsOf = (testCase: ScriptLabCase) =>
    testCase.scripts.filter(s => s.framework === framework)

  /**
   * Every script on the case, newest framework-version first.
   *
   * Separate from scriptsOf on purpose: the row reports what exists across all
   * frameworks, while the action buttons still operate on the selected one.
   */
  const allScriptsOf = (testCase: ScriptLabCase) =>
    [...testCase.scripts].sort(
      (a, b) => a.framework.localeCompare(b.framework) || a.version - b.version
    )

  const frameworkLabel = (name: string) =>
    frameworks.find(f => f.name === name)?.label ??
    name.charAt(0).toUpperCase() + name.slice(1)

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
        // No Base URL field on this screen any more: the compiler falls back
        // to the case's own application_url, which refinement already set.
        base_url: null,
        regenerate: newVersion
      })
      if (res.skipped?.length) {
        setNotice(
          `${res.generated} generated. ${res.skipped.length} skipped — ` +
            res.skipped.map(s => `${s.display_id}: ${s.reason}`).join(' · ')
        )
      }
    })

  const handleSaveEdit = async () => {
    if (!editingScript) return
    setSavingEdit(true)
    setEditError(null)
    try {
      const updated = await automationService.editScript(editingScript.id, editCode)
      setNotice(`Saved edits to ${updated.file_name}`)
      setEditingScript(null)
      await load()
    } catch (err: any) {
      setEditError(err?.message ?? 'Failed to save script edits.')
    } finally {
      setSavingEdit(false)
    }
  }

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
        noPadding
        actions={
          /*
            Order matches the source studio's Script Lab, deliberately:
            framework, new-version, Generate, Dry run, Download all,
            <Framework> only, Delete. People move between the two screens and
            reach for the same button in the same place.

            Base URL is gone -- the compiler falls back to the case's own
            application_url, which refinement already sets. Environment stays,
            because it labels the run a dry run creates and there is nowhere
            else to say it.
          */
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={framework}
                onChange={e => setFramework(e.target.value)}
                className="app-input w-[150px]"
                aria-label="Framework"
              >
                {(frameworks.length
                  ? frameworks
                  : [{ name: 'playwright', label: 'Playwright', runnable: true }]
                ).map(fw => (
                  <option key={fw.name} value={fw.name}>
                    {fw.label}
                  </option>
                ))}
              </select>

              <label
                className="inline-flex items-center gap-1.5 text-[12px] text-app-secondary"
                title="Generating again replaces the current script unless this is ticked, in which case it is kept and a new version is added alongside it"
              >
                <input
                  type="checkbox"
                  checked={newVersion}
                  onChange={e => setNewVersion(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                New version if one exists
              </label>

              <button
                type="button"
                onClick={handleGenerate}
                disabled={!anySelected || !canExecute || busy !== null}
                className="app-btn app-btn-primary inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <HiOutlineCode className="h-4 w-4" />
                {busy === 'generate' ? 'Generating…' : 'Generate scripts'}
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
                    : 'Execute the selected scripts once. Each becomes a run on the Runs screen.'
                }
                className="app-btn app-btn-secondary inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <HiOutlinePlay className="h-4 w-4" />
                {busy === 'dry-run' ? 'Queueing…' : 'Dry run'}
                {selectedScriptIds.length ? ` (${selectedScriptIds.length})` : ''}
              </button>

              <input
                value={environment}
                onChange={e => setEnvironment(e.target.value)}
                placeholder="SIT"
                className="app-input w-16 text-[12px]"
                aria-label="Environment"
                title="Recorded on the run, so its history says which environment it hit"
              />

              <select
                value={slowMoMs}
                onChange={e => setSlowMoMs(Number(e.target.value))}
                className="app-input text-[12px] w-[140px]"
                aria-label="Execution speed"
                title="Delay between actions: Safe (1000ms) for public WAF apps like eand.ae, Fast (0ms) for internal CI"
              >
                <option value={1000}>Safe / WAF (1s)</option>
                <option value={0}>Fast / CI (0s)</option>
                <option value={500}>Balanced (0.5s)</option>
                <option value={2000}>Debug (2s)</option>
              </select>

              <button
                type="button"
                onClick={() =>
                  runAction('download', async () =>
                    saveBlob(
                      // No framework: every script, foldered by framework.
                      await automationService.downloadScriptBundle(),
                      'automation-scripts.zip'
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
                  runAction('download-framework', async () =>
                    saveBlob(
                      await automationService.downloadScriptBundle(framework),
                      `automation-scripts-${framework}.zip`
                    )
                  )
                }
                disabled={busy !== null}
                title={`Download only the ${activeFramework?.label ?? framework} scripts`}
                className="app-btn app-btn-secondary inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <HiOutlineDownload className="h-4 w-4" />
                {activeFramework?.label ?? framework} only
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
                Delete scripts
                {selectedScriptIds.length ? ` (${selectedScriptIds.length})` : ''}
              </button>

              <button
                type="button"
                onClick={() => void load()}
                className="app-btn app-btn-ghost inline-flex items-center gap-1.5"
                title="Reload"
                aria-label="Reload"
              >
                <HiOutlineRefresh className="h-4 w-4" />
              </button>
            </div>

          </div>
        }
      >
        {!runnable ? (
          <div className="mx-5 mt-4 flex items-start gap-2 rounded-app border border-orange-200 bg-app-warning-bg px-3 py-2.5 text-[12px] text-app-warning">
            <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>
              {activeFramework?.label} is generate-only in this deployment. Scripts are
              produced and downloadable, but no runner exists to execute them.
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
              description="Approve cases classified as Automation in the Automation Workspace tab, and they arrive here ready to generate."
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
                  <th className="text-left text-[11px]">TC ID</th>
                  <th className="text-left text-[11px]">Title</th>
                  <th className="text-left text-[11px]">Steps</th>
                  <th className="text-left text-[11px]">Generated scripts</th>
                </tr>
              </thead>
              <tbody>
                {cases.map(testCase => {
                  // Every framework, not just the selected one. The dropdown
                  // chooses what Generate produces; the row reports what
                  // exists, so a case carrying both Playwright and Katalon
                  // shows both instead of hiding one behind the selector.
                  const scripts = allScriptsOf(testCase)
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
                      <td className="whitespace-nowrap font-mono text-[11px] text-app-primary">
                        {testCase.tc_display_id}
                      </td>
                      <td>
                        <p className="max-w-sm truncate text-[12px] font-medium text-app-primary">
                          {testCase.title}
                        </p>
                      </td>
                      <td className="text-[11px] text-app-secondary">{testCase.steps}</td>
                      <td>
                        {scripts.length ? (
                          <div className="space-y-1">
                            {scripts.map(script => (
                              <div key={script.id} className="flex flex-wrap items-center gap-1.5">
                                <span
                                  className="inline-flex items-center gap-1 rounded-app border border-app px-1.5 py-0.5 text-[11px] text-app-primary"
                                  title={script.file_name}
                                >
                                  <HiOutlineCode className="h-3 w-3 text-app-secondary" />
                                  {frameworkLabel(script.framework)}
                                  <span className="text-app-secondary">v{script.version}</span>
                                </span>

                                <ModeBadge script={script} />
                                <GateBadge script={script} />

                                <StatusBadge
                                  tone={
                                    script.dry_run_status && DRY_RUN_TONE[script.dry_run_status]
                                      ? DRY_RUN_TONE[script.dry_run_status]
                                      : 'neutral'
                                  }
                                  size="sm"
                                  dot={script.dry_run_status === 'running'}
                                >
                                  {script.dry_run_status ? script.dry_run_status.replace('_', ' ') : 'not run'}
                                </StatusBadge>

                                {script.edited_by_user ? (
                                  <StatusBadge tone="warning" size="sm">
                                    edited
                                  </StatusBadge>
                                ) : null}

                                {/* A dry run IS a run, so its evidence lives on
                                    the Runs tab rather than in a panel here. */}
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

                                <button
                                  type="button"
                                  onClick={() => setViewing(script)}
                                  className="rounded-md p-1 text-app-secondary transition hover:bg-app-surface-muted hover:text-app-primary"
                                  title={`View ${script.file_name}`}
                                  aria-label={`View ${script.file_name}`}
                                >
                                  <HiOutlineEye className="h-3.5 w-3.5" />
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
                                  className="rounded-md p-1 text-app-secondary transition hover:bg-app-surface-muted hover:text-app-primary disabled:opacity-40"
                                  title={`Download ${script.file_name}`}
                                  aria-label={`Download ${script.file_name}`}
                                >
                                  <HiOutlineDownload className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingScript(script)
                                    setEditCode(script.code || '')
                                    setEditError(null)
                                  }}
                                  disabled={!canExecute || busy !== null}
                                  className="rounded-md p-1 text-app-secondary transition hover:bg-app-surface-muted hover:text-app-brand-600 disabled:opacity-40"
                                  title={`Edit ${script.file_name}`}
                                  aria-label={`Edit ${script.file_name}`}
                                >
                                  <HiOutlinePencil className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-[11px] text-app-secondary">Not generated</span>
                        )}
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
              {canExecute ? (
                <button
                  type="button"
                  onClick={() =>
                    runAction('heal-script', async () => {
                      const healRes = await automationService.healScript(viewing.id)
                      setViewing({
                        ...viewing,
                        code: healRes.healed_code
                      })
                      setNotice(`Healed with AI: ${healRes.diagnosis}`)
                    })
                  }
                  disabled={busy !== null}
                  className="app-btn inline-flex items-center gap-1.5 bg-gradient-to-r from-emerald-600 to-teal-600 text-white font-medium shadow-sm hover:from-emerald-700 hover:to-teal-700 disabled:opacity-50"
                  title="Analyze failure logs & Discovery catalogue to repair this script"
                >
                  <HiOutlineSparkles className="h-4 w-4" />
                  Heal & Regenerate
                </button>
              ) : null}
              {viewing.dry_run_key ? (
                <Link
                  to={`/automation/runs/${viewing.dry_run_key}`}
                  className="app-btn app-btn-secondary inline-flex items-center gap-1.5"
                >
                  <HiOutlineExternalLink className="h-4 w-4" />
                  Open the run
                </Link>
              ) : null}
              {canExecute ? (
                <button
                  type="button"
                  onClick={() => {
                    const target = viewing
                    setViewing(null)
                    setEditingScript(target)
                    setEditCode(target.code || '')
                    setEditError(null)
                  }}
                  className="app-btn app-btn-secondary inline-flex items-center gap-1.5"
                  title="Hand-edit this script's code"
                >
                  <HiOutlinePencil className="h-4 w-4" />
                  Edit Code
                </button>
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

      {editingScript ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
          onClick={e => {
            if (e.target === e.currentTarget && !savingEdit) setEditingScript(null)
          }}
          role="dialog"
          aria-modal="true"
        >
          <div className="flex h-[92vh] w-full max-w-[1100px] flex-col overflow-hidden rounded-[24px] border border-app bg-app-surface shadow-[0_28px_70px_rgba(15,23,42,0.22)]">
            <div className="flex items-start justify-between gap-3 border-b border-app bg-app-surface-muted px-5 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-app-brand-500/10 text-app-brand-600">
                    <HiOutlinePencil className="h-4 w-4" />
                  </span>
                  <h2 className="truncate text-[15px] font-bold text-app-primary">
                    Edit Script · {editingScript.test_case_display_id} · {editingScript.file_name}
                  </h2>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <StatusBadge tone="info" size="sm">
                    {editingScript.framework}
                  </StatusBadge>
                  <StatusBadge tone="neutral" size="sm">
                    v{editingScript.version}
                  </StatusBadge>
                  <span className="text-[12px] text-app-secondary">
                    {editCode.split('\n').length} lines · {editCode.length} characters
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => !savingEdit && setEditingScript(null)}
                disabled={savingEdit}
                className="rounded-md p-1.5 text-app-secondary transition hover:bg-app-surface hover:text-app-primary disabled:opacity-40"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="app-scroll flex-1 space-y-3 overflow-y-auto px-5 py-4">
              {editError ? (
                <div className="rounded-app border border-red-200 bg-app-danger-bg px-3 py-2.5 text-[12px] text-app-danger flex items-center justify-between">
                  <span>{editError}</span>
                  <button type="button" onClick={() => setEditError(null)} className="text-xs font-semibold hover:underline">
                    Dismiss
                  </button>
                </div>
              ) : null}

              <div className="flex flex-col h-[calc(100%-20px)] min-h-[460px] rounded-xl border border-slate-700 bg-slate-950 overflow-hidden shadow-inner">
                <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-4 py-2 text-xs text-slate-400 font-mono">
                  <span>{editingScript.file_name}</span>
                  <span>TypeScript / JavaScript</span>
                </div>
                <textarea
                  value={editCode}
                  onChange={e => setEditCode(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Tab') {
                      e.preventDefault()
                      const target = e.currentTarget
                      const start = target.selectionStart
                      const end = target.selectionEnd
                      setEditCode(editCode.substring(0, start) + '  ' + editCode.substring(end))
                      setTimeout(() => {
                        target.selectionStart = target.selectionEnd = start + 2
                      }, 0)
                    }
                  }}
                  className="flex-1 w-full resize-none bg-slate-950 p-4 font-mono text-[13px] leading-relaxed text-emerald-400 focus:outline-none selection:bg-emerald-500/30 selection:text-white"
                  spellCheck={false}
                  placeholder="// Paste or edit your Playwright automation script here..."
                />
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-app bg-app-surface-muted px-5 py-3.5">
              <button
                type="button"
                onClick={() => setEditCode(editingScript.code || '')}
                disabled={savingEdit || editCode === editingScript.code}
                className="text-[12px] text-app-secondary hover:text-app-primary disabled:opacity-40"
              >
                Reset to current code
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setEditingScript(null)}
                  disabled={savingEdit}
                  className="app-btn app-btn-secondary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveEdit}
                  disabled={savingEdit || !canExecute}
                  className="app-btn app-btn-primary inline-flex items-center gap-1.5"
                >
                  <HiOutlineCheckCircle className="h-4 w-4" />
                  {savingEdit ? 'Saving Changes…' : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default ScriptLab
