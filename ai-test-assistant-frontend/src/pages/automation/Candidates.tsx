/**
 * --- Automation Module: candidates --------------------------------------
 *
 * What is available to automate, and whether it is fit to automate.
 *
 * Two sources are presented identically: approved cases read from the review
 * workflow, and cases authored in the Studio. The verdict beside each row comes
 * from a deterministic backend scorer, so the same case always reads the same
 * and every shortfall names itself.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  HiOutlineSearch,
  HiOutlineRefresh,
  HiOutlinePlay,
  HiOutlineEye,
  HiOutlineClipboardList,
  HiOutlineCheckCircle,
  HiOutlineExclamation,
  HiOutlineExclamationCircle,
  HiOutlineCode
} from 'react-icons/hi'
import automationService from '../../services/automationService'
import { useAutomationContext } from '../../components/automation/AutomationContext'
import MetricCard from '../../components/ui/MetricCard'
import SectionCard from '../../components/ui/SectionCard'
import StatusBadge from '../../components/ui/StatusBadge'
import EmptyState from '../../components/ui/EmptyState'
import LoadingSkeleton from '../../components/ui/LoadingSkeleton'
import CandidateDrawer from '../../components/automation/CandidateDrawer'
import RunSpecModal from '../../components/automation/RunSpecModal'
import { verdictLabel, verdictTone } from '../../components/automation/EligibilityMeter'
import type { Candidate, CandidateSummary, Verdict } from '../../types/automation'

type SourceFilter = 'all' | 'approved' | 'manual'

const SOURCE_OPTIONS: { value: SourceFilter; label: string }[] = [
  { value: 'all', label: 'All sources' },
  { value: 'approved', label: 'Approved' },
  { value: 'manual', label: 'Studio' }
]

const VERDICT_OPTIONS: { value: '' | Verdict; label: string }[] = [
  { value: '', label: 'Any verdict' },
  { value: 'ready', label: 'Ready' },
  { value: 'review', label: 'Needs review' },
  { value: 'needs_enhancement', label: 'Needs enhancement' }
]

const EMPTY_SUMMARY: CandidateSummary = {
  total: 0,
  ready: 0,
  review: 0,
  needs_enhancement: 0,
  scripted: 0
}

/**
 * Real data contains duplicate display IDs — two approved rows can both read
 * TC-AUTH-04. Keying on the display ID would collapse them in React's
 * reconciler, so the key is the origin identifier, which is unique.
 */
const rowKey = (c: Candidate) => `${c.source}:${c.id ?? c.origin_test_case_id ?? c.display_id}`

