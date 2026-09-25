import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import projectService, { type Project } from '../services/projectService'

// The project being worked on, shared by every page of the journey: chosen on
// Generate Test Cases, shown and filtered on in Review & Approval and
// Automation Studio. Remembered in this browser; the server is asked again on
// load, so a project renamed by someone else shows its current name.

interface ProjectContextValue {
  project: Project | null
  setProject: (project: Project | null) => void
}

const STORAGE_KEY = 'current_project'

const ProjectContext = createContext<ProjectContextValue>({ project: null, setProject: () => undefined })

const readStored = (): Project | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Project) : null
  } catch {
    return null
  }
}

export const ProjectProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [project, setProjectState] = useState<Project | null>(readStored)

  const setProject = useCallback((next: Project | null) => {
    setProjectState(next)
    try {
      if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: next.id, ppm_id: next.ppm_id, name: next.name }))
      else localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Storage unavailable: the choice lasts for this visit only.
    }
  }, [])

  useEffect(() => {
    const stored = readStored()
    if (!stored || !localStorage.getItem('api_token')) return
    projectService.get(stored.id)
      .then((fresh) => setProject(fresh))
      .catch((error) => {
        if (error?.response?.status === 404) setProject(null)
      })
  }, [setProject])

  const value = useMemo(() => ({ project, setProject }), [project, setProject])
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
}

export const useProject = () => useContext(ProjectContext)
