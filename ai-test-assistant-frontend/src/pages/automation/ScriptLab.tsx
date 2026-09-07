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
import { useConfirm } from '../../components/ui/ConfirmDialog'
import StatusBadge from '../../components/ui/StatusBadge'
import { CodeViewer } from '../../components/automation/CodeViewer'
import { StatTile } from '../../components/automation/workbenchPresentation'
import { formatWhen } from '../../components/automation/runPresentation'
import { isDryRunSettled, readSelectedApplicationId } from '../../types/automation'
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
/**
 * Hidden on request: the per-script status cluster in the grid -- compile mode,
 * the static gate verdict, the dry-run state and the evidence link.
 *
 * A flag rather than a deletion, because none of it is dead: GateBadge and the
 * evidence link still render in the script viewer panel below, so opening a
 * script still shows its gate result and still reaches its run. Flip this to
 * true to put the row badges back.
 */
const SHOW_SCRIPT_STATUS_BADGES = false

const GateBadge: React.FC<{ script: ScriptAsset }> = ({ script }) => {
  const gate = script.static_gate_result
  if (!gate) return <span className="text-[12px] text-app-secondary">—</span>
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


/**
 * Hidden for now, not deleted.
 *
 * The tiles still compute correctly and the data behind them is still fetched,
 * so this is one line to put back when the row is wanted again -- which is why
 * it is a flag rather than a commented-out block or a deletion.
 */
const SHOW_STAT_TILES = false

const ScriptLab: React.FC = () => {
  const { canExecute, runtime } = useAutomationContext()
  const confirm = useConfirm()

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

  /*
   * --- One table, two groups ---------------------------------------------
   *
   * Cases still waiting for a script on top, cases that already have one
   * underneath. Ordered rather than split into two <table>s: a second table
   * carries its own column widths and would drift out of alignment with the
   * first as soon as their content differed.
   *
   * "Has a script" counts every framework, matching what the row reports --
   * a case with a Katalon script but no Playwright one has been generated for,
   * and belongs below.
   */
  const hasScript = (testCase: ScriptLabCase) => testCase.scripts.length > 0

  /** The group a band heads -- what its checkbox selects. */
  const groupOf = (generated: boolean) =>
    generated ? groupedCases.generated : groupedCases.pending

  /* One group at a time, so selecting all of one leaves the other alone. */
  const toggleGroup = (group: ScriptLabCase[], checked: boolean) =>
    setSelectedCases(prev => {
      const next = new Set(prev)
      group.forEach(testCase => (checked ? next.add(testCase.id) : next.delete(testCase.id)))
      return next
    })

  const groupedCases = useMemo(() => {
    const pending = cases.filter(testCase => !hasScript(testCase))
    const generated = cases.filter(hasScript)
    return { pending, generated, rows: [...pending, ...generated] }
  }, [cases])

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

  /**
   * Delete the selected test cases outright, scripts and all.
   *
   * Distinct from "Delete scripts", which only clears what was generated and
   * leaves the case in the Lab to be generated again. This removes the entry,
   * so it is the action for a case that should not be here at all -- and it is
   * the one a case showing "Not generated" needs, since that case has no
   * scripts for the other button to act on and leaves it disabled.
   *
   * Confirmed because the two buttons sit together and read alike, while only
   * one of them is reversible by pressing Generate again.
   */
  const handleDeleteCases = async () => {
    const chosen = cases.filter(c => selectedCases.has(c.id))
    if (chosen.length === 0) return
    const count = chosen.length
    const ok = await confirm({
      title: count === 1 ? `Delete ${chosen[0].tc_display_id}?` : `Delete ${count} test cases?`,
      body:
        count === 1
          ? chosen[0].title
          : `${count} selected test cases will be removed from the Script Lab.`,
      consequences: [
        `Every script generated from ${count === 1 ? 'it' : 'them'} is deleted too.`,
        // The distinction the surrounding comment makes: the neighbouring
        // button is the reversible one, and this is not it.
        'Regenerating is not possible afterwards — the test case is gone, not just its scripts.',
        'This cannot be undone.'
      ],
      confirmLabel: count === 1 ? 'Delete test case' : `Delete ${count} test cases`
    })
    if (!ok) return
    void runAction('delete-cases', async () => {
      const res = await automationService.deleteWorkbenchCases(Array.from(selectedCases))
      setSelectedCases(new Set())
      setNotice(
        `${res.deleted} test case(s) deleted` +
          (res.scripts_removed ? `, along with ${res.scripts_removed} script(s).` : '.')
      )
    })
  }

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
        // Which application's discovery catalogue to compile against — the one
        // selected on Application Discovery. Omitting it only works while a
        // single application is registered; naming it keeps the scripts and
        // the grounding badges judged against the same catalogue.
        application_id: readSelectedApplicationId(),
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
      {SHOW_STAT_TILES && (
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
      )}

      {/*
        The card carried the title "Approved automation test cases", which said
        what the grid underneath already says and pushed this toolbar into the
        right half of the header. Dropping it lets the row start at the left
        edge and use the full width, the same shape the Workbench uses.

        Order matches the source studio's Script Lab, deliberately: framework,
        new-version, Generate, Dry run, Download all, <Framework> only, Delete.
        People move between the two screens and reach for the same button in
        the same place.

        Base URL is gone -- the compiler falls back to the case's own
        application_url, which refinement already sets.
      */}
      <SectionCard noPadding>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-app px-5 py-4">
          <select
            value={framework}
            onChange={e => setFramework(e.target.value)}
            className="app-input h-[38px] w-[160px] py-0 text-sm"
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
            className="inline-flex items-center gap-2 text-sm text-app-secondary"
            title="Generating again replaces the current script unless this is ticked, in which case it is kept and a new version is added alongside it"
          >
            <input
              type="checkbox"
              checked={newVersion}
              onChange={e => setNewVersion(e.target.checked)}
              className="h-4 w-4 accent-app-brand-700"
            />
            New Script Version
          </label>

          <button
            type="button"
            onClick={handleGenerate}
            disabled={!anySelected || !canExecute || busy !== null}
            className="app-spark app-spark-primary app-btn app-btn-primary inline-flex items-center gap-2 !px-4 !py-2 text-sm font-semibold disabled:opacity-50"
          >
            <HiOutlineCode className="app-spark-glyph h-[18px] w-[18px]" />
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
            className="app-spark app-btn app-btn-secondary inline-flex items-center gap-2 !px-3 !py-2 text-sm font-medium disabled:opacity-50"
          >
            <HiOutlinePlay className="app-spark-glyph h-[18px] w-[18px]" />
            {busy === 'dry-run' ? 'Queueing…' : 'Dry run'}
            {selectedScriptIds.length ? ` (${selectedScriptIds.length})` : ''}
          </button>

          {/* Environment and execution speed, hidden on request.
              Both still travel with every dry run -- they now take the
              defaults their state was initialised with, `environment`
              "SIT" and `slowMoMs` 1000 (Safe / WAF), which is what the
              controls already showed. Nothing about a run changes; only
              the ability to vary it from this screen is gone. Restore by
              uncommenting. */}
          {/* <input
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
          </select> */}

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
            title="Download every generated script as one zip, foldered by framework"
            className="app-spark app-btn app-btn-secondary inline-flex items-center gap-2 !px-3 !py-2 text-sm font-medium disabled:opacity-50"
          >
            <HiOutlineDownload className="app-spark-glyph h-[18px] w-[18px]" />
            All
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
            className="app-spark app-btn app-btn-secondary inline-flex items-center gap-2 !px-3 !py-2 text-sm font-medium disabled:opacity-50"
          >
            <HiOutlineDownload className="app-spark-glyph h-[18px] w-[18px]" />
            {activeFramework?.label ?? framework}
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
            className="app-spark app-btn app-btn-secondary inline-flex items-center gap-2 !px-3 !py-2 text-sm font-medium text-app-danger disabled:opacity-50"
          >
            <HiOutlineTrash className="app-spark-glyph h-[18px] w-[18px]" />
            Delete scripts
            {selectedScriptIds.length ? ` (${selectedScriptIds.length})` : ''}
          </button>

          <button
            type="button"
            onClick={() => void handleDeleteCases()}
            disabled={!anySelected || !canExecute || busy !== null}
            title="Remove the selected test cases from Automation Studio entirely, including any scripts generated from them"
            className="app-spark app-btn app-btn-secondary inline-flex items-center gap-2 !px-3 !py-2 text-sm font-medium text-app-danger disabled:opacity-50"
          >
            <HiOutlineTrash className="app-spark-glyph h-[18px] w-[18px]" />
            Delete test case
            {selectedCases.size ? ` (${selectedCases.size})` : ''}
          </button>

          <button
            type="button"
            onClick={() => void load()}
            className="app-spark app-btn app-btn-ghost inline-flex items-center gap-2 !px-3 !py-2"
            title="Reload"
            aria-label="Reload"
          >
            <HiOutlineRefresh className="app-spark-glyph h-[18px] w-[18px]" />
          </button>
        </div>
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
                  {/* No select-all here: it selected across both groups at
                      once. Each band carries its own instead. */}
                  <th className="text-left" />
                  {/* Centred over the column rather than pinned to its left
                      edge: TC ID, Title and Generated scripts are all wider
                      than their labels, which left each heading floating away
                      from the data under it. */}
                  <th className="text-center">TC ID</th>
                  <th className="text-center">Title</th>
                  <th className="text-center">Steps</th>
                  <th className="text-center">Added</th>
                  <th className="text-center">Generated scripts</th>
                </tr>
              </thead>
              <tbody>
                {groupedCases.rows.map((testCase, index) => {
                  // Every framework, not just the selected one. The dropdown
                  // chooses what Generate produces; the row reports what
                  // exists, so a case carrying both Playwright and Katalon
                  // shows both instead of hiding one behind the selector.
                  const scripts = allScriptsOf(testCase)
                  const generated = scripts.length > 0
                  const startsGroup =
                    index === 0 || hasScript(groupedCases.rows[index - 1]) !== generated
                  return (
                  <React.Fragment key={testCase.id}>
                    {/* A band only where the group changes, so a lab that is
                        entirely one or the other shows one heading. */}
                    {startsGroup ? (
                      /* Checkbox and heading in one cell, so the heading is not
                         stranded at the start of the Title column. A plain
                         block comment, not {\/* *\/}: this is a ternary's
                         expression slot, not JSX children. */
                      <tr className="bg-app-surface-muted">
                        <td colSpan={6} className="border-b border-app bg-app-surface-muted px-3 py-2">
                          <div className="flex items-center gap-2.5">
                            <input
                              type="checkbox"
                              checked={groupOf(generated).length > 0 && groupOf(generated).every(c => selectedCases.has(c.id))}
                              onChange={event => toggleGroup(groupOf(generated), event.target.checked)}
                              className="h-3.5 w-3.5 flex-shrink-0"
                              aria-label={
                                generated
                                  ? 'Select every case that already has a script'
                                  : 'Select every case awaiting script generation'
                              }
                            />
                            <span
                              className={`text-[13px] font-bold uppercase tracking-[0.08em] ${
                                generated ? 'text-emerald-600' : 'text-app-brand-600'
                              }`}
                            >
                          {generated
                                ? `Script generated (${groupedCases.generated.length})`
                                : `Awaiting script generation (${groupedCases.pending.length})`}
                            </span>
                          </div>
                        </td>
                      </tr>
                    ) : null}
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
                      <td className="whitespace-nowrap font-mono text-app-primary">
                        {testCase.tc_display_id}
                      </td>
                      <td>
                        <p className="max-w-sm truncate font-medium text-app-primary">
                          {testCase.title}
                        </p>
                      </td>
                      <td className="text-app-secondary">{testCase.steps}</td>
                      {/* Same field and same order as the Workbench grid, so a
                          case sits in the same place on both screens. */}
                      <td className="whitespace-nowrap text-[12px] text-app-secondary">
                        {formatWhen(testCase.created_at)}
                      </td>
                      <td>
                        {scripts.length ? (
                          <div className="space-y-1">
                            {scripts.map(script => (
                              <div key={script.id} className="flex flex-wrap items-center gap-1.5">
                                <span
                                  className="inline-flex items-center gap-1 rounded-app border border-app px-1.5 py-0.5 text-[12px] text-app-primary"
                                  title={script.file_name}
                                >
                                  <HiOutlineCode className="h-3 w-3 text-app-secondary" />
                                  {frameworkLabel(script.framework)}
                                  <span className="text-app-secondary">v{script.version}</span>
                                </span>

                                {SHOW_SCRIPT_STATUS_BADGES ? (
                                  <>
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

                                    {/* A dry run IS a run, so its evidence lives
                                        on the Runs tab rather than in a panel. */}
                                    {script.dry_run_key ? (
                                      <Link
                                        to={`/automation/runs/${script.dry_run_key}`}
                                        className="inline-flex items-center gap-0.5 text-[12px] font-semibold text-app-brand-700 hover:underline"
                                        title="Open the run, with its screenshot, video, trace and log"
                                      >
                                        evidence
                                        <HiOutlineExternalLink className="h-3 w-3" />
                                      </Link>
                                    ) : null}
                                  </>
                                ) : null}

                                {/* Kept: a hand-edited script is not a status,
                                    it is a warning that the file no longer
                                    matches what the compiler would produce. */}
                                {script.edited_by_user ? (
                                  <StatusBadge tone="warning" size="sm">
                                    edited
                                  </StatusBadge>
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
                          <span className="text-[12px] text-app-secondary">Not generated</span>
                        )}
                      </td>
                    </tr>
                  </React.Fragment>
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
