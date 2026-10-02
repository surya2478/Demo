// --- Test cases in the RQM upload template ----------------------------------------
//
// The QA team uploads test cases to RQM from one spreadsheet layout: 22 columns,
// the ones only QA can know left as "to be filled by QA". The Test Assistant
// once downloaded it through the AI service's export endpoint, from the table
// that service wrote. This builds it here instead, from any case's columns --
// the standard table (testcases.py), the AI service's older one, or a case as
// stored for review -- so both Test Assistant and Review & Approval download the
// same layout, and nothing depends on the AI service being reachable.

import { getTimestampedFilename } from './DynamicFileName-DateTime'

export const RQM_COLUMNS = [
  'ID', 'Domain', 'Channel', 'Product', 'Area of Test', 'Test Case ID', 'Environment', 'Sub Request Type',
  'Test Case Objective', 'Pre-Requisites', 'Test Steps', 'Expected Results', 'ATC Test Case', 'Test Case Type',
  'Test Case Complexity', 'Tested By', 'JIRA ID or PPM', 'Overall Status', 'Blocking Snag ID/Other Reason', 'SIT',
  'Planned Exec Sequence', 'Critical TC mapping'
] as const

export const TO_FILL = 'to be filled by QA'

/** What the download knows beyond the cases: the project's PPM id, when there is one. */
export interface RqmContext {
  ppmId?: string | null
}

type Field = 'id' | 'objective' | 'pre' | 'steps' | 'expected' | 'testData' | 'type' | 'category' | 'complexity'
  | 'sequence' | 'channel' | 'product' | 'domain' | 'area' | 'environment' | 'subRequest'

// Column names as the different tables spell them, compared without case or punctuation.
const NAMES: Record<Field, string[]> = {
  id: ['testcaseid', 'tcid', 'id', 'testcaseno', 'sno'],
  objective: ['testcaseobjective', 'testcasedescription', 'description', 'objective', 'testobjective', 'title', 'testcasetitle'],
  pre: ['prerequisites', 'prerequisite', 'preconditions', 'precondition'],
  steps: ['teststeps', 'steps'],
  expected: ['expectedresults', 'expectedresult', 'expectedoutcome'],
  testData: ['testdata'],
  type: ['testcasetype', 'type'],
  category: ['category'],
  complexity: ['testcasecomplexity', 'complexity'],
  sequence: ['plannedexecsequence', 'executionsequence', 'plannedexecutionsequence'],
  channel: ['channel'],
  product: ['product'],
  domain: ['domain'],
  area: ['areaoftest'],
  environment: ['environment'],
  subRequest: ['subrequesttype']
}

const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')

const reader = (row: Record<string, unknown>) => {
  const index = new Map<string, string>()
  Object.entries(row || {}).forEach(([name, value]) => {
    if (!name.startsWith('_') && value != null && String(value).trim()) index.set(key(name), String(value).trim())
  })
  return (field: Field) => {
    for (const name of NAMES[field]) {
      const value = index.get(name)
      // "None" is how the standard table says a cell is empty.
      if (value && !/^(none|n\/a|-|—)$/i.test(value)) return value
    }
    return ''
  }
}

/** Numbered steps, one per line as the template writes them: "1. …<br>2. …". */
export const rqmSteps = (text: string): string => {
  const clean = (text || '').replace(/\r/g, '').trim()
  if (!clean) return ''
  if (/<br\s*\/?>/i.test(clean)) return clean.replace(/<br\s*\/?>/gi, '<br>')
  let parts = clean.split(/(?:^|\s)(?=\d+[.)]\s)/).map((part) => part.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean)
  if (parts.length <= 1) parts = clean.split(/\n+/).map((line) => line.replace(/^[-*•]\s*/, '').trim()).filter(Boolean)
  return parts.map((part, i) => `${i + 1}. ${part}`).join('<br>')
}

const stepCount = (steps: string) => (steps ? steps.split('<br>').length : 0)

const caseType = (stated: string, category: string, text: string): string => {
  for (const value of [stated, category]) {
    if (/boundary|edge/i.test(value)) return 'Boundary'
    if (/negative/i.test(value)) return 'Negative'
    if (/positive/i.test(value)) return 'Positive'
  }
  const t = text.toLowerCase()
  if (/\b(boundary|maximum|minimum|limit|exceed(s|ed|ing)?)\b/.test(t)) return 'Boundary'
  if (/\b(invalid|cannot|unable|fail(s|ed|ure)?|error|reject(s|ed)?|without|missing|wrong|expired|unauthori[sz]ed|den(y|ied)|incorrect)\b/.test(t)) return 'Negative'
  return 'Positive'
}

const complexity = (stated: string, steps: number) => {
  if (/^(low|medium|high)$/i.test(stated)) return stated[0].toUpperCase() + stated.slice(1).toLowerCase()
  return steps <= 4 ? 'Low' : steps <= 8 ? 'Medium' : 'High'
}

/** One template row per case, in the order given. */
export const toRqmRows = (cases: Record<string, unknown>[], context: RqmContext = {}): Record<string, string>[] =>
  cases.map((row, index) => {
    const get = reader(row)
    const id = get('id') || `TC-${String(index + 1).padStart(2, '0')}`
    const channel = get('channel')
    const product = get('product')
    const steps = rqmSteps(get('steps'))
    const objective = get('objective')
    const expected = get('expected')
    const testData = get('testData')
    const pre = [get('pre'), testData && `Test data: ${testData}`].filter(Boolean).join('; ')
    return {
      ID: id,
      Domain: get('domain') || TO_FILL,
      Channel: channel || TO_FILL,
      Product: product || TO_FILL,
      'Area of Test': get('area') || TO_FILL,
      'Test Case ID': [id, channel, product].filter(Boolean).join('_'),
      Environment: get('environment') || TO_FILL,
      'Sub Request Type': get('subRequest') || TO_FILL,
      'Test Case Objective': objective,
      'Pre-Requisites': pre || TO_FILL,
      'Test Steps': steps,
      'Expected Results': expected,
      'ATC Test Case': TO_FILL,
      'Test Case Type': caseType(get('type'), get('category'), `${objective} ${expected}`),
      'Test Case Complexity': complexity(get('complexity'), stepCount(steps)),
      'Tested By': TO_FILL,
      'JIRA ID or PPM': context.ppmId?.trim() || TO_FILL,
      'Overall Status': TO_FILL,
      'Blocking Snag ID/Other Reason': TO_FILL,
      SIT: TO_FILL,
      'Planned Exec Sequence': get('sequence') || 'Day 1',
      'Critical TC mapping': TO_FILL
    }
  })

/** Save template rows (toRqmRows) as an RQM workbook. Returns how many rows it holds. */
export const saveRqm = async (rows: Record<string, string>[], baseName: string): Promise<number> => {
  const XLSX = await import('xlsx')
  const sheet = XLSX.utils.json_to_sheet(rows, { header: [...RQM_COLUMNS] })
  sheet['!cols'] = RQM_COLUMNS.map((column) =>
    ({ wch: ['Test Case Objective', 'Pre-Requisites', 'Test Steps', 'Expected Results'].includes(column) ? 48 : Math.max(12, column.length + 2) }))
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Test Cases')
  XLSX.writeFile(book, getTimestampedFilename(baseName))
  return rows.length
}

/** Save the cases as an RQM template workbook. Returns how many rows it holds. */
export const downloadRqm = (cases: Record<string, unknown>[], context: RqmContext, baseName: string): Promise<number> =>
  saveRqm(toRqmRows(cases, context), baseName)
