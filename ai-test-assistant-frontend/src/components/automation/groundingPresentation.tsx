/**
 * --- Automation Module: grounding presentation --------------------------
 *
 * The grounding badge, shared by the Discovery screen and the workbench grid
 * so a case never reads one way in one place and differently in the other.
 *
 * `partially_grounded` is the state worth designing for. It is the common
 * outcome and the useful one: some steps resolved, some did not, and the ones
 * that did not are exactly what a generator would otherwise invent locators
 * for. It gets a warning tone rather than a failure tone, because the case is
 * still worth generating -- with its gaps named.
 */
import React from 'react'
import StatusBadge from '../ui/StatusBadge'
import type { GroundingStatus } from '../../types/automation'

const META: Record<
  GroundingStatus,
  { tone: 'success' | 'warning' | 'danger' | 'neutral'; label: string; title: string }
> = {
  not_checked: {
    tone: 'neutral',
    label: 'Not checked',
    title: 'This case has not been matched against a discovered application yet.'
  },
  grounded: {
    tone: 'success',
    label: 'Grounded',
    title: 'Every step that names a control resolved to one that really exists.'
  },
  partially_grounded: {
    tone: 'warning',
    label: 'Partial',
    title: 'Some steps resolved and some did not. The unresolved ones are named.'
  },
  ungrounded: {
    tone: 'danger',
    label: 'Ungrounded',
    title: 'No step resolved to a discovered element, or no step names a control at all.'
  }
}

export const GroundingBadge: React.FC<{ status: GroundingStatus; count?: number }> = ({
  status,
  count
}) => {
  const meta = META[status] ?? META.not_checked
  return (
    <span title={meta.title}>
      <StatusBadge tone={meta.tone} size="sm" dot={status === 'partially_grounded'}>
        {meta.label}
        {typeof count === 'number' ? ` ${count}` : ''}
      </StatusBadge>
    </span>
  )
}

export default GroundingBadge
