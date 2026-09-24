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
    try:
        batch_id = ai_checks.start_batch(
            db, body.rows, actor=_actor(current_user), knowledge_base=body.knowledge_base
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
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
