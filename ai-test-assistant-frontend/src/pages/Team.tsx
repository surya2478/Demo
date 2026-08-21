import React from 'react'
import AppPageHeader from '../components/ui/AppPageHeader'
import EmptyState from '../components/ui/EmptyState'

const Team: React.FC = () => {
  return (
    <div className="space-y-6">
      <AppPageHeader
        eyebrow="Administration"
        title="Team"
        description="Team-specific management and collaboration views can live here using the shared enterprise layout."
      />
      <EmptyState
        title="Team view is ready for content"
        description="The shell, spacing, surfaces, and maroon styling are now aligned with the rest of the application."
      />
    </div>
  )
}

export default Team
