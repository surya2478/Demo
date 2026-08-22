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

    # automation | manual | undecided
    classification = Column(String(20), nullable=False, default="undecided", index=True)
    # policy | user | agent -- who decided, so a bulk re-run can leave a human
    # decision alone rather than silently overwriting it.
    classification_source = Column(String(30), nullable=True)
    classification_reason = Column(Text, nullable=True)
    manual_only_reasons = Column(JSON, nullable=True)

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

    Credentials are Fernet-encrypted under a key derived from SECRET_KEY and
    are never returned to the browser -- the API exposes only whether they are
    set. A saved password is replaceable, never readable.
    """

    __tablename__ = "automation_applications"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    base_url = Column(Text, nullable=False)
    environment = Column(String(50), nullable=False, default="SIT", index=True)

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
