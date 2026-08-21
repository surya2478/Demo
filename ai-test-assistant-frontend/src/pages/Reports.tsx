import React from 'react'
import AppPageHeader from '../components/ui/AppPageHeader'
import EmptyState from '../components/ui/EmptyState'

const Reports: React.FC = () => {
  return (
    <div className="space-y-6">
      <AppPageHeader
        eyebrow="Reports"
        title="Reports"
        description="Review exported and generated reporting views from the administration and AI testing workflows."
      />
      <EmptyState
        title="Report content appears here"
        description="This screen has been moved onto the shared maroon layout without introducing placeholder business data."
      />
    </div>
  )
}

export default Reports
