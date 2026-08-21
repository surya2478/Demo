import React from 'react'
import { HiOutlineSparkles } from 'react-icons/hi'

interface AIInsightCardProps {
  title: string
  description?: string
  actionLabel?: string
  onAction?: () => void
  tone?: 'brand' | 'warning' | 'success'
}

const toneMap = {
  brand: {
    bg: 'bg-app-brand-50',
    border: 'border-app-brand-200',
    iconBg: 'bg-app-brand-100 text-app-brand-700',
    btn: 'bg-app-brand-700 text-white hover:bg-app-brand-800'
  },
  warning: {
    bg: 'bg-app-warning-bg',
    border: 'border-orange-200',
    iconBg: 'bg-orange-100 text-app-warning',
    btn: 'bg-app-warning text-white hover:bg-orange-700'
  },
  success: {
    bg: 'bg-app-success-bg',
    border: 'border-green-200',
    iconBg: 'bg-green-100 text-app-success',
    btn: 'bg-app-success text-white hover:bg-green-700'
  }
}

const AIInsightCard: React.FC<AIInsightCardProps> = ({
  title,
  description,
  actionLabel,
  onAction,
  tone = 'brand'
}) => {
  const t = toneMap[tone]
  return (
    <div className={`rounded-app-lg border ${t.border} ${t.bg} p-4`}>
      <div className="flex items-start gap-3">
        <div className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-app ${t.iconBg}`}>
          <HiOutlineSparkles size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-app-primary">{title}</div>
          {description && <p className="mt-1 text-sm leading-5 text-app-secondary">{description}</p>}
          {actionLabel && onAction && (
            <button
              type="button"
              onClick={onAction}
              className={`mt-3 inline-flex items-center rounded-md px-3 py-1.5 text-xs font-semibold transition ${t.btn}`}
            >
              {actionLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default AIInsightCard
