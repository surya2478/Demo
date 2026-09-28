import React, { useState, ChangeEvent, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import '../../styles/animations.css'
import { loadConfigFromServer, getConfig } from '../../config/ai-api'
import MarkdownViewer from '../../components/MarkdownViewer'
import { getTimestampedFilename } from '../../utils/DynamicFileName-DateTime'
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
import Notification from '../../components/Notification'
import { authHeaderFor, isOwnBackend } from '../../utils/trackedFetchWithTokens'
import api from '../../services/api'
import SelectKB, { type KnowledgeBaseOption } from '../../components/test-assistant/SelectKB'
import JourneyBar from '../../components/test-assistant/JourneyBar'
import { CaseGrid, InputSummary, ProgressPanel, parseStreamingCases, removeCasesFromMarkdown } from '../../components/test-assistant/GenerationOutput'
import AIChecksPanel, { isSettled } from '../../components/test-assistant/AIChecksPanel'
import { useConfirm } from '../../components/ui/ConfirmDialog'
import { ProjectChip, ProjectDialog } from '../../components/project/ProjectDetails'
import SessionList from '../../components/project/SessionList'
import { useProject } from '../../context/ProjectContext'
import projectService, { projectLabel, type GenerationSnapshot, type Project, type SessionSummary } from '../../services/projectService'
import StepEditor from '../../components/test-assistant/StepEditor'
import { detectProject } from '../../utils/detectProject'
import aiChecksService, { type CheckBatch, type CheckItem, type EditedStep } from '../../services/aiChecksService'
import { publishTokenUsage } from '../../components/test-assistant/TokenUsageChip'



interface FilePreviewData {
  name: string
  // preview holds HTML for display (DOCX converted HTML or text->HTML)
  preview: string
  // markdown/plain text (normalized) used by MarkdownViewer in expanded modal / processing
  markdown: string
  isDocx: boolean
}

// A document a request carries (brd_document): an upload, a Spark import, or
// the prompt text.
type ReviewDocumentItem = {
  id: string
  name: string
  content: string
  type: 'file' | 'spark'
}

const TestCases: React.FC = () => {
  const navigate = useNavigate()
  const [inputType, setInputType] = useState<'text' | 'file' | 'e2e-spark' | 'figma-pdf'>('text')
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
  const [approvalNotification, setApprovalNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [submittedTestCaseCount, setSubmittedTestCaseCount] = useState<number | null>(null)
  const [workflowStageRequestId, setWorkflowStageRequestId] = useState<string | null>(null)
  // Mandatory before Generate: the cases carry it to Automation, where their
  // scripts run against it and read that environment's Test Data.
  const environmentOptions = [
    { label: 'Select', value: '' },
    { label: 'SIT', value: 'SIT' },
    { label: 'QA', value: 'QA' },
    { label: 'UAT', value: 'UAT' },
    { label: 'RC', value: 'RC' },
    { label: 'Preproduction', value: 'PREPRODUCTION' }
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
  // Shown once Generate was attempted without an environment.
  const [environmentMissing, setEnvironmentMissing] = useState(false)
  // Select KB. Default KB is the default application route (BASE_URL). The
  // other two are served by the admin backend and answered by the Squad KB's
  // model; `knowledgeBase` is the form value the backend expects.
  type KnowledgeBaseChoice = 'default' | 'squad' | 'automation' | 'journey'
  const knowledgeBaseOptions: readonly (KnowledgeBaseOption<KnowledgeBaseChoice> & { knowledgeBase: string })[] = [
    { value: 'default', label: 'Default KB', short: 'Default application', description: 'Generates with the default application, as before', isDefault: true, knowledgeBase: '' },
    { value: 'squad', label: 'Squad KB', short: 'Device Squad', description: "Grounds test cases in the Device Squad's knowledge base", knowledgeBase: 'Device Squad' },
    { value: 'automation', label: 'Automation KB', short: 'App profiles & flows', description: 'Grounds test cases in the application profiles and flows Automation uses', knowledgeBase: 'Automation KB' },
    { value: 'journey', label: 'Journey KB', short: 'Design journeys', description: 'Grounds test cases in the business-designed journeys, screen labels and rules', knowledgeBase: 'Journey KB' }
  ]
  const [selectedKnowledgeBase, setSelectedKnowledgeBase] = useState<KnowledgeBaseChoice>('default')
  const selectedKnowledgeBaseOption = knowledgeBaseOptions.find((option) => option.value === selectedKnowledgeBase) ?? knowledgeBaseOptions[0]

  const sourceOptions = [
    { value: 'text', label: 'Text Input', audit: 'Text Input', icon: 'M4 20h4L19 9l-4-4L4 16z' },
    { value: 'file', label: 'File Upload', audit: 'File Upload', icon: 'M20 12.5l-7.8 7.8a5 5 0 01-7-7L13 5.5a3.3 3.3 0 014.7 4.7L10 18a1.7 1.7 0 01-2.4-2.4l7-7' },
    { value: 'e2e-spark', label: 'From e2e Spark', audit: 'Solution from e2e Spark', icon: 'M13 2.75L6.75 13H11l-1 8.25L17.25 11H13z' },
    { value: 'figma-pdf', label: 'Figma Files (PDF)', audit: 'Figma Files (PDF)', icon: 'M8 3h5a3 3 0 010 6H8zM8 9h5a3 3 0 010 6H8zM8 15h3a3 3 0 11-3 3zM8 3a3 3 0 000 6M8 9a3 3 0 000 6' }
  ] as const

  // Output stays closed until generation starts, then opens; the chevron
  // toggles it once there is something to show.
  const [outputOpen, setOutputOpen] = useState(false)
  // The input area is compact by default; Expand gives it room to edit.
  const [inputExpanded, setInputExpanded] = useState(false)
  // While and after generating, the inputs fold to one line so the output
  // gets the screen; "Show inputs" reopens them.
  const [inputsFolded, setInputsFolded] = useState(false)
  // Progress on the page, replacing the pop-up. Stages advance on what the
  // stream actually does -- there is no server-side stage signal to report.
  const [genStagesDone, setGenStagesDone] = useState(0)
  const [genStartedAt, setGenStartedAt] = useState<number | null>(null)
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [generationError, setGenerationError] = useState('')
  const [generationStopped, setGenerationStopped] = useState(false)
  const [showFullTable, setShowFullTable] = useState(false)
  const stopRequestedRef = useRef(false)
  // AI Checks (screen 3): Refine -> Review -> Improve -> Classify, before approval.
  const [aiBatchId, setAiBatchId] = useState<string | null>(null)
  const [aiBatch, setAiBatch] = useState<CheckBatch | null>(null)
  const [aiStarting, setAiStarting] = useState(false)
  const [aiError, setAiError] = useState('')
  const [aiSelected, setAiSelected] = useState<Set<number>>(() => new Set())
  const [aiEditing, setAiEditing] = useState<number | null>(null)
  const [aiSaving, setAiSaving] = useState(false)
  const [aiEditError, setAiEditError] = useState('')
  const aiAutoSelectedRef = useRef<Set<number>>(new Set())
  const [aiBusy, setAiBusy] = useState<'stop' | 'restart' | 'delete' | null>(null)
  // Save & Run AI Checks saves the generated cases as a request first; Send
  // for Approval later sends that same request. Saved test_case_id by the
  // case's Test Case ID, so each sent row updates its own saved row.
  const [savedRequestId, setSavedRequestIdState] = useState<string | null>(null)
  // The id is needed straight after it is set (save, then start the checks).
  const savedRequestIdRef = useRef<string | null>(null)
  const setSavedRequestId = (id: string | null) => {
    savedRequestIdRef.current = id
    setSavedRequestIdState(id)
  }
  const savedCaseIdsRef = useRef<Map<string, string>>(new Map())
  // Checks already sent; Send for Approval can run again for the rest.
  const [aiSentIds, setAiSentIds] = useState<Set<number>>(() => new Set())
  // --- Project and saved sessions --------------------------------------------
  // Generated cases are saved as a session the moment generation ends, under
  // the current project, and the page reopens the latest unfinished one when
  // it is opened with nothing on it.
  const { project, setProject } = useProject()
  // Read at save time: Generate may be clicked in the same moment a project is
  // chosen, before a re-render has put it in this render's closure.
  const projectRef = useRef<Project | null>(project)
  projectRef.current = project
  const [projectDialog, setProjectDialog] = useState<null | 'gate' | 'edit'>(null)
  const projectSkippedRef = useRef(false)
  // A project nobody picked by hand is taken from the BRD: saved when it names
  // a PPM ID, else its name waits in the dialog for one. Picking or correcting
  // a project by hand ends this, so a BRD never overrides a choice.
  // Remembered with the project, so a reload still knows it came from a BRD.
  const [projectFromBrd, setProjectFromBrdState] = useState(() => {
    try { return Boolean(project) && localStorage.getItem('current_project_from_brd') === String(project?.id) } catch { return false }
  })
  const projectFromBrdRef = useRef(projectFromBrd)
  const setProjectFromBrd = (fromBrd: boolean, id?: number) => {
    projectFromBrdRef.current = fromBrd
    setProjectFromBrdState(fromBrd)
    try {
      if (fromBrd && id != null) localStorage.setItem('current_project_from_brd', String(id))
      else localStorage.removeItem('current_project_from_brd')
    } catch { /* storage unavailable */ }
  }
  const [brdProjectName, setBrdProjectName] = useState('')
  const brdDetectedForRef = useRef('')
  // File Upload and Figma pick and process documents in a window, so the
  // page keeps its full width for the document preview.
  const [uploadOpen, setUploadOpen] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [restoredDocumentNames, setRestoredDocumentNames] = useState<string[]>([])
  const restoreTriedRef = useRef(false)
  // Generated cases ticked in the grid, by Test Case ID: AI Checks run on
  // these (or on all when none are ticked), and Delete removes them.
  const [gridSelected, setGridSelected] = useState<Set<string>>(() => new Set())
  const confirm = useConfirm()
  // Which check each sent row came from, by Test Case ID. Kept out of the rows
  // themselves so the Review & Send table shows only the case's own columns;
  // the server reads the check's results from this id (never scores we send).
  const aiCheckIdsRef = useRef<Map<string, number>>(new Map())
  const streamReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)

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
  const [isGenerationStreaming, setIsGenerationStreaming] = useState(false)
  const generationStreamRef = useRef<HTMLDivElement | null>(null)
  const { runAIAction } = useAIAction()
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
    } else if (inputType === 'file' || inputType === 'figma-pdf') {
      setIsGenerateEnabled(fileInputs.length > 0)
    } else {
      setIsGenerateEnabled(combinedContent.trim().length > 0 && sparkStorageKey.trim().length > 0)
    }
  }, [inputType, textValue, fileInputs, combinedContent, sparkStorageKey])

  useEffect(() => {
    if (isGenerationStreaming && generationStreamRef.current) {
      generationStreamRef.current.scrollTop = generationStreamRef.current.scrollHeight
    }
  }, [response, isGenerationStreaming])

  // Normalize text: collapse excessive whitespace, trim lines, collapse multiple blank lines
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
    if (inputType === 'file' || inputType === 'figma-pdf') {
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

    if ((inputType === 'file' || inputType === 'figma-pdf') && fileInputs.length > 0) {
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

  const getWorkflowDocumentName = () => {
    if (inputType === 'text') return 'Text Input BRD'
    if (inputType === 'e2e-spark') return ppmId.trim() || sparkStorageKey || 'E2E Spark Document'
    return fileInputs.map((file) => file.name).join(' | ') || 'Uploaded BRD'
  }

  const startWorkflow = async (documentName: string, stages: Record<string, string>, existingFlowId?: string | null) => {
    const stageRequestId = existingFlowId || workflowStageRequestId || `FLOW-${crypto.randomUUID()}`
    // Progress tracking only. A tracker that cannot be reached must never stop
    // a generation or an approval, so its failure is logged and swallowed.
    try {
      await api.post(`/test-case-workflows/${encodeURIComponent(stageRequestId)}/start`, {
        document_name: documentName,
        stages
      })
    } catch (error) {
      console.warn('[TestCases] Workflow tracker unavailable; continuing without it:', error)
    }
    setWorkflowStageRequestId(stageRequestId)
    window.dispatchEvent(new CustomEvent('test-case-workflow-updated', {
      detail: { stageRequestId, documentName }
    }))
    return stageRequestId
  }

  const handleSendForApproval = async (rows: Record<string, string>[], documents: ReviewDocumentItem[] = getReviewDocuments()) => {
    try {
      // The request Save & Run AI Checks saved, when there is one.
      const requestId = savedRequestId || `REQ-${Date.now()}`
      const requestBy = (authUser.user as any)?.username || (authUser.user as any)?.email || 'system'
      const documentId = getApprovalDocumentId(documents)
      const stageRequestId = workflowStageRequestId || requestId
      const uniqueRows = deduplicateTestCases(rows).map((row, index) => {
        const baseId = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : `TC-${index + 1}`
        const savedId = savedCaseIdsRef.current.get(String((row as Record<string, string>)['Test Case ID'] ?? '').trim())
        const id = savedId || `${requestId}-TC-${savedRequestId ? `S${index + 1}` : index + 1}`
        return {
          ...row,
          id,
          test_case_id: id,
          sourceRowId: baseId
        }
      })

      const payload = {
        request_id: requestId,
        stage_request_id: stageRequestId,
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
          test_case_details: {
            ...row,
            ...(aiCheckIdsRef.current.has(String((row as Record<string, string>)['Test Case ID'] ?? ''))
              ? { _ai_check_id: aiCheckIdsRef.current.get(String((row as Record<string, string>)['Test Case ID'] ?? '')) }
              : {})
          },
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
      window.dispatchEvent(new CustomEvent('test-case-workflow-updated', {
        detail: { stageRequestId, documentName: getWorkflowDocumentName() }
      }))
      const sentChecks = uniqueRows
        .map((row) => aiCheckIdsRef.current.get(String((row as Record<string, string>)['Test Case ID'] ?? '')))
        .filter((id): id is number => id !== undefined)
      if (sentChecks.length) {
        setAiSentIds((current) => new Set([...Array.from(current), ...sentChecks]))
        setAiSelected((current) => new Set(Array.from(current).filter((id) => !sentChecks.includes(id))))
      }
      setSubmittedTestCaseCount((current) => (current ?? 0) + uniqueRows.length)
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
      await startWorkflow(trimmedPpmId, {
        PROCESS_DOCUMENT: 'COMPLETED',
        GENERATE_TEST_CASES: 'PENDING',
        REVIEW_APPROVAL: 'PENDING',
        AUTOMATION_REVIEW: 'PENDING',
        AUTOMATION_EXECUTION: 'PENDING'
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to import SSD content'
      setSparkImportError(msg)
      setDocumentsProcessed(false)
    } finally {
      setSparkImportLoading(false)
    }
  }

  const handleProcessFigmaPdf = async () => {
    if (fileInputs.length === 0) return

    await runAIAction({
      actionName: 'extract_figma_pdf_text',
      actionLabel: 'Extracting Figma PDF Text',
      artifactType: 'Figma PDF Text',
      stages: [
        'Uploading Figma PDF',
        'Reading visual pages with GPT-5.1',
        'Extracting visible labels and requirements',
        'Preparing editable text'
      ],
      successMessage: 'Figma PDF text extracted successfully.',
      retryAction: handleProcessFigmaPdf,
      execute: async () => {
        setLoading(true)
        setResponse('')
        try {
          const formData = new FormData()
          formData.append('file', fileInputs[0])
          const result = await api.post<{ text: string }>('/generate/figma/extract-text', formData, {
            headers: { 'Content-Type': 'multipart/form-data' }
          })
          const extractedText = normalizeText(result.data?.text || '')
          if (!extractedText) {
            throw new Error('GPT-5.1 returned no readable text from the Figma PDF')
          }

          setCombinedContent(extractedText)
          setCombinedPreviewHtml(textToHtml(extractedText))
          setDocumentsProcessed(true)
          setNeedsReprocess(false)
          await startWorkflow(getWorkflowDocumentName(), {
            PROCESS_DOCUMENT: 'COMPLETED',
            GENERATE_TEST_CASES: 'PENDING',
            REVIEW_APPROVAL: 'PENDING',
            AUTOMATION_REVIEW: 'PENDING',
            AUTOMATION_EXECUTION: 'PENDING'
          })
        } finally {
          setLoading(false)
        }
      }
    })
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
      // Deliberately independent of Select KB. Generation and extraction are
      // two different jobs with two different best homes, and the whole point
      // of Select KB is that they can diverge:
      //
      //   generation  -> the admin backend for Squad KB and Automation KB,
      //                  which only it can ground a prompt with.
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
          await startWorkflow(getWorkflowDocumentName(), {
            PROCESS_DOCUMENT: 'COMPLETED',
            GENERATE_TEST_CASES: 'PENDING',
            REVIEW_APPROVAL: 'PENDING',
            AUTOMATION_REVIEW: 'PENDING',
            AUTOMATION_EXECUTION: 'PENDING'
          })
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

    const flowId = await startWorkflow(getWorkflowDocumentName(), {
      PROCESS_DOCUMENT: 'COMPLETED',
      GENERATE_TEST_CASES: 'ACTIVE',
      REVIEW_APPROVAL: 'PENDING',
      AUTOMATION_REVIEW: 'PENDING',
      AUTOMATION_EXECUTION: 'PENDING'
    })
    
    await runAIAction({
      actionName: 'generate_test_cases',
      showModal: false,
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
        setIsGenerationStreaming(true)
        setResponse('');
        setOutput('');
        setInputsFolded(true)
        setOutputOpen(true)
        setShowFullTable(false)
        setGenerationError('')
        setGenerationStopped(false)
        setGenStagesDone(0)
        setGenStartedAt(Date.now())
        stopRequestedRef.current = false
        clearAiChecks()
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
            if ((inputType === 'file' || inputType === 'figma-pdf') && fileInputs.length > 0) {
              return combinedContent && combinedContent.trim().length > 0 ? combinedContent : ''
            }
            if (inputType === 'e2e-spark') {
              return combinedContent && combinedContent.trim().length > 0 ? combinedContent : ''
            }
            return ''
          })()

          const promptText = buildPromptTextWithSelection(sourceText)
          formData.append('text', promptText)
          if (selectedKnowledgeBaseOption.knowledgeBase) {
            formData.append('knowledge_base', selectedKnowledgeBaseOption.knowledgeBase)
          }
          if (inputType === 'figma-pdf') {
            formData.append('generation_mode', 'figma_pdf')
          }
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

      // Squad KB and Automation KB exist only on the admin backend, so they go
      // there whatever BASE_URL says. Default KB is the default application
      // route and keeps using BASE_URL.
      const generationBackendUrl = String((import.meta as any).env?.VITE_API_URL || 'http://localhost:8002').replace(/\/$/, '')
      const generationUrl = selectedKnowledgeBaseOption.knowledgeBase
        ? `${generationBackendUrl}/generate/kb-testcases`
        : `${config.BASE_URL}${config.ENDPOINTS.generateTestCases}`
      // Call tracked fetch but handle streaming locally
      const { response: res, status, logId } = await trackedFetchWithTokens(
        generationUrl,
        {
          tab: 'testcases',
          method: 'POST',
          body: formData,
          user: userAuth.user?.username || 'anonymous',
          sessionId: sessionStorage.getItem('client_session_id') || undefined,
          externalStream: true
        }
      );
      setGenStagesDone(1)
      // Stream and accumulate response here
      if (!res.body) {
        fullText = await res.text();
      } else {
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        streamReaderRef.current = reader
        const decoder = new TextDecoder();
        fullText = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const streamedChunk = chunk.replace(/^data: /, '');
            setResponse(prev => prev + streamedChunk)
            fullText += streamedChunk;
            // Scope is understood once text arrives, scenarios once the table
            // header is written; rows then stream as "Generating test cases".
            setGenStagesDone(prev => Math.max(prev, /test case id/i.test(fullText) ? 3 : 2))
          }
        } finally {
          streamReaderRef.current = null
        }
      }
      setGenStagesDone(4)
      if (stopRequestedRef.current) setGenerationStopped(true)

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

      setGenStagesDone(5)
      if (fullText && fullText.trim().length > 0) {
        setTestCasesData(fullText);
        await autosaveGeneration(fullText, stopRequestedRef.current)
        await startWorkflow(getWorkflowDocumentName(), {
          PROCESS_DOCUMENT: 'COMPLETED',
          GENERATE_TEST_CASES: 'COMPLETED',
          REVIEW_APPROVAL: 'ACTIVE',
          AUTOMATION_REVIEW: 'PENDING',
          AUTOMATION_EXECUTION: 'PENDING'
        }, flowId)
      }

          setGenStagesDone(6)
        } catch (err) {
          console.error('Generation error:', err);
          setGenerationError(err instanceof Error ? err.message : String(err))
          // setError(`Error generating test cases: ${err instanceof Error ? err.message : String(err)}`);
          auditStatus = 'failure';
          responsePayload = String(err);
          throw err;

        } finally {
          setLoading(false);
          setIsGenerationStreaming(false)
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

  function clearAiChecks() {
    setAiBatchId(null)
    setAiBatch(null)
    setAiError('')
    setAiSelected(new Set())
    setAiBusy(null)
    setSavedRequestId(null)
    savedCaseIdsRef.current = new Map()
    setAiSentIds(new Set())
    setAiEditing(null)
    setAiEditError('')
    aiAutoSelectedRef.current = new Set()
  }

  // Same rows Review & Send uses, so the checks start from exactly the table
  // the author sees.
  const handleRunAiChecks = async () => {
    const allRows = extractAndConsolidateTestCases(response || output || '').rows
    const idOf = (row: Record<string, string>) =>
      String(Object.entries(row).find(([key]) => /test\s*case\s*id/i.test(key))?.[1] ?? '').trim()
    const rows = gridSelected.size ? allRows.filter((row) => gridSelected.has(idOf(row))) : allRows
    if (!rows.length) {
      setAiError('No test cases were found in the output to check.')
      return
    }
    setAiStarting(true)
    setAiError('')
    try {
      // 1. Save: the generated cases are on record before any check runs.
      //    Skipped when an earlier attempt saved them and only the checks failed.
      if (!savedRequestIdRef.current) {
        const saved = await saveGeneratedCases(allRows)
        if (!saved) return
      }
      // 2. AI Checks.
      const batchId = await aiChecksService.start(rows, selectedKnowledgeBaseOption.knowledgeBase || undefined, savedRequestIdRef.current || undefined, selectedEnvironment || undefined)
      setAiBatchId(batchId)
      setAiBatch(await aiChecksService.get(batchId))
    } catch (error: any) {
      setAiError(error?.response?.data?.detail || error?.message || 'AI Checks could not be started.')
    } finally {
      setAiStarting(false)
    }
  }

  const generationSnapshot = (outputText: string, stopped = false): GenerationSnapshot => ({
    output: outputText,
    input_type: inputType,
    knowledge_base: selectedKnowledgeBase,
    knowledge_base_label: selectedKnowledgeBaseOption.label,
    environment: selectedEnvironment || '',
    focus: selectedFocus || '',
    document_text: inputType === 'text' ? '' : combinedContent,
    document_names: fileInputs.map((file) => file.name),
    text_input: inputType === 'text' ? textValue : '',
    ppm_id: inputType === 'e2e-spark' ? ppmId.trim() : '',
    stopped
  })

  // Called when generation ends (finished or stopped), so nothing generated
  // exists only in this browser tab.
  const autosaveGeneration = async (outputText: string, stopped: boolean) => {
    const rows = extractAndConsolidateTestCases(outputText).rows
    if (!rows.length) return
    const saved = await saveGeneratedCases(rows, generationSnapshot(outputText, stopped))
    if (saved) setApprovalNotification({ message: `${rows.length} test case${rows.length === 1 ? '' : 's'} saved${projectRef.current ? ` to ${projectRef.current.ppm_id}` : ''}`, type: 'success' })
  }

  const saveGeneratedCases = async (rows: Record<string, string>[], generation?: GenerationSnapshot): Promise<boolean> => {
    const requestId = `REQ-${Date.now()}`
    const requestBy = (authUser.user as any)?.username || (authUser.user as any)?.email || 'system'
    const documents = getReviewDocuments()
    const ids = new Map<string, string>()
    const saveRows = rows.map((row, index) => {
      const testCaseId = `${requestId}-TC-${index + 1}`
      ids.set(String(row['Test Case ID'] ?? '').trim(), testCaseId)
      return {
        test_case_id: testCaseId,
        request_id: requestId,
        test_case_details: { ...row, id: testCaseId },
        status: 'DRAFT',
        generated_by: requestBy
      }
    })
    try {
      await api.post('/test-case-reviews/save', {
        request_id: requestId,
        stage_request_id: workflowStageRequestId || requestId,
        source: inputType === 'e2e-spark' ? 'AZURE_DEVOPS' : inputType.toUpperCase(),
        request_by: requestBy,
        request_date_time: new Date().toISOString(),
        document_id: getApprovalDocumentId(documents),
        brd_document: documents,
        rows: saveRows,
        project_id: projectRef.current?.id ?? null,
        generation: generation ?? generationSnapshot(response || output || '')
      })
      savedCaseIdsRef.current = ids
      setSavedRequestId(requestId)
      return true
    } catch (error: any) {
      setAiError(`The test cases could not be saved. ${error?.response?.data?.detail || error?.message || ''}`.trim())
      return false
    }
  }

  const refreshAiBatch = async (batchId: string) => {
    try {
      const batch = await aiChecksService.get(batchId)
      setAiBatch(batch)
      // Select each case once, as it finishes; a case the author unticks stays unticked.
      const fresh = batch.items.filter((item) => item.status === 'done' && !aiAutoSelectedRef.current.has(item.check_id))
      if (fresh.length) {
        fresh.forEach((item) => aiAutoSelectedRef.current.add(item.check_id))
        setAiSelected((current) => {
          const next = new Set(current)
          fresh.forEach((item) => next.add(item.check_id))
          return next
        })
      }
      // Only a case nothing is working on can stay selected (Send takes the
      // finished ones; Delete and Restart the rest too).
      setAiSelected((current) => {
        const present = new Map(batch.items.map((item) => [item.check_id, item]))
        const drop = Array.from(current).filter((id) => !present.has(id) || !isSettled(present.get(id)!))
        if (!drop.length) return current
        const next = new Set(current)
        drop.forEach((id) => next.delete(id))
        return next
      })
    } catch (error) {
      console.warn('[TestCases] Could not refresh AI Checks:', error)
    }
  }

  const handleAiRetry = async (checkId: number) => {
    if (!aiBatchId) return
    try {
      await aiChecksService.retry(aiBatchId, checkId)
      aiAutoSelectedRef.current.delete(checkId)
      await refreshAiBatch(aiBatchId)
    } catch (error: any) {
      setAiError(error?.response?.data?.detail || 'Retry could not be started.')
    }
  }

  const handleAiStop = async () => {
    if (!aiBatchId) return
    setAiBusy('stop')
    try {
      await aiChecksService.stop(aiBatchId)
      await refreshAiBatch(aiBatchId)
    } catch (error: any) {
      setAiError(error?.response?.data?.detail || 'AI Checks could not be stopped.')
    } finally {
      setAiBusy(null)
    }
  }

  const handleAiRestart = async () => {
    if (!aiBatchId || !aiBatch) return
    setAiBusy('restart')
    setAiError('')
    try {
      await aiChecksService.restart(aiBatchId)
      aiBatch.items
        .filter((item) => item.status === 'stopped' || item.status === 'failed')
        .forEach((item) => aiAutoSelectedRef.current.delete(item.check_id))
      await refreshAiBatch(aiBatchId)
    } catch (error: any) {
      setAiError(error?.response?.data?.detail || 'AI Checks could not be restarted.')
    } finally {
      setAiBusy(null)
    }
  }

  const handleAiDelete = async () => {
    if (!aiBatchId || !aiBatch) return
    const chosen = aiBatch.items.filter((item) => aiSelected.has(item.check_id) && isSettled(item))
    if (!chosen.length) return
    const count = chosen.length
    const everything = count === aiBatch.items.length
    const ok = await confirm({
      title: count === 1 ? `Delete ${chosen[0].display_id}?` : `Delete ${count} test cases?`,
      body: count === 1 ? chosen[0].title ?? '' : `${count} selected test cases will be removed from these AI Checks results.`,
      consequences: [
        'Their AI Checks results and refined steps are deleted too.',
        everything ? 'That is every case here, so the AI Checks results close.' : 'The other cases are not affected.',
        'This cannot be undone.'
      ],
      confirmLabel: count === 1 ? 'Delete test case' : `Delete ${count} test cases`
    })
    if (!ok) return
    setAiBusy('delete')
    setAiError('')
    try {
      await aiChecksService.remove(aiBatchId, chosen.map((item) => item.check_id))
      if (savedRequestId) {
        const savedIds = chosen
          .map((item) => savedCaseIdsRef.current.get(String(item.display_id || item.source_row['Test Case ID'] || '').trim()))
          .filter((id): id is string => Boolean(id))
        if (savedIds.length) {
          await api.post(`/test-case-reviews/saved/${encodeURIComponent(savedRequestId)}/remove`, { test_case_ids: savedIds })
        }
      }
      if (everything) {
        clearAiChecks()
      } else {
        setAiSelected((current) => {
          const next = new Set(current)
          chosen.forEach((item) => next.delete(item.check_id))
          return next
        })
        await refreshAiBatch(aiBatchId)
      }
    } catch (error: any) {
      setAiError(error?.response?.data?.detail || 'The test cases could not be deleted.')
    } finally {
      setAiBusy(null)
    }
  }

  // Delete in the generated grid edits the output itself, so the full table,
  // Use for Test Data, downloads and AI Checks all see the same cases.
  const handleDeleteGenerated = async () => {
    const ids = streamParse.cases.filter((item) => gridSelected.has(item.id))
    if (!ids.length) return
    const count = ids.length
    const ok = await confirm({
      title: count === 1 ? `Delete ${ids[0].id}?` : `Delete ${count} test cases?`,
      body: count === 1 ? ids[0].title : `${count} selected test cases will be removed from the generated output.`,
      consequences: ['Generate again to get them back.'],
      confirmLabel: count === 1 ? 'Delete test case' : `Delete ${count} test cases`
    })
    if (!ok) return
    const drop = new Set(ids.map((item) => item.id))
    const next = removeCasesFromMarkdown(response || output || '', drop)
    if (response) setResponse(next)
    else setOutput(next)
    setGridSelected(new Set())
    if (savedRequestId) {
      const savedIds = ids.map((item) => savedCaseIdsRef.current.get(item.id)).filter((id): id is string => Boolean(id))
      try {
        if (savedIds.length) await api.post(`/test-case-reviews/saved/${encodeURIComponent(savedRequestId)}/remove`, { test_case_ids: savedIds })
        await projectService.updateSession(savedRequestId, { generation: { output: next } })
      } catch (error: any) {
        setAiError(`Removed here, but the saved session could not be updated. ${error?.response?.data?.detail || ''}`.trim())
      }
    }
  }

  const restoreSession = async (requestId: string) => {
    try {
      const session = await projectService.session(requestId)
      const g = session.generation || {}
      clearAiChecks()
      setResponse(g.output || '')
      setOutput('')
      const types = ['text', 'file', 'e2e-spark', 'figma-pdf'] as const
      setInputType((types as readonly string[]).includes(g.input_type || '') ? (g.input_type as typeof types[number]) : 'text')
      setTextValue(g.text_input || '')
      setCombinedContent(g.document_text || '')
      setRestoredDocumentNames(g.document_names || [])
      if (g.ppm_id) setPpmId(g.ppm_id)
      if (knowledgeBaseOptions.some((option) => option.value === g.knowledge_base)) setSelectedKnowledgeBase(g.knowledge_base as KnowledgeBaseChoice)
      setSelectedEnvironment((g.environment || '') as EnvironmentOption)
      setSelectedFocus((g.focus || '') as FocusOption)
      setGenerationError('')
      setGenerationStopped(Boolean(g.stopped))
      setGenStagesDone(6)
      setInputsFolded(true)
      setOutputOpen(true)
      setShowFullTable(false)
      if (session.project && session.project.id !== projectRef.current?.id) setProject(session.project)
      setSavedRequestId(session.request_id)
      savedCaseIdsRef.current = new Map(session.rows.map((row) => [row.display_id, row.test_case_id] as [string, string]))
      const sentRows = session.rows.filter((row) => row.status !== 'DRAFT').length
      setSubmittedTestCaseCount(sentRows > 0 ? sentRows : null)
      if (session.ai_batch_id) {
        const batch = await aiChecksService.get(session.ai_batch_id)
        const sent = batch.items.filter((item) => item.sent).map((item) => item.check_id)
        // A reopened session starts with its finished, unsent cases ticked.
        aiAutoSelectedRef.current = new Set(batch.items.filter((item) => item.status === 'done').map((item) => item.check_id))
        aiCheckIdsRef.current = new Map(batch.items.map((item) => [String(item.display_id || item.source_row['Test Case ID'] || ''), item.check_id] as [string, number]))
        setAiSentIds(new Set(sent))
        setAiSelected(new Set(batch.items.filter((item) => item.status === 'done' && !item.sent).map((item) => item.check_id)))
        setAiBatchId(session.ai_batch_id)
        setAiBatch(batch)
      }
      try { sessionStorage.removeItem('ta_closed_session') } catch { /* storage unavailable */ }
    } catch (error: any) {
      setAiError(error?.response?.data?.detail || 'The saved session could not be opened.')
    }
  }

  const handleAiSaveSteps = async (steps: EditedStep[]) => {
    if (!aiBatchId || aiEditing === null) return
    setAiSaving(true)
    setAiEditError('')
    try {
      await aiChecksService.saveSteps(aiBatchId, aiEditing, steps)
      setAiEditing(null)
      await refreshAiBatch(aiBatchId)
    } catch (error: any) {
      setAiEditError(error?.response?.data?.detail || 'The steps could not be saved.')
    } finally {
      setAiSaving(false)
    }
  }

  // The improved text is what goes for approval, not the text as generated.
  const checkedRow = (item: CheckItem): Record<string, string> => {
    const steps = (item.steps_structured ?? []).map((step) => `${step.step_number}. ${step.action}`).join(' ')
    return {
      ...item.source_row,
      'Test Case ID': item.display_id || item.source_row['Test Case ID'] || '',
      'Test Case Description': item.title || item.source_row['Test Case Description'] || '',
      Preconditions: item.preconditions || 'None',
      'Test Steps': steps || item.source_row['Test Steps'] || '',
      'Test Data': item.test_data || item.source_row['Test Data'] || 'None',
      'Expected Result': item.expected_result || item.source_row['Expected Result'] || ''
    }
  }

  const aiSendable = aiBatch ? aiBatch.items.filter((item) => item.status === 'done' && aiSelected.has(item.check_id) && !aiSentIds.has(item.check_id)) : []

  // The AI Checks results are the review: cases go straight to the manager,
  // not through the old Review & Send table, and a manager lands on Review &
  // Approval to decide them.
  const handleAiSend = async () => {
    if (!aiSendable.length) return
    const count = aiSendable.length
    const automation = aiSendable.filter((item) => item.classification === 'automation').length
    const dataPending = aiSendable.filter((item) => item.test_data_pending).length
    const ok = await confirm({
      title: `Send ${count} test case${count === 1 ? '' : 's'} for approval?`,
      body: `${automation} Automation · ${count - automation} Manual${projectRef.current ? ` · ${projectLabel(projectRef.current)}` : ''}`,
      consequences: [
        'The manager sees each case with its AI Checks results and can approve or reject it.',
        ...(dataPending ? [`${dataPending} still ${dataPending === 1 ? 'needs' : 'need'} test data; they are flagged for the manager.`] : []),
        'Approved Automation cases go on to Automation Lab.'
      ],
      confirmLabel: `Send ${count} for Approval`
    })
    if (!ok) return
    aiCheckIdsRef.current = new Map(
      aiSendable.map((item) => [String(item.display_id || item.source_row['Test Case ID'] || ''), item.check_id] as [string, number])
    )
    // A saved session already holds its documents; sending them again would
    // replace the uploaded files' record with whatever this page still has.
    const sent = await handleSendForApproval(aiSendable.map(checkedRow), savedRequestIdRef.current ? [] : getReviewDocuments())
    if (!sent) return
    const roles: string[] = ([] as string[]).concat((authUser.user as any)?.roles ?? [])
    if (roles.some((role) => role === 'manager' || role === 'admin')) navigate('/manager-review')
  }

  const handleAiDownload = () => {
    if (!aiBatch) return
    const header = ['Test Case ID', 'Title', 'Status', 'Classification', 'Quality before', 'Quality after', 'Improved by AI', 'Test data pending', 'Note']
    const quote = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
    const lines = aiBatch.items.map((item) => [
      item.display_id, item.title, item.status === 'failed' ? 'Not checked' : item.status,
      item.classification ?? '', item.score_before ?? '', item.score_after ?? '',
      item.improved ? 'Yes' : 'No', item.test_data_pending ? 'Yes' : 'No',
      item.status === 'failed' ? item.error : item.classification_reason
    ].map(quote).join(','))
    const blob = new Blob([[header.map(quote).join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `ai-checks-${aiBatch.batch_id}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  // Stop keeps what was written so far: cancelling the reader ends the stream
  // loop normally, so the partial table is stored and can still be sent.
  const handleStopGeneration = () => {
    stopRequestedRef.current = true
    void streamReaderRef.current?.cancel().catch(() => undefined)
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
    // Reset closes the session on this page; it stays saved and listed.
    try { if (savedRequestId) sessionStorage.setItem('ta_closed_session', savedRequestId) } catch { /* storage unavailable */ }
    setRestoredDocumentNames([])
    clearAiChecks()
    setOutputOpen(false)
    setInputsFolded(false)
    setGenerationError('')
    setGenerationStopped(false)
    setGenStagesDone(0)
    setShowFullTable(false)
    setInputExpanded(false)
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
    setIsGenerationStreaming(false)
    setUploadOpen(false)
    // A project taken from the BRD goes with it; one picked by hand stays.
    if (projectFromBrdRef.current) {
      setProject(null)
      projectRef.current = null
      setProjectFromBrd(false)
    }
    setBrdProjectName('')
    brdDetectedForRef.current = ''
    setWorkflowStageRequestId(null)
    setSelectedKnowledgeBase('default')
    window.dispatchEvent(new CustomEvent('test-case-workflow-updated'))
  }

  // Takes the project from the BRD's text unless one was picked by hand. True
  // when a project was saved from it; a BRD without a PPM ID only leaves its
  // name for the dialog.
  const applyBrdProject = async (text: string, fileNames: string[]): Promise<boolean> => {
    if (projectRef.current && !projectFromBrdRef.current) return false
    const found = detectProject(text, fileNames)
    setBrdProjectName(found.name || '')
    if (!found.ppmId) {
      // The last BRD's project does not belong to this one.
      if (projectFromBrdRef.current) {
        setProject(null)
        projectRef.current = null
        setProjectFromBrd(false)
      }
      return false
    }
    try {
      const chosen = await projectService.createOrOpen(found.ppmId, found.name || found.ppmId)
      setProject(chosen)
      projectRef.current = chosen
      projectSkippedRef.current = false
      setProjectFromBrd(true, chosen.id)
      setApprovalNotification({
        message: `Project ${chosen.existing ? 'found' : 'saved'} from the BRD: ${projectLabel(chosen)}. Click it to correct it.`,
        type: 'success'
      })
      return true
    } catch {
      return false
    }
  }

  // Once documents are processed, read the project from them.
  useEffect(() => {
    if (!documentsProcessed || (inputType !== 'file' && inputType !== 'figma-pdf') || fileInputs.length === 0) return
    const key = fileInputs.map((file) => `${file.name}:${file.size}`).join('|')
    if (!combinedContent.trim() || brdDetectedForRef.current === key) return
    brdDetectedForRef.current = key
    void applyBrdProject(combinedContent, fileInputs.map((file) => file.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentsProcessed, inputType, fileInputs])

  // A project is asked for before generating -- from the BRD first, then the
  // author, who may go on without.
  const requestGenerate = async () => {
    if (!selectedEnvironment) {
      setEnvironmentMissing(true)
      return
    }
    if (!projectRef.current && !projectSkippedRef.current) {
      const text = inputType === 'text' ? textValue : combinedContent
      if (await applyBrdProject(text, fileInputs.map((file) => file.name))) {
        void handleGenerate()
        return
      }
      setProjectDialog('gate')
      return
    }
    void handleGenerate()
  }

  const handleProjectChosen = (chosen: Project | null) => {
    const gate = projectDialog === 'gate'
    setProjectDialog(null)
    if (chosen) {
      setProject(chosen)
      projectRef.current = chosen
      projectSkippedRef.current = false
      setProjectFromBrd(false)
    } else {
      projectSkippedRef.current = true
    }
    if (gate) void handleGenerate()
  }

  const getGenerateButtonLabel = () => {
    if (inputType === 'e2e-spark') {
      return loading ? 'Generating...' : 'E2E Spark Generate'
    }
    if (loading) return 'Generating...'
    if ((inputType === 'file' || inputType === 'figma-pdf') && fileInputs.length > 0 && !documentsProcessed) {
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
    value: 'text' | 'file' | 'e2e-spark' | 'figma-pdf'
    label: string
    description: string
  }> = [
    { value: 'text', label: 'Text Input', description: 'Paste BRD or solution text directly.' },
    { value: 'file', label: 'File Upload', description: 'Bring in documents and process them in place.' },
    { value: 'e2e-spark', label: 'From e2e Spark', description: 'Import SSD content using a PPM identifier.' },
    { value: 'figma-pdf', label: 'Figma Files (PDF)', description: 'Upload Figma design exports as PDF.' }
  ]



  const tokenLimitReached = !isAdminUser && userTokenAllocation > 0 && userTokensUsed >= userTokenAllocation
  const hasOutput = isGenerationStreaming || Boolean(response || output)
  const streamParse = useMemo(
    () => parseStreamingCases(response || output || '', !isGenerationStreaming),
    [response, output, isGenerationStreaming]
  )

  useEffect(() => {
    setGridSelected((current) => {
      if (!current.size) return current
      const present = new Set(streamParse.cases.map((item) => item.id))
      const next = new Set(Array.from(current).filter((id) => present.has(id)))
      return next.size === current.size ? current : next
    })
  }, [streamParse.cases])

  // Poll while any case is still being checked; the job runs on the server
  // and its progress lives in the database.
  const aiRunning = Boolean(aiBatch && aiBatch.items.some((item) => item.status === 'queued' || item.status === 'running'))
  useEffect(() => {
    if (!aiBatchId || (aiBatch && !aiRunning)) return
    const id = window.setInterval(() => void refreshAiBatch(aiBatchId), 2500)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiBatchId, aiRunning])

  useEffect(() => {
    if (!aiRunning) return
    setNowTick(Date.now())
    const id = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [aiRunning])

  useEffect(() => {
    if (!isGenerationStreaming) return
    setNowTick(Date.now())
    const id = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [isGenerationStreaming])

  const currentUsername = String((authUser.user as any)?.username || '')
  const showEmptyOutput = !aiBatch && !hasOutput && !generationError

  useEffect(() => {
    if (!showEmptyOutput) return
    let cancelled = false
    setSessionsLoading(true)
    projectService.sessions({ projectId: project?.id ?? null, limit: 8 })
      .then((items) => { if (!cancelled) setSessions(items) })
      .catch(() => { if (!cancelled) setSessions([]) })
      .finally(() => { if (!cancelled) setSessionsLoading(false) })
    return () => { cancelled = true }
  }, [showEmptyOutput, project?.id])

  // Opening the page with nothing on it reopens your latest unfinished
  // session for this project -- unless you closed it with Reset.
  useEffect(() => {
    if (restoreTriedRef.current || !showEmptyOutput || loading) return
    restoreTriedRef.current = true
    let closed: string | null = null
    try { closed = sessionStorage.getItem('ta_closed_session') } catch { /* storage unavailable */ }
    projectService.sessions({ projectId: project?.id ?? null, mine: true, open: true, limit: 1 })
      .then((items) => {
        const latest = items[0]
        if (latest && latest.restorable && latest.request_id !== closed) void restoreSession(latest.request_id)
      })
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showEmptyOutput])

  const inputSummarySource =
    inputType === 'text'
      ? `Text input · ${textValue.trim().length.toLocaleString()} chars`
      : inputType === 'e2e-spark'
        ? `e2e Spark · PPM ${ppmId.trim() || '—'}`
        : fileInputs.map((file) => file.name).join(', ') || restoredDocumentNames.join(', ') || 'No files'

  useEffect(() => {
    if (isGenerationStreaming || response || output) setOutputOpen(true)
  }, [isGenerationStreaming, response, output])

  useEffect(() => {
    publishTokenUsage({ used: userTokensUsed, allocation: userTokenAllocation, isAdmin: isAdminUser, loading: tokenCheckLoading })
  }, [userTokensUsed, userTokenAllocation, isAdminUser, tokenCheckLoading])

  // Where this request is on the journey.
  const inputReady =
    inputType === 'text' ? textValue.trim().length > 0 : documentsProcessed || combinedContent.trim().length > 0
  const journeyStep =
    submittedTestCaseCount !== null ? 5
      : aiBatch && !aiRunning ? 4
        : (response || output) && !isGenerationStreaming ? 3
        : inputReady || loading || isGenerationStreaming ? 2
          : 1

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

      <div className="space-y-4">
        {/* Generate Test Cases -- folds to one line while and after generating */}
        {inputsFolded ? (
          <InputSummary
            source={inputSummarySource}
            knowledgeBase={selectedKnowledgeBaseOption.label}
            environment={selectedEnvironment || undefined}
            focus={selectedFocus || undefined}
            project={projectLabel(project) || undefined}
            onShowInputs={() => setInputsFolded(false)}
          />
        ) : (
        <section className="relative rounded-[20px] border border-[#E8EAEE] bg-white px-[22px] py-5 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)]">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8" aria-hidden><path d="M12 3l1.8 4.9L19 9.7l-4.2 3.1 1.5 5.2L12 15l-4.3 3 1.5-5.2L5 9.7l5.2-1.8z" /></svg>
            </div>
            <div>
              <h2 className="m-0 text-[16px] font-bold tracking-[-0.01em] text-[#1F2937]">Generate Test Cases</h2>
              <p className="mt-0.5 text-[12.5px] text-[#6B7280]">Generate test cases from BRDs, SDDs, ADO and e2e Spark</p>
            </div>
            <div className="ml-auto min-w-0">
              <ProjectChip onOpen={() => setProjectDialog('edit')} fromBrd={projectFromBrd} />
            </div>
          </div>

          {/* Source */}
          <div role="radiogroup" aria-label="Source" className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
            {sourceOptions.map((source) => {
              const active = inputType === source.value
              return (
                <button
                  key={source.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-audit-name={source.audit}
                  onClick={() => {
                    if (source.value !== inputType && (source.value === 'file' || source.value === 'figma-pdf') && (inputType === 'file' || inputType === 'figma-pdf')) {
                      // Figma reads one PDF and File Upload many formats: files picked for one are not for the other.
                      setFileInputs([]); setFilePreviews([]); setEditableContents({}); setCombinedContent(''); setCombinedPreviewHtml(''); setDocumentsProcessed(false)
                    }
                    setInputType(source.value)
                    if (source.value === 'file' || source.value === 'figma-pdf') setUploadOpen(true)
                  }}
                  className={`flex h-11 items-center gap-2 rounded-[12px] border px-3 text-[13px] font-semibold transition ${
                    active ? 'border-[#F6D4D5] bg-[#FFF5F5] text-[#7A0B0D]' : 'border-[#E8EAEE] bg-white text-[#1F2937] hover:border-[#F6D4D5]'
                  }`}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={active ? '#B71920' : '#6B7280'} strokeWidth="1.8" aria-hidden><path d={source.icon} /></svg>
                  {source.label}
                </button>
              )
            })}
          </div>

          {/* Compact input, expandable */}
          <div className={`mt-3 grid gap-3 ${inputType === 'e2e-spark' ? 'grid-cols-1 md:grid-cols-[minmax(0,1fr)_300px]' : 'grid-cols-1'}`}>
            <div className={`relative box-border overflow-hidden rounded-[16px] border border-[#E8EAEE] px-3.5 py-3 ${inputExpanded ? 'h-[360px]' : 'h-[116px]'}`}>
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.16em] text-[#6B7280]">
                    {inputType === 'text' ? 'Requirements' : 'Document preview'}
                  </span>
                  {(inputType === 'file' || inputType === 'figma-pdf') && fileInputs.length > 0 && (
                    <span className="truncate text-[11.5px] text-[#6B7280]" title={fileInputs.map((file) => file.name).join(', ')}>
                      · {fileInputs.length === 1 ? fileInputs[0].name : `${fileInputs.length} documents`} · {documentsProcessed ? 'processed' : 'not processed yet'}
                    </span>
                  )}
                </span>
                <span className="flex flex-shrink-0 items-center gap-3">
                  {(inputType === 'file' || inputType === 'figma-pdf') && (
                    <button type="button" onClick={() => setUploadOpen(true)} data-audit-name="Open document upload" className="text-[12px] font-semibold text-[#B71920] hover:text-[#941216]">
                      {fileInputs.length > 0 ? 'Change documents' : 'Upload documents'}
                    </button>
                  )}
                  {inputType !== 'text' && documentsProcessed && (
                    <button type="button" onClick={() => setExpandedPreview(true)} className="text-[12px] font-semibold text-[#B71920] hover:text-[#941216]">
                      Full preview
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setInputExpanded((value) => !value)}
                    aria-expanded={inputExpanded}
                    className="text-[12px] font-semibold text-[#B71920] hover:text-[#941216]"
                  >
                    {inputExpanded ? 'Collapse' : 'Expand'}
                  </button>
                </span>
              </div>
              {inputType === 'text' ? (
                <textarea
                  value={textValue}
                  data-audit-name="Text Input"
                  onChange={(e) => setTextValue(e.target.value)}
                  placeholder="Enter your BRD text here..."
                  className="mt-2 h-[calc(100%-26px)] w-full resize-none border-0 bg-transparent p-0 text-[12.5px] leading-[1.6] text-[#1F2937] outline-none placeholder:text-[#9CA3AF]"
                />
              ) : (
                <textarea
                  value={combinedContent}
                  data-audit-name="Combined Editable Content"
                  onChange={(e) => handleCombinedChange(e.target.value)}
                  placeholder={
                    inputType === 'e2e-spark'
                      ? 'Imported SSD content appears here after Import SSD.'
                      : 'Document text appears here after Process Documents. Edit it and process again to refresh.'
                  }
                  className="mt-2 h-[calc(100%-26px)] w-full resize-none border-0 bg-transparent p-0 text-[12.5px] leading-[1.6] text-[#6B7280] outline-none placeholder:text-[#9CA3AF]"
                />
              )}
              {!inputExpanded && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-9 bg-[linear-gradient(180deg,rgba(255,255,255,0),#fff)]" />
              )}
            </div>

            {inputType === 'e2e-spark' && (
              <div className="box-border flex flex-col gap-2 rounded-[16px] border-[1.5px] border-dashed border-[#F1A4A6] bg-[#FFF8F8] px-3.5 py-3">
                <label htmlFor="ppm-id" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#6B7280]">
                  PPM ID <span className="text-[#B71920]">*</span>
                </label>
                <div className="flex gap-2">
                  <input
                    id="ppm-id"
                    type="text"
                    value={ppmId}
                    onChange={(e) => {
                      setPpmId(e.target.value)
                      if (sparkImportError) setSparkImportError('')
                    }}
                    placeholder="Enter PPM ID"
                    className="h-9 min-w-0 flex-1 rounded-[10px] border border-[#E8EAEE] bg-white px-3 text-[13px] text-[#1F2937] outline-none focus:border-[#B71920] focus:ring-2 focus:ring-[#FDEBEC]"
                  />
                  <button
                    type="button"
                    onClick={handleImportSsd}
                    disabled={sparkImportLoading || ppmId.trim().length === 0}
                    className={`h-9 flex-shrink-0 rounded-[10px] px-3 text-[12.5px] font-bold transition ${
                      !sparkImportLoading && ppmId.trim().length > 0
                        ? 'bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] text-white'
                        : 'cursor-not-allowed bg-[#F4F5F7] text-[#9CA3AF]'
                    }`}
                  >
                    {sparkImportLoading ? 'Importing...' : 'Import SSD'}
                  </button>
                </div>
                {sparkStorageKey && <div className="text-[11px] font-semibold text-[#136B34]">SSD imported · {sparkStorageKey}</div>}
                {sparkImportError && <div className="text-[11px] font-semibold text-[#B71920]">{sparkImportError}</div>}
              </div>
            )}
          </div>

          {/* Controls: Select KB before Generate */}
          <div className="mt-4 flex flex-wrap items-end gap-2.5">
            <SelectKB
              options={knowledgeBaseOptions}
              value={selectedKnowledgeBase}
              onChange={setSelectedKnowledgeBase}
              disabled={loading}
            />
            <label className="relative flex flex-col gap-1.5" title="The environment these test cases target. Their scripts run against it and use its Test Data.">
              <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#6B7280]">Environment <span className="text-[#B71920]">*</span></span>
              <span className="relative">
                <select
                  value={selectedEnvironment}
                  data-audit-name="Environment"
                  required
                  aria-required="true"
                  aria-invalid={environmentMissing && !selectedEnvironment}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) => { setSelectedEnvironment(event.target.value as EnvironmentOption); setEnvironmentMissing(false) }}
                  className={`h-10 w-40 appearance-none rounded-[12px] border bg-white pl-3 pr-8 text-[13px] font-semibold text-[#1F2937] outline-none focus:border-[#B71920] focus:ring-2 focus:ring-[#FDEBEC] ${
                    environmentMissing && !selectedEnvironment ? 'border-[#B71920] ring-2 ring-[#FDEBEC]' : 'border-[#E8EAEE]'
                  }`}
                >
                  {environmentOptions.map((option) => (
                    <option key={option.label} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
              </span>
              {environmentMissing && !selectedEnvironment && (
                <span role="alert" className="absolute left-0 top-full mt-1 whitespace-nowrap text-[11.5px] font-semibold text-[#B71920]">Choose the environment first</span>
              )}
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#6B7280]">Focus</span>
              <span className="relative">
                <select
                  value={selectedFocus}
                  data-audit-name="Focus"
                  onChange={(event: ChangeEvent<HTMLSelectElement>) => setSelectedFocus(event.target.value as FocusOption)}
                  className="h-10 w-40 appearance-none rounded-[12px] border border-[#E8EAEE] bg-white pl-3 pr-8 text-[13px] font-semibold text-[#1F2937] outline-none focus:border-[#B71920] focus:ring-2 focus:ring-[#FDEBEC]"
                >
                  {focusOptions.map((option) => (
                    <option key={option.label} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
              </span>
            </label>
            <div className="ml-auto flex gap-2.5">
              <button
                type="button"
                data-audit-name="Reset"
                onClick={handleResetAll}
                disabled={!textValue && fileInputs.length === 0 && !ppmId && !combinedContent && !response && !output && !loading && !sparkImportLoading}
                className="flex h-10 items-center rounded-[12px] border border-[#F1A4A6] bg-white px-4 text-[13px] font-bold text-[#B71920] transition hover:bg-[#FFF5F5] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (inputType === 'figma-pdf' && fileInputs.length > 0 && !documentsProcessed) {
                    await handleProcessFigmaPdf()
                    return
                  }
                  if (inputType === 'file' && fileInputs.length > 0 && !documentsProcessed) {
                    await handleProcessDocuments()
                    return
                  }
                  requestGenerate()
                }}
                data-audit-name={getGenerateButtonLabel()}
                disabled={!isGenerateEnabled || loading || tokenLimitReached}
                title={tokenLimitReached ? 'Token allocation limit reached' : !selectedEnvironment ? 'Choose the environment these test cases target first' : ''}
                className={`flex h-10 items-center gap-2 rounded-[12px] px-4 text-[13px] font-bold transition ${
                  isGenerateEnabled && !loading && !tokenLimitReached
                    ? 'bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] hover:opacity-95'
                    : 'cursor-not-allowed bg-[#F4F5F7] text-[#9CA3AF]'
                } ${loading ? 'blink-bg' : ''}`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M12 3l1.8 4.9L19 9.7l-4.2 3.1 1.5 5.2L12 15l-4.3 3 1.5-5.2L5 9.7l5.2-1.8z" /></svg>
                <span className={loading ? 'blink-text' : ''}>{getGenerateButtonLabel()}</span>
              </button>
            </div>
          </div>
        </section>

        )}

        {/* Output: closed until generation starts, then progress and cases in place */}
        {aiBatch && aiEditing !== null && aiBatch.items.find((item) => item.check_id === aiEditing) ? (
          <StepEditor
            key={aiEditing}
            item={aiBatch.items.find((item) => item.check_id === aiEditing)!}
            totalCases={aiBatch.total}
            saving={aiSaving}
            error={aiEditError}
            onCancel={() => { setAiEditing(null); setAiEditError('') }}
            onSave={handleAiSaveSteps}
          />
        ) : aiBatch ? (
          <AIChecksPanel
            batch={aiBatch}
            now={nowTick}
            selected={aiSelected}
            onToggle={(checkId) => setAiSelected((current) => {
              const next = new Set(current)
              if (next.has(checkId)) next.delete(checkId)
              else next.add(checkId)
              return next
            })}
            onToggleAll={(ids, on) => setAiSelected((current) => {
              const next = new Set(current)
              ids.forEach((id) => (on ? next.add(id) : next.delete(id)))
              return next
            })}
            onRetry={handleAiRetry}
            onEdit={(checkId) => { setAiEditError(''); setAiEditing(checkId) }}
            onSend={handleAiSend}
            onDownload={handleAiDownload}
            onStop={handleAiStop}
            onRestart={handleAiRestart}
            onDelete={handleAiDelete}
            busy={aiBusy}
            savedAs={savedRequestId}
            sendCount={aiSendable.length}
            sentIds={aiSentIds}
          />
        ) : !hasOutput && !generationError ? (
          <section className="rounded-[16px] border border-[#E8EAEE] bg-white px-[22px] py-3 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
            <div className="flex flex-wrap items-center gap-2.5">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#B71920" strokeWidth="1.8" aria-hidden><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /></svg>
            <span className="text-[15px] font-bold text-[#1F2937]">Output</span>
            <span className="text-[12.5px] text-[#6B7280]">
              {documentsProcessed
                ? `Files processed — click "${getGenerateButtonLabel()}" to continue.`
                : 'Opens when you click Generate Test Cases — progress and test cases appear right here.'}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button type="button" disabled title="Generate test cases first" className="flex h-[34px] cursor-not-allowed items-center rounded-[12px] bg-[#F4F5F7] px-4 text-[13px] font-bold text-[#9CA3AF]">
                Save &amp; Run AI Checks
              </button>
              <span className="box-border flex h-[34px] w-[34px] items-center justify-center rounded-[10px] border border-[#E8EAEE]" aria-hidden>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#C4C8CF" strokeWidth="2"><path d="M6 9l6 6 6-6" /></svg>
              </span>
            </div>
            </div>
            <SessionList
              items={sessions}
              loading={sessionsLoading}
              scopeLabel={project ? projectLabel(project) : 'yours, without a project'}
              currentUser={currentUsername}
              onOpen={(requestId) => void restoreSession(requestId)}
            />
          </section>
        ) : (
          <section className="flex flex-col overflow-hidden rounded-[20px] border border-[#E8EAEE] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
            <div className={`flex flex-wrap items-center gap-2.5 px-[22px] pt-4 ${outputOpen || isGenerationStreaming ? '' : 'pb-4'}`}>
              <span className="text-[15px] font-bold text-[#1F2937]">Output</span>
              {isGenerationStreaming ? (
                <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-[#FDEBEC] px-[9px] text-[11.5px] font-semibold text-[#941216]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#B71920]" />Generating
                </span>
              ) : generationError ? (
                <span className="inline-flex h-6 items-center rounded-full bg-[#FEEBEC] px-[9px] text-[11.5px] font-semibold text-[#A3231C]">Failed</span>
              ) : (
                <span className="inline-flex h-6 items-center rounded-full bg-[#EAF7EF] px-[9px] text-[11.5px] font-semibold text-[#136B34]">
                  {generationStopped ? 'Stopped · ' : ''}{streamParse.cases.length} test case{streamParse.cases.length === 1 ? '' : 's'}
                </span>
              )}
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {isGenerationStreaming ? (
                  <button
                    type="button"
                    onClick={handleStopGeneration}
                    data-audit-name="Stop generation"
                    className="flex h-[34px] items-center rounded-[12px] border border-[#E8EAEE] bg-white px-4 text-[13px] font-bold text-[#1F2937] transition hover:border-[#F6D4D5]"
                  >
                    Stop
                  </button>
                ) : generationError ? (
                  <button
                    type="button"
                    onClick={requestGenerate}
                    data-audit-name="Retry generation"
                    className="flex h-[34px] items-center rounded-[12px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-4 text-[13px] font-bold text-white"
                  >
                    Retry
                  </button>
                ) : (
                  <>
                    {gridSelected.size > 0 && (
                      <button
                        type="button"
                        onClick={() => void handleDeleteGenerated()}
                        data-audit-name="Delete generated test cases"
                        className="flex h-[34px] items-center gap-1.5 rounded-[12px] border border-[#E8EAEE] bg-white px-3 text-[12.5px] font-bold text-[#A3231C] transition hover:border-[#F0C2C0]"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
                        Delete {gridSelected.size}
                      </button>
                    )}
                    {streamParse.cases.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowFullTable((value) => !value)}
                        className="flex h-[34px] items-center rounded-[12px] border border-[#E8EAEE] bg-white px-3 text-[12.5px] font-semibold text-[#1F2937] transition hover:border-[#F6D4D5]"
                      >
                        {showFullTable ? 'Summary' : 'Full table'}
                      </button>
                    )}
                  </>
                )}
                <button
                  type="button"
                  onClick={handleRunAiChecks}
                  data-audit-name="Save & Run AI Checks"
                  disabled={isGenerationStreaming || Boolean(generationError) || streamParse.cases.length === 0 || aiStarting || submittedTestCaseCount !== null}
                  title={streamParse.cases.length === 0 ? 'Generate test cases first' : 'Save the test cases, then refine, review, improve and classify them before approval'}
                  className={`flex h-[34px] items-center rounded-[12px] px-4 text-[13px] font-bold transition ${
                    isGenerationStreaming || generationError || streamParse.cases.length === 0 || submittedTestCaseCount !== null
                      ? 'cursor-not-allowed bg-[#F4F5F7] text-[#9CA3AF]'
                      : 'bg-[#1F2937] text-white hover:bg-[#111827]'
                  }`}
                >
                  {aiStarting ? 'Saving…' : gridSelected.size > 0 ? `Save & Run AI Checks on ${gridSelected.size}` : 'Save & Run AI Checks'}
                </button>
                {!isGenerationStreaming && !generationError && (
                  <button
                    type="button"
                    onClick={() => setOutputOpen((value) => !value)}
                    aria-expanded={outputOpen}
                    aria-label={outputOpen ? 'Close output' : 'Open output'}
                    className="box-border flex h-[34px] w-[34px] items-center justify-center rounded-[10px] border border-[#E8EAEE] bg-white"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2" aria-hidden>
                      <path d={outputOpen ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'} />
                    </svg>
                  </button>
                )}
              </div>
            </div>

            {aiError && (
              <div className="mx-[22px] mt-3.5 rounded-[12px] border border-[#F6D4D5] bg-[#FFF8F8] px-3.5 py-2.5 text-[12.5px] text-[#7A0B0D]" role="alert">
                {aiError}
              </div>
            )}

            {generationError && (
              <div className="mx-[22px] mb-4 mt-3.5 rounded-[16px] border border-[#F6D4D5] bg-[#FFF8F8] px-[18px] py-3.5 text-[13px] text-[#7A0B0D]" role="alert">
                <div className="font-bold">Test cases could not be generated</div>
                <div className="mt-1 break-words text-[12.5px] text-[#6B7280]">{generationError}</div>
              </div>
            )}

            {isGenerationStreaming && (
              <ProgressPanel stagesDone={genStagesDone} written={streamParse.cases.length} elapsedMs={genStartedAt ? nowTick - genStartedAt : 0} />
            )}

            {!generationError && (isGenerationStreaming || outputOpen) && (
              streamParse.cases.length > 0 && !showFullTable ? (
                <CaseGrid
                  cases={streamParse.cases}
                  streaming={isGenerationStreaming}
                  selection={submittedTestCaseCount !== null ? undefined : {
                    selected: gridSelected,
                    onToggle: (id) => setGridSelected((current) => {
                      const next = new Set(current)
                      if (next.has(id)) next.delete(id)
                      else next.add(id)
                      return next
                    }),
                    onToggleAll: (ids, on) => setGridSelected(on ? new Set(ids) : new Set())
                  }}
                  footerNote={isGenerationStreaming ? 'You can switch testing tools — generation keeps running.' : undefined}
                />
              ) : isGenerationStreaming ? (
                <CaseGrid cases={[]} streaming footerNote="You can switch testing tools — generation keeps running." />
              ) : (response || output) ? (
                <div className="px-[22px] pb-4 pt-3">
                  <MarkdownViewer content={response || output || ''} className="min-h-[200px]" />
                </div>
              ) : null
            )}
          </section>
        )}

        <JourneyBar current={journeyStep} />
      </div>

      <ProjectDialog
        open={projectDialog !== null}
        gate={projectDialog === 'gate'}
        initialPpmId={inputType === 'e2e-spark' ? ppmId.trim() : ''}
        initialName={brdProjectName}
        editCurrent={projectDialog === 'edit'}
        onClose={() => setProjectDialog(null)}
        onChosen={handleProjectChosen}
      />

      {/* File Upload / Figma: pick documents, then Process Documents or Reset back to the page */}
      {uploadOpen && (inputType === 'file' || inputType === 'figma-pdf') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(17,24,39,0.45)] p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) setUploadOpen(false) }}>
          <div role="dialog" aria-modal="true" aria-labelledby="upload-dialog-title" className="w-full max-w-[560px] overflow-hidden rounded-[20px] border border-[#E8EAEE] bg-white shadow-[0_24px_60px_rgba(16,24,40,0.22)]">
            <div className="flex items-start gap-3 border-b border-[#F1F2F4] px-6 pb-4 pt-5">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px] bg-[#FDEBEC]">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#B71920" strokeWidth="1.8" aria-hidden><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /></svg>
              </div>
              <div className="min-w-0 flex-1">
                <h2 id="upload-dialog-title" className="m-0 text-[16px] font-bold text-[#1F2937]">{inputType === 'figma-pdf' ? 'Upload Figma PDF' : 'Upload documents'}</h2>
                <p className="mt-0.5 text-[12.5px] text-[#6B7280]">
                  {inputType === 'figma-pdf'
                    ? 'One Figma design export as PDF. Its visible text becomes the requirements.'
                    : 'BRDs or SDDs: .docx, .pdf, .txt, .xlsx, .pptx. With no project chosen, the PPM ID and project name are read from them.'}
                </p>
              </div>
              <button type="button" onClick={() => setUploadOpen(false)} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-[10px] text-[#6B7280] hover:bg-[#F4F5F7]">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <div className="px-6 py-5">
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  if (e.dataTransfer.files?.length) {
                    handleFileChange({ target: { files: e.dataTransfer.files } } as unknown as ChangeEvent<HTMLInputElement>)
                  }
                }}
                // The whole drop zone opens the file picker; a file's own buttons (remove) do not.
                role="button"
                tabIndex={0}
                aria-label={inputType === 'figma-pdf' ? 'Choose a Figma PDF' : 'Choose documents'}
                onClick={(e) => {
                  const target = e.target as HTMLElement
                  if (target.closest('button') || target instanceof HTMLInputElement) return
                  document.getElementById('file-upload')?.click()
                }}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault()
                    document.getElementById('file-upload')?.click()
                  }
                }}
                className="box-border flex min-h-[150px] max-h-[320px] cursor-pointer flex-col gap-2 overflow-y-auto rounded-[16px] border-[1.5px] border-dashed border-[#F1A4A6] bg-[#FFF8F8] px-3.5 py-3 outline-none transition hover:border-[#B71920] hover:bg-[#FDEBEC] focus-visible:ring-2 focus-visible:ring-[#F1A4A6]"
              >
                <input
                  type="file"
                  onChange={handleFileChange}
                  data-audit-name={inputType === 'figma-pdf' ? 'Figma Files (PDF)' : 'File Upload'}
                  className="hidden"
                  id="file-upload"
                  accept={inputType === 'figma-pdf' ? '.pdf,application/pdf' : '.txt,.doc,.docx,.pdf,.xls,.xlsx,.ppt,.pptx'}
                  multiple={inputType !== 'figma-pdf'}
                />
                {fileInputs.map((file, index) => (
                  <div key={`${file.name}-${index}`} className="flex items-center gap-2.5">
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[8px] border border-[#F6D4D5] bg-white">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#B71920" strokeWidth="1.8" aria-hidden><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /></svg>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] font-semibold text-[#1F2937]" title={file.name}>{file.name}</div>
                      <div className={`text-[11px] font-semibold ${documentsProcessed ? 'text-[#136B34]' : 'text-[#6B7280]'}`}>
                        {documentsProcessed ? 'Processed' : 'Ready to process'} · {Math.max(1, Math.round(file.size / 1024))} KB
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveFile(index)}
                      title="Remove file"
                      aria-label={`Remove ${file.name}`}
                      className="flex-shrink-0 rounded-full p-1 text-[#B71920] transition hover:bg-white"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                ))}
                <div className={`text-[12px] text-[#6B7280] ${fileInputs.length === 0 ? 'my-auto flex flex-col items-center gap-2 py-6 text-center text-[13px]' : ''}`}>
                  {fileInputs.length === 0 && (
                    <span className="flex h-11 w-11 items-center justify-center rounded-full border border-[#F6D4D5] bg-white">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#B71920" strokeWidth="1.8" aria-hidden><path d="M12 16V4M7 9l5-5 5 5M5 20h14" /></svg>
                    </span>
                  )}
                  <span>
                  {fileInputs.length === 0
                    ? inputType === 'figma-pdf' ? 'Drop Figma PDF exports here, or ' : 'Drop BRDs or SDDs here, or '
                    : inputType === 'figma-pdf' ? 'Drop more Figma PDFs, or ' : 'Drop more BRDs or SDDs, or '}
                  <span className="font-semibold text-[#B71920] underline-offset-2 hover:underline">browse</span>
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 border-t border-[#F1F2F4] bg-[#FCFCFD] px-6 py-3.5">
              <button
                type="button"
                data-audit-name="Reset documents"
                onClick={() => {
                  setFileInputs([]); setFilePreviews([]); setEditableContents({}); setCombinedContent(''); setCombinedPreviewHtml('')
                  setDocumentsProcessed(false); setNeedsReprocess(false); brdDetectedForRef.current = ''
                  setUploadOpen(false)
                }}
                disabled={fileInputs.length === 0 || loading}
                className="flex h-9 items-center rounded-[12px] border border-[#F1A4A6] bg-white px-4 text-[13px] font-bold text-[#B71920] transition hover:bg-[#FFF5F5] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Reset
              </button>
              <div className="ml-auto flex gap-2">
                <button type="button" onClick={() => setUploadOpen(false)} className="flex h-9 items-center rounded-[12px] border border-[#E8EAEE] bg-white px-4 text-[13px] font-bold text-[#1F2937] hover:border-[#F6D4D5]">
                  Cancel
                </button>
                <button
                  type="button"
                  data-audit-name="Process Documents"
                  disabled={fileInputs.length === 0 || loading}
                  onClick={() => {
                    setUploadOpen(false)
                    void (inputType === 'figma-pdf' ? handleProcessFigmaPdf() : handleProcessDocuments())
                  }}
                  className="flex h-9 items-center rounded-[12px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-4 text-[13px] font-bold text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
                >
                  {documentsProcessed && fileInputs.length > 0 ? 'Process again' : 'Process Documents'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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

      {approvalNotification && (
        <Notification
          message={approvalNotification.message}
          type={approvalNotification.type}
          duration={2000}
          onClose={() => setApprovalNotification(null)}
        />
      )}
      {/* <ChatWindow
        isOpen={isChatOpen}
        onToggle={() => setIsChatOpen(!isChatOpen)}
        messages={chatMessages}
        onAddMessage={handleAddChatMessage}
        onUpdateLastMessage={handleUpdateLastMessage}
        onChatResponse={handleChatResponse}
        currentTab="Test Cases"
        userName={authUser.user?.username || 'User'}
        seedContent={brdContent}
      /> */}
    </div>
  )
}

export default TestCases
