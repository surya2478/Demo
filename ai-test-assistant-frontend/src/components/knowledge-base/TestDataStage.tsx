import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import knowledgeBaseService, { type CoverageCell } from '../../services/knowledgeBaseService'
import { Card, Chip, Failed, Loading, Note, useLoad } from './kbUi'

const CELL: Record<CoverageCell['status'], { label: string; tone: 'good' | 'bad' | 'info' }> = {
  ready: { label: 'Ready', tone: 'good' },
  missing: { label: 'Missing', tone: 'bad' },
  external: { label: 'External', tone: 'info' }
}

// Values never reach this screen: the API reports which stored key answered a
// variable, or that none did. Setting values stays in the vault's own screen.
const TestDataStage: React.FC<{ appKey: string }> = ({ appKey }) => {
  const [coverage, error, reload] = useLoad(appKey, () => knowledgeBaseService.testData(appKey))
  const [selected, setSelected] = useState<string | null>(null)
  const [env, setEnv] = useState<string | null>(null)

  useEffect(() => {
    if (!coverage) return
    setSelected(s => s ?? coverage.profiles.find(p => Object.values(p.cells).some(c => c.status === 'missing'))?.profile_id ?? coverage.profiles[0]?.profile_id ?? null)
    setEnv(e => e ?? coverage.environments[0] ?? null)
  }, [coverage])

  const profile = coverage?.profiles.find(p => p.profile_id === selected)
  // Inline, not a Tailwind class: the column count is only known at run time,
  // and Tailwind generates only classes it can read in the source.
  const grid = { gridTemplateColumns: `minmax(0,1fr) repeat(${coverage?.environments.length ?? 2}, 84px)` }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="m-0 text-[18px] font-bold text-[#1F2937]">Test data the journeys need</h2>
          <p className="m-0 mt-0.5 text-[12.5px] text-[#6B7280]">
            Definitions come from the Journey KB; values live in the encrypted test-data vault and are never shown or copied here
          </p>
        </div>
        {coverage && (
          <div className="flex items-center gap-1.5">
            <Chip tone="good">Ready {coverage.totals.ready}</Chip>
            <Chip tone="bad">Missing {coverage.totals.missing}</Chip>
            <Chip tone="info">External {coverage.totals.external}</Chip>
            <Link to="/test-data" className="ml-2 flex h-[34px] items-center rounded-[12px] border border-[#E8EAEE] bg-white px-3.5 text-[13px] font-bold text-[#1F2937] hover:border-[#F6D4D5]">Open vault</Link>
          </div>
        )}
      </div>

      {coverage && !coverage.vault_app && (
        <Note tone="warn">No test-data application is linked to this Knowledge Base yet, so every profile reads as missing. Add one in the vault with Knowledge Base id <code>{appKey}</code>.</Note>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card label="Coverage">
          <div style={grid} className={`grid h-9 items-center gap-3 bg-[#F4F5F7] px-5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-[#374151]`}>
            <span>Data profile · used by</span>
            {coverage?.environments.map(e => <span key={e}>{e}</span>)}
          </div>
          {error && <Failed message={error} onRetry={reload} />}
          {!coverage && !error && <Loading what="test-data coverage" />}
          {coverage?.profiles.map(p => (
            <button
              key={p.profile_id}
              type="button"
              onClick={() => setSelected(p.profile_id)}
              aria-current={p.profile_id === selected ? 'true' : undefined}
              style={grid}
              className={`grid w-full items-center gap-3 border-b border-[#F1F2F4] px-5 py-2.5 text-left text-[12.5px] ${p.profile_id === selected ? 'bg-[#FFF5F5] shadow-[inset_3px_0_0_#B71920]' : 'hover:bg-[#FCFCFD]'}`}
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-baseline gap-2"><strong>{p.name}</strong><code className="text-[11px] text-[#6B7280]">{p.profile_id}</code></span>
                <span className="text-[#6B7280]">{p.used_by.slice(0, 2).join(' · ')}{p.used_by.length > 2 ? ` · +${p.used_by.length - 2} more` : ''}</span>
              </span>
              {coverage.environments.map(e => (
                <Chip key={e} tone={CELL[p.cells[e]?.status ?? 'missing'].tone}>{CELL[p.cells[e]?.status ?? 'missing'].label}</Chip>
              ))}
            </button>
          ))}
          <div className="p-5"><Note>A profile appears here as soon as a journey or scenario names it. When Change &amp; Heal lands, a new BRD scenario will flag its data as Missing before any test case needs it.</Note></div>
        </Card>

        {profile && (
          <Card label="Profile detail" className="flex flex-col gap-3.5 p-[18px] self-start">
            <div>
              <span className="text-[11px] font-bold tracking-[0.1em] text-[#6B7280]">DATA PROFILE · {profile.kind.toUpperCase()}</span>
              <h2 className="m-0 mt-1 text-[16px] font-bold">{profile.name}</h2>
              <p className="m-0 mt-1 text-[12px] text-[#4B5563]">{profile.description}</p>
            </div>
            <div role="tablist" className="flex gap-1.5">
              {coverage?.environments.map(e => (
                <button key={e} type="button" role="tab" aria-selected={env === e} onClick={() => setEnv(e)}
                  className={`h-[30px] rounded-[10px] px-3 text-[12.5px] font-bold ${env === e ? 'bg-[#1F2937] text-white' : 'border border-[#E8EAEE] bg-white text-[#4B5563]'}`}>{e}</button>
              ))}
            </div>
            {profile.fields.length > 0 ? (
              <div className="overflow-hidden rounded-[12px] border border-[#E8EAEE]">
                {profile.fields.map(f => {
                  const cell = env ? profile.cells[env] : undefined
                  const missing = cell?.missing.includes(f.variable)
                  const key = cell?.matched_keys?.[f.variable]
                  return (
                    <div key={f.variable} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-[#F1F2F4] px-3 py-2.5 text-[12.5px] last:border-b-0">
                      <span><strong>{f.name}</strong><br /><code className="text-[11px] text-[#6B7280]">{f.variable}</code></span>
                      {missing || !key ? <Chip tone="bad">missing</Chip> : <span className="text-[11.5px] text-[#136B34]" title="The vault key that answers this variable">set · {key}</span>}
                    </div>
                  )
                })}
              </div>
            ) : (
              <Note>{profile.kind === 'external' ? 'Held outside this system, so it is not stored in the vault.' : 'A document rather than a value; upload support comes with the journey that needs it.'}</Note>
            )}
            {profile.state && (
              <Note tone="warn">
                <strong className="block text-[11px] tracking-[0.1em]">STATE THE ACCOUNT MUST BE IN</strong>
                {profile.state}
              </Note>
            )}
            <div className="flex flex-col gap-1 text-[12px] text-[#4B5563]">
              <span className="text-[11px] font-bold tracking-[0.1em] text-[#6B7280]">USED BY</span>
              {profile.used_by.map(u => <span key={u}>{u}</span>)}
            </div>
            <Link to="/test-data" className="flex h-[38px] items-center justify-center rounded-[12px] bg-[#B71920] text-[13px] font-bold text-white hover:opacity-95">
              Set values in vault
            </Link>
          </Card>
        )}
      </div>
    </div>
  )
}

export default TestDataStage
