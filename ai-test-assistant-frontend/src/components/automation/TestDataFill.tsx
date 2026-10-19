/**
 * --- Missing test data, filled in where the script is ------------------------------
 *
 * The check names each TESTDATA_* variable the script reads and has no value
 * for in the environment it runs against. Rather than send the user to Test
 * Data to guess where it goes, each one gets a field here, saved straight into
 * that application's Test Data:
 *
 *   - New value: stored under the variable's own key ("admin.credentials"),
 *     for this environment or all of them, encrypted when it is a secret.
 *   - Use a saved value: the variable becomes an alias of an entry the
 *     application already has (default_org.password, say), so that one value
 *     answers both names -- the same thing Test Data's "aliases" column does.
 *
 * Either way the variable name is recorded as an alias, so the match is exact
 * and survives the matcher's guesses. Nothing is sent but what the user typed
 * or picked; stored secrets are never read back.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import testDataService, {
  ALL_ENVIRONMENTS, environmentLabel, isSecretVariable, keyForVariable, readableName,
  type DataApp, type EntryInput, type ScriptDataCheck, type TestDataEntry
} from '../../services/testDataService'

type Mode = 'new' | 'existing'
interface Draft { mode: Mode; value: string; secret: boolean; allEnvironments: boolean; entryId: number | null }

const sentence = (text: string) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text)
const withAlias = (aliases: string, variable: string) => {
  const list = aliases.split(',').map(a => a.trim()).filter(Boolean)
  return list.some(a => a.toUpperCase() === variable.toUpperCase()) ? list.join(', ') : [...list, variable].join(', ')
}

const TestDataFill: React.FC<{
  check: ScriptDataCheck
  canExecute: boolean
  /** Saved: the caller checks the script again. */
  onSaved: () => void
}> = ({ check, canExecute, onSaved }) => {
  const env = check.environment
  const appId = check.application?.id ?? null
  const [app, setApp] = useState<DataApp | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setApp(null)
    if (appId === null) return
    let cancelled = false
    testDataService.apps().then(res => { if (!cancelled) setApp(res.apps.find(a => a.id === appId) ?? null) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [appId])

  useEffect(() => {
    setDrafts(Object.fromEntries(check.missing.map(name => [name, { mode: 'new', value: '', secret: isSecretVariable(name), allEnvironments: false, entryId: null }])))
    setError(null)
  }, [check])

  // Values this environment can already use: its own, and the all-environments ones.
  const saved = useMemo(
    () => (app?.entries ?? []).filter(e => (e.environment === env || e.environment === ALL_ENVIRONMENTS) && e.has_value),
    [app, env]
  )
  const entryLabel = (e: TestDataEntry) => `${e.key}${e.environment === ALL_ENVIRONMENTS ? ' (all environments)' : ''}${e.is_secret ? ' · secret' : e.value ? ` · ${e.value}` : ''}`

  const patch = (name: string, change: Partial<Draft>) => setDrafts(prev => ({ ...prev, [name]: { ...prev[name], ...change } }))

  const ready = check.missing.every(name => {
    const d = drafts[name]
    return d && (d.mode === 'new' ? d.value.trim() !== '' : d.entryId !== null)
  })

  const save = async () => {
    if (!app) return
    setSaving(true)
    setError(null)
    try {
      const entries: EntryInput[] = []
      check.missing.forEach(name => {
        const d = drafts[name]
        if (d.mode === 'existing') {
          const entry = app.entries.find(e => e.id === d.entryId)
          if (!entry) return
          const already = entries.find(x => x.id === entry.id)
          if (already) already.aliases = withAlias(already.aliases ?? '', name)
          else entries.push({ id: entry.id, environment: entry.environment, key: entry.key, is_secret: entry.is_secret, aliases: withAlias(entry.aliases ?? '', name) })
        } else {
          const environment = d.allEnvironments ? ALL_ENVIRONMENTS : env
          const key = keyForVariable(name)
          const existing = app.entries.find(e => e.environment === environment && e.key.toLowerCase() === key.toLowerCase())
          entries.push({
            id: existing?.id,
            environment,
            key,
            value: d.value,
            is_secret: d.secret,
            aliases: withAlias(existing?.aliases ?? '', name)
          })
        }
      })
      await testDataService.saveEntries(app.id, entries, [])
      onSaved()
    } catch (err: any) {
      setError(err?.response?.data?.detail ?? err?.message ?? 'The values could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const testDataLink = appId ? `/test-data?app=${appId}` : '/test-data'
  const n = check.missing.length

  if (!check.application) {
    return (
      <div className="rounded-[12px] border border-[#EBCFA4] bg-[#FFFBF4] px-3.5 py-3 text-[12.5px] text-[#8A5000]">
        <div className="font-bold">This script’s address isn’t linked to an application in Test Data yet</div>
        <p className="mt-1">
          It needs {check.missing.map(readableName).join(', ')} for {environmentLabel(env)}, but no Test Data application has this address, so there is nowhere to keep them.{' '}
          <Link to="/test-data" className="font-semibold text-[#B71920] hover:underline">Add the application and its address in Test Data</Link>, then come back here to fill the values.
        </p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-[12px] border border-[#EBCFA4] bg-[#FFFBF4]">
      <div className="flex flex-wrap items-start gap-2 px-3.5 pb-2 pt-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-bold text-[#8A5000]">
            {n === 1 ? 'One test data value is missing' : `${n} test data values are missing`} for {environmentLabel(env)}
          </div>
          <div className="text-[11.5px] text-[#8A5000]/80">
            Fill {n === 1 ? 'it' : 'them'} here; {n === 1 ? 'it is' : 'they are'} saved to Test Data under <b className="font-semibold">{check.application.name}</b>, and every script that asks for {n === 1 ? 'it' : 'them'} gets {n === 1 ? 'it' : 'them'}.
          </div>
        </div>
        <Link to={testDataLink} className="text-[11.5px] font-semibold text-[#B71920] hover:underline">Open in Test Data</Link>
      </div>

      <ul className="flex flex-col gap-2 px-3.5 pb-3">
        {check.missing.map(name => {
          const d = drafts[name]
          if (!d) return null
          return (
            <li key={name} className="rounded-[10px] border border-[#F0DDBB] bg-white px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12.5px] font-bold text-[#1F2937]">{sentence(readableName(name))}</span>
                <code className="rounded bg-[#F4F5F7] px-1.5 font-mono text-[10.5px] text-[#6B7280]">{name}</code>
                <span className="ml-auto flex rounded-[8px] bg-[#F4F5F7] p-[2px]" role="radiogroup" aria-label={`Where ${readableName(name)} comes from`}>
                  {([['new', 'New value'], ['existing', 'Use a saved value']] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={d.mode === mode}
                      disabled={mode === 'existing' && saved.length === 0}
                      title={mode === 'existing' && saved.length === 0 ? `Nothing is saved for ${environmentLabel(env)} yet` : undefined}
                      onClick={() => patch(name, { mode })}
                      className={`h-6 rounded-[6px] px-2 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${d.mode === mode ? 'bg-white text-[#1F2937] shadow-[0_1px_2px_rgba(16,24,40,0.12)]' : 'text-[#6B7280]'}`}
                    >
                      {label}
                    </button>
                  ))}
                </span>
              </div>
              {d.mode === 'new' ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    type={d.secret ? 'password' : 'text'}
                    value={d.value}
                    onChange={e => patch(name, { value: e.target.value })}
                    placeholder={`Value for ${environmentLabel(d.allEnvironments ? ALL_ENVIRONMENTS : env)}`}
                    autoComplete="off"
                    aria-label={`${readableName(name)} value`}
                    disabled={!canExecute}
                    className="h-8 min-w-[200px] flex-1 rounded-[8px] border border-[#E8EAEE] px-2.5 text-[12.5px] text-[#1F2937] outline-none focus:border-[#F1A4A6]"
                  />
                  <label className="flex items-center gap-1.5 text-[11.5px] text-[#374151]">
                    <input type="checkbox" checked={d.secret} onChange={e => patch(name, { secret: e.target.checked })} className="h-3.5 w-3.5 accent-[#B71920]" />
                    Secret (stored encrypted)
                  </label>
                  <select
                    value={d.allEnvironments ? 'all' : 'env'}
                    onChange={e => patch(name, { allEnvironments: e.target.value === 'all' })}
                    aria-label={`Environments for ${readableName(name)}`}
                    className="h-8 rounded-[8px] border border-[#E8EAEE] bg-white px-2 text-[11.5px] font-semibold text-[#374151]"
                  >
                    <option value="env">{environmentLabel(env)} only</option>
                    <option value="all">All environments</option>
                  </select>
                  <span className="w-full text-[10.5px] text-[#9CA3AF]">Saved as <span className="font-mono">{keyForVariable(name)}</span></span>
                </div>
              ) : (
                <div className="mt-2">
                  <select
                    value={d.entryId ?? ''}
                    onChange={e => patch(name, { entryId: e.target.value ? Number(e.target.value) : null })}
                    aria-label={`Saved value for ${readableName(name)}`}
                    disabled={!canExecute}
                    className="h-8 w-full rounded-[8px] border border-[#E8EAEE] bg-white px-2 text-[12.5px] text-[#1F2937]"
                  >
                    <option value="">Choose a value already saved for {environmentLabel(env)}…</option>
                    {saved.map(e => <option key={e.id} value={e.id}>{entryLabel(e)}</option>)}
                  </select>
                  <span className="mt-1 block text-[10.5px] text-[#9CA3AF]">{name} is added to that value’s aliases, so both names read the same value.</span>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {error && <div role="alert" className="mx-3.5 mb-2 rounded-[8px] border border-[#F6D4D5] bg-[#FFF8F8] px-3 py-1.5 text-[12px] text-[#7A0B0D]">{error}</div>}
      <div className="flex items-center gap-2 border-t border-[#F0DDBB] px-3.5 py-2.5">
        <span className="text-[11px] text-[#8A5000]/80">{canExecute ? 'The script is checked again as soon as it is saved.' : 'Saving test data needs the automation.execute permission.'}</span>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!canExecute || !ready || saving || !app}
          className="ml-auto inline-flex h-8 items-center rounded-[8px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-3 text-[12.5px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save to Test Data'}
        </button>
      </div>
    </div>
  )
}

export default TestDataFill
