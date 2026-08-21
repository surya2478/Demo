import React from 'react'
import { useNavigate } from 'react-router-dom'
import Button from '../components/shared/Button'
import SectionCard from '../components/ui/SectionCard'

const Unauthorized: React.FC = () => {
  const navigate = useNavigate()

  return (
    <div className="flex min-h-screen items-center justify-center bg-app-canvas px-4 py-10">
      <div className="w-full max-w-xl">
        <SectionCard
          title="Unauthorized"
          description="You do not have permission to view this page with the current account."
          contentClassName="text-center"
        >
          <div className="space-y-6">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-app-brand-50 text-app-brand-700 shadow-[0_0_0_6px_rgba(183,25,32,0.06)]">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-8 w-8">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 2.25c-3.07 0-5.55.65-7 1.52v5.37C5 13.77 8.13 18.41 12 19.75c3.87-1.34 7-6 7-10.6V3.77c-1.45-.87-3.93-1.52-7-1.52z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.5 11h5M12 9v4" />
              </svg>
            </div>
            <div className="flex justify-center gap-3">
              <Button onClick={() => navigate(-1)} variant="secondary">
                Go back
              </Button>
              <Button onClick={() => navigate('/dashboard')}>Back to Dashboard</Button>
            </div>
          </div>
        </SectionCard>
      </div>
    </div>
  )
}

export default Unauthorized
