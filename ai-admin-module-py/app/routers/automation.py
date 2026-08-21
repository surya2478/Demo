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
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings
from ..database.connection import get_db
from ..models.automation import AutomationTestCase
from ..services.authz import require_permission
from ..services.automation.eligibility import score_test_case
from ..services.automation.preflight import runtime_status

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
