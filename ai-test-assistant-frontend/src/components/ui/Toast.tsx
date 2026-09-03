/**
 * --- Toasts -------------------------------------------------------------
 *
 * The app's core loop is "launch a long job and wait" -- refine, classify,
 * review, generate, execute. Until now the only report a job made when it
 * finished was a spinner ceasing to spin, or a banner nailed to the top of one
 * card, which the user has usually scrolled past by the time the answer
 * arrives. Both fail the same way: the result is announced somewhere the
 * person is not looking.
 *
 * Two rules this makes deliberate, because getting them wrong is how toast
 * systems become noise:
 *
 *   - Errors do not auto-dismiss. A success can evaporate; the user asked for
 *     it and can ask again. A failure is the one message someone needs to
 *     still be there when they look back, and it usually carries the only copy
 *     of the reason.
 *
 *   - A toast carries the shape of the result, not the fact of it. "Refined 9
 *     of 12" and "Refined 12 of 12" are different outcomes and the second is
 *     the only one that means "done". That is what `description` is for.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  HiOutlineCheckCircle,
  HiOutlineExclamationCircle,
  HiOutlineInformationCircle,
  HiOutlineX,
  HiOutlineXCircle
} from 'react-icons/hi'

export type ToastTone = 'success' | 'error' | 'warning' | 'info'

export interface Toast {
  id: number
  tone: ToastTone
  title: string
  /** The detail a person needs to act -- which items failed, and why. */
  description?: string
  /** 0 keeps the toast up until it is dismissed by hand. */
  durationMs: number
}

type Emit = (title: string, description?: string) => number

interface ToastContextValue {
  success: Emit
  error: Emit
  warning: Emit
  info: Emit
  dismiss: (id: number) => void
  clear: () => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

/** Errors stay; everything else clears itself. Warnings get longer to read. */
const DURATION: Record<ToastTone, number> = {
  success: 5000,
  info: 5000,
  warning: 9000,
  error: 0
}

const TONE: Record<
  ToastTone,
  { wrap: string; icon: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  success: {
    wrap: 'border-app-success-border bg-app-success-bg',
    icon: 'text-app-success',
    Icon: HiOutlineCheckCircle
  },
  error: {
    wrap: 'border-app-danger-border bg-app-danger-bg',
    icon: 'text-app-danger',
    Icon: HiOutlineXCircle
  },
  warning: {
    wrap: 'border-app-warning-border bg-app-warning-bg',
    icon: 'text-app-warning',
    Icon: HiOutlineExclamationCircle
  },
  info: {
    wrap: 'border-app-info-border bg-app-info-bg',
    icon: 'text-app-info',
    Icon: HiOutlineInformationCircle
  }
}

/** Beyond this the stack stops being readable, so the oldest fall off. */
const MAX_VISIBLE = 4

const ToastRow: React.FC<{ toast: Toast; onDismiss: (id: number) => void }> = ({
  toast,
  onDismiss
}) => {
  const tone = TONE[toast.tone]
  const { Icon } = tone
  const isError = toast.tone === 'error'

  return (
    <div
      // An error interrupts; a confirmation waits its turn.
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      className={`toast-enter pointer-events-auto flex w-full items-start gap-2.5 rounded-app border px-3.5 py-3 shadow-app-card-lg ${tone.wrap}`}
    >
      <Icon className={`mt-px h-[18px] w-[18px] flex-shrink-0 ${tone.icon}`} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-snug text-app-primary">{toast.title}</p>
        {toast.description ? (
          <p className="mt-1 text-[12px] leading-relaxed text-app-secondary">
            {toast.description}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className="-mr-1 -mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-app-sm text-app-secondary transition hover:bg-black/5 hover:text-app-primary active:bg-black/10"
      >
        <HiOutlineX className="h-4 w-4" />
      </button>
    </div>
  )
}

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)
  const timers = useRef(new Map<number, number>())

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer) {
      window.clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const clear = useCallback(() => {
    timers.current.forEach(t => window.clearTimeout(t))
    timers.current.clear()
    setToasts([])
  }, [])

  // Timers outlive the component that started the job, so they are cleared on
  // unmount rather than left to fire against a dead setState.
  useEffect(() => () => {
    timers.current.forEach(t => window.clearTimeout(t))
    timers.current.clear()
  }, [])

  const push = useCallback(
    (tone: ToastTone, title: string, description?: string): number => {
      const id = nextId.current++
      const durationMs = DURATION[tone]
      setToasts(prev => [...prev, { id, tone, title, description, durationMs }].slice(-MAX_VISIBLE))
      if (durationMs > 0) {
        timers.current.set(
          id,
          window.setTimeout(() => {
            timers.current.delete(id)
            setToasts(prev => prev.filter(t => t.id !== id))
          }, durationMs)
        )
      }
      return id
    },
    []
  )

  const value = useMemo<ToastContextValue>(
    () => ({
      success: (title, description) => push('success', title, description),
      error: (title, description) => push('error', title, description),
      warning: (title, description) => push('warning', title, description),
      info: (title, description) => push('info', title, description),
      dismiss,
      clear
    }),
    [push, dismiss, clear]
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        // Above the sticky header (z-30) and the app's modals (z-50).
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[calc(100vw-2rem)] max-w-[380px] flex-col gap-2 sm:bottom-6 sm:right-6"
      >
        {toasts.map(toast => (
          <ToastRow key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

/**
 * Falls back to a no-op outside the provider rather than throwing: a toast is
 * a report on work that already happened, and losing the report is never worth
 * taking the screen down with it.
 */
export const useToast = (): ToastContextValue => {
  const ctx = useContext(ToastContext)
  return (
    ctx ?? {
      success: () => 0,
      error: () => 0,
      warning: () => 0,
      info: () => 0,
      dismiss: () => undefined,
      clear: () => undefined
    }
  )
}

export default ToastProvider
