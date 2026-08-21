import React from 'react'

const Loader: React.FC = () => (
  <div className="flex items-center justify-center p-8">
    <div className="flex items-center gap-3 rounded-full border border-app bg-app-surface px-4 py-3 shadow-app-card">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-app-brand-100 border-t-app-brand-700" />
      <span className="text-sm font-medium text-app-secondary">Loading</span>
    </div>
  </div>
)

export default Loader
