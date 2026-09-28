"""
--- AI Checks: refine, review, improve and classify before approval ----------

The Test Assistant runs these four steps on freshly generated test cases, so
the manager approves cases that are already improved and triaged, and only
Automation cases reach Automation Lab afterwards:

  1. AI Refine        -- structure the case into atomic steps with action types.
  2. Quality Review   -- score it, with coverage judged against the case as it
                         was generated.
  3. Auto-Improve     -- only when the review did not pass, reusing its
                         findings instead of reviewing again.
  4. KB Diff          -- Journey KB only, no model call: each step compared
                         with the designed journey and the crawled Automation
                         KB (services/journeys/diff.py). Skipped otherwise.
  5. AI Classify      -- rule-based, no model call. Partial and Undecided are
                         saved as Manual: only Automation goes on to the Lab.

Steps 1-3 are judged against the Knowledge Base the author selected on the
Test Assistant (the batch's `knowledge_base`) -- the same context generation
used, from generation.testcases.reference_context, so a case is refined and
reviewed against the KB it was written from. Classify stays on the Automation
KB whatever was selected: whether a case can be automated is a fact about the
running application, not about the design.

Each generated case becomes a draft AutomationTestCase (origin="ai_checks")
plus an AutomationAICheck row holding the original text and the progress of
every step. Progress is in the database, not in memory, so a reload -- or a
restart -- can still say where each case got to. A case that was running when
the process stopped is reported as interrupted and can be retried.

Nothing here is new AI behaviour. Every step is the Automation module's own
function (refine_case_content, review_test_case, auto_improve_test_case,
classification.assess), called earlier in the journey than before.
"""
from __future__ import annotations

import logging
import re
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any, Optional

from sqlalchemy.orm import Session

from ...database.connection import SessionLocal
from ...models.automation import AutomationAICheck, AutomationTestCase
from . import knowledge_base as kb
from . import workbench as wb
from .refine import refine_case_content, refined_to_columns

logger = logging.getLogger(__name__)

# Drafts are refined cases (the table only allows approved/manual/refined as a
# source) marked by their origin, which is what Automation Studio filters on.
ORIGIN = "ai_checks"
STEPS = ("refine", "review", "improve", "diff", "classify")

# Two cases at a time: roughly halves a batch's wall clock without leaning on
# the model provider's rate limits the way a wider pool would.
CONCURRENCY = 2

MAX_CASES = 100

# Worker threads per batch in this process. A check still "running" in the
# database whose batch has none here was interrupted -- the process that ran it
# is gone -- and is reported as such rather than spinning forever.
_active_workers: dict[str, int] = {}
_active_lock = threading.Lock()


def _enter(batch_id: str) -> None:
    with _active_lock:
        _active_workers[batch_id] = _active_workers.get(batch_id, 0) + 1


# Batches the author asked to stop. Waiting cases are marked stopped at once; a
# case already mid-step finishes that step (a model call cannot be cut off)
# and stops before the next one.
_stop_requested: set[str] = set()


def _stopping(batch_id: str) -> bool:
    with _active_lock:
        return batch_id in _stop_requested


class _Stopped(Exception):
    pass


def _leave(batch_id: str) -> None:
    with _active_lock:
        remaining = _active_workers.get(batch_id, 1) - 1
        if remaining > 0:
            _active_workers[batch_id] = remaining
        else:
            _active_workers.pop(batch_id, None)
            _stop_requested.discard(batch_id)


_TODO = re.compile(r"<<TODO:[^>]*>>")


def _pending_steps() -> dict[str, str]:
    return {name: "pending" for name in STEPS}


# --- Where the case runs ------------------------------------------------------

