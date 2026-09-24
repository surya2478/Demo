import React, { useEffect, useRef, useState } from 'react'

export interface KnowledgeBaseOption<V extends string = string> {
  value: V
  label: string
  /** Shown after the label in the closed control: "Squad KB · Device Squad". */
  short: string
  description: string
  /** The default choice sits above the Knowledge Base list. */
  isDefault?: boolean
}

interface SelectKBProps<V extends string> {
  options: readonly KnowledgeBaseOption<V>[]
  value: V
  onChange: (value: V) => void
  disabled?: boolean
}

const BookmarkGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#B71920" strokeWidth="1.8" aria-hidden>
    <path d="M6.75 4.5h8.5A2.75 2.75 0 0118 7.25v11.25a1 1 0 01-1.5.86L12 16.75l-4.5 2.61a1 1 0 01-1.5-.86V7.25A2.75 2.75 0 018.75 4.5z" />
  </svg>
)

const Tick = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#B71920" strokeWidth="2.4" className="mt-0.5 flex-shrink-0" aria-hidden>
    <path d="M5 12l5 5 9-10" />
  </svg>
)

// "Select KB", before the Generate button. A listbox rather than a native
// select so each Knowledge Base can say what it grounds generation in.
function SelectKB<V extends string>({ options, value, onChange, disabled = false }: SelectKBProps<V>) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const selected = options.find((option) => option.value === value) ?? options[0]

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

  const choose = (next: V) => {
    onChange(next)
    setOpen(false)
  }

  const renderOption = (option: KnowledgeBaseOption<V>) => {
    const isSelected = option.value === selected.value
    return (
      <button
        key={option.value}
        type="button"
        role="option"
        aria-selected={isSelected}
        onClick={() => choose(option.value)}
        className={`flex w-full items-start gap-2.5 rounded-[10px] px-3 py-[9px] text-left transition ${isSelected ? 'bg-[#FFF5F5]' : 'hover:bg-[#F8F9FB]'}`}
      >
        {isSelected ? <Tick /> : <span className="w-4 flex-shrink-0" />}
        <span className="min-w-0">
          <span className={`block text-[13px] ${isSelected ? 'font-bold text-[#7A0B0D]' : 'font-semibold text-[#1F2937]'}`}>
            {option.label}
            {option.isDefault && (
              <span className="ml-1 rounded-full bg-[#EAF7EF] px-[7px] py-0.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[#136B34]">
                Default
              </span>
            )}
          </span>
          <span className="mt-0.5 block text-[12px] text-[#6B7280]">{option.description}</span>
        </span>
      </button>
    )
  }

  const defaults = options.filter((option) => option.isDefault)
  const knowledgeBases = options.filter((option) => !option.isDefault)

  return (
    <div ref={rootRef} className="relative flex w-full flex-col gap-1.5 sm:w-auto">
      <span id="select-kb-label" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#6B7280]">Select KB</span>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby="select-kb-label"
        data-audit-name="Select KB"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className={`flex h-10 w-full items-center sm:w-[300px] justify-between gap-2 rounded-[12px] border bg-white px-3 text-[13px] font-semibold text-[#1F2937] transition disabled:cursor-not-allowed disabled:opacity-60 ${
          open ? 'border-[#B71920] shadow-[0_0_0_3px_#FDEBEC]' : 'border-[#E8EAEE] hover:border-[#F6D4D5]'
        }`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <BookmarkGlyph />
          <span className="truncate">
            {selected.label} <span className="font-medium text-[#6B7280]">· {selected.short}</span>
          </span>
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2" className="flex-shrink-0" aria-hidden>
          <path d={open ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'} />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          aria-labelledby="select-kb-label"
          className="absolute left-0 top-[calc(100%+4px)] z-50 flex w-[min(360px,calc(100vw-32px))] flex-col gap-0.5 rounded-[16px] border border-[#E8EAEE] bg-white p-1.5 shadow-[0_16px_40px_-12px_rgba(16,24,40,0.22),0_4px_12px_-6px_rgba(16,24,40,0.12)]"
        >
          {defaults.map(renderOption)}
          {knowledgeBases.length > 0 && (
            <div className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#6B7280]">Knowledge Bases</div>
          )}
          {knowledgeBases.map(renderOption)}
        </div>
      )}
    </div>
  )
}

export default SelectKB
