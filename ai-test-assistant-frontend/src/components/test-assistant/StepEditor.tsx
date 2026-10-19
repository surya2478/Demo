import React, { useState } from 'react'
import type { CheckItem, EditedStep } from '../../services/aiChecksService'

// Screen 3a: edit a checked case's steps before it is sent. Author-side only --
// the manager's screen stays read-only, so one final version is approved.
// Saving re-runs Quality Review and AI Classify for this case.

const ACTION_TYPES = ['navigate', 'click', 'fill', 'select', 'assert', 'wait'] as const
const TODO = /(<<TODO:[^>]*>>)/

interface DraftStep extends EditedStep {
  key: string
}

const Grip = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="#9CA3AF" aria-hidden>
    <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" /><circle cx="9" cy="12" r="1.5" />
    <circle cx="15" cy="12" r="1.5" /><circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
  </svg>
)

const IconButton: React.FC<{ label: string; onClick: () => void; children: React.ReactNode; className?: string }> = ({ label, onClick, children, className = '' }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    title={label}
    className={`flex h-7 w-7 items-center justify-center rounded-[8px] border border-[#E8EAEE] bg-white transition hover:border-[#F6D4D5] ${className}`}
  >
    {children}
  </button>
)

const PenIcon = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="1.8" aria-hidden><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
const TrashIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#B71920" strokeWidth="1.8" aria-hidden>
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
  </svg>
)

const withTodos = (text: string) =>
  text.split(TODO).map((part, index) =>
    TODO.test(part) ? (
      <span key={index} className="rounded-[6px] border border-[#EBCFA4] bg-white px-[5px] py-px font-mono text-[11.5px] text-[#8A5000]">{part}</span>
    ) : (
      <React.Fragment key={index}>{part}</React.Fragment>
    )
  )

let keySeed = 0
const nextKey = () => `s${++keySeed}`

interface StepEditorProps {
  item: CheckItem
  totalCases: number
  saving: boolean
  error: string
  onCancel: () => void
  onSave: (steps: EditedStep[]) => void
}

