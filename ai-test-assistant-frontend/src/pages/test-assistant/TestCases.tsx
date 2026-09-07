import React, { useState, ChangeEvent, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import '../../styles/animations.css'
import { loadConfigFromServer, getConfig } from '../../config/ai-api'
import MarkdownViewer from '../../components/MarkdownViewer'
import { getTimestampedFilename } from '../../utils/DynamicFileName-DateTime'
import ResetButton from '../../components/ResetButton'
import auditService from '../../services/auditService'
import { buildDetailedFieldAudit } from '../../utils/auditDetailsHelper'
import useAuth from '../../hooks/useAuth'
import { logApiEvent } from '../../utils/auditApiHelper'
import { useTestDataContext } from '../../context/TestDataContext'
import mammoth from 'mammoth'
import ReactMarkdown from 'react-markdown';
import { docxFilesToHtml } from '../../utils/docxToHtml' 
import { docxFilesToPlainText } from '../../utils/docxToPlainText'
import ChatWindow from '../../components/ChatWindow'
import { extractTokenCounts } from '../../utils/streamingFetchHelper'
import { trackedFetchWithTokens } from '../../utils/trackedFetchWithTokens'
import userService from '../../services/userService'
import RequestTrackerAPI from '../../utils/requestTrackerAPI'
import { theme } from '../../styles/theme'
import { useAIAction } from '../../hooks/useAIAction'
import { useAIProcessing } from '../../context/AIProcessingContext'
import ReviewAndSendModal, { type ReviewDocumentItem } from '../../components/ReviewAndSendModal'
import Notification from '../../components/Notification'
import { authHeaderFor, isOwnBackend } from '../../utils/trackedFetchWithTokens'



interface FilePreviewData {
  name: string
  // preview holds HTML for display (DOCX converted HTML or text->HTML)
  preview: string
  // markdown/plain text (normalized) used by MarkdownViewer in expanded modal / processing
  markdown: string
  isDocx: boolean
}

const TestCases: React.FC = () => {
  const navigate = useNavigate()
  const [inputType, setInputType] = useState<'text' | 'file' | 'e2e-spark'>('text')
  const [textValue, setTextValue] = useState('')
  const [fileInputs, setFileInputs] = useState<File[]>([])
  const [filePreviews, setFilePreviews] = useState<FilePreviewData[]>([])
  const [output, setOutput] = useState('')
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState('')
  const [isGenerateEnabled, setIsGenerateEnabled] = useState(false)
  const [documentsProcessed, setDocumentsProcessed] = useState(false)
  // raw per-file editable texts (may be empty for DOCX until processed)
  const [editableContents, setEditableContents] = useState<Record<number, string>>({})
  // combined single textarea content for all files
  const [combinedContent, setCombinedContent] = useState<string>('')
  // combined preview HTML (preserves DOCX convertToHtml output)
  const [combinedPreviewHtml, setCombinedPreviewHtml] = useState<string>('')
  const [needsReprocess, setNeedsReprocess] = useState<boolean>(false)
  const [expandedPreview, setExpandedPreview] = useState<boolean>(false)
  const authUser = useAuth()
  const [aiConfig, setAiConfig] = useState(() => getConfig())
  const { setTestCasesData } = useTestDataContext()
  const [contents, setContents] = useState<string[]>([]);
  const [texts, setTexts] = useState<string[]>([]);
  const userAuth = useAuth();
  const [isReviewOpen, setIsReviewOpen] = useState(false)
  const [reviewTableData, setReviewTableData] = useState<Record<string, string>[]>([])
  const [reviewDocuments, setReviewDocuments] = useState<ReviewDocumentItem[]>([])
  const [approvalNotification, setApprovalNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [submittedTestCaseCount, setSubmittedTestCaseCount] = useState<number | null>(null)
  const environmentOptions = [
    { label: 'Select', value: '' },
    { label: 'SIT', value: 'SIT' },
    { label: 'QA', value: 'QA' },
    { label: 'UAT', value: 'UAT' }
  ] as const
  const focusOptions = [
    { label: 'Select', value: '' },
    { label: 'Edge', value: 'Edge' },
    { label: 'Negative', value: 'Negative' },
    { label: 'Positive', value: 'Positive' },
    { label: 'Channel', value: 'Channel' }
  ] as const
  type EnvironmentOption = (typeof environmentOptions)[number]['value']
  type FocusOption = (typeof focusOptions)[number]['value']
  const [selectedEnvironment, setSelectedEnvironment] = useState<EnvironmentOption>('')
  const [selectedFocus, setSelectedFocus] = useState<FocusOption>('')

  // Chat state
  type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string; timestamp: string }
  const [isChatOpen, setIsChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatResponse, setChatResponse] = useState('')
  
  // Token allocation tracking
  const [userTokenAllocation, setUserTokenAllocation] = useState<number>(0)
  const [userTokensUsed, setUserTokensUsed] = useState<number>(0)
  const [tokenCheckLoading, setTokenCheckLoading] = useState<boolean>(false)
  const [showTokenWarning, setShowTokenWarning] = useState<boolean>(false)
  const [tokenWarningMessage, setTokenWarningMessage] = useState<string>('')
  const [ppmId, setPpmId] = useState('')
  const [sparkStorageKey, setSparkStorageKey] = useState('')
  const [sparkImportLoading, setSparkImportLoading] = useState(false)
  const [sparkImportError, setSparkImportError] = useState('')
  const { runAIAction } = useAIAction()
  const { setStreamPreview } = useAIProcessing()
  const isAdminUser = (() => {
    const role = String((authUser.user as any)?.role || '').toLowerCase()
    const roles = (authUser.user as any)?.roles
    return role === 'admin' || (Array.isArray(roles) && roles.some((r: any) => String(r).toLowerCase() === 'admin'))
  })()

  const brdContent = [combinedContent, response].filter(s => s && s.trim().length > 0).join('\n\n---\n\n')

  const previewContent = (() => {
    const fileContent = filePreviews
      .map((preview) => {
        const text = preview.markdown || preview.preview || ''
        return text.trim() ? `## ${preview.name}\n\n${text.trim()}` : ''
      })
      .filter(Boolean)
      .join('\n\n---\n\n')

    if (fileContent.trim()) return fileContent
    if (combinedContent && combinedContent.trim()) return combinedContent.trim()
    return ''
  })()

  const handleAddMessage = (role: 'user' | 'assistant', content: string) => {
    setChatMessages(prev => [
      ...prev,
      { id: `${Date.now()}-${Math.random()}`, role, content, timestamp: new Date().toISOString() }
    ])
  }

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

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const cfg = await loadConfigFromServer()
        if (mounted && cfg) {
          setAiConfig(cfg)
        }
      } catch (err) {
        console.warn('Failed to load AI config for TestCases', err)
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
        let allocation = 0

        // For non-admin users: Fetch allocation; For admin users: Only fetch usage
        if (!isAdminUser) {
          // Fetch user details to get token allocation
          const userData = await userService.get(userAuth.user.username)
          console.log('[TestCases] Fetched user data for token info:', userData)
          allocation = (userData as any).token_allocation || 10000
          console.log('[TestCases] User token allocation:', allocation)
          setUserTokenAllocation(allocation)
        } else {
          // Admin users: no allocation limit
          setUserTokenAllocation(0)
        }

        // Fetch user's token usage from request logs (for all users)
        const logsData = await RequestTrackerAPI.getLogs({
          user: userAuth.user.username,
          limit: 100 // Get all logs for this user
        })

        // Calculate total tokens used
        let totalUsed = 0
        console.log('******[TestCases] Fetched request logs for token usage:', logsData)
        if (logsData.logs && logsData.logs.length > 0) {
          totalUsed = logsData.logs.reduce((sum, log) => {
            const tokens = parseInt(String((log as any).totalTokens || 0))
            return sum + tokens
          }, 0)
        }
        setUserTokensUsed(totalUsed)

        const percentageUsed = allocation > 0 ? (totalUsed / allocation) * 100 : 0

        // Check if user is approaching limit (90%) - only for non-admin users
        if (!isAdminUser && allocation > 0) {
          if (percentageUsed >= 90) {
            setShowTokenWarning(true)
            setTokenWarningMessage(
              percentageUsed >= 100
                ? 'You have reached your token allocation limit. Please contact your administrator.'
                : `Warning: You have used ${percentageUsed.toFixed(1)}% of your allocated tokens.`
            )
          }
        }

        console.log('[TestCases] Token info:', {
          allocation,
          used: totalUsed,
          remaining: allocation - totalUsed,
          percentage: percentageUsed.toFixed(1)
        })
      } catch (err) {
        console.error('[TestCases] Failed to fetch token info:', err)
      } finally {
        setTokenCheckLoading(false)
      }
    }
    
    fetchTokenInfo()
  }, [userAuth.user?.username])

  useEffect(() => {
    if (inputType === 'text') {
      setIsGenerateEnabled(textValue.trim().length > 0)
    } else if (inputType === 'file') {
      setIsGenerateEnabled(fileInputs.length > 0)
    } else {
      setIsGenerateEnabled(combinedContent.trim().length > 0 && sparkStorageKey.trim().length > 0)
    }
  }, [inputType, textValue, fileInputs, combinedContent, sparkStorageKey])

  // Normalize text: collapse excessive whitespace, trim lines, collapse multiple blank lines
  // --- Where generation goes ------------------------------------------------
  //
  // ENDPOINTS.generateTestCasesUrl is an absolute override for THIS BUTTON
  // ONLY. It has existed in the config type and in config.json since the
  // migration but nothing ever read it, so the only way to move generation
  // onto the admin backend was to move BASE_URL -- which moves all eight AI
  // endpoints at once, and only /generate/brd-testcases has been ported. The
  // other seven (visual, test-data, kb/*, code/*, export/*) would 404.
  //
  // Reading it here is what makes the deployed environment able to route just
  // this call to the backend that holds the Knowledge Base, while every other
  // tab keeps talking to the AI service exactly as it does today.
  const resolveGenerateUrl = (cfg: ReturnType<typeof getConfig>) => {
    const override = String((cfg.ENDPOINTS as any).generateTestCasesUrl || '').trim()
    return override || `${cfg.BASE_URL}${cfg.ENDPOINTS.generateTestCases}`
  }

  const normalizeText = (s: string) => {
    if (!s || typeof s !== 'string') return ''
    const lf = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const lines = lf.split('\n').map(line => line.replace(/\s+/g, ' ').trim())
    const collapsed = lines.join('\n').replace(/\n{2,}/g, '\n\n').trim()
    return collapsed
  }

  // convert plain text to simple HTML for preview if we need to render edited plain-text into HTML
  const escapeHtml = (str: string) =>
    str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')

  const textToHtml = (text: string) => {
    if (!text || typeof text !== 'string') return ''
    const paragraphs = text
      .split(/\n{2,}/)
      .map(p => p.split('\n').map(line => escapeHtml(line)).join('<br/>'))
    return paragraphs.map(p => `<p>${p}</p>`).join('')
  }

  const buildPromptTextWithSelection = (baseText: string) => {
    const trimmedBaseText = (baseText || '').trim()
    const selectedValues: string[] = []

    if (selectedEnvironment && selectedEnvironment.trim()) {
      selectedValues.push(`Environment: ${selectedEnvironment}`)
    }

    if (selectedFocus && selectedFocus.trim()) {
      selectedValues.push(`Focus: ${selectedFocus}`)
    }

    if (selectedValues.length === 0) {
      return trimmedBaseText
    }

    const promptLines = trimmedBaseText ? [trimmedBaseText, ...selectedValues] : selectedValues
    return promptLines.join('\n')
  }

  const getReviewSourceText = () => {
    if (inputType === 'text') return textValue
    if (inputType === 'file') {
      return combinedContent || fileInputs.map(file => `${file.name}\n${combinedContent || ''}`).join('\n\n') || ''
    }
    if (inputType === 'e2e-spark') {
      return combinedContent || `PPM ID: ${ppmId || 'N/A'}`
    }
    return ''
  }

  const parseReviewTableData = (content: string): Record<string, string>[] => {
    const raw = (content || '').replace(/\r/g, '')
    if (!raw.trim()) {
      return [{ id: '1', content: '' }]
    }

    const markdownLines = raw.split('\n').filter(line => line.includes('|'))
    if (markdownLines.length >= 3) {
      const rows = markdownLines.filter(line => !/^\s*\|?\s*[:-][-:|\s]*\|?\s*$/.test(line.trim()))
      if (rows.length >= 2) {
        const headers = rows[0].split('|').map(value => value.trim()).filter(Boolean)
        const dataRows = rows.slice(1)
        const parsed = dataRows
          .map((line, index) => {
            const cells = line.split('|').map(value => value.trim()).filter(Boolean)
            if (!cells.length) return null
            const row: Record<string, string> = { id: String(index + 1) }
            headers.forEach((header, headerIndex) => {
              row[header] = cells[headerIndex] ?? ''
            })
            return Object.values(row).some(value => value && value.trim()) ? row : null
          })
          .filter(Boolean) as Record<string, string>[]

        if (parsed.length) return parsed
      }
    }

    const blocks = raw.split(/\n\s*\n/).map(block => block.trim()).filter(Boolean)
    if (blocks.length > 0) {
      const rows: Record<string, string>[] = []
      blocks.forEach((block, index) => {
        const firstLine = block.split('\n')[0]?.trim() || ''
        if (firstLine.includes(':') || firstLine.includes('-')) {
          const [key, ...rest] = firstLine.split(':')
          const row: Record<string, string> = { id: String(index + 1) }
          row[key.trim() || 'field'] = rest.join(':').trim() || block.replace(firstLine, '').trim()
          rows.push(row)
        } else {
          rows.push({ id: String(index + 1), content: block })
        }
      })
      if (rows.length) return rows
    }

    return [{ id: '1', content: raw }]
  }

  const getTestCaseDeduplicationKey = (row: Record<string, string>) => Object.entries(row)
    .filter(([key]) => key !== 'id' && !/^(test[_ ]?case[_ ]?)?(id|number)$/i.test(key))
    .map(([key, value]) => `${key.trim().toLowerCase()}:${normalizeText(String(value)).toLowerCase()}`)
    .join('|')

  const deduplicateTestCases = (rows: Record<string, string>[]) => {
    const seen = new Set<string>()
    return rows.filter(row => {
      const key = getTestCaseDeduplicationKey(row)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  const extractAndConsolidateTestCases = (content: string) => {
    const raw = (content || '').replace(/\r/g, '')
    const markdownLines = raw.split('\n').filter(line => line.includes('|'))
    const tableRows = markdownLines.filter(line => !/^\s*\|?\s*[:-][-:|\s]*\|?\s*$/.test(line.trim()))

    if (tableRows.length >= 2) {
      const headers = tableRows[0].split('|').map(value => value.trim()).filter(Boolean)
      const uniqueRows = deduplicateTestCases(parseReviewTableData(raw))
      const text = [
        `| ${headers.join(' | ')} |`,
        `| ${headers.map(() => '---').join(' | ')} |`,
        ...uniqueRows.map(row => `| ${headers.map(header => row[header] || '').join(' | ')} |`)
      ].join('\n')
      return { text, rows: uniqueRows }
    }

    const rows = deduplicateTestCases(parseReviewTableData(raw))
    return { text: rows.map(row => row.content || Object.values(row).filter(Boolean).join('\n')).join('\n\n'), rows }
  }

  const getReviewDocuments = (): ReviewDocumentItem[] => {
    const docs: ReviewDocumentItem[] = []

    if (inputType === 'file' && fileInputs.length > 0) {
      fileInputs.forEach((file, index) => {
        const previewData = filePreviews[index]
        docs.push({
          id: `file-${index}`,
          name: file.name,
          content: previewData?.markdown || combinedContent || file.name || '',
          type: 'file'
        })
      })
    }

    if (inputType === 'e2e-spark') {
      docs.push({
        id: 'spark-doc',
        name: sparkStorageKey || 'E2E Spark document',
        content: combinedContent || `PPM ID: ${ppmId || 'N/A'}`,
        type: 'spark'
      })
    }

    if (docs.length === 0 && (combinedContent || textValue || response || output)) {
      const content = combinedContent || textValue || response || output || 'No content available.'
      docs.push({
        id: 'prompt-doc',
        name: inputType === 'text' ? 'Reference text' : 'Reference prompt',
        content,
        type: 'file'
      })
    }

    return docs.length > 0 ? docs : [{ id: 'no-docs', name: 'No attached document', content: 'No content available.', type: 'file' }]
  }

  const openReviewWindow = () => {
    const consolidated = extractAndConsolidateTestCases(response || output || '')
    setReviewTableData(consolidated.rows)
    setReviewDocuments(getReviewDocuments())
    setIsReviewOpen(true)
  }

  const handleReviewTableChange = (nextRows: Record<string, string>[]) => {
    setReviewTableData(nextRows)
  }

  const getApprovalDocumentId = (documents: ReviewDocumentItem[]) => {
    if (inputType === 'text') {
      return `input_text_${new Date().toISOString().replace(/[-:.TZ]/g, '')}`
    }

    if (inputType === 'e2e-spark') {
      return ppmId.trim() || sparkStorageKey || 'e2e_spark'
    }

    const ppmIds = documents
      .map((document) => document.name.match(/\bPPM[-_ ]?[A-Za-z0-9-]+\b/i)?.[0])
      .filter((ppmId): ppmId is string => Boolean(ppmId))
    const documentIds = ppmIds.length > 0 ? ppmIds : documents.map((document) => document.name).filter(Boolean)
    return Array.from(new Set(documentIds)).join(' | ') || `input_text_${new Date().toISOString().replace(/[-:.TZ]/g, '')}`
  }

  const handleSendForApproval = async (rows: Record<string, string>[], documents: ReviewDocumentItem[] = getReviewDocuments()) => {
    try {
      const requestId = `REQ-${Date.now()}`
      const requestBy = (authUser.user as any)?.username || (authUser.user as any)?.email || 'system'
      const documentId = getApprovalDocumentId(documents)
      const uniqueRows = deduplicateTestCases(rows).map((row, index) => {
        const baseId = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : `TC-${index + 1}`
        return {
          ...row,
          id: `${requestId}-TC-${index + 1}`,
          test_case_id: `${requestId}-TC-${index + 1}`,
          sourceRowId: baseId
        }
      })

      const payload = {
        request_id: requestId,
        source: inputType === 'e2e-spark' ? 'AZURE_DEVOPS' : inputType.toUpperCase(),
        request_by: requestBy,
        request_date_time: new Date().toISOString(),
        document_id: documentId,
        brd_document: documents,
        no_of_test_cases: uniqueRows.length,
        approved_count: 0,
        rejected_count: 0,
        overall_status: 'PENDING_REVIEW',
        review_notes: '',
        rows: uniqueRows.map((row, index) => ({
          test_case_id: row.test_case_id || `${requestId}-TC-${index + 1}`,
          request_id: requestId,
          test_case_details: { ...row },
          status: 'PENDING',
          generated_by: requestBy
        })),
        payload: {
          rows: uniqueRows,
          inputType,
          environment: selectedEnvironment || '',
          focus: selectedFocus || '',
          source: getReviewSourceText(),
          generated: response || output || '',
          submittedAt: new Date().toISOString()
        },
        documents
      }

      console.log('[TestCases] Send for approval payload:', payload)
      const responseData = await fetch(`${(import.meta as any).env?.VITE_API_URL || (import.meta as any).env?.VITE_API_LOCAL_URL}/test-case-reviews/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('api_token') || ''}`
        },
        body: JSON.stringify(payload)
      })

      if (!responseData.ok) {
        throw new Error(`Approval submission failed with status ${responseData.status}`)
      }

      const data = await responseData.json().catch(() => ({ success: true }))
      console.log('[TestCases] Approval submission succeeded:', data)
      window.dispatchEvent(new Event('test-case-review-updated'))
      setSubmittedTestCaseCount(uniqueRows.length)
      setApprovalNotification({ message: `${uniqueRows.length} test case${uniqueRows.length === 1 ? '' : 's'} sent for approval`, type: 'success' })
      return true
    } catch (error) {
      console.error('[TestCases] Failed to submit for approval:', error)
      setApprovalNotification({ message: 'Failed to send for approval', type: 'error' })
      return false
    }
  }
  
   // Spark content must be plain text only: remove images/media/html markup and binary-like payloads.
  const sanitizeSparkContentToPlainText = (raw: string) => {
    if (!raw || typeof raw !== 'string') return ''

    let text = raw
    const looksHtml = /<\/?[a-z][\s\S]*>/i.test(raw)
    if (looksHtml) {
      const parser = new DOMParser()
      const doc = parser.parseFromString(raw, 'text/html')
      doc
        .querySelectorAll('img,picture,source,svg,video,audio,canvas,iframe,object,embed,script,style,noscript')
        .forEach((el) => el.remove())
      text = doc.body?.textContent || doc.documentElement?.textContent || ''
    }

    // Remove markdown image syntax and inline base64/data-uri payloads.
    text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    text = text.replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=\s]+/g, ' ')

    // Remove long binary-like chunks that occasionally appear in API payloads.
    text = text.replace(/[A-Za-z0-9+/]{400,}={0,2}/g, ' ')
    text = text.replace(/\b(?:[A-Fa-f0-9]{2}){100,}\b/g, ' ')

    return normalizeText(text)
  }


  // Build combinedContent from current editableContents (text files only at upload time)
  const rebuildCombinedFromEditable = (editableMap: Record<number, string>) => {
    // preserve order of fileInputs
    const parts: string[] = []
    for (let i = 0; i < fileInputs.length; i++) {
      const txt = editableMap[i] ?? ''
      if (txt && txt.trim().length > 0) parts.push(normalizeText(txt))
    }
    return parts.join('\n\n')
  }

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || [])
    if (selectedFiles.length === 0) return

    const newFiles = [...fileInputs, ...selectedFiles]
    setFileInputs(newFiles)
    setDocumentsProcessed(false)
    setResponse('')
    setCombinedPreviewHtml('')

    const newPreviews: FilePreviewData[] = []
    const newEditableContents: Record<number, string> = { ...editableContents }

    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i]
      const name = file.name.toLowerCase()
      const fileIndex = fileInputs.length + i
      let preview = ''
      let markdown = ''
      let isDocx = false

      if (name.endsWith('.docx')) {
        // defer DOCX processing to Process Documents
        isDocx = true
        preview = ''
        markdown = ''
        // editableContents[fileIndex] remains '' until Process Documents or user edits combined content
      } else if (name.endsWith('.txt') || name.endsWith('.csv') || name.endsWith('.md')) {
        try {
          const txt = await file.text()
          const normalized = normalizeText(txt)
          newEditableContents[fileIndex] = normalized
          markdown = normalized
          preview = '' // preview after Process Documents
        } catch (err) {
          console.error('Error reading text file:', err)
          markdown = `Error reading file: ${file.name}`
          newEditableContents[fileIndex] = markdown
        }
      } else {
        // binary / unsupported
        preview = ''
        markdown = `Preview not available for binary file type: ${file.name}`
      }

      newPreviews.push({ name: file.name, preview, markdown, isDocx })
    }

    setFilePreviews(prev => [...prev, ...newPreviews])
    setEditableContents(newEditableContents)

    // update combinedContent with available text parts (text files). DOCX parts will be added when Process Documents is clicked.
    const combined = rebuildCombinedFromEditable(newEditableContents)
    setCombinedContent(combined)
    setNeedsReprocess(true)
  }

  // remove a file and re-map editable contents
  const handleRemoveFile = (index: number) => {
    const newFiles = fileInputs.filter((_, i) => i !== index)
    const newPreviews = filePreviews.filter((_, i) => i !== index)
    setFileInputs(newFiles)
    setFilePreviews(newPreviews)

    const remapped: Record<number, string> = {}
    Object.keys(editableContents).forEach(k => {
      const kNum = Number(k)
      if (isNaN(kNum)) return
      if (kNum < index) remapped[kNum] = editableContents[kNum]
      else if (kNum > index) remapped[kNum - 1] = editableContents[kNum]
    })
    setEditableContents(remapped)

    // update combinedContent
    const combined = rebuildCombinedFromEditable(remapped)
    setCombinedContent(combined)
    setDocumentsProcessed(false)
    setCombinedPreviewHtml('')
  }

  // When the combined textarea is edited
  const handleCombinedChange = (value: string) => {
    setCombinedContent(value)
    setNeedsReprocess(true)
    // setDocumentsProcessed(false)
  }

  const handleImportSsd = async () => {
    const trimmedPpmId = ppmId.trim()
    if (!trimmedPpmId) {
      setSparkImportError('PPM ID is required')
      return
    }

    setSparkImportLoading(true)
    setSparkImportError('')
    setSparkStorageKey('')

    try {
      const authLoginUrl = String((import.meta as any).env?.VITE_SSD_AUTH_LOGIN_URL || '').trim()
      const authLoginEmail = String((import.meta as any).env?.VITE_SSD_AUTH_LOGIN_EMAIL || '').trim()
      const authLoginPassword = ('audiGG14$$045')	//String((import.meta as any).env?.VITE_SSD_AUTH_LOGIN_PASSWORD || '')

      if (!authLoginUrl) {
        throw new Error('SSD auth login URL is not configured')
      }
      if (!authLoginEmail || !authLoginPassword) {
        throw new Error('SSD auth login payload is not configured (email/password)')
      }

      const loginRes = await fetch(authLoginUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          email: authLoginEmail,
          password: authLoginPassword
        })
      })

      const loginPayload = await loginRes.json().catch(() => null)
      if (!loginRes.ok || !(loginPayload as any)?.success || !(loginPayload as any)?.token) {
        throw new Error((loginPayload as any)?.message || `Auth login failed with status ${loginRes.status}`)
      }
      const token = String((loginPayload as any).token)

      const pythonApiBase = String((import.meta as any).env?.VITE_SOLUTION_API_BASE_URL || '').replace(/\/$/, '')
      if (!pythonApiBase) {
        throw new Error('Python backend API base URL is not configured')
      }

      const searchRes = await fetch(`${pythonApiBase}/solutions/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ q: trimmedPpmId })
      })

      const searchPayload = await searchRes.json().catch(() => null)
      if (!searchRes.ok) {
        throw new Error((searchPayload as any)?.message || `Search API failed with status ${searchRes.status}`)
      }

      const fileId = (searchPayload as any)?.data?.files?.[0]?.id
      if (!fileId || typeof fileId !== 'string') {
        throw new Error('No file id found for the provided PPM ID')
      }

      setSparkStorageKey(fileId)

      const contentRes = await fetch(`${pythonApiBase}/solutions/files/${encodeURIComponent(fileId)}/content`, {
        method: 'GET',
        headers: {
          Accept: 'application/json, text/plain, */*',
          Authorization: `Bearer ${token}`
        }
      })

      if (!contentRes.ok) {
        throw new Error(`File content API failed with status ${contentRes.status}`)
      }

      const contentType = contentRes.headers.get('content-type') || ''
      let extractedContent = ''

      if (contentType.includes('application/json')) {
        const payload = await contentRes.json().catch(() => null)
        const htmlContent = (payload as any)?.data?.html
        const jsonContent =
          htmlContent ??
          (payload as any)?.data?.content ??
          (payload as any)?.content ??
          (payload as any)?.data?.text ??
          (payload as any)?.text ??
          (typeof (payload as any)?.data === 'string' ? (payload as any).data : '')

        if (typeof jsonContent === 'string' && jsonContent.trim().length > 0) {
          extractedContent = jsonContent
        } else if (payload !== null && payload !== undefined) {
          extractedContent = JSON.stringify(payload, null, 2)
        }
      } else {
        extractedContent = await contentRes.text()
      }

      if (!extractedContent || extractedContent.trim().length === 0) {
        throw new Error('Imported SSD content is empty')
      }

      const combinedValue = sanitizeSparkContentToPlainText(extractedContent)
      if (!combinedValue || combinedValue.trim().length === 0) {
        throw new Error('Imported SSD content did not contain usable plain text')
      }

      setCombinedContent(combinedValue)
      setCombinedPreviewHtml(textToHtml(combinedValue))
      setDocumentsProcessed(true)
      setNeedsReprocess(false)
      setResponse('')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to import SSD content'
      setSparkImportError(msg)
      setDocumentsProcessed(false)
    } finally {
      setSparkImportLoading(false)
    }
  }

  // Process Documents: convert DOCX now, combine all file texts (or use combinedContent if user edited it),
  // and produce combinedPreviewHtml in current format (DOCX HTML + text converted to HTML).
  const handleProcessDocuments = async () => {
    await runAIAction({
      actionName: 'process_testcase_documents',
      actionLabel: 'Analyzing Requirements',
      artifactType: 'Document Preview',
      stages: [
        'Reading requirements and inputs',
        'Understanding business and testing scope',
        'Interpreting uploaded documents',
        'Normalizing document content',
        'Preparing generated artifacts'
      ],
      successMessage: 'Documents processed successfully.',
      retryAction: handleProcessDocuments,
      execute: async () => {

    const requestPayload: Record<string, any> = {
        inputType,
        provider: aiConfig.PARAMETERS.provider,
        model_name: String(aiConfig.PARAMETERS.model),
        temperature: String(aiConfig.PARAMETERS.temperature),
        max_tokens: String(aiConfig.PARAMETERS.maxTokens),
        response_format: 'text',
        files: fileInputs.map(f => ({ name: f.name, size: f.size, type: f.type }))  
      }
      let auditStatus: 'success' | 'failure' = 'success'
      let responsePayload: any = null

  try {

      if (fileInputs.length === 0) {
        setDocumentsProcessed(false)
        return
      }

      setLoading(true)
      const config = getConfig()

      // --- Where documents get extracted --------------------------------
      //
      // Deliberately NOT resolveGenerateUrl(). Generation and extraction are
      // two different jobs with two different best homes, and the whole point
      // of the generateTestCasesUrl override is that they can now diverge:
      //
      //   generation  -> the admin backend, which holds the Knowledge Base and
      //                  is the only thing that can ground a prompt.
      //   extraction  -> BASE_URL, the AI service, which has always done this
      //                  and reads formats nothing in this repo can, PDF
      //                  included. Confirmed working in the deployed
      //                  environment.
      //
      // So this keeps posting files exactly where it always has. Pointing it
      // at the admin backend instead would be a regression: that backend has
      // no document parser, and the Test Assistant's own client-side parser
      // (mammoth) reads .docx and text formats only.
      //
      // The client-side path below is the FALLBACK for when BASE_URL is the
      // admin backend -- local development, or any environment mid-migration.
      // There the AI service is not reachable at all, and a request for
      // extraction returns 501 or, before this was checked,
      // {"detail":"Invalid or expired token"} pasted into the editable box as
      // if it were the document's text.
      const extractUrl = `${config.BASE_URL}${config.ENDPOINTS.generateTestCases}`
      const extractOnServer = !isOwnBackend(extractUrl)

      if (extractOnServer && !(needsReprocess && combinedContent && combinedContent.trim().length > 0)) {
        const formData = new FormData()
        formData.append('provider', config.PARAMETERS.provider)
        formData.append('model_name', String(config.PARAMETERS.model))
        formData.append('temperature', String(config.PARAMETERS.temperature))
        formData.append('max_tokens', String(config.PARAMETERS.maxTokens))
        formData.append('response_format', 'text')
        fileInputs.forEach(f => formData.append('files', f as Blob))

        const res = await fetch(extractUrl, {
          method: 'POST',
          body: formData,
          headers: authHeaderFor(extractUrl)
        })

        // Without this, an error body becomes the "requirements" that the
        // Generate button then sends to the model.
        if (!res.ok) {
          const raw = await res.text().catch(() => '')
          let detail = raw
          try {
            const parsed = JSON.parse(raw)
            if (parsed?.detail) detail = String(parsed.detail)
          } catch {
            // not JSON; the raw body is the best message available
          }
          throw new Error(
            res.status === 401
              ? 'Your session has expired. Sign in again and re-run Process Documents.'
              : `Could not process the uploaded document(s): ${detail}`
          )
        }

        let extracted = ''
        if (res.body) {
          const reader = (res.body as ReadableStream<Uint8Array>).getReader()
          const decoder = new TextDecoder()
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            extracted += decoder.decode(value, { stream: true })
          }
        } else {
          extracted = await res.text()
        }

        if (extracted && extracted.trim().length > 0) {
          const normalizedCombined = normalizeText(extracted)
          setCombinedContent(normalizedCombined)
          setCombinedPreviewHtml(textToHtml(normalizedCombined))
          setDocumentsProcessed(true)
          setNeedsReprocess(false)
          setResponse('')
          responsePayload = normalizedCombined
          return
        }
        throw new Error('No readable text was returned for the uploaded document(s).')
      }

      // If the user has edited combinedContent, prefer that as the source
      if (needsReprocess && combinedContent && combinedContent.trim().length > 0) {
        const normalizedCombined = normalizeText(combinedContent)
        setCombinedContent(normalizedCombined)
        setCombinedPreviewHtml(textToHtml(normalizedCombined))
        setDocumentsProcessed(true)
        setNeedsReprocess(false)
        setResponse('')
        responsePayload = normalizedCombined
        return
      }

      // Otherwise build combined content from the files themselves
      const combinedTextParts: string[] = []
      const htmlParts: string[] = []
      const unreadable: string[] = []

      for (let i = 0; i < fileInputs.length; i++) {
        const file = fileInputs[i]
        const name = file.name.toLowerCase()

        // If the user had provided editable content for this file, use it
        if (editableContents[i] !== undefined && editableContents[i] !== null && editableContents[i] !== '') {
          const normalized = normalizeText(editableContents[i])
          combinedTextParts.push(normalized)
          htmlParts.push(textToHtml(normalized))
          continue
        }

        try {
          if (name.endsWith('.docx')) {
            const arrayBuffer = await file.arrayBuffer()
            const htmlResult = await mammoth.convertToHtml({ arrayBuffer })
            const textResult = await mammoth.extractRawText({ arrayBuffer })
            const normalizedText = normalizeText(textResult?.value || '')
            combinedTextParts.push(normalizedText)
            // Keep the converted HTML for fidelity in the preview
            htmlParts.push(htmlResult?.value || textToHtml(normalizedText))
          } else if (name.endsWith('.txt') || name.endsWith('.csv') || name.endsWith('.md')) {
            const txt = await file.text()
            const normalized = normalizeText(txt)
            combinedTextParts.push(normalized)
            htmlParts.push(textToHtml(normalized))
          } else {
            // Named, not silently swallowed. A placeholder pushed into
            // combinedTextParts would become the "requirements" the Generate
            // button then sends to the model, so unreadable files are reported
            // and contribute nothing to the text.
            unreadable.push(file.name)
            htmlParts.push(
              `<div class="text-xs text-gray-400">${escapeHtml(`Preview not available for binary file type: ${file.name}`)}</div>`
            )
          }
        } catch (err) {
          console.error('Error processing file during Process Documents:', file.name, err)
          unreadable.push(file.name)
          htmlParts.push(
            `<div class="text-xs text-gray-400">${escapeHtml(`Error processing file: ${file.name}`)}</div>`
          )
        }
      }

      if (combinedTextParts.length === 0) {
        throw new Error(
          unreadable.length > 0
            ? `No readable text could be extracted. This tab reads .docx, .txt, .csv and .md files; could not read: ${unreadable.join(', ')}.`
            : 'No readable text was found in the uploaded document(s).'
        )
      }

      const combinedText = normalizeText(combinedTextParts.join('\n\n'))
      setCombinedContent(combinedText)
      setCombinedPreviewHtml(htmlParts.join('<hr class="my-4"/>'))
      setDocumentsProcessed(true)
      setNeedsReprocess(false)
      setResponse('')

      if (unreadable.length > 0) {
        console.warn('Process Documents skipped unreadable file(s):', unreadable.join(', '))
      }

      responsePayload = combinedText

    } catch (err) {
      console.error('Error in Process Documents:', err)
      auditStatus = 'failure'
      responsePayload = String(err)
      throw err

    }finally {
      setLoading(false)
      try {
          await logApiEvent({
            user: authUser.user,
            module: 'Test Cases',
            action: 'Files upload and Process Documents',
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

  let fullText = ''
  const handleGenerate = async () => {
    setSubmittedTestCaseCount(null)
    // Check token allocation before making request
    if (!isAdminUser && userTokenAllocation > 0 && userTokensUsed >= userTokenAllocation) {
      setShowTokenWarning(true)
      setTokenWarningMessage(
        'You have reached your token allocation limit. Please contact your administrator to increase your allocation.'
      )
      return
    }
    
    // Warn if approaching limit but allow request
    const remainingTokens = userTokenAllocation - userTokensUsed
    if (!isAdminUser && userTokenAllocation > 0 && remainingTokens < 1000 && remainingTokens > 0) {
      setShowTokenWarning(true)
      setTokenWarningMessage(
        `Warning: You have only ${remainingTokens.toLocaleString()} tokens remaining in your allocation.`
      )
    }
    
    await runAIAction({
      actionName: 'generate_test_cases',
      actionLabel: 'Generating Test Cases',
      artifactType: 'Test Cases',
      stages: [
        'Reading requirements and inputs',
        'Understanding business and testing scope',
        'Identifying positive, negative, boundary, and exception scenarios',
        'Generating test cases',
        'Validating test coverage and output structure',
        'Preparing generated artifacts'
      ],
      successMessage: 'Test Cases generated successfully.',
      retryAction: handleGenerate,
      execute: async () => {
        setLoading(true);
        setResponse('');
        setOutput('');
        // setError('');
        
        const requestPayload = {
          inputType,
          environment: selectedEnvironment || '',
          focus: selectedFocus || '',
          documentCount: fileInputs.length,
          combinedLength: combinedContent.length,
          provider: String(aiConfig.PARAMETERS.provider ?? ''),
          temperature: String(aiConfig.PARAMETERS.temperature ?? 0),
          model: String(aiConfig.PARAMETERS.model ?? ''),
          endpoint: aiConfig.ENDPOINTS.generateTestCases
        };

        console.log('Request payload for generating test cases:', requestPayload);
        let auditStatus: 'success' | 'failure' = 'success';
        let responsePayload: any = null;

        try {
          const config = getConfig();
          const formData = new FormData();
          formData.append('provider', config.PARAMETERS.provider);
          formData.append('model_name', String(config.PARAMETERS.model));
          formData.append('temperature', String(config.PARAMETERS.temperature));
          formData.append('max_tokens', String(config.PARAMETERS.maxTokens));
          formData.append('response_format', 'text');

          const sourceText = (() => {
            if (inputType === 'text') return textValue
            if (inputType === 'file' && fileInputs.length > 0) {
              return combinedContent && combinedContent.trim().length > 0 ? combinedContent : ''
            }
            if (inputType === 'e2e-spark') {
              return combinedContent && combinedContent.trim().length > 0 ? combinedContent : ''
            }
            return ''
          })()

          const promptText = buildPromptTextWithSelection(sourceText)
          formData.append('text', promptText)
          console.log('Prompt text being sent to API:', promptText)

      // console.log('Generating test cases with formData:', Array.from(formData.keys()));
      // console.log('Files in formData:', Array.from(formData.values()));
      // // Use direct fetch - exact same pattern as handleProcessDocuments
      // const res = await fetch(`${aiConfig.BASE_URL}${aiConfig.ENDPOINTS.generateTestCases}`, {
      //   method: 'POST',
      //   body: formData
      // });

      // if (!res.ok) {
      //   const errorText = await res.text();
      //   throw new Error(`HTTP ${res.status}: ${errorText}`);
      // }

      // // Stream and accumulate response
      // const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      // const decoder = new TextDecoder();
      // let fullText = '';

      // while (true) {
      //   const { done, value } = await reader.read();
      //   if (done) break;
      //   const chunk = decoder.decode(value);
      //   fullText += chunk.replace(/^data: /, '');
      // }

      // Start timer for duration calculation
      const startedAt = Date.now();

      // Call tracked fetch but handle streaming locally
      const { response: res, status, logId } = await trackedFetchWithTokens(
        resolveGenerateUrl(config),
        {
          tab: 'testcases',
          method: 'POST',
          body: formData,
          user: userAuth.user?.username || 'anonymous',
          sessionId: sessionStorage.getItem('client_session_id') || undefined,
          externalStream: true
        }
      );
      console.log("res === : ",res);
      // Stream and accumulate response here
      if (!res.body) {
        fullText = await res.text();
      } else {
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        fullText = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value);
          const streamedChunk = chunk.replace(/^data: /, '');
          setResponse(prev => prev + streamedChunk)
          fullText += streamedChunk;
          setStreamPreview(fullText);
        }
      }

      console.log('Full response text received:', fullText);
      // Extract tokens if present
      const tokenInfo = extractTokenCounts(fullText);
      if (tokenInfo) {
        console.log('[TestCases] Token usage:', tokenInfo);
        const tokensUsedInRequest = tokenInfo.totalTokens || 0;
        setUserTokensUsed(prev => prev + tokensUsedInRequest);
        const newTotal = userTokensUsed + tokensUsedInRequest;
        if (!isAdminUser && userTokenAllocation > 0 && newTotal >= userTokenAllocation) {
          setShowTokenWarning(true);
          setTokenWarningMessage('You have reached your token allocation limit. This was your last request.');
        }
      }

      // Update the request log now that we have fullText
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
        console.error('[TestCases] Failed to update request log:', logErr);
      }

      // Handle HTTP error after reading body (to surface server message)
      if (!res.ok) {
        throw new Error(`HTTP ${status}: ${fullText}`);
      }

      responsePayload = fullText;

      if (fullText && fullText.trim().length > 0) {
        setTestCasesData(fullText);
      }

        } catch (err) {
          console.error('Generation error:', err);
          // setError(`Error generating test cases: ${err instanceof Error ? err.message : String(err)}`);
          auditStatus = 'failure';
          responsePayload = String(err);
          throw err;

        } finally {
          setLoading(false);
          try {
            await logApiEvent({
              user: authUser.user,
              module: 'TestCases',
              action: 'Generate Test Cases',
              resourceType: 'API',
              resourceId: 'generateTestCases',
              resourceName: 'Generate Test Cases',
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

  const handleUseForTestData = () => {
    if (response) {
      setTestCasesData(response)
      navigate('/test-assistant/data')
    }
  }

  async function exportToExcel() {
    const config = getConfig()
    const consolidated = extractAndConsolidateTestCases(response || output || '')
    const formData = new FormData()
    formData.append('test_cases_text', consolidated.text)

    let responsePayload: any = null
    let auditStatus: 'success' | 'failure' = 'success'

    try {
      const exportUrl = `${config.BASE_URL}${config.ENDPOINTS.exportExcel}`
      const res = await fetch(exportUrl, {
        method: 'POST',
        body: formData,
        headers: { accept: 'application/json', ...authHeaderFor(exportUrl) }
      })
      const data = await res.blob()
      if (data.size === 0) return
      const url = URL.createObjectURL(data)
      const a = document.createElement('a')
      a.href = url
      a.download = getTimestampedFilename('test-case')
      a.click()
      URL.revokeObjectURL(url)
      try {
        await logApiEvent({
          user: authUser.user,
          module: 'Test Cases',
          action: 'Export to Excel',
          resourceType: 'file',
          resourceId: 'test_case_export',
          resourceName: 'Test Cases Export',
          request: { test_cases_text: consolidated.text },
          response: { filename: a.download, size: data.size },
          status: 'success'
        })  
      } catch (auditErr) {
        console.error('Failed to log audit event:', auditErr)
      }
      
    } catch (err) {
      console.error('Export error', err)
    }
  }

  const handleResetAll = () => {
    setInputType('text')
    setTextValue('')
    setFileInputs([])
    setFilePreviews([])
    setOutput('')
    setResponse('')
    setLoading(false)
    setDocumentsProcessed(false)
    setEditableContents({})
    setCombinedContent('')
    setCombinedPreviewHtml('')
    setNeedsReprocess(false)
    setExpandedPreview(false)
    setPpmId('')
    setSparkStorageKey('')
    setSparkImportLoading(false)
    setSparkImportError('')
  }

  const getGenerateButtonLabel = () => {
    if (inputType === 'e2e-spark') {
      return loading ? 'Generating...' : 'E2E Spark Generate'
    }
    if (loading) return 'Generating...'
    if (inputType === 'file' && fileInputs.length > 0 && !documentsProcessed) {
      return 'Process Documents'
    }
    return 'Generate Test Cases'
  }






  
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files) {
      const htmlContents = await docxFilesToHtml(Array.from(files));
      setContents(htmlContents);
    }
  };

  const inputOptions: Array<{
    value: 'text' | 'file' | 'e2e-spark'
    label: string
    description: string
  }> = [
    { value: 'text', label: 'Text Input', description: 'Paste BRD or solution text directly.' },
    { value: 'file', label: 'File Upload', description: 'Bring in documents and process them in place.' },
    { value: 'e2e-spark', label: 'From e2e Spark', description: 'Import SSD content using a PPM identifier.' }
  ]



  return (
    <div className="mx-auto max-w-[1600px] space-y-4">
      {/* Token Warning Banner */}
      {showTokenWarning && (
        <div className={`rounded-[20px] border-l-4 p-3.5 ${
          userTokensUsed >= userTokenAllocation
            ? 'bg-app-brand-50 border-red-500'
            : 'bg-yellow-50 border-yellow-500'
        }`}>
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
              <p className={`text-sm font-medium ${
                userTokensUsed >= userTokenAllocation ? 'text-red-800' : 'text-yellow-800'
              }`}>
                {tokenWarningMessage}
              </p>
            </div>
            <button
              onClick={() => setShowTokenWarning(false)}
              className="text-gray-400 hover:text-gray-600"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {/* Solutions card — header + input type pills + textarea all in one */}
        <div className="relative overflow-hidden rounded-[20px] border border-app bg-app-surface p-4 shadow-app-card">
          {/* Paper airplane decorative trail (right side, behind content) */}
          <svg viewBox="0 0 280 60" className="pointer-events-none absolute right-3 top-2 h-12 w-[260px] opacity-90" aria-hidden>
            <path d="M0 38 Q 40 18, 80 32 T 160 28 T 240 18" fill="none" stroke="#E8292E" strokeWidth="1.5" strokeDasharray="3 4" strokeLinecap="round" opacity="0.55" />
            <g transform="translate(244 14) rotate(-18)">
              <path d="M0 0 L18 6 L8 8 L6 16 Z" fill="#E8292E" />
            </g>
          </svg>

          {/* Solutions header */}
          <div className="relative mb-3 flex w-full flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-start gap-2.5">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] text-white shadow-[0_8px_20px_rgba(183,25,32,0.18)]">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-5 w-5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15M4.5 12h15" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 7l10 10M17 7L7 17" />
                </svg>
              </div>
              <div className="min-w-0">
                <h2 className="text-[16px] font-bold tracking-[-0.01em] text-app-primary leading-tight">Solutions</h2>
                <p className="text-[12px] leading-5 text-app-secondary">
                  Generate test cases and test data from your solutions text or uploaded files.
                </p>
              </div>
            </div>

            <div className="flex min-w-[210px] items-center justify-end gap-3 rounded-[12px] border border-app bg-white px-3 py-2 shadow-sm">
              <div className="text-right">
                <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-app-secondary">Token Usage</div>
                {!tokenCheckLoading ? (
                  isAdminUser ? (
                    <div className="mt-0.5 text-[12px] text-app-secondary">Total tokens used</div>
                  ) : (
                    <div className="mt-0.5 text-[12px] text-app-secondary">of {userTokenAllocation.toLocaleString()} allocated</div>
                  )
                ) : (
                  <div className="mt-0.5 text-[12px] text-app-secondary">Loading...</div>
                )}
              </div>
              <div className={`text-[22px] font-bold leading-none ${!isAdminUser && userTokenAllocation > 0 && userTokensUsed >= userTokenAllocation ? 'text-app-brand-700' : 'text-app-primary'}`}>
                {tokenCheckLoading ? '...' : userTokensUsed.toLocaleString()}
              </div>
            </div>
          </div>

          {/* Input type pills */}
          <div className="relative mb-3 grid gap-2 md:grid-cols-3">
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

            <label className={`cursor-pointer rounded-[12px] border px-3 py-2 transition-all duration-200 ${inputType === 'e2e-spark' ? 'border-app-brand-200 bg-app-brand-50/60' : 'border-app bg-white hover:border-app-brand-100 hover:bg-app-brand-50/30'}`}>
              <input
                type="radio"
                data-audit-name="Solution from e2e Spark"
                checked={inputType === 'e2e-spark'}
                onChange={() => setInputType('e2e-spark')}
                className="sr-only"
              />
              <div className="flex items-center gap-2">
                <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[8px] ${inputType === 'e2e-spark' ? 'bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] text-white' : 'bg-app-surface-muted text-app-secondary'}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </span>
                <span className={`text-[13px] font-semibold ${inputType === 'e2e-spark' ? 'text-app-brand-800' : 'text-app-primary'}`}>From e2e Spark</span>
              </div>
            </label>
          </div>

          {inputType === 'text' ? (
            <textarea
              value={textValue}
              data-audit-name="Text Input"
              onChange={(e) => setTextValue(e.target.value)}
              placeholder="Enter your BRD text here..."
              className="min-h-[180px] w-full resize-none rounded-[20px] border border-app bg-white px-4 py-3.5 text-sm text-app-primary outline-none transition placeholder:text-app-muted focus:border-app-brand-600 focus:ring-2 focus:ring-app-brand-100"
            />
          ) : (
            <>
              {inputType === 'file' ? (
                <div className="mb-4 rounded-[20px] border border-dashed border-app-brand-200 bg-app-brand-50/35 p-6 text-center">
                  <input
                    type="file"
                    onChange={handleFileChange}
                    data-audit-name="File Upload"
                    className="hidden"
                    id="file-upload"
                    accept=".txt,.doc,.docx,.pdf,.xls,.xlsx,.ppt,.pptx"
                    multiple
                  />
                  <label htmlFor="file-upload" className="cursor-pointer text-app-brand-700 hover:text-app-brand-800">
                    <div className="mb-2 text-base font-semibold">Click to upload or drag and drop (multiple files)</div>
                    <div className="text-sm text-app-secondary">
                      Supported files: TXT, DOC, DOCX, PDF, XLS, XLSX, PPT, PPTX
                    </div>
                  </label>
                </div>
              ) : (
                <div className="mb-4 rounded-[20px] border border-app-brand-100 bg-[linear-gradient(180deg,rgba(253,235,236,0.7)_0%,rgba(255,255,255,1)_100%)] p-4">
                  <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
                    <div>
                      <label className="mb-2 block text-sm font-medium text-app-primary">
                        PPM ID <span className="text-app-brand-700">*</span>
                      </label>
                      <input
                        type="text"
                        value={ppmId}
                        onChange={(e) => {
                          setPpmId(e.target.value)
                          if (sparkImportError) setSparkImportError('')
                        }}
                        placeholder="Enter PPM ID"
                        className={theme.input}
                      />
                    </div>
                    <button
                      onClick={handleImportSsd}
                      disabled={sparkImportLoading || ppmId.trim().length === 0}
                      className={`inline-flex h-11 items-center justify-center rounded-[18px] px-5 text-sm font-semibold transition ${
                        !sparkImportLoading && ppmId.trim().length > 0
                          ? 'bg-app-brand-700 text-white hover:bg-app-brand-800'
                          : 'cursor-not-allowed bg-gray-300 text-gray-500'
                      }`}
                    >
                      {sparkImportLoading ? 'Importing...' : 'Import SSD'}
                    </button>
                  </div>
                  {sparkStorageKey && (
                  <div className="mt-3 text-xs font-medium text-green-700">SSD imported successfully (id: {sparkStorageKey})</div>
                )}
                {sparkImportError && (
                    <div className="mt-3 text-xs font-medium text-app-brand-700">{sparkImportError}</div>
                  )}
                </div>
              )}

              {/* File list: show only attachments */}
              {inputType === 'file' && fileInputs.length > 0 && (
                <div className="space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.16em] text-app-secondary">Uploaded Files ({fileInputs.length})</div>
                  {fileInputs.map((file, index) => (
                    <div key={index} className="flex items-start justify-between gap-4 rounded-[22px] border border-app bg-app-surface-muted/55 p-4">
                      <div className="flex items-center space-x-2">
                        <svg className="h-5 w-5 flex-shrink-0 text-app-brand-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-app-primary">{file.name}</div>
                          <div className="text-xs text-app-secondary">{(file.size / 1024).toFixed(2)} KB</div>
                        </div>
                      </div>
                      <div className="flex items-center space-x-2">
                        <button onClick={() => handleRemoveFile(index)} className="ml-2 flex-shrink-0 rounded-full p-2 text-app-brand-700 transition hover:bg-white hover:text-red-800" title="Remove file">
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Combined editable textarea */}
              <div className="mt-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.16em] text-app-secondary">Combined Editable Content</div>
                  {documentsProcessed && (
                    <button
                      type="button"
                      onClick={() => setExpandedPreview(true)}
                      aria-label="Open document preview"
                      title="Open document preview"
                      className="inline-flex items-center gap-2 rounded-md border-2 border-red-600 bg-white px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-red-600 transition hover:bg-red-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-app-brand-200 focus:ring-offset-2"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M7 3h7l5 5v13a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2zm7 1v5h5" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 14s1.2-2.5 3-2.5 3 2.5 3 2.5-1.2 2.5-3 2.5-3-2.5-3-2.5z" />
                        <circle cx="12" cy="14" r="0.75" fill="currentColor" stroke="none" />
                      </svg>
                      <span>Document Preview</span>
                    </button>
                  )}
                </div>
                <textarea
                  value={combinedContent}
                  onChange={(e) => handleCombinedChange(e.target.value)}
                  placeholder={inputType === 'e2e-spark' ? "Imported SSD content will appear here after clicking 'Import SSD'..." : "Combined content from all uploaded files will appear here (edit and click 'Process Documents' to refresh preview)..."}
                  className="min-h-[176px] w-full resize-y rounded-[20px] border border-app bg-white px-4 py-3.5 text-sm text-app-primary outline-none transition placeholder:text-app-muted focus:border-app-brand-600 focus:ring-2 focus:ring-app-brand-100"
                />
              </div>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <button
              onClick={async () => {
                if (inputType === 'file' && fileInputs.length > 0 && !documentsProcessed) {
                  await handleProcessDocuments()
                  return
                }
                handleGenerate()
              }}
              data-audit-name={getGenerateButtonLabel()}
              disabled={!isGenerateEnabled || loading || (!isAdminUser && userTokenAllocation > 0 && userTokensUsed >= userTokenAllocation)}
              className={`inline-flex items-center gap-2 rounded-[12px] px-4 py-2.5 text-[13px] font-semibold transition ${
                isGenerateEnabled && !loading && (isAdminUser || userTokenAllocation === 0 || userTokensUsed < userTokenAllocation)
                  ? 'bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] hover:opacity-95'
                  : 'cursor-not-allowed bg-gray-300 text-gray-500'
              } ${loading ? 'blink-bg' : ''}`}
              title={!isAdminUser && userTokenAllocation > 0 && userTokensUsed >= userTokenAllocation ? 'Token allocation limit reached' : ''}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l1.5 3L9 7.5 6.5 9 5 12 3.5 9 1 7.5 3.5 6 5 3zM19 13l1.5 3L23 17.5 20.5 19 19 22 17.5 19 15 17.5 17.5 16 19 13zM12 6l2 4 4 2-4 2-2 4-2-4-4-2 4-2 2-4z" />
              </svg>
              <span className={loading ? 'blink-text' : ''}>{getGenerateButtonLabel()}</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 rounded-[12px] border border-app bg-white px-2.5 py-2 text-app-primary shadow-sm">
              <label className="text-[10px] font-semibold uppercase tracking-[0.16em] text-app-secondary">Environment</label>
              <select
                value={selectedEnvironment}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => setSelectedEnvironment(event.target.value as EnvironmentOption)}
                className="min-w-[88px] bg-transparent text-[13px] font-medium text-app-primary outline-none"
              >
                {environmentOptions.map((option) => (
                  <option key={option.label} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2 rounded-[12px] border border-app bg-white px-2.5 py-2 text-app-primary shadow-sm">
              <label className="text-[10px] font-semibold uppercase tracking-[0.16em] text-app-secondary">Focus</label>
              <select
                value={selectedFocus}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => setSelectedFocus(event.target.value as FocusOption)}
                className="min-w-[96px] bg-transparent text-[13px] font-medium text-app-primary outline-none"
              >
                {focusOptions.map((option) => (
                  <option key={option.label} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>

            <button onClick={handleUseForTestData} data-audit-name="Use for Test Data" disabled={!response} className={`inline-flex items-center gap-2 rounded-[12px] border px-3.5 py-2.5 text-[13px] font-semibold transition ${response ? 'border-app bg-white text-app-primary hover:border-app-brand-100 hover:bg-app-brand-50' : 'cursor-not-allowed border-app bg-white text-app-muted opacity-60'}`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                <ellipse cx="12" cy="5.5" rx="7" ry="2.5"/>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 5.5v6c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5v-6"/>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 11.5v6c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5v-6"/>
              </svg>
              Use for Test Data
            </button>

            {/* <button onClick={exportToExcel} disabled={!response} data-audit-name="Export to Excel" className={`inline-flex items-center gap-2 rounded-[12px] border px-3.5 py-2.5 text-[13px] font-semibold transition ${response ? 'border-app bg-white text-app-primary hover:border-app-brand-100 hover:bg-app-brand-50' : 'cursor-not-allowed border-app bg-white text-app-muted opacity-60'}`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 14L21 3m0 0h-6m6 0v6M21 14v5a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h5"/>
              </svg>
              Export to Excel
            </button> */}

            <ResetButton data-audit-name="Reset" onClick={handleResetAll} disabled={!textValue && fileInputs.length === 0 && !ppmId && !combinedContent && !response && !output && !loading && !sparkImportLoading} className="rounded-[12px] px-3.5 py-2.5 text-[13px]" />
          </div>
        </div>

        {/* Output Section - final generated test cases */}
        <div className="relative overflow-hidden rounded-[20px] border border-app bg-app-surface p-4 shadow-app-card">
          <div className="relative flex items-center justify-between gap-2.5 mb-2">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-app-brand-50 text-app-brand-700">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-4 w-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <div className="text-[15px] font-bold text-app-primary">Output</div>
            </div>

            <button
              type="button"
              onClick={openReviewWindow}
              disabled={!(response || output) || submittedTestCaseCount !== null}
              className={`inline-flex items-center gap-2 rounded-[12px] px-3.5 py-2 text-[12px] font-semibold transition ${submittedTestCaseCount !== null ? 'cursor-not-allowed border-2 border-red-600 bg-white text-red-600 opacity-75' : response || output ? 'bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] hover:opacity-95' : 'cursor-not-allowed bg-gray-300 text-gray-500 opacity-60'}`}
            >
              {submittedTestCaseCount !== null ? `${submittedTestCaseCount} TCs Pending Approval` : 'Review & Send'}
            </button>
          </div>
          <div className="relative mb-3 text-[12px] text-app-secondary">{documentsProcessed && !response ? `Files processed - click "${inputType === 'e2e-spark' ? 'E2E Spark Generate' : 'Generate Test Cases'}" to continue` : 'Generation output will appear here....'}</div>
          {(response || output) && (
            <MarkdownViewer content={response || output || ''} className="min-h-[200px]" />
          )}
        </div>

        </div>{/* closes solutions column */}

      {/* Expanded combined preview modal */}
      {expandedPreview && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/50 p-8" onClick={(e) => { if (e.target === e.currentTarget) setExpandedPreview(false) }}>
          <div className="relative w-full max-w-6xl bg-white rounded-lg shadow-lg overflow-hidden">
            <div className="flex items-center justify-between border-b border-red-100 bg-app-brand-50 px-5 py-3 text-app-brand-800">
              <div className="text-sm font-semibold">Full Preview</div>
              <div className="flex items-center space-x-2">
                <button onClick={() => navigator.clipboard?.writeText(combinedContent || '')} title="Copy combined text" className="text-app-brand-700 hover:text-red-800 p-2">
                   <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16h8M8 12h8M8 8h8M3 5a2 2 0 012-2h10a2 2 0 012 2v14l-4-2-4 2-4-2-4 2V5z"/></svg>
                 </button>
                <button onClick={() => setExpandedPreview(false)} aria-label="Close preview" className="text-app-brand-700 hover:text-red-800 p-2">
                   <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M6.28 5.22a.75.75 0 011.06 0L10 7.88l2.66-2.66a.75.75 0 111.06 1.06L11.06 8.94l2.66 2.66a.75.75 0 11-1.06 1.06L10 10l-2.66 2.66a.75.75 0 11-1.06-1.06L8.94 8.94 6.28 6.28a.75.75 0 010-1.06z" clipRule="evenodd"/></svg>
                 </button>
               </div>
             </div>
            <div className="p-8 max-h-[80vh] overflow-auto">
               {previewContent ? (
                  <MarkdownViewer content={previewContent} className="min-h-[200px]" />
               ) : (
                 <div className="text-sm text-gray-500">No preview available. Click "Process Documents" to generate the preview.</div>
               )}
            </div>
          </div>
        </div>
      )}

      <ReviewAndSendModal
        isOpen={isReviewOpen}
        documents={reviewDocuments}
        tableData={reviewTableData}
        onClose={() => setIsReviewOpen(false)}
        onTableDataChange={handleReviewTableChange}
        onSendForApproval={handleSendForApproval}
      />
      {approvalNotification && (
        <Notification
          message={approvalNotification.message}
          type={approvalNotification.type}
          duration={2000}
          onClose={() => setApprovalNotification(null)}
        />
      )}
      <ChatWindow
        isOpen={isChatOpen}
        onToggle={() => setIsChatOpen(!isChatOpen)}
        messages={chatMessages}
        onAddMessage={handleAddChatMessage}
        onUpdateLastMessage={handleUpdateLastMessage}
        onChatResponse={handleChatResponse}
        currentTab="Test Cases"
        userName={authUser.user?.username || 'User'}
        seedContent={brdContent}
      />
    </div>
  )
}

export default TestCases
