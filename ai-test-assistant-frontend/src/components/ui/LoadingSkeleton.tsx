import React from 'react'

interface LoadingSkeletonProps {
  className?: string
  rounded?: 'sm' | 'md' | 'lg' | 'full'
}

const roundedMap = {
  sm: 'rounded-md',
  md: 'rounded-app',
  lg: 'rounded-app-lg',
  full: 'rounded-full'
}

const LoadingSkeleton: React.FC<LoadingSkeletonProps> = ({ className = '', rounded = 'md' }) => (
  <div
    className={`animate-pulse bg-app-surface-muted ${roundedMap[rounded]} ${className}`.trim()}
    aria-hidden
  />
)

export default LoadingSkeleton
