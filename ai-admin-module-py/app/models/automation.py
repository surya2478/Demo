"""
--- Automation Module: new models --------------------------------------------

Studio-owned tables. Three rules hold across all of them:

1. No foreign key into an existing table. `origin_test_case_id` references
   test_cases_details.test_case_id by value only, so no migration ever alters a
   table the review workflow owns and create_all() can add these without
   touching anything that exists.

2. The review workflow's tables are read-only to this module. A refined or
   manually authored case lands here with its provenance recorded; it never
   overwrites a row a human approved.

3. Writes stay coarse. One row per run, updated on state transitions, never per
   log line. Evidence is held as file paths, never as blobs. This database is
   SQLite and already has a background writer; run traffic must not compete
   with it.

Upstream is async SQLAlchemy over Postgres with JSONB. This is sync over
SQLite, so the models are rewritten rather than ported -- mechanical, but not a
copy.
"""
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
)
from sqlalchemy.orm import relationship

from ..database.connection import Base


class AutomationTestCase(Base):
    """A test case available to automate.

    Three sources feed this table and behave identically downstream:

      approved  mirrored from test_cases_details at selection time, so a later
                edit to the approved row cannot silently change what was
                automated
      manual    authored in the Studio, which is what makes the module usable
                before the approval queue contains automation-ready cases
      refined   produced by the refine step from either of the above

    Fields mirror the seven keys the existing generation output uses, so an
    approved case maps across without translation. `steps_structured` holds the
    machine-readable form once refinement produces it -- "Test Steps" arrives
    as one numbered string, which no compiler can consume.
    """

    __tablename__ = "automation_test_cases"

    id = Column(Integer, primary_key=True, index=True)

    source = Column(String(20), nullable=False, default="manual", index=True)
    # By value, not by foreign key -- see the module docstring.
    origin_test_case_id = Column(String(255), nullable=True, index=True)
    origin_request_id = Column(String(255), nullable=True, index=True)
    # The Project (models.database.Project) the case was generated for, taken
    # from its review request. None for cases from anywhere else.
    project_id = Column(Integer, nullable=True, index=True)
    # Set on a refined case, pointing at the row it was derived from.
    parent_id = Column(Integer, ForeignKey("automation_test_cases.id"), nullable=True, index=True)

    display_id = Column(String(100), nullable=False, index=True)
    category = Column(String(255), nullable=True)
    description = Column(Text, nullable=True)
    preconditions = Column(Text, nullable=True)
    steps_raw = Column(Text, nullable=True)
    test_data = Column(Text, nullable=True)
    expected_result = Column(Text, nullable=True)

    # [{step_number, action, target, test_data_ref, expected_result}, ...]
    steps_structured = Column(JSON, nullable=True)
    # [{key, description, example_value, sensitive}, ...] -- `sensitive` is what
    # keeps a credential out of generated code, compiled to an environment
    # lookup instead of a literal.
    test_data_requirements = Column(JSON, nullable=True)
    automation_blockers = Column(JSON, nullable=True)

    # Cached so a list view does not recompute for every row. Recomputed on
    # write, never trusted as the sole source of truth.
    eligibility_score = Column(Integer, nullable=True)
    eligibility_verdict = Column(String(30), nullable=True, index=True)
    eligibility_reasons = Column(JSON, nullable=True)

    # --- Automation TC Coverage Assessment ----------------------------------
    # The workbench columns, ported from stlc-platform's RefinedTestCase.
    #
    # Refinement produces these; the workbench is where a human classifies and
    # approves them. They are separate from eligibility_* on purpose:
    # eligibility is a deterministic "is this fit to automate as written",
    # classification is a decision about whether it SHOULD be automated at all.
    # A case can score 100 and still be manual-only.

    # One sentence stating what the case proves. Distinct from description,
    # which is whatever the source document happened to say.
    objective = Column(Text, nullable=True)
    bdd_scenario = Column(Text, nullable=True)
    priority = Column(String(20), nullable=False, default="Medium")
    test_type = Column(String(50), nullable=True)

    # existing  -- refined in place from a case that already existed
    # imported  -- came in through intake (form, paste, CSV)
    # derived   -- generated to fill a coverage gap, no prior case
    origin = Column(String(20), nullable=False, default="imported", index=True)

    # automation | partial | manual | undecided
    #
    # partial is "automatable once these named edits are made". It exists
    # because the two-way split forced every case with a missing locator or an
    # unwritten expected result into one of two wrong answers: Automation,
    # which compiles a script that fails on its first run, or Manual, which
    # retires a case that only needed a sentence rewritten.
    classification = Column(String(20), nullable=False, default="undecided", index=True)
    # policy | user | agent -- who decided, so a bulk re-run can leave a human
    # decision alone rather than silently overwriting it.
    classification_source = Column(String(30), nullable=True)
    classification_reason = Column(Text, nullable=True)
    manual_only_reasons = Column(JSON, nullable=True)
    # The whole rule report behind the badge: every check (steps, channel,
    # knowledge base, test data) with its findings, each naming its step and
    # what to do about it. The badge carries one sentence; a reviewer approving
    # thirty cases needs the rest, and recomputing it on read would make the
    # grid disagree with the classification it is displaying.
    classification_report = Column(JSON, nullable=True)
    classified_at = Column(DateTime, nullable=True)

    test_data_required = Column(Boolean, nullable=False, default=False)
    # not_required | pending | ready -- pending blocks approval, which is the
    # whole reason it is tracked separately from test_data_requirements.
    test_data_status = Column(String(20), nullable=False, default="not_required", index=True)
    test_data_notes = Column(Text, nullable=True)

    # draft | approved | rejected. Named approval_status rather than `status`
    # because AutomationRun.status already means something else in this module
    # and one of the two would have to be read twice.
    approval_status = Column(String(20), nullable=False, default="draft", index=True)
    decision_reason = Column(Text, nullable=True)
    approved_by = Column(String(255), nullable=True)
    approved_at = Column(DateTime, nullable=True)

    # Bumped when a refinement replaces content in place, so the grid can show
    # v2 without keeping a second row.
    version = Column(Integer, nullable=False, default=1)
    # Resolved at refinement time and frozen, so a later change to the
    # application does not silently invalidate steps already written.
    application_url = Column(Text, nullable=True)

    application_id = Column(Integer, ForeignKey("automation_applications.id"), nullable=True, index=True)

    # --- Grounding ----------------------------------------------------------
    # Whether this case's steps resolve to controls that actually exist in the
    # discovered application.
    #
    #   not_checked        no discovery has been matched against it yet
    #   grounded           every step needing a control found one
    #   partially_grounded some did, some did not -- the useful middle state
    #   ungrounded         none did, or no step names a control at all
    #
    # Kept beside the case rather than computed on read because a catalogue is
    # versioned: the answer belongs to the discovery run it was matched against,
    # and recomputing later against a newer crawl would quietly change history.
    grounding_status = Column(String(30), nullable=False, default="not_checked", index=True)
    # {matched: [...], unresolved: [{step_number, target, reason}], skipped: n}
    # The unresolved list is the point: naming the steps that did NOT match is
    # what stops the generator inventing a locator for them.
    grounding_summary = Column(JSON, nullable=True)
    grounded_at = Column(DateTime, nullable=True)
    discovery_run_id = Column(
        Integer, ForeignKey("automation_discovery_runs.id"), nullable=True, index=True
    )

    # --- Guided Flow Discovery ----------------------------------------------
    # User-recorded ground-truth page objects captured during interactive browser sessions.
    flow_discovery_status = Column(String(30), nullable=False, default="none", index=True)
    # [{step_number, action, target_name, recommended_locator, alternative_locators, page_url, tag_name, accessible_name, role}, ...]
    recorded_flow_objects = Column(JSON, nullable=True)

    # --- Quality Review (eSMART Review Agent) -------------------------------
    review_score = Column(Float, nullable=True)
    review_verdict = Column(String(30), nullable=True, index=True)  # pass | needs_revision | fail
    review_scores = Column(JSON, nullable=True)  # {step_quality, data_readiness, expected_result_clarity, coverage}
    review_findings = Column(JSON, nullable=True)  # {issues: [...], suggestions: [...], coverage_gaps: [...]}
    # AI Checks' Diff step (services/journeys/diff.py): each step compared with
    # the Journey KB (design) and the Automation KB (crawled). Its own column,
    # not folded into review_findings or grounding_summary -- each of those is
    # rewritten by a different step and would drop it.
    # {journey_id, chain, summary: {STATUS: n}, automatable, steps: [...], compared_at}
    journey_diff = Column(JSON, nullable=True)
    reviewed_at = Column(DateTime, nullable=True)

    created_by = Column(String(255), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    parent = relationship("AutomationTestCase", remote_side=[id], backref="refinements")
    scripts = relationship("AutomationScript", back_populates="test_case")

    __table_args__ = (
        CheckConstraint(
            "source IN ('approved', 'manual', 'refined')",
            name="ck_automation_test_case_source",
        ),
    )


class AutomationApplication(Base):
    """A target application: where discovery crawls and tests run.

    --- Automation Module: one identity per application ---------------------

    This table was declared long before anything used it, and in the meantime
    two half-registries grew up beside it: Discovery kept a single global
    `is_current` crawl, and the Knowledge Base identified applications by
    folder name with no link back here. The result was that crawling a second
    application silently retired the first one's catalogue, and every test
    case grounded against it started reporting against the wrong elements.

    So this row is now the single identity. `app_key` is what ties it to its
    Knowledge Base folder, which is why it is unique and required: the runtime
    target (base URL, environment, credentials) lives here, the declarative
    profile lives in knowledge_base/applications/<app_key>/, and neither can
    name an application the other does not know about.

    Credentials are Fernet-encrypted under a key derived from SECRET_KEY and
    are never returned to the browser -- the API exposes only whether they are
    set. A saved password is replaceable, never readable.
    """

    __tablename__ = "automation_applications"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    # The Knowledge Base folder this application's profile and flows live in.
    # Slug-shaped and unique -- it is half of the application's identity.
    app_key = Column(String(100), nullable=False, unique=True, index=True)
    base_url = Column(Text, nullable=False)
    environment = Column(String(50), nullable=False, default="SIT", index=True)
    description = Column(Text, nullable=True)
    # Retired rather than deleted: an application with crawl history and
    # grounded test cases behind it should stop appearing in the picker
    # without taking that history with it.
    is_active = Column(Boolean, nullable=False, default=True, index=True)

    auth_mode = Column(String(20), nullable=False, default="none")
    # Non-secret auth settings only: field selectors, login path, username.
    auth_config = Column(JSON, nullable=True)
    auth_secret_encrypted = Column(Text, nullable=True)

    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        CheckConstraint("auth_mode IN ('none', 'form')", name="ck_automation_app_auth_mode"),
    )


