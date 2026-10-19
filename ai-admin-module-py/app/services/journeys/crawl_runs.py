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
import re
import sys
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse

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
    return store.automation_profile(kb)


def _kb(app_id: str) -> store.JourneyKB:
    kb = store.load(app_id)
    if kb is None:
        raise LookupError(f"No Journey KB for '{app_id}'.")
    return kb


FLOW_PREFIX = "flow:"


def _interactive_mapping(crawl: KbCrawlRun, kb: store.JourneyKB, profile: Dict[str, Any]) -> Dict[str, list]:
    """Turn a person's headed-browser pick into a scoped, reviewable KB mapping.

    Ordinary crawl rows omit an unmapped journey step because it has no design
    element descriptor yet. Without this bridge, recapture appears to succeed
    but the selector never reaches the Journey or Automation KB.
    """
    order = (crawl.plan or {}).get("interactive_capture_order")
    if not order:
        return {"automation": [], "journey": []}
    items = (crawl.plan or {}).get("items") or []
    if not isinstance(order, int) or not 1 <= order <= len(items):
        raise changesets.ChangeSetError("The selected capture step is not in this journey.")
    item = items[order - 1]
    journey = kb.journeys.get(crawl.journey_id)
    if not journey:
        raise changesets.ChangeSetError("The approved journey is no longer available.")
    step = next((s for s in journey.get("steps") or [] if s.get("step_number") == item.get("step_number")), None)
    if not step:
        raise changesets.ChangeSetError("The selected journey step is no longer available.")
    if re.match(r"\s*(enter|fill|type)\b", str(step.get("action") or ""), re.I) and re.search(r",|\band\b", str(step.get("action") or ""), re.I):
        raise changesets.ChangeSetError("This journey step names multiple fields. Split it into one step per field before capturing a control.")
    if step.get("screen_id") and step.get("element_id"):
        return {"automation": [], "journey": []}  # the ordinary crawl proposal heals mapped controls
    captured = next((s.get("capture") for s in (crawl.result or {}).get("steps") or []
                     if s.get("order") == order and s.get("status") == "done" and isinstance(s.get("capture"), dict)), None)
    if not captured or not captured.get("found") or captured.get("ambiguous") or captured.get("count") != 1:
        raise changesets.ChangeSetError("No uniquely verified control was selected at that step.")
    selector = str(captured.get("selector") or "")
    address = urlparse(str(captured.get("url") or ""))
    base = urlparse(crawl.base_url or "")
    if not selector or not address.hostname or address.hostname != base.hostname or address.scheme not in ("http", "https"):
        raise changesets.ChangeSetError("The selected control is outside this application's browser scope.")
    route = address.path or "/"
    screen_id = step.get("screen_id") if step.get("screen_id") in kb.screens else next(
        (sid for sid, screen in kb.screens.items() if (screen.get("route") or "").split("?", 1)[0] == route), None)
    slug = lambda value: re.sub(r"[^a-z0-9]+", "_", str(value).lower()).strip("_")[:48] or "control"
    screen_id = screen_id or ("SCR_" + slug((address.hostname or "") + route).upper())
    label = str(captured.get("app_label") or item.get("text") or "Selected control")[:160]
    element_id = f"captured_{item['step_number']}_{slug(label)}"
    screen = deepcopy(kb.screens.get(screen_id) or {"screen_id": screen_id, "name": route, "route": route, "elements": []})
    screen["route"] = route
    group = screen_id.lower()
    ref = f"selectors.{group}.{element_id}"
    role = str(captured.get("role") or "").lower()
    tag = str(captured.get("tag") or "").lower()
    kind = "text_input" if tag in {"input", "textarea"} or role in {"textbox", "searchbox"} else "link" if tag == "a" or role == "link" else "button" if tag == "button" or role == "button" else "text"
    element = {"element_id": element_id, "label": label, "type": kind,
               "locator_hint": f'{role} "{label}"' if role else None,
               "observed_locator": selector, "observed_strategy": "headed-user-pick",
               "observed_selector": selector, "automation_ref": ref}
    screen["elements"] = [e for e in screen.get("elements") or [] if e.get("element_id") != element_id] + [element]
    screens = deepcopy(kb.screens)
    screens[screen_id] = screen
    steps = deepcopy(journey.get("steps") or [])
    for candidate in steps:
        if candidate.get("step_number") == step.get("step_number"):
            candidate["screen_id"], candidate["element_id"] = screen_id, element_id
            break
    journey_file = changesets._journey_file(kb, crawl.journey_id)
    selectors = profile.get("selectors") or {}
    current_group = selectors.get(group) if isinstance(selectors.get(group), dict) else {}
    return {
        "automation": [{"file": "app_profile.json", "op": "set", "path": f"selectors.{group}",
                        "value": {**current_group, element_id: selector}, "note": "Unique control selected in a headed browser."}],
        "journey": [{"file": "screens.json", "op": "set", "path": "screens", "value": list(screens.values()),
                     "note": "Add the browser-observed control to its application screen."},
                    {"file": journey_file, "op": "set", "path": "steps", "value": steps,
                     "note": f"Map journey step {step['step_number']} to the selected browser control."},
                    {"file": journey_file, "op": "set", "path": "screens",
                     "value": list(dict.fromkeys([*(journey.get("screens") or []), screen_id])),
                     "note": "Include the captured application screen in the journey."}],
    }


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
          stop_before: Optional[int], allow_risky: bool,
          environment: Optional[str] = None) -> Dict[str, Any]:
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
    plan["environment"] = environment
    approved = profile.get("trusted_auth_origins") or {}
    plan["trusted_auth_origins"] = (approved.get(environment.upper(), [])
                                    if environment and isinstance(approved, dict) else [])
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
    plan = _plan(kb, journey_id, base_url=base_url, profile_id=profile_id, stop_before=stop_before,
                 allow_risky=allow_risky, environment=environment)
    if any(item.get('kind') == 'manual_otp' for item in plan.get('items') or []):
        if not headed_available():
            raise ValueError('This login needs a fresh OTP in a visible browser. Run it from a local backend.')
        headed = True
    # Paced like the automation module's own runs: every browser action waits
    # AUTOMATION_DEFAULT_SLOW_MO_MS, and the walk pauses 1-2 s between steps.
    low = max(0, int(settings.AUTOMATION_STEP_DELAY_MIN_MS or 0))
    plan["step_delay_ms"] = [low, max(low, int(settings.AUTOMATION_STEP_DELAY_MAX_MS or 0))]
    slow_mo = max(0, int(settings.AUTOMATION_DEFAULT_SLOW_MO_MS or 0))
    code = journey_crawl.build_spec(plan)
    journey = kb.journeys.get(journey_id) or {}
    authored = (journey.get('source') or {}).get('live_authoring')
    if authored and not any(t.get('operation') in ('fill', 'select') for t in authored.get('trace', [])):
        from ..automation import live_authoring
        live_authoring.verify_expanded_journey(journey, kb.screens, authored['source_actions'],
                                              authored.get('expected_result') or '', base_url)
        if stop_before is not None or plan.get('stop_before'):
            raise ValueError('This browser-authored replay cannot skip its verified assertions.')
        code = live_authoring.script(authored, crawl_plan=plan)
    run_key = new_run_key()
    db.add(AutomationRun(
        run_key=run_key, framework="playwright", environment=environment, status="queued",
        # Headed is never faster than a person can follow.
        run_config={"headless": not headed, "slow_mo_ms": max(slow_mo, 700) if headed else slow_mo, "mode": "journey_crawl"},
        run_metadata={"code": code, "base_url": base_url,
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
    source = (crawl.plan or {}).get("source")
    if source == "browser":
        # Imported lazily because browser_collector uses this module to build
        # the ordinary crawl record.
        from . import browser_collector

        return browser_collector.live(crawl)
    if (crawl.plan or {}).get("execution_target") == "local":
        from . import local_runner

        return local_runner.live(crawl)
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
    if (crawl.plan or {}).get("source") == "browser":
        from . import browser_collector

        return browser_collector.capture_file(crawl.id, name)
    if not crawl.run_key:
        return None
    run = db.query(AutomationRun).filter(AutomationRun.run_key == crawl.run_key).first()
    return _run_file(run, name) if run is not None else None


def absorb(db: Session, crawl: KbCrawlRun) -> KbCrawlRun:
    """Fold a finished run's output into the crawl record, once."""
    if crawl.status == "running" and (crawl.plan or {}).get("source") == "browser":
        expires_at = ((crawl.plan or {}).get("collector") or {}).get("expires_at")
        try:
            expired = bool(expires_at) and datetime.utcnow() >= datetime.fromisoformat(str(expires_at))
        except ValueError:
            expired = True
        if expired:
            crawl.status = "failed"
            crawl.error = "The browser collector did not finish before its pairing code expired. Start a new browser crawl."
            crawl.finished_at = datetime.utcnow()
            db.commit()
            db.refresh(crawl)
        return crawl
    if crawl.status == "running" and (crawl.plan or {}).get("execution_target") == "local":
        agent = (crawl.plan or {}).get("local_agent") or {}
        try:
            expired = bool(agent.get("expires_at")) and datetime.utcnow() >= datetime.fromisoformat(str(agent.get("expires_at")))
        except (TypeError, ValueError):
            expired = True
        if expired:
            crawl.status = "failed"
            crawl.error = "The device runner did not start before its run code expired. Start a new local dry run."
            crawl.finished_at = datetime.utcnow()
            crawl.plan = {**(crawl.plan or {}), "local_agent": {
                **agent, "token_hash": None, "state": "failed", "message": crawl.error,
            }}
            run = db.query(AutomationRun).filter(AutomationRun.run_key == crawl.run_key).first()
            if run:
                run.status = "failed"; run.outcome = "blocked"; run.error_message = crawl.error; run.completed_at = datetime.utcnow()
            db.commit()
            db.refresh(crawl)
        return crawl
    if crawl.status in ("completed", "failed") or not crawl.run_key:
        return crawl
    if (crawl.plan or {}).get("source") == "record":
        from . import journey_record

        return journey_record.absorb(db, crawl)
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
    if (crawl.plan or {}).get("source") == "record":
        raise changesets.ChangeSetError("A recording is saved as the journey's steps, not proposed as changes.")
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
    # Onboarding creates the Journey KB before any browser walk. A newly
    # registered app has no Automation KB yet; give its first selector proposal
    # an empty, app-scoped baseline to apply against, never another app's KB.
    store.ensure_automation_baseline(kb, crawl.base_url or "")
    profile = _automation_profile(kb)
    changes = journey_crawl.proposal(result, profile)
    manual = _interactive_mapping(crawl, kb, profile)
    if manual["automation"]:
        for proposed in manual["automation"]:
            existing = next((change for change in changes["automation"] if change["path"] == proposed["path"]), None)
            if existing and isinstance(existing.get("value"), dict):
                existing["value"] = {**existing["value"], **proposed["value"]}
            else:
                changes["automation"].append(proposed)
        # The full screens update must precede per-element links from this
        # crawl, so none of its other confirmed controls are dropped.
        changes["journey"] = manual["journey"] + changes["journey"]
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
    """The journey's flow blueprint regenerated from its steps and the selectors the walks confirmed, drafted for review."""
    crawl = db.get(KbCrawlRun, crawl_id)
    if crawl is None:
        raise LookupError("No such crawl.")
    absorb(db, crawl)
    if crawl.status != "completed" or (crawl.journey_id or "").startswith(FLOW_PREFIX) or (crawl.plan or {}).get("source") == "record":
        raise changesets.ChangeSetError("A flow is generated from a completed journey walk.")
    kb = _kb(crawl.app_id)
    journey = kb.journeys.get(crawl.journey_id)
    if journey is None:
        raise LookupError(f"No journey '{crawl.journey_id}'.")
    # The journey's flow blueprint is generated from its steps on the Journey
    # Map: regenerate the linked one (or create and link one), so a journey
    # never ends up with a second, unlinked flow.
    from . import journey_map

    linked = any(f in journey_map._flows(kb) for f in journey.get("automation_flow_ids") or [])
    created = journey_map.propose(db, kb, crawl.journey_id, steps=None, link_flow=None if linked else "new", actor=actor)
    lead = created["automation"] or created["journey"]
    flow_id = (lead.origin or {}).get("map", {}).get("flow_id")
    flow = next((f for f in [journey_map._flows(kb).get(flow_id or "")] if f), None) or {"flow_id": flow_id, "flow_name": journey.get("name"), "canonical_steps": []}
    return {"change_set": changesets.change_set_view(lead), "flow": flow,
            "journey_change_set": changesets.change_set_view(created["journey"]) if created["journey"] and created["automation"] else None}


def view(crawl: KbCrawlRun, *, with_result: bool = True) -> Dict[str, Any]:
    out = {
        "id": crawl.id, "app_id": crawl.app_id, "journey_id": crawl.journey_id,
        "journey_name": (crawl.plan or {}).get("journey_name"), "application_id": crawl.application_id,
        "source": (crawl.plan or {}).get("source") or "journey",
        "execution_target": (crawl.plan or {}).get("execution_target") or "server",
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
        if out["source"] == "browser" and crawl.result:
            # Older completed collector runs may have evaluated only their
            # captured screens. Reconcile their displayed step history with
            # the value-free action ledger too, so the fix also applies to
            # results completed before this deployment.
            from . import browser_collector

            plan = dict(crawl.plan or {})
            out["result"] = browser_collector._merge_step_events(
                dict(crawl.result), plan, dict(plan.get("collector") or {})
            )
        if out["source"] == "record" and (crawl.result or {}).get("recording"):
            from .journey_record import with_check

            out["result"] = {**crawl.result, "recording": with_check(crawl.result["recording"], crawl.result.get("final_url"))}
    return out
