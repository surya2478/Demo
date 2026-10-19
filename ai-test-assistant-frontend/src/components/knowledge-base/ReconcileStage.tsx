import React, { useEffect, useMemo, useState } from 'react'
import knowledgeBaseService, { errorText, type ElementStatus, type ReconcileDecision, type ReconcileRow } from '../../services/knowledgeBaseService'
import { CHIP, Chip, Card, ELEMENT_STATUS, Failed, Loading, Note, StatusChip, TONE, TableHead, useLoad } from './kbUi'

// Decisions first, then work to do, then what agrees; selectors only the
// application has come last -- a large Automation KB would otherwise bury
// the design elements under them.
const ORDER: ElementStatus[] = ['LABEL_DRIFT', 'REF_BROKEN', 'NOT_CRAWLED', 'MATCH', 'NOT_IN_DESIGN']

const rowKey = (r: ReconcileRow) => `${r.screen_id ?? ''}:${r.element_id ?? ''}:${r.automation_ref ?? ''}`

type Choice = ReconcileDecision['decision']

// What each status lets you decide. NOT_CRAWLED and MATCH have nothing to
// decide: the first needs a crawl, the second agrees.
const CHOICES: Partial<Record<ElementStatus, { id: Choice; title: string; detail: string }[]>> = {
  LABEL_DRIFT: [
    { id: 'app', title: 'The app', detail: 'use its label in the Journey KB; the old label stays as an alias and journey steps are reworded' },
    { id: 'both', title: 'Both', detail: 'keep the design label and accept the app label as an alias' },
    { id: 'design', title: 'The design', detail: 'record a defect against the application; no file changes' }
  ],
  REF_BROKEN: [
    { id: 'unlink', title: 'Clear the reference', detail: 'the Automation KB no longer has this entry; the next crawl links it again' }
  ],
  NOT_IN_DESIGN: [
    { id: 'add', title: 'Add to the design', detail: 'add this control to the Journey KB screen it belongs to' }
  ]
}

