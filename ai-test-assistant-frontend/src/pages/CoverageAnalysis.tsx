import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import {
  HiOutlineDocumentText,
  HiOutlineTableCells,
  HiOutlineXMark,
  HiOutlineArrowDownTray,
  HiOutlineCheckCircle,
  HiOutlineXCircle,
  HiOutlineClock,
  HiOutlineChevronDown,
  HiOutlineSparkles
} from 'react-icons/hi2'
import { Link } from 'react-router-dom'
import api from '../services/api'
import { usePageHeader } from '../components/layout/PageHeaderContext'
import { getTimestampedFilename } from '../utils/DynamicFileName-DateTime'

type CategoryKey = 'positive' | 'negative' | 'edge' | 'ui'

interface RequirementBreakdownRow {
  requirement_id: string
  requirement_text: string
  applicable_categories: CategoryKey[]
  covered_categories: CategoryKey[]
  matched_test_case_ids: string[]
  gap_reason: string
}

interface CategoryBreakdown {
  [key: string]: { covered: number; total: number }
}

interface CoverageAnalysisResponse {
  coverage_percentage: number
  total_slots: number
  covered_slots: number
  total_requirements: number
  fully_covered_requirements: number
  partially_covered_requirements: number
  not_covered_requirements: number
  requirement_breakdown: RequirementBreakdownRow[]
  category_breakdown: CategoryBreakdown
  existing_test_case_count: number
  recommended_test_cases_markdown: string
}

const CATEGORY_LABELS: Record<string, string> = {
  positive: 'Positive',
  negative: 'Negative',
  edge: 'Edge',
  ui: 'UI'
}

type StageKey = 'extract' | 'decompose' | 'map' | 'compute' | 'recommend'
type StageStatus = 'pending' | 'running' | 'completed' | 'error'

interface StageState {
  status: StageStatus
  data?: any
  error?: string
  startedAt?: number
  finishedAt?: number
}

type StageMap = Record<StageKey, StageState>

interface StreamEvent {
  type: 'stage' | 'result' | 'error'
  stage?: StageKey
  status?: 'running' | 'completed'
  data?: any
  detail?: string
}

const STAGES: { key: StageKey; title: string; description: string; usesLlm: boolean }[] = [
  { key: 'extract', title: 'Extract Documents', description: 'Read text from requirement documents and rows from the test case sheet.', usesLlm: false },
  { key: 'decompose', title: 'Decompose Requirements', description: 'Split requirements into atomic, testable items and tag applicable test categories.', usesLlm: true },
  { key: 'map', title: 'Map Coverage', description: 'Match each requirement/category against the existing test cases.', usesLlm: true },
  { key: 'compute', title: 'Compute Coverage %', description: 'Calculate coverage from covered vs. applicable requirement/category slots.', usesLlm: false },
  { key: 'recommend', title: 'Recommend Test Cases', description: 'Generate new test cases for each uncovered gap.', usesLlm: true }
]

const initialStages = (): StageMap => ({
  extract: { status: 'pending' },
  decompose: { status: 'pending' },
  map: { status: 'pending' },
  compute: { status: 'pending' },
  recommend: { status: 'pending' }
})

const formatDuration = (stage: StageState, now: number) => {
  if (!stage.startedAt) return ''
  const ms = (stage.finishedAt ?? now) - stage.startedAt
  return `${(ms / 1000).toFixed(1)}s`
}

const getAuthToken = () =>
  localStorage.getItem('authToken') || localStorage.getItem('api_token') || sessionStorage.getItem('authToken') || ''

const ACCEPTED_REQUIREMENT_TYPES = '.pdf,.docx,.txt,.md'
const ACCEPTED_TESTCASE_TYPES = '.xlsx,.csv'

