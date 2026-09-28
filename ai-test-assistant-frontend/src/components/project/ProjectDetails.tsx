import React, { useEffect, useRef, useState } from 'react'
import projectService, { type Project } from '../../services/projectService'
import { useProject } from '../../context/ProjectContext'

// "Project Details +" on Generate Test Cases, and the window it opens: PPM ID
// and Project Name. A PPM ID that already exists opens that project, so
// everyone on it shares one record and one name.

const FIELD = 'h-10 w-full rounded-[12px] border border-[#E8EAEE] bg-white px-3 text-[13.5px] text-[#1F2937] outline-none transition focus:border-[#F1A4A6] focus:ring-2 focus:ring-[#FDEBEC]'

export interface ProjectDialogProps {
  open: boolean
  /** Asked before Generate: offers going on without a project. */
  gate?: boolean
  initialPpmId?: string
  /** A name to start from, e.g. the one found in the BRD. */
  initialName?: string
  /** Opened to change the current project: starts from it and can rename it. */
  editCurrent?: boolean
  onClose: () => void
  onChosen: (project: Project | null) => void
}

export const ProjectDialog: React.FC<ProjectDialogProps> = ({ open, gate, initialPpmId, initialName, editCurrent, onClose, onChosen }) => {
  const { project: current } = useProject()
  const [ppmId, setPpmId] = useState('')
  const [name, setName] = useState('')
  const [found, setFound] = useState<Project | null>(null)
  const [recent, setRecent] = useState<Project[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ppmRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    setPpmId(editCurrent && current ? current.ppm_id : initialPpmId || '')
    setName(editCurrent && current ? current.name : initialName || '')
    setFound(null)
    setError('')
    projectService.list().then(setRecent).catch(() => setRecent([]))
    window.setTimeout(() => ppmRef.current?.focus(), 30)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPpmId, initialName, editCurrent])

  // An existing PPM ID fills its name, and the name is then its own -- except
  // the current project's, which can be corrected here.
  useEffect(() => {
    if (!open) return
    const value = ppmId.trim()
    if (value.length < 2) { setFound(null); return }
    const id = window.setTimeout(() => {
      projectService.byPpm(value)
        .then((project) => {
          setFound(project)
          if (project && project.id !== current?.id) setName(project.name)
        })
        .catch(() => setFound(null))
    }, 300)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ppmId, open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  const isCurrent = Boolean(found && current && found.id === current.id)

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!ppmId.trim() || !name.trim()) {
      setError('Enter both the PPM ID and the Project Name.')
      return
    }
    setBusy(true)
    setError('')
    try {
      if (isCurrent && found) {
        onChosen(name.trim() === found.name ? found : await projectService.rename(found.id, found.ppm_id, name.trim()))
        return
      }
      onChosen(await projectService.createOrOpen(ppmId.trim(), name.trim()))
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'The project could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  const others = recent.filter((item) => item.id !== current?.id).slice(0, 6)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(17,24,39,0.45)] p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-dialog-title"
        onSubmit={submit}
        className="w-full max-w-[520px] overflow-hidden rounded-[20px] border border-[#E8EAEE] bg-white shadow-[0_24px_60px_rgba(16,24,40,0.22)]"
      >
        <div className="flex items-start gap-3 border-b border-[#F1F2F4] px-6 pb-4 pt-5">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px] bg-[#FDEBEC]">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#B71920" strokeWidth="1.8" aria-hidden><path d="M3 7h6l2 2h10v10H3z" /></svg>
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="project-dialog-title" className="m-0 text-[16px] font-bold text-[#1F2937]">Project Details</h2>
            <p className="mt-0.5 text-[12.5px] text-[#6B7280]">
              {gate
                ? 'Choose the project these test cases are for. It stays with them through AI Checks, approval and Automation Studio.'
                : 'Test cases generated from now on belong to this project, through AI Checks, approval and Automation Studio.'}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-[10px] text-[#6B7280] hover:bg-[#F4F5F7]">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <div className="flex flex-col gap-4 px-6 py-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]">Project PPM ID</span>
            <input ref={ppmRef} value={ppmId} onChange={(e) => setPpmId(e.target.value)} placeholder="e.g. PPM-12345" className={FIELD} maxLength={100} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]">Project Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. B2B Portal Trade Licence"
              disabled={Boolean(found) && !isCurrent}
              className={`${FIELD} disabled:bg-[#F9FAFB] disabled:text-[#374151]`}
              maxLength={255}
            />
          </label>
          {found && !isCurrent && (
            <div className="rounded-[12px] border border-[#BBDFC8] bg-[#F5FBF7] px-3.5 py-2.5 text-[12.5px] text-[#136B34]">
              {found.ppm_id} already exists — you'll join it and see everyone's sessions for it.
            </div>
          )}
          {error && <div className="rounded-[12px] border border-[#F6D4D5] bg-[#FFF8F8] px-3.5 py-2.5 text-[12.5px] text-[#7A0B0D]" role="alert">{error}</div>}

          {others.length > 0 && (
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]">Recent projects</div>
              <div className="flex flex-wrap gap-1.5">
                {others.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onChosen(item)}
                    className="inline-flex h-7 max-w-full items-center gap-1 truncate rounded-full border border-[#E8EAEE] bg-white px-2.5 text-[12px] font-semibold text-[#1F2937] transition hover:border-[#F6D4D5] hover:bg-[#FFF8F8]"
                    title={`${item.ppm_id} · ${item.name}`}
                  >
                    <span className="text-[#941216]">{item.ppm_id}</span>
                    <span className="truncate font-normal text-[#6B7280]">{item.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-[#F1F2F4] bg-[#FCFCFD] px-6 py-3.5">
          {gate && (
            <button type="button" onClick={() => onChosen(null)} className="text-[12.5px] font-semibold text-[#6B7280] hover:text-[#1F2937] hover:underline">
              Continue without a project
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={onClose} className="flex h-9 items-center rounded-[12px] border border-[#E8EAEE] bg-white px-4 text-[13px] font-bold text-[#1F2937] hover:border-[#F6D4D5]">
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="flex h-9 items-center rounded-[12px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-4 text-[13px] font-bold text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] disabled:opacity-60"
            >
              {busy ? 'Saving…' : found && !isCurrent ? `Use ${found.ppm_id}` : gate ? 'Save & Generate' : 'Save project'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

/** The chip, or the "+" to add one, for a page header. */
export const ProjectChip: React.FC<{ onOpen: () => void; compact?: boolean; fromBrd?: boolean }> = ({ onOpen, compact, fromBrd }) => {
  const { project } = useProject()
  if (!project) {
    return (
      <button
        type="button"
        onClick={onOpen}
        data-audit-name="Add project details"
        className="flex h-9 items-center gap-2 whitespace-nowrap rounded-[12px] border border-dashed border-[#F1A4A6] bg-[#FFF8F8] px-3 text-[13px] font-bold text-[#B71920] transition hover:bg-[#FDEBEC]"
      >
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#B71920] text-white">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
        </span>
        Project Details
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      title={fromBrd ? 'Found in the BRD · click to correct it' : 'Change project'}
      data-audit-name="Change project"
      className={`flex h-9 min-w-0 max-w-full items-center gap-2 rounded-[12px] border border-[#E8EAEE] bg-white px-3 text-[13px] transition hover:border-[#F6D4D5] ${compact ? '' : 'max-w-[420px]'}`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#B71920" strokeWidth="1.8" className="flex-shrink-0" aria-hidden><path d="M3 7h6l2 2h10v10H3z" /></svg>
      <span className="font-bold text-[#941216]">{project.ppm_id}</span>
      <span className="truncate text-[#374151]">{project.name}</span>
      {fromBrd && <span className="flex-shrink-0 rounded-full bg-[#FFF4E5] px-1.5 py-0.5 text-[10.5px] font-semibold text-[#8A5000]">from BRD</span>}
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth="1.8" className="flex-shrink-0" aria-hidden><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
    </button>
  )
}
