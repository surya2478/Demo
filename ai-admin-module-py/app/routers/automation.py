"""
--- Automation Module: API ---------------------------------------------------

Phase 0 surface: runtime status and the candidate list.

Everything here is additive. The module reads test_cases_details but never
writes to it, and every write lands in an automation_* table.

Authorisation is enforced server-side through require_permission rather than
relying on the client. For automation.execute that is not cosmetic -- a run
spends real CPU, memory and browser time on this host.
"""
from __future__ import annotations

import csv
import io
import json
import logging
import shutil
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings
from ..database.connection import get_db
from ..models.database import TestCaseDetail
from ..models.automation import (
    AutomationApplication,
    AutomationDiscoveredElement,
    AutomationDiscoveryRun,
    AutomationIntakeBatch,
    AutomationIntakeDocument,
    AutomationRun,
    AutomationRunResult,
    AutomationScript,
    AutomationTestCase,
)
from ..services.authz import require_permission
from ..services.automation import workspace as ws
from ..services.automation.eligibility import COLUMN_ALIASES, score_test_case, split_steps
from ..services.automation.job_manager import job_manager, new_run_key
from ..services.automation.llm import LLMError, provider_status
from ..services.automation.preflight import is_ready, runtime_status
from ..services.automation.refine import refine_case_content, refined_to_columns
from ..services.automation import compiler
from ..services.automation import discovery
from ..services.automation import grounding
from ..services.automation import extraction
from ..services.automation import intake
from ..services.automation import workbench as wb
from ..services.automation import healer
from ..services.automation import knowledge_base as kb
from ..services.automation.guided_discovery import guided_discovery_manager
from ..services.audit_logger import audit_log

router = APIRouter(tags=["Automation Studio"])

PERM_VIEW = "automation.view"
PERM_EXECUTE = "automation.execute"


# ── Runtime ──────────────────────────────────────────────────────────────────

@router.get("/runtime")
def get_runtime_status(current_user: dict = Depends(require_permission(PERM_VIEW))):
    """Whether this deployment can execute a browser test right now.

    The degraded-mode surface. The UI calls this on load so a missing toolchain
    is visible before anyone clicks Run, rather than surfacing as an opaque
    failure five seconds later. Every unavailable entry carries a `detail` that
    names what to install.
    """
    status = runtime_status()
    frameworks = {
        name: {"available": support.available, "detail": support.detail}
        for name, support in status.items()
    }
    ready = all(support.available for support in status.values())

    return {
        "enabled": bool(settings.AUTOMATION_ENABLED),
        "ready": ready and bool(settings.AUTOMATION_ENABLED),
        "frameworks": frameworks,
        # Stated up front rather than discovered on a disabled button: no
        # runner exists for these anywhere, upstream included.
        "runnable_frameworks": ["playwright"],
        "generate_only_frameworks": ["katalon", "appium"],
        "max_concurrent_runs": settings.AUTOMATION_MAX_CONCURRENT_RUNS,
        "storage_path": settings.AUTOMATION_STORAGE_PATH,
    }


# ── Candidates ───────────────────────────────────────────────────────────────

def _approved_candidates(db: Session, search: Optional[str]) -> list[dict[str, Any]]:
    """Approved test cases from the review workflow.

    Raw SQL rather than the ORM on purpose: these tables belong to the review
    workflow, and importing its models here would create a coupling this module
    has promised not to have. A read stays a read.
    """
    sql = """
        SELECT d.test_case_id,
               d.request_id,
               d.test_case_details,
               d.reviewed_by,
               d.reviewed_datetime,
               d.generated_by,
               r.request_by,
               r.request_date_time
          FROM test_cases_details d
     LEFT JOIN test_case_review_details r ON r.request_id = d.request_id
         WHERE d.status = 'APPROVED'
      ORDER BY d.reviewed_datetime DESC
    """
    rows = db.execute(text(sql)).fetchall()

    out: list[dict[str, Any]] = []
    for row in rows:
        try:
            details = json.loads(row.test_case_details) if isinstance(row.test_case_details, str) else (row.test_case_details or {})
        except (TypeError, ValueError):
            details = {}

        eligibility = score_test_case(details)
        display_id = str(details.get("Test Case ID") or row.test_case_id)
        description = str(details.get("Test Case Description") or "")

        if search:
            haystack = f"{display_id} {description} {details.get('Category', '')}".lower()
            if search.lower() not in haystack:
                continue

        out.append(
            {
                "source": "approved",
                "id": None,  # not yet mirrored into the Studio's table
                "origin_test_case_id": str(row.test_case_id),
                "origin_request_id": row.request_id,
                "display_id": display_id,
                "category": details.get("Category"),
                "description": description,
                "approved_by": row.reviewed_by,
                "approved_at": str(row.reviewed_datetime) if row.reviewed_datetime else None,
                "generated_by": row.generated_by,
                "eligibility": eligibility.to_dict(),
                "script_count": 0,
            }
        )
    return out


def _manual_candidates(db: Session, search: Optional[str]) -> list[dict[str, Any]]:
    """Cases authored in the Studio, plus anything produced by refinement."""
    query = db.query(AutomationTestCase).order_by(AutomationTestCase.created_at.desc())
    out: list[dict[str, Any]] = []

    for case in query.all():
        if search:
            haystack = f"{case.display_id} {case.description or ''} {case.category or ''}".lower()
            if search.lower() not in haystack:
                continue

        out.append(
            {
                "source": case.source,
                "id": case.id,
                "origin_test_case_id": case.origin_test_case_id,
                "origin_request_id": case.origin_request_id,
                "display_id": case.display_id,
                "category": case.category,
                "description": case.description,
                "approved_by": None,
                "approved_at": None,
                "generated_by": case.created_by,
                "eligibility": {
                    "score": case.eligibility_score,
                    "verdict": case.eligibility_verdict,
                    "reasons": case.eligibility_reasons or [],
                    "step_count": len(case.steps_structured or []),
                    "can_generate": case.eligibility_verdict in ("ready", "review"),
                },
                "script_count": len(case.scripts or []),
            }
        )
    return out


@router.get("/candidates")
def list_candidates(
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
    source: str = Query(default="all", pattern="^(all|approved|manual)$"),
    verdict: Optional[str] = Query(default=None, pattern="^(ready|review|needs_enhancement)$"),
    search: Optional[str] = Query(default=None, max_length=200),
):
    """Test cases available to automate, with their eligibility verdict.

    Two sources, presented identically: approved cases read from the review
    workflow, and cases authored in the Studio. Scoring is deterministic, so a
    verdict is reproducible and every shortfall names itself.
    """
    candidates: list[dict[str, Any]] = []
    if source in ("all", "approved"):
        candidates.extend(_approved_candidates(db, search))
    if source in ("all", "manual"):
        candidates.extend(_manual_candidates(db, search))

    if verdict:
        candidates = [c for c in candidates if (c["eligibility"] or {}).get("verdict") == verdict]

    summary = {
        "total": len(candidates),
        "ready": sum(1 for c in candidates if (c["eligibility"] or {}).get("verdict") == "ready"),
        "review": sum(1 for c in candidates if (c["eligibility"] or {}).get("verdict") == "review"),
        "needs_enhancement": sum(
            1 for c in candidates if (c["eligibility"] or {}).get("verdict") == "needs_enhancement"
        ),
        "scripted": sum(1 for c in candidates if c["script_count"] > 0),
    }

    return {"summary": summary, "candidates": candidates}


