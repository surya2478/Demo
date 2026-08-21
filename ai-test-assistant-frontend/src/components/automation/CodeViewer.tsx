/**
 * --- Automation Module: code viewer -------------------------------------
 *
 * Highlights with Prism.highlight rather than Prism.highlightAll. highlightAll
 * walks the whole document and re-highlights every block on the page, which
 * races with React's own DOM updates; highlight() returns a string this
 * component owns. Prism escapes its input, so the markup it produces is safe
 * to inject.
 */
import React, { useMemo, useState } from 'react'
import Prism from 'prismjs'
import 'prismjs/themes/prism.css'
import 'prismjs/components/prism-javascript'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-json'
import { HiOutlineClipboardCopy, HiOutlineCheck, HiOutlineDownload } from 'react-icons/hi'

export type CodeLanguage = 'typescript' | 'javascript' | 'json' | 'plain'

interface CodeViewerProps {
  code: string
  language?: CodeLanguage
  fileName?: string
  /** Line numbers are noise on a three-line snippet; on a spec they are not. */
  showLineNumbers?: boolean
  maxHeight?: string
  className?: string
  /** Offer the source as a file. Useful for a spec someone wants to keep. */
  downloadable?: boolean
}

const grammarFor = (language: CodeLanguage) => {
  switch (language) {
    case 'typescript':
      return { grammar: Prism.languages.typescript, name: 'typescript' }
    case 'javascript':
      return { grammar: Prism.languages.javascript, name: 'javascript' }
    case 'json':
      return { grammar: Prism.languages.json, name: 'json' }
    default:
      return { grammar: null, name: 'plain' }
  }
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

export const CodeViewer: React.FC<CodeViewerProps> = ({
  code,
  language = 'typescript',
  fileName,
  showLineNumbers = true,
  maxHeight = '460px',
  className = '',
  downloadable = false
}) => {
  const [copied, setCopied] = useState(false)

  const html = useMemo(() => {
    const { grammar, name } = grammarFor(language)
    if (!grammar) return escapeHtml(code)
    try {
      return Prism.highlight(code, grammar, name)
    } catch {
      // A grammar that failed to load must not take the panel down with it.
      return escapeHtml(code)
    }
  }, [code, language])

  const lineCount = useMemo(() => code.split('\n').length, [code])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  const handleDownload = () => {
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName || 'spec.ts'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  return (
    <div className={`overflow-hidden rounded-app border border-app bg-app-surface ${className}`.trim()}>
      <div className="flex items-center justify-between gap-3 border-b border-app bg-app-surface-muted px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-[12px] font-semibold text-app-primary">
            {fileName || `${language} snippet`}
          </span>
          <span className="flex-shrink-0 text-[11px] text-app-secondary">
            {lineCount} {lineCount === 1 ? 'line' : 'lines'}
          </span>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          {downloadable && (
            <button
              type="button"
              onClick={handleDownload}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-app-secondary transition hover:bg-app-surface hover:text-app-primary"
              title="Download this file"
            >
              <HiOutlineDownload className="h-3.5 w-3.5" />
              Download
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-app-secondary transition hover:bg-app-surface hover:text-app-primary"
            title="Copy to clipboard"
          >
            {copied ? (
              <>
                <HiOutlineCheck className="h-3.5 w-3.5 text-app-success" />
                Copied
              </>
            ) : (
              <>
                <HiOutlineClipboardCopy className="h-3.5 w-3.5" />
                Copy
              </>
            )}
          </button>
        </div>
      </div>

      <div className="app-scroll overflow-auto" style={{ maxHeight }}>
        <div className="flex min-w-full">
          {showLineNumbers && (
            <div
              aria-hidden
              className="select-none border-r border-app bg-app-surface-muted/60 px-3 py-3 text-right font-mono text-[12px] leading-[1.6] text-app-secondary"
            >
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
          )}
          <pre className="m-0 flex-1 overflow-visible bg-transparent px-3 py-3 font-mono text-[12px] leading-[1.6]">
            <code
              className={`language-${language}`}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </pre>
        </div>
      </div>
    </div>
  )
}

interface CodeEditorProps {
  value: string
  onChange: (next: string) => void
  fileName?: string
  rows?: number
  placeholder?: string
  disabled?: boolean
  className?: string
}

/**
 * A plain monospace textarea, not a highlighted editor.
 *
 * Overlaying a highlighted <pre> behind a transparent textarea is the usual
 * trick and it breaks on tab handling, IME input, and long-line wrapping. For
 * pasting a spec, a textarea that behaves exactly like a textarea is better
 * than a fragile imitation of an IDE.
 */
export const CodeEditor: React.FC<CodeEditorProps> = ({
  value,
  onChange,
  fileName,
  rows = 16,
  placeholder,
  disabled = false,
  className = ''
}) => {
  const lineCount = useMemo(() => value.split('\n').length, [value])

  return (
    <div className={`overflow-hidden rounded-app border border-app bg-app-surface ${className}`.trim()}>
      <div className="flex items-center justify-between border-b border-app bg-app-surface-muted px-3 py-2">
        <span className="truncate font-mono text-[12px] font-semibold text-app-primary">
          {fileName || 'spec.ts'}
        </span>
        <span className="text-[11px] text-app-secondary">
          {lineCount} {lineCount === 1 ? 'line' : 'lines'}
        </span>
      </div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={rows}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        // Tab is left to the browser: trapping it inside a textarea breaks
        // keyboard navigation out of the field.
        className="app-scroll w-full resize-y border-0 bg-transparent px-3 py-3 font-mono text-[12px] leading-[1.6] text-app-primary outline-none disabled:opacity-60"
      />
    </div>
  )
}

export default CodeViewer
