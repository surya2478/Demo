import React from 'react'
import type { ElementStatus, JourneyStatus } from '../../services/knowledgeBaseService'

// The Knowledge Base page's visual vocabulary, shared by every stage so a
// status reads the same wherever it appears. Colours follow the AI Checks
// panel: green = in both, amber = needs a decision, grey = not yet, blue =
// only on one side, red = broken.

export const CHIP = 'inline-flex h-[22px] w-fit items-center whitespace-nowrap rounded-full px-[9px] text-[11.5px] font-semibold'

export const TONE = {
  good: 'bg-[#EAF7EF] text-[#136B34]',
  warn: 'bg-[#FFF4E5] text-[#8A5000]',
  idle: 'bg-[#F4F5F7] text-[#4B5563]',
  info: 'bg-[#EEF4FF] text-[#1D4ED8]',
  bad: 'bg-[#FEEBEC] text-[#A3231C]',
  brand: 'bg-[#FFF5F5] text-[#941216]'
} as const

export const ELEMENT_STATUS: Record<ElementStatus, { label: string; tone: keyof typeof TONE }> = {
  MATCH: { label: 'Match', tone: 'good' },
  LABEL_DRIFT: { label: 'Label drift', tone: 'warn' },
  REF_BROKEN: { label: 'Broken ref', tone: 'bad' },
  NOT_CRAWLED: { label: 'Not crawled', tone: 'idle' },
  NOT_IN_DESIGN: { label: 'Not in design', tone: 'info' },
  NO_ELEMENT: { label: 'No element', tone: 'idle' },
  UNRESOLVED: { label: 'Unresolved', tone: 'bad' }
}

export const JOURNEY_STATUS: Record<JourneyStatus, { label: string; tone: keyof typeof TONE; dot: string }> = {
  detailed: { label: 'Detailed', tone: 'good', dot: 'bg-[#136B34]' },
  source_available: { label: 'Source ready', tone: 'info', dot: 'bg-[#2F6FDB]' },
  automation_only: { label: 'Automation-only', tone: 'warn', dot: 'bg-[#8A5000]' },
  partial: { label: 'Partial', tone: 'info', dot: 'bg-[#2F6FDB]' },
  awaiting_source: { label: 'Awaiting source', tone: 'idle', dot: 'bg-[#D6D9DF]' }
}

// Chapter titles arrive in capitals from the master topic list. Sentence case
// reads better, but naive casing mangles acronyms ("B2b", "Cnap"), so those stay.
const KEEP_UPPER = new Set(['B2B', 'CNAP', 'DUL', 'LOA', 'SAAS', 'MS', 'VSAAS', 'TRN', 'SIM', 'ESIM', 'OTP', 'UAE'])
export const chapterTitle = (title: string): string => {
  const words = title.split(/(\s+)/)
  return words
    .map((word, i) => {
      const bare = word.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
      if (KEEP_UPPER.has(bare)) return word.toUpperCase()
      const lower = word.toLowerCase()
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower
    })
    .join('')
}

export const Chip: React.FC<{ tone: keyof typeof TONE; title?: string; children: React.ReactNode }> = ({ tone, title, children }) => (
  <span className={`${CHIP} ${TONE[tone]}`} title={title}>{children}</span>
)

export const StatusChip: React.FC<{ status: ElementStatus; title?: string }> = ({ status, title }) => (
  <Chip tone={ELEMENT_STATUS[status]?.tone ?? 'idle'} title={title}>{ELEMENT_STATUS[status]?.label ?? status}</Chip>
)

export const Card: React.FC<{ className?: string; children: React.ReactNode; label?: string }> = ({ className = '', children, label }) => (
  <section aria-label={label} className={`overflow-hidden rounded-[20px] border border-[#E8EAEE] bg-white ${className}`}>{children}</section>
)

export const CardHead: React.FC<{ title: string; hint?: string; right?: React.ReactNode }> = ({ title, hint, right }) => (
  <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
    <div>
      <h2 className="m-0 text-[16px] font-bold text-[#1F2937]">{title}</h2>
      {hint && <p className="m-0 mt-0.5 text-[12.5px] text-[#6B7280]">{hint}</p>}
    </div>
    {right}
  </div>
)

/** Column headings for a grid table; `cols` is the Tailwind grid-cols class. */
export const TableHead: React.FC<{ cols: string; labels: string[] }> = ({ cols, labels }) => (
  <div className={`grid ${cols} h-8 items-center gap-3 bg-[#F4F5F7] px-5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-[#374151]`}>
    {labels.map(label => <span key={label}>{label}</span>)}
  </div>
)

export const Note: React.FC<{ tone?: 'plain' | 'warn'; children: React.ReactNode }> = ({ tone = 'plain', children }) => (
  <div className={`rounded-[12px] px-3.5 py-3 text-[12.5px] ${tone === 'warn' ? 'border border-[#EBCFA4] bg-[#FFFBF4] text-[#8A5000]' : 'bg-[#F9FAFB] text-[#4B5563]'}`}>
    {children}
  </div>
)

export const Loading: React.FC<{ what: string }> = ({ what }) => (
  <div className="px-5 py-10 text-center text-[13px] text-[#6B7280]">Loading {what}…</div>
)

export const Failed: React.FC<{ message: string; onRetry?: () => void }> = ({ message, onRetry }) => (
  <div className="m-5 flex items-center justify-between gap-3 rounded-[12px] border border-[#F0C2C0] bg-[#FEEBEC] px-4 py-3 text-[12.5px] text-[#A3231C]">
    <span>{message}</span>
    {onRetry && <button type="button" onClick={onRetry} className="font-bold hover:underline">Retry</button>}
  </div>
)

/** Load once per key; returns [data, error, reload]. */
export function useLoad<T>(key: string | null, load: () => Promise<T>): [T | null, string | null, () => void] {
  const [data, setData] = React.useState<T | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [tick, setTick] = React.useState(0)
  const loadRef = React.useRef(load)
  loadRef.current = load
  React.useEffect(() => {
    if (!key) return
    let live = true
    setData(null)
    setError(null)
    loadRef.current()
      .then(result => { if (live) setData(result) })
      .catch((err: any) => { if (live) setError(err?.response?.data?.detail ?? err?.message ?? 'Could not load.') })
    return () => { live = false }
  }, [key, tick])
  return [data, error, () => setTick(t => t + 1)]
}
