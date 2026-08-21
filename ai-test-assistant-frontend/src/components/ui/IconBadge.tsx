import React from 'react'

interface IconBadgeProps {
  children: React.ReactNode
  tone?: 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'neutral'
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const toneMap: Record<NonNullable<IconBadgeProps['tone']>, string> = {
  brand: 'bg-app-brand-50 text-app-brand-700',
  success: 'bg-app-success-bg text-app-success',
  warning: 'bg-app-warning-bg text-app-warning',
  danger: 'bg-app-danger-bg text-app-danger',
  info: 'bg-app-info-bg text-app-info',
  neutral: 'bg-app-surface-muted text-app-secondary'
}

const sizeMap: Record<NonNullable<IconBadgeProps['size']>, string> = {
  sm: 'h-7 w-7 text-xs rounded-md',
  md: 'h-9 w-9 text-sm rounded-app',
  lg: 'h-11 w-11 text-base rounded-app-lg'
}

const IconBadge: React.FC<IconBadgeProps> = ({ children, tone = 'brand', size = 'md', className = '' }) => (
  <div
    className={`flex flex-shrink-0 items-center justify-center ${toneMap[tone]} ${sizeMap[size]} ${className}`.trim()}
    aria-hidden
  >
    {children}
  </div>
)

export default IconBadge
