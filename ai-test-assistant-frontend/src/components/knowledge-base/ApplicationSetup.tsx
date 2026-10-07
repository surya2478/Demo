import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import knowledgeBaseService, { errorText, type AppRegistration, type KbOverview } from '../../services/knowledgeBaseService'
import testDataService, { type DataApp } from '../../services/testDataService'
import { Card, CardHead, Chip, Failed, Loading, Note, useLoad } from './kbUi'

// Start here: the stage a new engineer lands on. It answers "is this
// application set up, and what do I do next?" as four steps, in the order the
// work happens --
//
//   1 Register     the application, its key and its address per environment
//   2 Design       documents in, journeys out (Sources, Journey KB, App Model)
//   3 Crawl        the live application, so each element gets a selector
//   4 Confirm      the Journey Map: every step beside the selector doing it
//
// -- and holds what step 1 needs: the name (renamed in every place it is shown,
// the key never changes), the environments and a Journey KB. New applications
// are registered from NewApplicationDialog in one call.

const BTN = 'h-[34px] rounded-[10px] px-3.5 text-[12.5px] font-bold disabled:cursor-not-allowed disabled:opacity-50'
export const BTN_PRIMARY = `${BTN} bg-[#B71920] text-white hover:opacity-95`
export const BTN_PLAIN = `${BTN} border border-[#E8EAEE] bg-white text-[#1F2937] hover:border-[#F6D4D5]`
const FIELD = 'w-full rounded-[10px] border border-[#E8EAEE] bg-white px-2.5 text-[13px] text-[#1F2937] focus:border-[#F1A4A6] focus:outline-none'
const INPUT = `h-[34px] ${FIELD}`
const TEXTAREA = `min-h-[150px] py-2 font-mono text-[12.5px] normal-case tracking-normal ${FIELD}`
const LABEL = 'flex flex-col gap-1 text-[11px] font-bold uppercase tracking-[0.08em] text-[#6B7280]'
const COMMON_ENVIRONMENTS = ['SIT', 'UAT', 'RC', 'PREPRODUCTION', 'PROD']

export const keyFromName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100)

const OUTLINE_EXAMPLE = `Sign in
  Sign in with password
  Sign in with OTP
Accounts
  View all accounts
  Search accounts
Payments
  Pay a bill
    Pay by card`

// --- Environments: rows of environment + address ---------------------------------------

type EnvRow = { env: string; address: string }

