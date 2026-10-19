/**
 * --- Automation Lab: projects (mockup A) ------------------------------------------
 *
 * Like Review & Approval's request list: Needs action / Passing / All, one row
 * per project with its scripts and dry-run progress, and Open to enter it.
 * Every number is computed from the Lab listing; nothing here has its own
 * endpoint.
 *
 * The Latest runs panel covers what the Runs page was used for day to day:
 * what ran lately, each opening its case inside its project. Runs with no test
 * case (discovery crawls, hand-written specs) are under "Other runs".
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import automationService from '../../services/automationService'
import { useAutomationContext } from '../../components/automation/AutomationContext'
import { ProjectBadge } from '../../components/automation/listPresentation'
import {
  BTN, CARD, CHIP, ChevronGlyph, DownloadGlyph, ago, attentionOf, readFramework, saveBlob, summarise, writeFramework,
  type ProjectSummary
} from '../../components/automation/labShared'
import { DoneDot, FailDot, SpinDot, EmptyDot, baseId, clock, dayMonth, elapsedSeconds, fullStamp, failedStepOf, hhmm, progressOf, toneOf } from '../../components/automation/labRun'
import { OtherRunsPopup, RunPopup } from '../../components/automation/LabPopups'
import DeleteProjectPopup from '../../components/automation/DeleteProjectPopup'
import { isTerminal } from '../../types/automation'
import type { FrameworkInfo, RunSummary, ScriptLabCase } from '../../types/automation'

type Tab = 'action' | 'passing' | 'all'

const ROW = 'grid grid-cols-[24px_minmax(170px,1.6fr)_40px_minmax(100px,1fr)_minmax(130px,1.2fr)_minmax(92px,0.85fr)_70px_76px] items-center gap-2.5 px-4'

const isPassing = (p: ProjectSummary) => p.cases.length > 0 && p.passed === p.cases.length
const projectLink = (key: string, testCase?: string | null, runKey?: string | null) => {
  const params = new URLSearchParams()
  if (testCase) params.set('case', testCase)
  if (runKey) { params.set('view', 'latest'); params.set('run', runKey) }
  const qs = params.toString()
  return `/automation/script-lab/${key}${qs ? `?${qs}` : ''}`
}

const Bar: React.FC<{ parts: { n: number; color: string }[]; total: number }> = ({ parts, total }) => (
  <span className="flex h-[7px] overflow-hidden rounded-full bg-[#E8EAEE]">
    {parts.map((p, i) => (p.n ? <span key={i} className={p.color} style={{ width: `${(100 * p.n) / Math.max(1, total)}%` }} /> : null))}
  </span>
)

/** One line of the Latest runs panel. */
const LatestRun: React.FC<{ run: RunSummary; now: number; onOpen: () => void }> = ({ run, now, onOpen }) => {
  const tone = toneOf(run)
  const progress = progressOf(run)
  const live = !isTerminal(run.status)
  const step = failedStepOf(run)
  const detail = live
    ? [tone === 'queued' ? 'Queued' : 'Running', progress?.current && progress?.total ? `step ${progress.current} of ${progress.total}` : null, clock(elapsedSeconds(run, now))]
    : tone === 'passed'
      ? ['Passed', hhmm(run.started_at ?? run.created_at), clock(run.duration_seconds)]
      : tone === 'cancelled'
        ? ['Cancelled', hhmm(run.started_at ?? run.created_at)]
        : [step ? `${tone === 'blocked' ? 'Blocked' : 'Failed'} at step ${step}` : tone === 'blocked' ? 'Blocked' : 'Failed', hhmm(run.started_at ?? run.created_at), run.healing_diagnosis && !run.is_healed ? 'fix suggested' : clock(run.duration_seconds)]
  return (
    <li className="flex items-start gap-2.5 border-b border-[#F1F2F4] py-2.5 last:border-b-0">
      <span className="mt-0.5">{tone === 'passed' ? <DoneDot size={18} /> : live ? <SpinDot size={18} /> : tone === 'cancelled' ? <EmptyDot size={18} /> : <FailDot size={18} />}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-semibold text-[#1F2937]">
          {baseId(run.tc_display_id)}{run.project ? ` · ${run.project.ppm_id}` : ''}
        </span>
        <span className="block text-[11.5px] leading-[1.4] text-[#6B7280]">{detail.filter(Boolean).join(' · ')}</span>
      </span>
      <button type="button" onClick={onOpen} className="text-[12px] font-bold text-[#B71920] hover:underline">Open</button>
    </li>
  )
}

const LabProjects: React.FC = () => {
  const { query, canExecute } = useAutomationContext()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [cases, setCases] = useState<ScriptLabCase[]>([])
  const [frameworks, setFrameworks] = useState<FrameworkInfo[]>([])
  const [framework, setFrameworkState] = useState(readFramework)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('action')
  const [projectFilter, setProjectFilter] = useState('all')
  const [projectMenu, setProjectMenu] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [otherOpen, setOtherOpen] = useState(false)
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // ?run=KEY: a run with no test case, from an old Runs link.
  const openRun = params.get('run')

  const setFramework = (name: string) => { setFrameworkState(name); writeFramework(name) }

  const load = useCallback(async () => {
    try {
      const [listing, fw, recent] = await Promise.all([
        automationService.listScriptLabCases(),
        automationService.listFrameworks(),
        automationService.listRuns(40)
      ])
      setCases(listing.cases ?? [])
      setFrameworks(fw.frameworks ?? [])
      setRuns(recent.runs ?? [])
      setError(null)
    } catch (err: any) {
      setError(err?.message ?? 'The Automation Lab could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const anyLive = runs.some(r => !isTerminal(r.status)) || cases.some(c => c.scripts.some(s => s.dry_run_status === 'running' || s.dry_run_status === 'queued'))
  useEffect(() => {
    if (!anyLive) return
    const poll = window.setInterval(() => void load(), 4000)
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    return () => { window.clearInterval(poll); window.clearInterval(tick) }
  }, [anyLive, load])

  const projects = useMemo(() => summarise(cases, framework), [cases, framework])
  const searched = useMemo(
    () =>
      projects.filter(p => {
        if (projectFilter !== 'all' && p.key !== projectFilter) return false
        if (!query) return true
        return [p.ppm, p.name].some(v => String(v ?? '').toLowerCase().includes(query))
          || p.cases.some(c => [c.tc_display_id, c.title, c.request_id].some(v => String(v ?? '').toLowerCase().includes(query)))
      }),
    [projects, projectFilter, query]
  )
  const counts = {
    action: searched.filter(p => attentionOf(p) > 0).length,
    passing: searched.filter(isPassing).length,
    all: searched.length
  }
  const visible = searched.filter(p => (tab === 'action' ? attentionOf(p) > 0 : tab === 'passing' ? isPassing(p) : true))

  // Only runs of Lab cases here; the rest are "Other runs".
  const caseRuns = runs.filter(r => r.test_case_id != null)
  const otherRuns = runs.filter(r => r.test_case_id == null)
  const filteredRuns = caseRuns.filter(r => projectFilter === 'all' || (projectFilter === 'none' ? !r.project : String(r.project?.id) === projectFilter))
  const filterLabel = projectFilter === 'all' ? 'All projects' : projectFilter === 'none' ? 'No project' : projects.find(p => p.key === projectFilter)?.ppm ?? 'All projects'

  const openLatest = (run: RunSummary) => {
    const testCase = cases.find(c => c.id === run.test_case_id)
    const key = testCase?.project ? String(testCase.project.id) : run.project ? String(run.project.id) : 'none'
    navigate(projectLink(key, testCase ? testCase.tc_display_id : run.tc_display_id, run.run_key))
  }

  const download = async (label: string, caseIds: number[] | null) => {
    setBusy(label)
    setError(null)
    try {
      saveBlob(await automationService.downloadScriptBundle(framework, caseIds), `automation-scripts-${framework}${label === 'all' ? '' : `-${label}`}.zip`)
    } catch (err: any) {
      setError(err?.message ?? 'The scripts could not be downloaded.')
    } finally {
      setBusy(null)
    }
  }

  const allOn = visible.length > 0 && visible.every(p => picked.has(p.key))
  const pickedCases = projects.filter(p => picked.has(p.key)).flatMap(p => p.cases.map(c => c.id))
  const firstKey = visible[0]?.key

  const closeRun = () => { params.delete('run'); setParams(params, { replace: true }) }

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_290px]">
      <section className={`${CARD} min-w-0 overflow-hidden`}>
        {/* Tabs and filters */}
        <div className="flex flex-wrap items-center gap-3 border-b border-[#E8EAEE] px-4">
          <nav className="flex items-center gap-5" aria-label="Project status">
            {([['action', 'Needs action', 'bg-[#FEEBEC] text-[#A3231C]'], ['passing', 'Passing', 'bg-[#EAF7EF] text-[#136B34]'], ['all', 'All', 'bg-[#F4F5F7] text-[#374151]']] as const).map(([key, label, tone]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                aria-pressed={tab === key}
                className={`-mb-px flex h-[46px] items-center gap-1.5 border-b-2 text-[13px] font-semibold transition ${tab === key ? 'border-[#B71920] text-[#B71920]' : 'border-transparent text-[#374151] hover:text-[#1F2937]'}`}
              >
                {label}
                <span className={`inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10.5px] font-bold ${tone}`}>{counts[key]}</span>
              </button>
            ))}
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-2 py-2">
            <button
              type="button"
              onClick={() => void download(picked.size ? 'selected' : 'all', picked.size ? pickedCases : null)}
              disabled={busy !== null}
              title={picked.size ? `Download the ticked projects' ${framework} scripts` : `Download every ${framework} script as one zip`}
              className={`${BTN} h-8 rounded-full px-3 text-[12px] font-semibold`}
            >
              {busy === 'all' || busy === 'selected' ? 'Downloading…' : 'Download scripts'}
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => setProjectMenu(v => !v)}
                aria-haspopup="menu"
                aria-expanded={projectMenu}
                className={`${BTN} h-8 rounded-full px-3 text-[12.5px] font-semibold`}
              >
                {filterLabel}
                <ChevronGlyph />
              </button>
              {projectMenu && (
                <div role="menu" className="absolute right-0 top-10 z-20 min-w-[240px] overflow-hidden rounded-[12px] border border-[#E8EAEE] bg-white py-1 shadow-[0_12px_32px_rgba(16,24,40,0.14)]">
                  {[{ key: 'all', label: 'All projects' }, ...projects.filter(p => p.key !== 'none').map(p => ({ key: p.key, label: `${p.ppm} · ${p.name}` })), { key: 'none', label: 'No project' }].map(item => (
                    <button
                      key={item.key}
                      type="button"
                      role="menuitemradio"
                      aria-checked={projectFilter === item.key}
                      onClick={() => { setProjectFilter(item.key); setProjectMenu(false) }}
                      className={`block w-full truncate px-3.5 py-2 text-left text-[12.5px] hover:bg-[#FFF8F8] ${projectFilter === item.key ? 'font-bold text-[#941216]' : 'text-[#1F2937]'}`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1" role="radiogroup" aria-label="Framework">
              {(frameworks.length ? frameworks : [{ name: 'playwright', label: 'Playwright', runnable: true }]).map(fw => (
                <button
                  key={fw.name}
                  type="button"
                  role="radio"
                  aria-checked={framework === fw.name}
                  onClick={() => setFramework(fw.name)}
                  title={fw.runnable ? undefined : `${fw.label} is generate-only here`}
                  className={`h-8 rounded-full px-3 text-[12.5px] font-semibold transition ${framework === fw.name ? 'bg-[#1F2937] text-white' : 'bg-[#F4F5F7] text-[#374151] hover:bg-[#ECEEF1]'}`}
                >
                  {fw.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {notice && <div role="status" className="mx-4 mt-3 rounded-[10px] border border-[#BBDFC8] bg-[#F5FBF7] px-3 py-2 text-[12.5px] text-[#136B34]">{notice}</div>}
        {error && <div role="alert" className="mx-4 mt-3 rounded-[10px] border border-[#F6D4D5] bg-[#FFF8F8] px-3 py-2 text-[12.5px] text-[#7A0B0D]">{error}</div>}

        <div className="app-scroll overflow-x-auto">
          <div className="min-w-[790px]">
            <div className={`${ROW} h-9 border-b border-[#E8EAEE] bg-[#FCFCFD] text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#374151]`}>
              <span className="flex justify-center">
                <input type="checkbox" aria-label="Select every project" checked={allOn} disabled={!visible.length} onChange={() => setPicked(allOn ? new Set() : new Set(visible.map(p => p.key)))} className="h-4 w-4 accent-[#B71920]" />
              </span>
              <span>Project</span>
              <span>Cases</span>
              <span>Scripts</span>
              <span>Last updated</span>
              <span>Attention</span>
              <span />
              <span />
            </div>

            {loading ? (
              <div className="px-6 py-8 text-[13px] text-[#6B7280]">Loading the Automation Lab…</div>
            ) : visible.length === 0 ? (
              <div className="px-6 py-10 text-center text-[13px] text-[#6B7280]">
                {cases.length
                  ? tab === 'action' ? 'Nothing needs action here.' : tab === 'passing' ? 'No project is passing every case yet.' : 'No projects match.'
                  : <>No approved Automation cases yet. Cases from other sources are prepared in the <Link to="/automation/workbench" className="font-semibold text-[#B71920] hover:underline">Automation Workspace</Link>.</>}
              </div>
            ) : (
              visible.map(p => {
                const n = p.cases.length
                const recent = ago(p.lastRunAt, now)
                const sub = p.key === 'none'
                  ? 'Cases approved before projects existed'
                  : [`Approved ${dayMonth(p.approvedAt)}`, p.approvedBy, p.lastRunAt ? (recent ? `${recent} last run` : `last run ${dayMonth(p.lastRunAt)}`) : 'new'].filter(Boolean).join(' · ')
                return (
                  <div key={p.key} className={`${ROW} min-h-[70px] border-b border-[#F1F2F4] py-2.5 text-[13px] last:border-b-0 ${picked.has(p.key) ? 'bg-[#FFFAFA]' : ''}`}>
                    <span className="flex justify-center">
                      <input
                        type="checkbox"
                        aria-label={`Select ${p.ppm ?? 'No project'}`}
                        checked={picked.has(p.key)}
                        onChange={() => setPicked(prev => { const next = new Set(prev); if (next.has(p.key)) next.delete(p.key); else next.add(p.key); return next })}
                        className="h-4 w-4 accent-[#B71920]"
                      />
                    </span>
                    <button type="button" onClick={() => navigate(projectLink(p.key))} className="flex min-w-0 items-center gap-3 text-left">
                      <ProjectBadge name={p.name} hasProject={Boolean(p.ppm)} />
                      <span className="min-w-0">
                        <span className="block truncate text-[13.5px] font-bold text-[#1F2937]">
                          {p.ppm ? <><span className="font-mono text-[#B71920]">{p.ppm}</span> - {p.name}</> : p.name}
                        </span>
                        <span className="block text-[11.5px] leading-[1.4] text-[#6B7280]">{sub}</span>
                      </span>
                    </button>
                    <span className="text-[14px] font-bold text-[#1F2937]">{n}</span>
                    <span className="flex flex-col gap-1.5">
                      <Bar total={n} parts={[{ n: p.scripted, color: 'bg-[#1F2937]' }]} />
                      <span className="text-[11.5px] text-[#6B7280]"><b className="text-[#1F2937]">{p.scripted}</b> of {n} scripted</span>
                    </span>
                    <span className="flex flex-col gap-0.5">
                      {p.lastUpdatedAt ? (
                        <>
                          <span className="text-[12.5px] font-semibold tabular-nums text-[#1F2937]">{fullStamp(p.lastUpdatedAt)}</span>
                          {ago(p.lastUpdatedAt, now) && <span className="text-[11.5px] text-[#6B7280]">{ago(p.lastUpdatedAt, now)}</span>}
                        </>
                      ) : (
                        <span className="text-[11.5px] text-[#9CA3AF]">—</span>
                      )}
                    </span>
                    <span className="flex flex-col items-start gap-1">
                      {attentionOf(p) === 0 ? (
                        <span className="text-[12px] text-[#9CA3AF]">None</span>
                      ) : (
                        <>
                          {p.failed > 0 && <span className={`${CHIP} h-[22px] bg-[#FEEBEC] text-[#A3231C]`}>{p.failed} failing</span>}
                          {p.testData > 0 && <span className={`${CHIP} h-[22px] bg-[#FFF4E5] text-[#8A5000]`}>{p.testData} test data</span>}
                          {p.needScripts > 0 && <span className={`${CHIP} h-[22px] border border-[#E8EAEE] bg-[#F4F5F7] text-[#374151]`}>{p.needScripts} need script{p.needScripts === 1 ? '' : 's'}</span>}
                        </>
                      )}
                    </span>
                    <span className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void download(p.ppm ?? 'no-project', p.cases.map(c => c.id))}
                      disabled={busy !== null || p.scripted === 0}
                      aria-label={`Download ${p.ppm ?? 'No project'} scripts`}
                      title={p.scripted ? `Download this project's ${framework} scripts` : 'No scripts yet'}
                      className="flex h-8 w-8 items-center justify-center rounded-[8px] border border-[#E8EAEE] bg-white text-[#6B7280] transition hover:text-[#B71920] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <DownloadGlyph size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleting(p)}
                      disabled={!canExecute}
                      aria-label={`Delete ${p.ppm ?? 'No project'} from the Automation Lab`}
                      title={canExecute ? 'Delete this project from the Automation Lab' : 'Deleting needs the automation.execute permission'}
                      className="flex h-8 w-8 items-center justify-center rounded-[8px] border border-[#E8EAEE] bg-white text-[#B71920] transition hover:border-[#F6D4D5] hover:bg-[#FFF5F5] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
                    </button>
                    </span>
                    <button
                      type="button"
                      onClick={() => navigate(projectLink(p.key))}
                      className={`h-9 rounded-[10px] text-[13px] font-bold transition ${
                        p.key === firstKey
                          ? 'bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] text-white shadow-[0_6px_16px_rgba(183,25,32,0.25)]'
                          : 'border border-[#B71920] bg-white text-[#B71920] hover:bg-[#FFF5F5]'
                      }`}
                    >
                      Open
                    </button>
                  </div>
                )
              })
            )}
          </div>
        </div>
        <div className="border-t border-[#E8EAEE] px-4 py-3 text-[11.5px] text-[#6B7280]">
          ⓘ Cases arrive here when a manager approves them as Automation in Review &amp; Approval, grouped by their project.
          {!canExecute ? ' You can view and download; generating and running need the automation.execute permission.' : ''}
        </div>
      </section>

      {/* Latest runs */}
      <aside className={`${CARD} self-start px-4 pb-4 pt-3.5`}>
        <div className="flex items-center justify-between">
          <span className="text-[13.5px] font-bold text-[#1F2937]">Latest runs</span>
          <span className="text-[11.5px] text-[#6B7280]">{projectFilter === 'all' ? 'all projects' : filterLabel}</span>
        </div>
        <ul className="mt-1">
          {filteredRuns.length === 0 ? (
            <li className="py-3 text-[12px] text-[#9CA3AF]">{loading ? 'Loading…' : 'No runs yet.'}</li>
          ) : (
            filteredRuns.slice(0, 6).map(run => <LatestRun key={run.run_key} run={run} now={now} onOpen={() => openLatest(run)} />)
          )}
        </ul>
        {otherRuns.length > 0 && (
          <button type="button" onClick={() => setOtherOpen(true)} className="mt-1 flex w-full items-center justify-between rounded-[10px] border border-[#E8EAEE] px-3 py-2 text-left hover:border-[#F6D4D5]">
            <span>
              <span className="block text-[12.5px] font-semibold text-[#1F2937]">Other runs · {otherRuns.length}</span>
              <span className="block text-[11px] text-[#6B7280]">Discovery crawls and hand-written specs</span>
            </span>
            <span className="text-[12px] font-bold text-[#B71920]">Open</span>
          </button>
        )}
        <p className="mt-3 rounded-[10px] bg-[#F4F5F7] px-3 py-2.5 text-[11.5px] leading-[1.5] text-[#6B7280]">
          Open takes you to the case inside its project, on its Latest run. Each case keeps its full run history.
        </p>
      </aside>

      {deleting && (
        <DeleteProjectPopup
          projectKey={deleting.key}
          label={deleting.ppm ? `${deleting.ppm} - ${deleting.name}` : 'No project'}
          canExecute={canExecute}
          onClose={() => setDeleting(null)}
          onDeleted={summary => {
            setDeleting(null)
            setNotice(summary)
            setPicked(prev => { const next = new Set(prev); next.delete(deleting.key); return next })
            if (projectFilter === deleting.key) setProjectFilter('all')
            void load()
          }}
        />
      )}
      {otherOpen && !openRun && (
        <OtherRunsPopup
          runs={otherRuns}
          onClose={() => setOtherOpen(false)}
          onOpen={key => { setOtherOpen(false); params.set('run', key); setParams(params) }}
        />
      )}
      {openRun && (
        <RunPopup
          runKey={openRun}
          canExecute={canExecute}
          onChanged={() => void load()}
          onMinimise={closeRun}
          onClose={closeRun}
        />
      )}
    </div>
  )
}

export default LabProjects
