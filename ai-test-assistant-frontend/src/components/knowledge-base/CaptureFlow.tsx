import React, { useCallback, useEffect, useMemo, useState } from 'react'
import knowledgeBaseService, {
  errorText, type CaptureEdits, type CaptureFlowPage, type CaptureFlowStep, type CaptureJourneyDraft, type CaptureJourneyStep,
  type CapturePreview, type InboxCapture, type KbTaxonomy
} from '../../services/knowledgeBaseService'
import { Chip, Note, TONE } from './kbUi'

// --- The captures inbox, and one capture as a flow ---------------------------------------
//
// Captures the tool sent with "Send to Knowledge Base" wait here. Opened, a
// capture is matched to the chosen journey without storing anything
// (POST /captures/{id}/preview) and drawn as a flow: its pages in order, each
// with the journey steps it answers and its objects -- which design element
// each one is, and whether its label differs from the KB. The reviewer puts
// pages in order, drops pages or objects, chooses a page's screen or the
// object a step uses; every change is saved on the capture and matched again.
// "Import for review" then stores it as a walk, reviewed like any other:
// propose, Generate flow, change sets, approve and publish.

const BTN = 'h-[30px] rounded-[9px] border border-[#E8EAEE] bg-white px-2.5 text-[12px] font-bold text-[#1F2937] hover:border-[#F6D4D5] disabled:cursor-not-allowed disabled:opacity-40'
const PRIMARY = 'h-[34px] rounded-[10px] bg-[#B71920] px-4 text-[13px] font-bold text-white hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50'
const SELECT = 'h-[30px] min-w-0 rounded-[8px] border border-[#E8EAEE] bg-white px-2 text-[12px] text-[#1F2937]'

const OUTCOME: Record<string, { label: string; tone: keyof typeof TONE }> = {
  confirmed: { label: 'KB selector confirmed', tone: 'good' },
  new: { label: 'New for the KB', tone: 'info' },
  healed: { label: 'Healed selector', tone: 'warn' },
  kb_failed: { label: 'KB selector failed', tone: 'bad' },
  not_found: { label: 'Not found', tone: 'bad' },
  not_reached: { label: 'Not reached', tone: 'idle' },
  not_applicable: { label: 'Not applicable', tone: 'idle' }
}
const STEP_STATUS: Record<string, { label: string; tone: keyof typeof TONE }> = {
  done: { label: 'Found', tone: 'good' },
  not_found: { label: 'Not found', tone: 'bad' },
  not_reached: { label: 'Not captured', tone: 'idle' },
  not_applicable: { label: 'Optional', tone: 'idle' },
  skipped: { label: 'Skipped', tone: 'idle' }
}
const KIND_TONE: Record<string, keyof typeof TONE> = { control: 'idle', text: 'info', picked: 'brand' }

const when = (iso: string | null) => (iso ? new Date(`${iso}Z`).toLocaleString() : '')

// --- One capture as a flow ---------------------------------------------------------------

