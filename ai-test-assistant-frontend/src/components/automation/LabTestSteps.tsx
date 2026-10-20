/**
 * The Automation Lab's Test steps tab, as a three-column journey (design "A"):
 * the case list on the left, the steps in the middle -- each with three lights,
 * is the element real, is the data stored, does the check prove the step -- and
 * on the right the fix queue and an inspector for the chosen step.
 *
 * A fix changes an unsaved draft of the case; the draft is compiled by the
 * preview endpoint so the lights and the code show what the fix really does,
 * not what it was meant to do. Saving writes the case and Test Data, the Lab
 * regenerates the script, and Save & dry run then runs it. The full editor
 * (every field of every step, the test data keys) is one click away.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import automationService from '../../services/automationService'
import { environmentLabel } from '../../services/testDataService'
import type { LabCaseSteps, LabCaseStepsSave, LabStepsPreview, ScriptAsset } from '../../types/automation'
import { BTN, PRIMARY } from './labShared'
import {
  GLYPH, caseBlocks, defineFixes, rankElements, scriptInSync, fold, isCombinedLogin, isPlaceholder, sameSteps, scriptBlocks, stepRange, stepsOf, toDraft, viewSteps,
  type Draft, type DraftData, type DraftStep, type Light, type Lvl, type StepView
} from './labJourney'

export { stepsNeedingAttention } from './labJourney'

// --- Look: the values of the design reference ---------------------------------------------

const CARD = 'overflow-hidden rounded-[16px] border border-[#DDE1E7] bg-white'
const LBL = 'text-[11px] font-semibold uppercase tracking-[0.12em] text-[#5B6270]'
const LT: Record<Lvl, string> = {
  ok: 'bg-[#E3F4EA] text-[#0F5E36]',
  warn: 'bg-[#FFF1DC] text-[#723E00]',
  bad: 'bg-[#FDE7E8] text-[#951820]',
  na: 'bg-[#EEF0F3] text-[#4B5160]'
}
const NODE: Record<'ok' | 'warn' | 'bad', string> = {
  ok: 'border-[#15803D] bg-[#15803D] text-white',
  warn: 'border-[#E8A33A] bg-white text-[#7A4200]',
  bad: 'border-[#B71920] bg-white text-[#9A141A]'
}
const SM_RED = 'inline-flex min-h-[36px] items-center rounded-[10px] border border-[#B71920] bg-[#B71920] px-3 text-[12.5px] font-semibold text-white hover:bg-[#9A141A] disabled:cursor-not-allowed disabled:opacity-50'
const LINK = 'min-h-[32px] bg-transparent p-0 text-[12.5px] font-semibold text-[#B71920] hover:text-[#8E1218] disabled:opacity-50'
const FIELD = 'min-h-[40px] w-full rounded-[10px] border border-[#CDD2DA] bg-white px-3 font-mono text-[13px] text-[#17181C] outline-none focus:border-[#B71920] focus:shadow-[0_0_0_3px_#FBE3E4] disabled:bg-[#F4F5F7]'

const Lt: React.FC<{ light: Light; tag?: string }> = ({ light, tag }) => (
  <span className={`inline-flex min-h-[24px] items-center gap-1.5 rounded-full px-[9px] text-[11.5px] font-semibold ${LT[light.lvl]}`}>
    <span className="font-mono font-semibold">{GLYPH[light.lvl]}</span>
    {tag && <b className="text-[9.5px] font-semibold uppercase tracking-[0.08em] opacity-80">{tag}</b>}
    {light.label}
  </span>
)

// --- Editor (every field) --------------------------------------------------------------------

const ED_LBL = 'text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#6B7280]'
const INPUT = 'w-full rounded-[10px] border border-[#E8EAEE] bg-white px-2.5 py-[7px] text-[12.5px] text-[#1F2937] outline-none focus:border-[#B71920] focus:shadow-[0_0_0_3px_#FDEBEC]'
const FIELD_LBL = 'text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[#6B7280]'
const MINI = 'inline-flex h-6 min-w-[24px] items-center justify-center rounded-[8px] border border-[#E8EAEE] bg-white px-2 text-[11px] font-bold text-[#1F2937] disabled:cursor-not-allowed disabled:opacity-40'
const ACTION_TYPES = ['navigate', 'click', 'fill', 'select', 'assert', 'wait']
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/

let seed = 0
const uid = () => `n${++seed}`

const problemsOf = (d: Draft) => {
  const keys = d.data.map((x) => x.key.trim())
  return [
    !d.title.trim() && 'The title is empty.',
    !d.steps.some((s) => s.action.trim()) && 'Keep at least one step.',
    ...d.data.filter((x) => !KEY_RE.test(x.key.trim())).map((x) => `“${x.key || '(empty)'}” is not a valid key: letters, digits and _ only, starting with a letter.`),
    new Set(keys.map((k) => k.toLowerCase())).size !== keys.length && 'A test data key is listed twice.'
  ].filter(Boolean) as string[]
}

// --- Component -------------------------------------------------------------------------------

export interface JourneyHero {
  tc: string
  chips: string[]
  title: string
  meta: string
}

interface Props {
  caseId: number
  script: ScriptAsset | null
  canExecute: boolean
  /** A dry run can be queued: the framework has a runner and the runtime is up. */
  runnable: boolean
  /** The case was edited after its script was generated: the script does not have the edits. */
  stale: boolean
  busy: boolean
  applicationId: number | null
  hero: JourneyHero
  /** The case list, the left column. */
  rail: React.ReactNode
  /** Test steps · Script · Latest run · History. */
  tabs: React.ReactNode
  onJump: (step: number) => void
  onHistory: () => void
  onGenerate: () => void
  onDryRun: (script: ScriptAsset) => void
  /** Unsaved fixes or the editor open: switching case asks first. */
  onEditingChange: (unsaved: boolean) => void
  /** After a save: regenerate the script when the steps changed (against the case's application), reload, and hand back the current script. */
  onSaved: (regenerate: boolean, applicationId: number | null) => Promise<ScriptAsset | null>
  /** Each step's worst light, for the case list's strip. */
  onLevels: (levels: Lvl[]) => void
}

