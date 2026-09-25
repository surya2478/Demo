import React from 'react'

// --- Streaming table parsing -------------------------------------------------
//
// The model streams ONE markdown table (services/generation/testcases.py). A
// row is only trusted once its line has ended: the last line of a partial
// stream is usually a row cut mid-cell, and parsing it would flash a broken
// case into the grid.

export interface StreamedCase {
  id: string
  title: string
  type: CaseType
  priority: string
  steps: number
}

export type CaseType = 'Positive' | 'Negative' | 'Boundary'

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())

const isDivider = (cells: string[]) => cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell))

// The table has no Type column -- adding one would change the contract the
// Automation module parses -- so the type is read off the description. It is
// a hint for the coverage bar, labelled as such, not a stored field.
export const inferCaseType = (text: string): CaseType => {
  const t = text.toLowerCase()
  if (/\b(boundary|maximum|minimum|max(imum)? length|min(imum)? length|limit|exceed(s|ed|ing)?|upper|lower bound)\b/.test(t)) return 'Boundary'
  if (/\b(invalid|not|cannot|can't|unable|fail(s|ed|ure)?|error|reject(s|ed)?|block(s|ed)?|without|missing|wrong|expired|unauthori[sz]ed|den(y|ied)|incorrect|empty|blank)\b/.test(t)) return 'Negative'
  return 'Positive'
}

const countSteps = (steps: string) => {
  const numbered = steps.match(/(?:^|\s)\d+[.)]\s/g)
  if (numbered && numbered.length) return numbered.length
  return steps.trim() ? 1 : 0
}

/**
 * The output with the given cases' rows taken out of its table(s). Everything
 * else -- headings, notes, other tables -- is left as it was, so the Full
 * table view, Use for Test Data and AI Checks all see the same cases.
 */
export const removeCasesFromMarkdown = (text: string, ids: Set<string>): string => {
  if (!ids.size) return text
  let idIndex = -1
  return (text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('|')) {
        idIndex = -1 // a table ended; the next one brings its own header
        return true
      }
      const cells = splitRow(trimmed)
      if (isDivider(cells)) return true
      if (idIndex < 0) {
        idIndex = cells.findIndex((cell) => /test case id/i.test(cell))
        return true
      }
      return !ids.has(cells[idIndex] ?? '')
    })
    .join('\n')
}

export interface StreamParse {
  headerSeen: boolean
  cases: StreamedCase[]
}

export const parseStreamingCases = (text: string, complete: boolean): StreamParse => {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n')
  // Drop the unfinished last line while the stream is still open.
  if (!complete) lines.pop()

  let header: string[] | null = null
  const cases: StreamedCase[] = []
  for (const line of lines) {
    // A finished row ends with its closing pipe. One that does not was cut
    // off -- by a stream still running, or by Stop -- and is not a case yet.
    if (!line.trim().startsWith('|') || !line.trim().endsWith('|')) continue
    const cells = splitRow(line)
    if (isDivider(cells)) continue
    if (!header) {
      if (cells.some((cell) => /test case id/i.test(cell))) header = cells.map((cell) => cell.toLowerCase())
      continue
    }
    const col = (name: string) => {
      const index = header!.findIndex((h) => h.includes(name))
      return index >= 0 ? cells[index] || '' : ''
    }
    const id = col('test case id')
    if (!id) continue
    const title = col('description') || col('title') || col('category')
    cases.push({
      id,
      title,
      type: inferCaseType(`${title} ${col('expected')}`),
      priority: col('priority') || '—',
      steps: countSteps(col('steps'))
    })
  }
  return { headerSeen: header !== null, cases }
}

// --- Inputs folded to one line -------------------------------------------------

const Chip: React.FC<{ tone?: 'neutral' | 'brand'; children: React.ReactNode; title?: string }> = ({ tone = 'neutral', children, title }) => (
  <span
    title={title}
    className={`inline-flex h-6 max-w-[320px] items-center gap-1.5 truncate whitespace-nowrap rounded-full px-[9px] text-[11.5px] font-semibold ${
      tone === 'brand' ? 'bg-[#FFF5F5] text-[#7A0B0D]' : 'bg-[#F4F5F7] text-[#1F2937]'
    }`}
  >
    {children}
  </span>
)

