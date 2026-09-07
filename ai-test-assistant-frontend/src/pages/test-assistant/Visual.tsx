import React, { useState, ChangeEvent, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { theme } from '../../styles/theme'
import { loadConfigFromServer, getConfig } from '../../config/ai-api'
import MarkdownViewer from '../../components/MarkdownViewer'
import { getTimestampedFilename } from '../../utils/DynamicFileName-DateTime'
import ResetButton from '../../components/ResetButton'
import { buildDetailedFieldAudit } from '../../utils/auditDetailsHelper'
import useAuth from '../../hooks/useAuth'
import { logApiEvent } from '../../utils/auditApiHelper'
import { useTestDataContext } from '../../context/TestDataContext'
import { trackedFetchWithTokens, authHeaderFor } from '../../utils/trackedFetchWithTokens'
import userService from '../../services/userService'
import RequestTrackerAPI from '../../utils/requestTrackerAPI'
import { extractTokenCounts } from '../../utils/streamingFetchHelper'
import { useAIAction } from '../../hooks/useAIAction'


const Visual: React.FC = () => {
  const navigate = useNavigate()
  const [inputType, setInputType] = useState<'text' | 'file'>('text')
  const [url, setUrl] = useState('')
  const [fileInput, setFileInput] = useState<File | null>(null)
  const [output, setOutput] = useState('')
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState('')
  const [isGenerateEnabled, setIsGenerateEnabled] = useState(false)
  const [aiConfig, setAiConfig] = useState(() => getConfig())
  const userAuth = useAuth()
  const { setTestCasesData } = useTestDataContext()    
  const [userTokenAllocation, setUserTokenAllocation] = useState<number>(0)
  const [userTokensUsed, setUserTokensUsed] = useState<number>(0)
  const [tokenCheckLoading, setTokenCheckLoading] = useState<boolean>(false)
  const [showTokenWarning, setShowTokenWarning] = useState<boolean>(false)
  const [tokenWarningMessage, setTokenWarningMessage] = useState<string>('')
  const { runAIAction } = useAIAction()
  const isAdminUser = (() => {
    const role = String((userAuth.user as any)?.role || '').toLowerCase()
    const roles = (userAuth.user as any)?.roles
    return role === 'admin' || (Array.isArray(roles) && roles.some((r: any) => String(r).toLowerCase() === 'admin'))
  })()


  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const cfg = await loadConfigFromServer()
        if (mounted && cfg) {
          setAiConfig(cfg)
        }
      } catch (err) {
        console.warn('Failed to load AI config for Visual', err)
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  // Fetch user token allocation and usage
  useEffect(() => {
    const fetchTokenInfo = async () => {
      if (!userAuth.user?.username) return

      setTokenCheckLoading(true)
      try {
        // For non-admin users: Fetch allocation; For admin users: Only fetch usage
        if (!isAdminUser) {
          const userData = await userService.get(userAuth.user.username)
          const allocation = (userData as any).token_allocation || 10000
          setUserTokenAllocation(allocation)
        } else {
          // Admin users: no allocation limit
          setUserTokenAllocation(0)
        }

        const logsData = await RequestTrackerAPI.getLogs({
          user: userAuth.user.username,
          limit: 100
        })

        let totalUsed = 0
        if (logsData.logs && logsData.logs.length > 0) {
          totalUsed = logsData.logs.reduce((sum, log) => {
            const tokens = parseInt(String((log as any).totalTokens || 0))
            return sum + tokens
          }, 0)
        }

        setUserTokensUsed(totalUsed)

        // Check if user is approaching limit (90%) - only for non-admin users
        if (!isAdminUser && userTokenAllocation > 0) {
          const percentageUsed = (totalUsed / userTokenAllocation) * 100
          if (percentageUsed >= 90) {
            setShowTokenWarning(true)
            setTokenWarningMessage(
              percentageUsed >= 100
                ? 'You have reached your token allocation limit. Please contact your administrator.'
                : `Warning: You have used ${percentageUsed.toFixed(1)}% of your allocated tokens.`
            )
          }
        }
      } catch (err) {
        console.error('[Visual] Failed to fetch token info:', err)
      } finally {
        setTokenCheckLoading(false)
      }
    }

    fetchTokenInfo()
  }, [userAuth.user?.username])

  useEffect(() => {
    if (inputType === 'text') {
      setIsGenerateEnabled(url.trim().length > 0)
    } else {
      setIsGenerateEnabled(fileInput !== null)
    }
  }, [inputType, url, fileInput])
  

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0] ?? null
    setFileInput(selectedFile)
  }

  const handleGenerate = async () => {
    if (!isGenerateEnabled || loading) return

    if (!isAdminUser && userTokenAllocation > 0) {
      if (userTokensUsed >= userTokenAllocation) {
        setShowTokenWarning(true)
        setTokenWarningMessage('You have reached your token allocation limit. Please contact your administrator to increase your allocation.')
        return
      }

      const remainingTokens = userTokenAllocation - userTokensUsed
      if (remainingTokens < 1000 && remainingTokens > 0) {
        setShowTokenWarning(true)
        setTokenWarningMessage(`Warning: You have only ${remainingTokens.toLocaleString()} tokens remaining in your allocation.`)
      }
    }
  
    await runAIAction({
      actionName: 'analyze_visual_test_results',
      actionLabel: 'Reviewing Visual Test Results',
      artifactType: 'Visual Testing Results',
      stages: [
        'Processing uploaded visual evidence',
        'Comparing UI elements and layouts',
        'Identifying visual differences',
        'Classifying impact and severity',
        'Preparing findings'
      ],
      successMessage: 'Visual Testing results are ready.',
      retryAction: handleGenerate,
      execute: async () => {
        setLoading(true)
        setResponse('')
        setOutput('')
      
        const config = getConfig()
        const formData = new FormData()
        
        formData.append("provider", config.PARAMETERS.provider)
        formData.append("model_name", String(config.PARAMETERS.model))
        formData.append("temperature", String(config.PARAMETERS.temperature))
        formData.append("response_format", "text")

        const requestPayload = {
          inputType,
          url,
          fileInputName: fileInput?.name ?? null,
          provider: String(config.PARAMETERS.provider ?? ''),
          temperature: String(config.PARAMETERS.temperature ?? 0),
          model: String(config.PARAMETERS.model ?? ''),
          endpoint: config.ENDPOINTS.generateVisual
        }

        let auditStatus: 'success' | 'failure' = 'success'
        let responsePayload: any = null

        try {
          if (inputType === 'file' && fileInput) {
            formData.append("image", fileInput as Blob)
          } else {
            formData.append("url", url)
          }

          const startedAt = Date.now();
          const { response: res, status, logId } = await trackedFetchWithTokens(
            `${config.BASE_URL}${config.ENDPOINTS.generateVisual}`,
            {
              tab: 'visual',
              method: 'POST',
              body: formData,
              user: userAuth.user?.username || 'anonymous',
              sessionId: sessionStorage.getItem('client_session_id') || undefined,
              externalStream: true
            }
          );

          let fullText = '';
          if (!res.body) {
            fullText = await res.text();
          } else {
            const reader = (res.body as ReadableStream<Uint8Array>).getReader();
            const decoder = new TextDecoder();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value);
              setResponse(prev => prev + chunk.replace('data: ', ''));
              fullText += decoder.decode(value, { stream: true });  
            }
          }

          const tokenInfo = extractTokenCounts(fullText);
          try {
            const duration = Date.now() - startedAt;
            await RequestTrackerAPI.updateRequest(logId, {
              response_status: status,
              response_data: fullText,
              duration,
              promptTokens: tokenInfo?.promptTokens,
              responseTokens: tokenInfo?.responseTokens,
              totalTokens: tokenInfo?.totalTokens
            });
          } catch (logErr) {
            console.error('[Visual] Failed to update request log:', logErr);
          }

          if (!res.ok) {
            throw new Error(`HTTP ${status}: ${fullText}`);
          }

          const tokensUsedInResponse = tokenInfo?.totalTokens ?? 0;
          if (tokensUsedInResponse > 0) {
            const newTotal = userTokensUsed + tokensUsedInResponse;
            setUserTokensUsed(prev => prev + tokensUsedInResponse);
            if (!isAdminUser && userTokenAllocation > 0 && newTotal >= userTokenAllocation) {
              setShowTokenWarning(true);
              setTokenWarningMessage('You have reached your token allocation limit. This was your last request.');
            }
          }
          responsePayload = fullText
          return fullText

        } catch (err) {
          console.error('Generation error:', err)
          setOutput('Error generating test cases. Please try again.')
          auditStatus = 'failure'
          responsePayload = String(err)
          throw err

        } finally {
          setLoading(false)
          try {
            await logApiEvent({
              user: userAuth.user,
              module: 'Visual',
              action: 'Generate Test Cases',
              resourceType: 'API',
              resourceId: 'generateTestCases',
              resourceName: 'Generate Test Cases from Visual Input',
              request: requestPayload,
              response: responsePayload,
              status: auditStatus
            })
          } catch (auditErr) {
            console.error('Failed to log audit event:', auditErr)
          }
        }
      }
    })
  }

  const handleUseForTestData = () => {
    if (response) {
      setTestCasesData(response)
      navigate('/test-assistant/data')
    }
  }

  async function exportToExcel() {
    const config = getConfig()
    const formData = new FormData()
    formData.append("test_cases_text", response)

    let auditStatus: 'success' | 'failure' = 'success'
    const requestPayload = { test_cases_text: response }
    let responsePayload: any = null

    try {
      // Credential chosen by destination, not by availability -- the AI key is
      // not a JWT and 401s if config.BASE_URL has been repointed at the admin
      // backend. See authHeaderFor.
      const exportUrl = `${config.BASE_URL}${config.ENDPOINTS.exportExcel}`
      const res = await fetch(exportUrl, {
        method: "POST",
        body: formData,
        headers: { 'accept': "application/json", ...authHeaderFor(exportUrl) },
      })

      const data = await res.blob()
      if (data.size === 0) return
      
      const url = URL.createObjectURL(data)
      const a = document.createElement("a")
      a.href = url
      a.download = getTimestampedFilename('test-case')
      a.click()
      URL.revokeObjectURL(url)

      responsePayload = a.download
    } catch (err) {
      console.error(err)
      auditStatus = 'failure'
    } finally {
      try {
        await logApiEvent({
          user: userAuth.user,
          module: 'Visual Tests',
          action: 'Export to Excel',
          resourceType: 'API',
          resourceId: 'exportExcel',
          resourceName: 'Export to Excel',
          request: requestPayload,
          response: responsePayload,
          status: auditStatus
        })
      } catch (auditErr) {
        console.error('Failed to log audit event:', auditErr)
      }
    }
  }

  const handleResetAll = () => {
    setInputType('text')
    setUrl('')
    setFileInput(null)
    setOutput('')
    setResponse('')
    setLoading(false)
  }

  return (
    <div className="mx-auto max-w-[1600px]">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold mb-1">VISUAL Data for Test Generation</h2>
          <p className="text-gray-600 text-sm">Generate test cases from images or URLs.</p>
        </div>

        {!tokenCheckLoading && (
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-xs text-gray-500 uppercase tracking-wide">Token Usage</div>
              {isAdminUser ? (
                <>
                  <div className="text-sm font-semibold">
                    <span className="text-gray-900">
                      {userTokensUsed.toLocaleString()}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-gray-500">Total tokens used</div>
                </>
              ) : userTokenAllocation > 0 ? (
                <>
                  <div className="text-sm font-semibold">
                    <span className={userTokensUsed >= userTokenAllocation ? 'text-app-brand-700' : 'text-gray-900'}>
                      {userTokensUsed.toLocaleString()}
                    </span>
                    <span className="text-gray-400 mx-1">/</span>
                    <span className="text-gray-600">{userTokenAllocation.toLocaleString()}</span>
                  </div>
                  <div className="mt-1 w-32 h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 ${
                        userTokensUsed >= userTokenAllocation
                          ? 'bg-red-600'
                          : userTokensUsed >= userTokenAllocation * 0.9
                          ? 'bg-yellow-500'
                          : 'bg-green-500'
                      }`}
                      style={{ width: `${Math.min(100, (userTokensUsed / userTokenAllocation) * 100)}%` }}
                    />
                  </div>
                </>
              ) : (
                <div className="mt-1 text-xs text-gray-500">Token allocation data is not available.</div>
              )}
            </div>
          </div>
        )}
      </div>

      {showTokenWarning && (
        <div
          className={`mb-4 p-4 rounded-lg border-l-4 ${
            userTokensUsed >= userTokenAllocation ? 'bg-app-brand-50 border-red-500' : 'bg-yellow-50 border-yellow-500'
          }`}
        >
          <div className="flex items-start gap-3">
            <svg
              className={`w-5 h-5 flex-shrink-0 ${
                userTokensUsed >= userTokenAllocation ? 'text-app-brand-700' : 'text-yellow-600'
              }`}
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                clipRule="evenodd"
              />
            </svg>
            <div className="flex-1">
              <p className={`text-sm font-medium ${userTokensUsed >= userTokenAllocation ? 'text-red-800' : 'text-yellow-800'}`}>
                {tokenWarningMessage}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-[20px] border border-app bg-app-surface p-4 shadow-app-card mb-4">
        <div className="mb-3 grid gap-2 md:grid-cols-2">
          <label className={`cursor-pointer rounded-[12px] border px-3 py-2 transition-all duration-200 ${inputType === 'text' ? 'border-app-brand-200 bg-app-brand-50/60' : 'border-app bg-white hover:border-app-brand-100 hover:bg-app-brand-50/30'}`}>
            <input
              type="radio"
              data-audit-name="Visual URL Input"
              checked={inputType === 'text'}
              onChange={() => setInputType('text')}
              className="sr-only"
            />
            <div className="flex items-center gap-2">
              <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[8px] ${inputType === 'text' ? 'bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] text-white' : 'bg-app-surface-muted text-app-secondary'}`}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
              </span>
              <span className={`text-[13px] font-semibold ${inputType === 'text' ? 'text-app-brand-800' : 'text-app-primary'}`}>URL Input</span>
            </div>
          </label>
          <label className={`cursor-pointer rounded-[12px] border px-3 py-2 transition-all duration-200 ${inputType === 'file' ? 'border-app-brand-200 bg-app-brand-50/60' : 'border-app bg-white hover:border-app-brand-100 hover:bg-app-brand-50/30'}`}>
            <input
              type="radio"
              data-audit-name="Visual File Input"
              checked={inputType === 'file'}
              onChange={() => setInputType('file')}
              className="sr-only"
            />
            <div className="flex items-center gap-2">
              <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[8px] ${inputType === 'file' ? 'bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] text-white' : 'bg-app-surface-muted text-app-secondary'}`}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <circle cx="8.5" cy="10.5" r="1.5" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 15l-5-5L5 21" />
                </svg>
              </span>
              <span className={`text-[13px] font-semibold ${inputType === 'file' ? 'text-app-brand-800' : 'text-app-primary'}`}>Upload Image</span>
            </div>
          </label>
        </div>

        {inputType === 'text' ? (
          <input
            type="url"
            data-audit-name="Visual URL Input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Enter image URL..."
            className={theme.input}
          />
        ) : (
          <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
            <input
              type="file"
              data-audit-name="Visual File Input"
              onChange={handleFileChange}
              className="hidden"
              id="image-upload"
              accept="image/*"
            />
            <label
              htmlFor="image-upload" 
              data-audit-name="Visual File Input"
              className="cursor-pointer text-app-brand-700 hover:text-app-brand-800"
            >
              <div data-audit-name="Visual File Input" className="mb-2">Click to upload or drag and drop</div>
              <div data-audit-name="Visual File Input" className="text-sm text-gray-500">
                {fileInput ? fileInput.name : 'Supported files: PNG, JPG, JPEG'}
              </div>
            </label>
          </div>
        )}
      </div>

      <div className="flex justify-between mb-6">
        <button
          onClick={handleGenerate}
          data-audit-name="Generate Visual Test Cases"
          disabled={!isGenerateEnabled || loading}
          className={`px-4 py-2 rounded-md border-2 transition-colors flex items-center ${
            isGenerateEnabled && !loading
              ? 'border-app-brand-600 bg-app-brand-800 text-white hover:bg-white hover:text-app-brand-700'
              : 'border-gray-300 bg-gray-300 text-gray-500 cursor-not-allowed'
          } ${loading ? 'blink-bg' : ''}`}
        >
          <span className={`${loading ? 'blink-text' : ''} font-medium`}>
            {loading ? 'Generating...' : 'Generate Test Cases'}
          </span>
        </button>
        <div className="space-x-3">
          <div className="flex items-center space-x-3">
            <button
              onClick={handleUseForTestData}
              data-audit-name="Use for Test Data"
              disabled={!response}
              className={`px-4 py-2 rounded-md border-2 transition-colors ${
                response
                  ? 'border-app-brand-600 bg-white text-app-brand-700 hover:bg-red-600 hover:text-white'
                  : 'border-gray-300 bg-gray-100 text-gray-400 cursor-not-allowed'
              }`}
            >
              Use for Test Data
            </button>

            <button
              onClick={exportToExcel}
              data-audit-name="Export to Excel"
              disabled={!response}
              className={`px-4 py-2 rounded-md border-2 transition-colors ${
                response
                  ? 'border-app-brand-600 bg-app-brand-800 text-white hover:bg-white hover:text-app-brand-700'
                  : 'border-gray-300 bg-gray-300 text-gray-400 cursor-not-allowed'
              }`}
            >
              Export to Excel
            </button>

            <ResetButton data-audit-name="Reset Visual Test Cases" 
              onClick={handleResetAll} 
              disabled={loading} />
          </div>
        </div>
      </div>

      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <MarkdownViewer 
          content={response || output || 'Generation output will appear here....'} 
          className="min-h-[200px]"
        />
      </div>
    </div>
  )
}

export default Visual
