import React, { createContext, useEffect, useState } from 'react'
import authService from '../services/authService'
import type { User } from '../types'
import ChangePasswordModal from '../components/ChangePasswordModal'
import auditService from '../services/auditService'

type AuthContextValue = {
  token: string | null
  user: User | null
  loading: boolean
  isAuthenticated: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => void
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('authToken'))
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  // Controls showing the forced-change modal; blocks app interaction
  const [forceChangeOpen, setForceChangeOpen] = useState(false)

  useEffect(() => {
    const initAuth = async () => {
      if (token) {
        try {
          const userData = await authService.getCurrentUser()
          setUser(userData)
          // console.log('from AuthContext tsx Fetched user on initAuth:', userData)  
          // Do NOT change forceChangeOpen here — we only show the modal right after a login event.
          // Removing the setForceChangeOpen(false) prevents a race where initAuth clears the modal opened by login.
          // setForceChangeOpen(false) // <-- removed
        } catch (error) {
          console.error('Failed to fetch user:', error)
          // Invalid token, clean up and require login
          setToken(null)
          localStorage.removeItem('authToken')
        }
      }
      setLoading(false)
    }

    initAuth()
  }, [token])

  const login = async (username: string, password: string) => {
    try {
      setLoading(true)
      const response = await authService.login(username, password)
      const accessToken = response.access_token

      // Save token first (needed for subsequent /me and change-password calls)
      localStorage.setItem('authToken', accessToken ?? '')
      setToken(accessToken ?? '')

      // Then fetch user data
      const userData = await authService.getCurrentUser()
      console.log('from AuthContext tsx Fetched user on login:', userData) 
      localStorage.setItem('username', userData.username) 
      // support both snake_case and camelCase until service mapping is consolidated
      const mustChange = (userData as any).mustChangePassword ?? (userData as any).must_change_password ?? false
      // console.log('mustChangePassword:', mustChange)

      setUser(userData)

      // If server indicates password must be changed, show modal ONLY on login
      if (mustChange) {
         console.log('Opening change password modal')
         setForceChangeOpen(true)
      }
    } catch (error) {
      console.error('Login failed:', error)
      throw error
    } finally {
      setLoading(false)
    }
  }

  const logout = () => {
    
    auditService.logEvent({
      actor: user?.username,
      actor_id: user?.id ? String(user.id) : undefined,
      actor_role: user?.role,
      action: 'Logout',
      resource_id: 'AuthContext',
      resource_name: 'Auth Context',
      resource_type: 'context',
      module: 'Authentication',
      status: 'success',
      details: {
        description: `${user?.username} has successfully logged out.`
      }
    })


    setToken(null)
    setUser(null)
    localStorage.removeItem('authToken')
    setForceChangeOpen(false)

    
  }

  // Called after successful password change: refresh user and close modal
  const onPasswordChangeSuccess = async () => {
    try {
      setLoading(true)
      const updated = await authService.getCurrentUser()
      setUser(updated)
      console.log('Password changed. Updated user:', updated)
      setForceChangeOpen(false)
    } catch (err) {
      console.error('Failed to refresh user after password change:', err)
    } finally {
      setLoading(false)
    }
  }

  // compute accessible auth state: user must change password to be blocked from app navigation
  const canAccessApp = !!token && !((user as any)?.mustChangePassword ?? (user as any)?.must_change_password)

  return (
    <AuthContext.Provider
      value={{
        token,
        user,
        loading,
        isAuthenticated: canAccessApp,
        login,
        logout,
      }}
    >
      {/* App children are rendered but interaction is blocked by the modal overlay while forceChangeOpen is true */}
      {children}

      <ChangePasswordModal
        open={forceChangeOpen}
        onSuccess={onPasswordChangeSuccess}
      />
    </AuthContext.Provider>
  )
}

interface LoginResponse {
  access_token: string
}

// const authService = {
//   async login(username: string, password: string): Promise<LoginResponse> {
//     const response = await fetch('/api/auth/login', {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify({ username, password }),
//     })
//     return response.json()
//   },

//   async getCurrentUser(): Promise<User> {
//     const response = await fetch('/api/auth/me')
//     return response.json()
//   },
// }

// export default AuthProvider