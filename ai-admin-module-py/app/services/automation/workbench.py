"""
--- Automation Module: TC Coverage Assessment workbench ----------------------

The service behind the Automation TC Coverage Assessment screen: turn approved
test cases into refined ones, classify them, and carry them through approval.

Ported in behaviour from stlc-platform's test-cases view, minus its project
scope and minus grounding, which belongs to Application Discovery and is being
built separately.

Two things here are deliberate:

  * Classification is rule-based, not a model call. Upstream resolves a
    project's published classification policy; without a policy-authoring
    screen the honest equivalent is deterministic rules over the markers
    eligibility.py already detects. A rule states its reason, costs nothing,
    and gives the same answer twice -- which matters for a decision a human is
    about to approve in bulk.

  * Generation runs as a background job with progress. Refinement is one LLM
    call per case; a batch of thirty held open on a request would time out long
    before it finished, and the screen is built to poll.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from ...database.connection import SessionLocal
from ..automation import classification
from ..automation.eligibility import score_test_case, split_steps
from ..automation.llm import LLMError
from ..automation.refine import refine_case_content, refined_to_columns
from ...models.automation import AutomationApplication, AutomationDeletedOrigin, AutomationTestCase

from . import knowledge_base as kb

logger = logging.getLogger(__name__)

CLASSIFICATION_AUTOMATION = classification.CLASSIFICATION_AUTOMATION
# Automatable once named, minor edits are made -- a locator the catalogue does
# not have, a step with no verb, a value nobody supplied. Distinct from
# Automation because compiling it now produces a script that fails on its first
# run, and distinct from Manual because nothing about it needs a person.
CLASSIFICATION_PARTIAL = classification.CLASSIFICATION_PARTIAL
CLASSIFICATION_MANUAL = classification.CLASSIFICATION_MANUAL
CLASSIFICATION_UNDECIDED = classification.CLASSIFICATION_UNDECIDED

# The classifications that mean "a script may be built from this": Automation
# only. Partial used to be in, on the reasoning that its findings are edits an
# author makes. Cases now reach Automation Lab after AI Checks, where Partial
# is saved as Manual by decision -- a Lab queue of cases that fail on their
# first run until someone edits them is the outcome that decision avoids.
# Existing approved Partial cases leave the Lab with this change; reclassify
# one as Automation in the Workbench to bring it back.
CLASSIFICATIONS_AUTOMATABLE = (CLASSIFICATION_AUTOMATION,)

APPROVAL_DRAFT = "draft"
APPROVAL_APPROVED = "approved"
APPROVAL_REJECTED = "rejected"


# ── Classification ───────────────────────────────────────────────────────────

def classify_case(
    case: AutomationTestCase,
    context: Optional[classification.ClassificationContext] = None,
) -> tuple[str, str, list[str]]:
    """Decide whether a case should be automated, and say why.

    Returns (classification, reason, manual_only_reasons), which is what the
    grid's badge and its subtitle need. The judgement itself lives in
    classification.assess -- it checks every step, the channel the case runs
    on, and whether the Knowledge Base knows the controls the steps name, and
    it returns far more than three values. Callers wanting the whole report
    should call assess directly; this signature is kept for the ones that only
    ever wanted the verdict.
    """
    report = classification.assess(case, context)
    return (
        report["classification"],
        report["reason"],
        [finding["message"] for finding in report["blockers"]],
    )


def apply_classification(
    case: AutomationTestCase,
    *,
    forced: Optional[str] = None,
    actor: Optional[str] = None,
    context: Optional[classification.ClassificationContext] = None,
) -> AutomationTestCase:
    """Set a case's classification, either by rule or because a human said so.

    `classification_source` records which, so a later bulk re-classify can be
    made to leave human decisions alone rather than silently overwriting them.

    A rule-based pass also stores the full report. The badge can only carry one
    sentence, and the thing a reviewer actually needs -- which step, which
    channel, which control the catalogue is missing -- is the rest of it. A
    forced classification clears the report rather than keeping a stale one:
    the findings described a verdict that no longer stands.
    """
    if forced:
        case.classification = forced
        case.classification_source = "user"
        case.classification_reason = f"Set to {forced} by {actor or 'a user'}."
        case.manual_only_reasons = []
        case.classification_report = None
    else:
        report = classification.assess(case, context)
        case.classification = report["classification"]
        case.classification_source = "policy"
        case.classification_reason = report["reason"]
        case.manual_only_reasons = [f["message"] for f in report["blockers"]]
        case.classification_report = report
    case.classified_at = datetime.utcnow()
    return case


# A human has confirmed the data exists. Distinct from "ready", which is a
# derived fact about the requirements list; this one is a decision.
TEST_DATA_USER_PROVIDED = "user_provided"
TEST_DATA_KB_PROVIDED = "kb_provided"


def derive_test_data_status(case: AutomationTestCase) -> str:
    """pending blocks approval; not_required, ready and user_provided do not.

    Tracked separately from test_data_requirements because "this case names
    three data items" and "a human still has to go and get them" are different
    questions, and only the second one stops a run.

    A user_provided status is returned unchanged rather than recomputed. The
    requirements list is the model's reading of what the case needs; a person
    ticking "I have provided this" is later and better information, and
    re-deriving over it would silently re-block a case every time anyone
    edited an unrelated field -- which is what an edit does, since this runs
    from rescore() on every save.
    """
    if case.test_data_status in (TEST_DATA_USER_PROVIDED, TEST_DATA_KB_PROVIDED):
        return case.test_data_status

    requirements = case.test_data_requirements or []
    if not requirements:
        return "not_required"
    blocking = [
        req
        for req in requirements
        if str(req.get("resolution", "user_required"))
        in ("existing_record", "user_required")
    ]
    return "pending" if blocking else "ready"


# ── Background generation jobs ───────────────────────────────────────────────

@dataclass
class Job:
    """One batch of refinements, tracked so the screen can show progress."""

    id: str
    total: int
    completed: int = 0
    status: str = "queued"  # queued | running | completed | failed
    message: str = "Queued"
    created_ids: list[int] = field(default_factory=list)
    errors: list[dict[str, Any]] = field(default_factory=list)
    started_at: datetime = field(default_factory=datetime.utcnow)
    finished_at: Optional[datetime] = None

    @property
    def percent(self) -> int:
        if self.total <= 0:
            return 100
        return min(100, round(100 * self.completed / self.total))

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.id,
            "status": self.status,
            "percent": self.percent,
            "message": self.message,
            "total": self.total,
            "completed": self.completed,
            "created_ids": list(self.created_ids),
            "errors": list(self.errors),
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
        }


class JobRegistry:
    """In-memory, deliberately.

    A generation job is ephemeral -- the screen polls it while open and never
    refers to it again. Persisting it would mean a table, a sweep for orphans
    and a migration, for state nobody reads after the page closes. A restart
    loses in-flight jobs, which is the same trade the run sweep already makes,
    and the refined rows themselves are committed per case rather than at the
    end, so a lost job never loses completed work.
    """

    def __init__(self, keep: int = 50) -> None:
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._lock = threading.Lock()
        self._keep = keep

    def create(self, total: int) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], total=total)
        with self._lock:
            self._jobs[job.id] = job
            self._order.append(job.id)
            while len(self._order) > self._keep:
                self._jobs.pop(self._order.pop(0), None)
        return job

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)


job_registry = JobRegistry()


def _refine_one(
    db,
    *,
    display_id: str,
    existing: dict[str, Any],
    origin_test_case_id: Optional[str],
    origin: str,
    application_url: Optional[str],
    application_name: Optional[str],
    category: Optional[str],
    actor: Optional[str],
    replace: Optional[AutomationTestCase] = None,
) -> AutomationTestCase:
    """Refine one case and persist it.

    `replace` carries the row a previous refinement produced. Regenerating
    overwrites it and bumps `version` rather than adding a second row, because
    the grid is keyed on one refined case per source and two would read as
    duplicates with no way to tell which is current.
    """
    refined = refine_case_content(
        ref=f"case-{origin_test_case_id or display_id}",
        title=display_id,
        existing=existing,
        application_url=application_url,
        application_name=application_name,
    )

    columns = refined_to_columns(refined)
    # The model echoes the title back; the Studio's identifier is authoritative.
    columns["display_id"] = display_id

    target = replace or AutomationTestCase()
    for field_name, value in columns.items():
        setattr(target, field_name, value)

    target.source = "refined"
    target.origin = origin
    target.origin_test_case_id = origin_test_case_id
    target.category = category
    target.objective = refined.objective
    target.bdd_scenario = refined.bdd_scenario
    target.priority = refined.priority or "Medium"
    target.test_type = refined.test_type
    target.test_data_required = bool(refined.test_data_required)
    target.test_data_notes = refined.test_data_notes
    target.application_url = application_url
    target.created_by = target.created_by or actor

    if replace is not None:
        target.version = (target.version or 1) + 1
        # A regenerated case is a new proposal, so a previous approval no
        # longer applies to the text that is now in front of the reviewer.
        target.approval_status = APPROVAL_DRAFT
        target.approved_by = None
        target.approved_at = None
        target.decision_reason = None

    target.test_data_status = derive_test_data_status(target)
    apply_classification(target)

    if replace is None:
        db.add(target)
    db.commit()
    db.refresh(target)

    # Automatically run Review Agent to evaluate quality
    try:
        from .review_agent import review_test_case
        review_test_case(target, db=db)
    except Exception as e:
        logger.warning("Quality review evaluation skipped for %s: %s", display_id, e)

    return target


def run_generation_job(
    job: Job,
    items: list[dict[str, Any]],
    *,
    application_url: Optional[str],
    application_name: Optional[str],
    actor: Optional[str],
    regenerate: bool,
) -> None:
    """Refine a batch in the background, committing each case as it lands.

    Runs in a worker thread with its own session: the refinement transport is
    blocking, and sharing the request's session across threads is not safe.
    """
    db = SessionLocal()
    job.status = "running"
    try:
        for index, item in enumerate(items, start=1):
            display_id = item["display_id"]
            job.message = f"Refining {display_id} ({index} of {job.total})"
            try:
                existing_row = None
                if item.get("origin_test_case_id"):
                    existing_row = (
                        db.query(AutomationTestCase)
                        .filter(
                            AutomationTestCase.origin_test_case_id
                            == item["origin_test_case_id"],
                            AutomationTestCase.source == "refined",
                        )
                        .first()
                    )
                if existing_row and not regenerate:
                    job.errors.append(
                        {
                            "display_id": display_id,
                            "error": (
                                "Already refined. Tick Regenerate existing to replace it."
                            ),
                        }
                    )
                    continue

                created = _refine_one(
                    db,
                    display_id=display_id,
                    existing=item["existing"],
                    origin_test_case_id=item.get("origin_test_case_id"),
                    origin=item.get("origin", "existing"),
                    application_url=application_url,
                    application_name=application_name,
                    category=item.get("category"),
                    actor=actor,
                    replace=existing_row if regenerate else None,
                )
                job.created_ids.append(created.id)
            except (LLMError, ValueError) as exc:
                logger.warning("Refinement failed for %s: %s", display_id, exc)
                job.errors.append({"display_id": display_id, "error": str(exc)})
            except Exception as exc:  # noqa: BLE001 - one bad case must not kill the batch
                logger.exception("Unexpected refinement failure for %s", display_id)
                job.errors.append({"display_id": display_id, "error": str(exc)})
                db.rollback()
            finally:
                job.completed = index

        job.status = "completed"
        done = len(job.created_ids)
        job.message = (
            f"Refined {done} of {job.total} test case(s)"
            + (f", {len(job.errors)} failed" if job.errors else "")
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Generation job %s failed outright", job.id)
        job.status = "failed"
        job.message = str(exc)
    finally:
        job.finished_at = datetime.utcnow()
        db.close()


def start_generation_job(
    items: list[dict[str, Any]],
    *,
    application_url: Optional[str],
    application_name: Optional[str],
    actor: Optional[str],
    regenerate: bool,
) -> Job:
    job = job_registry.create(total=len(items))
    thread = threading.Thread(
        target=run_generation_job,
        args=(job, items),
        kwargs={
            "application_url": application_url,
            "application_name": application_name,
            "actor": actor,
            "regenerate": regenerate,
        },
        daemon=True,
        name=f"tas-generate-{job.id}",
    )
    thread.start()
    return job


# ── Approval ─────────────────────────────────────────────────────────────────

def can_approve(case: AutomationTestCase) -> tuple[bool, str]:
    """Whether a case may be approved, and why not when it may not.

    Pending test data blocks approval on purpose: approving a case that cannot
    run until someone provisions an account produces a green queue and a red
    first execution.
    """
    if case.classification == CLASSIFICATION_UNDECIDED:
        return False, "Classify it first — the rules could not judge it as it stands."
    if case.test_data_status == "pending":
        return False, (
            case.test_data_notes
            or "Test data must be provided before this case can be approved."
        )
    return True, ""


def rescore(case: AutomationTestCase) -> AutomationTestCase:
    """Recompute eligibility and test-data status after an edit."""
    result = score_test_case(
        {
            "description": case.description,
            "preconditions": case.preconditions,
            "steps_raw": case.steps_raw,
            "test_data": case.test_data,
            "expected_result": case.expected_result,
        }
    )
    case.eligibility_score = result.score
    case.eligibility_verdict = result.verdict
    case.eligibility_reasons = result.reasons
    case.test_data_status = derive_test_data_status(case)
    return case


# --- Reading a source row whose column names are not ours ---------------------
#
# test_cases_details.test_case_details is whatever the browser spread into it:
# `test_case_details: { ...row }` in TestCases.tsx copies the parsed generation
# table verbatim, so its keys are the column headers the AI service happened to
# emit. Those headers are not stable across deployments -- one environment
# produced "Test Case ID" and "Test Case Description", another produced neither,
# and because every read here named one exact spelling, the misses fell through
# to origin_test_case_id and a whole workbench showed "REQ-...-TC-2" in both the
# TC ID and the Title column.
#
# So keys are matched on shape rather than spelling: case, spaces, underscores
# and punctuation are stripped before comparing, which makes "Test Case ID",
# "test_case_id" and "TC_ID" the same key without listing each one.
_DETAIL_ALIASES: dict[str, tuple[str, ...]] = {
    # Deliberately NOT including a bare "id": local rows carry an `id` holding a
    # row index, and using that as the visible identifier would be worse than
    # the fallback it replaces.
    "display_id": ("Test Case ID", "TC ID", "Test Case Id", "TestCaseID", "Case ID", "TC"),
    "description": (
        "Test Case Description", "Description", "Test Description", "Title",
        "Test Case Title", "Scenario", "Test Scenario", "Summary", "Objective",
        "Test Case Objective",
    ),
    "steps": ("Test Steps", "Steps", "Test Step", "Procedure", "Test Procedure", "Steps To Execute"),
    "preconditions": ("Preconditions", "Precondition", "Pre-conditions", "Pre Requisites", "Prerequisites"),
    "test_data": ("Test Data", "Data", "Test Data Required"),
    "expected": ("Expected Result", "Expected Results", "Expected", "Expected Outcome"),
    "category": ("Category", "Module", "Feature", "Functional Area"),
    "priority": ("Priority", "Severity"),
}


def _normalise_key(name: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(name).lower())


def detail_value(details: dict[str, Any], field: str) -> str:
    """The first non-empty value in `details` matching any alias for `field`.

    Returns "" rather than None so every caller can treat the result the same
    way; the callers that want a default apply `or <default>` as before.
    """
    if not isinstance(details, dict):
        return ""
    index = {}
    for key, value in details.items():
        index.setdefault(_normalise_key(key), value)
    for alias in _DETAIL_ALIASES.get(field, ()):
        value = index.get(_normalise_key(alias))
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


# --- Automation Module: two clocks in one column -----------------------------
# automation_test_cases.created_at is a naive column whose model default is
# datetime.utcnow, and everything else on the row -- updated_at included -- is
# UTC. The mirror below, however, prefers the source row's reviewed_datetime,
# and Review & Approval writes THAT with _dubai_now(): naive Dubai local time.
#
# So one column carried two clocks, and the mismatch was invisible in the
# database and loud in the browser. The frontend's parseServerTime appends a Z
# to a bare timestamp -- correct, because the column is documented UTC -- and
# formatToDubaiTime then adds Dubai's +04:00 on top. A case mirrored at 19:58
# Dubai displayed as 11:58 pm: four hours into the future, on the same row
# whose updated_at read correctly.
#
# Converting here rather than at the source keeps the change to one column.
# Making _dubai_now() return UTC would be the deeper fix, but reviewed_datetime
# is read by Review & Approval, which renders it WITHOUT the Z -- so flipping
# the source without migrating that screen too would simply move the four-hour
# error somewhere else.
#
# Dubai is UTC+04:00 all year and has observed no DST since 1990, so a fixed
# offset is exact here; zoneinfo would need tzdata shipped in the container to
# say the same thing.
DUBAI_UTC_OFFSET = timedelta(hours=4)


def _dubai_naive_to_utc(value: Optional[datetime]) -> Optional[datetime]:
    """A naive Dubai-local timestamp as naive UTC, for a UTC column."""
    return None if value is None else value - DUBAI_UTC_OFFSET


def sync_approved_test_cases(db: Session) -> int:
    """Mirrors approved test cases from test_cases_details into AutomationTestCase so they appear in Automation Studio Workbench."""
    sql = """
        SELECT d.test_case_id, d.request_id, d.test_case_details, d.reviewed_by, d.reviewed_datetime
          FROM test_cases_details d
         WHERE d.status = 'APPROVED'
    """
    rows = db.execute(text(sql)).fetchall()

    # Origins somebody deleted on purpose. Without this the mirror is not just
    # self-healing but insistent: it re-creates every APPROVED row that has no
    # case, and the Workbench listing runs it on every load, so a deleted case
    # reappeared within the same request that deleted it.
    deleted_origins = {
        row[0] for row in db.query(AutomationDeletedOrigin.origin_test_case_id).all()
    }

    synced = 0
    for row in rows:
        origin_id = str(row.test_case_id)
        if origin_id in deleted_origins:
            continue
        # Check if already mirrored by origin_test_case_id
        existing = db.query(AutomationTestCase).filter(
            (AutomationTestCase.origin_test_case_id == origin_id)
        ).first()

        try:
            details = json.loads(row.test_case_details) if isinstance(row.test_case_details, str) else (row.test_case_details or {})
        except Exception:
            details = {}
        selected_application = details.get("_automation_application") if isinstance(details, dict) else None
        if not isinstance(selected_application, dict):
            selected_application = {}

        raw_display = detail_value(details, "display_id")
        if raw_display:
            collision = db.query(AutomationTestCase).filter(
                AutomationTestCase.display_id == raw_display,
                AutomationTestCase.origin_test_case_id != origin_id
            ).first()
            if collision:
                req_suffix = f"#{row.request_id[-6:]}" if row.request_id else f"#{origin_id[-4:]}"
                display_id = f"{raw_display} ({req_suffix})"
            else:
                display_id = raw_display
        else:
            display_id = origin_id

        steps_raw = detail_value(details, "steps")
        split_s = split_steps(steps_raw)
        structured = [
            {
                "step_number": i + 1,
                "action": s,
                "target": None,
                "test_data_ref": None,
                "expected_result": None,
            }
            for i, s in enumerate(split_s)
        ] if split_s else []

        # --- Automation Module: the Knowledge Base owns the host ------------
        # A URL written into the case supplies the PATH; the Knowledge Base
        # supplies the ORIGIN. Neither one alone was right.
        #
        # Letting the case text win outright -- the previous rule -- made the
        # Knowledge Base unable to move an application between environments. A
        # BRD quoting https://www.eand.ae/en/... kept stamping production onto
        # every case derived from it, however many times the profile's base_url
        # was repointed, because application_url is written once at sync time
        # and never re-derived. Thirty-two rows were still driving a browser to
        # production after the KB had been migrated, and nothing in the UI said
        # so: the card shows a URL, and a stale URL looks exactly like a fresh
        # one.
        #
        # Letting the profile win outright is no better -- it discards genuine
        # page detail. A case naming /b2bportal/user-manage/user-management
        # would collapse to the application's login page and assert nothing
        # about the page it was written for.
        #
        # So: keep the path the case names, move it onto the host the profile
        # registers. A case naming an application the KB does not know keeps
        # its URL untouched, because there is no better answer to replace it
        # with.
        full_case_text = " ".join((
            detail_value(details, "preconditions"),
            steps_raw,
            detail_value(details, "description"),
            detail_value(details, "expected"),
            detail_value(details, "test_data"),
        ))
        # An application picked for the case in Human Evaluation / Agents
        # Refine (_automation_application) is explicit and wins. Otherwise a
        # case linked to the application the user chose on Generate runs
        # there, and nowhere else; one from a generation that chose
        # applications but could not be told apart gets no URL rather than a
        # guess. Only an older, unlinked case goes through the inference below.
        from . import applications as app_scope

        explicit_app = None
        try:
            explicit_app = db.get(AutomationApplication, int(selected_application.get("id"))) if selected_application.get("id") else None
        except (TypeError, ValueError):
            explicit_app = None
        choice, chosen = (None, False) if explicit_app is not None else app_scope.for_row(details)
        app_url_match = None if chosen else re.search(r"https?://[^\s'\"\)]+", full_case_text)
        if explicit_app is not None:
            app_url = explicit_app.base_url
            matched_app = explicit_app.app_key
        elif chosen:
            app_url = app_scope.url_for(db, choice, full_case_text) if choice else None
        elif app_url_match:
            app_url = app_url_match.group(0).rstrip(".,)")
            flow = kb.match_flow_blueprint(full_case_text)
            matched_app = (flow.get("_app_id") if flow else None) or kb.identify_app_id(full_case_text)
            prof = (kb.load_app_profile(matched_app) if matched_app else {}) or {}
            app_url = kb.rehome_to_profile(app_url, prof)
        else:
            # identify_app_id, not resolve_app_id. Both resolve_app_id and
            # load_app_profile end in a fallback that cannot answer "no
            # application" -- one returns default_app_id(), the other
            # profiles[0] -- so a case naming none was stamped with whichever
            # profile the Knowledge Base directory listed first. A generic
            # postpaid-plan case reached the Workbench pointing at an unrelated
            # consumer portal, and it happened precisely BECAUSE nothing
            # matched: a case the Knowledge Base does cover takes its URL from
            # the matched flow on the line above.
            #
            # None is the honest answer. The case then carries no URL until
            # someone supplies one, and compile_for refuses to build a script
            # without it rather than driving a browser to a stranger's site.
            flow = kb.match_flow_blueprint(full_case_text)
            matched_app = (flow.get("_app_id") if flow else None) or kb.identify_app_id(full_case_text)
            prof = (kb.load_app_profile(matched_app) if matched_app else {}) or {}
            app_url = (prof.get("base_url") or "").strip() or None

        # reviewed_datetime is naive DUBAI time; created_at is a UTC column.
        # See _dubai_naive_to_utc above for what the missing conversion did.
        created_at_dt = datetime.utcnow()
        reviewed_dubai = None
        if row.reviewed_datetime:
            if isinstance(row.reviewed_datetime, datetime):
                reviewed_dubai = row.reviewed_datetime
            elif isinstance(row.reviewed_datetime, str):
                try:
                    reviewed_dubai = datetime.fromisoformat(row.reviewed_datetime)
                except Exception:
                    try:
                        reviewed_dubai = datetime.strptime(row.reviewed_datetime.split('.')[0], "%Y-%m-%d %H:%M:%S")
                    except Exception:
                        reviewed_dubai = None
            if reviewed_dubai is not None:
                created_at_dt = _dubai_naive_to_utc(reviewed_dubai)

        if not existing:
            new_tc = AutomationTestCase(
                source="approved",
                origin_test_case_id=origin_id,
                origin_request_id=row.request_id,
                display_id=display_id,
                category=detail_value(details, "category") or "General",
                description=detail_value(details, "description") or display_id,
                objective=detail_value(details, "description") or None,
                preconditions=detail_value(details, "preconditions") or None,
                steps_raw=steps_raw,
                test_data=detail_value(details, "test_data") or None,
                expected_result=detail_value(details, "expected") or None,
                steps_structured=structured,
                application_url=app_url,
                application_id=explicit_app.id if explicit_app else app_scope.crawl_application_id(db, choice),
                environment=explicit_app.environment if explicit_app else selected_application.get("environment"),
                priority=detail_value(details, "priority") or "High",
                origin="imported",
                classification=CLASSIFICATION_UNDECIDED,
                # Draft, not approved. Two different decisions share the word
                # "approved" and this mirror used to collapse them: the source
                # row is APPROVED because a manager accepted the test case in
                # Review & Approval, which says nothing about whether it should
                # be automated. Automation Studio's own approval is the second
                # decision, it is what decide_cases() records with an
                # approved_by and an approved_at, and it is gated by
                # can_approve() -- which refuses an undecided case outright.
                #
                # Stamping "approved" here handed a case that gate's outcome
                # without ever running it, so a freshly mirrored case arrived
                # in Automation Studio pre-approved by nobody: approval_status
                # said approved while approved_by and approved_at stayed NULL,
                # and the only thing standing between it and Script Lab was its
                # classification. Landing as draft makes the case travel the
                # path everything else travels -- classify, then approve.
                approval_status=APPROVAL_DRAFT,
                created_by=row.reviewed_by or "manager",
                created_at=created_at_dt,
            )
            db.add(new_tc)
            synced += 1
        else:
            # A case that went through AI Checks was linked to this row when it
            # was sent. The manager approving the row approves the case; it
            # was refined, reviewed and classified before they saw it.
            if existing.origin == "ai_checks":
                from .ai_checks import promote_approved

                if promote_approved(
                    db, existing, approved_by=row.reviewed_by, approved_at=created_at_dt
                ):
                    synced += 1

            if not existing.origin_test_case_id:
                existing.origin_test_case_id = origin_id
            if not existing.origin_request_id:
                existing.origin_request_id = row.request_id
            if chosen:
                if choice and not existing.application_id:
                    existing.application_id = app_scope.crawl_application_id(db, choice)
                if app_url and not existing.application_url:
                    existing.application_url = app_url
            elif app_url and (not existing.application_url or "smb" in full_case_text.lower() and "smb" not in (existing.application_url or "")):
                existing.application_url = app_url
            if explicit_app is not None:
                existing.application_id = explicit_app.id
                existing.application_url = explicit_app.base_url
                existing.environment = explicit_app.environment

            # Repair a row that is still showing the fallback.
            #
            # This branch only ever topped up provenance, so a case mirrored
            # while its column headers were unreadable kept "REQ-...-TC-2" in
            # both the TC ID and the Title column for good: the mirror creates
            # missing cases and never revisits the ones it already made. Making
            # the reads tolerant therefore fixed nothing that already existed,
            # which is most of what an affected deployment is looking at.
            #
            # The guard is the point. A repair happens only where the stored
            # value IS the origin id -- the exact string the fallback produces
            # and one nobody would type -- so a curated display_id or an edited
            # description is never overwritten, and a row that has nothing
            # better available is left exactly as it is.
            # `display_id` above already applied the collision suffix, so the
            # repair reuses it rather than the raw value: two cases sharing a
            # "TC-001" would otherwise both repair to "TC-001" and the grid
            # would key two rows on one identifier.
            if existing.display_id == origin_id and display_id != origin_id:
                existing.display_id = display_id

            # Repair a row still carrying Dubai local time in a UTC column.
            #
            # _dubai_naive_to_utc above corrects the conversion only where the
            # mirror CREATES a case, and the mirror creates each case once. So
            # the fix landed for cases mirrored after it and for nobody else:
            # every row already in the table kept the raw reviewed_datetime the
            # old code copied in, and kept reading four hours into the future.
            # On a deployment that has been running a while that is most of the
            # grid, which is why the column still looked broken after the fix.
            #
            # The guard is the same shape as the display_id repair above: the
            # stored value must BE the naive Dubai timestamp, to the second --
            # the exact bytes the old code wrote. A row already converted sits
            # four hours off that and is left alone, so the pass is idempotent
            # and cannot walk a corrected row backwards on the next load. A
            # created_at that came from anywhere else will not match either.
            if reviewed_dubai is not None and existing.created_at is not None:
                stored = existing.created_at.replace(microsecond=0)
                if stored == reviewed_dubai.replace(microsecond=0):
                    existing.created_at = created_at_dt

            better_description = detail_value(details, "description")
            if better_description:
                if existing.description in (None, "", origin_id, existing.display_id):
                    existing.description = better_description
                if existing.objective in (None, "", origin_id, existing.display_id):
                    existing.objective = better_description

    _carry_projects(db)
    _carry_environments(db)

    # Commit unconditionally: the loop above also repairs existing rows, and
    # gating on `synced` meant a pass that created nothing threw those repairs
    # away when the session closed.
    db.commit()
    return synced


def _carry_projects(db: Session) -> None:
    """Give each mirrored case the project its review request was generated for."""
    from ...models.database import TestCaseReviewDetail

    projects = dict(
        db.query(TestCaseReviewDetail.request_id, TestCaseReviewDetail.project_id)
        .filter(TestCaseReviewDetail.project_id.isnot(None))
        .all()
    )
    if not projects:
        return
    for case in (
        db.query(AutomationTestCase)
        .filter(AutomationTestCase.project_id.is_(None), AutomationTestCase.origin_request_id.in_(list(projects)))
        .all()
    ):
        case.project_id = projects[case.origin_request_id]


def _carry_environments(db: Session) -> None:
    """Give each mirrored case the environment chosen when it was generated.

    Generate Test Cases saves the choice with the session (generation JSON);
    a case that reached Automation without AI Checks learns it here. A case
    that already has one keeps it.
    """
    from ...models.database import TestCaseReviewDetail

    pending = (
        db.query(AutomationTestCase)
        .filter(AutomationTestCase.environment.is_(None), AutomationTestCase.origin_request_id.isnot(None))
        .all()
    )
    if not pending:
        return
    wanted = {case.origin_request_id for case in pending}
    environments = {
        request_id: ((generation or {}).get("environment") or "").strip().upper()
        for request_id, generation in db.query(TestCaseReviewDetail.request_id, TestCaseReviewDetail.generation)
        .filter(TestCaseReviewDetail.request_id.in_(list(wanted)))
        .all()
        if isinstance(generation, dict)
    }
    for case in pending:
        if environments.get(case.origin_request_id):
            case.environment = environments[case.origin_request_id]