// Parses the single markdown table the backend returns for recommended test
// cases into row objects, the same shape a spreadsheet export expects.
const parseMarkdownTable = (content: string): Record<string, string>[] => {
  const raw = (content || '').replace(/\r/g, '').trim()
  if (!raw || !raw.includes('|')) return []

  const lines = raw.split('\n').filter((line) => line.includes('|'))
  const rows = lines.filter((line) => !/^\s*\|?\s*[:-][-:|\s]*\|?\s*$/.test(line.trim()))
  if (rows.length < 2) return []

  const headers = rows[0].split('|').map((v) => v.trim()).filter(Boolean)
  return rows
    .slice(1)
    .map((line) => {
      const cells = line.split('|').map((v) => v.trim()).filter((_, i, arr) => !(i === 0 && arr[0] === '') && !(i === arr.length - 1 && arr[arr.length - 1] === ''))
      const row: Record<string, string> = {}
      headers.forEach((header, idx) => {
        row[header] = cells[idx] ?? ''
      })
      return row
    })
    .filter((row) => Object.values(row).some((v) => v && v.trim()))
}

const coverageBarColor = (pct: number) => {
  if (pct >= 80) return '#16a34a'
  if (pct >= 50) return '#d97706'
  return '#dc2626'
}

const categoryList = (categories: string[] = []) =>
  categories.map((c) => CATEGORY_LABELS[c] || c).join(', ') || '—'

const StageOutput: React.FC<{ stageKey: StageKey; data: any }> = ({ stageKey, data }) => {
  if (!data) return null

  if (stageKey === 'extract') {
    return (
      <div className="space-y-2 text-xs text-slate-600">
        <ul className="space-y-1">
          {(data.requirement_documents || []).map((doc: { filename: string; characters: number }) => (
            <li key={doc.filename}>
              <strong>{doc.filename}</strong> — {doc.characters.toLocaleString()} characters extracted
            </li>
          ))}
        </ul>
        <div>
          Requirement text sent for analysis: <strong>{data.analyzed_characters.toLocaleString()}</strong> of{' '}
          {data.requirements_characters.toLocaleString()} characters
          {data.requirements_truncated && <span className="ml-1 font-semibold text-amber-700">(truncated to fit the model context)</span>}
        </div>
        <div>
          Test cases read: <strong>{data.existing_test_case_count}</strong>
          {data.test_cases_sent_for_mapping < data.existing_test_case_count && (
            <span className="ml-1 font-semibold text-amber-700">(first {data.test_cases_sent_for_mapping} used for mapping)</span>
          )}
        </div>
        {data.test_case_columns?.length > 0 && <div>Columns detected: {data.test_case_columns.join(', ')}</div>}
      </div>
    )
  }

  if (stageKey === 'decompose') {
    const requirements = data.requirements || []
    return (
      <div>
        <div className="mb-2 text-xs text-slate-600"><strong>{requirements.length}</strong> atomic requirements identified</div>
        <StageTable
          headers={['ID', 'Requirement', 'Applicable Categories']}
          rows={requirements.map((r: any) => [r.requirement_id, r.requirement_text, categoryList(r.applicable_categories)])}
        />
      </div>
    )
  }

  if (stageKey === 'map') {
    const items = data.coverage || []
    return (
      <div>
        <div className="mb-2 text-xs text-slate-600"><strong>{items.length}</strong> requirements assessed against existing test cases</div>
        <StageTable
          headers={['ID', 'Covered Categories', 'Matched Test Cases', 'Gap Reason']}
          rows={items.map((c: any) => [c.requirement_id, categoryList(c.covered_categories), (c.matched_test_case_ids || []).join(', ') || '—', c.gap_reason || '—'])}
        />
      </div>
    )
  }

  if (stageKey === 'compute') {
    const gaps = data.gaps || []
    return (
      <div className="space-y-2 text-xs text-slate-600">
        <div>
          Coverage = {data.covered_slots} covered ÷ {data.total_slots} applicable slots ={' '}
          <strong style={{ color: coverageBarColor(data.coverage_percentage) }}>{data.coverage_percentage}%</strong>
        </div>
        <div><strong>{gaps.length}</strong> gap(s) found to close</div>
        {gaps.length > 0 && (
          <StageTable
            headers={['Requirement', 'Missing Category', 'Requirement Text']}
            rows={gaps.map((g: any) => [g.requirement_id, CATEGORY_LABELS[g.category] || g.category, g.requirement_text])}
          />
        )}
      </div>
    )
  }

  const rowCount = parseMarkdownTable(data.recommended_test_cases_markdown).length
  return (
    <div className="text-xs text-slate-600">
      {rowCount > 0 ? <><strong>{rowCount}</strong> new test case(s) recommended — see Recommended New Test Cases below.</> : data.recommended_test_cases_markdown}
    </div>
  )
}

