import React from 'react'

interface ChartCardProps {
  title: string
  subtitle?: string
  actions?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  className?: string
}

const ChartCard: React.FC<ChartCardProps> = ({
  title,
  subtitle,
  actions,
  children,
  footer,
  className = ''
}) => (
  <section className={`flex flex-col rounded-app-lg border border-app bg-app-surface shadow-app-card ${className}`.trim()}>
    <div className="flex flex-col gap-3 border-b border-app px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h3 className="text-base font-semibold text-app-primary">{title}</h3>
        {subtitle && <p className="mt-0.5 text-sm text-app-secondary">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
    <div className="flex-1 px-5 py-4">{children}</div>
    {footer && <div className="border-t border-app px-5 py-3 text-sm text-app-secondary">{footer}</div>}
  </section>
)

export default ChartCard
