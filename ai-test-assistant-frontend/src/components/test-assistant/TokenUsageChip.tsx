import React, { useSyncExternalStore } from 'react'

// Token usage lives in the Test Assistant's top bar, but it is computed on the
// Generate Test Cases page. The page publishes here and the chip subscribes, so
// the chip is right whichever order the two mount in -- and the header meta,
// which only republishes on primitive changes, never needs to carry it.
export interface TokenUsage {
  used: number
  allocation: number
  isAdmin: boolean
  loading: boolean
}

let current: TokenUsage | null = null
const listeners = new Set<() => void>()

export const publishTokenUsage = (next: TokenUsage) => {
  if (
    current &&
    current.used === next.used &&
    current.allocation === next.allocation &&
    current.isAdmin === next.isAdmin &&
    current.loading === next.loading
  ) {
    return
  }
  current = next
  listeners.forEach((listener) => listener())
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const TokenUsageChip: React.FC = () => {
  const usage = useSyncExternalStore(subscribe, () => current)
  if (!usage) return null

  const limited = !usage.isAdmin && usage.allocation > 0
  const exhausted = limited && usage.used >= usage.allocation
  const title = usage.isAdmin
    ? 'Total tokens used'
    : limited
      ? `${usage.used.toLocaleString()} of ${usage.allocation.toLocaleString()} allocated`
      : 'Tokens used'

  return (
    <div
      className="flex h-9 items-center gap-2 rounded-[12px] border border-[#F6D4D5] bg-[#FFF5F5] px-3"
      title={title}
      data-audit-name="Token Usage"
    >
      <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#941216]">Tokens</span>
      <span className={`text-[14px] font-bold ${exhausted ? 'text-[#B71920]' : 'text-[#1F2937]'}`}>
        {usage.loading ? '...' : usage.used.toLocaleString()}
      </span>
      {limited && !usage.loading && (
        <span className="text-[12px] font-medium text-[#6B7280]">/ {usage.allocation.toLocaleString()}</span>
      )}
    </div>
  )
}

export default TokenUsageChip
