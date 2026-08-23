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
import {
  HiOutlineX,
  HiOutlineSave,
  HiOutlineExclamationCircle,
  HiOutlinePlus,
  HiOutlineTrash,
  HiOutlineArrowUp,
  HiOutlineArrowDown
} from 'react-icons/hi'
import { ClassificationBadge, TestDataBadge } from './workbenchPresentation'
import StatusBadge from '../ui/StatusBadge'
import type { WorkbenchCase, RefinedStep } from '../../types/automation'

interface TestCaseEditorProps {
  testCase: WorkbenchCase | null
  saving: boolean
  error: string | null
  onCancel: () => void
  onSave: (patch: Record<string, any>) => void
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
  const [dataRequired, setDataRequired] = useState(false)
  const [steps, setSteps] = useState<RefinedStep[]>([])

  useEffect(() => {
    if (!testCase) return
    setForm({
      title: testCase.tc_display_id ?? '',
      priority: testCase.priority ?? '',
      test_type: testCase.test_type ?? '',
      objective: testCase.objective ?? '',
      preconditions: testCase.preconditions ?? '',
      test_data: testCase.test_data ?? '',
      expected_result: testCase.expected_result ?? '',
      test_data_notes: testCase.test_data_notes ?? ''
    })
    setDataRequired(testCase.test_data_status === 'pending')
    setSteps(
      testCase.steps && testCase.steps.length > 0
        ? JSON.parse(JSON.stringify(testCase.steps))
        : []
    )
  }, [testCase])

  const handleUpdateStep = (idx: number, field: keyof RefinedStep, val: any) => {
    setSteps(prev => {
      const next = [...prev]
      next[idx] = { ...next[idx], [field]: val }
      return next
    })
  }

  const handleAddStep = () => {
    setSteps(prev => [
      ...prev,
      {
        step_number: prev.length + 1,
        action: '',
        target: '',
        test_data_ref: null,
        expected_result: ''
      }
    ])
  }

  const handleDeleteStep = (idx: number) => {
    setSteps(prev => {
      const next = prev.filter((_, i) => i !== idx)
      return next.map((s, i) => ({ ...s, step_number: i + 1 }))
    })
  }

  const handleMoveStep = (idx: number, direction: 'up' | 'down') => {
    if (direction === 'up' && idx === 0) return
    if (direction === 'down' && idx === steps.length - 1) return
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1
    setSteps(prev => {
      const next = [...prev]
      const temp = next[idx]
      next[idx] = next[targetIdx]
      next[targetIdx] = temp
      return next.map((s, i) => ({ ...s, step_number: i + 1 }))
    })
  }

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
      <div className="flex h-[94vh] w-full max-w-[960px] flex-col overflow-hidden rounded-[24px] border border-app bg-app-surface shadow-[0_28px_70px_rgba(15,23,42,0.18)]">
        <div className="flex items-start justify-between gap-3 border-b border-app bg-app-surface-muted px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[16px] font-bold text-app-primary">
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
                Edit general details and structured test steps below.
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

