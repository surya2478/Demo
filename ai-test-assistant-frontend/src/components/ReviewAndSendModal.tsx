import React, { useEffect, useMemo, useState } from 'react'
import MarkdownViewer from './MarkdownViewer'

export type ReviewDocumentItem = {
  id: string
  name: string
  content: string
  type: 'file' | 'spark'
}

interface ReviewAndSendModalProps {
  isOpen: boolean
  documents: ReviewDocumentItem[]
  tableData: Record<string, string>[]
  onClose: () => void
  onTableDataChange: (nextRows: Record<string, string>[]) => void
  onSendForApproval: (rows: Record<string, string>[], documents: ReviewDocumentItem[]) => void
}

const ReviewAndSendModal: React.FC<ReviewAndSendModalProps> = ({
  isOpen,
  documents,
  tableData,
  onClose,
  onTableDataChange,
  onSendForApproval
}) => {
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [baselineRows, setBaselineRows] = useState<Record<string, string>[]>([])
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null)
  const [selectedCell, setSelectedCell] = useState<{ rowId: string; column: string } | null>(null)
  const [documentViewer, setDocumentViewer] = useState<{ name: string; content: string } | null>(null)
  const [viewerZoom, setViewerZoom] = useState(1)
  const [isReferenceDrawerOpen, setIsReferenceDrawerOpen] = useState(false)

  useEffect(() => {
    if (!isOpen) return

    const nextRows = tableData.map((row) => ({ ...row }))
    setRows(nextRows)
    setBaselineRows(nextRows.map((row) => ({ ...row })))
    setSelectedRowId(nextRows[0]?.id ?? null)
    setSelectedCell(null)
    setViewerZoom(1)
    setIsReferenceDrawerOpen(false)
  }, [isOpen])

  const columns = useMemo(() => {
    if (!rows.length) return []
    return Object.keys(rows[0]).filter((key) => key !== 'id')
  }, [rows])

  const renderableRows = useMemo(() => rows.filter((row) => {
    if (columns.length === 0) return true
    return !columns.every((column) => (row[column] ?? '').trim().toLowerCase() === column.trim().toLowerCase())
  }), [rows, columns])

  const getRowKey = (row: Record<string, string>, index: number) => String(row.id ?? `row-${index}`)

  const rowChanged = (row: Record<string, string>) => {
    const baselineRow = baselineRows.find((item) => item.id === row.id)
    if (!baselineRow) return false
    return JSON.stringify(row) !== JSON.stringify(baselineRow)
  }

  const cellChanged = (row: Record<string, string>, column: string) => {
    const baselineRow = baselineRows.find((item) => item.id === row.id)
    if (!baselineRow) return false
    return (row[column] ?? '') !== (baselineRow[column] ?? '')
  }

  const handleCellChange = (rowId: string, column: string, value: string) => {
    const nextRows = rows.map((row) => (row.id === rowId ? { ...row, [column]: value } : row))
    setRows(nextRows)
    onTableDataChange(nextRows)
  }

  const handleRemoveRow = (rowId: string) => {
    const nextRows = rows.filter((row) => String(row.id ?? '') !== String(rowId))
    setRows(nextRows)
    onTableDataChange(nextRows)
    if (selectedRowId === rowId) setSelectedRowId(null)
    if (selectedCell?.rowId === rowId) setSelectedCell(null)
  }

  const handleSubmit = () => {
    onSendForApproval(rows, documents)
    onClose()
  }

  if (!isOpen) return null

  return (
    <>
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        <div className="flex h-[92vh] w-full max-w-[96vw] flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-[0_28px_70px_rgba(15,23,42,0.18)] animate-[fadeIn_0.2s_ease-out]">
          <div className="flex items-center justify-between border-b border-red-200 bg-red-600 px-5 py-4 text-white">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 text-white shadow-sm">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 11.5h6M9 15.5h6M8 3h8l5 5v11a3 3 0 01-3 3H8a3 3 0 01-3-3V6a3 3 0 013-3zm7 1v5h5" />
                </svg>
              </div>
              <div>
                <div className="text-[16px] font-bold tracking-[-0.02em] text-white">Review & Send</div>
                <div className="text-[12px] text-red-50">Review, refine, and approve generated test cases prior to final submission.</div>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label="Close review modal"
              className="rounded-full p-2 text-slate-500 transition hover:bg-white hover:text-slate-900"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M6.28 5.22a.75.75 0 011.06 0L10 7.88l2.66-2.66a.75.75 0 111.06 1.06L11.06 8.94l2.66 2.66a.75.75 0 11-1.06 1.06L10 10l-2.66 2.66a.75.75 0 11-1.06-1.06L8.94 8.94 6.28 6.28a.75.75 0 010-1.06z" clipRule="evenodd" />
              </svg>
            </button>
          </div>

          <div className="grid h-full min-h-0 flex-1 grid-cols-1 lg:grid-cols-[auto_minmax(0,2.5fr)]">
            <aside className={`flex min-h-0 flex-col overflow-hidden border-b border-slate-200 bg-slate-50/80 transition-all duration-200 lg:border-b-0 lg:border-r ${isReferenceDrawerOpen ? 'w-full lg:w-[280px]' : 'w-[64px]'}`}>
              <div className="flex items-center justify-between border-b border-slate-200 bg-slate-100 px-3 py-3">
                <div className={`flex items-center gap-2 ${!isReferenceDrawerOpen ? 'justify-center w-full' : ''}`}>
                  <button
                    type="button"
                    onClick={() => setIsReferenceDrawerOpen((value) => !value)}
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                    aria-label={isReferenceDrawerOpen ? 'Collapse reference files' : 'Expand reference files'}
                    title={isReferenceDrawerOpen ? 'Collapse' : 'Expand'}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                      <path strokeLinecap="round" strokeLinejoin="round" d={isReferenceDrawerOpen ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'} />
                    </svg>
                  </button>

                  {isReferenceDrawerOpen && (
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-700">Reference Files</div>
                  )}
                </div>
              </div>

              {isReferenceDrawerOpen ? (
                <div className="flex-1 space-y-3 overflow-y-auto overflow-x-hidden p-4">
                  {documents.length > 0 ? (
                    documents.map((document) => (
                      <div
                        key={document.id}
                        className="flex items-center justify-between gap-3 rounded-[14px] border border-slate-200 bg-white p-3.5 shadow-[0_4px_12px_rgba(15,23,42,0.04)] transition hover:border-slate-300 hover:shadow-[0_8px_18px_rgba(15,23,42,0.08)]"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-slate-100 text-slate-700">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M7 3h7l5 5v13a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2zm7 1v5h5" />
                            </svg>
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-[12px] font-semibold text-slate-800">{document.name}</div>
                            <div className="text-[10px] uppercase tracking-[0.14em] text-slate-500">{document.type === 'spark' ? 'E2E Spark' : 'Document'}</div>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => setDocumentViewer({ name: document.name, content: document.content })}
                          className="flex h-8 w-8 items-center justify-center rounded-[10px] border border-slate-200 bg-slate-50 text-slate-700 transition hover:border-slate-300 hover:bg-slate-100"
                          aria-label={`View ${document.name}`}
                          title="View document"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-[16px] border border-dashed border-slate-200 bg-white p-4 text-[12px] text-slate-600">
                      No reference documents attached.
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-1 items-center justify-center p-2">
                  <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">Files</div>
                </div>
              )}
            </aside>

            <main className="flex min-h-0 flex-col bg-white">
              <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-700">Generated Test Cases</div>
                <div className="text-[11px] text-slate-600">{renderableRows.length} record{renderableRows.length === 1 ? '' : 's'}</div>
              </div>

              <div className="flex-1 p-4">
                {renderableRows.length > 0 ? (
                  <div className="h-full overflow-hidden rounded-[18px] border border-slate-200 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.04)]">
                    <div className="max-h-[calc(92vh-180px)] overflow-y-auto overflow-x-hidden">
                      <table className="w-full table-fixed border-collapse text-left text-[12px]">
                        <colgroup>
                          <col className="w-[64px]" />
                          {columns.map((column) => (
                            <col key={column} className="w-auto" />
                          ))}
                          <col className="w-[90px]" />
                        </colgroup>
                        <thead className="sticky top-0 z-10 bg-slate-100">
                          <tr>
                            <th className="border-b border-slate-200 px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-800">#</th>
                            {columns.map((column) => (
                              <th key={column} className="border-b border-slate-200 px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-800">
                                {column}
                              </th>
                            ))}
                            <th className="border-b border-slate-200 px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-800">Remove</th>
                          </tr>
                        </thead>
                        <tbody>
                          {renderableRows.map((row, index) => {
                            const rowKey = getRowKey(row, index)
                            const isSelected = selectedRowId === row.id
                            const changed = rowChanged(row)

                            return (
                              <tr
                                key={rowKey}
                                onClick={() => {
                                  setSelectedRowId(row.id || null)
                                  setIsReferenceDrawerOpen(false)
                                }}
                                className={`align-top transition ${isSelected ? 'bg-slate-50' : changed ? 'bg-slate-50/80' : 'bg-white'} ${isSelected ? 'ring-1 ring-slate-200' : ''}`}
                              >
                                <td className={`border-b border-slate-100 px-3 py-3 align-top font-semibold text-slate-700 ${changed ? 'bg-slate-50/80' : ''}`}>
                                  {index + 1}
                                </td>

                                {columns.map((column) => {
                                  const isEditing = selectedCell?.rowId === row.id && selectedCell?.column === column
                                  const changedCell = cellChanged(row, column)

                                  return (
                                    <td
                                      key={`${rowKey}-${column}`}
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        setSelectedRowId(row.id || null)
                                        setSelectedCell({ rowId: row.id || rowKey, column })
                                        setIsReferenceDrawerOpen(false)
                                      }}
                                      className={`border-b border-slate-100 px-3 py-3 align-top transition ${changedCell ? 'border border-red-200 bg-red-50 font-bold text-slate-900 shadow-[inset_0_0_0_1px_rgba(239,68,68,0.14)]' : ''}`}
                                    >
                                      {isEditing ? (
                                        <textarea
                                          autoFocus
                                          value={row[column] ?? ''}
                                          onChange={(event) => handleCellChange(row.id || rowKey, column, event.target.value)}
                                          onBlur={() => setSelectedCell(null)}
                                          rows={Math.max(4, (row[column] ?? '').split('\n').length + 2)}
                                          className="min-h-[120px] w-full resize-y rounded-[12px] border border-slate-200 bg-white px-2.5 py-2 text-[12px] leading-6 text-slate-900 shadow-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                                        />
                                      ) : (
                                        <div className="min-h-[44px] whitespace-pre-wrap break-words rounded-[10px] px-2 py-2 text-[12px] leading-6 text-slate-800">
                                          {row[column] || '—'}
                                        </div>
                                      )}
                                    </td>
                                  )
                                })}

                                <td className="border-b border-slate-100 px-3 py-3 align-top">
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      handleRemoveRow(row.id || rowKey)
                                    }}
                                    className="rounded-[8px] border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] font-semibold text-red-700 transition hover:bg-red-100"
                                  >
                                    Remove
                                  </button>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-[16px] border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-700">
                    No generated test case rows were found to review.
                  </div>
                )}
              </div>
            </main>
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-[12px] border border-slate-200 bg-white px-4 py-2.5 text-[13px] font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              className="rounded-[12px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-4 py-2.5 text-[13px] font-semibold text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] transition hover:opacity-95"
            >
              Send for Approval
            </button>
          </div>
        </div>
      </div>

      {documentViewer && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
          onClick={(event) => {
            if (event.target === event.currentTarget) setDocumentViewer(null)
          }}
        >
          <div className="flex h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-[0_28px_70px_rgba(15,23,42,0.16)]">
            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-5 py-3">
              <div className="text-[14px] font-bold text-slate-900">{documentViewer.name}</div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setViewerZoom((current) => Number(Math.max(0.8, current - 0.1).toFixed(1)))}
                  className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  −
                </button>
                <div className="min-w-[58px] text-center text-[11px] font-semibold text-slate-700">{viewerZoom.toFixed(1)}x</div>
                <button
                  type="button"
                  onClick={() => setViewerZoom((current) => Number(Math.min(2, current + 0.1).toFixed(1)))}
                  className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => setDocumentViewer(null)}
                  aria-label="Close document viewer"
                  className="rounded-full p-2 text-slate-500 transition hover:bg-white hover:text-slate-900"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M6.28 5.22a.75.75 0 011.06 0L10 7.88l2.66-2.66a.75.75 0 111.06 1.06L11.06 8.94l2.66 2.66a.75.75 0 11-1.06 1.06L10 10l-2.66 2.66a.75.75 0 11-1.06-1.06L8.94 8.94 6.28 6.28a.75.75 0 010-1.06z" clipRule="evenodd" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto bg-slate-50 p-5">
              <div
                className="rounded-[18px] border border-slate-200 bg-white p-4 shadow-sm"
                style={{ fontSize: `${14 * viewerZoom}px`, lineHeight: 1.7 }}
              >
                <MarkdownViewer content={documentViewer.content || 'No document content available.'} className="prose prose-sm max-w-none" />
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default ReviewAndSendModal
