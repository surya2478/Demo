/**
 * --- Automation Lab: the Test steps journey, as data ---------------------------
 *
 * Each step gets three lights -- is the element real, is the data stored, does
 * the check prove the step -- read from the generated script (or, for unsaved
 * fixes, from the draft compiled by /lab/cases/:id/steps/preview), never from
 * the step's prose alone. The fix queue is what turns a light green: each fix
 * is a change to the draft that the preview then confirms or does not.
 */
import { stepBlocks } from './labShared'
import type { LabCaseSteps, LabKbElement, LabStep } from '../../types/automation'

export type Lvl = 'ok' | 'warn' | 'bad' | 'na'
export const GLYPH: Record<Lvl, string> = { ok: '✓', warn: '!', bad: '×', na: '–' }

export interface Light { lvl: Lvl; label: string; note: string }

export const worstOf = (levels: Lvl[]): 'ok' | 'warn' | 'bad' =>
  levels.includes('bad') ? 'bad' : levels.includes('warn') ? 'warn' : 'ok'

// --- The script, one block per step ------------------------------------------------------

export type ElementSource = 'page' | 'kb' | 'recorded' | 'value' | 'ai' | 'missing' | 'none'

export interface ScriptBlock {
  /** Its place among every test.step of the script, from 1: what the Script tab marks. */
  index: number
  /** "S1. …": a sign-in step the compiler put before the case's own, from the Knowledge Base. */
  prelude: boolean
  /** The number in the step's title: the case step it compiles, or the sign-in step's. */
  num: number | null
  title: string
  /** The step's body, dedented, without its test.step wrapper. */
  lines: string[]
  source: ElementSource
  confidence: number | null
  /** The expression that acts on the element. */
  locator: string | null
  /** The address a page step opens. */
  address: string | null
  assertions: string[]
}

const isComment = (line: string) => line.trim().startsWith('//')

