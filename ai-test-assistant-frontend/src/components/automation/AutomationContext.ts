/**
 * --- Automation Module: workspace context -------------------------------
 *
 * Runtime status is fetched once by the workspace shell and shared with both
 * tabs. Asking twice for the same answer would put two subprocess probes on a
 * host that is also running browsers.
 *
 * This lives in its own module rather than on the shell page so the tabs never
 * import `../Automation` — that specifier differs from the `pages/automation`
 * directory only by case, which resolves on Windows and is a coin toss
 * elsewhere.
 */
import { useOutletContext } from 'react-router-dom'
import type { RuntimeStatusResponse } from '../../types/automation'

export interface AutomationContext {
  runtime: RuntimeStatusResponse | null
  runtimeLoading: boolean
  runtimeError: string | null
  reloadRuntime: () => void
  /**
   * Shapes the UI only. The server enforces automation.execute through
   * require_permission, so a hidden button is a courtesy, not the control.
   */
  canExecute: boolean
  /** The header search ("Search scripts, runs, test cases…"), lower-cased. */
  query: string
  /** The tab cards' counts: Script Lab cases and runs executing now. */
  setLabCount: (count: number) => void
  setLiveRuns: (count: number) => void
}

export function useAutomationContext(): AutomationContext {
  return useOutletContext<AutomationContext>()
}
