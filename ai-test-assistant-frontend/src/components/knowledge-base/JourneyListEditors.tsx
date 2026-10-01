import React, { useMemo, useState } from 'react'
import type { JourneyBranch, JourneyScenario, TaxonomyNode } from '../../services/knowledgeBaseService'
import { EditorBar, FIELD, ICON, PLAIN_BTN } from './kbEdit'

// Editors for the parts of a journey other than its steps. Each one edits a
// copy and hands the whole list back on Save; the backend validates it (steps
// and branches that exist, rules that exist) and drafts a change set.

let counter = 0
const key = () => `k${++counter}`

const RowButtons: React.FC<{ index: number; count: number; label: string; onMove: (by: number) => void; onDelete: () => void }> = ({ index, count, label, onMove, onDelete }) => (
  <span className="flex gap-1">
    <button type="button" className={ICON} title="Move up" aria-label={`Move ${label} up`} disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
    <button type="button" className={ICON} title="Move down" aria-label={`Move ${label} down`} disabled={index === count - 1} onClick={() => onMove(1)}>↓</button>
    <button type="button" className={`${ICON} hover:text-[#A3231C]`} title="Delete" aria-label={`Delete ${label}`} onClick={onDelete}>✕</button>
  </span>
)

function moved<T>(list: T[], index: number, by: number): T[] {
  const next = [...list]
  const [item] = next.splice(index, 1)
  next.splice(index + by, 0, item)
  return next
}

// --- Branches ------------------------------------------------------------------------------

type BranchRow = JourneyBranch & { key: string }

