import React, { useMemo } from 'react'

// A "Project" filter for Automation Studio lists, built from the projects the
// listed items actually carry. 'all', 'none' (cases from before projects, or
// from outside the Test Assistant), or a project id.

export interface ProjectRef {
  id: number
  ppm_id: string
  name: string
}

export const matchesProject = (item: { project?: ProjectRef | null }, filter: string) =>
  filter === 'all' || (filter === 'none' ? !item.project : String(item.project?.id) === filter)

const ProjectFilter: React.FC<{
  items: { project?: ProjectRef | null }[]
  value: string
  onChange: (value: string) => void
  className?: string
}> = ({ items, value, onChange, className }) => {
  const options = useMemo(() => {
    const byId = new Map<number, ProjectRef>()
    items.forEach((item) => { if (item.project) byId.set(item.project.id, item.project) })
    return Array.from(byId.values()).sort((a, b) => a.ppm_id.localeCompare(b.ppm_id))
  }, [items])
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label="Filter by project"
      className={className ?? 'app-input h-8 w-[190px] py-0 text-xs'}
    >
      <option value="all">All projects</option>
      {options.map((item) => (
        <option key={item.id} value={String(item.id)}>{item.ppm_id} · {item.name}</option>
      ))}
      <option value="none">No project</option>
    </select>
  )
}

export const ProjectTag: React.FC<{ project?: ProjectRef | null }> = ({ project }) =>
  project ? (
    <span
      title={`${project.ppm_id} · ${project.name}`}
      className="ml-1.5 inline-flex h-[18px] items-center rounded-full bg-[#FFF5F5] px-1.5 align-middle text-[10px] font-semibold text-[#941216]"
    >
      {project.ppm_id}
    </span>
  ) : null

export default ProjectFilter
