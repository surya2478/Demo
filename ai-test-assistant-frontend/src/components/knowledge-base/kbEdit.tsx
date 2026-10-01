import React, { useCallback, useState } from 'react'
import type { JourneyEditResult } from '../../services/knowledgeBaseService'
import { useToast } from '../ui/Toast'

// Shared by every Journey KB editor: whether an approver's edits are
// published at once or left for review (one preference, remembered in this
// browser), and how a saved edit is reported.

const PUBLISH_KEY = 'kb_publish_edits_now'

const readPreference = (): boolean => {
  try {
    return window.localStorage.getItem(PUBLISH_KEY) !== 'false'
  } catch {
    return true
  }
}

export function useKbEdit(canApprove: boolean, onEdited?: () => void) {
  const toast = useToast()
  const [publishNow, setPublishNowState] = useState(readPreference)
  const [busy, setBusy] = useState(false)
  const publish = canApprove && publishNow

  const setPublishNow = useCallback((value: boolean) => {
    setPublishNowState(value)
    try {
      window.localStorage.setItem(PUBLISH_KEY, String(value))
    } catch {
      // storage unavailable: the choice lasts for this visit
    }
  }, [])

  /** Run an edit; report it; true when it was saved. */
  const run = useCallback(async (what: string, edit: (publish: boolean) => Promise<JourneyEditResult>, after?: () => void) => {
    setBusy(true)
    try {
      const result = await edit(publish)
      if (result.published) {
        toast.success(`${what} published`, result.version ? `Journey KB version ${result.version.number}.` : undefined)
      } else {
        toast.info(`${what} saved for review`, result.message ?? `Change set #${result.change_set.id} is waiting under Review change sets.`)
      }
      after?.()
      onEdited?.()
      return true
    } catch (error: any) {
      const detail = error?.response?.data?.detail
      toast.error(`${what} failed`, typeof detail === 'string' ? detail : detail?.message ?? error?.message)
      return false
    } finally {
      setBusy(false)
    }
  }, [publish, toast, onEdited])

  return { publish, publishNow, setPublishNow, busy, run }
}

export const PublishToggle: React.FC<{ canApprove: boolean; publishNow: boolean; onChange: (value: boolean) => void }> = ({ canApprove, publishNow, onChange }) =>
  canApprove ? (
    <label className="flex items-center gap-2 text-[11.5px] text-[#4B5563]">
      <input type="checkbox" checked={publishNow} onChange={e => onChange(e.target.checked)} className="accent-[#B71920]" />
      Publish edits immediately <span className="text-[#9CA3AF]">(off: save for review)</span>
    </label>
  ) : (
    <span className="text-[11.5px] text-[#6B7280]">Edits are saved for review by an approver.</span>
  )

export const EDIT_BTN = 'h-[30px] flex-shrink-0 rounded-[10px] bg-[#B71920] px-3 text-[12.5px] font-bold text-white hover:opacity-95 disabled:opacity-50'
export const PLAIN_BTN = 'h-[30px] flex-shrink-0 rounded-[10px] border border-[#E8EAEE] bg-white px-3 text-[12.5px] font-bold text-[#1F2937] hover:border-[#F6D4D5] disabled:opacity-50'
export const FIELD = 'w-full rounded-[8px] border border-[#E8EAEE] bg-white px-2.5 py-1.5 text-[12.5px] focus:border-[#B71920] focus:outline-none'
export const ICON = 'flex h-7 w-7 items-center justify-center rounded-[8px] border border-[#E8EAEE] bg-white text-[13px] text-[#374151] hover:border-[#F6D4D5] hover:text-[#B71920] disabled:cursor-not-allowed disabled:opacity-35'

/** The bar above an editor: what is being edited, and Cancel / Save. */
export const EditorBar: React.FC<{ title: React.ReactNode; busy: boolean; publish: boolean; invalid?: string | null; onCancel: () => void; onSave: () => void }> = ({ title, busy, publish, invalid, onCancel, onSave }) => (
  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#F1F2F4] bg-[#FFFCF7] px-5 py-2.5 text-[12.5px]">
    <span className="text-[#4B5563]">{title}</span>
    <span className="flex items-center gap-2">
      {invalid && <span className="text-[11.5px] text-[#A3231C]">{invalid}</span>}
      <button type="button" onClick={onCancel} disabled={busy} className={PLAIN_BTN}>Cancel</button>
      <button type="button" onClick={onSave} disabled={busy || !!invalid} className={EDIT_BTN}>
        {busy ? 'Saving…' : publish ? 'Save & publish' : 'Save for review'}
      </button>
    </span>
  </div>
)

/** The strip above a read-only list with its Edit button. */
export const EditStrip: React.FC<{ hint: string; label: string; onEdit: () => void }> = ({ hint, label, onEdit }) => (
  <div className="flex items-center justify-between gap-2 border-b border-[#F1F2F4] px-5 py-2 text-[12px] text-[#6B7280]">
    <span>{hint}</span>
    <button type="button" onClick={onEdit} className={EDIT_BTN}>{label}</button>
  </div>
)