export const InputSummary: React.FC<{
  source: string
  knowledgeBase: string
  environment?: string
  focus?: string
  project?: string
  onShowInputs: () => void
}> = ({ source, knowledgeBase, environment, focus, project, onShowInputs }) => (
  <section className="flex items-center gap-3 rounded-[16px] border border-[#E8EAEE] bg-white px-[18px] py-3 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)]">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8" aria-hidden><path d="M12 3l1.8 4.9L19 9.7l-4.2 3.1 1.5 5.2L12 15l-4.3 3 1.5-5.2L5 9.7l5.2-1.8z" /></svg>
    </div>
    <div className="flex-shrink-0 whitespace-nowrap text-[14px] font-bold text-[#1F2937]">Generate Test Cases</div>
    <div className="ml-2 flex min-w-0 gap-1.5 overflow-hidden">
      {project && <Chip tone="brand" title={project}>{project}</Chip>}
      <Chip title={source}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2" className="flex-shrink-0" aria-hidden><path d="M7 3h7l5 5v13H7z" /></svg>
        <span className="truncate">{source}</span>
      </Chip>
      <Chip tone="brand">KB · {knowledgeBase}</Chip>
      {environment && <Chip>{environment}</Chip>}
      {focus && <Chip>{focus}</Chip>}
    </div>
    <div className="ml-auto flex flex-shrink-0 items-center gap-2">
      <button
        type="button"
        onClick={onShowInputs}
        data-audit-name="Show inputs"
        className="box-border flex h-[30px] items-center gap-1.5 rounded-[10px] border border-[#E8EAEE] bg-white px-2.5 text-[12.5px] font-semibold text-[#1F2937] transition hover:border-[#F6D4D5]"
      >
        Show inputs
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
      </button>
    </div>
  </section>
)

// --- Live progress (replaces the pop-up) -----------------------------------

export const GENERATION_STAGES = [
  'Reading requirements and inputs',
  'Understanding business scope',
  'Identifying scenarios',
  'Generating test cases',
  'Validating coverage and structure',
  'Preparing generated artifacts'
] as const

const formatElapsed = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

