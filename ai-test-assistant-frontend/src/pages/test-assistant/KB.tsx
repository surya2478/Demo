import React, { useState, useEffect, useRef, useMemo } from 'react'
import { getConfig } from '../../config/ai-api'
import MarkdownViewer from '../../components/MarkdownViewer'
import { getTimestampedFilename } from '../../utils/DynamicFileName-DateTime'
import { buildDetailedFieldAudit , getFieldLabel, buildSessionInfo, buildEnvironmentInfo } from '../../utils/auditDetailsHelper'
import useAuth from '../../hooks/useAuth'
import auditService from '../../services/auditService'
import { formatToDubaiTime } from '../../utils/formatToDubaiTime'
import ResetButton from '../../components/ResetButton' // new import
import { logApiEvent } from '../../utils/auditApiHelper'
import ChatWindow from '../../components/ChatWindow'
import { trackedFetchWithTokens, authHeaderFor } from '../../utils/trackedFetchWithTokens'
import userService from '../../services/userService'
import RequestTrackerAPI from '../../utils/requestTrackerAPI'
import { extractTokenCounts } from '../../utils/streamingFetchHelper'
import { useAIAction } from '../../hooks/useAIAction'


const KB: React.FC = () => {
  const cfg = getConfig()
  const [zipFile, setZipFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [query, setQuery] = useState('')
  const [endpointGenerate, setEndpointGenerate] = useState(cfg.ENDPOINTS.kbGenerate || '/kb/generate' )
  const [endpointUpload, setEndpointUpload] = useState(cfg.ENDPOINTS.kbUploadZip || '/kb/upload-zip')
  
  const [asking, setAsking] = useState(false)
  const [response, setResponse] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputTimersRef = useRef<Record<string, number>>({});
  const previousValuesRef = useRef<Record<string, string>>({});
  const focusedFieldRef = useRef<string | null>(null);
  const fieldValuesRef = useRef<Record<string, string>>({});
  const userAuth = useAuth();
  
  // Chat state
  type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string; timestamp: string }
  const [isChatOpen, setIsChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatResponse, setChatResponse] = useState('')
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

  // const brdContent = [combinedContent, response].filter(s => s && s.trim().length > 0).join('\n\n---\n\n')


  // Update last message in real-time
  const handleUpdateLastMessage = (content: string) => {
    setChatMessages(prev => {
      if (prev.length === 0) return prev;
      const updated = [...prev];
      updated[updated.length - 1] = {
        ...updated[updated.length - 1],
        content
      };
      return updated;
    });
  };

  // Capture chat response when stream completes
  const handleChatResponse = (content: string) => {
    setChatResponse(content);
    // Append to response with separator
    setResponse(prev => {
      if (!prev) return content;
      return `${prev}\n\n---\n\n${content}`;
    });
  };

  // Add messages to chat
  const handleAddChatMessage = (role: 'user' | 'assistant', content: string) => {
    setChatMessages(prev => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random()}`,
        role,
        content,
        timestamp: new Date().toISOString()
      }
    ]);
  };

  const currentTabName = useMemo(() => {
      const pathname = location?.pathname || '';
      if (!pathname || typeof pathname !== 'string') return null;
      const pathParts = pathname.split('/');
      return pathParts[pathParts.length - 1] || null;
    }, [location.pathname]);

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
        console.error('[KB] Failed to fetch token info:', err)
      } finally {
        setTokenCheckLoading(false)
      }
    }

    fetchTokenInfo()
  }, [userAuth.user?.username, currentTabName])
    

  const handleZipChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null
    setZipFile(f)
  }

  const handleUpload = async () => {
    if (!zipFile) return
    await runAIAction({
      actionName: 'process_knowledge_base_upload',
      actionLabel: 'Processing Knowledge Base Content',
      artifactType: 'Knowledge Base Content',
      stages: [
        'Reading uploaded archive',
        'Validating document package',
        'Processing knowledge base content',
        'Preparing searchable content',
        'Finalizing upload'
      ],
      successMessage: 'Knowledge Base content processed successfully.',
      retryAction: handleUpload,
      execute: async () => {
        setError(null)
        setUploading(true)

        let responsePayload: any = null
        let auditStatus: 'success' | 'failure' = 'success'

        const requestPayload = {
          filename: zipFile.name,
          size: zipFile.size,
          type: zipFile.type,
          endpoint: endpointUpload
        }
        
        try {
          const formData = new FormData()
          formData.append('file', zipFile)

          // The destination picks the credential, not "whichever token exists".
          // cfg.BASE_URL is a runtime setting: it names the external AI service
          // in the deployed environment and this admin backend once the
          // generation endpoints are migrated. The AI key is right for the
          // former and is not a JWT, so it 401s against the latter --
          // authHeaderFor decides per URL and keeps sending the AI key while
          // BASE_URL still points off-host.
          const uploadUrl = `${cfg.BASE_URL}${cfg.ENDPOINTS.kbUploadZip}`
          const res = await fetch(uploadUrl, {
            method: 'POST',
            body: formData,
            headers: authHeaderFor(uploadUrl)
          })

          if (!res.ok) {
            const t = await res.text().catch(() => '')
            throw new Error(`Upload failed: ${res.status} ${t}`)
          }

          setResponse('Upload successful.')

          responsePayload = {
            status: res.status,
            statusText: res.statusText
          }
          return responsePayload
            
        } catch (err: any) {
          console.error(err)
          setError(err?.message ?? 'Upload failed') 
          auditStatus = 'failure'
          throw err
        } finally {
          setUploading(false)
          // single audit log capturing request and response
          await logApiEvent({
            user: userAuth.user,
            module: 'Knowledge Base',
            action: 'Upload Zip File',
            resourceType: 'API',
            resourceId: 'uploadZipFile',
            resourceName: 'Upload Zip File',
            request: requestPayload,
            response: responsePayload,
            status: auditStatus
          })
        }
      }
    })
  }

  const handleAsk = async () => {
    if (!query.trim() || asking) return;
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
      actionName: 'generate_knowledge_base_summary',
      actionLabel: 'Processing Knowledge Base Content',
      artifactType: 'Knowledge Base Summary',
      stages: [
        'Reading knowledge base query',
        'Retrieving relevant context',
        'Processing knowledge base content',
        'Creating AI recommendation',
        'Preparing generated response'
      ],
      successMessage: 'Knowledge Base Summary generated successfully.',
      retryAction: handleAsk,
      execute: async () => {
        setAsking(true);
        setError(null);
        setResponse('');

        const requestPayload = {
          query,
          provider: String(cfg.PARAMETERS.provider ?? ''),
          temperature: String(cfg.PARAMETERS.temperature ?? 0),
          model: String(cfg.PARAMETERS.model ?? ''),
          endpoint: endpointGenerate
        };

        let auditStatus: 'success' | 'failure' = 'success';
        let responsePayload: any = null;

        try {
          const formData = new FormData();
          formData.append('query', query);
          formData.append('provider', String(cfg.PARAMETERS.provider ?? ''));
          formData.append('model_name', String(cfg.PARAMETERS.model ?? ''));
          formData.append('temperature', String(cfg.PARAMETERS.temperature ?? 0));
          formData.append('response_format', 'text');

          const startedAt = Date.now();
          const { response: res, status, logId } = await trackedFetchWithTokens(
            `${cfg.BASE_URL}${endpointGenerate}`,
            {
              tab: 'kb',
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
              fullText += decoder.decode(value, { stream: true });
              setResponse(prev => prev + chunk)
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
            console.error('[KB] Failed to update request log:', logErr);
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
          handleAddChatMessage('assistant', fullText);
          return fullText;

        } catch (err: any) {
          auditStatus = 'failure';
          const errorMsg = err?.message ?? 'Failed to query knowledge base';
          setError(errorMsg);
          responsePayload = { error: errorMsg };
          throw err;

        } finally {
          setAsking(false);

          try {
            await logApiEvent({
              user: userAuth.user,
              module: 'Knowledge Base',
              action: 'Query KB',
              resourceType: 'API',
              resourceId: 'kbQuery',
              resourceName: 'Knowledge Base Query',
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

  const handleExport = async () => {
    if (!response) return

    setError(null)
    let auditStatus: 'success' | 'failure' = 'success'
    let responsePayload: any = null
    let requestPayload: any = null

    try {
      
      const form = new FormData()
      form.append('test_cases_text', response)

      const token = localStorage.getItem('authToken') || sessionStorage.getItem('authToken') || ''
      const headers: Record<string, string> = {}
      if (token) headers['Authorization'] = `Bearer ${token}`

      requestPayload = {
        test_cases_text_size: response.length,
        endpoint: cfg.ENDPOINTS.exportExcel,
        test_cases_text: response
      }
      const exportUrl = `${cfg.BASE_URL}${cfg.ENDPOINTS.exportExcel}`
      const res = await fetch(exportUrl, {
        method: 'POST',
        body: form,
        // credentials: 'include',
        headers: { accept: 'application/json', ...authHeaderFor(exportUrl) },
      })

      if (!res.ok) {
        const t = await res.text().catch(() => '')
        throw new Error(`Export failed: ${res.status} ${t}`)
      }

      const blob = await res.blob()
      if (blob.size === 0) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = getTimestampedFilename('kb-export')
      a.click()
      URL.revokeObjectURL(url)

      responsePayload = {
        status: res.status,
        statusText: res.statusText,
        blobSize: blob.size
      } 
      
    } catch (err) {
      console.error(err)
      setError('Export failed')     
    }finally {
       // Single audit log with request and response
      try {
        // single audit log capturing request and response
        await logApiEvent({
          user: userAuth.user,
          module: 'Knowledge Base',
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

  // Reset handler
  const handleReset = async () => {
    // capture previous values
    const prev = {
      zipFile: zipFile ? { name: zipFile.name, size: zipFile.size, type: zipFile.type } : null,
      query,
      endpointGenerate,
      response,
      error
    }

    // reset the UI
    setZipFile(null)
    setQuery('')
    setEndpointGenerate('/kb/generate')
    setResponse('')
    setError(null)

    // // prepare audit details
    // const details = buildDetailedFieldAudit(
    //   userAuth.user,
    //   'reset',
    //   'Knowledge Base',
    //   JSON.stringify({
    //     zipFile: null,
    //     query: '',
    //     endpoint: '/kb/generate',
    //     response: '',
    //     error: null
    //   }),
    //   JSON.stringify(prev),
    //   'Knowledge Base'
    // )
  
  }

  return (
    <div ref={containerRef} className="space-y-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold mb-2">Upload Documents to Knowledge Base</h2>
          <p className="text-sm text-gray-600 mb-4">
            Upload a ZIP file containing documents to expand the knowledge base.
          </p>
        </div>

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
      </div>

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
        <label className="block text-sm font-medium text-gray-700 mb-2">Upload ZIP File</label>

        <div className="mb-4">
          <input
            id="kb-zip-upload"
            data-audit-name="Upload ZIP File"
            type="file"
            accept=".zip"
            onChange={handleZipChange}
            className="block w-full text-sm text-gray-700 file:border-0 file:bg-red-600 file:text-white file:py-2 file:px-3 rounded-md"
          />
          {zipFile && <div className="text-xs text-gray-500 mt-2">Selected: {zipFile.name}</div>}
        </div>

        <div className="mb-6">
          <button
            onClick={handleUpload}
            data-audit-name="Upload to Knowledge Base"
            disabled={!zipFile || uploading}
            className={`px-4 py-2 rounded-md border-2 transition-colors ${
              !zipFile || uploading
                ? 'border-gray-300 bg-gray-200 text-gray-500 cursor-not-allowed'
                : 'border-app-brand-600 bg-app-brand-800 text-white hover:bg-app-brand-600'
            }`}
          >
            {uploading ? 'Uploading...' : 'Upload to Knowledge Base'}
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end">
          {/* Query Input - Takes 4 columns on large screens */}
          <div className="lg:col-span-4">
            <label data-audit-name="Knowledge Base Query" className="block text-sm font-medium text-gray-700 mb-1">Query</label>
            <input
              type="text"
              data-audit-name="Knowledge Base Query"
              placeholder="Enter your Query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full p-2 border rounded hover:border-app-brand-600 focus:border-app-brand-600 focus:ring-1 focus:ring-red-100 outline-none transition"
            />
          </div>

          {/* Query Endpoint - Takes 4 columns on large screens */}
          <div className="lg:col-span-4">
            <label data-audit-name="Knowledge Base Query Endpoint" className="block text-sm font-medium text-gray-700 mb-1">Query Endpoint</label>
            <select
              value={endpointGenerate}
              data-audit-name="Knowledge Base Query Endpoint"
              onChange={(e) => setEndpointGenerate(e.target.value)}
              className="w-full p-2 border rounded hover:border-app-brand-600 focus:border-app-brand-600 focus:ring-1 focus:ring-red-100 outline-none transition"
            >
              <option value="/kb/generate">Knowledge Base (/kb/generate)</option>
            </select>
          </div>

          {/* Action Buttons - Takes 4 columns on large screens, right-aligned */}
          <div className="lg:col-span-4 flex items-center justify-end gap-2">
            <button
              onClick={handleAsk}
              data-audit-name="Ask"
              disabled={!query || asking}
              className={`min-w-[130px] px-4 py-2 rounded-md border-2 transition-colors flex items-center justify-center ${asking ? 'blink-bg' : ''} ${
                query && !asking
                  ? 'border-app-brand-600 bg-app-brand-800 text-white hover:bg-white hover:text-app-brand-700'
                  : 'border-gray-300 bg-gray-300 text-gray-500 cursor-not-allowed'
              }`}
            >
              <span className={`${asking ? 'blink-text' : ''} font-medium`}>{asking ? 'Generating...' : 'Ask'}</span>
            </button>

            <button
              onClick={handleExport}
              data-audit-name="Export to Excel"
              disabled={!response}
              className={`min-w-[140px] px-4 py-2 rounded-md border-2 transition-colors ${
                response
                  ? 'border-app-brand-600 bg-app-brand-800 text-white hover:bg-white hover:text-app-brand-700'
                  : 'border-gray-300 bg-gray-200 text-gray-500 cursor-not-allowed'
              }`}
            >
              Export to Excel
            </button>

            <ResetButton
              onClick={handleReset}
              data-audit-name="Reset Knowledge Base"
              disabled={uploading || asking}
            />
          </div>
        </div>
      </div>

      {error && <div className="text-sm text-app-brand-800 bg-app-brand-50 p-2 rounded">{error}</div>}

      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <div className="text-sm text-gray-500 mb-2">Output</div>
        <MarkdownViewer content={response || 'No response yet.'} className="min-h-[200px]" />
      </div>
      <ChatWindow
        isOpen={isChatOpen}
        onToggle={() => setIsChatOpen(!isChatOpen)}
        messages={chatMessages}
        onAddMessage={handleAddChatMessage}
        onUpdateLastMessage={handleUpdateLastMessage}
        onChatResponse={handleChatResponse}
        currentTab={'Knowledge Base'}
        userName={userAuth.user?.username || 'User'}
        seedContent={response}
      />
    </div>
  )
}

export default KB
