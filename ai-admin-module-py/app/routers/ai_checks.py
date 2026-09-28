"""
--- AI Checks API --------------------------------------------------------------

The Test Assistant's AI Checks: refine, review, improve and classify generated
test cases before they are sent for approval. See services/automation/
ai_checks.py for the job itself.

Guarded by the Test Assistant's permission, not the Automation module's: the
people running these checks are the ones generating test cases, and they may
never open Automation Studio.
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database.connection import get_db
from ..services.authz import require_permission
from ..services.automation import ai_checks

router = APIRouter()

PERM = "testassistant.view"


class StartChecksRequest(BaseModel):
    # Each row is one generated test case, keyed by its table column headers
    # ("Test Case ID", "Test Steps", ...) exactly as the page parsed them.
    rows: list[dict[str, Any]] = Field(min_length=1, max_length=ai_checks.MAX_CASES)
    knowledge_base: Optional[str] = None
    # The saved session these cases belong to (test-case-reviews/save). The
    # batch is recorded on it, so the page can find the checks again.
    request_id: Optional[str] = None
    # SIT, UAT...: chosen on Generate Test Cases. The saved session's own
    # choice is used when this is left out.
    environment: Optional[str] = Field(default=None, max_length=40)


class EditedStep(BaseModel):
    action: str
    action_type: Optional[str] = None
    expected_result: Optional[str] = None
    target: Optional[str] = None
    test_data_ref: Optional[str] = None


class SaveEditsRequest(BaseModel):
    steps: list[EditedStep] = Field(min_length=1, max_length=200)
    preconditions: Optional[str] = None
    expected_result: Optional[str] = None


def _actor(user: dict) -> str:
    return (user or {}).get("username") or "user"


@router.post("/start", status_code=202)
def start_checks(
    body: StartChecksRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM)),
):
    session = None
    if body.request_id:
        from ..models.database import TestCaseReviewDetail

        session = db.query(TestCaseReviewDetail).filter(TestCaseReviewDetail.request_id == body.request_id).first()
        if session is None:
            raise HTTPException(status_code=404, detail="The saved session was not found.")
    try:
        batch_id = ai_checks.start_batch(
            db,
            body.rows,
            actor=_actor(current_user),
            knowledge_base=body.knowledge_base,
            project_id=session.project_id if session is not None else None,
            environment=body.environment or ((session.generation or {}).get("environment") if session is not None else None),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if session is not None:
        session.ai_batch_id = batch_id
        db.commit()
    return {"batch_id": batch_id}


@router.get("/{batch_id}")
def get_checks(
    batch_id: str,
    include_steps: bool = False,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM)),
):
    try:
        return ai_checks.batch_view(db, batch_id, include_steps=include_steps)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{batch_id}/checks/{check_id}/retry", status_code=202)
def retry_check(
    batch_id: str,
    check_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM)),
):
    try:
        ai_checks.retry(db, batch_id, check_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"status": "queued"}


class CheckIdsRequest(BaseModel):
    check_ids: list[int] = Field(default_factory=list, max_length=ai_checks.MAX_CASES)


@router.post("/{batch_id}/stop")
def stop_checks(
    batch_id: str,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM)),
):
    """Stop a batch: waiting cases stop now, a case mid-step stops after that step."""
    try:
        stopped = ai_checks.stop(db, batch_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"status": "stopping", "stopped": stopped}


@router.post("/{batch_id}/restart", status_code=202)
def restart_checks(
    batch_id: str,
    body: Optional[CheckIdsRequest] = None,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM)),
):
    """Re-run the stopped and failed cases (all of them, or the ids given)."""
    try:
        queued = ai_checks.restart(db, batch_id, (body.check_ids if body else None) or None)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"status": "queued", "queued": queued}


@router.post("/{batch_id}/delete")
def delete_checks(
    batch_id: str,
    body: CheckIdsRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM)),
):
    """Remove cases from the batch, with their drafts."""
    if not body.check_ids:
        raise HTTPException(status_code=400, detail="Select the cases to delete.")
    try:
        deleted = ai_checks.delete_checks(db, batch_id, body.check_ids)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"deleted": deleted}


@router.put("/{batch_id}/checks/{check_id}/steps", status_code=202)
def save_steps(
    batch_id: str,
    check_id: int,
    body: SaveEditsRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM)),
):
    """Save an author's step edits; Quality Review and AI Classify re-run."""
    edits = body.model_dump(exclude_unset=True)
    edits["steps"] = [step.model_dump() for step in body.steps]
    try:
        ai_checks.save_edits(db, batch_id, check_id, edits)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"status": "queued"}
