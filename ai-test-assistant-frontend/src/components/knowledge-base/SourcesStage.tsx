import React, { useState } from 'react'
import knowledgeBaseService, { type KbOverview } from '../../services/knowledgeBaseService'
import { Card, CardHead, Chip, Failed, JOURNEY_STATUS, Loading, Note, TableHead, chapterTitle, useLoad } from './kbUi'
import { DocumentReview, DocumentsCard } from './DocumentsPanel'

const EXTRACTION: Record<string, { label: string; tone: 'good' | 'warn' | 'idle' | 'info' }> = {
  transcribed: { label: 'Transcribed', tone: 'good' },
  approved: { label: 'Approved', tone: 'good' },
  partly_approved: { label: 'Partly approved', tone: 'info' },
  not_extracted: { label: 'Not extracted', tone: 'idle' }
}

const COLS = 'grid-cols-[minmax(0,2.2fr)_110px_minmax(0,1.8fr)_150px]'

const Tile: React.FC<{ label: string; value: React.ReactNode; hint: React.ReactNode; tone?: 'plain' | 'warn' }> = ({ label, value, hint, tone = 'plain' }) => (
  <div className={`flex flex-col gap-2 rounded-[16px] border bg-white px-[18px] py-4 ${tone === 'warn' ? 'border-[#EBCFA4]' : 'border-[#E8EAEE]'}`}>
    <span className={`text-[12px] font-bold tracking-[0.08em] ${tone === 'warn' ? 'text-[#8A5000]' : 'text-[#6B7280]'}`}>{label}</span>
    <div className="text-[28px] font-extrabold leading-none tracking-[-0.02em] text-[#1F2937]">{value}</div>
    <span className="text-[12px] text-[#4B5563]">{hint}</span>
  </div>
)

const SourcesStage: React.FC<{
  appKey: string
  overview: KbOverview | null
  canExecute: boolean
  onDrafted: () => void
  onOpenChangeSets: () => void
}> = ({ appKey, overview, canExecute, onDrafted, onOpenChangeSets }) => {
  const [sources, error, reload] = useLoad(appKey, () => knowledgeBaseService.sources(appKey))
  const [reviewing, setReviewing] = useState<number | null>(null)
  const j = overview?.journeys
  const pct = (n = 0) => (j?.total ? `${(n / j.total) * 100}%` : '0%')
  const reconcile = overview?.reconcile ?? {}
  const decisions = (reconcile.LABEL_DRIFT ?? 0) + (reconcile.REF_BROKEN ?? 0)

  if (reviewing != null) {
    return <DocumentReview docId={reviewing} canExecute={canExecute} onBack={() => setReviewing(null)} onDrafted={onDrafted} />
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile
          label="JOURNEYS"
          value={<>{j?.total ?? '—'} <span className="text-[13px] font-normal text-[#6B7280]">in {overview?.chapters.length ?? '—'} chapters</span></>}
          hint={
            <>
              <span className="mb-2 flex h-2 overflow-hidden rounded-full bg-[#F4F5F7]">
                <span className="bg-[#136B34]" style={{ width: pct(j?.by_status.detailed) }} />
                <span className="bg-[#2F6FDB]" style={{ width: pct(j?.by_status.source_available) }} />
                <span className="bg-[#8A5000]" style={{ width: pct(j?.by_status.automation_only) }} />
              </span>
              {j?.by_status.detailed ?? 0} detailed · {j?.by_status.source_available ?? 0} source ready · {j?.by_status.automation_only ?? 0} automation-only · {j?.by_status.awaiting_source ?? 0} awaiting source
            </>
          }
        />
        <Tile
          label="SCREENS"
          value={overview?.screens.catalogued ?? '—'}
          hint={`${overview?.screens.elements ?? '—'} design elements catalogued`}
        />
        <Tile
          label="ELEMENTS LINKED TO APP"
          value={<>{overview?.screens.linked ?? '—'} <span className="text-[13px] font-normal text-[#6B7280]">of {overview?.screens.elements ?? '—'}</span></>}
          hint="Each journey crawl links more; unlinked elements are guessed at script time"
        />
        <Tile
          label="NEEDS A DECISION"
          tone={decisions ? 'warn' : 'plain'}
          value={decisions}
          hint={`${reconcile.LABEL_DRIFT ?? 0} label drift · ${reconcile.REF_BROKEN ?? 0} broken reference · ${j?.open_questions ?? 0} open questions`}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card label="Sources">
          <CardHead
            title="Sources"
            hint="Every design document this Knowledge Base was built from, and what each one feeds"
          />
          <TableHead cols={COLS} labels={['Document', 'Type', 'Feeds', 'Extraction']} />
          {error && <Failed message={error} onRetry={reload} />}
          {!sources && !error && <Loading what="sources" />}
          {sources?.map(doc => (
            <div key={doc.document} className={`grid ${COLS} min-h-[54px] items-center gap-3 border-b border-[#F1F2F4] px-5 py-2 text-[13px]`}>
              <span className="font-semibold text-[#1F2937]">{doc.document}</span>
              <Chip tone={doc.type === 'master_list' ? 'brand' : 'idle'}>{doc.type === 'master_list' ? 'Master list' : 'Screen flow'}</Chip>
              <span className="text-[#4B5563]">
                {doc.feeds ?? (doc.journeys.length ? doc.journeys.map(x => x.title).join(' · ') : '—')}
              </span>
              <Chip tone={EXTRACTION[doc.extraction]?.tone ?? 'idle'}>{EXTRACTION[doc.extraction]?.label ?? doc.extraction}</Chip>
            </div>
          ))}
          <div className="p-5">
            <Note>Documents marked Not extracted have been read by the team but have no journey file yet. Upload one below and extract it to review what it describes, page by page.</Note>
          </div>
        </Card>

        <div className="xl:col-span-2 xl:row-start-2">
          <DocumentsCard appKey={appKey} canExecute={canExecute} onReview={doc => setReviewing(doc.id)} onOpenChangeSets={onOpenChangeSets} />
        </div>

        <Card label="Chapters" className="self-start xl:col-start-2 xl:row-start-1">
          <CardHead title="Chapters" hint="Journeys per chapter of the master topic list" />
          <div className="flex flex-col pb-3">
            {overview?.chapters.map(ch => (
              <div key={ch.id} className="flex items-center justify-between gap-3 px-5 py-1.5 text-[12.5px]">
                <span className="flex min-w-0 items-center gap-2">
                  <span className={`h-2 w-2 flex-shrink-0 rounded-full ${JOURNEY_STATUS[ch.status]?.dot ?? 'bg-[#D6D9DF]'}`} />
                  <span className="truncate text-[#1F2937]">{chapterTitle(ch.title)}</span>
                </span>
                <span className="text-[11.5px] text-[#6B7280]">{ch.journeys}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}

export default SourcesStage