const DecisionForm: React.FC<{ appKey: string; row: ReconcileRow; screens: { id: string; name: string }[]; onDrafted: () => void }> = ({ appKey, row, screens, onDrafted }) => {
  const choices = CHOICES[row.status] ?? []
  const [choice, setChoice] = useState<Choice | null>(choices[0]?.id ?? null)
  const [screen, setScreen] = useState('')
  const [label, setLabel] = useState(row.app_labels[0] ?? '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  if (!choices.length) return null
  const submit = async () => {
    if (!choice) return
    setBusy(true)
    setError(null)
    try {
      const created = await knowledgeBaseService.decide(appKey, {
        decision: choice,
        screen_id: choice === 'add' ? screen : row.screen_id,
        element_id: row.element_id,
        automation_ref: row.automation_ref,
        app_label: row.app_labels[0] ?? null,
        label: choice === 'add' ? label : null,
        note: note || null
      })
      setDone(`Change set #${created.id} drafted: ${created.title}`)
      onDrafted()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <fieldset className="flex flex-col gap-2 border-0 p-0 text-[12.5px]">
        <legend className="mb-1.5 text-[12px] font-bold text-[#374151]">{row.status === 'LABEL_DRIFT' ? 'Which is right?' : 'Decision'}</legend>
        {choices.map(c => (
          <label key={c.id} className={`flex cursor-pointer gap-2 rounded-[12px] border p-2.5 ${choice === c.id ? 'border-[#F1A4A6] bg-[#FFF5F5]' : 'border-[#E8EAEE]'}`}>
            <input type="radio" name={`kb-decision-${row.automation_ref ?? row.element_id}`} checked={choice === c.id} onChange={() => setChoice(c.id)} className="mt-0.5 accent-[#B71920]" />
            <span><strong>{c.title}</strong> · {c.detail}</span>
          </label>
        ))}
      </fieldset>
      {choice === 'add' && (
        <div className="grid gap-2">
          <label className="text-[12px] font-semibold text-[#374151]">Screen
            <select value={screen} onChange={e => setScreen(e.target.value)} className="mt-1 block h-9 w-full rounded-[10px] border border-[#E8EAEE] bg-white px-2 text-[13px]">
              <option value="">Choose the screen…</option>
              {screens.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="text-[12px] font-semibold text-[#374151]">Label as the user sees it
            <input value={label} onChange={e => setLabel(e.target.value)} className="mt-1 block h-9 w-full rounded-[10px] border border-[#E8EAEE] px-3 text-[13px]" />
          </label>
        </div>
      )}
      <label className="text-[12px] font-semibold text-[#374151]">Note for the reviewer (optional)
        <input value={note} onChange={e => setNote(e.target.value)} className="mt-1 block h-9 w-full rounded-[10px] border border-[#E8EAEE] px-3 text-[13px]" />
      </label>
      {error && <Note tone="warn">{error}</Note>}
      {done && <Note>{done}. It changes nothing until it is approved in Change sets.</Note>}
      <button type="button" onClick={() => void submit()} disabled={busy || !choice || (choice === 'add' && !screen) || !!done}
        className="h-[38px] rounded-[12px] bg-[#B71920] text-[13px] font-bold text-white hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50">
        {busy ? 'Drafting…' : done ? 'Drafted' : 'Create change set'}
      </button>
    </div>
  )
}

const ReconcileStage: React.FC<{ appKey: string; onDrafted: () => void }> = ({ appKey, onDrafted }) => {
  const [data, error, reload] = useLoad(appKey, () => knowledgeBaseService.reconcile(appKey))
  const [status, setStatus] = useState<ElementStatus | 'captured_unmapped' | 'all'>('all')
  const [journey, setJourney] = useState<string>('all')
  const [selected, setSelected] = useState<string | null>(null)

  const journeys = useMemo(() => Array.from(new Set((data?.rows ?? []).flatMap(r => r.journeys))).sort(), [data])
  const rows = useMemo(() => {
    const list = (data?.rows ?? []).filter(r =>
      (status === 'all' || (status === 'captured_unmapped' ? r.status === 'NOT_CRAWLED' && !!r.observed_control : status === 'NOT_CRAWLED' ? r.status === 'NOT_CRAWLED' && !r.observed_control : r.status === status)) && (journey === 'all' || r.journeys.includes(journey))
    )
    // Decisions first: drift and broken references, then the rest.
    return [...list].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
  }, [data, status, journey])

  useEffect(() => {
    if (rows.length && !rows.some(r => rowKey(r) === selected)) setSelected(rowKey(rows[0]))
  }, [rows, selected])
  const current = rows.find(r => rowKey(r) === selected)
  const screens = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of data?.rows ?? []) if (r.screen_id && r.screen_name) seen.set(r.screen_id, r.screen_name)
    return Array.from(seen, ([id, name]) => ({ id, name }))
  }, [data])

  const filterChip = (id: ElementStatus | 'captured_unmapped' | 'all', label: string, tone: keyof typeof TONE, count: number) => (
    <button key={id} type="button" aria-pressed={status === id} onClick={() => setStatus(id)}
      className={`${CHIP} h-7 px-[11px] text-[12px] ${status === id ? 'bg-[#1F2937] text-white' : TONE[tone]}`}>
      {label} {count}
    </button>
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Journey" value={journey} onChange={e => setJourney(e.target.value)}
          className="h-9 rounded-[10px] border border-[#E8EAEE] bg-white px-2.5 text-[13px]">
          <option value="all">All journeys</option>
          {journeys.map(j => <option key={j} value={j}>{j}</option>)}
        </select>
        <span className="mx-1 h-6 w-px bg-[#E8EAEE]" />
        {filterChip('all', 'All', 'idle', data?.rows.length ?? 0)}
        {ORDER.map(s => s === 'NOT_CRAWLED' ? <React.Fragment key={s}>{filterChip('captured_unmapped', 'Captured · not mapped', 'info', data?.rows.filter(r => r.status === s && r.observed_control).length ?? 0)}{filterChip(s, 'Not captured', 'idle', data?.rows.filter(r => r.status === s && !r.observed_control).length ?? 0)}</React.Fragment> : filterChip(s, ELEMENT_STATUS[s].label, ELEMENT_STATUS[s].tone, data?.summary[s] ?? 0))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card label="Design versus application">
          <TableHead cols="grid-cols-[minmax(0,1fr)_auto]" labels={['Element · design (Journey KB) · application (Automation KB)', 'Status']} />
          {error && <Failed message={error} onRetry={reload} />}
          {!data && !error && <Loading what="the comparison" />}
          <div className="max-h-[640px] overflow-auto">
            {rows.map(r => {
              const key = rowKey(r)
              return (
                <button key={key} type="button" onClick={() => setSelected(key)} aria-current={key === selected ? 'true' : undefined}
                  className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[#F1F2F4] px-5 py-2.5 text-left text-[12.5px] ${key === selected ? 'bg-[#FFF5F5] shadow-[inset_3px_0_0_#B71920]' : 'hover:bg-[#FCFCFD]'}`}>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className={`truncate ${key === selected ? 'font-bold' : 'font-semibold'}`}>
                      {r.screen_name ? `${r.screen_name} · ${r.element_id}` : r.automation_ref}
                    </span>
                    <span className="truncate text-[#4B5563]">
                      {r.design_label ? `Design: ‘${r.design_label}’` : <span className="text-[#6B7280]">Not in design</span>}
                    </span>
                    <span className="truncate text-[#6B7280]">
                      App: {r.automation_target ? <code className="text-[11.5px] text-[#1F2937]">{r.automation_target}</code> : '—'}
                    </span>
                  </span>
                  {r.status === 'NOT_CRAWLED' && r.observed_control ? <Chip tone="info" title="Browser-observed, but not linked to an approved Automation KB locator">Captured · not mapped</Chip> : <StatusChip status={r.status} />}
                </button>
              )
            })}
            {data && rows.length === 0 && <p className="px-5 py-6 text-center text-[13px] text-[#6B7280]">Nothing matches these filters.</p>}
          </div>
        </Card>

        {current && (
          <Card label="Selected difference" className="flex flex-col gap-3.5 self-start p-[18px]">
            <div>
              <span className={`text-[11px] font-bold tracking-[0.1em] ${ELEMENT_STATUS[current.status].tone === 'warn' ? 'text-[#8A5000]' : 'text-[#6B7280]'}`}>{current.status === 'NOT_CRAWLED' && current.observed_control ? 'CAPTURED · NOT MAPPED' : ELEMENT_STATUS[current.status].label.toUpperCase()}</span>
              <h2 className="m-0 mt-1 text-[16px] font-bold">{current.screen_name ? `${current.screen_name} · ${current.element_id}` : current.automation_ref}</h2>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div className="flex flex-col gap-1.5 rounded-[12px] border border-[#E8EAEE] p-2.5">
                <span className="text-[11px] font-bold text-[#6B7280]">DESIGN SAYS</span>
                <span className="text-[15px] font-extrabold">{current.design_label ?? '—'}</span>
                {current.locator_hint && <span className="text-[11px] text-[#6B7280]">looks for {current.locator_hint}</span>}
              </div>
              <div className="flex flex-col gap-1.5 rounded-[12px] border border-[#E8EAEE] p-2.5">
                <span className="text-[11px] font-bold text-[#6B7280]">APP SHOWS</span>
                <span className="text-[15px] font-extrabold">{current.app_labels.join(' / ') || (current.automation_target ? 'located' : '—')}</span>
                {current.automation_ref && <code className="break-all text-[11px] text-[#6B7280]">{current.automation_ref}</code>}
              </div>
            </div>
            {current.suggestion && <Note tone={current.status === 'MATCH' ? 'plain' : 'warn'}>{current.suggestion}</Note>}
            {current.journeys.length > 0 && (
              <div className="flex flex-col gap-1 text-[12px] text-[#4B5563]">
                <span className="text-[11px] font-bold tracking-[0.1em] text-[#6B7280]">JOURNEYS USING THIS ELEMENT</span>
                {current.journeys.map(j => <span key={j}>{j}</span>)}
              </div>
            )}
            <DecisionForm key={rowKey(current)} appKey={appKey} row={current} screens={screens} onDrafted={onDrafted} />
          </Card>
        )}
      </div>
    </div>
  )
}

export default ReconcileStage
