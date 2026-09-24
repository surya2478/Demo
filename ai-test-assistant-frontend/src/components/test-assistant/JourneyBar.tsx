import React from 'react'

export const JOURNEY_STEPS = [
  'Parse Solution',
  'Generate Test Cases',
  'AI Checks',
  'Send for Approval',
  'Manager Approval',
  'Automation Lab',
  'Execute & Report'
] as const

interface JourneyBarProps {
  /** 1-based step the current request is on. */
  current: number
  /** Steps not built yet. They are never shown as done, even once passed. */
  unavailable?: number[]
}

const Check = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" aria-hidden>
    <path d="M5 12l5 5 9-10" />
  </svg>
)

// Where the current request is, from requirement to report. Sticky to the
// bottom of the window, so it follows the last section on a short page and
// stays visible without scrolling on a long one.
const JourneyBar: React.FC<JourneyBarProps> = ({ current, unavailable = [] }) => (
  <section
    aria-label="Journey"
    className="app-scroll sticky bottom-3 z-20 overflow-x-auto rounded-[16px] border border-[#E8EAEE] bg-white px-[22px] py-3 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]"
  >
    {/* Full width on a desktop; scrolls inside itself on a narrow screen
        rather than widening the page. */}
    <div className="flex min-w-[900px] items-start gap-1">
    <div className="flex w-[90px] flex-shrink-0 flex-col justify-center pt-1">
      <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#941216]">Journey</span>
      <span className="text-[11px] text-[#6B7280]">Step {current} of {JOURNEY_STEPS.length}</span>
    </div>
    {JOURNEY_STEPS.map((label, index) => {
      const step = index + 1
      const pending = unavailable.includes(step)
      const state = step === current ? 'now' : step < current && !pending ? 'done' : 'next'
      return (
        <React.Fragment key={label}>
          {index > 0 && (
            <div className={`mt-3 h-0.5 min-w-[8px] flex-1 ${step <= current && state !== 'next' ? 'bg-[#B71920]' : 'bg-[#E8EAEE]'}`} />
          )}
          <div
            className="flex w-[104px] flex-shrink-0 flex-col items-center gap-1.5 text-center"
            title={pending ? `${label} arrives in a later release` : undefined}
            aria-current={state === 'now' ? 'step' : undefined}
          >
            <div
              className={`box-border flex h-[26px] w-[26px] items-center justify-center rounded-full text-[11px] font-bold ${
                state === 'done'
                  ? 'bg-[#B71920] text-white'
                  : state === 'now'
                    ? 'border-2 border-[#B71920] bg-white text-[#B71920] shadow-[0_0_0_5px_rgba(183,25,32,0.12)]'
                    : 'border-[1.5px] border-[#D6D9DF] bg-white text-[#9CA3AF]'
              }`}
            >
              {state === 'done' ? <Check /> : step}
            </div>
            <span
              className={`text-[11.5px] font-semibold leading-[1.25] ${
                state === 'done' ? 'text-[#1F2937]' : state === 'now' ? 'text-[#B71920]' : 'text-[#6B7280]'
              }`}
            >
              {label}
            </span>
          </div>
        </React.Fragment>
      )
    })}
    </div>
  </section>
)

export default JourneyBar
