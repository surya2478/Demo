// Katalon Import -- under AI Test Automation.
//
// The QA team's Katalon project is the ground truth for applications we cannot
// crawl (USP/CIM inside the enterprise network). Upload what they export and get,
// from ONE set of steps: findings, a draft Automation KB, a manual test case per
// data row, and Playwright/Katalon scripts that match the test case step for step.
// The only write into another module is a DRAFT Automation KB change set.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { useConfirm } from '../../components/ui/ConfirmDialog'
import katalonImportService, {
  type CaseBrief,
  type CaseDetail,
  type CaseStatus,
  type Component,
  type Conformance,
  type Finding,
  type ImportBrief,
  type ImportDetail,
  type ImportFile,
  type Model,
  type Severity,
} from '../../services/katalonImportService'

const CARD = 'rounded-[20px] border border-[#E8EAEE] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]'
const FIELD = 'h-9 w-full rounded-[10px] border border-[#E8EAEE] bg-white px-3 text-[13px] text-[#1F2937] outline-none transition focus:border-[#F1A4A6] focus:ring-2 focus:ring-[#FDEBEC] disabled:bg-[#F9FAFB]'
const BTN = 'flex h-9 items-center gap-1.5 whitespace-nowrap rounded-[12px] border border-[#E8EAEE] bg-white px-3.5 text-[13px] font-bold text-[#1F2937] transition hover:border-[#F6D4D5] disabled:cursor-not-allowed disabled:opacity-50'
const PRIMARY = 'flex h-9 items-center gap-1.5 whitespace-nowrap rounded-[12px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-4 text-[13px] font-bold text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50'
const EYEBROW = 'text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]'
const MONO = 'font-mono text-[11.5px] leading-[1.5]'

const hasPermission = (user: any, permission: string): boolean => {
  if (!user) return false
  const roles: string[] = (user.roles as string[]) || (user.role ? [user.role] : [])
  if (roles.some((r) => String(r).toLowerCase() === 'admin')) return true
  return ((user.permissions as string[]) || []).includes(permission)
}

const errorText = (err: any, fallback: string) => err?.response?.data?.detail || err?.message || fallback

const fmtSize = (bytes?: number | null) =>
  !bytes ? '' : bytes > 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

const fmtDate = (iso?: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

const SEVERITY: Record<Severity, { label: string; cls: string; dot: string }> = {
  high: { label: 'High', cls: 'bg-[#FDEBEC] text-[#B71920]', dot: '#DC2626' },
  medium: { label: 'Medium', cls: 'bg-[#FFF4E5] text-[#8A5000]', dot: '#D97706' },
  info: { label: 'Info', cls: 'bg-[#EEF4FF] text-[#1D4ED8]', dot: '#2563EB' },
}

const CASE_STATUS: Record<CaseStatus, { label: string; cls: string; hint: string }> = {
  ready: { label: 'Ready', cls: 'bg-[#E8F6EE] text-[#136B34]', hint: 'Every step this row takes is in the export.' },
  incomplete: { label: 'Incomplete', cls: 'bg-[#FFF4E5] text-[#8A5000]', hint: 'The row takes a branch the export does not contain, or a value is missing.' },
  excluded: { label: 'Excluded', cls: 'bg-[#F4F5F7] text-[#6B7280]', hint: 'The data sheet marks the row (not yet implemented, duplicate).' },
}

const KIND_LABEL: Record<string, { label: string; cls: string }> = {
  converter_md: { label: 'Test case', cls: 'bg-[#FDEBEC] text-[#B71920]' },
  object_repository: { label: 'Object', cls: 'bg-[#F3E8FF] text-[#6B21A8]' },
  test_data: { label: 'Test data', cls: 'bg-[#E8F6EE] text-[#136B34]' },
  keywords: { label: 'Keywords', cls: 'bg-[#EEF4FF] text-[#1D4ED8]' },
  profile: { label: 'Profile', cls: 'bg-[#FFF4E5] text-[#8A5000]' },
  scripts: { label: 'Script', cls: 'bg-[#F4F5F7] text-[#4B5563]' },
}

const STEP_TYPE: Record<string, string> = {
  db_prep: 'bg-[#FFF4E5] text-[#8A5000]',
  db_check: 'bg-[#E8F6EE] text-[#136B34]',
  frame: 'bg-[#F3E8FF] text-[#6B21A8]',
  capture: 'bg-[#EEF4FF] text-[#1D4ED8]',
  fail: 'bg-[#FDEBEC] text-[#B71920]',
  manual: 'bg-[#FDEBEC] text-[#B71920]',
}

const Chip: React.FC<{ cls: string; children: React.ReactNode; title?: string }> = ({ cls, children, title }) => (
  <span title={title} className={`inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-[11.5px] font-semibold ${cls}`}>{children}</span>
)

const Tile: React.FC<{ label: string; value: React.ReactNode; hint?: React.ReactNode }> = ({ label, value, hint }) => (
  <div className="rounded-[14px] border border-[#EEF0F3] bg-[#FCFCFD] px-4 py-3">
    <div className={EYEBROW}>{label}</div>
    <div className="mt-1 text-[22px] font-extrabold leading-tight text-[#1F2937]">{value}</div>
    {hint && <div className="mt-0.5 text-[11.5px] text-[#6B7280]">{hint}</div>}
  </div>
)

const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="rounded-[14px] border border-dashed border-[#E8EAEE] px-4 py-8 text-center text-[13px] text-[#6B7280]">{children}</div>
)

// --- Inputs -------------------------------------------------------------------------

const DropZone: React.FC<{ disabled: boolean; busy: number | null; onFiles: (files: File[]) => void }> = ({ disabled, busy, onFiles }) => {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        if (!disabled && e.dataTransfer.files.length) onFiles(Array.from(e.dataTransfer.files))
      }}
      className={`flex flex-col items-center justify-center gap-2 rounded-[16px] border-2 border-dashed px-6 py-8 text-center transition ${
        over ? 'border-[#F1A4A6] bg-[#FFF5F5]' : 'border-[#E8EAEE] bg-[#FCFCFD]'
      }`}
    >
      <div className="text-[14px] font-bold text-[#1F2937]">{busy !== null ? `Uploading and analysing… ${busy < 100 ? `${busy}%` : ''}` : 'Drop the Katalon exports here'}</div>
      <div className="max-w-[560px] text-[12.5px] leading-[1.55] text-[#6B7280]">
        Zips are fine (nested too). Converted test cases <b>.md</b>, Object Repository <b>.rs</b>, test data <b>.dat / .csv / .xlsx</b>,
        keywords <b>.groovy</b> and the profile <b>.glbl</b>. Passwords in a profile are dropped as it is read and never stored.
      </div>
      <input ref={input} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files?.length) onFiles(Array.from(e.target.files)); e.target.value = '' }} />
      <button type="button" className={PRIMARY} disabled={disabled || busy !== null} onClick={() => input.current?.click()}>Choose files</button>
    </div>
  )
}

