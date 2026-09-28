/**
 * --- Pieces shared by the Runs and Automation Lab lists -----------------------
 *
 * Both lists group by project and open a row in a drawer; these keep the two
 * looking like one product: the round status mark at the start of a row, the
 * project's badge, and the bar that says how a project's rows went.
 */
import React from 'react'

export type MarkTone = 'passed' | 'failed' | 'blocked' | 'running' | 'queued' | 'cancelled' | 'none'

/** The round status mark at the start of a row. */
export const StatusMark: React.FC<{ tone: MarkTone; title?: string }> = ({ tone, title }) => {
  if (tone === 'running' || tone === 'queued') {
    return <span title={title} className="box-border h-8 w-8 animate-spin rounded-full border-[3px] border-[#DBE7FE] border-t-[#2563EB]" />
  }
  if (tone === 'none') {
    return (
      <span title={title} className="flex h-8 w-8 items-center justify-center rounded-full bg-[#F4F5F7]">
        <span className="box-border h-5 w-5 rounded-full border-2 border-dashed border-[#C4C8CF]" />
      </span>
    )
  }
  const style: Record<'passed' | 'failed' | 'blocked' | 'cancelled', { ring: string; fill: string; icon: React.ReactNode }> = {
    passed: { ring: 'bg-[#EAF7EF]', fill: 'bg-[#16A34A]', icon: <path d="M5 12l5 5 9-10" /> },
    failed: { ring: 'bg-[#FEEBEC]', fill: 'bg-[#DC2626]', icon: <path d="M6 6l12 12M18 6L6 18" /> },
    blocked: { ring: 'bg-[#FFF4E5]', fill: 'bg-[#D97706]', icon: <path d="M12 7v6M12 17h.01" /> },
    cancelled: { ring: 'bg-[#F4F5F7]', fill: 'bg-[#9CA3AF]', icon: <path d="M7 12h10" /> }
  }
  const s = style[tone]
  return (
    <span title={title} className={`flex h-8 w-8 items-center justify-center rounded-full ${s.ring}`}>
      <span className={`flex h-5 w-5 items-center justify-center rounded-full ${s.fill}`}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" aria-hidden>{s.icon}</svg>
      </span>
    </span>
  )
}

/** Two letters for a project's badge: the first letters of its first two words. */
export const initials = (name: string) =>
  name.split(/[\s\-_/]+/).filter(w => /[A-Za-z0-9]/.test(w)).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '—'

/** The project's badge: its initials on red, or a grey dash for "No project". */
export const ProjectBadge: React.FC<{ name: string; hasProject: boolean }> = ({ name, hasProject }) => (
  <span
    className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[12px] text-[13px] font-extrabold text-white ${
      hasProject ? 'bg-[linear-gradient(145deg,#ff3b40_0%,#c8161d_60%,#9e0f15_100%)] shadow-[0_6px_14px_rgba(183,25,32,0.25)]' : 'bg-[#9CA3AF]'
    }`}
  >
    {hasProject ? initials(name) : '—'}
  </span>
)

/** One bar for a project's rows, with the counts under it. Zero counts are left out. */
export const OutcomeBar: React.FC<{ parts: { label: string; count: number; bar: string; text: string }[]; total: number }> = ({ parts, total }) => (
  <span className="flex w-[260px] flex-shrink-0 flex-col gap-1.5">
    <span className="flex h-2 overflow-hidden rounded-full bg-[#F1F2F4]">
      {parts.map(p => (p.count ? <span key={p.label} className={p.bar} style={{ width: `${(100 * p.count) / Math.max(1, total)}%` }} /> : null))}
    </span>
    <span className="flex flex-wrap gap-x-3 text-[12px] text-[#6B7280]">
      {parts.filter(p => p.count).map(p => (
        <span key={p.label}><b className={p.text}>{p.count}</b> {p.label}</span>
      ))}
    </span>
  </span>
)