def _resolve_application(details: dict[str, Any]) -> tuple[Optional[str], Optional[str]]:
    """(application_url, application_name) for a generated case, or (None, None).

    The same rule sync_approved_test_cases applies when a case is mirrored:
    a URL the case names keeps its path and moves onto the host the matched
    Knowledge Base profile registers; a case naming no URL takes the profile's
    base URL; a case matching no application gets no URL at all, rather than
    whichever profile happens to be listed first.
    """
    text = " ".join(
        wb.detail_value(details, field)
        for field in ("preconditions", "steps", "description", "expected", "test_data")
    )
    try:
        flow = kb.match_flow_blueprint(text)
        app_id = (flow.get("_app_id") if flow else None) or kb.identify_app_id(text)
        profile = (kb.load_app_profile(app_id) if app_id else {}) or {}
    except Exception:  # noqa: BLE001 - an unreadable KB means "unknown", not a failed check
        logger.warning("Knowledge Base lookup failed while resolving the application", exc_info=True)
        return None, None

    name = profile.get("app_name") or app_id
    named_url = re.search(r"https?://[^\s'\"\)]+", text)
    if named_url:
        return kb.rehome_to_profile(named_url.group(0).rstrip(".,)"), profile), name
    return (profile.get("base_url") or "").strip() or None, name


# --- The selected Knowledge Base -------------------------------------------------

def _reference(check: AutomationAICheck) -> dict[str, Any]:
    """The selected KB's context for this case, from its generated text.

    Looked up from the case as generated (source_row), not as refined: the KB
    has to recognise the same text generation grounded on, and a refined case
    that drifted would otherwise lose its reference half-way through.
    """
    from ..generation.testcases import reference_context

    row = check.source_row or {}
    text = " ".join(
        wb.detail_value(row, field)
        for field in ("description", "preconditions", "steps", "expected", "test_data")
    )
    try:
        return reference_context(check.knowledge_base, text)
    except Exception:  # noqa: BLE001 - a KB problem downgrades to ungrounded, never fails the check
        logger.warning("Knowledge Base lookup failed for check %s", check.id, exc_info=True)
        return {"knowledge_base": check.knowledge_base, "kind": "none", "context": "", "detail": {}}


def _diff(db: Session, check: AutomationAICheck, case: AutomationTestCase) -> None:
    """Step 4: compare the case with the Journey KB and the Automation KB.

    Journey KB only. Other KBs carry no design journey to compare against, and
    reporting "no journey" on every one of their cases would be noise.
    """
    from ..generation.testcases import JOURNEY_KB

    if (check.knowledge_base or "").strip() != JOURNEY_KB:
        case.journey_diff = None
        _set_step(db, check, "diff", "skipped")
        return
    _set_step(db, check, "diff", "running")
    from ..journeys import diff as journey_diff

    steps = [
        {"step_number": s.get("step_number"), "action": s.get("action") or "", "target": s.get("target")}
        for s in (case.steps_structured or [])
        if isinstance(s, dict)
    ]
    text = " ".join(
        [case.description or "", case.objective or "", case.preconditions or ""]
        + [wb.detail_value(check.source_row or {}, "description")]
    )
    report = journey_diff.diff_case(steps, text)
    report["compared_at"] = datetime.utcnow().isoformat()
    case.journey_diff = report
    # No journey recognised: nothing was compared, so the step did not run.
    _set_step(db, check, "diff", "done" if report.get("journey_id") else "skipped")


