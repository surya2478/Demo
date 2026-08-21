import React from 'react'

interface SectionCardProps {
  title?: string
  description?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
  contentClassName?: string
  noPadding?: boolean
}

const SectionCard: React.FC<SectionCardProps> = ({
  title,
  description,
  actions,
  children,
  className = '',
  contentClassName = '',
  noPadding = false
}) => {
  return (
    <section className={`rounded-app-lg border border-app bg-app-surface shadow-app-card ${className}`.trim()}>
      {(title || description || actions) ? (
        <div className="flex flex-col gap-2 border-b border-app px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-0.5">
            {title ? <h2 className="text-base font-semibold text-app-primary">{title}</h2> : null}
            {description ? <p className="text-sm text-app-secondary">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={`${noPadding ? '' : 'px-5 py-5'} ${contentClassName}`.trim()}>{children}</div>
    </section>
  )
}

export default SectionCard
