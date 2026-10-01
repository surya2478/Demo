import React, { useState } from 'react'
import knowledgeBaseService, { type ScreenElementDetail } from '../../services/knowledgeBaseService'
import { useConfirm } from '../ui/ConfirmDialog'
import { FIELD, ICON, PLAIN_BTN } from './kbEdit'
import { Failed, Loading, useLoad } from './kbUi'

// One design screen's elements, opened from the App Model: relabel one the
// extraction misread, or delete one that is not on the screen. Each edit is a
// change set like every other Knowledge Base edit.

type Run = (what: string, edit: (publish: boolean) => Promise<any>, after?: () => void) => Promise<boolean>

const ElementRow: React.FC<{
  element: ScreenElementDetail
  canEdit: boolean
  busy: boolean
  publish: boolean
  onRelabel: (label: string) => Promise<boolean>
  onDelete: () => void
}> = ({ element, canEdit, busy, publish, onRelabel, onDelete }) => {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(element.label ?? '')
  return (
    <div className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-[#F1F2F4] px-4 py-2 text-[12.5px]">
      {editing ? (
        <form className="flex items-center gap-1.5" onSubmit={async e => { e.preventDefault(); if (await onRelabel(label)) setEditing(false) }}>
          <input autoFocus aria-label={`New label for ${element.element_id}`} value={label} onChange={e => setLabel(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') setEditing(false) }} className={FIELD} />
          <button type="submit" disabled={busy || !label.trim()} className="h-[30px] flex-shrink-0 rounded-[8px] bg-[#B71920] px-2.5 text-[12px] font-bold text-white disabled:opacity-50">
            {publish ? 'Save' : 'Draft'}
          </button>
          <button type="button" className={PLAIN_BTN} onClick={() => { setEditing(false); setLabel(element.label ?? '') }}>Cancel</button>
        </form>
      ) : (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span>
            <strong>{element.label ?? element.element_id}</strong>
            <code className="ml-2 text-[11px] text-[#6B7280]">{element.element_id}</code>
            {element.type && <span className="ml-2 text-[11px] text-[#9CA3AF]">{element.type}</span>}
          </span>
          <span className="text-[11.5px] text-[#6B7280]">
            {element.used_by.length
              ? `Used by ${element.used_by.map(u => `${u.name} step ${u.step_number}`).join(', ')}`
              : 'No journey step uses it'}
            {element.automation_ref && <> · linked to <code className="text-[11px]">{element.automation_ref}</code></>}
          </span>
        </span>
      )}
      {canEdit && !editing && (
        <span className="flex gap-1 opacity-60 group-hover:opacity-100">
          <button type="button" className={ICON} title="Relabel" aria-label={`Relabel ${element.element_id}`} onClick={() => setEditing(true)}>✎</button>
          <button type="button" className={`${ICON} hover:text-[#A3231C]`} title="Delete element" aria-label={`Delete ${element.element_id}`} onClick={onDelete}>✕</button>
        </span>
      )}
    </div>
  )
}

const ScreenElementsPanel: React.FC<{
  appKey: string
  screenId: string
  canEdit: boolean
  busy: boolean
  publish: boolean
  run: Run
  onChanged: () => void
}> = ({ appKey, screenId, canEdit, busy, publish, run, onChanged }) => {
  const confirm = useConfirm()
  const [detail, error, reload] = useLoad(`${appKey}:${screenId}`, () => knowledgeBaseService.screen(appKey, screenId))
  const after = () => { reload(); onChanged() }

  const remove = async (element: ScreenElementDetail) => {
    const ok = await confirm({
      title: `Delete “${element.label ?? element.element_id}” from ${screenId}?`,
      consequences: [
        element.used_by.length
          ? `${element.used_by.length} journey step${element.used_by.length === 1 ? '' : 's'} keep the screen but lose this element: ${element.used_by.map(u => `${u.name} step ${u.step_number}`).join(', ')}.`
          : 'No journey step uses it.',
        element.automation_ref ? `Its link to ${element.automation_ref} in the Automation KB goes with it.` : 'It is not linked to the Automation KB.',
        publish ? 'Published now; History can revert it.' : 'Saved for review; nothing changes until it is approved.'
      ],
      confirmLabel: publish ? 'Delete element' : 'Save deletion for review',
      tone: 'danger'
    })
    if (ok) await run('Element deletion', p => knowledgeBaseService.removeElement(appKey, screenId, element.element_id, p), after)
  }

  if (error) return <Failed message={error} onRetry={reload} />
  if (!detail) return <Loading what="the elements" />
  return (
    <div className="rounded-[12px] border border-[#E8EAEE] bg-white">
      <div className="px-4 py-2 text-[11px] font-bold tracking-[0.1em] text-[#6B7280]">ELEMENTS · {detail.elements.length}</div>
      {detail.elements.length === 0 && <p className="m-0 border-t border-[#F1F2F4] px-4 py-3 text-[12.5px] text-[#6B7280]">No elements catalogued for this screen.</p>}
      {detail.elements.map(element => (
        <ElementRow
          key={element.element_id}
          element={element}
          canEdit={canEdit}
          busy={busy}
          publish={publish}
          onRelabel={label => run('Element label', p => knowledgeBaseService.relabelElement(appKey, screenId, element.element_id, label, p), after)}
          onDelete={() => void remove(element)}
        />
      ))}
    </div>
  )
}

export default ScreenElementsPanel
