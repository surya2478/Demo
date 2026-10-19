"""
--- AI Checks, run from Review & Approval -----------------------------------------

The Test Assistant now saves the generated cases and sends them for review as
they were generated; AI Checks run here instead, on the cases a manager picks
(a project, a request, or selected cases). Nothing about the checks is new:
each request's cases go through ai_checks.start_batch with that request's own
generation settings -- Knowledge Base, environment, applications, project --
exactly as "Save & Run AI Checks" started them from the Test Assistant.

The link between a review case and its check lives on the case, under
"_ai_run" ({batch_id, check_id, status}). When the check finishes, the case is
written back the way "Send for Approval" used to write it: "_ai" holds the
check's results (read from the check record by ai_checks.attach_to_review,
never from a browser), and the case's columns take the checked text, with the
case as sent kept in "_ai"."original" for the Compare view. That write-back
happens on read (sync_rows), so it needs no hook in the check runner and is
safe to repeat: a manager editing the steps of a finished check sees the edit
the next time the case is read.

Approval is unchanged: a written-back case is linked to its checked draft
(origin_test_case_id), which approval promotes into the Automation Lab. A case
whose check is still running cannot be approved (the decision endpoint asks
running_ids), so a half-checked case never reaches the Lab.
"""
from __future__ import annotations

import logging
from typing import Any, Iterable, Optional

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from ..models.automation import AutomationAICheck, AutomationTestCase
from ..models.database import TestCaseDetail, TestCaseReviewDetail
from .automation import ai_checks
from .automation import applications as app_scope

logger = logging.getLogger(__name__)

LIVE = ("queued", "running")

# The Test Assistant saves its "Select KB" choice by value; AI Checks takes the
# Knowledge Base by name, as the Test Assistant sent it when it started them.
_KB_BY_CHOICE = {"default": None, "": None, "squad": "Device Squad", "automation": "Automation KB"}


def _knowledge_base(generation: dict[str, Any]) -> Optional[str]:
    choice = generation.get("knowledge_base")
    if choice is None:
        return None
    return _KB_BY_CHOICE.get(str(choice).strip().lower(), str(choice).strip() or None)


def _run(details: Any) -> Optional[dict[str, Any]]:
    run = (details or {}).get("_ai_run") if isinstance(details, dict) else None
    return run if isinstance(run, dict) else None


def is_running(case: TestCaseDetail) -> bool:
    run = _run(case.test_case_details)
    return bool(run and run.get("status") in LIVE)


def unsettled(case: TestCaseDetail) -> bool:
    """Linked to a check whose result is not written back yet (or may change)."""
    run = _run(case.test_case_details)
    return bool(run and run.get("status") != "done")


def running_ids(cases: Iterable[TestCaseDetail]) -> list[str]:
    return [case.test_case_id for case in cases if is_running(case)]


def _as_generated(details: dict[str, Any]) -> dict[str, Any]:
    """The case's own columns, for a check: no bookkeeping keys.

    A case checked before is checked again from what it was sent as, not from
    the text a previous check wrote over it.
    """
    ai = details.get("_ai") if isinstance(details.get("_ai"), dict) else None
    original = ai.get("original") if ai else None
    source = original if isinstance(original, dict) and original else details
    return {key: value for key, value in source.items() if not str(key).startswith("_") and key != "id"}


def _release_draft(db: Session, details: dict[str, Any]) -> None:
    """Unlink the draft a previous check left, so only the new one is promoted."""
    ai = details.get("_ai") if isinstance(details.get("_ai"), dict) else None
    case_id = ai.get("case_id") if ai else None
    if not case_id:
        return
    draft = db.get(AutomationTestCase, case_id)
    if draft is not None and draft.origin == ai_checks.ORIGIN:
        draft.origin_test_case_id = None
        draft.origin_request_id = None


