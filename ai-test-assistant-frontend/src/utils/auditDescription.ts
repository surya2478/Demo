/**
 * Generate a human-readable description for navigation and key user actions.
 * Use this helper throughout the frontend for all audit log descriptions.
 */

import { act } from "react";

type ActionType =
  | 'navigate'
  | 'add'
  | 'edit'
  | 'delete'
  | 'update'
  | 'setting_change'
  | 'login'
  | 'logout'
  | 'view'
  | 'download'
  | 'upload'
  | 'other';

interface AuditDescriptionParams {
  action: ActionType;
  module: string;
  submodule?: string;
  resourceName?: string;
  from?: string;
  to?: string;
  changes?: Record<string, { previous: any; new: any }>;
  reason?: string;
  extra?: string;
  actor?: string; // Add actor for personalized messages
}

export function buildAuditDescription(params: AuditDescriptionParams): string {
  const {
    action,
    module,
    submodule,
    resourceName,
    from,
    to,
    changes,
    reason,
    extra,
    actor,
  } = params;

  const mod = submodule ? `${module} > ${submodule}` : module;
  

  switch (action) {
    case 'navigate':
      if (from && to) {
        return `${actor} navigated from "${from}" to "${to}" in ${mod}.`;
      }
      if (to) {
        return `${actor} accessed "${to}" in ${mod}.`;
      }
      return `${actor} navigated in ${mod}.`;

    case 'add':
      return `${actor} added ${resourceName ? `"${resourceName}" ` : ''}in ${mod}.`;

    case 'edit':
      if (changes && resourceName) {
        // If only one field changed, use a more specific message
        const fields = Object.entries(changes);
        if (fields.length === 1) {
          const [field, { previous, new: newVal }] = fields[0];
          return `${actor} updated ${field} for ${resourceName}: changed from '${previous ?? '[empty]'}' to '${newVal ?? '[empty]'}'.`;
        } else {
          const fieldList = fields
            .map(
              ([field, { previous, new: newVal }]) =>
                `"${field}" from '${previous ?? '[empty]'}' to '${newVal ?? '[empty]'}'`
            )
            .join(', ');
          return `${actor} edited "${resourceName}" in ${mod}: changed ${fieldList}.`;
        }
      }
      return `${actor} edited ${resourceName ? `"${resourceName}" ` : ''}in ${mod}.`;

    case 'delete':
      return `${actor} deleted ${resourceName ? `"${resourceName}" ` : ''}in ${mod}.`;

    case 'update':
      return `${actor} updated ${resourceName ? `"${resourceName}" ` : ''}in ${mod}.`;

    case 'setting_change':
      return `${actor} changed settings${resourceName ? ` for "${resourceName}"` : ''} in ${mod}${reason ? ` (Reason: ${reason})` : ''}.`;

    case 'login':
      return `${actor} logged in to ${mod}.`;

    case 'logout':
      return `${actor} logged out from ${mod}.`;

    case 'view':
      return `${actor} viewed ${resourceName ? `"${resourceName}" ` : ''}in ${mod}.`;

    case 'download':
      return `${actor} downloaded ${resourceName ? `"${resourceName}" ` : ''}from ${mod}.`;

    case 'upload':
      return `${actor} uploaded ${resourceName ? `"${resourceName}" ` : ''}to ${mod}.`;

    default:
      return `${actor} performed ${action} in ${mod}${resourceName ? ` on "${resourceName}"` : ''}${extra ? ` (${extra})` : ''}.`;
  }
}