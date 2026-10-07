import React, { useEffect, useRef, useState } from 'react'
import {
  HiOutlineArrowPath,
  HiOutlineCheckCircle,
  HiOutlineClock,
  HiOutlinePlus,
  HiOutlineXMark
} from 'react-icons/hi2'
import api from '../services/api'

type IngestionStage = 'extract' | 'embedding' | 'store'
type IngestionStatus = 'pending' | 'running' | 'completed' | 'error'

interface IngestionStageState {
  status: IngestionStatus
  message?: string
  completedChunks?: number
  totalChunks?: number
}

interface IngestionEvent {
  type: 'progress' | 'result' | 'error'
  stage?: IngestionStage
  status?: Exclude<IngestionStatus, 'pending' | 'error'>
  message?: string
  detail?: string
  completed_chunks?: number
  total_chunks?: number
  data?: {
    document_name: string
    squad_name: string
    systems: string[]
    chunks_ingested: number
    embedding_model: string
  }
}

const INGESTION_STAGES: { key: IngestionStage; label: string }[] = [
  { key: 'extract', label: 'Extracting document text' },
  { key: 'embedding', label: 'Creating embeddings' },
  { key: 'store', label: 'Storing in knowledge base' }
]

const initialProgress = (): Record<IngestionStage, IngestionStageState> => ({
  extract: { status: 'pending' },
  embedding: { status: 'pending' },
  store: { status: 'pending' }
})

