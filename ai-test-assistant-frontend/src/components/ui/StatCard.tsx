import React from 'react'

interface StatCardProps {
  label: string
  value: React.ReactNode
  hint?: string
  icon?: React.ReactNode
  tone?: 'brand' | 'success' | 'warning' | 'danger' | 'neutral'
}

const toneClasses: Record<NonNullable<StatCardProps['tone']>, string> = {
  brand: 'bg-app-brand-50 text-app-brand-800 border-app-brand-100',
  success: 'bg-green-50 text-green-800 border-green-100',
  warning: 'bg-amber-50 text-amber-800 border-amber-100',
  danger: 'bg-red-50 text-red-800 border-red-100',
  neutral: 'bg-slate-50 text-slate-700 border-slate-200'
}

const StatCard: React.FC<StatCardProps> = ({ label, value, hint, icon, tone = 'brand' }) => {
  return (
    <div className="rounded-3xl border border-app bg-app-surface px-5 py-5 shadow-app-card">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-app-muted">{label}</p>
          <div className="text-3xl font-semibold tracking-tight text-app-primary">{value}</div>
          {hint ? <p className="text-sm text-app-secondary">{hint}</p> : null}
        </div>
        {icon ? (
          <div className={`flex h-12 w-12 items-center justify-center rounded-2xl border ${toneClasses[tone]}`}>
            {icon}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default StatCard
