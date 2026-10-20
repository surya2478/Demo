import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState
} from 'react'

export interface PageMeta {
  title?: string
  subtitle?: string
  welcomeText?: string
  actions?: React.ReactNode
  leading?: React.ReactNode
  eyebrow?: React.ReactNode
  /** A smaller title, for a page whose top bar also carries its actions. */
  compactTitle?: boolean
  /*
   * JSX is not part of the republish key (see usePageHeader). A page whose
   * `leading` or `actions` depend on data -- a menu filtered by permissions --
   * passes a string that changes with that data, so the header refreshes.
   */
  contentKey?: string
  showSearch?: boolean
  onSearch?: (q: string) => void
  searchPlaceholder?: string
  showAssistant?: boolean
  showNotifications?: boolean
  notificationCount?: number
  showDateRange?: boolean
  dateRangeLabel?: string
  /*
   * The three header controls each need a handler to appear at all -- see the
   * note in TopHeader. Pass stable references (useCallback): meta republishes
   * only when a primitive field changes, so a handler that closes over
   * changing state will otherwise go stale.
   */
  onDateRangeClick?: () => void
  onNotificationsClick?: () => void
  onAssistantClick?: () => void
}

// Two separate contexts: a value context (changes when meta changes) and
// a stable setter context (referentially stable for the lifetime of the
// provider). Pages depend ONLY on the stable setter — never the value —
// so route changes can't be blocked by an infinite effect loop.
const MetaValueContext = createContext<PageMeta>({})
const MetaSetterContext = createContext<((m: PageMeta) => void) | null>(null)

export const PageHeaderProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [meta, setMetaState] = useState<PageMeta>({})

  // Stable setter — useCallback with empty deps. This reference never
  // changes for the life of the provider, so pages can safely depend on it.
  const setMeta = useCallback((next: PageMeta) => {
    setMetaState(next)
  }, [])

  return (
    <MetaSetterContext.Provider value={setMeta}>
      <MetaValueContext.Provider value={meta}>{children}</MetaValueContext.Provider>
    </MetaSetterContext.Provider>
  )
}

/**
 * Page-side hook to publish header meta to TopHeader.
 *
 * - Reads only the STABLE setter context — never the meta value — so calling
 *   setMeta cannot trigger this hook's effect to re-run.
 * - Effect deps are the serialized primitive key + the stable setter. JSX
 *   action references and inline handler references therefore do not cause
 *   re-publishes.
 * - The latest meta (including current actions/handlers) is read from a ref
 *   at the moment a publish actually happens.
 * - `enabled: false` stands a shell aside so a nested page can publish the
 *   header itself (the setter holds one meta, and the last publish wins).
 */
export function usePageHeader(meta: PageMeta, { enabled = true }: { enabled?: boolean } = {}) {
  const setMeta = useContext(MetaSetterContext)
  const metaRef = useRef(meta)
  metaRef.current = meta

  const key = JSON.stringify({
    title: meta.title ?? null,
    subtitle: meta.subtitle ?? null,
    welcomeText: meta.welcomeText ?? null,
    searchPlaceholder: meta.searchPlaceholder ?? null,
    dateRangeLabel: meta.dateRangeLabel ?? null,
    notificationCount: meta.notificationCount ?? null,
    showSearch: meta.showSearch ?? null,
    showAssistant: meta.showAssistant ?? null,
    showNotifications: meta.showNotifications ?? null,
    showDateRange: meta.showDateRange ?? null,
    contentKey: meta.contentKey ?? null,
    compactTitle: meta.compactTitle ?? null
  })

  // Publish on mount + whenever a primitive field changes.
  useEffect(() => {
    if (!setMeta || !enabled) return
    setMeta(metaRef.current)
  }, [setMeta, key, enabled])

  // Clear on unmount so the next page starts with a blank header.
  useEffect(() => {
    return () => {
      setMeta?.({})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

export function usePageHeaderMeta(): PageMeta {
  return useContext(MetaValueContext)
}
