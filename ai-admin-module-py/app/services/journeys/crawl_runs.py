"""
--- Journey-guided crawl runs: start, absorb, propose -------------------------------

The browser work is an ordinary AutomationRun -- the same runner, workspace,
test-data resolution, redaction, logs and cancellation as every other run
(see the Application Discovery crawl in routers/automation.py, which this
follows). This module only asks for the run, reads its output file when it
has finished, and turns the result into change sets on request.

It is also the dry-run engine for the Knowledge Base page: a walk's source is a
Journey KB journey or an Automation KB flow blueprint ("flow:<id>" in
journey_id), it can stop before a chosen step and before anything that changes
data, it can be watched live (live()), and -- where the server can show a
browser, i.e. a backend running on someone's own machine -- run headed.
"""
from __future__ import annotations

import json
import os
import sys
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


FLOW_PREFIX = "flow:"


def headed_available() -> bool:
    """Whether a walk may open a visible browser here.

    Only where someone can see it: a backend on a Windows or macOS desktop, or
    a Linux one with a display. Never in a container. AUTOMATION_ALLOW_HEADED
    (true/false) overrides the guess.
    """
    flag = (os.environ.get("AUTOMATION_ALLOW_HEADED") or "").strip().lower()
    if flag in ("1", "true", "yes"):
        return True
    if flag in ("0", "false", "no"):
        return False
    if os.path.exists("/.dockerenv"):
        return False
    return sys.platform in ("win32", "darwin") or bool(os.environ.get("DISPLAY"))


def blocked_environments() -> list:
    """Environments a walk refuses: it types into forms and clicks through journeys."""
    raw = os.environ.get("AUTOMATION_WALK_BLOCKED_ENVIRONMENTS") or "PRODUCTION,PROD,LIVE"
    return [e.strip().upper() for e in raw.split(",") if e.strip()]


def flows(app_id: str) -> list:
    """The Automation KB flow blueprints of the Journey KB's application, for the source picker."""
    from ..automation import knowledge_base as automation_kb

    kb = _kb(app_id)
    return [{"flow_id": f.get("flow_id"), "flow_name": f.get("flow_name") or f.get("flow_id"),
             "category": f.get("category"), "steps": len(f.get("canonical_steps", []))}
            for f in automation_kb.list_flows(kb.automation_app_id)]


def _plan(kb: store.JourneyKB, source_id: str, *, base_url: str, profile_id: Optional[str],
          stop_before: Optional[int], allow_risky: bool) -> Dict[str, Any]:
    profile = _automation_profile(kb)
    if source_id.startswith(FLOW_PREFIX):
        from ..automation import knowledge_base as automation_kb

        flow_id = source_id[len(FLOW_PREFIX):]
        flow = next((f for f in automation_kb.list_flows(kb.automation_app_id) if f.get("flow_id") == flow_id), None)
        if flow is None:
            raise LookupError(f"No flow blueprint '{flow_id}'.")
        # The same user a journey walk signs in as, unless one is chosen.
        profiles = {k: v for k, v in ((kb.roles or {}).get("test_data_profiles") or {}).items() if isinstance(v, dict)}
        if not profile_id:
            profile_id = next((pid for pid, p in profiles.items() if "Journey Crawl sign-in" in p.get("extra_users", [])), None)
        plan = journey_crawl.build_flow_plan(flow, automation_profile=profile, base_url=base_url,
                                             data_profile=profiles.get(profile_id or ""), profile_id=profile_id)
        plan["journey_id"] = source_id
    else:
        plan = journey_crawl.build_plan(kb, source_id, automation_profile=profile, base_url=base_url, profile_id=profile_id)
        plan["source"] = "journey"
    return journey_crawl.apply_stop(plan, stop_before=stop_before, allow_risky=allow_risky)


