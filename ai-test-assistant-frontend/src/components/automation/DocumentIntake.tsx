/**
 * --- Automation Module: Document Intake ----------------------------------
 *
 * The second way test cases reach the Workbench, sitting above "What to
 * refine" rather than replacing it. The first way is the review workflow: a
 * human approves a case and it appears there. This one starts from documents.
 *
 * Ported in behaviour from stlc-platform's Document intake panel, with the
 * departures this deployment forces:
 *
 *  - no project scope, so batches are global and the picker is a flat list;
 *  - only a Test Cases document produces candidates. A BRD is extracted and
 *    stored against the requirements work that is not built yet, which is why
 *    its row shows a dash rather than a zero in the last column.
 *
 * Uploading stores and reads the text; it does not create test cases. That is
 * Extract Test Cases, and the separation is the source studio's: extraction
 * can cost a model call for a document with no clean table, so it is a
 * deliberate press rather than a side effect of attaching a file.
 *
 * The panel re-renders from the batch object every mutation returns, rather
 * than merging responses into local state. Upload is the reason: one call can
 * both add rows and change the batch's totals, and a document that failed to
 * parse still appears, so reconciling by hand would be its own bug surface.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  HiOutlineUpload,
  HiOutlineRefresh,
  HiOutlineTrash,
  HiOutlinePlus,
  HiOutlineDocumentText,
  HiOutlineDocumentSearch,
  HiOutlineExclamationCircle
} from 'react-icons/hi'
import automationService from '../../services/automationService'
import SectionCard from '../ui/SectionCard'
import EmptyState from '../ui/EmptyState'
import StatusBadge from '../ui/StatusBadge'
import { JobProgress } from './workbenchPresentation'
import { isJobSettled } from '../../types/automation'
import {
  INTAKE_ACCEPTED_EXTENSIONS,
  INTAKE_ROLE_LABELS,
  type GenerationJob,
  type IntakeBatch,
  type IntakeDocument,
  type IntakeRole
} from '../../types/automation'

const ROLES: IntakeRole[] = ['brd', 'srd', 'test_cases']

interface DocumentIntakeProps {
  /**
   * Called after anything that may have created test cases, so the panel below
   * can reload. Intake writes into the same table "What to refine" reads from,
   * and without this the new cases only appear on a manual refresh.
   */
  onCasesHarvested?: () => void
}

