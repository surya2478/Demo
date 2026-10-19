/**
 * The Automation Lab's Test steps tab: each step of the case beside the test
 * data it uses, the element its script acts on (and where that element came
 * from), and whether its expected result is asserted. Edit opens the steps,
 * the case fields and the test data together; saving writes the case and Test
 * Data, then the Lab regenerates the script from the edited steps.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import automationService from '../../services/automationService'
import { environmentLabel } from '../../services/testDataService'
import type { LabCaseSteps, LabCaseStepsSave, LabStep, ScriptAsset } from '../../types/automation'
import { BTN, CHIP, PRIMARY, stepBlocks } from './labShared'

// --- What each step block of the script does ----------------------------------------------

export type ElementSource = 'page' | 'kb' | 'ai' | 'missing' | 'none'

export interface ScriptStep {
  source: ElementSource
  confidence: number | null
  /** The line that acts on the element, or the address a page step opens. */
  locator: string | null
  asserted: boolean
}

/** Read from the generated code: the compiler marks guessed locators and unresolved targets in comments. */
export const scriptStepMap = (code: string): ScriptStep[] => {
  const lines = code.split('\n')
  return stepBlocks(code).map(({ start, end }) => {
    const block = lines.slice(start + 1, end + 1)
    const live = block.filter((line) => !line.trim().startsWith('//'))
    const action = live.find((line) => /\bpage\.(getBy\w+|locator)\(/.test(line))
    const nav = live.find((line) => /\bnavigateTo\(|\bpage\.goto\(/.test(line))
    const ai = block.map((line) => /\[AI-resolved locator, confidence (\d+)\]/.exec(line)).find(Boolean)
    const missing = block.some((line) => /^\s*\/\/\s*TODO:/.test(line))
    const source: ElementSource = missing ? 'missing' : ai ? 'ai' : action ? 'kb' : nav ? 'page' : 'none'
    const address = nav ? /["'`]([^"'`]+)["'`]/.exec(nav)?.[1] ?? null : null
    return {
      source,
      confidence: ai ? Number(ai[1]) : null,
      locator: action ? action.trim().replace(/^await\s+/, '').replace(/;\s*$/, '') : address,
      asserted: live.some((line) => /\bexpect\(/.test(line))
    }
  })
}

/** Steps whose element is guessed or not found: the Test steps tab's badge. */
export const stepsNeedingAttention = (code: string) =>
  scriptStepMap(code).filter((s) => s.source === 'ai' || s.source === 'missing').length

const SOURCE_CHIP: Record<ElementSource, { label: string; tone: string }> = {
  page: { label: 'Page address', tone: 'bg-[#EEF4FC] text-[#234A78]' },
  kb: { label: 'Knowledge Base', tone: 'bg-[#EAF7EF] text-[#136B34]' },
  ai: { label: 'AI-guessed', tone: 'bg-[#FFF4E5] text-[#8A5000]' },
  missing: { label: 'Not found', tone: 'bg-[#FEEBEC] text-[#A3231C]' },
  none: { label: 'No element', tone: 'bg-[#F4F5F7] text-[#6B7280]' }
}

const LBL = 'text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#6B7280]'
const MONO = 'break-all rounded-[6px] bg-[#F4F5F7] px-1.5 py-px font-mono text-[11px] text-[#1F2937]'
const INPUT = 'w-full rounded-[10px] border border-[#E8EAEE] bg-white px-2.5 py-[7px] text-[12.5px] text-[#1F2937] outline-none focus:border-[#B71920] focus:shadow-[0_0_0_3px_#FDEBEC]'
const FIELD_LBL = 'text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[#6B7280]'
const MINI = 'inline-flex h-6 min-w-[24px] items-center justify-center rounded-[8px] border border-[#E8EAEE] bg-white px-2 text-[11px] font-bold text-[#1F2937] disabled:cursor-not-allowed disabled:opacity-40'
const ACTION_TYPES = ['navigate', 'click', 'fill', 'select', 'assert', 'wait']
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/
const isPlaceholder = (ref: string | null | undefined) => Boolean(ref && ref.trim().startsWith('<<'))
/** A fill step aimed at both the username and the password: one value cannot fill two fields. */
const isCombinedLogin = (step: { action_type: string | null; target: string | null; action: string }) =>
  step.action_type === 'fill' && /user|e-?mail|login/i.test(`${step.target} ${step.action}`) && /pass/i.test(`${step.target} ${step.action}`)

// --- Edit draft ---------------------------------------------------------------------------------

interface DraftStep extends Omit<LabStep, 'step_number'> { uid: string }
interface DraftData { uid: string; key: string; description: string; sensitive: boolean; hasValue: boolean; value?: string }
interface Draft { title: string; preconditions: string; expected_result: string; steps: DraftStep[]; data: DraftData[] }

let seed = 0
const uid = () => `u${++seed}`

const toDraft = (src: LabCaseSteps): Draft => ({
  title: src.title,
  preconditions: src.preconditions,
  expected_result: src.expected_result,
  steps: src.steps.map(({ step_number: _n, ...s }) => ({ ...s, uid: uid() })),
  data: src.test_data.map((d) => ({ uid: uid(), key: d.key, description: d.description ?? '', sensitive: d.sensitive, hasValue: d.has_value }))
})

interface Props {
  caseId: number
  script: ScriptAsset | null
  canExecute: boolean
  applicationId: number | null
  /** Show this step's lines in the Script tab. */
  onJump: (step: number) => void
  onEditingChange: (editing: boolean) => void
  /** After a save: regenerate the script and reload; resolves to what to tell the user. */
  onSaved: () => Promise<void>
}

const LabTestSteps: React.FC<Props> = ({ caseId, script, canExecute, applicationId, onJump, onEditingChange, onSaved }) => {
  const [data, setData] = useState<LabCaseSteps | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])

  const load = useCallback(async () => {
    try {
      setData(await automationService.getLabCaseSteps(caseId, applicationId))
      setError(null)
    } catch (err: any) {
      setError(err?.message ?? 'The steps could not be loaded.')
    }
  }, [caseId, applicationId])

  useEffect(() => { setData(null); setDraft(null); setWarnings([]); void load() }, [load])
  useEffect(() => { onEditingChange(draft !== null) }, [draft, onEditingChange])
  // Reload when a new script version lands, so the element column follows it.
  useEffect(() => { if (!draft) void load() }, [script?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const map = useMemo(() => scriptStepMap(script?.code ?? ''), [script?.code])
  const gateNotes = (script?.static_gate_result?.warnings ?? []).filter((w) => !/^Step \d+:/.test(w))

  if (error) return <div className="m-4 rounded-[12px] border border-[#F6D4D5] bg-[#FFF8F8] px-4 py-2.5 text-[13px] text-[#7A0B0D]" role="alert">{error}</div>
  if (!data) return <div className="px-6 py-12 text-center text-[13px] text-[#6B7280]">Loading the steps…</div>

  const env = environmentLabel(data.environment) || data.environment
  const keyOf = (key: string) => data.test_data.find((d) => d.key === key)

  // --- Read mode ---------------------------------------------------------------------------
  if (!draft) {
    const outOfStep = script && map.length !== data.steps.length
    const flagged = data.steps
      .map((s, i) => ({ s, m: map[i] }))
      .filter(({ m }) => m && (m.source === 'ai' || m.source === 'missing'))
    return (
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={LBL}>Step → test data → element → check</span>
          <button type="button" onClick={() => { setSaveError(null); setDraft(toDraft(data)) }} disabled={!canExecute} title={canExecute ? 'Edit the steps, test data and case fields' : 'You do not have permission to edit'} className={`${BTN} !h-8 !text-[12px]`}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
            Edit steps &amp; test data
          </button>
        </div>
        {warnings.map((w) => <div key={w} className="rounded-[12px] border border-[#EBCFA4] bg-[#FFFBF4] px-3 py-2 text-[12.5px] text-[#8A5000]">{w}</div>)}
        {!script && <div className="rounded-[12px] border border-[#E8EAEE] bg-[#FCFCFD] px-3 py-2 text-[12.5px] text-[#6B7280]">No script yet, so the element and check columns are empty. Generate it to see how each step is automated.</div>}
        {outOfStep && (
          <div className="rounded-[12px] border border-[#EBCFA4] bg-[#FFFBF4] px-3 py-2 text-[12.5px] text-[#8A5000]">
            The script has {map.length} steps and the case has {data.steps.length}, so it was generated from other steps. Regenerate it before relying on this mapping.
          </div>
        )}
        {gateNotes.map((w) => <div key={w} className="rounded-[12px] border border-[#EBCFA4] bg-[#FFFBF4] px-3 py-2 text-[12.5px] text-[#8A5000]">{w}</div>)}

        <div className="app-scroll overflow-x-auto rounded-[14px] border border-[#E8EAEE]">
          <table className="w-full min-w-[860px] border-collapse text-[12.5px]">
            <thead>
              <tr className="bg-[#FCFCFD] text-left">
                {['#', 'Test step and expected result', 'Test data', 'Element', 'Expected result'].map((h) => (
                  <th key={h} className="border-b border-[#E8EAEE] px-2.5 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.steps.map((s, i) => {
                const m = map[i]
                const ref = (s.test_data_ref ?? '').trim()
                const key = ref && !isPlaceholder(ref) ? keyOf(ref) : undefined
                return (
                  <tr key={s.step_number} onClick={() => script && onJump(s.step_number)} className={`align-top ${script ? 'cursor-pointer hover:bg-[#FFFAFA]' : ''}`} title={script ? 'Show this step in the script' : undefined}>
                    <td className="w-8 border-b border-[#E8EAEE] px-2.5 py-2.5 font-bold text-[#6B7280]">{s.step_number}</td>
                    <td className="border-b border-[#E8EAEE] px-2.5 py-2.5 leading-[1.45] text-[#1F2937]">
                      {s.action}
                      <div className="mt-0.5 text-[11.5px] text-[#6B7280]">Expected: {s.expected_result || '—'}</div>
                    </td>
                    <td className="border-b border-[#E8EAEE] px-2.5 py-2.5">
                      {!ref ? <span className="text-[#9CA3AF]">None</span>
                        : isPlaceholder(ref) ? <><span className={MONO}>{ref}</span><div className="mt-1 text-[11.5px] text-[#A3231C]">Placeholder, not a test data key</div></>
                          : (
                            <>
                              <span className={MONO}>{ref}</span>
                              {isCombinedLogin(s) && <div className="mt-1 text-[11.5px] text-[#A3231C]">One value for two fields</div>}
                              <div className={`mt-1 text-[11.5px] ${key?.has_value ? 'text-[#6B7280]' : 'text-[#A3231C]'}`}>
                                {key?.has_value ? `${env} · ${key.sensitive ? 'value set (masked)' : key.value}` : `No value for ${env}`}
                              </div>
                              {key?.matched_key && key.matched_key !== ref && <div className="text-[11.5px] text-[#8A5000]">Matched to stored “{key.matched_key}”</div>}
                            </>
                          )}
                    </td>
                    <td className="border-b border-[#E8EAEE] px-2.5 py-2.5">
                      {m ? (
                        <>
                          <span className={`${CHIP} !h-5 !px-2 !text-[10.5px] ${SOURCE_CHIP[m.source].tone}`}>{SOURCE_CHIP[m.source].label}{m.confidence != null ? ` · ${m.confidence}` : ''}</span>
                          {m.locator && <div className="mt-1"><span className={MONO}>{m.locator}</span></div>}
                          {!m.locator && s.target && <div className="mt-1 text-[11.5px] text-[#6B7280]">{s.target}</div>}
                        </>
                      ) : <span className="text-[11.5px] text-[#6B7280]">{s.target || '—'}</span>}
                    </td>
                    <td className="border-b border-[#E8EAEE] px-2.5 py-2.5">
                      {m ? (
                        m.asserted
                          ? <span className={`${CHIP} !h-5 !px-2 !text-[10.5px] bg-[#EAF7EF] text-[#136B34]`}>Asserted</span>
                          : <span className={`${CHIP} !h-5 !px-2 !text-[10.5px] bg-[#F4F5F7] text-[#6B7280]`}>{s.expected_result ? 'Comment only' : 'None'}</span>
                      ) : <span className="text-[#9CA3AF]">—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          <div className="flex flex-col gap-2 rounded-[14px] border border-[#E8EAEE] p-3">
            <span className={LBL}>Test data · {env}{data.test_data_app ? ` · ${data.test_data_app.name}` : ''}</span>
            {!data.test_data.length ? <span className="text-[12.5px] text-[#6B7280]">This case uses no test data.</span> : data.test_data.map((d) => (
              <div key={d.key} className="flex items-center justify-between gap-3 text-[12.5px]">
                <span className="min-w-0">
                  <span className={MONO}>{d.key}</span>
                  <span className="mt-0.5 block text-[11px] text-[#6B7280]">
                    {d.used_in.length ? `Step ${d.used_in.join(', ')}` : 'Not used by any step'}
                    {d.has_value ? ` · ${d.sensitive ? 'masked' : d.value}` : ''}
                    {d.matched_key && d.matched_key !== d.key ? ` · from “${d.matched_key}”` : ''}
                  </span>
                </span>
                <span className={`${CHIP} !h-[22px] !text-[10.5px] ${d.has_value ? 'bg-[#EAF7EF] text-[#136B34]' : 'bg-[#FEEBEC] text-[#A3231C]'}`}>{d.has_value ? 'Value set' : 'Missing'}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2 rounded-[14px] border border-[#E8EAEE] p-3">
            <span className={LBL}>Objects missing from the Knowledge Base</span>
            {!script ? <span className="text-[12.5px] text-[#6B7280]">Shown once the script is generated.</span>
              : !flagged.length ? <span className="text-[12.5px] text-[#136B34]">Every element this script uses came from the Knowledge Base.</span>
                : flagged.map(({ s, m }) => (
                  <div key={s.step_number} className="flex items-center justify-between gap-3 text-[12.5px]">
                    <span className="min-w-0"><span className="block truncate text-[#1F2937]">{s.target || s.action}</span><span className="text-[11px] text-[#6B7280]">Step {s.step_number}</span></span>
                    <span className={`${CHIP} !h-[22px] !text-[10.5px] ${SOURCE_CHIP[m!.source].tone}`}>{m!.source === 'missing' ? 'Not found' : 'Guessed'}</span>
                  </div>
                ))}
            {flagged.length > 0 && <Link to="/automation/knowledge-base" className="text-[12px] font-semibold text-[#B71920] hover:underline">Open the Knowledge Base</Link>}
          </div>
        </div>
      </div>
    )
  }

  // --- Edit mode -----------------------------------------------------------------------------
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d))
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
      if (!data.some((d) => d.key === key)) data.push({ uid: uid(), key, description: key === 'admin_username' ? 'Admin username' : 'Admin password', sensitive: true, hasValue: false })
    }
    set({ steps, data })
  }

  const keys = draft.data.map((d) => d.key.trim())
  const problems = [
    !draft.title.trim() && 'The title is empty.',
    !draft.steps.some((s) => s.action.trim()) && 'Keep at least one step.',
    ...draft.data.filter((d) => !KEY_RE.test(d.key.trim())).map((d) => `“${d.key || '(empty)'}” is not a valid key: letters, digits and _ only, starting with a letter.`),
    new Set(keys.map((k) => k.toLowerCase())).size !== keys.length && 'A test data key is listed twice.'
  ].filter(Boolean) as string[]

  const save = async () => {
    if (problems.length || saving) return
    const body: LabCaseStepsSave = {
      title: draft.title.trim(),
      preconditions: draft.preconditions,
      expected_result: draft.expected_result,
      steps: draft.steps.filter((s) => s.action.trim()).map(({ uid: _u, ...s }) => ({
        ...s,
        test_data_ref: s.test_data_ref && (keys.includes(s.test_data_ref) || isPlaceholder(s.test_data_ref)) ? s.test_data_ref : null
      })),
      test_data: draft.data.map((d) => ({ key: d.key.trim(), description: d.description.trim() || null, sensitive: d.sensitive, ...(d.value !== undefined ? { value: d.value } : {}) }))
    }
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await automationService.saveLabCaseSteps(caseId, body, applicationId)
      setData(saved)
      setWarnings(saved.warnings ?? [])
      setDraft(null)
      await onSaved()
    } catch (err: any) {
      setSaveError(err?.message ?? 'The changes could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const elementList = `kb-elements-${caseId}`
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={LBL}>Editing {data.display_id} · steps, test data and case fields</span>
        <span className="text-[11.5px] text-[#6B7280]">Nothing changes until you save</span>
      </div>

      <section className="flex flex-col gap-2.5 rounded-[14px] border border-[#E8EAEE] p-3">
        <span className={LBL}>Case</span>
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
          <span className={LBL}>Steps</span>
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
          <span className={LBL}>Test data · {env}{data.test_data_app ? ` · ${data.test_data_app.name}` : ''}</span>
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
        <button type="button" onClick={() => set({ data: [...draft.data, { uid: uid(), key: '', description: '', sensitive: false, hasValue: false }] })}
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
          <span className={LBL}>Saving updates</span>
          <ul className="mt-1.5 list-disc pl-[18px] text-[12px] leading-[1.6] text-[#1F2937]">
            <li>The case's title, preconditions, steps and expected result (case version {data.version + 1}); it stays approved</li>
            <li>Test Data values for {env}{data.test_data_app ? ` in ${data.test_data_app.name}` : ''}, where you typed one</li>
            {script?.edited_by_user
              ? <li className="text-[#8A5000]">The script was edited by hand, so it is not regenerated. Regenerate it from Generate once you have kept what you need.</li>
              : <li>The script, regenerated as v{(script?.version ?? 0) + 1} and checked by the static gate{script ? ` (v${script.version} stays in History)` : ''}</li>}
          </ul>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => { setDraft(null); setSaveError(null) }} disabled={saving} className={BTN}>Cancel</button>
          <button type="button" onClick={() => void save()} disabled={saving || problems.length > 0} className={PRIMARY}>
            {saving ? 'Saving…' : script?.edited_by_user ? 'Save' : 'Save & regenerate script'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default LabTestSteps
