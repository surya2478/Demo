import React, { useEffect } from 'react'

interface Props {
  message: string
  type: 'success' | 'error'
  onClose: () => void
  duration?: number
}

const Notification: React.FC<Props> = ({ message, type, onClose, duration = 3000 }) => {
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose()
    }, duration)

    return () => clearTimeout(timer)
  }, [duration, onClose])

  return (
    <div className="fixed inset-x-0 top-4 z-50 flex items-center justify-center px-4">
      <div
        className={`flex items-center gap-3 rounded-2xl border px-5 py-3 shadow-app-card ${
          type === 'success'
            ? 'border-green-100 bg-green-50 text-green-800'
            : 'border-red-100 bg-red-50 text-red-800'
        }`}
      >
        <span className="font-medium">{message}</span>
        <button
          onClick={onClose}
          className="rounded-full p-1 text-current/70 transition hover:bg-black/5 hover:text-current"
        >
          x
        </button>
      </div>
    </div>
  )
}

export default Notification