def preview(app_id: str, journey_id: str, profile_id: Optional[str], *, stop_before: Optional[int] = None,
            allow_risky: bool = False) -> Dict[str, Any]:
    kb = _kb(app_id)
    profile = _automation_profile(kb)
    plan = _plan(kb, journey_id, base_url=profile.get("base_url") or "", profile_id=profile_id,
                 stop_before=stop_before, allow_risky=allow_risky)
    plan.pop("screens", None)
    plan["screen_names"] = {sid: sig.get("name") for sid, sig in (plan.pop("signatures", None) or {}).items()}
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
    stop_before: Optional[int] = None,
    allow_risky: bool = False,
    headed: bool = False,
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
    environment = (environment or application.environment or "SIT").strip()
    if environment.upper() in blocked_environments():
        raise ValueError(f"Walks do not run against {environment}: they fill in forms and click through journeys. "
                         "Use SIT, QA, UAT or RC.")
    if headed and not headed_available():
        raise ValueError("This server cannot show a browser. Watch the walk live on this page instead.")
    # The environment's own address in Test Data, else the registered one.
    from ..automation.registry import address_for_crawl

    base_url = (address_for_crawl(db, application.app_key, environment) or application.base_url or "").strip()
    if not base_url:
        raise ValueError(f"{application.name} has no address for {environment}. Add one in AI Test Automation > Test Data.")
    # A journey walk starts at this address and nothing else: the application
    # takes it to its first screen, which the walk recognises by what is on
    # it (journey_crawl.entry_address). A flow starts at its own entry point.
    plan = _plan(kb, journey_id, base_url=base_url, profile_id=profile_id, stop_before=stop_before, allow_risky=allow_risky)
    run_key = new_run_key()
    db.add(AutomationRun(
        run_key=run_key, framework="playwright", environment=environment, status="queued",
        # Headed is slowed down so a person can follow it.
        run_config={"headless": not headed, "slow_mo_ms": 700 if headed else 300, "mode": "journey_crawl"},
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


def _run_file(run: AutomationRun, name: str) -> Optional[Path]:
    from ..automation import workspace as ws

    for base in ([Path(run.workspace_path)] if run.workspace_path else []) + [ws.workspace_dir_for_run(run.run_key)]:
        candidate = base / name
        if candidate.exists():
            return candidate
    return None


def _output_path(run: AutomationRun) -> Optional[Path]:
    return _run_file(run, journey_crawl.OUTPUT_FILE)


def live(db: Session, crawl: KbCrawlRun) -> Dict[str, Any]:
    """Where a walk has got to: its steps so far, the step under way, and whether a frame is ready."""
    run = db.query(AutomationRun).filter(AutomationRun.run_key == crawl.run_key).first() if crawl.run_key else None
    progress: Dict[str, Any] = {}
    frame_at = None
    if run is not None:
        path = _run_file(run, journey_crawl.PROGRESS_FILE)
        if path is not None:
            try:
                progress = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                progress = {}  # mid-rename; the next poll reads it
        frame = _run_file(run, journey_crawl.FRAME_FILE)
        frame_at = frame.stat().st_mtime if frame is not None else None
    return {
        "id": crawl.id, "status": crawl.status, "run_status": run.status if run else None,
        "phase": ((run.run_metadata or {}).get("execution_phase") if run else None),
        "total": progress.get("total") or len((crawl.plan or {}).get("items", [])),
        "current": progress.get("current"), "finished": bool(progress.get("finished")),
        "steps": progress.get("steps", []), "frame_at": frame_at,
    }


def run_file(db: Session, crawl: KbCrawlRun, name: str) -> Optional[Path]:
    """A frame or step screenshot of a walk; None when there is none (yet)."""
    if not crawl.run_key:
        return None
    run = db.query(AutomationRun).filter(AutomationRun.run_key == crawl.run_key).first()
    return _run_file(run, name) if run is not None else None


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


def _flow_file(app_key: str, flow_id: str) -> str:
    """The Automation KB file a flow blueprint lives in, relative to its folder."""
    from ..automation import knowledge_base as automation_kb

    folder = changesets.kb_dir(app_key, "automation") / "flows"
    for path in sorted(folder.glob("*.json")) if folder.exists() else []:
        try:
            if json.loads(path.read_text(encoding="utf-8")).get("flow_id") == flow_id:
                return f"flows/{path.name}"
        except (OSError, ValueError):
            continue
    raise LookupError(f"No flow blueprint file for '{flow_id}'.")


def _with_picks(result: Dict[str, Any], picks: list) -> Dict[str, Any]:
    """The walk's rows with the reviewer's picked candidates taken as captured selectors."""
    chosen = {(p["screen_id"], p["element_id"]): p["selector"] for p in picks or [] if p.get("selector")}
    rows = []
    for row in result.get("rows", []):
        selector = chosen.get((row["screen_id"], row["element_id"]))
        if selector:
            row = {**row, "selector": selector, "ambiguous": False, "data_dependent": False, "strategy": "picked",
                   "outcome": "healed" if row.get("kb_target") else "new"}
        rows.append(row)
    return {**result, "rows": rows}


def propose(db: Session, crawl_id: int, *, actor: Optional[str], additions: Optional[list] = None,
            picks: Optional[list] = None) -> KbCrawlRun:
    """Draft the change sets a finished walk supports.

    A journey walk: the selectors it captured (and the candidates the reviewer
    picked for elements it could not find) for the Automation KB, their links
    for the Journey KB, and -- when chosen -- the app-only elements it
    catalogued, as new Journey KB elements with their selectors. A flow walk:
    the flow's step targets that failed and were found another way, or picked.
    """
    crawl = db.get(KbCrawlRun, crawl_id)
    if crawl is None:
        raise LookupError("No such crawl.")
    absorb(db, crawl)
    if crawl.status != "completed":
        raise changesets.ChangeSetError("Only a completed walk can propose changes.")
    kb = _kb(crawl.app_id)
    name = (crawl.plan or {}).get("journey_name") or crawl.journey_id
    origin = {"crawl": {"crawl_run_id": crawl.id, "journey_id": crawl.journey_id, "run_key": crawl.run_key}}
    result = _with_picks(crawl.result or {}, picks or [])

    if (crawl.journey_id or "").startswith(FLOW_PREFIX):
        flow_id = crawl.journey_id[len(FLOW_PREFIX):]
        step_picks = {int(p["element_id"].split("_", 1)[1]): p["selector"] for p in picks or []
                      if str(p.get("element_id", "")).startswith("step_") and p.get("selector")}
        changes = journey_crawl.flow_fixes(crawl.result or {}, _flow_file(kb.automation_app_id, flow_id), step_picks)
        if not changes:
            raise changesets.ChangeSetError("Nothing to fix: every step the walk reached was found with the flow's own selector. "
                                            "Pick a candidate for a step it could not find.")
        fix = changesets.draft(
            db, app_id=kb.automation_app_id, kb="automation", source="crawl", actor=actor, origin=origin,
            title=f"Dry run of {name}: fix {len(changes)} step selector(s)",
            description=f"Walked in {crawl.environment} at {crawl.base_url}.", changes=changes,
        )
        crawl.automation_change_set_id = fix.id
        db.commit()
        db.refresh(crawl)
        return crawl

    if crawl.automation_change_set_id or crawl.journey_change_set_id:
        raise changesets.ChangeSetError("This walk has already proposed its changes.")
    profile = _automation_profile(kb)
    changes = journey_crawl.proposal(result, profile)
    # Where the walk found each screen, for screens whose address is not recorded or has moved.
    routes = journey_crawl.route_changes(crawl.result or {}, kb, profile)
    changes["automation"].extend(routes["automation"])
    changes["journey"].extend(routes["journey"])
    extra = journey_crawl.additions(crawl.result or {}, additions or [], walk_id=crawl.id)
    if extra["groups"]:
        # One change per selectors group: the walk's captures and the additions together.
        by_path = {c["path"]: c for c in changes["automation"]}
        selectors = profile.get("selectors") or {}
        for group, entries in extra["groups"].items():
            path = f"selectors.{group}"
            if path in by_path and isinstance(by_path[path]["value"], dict):
                by_path[path]["value"] = {**by_path[path]["value"], **entries}
                by_path[path]["note"] = f"{len(by_path[path]['value'])} selector(s) from the walk"
            else:
                existing = selectors.get(group) if isinstance(selectors.get(group), dict) else {}
                changes["automation"].append({"file": "app_profile.json", "op": "set", "path": path,
                                              "value": {**existing, **entries}, "note": f"{len(entries)} element(s) added from the walk"})
        changes["journey"].extend(extra["journey"])
    if not changes["automation"] and not changes["journey"]:
        raise changesets.ChangeSetError("The walk found nothing new to propose: every element it captured is already in both "
                                        "Knowledge Bases. Tick app-only elements to add them.")

    added = len(extra["journey"])
    automation_set = None
    if changes["automation"]:
        automation_set = changesets.draft(
            db, app_id=kb.automation_app_id, kb="automation", source="crawl", actor=actor, origin=origin,
            title=f"Crawl of {name}: {sum(len(c['value']) if isinstance(c['value'], dict) else 1 for c in changes['automation'] if not c['path'].startswith('endpoints.'))} selector(s)"
                  + (f", {len(routes['automation'])} address(es)" if routes["automation"] else ""),
            description=f"Captured in {crawl.environment} at {crawl.base_url}. Every selector matched exactly one element when captured.",
            changes=changes["automation"],
        )
        crawl.automation_change_set_id = automation_set.id
    if changes["journey"]:
        journey_origin = {"crawl": {**origin["crawl"], "pair": automation_set.id if automation_set else None}}
        journey_set = changesets.draft(
            db, app_id=kb.app_id, kb="journey", source="crawl", actor=actor, origin=journey_origin,
            title=f"Crawl of {name}: link {len(changes['journey']) - added} element(s)"
                  + (f", add {added} from the app" if added else "") + " to the Journey KB",
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


def generate_flow(db: Session, crawl_id: int, *, actor: Optional[str]) -> Dict[str, Any]:
    """Draft a flow blueprint from a journey walk: the steps it performed, with the selectors it used."""
    crawl = db.get(KbCrawlRun, crawl_id)
    if crawl is None:
        raise LookupError("No such crawl.")
    absorb(db, crawl)
    if crawl.status != "completed" or (crawl.journey_id or "").startswith(FLOW_PREFIX):
        raise changesets.ChangeSetError("A flow is generated from a completed journey walk.")
    kb = _kb(crawl.app_id)
    journey = kb.journeys.get(crawl.journey_id)
    if journey is None:
        raise LookupError(f"No journey '{crawl.journey_id}'.")
    flow = journey_crawl.flow_from_walk(crawl.plan or {}, crawl.result or {}, journey, kb.journeys)
    if not flow["canonical_steps"]:
        raise changesets.ChangeSetError("The walk performed no step with a selector, so there is no flow to generate.")
    try:
        rel = _flow_file(kb.automation_app_id, flow["flow_id"])
        changes = [{"file": rel, "op": "set", "path": key, "value": flow[key], "note": "from the walk"}
                   for key in ("flow_name", "catalog_entrypoint", "canonical_steps", "target_match_keywords", "generated_from")]
        verb = "Update"
    except LookupError:
        rel = f"flows/{flow['flow_id']}.json"
        changes = [{"file": rel, "op": "create", "path": changesets.ROOT, "value": flow, "note": f"{len(flow['canonical_steps'])} steps"}]
        verb = "New"
    draft = changesets.draft(
        db, app_id=kb.automation_app_id, kb="automation", source="crawl", actor=actor,
        origin={"crawl": {"crawl_run_id": crawl.id, "journey_id": crawl.journey_id, "run_key": crawl.run_key, "generated_flow": flow["flow_id"]}},
        title=f"{verb} flow from the walk of {journey.get('name') or crawl.journey_id}: {len(flow['canonical_steps'])} steps",
        description=f"Walked in {crawl.environment} at {crawl.base_url}; only the steps that ran, with the selectors they used.",
        changes=changes,
    )
    return {"change_set": changesets.change_set_view(draft), "flow": flow}


def view(crawl: KbCrawlRun, *, with_result: bool = True) -> Dict[str, Any]:
    out = {
        "id": crawl.id, "app_id": crawl.app_id, "journey_id": crawl.journey_id,
        "journey_name": (crawl.plan or {}).get("journey_name"), "application_id": crawl.application_id,
        "source": (crawl.plan or {}).get("source") or "journey",
        "stop_before": (crawl.plan or {}).get("stop_before"), "stop_reason": (crawl.plan or {}).get("stop_reason"),
        "entry": (crawl.plan or {}).get("entry"), "scenario": (crawl.plan or {}).get("scenario"),
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