class AutomationScript(Base):
    """A generated script.

    Edits create a new version rather than overwriting, so an approved script
    can always be recovered -- upstream's rule, and the reason `version` and
    `parent_script_id` exist.

    `contract` holds the validated JSON the model produced. Keeping it is what
    makes a bad script diagnosable: it separates a bad contract from a compiler
    fault, which is otherwise guesswork.
    """

    __tablename__ = "automation_scripts"

    id = Column(Integer, primary_key=True, index=True)
    test_case_id = Column(Integer, ForeignKey("automation_test_cases.id"), nullable=False, index=True)

    framework = Column(String(30), nullable=False, index=True)
    language = Column(String(30), nullable=False, default="typescript")
    file_name = Column(String(255), nullable=False)
    code = Column(Text, nullable=False)
    # Multi-file compiled output: {"specs/x.spec.ts": "...", "pages/Y.ts": "..."}
    files = Column(JSON, nullable=True)

    contract = Column(JSON, nullable=True)
    quality_gate = Column(JSON, nullable=True)
    # compiled: rendered deterministically from a contract.
    # raw:      written directly by the model, no compiler backend exists.
    generation_mode = Column(String(20), nullable=False, default="compiled")

    version = Column(Integer, nullable=False, default=1)
    parent_script_id = Column(Integer, ForeignKey("automation_scripts.id"), nullable=True)
    status = Column(String(30), nullable=False, default="draft", index=True)

    # --- Automation Script Lab ----------------------------------------------
    # Ported from stlc-platform's ScriptAsset.

    # Stable handle for one test case + framework pair, so regenerating
    # replaces the right asset instead of accumulating duplicates.
    script_key = Column(String(255), nullable=True, index=True)
    execution_command = Column(Text, nullable=True)
    setup_notes = Column(JSON, nullable=True)
    entry_path = Column(String(500), nullable=True)

    # Lint/compile checks that run before anything is executed. Cheap, and they
    # catch the failures not worth spending a browser on.
    static_gate_result = Column(JSON, nullable=True)

    # not_run | queued | running | passed | failed | blocked
    dry_run_status = Column(String(20), nullable=False, default="not_run", index=True)
    dry_run_summary = Column(JSON, nullable=True)
    dry_run_at = Column(DateTime, nullable=True)
    # The run_key of the AutomationRun that produced the result above. A dry run
    # IS a run -- it reuses the Phase 0 runner, job manager and evidence
    # pipeline rather than adding a second execution path.
    dry_run_key = Column(String(64), nullable=True, index=True)

    # False on superseded versions, so the grid shows one row per test case and
    # framework without a subquery.
    is_current = Column(Boolean, nullable=False, default=True, index=True)
    # Set once a human edits the code, so regeneration can warn before
    # discarding hand-written changes.
    edited_by_user = Column(Boolean, nullable=False, default=False)
    generation_error = Column(Text, nullable=True)

    created_by = Column(String(255), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    test_case = relationship("AutomationTestCase", back_populates="scripts")
    runs = relationship("AutomationRun", back_populates="script")

    __table_args__ = (
        CheckConstraint(
            "framework IN ('playwright', 'katalon', 'appium')",
            name="ck_automation_script_framework",
        ),
        Index("ix_automation_script_tc_framework", "test_case_id", "framework"),
    )


class AutomationRun(Base):
    """One execution.

    `status` is the run's lifecycle. `outcome` is what the tests said, and the
    two are deliberately separate: a run can complete cleanly while every test
    fails, and conflating them is how an infrastructure failure gets reported
    as a test failure.

    `run_config` holds execution settings as one JSON column rather than a
    spread of booleans. Headless-only is the decision today; a headed profile
    later becomes a new value here, not a schema change.
    """

    __tablename__ = "automation_runs"

    id = Column(Integer, primary_key=True, index=True)
    run_key = Column(String(64), nullable=False, unique=True, index=True)

    script_id = Column(Integer, ForeignKey("automation_scripts.id"), nullable=True, index=True)
    test_case_id = Column(Integer, ForeignKey("automation_test_cases.id"), nullable=True, index=True)
    application_id = Column(Integer, ForeignKey("automation_applications.id"), nullable=True)

    framework = Column(String(30), nullable=False, default="playwright")
    environment = Column(String(50), nullable=True, index=True)
    run_config = Column(JSON, nullable=True)

    # queued | running | completed | failed | cancelled
    status = Column(String(30), nullable=False, default="queued", index=True)
    # passed | failed | blocked -- null until the run finishes
    outcome = Column(String(30), nullable=True, index=True)
    error_message = Column(Text, nullable=True)

    total_tests = Column(Integer, nullable=False, default=0)
    passed = Column(Integer, nullable=False, default=0)
    failed = Column(Integer, nullable=False, default=0)
    skipped = Column(Integer, nullable=False, default=0)
    blocked = Column(Integer, nullable=False, default=0)

    duration_seconds = Column(Integer, nullable=True)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)

    workspace_path = Column(Text, nullable=True)
    log_path = Column(Text, nullable=True)
    run_metadata = Column(JSON, nullable=True)

    triggered_by = Column(String(255), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)

    script = relationship("AutomationScript", back_populates="runs")
    test_case = relationship("AutomationTestCase")
    results = relationship(
        "AutomationRunResult", back_populates="run", cascade="all, delete-orphan"
    )

    __table_args__ = (
        CheckConstraint(
            "status IN ('queued', 'running', 'completed', 'failed', 'cancelled')",
            name="ck_automation_run_status",
        ),
        Index("ix_automation_run_status_created", "status", "created_at"),
    )


