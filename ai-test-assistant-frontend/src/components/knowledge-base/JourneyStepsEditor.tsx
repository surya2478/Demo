import React, { useState } from 'react'
import type { JourneyStep, JourneyStepEdit } from '../../services/knowledgeBaseService'

// Reorder, edit, add and delete a journey's steps. Nothing is written here:
// Save hands the whole list, in order, to the backend, which drafts it as a
// change set and renumbers what points at step numbers (branches, scenarios).

interface Row extends JourneyStepEdit {
  key: string
}

interface Props {
  steps: JourneyStep[]
  saving: boolean
  canPublish: boolean
  onSave: (steps: JourneyStepEdit[], publish: boolean) => void
  onCancel: () => void
  /** The save button's label when not publishing. */
  saveLabel?: string
}

let counter = 0
const newKey = () => `new-${++counter}`

const INPUT = 'w-full rounded-[8px] border border-[#E8EAEE] bg-white px-2.5 py-1.5 text-[12.5px] focus:border-[#B71920] focus:outline-none'
const ICON_BTN = 'flex h-7 w-7 items-center justify-center rounded-[8px] border border-[#E8EAEE] bg-white text-[13px] text-[#374151] hover:border-[#F6D4D5] hover:text-[#B71920] disabled:cursor-not-allowed disabled:opacity-35'

