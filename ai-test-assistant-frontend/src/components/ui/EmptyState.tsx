import React from 'react'

interface EmptyStateProps {
  title: string
  description?: string
  icon?: React.ReactNode
  action?: React.ReactNode
  className?: string
}

const EmptyState: React.FC<EmptyStateProps> = ({ title, description, icon, action, className = '' }) => {
  return (
    <div
      className={`rounded-app-lg border border-dashed border-app bg-app-surface-muted/50 px-6 py-10 text-center ${className}`.trim()}
    >
      <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-app bg-app-surface text-app-brand-700 shadow-app-card">
        {icon ?? <span className="text-lg font-semibold">i</span>}
      </div>
      <h3 className="text-base font-semibold text-app-primary">{title}</h3>
      {description ? (
        <p className="mx-auto mt-1.5 max-w-xl text-sm text-app-secondary">{description}</p>
      ) : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  )
}

export default EmptyState
