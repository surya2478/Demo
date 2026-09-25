import React, { useMemo, useState } from 'react'
import type { CheckBatch, CheckItem, CheckStepName, CheckStepState } from '../../services/aiChecksService'

// Screen 3: AI Checks results, in the Output card. Refine -> Quality Review ->
// Auto-Improve (only when the review did not pass) -> AI Classify.

type Filter = 'all' | 'automation' | 'manual' | 'improved' | 'test_data' | 'not_checked' | 'stopped'

const STAGES: { key: CheckStepName; label: string; letter: string }[] = [
  { key: 'refine', label: '1 · AI Refine', letter: 'R' },
  { key: 'review', label: '2 · Quality Review', letter: 'Q' },
  { key: 'improve', label: '3 · Auto-Improve', letter: 'I' },
  { key: 'classify', label: '4 · AI Classify', letter: 'C' }
]

const CHIP = 'inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-[9px] text-[11.5px] font-semibold'
const C_AUTO = 'bg-[#EAF7EF] text-[#136B34]'
const C_MAN = 'bg-[#F4F5F7] text-[#374151]'
const C_WARN = 'bg-[#FFF4E5] text-[#8A5000]'
const C_BAD = 'bg-[#FEEBEC] text-[#A3231C]'
const C_BRAND = 'bg-[#FFF5F5] text-[#941216]'
const ROW = 'grid grid-cols-[22px_70px_minmax(0,1fr)_104px_90px_130px_150px] items-center gap-3 border-b border-[#F1F2F4] px-4'