const Candidates: React.FC = () => {
  const navigate = useNavigate()
  const { runtime, canExecute } = useAutomationContext()

  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [summary, setSummary] = useState<CandidateSummary>(EMPTY_SUMMARY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [source, setSource] = useState<SourceFilter>('all')
  const [verdict, setVerdict] = useState<'' | Verdict>('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')

  const [drawerCandidate, setDrawerCandidate] = useState<Candidate | null>(null)
  const [runCandidate, setRunCandidate] = useState<Candidate | null>(null)
  const [runModalOpen, setRunModalOpen] = useState(false)

  // Debounce the search so typing does not re-scan every approved case per
  // keystroke — the backend re-reads and re-scores the whole table each call.
  const debounceRef = useRef<number | null>(null)
  useEffect(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => setSearch(searchInput), 350)
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
    }
  }, [searchInput])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await automationService.listCandidates({
        source,
        verdict: verdict || null,
        search: search || null
      })
      setCandidates(data.candidates ?? [])
      setSummary(data.summary ?? EMPTY_SUMMARY)
    } catch (err: any) {
      setError(err?.message ?? 'Candidates could not be loaded.')
      setCandidates([])
      setSummary(EMPTY_SUMMARY)
    } finally {
      setLoading(false)
    }
  }, [source, verdict, search])

  useEffect(() => {
    void load()
  }, [load])

  const openRun = useCallback((candidate: Candidate | null) => {
    setDrawerCandidate(null)
    setRunCandidate(candidate)
    setRunModalOpen(true)
  }, [])

  const handleQueued = useCallback(
    (runKey: string) => {
      setRunModalOpen(false)
      setRunCandidate(null)
      navigate(`/automation/runs/${runKey}`)
    },
    [navigate]
  )

  const hasFilters = source !== 'all' || verdict !== '' || search !== ''

  const metrics = useMemo(
    () => [
      {
        label: 'Candidates',
        value: summary.total,
        tone: 'brand' as const,
        icon: <HiOutlineClipboardList className="h-4 w-4" />,
        tooltip: 'Approved and Studio-authored cases matching the current filters'
      },
      {
        label: 'Ready',
        value: summary.ready,
        tone: 'success' as const,
        icon: <HiOutlineCheckCircle className="h-4 w-4" />,
        tooltip: 'Scored as fit to automate as written'
      },
      {
        label: 'Needs review',
        value: summary.review,
        tone: 'warning' as const,
        icon: <HiOutlineExclamation className="h-4 w-4" />,
        tooltip: 'Automatable, but something is missing or ambiguous'
      },
      {
        label: 'Needs enhancement',
        value: summary.needs_enhancement,
        tone: 'danger' as const,
        icon: <HiOutlineExclamationCircle className="h-4 w-4" />,
        tooltip: 'Too thin to generate from — generating would waste the call'
      },
      {
        label: 'Scripted',
        value: summary.scripted,
        tone: 'violet' as const,
        icon: <HiOutlineCode className="h-4 w-4" />,
        tooltip: 'Cases that already have at least one generated script'
      }
    ],
    [summary]
  )

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {metrics.map(m => (
          <MetricCard
            key={m.label}
            label={m.label}
            value={loading ? '—' : m.value}
            tone={m.tone}
            icon={m.icon}
            tooltip={m.tooltip}
          />
        ))}
      </div>

      <SectionCard
        title="Automation candidates"
        description="Eligibility is scored deterministically, so a verdict is reproducible and every shortfall names itself."
        noPadding
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <HiOutlineSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-app-secondary" />
              <input
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                placeholder="Search ID, description, category…"
                maxLength={200}
                className="app-input w-full min-w-[240px] pl-8"
              />
            </div>
            <select
              value={source}
              onChange={e => setSource(e.target.value as SourceFilter)}
              className="app-input"
            >
              {SOURCE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <select
              value={verdict}
              onChange={e => setVerdict(e.target.value as '' | Verdict)}
              className="app-input"
            >
              {VERDICT_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void load()}
              className="app-btn app-btn-secondary inline-flex items-center gap-1.5"
              title="Reload candidates"
            >
              <HiOutlineRefresh className="h-4 w-4" />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => openRun(null)}
              disabled={!canExecute}
              title={canExecute ? undefined : 'You do not have permission to execute runs.'}
              className="app-btn app-btn-primary inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <HiOutlinePlay className="h-4 w-4" />
              Run a spec
            </button>
          </div>
        }
      >
        {error ? (
          <div className="m-5 flex items-start gap-2 rounded-app border border-red-200 bg-app-danger-bg px-3 py-3 text-[13px] text-app-danger">
            <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 6 }, (_, i) => (
              <LoadingSkeleton key={i} className="h-12 w-full" rounded="lg" />
            ))}
          </div>
        ) : null}

        {!loading && !error && candidates.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title={hasFilters ? 'Nothing matches these filters' : 'No candidates yet'}
              description={
                hasFilters
                  ? 'Widen the source or verdict filter, or clear the search.'
                  : 'Approve a test case in Review & Approve, or author one in the Studio, and it will appear here with an eligibility verdict.'
              }
              icon={<HiOutlineClipboardList className="h-5 w-5" />}
              action={
                hasFilters ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSource('all')
                      setVerdict('')
                      setSearchInput('')
                    }}
                    className="app-btn app-btn-secondary"
                  >
                    Clear filters
                  </button>
                ) : undefined
              }
            />
          </div>
        ) : null}

        {!loading && candidates.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="app-table">
              <thead>
                <tr>
                  <th className="text-left">Test case</th>
                  <th className="text-left">Source</th>
                  <th className="text-left">Eligibility</th>
                  <th className="text-left">Steps</th>
                  <th className="text-left">Approved by</th>
                  <th className="text-right"></th>
                </tr>
              </thead>
              <tbody>
                {candidates.map(candidate => {
                  const e = candidate.eligibility
                  return (
                    <tr key={rowKey(candidate)}>
                      <td>
                        <div className="min-w-0 max-w-[420px]">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-mono text-[12px] font-semibold text-app-primary">
                              {candidate.display_id}
                            </span>
                            {candidate.script_count > 0 ? (
                              <StatusBadge tone="info" size="sm">
                                {candidate.script_count} script
                                {candidate.script_count === 1 ? '' : 's'}
                              </StatusBadge>
                            ) : null}
                          </div>
                          <div className="truncate text-[12px] text-app-secondary">
                            {candidate.description || '—'}
                          </div>
                          {candidate.category ? (
                            <div className="truncate text-[11px] text-app-secondary/80">
                              {candidate.category}
                            </div>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <StatusBadge
                          tone={candidate.source === 'approved' ? 'info' : 'brand'}
                          size="sm"
                        >
                          {candidate.source}
                        </StatusBadge>
                      </td>
                      <td>
                        <div className="flex items-center gap-2">
                          <StatusBadge tone={verdictTone(e?.verdict)} size="sm" dot>
                            {verdictLabel(e?.verdict)}
                          </StatusBadge>
                          <span
                            className="text-[12px] font-semibold text-app-secondary"
                            title={
                              e?.reasons?.length
                                ? e.reasons.join(' · ')
                                : 'Nothing missing from this case'
                            }
                          >
                            {e?.score ?? 0}
                          </span>
                        </div>
                      </td>
                      <td className="text-[13px] text-app-secondary">{e?.step_count ?? 0}</td>
                      <td className="text-[13px] text-app-secondary">
                        {candidate.approved_by ?? candidate.generated_by ?? '—'}
                      </td>
                      <td className="text-right">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setDrawerCandidate(candidate)}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-semibold text-app-secondary transition hover:bg-app-surface-muted hover:text-app-primary"
                          >
                            <HiOutlineEye className="h-4 w-4" />
                            View
                          </button>
                          <button
                            type="button"
                            onClick={() => openRun(candidate)}
                            disabled={!canExecute}
                            title={
                              canExecute
                                ? 'Scaffold a spec from this case and run it'
                                : 'You do not have permission to execute runs.'
                            }
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-semibold text-app-brand-700 transition hover:bg-app-brand-50 disabled:opacity-40 disabled:hover:bg-transparent"
                          >
                            <HiOutlinePlay className="h-4 w-4" />
                            Run
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </SectionCard>

      <CandidateDrawer
        candidate={drawerCandidate}
        onClose={() => setDrawerCandidate(null)}
        onRun={openRun}
        canExecute={canExecute}
      />

      <RunSpecModal
        open={runModalOpen}
        onClose={() => {
          setRunModalOpen(false)
          setRunCandidate(null)
        }}
        candidate={runCandidate}
        runtime={runtime}
        canExecute={canExecute}
        onQueued={handleQueued}
      />
    </div>
  )
}

export default Candidates
