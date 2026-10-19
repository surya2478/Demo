import React, { useCallback, useEffect, useState } from 'react'
import api from '../../services/api'
import knowledgeBaseService, { type JourneyCrawl } from '../../services/knowledgeBaseService'
import { RecordingLive } from '../knowledge-base/JourneyRecording'

export default function ReviewLoginCapture({ requestId, caseId, recordingId, onDrafts }: {
  requestId: string; caseId: string; recordingId?: number | null; onDrafts: (ids: number[]) => void
}) {
  const [crawl, setCrawl] = useState<JourneyCrawl | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    const id = crawl?.id || recordingId
    if (id) setCrawl(await knowledgeBaseService.crawl(id))
  }, [crawl?.id, recordingId])
  useEffect(() => { void refresh().catch(() => setError('The recording could not be loaded.')) }, [refresh])
  const start = async () => {
    setBusy(true); setError('')
    try { setCrawl((await api.post(`/test-case-reviews/detail/${encodeURIComponent(requestId)}/cases/${encodeURIComponent(caseId)}/record-login`)).data) }
    catch (err: any) { setError(err?.response?.data?.detail || 'The capture browser could not start.') }
    finally { setBusy(false) }
  }
  const save = async () => {
    if (!crawl?.result?.recording) return
    setBusy(true); setError('')
    try {
      await knowledgeBaseService.saveRecording(crawl.id, { steps: crawl.result.recording, link_flow: 'new', publish: false })
      const updated = await knowledgeBaseService.crawl(crawl.id)
      setCrawl(updated)
      onDrafts([updated.journey_change_set_id, updated.automation_change_set_id].filter((id): id is number => !!id))
    } catch (err: any) { setError(err?.response?.data?.detail || 'The observed login could not be saved.') }
    finally { setBusy(false) }
  }
  const active = crawl?.status === 'running' || crawl?.status === 'queued'
  return <section className="mt-3 rounded-lg border bg-white p-3 text-[12px]">
    <h4 className="font-bold">Capture sign-in — no existing journey needed</h4>
    <p>A local browser opens for you to sign in with your authorized test account and fresh OTP. Return here to finish and review the captured steps. Do not purchase, accept finance terms, or submit an order.</p>
    <p>Typed values are not saved. The journey keeps observed controls and field types. A fresh OTP is required again on future sign-ins; recording does not make it reusable.</p>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {!active && <button disabled={busy} onClick={() => void start()} className="rounded border px-3 py-2 font-semibold">{crawl ? 'Record again' : 'Open sign-in capture'}</button>}
    {active && crawl && <RecordingLive crawl={crawl} canStop onFinished={() => void refresh()} />}
    {crawl?.status === 'failed' && <p role="alert">{crawl.error}</p>}
    {crawl?.status === 'completed' && <>
      <ol>{crawl.result?.recording?.map((step, i) => <li key={i}>{i + 1}. {step.action}</li>)}</ol>
      <button disabled={busy} onClick={() => void save()} className="mt-2 rounded border px-3 py-2 font-semibold">Review reusable login and script blueprint</button>
    </>}
  </section>
}