export const BranchesEditor: React.FC<{
  branches: JourneyBranch[]
  stepCount: number
  ruleIds: string[]
  busy: boolean
  publish: boolean
  onSave: (items: Partial<JourneyBranch>[]) => void
  onCancel: () => void
}> = ({ branches, stepCount, ruleIds, busy, publish, onSave, onCancel }) => {
  const [rows, setRows] = useState<BranchRow[]>(() => branches.map(b => ({ ...b, rule: b.rule ?? '', key: key() })))
  const set = (k: string, patch: Partial<BranchRow>) => setRows(prev => prev.map(r => (r.key === k ? { ...r, ...patch } : r)))
  const bad = rows.findIndex(r => !r.condition.trim() || !r.outcome.trim() || !(r.at_step >= 1 && r.at_step <= stepCount))
  return (
    <div className="flex flex-col">
      <EditorBar
        title={<>Editing {rows.length} branch{rows.length === 1 ? '' : 'es'} <span className="text-[#6B7280]">· a new branch gets the next id</span></>}
        busy={busy} publish={publish}
        invalid={bad >= 0 ? `Branch ${bad + 1} needs a step, condition and outcome` : null}
        onCancel={onCancel}
        onSave={() => onSave(rows.map(({ key: _k, ...b }) => ({ ...b, rule: b.rule || undefined })))}
      />
      {rows.map((r, i) => (
        <div key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b border-[#F1F2F4] px-5 py-2.5 text-[12.5px]">
          <span className="grid gap-1.5 md:grid-cols-[120px_110px_minmax(0,1fr)]">
            <span className="flex flex-col gap-0.5">
              <span className="text-[11px] text-[#6B7280]">Id</span>
              <code className="pt-1 text-[12px]">{r.branch_id || 'new'}</code>
            </span>
            <label className="flex flex-col gap-0.5">
              <span className="text-[11px] text-[#6B7280]">At step</span>
              <select value={r.at_step || ''} onChange={e => set(r.key, { at_step: Number(e.target.value) })} className={FIELD}>
                <option value="">—</option>
                {Array.from({ length: stepCount }, (_, n) => <option key={n + 1} value={n + 1}>Step {n + 1}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[11px] text-[#6B7280]">Rule</span>
              <select value={r.rule ?? ''} onChange={e => set(r.key, { rule: e.target.value })} className={FIELD}>
                <option value="">None</option>
                {ruleIds.map(id => <option key={id} value={id}>{id}</option>)}
              </select>
            </label>
            <input aria-label={`Branch ${i + 1} condition`} value={r.condition} placeholder="If… (condition)"
              onChange={e => set(r.key, { condition: e.target.value })} className={`${FIELD} md:col-span-3`} />
            <input aria-label={`Branch ${i + 1} outcome`} value={r.outcome} placeholder="Then… (outcome, e.g. 'error dialog -> back to step 6')"
              onChange={e => set(r.key, { outcome: e.target.value })} className={`${FIELD} md:col-span-3`} />
          </span>
          <RowButtons index={i} count={rows.length} label={`branch ${i + 1}`}
            onMove={by => setRows(prev => moved(prev, i, by))} onDelete={() => setRows(prev => prev.filter(x => x.key !== r.key))} />
        </div>
      ))}
      <div className="px-5 py-3">
        <button type="button" className="text-[12.5px] font-semibold text-[#B71920] hover:underline"
          onClick={() => setRows(prev => [...prev, { key: key(), branch_id: '', at_step: 1, condition: '', outcome: '', rule: '' }])}>+ Add branch</button>
      </div>
    </div>
  )
}

// --- Scenarios -----------------------------------------------------------------------------

const SCENARIO_TYPES = ['positive', 'negative', 'alternate', 'edge', 'boundary', 'data', 'empty_state', 'security', 'ui']
type ScenarioRow = JourneyScenario & { key: string; stepsText: string }

const parseSteps = (text: string): number[] | null => {
  const parts = text.split(/[\s,]+/).filter(Boolean)
  const out: number[] = []
  for (const part of parts) {
    const range = part.match(/^(\d+)-(\d+)$/)
    if (range) {
      for (let n = Number(range[1]); n <= Number(range[2]); n++) out.push(n)
    } else if (/^\d+$/.test(part)) {
      out.push(Number(part))
    } else {
      return null
    }
  }
  return out
}

export const ScenariosEditor: React.FC<{
  scenarios: JourneyScenario[]
  stepCount: number
  branchIds: string[]
  busy: boolean
  publish: boolean
  onSave: (items: Partial<JourneyScenario>[]) => void
  onCancel: () => void
}> = ({ scenarios, stepCount, branchIds, busy, publish, onSave, onCancel }) => {
  const [rows, setRows] = useState<ScenarioRow[]>(() =>
    scenarios.map(s => ({ ...s, key: key(), stepsText: (s.steps ?? []).join(', '), branch: s.branch ?? '', test_data: s.test_data ?? '' })))
  const set = (k: string, patch: Partial<ScenarioRow>) => setRows(prev => prev.map(r => (r.key === k ? { ...r, ...patch } : r)))
  const problem = useMemo(() => {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      if (!r.title.trim()) return `Scenario ${i + 1} needs a title`
      const steps = parseSteps(r.stepsText)
      if (!steps || steps.some(n => n < 1 || n > stepCount)) return `Scenario ${i + 1}: steps are numbers from 1 to ${stepCount}`
    }
    return null
  }, [rows, stepCount])
  return (
    <div className="flex flex-col">
      <EditorBar
        title={<>Editing {rows.length} scenario{rows.length === 1 ? '' : 's'} <span className="text-[#6B7280]">· steps as “1, 2, 4-6”</span></>}
        busy={busy} publish={publish} invalid={problem} onCancel={onCancel}
        onSave={() => onSave(rows.map(({ key: _k, stepsText, ...s }) => ({
          ...s, steps: parseSteps(stepsText) ?? [], branch: s.branch || undefined, test_data: s.test_data || undefined
        })))}
      />
      {rows.map((r, i) => (
        <div key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b border-[#F1F2F4] px-5 py-2.5 text-[12.5px]">
          <span className="grid gap-1.5 md:grid-cols-[110px_130px_minmax(0,1fr)]">
            <code className="pt-2 text-[12px]">{r.scenario_id || 'new'}</code>
            <select aria-label={`Scenario ${i + 1} type`} value={r.type} onChange={e => set(r.key, { type: e.target.value })} className={FIELD}>
              {SCENARIO_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <input aria-label={`Scenario ${i + 1} title`} value={r.title} placeholder="What this scenario proves"
              onChange={e => set(r.key, { title: e.target.value })} className={FIELD} />
            <input aria-label={`Scenario ${i + 1} steps`} value={r.stepsText} placeholder="Steps, e.g. 1-5, 7"
              onChange={e => set(r.key, { stepsText: e.target.value })} className={`${FIELD} md:col-span-1`} />
            <select aria-label={`Scenario ${i + 1} branch`} value={r.branch ?? ''} onChange={e => set(r.key, { branch: e.target.value })} className={FIELD}>
              <option value="">No branch</option>
              {branchIds.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
            <input aria-label={`Scenario ${i + 1} test data`} value={r.test_data ?? ''} placeholder="Test data key (optional)"
              onChange={e => set(r.key, { test_data: e.target.value })} className={`${FIELD} font-mono text-[11.5px]`} />
          </span>
          <RowButtons index={i} count={rows.length} label={`scenario ${i + 1}`}
            onMove={by => setRows(prev => moved(prev, i, by))} onDelete={() => setRows(prev => prev.filter(x => x.key !== r.key))} />
        </div>
      ))}
      <div className="px-5 py-3">
        <button type="button" className="text-[12.5px] font-semibold text-[#B71920] hover:underline"
          onClick={() => setRows(prev => [...prev, { key: key(), scenario_id: '', type: 'positive', title: '', stepsText: '', steps: [], branch: '', test_data: '' }])}>+ Add scenario</button>
      </div>
    </div>
  )
}

// --- Prerequisite and next journeys --------------------------------------------------------

const JourneyPicker: React.FC<{ label: string; hint: string; value: string[]; options: TaxonomyNode[]; exclude: string; onChange: (ids: string[]) => void }> = ({ label, hint, value, options, exclude, onChange }) => {
  const byId = new Map(options.map(o => [o.id, o]))
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const matches = needle
    ? options.filter(o => o.id !== exclude && !value.includes(o.id) && (o.title.toLowerCase().includes(needle) || o.id.toLowerCase().includes(needle))).slice(0, 8)
    : []
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-bold text-[#374151]">{label} <span className="font-normal text-[#6B7280]">· {hint}</span></span>
      <span className="flex flex-wrap gap-1.5">
        {value.length === 0 && <span className="text-[12px] text-[#9CA3AF]">None</span>}
        {value.map((id, i) => (
          <span key={id} className="inline-flex items-center gap-1 rounded-full bg-[#F4F5F7] py-0.5 pl-2.5 pr-1 text-[12px]">
            {value.length > 1 && <span className="text-[#9CA3AF]">{i + 1}.</span>}
            {byId.get(id)?.title ?? id}
            <button type="button" aria-label={`Remove ${byId.get(id)?.title ?? id}`} onClick={() => onChange(value.filter(v => v !== id))}
              className="flex h-5 w-5 items-center justify-center rounded-full text-[#6B7280] hover:bg-white hover:text-[#A3231C]">✕</button>
          </span>
        ))}
      </span>
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search journeys to add" className={FIELD} aria-label={`Add to ${label}`} />
      {matches.length > 0 && (
        <span className="flex flex-col rounded-[8px] border border-[#E8EAEE] bg-white">
          {matches.map(o => (
            <button key={o.id} type="button" onClick={() => { onChange([...value, o.id]); setQuery('') }}
              className="flex justify-between gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-[#FFF5F5]">
              <span>{o.title}</span><code className="text-[10.5px] text-[#9CA3AF]">{o.id}</code>
            </button>
          ))}
        </span>
      )}
    </div>
  )
}

export const LinksEditor: React.FC<{
  journeyId: string
  prerequisites: string[]
  next: string[]
  options: TaxonomyNode[]
  busy: boolean
  publish: boolean
  onSave: (links: { prerequisite_journeys: string[]; next_journeys: string[] }) => void
  onCancel: () => void
}> = ({ journeyId, prerequisites, next, options, busy, publish, onSave, onCancel }) => {
  const [pre, setPre] = useState(prerequisites)
  const [nxt, setNxt] = useState(next)
  const choices = options.filter(o => o.kind !== 'chapter')
  return (
    <div className="flex flex-col rounded-[12px] border border-[#F6D4D5]">
      <EditorBar title="Editing the journeys around this one" busy={busy} publish={publish} onCancel={onCancel}
        onSave={() => onSave({ prerequisite_journeys: pre, next_journeys: nxt })} />
      <div className="grid gap-4 p-4 md:grid-cols-2">
        <JourneyPicker label="Runs after" hint="prerequisites, in order — a group (e.g. Sign-In) means any one of its variants"
          value={pre} options={choices} exclude={journeyId} onChange={setPre} />
        <JourneyPicker label="Then" hint="journeys that may follow this one" value={nxt} options={choices} exclude={journeyId} onChange={setNxt} />
      </div>
    </div>
  )
}

// --- Business rules ------------------------------------------------------------------------

export const RuleRow: React.FC<{
  rule: { rule_id: string; type: string; statement: string; message?: string; basis: string }
  canEdit: boolean
  busy: boolean
  publish: boolean
  onSave: (statement: string, message: string) => Promise<boolean>
  onDelete: () => void
  basisChip: React.ReactNode
}> = ({ rule, canEdit, busy, publish, onSave, onDelete, basisChip }) => {
  const [editing, setEditing] = useState(false)
  const [statement, setStatement] = useState(rule.statement)
  const [message, setMessage] = useState(rule.message ?? '')
  if (editing) {
    return (
      <div className="flex flex-col gap-1.5 rounded-[10px] border border-[#F6D4D5] bg-[#FFFCF7] p-3">
        <strong className="text-[12.5px]">{rule.rule_id}</strong>
        <textarea aria-label={`${rule.rule_id} statement`} value={statement} onChange={e => setStatement(e.target.value)} rows={3} className={FIELD} />
        <input aria-label={`${rule.rule_id} message`} value={message} onChange={e => setMessage(e.target.value)} placeholder="Message shown to the user (optional)" className={FIELD} />
        <span className="flex justify-end gap-2">
          <button type="button" className={PLAIN_BTN} disabled={busy} onClick={() => { setEditing(false); setStatement(rule.statement); setMessage(rule.message ?? '') }}>Cancel</button>
          <button type="button" disabled={busy || !statement.trim()}
            className="h-[30px] rounded-[10px] bg-[#B71920] px-3 text-[12.5px] font-bold text-white hover:opacity-95 disabled:opacity-50"
            onClick={async () => { if (await onSave(statement, message)) setEditing(false) }}>
            {publish ? 'Save & publish' : 'Save for review'}
          </button>
        </span>
      </div>
    )
  }
  return (
    <div className="group flex gap-3">
      {basisChip}
      <span className="min-w-0 flex-1"><strong>{rule.rule_id}</strong> · {rule.statement}{rule.message && <> Message: <em>‘{rule.message}’</em></>}</span>
      {canEdit && (
        <span className="flex flex-shrink-0 gap-1 opacity-60 group-hover:opacity-100">
          <button type="button" className={ICON} title="Edit rule" aria-label={`Edit ${rule.rule_id}`} onClick={() => setEditing(true)}>✎</button>
          <button type="button" className={`${ICON} hover:text-[#A3231C]`} title="Delete rule" aria-label={`Delete ${rule.rule_id}`} onClick={onDelete}>✕</button>
        </span>
      )}
    </div>
  )
}
