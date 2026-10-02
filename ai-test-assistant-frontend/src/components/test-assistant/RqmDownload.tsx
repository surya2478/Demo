// --- Download test cases in the RQM template --------------------------------------
//
// One control for Test Assistant and Review & Approval: the test cases as they
// were generated, or as AI Checks left them. The menu is positioned against the
// window, not its row, so a list that scrolls sideways (Review & Approval's)
// cannot clip it.

import React, { useEffect, useRef, useState } from 'react'

export type RqmVersion = 'generated' | 'checked'

interface Props {
  /** 'button' shows a label; 'icon' is the compact one for a list row. */
  variant?: 'button' | 'icon'
  label?: string
  /** Offer "After AI Checks" as well. Without it the control downloads as generated. */
  checkedAvailable?: boolean
  busy?: boolean
  disabled?: boolean
  title?: string
  onPick: (version: RqmVersion) => void
}

const OPTIONS: { version: RqmVersion; label: string; detail: string }[] = [
  { version: 'generated', label: 'As generated', detail: 'The test cases before AI Checks changed them' },
  { version: 'checked', label: 'After AI Checks', detail: 'With the steps, data and results AI Checks improved' }
]

const DownloadIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
)

const RqmDownload: React.FC<Props> = ({ variant = 'button', label = 'Download TCs', checkedAvailable = true, busy = false, disabled = false, title, onPick }) => {
  const [place, setPlace] = useState<React.CSSProperties | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!place) return
    const close = () => setPlace(null)
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) close()
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { close(); triggerRef.current?.focus() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [place])

  const open = () => {
    if (!checkedAvailable) { onPick('generated'); return }
    if (place) { setPlace(null); return }
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const right = Math.max(8, window.innerWidth - rect.right)
    // Opens upward when there is no room below.
    setPlace(rect.bottom + 140 > window.innerHeight
      ? { position: 'fixed', right, bottom: window.innerHeight - rect.top + 6 }
      : { position: 'fixed', right, top: rect.bottom + 6 })
  }

  const pick = (version: RqmVersion) => { setPlace(null); onPick(version) }
  const tip = title ?? (checkedAvailable ? 'Download the test cases in the RQM template' : 'Download the test cases as generated, in the RQM template')

  return (
    <>
      {variant === 'icon' ? (
        <button
          ref={triggerRef}
          type="button"
          onClick={open}
          disabled={disabled || busy}
          title={busy ? 'Downloading…' : tip}
          aria-label={tip}
          aria-haspopup={checkedAvailable ? 'menu' : undefined}
          aria-expanded={checkedAvailable ? !!place : undefined}
          className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-[#E8EAEE] bg-white text-[#1F2937] transition hover:border-[#F6D4D5] hover:text-[#B71920] disabled:opacity-50"
        >
          {busy ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#E8EAEE] border-t-[#B71920]" /> : <DownloadIcon />}
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          onClick={open}
          disabled={disabled || busy}
          title={tip}
          aria-haspopup={checkedAvailable ? 'menu' : undefined}
          aria-expanded={checkedAvailable ? !!place : undefined}
          className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-[#E8EAEE] bg-white px-3 text-[12.5px] font-bold text-[#1F2937] transition hover:border-[#F6D4D5] disabled:opacity-50"
        >
          <DownloadIcon />
          {busy ? 'Downloading…' : label}
        </button>
      )}
      {place && (
        <div ref={menuRef} role="menu" style={place} className="z-50 w-[250px] overflow-hidden rounded-[12px] border border-[#E8EAEE] bg-white py-1 shadow-[0_12px_32px_rgba(16,24,40,0.14)]">
          <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#6B7280]">RQM template</div>
          {OPTIONS.map((option) => (
            <button key={option.version} type="button" role="menuitem" onClick={() => pick(option.version)} className="flex w-full flex-col px-3 py-2 text-left hover:bg-[#FFF5F5]">
              <span className="text-[12.5px] font-bold text-[#1F2937]">{option.label}</span>
              <span className="text-[11px] text-[#6B7280]">{option.detail}</span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}

export default RqmDownload
