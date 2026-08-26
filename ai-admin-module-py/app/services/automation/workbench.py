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
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from ...database.connection import SessionLocal
from ..automation.eligibility import MANUAL_MARKERS, score_test_case, split_steps
from ..automation.llm import LLMError
from ..automation.refine import refine_case_content, refined_to_columns
from ...models.automation import AutomationTestCase

from . import knowledge_base as kb

logger = logging.getLogger(__name__)

CLASSIFICATION_AUTOMATION = "automation"
CLASSIFICATION_MANUAL = "manual"
CLASSIFICATION_UNDECIDED = "undecided"

APPROVAL_DRAFT = "draft"
APPROVAL_APPROVED = "approved"
APPROVAL_REJECTED = "rejected"


# ── Classification ───────────────────────────────────────────────────────────

def classify_case(case: AutomationTestCase) -> tuple[str, str, list[str]]:
    """Decide whether a case should be automated, and say why.

    Returns (classification, reason, manual_only_reasons). The reason is shown
    under the badge in the grid, so it is written to be read by a person
    deciding whether to accept the call, not as a log line.
    """
    blockers = list(case.automation_blockers or [])
    if blockers:
        return (
            CLASSIFICATION_MANUAL,
            "The refinement found something that cannot be automated: " + blockers[0],
            blockers,
        )

    haystack = " ".join(
        str(part or "")
        for part in (
            case.steps_raw,
            case.expected_result,
            case.preconditions,
            case.description,
            case.objective,
        )
    ).lower()

    hits = []
    for pattern in MANUAL_MARKERS:
        match = re.search(pattern, haystack)
        if match:
            hits.append(match.group(0))
    if hits:
        joined = ", ".join(sorted(set(hits)))
        return (
            CLASSIFICATION_MANUAL,
            f"Needs a human at run time ({joined}), so it cannot run unattended.",
            [f"Step mentions {hit}" for hit in sorted(set(hits))],
        )

    steps = case.steps_structured or split_steps(case.steps_raw)
    if not steps:
        return (
            CLASSIFICATION_UNDECIDED,
            "No discrete steps to judge. Refine it first, then classify.",
            [],
        )

    if (case.eligibility_verdict or "") == "needs_enhancement":
        return (
            CLASSIFICATION_UNDECIDED,
            "Too thin to judge: "
            + "; ".join(case.eligibility_reasons or ["the case is missing key content"]),
            [],
        )

    return (
        CLASSIFICATION_AUTOMATION,
        f"{len(steps)} discrete step(s), an expected result, and nothing needing a human.",
        [],
    )


def apply_classification(
    case: AutomationTestCase,
    *,
    forced: Optional[str] = None,
    actor: Optional[str] = None,
) -> AutomationTestCase:
    """Set a case's classification, either by rule or because a human said so.

    `classification_source` records which, so a later bulk re-classify can be
    made to leave human decisions alone rather than silently overwriting them.
    """
    if forced:
        case.classification = forced
        case.classification_source = "user"
        case.classification_reason = f"Set to {forced} by {actor or 'a user'}."
        case.manual_only_reasons = []
    else:
        classification, reason, manual_reasons = classify_case(case)
        case.classification = classification
        case.classification_source = "policy"
        case.classification_reason = reason
        case.manual_only_reasons = manual_reasons
    return case


# A human has confirmed the data exists. Distinct from "ready", which is a
# derived fact about the requirements list; this one is a decision.
TEST_DATA_USER_PROVIDED = "user_provided"


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
    if case.test_data_status == TEST_DATA_USER_PROVIDED:
        return TEST_DATA_USER_PROVIDED

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
        return False, "Classify it as Automation or Manual first."
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


def sync_approved_test_cases(db: Session) -> int:
    """Mirrors approved test cases from test_cases_details into AutomationTestCase so they appear in Automation Studio Workbench."""
    sql = """
        SELECT d.test_case_id, d.request_id, d.test_case_details, d.reviewed_by, d.reviewed_datetime
          FROM test_cases_details d
         WHERE d.status = 'APPROVED'
    """
    rows = db.execute(text(sql)).fetchall()
    synced = 0
    for row in rows:
        origin_id = str(row.test_case_id)
        # Check if already mirrored by origin_test_case_id
        existing = db.query(AutomationTestCase).filter(
            (AutomationTestCase.origin_test_case_id == origin_id)
        ).first()

        try:
            details = json.loads(row.test_case_details) if isinstance(row.test_case_details, str) else (row.test_case_details or {})
        except Exception:
            details = {}

        raw_display = str(details.get("Test Case ID") or "").strip()
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

        steps_raw = str(details.get("Test Steps") or "")
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

        # A URL written into the case wins; otherwise the registered
        # application's. This was a literal eand.ae URL, which stamped that
        full_case_text = f"{details.get('Preconditions', '')} {steps_raw} {details.get('Test Case Description', '')} {details.get('Expected Result', '')} {details.get('Test Data', '')}"
        app_url_match = re.search(r"https?://[^\s'\"\)]+", full_case_text)
        if app_url_match:
            app_url = app_url_match.group(0).rstrip(".,)")
        else:
            flow = kb.match_flow_blueprint(full_case_text)
            matched_app = (flow.get("_app_id") if flow else None) or kb.resolve_app_id(full_case_text) or kb.default_app_id()
            prof = kb.load_app_profile(matched_app) or {}
            app_url = (prof.get("base_url") or kb.default_base_url() or "").strip() or None

        created_at_dt = datetime.utcnow()
        if row.reviewed_datetime:
            if isinstance(row.reviewed_datetime, datetime):
                created_at_dt = row.reviewed_datetime
            elif isinstance(row.reviewed_datetime, str):
                try:
                    created_at_dt = datetime.fromisoformat(row.reviewed_datetime)
                except Exception:
                    try:
                        created_at_dt = datetime.strptime(row.reviewed_datetime.split('.')[0], "%Y-%m-%d %H:%M:%S")
                    except Exception:
                        created_at_dt = datetime.utcnow()

        if not existing:
            new_tc = AutomationTestCase(
                source="approved",
                origin_test_case_id=origin_id,
                origin_request_id=row.request_id,
                display_id=display_id,
                category=details.get("Category") or "General",
                description=details.get("Test Case Description") or details.get("description") or display_id,
                objective=details.get("Test Case Description") or details.get("objective"),
                preconditions=details.get("Preconditions"),
                steps_raw=steps_raw,
                test_data=details.get("Test Data"),
                expected_result=details.get("Expected Result"),
                steps_structured=structured,
                application_url=app_url,
                priority=details.get("Priority") or "High",
                origin="imported",
                classification="undecided",
                approval_status="approved",
                created_by=row.reviewed_by or "manager",
                created_at=created_at_dt,
            )
            db.add(new_tc)
            synced += 1
        else:
            if not existing.origin_test_case_id:
                existing.origin_test_case_id = origin_id
            if not existing.origin_request_id:
                existing.origin_request_id = row.request_id
            if app_url and (not existing.application_url or "smb" in full_case_text.lower() and "smb" not in (existing.application_url or "")):
                existing.application_url = app_url

    if synced > 0:
        db.commit()
    return synced

