import React, { useEffect, useState } from 'react'
import knowledgeBaseService, { errorText, type ChangeSet, type KbImpact, type KbValue, type KbVersionRow } from '../../services/knowledgeBaseService'
import ImpactSummary from './ImpactSummary'
import { Chip, Note } from './kbUi'

// Review queue and history for one application's Knowledge Bases. Nothing is
// written to a Knowledge Base until a change set here is approved, and every
// approval is a version that History can revert.

type Tab = 'review' | 'history'

const STATUS_TONE: Record<string, 'warn' | 'good' | 'idle' | 'bad'> = {
  draft: 'warn', conflicted: 'bad', published: 'good', rejected: 'idle'
}

const when = (iso: string | null) => (iso ? new Date(iso.endsWith('Z') ? iso : `${iso}Z`).toLocaleString() : '—')

const show = (v: KbValue | null | undefined) => {
  if (!v || !v.present) return <span className="italic text-[#9CA3AF]">absent</span>
  const value = v.value
  if (typeof value === 'string') return <span>‘{value}’</span>
  if (value === null) return <span className="italic text-[#9CA3AF]">empty</span>
  return <code className="whitespace-pre-wrap break-all text-[11px]">{JSON.stringify(value, null, 1)}</code>
}

const ChangeSetCard: React.FC<{
  summary: ChangeSet
  canDecide: boolean
  onDone: (message: string, published: boolean) => void
}> = ({ summary, canDecide, onDone }) => {
  const [full, setFull] = useState<ChangeSet | null>(null)
  const [impact, setImpact] = useState<KbImpact | null>(null)
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pending = summary.status === 'draft' || summary.status === 'conflicted'

  useEffect(() => {
    if (open && !full) knowledgeBaseService.changeSet(summary.id).then(setFull).catch(err => setError(errorText(err)))
  }, [open, full, summary.id])
  // What approving would touch -- Journey KB drafts only; the heal after approval uses the same analysis.
  useEffect(() => {
    if (open && pending && summary.kb === 'journey' && summary.kind !== 'defect' && !impact) {
      knowledgeBaseService.changeSetImpact(summary.id).then(setImpact).catch(() => undefined)
    }
  }, [open, pending, summary.id, summary.kb, summary.kind, impact])

  const act = async (what: 'approve' | 'reject' | 'discard') => {
    setBusy(what)
    setError(null)
    try {
      if (what === 'approve') {
        const result = await knowledgeBaseService.approve(summary.id, note)
        onDone(result.version
          ? `Published as ${summary.kb === 'journey' ? 'Journey' : 'Automation'} KB version ${result.version.number}.${result.heal_id ? ' The affected test cases were re-diffed; follow-ups are on the Change & Heal stage.' : ''}`
          : 'Decision recorded.', true)
      } else if (what === 'reject') {
        await knowledgeBaseService.reject(summary.id, note)
        onDone('Change set rejected.', false)
      } else {
        await knowledgeBaseService.discard(summary.id)
        onDone('Draft discarded.', false)
      }
    } catch (err) {
      setError(errorText(err))
      setFull(null)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={`rounded-[14px] border p-3.5 ${summary.status === 'conflicted' ? 'border-[#F0C2C0] bg-[#FFFAFA]' : 'border-[#E8EAEE] bg-white'}`}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} className="flex w-full items-start justify-between gap-3 text-left">
        <span className="flex min-w-0 flex-col gap-1">
          <strong className="text-[13px] text-[#1F2937]">{summary.title}</strong>
          <span className="text-[11.5px] text-[#6B7280]">
            #{summary.id} · {summary.kb === 'journey' ? 'Journey KB' : 'Automation KB'} · from {summary.source}
            {summary.kind === 'defect' ? ' · defect, no file changes' : ` · ${summary.change_count} change${summary.change_count === 1 ? '' : 's'}`}
            {' · '}{summary.created_by ?? 'unknown'} · {when(summary.created_at)}
          </span>
        </span>
        <Chip tone={STATUS_TONE[summary.status] ?? 'idle'}>{summary.status}</Chip>
      </button>

      {open && (
        <div className="mt-3 flex flex-col gap-2.5">
          {summary.description && <p className="m-0 text-[12.5px] text-[#4B5563]">{summary.description}</p>}
          {impact && (
            <div className="rounded-[10px] border border-[#EBCFA4] bg-[#FFFBF4] p-2.5">
              <div className="mb-1.5 text-[12px] font-bold text-[#8A5000]">If approved, this touches</div>
              <ImpactSummary impact={impact} compact />
            </div>
          )}
          {full?.changes?.map((c, i) => (
            <div key={i} className="rounded-[10px] border border-[#F1F2F4] bg-[#FCFCFD] p-2.5 text-[12px]">
              <div className="mb-1.5 break-all text-[11px] text-[#6B7280]"><code>{c.file}</code> · <code>{c.path}</code>{c.note ? ` — ${c.note}` : ''}</div>
              <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
                <span className="font-semibold text-[#A3231C]">before</span><span className="min-w-0">{show(c.before)}</span>
                <span className="font-semibold text-[#136B34]">after</span><span className="min-w-0">{c.op === 'remove' ? <span className="italic text-[#9CA3AF]">removed</span> : show(c.after)}</span>
              </div>
            </div>
          ))}
          {summary.decision_note && <Note>Decision note: {summary.decision_note}</Note>}
          {error && <Note tone="warn">{error}</Note>}
          {pending && (
            <div className="flex flex-col gap-2">
              <label className="text-[12px] font-semibold text-[#374151]" htmlFor={`note-${summary.id}`}>Note (optional)</label>
              <input id={`note-${summary.id}`} value={note} onChange={e => setNote(e.target.value)} className="h-9 rounded-[10px] border border-[#E8EAEE] px-3 text-[13px]" />
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void act('approve')} disabled={!canDecide || busy !== null}
                  title={canDecide ? 'Write these changes to the files and record a version' : 'Needs the automation.approve permission'}
                  className="h-9 rounded-[12px] bg-[#B71920] px-4 text-[13px] font-bold text-white hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50">
                  {busy === 'approve' ? 'Publishing…' : summary.kind === 'defect' ? 'Record defect' : 'Approve & publish'}
                </button>
                <button type="button" onClick={() => void act('reject')} disabled={!canDecide || busy !== null}
                  className="h-9 rounded-[12px] border border-[#E8EAEE] bg-white px-4 text-[13px] font-bold text-[#1F2937] disabled:cursor-not-allowed disabled:opacity-50">
                  {busy === 'reject' ? 'Rejecting…' : 'Reject'}
                </button>
                <button type="button" onClick={() => void act('discard')} disabled={busy !== null}
                  className="h-9 rounded-[12px] px-3 text-[13px] font-bold text-[#A3231C] hover:underline disabled:opacity-50">
                  {busy === 'discard' ? 'Discarding…' : 'Discard draft'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const ChangeSetsDrawer: React.FC<{
  appKey: string
  tab: Tab
  onTab: (tab: Tab) => void
  onClose: () => void
  /** Called after anything that changed the files, so the page reloads. */
  onPublished: () => void
  /** Called after anything that changed the queue. */
  onQueueChanged: () => void
  canDecide: boolean
}> = ({ appKey, tab, onTab, onClose, onPublished, onQueueChanged, canDecide }) => {
  const [sets, setSets] = useState<ChangeSet[] | null>(null)
  const [versions, setVersions] = useState<KbVersionRow[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reverting, setReverting] = useState<number | null>(null)
  const [showDone, setShowDone] = useState(false)

  const load = React.useCallback(() => {
    setError(null)
    knowledgeBaseService.changeSets(appKey).then(r => setSets(r.change_sets)).catch(err => setError(errorText(err)))
    knowledgeBaseService.versions(appKey).then(setVersions).catch(err => setError(errorText(err)))
  }, [appKey])
  useEffect(load, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pending = (sets ?? []).filter(s => s.status === 'draft' || s.status === 'conflicted')
  const decided = (sets ?? []).filter(s => s.status === 'published' || s.status === 'rejected')

  const revert = async (v: KbVersionRow) => {
    setReverting(v.id)
    setError(null)
    try {
      const undo = await knowledgeBaseService.revert(v.id)
      setMessage(`Version ${v.number} reverted; the files are restored as version ${undo.number}.`)
      onPublished()
      load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setReverting(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20" role="dialog" aria-modal="true" aria-label="Knowledge Base change sets" onClick={onClose}>
      <div className="flex h-full w-full max-w-[560px] flex-col bg-[#F6F7F9] shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-[#E8EAEE] bg-white px-5 py-4">
          <div>
            <h2 className="m-0 text-[17px] font-bold text-[#1F2937]">Change sets</h2>
            <p className="m-0 text-[12px] text-[#6B7280]">Nothing reaches a Knowledge Base until it is approved here</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-[#E8EAEE] bg-white text-[18px] leading-none text-[#374151]">×</button>
        </div>
        <div role="tablist" className="flex gap-1 border-b border-[#E8EAEE] bg-white px-4">
          {([['review', `Review ${pending.length}`], ['history', `History ${versions?.length ?? ''}`]] as [Tab, string][]).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => onTab(id)}
              className={`h-10 border-b-2 px-3 text-[13px] ${tab === id ? 'border-[#B71920] font-bold text-[#1F2937]' : 'border-transparent text-[#6B7280]'}`}>
              {label}
            </button>
          ))}
        </div>

        <div className="flex flex-1 flex-col gap-3 overflow-auto p-4">
          {message && <Note>{message}</Note>}
          {error && <Note tone="warn">{error}</Note>}
          {!canDecide && tab === 'review' && <Note>You can review and discard drafts. Approving or rejecting needs the automation.approve permission.</Note>}

          {tab === 'review' && (
            <>
              {sets === null && <p className="text-[13px] text-[#6B7280]">Loading…</p>}
              {sets && pending.length === 0 && <Note>No change set is waiting. Reconcile decisions, PDF extraction and crawls create them.</Note>}
              {pending.map(s => (
                <ChangeSetCard key={s.id} summary={s} canDecide={canDecide}
                  onDone={(text, published) => { setMessage(text); load(); onQueueChanged(); if (published) onPublished() }} />
              ))}
              {decided.length > 0 && (
                <button type="button" onClick={() => setShowDone(v => !v)} className="w-fit text-[12.5px] font-bold text-[#B71920] hover:underline">
                  {showDone ? 'Hide' : 'Show'} {decided.length} decided
                </button>
              )}
              {showDone && decided.map(s => <ChangeSetCard key={s.id} summary={s} canDecide={false} onDone={() => undefined} />)}
            </>
          )}

          {tab === 'history' && (
            <>
              {versions === null && <p className="text-[13px] text-[#6B7280]">Loading…</p>}
              {versions && versions.length === 0 && <Note>No version has been published yet.</Note>}
              {versions?.map(v => (
                <div key={v.id} className="flex items-start justify-between gap-3 rounded-[14px] border border-[#E8EAEE] bg-white p-3.5">
                  <div className="flex min-w-0 flex-col gap-1 text-[12.5px]">
                    <strong className="text-[13px]">{v.kb === 'journey' ? 'Journey' : 'Automation'} KB v{v.number}</strong>
                    <span className="text-[#4B5563]">{v.summary}</span>
                    <span className="text-[11.5px] text-[#6B7280]">{v.published_by ?? 'unknown'} · {when(v.published_at)} · {v.files.join(', ')}</span>
                  </div>
                  {v.reverted_by_version_id ? (
                    <Chip tone="idle">reverted</Chip>
                  ) : (
                    <button type="button" onClick={() => void revert(v)} disabled={!canDecide || reverting !== null}
                      title={canDecide ? 'Restore the files this version changed' : 'Needs the automation.approve permission'}
                      className="h-8 flex-shrink-0 rounded-[10px] border border-[#E8EAEE] bg-white px-3 text-[12.5px] font-bold text-[#1F2937] disabled:cursor-not-allowed disabled:opacity-50">
                      {reverting === v.id ? 'Reverting…' : 'Revert'}
                    </button>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default ChangeSetsDrawer
