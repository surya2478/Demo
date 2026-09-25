import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePageHeader } from '../../components/layout/PageHeaderContext'
import JourneyBar from '../../components/test-assistant/JourneyBar'
import reviewService, {
  PENDING, ageLabel, downloadRequestCases, downloadRequestList,
  type Overview, type RequestSummary, type SourceGroup
} from '../../services/reviewService'

// Screen 4: Review & Approval. One list with Pending / Approved / Rejected / All
// tabs replaces the three stacked tables, and the Approved tab plus Download
// replaces the Approved Test Cases page.

type Tab = 'pending' | 'approved' | 'rejected' | 'all'

const CARD = 'rounded-[20px] border border-[#E8EAEE] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]'
const LBL = 'text-[10px] font-semibold uppercase tracking-[0.16em] text-[#6B7280]'
const CHIP = 'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-[9px] text-[11.5px] font-semibold'
const REQ = 'grid grid-cols-[minmax(0,1fr)_56px_150px_64px_100px_86px] items-center gap-3 border-b border-[#F1F2F4] px-[18px]'
const SOURCES: SourceGroup[] = ['BRD', 'SDD', 'ADO', 'e2e Spark']

const SOURCE_TONE: Record<SourceGroup, string> = {
  BRD: 'bg-[#F4F5F7] text-[#1F2937]',
  SDD: 'bg-[#FFF5F5] text-[#941216]',
  ADO: 'bg-[#EFF6FF] text-[#1D4ED8]',
  'e2e Spark': 'bg-[#F5F3FF] text-[#5B21B6]'
}

const inTab = (item: RequestSummary, tab: Tab) =>
  tab === 'all' ? true
    : tab === 'pending' ? PENDING.includes(item.overall_status)
      : tab === 'approved' ? item.overall_status === 'APPROVED'
        : item.overall_status === 'REJECTED'

const DocIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#B71920" strokeWidth="1.8" aria-hidden><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /></svg>
)