export const scriptBlocks = (code: string): ScriptBlock[] => {
  const all = code.split('\n')
  return stepBlocks(code).map(({ start, end }, index) => {
    const head = /test\.step\((["'`])(S?)(\d+)\.\s*((?:\\.|(?!\1).)*)\1/.exec(all[start])
    // The block runs to the next step; the step itself closes at its own "});".
    const indent = /^\s*/.exec(all[start])?.[0] ?? ''
    let close = end
    for (let i = start + 1; i <= end; i++) {
      if (all[i].startsWith(`${indent}});`)) { close = i - 1; break }
    }
    const body = all.slice(start + 1, close + 1)
    while (body.length && !body[body.length - 1].trim()) body.pop()
    const pad = Math.min(...body.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length))
    const lines = body.map((l) => l.slice(Number.isFinite(pad) ? pad : 0))
    const live = lines.filter((l) => !isComment(l))
    const action = live.find((l) => /\bpage\.(getBy\w+|locator)\(/.test(l) && !/^\s*await expect\(/.test(l)) ?? null
    const nav = live.find((l) => /\bnavigateTo\(|\bpage\.goto\(/.test(l)) ?? null
    const ai = lines.map((l) => /\[AI-resolved locator, confidence (\d+|\?)\]/.exec(l)).find(Boolean)
    const missing = lines.some((l) => /^\s*\/\/\s*TODO:/.test(l))
    const recorded = lines.some((l) => /\[Guided Discovery\]/.test(l))
    const byValue = lines.some((l) => /^\/\/ Picks the item named by /.test(l.trim()))
    const source: ElementSource = missing ? 'missing' : ai ? 'ai' : recorded ? 'recorded' : byValue ? 'value' : action ? 'kb' : nav ? 'page' : 'none'
    return {
      index: index + 1,
      prelude: head?.[2] === 'S',
      num: head ? Number(head[3]) : null,
      title: head ? head[4].replace(/\\(["'`\\])/g, '$1').replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))) : '',
      lines,
      source,
      confidence: ai && ai[1] !== '?' ? Number(ai[1]) : null,
      locator: action ? action.trim().replace(/^(await\s+)?(const \w+ = )?/, '').replace(/;\s*$/, '') : null,
      address: nav ? /["'`]([^"'`]+)["'`]/.exec(nav)?.[1] ?? null : null,
      assertions: live.filter((l) => /\bexpect\(/.test(l)).map((l) => l.trim())
    }
  })
}

/** Steps whose element is guessed or not found: the Test steps tab's badge. */
export const stepsNeedingAttention = (code: string) =>
  scriptBlocks(code).filter((b) => b.source === 'ai' || b.source === 'missing').length

/** A case's strip in the case list, from its script alone (the open case reports its own). */
/** The case's own steps, in order: the sign-in steps before them are not the case's. */
export const caseBlocks = (blocks: ScriptBlock[]) => blocks.filter((b) => !b.prelude)

export const caseStrip = (code: string | null | undefined, steps: number): Lvl[] => {
  if (!code) return Array.from({ length: Math.max(1, steps) }, () => 'na' as Lvl)
  const blocks = scriptBlocks(code)
  if (!blocks.length) return Array.from({ length: Math.max(1, steps) }, () => 'na' as Lvl)
  const level = (b: ScriptBlock): Lvl => {
    const comment = b.lines.some((l) => /^\/\/ expected:/.test(l.trim()))
    const placeholder = b.lines.some((l) => l.includes('<<'))
    return worstOf([
      b.source === 'missing' ? 'bad' : b.source === 'ai' ? 'warn' : 'ok',
      placeholder ? 'bad' : 'ok',
      comment && !b.assertions.length ? 'warn' : 'ok'
    ])
  }
  // One mark per sign-in step, then one per case step -- as the Test steps tab
  // counts them. A case step with no block of its own was replaced by the
  // sign-in when there is one, and is missing from the script when there is not.
  const prelude = blocks.filter((b) => b.prelude)
  const own = caseBlocks(blocks)
  const count = Math.max(steps, ...own.map((b) => b.num ?? 0))
  const marks = Array.from({ length: count }, (_, i): Lvl => {
    const b = own.find((x) => x.num === i + 1)
    return b ? level(b) : prelude.length ? 'ok' : 'warn'
  })
  return [...prelude.map(level), ...marks]
}

// --- The draft the fixes change ------------------------------------------------------------

export interface DraftStep extends Omit<LabStep, 'step_number'> { uid: string }
export interface DraftData {
  uid: string
  key: string
  description: string
  sensitive: boolean
  /** Test Data already holds a value for the run environment. */
  hasValue: boolean
  /** The stored value, when it is not sensitive. */
  stored: string | null
  /** Typed here; undefined keeps what Test Data holds. */
  value?: string
}
export interface Draft { title: string; preconditions: string; expected_result: string; steps: DraftStep[]; data: DraftData[] }

export const toDraft = (src: LabCaseSteps): Draft => ({
  title: src.title,
  preconditions: src.preconditions,
  expected_result: src.expected_result,
  steps: src.steps.map(({ step_number: n, ...s }) => ({ ...s, uid: `s${n}` })),
  data: src.test_data.map((d, i) => ({
    uid: `d${i + 1}`, key: d.key, description: d.description ?? '', sensitive: d.sensitive, hasValue: d.has_value, stored: d.value
  }))
})

const sig = (s: Omit<LabStep, 'step_number'>) =>
  [s.action, s.action_type ?? '', s.target ?? '', s.test_data_ref ?? '', s.expected_result ?? ''].map((v) => v.trim()).join('\u0001')

export const sameSteps = (a: DraftStep[], b: DraftStep[]) =>
  a.length === b.length && a.every((s, i) => s.uid === b[i].uid && sig(s) === sig(b[i]))

export const isPlaceholder = (ref: string | null | undefined) => Boolean(ref && ref.trim().startsWith('<<'))

/** A fill step aimed at both the username and the password: one value cannot fill two fields. */
export const isCombinedLogin = (step: { action_type: string | null; target: string | null; action: string }) =>
  step.action_type === 'fill' && /user|e-?mail|login/i.test(`${step.target} ${step.action}`) && /pass/i.test(`${step.target} ${step.action}`)

const acted = (s: DraftStep) => `${s.action} ${s.target ?? ''}`.toLowerCase()

/** A value written into the step text instead of read from Test Data: 'TL123456'. */
export const hardCoded = (s: DraftStep): string | null => {
  if (s.test_data_ref || s.action_type === 'navigate') return null
  const quoted = Array.from(s.action.matchAll(/[‘'"“]([^‘’'"“”\n]{2,60})[’'"”]/g)).map((m) => m[1].trim())
  const isData = (v: string) => (s.action_type === 'fill' || s.action_type === 'select' ? true : /\d/.test(v) && v.length >= 3)
  return quoted.find(isData) ?? null
}

// --- Lights ------------------------------------------------------------------------------------

const short = (v: string, n = 28) => (v.length > n ? `${v.slice(0, n - 1)}…` : v)
const literalsOf = (line: string) => Array.from(line.matchAll(/(["'`])((?:(?!\1).){2,80})\1/g)).map((m) => m[2])

const checkKind = (line: string) =>
  /toHaveURL/.test(line) ? 'URL asserted'
    : /toHaveValue/.test(line) ? 'Value asserted'
      : /not\.toBeEmpty/.test(line) ? 'Not empty'
        : /getByRole\('dialog'/.test(line) && !/getByRole\('heading'/.test(line) ? 'Dialog asserted'
          : /getByRole\('heading'/.test(line) ? 'Heading asserted'
            : /getByRole\('row'/.test(line) ? 'Row visible'
              : /getByText/.test(line) ? 'Text asserted'
                : 'Visible asserted'

export interface StepView {
  uid: string
  /** 1, 2, … for the case's steps; S1, S2, … for the sign-in steps. */
  label: string
  prelude: boolean
  n: number
  step: DraftStep
  block: ScriptBlock | null
  /** The block comes from the unsaved draft's preview, not the saved script. */
  changed: boolean
  /** Lines of the block the saved script does not have. */
  added: Set<number>
  /** The compiler put the Knowledge Base's sign-in in place of this step. */
  replaced: boolean
  el: Light
  data: Light
  check: Light
  worst: 'ok' | 'warn' | 'bad'
}

export interface Ctx { env: string; hasScript: boolean; pending: boolean }

export const elementLight = (s: DraftStep, b: ScriptBlock | null, ctx: Ctx): Light => {
  if (!b) {
    return ctx.pending
      ? { lvl: 'na', label: 'Compiling…', note: 'The unsaved steps are being compiled.' }
      : ctx.hasScript
        ? { lvl: 'warn', label: 'Not in script', note: 'The script has no step for this one: it was generated from other steps. Regenerate it.' }
        : { lvl: 'warn', label: 'No script', note: 'There is no script yet, so nothing says which element this step acts on. Generate it.' }
  }
  const target = s.target || ''
  switch (b.source) {
    case 'page': return { lvl: 'ok', label: 'Page URL', note: b.address ? `navigateTo('${b.address}')` : 'Opens the page.' }
    case 'kb': return { lvl: 'ok', label: `KB · ${short(target || 'element')}`, note: `Knowledge Base element: ${b.locator}` }
    case 'value': return { lvl: 'ok', label: 'Text of the value', note: `Clicks the item showing the Test Data value ${s.test_data_ref ?? ''}: ${b.locator}` }
    case 'recorded': return { lvl: 'ok', label: `Recorded · ${short(target || 'element')}`, note: `Recorded in a guided walk: ${b.locator}` }
    case 'ai': return {
      lvl: 'warn',
      label: `AI-guessed${b.confidence != null ? ` · ${b.confidence}` : ''}`,
      note: `AI guessed ${b.locator ?? 'the locator'}${b.confidence != null ? ` at confidence ${b.confidence}` : ''}. The Knowledge Base has not confirmed it.`
    }
    case 'missing': return {
      lvl: 'bad',
      label: 'Not found',
      note: `No discovered element matches “${target || s.action}”. The page was not crawled, or it renders differently.`
    }
    default: return s.action_type === 'wait'
      ? { lvl: 'na', label: 'None', note: 'A wait acts on no element.' }
      : { lvl: 'na', label: 'No element', note: 'The script acts on no element in this step.' }
  }
}

export const dataLight = (s: DraftStep, data: DraftData[], ctx: Ctx, b: ScriptBlock | null = null): Light => {
  const ref = (s.test_data_ref ?? '').trim()
  if (ref && isPlaceholder(ref)) return { lvl: 'bad', label: 'Placeholder', note: `${ref} is a placeholder, not a Test Data key. Name the value in the editor.` }
  if (ref && isCombinedLogin(s)) return { lvl: 'warn', label: '1 value, 2 fields', note: `${ref} is one value, but the step fills a username field and a password field.` }
  if (ref) {
    const d = data.find((x) => x.key === ref)
    const typed = Boolean(d?.value && d.value.trim())
    // The step names the key, but the code it compiled to may still type the value itself.
    const variable = ref.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()
    if (b && !b.lines.some((l) => !isComment(l) && new RegExp(`\\b${variable}\\b`).test(l))) {
      return { lvl: 'warn', label: 'Not read by script', note: `The step names ${ref}, but its script line does not read it, so the value in the code is used whatever Test Data holds.` }
    }
    if (d && (d.hasValue || typed)) {
      const shown = d.sensitive ? 'a masked value' : `“${typed ? d.value : d.stored}”`
      return { lvl: 'ok', label: short(ref), note: `${ref} has ${shown} for ${ctx.env}${typed ? ', saved with the case' : ''}.` }
    }
    return { lvl: 'warn', label: `Needs ${ctx.env} value`, note: `${ref} has no value for ${ctx.env} yet. Add it under Test data.` }
  }
  const lit = hardCoded(s)
  if (lit) return { lvl: 'warn', label: `Hard-coded ${short(lit, 16)}`, note: `${lit} is typed into the step text, not read from Test Data, so no other environment can override it.` }
  return { lvl: 'na', label: 'None', note: 'No test data needed.' }
}

export const checkLight = (s: DraftStep, b: ScriptBlock | null, ctx: Ctx): Light => {
  if (!b) return { lvl: 'na', label: ctx.pending ? 'Compiling…' : ctx.hasScript ? 'Not in script' : 'No script', note: ctx.pending ? 'The unsaved steps are being compiled.' : 'Nothing checks this step until the script has it.' }
  if (b.assertions.length) {
    // A value the step clicked was on the page before the click: seeing it
    // afterwards proves nothing.
    const actedOn = acted(s)
    const weakAllowed = s.action_type === 'click' || s.action_type === 'navigate' || (!s.action_type && /\bclick/i.test(s.action))
    // Only a text check: a heading or dialog with that name is not the link that was clicked.
    const weak = (line: string) => weakAllowed && /getByText\(/.test(line) && !/getByRole\('(heading|dialog)'/.test(line) && /toBeVisible/.test(line)
      && literalsOf(line).some((l) => actedOn.includes(l.toLowerCase()))
    const strong = b.assertions.filter((a) => !weak(a))
    if (!strong.length) {
      const lit = literalsOf(b.assertions[0])[0] ?? 'the element'
      return { lvl: 'bad', label: 'Weak check', note: `Checks that ${lit} is visible. It was already on the page before this step, so this passes even if the step did nothing.` }
    }
    return { lvl: 'ok', label: checkKind(strong[0]), note: `The script asserts ${short(strong[0].replace(/^await\s+/, '').replace(/;$/, ''), 140)}` }
  }
  if ((s.expected_result ?? '').trim()) return { lvl: 'warn', label: 'Comment only', note: 'The expected result is a comment. Nothing confirms the step worked.' }
  return { lvl: 'na', label: 'None', note: 'This step has no expected result to check.' }
}

const norm = (v: string) => v.replace(/…$/, '').replace(/\s+/g, ' ').trim().toLowerCase()

/** The case step a block compiles, by the number in its title; null when the titles disagree. */
const blockFor = (blocks: ScriptBlock[], n: number) => blocks.find((b) => b.num === n) ?? null

/** Every block of the script names the case step it compiles: it was generated from these steps. */
export const scriptInSync = (savedAll: ScriptBlock[], steps: DraftStep[]) =>
  caseBlocks(savedAll).every((b) => {
    const s = b.num ? steps[b.num - 1] : undefined
    if (!s) return false
    const t = norm(b.title).slice(0, 50)
    const a = norm(s.action).slice(0, 50)
    return Boolean(t) && (a.startsWith(t) || t.startsWith(a))
  })

const PRELUDE_NOTE = 'Signs in first, as the Knowledge Base records it for this application. It changes when the Knowledge Base does.'

export const viewSteps = (
  draft: Draft,
  base: Draft,
  savedAll: ScriptBlock[],
  previewAll: ScriptBlock[] | null,
  ctx: Omit<Ctx, 'pending'>
): StepView[] => {
  const dirty = !sameSteps(draft.steps, base.steps)
  const saved = caseBlocks(savedAll)
  const preview = previewAll ? caseBlocks(previewAll) : null
  const inSync = scriptInSync(savedAll, base.steps)

  // The sign-in steps run first; the preview's, once there is one, are what saving produces.
  const pre = (dirty && previewAll ? previewAll : savedAll).filter((b) => b.prelude)
  const prelude: StepView[] = pre.map((block) => {
    const step: DraftStep = { uid: `pre${block.num}`, action: block.title || 'Sign in', action_type: null, target: block.title, test_data_ref: null, expected_result: null }
    const c: Ctx = { ...ctx, pending: false }
    const el = elementLight(step, block, c)
    const reads = block.lines.some((l) => !isComment(l) && /\.(fill|selectOption)\(\s*[a-z_][a-z0-9_]*\s*\)/.test(l))
    const data: Light = reads ? { lvl: 'ok', label: 'Test data', note: 'Reads its value from Test Data.' } : { lvl: 'na', label: 'None', note: 'No test data needed.' }
    const check = block.assertions.length ? checkLight(step, block, c) : { lvl: 'na' as Lvl, label: 'None', note: 'The next step shows whether this one worked.' }
    return {
      uid: step.uid, label: `S${block.num}`, prelude: true, n: block.index, step, block, changed: false, added: new Set<number>(), replaced: false,
      el: { ...el, note: `${el.note} ${PRELUDE_NOTE}` }, data, check, worst: worstOf([el.lvl, data.lvl, check.lvl])
    }
  })

  const signIn = pre.length ? `S${pre[0].num}–S${pre[pre.length - 1].num}` : ''
  const own = draft.steps.map((step, i): StepView => {
    const j = base.steps.findIndex((b) => b.uid === step.uid)
    const unchanged = j >= 0 && sig(base.steps[j]) === sig(step)
    // A step as saved keeps the saved script's block: it carries the locators
    // the AI agent resolved, which the preview does not ask for.
    let block: ScriptBlock | null = null
    let changed = false
    let from: ScriptBlock[] | null = savedAll
    if (!dirty) block = blockFor(saved, i + 1)
    else if (unchanged && inSync) block = blockFor(saved, j + 1)
    else if (preview) { block = blockFor(preview, i + 1); changed = !unchanged || !inSync; from = previewAll }
    else from = null
    const before = j >= 0 && inSync ? blockFor(saved, j + 1) : null
    const added = new Set<number>()
    if (changed && block) block.lines.forEach((l, k) => { if (!isComment(l) && l.trim() && !before?.lines.includes(l)) added.add(k) })
    const c: Ctx = { ...ctx, pending: from === null }
    // No block of its own, and a sign-in in front: the compiler signed in from
    // the Knowledge Base instead of typing this step.
    const replaced = !block && from !== null && (from === previewAll || ctx.hasScript) && from.some((b) => b.prelude)
      && /sign|log ?in|credential|password|otp|user ?name|e-?mail/i.test(`${step.action} ${step.target ?? ''}`)
    if (replaced) {
      const el: Light = { lvl: 'ok', label: `Sign-in ${signIn}`, note: `The compiler signs in with the Knowledge Base's steps (${signIn}) instead of typing this one, so its elements are the Knowledge Base's.` }
      const data: Light = { lvl: 'na', label: 'Via sign-in', note: 'The sign-in steps read their own Test Data values.' }
      const check: Light = { lvl: 'na', label: 'Via sign-in', note: 'The sign-in steps check that it worked.' }
      return { uid: step.uid, label: String(i + 1), prelude: false, n: i + 1, step, block, changed, added, replaced, el, data, check, worst: 'ok' }
    }
    const el = elementLight(step, block, c)
    const data = dataLight(step, draft.data, c, block)
    const check = checkLight(step, block, c)
    return { uid: step.uid, label: String(i + 1), prelude: false, n: i + 1, step, block, changed, added, replaced: false, el, data, check, worst: worstOf([el.lvl, data.lvl, check.lvl]) }
  })
  return [...prelude, ...own]
}

// --- Fixes -------------------------------------------------------------------------------------

const words = (v: string) => v.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !['the', 'a', 'an', 'in', 'on', 'of', 'to', 'and', 'field', 'button', 'link', 'click', 'enter', 'type', 'select', 'that', 'with'].includes(w))

const FILL_ROLES = ['textbox', 'searchbox', 'combobox', 'spinbutton', '']

/** The elements a step could mean, best first: what the inspector offers to pick from. */
export const rankElements = (s: DraftStep, elements: LabKbElement[], limit = 20): LabKbElement[] => {
  const want = new Set(words(`${s.target ?? ''} ${s.action}`))
  const pool = elements.filter((e) =>
    s.action_type === 'fill' ? FILL_ROLES.includes(e.role ?? '') : s.action_type === 'click' || s.action_type === 'select' ? e.role !== 'textbox' : true)
  return pool
    .map((e) => { const have = words(e.name); return { e, have: have.length, score: have.filter((w) => want.has(w)).length } })
    // Two shared words, or the whole of a one-word name: one common word ("trade") is not a match.
    .filter((x) => x.score >= 2 || (x.have === 1 && x.score === 1))
    .sort((a, b) => b.score - a.score || a.e.name.length - b.e.name.length)
    .slice(0, limit)
    .map((x) => x.e)
}

/** The Knowledge Base element a step most plausibly names, or null when it is not clear. */
export const matchElement = (s: DraftStep, elements: LabKbElement[]): LabKbElement | null => {
  const want = new Set(words(s.target || s.action))
  if (!want.size) return null
  const pool = elements.filter((e) =>
    s.action_type === 'fill' ? FILL_ROLES.includes(e.role ?? '') : s.action_type === 'click' || s.action_type === 'select' ? e.role !== 'textbox' : true)
  const scored = pool
    .map((e) => {
      const have = new Set(words(e.name))
      const common = Array.from(want).filter((w) => have.has(w)).length
      return { e, score: have.size ? common / new Set([...Array.from(want), ...Array.from(have)]).size : 0 }
    })
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score)
  if (!scored.length || (scored[1] && scored[1].score === scored[0].score && scored[1].e.name !== scored[0].e.name)) return null
  return scored[0].e
}

const GENERIC = new Set(['the', 'a', 'an', 'home', 'login', 'log', 'sign', 'main', 'landing', 'next', 'previous', 'same', 'current', 'new', 'this', 'that', 'user', 'error', 'success', 'confirmation'])

/** An expected result rewritten so the compiler can assert it, or null when nothing in it names a proof. */
export const provableExpected = (s: DraftStep): string | null => {
  const text = (s.expected_result ?? '').trim()
  if (!text) return null
  const actedOn = acted(s)
  const runs = Array.from(text.matchAll(/((?:[A-Z][\w&'/-]*\s+){0,4}[A-Z][\w&'/-]*)/g))
    .map((m) => m[1].split(/\s+/).filter((w, i, all) => !(i === 0 && ['The', 'A', 'An'].includes(w) && all.length > 1)).join(' '))
    .filter((r) => r.length >= 4 && !r.split(' ').every((w) => GENERIC.has(w.toLowerCase())) && !actedOn.includes(r.toLowerCase()))
    .sort((a, b) => b.length - a.length)
  const name = runs[0]
  if (!name) return null
  const stem = text.replace(/[.\s]+$/, '')
  return /\b(modal|dialog|pop-?up|drawer|overlay)\b/i.test(text) ? `${stem}. The ${name} dialog is displayed.` : `${stem}. "${name}" is visible.`
}

const keyFor = (s: DraftStep, lit: string, taken: string[]) => {
  // The name the step gives the value: the Title Case words just before it,
  // "Trade License TL123456" -> trade_license; else the last plain words.
  const before = s.action.split(lit)[0].replace(/[‘'"“]\s*$/, '').trim()
  const tokens = before.split(/\s+/).filter(Boolean)
  // "Trade License number 'TL123456'": the noun after the name is the key's suffix.
  let suffix = ''
  if (tokens.length && /^(number|no\.?|id|code|value|name)$/i.test(tokens[tokens.length - 1])) suffix = tokens.pop()!.toLowerCase().replace(/^no\.?$/, 'number')
  const titled: string[] = []
  for (let i = tokens.length - 1; i >= 0 && titled.length < 4 && /^[A-Z][\w&-]*$/.test(tokens[i]); i--) titled.unshift(tokens[i])
  const named = titled.filter((w) => !GENERIC.has(w.toLowerCase()))
  let key = (named.length ? named.map((w) => w.toLowerCase()) : words(tokens.join(' ')).slice(-2)).join('_').replace(/[^a-z0-9_]/g, '')
  if (key && suffix) key = `${key}_${suffix}`
  else if (key && /\d/.test(lit) && !/(number|id|code|no)$/.test(key)) key = `${key}_number`
  if (!/^[a-z][a-z0-9_]*$/.test(key)) key = 'value'
  let out = key
  for (let i = 2; taken.includes(out); i++) out = `${key}_${i}`
  return out
}

export type FixKind = 'signin' | 'split' | 'data' | 'kb' | 'checks'

export interface FixDef {
  id: string
  kind: FixKind
  title: string
  why: string
  act: string
  doneTxt: string
  /** The steps it touches, by uid in the saved case. */
  uids: string[]
  apply: (d: Draft) => Draft
}

const patchSteps = (d: Draft, uids: string[], patch: (s: DraftStep) => Partial<DraftStep>): Draft =>
  ({ ...d, steps: d.steps.map((s) => (uids.includes(s.uid) ? { ...s, ...patch(s) } : s)) })

/** The fixes the saved case and script call for, in the order the queue lists them. */
export const defineFixes = (base: Draft, views: StepView[], elements: LabKbElement[]): FixDef[] => {
  const fixes: FixDef[] = []
  const byUid = (uid: string) => views.find((v) => v.uid === uid)
  const signIn = views.filter((v) => v.prelude && v.worst !== 'ok')
  views = views.filter((v) => !v.prelude)
  if (signIn.length) {
    fixes.push({
      id: 'signin', kind: 'signin', uids: [],
      title: 'Confirm the sign-in elements',
      why: `Sign-in ${signIn.map((v) => v.label).join(', ')} ${signIn.length === 1 ? 'acts on an element' : 'act on elements'} the crawl did not find. The sign-in comes from the Knowledge Base: crawl the login pages there, then regenerate.`,
      act: '', doneTxt: '', apply: (d) => d
    })
  }

  base.steps.filter((s) => isCombinedLogin(s) && !byUid(s.uid)?.replaced).forEach((old) => {
    const n = byUid(old.uid)?.n
    const pick = (re: RegExp, role: 'fill' | 'click', fallback: string) =>
      elements.find((e) => re.test(e.name) && (role === 'fill' ? FILL_ROLES.includes(e.role ?? '') : e.role !== 'textbox'))?.name ?? fallback
    fixes.push({
      id: `split:${old.uid}`, kind: 'split', uids: [old.uid],
      title: 'Split the login step',
      why: `One value is typed into “${old.target || 'the login fields'}”, which is two fields. Split it into Username, Password and Sign In, each with its own element and value.`,
      act: `Split step ${n}`,
      doneTxt: 'Split into username, password and Sign In. Add their values under Test data.',
      apply: (d) => {
        const i = d.steps.findIndex((s) => s.uid === old.uid)
        if (i < 0) return d
        const steps = [...d.steps]
        steps.splice(i, 1,
          { uid: `${old.uid}.1`, action: 'Enter the username in the Username field', action_type: 'fill', target: pick(/user ?name|e-?mail|login id/i, 'fill', 'Username'), test_data_ref: 'admin_username', expected_result: 'The Username field shows the username.' },
          { uid: `${old.uid}.2`, action: 'Enter the password in the Password field', action_type: 'fill', target: pick(/pass/i, 'fill', 'Password'), test_data_ref: 'admin_password', expected_result: 'The Password field is filled.' },
          { uid: `${old.uid}.3`, action: 'Click the Sign In button', action_type: 'click', target: pick(/sign ?in|log ?in/i, 'click', 'Sign In'), test_data_ref: null, expected_result: old.expected_result })
        const used = new Set(steps.map((s) => s.test_data_ref))
        const data = d.data.filter((x) => x.key !== old.test_data_ref || used.has(x.key))
        for (const key of ['admin_username', 'admin_password']) {
          if (!data.some((x) => x.key === key)) {
            data.push({ uid: `${old.uid}.${key}`, key, description: key === 'admin_username' ? 'Admin username' : 'Admin password · stored masked', sensitive: true, hasValue: false, stored: null })
          }
        }
        return { ...d, steps, data }
      }
    })
  })

  const literals = new Map<string, string[]>()
  base.steps.forEach((s) => { const lit = hardCoded(s); if (lit) literals.set(lit, [...(literals.get(lit) ?? []), s.uid]) })
  const taken = base.data.map((d) => d.key)
  literals.forEach((uids, lit) => {
    const key = keyFor(base.steps.find((s) => s.uid === uids[0])!, lit, taken)
    taken.push(key)
    fixes.push({
      id: `data:${lit}`, kind: 'data', uids,
      title: `Move ${short(lit, 18)} into Test data`,
      why: `${lit} is hard-coded in the step text. Store it as ${key} so another environment can override it.`,
      act: 'Create key',
      doneTxt: `${key} = ${lit}, saved with the case.`,
      apply: (d) => {
        const next = patchSteps(d, uids, () => ({ test_data_ref: key }))
        if (next.data.some((x) => x.key === key)) return next
        return { ...next, data: [...next.data, { uid: `lit.${key}`, key, description: `${lit} · from the step text`, sensitive: false, hasValue: false, stored: null, value: lit }] }
      }
    })
  })

  const guessed = views.filter((v) => v.block && (v.block.source === 'ai' || v.block.source === 'missing'))
  if (guessed.length) {
    const matches = guessed.map((v) => ({ uid: v.uid, el: matchElement(v.step, elements) })).filter((m) => m.el) as { uid: string; el: LabKbElement }[]
    const label = guessed.length === 1 ? `Step ${guessed[0].n}` : `Steps ${guessed.map((v) => v.n).join(', ')}`
    fixes.push({
      id: 'kb', kind: 'kb', uids: guessed.map((v) => v.uid),
      title: guessed.length === 1 ? 'Confirm the guessed element' : 'Confirm the guessed elements',
      why: matches.length
        ? `${label}: ${guessed.length} locator${guessed.length === 1 ? ' was' : 's were'} guessed or not found. ${matches.length} match${matches.length === 1 ? 'es' : ''} a Knowledge Base element by name${matches.length < guessed.length ? '; crawl the page for the rest' : ''}.`
        : `${label}: no Knowledge Base element matches. Crawl the page in the Knowledge Base so they are matched against real elements, or pick one in the inspector.`,
      act: matches.length ? `Match ${matches.length} to the KB` : '',
      doneTxt: `Matched to ${matches.length} Knowledge Base element${matches.length === 1 ? '' : 's'}: ${matches.map((m) => m.el.name).join(', ')}.`,
      apply: (d) => ({ ...d, steps: d.steps.map((s) => { const m = matches.find((x) => x.uid === s.uid); return m ? { ...s, target: m.el.name } : s }) })
    })
  }

  const unproven = views.filter((v) => v.check.lvl === 'warn' || v.check.lvl === 'bad')
  if (unproven.length) {
    const rewrites = unproven.map((v) => ({ uid: v.uid, expected: provableExpected(v.step) })).filter((r) => r.expected) as { uid: string; expected: string }[]
    const weak = unproven.filter((v) => v.check.lvl === 'bad')
    fixes.push({
      id: 'checks', kind: 'checks', uids: unproven.map((v) => v.uid),
      title: 'Make the checks prove the step',
      why: [
        weak.length ? `Step ${weak.map((v) => v.n).join(', ')} checks something that was true before the step ran.` : '',
        `${unproven.length === 1 ? 'Step' : 'Steps'} ${unproven.map((v) => v.n).join(', ')} need${unproven.length === 1 ? 's' : ''} an assertion that proves ${unproven.length === 1 ? 'it' : 'them'}.`,
        rewrites.length ? `${rewrites.length} can be asserted from what the expected result names.` : 'Say what proves each one in the inspector.'
      ].filter(Boolean).join(' '),
      act: rewrites.length ? `Add ${rewrites.length} check${rewrites.length === 1 ? '' : 's'}` : '',
      doneTxt: `${rewrites.length} expected result${rewrites.length === 1 ? '' : 's'} now name what to assert.`,
      apply: (d) => ({ ...d, steps: d.steps.map((s) => { const r = rewrites.find((x) => x.uid === s.uid); return r ? { ...s, expected_result: r.expected } : s }) })
    })
  }
  return fixes
}

const ORDER: FixKind[] = ['split', 'data', 'kb', 'checks']

/** The saved case with the applied fixes, the inspector's edits and the typed values on top. */
export const fold = (base: Draft, fixes: FixDef[], applied: Set<string>, edits: Record<string, Partial<DraftStep>>, values: Record<string, string>): Draft => {
  let d = base
  for (const kind of ORDER) for (const f of fixes) if (f.kind === kind && applied.has(f.id)) d = f.apply(d)
  d = { ...d, steps: d.steps.map((s) => (edits[s.uid] ? { ...s, ...edits[s.uid] } : s)) }
  return { ...d, data: d.data.map((x) => (values[x.key] !== undefined ? { ...x, value: values[x.key] } : x)) }
}

/** Where a fix lands in the draft now: a split step's uid became three. */
export const stepsOf = (draft: Draft, uids: string[]) =>
  draft.steps.map((s, i) => (uids.some((u) => s.uid === u || s.uid.startsWith(`${u}.`)) ? i + 1 : 0)).filter(Boolean)

export const stepRange = (ns: number[]) =>
  !ns.length ? '' : ns.length === 1 ? `Step ${ns[0]}` : ns.every((n, i) => i === 0 || n === ns[i - 1] + 1) ? `Steps ${ns[0]}–${ns[ns.length - 1]}` : `Steps ${ns.join(', ')}`
