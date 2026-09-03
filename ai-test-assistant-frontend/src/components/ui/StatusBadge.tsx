import React from 'react'

interface StatusBadgeProps {
  children: React.ReactNode
  tone?: 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'neutral'
  size?: 'sm' | 'md'
  dot?: boolean
  className?: string
}

const toneMap: Record<NonNullable<StatusBadgeProps['tone']>, { wrap: string; dot: string }> = {
  brand: { wrap: 'bg-app-brand-50 text-app-brand-800 border-app-brand-200', dot: 'bg-app-brand-600' },
  success: { wrap: 'bg-app-success-bg text-app-success border-app-success-border', dot: 'bg-app-success' },
  warning: { wrap: 'bg-app-warning-bg text-app-warning border-app-warning-border', dot: 'bg-app-warning' },
  danger: { wrap: 'bg-app-danger-bg text-app-danger border-app-danger-border', dot: 'bg-app-danger' },
  info: { wrap: 'bg-app-info-bg text-app-info border-app-info-border', dot: 'bg-app-info' },
  neutral: { wrap: 'bg-app-surface-muted text-app-secondary border-app', dot: 'bg-app-secondary' }
}

/**
 * `sm` is what every badge in the workbench table renders at, including the
 * one that blocks approval. It was 10px semibold; 12px medium is the same
 * visual weight at a size that can actually be read at a glance.
 */
const sizeMap = {
  sm: 'px-2 py-0.5 text-[12px]',
  md: 'px-2.5 py-1 text-[13px]'
}

const StatusBadge: React.FC<StatusBadgeProps> = ({
  children,
  tone = 'neutral',
  size = 'md',
  dot = false,
  className = ''
}) => {
  const t = toneMap[tone]
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-medium ${t.wrap} ${sizeMap[size]} ${className}`.trim()}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />}
      {children}
    </span>
  )
}

export default StatusBadge