class AutomationRunResult(Base):
    """One test inside a run.

    The status vocabulary matches the runner's exactly -- pass, fail, skip,
    error, blocked -- so evidence and database never disagree. `blocked` is
    load-bearing: a target that could not be reached tested nothing, and
    recording it as a pass manufactures confidence.

    Artifact columns hold absolute paths on disk. They are served through an
    authenticated route with a traversal guard, never handed to the browser as
    filesystem paths.
    """

    __tablename__ = "automation_run_results"

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, ForeignKey("automation_runs.id"), nullable=False, index=True)

    test_name = Column(String(500), nullable=False)
    status = Column(String(20), nullable=False, index=True)
    duration_ms = Column(Integer, nullable=True)

    error_message = Column(Text, nullable=True)
    stack_trace = Column(Text, nullable=True)

    screenshot_path = Column(Text, nullable=True)
    video_path = Column(Text, nullable=True)
    trace_path = Column(Text, nullable=True)
    console_logs = Column(JSON, nullable=True)
    network_logs = Column(JSON, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)

    run = relationship("AutomationRun", back_populates="results")

    __table_args__ = (
        CheckConstraint(
            "status IN ('pass', 'fail', 'skip', 'error', 'blocked')",
            name="ck_automation_run_result_status",
        ),
    )


