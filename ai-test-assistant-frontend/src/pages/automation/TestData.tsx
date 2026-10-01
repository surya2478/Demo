/**
 * --- AI Test Automation > Test Data (Beta) --------------------------------------
 *
 * The one data source for automation test cases: applications and the values
 * their scripts read -- logins, passwords, OTPs, record names -- per
 * environment. A run finds its application by URL or Knowledge Base id and each
 * TESTDATA_* variable by meaning, so a value is entered once and every script
 * for the application uses it. Each application names the environment its
 * scripts run against, so the Automation Lab never asks.
 *
 * The Knowledge Base holds no values: its data profiles (which user, which
 * fields) are checked against this page, which shows what they still need.
 *
 * Secrets are encrypted by the server on save and never sent back: a stored
 * one shows as set, and typing replaces it.
 *
 * It is also the one place applications are registered. Each has an address
 * per environment, chosen first: picking an environment shows where it runs
 * and the values it reads. Discovery and the Knowledge Base page pick from
 * these applications instead of registering their own.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { useConfirm } from '../../components/ui/ConfirmDialog'
import testDataService, {
  ALL_ENVIRONMENTS, environmentLabel, isSecretVariable, keyForVariable, readableName,
  type DataApp, type EntryInput, type EnvironmentSummary, type KbApp, type KbUsage
} from '../../services/testDataService'

const CARD = 'rounded-[20px] border border-[#E8EAEE] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]'
const FIELD = 'h-9 w-full rounded-[10px] border border-[#E8EAEE] bg-white px-3 text-[13px] text-[#1F2937] outline-none transition focus:border-[#F1A4A6] focus:ring-2 focus:ring-[#FDEBEC] disabled:bg-[#F9FAFB]'
const BTN = 'flex h-9 items-center gap-1.5 whitespace-nowrap rounded-[12px] border border-[#E8EAEE] bg-white px-3.5 text-[13px] font-bold text-[#1F2937] transition hover:border-[#F6D4D5] disabled:cursor-not-allowed disabled:opacity-50'
const PRIMARY = 'flex h-9 items-center gap-1.5 whitespace-nowrap rounded-[12px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-4 text-[13px] font-bold text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50'

type Row = {
  uid: string
  id?: number
  environment: string
  key: string
  /** What was typed; undefined keeps a stored secret. */
  value?: string
  shown: string
  has_value: boolean
  is_secret: boolean
  /** Stored as a secret when loaded: its value is on the server only. */
  stored_secret: boolean
  aliases: string
}

let counter = 0
const uid = () => `r${++counter}`

const rowsOf = (app: DataApp): Row[] =>
  app.entries.map(e => ({
    uid: uid(),
    id: e.id,
    environment: e.environment,
    key: e.key,
    value: undefined,
    shown: e.is_secret ? '' : e.value ?? '',
    has_value: e.has_value,
    is_secret: e.is_secret,
    stored_secret: e.is_secret,
    aliases: e.aliases
  }))

const envLabel = environmentLabel

// Editing is automation.execute; the server enforces it, this only shapes the page.
const canEdit = (user: any): boolean => {
  if (!user) return false
  const roles: string[] = (user.roles as string[]) || (user.role ? [user.role] : [])
  if (roles.some(r => String(r).toLowerCase() === 'admin')) return true
  return ((user.permissions as string[]) || []).includes('automation.execute')
}

const STATUS_CHIP: Record<string, string> = {
  ready: 'bg-[#EAF7EF] text-[#136B34]',
  missing: 'bg-[#FFF4E5] text-[#8A5000]',
  external: 'bg-[#F4F5F7] text-[#374151]'
}

// --- Add application --------------------------------------------------------------

// The environments an application can be added for, in the order a release
// moves through them; the page's list (from the server) adds any others.
const DIALOG_ENVIRONMENTS = ['SIT', 'UAT', 'RC', 'PREPRODUCTION']

