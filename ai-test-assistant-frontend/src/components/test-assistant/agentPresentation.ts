import type { AgentName, AgentProgress, CheckItem } from '../../services/aiChecksService'

export const parallelAgent = (name: AgentName) => name === 'expert_editor' || name === 'approval_manager'

export function agentState(name: AgentName, progress?: AgentProgress) {
  // Older saved runs recorded completion of the recovery review as success.
  if (name === 'expert_editor' && progress?.status === 'done' && /recovery needs attention|recovery review unavailable/i.test(progress.message || '')) return 'failed'
  return progress?.status || 'waiting'
}

export function caseStatus(item: CheckItem) {
  if (item.status === 'running') return 'Running'
  if (item.status === 'queued') return 'Queued'
  if (item.status === 'stopped') return 'Stopped'
  if (item.status === 'failed') return item.evaluation_handoff ? 'Needs input · Evaluation' : 'Unresolved'
  if (item.status === 'awaiting_approval') return 'Awaiting decision'
  return item.classification === 'automation' ? 'Automation ready' : 'Checks complete · Review'
}

export function blockerSummary(name: AgentName, message: string) {
  if (name === 'expert_editor' && /recovery.*unavailable|AI review failed|LLMInvalidResponse/i.test(message))
    return 'The recovery review failed to return a usable decision. It did not repair the case. Completed browser evidence is retained.'
  if (/invalid credentials?|rejected the configured|incorrect password/i.test(message))
    return 'The website rejected the test login. Correct the authorized credentials here; protected steps are on hold.'
  if (name === 'navigation_guide' && /unresolved|screen_id|element_id|proposed mapping/i.test(message)) {
    const missing = message.match(/Steps?\s+(\d+(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*-\s*)\d+)*)\s+(?:are\s+all\s+|are\s+|all\s+)?(?:unresolved|have no|lack)/i)
    return `The browser evidence does not identify the page controls needed for ${missing ? 'steps ' + missing[1] : 'one or more actions'}. The agent cannot safely turn those actions into clicks or verify their results. Dependent execution is on hold; the missing page/control evidence is available for resolution in Human Evaluation.`
  }
  return message
}
