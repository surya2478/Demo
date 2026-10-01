import React, { useState } from 'react'
import knowledgeBaseService from '../../services/knowledgeBaseService'
import ScreenElementsPanel from './ScreenElementsPanel'
import { FIELD, PLAIN_BTN, PublishToggle, useKbEdit } from './kbEdit'
import { Card, CardHead, Chip, Failed, Loading, Note, useLoad } from './kbUi'

const ModelStage: React.FC<{
  appKey: string
  canExecute?: boolean
  canApprove?: boolean
  onEdited?: () => void
}> = ({ appKey, canExecute = false, canApprove = false, onEdited }) => {
  const [model, error, reload] = useLoad(appKey, () => knowledgeBaseService.model(appKey))
  const kbEdit = useKbEdit(canApprove, onEdited)
  const [openScreen, setOpenScreen] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const names = new Map((model?.screens ?? []).map(s => [s.screen_id, s.name]))
  const nameOf = (target: string) =>
    target.split('|').map(t => names.get(t.trim()) ?? t.trim()).join(' or ')

  return (
    <div className="flex flex-col gap-4">
      <Card label="Screens">
        <CardHead
          title="Screens"
          hint="Design screens with the route and elements the Automation KB knows for each. Open a screen's elements to relabel or delete one."
          right={model && (
            <div className="flex gap-1.5">
              <Chip tone="idle">All {model.screens.length}</Chip>
              <Chip tone="idle">Design only {model.screens.filter(s => s.origin === 'design').length}</Chip>
              <Chip tone="good">In app {model.screens.filter(s => s.origin === 'both').length}</Chip>
              <Chip tone="warn">App routes not in design {model.app_only_routes.length}</Chip>
            </div>
          )}
        />
        {canExecute && (
          <div className="border-t border-[#F1F2F4] px-5 py-2">
            <PublishToggle canApprove={canApprove} publishNow={kbEdit.publishNow} onChange={kbEdit.setPublishNow} />
          </div>
        )}
        {error && <Failed message={error} onRetry={reload} />}
        {!model && !error && <Loading what="the application model" />}
        {model?.screens.map(s => {
          // Where this screen leads, itself excluded (an inline error keeps
          // the user on the same screen), with screens not yet catalogued said so.
          const targets = Array.from(new Set(s.transitions.flatMap(t => t.to.split('|').map(x => x.trim()))))
            .filter(t => t && t !== s.screen_id && !t.startsWith('('))
          return (
            <div key={s.screen_id} className="flex flex-col gap-2 border-t border-[#F1F2F4] px-5 py-3 text-[12.5px] md:flex-row md:flex-wrap md:items-start md:gap-x-6">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                {renaming?.id === s.screen_id ? (
                  <form className="flex items-center gap-1.5" onSubmit={async e => {
                    e.preventDefault()
                    await kbEdit.run('Screen name', p => knowledgeBaseService.renameScreen(appKey, s.screen_id, renaming.name, p), () => { setRenaming(null); reload() })
                  }}>
                    <input autoFocus aria-label={`New name for ${s.screen_id}`} value={renaming.name}
                      onChange={e => setRenaming({ id: s.screen_id, name: e.target.value })}
                      onKeyDown={e => { if (e.key === 'Escape') setRenaming(null) }} className={FIELD} />
                    <button type="submit" disabled={kbEdit.busy || !renaming.name.trim()} className="h-[30px] flex-shrink-0 rounded-[8px] bg-[#B71920] px-2.5 text-[12px] font-bold text-white disabled:opacity-50">
                      {kbEdit.publish ? 'Save' : 'Draft'}
                    </button>
                    <button type="button" className={PLAIN_BTN} onClick={() => setRenaming(null)}>Cancel</button>
                  </form>
                ) : (
                  <span className="flex flex-wrap items-baseline gap-2">
                    <strong className="text-[13.5px]">{s.name}</strong>
                    <code className="text-[11px] text-[#6B7280]">{s.screen_id}</code>
                    {canExecute && (
                      <button type="button" onClick={() => setRenaming({ id: s.screen_id, name: s.name })}
                        className="text-[11.5px] font-semibold text-[#B71920] hover:underline" aria-label={`Rename ${s.name}`}>✎ Rename</button>
                    )}
                  </span>
                )}
                <span className="break-all">
                  {s.route_in_app
                    ? <code className="text-[11.5px]">{s.route_in_app}</code>
                    : <span className="text-[#6B7280]">route: {s.route ?? 'unknown'}</span>}
                  {s.route && !s.route_in_app && s.route_ref && <> <Chip tone="bad">route missing in app</Chip></>}
                </span>
                {targets.length > 0 && (
                  <span className="text-[#4B5563]">
                    Leads to:{' '}
                    {targets.map((t, i) => (
                      <React.Fragment key={t}>
                        {i > 0 && ', '}
                        {names.has(t) ? names.get(t) : <span className="text-[#9CA3AF]" title="Not catalogued yet">{t}</span>}
                      </React.Fragment>
                    ))}
                  </span>
                )}
              </div>
              <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5">
                <Chip tone="idle">{s.elements} element{s.elements === 1 ? '' : 's'}</Chip>
                <Chip tone={s.linked ? 'good' : 'idle'}>{s.linked} linked to app</Chip>
                <button type="button" onClick={() => setOpenScreen(o => (o === s.screen_id ? null : s.screen_id))} aria-expanded={openScreen === s.screen_id}
                  className={openScreen === s.screen_id ? PLAIN_BTN : 'h-[30px] rounded-[10px] bg-[#B71920] px-3 text-[12.5px] font-bold text-white hover:opacity-95'}>
                  {openScreen === s.screen_id ? 'Hide elements' : canExecute ? 'Edit elements' : 'Elements'}
                </button>
              </div>
              {openScreen === s.screen_id && (
                <div className="w-full md:basis-full">
                  <ScreenElementsPanel appKey={appKey} screenId={s.screen_id} canEdit={canExecute} busy={kbEdit.busy}
                    publish={kbEdit.publish} run={kbEdit.run} onChanged={reload} />
                </div>
              )}
            </div>
          )
        })}
        {model && model.app_only_routes.length > 0 && (
          <div className="flex flex-col gap-2 p-5">
            <span className="text-[11px] font-bold tracking-[0.1em] text-[#6B7280]">ROUTES THE AUTOMATION KB HAS THAT NO DESIGN SCREEN USES</span>
            {model.app_only_routes.map(r => (
              <span key={r.route_ref} className="text-[12.5px]"><code className="text-[11.5px]">{r.route}</code> <span className="text-[#6B7280]">· {r.route_ref}</span></span>
            ))}
          </div>
        )}
      </Card>

      <Card label="Transitions">
        <CardHead title="Transitions" hint="How the design moves between screens, including the conditional branches" />
        <div className="grid gap-3 px-5 pb-5 md:grid-cols-2">
          {model?.screens.filter(s => s.transitions.length).map(s => (
            <div key={s.screen_id} className="rounded-[14px] border border-[#E8EAEE] p-3.5 text-[12.5px]">
              <strong className="block pb-1.5">{s.name}</strong>
              {s.transitions.map((t, i) => (
                <span key={i} className="block py-0.5 text-[#4B5563]">
                  <code className="text-[11.5px] text-[#1F2937]">{t.on}</code> → {nameOf(t.to)}
                  {t.condition && <span className="text-[#6B7280]"> · if {t.condition}</span>}
                </span>
              ))}
            </div>
          ))}
        </div>
        <div className="px-5 pb-5"><Note>A drawn navigation graph comes with the journey-guided crawl, when crawled routes can be placed on it.</Note></div>
      </Card>
    </div>
  )
}

export default ModelStage
