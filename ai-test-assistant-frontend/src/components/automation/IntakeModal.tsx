/**
 * --- Automation Module: test case intake --------------------------------
 *
 * Three ways in, because people arrive with the test case in three shapes:
 * typed from scratch, pasted out of a document or email, or sitting in a
 * spreadsheet.
 *
 * Paste parses locally and deterministically rather than through the model.
 * The text already carries its own labels ("Preconditions:", "Expected
 * Result:"), so matching them is instant, free and predictable, where an LLM
 * call would be none of those. It also lands the user in the form with the
 * fields filled, so a mis-parse is visible and correctable before anything is
 * saved — which a silent server-side parse would not be.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react'
import {
  HiOutlineX,
  HiOutlinePlus,
  HiOutlineClipboardList,
  HiOutlineDocumentText,
  HiOutlineTable,
  HiOutlineExclamationCircle,
  HiOutlineCheckCircle
} from 'react-icons/hi'
import automationService from '../../services/automationService'
import StatusBadge from '../ui/StatusBadge'
import { verdictLabel, verdictTone } from './EligibilityMeter'
import type { ImportResult, ManualCaseInput, StudioCase } from '../../types/automation'

type Mode = 'form' | 'paste' | 'csv'

interface IntakeModalProps {
  open: boolean
  onClose: () => void
  canWrite: boolean
  /** Called after anything lands, so the caller can refresh its list. */
  onSaved: (created: StudioCase[]) => void
}

const EMPTY: ManualCaseInput = {
  display_id: '',
  category: '',
  description: '',
  preconditions: '',
  steps_raw: '',
  test_data: '',
  expected_result: ''
}

const MODES: Array<{ id: Mode; label: string; icon: React.ComponentType<any>; hint: string }> = [
  { id: 'form', label: 'Form', icon: HiOutlineClipboardList, hint: 'Type the case field by field.' },
  { id: 'paste', label: 'Paste', icon: HiOutlineDocumentText, hint: 'Paste a whole case; labelled sections are split automatically.' },
  { id: 'csv', label: 'CSV', icon: HiOutlineTable, hint: 'Import a spreadsheet export in bulk.' }
]

const FIELDS: Array<{
  key: keyof ManualCaseInput
  label: string
  placeholder: string
  rows?: number
  required?: boolean
}> = [
  { key: 'display_id', label: 'Test case ID', placeholder: 'TC-AUTH-07', required: true },
  { key: 'category', label: 'Category', placeholder: 'Authentication' },
  { key: 'description', label: 'Description', placeholder: 'What this test proves, in one sentence', rows: 2 },
  { key: 'preconditions', label: 'Preconditions', placeholder: 'State the system must be in — not actions', rows: 2 },
  { key: 'steps_raw', label: 'Test steps', placeholder: '1. Navigate to the login page.\n2. Enter the username.', rows: 5 },
  { key: 'test_data', label: 'Test data', placeholder: 'username: an active account', rows: 2 },
  { key: 'expected_result', label: 'Expected result', placeholder: 'What is observably true at the end', rows: 2 }
]