const LabTestSteps: React.FC<Props> = ({
  caseId, script, canExecute, runnable, stale, busy, applicationId, hero, rail, tabs,
  onJump, onHistory, onGenerate, onDryRun, onEditingChange, onSaved, onLevels
}) => {
  const [data, setData] = useState<LabCaseSteps | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [applied, setApplied] = useState<Set<string>>(new Set())
  const [edits, setEdits] = useState<Record<string, Partial<DraftStep>>>({})
  const [values, setValues] = useState<Record<string, string>>({})
  const [replacing, setReplacing] = useState<Set<string>>(new Set())
  const [sel, setSel] = useState(0)
  const [editor, setEditor] = useState<Draft | null>(null)
  const [preview, setPreview] = useState<LabStepsPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [saving, setSaving] = useState<'save' | 'run' | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const dataRef = useRef<HTMLElement | null>(null)
  const stepRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const previewReq = useRef(0)

  const reset = () => { setApplied(new Set()); setEdits({}); setValues({}); setReplacing(new Set()); setPreview(null); setPreviewError(null) }

  const load = useCallback(async () => {
    try {
      setData(await automationService.getLabCaseSteps(caseId, applicationId))
      setError(null)
    } catch (err: any) {
      setError(err?.message ?? 'The steps could not be loaded.')
    }
  }, [caseId, applicationId])

  useEffect(() => { setData(null); setEditor(null); setWarnings([]); setSel(0); reset(); void load() }, [load])
  // A new script version: the lights follow it.
  useEffect(() => { if (!editor) void load() }, [script?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const playwright = !script || script.framework === 'playwright'
  const saved = useMemo(() => (script && playwright ? scriptBlocks(script.code || '') : []), [script, playwright])
  const base = useMemo(() => (data ? toDraft(data) : null), [data])
  const env = data ? environmentLabel(data.environment) || data.environment : ''
  const ctx = { env, hasScript: Boolean(script) }

  // The saved case's own lights: what the fix queue is computed from.
  const baseViews = useMemo(() => (base ? viewSteps(base, base, saved, null, ctx) : []), [base, saved, env]) // eslint-disable-line react-hooks/exhaustive-deps
  const fixes = useMemo(() => (base && data ? defineFixes(base, baseViews, data.kb_elements) : []), [base, baseViews, data])
  const draft = useMemo(() => (base ? fold(base, fixes, applied, edits, values) : null), [base, fixes, applied, edits, values])
  const stepsChanged = Boolean(draft && base && !sameSteps(draft.steps, base.steps))
  const typed = Object.values(values).some((v) => v !== '')
  const dirty = applied.size > 0 || Object.keys(edits).length > 0 || typed

  useEffect(() => { onEditingChange(editor !== null || dirty) }, [editor, dirty, onEditingChange])

  // Compile the draft's steps whenever they change, so every light is the compiler's word.
  const stepsKey = draft ? JSON.stringify(draft.steps) : ''
  useEffect(() => {
    if (!stepsChanged || !draft) { setPreview(null); setPreviewError(null); return }
    const id = ++previewReq.current
    setPreview(null)
    setPreviewError(null)
    const timer = window.setTimeout(() => {
      automationService
        .previewLabCaseSteps(caseId, { framework: 'playwright', steps: draft.steps.filter((s) => s.action.trim()).map(({ uid: _u, ...s }) => s) }, applicationId)
        .then((r) => { if (id === previewReq.current) setPreview(r) })
        .catch((err: any) => { if (id === previewReq.current) setPreviewError(err?.message ?? 'The draft could not be compiled.') })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [stepsKey, stepsChanged, caseId, applicationId]) // eslint-disable-line react-hooks/exhaustive-deps

  const previewBlocks = useMemo(() => (preview ? scriptBlocks(preview.code) : null), [preview])
  const views: StepView[] = useMemo(
    () => (draft && base ? viewSteps(draft, base, saved, previewBlocks, ctx) : []),
    [draft, base, saved, previewBlocks, env] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const levelsKey = views.map((v) => v.worst).join(',')
  useEffect(() => { if (views.length) onLevels(views.map((v) => v.worst)) }, [levelsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="rounded-[12px] border border-[#F6D4D5] bg-[#FFF8F8] px-4 py-2.5 text-[13px] text-[#7A0B0D]" role="alert">{error}</div>
  if (!data || !draft || !base) {
    return (
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[272px_minmax(0,1fr)]">
        {rail}
        <div className={`${CARD} px-6 py-12 text-center text-[13px] text-[#6B7280]`}>Loading the steps…</div>
      </div>
    )
  }

  // --- Saving --------------------------------------------------------------------------------
  const persist = async (d: Draft, run: boolean) => {
    if (problemsOf(d).length || saving) return
    const keys = d.data.map((x) => x.key.trim())
    const regenerate = !sameSteps(d.steps, base.steps)
    const body: LabCaseStepsSave = {
      title: d.title.trim(),
      preconditions: d.preconditions,
      expected_result: d.expected_result,
      steps: d.steps.filter((s) => s.action.trim()).map(({ uid: _u, ...s }) => ({
        ...s,
        test_data_ref: s.test_data_ref && (keys.includes(s.test_data_ref) || isPlaceholder(s.test_data_ref)) ? s.test_data_ref : null
      })),
      test_data: d.data.map((x) => ({ key: x.key.trim(), description: x.description.trim() || null, sensitive: x.sensitive, ...(x.value !== undefined && x.value !== '' ? { value: x.value } : {}) }))
    }
    setSaving(run ? 'run' : 'save')
    setSaveError(null)
    try {
      const result = await automationService.saveLabCaseSteps(caseId, body, applicationId)
      setData(result)
      setWarnings(result.warnings ?? [])
      setEditor(null)
      reset()
      const before = script?.version ?? 0
      const current = await onSaved(regenerate, applicationId ?? data.kb_application?.id ?? null)
      if (run) {
        if (!current) setSaveError('Saved, but there is no script to dry run.')
        else if (regenerate && current.version <= before) setSaveError(`Saved, but the script was not regenerated, so v${current.version} was not run: it does not have your changes.`)
        else if (current.static_gate_result && !current.static_gate_result.passed) setSaveError(`Saved, but script v${current.version} failed the static gate, so it was not run.`)
        else if (regenerate && current.edited_by_user) setSaveError('Saved. The script was edited by hand, so it was not regenerated or run.')
        else onDryRun(current)
      }
    } catch (err: any) {
      setSaveError(err?.message ?? 'The changes could not be saved.')
    } finally {
      setSaving(null)
    }
  }

  /** The saved steps, compiled again: the queue's Regenerate, no save. */
  const regenerate = async () => {
    setSaving('save')
    setSaveError(null)
    try {
      const before = script?.version ?? 0
      const current = await onSaved(true, applicationId ?? data.kb_application?.id ?? null)
      if (!current || current.version <= before) setSaveError('The script was not regenerated; see the message above.')
    } finally {
      setSaving(null)
    }
  }

  // --- Edit mode: the full editor --------------------------------------------------------------
  if (editor) {
    return (
      <div className="flex flex-col gap-4">
        <HeroBand hero={hero} tabs={tabs} views={views} />
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[272px_minmax(0,1fr)]">
          {rail}
          <div className={`${CARD} min-w-0`}>
            <FullEditor
              data={data}
              script={script}
              initial={editor}
              env={env}
              saving={saving !== null}
              saveError={saveError}
              onChange={setEditor}
              onCancel={() => { setEditor(null); setSaveError(null) }}
              onSave={(d) => void persist(d, false)}
            />
          </div>
        </div>
      </div>
    )
  }

  // --- Journey -------------------------------------------------------------------------------
  const cur = views[Math.min(sel, views.length - 1)] ?? null
  const total = views.length
  const ready = views.filter((v) => v.worst === 'ok').length
  const allReady = total > 0 && ready === total
  const ring = 2 * Math.PI * 23
  const problems = problemsOf(draft)
  const ownBlocks = caseBlocks(saved).length
  const inSync = !script || scriptInSync(saved, base.steps)

  const usedBy = (key: string) => draft.steps.map((s, i) => (s.test_data_ref === key ? i + 1 : 0)).filter(Boolean)
  const missingValues = draft.data.filter((x) => usedBy(x.key).length && !x.hasValue && !(x.value ?? '').trim()
    && !draft.steps.some((s) => s.test_data_ref === x.key && isCombinedLogin(s)))
  const everMissing = base.data.some((x) => !x.hasValue) || draft.data.some((x) => !x.hasValue)

  const show = (uids: string[]) => {
    const n = stepsOf(draft, uids)[0]
    const i = n ? views.findIndex((v) => !v.prelude && v.n === n) : views.findIndex((v) => v.prelude && v.worst !== 'ok')
    if (i < 0) return
    setSel(i)
    stepRefs.current[views[i].uid]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
  const showData = () => {
    dataRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    window.setTimeout(() => dataRef.current?.querySelector<HTMLInputElement>('input:not([disabled])')?.focus(), 250)
  }
  const toggle = (id: string, on: boolean) => setApplied((prev) => { const next = new Set(prev); if (on) next.add(id); else next.delete(id); return next })
  const edit = (u: string, patch: Partial<DraftStep>) => setEdits((prev) => ({ ...prev, [u]: { ...prev[u], ...patch } }))
  const unedit = (u: string) => setEdits((prev) => { const next = { ...prev }; delete next[u]; return next })

  // The queue: the fixes the saved case calls for, then what only the user can give.
  type Item = { id: string; t: string; where: string; why: string; act: string; done: boolean; doneTxt: string; onAct: () => void; onShow: (() => void) | null; onUndo: (() => void) | null }
  const items: Item[] = []
  if (!script) {
    items.push({ id: 'generate', t: 'Generate the script', where: 'All steps', why: 'There is no script yet, so nothing says which element each step acts on or what it checks.', act: 'Generate', done: false, doneTxt: '', onAct: onGenerate, onShow: null, onUndo: null })
  } else if ((!inSync || stale) && !stepsChanged) {
    items.push({
      id: 'sync', t: 'Regenerate the script', where: 'All steps',
      why: !inSync
        ? `The script's ${ownBlocks} steps do not match the case's ${base.steps.length}: it was generated from other steps. Its lights cannot be trusted until it is regenerated.`
        : `The case was edited after v${script.version} was generated, so the script does not have those edits yet.`,
      act: 'Regenerate', done: false, doneTxt: '',
      onAct: () => void regenerate(), onShow: null, onUndo: null
    })
  }
  fixes.forEach((f) => {
    const done = applied.has(f.id)
    items.push({
      id: f.id, t: f.title, where: stepRange(stepsOf(draft, f.uids)), why: f.why, act: f.act, done, doneTxt: f.doneTxt,
      onAct: () => { toggle(f.id, true); show(f.uids) }, onShow: () => show(f.uids), onUndo: f.act ? () => toggle(f.id, false) : null
    })
  })
  if (everMissing && (missingValues.length || typed)) {
    items.push({
      id: 'values', t: `Add the ${env} values`, where: 'Test data',
      why: `${missingValues.map((x) => x.key).join(', ')} ${missingValues.length === 1 ? 'has' : 'have'} no value for ${env}. Type ${missingValues.length === 1 ? 'it' : 'them'} under Test data; ${missingValues.length === 1 ? 'it is' : 'they are'} saved to Test Data with the case.`,
      act: 'Fill in', done: missingValues.length === 0, doneTxt: `Values entered for ${env}. They are saved to Test Data with the case.`,
      onAct: showData, onShow: null, onUndo: () => setValues({})
    })
  }
  const left = items.filter((i) => !i.done).length

  const runLabel = dirty ? (allReady ? 'Save & dry run' : 'Save & dry run anyway') : !script ? 'Generate' : allReady ? 'Dry run' : 'Dry run anyway'
  const runDisabled = !canExecute || busy || saving !== null || (script !== null && !runnable) || (dirty && problems.length > 0)
  const run = () => {
    if (dirty) void persist(draft, true)
    else if (!script) onGenerate()
    else onDryRun(script)
  }

  const gateNotes = (script?.static_gate_result?.warnings ?? []).filter((w) => !/^Step \d+:/.test(w))
  const banners = [
    ...warnings,
    ...(saveError ? [saveError] : []),
    ...(previewError ? [`The unsaved steps could not be compiled: ${previewError}`] : []),
    ...(!playwright ? ['The journey reads Playwright scripts. Choose Playwright above to see each step’s element and check.'] : []),
    ...gateNotes,
    ...(dirty && script?.edited_by_user && stepsChanged ? ['The script was edited by hand, so saving will not regenerate it. Regenerate it from Generate once you have kept what you need.'] : [])
  ]
  const kbChoices = (s: DraftStep) => rankElements(s, data.kb_elements)

  return (
    <div className="flex flex-col gap-4">
      <HeroBand hero={hero} tabs={tabs} views={views}>
        <div className="flex flex-[1_1_300px] items-center gap-3.5 border-[#E8EAEE] lg:border-l lg:pl-4">
          <div className="relative h-14 w-14 flex-none" title={`${ready} of ${total} steps ready`}>
            <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden>
              <circle cx="28" cy="28" r="23" fill="none" stroke="#EEF0F3" strokeWidth="6" />
              {ready > 0 && (
                <circle cx="28" cy="28" r="23" fill="none" stroke="#15803D" strokeWidth="6" strokeLinecap="round"
                  strokeDasharray={`${((ready / total) * ring).toFixed(1)} ${ring.toFixed(1)}`} transform="rotate(-90 28 28)" />
              )}
            </svg>
            <span className="absolute inset-0 flex items-center justify-center font-mono text-[13px] font-semibold text-[#1F2937]">{ready}/{total}</span>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <div className="text-[13.5px] font-bold text-[#1F2937]">{allReady ? 'Ready for a dry run' : `${total - ready} of ${total} step${total === 1 ? '' : 's'} need${total - ready === 1 ? 's' : ''} you`}</div>
            <div className="max-w-[46ch] text-[11.5px] leading-[1.4] text-[#6B7280]">
              {allReady
                ? 'Every element is confirmed, every value comes from Test Data, and every check proves its step.'
                : 'Ready means: element confirmed, data from Test Data, and a check that proves the step.'}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <button type="button" onClick={run} disabled={runDisabled} className={`${allReady || !script ? PRIMARY : BTN} !h-8 !px-3 !text-[12px]`}
                title={!runnable && script ? 'This framework has no runner here, or the browser runtime is down.' : undefined}>
                {saving === 'run' ? 'Saving…' : runLabel}
              </button>
              <button type="button" onClick={onHistory} className={`${BTN} !h-8 !px-3 !text-[12px]`}>History</button>
              {dirty && (
                <span className="flex flex-wrap items-center gap-2.5 text-[11.5px] text-[#6B7280]">
                  <span className="rounded-full bg-[#FFF4E5] px-2 py-0.5 font-semibold text-[#8A5000]">Unsaved fixes</span>
                  <button type="button" onClick={() => void persist(draft, false)} disabled={!canExecute || saving !== null || problems.length > 0} className="font-semibold text-[#B71920] hover:underline disabled:opacity-50">
                    {saving === 'save' ? 'Saving…' : 'Save without running'}
                  </button>
                  <button type="button" onClick={reset} disabled={saving !== null} className="font-semibold text-[#6B7280] hover:underline">Discard</button>
                </span>
              )}
            </div>
          </div>
        </div>
      </HeroBand>

      {banners.length > 0 && (
        <div className="flex flex-col gap-2">
          {banners.map((w) => <div key={w} className="rounded-[12px] border border-[#EBCFA4] bg-[#FFFBF4] px-3.5 py-2 text-[12.5px] text-[#8A5000]">{w}</div>)}
          {problems.length > 0 && dirty && <div role="alert" className="rounded-[12px] border border-[#F6D4D5] bg-[#FFF8F8] px-3.5 py-2 text-[12.5px] text-[#7A0B0D]">{problems.join(' ')}</div>}
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[272px_minmax(0,1fr)_392px]">
        {rail}

        {/* The journey and its data */}
        <div className="flex min-w-0 flex-col gap-4">
          <section className={CARD} aria-label="Test journey">
            <div className="flex flex-wrap items-end justify-between gap-2 border-b border-[#E6E9EE] px-[18px] pb-2.5 pt-4">
              <div><span className={LBL}>Test journey</span><h2 className="m-0 mt-0.5 text-[16px] font-semibold">What the test does, step by step</h2></div>
              <div className="flex flex-col items-end gap-1.5">
                <span className="text-[12.5px] text-[#4B5160]">Each step: is the element real · is the data stored · does the check prove it</span>
                <button type="button" onClick={() => { setSaveError(null); setEditor(draft) }} disabled={!canExecute} title={canExecute ? 'Edit every field of the steps, the test data keys and the case' : 'You do not have permission to edit'} className={LINK}>
                  Edit steps &amp; test data
                </button>
              </div>
            </div>
            <ol className="m-0 list-none px-[18px] pb-1.5 pt-4">
              {views.map((v, i) => (
                <li key={v.uid} className="grid grid-cols-[36px_minmax(0,1fr)] gap-3">
                  <div className="flex flex-col items-center">
                    <span className={`mt-2.5 flex h-8 w-8 flex-none items-center justify-center rounded-full border-2 font-mono font-semibold ${v.prelude ? 'text-[11px]' : 'text-[13px]'} ${NODE[v.worst]}`}>{v.label}</span>
                    {i < views.length - 1 && <span className="min-h-[12px] w-0.5 flex-1 bg-[#DDE1E7]" />}
                  </div>
                  <button
                    type="button"
                    ref={(el) => { stepRefs.current[v.uid] = el }}
                    onClick={() => setSel(i)}
                    aria-pressed={cur?.uid === v.uid}
                    className={`mb-3 flex w-full flex-col gap-2 rounded-[12px] border bg-white px-3.5 py-3 text-left ${cur?.uid === v.uid ? 'border-[#17181C] shadow-[0_0_0_1px_#17181C]' : 'border-[#DDE1E7] hover:border-[#AEB4BF]'}`}
                  >
                    <span className="block text-[14px] font-semibold leading-[1.35]">{v.step.action || '(no action)'}</span>
                    {v.prelude
                      ? <span className="block text-[12.5px] leading-[1.4] text-[#4B5160]">Sign-in from the Knowledge Base · runs before the case's steps</span>
                      : <span className="block text-[12.5px] leading-[1.4] text-[#4B5160]">Expected: {v.step.expected_result || '—'}</span>}
                    <span className="flex flex-wrap gap-1.5">
                      <Lt light={v.el} tag="Element" />
                      <Lt light={v.data} tag="Data" />
                      <Lt light={v.check} tag="Check" />
                      {v.changed && <span className="inline-flex min-h-[24px] items-center rounded-full border border-dashed border-[#AEB4BF] px-[9px] text-[11px] font-semibold text-[#4B5160]">Unsaved</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </section>

          <section ref={dataRef} className={CARD} aria-label="Test data">
            <div className="flex flex-col gap-1 border-b border-[#E6E9EE] px-4 py-3.5">
              <span className={LBL}>Test data · {env}{data.test_data_app ? ` · ${data.test_data_app.name}` : ''}</span>
              <h3 className="m-0 text-[15px] font-semibold leading-[1.35]">Values this case reads</h3>
            </div>
            {!draft.data.length && <div className="px-4 py-3 text-[12.5px] text-[#4B5160]">This case reads no test data.</div>}
            {draft.data.map((x) => {
              const used = usedBy(x.key)
              const split = draft.steps.some((s) => s.test_data_ref === x.key && isCombinedLogin(s))
              const typedHere = (x.value ?? '').trim() !== ''
              const light: Light = split ? { lvl: 'warn', label: 'Split needed', note: '' }
                : typedHere ? { lvl: 'ok', label: x.sensitive ? 'Value set · masked' : x.value!, note: '' }
                  : x.hasValue ? { lvl: 'ok', label: x.sensitive ? 'Value set · masked' : (x.stored ?? 'Value set'), note: '' }
                    : { lvl: 'warn', label: `No ${env} value`, note: '' }
              const input = !split && (!x.hasValue || replacing.has(x.key) || typedHere)
              return (
                <div key={x.uid} className="flex flex-col gap-1 border-t border-[#E6E9EE] px-4 py-3 first-of-type:border-t-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-[12.5px] font-semibold">{x.key}</span>
                    <Lt light={light} />
                  </div>
                  <div className="mt-[5px] text-[12.5px] leading-[1.45] text-[#3B4150] [overflow-wrap:anywhere]">
                    {[split ? 'One value, used for two fields' : x.description || null, used.length ? `used by step ${used.join(', ')}` : 'not used by any step'].filter(Boolean).join(' · ')}
                    {x.hasValue && !split && !input && canExecute && data.test_data_app && (
                      <> · <button type="button" onClick={() => setReplacing((p) => new Set(p).add(x.key))} className="font-semibold text-[#B71920] hover:underline">Replace value</button></>
                    )}
                  </div>
                  {input && (
                    <label className="mt-1.5 flex flex-col gap-1 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#5B6270]">
                      Value for {env}
                      <input
                        type={x.sensitive ? 'password' : 'text'}
                        autoComplete="off"
                        value={values[x.key] ?? (x.value ?? '')}
                        onChange={(e) => setValues((p) => ({ ...p, [x.key]: e.target.value }))}
                        disabled={!canExecute || !data.test_data_app}
                        placeholder={!data.test_data_app ? 'No Test Data application matches this case' : x.hasValue ? 'Set · type to replace' : 'Enter value'}
                        className={`${FIELD} normal-case tracking-normal`}
                      />
                    </label>
                  )}
                </div>
              )
            })}
          </section>
        </div>

        {/* Fix queue and inspector */}
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2 xl:col-span-1">
          <section className={CARD} aria-label="Fix queue">
            <div className="flex items-center justify-between gap-2 px-4 py-3.5">
              <div><span className={LBL}>Before you run</span><h2 className="m-0 mt-0.5 text-[16px] font-semibold">Fix queue</h2></div>
              <span className={`rounded-full px-[9px] py-[3px] font-mono text-[12px] font-semibold text-white ${left ? 'bg-[#B71920]' : 'bg-[#15803D]'}`}>{left ? `${left} left` : 'Clear'}</span>
            </div>
            {items.map((f, i) => (
              <div key={f.id} className="flex flex-col gap-[7px] border-t border-[#E6E9EE] px-4 py-3.5">
                <div className="flex items-center gap-2">
                  <span className={`flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full font-mono text-[11px] font-semibold text-white ${f.done ? 'bg-[#15803D]' : 'bg-[#17181C]'}`}>{f.done ? '✓' : i + 1}</span>
                  <span className={`text-[14px] font-semibold ${f.done ? 'text-[#4B5160]' : ''}`}>{f.t}</span>
                  <span className="ml-auto whitespace-nowrap font-mono text-[11px] font-semibold text-[#5B6270]">{f.where}</span>
                </div>
                {!f.done ? (
                  <>
                    <p className="m-0 text-[12.5px] leading-[1.45] text-[#4B5160]">{f.why}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      {f.act && <button type="button" onClick={f.onAct} disabled={!canExecute || saving !== null} className={SM_RED}>{f.act}</button>}
                      {(f.id === 'kb' || f.id === 'signin') && <Link to="/automation/knowledge-base" className={`${LINK} inline-flex items-center`}>Open the Knowledge Base</Link>}
                      {f.onShow && <button type="button" onClick={f.onShow} className={LINK}>Show me</button>}
                    </div>
                  </>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12.5px] font-semibold text-[#0F5E36]">{f.doneTxt}</span>
                    {f.onUndo && <button type="button" onClick={f.onUndo} className={LINK}>Undo</button>}
                  </div>
                )}
              </div>
            ))}
            {!items.length && <div className="border-t border-[#E6E9EE] p-4 text-[13px] font-semibold text-[#0F5E36]">Nothing to fix: every step is grounded, fed from Test Data and checked.</div>}
            {items.length > 0 && left === 0 && (
              <div className="border-t border-[#E6E9EE] p-4 text-[13px] font-semibold text-[#0F5E36]">
                All fixes applied. {stepsChanged
                  ? `Saving regenerates the script as v${(script?.version ?? 0) + 1} and runs it through the static gate.`
                  : 'Saving stores the values in Test Data.'}
              </div>
            )}
          </section>

          {cur && (
            <section className={CARD} aria-label="Step inspector">
              <div className="flex flex-col gap-1 border-b border-[#E6E9EE] px-4 py-3.5">
                <span className={LBL}>Step {cur.label} · inspector</span>
                <h3 className="m-0 text-[15px] font-semibold leading-[1.35]">{cur.step.action || '(no action)'}</h3>
              </div>
              <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 px-4 py-3.5">
                <span className="pt-[5px] text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#5B6270]">Element</span>
                <div>
                  <Lt light={cur.el} />
                  <div className="mt-[5px] text-[12.5px] leading-[1.45] text-[#3B4150] [overflow-wrap:anywhere]">{cur.el.note}</div>
                  {canExecute && !cur.prelude && !cur.replaced && (cur.el.lvl === 'warn' || cur.el.lvl === 'bad') && kbChoices(cur.step).length > 0 && (
                    <select
                      aria-label="Use a Knowledge Base element"
                      value=""
                      onChange={(e) => e.target.value && edit(cur.uid, { target: e.target.value })}
                      className="mt-2 min-h-[36px] w-full rounded-[10px] border border-[#CDD2DA] bg-white px-2 text-[12.5px]"
                    >
                      <option value="">Use a Knowledge Base element ({kbChoices(cur.step).length} likely)…</option>
                      {kbChoices(cur.step).map((e) => (
                        <option key={`${e.name}|${e.page}`} value={e.name}>{[e.name, e.role, e.page?.replace(/^https?:\/\/[^/]+/, '')].filter(Boolean).join(' · ')}</option>
                      ))}
                    </select>
                  )}
                </div>
                <span className="pt-[5px] text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#5B6270]">Data</span>
                <div>
                  <Lt light={cur.data} />
                  <div className="mt-[5px] text-[12.5px] leading-[1.45] text-[#3B4150] [overflow-wrap:anywhere]">{cur.data.note}</div>
                </div>
                <span className="pt-[5px] text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#5B6270]">Check</span>
                <div>
                  <Lt light={cur.check} />
                  <div className="mt-[5px] text-[12.5px] leading-[1.45] text-[#3B4150] [overflow-wrap:anywhere]">{cur.check.note}</div>
                  {canExecute && !cur.prelude && !cur.replaced && (cur.check.lvl === 'warn' || cur.check.lvl === 'bad' || edits[cur.uid]?.expected_result !== undefined) && (
                    <label className="mt-2 flex flex-col gap-1 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#5B6270]">
                      What proves this step
                      <textarea
                        rows={2}
                        value={cur.step.expected_result ?? ''}
                        onChange={(e) => edit(cur.uid, { expected_result: e.target.value })}
                        className="rounded-[10px] border border-[#CDD2DA] px-2.5 py-2 text-[12.5px] normal-case tracking-normal text-[#17181C] outline-none focus:border-[#B71920] focus:shadow-[0_0_0_3px_#FBE3E4]"
                      />
                      <span className="text-[11px] font-normal normal-case tracking-normal text-[#5B6270]">A quoted text, a page or dialog name (“The Trade License Details dialog opens”) or a URL becomes an assertion.</span>
                    </label>
                  )}
                  {edits[cur.uid] && <button type="button" onClick={() => unedit(cur.uid)} className={`${LINK} mt-1`}>Undo edits to this step</button>}
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 bg-[#22242A] px-4 py-[9px] font-mono text-[11px] font-semibold text-[#C9CDD6]">
                <span className="truncate">{(preview?.file_name ?? script?.file_name ?? 'spec.ts')} · step {cur.label}</span>
                <span className="flex items-center gap-3 whitespace-nowrap">
                  {stepsChanged ? `v${(script?.version ?? 0) + 1} draft · unsaved` : script ? `v${script.version}` : 'no script'}
                  {script && !cur.changed && cur.block && (inSync || cur.prelude) && <button type="button" onClick={() => onJump(cur.block!.index)} className="font-semibold text-[#FF9EA3] hover:underline">Open in Script</button>}
                </span>
              </div>
              <div className="app-scroll overflow-x-auto bg-[#16171B] py-2.5 font-mono text-[12px] leading-[1.75] text-[#E5E7EB]" aria-label="Script for this step">
                {!cur.block ? (
                  <div className="px-4 text-[#9AA1AE]">{stepsChanged && !preview && !previewError ? '// compiling the unsaved steps…' : '// no script for this step yet'}</div>
                ) : cur.block.lines.map((l, k) => {
                  const todo = /^\s*\/\/\s*TODO:/.test(l) || (cur.check.lvl === 'bad' && cur.block!.assertions.includes(l.trim()))
                  const comment = l.trim().startsWith('//')
                  return (
                    <div key={k} className={`whitespace-pre px-4 ${todo ? 'bg-[rgba(183,25,32,0.30)] shadow-[inset_3px_0_0_#FF6B72]' : cur.added.has(k) ? 'bg-[rgba(21,128,61,0.30)] shadow-[inset_3px_0_0_#3BB273]' : ''} ${comment && !todo ? 'text-[#9AA1AE]' : ''}`}>
                      {l || ' '}
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

/** The case's header on every tab: which case, and -- as children -- how ready it is. */
export const HeroBand: React.FC<{ hero: JourneyHero; tabs: React.ReactNode; views: StepView[]; children?: React.ReactNode }> = ({ hero, tabs, children }) => (
  <section
    className="relative flex flex-wrap items-center gap-x-6 gap-y-3 overflow-hidden rounded-[16px] border border-[#F1C4C6] bg-[radial-gradient(120%_140%_at_100%_0%,#FFF5F5_0%,#FFFFFF_45%)] py-3 pl-5 pr-4 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_8px_24px_rgba(183,25,32,0.08)]"
    aria-label={`${hero.tc} summary`}
  >
    {/* The brand's red, as a gradient edge down the left and a hairline along the top. */}
    <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-[5px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)]" />
    <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-[linear-gradient(90deg,#d7141c_0%,rgba(215,20,28,0.35)_40%,rgba(215,20,28,0)_75%)]" />
    <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-0.5 text-[11.5px] font-bold text-[#B71920]">{hero.tc}</span>
        {hero.chips.map((c) => (
          <span key={c} className="inline-flex h-[22px] items-center whitespace-nowrap rounded-full border border-[#E8EAEE] bg-white px-2 text-[10.5px] font-semibold text-[#1F2937]">{c}</span>
        ))}
        <span className="ml-auto">{tabs}</span>
      </div>
      <h1 className="m-0 mt-1 text-[15px] font-bold leading-[1.35] text-[#1F2937]">{hero.title}</h1>
      <div className="truncate text-[11.5px] text-[#6B7280]">{hero.meta}</div>
    </div>
    {children}
  </section>
)

/** Readiness in the header of the other tabs: the strip's count, and the way to the fixes. */
export const ReadinessSummary: React.FC<{ levels: Lvl[]; hasScript: boolean; onOpen: () => void }> = ({ levels, hasScript, onOpen }) => {
  const total = levels.length
  const ready = hasScript ? levels.filter((l) => l === 'ok' || l === 'na').length : 0
  const ring = 2 * Math.PI * 23
  const allReady = hasScript && total > 0 && ready === total
  return (
    <div className="flex flex-[1_1_300px] items-center gap-3.5 border-[#E8EAEE] lg:border-l lg:pl-4">
      <div className="relative h-14 w-14 flex-none" title={`${ready} of ${total} steps ready`}>
        <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden>
          <circle cx="28" cy="28" r="23" fill="none" stroke="#EEF0F3" strokeWidth="6" />
          {ready > 0 && (
            <circle cx="28" cy="28" r="23" fill="none" stroke="#15803D" strokeWidth="6" strokeLinecap="round"
              strokeDasharray={`${((ready / total) * ring).toFixed(1)} ${ring.toFixed(1)}`} transform="rotate(-90 28 28)" />
          )}
        </svg>
        <span className="absolute inset-0 flex items-center justify-center font-mono text-[13px] font-semibold text-[#1F2937]">{ready}/{total}</span>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="text-[13.5px] font-bold text-[#1F2937]">
          {!hasScript ? 'No script yet' : allReady ? 'Ready for a dry run' : `${total - ready} of ${total} step${total === 1 ? '' : 's'} need${total - ready === 1 ? 's' : ''} you`}
        </div>
        <div className="max-w-[46ch] text-[11.5px] leading-[1.4] text-[#6B7280]">
          {!hasScript ? 'Generate it to see how each step is automated.' : 'Read from the script: element confirmed, data from Test Data, and a check that proves each step.'}
        </div>
        <div className="mt-1">
          <button type="button" onClick={onOpen} className={`${BTN} !h-8 !px-3 !text-[12px]`}>{allReady ? 'Open Test steps' : 'Review in Test steps'}</button>
        </div>
      </div>
    </div>
  )
}

// --- The full editor: every field of every step, the keys, the case ----------------------------

const FullEditor: React.FC<{
  data: LabCaseSteps
  script: ScriptAsset | null
  initial: Draft
  env: string
  saving: boolean
  saveError: string | null
  onChange: (d: Draft) => void
  onCancel: () => void
  onSave: (d: Draft) => void
}> = ({ data, script, initial: draft, env, saving, saveError, onChange, onCancel, onSave }) => {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch })
  const setStep = (id: string, patch: Partial<DraftStep>) => set({ steps: draft.steps.map((s) => (s.uid === id ? { ...s, ...patch } : s)) })
  const setDatum = (id: string, patch: Partial<DraftData>) => {
    const before = draft.data.find((d) => d.uid === id)
    const steps = patch.key !== undefined && before
      ? draft.steps.map((s) => (s.test_data_ref === before.key ? { ...s, test_data_ref: patch.key! } : s))
      : draft.steps
    set({ data: draft.data.map((d) => (d.uid === id ? { ...d, ...patch } : d)), steps })
  }
  const move = (index: number, by: number) => {
    const steps = [...draft.steps]
    const [item] = steps.splice(index, 1)
    steps.splice(index + by, 0, item)
    set({ steps })
  }
  const splitLogin = (index: number) => {
    const steps = [...draft.steps]
    const old = steps[index]
    steps.splice(index, 1,
      { uid: uid(), action: 'Enter the username in the Username field', action_type: 'fill', target: 'Username', test_data_ref: 'admin_username', expected_result: 'The Username field shows the username.' },
      { uid: uid(), action: 'Enter the password in the Password field', action_type: 'fill', target: 'Password', test_data_ref: 'admin_password', expected_result: 'The Password field is filled.' },
      { uid: uid(), action: 'Click the Sign In button', action_type: 'click', target: 'Sign In', test_data_ref: null, expected_result: old.expected_result })
    const used = new Set(steps.map((s) => s.test_data_ref))
    const data = draft.data.filter((d) => d.key !== old.test_data_ref || used.has(d.key))
    for (const key of ['admin_username', 'admin_password']) {
      if (!data.some((d) => d.key === key)) data.push({ uid: uid(), key, description: key === 'admin_username' ? 'Admin username' : 'Admin password', sensitive: true, hasValue: false, stored: null })
    }
    set({ steps, data })
  }

  const problems = problemsOf(draft)
  const elementList = `kb-elements-${data.case_id}`
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={ED_LBL}>Editing {data.display_id} · steps, test data and case fields</span>
        <span className="text-[11.5px] text-[#6B7280]">Nothing changes until you save</span>
      </div>

      <section className="flex flex-col gap-2.5 rounded-[14px] border border-[#E8EAEE] p-3">
        <span className={ED_LBL}>Case</span>
        <label className="flex flex-col gap-1"><span className={FIELD_LBL}>Title</span>
          <textarea id="lab-edit-title" rows={2} value={draft.title} onChange={(e) => set({ title: e.target.value })} className={`${INPUT} resize-y`} />
        </label>
        <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
          <label className="flex flex-col gap-1"><span className={FIELD_LBL}>Preconditions</span>
            <textarea id="lab-edit-pre" rows={3} value={draft.preconditions} onChange={(e) => set({ preconditions: e.target.value })} className={`${INPUT} resize-y`} />
          </label>
          <label className="flex flex-col gap-1"><span className={FIELD_LBL}>Overall expected result</span>
            <textarea id="lab-edit-exp" rows={3} value={draft.expected_result} onChange={(e) => set({ expected_result: e.target.value })} className={`${INPUT} resize-y`} />
          </label>
        </div>
      </section>

      <section className="flex flex-col gap-2.5 rounded-[14px] border border-[#E8EAEE] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={ED_LBL}>Steps</span>
          <span className="text-[11.5px] text-[#6B7280]">
            {data.kb_elements.length ? `Pick an element from the ${data.kb_application?.name ?? ''} Knowledge Base (${data.kb_elements.length}) or type one` : 'No Knowledge Base elements for this application; type the element'}
          </span>
        </div>
        <datalist id={elementList}>
          {data.kb_elements.map((e) => <option key={`${e.name}|${e.page}`} value={e.name}>{[e.role, e.page?.replace(/^https?:\/\/[^/]+/, '')].filter(Boolean).join(' · ')}</option>)}
        </datalist>
        {draft.steps.map((s, i) => (
          <div key={s.uid} className="flex flex-col gap-2 rounded-[12px] border border-[#E8EAEE] bg-[#FCFCFD] px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-[#1F2937] text-[11px] font-bold text-white">{i + 1}</span>
              {isCombinedLogin(s) && (
                <button type="button" onClick={() => splitLogin(i)} className={`${MINI} !border-[#F6D4D5] !bg-[#FFF8F8] !text-[#941216]`}>Split into username, password and Sign In</button>
              )}
              <span className="ml-auto flex gap-1.5">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move step ${i + 1} up`} className={MINI}>↑</button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === draft.steps.length - 1} aria-label={`Move step ${i + 1} down`} className={MINI}>↓</button>
                <button type="button" onClick={() => set({ steps: draft.steps.filter((x) => x.uid !== s.uid) })} aria-label={`Delete step ${i + 1}`} className={`${MINI} !text-[#A3231C]`}>Delete</button>
              </span>
            </div>
            <label className="flex flex-col gap-1"><span className={FIELD_LBL}>Test step</span>
              <textarea id={`lab-step-${s.uid}-action`} rows={2} value={s.action} onChange={(e) => setStep(s.uid, { action: e.target.value })} className={`${INPUT} resize-y`} />
            </label>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-[130px_minmax(0,1fr)_minmax(0,1fr)]">
              <label className="flex flex-col gap-1"><span className={FIELD_LBL}>Action type</span>
                <select id={`lab-step-${s.uid}-type`} value={s.action_type ?? ''} onChange={(e) => setStep(s.uid, { action_type: e.target.value || null })} className={INPUT}>
                  <option value="">—</option>
                  {ACTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1"><span className={FIELD_LBL}>Element / target</span>
                <input id={`lab-step-${s.uid}-target`} list={elementList} value={s.target ?? ''} onChange={(e) => setStep(s.uid, { target: e.target.value })} placeholder={s.action_type === 'navigate' ? 'Page address' : 'Pick or type the element'} className={INPUT} />
              </label>
              <label className="flex flex-col gap-1"><span className={FIELD_LBL}>Test data</span>
                <select id={`lab-step-${s.uid}-data`} value={s.test_data_ref ?? ''} onChange={(e) => setStep(s.uid, { test_data_ref: e.target.value || null })} className={INPUT}>
                  <option value="">No test data</option>
                  {isPlaceholder(s.test_data_ref) && <option value={s.test_data_ref!}>{s.test_data_ref}</option>}
                  {draft.data.filter((d) => d.key.trim()).map((d) => <option key={d.uid} value={d.key}>{d.key}</option>)}
                </select>
              </label>
            </div>
            <label className="flex flex-col gap-1"><span className={FIELD_LBL}>Expected result</span>
              <input id={`lab-step-${s.uid}-exp`} value={s.expected_result ?? ''} onChange={(e) => setStep(s.uid, { expected_result: e.target.value })} placeholder="What should happen; a quoted text or a URL becomes an assertion" className={INPUT} />
            </label>
          </div>
        ))}
        <button type="button" onClick={() => set({ steps: [...draft.steps, { uid: uid(), action: '', action_type: 'click', target: '', test_data_ref: null, expected_result: '' }] })}
          className="rounded-[12px] border-[1.5px] border-dashed border-[#F1A4A6] bg-[#FFF8F8] px-3 py-2 text-left text-[12.5px] font-bold text-[#941216] hover:bg-[#FFF5F5]">
          + Add step
        </button>
      </section>

      <section className="flex flex-col gap-2.5 rounded-[14px] border border-[#E8EAEE] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={ED_LBL}>Test data · {env}{data.test_data_app ? ` · ${data.test_data_app.name}` : ''}</span>
          <span className="text-[11.5px] text-[#6B7280]">{data.test_data_app ? 'Values are saved to Test Data; sensitive ones are stored encrypted' : 'No Test Data application matches this case, so values cannot be saved'}</span>
        </div>
        {draft.data.length > 0 && (
          <div className="app-scroll overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-[12.5px]">
              <thead>
                <tr className="text-left">
                  {['Key', 'Description', `Value for ${env}`, 'Sensitive', 'Used in', ''].map((h) => <th key={h} className="px-1.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {draft.data.map((d) => {
                  const used = draft.steps.map((s, i) => (s.test_data_ref === d.key ? i + 1 : 0)).filter(Boolean)
                  return (
                    <tr key={d.uid}>
                      <td className="px-1.5 py-1"><input id={`lab-data-${d.uid}-key`} value={d.key} onChange={(e) => setDatum(d.uid, { key: e.target.value })} aria-label="Key" className={`${INPUT} font-mono`} /></td>
                      <td className="px-1.5 py-1"><input id={`lab-data-${d.uid}-desc`} value={d.description} onChange={(e) => setDatum(d.uid, { description: e.target.value })} aria-label="Description" className={INPUT} /></td>
                      <td className="px-1.5 py-1">
                        <input id={`lab-data-${d.uid}-value`} type={d.sensitive ? 'password' : 'text'} autoComplete="off" value={d.value ?? ''} disabled={!data.test_data_app}
                          onChange={(e) => setDatum(d.uid, { value: e.target.value })} aria-label={`Value for ${env}`}
                          placeholder={d.hasValue ? 'Set · type to replace' : `No value for ${env}`} className={`${INPUT} disabled:bg-[#F4F5F7]`} />
                      </td>
                      <td className="px-1.5 py-1 text-center"><input id={`lab-data-${d.uid}-secret`} type="checkbox" checked={d.sensitive} onChange={(e) => setDatum(d.uid, { sensitive: e.target.checked })} aria-label="Sensitive" /></td>
                      <td className="whitespace-nowrap px-1.5 py-1 text-[11.5px] text-[#6B7280]">{used.length ? `Step ${used.join(', ')}` : '—'}</td>
                      <td className="px-1.5 py-1">
                        <button type="button" onClick={() => set({ data: draft.data.filter((x) => x.uid !== d.uid), steps: draft.steps.map((s) => (s.test_data_ref === d.key ? { ...s, test_data_ref: null } : s)) })} className={`${MINI} !text-[#A3231C]`}>Delete</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <button type="button" onClick={() => set({ data: [...draft.data, { uid: uid(), key: '', description: '', sensitive: false, hasValue: false, stored: null }] })}
          className="rounded-[12px] border-[1.5px] border-dashed border-[#F1A4A6] bg-[#FFF8F8] px-3 py-2 text-left text-[12.5px] font-bold text-[#941216] hover:bg-[#FFF5F5]">
          + Add test data key
        </button>
      </section>

      {(problems.length > 0 || saveError) && (
        <div className="rounded-[12px] border border-[#F6D4D5] bg-[#FFF8F8] px-3 py-2 text-[12.5px] text-[#7A0B0D]" role="alert">
          {[...problems, saveError].filter(Boolean).map((p) => <div key={p!}>{p}</div>)}
        </div>
      )}

      <div className="sticky bottom-0 flex flex-wrap items-end justify-between gap-3 rounded-[14px] border border-[#E8EAEE] bg-white px-3.5 py-3 shadow-[0_-8px_24px_rgba(16,24,40,0.06)]">
        <div>
          <span className={ED_LBL}>Saving updates</span>
          <ul className="mt-1.5 list-disc pl-[18px] text-[12px] leading-[1.6] text-[#1F2937]">
            <li>The case's title, preconditions, steps and expected result (case version {data.version + 1}); it stays approved</li>
            <li>Test Data values for {env}{data.test_data_app ? ` in ${data.test_data_app.name}` : ''}, where you typed one</li>
            {script?.edited_by_user
              ? <li className="text-[#8A5000]">The script was edited by hand, so it is not regenerated. Regenerate it from Generate once you have kept what you need.</li>
              : <li>The script, regenerated as v{(script?.version ?? 0) + 1} and checked by the static gate{script ? ` (v${script.version} stays in History)` : ''}</li>}
          </ul>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} disabled={saving} className={BTN}>Back to the journey</button>
          <button type="button" onClick={() => onSave(draft)} disabled={saving || problems.length > 0} className={PRIMARY}>
            {saving ? 'Saving…' : script?.edited_by_user ? 'Save' : 'Save & regenerate script'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default LabTestSteps