const Tick: React.FC<{ size?: number; color?: string; width?: number }> = ({ size = 14, color = '#fff', width = 3 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={width} aria-hidden><path d="M5 12l5 5 9-10" /></svg>
)

const BTN = 'flex h-9 items-center gap-2 whitespace-nowrap rounded-[12px] border border-[#E8EAEE] bg-white px-4 text-[13px] font-bold transition hover:border-[#F6D4D5] disabled:cursor-not-allowed disabled:opacity-50'

/** A case can be selected once nothing is working on it: to send, delete or restart. */
export const isSettled = (item: CheckItem) => item.status === 'done' || item.status === 'failed' || item.status === 'stopped'

const formatElapsed = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

const stageSummary = (batch: CheckBatch, key: CheckStepName) => {
  const p = batch.pipeline[key]
  switch (key) {
    case 'refine':
      return <>{p.done} of {batch.total} structured</>
    case 'review':
      return <>{p.done} scored{p.failed ? <> · <span className="font-semibold text-[#A3231C]">{p.failed} failed</span></> : null}</>
    case 'improve':
      return <>{p.done} improved · {p.skipped} already passed</>
    default:
      return <>{p.done} classified by rule</>
  }
}

// Only a stage something is working on spins. Once the batch is stopped (or
// stopping and this stage has nothing in flight), a stage left part-way shows
// as stopped rather than as still running.
const stageState = (batch: CheckBatch, key: CheckStepName): 'done' | 'running' | 'stopped' | 'pending' => {
  const p = batch.pipeline[key]
  const reached = p.done + p.skipped + p.failed > 0
  if (p.running > 0) return 'running'
  if (p.pending === 0) return reached ? 'done' : 'pending'
  if (batch.status !== 'running' || batch.stopping) return reached ? 'stopped' : 'pending'
  return reached ? 'running' : 'pending'
}

const Dot: React.FC<{ letter: string; state: CheckStepState | 'na' }> = ({ letter, state }) => {
  const cls =
    state === 'done' ? 'bg-[#B71920] text-white'
      : state === 'skipped' ? 'border-[1.5px] border-dashed border-[#C4C8CF] bg-white text-[#9CA3AF]'
        : state === 'failed' ? 'border-[1.5px] border-[#F0C2C0] bg-[#FEEBEC] text-[#A3231C]'
          : state === 'running' ? 'border-2 border-[#F6D4D5] border-t-[#B71920] bg-white text-[#B71920] animate-spin'
            : 'bg-[#F4F5F7] text-[#C4C8CF]'
  const title = { done: 'done', skipped: 'skipped', failed: 'failed', running: 'running', pending: 'waiting', na: 'not run' }[state]
  return (
    <span title={`${letter}: ${title}`} className={`box-border flex h-[18px] w-[18px] items-center justify-center rounded-full text-[9px] font-bold ${cls}`}>
      {state === 'running' ? '' : letter}
    </span>
  )
}

interface AIChecksPanelProps {
  batch: CheckBatch
  now: number
  selected: Set<number>
  onToggle: (checkId: number) => void
  onToggleAll: (checkIds: number[], on: boolean) => void
  onRetry: (checkId: number) => void
  onEdit: (checkId: number) => void
  onSend: () => void
  onDownload: () => void
  onStop: () => void
  onRestart: () => void
  onDelete: () => void
  busy: 'stop' | 'restart' | 'delete' | null
  /** The request the generated cases were saved as. */
  savedAs?: string | null
  sendCount: number
  /** Checks already sent for approval; the rest can still be sent. */
  sentIds: Set<number>
}

const AIChecksPanel: React.FC<AIChecksPanelProps> = ({
  batch, now, selected, onToggle, onToggleAll, onRetry, onEdit, onSend, onDownload, onStop, onRestart, onDelete, busy, savedAs, sendCount, sentIds
}) => {
  const [filter, setFilter] = useState<Filter>('all')
  const s = batch.summary
  const running = batch.status === 'running'
  const started = batch.started_at ? Date.parse(batch.started_at.endsWith('Z') ? batch.started_at : `${batch.started_at}Z`) : now
  const finished = batch.finished_at ? Date.parse(batch.finished_at.endsWith('Z') ? batch.finished_at : `${batch.finished_at}Z`) : now
  const elapsed = formatElapsed((running ? now : finished) - started)
  const doneCount = batch.items.filter((item) => item.status === 'done' || item.status === 'failed').length
  const inFlight = batch.items.filter((item) => item.status === 'running').length
  const restartable = batch.items.filter((item) => item.status === 'stopped' || item.status === 'failed').length
  const deleteCount = batch.items.filter((item) => selected.has(item.check_id) && isSettled(item) && !sentIds.has(item.check_id)).length
  const sentTotal = sentIds.size

  const counts: Record<Filter, number> = {
    all: batch.total,
    automation: s.automation,
    manual: s.manual,
    improved: s.improved,
    test_data: s.test_data_pending,
    not_checked: s.not_checked,
    stopped: s.stopped ?? 0
  }

  const visible = useMemo(() => batch.items.filter((item) => {
    switch (filter) {
      case 'automation': return item.classification === 'automation'
      case 'manual': return item.classification === 'manual'
      case 'improved': return item.improved
      case 'test_data': return item.test_data_pending
      case 'not_checked': return item.status === 'failed'
      case 'stopped': return item.status === 'stopped'
      default: return true
    }
  }), [batch.items, filter])

  const selectable = visible.filter((item) => isSettled(item) && !sentIds.has(item.check_id)).map((item) => item.check_id)
  const allOn = selectable.length > 0 && selectable.every((id) => selected.has(id))
  const firstEditable = batch.items.find((item) => selected.has(item.check_id) && item.status === 'done') ?? batch.items.find((item) => item.status === 'done')

  const filterChip = (key: Filter, label: string, tone: string) => (
    <button
      key={key}
      type="button"
      onClick={() => setFilter(key)}
      aria-pressed={filter === key}
      className={`${CHIP} transition ${filter === key ? 'bg-[#1F2937] text-white' : tone}`}
    >
      {label} {counts[key]}
    </button>
  )

  return (
    <section className="flex flex-col overflow-hidden rounded-[20px] border border-[#E8EAEE] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2.5 px-[22px] pt-4">
        <span className="text-[15px] font-bold text-[#1F2937]">Output</span>
        <span className={`${CHIP} bg-[#F4F5F7] text-[#1F2937]`}>{batch.total} test cases</span>
        {savedAs && (
          <span className={`${CHIP} ${C_AUTO}`} title="Saved when AI Checks started; Send for Approval sends this request">
            <Tick size={11} color="#136B34" width={3.5} />Saved · {savedAs}
          </span>
        )}
        {running && batch.stopping ? (
          <span className={`${CHIP} ${C_WARN}`}>
            <span className="box-border h-2.5 w-2.5 animate-spin rounded-full border-2 border-[#EBCFA4] border-t-[#8A5000]" />
            Stopping · finishing {inFlight} case{inFlight === 1 ? '' : 's'} in progress
          </span>
        ) : running ? (
          <span className={`${CHIP} bg-[#FDEBEC] text-[#941216]`}>
            <span className="h-1.5 w-1.5 rounded-full bg-[#B71920]" />AI Checks running · {doneCount}/{batch.total} · {elapsed}
          </span>
        ) : batch.status === 'stopped' ? (
          <span className={`${CHIP} ${C_WARN}`}>AI Checks stopped · {doneCount}/{batch.total} checked</span>
        ) : (
          <span className={`${CHIP} ${C_AUTO}`}><Tick size={11} color="#136B34" width={3.5} />AI Checks complete · {elapsed}</span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {running ? (
            <button
              type="button"
              onClick={onStop}
              disabled={batch.stopping || busy !== null}
              data-audit-name="Stop AI Checks"
              title="Waiting cases stop now; a case mid-step stops once that step finishes"
              className={`${BTN} text-[#A3231C]`}
            >
              <span className="h-2.5 w-2.5 rounded-[2px] bg-[#B71920]" aria-hidden />
              {batch.stopping || busy === 'stop' ? 'Stopping…' : 'Stop'}
            </button>
          ) : restartable > 0 ? (
            <button
              type="button"
              onClick={onRestart}
              disabled={busy !== null}
              data-audit-name="Restart AI Checks"
              title="Check the stopped and failed cases again; finished cases keep their results"
              className={`${BTN} text-[#1F2937]`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1F2937" strokeWidth="2" aria-hidden><path d="M4 12a8 8 0 1 0 2.3-5.7" /><path d="M4 4v4h4" /></svg>
              {busy === 'restart' ? 'Restarting…' : `Restart ${restartable}`}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => firstEditable && onEdit(firstEditable.check_id)}
            disabled={!firstEditable}
            className="flex h-9 items-center gap-2 rounded-[12px] border border-[#E8EAEE] bg-white px-4 text-[13px] font-bold text-[#1F2937] transition hover:border-[#F6D4D5] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1F2937" strokeWidth="1.8" aria-hidden><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
            Edit steps
          </button>
          <button
            type="button"
            onClick={onDownload}
            className="flex h-9 items-center rounded-[12px] border border-[#E8EAEE] bg-white px-4 text-[13px] font-bold text-[#1F2937] transition hover:border-[#F6D4D5]"
          >
            Download
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={deleteCount === 0 || busy !== null}
            data-audit-name="Delete AI Checks cases"
            title={deleteCount === 0 ? 'Select the cases to delete' : 'Remove the selected cases from this batch'}
            className={`${BTN} text-[#A3231C]`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
            {busy === 'delete' ? 'Deleting…' : deleteCount ? `Delete ${deleteCount}` : 'Delete'}
          </button>
          <button
            type="button"
            onClick={onSend}
            // Finished cases can go while the rest are still being checked.
            disabled={sendCount === 0}
            data-audit-name="Send for Approval"
            className={`flex h-9 items-center gap-2 whitespace-nowrap rounded-[12px] px-4 text-[13px] font-bold transition ${
              sendCount === 0 && sentTotal > 0
                ? 'cursor-not-allowed border border-[#F1A4A6] bg-white text-[#B71920]'
                : sendCount === 0
                  ? 'cursor-not-allowed bg-[#F4F5F7] text-[#9CA3AF]'
                  : 'bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] hover:opacity-95'
            }`}
          >
            {sendCount === 0 && sentTotal > 0 ? `${sentTotal} TCs Pending Approval` : `Send ${sendCount} for Approval`}
            {(sendCount > 0 || sentTotal === 0) && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>}
          </button>
        </div>
      </div>

      {/* Pipeline */}
      <div className="mx-[22px] mt-3.5 flex flex-wrap items-center gap-3.5 rounded-[16px] border border-[#F6D4D5] bg-[linear-gradient(90deg,#FFF8F8,#FFFFFF_75%)] px-[18px] py-3.5">
        {STAGES.map((stage, index) => {
          const state = stageState(batch, stage.key)
          return (
            <React.Fragment key={stage.key}>
              {index > 0 && (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F1A4A6" strokeWidth="2" aria-hidden><path d="M9 6l6 6-6 6" /></svg>
              )}
              <div className="flex min-w-[180px] flex-1 items-center gap-2.5">
                {state === 'done' ? (
                  <div className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-full bg-[#B71920]"><Tick /></div>
                ) : state === 'running' ? (
                  <div className="box-border h-[30px] w-[30px] flex-shrink-0 animate-spin rounded-full border-[3px] border-[#F6D4D5] border-t-[#B71920]" />
                ) : state === 'stopped' ? (
                  <div title="Stopped part-way" className="box-border flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center gap-[3px] rounded-full border-2 border-[#EBCFA4] bg-[#FFFBF4]">
                    <span className="h-2.5 w-[3px] rounded-sm bg-[#8A5000]" /><span className="h-2.5 w-[3px] rounded-sm bg-[#8A5000]" />
                  </div>
                ) : (
                  <div className="box-border flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-full border-2 border-[#D6D9DF] text-[12px] font-bold text-[#9CA3AF]">{index + 1}</div>
                )}
                <div>
                  <div className="text-[13px] font-bold text-[#1F2937]">{stage.label}</div>
                  <div className="text-[12px] text-[#6B7280]">{stageSummary(batch, stage.key)}</div>
                </div>
              </div>
            </React.Fragment>
          )
        })}
      </div>

      {/* Outcome tiles */}
      <div className="mx-[22px] mt-3 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <div className="rounded-[16px] border border-[#BBDFC8] bg-[#F5FBF7] px-3.5 py-3">
          <div className="flex items-baseline gap-2"><span className="text-[24px] font-extrabold leading-none tracking-[-0.02em] text-[#136B34]">{s.automation}</span><span className="text-[13px] font-bold text-[#1F2937]">Automation</span></div>
          <div className="mt-1.5 text-[12px] text-[#6B7280]">Go to Automation Lab once the manager approves</div>
        </div>
        <div className="rounded-[16px] border border-[#E8EAEE] bg-[#FCFCFD] px-3.5 py-3">
          <div className="flex items-baseline gap-2"><span className="text-[24px] font-extrabold leading-none tracking-[-0.02em] text-[#1F2937]">{s.manual}</span><span className="text-[13px] font-bold text-[#1F2937]">Manual</span></div>
          <div className="mt-1.5 text-[12px] text-[#6B7280]">
            {s.needs_minor_changes ? `Includes ${s.needs_minor_changes} that need minor changes to automate` : 'Stay with the manual test team'}
          </div>
        </div>
        <div className="rounded-[16px] border border-[#E8EAEE] bg-[#FCFCFD] px-3.5 py-3">
          <div className="flex items-baseline gap-2">
            <span className="text-[24px] font-extrabold leading-none tracking-[-0.02em] text-[#1F2937]">{s.avg_after ?? '—'}</span>
            <span className="text-[13px] font-bold text-[#1F2937]">Avg quality</span><span className="text-[12px] text-[#6B7280]">/ 5</span>
          </div>
          <div className="mt-1.5 text-[12px] text-[#6B7280]">
            {s.avg_before != null && s.avg_after != null ? `Up from ${s.avg_before} before AI Checks` : 'Scored by Quality Review'}
          </div>
        </div>
        <div className="rounded-[16px] border border-[#EBCFA4] bg-[#FFFBF4] px-3.5 py-3">
          <div className="flex items-baseline gap-2"><span className="text-[24px] font-extrabold leading-none tracking-[-0.02em] text-[#8A5000]">{s.test_data_pending + s.not_checked}</span><span className="text-[13px] font-bold text-[#1F2937]">Need a look</span></div>
          <div className="mt-1.5 text-[12px] text-[#6B7280]">{s.test_data_pending} missing test data · {s.not_checked} not checked</div>
        </div>
      </div>

      {/* Filters */}
      <div className="mx-[22px] mb-2.5 mt-3.5 flex flex-wrap items-center gap-1.5">
        {filterChip('all', 'All', 'bg-[#F4F5F7] text-[#1F2937]')}
        {filterChip('automation', 'Automation', C_AUTO)}
        {filterChip('manual', 'Manual', C_MAN)}
        {filterChip('improved', 'Improved by AI', C_BRAND)}
        {filterChip('test_data', 'Test data pending', C_WARN)}
        {filterChip('not_checked', 'Not checked', C_BAD)}
        {counts.stopped > 0 && filterChip('stopped', 'Stopped', C_WARN)}
        <span className="ml-auto flex items-center gap-2.5 text-[12px] text-[#6B7280]">
          <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-full bg-[#B71920]" />done</span>
          <span className="flex items-center gap-1"><span className="box-border h-3 w-3 rounded-full border-[1.5px] border-dashed border-[#C4C8CF]" />skipped</span>
          <span className="flex items-center gap-1"><span className="box-border h-3 w-3 rounded-full border-[1.5px] border-[#F0C2C0] bg-[#FEEBEC]" />failed</span>
        </span>
      </div>

      {/* Table */}
      <div className="mx-[22px] mb-4 overflow-hidden rounded-[16px] border border-[#E8EAEE]">
        <div className="max-h-[520px] overflow-auto">
          <div className="min-w-[860px]">
            <div className={`${ROW} sticky top-0 z-10 h-9 border-b-[#F6D4D5] bg-[#F4F5F7] text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1F2937]`}>
              <input
                type="checkbox"
                aria-label="Select all cases"
                title="Select all"
                checked={allOn}
                disabled={selectable.length === 0}
                onChange={() => onToggleAll(selectable, !allOn)}
                className="h-4 w-4 accent-[#B71920]"
              />
              <span>TC ID</span><span>Title</span><span>AI Checks</span><span>Quality</span><span>Classification</span><span>Flags</span>
            </div>
            {visible.map((item) => <Row key={item.check_id} item={item} selected={selected.has(item.check_id)} sent={sentIds.has(item.check_id)} canRetry={!batch.stopping && busy === null} onToggle={onToggle} onRetry={onRetry} onEdit={onEdit} />)}
            {visible.length === 0 && <div className="px-4 py-6 text-center text-[13px] text-[#6B7280]">No test cases match this filter.</div>}
          </div>
        </div>
      </div>
    </section>
  )
}

const Row: React.FC<{
  item: CheckItem
  selected: boolean
  sent: boolean
  canRetry: boolean
  onToggle: (id: number) => void
  onRetry: (id: number) => void
  onEdit: (id: number) => void
}> = ({ item, selected, sent, canRetry, onToggle, onRetry, onEdit }) => {
  const failed = item.status === 'failed'
  const stopped = item.status === 'stopped'
  const finished = item.status === 'done'
  const stepState = (key: CheckStepName): CheckStepState | 'na' => {
    const state = item.steps?.[key] ?? 'pending'
    return (failed || stopped) && state === 'pending' ? 'na' : state
  }
  const before = item.score_before
  const after = item.score_after

  return (
    <div className={`${ROW} h-[46px] text-[13px] text-[#1F2937] ${failed ? 'bg-[#FFFAFA]' : ''}`}>
      <input
        type="checkbox"
        aria-label={`Select ${item.display_id}`}
        checked={selected}
        disabled={!isSettled(item) || sent}
        onChange={() => onToggle(item.check_id)}
        className="h-4 w-4 accent-[#B71920]"
      />
      <span className="font-semibold">{item.display_id}</span>
      <button
        type="button"
        onClick={() => finished && !sent && onEdit(item.check_id)}
        disabled={!finished || sent}
        title={finished ? 'Open to edit steps' : item.title ?? ''}
        className="truncate text-left hover:text-[#B71920] disabled:hover:text-inherit"
      >
        {item.title}
      </button>
      <span className="flex items-center gap-[5px]">
        {STAGES.map((stage) => <Dot key={stage.key} letter={stage.letter} state={stepState(stage.key)} />)}
      </span>
      <span>
        {after != null ? (
          <>
            {item.improved && before != null && before !== after && <span className="text-[#9CA3AF] line-through">{before.toFixed(1)}</span>}{' '}
            <strong>{after.toFixed(1)}</strong>
          </>
        ) : before != null ? <strong>{before.toFixed(1)}</strong> : <span className="text-[#9CA3AF]">—</span>}
      </span>
      <span>
        {failed ? <span className={`${CHIP} ${C_BAD}`}>Not checked</span>
          : stopped ? <span className={`${CHIP} ${C_WARN}`}>Stopped</span>
          : item.classification === 'automation' ? <span className={`${CHIP} ${C_AUTO}`}>Automation</span>
            : item.classification === 'manual' ? <span className={`${CHIP} ${C_MAN}`}>Manual</span>
              : <span className="text-[12px] text-[#9CA3AF]">{item.status === 'queued' ? 'Waiting' : 'Checking…'}</span>}
      </span>
      <span className="flex min-w-0 items-center gap-2">
        {failed ? (
          <>
            <span className="text-[11.5px] text-[#A3231C]" title={item.error ?? ''}>Stays here</span>
            <button type="button" onClick={() => onRetry(item.check_id)} disabled={!canRetry || sent} className="text-[12px] font-bold text-[#B71920] hover:text-[#941216] disabled:opacity-40">Retry</button>
          </>
        ) : stopped ? (
          <button type="button" onClick={() => onRetry(item.check_id)} disabled={!canRetry || sent} className="text-[12px] font-bold text-[#B71920] hover:text-[#941216] disabled:opacity-40">Restart</button>
        ) : sent ? (
          <span className={`${CHIP} ${C_AUTO}`}><Tick size={11} color="#136B34" width={3.5} />Sent for approval</span>
        ) : item.test_data_pending ? (
          <span className={`${CHIP} ${C_WARN}`} title={item.test_data_notes ?? ''}>Test data pending</span>
        ) : item.improved ? (
          <span className={`${CHIP} ${C_BRAND}`}>Improved</span>
        ) : item.classification_detail === 'partial' ? (
          <span className="truncate text-[11.5px] text-[#6B7280]">Needs minor changes</span>
        ) : item.classification === 'manual' ? (
          <span className="truncate text-[11.5px] text-[#6B7280]" title={item.classification_reason ?? ''}>{shortReason(item.classification_reason)}</span>
        ) : null}
      </span>
    </div>
  )
}

const shortReason = (reason: string | null) => {
  if (!reason) return ''
  const first = reason.split(/[.;:]/)[0].trim()
  return first.length > 28 ? `${first.slice(0, 27)}…` : first
}

export default AIChecksPanel
