/**
 * --- Delete a project from the Automation Lab ---------------------------------------
 *
 * Careful by construction:
 *   - It first asks the server what would go -- cases, every script version
 *     (and how many were edited by hand), runs with their evidence -- and says
 *     what stays: the project itself and its Review & Approval requests.
 *   - It is refused while any of the project's runs is still going.
 *   - The PPM ID (or "No project") must be typed exactly.
 *   - The server checks all of it again, and refuses if the project gained or
 *     lost cases since the numbers were shown.
 */
import React, { useEffect, useState } from 'react'
import automationService from '../../services/automationService'
import type { ProjectDeletePreview } from '../../types/automation'
import { BTN, Popup, PopupClose } from './labShared'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const DeleteProjectPopup: React.FC<{
  projectKey: string
  /** "7899 - Testing", for the title before the preview arrives. */
  label: string
  canExecute: boolean
  onClose: () => void
  onDeleted: (summary: string) => void
}> = ({ projectKey, label, canExecute, onClose, onDeleted }) => {
  const [preview, setPreview] = useState<ProjectDeletePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let cancelled = false
    automationService
      .previewProjectDelete(projectKey)
      .then(res => { if (!cancelled) setPreview(res) })
      .catch(err => { if (!cancelled) setError(err?.message ?? 'What this would delete could not be worked out.') })
    return () => { cancelled = true }
  }, [projectKey])

  const live = preview?.live_runs.length ?? 0
  const matches = Boolean(preview) && typed.trim() === preview!.confirm_text
  const allowed = canExecute && Boolean(preview) && preview!.cases > 0 && live === 0 && matches && !deleting

  const remove = async () => {
    if (!preview || !allowed) return
    setDeleting(true)
    setError(null)
    try {
      const res = await automationService.deleteProject(projectKey, typed.trim(), preview.cases)
      onDeleted(
        `${label} was deleted from the Automation Lab: ${plural(res.cases_removed, 'case')}, ${plural(res.scripts_removed, 'script version')} and ${plural(res.runs_removed, 'run')} removed.`
      )
    } catch (err: any) {
      setError(err?.message ?? 'The project could not be deleted.')
      setDeleting(false)
      // The server may have refused because something changed: show the current numbers.
      automationService.previewProjectDelete(projectKey).then(setPreview).catch(() => undefined)
    }
  }

  return (
    <Popup label={`Delete ${label}`} width="max-w-[560px]" onClose={onClose} locked={deleting}>
      <div className="flex items-start gap-3 px-5 pb-3 pt-4">
        <span className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[#FEEBEC] text-[#B71920]">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-[15.5px] font-bold text-[#1F2937]">Delete {label} from the Automation Lab?</h2>
          <p className="mt-0.5 text-[12.5px] text-[#6B7280]">This cannot be undone.</p>
        </div>
        <PopupClose onClick={onClose} />
      </div>

      <div className="flex flex-col gap-3 border-t border-[#E8EAEE] px-5 py-4">
        {!preview && !error && <div className="h-[120px] animate-pulse rounded-[12px] bg-[#F4F5F7]" />}
        {preview && (
          <>
            <div className="rounded-[12px] border border-[#F3C2C0] bg-[#FFF8F8] px-3.5 py-3">
              <div className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-[#A3231C]">What is deleted</div>
              <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-[12.5px] text-[#1F2937]">
                <li><b>{plural(preview.cases, 'test case')}</b> in this project</li>
                <li>
                  <b>{plural(preview.scripts, 'script version')}</b> ({preview.current_scripts} current)
                  {preview.edited_scripts > 0 && <span className="font-semibold text-[#B45309]"> — {plural(preview.edited_scripts, 'was', 'were')} edited by hand</span>}
                </li>
                <li><b>{plural(preview.runs, 'run')}</b> with their results and evidence (screenshots, videos, traces, logs)</li>
              </ul>
            </div>
            <div className="rounded-[12px] border border-[#E8EAEE] bg-[#FAFAFB] px-3.5 py-3">
              <div className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-[#6B7280]">What stays</div>
              <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-[12.5px] text-[#374151]">
                <li>{preview.project ? <>The project <b>{preview.project.ppm_id}</b> itself and its requests in Generate Test Cases and Review &amp; Approval</> : 'The requests these cases came from in Review & Approval'}</li>
                <li>Test Data, the Knowledge Base and downloaded scripts</li>
                {preview.from_review > 0 && (
                  <li>{plural(preview.from_review, 'case')} came from Review &amp; Approval; {preview.from_review === 1 ? 'it is' : 'they are'} kept out of the Lab and will not reappear on their own</li>
                )}
              </ul>
            </div>
            {live > 0 && (
              <div role="alert" className="rounded-[12px] border border-[#EBCFA4] bg-[#FFFBF4] px-3.5 py-2.5 text-[12.5px] text-[#8A5000]">
                <b>{plural(live, 'run is', 'runs are')} still going</b> ({preview.live_runs.slice(0, 3).join(', ')}). Wait for {live === 1 ? 'it' : 'them'} to finish or cancel {live === 1 ? 'it' : 'them'} first.
              </div>
            )}
            {preview.cases === 0 && <div className="text-[12.5px] text-[#6B7280]">This project has no cases in the Automation Lab.</div>}
            <label className="block text-[12.5px] text-[#1F2937]">
              Type <code className="rounded bg-[#F4F5F7] px-1.5 py-0.5 font-mono text-[12px] font-bold text-[#B71920]">{preview.confirm_text}</code> to confirm
              <input
                value={typed}
                onChange={e => setTyped(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void remove() }}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                disabled={!canExecute || live > 0 || deleting}
                aria-label="Type the PPM ID to confirm"
                className={`mt-1.5 h-9 w-full rounded-[10px] border px-3 font-mono text-[13px] outline-none ${typed && !matches ? 'border-[#F1A4A6]' : 'border-[#E8EAEE] focus:border-[#F1A4A6]'}`}
              />
            </label>
            {!canExecute && <div className="text-[12px] text-[#6B7280]">Deleting needs the automation.execute permission.</div>}
          </>
        )}
        {error && <div role="alert" className="rounded-[10px] border border-[#F6D4D5] bg-[#FFF8F8] px-3 py-2 text-[12.5px] text-[#7A0B0D]">{error}</div>}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-[#E8EAEE] px-5 py-3">
        <button type="button" onClick={onClose} disabled={deleting} className={BTN}>Cancel</button>
        <button
          type="button"
          onClick={() => void remove()}
          disabled={!allowed}
          className="inline-flex h-9 items-center rounded-[10px] bg-[#B71920] px-3.5 text-[13px] font-bold text-white transition hover:bg-[#9E1218] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {deleting ? 'Deleting…' : 'Delete project'}
        </button>
      </div>
    </Popup>
  )
}

export default DeleteProjectPopup