const InputsTab: React.FC<{ detail: ImportDetail; canEdit: boolean; busy: number | null; onFiles: (files: File[]) => void; onRemove: (f: ImportFile) => void; onAnalyse: () => void }> = ({ detail, canEdit, busy, onFiles, onRemove, onAnalyse }) => {
  const checklist = detail.result?.analysis.checklist
  const files = detail.meta.files
  const exports = detail.result?.exports || []
  const role = (path: string) => exports.find((e) => e.file === path)
  return (
    <div className="flex flex-col gap-4">
      <DropZone disabled={!canEdit} busy={busy} onFiles={onFiles} />
      {checklist && (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {checklist.map((c) => (
            <div key={c.key} className={`flex gap-3 rounded-[14px] border px-4 py-3 ${c.present ? 'border-[#BBDFC8] bg-[#F6FBF8]' : 'border-[#EEF0F3] bg-white'}`}>
              <span className={`mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full text-[11px] font-black ${c.present ? 'bg-[#16A34A] text-white' : 'bg-[#F1F2F4] text-[#9CA3AF]'}`}>
                {c.present ? '✓' : '·'}
              </span>
              <div className="min-w-0">
                <div className="text-[13px] font-bold text-[#1F2937]">{c.label} {c.present && c.count > 0 && <span className="font-semibold text-[#6B7280]">· {c.count}</span>}</div>
                <div className="text-[12px] leading-[1.45] text-[#6B7280]">{c.why}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="overflow-hidden rounded-[14px] border border-[#EEF0F3]">
        <div className="flex items-center justify-between border-b border-[#EEF0F3] bg-[#FCFCFD] px-4 py-2">
          <span className="text-[12.5px] font-semibold text-[#374151]">{files.length} file{files.length === 1 ? '' : 's'}</span>
          <div className="flex items-center gap-3">
            <span className="hidden text-[11.5px] text-[#6B7280] md:inline">Upload again to add files; a file with the same path replaces the earlier one.</span>
            {canEdit && files.length > 0 && (
              <button type="button" className={BTN} disabled={busy !== null} onClick={onAnalyse}>Re-analyse</button>
            )}
          </div>
        </div>
        {!files.length && <div className="px-4 py-6 text-[13px] text-[#6B7280]">No files yet.</div>}
        <div className="max-h-[420px] overflow-y-auto">
          {files.map((f) => {
            const kind = f.kind ? KIND_LABEL[f.kind] : null
            return (
              <div key={f.path} className="flex items-start gap-3 border-b border-[#F4F5F7] px-4 py-2 last:border-0">
                <div className="w-[92px] flex-none pt-0.5">{kind ? <Chip cls={kind.cls}>{kind.label}</Chip> : <Chip cls="bg-[#F4F5F7] text-[#9CA3AF]">Ignored</Chip>}</div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-semibold text-[#1F2937]" title={f.path}>{f.path}</div>
                  {f.note && <div className="text-[11.5px] text-[#6B7280]">{f.note}</div>}
                  {f.kind === 'converter_md' && role(f.path) && (
                    <div className="text-[11.5px] text-[#6B7280]">
                      {role(f.path)!.role === 'primary' && `Primary export of this test case (row ${role(f.path)!.data_key || '?'}).`}
                      {role(f.path)!.role === 'branch_source' && `Fills ${role(f.path)!.branches.length} branch(es) the primary export skipped: ${role(f.path)!.branches.map((b) => b.expr).join('; ')}.`}
                      {role(f.path)!.role === 'superseded' && 'Same branches as the primary export; adds nothing new.'}
                    </div>
                  )}
                </div>
                <span className="flex-none pt-0.5 text-[11.5px] tabular-nums text-[#9CA3AF]">{fmtSize(f.size)}</span>
                {canEdit && (
                  <button type="button" onClick={() => onRemove(f)} className="flex-none text-[12px] font-semibold text-[#9CA3AF] hover:text-[#B71920]" title="Remove this file">Remove</button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// --- Findings -----------------------------------------------------------------------

const FindingsTab: React.FC<{ detail: ImportDetail }> = ({ detail }) => {
  const analysis = detail.result!.analysis
  const [filter, setFilter] = useState<Severity | 'all'>('all')
  const shown = analysis.findings.filter((f) => filter === 'all' || f.severity === filter)
  const env = analysis.environment
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {(['all', 'high', 'medium', 'info'] as const).map((s) => {
            const n = s === 'all' ? analysis.findings.length : analysis.summary.findings[s] ?? 0
            return (
              <button key={s} type="button" onClick={() => setFilter(s)}
                className={`h-8 rounded-full border px-3 text-[12.5px] font-semibold transition ${filter === s ? 'border-[#B71920] bg-[#FFF5F5] text-[#B71920]' : 'border-[#E8EAEE] bg-white text-[#4B5563]'}`}>
                {s === 'all' ? 'All' : SEVERITY[s].label} · {n}
              </button>
            )
          })}
        </div>
        {!shown.length && <Empty>No findings at this level.</Empty>}
        {shown.map((f: Finding) => (
          <div key={f.id} className="rounded-[14px] border border-[#EEF0F3] bg-white px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Chip cls={SEVERITY[f.severity].cls}>{SEVERITY[f.severity].label}</Chip>
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#9CA3AF]">{f.category}</span>
            </div>
            <div className="mt-1.5 text-[14px] font-bold text-[#1F2937]">{f.title}</div>
            <div className="mt-1 text-[12.5px] leading-[1.55] text-[#4B5563]">{f.detail}</div>
            <div className="mt-2 rounded-[10px] bg-[#FCFCFD] px-3 py-2 text-[12.5px] text-[#1F2937]"><b>Next:</b> {f.action}</div>
          </div>
        ))}
      </div>
      <aside className="flex flex-col gap-3">
        <div className="rounded-[14px] border border-[#EEF0F3] bg-white px-4 py-3">
          <div className={EYEBROW}>Application</div>
          <div className="mt-1 break-all text-[13px] font-semibold text-[#1F2937]">{env.app_url || 'Unknown (no profile)'}</div>
          <div className="mt-1 text-[12px] text-[#6B7280]">Environment {env.env || '—'} · Grid {env.grid || '—'}</div>
        </div>
        <div className="rounded-[14px] border border-[#EEF0F3] bg-white px-4 py-3">
          <div className={EYEBROW}>Systems in the profile</div>
          {!env.systems.length && <div className="mt-1 text-[12.5px] text-[#6B7280]">None.</div>}
          <div className="mt-1 flex flex-col gap-1.5">
            {env.systems.map((s) => (
              <div key={s.variable} className="text-[12px]">
                <div className="font-semibold text-[#1F2937]">{s.service || s.variable}</div>
                <div className={`${MONO} text-[#6B7280]`}>{s.variable} · {s.host || '?'}{s.port ? `:${s.port}` : ''}</div>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[11.5px] text-[#9CA3AF]">Host names only. User names and passwords are never read into this page.</div>
        </div>
        {analysis.data.map((t) => (
          <div key={t.name} className="rounded-[14px] border border-[#EEF0F3] bg-white px-4 py-3">
            <div className={EYEBROW}>Test data · {t.name}</div>
            <div className="mt-1 text-[13px] font-semibold text-[#1F2937]">{t.rows} rows · {t.columns.length} columns</div>
            {Object.entries(t.distribution).slice(0, 5).map(([col, values]) => (
              <div key={col} className="mt-2">
                <div className="text-[11.5px] font-semibold text-[#4B5563]">{col}</div>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {Object.entries(values).slice(0, 6).map(([v, n]) => (
                    <span key={v} className="rounded bg-[#F4F5F7] px-1.5 py-0.5 text-[11px] text-[#4B5563]">{v || '(empty)'} · {n}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
      </aside>
    </div>
  )
}

// --- Knowledge Base -----------------------------------------------------------------

const condLabel = (model: Model, id: string) => {
  const c = model.conditions[id]
  if (!c) return id
  if (c.kind === 'try') return 'Optional'
  if (c.kind === 'ui') return c.text.replace(/^If /, 'If ')
  return c.text
}

const ComponentSteps: React.FC<{ model: Model; comp: Component }> = ({ model, comp }) => (
  <div className="overflow-x-auto">
    <table className="w-full min-w-[760px] border-collapse text-left">
      <thead>
        <tr className="border-b border-[#EEF0F3] text-[11px] uppercase tracking-[0.08em] text-[#6B7280]">
          <th className="px-3 py-2 font-semibold">#</th>
          <th className="px-3 py-2 font-semibold">Action</th>
          <th className="px-3 py-2 font-semibold">Type</th>
          <th className="px-3 py-2 font-semibold">Locator</th>
          <th className="px-3 py-2 font-semibold">Katalon</th>
        </tr>
      </thead>
      <tbody>
        {comp.steps.map((s, i) => (
          <tr key={s.id} className="border-b border-[#F4F5F7] align-top last:border-0">
            <td className="px-3 py-2 text-[12px] tabular-nums text-[#9CA3AF]">{i + 1}</td>
            <td className="px-3 py-2">
              {s.conds.length > 0 && (
                <div className="mb-1 flex flex-wrap gap-1">
                  {s.conds.map((c) => <span key={c} className="rounded bg-[#F3F4F6] px-1.5 py-0.5 text-[10.5px] text-[#4B5563]">{condLabel(model, c)}</span>)}
                </div>
              )}
              <div className="text-[12.5px] text-[#1F2937]">{s.action}</div>
              {s.expected && <div className="text-[11.5px] text-[#6B7280]">→ {s.expected}</div>}
            </td>
            <td className="px-3 py-2"><Chip cls={STEP_TYPE[s.type] || 'bg-[#F4F5F7] text-[#4B5563]'}>{s.type}</Chip></td>
            <td className={`max-w-[360px] break-all px-3 py-2 ${MONO} text-[#374151]`}>{s.target || (s.keyword ? <span className="text-[#6B7280]">{s.keyword}</span> : '—')}</td>
            <td className="px-3 py-2 text-[11.5px] text-[#6B7280]">{s.source}{s.via ? <div className="text-[10.5px]">{s.via}</div> : null}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)

const KbTab: React.FC<{ detail: ImportDetail }> = ({ detail }) => {
  const result = detail.result!
  const [modelIndex, setModelIndex] = useState(0)
  const model = result.models[modelIndex]
  const [view, setView] = useState<'components' | 'locators' | 'database' | 'files'>('components')
  const [selected, setSelected] = useState<string | null>(model?.components[0]?.id ?? null)
  const [onlyIssues, setOnlyIssues] = useState(false)
  useEffect(() => { setSelected(model?.components[0]?.id ?? null) }, [model])
  if (!model) return <Empty>No converted test case yet. Upload a .md export.</Empty>
  const comp = model.components.find((c) => c.id === selected) || model.components[0]
  const locators = result.analysis.locators.filter((l) => !onlyIssues || l.issues.length)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {result.models.length > 1 && (
          <select className={`${FIELD} w-auto`} value={modelIndex} onChange={(e) => setModelIndex(Number(e.target.value))}>
            {result.models.map((m, i) => <option key={i} value={i}>{m.test_case.title}</option>)}
          </select>
        )}
        {([['components', `Components · ${model.components.length}`], ['locators', `Locators · ${result.analysis.locators.length}`],
          ['database', `Database steps · ${result.analysis.db_steps.length}`], ['files', 'KB files']] as const).map(([key, label]) => (
          <button key={key} type="button" onClick={() => setView(key)}
            className={`h-8 rounded-full border px-3 text-[12.5px] font-semibold ${view === key ? 'border-[#B71920] bg-[#FFF5F5] text-[#B71920]' : 'border-[#E8EAEE] bg-white text-[#4B5563]'}`}>{label}</button>
        ))}
      </div>

      {view === 'components' && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[300px_minmax(0,1fr)]">
          <div className="flex max-h-[640px] flex-col gap-1 overflow-y-auto rounded-[14px] border border-[#EEF0F3] p-2">
            <div className="px-2 py-1 text-[11.5px] text-[#6B7280]">The flow, in order. Each component is one called Katalon test case.</div>
            {model.flow.map((f, i) => {
              const c = model.components.find((x) => x.id === f.component)!
              const active = c.id === comp?.id
              return (
                <button key={c.id} type="button" onClick={() => setSelected(c.id)}
                  className={`flex items-start gap-2 rounded-[10px] px-2.5 py-2 text-left transition ${active ? 'bg-[#FFF5F5]' : 'hover:bg-[#FCFCFD]'}`}>
                  <span className="mt-0.5 w-5 flex-none text-right text-[11px] tabular-nums text-[#9CA3AF]">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[12.5px] font-bold ${active ? 'text-[#B71920]' : 'text-[#1F2937]'}`}>{c.name}</span>
                    <span className="block text-[11px] text-[#6B7280]">
                      {c.steps.length} steps{c.gaps.length ? ` · ${c.gaps.length} missing branch${c.gaps.length > 1 ? 'es' : ''}` : ''}{f.when.length ? ' · conditional' : ''}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
          {comp && (
            <div className="min-w-0 rounded-[14px] border border-[#EEF0F3]">
              <div className="border-b border-[#EEF0F3] px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-bold text-[#1F2937]">{comp.name}</span>
                  <span className={`${MONO} rounded bg-[#F4F5F7] px-1.5 text-[#4B5563]`}>{comp.id}</span>
                  {comp.katalon && <span className="text-[11.5px] text-[#6B7280]">{comp.katalon.type} {comp.katalon.ref}</span>}
                </div>
                {comp.when.length > 0 && <div className="mt-1 text-[12px] text-[#6B7280]">Runs only {comp.when.map((c) => condLabel(model, c)).join(' and ')}</div>}
                {comp.gaps.map((g) => (
                  <div key={g.expr} className="mt-2 rounded-[10px] bg-[#FFF4E5] px-3 py-2 text-[12px] text-[#8A5000]">
                    Branch <b>{g.expr}</b> ({g.steps_skipped} steps) is not in the export. Rows that take it are incomplete until it is exported.
                  </div>
                ))}
              </div>
              {comp.steps.length ? <ComponentSteps model={model} comp={comp} /> : <div className="px-4 py-6 text-[13px] text-[#6B7280]">No steps for the exported data row.</div>}
            </div>
          )}
        </div>
      )}

      {view === 'locators' && (
        <div className="overflow-hidden rounded-[14px] border border-[#EEF0F3]">
          <div className="flex items-center justify-between border-b border-[#EEF0F3] bg-[#FCFCFD] px-4 py-2">
            <label className="flex items-center gap-2 text-[12.5px] font-semibold text-[#374151]">
              <input type="checkbox" className="accent-[#B71920]" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />
              Only locators with issues ({result.analysis.summary.locators_with_issues})
            </label>
            <span className="text-[11.5px] text-[#6B7280]">From the team's Object Repository · unverified until run</span>
          </div>
          <div className="max-h-[620px] overflow-auto">
            <table className="w-full min-w-[820px] border-collapse text-left">
              <tbody>
                {locators.map((l) => (
                  <tr key={l.path} className="border-b border-[#F4F5F7] align-top last:border-0">
                    <td className="w-[240px] px-4 py-2">
                      <div className="text-[12.5px] font-bold text-[#1F2937]">{l.label}</div>
                      <div className="text-[11px] text-[#6B7280]">{l.path}</div>
                      <div className="text-[11px] text-[#9CA3AF]">used {l.uses}×{l.params.length ? ` · param ${l.params.join(', ')}` : ''}</div>
                    </td>
                    <td className={`break-all px-3 py-2 ${MONO} text-[#374151]`}>{l.xpath || <span className="text-[#B71920]">no locator</span>}</td>
                    <td className="w-[320px] px-3 py-2">
                      {l.issues.length === 0 && <Chip cls="bg-[#E8F6EE] text-[#136B34]">No issues</Chip>}
                      <div className="flex flex-col gap-1">
                        {l.issues.map((i) => (
                          <div key={i.code} className="flex items-start gap-1.5 text-[11.5px] text-[#4B5563]">
                            <span className="mt-1 h-1.5 w-1.5 flex-none rounded-full" style={{ background: SEVERITY[i.severity].dot }} />{i.text}
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {view === 'database' && (
        <div className="flex flex-col gap-2">
          <div className="rounded-[12px] bg-[#FCFCFD] px-4 py-2.5 text-[12.5px] text-[#4B5563]">
            <b>Data preparation</b> writes to the test databases and is gated (Playwright: KATALON_DB_MODE=all; Katalon: the team's own keywords).
            <b> Database checks</b> only read and are the below-the-UI checkpoints.
          </div>
          {result.analysis.db_steps.map((d) => (
            <div key={d.id} className="rounded-[14px] border border-[#EEF0F3] bg-white px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Chip cls={STEP_TYPE[d.type]}>{d.type === 'db_prep' ? 'Data preparation' : 'Database check'}</Chip>
                <span className="text-[13.5px] font-bold text-[#1F2937]">{d.name}</span>
                <span className={`${MONO} text-[#6B7280]`}>{d.id}</span>
                {d.count_guard_missing && <Chip cls="bg-[#FDEBEC] text-[#B71920]">Source can false-pass · generated check guards it</Chip>}
              </div>
              <div className="mt-1 text-[12px] text-[#6B7280]">{d.keyword} · {d.systems.map((s) => `${s.service || s.variable} (${s.host || '?'})`).join(', ') || 'system unknown'}</div>
              {d.statements.length > 0 && (
                <pre className={`mt-2 max-h-[180px] overflow-auto whitespace-pre-wrap rounded-[10px] bg-[#0F172A] px-3 py-2 ${MONO} text-[#E2E8F0]`}>{d.statements.join(';\n\n')}</pre>
              )}
            </div>
          ))}
        </div>
      )}

      {view === 'files' && (
        <div className="flex flex-col gap-2">
          <div className="text-[12.5px] text-[#4B5563]">What the Automation KB will hold for this application. Publish creates a draft change set with exactly these files.</div>
          {Object.entries(result.kb).map(([name, doc]) => (
            <details key={name} className="rounded-[14px] border border-[#EEF0F3] bg-white">
              <summary className="cursor-pointer px-4 py-2.5 text-[13px] font-bold text-[#1F2937]">{name}</summary>
              <pre className={`max-h-[460px] overflow-auto border-t border-[#EEF0F3] px-4 py-3 ${MONO} text-[#374151]`}>{JSON.stringify(doc, null, 2)}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  )
}

// --- Test cases & scripts --------------------------------------------------------------

const ConformanceBadge: React.FC<{ c: Conformance }> = ({ c }) => (
  <Chip cls={c.ok ? 'bg-[#E8F6EE] text-[#136B34]' : 'bg-[#FDEBEC] text-[#B71920]'}
    title={c.ok ? 'Same steps, same order, same locators as the test case.' : c.issues.map((i) => `TC ${i.n ?? '?'} ${i.key ?? ''}: ${i.problem}`).join('\n')}>
    {c.ok ? `Matches · ${c.script_steps}/${c.tc_steps} steps` : `${c.issues.length} difference${c.issues.length === 1 ? '' : 's'}`}
  </Chip>
)

const CodeView: React.FC<{ code: string; focus: number | null }> = ({ code, focus }) => {
  const box = useRef<HTMLDivElement>(null)
  const lines = useMemo(() => code.split('\n'), [code])
  const marker = useMemo(() => {
    const out: Record<number, number> = {}
    lines.forEach((l, i) => { const m = l.match(/\/\/\s*\[TC (\d+)\]/); if (m) out[Number(m[1])] = i })
    return out
  }, [lines])
  useEffect(() => {
    if (focus === null || !box.current) return
    const el = box.current.querySelector(`[data-line="${marker[focus]}"]`) as HTMLElement | null
    if (el) box.current.scrollTop = el.offsetTop - 80
  }, [focus, marker])
  const start = focus !== null ? marker[focus] : -1
  const end = focus !== null ? (marker[focus + 1] ?? start + 2) : -1
  return (
    <div ref={box} className="relative max-h-[640px] overflow-auto rounded-[12px] bg-[#0F172A] py-2">
      {lines.map((l, i) => (
        <div key={i} data-line={i} className={`flex ${i >= start && i < end ? 'bg-[#7F1D1D]/60' : ''}`}>
          <span className={`w-12 flex-none select-none pr-3 text-right ${MONO} text-[#475569]`}>{i + 1}</span>
          <span className={`whitespace-pre pr-4 ${MONO} ${l.trim().startsWith('//') ? 'text-[#94A3B8]' : 'text-[#E2E8F0]'}`}>{l || ' '}</span>
        </div>
      ))}
    </div>
  )
}

const CaseViewer: React.FC<{ importId: string; caseId: string; onClose: () => void }> = ({ importId, caseId, onClose }) => {
  const [detail, setDetail] = useState<CaseDetail | null>(null)
  const [error, setError] = useState('')
  const [framework, setFramework] = useState<'playwright' | 'katalon'>('playwright')
  const [focus, setFocus] = useState<number | null>(null)
  const [edited, setEdited] = useState('')
  const [check, setCheck] = useState<Conformance | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    setDetail(null); setError(''); setFocus(null); setCheck(null)
    katalonImportService.caseDetail(importId, caseId).then(setDetail).catch((err) => setError(errorText(err, 'The test case could not be loaded.')))
  }, [importId, caseId])

  const runCheck = async () => {
    if (!edited.trim()) return
    setChecking(true)
    try { setCheck(await katalonImportService.checkScript(importId, caseId, framework, edited)) } catch (err) { setError(errorText(err, 'The script could not be checked.')) } finally { setChecking(false) }
  }

  if (error) return <div className="rounded-[14px] bg-[#FDEBEC] px-4 py-3 text-[13px] text-[#B71920]">{error}</div>
  if (!detail) return <Empty>Building the test case and its scripts…</Empty>
  const code = detail.scripts[framework]
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="text-[12.5px] font-semibold text-[#B71920] hover:underline" onClick={onClose}>← All test cases</button>
            <Chip cls={CASE_STATUS[detail.status].cls}>{CASE_STATUS[detail.status].label}</Chip>
          </div>
          <div className="mt-1 text-[16px] font-bold text-[#1F2937]">{detail.case_id} · {detail.title}</div>
          <div className="mt-0.5 text-[12px] text-[#6B7280]">{detail.steps.length} steps. Click a step to see the same step in the script.</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-[#6B7280]">Playwright</span><ConformanceBadge c={detail.conformance.playwright} />
          <span className="text-[12px] text-[#6B7280]">Katalon</span><ConformanceBadge c={detail.conformance.katalon} />
        </div>
      </div>
      {detail.problems.length > 0 && (
        <div className="flex flex-col gap-1 rounded-[12px] border border-[#F5D9A8] bg-[#FFFAF2] px-4 py-3">
          {detail.problems.map((p, i) => (
            <div key={i} className="flex items-start gap-2 text-[12.5px] text-[#4B5563]">
              <span className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full" style={{ background: SEVERITY[p.severity].dot }} />{p.text}
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
        <div className="max-h-[700px] overflow-auto rounded-[14px] border border-[#EEF0F3]">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 bg-[#FCFCFD]">
              <tr className="border-b border-[#EEF0F3] text-[11px] uppercase tracking-[0.08em] text-[#6B7280]">
                <th className="px-3 py-2 font-semibold">Step</th>
                <th className="px-3 py-2 font-semibold">Action</th>
                <th className="px-3 py-2 font-semibold">Expected result</th>
              </tr>
            </thead>
            <tbody>
              {detail.steps.map((s) => (
                <tr key={s.n} onClick={() => setFocus(s.n)}
                  className={`cursor-pointer border-b border-[#F4F5F7] align-top last:border-0 ${focus === s.n ? 'bg-[#FFF5F5]' : 'hover:bg-[#FCFCFD]'}`}>
                  <td className="px-3 py-2">
                    <div className="text-[12.5px] font-bold tabular-nums text-[#1F2937]">{s.n}</div>
                    <div className="text-[10.5px] text-[#9CA3AF]">{s.component}</div>
                  </td>
                  <td className="px-3 py-2">
                    {s.when.length > 0 && <div className="mb-0.5 text-[11px] font-semibold text-[#6B21A8]">{s.when.join(' → ')}</div>}
                    <div className="text-[12.5px] text-[#1F2937]">{s.action}</div>
                    {s.data && <div className="text-[11.5px] text-[#6B7280]">Data: {s.data}</div>}
                  </td>
                  <td className="px-3 py-2 text-[12px] text-[#4B5563]">{s.expected}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-2">
            {(['playwright', 'katalon'] as const).map((f) => (
              <button key={f} type="button" onClick={() => setFramework(f)}
                className={`h-8 rounded-full border px-3 text-[12.5px] font-semibold ${framework === f ? 'border-[#B71920] bg-[#FFF5F5] text-[#B71920]' : 'border-[#E8EAEE] bg-white text-[#4B5563]'}`}>
                {f === 'playwright' ? 'Playwright (TypeScript)' : 'Katalon (Groovy)'}
              </button>
            ))}
            <button type="button" className="ml-auto text-[12px] font-semibold text-[#6B7280] hover:text-[#B71920]" onClick={() => navigator.clipboard?.writeText(code)}>Copy</button>
          </div>
          <CodeView code={code} focus={focus} />
        </div>
      </div>
      <details className="rounded-[14px] border border-[#EEF0F3] bg-white">
        <summary className="cursor-pointer px-4 py-2.5 text-[13px] font-bold text-[#1F2937]">Check an edited {framework === 'playwright' ? 'Playwright' : 'Katalon'} script against this test case</summary>
        <div className="flex flex-col gap-2 border-t border-[#EEF0F3] px-4 py-3">
          <div className="text-[12px] text-[#6B7280]">Paste the script. It must keep the <span className={MONO}>// [TC n]</span> markers; the check reports missing, extra or reordered steps and steps that no longer use the test case's locator.</div>
          <textarea className={`min-h-[140px] rounded-[10px] border border-[#E8EAEE] p-3 ${MONO}`} value={edited} onChange={(e) => setEdited(e.target.value)} placeholder="Paste the script here" />
          <div className="flex items-center gap-2">
            <button type="button" className={BTN} disabled={checking || !edited.trim()} onClick={runCheck}>{checking ? 'Checking…' : 'Check'}</button>
            {check && <ConformanceBadge c={check} />}
          </div>
          {check && !check.ok && (
            <ul className="m-0 list-disc pl-5 text-[12px] text-[#4B5563]">
              {check.issues.map((i, k) => <li key={k}>TC {i.n ?? '?'} {i.key ?? ''}: {i.problem}</li>)}
            </ul>
          )}
        </div>
      </details>
    </div>
  )
}

const CasesTab: React.FC<{ detail: ImportDetail }> = ({ detail }) => {
  const result = detail.result!
  const [status, setStatus] = useState<CaseStatus | 'all'>('ready')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const counts = result.analysis.summary.cases
  const list = result.cases.filter((c) => (status === 'all' || c.status === status) &&
    (!query || `${c.case_id} ${c.title}`.toLowerCase().includes(query.toLowerCase())))
  useEffect(() => { setOpen(null) }, [detail.meta.id])
  if (open) return <CaseViewer importId={detail.meta.id} caseId={open} onClose={() => setOpen(null)} />
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {(['ready', 'incomplete', 'excluded', 'all'] as const).map((s) => (
          <button key={s} type="button" onClick={() => setStatus(s)} title={s === 'all' ? '' : CASE_STATUS[s].hint}
            className={`h-8 rounded-full border px-3 text-[12.5px] font-semibold ${status === s ? 'border-[#B71920] bg-[#FFF5F5] text-[#B71920]' : 'border-[#E8EAEE] bg-white text-[#4B5563]'}`}>
            {s === 'all' ? `All · ${result.cases.length}` : `${CASE_STATUS[s].label} · ${counts[s] ?? 0}`}
          </button>
        ))}
        <input className={`${FIELD} ml-auto max-w-[280px]`} placeholder="Search case id or title" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="rounded-[12px] bg-[#FCFCFD] px-4 py-2.5 text-[12.5px] text-[#4B5563]">
        One test case per data row. Each row's data decides its branches, so a test case holds exactly the steps its script runs.
        Open a case to see the manual steps beside the Playwright and Katalon scripts.
      </div>
      <div className="overflow-hidden rounded-[14px] border border-[#EEF0F3]">
        {!list.length && <div className="px-4 py-6 text-[13px] text-[#6B7280]">No test cases here.</div>}
        <div className="max-h-[620px] overflow-y-auto">
          {list.map((c: CaseBrief) => (
            <button key={c.case_id} type="button" onClick={() => setOpen(c.case_id)}
              className="flex w-full items-start gap-3 border-b border-[#F4F5F7] px-4 py-2.5 text-left last:border-0 hover:bg-[#FFFBFB]">
              <span className="w-[110px] flex-none text-[12.5px] font-bold text-[#941216]">{c.case_id}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-[#1F2937]">{c.title}</span>
                {c.problems.length > 0 && <span className="block truncate text-[11.5px] text-[#8A5000]">{c.problems[0].text}</span>}
              </span>
              <span className="flex-none text-[11.5px] tabular-nums text-[#6B7280]">{c.steps} steps</span>
              <Chip cls={CASE_STATUS[c.status].cls}>{CASE_STATUS[c.status].label}</Chip>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// --- Publish ------------------------------------------------------------------------

const PublishTab: React.FC<{ detail: ImportDetail; canEdit: boolean; canApprove: boolean; onChanged: (d: ImportDetail) => void }> = ({ detail, canEdit, canApprove, onChanged }) => {
  const result = detail.result!
  const confirm = useConfirm()
  const [key, setKey] = useState(detail.meta.app_key || result.suggested.app_key)
  const [name, setName] = useState(detail.meta.app_name || result.suggested.app_name)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState<{ ok: boolean; text: React.ReactNode } | null>(null)
  const [status, setStatus] = useState<'ready' | 'all'>('ready')
  const [frameworks, setFrameworks] = useState<string[]>(['playwright', 'katalon'])
  const last = (detail.meta.change_sets || []).slice(-1)[0]

  const draft = async () => {
    setBusy('draft'); setMessage(null)
    try {
      const out = await katalonImportService.draftChangeSet(detail.meta.id, key.trim(), name.trim())
      onChanged(await katalonImportService.get(detail.meta.id))
      setMessage({ ok: true, text: <>Draft change set #{out.change_set_id} created for <b>{out.app_key}</b>. Review it on the Knowledge Base page, or approve it here.</> })
    } catch (err) {
      setMessage({ ok: false, text: errorText(err, 'The draft could not be made.') })
    } finally { setBusy('') }
  }
  const approve = async (id: number) => {
    const ok = await confirm({ title: `Publish change set #${id} to the Automation KB?`, body: 'The components, flow and profile are written to the Automation KB. A version is recorded, so it can be reverted.', confirmLabel: `Publish #${id}` })
    if (!ok) return
    setBusy('approve'); setMessage(null)
    try {
      await katalonImportService.approveChangeSet(id, 'Approved from Katalon Import')
      setMessage({ ok: true, text: <>Change set #{id} is published to the Automation KB.</> })
    } catch (err) {
      setMessage({ ok: false, text: errorText(err, 'The change set could not be published.') })
    } finally { setBusy('') }
  }
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setMessage(null)
    try { await fn() } catch (err) { setMessage({ ok: false, text: errorText(err, 'The download failed.') }) } finally { setBusy('') }
  }
  const counts = result.analysis.summary.cases

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <section className="flex flex-col gap-3 rounded-[16px] border border-[#EEF0F3] px-5 py-4">
        <div>
          <div className="text-[15px] font-bold text-[#1F2937]">1 · Automation Knowledge Base</div>
          <div className="mt-0.5 text-[12.5px] leading-[1.55] text-[#4B5563]">
            Creates a <b>draft</b> change set with app_profile.json, components.json and one flow per test case.
            Nothing changes until it is approved. Re-running replaces components with the same id.
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className={EYEBROW}>KB key (folder)</span>
            <input className={FIELD} value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} disabled={!canEdit} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={EYEBROW}>Application name</span>
            <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={PRIMARY} disabled={!canEdit || !!busy || !key.trim() || !name.trim()} onClick={draft}>
            {busy === 'draft' ? 'Creating…' : 'Create draft change set'}
          </button>
          {last && (
            <>
              <Link to={`/automation/knowledge-base?app=${encodeURIComponent(last.app_key)}`} className={BTN}>Review in Knowledge Base</Link>
              {canApprove && <button type="button" className={BTN} disabled={!!busy} onClick={() => approve(last.id)}>{busy === 'approve' ? 'Publishing…' : `Approve #${last.id}`}</button>}
            </>
          )}
        </div>
        {(detail.meta.change_sets || []).length > 0 && (
          <div className="text-[11.5px] text-[#6B7280]">Drafts from this import: {(detail.meta.change_sets || []).map((c) => `#${c.id} (${c.app_key}, ${fmtDate(c.at)})`).join(' · ')}</div>
        )}
        <button type="button" className={`${BTN} w-fit`} disabled={!!busy} onClick={() => run('kb', () => katalonImportService.downloadKb(detail.meta.id, key || 'app'))}>
          {busy === 'kb' ? 'Preparing…' : 'Download the KB files (.zip)'}
        </button>
      </section>

      <section className="flex flex-col gap-3 rounded-[16px] border border-[#EEF0F3] px-5 py-4">
        <div>
          <div className="text-[15px] font-bold text-[#1F2937]">2 · Test cases and scripts</div>
          <div className="mt-0.5 text-[12.5px] leading-[1.55] text-[#4B5563]">
            The same steps as a manual test case sheet and as scripts. Every script is checked against its test case before download
            (CONFORMANCE.json in the zip).
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-[13px] text-[#374151]">
            <input type="radio" className="accent-[#B71920]" checked={status === 'ready'} onChange={() => setStatus('ready')} /> Ready only ({counts.ready ?? 0})
          </label>
          <label className="flex items-center gap-2 text-[13px] text-[#374151]">
            <input type="radio" className="accent-[#B71920]" checked={status === 'all'} onChange={() => setStatus('all')} /> All rows ({result.cases.length})
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {(['playwright', 'katalon'] as const).map((f) => (
            <label key={f} className="flex items-center gap-2 text-[13px] text-[#374151]">
              <input type="checkbox" className="accent-[#B71920]" checked={frameworks.includes(f)}
                onChange={(e) => setFrameworks((prev) => (e.target.checked ? [...prev, f] : prev.filter((x) => x !== f)))} />
              {f === 'playwright' ? 'Playwright project' : 'Katalon scripts (for the team’s project)'}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={PRIMARY} disabled={!!busy} onClick={() => run('cases', () => katalonImportService.downloadCases(detail.meta.id, status))}>
            {busy === 'cases' ? 'Preparing…' : 'Test cases (.xlsx)'}
          </button>
          <button type="button" className={BTN} disabled={!!busy || !frameworks.length} onClick={() => run('scripts', () => katalonImportService.downloadScripts(detail.meta.id, status, frameworks))}>
            {busy === 'scripts' ? 'Preparing…' : 'Scripts (.zip)'}
          </button>
          <button type="button" className={BTN} disabled={!!busy} onClick={() => run('report', () => katalonImportService.downloadReport(detail.meta.id))}>
            {busy === 'report' ? 'Preparing…' : 'Findings report (.md)'}
          </button>
        </div>
        <div className="text-[11.5px] text-[#6B7280]">
          Secrets are never in the files: Playwright reads KATALON_&lt;name&gt; from the environment; Katalon uses the team’s GlobalVariable profile.
        </div>
      </section>
      {message && (
        <div className={`rounded-[12px] px-4 py-3 text-[13px] xl:col-span-2 ${message.ok ? 'bg-[#E8F6EE] text-[#136B34]' : 'bg-[#FDEBEC] text-[#B71920]'}`}>{message.text}</div>
      )}
    </div>
  )
}

// --- One import -----------------------------------------------------------------------

type TabId = 'inputs' | 'findings' | 'kb' | 'cases' | 'publish'

const ImportView: React.FC<{ importId: string; canEdit: boolean; canApprove: boolean; onChanged: () => void; onDeleted: () => void }> = ({ importId, canEdit, canApprove, onChanged, onDeleted }) => {
  const confirm = useConfirm()
  const [detail, setDetail] = useState<ImportDetail | null>(null)
  const [tab, setTab] = useState<TabId>('inputs')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<number | null>(null)
  const [name, setName] = useState('')

  const load = useCallback(async () => {
    try {
      const d = await katalonImportService.get(importId)
      setDetail(d); setName(d.meta.name)
      setTab((cur) => (d.result ? cur : 'inputs'))
    } catch (err) { setError(errorText(err, 'The import could not be loaded.')) }
  }, [importId])

  useEffect(() => { setDetail(null); setError(''); setTab('inputs'); void load() }, [load])

  const apply = (d: ImportDetail) => { setDetail(d); onChanged() }

  const upload = async (files: File[]) => {
    setBusy(0); setError('')
    try {
      const d = await katalonImportService.upload(importId, files, setBusy)
      apply(d)
      if (d.result && tab === 'inputs') setTab('findings')
    } catch (err) { setError(errorText(err, 'The upload failed.')); void load() } finally { setBusy(null) }
  }
  const reanalyse = async () => {
    setBusy(100); setError('')
    try { apply(await katalonImportService.analyse(importId)) } catch (err) { setError(errorText(err, 'The analysis failed.')) } finally { setBusy(null) }
  }
  const removeFile = async (f: ImportFile) => {
    try { apply(await katalonImportService.removeFile(importId, f.path)) } catch (err) { setError(errorText(err, 'The file could not be removed.')) }
  }
  const rename = async () => {
    if (!detail || !name.trim() || name.trim() === detail.meta.name) return
    try { apply(await katalonImportService.update(importId, { name: name.trim() })) } catch (err) { setError(errorText(err, 'The name could not be saved.')) }
  }
  const remove = async () => {
    const ok = await confirm({ title: 'Delete this import?', body: 'Its uploaded files and results are removed.', consequences: ['Change sets already drafted from it stay on the Knowledge Base page.'], confirmLabel: 'Delete import', tone: 'danger' })
    if (!ok) return
    try { await katalonImportService.remove(importId); onDeleted() } catch (err) { setError(errorText(err, 'The import could not be deleted.')) }
  }

  if (!detail) return <section className={`${CARD} px-6 py-8 text-[13px] text-[#6B7280]`}>{error || 'Loading…'}</section>
  const s = detail.result?.analysis.summary
  const tabs: { id: TabId; label: string; needs: boolean }[] = [
    { id: 'inputs', label: '1 · Inputs', needs: false },
    { id: 'findings', label: `2 · Findings${s ? ` · ${s.findings.high ?? 0} high` : ''}`, needs: true },
    { id: 'kb', label: '3 · Knowledge Base', needs: true },
    { id: 'cases', label: `4 · Test cases & scripts${s ? ` · ${s.cases.ready ?? 0} ready` : ''}`, needs: true },
    { id: 'publish', label: '5 · Publish', needs: true },
  ]
  return (
    <section className={`${CARD} flex min-w-0 flex-col gap-4 px-6 py-5`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <input className="w-full max-w-[560px] rounded-[8px] border border-transparent bg-transparent px-1 text-[19px] font-bold text-[#1F2937] outline-none hover:border-[#E8EAEE] focus:border-[#F1A4A6]"
            value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
          <div className="px-1 text-[12px] text-[#6B7280]">
            {detail.meta.created_by ? `${detail.meta.created_by} · ` : ''}{fmtDate(detail.meta.created_at)}
            {detail.result ? ` · analysed ${fmtDate(detail.result.generated_at)}` : ''}
          </div>
        </div>
        {canEdit && <button type="button" className={BTN} onClick={remove}>Delete</button>}
      </div>
      {error && <div className="rounded-[12px] bg-[#FDEBEC] px-4 py-3 text-[13px] text-[#B71920]">{error}</div>}
      {detail.meta.status === 'failed' && detail.meta.error && <div className="rounded-[12px] bg-[#FDEBEC] px-4 py-3 text-[13px] text-[#B71920]">{detail.meta.error}</div>}
      {s && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <Tile label="Components" value={s.components} hint={`${s.steps} steps from ${s.test_cases} test case${s.test_cases === 1 ? '' : 's'}`} />
          <Tile label="Locators" value={s.locators} hint={`${s.locators_with_issues} with issues`} />
          <Tile label="Database steps" value={s.db_steps} hint="prep gated · checks read-only" />
          <Tile label="Data rows" value={s.rows} />
          <Tile label="Test cases" value={s.cases.ready ?? 0} hint={`ready · ${s.cases.incomplete ?? 0} incomplete · ${s.cases.excluded ?? 0} excluded`} />
          <Tile label="Findings" value={<span className="text-[#B71920]">{s.findings.high ?? 0}</span>} hint={`high · ${s.findings.medium ?? 0} medium · ${s.findings.info ?? 0} info`} />
        </div>
      )}
      <div className="flex flex-wrap gap-1 border-b border-[#EEF0F3]">
        {tabs.map((t) => {
          const disabled = t.needs && !detail.result
          return (
            <button key={t.id} type="button" disabled={disabled} onClick={() => setTab(t.id)}
              className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-bold transition disabled:cursor-not-allowed disabled:opacity-40 ${tab === t.id ? 'border-[#B71920] text-[#B71920]' : 'border-transparent text-[#4B5563] hover:text-[#1F2937]'}`}>
              {t.label}
            </button>
          )
        })}
      </div>
      {tab === 'inputs' && <InputsTab detail={detail} canEdit={canEdit} busy={busy} onFiles={upload} onRemove={removeFile} onAnalyse={reanalyse} />}
      {tab === 'findings' && detail.result && <FindingsTab detail={detail} />}
      {tab === 'kb' && detail.result && <KbTab detail={detail} />}
      {tab === 'cases' && detail.result && <CasesTab detail={detail} />}
      {tab === 'publish' && detail.result && <PublishTab detail={detail} canEdit={canEdit} canApprove={canApprove} onChanged={apply} />}
    </section>
  )
}

// --- Page -----------------------------------------------------------------------------

const KatalonImport: React.FC = () => {
  const { user } = useAuth()
  const canEdit = hasPermission(user, 'automation.execute')
  const canApprove = hasPermission(user, 'automation.approve')
  const [items, setItems] = useState<ImportBrief[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    try {
      const list = await katalonImportService.list()
      setItems(list)
      setSelected((cur) => (cur && list.some((i) => i.id === cur) ? cur : list[0]?.id ?? null))
    } catch (err) { setItems([]); setError(errorText(err, 'Katalon Import is not available on this server.')) }
  }, [])
  useEffect(() => { void load() }, [load])

  const create = async () => {
    setCreating(true); setError('')
    try {
      const meta = await katalonImportService.create(newName.trim() || `Katalon import ${new Date().toISOString().slice(0, 10)}`)
      setNewName('')
      await load()
      setSelected(meta.id)
    } catch (err) { setError(errorText(err, 'The import could not be created.')) } finally { setCreating(false) }
  }

  return (
    <div className="flex flex-col gap-3">
      <section className={`${CARD} px-6 py-5`}>
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-[#B71920]">AI Test Automation</p>
        <div className="mt-1 flex flex-wrap items-center gap-2.5">
          <h1 className="m-0 text-[27px] font-extrabold leading-tight tracking-[-0.02em] text-[#1F2937]">Katalon Import</h1>
          <span className="rounded-full border border-[#F1A4A6] bg-[#FFF5F5] px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[#B71920]">Beta</span>
        </div>
        <p className="mt-2 max-w-[900px] text-[13.5px] leading-[1.6] text-[#4B5563]">
          Upload the QA team's Katalon exports and get, from one set of steps: what is missing or fragile, a draft Automation Knowledge Base,
          a manual test case for every data row, and Playwright and Katalon scripts that match each test case step for step.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-[#6B7280]">
          {['Upload exports', 'Review findings', 'Check the KB', 'Open test cases & scripts', 'Publish'].map((step, i) => (
            <React.Fragment key={step}>
              {i > 0 && <span className="text-[#D1D5DB]">→</span>}
              <span className="rounded-full bg-[#F4F5F7] px-2.5 py-1 font-semibold text-[#4B5563]">{i + 1}. {step}</span>
            </React.Fragment>
          ))}
        </div>
      </section>

      {error && <section className={`${CARD} px-6 py-4 text-[13px] text-[#B71920]`}>{error}</section>}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className={`${CARD} flex flex-col gap-3 px-4 py-4 lg:sticky lg:top-3 lg:max-h-[calc(100vh-24px)] lg:self-start`}>
          {canEdit && (
            <div className="flex flex-col gap-2">
              <span className={EYEBROW}>New import</span>
              <input className={FIELD} placeholder="e.g. USP Mobile Postpaid" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void create() }} />
              <button type="button" className={`${PRIMARY} justify-center`} disabled={creating} onClick={create}>{creating ? 'Creating…' : '+ New import'}</button>
            </div>
          )}
          <span className={EYEBROW}>Imports</span>
          <div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
            {items === null && <div className="text-[12.5px] text-[#6B7280]">Loading…</div>}
            {items?.length === 0 && <div className="text-[12.5px] text-[#6B7280]">None yet. Create one, then upload the exports.</div>}
            {items?.map((i) => (
              <button key={i.id} type="button" onClick={() => setSelected(i.id)}
                className={`rounded-[12px] border px-3 py-2 text-left transition ${selected === i.id ? 'border-[#F1A4A6] bg-[#FFF5F5]' : 'border-transparent hover:bg-[#FCFCFD]'}`}>
                <div className="truncate text-[13px] font-bold text-[#1F2937]">{i.name}</div>
                <div className="text-[11.5px] text-[#6B7280]">
                  {i.files} file{i.files === 1 ? '' : 's'}{i.summary ? ` · ${i.summary.cases.ready ?? 0} ready cases` : ''} · {fmtDate(i.updated_at)}
                </div>
              </button>
            ))}
          </div>
        </aside>
        {selected ? (
          <ImportView key={selected} importId={selected} canEdit={canEdit} canApprove={canApprove} onChanged={load}
            onDeleted={() => { setSelected(null); void load() }} />
        ) : (
          <section className={`${CARD} flex flex-col items-center gap-2 px-6 py-12 text-center`}>
            <div className="text-[15px] font-bold text-[#1F2937]">Start with a new import</div>
            <div className="max-w-[460px] text-[13px] text-[#6B7280]">Give it a name, then drop the converted test case (.md) and whatever else the team exported: Object Repository, test data, keywords and profile.</div>
          </section>
        )}
      </div>
    </div>
  )
}

export default KatalonImport
