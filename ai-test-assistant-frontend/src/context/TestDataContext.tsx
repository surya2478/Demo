import React, { createContext, useContext, useState, ReactNode } from 'react'

interface TestDataContextType {
  testCasesData: string | null
  setTestCasesData: (data: string | null) => void
  clearTestCasesData: () => void
}

const TestDataContext = createContext<TestDataContextType | undefined>(undefined)

export const TestDataProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [testCasesData, setTestCasesData] = useState<string | null>(null)

  const clearTestCasesData = () => {
    setTestCasesData(null)
  }

  return (
    <TestDataContext.Provider value={{ testCasesData, setTestCasesData, clearTestCasesData }}>
      {children}
    </TestDataContext.Provider>
  )
}

export const useTestDataContext = () => {
  const context = useContext(TestDataContext)
  if (!context) {
    throw new Error('useTestDataContext must be used within TestDataProvider')
  }
  return context
}