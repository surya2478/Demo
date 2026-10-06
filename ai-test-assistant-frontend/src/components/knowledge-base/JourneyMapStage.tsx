// --- Journey Map ---------------------------------------------------------------------
//
// One journey on one screen: its steps (the Journey KB), how each is carried
// out (the Automation KB selector of the step's element, and whether the last
// walk confirmed it), and the flow blueprint's step for it. The journey owns
// the steps -- edited only here -- and the flow blueprint is generated from
// them, in the same review, so the two cannot drift apart again.

import React, { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import knowledgeBaseService, {
  type JourneyMap, type JourneyStepEdit, type MapCapture, type MapFlowState, type MapRow
} from '../../services/knowledgeBaseService'
import { CHIP, Card, Failed, Loading, Note, TONE, useLoad } from './kbUi'
import { EDIT_BTN, EditorBar, FIELD, ICON, PLAIN_BTN, PublishToggle, useKbEdit } from './kbEdit'

const CAPTURE: Record<MapCapture, { label: string; tone: keyof typeof TONE; hint: string }> = {
  confirmed: { label: 'Confirmed', tone: 'good', hint: 'The last walk found it with this selector' },
  to_confirm: { label: 'Not walked', tone: 'info', hint: 'The Automation KB has a selector; no walk has confirmed it yet' },
  failed: { label: 'Failed in walk', tone: 'bad', hint: 'The last walk could not find it with this selector — pick a suggestion on the walk' },
  captured: { label: 'Captured · propose', tone: 'warn', hint: 'The last walk captured a selector; propose it from the walk to add it to the Automation KB' },
  needs_capture: { label: 'Needs capture', tone: 'warn', hint: 'No selector yet: walk the journey to capture one' },
  broken_ref: { label: 'Broken reference', tone: 'bad', hint: 'The element points at a selector the Automation KB does not have' },
  unknown_element: { label: 'Unknown element', tone: 'bad', hint: 'The step names an element its screen does not have — pick one' },
  screen: { label: 'Screen check', tone: 'idle', hint: 'A check of the whole screen, with no single element' }
}

const FLOW: Record<MapFlowState, { label: string; tone: keyof typeof TONE; hint: string }> = {
  same: { label: 'In flow', tone: 'good', hint: 'The flow blueprint has this step, as the journey says it' },
  differs: { label: 'Flow differs', tone: 'warn', hint: 'The flow blueprint words it or targets it differently — regenerate the flow' },
  missing: { label: 'Not in flow', tone: 'warn', hint: 'The flow blueprint has no step for this — regenerate the flow' },
  error_path: { label: 'Error path', tone: 'idle', hint: 'An error branch: tested by scenarios, not part of the flow' },
  only_flow: { label: 'Only in flow', tone: 'info', hint: 'The flow blueprint has a step the journey does not' }
}

const COLS = 'grid grid-cols-[34px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] items-start gap-3'

interface Draft extends JourneyStepEdit { key: string; fromFlow?: boolean }

let counter = 0
const newKey = () => `n${++counter}`

const Badge: React.FC<{ tone: keyof typeof TONE; title?: string; children: React.ReactNode }> = ({ tone, title, children }) => (
  <span title={title} className={`${CHIP} ${TONE[tone]}`}>{children}</span>
)

const Mono: React.FC<{ value?: string | null }> = ({ value }) =>
  value ? <span className="block truncate font-mono text-[11px] text-[#4B5563]" title={value}>{value}</span> : <span className="text-[11.5px] text-[#9CA3AF]">—</span>

// --- Reading -------------------------------------------------------------------------------

const MapRows: React.FC<{ map: JourneyMap; onWalk: () => void }> = ({ map, onWalk }) => (
  <div>
    <div className={`${COLS} border-y border-[#F1F2F4] bg-[#F9FAFB] px-5 py-2 text-[11px] font-bold uppercase tracking-[0.08em] text-[#6B7280]`}>
      <span>#</span><span>Journey step · screen · element</span><span>How it is done (Automation KB)</span><span>Flow blueprint</span>
    </div>
    {map.rows.map((row, i) => row.kind === 'flow_only' ? (
      <div key={`f${i}`} className={`${COLS} border-b border-[#F1F2F4] bg-[#F8FAFF] px-5 py-2 text-[12.5px]`}>
        <span className="text-[#9CA3AF]">–</span>
        <span className="text-[12px] italic text-[#6B7280]">Not in the journey. Add it there if the journey should have it; otherwise it goes when the flow is regenerated.</span>
        <span><Mono value={row.flow_step?.target} /></span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-[#1F2937]">{row.flow_step?.step_number}. {row.flow_step?.action}</span>
          <Badge {...FLOW.only_flow} title={FLOW.only_flow.hint}>{FLOW.only_flow.label}</Badge>
        </span>
      </div>
    ) : (
      <StepRow key={`s${row.step_number}`} row={row} onWalk={onWalk} />
    ))}
  </div>
)

const StepRow: React.FC<{ row: MapRow; onWalk: () => void }> = ({ row, onWalk }) => {
  const capture = row.capture ? CAPTURE[row.capture] : null
  const flow = FLOW[row.flow_state]
  // Say what differs: an old wording in the flow is not the same as a different selector.
  const diff = row.flow_diff ?? []
  const flowLabel = row.flow_state !== 'differs' || !diff.length ? flow.label
    : diff.length === 2 ? 'Wording & selector differ' : diff[0] === 'wording' ? 'Wording differs' : 'Selector differs'
  const flowHint = row.flow_state !== 'differs' || !diff.length ? flow.hint
    : diff.includes('selector')
      ? 'The flow blueprint uses a different selector or address than the Automation KB has for this step. Regenerate the flow to use the Automation KB one.'
      : 'Same selector; the flow blueprint only words the step differently (its older wording). Regenerate the flow to take the journey’s words.'
  const needsWalk = row.capture === 'needs_capture' || row.capture === 'failed' || row.capture === 'to_confirm'
  return (
    <div className={`${COLS} border-b border-[#F1F2F4] px-5 py-2.5 text-[12.5px] ${row.branch === 'negative_only' ? 'bg-[#FCFCFD]' : ''}`}>
      <span className="font-bold text-[#1F2937]">{row.step_number}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[#1F2937]">{row.action}</span>
        {row.expected_result && <span className="text-[#6B7280]">{row.expected_result}</span>}
        <span className="text-[11.5px] text-[#9CA3AF]">
          {(row.screen_names ?? []).join(' or ') || 'no screen'}
          {row.element_id ? ` · ${row.element_label ?? row.element_id}` : ''}
          {row.branch === 'negative_only' ? ' · error path' : ''}
        </span>
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        {row.target_kind === 'route' ? <span className="text-[11px] text-[#6B7280]">address</span> : null}
        <Mono value={row.target ?? row.walk_selector} />
        <span className="flex flex-wrap items-center gap-1.5">
          {capture && <Badge tone={capture.tone} title={capture.hint}>{capture.label}</Badge>}
          {needsWalk && <button type="button" onClick={onWalk} className="text-[11.5px] font-semibold text-[#B71920] hover:underline">Walk</button>}
        </span>
        {row.walk_reason && <span className="text-[11px] text-[#A3231C]">{row.walk_reason}</span>}
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        {row.flow_step
          ? <span className={row.flow_state === 'differs' ? 'text-[#8A5000]' : 'text-[#4B5563]'}>{row.flow_step.step_number}. {row.flow_step.action}</span>
          : <span className="text-[11.5px] text-[#9CA3AF]">—</span>}
        <Badge tone={flow.tone} title={flowHint}>{flowLabel}</Badge>
      </span>
    </div>
  )
}

// --- Editing ---------------------------------------------------------------------------------

const StepsEditor: React.FC<{ map: JourneyMap; busy: boolean; publish: boolean; onCancel: () => void; onSave: (steps: JourneyStepEdit[]) => void }> = ({ map, busy, publish, onCancel, onSave }) => {
  const screens = map.screens
  const [rows, setRows] = useState<Draft[]>(() => map.rows.filter(r => r.kind === 'step').map(r => ({
    key: `s${r.step_number}`, from_step: r.step_number ?? null, action: r.action ?? '', expected_result: r.expected_result ?? '',
    screen_id: (r.screen_ids ?? []).join('|') || '', element_id: r.element_id ?? ''
  })))
  // The flow's own steps, offered for adding where they fall.
  const flowOnly = map.rows.filter(r => r.kind === 'flow_only' && r.flow_step).map(r => r.flow_step!)
  const [offered, setOffered] = useState(flowOnly)

  const update = (key: string, patch: Partial<Draft>) => setRows(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)))
  const move = (i: number, by: number) => setRows(prev => { const n = [...prev]; const [r] = n.splice(i, 1); n.splice(i + by, 0, r); return n })
  const insertAt = (i: number, row?: Partial<Draft>) => setRows(prev => {
    const n = [...prev]
    n.splice(i, 0, { key: newKey(), from_step: null, action: '', expected_result: '', screen_id: prev[i - 1]?.screen_id ?? '', element_id: '', ...row })
    return n
  })
  const remove = (key: string) => setRows(prev => prev.filter(r => r.key !== key))
  const blank = rows.findIndex(r => !r.action.trim())
  const unknown = rows.findIndex(r => r.element_id && r.screen_id && !r.screen_id.includes('|') &&
    !(screens.find(s => s.screen_id === r.screen_id)?.elements ?? []).some(e => e.element_id === r.element_id))
  const invalid = rows.length === 0 ? 'A journey needs a step'
    : blank >= 0 ? `Step ${blank + 1} needs an action`
      : unknown >= 0 ? `Step ${unknown + 1}: pick an element its screen has` : null

  return (
    <div>
      <EditorBar title={<>Editing {rows.length} steps. The flow blueprint is regenerated from them when this is approved.</>}
        busy={busy} publish={publish} invalid={invalid} onCancel={onCancel}
        onSave={() => onSave(rows.map(({ key: _k, fromFlow: _f, ...r }) => ({ ...r, screen_id: r.screen_id || null, element_id: r.element_id || null })))} />
      {offered.length > 0 && (
        <div className="flex flex-col gap-1.5 border-b border-[#F1F2F4] bg-[#F8FAFF] px-5 py-2.5 text-[12px]">
          <span className="font-semibold text-[#1D4ED8]">Only in the flow blueprint — add to the journey, or leave out (they go when the flow is regenerated):</span>
          {offered.map(f => (
            <span key={f.step_number} className="flex flex-wrap items-center gap-2">
              <span className="text-[#1F2937]">{f.step_number}. {f.action}</span>
              <button type="button" className="font-semibold text-[#B71920] hover:underline" onClick={() => {
                insertAt(Math.min(rows.length, f.step_number - 1), { action: f.action, expected_result: f.expected_result ?? '', fromFlow: true })
                setOffered(prev => prev.filter(x => x !== f))
              }}>Add to journey at step {Math.min(rows.length, f.step_number - 1) + 1}</button>
            </span>
          ))}
        </div>
      )}
      {rows.map((row, i) => {
        const screen = screens.find(s => s.screen_id === row.screen_id)
        const combined = !!row.screen_id && row.screen_id.includes('|')
        return (
          <div key={row.key} className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-start gap-3 border-b border-[#F1F2F4] px-5 py-2.5">
            <span className="flex flex-col items-center pt-1.5">
              <span className="text-[13px] font-bold">{i + 1}</span>
              {row.from_step === null
                ? <span className="text-[10px] font-semibold text-[#136B34]">{row.fromFlow ? 'from flow' : 'new'}</span>
                : row.from_step !== i + 1 && <span className="text-[10px] text-[#A3231C]">was {row.from_step}</span>}
            </span>
            <span className="flex min-w-0 flex-col gap-1.5">
              <input aria-label={`Step ${i + 1} action`} value={row.action} placeholder="What the user does" onChange={e => update(row.key, { action: e.target.value })}
                className={`${FIELD} ${!row.action.trim() ? 'border-[#F6D4D5] bg-[#FFF5F5]' : ''}`} />
              <input aria-label={`Step ${i + 1} expected result`} value={row.expected_result} placeholder="Expected result" onChange={e => update(row.key, { expected_result: e.target.value })} className={`${FIELD} text-[#4B5563]`} />
              <span className="grid grid-cols-2 gap-1.5">
                <select aria-label={`Step ${i + 1} screen`} value={row.screen_id ?? ''} onChange={e => update(row.key, { screen_id: e.target.value, element_id: '' })} className={FIELD}>
                  <option value="">No screen</option>
                  {combined && <option value={row.screen_id ?? ''}>{row.screen_id?.split('|').map(id => screens.find(s => s.screen_id === id)?.name ?? id).join(' or ')}</option>}
                  {screens.map(s => <option key={s.screen_id} value={s.screen_id}>{s.name}</option>)}
                </select>
                <select aria-label={`Step ${i + 1} element`} value={row.element_id ?? ''} disabled={!screen} onChange={e => update(row.key, { element_id: e.target.value })}
                  className={`${FIELD} ${unknown === i ? 'border-[#F6D4D5] bg-[#FFF5F5]' : ''}`}>
                  <option value="">{screen ? 'Whole screen (no element)' : combined ? 'Either screen (no element)' : 'Pick a screen first'}</option>
                  {row.element_id && !(screen?.elements ?? []).some(e => e.element_id === row.element_id) && <option value={row.element_id}>{row.element_id} (not on this screen)</option>}
                  {(screen?.elements ?? []).map(e => <option key={e.element_id} value={e.element_id}>{e.label ?? e.element_id}{e.type ? ` · ${e.type}` : ''}</option>)}
                </select>
              </span>
            </span>
            <span className="flex flex-col gap-1">
              <span className="flex gap-1">
                <button type="button" aria-label={`Move step ${i + 1} up`} title="Move up" disabled={i === 0} onClick={() => move(i, -1)} className={ICON}>↑</button>
                <button type="button" aria-label={`Move step ${i + 1} down`} title="Move down" disabled={i === rows.length - 1} onClick={() => move(i, 1)} className={ICON}>↓</button>
              </span>
              <span className="flex gap-1">
                <button type="button" aria-label={`Add a step after step ${i + 1}`} title="Add a step below" onClick={() => insertAt(i + 1)} className={ICON}>+</button>
                <button type="button" aria-label={`Delete step ${i + 1}`} title="Delete step" disabled={rows.length === 1} onClick={() => remove(row.key)} className={`${ICON} hover:text-[#A3231C]`}>✕</button>
              </span>
            </span>
          </div>
        )
      })}
      <div className="px-5 py-3">
        <button type="button" onClick={() => insertAt(rows.length)} className="text-[12.5px] font-semibold text-[#B71920] hover:underline">+ Add step at the end</button>
      </div>
    </div>
  )
}

// --- The stage -------------------------------------------------------------------------------

const JourneyMapStage: React.FC<{
  appKey: string
  canExecute?: boolean
  canApprove?: boolean
  onEdited?: () => void
  onOpenStage: (stage: string, extra?: Record<string, string>) => void
}> = ({ appKey, canExecute = false, canApprove = false, onEdited, onOpenStage }) => {
  const [params, setParams] = useSearchParams()
  const [overview, overviewError, reloadOverview] = useLoad(appKey, () => knowledgeBaseService.journeyMapOverview(appKey))
  const asked = params.get('journey')
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => {
    if (!overview || selected) return
    setSelected(overview.journeys.some(j => j.journey_id === asked) ? asked : overview.journeys[0]?.journey_id ?? null)
  }, [overview, selected, asked])
  const choose = (id: string) => {
    setSelected(id)
    setEditing(false)
    setParams(prev => { const p = new URLSearchParams(prev); p.set('journey', id); return p }, { replace: true })
  }
  const [map, mapError, reloadMap] = useLoad(selected ? `${appKey}:${selected}` : null, () => knowledgeBaseService.journeyMap(appKey, selected as string))
  const [editing, setEditing] = useState(false)
  const [linkChoice, setLinkChoice] = useState('')
  useEffect(() => setLinkChoice(map?.suggested_flows[0]?.flow_id ?? 'new'), [map])
  const reload = () => { reloadMap(); reloadOverview() }
  const { publish, publishNow, setPublishNow, busy, run } = useKbEdit(canApprove, onEdited)

  const save = (body: { steps?: JourneyStepEdit[]; link_flow?: string | null }, what: string) =>
    run(what, p => knowledgeBaseService.saveJourneyMap(appKey, selected as string, { ...body, publish: p }), () => { setEditing(false); reload() })

  const walk = () => onOpenStage('crawl', { journey: selected ?? '', record: '' })
  const record = () => onOpenStage('crawl', { journey: selected ?? '', record: '1' })
  const s = map?.summary
  const flowLabel = useMemo(() => {
    if (!map?.flow) return null
    return map.flow.up_to_date ? 'up to date with the journey' : 'out of date — regenerate it'
  }, [map])

  return (
    <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
      <Card className="flex flex-col self-start">
        <div className="border-b border-[#F1F2F4] px-4 py-3">
          <div className="text-[14px] font-bold text-[#1F2937]">Journeys</div>
          <div className="text-[11.5px] text-[#6B7280]">Each with its flow blueprint</div>
        </div>
        {overviewError && <Failed message={overviewError} onRetry={reloadOverview} />}
        {!overview && !overviewError && <Loading what="journeys" />}
        {overview?.journeys.map(j => {
          const todo = j.summary ? j.summary.flow_differs + j.summary.only_in_flow + j.summary.needs_capture + j.summary.failed : 0
          return (
            <button key={j.journey_id} type="button" onClick={() => choose(j.journey_id)}
              className={`flex flex-col gap-1 border-b border-[#F1F2F4] px-4 py-2.5 text-left ${selected === j.journey_id ? 'bg-[#FFF5F5]' : 'hover:bg-[#FAFAFB]'}`}>
              <span className="text-[13px] font-semibold text-[#1F2937]">{j.journey_name}</span>
              <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-[#6B7280]">
                {j.flow ? <span className="font-mono">{j.flow.flow_id}</span> : <Badge tone="warn">no flow</Badge>}
                {j.summary && <span>· {j.summary.steps} steps</span>}
                {todo > 0 ? <Badge tone="warn">{todo} to fix</Badge> : j.summary ? <Badge tone="good">in step</Badge> : null}
              </span>
            </button>
          )
        })}
      </Card>

      <Card className="min-w-0">
        {mapError && <Failed message={mapError} onRetry={reloadMap} />}
        {!map && !mapError && selected && <Loading what="the journey map" />}
        {map && (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3 px-5 pb-3 pt-4">
              <div className="flex min-w-0 flex-col gap-1">
                <h2 className="m-0 text-[17px] font-bold text-[#1F2937]">{map.journey_name}</h2>
                <span className="text-[12px] text-[#6B7280]">
                  {map.flow
                    ? <>Flow blueprint <span className="font-mono text-[#1F2937]">{map.flow.flow_id}</span> · {map.flow.steps} steps · <span className={map.flow.up_to_date ? 'text-[#136B34]' : 'font-semibold text-[#8A5000]'}>{flowLabel}</span></>
                    : 'No flow blueprint yet: link one or create it from this journey.'}
                  {map.walk && <> · last walk #{map.walk.id} in {map.walk.environment}{map.walk.when ? `, ${new Date(map.walk.when + 'Z').toLocaleString()}` : ''}</>}
                </span>
              </div>
              {canExecute && !editing && (
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={record} className={PLAIN_BTN} title="Do the journey yourself in a browser; what you do becomes its steps and its flow">Record this journey</button>
                  <button type="button" onClick={walk} className={PLAIN_BTN}>Walk this journey</button>
                  {map.flow && !map.flow.up_to_date && (
                    <button type="button" disabled={busy} onClick={() => void save({}, 'Flow regeneration')} className={PLAIN_BTN}
                      title="Rebuild the flow blueprint's steps from the journey; QA-recorded targets are kept">Regenerate flow</button>
                  )}
                  <button type="button" onClick={() => setEditing(true)} className={EDIT_BTN}>Edit steps</button>
                </div>
              )}
            </div>

            {s && (
              <div className="flex flex-wrap gap-1.5 px-5 pb-3">
                <Badge tone="good">{s.mapped} of {s.steps} mapped</Badge>
                {s.confirmed > 0 && <Badge tone="good">{s.confirmed} confirmed by walk</Badge>}
                {s.needs_capture > 0 && <Badge tone="warn">{s.needs_capture} need capture</Badge>}
                {s.failed > 0 && <Badge tone="bad">{s.failed} failed in walk</Badge>}
                {s.flow_differs > 0 && <Badge tone="warn">{s.flow_differs} differ from the flow</Badge>}
                {s.only_in_flow > 0 && <Badge tone="info">{s.only_in_flow} only in the flow</Badge>}
              </div>
            )}

            {!map.flow && canExecute && !editing && (
              <div className="mx-5 mb-3 flex flex-wrap items-center gap-2 rounded-[12px] border border-[#EBCFA4] bg-[#FFFBF4] px-3.5 py-2.5 text-[12.5px]">
                <span className="text-[#8A5000]">Link a flow blueprint:</span>
                <select aria-label="Flow blueprint to link" value={linkChoice} onChange={e => setLinkChoice(e.target.value)} className={`${FIELD} w-auto max-w-[420px]`}>
                  {map.suggested_flows.map(f => <option key={f.flow_id} value={f.flow_id}>{f.flow_name} (suggested)</option>)}
                  {(overview?.flows ?? []).filter(f => !f.linked && !map.suggested_flows.some(x => x.flow_id === f.flow_id)).map(f =>
                    <option key={f.flow_id} value={f.flow_id}>{f.flow_name}</option>)}
                  <option value="new">Create a new flow from this journey</option>
                </select>
                <button type="button" disabled={busy || !linkChoice} className={EDIT_BTN}
                  onClick={() => void save({ link_flow: linkChoice }, linkChoice === 'new' ? 'New flow' : 'Flow link')}>
                  {linkChoice === 'new' ? 'Create flow' : 'Link and regenerate'}
                </button>
                <span className="text-[11.5px] text-[#6B7280]">Linking regenerates that flow from this journey; its QA-recorded targets are kept.</span>
              </div>
            )}

            {map.walk?.derailed && (
              <div className="px-5 pb-3"><Note tone="warn">The last walk left the path after step {map.walk.derailed.after}: {map.walk.derailed.reason}. Steps after it were not checked.</Note></div>
            )}

            <div className="flex items-center justify-between gap-2 px-5 pb-2 text-[11.5px] text-[#6B7280]">
              <span>The journey owns the steps; selectors come from the Automation KB; the flow blueprint is generated from both.</span>
              {canExecute && <PublishToggle canApprove={canApprove} publishNow={publishNow} onChange={setPublishNow} />}
            </div>

            {editing
              ? <StepsEditor key={map.journey_id} map={map} busy={busy} publish={publish} onCancel={() => setEditing(false)}
                  onSave={steps => void save({ steps }, 'Journey steps')} />
              : <MapRows map={map} onWalk={walk} />}
          </>
        )}
      </Card>
    </div>
  )
}

export default JourneyMapStage
