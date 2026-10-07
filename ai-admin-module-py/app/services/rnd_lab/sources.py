"""
--- AI R&D Lab: read-only adapters ---------------------------------------------

Everything the Lab knows about other modules comes through here, and nothing
here writes. Queries only: approved cases from Automation Studio, the BRD text
saved with each review request, the Journey KB files, the current script and
its last dry run. If a module changes shape, this is the one file to follow it.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)



def project(db: Session, project_id: int) -> Optional[Dict[str, Any]]:
    from ...models.database import Project

    row = db.get(Project, project_id)
    return {"id": row.id, "ppm_id": row.ppm_id, "name": row.name} if row else None


def approved_cases(db: Session, project_id: Optional[int], *, include_unassigned: bool = False,
                   case_ids: Optional[List[int]] = None) -> list:
    """Approved cases classified for automation: the Automation Lab's working set, per project."""
    from sqlalchemy import or_

    from ...models.automation import AutomationTestCase as Case
    from ..automation import workbench as wb

    # The same two conditions the Automation Lab applies, read from its constants.
    query = db.query(Case).filter(Case.approval_status == wb.APPROVAL_APPROVED,
                                  Case.classification.in_(wb.CLASSIFICATIONS_AUTOMATABLE))
    if case_ids is not None:
        query = query.filter(Case.id.in_(case_ids or [-1]))
    elif include_unassigned:
        query = query.filter(or_(Case.project_id == project_id, Case.project_id.is_(None)))
    else:
        query = query.filter(Case.project_id == project_id)
    return query.order_by(Case.id.desc()).all()


def case_title(case) -> str:
    return case.objective or case.description or case.display_id


def case_steps(case) -> List[Dict[str, Any]]:
    """Structured steps, or the raw numbered text split into steps when refinement never ran."""
    steps = [s for s in (case.steps_structured or []) if isinstance(s, dict)]
    if steps:
        return [{
            "step_number": s.get("step_number") or i + 1,
            "action": str(s.get("action") or ""),
            "action_type": s.get("action_type"),
            "target": s.get("target"),
            "test_data_ref": s.get("test_data_ref"),
            "expected_result": str(s.get("expected_result") or ""),
        } for i, s in enumerate(steps)]
    try:
        from ..automation.eligibility import split_steps

        raw = split_steps(case.steps_raw or "")
    except Exception:  # noqa: BLE001 - a malformed raw string is not fatal
        raw = [line for line in (case.steps_raw or "").splitlines() if line.strip()]
    out = [{"step_number": i + 1, "action": str(s), "action_type": None, "target": None,
            "test_data_ref": None, "expected_result": ""} for i, s in enumerate(raw)]
    if out and case.expected_result:
        out[-1]["expected_result"] = case.expected_result
    return out


def request_documents(db: Session, request_ids: set) -> Dict[str, List[Dict[str, str]]]:
    """BRD (and other) text saved with each review request, by request id."""
    from ...models.database import TestCaseReviewDetail

    if not request_ids:
        return {}
    out: Dict[str, List[Dict[str, str]]] = {}
    rows = db.query(TestCaseReviewDetail).filter(TestCaseReviewDetail.request_id.in_(list(request_ids))).all()
    for detail in rows:
        docs = []
        for i, item in enumerate(detail.brd_document or []):
            if isinstance(item, dict) and (item.get("content") or "").strip():
                docs.append({"name": item.get("name") or f"Document {i + 1}", "content": item["content"]})
        generation = detail.generation if isinstance(detail.generation, dict) else {}
        if not docs and (generation.get("document_text") or "").strip():
            names = generation.get("document_names") or []
            docs.append({"name": names[0] if names else "Requirements", "content": generation["document_text"]})
        if docs:
            out[detail.request_id] = docs
    return out


def current_scripts(db: Session, case_ids: List[int]) -> Dict[int, Dict[str, Any]]:
    """The current script per case, with its last dry run read through the run."""
    from ...models.automation import AutomationRun, AutomationScript

    if not case_ids:
        return {}
    scripts = (db.query(AutomationScript)
               .filter(AutomationScript.test_case_id.in_(case_ids), AutomationScript.is_current.is_(True))
               .order_by(AutomationScript.id.desc()).all())
    keys = [s.dry_run_key for s in scripts if s.dry_run_key]
    runs = {r.run_key: r for r in db.query(AutomationRun).filter(AutomationRun.run_key.in_(keys))} if keys else {}
    out: Dict[int, Dict[str, Any]] = {}
    for script in scripts:
        if script.test_case_id in out:
            continue  # newest first; one per case
        run = runs.get(script.dry_run_key)
        out[script.test_case_id] = {
            "id": script.id,
            "framework": script.framework,
            "file_name": script.file_name,
            "status": script.status,
            "version": script.version,
            "code": script.code or "",
            "dry_run": _dry_run_status(run) if run is not None else "not_run",
        }
    return out


def _dry_run_status(run) -> str:
    return {
        "queued": "queued",
        "running": "running",
        "completed": "passed" if run.outcome == "passed" else "failed",
        "failed": "blocked" if run.outcome == "blocked" else "failed",
        "cancelled": "not_run",
    }.get(run.status, "not_run")


# --- Journey KB -------------------------------------------------------------------

def kb_apps() -> List[Dict[str, str]]:
    from ..journeys import store

    out = []
    for app_id in store.list_apps():
        kb = store.load(app_id)
        out.append({"app_id": app_id, "app_name": kb.app_name if kb else app_id})
    return out


def kb_catalog(app_id: Optional[str]) -> Dict[str, Any]:
    """Elements, screens and business rules of a Journey KB, flattened for matching."""
    if not app_id:
        return {"app_id": None, "elements": [], "rules": [], "screens": {}}
    from ..journeys import store

    kb = store.load(app_id)
    if kb is None:
        return {"app_id": app_id, "elements": [], "rules": [], "screens": {}, "missing": True}
    elements = []
    for screen_id, screen in kb.screens.items():
        for el in screen.get("elements") or []:
            if not isinstance(el, dict) or not el.get("element_id"):
                continue
            elements.append({
                "ref": f"{screen_id}.{el['element_id']}",
                "screen_id": screen_id,
                "screen": screen.get("name") or screen_id,
                "element_id": el["element_id"],
                "label": str(el.get("label") or ""),
                "type": str(el.get("type") or ""),
                "aliases": [str(a) for a in el.get("aliases") or []],
                "locator_hint": el.get("locator_hint"),
                "basis": el.get("basis"),
            })
    rules = [{"rule_id": rid, "statement": str(r.get("statement") or ""), "type": r.get("type"),
              "basis": r.get("basis")} for rid, r in kb.rules.items()]
    screens = {sid: {"name": s.get("name") or sid, "route": s.get("route")} for sid, s in kb.screens.items()}
    return {"app_id": app_id, "app_name": kb.app_name, "elements": elements, "rules": rules, "screens": screens}
