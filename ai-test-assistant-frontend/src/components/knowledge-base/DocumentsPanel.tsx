import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import knowledgeBaseService, { errorText, type CatalogScreen, type DocumentAddition, type DocumentConversion, type KbImpact, type ReviewItem, type SourceDocument } from '../../services/knowledgeBaseService'
import ImpactSummary from './ImpactSummary'
import { Card, CardHead, Chip, Failed, Loading, Note, TONE, chapterTitle, useLoad } from './kbUi'

// Design documents in, reviewed knowledge out. Upload a PDF or BRD, let the
// model propose what it describes, then keep, edit or drop each item next to
// the page it came from. What is kept becomes one Journey KB change set,
// approved in the Change sets drawer like any other; nothing is written here.

const STATUS: Record<SourceDocument['status'], { label: string; tone: keyof typeof TONE }> = {
  uploaded: { label: 'Not extracted', tone: 'idle' },
  extracting: { label: 'Extracting…', tone: 'info' },
  extracted: { label: 'Ready to review', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
  drafted: { label: 'Change set drafted', tone: 'good' }
}
const KIND_LABEL: Record<ReviewItem['kind'], string> = { journey: 'Journeys', screen: 'Screens', element: 'Elements', rule: 'Business rules' }
const ACTION: Record<ReviewItem['action'], { label: string; tone: keyof typeof TONE }> = {
  add: { label: 'New', tone: 'info' },
  exists: { label: 'Already in KB', tone: 'good' },
  differs: { label: 'Differs from KB', tone: 'warn' },
  no_place: { label: 'Not in master list', tone: 'bad' },
  // A BRD may change what exists:
  rename: { label: 'BRD renames', tone: 'brand' },
  revise: { label: 'BRD revises steps', tone: 'brand' },
  modify: { label: 'BRD restates rule', tone: 'brand' }
}
// Which fields a reviewer may correct, per kind (the backend accepts the same).
const EDITABLE: Record<ReviewItem['kind'], { key: string; label: string }[]> = {
  element: [{ key: 'label', label: 'Label' }],
  screen: [{ key: 'name', label: 'Name' }],
  rule: [{ key: 'statement', label: 'Statement' }, { key: 'message', label: 'Message' }],
  journey: [{ key: 'name', label: 'Name' }]
}
const BTN = 'h-[34px] rounded-[10px] px-3.5 text-[12.5px] font-bold disabled:cursor-not-allowed disabled:opacity-50'
const BTN_PRIMARY = `${BTN} bg-[#B71920] text-white hover:opacity-95`
const BTN_PLAIN = `${BTN} border border-[#E8EAEE] bg-white text-[#1F2937] hover:border-[#F6D4D5]`

const pageRef = (pages: number[]) => (pages.length ? `p${pages.join(', ')}` : '')

// The ids the backend gives an added screen or element (documents._snake / _screen_id).
const snake = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'element'
const addedScreenId = (name: string) => `SCR_${snake(name).toUpperCase()}`

const ELEMENT_TYPE_OPTIONS = ['button', 'link', 'text_input', 'password_input', 'dropdown', 'checkbox', 'radio', 'tab', 'heading', 'text',
  'inline_error', 'icon_button', 'date_input', 'file_upload', 'otp_input_group', 'card_list', 'tile_list', 'image', 'widget', 'control']

const AdditionsCard: React.FC<{
  additions: DocumentAddition[]
  catalog: CatalogScreen[]
  page: number
  locked: boolean
  onChange: (additions: DocumentAddition[]) => void
}> = ({ additions, catalog, page, locked, onChange }) => {
  const [screenName, setScreenName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [screenId, setScreenId] = useState('')
  const [label, setLabel] = useState('')
  const [type, setType] = useState('button')
  const field = 'h-8 min-w-0 rounded-[8px] border border-[#E8EAEE] bg-white px-2 text-[12.5px] text-[#1F2937]'
  const btn = 'h-8 rounded-[8px] border border-[#E8EAEE] bg-white px-3 text-[12px] font-bold text-[#1F2937] hover:border-[#F6D4D5] disabled:opacity-50'
  return (
    <Card label="Add what the model missed">
      <CardHead title="Add what the model missed"
        hint={`Screens and elements the pages show but the proposal lacks — often ones only in a screenshot. Added from page ${page}; quote labels exactly.`} />
      <div className="flex flex-col gap-3 px-5 pb-4">
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
          <input aria-label="New screen name" className={field} placeholder="Screen name, e.g. User Cancelled the login" value={screenName} onChange={e => setScreenName(e.target.value)} disabled={locked} />
          <input aria-label="New screen purpose" className={field} placeholder="What it is for (optional)" value={purpose} onChange={e => setPurpose(e.target.value)} disabled={locked} />
          <button type="button" className={btn} disabled={locked || !screenName.trim()}
            onClick={() => { onChange([...additions, { kind: 'screen', name: screenName.trim(), purpose: purpose.trim() || undefined, page }]); setScreenName(''); setPurpose('') }}>
            Add screen
          </button>
        </div>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_130px_auto]">
          <select aria-label="Screen of the new element" className={field} value={screenId} onChange={e => setScreenId(e.target.value)} disabled={locked}>
            <option value="">Screen…</option>
            {catalog.map(c => <option key={c.screen_id} value={c.screen_id}>{c.name}{c.source === 'proposed' ? ' · new' : ''}</option>)}
          </select>
          <input aria-label="New element label" className={field} placeholder="Label exactly as shown" value={label} onChange={e => setLabel(e.target.value)} disabled={locked} />
          <select aria-label="New element type" className={field} value={type} onChange={e => setType(e.target.value)} disabled={locked}>
            {ELEMENT_TYPE_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <button type="button" className={btn} disabled={locked || !screenId || !label.trim()}
            onClick={() => { onChange([...additions, { kind: 'element', screen_id: screenId, label: label.trim(), type, page }]); setLabel('') }}>
            Add element
          </button>
        </div>
        {additions.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12.5px]">
            {additions.map((a, i) => (
              <li key={i} className="flex items-center justify-between gap-2 rounded-[8px] bg-[#F9FAFB] px-2.5 py-1.5">
                <span className="min-w-0">
                  <Chip tone="brand">{a.kind === 'screen' ? 'screen' : a.type}</Chip>{' '}
                  <span className="font-semibold text-[#1F2937]">{a.kind === 'screen' ? a.name : a.label}</span>
                  <span className="font-mono text-[11px] text-[#6B7280]"> {a.kind === 'screen' ? addedScreenId(a.name) : `${a.screen_id} · ${snake(a.label)}`}{a.page ? ` · p${a.page}` : ''}</span>
                </span>
                <button type="button" className="text-[12px] font-semibold text-[#A3231C] hover:underline" disabled={locked}
                  onClick={() => onChange(additions.filter((_, j) => j !== i))}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}

// A journey step as the reviewer is editing it. `from` is the proposed step it
// came from (its screen, element and rule stay attached); null is a step the
// reviewer added, which they may link to a screen and element themselves.
interface StepDraft {
  key: number
  from: number | null
  action: string
  expected_result: string
  screen_id?: string
  element_id?: string
  rule?: string
  branch?: string
}
let stepKeys = 0
const draftsOf = (item: ReviewItem): StepDraft[] =>
  (item.value?.steps ?? []).map((s: any) => ({
    key: ++stepKeys, from: s.step_number, action: s.action ?? '', expected_result: s.expected_result ?? '',
    screen_id: s.screen_id, element_id: s.element_id, rule: s.rule, branch: s.branch
  }))
// What a journey needs once its steps are edited -- the backend does the same.
// Only proposed items matter; the closure ignores ids that are not items.
const requiresOf = (item: ReviewItem, steps?: StepDraft[]): string[] => {
  if (!steps) return item.requires
  const still = new Set<string>()
  for (const s of steps) {
    if (s.screen_id) still.add(`screen:${s.screen_id}`)
    if (s.screen_id && s.element_id) still.add(`element:${s.screen_id}.${s.element_id}`)
    if (s.rule) still.add(`rule:${s.rule}`)
  }
  return Array.from(still)
}

type RuleOption = NonNullable<SourceDocument['rule_catalog']>[number]

interface JourneyLinks {
  next_journeys: string[]
  prerequisite_journeys: string[]
  roles: string[]
  match_keywords: string[]
}

// Which journeys run before and after this one, who uses it, and the phrases a
// test case about it would contain -- the Journey KB matches cases to journeys
// on these keywords, so a missing one means cases never find this journey.
const JourneyLinksEditor: React.FC<{
  value: JourneyLinks
  journeys: NonNullable<SourceDocument['journey_catalog']>
  self: string
  onChange: (patch: Partial<JourneyLinks>) => void
}> = ({ value, journeys, self, onChange }) => {
  const field = 'h-8 w-full rounded-[8px] border border-[#E8EAEE] bg-white px-2 text-[12.5px] text-[#1F2937]'
  const label = 'flex flex-col gap-1 text-[11px] font-bold uppercase tracking-[0.08em] text-[#6B7280]'
  const title = (id: string) => journeys.find(j => j.id === id)?.title ?? id
  const list = (key: 'next_journeys' | 'prerequisite_journeys', text: string) => (
    <div className={label}>
      {text}
      <div className="flex flex-wrap gap-1">
        {(value[key] ?? []).map(id => (
          <span key={id} className="inline-flex items-center gap-1 rounded-full bg-[#EEF4FF] px-2 py-0.5 text-[11.5px] font-semibold normal-case tracking-normal text-[#1D4ED8]" title={id}>
            {title(id)}
            <button type="button" aria-label={`Remove ${title(id)}`} onClick={() => onChange({ [key]: (value[key] ?? []).filter(x => x !== id) })}>✕</button>
          </span>
        ))}
      </div>
      <select className={`${field} font-normal normal-case tracking-normal`} value="" aria-label={`Add to ${text}`}
        onChange={e => e.target.value && onChange({ [key]: [...(value[key] ?? []), e.target.value] })}>
        <option value="">Add a journey…</option>
        {journeys.filter(j => j.id !== self && !(value[key] ?? []).includes(j.id)).map(j => (
          <option key={j.id} value={j.id}>{j.title}{j.authored ? ' · authored' : ''}</option>
        ))}
      </select>
    </div>
  )
  const csv = (key: 'roles' | 'match_keywords', text: string, hint: string) => (
    <label className={label}>
      {text}
      <input className={`${field} font-normal normal-case tracking-normal`} defaultValue={(value[key] ?? []).join(', ')}
        onBlur={e => onChange({ [key]: e.target.value.split(',').map(x => x.trim()).filter(Boolean) })} />
      <span className="font-normal normal-case tracking-normal text-[#6B7280]">{hint}</span>
    </label>
  )
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {list('prerequisite_journeys', 'Runs after')}
      {list('next_journeys', 'Leads to')}
      {csv('roles', 'Roles', 'Comma-separated, e.g. ROLE_B2B_USER')}
      {csv('match_keywords', 'Match keywords', 'Phrases a test case about this journey would use; comma-separated')}
    </div>
  )
}

const StepsEditor: React.FC<{
  steps: StepDraft[]
  catalog: CatalogScreen[]
  rules: RuleOption[]
  onChange: (steps: StepDraft[]) => void
  onReset: () => void
}> = ({ steps, catalog, rules, onChange, onReset }) => {
  // Either-or screens ("A|B": the account decides) are offered when a step already uses one.
  const eitherOr = Array.from(new Set(steps.map(s => s.screen_id).filter((x): x is string => !!x && x.includes('|'))))
  const screenName = (id: string) => id.split('|').map(p => catalog.find(c => c.screen_id === p)?.name ?? p).join(' or ')
  const set = (i: number, patch: Partial<StepDraft>) => onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  const move = (i: number, by: number) => {
    const next = [...steps]
    const [s] = next.splice(i, 1)
    next.splice(i + by, 0, s)
    onChange(next)
  }
  const field = 'h-8 w-full rounded-[8px] border border-[#E8EAEE] bg-white px-2 text-[12.5px] text-[#1F2937]'
  const icon = 'h-7 w-7 rounded-[8px] text-[13px] font-bold text-[#374151] hover:bg-[#EEF4FF] disabled:opacity-30'
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#6B7280]">Steps</span>
        <button type="button" onClick={onReset} className="text-[11.5px] font-semibold text-[#1D4ED8] hover:underline">Reset to proposal</button>
      </div>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {steps.map((s, i) => (
          <li key={s.key} className="flex gap-2 rounded-[10px] border border-[#E8EAEE] bg-white p-2">
            <span className="w-5 flex-shrink-0 pt-1.5 text-right text-[12px] font-bold text-[#6B7280]">{i + 1}</span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <input aria-label={`Step ${i + 1} action`} className={`${field} ${s.action.trim() ? '' : 'border-[#F0C2C0]'}`}
                placeholder="What the user does" value={s.action} onChange={e => set(i, { action: e.target.value })} />
              <input aria-label={`Step ${i + 1} expected result`} className={field} placeholder="Expected result (optional)"
                value={s.expected_result} onChange={e => set(i, { expected_result: e.target.value })} />
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                <select aria-label={`Step ${i + 1} screen`} className={field} value={s.screen_id ?? ''}
                  onChange={e => set(i, { screen_id: e.target.value || undefined, element_id: undefined })}>
                  <option value="">No screen</option>
                  {eitherOr.map(id => <option key={id} value={id}>Either: {screenName(id)}</option>)}
                  {catalog.map(c => (
                    <option key={c.screen_id} value={c.screen_id}>{c.name}{c.source === 'proposed' ? ' · new' : ''}</option>
                  ))}
                </select>
                <select aria-label={`Step ${i + 1} element`} className={field} value={s.element_id ?? ''} disabled={!s.screen_id || s.screen_id.includes('|')}
                  onChange={e => set(i, { element_id: e.target.value || undefined })}>
                  <option value="">{!s.screen_id ? 'Choose a screen first' : s.screen_id.includes('|') ? 'No element on an either-or screen' : 'No element'}</option>
                  {(catalog.find(c => c.screen_id === s.screen_id)?.elements ?? []).map(el => (
                    <option key={el.element_id} value={el.element_id}>{el.label}{el.source === 'proposed' ? ' · new' : ''}</option>
                  ))}
                </select>
                <select aria-label={`Step ${i + 1} rule`} className={field} value={s.rule ?? ''} onChange={e => set(i, { rule: e.target.value || undefined })}>
                  <option value="">No rule</option>
                  {rules.map(r => (
                    <option key={r.rule_id} value={r.rule_id} title={r.statement ?? ''}>
                      {r.rule_id}{r.source === 'proposed' ? ' · new' : ''} — {(r.statement ?? '').slice(0, 60)}
                    </option>
                  ))}
                </select>
                <select aria-label={`Step ${i + 1} branch`} className={field} value={s.branch ?? ''} onChange={e => set(i, { branch: e.target.value || undefined })}>
                  <option value="">Main path</option>
                  <option value="alternate">Alternate path</option>
                  <option value="negative_only">Error path only</option>
                </select>
              </div>
              <span className="font-mono text-[11px] text-[#9CA3AF]">{s.from == null ? 'added by you' : `proposed step ${s.from}`}</span>
            </div>
            <div className="flex flex-shrink-0 flex-col">
              <button type="button" className={icon} aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button type="button" className={icon} aria-label={`Move step ${i + 1} down`} disabled={i === steps.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button type="button" className={`${icon} text-[#A3231C] hover:bg-[#FEEBEC]`} aria-label={`Remove step ${i + 1}`} disabled={steps.length === 1}
                onClick={() => onChange(steps.filter((_, j) => j !== i))}>✕</button>
            </div>
          </li>
        ))}
      </ol>
      <button type="button" className="w-fit text-[12px] font-semibold text-[#1D4ED8] hover:underline"
        onClick={() => onChange([...steps, { key: ++stepKeys, from: null, action: '', expected_result: '' }])}>+ Add step</button>
      <span className="text-[11px] text-[#6B7280]">A removed step also drops any new screen, element or rule only it needed; linking a step to a new (proposed) one keeps it in the change set.</span>
    </div>
  )
}

// --- PDF to structured Word ----------------------------------------------------------------
// A large Figma PDF that extraction struggles with can be written up page by
// page as a Word document: download it to read, or add it as a document of
// its own and extract that instead (backend services/journeys/doc_convert.py).

const saveBlob = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const ConvertPanel: React.FC<{
  doc: SourceDocument
  vision: string | null
  canExecute: boolean
  onChanged: () => void
  onMessage: (text: string, tone?: 'plain' | 'warn') => void
}> = ({ doc, vision, canExecute, onChanged, onMessage }) => {
  const conv: DocumentConversion = doc.conversion ?? { status: 'none' }
  const [mode, setMode] = useState<'ai' | 'text'>(conv.mode ?? 'ai')
  const [images, setImages] = useState(conv.images ?? true)
  const [busy, setBusy] = useState<string | null>(null)
  const running = conv.status === 'running'
  const total = conv.pages || doc.pages || 0
  const act = async (key: string, action: () => Promise<void>) => {
    setBusy(key)
    try { await action() } catch (err) { onMessage(errorText(err), 'warn') } finally { setBusy(null); onChanged() }
  }
  const radio = 'flex items-start gap-2 rounded-[10px] border px-3 py-2 text-[12.5px]'
  return (
    <div className="mt-2 flex flex-col gap-3 rounded-[12px] border border-[#E8EAEE] bg-[#FAFAFB] p-3 text-[12.5px]">
      <div className="text-[#374151]">
        <strong>Convert to Word.</strong> Writes the PDF up page by page as a structured .docx, useful when a large Figma export is too much for
        extraction. Download it to read, or add it as a document and extract that instead. A large file takes a while; you can leave this page.
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <label className={`${radio} ${mode === 'ai' ? 'border-[#F6D4D5] bg-white' : 'border-[#E8EAEE]'}`}>
          <input type="radio" name={`mode-${doc.id}`} checked={mode === 'ai'} onChange={() => setMode('ai')} disabled={running} className="mt-0.5" />
          <span><strong>AI-structured</strong>: each page as a screen with its purpose, sections, UI elements, actions and notes.{' '}
            {vision ? <>Reads the text and the screenshots ({vision}).</> : <>Reads the page text only (no vision model).</>}</span>
        </label>
        <label className={`${radio} ${mode === 'text' ? 'border-[#F6D4D5] bg-white' : 'border-[#E8EAEE]'}`}>
          <input type="radio" name={`mode-${doc.id}`} checked={mode === 'text'} onChange={() => setMode('text')} disabled={running} className="mt-0.5" />
          <span><strong>Text only</strong>: each page&apos;s own text, no model call. Fast.</span>
        </label>
      </div>
      <label className="flex items-center gap-2 text-[#374151]">
        <input type="checkbox" checked={images} onChange={e => setImages(e.target.checked)} disabled={running} />
        Include page pictures (tall pages in slices): a larger file, but each screen is visible
      </label>
      {running && (
        <div>
          <div className="mb-1 text-[#374151]">Converting… page {conv.page ?? 0} of {total || '?'}</div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[#E8EAEE]">
            <div className="h-full bg-[#B71920] transition-all" style={{ width: `${Math.round(100 * (conv.page ?? 0) / Math.max(1, total))}%` }} />
          </div>
        </div>
      )}
      {conv.status === 'failed' && conv.error && <Note tone="warn">{conv.error}</Note>}
      {conv.ready && (
        <div className="text-[#374151]">
          Ready: <strong>{conv.filename}</strong>
          {conv.size_bytes != null && <> · {(conv.size_bytes / (1024 * 1024)).toFixed(1)} MB</>}
          {conv.mode && <> · {conv.mode === 'ai' ? 'AI-structured' : 'text only'}</>}
          {conv.finished_at && <> · {new Date(`${conv.finished_at}Z`).toLocaleString()}</>}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN_PRIMARY} disabled={!canExecute || running || busy !== null}
          title={canExecute ? undefined : 'Needs the automation.execute permission'}
          onClick={() => void act('convert', async () => { await knowledgeBaseService.convertDocument(doc.id, mode, images) })}>
          {running ? 'Converting…' : conv.ready ? 'Convert again' : 'Convert to Word'}
        </button>
        {conv.ready && (
          <>
            <button type="button" className={BTN_PLAIN} disabled={busy !== null}
              onClick={() => void act('download', async () => saveBlob(await knowledgeBaseService.downloadConversion(doc.id), conv.filename || 'structured.docx'))}>
              {busy === 'download' ? 'Downloading…' : 'Download .docx'}
            </button>
            <button type="button" className={BTN_PLAIN} disabled={!canExecute || busy !== null}
              title="Add the Word document to this list, then Extract it"
              onClick={() => void act('add', async () => {
                const added = await knowledgeBaseService.addConversion(doc.id)
                onMessage(added.duplicate ? `${added.filename} is already in the list.` : `${added.filename} added. Extract it to see what it proposes.`)
              })}>
              {busy === 'add' ? 'Adding…' : 'Add as document'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// --- The list of uploaded documents --------------------------------------------------------

export const DocumentsCard: React.FC<{
  appKey: string
  canExecute: boolean
  onReview: (doc: SourceDocument) => void
  onOpenChangeSets: () => void
}> = ({ appKey, canExecute, onReview, onOpenChangeSets }) => {
  const [docs, setDocs] = useState<SourceDocument[] | null>(null)
  const [vision, setVision] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'plain' | 'warn'; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [kind, setKind] = useState<'screen_flow' | 'brd'>('screen_flow')
  const [converting, setConverting] = useState<number | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const load = useCallback(() => {
    knowledgeBaseService.documents(appKey)
      .then(r => { setDocs(r.documents); setVision(r.vision_model); setError(null) })
      .catch(err => setError(errorText(err)))
  }, [appKey])
  useEffect(load, [load])
  const extracting = docs?.some(d => d.status === 'extracting' || d.conversion?.status === 'running')
  useEffect(() => {
    if (!extracting) return
    const t = window.setInterval(load, 3000)
    return () => window.clearInterval(t)
  }, [extracting, load])

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key)
    setMessage(null)
    try { await action() } catch (err) { setMessage({ tone: 'warn', text: errorText(err) }) } finally { setBusy(null); load() }
  }

  const upload = (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    void run('upload', async () => {
      const doc = await knowledgeBaseService.uploadDocument(appKey, file, kind)
      setMessage({ tone: 'plain', text: doc.duplicate ? `${file.name} was uploaded before, as ${doc.filename}; that copy is shown.` : `${file.name} uploaded. Extract it to see what it proposes.` })
    })
    if (input.current) input.current.value = ''
  }

  return (
    <Card label="Uploaded documents">
      <CardHead
        title="Uploaded documents"
        hint="PDF screen flows and BRDs. Extraction proposes journeys, screens, elements and rules for you to review; nothing is written until a change set is approved"
        right={
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Document kind" value={kind} onChange={e => setKind(e.target.value as 'screen_flow' | 'brd')}
              className="h-[34px] rounded-[10px] border border-[#E8EAEE] bg-white px-2.5 text-[12.5px] font-semibold text-[#374151]">
              <option value="screen_flow">Screen flow PDF</option>
              <option value="brd">BRD</option>
            </select>
            <input ref={input} type="file" accept=".pdf,.docx" className="hidden" onChange={e => upload(e.target.files)} />
            <button type="button" onClick={() => input.current?.click()} disabled={!canExecute || busy !== null}
              title={canExecute ? 'PDF or Word .docx, up to 30 MB' : 'Needs the automation.execute permission'} className={BTN_PRIMARY}>
              {busy === 'upload' ? 'Uploading…' : 'Upload PDF or BRD'}
            </button>
          </div>
        }
      />
      <div className="flex flex-col gap-2 px-5 pb-3">
        {!vision && (
          <Note>
            Extraction reads the page <strong>text</strong> only: no vision model is configured, so screenshots are not read and a label that appears only in a
            screenshot is marked <em>inferred</em> for you to check. Configure Azure OpenAI (<code>AZURE_OPENAI_*</code>) on the backend to read pages as pictures.
          </Note>
        )}
        {vision && <Note>Pages are read as text and as pictures by <code>{vision}</code>; a tall Figma page is read in slices. Files up to 30 MB; a large one takes a while.</Note>}
        {kind === 'brd' && (
          <Note>
            A <strong>BRD</strong> describes a change, so it may also <em>rename</em> elements, <em>revise</em> the steps of authored journeys and
            <em> restate</em> rules. Each change is reviewed with its impact on journeys, test cases and crawled selectors, and after approval
            the follow-ups appear under Change &amp; Heal.
          </Note>
        )}
        {message && <Note tone={message.tone}>{message.text}</Note>}
      </div>
      {error && <Failed message={error} onRetry={load} />}
      {!docs && !error && <Loading what="documents" />}
      {docs && docs.length === 0 && <div className="px-5 pb-5 text-[12.5px] text-[#6B7280]">No document uploaded yet.</div>}
      <ul className="m-0 list-none p-0">
        {docs?.map(doc => {
          const add = Object.entries(doc.counts ?? {}).filter(([k]) => k.endsWith('.add')).reduce((n, [, v]) => n + v, 0)
          const openDraft = doc.change_set_id && ['draft', 'conflicted'].includes(doc.change_set_status ?? '')
          return (
            <li key={doc.id} className="border-t border-[#F1F2F4] px-5 py-3 text-[12.5px]">
             <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <div className="truncate font-semibold text-[#1F2937]" title={doc.filename}>{doc.filename}</div>
                <div className="flex flex-wrap items-center gap-x-2 text-[11.5px] text-[#6B7280]">
                  <span>{doc.doc_kind === 'brd' ? 'BRD' : 'Screen flow'}</span>
                  {doc.pages != null && <span>· {doc.pages} page{doc.pages === 1 ? '' : 's'}</span>}
                  <span>· {(doc.size_bytes / 1024).toFixed(0)} KB</span>
                  {doc.created_by && <span>· uploaded by {doc.created_by}</span>}
                  {doc.counts && <span>· {add} new item{add === 1 ? '' : 's'} proposed{doc.vision === false ? ' from text only' : ''}</span>}
                  {doc.change_set_id && <span>· change set #{doc.change_set_id} {doc.change_set_status ?? 'removed'}</span>}
                </div>
                {doc.status === 'failed' && doc.error && <div className="mt-1 text-[11.5px] text-[#A3231C]">{doc.error}</div>}
              </div>
              <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
                <Chip tone={STATUS[doc.status].tone}>{STATUS[doc.status].label}</Chip>
                {['extracted', 'drafted'].includes(doc.status) && (
                  <button type="button" className={BTN_PRIMARY} onClick={() => onReview(doc)}>Review</button>
                )}
                {openDraft && <button type="button" className={BTN_PLAIN} onClick={onOpenChangeSets}>Open change set</button>}
                {doc.status !== 'extracting' && !openDraft && (
                  <button type="button" className={BTN_PLAIN} disabled={!canExecute || busy !== null}
                    onClick={() => void run(`x${doc.id}`, async () => { await knowledgeBaseService.extractDocument(doc.id) })}>
                    {doc.status === 'uploaded' ? 'Extract' : 'Extract again'}
                  </button>
                )}
                {doc.filename.toLowerCase().endsWith('.pdf') && (
                  <button type="button" className={BTN_PLAIN} aria-expanded={converting === doc.id}
                    onClick={() => setConverting(converting === doc.id ? null : doc.id)}>
                    {doc.conversion?.status === 'running' ? 'Converting to Word…' : doc.conversion?.ready ? 'Word version' : 'Convert to Word'}
                  </button>
                )}
                {doc.status !== 'extracting' && !openDraft && (
                  <button type="button" className={`${BTN} text-[#A3231C] hover:underline`} disabled={!canExecute || busy !== null}
                    onClick={() => { if (window.confirm(`Delete ${doc.filename} and its extraction? Knowledge already published from it stays.`)) void run(`d${doc.id}`, () => knowledgeBaseService.deleteDocument(doc.id)) }}>
                    Delete
                  </button>
                )}
              </div>
             </div>
              {converting === doc.id && (
                <ConvertPanel doc={doc} vision={vision} canExecute={canExecute} onChanged={load}
                  onMessage={(text, tone = 'plain') => setMessage({ tone, text })} />
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

// --- Reviewing one extraction ---------------------------------------------------------------

const PageViewer: React.FC<{ docId: number; page: number; pages: { page: number; text: string }[]; images: boolean; onPage: (n: number) => void }> = ({ docId, page, pages, images, onPage }) => {
  const [mode, setMode] = useState<'picture' | 'text'>(images ? 'picture' : 'text')
  const [src, setSrc] = useState<string | null>(null)
  const [imgError, setImgError] = useState<string | null>(null)
  useEffect(() => {
    if (!images || mode !== 'picture') return
    let live = true
    let url: string | null = null
    setSrc(null)
    setImgError(null)
    knowledgeBaseService.documentPageImage(docId, page)
      .then(u => { url = u; if (live) setSrc(u); else URL.revokeObjectURL(u) })
      .catch(err => live && setImgError(errorText(err)))
    return () => { live = false; if (url) URL.revokeObjectURL(url) }
  }, [docId, page, mode, images])
  const text = pages.find(p => p.page === page)?.text ?? ''
  return (
    <Card className="flex flex-col xl:sticky xl:top-4" label="Document page">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#F1F2F4] px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {pages.map(p => (
            <button key={p.page} type="button" onClick={() => onPage(p.page)}
              className={`h-7 min-w-[28px] rounded-[8px] px-2 text-[12px] font-bold ${p.page === page ? 'bg-[#B71920] text-white' : 'bg-[#F4F5F7] text-[#374151] hover:bg-[#FFF5F5]'}`}>
              {p.page}
            </button>
          ))}
        </div>
        {images && (
          <div className="flex rounded-[8px] bg-[#F4F5F7] p-0.5 text-[12px] font-semibold">
            {(['picture', 'text'] as const).map(m => (
              <button key={m} type="button" onClick={() => setMode(m)}
                className={`rounded-[6px] px-2.5 py-1 ${mode === m ? 'bg-white text-[#1F2937] shadow-sm' : 'text-[#6B7280]'}`}>{m === 'picture' ? 'Page' : 'Text'}</button>
            ))}
          </div>
        )}
      </div>
      <div className="max-h-[75vh] overflow-auto p-3">
        {mode === 'picture' && images
          ? (imgError ? <Note tone="warn">{imgError}</Note> : src ? <img src={src} alt={`Page ${page}`} className="w-full rounded-[8px] border border-[#E8EAEE]" /> : <Loading what={`page ${page}`} />)
          : <pre className="m-0 whitespace-pre-wrap break-words font-sans text-[12.5px] leading-5 text-[#374151]">{text || '(no text on this page)'}</pre>}
      </div>
    </Card>
  )
}

// Journeys the document describes that the master topic list does not have.
// Extraction never invents a place for a journey; the reviewer gives it one
// here -- an existing chapter, or a new chapter -- in one change set, and the
// stored extraction is matched again (no second model call).
const NEW_CHAPTER = '__new__'

const UnplacedCard: React.FC<{
  doc: SourceDocument
  items: ReviewItem[]
  onDocument: (doc: SourceDocument) => void
  /** Told once the journeys are placed: this card goes away with them, so the review shows the outcome. */
  onPlaced: (text: string) => void
}> = ({ doc, items, onDocument, onPlaced }) => {
  const [taxonomy] = useLoad(doc.app_id, () => knowledgeBaseService.taxonomy(doc.app_id))
  const [rows, setRows] = useState(() => items.map(i => ({ item_id: i.item_id, keep: true, title: i.title, parent: '', chapter: '' })))
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ tone: 'plain' | 'warn'; text: string; rematch?: boolean } | null>(null)
  // Reset only when the unplaced journeys change (a re-match), not on every render.
  const itemKey = items.map(i => i.item_id).join('|')
  useEffect(() => {
    setRows(items.map(i => ({ item_id: i.item_id, keep: true, title: i.title, parent: '', chapter: '' })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemKey])

  // Where a journey may go: chapters and the groups under them, in tree order.
  const parents = useMemo(() => {
    const nodes = taxonomy?.nodes ?? []
    const byId = new Map(nodes.map(n => [n.id, n]))
    const out: { id: string; label: string }[] = []
    const walk = (id: string, depth: number) => {
      const n = byId.get(id)
      if (!n || !(n.kind === 'chapter' || n.kind === 'group')) return
      out.push({ id, label: `${'\u00a0\u00a0'.repeat(depth)}${n.kind === 'chapter' ? chapterTitle(n.title) : n.title}` })
      n.children.forEach(c => walk(c, depth + 1))
    }
    ;(taxonomy?.roots ?? []).forEach(r => walk(r, 0))
    return out
  }, [taxonomy])

  const kept = rows.filter(r => r.keep)
  const ready = kept.length > 0 && kept.every(r => r.title.trim() && (r.parent === NEW_CHAPTER ? r.chapter.trim() : r.parent))
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(prev => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const place = async () => {
    setBusy(true)
    setResult(null)
    try {
      const r = await knowledgeBaseService.placeDocumentJourneys(doc.id, kept.map(row => ({
        title: row.title.trim(),
        ...(row.parent === NEW_CHAPTER ? { new_chapter: row.chapter.trim() } : { parent_id: row.parent })
      })), true)
      if (r.published) {
        onPlaced(`${kept.length} journey${kept.length === 1 ? '' : 's'} added to the master list (version ${r.version?.number ?? ''}) and the document matched again: they are now proposed below.`)
        onDocument(r.document)
      } else {
        onDocument(r.document)
        setResult({ tone: 'warn', text: `${r.message ?? 'Saved as a change set.'} Once change set #${r.change_set.id} is approved, match the document again.`, rematch: true })
      }
    } catch (err) {
      setResult({ tone: 'warn', text: errorText(err) })
    } finally {
      setBusy(false)
    }
  }
  const rematch = async () => {
    setBusy(true)
    try {
      onDocument(await knowledgeBaseService.rematchDocument(doc.id))
      setResult(null)
    } catch (err) {
      setResult({ tone: 'warn', text: errorText(err), rematch: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card label="Not in the master list">
      <CardHead
        title={`Not in the master list · ${items.length}`}
        hint="Journeys this document describes that the master topic list does not have yet. Choose where each one belongs; they are added in one change set and the document is matched again, without another model call."
      />
      <ul className="m-0 flex list-none flex-col gap-2 px-5 pb-3">
        {rows.map((row, i) => (
          <li key={row.item_id} className="grid items-center gap-2 text-[12.5px] sm:grid-cols-[18px_minmax(0,1.2fr)_minmax(0,1fr)]">
            <input type="checkbox" aria-label={`Add ${row.title}`} className="h-4 w-4 accent-[#B71920]" checked={row.keep} onChange={e => set(i, { keep: e.target.checked })} />
            <input aria-label="Journey name" className="h-8 rounded-[8px] border border-[#E8EAEE] px-2" value={row.title} disabled={!row.keep}
              onChange={e => set(i, { title: e.target.value })} />
            <div className="flex gap-2">
              <select aria-label={`Where ${row.title} goes`} className="h-8 min-w-0 flex-1 rounded-[8px] border border-[#E8EAEE] bg-white px-2" value={row.parent} disabled={!row.keep}
                onChange={e => set(i, { parent: e.target.value })}>
                <option value="">Choose a chapter…</option>
                {parents.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                <option value={NEW_CHAPTER}>+ New chapter…</option>
              </select>
              {row.parent === NEW_CHAPTER && (
                <input aria-label="New chapter name" placeholder="Chapter name" className="h-8 min-w-0 flex-1 rounded-[8px] border border-[#E8EAEE] px-2"
                  value={row.chapter} onChange={e => set(i, { chapter: e.target.value })} />
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2 px-5 pb-5">
        <button type="button" className={BTN_PRIMARY} disabled={busy || !ready} onClick={() => void place()}
          title={!ready ? 'Each kept journey needs a name and a place' : undefined}>
          {busy ? 'Adding…' : `Add ${kept.length} to the master list`}
        </button>
        {result?.rematch && <button type="button" className={BTN_PLAIN} disabled={busy} onClick={() => void rematch()}>Match again</button>}
        {result && <Note tone={result.tone}>{result.text}</Note>}
      </div>
    </Card>
  )
}

export const DocumentReview: React.FC<{
  docId: number
  canExecute: boolean
  onBack: () => void
  onDrafted: () => void
}> = ({ docId, canExecute, onBack, onDrafted }) => {
  const [doc, setDoc] = useState<SourceDocument | null>(null)
  const [pages, setPages] = useState<{ pages: { page: number; text: string }[]; images: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({})
  const [stepEdits, setStepEdits] = useState<Record<string, StepDraft[]>>({})
  const [listEdits, setListEdits] = useState<Record<string, Partial<JourneyLinks>>>({})
  const [additions, setAdditions] = useState<DocumentAddition[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ tone: 'plain' | 'warn'; text: string } | null>(null)

  useEffect(() => {
    let live = true
    Promise.all([knowledgeBaseService.document(docId), knowledgeBaseService.documentPages(docId)])
      .then(([d, p]) => {
        if (!live) return
        setDoc(d)
        setPages(p)
        setSelected(new Set((d.extraction?.items ?? []).filter(i => i.selected).map(i => i.item_id)))
      })
      .catch(err => live && setError(errorText(err)))
    return () => { live = false }
  }, [docId])

  const items = doc?.extraction?.items ?? []
  const byId = useMemo(() => new Map(items.map(i => [i.item_id, i])), [items])
  // Everything the selection depends on, as the backend will add it.
  const closure = useMemo(() => {
    const out = new Set(selected)
    const queue = Array.from(selected)
    while (queue.length) {
      const id = queue.pop()!
      const item = byId.get(id)
      for (const need of item ? requiresOf(item, stepEdits[id]) : []) {
        if (byId.get(need)?.selectable && !out.has(need)) { out.add(need); queue.push(need) }
      }
    }
    return out
  }, [selected, byId, stepEdits])
  const emptyStep = Object.entries(stepEdits).some(([id, steps]) => closure.has(id) && steps.some(s => !s.action.trim()))
  const openDraft = !!doc?.change_set_id && ['draft', 'conflicted'].includes(doc.change_set_status ?? '')
  const locked = openDraft || !canExecute

  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const buildEdits = useCallback(() => {
    const keptEdits: Record<string, Record<string, unknown>> = Object.fromEntries(Object.entries(edits).filter(([id]) => closure.has(id)))
    for (const [id, lists] of Object.entries(listEdits)) {
      if (selected.has(id)) keptEdits[id] = { ...keptEdits[id], ...lists }
    }
    for (const [id, steps] of Object.entries(stepEdits)) {
      if (!selected.has(id)) continue
      keptEdits[id] = {
        ...keptEdits[id],
        steps: steps.map(s => ({
          from: s.from, action: s.action.trim(), expected_result: s.expected_result.trim(),
          screen_id: s.screen_id ?? null, element_id: s.element_id ?? null, rule: s.rule ?? null, branch: s.branch ?? null
        }))
      }
    }
    return keptEdits
  }, [edits, stepEdits, listEdits, selected, closure])

  // What the current selection would touch, refreshed as it changes.
  const [impact, setImpact] = useState<KbImpact | null>(null)
  const [impactError, setImpactError] = useState<string | null>(null)
  useEffect(() => {
    if (!doc?.extraction || selected.size === 0 || emptyStep) { setImpact(null); return }
    let live = true
    const t = window.setTimeout(() => {
      knowledgeBaseService.documentImpact(docId, Array.from(selected), buildEdits(), additions)
        .then(r => { if (live) { setImpact(r); setImpactError(null) } })
        .catch(err => { if (live) setImpactError(errorText(err)) })
    }, 500)
    return () => { live = false; window.clearTimeout(t) }
  }, [docId, doc?.extraction, selected, emptyStep, buildEdits, additions])

  const submit = async () => {
    setBusy(true)
    setResult(null)
    try {
      const r = await knowledgeBaseService.draftFromDocument(docId, Array.from(selected), buildEdits(), additions)
      setDoc(prev => prev ? { ...prev, ...r.document } : prev)
      setResult({ tone: 'plain', text: `Change set #${r.change_set.id} drafted${r.auto_included.length ? `, including ${r.auto_included.length} item(s) the selection depends on` : ''}. Review and approve it in the Change sets drawer.` })
      onDrafted()
    } catch (err) {
      setResult({ tone: 'warn', text: errorText(err) })
    } finally {
      setBusy(false)
    }
  }

  if (error) return <Card><Failed message={error} /></Card>
  if (!doc || !pages) return <Card><Loading what="the extraction" /></Card>
  // The catalog steps may link to, with what the reviewer added.
  const fullCatalog: CatalogScreen[] = (() => {
    const screens = (doc.catalog ?? []).map(c => ({ ...c, elements: [...c.elements] }))
    for (const a of additions) {
      if (a.kind === 'screen') screens.push({ screen_id: addedScreenId(a.name), name: a.name, source: 'proposed', elements: [] })
    }
    for (const a of additions) {
      if (a.kind === 'element') screens.find(c => c.screen_id === a.screen_id)?.elements.push({ element_id: snake(a.label), label: a.label, source: 'proposed' })
    }
    return screens
  })()
  const ex = doc.extraction
  const proposed = items.filter(i => i.selectable)
  const known = items.filter(i => !i.selectable)
  const unplaced = items.filter(i => i.kind === 'journey' && i.action === 'no_place')
  const takeDocument = (next: SourceDocument) => {
    setDoc(prev => (prev ? { ...prev, ...next } : next))
    setSelected(new Set((next.extraction?.items ?? []).filter(i => i.selected).map(i => i.item_id)))
  }

  const row = (item: ReviewItem) => {
    const on = closure.has(item.item_id)
    const implied = on && !selected.has(item.item_id)
    const edit = edits[item.item_id] ?? {}
    const title = edit[EDITABLE[item.kind][0]?.key] ?? item.title
    return (
      <li key={item.item_id} className={`flex gap-3 border-t border-[#F1F2F4] px-4 py-2.5 text-[12.5px] ${on ? 'bg-white' : 'bg-[#FAFAFB]'}`}>
        {item.selectable
          ? <input type="checkbox" aria-label={`Keep ${item.title}`} className="mt-0.5 h-4 w-4 flex-shrink-0 accent-[#B71920]" checked={on} disabled={locked || implied}
              title={implied ? 'Included because a kept item depends on it' : undefined} onChange={() => toggle(item.item_id)} />
          : <span className="w-4 flex-shrink-0" />}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`min-w-0 font-semibold ${on ? 'text-[#1F2937]' : 'text-[#6B7280]'}`}>{title}</span>
            <Chip tone={ACTION[item.action].tone}>{ACTION[item.action].label}</Chip>
            {item.value?.basis === 'inferred' && <Chip tone="warn" title="Not found in the page text">Inferred</Chip>}
            {implied && <Chip tone="idle">needed</Chip>}
            {item.pages.map(p => (
              <button key={p} type="button" onClick={() => setPage(p)} className="text-[11.5px] font-semibold text-[#1D4ED8] hover:underline">p{p}</button>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-2 text-[11.5px] text-[#6B7280]">
            {item.kind === 'element' && <span className="font-mono">{item.screen_id} · {item.element_id}</span>}
            {item.kind === 'element' && item.value && <span>{item.value.type}{item.value.locator_hint ? ` · hint ${item.value.locator_hint}` : ''}</span>}
            {item.kind === 'screen' && <span className="font-mono">{item.screen_id}</span>}
            {item.kind === 'journey' && item.journey_id && <span className="font-mono">{item.journey_id}</span>}
            {item.detail && <span>{item.detail}</span>}
            {item.evidence && <span className="italic">“{item.evidence}”</span>}
          </div>
          {item.warnings.map(w => <div key={w} className="text-[11.5px] text-[#8A5000]">⚠ {w}</div>)}
          {item.action === 'revise' && item.value?.current_steps && editing !== item.item_id && (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-[#374151]">Current steps ({item.value.current_steps.length})</summary>
              <ol className="m-0 mt-1 flex flex-col gap-1 pl-5">
                {item.value.current_steps.map((s: any) => (
                  <li key={s.step_number} className={item.value?.delta?.removed?.includes(s.step_number) ? 'text-[#A3231C] line-through' : 'text-[#6B7280]'}>
                    {s.action}
                  </li>
                ))}
              </ol>
            </details>
          )}
          {item.kind === 'journey' && item.value?.steps && editing !== item.item_id && (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-[#374151]">
                {(stepEdits[item.item_id] ?? item.value.steps).length} steps{stepEdits[item.item_id] ? ' · edited' : ''}
              </summary>
              <ol className="m-0 mt-1 flex flex-col gap-1 pl-5">
                {(stepEdits[item.item_id] ?? draftsOf(item)).map((s: StepDraft) => (
                  <li key={s.key} className={item.action === 'revise' && s.from != null && item.value?.delta?.added?.includes(s.from) ? 'text-[#136B34]'
                    : item.action === 'revise' && s.from != null && item.value?.delta?.changed?.includes(s.from) ? 'text-[#8A5000]' : 'text-[#374151]'}>
                    {s.action}{s.expected_result ? <span className="text-[#6B7280]"> → {s.expected_result}</span> : null}
                    <span className="ml-1 font-mono text-[11px] text-[#9CA3AF]">{[s.screen_id, s.element_id].filter(Boolean).join(' · ')}{s.branch ? ` · ${s.branch}` : ''}{s.rule ? ` · ${s.rule}` : ''}</span>
                  </li>
                ))}
              </ol>
            </details>
          )}
          {editing === item.item_id && (
            <div className="flex flex-col gap-1.5 rounded-[10px] bg-[#F9FAFB] p-2.5">
              {EDITABLE[item.kind].map(f => (
                <label key={f.key} className="flex flex-col gap-0.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[#6B7280]">
                  {f.label}
                  <input className="h-8 rounded-[8px] border border-[#E8EAEE] bg-white px-2 text-[12.5px] font-normal normal-case tracking-normal text-[#1F2937]"
                    value={edit[f.key] ?? item.value?.[f.key] ?? ''}
                    onChange={e => setEdits(prev => ({ ...prev, [item.item_id]: { ...prev[item.item_id], [f.key]: e.target.value } }))} />
                </label>
              ))}
              <span className="text-[11px] text-[#6B7280]">{item.kind === 'element' ? 'Quote the label exactly as the page shows it; the locator hint follows the label.' : 'Your wording replaces the proposal.'}</span>
              {item.kind === 'journey' && item.action === 'add' && (
                <JourneyLinksEditor
                  value={{ ...(item.value ?? {}), ...(listEdits[item.item_id] ?? {}) } as JourneyLinks}
                  journeys={doc.journey_catalog ?? []}
                  self={item.journey_id ?? ''}
                  onChange={patch => setListEdits(prev => ({ ...prev, [item.item_id]: { ...prev[item.item_id], ...patch } }))}
                />
              )}
              {item.kind === 'journey' && (
                <StepsEditor
                  steps={stepEdits[item.item_id] ?? draftsOf(item)}
                  catalog={fullCatalog}
                  rules={doc.rule_catalog ?? []}
                  onChange={steps => setStepEdits(prev => ({ ...prev, [item.item_id]: steps }))}
                  onReset={() => setStepEdits(prev => { const next = { ...prev }; delete next[item.item_id]; return next })}
                />
              )}
            </div>
          )}
        </div>
        {item.selectable && !locked && item.value && (
          <button type="button" className="h-7 flex-shrink-0 self-start rounded-[8px] px-2 text-[12px] font-semibold text-[#1D4ED8] hover:bg-[#EEF4FF]"
            onClick={() => setEditing(e => e === item.item_id ? null : item.item_id)}>{editing === item.item_id ? 'Done' : 'Edit'}</button>
        )}
      </li>
    )
  }

  const group = (list: ReviewItem[], kind: ReviewItem['kind']) => {
    const of = list.filter(i => i.kind === kind)
    if (!of.length) return null
    return (
      <section key={kind}>
        <h3 className="m-0 bg-[#F4F5F7] px-4 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-[#374151]">{KIND_LABEL[kind]} · {of.length}</h3>
        <ul className="m-0 list-none p-0">{of.map(row)}</ul>
      </section>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <button type="button" onClick={onBack} className="text-[12.5px] font-semibold text-[#1D4ED8] hover:underline">← Sources</button>
          <h2 className="m-0 truncate text-[18px] font-bold text-[#1F2937]">Review · {doc.filename}</h2>
          <p className="m-0 mt-0.5 text-[12.5px] text-[#6B7280]">
            {ex ? `Proposed by ${ex.model} from ${ex.vision ? 'page text and pictures' : 'page text only'} · ${ex.pages.length} page(s) in ${ex.calls} call(s), ${ex.seconds}s` : 'Not extracted yet'}
          </p>
        </div>
        <button type="button" className={BTN_PRIMARY} disabled={locked || busy || closure.size === 0 || emptyStep} onClick={() => void submit()}
          title={!canExecute ? 'Needs the automation.execute permission' : openDraft ? 'A change set from this document awaits review' : emptyStep ? 'Every step needs an action' : undefined}>
          {busy ? 'Drafting…' : `Create change set · ${closure.size + additions.length} item${closure.size + additions.length === 1 ? '' : 's'}`}
        </button>
      </div>
      {openDraft && <Note>Change set #{doc.change_set_id} from this document is awaiting review. Approve, reject or discard it in the Change sets drawer before drafting again.</Note>}
      {ex && !ex.vision && <Note tone="warn">Screenshots were not read. Items marked <strong>Inferred</strong> name labels the page text does not contain — compare them with the page picture before keeping them, and correct the wording with Edit.</Note>}
      {result && <Note tone={result.tone}>{result.text}</Note>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div><PageViewer docId={docId} page={page} pages={pages.pages} images={pages.images} onPage={setPage} /></div>
        <div className="flex flex-col gap-4">
          <AdditionsCard additions={additions} catalog={fullCatalog} page={page} locked={locked} onChange={setAdditions} />
          {selected.size > 0 && (
            <Card label="Impact">
              <CardHead title="Impact of this selection" hint="What approving it would touch. After approval the affected test cases are re-diffed and the follow-ups appear under Change & Heal." />
              <div className="px-5 pb-4">
                {impactError ? <Note tone="warn">{impactError}</Note> : impact ? <ImpactSummary impact={impact} /> : <span className="text-[12.5px] text-[#6B7280]">Working it out…</span>}
              </div>
            </Card>
          )}
          <Card label="Proposed">
            <CardHead title={`Proposed · ${proposed.length}`} hint="Tick what should become design knowledge. Selecting a journey also keeps the screens, elements and rules it needs." />
            {proposed.length === 0 && <div className="px-5 pb-5 text-[12.5px] text-[#6B7280]">Nothing new: everything this document describes is already in the Journey KB.</div>}
            {(['journey', 'screen', 'element', 'rule'] as const).map(k => group(proposed, k))}
          </Card>
          {unplaced.length > 0 && canExecute && doc.status === 'extracted' && <UnplacedCard doc={doc} items={unplaced} onDocument={takeDocument} onPlaced={text => setResult({ tone: 'plain', text })} />}
          {known.length > 0 && (
            <Card label="Already known">
              <CardHead title={`Already known or not placeable · ${known.length}`} hint="Shown for comparison; nothing here is written. Label differences are settled in Reconcile." />
              {(['journey', 'screen', 'element', 'rule'] as const).map(k => group(known, k))}
            </Card>
          )}
          {!!ex?.open_questions.length && (
            <Card label="Open questions">
              <CardHead title="Open questions from the model" />
              <ul className="m-0 flex flex-col gap-1 px-9 pb-4 text-[12.5px] text-[#374151]">{ex.open_questions.map(q => <li key={q}>{q}</li>)}</ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
