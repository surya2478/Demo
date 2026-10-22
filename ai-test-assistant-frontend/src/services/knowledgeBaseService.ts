import api from './api'
import { makeLocalPairing } from './localRunner'

// The Knowledge Base page's own stages: sources, Journey KB, application model,
// test data and reconcile (backend: routers/knowledge_base_page.py). Crawl and
// Automation KB stages reuse the Discovery screen and automationService.

const BASE = '/automation/knowledge-base'

const makeCollectorPairing = (crawl: { id: number; base_url?: string | null }, token: string): string => {
  const apiBase = new URL(String(api.defaults.baseURL || '/'), window.location.origin).toString().replace(/\/$/, '')
  const raw = JSON.stringify({
    api: apiBase,
    id: crawl.id,
    token,
    origin: new URL(crawl.base_url || '').origin,
    studio: window.location.origin
  })
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export type ElementStatus = 'MATCH' | 'LABEL_DRIFT' | 'REF_BROKEN' | 'NOT_CRAWLED' | 'NOT_IN_DESIGN' | 'NO_ELEMENT' | 'UNRESOLVED'
  /** A step done by a recorded selector or an address: confirmed by the last walk, or not walked yet. */
  | 'CONFIRMED' | 'RECORDED'
export type JourneyStatus = 'detailed' | 'source_available' | 'awaiting_source' | 'automation_only' | 'partial'

export interface JourneyKbApp {
  app_id: string
  app_name: string
  automation_app_id: string
}

export interface KbOverview {
  app_id: string
  app_name: string
  automation_app_id: string
  base_url: string | null
  journeys: { total: number; by_status: Partial<Record<JourneyStatus, number>>; authored: number; open_questions: number }
  chapters: { id: string; title: string; status: JourneyStatus; journeys: number }[]
  screens: { catalogued: number; elements: number; linked: number }
  sources: { documents: number }
  automation: { flows: number; selectors: number }
  reconcile: Partial<Record<ElementStatus, number>>
}

export interface KbSource {
  document: string
  type: 'master_list' | 'screen_flow'
  journeys: { id: string; title: string; status: JourneyStatus }[]
  extraction: 'transcribed' | 'approved' | 'partly_approved' | 'not_extracted'
  feeds?: string
}

export interface TaxonomyNode {
  id: string
  title: string
  kind: 'chapter' | 'group' | 'journey' | 'variant' | 'shared'
  level: number
  chapter: string
  parent: string | null
  children: string[]
  status: JourneyStatus
  audience?: string
}

export interface KbTaxonomy {
  summary: { total_nodes: number; journey_status_counts: Record<string, number> }
  roots: string[]
  nodes: TaxonomyNode[]
  authored: string[]
  /** Journeys whose flow matches them and whose every step a walk confirmed. */
  verified?: string[]
}

export interface JourneyStepLink {
  status: ElementStatus
  automation_target: string | null
  app_labels: string[]
  /** Why the step's element cannot be resolved, when it cannot. */
  note?: string
}

export interface JourneyStep {
  step_number: number
  action: string
  expected_result: string
  screen_id?: string
  screen_name?: string | null
  element_id?: string
  branch?: string
  rule?: string
  note?: string
  link: JourneyStepLink
}

export interface JourneyDetail {
  node: TaxonomyNode & { sources?: string[]; description?: string; roles?: string[]; entry_point?: string }
  journey: null | {
    journey_id: string
    name: string
    journey_path: string[]
    sources: string[]
    roles: string[]
    shared?: boolean
    steps: JourneyStep[]
    chain: { journey_id: string; name: string }[]
    next: { journey_id: string; name: string }[]
    conditional_branches: JourneyBranch[]
    test_scenarios: JourneyScenario[]
    prerequisite_journeys?: string[]
    next_journeys?: string[]
    open_questions: string[]
    rules: { rule_id: string; type: string; statement: string; message?: string; basis: string }[]
    used_by: { journey_id: string; name: string; relation: string }[]
    /** The flow matches the journey and a walk confirmed every step. */
    verified?: boolean
  }
}

export interface ModelScreen {
  screen_id: string
  name: string
  route: string | null
  route_ref: string | null
  route_in_app: string | null
  elements: number
  linked: number
  origin: 'design' | 'both'
  transitions: { on: string; to: string; condition?: string }[]
}

export interface KbModel {
  screens: ModelScreen[]
  app_only_routes: { route_ref: string; route: string }[]
}

export interface ReconcileRow {
  screen_id: string | null
  screen_name: string | null
  element_id: string | null
  design_label: string | null
  type: string | null
  locator_hint: string | null
  journeys: string[]
  status: ElementStatus
  automation_ref: string | null
  automation_target: string | null
  app_labels: string[]
  suggestion: string | null
}

export interface KbReconcile {
  rows: ReconcileRow[]
  summary: Partial<Record<ElementStatus, number>>
}

export interface CoverageCell {
  status: 'ready' | 'missing' | 'external'
  missing: string[]
  matched_keys?: Record<string, string>
}

export interface CoverageProfile {
  profile_id: string
  name: string
  description: string | null
  kind: 'vault' | 'file' | 'external'
  fields: { name: string; variable: string }[]
  state: string | null
  used_by: string[]
  cells: Record<string, CoverageCell>
}

export interface KbTestData {
  vault_app: { id: number; name: string } | null
  environments: string[]
  profiles: CoverageProfile[]
  totals: { ready: number; missing: number; external: number }
}


export type CrawlOutcome = 'confirmed' | 'new' | 'healed' | 'kb_failed' | 'not_found' | 'not_applicable' | 'not_reached'
export type CrawlStatus = 'queued' | 'running' | 'completed' | 'failed'

export interface CrawlPlanItem {
  journey_id: string
  journey_name: string
  step_number: number
  text: string
  kind: 'goto' | 'screen' | 'fill' | 'otp' | 'click' | 'dblclick' | 'hover' | 'focus' | 'check' | 'uncheck' | 'press' | 'select' | 'capture' | 'skip'
  screen_id: string | null
  optional: boolean
  /** A step of a journey this one needs first (sign-in before choosing an organization). */
  setup?: boolean
  variable?: string | null
  text_variable?: string | null
  reason?: string
  /** A click that would submit, confirm, pay, save or delete. */
  risky?: boolean
  expected?: string | null
  screen_options?: string[]
  /** Where the design says this action leads; `expected` marks the outcome this walk expects. */
  expect?: CrawlExpectation[]
}

export interface CrawlExpectation {
  to: string[]
  condition: string | null
  rule: string | null
  effect: string | null
  expected: boolean
}

export interface CrawlScenario {
  scenario_id: string
  type: string
  title: string
  steps: number[]
  rules?: string[]
  branch?: string | null
}

export interface CrawlPlan {
  journey_id: string
  journey_name: string
  scope: string[]
  base_url: string
  profile_id: string | null
  variables: string[]
  items: CrawlPlanItem[]
  source?: 'journey' | 'flow'
  /** Order (1-based) of the first step that will not run, and why. */
  stop_before?: number | null
  stop_reason?: string | null
  first_risky?: number | null
  /** Where the walk begins: the environment's address. */
  entry?: string
  /** The journey's test scenario the chosen test data is for. */
  scenario?: CrawlScenario | null
  warnings?: string[]
  screen_names?: Record<string, string>
}

export interface WalkFlow { flow_id: string; flow_name: string; category: string | null; steps: number }
export type CrawlBrowser = 'chrome' | 'chromium'
export interface WalkCapabilities {
  headed_available: boolean
  blocked_environments: string[]
  /** The browser walks and crawls open unless one is chosen (AUTOMATION_CRAWL_BROWSER). */
  default_browser?: CrawlBrowser
  /** Whether Google Chrome is installed where the backend runs; without it Chrome falls back to Chromium. */
  chrome_installed?: boolean
}

export interface BrowserTabPreview {
  page_id: string | null
  name: string | null
  title: string | null
  url: string | null
  screenshot?: string | null
  viewport: { width: number; height: number }
  elements: { role: string | null; name: string | null; kind: string | null; bounds: { x: number; y: number; width: number; height: number } }[]
}

/** A walk as it runs. */
export interface WalkLive {
  id: number
  status: CrawlStatus
  run_status: string | null
  phase: string | null
  total: number
  current: { order: number; step_number: number; text: string; kind: string } | null
  finished: boolean
  steps: CrawlStep[]
  /** When the latest frame was written (seconds); null before the first. */
  frame_at: number | null
  /** Browser-owned collector progress and a value-free map of its current tab. */
  collector_state?: 'waiting' | 'opening' | 'executing' | 'capturing' | 'completed' | 'failed'
  pages_received?: number
  pages_max?: number
  current_url?: string | null
  connected_at?: string | null
  action_index?: number | null
  action_total?: number | null
  action_text?: string | null
  preview?: BrowserTabPreview | null
}

export interface CrawlRow {
  screen_id: string
  element_id: string
  design_label: string | null
  type: string | null
  outcome: CrawlOutcome
  strategy: string | null
  selector: string | null
  ambiguous: boolean
  app_label: string | null
  label_differs: boolean
  data_dependent: boolean
  kb_ref: string | null
  kb_target: string | null
  url?: string | null
  /** The journey step this element belongs to; null for the other elements on the journey's screens. */
  step?: number | null
  /** The element belongs to a setup step. */
  setup?: boolean
  /** For an element the walk could not find: the likeliest elements on its screen. */
  candidates?: { selector: string; name: string; role: string; score: number }[]
}

/** One element the walk catalogued on a screen. Never a value. */
export interface InventoryElement {
  role: string
  name: string
  tag: string
  selector: string
  /** Header, footer or menu: on every screen. */
  chrome: boolean
  /** The design element it is, when it is one. */
  matched: string | null
}

export interface InventoryPage {
  screen_id: string | null
  url: string | null
  page: string
  elements: InventoryElement[]
  app_only: number
}

export interface CrawlStep {
  order: number
  journey_id: string
  step_number: number
  kind: string
  screen_id: string | null
  status: 'done' | 'skipped' | 'not_found' | 'not_applicable' | 'error' | 'stopped' | 'not_reached' | 'blocked' | 'off_path' | 'auto'
  error?: string
  reason?: string
  note?: string
  url?: string
  /** The screen the walk recognised there. */
  screen?: string
  /** What an action led to: the expected outcome, a known branch, an error, or nothing. */
  outcome?: { kind: 'expected' | 'branch' | 'error' | 'unexpected' | 'unknown' | 'stuck'; screen?: string | null; rule?: string | null; condition?: string | null; message?: string; url?: string } | null
  /** shot-<n>.png in the run's workspace, served by crawlImage. */
  screenshot?: string
  /** Completed crawl that previously confirmed this step during a recapture. */
  inherited_from_crawl_id?: number
}

/** How a recording did a step: never a typed value, only what kind of field it was. */
export interface RecordedAction {
  kind: 'goto' | 'click' | 'fill' | 'otp' | 'select' | 'check' | 'press' | 'verify'
  target?: string
  route?: string
  field?: string
  label?: string
  option?: string
  key?: string
  url?: string
  led_to?: string
  boxes?: number
  screenshot?: string
  unique?: boolean
  at?: number[]
}

export interface RecordedStep {
  action: string
  expected_result: string
  recorded: RecordedAction
}

/** An action as it is recorded, for the live list. */
export interface RecordingEvent {
  order: number
  kind: RecordedAction['kind']
  label: string | null
  field: string | null
  option: string | null
  url: string | null
  unique: boolean
  screenshot: string | null
}

export interface JourneyCrawl {
  id: number
  app_id: string
  journey_id: string
  journey_name: string | null
  application_id: number | null
  environment: string | null
  profile_id: string | null
  base_url: string | null
  run_key: string | null
  status: CrawlStatus
  error: string | null
  automation_change_set_id: number | null
  journey_change_set_id: number | null
  created_by: string | null
  created_at: string | null
  finished_at: string | null
  summary: Partial<Record<CrawlOutcome, number>> | null
  source?: 'journey' | 'flow' | 'record' | 'capture' | 'browser'
  execution_target?: 'server' | 'local'
  stop_before?: number | null
  stop_reason?: string | null
  browser?: CrawlBrowser | null
  browser_note?: string | null
  result?: {
    /** A recording (source 'record'): what the person did, as journey steps. */
    recording?: RecordedStep[]
    ended?: string | null
    rows: CrawlRow[]; steps: CrawlStep[]; blockers: string[]; final_url: string | null
    summary: Partial<Record<CrawlOutcome | 'app_only' | 'routes_new', number>>
    inventory?: InventoryPage[]
    entry?: { address: string; landed?: string; screen?: string | null; note?: string; fallback?: string; error?: string } | null
    derailed?: { after: number; reason: string } | null
    scenario?: CrawlScenario | null
    routes?: { screen_id: string; path: string; known: string | null; state: 'same' | 'new' | 'differs' }[]
    /** A browser capture (source 'capture'): the uploaded pages and the screen each was matched to. */
    capture?: CaptureInfo
  } | null
}

/** One step of a journey being built from a capture. */
export interface CaptureJourneyStep {
  action: string
  expected_result: string
  page_id: string
  selector: string | null
  note?: string
}

export interface CaptureJourneyDraft {
  title: string
  steps: CaptureJourneyStep[]
  pages: { page_id: string; name: string; path: string | null; screen_id: string | null; screen_name: string | null;
    objects: { selector: string; name: string; type: string; kind: string; chrome: boolean }[] }[]
}

/** A capture the tool sent straight to the app, waiting in the inbox. */
export interface InboxCapture {
  id: number
  app_id: string | null
  environment: string | null
  journey_id: string | null
  name: string | null
  host: string | null
  origin: string | null
  status: 'inbox' | 'imported' | 'discarded'
  pages: number
  elements: number
  first_url: string | null
  crawl_run_id: number | null
  edits: CaptureEdits
  created_by: string | null
  created_at: string | null
}

/** The reviewer's changes to a capture, applied when it is matched or imported. */
export interface CaptureEdits {
  order?: string[]
  dropped_pages?: string[]
  /** page_id -> selectors left out */
  dropped_elements?: Record<string, string[]>
  names?: Record<string, string>
  /** page_id -> screen_id ('' = none) */
  screens?: Record<string, string>
  /** step number -> the object the step uses */
  steps?: Record<string, { page_id: string; selector: string }>
}

export interface CaptureUse {
  screen_id: string
  element_id: string
  design_label: string | null
  step: number | null
  outcome: string | null
  label_differs: boolean
  app_label: string | null
}

export interface CaptureFlowPage {
  page_id: string
  name: string
  url: string | null
  path: string | null
  title: string | null
  screen_id: string | null
  screen_name: string | null
  screen_chosen: boolean
  auto_screen: string | null
  steps: number[]
  elements: { selector: string; name: string; role: string | null; tag: string | null; kind: 'control' | 'text' | 'picked' | string; action: string | null; chrome: boolean; uses: CaptureUse[] }[]
}

export interface CaptureFlowStep {
  order: number
  step_number: number | null
  kind: string
  text: string | null
  setup: boolean
  element_label: string | null
  has_element: boolean
  status: string
  reason: string | null
  page_id: string | null
  selector: string | null
  app_label: string | null
  outcome: string | null
  label_differs: boolean
  chosen: boolean
}

export interface CapturePreview {
  capture: InboxCapture
  journey_id: string
  pages: CaptureFlowPage[]
  steps: CaptureFlowStep[]
  screens: { screen_id: string; name: string }[]
  dropped_pages: { page_id: string; name: string }[]
  summary: Record<string, number>
  notes: string[]
}

export interface CaptureInfo {
  file: string
  format: string
  host?: string | null
  started_at?: string | null
  finished_at?: string | null
  uploaded_by?: string | null
  browser?: string | null
  pages: { page_id: string; name: string; url: string | null; screen_id: string | null; steps?: number[]; elements: number; preview?: BrowserTabPreview | null }[]
  notes: string[]
}

export type ChangeSetStatus = 'draft' | 'published' | 'rejected' | 'conflicted'

export type DocumentStatus = 'uploaded' | 'extracting' | 'extracted' | 'failed' | 'drafted'
export type ItemKind = 'journey' | 'screen' | 'element' | 'rule'
// rename, revise and modify come from a BRD only: it may change what exists.
export type ItemAction = 'add' | 'exists' | 'differs' | 'no_place' | 'rename' | 'revise' | 'modify'

export interface ReviewItem {
  item_id: string
  kind: ItemKind
  action: ItemAction
  selectable: boolean
  selected: boolean
  title: string
  detail?: string | null
  pages: number[]
  evidence?: string
  warnings: string[]
  requires: string[]
  screen_id?: string
  element_id?: string
  journey_id?: string
  value?: Record<string, any>
}

export interface KbImpact {
  counts: { journeys?: number; elements?: number; rules?: number; test_cases?: number; selectors?: number }
  journeys: { journey_id: string; name: string; reasons: string[]; authored: boolean }[]
  elements: { screen_id: string; element_id: string; label: string | null; fields: string[]; new: boolean; automation_ref: string | null; label_changed: boolean }[]
  screens: string[]
  rules: string[]
  automation: { selectors_to_reverify: string[]; flows: string[] }
  crawl_journeys: string[]
  test_cases: { id: number; display_id: string; title: string; journey_id: string | null; approval_status: string; summary: Record<string, number>; steps_touched: number[] }[]
}

export interface KbHeal {
  id: number
  app_id: string
  change_set_id: number | null
  version_id: number | null
  title: string
  source: string | null
  impact: KbImpact
  rediff: { case_id: number; display_id: string; journey_id: string | null; before: Record<string, number>; after: Record<string, number>; changed: boolean; automatable_before?: boolean; automatable_after?: boolean }[]
  recheck: null | { requested_by: string | null; requested_at: string; case_ids: number[]; queued: number; skipped: { case_id: number; reason: string }[]; progress?: Record<string, string> }
  crawls: { journey_id: string; crawl_id: number; mode?: HealCrawlMode; started_by: string | null; started_at: string; status: string; summary: Record<string, number> | null }[]
  created_by: string | null
  created_at: string | null
}

export type HealCrawlMode = 'server' | 'device' | 'collector'
export interface HealCrawlStart {
  heal: KbHeal
  crawl: JourneyCrawl
  mode: HealCrawlMode
  pairing?: string
  expires_in_minutes?: number
}

// A screen or element the reviewer adds -- what the model missed, typically
// something shown only in a screenshot.
export type DocumentAddition =
  | { kind: 'screen'; name: string; purpose?: string; page?: number }
  | { kind: 'element'; screen_id: string; label: string; type: string; page?: number }

export interface CatalogScreen {
  screen_id: string
  name: string
  source: 'kb' | 'proposed'
  elements: { element_id: string; label: string; source: 'kb' | 'proposed' }[]
}

export interface DocumentConversion {
  status: 'none' | 'running' | 'done' | 'failed'
  mode?: 'ai' | 'text'
  images?: boolean
  page?: number
  pages?: number
  model?: string | null
  error?: string | null
  size_bytes?: number
  filename?: string
  finished_at?: string
  ready?: boolean
}

export interface SourceDocument {
  id: number
  app_id: string
  filename: string
  doc_kind: 'screen_flow' | 'brd'
  size_bytes: number
  pages: number | null
  status: DocumentStatus
  error: string | null
  change_set_id: number | null
  change_set_status: ChangeSetStatus | null
  created_by: string | null
  created_at: string | null
  extracted_at: string | null
  counts: Record<string, number> | null
  vision: boolean | null
  model: string | null
  duplicate?: boolean
  // Its structured Word conversion (PDF only; backend services/journeys/doc_convert.py).
  conversion?: DocumentConversion
  // Screens and elements an added journey step may link to (with extraction only).
  catalog?: CatalogScreen[]
  // Rules a step may cite, and journeys a journey may name as next / prerequisite.
  rule_catalog?: { rule_id: string; statement: string | null; source: 'kb' | 'proposed' }[]
  journey_catalog?: { id: string; title: string; authored: boolean }[]
  extraction?: {
    model: string
    vision: boolean
    pages: { page: number; chars: number }[]
    calls: number
    seconds: number
    items: ReviewItem[]
    counts: Record<string, number>
    open_questions: string[]
  }
}


export interface KbValue { present: boolean; value?: unknown }

export interface ChangeSet {
  id: number
  app_id: string
  kb: 'journey' | 'automation'
  title: string
  description: string | null
  source: string
  kind: 'change' | 'defect'
  status: ChangeSetStatus
  created_by: string | null
  created_at: string | null
  decided_by: string | null
  decided_at: string | null
  decision_note: string | null
  published_version_id: number | null
  change_count: number
  changes?: { file: string; op: 'set' | 'remove' | 'create' | 'delete'; path: string; before: KbValue | null; after: KbValue | null; note: string | null }[]
}

export interface KbVersionRow {
  id: number
  kb: 'journey' | 'automation'
  number: number
  change_set_id: number | null
  summary: string | null
  published_by: string | null
  published_at: string | null
  files: string[]
  reverted_by_version_id: number | null
}

export interface ReconcileDecision {
  decision: 'app' | 'both' | 'design' | 'unlink' | 'add'
  screen_id?: string | null
  element_id?: string | null
  automation_ref?: string | null
  app_label?: string | null
  label?: string | null
  note?: string | null
}

export interface JourneyBranch { branch_id: string; at_step: number; condition: string; outcome: string; rule?: string }
export interface JourneyScenario { scenario_id: string; type: string; title: string; steps?: number[]; branch?: string; test_data?: string; rules?: string[] }

export interface ScreenElementDetail {
  element_id: string
  label: string | null
  type: string | null
  automation_ref: string | null
  aliases: string[]
  used_by: { journey_id: string; name: string; step_number: number }[]
}
export interface ScreenDetail { screen_id: string; name: string; elements: ScreenElementDetail[]; used_by: { journey_id: string; name: string; step_number: number }[] }

/** One step as the journey editor sends it; from_step is its number before the edit (null: new). */
export interface JourneyStepEdit {
  from_step: number | null
  action: string
  expected_result: string
  screen_id?: string | null
  element_id?: string | null
}

export interface JourneyEditResult {
  change_set: ChangeSet
  published: boolean
  version?: KbVersionRow | null
  /** Set when publish was asked for but the user may not approve. */
  message?: string
}

// --- Journey Map: the journey's steps, its flow blueprint and selectors, side by side ---------

/** Whether the Automation KB knows how to carry a step out, and whether the last walk confirmed it. */
export type MapCapture = 'confirmed' | 'to_confirm' | 'failed' | 'captured' | 'needs_capture' | 'broken_ref' | 'unknown_element' | 'screen'
/** Whether the flow blueprint says what the journey says. */
export type MapFlowState = 'same' | 'differs' | 'missing' | 'error_path' | 'only_flow'

export interface MapFlowStep { step_number: number; action: string; target: string; expected_result?: string }

export interface MapRow {
  kind: 'step' | 'flow_only'
  step_number?: number
  action?: string
  expected_result?: string
  branch?: string | null
  rule?: string | null
  screen_ids?: string[]
  screen_names?: string[]
  element_id?: string | null
  element_label?: string | null
  element_type?: string | null
  automation_ref?: string | null
  target?: string | null
  target_kind?: 'selector' | 'route' | 'no_selector' | 'broken_ref' | 'unknown_element' | 'none'
  capture: MapCapture | null
  walk_status?: string | null
  walk_reason?: string | null
  walk_selector?: string | null
  flow_step: MapFlowStep | null
  flow_state: MapFlowState
  /** For flow_state 'differs': what the flow blueprint has differently. */
  flow_diff?: ('wording' | 'selector')[]
}

export interface MapSummary { steps: number; mapped: number; confirmed: number; needs_capture: number; failed: number; flow_differs: number; only_in_flow: number }

export interface JourneyMap {
  journey_id: string
  journey_name: string
  flow: { flow_id: string; flow_name: string; steps: number; generated_from?: { journey_id: string; generated_at?: string } | null; up_to_date: boolean } | null
  linked_flow_ids: string[]
  suggested_flows: { flow_id: string; flow_name: string; score: number }[]
  walk: { id: number; environment: string | null; profile_id: string | null; when: string | null; derailed?: { after: number; reason: string } | null } | null
  rows: MapRow[]
  summary: MapSummary
  screens: { screen_id: string; name: string; elements: { element_id: string; label: string | null; type: string | null }[] }[]
}

export interface JourneyMapOverview {
  journeys: { journey_id: string; journey_name: string; flow: JourneyMap['flow']; summary: MapSummary | null; error?: string }[]
  flows: { flow_id: string; flow_name: string; linked: boolean }[]
}

export interface JourneyMapSaveResult extends JourneyEditResult {
  /** The regenerated flow's change set, published with the journey's. */
  flow_change_set?: ChangeSet
}

export interface JourneyRemovalPreview {
  journeys: number
  authored: string[]
  dependents: { journey_id: string; name: string; relation: string }[]
}

/** Where an application stands: registered for crawling, its environments, a Journey KB. */
/** What deleting an application would touch (GET /{app}/deletion). */
export interface AppDeletion {
  app_key: string
  name: string
  test_data: { registered: boolean; environments: string[]; values: number }
  crawl: { registered: boolean; runs: number }
  journey_kb: { exists: boolean; journeys: number; screens: number; documents: number }
  automation_kb: { exists: boolean; shared: boolean }
  pending_change_sets: number
}

export interface AppRegistration {
  app_key: string
  journey_kb: boolean
  app_name: string | null
  data_app_id: number | null
  crawl_app_id: number | null
  application: { id: number; name: string } | null
  default: string | null
  addresses: Record<string, string>
}

export interface NewApplication {
  name: string
  /** The folder both Knowledge Bases share; derived from the name when omitted. */
  app_key?: string
  /** {environment: address} */
  addresses: Record<string, string>
  default_environment?: string
  id_prefix?: string
  /** The master topic list: one journey per line, two spaces of indent per level. */
  outline?: string
}

/** A 409 from approve/revert: the file changed after the draft was made. */
export interface ConflictDetail { message: string; conflicts: { file: string; path: string | null; reason: string }[] }

const enc = encodeURIComponent

const knowledgeBaseService = {
  listApps: async (): Promise<JourneyKbApp[]> => (await api.get(`${BASE}/apps`)).data.apps,
  // Registering an application: Test Data entry, crawl registry and Journey KB in one call.
  registerApplication: async (body: NewApplication): Promise<AppRegistration & { name: string; journey_kb_created: boolean; warnings: string[] }> =>
    (await api.post(`${BASE}/applications`, body)).data,
  registration: async (app: string): Promise<AppRegistration> => (await api.get(`${BASE}/${enc(app)}/registration`)).data,
  createJourneyKb: async (app: string, body: { name?: string; id_prefix?: string; outline?: string }): Promise<JourneyKbApp> =>
    (await api.post(`${BASE}/${enc(app)}/journey-kb`, body)).data,
  /** Renames it in Test Data, the crawl registry and the Journey KB; the key stays. */
  renameApplication: async (app: string, name: string): Promise<{ app_key: string; name: string }> =>
    (await api.put(`${BASE}/${enc(app)}/name`, { name })).data,
  deletionPreview: async (app: string): Promise<AppDeletion> => (await api.get(`${BASE}/${enc(app)}/deletion`)).data,
  /** Deletes it everywhere; its KB folders are moved to knowledge_base/_deleted. `confirm` is its exact name. */
  deleteApplication: async (app: string, confirm: string): Promise<{ deleted: string; name: string; archived_to: string | null; crawl_deactivated: boolean }> =>
    (await api.delete(`${BASE}/${enc(app)}`, { params: { confirm } })).data,
  overview: async (app: string): Promise<KbOverview> => (await api.get(`${BASE}/${enc(app)}/overview`)).data,
  sources: async (app: string): Promise<KbSource[]> => (await api.get(`${BASE}/${enc(app)}/sources`)).data.sources,
  taxonomy: async (app: string): Promise<KbTaxonomy> => (await api.get(`${BASE}/${enc(app)}/taxonomy`)).data,
  journey: async (app: string, journeyId: string): Promise<JourneyDetail> =>
    (await api.get(`${BASE}/${enc(app)}/journeys/${enc(journeyId)}`)).data,
  // Editing journeys. Each edit is drafted as a change set; with publish it is
  // also approved at once (when the user may approve).
  addJourney: async (app: string, parentId: string | null, title: string, publish: boolean): Promise<JourneyEditResult> =>
    (await api.post(`${BASE}/${enc(app)}/journeys`, { parent_id: parentId, title, publish })).data,
  renameJourney: async (app: string, journeyId: string, title: string, publish: boolean): Promise<JourneyEditResult> =>
    (await api.post(`${BASE}/${enc(app)}/journeys/${enc(journeyId)}/rename`, { title, publish })).data,
  journeyRemoval: async (app: string, journeyId: string): Promise<JourneyRemovalPreview> =>
    (await api.get(`${BASE}/${enc(app)}/journeys/${enc(journeyId)}/removal`)).data,
  removeJourney: async (app: string, journeyId: string, publish: boolean): Promise<JourneyEditResult> =>
    (await api.delete(`${BASE}/${enc(app)}/journeys/${enc(journeyId)}`, { params: { publish } })).data,
  editSteps: async (app: string, journeyId: string, steps: JourneyStepEdit[], publish: boolean): Promise<JourneyEditResult> =>
    (await api.put(`${BASE}/${enc(app)}/journeys/${enc(journeyId)}/steps`, { steps, publish })).data,
  journeyMapOverview: async (app: string): Promise<JourneyMapOverview> => (await api.get(`${BASE}/${enc(app)}/journey-map`)).data,
  journeyMap: async (app: string, journeyId: string): Promise<JourneyMap> =>
    (await api.get(`${BASE}/${enc(app)}/journey-map/${enc(journeyId)}`)).data,
  /** Steps edited on the map (or none: regenerate the flow only), and a flow to link for a journey without one. */
  saveJourneyMap: async (app: string, journeyId: string, body: { steps?: JourneyStepEdit[]; link_flow?: string | null; publish: boolean }): Promise<JourneyMapSaveResult> =>
    (await api.post(`${BASE}/${enc(app)}/journey-map/${enc(journeyId)}`, body)).data,
  moveJourney: async (app: string, journeyId: string, direction: 'up' | 'down', publish: boolean): Promise<JourneyEditResult> =>
    (await api.post(`${BASE}/${enc(app)}/journeys/${enc(journeyId)}/move`, { direction, publish })).data,
  editBranches: async (app: string, journeyId: string, items: Partial<JourneyBranch>[], publish: boolean): Promise<JourneyEditResult> =>
    (await api.put(`${BASE}/${enc(app)}/journeys/${enc(journeyId)}/branches`, { items, publish })).data,
  editScenarios: async (app: string, journeyId: string, items: Partial<JourneyScenario>[], publish: boolean): Promise<JourneyEditResult> =>
    (await api.put(`${BASE}/${enc(app)}/journeys/${enc(journeyId)}/scenarios`, { items, publish })).data,
  editLinks: async (app: string, journeyId: string, links: { prerequisite_journeys?: string[]; next_journeys?: string[] }, publish: boolean): Promise<JourneyEditResult> =>
    (await api.put(`${BASE}/${enc(app)}/journeys/${enc(journeyId)}/links`, { ...links, publish })).data,
  screen: async (app: string, screenId: string): Promise<ScreenDetail> =>
    (await api.get(`${BASE}/${enc(app)}/screens/${enc(screenId)}`)).data,
  renameScreen: async (app: string, screenId: string, text: string, publish: boolean): Promise<JourneyEditResult> =>
    (await api.post(`${BASE}/${enc(app)}/screens/${enc(screenId)}/rename`, { text, publish })).data,
  relabelElement: async (app: string, screenId: string, elementId: string, text: string, publish: boolean): Promise<JourneyEditResult> =>
    (await api.post(`${BASE}/${enc(app)}/screens/${enc(screenId)}/elements/${enc(elementId)}/label`, { text, publish })).data,
  removeElement: async (app: string, screenId: string, elementId: string, publish: boolean): Promise<JourneyEditResult> =>
    (await api.delete(`${BASE}/${enc(app)}/screens/${enc(screenId)}/elements/${enc(elementId)}`, { params: { publish } })).data,
  editRule: async (app: string, ruleId: string, statement: string, message: string | null, publish: boolean): Promise<JourneyEditResult> =>
    (await api.put(`${BASE}/${enc(app)}/rules/${enc(ruleId)}`, { statement, message, publish })).data,
  removeRule: async (app: string, ruleId: string, publish: boolean): Promise<JourneyEditResult> =>
    (await api.delete(`${BASE}/${enc(app)}/rules/${enc(ruleId)}`, { params: { publish } })).data,
  /** Correct the steps a drafted change set proposes, before approval. */
  reviseChangeSteps: async (changeSetId: number, position: number, steps: JourneyStepEdit[]): Promise<ChangeSet> =>
    (await api.put(`${BASE}/change-sets/${changeSetId}/changes/${position}/steps`, { steps })).data,
  model: async (app: string): Promise<KbModel> => (await api.get(`${BASE}/${enc(app)}/model`)).data,
  reconcile: async (app: string): Promise<KbReconcile> => (await api.get(`${BASE}/${enc(app)}/reconcile`)).data,
  testData: async (app: string): Promise<KbTestData> => (await api.get(`${BASE}/${enc(app)}/test-data`)).data,

  // Change sets: every edit to either Knowledge Base goes through these.
  changeSets: async (app: string, status?: string): Promise<{ change_sets: ChangeSet[]; pending: number }> =>
    (await api.get(`${BASE}/${enc(app)}/change-sets`, { params: status ? { status } : undefined })).data,
  changeSet: async (id: number): Promise<ChangeSet> => (await api.get(`${BASE}/change-sets/${id}`)).data,
  decide: async (app: string, decision: ReconcileDecision): Promise<ChangeSet> =>
    (await api.post(`${BASE}/${enc(app)}/reconcile/decide`, decision)).data,
  approve: async (id: number, note?: string): Promise<{ version: KbVersionRow | null; change_set: ChangeSet; heal_id?: number | null }> =>
    (await api.post(`${BASE}/change-sets/${id}/approve`, { note: note || null })).data,
  reject: async (id: number, note?: string): Promise<ChangeSet> =>
    (await api.post(`${BASE}/change-sets/${id}/reject`, { note: note || null })).data,
  discard: async (id: number): Promise<void> => { await api.delete(`${BASE}/change-sets/${id}`) },
  versions: async (app: string): Promise<KbVersionRow[]> => (await api.get(`${BASE}/${enc(app)}/versions`)).data.versions,
  revert: async (versionId: number): Promise<KbVersionRow> => (await api.post(`${BASE}/versions/${versionId}/revert`)).data,

  // Journey-guided crawl (backend: services/journeys/journey_crawl.py, crawl_runs.py)
  /** journeyId is a journey id, or "flow:<flow_id>" for a flow blueprint. */
  crawlPlan: async (app: string, journeyId: string, profileId?: string | null, options?: { stop_before?: number | null; allow_risky?: boolean }): Promise<CrawlPlan> =>
    (await api.get(`${BASE}/${enc(app)}/journey-crawl/plan`, {
      params: { journey_id: journeyId, profile_id: profileId || undefined, stop_before: options?.stop_before || undefined, allow_risky: options?.allow_risky || undefined }
    })).data,
  startCrawl: async (app: string, body: {
    journey_id: string; application_id: number; profile_id?: string | null; environment?: string | null
    stop_before?: number | null; allow_risky?: boolean; headed?: boolean; browser?: CrawlBrowser
  }): Promise<JourneyCrawl> =>
    (await api.post(`${BASE}/${enc(app)}/journey-crawl`, body)).data,
  /** Run the generated journey spec through the loopback Playwright runner on this device. */
  startLocalCrawl: async (app: string, body: {
    journey_id: string; application_id: number; profile_id?: string | null; environment?: string | null
    stop_before?: number | null; allow_risky?: boolean; headed?: boolean; capture_step?: number | null
  }): Promise<{ crawl: JourneyCrawl; pairing: string; expires_in_minutes: number }> => {
    const response = (await api.post(`${BASE}/${enc(app)}/local-journey-crawl`, body)).data as {
      crawl: JourneyCrawl; runner_token: string; expires_in_minutes: number
    }
    const pairing = makeLocalPairing({ id: response.crawl.id, token: response.runner_token })
    return { crawl: response.crawl, pairing, expires_in_minutes: response.expires_in_minutes }
  },
  downloadLocalRunner: async (): Promise<string> => {
    const res = await api.get('/automation/local-runner/package', { responseType: 'blob' })
    return URL.createObjectURL(res.data as Blob)
  },
  cancelLocalCrawl: async (id: number): Promise<JourneyCrawl> =>
    (await api.post(`${BASE}/journey-crawls/${id}/cancel-local`)).data,
  /** Pair a cross-browser WebExtension. The returned collector token is valid only for this crawl. */
  startBrowserCrawl: async (app: string, body: {
    journey_id: string; application_id: number; profile_id?: string | null; environment?: string | null; max_pages?: number
    wait_seconds?: number; retry_count?: number; capture_step?: number | null; recapture_of?: number | null
  }): Promise<{ crawl: JourneyCrawl; pairing: string; expires_in_minutes: number }> => {
    const response = (await api.post(`${BASE}/${enc(app)}/browser-crawl`, body)).data as {
      crawl: JourneyCrawl; collector_token: string; expires_in_minutes: number
    }
    const pairing = makeCollectorPairing(response.crawl, response.collector_token)
    return { crawl: response.crawl, pairing, expires_in_minutes: response.expires_in_minutes }
  },
  downloadBrowserCollector: async (engine: 'chromium' | 'firefox' | 'safari'): Promise<string> => {
    const res = await api.get(`/automation/browser-collector/package/${engine}`, {
      params: { studio_origin: window.location.origin }, responseType: 'blob'
    })
    return URL.createObjectURL(res.data as Blob)
  },
  cancelBrowserCrawl: async (id: number, message?: string): Promise<JourneyCrawl> =>
    (await api.post(`${BASE}/journey-crawls/${id}/cancel-browser`, message ? { message } : undefined)).data,
  walkCapabilities: async (): Promise<WalkCapabilities> => (await api.get(`${BASE}/walk/capabilities`)).data,
  walkFlows: async (app: string): Promise<WalkFlow[]> => (await api.get(`${BASE}/${enc(app)}/walk/flows`)).data.flows,
  crawlLive: async (id: number): Promise<WalkLive> => (await api.get(`${BASE}/journey-crawls/${id}/live`)).data,
  /** live.png or shot-<n>.png, as an object URL (the route needs the session's token). */
  crawlImage: async (id: number, name: string): Promise<string> => {
    const res = await api.get(`${BASE}/journey-crawls/${id}/image/${encodeURIComponent(name)}`, { responseType: 'blob' })
    return URL.createObjectURL(res.data as Blob)
  },
  crawls: async (app: string): Promise<JourneyCrawl[]> => (await api.get(`${BASE}/${enc(app)}/journey-crawls`)).data.crawls,
  crawl: async (id: number): Promise<JourneyCrawl> => (await api.get(`${BASE}/journey-crawls/${id}`)).data,
  /** additions: "<screen_id>|<selector>" of app-only elements to add; picks: a candidate for an element (or flow step) not found. */
  proposeFromCrawl: async (id: number, body?: { additions?: string[]; picks?: { screen_id: string; element_id: string; selector: string }[] }): Promise<JourneyCrawl> =>
    (await api.post(`${BASE}/journey-crawls/${id}/propose`, body ?? {})).data,
  /** Record a journey: a browser opens on the server's machine for someone to do it in. */
  /** The browser capture tool's source, for a bookmarklet or the DevTools console. */
  captureTool: async (): Promise<string> =>
    (await api.get(`${BASE}/capture-tool.js`, { responseType: 'text', transformResponse: [(d: string) => d] })).data,
  /** A capture zip (or .json) uploaded as a walk of `journey_id`; reviewed like one. */
  importCapture: async (app: string, body: { file: File; journey_id: string; application_id?: number | null; environment?: string | null }): Promise<JourneyCrawl> => {
    const form = new FormData()
    form.append('file', body.file)
    form.append('journey_id', body.journey_id)
    if (body.application_id != null) form.append('application_id', String(body.application_id))
    if (body.environment) form.append('environment', body.environment)
    return (await api.post(`${BASE}/${enc(app)}/journey-crawl/import`, form)).data
  },
  // The captures inbox: captures the tool sent straight to the app (journey_capture.py).
  receiveCapture: async (capture: unknown, origin: string | null): Promise<InboxCapture> =>
    (await api.post(`${BASE}/captures`, { capture, origin })).data,
  captures: async (app?: string | null, includeDone = false): Promise<InboxCapture[]> =>
    (await api.get(`${BASE}/captures`, { params: { app_id: app || undefined, include_done: includeDone } })).data.captures,
  editCapture: async (id: number, body: { app_id?: string; environment?: string; name?: string; edits?: CaptureEdits; status?: 'inbox' | 'discarded' }): Promise<InboxCapture> =>
    (await api.patch(`${BASE}/captures/${id}`, body)).data,
  previewCapture: async (id: number, body: { journey_id: string; application_id?: number | null; environment?: string | null }): Promise<CapturePreview> =>
    (await api.post(`${BASE}/captures/${id}/preview`, body)).data,
  importInboxCapture: async (id: number, body: { journey_id: string; application_id?: number | null; environment?: string | null }): Promise<JourneyCrawl> =>
    (await api.post(`${BASE}/captures/${id}/import`, body)).data,
  deleteCapture: async (id: number): Promise<void> => { await api.delete(`${BASE}/captures/${id}`) },
  /** Proposed steps and screens for a new journey built from the capture. */
  captureJourneyDraft: async (id: number): Promise<CaptureJourneyDraft> => (await api.get(`${BASE}/captures/${id}/journey-draft`)).data,
  /** The journey (an existing one with no steps, or a new one placed under parent_id) as one change set. */
  createCaptureJourney: async (id: number, body: { journey_id?: string | null; parent_id?: string | null; title?: string | null; steps: CaptureJourneyStep[]; publish: boolean }):
    Promise<JourneyEditResult & { journey_id: string }> => (await api.post(`${BASE}/captures/${id}/journey`, body)).data,
  startRecording: async (app: string, body: { journey_id: string; application_id: number; environment?: string | null }): Promise<JourneyCrawl> =>
    (await api.post(`${BASE}/${enc(app)}/journey-record`, body)).data,
  /** Record it myself in a browser opened by the loopback Playwright runner on this device. */
  startLocalRecording: async (app: string, body: { journey_id: string; application_id: number; environment?: string | null }):
    Promise<{ crawl: JourneyCrawl; pairing: string; expires_in_minutes: number }> => {
    const response = (await api.post(`${BASE}/${enc(app)}/local-journey-record`, body)).data as {
      crawl: JourneyCrawl; runner_token: string; expires_in_minutes: number
    }
    const pairing = makeLocalPairing({ id: response.crawl.id, token: response.runner_token })
    return { crawl: response.crawl, pairing, expires_in_minutes: response.expires_in_minutes }
  },
  finishRecording: async (id: number): Promise<void> => { await api.post(`${BASE}/journey-crawls/${id}/finish`) },
  /** The reviewed recording as the journey's steps, with its flow regenerated. */
  saveRecording: async (id: number, body: { steps: RecordedStep[]; link_flow?: string | null; publish: boolean }): Promise<JourneyMapSaveResult> =>
    (await api.post(`${BASE}/journey-crawls/${id}/save-recording`, body)).data,
  /** A flow blueprint from a journey walk, drafted for review. */
  generateFlow: async (id: number): Promise<{ change_set: ChangeSet; flow: { flow_id: string; flow_name: string; canonical_steps: unknown[] } }> =>
    (await api.post(`${BASE}/journey-crawls/${id}/generate-flow`)).data,

  // Design documents (backend: services/journeys/documents.py)
  documents: async (app: string): Promise<{ documents: SourceDocument[]; vision_model: string | null }> =>
    (await api.get(`${BASE}/${enc(app)}/documents`)).data,
  uploadDocument: async (app: string, file: File, docKind: 'screen_flow' | 'brd'): Promise<SourceDocument> => {
    const form = new FormData()
    form.append('file', file)
    form.append('doc_kind', docKind)
    // Up to 30 MB: allow a slow link the time it needs.
    return (await api.post(`${BASE}/${enc(app)}/documents`, form, { timeout: 600_000 })).data
  },
  document: async (id: number): Promise<SourceDocument> => (await api.get(`${BASE}/documents/${id}`)).data,
  documentPages: async (id: number): Promise<{ pages: { page: number; text: string }[]; images: boolean }> =>
    (await api.get(`${BASE}/documents/${id}/pages`)).data,
  // Fetched with the auth header, so an <img> cannot load it directly.
  documentPageImage: async (id: number, page: number): Promise<string> =>
    URL.createObjectURL((await blobRequest(() => api.get(`${BASE}/documents/${id}/pages/${page}.png`, { responseType: 'blob' }))).data),
  extractDocument: async (id: number): Promise<SourceDocument> => (await api.post(`${BASE}/documents/${id}/extract`)).data,
  /** Add journeys the master list lacks (one change set), then match the document again. */
  placeDocumentJourneys: async (id: number, placements: { title: string; parent_id?: string | null; new_chapter?: string | null }[], publish: boolean): Promise<JourneyEditResult & { document: SourceDocument }> =>
    (await api.post(`${BASE}/documents/${id}/place`, { placements, publish })).data,
  /** Match the stored extraction against the Journey KB as it is now; no model call. */
  rematchDocument: async (id: number): Promise<SourceDocument> => (await api.post(`${BASE}/documents/${id}/rematch`)).data,
  draftFromDocument: async (id: number, selected: string[], edits: Record<string, Record<string, unknown>>, additions: DocumentAddition[] = []):
    Promise<{ document: SourceDocument; change_set: ChangeSet; auto_included: string[] }> =>
    (await api.post(`${BASE}/documents/${id}/draft`, { selected, edits, additions })).data,
  deleteDocument: async (id: number): Promise<void> => { await api.delete(`${BASE}/documents/${id}`) },
  /** Write a PDF up as a structured Word document, page by page (runs in the background). */
  convertDocument: async (id: number, mode: 'ai' | 'text', images: boolean): Promise<DocumentConversion> =>
    (await api.post(`${BASE}/documents/${id}/convert`, { mode, images })).data,
  conversion: async (id: number): Promise<DocumentConversion> => (await api.get(`${BASE}/documents/${id}/convert`)).data,
  downloadConversion: async (id: number): Promise<Blob> =>
    (await blobRequest(() => api.get(`${BASE}/documents/${id}/convert.docx`, { responseType: 'blob', timeout: 600_000 }))).data,
  /** Keep the structured Word document as a Knowledge Base document of its own. */
  addConversion: async (id: number): Promise<SourceDocument> => (await api.post(`${BASE}/documents/${id}/convert/add`)).data,
  documentImpact: async (id: number, selected: string[], edits: Record<string, Record<string, unknown>>, additions: DocumentAddition[] = []): Promise<KbImpact> =>
    (await api.post(`${BASE}/documents/${id}/impact`, { selected, edits, additions })).data,

  // Change & Heal (backend: services/journeys/impact.py, heal.py)
  changeSetImpact: async (id: number): Promise<KbImpact> => (await api.get(`${BASE}/change-sets/${id}/impact`)).data,
  heals: async (app: string): Promise<KbHeal[]> => (await api.get(`${BASE}/${enc(app)}/heals`)).data.heals,
  heal: async (id: number): Promise<KbHeal> => (await api.get(`${BASE}/heals/${id}`)).data,
  healRecheck: async (id: number): Promise<KbHeal> => (await api.post(`${BASE}/heals/${id}/recheck`)).data,
  healCrawl: async (id: number, body: {
    journey_id: string
    application_id: number
    environment?: string | null
    mode: HealCrawlMode
    wait_seconds?: number
    retry_count?: number
    max_pages?: number
    headed?: boolean
  }): Promise<HealCrawlStart> => {
    const response = (await api.post(`${BASE}/heals/${id}/crawl`, body)).data as {
      heal: KbHeal
      crawl: JourneyCrawl
      mode: HealCrawlMode
      runner_token?: string
      collector_token?: string
      expires_in_minutes?: number
    }
    const pairing = response.mode === 'device' && response.runner_token
      ? makeLocalPairing({ id: response.crawl.id, token: response.runner_token })
      : response.mode === 'collector' && response.collector_token
        ? makeCollectorPairing(response.crawl, response.collector_token)
        : undefined
    return { heal: response.heal, crawl: response.crawl, mode: response.mode, pairing, expires_in_minutes: response.expires_in_minutes }
  }
}

/** The API's message for a failed call, including a 409's conflict list. */
/** A blob request whose error body (JSON {detail}) is read back, so errorText can show it. */
async function blobRequest<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch (err: any) {
    const data = err?.response?.data
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      try { err.response.data = JSON.parse(await data.text()) } catch { /* not JSON: keep the generic message */ }
    }
    throw err
  }
}

export const errorText = (err: any): string => {
  const detail = err?.response?.data?.detail
  if (detail && typeof detail === 'object' && 'conflicts' in detail) {
    const c = detail as ConflictDetail
    return `${c.message} ${c.conflicts.map(x => `${x.file}${x.path ? ` · ${x.path}` : ''}: ${x.reason}`).join('; ')}`
  }
  return typeof detail === 'string' ? detail : err?.message ?? 'The request failed.'
}

export default knowledgeBaseService
