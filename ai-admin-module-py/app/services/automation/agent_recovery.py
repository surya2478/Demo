"""Resume an evidence-held agent journey with a fresh, scoped browser scan."""
from __future__ import annotations

from datetime import datetime
import json
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy.orm import Session

from ...models.automation import AutomationAICheck, AutomationDiscoveryRun
from ...models.kb_changes import KbChangeSet
from ...routers import automation as automation_router
from . import agent_approval, agent_journey, expert_editor


def align_steps(db: Session, batch_id: str, check_id: int, actor: str) -> dict:
    """Draft a source-step correction before a person captures a combined field.

    A single headed-browser pick cannot prove both halves of a combined action.
    Keep matching approved mappings, but split the stale journey to match the
    saved case. Publishing remains the normal human KB decision.
    """
    from ..journeys import changesets, store

    check = db.get(AutomationAICheck, check_id)
    if not check or check.batch_id != batch_id or check.status not in {"failed", "awaiting_approval"}:
        raise ValueError("This case is not waiting for a control repair.")
    state = check.steps or {}
    setup = state.get("_agent_setup") or {}
    plan = state.get("_agent_plan") or {}
    journey_id = plan.get("journey_id")
    kb = store.load(setup.get("app_key") or "")
    if not kb or journey_id not in kb.journeys:
        raise ValueError("Approve the prepared journey before aligning its steps.")
    original = kb.journeys[journey_id]
    actions = agent_journey.source_steps(check.source_row or {})
    if not actions:
        raise ValueError("The saved case has no source steps to align.")
    old = original.get("steps") or []
    if [str(step.get("action") or "").strip() for step in old] == actions:
        raise ValueError("The approved journey already matches the saved case steps.")
    by_action = {str(step.get("action") or "").strip(): step for step in old}
    revised = []
    for number, action in enumerate(actions, start=1):
        previous = by_action.get(action) or {}
        revised.append({"step_number": number, "action": action,
                        "expected_result": previous.get("expected_result"),
                        "screen_id": previous.get("screen_id"), "element_id": previous.get("element_id")})
    questions = [f"Step {s['step_number']}: {s['action']}" for s in revised if not s["element_id"]]
    source_file = changesets._journey_file(kb, journey_id)
    proposal = changesets.draft(
        db, app_id=kb.app_id, kb="journey", source="agent-repair", actor=actor,
        title=f"Align journey steps with saved case {check.case_id}",
        description="Split combined actions so each browser control is captured and approved separately.",
        origin={"ai_check_case_id": check.case_id, "journey_id": journey_id},
        changes=[{"file": source_file, "op": "set", "path": "steps", "value": revised,
                  "note": "Use the saved case's one-control-per-action steps; preserve matching approved mappings."},
                 {"file": source_file, "op": "set", "path": "open_questions",
                  "value": ["These steps still need a browser-selected control: " + "; ".join(questions)] if questions else [],
                  "note": "Keep unverified controls explicit until captured."}],
    )
    return {"change_set_id": proposal.id, "steps": len(revised), "unmapped": len(questions)}


def _scan_progress(run: AutomationDiscoveryRun) -> dict:
    """Read the crawler's small, non-secret progress snapshot while it runs."""
    if not run.run_key:
        return {}
    from ...services.automation import discovery, workspace
    # The canonical workspace is keyed by run_key; it is available before the
    # final discovery output is absorbed into the database.
    path = workspace.workspace_dir_for_run(run.run_key) / discovery.DISCOVERY_PROGRESS_FILE
    try:
        snapshot = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(snapshot, dict):
        return {}

    def safe_page(item: dict) -> dict:
        url = urlsplit(str(item.get("url") or ""))
        return {"url": urlunsplit((url.scheme, url.netloc, url.path, "", "")),
                "title": str(item.get("title") or "")[:120]}

    current = safe_page({"url": snapshot.get("current_url")})["url"]
    return {
        "phase": str(snapshot.get("phase") or "Scanning")[:80],
        "current_url": current,
        "observed_pages": max(0, int(snapshot.get("pages") or 0)),
        "observed_controls": max(0, int(snapshot.get("controls") or 0)),
        "blockers": max(0, int(snapshot.get("blockers") or 0)),
        "max_pages": max(1, int(snapshot.get("max_pages") or 30)),
        "recent_pages": [safe_page(item) for item in (snapshot.get("recent_pages") or [])[-5:] if isinstance(item, dict)],
    }


def _check(db: Session, batch_id: str, check_id: int) -> AutomationAICheck:
    check = db.get(AutomationAICheck, check_id)
    if not check or check.batch_id != batch_id or check.status != "awaiting_approval":
        raise ValueError("This case is not waiting for a Journey KB draft.")
    guide = ((check.steps or {}).get("_agents") or {}).get("navigation_guide") or {}
    if guide.get("status") != "needs_approval":
        raise ValueError("There is no pending journey draft to scan.")
    return check


