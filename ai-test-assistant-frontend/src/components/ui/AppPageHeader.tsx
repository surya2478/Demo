import React from 'react'

interface AppPageHeaderProps {
  eyebrow?: string
  title: string
  description?: string
  actions?: React.ReactNode
  compact?: boolean
}

const AppPageHeader: React.FC<AppPageHeaderProps> = ({
  eyebrow,
  title,
  description,
  actions,
  compact = false
}) => {
  return (
    <div
      className={`flex flex-col gap-3 ${
        compact ? '' : 'mb-1'
      } lg:flex-row lg:items-start lg:justify-between`}
    >
      <div className="min-w-0 space-y-1">
        {eyebrow ? (
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-app-brand-700">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-app-primary sm:text-[26px]">
          {title}
        </h1>
        {description ? (
          <p className="max-w-3xl text-sm text-app-secondary">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">{actions}</div>
      ) : null}
    </div>
  )
}

export default AppPageHeader