const EnvironmentRows: React.FC<{
  rows: EnvRow[]
  defaultEnv: string
  onRows: (rows: EnvRow[]) => void
  onDefault: (env: string) => void
}> = ({ rows, defaultEnv, onRows, onDefault }) => {
  const set = (i: number, patch: Partial<EnvRow>) => onRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const unused = COMMON_ENVIRONMENTS.find(e => !rows.some(r => r.env.toUpperCase() === e)) ?? ''
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[88px_minmax(0,1fr)_auto_28px] sm:grid-cols-[110px_minmax(0,1fr)_74px_28px] gap-2 text-[10.5px] font-bold uppercase tracking-[0.1em] text-[#6B7280]">
        <span>Environment</span><span>Address</span><span className="hidden sm:inline">Default</span><span />
      </div>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[88px_minmax(0,1fr)_auto_28px] sm:grid-cols-[110px_minmax(0,1fr)_74px_28px] items-center gap-2">
          <input aria-label="Environment" list="kb-environments" className={INPUT} value={r.env}
            onChange={e => {
              const env = e.target.value.toUpperCase()
              if (defaultEnv === r.env) onDefault(env)
              set(i, { env })
            }} />
          <input aria-label={`${r.env || 'Environment'} address`} className={INPUT} placeholder="https://sit.example.com/portal" value={r.address}
            onChange={e => set(i, { address: e.target.value })} />
          <label className="flex items-center gap-1.5 text-[12px] text-[#374151]">
            <input type="radio" name="kb-default-env" aria-label={`${r.env} is the default`} className="accent-[#B71920]" checked={!!r.env && defaultEnv === r.env} onChange={() => onDefault(r.env)} />
            <span className="hidden sm:inline">default</span>
          </label>
          <button type="button" aria-label={`Remove ${r.env}`} title="Remove this environment" disabled={rows.length === 1}
            className="h-7 w-7 rounded-[8px] text-[16px] text-[#6B7280] hover:bg-[#FEEBEC] hover:text-[#A3231C] disabled:opacity-30"
            onClick={() => onRows(rows.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <datalist id="kb-environments">{COMMON_ENVIRONMENTS.map(e => <option key={e} value={e} />)}</datalist>
      <button type="button" className="w-fit text-[12.5px] font-semibold text-[#1D4ED8] hover:underline" onClick={() => onRows([...rows, { env: unused, address: '' }])}>
        + Add environment
      </button>
    </div>
  )
}

const addressesOf = (rows: EnvRow[]) =>
  Object.fromEntries(rows.filter(r => r.env.trim() && r.address.trim()).map(r => [r.env.trim().toUpperCase(), r.address.trim()]))

// --- New application -------------------------------------------------------------------

export const NewApplicationDialog: React.FC<{
  /** Registering a Journey KB that has no application yet: key and name are fixed. */
  existingKb?: { app_key: string; name: string } | null
  onClose: () => void
  onCreated: (result: { app_key: string; crawl_app_id: number | null }) => void
}> = ({ existingKb, onClose, onCreated }) => {
  const [name, setName] = useState(existingKb?.name ?? '')
  const [key, setKey] = useState(existingKb?.app_key ?? '')
  const [keyEdited, setKeyEdited] = useState(!!existingKb)
  const [rows, setRows] = useState<EnvRow[]>([{ env: 'SIT', address: '' }])
  const [defaultEnv, setDefaultEnv] = useState('SIT')
  const [outline, setOutline] = useState('')
  const [prefix, setPrefix] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { if (!keyEdited) setKey(keyFromName(name)) }, [name, keyEdited])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const addresses = addressesOf(rows)
  const ready = name.trim() && /^[a-z0-9][a-z0-9_-]{1,99}$/.test(key) && Object.keys(addresses).length > 0 && !!addresses[defaultEnv]
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await knowledgeBaseService.registerApplication({
        name: name.trim(), app_key: key, addresses, default_environment: defaultEnv,
        outline: outline.trim() || undefined, id_prefix: prefix.trim() || undefined
      })
      onCreated({ app_key: r.app_key, crawl_app_id: r.crawl_app_id })
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/25 px-4 py-10" role="dialog" aria-modal="true"
      aria-label={existingKb ? 'Register application' : 'New application'} onClick={() => !busy && onClose()}>
      <div className="flex w-full max-w-[720px] flex-col gap-5 rounded-[20px] bg-white p-6 shadow-xl" onClick={e => e.stopPropagation()}>
        <div>
          <h2 className="m-0 text-[18px] font-bold text-[#1F2937]">{existingKb ? `Register ${existingKb.name}` : 'New application'}</h2>
          <p className="m-0 mt-1 text-[12.5px] text-[#6B7280]">
            {existingKb
              ? 'This Journey KB has no application yet. Give its address for each environment so it can be crawled and tested.'
              : 'Registers the application for Test Data and crawling, and creates its Journey KB. You can rename it and change environments later.'}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_240px]">
          <label className={LABEL}>
            Name
            <input autoFocus={!existingKb} disabled={!!existingKb} className={`${INPUT} normal-case tracking-normal`} value={name}
              placeholder="e& Money Wallet" onChange={e => setName(e.target.value)} />
          </label>
          <label className={LABEL}>
            Key
            <input disabled={!!existingKb} className={`${INPUT} font-mono normal-case tracking-normal`} value={key}
              onChange={e => { setKeyEdited(true); setKey(e.target.value.toLowerCase()) }} />
            <span className="text-[11px] font-normal normal-case tracking-normal text-[#6B7280]">Folder name for both Knowledge Bases. It never changes, even when the name does.</span>
          </label>
        </div>

        <div className="flex flex-col gap-2">
          <span className={LABEL}>Environments</span>
          <EnvironmentRows rows={rows} defaultEnv={defaultEnv} onRows={setRows} onDefault={setDefaultEnv} />
          <span className="text-[11.5px] text-[#6B7280]">The default environment is where scripts run and crawls go unless another is chosen. Test accounts and values per environment are added in Test Data.</span>
        </div>

        {!existingKb && (
          <div className="flex flex-col gap-2">
            <label className={LABEL}>
              Master topic list <span className="font-normal normal-case tracking-normal text-[#9CA3AF]">· optional, can be added later</span>
              <textarea className={TEXTAREA} value={outline}
                placeholder={OUTLINE_EXAMPLE} onChange={e => setOutline(e.target.value)} />
            </label>
            <span className="text-[11.5px] text-[#6B7280]">
              Every journey the application has, one per line: chapters at the left, then two spaces (or a tab) per level. Copy it from the
              table of contents of your master design document. Journeys extracted from PDFs are placed on this list; anything missing can be added
              from the document review.
            </span>
            <details className="text-[12.5px] text-[#374151]">
              <summary className="cursor-pointer font-semibold">Advanced</summary>
              <label className={`${LABEL} mt-2 w-[220px]`}>
                Journey id prefix
                <input className={`${INPUT} font-mono normal-case tracking-normal`} value={prefix} placeholder="derived from the key"
                  onChange={e => setPrefix(e.target.value.toUpperCase())} />
              </label>
            </details>
          </div>
        )}

        {error && <Note tone="warn">{error}</Note>}
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN_PLAIN} disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className={BTN_PRIMARY} disabled={!ready || busy} onClick={() => void submit()}
            title={!ready ? 'Needs a name, a key and the default environment’s address' : undefined}>
            {busy ? 'Registering…' : existingKb ? 'Register application' : 'Create application'}
          </button>
        </div>
      </div>
    </div>
  )
}

