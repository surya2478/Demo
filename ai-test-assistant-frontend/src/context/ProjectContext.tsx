import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import projectService, { type Project } from '../services/projectService'
import { useAuth } from '../hooks/useAuth'

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
  const { user } = useAuth()
  const username = user?.username ?? null

  const setProject = useCallback((next: Project | null) => {
    setProjectState(next)
    try {
      if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: next.id, ppm_id: next.ppm_id, name: next.name }))
      else localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Storage unavailable: the choice lasts for this visit only.
    }
  }, [])

  // Refreshed only once sign-in has finished (AuthProvider has confirmed the
  // user with /auth/me). Asking straight away on page load raced the sign-in
  // restore: the request could leave before the token did, got 401, and the
  // 401 handler signed the user out on every refresh once a project was saved.
  useEffect(() => {
    if (!username) return
    const stored = readStored()
    if (!stored) return
    projectService.get(stored.id)
      .then((fresh) => setProject(fresh))
      .catch((error) => {
        if (error?.response?.status === 404) setProject(null)
      })
  }, [username, setProject])

  const value = useMemo(() => ({ project, setProject }), [project, setProject])
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
}

export const useProject = () => useContext(ProjectContext)