const AddAppDialog: React.FC<{
  kbApps: KbApp[]
  taken: Set<string>
  environments: string[]
  /** A Knowledge Base application to start from (the Knowledge Base page links here with it). */
  initialKb?: string | null
  onClose: () => void
  onAdd: (body: { name: string; kb_app_id: string | null; url_prefix: string | null; run_environment: string }, suggested: KbApp['suggested']) => Promise<void>
}> = ({ kbApps, taken, environments, initialKb, onClose, onAdd }) => {
  const available = kbApps.filter(a => !taken.has(a.kb_app_id))
  const [kbId, setKbId] = useState((initialKb && available.some(a => a.kb_app_id === initialKb) ? initialKb : available[0]?.kb_app_id) ?? '')
  const kb = kbApps.find(a => a.kb_app_id === kbId) ?? null
  const [name, setName] = useState(kb?.name ?? '')
  const [prefix, setPrefix] = useState(kb?.url_prefix ?? '')
  const envChoices = Array.from(new Set([...DIALOG_ENVIRONMENTS, ...environments.map(e => e.toUpperCase())]))
    .filter(e => e && e !== ALL_ENVIRONMENTS)
  const [runEnvironment, setRunEnvironment] = useState('SIT')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const pickKb = (id: string) => {
    setKbId(id)
    const next = kbApps.find(a => a.kb_app_id === id)
    setName(next?.name ?? '')
    setPrefix(next?.url_prefix ?? '')
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim()) {
      setError('Give the application a name.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await onAdd({ name: name.trim(), kb_app_id: kbId || null, url_prefix: prefix.trim() || null, run_environment: runEnvironment }, kb?.suggested ?? [])
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'The application could not be added.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(17,24,39,0.45)] p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <form role="dialog" aria-modal="true" aria-label="Add application" onSubmit={submit} className="w-full max-w-[520px] overflow-hidden rounded-[20px] border border-[#E8EAEE] bg-white shadow-[0_24px_60px_rgba(16,24,40,0.22)]">
        <div className="border-b border-[#F1F2F4] px-6 pb-4 pt-5">
          <h2 className="m-0 text-[16px] font-bold text-[#1F2937]">Add application</h2>
          <p className="mt-0.5 text-[12.5px] text-[#6B7280]">Pick it from the Knowledge Base to fill in its address and the values it usually needs, or add one of your own.</p>
        </div>
        <div className="flex flex-col gap-4 px-6 py-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]">Environment</span>
            <select value={runEnvironment} onChange={e => setRunEnvironment(e.target.value)} className={FIELD} aria-label="Environment">
              {envChoices.map(e => <option key={e} value={e}>{envLabel(e)}</option>)}
            </select>
            <span className="text-[11.5px] text-[#9CA3AF]">Where the address below runs. Add the other environments' addresses after it is created.</span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]">Knowledge Base application</span>
            <select value={kbId} onChange={e => pickKb(e.target.value)} className={FIELD}>
              {available.map(a => <option key={a.kb_app_id} value={a.kb_app_id}>{a.name}</option>)}
              <option value="">None — my own application</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]">Name</span>
            <input value={name} onChange={e => setName(e.target.value)} className={FIELD} maxLength={200} placeholder="e.g. B2B Portal" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]">Address in {envLabel(runEnvironment)}</span>
            <input value={prefix} onChange={e => setPrefix(e.target.value)} className={`${FIELD} font-mono`} placeholder="https://devnew-sas.etisalat.ae/b2bportal" />
            <span className="text-[11.5px] text-[#9CA3AF]">Runs for {envLabel(runEnvironment)} open this host; scripts that open an address starting with it use these values.</span>
          </label>
          {error && <div role="alert" className="rounded-[12px] border border-[#F6D4D5] bg-[#FFF8F8] px-3.5 py-2 text-[12.5px] text-[#7A0B0D]">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-[#F1F2F4] bg-[#FCFCFD] px-6 py-3.5">
          <button type="button" onClick={onClose} className={BTN}>Cancel</button>
          <button type="submit" disabled={busy} className={PRIMARY}>{busy ? 'Adding…' : 'Add application'}</button>
        </div>
      </form>
    </div>
  )
}

// --- Page ----------------------------------------------------------------------------

const TestData: React.FC = () => {
  const { user } = useAuth()
  const canExecute = canEdit(user)
  const confirm = useConfirm()
  const [params, setParams] = useSearchParams()
  const [apps, setApps] = useState<DataApp[]>([])
  const [environments, setEnvironments] = useState<string[]>(['SIT', 'QA', 'UAT', 'RC', 'PREPRODUCTION'])
  const [kbApps, setKbApps] = useState<KbApp[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)

  const selectedId = Number(params.get('app')) || apps[0]?.id || null
  const addKb = params.get('add')
  useEffect(() => {
    if (addKb && !loading && canExecute) setAdding(true)
  }, [addKb, loading, canExecute])
  const app = apps.find(a => a.id === selectedId) ?? null

  // The editor's working copy of the selected application.
  const [name, setName] = useState('')
  const [kbId, setKbId] = useState('')
  // {environment: address}, the working copy; '' means none.
  const [addresses, setAddresses] = useState<Record<string, string>>({})
  const [runEnv, setRunEnv] = useState('SIT')
  const [warnings, setWarnings] = useState<string[]>([])
  const [kbUsage, setKbUsage] = useState<KbUsage | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [deleted, setDeleted] = useState<number[]>([])
  const [env, setEnv] = useState('SIT')
  const [newEnv, setNewEnv] = useState('')
  const [dirty, setDirty] = useState(false)

  const load = useCallback(async () => {
    try {
      const [data, kb] = await Promise.all([testDataService.apps(), testDataService.kbApps()])
      setApps(data.apps)
      setEnvironments(data.environments.length ? data.environments : ['SIT', 'QA', 'UAT', 'RC', 'PREPRODUCTION'])
      setKbApps(kb)
      setError('')
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'Test data could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const reset = useCallback((next: DataApp | null) => {
    setName(next?.name ?? '')
    setKbId(next?.kb_app_id ?? '')
    setAddresses({ ...(next?.addresses ?? {}) })
    setRunEnv(next?.run_environment || 'SIT')
    setWarnings([])
    // Open on the default environment: where its runs go unless a case says otherwise.
    setEnv(next?.run_environment || 'SIT')
    setRows(next ? rowsOf(next) : [])
    setDeleted([])
    setDirty(false)
  }, [])

  useEffect(() => { reset(app) }, [app, reset])

  // What the Knowledge Base's data profiles need from this application.
  useEffect(() => {
    if (!app?.kb_app_id) { setKbUsage(null); return }
    let cancelled = false
    testDataService.knowledgeBase(app.id)
      .then(usage => { if (!cancelled) setKbUsage(usage) })
      .catch(() => { if (!cancelled) setKbUsage(null) })
    return () => { cancelled = true }
  }, [app])

  // Rows for the variables a KB profile still misses in the run environment.
  const addMissing = (variables: string[]) => {
    const have = new Set(rows.filter(r => r.environment === runEnv).map(r => r.key.trim().toLowerCase()))
    const next = Array.from(new Set(variables)).map(v => ({ v, key: keyForVariable(v) })).filter(({ key }) => !have.has(key))
    if (!next.length) return
    setRows(current => [
      ...current,
      ...next.map(({ v, key }) => ({ uid: uid(), environment: runEnv, key, value: '', shown: '', has_value: false, is_secret: isSecretVariable(v), stored_secret: false, aliases: '' }))
    ])
    setEnv(runEnv)
    setDirty(true)
    setNotice(`Added ${next.length} value${next.length === 1 ? '' : 's'} for ${envLabel(runEnv)}. Fill ${next.length === 1 ? 'it' : 'them'} in and save.`)
  }

  const tabs = useMemo(() => {
    const present = new Set(rows.map(r => r.environment))
    return [ALL_ENVIRONMENTS, ...Array.from(new Set([...environments, ...Array.from(present).filter(e => e !== ALL_ENVIRONMENTS)]))]
  }, [environments, rows])

  const shown = rows.filter(r => r.environment === env)

  // Per environment, as edited: its address, and how many of its values are set.
  const envStatus = (e: string) => {
    const mine = rows.filter(r => r.environment === e)
    return { address: (addresses[e] ?? '').trim(), values: mine.length, set: mine.filter(r => r.has_value || r.shown || r.value).length }
  }
  const sameAddressAs = env !== ALL_ENVIRONMENTS && envStatus(env).address
    ? Object.keys(addresses).filter(e => e !== env && (addresses[e] ?? '').trim().toLowerCase() === envStatus(env).address.toLowerCase())
    : []
  // An environment with no values yet can start from the names another one uses.
  const copySource = env !== ALL_ENVIRONMENTS && shown.length === 0
    ? [runEnv, ...environments].find(e => e !== env && e !== ALL_ENVIRONMENTS && rows.some(r => r.environment === e)) ?? null
    : null
  const copyNames = (from: string) => {
    const names = rows.filter(r => r.environment === from)
    setRows(current => [
      ...current,
      ...names.map(r => ({ uid: uid(), environment: env, key: r.key, value: '', shown: '', has_value: false, is_secret: r.is_secret, stored_secret: false, aliases: r.aliases }))
    ])
    setDirty(true)
    setNotice(`Copied ${names.length} name${names.length === 1 ? '' : 's'} from ${envLabel(from)}. Fill in ${envLabel(env)}'s values and save.`)
  }
  const edit = (id: string, patch: Partial<Row>) => {
    setRows(current => current.map(r => (r.uid === id ? { ...r, ...patch } : r)))
    setDirty(true)
  }
  const add = (key = '', isSecret = false, environment = env) => {
    setRows(current => [...current, { uid: uid(), environment, key, value: '', shown: '', has_value: false, is_secret: isSecret, stored_secret: false, aliases: '' }])
    setDirty(true)
  }
  const remove = (row: Row) => {
    setRows(current => current.filter(r => r.uid !== row.uid))
    if (row.id) setDeleted(current => [...current, row.id!])
    setDirty(true)
  }

  const choose = async (id: number) => {
    if (dirty && !(await confirm({ title: 'Discard unsaved changes?', body: `Changes to ${name} have not been saved.`, confirmLabel: 'Discard' }))) return
    setParams({ app: String(id) }, { replace: true })
    setNotice('')
  }

  const save = async () => {
    if (!app) return
    const keys = new Set<string>()
    for (const row of rows) {
      if (!row.key.trim()) {
        setError(`A value in ${envLabel(row.environment)} has no name.`)
        return
      }
      const id = `${row.environment}|${row.key.trim().toLowerCase()}`
      if (keys.has(id)) {
        setError(`${row.key} is listed twice in ${envLabel(row.environment)}.`)
        return
      }
      keys.add(id)
    }
    setBusy(true)
    setError('')
    try {
      const changedAddresses: Record<string, string> = {}
      for (const e of Array.from(new Set([...Object.keys(app.addresses ?? {}), ...Object.keys(addresses)]))) {
        const now = (addresses[e] ?? '').trim()
        if (now !== (app.addresses?.[e] ?? '')) changedAddresses[e] = now
      }
      let saveWarnings: string[] = []
      if (name !== app.name || (kbId || null) !== app.kb_app_id || runEnv !== app.run_environment || Object.keys(changedAddresses).length) {
        const updated = await testDataService.updateApp(app.id, { name: name.trim(), kb_app_id: kbId || null, run_environment: runEnv, addresses: changedAddresses })
        saveWarnings = updated.warnings ?? []
      }
      const entries: EntryInput[] = rows.map(row => ({
        id: row.id,
        environment: row.environment,
        key: row.key.trim(),
        is_secret: row.is_secret,
        aliases: row.aliases,
        // A secret left blank keeps what is stored; anything typed replaces it.
        // Un-marking a stored secret without retyping it keeps it too: the
        // server decrypts it in place.
        ...(row.is_secret
          ? (row.value ? { value: row.value } : row.id ? {} : { value: '' })
          : row.stored_secret && row.has_value && !row.shown ? {} : { value: row.shown })
      }))
      await testDataService.saveEntries(app.id, entries, deleted)
      await load()
      if (app.kb_app_id) testDataService.knowledgeBase(app.id).then(setKbUsage).catch(() => undefined)
      setWarnings(saveWarnings)
      setNotice('Saved. Secret values are encrypted.')
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'The test data could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  const addApp = async (body: { name: string; kb_app_id: string | null; url_prefix: string | null; run_environment: string }, suggested: KbApp['suggested']) => {
    const created = await testDataService.createApp({
      name: body.name, kb_app_id: body.kb_app_id, run_environment: body.run_environment,
      addresses: body.url_prefix ? { [body.run_environment]: body.url_prefix } : {}
    })
    if (suggested.length) {
      // A value for one environment is created in the one chosen; one for all
      // environments stays shared.
      await testDataService.saveEntries(
        created.id,
        suggested.map(s => ({
          environment: s.environment === ALL_ENVIRONMENTS ? ALL_ENVIRONMENTS : body.run_environment,
          key: s.key, is_secret: s.is_secret, aliases: s.aliases, value: ''
        })),
        []
      )
      setEnv(body.run_environment)
    }
    setAdding(false)
    await load()
    setParams({ app: String(created.id) }, { replace: true })
    setWarnings(created.warnings ?? [])
    setNotice(suggested.length ? 'Added with the values it usually needs. Fill them in and save.' : 'Added. Add the values its scripts need.')
  }

  const removeApp = async () => {
    if (!app) return
    const ok = await confirm({
      title: `Delete ${app.name}?`,
      body: 'Its test data is removed for every environment.',
      consequences: ['Scripts for it will be refused until its values are added again.', 'This cannot be undone.'],
      confirmLabel: 'Delete application'
    })
    if (!ok) return
    await testDataService.deleteApp(app.id)
    setParams({}, { replace: true })
    await load()
  }

  const secretsCount = rows.filter(r => r.is_secret).length

  return (
    <div className="flex flex-col gap-3">
    <section className={`${CARD} px-6 py-5`}>
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-[#B71920]">AI Test Automation</p>
      <div className="mt-1 flex flex-wrap items-center gap-2.5">
        <h1 className="m-0 text-[27px] font-extrabold leading-tight tracking-[-0.02em] text-[#1F2937]">Test Data</h1>
        <span className="rounded-full border border-[#F1A4A6] bg-[#FFF5F5] px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[#B71920]">Beta</span>
      </div>
      <p className="mt-2 max-w-[760px] text-[13.5px] leading-[1.6] text-[#4B5563]">
        The one source of test data for automation test cases. Scripts, dry runs and runs read their logins, OTPs and records
        from here, for the environment chosen when each test case was generated; the Knowledge Base says which data its journeys need and checks it against this page.
      </p>
    </section>
    <section className={`${CARD} grid min-h-[620px] grid-cols-1 overflow-hidden lg:grid-cols-[300px_minmax(0,1fr)]`}>
      {/* Applications */}
      <aside className="flex flex-col border-b border-[#E8EAEE] lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-2 px-5 pb-3 pt-4">
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-bold text-[#1F2937]">Applications</div>
            <div className="text-[12.5px] text-[#6B7280]">Logins, OTPs and values scripts read</div>
          </div>
          {canExecute && (
            <button type="button" onClick={() => setAdding(true)} className="flex h-8 items-center gap-1 rounded-[10px] border border-dashed border-[#F1A4A6] bg-[#FFF8F8] px-2.5 text-[12.5px] font-bold text-[#B71920] hover:bg-[#FDEBEC]">
              <span className="text-[15px] leading-none">+</span> Application
            </button>
          )}
        </div>
        <div className="app-scroll flex-1 overflow-y-auto border-t border-[#E8EAEE]">
          {loading ? (
            <div className="px-5 py-6 text-[13px] text-[#6B7280]">Loading…</div>
          ) : apps.length === 0 ? (
            <div className="px-5 py-8 text-center text-[13px] text-[#6B7280]">No applications yet. Add one to give its scripts their logins and OTPs.</div>
          ) : (
            apps.map(a => {
              const set = a.entries.filter(e => e.has_value).length
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => void choose(a.id)}
                  className={`block w-full border-b border-[#F1F2F4] px-5 py-3 text-left ${a.id === selectedId ? 'bg-[#FFF5F5] shadow-[inset_3px_0_0_#B71920]' : 'hover:bg-[#FCFCFD]'}`}
                >
                  <div className="truncate text-[14px] font-bold text-[#1F2937]">{a.name}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(a.environment_summary ?? []).filter((e: EnvironmentSummary) => e.address || e.values).map((e: EnvironmentSummary) => (
                      <span key={e.environment} title={e.address ?? 'No address for this environment'}
                        className={`rounded-full px-1.5 py-px text-[10.5px] font-semibold ${e.address ? 'bg-[#EAF7EF] text-[#136B34]' : 'bg-[#FFF4E5] text-[#8A5000]'}`}>
                        {e.is_default ? '★ ' : ''}{envLabel(e.environment)}
                      </span>
                    ))}
                    {!(a.environment_summary ?? []).some((e: EnvironmentSummary) => e.address) && <span className="text-[11px] text-[#9CA3AF]">no address yet</span>}
                  </div>
                  <div className="mt-0.5 text-[12px] text-[#6B7280]">{set} of {a.entries.length} values set</div>
                </button>
              )
            })
          )}
        </div>
      </aside>

      {/* Editor */}
      <div className="flex min-w-0 flex-col">
        {!app ? (
          <div className="m-auto max-w-[360px] px-6 text-center text-[13px] text-[#6B7280]">
            Scripts read logins and OTPs as <code className="rounded bg-[#F4F5F7] px-1 font-mono text-[12px]">TESTDATA_*</code> values. Add an application and its values once; every script for it uses them, and a run missing one is stopped with its name.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 border-b border-[#E8EAEE] px-5 py-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] md:items-end">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]">Application</span>
                <input value={name} onChange={e => { setName(e.target.value); setDirty(true) }} disabled={!canExecute} className={FIELD} title={name} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]">Knowledge Base</span>
                <select value={kbId} onChange={e => { setKbId(e.target.value); setDirty(true) }} disabled={!canExecute} className={FIELD}>
                  <option value="">None</option>
                  {kbApps.map(k => <option key={k.kb_app_id} value={k.kb_app_id}>{k.name}</option>)}
                </select>
              </label>
              {canExecute && (
                <button type="button" onClick={() => void removeApp()} className="h-9 px-1 text-[12.5px] font-semibold text-[#A3231C] hover:underline">Delete application</button>
              )}
            </div>

            <div className="px-5 pt-3.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]">Environment</div>
            <div className="flex flex-wrap items-center gap-1.5 px-5 pt-1.5">
              {tabs.map(t => {
                const status = envStatus(t)
                const isAll = t === ALL_ENVIRONMENTS
                const dot = isAll ? null : status.address ? 'bg-[#22A559]' : status.values ? 'bg-[#E3A008]' : 'bg-[#D6D9DF]'
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setEnv(t)}
                    aria-pressed={env === t}
                    title={isAll ? 'Values shared by every environment' : status.address ? `${status.address} · ${status.set} of ${status.values} values set` : 'No address for this environment yet'}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold transition ${env === t ? 'bg-[#1F2937] text-white' : 'bg-[#F4F5F7] text-[#1F2937] hover:bg-[#E8EAEE]'}`}
                  >
                    {dot && <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />}
                    {t === runEnv && <span aria-label="default" title="Default environment">★</span>}
                    {envLabel(t)}
                    <span className={env === t ? 'text-white/70' : 'text-[#6B7280]'}>{status.values}</span>
                  </button>
                )
              })}
              {canExecute && (
                <form
                  onSubmit={e => {
                    e.preventDefault()
                    const value = newEnv.trim().toUpperCase()
                    if (!value) return
                    if (!environments.includes(value)) setEnvironments(current => [...current, value])
                    setEnv(value)
                    setNewEnv('')
                  }}
                  className="flex items-center"
                >
                  <input value={newEnv} onChange={e => setNewEnv(e.target.value)} placeholder="+ environment" maxLength={40} className="h-8 w-[120px] rounded-full border border-dashed border-[#D6D9DF] bg-white px-3 text-[12.5px] outline-none focus:border-[#F1A4A6]" />
                </form>
              )}
            </div>

            {env === ALL_ENVIRONMENTS ? (
              <div className="px-5 pb-2 pt-2 text-[12px] text-[#6B7280]">
                Used in every environment unless an environment sets its own — e.g. the OTP 123456.
              </div>
            ) : (
              <div className="mx-5 mt-3 grid grid-cols-1 gap-2 rounded-[14px] border border-[#E8EAEE] bg-[#FCFCFD] p-3.5 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6B7280]">Address in {envLabel(env)}</span>
                  <input
                    value={addresses[env] ?? ''}
                    onChange={e => { setAddresses(current => ({ ...current, [env]: e.target.value })); setDirty(true) }}
                    disabled={!canExecute}
                    className={`${FIELD} font-mono`}
                    title={addresses[env] ?? ''}
                    placeholder={`https://host/path for ${envLabel(env)}`}
                  />
                </label>
                {runEnv === env ? (
                  <span className="flex h-9 items-center gap-1 rounded-[12px] bg-[#FFF5F5] px-3 text-[12.5px] font-bold text-[#B71920]" title="Used for test cases generated before cases carried an environment">★ Default environment</span>
                ) : canExecute ? (
                  <button type="button" onClick={() => { setRunEnv(env); setDirty(true) }} className={BTN} title="Used for test cases generated before cases carried an environment">Make {envLabel(env)} the default</button>
                ) : null}
                <span className="text-[12px] text-[#6B7280] md:col-span-2">
                  {envStatus(env).address
                    ? <>Runs for {envLabel(env)} open this host and read the values below; values in All environments fill any gap.</>
                    : <>No address yet: runs for {envLabel(env)} use the host the script was generated against. Add one so they go to {envLabel(env)}.</>}
                  {sameAddressAs.length > 0 && (
                    <span className="mt-1 block font-semibold text-[#8A5000]">Same address as {sameAddressAs.map(envLabel).join(', ')} — check this is really where {envLabel(env)} runs.</span>
                  )}
                </span>
              </div>
            )}
            {warnings.length > 0 && (
              <div className="mx-5 mt-2 rounded-[12px] border border-[#EBCFA4] bg-[#FFFBF4] px-3.5 py-2 text-[12.5px] text-[#8A5000]">{warnings.join(' ')}</div>
            )}
            <div className="h-3" />

            <div className="app-scroll min-h-0 flex-1 overflow-x-auto px-5">
              <div className="min-w-[680px] overflow-hidden rounded-[14px] border border-[#E8EAEE]">
                <div className="grid h-9 grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_70px_minmax(0,1fr)_32px] items-center gap-3 bg-[#F4F5F7] px-3.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1F2937]">
                  <span>Name</span><span>Value</span><span>Secret</span><span title="Other names scripts may use for it">Also known as</span><span />
                </div>
                {shown.length === 0 ? (
                  <div className="px-3.5 py-5 text-center text-[13px] text-[#9CA3AF]">
                    No values for {envLabel(env)} yet.
                    {canExecute && copySource && (
                      <button type="button" onClick={() => copyNames(copySource)} className="ml-2 font-semibold text-[#B71920] hover:underline">
                        Copy the names from {envLabel(copySource)}
                      </button>
                    )}
                  </div>
                ) : (
                  shown.map(row => (
                    <div key={row.uid} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_70px_minmax(0,1fr)_32px] items-center gap-3 border-t border-[#F1F2F4] px-3.5 py-2">
                      <input value={row.key} onChange={e => edit(row.uid, { key: e.target.value })} disabled={!canExecute} placeholder="admin.username" className={`${FIELD} font-mono`} />
                      {row.is_secret ? (
                        <input
                          type="password"
                          autoComplete="new-password"
                          value={row.value ?? ''}
                          onChange={e => edit(row.uid, { value: e.target.value })}
                          disabled={!canExecute}
                          placeholder={row.has_value ? '•••••••• set — type to replace' : 'Not set'}
                          className={FIELD}
                        />
                      ) : (
                        <input value={row.shown} onChange={e => edit(row.uid, { shown: e.target.value })} disabled={!canExecute} placeholder="Not set" className={FIELD} />
                      )}
                      <label className="flex justify-center">
                        <input
                          type="checkbox"
                          checked={row.is_secret}
                          disabled={!canExecute}
                          onChange={e => edit(row.uid, { is_secret: e.target.checked, value: e.target.checked ? (row.shown || undefined) : row.value, shown: e.target.checked ? '' : row.shown })}
                          aria-label={`${row.key || 'value'} is secret`}
                          className="h-4 w-4 accent-[#B71920]"
                        />
                      </label>
                      <input value={row.aliases} onChange={e => edit(row.uid, { aliases: e.target.value })} disabled={!canExecute} placeholder="e.g. login_email" className={`${FIELD} font-mono`} />
                      {canExecute ? (
                        <button type="button" onClick={() => remove(row)} aria-label={`Remove ${row.key}`} className="flex h-8 w-8 items-center justify-center rounded-[10px] text-[#9CA3AF] hover:bg-[#FEEBEC] hover:text-[#A3231C]">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
                        </button>
                      ) : <span />}
                    </div>
                  ))
                )}
              </div>
              {canExecute && (
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <button type="button" onClick={() => add()} className={BTN}>+ Value</button>
                  <button type="button" onClick={() => { add('username', false); add('password', true) }} className={BTN}>+ Login (username, password)</button>
                  {env === ALL_ENVIRONMENTS && !shown.some(r => r.key.toLowerCase() === 'otp') && (
                    <button type="button" onClick={() => add('otp', false)} className={BTN}>+ OTP</button>
                  )}
                </div>
              )}
              <p className="mb-3 mt-3 text-[12px] leading-[1.5] text-[#6B7280]">
                Scripts are matched by meaning: <code className="font-mono">TESTDATA_ADMIN_PASSWORD</code> uses <code className="font-mono">admin.password</code>, else <code className="font-mono">password</code>;
                email, login and user id all count as the username. Name a role with a prefix (<code className="font-mono">admin.</code>, <code className="font-mono">customer.</code>), and list any other name a script uses under Also known as.
              </p>

              {kbUsage?.journey_app && kbUsage.profiles.length > 0 && (
                <div className="mb-4 overflow-hidden rounded-[14px] border border-[#E8EAEE]">
                  <div className="flex flex-wrap items-center gap-2 border-b border-[#F1F2F4] bg-[#FCFCFD] px-3.5 py-2.5">
                    <span className="text-[13px] font-bold text-[#1F2937]">Used by the Knowledge Base</span>
                    <span className="text-[12px] text-[#6B7280]">{kbUsage.journey_app.name} · data profiles its journeys need, checked for {envLabel(runEnv)}</span>
                  </div>
                  {kbUsage.profiles.map(profile => {
                    const cell = profile.cells[runEnv] ?? { status: profile.kind === 'external' ? 'external' : 'missing', missing: profile.fields.map(f => f.variable).filter(Boolean) as string[] }
                    return (
                      <div key={profile.profile_id} className="flex flex-wrap items-start gap-3 border-t border-[#F1F2F4] px-3.5 py-2.5 first:border-t-0">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[13px] font-semibold text-[#1F2937]">{profile.name}</span>
                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${profile.kind === 'file' ? STATUS_CHIP.external : STATUS_CHIP[cell.status] ?? STATUS_CHIP.missing}`}>
                              {profile.kind === 'file' ? 'Document · not a value' : cell.status === 'ready' ? 'Ready' : cell.status === 'external' ? 'Held outside' : `${cell.missing.length || 'Values'} missing`}
                            </span>
                          </div>
                          <div className="mt-0.5 text-[12px] text-[#6B7280]">
                            {profile.fields.map(f => f.variable ? `${f.name} (${readableName(f.variable)})` : f.name).join(' · ')}
                          </div>
                          {profile.used_by.length > 0 && (
                            <div className="mt-0.5 truncate text-[11.5px] text-[#9CA3AF]" title={profile.used_by.join('\n')}>
                              Used by {profile.used_by.length} scenario{profile.used_by.length === 1 ? '' : 's'}: {profile.used_by.slice(0, 2).join(', ')}{profile.used_by.length > 2 ? '…' : ''}
                            </div>
                          )}
                        </div>
                        {canExecute && cell.status === 'missing' && cell.missing.length > 0 && (
                          <button type="button" onClick={() => addMissing(cell.missing)} className={BTN}>+ Add missing to {envLabel(runEnv)}</button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t border-[#E8EAEE] bg-[#FCFCFD] px-5 py-3">
              {error ? <span role="alert" className="text-[12.5px] text-[#A3231C]">{error}</span> : notice ? <span className="text-[12.5px] text-[#136B34]">{notice}</span> : (
                <span className="text-[12.5px] text-[#6B7280]">{secretsCount} secret value{secretsCount === 1 ? '' : 's'} · encrypted on save, never shown again</span>
              )}
              {canExecute && (
                <div className="ml-auto flex gap-2">
                  <button type="button" onClick={() => reset(app)} disabled={!dirty || busy} className={BTN}>Discard</button>
                  <button type="button" onClick={() => void save()} disabled={!dirty || busy} className={PRIMARY}>{busy ? 'Saving…' : 'Save changes'}</button>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {adding && (
        <AddAppDialog
          kbApps={kbApps}
          taken={new Set(apps.map(a => a.kb_app_id).filter(Boolean) as string[])}
          environments={environments}
          initialKb={addKb}
          onClose={() => { setAdding(false); if (addKb) setParams(selectedId ? { app: String(selectedId) } : {}, { replace: true }) }}
          onAdd={addApp}
        />
      )}
    </section>
    </div>
  )
}

export default TestData