const PageCard: React.FC<{
  page: CaptureFlowPage
  index: number
  count: number
  selected: boolean
  screens: CapturePreview['screens']
  locked: boolean
  onSelect: () => void
  onMove: (dir: -1 | 1) => void
  onDrop: () => void
  onRename: (name: string) => void
  onScreen: (screenId: string | null) => void
}> = ({ page, index, count, selected, screens, locked, onSelect, onMove, onDrop, onRename, onScreen }) => {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(page.name)
  useEffect(() => setName(page.name), [page.name])
  const counts = { control: 0, text: 0, picked: 0 } as Record<string, number>
  page.elements.forEach(e => { counts[e.kind] = (counts[e.kind] ?? 0) + 1 })
  const used = page.elements.filter(e => e.uses.length > 0).length
  return (
    <div role="group" aria-label={`Page ${index + 1}: ${page.name}`}
      className={`flex w-[250px] flex-none flex-col gap-2 rounded-[14px] border bg-white p-3 text-[12px] shadow-sm ${selected ? 'border-[#B71920] ring-2 ring-[#FDEBEC]' : 'border-[#E8EAEE]'}`}>
      <div className="flex items-start gap-2">
        <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-[#1F2937] text-[11.5px] font-bold text-white">{index + 1}</span>
        {editing ? (
          <form className="flex min-w-0 flex-1 gap-1" onSubmit={e => { e.preventDefault(); onRename(name); setEditing(false) }}>
            <input aria-label="Page name" autoFocus value={name} onChange={e => setName(e.target.value)} className={`${SELECT} flex-1`} />
            <button type="submit" className={BTN}>OK</button>
          </form>
        ) : (
          <button type="button" className="min-w-0 flex-1 text-left" onClick={onSelect} title="Show this page's objects">
            <div className="truncate text-[13px] font-bold text-[#1F2937]" title={page.name}>{page.name}</div>
            <div className="truncate font-mono text-[11px] text-[#6B7280]" title={page.url ?? ''}>{page.path ?? page.url}</div>
          </button>
        )}
      </div>
      <label className="flex flex-col gap-0.5 text-[10.5px] font-bold uppercase tracking-[0.08em] text-[#6B7280]">
        Screen
        <select aria-label={`Screen of ${page.name}`} className={SELECT} disabled={locked}
          value={page.screen_chosen ? (page.screen_id ?? '') : '__auto__'}
          onChange={e => onScreen(e.target.value === '__auto__' ? null : e.target.value)}>
          <option value="__auto__">Auto: {screens.find(s => s.screen_id === page.auto_screen)?.name ?? 'none matched'}</option>
          <option value="">No screen</option>
          {screens.map(s => <option key={s.screen_id} value={s.screen_id}>{s.name}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap gap-1">
        {page.steps.length
          ? page.steps.map(n => <Chip key={n} tone="good">Step {n}</Chip>)
          : <Chip tone="idle" title="No journey step was answered on this page">No step</Chip>}
      </div>
      <div className="text-[11.5px] text-[#6B7280]">
        {counts.control} controls · {counts.text} texts{counts.picked ? ` · ${counts.picked} picked` : ''} · {used} matched
      </div>
      <div className="flex flex-wrap gap-1">
        <button type="button" className={BTN} disabled={locked || index === 0} onClick={() => onMove(-1)} aria-label={`Move ${page.name} earlier`} title="Earlier">←</button>
        <button type="button" className={BTN} disabled={locked || index === count - 1} onClick={() => onMove(1)} aria-label={`Move ${page.name} later`} title="Later">→</button>
        <button type="button" className={BTN} disabled={locked} onClick={() => setEditing(true)}>Rename</button>
        <button type="button" className={BTN} onClick={onSelect}>Objects</button>
        <button type="button" className={`${BTN} text-[#A3231C]`} disabled={locked || count === 1} onClick={onDrop} title="Leave this page out">Drop</button>
      </div>
    </div>
  )
}

const ObjectsTable: React.FC<{
  page: CaptureFlowPage
  dropped: string[]
  locked: boolean
  onToggle: (selector: string, keep: boolean) => void
}> = ({ page, dropped, locked, onToggle }) => {
  const [filter, setFilter] = useState<'all' | 'matched' | 'unmatched' | 'picked'>('all')
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  // Dropped objects are not in the preview (it is matched without them); list them to restore.
  const rows = page.elements.filter(e =>
    (filter === 'all' || (filter === 'matched' ? e.uses.length > 0 : filter === 'unmatched' ? e.uses.length === 0 : e.kind === 'picked'))
    && (!q || `${e.name} ${e.role ?? ''} ${e.selector}`.toLowerCase().includes(q)))
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'matched', 'unmatched', 'picked'] as const).map(f => (
          <button key={f} type="button" onClick={() => setFilter(f)} aria-pressed={filter === f}
            className={`h-7 rounded-full px-3 text-[12px] font-semibold ${filter === f ? 'bg-[#1F2937] text-white' : 'bg-[#F4F5F7] text-[#1F2937]'}`}>
            {f === 'all' ? `All ${page.elements.length}` : f === 'matched' ? 'Used by the journey' : f === 'unmatched' ? 'Not matched' : 'Picked'}
          </button>
        ))}
        <input aria-label="Search objects" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search label or XPath"
          className={`${SELECT} w-[220px]`} />
      </div>
      <div className="overflow-x-auto rounded-[12px] border border-[#E8EAEE]">
        <table className="w-full min-w-[760px] border-collapse text-[12px]">
          <thead className="bg-[#F4F5F7] text-left text-[10.5px] uppercase tracking-[0.08em] text-[#4B5563]">
            <tr><th className="w-[52px] px-3 py-2">Keep</th><th className="px-3 py-2">Object</th><th className="px-3 py-2">XPath</th><th className="px-3 py-2">In the journey</th></tr>
          </thead>
          <tbody>
            {rows.map(e => (
              <tr key={e.selector} className="border-t border-[#F1F2F4] align-top">
                <td className="px-3 py-2">
                  <input type="checkbox" checked aria-label={`Keep ${e.name}`} disabled={locked} onChange={() => onToggle(e.selector, false)} className="accent-[#B71920]" />
                </td>
                <td className="px-3 py-2">
                  <div className="font-semibold text-[#1F2937]">{e.name || <span className="text-[#9CA3AF]">(no name)</span>}</div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    <Chip tone={KIND_TONE[e.kind] ?? 'idle'}>{e.kind}</Chip>
                    {e.role && <Chip tone="idle">{e.role}</Chip>}
                    {e.action && <Chip tone="idle">{e.action}</Chip>}
                  </div>
                </td>
                <td className="max-w-[320px] px-3 py-2"><code className="block truncate text-[11px] text-[#374151]" title={e.selector}>{e.selector}</code></td>
                <td className="px-3 py-2">
                  {e.uses.length ? e.uses.map(u => (
                    <div key={`${u.screen_id}.${u.element_id}`} className="mb-1 flex flex-wrap items-center gap-1">
                      {u.step != null && <Chip tone="good">Step {u.step}</Chip>}
                      <span className="text-[#1F2937]">{u.design_label ?? u.element_id}</span>
                      {u.outcome && <Chip tone={OUTCOME[u.outcome]?.tone ?? 'idle'}>{OUTCOME[u.outcome]?.label ?? u.outcome}</Chip>}
                      {u.label_differs && <Chip tone="warn" title={`The page says "${u.app_label}"`}>Label differs</Chip>}
                    </div>
                  )) : <span className="text-[#9CA3AF]">Not matched to a journey element</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={4} className="px-3 py-4 text-center text-[#9CA3AF]">No object matches.</td></tr>}
          </tbody>
        </table>
      </div>
      {dropped.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-[#6B7280]">
          {dropped.length} object{dropped.length === 1 ? '' : 's'} left out:
          {dropped.map(sel => (
            <button key={sel} type="button" className={BTN} disabled={locked} title={sel} onClick={() => onToggle(sel, true)}>
              Restore {sel.length > 28 ? `${sel.slice(0, 28)}…` : sel}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const StepsPanel: React.FC<{
  steps: CaptureFlowStep[]
  pages: CaptureFlowPage[]
  locked: boolean
  onChoose: (step: number, choice: { page_id: string; selector: string } | null) => void
}> = ({ steps, pages, locked, onChoose }) => {
  const pageName = (id: string | null) => pages.find(p => p.page_id === id)?.name ?? ''
  // An option's value is "<page index>:<object index>"; selectors can hold any character.
  const keyOf = (pageId: string | null, selector: string | null) => {
    const pi = pages.findIndex(p => p.page_id === pageId)
    const ei = pi >= 0 ? pages[pi].elements.findIndex(e => e.selector === selector) : -1
    return pi >= 0 && ei >= 0 ? `${pi}:${ei}` : ''
  }
  return (
    <ol className="m-0 flex list-none flex-col gap-0 p-0">
      {steps.filter(s => s.kind !== 'skip').map(s => {
        const status = STEP_STATUS[s.status] ?? { label: s.status, tone: 'idle' as const }
        return (
          <li key={s.order} className="grid grid-cols-1 gap-2 border-t border-[#F1F2F4] py-2.5 text-[12.5px] first:border-t-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-bold text-[#1F2937]">{s.step_number != null ? `Step ${s.step_number}` : 'Setup'}</span>
                {s.setup && <Chip tone="idle">sign-in</Chip>}
                <Chip tone={status.tone}>{status.label}</Chip>
                {s.chosen && <Chip tone="brand">your choice</Chip>}
                {s.label_differs && <Chip tone="warn" title={`The page says "${s.app_label}"`}>Label differs</Chip>}
              </div>
              <div className="mt-0.5 text-[#374151]">{s.text}</div>
              {s.page_id
                ? <div className="mt-0.5 text-[11.5px] text-[#6B7280]">On {pageName(s.page_id)}: <strong className="text-[#1F2937]">{s.app_label || s.element_label}</strong></div>
                : s.reason && <div className="mt-0.5 text-[11.5px] text-[#8A5000]">{s.reason}</div>}
            </div>
            {s.has_element && s.step_number != null ? (
              <label className="flex flex-col gap-0.5 text-[10.5px] font-bold uppercase tracking-[0.08em] text-[#6B7280]">
                Object for “{s.element_label}”
                <select aria-label={`Object for step ${s.step_number}`} className={SELECT} disabled={locked}
                  value={s.chosen ? keyOf(s.page_id, s.selector) : ''}
                  onChange={e => {
                    if (!e.target.value) { onChoose(s.step_number!, null); return }
                    const [pi, ei] = e.target.value.split(':').map(Number)
                    const p = pages[pi]
                    const el = p?.elements[ei]
                    if (p && el) onChoose(s.step_number!, { page_id: p.page_id, selector: el.selector })
                  }}>
                  <option value="">{s.page_id ? `Matched by label: ${s.app_label || s.element_label}` : 'Matched by label (none found)'}</option>
                  {pages.map((p, pi) => (
                    <optgroup key={p.page_id} label={p.name}>
                      {p.elements.map((e, ei) => ({ e, ei })).filter(({ e }) => e.kind !== 'text' || s.kind === 'capture').map(({ e, ei }) => (
                        <option key={e.selector} value={`${pi}:${ei}`}>{e.name || e.selector}{e.role ? ` · ${e.role}` : ''}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
            ) : <span />}
          </li>
        )
      })}
    </ol>
  )
}

// --- A new journey from the capture -------------------------------------------------------
// Most of the master list has no steps yet, so the journey a capture shows may
// not exist to match against. Proposed steps (backend capture_journey.py: open
// the first page, fill what was picked, click what names the next page) are
// edited here, then saved -- with the journey's place in the master list and
// any new screens -- as one Journey KB change set.

const FIELD = 'h-[30px] w-full min-w-0 rounded-[8px] border border-[#E8EAEE] bg-white px-2 text-[12px] text-[#1F2937]'

const NewJourneyPanel: React.FC<{
  capture: InboxCapture
  appKey: string
  canExecute: boolean
  onCancel: () => void
  onCreated: (journeyId: string, title: string, published: boolean, message: string) => void
}> = ({ capture, appKey, canExecute, onCancel, onCreated }) => {
  const [draft, setDraft] = useState<CaptureJourneyDraft | null>(null)
  const [taxonomy, setTaxonomy] = useState<KbTaxonomy | null>(null)
  const [steps, setSteps] = useState<CaptureJourneyStep[]>([])
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [parentId, setParentId] = useState('')
  const [title, setTitle] = useState('')
  const [existingId, setExistingId] = useState('')
  const [query, setQuery] = useState('')
  const [publish, setPublish] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    Promise.all([knowledgeBaseService.captureJourneyDraft(capture.id), knowledgeBaseService.taxonomy(appKey)])
      .then(([d, t]) => { if (!live) return; setDraft(d); setSteps(d.steps); setTitle(d.title); setTaxonomy(t) })
      .catch(err => live && setError(errorText(err)))
    return () => { live = false }
  }, [capture.id, appKey])

  const byId = useMemo(() => new Map((taxonomy?.nodes ?? []).map(n => [n.id, n])), [taxonomy])
  const trail = (id: string | null): string => {
    const out: string[] = []
    for (let n = id ? byId.get(id) : undefined; n; n = n.parent ? byId.get(n.parent) : undefined) out.unshift(n.title)
    return out.join(' › ')
  }
  // Where a new journey can go: a chapter, a group, or a journey (as a variant of it).
  const parents = useMemo(() => (taxonomy?.nodes ?? []).filter(n => ['chapter', 'group', 'journey'].includes(n.kind)), [taxonomy])
  // Journeys of the master list with no steps yet.
  const waiting = useMemo(() => {
    const authored = new Set(taxonomy?.authored ?? [])
    const q = query.trim().toLowerCase()
    return (taxonomy?.nodes ?? []).filter(n => ['journey', 'variant'].includes(n.kind) && !authored.has(n.id))
      .filter(n => !q || `${n.title} ${trail(n.id)}`.toLowerCase().includes(q)).slice(0, 200)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taxonomy, query])

  const pageOf = (id: string) => draft?.pages.find(p => p.page_id === id)
  const set = (i: number, patch: Partial<CaptureJourneyStep>) => setSteps(cur => cur.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  const move = (i: number, dir: -1 | 1) => setSteps(cur => { const next = [...cur]; const [x] = next.splice(i, 1); next.splice(i + dir, 0, x); return next })
  const add = () => setSteps(cur => [...cur, { action: '', expected_result: '', page_id: cur[cur.length - 1]?.page_id ?? draft?.pages[0]?.page_id ?? '', selector: null }])

  const ready = steps.length > 0 && steps.every(s => s.action.trim()) && (mode === 'new' ? !!parentId && !!title.trim() : !!existingId)
  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await knowledgeBaseService.createCaptureJourney(capture.id, {
        ...(mode === 'new' ? { parent_id: parentId, title: title.trim() } : { journey_id: existingId }),
        steps: steps.map(({ note: _note, ...s }) => ({ ...s, action: s.action.trim(), expected_result: s.expected_result.trim() })),
        publish
      })
      const name = mode === 'new' ? title.trim() : (byId.get(existingId)?.title ?? existingId)
      onCreated(r.journey_id, name, r.published, r.published
        ? `Journey created and published (change set #${r.change_set.id}). It is selected above; the flow is matched against it.`
        : (r.message ?? `Saved as change set #${r.change_set.id}; approve it in Change sets, then choose the journey above.`))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (!draft || !taxonomy) {
    return error ? <Note tone="warn">{error}</Note> : <div className="text-[12.5px] text-[#6B7280]">Proposing steps from the capture…</div>
  }
  const radio = 'flex items-start gap-2 rounded-[10px] border px-3 py-2 text-[12.5px]'
  return (
    <div className="flex flex-col gap-3 rounded-[12px] border border-[#E8EAEE] bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-[14px] font-bold text-[#1F2937]">New journey from this capture</div>
          <div className="text-[12px] text-[#6B7280]">
            Its steps are proposed from the page order — check the wording and the object each step uses. Pages become screens
            (an existing screen when the route matches); their objects become the screen&apos;s elements. Selectors come later, when the capture is imported against the journey.
          </div>
        </div>
        <button type="button" className={BTN} onClick={onCancel}>Back to the flow</button>
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        <label className={`${radio} ${mode === 'new' ? 'border-[#F6D4D5] bg-[#FFFBFB]' : 'border-[#E8EAEE]'}`}>
          <input type="radio" name="cj-mode" checked={mode === 'new'} onChange={() => setMode('new')} className="mt-0.5" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <strong>A new journey in the master list</strong>
            <select aria-label="Place the new journey under" className={FIELD} value={parentId} disabled={mode !== 'new'} onChange={e => setParentId(e.target.value)}>
              <option value="">Under…</option>
              {parents.map(n => <option key={n.id} value={n.id}>{'\u00a0\u00a0'.repeat(Math.max(0, n.level - 1))}{n.title}{n.kind === 'journey' ? ' (as a variant)' : ''}</option>)}
            </select>
            <input aria-label="New journey name" className={FIELD} value={title} disabled={mode !== 'new'} onChange={e => setTitle(e.target.value)} placeholder="Journey name, e.g. Order a mobile plan" />
          </span>
        </label>
        <label className={`${radio} ${mode === 'existing' ? 'border-[#F6D4D5] bg-[#FFFBFB]' : 'border-[#E8EAEE]'}`}>
          <input type="radio" name="cj-mode" checked={mode === 'existing'} onChange={() => setMode('existing')} className="mt-0.5" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <strong>A journey already in the master list, with no steps yet</strong>
            <input aria-label="Search journeys" className={FIELD} value={query} disabled={mode !== 'existing'} onChange={e => setQuery(e.target.value)} placeholder="Search, e.g. order, plans, add-ons" />
            <select aria-label="Journey to give these steps" className={FIELD} value={existingId} disabled={mode !== 'existing'} onChange={e => setExistingId(e.target.value)}>
              <option value="">{waiting.length ? `Choose one of ${waiting.length}…` : 'No journey matches'}</option>
              {waiting.map(n => <option key={n.id} value={n.id}>{trail(n.id)}</option>)}
            </select>
          </span>
        </label>
      </div>

      <div className="overflow-x-auto rounded-[12px] border border-[#E8EAEE]">
        <table className="w-full min-w-[900px] border-collapse text-[12px]">
          <thead className="bg-[#F4F5F7] text-left text-[10.5px] uppercase tracking-[0.08em] text-[#4B5563]">
            <tr><th className="w-[36px] px-2 py-2">#</th><th className="px-2 py-2">Action</th><th className="px-2 py-2">Expected result</th><th className="w-[170px] px-2 py-2">Page (screen)</th><th className="w-[190px] px-2 py-2">Object</th><th className="w-[96px] px-2 py-2" /></tr>
          </thead>
          <tbody>
            {steps.map((s, i) => {
              const page = pageOf(s.page_id)
              return (
                <tr key={i} className="border-t border-[#F1F2F4] align-top">
                  <td className="px-2 py-2 font-bold text-[#1F2937]">{i + 1}</td>
                  <td className="px-2 py-2">
                    <input aria-label={`Step ${i + 1} action`} className={FIELD} value={s.action} onChange={e => set(i, { action: e.target.value, note: undefined })} />
                    {s.note && <div className="mt-1 text-[11px] text-[#8A5000]">{s.note}</div>}
                  </td>
                  <td className="px-2 py-2"><input aria-label={`Step ${i + 1} expected result`} className={FIELD} value={s.expected_result} onChange={e => set(i, { expected_result: e.target.value })} /></td>
                  <td className="px-2 py-2">
                    <select aria-label={`Step ${i + 1} page`} className={FIELD} value={s.page_id} onChange={e => set(i, { page_id: e.target.value, selector: null })}>
                      {draft.pages.map(p => <option key={p.page_id} value={p.page_id}>{p.name}{p.screen_name ? ` (${p.screen_name})` : ' (new screen)'}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <select aria-label={`Step ${i + 1} object`} className={FIELD} value={s.selector ? String(page?.objects.findIndex(o => o.selector === s.selector) ?? '') : ''}
                      onChange={e => set(i, { selector: e.target.value === '' ? null : page?.objects[Number(e.target.value)]?.selector ?? null, note: undefined })}>
                      <option value="">— none (a check of the page) —</option>
                      {page?.objects.map((o, oi) => <option key={o.selector} value={oi}>{o.name} · {o.type}{o.chrome ? ' · header' : ''}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex gap-1">
                      <button type="button" className={BTN} aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                      <button type="button" className={BTN} aria-label={`Move step ${i + 1} down`} disabled={i === steps.length - 1} onClick={() => move(i, 1)}>↓</button>
                      <button type="button" className={`${BTN} text-[#A3231C]`} aria-label={`Remove step ${i + 1}`} onClick={() => setSteps(cur => cur.filter((_, j) => j !== i))}>✕</button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" className={BTN} onClick={add}>+ Add step</button>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-[12.5px] text-[#374151]" title="Publishing needs the approve permission; otherwise it waits in Change sets">
            <input type="checkbox" checked={publish} onChange={e => setPublish(e.target.checked)} className="accent-[#B71920]" />
            Publish now
          </label>
          <button type="button" className={PRIMARY} disabled={!canExecute || busy || !ready} onClick={() => void create()}
            title={!ready ? (mode === 'new' ? 'Choose where it goes and name it; every step needs an action' : 'Choose the journey; every step needs an action') : undefined}>
            {busy ? 'Creating…' : `Create journey · ${steps.length} steps`}
          </button>
        </div>
      </div>
      {error && <Note tone="warn">{error}</Note>}
    </div>
  )
}

export const CaptureFlow: React.FC<{
  capture: InboxCapture
  appKey: string
  journeyId: string
  application: { id: number; environment: string }
  canExecute: boolean
  onChanged: () => void
  onImported: (crawlId: number) => void
  onClose: () => void
  /** A journey was built from the capture: the stage selects it. */
  onJourneyCreated?: (journeyId: string, title: string) => void
}> = ({ capture, appKey, journeyId, application, canExecute, onChanged, onImported, onClose, onJourneyCreated }) => {
  const [building, setBuilding] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [edits, setEdits] = useState<CaptureEdits>(capture.edits ?? {})
  const [preview, setPreview] = useState<CapturePreview | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const locked = !canExecute || capture.status !== 'inbox'
  const foreign = capture.app_id && capture.app_id !== appKey

  const match = useCallback(async () => {
    if (!journeyId || !capture.app_id || foreign) return
    setBusy(b => b ?? 'match')
    setError(null)
    try {
      const p = await knowledgeBaseService.previewCapture(capture.id, { journey_id: journeyId, application_id: application.id, environment: capture.environment || application.environment })
      setPreview(p)
      setSelected(s => (s && p.pages.some(x => x.page_id === s) ? s : p.pages[0]?.page_id ?? null))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }, [capture.id, capture.app_id, capture.environment, journeyId, application.id, application.environment, foreign])
  useEffect(() => { void match() }, [match])

  const save = async (next: CaptureEdits) => {
    setEdits(next)
    setBusy('save')
    setError(null)
    try {
      await knowledgeBaseService.editCapture(capture.id, { edits: next })
      setBusy(null)
      await match()
    } catch (err) {
      setError(errorText(err))
      setBusy(null)
    }
  }
  const pages = preview?.pages ?? []
  const order = pages.map(p => p.page_id)
  const move = (index: number, dir: -1 | 1) => {
    const next = [...order]
    const [id] = next.splice(index, 1)
    next.splice(index + dir, 0, id)
    void save({ ...edits, order: next })
  }
  const drop = (pageId: string) => void save({ ...edits, dropped_pages: [...(edits.dropped_pages ?? []), pageId] })
  const restore = (pageId: string) => void save({ ...edits, dropped_pages: (edits.dropped_pages ?? []).filter(id => id !== pageId) })
  const rename = (pageId: string, name: string) => void save({ ...edits, names: { ...(edits.names ?? {}), [pageId]: name } })
  const screen = (pageId: string, screenId: string | null) => {
    const screens = { ...(edits.screens ?? {}) }
    if (screenId === null) delete screens[pageId]
    else screens[pageId] = screenId
    void save({ ...edits, screens })
  }
  const toggle = (pageId: string, selector: string, keep: boolean) => {
    const current = edits.dropped_elements?.[pageId] ?? []
    const nextList = keep ? current.filter(s => s !== selector) : [...current, selector]
    void save({ ...edits, dropped_elements: { ...(edits.dropped_elements ?? {}), [pageId]: nextList } })
  }
  const choose = (step: number, choice: { page_id: string; selector: string } | null) => {
    const steps = { ...(edits.steps ?? {}) }
    if (choice) steps[String(step)] = choice
    else delete steps[String(step)]
    void save({ ...edits, steps })
  }
  const claim = async () => {
    setBusy('claim')
    try { await knowledgeBaseService.editCapture(capture.id, { app_id: appKey, environment: capture.environment || application.environment }); onChanged() } catch (err) { setError(errorText(err)) } finally { setBusy(null) }
  }
  const importIt = async () => {
    setBusy('import')
    setError(null)
    try {
      const crawl = await knowledgeBaseService.importInboxCapture(capture.id, { journey_id: journeyId, application_id: application.id, environment: capture.environment || application.environment })
      onChanged()
      onImported(crawl.id)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const steps = (preview?.steps ?? []).filter(s => s.kind !== 'skip' && !s.setup)
  const found = steps.filter(s => s.status === 'done').length
  const current = pages.find(p => p.page_id === selected) ?? null
  const matchedObjects = pages.reduce((n, p) => n + p.elements.filter(e => e.uses.length > 0).length, 0)
  const newObjects = pages.reduce((n, p) => n + p.elements.filter(e => e.uses.some(u => u.outcome === 'new')).length, 0)
  const differs = pages.reduce((n, p) => n + p.elements.filter(e => e.uses.some(u => u.label_differs)).length, 0)

  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-[#E8EAEE] bg-[#FCFCFD] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[14px] font-bold text-[#1F2937]">Capture #{capture.id} · {capture.name}</div>
          <div className="text-[12px] text-[#6B7280]">
            {capture.pages} pages · {capture.elements} objects · sent {when(capture.created_at)}{capture.created_by ? ` by ${capture.created_by}` : ''}
            {capture.origin ? ` · from ${capture.origin}` : ''}{capture.environment ? ` · ${capture.environment}` : ''}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BTN} onClick={onClose}>Back to the inbox</button>
          {capture.status === 'inbox' && capture.app_id && !foreign && !building && (
            <button type="button" className={BTN.replace('h-[30px]', 'h-[34px]')} disabled={!canExecute || busy !== null}
              onClick={() => { setBuilding(true); setNotice(null) }}
              title="Most of the master list has no steps yet: make this capture the journey's steps">
              New journey from this capture
            </button>
          )}
          {capture.status === 'inbox' && preview && !building && (
            <button type="button" className={PRIMARY} disabled={!canExecute || busy !== null || !journeyId}
              onClick={() => void importIt()} title="Stores it as a walk of the journey; then propose and approve its changes below">
              {busy === 'import' ? 'Importing…' : 'Import for review'}
            </button>
          )}
        </div>
      </div>

      {!capture.app_id && (
        <Note tone="warn">
          This capture&apos;s address matched no registered application.{' '}
          <button type="button" className="font-bold text-[#B71920] underline" disabled={!canExecute || busy !== null} onClick={() => void claim()}>It belongs to this application</button>
        </Note>
      )}
      {foreign && <Note tone="warn">This capture belongs to {capture.app_id}. Choose that application at the top of the page to review it.</Note>}
      {capture.status === 'imported' && <Note>Imported as capture walk #{capture.crawl_run_id}; it is reviewed under Walk results below.</Note>}
      {error && <Note tone="warn">{error}</Note>}
      {!preview && !error && capture.app_id && !foreign && <div className="text-[12.5px] text-[#6B7280]">Matching the capture to the journey…</div>}

      {notice && <Note>{notice}</Note>}
      {building && (
        <NewJourneyPanel capture={capture} appKey={appKey} canExecute={canExecute} onCancel={() => setBuilding(false)}
          onCreated={(id, name, published, message) => { setBuilding(false); setNotice(message); if (published) onJourneyCreated?.(id, name) }} />
      )}
      {preview && !building && (
        <>
          <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
            <Chip tone={found === steps.length ? 'good' : 'warn'}>{found} of {steps.length} steps found</Chip>
            <Chip tone="good">{matchedObjects} objects match the journey</Chip>
            {newObjects > 0 && <Chip tone="info">{newObjects} new for the Automation KB</Chip>}
            {differs > 0 && <Chip tone="warn">{differs} labels differ from the KB</Chip>}
            {busy === 'save' || busy === 'match' ? <span className="text-[#6B7280]">Matching again…</span> : null}
          </div>
          {preview.notes.map(n => <Note key={n} tone="warn">{n}</Note>)}

          <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#6B7280]">The flow, in the order the pages were captured</div>
          <div className="app-scroll flex items-stretch gap-2 overflow-x-auto pb-2">
            {pages.map((p, i) => (
              <React.Fragment key={p.page_id}>
                {i > 0 && <div aria-hidden className="flex flex-none items-center text-[20px] text-[#9CA3AF]">→</div>}
                <PageCard page={p} index={i} count={pages.length} selected={p.page_id === selected} screens={preview.screens} locked={locked}
                  onSelect={() => setSelected(p.page_id)} onMove={dir => move(i, dir)} onDrop={() => drop(p.page_id)}
                  onRename={name => rename(p.page_id, name)} onScreen={sid => screen(p.page_id, sid)} />
              </React.Fragment>
            ))}
          </div>
          {preview.dropped_pages.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-[#6B7280]">
              Left out:
              {preview.dropped_pages.map(p => <button key={p.page_id} type="button" className={BTN} disabled={locked} onClick={() => restore(p.page_id)}>Restore {p.name}</button>)}
            </div>
          )}

          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-2 rounded-[12px] border border-[#E8EAEE] bg-white p-3">
              <div className="text-[13px] font-bold text-[#1F2937]">{current ? `Objects on ${current.name}` : 'Objects'}</div>
              {current
                ? <ObjectsTable page={current} dropped={edits.dropped_elements?.[current.page_id] ?? []} locked={locked}
                    onToggle={(sel, keep) => toggle(current.page_id, sel, keep)} />
                : <span className="text-[12.5px] text-[#6B7280]">Pick a page above.</span>}
            </div>
            <div className="flex flex-col gap-1 rounded-[12px] border border-[#E8EAEE] bg-white p-3">
              <div className="text-[13px] font-bold text-[#1F2937]">Journey steps</div>
              <div className="text-[11.5px] text-[#6B7280]">Where each step&apos;s object was found. Choose another object if the label match picked the wrong one.</div>
              <StepsPanel steps={preview.steps} pages={pages} locked={locked} onChoose={choose} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// --- The inbox ---------------------------------------------------------------------------

export const CaptureInbox: React.FC<{
  appKey: string
  journeyId: string
  application: { id: number; environment: string }
  canExecute: boolean
  openId?: number | null
  onImported: (crawlId: number) => void
  onJourneyCreated?: (journeyId: string, title: string) => void
}> = ({ appKey, journeyId, application, canExecute, openId, onImported, onJourneyCreated }) => {
  const [list, setList] = useState<InboxCapture[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<number | null>(openId ?? null)
  const [showDone, setShowDone] = useState(false)
  const load = useCallback(() => {
    knowledgeBaseService.captures(appKey, showDone).then(r => { setList(r); setError(null) }).catch(err => setError(errorText(err)))
  }, [appKey, showDone])
  useEffect(load, [load])
  // Back from the application's tab after sending: show what arrived.
  useEffect(() => {
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])
  useEffect(() => { if (openId) setOpen(openId) }, [openId])

  const capture = useMemo(() => list?.find(c => c.id === open) ?? null, [list, open])
  const discard = async (c: InboxCapture) => {
    if (!window.confirm(`Discard capture #${c.id} (${c.pages} pages)? It is deleted.`)) return
    try { await knowledgeBaseService.deleteCapture(c.id); if (open === c.id) setOpen(null); load() } catch (err) { setError(errorText(err)) }
  }

  if (capture) {
    return (
      <CaptureFlow capture={capture} appKey={appKey} journeyId={journeyId} application={application} canExecute={canExecute}
        onChanged={load} onImported={onImported} onClose={() => setOpen(null)} onJourneyCreated={onJourneyCreated} />
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#6B7280]">Captures inbox · sent from the tool</span>
        <div className="flex items-center gap-3 text-[12px]">
          <label className="flex items-center gap-1.5 text-[#374151]">
            <input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} className="accent-[#B71920]" />
            Show imported
          </label>
          <button type="button" className={BTN} onClick={load}>Refresh</button>
        </div>
      </div>
      {error && <Note tone="warn">{error}</Note>}
      {list && list.length === 0 && (
        <div className="rounded-[10px] border border-dashed border-[#D6D9DF] px-3 py-3 text-[12.5px] text-[#6B7280]">
          Nothing in the inbox. In the tool, press <strong>Send to Knowledge Base</strong>; the capture appears here.
        </div>
      )}
      {list && list.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-0 rounded-[12px] border border-[#E8EAEE] bg-white p-0">
          {list.map(c => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-[#F1F2F4] px-3 py-2.5 text-[12.5px] first:border-t-0">
              <div className="min-w-0">
                <div className="truncate font-semibold text-[#1F2937]">#{c.id} · {c.name}</div>
                <div className="text-[11.5px] text-[#6B7280]">
                  {c.pages} pages · {c.elements} objects · {when(c.created_at)}{c.created_by ? ` · ${c.created_by}` : ''}
                  {!c.app_id && ' · application not matched'}{c.status === 'imported' ? ` · imported as walk #${c.crawl_run_id}` : ''}
                </div>
              </div>
              <div className="flex gap-2">
                <button type="button" className={PRIMARY.replace('h-[34px]', 'h-[30px]')} onClick={() => setOpen(c.id)}>{c.status === 'imported' ? 'View' : 'Review flow'}</button>
                {canExecute && <button type="button" className={`${BTN} text-[#A3231C]`} onClick={() => void discard(c)}>Discard</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default CaptureInbox
