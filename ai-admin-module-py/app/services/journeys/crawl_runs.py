"""
--- Journey-guided crawl runs: start, absorb, propose -------------------------------

The browser work is an ordinary AutomationRun -- the same runner, workspace,
test-data resolution, redaction, logs and cancellation as every other run
(see the Application Discovery crawl in routers/automation.py, which this
follows). This module only asks for the run, reads its output file when it
has finished, and turns the result into change sets on request.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from ...config import settings
from ...models.automation import AutomationApplication, AutomationRun
from ...models.kb_changes import KbChangeSet, KbCrawlRun
from . import changesets, journey_crawl, store


class Unavailable(Exception):
    """The crawl cannot be queued right now; status_code says why."""

    def __init__(self, message: str, status_code: int):
        super().__init__(message)
        self.status_code = status_code


def _automation_profile(kb: store.JourneyKB) -> Dict[str, Any]:
    from ..automation import knowledge_base as automation_kb

    return automation_kb.load_app_profile(kb.automation_app_id) or {}


def _kb(app_id: str) -> store.JourneyKB:
    kb = store.load(app_id)
    if kb is None:
        raise LookupError(f"No Journey KB for '{app_id}'.")
    return kb


def preview(app_id: str, journey_id: str, profile_id: Optional[str]) -> Dict[str, Any]:
    kb = _kb(app_id)
    profile = _automation_profile(kb)
    plan = journey_crawl.build_plan(kb, journey_id, automation_profile=profile,
                                    base_url=profile.get("base_url") or "", profile_id=profile_id)
    plan.pop("screens", None)
    return plan


def start(
    db: Session,
    *,
    app_id: str,
    journey_id: str,
    application_id: int,
    profile_id: Optional[str] = None,
    environment: Optional[str] = None,
    actor: Optional[str] = None,
) -> KbCrawlRun:
    from ..automation.job_manager import job_manager, new_run_key
    from ..automation.preflight import is_ready, runtime_status

    if not settings.AUTOMATION_ENABLED:
        raise Unavailable("The Automation Module is disabled on this deployment (AUTOMATION_ENABLED=false).", 503)
    if not is_ready():
        detail = "; ".join(f"{n}: {s.detail}" for n, s in runtime_status().items() if not s.available)
        raise Unavailable(f"The browser runtime is not available. {detail}", 503)
    permitted, reason = job_manager.capacity()
    if not permitted:
        raise Unavailable(reason, 429)

    application = db.get(AutomationApplication, application_id)
    if application is None:
        raise LookupError("No such registered application.")
    kb = _kb(app_id)
    if application.app_key != kb.app_id:
        raise ValueError(f"{application.name} is registered as '{application.app_key}', not '{kb.app_id}'.")
    base_url = (application.base_url or "").strip()
    if not base_url:
        raise ValueError(f"{application.name} has no base URL registered.")
    environment = (environment or application.environment or "SIT").strip()

    plan = journey_crawl.build_plan(kb, journey_id, automation_profile=_automation_profile(kb),
                                    base_url=base_url, profile_id=profile_id)
    run_key = new_run_key()
    db.add(AutomationRun(
        run_key=run_key, framework="playwright", environment=environment, status="queued",
        run_config={"headless": True, "slow_mo_ms": 300, "mode": "journey_crawl"},
        run_metadata={"code": journey_crawl.build_spec(plan), "base_url": base_url,
                      "file_name": journey_crawl.SPEC_FILE, "journey_id": journey_id},
        triggered_by=actor,
    ))
    crawl = KbCrawlRun(
        app_id=app_id, journey_id=journey_id, application_id=application.id, environment=environment,
        profile_id=plan.get("profile_id"), base_url=base_url, run_key=run_key, status="running",
        plan=plan, created_by=actor,
    )
    db.add(crawl)
    db.commit()
    db.refresh(crawl)
    job_manager.submit(run_key)
    return crawl


def _output_path(run: AutomationRun) -> Optional[Path]:
    from ..automation import workspace as ws

    for base in ([Path(run.workspace_path)] if run.workspace_path else []) + [ws.workspace_dir_for_run(run.run_key)]:
        candidate = base / journey_crawl.OUTPUT_FILE
        if candidate.exists():
            return candidate
    return None


def absorb(db: Session, crawl: KbCrawlRun) -> KbCrawlRun:
    """Fold a finished run's output into the crawl record, once."""
    if crawl.status in ("completed", "failed") or not crawl.run_key:
        return crawl
    run = db.query(AutomationRun).filter(AutomationRun.run_key == crawl.run_key).first()
    if run is None or run.status in ("queued", "running"):
        return crawl
    output = _output_path(run)
    if output is None:
        crawl.status = "failed"
        crawl.error = run.error_message or "The crawl produced no result. Its run log explains what stopped it."
    else:
        try:
            crawl.result = journey_crawl.evaluate(crawl.plan or {}, json.loads(output.read_text(encoding="utf-8")))
            crawl.status = "completed"
            crawl.error = None
        except (ValueError, KeyError) as exc:
            crawl.status = "failed"
            crawl.error = f"The crawl result could not be read: {exc}"
    crawl.finished_at = datetime.utcnow()
    db.commit()
    db.refresh(crawl)
    return crawl


