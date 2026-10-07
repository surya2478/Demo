// AI R&D Lab -- under AI Test Automation, independent of everything else.
//
// Project first (the same PPM ID + Project Name as Generate Test Cases), then a
// study: the project's approved automation cases, their BRDs (linked
// automatically from each case's request), optional Figma and other uploads,
// and the Journey KB. Analysis maps every step against each source and lists
// what is still to do. The Lab reads other modules and writes to none of them.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { useConfirm } from '../../components/ui/ConfirmDialog'
import { useProject } from '../../context/ProjectContext'
import { ProjectChip, ProjectDialog } from '../../components/project/ProjectDetails'
import rndLabService, {
  type CaseMap,
  type CellStatus,
  type EvidenceCell,
  type Gap,
  type GapModule,
  type LabCase,
  type LabStatus,
  type StudyBrief,
  type StudyDetail,
} from '../../services/rndLabService'

const CARD = 'rounded-[20px] border border-[#E8EAEE] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]'
const FIELD = 'h-9 w-full rounded-[10px] border border-[#E8EAEE] bg-white px-3 text-[13px] text-[#1F2937] outline-none transition focus:border-[#F1A4A6] focus:ring-2 focus:ring-[#FDEBEC] disabled:bg-[#F9FAFB]'
const BTN = 'flex h-9 items-center gap-1.5 whitespace-nowrap rounded-[12px] border border-[#E8EAEE] bg-white px-3.5 text-[13px] font-bold text-[#1F2937] transition hover:border-[#F6D4D5] disabled:cursor-not-allowed disabled:opacity-50'
const PRIMARY = 'flex h-9 items-center gap-1.5 whitespace-nowrap rounded-[12px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-4 text-[13px] font-bold text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50'
const EYEBROW = 'text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]'

const hasPermission = (user: any, permission: string): boolean => {
  if (!user) return false
  const roles: string[] = (user.roles as string[]) || (user.role ? [user.role] : [])
  if (roles.some((r) => String(r).toLowerCase() === 'admin')) return true
  return ((user.permissions as string[]) || []).includes(permission)
}

const errorText = (err: any, fallback: string) => err?.response?.data?.detail || err?.message || fallback

const CELL_STYLE: Record<CellStatus, { label: string; cls: string }> = {
  mapped: { label: 'Mapped', cls: 'bg-[#E8F6EE] text-[#136B34] border-[#BBDFC8]' },
  weak: { label: 'Weak', cls: 'bg-[#FFF4E5] text-[#8A5000] border-[#F5D9A8]' },
  missing: { label: 'Missing', cls: 'bg-[#FDEBEC] text-[#B71920] border-[#F6D4D5]' },
  conflict: { label: 'Conflict', cls: 'bg-[#F3E8FF] text-[#6B21A8] border-[#E1CCF7]' },
  unverified: { label: 'Unverified', cls: 'bg-[#FFF7ED] text-[#9A3412] border-[#FBD5B5]' },
  na: { label: 'n/a', cls: 'bg-[#F4F5F7] text-[#6B7280] border-[#E8EAEE]' },
  pending: { label: 'No script', cls: 'bg-[#EEF4FF] text-[#1D4ED8] border-[#C9DAFB]' },
}

const VERDICT: Record<string, { label: string; cls: string }> = {
  ready: { label: 'Ready', cls: 'bg-[#E8F6EE] text-[#136B34]' },
  needs_work: { label: 'Needs work', cls: 'bg-[#FFF4E5] text-[#8A5000]' },
  blocked: { label: 'Blocked', cls: 'bg-[#FDEBEC] text-[#B71920]' },
  needs_decision: { label: 'Needs BA decision', cls: 'bg-[#F3E8FF] text-[#6B21A8]' },
}

const SEVERITY: Record<string, string> = {
  high: 'bg-[#FDEBEC] text-[#B71920]',
  medium: 'bg-[#FFF4E5] text-[#8A5000]',
  info: 'bg-[#EEF4FF] text-[#1D4ED8]',
}

const GAP_LABEL: Record<string, string> = {
  uncovered_requirement: 'Requirements with no test case',
  unsupported_step: 'Steps not backed by a document',
  design_drift: 'Sources disagree',
  kb_gap: 'Elements not in the KB',
  script_gap: 'Steps the script skips',
  weak_assertion: 'Expected results not checked',
  no_script: 'Cases with no script',
  dry_run_failed: 'Dry runs not passing',
  data_gap: 'Test data pending',
}

const MODULE_LINK: Record<string, { to: string; label: string }> = {
  script_lab: { to: '/automation/script-lab', label: 'Automation Lab' },
  workbench: { to: '/automation/workbench', label: 'Workbench' },
  knowledge_base: { to: '/automation/knowledge-base', label: 'Knowledge Base' },
  test_data: { to: '/test-data', label: 'Test Data' },
}

const ROLE_LABEL: Record<string, string> = {
  brd: 'BRD',
  figma: 'Figma design',
  srd: 'SRD',
  api_spec: 'API spec',
  other: 'Other',
}

const fmtSize = (bytes?: number | null) =>
  !bytes ? '' : bytes > 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

// --- Small pieces ----------------------------------------------------------------

