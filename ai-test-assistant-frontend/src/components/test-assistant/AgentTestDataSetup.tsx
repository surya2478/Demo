import React, { useEffect, useMemo, useState } from 'react'
import aiChecksService, { type AgentTestDataSuggestion } from '../../services/aiChecksService'

interface Props {
  batchId: string
  checkId: number
  onProfileDraft: (changeSetId: number) => void
  onSaved: () => void
  onReady?: () => void
}

const syntheticValues = (fields: { name: string; variable: string }[]) => {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(4)), (value) => value.toString(16).padStart(2, '0')).join('')
  const password = `Qa!${nonce}9x`
  return Object.fromEntries(fields.map((field) => {
    const name = field.name.toLowerCase()
    const value = /password|confirm/.test(name) ? password
      : /email/.test(name) ? `qa.${nonce}@example.test`
      : /user/.test(name) ? `qa_${nonce}`
      : /first name/.test(name) ? 'Test'
      : /last name/.test(name) ? `User${nonce.slice(0, 4)}`
      : /address/.test(name) ? '123 Test Street'
      : /city/.test(name) ? 'Testville'
      : /state/.test(name) ? 'CA'
      : /zip|postal/.test(name) ? '90210'
      : /phone|mobile/.test(name) ? '5550100199'
      : /ssn/.test(name) ? `900-${nonce.slice(0, 2)}-${nonce.slice(2, 6)}`
      : `QA-${nonce}`
    return [field.variable, value]
  }))
}

const AgentTestDataSetup: React.FC<Props> = ({ batchId, checkId, onProfileDraft, onSaved, onReady }) => {
  const [info, setInfo] = useState<AgentTestDataSuggestion | null>(null)
  const [profileId, setProfileId] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [autoPrepared, setAutoPrepared] = useState(false)

  useEffect(() => {
    let active = true
    aiChecksService.agentTestDataSuggestion(batchId, checkId)
      .then((result) => { if (active) { setInfo(result); setProfileId(result.recommended_profile_id || result.profile_id) } })
      .catch((reason) => { if (active) setError(reason?.response?.data?.detail || 'Captured fields could not be loaded.') })
    return () => { active = false }
  }, [batchId, checkId])

  const fields = useMemo(() => {
    if (!info) return []
    return profileId === info.profile_id ? info.fields : info.profiles.find((profile) => profile.profile_id === profileId)?.fields || []
  }, [info, profileId])

  useEffect(() => {
    if (info && fields.length && !info.recommended_profile_id && info.synthetic_safe && !autoPrepared && !Object.keys(values).length) {
      setValues(syntheticValues(fields))
      setMessage('Approval Manager prepared test-only examples for review. They are not saved yet.')
      setAutoPrepared(true)
    }
  }, [info, fields, values, autoPrepared])

  const fillDummy = () => {
    setValues(syntheticValues(fields))
    setMessage('Test-only values are ready to review. Save them when you are satisfied.')
  }

  const save = async () => {
    if (!info || fields.some((field) => !values[field.variable]?.trim())) {
      setError('Add a value for every captured field before saving.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await aiChecksService.saveAgentTestData(batchId, checkId, profileId, values)
      setMessage(`${result.message} The entered values remain in this form for review; sensitive fields stay masked.`)
      onSaved()
      if (result.change_set_id) onProfileDraft(result.change_set_id)
      else onReady?.()
    } catch (reason: any) {
      setError(reason?.response?.data?.detail || reason?.message || 'Test Data could not be saved.')
    } finally { setBusy(false) }
  }

  const useExisting = async () => {
    if (!info || !info.ready_profile_ids.includes(profileId)) return
    setBusy(true)
    setError('')
    try {
      const result = await aiChecksService.assignExistingAgentTestData(batchId, checkId, profileId)
      setMessage(result.message)
      onSaved()
      onReady?.()
    } catch (reason: any) {
      setError(reason?.response?.data?.detail || reason?.message || 'The stored profile could not be selected.')
    } finally { setBusy(false) }
  }

  return <div className="rounded-[10px] border border-[#D6E4F5] bg-[#F8FAFD] p-3 text-[12px] text-[#344054]">
    <div className="font-bold">Add Test Data here</div>
    <p className="mb-2 mt-1 text-[11px] text-[#667085]">These field names come from the captured browser page. Use your own test values or fill test-only examples; examples are not a registered account.</p>
    {!info && !error && <div>Loading captured fields…</div>}
    {info && <>
      <div className="mb-2 rounded bg-white p-2 text-[11px]"><strong>Needed for this case:</strong> {info.requirements.length ? info.requirements.join(', ').replaceAll('_', ' ') : 'No exact data fields were identified.'} {info.requires_existing_account && <span className="block mt-1 text-[#805000]">This is a sign-in test. New dummy credentials alone cannot log in; use a ready test account or create one first.</span>}</div>
      <label className="mb-2 block font-semibold">Profile
        <select className="mt-1 w-full rounded border border-[#D0D5DD] bg-white p-2 font-normal" value={profileId} onChange={(event) => { setProfileId(event.target.value); setValues({}); setMessage(''); setAutoPrepared(false) }}>
          {!info.profile_exists && <option value={info.profile_id}>Create a profile for this case (approval required)</option>}
          {info.profiles.map((profile) => <option key={profile.profile_id} value={profile.profile_id}>{profile.name} · {info.ready_profile_ids.includes(profile.profile_id) ? `ready for ${info.environment}` : 'missing matching data'}</option>)}
        </select>
      </label>
      {info.ready_profile_ids.includes(profileId) && <div className="mb-2 rounded border border-[#BBDFC8] bg-[#F5FBF7] p-2 text-[#136B34]"><strong>Stored KB data is ready for these fields.</strong> Values remain in Test Data and are not shown here. <button type="button" disabled={busy} onClick={() => void useExisting()} className="mt-2 block rounded bg-[#136B34] px-3 py-1.5 font-bold text-white disabled:opacity-50">{busy ? 'Assigning…' : 'Use this stored data'}</button></div>}
      {!fields.length ? <div className="rounded bg-[#FFF4E5] p-2 text-[#805000]">No input fields were verified. Check the browser evidence before adding values.</div> : <>
        <div className="grid gap-2 sm:grid-cols-2">{fields.map((field) => <label key={field.variable} className="font-semibold">{field.name}
          <input className="mt-1 w-full rounded border border-[#D0D5DD] bg-white p-2 font-normal" type={/PASSWORD|SECRET|TOKEN|PIN|SSN/i.test(field.variable) ? 'password' : 'text'} autoComplete="off" value={values[field.variable] || ''} onChange={(event) => setValues((current) => ({ ...current, [field.variable]: event.target.value }))} />
        </label>)}</div>
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={fillDummy} disabled={!info.synthetic_safe} title={!info.synthetic_safe ? 'This case needs real existing test data; invented values may fail' : undefined} className="rounded border border-[#9BB8D7] bg-white px-3 py-1.5 font-semibold disabled:opacity-50">Prepare test-only examples</button><button type="button" disabled={busy} onClick={() => void save()} className="rounded bg-[#344054] px-3 py-1.5 font-bold text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save Test Data'}</button></div>
      </>}
      <p className="mb-0 mt-2 text-[11px] text-[#667085]">Saved values go to Test Data for {info.environment}. Passwords and sensitive fields are encrypted. A new profile stays a draft until you approve it.</p>
    </>}
    {message && <div role="status" className="mt-2 text-[#136B34]">{message}</div>}
    {error && <div role="alert" className="mt-2 text-[#A3231C]">{error}</div>}
  </div>
}

export default AgentTestDataSetup
