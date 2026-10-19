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

from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database.connection import get_db
from ..services.authz import require_permission, user_has_permission
from ..services.automation import ai_checks

router = APIRouter()

PERM = "testassistant.view"


class AgentSetup(BaseModel):
    app_key: str = Field(min_length=2, max_length=100)
    application_id: int = Field(gt=0)
    profile_id: Optional[str] = Field(default=None, max_length=200)
    # Credentials are stored in Test Data, never in the check request or log.
    environment: str = Field(min_length=1, max_length=40)
    reuse_kb_evidence: bool = True
    headed: bool = False


class StartChecksRequest(BaseModel):
    # Each row is one generated test case, keyed by its table column headers
    # ("Test Case ID", "Test Steps", ...) exactly as the page parsed them.
    rows: list[dict[str, Any]] = Field(min_length=1, max_length=ai_checks.MAX_CASES)
    knowledge_base: Optional[str] = None
    refine_mode: Literal["knowledge_base", "agents"] = "knowledge_base"
    agent_setup: Optional[AgentSetup] = None
    approval_manager_enabled: bool = False
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


class AgentDecisionRequest(BaseModel):
    scope: Literal["one", "batch", "off"]
    check_id: Optional[int] = None


class KBEvidencePreferenceRequest(BaseModel):
    enabled: bool


class AgentTestDataRequest(BaseModel):
    profile_id: str = Field(min_length=1, max_length=100)
    values: dict[str, str] = Field(min_length=1, max_length=50)


class ExistingAgentTestDataRequest(BaseModel):
    profile_id: str = Field(min_length=1, max_length=100)


@router.get("/{batch_id}/checks/{check_id}/test-data")
def agent_test_data_suggestion(
    batch_id: str, check_id: int, db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission("automation.execute")),
):
    from ..services.automation import agent_test_data
    try:
        return agent_test_data.suggestion(db, batch_id, check_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/{batch_id}/checks/{check_id}/test-data")
def save_agent_test_data(
    batch_id: str, check_id: int, body: AgentTestDataRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission("automation.execute")),
):
    from ..services.automation import agent_test_data
    try:
        return agent_test_data.save(db, batch_id, check_id, profile_id=body.profile_id,
                                    values=body.values, actor=_actor(current_user))
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/{batch_id}/checks/{check_id}/test-data/existing")
def assign_existing_agent_test_data(
    batch_id: str, check_id: int, body: ExistingAgentTestDataRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission("automation.execute")),
):
    from ..services.automation import agent_test_data
    try:
        return agent_test_data.assign_existing(db, batch_id, check_id,
                                               profile_id=body.profile_id, actor=_actor(current_user))
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/{batch_id}/checks/{check_id}/scan-missing", status_code=202)
def scan_missing_agent_controls(
    batch_id: str, check_id: int, reuse_existing: bool = False, db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission("automation.execute")),
):
    """Re-scan observed controls for an evidence-held agent journey draft."""
    from ..services.automation import agent_recovery
    try:
        return agent_recovery.start(db, batch_id, check_id, _actor(current_user), reuse_existing=reuse_existing)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/{batch_id}/checks/{check_id}/scan-missing")
