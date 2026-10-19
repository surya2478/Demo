import React, { useEffect, useMemo, useState } from 'react'
import knowledgeBaseService, { type AppRegistration, type JourneyKbApp, type KbTestData } from '../../services/knowledgeBaseService'
import testDataService, { isSecretVariable, keyForVariable, readableName } from '../../services/testDataService'
import type { AgentSetup } from '../../services/aiChecksService'
import SetupTestDataPanel from './SetupTestDataPanel'

interface Props {
  environment: string
  caseCount: number
  onChange: (setup: AgentSetup | null) => void
}

const box = 'w-full rounded-[9px] border border-[#DDE1E7] bg-white px-3 py-2 text-[12px] text-[#253041]'
const label = 'mb-1 block text-[11px] font-semibold text-[#536174]'

const AgentReviewSetup: React.FC<Props> = ({ environment, caseCount, onChange }) => {
  const [apps, setApps] = useState<JourneyKbApp[]>([])
  const [appKey, setAppKey] = useState('')
  const [registration, setRegistration] = useState<AppRegistration | null>(null)
  const [coverage, setCoverage] = useState<KbTestData | null>(null)
  const [authoredCount, setAuthoredCount] = useState(0)
  const [profileId, setProfileId] = useState('')
  const [env, setEnv] = useState(environment || 'QA')
  const [reuseKbEvidence, setReuseKbEvidence] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [newApp, setNewApp] = useState(false)
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [registering, setRegistering] = useState(false)
  const [entryValues, setEntryValues] = useState<Record<string, string>>({})
  const [savingData, setSavingData] = useState(false)

  useEffect(() => {
    let live = true
    knowledgeBaseService.listApps().then((list) => {
      if (!live) return
      setApps(list)
      // Never silently attach a new project's checks to the first unrelated app.
      setAppKey((current) => list.some((app) => app.app_id === current) ? current : '')
    }).catch((reason) => { if (live) setError(reason?.response?.data?.detail || 'Applications could not be loaded.') })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [])

  useEffect(() => {
    onChange(null)
    setRegistration(null)
    setCoverage(null)
    setAuthoredCount(0)
    setProfileId('')
    if (!appKey) return
    let live = true
    Promise.all([knowledgeBaseService.registration(appKey), knowledgeBaseService.testData(appKey), knowledgeBaseService.taxonomy(appKey)])
      .then(([reg, data, taxonomy]) => {
        if (!live) return
        setRegistration(reg)
        setCoverage(data)
        setAuthoredCount(taxonomy.authored.length)
        // A batch can contain positive and negative identities. Do not force
        // the first profile onto every case; each journey has its own default.
        setProfileId('')
        setError('')
      }).catch((reason) => { if (live) setError(reason?.response?.data?.detail || 'Application setup could not be loaded.') })
    return () => { live = false }
  }, [appKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const profile = coverage?.profiles.find((item) => item.profile_id === profileId)
  const cell = profile?.cells[env.toUpperCase()]
  const needed = profile?.kind === 'vault' ? (cell?.missing || profile.fields.map((field) => field.variable)) : []
  const address = registration?.addresses[env.toUpperCase()] || registration?.addresses['*']
  const ready = Boolean(registration?.crawl_app_id && address && (!profileId || cell?.status === 'ready') && profile?.kind !== 'external' && !/^(PRODUCTION|PROD|LIVE)$/i.test(env))
  useEffect(() => {
    onChange(ready ? { app_key: appKey, application_id: registration!.crawl_app_id!, profile_id: profileId || null, environment: env.toUpperCase(), reuse_kb_evidence: reuseKbEvidence } : null)
  }, [appKey, registration, profileId, env, ready, reuseKbEvidence, onChange])

  const environments = useMemo(() => Array.from(new Set([
    environment || 'QA', env, ...Object.keys(registration?.addresses || {})
  ].filter((value) => value && value !== '*'))), [environment, env, registration])

  const register = async () => {
    if (!newName.trim() || !/^https?:\/\/[^\s]+$/i.test(newUrl.trim())) {
      setError('Enter an application name and a full non-production website address.')
      return
    }
    setRegistering(true)
    setError('')
    try {
      const created = await knowledgeBaseService.registerApplication({ name: newName.trim(), addresses: { [env.toUpperCase()]: newUrl.trim() }, default_environment: env.toUpperCase() })
      const list = await knowledgeBaseService.listApps()
      setApps(list)
      setAppKey(created.app_key)
      setNewApp(false)
      setNewName('')
      setNewUrl('')
    } catch (reason: any) {
      setError(reason?.response?.data?.detail || reason?.message || 'The application could not be registered.')
    } finally { setRegistering(false) }
  }

  const saveMissing = async () => {
    if (!coverage?.vault_app || !needed.length) return
    const supplied = needed.filter((variable) => (entryValues[variable] || '').trim())
    if (!supplied.length) { setError('Enter at least one missing value to save.'); return }
    setSavingData(true)
    setError('')
    try {
      await testDataService.saveEntries(coverage.vault_app.id, supplied.map((variable) => ({
        environment: env.toUpperCase(), key: keyForVariable(variable), value: entryValues[variable],
        is_secret: isSecretVariable(variable)
      })), [])
      setEntryValues({})
      setCoverage(await knowledgeBaseService.testData(appKey))
    } catch (reason: any) {
      setError(reason?.response?.data?.detail || reason?.message || 'Test Data could not be saved.')
    } finally { setSavingData(false) }
  }

  const fillSynthetic = () => {
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(6)), (value) => value.toString(16).padStart(2, '0')).join('')
    setEntryValues((current) => ({ ...current, ...Object.fromEntries(needed.map((variable) => {
      const value = /PASSWORD|SECRET|PIN/i.test(variable) ? `Qa!${nonce}9` : /EMAIL/i.test(variable) ? `qa.agent.${nonce}@example.test` : /USER|LOGIN/i.test(variable) ? `qa_agent_${nonce}` : `qa-test-${nonce}`
      return [variable, value]
    })) }))
  }

  return <div className="mt-3 rounded-[14px] border border-[#E6E9EF] bg-[#FAFBFC] p-4 text-[12px] text-[#344054]">
    <div className="font-bold text-[#1F2937]">Set up the agents</div>
    <p className="mb-3 mt-1 leading-5 text-[#667085]">They will use a real browser crawl, then prepare any Knowledge Base changes for your approval. Your saved test cases stay unchanged.</p>
    {loading ? <p>Loading applications…</p> : <div className="grid gap-3 sm:grid-cols-2">
      <label><span className={label}>Application</span><select className={box} value={appKey} onChange={(event) => { setAppKey(event.target.value); setNewApp(false); setNewName(''); setNewUrl('') }}><option value="">Choose an application</option>{apps.map((app) => <option key={app.app_id} value={app.app_id}>{app.app_name}</option>)}</select></label>
      <label><span className={label}>Environment</span><select className={box} value={env} onChange={(event) => setEnv(event.target.value)}>{environments.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
    </div>}
    <button type="button" onClick={() => setNewApp((value) => !value)} className="mt-2 text-[12px] font-semibold text-[#B71920] hover:underline">{newApp ? 'Use an existing application' : '+ Register a new application'}</button>
    {newApp && <div className="mt-3 rounded-[10px] border border-[#E5E8EE] bg-white p-3">
      <div className="grid gap-2 sm:grid-cols-2"><label><span className={label}>Application name</span><input className={box} value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Customer portal" /></label><label><span className={label}>{env} website address</span><input className={box} value={newUrl} onChange={(event) => setNewUrl(event.target.value)} placeholder="https://qa.example.com" /></label></div>
      <p className="my-2 text-[11px] text-[#7A5C25]">Registration creates the application, not a user account. The guide agents will prepare missing journey steps for your approval.</p>
      <button type="button" disabled={registering} onClick={() => void register()} className="rounded-[8px] bg-[#B71920] px-3 py-1.5 font-bold text-white disabled:opacity-50">{registering ? 'Registering…' : 'Register application'}</button>
    </div>}
    {registration && <div className="mt-3 grid gap-2 sm:grid-cols-2">
      <div><span className={label}>Browser target</span><div className="break-all rounded-[9px] bg-white px-3 py-2">{address || `Add a ${env} address in Test Data before starting.`}</div></div>
      <label><span className={label}>Login / Test Data profile</span><select className={box} value={profileId} onChange={(event) => setProfileId(event.target.value)}><option value="">Use each journey’s configured profile</option>{coverage?.profiles.map((item) => <option key={item.profile_id} value={item.profile_id}>{item.name}</option>)}</select></label>
    </div>}
    {registration && <label className="mt-3 flex items-start gap-2 rounded-[9px] border border-[#DDE1E7] bg-white p-3">
      <input type="checkbox" checked={reuseKbEvidence} onChange={(event) => setReuseKbEvidence(event.target.checked)} className="mt-0.5" />
      <span><strong>Check Knowledge Base evidence first</strong><span className="mt-0.5 block text-[11px] text-[#667085]">Reuse a recent browser scan for this application and environment when it covers this case. Missing or stale evidence is crawled again; approved journeys are still verified during execution.</span></span>
    </label>}
    {registration?.crawl_app_id && address && <SetupTestDataPanel appKey={appKey} applicationId={registration.crawl_app_id} address={address} environment={env.toUpperCase()} coverage={coverage} caseCount={caseCount} onSaved={(updated, selectedProfile) => { setCoverage(updated); if (caseCount === 1) setProfileId(selectedProfile); setEntryValues({}) }} />}
    {profile?.kind === 'external' && <p className="mt-2 rounded-[8px] bg-[#FFF4E5] p-2 text-[#8A5000]">External login cannot run unattended. Choose a supported Test Data profile or prepare the login journey first.</p>}
    {profile?.kind === 'vault' && needed.length > 0 && <div className="mt-3 rounded-[10px] border border-[#E8D6B3] bg-[#FFF9EE] p-3">
      <div className="font-semibold text-[#805000]">Missing Test Data for {env}</div>
      <p className="mt-1 text-[11px]">Enter test-only credentials or values. Passwords are saved securely in Test Data and are not sent with the agent run. Synthetic values work only if the application accepts them.</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">{needed.map((variable) => <label key={variable}><span className={label}>{readableName(variable)}</span><input className={box} type={isSecretVariable(variable) ? 'password' : 'text'} autoComplete="off" value={entryValues[variable] || ''} onChange={(event) => setEntryValues((values) => ({ ...values, [variable]: event.target.value }))} /></label>)}</div>
      <button type="button" onClick={fillSynthetic} className="mt-3 mr-2 rounded-[8px] border border-[#C99D4B] bg-white px-3 py-1.5 font-semibold text-[#805000]">Fill with synthetic test values</button>
      <button type="button" disabled={savingData} onClick={() => void saveMissing()} className="mt-3 rounded-[8px] border border-[#C99D4B] bg-white px-3 py-1.5 font-semibold text-[#805000] disabled:opacity-50">{savingData ? 'Saving…' : 'Save to Test Data'}</button>
      <p className="mb-0 mt-2 text-[11px] text-[#7A5C25]">Synthetic values are not a registered account. A registration journey must exist and accept them before they can be used to sign in.</p>
    </div>}
    {registration && <div className={`mt-3 rounded-[8px] px-3 py-2 ${ready ? 'bg-[#EAF7EF] text-[#136B34]' : 'bg-[#FFF4E5] text-[#805000]'}`}>{ready ? authoredCount === 0 ? 'Ready to prepare: the guide agents will draft journey steps and observed controls for your approval before browser replay.' : 'Setup ready. The guide agents will direct the Automation Expert to a matching journey.' : /^(PRODUCTION|PROD|LIVE)$/i.test(env) ? 'Choose a non-production environment for a safe browser crawl.' : 'Complete the address and selected Test Data profile before starting.'}</div>}
    {error && <p role="alert" className="mt-2 text-[#A3231C]">{error}</p>}
  </div>
}

export default AgentReviewSetup