const JourneyStepsEditor: React.FC<Props> = ({ steps, saving, canPublish, onSave, onCancel, saveLabel = 'Save for review' }) => {
  const [rows, setRows] = useState<Row[]>(() =>
    steps.map(s => ({
      key: `s${s.step_number}`,
      from_step: s.step_number,
      action: s.action,
      expected_result: s.expected_result ?? '',
      screen_id: s.screen_id ?? '',
      element_id: s.element_id ?? ''
    }))
  )

  const original = steps.length
  const deleted = steps.filter(s => !rows.some(r => r.from_step === s.step_number)).map(s => s.step_number)
  const moved = rows.filter((r, i) => r.from_step !== null && r.from_step !== i + 1).length
  const added = rows.filter(r => r.from_step === null).length
  const blank = rows.findIndex(r => !r.action.trim())

  const update = (key: string, patch: Partial<Row>) => setRows(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)))
  const move = (index: number, by: number) => setRows(prev => {
    const next = [...prev]
    const [row] = next.splice(index, 1)
    next.splice(index + by, 0, row)
    return next
  })
  const insertAfter = (index: number) => setRows(prev => {
    const next = [...prev]
    next.splice(index + 1, 0, { key: newKey(), from_step: null, action: '', expected_result: '', screen_id: prev[index]?.screen_id ?? '', element_id: '' })
    return next
  })
  const remove = (key: string) => setRows(prev => prev.filter(r => r.key !== key))

  const save = (publish: boolean) =>
    onSave(rows.map(({ key: _key, ...r }) => ({ ...r, screen_id: r.screen_id || null, element_id: r.element_id || null })), publish)

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#F1F2F4] bg-[#FFFCF7] px-5 py-2.5 text-[12.5px]">
        <span className="text-[#4B5563]">
          Editing {rows.length} step{rows.length === 1 ? '' : 's'}
          {moved > 0 && <> · {moved} moved</>}
          {added > 0 && <> · {added} new</>}
          {deleted.length > 0 && <> · deleted {deleted.map(n => `#${n}`).join(', ')}</>}
          <span className="ml-1 text-[#6B7280]">— branches and scenarios are renumbered to match.</span>
        </span>
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} disabled={saving} className="h-[32px] rounded-[10px] border border-[#E8EAEE] bg-white px-3 text-[12.5px] font-bold text-[#1F2937] hover:border-[#F6D4D5]">Cancel</button>
          <button type="button" onClick={() => save(false)} disabled={saving || blank >= 0 || rows.length === 0}
            title={blank >= 0 ? `Step ${blank + 1} needs an action` : 'Saved as a change set, published after review'}
            className={`h-[32px] rounded-[10px] px-3 text-[12.5px] font-bold disabled:cursor-not-allowed disabled:opacity-50 ${canPublish ? 'border border-[#E8EAEE] bg-white text-[#1F2937] hover:border-[#F6D4D5]' : 'bg-[#B71920] text-white hover:opacity-95'}`}>
            {saving && !canPublish ? 'Saving…' : saveLabel}
          </button>
          {canPublish && (
            <button type="button" onClick={() => save(true)} disabled={saving || blank >= 0 || rows.length === 0}
              className="h-[32px] rounded-[10px] bg-[#B71920] px-3 text-[12.5px] font-bold text-white hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50">
              {saving ? 'Saving…' : 'Save & publish'}
            </button>
          )}
        </div>
      </div>

      {rows.map((row, index) => (
        <div key={row.key} className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-start gap-3 border-b border-[#F1F2F4] px-5 py-2.5">
          <span className="flex flex-col items-center pt-1.5">
            <span className="text-[13px] font-bold text-[#1F2937]">{index + 1}</span>
            {row.from_step === null
              ? <span className="text-[10px] font-semibold text-[#136B34]">new</span>
              : row.from_step !== index + 1 && <span className="text-[10px] text-[#A3231C]" title={`Step ${row.from_step} before this edit`}>was {row.from_step}</span>}
          </span>
          <span className="flex min-w-0 flex-col gap-1.5">
            <input aria-label={`Step ${index + 1} action`} value={row.action} placeholder="Action — what the user does"
              onChange={e => update(row.key, { action: e.target.value })}
              className={`${INPUT} ${!row.action.trim() ? 'border-[#F6D4D5] bg-[#FFF5F5]' : ''}`} />
            <input aria-label={`Step ${index + 1} expected result`} value={row.expected_result} placeholder="Expected result"
              onChange={e => update(row.key, { expected_result: e.target.value })} className={`${INPUT} text-[#4B5563]`} />
            <span className="grid grid-cols-2 gap-1.5">
              <input aria-label={`Step ${index + 1} screen`} value={row.screen_id ?? ''} placeholder="Screen id (e.g. SCR_LOGIN)"
                onChange={e => update(row.key, { screen_id: e.target.value })} className={`${INPUT} font-mono text-[11.5px]`} />
              <input aria-label={`Step ${index + 1} element`} value={row.element_id ?? ''} placeholder="Element id (e.g. tab_otp)"
                onChange={e => update(row.key, { element_id: e.target.value })} className={`${INPUT} font-mono text-[11.5px]`} />
            </span>
          </span>
          <span className="flex flex-col gap-1">
            <span className="flex gap-1">
              <button type="button" aria-label={`Move step ${index + 1} up`} title="Move up" disabled={index === 0} onClick={() => move(index, -1)} className={ICON_BTN}>↑</button>
              <button type="button" aria-label={`Move step ${index + 1} down`} title="Move down" disabled={index === rows.length - 1} onClick={() => move(index, 1)} className={ICON_BTN}>↓</button>
            </span>
            <span className="flex gap-1">
              <button type="button" aria-label={`Add a step after step ${index + 1}`} title="Add a step below" onClick={() => insertAfter(index)} className={ICON_BTN}>+</button>
              <button type="button" aria-label={`Delete step ${index + 1}`} title="Delete step" disabled={rows.length === 1} onClick={() => remove(row.key)} className={`${ICON_BTN} hover:text-[#A3231C]`}>✕</button>
            </span>
          </span>
        </div>
      ))}
      {rows.length === 0 && <p className="px-5 py-4 text-[12.5px] text-[#6B7280]">No steps left. Add one, or cancel.</p>}
      <div className="px-5 py-3">
        <button type="button" onClick={() => insertAfter(rows.length - 1)} className="text-[12.5px] font-semibold text-[#B71920] hover:underline">+ Add step at the end</button>
        {original > 0 && deleted.length > 0 && (
          <span className="ml-3 text-[12px] text-[#6B7280]">A branch anchored on a deleted step moves to the step before it; the change set says which.</span>
        )}
      </div>
    </div>
  )
}

export default JourneyStepsEditor
