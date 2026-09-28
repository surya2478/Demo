import React from 'react'
import type { KbImpact } from '../../services/knowledgeBaseService'
import { Chip } from './kbUi'

// What a Knowledge Base change touches: journeys (and why), test cases (and
// which of their steps), Automation KB selectors to confirm, journeys a crawl
// should walk. Shown before approval (document review, change sets drawer)
// and after it (Change & Heal).

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="flex flex-col gap-1">
    <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-[#6B7280]">{title}</span>
    {children}
  </div>
)

const ImpactSummary: React.FC<{ impact: KbImpact; compact?: boolean }> = ({ impact, compact }) => {
  const c = impact.counts ?? {}
  const nothing = !impact.journeys.length && !impact.test_cases.length && !impact.automation.selectors_to_reverify.length
  return (
    <div className="flex flex-col gap-2.5 text-[12.5px]">
      <div className="flex flex-wrap gap-1.5">
        <Chip tone={c.journeys ? 'warn' : 'idle'}>{c.journeys ?? 0} journey{c.journeys === 1 ? '' : 's'}</Chip>
        <Chip tone={c.test_cases ? 'warn' : 'idle'}>{c.test_cases ?? 0} test case{c.test_cases === 1 ? '' : 's'}</Chip>
        <Chip tone={c.selectors ? 'bad' : 'idle'}>{c.selectors ?? 0} selector{c.selectors === 1 ? '' : 's'} to re-verify</Chip>
        {!!c.rules && <Chip tone="info">{c.rules} rule{c.rules === 1 ? '' : 's'}</Chip>}
      </div>
      {nothing && <span className="text-[#6B7280]">Nothing else depends on this change.</span>}
      {!!impact.journeys.length && (
        <Section title="Journeys">
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {impact.journeys.slice(0, compact ? 5 : undefined).map(j => (
              <li key={j.journey_id} className="min-w-0">
                <span className="font-semibold text-[#1F2937]">{j.name}</span>
                <span className="text-[#6B7280]"> — {j.reasons.join('; ')}</span>
              </li>
            ))}
            {compact && impact.journeys.length > 5 && <li className="text-[#6B7280]">and {impact.journeys.length - 5} more</li>}
          </ul>
        </Section>
      )}
      {!!impact.test_cases.length && (
        <Section title="Test cases (matched by their AI Checks KB diff)">
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {impact.test_cases.slice(0, compact ? 6 : undefined).map(t => (
              <li key={t.id} className="min-w-0 truncate" title={t.title}>
                <span className="font-mono text-[11.5px] text-[#1F2937]">{t.display_id}</span>
                <span className="text-[#6B7280]"> · {t.approval_status}{t.steps_touched.length ? ` · step${t.steps_touched.length === 1 ? '' : 's'} ${t.steps_touched.join(', ')} use a changed element` : ''}</span>
              </li>
            ))}
            {compact && impact.test_cases.length > 6 && <li className="text-[#6B7280]">and {impact.test_cases.length - 6} more</li>}
          </ul>
        </Section>
      )}
      {!!impact.automation.selectors_to_reverify.length && (
        <Section title="Automation KB selectors a crawl must confirm">
          <div className="flex flex-wrap gap-1">
            {impact.automation.selectors_to_reverify.map(s => <code key={s} className="rounded bg-[#FEEBEC] px-1.5 py-0.5 text-[11px] text-[#A3231C]">{s}</code>)}
          </div>
        </Section>
      )}
      {!compact && !!impact.automation.flows.length && (
        <Section title="Flow blueprints">
          <div className="flex flex-wrap gap-1">{impact.automation.flows.map(f => <code key={f} className="text-[11px]">{f}</code>)}</div>
        </Section>
      )}
    </div>
  )
}

export default ImpactSummary