def propose(db: Session, crawl_id: int, *, actor: Optional[str]) -> KbCrawlRun:
    """Draft the Automation KB and Journey KB change sets a finished crawl supports."""
    crawl = db.get(KbCrawlRun, crawl_id)
    if crawl is None:
        raise LookupError("No such crawl.")
    absorb(db, crawl)
    if crawl.status != "completed":
        raise changesets.ChangeSetError("Only a completed crawl can propose changes.")
    if crawl.automation_change_set_id or crawl.journey_change_set_id:
        raise changesets.ChangeSetError("This crawl has already proposed its changes.")
    kb = _kb(crawl.app_id)
    changes = journey_crawl.proposal(crawl.result or {}, _automation_profile(kb))
    if not changes["automation"] and not changes["journey"]:
        raise changesets.ChangeSetError("The crawl found nothing new to propose: every element it captured is already in both Knowledge Bases.")

    name = (crawl.plan or {}).get("journey_name") or crawl.journey_id
    origin = {"crawl": {"crawl_run_id": crawl.id, "journey_id": crawl.journey_id, "run_key": crawl.run_key}}
    automation_set = None
    if changes["automation"]:
        automation_set = changesets.draft(
            db, app_id=kb.automation_app_id, kb="automation", source="crawl", actor=actor, origin=origin,
            title=f"Crawl of {name}: {sum(len(c['value']) if isinstance(c['value'], dict) else 1 for c in changes['automation'])} selector(s)",
            description=f"Captured in {crawl.environment} at {crawl.base_url}. Every selector matched exactly one element when captured.",
            changes=changes["automation"],
        )
        crawl.automation_change_set_id = automation_set.id
    if changes["journey"]:
        journey_origin = {"crawl": {**origin["crawl"], "pair": automation_set.id if automation_set else None}}
        journey_set = changesets.draft(
            db, app_id=kb.app_id, kb="journey", source="crawl", actor=actor, origin=journey_origin,
            title=f"Crawl of {name}: link {len(changes['journey'])} element(s) to the Automation KB",
            description=("Approving this also publishes change set #%d, the selectors these links point at." % automation_set.id)
            if automation_set else None,
            changes=changes["journey"],
        )
        crawl.journey_change_set_id = journey_set.id
        if automation_set:
            automation_set.origin = {"crawl": {**origin["crawl"], "pair": journey_set.id}}
    db.commit()
    db.refresh(crawl)
    return crawl


def view(crawl: KbCrawlRun, *, with_result: bool = True) -> Dict[str, Any]:
    out = {
        "id": crawl.id, "app_id": crawl.app_id, "journey_id": crawl.journey_id,
        "journey_name": (crawl.plan or {}).get("journey_name"), "application_id": crawl.application_id,
        "environment": crawl.environment, "profile_id": crawl.profile_id, "base_url": crawl.base_url,
        "run_key": crawl.run_key, "status": crawl.status, "error": crawl.error,
        "automation_change_set_id": crawl.automation_change_set_id,
        "journey_change_set_id": crawl.journey_change_set_id,
        "created_by": crawl.created_by,
        "created_at": crawl.created_at.isoformat() if crawl.created_at else None,
        "finished_at": crawl.finished_at.isoformat() if crawl.finished_at else None,
        "summary": (crawl.result or {}).get("summary"),
    }
    if with_result:
        out["result"] = crawl.result
    return out
