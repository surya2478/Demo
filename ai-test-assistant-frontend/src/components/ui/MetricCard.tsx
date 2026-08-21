import React from 'react'

export interface MetricCardProps {
  label: string
  value: React.ReactNode
  icon?: React.ReactNode
  trend?: {
    direction: 'up' | 'down' | 'flat'
    value: string
    label?: string
  }
  tone?: 'brand' | 'success' | 'warning' | 'danger' | 'neutral' | 'violet'
  className?: string
  tooltip?: string
  sparkData?: number[]
}

const toneIconBg: Record<NonNullable<MetricCardProps['tone']>, string> = {
  brand: 'bg-app-brand-50 text-app-brand-700',
  success: 'bg-app-success-bg text-app-success',
  warning: 'bg-app-warning-bg text-app-warning',
  danger: 'bg-app-danger-bg text-app-danger',
  neutral: 'bg-app-surface-muted text-app-secondary',
  violet: 'bg-[#F3EDFB] text-[#7B3FE4]'
}

const toneSparkColor: Record<NonNullable<MetricCardProps['tone']>, string> = {
  brand: '#B71920',
  success: '#15803D',
  warning: '#D97706',
  danger: '#DC2626',
  neutral: '#9CA3AF',
  violet: '#7B3FE4'
}

const trendColor: Record<'up' | 'down' | 'flat', string> = {
  up: 'text-app-success',
  down: 'text-app-danger',
  flat: 'text-app-secondary'
}

const trendArrow: Record<'up' | 'down' | 'flat', string> = {
  up: '↗',
  down: '↘',
  flat: '→'
}

const Sparkline: React.FC<{ data: number[]; color: string }> = ({ data, color }) => {
  if (!data || data.length < 2) return null
  const w = 80
  const h = 32
  const padX = 2
  const padY = 3
  const maxV = Math.max(...data, 1)
  const minV = Math.min(...data, 0)
  const range = maxV - minV || 1
  const xStep = (w - padX * 2) / Math.max(data.length - 1, 1)
  const toXY = (i: number, v: number) =>
    [padX + i * xStep, h - padY - ((v - minV) / range) * (h - padY * 2)] as const
  const points = data.map((v, i) => toXY(i, v))
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const areaPath = `${path} L${points[points.length - 1][0].toFixed(1)},${h - padY} L${points[0][0].toFixed(1)},${h - padY} Z`

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      className="pointer-events-none"
      aria-hidden
    >
      <path d={areaPath} fill={color} fillOpacity={0.12} />
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

const MetricCard: React.FC<MetricCardProps> = ({
  label,
  value,
  icon,
  trend,
  tone = 'brand',
  className = '',
  tooltip,
  sparkData
}) => {
  return (
    <div
      className={`relative overflow-hidden rounded-app-lg border border-app bg-app-surface p-5 shadow-app-card transition hover:shadow-app-card-lg ${className}`.trim()}
      title={tooltip}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-app-secondary">{label}</div>
          <div className="mt-2 text-[28px] font-bold leading-tight tracking-tight text-app-primary sm:text-[30px]">
            {value}
          </div>
        </div>
        {icon && (
          <div
            className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-app ${toneIconBg[tone]}`}
            aria-hidden
          >
            {icon}
          </div>
        )}
      </div>
      {trend && (
        <div className="mt-3 flex items-center gap-1.5 text-xs">
          <span className={`font-semibold ${trendColor[trend.direction]}`}>
            {trendArrow[trend.direction]} {trend.value}
          </span>
          {trend.label && <span className="text-app-secondary">{trend.label}</span>}
        </div>
      )}
      {sparkData && sparkData.length >= 2 && (
        <div className="absolute bottom-3 right-3 opacity-70">
          <Sparkline data={sparkData} color={toneSparkColor[tone]} />
        </div>
      )}
    </div>
  )
}

export default MetricCard