// --- Rename ----------------------------------------------------------------------------

export const RenameApplication: React.FC<{
  appKey: string
  name: string
  canEdit: boolean
  onRenamed: (name: string) => void
}> = ({ appKey, name, canEdit, onRenamed }) => {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setValue(name); setEditing(false); setError(null) }, [name, appKey])

  if (!editing) {
    return (
      <button type="button" disabled={!canEdit} onClick={() => setEditing(true)}
        title={canEdit ? 'Rename this application everywhere it is shown; its key stays' : 'Needs the automation.execute permission'}
        className="h-[30px] rounded-[10px] px-2 text-[12.5px] font-semibold text-[#1D4ED8] hover:bg-[#EEF4FF] disabled:cursor-not-allowed disabled:text-[#9CA3AF] disabled:hover:bg-transparent">
        Rename
      </button>
    )
  }
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await knowledgeBaseService.renameApplication(appKey, value.trim())
      setEditing(false)
      onRenamed(r.name)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <input autoFocus aria-label="Application name" className={`${INPUT} w-[320px]`} value={value} onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && value.trim()) void save(); if (e.key === 'Escape') setEditing(false) }} />
      <button type="button" className={BTN_PRIMARY} disabled={busy || !value.trim() || value.trim() === name} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
      <button type="button" className={BTN_PLAIN} disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
      {error && <span className="text-[12px] text-[#A3231C]">{error}</span>}
    </span>
  )
}

// --- A Journey KB for an application registered without one -----------------------------

export const CreateJourneyKbCard: React.FC<{ appKey: string; name: string; canExecute: boolean; onCreated: () => void }> = ({ appKey, name, canExecute, onCreated }) => {
  const [outline, setOutline] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      await knowledgeBaseService.createJourneyKb(appKey, { name, outline: outline.trim() || undefined })
      onCreated()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }
  return (
    <Card label="Create Journey KB" className="flex flex-col gap-3 p-6">
      <div>
        <h2 className="m-0 text-[16px] font-bold text-[#1F2937]">{name} has no Journey KB yet</h2>
        <p className="m-0 mt-1 text-[12.5px] text-[#6B7280]">
          The Journey KB holds the design: journeys, screens and their exact labels, taken from documents. Create it to upload PDFs and BRDs.
          Crawling and the Automation KB work without one.
        </p>
      </div>
      <label className={LABEL}>
        Master topic list <span className="font-normal normal-case tracking-normal text-[#9CA3AF]">· optional</span>
        <textarea className={TEXTAREA} value={outline}
          placeholder={OUTLINE_EXAMPLE} onChange={e => setOutline(e.target.value)} />
      </label>
      {error && <Note tone="warn">{error}</Note>}
      <button type="button" className={`${BTN_PRIMARY} w-fit`} disabled={busy || !canExecute} onClick={() => void create()}
        title={!canExecute ? 'Needs the automation.execute permission' : undefined}>
        {busy ? 'Creating…' : `Create the Journey KB (${appKey})`}
      </button>
    </Card>
  )
}