const SquadKnowledgeBaseIngestion: React.FC = () => {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [squads, setSquads] = useState<string[]>([])
  const [squadsLoading, setSquadsLoading] = useState(true)
  const [squad, setSquad] = useState('')
  const [systems, setSystems] = useState<string[]>([])
  const [systemDraft, setSystemDraft] = useState('')
  const [addSquadOpen, setAddSquadOpen] = useState(false)
  const [newSquadName, setNewSquadName] = useState('')
  const [addingSquad, setAddingSquad] = useState(false)
  const [documents, setDocuments] = useState<string[]>([])
  const [documentsLoading, setDocumentsLoading] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState(initialProgress)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const loadSquads = async () => {
    setSquadsLoading(true)
    try {
      const response = await api.get<{ squads: string[] }>('/generate/squad-knowledge-base/squads')
      setSquads(response.data.squads || [])
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'Unable to load squads.')
    } finally {
      setSquadsLoading(false)
    }
  }

  useEffect(() => {
    void loadSquads()
  }, [])

  const loadDocuments = async (selectedSquad: string) => {
    if (!selectedSquad) {
      setDocuments([])
      return
    }
    setDocumentsLoading(true)
    setError('')
    try {
      console.log("SquadKnowledgeBaseIngestion ===== loadDocuments ==== selectedSquad === ",selectedSquad)
      console.log(`SquadKnowledgeBaseIngestion ===== loadDocuments ==== encodeURIComponent(selectedSquad) === ${encodeURIComponent(selectedSquad)}`)
      const response = await api.get<{ documents: string[] }>(`/generate/squad-knowledge-base/documents/${encodeURIComponent(selectedSquad)}`)
      setDocuments(response.data.documents || [])
    } catch (err: any) {
      setDocuments([])
      setError(err?.response?.data?.detail || 'Unable to load squad documents.')
    } finally {
      setDocumentsLoading(false)
    }
  }

  const handleSquadChange = (selectedSquad: string) => {
    setSquad(selectedSquad)
    setSystems(selectedSquad === 'Device Squad' ? ['BCRM', 'B2B', 'SMB'] : [])
    setSystemDraft('')
    setMessage('')
    setError('')
    void loadDocuments(selectedSquad)
  }

  const chooseFile = (candidate: File | undefined) => {
    setMessage('')
    setError('')
    if (!candidate) return
    if (!/\.(docx|pdf|xlsx)$/i.test(candidate.name)) {
      setFile(null)
      setError('Only DOCX, PDF and XLSX files are supported.')
      return
    }
    if (candidate.size > 25 * 1024 * 1024) {
      setFile(null)
      setError('The uploaded file exceeds the 25 MB limit.')
      return
    }
    setFile(candidate)
  }

  const addSquad = async () => {
    const name = newSquadName.trim()
    if (!name || addingSquad) return
    setAddingSquad(true)
    setError('')
    setMessage('')
    try {
      const response = await api.post<{ squads: string[]; added: string }>(
        '/generate/squad-knowledge-base/squads',
        { name }
      )
      setSquads(response.data.squads)
      setSquad(response.data.added)
      setSystems([])
      setNewSquadName('')
      setAddSquadOpen(false)
      setMessage(`Squad "${response.data.added}" added.`)
      void loadDocuments(response.data.added)
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'Unable to add squad.')
    } finally {
      setAddingSquad(false)
    }
  }

  const addSystem = () => {
    const name = systemDraft.trim()
    if (!name) return
    if (systems.some((system) => system.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setError(`System "${name}" is already selected.`)
      return
    }
    if (systems.length >= 50) {
      setError('A maximum of 50 systems can be selected.')
      return
    }
    setSystems((current) => [...current, name])
    setSystemDraft('')
    setError('')
  }

  const resetForm = () => {
    setSquad('')
    setSystems([])
    setSystemDraft('')
    setDocuments([])
    setFile(null)
    setMessage('')
    setError('')
    setProgress(initialProgress())
    setAddSquadOpen(false)
    setNewSquadName('')
    if (inputRef.current) inputRef.current.value = ''
  }

  const ingest = async () => {
    if (!file || !squad || loading) return
    setLoading(true)
    setMessage('')
    setError('')
    setProgress({
      ...initialProgress(),
      extract: { status: 'running', message: 'Reading the uploaded document.' }
    })
    try {
      const formData = new FormData()
      formData.append('squad_name', squad)
      systems.forEach((system) => formData.append('systems', system))
      formData.append('file', file)
            const baseUrl = String(api.defaults.baseURL || '').replace(/\/$/, '')
      const token = localStorage.getItem('authToken') || localStorage.getItem('api_token') || sessionStorage.getItem('authToken') || ''
      const response = await fetch(`${baseUrl}/generate/squad-knowledge-base/ingest-document-stream`, {
        method: 'POST',
        body: formData,
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      })

      if (!response.ok || !response.body) {
        let detail = 'Document ingestion failed.'
        try {
          const body = await response.json()
          if (typeof body?.detail === 'string') detail = body.detail
        } catch {
          // Keep the generic error for a non-JSON response.
        }
        throw new Error(detail)
      }

      let buffer = ''
      let streamError = ''
      let result: IngestionEvent['data']
      const applyEvent = (event: IngestionEvent) => {
        if (event.type === 'progress' && event.stage) {
          setProgress((current) => ({
            ...current,
            [event.stage!]: {
              status: event.status || 'running',
              message: event.message,
              completedChunks: event.completed_chunks,
              totalChunks: event.total_chunks
            }
          }))
        } else if (event.type === 'error') {
          streamError = event.detail || 'Document ingestion failed.'
          if (event.stage) {
            setProgress((current) => ({
              ...current,
              [event.stage!]: { ...current[event.stage!], status: 'error', message: streamError }
            }))
          }
        } else if (event.type === 'result') {
          result = event.data
        }
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        lines.filter((line) => line.trim()).forEach((line) => applyEvent(JSON.parse(line)))
      }
      if (buffer.trim()) applyEvent(JSON.parse(buffer))
      if (streamError) throw new Error(streamError)
      if (!result) throw new Error('Ingestion ended without a result.')

      setMessage(`Ingested ${result.document_name} into ${result.squad_name} (${result.systems.join(', ')}): ${result.chunks_ingested} chunk(s) using ${result.embedding_model}.`)
      await loadDocuments(squad)
      setFile(null)
      if (inputRef.current) inputRef.current.value = ''
    } catch (err: any) {
      const detail = err instanceof Error ? err.message : err?.response?.data?.detail || 'Document ingestion failed.'
      setError(detail)
      setProgress((current) => {
        const activeStage = INGESTION_STAGES.find((stage) => current[stage.key].status === 'running')?.key
        return activeStage
          ? { ...current, [activeStage]: { ...current[activeStage], status: 'error', message: detail } }
          : current
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5">
      <div className="rounded-[20px] border border-app bg-app-surface p-6 shadow-app-card">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
          <h1 className="text-xl font-bold text-app-primary">Squad Knowledge Base Ingestion</h1>
          <p className="mt-1 text-sm text-app-secondary">
            Ingest requirements and test cases into your squad's knowledge base.
          </p>
          </div>
          <div className="relative flex flex-shrink-0">
            <button
              type="button"
              onClick={() => { setAddSquadOpen((open) => !open); setError(''); setMessage('') }}
              aria-expanded={addSquadOpen}
              className="inline-flex items-center gap-2 rounded-[12px] border border-app-brand-600 bg-white px-3 py-2 text-[13px] font-semibold text-app-brand-700 hover:bg-app-brand-50"
            >
              {addSquadOpen ? <HiOutlineXMark className="h-4 w-4" /> : <HiOutlinePlus className="h-4 w-4" />}
              {addSquadOpen ? 'Close' : 'Add squad'}
            </button>
            {addSquadOpen && (
              <form
                className="absolute right-0 top-full z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-[14px] border border-app-brand-100 bg-white p-4 shadow-lg"
                onSubmit={(event) => { event.preventDefault(); void addSquad() }}
              >
                <label htmlFor="new-squad-name" className="mb-2 block text-[10px] font-bold uppercase tracking-[0.16em] text-app-secondary">
                  New squad name
                </label>
                <div className="flex gap-2">
                  <input
                    id="new-squad-name"
                    value={newSquadName}
                    onChange={(event) => setNewSquadName(event.target.value)}
                    maxLength={80}
                    autoFocus
                    placeholder="e.g. Customer Experience"
                    disabled={addingSquad}
                    className="min-w-0 flex-1 rounded-[10px] border border-app bg-white px-3 py-2 text-sm text-app-primary outline-none focus:border-app-brand-600 focus:ring-2 focus:ring-app-brand-100"
                  />
                  <button
                    type="submit"
                    disabled={!newSquadName.trim() || addingSquad}
                    className="rounded-[10px] bg-app-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-app-brand-800 disabled:cursor-not-allowed disabled:bg-gray-300"
                  >
                    {addingSquad ? 'Adding...' : 'Add'}
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-app-secondary">Up to 80 characters. Squad names are shared and saved on the server.</p>
              </form>
            )}
          </div>
        </div>

        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)]">
          <div>
            <div className="mb-5">
              <label className="mb-2 block text-[10px] font-bold uppercase tracking-[0.16em] text-app-secondary">
                Squad Knowledge Base
              </label>
              <select
                value={squad}
                disabled={squadsLoading || loading}
                onChange={(event) => handleSquadChange(event.target.value)}
                className="w-full rounded-[12px] border border-app bg-white px-3 py-2.5 text-sm text-app-primary outline-none focus:border-app-brand-600 focus:ring-2 focus:ring-app-brand-100"
              >
                <option value="">{squadsLoading ? 'Loading squads...' : 'Select'}</option>
                {squads.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </div>

            <div className="mb-5">
              <label htmlFor="squad-systems" className="mb-2 block text-[10px] font-bold uppercase tracking-[0.16em] text-app-secondary">
                Systems for this ingestion <span className="text-red-600">*</span>
              </label>
              {systems.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {systems.map((system) => (
                    <span key={system} className="inline-flex items-center gap-1.5 rounded-full border border-app-brand-100 bg-app-brand-50 px-2.5 py-1 text-xs font-semibold text-app-brand-800">
                      {system}
                      <button
                        type="button"
                        onClick={() => setSystems((current) => current.filter((value) => value !== system))}
                        disabled={loading}
                        aria-label={`Remove ${system}`}
                        className="rounded-full text-app-brand-700 hover:text-red-700 disabled:opacity-50"
                      >
                        <HiOutlineXMark className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <input
                  id="squad-systems"
                  value={systemDraft}
                  onChange={(event) => setSystemDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addSystem()
                    }
                  }}
                  maxLength={100}
                  disabled={!squad || loading}
                  placeholder={squad ? 'Enter a system name' : 'Select a squad first'}
                  className="min-w-0 flex-1 rounded-[10px] border border-app bg-white px-3 py-2 text-sm text-app-primary outline-none focus:border-app-brand-600 focus:ring-2 focus:ring-app-brand-100 disabled:bg-app-surface-muted"
                />
                <button
                  type="button"
                  onClick={addSystem}
                  disabled={!squad || !systemDraft.trim() || loading || systems.length >= 50}
                  className="inline-flex items-center gap-1.5 rounded-[10px] border border-app-brand-600 px-3 py-2 text-sm font-semibold text-app-brand-700 hover:bg-app-brand-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <HiOutlinePlus className="h-4 w-4" />
                  Add
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-app-secondary">
                Stored as metadata for this upload. Device Squad starts with BCRM, B2B and SMB; retrieval still uses the squad only.
              </p>
            </div>

            <input
              ref={inputRef}
              type="file"
              accept=".docx,.pdf,.xlsx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(event) => chooseFile(event.target.files?.[0])}
            />
            <button
              type="button"
              className={`w-full rounded-[18px] border-2 border-dashed p-10 text-center transition ${dragging ? 'border-app-brand-700 bg-app-brand-50' : 'border-app-brand-200 bg-app-brand-50/35 hover:bg-app-brand-50/60'}`}
              onClick={() => inputRef.current?.click()}
              onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files?.[0]) }}
            >
              <div className="text-base font-semibold text-app-brand-800">
                {file ? file.name : 'Click to upload or drag and drop a document'}
              </div>
              <div className="mt-2 text-sm text-app-secondary">DOCX, PDF or XLSX · Maximum 25 MB</div>
            </button>

            {(loading || Object.values(progress).some((stage) => stage.status !== 'pending')) && (
              <div className="mt-5 space-y-2 rounded-[14px] border border-app-brand-100 bg-app-brand-50/40 p-3" aria-live="polite">
                {INGESTION_STAGES.map((stage) => {
                  const state = progress[stage.key]
                  return (
                    <div key={stage.key} className="flex items-start gap-2.5 rounded-[10px] bg-white/70 px-3 py-2">
                      {state.status === 'completed' ? (
                        <HiOutlineCheckCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-600" />
                      ) : state.status === 'running' ? (
                        <span className="mt-0.5 inline-block h-4 w-4 flex-shrink-0 animate-spin rounded-full border-2 border-app-brand-700 border-t-transparent" />
                      ) : state.status === 'error' ? (
                        <HiOutlineXMark className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-700" />
                      ) : (
                        <HiOutlineClock className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-300" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-app-primary">{stage.label}</div>
                        {state.message && <div className="mt-0.5 text-[11px] text-app-secondary">{state.message}</div>}
                        {stage.key === 'store' && state.totalChunks && state.status === 'running' && (
                          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-app-brand-100">
                            <div
                              className="h-full rounded-full bg-app-brand-700 transition-all"
                              style={{ width: `${Math.min(100, ((state.completedChunks || 0) / state.totalChunks) * 100)}%` }}
                            />
                          </div>
                        )}
                      </div>
                      <span className="text-[10px] font-semibold uppercase text-app-muted">{state.status}</span>
                    </div>
                  )
                })}
              </div>
            )}

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <div className="min-h-5 text-sm">
                {message && <span className="text-green-700">{message}</span>}
                {error && <span className="text-red-700">{error}</span>}
              </div>
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={resetForm}
                  disabled={loading || addingSquad}
                  title="Reset this upload form"
                  className="inline-flex items-center gap-2 rounded-[12px] border border-app px-3 py-2.5 text-[13px] font-semibold text-app-secondary hover:bg-app-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <HiOutlineArrowPath className="h-4 w-4" />
                  Reset
                </button>
                <button
                  type="button"
                  onClick={ingest}
                  disabled={!file || !squad || systems.length === 0 || loading}
                  className={`rounded-[12px] px-4 py-2.5 text-[13px] font-semibold transition ${file && squad && systems.length > 0 && !loading ? 'bg-app-brand-700 text-white hover:bg-app-brand-800' : 'cursor-not-allowed bg-gray-300 text-gray-500'}`}
                >
                  {loading ? 'Ingesting...' : 'Ingest into Squad Knowledge Base'}
                </button>
              </div>
            </div>
          </div>

          <aside className="rounded-[16px] border border-app bg-white p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-bold text-app-primary">{squad || 'Squad'} Documents</div>
                <div className="text-xs text-app-secondary">{documentsLoading ? 'Loading...' : `${documents.length} document${documents.length === 1 ? '' : 's'}`}</div>
              </div>
              <div className="rounded-full bg-app-brand-50 px-2.5 py-1 text-xs font-bold text-app-brand-800">{documents.length}</div>
            </div>
            <div className="max-h-[320px] overflow-y-auto rounded-[12px] border border-app-surface-muted bg-app-surface-muted/40 p-2">
              {!squad ? (
                <div className="p-3 text-sm text-app-secondary">Select a squad to view documents.</div>
              ) : documentsLoading ? (
                <div className="p-3 text-sm text-app-secondary">Loading documents...</div>
              ) : documents.length === 0 ? (
                <div className="p-3 text-sm text-app-secondary">No records found for this squad.</div>
              ) : (
                <ol className="space-y-1">
                  {documents.map((document, index) => (
                    <li key={`${document}-${index}`} className="rounded-[9px] bg-white px-3 py-2 text-sm text-app-primary">
                      <span className="mr-2 text-xs font-semibold text-app-muted">{index + 1}.</span>{document}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

export default SquadKnowledgeBaseIngestion
