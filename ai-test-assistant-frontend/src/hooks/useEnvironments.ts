import { useEffect, useState } from 'react'
import testDataService, { type ManagedEnvironment } from '../services/testDataService'

// The managed environment list, shared by every environment choice on the
// page. Loaded once; Manage environments publishes changes so every dropdown
// updates without a reload. Until it loads (or if it cannot), the defaults.

export const DEFAULT_ENVIRONMENTS = ['SIT', 'QA', 'UAT', 'RC', 'PREPRODUCTION']

let current: ManagedEnvironment[] | null = null
let pending: Promise<void> | null = null
const listeners = new Set<(list: ManagedEnvironment[]) => void>()

export const publishEnvironments = (list: ManagedEnvironment[]) => {
  current = list
  listeners.forEach(fn => fn(list))
}

export const reloadEnvironments = (): Promise<void> => {
  pending = testDataService.environments().then(publishEnvironments).catch(() => undefined).finally(() => { pending = null })
  return pending
}

/** The environment names, in order. */
export const useEnvironments = (): { names: string[]; list: ManagedEnvironment[] | null } => {
  const [list, setList] = useState<ManagedEnvironment[] | null>(current)
  useEffect(() => {
    listeners.add(setList)
    if (!current && !pending) void reloadEnvironments()
    return () => { listeners.delete(setList) }
  }, [])
  return { names: list?.map(e => e.name) ?? DEFAULT_ENVIRONMENTS, list }
}
