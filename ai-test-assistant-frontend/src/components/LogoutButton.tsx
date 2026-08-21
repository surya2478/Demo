import React from 'react'

interface Props {
  onClick?: () => void
  className?: string
}

const LogoutButton: React.FC<Props> = ({ onClick, className = '' }) => {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-2xl border border-app-brand-200 bg-app-surface px-4 py-2.5 text-sm font-semibold text-app-brand-800 transition hover:bg-app-brand-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-app-brand-100 ${className}`.trim()}
      title="Logout"
    >
      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path fillRule="evenodd" d="M3 4a1 1 0 011-1h6a1 1 0 010 2H5v10h5a1 1 0 110 2H4a1 1 0 01-1-1V4z" clipRule="evenodd" />
        <path d="M13 7l3 3-3 3v-2H9V9h4V7z" />
      </svg>
      <span>Logout</span>
    </button>
  )
}

export default LogoutButton
