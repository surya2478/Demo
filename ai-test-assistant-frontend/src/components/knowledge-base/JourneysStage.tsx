import React, { useEffect, useMemo, useState } from 'react'
import knowledgeBaseService, { type JourneyEditResult, type TaxonomyNode } from '../../services/knowledgeBaseService'
import { useConfirm } from '../ui/ConfirmDialog'
import { useToast } from '../ui/Toast'
import { BranchesEditor, LinksEditor, RuleRow, ScenariosEditor } from './JourneyListEditors'
import { EditStrip, useKbEdit } from './kbEdit'
import { Card, Chip, Failed, JOURNEY_STATUS, Loading, Note, StatusChip, TableHead, chapterTitle, useLoad } from './kbUi'

type DetailTab = 'steps' | 'rules' | 'branches' | 'scenarios' | 'questions'

const STEP_COLS = 'grid-cols-[28px_minmax(0,1fr)_auto]'

const TREE_BTN = 'flex h-6 w-6 items-center justify-center rounded-[6px] text-[12px] text-[#6B7280] hover:bg-white hover:text-[#B71920]'

// The tree and a journey's steps are editable: every edit is drafted as a
// change set (reviewed under "Review change sets"), or published at once by
// someone who may approve. Ids never change -- a renamed journey keeps the id
// its files, test cases and crawls name.
type TreeEdit = { mode: 'rename' | 'add'; id: string | null; title: string }

