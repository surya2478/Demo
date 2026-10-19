import React, { useEffect, useMemo, useState } from 'react'
import api from '../../services/api'
import automationService from '../../services/automationService'
import knowledgeBaseService, { type KbTestData } from '../../services/knowledgeBaseService'
import testDataService, { isSecretVariable, keyForVariable } from '../../services/testDataService'
import type { DiscoveryRun } from '../../types/automation'
import { observedInputFields, type SetupField } from './setupDataFields'

interface Props {
  appKey: string
  applicationId: number
  address: string
  environment: string
  coverage: KbTestData | null
  caseCount: number
  onSaved: (coverage: KbTestData, profileId: string) => void
}

const fieldInput = 'w-full rounded-[8px] border border-[#DDE1E7] bg-white px-2.5 py-1.5 text-[12px]'
const slug = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 55)

/** Discovery supplies field names only. This panel never proposes selectors. */
const SetupTestDataPanel: React.FC<Props> = ({ appKey, applicationId, address, environment, coverage, caseCount, onSaved }) => {
  const [open, setOpen] = useState(false)
  const [run, setRun] = useState<DiscoveryRun | null>(null)
  const [scanning, setScanning] = useState(false)
  const [observed, setObserved] = useState<SetupField[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [manualName, setManualName] = useState('')
  const [manual, setManual] = useState<SetupField[]>([])
  const [values, setValues] = useState<Record<string, string>>({})
  const [profileName, setProfileName] = useState('New test identity')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const targetHost = useMemo(() => { try { return new URL(address).host } catch { return '' } }, [address])
  const fieldHosts = (scan: DiscoveryRun) => [targetHost, ...scan.explored_pages.filter((page) =>
    page.linked_auth && page.status != null && page.status >= 200 && page.status < 400 &&
    !page.blocked_by_overlay && !/request rejected|access denied/i.test(page.title || '')
  ).map((page) => { try { return new URL(page.url).host } catch { return '' } }).filter(Boolean)]
  const observedFields = (scan: DiscoveryRun, mainElements: Parameters<typeof observedInputFields>[0]) => {
    const linkedElements = scan.explored_pages.flatMap((page, pageIndex) =>
      page.linked_auth && page.status != null && page.status >= 200 && page.status < 400 &&
      !page.blocked_by_overlay && !/request rejected|access denied/i.test(page.title || '')
        ? (page.linked_auth_controls || []).filter((control) => control.page_url === page.url)
          .map((control, controlIndex) => ({ ...control, id: `linked-${pageIndex}-${controlIndex}` })) : [])
    return observedInputFields([...mainElements, ...linkedElements], fieldHosts(scan))
  }
  const fields = useMemo(() => [...observed, ...manual].filter((field) => selected.includes(field.id)), [observed, manual, selected])
  const linkedLogin = run?.blockers.filter((item) => item.kind === 'linked_auth' &&
    !/\.(?:pdf|docx?|xlsx?|zip)(?:$|[?#])/i.test(item.target_url || '')) || []
  const staleDocumentMatch = run?.blockers.some((item) => item.kind === 'linked_auth' &&
    /\.(?:pdf|docx?|xlsx?|zip)(?:$|[?#])/i.test(item.target_url || '')) || false
  const linkedPage = run?.explored_pages.find((page) => page.linked_auth && linkedLogin.some((item) => item.target_url === page.requested_url) &&
    page.status != null && page.status >= 200 && page.status < 400 && !page.blocked_by_overlay &&
    !/request rejected|access denied/i.test(page.title || ''))

  useEffect(() => {
    setRun(null); setObserved([]); setSelected([]); setManual([]); setValues({}); setError(''); setMessage(''); setScanning(false)
  }, [appKey, environment, address])

  useEffect(() => {
    if (!open || run || scanning || !targetHost) return
    let live = true
    const loadSaved = async () => {
      try {
        const state = await automationService.getDiscovery(applicationId)
        const current = state.discovery
        if (!live || current?.status !== 'completed' || current.application_id !== applicationId ||
            current.application_url?.replace(/\/$/, '') !== address.replace(/\/$/, '') ||
            current.application_environment?.toUpperCase() !== environment.toUpperCase()) return
        const catalogue = await automationService.listDiscoveredElements({ applicationId })
        if (!live) return
        setRun(current)
        setObserved(observedFields(current, catalogue.elements))
        setMessage(`Showing saved scan #${current.id}. Scan again for a fresh view of the application.`)
      } catch { /* The Scan button remains available when no saved catalogue can be read. */ }
    }
    void loadSaved()
    return () => { live = false }
  }, [open, run?.id, scanning, applicationId, address, environment, targetHost])

  useEffect(() => {
    if (!scanning || !run) return
    let live = true
    let pending = false
    const poll = async () => {
      if (pending) return
      pending = true
      try {
        const state = await automationService.getDiscovery(applicationId)
        const current = state.discovery
        if (!live || !current) return
        if (current.id !== run.id || current.application_id !== applicationId ||
            current.application_url?.replace(/\/$/, '') !== address.replace(/\/$/, '')) {
          setError('Another scan replaced this application’s current scan. Run it again to use current evidence.')
          setScanning(false)
          return
        }
        setRun(current)
        if (current.status === 'failed') {
          setError(current.error || 'Browser scan failed.')
          setScanning(false)
        } else if (current.status === 'completed') {
          const catalogue = await automationService.listDiscoveredElements({ applicationId })
          if (!live) return
          setObserved(observedFields(current, catalogue.elements))
          setMessage(`Scanned ${current.pages_discovered} page(s) and ${current.elements_discovered} control(s). Select the input fields this test identity needs.`)
          setScanning(false)
        }
      } catch (reason: any) {
        if (live) { setError(reason?.message || 'Could not read the browser scan.'); setScanning(false) }
      } finally { pending = false }
    }
    void poll()
    const timer = window.setInterval(() => { void poll() }, 2000)
    return () => { live = false; window.clearInterval(timer) }
  }, [scanning, run?.id, applicationId, address, targetHost])

  const startScan = async () => {
    if (!targetHost || !address.startsWith('https://') && !address.startsWith('http://')) {
      setError('Register a complete application address first.'); return
    }
    setError(''); setMessage(''); setObserved([]); setSelected([]); setRun(null)
    try {
      const started = await automationService.startDiscovery({ application_id: applicationId,
        application_url: address, application_environment: environment, max_pages: 5 })
      setRun(started); setScanning(true)
    } catch (reason: any) { setError(reason?.message || 'Browser scan could not start.') }
  }

  const addManual = () => {
    const name = manualName.trim()
    if (!name || !slug(name)) { setError('Enter a field name such as username or customer ID.'); return }
    if ([...observed, ...manual].some((field) => field.name.toLowerCase() === name.toLowerCase())) {
      setError('That field is already listed. Select it above.'); return
    }
    const id = `manual-${crypto.randomUUID()}`
    setManual((previous) => [...previous, { id, name, observed: false }])
    setSelected((previous) => [...previous, id])
    setManualName(''); setError('')
  }

  const save = async () => {
    if (!coverage?.vault_app) { setError('Register this application in Test Data first.'); return }
    if (!fields.length || !profileName.trim()) { setError('Name the profile and select at least one field.'); return }
    if (fields.some((field) => !values[field.id]?.trim())) { setError('Enter a value for each selected field.'); return }
    const names = fields.map((field) => slug(field.name))
    if (new Set(names).size !== names.length) { setError('Selected field names must be unique within one profile.'); return }
    setSaving(true); setError('')
    let changeId: number | null = null
    try {
      const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()
      const profileId = `SETUP_${suffix}`
      const definitions = fields.map((field, index) => ({ name: field.name, variable: `TESTDATA_${profileId}_${names[index]}` }))
      const draft = await api.post(`/automation/knowledge-base/${encodeURIComponent(appKey)}/change-sets`, {
        kb: 'journey', source: 'setup-test-data', title: `Test Data profile: ${profileName.trim()}`,
        description: `Profile fields chosen in agent setup. ${fields.filter((field) => field.observed).length} field(s) were observed on the application host; manually added fields are user supplied. Values are stored separately.`,
        changes: [{ file: 'roles.json', op: 'set', path: `test_data_profiles.${profileId}`,
          value: { name: profileName.trim(), kind: 'vault', fields: definitions,
            description: 'Prepared in agent setup. Test values are stored by environment in Test Data.',
            state: 'Test-only values' } }]
      })
      changeId = draft.data.id
      await knowledgeBaseService.approve(changeId!, 'Added the selected Test Data profile during agent setup.')
      await testDataService.saveEntries(coverage.vault_app.id, definitions.map((definition, index) => ({
        environment: environment.toUpperCase(), key: keyForVariable(definition.variable),
        value: values[fields[index].id].trim(), is_secret: isSecretVariable(definition.variable)
      })), [])
      const refreshed = await knowledgeBaseService.testData(appKey)
      onSaved(refreshed, profileId)
      setMessage(`Saved ${definitions.length} field(s) to ${environment}. ${caseCount === 1 ? `${profileName.trim()} is selected for this case.` : 'Choose this profile above only if it fits every selected case; otherwise assign profiles per case.'}`)
      setValues({}); setSelected([])
    } catch (reason: any) {
      setError(`${reason?.response?.data?.detail || reason?.message || 'Could not save Test Data.'}${changeId ? ' The profile may have been created; refresh its status before trying again.' : ''}`)
    } finally { setSaving(false) }
  }

  return <div className="mt-3 rounded-[10px] border border-[#D9E1EE] bg-white p-3">
    <button type="button" onClick={() => setOpen((value) => !value)} className="text-[12px] font-bold text-[#244B7D] underline">{open ? 'Hide Test Data setup' : 'Add Test Data or scan for fields'}</button>
    {open && <div className="mt-2 space-y-3">
      <p className="m-0 text-[11px] text-[#667085]">Scan the registered address to see browser observed input names. Protected pages need a configured login first. The scan does not create working credentials.</p>
      <button type="button" disabled={scanning || saving} onClick={() => void startScan()} className="rounded-[8px] border border-[#C9D6E8] px-3 py-1.5 text-[11px] font-bold text-[#244B7D] disabled:opacity-50">{scanning ? 'Scanning application…' : run?.status === 'completed' ? 'Scan again for fields' : 'Scan application for fields'}</button>
      {run && <p className="m-0 text-[11px] text-[#667085]">Scan #{run.id}: {run.status} · {run.pages_discovered} pages · {run.elements_discovered} controls{run.blockers.length ? ` · ${run.blockers.length} blocked routes` : ''}</p>}
      {run?.status === 'completed' && <p className="m-0 text-[11px] text-[#667085]">This is a public crawl, not a signed-in session. A linked sign-in host may be inspected for field names, but its controls are not approved for credential use until that host and login journey are reviewed. {observed.some((field) => /user\s*name|password|sign.?in|log.?in/i.test(field.name)) ? 'Possible login inputs were observed below; select only fields that match this test identity.' : 'No verified login input was found on these pages.'}</p>}
      {run?.status === 'completed' && staleDocumentMatch && <p role="status" className="m-0 rounded-[8px] bg-[#FFF4E5] p-2 text-[11px] text-[#805000]">This saved scan mistook a document for a sign-in route. Scan again to let Crawl Guide inspect the actual sign-in link.</p>}
      {run?.status === 'completed' && linkedLogin.length > 0 && <p role="status" className="m-0 rounded-[8px] bg-[#EAF2FD] p-2 text-[11px] text-[#244B7D]">Crawl Guide found an observed sign-in route{linkedPage ? ' and inspected its public login page' : ', but has not verified its login page yet'}. Start AI checks to have the agents prepare a reviewable login Journey from the scan, then use existing Test Data for this environment. They cannot invent working credentials or approve an unverified form.</p>}
      {run && run.blockers.length > 0 && <div className="rounded-[8px] border border-[#F3D6B1] bg-[#FFFAF2] p-2 text-[11px] text-[#805000]"><strong>Routes needing attention</strong><ul className="mb-0 mt-1 list-disc pl-4">{run.blockers.slice(0, 4).map((blocker, index) => <li key={index}>{blocker.reason} <span className="break-all text-[#667085]">{blocker.url}</span></li>)}</ul></div>}
      {observed.length > 0 && <div className="max-h-40 space-y-1 overflow-y-auto rounded-[8px] border border-[#E6E9EF] p-2">{observed.map((field) => <label key={field.id} className="flex items-start gap-2 text-[11px]"><input type="checkbox" checked={selected.includes(field.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, field.id] : current.filter((id) => id !== field.id))} /><span><strong>{field.name}</strong><span className="ml-1 text-[#667085]">Observed · {field.page}</span></span></label>)}</div>}
      {run?.status === 'completed' && observed.length === 0 && <p className="m-0 text-[11px] text-[#805000]">No named input field was verified on this host. Add known Test Data fields manually, or inspect the blocked routes.</p>}
      <div className="flex gap-2"><input className={fieldInput} aria-label="Additional field name" placeholder="Add a field, e.g. username" value={manualName} onChange={(event) => setManualName(event.target.value)} /><button type="button" onClick={addManual} className="shrink-0 rounded-[8px] border px-3 text-[11px] font-bold">Add field</button></div>
      {manual.length > 0 && <p className="m-0 text-[11px] text-[#667085]">Manually named: {manual.map((field) => field.name).join(', ')}</p>}
      {fields.length > 0 && <div className="space-y-2"><label className="block text-[11px] font-semibold">Profile name<input className={fieldInput} value={profileName} onChange={(event) => setProfileName(event.target.value)} /></label><div className="grid gap-2 sm:grid-cols-2">{fields.map((field) => <label key={field.id} className="text-[11px] font-semibold">{field.name}<input className={fieldInput} type={isSecretVariable(`TESTDATA_${slug(field.name)}`) ? 'password' : 'text'} autoComplete="off" value={values[field.id] || ''} onChange={(event) => setValues((previous) => ({ ...previous, [field.id]: event.target.value }))} /></label>)}</div><p className="m-0 text-[11px] text-[#805000]">{caseCount === 1 ? 'This profile will be selected for this case.' : 'This batch has multiple cases. The profile will be saved without applying one identity to all cases. Choose it above only if it fits every case.'}</p><button type="button" disabled={saving} onClick={() => void save()} className="rounded-[8px] bg-[#B71920] px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save profile and values'}</button></div>}
      {message && <p role="status" className="m-0 text-[11px] text-[#136B34]">{message}</p>}
      {error && <p role="alert" className="m-0 text-[11px] text-[#A3231C]">{error}</p>}
    </div>}
  </div>
}

export default SetupTestDataPanel
