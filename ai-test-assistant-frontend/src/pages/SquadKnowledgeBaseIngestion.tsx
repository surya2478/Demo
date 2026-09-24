import React, { useRef, useState } from 'react'
import api from '../services/api'

const squads = ['Device Squad'] as const
type Squad = (typeof squads)[number] | ''

const SquadKnowledgeBaseIngestion: React.FC = () => {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [squad, setSquad] = useState<Squad>('')
  const [documents, setDocuments] = useState<string[]>([])
  const [documentsLoading, setDocumentsLoading] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const loadDocuments = async (selectedSquad: Squad) => {
    if (!selectedSquad) {
      setDocuments([])
      return
    }
    setDocumentsLoading(true)
    setError('')
    try {
      const response = await api.get<{ documents: string[] }>(`/generate/squad-knowledge-base/documents/${encodeURIComponent(selectedSquad)}`)
      setDocuments(response.data.documents || [])
    } catch (err: any) {
      setDocuments([])
      setError(err?.response?.data?.detail || 'Unable to load squad documents.')
    } finally {
      setDocumentsLoading(false)
    }
  }

  const handleSquadChange = (selectedSquad: Squad) => {
    setSquad(selectedSquad)
    setMessage('')
    setError('')
    void loadDocuments(selectedSquad)
  }

  const chooseFile = (candidate: File | undefined) => {
    setMessage('')
    setError('')
    if (!candidate) return
    if (!candidate.name.toLowerCase().endsWith('.docx')) {
      setFile(null)
      setError('Only DOCX files are supported.')
      return
    }
    setFile(candidate)
  }

  const ingest = async () => {
    if (!file || !squad || loading) return
    setLoading(true)
    setMessage('')
    setError('')
    try {
      const formData = new FormData()
      formData.append('squad_name', squad)
      formData.append('file', file)
      const response = await api.post<{
        document_name: string
        squad_name: string
        chunks_ingested: number
        embedding_model: string
      }>('/generate/squad-knowledge-base/ingest-docx', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
      setMessage('File ingested successfully.')
      await loadDocuments(squad)
      setFile(null)
      if (inputRef.current) inputRef.current.value = ''
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'DOCX ingestion failed.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5">
      <div className="rounded-[20px] border border-app bg-app-surface p-6 shadow-app-card">
        <div className="mb-6">
          <h1 className="text-xl font-bold text-app-primary">Squad Knowledge Base Ingestion</h1>
          <p className="mt-1 text-sm text-app-secondary">
            Upload a DOCX, select its squad, and create searchable OpenAI embeddings in PostgreSQL.
          </p>
        </div>

        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)]">
          <div>
            <div className="mb-5">
              <label className="mb-2 block text-[10px] font-bold uppercase tracking-[0.16em] text-app-secondary">
                Squad Knowledge Base
              </label>
              <select
                value={squad}
                onChange={(event) => handleSquadChange(event.target.value as Squad)}
                className="w-full rounded-[12px] border border-app bg-white px-3 py-2.5 text-sm text-app-primary outline-none focus:border-app-brand-600 focus:ring-2 focus:ring-app-brand-100"
              >
                <option value="">Select</option>
                {squads.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </div>

            <input
              ref={inputRef}
              type="file"
              accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
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
                {file ? file.name : 'Click to upload or drag and drop a DOCX file'}
              </div>
              <div className="mt-2 text-sm text-app-secondary">DOCX only</div>
            </button>

            {loading && (
              <div className="mt-5 rounded-[14px] border border-app-brand-100 bg-app-brand-50/40 p-3">
                <div className="mb-2 flex items-center justify-between text-xs font-semibold text-app-brand-800">
                  <span>Extracting, embedding, and storing document...</span>
                  <span className="animate-pulse">Working</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-white">
                  <div className="h-full w-1/2 animate-pulse rounded-full bg-app-brand-700" />
                </div>
              </div>
            )}

            <div className="mt-5 flex items-center justify-between gap-3">
              <div className="min-h-5 text-sm">
                {message && <span className="text-green-700">{message}</span>}
                {error && <span className="text-red-700">{error}</span>}
              </div>
              <button
                type="button"
                onClick={ingest}
                disabled={!file || !squad || loading}
                className={`rounded-[12px] px-4 py-2.5 text-[13px] font-semibold transition ${file && squad && !loading ? 'bg-app-brand-700 text-white hover:bg-app-brand-800' : 'cursor-not-allowed bg-gray-300 text-gray-500'}`}
              >
                {loading ? 'Ingesting...' : 'Ingest into Squad Knowledge Base'}
              </button>
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