class AutomationDiscoveryRun(Base):
    """One crawl of a running application.

    --- Automation Module: Application Discovery ----------------------------

    Discovery answers the question the compiler cannot: what is actually on
    the page. A refined test case says "the Username field"; the application
    might render "Email", or a label with no `for` attribute that no
    accessible-name query can reach. Without a catalogue of real elements the
    generator can only guess, and a wrong guess is not discovered until a run
    goes red fifteen seconds in.

    Versioned rather than overwritten: a test case grounded against version 2
    should not silently start reporting against version 3's catalogue, and an
    old run's evidence still refers to the elements it saw.
    """

    __tablename__ = "automation_discovery_runs"

    id = Column(Integer, primary_key=True, index=True)
    # Which application this crawl catalogued. Required in practice -- the
    # column stays nullable only because rows predating per-application
    # scoping exist, and the migration backfills those rather than dropping
    # them. Every code path below resolves an application first.
    application_id = Column(
        Integer, ForeignKey("automation_applications.id"), nullable=True, index=True
    )

    # Both are per application, not global. `version` counts this
    # application's crawls, and `is_current` marks the one its grounding is
    # judged against -- crawling application B used to retire application A's
    # catalogue, which is exactly the confusion this scoping removes.
    version = Column(Integer, nullable=False, default=1)
    is_current = Column(Boolean, nullable=False, default=True, index=True)

    # queued | running | completed | failed
    status = Column(String(30), nullable=False, default="queued", index=True)
    application_url = Column(Text, nullable=True)
    application_environment = Column(String(50), nullable=True)

    # Kept for the seam: authenticated discovery needs credential storage,
    # which needs a crypto dependency this deployment does not carry yet.
    # Until then every crawl runs as an anonymous visitor.
    auth_mode = Column(String(20), nullable=False, default="none")
    auth_status = Column(String(30), nullable=False, default="not_required")
    auth_detail = Column(Text, nullable=True)

    pages_discovered = Column(Integer, nullable=False, default=0)
    elements_discovered = Column(Integer, nullable=False, default=0)
    explored_pages = Column(JSON, nullable=True)
    # Why a page could not be crawled -- stated, so a thin catalogue explains
    # itself rather than looking like the application has nothing on it.
    blockers = Column(JSON, nullable=True)
    error = Column(Text, nullable=True)

    # The crawl executes through the ordinary runner, so it has a run_key like
    # anything else and its log and evidence are already served.
    run_key = Column(String(64), nullable=True, index=True)

    created_by = Column(String(255), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    elements = relationship(
        "AutomationDiscoveredElement", back_populates="run", cascade="all, delete-orphan"
    )


class AutomationDiscoveredElement(Base):
    """One interactive control found on a page.

    `recommended_locator` is the point of the whole table: a Playwright query
    that was verified to resolve at crawl time, so the generator can emit
    something known to exist instead of a phrase it hoped would match.
    """

    __tablename__ = "automation_discovered_elements"

    id = Column(Integer, primary_key=True, index=True)
    discovery_run_id = Column(
        Integer,
        ForeignKey("automation_discovery_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    page_url = Column(String(1000), nullable=False)
    page_title = Column(String(500), nullable=True)

    # A slug derived from role and accessible name, stable enough to reference.
    element_name = Column(String(200), nullable=False, index=True)
    role = Column(String(100), nullable=True, index=True)
    accessible_name = Column(Text, nullable=True)
    # What the control is for, in the application's own terms. Null until
    # something is able to infer it; the matcher weights it below the
    # accessible name precisely because it is the softer signal.
    business_meaning = Column(Text, nullable=True)

    recommended_locator = Column(Text, nullable=False)
    # role | label | text | placeholder | testid
    recommended_strategy = Column(String(20), nullable=False, default="role")
    # 0-100. Drives tie-breaks in the matcher, so a uniquely-named control
    # beats an ambiguous one when both score the same on words.
    confidence_score = Column(Integer, nullable=False, default=0)
    href = Column(Text, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)

    run = relationship("AutomationDiscoveryRun", back_populates="elements")


class AutomationIntakeBatch(Base):
    """One scope of work: the documents that describe it, gathered together.

    --- Automation Module: Document Intake ----------------------------------

    The second way test cases reach the Workbench. The first is the review
    workflow -- a human approves a case and it appears in "What to refine".
    This is for the scope that arrives as documents instead: a BRD, an SRD, and
    the spreadsheet of test cases someone already wrote.

    A batch is a grouping, not a job. Documents are attached over time and
    extraction happens per document as each one lands, so a failed parse on the
    third file does not cost the two that already succeeded.

    Deliberately not project-scoped. Upstream keys every batch to a project id;
    this deployment has no project concept, so batches are global and ordered
    by recency, which is what the picker in the UI shows.
    """

    __tablename__ = "automation_intake_batches"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), nullable=False)

    # draft: documents still arriving. ready: at least one document extracted
    # and something was found in it. Purely descriptive -- nothing gates on it.
    status = Column(String(30), nullable=False, default="draft", index=True)

    created_by = Column(String(255), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    documents = relationship(
        "AutomationIntakeDocument",
        back_populates="batch",
        cascade="all, delete-orphan",
        order_by="AutomationIntakeDocument.id",
    )


class AutomationIntakeDocument(Base):
    """One uploaded file, its extracted text, and what was found in it.

    The original file is kept on disk under the module's storage root and
    referenced by path, following the same rule as run evidence: this database
    is SQLite with a background writer, and documents do not belong in it as
    blobs. `stored_path` is relative to that root so the store can be moved
    without rewriting rows.

    `role` is the user's declaration of what the document is -- BRD, SRD or
    test cases -- and it decides what happens to the text. Only a test case
    document produces candidates; the others are held for the requirements work
    that is not built yet. It is editable after upload because people pick the
    wrong one in the dropdown and re-uploading a 40MB PDF to fix that is a
    poor answer.
    """

    __tablename__ = "automation_intake_documents"

    id = Column(Integer, primary_key=True, index=True)
    batch_id = Column(
        Integer,
        ForeignKey("automation_intake_batches.id"),
        nullable=False,
        index=True,
    )

    filename = Column(String(255), nullable=False)
    file_type = Column(String(10), nullable=False)
    size_bytes = Column(Integer, nullable=True)
    stored_path = Column(Text, nullable=True)

    # brd | srd | test_cases
    role = Column(String(20), nullable=False, default="brd", index=True)

    # pending | ready | failed -- the "TEXT" column in the intake table.
    extract_status = Column(String(20), nullable=False, default="pending", index=True)
    extract_error = Column(Text, nullable=True)
    extracted_text = Column(Text, nullable=True)
    page_count = Column(Integer, nullable=True)

    # How many test cases this document yielded. Zero for a BRD, and zero for a
    # test case document whose table could not be mapped -- the UI shows the
    # count so the difference is visible before anyone clicks refine.
    cases_found = Column(Integer, nullable=False, default=0)

    uploaded_by = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)

    batch = relationship("AutomationIntakeBatch", back_populates="documents")

    __table_args__ = (
        CheckConstraint(
            "role IN ('brd', 'srd', 'test_cases')",
            name="ck_intake_document_role",
        ),
        Index("ix_intake_document_batch_role", "batch_id", "role"),
    )


class AutomationDeletedOrigin(Base):
    """A mirrored case someone deleted on purpose, so it is not mirrored again.

    sync_approved_test_cases is self-healing by design: it re-reads every
    APPROVED row in test_cases_details and re-creates any that has no case, so
    an approval whose mirror failed is caught up on the next pass. The cost of
    that design is that deleting a mirrored case could not stick -- the Workbench
    listing runs the mirror on every load, so a case deleted at the top of the
    request was back before the response was sent, and the UI truthfully
    reported both "1 test case(s) deleted" and the row still sitting there.

    A deletion is a decision, and this is where that decision is kept. The
    mirror consults it and skips these origins, so self-healing still applies to
    everything nobody has ruled on.

    Keyed by value, not by foreign key, in line with rule 1 at the top of this
    module: the review workflow's tables stay untouched and create_all() can add
    this one on its own.

    Re-approving the case in Review & Approval clears its row here, which is the
    undo: the reviewer making that decision again is the one signal that
    outranks the earlier delete.
    """

    __tablename__ = "automation_deleted_origins"

    # test_cases_details.test_case_id, by value. Primary key because one origin
    # can only be deleted once, and re-deleting must not error.
    origin_test_case_id = Column(String(255), primary_key=True)

    # Kept only so the audit trail and any support question can be read without
    # joining back to a row that may itself be gone by then.
    display_id = Column(String(255), nullable=True)

    deleted_by = Column(String(255), nullable=True)
    deleted_at = Column(DateTime, default=datetime.utcnow, index=True)


class AutomationAICheck(Base):
    """One case's pass through AI Checks, before it is sent for approval.

    AI Checks run on the Test Assistant page -- Refine, Quality Review,
    Auto-Improve (only when the review did not pass), AI Classify -- so the
    manager approves a case that has already been improved and triaged. The
    case itself is an AutomationTestCase with origin="ai_checks": a draft that
    Automation Studio does not list until the manager approves it.

    Progress lives here rather than in memory so a page reload, or a backend
    restart, can still say where every case got to. A case that was running
    when the process stopped is reported as interrupted and can be retried.

    `source_row` is the case exactly as it was generated. It is what Quality
    Review scores COVERAGE against -- there is no approved source row yet at
    this point -- and what Retry starts again from.
    """

    __tablename__ = "automation_ai_checks"

    id = Column(Integer, primary_key=True, index=True)
    batch_id = Column(String(40), nullable=False, index=True)
    position = Column(Integer, nullable=False, default=0)
    case_id = Column(Integer, ForeignKey("automation_test_cases.id"), nullable=True, index=True)
    source_row = Column(JSON, nullable=False)

    # queued | running | done | failed
    status = Column(String(20), nullable=False, default="queued", index=True)
    # {"refine"|"review"|"improve"|"classify": pending | running | done | skipped | failed}
    steps = Column(JSON, nullable=True)
    error = Column(Text, nullable=True)

    score_before = Column(Float, nullable=True)
    score_after = Column(Float, nullable=True)
    improved = Column(Boolean, nullable=False, default=False)
    # What the rules said before Partial and Undecided were folded into Manual.
    classification_detail = Column(String(20), nullable=True)
    knowledge_base = Column(String(100), nullable=True)

    requested_by = Column(String(255), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    finished_at = Column(DateTime, nullable=True)


# --- Test data vault -----------------------------------------------------------


class AutomationDataApp(Base):
    """An application whose tests need values: logins, OTPs, record names.

    Matched to a run by the Knowledge Base application its test case belongs
    to, or by URL prefix, so the same values serve every script for it.
    """

    __tablename__ = "automation_data_apps"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), nullable=False, unique=True)
    # The Knowledge Base application id (e.g. eand_b2b_portal), when there is one.
    kb_app_id = Column(String(100), nullable=True, index=True)
    # e.g. https://devnew-sas.etisalat.ae/b2bportal -- the longest match wins.
    url_prefix = Column(Text, nullable=True)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    entries = relationship("AutomationTestData", cascade="all, delete-orphan", back_populates="app")


class AutomationTestData(Base):
    """One value an application's tests read, for one environment.

    `environment` "*" means every environment (an OTP shared by SIT and UAT).
    A secret's value is stored encrypted and never returned by the API.
    """

    __tablename__ = "automation_test_data"

    id = Column(Integer, primary_key=True, index=True)
    app_id = Column(Integer, ForeignKey("automation_data_apps.id"), nullable=False, index=True)
    environment = Column(String(40), nullable=False, default="*")
    # e.g. "admin.username", "password", "otp", "organization_name".
    key = Column(String(120), nullable=False)
    value = Column(Text, nullable=True)
    is_secret = Column(Boolean, nullable=False, default=False)
    # Other names a script may use for it, comma-separated.
    aliases = Column(Text, nullable=True)
    updated_by = Column(String(255), nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    app = relationship("AutomationDataApp", back_populates="entries")

    __table_args__ = (
        Index("uq_automation_test_data_key", "app_id", "environment", "key", unique=True),
    )
