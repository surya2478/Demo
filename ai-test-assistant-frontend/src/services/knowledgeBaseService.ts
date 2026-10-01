import api from './api'

// The Knowledge Base page's own stages: sources, Journey KB, application model,
// test data and reconcile (backend: routers/knowledge_base_page.py). Crawl and
// Automation KB stages reuse the Discovery screen and automationService.

const BASE = '/automation/knowledge-base'

export type ElementStatus = 'MATCH' | 'LABEL_DRIFT' | 'REF_BROKEN' | 'NOT_CRAWLED' | 'NOT_IN_DESIGN' | 'NO_ELEMENT' | 'UNRESOLVED'
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
}

export interface JourneyStepLink {
  status: ElementStatus
  automation_target: string | null
  app_labels: string[]
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
  kind: 'goto' | 'screen' | 'fill' | 'otp' | 'click' | 'capture' | 'skip'
  screen_id: string | null
  optional: boolean
  variable?: string | null
  text_variable?: string | null
  reason?: string
  /** A click that would submit, confirm, pay, save or delete. */
  risky?: boolean
  expected?: string | null
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
}

export interface WalkFlow { flow_id: string; flow_name: string; category: string | null; steps: number }
export interface WalkCapabilities { headed_available: boolean; blocked_environments: string[] }

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
  status: 'done' | 'skipped' | 'not_found' | 'not_applicable' | 'error' | 'stopped'
  error?: string
  reason?: string
  url?: string
  /** shot-<n>.png in the run's workspace, served by crawlImage. */
  screenshot?: string
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
  source?: 'journey' | 'flow'
  stop_before?: number | null
  stop_reason?: string | null
  result?: {
    rows: CrawlRow[]; steps: CrawlStep[]; blockers: string[]; final_url: string | null
    summary: Partial<Record<CrawlOutcome | 'app_only', number>>
    inventory?: InventoryPage[]
  } | null
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
  crawls: { journey_id: string; crawl_id: number; started_by: string | null; started_at: string; status: string; summary: Record<string, number> | null }[]
  created_by: string | null
  created_at: string | null
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

export interface JourneyRemovalPreview {
  journeys: number
  authored: string[]
  dependents: { journey_id: string; name: string; relation: string }[]
}

/** A 409 from approve/revert: the file changed after the draft was made. */
export interface ConflictDetail { message: string; conflicts: { file: string; path: string | null; reason: string }[] }

const enc = encodeURIComponent

const knowledgeBaseService = {
  listApps: async (): Promise<JourneyKbApp[]> => (await api.get(`${BASE}/apps`)).data.apps,
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
    stop_before?: number | null; allow_risky?: boolean; headed?: boolean
  }): Promise<JourneyCrawl> =>
    (await api.post(`${BASE}/${enc(app)}/journey-crawl`, body)).data,
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
    return (await api.post(`${BASE}/${enc(app)}/documents`, form, { timeout: 120_000 })).data
  },
  document: async (id: number): Promise<SourceDocument> => (await api.get(`${BASE}/documents/${id}`)).data,
  documentPages: async (id: number): Promise<{ pages: { page: number; text: string }[]; images: boolean }> =>
    (await api.get(`${BASE}/documents/${id}/pages`)).data,
  // Fetched with the auth header, so an <img> cannot load it directly.
  documentPageImage: async (id: number, page: number): Promise<string> =>
    URL.createObjectURL((await api.get(`${BASE}/documents/${id}/pages/${page}.png`, { responseType: 'blob' })).data),
  extractDocument: async (id: number): Promise<SourceDocument> => (await api.post(`${BASE}/documents/${id}/extract`)).data,
  draftFromDocument: async (id: number, selected: string[], edits: Record<string, Record<string, unknown>>, additions: DocumentAddition[] = []):
    Promise<{ document: SourceDocument; change_set: ChangeSet; auto_included: string[] }> =>
    (await api.post(`${BASE}/documents/${id}/draft`, { selected, edits, additions })).data,
  deleteDocument: async (id: number): Promise<void> => { await api.delete(`${BASE}/documents/${id}`) },
  documentImpact: async (id: number, selected: string[], edits: Record<string, Record<string, unknown>>, additions: DocumentAddition[] = []): Promise<KbImpact> =>
    (await api.post(`${BASE}/documents/${id}/impact`, { selected, edits, additions })).data,

  // Change & Heal (backend: services/journeys/impact.py, heal.py)
  changeSetImpact: async (id: number): Promise<KbImpact> => (await api.get(`${BASE}/change-sets/${id}/impact`)).data,
  heals: async (app: string): Promise<KbHeal[]> => (await api.get(`${BASE}/${enc(app)}/heals`)).data.heals,
  heal: async (id: number): Promise<KbHeal> => (await api.get(`${BASE}/heals/${id}`)).data,
  healRecheck: async (id: number): Promise<KbHeal> => (await api.post(`${BASE}/heals/${id}/recheck`)).data,
  healCrawl: async (id: number, body: { journey_id: string; application_id: number; environment?: string | null }): Promise<KbHeal> =>
    (await api.post(`${BASE}/heals/${id}/crawl`, body)).data
}

/** The API's message for a failed call, including a 409's conflict list. */
export const errorText = (err: any): string => {
  const detail = err?.response?.data?.detail
  if (detail && typeof detail === 'object' && 'conflicts' in detail) {
    const c = detail as ConflictDetail
    return `${c.message} ${c.conflicts.map(x => `${x.file}${x.path ? ` · ${x.path}` : ''}: ${x.reason}`).join('; ')}`
  }
  return typeof detail === 'string' ? detail : err?.message ?? 'The request failed.'
}

export default knowledgeBaseService
