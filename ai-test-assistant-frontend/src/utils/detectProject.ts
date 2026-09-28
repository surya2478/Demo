// Finds the project a BRD belongs to -- its PPM ID and name -- in the text a
// document was parsed into, so a project the author did not pick by hand can
// still be saved with the test cases. Deterministic: no model call.

export interface DetectedProject {
  /** Null when the document names no PPM ID; a project cannot be saved without one. */
  ppmId: string | null
  /** From a "Project Name" field, else the document's title, else the file name. */
  name: string | null
}

const LABELLED_PPM = /\bPPM\s*(?:ID|No\.?|Number|Code|Ref(?:erence)?|#)?\s*[:#=\-–—]?\s*([A-Z]{0,6}[-/]?\d[A-Z0-9\-/]{1,30})/i
const LABELLED_NAME = /\b(?:Project\s*(?:Name|Title)|Name\s+of\s+(?:the\s+)?Project|Initiative\s*Name|Project)\s*[:\-–—|]\s*([^\n]{0,160})(?:\n([^\n]{0,160}))?/i

// Lines that head a BRD without naming the project.
const NOT_A_TITLE = [
  /^(?:business|functional|software|system|technical|solution)?\s*(?:requirements?|design|solution)\s*(?:document|specification)s?\b/i,
  /^(?:brd|frd|srs|sdd|hld|lld|prd)\b/i,
  /^(?:document|version|revision|table of contents|contents|confidential|internal|draft|approved|prepared|author|date|page)\b/i,
  /^(?:\d+(?:\.\d+)*\s*)?(?:introduction|purpose|scope|overview|background|executive summary|glossary|definitions|references|approvals?|sign[- ]?off)\b/i,
  /^[A-Za-z][\w ./&()-]{1,30}:\s/, // a "Label: value" line
  /^v?\d+(?:\.\d+)*$/i,
  /^[\W\d_]+$/
]

const tidy = (value: string) => value.replace(/\s+/g, ' ').replace(/^[\s:–—\-|*#]+|[\s:–—\-|*#]+$/g, '').trim()

const usableName = (value: string | undefined) => {
  const name = tidy(value || '')
  if (name.length < 3 || name.length > 120) return null
  // A label, not a value: "Project Manager", "Project Sponsor" and the like.
  if (/^(?:manager|sponsor|owner|lead|id|code|number|scope|overview|background|details?)\b/i.test(name)) return null
  if (/\bPPM\b/i.test(name)) return null
  return name
}

const titleOf = (text: string) => {
  const lines = text.split(/\r?\n/).map(tidy).filter(Boolean).slice(0, 20)
  for (const line of lines) {
    if (NOT_A_TITLE.some((rule) => rule.test(line))) continue
    const name = usableName(line)
    if (name && /[A-Za-z]{3}/.test(name)) return name
  }
  return null
}

const fileTitle = (fileName: string) => {
  const stem = fileName.replace(/\.[A-Za-z0-9]+$/, '').replace(/\bPPM[-_ ]?[A-Z0-9-]+\b/i, '').replace(/[_]+/g, ' ')
  return usableName(stem.replace(/\b(?:brd|frd|srs|sdd|v\d+(?:\.\d+)*)\b/gi, ''))
}

export const detectProject = (text: string, fileNames: string[] = []): DetectedProject => {
  const body = String(text || '')
  const ppm = body.match(LABELLED_PPM) ?? fileNames.map((name) => name.match(LABELLED_PPM)).find(Boolean) ?? null
  const ppmId = ppm ? ppm[1].replace(/[-_/]+$/, '').toUpperCase() : null

  const labelled = body.match(LABELLED_NAME)
  const name =
    usableName(labelled?.[1]) ?? (labelled && !tidy(labelled[1] || '') ? usableName(labelled[2]) : null)
    ?? titleOf(body)
    ?? fileNames.map(fileTitle).find(Boolean)
    ?? null
  return { ppmId, name }
}
