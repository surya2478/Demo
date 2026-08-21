import auditService from '../services/auditService'
import { buildDetailedFieldAudit, maskValue } from './auditDetailsHelper'
import type { User } from '../types'

type ApiStatus = 'initiated' | 'success' | 'failure' | 'error'

/**
 * Build and send an audit event describing an API request/response.
 * This wrapper centralizes request/response logging so you can reuse the same format
 * across the frontend.
 *
 * Example usage:
 *  logApiEvent({
 *    user, module: 'Knowledge Base', action: 'ask', resourceType: 'api_request',
 *    resourceId: 'kb_request', resourceName: 'Knowledge Base Query',
 *    request: requestPayload, status: 'initiated'
 *  })
 */
export const logApiEvent = async (params: {
  user?: User | null
  module: string
  submodule?: string
  action: string
  resourceType?: string
  resourceId?: string
  resourceName?: string
  description?: string
  request?: any
  response?: any
  status?: ApiStatus
}) => {
  try {
    const {
      user,
      module,
      submodule,
      action,
      resourceType,
      resourceId,
      resourceName,
      description,
      request,
      response,
      status = 'initiated'
    } = params

    /* Small helper to string safe payloads and mask sensitive values where needed */
    const safeStringify = (v: any) => {
      if (v === null || v === undefined) return null
      try {
        const s = typeof v === 'string' ? v : JSON.stringify(v)
        // mask if too long or contains sensitive shapes
        // if (typeof s === 'string' && s.length > 2000) return s.slice(0, 2000) + '…'
        return s
      } catch {
        return String(v)
      }
    }

    const requestStr = safeStringify(request)
    const responseStr = safeStringify(response)
    const desc = description || `API ${action} invoked`
    // Use the field-level builder to create consistent details
    const fieldLabel = resourceName || resourceId || action
    const details = buildDetailedFieldAudit(
      user ?? null,
      action,
      desc,
      (fieldLabel as string),
      responseStr ?? undefined, // treat response as new_value when applicable
      requestStr ?? undefined, // treat request as previous_value
      submodule
    )

    // attach request/response payloads as context fields as well
    if (requestStr) {
      details.context = details.context || {}
      details.context.request_payload = requestStr //maskValue('request', requestStr)
    }
    if (responseStr) {
      details.context = details.context || {}
      details.context.response_payload = responseStr //maskValue('response', responseStr)
    }

    await auditService.logEvent({
      actor: user?.username,
      actor_id: user?.id ? String(user.id) : undefined,
      actor_role: user?.role,
      module,
      submodule,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      resource_name: resourceName,
      status: status === 'error' ? 'failure' : status, 
      details
    })
  } catch (err) {
    // Non-blocking; logging should not break UI behaviour
    // Optionally, route to console for debugging
    // eslint-disable-next-line no-console
    console.warn('auditApiHelper.logApiEvent failed', err)
  }
}