const formatStamp = (iso: string | null) => {
  if (!iso) return ''
  const date = new Date(iso)
  return `${date.toLocaleDateString('en-GB')} · ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
}

const ReviewApproval: React.FC = () => {
  const navigate = useNavigate()
  const [overview, setOverview] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('pending')
  const [source, setSource] = useState<SourceGroup | 'all'>('all')
  // 'all', 'none' (requests from before projects), or a project id.
  const [projectFilter, setProjectFilter] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [downloading, setDownloading] = useState<string | null>(null)
  const visibleRef = useRef<RequestSummary[]>([])

  const load = useCallback(async () => {
    try {
      setOverview(await reviewService.overview())
      setError('')
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'Review requests could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const onUpdate = () => void load()
    window.addEventListener('test-case-review-updated', onUpdate)
    return () => window.removeEventListener('test-case-review-updated', onUpdate)
  }, [load])

  const onSearch = useCallback((q: string) => setQuery(q.trim().toLowerCase()), [])
  const onExport = useCallback(() => { void downloadRequestList(visibleRef.current) }, [])

  usePageHeader({
    eyebrow: 'AI Test Generation',
    title: 'Review & Approval',
    showSearch: true,
    searchPlaceholder: 'Search requests, documents, people...',
    onSearch,
    actions: (
      <button
        type="button"
        onClick={onExport}
        className="flex h-9 items-center gap-2 rounded-[12px] border border-[#E8EAEE] bg-white px-3.5 text-[13px] font-bold text-[#1F2937] transition hover:border-[#F6D4D5]"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1F2937" strokeWidth="1.8" aria-hidden><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
        Export
      </button>
    )
  })

  const now = overview ? Date.parse(overview.now) : Date.now()
  const requests = overview?.requests ?? []
  const counts = {
    pending: requests.filter((r) => inTab(r, 'pending')).length,
    approved: requests.filter((r) => inTab(r, 'approved')).length,
    rejected: requests.filter((r) => inTab(r, 'rejected')).length,
    all: requests.length
  }
  const visible = useMemo(() => requests.filter((item) =>
    inTab(item, tab)
    && (source === 'all' || item.source_group === source)
    && (projectFilter === 'all' || (projectFilter === 'none' ? !item.project : String(item.project?.id) === projectFilter))
    && (!query || [item.document_name, item.request_id, item.request_by, item.project?.ppm_id, item.project?.name].some((v) => String(v ?? '').toLowerCase().includes(query)))
  ).sort((a, b) => tab === 'pending'
    ? String(a.request_date_time).localeCompare(String(b.request_date_time))
    : String(b.request_date_time).localeCompare(String(a.request_date_time))), [requests, tab, source, projectFilter, query])
  const projectOptions = useMemo(() => {
    const byId = new Map<number, { id: number; ppm_id: string; name: string }>()
    requests.forEach((item) => { if (item.project) byId.set(item.project.id, item.project) })
    return Array.from(byId.values()).sort((a, b) => a.ppm_id.localeCompare(b.ppm_id))
  }, [requests])
  visibleRef.current = visible

  const recent = requests
    .filter((item) => item.overall_status === 'APPROVED')
    .sort((a, b) => String(b.reviewed_date_time).localeCompare(String(a.reviewed_date_time)))
    .slice(0, 3)

  const k = overview?.kpis
  const oldestAge = k?.oldest_request_time ? ageLabel(k.oldest_request_time, now).replace(' ago', '') : '—'
  const readyPct = k && k.pending_cases ? Math.round((k.automation_ready / k.pending_cases) * 100) : 0

  const download = async (requestId: string) => {
    setDownloading(requestId)
    try {
      const detail = await reviewService.detail(requestId)
      await downloadRequestCases(requestId, detail.test_cases.filter((item) => item.status === 'APPROVED'))
    } catch (err: any) {
      setError(err?.response?.data?.detail || `Test cases for ${requestId} could not be downloaded.`)
    } finally {
      setDownloading(null)
    }
  }

  const tabButton = (key: Tab, label: string) => (
    <button
      key={key}
      type="button"
      onClick={() => setTab(key)}
      aria-pressed={tab === key}
      className={`flex h-10 items-center gap-1.5 border-b-2 px-1 text-[13.5px] font-semibold transition ${tab === key ? 'border-[#B71920] text-[#B71920]' : 'border-transparent text-[#6B7280] hover:text-[#1F2937]'}`}
    >
      {label}
      <span className={`rounded-full px-[7px] py-px text-[11px] font-bold ${key === 'pending' ? 'bg-[#FDEBEC] text-[#941216]' : 'bg-[#F4F5F7] text-[#6B7280]'}`}>{counts[key]}</span>
    </button>
  )

  return (
    <div className="flex flex-col gap-4">
      {error && <div className="rounded-[12px] border border-[#F6D4D5] bg-[#FFF8F8] px-4 py-2.5 text-[13px] text-[#7A0B0D]" role="alert">{error}</div>}

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-[16px] border border-[#F6D4D5] bg-[linear-gradient(135deg,#FFF5F5,#FFFFFF_70%)] px-4 py-3.5 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
          <div className={`${LBL} !text-[#941216]`}>Awaiting your decision</div>
          <div className="mt-2 flex items-baseline gap-2"><span className="text-[26px] font-extrabold leading-none tracking-[-0.02em] text-[#941216]">{k?.pending_requests ?? '—'}</span><span className="text-[13px] text-[#6B7280]">requests · {k?.pending_cases ?? 0} test cases</span></div>
        </div>
        <div className={`${CARD} !rounded-[16px] px-4 py-3.5`}>
          <div className={LBL}>Automation-ready</div>
          <div className="mt-2 flex items-baseline gap-2"><span className="text-[26px] font-extrabold leading-none tracking-[-0.02em] text-[#136B34]">{k?.automation_ready ?? '—'}</span><span className="text-[13px] text-[#6B7280]">of {k?.pending_cases ?? 0} · {readyPct}%</span></div>
        </div>
        <div className={`${CARD} !rounded-[16px] px-4 py-3.5`}>
          <div className={LBL}>Average AI quality</div>
          <div className="mt-2 flex items-baseline gap-2"><span className="text-[26px] font-extrabold leading-none tracking-[-0.02em] text-[#1F2937]">{k?.avg_after != null ? k.avg_after.toFixed(1) : '—'}</span><span className="text-[13px] text-[#6B7280]">/ 5{k?.avg_before != null ? ` · up from ${k.avg_before.toFixed(1)}` : ''}</span></div>
        </div>
        <div className={`${CARD} !rounded-[16px] px-4 py-3.5`}>
          <div className={LBL}>Oldest waiting</div>
          <div className="mt-2 flex min-w-0 items-baseline gap-2"><span className="whitespace-nowrap text-[26px] font-extrabold leading-none tracking-[-0.02em] text-[#1F2937]">{oldestAge}</span><span className="truncate text-[13px] text-[#6B7280]">{k?.oldest_document ?? ''}</span></div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_270px]">
        {/* Requests */}
        <section className={`${CARD} flex flex-col overflow-hidden`}>
          <div className="flex flex-wrap items-center gap-[22px] border-b border-[#E8EAEE] px-[18px] pt-1">
            {tabButton('pending', 'Pending')}
            {tabButton('approved', 'Approved')}
            {tabButton('rejected', 'Rejected')}
            {tabButton('all', 'All')}
            <div className="ml-auto flex flex-wrap items-center gap-1.5 py-2">
              <select
                aria-label="Project"
                value={projectFilter}
                onChange={(event) => setProjectFilter(event.target.value)}
                className="h-7 max-w-[240px] truncate rounded-full border border-[#E8EAEE] bg-white px-2.5 text-[11.5px] font-semibold text-[#1F2937] outline-none focus:border-[#F1A4A6]"
              >
                <option value="all">All projects</option>
                {projectOptions.map((item) => <option key={item.id} value={String(item.id)}>{item.ppm_id} · {item.name}</option>)}
                <option value="none">No project</option>
              </select>
              <button type="button" onClick={() => setSource('all')} className={`${CHIP} h-6 ${source === 'all' ? 'bg-[#1F2937] text-white' : 'bg-[#F4F5F7] text-[#1F2937]'}`}>All sources</button>
              {SOURCES.map((item) => (
                <button key={item} type="button" onClick={() => setSource(item)} className={`${CHIP} h-6 ${source === item ? 'bg-[#1F2937] text-white' : 'bg-[#F4F5F7] text-[#1F2937]'}`}>{item}</button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <div className="min-w-[760px]">
              <div className={`${REQ} h-9 border-b-[#F6D4D5] bg-[#F4F5F7] text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1F2937]`}>
                <span>Request</span><span>Cases</span><span>AI classification</span><span>Quality</span><span>Attention</span><span />
              </div>
              {loading && <div className="px-[18px] py-6 text-[13px] text-[#6B7280]">Loading requests…</div>}
              {!loading && visible.length === 0 && <div className="px-[18px] py-6 text-[13px] text-[#6B7280]">No requests here.</div>}
              {visible.map((item, index) => {
                const waitingLong = PENDING.includes(item.overall_status) && item.request_date_time && now - Date.parse(item.request_date_time) > 2 * 3600 * 1000
                const checked = item.automation + item.manual
                const pending = PENDING.includes(item.overall_status)
                return (
                  <div key={item.request_id} className={`${REQ} py-3.5`}>
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px] border border-[#F6D4D5] bg-[#FFF5F5]"><DocIcon /></div>
                      <div className="min-w-0">
                        <div className="truncate text-[13.5px] font-bold text-[#1F2937]" title={item.document_name}>{item.document_name}</div>
                        <div className="mt-[3px] flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
                          {item.project && (
                            <span className={`${CHIP} h-5 bg-[#FFF5F5] text-[10.5px] text-[#941216]`} title={`${item.project.ppm_id} · ${item.project.name}`}>{item.project.ppm_id}</span>
                          )}
                          <span className={`${CHIP} h-5 text-[10.5px] ${SOURCE_TONE[item.source_group]}`}>{item.source_group}</span>
                          <span className={`text-[11.5px] ${waitingLong ? 'font-semibold text-[#A3231C]' : 'text-[#6B7280]'}`}>{ageLabel(item.request_date_time, now)}</span>
                          <span className="text-[11.5px] text-[#6B7280]">· {item.request_by} ·</span>
                          <span className="truncate font-mono text-[11.5px] text-[#6B7280]">{item.request_id}</span>
                        </div>
                      </div>
                    </div>
                    <span className="text-[15px] font-bold text-[#1F2937]">{item.cases}</span>
                    <div>
                      {checked > 0 ? (
                        <>
                          <div className="flex h-2 overflow-hidden rounded-full bg-[#E8EAEE]">
                            <span className="bg-[#15803D]" style={{ width: `${(item.automation / checked) * 100}%` }} />
                            <span className="bg-[#9CA3AF]" style={{ width: `${(item.manual / checked) * 100}%` }} />
                          </div>
                          <div className="mt-[5px] text-[11.5px] text-[#6B7280]"><strong className="text-[#136B34]">{item.automation}</strong> Automation · <strong className="text-[#374151]">{item.manual}</strong> Manual</div>
                        </>
                      ) : <span className="text-[11.5px] text-[#9CA3AF]">Not AI-checked</span>}
                    </div>
                    <div>
                      {item.avg_after != null ? (
                        <>
                          <span className="text-[15px] font-bold text-[#1F2937]">{item.avg_after.toFixed(1)}</span>
                          {item.avg_before != null && <div className="text-[11.5px] text-[#6B7280]">from {item.avg_before.toFixed(1)}</div>}
                        </>
                      ) : <span className="text-[12px] text-[#9CA3AF]">—</span>}
                    </div>
                    {item.test_data_pending > 0
                      ? <span className={`${CHIP} h-6 w-fit bg-[#FFF4E5] text-[#8A5000]`}>{item.test_data_pending} test data</span>
                      : <span className="text-[12px] text-[#9CA3AF]">None</span>}
                    <button
                      type="button"
                      onClick={() => navigate(`/manager-review/${encodeURIComponent(item.request_id)}`)}
                      className={`flex h-9 items-center justify-center rounded-[12px] px-3.5 text-[13px] font-bold transition ${
                        pending && index === 0
                          ? 'bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] hover:opacity-95'
                          : 'border-[1.5px] border-[#B71920] bg-white text-[#B71920] hover:bg-[#FFF5F5]'
                      }`}
                    >
                      {pending ? 'Review' : 'Open'}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="flex flex-1 items-end px-[18px] py-3.5">
            <div className="flex items-center gap-2 text-[12px] text-[#6B7280]">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="1.8" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
              Requests from the Test Assistant have been through AI Checks. Approved Automation cases go straight to Automation Lab.
            </div>
          </div>
        </section>

        {/* Recently approved: replaces the Approved Test Cases page */}
        <aside className={`${CARD} flex flex-col px-[18px] py-4`}>
          <div className="flex items-center justify-between">
            <span className="text-[14px] font-bold text-[#1F2937]">Recently approved</span>
            <button type="button" onClick={() => setTab('approved')} className="text-[12px] font-semibold text-[#B71920] hover:text-[#941216]">View all {counts.approved}</button>
          </div>
          {recent.length === 0 && <div className="py-3 text-[12px] text-[#6B7280]">Nothing approved yet.</div>}
          {recent.map((item) => (
            <div key={item.request_id} className="flex flex-col gap-1 border-b border-[#F1F2F4] py-3">
              <div className="truncate text-[13px] font-semibold text-[#1F2937]" title={item.document_name}>{item.document_name}</div>
              <div className="text-[12px] text-[#6B7280]">{item.approved_count} approved{item.sent_to_lab ? <> · <strong className="text-[#136B34]">{item.sent_to_lab} sent to Automation Lab</strong></> : null}</div>
              <div className="flex justify-between text-[11.5px] text-[#9CA3AF]">
                <span>{formatStamp(item.reviewed_date_time)}</span>
                <button type="button" onClick={() => void download(item.request_id)} disabled={downloading === item.request_id} className="font-semibold text-[#B71920] hover:text-[#941216] disabled:opacity-50">
                  {downloading === item.request_id ? 'Downloading…' : 'Download'}
                </button>
              </div>
            </div>
          ))}
          <div className="mt-auto rounded-[12px] bg-[#F4F5F7] px-3 py-2.5 text-[12px] text-[#6B7280]">
            The Approved tab and Download replace the old Approved Test Cases page, so nothing is lost when that menu item is hidden.
          </div>
        </aside>
      </div>

      <JourneyBar current={5} />
    </div>
  )
}

export default ReviewApproval
