/**
 * --- AI Checks on Review & Approval, in the Test Assistant's own panel ---------------
 *
 * The batch a manager started, shown with the same AIChecksPanel (pipeline,
 * per-case progress, Retry, Stop, Restart) and the same StepEditor the Test
 * Assistant uses. Nothing to send: each case's results are written onto its
 * review case as its check finishes, so the panel's Send for Approval and
 * Delete are left out. Closing the popup leaves the checks running.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import AIChecksPanel from '../test-assistant/AIChecksPanel'
import StepEditor from '../test-assistant/StepEditor'
import { reviewChecksService } from '../../services/reviewService'
import type { CheckBatch, EditedStep } from '../../services/aiChecksService'

const ReviewChecksPopup: React.FC<{
  batchId: string
  /** "REQ-… · 7899" in the title. */
  label: string
  onClose: () => void
  /** The batch moved on: the review page reloads its cases. */
  onChanged: () => void
}> = ({ batchId, label, onClose, onChanged }) => {
  const [batch, setBatch] = useState<CheckBatch | null>(null)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [busy, setBusy] = useState<'stop' | 'restart' | 'delete' | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState('')
  // How many cases had finished at the last look: the review page reloads when it moves.
  const doneRef = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await reviewChecksService.get(batchId)
      const doneNow = next.items.filter((i) => i.status === 'done' || i.status === 'failed').length
      if (doneRef.current !== null && doneNow !== doneRef.current) onChanged()
      doneRef.current = doneNow
      setBatch(next)
      setError('')
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'The AI Checks could not be loaded.')
    }
  }, [batchId, onChanged])

  useEffect(() => { void refresh() }, [refresh])
  const running = Boolean(batch && batch.items.some((i) => i.status === 'queued' || i.status === 'running'))
  useEffect(() => {
    if (!running) return
    const poll = window.setInterval(() => void refresh(), 3000)
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    return () => { window.clearInterval(poll); window.clearInterval(tick) }
  }, [running, refresh])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const act = async (which: 'stop' | 'restart', fn: () => Promise<void>) => {
    setBusy(which)
    try {
      await fn()
      await refresh()
      onChanged()
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'That did not work.')
    } finally {
      setBusy(null)
    }
  }

  const saveSteps = async (steps: EditedStep[]) => {
    if (editing === null) return
    setSaving(true)
    setEditError('')
    try {
      await reviewChecksService.saveSteps(batchId, editing, steps)
      setEditing(null)
      await refresh()
      onChanged()
    } catch (err: any) {
      setEditError(err?.response?.data?.detail || 'The steps could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const editingItem = batch && editing !== null ? batch.items.find((i) => i.check_id === editing) ?? null : null

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-[rgba(17,24,39,0.42)] px-4 pb-6 pt-[6vh]"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose() }}
      role="dialog"
      aria-modal="true"
      aria-label={`AI Checks · ${label}`}
    >
      <div className="flex w-full max-w-[1180px] flex-col gap-2">
        <div className="flex items-center justify-between rounded-[14px] bg-white px-4 py-2.5 shadow-[0_12px_32px_rgba(16,24,40,0.14)]">
          <div className="min-w-0">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[#6B7280]">AI Checks · {label}</div>
            <div className="text-[12px] text-[#6B7280]">Results are applied to each review case as it finishes. Closing this leaves the checks running.</div>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-full border border-[#E8EAEE] text-[#6B7280] hover:bg-[#F4F5F7]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        {error && <div role="alert" className="rounded-[12px] border border-[#F6D4D5] bg-[#FFF8F8] px-4 py-2.5 text-[13px] text-[#7A0B0D]">{error}</div>}
        {!batch ? (
          <div className="rounded-[20px] bg-white px-6 py-10 text-[13px] text-[#6B7280]">Loading the AI Checks…</div>
        ) : editingItem ? (
          <StepEditor
            key={editingItem.check_id}
            item={editingItem}
            totalCases={batch.total}
            saving={saving}
            error={editError}
            onCancel={() => { setEditing(null); setEditError('') }}
            onSave={(steps) => void saveSteps(steps)}
          />
        ) : (
          <AIChecksPanel
            title="AI Checks"
            batch={batch}
            now={now}
            selected={selected}
            onToggle={(id) => setSelected((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n })}
            onToggleAll={(ids, on) => setSelected((cur) => { const n = new Set(cur); ids.forEach((id) => (on ? n.add(id) : n.delete(id))); return n })}
            onRetry={(checkId) => void act('restart', () => reviewChecksService.retry(batchId, checkId))}
            onEdit={(checkId) => { setEditError(''); setEditing(checkId) }}
            onStop={() => void act('stop', () => reviewChecksService.stop(batchId))}
            onRestart={() => void act('restart', () => reviewChecksService.restart(batchId))}
            busy={busy}
          />
        )}
      </div>
    </div>
  )
}

export default ReviewChecksPopup