def scan_missing_agent_progress(
    batch_id: str, check_id: int, db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission("automation.execute")),
):
    from ..services.automation import agent_recovery
    try:
        return agent_recovery.progress(db, batch_id, check_id, _actor(current_user))
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/{batch_id}/checks/{check_id}/align-journey-steps")
def align_agent_journey_steps(
    batch_id: str, check_id: int, db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission("automation.execute")),
):
    from ..services.automation import agent_recovery
    try:
        return agent_recovery.align_steps(db, batch_id, check_id, _actor(current_user))
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


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
    if body.refine_mode == "agents":
        from ..models.automation import AutomationApplication
        from ..services.journeys import store

        if not user_has_permission(current_user, "automation.execute"):
            raise HTTPException(status_code=403, detail="Agents Refine needs permission to run browser crawls.")
        if body.approval_manager_enabled and not user_has_permission(current_user, "automation.approve"):
            raise HTTPException(status_code=403, detail="Approval Manager needs permission to approve Knowledge Base changes.")
        if session is None or session.project_id is None:
            raise HTTPException(status_code=400, detail="Choose a project and save the test cases before starting Agents Refine.")
        if body.agent_setup is None:
            raise HTTPException(status_code=400, detail="Choose or register an application for Agents Refine.")
        application = db.get(AutomationApplication, body.agent_setup.application_id)
        if application is None or not application.is_active or application.app_key != body.agent_setup.app_key:
            raise HTTPException(status_code=400, detail="The selected application is not registered for this Knowledge Base.")
        if store.load(body.agent_setup.app_key) is None:
            raise HTTPException(status_code=400, detail="The selected application has no Journey Knowledge Base.")
    try:
        batch_id = ai_checks.start_batch(
            db,
            body.rows,
            actor=_actor(current_user),
            # Agent-only refinement deliberately has no KB reference. The
            # same refine/review/improve/classify pipeline still runs.
            knowledge_base=body.knowledge_base if body.refine_mode == "knowledge_base" else None,
            project_id=session.project_id if session is not None else None,
            environment=(body.agent_setup.environment if body.refine_mode == "agents" and body.agent_setup else body.environment)
            or ((session.generation or {}).get("environment") if session is not None else None),
            agent_setup=body.agent_setup.model_dump() if body.refine_mode == "agents" and body.agent_setup else None,
            approval_manager_enabled=body.refine_mode == "agents" and body.approval_manager_enabled,
            review_request_id=body.request_id,
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


@router.patch("/{batch_id}/kb-evidence")
def update_kb_evidence_preference(
    batch_id: str, body: KBEvidencePreferenceRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission("automation.execute")),
):
    try:
        ai_checks.set_reuse_kb_evidence(db, batch_id, body.enabled)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"enabled": body.enabled}


@router.patch("/{batch_id}/headed")
def update_browser_visibility(batch_id: str, body: KBEvidencePreferenceRequest,
    db: Session = Depends(get_db), current_user: dict = Depends(require_permission('automation.execute'))):
    try:
        ai_checks.set_reuse_kb_evidence(db, batch_id, body.enabled, preference='headed')
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {'enabled': body.enabled}


@router.post("/{batch_id}/agent-decision")
def agent_decision(
    batch_id: str,
    body: AgentDecisionRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission("automation.approve")),
):
    """A deliberate, batch-scoped delegation; unverified changes remain drafts."""
    from ..services.automation import agent_approval

    try:
        return agent_approval.set_policy(db, batch_id, scope=body.scope,
                                         check_id=body.check_id, actor=_actor(current_user))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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


@router.post("/{batch_id}/checks/{check_id}/continue-browser-replay", status_code=202)
def continue_browser_replay(
    batch_id: str,
    check_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission("automation.execute")),
):
    """Explicitly allow this case's paused browser replay to submit/change data."""
    try:
        ai_checks.continue_after_safety_pause(db, batch_id, check_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"status": "queued"}


@router.post("/{batch_id}/checks/{check_id}/retry-data-entry")
def retry_agent_data_entry(
    batch_id: str, check_id: int, db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission("automation.execute")),
):
    """Reuse a completed browser capture after KB preparation failed."""
    try:
        return ai_checks.retry_data_entry(db, batch_id, check_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/{batch_id}/checks/{check_id}/retry-analysis", status_code=202)
def retry_agent_analysis(
    batch_id: str, check_id: int, db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM)),
):
    """Resume at Analysis using the completed, case-matched browser capture."""
    try:
        ai_checks.retry_analysis(db, batch_id, check_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"status": "queued"}


@router.post("/{batch_id}/checks/{check_id}/retry-agent/{agent_name}", status_code=202)
def retry_failed_agent(
    batch_id: str, check_id: int, agent_name: str, db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM)),
):
    """Retry one failed handoff from its validated upstream checkpoint."""
    try:
        ai_checks.retry_agent_stage(db, batch_id, check_id, agent_name)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"status": "queued"}


@router.post("/{batch_id}/checks/{check_id}/mark-unverified-sent")
def mark_unverified_case_sent(
    batch_id: str, check_id: int, db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM)),
):
    """Persist the send state after the original, unchecked case reaches Evaluation."""
    try:
        ai_checks.mark_unverified_sent(db, batch_id, check_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"sent": True}


@router.post("/{batch_id}/checks/{check_id}/recheck", status_code=202)
def recheck_completed_case(
    batch_id: str, check_id: int, db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM)),
):
    """Re-run the quality agent and classification against the current KB."""
    try:
        ai_checks.recheck_one(db, batch_id, check_id)
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
