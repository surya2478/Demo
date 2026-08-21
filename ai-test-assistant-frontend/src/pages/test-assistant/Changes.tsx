import React, { useState, useEffect } from 'react'
import { getConfig } from '../../config/ai-api'
import MarkdownViewer from '../../components/MarkdownViewer'
import { getTimestampedFilename } from '../../utils/DynamicFileName-DateTime'
import { buildDetailedFieldAudit } from '../../utils/auditDetailsHelper'
import useAuth from '../../hooks/useAuth'
import auditService from '../../services/auditService'
import ResetButton from '../../components/ResetButton'
import { logApiEvent } from '../../utils/auditApiHelper'
import { trackedFetchWithTokens } from '../../utils/trackedFetchWithTokens'
import userService from '../../services/userService'
import RequestTrackerAPI from '../../utils/requestTrackerAPI'
import { extractTokenCounts } from '../../utils/streamingFetchHelper'
import { useAIAction } from '../../hooks/useAIAction'


const Changes: React.FC = () => {
  const cfg = getConfig()
  const [repoPath, setRepoPath] = useState('')
  const [headOffset, setHeadOffset] = useState<number>(1)
  const [embedProvider, setEmbedProvider] = useState<string>(cfg.PARAMETERS.provider ?? '')
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState('')
  const [error, setError] = useState<string | null>(null)
  const authUser = useAuth()
  const [userTokenAllocation, setUserTokenAllocation] = useState<number>(0)
  const [userTokensUsed, setUserTokensUsed] = useState<number>(0)
  const [tokenCheckLoading, setTokenCheckLoading] = useState<boolean>(false)
  const [showTokenWarning, setShowTokenWarning] = useState<boolean>(false)
  const [tokenWarningMessage, setTokenWarningMessage] = useState<string>('')
  const { runAIAction } = useAIAction()
  const isAdminUser = (() => {
    const role = String((authUser.user as any)?.role || '').toLowerCase()
    const roles = (authUser.user as any)?.roles
    return role === 'admin' || (Array.isArray(roles) && roles.some((r: any) => String(r).toLowerCase() === 'admin'))
  })()
  
  const defaults = {
    repoPath: '',
    headOffset: 1,
    embedProvider: cfg.PARAMETERS.provider ?? ''
  }

  useEffect(() => {
    const fetchTokenInfo = async () => {
      if (!authUser.user?.username) return

      setTokenCheckLoading(true)
      try {
        // For non-admin users: Fetch allocation; For admin users: Only fetch usage
        if (!isAdminUser) {
          const userData = await userService.get(authUser.user.username)
          const allocation = (userData as any).token_allocation || 10000
          setUserTokenAllocation(allocation)
        } else {
          // Admin users: no allocation limit
          setUserTokenAllocation(0)
        }

        const logsData = await RequestTrackerAPI.getLogs({
          user: authUser.user.username,
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
        console.error('[Changes] Failed to fetch token info:', err)
      } finally {
        setTokenCheckLoading(false)
      }
    }

    fetchTokenInfo()
  }, [authUser.user?.username])

  const handleReset = async () => {
    const noChange =
      repoPath === defaults.repoPath &&
      headOffset === defaults.headOffset &&
      embedProvider === defaults.embedProvider &&
      response === '' &&
      error === null

    if (noChange) return

    const prev = {
      repoPath,
      headOffset,
      embedProvider,
      response,
      error
    }

    setRepoPath(defaults.repoPath)
    setHeadOffset(defaults.headOffset)
    setEmbedProvider(defaults.embedProvider)
    setResponse('')
    setError(null)
  }

  const handleCheckChanges = async () => {
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
      actionName: 'change_impact_analysis',
      actionLabel: 'Preparing Change Impact Analysis',
      artifactType: 'Change Impact Analysis',
      stages: [
        'Reading change details',
        'Identifying affected systems and components',
        'Mapping impacted requirements and test cases',
        'Recommending regression scope',
        'Preparing impact assessment'
      ],
      successMessage: 'Change Impact Analysis is ready.',
      retryAction: handleCheckChanges,
      execute: async () => {
        setError(null);
        setResponse('');
        setLoading(true);

        const requestPayload = {
          repository: repoPath,
          headOffset: headOffset
        };

        let responsePayload: any = null;
        let auditStatus: 'success' | 'failure' = 'success';

        try {
          const formData = new FormData();
          formData.append('repo_path', repoPath);
          formData.append('head_offset', String(headOffset));
          formData.append('list_only', '');

          const startedAt = Date.now();
          const { response: res, status, logId } = await trackedFetchWithTokens(
            `${cfg.BASE_URL}${cfg.ENDPOINTS.codeChanges}`,
            {
              tab: 'changes',
              method: 'POST',
              body: formData,
              user: authUser.user?.username || 'anonymous',
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
              fullText += chunk.replace(/^data: /, '');
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
            console.error('[Changes] Failed to update request log:', logErr);
          }

          if (!res.ok) {
            throw new Error(`HTTP ${status}: ${fullText}`);
          }

          setResponse(fullText);
          const tokensUsedInResponse = tokenInfo?.totalTokens ?? 0;
          if (tokensUsedInResponse > 0) {
            const newTotal = userTokensUsed + tokensUsedInResponse;
            setUserTokensUsed(prev => prev + tokensUsedInResponse);
            if (!isAdminUser && userTokenAllocation > 0 && newTotal >= userTokenAllocation) {
              setShowTokenWarning(true);
              setTokenWarningMessage('You have reached your token allocation limit. This was your last request.');
            }
          }
          responsePayload = fullText;
          return fullText;

        } catch (err: any) {
          auditStatus = 'failure';
          const errorMsg = err?.message ?? 'Failed to check changes';
          setError(errorMsg);
          responsePayload = { error: errorMsg };
          throw err;

        } finally {
          setLoading(false);

          try {
            await logApiEvent({
              user: authUser.user,
              module: 'Changes',
              action: 'Check Changes',
              resourceType: 'API',
              resourceId: 'codeChanges',
              resourceName: 'Check Code Changes',
              request: requestPayload,
              response: responsePayload,
              status: auditStatus
            });
          } catch (auditErr) {
            console.error('Failed to log audit event:', auditErr);
          }
        }
      }
    });
  }

  const handleGenerateTestCases = async () => {
    if (!repoPath) return
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
      actionName: 'generate_change_test_cases',
      actionLabel: 'Generating Test Cases',
      artifactType: 'Test Cases',
      stages: [
        'Reading change details',
        'Identifying affected systems and components',
        'Mapping impacted requirements and test cases',
        'Generating test cases',
        'Preparing generated artifacts'
      ],
      successMessage: 'Test Cases generated successfully.',
      retryAction: handleGenerateTestCases,
      execute: async () => {
        setError(null)
        setResponse('')
        setLoading(true)
        
        const requestPayload = {
          repo_path: repoPath,
          provider: cfg.PARAMETERS.provider,
          embed_provider: cfg.PARAMETERS.embed_provider,
          model_name: cfg.PARAMETERS.model,
          temperature: cfg.PARAMETERS.temperature,
          head_offset: headOffset
        }
        let responsePayload: any = null
        let auditStatus: 'success' | 'failure' = 'success'
        let errorMessage: string | null = null
        let generatedContent = ''
        
        const requestStartTime = Date.now();
        let requestLogId = '';
        let responseStatus = 200;

        try {
      // requestLogId = await createManualRequestLog({
      //   tab: 'changes',
      //   method: 'POST',
      //   url: `${cfg.BASE_URL}${cfg.ENDPOINTS.codeGenerateTestCase}`,
      //   endpoint: cfg.ENDPOINTS.codeGenerateTestCase,
      //   requestPayload: requestPayload,
      //   user: getCurrentUser(),
      //   sessionId: getSessionId()
      // });

      const form = new FormData()
      form.append('repo_path', repoPath)
      form.append('provider', cfg.PARAMETERS.provider ?? '')
      form.append('embed_provider', cfg.PARAMETERS.embed_provider ?? '')
      form.append('model_name', String(cfg.PARAMETERS.model))
      form.append('temperature', String(cfg.PARAMETERS.temperature))
      form.append('head_offset', String(headOffset))
      form.append('response_format', 'text')
      
      
      const res = await fetch(`${cfg.BASE_URL}${cfg.ENDPOINTS.codeGenerateTestCase}`, {
        method: 'POST',
        body: form,
        credentials: 'include'
      })
      
      responseStatus = res.status;
      
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        throw new Error(`Server ${res.status} ${t}`)
      }

      // stream reading if available
      if (res.body && (res.body as any).getReader) {
        const reader = (res.body as any).getReader()
        const decoder = new TextDecoder()
        let done = false
        while (!done) {
          const { done: d, value } = await reader.read()
          if (d) { done = true; break }
          const chunk = decoder.decode(value)
          generatedContent += chunk
          setResponse(prev => prev + chunk)
        }
      } else {
        const text = await res.text()
        generatedContent = text
        setResponse(text)
      }

      const tokenInfo = extractTokenCounts(generatedContent)
      const tokensUsedInResponse = tokenInfo?.totalTokens ?? 0
      if (tokensUsedInResponse > 0) {
        const newTotal = userTokensUsed + tokensUsedInResponse
        setUserTokensUsed(prev => prev + tokensUsedInResponse)
        if (!isAdminUser && userTokenAllocation > 0 && newTotal >= userTokenAllocation) {
          setShowTokenWarning(true)
          setTokenWarningMessage('You have reached your token allocation limit. This was your last request.')
        }
      }

      responsePayload = { 
        test_cases: generatedContent,
        length: generatedContent.length 
      }
      
      // Update request log with response
      // if (requestLogId) {
      //   await updateManualRequestLog(requestLogId, {
      //     responseStatus,
      //     responseData: generatedContent,
      //     duration: Date.now() - requestStartTime
      //   });
      // }

        } catch (err: any) {
          auditStatus = 'failure'
          errorMessage = err?.message ?? 'Failed to generate test cases'
          setError(errorMessage)
          responsePayload = String(errorMessage)
          throw err
      
      // // Update request log with error
      // if (requestLogId) {
      //   await updateManualRequestLog(requestLogId, {
      //     responseStatus: responseStatus || 500,
      //     responseData: String(err),
      //     duration: Date.now() - requestStartTime,
      //     error: String(err)
      //   });
      // }

        } finally {
          setLoading(false)
          
          try {
            // single audit log capturing request and response
            await logApiEvent({
              user: authUser.user,
              module: 'Changes',
              action: 'Generate Test Cases',
              resourceType: 'API',
              resourceId: 'generateTestCases',
              resourceName: 'Generate Test Cases',
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

  const getGenerateButtonLabel = () => {
    if (loading) {
      return 'Generating...';
    } else {
      return 'Generate Test Cases';
    }
  }; 

  const handleExport = async () => {
    if (!response) return
    
    const requestPayload = {
      test_cases_text: response,
      length: response.length
    }
    let responsePayload: any = null
    let auditStatus: 'success' | 'failure' = 'success'
    let errorMessage: string | null = null

    try {
      const form = new FormData()
      form.append('test_cases_text', response)
      const res = await fetch(`${cfg.BASE_URL}${cfg.ENDPOINTS.exportExcel}`, {
        method: 'POST',
        body: form,
        credentials: 'include'
      })
      if (!res.ok) throw new Error(`Server ${res.status}`)
      const blob = await res.blob()
      if (blob.size === 0) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = getTimestampedFilename('changes-test-cases')
      a.click()
      URL.revokeObjectURL(url)

      responsePayload = {
        filename: a.download,
        fileSize: blob.size,
        message: 'Export successful'
      }

    } catch (err: any) {
      auditStatus = 'failure'
      errorMessage = err?.message ?? 'Failed to export to Excel'
      responsePayload = String(errorMessage) 
      console.error(err)
    } finally {
      // Single audit log with request and response
      try {

        // single audit log capturing request and response
        await logApiEvent({
          user: authUser.user,
          module: 'Changes',
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

  return (
    <div className="mx-auto max-w-[1600px] space-y-6">
      {!tokenCheckLoading && (
        <div className="flex items-start justify-end">
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

      {showTokenWarning && (
        <div
          className={`p-4 rounded-lg border-l-4 ${
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

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Repository Path</label>
            <input
              type="text"
              data-audit-name="Repository Path"
              placeholder="Enter repository path"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              className="w-full p-2 border rounded hover:border-app-brand-600 focus:border-app-brand-600 focus:ring-1 focus:ring-red-100 outline-none transition"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Head Offset</label>
            <input
              type="number"
              data-audit-name="Head Offset"
              min={0}
              value={headOffset}
              onChange={(e) => setHeadOffset(Number(e.target.value))}
              className="w-full p-2 border rounded hover:border-app-brand-600 focus:border-app-brand-600 focus:ring-1 focus:ring-red-100 outline-none transition"
            />
          </div>

          
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <button
              onClick={handleCheckChanges}
              data-audit-name="Check Changes"
              disabled={loading}
              className="px-4 py-2 rounded-md border border-app-brand-600 bg-white text-app-brand-700 hover:bg-red-600 hover:text-white transition"
            >
              {loading ? 'Checking...' : 'Check Changes'}
            </button>

            <button
              onClick={handleGenerateTestCases}
              data-audit-name="Generate Test Cases"
              disabled={!repoPath || loading}
              className={`px-4 py-2 rounded-md border border-app-brand-600 text-white ${loading ? 'bg-app-brand-500' : 'bg-red-600 hover:bg-app-brand-600'} transition`}
            >
              {/* {loading ? 'Generating...' : 'Generate Test Cases'} */}
              <span className={`${loading ? 'blink-text' : ''} font-medium`}>{getGenerateButtonLabel()}</span>            
            </button>
           </div>
 
           <div>
             <button
               onClick={handleExport}
               data-audit-name="Export to Excel"
               disabled={!response}
               className={`px-4 py-2 rounded-md border-2 ${response ? 'border-app-brand-600 bg-app-brand-800 text-white hover:bg-white hover:text-app-brand-700' : 'border-gray-300 bg-gray-200 text-gray-500 cursor-not-allowed'} transition`}
             >
               Export to Excel
             </button>
              <span className="ml-3">
              <ResetButton onClick={handleReset} 
              data-audit-name="Reset Changes" 
              disabled={loading} />
            </span>
           </div>
         </div>
      </div>

      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <div className="flex justify-between items-center mb-2">
          <div className="text-sm text-gray-500">Output</div>
        </div>

        <MarkdownViewer content={response || 'Generation output will appear here....'} className="min-h-[200px]" />
      </div>

      {error && <div className="text-sm text-app-brand-800 bg-app-brand-50 p-2 rounded">{error}</div>}
    </div>
  )
}

export default Changes