const formatBytes = (bytes: number | null): string => {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const ExtractBadge: React.FC<{ document: IntakeDocument }> = ({ document }) => {
  if (document.extract_status === 'ready') {
    return <StatusBadge tone="success" dot>Ready</StatusBadge>
  }
  if (document.extract_status === 'failed') {
    return <StatusBadge tone="danger" dot>Failed</StatusBadge>
  }
  return <StatusBadge tone="neutral" dot>Pending</StatusBadge>
}

const DocumentIntake: React.FC<DocumentIntakeProps> = ({ onCasesHarvested }) => {
  const [batches, setBatches] = useState<IntakeBatch[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [newName, setNewName] = useState('')
  const [role, setRole] = useState<IntakeRole>('brd')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [job, setJob] = useState<GenerationJob | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const pollRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (pollRef.current !== null) window.clearTimeout(pollRef.current)
    },
    []
  )

  const active = useMemo(
    () => batches.find(batch => batch.id === activeId) ?? null,
    [batches, activeId]
  )

  /** Documents this batch could actually extract from. */
  const testCaseDocs = useMemo(
    () =>
      (active?.documents ?? []).filter(
        doc => doc.role === 'test_cases' && doc.extract_status === 'ready'
      ).length,
    [active]
  )

  const running = job !== null && !isJobSettled(job.status)

  const load = useCallback(async (selectId?: number) => {
    setLoading(true)
    setError(null)
    try {
      const { batches: found } = await automationService.listIntakeBatches()
      setBatches(found)
      setActiveId(current => {
        if (selectId !== undefined) return selectId
        if (current !== null && found.some(batch => batch.id === current)) return current
        return found.length ? found[0].id : null
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load intake batches')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** Replace one batch in place, so the picker keeps its order and selection. */
  const applyBatch = useCallback((batch: IntakeBatch) => {
    setBatches(current => current.map(item => (item.id === batch.id ? batch : item)))
  }, [])

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) {
      setError('Give the intake a name.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const batch = await automationService.createIntakeBatch(name)
      setNewName('')
      await load(batch.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the intake')
    } finally {
      setBusy(false)
    }
  }

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    // Cleared immediately so re-picking the same file after a failure still
    // fires a change event.
    event.target.value = ''
    if (!files.length || !active) return

    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await automationService.uploadIntakeDocuments(active.id, files, role)
      applyBatch(result.batch)

      if (result.rejected.length) {
        setError(
          result.rejected
            .map(item => `${item.filename ?? 'file'}: ${item.reason}`)
            .join(' · ')
        )
      }

      const pending = result.batch.documents.filter(
        doc => doc.role === 'test_cases' && doc.extract_status === 'ready'
      ).length
      if (pending > 0) {
        setNotice(
          `${pending} test case document(s) ready. Press Extract Test Cases to read them in.`
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not upload the documents')
    } finally {
      setBusy(false)
    }
  }

  const handleRoleChange = async (document: IntakeDocument, next: IntakeRole) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await automationService.setIntakeDocumentRole(document.id, next)
      applyBatch(result.batch)
      if (result.note) setNotice(result.note)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the document type')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Poll the extraction job. Stops the moment it settles — a finished job
   * cannot change, and the batch is reloaded once from the terminal state so
   * the per-document counts and any per-document notes are current.
   */
  const pollExtraction = useCallback(
    async (jobId: string) => {
      try {
        const next = await automationService.getGenerationJob(jobId)
        setJob(next)
        if (isJobSettled(next.status)) {
          await load()
          // Reload the panel below whatever the outcome: a job that failed on
          // its third document still committed the first two.
          onCasesHarvested?.()
          if (next.status === 'failed') {
            setError(next.message || 'Extraction failed.')
          } else {
            setNotice(next.message || 'Extraction finished.')
          }
          return
        }
        pollRef.current = window.setTimeout(() => void pollExtraction(jobId), 1200)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Lost track of the extraction job.')
        setJob(null)
      }
    },
    [load, onCasesHarvested]
  )

  const handleExtract = async () => {
    if (!active) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const started = await automationService.extractIntakeTestCases(active.id)
      setJob(started)
      void pollExtraction(started.job_id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Extraction could not be started.')
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteDocument = async (document: IntakeDocument) => {
    setBusy(true)
    setError(null)
    try {
      const result = await automationService.deleteIntakeDocument(document.id)
      applyBatch(result.batch)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the document')
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteBatch = async (batch: IntakeBatch) => {
    setBusy(true)
    setError(null)
    try {
      await automationService.deleteIntakeBatch(batch.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the intake')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SectionCard
      title="Document intake"
      description="Upload the BRD, SRD and TC documents to analyse and refine them to suite Automation objective."
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void handleCreate()
            }}
            placeholder="New intake name"
            className="app-input h-9 w-[190px] text-xs"
            aria-label="New intake name"
          />
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={busy || !newName.trim()}
            className="app-btn app-btn-primary h-9 px-3 text-xs"
          >
            <HiOutlinePlus className="h-3.5 w-3.5" />
            Create intake
          </button>
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy}
            className="app-btn app-btn-ghost h-9 w-9 p-0 inline-flex items-center justify-center"
            title="Reload"
            aria-label="Reload intake batches"
          >
            <HiOutlineRefresh className="h-4 w-4" />
          </button>
        </div>
      }
    >
      {error ? (
        <div className="mb-4 flex items-start gap-2 rounded-app border border-red-200 bg-app-danger-bg px-3 py-2 text-sm text-app-danger">
          <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {notice ? (
        <div className="mb-4 rounded-app border border-green-200 bg-app-success-bg px-3 py-2 text-sm text-app-success">
          {notice}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-app-secondary">Loading intake batches…</p>
      ) : !batches.length ? (
        <EmptyState
          title="No intake batches yet"
          description="Create an intake, then upload the BRD, SRD and existing test case documents for the scope you want to automate."
          icon={<HiOutlineDocumentText className="h-6 w-6" />}
        />
      ) : (
        <div className="space-y-4">
          {/* Batch picker */}
          <div className="flex flex-wrap items-center gap-2">
            {batches.map(batch => {
              const selected = batch.id === activeId
              return (
                <button
                  key={batch.id}
                  type="button"
                  onClick={() => setActiveId(batch.id)}
                  className={`rounded-app border px-3 py-1.5 text-sm transition ${
                    selected
                      ? 'border-app-brand-200 bg-app-brand-50 text-app-brand-800'
                      : 'border-app bg-app-surface text-app-secondary hover:bg-app-surface-muted'
                  }`}
                >
                  {batch.name}
                  <span className="ml-2 text-[10px] uppercase tracking-wide text-app-secondary">
                    {batch.cases_found > 0
                      ? `${batch.cases_found} case(s)`
                      : `${batch.document_count} doc(s)`}
                  </span>
                </button>
              )
            })}
          </div>

          {active ? (
            <div className="rounded-app border border-app bg-app-surface-muted/40 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <label className="text-sm text-app-secondary" htmlFor="tas-intake-role">
                  Upload as
                </label>
                <select
                  id="tas-intake-role"
                  value={role}
                  onChange={e => setRole(e.target.value as IntakeRole)}
                  className="app-input w-[130px]"
                >
                  {ROLES.map(value => (
                    <option key={value} value={value}>
                      {INTAKE_ROLE_LABELS[value]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  disabled={busy}
                  className="app-btn app-btn-secondary"
                >
                  <HiOutlineUpload className="h-4 w-4" />
                  {busy ? 'Working…' : 'Upload documents'}
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept={INTAKE_ACCEPTED_EXTENSIONS}
                  onChange={e => void handleUpload(e)}
                  className="hidden"
                />
                <span className="text-sm text-app-secondary">
                  PDF, DOCX, XLSX, CSV, TXT or MD. Multiple files at once.
                </span>
                <button
                  type="button"
                  onClick={() => void handleExtract()}
                  disabled={busy || running || !testCaseDocs}
                  className="app-btn app-btn-primary"
                  title={
                    testCaseDocs
                      ? 'Read the test case documents into candidates to refine'
                      : 'Upload a document with its type set to Test Cases first'
                  }
                >
                  <HiOutlineDocumentSearch className="h-4 w-4" />
                  Extract Test Cases
                </button>
                <button
                  type="button"
                  onClick={() => void handleDeleteBatch(active)}
                  disabled={busy}
                  className="app-btn app-btn-ghost ml-auto text-app-danger"
                  title="Delete this intake and its documents. Test cases already read from them are kept."
                >
                  <HiOutlineTrash className="h-4 w-4" />
                  Delete intake
                </button>
              </div>

              {running ? (
                <div className="mt-4">
                  <JobProgress
                    percent={job.percent}
                    message={job.message}
                    tone={job.status === 'failed' ? 'failed' : 'running'}
                  />
                </div>
              ) : null}

              {active.documents.length ? (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead>
                      <tr className="border-b border-app text-left text-[11px] uppercase tracking-wide text-app-secondary">
                        <th className="pb-2 pr-3 font-medium">Document</th>
                        <th className="pb-2 pr-3 font-medium">Type</th>
                        <th className="pb-2 pr-3 font-medium">Text</th>
                        <th className="pb-2 pr-3 font-medium">Test cases found</th>
                        <th className="pb-2 pr-3 font-medium sr-only">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {active.documents.map(document => (
                        <tr key={document.id} className="border-b border-app/60 last:border-0">
                          <td className="py-2.5 pr-3">
                            <div className="flex items-center gap-2">
                              <HiOutlineDocumentText className="h-4 w-4 shrink-0 text-app-secondary" />
                              <span className="text-app-primary">{document.filename}</span>
                              <span className="text-[11px] text-app-secondary">
                                {formatBytes(document.size_bytes)}
                              </span>
                            </div>
                          </td>
                          <td className="py-2.5 pr-3">
                            <select
                              value={document.role}
                              disabled={busy}
                              onChange={e =>
                                void handleRoleChange(document, e.target.value as IntakeRole)
                              }
                              className="app-input w-[130px]"
                              aria-label={`Type of ${document.filename}`}
                            >
                              {ROLES.map(value => (
                                <option key={value} value={value}>
                                  {INTAKE_ROLE_LABELS[value]}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2.5 pr-3">
                            <div className="flex flex-col gap-1">
                              <ExtractBadge document={document} />
                              {document.extract_error ? (
                                <span className="max-w-[280px] text-[11px] leading-snug text-app-secondary">
                                  {document.extract_error}
                                </span>
                              ) : null}
                            </div>
                          </td>
                          <td className="py-2.5 pr-3 text-app-primary">
                            {document.role === 'test_cases'
                              ? `${document.cases_found} test case(s)`
                              : '—'}
                          </td>
                          <td className="py-2.5 pr-3 text-right">
                            <button
                              type="button"
                              onClick={() => void handleDeleteDocument(document)}
                              disabled={busy}
                              className="app-btn app-btn-ghost text-app-danger"
                              title="Remove this document. Test cases already read from it are kept."
                              aria-label={`Remove ${document.filename}`}
                            >
                              <HiOutlineTrash className="h-4 w-4" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="mt-4 text-sm text-app-secondary">
                  No documents yet. Pick a type and upload the files for this scope.
                </p>
              )}
            </div>
          ) : null}
        </div>
      )}
    </SectionCard>
  )
}

export default DocumentIntake
