import type { DiscoveredElement } from '../../types/automation'

export type SetupField = { id: string; name: string; page?: string; observed: boolean }
type InputEvidence = Omit<Pick<DiscoveredElement, 'id' | 'page_url' | 'role' | 'accessible_name' | 'recommended_locator' | 'confidence_score'>, 'id'> & { id: number | string }

const inputRole = (role: string | null) => ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes((role || '').toLowerCase())

/** Suggest names only from named, uniquely observed inputs on verified hosts. */
export const observedInputFields = (elements: InputEvidence[], host: string | string[]): SetupField[] => {
  const hosts = new Set(Array.isArray(host) ? host : [host])
  const groups = new Map<string, InputEvidence[]>()
  elements.forEach((element) => {
    try {
      if (!hosts.has(new URL(element.page_url).host) || !inputRole(element.role) ||
          !element.accessible_name?.trim() || !element.recommended_locator || element.confidence_score < 70) return
      const key = `${element.page_url}|${element.accessible_name.trim().toLowerCase()}`
      groups.set(key, [...(groups.get(key) || []), element])
    } catch { /* A malformed or different host supplies no fields. */ }
  })
  return Array.from(groups.values()).flatMap((group) => {
    // Two different controls with the same visible name cannot safely be
    // offered as one observed input. The user may add a field manually.
    if (new Set(group.map((element) => element.recommended_locator)).size !== 1) return []
    const element = group[0]
    return [{ id: `observed-${element.id}`, name: element.accessible_name!.trim(),
      page: element.page_url, observed: true }]
  })
}