const Chip: React.FC<{ cls: string; children: React.ReactNode; title?: string }> = ({ cls, children, title }) => (
  <span title={title} className={`inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-[11.5px] font-semibold ${cls}`}>{children}</span>
)

const Readiness: React.FC<{ value: number | null | undefined }> = ({ value }) => {
  if (value === null || value === undefined) return <span className="text-[12px] text-[#9CA3AF]">—</span>
  const color = value >= 80 ? '#16A34A' : value >= 50 ? '#D97706' : '#DC2626'
  return (
    <div className="flex min-w-[110px] items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#F1F2F4]">
        <div className="h-full rounded-full" style={{ width: `${value}%`, background: color }} />
      </div>
      <span className="w-8 text-right text-[12.5px] font-bold tabular-nums text-[#1F2937]">{value}</span>
    </div>
  )
}

const Cell: React.FC<{ cell?: EvidenceCell }> = ({ cell }) => {
  if (!cell) return <span className="text-[12px] text-[#9CA3AF]">—</span>
  const style = CELL_STYLE[cell.status] || CELL_STYLE.na
  const tip = [cell.ref, cell.evidence, cell.note, cell.rules && cell.rules !== cell.status ? `Rules said: ${cell.rules}` : null]
    .filter(Boolean)
    .join('\n')
  return (
    <div className="flex min-w-0 flex-col gap-1" title={tip}>
      <div className="flex items-center gap-1">
        <span className={`inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-semibold ${style.cls}`}>{style.label}</span>
        {cell.source === 'ai' && <span className="rounded bg-[#F4F5F7] px-1 text-[10px] font-bold text-[#6B7280]">AI</span>}
        {cell.ref && <span className="truncate font-mono text-[10.5px] text-[#6B7280]">{cell.ref}</span>}
      </div>
      {(cell.evidence || cell.note) && (
        <span className="line-clamp-2 text-[11.5px] leading-[1.35] text-[#4B5563]">{cell.evidence || cell.note}</span>
      )}
    </div>
  )
}

const Tile: React.FC<{ label: string; value: React.ReactNode; hint?: string }> = ({ label, value, hint }) => (
  <div className="rounded-[14px] border border-[#EEF0F3] bg-[#FCFCFD] px-4 py-3">
    <div className={EYEBROW}>{label}</div>
    <div className="mt-1 text-[22px] font-extrabold leading-tight text-[#1F2937]">{value}</div>
    {hint && <div className="mt-0.5 text-[11.5px] text-[#6B7280]">{hint}</div>}
  </div>
)

const GapAction: React.FC<{ module?: GapModule }> = ({ module }) => {
  const link = module ? MODULE_LINK[module] : null
  if (!link) return null
  return (
    <Link to={link.to} className="whitespace-nowrap text-[12px] font-semibold text-[#B71920] hover:underline">
      Open {link.label} →
    </Link>
  )
}

// --- New study -------------------------------------------------------------------