// --- Start here ------------------------------------------------------------------------

type StepState = 'done' | 'now' | 'later'
const STEP_DOT: Record<StepState, string> = {
  done: 'bg-[#136B34] text-white',
  now: 'bg-[#B71920] text-white',
  later: 'bg-[#F4F5F7] text-[#6B7280]'
}

const SetupStep: React.FC<{
  n: number
  state: StepState
  title: string
  status: React.ReactNode
  how: React.ReactNode
  actions: React.ReactNode
}> = ({ n, state, title, status, how, actions }) => (
  <li className={`flex flex-col gap-3 border-t border-[#F1F2F4] px-5 py-4 sm:flex-row sm:items-start ${state === 'now' ? 'bg-[#FFFBFB]' : ''}`}>
    <span className={`flex h-[28px] w-[28px] flex-shrink-0 items-center justify-center rounded-full text-[12.5px] font-bold ${STEP_DOT[state]}`}>
      {state === 'done' ? '✓' : n}
    </span>
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-bold text-[#1F2937]">{title}</span>
        {state === 'now' && <Chip tone="brand">Next</Chip>}
        {state === 'done' && <Chip tone="good">Done</Chip>}
      </div>
      <span className="text-[12.5px] text-[#374151]">{status}</span>
      <span className="text-[12px] text-[#6B7280]">{how}</span>
    </div>
    <div className="flex flex-shrink-0 flex-wrap gap-2">{actions}</div>
  </li>
)

const EnvironmentsCard: React.FC<{
  appKey: string
  registration: AppRegistration
  canExecute: boolean
  onChanged: () => void
}> = ({ appKey, registration, canExecute, onChanged }) => {
  const [dataApp, setDataApp] = useState<DataApp | null>(null)
  const [editing, setEditing] = useState(false)
  const [rows, setRows] = useState<EnvRow[]>([])
  const [defaultEnv, setDefaultEnv] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'plain' | 'warn'; text: string } | null>(null)

  useEffect(() => {
    if (!registration.data_app_id) { setDataApp(null); return }
    let live = true
    testDataService.apps().then(r => live && setDataApp(r.apps.find(a => a.id === registration.data_app_id) ?? null)).catch(() => undefined)
    return () => { live = false }
  }, [registration])

  const start = () => {
    setRows(Object.entries(registration.addresses).map(([env, address]) => ({ env, address })))
    setDefaultEnv(registration.default ?? '')
    setMessage(null)
    setEditing(true)
  }
  const save = async () => {
    if (!dataApp) return
    setBusy(true)
    setMessage(null)
    try {
      const wanted = addressesOf(rows)
      // An environment taken out is sent as "" so the server removes it.
      for (const env of Object.keys(registration.addresses)) if (!(env in wanted)) wanted[env] = ''
      const r = await testDataService.updateApp(dataApp.id, {
        name: dataApp.name, kb_app_id: dataApp.kb_app_id ?? appKey, addresses: wanted, run_environment: defaultEnv || null
      })
      setEditing(false)
      setMessage(r.warnings?.length ? { tone: 'warn', text: r.warnings.join(' ') } : null)
      onChanged()
    } catch (err) {
      setMessage({ tone: 'warn', text: errorText(err) })
    } finally {
      setBusy(false)
    }
  }
  const envs = Object.entries(registration.addresses)
  return (
    <Card label="Environments">
      <CardHead
        title="Environments"
        hint="The application's address in each environment. Routes in the Knowledge Base are the same everywhere; only the host changes."
        right={!editing && registration.data_app_id ? (
          <div className="flex gap-2">
            <button type="button" className={BTN_PLAIN} disabled={!canExecute || !dataApp} onClick={start}>Edit environments</button>
            <Link to={`/test-data?app=${registration.data_app_id}`} className={`${BTN_PLAIN} inline-flex items-center`}>Test accounts & values</Link>
          </div>
        ) : undefined}
      />
      <div className="flex flex-col gap-3 px-5 pb-5">
        {editing ? (
          <>
            <EnvironmentRows rows={rows} defaultEnv={defaultEnv} onRows={setRows} onDefault={setDefaultEnv} />
            <div className="flex gap-2">
              <button type="button" className={BTN_PRIMARY} disabled={busy || !addressesOf(rows)[defaultEnv]} onClick={() => void save()}
                title={!addressesOf(rows)[defaultEnv] ? 'The default environment needs an address' : undefined}>{busy ? 'Saving…' : 'Save environments'}</button>
              <button type="button" className={BTN_PLAIN} disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </>
        ) : envs.length ? (
          <div className="flex flex-col">
            {envs.map(([env, address]) => (
              <div key={env} className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-3 border-b border-[#F1F2F4] py-2 text-[13px] last:border-b-0">
                <span className="flex items-center gap-1.5 font-semibold text-[#1F2937]">{env}{env === registration.default && <Chip tone="idle">default</Chip>}</span>
                <span className="truncate font-mono text-[12.5px] text-[#374151]" title={address}>{address}</span>
              </div>
            ))}
          </div>
        ) : (
          <span className="text-[12.5px] text-[#6B7280]">No environments yet.</span>
        )}
        {message && <Note tone={message.tone}>{message.text}</Note>}
      </div>
    </Card>
  )
}

export const SetupStage: React.FC<{
  appKey: string | null
  /** The Knowledge Base key of the selection, with or without a Journey KB. */
  kbKey: string
  name: string
  overview: KbOverview | null
  /** Flows crawled so far, for an application with no Journey KB (and so no overview). */
  crawledFlows?: number
  canExecute: boolean
  onOpenStage: (stage: string) => void
  onRegister: () => void
  onChanged: () => void
}> = ({ appKey, kbKey, name, overview, crawledFlows = 0, canExecute, onOpenStage, onRegister, onChanged }) => {
  const [registration, regError, reloadRegistration] = useLoad(kbKey, () => knowledgeBaseService.registration(kbKey))
  const [taxonomy] = useLoad(appKey, () => knowledgeBaseService.taxonomy(appKey!))
  if (regError) return <Card><Failed message={regError} onRetry={reloadRegistration} /></Card>
  if (!registration) return <Card><Loading what="the application" /></Card>

  const registered = !!registration.crawl_app_id && Object.keys(registration.addresses).length > 0
  const j = overview?.journeys
  const authored = j?.authored ?? 0
  const docs = overview?.sources.documents ?? 0
  const flows = overview?.automation.flows ?? crawledFlows
  const linked = overview?.screens.linked ?? 0
  const verified = taxonomy?.verified?.length ?? 0
  const done = [
    registered && !!appKey,
    authored > 0,
    flows > 0 && (linked > 0 || !appKey),
    authored > 0 && verified >= authored
  ]
  const next = done.findIndex(d => !d)
  const state = (i: number): StepState => (done[i] ? 'done' : i === next ? 'now' : 'later')
  const changed = () => { reloadRegistration(); onChanged() }

  return (
    <div className="flex flex-col gap-4">
      <Card label="Start here">
        <CardHead
          title={next === -1 ? `${name} is set up` : `Setting up ${name}`}
          hint="Four steps take an application from nothing to journeys whose every step has a verified selector. Each step opens the stage that does it."
        />
        <ol className="m-0 list-none p-0">
          <SetupStep n={1} state={state(0)} title="Register the application"
            status={<>
              {registered ? `Registered · ${Object.keys(registration.addresses).length} environment${Object.keys(registration.addresses).length === 1 ? '' : 's'} (default ${registration.default})` : 'Not registered for crawling yet'}
              {' · '}{appKey ? 'Journey KB ready' : 'no Journey KB yet'}
            </>}
            how="Its name, a key shared by both Knowledge Bases, and its address in each environment (SIT, RC…)."
            actions={!registered
              ? <button type="button" className={BTN_PRIMARY} disabled={!canExecute} onClick={onRegister}>Register it</button>
              : null}
          />
          <SetupStep n={2} state={state(1)} title="Upload documents and approve journeys"
            status={appKey ? `${docs} document${docs === 1 ? '' : 's'} · ${authored} journey${authored === 1 ? '' : 's'} authored of ${j?.total ?? 0} in the master list` : 'Needs the Journey KB'}
            how={<>Upload screen-flow PDFs or BRDs (PDF or Word) in Sources. The model proposes journeys, screens and rules; keep what is right, then approve the change set.
              Figma designs: export the frames to PDF. {j && j.total === 0 && <strong className="text-[#8A5000]">Add the master topic list first (Journey KB), so extracted journeys have a place.</strong>}</>}
            actions={<>
              {j && j.total === 0 && <button type="button" className={BTN_PLAIN} disabled={!appKey} onClick={() => onOpenStage('journeys')}>Journey KB</button>}
              <button type="button" className={state(1) === 'now' ? BTN_PRIMARY : BTN_PLAIN} disabled={!appKey} onClick={() => onOpenStage('sources')}>Upload documents</button>
            </>}
          />
          <SetupStep n={3} state={state(2)} title="Crawl the application"
            status={`${flows} flow${flows === 1 ? '' : 's'} · ${overview?.automation.selectors ?? 0} selectors · ${linked} of ${overview?.screens.elements ?? 0} design elements linked to the app`}
            how="Walk each journey in a real browser: every step finds its element on the live page and proposes the selector for the Automation KB. Test accounts come from Test Data."
            actions={<>
              <button type="button" className={BTN_PLAIN} onClick={() => onOpenStage('testdata')}>Test data</button>
              <button type="button" className={state(2) === 'now' ? BTN_PRIMARY : BTN_PLAIN} disabled={!registered} onClick={() => onOpenStage('crawl')}>Walk journeys</button>
            </>}
          />
          <SetupStep n={4} state={state(3)} title="Confirm on the Journey Map"
            status={authored ? `${verified} of ${authored} journey${authored === 1 ? '' : 's'} confirmed step by step by a walk` : 'No journeys to confirm yet'}
            how="Each journey step beside the selector that does it and the flow step generated from it. A journey is mapped when a walk has confirmed every step; differences are settled in Reconcile."
            actions={<button type="button" className={state(3) === 'now' ? BTN_PRIMARY : BTN_PLAIN} disabled={!appKey} onClick={() => onOpenStage('map')}>Open Journey Map</button>}
          />
        </ol>
      </Card>

      {!appKey && registered && <CreateJourneyKbCard appKey={kbKey} name={name} canExecute={canExecute} onCreated={changed} />}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card label="Application">
          <CardHead title="Application" hint="Rename it with Rename beside the title; the key and every id under it stay." />
          <dl className="m-0 grid grid-cols-[150px_minmax(0,1fr)] gap-x-3 gap-y-2 px-5 pb-5 text-[13px]">
            <dt className="text-[#6B7280]">Name</dt><dd className="m-0 font-semibold text-[#1F2937]">{name}</dd>
            <dt className="text-[#6B7280]">Key</dt><dd className="m-0 font-mono text-[12.5px]">{kbKey}</dd>
            <dt className="text-[#6B7280]">Journey KB</dt>
            <dd className="m-0 font-mono text-[12.5px]">{appKey ? `knowledge_base/journeys/${appKey}` : '—'}</dd>
            <dt className="text-[#6B7280]">Automation KB</dt>
            <dd className="m-0 font-mono text-[12.5px]">knowledge_base/applications/{overview?.automation_app_id ?? kbKey}{flows ? '' : <span className="font-sans text-[#6B7280]"> · filled by the first crawl</span>}</dd>
          </dl>
        </Card>
        <EnvironmentsCard appKey={kbKey} registration={registration} canExecute={canExecute} onChanged={changed} />
      </div>
    </div>
  )
}
