import { useEffect, useRef, useState } from 'react'

// An image the API serves with the session's token, as an object URL that is
// released when it is replaced or the component goes.
export function useAuthedImage(load: (() => Promise<string>) | null, key: string | null) {
  const [url, setUrl] = useState<string | null>(null)
  const current = useRef<string | null>(null)
  useEffect(() => {
    if (!load || !key) return
    let live = true
    load().then(next => {
      if (!live) { URL.revokeObjectURL(next); return }
      if (current.current) URL.revokeObjectURL(current.current)
      current.current = next
      setUrl(next)
    }).catch(() => undefined)
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => () => { if (current.current) URL.revokeObjectURL(current.current) }, [])
  return url
}
