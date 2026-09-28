import React, { useEffect, useMemo, useState } from 'react'
import knowledgeBaseService, { type TaxonomyNode } from '../../services/knowledgeBaseService'
import { Card, Chip, Failed, JOURNEY_STATUS, Loading, Note, StatusChip, TableHead, chapterTitle, useLoad } from './kbUi'

type DetailTab = 'steps' | 'rules' | 'branches' | 'scenarios' | 'questions'

const STEP_COLS = 'grid-cols-[28px_minmax(0,1fr)_auto]'

const JourneysStage: React.FC<{ appKey: string; onOpenStage: (stage: string) => void }> = ({ appKey, onOpenStage }) => {
  const [taxonomy, taxError, reloadTaxonomy] = useLoad(appKey, () => knowledgeBaseService.taxonomy(appKey))
  const [selected, setSelected] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<DetailTab>('steps')

  const byId = useMemo(() => new Map((taxonomy?.nodes ?? []).map(n => [n.id, n])), [taxonomy])

  // Open on the first authored journey, with its branch of the tree expanded.
  useEffect(() => {
    if (!taxonomy || selected) return
    const first = taxonomy.authored[0] ?? null
    setSelected(first)
    const open = new Set<string>()
    let cursor = first ? byId.get(first)?.parent : null
    while (cursor) { open.add(cursor); cursor = byId.get(cursor)?.parent ?? null }
    setExpanded(open)
  }, [taxonomy, byId, selected])

  const [detail, detailError, reloadDetail] = useLoad(selected ? `${appKey}:${selected}` : null, () =>
    knowledgeBaseService.journey(appKey, selected as string)
  )
  useEffect(() => setTab('steps'), [selected])

  const leaves = (taxonomy?.nodes ?? []).filter(n => n.kind !== 'chapter' && n.children.length === 0)
  const counts = leaves.reduce<Record<string, number>>((acc, n) => ({ ...acc, [n.status]: (acc[n.status] ?? 0) + 1 }), {})
  const needle = query.trim().toLowerCase()
  const matches = needle ? leaves.filter(n => n.title.toLowerCase().includes(needle)).slice(0, 60) : []

  const toggle = (id: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const renderNode = (node: TaxonomyNode, depth: number): React.ReactNode => {
    const isOpen = expanded.has(node.id)
    const leafCount = node.kind === 'chapter' ? leaves.filter(l => l.chapter === node.chapter).length : null
    const active = node.id === selected
    return (
      <React.Fragment key={node.id}>
        <button
          type="button"
          onClick={() => (node.children.length ? toggle(node.id) : setSelected(node.id))}
          aria-expanded={node.children.length ? isOpen : undefined}
          aria-current={active ? 'true' : undefined}
          className={`flex w-full items-center justify-between gap-2 rounded-[8px] py-1.5 pr-2 text-left text-[12.5px] ${
            active ? 'bg-[#FFF5F5] font-bold text-[#941216]' : node.kind === 'chapter' ? 'font-bold text-[#1F2937] hover:bg-[#F9FAFB]' : 'text-[#374151] hover:bg-[#F9FAFB]'
          }`}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          <span className="min-w-0 truncate">
            {node.children.length ? (isOpen ? '▾ ' : '▸ ') : ''}
            {node.kind === 'chapter' ? chapterTitle(node.title) : node.title}
            {node.kind === 'shared' && <span className="ml-1 text-[10.5px] font-normal text-[#6B7280]">shared</span>}
          </span>
          {leafCount !== null ? (
            <span className="text-[11px] font-normal text-[#6B7280]">{leafCount}</span>
          ) : !node.children.length ? (
            <span title={JOURNEY_STATUS[node.status]?.label} className={`h-2 w-2 flex-shrink-0 rounded-full ${JOURNEY_STATUS[node.status]?.dot}`} />
          ) : null}
        </button>
        {isOpen && node.children.map(id => byId.get(id)).filter(Boolean).map(child => renderNode(child as TaxonomyNode, depth + 1))}
      </React.Fragment>
    )
  }

  const j = detail?.journey
  const node = detail?.node

  return (
    <div className="grid gap-4 xl:grid-cols-[330px_minmax(0,1fr)]">
      <Card label="Journey hierarchy" className="flex max-h-[760px] flex-col">
        <div className="flex flex-col gap-2.5 border-b border-[#F1F2F4] p-3.5">
          <label htmlFor="kb-journey-search" className="text-[12px] font-bold text-[#374151]">Journeys · A → B → C</label>
          <input
            id="kb-journey-search"
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={`Search ${leaves.length || ''} journeys`}
            className="h-[34px] rounded-[10px] border border-[#E8EAEE] bg-[#F9FAFB] px-3 text-[13px]"
          />
          <div className="flex flex-wrap gap-1.5">
            {(['detailed', 'source_available', 'automation_only', 'awaiting_source'] as const).map(s => (
              <Chip key={s} tone={JOURNEY_STATUS[s].tone}>{JOURNEY_STATUS[s].label} {counts[s] ?? 0}</Chip>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-auto p-2">
          {taxError && <Failed message={taxError} onRetry={reloadTaxonomy} />}
          {!taxonomy && !taxError && <Loading what="journeys" />}
          {needle
            ? matches.map(n => renderNode({ ...n, children: [] }, 0))
            : taxonomy?.roots.map(id => byId.get(id)).filter(Boolean).map(n => renderNode(n as TaxonomyNode, 0))}
          {needle && matches.length === 0 && <p className="px-2 py-4 text-[12.5px] text-[#6B7280]">No journey matches “{query}”.</p>}
        </div>
      </Card>

      <Card label="Journey detail" className="flex min-w-0 flex-col">
        {detailError && <Failed message={detailError} onRetry={reloadDetail} />}
        {!detail && !detailError && <Loading what="the journey" />}
        {node && (
          <div className="flex flex-col gap-2 border-b border-[#F1F2F4] px-5 pb-3 pt-4">
            <span className="text-[12px] text-[#6B7280]">{(j?.journey_path ?? []).slice(0, -1).map((part, i) => (i === 0 ? chapterTitle(part) : part)).join(' › ') || node.chapter}</span>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="m-0 text-[20px] font-bold text-[#1F2937]">{node.title}</h2>
                <Chip tone={JOURNEY_STATUS[node.status]?.tone ?? 'idle'}>{JOURNEY_STATUS[node.status]?.label ?? node.status}</Chip>
                <code className="text-[11.5px] text-[#6B7280]">{node.id}</code>
              </div>
              {j && (
                <div className="flex gap-2">
                  <button type="button" onClick={() => onOpenStage('crawl')} className="h-[34px] rounded-[12px] border border-[#E8EAEE] bg-white px-3.5 text-[13px] font-bold text-[#1F2937] hover:border-[#F6D4D5]">Crawl</button>
                  <button type="button" onClick={() => onOpenStage('reconcile')} className="h-[34px] rounded-[12px] bg-[#B71920] px-3.5 text-[13px] font-bold text-white hover:opacity-95">Reconcile</button>
                </div>
              )}
            </div>
            {j && (
              <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-[#4B5563]">
                <span className="font-semibold text-[#374151]">Runs as</span>
                {j.chain.map((c, i) => (
                  <React.Fragment key={c.journey_id}>
                    {i > 0 && <span>→</span>}
                    <button type="button" onClick={() => setSelected(c.journey_id)} className={`rounded-[8px] px-2.5 py-0.5 font-semibold ${c.journey_id === j.journey_id ? 'bg-[#FFF5F5] text-[#941216]' : 'bg-[#F4F5F7] text-[#374151]'}`}>{c.name}</button>
                  </React.Fragment>
                ))}
                {j.next.length > 0 && <span>→ then {j.next.map(n => n.name).join(' or ')}</span>}
                <span className="ml-auto">Source: {j.sources.join(', ')}</span>
              </div>
            )}
          </div>
        )}

        {node && !j && (
          <div className="flex flex-col gap-3 p-5">
            <Note>
              {node.status === 'automation_only'
                ? 'This journey exists in the Automation KB (crawled) but has no design document yet. Its flow blueprint is under the Automation KB stage.'
                : node.status === 'source_available'
                  ? 'A screen-level design document for this journey has been analysed; the journey file is authored in the next phase (PDF extraction with review).'
                  : 'Only the title from the master topic list is known. Upload a BRD or screen-flow document for it once extraction is available.'}
            </Note>
          </div>
        )}

        {j && (
          <>
            <div role="tablist" className="flex gap-1 border-b border-[#F1F2F4] px-4 text-[13px]">
              {([
                ['steps', `Steps ${j.steps.length}`],
                ['rules', `Rules ${j.rules.length}`],
                ['branches', `Branches ${j.conditional_branches.length}`],
                ['scenarios', `Scenarios ${j.test_scenarios.length}`],
                ['questions', `Open questions ${j.open_questions.length}`]
              ] as [DetailTab, string][]).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => setTab(id)}
                  className={`h-10 border-b-2 px-3 ${tab === id ? 'border-[#B71920] font-bold text-[#1F2937]' : 'border-transparent text-[#6B7280] hover:text-[#1F2937]'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_280px]">
              <div className="min-w-0">
                {tab === 'steps' && (
                  <>
                    <TableHead cols={STEP_COLS} labels={['#', 'Action → expected · screen', 'In app']} />
                    {j.steps.map(step => (
                      <div key={step.step_number} className={`grid ${STEP_COLS} items-center gap-3 border-b border-[#F1F2F4] px-5 py-2 text-[12.5px] ${step.link.status === 'LABEL_DRIFT' ? 'bg-[#FFFCF7]' : ''}`}>
                        <span className="font-bold">{step.step_number}</span>
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span>
                            {step.action}
                            {step.branch === 'negative_only' && <span className="ml-1.5 text-[11px] text-[#A3231C]">error path only</span>}
                          </span>
                          <span className="text-[#6B7280]">{step.expected_result}</span>
                          <span className="text-[11.5px] text-[#9CA3AF]">{step.screen_name ?? step.screen_id ?? '—'}{step.element_id ? ` · ${step.element_id}` : ''}</span>
                        </span>
                        <StatusChip status={step.link.status} title={step.link.automation_target ?? undefined} />
                      </div>
                    ))}
                  </>
                )}
                {tab === 'rules' && (
                  <div className="flex flex-col gap-3 p-5 text-[12.5px]">
                    {j.rules.map(r => (
                      <div key={r.rule_id} className="flex gap-3">
                        <Chip tone={r.basis === 'inferred' ? 'warn' : 'good'}>{r.basis}</Chip>
                        <span><strong>{r.rule_id}</strong> · {r.statement}{r.message && <> Message: <em>‘{r.message}’</em></>}</span>
                      </div>
                    ))}
                  </div>
                )}
                {tab === 'branches' && (
                  <div className="flex flex-col gap-3 p-5 text-[12.5px]">
                    {j.conditional_branches.map(b => (
                      <span key={b.branch_id}><strong>At step {b.at_step}</strong> · if {b.condition} → {b.outcome} {b.rule && <span className="text-[#6B7280]">({b.rule})</span>}</span>
                    ))}
                  </div>
                )}
                {tab === 'scenarios' && (
                  <div className="flex flex-col gap-2 p-5 text-[12.5px]">
                    {j.test_scenarios.map(s => (
                      <div key={s.scenario_id} className="flex items-center gap-3">
                        <code className="w-[84px] text-[11.5px] text-[#6B7280]">{s.scenario_id}</code>
                        <Chip tone={s.type === 'positive' ? 'good' : s.type === 'negative' ? 'bad' : 'idle'}>{s.type}</Chip>
                        <span className="min-w-0 flex-1">{s.title}</span>
                        {s.test_data && <button type="button" onClick={() => onOpenStage('testdata')} className="text-[11.5px] font-semibold text-[#B71920] hover:underline">{s.test_data}</button>}
                      </div>
                    ))}
                  </div>
                )}
                {tab === 'questions' && (
                  <div className="flex flex-col gap-2 p-5 text-[12.5px]">
                    {j.open_questions.map(q => <span key={q}>• {q}</span>)}
                  </div>
                )}
              </div>
              <aside aria-label="Dependencies" className="flex flex-col gap-4 border-l border-[#F1F2F4] p-4 text-[12.5px]">
                {j.open_questions.length > 0 && (
                  <Note tone="warn">
                    <strong className="block text-[11px] tracking-[0.1em]">OPEN QUESTIONS · {j.open_questions.length}</strong>
                    {j.open_questions.slice(0, 3).map(q => <span key={q} className="mt-1 block">{q}</span>)}
                  </Note>
                )}
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-bold tracking-[0.1em] text-[#6B7280]">AFFECTED WHEN THIS CHANGES</span>
                  {j.used_by.length === 0 && <span className="text-[#6B7280]">Nothing depends on it yet.</span>}
                  {j.used_by.map(u => (
                    <button key={u.journey_id + u.relation} type="button" onClick={() => setSelected(u.journey_id)} className="text-left hover:text-[#B71920]">
                      {u.name} <span className="text-[#6B7280]">· {u.relation}</span>
                    </button>
                  ))}
                </div>
                {j.roles.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[11px] font-bold tracking-[0.1em] text-[#6B7280]">ROLES</span>
                    <span>{j.roles.join(', ')}</span>
                  </div>
                )}
              </aside>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}

export default JourneysStage
