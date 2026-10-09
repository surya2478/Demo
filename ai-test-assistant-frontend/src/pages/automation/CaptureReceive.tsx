import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import knowledgeBaseService, { errorText, type InboxCapture } from '../../services/knowledgeBaseService'

// Where the KB capture tool's "Send to Knowledge Base" lands. The tool opens
// this page from the application's tab and hands it the capture with
// window.postMessage; nothing reaches the server until the person presses
// Save -- a page somewhere else could open this one too, so the origin and
// what arrived are shown first. Saved captures wait in the Crawl stage's
// inbox, where they are reviewed as a flow and imported as a walk.

type Pending = { id: string; origin: string; source: MessageEventSource; capture: { format: string; host?: string; name?: string; pages: { page_id?: string; name?: string; url?: string; elements?: unknown[]; picked?: unknown[] }[] } }

const FORMAT = 'kb-capture/1'
const BTN = 'h-10 rounded-[12px] px-4 text-[13px] font-bold disabled:cursor-not-allowed disabled:opacity-50'

const pathOf = (url?: string) => { try { return new URL(url ?? '').pathname } catch { return url ?? '' } }

const CaptureReceive: React.FC = () => {
  const navigate = useNavigate()
  const [pending, setPending] = useState<Pending | null>(null)
  const [saved, setSaved] = useState<InboxCapture | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(true)
  const opener = useRef<Window | null>(window.opener as Window | null)

  useEffect(() => {
    const from = opener.current
    if (!from) { setWaiting(false); return }
    let timer = 0
    const onMessage = (e: MessageEvent) => {
      if (e.source !== from || !e.data || typeof e.data !== 'object' || e.data.type !== 'kb-capture') return
      const capture = e.data.capture
      if (!capture || capture.format !== FORMAT || !Array.isArray(capture.pages)) return
      window.clearInterval(timer)
      setPending(current => (current?.id === e.data.id ? current : { id: String(e.data.id), origin: e.origin, source: e.source as MessageEventSource, capture }))
      setWaiting(false)
    }
    window.addEventListener('message', onMessage)
    // Say "ready" until the tool answers (it may still be setting up). No data goes with it.
    let tries = 0
    const ping = () => { try { from.postMessage({ type: 'kb-capture-ready' }, '*') } catch { /* closed */ } }
    ping()
    timer = window.setInterval(() => { tries += 1; if (tries > 20) { window.clearInterval(timer); setWaiting(false) } else ping() }, 1000)
    return () => { window.removeEventListener('message', onMessage); window.clearInterval(timer) }
  }, [])

  const reply = (message: Record<string, unknown>) => {
    if (!pending) return
    try { (pending.source as Window).postMessage(message, pending.origin) } catch { /* the tool's tab was closed */ }
  }

  const save = async () => {
    if (!pending) return
    setBusy(true)
    setError(null)
    try {
      const capture = await knowledgeBaseService.receiveCapture(pending.capture, pending.origin)
      reply({ type: 'kb-capture-saved', id: pending.id, capture_id: capture.id })
      setSaved(capture)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const cancel = () => { reply({ type: 'kb-capture-cancelled', id: pending?.id }); setPending(null) }
  const review = (capture: InboxCapture) => {
    const p = new URLSearchParams({ stage: 'crawl', capture: '1', inbox: String(capture.id) })
    if (capture.app_id) p.set('app', capture.app_id)
    navigate(`/automation/knowledge-base?${p.toString()}`)
  }

  const pages = pending?.capture.pages ?? []
  const elements = pages.reduce((n, p) => n + (p.elements?.length ?? 0) + (p.picked?.length ?? 0), 0)
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-4 p-6">
      <div>
        <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#6B7280]">Knowledge Base · capture inbox</div>
        <h1 className="m-0 mt-1 text-[22px] font-bold text-[#1F2937]">Capture from your browser</h1>
      </div>

      {saved ? (
        <div className="rounded-[16px] border border-[#CDEBD8] bg-[#F3FBF6] p-5 text-[13px] text-[#136B34]">
          <div className="text-[15px] font-bold">Saved as capture #{saved.id}</div>
          <p className="mb-3 mt-1">
            {saved.pages} page{saved.pages === 1 ? '' : 's'}, {saved.elements} objects
            {saved.app_id ? <> · matched to <strong>{saved.app_id}</strong>{saved.environment ? ` (${saved.environment})` : ''}</> : ' · choose its application in the inbox'}.
            Review it as a flow, then import it against a journey. You can close this tab and keep capturing in the other one.
          </p>
          <button type="button" className={`${BTN} bg-[#B71920] text-white`} onClick={() => review(saved)}>Review the flow</button>
        </div>
      ) : pending ? (
        <div className="rounded-[16px] border border-[#E8EAEE] bg-white p-5 text-[13px] text-[#374151] shadow-sm">
          <div className="text-[15px] font-bold text-[#1F2937]">{pending.capture.name || pending.capture.host || 'Capture'}</div>
          <p className="mt-1">
            Sent from <code className="rounded bg-[#F4F5F7] px-1">{pending.origin}</code>: {pages.length} page{pages.length === 1 ? '' : 's'}, {elements} objects.
            Save it only if you sent it from the KB capture tool just now.
          </p>
          <ol className="my-3 flex max-h-[280px] list-decimal flex-col gap-1 overflow-y-auto pl-5">
            {pages.map((p, i) => (
              <li key={p.page_id ?? i}><span className="font-semibold text-[#1F2937]">{p.name || `Page ${i + 1}`}</span> <span className="font-mono text-[11.5px] text-[#6B7280]">{pathOf(p.url)}</span></li>
            ))}
          </ol>
          {error && <div role="alert" className="mb-3 rounded-[10px] border border-[#F6D4D5] bg-[#FFF8F8] px-3 py-2 text-[#7A0B0D]">{error}</div>}
          <div className="flex gap-2">
            <button type="button" className={`${BTN} bg-[#B71920] text-white`} disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save to inbox'}</button>
            <button type="button" className={`${BTN} border border-[#E8EAEE] bg-white text-[#1F2937]`} disabled={busy} onClick={cancel}>Cancel</button>
          </div>
        </div>
      ) : waiting ? (
        <div className="rounded-[16px] border border-[#E8EAEE] bg-white p-5 text-[13px] text-[#6B7280]">Waiting for the capture from the other tab…</div>
      ) : (
        <div className="rounded-[16px] border border-[#EBCFA4] bg-[#FFFBF4] p-5 text-[13px] text-[#8A5000]">
          Nothing was received. This page takes captures from the KB capture tool: on the application&apos;s page, press <strong>Send to Knowledge Base</strong> in the tool.
          If you had to sign in first, press it again now.
          <div className="mt-3">
            <button type="button" className={`${BTN} border border-[#E8EAEE] bg-white text-[#1F2937]`}
              onClick={() => navigate('/automation/knowledge-base?stage=crawl&capture=1')}>Open the capture inbox</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default CaptureReceive