def start(
    db: Session,
    cases: list[TestCaseDetail],
    *,
    actor: Optional[str],
    recheck: bool = False,
) -> dict[str, Any]:
    """Start AI Checks on these review cases; one batch per request (and per 100 cases).

    Only PENDING cases are checked. Cases already checked are skipped unless
    `recheck`; cases whose check is still running are always skipped.
    """
    by_request: dict[str, list[TestCaseDetail]] = {}
    skipped = {"not_pending": 0, "checked": 0, "running": 0}
    for case in cases:
        details = case.test_case_details if isinstance(case.test_case_details, dict) else {}
        if str(case.status).upper() != "PENDING":
            skipped["not_pending"] += 1
        elif is_running(case):
            skipped["running"] += 1
        elif details.get("_ai") and not recheck:
            skipped["checked"] += 1
        else:
            by_request.setdefault(case.request_id, []).append(case)

    batches: list[dict[str, Any]] = []
    for request_id, items in by_request.items():
        request = db.query(TestCaseReviewDetail).filter(TestCaseReviewDetail.request_id == request_id).first()
        generation = (request.generation or {}) if request is not None else {}
        scope = app_scope.choices(db, generation.get("applications") or [])
        for offset in range(0, len(items), ai_checks.MAX_CASES):
            chunk = items[offset: offset + ai_checks.MAX_CASES]
            rows = [_as_generated(dict(case.test_case_details or {})) for case in chunk]
            if scope:
                # An application picked by hand for a case lives on the case.
                app_scope.carry_by_case(rows, [case.test_case_details for case in chunk])
            batch_id = ai_checks.start_batch(
                db,
                rows,
                actor=actor,
                knowledge_base=_knowledge_base(generation),
                project_id=request.project_id if request is not None else None,
                environment=generation.get("environment") or None,
                applications=scope,
            )
            checks = (
                db.query(AutomationAICheck)
                .filter(AutomationAICheck.batch_id == batch_id)
                .order_by(AutomationAICheck.position)
                .all()
            )
            for case, check in zip(chunk, checks):
                details = dict(case.test_case_details or {})
                _release_draft(db, details)
                details["_ai_run"] = {"batch_id": batch_id, "check_id": check.id, "status": "queued", "by": actor}
                case.test_case_details = details
                flag_modified(case, "test_case_details")
            db.commit()
            batches.append({"request_id": request_id, "batch_id": batch_id, "cases": len(chunk)})
    return {
        "batches": batches,
        "started": sum(b["cases"] for b in batches),
        "skipped": skipped,
    }


def _checked_columns(details: dict[str, Any], results: dict[str, Any]) -> dict[str, Any]:
    """The case's columns as the check left them -- what "Send for Approval" sent."""
    original = results.get("original") or {}
    steps = " ".join(f"{s.get('step_number')}. {s.get('action')}" for s in (results.get("steps") or []) if s.get("action"))
    check = results.get("_case") or {}
    updated = dict(details)
    updated["Test Case Description"] = check.get("title") or original.get("Test Case Description") or details.get("Test Case Description", "")
    updated["Preconditions"] = check.get("preconditions") or "None"
    updated["Test Steps"] = steps or original.get("Test Steps") or details.get("Test Steps", "")
    updated["Test Data"] = check.get("test_data") or original.get("Test Data") or "None"
    updated["Expected Result"] = check.get("expected_result") or original.get("Expected Result") or details.get("Expected Result", "")
    return updated


def sync_rows(db: Session, cases: Iterable[TestCaseDetail]) -> bool:
    """Write finished checks back onto their review cases. True if anything changed."""
    changed = False
    for case in cases:
        details = case.test_case_details if isinstance(case.test_case_details, dict) else None
        run = _run(details)
        if not run or not run.get("check_id"):
            continue
        check = db.get(AutomationAICheck, int(run["check_id"]))
        if check is None:
            # The check was deleted: the case goes back to unchecked.
            details = dict(details)
            details.pop("_ai_run", None)
            case.test_case_details = details
            flag_modified(case, "test_case_details")
            changed = True
            continue
        status = check.status
        new_details = dict(details)
        new_run = dict(run, status=status, error=check.error if status == "failed" else None)
        if status == "done" and str(case.status).upper() == "PENDING":
            draft = db.get(AutomationTestCase, check.case_id) if check.case_id else None
            results = ai_checks.attach_to_review(db, check.id, test_case_id=case.test_case_id, request_id=case.request_id)
            if results and draft is not None:
                results = dict(results)
                results["_case"] = {
                    "title": draft.description,
                    "preconditions": draft.preconditions,
                    "test_data": draft.test_data,
                    "expected_result": draft.expected_result,
                }
                new_details = _checked_columns(new_details, results)
                results.pop("_case", None)
                new_details["_ai"] = results
        new_details["_ai_run"] = new_run
        if new_details != details:
            case.test_case_details = new_details
            flag_modified(case, "test_case_details")
            changed = True
    if changed:
        db.commit()
    return changed