export const ProgressPanel: React.FC<{ stagesDone: number; written: number; elapsedMs: number }> = ({ stagesDone, written, elapsedMs }) => {
  const total = GENERATION_STAGES.length
  const circumference = 157
  const offset = circumference * (1 - Math.min(stagesDone, total) / total)
  return (
    <div className="mx-[22px] mt-3.5 grid grid-cols-1 items-center gap-[22px] rounded-[16px] border border-[#F6D4D5] bg-[linear-gradient(90deg,#FFF8F8,#FFFFFF_70%)] px-[18px] py-3.5 lg:grid-cols-[250px_minmax(0,1fr)]">
      <div className="flex items-center gap-3.5">
        <div className="relative h-[60px] w-[60px] flex-shrink-0">
          <svg width="60" height="60" viewBox="0 0 60 60" className="-rotate-90" aria-hidden>
            <circle cx="30" cy="30" r="25" fill="none" stroke="#F6D4D5" strokeWidth="5" />
            <circle
              cx="30" cy="30" r="25" fill="none" stroke="#B71920" strokeWidth="5" strokeLinecap="round"
              strokeDasharray={circumference} strokeDashoffset={offset}
              style={{ transition: 'stroke-dashoffset 400ms ease' }}
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center text-[13px] font-extrabold text-[#1F2937]">
            {Math.min(stagesDone, total)}/{total}
          </div>
        </div>
        <div>
          <div className="text-[14px] font-bold text-[#1F2937]">Generating test cases</div>
          <div className="mt-0.5 text-[12px] text-[#6B7280]">
            <strong className="text-[#1F2937]">{written} written</strong> so far · {formatElapsed(elapsedMs)} elapsed
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-x-[18px] gap-y-2.5 sm:grid-cols-2 xl:grid-cols-3">
        {GENERATION_STAGES.map((stage, index) => {
          const state = index < stagesDone ? 'done' : index === stagesDone ? 'now' : 'next'
          return (
            <div
              key={stage}
              className={`flex items-center gap-2 text-[12.5px] font-semibold ${
                state === 'done' ? 'text-[#1F2937]' : state === 'now' ? 'text-[#B71920]' : 'text-[#9CA3AF]'
              }`}
            >
              {state === 'done' ? (
                <span className="flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full bg-[#EAF7EF]">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#136B34" strokeWidth="3.5" aria-hidden><path d="M5 12l5 5 9-10" /></svg>
                </span>
              ) : state === 'now' ? (
                <span className="box-border h-[18px] w-[18px] flex-shrink-0 animate-spin rounded-full border-[2.5px] border-[#F6D4D5] border-t-[#B71920]" />
              ) : (
                <span className="box-border h-[18px] w-[18px] flex-shrink-0 rounded-full border-2 border-[#D6D9DF]" />
              )}
              {stage}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// --- The grid cases stream into -------------------------------------------

const TYPE_TONE: Record<CaseType, string> = {
  Positive: 'bg-[#EAF7EF] text-[#136B34]',
  Negative: 'bg-[#FEEBEC] text-[#A3231C]',
  Boundary: 'bg-[#FEF3E2] text-[#9A5B00]'
}

const ROW = 'grid grid-cols-[88px_minmax(0,1fr)_130px_90px_64px] items-center gap-3 border-b border-[#F1F2F4] px-4'
const ROW_SELECT = 'grid grid-cols-[22px_88px_minmax(0,1fr)_130px_90px_64px] items-center gap-3 border-b border-[#F1F2F4] px-4'

interface CaseSelection {
  selected: Set<string>
  onToggle: (id: string) => void
  onToggleAll: (ids: string[], on: boolean) => void
}

export const CaseGrid: React.FC<{
  cases: StreamedCase[]
  streaming: boolean
  footerNote?: string
  /** Checkboxes, once the cases are all written. */
  selection?: CaseSelection
}> = ({ cases, streaming, footerNote, selection }) => {
  const row = selection && !streaming ? ROW_SELECT : ROW
  const ids = cases.map((item) => item.id)
  const allOn = Boolean(selection) && ids.length > 0 && ids.every((id) => selection!.selected.has(id))
  const counts = cases.reduce<Record<CaseType, number>>(
    (acc, item) => ({ ...acc, [item.type]: acc[item.type] + 1 }),
    { Positive: 0, Negative: 0, Boundary: 0 }
  )
  const total = cases.length || 1
  const nextId = `TC-${String(cases.length + 1).padStart(3, '0')}`

  return (
    <div className="mx-[22px] mb-4 mt-3.5 overflow-hidden rounded-[16px] border border-[#E8EAEE]">
      <div className="max-h-[440px] overflow-y-auto">
        <div className={`${row} sticky top-0 z-10 h-9 border-b-[#F6D4D5] bg-[#F4F5F7] text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1F2937]`}>
          {row === ROW_SELECT && (
            <input
              type="checkbox"
              aria-label="Select all test cases"
              title="Select all"
              checked={allOn}
              disabled={ids.length === 0}
              onChange={() => selection!.onToggleAll(ids, !allOn)}
              className="h-4 w-4 accent-[#B71920]"
            />
          )}
          <span>TC ID</span><span>Title</span><span title="Inferred from each case's description">Type</span><span>Priority</span><span>Steps</span>
        </div>
        {cases.map((item) => (
          <div key={item.id} className={`${row} h-11 text-[13px] text-[#1F2937] ${row === ROW_SELECT && selection!.selected.has(item.id) ? 'bg-[#FFF8F8]' : ''}`}>
            {row === ROW_SELECT && (
              <input
                type="checkbox"
                aria-label={`Select ${item.id}`}
                checked={selection!.selected.has(item.id)}
                onChange={() => selection!.onToggle(item.id)}
                className="h-4 w-4 accent-[#B71920]"
              />
            )}
            <span className="font-semibold">{item.id}</span>
            <span className="truncate" title={item.title}>{item.title}</span>
            <span>
              <span className={`inline-flex h-6 items-center rounded-full px-[9px] text-[11.5px] font-semibold ${TYPE_TONE[item.type]}`}>{item.type}</span>
            </span>
            <span>{item.priority}</span>
            <span>{item.steps}</span>
          </div>
        ))}
        {streaming && (
          <div className={`${ROW} h-11 bg-[#FFF8F8] text-[13px]`} aria-label="Writing the next test case">
            <span className="font-semibold text-[#B71920]">{nextId}</span>
            <span className="flex flex-col gap-1.5"><span className="tc-shim w-[70%]" /><span className="tc-shim w-[45%]" /></span>
            <span><span className="tc-shim block w-[70px]" /></span>
            <span><span className="tc-shim block w-10" /></span>
            <span><span className="tc-shim block w-5" /></span>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[12px] text-[#6B7280]">
        <span>{streaming ? 'Coverage so far' : 'Coverage'}</span>
        <span className="flex h-1.5 w-40 overflow-hidden rounded-full bg-[#F4F5F7]" title="Types are inferred from each case's description">
          <span style={{ width: `${(counts.Positive / total) * 100}%` }} className="bg-[#15803D]" />
          <span style={{ width: `${(counts.Negative / total) * 100}%` }} className="bg-[#DC2626]" />
          <span style={{ width: `${(counts.Boundary / total) * 100}%` }} className="bg-[#D97706]" />
        </span>
        <span>
          {counts.Positive} Positive · {counts.Negative} Negative{counts.Boundary ? ` · ${counts.Boundary} Boundary` : ''}
        </span>
        {footerNote && <span className="ml-auto">{footerNote}</span>}
      </div>
    </div>
  )
}
