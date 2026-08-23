/**
 * --- Application Discovery and Grounding --------------------------------
 *
 * Crawl the running application, catalogue what it renders, then check whether
 * refined test cases actually resolve against it.
 *
 * This is the screen that answers the question the compiler cannot. A test
 * case says "the Username field"; the application might render "Email", or a
 * label with no `for` attribute that no accessible-name query can reach.
 * Without a catalogue the generator can only guess, and a wrong guess is not
 * discovered until a run goes red fifteen seconds in.
 *
 * The unresolved list is the point of the whole screen. Naming the steps that
 * did NOT match is what stops a generator inventing a locator for them, and
 * what tells an author whether the gap is a page that was never crawled or a
 * label the application words differently.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  HiOutlineSearch,
  HiOutlineRefresh,
  HiOutlineTrash,
  HiOutlineExclamationCircle,
  HiOutlineCheckCircle,
  HiOutlineExternalLink,
  HiOutlineGlobeAlt,
  HiOutlineLink
} from 'react-icons/hi'
import automationService from '../../services/automationService'
import { useAutomationContext } from '../../components/automation/AutomationContext'
import SectionCard from '../../components/ui/SectionCard'
import EmptyState from '../../components/ui/EmptyState'
import LoadingSkeleton from '../../components/ui/LoadingSkeleton'
import StatusBadge from '../../components/ui/StatusBadge'
import { StatTile, JobProgress } from '../../components/automation/workbenchPresentation'
import { GroundingBadge } from '../../components/automation/groundingPresentation'
import { isDiscoverySettled } from '../../types/automation'
import type {
  DiscoveredElement,
  DiscoveryRun,
  GroundResult,
  WorkbenchCase
} from '../../types/automation'

const STRATEGY_TONE: Record<string, 'success' | 'info' | 'warning' | 'neutral'> = {
  testid: 'success',
  label: 'success',
  role: 'info',
  placeholder: 'warning',
  text: 'warning'
}

const Discovery: React.FC = () => {
  const { canExecute, runtime } = useAutomationContext()

  const [discovery, setDiscovery] = useState<DiscoveryRun | null>(null)
  const [elements, setElements] = useState<DiscoveredElement[]>([])
  const [roles, setRoles] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [url, setUrl] = useState('')
  const [environment, setEnvironment] = useState('SIT')
  const [maxPages, setMaxPages] = useState(8)

  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('')

  const [grounding, setGrounding] = useState<GroundResult | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)

  const pollRef = useRef<number | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const state = await automationService.getDiscovery()
      setDiscovery(state.discovery)
      if (state.discovery?.status === 'completed') {
        const catalog = await automationService.listDiscoveredElements()
        setElements(catalog.elements ?? [])
        setRoles(catalog.roles ?? [])
      } else {
        setElements([])
        setRoles([])
      }
      if (state.discovery && !url) setUrl(state.discovery.application_url ?? '')
    } catch (err: any) {
      setError(err?.message ?? 'Discovery state could not be read.')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void load()
    return () => {
      if (pollRef.current !== null) window.clearTimeout(pollRef.current)
    }
  }, [load])

  /** Follow a crawl until it settles; a finished one cannot change. */
  const poll = useCallback(async () => {
    try {
      const state = await automationService.getDiscovery()
      setDiscovery(state.discovery)
      if (state.discovery && isDiscoverySettled(state.discovery.status)) {
        await load()
        return
      }
      pollRef.current = window.setTimeout(() => void poll(), 2000)
    } catch {
      await load()
    }
  }, [load])

  const handleDiscover = async () => {
    if (!url.trim()) return
    setBusy('discover')
    setError(null)
    setGrounding(null)
    try {
      const started = await automationService.startDiscovery({
        application_url: url.trim(),
        application_environment: environment.trim() || null,
        max_pages: maxPages
      })
      setDiscovery(started)
      void poll()
    } catch (err: any) {
      setError(err?.message ?? 'Discovery could not be started.')
    } finally {
      setBusy(null)
    }
  }

  const runAction = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (err: any) {
      setError(err?.message ?? `${label} failed.`)
    } finally {
      setBusy(null)
    }
  }

  const visibleElements = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return elements.filter(e => {
      if (roleFilter && e.role !== roleFilter) return false
      if (!needle) return true
      return (
        (e.accessible_name ?? '').toLowerCase().includes(needle) ||
        e.element_name.toLowerCase().includes(needle) ||
        e.recommended_locator.toLowerCase().includes(needle)
      )
    })
  }, [elements, search, roleFilter])

  const running = discovery ? !isDiscoverySettled(discovery.status) : false

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Catalogue version" value={loading ? '—' : discovery?.version ?? '—'} />
        <StatTile label="Pages crawled" value={loading ? '—' : discovery?.pages_discovered ?? 0} />
        <StatTile
          label="Elements found"
          value={loading ? '—' : discovery?.elements_discovered ?? 0}
          tone={discovery?.elements_discovered ? 'success' : 'default'}
        />
        <StatTile
          label="Blockers"
          value={loading ? '—' : discovery?.blockers?.length ?? 0}
          tone={discovery?.blockers?.length ? 'warning' : 'default'}
          hint={discovery?.blockers?.length ? 'Pages not crawled' : undefined}
        />
      </div>

      <SectionCard
        title="Target application"
        description="Discover the running application so generated locators come from real elements instead of the model's guesses. Skip it and scripts are still produced — just ungrounded."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="http://localhost:5175"
              className="app-input w-[230px]"
              aria-label="Application URL"
            />
            <input
              value={environment}
              onChange={e => setEnvironment(e.target.value)}
              placeholder="SIT"
              className="app-input w-20"
              aria-label="Environment"
            />
            <input
              type="number"
              min={1}
              max={40}
              value={maxPages}
              onChange={e => setMaxPages(Number(e.target.value) || 8)}
              className="app-input w-20"
              aria-label="Maximum pages"
              title="How many same-origin pages to follow before stopping"
            />
            <button
              type="button"
              onClick={handleDiscover}
              disabled={!canExecute || !url.trim() || busy !== null || running}
              className="app-btn app-btn-primary inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <HiOutlineGlobeAlt className="h-4 w-4" />
              {running ? 'Discovering…' : 'Discover Application'}
            </button>
            <button
              type="button"
              onClick={() =>
                runAction('ground', async () => {
                  const result = await automationService.groundCases([])
                  setGrounding(result)
                })
              }
              disabled={
                !canExecute || busy !== null || !discovery || discovery.status !== 'completed'
              }
              title={
                discovery?.status === 'completed'
                  ? 'Match every refined test case against this catalogue'
                  : 'Discover the application first'
              }
              className="app-btn app-btn-secondary inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <HiOutlineLink className="h-4 w-4" />
              Check Grounding
            </button>
            <button
              type="button"
              onClick={() =>
                runAction('delete', async () => {
                  await automationService.deleteDiscovery()
                  setGrounding(null)
                  await load()
                })
              }
              disabled={!canExecute || busy !== null || !discovery}
              title="Discard the catalogue and reset every grounding verdict that depended on it"
              className="app-btn app-btn-secondary inline-flex items-center gap-1.5 text-app-danger disabled:opacity-50"
            >
              <HiOutlineTrash className="h-4 w-4" />
              Clear
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="app-btn app-btn-secondary inline-flex items-center gap-1.5"
              title="Reload"
            >
              <HiOutlineRefresh className="h-4 w-4" />
            </button>
          </div>
        }
      >
        {runtime && !runtime.ready ? (
          <div className="mb-3 flex items-start gap-2 rounded-app border border-orange-200 bg-app-warning-bg px-3 py-2.5 text-[12px] text-app-warning">
            <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>The browser runtime is unavailable, so a crawl would be refused.</span>
          </div>
        ) : null}

        {running ? (
          <div className="mb-3">
            <JobProgress
              percent={discovery?.status === 'queued' ? 5 : 55}
              message={`Crawling ${discovery?.application_url ?? url}…`}
            />
          </div>
        ) : null}

        {error ? (
          <div className="mb-3 flex items-start gap-2 rounded-app border border-red-200 bg-app-danger-bg px-3 py-3 text-[13px] text-app-danger">
            <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? (
          <LoadingSkeleton className="h-20 w-full" rounded="lg" />
        ) : !discovery ? (
          <EmptyState
            title="Nothing discovered yet"
            description="Point this at a running application and crawl it. Every control it finds gets a locator verified to resolve, which is what grounding matches your test case steps against."
            icon={<HiOutlineGlobeAlt className="h-5 w-5" />}
          />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <StatusBadge
                tone={
                  discovery.status === 'completed'
                    ? 'success'
                    : discovery.status === 'failed'
                      ? 'danger'
                      : 'info'
                }
                size="sm"
                dot={running}
              >
                {discovery.status}
              </StatusBadge>
              <span className="font-mono text-app-primary">{discovery.application_url}</span>
              {discovery.application_environment ? (
                <span className="text-app-secondary">· {discovery.application_environment}</span>
              ) : null}
              <span className="text-app-secondary">· v{discovery.version}</span>
              {discovery.run_key ? (
                <Link
                  to={`/automation/runs/${discovery.run_key}`}
                  className="inline-flex items-center gap-0.5 font-semibold text-app-brand-700 hover:underline"
                  title="The crawl is an ordinary run — open its log and evidence"
                >
                  crawl log
                  <HiOutlineExternalLink className="h-3 w-3" />
                </Link>
              ) : null}
            </div>

            {/* Stated rather than left as a surprise: everything below was
                crawled as an anonymous visitor, so pages behind a login are
                not in the catalogue. */}
            <p className="rounded-app border border-app bg-app-surface-muted/40 px-3 py-2 text-[11px] text-app-secondary">
              {discovery.auth_detail ??
                'Crawled as an anonymous visitor — pages behind a login are not included.'}
            </p>

            {discovery.error ? (
              <div className="flex items-start gap-2 rounded-app border border-red-200 bg-app-danger-bg px-3 py-2.5 text-[12px] text-app-danger">
                <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>{discovery.error}</span>
              </div>
            ) : null}

            {discovery.blockers?.length ? (
              <div className="rounded-app border border-orange-200 bg-app-warning-bg px-3 py-2.5 text-[12px] text-app-warning">
                <div className="font-semibold">
                  {discovery.blockers.length} page(s) could not be crawled
                </div>
                <ul className="mt-1 space-y-0.5">
                  {discovery.blockers.map((b, i) => (
                    <li key={i} className="truncate">
                      <span className="font-mono">{b.url}</span> — {b.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {discovery.explored_pages?.length ? (
              <div className="text-[11px] text-app-secondary">
                Pages:{' '}
                {discovery.explored_pages
                  .map(p => `${p.title || p.url} (${p.status})`)
                  .join(' · ')}
              </div>
            ) : null}
          </div>
        )}
      </SectionCard>

      {/* ── Grounding results ──────────────────────────────────────────── */}
      {grounding ? (
        <SectionCard
          title="Grounding"
          description="How each refined test case resolves against the current catalogue. The steps that did not match are the point — a generator handed a partial catalogue would invent locators for them."
          noPadding
        >
          <div className="flex flex-wrap items-center gap-3 border-b border-app px-5 py-3 text-[12px]">
            <span className="text-app-secondary">{grounding.checked} case(s) checked against v{grounding.grounded_against.version}</span>
            <GroundingBadge status="grounded" />
            <span className="font-semibold text-app-primary">{grounding.counts.grounded ?? 0}</span>
            <GroundingBadge status="partially_grounded" />
            <span className="font-semibold text-app-primary">
              {grounding.counts.partially_grounded ?? 0}
            </span>
            <GroundingBadge status="ungrounded" />
            <span className="font-semibold text-app-primary">{grounding.counts.ungrounded ?? 0}</span>
          </div>

          {grounding.test_cases.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No refined test cases to ground"
                description="Refine some approved test cases in the Automation Workspace tab first."
              />
            </div>
          ) : (
            <div className="divide-y divide-transparent">
              {grounding.test_cases.map((testCase: WorkbenchCase) => {
                const summary = testCase.grounding_summary
                const open = expanded === testCase.id
                return (
                  <div key={testCase.id} className="border-b border-app last:border-b-0">
                    <button
                      type="button"
                      onClick={() => setExpanded(open ? null : testCase.id)}
                      className="flex w-full flex-wrap items-center gap-3 px-5 py-3 text-left transition hover:bg-app-surface-muted"
                    >
                      <span className="font-mono text-[12px] font-semibold text-app-primary">
                        {testCase.tc_display_id}
                      </span>
                      <GroundingBadge status={testCase.grounding_status} />
                      {summary ? (
                        <span className="text-[11px] text-app-secondary">
                          {summary.matched.length} matched · {summary.unresolved.length} unresolved
                          {summary.skipped ? ` · ${summary.skipped} need no control` : ''}
                        </span>
                      ) : null}
                      <span className="ml-auto text-[11px] text-app-secondary">
                        {open ? 'hide' : 'details'}
                      </span>
                    </button>

                    {open && summary ? (
                      <div className="space-y-3 px-5 pb-4">
                        {summary.note ? (
                          <p className="text-[12px] text-app-secondary">{summary.note}</p>
                        ) : null}

                        {summary.matched.length ? (
                          <div>
                            <h4 className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-app-success">
                              <HiOutlineCheckCircle className="h-3.5 w-3.5" />
                              Resolved
                            </h4>
                            <div className="overflow-x-auto rounded-app border border-app">
                              <table className="app-table">
                                <thead>
                                  <tr>
                                    <th className="text-left">Step</th>
                                    <th className="text-left">Target</th>
                                    <th className="text-left">Locator</th>
                                    <th className="text-left">Confidence</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {summary.matched.map(m => (
                                    <tr key={m.step_number}>
                                      <td className="text-[12px] text-app-secondary">
                                        {m.step_number}
                                      </td>
                                      <td className="text-[12px] text-app-primary">{m.target}</td>
                                      <td className="font-mono text-[11px] text-app-brand-700">
                                        {m.locator}
                                      </td>
                                      <td>
                                        <StatusBadge
                                          tone={STRATEGY_TONE[m.strategy] ?? 'neutral'}
                                          size="sm"
                                        >
                                          {m.strategy} {m.confidence}
                                        </StatusBadge>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        ) : null}

                        {summary.unresolved.length ? (
                          <div>
                            <h4 className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-app-warning">
                              <HiOutlineExclamationCircle className="h-3.5 w-3.5" />
                              Unresolved — a generator would have to guess these
                            </h4>
                            <div className="space-y-1.5">
                              {summary.unresolved.map(gap => (
                                <div
                                  key={gap.step_number}
                                  className="rounded-app border border-orange-200 bg-app-warning-bg px-3 py-2 text-[12px]"
                                >
                                  <div className="font-semibold text-app-warning">
                                    Step {gap.step_number}: {gap.target}
                                  </div>
                                  <div className="mt-0.5 text-app-warning/90">{gap.reason}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}
        </SectionCard>
      ) : null}

      {/* ── Element catalogue ──────────────────────────────────────────── */}
      <SectionCard
        title="Discovered elements"
        description="Every control the crawl found, with a locator that was verified to resolve uniquely at crawl time — not a guess."
        noPadding
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <HiOutlineSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-app-secondary" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search name or locator…"
                className="app-input w-[220px] pl-8"
              />
            </div>
            <select
              value={roleFilter}
              onChange={e => setRoleFilter(e.target.value)}
              className="app-input"
              aria-label="Filter by role"
            >
              <option value="">All roles</option>
              {roles.map(role => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </div>
        }
      >
        {elements.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No elements catalogued"
              description="Run discovery against the application, and every control it renders appears here."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="app-table">
              <thead>
                <tr>
                  <th className="text-left">Role</th>
                  <th className="text-left">Accessible name</th>
                  <th className="text-left">Recommended locator</th>
                  <th className="text-left">Strategy</th>
                  <th className="text-left">Page</th>
                </tr>
              </thead>
              <tbody>
                {visibleElements.map(element => (
                  <tr key={element.id}>
                    <td>
                      <StatusBadge tone="neutral" size="sm">
                        {element.role ?? '—'}
                      </StatusBadge>
                    </td>
                    <td className="text-[12px] text-app-primary">{element.accessible_name}</td>
                    <td className="font-mono text-[11px] text-app-brand-700">
                      {element.recommended_locator}
                    </td>
                    <td>
                      <span
                        title={
                          element.recommended_strategy === 'placeholder'
                            ? 'Fell back to the placeholder because the label is not associated with the input.'
                            : undefined
                        }
                      >
                        <StatusBadge
                          tone={STRATEGY_TONE[element.recommended_strategy] ?? 'neutral'}
                          size="sm"
                        >
                          {element.recommended_strategy} · {element.confidence_score}
                        </StatusBadge>
                      </span>
                    </td>
                    <td className="max-w-[220px] truncate text-[11px] text-app-secondary">
                      {element.page_title || element.page_url}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  )
}

export default Discovery
