import React, { useEffect, useRef, useState } from 'react'
import api from '../../services/api'

/** A Test Data application, as Generate Test Cases offers it. */
export interface TargetApplication {
  id: number
  name: string
  kb_app_id: string
  has_kb: boolean
  flows: number
  has_journeys: boolean
  /** {environment: address} */
  addresses: Record<string, string>
}

export const fetchTargetApplications = async (): Promise<TargetApplication[]> =>
  (await api.get('/generate/target-applications')).data.applications

interface SelectApplicationsProps {
  options: TargetApplication[]
  value: number[]
  onChange: (value: number[]) => void
  disabled?: boolean
  /** Shown once Generate was attempted with nothing chosen. */
  missing?: boolean
  loading?: boolean
}

const AppGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#B71920" strokeWidth="1.8" aria-hidden>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="M3.5 9h17M7 6.8h.01M9.5 6.8h.01" />
  </svg>
)

const Check = ({ on }: { on: boolean }) => (
  <span
    className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[5px] border ${on ? 'border-[#B71920] bg-[#B71920]' : 'border-[#D0D5DD] bg-white'}`}
    aria-hidden
  >
    {on && (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.2">
        <path d="M5 12l5 5 9-10" />
      </svg>
    )}
  </span>
)

// What the application's Knowledge Base can ground generation in.
const describe = (app: TargetApplication) => {
  const knows = [
    app.has_journeys ? 'design journeys' : '',
    app.flows ? `${app.flows} flow${app.flows === 1 ? '' : 's'}` : ''
  ].filter(Boolean)
  if (knows.length) return `Knowledge Base: ${knows.join(' · ')}`
  if (app.has_kb) return 'Knowledge Base: profile only, no flows yet'
  return 'No Knowledge Base yet: cases are written from the requirements alone'
}

// "Application", after Select KB and before Environment. Several can be
// ticked; each generated case is linked to the one it is for, and nothing
// downstream infers the application from the case text again.
const SelectApplications: React.FC<SelectApplicationsProps> = ({ options, value, onChange, disabled = false, missing = false, loading = false }) => {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const chosen = options.filter((option) => value.includes(option.id))

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  const toggle = (id: number) => onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id])

  const summary = loading
    ? 'Loading applications…'
    : chosen.length === 0
      ? 'Select application'
      : chosen.length === 1
        ? chosen[0].name
        : `${chosen[0].name} +${chosen.length - 1}`

  return (
    <div ref={rootRef} className="relative flex w-full flex-col gap-1.5 sm:w-auto">
      <span id="select-application-label" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#6B7280]">
        Application <span className="text-[#B71920]">*</span>
      </span>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby="select-application-label"
        aria-invalid={missing && chosen.length === 0}
        data-audit-name="Application"
        title={chosen.map((app) => app.name).join(', ') || 'The application(s) these test cases are for'}
        disabled={disabled || loading}
        onClick={() => setOpen((current) => !current)}
        className={`flex h-10 w-full items-center sm:w-[240px] justify-between gap-2 rounded-[12px] border bg-white px-3 text-[13px] font-semibold text-[#1F2937] transition disabled:cursor-not-allowed disabled:opacity-60 ${
          open
            ? 'border-[#B71920] shadow-[0_0_0_3px_#FDEBEC]'
            : missing && chosen.length === 0
              ? 'border-[#B71920] ring-2 ring-[#FDEBEC]'
              : 'border-[#E8EAEE] hover:border-[#F6D4D5]'
        }`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <AppGlyph />
          <span className={`truncate ${chosen.length ? '' : 'font-medium text-[#6B7280]'}`}>{summary}</span>
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2" className="flex-shrink-0" aria-hidden>
          <path d={open ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'} />
        </svg>
      </button>
      {missing && chosen.length === 0 && (
        <span role="alert" className="absolute left-0 top-full mt-1 whitespace-nowrap text-[11.5px] font-semibold text-[#B71920]">Choose the application first</span>
      )}

      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-labelledby="select-application-label"
          className="absolute left-0 top-[calc(100%+4px)] z-50 flex max-h-[360px] w-[min(380px,calc(100vw-32px))] flex-col gap-0.5 overflow-y-auto rounded-[16px] border border-[#E8EAEE] bg-white p-1.5 shadow-[0_16px_40px_-12px_rgba(16,24,40,0.22),0_4px_12px_-6px_rgba(16,24,40,0.12)]"
        >
          {options.length === 0 ? (
            <div className="px-3 py-3 text-[12.5px] text-[#6B7280]">
              No applications are registered yet. Add one under AI Test Automation &gt; Test Data.
            </div>
          ) : (
            <>
              <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#6B7280]">
                Tick every application the document covers
              </div>
              {options.map((app) => {
                const on = value.includes(app.id)
                return (
                  <button
                    key={app.id}
                    type="button"
                    role="option"
                    aria-selected={on}
                    onClick={() => toggle(app.id)}
                    className={`flex w-full items-start gap-2.5 rounded-[10px] px-3 py-[9px] text-left transition ${on ? 'bg-[#FFF5F5]' : 'hover:bg-[#F8F9FB]'}`}
                  >
                    <Check on={on} />
                    <span className="min-w-0">
                      <span className={`block text-[13px] ${on ? 'font-bold text-[#7A0B0D]' : 'font-semibold text-[#1F2937]'}`}>{app.name}</span>
                      <span className={`mt-0.5 block text-[12px] ${app.has_kb || app.has_journeys ? 'text-[#6B7280]' : 'text-[#B45309]'}`}>{describe(app)}</span>
                    </span>
                  </button>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default SelectApplications
