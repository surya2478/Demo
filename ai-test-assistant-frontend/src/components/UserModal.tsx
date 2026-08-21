import React, { useState, useEffect } from 'react'
import userService from '../services/userService'
import { logApiEvent } from '../utils/auditApiHelper'
import useAuth from '../hooks/useAuth'

interface UserModalProps {
  isOpen: boolean
  onClose: () => void
  onUserCreated: (user: any) => void // Adjust type as needed
}

const UserModal: React.FC<UserModalProps> = ({ isOpen, onClose, onUserCreated }) => {
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    role: 'user',
    must_change_password: true,
    token_allocation: 10000,
    auth_source: 'ldap', // Default to LDAP authentication
    allowed_time_start: '',
    allowed_time_end: '',
    is_active: true,
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const authUser = useAuth();

  useEffect(() => {
    if (!isOpen) {
      setFormData({
        username: '',
        email: '',
        password: '',
        role: 'user',
        must_change_password: true,
        token_allocation: 10000,
        auth_source: 'ldap',
        allowed_time_start: '',
        allowed_time_end: '',
        is_active: true,
      })
      setError(null)
    }
  }, [isOpen])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, type } = e.target as HTMLInputElement
    const value = type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value
    setFormData((prev) => ({ ...prev, [name]: value }))
  }

  const validate = () => {
    if (!formData.username.trim()) return 'Username is required'
    if (!formData.email.trim()) return 'Email is required'
    if (!/^\S+@\S+\.\S+$/.test(formData.email)) return 'Email is invalid'
    if (!formData.password || formData.password.length < 8) return 'Password must be at least 8 characters'
    return null
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    // Prepare audit log details
    const requestPayload = {
      username: formData.username.trim(),
      email: formData.email.trim(),
      role: formData.role,
      must_change_password: !!formData.must_change_password,
    }
    let auditStatus: 'success' | 'failure' = 'success'
    let responsePayload: any = null

    const v = validate()
    if (v) {
      setError(v)
      return
    }

    setLoading(true)
    try {
      const payload = {
        username: formData.username.trim(),
        email: formData.email.trim(),
        password: formData.password,
        role: formData.role,
        must_change_password: !!formData.must_change_password,
        token_allocation: formData.token_allocation,
        auth_source: formData.auth_source,
        allowed_time_start: formData.allowed_time_start || null,
        allowed_time_end: formData.allowed_time_end || null,
        is_active: formData.is_active,
      }
      console.log('Creating user with payload:', payload);
      const response = await userService.create(payload)
      // response may be { user: User }, { data: User } or the User object directly
      let createdUser: any
      if (response && typeof response === 'object') {
        if ('user' in response) {
          createdUser = (response as any).user
        } else if ('data' in (response as any)) {
          createdUser = (response as any).data
        } else {
          createdUser = response
        }
      } else {
        createdUser = response
      }
      onUserCreated(createdUser)
      onClose()
      setFormData({
        username: '',
        email: '',
        password: '',
        role: 'user',
        must_change_password: true,
        token_allocation: 10000,
        auth_source: 'ldap',
        allowed_time_start: '',
        allowed_time_end: '',
        is_active: true,
      })

      responsePayload = createdUser

    } catch (err: any) {
      console.error('Create user error:', err)
      const errorDetail = err?.response?.data?.detail ?? err?.response?.data ?? err?.message
      if (Array.isArray(errorDetail)) {
        setError(errorDetail.map((d: any) => d.msg || JSON.stringify(d)).join('; '))
      } else if (typeof errorDetail === 'string') {
        setError(errorDetail)
      } else {
        setError('Failed to create user')
      }
      auditStatus = 'failure'
      responsePayload = errorDetail

    } finally {
      setLoading(false)
     // single audit log capturing request and success response
      try {
        await logApiEvent({
          user: authUser.user,
          module: 'User Management',
          action: 'Create User',
          resourceType: 'API',
          resourceId: 'createUser',
          resourceName: 'Create User',
          description: `created new user ${formData.username.trim()}`,
          request: requestPayload,
          response: responsePayload,
          status: auditStatus
        })
      } catch (auditErr) {
        console.error('Failed to log audit event:', auditErr)
      }


    }
  }

  const handleClose = () => {
    setFormData({
      username: '',
      email: '',
      password: '',
      role: 'user',
      must_change_password: true,
      token_allocation: 10000,
      auth_source: 'ldap',
      allowed_time_start: '',
      allowed_time_end: '',
      is_active: true,
    })
    setError(null)
    onClose()
  }

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 sm:p-6 overflow-y-auto"
      aria-modal="true"
      role="dialog"
      aria-labelledby="create-user-title"
    >
      <div className="w-full max-w-4xl my-8 transform rounded-xl shadow-2xl bg-white ring-1 ring-black/5 flex flex-col max-h-[calc(100vh-4rem)]">
        {/* Header - Fixed */}
        <div className="bg-gradient-to-r from-red-600 to-red-700 px-6 py-4 rounded-t-xl flex-shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <h3 id="create-user-title" className="text-lg font-semibold text-white flex items-center gap-3">
                <svg className="w-5 h-5 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <path d="M10 2a4 4 0 00-4 4v2H5a2 2 0 00-2 2v4a2 2 0 002 2h10a2 2 0 002-2v-4a2 2 0 00-2-2h-1V6a4 4 0 00-4-4z" />
                </svg>
                Create New User
              </h3>
              <p className="text-red-100 text-sm mt-1">Create account and set initial password / must-change flag.</p>
            </div>
            <button
              type="button"
              onClick={handleClose}
              aria-label="Close modal"
              className="text-red-100 hover:text-white rounded-full p-1.5 hover:bg-red-800 transition-colors"
            >
              <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                <path fillRule="evenodd" d="M6.293 6.293a1 1 0 011.414 0L10 8.586l2.293-2.293a1 1 0 011.414 1.414L11.414 10l2.293 2.293a1 1 0 01-1.414 1.414L10 11.414l-2.293 2.293a1 1 0 01-1.414-1.414L8.586 10 6.293 7.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body - Scrollable */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto">
          <div className="px-6 py-5 space-y-4">
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
              <label className="block text-sm font-medium text-gray-700 mb-2">Username *</label>
              <input
                name="username"
                value={formData.username}
                onChange={handleChange}
                required
                className="w-full px-4 py-2 border-2 border-red-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-100 focus:border-red-600 transition"
                placeholder="username"
                autoComplete="username"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Email *</label>
              <input
                name="email"
                value={formData.email}
                onChange={handleChange}
                required
                type="email"
                className="w-full px-4 py-2 border-2 border-red-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-100 focus:border-red-600 transition"
                placeholder="email@example.com"
                autoComplete="email"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Password *</label>
              <input
                name="password"
                value={formData.password}
                onChange={handleChange}
                required
                type="password"
                className="w-full px-4 py-2 border-2 border-red-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-100 focus:border-red-600 transition"
                placeholder="At least 8 characters"
                autoComplete="new-password"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Role</label>
              <select
                name="role"
                value={formData.role}
                onChange={handleChange}
                className="w-full px-4 py-2 border-2 border-red-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-100 focus:border-red-600 transition"
              >
                <option value="user">User</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
                <option value="tester">Tester</option>
                <option value="solution">Solution</option>
                <option value="tester_level_2">Tester Level 2</option>
                <option value="code_changes">Code Changes</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Token Allocation</label>
              <input
                name="token_allocation"
                value={formData.token_allocation}
                onChange={handleChange}
                required
                type="number"
                min="0"
                className="w-full px-4 py-2 border-2 border-red-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-100 focus:border-red-600 transition"
                placeholder="10000"
              />
            </div>

            <div className="flex flex-col justify-center">
              <label className="inline-flex items-center mb-2">
                <input
                  name="is_active"
                  checked={!!formData.is_active}
                  onChange={handleChange}
                  type="checkbox"
                  className="h-4 w-4 rounded border-red-300 text-red-600 focus:ring-red-500"
                />
                <span className="ml-2 text-sm text-gray-700">Active User</span>
              </label>
              <label className="inline-flex items-center">
                <input
                  name="must_change_password"
                  checked={!!formData.must_change_password}
                  onChange={handleChange}
                  type="checkbox"
                  className="h-4 w-4 rounded border-red-300 text-red-600 focus:ring-red-500"
                />
                <span className="ml-2 text-sm text-gray-700">Must change password</span>
              </label>
            </div>
          </div>

          {/* Authentication Source - Full Width */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Authentication Source</label>
            <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border-2 border-gray-200">
              <label className="inline-flex items-center cursor-pointer">
                <input
                  name="auth_source"
                  checked={formData.auth_source === 'ldap'}
                  onChange={(e) => {
                    setFormData((prev) => ({
                      ...prev,
                      auth_source: e.target.checked ? 'ldap' : 'local'
                    }))
                  }}
                  type="checkbox"
                  className="h-4 w-4 rounded border-red-300 text-red-600 focus:ring-red-500"
                />
                <span className="ml-2 text-sm font-medium text-gray-700">
                  Use LDAP Authentication
                </span>
              </label>
              <span className="ml-auto text-xs font-semibold px-2 py-1 rounded-full">
                {formData.auth_source === 'ldap' ? (
                  <span className="rounded-full bg-app-brand-75 px-2 py-1 text-app-brand-800">LDAP</span>
                ) : (
                  <span className="text-green-700 bg-green-100 px-2 py-1 rounded-full">Local Database</span>
                )}
              </span>
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
                  onClick={() => setFormData(prev => ({ ...prev, allowed_time_start: '08:00', allowed_time_end: '12:00' }))}
                  className="px-3 py-1.5 text-xs font-medium bg-white border-2 border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 transition-colors"
                >
                  8 AM - 12 PM
                </button>
                <button
                  type="button"
                  onClick={() => setFormData(prev => ({ ...prev, allowed_time_start: '12:00', allowed_time_end: '16:00' }))}
                  className="px-3 py-1.5 text-xs font-medium bg-white border-2 border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 transition-colors"
                >
                  12 PM - 4 PM
                </button>
                <button
                  type="button"
                  onClick={() => setFormData(prev => ({ ...prev, allowed_time_start: '16:00', allowed_time_end: '20:00' }))}
                  className="px-3 py-1.5 text-xs font-medium bg-white border-2 border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 transition-colors"
                >
                  4 PM - 8 PM
                </button>
                <button
                  type="button"
                  onClick={() => setFormData(prev => ({ ...prev, allowed_time_start: '08:00', allowed_time_end: '17:00' }))}
                  className="px-3 py-1.5 text-xs font-medium bg-white border-2 border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 transition-colors"
                >
                  8 AM - 5 PM
                </button>
                <button
                  type="button"
                  onClick={() => setFormData(prev => ({ ...prev, allowed_time_start: '', allowed_time_end: '' }))}
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
                  name="allowed_time_start"
                  value={formData.allowed_time_start}
                  onChange={handleChange}
                  type="time"
                  className="w-full px-3 py-2 border-2 border-amber-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-200 focus:border-amber-500 transition text-sm"
                  placeholder="HH:MM"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">End Time (Dubai Time)</label>
                <input
                  name="allowed_time_end"
                  value={formData.allowed_time_end}
                  onChange={handleChange}
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

          {/* Actions - Fixed at bottom */}
          <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 rounded-b-xl flex-shrink-0">
            <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={handleClose}
              disabled={loading}
              className="px-5 py-2.5 rounded-lg border-2 border-gray-300 hover:border-red-500 hover:text-red-600 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={loading}
              className={`inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-lg font-semibold transition-all min-w-[140px] ${
                loading ? 'bg-red-500 text-white cursor-not-allowed' : 'bg-red-600 hover:bg-red-700 text-white shadow-md hover:shadow-lg'
              }`}
            >
              {loading ? (
                <>
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  Creating...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                    <path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" />
                  </svg>
                  Create User
                </>
              )}
            </button>
          </div>
          </div>
        </form>

        {/* Footer note - Fixed */}
        <div className="px-6 py-3 bg-red-50 border-t border-red-100 text-xs text-red-700 rounded-b-xl flex-shrink-0">
          <div className="flex items-start gap-2">
            <svg className="w-4 h-4 text-red-600 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
            <p>If "Require password change" is checked, the user will be forced to update their password on first login.</p>
          </div>
        </div>
      </div>
    </div>
  )
}

export default UserModal
