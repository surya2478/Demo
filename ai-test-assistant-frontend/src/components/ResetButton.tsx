import React from 'react'

interface Props {
  onClick?: () => void
  className?: string
  title?: string
  disabled?: boolean
}

const ResetButton: React.FC<Props> = ({ onClick, className = '', title = 'Reset', disabled = false }) => {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`inline-flex items-center space-x-2 px-3 py-1.5 rounded-md border-2 border-red-600 text-red-600 bg-white hover:bg-red-600 hover:text-white transition ${className}`}
      disabled={disabled}
    >
      {/* professional circular refresh icon */}
      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v6h6M20 20v-6h-6" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20.49 9A9 9 0 105.5 19.5" />
      </svg>
      <span className="text-sm font-medium">{title}</span>
    </button>
  )
}

export default ResetButton