@router.get("/candidates/approved/{test_case_id}")
def get_approved_candidate(
    test_case_id: str,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    """Full detail for one approved case, with its eligibility breakdown.

    Backs the View drawer. Read-only, like everything touching this table.
    """
    row = db.execute(
        text(
            "SELECT test_case_id, request_id, test_case_details, status, reviewed_by, "
            "reviewed_datetime, generated_by FROM test_cases_details WHERE test_case_id = :tid"
        ),
        {"tid": test_case_id},
    ).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Test case not found")
    if (row.status or "").upper() != "APPROVED":
        raise HTTPException(
            status_code=409,
            detail=(
                f"Test case {test_case_id} is {row.status}, not APPROVED. "
                "Only approved test cases can be automated."
            ),
        )

    try:
        details = json.loads(row.test_case_details) if isinstance(row.test_case_details, str) else (row.test_case_details or {})
    except (TypeError, ValueError):
        details = {}

    eligibility = score_test_case(details)
    return {
        "source": "approved",
        "origin_test_case_id": str(row.test_case_id),
        "origin_request_id": row.request_id,
        "details": details,
        "eligibility": eligibility.to_dict(),
        "approved_by": row.reviewed_by,
        "approved_at": str(row.reviewed_datetime) if row.reviewed_datetime else None,
        "generated_by": row.generated_by,
    }


# ── Runs ─────────────────────────────────────────────────────────────────────

class CreateRunRequest(BaseModel):
    """What to execute.

    `code` exists for Phase 0: it lets a hand-written spec run through the whole
    module before any generation exists, which is what makes a green result mean
    the runtime is genuinely correct rather than that the model happened to
    behave. Phase 1 adds `script_id` alongside it.
    """

    code: str = Field(min_length=1, max_length=200_000)
    environment: Optional[str] = Field(default=None, max_length=50)
    base_url: Optional[str] = Field(default=None, max_length=2000)
    file_name: Optional[str] = Field(default=None, max_length=255)
    test_case_id: Optional[int] = None
    slow_mo_ms: Optional[int] = Field(default=None, ge=0, le=10000)
    headless: Optional[bool] = Field(default=True)


def _run_summary(run: AutomationRun) -> dict:
    tc_display_id = None
    tc_title = None
    test_case = getattr(run, "test_case", None)
    script = getattr(run, "script", None)
    metadata = run.run_metadata if isinstance(run.run_metadata, dict) else {}

    if test_case:
        tc_display_id = getattr(test_case, "display_id", None)
        tc_title = getattr(test_case, "description", None) or tc_display_id
    elif script and getattr(script, "test_case", None):
        stc = script.test_case
        tc_display_id = getattr(stc, "display_id", None)
        tc_title = getattr(stc, "description", None) or tc_display_id
    elif metadata:
        tc_display_id = metadata.get("display_id") or metadata.get("file_name")
        tc_title = metadata.get("title") or metadata.get("description")

    file_name = None
    if metadata and metadata.get("file_name"):
        file_name = metadata.get("file_name")
    elif script:
        file_name = getattr(script, "file_name", None)

    return {
        "run_key": run.run_key,
        "test_case_id": getattr(run, "test_case_id", None),
        "tc_display_id": tc_display_id,
        "tc_title": tc_title,
        "file_name": file_name,
        "status": run.status,
        "outcome": run.outcome,
        "framework": run.framework,
        "environment": run.environment,
        "error_message": run.error_message,
        "total_tests": run.total_tests,
        "passed": run.passed,
        "failed": run.failed,
        "skipped": run.skipped,
        "blocked": run.blocked,
        "duration_seconds": run.duration_seconds,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "completed_at": run.completed_at.isoformat() if run.completed_at else None,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "triggered_by": run.triggered_by,
        "is_active": job_manager.is_active(run.run_key),
        "is_healed": bool(metadata.get("is_healed", False)),
        "healing_diagnosis": metadata.get("healing_diagnosis"),
        "healing_changes": metadata.get("healing_changes"),
        "original_code": metadata.get("original_code"),
        "healed_code": metadata.get("healed_code"),
        "run_metadata": metadata,
    }


@router.post("/runs", status_code=202)
def create_run(
    body: CreateRunRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Queue a run. Returns 202 with a run_key to poll.

    Refuses before queueing rather than after: an unavailable runtime or a full
    slot produces an immediate, explained rejection instead of a run that sits
    at "queued" and fails a minute later.
    """
    if not settings.AUTOMATION_ENABLED:
        raise HTTPException(
            status_code=503,
            detail="The Automation Module is disabled on this deployment (AUTOMATION_ENABLED=false).",
        )

    if not is_ready():
        detail = "; ".join(
            f"{name}: {support.detail}"
            for name, support in runtime_status().items()
            if not support.available
        )
        raise HTTPException(
            status_code=503, detail=f"The browser runtime is not available. {detail}"
        )

    permitted, reason = job_manager.capacity()
    if not permitted:
        raise HTTPException(status_code=429, detail=reason)

    username = (current_user or {}).get("username")
    run_key = new_run_key()

    slow_mo = (
        body.slow_mo_ms
        if body.slow_mo_ms is not None
        else getattr(settings, "AUTOMATION_DEFAULT_SLOW_MO_MS", 1000)
    )
    is_headless = body.headless if body.headless is not None else True

    run = AutomationRun(
        run_key=run_key,
        test_case_id=body.test_case_id,
        framework="playwright",
        environment=body.environment,
        status="queued",
        run_config={
            "headless": is_headless,
            "slow_mo_ms": slow_mo,
            "mode": "standard",
        },
        run_metadata={
            "code": body.code,
            "base_url": body.base_url,
            "file_name": body.file_name,
        },
        triggered_by=username,
    )
    db.add(run)
    db.commit()
    db.refresh(run)

    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action="execute",
        resource_type="automation_run",
        resource_id=run_key,
        resource_name=f"Playwright run ({body.environment or 'no environment'})",
        status="success",
        details={
            "description": f"{username} started automation run {run_key}",
            "environment": body.environment,
            "base_url": body.base_url,
        },
    )

    job_manager.submit(run_key)
    return {"run_key": run_key, "status": "queued", "poll": f"/automation/runs/{run_key}"}


@router.get("/runs")
def list_runs(
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
    limit: int = Query(default=50, ge=1, le=200),
):
    runs = (
        db.query(AutomationRun).order_by(AutomationRun.created_at.desc()).limit(limit).all()
    )
    total = db.query(AutomationRun).count()
    finished = [r for r in runs if r.outcome in ("passed", "failed")]
    passed = sum(1 for r in finished if r.outcome == "passed")
    durations = [r.duration_seconds for r in runs if r.duration_seconds]

    return {
        "summary": {
            "total_runs": total,
            "pass_rate": round(100 * passed / len(finished)) if finished else None,
            "avg_duration_seconds": round(sum(durations) / len(durations)) if durations else None,
            "active": job_manager.active_count(),
            "capacity": job_manager.limit,
        },
        "runs": [_run_summary(r) for r in runs],
    }


@router.get("/runs/{run_key}")
def get_run(
    run_key: str,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    """One run with its per-test rows. This is what the UI polls."""
    run = db.query(AutomationRun).filter(AutomationRun.run_key == run_key).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    results = (
        db.query(AutomationRunResult)
        .filter(AutomationRunResult.run_id == run.id)
        .order_by(AutomationRunResult.id)
        .all()
    )

    metadata = run.run_metadata or {}
    code_val = metadata.get("code")
    if not code_val and run.script:
        code_val = run.script.code
    if not code_val and run.workspace_path:
        wp = Path(run.workspace_path)
        for spec_file in wp.glob("*.spec.ts"):
            try:
                code_val = spec_file.read_text(encoding="utf-8")
                break
            except Exception:
                pass

    return {
        **_run_summary(run),
        "has_log": bool(run.log_path and Path(run.log_path).exists()),
        # What actually executed, so the spec can be read beside its results.
        # Only on this endpoint: a code blob per row would inflate the runs
        # list many times over for a column nobody reads there.
        "spec": {
            "code": code_val,
            "file_name": metadata.get("file_name") or (run.script.file_name if run.script else "spec.ts"),
            "base_url": metadata.get("base_url") or (run.test_case.application_url if run.test_case else None),
        },
        "results": [
            {
                "id": r.id,
                "test_name": r.test_name,
                "status": r.status,
                "duration_ms": r.duration_ms,
                "error_message": r.error_message,
                "stack_trace": r.stack_trace,
                # Paths are never returned. The UI asks for evidence by kind
                # through the authenticated route below.
                "evidence": {
                    "screenshot": bool(r.screenshot_path),
                    "video": bool(r.video_path),
                    "trace": bool(r.trace_path),
                },
                "console_logs": r.console_logs,
                "network_logs": r.network_logs,
            }
            for r in results
        ],
    }


@router.post("/runs/{run_key}/cancel")
def cancel_run(
    run_key: str,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    run = db.query(AutomationRun).filter(AutomationRun.run_key == run_key).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.status not in ("queued", "running"):
        raise HTTPException(status_code=409, detail=f"Run is already {run.status}.")

    if not job_manager.cancel(run_key):
        raise HTTPException(
            status_code=409,
            detail="This run is not being executed by this process, so it cannot be cancelled here.",
        )
    return {"run_key": run_key, "cancelling": True}


class HealRunResponse(BaseModel):
    healed_code: str
    diagnosis: str
    changes_made: list[str] = Field(default_factory=list)
    original_code: str
    confidence: int = 85


@router.post("/runs/{run_key}/heal", response_model=HealRunResponse)
def heal_run_spec(
    run_key: str,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Diagnose a run and generate a repaired Playwright spec using the Healer Agent."""
    run = db.query(AutomationRun).filter(AutomationRun.run_key == run_key).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    metadata = run.run_metadata or {}
    code = metadata.get("code") or ""
    if not code and run.script:
        code = run.script.code or ""
    if not code:
        raise HTTPException(status_code=400, detail="This run has no script code stored.")

    first_fail = (
        db.query(AutomationRunResult)
        .filter(AutomationRunResult.run_id == run.id, AutomationRunResult.status.in_(["fail", "error"]))
        .first()
    )
    err_msg = (first_fail.error_message if first_fail else "") or (run.error_message or "")
    stack = first_fail.stack_trace if first_fail else ""

    discovered_rows = (
        db.query(AutomationDiscoveredElement)
        .join(
            AutomationDiscoveryRun,
            AutomationDiscoveredElement.discovery_run_id == AutomationDiscoveryRun.id,
        )
        .filter(AutomationDiscoveryRun.is_current == True)
        .all()
    )
    discovered_list = [
        {
            "role": d.role,
            "accessible_name": d.accessible_name,
            "recommended_locator": d.recommended_locator,
            "page_url": d.page_url,
        }
        for d in discovered_rows
    ]

    healed_code, diagnosis, changes = healer.diagnose_and_heal(
        code=code,
        error_message=err_msg,
        stack_trace=stack,
        discovered_elements=discovered_list,
        base_url=metadata.get("base_url"),
    )

    return HealRunResponse(
        healed_code=healed_code,
        diagnosis=diagnosis,
        changes_made=changes,
        original_code=code,
        confidence=90 if healed_code.strip() != code.strip() else 50,
    )


@router.post("/scripts/{script_id}/heal", response_model=HealRunResponse)
def heal_script_spec(
    script_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Diagnose a script and generate a repaired Playwright spec using the Healer Agent."""
    script = db.query(AutomationScript).filter(AutomationScript.id == script_id).first()
    if not script:
        raise HTTPException(status_code=404, detail="Script not found")

    code = script.code or ""
    if not code:
        raise HTTPException(status_code=400, detail="This script has no code.")

    latest_run = (
        db.query(AutomationRun)
        .filter(AutomationRun.script_id == script.id)
        .order_by(AutomationRun.id.desc())
        .first()
    )
    err_msg = ""
    stack = ""
    if latest_run:
        fail_res = (
            db.query(AutomationRunResult)
            .filter(AutomationRunResult.run_id == latest_run.id, AutomationRunResult.status.in_(["fail", "error"]))
            .first()
        )
        if fail_res:
            err_msg = fail_res.error_message or ""
            stack = fail_res.stack_trace or ""

    discovered_rows = (
        db.query(AutomationDiscoveredElement)
        .join(
            AutomationDiscoveryRun,
            AutomationDiscoveredElement.discovery_run_id == AutomationDiscoveryRun.id,
        )
        .filter(AutomationDiscoveryRun.is_current == True)
        .all()
    )
    discovered_list = [
        {
            "role": d.role,
            "accessible_name": d.accessible_name,
            "recommended_locator": d.recommended_locator,
            "page_url": d.page_url,
        }
        for d in discovered_rows
    ]

    healed_code, diagnosis, changes = healer.diagnose_and_heal(
        code=code,
        error_message=err_msg,
        stack_trace=stack,
        discovered_elements=discovered_list,
        base_url=None,
    )

    return HealRunResponse(
        healed_code=healed_code,
        diagnosis=diagnosis,
        changes_made=changes,
        original_code=code,
        confidence=90 if healed_code.strip() != code.strip() else 50,
    )



class DeleteRunsRequest(BaseModel):
    run_keys: list[str] = Field(min_length=1)


@router.post("/runs/delete")
def delete_runs(
    body: DeleteRunsRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Delete one or more automation runs, results, and on-disk workspaces."""
    username = (current_user or {}).get("username")
    runs = db.query(AutomationRun).filter(AutomationRun.run_key.in_(body.run_keys)).all()
    if not runs:
        return {"deleted": 0}

    deleted_count = 0
    for run in runs:
        # Cancel if active
        if job_manager.is_active(run.run_key):
            try:
                job_manager.cancel(run.run_key)
            except Exception:
                pass

        # If it was dry_run on a script, unlink it
        if run.script and run.script.dry_run_key == run.run_key:
            run.script.dry_run_key = None
            run.script.dry_run_status = "not_run"

        # Remove workspace directory if it exists
        if run.workspace_path:
            try:
                wp = Path(run.workspace_path)
                if wp.exists() and wp.is_dir():
                    shutil.rmtree(wp, ignore_errors=True)
            except Exception:
                pass

        # Also check default workspace location
        try:
            ws_dir = ws.workspace_dir_for_run(run.run_key)
            if ws_dir.exists() and ws_dir.is_dir():
                shutil.rmtree(ws_dir, ignore_errors=True)
        except Exception:
            pass

        db.delete(run)
        deleted_count += 1

    db.commit()

    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action="delete",
        resource_type="automation_run",
        resource_id=",".join(body.run_keys),
        resource_name=f"{deleted_count} run(s)",
        status="success",
        details={
            "description": f"{username} deleted {deleted_count} automation run(s)",
            "run_keys": body.run_keys,
        },
    )
    return {"deleted": deleted_count}


@router.delete("/runs/{run_key}")
def delete_single_run(
    run_key: str,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Delete a single automation run."""
    return delete_runs(DeleteRunsRequest(run_keys=[run_key]), db=db, current_user=current_user)


# ── Evidence ─────────────────────────────────────────────────────────────────

_ARTIFACT_KINDS = {
    "screenshot": ("screenshot_path", "image/png"),
    "video": ("video_path", "video/webm"),
    "trace": ("trace_path", "application/zip"),
}


def _guarded_path(raw_path: Optional[str]) -> Path:
    """Resolve an artifact path and refuse anything outside the storage root.

    These paths come from a Playwright report that a generated spec can
    influence, so containment is checked rather than trusted. Canonicalise
    first, then compare: checking the string before resolving would miss `..`
    and symlinks, which is the whole attack.
    """
    if not raw_path:
        raise HTTPException(status_code=404, detail="No such artifact for this test")

    resolved = Path(raw_path).resolve()
    root = ws.storage_root().resolve()
    try:
        resolved.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=403, detail="Artifact path is outside the storage root")

    if not resolved.exists():
        raise HTTPException(status_code=404, detail="The artifact file is no longer on disk")
    return resolved


@router.get("/runs/{run_key}/results/{result_id}/artifact/{kind}")
def get_artifact(
    run_key: str,
    result_id: int,
    kind: str,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    """Serve one piece of evidence: screenshot, video or trace."""
    if kind not in _ARTIFACT_KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown artifact kind '{kind}'. Expected one of: {', '.join(_ARTIFACT_KINDS)}",
        )

    run = db.query(AutomationRun).filter(AutomationRun.run_key == run_key).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    result = (
        db.query(AutomationRunResult)
        .filter(AutomationRunResult.id == result_id, AutomationRunResult.run_id == run.id)
        .first()
    )
    if not result:
        raise HTTPException(status_code=404, detail="Result not found for this run")

    attr, media_type = _ARTIFACT_KINDS[kind]
    path = _guarded_path(getattr(result, attr, None))
    return FileResponse(path, media_type=media_type, filename=path.name)


@router.get("/runs/{run_key}/log", response_class=PlainTextResponse)
def get_run_log(
    run_key: str,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    """Runner stdout and stderr for one run."""
    run = db.query(AutomationRun).filter(AutomationRun.run_key == run_key).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    path = _guarded_path(run.log_path)
    return PlainTextResponse(path.read_text(encoding="utf-8", errors="replace"))


# ── Intake: cases authored in the Studio ─────────────────────────────────────
#
# Hard rule for this module: manual and refined cases live in automation_*
# tables only. test_cases_details belongs to the review workflow, is read-only
# here, and nothing below holds a foreign key into it. A case that came from
# there keeps its identifier in origin_test_case_id as a plain string.
#
# Writes require automation.execute rather than automation.view. Authoring is a
# mutation, and refinement additionally spends a real LLM call, which is the
# same reason execution is gated. If authoring and running ever need to be
# granted separately, that is the point to add an automation.author permission.


class ManualTestCaseRequest(BaseModel):
    """A test case typed, pasted or imported into the Studio."""

    display_id: str = Field(min_length=1, max_length=100)
    category: Optional[str] = Field(default=None, max_length=255)
    description: Optional[str] = Field(default=None, max_length=5000)
    preconditions: Optional[str] = Field(default=None, max_length=10_000)
    steps_raw: Optional[str] = Field(default=None, max_length=50_000)
    test_data: Optional[str] = Field(default=None, max_length=10_000)
    expected_result: Optional[str] = Field(default=None, max_length=10_000)
    # Free text, kept as a string so an intake form need not know about the
    # applications table before that screen exists.
    origin_test_case_id: Optional[str] = Field(default=None, max_length=255)


class RefineRequest(BaseModel):
    """Optional grounding for a refinement call.

    Passing the real application URL is what stops the model inventing
    example.com and selectors that do not exist -- the prompt keys on it.
    """

    application_url: Optional[str] = Field(default=None, max_length=2000)
    application_name: Optional[str] = Field(default=None, max_length=255)
    requirement: Optional[str] = Field(default=None, max_length=10_000)


def _score_columns(payload: dict) -> dict:
    """Score a case with the same deterministic rules used everywhere else.

    The scorer accepts both the title-case keys stored by generation and the
    lower-case ones this table uses, so a Studio case and an approved case are
    judged identically.
    """
    result = score_test_case(payload)
    return {
        "eligibility_score": result.score,
        "eligibility_verdict": result.verdict,
        "eligibility_reasons": result.reasons,
    }


def _case_detail(case: AutomationTestCase) -> dict:
    return {
        "id": case.id,
        "source": case.source,
        "parent_id": case.parent_id,
        "origin_test_case_id": case.origin_test_case_id,
        "display_id": case.display_id,
        "category": case.category,
        "description": case.description,
        "preconditions": case.preconditions,
        "steps_raw": case.steps_raw,
        "test_data": case.test_data,
        "expected_result": case.expected_result,
        "steps_structured": case.steps_structured or [],
        "test_data_requirements": case.test_data_requirements or [],
        "automation_blockers": case.automation_blockers or [],
        "eligibility": {
            "score": case.eligibility_score,
            "verdict": case.eligibility_verdict,
            "reasons": case.eligibility_reasons or [],
            "step_count": len(case.steps_structured or []),
            "can_generate": case.eligibility_verdict in ("ready", "review"),
        },
        "created_by": case.created_by,
        "created_at": case.created_at.isoformat() if case.created_at else None,
        "updated_at": case.updated_at.isoformat() if case.updated_at else None,
    }


def _load_case(db: Session, case_id: int) -> AutomationTestCase:
    case = db.query(AutomationTestCase).filter(AutomationTestCase.id == case_id).first()
    if not case:
        raise HTTPException(status_code=404, detail="Test case not found in the Studio")
    return case


@router.get("/llm")
def get_llm_status(current_user: dict = Depends(require_permission(PERM_VIEW))):
    """Whether refinement could run right now.

    Same intent as /runtime: a missing key should be visible before someone
    clicks Refine, not after a failed call.
    """
    return provider_status()


@router.post("/candidates", status_code=201)
def create_candidate(
    body: ManualTestCaseRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Author a test case directly in the Studio."""
    username = (current_user or {}).get("username")
    payload = body.model_dump()

    case = AutomationTestCase(
        source="manual",
        created_by=username,
        **payload,
        **_score_columns(payload),
    )
    db.add(case)
    db.commit()
    db.refresh(case)

    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action="create",
        resource_type="automation_test_case",
        resource_id=str(case.id),
        resource_name=case.display_id,
        status="success",
        details={"description": f"{username} authored test case {case.display_id}"},
    )
    return _case_detail(case)


@router.get("/candidates/manual/{case_id}")
def get_candidate(
    case_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    return _case_detail(_load_case(db, case_id))


@router.put("/candidates/manual/{case_id}")
def update_candidate(
    case_id: int,
    body: ManualTestCaseRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Edit a Studio case and re-score it.

    Re-scoring on every write is the point: an edit that adds the missing
    expected result should move the verdict immediately, not at the next full
    listing.
    """
    case = _load_case(db, case_id)
    payload = body.model_dump()
    for field, value in payload.items():
        setattr(case, field, value)
    for field, value in _score_columns(payload).items():
        setattr(case, field, value)

    db.commit()
    db.refresh(case)
    return _case_detail(case)


@router.delete("/candidates/manual/{case_id}", status_code=204)
def delete_candidate(
    case_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    case = _load_case(db, case_id)
    if case.scripts:
        raise HTTPException(
            status_code=409,
            detail=(
                f"This case has {len(case.scripts)} generated script(s). Delete those "
                "first, so a run's history never points at a case that no longer exists."
            ),
        )
    username = (current_user or {}).get("username")
    display_id = case.display_id
    db.delete(case)
    db.commit()

    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action="delete",
        resource_type="automation_test_case",
        resource_id=str(case_id),
        resource_name=display_id,
        status="success",
        details={"description": f"{username} deleted Studio test case {display_id}"},
    )
    return None


# Column aliases accepted on import. Spreadsheets exported from the review
# workflow use the title-case names; a hand-rolled CSV usually does not.
# Moved to services/automation/eligibility.py, beside the field constants these
# alias, when document intake became a second consumer. Same table, same
# behaviour; the local name is kept so the usages below read unchanged.
_CSV_ALIASES = COLUMN_ALIASES

MAX_CSV_ROWS = 500


@router.post("/candidates/import", status_code=201)
def import_candidates(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Bulk intake from CSV.

    Header matching is alias-based and case-insensitive because the two CSVs
    people actually have -- a spreadsheet exported from the review workflow and
    something hand-rolled -- disagree on every column name. A row missing a
    display_id is reported by line number rather than silently skipped.
    """
    raw = file.file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    try:
        text_body = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text_body = raw.decode("latin-1")

    reader = csv.DictReader(io.StringIO(text_body))
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="The CSV has no header row.")

    lookup = {}
    for column, aliases in _CSV_ALIASES.items():
        for name in reader.fieldnames:
            if (name or "").strip().lower() in aliases:
                lookup[column] = name
                break

    if "display_id" not in lookup:
        raise HTTPException(
            status_code=400,
            detail=(
                "No column maps to display_id. Expected one of: "
                + ", ".join(_CSV_ALIASES["display_id"])
                + f". Found: {', '.join(n for n in reader.fieldnames if n)}"
            ),
        )

    username = (current_user or {}).get("username")
    created, skipped = [], []

    for line_no, row in enumerate(reader, start=2):
        if len(created) >= MAX_CSV_ROWS:
            skipped.append({"line": line_no, "reason": f"Exceeded the {MAX_CSV_ROWS}-row limit"})
            break

        payload = {
            column: (row.get(source_name) or "").strip() or None
            for column, source_name in lookup.items()
        }
        if not payload.get("display_id"):
            skipped.append({"line": line_no, "reason": "No test case ID"})
            continue
        payload.setdefault("origin_test_case_id", None)
        payload["display_id"] = payload["display_id"][:100]

        case = AutomationTestCase(
            source="manual",
            created_by=username,
            **payload,
            **_score_columns(payload),
        )
        db.add(case)
        created.append(case)

    db.commit()
    for case in created:
        db.refresh(case)

    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action="import",
        resource_type="automation_test_case",
        resource_id=file.filename or "upload.csv",
        resource_name=file.filename or "upload.csv",
        status="success",
        details={
            "description": f"{username} imported {len(created)} test case(s) from CSV",
            "skipped": len(skipped),
        },
    )

    return {
        "imported": len(created),
        "skipped": skipped,
        "cases": [_case_detail(case) for case in created],
    }


@router.post("/candidates/manual/{case_id}/refine", status_code=201)
def refine_candidate(
    case_id: int,
    body: RefineRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Rewrite a case into automation-ready form via the LLM.

    The result is stored as a NEW row with source="refined" and parent_id
    pointing at the original, rather than overwriting it. Refinement is a model
    judgement: keeping the original is what lets a reviewer compare the two and
    reject the rewrite, and what makes a second refinement reproducible.
    """
    case = _load_case(db, case_id)
    username = (current_user or {}).get("username")

    existing = {
        "display_id": case.display_id,
        "category": case.category,
        "description": case.description,
        "preconditions": case.preconditions,
        "steps_raw": case.steps_raw,
        "test_data": case.test_data,
        "expected_result": case.expected_result,
    }

    try:
        refined = refine_case_content(
            ref=f"case-{case.id}",
            title=case.display_id,
            existing=existing,
            requirement=body.requirement,
            application_url=body.application_url,
            application_name=body.application_name,
        )
    except LLMError as exc:
        # The transport already explains itself; 502 says the failure was
        # upstream rather than in the request.
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    columns = refined_to_columns(refined)
    # The refined title is the model echoing the original back; keep the
    # Studio's own identifier rather than letting a rewrite rename the case.
    columns["display_id"] = case.display_id

    child = AutomationTestCase(
        source="refined",
        parent_id=case.id,
        origin_test_case_id=case.origin_test_case_id,
        origin_request_id=case.origin_request_id,
        category=case.category,
        created_by=username,
        **columns,
    )
    db.add(child)
    db.commit()
    db.refresh(child)

    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action="refine",
        resource_type="automation_test_case",
        resource_id=str(child.id),
        resource_name=child.display_id,
        status="success",
        details={
            "description": f"{username} refined test case {case.display_id}",
            "parent_id": case.id,
            "provider": provider_status().get("provider"),
        },
    )

    return {
        "original": _case_detail(case),
        "refined": _case_detail(child),
        "bdd_scenario": refined.bdd_scenario,
        "test_data_required": refined.test_data_required,
        "test_data_notes": refined.test_data_notes,
    }


# ── Automation TC Coverage Assessment ────────────────────────────────────────
#
# The workbench: approved test cases come in, get refined in place keeping ID
# and name, are classified, and go through approval on their way to the Script
# Lab.
#
# Ported in behaviour from stlc-platform's test-cases view, without its project
# scope. Grounding is deliberately absent -- it belongs to Application
# Discovery, which is a separate screen.


class GenerateRequest(BaseModel):
    """What to refine.

    Two id spaces on purpose. `source_test_case_ids` are approved cases from
    the review workflow, identified by their string ids there; `case_ids` are
    rows the Studio already owns. The screen can select from both lists at once.
    """

    source_test_case_ids: list[str] = Field(default_factory=list)
    case_ids: list[int] = Field(default_factory=list)
    application_id: Optional[int] = None
    application_url: Optional[str] = Field(default=None, max_length=2000)
    application_name: Optional[str] = Field(default=None, max_length=255)
    environment: Optional[str] = Field(default=None, max_length=50)
    # Without this a second generate would build a duplicate alongside the
    # first, which is the confusion the upstream screen warns about inline.
    regenerate: bool = False


class ClassifyRequest(BaseModel):
    case_ids: list[int] = Field(min_length=1)
    # Omitted means "apply the rules"; supplied means a human decided.
    classification: Optional[str] = Field(default=None, pattern="^(automation|manual|undecided)$")


class DecideRequest(BaseModel):
    case_ids: list[int] = Field(min_length=1)
    decision: str = Field(pattern="^(approve|reject)$")
    reason: Optional[str] = Field(default=None, max_length=2000)


class BulkIdsRequest(BaseModel):
    case_ids: list[int] = Field(min_length=1)


class EditCaseRequest(BaseModel):
    """Fields the inline editor may change. Everything else is derived."""

    title: Optional[str] = Field(default=None, max_length=500)
    objective: Optional[str] = Field(default=None, max_length=5000)
    preconditions: Optional[str] = Field(default=None, max_length=10_000)
    steps_raw: Optional[str] = Field(default=None, max_length=50_000)
    test_data: Optional[str] = Field(default=None, max_length=10_000)
    expected_result: Optional[str] = Field(default=None, max_length=10_000)
    priority: Optional[str] = Field(default=None, max_length=20)
    test_type: Optional[str] = Field(default=None, max_length=50)
    test_data_notes: Optional[str] = Field(default=None, max_length=2000)

    # The approval gate, set by a human rather than derived. Ticking "required"
    # re-blocks the case; clearing it records that the data now exists. The
    # status is constrained here rather than left free-form because can_approve
    # keys on the exact string, and a typo would silently unblock a case.
    test_data_required: Optional[bool] = None
    test_data_status: Optional[str] = Field(
        default=None, pattern="^(not_required|pending|ready|user_provided)$"
    )
    steps_structured: Optional[list[dict]] = None


def _parse_raw_steps_to_structured(steps_raw: Optional[str], expected_result: Optional[str] = None) -> list[dict]:
    if not steps_raw:
        return []
    raw_lines = [line.strip() for line in str(steps_raw).split("\n") if line.strip()]
    exp_lines = [e.strip() for e in str(expected_result or "").split("\n") if e.strip()]
    structured = []
    for i, r_line in enumerate(raw_lines):
        clean_act = r_line
        if clean_act.lower().startswith("step ") and ":" in clean_act:
            clean_act = clean_act.split(":", 1)[1].strip()
        elif "." in clean_act and clean_act.split(".", 1)[0].isdigit():
            clean_act = clean_act.split(".", 1)[1].strip()
        elif ")" in clean_act and clean_act.split(")", 1)[0].isdigit():
            clean_act = clean_act.split(")", 1)[1].strip()

        clean_exp = ""
        if i < len(exp_lines):
            clean_exp = exp_lines[i]
            if clean_exp.lower().startswith("step ") and ":" in clean_exp:
                clean_exp = clean_exp.split(":", 1)[1].strip()
            elif "." in clean_exp and clean_exp.split(".", 1)[0].isdigit():
                clean_exp = clean_exp.split(".", 1)[1].strip()
            elif ")" in clean_exp and clean_exp.split(")", 1)[0].isdigit():
                clean_exp = clean_exp.split(")", 1)[1].strip()

        structured.append(
            {
                "step_number": i + 1,
                "action": clean_act,
                "target": None,
                "test_data_ref": None,
                "expected_result": clean_exp or None,
            }
        )
    return structured


def _workbench_case(case: AutomationTestCase, source_missing: bool = False) -> dict:
    """One row of the refined grid."""
    detail = _case_detail(case)
    steps = case.steps_structured or []
    if not steps and case.steps_raw:
        steps = _parse_raw_steps_to_structured(case.steps_raw, case.expected_result)

    detail.update(
        {
            "tc_display_id": case.display_id,
            "title": case.description or case.objective or case.display_id,
            "objective": case.objective or case.description or case.display_id,
            "bdd_scenario": case.bdd_scenario,
            "priority": case.priority,
            "test_type": case.test_type,
            "origin": case.origin,
            "classification": case.classification,
            "classification_source": case.classification_source,
            "classification_reason": case.classification_reason,
            "manual_only_reasons": case.manual_only_reasons or [],
            "test_data_required": bool(case.test_data_required),
            "test_data_status": case.test_data_status,
            "test_data_notes": case.test_data_notes,
            "approval_status": case.approval_status,
            "decision_reason": case.decision_reason,
            "approved_by": case.approved_by,
            "approved_at": case.approved_at.isoformat() if case.approved_at else None,
            "version": case.version,
            "application_url": case.application_url,
            "steps": steps,
            # The source it was refined from has been deleted, so regenerating
            # would build a second case rather than replacing this one.
            "source_missing": source_missing,
            "can_approve": wb.can_approve(case)[0],
            "approve_blocked_reason": wb.can_approve(case)[1] or None,
            # Grounding: whether the steps resolve to controls that exist.
            "grounding_status": case.grounding_status,
            "grounding_summary": case.grounding_summary,
            "grounded_at": case.grounded_at.isoformat() if case.grounded_at else None,
            "discovery_run_id": case.discovery_run_id,
            "flow_discovery_status": case.flow_discovery_status or "none",
            "recorded_flow_objects": case.recorded_flow_objects or [],
            "recorded_flow_objects_count": len(case.recorded_flow_objects or []),
            # Quality Review (eSMART Review Agent)
            "review_score": case.review_score,
            "review_verdict": case.review_verdict,
            "review_scores": case.review_scores or {},
            "review_findings": case.review_findings or {},
            "reviewed_at": case.reviewed_at.isoformat() if case.reviewed_at else None,
        }
    )
    return detail


@router.get("/workbench/sources")
def list_workbench_sources(
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
    search: Optional[str] = Query(default=None, max_length=200),
):
    """Approved test cases available to refine, and whether each already was.

    This is the "Uploaded test cases" panel. The cases stay in the review
    workflow -- refining reads them and writes a Studio row, and the panel shows
    a Refined badge by looking for that row rather than by writing anything back.
    """
    sources = _approved_candidates(db, search)
    refined = {
        row.origin_test_case_id: row.id
        for row in db.query(AutomationTestCase)
        .filter(
            AutomationTestCase.source == "refined",
            AutomationTestCase.origin_test_case_id.isnot(None),
        )
        .all()
    }

    out = []
    for source in sources:
        origin_id = source.get("origin_test_case_id")
        out.append(
            {
                "id": origin_id,
                "origin": "approved",
                "tc_display_id": source.get("display_id"),
                "title": source.get("description") or source.get("display_id"),
                "category": source.get("category"),
                "eligibility": source.get("eligibility"),
                "refined_test_case_id": refined.get(origin_id),
            }
        )

    # --- Automation Module: the second way in --------------------------------
    #
    # Studio-owned cases that never went through the review workflow: CSV
    # imports, manually authored cases, and now document intake. They were
    # always refinable -- /workbench/generate has taken `case_ids` alongside
    # `source_test_case_ids` since it was written -- but nothing listed them
    # here, so the only route to that parameter was the Candidates screen.
    #
    # `origin` is what tells the two apart on the wire. An approved case's id
    # is a review-workflow test_case_id (a string); a studio case's is this
    # table's integer primary key, and they go into different request fields.
    studio_query = db.query(AutomationTestCase).filter(AutomationTestCase.source == "manual")
    if search:
        pattern = f"%{search.strip()}%"
        studio_query = studio_query.filter(
            AutomationTestCase.display_id.ilike(pattern)
            | AutomationTestCase.description.ilike(pattern)
        )

    # How a refined row points back at the studio case it came from. NOT
    # parent_id, which stays null on this path: /workbench/generate stamps
    # origin_test_case_id with "studio-<id>" for an imported item, and that
    # string is the only link there is. Keying on parent_id here meant the
    # Refined badge never lit for a studio case and the regenerate guard never
    # fired, so pressing Generate twice silently built a second refined row.
    refined_from_studio = {
        row.origin_test_case_id
        for row in db.query(AutomationTestCase)
        .filter(
            AutomationTestCase.source == "refined",
            AutomationTestCase.origin_test_case_id.like("studio-%"),
        )
        .all()
    }

    for case in studio_query.order_by(AutomationTestCase.display_id).all():
        out.append(
            {
                "id": str(case.id),
                "origin": "studio",
                "tc_display_id": case.display_id,
                "title": case.description or case.display_id,
                "category": case.category,
                "eligibility": {
                    "score": case.eligibility_score,
                    "verdict": case.eligibility_verdict,
                    "reasons": case.eligibility_reasons or [],
                    "step_count": len(case.steps_structured or []),
                    "can_generate": case.eligibility_verdict in ("ready", "review"),
                },
                "refined_test_case_id": (
                    case.id if f"studio-{case.id}" in refined_from_studio else None
                ),
            }
        )

    return {"sources": out, "total": len(out)}


class DeleteWorkbenchSourcesRequest(BaseModel):
    source_test_case_ids: list[str] = Field(default_factory=list)
    case_ids: list[int] = Field(default_factory=list)


@router.post("/workbench/sources/delete")
def delete_workbench_sources(
    body: DeleteWorkbenchSourcesRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Delete approved source test cases and/or manual studio test cases."""
    username = (current_user or {}).get("username")
    deleted_approved = 0
    deleted_studio = 0
    scripts_removed = 0

    # 1. Delete approved test cases from test_cases_details
    if body.source_test_case_ids:
        # Also clean up any refined cases in automation_test_cases linked to these approved cases
        linked_refined = (
            db.query(AutomationTestCase)
            .filter(
                AutomationTestCase.source == "refined",
                AutomationTestCase.origin_test_case_id.in_(body.source_test_case_ids),
            )
            .all()
        )
        for refined_case in linked_refined:
            scripts_removed += len(refined_case.scripts or [])
            for script in list(refined_case.scripts or []):
                db.delete(script)
            db.delete(refined_case)

        approved_rows = (
            db.query(TestCaseDetail)
            .filter(TestCaseDetail.test_case_id.in_(body.source_test_case_ids))
            .all()
        )
        deleted_approved = len(approved_rows)
        for row in approved_rows:
            db.delete(row)

    # 2. Delete studio manual cases from automation_test_cases
    if body.case_ids:
        studio_prefixes = [f"studio-{cid}" for cid in body.case_ids]
        linked_refined_studio = (
            db.query(AutomationTestCase)
            .filter(
                AutomationTestCase.source == "refined",
                AutomationTestCase.origin_test_case_id.in_(studio_prefixes),
            )
            .all()
        )
        for refined_case in linked_refined_studio:
            scripts_removed += len(refined_case.scripts or [])
            for script in list(refined_case.scripts or []):
                db.delete(script)
            db.delete(refined_case)

        studio_cases = (
            db.query(AutomationTestCase)
            .filter(
                AutomationTestCase.id.in_(body.case_ids),
                AutomationTestCase.source == "manual",
            )
            .all()
        )
        deleted_studio = len(studio_cases)
        for case in studio_cases:
            scripts_removed += len(case.scripts or [])
            for script in list(case.scripts or []):
                db.delete(script)
            db.delete(case)

    db.commit()

    total_deleted = deleted_approved + deleted_studio
    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action="delete",
        resource_type="automation_source_cases",
        resource_id=",".join(body.source_test_case_ids + [str(i) for i in body.case_ids]),
        resource_name=f"{total_deleted} source test case(s)",
        status="success",
        details={
            "description": f"{username} deleted {total_deleted} source test case(s)",
            "deleted_approved": deleted_approved,
            "deleted_studio": deleted_studio,
            "scripts_removed": scripts_removed,
        },
    )
    return {
        "deleted": total_deleted,
        "deleted_approved": deleted_approved,
        "deleted_studio": deleted_studio,
        "scripts_removed": scripts_removed,
    }



class RefineCasesInPlaceRequest(BaseModel):
    case_ids: list[int] = Field(min_length=1)
    application_url: Optional[str] = None


@router.get("/workbench/test-cases")
def list_workbench_cases(
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
    classification: str = Query(default="all", pattern="^(all|automation|manual|undecided)$"),
):
    """The refined grid, with the counts the stat tiles show."""
    from ..services.automation import workbench as wb

    # Auto-sync any approved test cases from Manager Review into AutomationTestCase
    try:
        wb.sync_approved_test_cases(db)
    except Exception as e:
        logger.warning("Failed to auto-sync approved test cases: %s", e)

    # Fetch all studio test cases
    cases = db.query(AutomationTestCase).order_by(AutomationTestCase.id.desc()).all()

    known_sources = {
        str(row[0])
        for row in db.execute(
            text("SELECT test_case_id FROM test_cases_details WHERE status = 'APPROVED'")
        ).fetchall()
    }

    rows = [
        _workbench_case(
            case,
            source_missing=bool(
                case.origin_test_case_id and case.origin_test_case_id not in known_sources
            ),
        )
        for case in cases
    ]

    counts = {
        "total": len(rows),
        "automation": sum(1 for r in rows if r["classification"] == "automation"),
        "manual": sum(1 for r in rows if r["classification"] == "manual"),
        "undecided": sum(1 for r in rows if r["classification"] == "undecided"),
        "approved": sum(1 for r in rows if r["approval_status"] == "approved"),
        "rejected": sum(1 for r in rows if r["approval_status"] == "rejected"),
        "needs_data": sum(1 for r in rows if r["test_data_status"] == "pending"),
    }

    if classification != "all":
        rows = [r for r in rows if r["classification"] == classification]

    return {"counts": counts, "test_cases": rows}


@router.post("/workbench/test-cases/refine-bulk")
def refine_cases_in_place(
    body: RefineCasesInPlaceRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Run AI refinement directly on selected test cases in place."""
    from ..services.automation import workbench as wb

    actor = (current_user or {}).get("username", "user")
    cases = db.query(AutomationTestCase).filter(AutomationTestCase.id.in_(body.case_ids)).all()
    if not cases:
        raise HTTPException(status_code=404, detail="No matching test cases found to refine.")

    refined_results = []
    for c in cases:
        try:
            existing_dict = {
                "Test Case ID": c.display_id,
                "Test Case Description": c.description or c.objective or c.display_id,
                "Preconditions": c.preconditions or "",
                "Test Steps": c.steps_raw or "\n".join(
                    f"{s.get('step_number', i)}. {s.get('action', '')}"
                    for i, s in enumerate(c.steps_structured or [], 1)
                ),
                "Test Data": c.test_data or "",
                "Expected Result": c.expected_result or "",
            }
            ref_out = wb._refine_one(
                db=db,
                case_dict=existing_dict,
                display_id=c.display_id,
                origin=c.origin or "imported",
                origin_test_case_id=c.origin_test_case_id or f"studio-{c.id}",
                category=c.category,
                application_url=body.application_url or c.application_url,
                replace=c,
                actor=actor,
            )
            refined_results.append(_workbench_case(ref_out))
        except Exception as e:
            logger.error("In-place refinement failed for case %s: %s", c.display_id, e)

    return {"refined_count": len(refined_results), "test_cases": refined_results}


@router.post("/workbench/test-cases/{case_id}/refine")
def refine_single_case_in_place(
    case_id: int,
    body: Optional[RefineCasesInPlaceRequest] = None,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Run AI refinement on a single test case in place."""
    req = RefineCasesInPlaceRequest(case_ids=[case_id], application_url=body.application_url if body else None)
    res = refine_cases_in_place(req, db, current_user)
    if res["test_cases"]:
        return res["test_cases"][0]
    raise HTTPException(status_code=500, detail="Refinement failed for this test case.")


@router.post("/workbench/generate", status_code=202)
def generate_refined_cases(
    body: GenerateRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Refine a batch. Returns 202 with a job_id to poll.

    Refusing up front rather than mid-batch: an unconfigured LLM provider would
    otherwise fail on every case in turn and report thirty identical errors.
    """
    status = provider_status()
    if not status.get("configured"):
        raise HTTPException(status_code=503, detail=status.get("detail"))

    username = (current_user or {}).get("username")
    items: list[dict[str, Any]] = []

    for source_id in body.source_test_case_ids:
        row = db.execute(
            text(
                "SELECT test_case_id, test_case_details FROM test_cases_details "
                "WHERE test_case_id = :tid AND status = 'APPROVED'"
            ),
            {"tid": source_id},
        ).fetchone()
        if not row:
            continue
        try:
            details = json.loads(row.test_case_details) if isinstance(row.test_case_details, str) else (row.test_case_details or {})
        except (TypeError, ValueError):
            details = {}
        items.append(
            {
                "display_id": str(details.get("Test Case ID") or row.test_case_id),
                "origin_test_case_id": str(row.test_case_id),
                "origin": "existing",
                "category": details.get("Category"),
                "existing": details,
            }
        )

    for case_id in body.case_ids:
        case = db.query(AutomationTestCase).filter(AutomationTestCase.id == case_id).first()
        if not case:
            continue
        items.append(
            {
                "display_id": case.display_id,
                "origin_test_case_id": case.origin_test_case_id or f"studio-{case.id}",
                "origin": "imported",
                "category": case.category,
                "existing": {
                    "description": case.description,
                    "preconditions": case.preconditions,
                    "steps_raw": case.steps_raw,
                    "test_data": case.test_data,
                    "expected_result": case.expected_result,
                },
            }
        )

    if not items:
        raise HTTPException(
            status_code=400,
            detail="Nothing to refine. Select at least one approved or Studio test case.",
        )

    job = wb.start_generation_job(
        items,
        application_url=body.application_url,
        application_name=body.application_name,
        actor=username,
        regenerate=body.regenerate,
    )

    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action="refine",
        resource_type="automation_test_case",
        resource_id=job.id,
        resource_name=f"{len(items)} test case(s)",
        status="success",
        details={
            "description": f"{username} started refinement of {len(items)} test case(s)",
            "regenerate": body.regenerate,
        },
    )
    return job.to_dict()


@router.get("/workbench/jobs/{job_id}")
def get_generation_job(
    job_id: str,
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    job = wb.job_registry.get(job_id)
    if not job:
        raise HTTPException(
            status_code=404,
            detail="No such job. Generation jobs are kept in memory and are lost on restart.",
        )
    return job.to_dict()


@router.post("/workbench/classify")
def classify_cases(
    body: ClassifyRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Bulk classify -- by rule when no classification is supplied."""
    username = (current_user or {}).get("username")
    cases = (
        db.query(AutomationTestCase)
        .filter(AutomationTestCase.id.in_(body.case_ids))
        .all()
    )
    for case in cases:
        wb.apply_classification(case, forced=body.classification, actor=username)
    db.commit()
    return {
        "updated": len(cases),
        "test_cases": [_workbench_case(case) for case in cases],
    }


@router.post("/workbench/decide")
def decide_cases(
    body: DecideRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Bulk approve or reject.

    Approval is refused per case rather than for the batch, so one case waiting
    on test data does not block the other twenty-nine. The refusals come back
    named.
    """
    username = (current_user or {}).get("username")
    cases = (
        db.query(AutomationTestCase)
        .filter(AutomationTestCase.id.in_(body.case_ids))
        .all()
    )

    updated, refused = [], []
    for case in cases:
        if body.decision == "approve":
            allowed, why = wb.can_approve(case)
            if not allowed:
                refused.append({"id": case.id, "display_id": case.display_id, "reason": why})
                continue
            case.approval_status = wb.APPROVAL_APPROVED
            case.approved_by = username
            case.approved_at = datetime.utcnow()
        else:
            case.approval_status = wb.APPROVAL_REJECTED
            case.approved_by = None
            case.approved_at = None
        case.decision_reason = body.reason
        updated.append(case)

    db.commit()

    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action=body.decision,
        resource_type="automation_test_case",
        resource_id=",".join(str(c.id) for c in updated) or "none",
        resource_name=f"{len(updated)} test case(s)",
        status="success",
        details={
            "description": f"{username} {body.decision}d {len(updated)} test case(s)",
            "refused": len(refused),
        },
    )

    return {
        "updated": len(updated),
        "refused": refused,
        "test_cases": [_workbench_case(case) for case in updated],
    }


@router.post("/workbench/test-cases/{case_id}/reopen")
def reopen_case(
    case_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Return an approved case to draft so it can be edited again."""
    case = _load_case(db, case_id)
    case.approval_status = wb.APPROVAL_DRAFT
    case.approved_by = None
    case.approved_at = None
    case.decision_reason = None
    db.commit()
    db.refresh(case)
    return _workbench_case(case)


@router.patch("/workbench/test-cases/{case_id}")
def edit_workbench_case(
    case_id: int,
    body: EditCaseRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Inline edit, then re-derive everything that depends on the content."""
    case = _load_case(db, case_id)
    if case.approval_status == wb.APPROVAL_APPROVED:
        raise HTTPException(
            status_code=409,
            detail="This case is approved. Reopen it before editing.",
        )

    payload = body.model_dump(exclude_unset=True)
    if "title" in payload and payload["title"]:
        case.display_id = payload.pop("title")[:100]
    for field_name, value in payload.items():
        setattr(case, field_name, value)

    if "steps_structured" in payload and payload["steps_structured"] is not None:
        case.steps_structured = payload["steps_structured"]
        # Re-construct steps_raw from structured steps for consistency
        case.steps_raw = "\n".join(
            f"{s.get('step_number', i)}. {s.get('action', '')}"
            for i, s in enumerate(case.steps_structured, start=1)
        )
    elif "steps_raw" in payload and payload["steps_raw"]:
        raw_list = split_steps(payload["steps_raw"])
        if raw_list:
            case.steps_structured = [
                {
                    "step_number": i,
                    "action": s.strip(),
                    "target": s.strip(),
                    "test_data_ref": None,
                    "expected_result": None,
                }
                for i, s in enumerate(raw_list, start=1)
            ]

    # Supersede any existing scripts for this case so generating/running always reflects edits
    db.query(AutomationScript).filter(AutomationScript.test_case_id == case.id).update(
        {"is_current": False}
    )

    wb.rescore(case)

    # Re-evaluate review quality score after manual edit
    try:
        from ..services.automation.review_agent import review_test_case
        review_test_case(case, db=db)
    except Exception as e:
        logger.warning("Quality review re-score skipped for %s: %s", case.display_id, e)

    db.commit()
    db.refresh(case)
    return _workbench_case(case)


@router.post("/workbench/delete")
def delete_workbench_cases(
    body: BulkIdsRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Delete refined cases and the scripts generated from them.

    Cascading is stated rather than discovered: a script whose test case is
    gone cannot be regenerated or explained, so leaving it would be leaving
    rubbish behind.
    """
    username = (current_user or {}).get("username")
    cases = (
        db.query(AutomationTestCase)
        .filter(AutomationTestCase.id.in_(body.case_ids))
        .all()
    )
    scripts_removed = 0
    for case in cases:
        scripts_removed += len(case.scripts or [])
        for script in list(case.scripts or []):
            db.delete(script)
        db.delete(case)
    db.commit()

    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action="delete",
        resource_type="automation_test_case",
        resource_id=",".join(str(i) for i in body.case_ids),
        resource_name=f"{len(cases)} test case(s)",
        status="success",
        details={
            "description": f"{username} deleted {len(cases)} refined test case(s)",
            "scripts_removed": scripts_removed,
        },
    )
    return {"deleted": len(cases), "scripts_removed": scripts_removed}


@router.get("/workbench/export")
def export_workbench_cases(
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
    classification: str = Query(default="all", pattern="^(all|automation|manual)$"),
):
    """Download refined cases as CSV.

    CSV rather than a workbook because neither openpyxl nor xlsxwriter is a
    dependency of this backend, and adding one to format a download would be
    the wrong place to pay that cost -- the frontend already ships SheetJS and
    builds the two-sheet workbook from this data client-side.
    """
    query = db.query(AutomationTestCase).filter(AutomationTestCase.source == "refined")
    if classification != "all":
        query = query.filter(AutomationTestCase.classification == classification)
    cases = query.order_by(AutomationTestCase.display_id).all()

    columns = [
        "Test Case ID", "Title", "Objective", "Category", "Priority", "Test Type",
        "Classification", "Classification Reason", "Preconditions", "Test Steps",
        "Test Data", "Expected Result", "BDD Scenario", "Test Data Required",
        "Test Data Status", "Status", "Version", "Application URL",
    ]

    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(columns)
    for case in cases:
        writer.writerow([
            case.display_id, case.display_id, case.objective or "", case.category or "",
            case.priority or "", case.test_type or "", case.classification or "",
            case.classification_reason or "", case.preconditions or "", case.steps_raw or "",
            case.test_data or "", case.expected_result or "", case.bdd_scenario or "",
            "Yes" if case.test_data_required else "No", case.test_data_status or "",
            case.approval_status or "", case.version or 1, case.application_url or "",
        ])

    filename = f"automation-test-cases-{classification}.csv"
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Automation Script Lab ────────────────────────────────────────────────────
#
# Generate, review, dry-run and download scripts for approved automation test
# cases.
#
# A dry run IS a run: it goes through the same job manager, workspace and
# evidence pipeline as everything on the Runs tab, linked by dry_run_key. A
# second execution path would mean a second set of timeouts, a second way to
# capture a trace, and two places to look when something hangs.


class GenerateScriptsRequest(BaseModel):
    case_ids: list[int] = Field(min_length=1)
    framework: str = Field(default="playwright")
    # Which application's discovery catalogue to compile against. Omitted is
    # fine while one application is registered; with several it has to be said.
    application_id: Optional[int] = None
    base_url: Optional[str] = Field(default=None, max_length=2000)
    # Regenerating replaces the current script for the pair rather than adding
    # a version nobody asked for.
    regenerate: bool = True


class DryRunRequest(BaseModel):
    script_ids: list[int] = Field(min_length=1)
    environment: Optional[str] = Field(default=None, max_length=50)
    base_url: Optional[str] = Field(default=None, max_length=2000)
    slow_mo_ms: Optional[int] = Field(default=None, ge=0, le=10000)
    headless: Optional[bool] = Field(default=True)


class EditScriptRequest(BaseModel):
    code: str = Field(min_length=1, max_length=200_000)


class ScriptDecisionRequest(BaseModel):
    decision: str = Field(pattern="^(approve|reject)$")
    reason: Optional[str] = Field(default=None, max_length=2000)


def _script_detail(script: AutomationScript) -> dict:
    case = script.test_case
    return {
        "id": script.id,
        "test_case_id": script.test_case_id,
        "test_case_display_id": case.display_id if case else None,
        "test_case_title": (case.objective or case.description) if case else None,
        "framework": script.framework,
        "language": script.language,
        "file_name": script.file_name,
        "script_key": script.script_key,
        "code": script.code,
        "entry_path": script.entry_path,
        "execution_command": script.execution_command,
        "setup_notes": script.setup_notes or [],
        "generation_mode": script.generation_mode,
        "static_gate_result": script.static_gate_result,
        "dry_run_status": script.dry_run_status or "not_run",
        "dry_run_summary": script.dry_run_summary,
        "dry_run_at": script.dry_run_at.isoformat() if script.dry_run_at else None,
        "dry_run_key": script.dry_run_key,
        "status": script.status,
        "version": script.version,
        "is_current": bool(script.is_current),
        "edited_by_user": bool(script.edited_by_user),
        "generation_error": script.generation_error,
        "runnable": script.framework in compiler.RUNNABLE_FRAMEWORKS,
        "created_by": script.created_by,
        "created_at": script.created_at.isoformat() if script.created_at else None,
        "updated_at": script.updated_at.isoformat() if script.updated_at else None,
    }


@router.get("/frameworks")
def list_frameworks(current_user: dict = Depends(require_permission(PERM_VIEW))):
    """Which frameworks can be generated, and which can actually be executed.

    Stated rather than discovered on a disabled button: no runner exists for
    Katalon or Appium here or upstream.
    """
    return {
        "frameworks": [
            {
                "name": name,
                "label": compiler.FRAMEWORK_LABELS[name],
                "runnable": name in compiler.RUNNABLE_FRAMEWORKS,
            }
            for name in compiler.FRAMEWORKS
        ],
        "runnable": list(compiler.RUNNABLE_FRAMEWORKS),
    }


@router.get("/scripts/approved-cases")
def list_approved_automation_cases(
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    """The Lab's working set: approved cases classified as Automation.

    Anything still in draft, rejected, or classified Manual is deliberately
    absent -- generating from an unapproved case produces a script nobody has
    agreed should exist.
    """
    cases = (
        db.query(AutomationTestCase)
        .filter(
            AutomationTestCase.approval_status == wb.APPROVAL_APPROVED,
            AutomationTestCase.classification != wb.CLASSIFICATION_MANUAL,
        )
        .order_by(AutomationTestCase.display_id)
        .all()
    )

    scripts = db.query(AutomationScript).filter(AutomationScript.is_current.is_(True)).all()
    by_case: dict[int, list[dict]] = {}
    for script in scripts:
        by_case.setdefault(script.test_case_id, []).append(_script_detail(script))

    counts: dict[str, int] = {name: 0 for name in compiler.FRAMEWORKS}
    for script in scripts:
        if script.framework in counts:
            counts[script.framework] += 1

    return {
        "counts": {"approved_cases": len(cases), "by_framework": counts},
        "cases": [
            {
                "id": case.id,
                "tc_display_id": case.display_id,
                "title": case.objective or case.description or case.display_id,
                "priority": case.priority,
                "steps": len(case.steps_structured or []),
                "test_data_status": case.test_data_status,
                "application_url": case.application_url,
                "scripts": by_case.get(case.id, []),
            }
            for case in cases
        ],
    }


@router.post("/scripts/generate", status_code=201)
def generate_scripts(
    body: GenerateScriptsRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Compile scripts for the selected cases.

    Synchronous, unlike refinement: compilation is deterministic template
    rendering with no network call, so a batch finishes in milliseconds and a
    job to poll would be ceremony around nothing.
    """
    if body.framework not in compiler.FRAMEWORKS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown framework. Expected one of: {', '.join(compiler.FRAMEWORKS)}",
        )

    username = (current_user or {}).get("username")
    cases = (
        db.query(AutomationTestCase)
        .filter(AutomationTestCase.id.in_(body.case_ids))
        .all()
    )

    # Fetched once per batch, not per case: it is the same catalogue for every
    # case here, and a crawl's worth of rows is not something to re-query N
    # times over one request. [] when nothing has been discovered -- compile_for
    # then falls back to the phrase heuristic exactly as it did before grounding
    # existed, so a deployment that has never run Discovery is unaffected.
    catalog = _current_catalog(db, _resolve_application(db, body.application_id).id)

    produced, skipped = [], []
    for case in cases:
        if case.approval_status != wb.APPROVAL_APPROVED:
            skipped.append({"display_id": case.display_id, "reason": "Not approved."})
            continue

        # Ensure steps_structured is in sync with steps_raw
        if case.steps_raw:
            raw_list = split_steps(case.steps_raw)
            if raw_list and (not case.steps_structured or len(case.steps_structured) != len(raw_list)):
                case.steps_structured = [
                    {
                        "step_number": i,
                        "action": s.strip(),
                        "target": s.strip(),
                        "test_data_ref": None,
                        "expected_result": None,
                    }
                    for i, s in enumerate(raw_list, start=1)
                ]
                db.commit()

        script_key = f"{case.id}:{body.framework}"
        existing = (
            db.query(AutomationScript)
            .filter(
                AutomationScript.script_key == script_key,
                AutomationScript.is_current.is_(True),
            )
            .first()
        )
        if existing and not body.regenerate:
            skipped.append(
                {"display_id": case.display_id, "reason": "A current script already exists."}
            )
            continue
        if existing and existing.edited_by_user and body.regenerate:
            skipped.append(
                {
                    "display_id": case.display_id,
                    "reason": (
                        "The current script has hand-written edits. Delete it first if you "
                        "really want to discard them."
                    ),
                }
            )
            continue

        try:
            compiled = compiler.compile_for(
                case,
                body.framework,
                base_url=body.base_url or case.application_url,
                catalog=catalog,
            )
        except ValueError as exc:
            skipped.append({"display_id": case.display_id, "reason": str(exc)})
            continue

        if existing:
            # Superseded, not deleted: a previous dry run's evidence still
            # refers to the code that produced it.
            existing.is_current = False

        script = AutomationScript(
            test_case_id=case.id,
            script_key=script_key,
            framework=compiled.framework,
            language=compiled.language,
            file_name=compiled.file_name,
            code=compiled.code,
            entry_path=compiled.entry_path,
            execution_command=compiled.execution_command,
            setup_notes=compiled.setup_notes,
            generation_mode=compiled.generation_mode,
            static_gate_result=compiled.gate_result(),
            version=(existing.version + 1) if existing else 1,
            parent_script_id=existing.id if existing else None,
            is_current=True,
            edited_by_user=False,
            status="draft",
            created_by=username,
        )
        db.add(script)
        produced.append(script)

    db.commit()
    for script in produced:
        db.refresh(script)

    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action="generate",
        resource_type="automation_script",
        resource_id=",".join(str(s.id) for s in produced) or "none",
        resource_name=f"{len(produced)} {body.framework} script(s)",
        status="success",
        details={
            "description": f"{username} generated {len(produced)} {body.framework} script(s)",
            "skipped": len(skipped),
        },
    )

    return {
        "generated": len(produced),
        "skipped": skipped,
        "scripts": [_script_detail(s) for s in produced],
    }


@router.get("/scripts")
def list_scripts(
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
    framework: Optional[str] = Query(default=None),
    current_only: bool = Query(default=True),
):
    query = db.query(AutomationScript)
    if current_only:
        query = query.filter(AutomationScript.is_current.is_(True))
    if framework:
        query = query.filter(AutomationScript.framework == framework)
    scripts = query.order_by(AutomationScript.created_at.desc()).all()
    return {"scripts": [_script_detail(s) for s in scripts]}


def _load_script(db: Session, script_id: int) -> AutomationScript:
    script = db.query(AutomationScript).filter(AutomationScript.id == script_id).first()
    if not script:
        raise HTTPException(status_code=404, detail="Script not found")
    return script


@router.get("/scripts/{script_id}")
def get_script(
    script_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    return _script_detail(_load_script(db, script_id))


@router.patch("/scripts/{script_id}")
def edit_script(
    script_id: int,
    body: EditScriptRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Hand-edit a script, then re-run the static gate over what was typed."""
    script = _load_script(db, script_id)
    script.code = body.code
    # Flagged so regeneration warns before discarding the edit.
    script.edited_by_user = True
    script.static_gate_result = {
        **compiler.CompiledScript(
            framework=script.framework,
            language=script.language,
            file_name=script.file_name,
            code=body.code,
            entry_path=script.entry_path or script.file_name,
            execution_command=script.execution_command or "",
            issues=compiler.run_static_gate(body.code, 1, 0),
        ).gate_result(),
    }
    db.commit()
    db.refresh(script)
    return _script_detail(script)


@router.post("/scripts/{script_id}/decide")
def decide_script(
    script_id: int,
    body: ScriptDecisionRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    script = _load_script(db, script_id)
    gate = script.static_gate_result or {}
    if body.decision == "approve" and gate.get("passed") is False:
        raise HTTPException(
            status_code=409,
            detail=(
                "The static gate failed on this script: "
                + "; ".join(gate.get("errors") or ["unknown reason"])
                + ". Fix it before approving."
            ),
        )
    script.status = "approved" if body.decision == "approve" else "rejected"
    db.commit()
    db.refresh(script)
    return _script_detail(script)


@router.post("/scripts/dry-run", status_code=202)
def dry_run_scripts(
    body: DryRunRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Execute the selected scripts once, through the ordinary run pipeline.

    Each script becomes an AutomationRun, so its evidence, log and cancellation
    behave exactly like anything on the Runs tab, and dry_run_key is the join
    back. Refusals happen before anything is queued.
    """
    if not settings.AUTOMATION_ENABLED:
        raise HTTPException(
            status_code=503,
            detail="The Automation Module is disabled on this deployment (AUTOMATION_ENABLED=false).",
        )
    if not is_ready():
        detail = "; ".join(
            f"{name}: {support.detail}"
            for name, support in runtime_status().items()
            if not support.available
        )
        raise HTTPException(status_code=503, detail=f"The browser runtime is not available. {detail}")

    username = (current_user or {}).get("username")
    queued, refused = [], []

    for script_id in body.script_ids:
        script = db.query(AutomationScript).filter(AutomationScript.id == script_id).first()
        if not script:
            refused.append({"script_id": script_id, "reason": "Script not found."})
            continue
        if script.framework not in compiler.RUNNABLE_FRAMEWORKS:
            refused.append(
                {
                    "script_id": script_id,
                    "reason": (
                        f"{compiler.FRAMEWORK_LABELS.get(script.framework, script.framework)} is "
                        "generate-only — no runner exists for it."
                    ),
                }
            )
            continue
        gate = script.static_gate_result or {}
        if gate.get("passed") is False:
            refused.append(
                {
                    "script_id": script_id,
                    "reason": "Static gate failed: " + "; ".join(gate.get("errors") or []),
                }
            )
            continue

        permitted, reason = job_manager.capacity()
        if not permitted:
            refused.append({"script_id": script_id, "reason": reason})
            continue

        run_key = new_run_key()
        slow_mo = (
            body.slow_mo_ms
            if body.slow_mo_ms is not None
            else getattr(settings, "AUTOMATION_DEFAULT_SLOW_MO_MS", 1000)
        )
        is_headless = body.headless if body.headless is not None else True

        run = AutomationRun(
            run_key=run_key,
            test_case_id=script.test_case_id,
            script_id=script.id,
            framework=script.framework,
            environment=body.environment,
            status="queued",
            run_config={
                "headless": is_headless,
                "slow_mo_ms": slow_mo,
                "mode": "dry_run",
            },
            run_metadata={
                "code": script.code,
                "base_url": body.base_url,
                "file_name": script.file_name,
            },
            triggered_by=username,
        )
        db.add(run)

        script.dry_run_status = "queued"
        script.dry_run_key = run_key
        script.dry_run_at = datetime.utcnow()
        db.commit()
        db.refresh(run)

        job_manager.submit(run_key)
        queued.append({"script_id": script.id, "run_key": run_key})

    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action="execute",
        resource_type="automation_script",
        resource_id=",".join(str(q["script_id"]) for q in queued) or "none",
        resource_name=f"dry run of {len(queued)} script(s)",
        status="success",
        details={"description": f"{username} dry-ran {len(queued)} script(s)"},
    )

    if not queued and refused:
        raise HTTPException(status_code=409, detail=refused[0]["reason"])
    return {"queued": queued, "refused": refused}


@router.get("/scripts/{script_id}/dry-run")
def get_dry_run(
    script_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    """The dry run's current state, folded back onto the script.

    Read through the run rather than cached on the script, so the two can never
    disagree about what happened.
    """
    script = _load_script(db, script_id)
    if not script.dry_run_key:
        return {"script_id": script.id, "dry_run_status": "not_run", "run": None}

    run = db.query(AutomationRun).filter(AutomationRun.run_key == script.dry_run_key).first()
    if not run:
        return {"script_id": script.id, "dry_run_status": script.dry_run_status, "run": None}

    mapped = {
        "queued": "queued",
        "running": "running",
        "completed": "passed" if run.outcome == "passed" else "failed",
        "failed": "blocked" if run.outcome == "blocked" else "failed",
        "cancelled": "not_run",
    }.get(run.status, "not_run")

    if script.dry_run_status != mapped:
        script.dry_run_status = mapped
        script.dry_run_summary = {
            "outcome": run.outcome,
            "total": run.total_tests,
            "passed": run.passed,
            "failed": run.failed,
            "duration_seconds": run.duration_seconds,
            "error_message": run.error_message,
        }
        db.commit()

    return {
        "script_id": script.id,
        "dry_run_status": mapped,
        "run": _run_summary(run),
        "summary": script.dry_run_summary,
    }


@router.post("/scripts/delete")
def delete_scripts(
    body: BulkIdsRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Delete scripts. Runs are left alone -- their evidence is still a record."""
    username = (current_user or {}).get("username")
    scripts = (
        db.query(AutomationScript).filter(AutomationScript.id.in_(body.case_ids)).all()
    )
    for script in scripts:
        db.delete(script)
    db.commit()

    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action="delete",
        resource_type="automation_script",
        resource_id=",".join(str(i) for i in body.case_ids),
        resource_name=f"{len(scripts)} script(s)",
        status="success",
        details={"description": f"{username} deleted {len(scripts)} script(s)"},
    )
    return {"deleted": len(scripts)}


@router.get("/scripts/{script_id}/download")
def download_script(
    script_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    script = _load_script(db, script_id)
    return Response(
        content=script.code or "",
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{script.file_name}"'},
    )


@router.get("/scripts/download/bundle")
def download_script_bundle(
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
    framework: Optional[str] = Query(default=None),
):
    """Every current script as one zip, foldered by framework.

    Built in memory: these are text files of a few kilobytes each, so writing
    them to disk to serve them would add a temp file and a cleanup path for no
    benefit.
    """
    query = db.query(AutomationScript).filter(AutomationScript.is_current.is_(True))
    if framework:
        query = query.filter(AutomationScript.framework == framework)
    scripts = query.all()

    if not scripts:
        raise HTTPException(status_code=404, detail="There are no scripts to download yet.")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for script in scripts:
            case = script.test_case
            folder = script.framework
            name = script.file_name or f"script-{script.id}.txt"
            archive.writestr(f"{folder}/{name}", script.code or "")
            if script.setup_notes:
                archive.writestr(
                    f"{folder}/{name}.README.txt",
                    "\n".join(
                        [f"Test case: {case.display_id if case else script.test_case_id}", ""]
                        + list(script.setup_notes)
                    ),
                )

    buffer.seek(0)
    filename = f"automation-scripts{'-' + framework if framework else ''}.zip"
    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Applications: the registry everything else hangs off ─────────────────────
#
# `automation_applications` existed from the start and nothing ever wrote to
# it. Discovery kept one global `is_current` crawl instead, so a second
# application's crawl retired the first one's catalogue and every test case
# grounded against it silently began reporting against the wrong elements.
# The Knowledge Base meanwhile identified applications by folder name with no
# link back here, which made "an application" two unrelated things.
#
# One row is now the identity. `app_key` names the Knowledge Base folder
# holding the declarative profile and flows; the row itself holds the runtime
# target. Discovery, its element catalogue and grounding are all scoped by
# application_id from here down.


APP_KEY_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,99}$"


class ApplicationRequest(BaseModel):
    """A target application to register."""

    name: str = Field(min_length=1, max_length=255)
    # Slug-shaped because it is a directory name in the Knowledge Base.
    app_key: str = Field(min_length=1, max_length=100, pattern=APP_KEY_PATTERN)
    base_url: str = Field(min_length=1, max_length=2000)
    environment: str = Field(default="SIT", max_length=50)
    description: Optional[str] = Field(default=None, max_length=2000)
    is_active: bool = True


class ApplicationUpdate(BaseModel):
    """A partial edit. `app_key` is deliberately absent.

    Repointing a registered application at a different Knowledge Base folder
    would silently re-ground every test case behind it against a different
    profile. Register a second application instead.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    base_url: Optional[str] = Field(default=None, min_length=1, max_length=2000)
    environment: Optional[str] = Field(default=None, max_length=50)
    description: Optional[str] = Field(default=None, max_length=2000)
    is_active: Optional[bool] = None


def _application_detail(db: Session, app: AutomationApplication) -> dict:
    """One application with the two things the screen needs beside it.

    The Knowledge Base link and the discovery state are folded in here rather
    than fetched separately, because "is this application actually usable" is
    the question the picker has to answer, and it is those two facts.
    """
    profile = None
    flows: list = []
    try:
        profile = kb.load_app_profile(app.app_key)
        if profile:
            flows = kb.list_flows(app.app_key)
    except Exception as exc:  # a broken profile must not hide the application
        logger.warning("Knowledge Base lookup failed for %s: %s", app.app_key, exc)

    run = _current_discovery(db, app.id)
    discovery_summary = None
    if run:
        count = (
            db.query(AutomationDiscoveredElement)
            .filter(AutomationDiscoveredElement.discovery_run_id == run.id)
            .count()
        )
        discovery_summary = {
            "id": run.id,
            "status": run.status,
            "version": run.version,
            "elements_discovered": count,
            "pages_discovered": run.pages_discovered,
            "updated_at": run.updated_at.isoformat() if run.updated_at else None,
        }

    return {
        "id": app.id,
        "name": app.name,
        "app_key": app.app_key,
        "base_url": app.base_url,
        "environment": app.environment,
        "description": app.description,
        "is_active": bool(app.is_active),
        "auth_mode": app.auth_mode,
        # Whether a password is stored, never the password itself.
        "has_credentials": bool(app.auth_secret_encrypted),
        "knowledge_base": {
            "linked": profile is not None,
            "app_name": (profile or {}).get("app_name"),
            "domain": (profile or {}).get("domain"),
            "flows": len(flows),
        },
        "discovery": discovery_summary,
        "created_by": app.created_by,
        "created_at": app.created_at.isoformat() if app.created_at else None,
        "updated_at": app.updated_at.isoformat() if app.updated_at else None,
    }


def _application_or_404(db: Session, application_id: int) -> AutomationApplication:
    app = (
        db.query(AutomationApplication)
        .filter(AutomationApplication.id == application_id)
        .first()
    )
    if not app:
        raise HTTPException(status_code=404, detail="That application is not registered.")
    return app


def _resolve_application(
    db: Session, application_id: Optional[int]
) -> AutomationApplication:
    """The application a request means, or a 409 that says what to do about it.

    An explicit id always wins. Without one, a deployment with a single
    registered application has an unambiguous answer and gets it -- which is
    what keeps existing single-application callers working. With several, there
    is no defensible default: picking one would ground test cases against an
    application nobody named.
    """
    if application_id is not None:
        return _application_or_404(db, application_id)

    active = (
        db.query(AutomationApplication)
        .filter(AutomationApplication.is_active.is_(True))
        .order_by(AutomationApplication.id)
        .all()
    )
    if len(active) == 1:
        return active[0]
    if not active:
        raise HTTPException(
            status_code=409,
            detail=(
                "No application is registered yet. Add one on the Application "
                "Discovery screen before crawling or grounding."
            ),
        )
    raise HTTPException(
        status_code=409,
        detail=(
            f"{len(active)} applications are registered. Say which one this is for "
            f"by passing application_id."
        ),
    )


@router.get("/applications")
def list_registered_applications(
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
    include_inactive: bool = Query(default=False),
):
    """Every registered application, with its Knowledge Base and crawl state."""
    query = db.query(AutomationApplication)
    if not include_inactive:
        query = query.filter(AutomationApplication.is_active.is_(True))
    apps = query.order_by(AutomationApplication.name).all()
    return {
        "applications": [_application_detail(db, app) for app in apps],
        "total": len(apps),
    }


@router.get("/applications/{application_id}")
def get_application(
    application_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    return _application_detail(db, _application_or_404(db, application_id))


@router.post("/applications", status_code=201)
def create_application(
    body: ApplicationRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Register an application.

    A Knowledge Base folder is not required up front -- an application can be
    crawled before anyone writes its flow blueprints, and the response says
    whether the folder resolved so the screen can show it.
    """
    existing = (
        db.query(AutomationApplication)
        .filter(AutomationApplication.app_key == body.app_key)
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"An application with the key '{body.app_key}' is already registered.",
        )

    username = (current_user or {}).get("username")
    app = AutomationApplication(
        name=body.name.strip(),
        app_key=body.app_key.strip(),
        base_url=body.base_url.strip(),
        environment=(body.environment or "SIT").strip(),
        description=(body.description or None),
        is_active=body.is_active,
        created_by=username,
    )
    db.add(app)
    db.commit()
    db.refresh(app)

    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action="create",
        resource_type="automation_application",
        resource_id=str(app.id),
        resource_name=app.name,
        status="success",
        details={"description": f"{username} registered application {app.name}"},
    )
    return _application_detail(db, app)


@router.patch("/applications/{application_id}")
def update_application(
    application_id: int,
    body: ApplicationUpdate,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    app = _application_or_404(db, application_id)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(app, field, value.strip() if isinstance(value, str) else value)
    db.commit()
    db.refresh(app)
    return _application_detail(db, app)


@router.delete("/applications/{application_id}")
def delete_application(
    application_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Remove an application that has no crawl history.

    An application with crawls behind it is deactivated instead of deleted:
    test cases grounded against those runs still point at them, and deleting
    the runs to make room for the delete would quietly discard that evidence.
    """
    app = _application_or_404(db, application_id)
    runs = (
        db.query(AutomationDiscoveryRun)
        .filter(AutomationDiscoveryRun.application_id == app.id)
        .count()
    )
    if runs:
        raise HTTPException(
            status_code=409,
            detail=(
                f"{app.name} has {runs} discovery run(s) behind it. Deactivate it "
                f"instead, or delete its discovery data first."
            ),
        )

    username = (current_user or {}).get("username")
    name = app.name
    db.delete(app)
    db.commit()

    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action="delete",
        resource_type="automation_application",
        resource_id=str(application_id),
        resource_name=name,
        status="success",
        details={"description": f"{username} removed application {name}"},
    )
    return {"deleted": True, "id": application_id}


class KnowledgeBaseDraftRequest(BaseModel):
    """Turn this application's current crawl into Knowledge Base files.

    `overwrite_profile` is off by default and has to be asked for: an existing
    app_profile.json is what every model, prompt and grounding rule compiles
    from, and a crawl is not entitled to replace curated ground truth.
    """

    overwrite_profile: bool = False
    # Classify the crawl into the keys the model compiler reads -- url_templates,
    # endpoints, named selector groups, grounding rules -- instead of leaving
    # them for a person to type. Every proposal is checked back against the
    # crawl before it is written, and a model that cannot be reached simply
    # yields the plain structural draft.
    synthesise: bool = True


@router.post("/applications/{application_id}/knowledge-base/draft")
def draft_knowledge_base_from_crawl(
    application_id: int,
    body: KnowledgeBaseDraftRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Write a Knowledge Base draft from the application's current crawl.

    The seam between the two halves of this screen. Discovery fills a database
    with elements; the Knowledge Base is files somebody typed; until now
    nothing carried anything from one to the other, so a crawl that catalogued
    hundreds of controls moved a single counter and left the three beside it --
    compiled from the files -- untouched.

    One direction only. A crawl proposes, a person disposes: what comes out is
    stamped as a draft, says what it could not work out, and lands under names
    that cannot collide with hand-authored blueprints.
    """
    app = _application_or_404(db, application_id)
    run = _current_discovery(db, app.id)
    if not run:
        raise HTTPException(
            status_code=409,
            detail=(
                f"{app.name} has not been crawled yet, so there is nothing to draft "
                f"from. Run discovery against it first."
            ),
        )
    run = _absorb_discovery_result(db, run)
    if run.status != "completed":
        raise HTTPException(
            status_code=409,
            detail=f"The current crawl of {app.name} is {run.status}. Wait for it to finish.",
        )

    elements = [
        # _element_detail already carries element_name, which is the handle the
        # draft keys its selector groups on.
        _element_detail(row)
        for row in db.query(AutomationDiscoveredElement)
        .filter(AutomationDiscoveredElement.discovery_run_id == run.id)
        .all()
    ]

    try:
        result = kb.write_draft_from_crawl(
            app_key=app.app_key,
            app_name=app.name,
            base_url=run.application_url or app.base_url or "",
            pages=run.explored_pages or [],
            elements=elements,
            blockers=run.blockers or [],
            crawl_version=run.version,
            overwrite_profile=body.overwrite_profile,
            synthesise=body.synthesise,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    username = (current_user or {}).get("username")
    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action="update",
        resource_type="automation_knowledge_base",
        resource_id=app.app_key,
        resource_name=app.name,
        status="success",
        details={
            "description": (
                f"{username} drafted Knowledge Base files for {app.name} from crawl "
                f"v{run.version}"
            ),
            "written": result["written"],
            "skipped": [entry["path"] for entry in result["skipped"]],
        },
    )
    return {**result, "crawl_version": run.version, "application_id": app.id}



# ── Application Discovery and Grounding ──────────────────────────────────────
#
# Discovery crawls the running application and catalogues what it renders.
# Grounding matches refined test case steps against that catalogue and names
# the ones that do not resolve.
#
# The crawl executes through the ordinary runner, so it has a run_key, a log
# and cancellation for free. Its catalogue is folded in lazily when the run
# finishes, the same way a dry run's result is -- one place decides what
# happened, and the stored state can never disagree with the run.


class DiscoveryRequest(BaseModel):
    """What to crawl.

    Only the application is really required: its registered base URL and
    environment are what a crawl should use by default, and re-typing them per
    crawl is how the two drift apart. Both stay overridable for the case of
    crawling one application in a second environment.
    """

    application_id: Optional[int] = None
    application_url: Optional[str] = Field(default=None, max_length=2000)
    application_environment: Optional[str] = Field(default=None, max_length=50)
    max_pages: int = Field(default=discovery.DEFAULT_MAX_PAGES, ge=1, le=40)


class GroundRequest(BaseModel):
    """Which cases to ground, against which application's catalogue.

    Empty `case_ids` means every refined case.
    """

    case_ids: list[int] = Field(default_factory=list)
    application_id: Optional[int] = None


def _discovery_detail(run: AutomationDiscoveryRun, element_count: Optional[int] = None) -> dict:
    return {
        "id": run.id,
        "application_id": run.application_id,
        "version": run.version,
        "is_current": bool(run.is_current),
        "status": run.status,
        "application_url": run.application_url,
        "application_environment": run.application_environment,
        "auth_mode": run.auth_mode,
        "auth_status": run.auth_status,
        "auth_detail": run.auth_detail,
        "pages_discovered": run.pages_discovered,
        "elements_discovered": element_count
        if element_count is not None
        else run.elements_discovered,
        "explored_pages": run.explored_pages or [],
        "blockers": run.blockers or [],
        "error": run.error,
        "run_key": run.run_key,
        "created_by": run.created_by,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "updated_at": run.updated_at.isoformat() if run.updated_at else None,
    }


def _element_detail(element: AutomationDiscoveredElement) -> dict:
    return {
        "id": element.id,
        "page_url": element.page_url,
        "page_title": element.page_title,
        "element_name": element.element_name,
        "role": element.role,
        "accessible_name": element.accessible_name,
        "business_meaning": element.business_meaning,
        "recommended_locator": element.recommended_locator,
        "recommended_strategy": element.recommended_strategy,
        "confidence_score": element.confidence_score,
        "href": element.href,
    }


def _current_discovery(
    db: Session, application_id: Optional[int] = None
) -> Optional[AutomationDiscoveryRun]:
    """This application's current catalogue.

    `is_current` is per application, not per deployment. Without the filter,
    crawling application B returned B's catalogue to every question asked about
    A -- and because both are real catalogues of real elements, the wrong
    answers looked exactly like right ones.

    Runs predating scoping carry application_id NULL and match no application,
    so they read as "never crawled" until add_automation_application_scope.py
    adopts them. That is deliberate: reporting an unattributed catalogue under
    some application's name is the failure this filter exists to prevent.
    """
    query = db.query(AutomationDiscoveryRun).filter(
        AutomationDiscoveryRun.is_current.is_(True)
    )
    query = query.filter(AutomationDiscoveryRun.application_id == application_id)
    return query.order_by(AutomationDiscoveryRun.id.desc()).first()


def _current_catalog(db: Session, application_id: Optional[int] = None) -> list[dict]:
    """The current discovery run's elements, in grounding's shape, or [].

    Shared by /workbench/ground and /scripts/generate so a script and its
    case's grounding badge are judged against the identical catalogue -- two
    separate lookups here previously risked disagreeing if a crawl finished
    between them.
    """
    run = _current_discovery(db, application_id)
    if not run:
        return []
    run = _absorb_discovery_result(db, run)
    if run.status != "completed":
        return []
    elements = (
        db.query(AutomationDiscoveredElement)
        .filter(AutomationDiscoveredElement.discovery_run_id == run.id)
        .all()
    )
    return discovery.catalog_from_elements(elements)


def _absorb_discovery_result(db: Session, run: AutomationDiscoveryRun) -> AutomationDiscoveryRun:
    """Fold a finished crawl's catalogue into the database, once.

    Read from the workspace rather than kept in memory: the crawl is a
    subprocess, and its output file is the only thing that survives it.
    """
    if run.status in ("completed", "failed") or not run.run_key:
        return run

    execution = db.query(AutomationRun).filter(AutomationRun.run_key == run.run_key).first()
    if not execution:
        return run

    if execution.status in ("queued", "running"):
        run.status = "running"
        db.commit()
        return run

    if execution.status == "cancelled":
        run.status = "failed"
        run.error = "The crawl was cancelled."
        db.commit()
        return run

    output_path = None
    candidates = []
    if execution.workspace_path:
        candidates.append(Path(execution.workspace_path) / discovery.DISCOVERY_OUTPUT_FILE)
    if execution.run_key:
        candidates.append(ws.workspace_dir_for_run(execution.run_key) / discovery.DISCOVERY_OUTPUT_FILE)

    for candidate in candidates:
        if candidate.exists():
            output_path = candidate
            break

    if output_path is None:
        run.status = "failed"
        run.error = (
            execution.error_message
            or "The crawl produced no catalogue. Its log explains what stopped it."
        )
        db.commit()
        return run

    try:
        parsed = discovery.parse_discovery_output(
            output_path.read_text(encoding="utf-8", errors="replace")
        )
    except ValueError as exc:
        run.status = "failed"
        run.error = str(exc)
        db.commit()
        return run

    for element in parsed["elements"]:
        db.add(AutomationDiscoveredElement(discovery_run_id=run.id, **element))

    run.status = "completed"
    run.pages_discovered = len(parsed["pages"])
    run.elements_discovered = len(parsed["elements"])
    run.explored_pages = parsed["pages"]
    run.blockers = parsed["blockers"]
    run.error = None
    db.commit()
    db.refresh(run)
    return run


@router.post("/discovery/run", status_code=202)
def start_discovery(
    body: DiscoveryRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Crawl the application. Returns 202; poll GET /discovery.

    Refuses before queueing for the same reason a run does: an unavailable
    browser runtime should be explained now, not discovered as a failed crawl
    a minute later.
    """
    if not settings.AUTOMATION_ENABLED:
        raise HTTPException(
            status_code=503,
            detail="The Automation Module is disabled on this deployment (AUTOMATION_ENABLED=false).",
        )
    if not is_ready():
        detail = "; ".join(
            f"{name}: {support.detail}"
            for name, support in runtime_status().items()
            if not support.available
        )
        raise HTTPException(status_code=503, detail=f"The browser runtime is not available. {detail}")

    permitted, reason = job_manager.capacity()
    if not permitted:
        raise HTTPException(status_code=429, detail=reason)

    username = (current_user or {}).get("username")
    application = _resolve_application(db, body.application_id)

    # The registered application supplies both unless this crawl overrides
    # them, so the common case is "pick the application, press Crawl".
    target_url = (body.application_url or application.base_url or "").strip()
    if not target_url:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{application.name} has no base URL registered and none was given. "
                f"Set one on the application before crawling."
            ),
        )
    environment = (body.application_environment or application.environment or "").strip() or None

    # Versioned, not overwritten: a case grounded against the previous
    # catalogue keeps pointing at the run it was actually matched against.
    # Both the numbering and the retirement are scoped to this application --
    # crawling one must leave every other application's catalogue current.
    previous = _current_discovery(db, application.id)
    next_version = (previous.version + 1) if previous else 1
    if previous:
        previous.is_current = False

    run = AutomationDiscoveryRun(
        application_id=application.id,
        version=next_version,
        is_current=True,
        status="queued",
        application_url=target_url,
        application_environment=environment,
        auth_mode="none",
        auth_status="not_required",
        auth_detail=(
            "Crawled as an anonymous visitor. Authenticated discovery needs credential "
            "storage, which this deployment does not carry yet."
        ),
        created_by=username,
    )
    db.add(run)
    db.commit()
    db.refresh(run)

    run_key = new_run_key()
    execution = AutomationRun(
        run_key=run_key,
        framework="playwright",
        environment=environment,
        status="queued",
        run_config={"headless": True, "slow_mo_ms": 1000, "mode": "discovery"},
        run_metadata={
            "code": discovery.build_discovery_spec(
                target_url,
                max_pages=body.max_pages,
                # Derived from max_pages and capped below the runner's own
                # subprocess timeout, so asking for more pages actually buys
                # time for them instead of timing out partway through.
                budget_ms=discovery.crawl_budget_ms(
                    body.max_pages,
                    run_timeout_seconds=int(settings.AUTOMATION_RUN_TIMEOUT_SECONDS or 600),
                ),
            ),
            "base_url": target_url,
            "file_name": "discovery.spec.ts",
        },
        triggered_by=username,
    )
    db.add(execution)
    run.run_key = run_key
    run.status = "running"
    db.commit()

    job_manager.submit(run_key)

    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action="discover",
        resource_type="automation_discovery_run",
        resource_id=str(run.id),
        resource_name=target_url,
        status="success",
        details={
            "description": (
                f"{username} started discovery of {application.name} at {target_url}"
            ),
            "application_id": application.id,
            "application": application.name,
            "version": next_version,
        },
    )

    db.refresh(run)
    return _discovery_detail(run, element_count=0)


@router.get("/discovery")
def get_discovery(
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
    application_id: Optional[int] = Query(default=None),
):
    """One application's catalogue state. Absorbs a finished crawl on the way."""
    application = _resolve_application(db, application_id)
    run = _current_discovery(db, application.id)
    if not run:
        return {"discovery": None, "elements": 0, "application_id": application.id}

    run = _absorb_discovery_result(db, run)
    count = (
        db.query(AutomationDiscoveredElement)
        .filter(AutomationDiscoveredElement.discovery_run_id == run.id)
        .count()
    )
    return {
        "discovery": _discovery_detail(run, element_count=count),
        "elements": count,
        "application_id": application.id,
    }


@router.get("/discovery/elements")
def list_discovered_elements(
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
    search: Optional[str] = Query(default=None, max_length=200),
    role: Optional[str] = Query(default=None, max_length=50),
    application_id: Optional[int] = Query(default=None),
):
    application = _resolve_application(db, application_id)
    run = _current_discovery(db, application.id)
    if not run:
        return {"elements": [], "total": 0, "roles": []}

    query = db.query(AutomationDiscoveredElement).filter(
        AutomationDiscoveredElement.discovery_run_id == run.id
    )
    if role:
        query = query.filter(AutomationDiscoveredElement.role == role)
    elements = query.order_by(AutomationDiscoveredElement.element_name).all()

    if search:
        needle = search.lower()
        elements = [
            e
            for e in elements
            if needle in (e.accessible_name or "").lower()
            or needle in (e.element_name or "").lower()
        ]

    return {
        "elements": [_element_detail(e) for e in elements],
        "total": len(elements),
        "roles": sorted({e.role for e in elements if e.role}),
    }


@router.delete("/discovery")
def delete_discovery(
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
    application_id: Optional[int] = Query(default=None),
):
    """Discard one application's catalogue and reset the cases it grounded.

    Leaving a grounding verdict behind after deleting what produced it would
    leave the grid asserting something nothing backs.

    Scoped to the application: this used to delete every run in the deployment
    and reset every grounded case, so clearing a stale crawl of one application
    also threw away another application's working catalogue.
    """
    application = _resolve_application(db, application_id)
    runs = (
        db.query(AutomationDiscoveryRun)
        .filter(AutomationDiscoveryRun.application_id == application.id)
        .all()
    )
    run_ids = [run.id for run in runs]
    elements = (
        db.query(AutomationDiscoveredElement)
        .filter(AutomationDiscoveredElement.discovery_run_id.in_(run_ids))
        .count()
        if run_ids
        else 0
    )

    reset = (
        db.query(AutomationTestCase)
        .filter(AutomationTestCase.grounding_status != grounding.STATUS_NOT_CHECKED)
        .filter(AutomationTestCase.discovery_run_id.in_(run_ids))
        .all()
        if run_ids
        else []
    )
    for case in reset:
        case.grounding_status = grounding.STATUS_NOT_CHECKED
        case.grounding_summary = None
        case.grounded_at = None
        case.discovery_run_id = None

    for run in runs:
        db.delete(run)
    db.commit()

    return {
        "application_id": application.id,
        "discovery_runs_removed": len(runs),
        "elements_removed": elements,
        "test_cases_reset": len(reset),
    }


@router.post("/workbench/ground")
def ground_cases(
    body: GroundRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Match test case steps against one application's current catalogue.

    Deterministic and instant -- no browser, no model call -- so it runs inline
    rather than as a job.
    """
    application = _resolve_application(db, body.application_id)
    run = _current_discovery(db, application.id)
    if not run:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Nothing has been discovered for {application.name} yet. Run "
                f"discovery against it first."
            ),
        )
    run = _absorb_discovery_result(db, run)
    if run.status != "completed":
        raise HTTPException(
            status_code=409,
            detail=f"The current discovery run is {run.status}. Wait for it to finish.",
        )

    catalog = _current_catalog(db, application.id)

    query = db.query(AutomationTestCase).filter(AutomationTestCase.source == "refined")
    if body.case_ids:
        query = query.filter(AutomationTestCase.id.in_(body.case_ids))
    cases = query.all()

    tallies = {
        grounding.STATUS_GROUNDED: 0,
        grounding.STATUS_PARTIAL: 0,
        grounding.STATUS_UNGROUNDED: 0,
    }
    for case in cases:
        summary = grounding.ground_test_case(case.steps_structured or [], catalog)
        case.grounding_status = summary["status"]
        case.grounding_summary = summary
        case.grounded_at = datetime.utcnow()
        case.discovery_run_id = run.id
        tallies[summary["status"]] = tallies.get(summary["status"], 0) + 1

    db.commit()

    return {
        "grounded_against": _discovery_detail(run, element_count=len(catalog)),
        "checked": len(cases),
        "counts": tallies,
        "test_cases": [_workbench_case(case) for case in cases],
    }


# ── Document intake ──────────────────────────────────────────────────────────
#
# The second way test cases reach the Workbench. See services/automation/
# intake.py for what this does and, more importantly, what it deliberately does
# not do yet -- BRD prose does not become test cases here.
#
# Reads need automation.view; anything that writes a file or creates candidates
# needs automation.execute, matching /candidates/import.


class IntakeBatchCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class IntakeDocumentRole(BaseModel):
    role: str = Field(pattern="^(brd|srd|test_cases)$")


def _batch_or_404(db: Session, batch_id: int) -> AutomationIntakeBatch:
    batch = db.query(AutomationIntakeBatch).filter(AutomationIntakeBatch.id == batch_id).first()
    if not batch:
        raise HTTPException(status_code=404, detail="That intake batch no longer exists.")
    return batch


def _document_or_404(db: Session, document_id: int) -> AutomationIntakeDocument:
    document = (
        db.query(AutomationIntakeDocument)
        .filter(AutomationIntakeDocument.id == document_id)
        .first()
    )
    if not document:
        raise HTTPException(status_code=404, detail="That document no longer exists.")
    return document


@router.get("/intake/batches")
def list_intake_batches(
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    """Every intake batch, newest first, each with its documents."""
    batches = (
        db.query(AutomationIntakeBatch)
        .order_by(AutomationIntakeBatch.created_at.desc(), AutomationIntakeBatch.id.desc())
        .all()
    )
    return {"batches": [intake.batch_detail(b) for b in batches]}


@router.post("/intake/batches", status_code=201)
def create_intake_batch(
    payload: IntakeBatchCreate,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Create an empty batch to upload documents into."""
    username = (current_user or {}).get("username")
    batch = AutomationIntakeBatch(name=payload.name.strip(), created_by=username)
    db.add(batch)
    db.commit()
    db.refresh(batch)

    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action="create",
        resource_type="automation_intake_batch",
        resource_id=str(batch.id),
        resource_name=batch.name,
        status="success",
        details={"description": f"{username} created intake batch {batch.name!r}"},
    )
    return intake.batch_detail(batch)


@router.delete("/intake/batches/{batch_id}", status_code=200)
def delete_intake_batch(
    batch_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Delete a batch, its documents and their stored originals.

    Test cases harvested from those documents are left in place -- they may
    already be refined or have scripts built on them. See intake.delete_document.
    """
    batch = _batch_or_404(db, batch_id)
    name = batch.name

    for document in list(batch.documents):
        intake.delete_document(db, document)
    db.delete(batch)
    db.commit()

    username = (current_user or {}).get("username")
    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action="delete",
        resource_type="automation_intake_batch",
        resource_id=str(batch_id),
        resource_name=name,
        status="success",
        details={"description": f"{username} deleted intake batch {name!r}"},
    )
    return {"deleted": True, "id": batch_id}


@router.post("/intake/batches/{batch_id}/documents", status_code=201)
def upload_intake_documents(
    batch_id: int,
    files: list[UploadFile] = File(...),
    role: str = Form(default="brd"),
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Upload one or more documents into a batch and extract them.

    Extraction runs inline rather than on a worker: this backend has no queue,
    and the alternative -- returning immediately and making the UI poll a job
    that does not exist -- would be a worse lie than a slow request. The size
    ceiling in extraction.py is what keeps that bounded.

    A document that fails to parse is still recorded, with the reason. The
    response carries the whole batch so the table re-renders from one call.
    """
    batch = _batch_or_404(db, batch_id)
    username = (current_user or {}).get("username")

    if not files:
        raise HTTPException(status_code=400, detail="No files were uploaded.")

    accepted, rejected = [], []
    for upload in files:
        contents = upload.file.read()
        if not contents:
            rejected.append({"filename": upload.filename, "reason": "The file is empty."})
            continue
        try:
            document = intake.ingest(
                db,
                batch=batch,
                filename=upload.filename or "document",
                contents=contents,
                role=role,
                username=username,
            )
            accepted.append(document)
        except ValueError as exc:
            rejected.append({"filename": upload.filename, "reason": str(exc)})

    db.commit()
    db.refresh(batch)

    harvested = sum(d.cases_found for d in accepted)
    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action="upload",
        resource_type="automation_intake_batch",
        resource_id=str(batch.id),
        resource_name=batch.name,
        status="success" if accepted else "failure",
        details={
            "description": (
                f"{username} uploaded {len(accepted)} document(s) to intake "
                f"{batch.name!r}, yielding {harvested} test case(s)"
            ),
            "rejected": len(rejected),
        },
    )

    return {"batch": intake.batch_detail(batch), "rejected": rejected}


@router.patch("/intake/documents/{document_id}")
def set_intake_document_role(
    document_id: int,
    payload: IntakeDocumentRole,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Change what a document is.

    Only the label changes. Nothing is read here -- extraction is the Extract
    Test Cases button, and doing it as a side effect of a dropdown would mean a
    stray click could spend a model call. Correcting a role and then extracting
    is two deliberate actions, which is what the source studio does too.
    """
    document = _document_or_404(db, document_id)
    document.role = payload.role
    db.commit()

    batch = _batch_or_404(db, document.batch_id)
    note = None
    if payload.role == "test_cases" and document.cases_found == 0:
        note = "Marked as test cases. Press Extract Test Cases to read them in."
    return {"batch": intake.batch_detail(batch), "note": note}


@router.delete("/intake/documents/{document_id}", status_code=200)
def delete_intake_document(
    document_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Detach one document from its batch and delete its stored original."""
    document = _document_or_404(db, document_id)
    batch_id = document.batch_id
    filename = document.filename

    intake.delete_document(db, document)
    db.commit()

    batch = _batch_or_404(db, batch_id)
    username = (current_user or {}).get("username")
    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action="delete",
        resource_type="automation_intake_document",
        resource_id=str(document_id),
        resource_name=filename,
        status="success",
        details={"description": f"{username} removed {filename!r} from intake {batch.name!r}"},
    )
    return {"batch": intake.batch_detail(batch)}


@router.post("/intake/batches/{batch_id}/extract", status_code=202)
def extract_intake_test_cases(
    batch_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Read the uploaded test case documents into candidates.

    202 and poll, on the same contract as /workbench/generate and through the
    same job registry, so the frontend reuses /workbench/jobs/{job_id} and its
    progress component rather than growing a second polling mechanism.

    Deliberately separate from coverage assessment. Coverage needs a BRD or SRD
    to measure against; reading a test case sheet does not. Keeping the two on
    one button would leave a batch holding only existing test cases with no way
    into the Workbench, which is the case this module exists to serve.

    Refusals are up front: an unconfigured model provider would otherwise fail
    on every document in turn and report the same error N times. A batch that
    is entirely clean spreadsheets never reaches the model, so that check is
    skipped when every document can be read from its own table.
    """
    batch = _batch_or_404(db, batch_id)
    documents = [d for d in batch.documents if d.role == "test_cases"]

    if not documents:
        raise HTTPException(
            status_code=400,
            detail=(
                "This intake has no test case documents. Upload one with its type "
                "set to Test Cases, or change an existing document's type."
            ),
        )

    unreadable = [d.filename for d in documents if d.extract_status != "ready"]
    if len(unreadable) == len(documents):
        raise HTTPException(
            status_code=400,
            detail=(
                "None of the test case documents could be read: "
                + ", ".join(unreadable)
            ),
        )

    # Only documents whose own table cannot be mapped need the model. Checking
    # first means a tidy spreadsheet works with no provider configured at all.
    needs_model = [
        d
        for d in documents
        if d.extract_status == "ready" and not intake.can_read_table(d)
    ]
    if needs_model:
        status_info = provider_status()
        if not status_info.get("configured"):
            raise HTTPException(
                status_code=503,
                detail=(
                    f"{len(needs_model)} document(s) have no readable table, so they "
                    f"need the model, which is not configured. {status_info.get('detail')}"
                ),
            )

    username = (current_user or {}).get("username")
    job = intake.start_extraction_job(
        batch.id, document_count=len(documents), username=username
    )

    audit_log(
        actor=username or "unknown",
        actor_role=(current_user or {}).get("role"),
        module="Automation Studio",
        action="extract",
        resource_type="automation_intake_batch",
        resource_id=str(batch.id),
        resource_name=batch.name,
        status="success",
        details={
            "description": (
                f"{username} started test case extraction over {len(documents)} "
                f"document(s) in intake {batch.name!r}"
            ),
            "needs_model": len(needs_model),
        },
    )
    return job.to_dict()


# ── Guided Flow Discovery ───────────────────────────────────────────────────

@router.post("/workbench/test-cases/{case_id}/guided-discovery/start")
def start_guided_discovery(
    case_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Launch a live interactive headed browser for recording flow objects."""
    case = _load_case(db, case_id)
    session = guided_discovery_manager.start_session(case)
    return {
        "case_id": case.id,
        "display_id": case.display_id,
        "target_url": session.target_url,
        "status": session.status,
        "started_at": session.started_at.isoformat(),
    }


@router.post("/workbench/test-cases/{case_id}/guided-discovery/stop")
def stop_guided_discovery(
    case_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Stop the guided discovery browser session and persist objects."""
    session = guided_discovery_manager.stop_session(case_id)
    db.expire_all()
    case = _load_case(db, case_id)
    return {
        "case_id": case.id,
        "status": session.status if session else "stopped",
        "objects_count": len(case.recorded_flow_objects or []),
        "flow_discovery_status": case.flow_discovery_status or "none",
        "captured_objects": case.recorded_flow_objects or [],
    }


@router.get("/workbench/test-cases/{case_id}/guided-discovery/status")
def get_guided_discovery_status(
    case_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    """Get active live session status and captured items."""
    case = _load_case(db, case_id)
    session = guided_discovery_manager.get_session(case_id)
    active_status = session.status if session else (case.flow_discovery_status or "none")
    live_objects = session.captured_objects if session and session.captured_objects else (case.recorded_flow_objects or [])
    return {
        "case_id": case.id,
        "display_id": case.display_id,
        "status": active_status,
        "objects_count": len(live_objects),
        "captured_objects": live_objects,
    }


@router.get("/workbench/test-cases/{case_id}/guided-discovery/objects")
def get_guided_discovery_objects(
    case_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    """Get all saved flow objects for a test case."""
    case = _load_case(db, case_id)
    return {
        "case_id": case.id,
        "display_id": case.display_id,
        "flow_discovery_status": case.flow_discovery_status or "none",
        "objects": case.recorded_flow_objects or [],
    }


class UpdateFlowObjectsRequest(BaseModel):
    objects: list[dict[str, Any]]


@router.put("/workbench/test-cases/{case_id}/guided-discovery/objects")
def update_guided_discovery_objects(
    case_id: int,
    body: UpdateFlowObjectsRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Update or reorder saved flow objects."""
    case = _load_case(db, case_id)
    case.recorded_flow_objects = body.objects
    case.flow_discovery_status = "captured" if body.objects else "none"
    db.commit()
    db.refresh(case)
    return {
        "case_id": case.id,
        "objects_count": len(case.recorded_flow_objects or []),
        "objects": case.recorded_flow_objects,
    }


@router.delete("/workbench/test-cases/{case_id}/guided-discovery/objects")
def clear_guided_discovery_objects(
    case_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Clear recorded flow objects for a test case."""
    case = _load_case(db, case_id)
    case.recorded_flow_objects = None
    case.flow_discovery_status = "none"
    db.commit()
    db.refresh(case)
    return {"case_id": case.id, "cleared": True}


# ── Test Case Quality Review (eSMART Review Agent) ──────────────────────────

@router.post("/workbench/test-cases/{case_id}/review")
def run_case_review(
    case_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Run eSMART-grade multi-dimensional QA review on a test case."""
    from ..services.automation.review_agent import review_test_case
    case = _load_case(db, case_id)
    result = review_test_case(case, db=db)
    return result


@router.post("/workbench/test-cases/review-all")
def run_review_all(
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Run Review Agent over all test cases in batch."""
    from ..services.automation.review_agent import review_test_case
    all_cases = db.query(AutomationTestCase).all()
    case_map = {}
    for c in all_cases:
        if c.display_id not in case_map:
            case_map[c.display_id] = c
        elif c.source == "refined" and case_map[c.display_id].source != "refined":
            case_map[c.display_id] = c
    cases = list(case_map.values())
    results = []
    for case in cases:
        try:
            r = review_test_case(case, db=db)
            results.append(r)
        except Exception as e:
            logger.warning("Review failed for %s: %s", case.display_id, e)
    return {"reviewed_count": len(results), "reviews": results}


@router.post("/workbench/test-cases/{case_id}/auto-improve")
def run_case_auto_improve(
    case_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Automatically improve test case quality using Review Agent suggestions."""
    from ..services.automation.review_agent import auto_improve_test_case
    case = _load_case(db, case_id)
    result = auto_improve_test_case(case, db=db)
    return result


# ── Knowledge Base Endpoints ─────────────────────────────────────────────────

@router.get("/knowledge-base/applications")
def get_kb_applications(
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    """List all registered applications and their flow count in the Knowledge Base."""
    apps = kb.list_applications()
    return {"applications": apps, "total": len(apps)}


@router.get("/knowledge-base/applications/{app_id}/flows")
def get_kb_application_flows(
    app_id: str,
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    """List all Flow Blueprints for a specific application."""
    flows = kb.list_flows(app_id)
    profile = kb.load_app_profile(app_id)
    return {"app_id": app_id, "profile": profile, "flows": flows, "total": len(flows)}


@router.get("/knowledge-base/applications/{app_id}/flows/{flow_id}")
def get_kb_flow_detail(
    app_id: str,
    flow_id: str,
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    """Get details of a specific Flow Blueprint."""
    flows = kb.list_flows(app_id)
    matched = next((f for f in flows if f.get("flow_id") == flow_id), None)
    if not matched:
        raise HTTPException(status_code=404, detail=f"Flow blueprint {flow_id} not found for {app_id}")
    return matched


@router.get("/knowledge-base/applications/{app_id}/model")
def get_kb_application_model(
    app_id: str,
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    """
    Get the comprehensive Application Model in structured JSON format with full URL details,
    component selectors, known products catalog, and navigation graph.
    """
    model = kb.build_application_model(app_id)
    return model


@router.get("/knowledge-base/applications/{app_id}/model/export")
def export_kb_application_model(
    app_id: str,
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    """
    Download the Application Model as a formatted JSON file attachment.
    """
    json_str = kb.export_application_model_json(app_id, indent=2)
    return Response(
        content=json_str,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{app_id}_application_model.json"'}
    )

