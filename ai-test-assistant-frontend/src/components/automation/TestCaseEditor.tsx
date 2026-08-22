/**
 * --- Automation Module: refined test case editor ------------------------
 *
 * The inline editor behind the pencil in the refined grid.
 *
 * Edits the prose fields only. Structured steps, test data requirements and
 * the classification are all derived from refinement, and letting them be
 * hand-edited here would put the grid's structured view out of step with the
 * text a generator compiles from. Re-refining is the way to change those.
 *
 * Saving re-scores server-side, so the verdict and test-data status the grid
 * shows afterwards reflect what was actually typed.
 */
import React, { useEffect, useState } from 'react'
import { HiOutlineX, HiOutlineSave, HiOutlineExclamationCircle } from 'react-icons/hi'
import { ClassificationBadge, TestDataBadge } from './workbenchPresentation'
import type { WorkbenchCase } from '../../types/automation'

interface TestCaseEditorProps {
  testCase: WorkbenchCase | null
  saving: boolean
  error: string | null
  onCancel: () => void
  onSave: (patch: Record<string, string>) => void
}

const FIELDS: Array<{
  key: keyof WorkbenchCase | 'title'
  label: string
  rows?: number
  placeholder?: string
}> = [
  { key: 'title', label: 'Test case ID' },
  { key: 'priority', label: 'Priority', placeholder: 'High | Medium | Low' },
  { key: 'test_type', label: 'Test type', placeholder: 'Positive | Negative | Edge / Boundary | Regression' },
  { key: 'objective', label: 'Objective', rows: 2, placeholder: 'One sentence: what this test proves' },
  { key: 'preconditions', label: 'Preconditions', rows: 3 },
  { key: 'steps_raw', label: 'Test steps', rows: 6 },
  { key: 'test_data', label: 'Test data', rows: 2 },
  { key: 'expected_result', label: 'Expected result', rows: 2 },
  { key: 'test_data_notes', label: 'Test data notes', rows: 2, placeholder: 'What an approver must provide' }
]

export const TestCaseEditor: React.FC<TestCaseEditorProps> = ({
  testCase,
  saving,
  error,
  onCancel,
  onSave
}) => {
  const [form, setForm] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!testCase) return
    setForm({
      title: testCase.tc_display_id ?? '',
      priority: testCase.priority ?? '',
      test_type: testCase.test_type ?? '',
      objective: testCase.objective ?? '',
      preconditions: testCase.preconditions ?? '',
      steps_raw: testCase.steps_raw ?? '',
      test_data: testCase.test_data ?? '',
      expected_result: testCase.expected_result ?? '',
      test_data_notes: testCase.test_data_notes ?? ''
    })
  }, [testCase])

  if (!testCase) return null

  return (
    <div
      className="fixed inset-0 z-[65] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
      onClick={e => {
        if (e.target === e.currentTarget && !saving) onCancel()
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="flex h-[92vh] w-full max-w-[860px] flex-col overflow-hidden rounded-[24px] border border-app bg-app-surface shadow-[0_28px_70px_rgba(15,23,42,0.18)]">
        <div className="flex items-start justify-between gap-3 border-b border-app bg-app-surface-muted px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-bold text-app-primary">
              Edit {testCase.tc_display_id}
              {testCase.version > 1 ? (
                <span className="ml-1.5 font-normal text-app-secondary">v{testCase.version}</span>
              ) : null}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <ClassificationBadge classification={testCase.classification} />
              <TestDataBadge
                required={testCase.test_data_required}
                status={testCase.test_data_status}
              />
              <span className="text-[11px] text-app-secondary">
                Steps and test data requirements come from refinement — re-refine to change them.
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-md p-1.5 text-app-secondary transition hover:bg-app-surface hover:text-app-primary disabled:opacity-50"
            aria-label="Close"
          >
            <HiOutlineX className="h-5 w-5" />
          </button>
        </div>

        <div className="app-scroll flex-1 overflow-y-auto px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {FIELDS.map(field => {
              const wide = (field.rows ?? 1) > 1
              return (
                <div key={String(field.key)} className={wide ? 'sm:col-span-3' : ''}>
                  <label className="mb-1 block text-[12px] font-semibold text-app-primary">
                    {field.label}
                  </label>
                  {wide ? (
                    <textarea
                      value={form[field.key as string] ?? ''}
                      onChange={e =>
                        setForm(prev => ({ ...prev, [field.key as string]: e.target.value }))
                      }
                      rows={field.rows}
                      placeholder={field.placeholder}
                      className="app-input app-scroll w-full resize-y"
                    />
                  ) : (
                    <input
                      value={form[field.key as string] ?? ''}
                      onChange={e =>
                        setForm(prev => ({ ...prev, [field.key as string]: e.target.value }))
                      }
                      placeholder={field.placeholder}
                      className="app-input w-full"
                    />
                  )}
                </div>
              )
            })}
          </div>

          {testCase.steps.length > 0 ? (
            <div className="mt-4">
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-app-secondary">
                Structured steps (read-only)
              </h3>
              <div className="overflow-x-auto rounded-app border border-app">
                <table className="app-table">
                  <thead>
                    <tr>
                      <th className="text-left">#</th>
                      <th className="text-left">Action</th>
                      <th className="text-left">Target</th>
                      <th className="text-left">Data</th>
                    </tr>
                  </thead>
                  <tbody>
                    {testCase.steps.map(step => (
                      <tr key={step.step_number}>
                        <td className="text-[12px] text-app-secondary">{step.step_number}</td>
                        <td className="text-[12px] text-app-primary">{step.action}</td>
                        <td className="text-[12px] text-app-secondary">{step.target ?? '—'}</td>
                        <td className="font-mono text-[11px] text-app-brand-700">
                          {step.test_data_ref ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="mt-4 flex items-start gap-2 rounded-app border border-red-200 bg-app-danger-bg px-3 py-3 text-[13px] text-app-danger">
              <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-app bg-app-surface-muted px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="app-btn app-btn-secondary disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(form)}
            disabled={saving}
            className="app-btn app-btn-primary inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <HiOutlineSave className="h-4 w-4" />
            {saving ? 'Saving…' : 'Save and re-score'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default TestCaseEditor
