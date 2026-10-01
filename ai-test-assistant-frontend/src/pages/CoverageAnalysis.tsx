import React, { useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { HiOutlineDocumentText, HiOutlineTableCells, HiOutlineXMark, HiOutlineArrowDownTray } from 'react-icons/hi2'
import api, { LONG_REQUEST_MS } from '../services/api'
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
  const requirementFilesInputRef = useRef<HTMLInputElement>(null)
  const testCaseFileInputRef = useRef<HTMLInputElement>(null)
  
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
  const canReset = !loading && (requirementFiles.length > 0 || !!testCaseFile || !!result || !!error)

  const handleReset = () => {
    setRequirementFiles([])
    setTestCaseFile(null)
    setResult(null)
    setError('')
    if (requirementFilesInputRef.current) requirementFilesInputRef.current.value = ''
    if (testCaseFileInputRef.current) testCaseFileInputRef.current.value = ''
  }

  const handleAnalyze = async () => {
    if (!canAnalyze || !testCaseFile) return
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const formData = new FormData()
      requirementFiles.forEach((file) => formData.append('requirement_files', file))
      formData.append('testcase_file', testCaseFile)

      // Three model calls in a row: minutes on the AI service, far past the
      // 30s default, which gave up while the backend was still working.
      const response = await api.post<CoverageAnalysisResponse>('/coverage/analyze', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: LONG_REQUEST_MS
      })
      setResult(response.data)
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : err?.message || 'Coverage analysis failed. Please try again.')
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
        <h2 className="mb-1 text-sm font-bold uppercase tracking-[0.14em] text-red-800">Inputs</h2>
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
           type='button'
           onClick={handleReset}
           disabled={!canReset}
           title="Reset uploaded files and analysis results"
           aria-label='Reset uploaded files and analysis results'
           className='rounded-md bg-red-800 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-900 disabled:cursor-not-allowed disabled:opacity-50'
           >Reset</button>
          {error && <span className="text-xs font-medium text-red-700">{error}</span>}
        </div>
      </section>

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
              {recommendedRows.length === 0 ? (
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
