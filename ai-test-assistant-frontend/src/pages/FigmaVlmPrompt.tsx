import React, { useEffect, useState } from 'react'
import api from '../services/api'
import ResetButton from '../components/ResetButton'

const FigmaVlmPrompt: React.FC = () => {
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const loadPrompt = async () => {
      try {
        const response = await api.get<{ prompt: string; model: string }>('/generate/figma/vlm-prompt')
        setPrompt(response.data.prompt)
        setModel(response.data.model)
      } catch (err) {
        setError('Unable to load the Figma extraction prompt.')
      } finally {
        setLoading(false)
      }
    }
    loadPrompt()
  }, [])

  const savePrompt = async () => {
    setSaving(true)
    setMessage('')
    setError('')
    try {
      const response = await api.put<{ prompt: string; model: string }>('/generate/figma/vlm-prompt', { prompt })
      setPrompt(response.data.prompt)
      setModel(response.data.model)
      setMessage('Prompt saved. Future Figma PDF extractions will use this prompt.')
    } catch (err) {
      setError('Unable to save the Figma extraction prompt.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="rounded-[20px] border border-app bg-app-surface p-6 shadow-app-card">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-app-primary">Figma PDF VLM Prompt</h1>
            <p className="mt-1 text-sm text-app-secondary">
              This server-side prompt is used exclusively when GPT-5.1 extracts text from uploaded Figma PDFs.
            </p>
          </div>
          <div className="rounded-[12px] border border-app bg-white px-3 py-2 text-right">
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-app-secondary">Vision Model</div>
            <div className="mt-1 text-sm font-semibold text-app-primary">{model || 'Loading...'}</div>
          </div>
        </div>

        {loading ? (
          <div className="rounded-[14px] bg-white p-4 text-sm text-app-secondary">Loading prompt...</div>
        ) : (
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            minLength={20}
            maxLength={20000}
            className="min-h-[360px] w-full resize-y rounded-[16px] border border-app bg-white px-4 py-3 text-sm leading-6 text-app-primary outline-none transition focus:border-app-brand-600 focus:ring-2 focus:ring-app-brand-100"
            aria-label="Figma PDF VLM prompt"
          />
        )}

        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="min-h-5 text-sm">
            {message && <span className="text-green-700">{message}</span>}
            {error && <span className="text-red-700">{error}</span>}
          </div>
          <div className="flex items-center gap-2">
            <ResetButton
              data-audit-name="Reset Figma VLM Prompt"
              onClick={() => window.location.reload()}
              disabled={loading || saving}
              className="rounded-[12px] px-3.5 py-2.5 text-[13px]"
            />
            <button
              type="button"
              onClick={savePrompt}
              disabled={loading || saving || prompt.trim().length < 20}
              className={`rounded-[12px] px-4 py-2.5 text-[13px] font-semibold transition ${
                !loading && !saving && prompt.trim().length >= 20
                  ? 'bg-app-brand-700 text-white hover:bg-app-brand-800'
                  : 'cursor-not-allowed bg-gray-300 text-gray-500'
              }`}
            >
              {saving ? 'Saving...' : 'Save Prompt'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default FigmaVlmPrompt
