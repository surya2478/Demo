import React, { useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { publishEnvironments, reloadEnvironments, useEnvironments } from '../hooks/useEnvironments'
import testDataService, { environmentLabel, type ManagedEnvironment } from '../services/testDataService'

// Manage environments: add, rename, reorder and delete the one list every
// environment choice offers (Generate Test Cases, Test Data, an application's
// addresses, the Workbench). The server renames a name everywhere it is
// stored and refuses a delete that would make something fall back unseen.

const FIELD = 'h-9 rounded-[10px] border border-[#E8EAEE] bg-white px-3 text-[13px] text-[#1F2937] outline-none focus:border-[#F1A4A6]'
const BTN = 'h-8 rounded-[8px] border border-[#E8EAEE] bg-white px-2.5 text-[12px] font-semibold text-[#1F2937] hover:border-[#F6D4D5] disabled:cursor-not-allowed disabled:opacity-40'
const PRIMARY = 'h-9 rounded-[10px] bg-[#B71920] px-4 text-[13px] font-bold text-white hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50'

const errorOf = (err: any): string => err?.response?.data?.detail || err?.message || 'That did not work.'
const counts = (usage: Record<string, number>) => Object.entries(usage).map(([what, n]) => `${n} ${what}`).join(', ')

/** Editing is automation.execute (the server enforces it; this only shapes the dialog). */
const useCanEdit = (): boolean => {
  const { user } = useAuth() as { user: any }
  if (!user) return false
  const roles: string[] = (user.roles as string[]) || (user.role ? [user.role] : [])
  if (roles.some(r => String(r).toLowerCase() === 'admin')) return true
  return ((user.permissions as string[]) || []).includes('automation.execute')
}

const Row: React.FC<{
  env: ManagedEnvironment
  first: boolean
  last: boolean
  canEdit: boolean
  busy: boolean
  onMove: (dir: -1 | 1) => void
  onRename: (to: string) => Promise<boolean>
  onDelete: (removeData: boolean) => Promise<boolean>
}> = ({ env, first, last, canEdit, busy, onMove, onRename, onDelete }) => {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(env.name)
  const [confirming, setConfirming] = useState(false)
  const data = Object.fromEntries(Object.entries(env.usage).filter(([k]) => ['test data values', 'application addresses', 'crawl targets'].includes(k)))
  const hasData = Object.keys(data).length > 0
  return (
    <li className="border-t border-[#F1F2F4] py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        {editing ? (
          <form className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={async e => { e.preventDefault(); if (await onRename(name)) setEditing(false) }}>
            <input aria-label={`New name for ${env.name}`} autoFocus value={name} maxLength={40} className={`${FIELD} w-[160px] uppercase`}
              onChange={e => setName(e.target.value.toUpperCase())} />
            <button type="submit" className={BTN} disabled={busy || !name.trim() || name.trim() === env.name}>Save</button>
            <button type="button" className={BTN} onClick={() => { setEditing(false); setName(env.name) }}>Cancel</button>
          </form>
        ) : (
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold text-[#1F2937]">
              {env.label}{env.label !== env.name && <span className="ml-1.5 font-mono text-[11.5px] font-normal text-[#6B7280]">{env.name}</span>}
            </div>
            <div className="text-[11.5px] text-[#6B7280]">{Object.keys(env.usage).length ? `Used by ${counts(env.usage)}` : 'Not used yet'}</div>
          </div>
        )}
        {canEdit && !editing && (
          <div className="flex items-center gap-1">
            <button type="button" className={BTN} aria-label={`Move ${env.name} up`} title="Move up" disabled={busy || first} onClick={() => onMove(-1)}>↑</button>
            <button type="button" className={BTN} aria-label={`Move ${env.name} down`} title="Move down" disabled={busy || last} onClick={() => onMove(1)}>↓</button>
            <button type="button" className={BTN} disabled={busy} onClick={() => { setEditing(true); setConfirming(false) }}
              title="Rename it everywhere: values, addresses, defaults, test cases and run history">Rename</button>
            <button type="button" className={`${BTN} text-[#A3231C]`} disabled={busy || env.blocked.length > 0}
              title={env.blocked.length ? `Cannot delete: ${env.blocked.join('; ')}` : 'Delete this environment'}
              onClick={() => (hasData ? setConfirming(true) : void onDelete(false))}>Delete</button>
          </div>
        )}
      </div>
      {env.blocked.length > 0 && canEdit && !editing && (
        <div className="mt-1 text-[11.5px] text-[#8A5000]">Cannot be deleted: {env.blocked.join('; ')}.</div>
      )}
      {editing && Object.keys(env.usage).length > 0 && (
        <div className="mt-1 text-[11.5px] text-[#6B7280]">Renamed everywhere it is used: {counts(env.usage)}.</div>
      )}
      {confirming && (
        <div role="alert" className="mt-2 rounded-[10px] border border-[#F6D4D5] bg-[#FFF8F8] p-2.5 text-[12px] text-[#7A0B0D]">
          Deleting {env.label} also deletes its {counts(data)}. This cannot be undone.
          <div className="mt-2 flex gap-2">
            <button type="button" className={`${BTN} border-[#B71920] text-[#B71920]`} disabled={busy}
              onClick={async () => { if (await onDelete(true)) setConfirming(false) }}>Delete {env.label} and its data</button>
            <button type="button" className={BTN} onClick={() => setConfirming(false)}>Keep it</button>
          </div>
        </div>
      )}
    </li>
  )
}

