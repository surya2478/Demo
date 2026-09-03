/**
 * --- A button that opens a short menu ------------------------------------
 *
 * Built for the workbench toolbar, where eleven controls in a row could not be
 * made to fit a laptop at any arrangement or padding -- the count was the
 * problem, not the layout. Grouping the three classification verbs under one
 * control, and the two destructive ones under another, is what actually buys
 * the width back.
 *
 * Deliberately not a generic dropdown: no submenus, no checkable items, no
 * portal. A handful of actions, one level, closes on choice.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react'

export interface MenuAction {
  label: string
  onSelect: () => void
  /** Shown under the label -- say what the item does when it is not obvious. */
  detail?: string
  disabled?: boolean
  /** Destructive items are tinted and sit below a divider. */
  danger?: boolean
  icon?: React.ReactNode
}

interface MenuButtonProps {
  label: React.ReactNode
  actions: MenuAction[]
  disabled?: boolean
  title?: string
  /** Applied to the trigger, so callers keep the toolbar's button language. */
  className?: string
  ariaLabel?: string
  align?: 'left' | 'right'
}

const MenuButton: React.FC<MenuButtonProps> = ({
  label,
  actions,
  disabled = false,
  title,
  className = 'app-btn app-btn-secondary text-xs font-medium',
  ariaLabel,
  align = 'right'
}) => {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuId = useId()

  const close = useCallback(
    (returnFocus = false) => {
      setOpen(false)
      if (returnFocus) triggerRef.current?.focus()
    },
    []
  )

  // Close on a click outside, and on Escape from anywhere in the menu.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(true)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])

  // A menu whose trigger goes disabled mid-flight must not stay open.
  useEffect(() => {
    if (disabled && open) setOpen(false)
  }, [disabled, open])

  const enabled = actions.filter(a => !a.disabled)

  return (
    <div ref={wrapRef} className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className={`${className} inline-flex items-center gap-1.5`}
      >
        {label}
        <svg
          viewBox="0 0 12 12"
          aria-hidden
          className={`h-2.5 w-2.5 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path
            d="M2.5 4.5 6 8l3.5-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          className={`absolute top-full z-40 mt-1.5 min-w-[210px] overflow-hidden rounded-app border border-app bg-app-surface py-1 shadow-app-card-lg ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {actions.map((action, index) => {
            const dividerAbove =
              action.danger && index > 0 && !actions[index - 1].danger
            return (
              <React.Fragment key={action.label}>
                {dividerAbove ? <div className="my-1 h-px bg-app-border" /> : null}
                <button
                  type="button"
                  role="menuitem"
                  disabled={action.disabled}
                  onClick={() => {
                    close()
                    action.onSelect()
                  }}
                  className={`flex w-full items-start gap-2 px-3 py-2 text-left text-xs transition disabled:cursor-not-allowed disabled:opacity-45 ${
                    action.danger
                      ? 'text-app-danger hover:bg-app-danger-bg active:bg-app-danger-bg'
                      : 'text-app-primary hover:bg-app-surface-muted active:bg-app-border'
                  }`}
                >
                  {action.icon ? (
                    <span className="mt-px flex-shrink-0">{action.icon}</span>
                  ) : null}
                  <span className="min-w-0">
                    <span className="block font-medium leading-tight">{action.label}</span>
                    {action.detail ? (
                      <span className="mt-0.5 block text-[11px] leading-snug text-app-secondary">
                        {action.detail}
                      </span>
                    ) : null}
                  </span>
                </button>
              </React.Fragment>
            )
          })}
          {enabled.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-app-secondary">Nothing available here.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default MenuButton
