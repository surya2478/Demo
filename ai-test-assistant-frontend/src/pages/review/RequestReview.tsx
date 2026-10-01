import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { usePageHeader } from '../../components/layout/PageHeaderContext'
import JourneyBar from '../../components/test-assistant/JourneyBar'
import reviewService, {
  ageLabel, aiOf, sourceGroupOf, caseDisplayId, caseTitle, detailOf, diffSteps, splitSteps,
  type RequestSummary, type ReviewCase
} from '../../services/reviewService'
import { inferCaseType } from '../../components/test-assistant/GenerationOutput'

// Screen 5: review a request case by case. The manager sees what the AI
// changed, why a case is Automation or Manual, and whether test data is
// missing, then approves -- in bulk for the Automation-ready ones. Read-only:
// authors edit steps before sending, so there is one final version.

type Filter = 'all' | 'automation' | 'manual' | 'improved' | 'test_data'
type View = 'ai' | 'original' | 'compare'

const CARD = 'rounded-[20px] border border-[#E8EAEE] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]'
const CHIP = 'inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-[9px] text-[11.5px] font-semibold'
const LBL = 'text-[10px] font-semibold uppercase tracking-[0.16em] text-[#6B7280]'
const TODO = /(<<TODO:[^>]*>>)/

const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="box-border inline-flex h-5 min-w-[20px] items-center justify-center rounded-[6px] border border-[#D6D9DF] bg-white px-[5px] text-[11px] font-bold text-[#374151] shadow-[0_1px_0_#D6D9DF]">{children}</span>
)

const withTodos = (text: string) => text.split(TODO).map((part, index) =>
  TODO.test(part)
    ? <span key={index} className="rounded-[6px] border border-[#EBCFA4] bg-white px-[5px] py-px font-mono text-[11.5px] text-[#8A5000]">{part}</span>
    : <React.Fragment key={index}>{part}</React.Fragment>
)

const StatusIcon: React.FC<{ status: string }> = ({ status }) =>
  status === 'APPROVED' ? (
    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#EAF7EF]" title="Approved"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#136B34" strokeWidth="3.5" aria-hidden><path d="M5 12l5 5 9-10" /></svg></span>
  ) : status === 'REJECTED' ? (
    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#FEEBEC]" title="Rejected"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#A3231C" strokeWidth="3.5" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg></span>
  ) : (
    <span className="box-border h-5 w-5 rounded-full border-[1.5px] border-dashed border-[#C4C8CF]" title="Waiting" />
  )

const DIMENSIONS: { key: 'step_quality' | 'data_readiness' | 'expected_result_clarity' | 'coverage'; label: string }[] = [
  { key: 'step_quality', label: 'Step quality' },
  { key: 'data_readiness', label: 'Data readiness' },
  { key: 'expected_result_clarity', label: 'Expected results' },
  { key: 'coverage', label: 'Coverage vs source' }
]