const JourneysStage: React.FC<{
  appKey: string
  onOpenStage: (stage: string, extra?: Record<string, string>) => void
  canExecute?: boolean
  canApprove?: boolean
  /** A change set was drafted or published: the page refreshes its review count. */
  onEdited?: () => void
}> = ({ appKey, onOpenStage, canExecute = false, canApprove = false, onEdited }) => {
  const confirm = useConfirm()
  const toast = useToast()
  const [treeEdit, setTreeEdit] = useState<TreeEdit | null>(null)
  const [busy, setBusy] = useState(false)
  // Publish edits at once, or leave them for review. Only an approver chooses;
  // the choice is shared with the other Knowledge Base editors.
  const kbEdit = useKbEdit(canApprove, onEdited)
  const { publishNow, setPublishNow, publish } = kbEdit
  const [editingPart, setEditingPart] = useState<null | 'branches' | 'scenarios' | 'links'>(null)
  const [taxonomy, taxError, reloadTaxonomy] = useLoad(appKey, () => knowledgeBaseService.taxonomy(appKey))
  const [selected, setSelected] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<DetailTab>('steps')

  const byId = useMemo(() => new Map((taxonomy?.nodes ?? []).map(n => [n.id, n])), [taxonomy])
  const verified = useMemo(() => new Set(taxonomy?.verified ?? []), [taxonomy])

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
  useEffect(() => { setTab('steps'); setEditingPart(null) }, [selected])
  useEffect(() => setEditingPart(prev => (prev === 'links' ? prev : null)), [tab])

  // Edits to the open journey's branches, scenarios, links and rules.
  const reloadAll = () => { reloadTaxonomy(); reloadDetail() }
  const saveJourneyPart = (what: string, edit: (publish: boolean) => Promise<any>) =>
    kbEdit.run(what, edit, () => { setEditingPart(null); reloadAll() })

  const moveNode = (node: TaxonomyNode, direction: 'up' | 'down') =>
    kbEdit.run('Order', p => knowledgeBaseService.moveJourney(appKey, node.id, direction, p), reloadTaxonomy)

  const deleteRule = async (ruleId: string) => {
    const ok = await confirm({
      title: `Delete rule ${ruleId}?`,
      consequences: [
        'It is removed from the business rules, and from every journey, step, branch and scenario that cites it.',
        publish ? 'Published now; History can revert it.' : 'Saved for review; nothing changes until it is approved.'
      ],
      confirmLabel: publish ? `Delete ${ruleId}` : 'Save deletion for review',
      tone: 'danger'
    })
    if (ok) await kbEdit.run('Rule deletion', p => knowledgeBaseService.removeRule(appKey, ruleId, p), reloadAll)
  }

  const afterEdit = (result: JourneyEditResult, what: string) => {
    if (result.published) {
      toast.success(`${what} published`, result.version ? `Journey KB version ${result.version.number}.` : undefined)
    } else {
      toast.info(`${what} saved for review`, result.message ?? `Change set #${result.change_set.id} is waiting under Review change sets.`)
    }
    reloadTaxonomy()
    if (selected) reloadDetail()
    onEdited?.()
  }

  const failure = (error: any, what: string) => {
    const detail = error?.response?.data?.detail
    toast.error(`${what} failed`, typeof detail === 'string' ? detail : detail?.message ?? error?.message)
  }

  const submitTree = async () => {
    if (!treeEdit) return
    const title = treeEdit.title.trim()
    if (!title) return
    setBusy(true)
    try {
      if (treeEdit.mode === 'rename' && treeEdit.id) {
        afterEdit(await knowledgeBaseService.renameJourney(appKey, treeEdit.id, title, publish), 'Rename')
      } else {
        const result = await knowledgeBaseService.addJourney(appKey, treeEdit.id, title, publish)
        afterEdit(result, treeEdit.id ? 'New journey' : 'New chapter')
        if (treeEdit.id) setExpanded(prev => new Set(prev).add(treeEdit.id as string))
      }
      setTreeEdit(null)
    } catch (error) {
      failure(error, treeEdit.mode === 'rename' ? 'Rename' : 'Adding the journey')
    } finally {
      setBusy(false)
    }
  }

  const removeNode = async (node: TaxonomyNode) => {
    let preview
    try {
      preview = await knowledgeBaseService.journeyRemoval(appKey, node.id)
    } catch (error) {
      failure(error, 'Checking the journey')
      return
    }
    const consequences = [
      preview.journeys > 1 ? `${preview.journeys - 1} journey${preview.journeys === 2 ? '' : 's'} below it go too.` : 'Nothing is below it.',
      preview.authored.length
        ? `${preview.authored.length} authored journey file${preview.authored.length === 1 ? '' : 's'} deleted (steps, branches, scenarios) and no longer used for generation or crawls.`
        : 'No authored steps are lost.',
      ...preview.dependents.map(d => `${d.name} still ${d.relation}.`),
      publish ? 'Published now; History can revert it.' : 'Saved for review; nothing changes until it is approved.'
    ]
    const ok = await confirm({
      title: `Remove "${node.kind === 'chapter' ? chapterTitle(node.title) : node.title}"?`,
      consequences,
      confirmLabel: publish ? 'Remove journey' : 'Save removal for review',
      tone: 'danger'
    })
    if (!ok) return
    setBusy(true)
    try {
      afterEdit(await knowledgeBaseService.removeJourney(appKey, node.id, publish), 'Removal')
      if (publish && selected) {
        let cursor: string | null = selected
        while (cursor) {
          if (cursor === node.id) { setSelected(null); break }
          cursor = byId.get(cursor)?.parent ?? null
        }
      }
    } catch (error) {
      failure(error, 'Removing the journey')
    } finally {
      setBusy(false)
    }
  }

  const titleInput = (placeholder: string) => (
    <form onSubmit={e => { e.preventDefault(); void submitTree() }} className="flex items-center gap-1.5 py-1 pr-1">
      <input
        autoFocus
        aria-label={placeholder}
        value={treeEdit?.title ?? ''}
        placeholder={placeholder}
        disabled={busy}
        onChange={e => setTreeEdit(prev => (prev ? { ...prev, title: e.target.value } : prev))}
        onKeyDown={e => { if (e.key === 'Escape') setTreeEdit(null) }}
        className="h-[30px] min-w-0 flex-1 rounded-[8px] border border-[#B71920] bg-white px-2 text-[12.5px] focus:outline-none"
      />
      <button type="submit" disabled={busy || !treeEdit?.title.trim()} className="h-[30px] rounded-[8px] bg-[#B71920] px-2.5 text-[12px] font-bold text-white disabled:opacity-50">
        {publish ? 'Save' : 'Draft'}
      </button>
      <button type="button" onClick={() => setTreeEdit(null)} className="h-[30px] rounded-[8px] px-1.5 text-[12px] text-[#6B7280] hover:text-[#1F2937]">Cancel</button>
    </form>
  )

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
    const label = node.kind === 'chapter' ? chapterTitle(node.title) : node.title
    if (treeEdit?.mode === 'rename' && treeEdit.id === node.id) {
      return <div key={node.id} style={{ paddingLeft: 4 + depth * 14 }}>{titleInput(`New name for ${label}`)}</div>
    }
    return (
      <React.Fragment key={node.id}>
        <div className="group relative">
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
          ) : !node.children.length && verified.has(node.id) ? (
            <span title="Verified: the flow matches the journey and a walk confirmed every step" aria-label="Verified" className="flex-shrink-0 text-[13px] font-bold leading-none text-[#136B34]">✓</span>
          ) : !node.children.length ? (
            <span title={JOURNEY_STATUS[node.status]?.label} className={`h-2 w-2 flex-shrink-0 rounded-full ${JOURNEY_STATUS[node.status]?.dot}`} />
          ) : null}
        </button>
        {canExecute && !treeEdit && (
          <span className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-[8px] bg-[#F4F5F7] px-0.5 shadow-sm group-hover:flex group-focus-within:flex">
            <button type="button" className={TREE_BTN} title="Move up" aria-label={`Move ${label} up`} onClick={() => void moveNode(node, 'up')}>↑</button>
            <button type="button" className={TREE_BTN} title="Move down" aria-label={`Move ${label} down`} onClick={() => void moveNode(node, 'down')}>↓</button>
            <button type="button" className={TREE_BTN} title="Add a journey under this" aria-label={`Add a journey under ${label}`}
              onClick={() => { setTreeEdit({ mode: 'add', id: node.id, title: '' }); setExpanded(prev => new Set(prev).add(node.id)) }}>+</button>
            <button type="button" className={TREE_BTN} title="Rename" aria-label={`Rename ${label}`}
              onClick={() => setTreeEdit({ mode: 'rename', id: node.id, title: node.title })}>✎</button>
            <button type="button" className={`${TREE_BTN} hover:text-[#A3231C]`} title="Remove" aria-label={`Remove ${label}`}
              onClick={() => void removeNode(node)}>✕</button>
          </span>
        )}
        </div>
        {isOpen && node.children.map(id => byId.get(id)).filter(Boolean).map(child => renderNode(child as TaxonomyNode, depth + 1))}
        {treeEdit?.mode === 'add' && treeEdit.id === node.id && (
          <div style={{ paddingLeft: 4 + (depth + 1) * 14 }}>{titleInput(`New journey under ${label}`)}</div>
        )}
      </React.Fragment>
    )
  }

  // Older/imported journey records can omit collection fields. Normalise them
  // at the UI boundary so one incomplete record cannot crash the whole stage.
  const rawJourney = detail?.journey
  const j = rawJourney ? {
    ...rawJourney,
    journey_path: rawJourney.journey_path ?? [],
    chain: rawJourney.chain ?? [],
    next: rawJourney.next ?? [],
    sources: rawJourney.sources ?? [],
    steps: rawJourney.steps ?? [],
    rules: rawJourney.rules ?? [],
    conditional_branches: rawJourney.conditional_branches ?? [],
    test_scenarios: rawJourney.test_scenarios ?? [],
    open_questions: rawJourney.open_questions ?? [],
    used_by: rawJourney.used_by ?? [],
    roles: rawJourney.roles ?? []
  } : undefined
  const node = detail?.node

  return (
    <div className="grid gap-4 xl:grid-cols-[330px_minmax(0,1fr)]">
      <Card label="Journey hierarchy" className="flex max-h-[760px] flex-col">
        <div className="flex flex-col gap-2.5 border-b border-[#F1F2F4] p-3.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="kb-journey-search" className="text-[12px] font-bold text-[#374151]">Journeys · A → B → C</label>
            {canExecute && (
              <button type="button" disabled={!!treeEdit} onClick={() => setTreeEdit({ mode: 'add', id: null, title: '' })}
                className="text-[12px] font-semibold text-[#B71920] hover:underline disabled:opacity-40">+ Chapter</button>
            )}
          </div>
          {canExecute && (
            canApprove ? (
              <label className="flex items-center gap-2 text-[11.5px] text-[#4B5563]">
                <input type="checkbox" checked={publishNow} onChange={e => setPublishNow(e.target.checked)} className="accent-[#B71920]" />
                Publish edits immediately <span className="text-[#9CA3AF]">(off: save for review)</span>
              </label>
            ) : (
              <span className="text-[11.5px] text-[#6B7280]">Edits are saved for review by an approver.</span>
            )
          )}
          {treeEdit?.mode === 'add' && treeEdit.id === null && titleInput('New chapter name')}
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
                <Chip tone={j?.source?.kind === 'agent_prepared' ? 'info' : JOURNEY_STATUS[node.status]?.tone ?? 'idle'}>{j?.source?.kind === 'agent_prepared' ? 'Agent-authored · source document unlinked' : JOURNEY_STATUS[node.status]?.label ?? node.status}</Chip>
                {(verified.has(node.id) || j?.verified) && <Chip tone="good" title="Verified: the flow matches the journey and a walk confirmed every step">✓ Verified</Chip>}
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
                {canExecute && editingPart !== 'links' && (
                  <button type="button" onClick={() => setEditingPart('links')} className="rounded-[8px] px-2 py-0.5 text-[12px] font-semibold text-[#B71920] hover:bg-[#FFF5F5]">
                    ✎ Edit linked journeys
                  </button>
                )}
                <span className="ml-auto">Source: {j.sources?.length ? j.sources.join(', ') : j.source?.kind === 'agent_prepared' ? 'Test Assistant agent capture' : 'No source document linked'}</span>
              </div>
            )}
            {j && editingPart === 'links' && (
              <LinksEditor
                journeyId={j.journey_id}
                prerequisites={j.prerequisite_journeys ?? []}
                next={j.next_journeys ?? []}
                options={taxonomy?.nodes ?? []}
                busy={kbEdit.busy}
                publish={publish}
                onCancel={() => setEditingPart(null)}
                onSave={links => void saveJourneyPart('Linked journeys', p => knowledgeBaseService.editLinks(appKey, j.journey_id, links, p))}
              />
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
                    {canExecute && (
                      <div className="flex items-center justify-between gap-2 border-b border-[#F1F2F4] px-5 py-2 text-[12px] text-[#6B7280]">
                        <span>Steps are edited on the Journey Map, beside their selectors and the flow blueprint generated from them.</span>
                        <button type="button" onClick={() => onOpenStage('map', { journey: j.journey_id })}
                          className="h-[30px] flex-shrink-0 rounded-[10px] bg-[#B71920] px-3 text-[12.5px] font-bold text-white hover:opacity-95">
                          Edit on Journey Map
                        </button>
                      </div>
                    )}
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
                          {step.link.note && <span className="text-[11.5px] text-[#A3231C]">{step.link.note}: fix it on the Journey Map</span>}
                        </span>
                        {step.link.status === 'NOT_CRAWLED' && step.link.observed_control
                          ? <Chip tone="info" title="A browser control was captured, but no approved Automation KB locator is linked. This step is not executable yet.">Captured · not mapped</Chip>
                          : <StatusChip status={step.link.status} title={step.link.automation_target ?? step.link.note} />}
                      </div>
                    ))}
                  </>
                )}
                {tab === 'rules' && (
                  <div className="flex flex-col gap-3 p-5 text-[12.5px]">
                    {j.rules.length === 0 && <span className="text-[#6B7280]">This journey cites no business rules.</span>}
                    {j.rules.map(r => (
                      <RuleRow
                        key={r.rule_id}
                        rule={r}
                        canEdit={canExecute}
                        busy={kbEdit.busy}
                        publish={publish}
                        basisChip={<Chip tone={r.basis === 'inferred' ? 'warn' : 'good'}>{r.basis}</Chip>}
                        onSave={(statement, message) => kbEdit.run('Rule', p => knowledgeBaseService.editRule(appKey, r.rule_id, statement, message || null, p), reloadAll)}
                        onDelete={() => void deleteRule(r.rule_id)}
                      />
                    ))}
                  </div>
                )}
                {tab === 'branches' && editingPart === 'branches' && (
                  <BranchesEditor
                    branches={j.conditional_branches}
                    stepCount={j.steps.length}
                    ruleIds={Array.from(new Set([...j.rules.map(r => r.rule_id), ...j.conditional_branches.map(b => b.rule).filter((x): x is string => !!x)]))}
                    busy={kbEdit.busy}
                    publish={publish}
                    onCancel={() => setEditingPart(null)}
                    onSave={items => void saveJourneyPart('Branches', p => knowledgeBaseService.editBranches(appKey, j.journey_id, items, p))}
                  />
                )}
                {tab === 'branches' && editingPart !== 'branches' && canExecute && (
                  <EditStrip hint="What happens when a step goes another way: the condition, the outcome, and the rule behind it." label="Edit branches" onEdit={() => setEditingPart('branches')} />
                )}
                {tab === 'branches' && editingPart !== 'branches' && (
                  <div className="flex flex-col gap-3 p-5 text-[12.5px]">
                    {j.conditional_branches.length === 0 && <span className="text-[#6B7280]">No branches yet.</span>}
                    {j.conditional_branches.map(b => (
                      <span key={b.branch_id}><strong>At step {b.at_step}</strong> · if {b.condition} → {b.outcome} {b.rule && <span className="text-[#6B7280]">({b.rule})</span>}</span>
                    ))}
                  </div>
                )}
                {tab === 'scenarios' && editingPart === 'scenarios' && (
                  <ScenariosEditor
                    scenarios={j.test_scenarios}
                    stepCount={j.steps.length}
                    branchIds={j.conditional_branches.map(b => b.branch_id)}
                    busy={kbEdit.busy}
                    publish={publish}
                    onCancel={() => setEditingPart(null)}
                    onSave={items => void saveJourneyPart('Scenarios', p => knowledgeBaseService.editScenarios(appKey, j.journey_id, items, p))}
                  />
                )}
                {tab === 'scenarios' && editingPart !== 'scenarios' && canExecute && (
                  <EditStrip hint="The test scenarios this journey implies: which steps they walk and which branch they take." label="Edit scenarios" onEdit={() => setEditingPart('scenarios')} />
                )}
                {tab === 'scenarios' && editingPart !== 'scenarios' && (
                  <div className="flex flex-col gap-2 p-5 text-[12.5px]">
                    {j.test_scenarios.length === 0 && <span className="text-[#6B7280]">No scenarios yet.</span>}
                    {j.test_scenarios.map(s => (
                      <div key={s.scenario_id} className="flex items-center gap-3">
                        <code className="w-[84px] text-[11.5px] text-[#6B7280]">{s.scenario_id}</code>
                        <Chip tone={s.type === 'positive' ? 'good' : s.type === 'negative' ? 'bad' : 'idle'}>{s.type}</Chip>
                        <span className="min-w-0 flex-1">
                          {s.title}
                          {(s.steps?.length || s.branch) && (
                            <span className="ml-1.5 text-[11.5px] text-[#9CA3AF]">
                              {s.steps?.length ? `steps ${s.steps.join(', ')}` : ''}{s.branch ? ` · ${s.branch}` : ''}
                            </span>
                          )}
                        </span>
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
