import React, { useState, useEffect, useRef } from 'react'
import userService from '../services/userService'
import type { User } from '../types'
import { useAuth } from '../hooks/useAuth'
import { logApiEvent } from '../utils/auditApiHelper'

interface Props {
  isOpen: boolean
  user: User | null
  onClose: () => void
  onSaved: (user: User) => void
}

const roleOptions = [
  { value: 'user', label: 'User' },
  { value: 'manager', label: 'Manager' },
  { value: 'admin', label: 'Admin' },
  { value: 'tester', label: 'Tester' },
  { value: 'solution', label: 'Solution' },
  { value: 'tester_level_2', label: 'Tester Level 2' },
  { value: 'code_changes', label: 'Code Changes' },
]

const EditUserModal: React.FC<Props> = ({ isOpen, user, onClose, onSaved }) => {
  const [role, setRole] = useState<string>(user?.role ?? '')
  const [isActive, setIsActive] = useState<boolean>( (user as any)?.is_active ?? true )
  const [tokenAllocation, setTokenAllocation] = useState<number>((user as any)?.token_allocation ?? 10000)
  const [allowedTimeStart, setAllowedTimeStart] = useState<string>((user as any)?.allowed_time_start ?? '')
  const [allowedTimeEnd, setAllowedTimeEnd] = useState<string>((user as any)?.allowed_time_end ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fieldValuesRef = useRef<Record<string, string>>({})
  const focusedFieldRef = useRef<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const authUser = useAuth();
  
  // --- Track original user for comparison ---
  const originalUserRef = useRef<User | null>(null)
  useEffect(() => {
    setRole(user?.role ?? '')
    setError(null)
    originalUserRef.current = user ? { ...user } : null
    setIsActive((user as any)?.is_active ?? true)
    setTokenAllocation((user as any)?.token_allocation ?? 10000)
    setAllowedTimeStart((user as any)?.allowed_time_start ?? '')
    setAllowedTimeEnd((user as any)?.allowed_time_end ?? '')
  }, [user])

  /**
 * Build session info (masked)
 */
  const buildSessionInfo = (authUser: any): any => {
    if (!authUser) return null;
    // simple session id generation (hash of user + timestamp)
    const sessionId = `${String(authUser.username || 'user').slice(0, 6)}-${Math.random().toString(36).slice(2, 8)}...${Date.now().toString(36).slice(-4)}`;
    return {
      session_id: sessionId,
      status: 'active'
      // expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() // +2hrs
    };
  };

  /**
 * Build environment/context info
 */
  const buildEnvironmentInfo = (): any => {
    return {
      ip: 'CLIENT_IP', // backend will fill this
      user_agent: navigator.userAgent,
      source: 'web',
      platform: navigator.platform,
      language: navigator.language
    };
  };

  if (!isOpen || !user) return null

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    
    let auditStatus: 'success' | 'failure' = 'success'
    const requestPayload = { 
      user: user.username, 
      role, 
      is_active: isActive,
      token_allocation: tokenAllocation,
      allowed_time_start: allowedTimeStart,
      allowed_time_end: allowedTimeEnd
    }
    let responsePayload: any = null

    try {
      // Pass username (backend expects username)
      const payload: any = { 
        role, 
        is_active: isActive, 
        token_allocation: tokenAllocation,
        allowed_time_start: allowedTimeStart || null,
        allowed_time_end: allowedTimeEnd || null
      }
      const res = await userService.update(user!.username ?? user!.email, payload)

      // const res = await userService.update(user!.username ?? user!.email, { role })
      const updated = ((res as any)?.user ?? (res as any)?.data ?? res) as User
      onSaved(updated)
      onClose()

     
      responsePayload = updated
      
    } catch (err: any) {
      console.error('Failed to update user role or active status:', err)
      const detail = err?.response?.data?.detail ?? err?.response?.data?.message ?? err?.message
      setError(typeof detail === 'string' ? detail : 'Failed to update user')
      auditStatus = 'failure'
      responsePayload =  detail
    } finally {
      setSaving(false)
      // single audit log capturing request and success response
      try {
        await logApiEvent({
          user: authUser.user,
          module: 'User Management',
          action: 'Update User',
          resourceType: 'API',
          resourceId: 'updateUser',
          resourceName: 'Update User',
          description: `updated user details for ${user.username ?? user.email}`,
          request: requestPayload,
          response: responsePayload,
          status: auditStatus
        })
      } catch (auditErr) {
        console.error('Failed to log audit event:', auditErr)
      }
    }
  }

  return (
     <div ref={containerRef}>
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      aria-modal="true"
      role="dialog"
      aria-labelledby="edit-user-title"
    >
      <div className="w-full max-w-4xl transform overflow-hidden rounded-xl shadow-2xl bg-white ring-1 ring-black/5">
        {/* Header */}
        <div className="bg-gradient-to-r from-red-600 to-red-700 px-6 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 id="edit-user-title" className="text-lg font-semibold text-white flex items-center gap-3">
                <svg className="w-5 h-5 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <path d="M6 2a2 2 0 00-2 2v2H3a1 1 0 00-1 1v6a1 1 0 001 1h14a1 1 0 001-1V7a1 1 0 00-1-1h-1V4a2 2 0 00-2-2H6zM8 9a1 1 0 112 0v2a1 1 0 11-2 0V9z" />
                </svg>
                Edit User
              </h3>
              <p className="text-red-100 text-sm mt-1">Update user role and settings</p>
            </div>

            <button
              data-audit-name="Close Edit User Modal"
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-red-100 hover:text-white rounded-full p-1"
            >
              <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                <path fillRule="evenodd" d="M6.293 6.293a1 1 0 011.414 0L10 8.586l2.293-2.293a1 1 0 011.414 1.414L11.414 10l2.293 2.293a1 1 0 01-1.414 1.414L10 11.414l-2.293 2.293a1 1 0 01-1.414-1.414L8.586 10 6.293 7.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-6 space-y-4">
          {error && (
            <div className="rounded-md bg-red-50 border-l-4 border-red-600 p-3">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 text-red-600 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm-1-9V6a1 1 0 112 0v3a1 1 0 11-2 0zm1 4a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5z" clipRule="evenodd" />
                </svg>
                <p className="text-sm text-red-800">{error}</p>
              </div>
            </div>
          )}

          {/* Two Column Layout */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">User Name</label>
              <div className="text-sm text-gray-800 p-2 bg-gray-50 rounded-lg border border-red-100">
                {user.username ?? user.email}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Role</label>
              <select
                data-audit-name="Changed User Role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full px-4 py-2 border-2 border-red-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-100 focus:border-red-600 transition"
              >
                {roleOptions.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Active Status</label>
              <select
                data-audit-name="Changed User Active State"
                value={isActive ? '1' : '0'}
                onChange={(e) => setIsActive(e.target.value === '1')}
                className="w-full px-4 py-2 border-2 border-red-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-100 focus:border-red-600 transition"
              >
                <option value="1">Active</option>
                <option value="0">Inactive</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Token Allocation</label>
              <input
                data-audit-name="Changed Token Allocation"
                type="number"
                min="0"
                value={tokenAllocation}
                onChange={(e) => setTokenAllocation(parseInt(e.target.value) || 0)}
                className="w-full px-4 py-2 border-2 border-red-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-100 focus:border-red-600 transition"
              />
            </div>

            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-2">Require Password Change</label>
              <div className="text-sm text-gray-800 p-2 bg-gray-50 rounded-lg border border-red-100">
                {(user as any)?.must_change_password ? 'Yes - User must change password on next login' : 'No - User can login with current password'}
              </div>
            </div>
          </div>

          {/* Time Slot Management */}
          <div className="border-2 border-amber-200 rounded-lg p-4 bg-amber-50/30">
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-5 h-5 text-amber-600" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
              </svg>
              <label className="text-sm font-semibold text-gray-800">Time Slot Restrictions</label>
            </div>
            
            {/* Quick Presets */}
            <div className="mb-3">
              <p className="text-xs text-gray-600 mb-2">Quick Presets:</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => { setAllowedTimeStart('08:00'); setAllowedTimeEnd('12:00') }}
                  className="px-3 py-1.5 text-xs font-medium bg-white border-2 border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 transition-colors"
                >
                  8 AM - 12 PM
                </button>
                <button
                  type="button"
                  onClick={() => { setAllowedTimeStart('12:00'); setAllowedTimeEnd('16:00') }}
                  className="px-3 py-1.5 text-xs font-medium bg-white border-2 border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 transition-colors"
                >
                  12 PM - 4 PM
                </button>
                <button
                  type="button"
                  onClick={() => { setAllowedTimeStart('16:00'); setAllowedTimeEnd('20:00') }}
                  className="px-3 py-1.5 text-xs font-medium bg-white border-2 border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 transition-colors"
                >
                  4 PM - 8 PM
                </button>
                <button
                  type="button"
                  onClick={() => { setAllowedTimeStart('08:00'); setAllowedTimeEnd('17:00') }}
                  className="px-3 py-1.5 text-xs font-medium bg-white border-2 border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 transition-colors"
                >
                  8 AM - 5 PM
                </button>
                <button
                  type="button"
                  onClick={() => { setAllowedTimeStart(''); setAllowedTimeEnd('') }}
                  className="px-3 py-1.5 text-xs font-medium bg-white border-2 border-green-300 text-green-700 rounded-lg hover:bg-green-50 transition-colors"
                >
                  24/7 Access
                </button>
              </div>
            </div>

            {/* Custom Time Inputs */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Start Time (Dubai Time)</label>
                <input
                  data-audit-name="Changed Time Start"
                  value={allowedTimeStart}
                  onChange={(e) => setAllowedTimeStart(e.target.value)}
                  type="time"
                  className="w-full px-3 py-2 border-2 border-amber-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-200 focus:border-amber-500 transition text-sm"
                  placeholder="HH:MM"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">End Time (Dubai Time)</label>
                <input
                  data-audit-name="Changed Time End"
                  value={allowedTimeEnd}
                  onChange={(e) => setAllowedTimeEnd(e.target.value)}
                  type="time"
                  className="w-full px-3 py-2 border-2 border-amber-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-200 focus:border-amber-500 transition text-sm"
                  placeholder="HH:MM"
                />
              </div>
            </div>

            <p className="mt-2 text-xs text-amber-700 flex items-start gap-1">
              <svg className="w-3.5 h-3.5 shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
              </svg>
              <span>Leave empty for 24/7 access. User can only login during specified time slots (Dubai timezone).</span>
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex items-center justify-end gap-3">
          <button
            data-audit-name="Cancel Edit User"
            onClick={onClose}
            className="px-4 py-2 rounded-md border-2 border-gray-200 bg-white text-gray-700 hover:border-red-500 hover:text-red-600 transition"
            disabled={saving}
          >
            Cancel
          </button>

          <button
            data-audit-name="Save Edited User"
            onClick={handleSave}
            disabled={saving}
            className={`inline-flex items-center gap-2 px-5 py-2 rounded-md font-semibold transition ${
              saving ? 'bg-red-500/80 text-white' : 'bg-red-600 hover:bg-red-700 text-white shadow'
            }`}
          >
            {saving ? (
              <>
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                Saving...
              </>
            ) : (
              'Save'
            )}
          </button>
        </div>
      </div>
    </div>
    </div>
  )
}

export default EditUserModal