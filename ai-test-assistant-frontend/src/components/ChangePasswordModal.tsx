import React, { useState, useMemo, useContext } from 'react'
import authService from '../services/authService'
import { AuthContext } from '../context/AuthContext'
import { logApiEvent } from '../utils/auditApiHelper'

type Props = {
  open: boolean
  onSuccess: () => void
}

export const ChangePasswordModal: React.FC<Props> = ({ open, onSuccess }) => {
  const authContext = useContext(AuthContext)
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Get username from auth context
  const username = authContext?.user?.username ?? ''

  const valid = useMemo(() => {
    return newPassword.length >= 8 && newPassword === confirm
  }, [newPassword, confirm])

  if (!open) return null

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!valid || !username) {
      setError('Username not found')
      return
    }

    // Prepare audit log details
    const requestPayload = {
      username: username,
      newPassword: '****',
      currentPassword: currentPassword ? '****' : null
    }
    let auditStatus: 'success' | 'failure' = 'success'
    let responsePayload: any = null

    setLoading(true)
    setError(null)
    try {
      await authService.changePassword(newPassword, username)
      console.log('Password changed successfully')
      onSuccess()
      setNewPassword('')
      setConfirm('')
      setCurrentPassword('')

      responsePayload = { message: 'Password changed successfully' }

    } catch (err: any) {
      setError(err?.message ?? 'Failed to change password')
      auditStatus = 'failure'
      responsePayload =  error
      
    } finally {
      setLoading(false)
      // single audit log capturing request and success response
      try {
        await logApiEvent({
          user: authContext?.user,
          module: 'User Management',
          action: 'Change Password',
          resourceType: 'API',
          resourceId: 'changePassword',
          resourceName: 'Change Password',
          description: `${username} changed their password`,
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
    // overlay
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <form
        onSubmit={submit}
        className="relative z-10 w-full max-w-md bg-white rounded-xl shadow-2xl overflow-hidden transform transition-all"
        aria-modal="true"
        role="dialog"
      >
        {/* Header with red accent */}
        <div className="bg-gradient-to-r from-red-600 to-red-700 px-6 py-4">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
            </svg>
            Change Password
          </h2>
          <p className="text-red-50 text-sm mt-1">
            Update your password to continue
          </p>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {/* Current Password */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Current Password <span className="text-gray-400">(Optional)</span>
            </label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full px-4 py-2 border-2 border-red-200 rounded-lg focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-100 transition"
              placeholder="Enter current password"
            />
          </div>

          {/* New Password */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              New Password <span className="text-red-600">*</span>
            </label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-4 py-2 border-2 border-red-200 rounded-lg focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-100 transition"
              placeholder="Minimum 8 characters"
              minLength={8}
            />
            {newPassword && (
              <div className="mt-2 text-xs text-gray-600">
                <div className={`flex items-center gap-1 ${newPassword.length >= 8 ? 'text-green-600' : 'text-orange-600'}`}>
                  <span className={`w-2 h-2 rounded-full ${newPassword.length >= 8 ? 'bg-green-600' : 'bg-orange-600'}`} />
                  {newPassword.length >= 8 ? 'Strong password' : `${8 - newPassword.length} more characters needed`}
                </div>
              </div>
            )}
          </div>

          {/* Confirm Password */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Confirm Password <span className="text-red-600">*</span>
            </label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={`w-full px-4 py-2 border-2 rounded-lg focus:outline-none focus:ring-2 transition ${
                confirm && confirm !== newPassword
                  ? 'border-red-500 focus:border-red-600 focus:ring-red-100'
                  : 'border-red-200 focus:border-red-600 focus:ring-red-100'
              }`}
              placeholder="Re-enter new password"
            />
            {confirm && confirm !== newPassword && (
              <div className="mt-2 text-xs text-red-600 flex items-center gap-1">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
                Passwords do not match
              </div>
            )}
          </div>

          {/* Error Message */}
          {error && (
            <div className="p-3 bg-red-50 border-l-4 border-red-600 rounded">
              <div className="flex items-start gap-2">
                <svg className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
                <p className="text-red-800 text-sm font-medium">{error}</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer with Actions */}
        <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex items-center justify-end gap-3">
          <button
            type="submit"
            disabled={!valid || loading || !username}
            className={`px-6 py-2 rounded-lg font-semibold transition-all flex items-center gap-2 ${
              valid && !loading && username
                ? 'bg-red-600 hover:bg-red-700 text-white shadow-md hover:shadow-lg'
                : 'bg-gray-300 text-gray-500 cursor-not-allowed'
            }`}
          >
            {loading ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Updating...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                </svg>
                Update Password
              </>
            )}
          </button>
        </div>

        {/* Password Requirements Info */}
        <div className="px-6 py-3 bg-red-50 border-t border-red-100">
          <p className="text-xs text-red-800 font-medium">Password Requirements:</p>
          <ul className="text-xs text-red-700 mt-1 space-y-1">
            <li className="flex items-center gap-1">
              <span className={newPassword.length >= 8 ? 'text-green-600' : 'text-red-600'}>✓</span>
              Minimum 8 characters
            </li>
            <li className="flex items-center gap-1">
              <span className={newPassword === confirm && confirm ? 'text-green-600' : 'text-red-600'}>✓</span>
              Passwords must match
            </li>
          </ul>
        </div>
      </form>
    </div>
  )
}

export default ChangePasswordModal