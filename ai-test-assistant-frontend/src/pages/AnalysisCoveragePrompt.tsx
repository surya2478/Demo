import React, { useEffect, useState } from 'react'
import api from '../services/api'
import { usePageHeader } from '../components/layout/PageHeaderContext'

type PromptKey = 'decompose' | 'map' | 'recommend'
type PromptSet = Record<PromptKey, string>

interface PromptsResponse {
  prompts: PromptSet
  defaults: PromptSet
}

const MIN_LENGTH = 20
const MAX_LENGTH = 20000

const PROMPT_SECTIONS: { key: PromptKey; title: string; description: string; outputNote: string }[] = [
  {
    key: 'decompose',
    title: '1. Decompose Requirements',
    description: 'Splits the uploaded SDD/BRD/Figma text into atomic requirements and tags which test categories apply.',
    outputNote: 'Must still ask for JSON: {"requirements": [{"requirement_id", "requirement_text", "applicable_categories"}]}'
  },
  {
    key: 'map',
    title: '2. Map Coverage',
    description: 'Decides which applicable categories the existing test cases already cover. This drives the coverage %.',
    outputNote: 'Must still ask for JSON: {"coverage": [{"requirement_id", "covered_categories", "matched_test_case_ids", "gap_reason"}]}'
  },
  {
    key: 'recommend',
    title: '3. Recommend Test Cases',
    description: 'Writes one new test case per uncovered requirement/category gap.',
    outputNote: 'Must still ask for ONE markdown table, one row per gap, no text around it.'
  }
]

const EMPTY: PromptSet = { decompose: '', map: '', recommend: '' }

const AnalysisCoveragePrompt: React.FC = () => {
  usePageHeader({
    title: 'Coverage Analysis Prompts',
    subtitle: 'System prompts used by the three LLM calls in Coverage Analysis.'
  })

  const [prompts, setPrompts] = useState<PromptSet>(EMPTY)
  const [saved, setSaved] = useState<PromptSet>(EMPTY)
  const [defaults, setDefaults] = useState<PromptSet>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const applyResponse = (data: PromptsResponse) => {
    setPrompts(data.prompts)
    setSaved(data.prompts)
    setDefaults(data.defaults)
  }

  useEffect(() => {
    const load = async () => {
      try {
        const response = await api.get<PromptsResponse>('/coverage/prompts')
        applyResponse(response.data)
      } catch {
        setError('Unable to load the coverage analysis prompts.')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const isDirty = (Object.keys(EMPTY) as PromptKey[]).some((key) => prompts[key] !== saved[key])
  const invalidKeys = (Object.keys(EMPTY) as PromptKey[]).filter((key) => prompts[key].trim().length < MIN_LENGTH)
  const canSave = !loading && !saving && isDirty && invalidKeys.length === 0

  const updatePrompt = (key: PromptKey, value: string) => {
    setPrompts((prev) => ({ ...prev, [key]: value }))
    setMessage('')
  }

  const handleSave = async () => {
    setSaving(true)
    setMessage('')
    setError('')
    try {
      const response = await api.put<PromptsResponse>('/coverage/prompts', prompts)
      applyResponse(response.data)
      setMessage('Prompts saved. The next coverage analysis will use them.')
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : 'Unable to save the coverage analysis prompts.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="rounded-[14px] border border-slate-200 bg-white p-5 text-sm text-slate-500">Loading prompts...</div>
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="rounded-[14px] border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
        The backend parses each call's reply, so keep the requested output format described under each prompt. Changing it breaks
        the analysis. Saving requires admin access and applies to every user's next analysis.
      </div>

      {PROMPT_SECTIONS.map((section) => {
        const value = prompts[section.key]
        const isDefault = value.trim() === defaults[section.key].trim()
        const isChanged = value !== saved[section.key]
        return (
          <section key={section.key} className="rounded-[14px] border border-slate-200 bg-white p-5">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-[0.14em] text-red-800">
                  {section.title}
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold normal-case tracking-normal ${isDefault ? 'bg-slate-100 text-slate-500' : 'bg-red-50 text-red-800'}`}>
                    {isDefault ? 'Default' : 'Customized'}
                  </span>
                  {isChanged && <span className="text-[10px] font-semibold normal-case tracking-normal text-amber-700">Unsaved changes</span>}
                </h2>
                <p className="mt-1 text-xs text-slate-500">{section.description}</p>
              </div>
              <button
                type="button"
                onClick={() => updatePrompt(section.key, defaults[section.key])}
                disabled={isDefault || saving}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-red-800 hover:text-red-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Restore default
              </button>
            </div>
            <textarea
              value={value}
              onChange={(event) => updatePrompt(section.key, event.target.value)}
              maxLength={MAX_LENGTH}
              aria-label={`${section.title} system prompt`}
              className="min-h-[260px] w-full resize-y rounded-[10px] border border-slate-300 bg-white px-3 py-2.5 font-mono text-xs leading-5 text-slate-800 outline-none transition focus:border-red-800 focus:ring-2 focus:ring-red-100"
            />
            <div className="mt-1.5 flex flex-wrap justify-between gap-2 text-[11px]">
              <span className="text-slate-500">{section.outputNote}</span>
              <span className={value.trim().length < MIN_LENGTH ? 'font-semibold text-red-700' : 'text-slate-400'}>
                {value.length.toLocaleString()} / {MAX_LENGTH.toLocaleString()} characters
              </span>
            </div>
          </section>
        )
      })}

      <div className="flex items-center justify-between gap-3">
        <div className="min-h-5 text-sm">
          {message && <span className="text-green-700">{message}</span>}
          {error && <span className="text-red-700">{error}</span>}
          {!error && invalidKeys.length > 0 && <span className="text-red-700">Each prompt needs at least {MIN_LENGTH} characters.</span>}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPrompts(saved)}
            disabled={!isDirty || saving}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 transition hover:border-red-800 hover:text-red-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Discard changes
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="rounded-md bg-red-800 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Prompts'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default AnalysisCoveragePrompt
