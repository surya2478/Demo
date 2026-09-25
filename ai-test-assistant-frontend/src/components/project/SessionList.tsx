import React from 'react'
import type { SessionSummary } from '../../services/projectService'

// Saved generation sessions for the current project, under the empty Output
// card: what each became (generated, being checked, sent, approved) and a way
// back into any of them.

const CHIP = 'inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-[9px] text-[11.5px] font-semibold'

const when = (iso: string | null) => {
  if (!iso) return ''
  const date = new Date(iso)
  return date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export const sessionState = (item: SessionSummary): { label: string; tone: string } => {
  const checks = item.checks
  if (checks && checks.running > 0) return { label: `AI Checks ${checks.done}/${checks.total}`, tone: 'bg-[#FDEBEC] text-[#941216]' }
  if (item.stage === 'generated') return { label: 'Generated', tone: 'bg-[#F4F5F7] text-[#1F2937]' }
  if (item.stage === 'ai_checks') {
    if (checks && checks.stopped > 0) return { label: `AI Checks stopped · ${checks.done}/${checks.total}`, tone: 'bg-[#FFF4E5] text-[#8A5000]' }
    return { label: 'AI Checks complete', tone: 'bg-[#EAF7EF] text-[#136B34]' }
  }
  const sent = item.pending + item.approved + item.rejected
  if (item.approved && !item.pending) return { label: `${item.approved} approved`, tone: 'bg-[#EAF7EF] text-[#136B34]' }
  if (item.stage === 'partly_sent') return { label: `${sent} of ${item.cases} sent`, tone: 'bg-[#FFF5F5] text-[#941216]' }
  return { label: `${item.pending} pending approval`, tone: 'bg-[#FFF5F5] text-[#941216]' }
}

const SessionList: React.FC<{
  items: SessionSummary[]
  loading: boolean
  scopeLabel: string
  currentUser: string
  onOpen: (requestId: string) => void
}> = ({ items, loading, scopeLabel, currentUser, onOpen }) => (
  <div className="mt-3 border-t border-[#F1F2F4] pt-3">
    <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]">
      Saved sessions <span className="normal-case tracking-normal text-[#9CA3AF]">· {scopeLabel}</span>
    </div>
    {loading ? (
      <div className="py-2 text-[12.5px] text-[#9CA3AF]">Loading…</div>
    ) : items.length === 0 ? (
      <div className="py-2 text-[12.5px] text-[#9CA3AF]">No saved sessions yet. Generated test cases are saved here automatically.</div>
    ) : (
      <div className="overflow-hidden rounded-[14px] border border-[#E8EAEE]">
        {items.map((item) => {
          const state = sessionState(item)
          return (
            <div key={item.request_id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-[#F1F2F4] px-3.5 py-2.5 last:border-b-0">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold text-[#1F2937]" title={item.document_name}>{item.document_name}</div>
                <div className="truncate text-[11.5px] text-[#6B7280]">
                  {item.request_id} · {item.cases} test case{item.cases === 1 ? '' : 's'} · {item.request_by === currentUser ? 'you' : item.request_by} · {when(item.request_date_time)}
                </div>
              </div>
              <span className={`${CHIP} ${state.tone}`}>{state.label}</span>
              <button
                type="button"
                onClick={() => onOpen(item.request_id)}
                disabled={!item.restorable}
                className="flex h-8 items-center rounded-[10px] border border-[#E8EAEE] bg-white px-3 text-[12.5px] font-bold text-[#1F2937] transition hover:border-[#F6D4D5] disabled:opacity-50"
              >
                Open
              </button>
            </div>
          )
        })}
      </div>
    )}
  </div>
)

export default SessionList
