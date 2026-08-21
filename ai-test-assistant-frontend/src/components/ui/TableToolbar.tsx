import React from 'react'

interface TableToolbarProps {
  title?: string
  description?: string
  left?: React.ReactNode
  right?: React.ReactNode
}

const TableToolbar: React.FC<TableToolbarProps> = ({ title, description, left, right }) => {
  return (
    <div className="flex flex-col gap-4 rounded-3xl border border-app bg-app-surface px-5 py-4 shadow-app-card sm:px-6 lg:flex-row lg:items-center lg:justify-between">
      <div className="space-y-1">
        {title ? <h2 className="text-base font-semibold text-app-primary">{title}</h2> : null}
        {description ? <p className="text-sm text-app-secondary">{description}</p> : null}
        {left ? <div className="flex flex-wrap items-center gap-3 pt-2">{left}</div> : null}
      </div>
      {right ? <div className="flex flex-wrap items-center gap-3 lg:justify-end">{right}</div> : null}
    </div>
  )
}

export default TableToolbar