def _diff_brief(report: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    if not report:
        return None
    return {
        "journey_id": report.get("journey_id"),
        "summary": report.get("summary") or {},
        "automatable": report.get("automatable"),
        "reason": report.get("reason"),
    }


# --- Starting a batch -------------------------------------------------------

def start_batch(
    db: Session,
    rows: list[dict[str, Any]],
    *,
    actor: Optional[str],
    knowledge_base: Optional[str] = None,
    project_id: Optional[int] = None,
    environment: Optional[str] = None,
) -> str:
    """Create a draft case and a check per row, then run the batch in the background."""
    if not rows:
        raise ValueError("There are no test cases to check.")
    if len(rows) > MAX_CASES:
        raise ValueError(f"AI Checks run on up to {MAX_CASES} test cases at a time.")

    batch_id = uuid.uuid4().hex[:16]
    for position, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError("Each test case must be an object of its table columns.")
        display_id = wb.detail_value(row, "display_id") or f"TC-{position + 1:03d}"
        description = wb.detail_value(row, "description") or display_id
        application_url, _ = _resolve_application(row)
        case = AutomationTestCase(
            source="refined",
            origin=ORIGIN,
            display_id=display_id[:100],
            category=wb.detail_value(row, "category") or "General",
            description=description,
            objective=description,
            preconditions=wb.detail_value(row, "preconditions") or None,
            steps_raw=wb.detail_value(row, "steps") or None,
            test_data=wb.detail_value(row, "test_data") or None,
            expected_result=wb.detail_value(row, "expected") or None,
            priority=wb.detail_value(row, "priority") or "Medium",
            application_url=application_url,
            classification=wb.CLASSIFICATION_UNDECIDED,
            approval_status=wb.APPROVAL_DRAFT,
            created_by=actor,
            project_id=project_id,
            environment=(environment or "").strip().upper() or None,
        )
        db.add(case)
        db.flush()
        db.add(
            AutomationAICheck(
                batch_id=batch_id,
                position=position,
                case_id=case.id,
                source_row=row,
                status="queued",
                steps=_pending_steps(),
                knowledge_base=(knowledge_base or None),
                requested_by=actor,
            )
        )
    db.commit()
    _launch(batch_id)
    return batch_id


def _launch(batch_id: str, check_ids: Optional[list[int]] = None) -> None:
    with _active_lock:
        _stop_requested.discard(batch_id)
    thread = threading.Thread(
        target=_run_batch,
        args=(batch_id, check_ids),
        daemon=True,
        name=f"ai-checks-{batch_id}",
    )
    _enter(batch_id)
    thread.start()


def _run_batch(batch_id: str, check_ids: Optional[list[int]]) -> None:
    db = SessionLocal()
    try:
        query = db.query(AutomationAICheck.id).filter(
            AutomationAICheck.batch_id == batch_id, AutomationAICheck.status == "queued"
        )
        if check_ids:
            query = query.filter(AutomationAICheck.id.in_(check_ids))
        ids = [row[0] for row in query.order_by(AutomationAICheck.position).all()]
    finally:
        db.close()
    try:
        with ThreadPoolExecutor(max_workers=CONCURRENCY, thread_name_prefix=f"ai-check-{batch_id}") as pool:
            list(pool.map(_run_check, ids))
    finally:
        _leave(batch_id)


# --- One case through the four steps ------------------------------------------

def _set_step(db: Session, check: AutomationAICheck, name: str, state: str) -> None:
    steps = dict(check.steps or _pending_steps())
    steps[name] = state
    check.steps = steps  # reassigned, so the JSON column is marked dirty
    db.commit()


def _fail(db: Session, check: AutomationAICheck, step: str, message: str) -> None:
    db.rollback()
    check = db.get(AutomationAICheck, check.id)
    steps = dict(check.steps or _pending_steps())
    steps[step] = "failed"
    check.steps = steps
    check.status = "failed"
    check.error = message[:2000]
    check.finished_at = datetime.utcnow()
    db.commit()


def _run_check(check_id: int) -> None:
    db = SessionLocal()
    step = "refine"
    try:
        check = db.get(AutomationAICheck, check_id)
        case = db.get(AutomationTestCase, check.case_id) if check else None
        if check is None or case is None or check.status != "queued":
            return  # deleted, or stopped while it waited
        if _stopping(check.batch_id):
            raise _Stopped()
        check.status = "running"
        check.error = None
        db.commit()

        # 1. AI Refine -- without its own review and classify: those are steps
        # 2 and 4 here, and running them inside refine would do both twice.
        _set_step(db, check, step, "running")
        row = check.source_row or {}
        application_url, application_name = _resolve_application(row)
        reference = _reference(check)
        refined = refine_case_content(
            ref=f"check-{check.id}",
            title=case.display_id,
            existing=row,
            application_url=application_url,
            application_name=application_name,
            reference=reference,
        )
        columns = refined_to_columns(refined)
        columns["display_id"] = case.display_id  # the generated id is authoritative
        for field_name, value in columns.items():
            setattr(case, field_name, value)
        case.objective = refined.objective
        case.bdd_scenario = refined.bdd_scenario
        case.priority = refined.priority or case.priority or "Medium"
        case.test_type = refined.test_type
        case.test_data_required = bool(refined.test_data_required)
        case.test_data_notes = refined.test_data_notes
        case.application_url = application_url
        _set_step(db, check, step, "done")

        # 2. Quality Review, coverage against the generated text.
        if _stopping(check.batch_id):
            raise _Stopped()
        step = "review"
        _set_step(db, check, step, "running")
        from .review_agent import auto_improve_test_case, review_test_case

        review = review_test_case(case, db=db, commit=False, reference=reference)
        if (review.get("findings") or {}).get("source") != "model":
            # The heuristic fallback is a structural guess, not a review, and
            # must not decide whether the case gets improved.
            _fail(db, check, step, "The AI reviewer could not be reached, so this case was not reviewed.")
            return
        check.score_before = case.review_score
        _set_step(db, check, step, "done")

        # 3. Auto-Improve, only when the review did not pass.
        if _stopping(check.batch_id):
            raise _Stopped()
        step = "improve"
        if case.review_verdict == "pass":
            check.score_after = case.review_score
            _set_step(db, check, step, "skipped")
        else:
            _set_step(db, check, step, "running")
            improved = auto_improve_test_case(case, db, review_data=review, reference=reference)
            db.refresh(case)
            check.score_after = (improved.get("review") or {}).get("overall_score", case.review_score)
            check.improved = True
            _set_step(db, check, step, "done")

        # 4. KB Diff, on the case as it will be approved.
        if _stopping(check.batch_id):
            raise _Stopped()
        step = "diff"
        _diff(db, check, case)

        # 5. AI Classify.
        if _stopping(check.batch_id):
            raise _Stopped()
        step = "classify"
        _classify(db, check, case)

        check.status = "done"
        check.finished_at = datetime.utcnow()
        db.commit()
    except _Stopped:
        _mark_stopped(db, check_id)
    except Exception as exc:  # noqa: BLE001 - one case must not stop the batch
        logger.warning("AI Checks failed for check %s at %s", check_id, step, exc_info=True)
        try:
            check = db.get(AutomationAICheck, check_id)
            if check is not None:
                _fail(db, check, step, str(exc) or exc.__class__.__name__)
        except Exception:  # noqa: BLE001
            logger.exception("Could not record the AI Checks failure for check %s", check_id)
    finally:
        db.close()


def _mark_stopped(db: Session, check_id: int) -> None:
    db.rollback()
    check = db.get(AutomationAICheck, check_id)
    if check is None:
        return
    # Steps already finished stay finished; the rest go back to waiting.
    check.steps = {
        name: (state if state in ("done", "skipped") else "pending")
        for name, state in (check.steps or _pending_steps()).items()
    }
    check.status = "stopped"
    check.error = "Stopped before this case finished. Restart to check it."
    check.finished_at = None
    db.commit()


def _classify(db: Session, check: AutomationAICheck, case: AutomationTestCase) -> None:
    """Classify by rule; Partial and Undecided are kept as Manual."""
    _set_step(db, check, "classify", "running")
    wb.rescore(case)
    wb.apply_classification(case)
    check.classification_detail = case.classification
    if case.classification != wb.CLASSIFICATION_AUTOMATION:
        if case.classification == wb.CLASSIFICATION_PARTIAL:
            case.classification_reason = "Needs minor changes to automate. " + (case.classification_reason or "")
        case.classification = wb.CLASSIFICATION_MANUAL
    # Placeholders the improver left are flagged, never invented away.
    if _TODO.search(_case_text(case)):
        case.test_data_status = "pending"
    _set_step(db, check, "classify", "done")


def _case_text(case: AutomationTestCase) -> str:
    parts = [case.preconditions or "", case.steps_raw or "", case.expected_result or "", case.test_data or ""]
    for step in case.steps_structured or []:
        if isinstance(step, dict):
            parts.extend(str(step.get(key) or "") for key in ("action", "expected_result", "test_data_ref"))
    return " ".join(parts)


# --- Retry, and re-check after an edit ------------------------------------------

def retry(db: Session, batch_id: str, check_id: int) -> None:
    """Run a case through every step again, from its generated text."""
    check = _get_check(db, batch_id, check_id)
    if check.status in ("queued", "running") and _is_active(batch_id):
        raise ValueError("This case is still being checked.")
    _reset(check)
    db.commit()
    _launch(batch_id, [check.id])


def save_edits(db: Session, batch_id: str, check_id: int, edits: dict[str, Any]) -> None:
    """Store an author's step edits, then re-run Quality Review, KB Diff and AI Classify."""
    check = _get_check(db, batch_id, check_id)
    if check.status in ("queued", "running") and _is_active(batch_id):
        raise ValueError("This case is still being checked.")
    case = db.get(AutomationTestCase, check.case_id)
    if case is None:
        raise ValueError("This case no longer exists.")

    from .refine import normalize_action_type

    steps = []
    for index, step in enumerate(edits.get("steps") or [], start=1):
        action = str(step.get("action") or "").strip()
        if not action:
            continue
        previous = step.get("_previous") or {}
        steps.append(
            {
                "step_number": len(steps) + 1,
                "action": action,
                "action_type": normalize_action_type(step.get("action_type")),
                "target": step.get("target", previous.get("target")),
                "test_data_ref": step.get("test_data_ref", previous.get("test_data_ref")),
                "expected_result": (str(step.get("expected_result") or "").strip() or None),
            }
        )
    if not steps:
        raise ValueError("A test case needs at least one step.")

    case.steps_structured = steps
    case.steps_raw = "\n".join(f"{s['step_number']}. {s['action']}" for s in steps)
    if "preconditions" in edits:
        case.preconditions = str(edits.get("preconditions") or "").strip() or None
    if "expected_result" in edits:
        case.expected_result = str(edits.get("expected_result") or "").strip() or None

    # Filling in every <<TODO>> is the author supplying the data; the warning
    # clears. Placeholders left in keep it.
    if _TODO.search(_case_text(case)):
        case.test_data_status = "pending"
    elif case.test_data_status == "pending":
        case.test_data_status = wb.TEST_DATA_USER_PROVIDED

    check.status = "queued"
    steps_state = dict(check.steps or _pending_steps())
    steps_state["review"] = "pending"
    steps_state["diff"] = "pending"
    steps_state["classify"] = "pending"
    check.steps = steps_state
    check.error = None
    db.commit()

    thread = threading.Thread(target=_recheck, args=(batch_id, check.id), daemon=True, name=f"ai-recheck-{check.id}")
    _enter(batch_id)
    thread.start()


def _reset(check: AutomationAICheck) -> None:
    check.status = "queued"
    check.steps = _pending_steps()
    check.error = None
    check.score_before = None
    check.score_after = None
    check.improved = False
    check.classification_detail = None
    check.finished_at = None


# --- Stop, restart and delete ---------------------------------------------------

def stop(db: Session, batch_id: str) -> int:
    """Stop a batch. Returns how many waiting cases were stopped outright."""
    checks = _batch_checks(db, batch_id)
    if _is_active(batch_id):
        with _active_lock:
            _stop_requested.add(batch_id)
    waiting = [c for c in checks if c.status == "queued"]
    for check in waiting:
        check.status = "stopped"
        check.error = "Stopped before this case was checked. Restart to check it."
    db.commit()
    return len(waiting)


def restart(db: Session, batch_id: str, check_ids: Optional[list[int]] = None) -> int:
    """Run the batch's stopped and failed cases again, from their generated text.

    Finished cases keep their results. Returns how many cases were queued.
    """
    checks = _batch_checks(db, batch_id)
    if any(c.status in ("queued", "running") for c in checks) and _is_active(batch_id):
        raise ValueError("AI Checks are still running on this batch. Stop them first.")
    wanted = set(check_ids or [])
    again = [
        c for c in checks
        if c.status in ("stopped", "failed") and c.case_id and (not wanted or c.id in wanted)
    ]
    if not again:
        raise ValueError("There are no stopped or failed cases to restart.")
    for check in again:
        _reset(check)
    db.commit()
    _launch(batch_id, [c.id for c in again])
    return len(again)


def delete_checks(db: Session, batch_id: str, check_ids: list[int]) -> int:
    """Remove cases from a batch, with their drafts. Returns how many went.

    A case being checked right now, or already sent for approval, stays.
    """
    wanted = set(check_ids)
    checks = [c for c in _batch_checks(db, batch_id) if c.id in wanted]
    if not checks:
        raise LookupError("None of those cases are in this batch.")
    if any(c.status == "running" or (c.status == "queued" and _is_active(batch_id)) for c in checks):
        raise ValueError("Stop AI Checks before deleting a case that is being checked.")
    case_ids = [c.case_id for c in checks if c.case_id]
    cases = db.query(AutomationTestCase).filter(AutomationTestCase.id.in_(case_ids)).all() if case_ids else []
    if any(case.origin != ORIGIN or case.origin_request_id for case in cases):
        raise ValueError("A case already sent for approval cannot be deleted here.")
    for check in checks:
        db.delete(check)
    db.flush()
    for case in cases:
        db.delete(case)
    db.commit()
    return len(checks)


def _batch_checks(db: Session, batch_id: str) -> list[AutomationAICheck]:
    checks = db.query(AutomationAICheck).filter(AutomationAICheck.batch_id == batch_id).all()
    if not checks:
        raise LookupError("No such AI Checks batch.")
    return checks


def _recheck(batch_id: str, check_id: int) -> None:
    db = SessionLocal()
    step = "review"
    try:
        check = db.get(AutomationAICheck, check_id)
        case = db.get(AutomationTestCase, check.case_id)
        check.status = "running"
        db.commit()
        _set_step(db, check, step, "running")
        from .review_agent import review_test_case

        review = review_test_case(case, db=db, commit=False, reference=_reference(check))
        if (review.get("findings") or {}).get("source") != "model":
            _fail(db, check, step, "The AI reviewer could not be reached, so the edit was not re-reviewed.")
            return
        check.score_after = case.review_score
        _set_step(db, check, step, "done")
        step = "diff"
        _diff(db, check, case)
        step = "classify"
        _classify(db, check, case)
        check.status = "done"
        check.finished_at = datetime.utcnow()
        db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Re-check failed for check %s", check_id, exc_info=True)
        check = db.get(AutomationAICheck, check_id)
        if check is not None:
            _fail(db, check, step, str(exc) or exc.__class__.__name__)
    finally:
        db.close()
        _leave(batch_id)


def recheck_cases(db: Session, case_ids: list[int]) -> dict[str, Any]:
    """Re-run Quality Review, KB Diff and AI Classify on cases after a KB change.

    Used by Change & Heal. Same path as saving an edit (_recheck): the case as
    it stands is reviewed again against the updated Knowledge Base -- nothing is
    re-refined, so an author's edits are kept. One case at a time, in one
    background thread, so a change touching many cases does not fan out into
    many concurrent model calls.
    """
    wanted = set(case_ids)
    checks = (
        db.query(AutomationAICheck).filter(AutomationAICheck.case_id.in_(wanted)).order_by(AutomationAICheck.id.desc()).all()
        if wanted else []
    )
    latest: dict[int, AutomationAICheck] = {}
    for check in checks:
        latest.setdefault(check.case_id, check)  # newest check per case
    queued, skipped = [], []
    for case_id in sorted(wanted):
        check = latest.get(case_id)
        if check is None:
            skipped.append({"case_id": case_id, "reason": "never went through AI Checks"})
            continue
        if check.status in ("queued", "running") and _is_active(check.batch_id):
            skipped.append({"case_id": case_id, "reason": "being checked right now"})
            continue
        check.status = "queued"
        state = dict(check.steps or _pending_steps())
        state.update(review="pending", diff="pending", classify="pending")
        check.steps = state
        check.error = None
        queued.append((check.batch_id, check.id))
    db.commit()

    def run() -> None:
        for batch_id, check_id in queued:
            _enter(batch_id)
            _recheck(batch_id, check_id)  # leaves the batch itself

    if queued:
        threading.Thread(target=run, daemon=True, name="ai-recheck-kb-change").start()
    return {"queued": len(queued), "skipped": skipped}


# --- Reading a batch -------------------------------------------------------------

def _is_active(batch_id: str) -> bool:
    with _active_lock:
        return _active_workers.get(batch_id, 0) > 0


def _get_check(db: Session, batch_id: str, check_id: int) -> AutomationAICheck:
    check = db.get(AutomationAICheck, check_id)
    if check is None or check.batch_id != batch_id:
        raise LookupError("No such check in this batch.")
    return check


def _step_states(check: AutomationAICheck) -> dict[str, str]:
    """Every step's state, including steps added after the check was made.

    A batch checked before KB Diff existed has no "diff" entry; for a case that
    got past it, the honest state is that it did not run.
    """
    states = {**_pending_steps(), **(check.steps or {})}
    if "diff" not in (check.steps or {}) and (check.steps or {}).get("classify") in ("done", "running"):
        states["diff"] = "skipped"
    return states


def _step_list(case: Optional[AutomationTestCase]) -> list[dict[str, Any]]:
    if case is None:
        return []
    return [
        {
            "step_number": int(step.get("step_number") or index + 1),
            "action": step.get("action") or "",
            "action_type": step.get("action_type"),
            "target": step.get("target"),
            "test_data_ref": step.get("test_data_ref"),
            "expected_result": step.get("expected_result"),
        }
        for index, step in enumerate(case.steps_structured or [])
        if isinstance(step, dict)
    ]


def batch_view(db: Session, batch_id: str, *, include_steps: bool = False) -> dict[str, Any]:
    checks = (
        db.query(AutomationAICheck)
        .filter(AutomationAICheck.batch_id == batch_id)
        .order_by(AutomationAICheck.position)
        .all()
    )
    if not checks:
        raise LookupError("No such AI Checks batch.")

    active = _is_active(batch_id)
    # A check left mid-flight by a process that no longer exists.
    interrupted = [c for c in checks if c.status in ("queued", "running") and not active]
    for check in interrupted:
        steps = _step_states(check)
        for name, state in steps.items():
            if state == "running":
                steps[name] = "failed"
        check.steps = steps
        check.status = "failed"
        check.error = "Interrupted -- the server restarted while this case was being checked. Retry it."
    if interrupted:
        db.commit()

    cases = {
        case.id: case
        for case in db.query(AutomationTestCase)
        .filter(AutomationTestCase.id.in_([c.case_id for c in checks if c.case_id]))
        .all()
    }

    items = []
    for check in checks:
        case = cases.get(check.case_id)
        items.append(
            {
                "check_id": check.id,
                "case_id": check.case_id,
                "display_id": case.display_id if case else None,
                "title": (case.description if case else None) or (check.source_row or {}).get("Test Case Description"),
                "status": check.status,
                "steps": _step_states(check),
                "error": check.error,
                "score_before": check.score_before,
                "score_after": check.score_after,
                "improved": bool(check.improved),
                "classification": case.classification if case and check.status == "done" else None,
                "classification_detail": check.classification_detail,
                "classification_reason": case.classification_reason if case else None,
                "test_data_pending": bool(case and case.test_data_status == "pending"),
                "test_data_notes": case.test_data_notes if case else None,
                "review_verdict": case.review_verdict if case else None,
                "application_url": case.application_url if case else None,
                "preconditions": case.preconditions if case else None,
                "expected_result": case.expected_result if case else None,
                "test_data": case.test_data if case else None,
                "steps_structured": _step_list(case) if include_steps else None,
                # Counts for the row; the step-by-step report with the edit view.
                "journey_diff": _diff_brief(case.journey_diff if case else None),
                "journey_diff_steps": ((case.journey_diff or {}).get("steps") if case and include_steps else None),
                "source_row": check.source_row,
                # Linked to a review row once sent for approval.
                "sent": bool(case and case.origin_request_id),
            }
        )

    def count(step: str, state: str) -> int:
        return sum(1 for item in items if (item["steps"] or {}).get(step) == state)

    done = [item for item in items if item["status"] == "done"]
    scored_after = [item["score_after"] for item in done if item["score_after"] is not None]
    scored_before = [item["score_before"] for item in done if item["score_before"] is not None]
    started = min((c.created_at for c in checks if c.created_at), default=None)
    finished = max((c.finished_at for c in checks if c.finished_at), default=None)
    running = any(item["status"] in ("queued", "running") for item in items)
    stopped = any(item["status"] == "stopped" for item in items)

    return {
        "batch_id": batch_id,
        "status": "running" if running else "stopped" if stopped else "complete",
        # Stop was pressed and a case is finishing the step it was on.
        "stopping": running and _stopping(batch_id),
        "total": len(items),
        "started_at": started.isoformat() if started else None,
        "finished_at": None if running or not finished else finished.isoformat(),
        "knowledge_base": checks[0].knowledge_base,
        "pipeline": {
            step: {state: count(step, state) for state in ("done", "skipped", "failed", "running", "pending")}
            for step in STEPS
        },
        "summary": {
            "automation": sum(1 for item in done if item["classification"] == wb.CLASSIFICATION_AUTOMATION),
            "manual": sum(1 for item in done if item["classification"] == wb.CLASSIFICATION_MANUAL),
            "needs_minor_changes": sum(1 for item in done if item["classification_detail"] == wb.CLASSIFICATION_PARTIAL),
            "improved": sum(1 for item in items if item["improved"]),
            "test_data_pending": sum(1 for item in items if item["test_data_pending"]),
            "not_checked": sum(1 for item in items if item["status"] == "failed"),
            "stopped": sum(1 for item in items if item["status"] == "stopped"),
            "avg_before": round(sum(scored_before) / len(scored_before), 1) if scored_before else None,
            "avg_after": round(sum(scored_after) / len(scored_after), 1) if scored_after else None,
        },
        "items": items,
    }


# --- Handing a checked case to Review & Approval ---------------------------------

def attach_to_review(
    db: Session, check_id: Any, *, test_case_id: str, request_id: str
) -> Optional[dict[str, Any]]:
    """Link a checked draft to the review row it was sent as; return its AI results.

    The results come from the check record, never from the browser: the scores
    and classification a manager approves on have to be the ones the checks
    produced. Returns None for an id that is not a finished check, so a case
    sent without AI Checks simply carries no AI results.
    """
    try:
        check = db.get(AutomationAICheck, int(check_id))
    except (TypeError, ValueError):
        return None
    if check is None or check.status != "done":
        return None
    case = db.get(AutomationTestCase, check.case_id) if check.case_id else None
    if case is None:
        return None

    case.origin_test_case_id = test_case_id
    case.origin_request_id = request_id

    return {
        "check_id": check.id,
        "case_id": case.id,
        "classification": case.classification,
        "classification_detail": check.classification_detail,
        "classification_reason": case.classification_reason,
        "score_before": check.score_before,
        "score_after": check.score_after,
        "improved": bool(check.improved),
        "review_verdict": case.review_verdict,
        "review_scores": case.review_scores,
        "coverage_basis": (case.review_findings or {}).get("coverage_basis"),
        "test_data_pending": case.test_data_status == "pending",
        "test_data_notes": case.test_data_notes,
        "test_type": case.test_type,
        "steps": _step_list(case),
        "journey_diff": _diff_brief(case.journey_diff),
        # The case as generated, for the manager's Compare view.
        "original": check.source_row,
    }


# The origin a draft takes once a manager approves it: visible in Automation
# Studio from then on, and still recognisable as having come through AI Checks.
APPROVED_ORIGIN = "ai_checked"


def promote_approved(
    db: Session, case: AutomationTestCase, *, approved_by: Optional[str], approved_at: Optional[datetime]
) -> bool:
    """Approve a checked draft its review row was approved for. True if it changed.

    Manager approval is the only approval these cases need: they were refined,
    reviewed and classified before the manager saw them, which is what the
    Workbench's own approval gate exists to ensure. Missing test data does not
    block -- it was flagged on every screen and the case lands flagged.
    """
    if case.origin != ORIGIN:
        return False
    case.origin = APPROVED_ORIGIN
    case.approval_status = wb.APPROVAL_APPROVED
    case.approved_by = approved_by or "manager"
    case.approved_at = approved_at or datetime.utcnow()
    case.decision_reason = "Approved in Review & Approval after AI Checks."
    return True