        <div className="app-scroll flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {/* General Metadata Fields */}
          <div className="grid gap-3.5 sm:grid-cols-3">
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
                      className="app-input app-scroll w-full resize-y text-[13px]"
                    />
                  ) : (
                    <input
                      value={form[field.key as string] ?? ''}
                      onChange={e =>
                        setForm(prev => ({ ...prev, [field.key as string]: e.target.value }))
                      }
                      placeholder={field.placeholder}
                      className="app-input w-full text-[13px]"
                    />
                  )}
                </div>
              )
            })}
          </div>

          {/* Test Data Requirements Gate */}
          <div className="rounded-2xl border border-orange-200 bg-app-warning-bg p-4 shadow-sm">
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-app-warning">
              Test Data
            </h3>

            {testCase.test_data_requirements?.length ? (
              <ul className="mb-3 space-y-1.5">
                {testCase.test_data_requirements.map(requirement => (
                  <li key={requirement.key} className="text-[12px] text-app-primary flex items-center gap-1.5">
                    <span className="font-mono text-[11px] font-bold">{requirement.key}</span>
                    {requirement.description ? ` — ${requirement.description}` : ''}
                    <StatusBadge tone="neutral" size="sm" className="ml-1">
                      {requirement.resolution}
                    </StatusBadge>
                    {requirement.sensitive ? (
                      <StatusBadge tone="danger" size="sm" className="ml-1">
                        sensitive
                      </StatusBadge>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-2 text-[12px] text-app-secondary">
                No test data needs were identified for this test case.
              </p>
            )}

            <label className="flex items-start gap-2 text-[12px] text-app-primary">
              <input
                type="checkbox"
                checked={dataRequired}
                onChange={e => setDataRequired(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded text-app-brand-600 focus:ring-app-brand-500"
              />
              <span>
                Test data still required — <strong>approval stays blocked while this is ticked</strong>.
                Clear it once the data above has been provided.
              </span>
            </label>
          </div>

          {/* Interactive Structured Steps Editor */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-[13px] font-bold text-app-primary flex items-center gap-2">
                  <span>Structured Test Steps</span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                    {steps.length} steps
                  </span>
                </h3>
                <p className="text-[11px] text-app-secondary mt-0.5">
                  Directly edit action descriptions, target elements, expected results, or reorder/add steps.
                </p>
              </div>

              <button
                type="button"
                onClick={handleAddStep}
                className="app-btn bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 inline-flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg shadow-sm"
              >
                <HiOutlinePlus className="h-3.5 w-3.5" />
                Add Step
              </button>
            </div>

            <div className="space-y-3">
              {steps.map((step, idx) => (
                <div
                  key={step.step_number || idx}
                  className="rounded-2xl border border-app bg-app-surface p-4 shadow-sm space-y-3 transition hover:border-indigo-300"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-white font-bold text-xs">
                        {idx + 1}
                      </span>
                      <span className="text-xs font-bold uppercase tracking-wider text-indigo-900">
                        Step {idx + 1}
                      </span>
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleMoveStep(idx, 'up')}
                        disabled={idx === 0}
                        className="rounded p-1 text-app-secondary hover:bg-slate-100 disabled:opacity-30"
                        title="Move Step Up"
                      >
                        <HiOutlineArrowUp className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMoveStep(idx, 'down')}
                        disabled={idx === steps.length - 1}
                        className="rounded p-1 text-app-secondary hover:bg-slate-100 disabled:opacity-30"
                        title="Move Step Down"
                      >
                        <HiOutlineArrowDown className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteStep(idx)}
                        className="rounded p-1 text-red-500 hover:bg-red-50 ml-1"
                        title="Delete Step"
                      >
                        <HiOutlineTrash className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <label className="mb-1 block text-[11px] font-semibold text-app-primary">
                        Action Description <span className="text-red-500">*</span>
                      </label>
                      <textarea
                        value={step.action}
                        onChange={e => handleUpdateStep(idx, 'action', e.target.value)}
                        rows={2}
                        placeholder="e.g. Click 'Buy Now' button under Samsung Galaxy Fold8 Ultra Eco Bundle"
                        className="app-input w-full text-xs"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-[11px] font-semibold text-app-secondary">
                        Target Element / Control
                      </label>
                      <input
                        value={step.target ?? ''}
                        onChange={e => handleUpdateStep(idx, 'target', e.target.value)}
                        placeholder="e.g. 'Buy Now' button / Search icon"
                        className="app-input w-full text-xs"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-[11px] font-semibold text-app-secondary">
                        Test Data Reference (Optional)
                      </label>
                      <input
                        value={step.test_data_ref ?? ''}
                        onChange={e => handleUpdateStep(idx, 'test_data_ref', e.target.value || null)}
                        placeholder="e.g. search_query, username"
                        className="app-input w-full text-xs font-mono"
                      />
                    </div>

                    <div className="sm:col-span-2">
                      <label className="mb-1 block text-[11px] font-semibold text-app-primary">
                        Expected Result (Observable Post-Condition)
                      </label>
                      <textarea
                        value={step.expected_result ?? ''}
                        onChange={e => handleUpdateStep(idx, 'expected_result', e.target.value)}
                        rows={2}
                        placeholder="e.g. Shopping Cart page displays product with selected specifications and enabled 'Proceed to Secure Checkout' button"
                        className="app-input w-full text-xs"
                      />
                    </div>
                  </div>
                </div>
              ))}

              {steps.length === 0 ? (
                <div className="text-center py-6 border-2 border-dashed border-slate-200 rounded-2xl">
                  <p className="text-xs text-app-secondary">No steps defined yet.</p>
                  <button
                    type="button"
                    onClick={handleAddStep}
                    className="mt-2 text-xs font-semibold text-indigo-600 hover:underline"
                  >
                    + Add your first step
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          {error ? (
            <div className="flex items-start gap-2 rounded-2xl border border-red-200 bg-app-danger-bg px-4 py-3 text-[13px] text-app-danger">
              <HiOutlineExclamationCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-app bg-app-surface-muted px-6 py-4">
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
            onClick={() =>
              onSave({
                ...form,
                test_data_required: dataRequired,
                test_data_status: dataRequired ? 'pending' : 'user_provided',
                steps_structured: steps
              })
            }
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