export const IntakeModal: React.FC<IntakeModalProps> = ({ open, onClose, canWrite, onSaved }) => {
  const [mode, setMode] = useState<Mode>('form')
  const [form, setForm] = useState<ManualCaseInput>(EMPTY)
  const [pasted, setPasted] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<StudioCase | null>(null)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const reset = useCallback(() => {
    setMode('form')
    setForm(EMPTY)
    setPasted('')
    setError(null)
    setSaved(null)
    setImportResult(null)
    setSaving(false)
  }, [])

  const close = useCallback(() => {
    if (saving) return
    reset()
    onClose()
  }, [saving, reset, onClose])

  const setField = (key: keyof ManualCaseInput, value: string) =>
    setForm(prev => ({ ...prev, [key]: value }))

  const parsedPreview = useMemo(() => {
    if (mode !== 'paste' || !pasted.trim()) return null
    return automationService.parsePastedCase(pasted)
  }, [mode, pasted])

  const applyParsed = () => {
    if (!parsedPreview) return
    setForm({
      ...EMPTY,
      ...Object.fromEntries(
        Object.entries(parsedPreview).map(([k, v]) => [k, v ?? ''])
      )
    } as ManualCaseInput)
    setMode('form')
    setError(null)
  }

  const handleSave = async () => {
    if (!form.display_id.trim()) {
      setError('A test case ID is required — it is how the case is identified everywhere else.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const created = await automationService.createCase({
        ...form,
        display_id: form.display_id.trim()
      })
      setSaved(created)
      onSaved([created])
    } catch (err: any) {
      setError(err?.message ?? 'The test case could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const handleImport = async (file: File) => {
    setSaving(true)
    setError(null)
    setImportResult(null)
    try {
      const result = await automationService.importCases(file)
      setImportResult(result)
      onSaved(result.cases ?? [])
    } catch (err: any) {
      setError(err?.message ?? 'The CSV could not be imported.')
    } finally {
      setSaving(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
      onClick={e => {
        if (e.target === e.currentTarget) close()
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="flex h-[92vh] w-full max-w-[900px] flex-col overflow-hidden rounded-[24px] border border-app bg-app-surface shadow-[0_28px_70px_rgba(15,23,42,0.18)]">
        <div className="flex items-center justify-between border-b border-app bg-app-surface-muted px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold text-app-primary">Add a test case</h2>
            <p className="mt-0.5 text-[12px] text-app-secondary">
              Stored in the Studio. The review workflow's own test cases are never modified.
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={saving}
            className="rounded-md p-1.5 text-app-secondary transition hover:bg-app-surface hover:text-app-primary disabled:opacity-50"
            aria-label="Close"
          >
            <HiOutlineX className="h-5 w-5" />
          </button>
        </div>

        <div className="border-b border-app px-5 py-3">
          <div className="flex flex-wrap gap-1.5">
            {MODES.map(m => {
              const Icon = m.icon
              const active = m.id === mode
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    setMode(m.id)
                    setError(null)
                  }}
                  className={[
                    'inline-flex items-center gap-1.5 rounded-app px-3 py-1.5 text-[12px] font-semibold transition',
                    active
                      ? 'border border-app-brand-200 bg-app-brand-50 text-app-brand-800'
                      : 'border border-app bg-app-surface text-app-secondary hover:text-app-primary'
                  ].join(' ')}
                >
                  <Icon className="h-4 w-4" />
                  {m.label}
                </button>
              )
            })}
          </div>
          <p className="mt-2 text-[11px] text-app-secondary">
            {MODES.find(m => m.id === mode)?.hint}
          </p>
        </div>

        <div className="app-scroll flex-1 overflow-y-auto px-5 py-4">
          {!canWrite ? (
            <div className="mb-4 flex items-start gap-2 rounded-app border border-orange-200 bg-app-warning-bg px-3 py-3 text-[13px] text-app-warning">
              <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>You do not have permission to add test cases.</span>
            </div>
          ) : null}

          {mode === 'form' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {FIELDS.map(field => {
                const isWide = (field.rows ?? 1) > 1
                return (
                  <div key={field.key} className={isWide ? 'sm:col-span-2' : ''}>
                    <label className="mb-1 block text-[12px] font-semibold text-app-primary">
                      {field.label}
                      {field.required ? <span className="text-app-danger"> *</span> : null}
                    </label>
                    {isWide ? (
                      <textarea
                        value={(form[field.key] as string) ?? ''}
                        onChange={e => setField(field.key, e.target.value)}
                        rows={field.rows}
                        placeholder={field.placeholder}
                        className="app-input app-scroll w-full resize-y"
                      />
                    ) : (
                      <input
                        value={(form[field.key] as string) ?? ''}
                        onChange={e => setField(field.key, e.target.value)}
                        placeholder={field.placeholder}
                        className="app-input w-full"
                      />
                    )}
                  </div>
                )
              })}
            </div>
          ) : null}

          {mode === 'paste' ? (
            <div className="space-y-3">
              <textarea
                value={pasted}
                onChange={e => setPasted(e.target.value)}
                rows={12}
                placeholder={
                  'Test Case ID: TC-AUTH-07\nCategory: Authentication\nPreconditions: A locked account exists.\nSteps:\n1. Open the login page.\n2. Sign in with the locked account.\nExpected Result: The account-locked message is shown.'
                }
                className="app-input app-scroll w-full resize-y font-mono text-[12px]"
              />
              {parsedPreview ? (
                <div className="rounded-app border border-app bg-app-surface-muted/40 px-3 py-3">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-app-secondary">
                    Parsed into
                  </div>
                  <dl className="grid gap-1.5 sm:grid-cols-2">
                    {FIELDS.map(f => {
                      const value = (parsedPreview as any)[f.key]
                      return (
                        <div key={f.key} className="min-w-0">
                          <dt className="text-[11px] text-app-secondary">{f.label}</dt>
                          <dd
                            className={`truncate text-[12px] ${value ? 'text-app-primary' : 'italic text-app-secondary/70'}`}
                            title={value || undefined}
                          >
                            {value || 'not found'}
                          </dd>
                        </div>
                      )
                    })}
                  </dl>
                  <button
                    type="button"
                    onClick={applyParsed}
                    className="app-btn app-btn-secondary mt-3"
                  >
                    Use this — review in the form
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {mode === 'csv' ? (
            <div className="space-y-3">
              <div className="rounded-app border border-dashed border-app bg-app-surface-muted/40 px-4 py-6 text-center">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv"
                  disabled={!canWrite || saving}
                  onChange={e => {
                    const file = e.target.files?.[0]
                    if (file) void handleImport(file)
                  }}
                  className="mx-auto block text-[12px] text-app-secondary"
                />
                <p className="mt-3 text-[12px] text-app-secondary">
                  Header names are matched case-insensitively against common aliases, so a
                  spreadsheet exported from the review workflow imports without renaming
                  anything.
                </p>
                <p className="mt-1.5 font-mono text-[11px] text-app-secondary/80">
                  Test Case ID, Category, Test Case Description, Preconditions, Test Steps,
                  Test Data, Expected Result
                </p>
              </div>

              {importResult ? (
                <div className="rounded-app border border-app px-3 py-3">
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-app-primary">
                    <HiOutlineCheckCircle className="h-4 w-4 text-app-success" />
                    Imported {importResult.imported}{' '}
                    {importResult.imported === 1 ? 'case' : 'cases'}
                  </div>
                  {importResult.skipped?.length ? (
                    <div className="mt-2">
                      {/* Reported by line number rather than dropped silently, so a
                          bad row can actually be found in the source file. */}
                      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-app-warning">
                        {importResult.skipped.length} row(s) skipped
                      </div>
                      <ul className="mt-1 space-y-0.5">
                        {importResult.skipped.map(s => (
                          <li key={s.line} className="text-[12px] text-app-secondary">
                            Line {s.line}: {s.reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {saved ? (
            <div className="mt-4 flex flex-wrap items-center gap-2 rounded-app border border-green-200 bg-app-success-bg px-3 py-3 text-[13px] text-app-success">
              <HiOutlineCheckCircle className="h-4 w-4 flex-shrink-0" />
              <span className="font-semibold">{saved.display_id}</span>
              <span>saved and scored:</span>
              <StatusBadge tone={verdictTone(saved.eligibility?.verdict)} size="sm" dot>
                {verdictLabel(saved.eligibility?.verdict)} {saved.eligibility?.score}
              </StatusBadge>
            </div>
          ) : null}

          {error ? (
            <div className="mt-4 flex items-start gap-2 rounded-app border border-red-200 bg-app-danger-bg px-3 py-3 text-[13px] text-app-danger">
              <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-app bg-app-surface-muted px-5 py-3">
          <button
            type="button"
            onClick={reset}
            disabled={saving}
            className="text-[12px] font-semibold text-app-secondary transition hover:text-app-primary disabled:opacity-50"
          >
            Clear
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={close}
              disabled={saving}
              className="app-btn app-btn-secondary disabled:opacity-50"
            >
              {saved || importResult ? 'Done' : 'Cancel'}
            </button>
            {mode !== 'csv' ? (
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !canWrite || !form.display_id.trim()}
                className="app-btn app-btn-primary inline-flex items-center gap-1.5 disabled:opacity-50"
                title={mode === 'paste' ? 'Apply the parsed fields first' : undefined}
              >
                <HiOutlinePlus className="h-4 w-4" />
                {saving ? 'Saving…' : 'Save test case'}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

export default IntakeModal
