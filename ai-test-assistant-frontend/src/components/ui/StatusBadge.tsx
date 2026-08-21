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
  success: { wrap: 'bg-app-success-bg text-app-success border-green-200', dot: 'bg-app-success' },
  warning: { wrap: 'bg-app-warning-bg text-app-warning border-orange-200', dot: 'bg-app-warning' },
  danger: { wrap: 'bg-app-danger-bg text-app-danger border-red-200', dot: 'bg-app-danger' },
  info: { wrap: 'bg-app-info-bg text-app-info border-blue-200', dot: 'bg-app-info' },
  neutral: { wrap: 'bg-app-surface-muted text-app-secondary border-app', dot: 'bg-app-secondary' }
}

const sizeMap = {
  sm: 'px-2 py-0.5 text-[10px]',
  md: 'px-2.5 py-1 text-xs'
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
      className={`inline-flex items-center gap-1.5 rounded-full border font-semibold ${t.wrap} ${sizeMap[size]} ${className}`.trim()}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />}
      {children}
    </span>
  )
}

export default StatusBadge