def start(db: Session, batch_id: str, check_id: int, actor: str, *, reuse_existing: bool = False) -> dict:
    check = _check(db, batch_id, check_id)
    state = dict(check.steps or {})
    recovery = state.get("_agent_recovery") or {}
    if recovery.get("status") == "scanning":
        return {"status": "scanning", "run_id": recovery["run_id"]}
    setup = state.get("_agent_setup") or {}
    from ...models.automation import AutomationApplication
    app = db.get(AutomationApplication, setup.get("application_id"))
    if not app or app.app_key != setup.get("app_key"):
        raise ValueError("The selected application is no longer registered.")
    if reuse_existing:
        run = (db.query(AutomationDiscoveryRun)
               .filter(AutomationDiscoveryRun.application_id == app.id,
                       AutomationDiscoveryRun.status == "completed")
               .order_by(AutomationDiscoveryRun.id.desc()).first())
        if not run or urlsplit(run.application_url or "").netloc != urlsplit(app.base_url or "").netloc:
            raise ValueError("No completed browser capture exists for this application. Run a fresh crawl instead.")
    else:
        run = automation_router.start_discovery(
            automation_router.DiscoveryRequest(
                application_id=app.id, application_url=app.base_url,
                application_environment=setup.get("environment"), max_pages=30,
            ), db=db, current_user={"username": actor, "role": "admin"},
        )
    run_id = run.id if hasattr(run, "id") else run["id"]
    state["_agent_recovery"] = {"status": "scanning", "run_id": run_id,
                                 "reused_capture": reuse_existing}
    check.steps = state
    db.commit()
    return {"status": "scanning", "run_id": run_id, "reused_capture": reuse_existing}


def progress(db: Session, batch_id: str, check_id: int, actor: str) -> dict:
    check = _check(db, batch_id, check_id)
    state = dict(check.steps or {})
    recovery = state.get("_agent_recovery") or {}
    run_id = recovery.get("run_id")
    if not run_id:
        return {"status": "idle"}
    if recovery.get("status") != "scanning":
        return recovery
    run = db.get(AutomationDiscoveryRun, run_id)
    if not run:
        raise ValueError("The browser scan could not be found.")
    automation_router._absorb_discovery_result(db, run)
    if run.status not in {"completed", "failed"}:
        return {"status": "scanning", "run_id": run_id,
                "reused_capture": bool(recovery.get("reused_capture")), **_scan_progress(run)}
    if run.status == "failed":
        recovery = {"status": "failed", "run_id": run_id, "message": run.error or "Browser scan failed."}
    else:
        editor_notes: list[str] = []
        setup = state.get("_agent_setup") or {}
        plan = state.get("_agent_plan") or {}
        old_ids = ((state.get("_agents") or {}).get("navigation_guide") or {}).get("change_set_ids") or []
        source_id = plan.get("change_set_id") or (old_ids[0] if old_ids else None)
        original = db.get(KbChangeSet, source_id) if source_id else None
        journey_file = next((item.file for item in (original.changes if original else [])
                             if item.file.startswith("journeys/")), None)
        from ..journeys import store
        kb = store.load(setup["app_key"])
        published = bool(kb and plan.get("journey_id") in kb.journeys and journey_file)
        try:
            if published:
                new_id, unresolved = agent_journey.repair_published(
                    db, app_id=setup["app_key"], journey_id=plan["journey_id"],
                    journey_file=journey_file, case_id=check.case_id,
                    row=check.source_row or {}, actor=actor, discovery=run, editor_notes=editor_notes,
                )
                journey_id = plan["journey_id"]
            else:
                new_id, journey_id, unresolved = agent_journey.draft_from_case(
                    db, app_id=setup["app_key"], case_id=check.case_id,
                    row=check.source_row or {}, actor=actor, discovery=run, editor_notes=editor_notes,
                )
        except expert_editor.ExpertEditorReviewError as exc:
            recovery = {"status": "failed", "run_id": run_id, "message": str(exc),
                        "observed_pages": len(run.explored_pages or []),
                        "observed_controls": run.elements_discovered}
            state["_agent_recovery"] = recovery
            agents = dict(state.get("_agents") or {})
            editor = dict(agents.get("expert_editor") or {})
            editor.update(status="failed", message=str(exc))
            agents["expert_editor"] = editor
            state["_agents"] = agents
            check.steps = state
            db.commit()
            return recovery
        if new_id is None:
            recovery = {"status": "failed", "run_id": run_id,
                        "message": "This scan found no new controls to add. The existing journey was not changed.",
                        "observed_pages": len(run.explored_pages or [])}
            state["_agent_recovery"] = recovery
            check.steps = state
            db.commit()
            return recovery
        for old_id in old_ids:
            old = db.get(KbChangeSet, old_id)
            if old and old.status == "draft":
                old.status = "rejected"
                old.decided_at = datetime.utcnow()
                old.decided_by = actor
                old.decision_note = f"Superseded by fresh browser scan and draft #{new_id}."
        agents = dict(state.get("_agents") or {})
        guide = dict(agents.get("navigation_guide") or {})
        guide.update(change_set_ids=[new_id], journey_id=journey_id,
                     message=f"Fresh browser scan prepared draft #{new_id}; {len(unresolved)} step(s) still need a verified control.")
        agents["navigation_guide"] = guide
        editor = dict(agents.get("expert_editor") or {})
        events = list(editor.get("events") or [])
        for note in editor_notes:
            events.append({"at": datetime.utcnow().isoformat(), "status": "working", "message": "Navigation Guide: " + note})
        events.append({"at": datetime.utcnow().isoformat(), "status": "needs_approval", "message": "Reviewed the rescanned controls; the KB draft still needs approval."})
        editor.update(status="needs_approval", message=events[-1]["message"], events=events[-30:])
        agents["expert_editor"] = editor
        state["_agents"] = agents
        state["_agent_plan"] = {"change_set_id": new_id, "journey_id": journey_id,
                                "unresolved": unresolved, "discovery_issue": None}
        recovery = {"status": "prepared", "run_id": run_id, "change_set_id": new_id,
                    "unresolved": unresolved, "observed_pages": len(run.explored_pages or []),
                    "observed_controls": run.elements_discovered,
                    "reused_capture": bool(recovery.get("reused_capture"))}
    state["_agent_recovery"] = recovery
    check.steps = state
    db.commit()
    if recovery["status"] == "prepared":
        agent_approval.decide_if_delegated(db, check)
    return recovery