const StepEditor: React.FC<StepEditorProps> = ({ item, totalCases, saving, error, onCancel, onSave }) => {
  const [steps, setSteps] = useState<DraftStep[]>(() =>
    (item.steps_structured ?? []).map((step) => ({
      key: nextKey(),
      action: step.action,
      action_type: step.action_type,
      expected_result: step.expected_result,
      target: step.target,
      test_data_ref: step.test_data_ref
    }))
  )
  const [editing, setEditing] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)

  const update = (key: string, patch: Partial<DraftStep>) =>
    setSteps((current) => current.map((step) => (step.key === key ? { ...step, ...patch } : step)))
  const remove = (key: string) => {
    setSteps((current) => current.filter((step) => step.key !== key))
    if (editing === key) setEditing(null)
  }
  const add = () => {
    const key = nextKey()
    setSteps((current) => [...current, { key, action: '', action_type: null, expected_result: '' }])
    setEditing(key)
  }
  const moveTo = (fromKey: string, toKey: string) => {
    if (fromKey === toKey) return
    setSteps((current) => {
      const from = current.findIndex((step) => step.key === fromKey)
      const to = current.findIndex((step) => step.key === toKey)
      if (from < 0 || to < 0) return current
      const next = [...current]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  const valid = steps.some((step) => step.action.trim())
  const score = item.score_after ?? item.score_before

  return (
    <section className="flex flex-col overflow-hidden rounded-[20px] border border-[#E8EAEE] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-[#E8EAEE] px-[22px] py-3.5">
        <button type="button" onClick={onCancel} className="flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap text-[12.5px] font-semibold text-[#B71920] hover:text-[#941216]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M15 6l-6 6 6 6" /></svg>
          Back to the {totalCases} test cases
        </button>
        <span className="h-5 w-px bg-[#E8EAEE]" />
        <span className="whitespace-nowrap text-[14px] font-bold text-[#1F2937]">{item.display_id}</span>
        <span className="min-w-0 truncate text-[14px] text-[#1F2937]">{item.title}</span>
        {item.classification && (
          <span className={`inline-flex h-6 items-center rounded-full px-[9px] text-[11.5px] font-semibold ${item.classification === 'automation' ? 'bg-[#EAF7EF] text-[#136B34]' : 'bg-[#F4F5F7] text-[#374151]'}`}>
            {item.classification === 'automation' ? 'Automation' : 'Manual'}
          </span>
        )}
        {score != null && <span className="inline-flex h-6 items-center rounded-full bg-[#F4F5F7] px-[9px] text-[11.5px] font-semibold text-[#1F2937]">{score.toFixed(1)} / 5</span>}
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={onCancel} className="flex h-10 items-center rounded-[12px] border border-[#E8EAEE] bg-white px-4 text-[13px] font-bold text-[#1F2937]">Cancel</button>
          <button
            type="button"
            disabled={!valid || saving}
            onClick={() => onSave(steps.filter((step) => step.action.trim()).map(({ key: _key, ...step }) => step))}
            className="flex h-10 items-center gap-2 rounded-[12px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-4 text-[13px] font-bold text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8" aria-hidden><path d="M20 12a8 8 0 11-2.3-5.6M20 4v5h-5" /></svg>
            {saving ? 'Saving…' : 'Save & re-check'}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2 px-[22px] py-3.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#6B7280]">Steps · {steps.length}</span>
          <span className="text-[12px] text-[#6B7280]">Drag to reorder · edit any step · delete what does not belong</span>
        </div>

        {error && <div className="rounded-[12px] border border-[#F6D4D5] bg-[#FFF8F8] px-3.5 py-2.5 text-[12.5px] text-[#7A0B0D]" role="alert">{error}</div>}

        {steps.map((step, index) => {
          const open = editing === step.key
          const hasTodo = TODO.test(step.action) || TODO.test(step.expected_result ?? '')
          return (
            <div
              key={step.key}
              draggable={!open}
              onDragStart={() => setDragging(step.key)}
              onDragOver={(e) => { e.preventDefault(); if (dragging) moveTo(dragging, step.key) }}
              onDragEnd={() => setDragging(null)}
              className={`grid items-center gap-3 rounded-[12px] border px-3.5 py-2.5 ${
                open
                  ? 'grid-cols-[20px_24px_minmax(0,1fr)] items-start border-[#B71920] bg-white shadow-[0_0_0_3px_#FDEBEC]'
                  : hasTodo
                    ? 'grid-cols-[20px_24px_minmax(0,1fr)_96px] border-[#EBCFA4] bg-[#FFFBF4]'
                    : 'grid-cols-[20px_24px_minmax(0,1fr)_96px] border-[#E8EAEE] bg-white'
              } ${dragging === step.key ? 'opacity-60' : ''}`}
            >
              <span className={`cursor-grab ${open ? 'mt-1.5' : ''}`} aria-hidden><Grip /></span>
              <span className={`text-[12.5px] font-bold ${open ? 'mt-1.5 text-[#B71920]' : hasTodo ? 'text-[#8A5000]' : 'text-[#6B7280]'}`}>{index + 1}</span>
              {open ? (
                <div className="flex min-w-0 flex-col gap-2">
                  <textarea
                    value={step.action}
                    autoFocus
                    rows={2}
                    aria-label={`Step ${index + 1} action`}
                    onChange={(e) => update(step.key, { action: e.target.value })}
                    placeholder="What the tester does in this step"
                    className="w-full resize-y rounded-[10px] border border-[#E8EAEE] px-2.5 py-2 text-[13px] text-[#1F2937] outline-none focus:border-[#B71920]"
                  />
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[150px_minmax(0,1fr)]">
                    <span className="relative">
                      <select
                        value={step.action_type ?? ''}
                        aria-label={`Step ${index + 1} action type`}
                        onChange={(e) => update(step.key, { action_type: e.target.value || null })}
                        className="h-9 w-full appearance-none rounded-[10px] border border-[#E8EAEE] bg-white pl-2.5 pr-7 text-[12.5px] font-semibold text-[#1F2937] outline-none focus:border-[#B71920]"
                      >
                        <option value="">Action type</option>
                        {ACTION_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                      </select>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
                    </span>
                    <input
                      value={step.expected_result ?? ''}
                      aria-label={`Step ${index + 1} expected result`}
                      onChange={(e) => update(step.key, { expected_result: e.target.value })}
                      placeholder="Expected: what should happen"
                      className="h-9 rounded-[10px] border border-[#E8EAEE] px-2.5 text-[12.5px] text-[#1F2937] outline-none focus:border-[#B71920]"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => setEditing(null)} className="flex h-[30px] items-center rounded-[12px] bg-[#1F2937] px-3.5 text-[12px] font-bold text-white">Done</button>
                    <span className="text-[11.5px] text-[#6B7280]">Action type feeds script generation, so it is editable here</span>
                    <IconButton label={`Delete step ${index + 1}`} onClick={() => remove(step.key)} className="ml-auto"><TrashIcon /></IconButton>
                  </div>
                </div>
              ) : (
                <>
                  <div className="min-w-0">
                    <div className="text-[13px] text-[#1F2937]">{step.action ? withTodos(step.action) : <span className="text-[#9CA3AF]">Empty step</span>}</div>
                    <div className={`mt-0.5 text-[11.5px] ${hasTodo ? 'text-[#8A5000]' : 'text-[#6B7280]'}`}>
                      {hasTodo
                        ? 'Fill this in here and the test data warning clears'
                        : step.expected_result ? `Expected: ${step.expected_result}` : 'No expected result'}
                      {step.action_type && !hasTodo && <span className="ml-2 rounded bg-[#F4F5F7] px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#6B7280]">{step.action_type}</span>}
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <IconButton label={`Edit step ${index + 1}`} onClick={() => setEditing(step.key)}><PenIcon /></IconButton>
                    <IconButton label={`Delete step ${index + 1}`} onClick={() => remove(step.key)}><TrashIcon /></IconButton>
                  </div>
                </>
              )}
            </div>
          )
        })}

        <button
          type="button"
          onClick={add}
          className="flex items-center gap-2 rounded-[12px] border-[1.5px] border-dashed border-[#F1A4A6] bg-[#FFF8F8] px-3.5 py-2.5 text-[13px] font-bold text-[#941216] transition hover:bg-[#FFF5F5]"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#941216" strokeWidth="2" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
          Add step
        </button>

        <div className="mt-1 flex items-center gap-2 border-t border-[#E8EAEE] pt-2.5 text-[12px] text-[#6B7280]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="1.8" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
          Saving re-runs the Quality Check and AI Classify for this case, so its score and Automation / Manual verdict stay current.
        </div>
      </div>
    </section>
  )
}

export default StepEditor