const StageTable: React.FC<{ headers: string[]; rows: string[][] }> = ({ headers, rows }) => (
  <div className="max-h-[280px] overflow-auto rounded-md border border-slate-200">
    <table className="min-w-full border-collapse text-left text-xs text-slate-700">
      <thead className="sticky top-0 bg-slate-50">
        <tr>
          {headers.map((h) => (
            <th key={h} className="border-b border-slate-200 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, idx) => (
          <tr key={idx} className="border-b border-slate-100 align-top">
            {row.map((cell, cIdx) => (
              <td key={cIdx} className={`px-2.5 py-1.5 ${cIdx === 0 ? 'font-semibold' : ''}`}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)

const StageIcon: React.FC<{ status: StageStatus }> = ({ status }) => {
  if (status === 'running') return <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-red-800 border-t-transparent" />
  if (status === 'completed') return <HiOutlineCheckCircle className="h-5 w-5 text-green-600" />
  if (status === 'error') return <HiOutlineXCircle className="h-5 w-5 text-red-700" />
  return <HiOutlineClock className="h-5 w-5 text-slate-300" />
}

const CoverageAnalysis: React.FC = () => {
  usePageHeader({
    title: 'Coverage Analysis',
    subtitle: 'Assess how well existing test cases cover your requirements, and get recommendations to close the gaps.'
  })

  const [requirementFiles, setRequirementFiles] = useState<File[]>([])
  const [testCaseFile, setTestCaseFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')
  const [result, setResult] = useState<CoverageAnalysisResponse | null>(null)
  const [stages, setStages] = useState<StageMap>(initialStages)
  const [expandedStages, setExpandedStages] = useState<Partial<Record<StageKey, boolean>>>({})
  const [now, setNow] = useState(Date.now())
  const requirementFilesInputRef = useRef<HTMLInputElement>(null)
  const testCaseFileInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  // Ticks the live duration of the running stage.
  useEffect(() => {
    if (!loading) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [loading])

  const pipelineStarted = Object.values(stages).some((s) => s.status !== 'pending')
  const recommendationsReady = stages.recommend.status === 'completed'

  const recommendedRows = useMemo(
    () => (result ? parseMarkdownTable(result.recommended_test_cases_markdown) : []),
    [result]
  )

  const handleRequirementFilesChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || [])
    if (selected.length === 0) return
    setRequirementFiles((prev) => [...prev, ...selected])
    setResult(null)
    e.target.value = ''
  }

  const handleTestCaseFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0]
    if (!selected) return
    setTestCaseFile(selected)
    setResult(null)
    e.target.value = ''
  }

  const removeRequirementFile = (index: number) => {
    setRequirementFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const canAnalyze = requirementFiles.length > 0 && !!testCaseFile && !loading
  const canReset = !loading && (requirementFiles.length > 0 || !!testCaseFile || !!result || !!error || pipelineStarted)

  const handleReset = () => {
    setRequirementFiles([])
    setTestCaseFile(null)
    setResult(null)
    setError('')
    setStages(initialStages())
    setExpandedStages({})
    if (requirementFilesInputRef.current) requirementFilesInputRef.current.value = ''
    if (testCaseFileInputRef.current) testCaseFileInputRef.current.value = ''
  }

  const applyEvent = (event: StreamEvent) => {
    const at = Date.now()
    if (event.type === 'stage' && event.stage) {
      const key = event.stage
      setStages((prev) => ({
        ...prev,
        [key]: {
          ...prev[key],
          status: event.status === 'completed' ? 'completed' : 'running',
          startedAt: prev[key].startedAt ?? at,
          finishedAt: event.status === 'completed' ? at : undefined,
          data: event.data ?? prev[key].data
        }
      }))
      if (event.status === 'completed' && key === 'compute') {
        setResult({ ...event.data, recommended_test_cases_markdown: '' })
      }
    } else if (event.type === 'result') {
      setResult(event.data)
    } else if (event.type === 'error') {
      const key = event.stage ?? 'extract'
      setStages((prev) => ({ ...prev, [key]: { ...prev[key], status: 'error', error: event.detail, finishedAt: at } }))
      setError(event.detail || 'Coverage analysis failed.')
    }
  }

  const handleAnalyze = async () => {
    if (!canAnalyze || !testCaseFile) return
    setLoading(true)
    setError('')
    setResult(null)
    setExpandedStages({})
    const startedAt = Date.now()
    setNow(startedAt)
    // Upload and extraction happen server-side before the first streamed event arrives.
    setStages({ ...initialStages(), extract: { status: 'running', startedAt } })

    const controller = new AbortController()
    abortRef.current = controller
    try {
      const formData = new FormData()
      requirementFiles.forEach((file) => formData.append('requirement_files', file))
      formData.append('testcase_file', testCaseFile)

      const baseUrl = String(api.defaults.baseURL || '').replace(/\/$/, '')
      const token = getAuthToken()
      const response = await fetch(`${baseUrl}/coverage/analyze-stream`, {
        method: 'POST',
        body: formData,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal
      })

      if (!response.ok || !response.body) {
        if ([401, 419, 440].includes(response.status)) {
          window.dispatchEvent(new CustomEvent('app:logout', { detail: { status: response.status } }))
        }
        let detail = 'Coverage analysis failed. Please try again.'
        try {
          const body = await response.json()
          if (typeof body?.detail === 'string') detail = body.detail
        } catch {
          // Non-JSON error body; keep the generic message.
        }
        applyEvent({ type: 'error', stage: 'extract', detail })
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        lines.filter((line) => line.trim()).forEach((line) => applyEvent(JSON.parse(line)))
      }
      if (buffer.trim()) applyEvent(JSON.parse(buffer))
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        setError('Coverage analysis failed. Please try again.')
        setStages((prev) => {
          const running = (Object.keys(prev) as StageKey[]).find((k) => prev[k].status === 'running')
          return running ? { ...prev, [running]: { ...prev[running], status: 'error', finishedAt: Date.now() } } : prev
        })
      }
    } finally {
      setLoading(false)
    }
  }

  const handleExportRecommendations = async () => {
    if (!recommendedRows.length) return
    const XLSX = await import('xlsx')
    const worksheet = XLSX.utils.json_to_sheet(recommendedRows)
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Recommended Test Cases')
    XLSX.writeFile(workbook, getTimestampedFilename('recommended-test-cases.xlsx'))
  }

  return (
    <div className="space-y-5">
      {/* Upload section */}
      <section className="rounded-[14px] border border-slate-200 bg-white p-5">
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 className="text-sm font-bold uppercase tracking-[0.14em] text-red-800">Inputs</h2>
          <Link to="/settings/analysis-coverage-prompt" className="text-xs font-semibold text-red-800 hover:underline">
            Edit analysis prompts
          </Link>
        </div>
        <p className="mb-4 text-xs text-slate-500">
          Upload the requirements (SDD, BRD, or Figma export) and the existing test case sheet to assess.
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          {/* Requirements upload */}
          <div className="rounded-[10px] border border-dashed border-slate-300 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700">
              <HiOutlineDocumentText className="h-5 w-5 text-red-800" />
              Requirement Documents (SDD / BRD / Figma)
            </div>
            <input
              ref={requirementFilesInputRef}
              type="file"
              multiple
              accept={ACCEPTED_REQUIREMENT_TYPES}
              onChange={handleRequirementFilesChange}
              className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-red-800 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white hover:file:bg-red-900"
            />
            <p className="mt-1 text-[11px] text-slate-400">Supported: PDF, DOCX, TXT, MD. Multiple files allowed.</p>

            {requirementFiles.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {requirementFiles.map((file, index) => (
                  <li key={`${file.name}-${index}`} className="flex items-center justify-between rounded-md bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">
                    <span className="truncate">{file.name}</span>
                    <button type="button" onClick={() => removeRequirementFile(index)} aria-label="Remove file" className="text-slate-400 hover:text-red-700">
                      <HiOutlineXMark className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Test case sheet upload */}
          <div className="rounded-[10px] border border-dashed border-slate-300 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700">
              <HiOutlineTableCells className="h-5 w-5 text-red-800" />
              Existing Test Cases (Excel / CSV)
            </div>
            <input
              ref={testCaseFileInputRef}
              type="file"
              accept={ACCEPTED_TESTCASE_TYPES}
              onChange={handleTestCaseFileChange}
              className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-red-800 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white hover:file:bg-red-900"
            />
            <p className="mt-1 text-[11px] text-slate-400">Supported: XLSX, CSV. Manually or AI-created test cases both work.</p>

            {testCaseFile && (
              <div className="mt-3 flex items-center justify-between rounded-md bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">
                <span className="truncate">{testCaseFile.name}</span>
                <button type="button" onClick={() => setTestCaseFile(null)} aria-label="Remove file" className="text-slate-400 hover:text-red-700">
                  <HiOutlineXMark className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={handleAnalyze}
            disabled={!canAnalyze}
            className="rounded-md bg-red-800 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Analyzing coverage…' : 'Analyze Coverage'}
          </button>
          <button
            type="button"
            onClick={handleReset}
            disabled={!canReset}
            title="Reset uploaded files and analysis results"
            aria-label="Reset uploaded files and analysis results"
            className="rounded-md bg-red-800 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-900 disabled:cursor-not-allowed disabled:opacity-50"
            // className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 text-slate-600 transition hover:border-red-800 hover:text-red-800 disabled:cursor-not-allowed disabled:opacity-40"
          >Reset
            {/* <HiOutlineArrowPath className="h-4 w-4" /> */}
          </button>
          {error && <span className="text-xs font-medium text-red-700">{error}</span>}
        </div>
      </section>

      {/* Processing pipeline */}
      {pipelineStarted && (
        <section className="rounded-[14px] border border-slate-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-[0.14em] text-red-800">Processing Steps</h2>
          <ol className="space-y-2">
            {STAGES.map((stage, index) => {
              const state = stages[stage.key]
              const expandable = state.status === 'completed' && !!state.data
              const expanded = !!expandedStages[stage.key]
              return (
                <li key={stage.key} className={`rounded-[10px] border p-3 ${state.status === 'running' ? 'border-red-200 bg-red-50/40' : state.status === 'error' ? 'border-red-300 bg-red-50' : 'border-slate-200'}`}>
                  <button
                    type="button"
                    disabled={!expandable}
                    onClick={() => setExpandedStages((prev) => ({ ...prev, [stage.key]: !prev[stage.key] }))}
                    aria-expanded={expanded}
                    className="flex w-full items-start gap-3 text-left disabled:cursor-default"
                  >
                    <StageIcon status={state.status} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
                        <span>{index + 1}. {stage.title}</span>
                        {stage.usesLlm && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
                            <HiOutlineSparkles className="h-3 w-3" /> LLM
                          </span>
                        )}
                        {state.status === 'running' && <span className="text-[11px] font-medium text-red-800">In progress…</span>}
                      </div>
                      <div className="text-[11px] text-slate-500">{stage.description}</div>
                      {state.status === 'error' && state.error && <div className="mt-1 text-xs font-medium text-red-700">{state.error}</div>}
                    </div>
                    <span className="flex-shrink-0 text-[11px] tabular-nums text-slate-400">{formatDuration(state, now)}</span>
                    {expandable && <HiOutlineChevronDown className={`h-4 w-4 flex-shrink-0 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`} />}
                  </button>
                  {expandable && expanded && (
                    <div className="mt-3 border-t border-slate-100 pt-3">
                      <StageOutput stageKey={stage.key} data={state.data} />
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        </section>
      )}

      {/* Results */}
      {result && (
        <>
          <section className="rounded-[14px] border border-slate-200 bg-white p-5">
            <h2 className="mb-3 text-sm font-bold uppercase tracking-[0.14em] text-red-800">Coverage Score</h2>
            <div className="flex flex-col gap-4 md:flex-row md:items-center">
              <div className="flex-shrink-0">
                <div className="text-4xl font-extrabold" style={{ color: coverageBarColor(result.coverage_percentage) }}>
                  {result.coverage_percentage}%
                </div>
                <div className="text-[11px] text-slate-500">
                  {result.covered_slots} of {result.total_slots} requirement/test-type combinations covered
                </div>
              </div>
              <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${result.coverage_percentage}%`, backgroundColor: coverageBarColor(result.coverage_percentage) }}
                />
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
              {(Object.keys(CATEGORY_LABELS) as CategoryKey[]).map((category) => {
                const stats = result.category_breakdown[category] || { covered: 0, total: 0 }
                const pct = stats.total ? Math.round((stats.covered / stats.total) * 100) : 0
                return (
                  <div key={category} className="rounded-[10px] border border-slate-200 p-3 text-center">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500">{CATEGORY_LABELS[category]}</div>
                    <div className="text-lg font-bold text-slate-800">{stats.covered}/{stats.total}</div>
                    <div className="text-[11px] text-slate-400">{pct}% covered</div>
                  </div>
                )
              })}
            </div>

            <div className="mt-4 flex flex-wrap gap-4 text-xs text-slate-600">
              <span>Requirements found: <strong>{result.total_requirements}</strong></span>
              <span>Fully covered: <strong className="text-green-700">{result.fully_covered_requirements}</strong></span>
              <span>Partially covered: <strong className="text-amber-700">{result.partially_covered_requirements}</strong></span>
              <span>Not covered: <strong className="text-red-700">{result.not_covered_requirements}</strong></span>
              <span>Existing test cases read: <strong>{result.existing_test_case_count}</strong></span>
            </div>
          </section>

          <section className="overflow-hidden rounded-[14px] border border-slate-200">
            <div className="border-b border-slate-200 bg-slate-50 px-3 py-2.5">
              <h2 className="text-sm font-bold uppercase tracking-[0.14em] text-slate-700">Requirement Breakdown</h2>
            </div>
            <div className="max-h-[420px] overflow-auto">
              <table className="min-w-full border-collapse text-left text-xs text-slate-700">
                <thead className="sticky top-0 z-10 bg-white">
                  <tr>
                    {['ID', 'Requirement', 'Applicable', 'Covered', 'Matched Test Cases', 'Gap'].map((col) => (
                      <th key={col} className="border-b border-slate-200 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-red-800">{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.requirement_breakdown.map((row) => (
                    <tr key={row.requirement_id} className="border-b border-slate-100 align-top">
                      <td className="px-3 py-2 font-semibold">{row.requirement_id}</td>
                      <td className="px-3 py-2">{row.requirement_text}</td>
                      <td className="px-3 py-2">{row.applicable_categories.map((c) => CATEGORY_LABELS[c] || c).join(', ')}</td>
                      <td className="px-3 py-2">{row.covered_categories.map((c) => CATEGORY_LABELS[c] || c).join(', ') || '—'}</td>
                      <td className="px-3 py-2">{row.matched_test_case_ids.join(', ') || '—'}</td>
                      <td className="px-3 py-2 text-slate-500">{row.gap_reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="overflow-hidden rounded-[14px] border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2.5">
              <h2 className="text-sm font-bold uppercase tracking-[0.14em] text-slate-700">Recommended New Test Cases</h2>
              {recommendedRows.length > 0 && (
                <button
                  type="button"
                  onClick={handleExportRecommendations}
                  className="flex items-center gap-1.5 rounded-md border border-red-800 px-2.5 py-1 text-[11px] font-semibold text-red-800 hover:bg-red-50"
                >
                  <HiOutlineArrowDownTray className="h-4 w-4" />
                  Export to Excel
                </button>
              )}
            </div>
            <div className="max-h-[480px] overflow-auto">
              {!recommendationsReady ? (
                <p className="px-3 py-4 text-xs text-slate-500">
                  {stages.recommend.status === 'error' ? 'Recommendations could not be generated.' : 'Generating recommendations…'}
                </p>
              ) : recommendedRows.length === 0 ? (
                <p className="px-3 py-4 text-xs text-slate-500">
                  {result.recommended_test_cases_markdown || 'No new test cases were recommended.'}
                </p>
              ) : (
                <table className="min-w-full border-collapse text-left text-xs text-slate-700">
                  <thead className="sticky top-0 z-10 bg-white">
                    <tr>
                      {Object.keys(recommendedRows[0]).map((col) => (
                        <th key={col} className="border-b border-slate-200 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-red-800">{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {recommendedRows.map((row, idx) => (
                      <tr key={idx} className="border-b border-slate-100 align-top">
                        {Object.keys(row).map((col) => (
                          <td key={col} className="px-3 py-2">{row[col]}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

export default CoverageAnalysis
