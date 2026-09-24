import React, { useEffect, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'

export interface TestingTool {
  /** Absolute path, e.g. /test-assistant/visual. The menu renders in the top
   *  bar, outside the Test Assistant route, so relative links would resolve
   *  against the layout instead. */
  to: string
  label: string
  detail: string
  Icon: React.FC<{ className?: string }>
}

const GridGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="1.8" aria-hidden>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
  </svg>
)

// Replaces the Test Assistant's tab bar: every testing mode stays one click
// away, without a whole card of tabs above the page.
const TestingToolsMenu: React.FC<{ tools: TestingTool[] }> = ({ tools }) => {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

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

  if (tools.length === 0) return null

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-audit-name="Testing tools"
        className={`flex h-9 items-center gap-2 rounded-[12px] border bg-white px-3 text-[13px] font-semibold text-[#1F2937] transition ${
          open ? 'border-[#B71920] shadow-[0_0_0_3px_#FDEBEC]' : 'border-[#E8EAEE] hover:border-[#F6D4D5]'
        }`}
      >
        <GridGlyph />
        <span>Testing tools</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2" aria-hidden>
          <path d={open ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'} />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+6px)] z-50 w-[280px] rounded-[16px] border border-[#E8EAEE] bg-white p-1.5 shadow-[0_16px_40px_-12px_rgba(16,24,40,0.22),0_4px_12px_-6px_rgba(16,24,40,0.12)]"
        >
          {tools.map(({ to, label, detail, Icon }) => (
            <NavLink
              key={to}
              to={to}
              role="menuitem"
              onClick={() => setOpen(false)}
              data-audit="true"
              data-audit-name={label}
              className={({ isActive }) =>
                `flex items-start gap-2.5 rounded-[10px] px-3 py-2 transition ${isActive ? 'bg-[#FFF5F5]' : 'hover:bg-[#F8F9FB]'}`
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={`mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[8px] ${
                      isActive
                        ? 'bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] text-white'
                        : 'border border-[#E8EAEE] bg-[#F8F9FB] text-[#6B7280]'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className={`block text-[13px] font-semibold ${isActive ? 'text-[#7A0B0D]' : 'text-[#1F2937]'}`}>{label}</span>
                    <span className="block text-[12px] text-[#6B7280]">{detail}</span>
                  </span>
                </>
              )}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}

export default TestingToolsMenu
