import React, { useState, useEffect, ChangeEvent } from 'react'
import MarkdownViewer from '../../components/MarkdownViewer'
import { getConfig } from '../../config/ai-api'
import { getTimestampedFilename } from '../../utils/DynamicFileName-DateTime';
import * as XLSX from 'xlsx';
import ResetButton from '../../components/ResetButton'
import '../../styles/animations.css'
import { buildDetailedFieldAudit } from '../../utils/auditDetailsHelper'
import useAuth from '../../hooks/useAuth'
import auditService from '../../services/auditService';
import { logApiEvent } from '../../utils/auditApiHelper';
import { useTestDataContext } from '../../context/TestDataContext'
import { trackedFetchWithTokens } from '../../utils/trackedFetchWithTokens'
import userService from '../../services/userService'
import RequestTrackerAPI from '../../utils/requestTrackerAPI'
import { extractTokenCounts } from '../../utils/streamingFetchHelper'
import { useAIAction } from '../../hooks/useAIAction'


const DataTab: React.FC = () => {
  const [inputType, setInputType] = useState<'text' | 'file'>('text')
  const [testCases, setTestCases] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [filePreview, setFilePreview] = useState(''); // new: preview text
  const [output, setOutput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isGenerateEnabled, setIsGenerateEnabled] = useState(false)
  const authUser  = useAuth();
  const config = getConfig();
  const [userTokenAllocation, setUserTokenAllocation] = useState<number>(0)
  const [userTokensUsed, setUserTokensUsed] = useState<number>(0)
  const [tokenCheckLoading, setTokenCheckLoading] = useState<boolean>(false)
  const [showTokenWarning, setShowTokenWarning] = useState<boolean>(false)
  const [tokenWarningMessage, setTokenWarningMessage] = useState<string>('')
  // Add to component:
  const { testCasesData, clearTestCasesData } = useTestDataContext()
  const { runAIAction } = useAIAction()
  const isAdminUser = (() => {
    const role = String((authUser.user as any)?.role || '').toLowerCase()
    const roles = (authUser.user as any)?.roles
    return role === 'admin' || (Array.isArray(roles) && roles.some((r: any) => String(r).toLowerCase() === 'admin'))
  })()

  let fullText = '';

  useEffect(() => {
    // enable generate when textarea has content or a file is selected
    if (inputType === 'text') {
      setIsGenerateEnabled(testCases.trim().length > 0)
    } else {
      setIsGenerateEnabled(!!file)
    }
  }, [inputType, testCases, file])

  // Fetch user token allocation and usage
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
        console.error('[Data] Failed to fetch token info:', err)
      } finally {
        setTokenCheckLoading(false)
      }
    }

    fetchTokenInfo()
  }, [authUser.user?.username])

  // useEffect(() => {
  //   const fromUseButton = sessionStorage.getItem('fromUseForTestData')
  //   console.log('fromUseButton:', fromUseButton);
  //   if (fromUseButton === 'true') {
  //       // If there's initial data coming from sessionStorage (BRD -> Data transfer)
  //       const saved = sessionStorage.getItem('testDataInput')
  //       console.log('Saved test data input:', saved);
  //       if (saved) {
  //         setTestCases(saved)
  //         sessionStorage.removeItem('testDataInput')
  //         sessionStorage.removeItem('fromUseForTestData')
  //       }
  //   }
  // }, [])

  // Replace the existing useEffect with this:
  useEffect(() => {
    if (testCasesData) {
      console.log('Loading test cases from context:', testCasesData)
      setTestCases(testCasesData)
      // Clear after loading so it doesn't reload on normal tab navigation
      clearTestCasesData()
    }
  }, [testCasesData, clearTestCasesData])

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0] ?? null
    setFile(selectedFile)
    setFilePreview('')

    if (!selectedFile) return

    const name = selectedFile.name.toLowerCase()

    // Read text-like files for preview (txt, csv, md)
    if (name.endsWith('.txt') || name.endsWith('.csv') || name.endsWith('.md')) {
        const text = await selectedFile.text();
        setFilePreview(text);
    } // For Excel files, use the xlsx library
    else if (selectedFile.name.endsWith('.xlsx') || selectedFile.name.endsWith('.xls')) {
      const arrayBuffer = await selectedFile.arrayBuffer();
      const data = new Uint8Array(arrayBuffer as ArrayBuffer);
      const workbook = XLSX.read(data, {type: 'array'});
      
      // Get the first worksheet
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      
      // Convert to CSV format
      const csv = XLSX.utils.sheet_to_csv(worksheet);
      setFilePreview(csv);
      
    }else {
      // For binary files (xlsx, xls, etc) show placeholder preview message
      setFilePreview(`Preview not available for binary file type: ${selectedFile.name}`)
    }
  }

  const handleGenerate = async () => {
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
      actionName: 'generate_test_data',
      actionLabel: 'Generating Test Data',
      artifactType: 'Test Data',
      stages: [
        'Reviewing test case context',
        'Identifying data attributes and dependencies',
        'Generating valid and negative datasets',
        'Validating data constraints',
        'Preparing test data output'
      ],
      successMessage: 'Test Data generated successfully.',
      retryAction: handleGenerate,
      execute: async () => {
        setError(null);
        setOutput('');
        setLoading(true);

        const config = getConfig();
        const formData = new FormData();

        const requestPayload = {
          inputType,
          filename: file?.name || null,
          provider: String(config.PARAMETERS.provider ?? ''),
          temperature: String(config.PARAMETERS.temperature ?? 0),
          model: String(config.PARAMETERS.model ?? ''),
          endpoint: config.ENDPOINTS.generateTestData
        };

        let auditStatus: 'success' | 'failure' = 'success';
        let responsePayload: any = null;

        try {
          formData.append('provider', config.PARAMETERS.provider);
          formData.append('model_name', String(config.PARAMETERS.model));
          formData.append('temperature', String(config.PARAMETERS.temperature));
          formData.append('response_format', 'text');

          if (inputType === 'text') {
            formData.append('test_cases', testCases);
          } else if (inputType === 'file' && file) {
            formData.append('test_cases', filePreview);
          }

          const startedAt = Date.now();
          const { response: res, status, logId } = await trackedFetchWithTokens(
            `${config.BASE_URL}${config.ENDPOINTS.generateTestData}`,
            {
              tab: 'data',
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
              setOutput(prev => prev + chunk);
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
            console.error('[DataTab] Failed to update request log:', logErr);
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
          responsePayload = fullText;
          return fullText;

        } catch (err) {
          auditStatus = 'failure';
          const errorMsg = err instanceof Error ? err.message : String(err);
          setError(errorMsg);
          responsePayload = { error: errorMsg };
          throw err;

        } finally {
          setLoading(false);
          try {
            await logApiEvent({
              user: authUser.user,
              module: 'TestData',
              action: 'Generate Test Data',
              resourceType: 'API',
              resourceId: 'generateTestData',
              resourceName: 'Generate Test Data',
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

  async function exportToExcel() {
    const formData = new FormData();
    formData.append("test_cases_text", output);
    try{
      const res = await fetch(`${config.BASE_URL}${config.ENDPOINTS.exportExcel}`, {
        method: "POST",
        body: formData,
        headers: { 'accept': "application/json" },
      });

      const data = await res.blob();
      if (data.size === 0) return;
      const url = URL.createObjectURL(data);

      const a = document.createElement("a");
      a.href = url;
      a.download = getTimestampedFilename('test-data');
      a.click();

      URL.revokeObjectURL(url);

      // single audit log capturing request and response for Export
      await logApiEvent({
        user: authUser.user,
        module: 'Test Data',
        action: 'Export to Excel',
        resourceType: 'Test Data',
        resourceId: a.download,
        resourceName: a.download,
        request: { test_cases_text: output },
        response: { filename: a.download, size: data.size },
        status: 'success'
      })
  
    } catch (err) {
      console.error(err);
    }
  }

  const handleResetAll = () => {
    setInputType('text')
    setTestCases('')
    setFile(null)
    setFilePreview('')
    setOutput('')
    setError(null)
    setLoading(false)

    // // Audit log for reset action
    // const details = buildDetailedFieldAudit(authUser.user?.username, 'click', 'Reset All Fields', 'All fields cleared');  
    // auditService.logEvent({
    //   actor: authUser.user?.username,
    //   actor_id: authUser.user?.id ? String(authUser.user.id) : undefined,
    //   actor_role: authUser.user?.role,
    //   module: 'Test Data',
    //   action: 'Reset All',
    //   resource_type: 'Test Data',
    //   resource_id: 'TestData Reset',
    //   status: 'success',
    //   details: details,
    // })

  }

  return (
    <div className="mx-auto max-w-[1600px]">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold mb-0">Generate Test Data</h2>
          <p className="text-gray-600 text-sm">Create test data from imported test cases or pasted test cases.</p>
        </div>
        <div>
          {/* Reset moved next to Export button per request - header left empty */}
        </div>
     
        {!tokenCheckLoading && (
          <div className="flex items-center justify-between mb-4">
            <div></div>
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

      <div className="space-y-6">
        <div className="rounded-[20px] border border-app bg-app-surface p-4 shadow-app-card">
          <div className="mb-3 grid gap-2 md:grid-cols-2">
            <label className={`cursor-pointer rounded-[12px] border px-3 py-2 transition-all duration-200 ${inputType === 'text' ? 'border-app-brand-200 bg-app-brand-50/60' : 'border-app bg-white hover:border-app-brand-100 hover:bg-app-brand-50/30'}`}>
              <input
                type="radio"
                data-audit-name="Text Input"
                checked={inputType === 'text'}
                onChange={() => setInputType('text')}
                className="sr-only"
              />
              <div className="flex items-center gap-2">
                <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[8px] ${inputType === 'text' ? 'bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] text-white' : 'bg-app-surface-muted text-app-secondary'}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16 4l4 4m0 0l-9 9-4-4 9-9m4 4l-4-4M5 21h14" />
                  </svg>
                </span>
                <span className={`text-[13px] font-semibold ${inputType === 'text' ? 'text-app-brand-800' : 'text-app-primary'}`}>Text Input</span>
              </div>
            </label>
            <label className={`cursor-pointer rounded-[12px] border px-3 py-2 transition-all duration-200 ${inputType === 'file' ? 'border-app-brand-200 bg-app-brand-50/60' : 'border-app bg-white hover:border-app-brand-100 hover:bg-app-brand-50/30'}`}>
              <input
                type="radio"
                data-audit-name="File Upload"
                checked={inputType === 'file'}
                onChange={() => setInputType('file')}
                className="sr-only"
              />
              <div className="flex items-center gap-2">
                <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[8px] ${inputType === 'file' ? 'bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] text-white' : 'bg-app-surface-muted text-app-secondary'}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656L5.172 10.343a6 6 0 008.486 8.486L20.5 12" />
                  </svg>
                </span>
                <span className={`text-[13px] font-semibold ${inputType === 'file' ? 'text-app-brand-800' : 'text-app-primary'}`}>File Upload</span>
              </div>
            </label>
          </div>

          {inputType === 'text' ? (
            <>
              <label data-audit-name="Test Cases Input" className="block text-sm font-medium text-gray-700 mb-2">
                Test Cases (from Solutions or VISUAL tables)
              </label>
              <textarea
                value={testCases}
                data-audit-name="Test Cases Input"
                onChange={(e) => setTestCases(e.target.value)}
                placeholder="Enter or paste test cases here..."
                className="w-full h-40 p-3 border-2 border-gray-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-200 outline-none transition-all resize-none"
              />
            </>
          ) : (
            <>
              {/* Preview textarea shown immediately after file upload, non-editable */}
              {file && (
                <>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                File Preview
              </label>
              <textarea
                value={filePreview ?? ''}
                data-audit-name="File Preview"
                readOnly
                placeholder="File preview will appear here after upload"
                className="w-full h-40 p-3 border-2 border-gray-200 rounded-lg bg-gray-50 text-gray-700 resize-none mb-4"
              />
 </>
              )}
              <label data-audit-name="Import Test Cases" className="block text-sm font-medium text-gray-700 mb-2">
                Import Test Cases (Excel, CSV, or Markup)
              </label>
              <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
                <input
                  type="file"
                  data-audit-name="Data File Upload"
                  onChange={handleFileChange}
                  className="hidden"
                  id="data-file-upload"
                  accept=".xlsx,.xls,.csv,.txt,.md"
                />
                <label data-audit-name="Data File Upload" htmlFor="data-file-upload" className="cursor-pointer text-app-brand-700 hover:text-app-brand-800">
                  <div className="mb-2">{file ? file.name : 'Click to upload or drag and drop'}</div>
                  <div className="text-sm text-gray-500">Supported: Excel, CSV, TXT, Markdown</div>
                </label>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-between">
          {/* Left: Generate Test Data */}
          <div>
            <button
              data-audit-name="Generate Test Data"
              onClick={handleGenerate}
              disabled={!isGenerateEnabled || loading}
              className={`px-4 py-2 rounded-md border-2 transition-colors flex items-center ${loading ? 'blink-bg' : ''} ${
                isGenerateEnabled && !loading
                  ? 'border-app-brand-600 bg-app-brand-800 text-white hover:bg-white hover:text-app-brand-700'
                  : 'border-gray-300 bg-gray-300 text-gray-500 cursor-not-allowed'
              }`}
            >
              <span className={`${loading ? 'blink-text' : ''} font-medium`}>{loading ? 'Generating...' : 'Generate Test Data'}</span>
            </button>
          </div>

          {/* Right: Export to Excel and Reset */}
          <div className="flex items-center space-x-3">
            <button
              onClick={exportToExcel}
              data-audit-name="Export to Excel"
              disabled={!output}
              className={`px-4 py-2 rounded-md border-2 transition-colors ${
                output
                  ? 'border-app-brand-600 bg-app-brand-800 text-white hover:bg-white hover:text-app-brand-700'
                  : 'border-gray-300 bg-gray-300 text-gray-400 cursor-not-allowed'
              }`}
            >
              Export to Excel
            </button>

            <ResetButton onClick={handleResetAll}
              data-audit-name="Reset All Fields"
             disabled={loading} />
          </div>
        </div>

        {error && (
          <div className="text-sm text-app-brand-800 bg-app-brand-50 p-2 rounded">{error}</div>
        )}

        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
          <div className="text-sm text-gray-500 mb-2">Output</div>
          <MarkdownViewer content={output || 'Generation output will appear here....'} className="min-h-[200px]" />
        </div>
      </div>
    </div>
  )
}

export default DataTab
