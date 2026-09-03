import React, { useState, useEffect } from 'react'
import { getConfig } from '../../config/ai-api'
import MarkdownViewer from '../../components/MarkdownViewer'
import ResetButton from '../../components/ResetButton'
import { getTimestampedFilename } from '../../utils/DynamicFileName-DateTime'
import { buildDetailedFieldAudit } from '../../utils/auditDetailsHelper'
import useAuth from '../../hooks/useAuth'
import { logApiEvent } from '../../utils/auditApiHelper'
import { trackedFetchWithTokens, getAiAuthToken } from '../../utils/trackedFetchWithTokens'
import userService from '../../services/userService'
import RequestTrackerAPI from '../../utils/requestTrackerAPI'
import { extractTokenCounts } from '../../utils/streamingFetchHelper'
import { useAIAction } from '../../hooks/useAIAction'


const Unit: React.FC = () => {
  const cfg = getConfig()
  const [repoPath, setRepoPath] = useState<string>('')
  const [headOffset, setHeadOffset] = useState<number>(1)
  const [loading, setLoading] = useState<boolean>(false)
  const [response, setResponse] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const  userAuth  = useAuth()
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
        console.error('[Unit] Failed to fetch token info:', err)
      } finally {
        setTokenCheckLoading(false)
      }
    }

    fetchTokenInfo()
  }, [userAuth.user?.username])

  
  const handleGenerate = async () => {
    if (!repoPath || loading) return;
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
      actionName: 'generate_unit_tests',
      actionLabel: 'Generating Unit Test Suggestions',
      artifactType: 'Unit Test Suggestions',
      stages: [
        'Reading repository inputs',
        'Understanding code structure and test scope',
        'Identifying candidate units and edge cases',
        'Generating unit test suggestions',
        'Preparing generated artifacts'
      ],
      successMessage: 'Unit Test suggestions generated successfully.',
      retryAction: handleGenerate,
      execute: async () => {
        setLoading(true);
        setResponse('');
        setError(null);

        const requestPayload = {
          repository: repoPath,
          head_offset: headOffset,
          provider: String(cfg.PARAMETERS.provider ?? ''),
          temperature: String(cfg.PARAMETERS.temperature ?? 0),
          model: String(cfg.PARAMETERS.model ?? ''),
          endpoint: cfg.ENDPOINTS.codeGenerateUnitTest
        };

        let auditStatus: 'success' | 'failure' = 'success';
        let responsePayload: any = null;

        try {
          const form = new FormData();
          form.append('repo_path', repoPath);
          form.append('provider', String(cfg.PARAMETERS.provider ?? ''));
          form.append('model_name', String(cfg.PARAMETERS.model ?? ''));
          form.append('temperature', String(cfg.PARAMETERS.temperature ?? 0));
          form.append('head_offset', String(headOffset));
          form.append('response_format', 'text');

          const startedAt = Date.now();
          const { response: res, status, logId } = await trackedFetchWithTokens(
            `${cfg.BASE_URL}${cfg.ENDPOINTS.codeGenerateUnitTest}`,
            {
              tab: 'unit',
              method: 'POST',
              body: form,
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
              fullText += chunk.replace(/^data: /, '');
              setResponse(prev => prev + chunk)
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
            console.error('[Unit] Failed to update request log:', logErr);
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
          responsePayload = { generatedText: fullText };
          return fullText;

        } catch (err: any) {
          auditStatus = 'failure';
          const errorMsg = err?.message ?? 'Failed to generate unit tests';
          setError(errorMsg);
          responsePayload = { error: errorMsg };
          throw err;

        } finally {
          setLoading(false);

          try {
            await logApiEvent({
              user: userAuth.user,
              module: 'Unit Tests',
              action: 'Generate Unit Tests',
              resourceType: 'API',
              resourceId: 'generateUnitTest',
              resourceName: 'Generate Unit Tests',
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

  const changeExtension = (filename: string, newExt: string) => {
    return filename.replace(/\.[^/.]+$/, newExt);
  };

  const getGenerateButtonLabel = () => {
    if (loading) {
      return 'Generating...';
    } else {
      return 'Generate Unit Tests';
    }
  };
  
  const handleExport = async () => {
    if (!response) return
    
    let auditStatus: 'success' | 'failure' = 'success'
    const requestPayload = {
      test_cases_text: response
    }
    let responsePayload: any = null

    try{
      const form = new FormData()
      form.append('test_cases_text', response)
      const res = await fetch(`${cfg.BASE_URL}${cfg.ENDPOINTS.exportText}`, {
          method: 'POST',
          body: form,
          headers: (() => {
            const token = getAiAuthToken()
            return token ? { 'Authorization': `Bearer ${token}` } : undefined
          })()
        })

      // if (!res.ok) {
      //   const txt = await res.text().catch(() => '')
      //   throw new Error(`Server ${res.status} ${txt}`)
      // }
      // // const blob = await res.blob() 

      const blob = new Blob([response], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      let fileName = getTimestampedFilename('unit-tests') // e.g. unit-tests-<ts>.txt
      const updatedFileName = changeExtension(fileName, ".txt");
      console.log('Exporting file with name:', updatedFileName);  
      a.download = updatedFileName
      a.click()
      URL.revokeObjectURL(url)
      responsePayload = { exportedFileName: a.download }
    }catch(err){
      console.error('Export error:', err)
    } finally {
      // Single audit log with request and response
      try {
        // single audit log capturing request and response
        await logApiEvent({
          user: userAuth.user,
          module: 'Unit Tests',
          action: 'Export to Text',
          resourceType: 'API',
          resourceId: 'exportText',
          resourceName: 'Export to Text',
          request: requestPayload,
          response: responsePayload,
          status: auditStatus
        })
      } catch (auditErr) {
        console.error('Failed to log audit event:', auditErr)
      }
    }
  }

  const handleReset = () => {
    setRepoPath('')
    setHeadOffset(1)
    setResponse('')
    setError(null)
    setLoading(false)
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
              onClick={handleGenerate}
              data-audit-name="Generate Unit Tests"
              disabled={!repoPath || loading}
              className={`px-4 py-2 rounded-md border-2 transition-colors ${
                !repoPath || loading
                  ? 'border-gray-300 bg-gray-300 text-gray-500 cursor-not-allowed'
                  : 'border-app-brand-600 bg-app-brand-800 text-white hover:bg-app-brand-600'
              }`}
            >
              {/* {loading ? 'Generating...' : 'Generate Unit Tests'} */}
              <span className={`${loading ? 'blink-text' : ''} font-medium`}>{getGenerateButtonLabel()}</span>            
            </button>
          </div>

          <div className="flex items-center space-x-3">
            <button
              onClick={handleExport}
              disabled={!response}
              data-audit-name="Export to Text"
              className={`px-4 py-2 rounded-md border-2 transition-colors ${
                response
                  ? 'border-app-brand-600 bg-app-brand-800 text-white hover:bg-white hover:text-app-brand-700'
                  : 'border-gray-300 bg-gray-300 text-gray-500 cursor-not-allowed'
              }`}
            >
              Export to Text
            </button>

            <ResetButton data-audit-name="Reset Unit Tests" 
            onClick={handleReset} 
            disabled={loading} />
          </div>
        </div>
      </div>

      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <div className="text-sm text-gray-500 mb-2">Output</div>
        <MarkdownViewer content={response || 'Generation output will appear here....'} className="min-h-[200px]" />
      </div>

      {error && <div className="text-sm text-app-brand-800 bg-app-brand-50 p-2 rounded">{error}</div>}
    </div>
  )
}

export default Unit