const RequestReview: React.FC = () => {
  const { requestId = '' } = useParams()
  const navigate = useNavigate()
  const [summary, setSummary] = useState<RequestSummary | null>(null)
  const [cases, setCases] = useState<ReviewCase[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [view, setView] = useState<View>('compare')
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const reasonRef = useRef<HTMLInputElement | null>(null)

  const load = useCallback(async () => {
    try {
      const detail = await reviewService.detail(requestId)
      setSummary(detail.data)
      setCases(detail.test_cases)
      setError('')
      setCurrentId((current) => current ?? (detail.test_cases.find((c) => c.status === 'PENDING') ?? detail.test_cases[0])?.test_case_id ?? null)
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'This request could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [requestId])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60000)
    return () => window.clearInterval(id)
  }, [])

  const counts = useMemo(() => ({
    all: cases.length,
    automation: cases.filter((c) => aiOf(c)?.classification === 'automation').length,
    manual: cases.filter((c) => aiOf(c)?.classification === 'manual').length,
    improved: cases.filter((c) => aiOf(c)?.improved).length,
    test_data: cases.filter((c) => aiOf(c)?.test_data_pending).length
  }), [cases])

  const visible = useMemo(() => cases.filter((c) => {
    const ai = aiOf(c)
    switch (filter) {
      case 'automation': return ai?.classification === 'automation'
      case 'manual': return ai?.classification === 'manual'
      case 'improved': return Boolean(ai?.improved)
      case 'test_data': return Boolean(ai?.test_data_pending)
      default: return true
    }
  }), [cases, filter])

  const current = cases.find((c) => c.test_case_id === currentId) ?? null
  const approved = cases.filter((c) => c.status === 'APPROVED').length
  const rejected = cases.filter((c) => c.status === 'REJECTED').length
  const decided = approved + rejected
  const pendingCases = cases.filter((c) => c.status === 'PENDING')
  const automationReady = pendingCases.filter((c) => aiOf(c)?.classification === 'automation')
  const bulkTargets = selected.size > 0 ? pendingCases.filter((c) => selected.has(c.test_case_id)) : automationReady

  const moveBy = useCallback((step: number) => {
    if (!visible.length) return
    const index = Math.max(0, visible.findIndex((c) => c.test_case_id === currentId))
    const next = visible[Math.min(visible.length - 1, Math.max(0, index + step))]
    setCurrentId(next.test_case_id)
    setReason('')
  }, [visible, currentId])

  const decide = useCallback(async (decision: 'APPROVE' | 'REJECT', targets: ReviewCase[], notes?: string) => {
    if (!targets.length) return
    setBusy(true)
    try {
      await reviewService.decide(
        requestId,
        decision,
        targets.map((c) => ({ test_case_id: c.test_case_id, ...(decision === 'REJECT' ? { rejection_reason: notes } : {}) })),
        notes
      )
      setSelected(new Set())
      setReason('')
      await load()
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'The decision could not be saved.')
    } finally {
      setBusy(false)
    }
  }, [requestId, load])

  const approveCurrent = useCallback(async () => {
    if (!current || busy) return
    await decide('APPROVE', [current])
    // Approve & next: the next case still waiting, after this one.
    const order = visible.map((c) => c.test_case_id)
    const start = order.indexOf(current.test_case_id)
    const next = [...order.slice(start + 1), ...order.slice(0, start)].find((id) => cases.find((c) => c.test_case_id === id)?.status === 'PENDING')
    if (next) setCurrentId(next)
  }, [current, busy, decide, visible, cases])

  const rejectCurrent = useCallback(async () => {
    if (!current || busy) return
    if (!reason.trim()) {
      reasonRef.current?.focus()
      setError('A reason is needed to reject a test case.')
      return
    }
    await decide('REJECT', [current], reason.trim())
  }, [current, busy, reason, decide])

  const rejectTargets = selected.size > 0 ? pendingCases.filter((c) => selected.has(c.test_case_id)) : pendingCases

  const rejectRequest = useCallback(async () => {
    if (!reason.trim()) {
      reasonRef.current?.focus()
      setError(`Give a reason in the box below to reject the ${selected.size > 0 ? 'selected' : 'remaining'} test cases.`)
      return
    }
    await decide('REJECT', rejectTargets, reason.trim())
  }, [reason, decide, rejectTargets, selected.size])

  // Keyboard: A approve & next, R reject, J / K next / previous.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'a') { event.preventDefault(); void approveCurrent() }
      else if (key === 'r') { event.preventDefault(); void rejectCurrent() }
      else if (key === 'j') { event.preventDefault(); moveBy(1) }
      else if (key === 'k') { event.preventDefault(); moveBy(-1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [approveCurrent, rejectCurrent, moveBy])

  const docName = summary
    ? (summary.brd_document as any)?.map?.((d: any) => d?.name).filter(Boolean).join(' | ') || summary.document_id || summary.request_id
    : requestId
  const sourceLabel = summary ? sourceGroupOf(summary) : ''

  usePageHeader({
    eyebrow: (
      <span className="normal-case tracking-normal text-[11px] font-semibold text-[#6B7280]">
        <Link to="/manager-review" className="text-[#941216] hover:underline">Review &amp; Approval</Link>
        {' / '}{summary?.project ? <strong className="text-[#941216]">{summary.project.ppm_id} · {summary.project.name} · </strong> : null}{requestId}{sourceLabel ? ` · ${sourceLabel}` : ''}{summary?.request_by ? ` · sent by ${summary.request_by}` : ''}
        {summary?.request_date_time ? ` ${ageLabel(summary.request_date_time, now)}` : ''}
      </span>
    ),
    title: docName,
    showSearch: false,
    contentKey: `${requestId}|${summary?.request_by ?? ''}|${bulkTargets.length}|${rejectTargets.length}|${selected.size}|${pendingCases.length}|${busy}|${Math.floor(now / 60000)}`,
    actions: (
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => void rejectRequest()}
          disabled={busy || rejectTargets.length === 0}
          className="flex h-9 items-center rounded-[12px] border border-[#E8EAEE] bg-white px-3.5 text-[13px] font-bold text-[#A3231C] transition hover:border-[#F0C2C0] disabled:opacity-50"
        >
          {selected.size > 0 ? `Reject ${rejectTargets.length} selected` : 'Reject request'}
        </button>
        <button
          type="button"
          onClick={() => void decide('APPROVE', bulkTargets)}
          disabled={busy || bulkTargets.length === 0}
          className="flex h-9 items-center gap-2 rounded-[12px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-3.5 text-[13px] font-bold text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" aria-hidden><path d="M5 12l5 5 9-10" /></svg>
          {selected.size > 0 ? `Approve ${bulkTargets.length} selected` : `Approve ${bulkTargets.length} Automation-ready`}
        </button>
      </div>
    )
  })

  if (loading) return <div className="p-6 text-[13px] text-[#6B7280]">Loading request…</div>

  const ai = current ? aiOf(current) : null
  const originalSteps = current ? splitSteps(ai?.original?.['Test Steps'] ?? detailOf(current, 'Test Steps', 'Steps')) : []
  const diff = ai?.steps?.length ? diffSteps(originalSteps, ai.steps) : []
  const added = diff.filter((line) => line.kind === 'add').length
  const removed = diff.filter((line) => line.kind === 'del').length
  const title = current ? caseTitle(current) : ''
  const caseType = ai?.test_type || (current ? inferCaseType(title) : '')
  const priority = current ? detailOf(current, 'Priority') : ''
  const verdict = ai?.review_verdict

  const chip = (key: Filter, label: string, tone: string) => (
    <button key={key} type="button" onClick={() => setFilter(key)} aria-pressed={filter === key}
      className={`${CHIP} ${filter === key ? 'bg-[#1F2937] text-white' : tone}`}>{label} {counts[key]}</button>
  )

  return (
    <div className="flex flex-col gap-3">
      {error && <div className="rounded-[12px] border border-[#F6D4D5] bg-[#FFF8F8] px-4 py-2.5 text-[13px] text-[#7A0B0D]" role="alert">{error}</div>}

      {/* Decision progress */}
      <div className={`${CARD} !rounded-[14px] flex flex-wrap items-center gap-4 px-4 py-2.5`}>
        <span className="text-[13px] font-bold text-[#1F2937]">{decided} of {cases.length} decided</span>
        <div className="flex h-2 min-w-[120px] flex-1 overflow-hidden rounded-full bg-[#F4F5F7]">
          <span className="bg-[#15803D]" style={{ width: `${cases.length ? (approved / cases.length) * 100 : 0}%` }} />
          <span className="bg-[#DC2626]" style={{ width: `${cases.length ? (rejected / cases.length) * 100 : 0}%` }} />
        </div>
        <span className="text-[12px] text-[#6B7280]"><strong className="text-[#136B34]">{approved}</strong> approved · <strong className="text-[#A3231C]">{rejected}</strong> rejected · {pendingCases.length} to go</span>
        <span className="flex items-center gap-[5px] border-l border-[#E8EAEE] pl-3.5 text-[12px] text-[#6B7280]">
          <Kbd>A</Kbd>approve <Kbd>R</Kbd>reject <Kbd>J</Kbd><Kbd>K</Kbd>next / previous
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[350px_minmax(0,1fr)]">
        {/* Case list */}
        <section className={`${CARD} flex max-h-[720px] flex-col overflow-hidden`}>
          <div className="flex flex-wrap gap-1.5 border-b border-[#E8EAEE] px-3.5 py-3">
            {chip('all', 'All', 'bg-[#F4F5F7] text-[#1F2937]')}
            {chip('automation', 'Automation', 'bg-[#EAF7EF] text-[#136B34]')}
            {chip('manual', 'Manual', 'bg-[#F4F5F7] text-[#374151]')}
            {chip('improved', 'Improved', 'bg-[#FFF5F5] text-[#941216]')}
            {chip('test_data', 'Test data', 'bg-[#FFF4E5] text-[#8A5000]')}
          </div>
          {(() => {
            const selectableIds = visible.filter((c) => c.status === 'PENDING').map((c) => c.test_case_id)
            const allOn = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id))
            return (
              <div className="flex items-center gap-2.5 border-b border-[#E8EAEE] bg-[#FCFCFD] px-3.5 py-2 text-[12px] text-[#6B7280]">
                <input
                  type="checkbox"
                  aria-label="Select all pending test cases"
                  checked={allOn}
                  disabled={selectableIds.length === 0}
                  onChange={() => setSelected((s) => {
                    const n = new Set(s)
                    selectableIds.forEach((id) => (allOn ? n.delete(id) : n.add(id)))
                    return n
                  })}
                  className="h-4 w-4 accent-[#B71920]"
                />
                <span className="font-semibold text-[#1F2937]">{selected.size > 0 ? `${selected.size} selected` : 'Select all pending'}</span>
                {selected.size > 0 && (
                  <button type="button" onClick={() => setSelected(new Set())} className="ml-auto font-semibold text-[#941216] hover:underline">Clear</button>
                )}
              </div>
            )
          })()}
          <div className="overflow-y-auto">
            {visible.map((c) => {
              const cai = aiOf(c)
              const active = c.test_case_id === currentId
              return (
                <div
                  key={c.test_case_id}
                  onClick={() => { setCurrentId(c.test_case_id); setReason('') }}
                  className={`grid cursor-pointer grid-cols-[16px_minmax(0,1fr)_34px_20px] items-center gap-2.5 border-b border-[#F1F2F4] px-3.5 py-2.5 ${active ? 'bg-[#FFF5F5] shadow-[inset_3px_0_0_#B71920]' : 'hover:bg-[#FCFCFD]'}`}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${caseDisplayId(c)}`}
                    checked={selected.has(c.test_case_id)}
                    disabled={c.status !== 'PENDING'}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => setSelected((s) => { const n = new Set(s); n.has(c.test_case_id) ? n.delete(c.test_case_id) : n.add(c.test_case_id); return n })}
                    className="h-4 w-4 accent-[#B71920]"
                  />
                  <div className="min-w-0">
                    <div className="text-[12.5px] font-bold text-[#1F2937]">
                      {caseDisplayId(c)}
                      {cai?.classification && (
                        <span className={`ml-1 inline-flex h-[18px] items-center rounded-full px-2 text-[10px] font-semibold ${cai.classification === 'automation' ? 'bg-[#EAF7EF] text-[#136B34]' : 'bg-[#F4F5F7] text-[#374151]'}`}>
                          {cai.classification === 'automation' ? 'Auto' : 'Manual'}
                        </span>
                      )}
                      {cai?.test_data_pending && <span className="ml-1 inline-flex h-[18px] items-center rounded-full bg-[#FFF4E5] px-2 text-[10px] font-semibold text-[#8A5000]">Data</span>}
                    </div>
                    <div className="truncate text-[12px] text-[#6B7280]">{caseTitle(c)}</div>
                  </div>
                  <span className="text-[13px] font-bold text-[#1F2937]">{cai?.score_after != null ? cai.score_after.toFixed(1) : '—'}</span>
                  <StatusIcon status={c.status} />
                </div>
              )
            })}
          </div>
        </section>

        {/* Case detail */}
        {current ? (
          <section className={`${CARD} flex flex-col overflow-hidden`}>
            <div className="border-b border-[#E8EAEE] px-5 pb-3 pt-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] font-bold text-[#941216]">{caseDisplayId(current)}</span>
                {caseType && <span className={`${CHIP} ${/neg/i.test(caseType) ? 'bg-[#FEEBEC] text-[#A3231C]' : /bound|edge/i.test(caseType) ? 'bg-[#FEF3E2] text-[#9A5B00]' : 'bg-[#EAF7EF] text-[#136B34]'}`}>{caseType}</span>}
                {priority && <span className={`${CHIP} bg-[#F4F5F7] text-[#1F2937]`}>{priority}</span>}
                {ai?.classification && <span className={`${CHIP} ${ai.classification === 'automation' ? 'bg-[#EAF7EF] text-[#136B34]' : 'bg-[#F4F5F7] text-[#374151]'}`}>{ai.classification === 'automation' ? 'Automation' : 'Manual'}</span>}
                {ai?.improved && <span className={`${CHIP} bg-[#FFF5F5] text-[#941216]`}>Improved by AI</span>}
                {!ai && <span className={`${CHIP} bg-[#F4F5F7] text-[#6B7280]`}>Not AI-checked</span>}
                {current.status !== 'PENDING' && <span className={`${CHIP} ${current.status === 'APPROVED' ? 'bg-[#EAF7EF] text-[#136B34]' : 'bg-[#FEEBEC] text-[#A3231C]'}`}>{current.status === 'APPROVED' ? 'Approved' : 'Rejected'}</span>}
                {ai && (
                  <div className="ml-auto flex rounded-[10px] bg-[#F4F5F7] p-[3px]" role="tablist">
                    {(['ai', 'original', 'compare'] as View[]).map((v) => (
                      <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}
                        className={`rounded-[8px] px-2.5 py-[5px] text-[12px] ${view === v ? 'bg-white font-bold text-[#1F2937] shadow-[0_1px_2px_rgba(16,24,40,0.08)]' : 'font-semibold text-[#6B7280]'}`}>
                        {v === 'ai' ? 'AI version' : v === 'original' ? 'Original' : 'Compare'}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="mt-2 text-[16px] font-bold text-[#1F2937]">{title}</div>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_272px]">
              {/* Steps */}
              <div className="flex flex-col gap-1 border-[#E8EAEE] px-[18px] py-3.5 xl:border-r">
                {!ai || view === 'original' ? (
                  <>
                    <div className="mb-1 flex items-center justify-between"><span className={LBL}>{ai ? 'Steps · as generated' : 'Steps'}</span></div>
                    {(originalSteps.length ? originalSteps : ['No steps recorded']).map((text, index) => (
                      <div key={index} className="grid grid-cols-[20px_22px_minmax(0,1fr)] items-start gap-2 rounded-[8px] px-2.5 py-[7px] text-[12.5px] leading-[1.45] text-[#1F2937]">
                        <span /><span className="font-semibold text-[#9CA3AF]">{index + 1}</span><span>{withTodos(text)}</span>
                      </div>
                    ))}
                    {(ai?.original?.['Expected Result'] || detailOf(current, 'Expected Result')) && (
                      <div className="mt-2 text-[12px] text-[#6B7280]">Expected: {ai?.original?.['Expected Result'] || detailOf(current, 'Expected Result')}</div>
                    )}
                  </>
                ) : view === 'ai' ? (
                  <>
                    <div className="mb-1 flex items-center justify-between"><span className={LBL}>Steps · after AI Checks</span></div>
                    {ai.steps.map((step) => {
                      const todo = TODO.test(step.action)
                      return (
                        <div key={step.step_number} className={`grid grid-cols-[20px_22px_minmax(0,1fr)] items-start gap-2 rounded-[8px] px-2.5 py-[7px] text-[12.5px] leading-[1.45] ${todo ? 'bg-[#FFF4E5]' : ''}`}>
                          <span className="font-mono font-extrabold text-[#8A5000]">{todo ? '!' : ''}</span>
                          <span className={`font-semibold ${todo ? 'text-[#8A5000]' : 'text-[#9CA3AF]'}`}>{step.step_number}</span>
                          <span>{withTodos(step.action)}{step.expected_result && <div className="mt-0.5 text-[11.5px] text-[#6B7280]">Expected: {step.expected_result}</div>}</span>
                        </div>
                      )
                    })}
                  </>
                ) : (
                  <>
                    <div className="mb-1 flex items-center justify-between">
                      <span className={LBL}>Steps · what the AI changed</span>
                      <span className="text-[11.5px] text-[#6B7280]"><span className="font-bold text-[#136B34]">+{added}</span> added · <span className="font-bold text-[#A3231C]">−{removed}</span> removed</span>
                    </div>
                    {diff.map((line, index) => {
                      const todo = TODO.test(line.text)
                      if (line.kind === 'del') {
                        return (
                          <div key={index} className="grid grid-cols-[20px_22px_minmax(0,1fr)] items-start gap-2 rounded-[8px] bg-[#FEEBEC] px-2.5 py-[7px] text-[12.5px] leading-[1.45] text-[#A3231C] line-through">
                            <span className="font-mono font-extrabold">−</span><span /><span>{line.text}</span>
                          </div>
                        )
                      }
                      const add = line.kind === 'add'
                      return (
                        <div key={index} className={`grid grid-cols-[20px_22px_minmax(0,1fr)] items-start gap-2 rounded-[8px] px-2.5 py-[7px] text-[12.5px] leading-[1.45] text-[#1F2937] ${todo ? 'bg-[#FFF4E5]' : add ? 'bg-[#EAF7EF]' : ''}`}>
                          <span className={`font-mono font-extrabold ${todo ? 'text-[#8A5000]' : add ? 'text-[#136B34]' : 'text-[#9CA3AF]'}`}>{todo ? '!' : add ? '+' : ' '}</span>
                          <span className={`font-semibold ${todo ? 'text-[#8A5000]' : add ? 'text-[#136B34]' : 'text-[#9CA3AF]'}`}>{line.number}</span>
                          <span>
                            {withTodos(line.text)}
                            {add && line.expected && <div className="mt-0.5 text-[11.5px] text-[#136B34]">Expected: {line.expected}</div>}
                          </span>
                        </div>
                      )
                    })}
                  </>
                )}
              </div>

              {/* Insights */}
              <div className="flex flex-col gap-3.5 bg-[#FCFCFD] px-4 py-3.5">
                <div>
                  <div className={LBL}>AI quality review</div>
                  {ai?.score_after != null ? (
                    <>
                      <div className="mt-1.5 flex items-baseline gap-2">
                        <span className="text-[28px] font-extrabold tracking-[-0.02em] text-[#1F2937]">{ai.score_after.toFixed(1)}</span>
                        <span className="text-[12px] text-[#6B7280]">/ 5{ai.improved && ai.score_before != null ? ` · from ${ai.score_before.toFixed(1)}` : ''}</span>
                        {verdict && (
                          <span className={`${CHIP} ml-auto ${verdict === 'pass' ? 'bg-[#EAF7EF] text-[#136B34]' : verdict === 'fail' ? 'bg-[#FEEBEC] text-[#A3231C]' : 'bg-[#FFF4E5] text-[#8A5000]'}`}>
                            {verdict === 'pass' ? 'Pass' : verdict === 'fail' ? 'Fail' : 'Needs revision'}
                          </span>
                        )}
                      </div>
                      <div className="mt-2.5 flex flex-col gap-2">
                        {DIMENSIONS.map(({ key, label }) => {
                          const value = ai.review_scores?.[key]
                          if (value == null) return null
                          return (
                            <div key={key}>
                              <div className="flex justify-between text-[12px] text-[#1F2937]">
                                <span>{key === 'coverage' && ai.coverage_basis === 'objective' ? 'Coverage vs objective' : label}</span><strong>{value.toFixed(1)}</strong>
                              </div>
                              <div className="h-1.5 overflow-hidden rounded-full bg-[#F4F5F7]">
                                <span className={`block h-full rounded-full ${value < 4 ? 'bg-[#D97706]' : 'bg-[#B71920]'}`} style={{ width: `${(value / 5) * 100}%` }} />
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </>
                  ) : <div className="mt-1.5 text-[12.5px] text-[#6B7280]">This case was sent without AI Checks, so it has no quality review.</div>}
                </div>
                {ai?.classification_reason && (
                  <div className="border-t border-[#E8EAEE] pt-3">
                    <div className={LBL}>Why {ai.classification === 'automation' ? 'Automation' : 'Manual'}</div>
                    <div className="mt-1.5 text-[12.5px] leading-[1.5] text-[#1F2937]">{ai.classification_reason}</div>
                  </div>
                )}
                {ai?.test_data_pending && (
                  <div className="rounded-[12px] border border-[#EBCFA4] bg-[#FFFBF4] px-3 py-2.5">
                    <div className="text-[12.5px] font-bold text-[#8A5000]">Test data missing</div>
                    <div className="mt-[3px] text-[12px] leading-[1.45] text-[#6B7280]">Doesn't block approval. The case goes to Automation Lab flagged until the value is filled in.</div>
                  </div>
                )}
              </div>
            </div>

            {/* Decision bar */}
            <div className="flex flex-wrap items-center gap-2.5 border-t border-[#E8EAEE] px-5 py-3">
              <input
                ref={reasonRef}
                value={reason}
                onChange={(e) => { setReason(e.target.value); if (error) setError('') }}
                placeholder="Reason (needed to reject)"
                className="h-9 min-w-[200px] flex-1 rounded-[12px] border border-[#E8EAEE] px-3 text-[13px] text-[#1F2937] outline-none placeholder:text-[#9CA3AF] focus:border-[#B71920]"
              />
              <button type="button" onClick={() => void rejectCurrent()} disabled={busy}
                className="flex h-9 items-center gap-2 rounded-[12px] border border-[#F0C2C0] bg-white px-3.5 text-[13px] font-bold text-[#A3231C] disabled:opacity-50">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#A3231C" strokeWidth="2.6" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
                Reject
              </button>
              {cases.length > 0 && pendingCases.length === 0 ? (
                // Every case is decided: nothing is next, so the way on is back to the list.
                <button type="button" onClick={() => navigate('/manager-review')} disabled={busy}
                  title="Every test case in this request is decided"
                  className="flex h-9 items-center gap-2 rounded-[12px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-3.5 text-[13px] font-bold text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] disabled:opacity-50">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
                  Close &amp; back to Review
                </button>
              ) : (
                <button type="button" onClick={() => void approveCurrent()} disabled={busy}
                  className="flex h-9 items-center gap-2 rounded-[12px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-3.5 text-[13px] font-bold text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] disabled:opacity-50">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" aria-hidden><path d="M5 12l5 5 9-10" /></svg>
                  Approve &amp; next
                </button>
              )}
            </div>
          </section>
        ) : (
          <section className={`${CARD} flex items-center justify-center p-10 text-[13px] text-[#6B7280]`}>
            {cases.length ? 'Pick a test case on the left.' : 'This request has no test cases.'}
            <button type="button" onClick={() => navigate('/manager-review')} className="ml-2 font-semibold text-[#B71920]">Back to the list</button>
          </section>
        )}
      </div>

      <JourneyBar current={4} />
    </div>
  )
}

export default RequestReview
