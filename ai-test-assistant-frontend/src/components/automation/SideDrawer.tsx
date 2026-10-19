/**
 * --- A panel that slides in from the right, over a full-width list ----------
 *
 * Runs and the Automation Lab give their list the whole page and open the
 * chosen row here. Esc and the backdrop close it; ↑ / ↓ step to the previous
 * or next row without closing, so a list can be read through one item at a
 * time. Keys typed into a field are left alone.
 *
 * The slide is a one-off animation with no fill, so no transform stays on the
 * panel afterwards: a transform would make it the containing block for the
 * fixed-position dialogs opened from inside it (Spec, confirmations).
 */
import React, { useEffect, useRef } from 'react'

interface Props {
  label: string
  /** Tailwind width classes for the panel. */
  width: string
  /** Centered workspace for detailed case editing; other consumers stay drawers. */
  variant?: 'side' | 'centered'
  onClose: () => void
  onPrev?: (() => void) | null
  onNext?: (() => void) | null
  /** While something inside has its own dialog open, keys belong to it. */
  paused?: boolean
  children: React.ReactNode
}

const typing = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))
}

const SideDrawer: React.FC<Props> = ({ label, width, variant = 'side', onClose, onPrev, onNext, paused, children }) => {
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (variant !== 'centered') return
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => previous?.focus()
  }, [variant])
  useEffect(() => {
    if (paused) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      // A confirmation or editor opened over the drawer handles its own keys.
      if (document.querySelectorAll('[aria-modal="true"]').length > 1) return
      if (variant === 'centered' && event.key === 'Tab') {
        const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])
          .filter(element => element.getClientRects().length > 0)
        if (focusable.length) {
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }
        return
      }
      if (typing(event.target)) return
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowUp' && onPrev) { event.preventDefault(); onPrev() }
      else if (event.key === 'ArrowDown' && onNext) { event.preventDefault(); onNext() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onPrev, onNext, paused, variant])

  // The page under the drawer stays where it was.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [])

  return (
    <div
      className={`fixed inset-0 z-[60] flex bg-[rgba(17,24,39,0.5)] ${variant === 'centered' ? 'items-center justify-center p-3 sm:p-5' : 'justify-end'}`}
      style={{ animation: 'sideDrawerFade 160ms ease-out' }}
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
      role="presentation"
    >
      <style>{'@keyframes sideDrawerFade{from{opacity:0}to{opacity:1}}@keyframes sideDrawerIn{from{transform:translateX(48px);opacity:.6}to{transform:none;opacity:1}}@keyframes caseModalIn{from{transform:translateY(16px) scale(.985);opacity:.6}to{transform:none;opacity:1}}'}</style>
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`flex w-full flex-col overflow-hidden bg-white ${variant === 'centered' ? 'h-[min(94vh,1000px)] rounded-[22px] border border-white/70 shadow-[0_32px_90px_rgba(15,23,42,0.3)]' : 'h-full shadow-[-24px_0_60px_rgba(15,23,42,0.18)]'} ${width}`}
        style={{ animation: `${variant === 'centered' ? 'caseModalIn' : 'sideDrawerIn'} 200ms cubic-bezier(.2,.8,.2,1)` }}
      >
        {children}
      </aside>
    </div>
  )
}

/** ↑ ↓ "3 of 40" ✕ -- the same controls at the top of every drawer. */
export const DrawerNav: React.FC<{
  index: number
  total: number
  onPrev?: (() => void) | null
  onNext?: (() => void) | null
  onClose: () => void
}> = ({ index, total, onPrev, onNext, onClose }) => {
  const btn = 'flex h-9 w-9 items-center justify-center rounded-[10px] border border-[#E8EAEE] bg-white text-[#374151] transition hover:border-[#F6D4D5] hover:text-[#B71920] disabled:cursor-not-allowed disabled:opacity-40'
  return (
    <div className="flex flex-shrink-0 items-center gap-1.5">
      {total > 0 && (
        <>
          <button type="button" onClick={() => onPrev?.()} disabled={!onPrev} aria-label="Previous (↑)" title="Previous (↑)" className={btn}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M18 15l-6-6-6 6" /></svg>
          </button>
          <button type="button" onClick={() => onNext?.()} disabled={!onNext} aria-label="Next (↓)" title="Next (↓)" className={btn}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
          </button>
          {index >= 0 && <span className="px-1 text-[12.5px] tabular-nums text-[#6B7280]">{index + 1} of {total}</span>}
        </>
      )}
      <button type="button" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)" className={`${btn} ml-1`}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  )
}

export default SideDrawer