const NewStudy: React.FC<{
  projectId: number
  ppmId: string
  kbApps: { app_id: string; app_name: string }[]
  onCreated: (study: StudyBrief) => void
  onCancel: () => void
}> = ({ projectId, ppmId, kbApps, onCreated, onCancel }) => {
  const [name, setName] = useState(`${ppmId} study ${new Date().toISOString().slice(0, 10)}`)
  const [kb, setKb] = useState(kbApps[0]?.app_id ?? '')
  const [hasDesign, setHasDesign] = useState(false)
  const [unassigned, setUnassigned] = useState(false)
  const [cases, setCases] = useState<LabCase[] | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setCases(null)
    rndLabService.projectCases(projectId, unassigned)
      .then((items) => { setCases(items); setPicked(new Set(items.filter((c) => c.project_id === projectId).map((c) => c.id))) })
      .catch((err) => { setCases([]); setError(errorText(err, 'The cases could not be loaded.')) })
  }, [projectId, unassigned])

  useEffect(() => { if (!kb && kbApps[0]) setKb(kbApps[0].app_id) }, [kbApps, kb])

  const toggle = (id: number) => setPicked((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  const all = cases ?? []
  const allPicked = all.length > 0 && all.every((c) => picked.has(c.id))

  const create = async () => {
    if (!picked.size) { setError('Pick at least one test case.'); return }
    setBusy(true)
    setError('')
    try {
      // Every case of the project picked, and nothing from outside it: store no
      // list, so cases approved later join the study on its next analysis.
      const everything = !unassigned && allPicked
      onCreated(await rndLabService.createStudy({
        project_id: projectId, name: name.trim() || 'Study', kb_app_id: kb || null,
        case_ids: everything ? null : Array.from(picked), has_design: hasDesign,
      }))
    } catch (err) {
      setError(errorText(err, 'The study could not be created.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={`${CARD} flex flex-col gap-4 px-6 py-5`}>
      <div>
        <h2 className="m-0 text-[17px] font-bold text-[#1F2937]">New study</h2>
        <p className="mt-0.5 text-[12.5px] text-[#6B7280]">
          Approved automation test cases of this project. Their BRDs are linked automatically from the request each case came from.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className={EYEBROW}>Study name</span>
          <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} maxLength={255} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={EYEBROW}>Knowledge Base</span>
          <select className={FIELD} value={kb} onChange={(e) => setKb(e.target.value)}>
            {kbApps.map((app) => <option key={app.app_id} value={app.app_id}>{app.app_name}</option>)}
            <option value="">No Knowledge Base</option>
          </select>
        </label>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <label className="flex items-center gap-2 text-[13px] text-[#374151]">
          <input type="checkbox" checked={hasDesign} onChange={(e) => setHasDesign(e.target.checked)} className="accent-[#B71920]" />
          This project has Figma designs
          <span className="text-[12px] text-[#9CA3AF]">(adds a Design column; upload the export next)</span>
        </label>
        <label className="flex items-center gap-2 text-[13px] text-[#374151]">
          <input type="checkbox" checked={unassigned} onChange={(e) => setUnassigned(e.target.checked)} className="accent-[#B71920]" />
          Also show approved cases with no project
        </label>
      </div>

      <div className="overflow-hidden rounded-[14px] border border-[#EEF0F3]">
        <div className="flex items-center justify-between border-b border-[#EEF0F3] bg-[#FCFCFD] px-4 py-2">
          <label className="flex items-center gap-2 text-[12.5px] font-semibold text-[#374151]">
            <input type="checkbox" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(all.map((c) => c.id)))} className="accent-[#B71920]" />
            {picked.size} of {all.length} test case{all.length === 1 ? '' : 's'}
          </label>
          <span className="text-[11.5px] text-[#6B7280]">Approved and classified Automation</span>
        </div>
        <div className="max-h-[340px] overflow-y-auto">
          {cases === null && <div className="px-4 py-6 text-[13px] text-[#6B7280]">Loading cases…</div>}
          {cases !== null && !cases.length && (
            <div className="px-4 py-6 text-[13px] text-[#6B7280]">
              No approved automation test cases for this project yet. Approve and classify cases in Review &amp; Approval and the Workbench first.
            </div>
          )}
          {all.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-start gap-3 border-b border-[#F4F5F7] px-4 py-2.5 last:border-0 hover:bg-[#FFFBFB]">
              <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} className="mt-1 accent-[#B71920]" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12.5px] font-bold text-[#941216]">{c.display_id}</span>
                  <span className="text-[11.5px] text-[#6B7280]">{c.steps} steps</span>
                  {!c.project_id && <Chip cls="bg-[#F4F5F7] text-[#6B7280]">No project</Chip>}
                  <Chip cls={c.has_brd ? 'bg-[#E8F6EE] text-[#136B34]' : 'bg-[#FFF4E5] text-[#8A5000]'}>{c.has_brd ? 'BRD linked' : 'No BRD on request'}</Chip>
                  <Chip cls={c.script ? 'bg-[#EEF4FF] text-[#1D4ED8]' : 'bg-[#F4F5F7] text-[#6B7280]'}>
                    {c.script ? `${c.script.framework} · dry run ${c.script.dry_run.replace('_', ' ')}` : 'No script'}
                  </Chip>
                </div>
                <div className="mt-0.5 truncate text-[12.5px] text-[#374151]">{c.title}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {error && <div className="rounded-[12px] border border-[#F6D4D5] bg-[#FFF8F8] px-3.5 py-2.5 text-[12.5px] text-[#7A0B0D]" role="alert">{error}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" className={BTN} onClick={onCancel}>Cancel</button>
        <button type="button" className={PRIMARY} disabled={busy || !picked.size} onClick={create}>{busy ? 'Creating…' : 'Create study'}</button>
      </div>
    </section>
  )
}

// --- Sources ---------------------------------------------------------------------

const Sources: React.FC<{
  study: StudyDetail
  kbName?: string
  status: LabStatus | null
  canEdit: boolean
  onChanged: () => void
}> = ({ study, kbName, status, canEdit, onChanged }) => {
  const confirm = useConfirm()
  const [role, setRole] = useState(study.has_design ? 'figma' : 'srd')
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement | null>(null)
  const busy = study.status === 'analysing'

  const upload = async (file: File) => {
    const limit = (status?.max_upload_mb ?? 100) * 1_048_576
    if (file.size > limit) { setError(`${file.name} is ${fmtSize(file.size)}, over the ${status?.max_upload_mb} MB limit.`); return }
    setError('')
    setProgress(0)
    try {
      await rndLabService.upload(study.id, role, file, setProgress)
      onChanged()
    } catch (err) {
      setError(errorText(err, 'The upload failed.'))
    } finally {
      setProgress(null)
      if (input.current) input.current.value = ''
    }
  }

  const remove = async (id: number, filename: string, linked: boolean) => {
    const ok = await confirm({
      title: `Remove ${filename} from this study?`,
      body: linked ? 'It is linked again from the case’s request on the next analysis.' : 'The uploaded file is deleted from the Lab. Nothing else changes.',
      confirmLabel: 'Remove', tone: 'danger',
    })
    if (!ok) return
    try { await rndLabService.deleteDocument(study.id, id); onChanged() } catch (err) { setError(errorText(err, 'It could not be removed.')) }
  }

  const toggleDesign = async () => {
    try { await rndLabService.updateStudy(study.id, { has_design: !study.has_design }); onChanged() } catch (err) { setError(errorText(err, 'Not saved.')) }
  }

  return (
    <section className={`${CARD} flex flex-col gap-3 px-5 py-4`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="m-0 text-[15px] font-bold text-[#1F2937]">Sources</h3>
          <p className="mt-0.5 text-[12px] text-[#6B7280]">
            Knowledge Base: <b className="text-[#374151]">{kbName || study.summary?.sources.kb || study.kb_app_id || 'none'}</b>
            {' · '}
            <button type="button" disabled={!canEdit || busy} onClick={toggleDesign} className="font-semibold text-[#B71920] hover:underline disabled:text-[#9CA3AF] disabled:no-underline">
              {study.has_design ? 'Design column on (Figma)' : 'No designs for this project'}
            </button>
          </p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <select className={`${FIELD} w-[150px]`} value={role} onChange={(e) => setRole(e.target.value)} disabled={progress !== null}>
              {['figma', 'srd', 'api_spec', 'brd', 'other'].map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
            <input ref={input} type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.csv,.txt,.md"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f) }} />
            <button type="button" className={BTN} disabled={progress !== null || busy} onClick={() => input.current?.click()}>
              {progress !== null ? `Uploading ${progress}%` : 'Upload document'}
            </button>
          </div>
        )}
      </div>
      {role === 'figma' && canEdit && (
        <p className="rounded-[10px] bg-[#F9FAFB] px-3 py-2 text-[11.5px] leading-[1.5] text-[#6B7280]">
          Export the frames from Figma as PDF (or PNG); up to {status?.max_upload_mb ?? 100} MB. Pages that carry text are read directly;
          picture-only frames are sent to the vision model a few pages at a time
          {status?.vision_available ? '.' : ' — not configured on this server (AZURE_OPENAI_*), so only text is read.'}
        </p>
      )}
      {error && <div className="rounded-[10px] border border-[#F6D4D5] bg-[#FFF8F8] px-3 py-2 text-[12.5px] text-[#7A0B0D]" role="alert">{error}</div>}
      <div className="flex flex-col divide-y divide-[#F4F5F7]">
        {!study.documents.length && <div className="py-3 text-[12.5px] text-[#6B7280]">No documents yet. BRDs appear here once the cases’ requests carry one.</div>}
        {study.documents.map((d) => (
          <div key={d.id} className="flex flex-wrap items-center gap-2 py-2">
            <Chip cls={d.role === 'figma' ? 'bg-[#F3E8FF] text-[#6B21A8]' : 'bg-[#F4F5F7] text-[#374151]'}>{ROLE_LABEL[d.role] || d.role}</Chip>
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[#1F2937]" title={d.filename}>{d.filename}</span>
            <span className="text-[11.5px] text-[#6B7280]">
              {d.origin === 'linked' ? `Linked · ${d.origin_request_id}` : 'Uploaded'}
              {d.size_bytes ? ` · ${fmtSize(d.size_bytes)}` : ''}
              {d.page_count ? ` · ${d.page_count} pages` : ''}
              {d.text_chars ? ` · ${d.text_chars.toLocaleString()} chars` : ''}
            </span>
            <Chip cls={d.status === 'ready' ? 'bg-[#E8F6EE] text-[#136B34]' : d.status === 'failed' ? 'bg-[#FDEBEC] text-[#B71920]' : 'bg-[#EEF4FF] text-[#1D4ED8]'}>
              {d.status === 'extracting' ? 'Reading…' : d.status}
            </Chip>
            {canEdit && d.status === 'failed' && d.origin === 'upload' && (
              <button type="button" className="text-[12px] font-semibold text-[#B71920] hover:underline" onClick={() => rndLabService.retryDocument(study.id, d.id).then(onChanged)}>Retry</button>
            )}
            {canEdit && !busy && (
              <button type="button" className="text-[12px] text-[#6B7280] hover:text-[#B71920]" onClick={() => remove(d.id, d.filename, d.origin === 'linked')}>Remove</button>
            )}
            {(d.error || d.notes.length > 0) && (
              <div className="w-full pl-1 text-[11.5px] text-[#6B7280]">{d.error ? <span className="text-[#B71920]">{d.error}</span> : d.notes.join(' ')}</div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

// --- Case matrix -----------------------------------------------------------------

const Matrix: React.FC<{ studyId: number; caseId: number; hasDesign: boolean }> = ({ studyId, caseId, hasDesign }) => {
  const [data, setData] = useState<CaseMap | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    rndLabService.caseMap(studyId, caseId).then(setData).catch((err) => setError(errorText(err, 'Not loaded.')))
  }, [studyId, caseId])
  if (error) return <div className="px-4 py-3 text-[12.5px] text-[#B71920]">{error}</div>
  if (!data) return <div className="px-4 py-3 text-[12.5px] text-[#6B7280]">Loading the evidence matrix…</div>
  const cols = hasDesign ? 'grid-cols-[minmax(220px,1.4fr)_repeat(5,minmax(130px,1fr))]' : 'grid-cols-[minmax(220px,1.4fr)_repeat(4,minmax(130px,1fr))]'
  return (
    <div className="flex flex-col gap-3 bg-[#FCFCFD] px-4 py-3">
      {data.error && <div className="text-[11.5px] text-[#9A3412]">AI judgement unavailable for this case; the rules pass is shown. {data.error}</div>}
      <div className="overflow-x-auto rounded-[12px] border border-[#EEF0F3] bg-white">
        <div className={`grid ${cols} min-w-[900px] gap-3 border-b border-[#EEF0F3] px-3 py-2 ${EYEBROW}`}>
          <span>Step</span><span>Requirement</span>{hasDesign && <span>Design</span>}<span>Knowledge Base</span><span>Script action</span><span>Assertion</span>
        </div>
        {data.matrix.map((row) => (
          <div key={row.step_number} className={`grid ${cols} min-w-[900px] gap-3 border-b border-[#F4F5F7] px-3 py-2.5 last:border-0`}>
            <div className="min-w-0">
              <div className="text-[12.5px] font-semibold text-[#1F2937]"><span className="text-[#941216]">{row.step_number}.</span> {row.action}</div>
              {row.expected_result && <div className="mt-0.5 text-[11.5px] text-[#6B7280]">Expect: {row.expected_result}</div>}
            </div>
            <Cell cell={row.requirement} />
            {hasDesign && <Cell cell={row.design} />}
            <Cell cell={row.kb} />
            <Cell cell={row.script_action} />
            <Cell cell={row.assertion} />
          </div>
        ))}
      </div>
      {data.gaps.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className={EYEBROW}>Work to do on this case</div>
          {data.gaps.map((g: Gap, i) => (
            <div key={i} className="flex flex-wrap items-start gap-2 text-[12.5px]">
              <Chip cls={SEVERITY[g.severity]}>{g.severity}</Chip>
              <span className="font-semibold text-[#1F2937]">{g.label}{g.step_number ? ` · step ${g.step_number}` : ''}</span>
              <span className="min-w-0 flex-1 text-[#4B5563]">{g.detail} <span className="text-[#6B7280]">— {g.action}</span></span>
              <GapAction module={g.module} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// --- Study -----------------------------------------------------------------------

type Tab = 'cases' | 'work' | 'requirements'

const Study: React.FC<{
  studyId: number
  kbApps: { app_id: string; app_name: string }[]
  status: LabStatus | null
  canEdit: boolean
  onDeleted: () => void
  onChanged: (study: StudyBrief) => void
}> = ({ studyId, kbApps, status, canEdit, onDeleted, onChanged }) => {
  const confirm = useConfirm()
  const [study, setStudy] = useState<StudyDetail | null>(null)
  const [error, setError] = useState('')
  const [useAi, setUseAi] = useState(true)
  const [open, setOpen] = useState<number | null>(null)
  const [tab, setTab] = useState<Tab>('cases')
  const [workFilter, setWorkFilter] = useState('all')

  const load = useCallback(async () => {
    try {
      const next = await rndLabService.study(studyId)
      setStudy(next)
      onChanged(next)
      setError('')
    } catch (err) {
      setError(errorText(err, 'The study could not be loaded.'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyId])

  useEffect(() => { setStudy(null); setOpen(null); setTab('cases'); void load() }, [load])

  const live = study?.status === 'analysing' || study?.documents.some((d) => d.status === 'extracting')
  useEffect(() => {
    if (!live) return
    const id = window.setInterval(() => { void load() }, 2500)
    return () => window.clearInterval(id)
  }, [live, load])

  if (error && !study) return <section className={`${CARD} px-6 py-5 text-[13px] text-[#B71920]`}>{error}</section>
  if (!study) return <section className={`${CARD} px-6 py-5 text-[13px] text-[#6B7280]`}>Loading the study…</section>

  const s = study.summary
  const reading = study.documents.some((d) => d.status === 'extracting')
  const analyse = async () => {
    try { await rndLabService.analyse(study.id, useAi); await load() } catch (err) { setError(errorText(err, 'The analysis could not start.')) }
  }
  const remove = async () => {
    const ok = await confirm({
      title: `Delete the study "${study.name}"?`,
      body: 'Its evidence matrices and uploaded documents are deleted from the Lab.',
      consequences: ['Test cases, scripts, BRDs and the Knowledge Base are not touched.'],
      confirmLabel: 'Delete study', tone: 'danger',
    })
    if (!ok) return
    try { await rndLabService.deleteStudy(study.id); onDeleted() } catch (err) { setError(errorText(err, 'Not deleted.')) }
  }
  const pct = study.progress && study.progress.total ? Math.round((100 * study.progress.done) / study.progress.total) : null
  const uncovered = study.requirements.filter((r) => !r.covered_by.length)
  const work = study.work.filter((g) => workFilter === 'all' || g.type === workFilter)
  const workTypes = Array.from(new Set(study.work.map((g) => g.type)))

  return (
    <div className="flex flex-col gap-3">
      <section className={`${CARD} flex flex-col gap-3 px-5 py-4`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="m-0 truncate text-[18px] font-bold text-[#1F2937]">{study.name}</h2>
            <p className="mt-0.5 text-[12px] text-[#6B7280]">
              {study.case_ids ? `${study.case_ids.length} selected cases` : 'All approved automation cases of the project'}
              {study.analysed_at ? ` · analysed ${new Date(study.analysed_at + 'Z').toLocaleString()}` : ' · not analysed yet'}
              {s ? ` · ${s.use_ai ? 'rules + AI' : 'rules only'}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && (
              <label className="flex items-center gap-1.5 text-[12.5px] text-[#374151]" title={status?.llm?.detail || ''}>
                <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} disabled={!status?.llm?.configured} className="accent-[#B71920]" />
                AI judgement {status && !status.llm?.configured && <span className="text-[#9CA3AF]">(no model)</span>}
              </label>
            )}
            {canEdit && (
              <button type="button" className={PRIMARY} disabled={study.status === 'analysing' || reading} onClick={analyse}
                title={reading ? 'Wait for the documents to be read' : ''}>
                {study.status === 'analysing' ? 'Analysing…' : study.analysed_at ? 'Re-analyse' : 'Analyse'}
              </button>
            )}
            {s && <button type="button" className={BTN} onClick={() => rndLabService.downloadGaps(study.id, `rnd-lab-${study.ppm_id || study.project_id}-${study.id}-gaps.csv`)}>Gaps CSV</button>}
            {canEdit && <button type="button" className={BTN} disabled={study.status === 'analysing'} onClick={remove}>Delete</button>}
          </div>
        </div>
        {study.status === 'analysing' && (
          <div>
            <div className="h-1.5 overflow-hidden rounded-full bg-[#F1F2F4]">
              {pct === null
                ? <div className="h-full w-1/3 animate-pulse rounded-full bg-[#D7141C]" />
                : <div className="h-full rounded-full bg-[#D7141C] transition-all" style={{ width: `${Math.max(pct, 3)}%` }} />}
            </div>
            <div className="mt-1 text-[12px] text-[#6B7280]">{study.progress?.message || 'Working…'}</div>
          </div>
        )}
        {(study.status === 'failed' || study.status === 'interrupted') && study.error && (
          <div className="rounded-[10px] border border-[#F6D4D5] bg-[#FFF8F8] px-3 py-2 text-[12.5px] text-[#7A0B0D]">{study.error}</div>
        )}
        {error && <div className="text-[12.5px] text-[#B71920]">{error}</div>}
        {s?.notes?.map((n, i) => <div key={i} className="text-[12px] text-[#9A3412]">{n}</div>)}
      </section>

      <Sources study={study} kbName={kbApps.find((a) => a.app_id === study.kb_app_id)?.app_name} status={status} canEdit={canEdit} onChanged={load} />

      {s && (
        <>
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <Tile label="Cases" value={s.cases} />
            <Tile label="Avg readiness" value={`${s.avg_readiness}`} hint="0–100, from the evidence" />
            <Tile label="Ready" value={s.verdicts.ready || 0} hint={`${s.verdicts.needs_work || 0} need work`} />
            <Tile label="Blocked" value={s.verdicts.blocked || 0} hint={`${s.verdicts.needs_decision || 0} need a BA decision`} />
            <Tile label="Requirements covered" value={`${s.requirements.covered}/${s.requirements.total}`} hint={s.requirements.method === 'ai' ? 'extracted by AI, quotes checked' : 'extracted by rules'} />
            <Tile label="KB elements" value={s.sources.kb_elements} hint={s.sources.kb || 'no KB'} />
          </section>

          <section className={`${CARD} overflow-hidden`}>
            <div className="flex flex-wrap items-center gap-1 border-b border-[#F1F2F4] px-4 pt-3">
              {([['cases', `Cases (${study.case_rows.length})`], ['work', `Work to do (${study.work.length + uncovered.length})`], ['requirements', `Requirements (${study.requirements.length})`]] as [Tab, string][]).map(([key, label]) => (
                <button key={key} type="button" onClick={() => setTab(key)}
                  className={`-mb-px border-b-2 px-3 pb-2.5 text-[13px] font-bold ${tab === key ? 'border-[#B71920] text-[#B71920]' : 'border-transparent text-[#6B7280] hover:text-[#1F2937]'}`}>
                  {label}
                </button>
              ))}
              <div className="ml-auto flex flex-wrap gap-1.5 pb-2">
                {Object.entries(s.gaps).filter(([, n]) => n > 0).map(([type, n]) => (
                  <Chip key={type} cls="bg-[#F4F5F7] text-[#374151]" title={GAP_LABEL[type]}>{GAP_LABEL[type] || type}: {n}</Chip>
                ))}
              </div>
            </div>

            {tab === 'cases' && (
              <div className="overflow-x-auto">
                <div className={`grid min-w-[860px] grid-cols-[110px_minmax(0,1fr)_150px_140px_80px_170px] gap-3 border-b border-[#F4F5F7] px-4 py-2 ${EYEBROW}`}>
                  <span>Case</span><span>Title</span><span>Readiness</span><span>Verdict</span><span>Gaps</span><span>Script</span>
                </div>
                {study.case_rows.map((c) => (
                  <div key={c.test_case_id} className="min-w-[860px] border-b border-[#F4F5F7] last:border-0">
                    <button type="button" onClick={() => setOpen(open === c.test_case_id ? null : c.test_case_id)}
                      className="grid w-full grid-cols-[110px_minmax(0,1fr)_150px_140px_80px_170px] items-center gap-3 px-4 py-2.5 text-left hover:bg-[#FFFBFB]">
                      <span className="text-[12.5px] font-bold text-[#941216]">{open === c.test_case_id ? '▾' : '▸'} {c.display_id}</span>
                      <span className="truncate text-[12.5px] text-[#374151]" title={c.title}>{c.title}</span>
                      <Readiness value={c.readiness} />
                      <span>{c.verdict && <Chip cls={VERDICT[c.verdict]?.cls || ''}>{VERDICT[c.verdict]?.label || c.verdict}</Chip>}</span>
                      <span className="text-[12.5px] text-[#374151]">{c.gaps}{c.high_gaps ? <span className="text-[#B71920]"> ({c.high_gaps} high)</span> : ''}</span>
                      <span className="truncate text-[12px] text-[#6B7280]">{c.script ? `${c.script.framework} · ${c.script.dry_run.replace('_', ' ')}` : 'none'}</span>
                    </button>
                    {open === c.test_case_id && <Matrix studyId={study.id} caseId={c.test_case_id} hasDesign={study.has_design} />}
                  </div>
                ))}
              </div>
            )}

            {tab === 'work' && (
              <div className="flex flex-col">
                <div className="flex items-center gap-2 border-b border-[#F4F5F7] px-4 py-2">
                  <select className={`${FIELD} w-[260px]`} value={workFilter} onChange={(e) => setWorkFilter(e.target.value)}>
                    <option value="all">All gap types</option>
                    {workTypes.map((t) => <option key={t} value={t}>{GAP_LABEL[t] || t}</option>)}
                    <option value="uncovered_requirement">{GAP_LABEL.uncovered_requirement}</option>
                  </select>
                </div>
                {(workFilter === 'all' || workFilter === 'uncovered_requirement') && uncovered.map((r) => (
                  <div key={r.id} className="flex flex-wrap items-start gap-2 border-b border-[#F4F5F7] px-4 py-2 text-[12.5px]">
                    <Chip cls={SEVERITY.medium}>medium</Chip>
                    <span className="font-semibold text-[#1F2937]">Requirement with no test case · {r.id}</span>
                    <span className="min-w-0 flex-1 text-[#4B5563]">{r.statement} <span className="text-[#6B7280]">— add a test case or confirm it is out of scope.</span></span>
                  </div>
                ))}
                {workFilter !== 'uncovered_requirement' && work.map((g, i) => (
                  <div key={i} className="flex flex-wrap items-start gap-2 border-b border-[#F4F5F7] px-4 py-2 text-[12.5px] last:border-0">
                    <Chip cls={SEVERITY[g.severity]}>{g.severity}</Chip>
                    <button type="button" className="font-bold text-[#941216] hover:underline" onClick={() => { setTab('cases'); setOpen(g.test_case_id) }}>{g.display_id}</button>
                    <span className="font-semibold text-[#1F2937]">{g.label}{g.step_number ? ` · step ${g.step_number}` : ''}</span>
                    <span className="min-w-0 flex-1 text-[#4B5563]">{g.detail} <span className="text-[#6B7280]">— {g.action}</span></span>
                    <GapAction module={g.module} />
                  </div>
                ))}
                {!work.length && !uncovered.length && <div className="px-4 py-6 text-[13px] text-[#6B7280]">Nothing left to do.</div>}
              </div>
            )}

            {tab === 'requirements' && (
              <div>
                {!study.requirements.length && <div className="px-4 py-6 text-[13px] text-[#6B7280]">No requirements were found in the study's documents.</div>}
                {study.requirements.map((r) => (
                  <div key={r.id} className="flex flex-wrap items-start gap-2 border-b border-[#F4F5F7] px-4 py-2 text-[12.5px] last:border-0">
                    <span className="w-12 font-mono font-bold text-[#941216]">{r.id}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[#1F2937]">{r.statement}</div>
                      <div className="mt-0.5 text-[11.5px] text-[#6B7280]">
                        {r.doc}{r.page ? ` p.${r.page}` : ''} · {r.kind}
                        {!r.verified && <span className="text-[#9A3412]"> · quote not found in the document</span>}
                      </div>
                    </div>
                    {r.covered_by.length
                      ? <Chip cls="bg-[#E8F6EE] text-[#136B34]" title={r.covered_by.join(', ')}>Covered by {r.covered_by.length}</Chip>
                      : <Chip cls="bg-[#FDEBEC] text-[#B71920]">No test case</Chip>}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
      {!s && study.status !== 'analysing' && (
        <section className={`${CARD} px-6 py-8 text-center text-[13px] text-[#6B7280]`}>
          Add any Figma or other documents above, then press <b className="text-[#1F2937]">Analyse</b> to build the evidence matrix.
        </section>
      )}
    </div>
  )
}

// --- Page ------------------------------------------------------------------------

const RndLab: React.FC = () => {
  const { user } = useAuth()
  const canEdit = hasPermission(user, 'automation.execute')
  const { project, setProject } = useProject()
  const [dialog, setDialog] = useState(false)
  const [status, setStatus] = useState<LabStatus | null>(null)
  const [kbApps, setKbApps] = useState<{ app_id: string; app_name: string }[]>([])
  const [studies, setStudies] = useState<StudyBrief[] | null>(null)
  const [selected, setSelected] = useState<number | 'new' | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    rndLabService.status().then(setStatus).catch((err) => setError(errorText(err, 'The R&D Lab is not available on this server.')))
    rndLabService.kbApps().then(setKbApps).catch(() => setKbApps([]))
  }, [])

  // Project first: ask for it straight away when none is chosen.
  useEffect(() => { if (!project) setDialog(true) }, [project])

  const loadStudies = useCallback(async () => {
    if (!project) { setStudies(null); return }
    try {
      const items = await rndLabService.studies(project.id)
      setStudies(items)
      setSelected((cur) => (cur === 'new' || (cur && items.some((s) => s.id === cur)) ? cur : items[0]?.id ?? 'new'))
    } catch (err) {
      setError(errorText(err, 'The studies could not be loaded.'))
    }
  }, [project])

  useEffect(() => { setSelected(null); void loadStudies() }, [loadStudies])

  const onStudyChanged = useCallback((brief: StudyBrief) => {
    setStudies((prev) => prev?.map((s) => (s.id === brief.id ? { ...s, ...brief } : s)) ?? prev)
  }, [])

  const list = useMemo(() => studies ?? [], [studies])

  return (
    <div className="flex flex-col gap-3">
      <section className={`${CARD} px-6 py-5`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-[#B71920]">AI Test Automation</p>
            <div className="mt-1 flex flex-wrap items-center gap-2.5">
              <h1 className="m-0 text-[27px] font-extrabold leading-tight tracking-[-0.02em] text-[#1F2937]">AI R&amp;D Lab</h1>
              <span className="rounded-full border border-[#F1A4A6] bg-[#FFF5F5] px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[#B71920]">Experimental</span>
            </div>
            <p className="mt-2 max-w-[820px] text-[13.5px] leading-[1.6] text-[#4B5563]">
              Maps each approved automation test case against its BRD, the Figma design, the Knowledge Base and the generated script:
              which steps are backed by evidence, where the sources disagree, and the work still to do. Read-only towards every other module.
            </p>
          </div>
          <ProjectChip onOpen={() => setDialog(true)} />
        </div>
      </section>

      {error && <section className={`${CARD} px-6 py-4 text-[13px] text-[#B71920]`}>{error}</section>}

      {!project && (
        <section className={`${CARD} flex flex-col items-center gap-3 px-6 py-10 text-center`}>
          <h2 className="m-0 text-[17px] font-bold text-[#1F2937]">Start with the project</h2>
          <p className="max-w-[520px] text-[13px] text-[#6B7280]">
            Enter the Project PPM ID and Project Name. The Lab works per project: its approved automation cases, their BRDs and its designs.
          </p>
          <button type="button" className={PRIMARY} onClick={() => setDialog(true)}>Enter project details</button>
        </section>
      )}

      {project && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className={`${CARD} flex h-fit flex-col gap-2 px-3 py-3`}>
            <div className="flex items-center justify-between px-1">
              <span className={EYEBROW}>Studies</span>
              {canEdit && <button type="button" className="text-[12.5px] font-bold text-[#B71920] hover:underline" onClick={() => setSelected('new')}>+ New study</button>}
            </div>
            {studies === null && <div className="px-1 py-2 text-[12.5px] text-[#6B7280]">Loading…</div>}
            {studies !== null && !list.length && <div className="px-1 py-2 text-[12.5px] text-[#6B7280]">No studies for {project.ppm_id} yet.</div>}
            {list.map((s) => (
              <button key={s.id} type="button" onClick={() => setSelected(s.id)}
                className={`flex flex-col gap-1 rounded-[12px] border px-3 py-2 text-left transition ${selected === s.id ? 'border-[#F1A4A6] bg-[#FFF8F8]' : 'border-transparent hover:bg-[#F9FAFB]'}`}>
                <span className="truncate text-[13px] font-bold text-[#1F2937]">{s.name}</span>
                <span className="flex items-center gap-2 text-[11.5px] text-[#6B7280]">
                  {s.status === 'analysing' ? 'Analysing…' : s.status === 'ready' ? `${s.cases ?? 0} cases · readiness ${s.avg_readiness ?? '—'}` : s.status}
                </span>
              </button>
            ))}
          </aside>

          <div className="min-w-0">
            {selected === 'new' && canEdit && (
              <NewStudy projectId={project.id} ppmId={project.ppm_id} kbApps={kbApps}
                onCancel={() => setSelected(list[0]?.id ?? null)}
                onCreated={(s) => { setStudies((prev) => [s, ...(prev ?? [])]); setSelected(s.id) }} />
            )}
            {selected === 'new' && !canEdit && (
              <section className={`${CARD} px-6 py-8 text-center text-[13px] text-[#6B7280]`}>Creating a study needs the automation.execute permission.</section>
            )}
            {typeof selected === 'number' && (
              <Study key={selected} studyId={selected} kbApps={kbApps} status={status} canEdit={canEdit}
                onChanged={onStudyChanged}
                onDeleted={() => { setSelected(null); void loadStudies() }} />
            )}
          </div>
        </div>
      )}

      <ProjectDialog
        open={dialog}
        description="The Lab works per project: its approved automation test cases, their BRDs and its designs."
        onClose={() => setDialog(false)}
        onChosen={(chosen) => { setDialog(false); if (chosen) setProject(chosen) }}
      />
    </div>
  )
}

export default RndLab
