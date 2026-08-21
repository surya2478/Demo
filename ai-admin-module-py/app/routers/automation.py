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

import json
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings
from ..database.connection import get_db
from ..models.automation import AutomationRun, AutomationRunResult, AutomationTestCase
from ..services.authz import require_permission
from ..services.automation import workspace as ws
from ..services.automation.eligibility import score_test_case
from ..services.automation.job_manager import job_manager, new_run_key
from ..services.automation.preflight import is_ready, runtime_status
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


def _run_summary(run: AutomationRun) -> dict:
    return {
        "run_key": run.run_key,
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

    run = AutomationRun(
        run_key=run_key,
        test_case_id=body.test_case_id,
        framework="playwright",
        environment=body.environment,
        status="queued",
        # Headless is the decision for this deployment. Persisted as a config
        # object rather than assumed, so a future profile is a new value here
        # instead of a schema change.
        run_config={"headless": True, "mode": "standard"},
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

    return {
        **_run_summary(run),
        "has_log": bool(run.log_path and Path(run.log_path).exists()),
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
