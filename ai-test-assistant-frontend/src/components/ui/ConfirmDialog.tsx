/**
 * --- Confirming something irreversible ----------------------------------
 *
 * The four destructive paths in Automation Studio were guarded by
 * `window.confirm`. Three problems with that, in rising order of seriousness:
 * it is an unstyled OS dialog in a product with its own identity; it cannot
 * mark which button is the dangerous one; and it is a single line of text, so
 * the consequences a person needs before answering do not fit in it.
 *
 * That last one had bitten already. "Are you sure you want to delete 3 test
 * cases?" was the prompt guarding a call that deletes the approved test cases
 * themselves, every refined case linked to them, and every script generated
 * from those. The quietest dialog in the app sat in front of its most
 * destructive action.
 *
 * So `consequences` is the point of this component rather than a decoration:
 * a caller is expected to name what else goes, and the dialog gives that list
 * more room than the question itself.
 *
 * Promise-based on purpose -- `if (!(await confirm({...}))) return` is the
 * same shape as the `window.confirm` guard it replaces, so the call sites
 * changed in content and not in structure.
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
import { HiOutlineExclamation } from 'react-icons/hi'

export interface ConfirmRequest {
  /** The question, as a question. "Delete 12 test cases?" */
  title: string
  /** One line of context. What is about to happen, in the user's words. */
  body?: React.ReactNode
  /**
   * What else goes, one item per line. Name every cascade the caller knows
   * about; this is the reason the dialog exists.
   */
  consequences?: string[]
  /** Say what the button does -- "Delete 12 test cases", never "OK". */
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'default'
}

type Confirm = (request: ConfirmRequest) => Promise<boolean>

const ConfirmContext = createContext<Confirm | null>(null)

interface Pending {
  request: ConfirmRequest
  resolve: (ok: boolean) => void
}

export const ConfirmProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [pending, setPending] = useState<Pending | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  /** Where focus came from, so it can go back when the dialog closes. */
  const returnFocusRef = useRef<HTMLElement | null>(null)

  const confirm = useCallback<Confirm>(
    request =>
      new Promise<boolean>(resolve => {
        returnFocusRef.current = (document.activeElement as HTMLElement) ?? null
        setPending({ request, resolve })
      }),
    []
  )

  const settle = useCallback(
    (ok: boolean) => {
      setPending(current => {
        current?.resolve(ok)
        return null
      })
      // Put focus back where the user left it, not at the top of the document.
      const target = returnFocusRef.current
      returnFocusRef.current = null
      if (target && document.contains(target)) {
        window.setTimeout(() => target.focus(), 0)
      }
    },
    []
  )

  const isOpen = pending !== null

  // Cancel is the default focus: the safe answer should be the one a stray
  // Return key hits.
  useEffect(() => {
    if (!isOpen) return
    const id = window.setTimeout(() => cancelRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [isOpen])

  // The page behind must not scroll under the dialog.
  useEffect(() => {
    if (!isOpen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [isOpen])

  // Escape cancels, and Tab stays inside the dialog.
  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        settle(false)
        return
      }
      if (event.key !== 'Tab') return
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>('button')
      if (!focusable || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isOpen, settle])

  const request = pending?.request
  const danger = (request?.tone ?? 'danger') === 'danger'

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request ? (
        <div
          // Above the app's modals (z-60/z-70) -- a confirm can be raised from
          // inside one -- and below the toasts that report the result.
          className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
          onMouseDown={event => {
            if (event.target === event.currentTarget) settle(false)
          }}
        >
          <div
            ref={panelRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby={request.consequences?.length ? 'confirm-consequences' : undefined}
            className="w-full max-w-[440px] overflow-hidden rounded-app-lg border border-app bg-app-surface shadow-app-card-lg"
          >
            <div className="flex gap-3 px-5 pb-4 pt-5">
              <span
                className={`mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full ${
                  danger
                    ? 'bg-app-danger-bg text-app-danger'
                    : 'bg-app-warning-bg text-app-warning'
                }`}
              >
                <HiOutlineExclamation className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h2
                  id="confirm-title"
                  className="text-[16px] font-semibold leading-snug text-app-primary"
                >
                  {request.title}
                </h2>
                {request.body ? (
                  <p className="mt-1.5 text-[13px] leading-relaxed text-app-secondary">
                    {request.body}
                  </p>
                ) : null}
              </div>
            </div>

            {request.consequences?.length ? (
              <ul
                id="confirm-consequences"
                className="mx-5 mb-4 space-y-1.5 rounded-app border border-app bg-app-surface-muted px-4 py-3"
              >
                {request.consequences.map(line => (
                  <li
                    key={line}
                    className="flex gap-2 text-[12.5px] leading-relaxed text-app-primary"
                  >
                    <span aria-hidden className="mt-[7px] h-1 w-1 flex-shrink-0 rounded-full bg-app-muted" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="flex justify-end gap-2 border-t border-app bg-app-surface-subtle px-5 py-3">
              <button
                ref={cancelRef}
                type="button"
                onClick={() => settle(false)}
                className="app-btn app-btn-secondary text-[13px]"
              >
                {request.cancelLabel ?? 'Cancel'}
              </button>
              <button
                type="button"
                onClick={() => settle(true)}
                className={
                  danger
                    ? 'app-btn bg-app-danger text-white shadow-app-card transition hover:brightness-90 active:brightness-75 text-[13px] font-semibold'
                    : 'app-btn app-btn-primary text-[13px] font-semibold'
                }
              >
                {request.confirmLabel ?? 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </ConfirmContext.Provider>
  )
}

/**
 * Refuses rather than proceeds when the provider is missing. A confirm that
 * silently returns true would turn a mounting mistake into deleted data.
 */
export const useConfirm = (): Confirm => {
  const ctx = useContext(ConfirmContext)
  const fallback = useCallback<Confirm>(async () => false, [])
  return ctx ?? fallback
}

export default ConfirmProvider
