import React from 'react'
import { useAuth } from '../hooks/useAuth'
import { theme } from '../styles/theme'
import LogoutButton from './LogoutButton'

const Navbar: React.FC = () => {
  const { user, logout } = useAuth()

  return (
    <header className="bg-white border-b border-red-100 p-4 flex items-center justify-between">
      <div className="text-lg font-semibold text-red-600">Test Case Intelligence Platform</div>
      <div className="flex items-center gap-4">
        {/* <div className="text-sm text-red-600">{user?.username ?? 'Unknown'}</div> */}
        {/* <button onClick={logout} className={theme.button.secondary}>
          Logout
        </button> */}
        <LogoutButton onClick={logout} />
      </div>
    </header>
  )
}

export default Navbar