export const ManageEnvironmentsDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const canEdit = useCanEdit()
  const { list } = useEnvironments()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)

  const act = async (action: () => Promise<string | null>): Promise<boolean> => {
    setBusy(true)
    setMessage(null)
    try {
      const text = await action()
      if (text) setMessage({ tone: 'ok', text })
      return true
    } catch (err) {
      setMessage({ tone: 'bad', text: errorOf(err) })
      return false
    } finally {
      setBusy(false)
    }
  }
  const names = list?.map(e => e.name) ?? []
  const move = (index: number, dir: -1 | 1) => act(async () => {
    const next = [...names]
    const [item] = next.splice(index, 1)
    next.splice(index + dir, 0, item)
    publishEnvironments(await testDataService.reorderEnvironments(next))
    return null
  })

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(17,24,39,0.45)] p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div role="dialog" aria-modal="true" aria-label="Manage environments"
        className="flex max-h-[90vh] w-full max-w-[560px] flex-col overflow-hidden rounded-[20px] border border-[#E8EAEE] bg-white shadow-[0_24px_60px_rgba(16,24,40,0.22)]">
        <div className="border-b border-[#F1F2F4] px-6 pb-4 pt-5">
          <h2 className="m-0 text-[16px] font-bold text-[#1F2937]">Manage environments</h2>
          <p className="mt-0.5 text-[12.5px] text-[#6B7280]">
            One list for Generate Test Cases, Test Data, application addresses and the Workbench, in release order.
            A rename follows everywhere the name is stored.
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
          {!list ? <div className="py-4 text-[13px] text-[#6B7280]">Loading environments…</div> : (
            <ul className="m-0 list-none p-0">
              {list.map((env, i) => (
                <Row key={env.name} env={env} first={i === 0} last={i === list.length - 1} canEdit={canEdit} busy={busy}
                  onMove={dir => void move(i, dir)}
                  onRename={to => act(async () => {
                    const r = await testDataService.renameEnvironment(env.name, to)
                    publishEnvironments(r.environments)
                    const changed = counts(r.changed)
                    return `${env.name} is now ${to.trim().toUpperCase()}${changed ? ` (updated ${changed})` : ''}.`
                  })}
                  onDelete={removeData => act(async () => {
                    const r = await testDataService.deleteEnvironment(env.name, removeData)
                    publishEnvironments(r.environments)
                    const removed = counts(r.removed)
                    return `${env.label} deleted${removed ? `, with ${removed}` : ''}.`
                  })} />
              ))}
            </ul>
          )}
          {message && (
            <div role={message.tone === 'bad' ? 'alert' : 'status'}
              className={`mt-2 rounded-[10px] border px-3 py-2 text-[12.5px] ${message.tone === 'bad' ? 'border-[#F6D4D5] bg-[#FFF8F8] text-[#7A0B0D]' : 'border-[#CDEBD8] bg-[#F3FBF6] text-[#136B34]'}`}>
              {message.text}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#F1F2F4] bg-[#FCFCFD] px-6 py-3.5">
          {canEdit ? (
            <form className="flex items-center gap-2"
              onSubmit={e => {
                e.preventDefault()
                const value = name.trim().toUpperCase()
                if (!value) return
                void act(async () => {
                  publishEnvironments(await testDataService.addEnvironment(value))
                  setName('')
                  return `${environmentLabel(value)} added.`
                })
              }}>
              <input aria-label="New environment" value={name} maxLength={40} placeholder="e.g. UAT2" className={`${FIELD} w-[150px] uppercase`}
                onChange={e => setName(e.target.value.toUpperCase())} />
              <button type="submit" className={PRIMARY} disabled={busy || !name.trim()}>Add</button>
            </form>
          ) : <span className="text-[12px] text-[#6B7280]">Changing the list needs the automation.execute permission.</span>}
          <button type="button" className={`${BTN} h-9 px-4`} onClick={() => { void reloadEnvironments(); onClose() }}>Done</button>
        </div>
      </div>
    </div>
  )
}

/** A small "Manage" link that opens the dialog; place it next to an environment choice. */
export const ManageEnvironmentsButton: React.FC<{ className?: string; label?: string }> = ({ className, label = 'Manage environments' }) => {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className={className ?? 'text-[12px] font-semibold text-[#1D4ED8] hover:underline'}>{label}</button>
      {open && <ManageEnvironmentsDialog onClose={() => setOpen(false)} />}
    </>
  )
}

export default ManageEnvironmentsButton
