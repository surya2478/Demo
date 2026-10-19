"""
--- AI Checks: refine, review, improve and classify before approval ----------

The Test Assistant runs these four steps on freshly generated test cases, so
the manager approves cases that are already improved and triaged, and only
Automation cases reach Automation Lab afterwards:

  1. AI Refine        -- structure the case into atomic steps with action types.
  2. Quality Review   -- score it, with coverage judged against the case as it
                         was generated.
  3. Auto-Improve     -- only when the review did not pass, reusing its
                         findings instead of reviewing again.
  4. KB Diff          -- Journey KB only, no model call: each step compared
                         with the designed journey and the crawled Automation
                         KB (services/journeys/diff.py). Skipped otherwise.
  5. AI Classify      -- rule-based, no model call. Partial and Undecided are
                         saved as Manual: only Automation goes on to the Lab.

Steps 1-3 are judged against the Knowledge Base the author selected on the
Test Assistant (the batch's `knowledge_base`) -- the same context generation
used, from generation.testcases.reference_context, so a case is refined and
reviewed against the KB it was written from. Classify stays on the Automation
KB whatever was selected: whether a case can be automated is a fact about the
running application, not about the design.

Each generated case becomes a draft AutomationTestCase (origin="ai_checks")
plus an AutomationAICheck row holding the original text and the progress of
every step. Progress is in the database, not in memory, so a reload -- or a
restart -- can still say where each case got to. A case that was running when
the process stopped is reported as interrupted and can be retried.

The optional agent workflow also reviews the approved journey, builds a
diagnostic script before browser replay, and compiles the refined case before
hand-off. Model opinions never override host, screen, execution or approval
gates.
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any, Optional
from urllib.parse import urlsplit

from sqlalchemy.orm import Session

from ...config import settings
from ...database.connection import SessionLocal
from ...models.automation import AutomationAICheck, AutomationTestCase
from . import knowledge_base as kb
from . import workbench as wb
from .refine import refine_case_content, refined_to_columns

logger = logging.getLogger(__name__)

# Drafts are refined cases (the table only allows approved/manual/refined as a
# source) marked by their origin, which is what Automation Studio filters on.
ORIGIN = "ai_checks"
STEPS = ("refine", "review", "improve", "diff", "classify")
AGENT_NAMES = ("requirements_guide", "crawl_guide", "navigation_guide", "expert_editor", "evidence_coordinator", "automation", "analysis", "audit", "data_entry", "approval_manager")

# Two cases at a time: roughly halves a batch's wall clock without leaning on
# the model provider's rate limits the way a wider pool would.
CONCURRENCY = 2

MAX_CASES = 100

# Worker threads per batch in this process. A check still "running" in the
# database whose batch has none here was interrupted -- the process that ran it
# is gone -- and is reported as such rather than spinning forever.
_active_workers: dict[str, int] = {}
_active_lock = threading.Lock()


def _enter(batch_id: str) -> None:
    with _active_lock:
        _active_workers[batch_id] = _active_workers.get(batch_id, 0) + 1


# Batches the author asked to stop. Waiting cases are marked stopped at once; a
# case already mid-step finishes that step (a model call cannot be cut off)
# and stops before the next one.
_stop_requested: set[str] = set()


def _stopping(batch_id: str) -> bool:
    with _active_lock:
        return batch_id in _stop_requested


class _Stopped(Exception):
    pass


class _ResumeAnalysis(Exception):
    """Skip completed browser handoffs and continue at the saved QA checkpoint."""
    pass


def _leave(batch_id: str) -> None:
    with _active_lock:
        remaining = _active_workers.get(batch_id, 1) - 1
        if remaining > 0:
            _active_workers[batch_id] = remaining
        else:
            _active_workers.pop(batch_id, None)
            _stop_requested.discard(batch_id)


_TODO = re.compile(r"<<TODO:[^>]*>>")


def _pending_steps() -> dict[str, str]:
    return {name: "pending" for name in STEPS}


# --- Where the case runs ------------------------------------------------------

def _resolve_application(details: dict[str, Any]) -> tuple[Optional[str], Optional[str]]:
    """(application_url, application_name) for a generated case, or (None, None).

    The same rule sync_approved_test_cases applies when a case is mirrored:
    a URL the case names keeps its path and moves onto the host the matched
    Knowledge Base profile registers; a case naming no URL takes the profile's
    base URL; a case matching no application gets no URL at all, rather than
    whichever profile happens to be listed first.
    """
    text = " ".join(
        wb.detail_value(details, field)
        for field in ("preconditions", "steps", "description", "expected", "test_data")
    )
    try:
        flow = kb.match_flow_blueprint(text)
        app_id = (flow.get("_app_id") if flow else None) or kb.identify_app_id(text)
        profile = (kb.load_app_profile(app_id) if app_id else {}) or {}
    except Exception:  # noqa: BLE001 - an unreadable KB means "unknown", not a failed check
        logger.warning("Knowledge Base lookup failed while resolving the application", exc_info=True)
        return None, None

    name = profile.get("app_name") or app_id
    named_url = re.search(r"https?://[^\s'\"\)]+", text)
    if named_url:
        return kb.rehome_to_profile(named_url.group(0).rstrip(".,)"), profile), name
    return (profile.get("base_url") or "").strip() or None, name


def _for_environment(db: Session, url: Optional[str], environment: Optional[str]) -> Optional[str]:
    """The case's address on its environment's host (Test Data), when that environment has one.

    The Knowledge Base resolves a case onto the host it was crawled on; a case
    generated for RC should name RC's host, so a reviewer opening it, and a run
    without an environment of its own, land where the case is for.
    """
    try:
        from .registry import rehome_for_environment

        return rehome_for_environment(db, url, environment)
    except Exception:  # noqa: BLE001 - the crawled host is still a usable address
        logger.warning("Moving %s onto %s's host failed", url, environment, exc_info=True)
        return url


# --- The selected Knowledge Base -------------------------------------------------

def _reference(check: AutomationAICheck) -> dict[str, Any]:
    """The selected KB's context for this case, from its generated text.

    Looked up from the case as generated (source_row), not as refined: the KB
    has to recognise the same text generation grounded on, and a refined case
    that drifted would otherwise lose its reference half-way through.
    """

    row = check.source_row or {}
    text = " ".join(
        wb.detail_value(row, field)
        for field in ("description", "preconditions", "steps", "expected", "test_data")
    )
    try:
        return reference_context(check.knowledge_base, text)
    except Exception:  # noqa: BLE001 - a KB problem downgrades to ungrounded, never fails the check
        logger.warning("Knowledge Base lookup failed for check %s", check.id, exc_info=True)
        return {"knowledge_base": check.knowledge_base, "kind": "none", "context": "", "detail": {}}


def _diff(db: Session, check: AutomationAICheck, case: AutomationTestCase) -> None:
    """Step 4: compare the case with the design journey and the crawled application.

    Automation KB only (Journey KB, its older name, too). Other KBs carry no
    design journey to compare against, and reporting "no journey" on every one
    of their cases would be noise; an Automation KB case no journey recognises
    is skipped below.
    """
    from ..generation.testcases import APPLICATION_KBS

    if (check.knowledge_base or "").strip() not in APPLICATION_KBS:
        case.journey_diff = None
        _set_step(db, check, "diff", "skipped")
        return
    _set_step(db, check, "diff", "running")
    from ..journeys import diff as journey_diff

    steps = [
        {"step_number": s.get("step_number"), "action": s.get("action") or "", "target": s.get("target")}
        for s in (case.steps_structured or [])
        if isinstance(s, dict)
    ]
    text = " ".join(
        [case.description or "", case.objective or "", case.preconditions or ""]
        + [wb.detail_value(check.source_row or {}, "description")]
    )
    agent_state = check.steps or {}
    agent_setup = agent_state.get("_agent_setup") or {}
    matched_journey = ((agent_state.get("_agents") or {}).get("automation") or {}).get("journey_id")
    report = journey_diff.diff_case(
        steps, text,
        app_id=agent_setup.get("app_key") if agent_state.get("_mode") == "agents" else None,
        journey_id=matched_journey if agent_state.get("_mode") == "agents" else None,
    )
    report["compared_at"] = datetime.utcnow().isoformat()
    case.journey_diff = report
    # No journey recognised: nothing was compared, so the step did not run.
    _set_step(db, check, "diff", "done" if report.get("journey_id") else "skipped")


def _diff_brief(report: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    if not report:
        return None
    return {
        "journey_id": report.get("journey_id"),
        "summary": report.get("summary") or {},
        "automatable": report.get("automatable"),
        "reason": report.get("reason"),
    }


# --- Starting a batch -------------------------------------------------------

def start_batch(
    db: Session,
    rows: list[dict[str, Any]],
    *,
    actor: Optional[str],
    knowledge_base: Optional[str] = None,
    project_id: Optional[int] = None,
    environment: Optional[str] = None,
    agent_setup: Optional[dict[str, Any]] = None,
    approval_manager_enabled: bool = False,
    review_request_id: Optional[str] = None,
) -> str:
    """Create a draft case and a check per row, then run the batch in the background."""
    if not rows:
        raise ValueError("There are no test cases to check.")
    if len(rows) > MAX_CASES:
        raise ValueError(f"AI Checks run on up to {MAX_CASES} test cases at a time.")

    batch_id = uuid.uuid4().hex[:16]
    for position, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError("Each test case must be an object of its table columns.")
        display_id = wb.detail_value(row, "display_id") or f"TC-{position + 1:03d}"
        description = wb.detail_value(row, "description") or display_id
        application_url, _ = _resolve_application(row)
        application_url = _for_environment(db, application_url, environment)
        case = AutomationTestCase(
            source="refined",
            origin=ORIGIN,
            display_id=display_id[:100],
            category=wb.detail_value(row, "category") or "General",
            description=description,
            objective=description,
            preconditions=wb.detail_value(row, "preconditions") or None,
            steps_raw=wb.detail_value(row, "steps") or None,
            test_data=wb.detail_value(row, "test_data") or None,
            expected_result=wb.detail_value(row, "expected") or None,
            priority=wb.detail_value(row, "priority") or "Medium",
            application_url=application_url,
            classification=wb.CLASSIFICATION_UNDECIDED,
            approval_status=wb.APPROVAL_DRAFT,
            created_by=actor,
            project_id=project_id,
            environment=(environment or "").strip().upper() or None,
        )
        db.add(case)
        db.flush()
        db.add(
            AutomationAICheck(
                batch_id=batch_id,
                position=position,
                case_id=case.id,
                source_row=row,
                status="queued",
                steps={**_pending_steps(), **({
                    "_mode": "agents",
                    "_agent_setup": agent_setup,
                    "_review_request_id": review_request_id,
                    "_agents": {name: {"status": "waiting", "message": None} for name in AGENT_NAMES},
                    **({"_agent_auto_approval": {"scope": "batch", "requested_by": actor}} if approval_manager_enabled else {}),
                } if agent_setup else {})},
                knowledge_base=(knowledge_base or None),
                requested_by=actor,
            )
        )
    db.commit()
    _launch(batch_id)
    return batch_id


def _launch(batch_id: str, check_ids: Optional[list[int]] = None) -> None:
    from . import check_leases
    owner = check_leases.acquire(batch_id)
    if not owner:
        return
    finished = threading.Event()

    def heartbeat():
        while not finished.wait(30):
            try:
                if check_leases.renew(batch_id, owner):
                    continue
            except Exception:
                logger.exception("AI Checks lost its worker lease for %s", batch_id)
            with _active_lock:
                _stop_requested.add(batch_id)
            return

    def run_owned():
        pulse = threading.Thread(target=heartbeat, daemon=True)
        pulse.start()
        try:
            _run_batch(batch_id, check_ids)
        finally:
            finished.set()
            check_leases.release(batch_id, owner)

    with _active_lock:
        _stop_requested.discard(batch_id)
    thread = threading.Thread(
        target=run_owned,
        daemon=True,
        name=f"ai-checks-{batch_id}",
    )
    _enter(batch_id)
    thread.start()


def _run_batch(batch_id: str, check_ids: Optional[list[int]]) -> None:
    db = SessionLocal()
    try:
        query = db.query(AutomationAICheck.id).filter(
            AutomationAICheck.batch_id == batch_id, AutomationAICheck.status == "queued"
        )
        if check_ids:
            query = query.filter(AutomationAICheck.id.in_(check_ids))
        ids = [row[0] for row in query.order_by(AutomationAICheck.position).all()]
        agent_mode = bool(ids and (db.get(AutomationAICheck, ids[0]).steps or {}).get("_mode") == "agents")
    finally:
        db.close()
    try:
        if agent_mode:
            # A browser walk and KB proposal belong to one application at a
            # time; do not fan out multiple crawls or change sets in parallel.
            for check_id in ids:
                _run_with_recovery(check_id)
                followup = SessionLocal()
                try:
                    current = followup.get(AutomationAICheck, check_id)
                    agents = ((current.steps or {}).get("_agents") or {}) if current else {}
                    if current and current.status == "awaiting_approval" and any(
                        (agents.get(name) or {}).get("status") == "needs_approval"
                        for name in ("navigation_guide", "automation")):
                        continue  # Keep other cases moving; unresolved work is in Human Evaluation.
                finally:
                    followup.close()
        else:
            with ThreadPoolExecutor(max_workers=CONCURRENCY, thread_name_prefix=f"ai-check-{batch_id}") as pool:
                list(pool.map(_run_check, ids))
    finally:
        _leave(batch_id)


# --- One case through the four steps ------------------------------------------

def _run_with_recovery(check_id: int) -> None:
    try:
        _run_recovery_cycles(check_id)
    finally:
        from .evaluation_handoff import handoff
        db = SessionLocal()
        try:
            check = db.get(AutomationAICheck, check_id)
            if check:
                handoff(db, check)
        except Exception:
            db.rollback()
            logger.exception("Could not hand off AI check %s to Human Evaluation", check_id)
        finally:
            db.close()


def _run_recovery_cycles(check_id: int) -> None:
    """Run saved stages and let Expert Editor coordinate at most two repairs."""
    from . import recovery_coordination as recovery
    for cycle in range(3):
        _run_check(check_id)
        db = SessionLocal()
        try:
            check = db.get(AutomationAICheck, check_id)
            if not check or _stopping(check.batch_id):
                return
            state = dict(check.steps or {})
            entry = state.get("_recovery_pending")
            if check.status != "failed" or not entry:
                if entry and ((state.get("_agents") or {}).get(entry["stage"]) or {}).get("status") == "done":
                    history = list(state.get("_recovery_history") or [])
                    if history:
                        history[-1] = {**history[-1], "status": "verified"}
                    state["_recovery_history"] = history
                    state.pop("_recovery_pending", None)
                    check.steps = state
                    db.commit()
                return
            _set_agent(db, check, "expert_editor", "failed" if entry["stage"] == "expert_editor" else "working",
                       f"Coordinating recovery for {entry['stage'].replace('_', ' ')}: {entry['category'].replace('_', ' ')}.")
            try:
                if entry["category"] == "model_contract":
                    advice = recovery.RecoveryAdvice(action="retry_stage", reason="The reviewer returned an incomplete decision list. Retrying the saved mapping checkpoint without repeating the completed browser scan.")
                elif entry["category"] == "provider_configuration":
                    # The same exhausted provider cannot arbitrate its own
                    # quota. Preserve the handoff without another model call.
                    advice = recovery.RecoveryAdvice(action="request_input", reason="Provider quota or configuration needs attention. Retry this agent after it is restored; completed handoffs are retained.")
                else:
                    advice = recovery.decide(entry, should_stop=lambda: _stopping(check.batch_id))
                proceed = recovery.allowed(entry, advice) and cycle < 2
                reason = advice.reason
            except Exception as exc:
                proceed = False
                reason = "Recovery review unavailable; the failed handoff and evidence are retained. " + str(exc)[:200]
            if proceed and advice.action == "refresh_runtime":
                from .preflight import runtime_status
                proceed = all(item.available for item in runtime_status(refresh=True).values())
                if not proceed:
                    reason = "Browser runtime still needs setup. Use Setup & Local Tools, then retry this agent."
            if proceed:
                try:
                    target = entry["stage"]
                    if advice.action == "recapture" and target in {"automation", "expert_editor"}:
                        # A downstream observation goes back to the owner of
                        # page evidence, not into another identical replay.
                        target = "navigation_guide"
                        _set_agent(db, check, target, "failed", "Expert Editor requested fresh evidence: " + entry["reason"])
                    retry_agent_stage(db, check.batch_id, check.id, target, _dispatch=False)
                    if advice.action == "recapture":
                        state = dict(check.steps or {})
                        state["_force_discovery"] = True
                        check.steps = state
                except ValueError as exc:
                    proceed, reason = False, str(exc)
            state = dict(check.steps or {})
            history = list(state.get("_recovery_history") or [])
            if history:
                history[-1] = {**history[-1], "status": "retrying" if proceed else "needs_input", "recommendation": reason}
            state["_recovery_history"] = history
            check.steps = state
            _set_agent(db, check, "expert_editor", "working" if proceed else "failed",
                       (f"Recovery {entry['attempt']}/{1 if advice.action == 'recapture' else 2}: resuming {entry['stage'].replace('_', ' ')}. " if proceed else "Recovery needs attention: ") + reason)
            if not proceed:
                return
        finally:
            db.close()


def _set_step(db: Session, check: AutomationAICheck, name: str, state: str) -> None:
    steps = dict(check.steps or _pending_steps())
    steps[name] = state
    if steps.get("_mode") == "agents":
        agents = dict(steps.get("_agents") or {})
        agent_name = "analysis" if name == "refine" else "audit" if name in ("review", "improve", "diff", "classify") else None
        if agent_name:
            entry = dict(agents.get(agent_name) or {})
            if state == "running":
                entry.update(status="working", message=f"{name.replace('_', ' ').title()} is in progress.")
            elif state == "failed":
                entry.update(status="failed", message=f"{name.replace('_', ' ').title()} failed.")
            elif name == "refine" and state == "done":
                entry.update(status="done", message="Refined the case using the captured page evidence.")
            elif name == "classify" and state == "done":
                entry.update(status="done", message="Reviewed the result and classified the case.")
            if entry.get("message"):
                events = list(entry.get("events") or [])
                if not events or events[-1].get("status") != entry.get("status") or events[-1].get("message") != entry.get("message"):
                    events.append({"at": datetime.utcnow().isoformat(), "status": entry.get("status"), "message": entry.get("message")})
                entry["events"] = events[-30:]
            agents[agent_name] = entry
            steps["_agents"] = agents
    check.steps = steps  # reassigned, so the JSON column is marked dirty
    db.commit()


def _set_agent(db: Session, check: AutomationAICheck, name: str, status: str, message: str,
               **evidence: Any) -> None:
    steps = dict(check.steps or _pending_steps())
    agents = dict(steps.get("_agents") or {})
    previous = dict(agents.get(name) or {})
    events = list(previous.get("events") or [])
    events.append({"at": datetime.utcnow().isoformat(), "status": status, "message": message})
    agents[name] = {**previous, "status": status, "message": message, **evidence, "events": events[-30:]}
    steps["_agents"] = agents
    check.steps = steps
    db.commit()


def _review_agent(db: Session, check: AutomationAICheck, name: str,
                  evidence: dict[str, Any]) -> Any:
    from . import agent_reviews

    def progress(status: str, attempt: int, total: int, message: str) -> None:
        _set_agent(db, check, name, status, f"Attempt {attempt}/{total}: {message}",
                   attempt=attempt, max_attempts=total)

    feedback = [item for item in (check.steps or {}).get("_recovery_history", []) if item.get("stage") == name][-2:]
    if name == "data_entry":
        # Expert Editor retains the repair history. Data Entry judges this
        # capture and proposal; a corrected prior runtime exception is not
        # evidence that today's selector is unsupported.
        feedback = []
    return agent_reviews.review(name, {**evidence, "previous_repair_attempts": feedback}, on_progress=progress,
                                should_stop=lambda: _stopping(check.batch_id))


def _note_profile_selection(db: Session, check: AutomationAICheck, resume_stage: Optional[str]) -> None:
    """A profile correction cannot regress a completed Navigation handoff."""
    _set_agent(db, check, "automation" if resume_stage == "automation" else "navigation_guide", "working",
               "Selected the unique ready Test Data profile matching this case's explicit input values. Browser replay must still verify the result.")


def _settle_active_agents(agents: dict, failed_agent: str) -> dict:
    """A failed handoff ends concurrent work; retain its last observation."""
    result = copy.deepcopy(agents)
    for name, progress in result.items():
        if name != failed_agent and progress.get("status") in {"working", "queued", "retry_wait", "retrying"}:
            progress["status"] = "waiting"
            progress["message"] = f"On hold: {failed_agent.replace('_', ' ')} did not complete its handoff. Saved observations are retained."
    return result


def _fail(db: Session, check: AutomationAICheck, step: str, message: str) -> None:
    db.rollback()
    check = db.get(AutomationAICheck, check.id)
    steps = dict(check.steps or _pending_steps())
    steps[step] = "failed"
    if steps.get("_mode") == "agents":
        agents = dict(steps.get("_agents") or {})
        agent_name = step if step in AGENT_NAMES else "analysis" if step == "refine" else "audit"
        previous = dict(agents.get(agent_name) or {})
        events = list(previous.get("events") or [])
        events.append({"at": datetime.utcnow().isoformat(), "status": "failed", "message": message[:500]})
        agents[agent_name] = {**previous, "status": "failed", "message": message[:500], "events": events[-30:]}
        steps["_agents"] = _settle_active_agents(agents, agent_name)
    check.steps = steps
    check.status = "failed"
    check.error = message[:2000]
    check.finished_at = datetime.utcnow()
    if steps.get("_mode") == "agents":
        from .recovery_coordination import record_failure
        record_failure(check, agent_name, message)
    db.commit()


def _review_data_entry(db: Session, check: AutomationAICheck, crawl: Any, pending: list[int]) -> None:
    from ...models.kb_changes import KbChangeSet
    from . import agent_reviews, agent_approval
    changes = [db.get(KbChangeSet, change_id) for change_id in pending]
    decision = _review_agent(db, check, "data_entry", {
        "crawl_summary": (crawl.result or {}).get("summary"),
        "browser_capture": [{"screen_id": row.get("screen_id"), "element_id": row.get("element_id"),
                             "outcome": row.get("outcome"), "selector": row.get("selector"),
                             "url": row.get("url")}
                            for row in (crawl.result or {}).get("rows", [])[:70] if isinstance(row, dict)],
        "browser_actions": browser_execution_evidence(crawl.plan or {}, crawl.result or {})["steps"],
        "proposals": [agent_approval._review_summary(change) for change in changes if change],
        "evidence_rule": "Each selector must match a unique browser capture on the same application host and screen. Prior repair errors are historical; judge this proposal against the current capture.",
        "test_data_profile_selected": bool(((check.steps or {}).get("_agent_setup") or {}).get("profile_id")),
    })
    if decision.verdict == "hold":
        raise agent_reviews.AgentReviewError(f"Data Entry Expert held the proposal: {decision.reason}")
    _set_agent(db, check, "data_entry", "working", f"AI reviewed the KB proposal: {decision.reason}")


def finish_with_held_kb_update(db: Session, check: AutomationAICheck, reasons: list[str]) -> bool:
    """Finish a fully checked case without publishing a disputed optional KB update.

    A withheld crawl proposal must never be treated as approved evidence for
    automation. The case can still enter Human Evaluation as Manual, with the
    hold visible to the reviewer. Journey proposals are not eligible here:
    they precede browser verification and remain blocked.
    """
    state = dict(check.steps or {})
    agents = dict(state.get("_agents") or {})
    data_agent = dict(agents.get("data_entry") or {})
    if (check.status != "awaiting_approval" or data_agent.get("status") != "needs_approval"
            or state.get("classify") != "done" or not data_agent.get("change_set_ids")):
        return False
    case = db.get(AutomationTestCase, check.case_id)
    if case is None:
        return False
    reason = "; ".join(str(item) for item in reasons if item).strip()[:600]
    explanation = "Knowledge Base publication was held because the proposed browser evidence needs repair. This case is for manual evaluation, not automation."
    case.classification = wb.CLASSIFICATION_MANUAL
    case.classification_reason = explanation + (f" Approval Manager: {reason}" if reason else "")
    findings = dict(case.review_findings or {})
    findings["kb_publication_held"] = {"change_set_ids": list(data_agent["change_set_ids"]), "reason": reason}
    case.review_findings = findings
    check.classification_detail = wb.CLASSIFICATION_MANUAL
    state["_kb_publication_held"] = findings["kb_publication_held"]
    agents["data_entry"] = {**data_agent, "status": "done", "message": "KB update withheld; the checked case can proceed to Human Evaluation as Manual. No KB changes were published."}
    manager = dict(agents.get("approval_manager") or {})
    agents["approval_manager"] = {**manager, "status": "done", "message": "Held the disputed KB update. The checked case can proceed to Human Evaluation as Manual; no KB changes were published."}
    editor = dict(agents.get("expert_editor") or {})
    if editor.get("status") not in ("failed", "done"):
        agents["expert_editor"] = {**editor, "status": "done", "message": "Cross-agent review completed; disputed KB publication was held."}
    state["_agents"] = agents
    check.steps = state
    check.status = "done"
    check.error = None
    check.finished_at = datetime.utcnow()
    db.commit()
    return True


def retry_data_entry(db: Session, batch_id: str, check_id: int) -> dict[str, Any]:
    """Resume only the final KB proposal from its completed browser crawl."""
    from ...models.kb_changes import KbChangeSet, KbCrawlRun
    from ..journeys import crawl_runs
    from . import agent_approval
    check = db.get(AutomationAICheck, check_id)
    if not check or check.batch_id != batch_id:
        raise LookupError("The selected AI check was not found.")
    agents = ((check.steps or {}).get("_agents") or {})
    crawl_id = (agents.get("automation") or {}).get("crawl_id")
    if (check.steps or {}).get("_mode") != "agents" or check.status != "failed" or (agents.get("data_entry") or {}).get("status") != "failed" or not crawl_id:
        raise ValueError("This case has no completed browser capture to resume from.")
    crawl = db.get(KbCrawlRun, crawl_id)
    setup = (check.steps or {}).get("_agent_setup") or {}
    evidence = browser_execution_evidence(crawl.plan or {}, crawl.result or {}) if crawl else None
    if (not crawl or crawl.status != "completed" or crawl.app_id != setup.get("app_key")
            or crawl.application_id != int(setup.get("application_id") or 0)
            or str(crawl.environment or "").upper() != str(setup.get("environment") or "").upper()
            or not evidence or evidence["incomplete"] or evidence["safety_pause"] or not evidence["total"]):
        raise ValueError("The saved browser capture is incomplete or belongs to another application. Retry Automation Expert first.")
    check.status = "running"
    check.error = None
    check.finished_at = None
    db.commit()
    _set_agent(db, check, "data_entry", "working", "Preparing Knowledge Base changes from the saved browser capture.", crawl_id=crawl_id)
    try:
        if not (crawl.automation_change_set_id or crawl.journey_change_set_id):
            crawl_runs.propose(db, crawl_id, actor=check.requested_by)
        db.refresh(crawl)
        pending = [value for value in (crawl.automation_change_set_id, crawl.journey_change_set_id) if value]
        _review_data_entry(db, check, crawl, pending)
        if pending:
            _set_agent(db, check, "data_entry", "needs_approval", "Captured Knowledge Base changes are ready for approval.",
                       change_set_ids=pending, crawl_id=crawl_id)
            check.status = "awaiting_approval"
            check.finished_at = datetime.utcnow()
            db.commit()
            agent_approval.decide_if_delegated(db, check)
        else:
            _set_agent(db, check, "data_entry", "done", "No new Knowledge Base changes were needed.", crawl_id=crawl_id)
            check.status = "done"
            check.finished_at = datetime.utcnow()
            db.commit()
        db.refresh(check)
        still_pending = []
        for change_id in pending:
            change = db.get(KbChangeSet, change_id)
            if change is not None and change.status in ("draft", "conflicted"):
                still_pending.append(change_id)
        return {"status": check.status, "change_set_ids": still_pending}
    except Exception as exc:
        _fail(db, check, "data_entry", str(exc) or exc.__class__.__name__)
        return {"status": "failed", "message": str(exc) or exc.__class__.__name__}


def retry_analysis(db: Session, batch_id: str, check_id: int, *, _dispatch: bool = True) -> None:
    """Retry Analysis and later checks using an already completed browser run."""
    from ...models.kb_changes import KbCrawlRun

    check = _get_check(db, batch_id, check_id)
    agents = ((check.steps or {}).get("_agents") or {})
    crawl_id = (agents.get("automation") or {}).get("crawl_id")
    if (check.status != "failed" or (check.steps or {}).get("_mode") != "agents"
            or (agents.get("analysis") or {}).get("status") != "failed" or not crawl_id):
        raise ValueError("This case has no failed Analysis handoff with a saved browser capture.")
    if _dispatch and _is_active(batch_id):
        raise ValueError("Wait for this check batch to finish its current case before retrying Analysis.")
    crawl = db.get(KbCrawlRun, int(crawl_id))
    setup = (check.steps or {}).get("_agent_setup") or {}
    evidence = browser_execution_evidence(crawl.plan or {}, crawl.result or {}) if crawl else None
    if (not crawl or crawl.status != "completed" or crawl.app_id != setup.get("app_key")
            or crawl.application_id != int(setup.get("application_id") or 0)
            or not evidence or evidence["incomplete"] or evidence["safety_pause"]
            or evidence["total"] == 0):
        raise ValueError("The saved browser capture is incomplete or belongs to another application. Restart the case instead.")
    state = dict(check.steps or {})
    state.update(refine="pending", review="pending", improve="pending",
                 diff="pending", classify="pending")
    state["_agent_resume_analysis"] = {"crawl_id": int(crawl_id)}
    retained = dict(state.get("_agents") or {})
    for name in ("analysis", "audit", "data_entry"):
        agent = dict(retained.get(name) or {})
        agent.update(status="waiting", message="Waiting to resume from the saved browser capture.")
        retained[name] = agent
    state["_agents"] = retained
    check.steps = state
    check.status = "queued"
    check.error = None
    check.finished_at = None
    db.commit()
    if _dispatch:
        _launch(batch_id, [check.id])


def _published_journey_checkpoint(db: Session, check: AutomationAICheck, setup: dict,
                                  plan: dict, kb=None) -> str | None:
    """Exact case-owned published journey, independent of title keyword matching."""
    from ...models.kb_changes import KbChangeSet
    from ..journeys import store

    change_id, journey_id = plan.get("change_set_id"), plan.get("journey_id")
    if not change_id or not journey_id:
        return None
    change = db.get(KbChangeSet, int(change_id))
    if (not change or change.status != "published" or change.app_id != setup.get("app_key")
            or (change.origin or {}).get("ai_check_case_id") != check.case_id):
        return None
    kb = kb or store.load(setup["app_key"])
    return journey_id if kb and journey_id in kb.journeys else None


def retry_agent_stage(db: Session, batch_id: str, check_id: int, stage: str, *, _dispatch: bool = True,
                      _retain_published_plan: bool = False) -> None:
    """Resume a failed handoff without discarding successful upstream work."""
    from ...models.kb_changes import KbCrawlRun
    from ..journeys import store

    if stage == "analysis":
        return retry_analysis(db, batch_id, check_id, _dispatch=_dispatch)
    if stage not in {"requirements_guide", "crawl_guide", "navigation_guide", "expert_editor", "evidence_coordinator", "automation", "audit"}:
        raise ValueError("This agent does not support a queued stage retry.")
    check = _get_check(db, batch_id, check_id)
    state = dict(check.steps or {})
    agents = dict(state.get("_agents") or {})
    stopped_replay = check.status == 'stopped' and stage == 'automation' and (agents.get(stage) or {}).get('status') in {'working', 'queued', 'stopped'}
    if state.get("_mode") != "agents" or (not stopped_replay and (check.status != "failed" or (agents.get(stage) or {}).get("status") != "failed")):
        raise ValueError("The selected agent does not have a failed handoff to retry.")
    if _dispatch and _is_active(batch_id):
        raise ValueError("Wait for this check batch to finish its current case before retrying this agent.")
    setup = state.get("_agent_setup") or {}
    if stage != "requirements_guide":
        if (agents.get("requirements_guide") or {}).get("status") != "done":
            raise ValueError("Requirements Guide has no completed checkpoint. Use the full restart.")
        if not setup.get("app_key") or not setup.get("application_id"):
            raise ValueError("The application checkpoint is missing. Use the full restart.")
    if stage in {"expert_editor", "evidence_coordinator", "automation"}:
        if stage in {"evidence_coordinator", "automation"} and (agents.get("navigation_guide") or {}).get("status") != "done":
            raise ValueError("Navigation Guide has no completed checkpoint. Retry it first.")
        match = store.describe(" ".join(wb.detail_value(check.source_row or {}, key)
                                        for key in ("description", "preconditions", "steps", "expected")), setup["app_key"])
        kb = store.load(setup["app_key"])
        checkpoint = _published_journey_checkpoint(db, check, setup, state.get("_agent_plan") or {}, kb)
        if checkpoint:
            match.update(grounded=True, journey_id=checkpoint)
        if not match.get("grounded") or not kb or match.get("journey_id") not in kb.journeys:
            raise ValueError("The approved journey is unavailable or changed. Retry Navigation Guide first.")
        if stage in {"evidence_coordinator", "automation"} and (agents.get("navigation_guide") or {}).get("journey_id") != match.get("journey_id"):
            raise ValueError("Navigation Guide's approved journey changed. Retry Navigation Guide first.")
    if stage == "audit":
        if (agents.get("analysis") or {}).get("status") != "done":
            raise ValueError("Analysis has no completed checkpoint. Retry Analysis first.")
        crawl_id = (agents.get("automation") or {}).get("crawl_id")
        crawl = db.get(KbCrawlRun, int(crawl_id)) if crawl_id else None
        evidence = browser_execution_evidence(crawl.plan or {}, crawl.result or {}) if crawl else None
        if (not crawl or crawl.status != "completed" or crawl.app_id != setup.get("app_key")
                or crawl.application_id != int(setup.get("application_id") or 0)
                or str(crawl.environment or "").upper() != str(setup.get("environment") or "").upper()
                or not evidence or evidence["incomplete"] or evidence["safety_pause"] or not evidence["total"]):
            raise ValueError("The saved browser capture is incomplete or belongs to another application. Use the full restart.")
        state["_agent_resume_analysis"] = {"crawl_id": crawl.id, "start_at": "review"}
    elif stage != "requirements_guide":
        state["_agent_resume_stage"] = "automation" if stage == "evidence_coordinator" else stage
    else:
        state["_agent_resume_stage"] = "requirements_guide"
    if stage == "requirements_guide" or (stage == "navigation_guide" and not _retain_published_plan):
        state.pop("_agent_plan", None)
    downstream = {
        "requirements_guide": AGENT_NAMES,
        "crawl_guide": ("crawl_guide", "navigation_guide", "expert_editor", "automation", "analysis", "audit", "data_entry"),
        "navigation_guide": ("navigation_guide", "expert_editor", "evidence_coordinator", "automation", "analysis", "audit", "data_entry"),
        "expert_editor": ("expert_editor", "navigation_guide", "evidence_coordinator", "automation", "analysis", "audit", "data_entry"),
        "evidence_coordinator": ("evidence_coordinator", "automation", "analysis", "audit", "data_entry"),
        "automation": ("evidence_coordinator", "automation", "analysis", "audit", "data_entry"),
        "audit": ("audit", "data_entry"),
    }[stage]
    for name in downstream:
        if name == "approval_manager":
            continue
        prior = dict(agents.get(name) or {})
        for stale_key in ("crawl_id", "change_set_ids", "discovery_id", "summary", "readiness", "concerns"):
            prior.pop(stale_key, None)
        prior.update(status="waiting", message=f"Waiting for {stage.replace('_', ' ')} retry.")
        agents[name] = prior
    state["_agents"] = agents
    for step in (("review", "improve", "diff", "classify") if stage == "audit" else STEPS):
        state[step] = "pending"
    check.steps = state
    check.status = "queued"
    check.error = None
    check.finished_at = None
    db.commit()
    if _dispatch:
        _launch(batch_id, [check.id])


def mark_unverified_sent(db: Session, batch_id: str, check_id: int) -> None:
    """Record that the original case was sent without pretending AI Checks passed."""
    check = _get_check(db, batch_id, check_id)
    state = dict(check.steps or {})
    guide = ((state.get("_agents") or {}).get("navigation_guide") or {})
    if (state.get("_mode") != "agents" or check.status != "awaiting_approval"
            or guide.get("status") != "needs_approval" or not (state.get("_agent_decision") or {}).get("held")):
        raise ValueError("This case is not a held, unverified journey proposal.")
    state["_sent_unverified"] = True
    check.steps = state
    db.commit()


def _run_check(check_id: int) -> None:
    """Run one check with the LLM its Knowledge Base generates with."""
    from ..generation.testcases import provider_for_kb
    from .llm import use_provider

    db = SessionLocal()
    try:
        check = db.get(AutomationAICheck, check_id)
        knowledge_base = check.knowledge_base if check else None
        agent_mode = bool(check and (check.steps or {}).get("_mode") == "agents")
    finally:
        db.close()
    # Default KB cases go to AI_CHECKS_DEFAULT_KB_PROVIDER (Azure), not the AI
    # service generation uses: Prompt Shield blocks refine sent through it.
    provider = ((settings.AUTOMATION_LLM_PROVIDER or settings.LLM_PROVIDER or "").strip() if agent_mode
                else provider_for_kb(knowledge_base) or (settings.AI_CHECKS_DEFAULT_KB_PROVIDER or "").strip()) or None
    logger.info("AI Checks: check %s (KB %s) uses provider %s", check_id, knowledge_base or "Default",
                provider or "AUTOMATION_LLM_PROVIDER / LLM_PROVIDER")
    with use_provider(provider):
        if agent_mode:
            _run_agent_check(check_id)
        else:
            _run_check_steps(check_id)


def _unverified_journey_steps(steps: list[dict[str, Any]]) -> list[str]:
    """Include implicit auth and entry actions, not only literal click/fill verbs."""
    missing = []
    for step in steps:
        action = str(step.get("action") or "")
        interactive = re.match(r"\s*(click|tap|enter|fill|type|select|choose|verify|check|look for|sign[ -]?in|log[ -]?in|sign[ -]?out|log[ -]?out|authenticate)", action, re.I)
        navigation = re.match(r"\s*(open|visit|go to|navigate|attempt to navigate)", action, re.I)
        if (interactive and not (step.get("screen_id") and step.get("element_id"))) or (navigation and not step.get("screen_id")):
            missing.append(str(step.get("step_number")))
    return missing


def _recover_automation_gap(db: Session, check: AutomationAICheck, *, setup: dict[str, Any],
                            journey_id: str, row: dict[str, Any], crawl_id: int,
                            address: str, application_id: int) -> tuple[bool, str | None]:
    """One bounded extra discovery, then a reviewed KB draft if evidence changed.

    Never rerun the same browser replay against an unchanged journey or publish
    a guessed locator. The caller handles the no-new-evidence result explicitly.
    """
    from ..journeys import changesets, store
    from . import agent_journey, agent_approval, agent_auth

    previous = (check.steps or {}).get('_live_navigation') or {}
    if previous.get('status') == 'authored':
        from . import live_authoring
        actions = agent_journey.source_steps(row)
        if agent_auth.requires_signed_in_browser(row, actions) or live_authoring.selected_fields(db, setup, actions):
            return False, 'Protected or form actions require their authorized data and cannot be repeated by guest recovery.'
        state = dict(check.steps or {})
        history = list(state.get('_live_recoveries') or [])
        if history:
            return False, 'The bounded live recovery attempt is exhausted; retained evidence requires Human Evaluation.'
        history.append({'crawl_id': crawl_id, 'status': 'working', 'at': datetime.utcnow().isoformat()})
        state['_live_recoveries'] = history
        check.steps = state
        db.commit()  # Reserve before opening a browser, including interrupted attempts.
        def progress(message):
            _set_agent(db, check, 'automation', 'working', message, crawl_id=crawl_id)
        try:
            captured = live_authoring.recover_guest_capture(previous, address, actions,
                agent_journey.source_expected(row), headed=bool(setup.get('headed')),
                should_stop=lambda: _stopping(check.batch_id), on_progress=progress)
            if captured.get('status') != 'authored' or (captured.get('script_verification') or {}).get('status') != 'passed':
                raise ValueError(captured.get('issue') or 'Replacement steps did not pass clean-browser replay')
            bindings, screens = live_authoring.journey_bindings(captured, agent_journey.source_expected(row))
            repair_id, repaired_journey, unresolved = agent_journey.draft_from_case(
                db, app_id=setup['app_key'], case_id=check.case_id, row=row,
                actor=check.requested_by, discovery=None, observed_bindings=bindings,
                observed_screens=screens, authored_capture=captured)
            state = dict(check.steps or {})
            state['_live_navigation'] = {**captured, 'actions': json.dumps(actions, ensure_ascii=False)}
            state['_live_recoveries'] = [{**history[0], 'status': 'verified', 'change_set_id': repair_id}]
            state['_agent_plan'] = {'change_set_id': repair_id, 'journey_id': repaired_journey, 'unresolved': unresolved}
            check.steps = state
            _set_agent(db, check, 'automation', 'needs_approval',
                'Live recovery passed clean replay. Publishing the updated reusable journey through the assigned approval policy before rerunning.',
                crawl_id=crawl_id, change_set_ids=[repair_id])
            check.status = 'awaiting_approval'
            check.error = None
            check.finished_at = datetime.utcnow()
            db.commit()
            agent_approval.decide_if_delegated(db, check)
            return True, None
        except Exception as exc:
            state = dict(check.steps or {})
            state['_live_recoveries'] = [{**history[0], 'status': 'unresolved'}]
            check.steps = state
            db.commit()
            return False, str(exc)

    context = agent_auth.discovery_context(db, setup, row, agent_journey.source_steps(row))
    if agent_auth.requires_signed_in_browser(row, agent_journey.source_steps(row)) and not context["login_journey_id"]:
        return False, "An observed login prerequisite is required before repairing protected-page controls."

    _set_agent(db, check, "automation", "working",
               "An execution or script gap needs evidence. Scanning public pages once more for "
               "uniquely observed controls; a new mapping will need KB approval.", crawl_id=crawl_id)
    discovery, issue = agent_journey.discover(
        db, application_id=application_id, **context,
        environment=setup["environment"], actor=check.requested_by,
        stop_requested=lambda: _stopping(check.batch_id), force=True, max_pages=30,
        headed=bool(setup.get("headed", False)),
        on_progress=lambda run: _set_agent(
            db, check, "automation", "working",
            f"Additional discovery: {run.pages_discovered or 0} pages, "
            f"{run.elements_discovered or 0} controls observed.",
            crawl_id=crawl_id, discovery_id=run.id,
            summary={"pages": run.pages_discovered or 0,
                     "controls": run.elements_discovered or 0,
                     "blockers": len(run.blockers or [])}),
    )
    if _stopping(check.batch_id):
        return False, "Discovery was stopped."
    repair_id = None
    unresolved: list[str] = []
    if discovery:
        journey_kb = store.load(setup["app_key"])
        journey_file = changesets._journey_file(journey_kb, journey_id)
        repair_id, unresolved = agent_journey.repair_published(
            db, app_id=setup["app_key"], journey_id=journey_id,
            journey_file=journey_file, case_id=check.case_id, row=row,
            actor=check.requested_by, discovery=discovery,
        )
    if not repair_id:
        return False, issue or "The extra scan found no new grounded mapping."
    if unresolved and (check.steps or {}).get("_agent_auto_approval"):
        from ...models.kb_changes import KbChangeSet
        proposal = db.get(KbChangeSet, repair_id)
        if proposal and proposal.status == "draft":
            proposal.status = "rejected"
            proposal.decision_note = "Incomplete repair; no new verified handoff is available."
            db.commit()
        return False, "Missing controls remain after discovery: " + "; ".join(unresolved)
    state = dict(check.steps or {})
    state["_agent_plan"] = {"change_set_id": repair_id, "journey_id": journey_id,
                             "unresolved": unresolved, "discovery_issue": issue}
    check.steps = state
    _set_agent(db, check, "automation", "needs_approval",
               f"Additional discovery prepared grounded repair #{repair_id}; "
               f"{len(unresolved)} action(s) remain unresolved. Approve the KB draft, "
               "then check this case again.", crawl_id=crawl_id,
               discovery_id=discovery.id, change_set_ids=[repair_id],
               summary={"pages": discovery.pages_discovered or 0,
                        "controls": discovery.elements_discovered or 0,
                        "blockers": len(discovery.blockers or [])})
    check.status = "awaiting_approval"
    check.error = None
    check.finished_at = datetime.utcnow()
    db.commit()
    agent_approval.decide_if_delegated(db, check)
    return True, None


def browser_execution_evidence(plan: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    """Use executed journey steps, never the separate page-control inventory."""
    items = plan.get("items") or []
    raw_steps = [step for step in result.get("steps") or [] if isinstance(step, dict)]
    by_order = {step.get("order"): step for step in raw_steps if isinstance(step.get("order"), int)}
    steps: list[dict[str, Any]] = []
    incomplete: list[str] = []
    completed = 0
    for order, item in enumerate(items, start=1):
        step = by_order.get(order) or {}
        status = str(step.get("status") or "missing").lower()
        capture = step.get("capture") if isinstance(step.get("capture"), dict) else {}
        expected_screen = item.get("screen_id")
        expected_control = (item.get("element") or {}).get("element_id")
        interactive = item.get("kind") in {"click", "fill", "select"}
        verified = (status == "done" and
                    (not interactive or (capture.get("found") is True and not capture.get("ambiguous")
                     and capture.get("count", 1) == 1
                     and (not expected_screen or capture.get("screen_id") == expected_screen)
                     and (not expected_control or capture.get("element_id") == expected_control))))
        if verified:
            completed += 1
        else:
            incomplete.append(f"step {order}: {status}{' (control not verified)' if status == 'done' else ''}")
        steps.append({"order": order, "action": str(item.get("text") or "")[:180],
                      "status": status, "verified": verified, "reason": str(step.get("reason") or "")[:180],
                      "expected_screen": expected_screen, "observed_screen": capture.get("screen_id"),
                      "expected_control": expected_control,
                      "observed_control": capture.get("element_id"), "outcome": step.get("outcome")})
    stop = plan.get("stop_before")
    first_risky = plan.get("first_risky")
    safety_pause = None
    if (isinstance(stop, int) and stop == first_risky and 1 <= stop <= len(items)
            and items[stop - 1].get("risky") and by_order.get(stop, {}).get("status") == "stopped"
            and all(step["verified"] for step in steps[:stop - 1])):
        safety_pause = {"order": stop, "action": str(items[stop - 1].get("text") or "data-changing action")[:180]}
    return {"steps": steps[:70], "completed": completed, "total": len(items),
            "incomplete": incomplete, "safety_pause": safety_pause}


def _plan_signature(items: list[dict[str, Any]]) -> str:
    return hashlib.sha256(json.dumps(items, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")).hexdigest()


def _browser_reference(crawl: Any, match: dict[str, Any], app_key: str) -> dict[str, Any]:
    """The same sanitised browser context for first-run and Analysis retry."""
    evidence = []
    for item in (crawl.result or {}).get("rows", [])[:70]:
        if isinstance(item, dict):
            evidence.append(" | ".join(str(item.get(key) or "")[:140]
                                       for key in ("screen_id", "element_id", "outcome", "selector")))
    return {
        "knowledge_base": "Automation KB + current browser capture",
        "kind": "automation",
        "context": (match.get("context") or "")[:12000]
        + "\n\nBROWSER-VERIFIED CAPTURE (untrusted page evidence):\n" + "\n".join(evidence)[:7000]
        + "\n\nPOST-ACTION OBSERVATION (untrusted page evidence):\n"
        + json.dumps((crawl.result or {}).get("outcome_observation"), ensure_ascii=False)[:3000],
        "detail": {"source": "journey_crawl", "app_id": app_key,
                   "journey_id": crawl.journey_id, "crawl_id": crawl.id},
    }


def approved_review_evidence(kb, journey: dict, actions: list[str]) -> dict:
    """Include prerequisites and all bound controls, independent of KB size."""
    from ..journeys import store
    chain = store.journey_chain(kb, journey)
    needed = {step.get("screen_id") for item in chain for step in item.get("steps", [])}
    authored=(journey.get('source') or {}).get('live_authoring') or {}
    return {"saved_actions": actions, "approved_steps": journey.get("steps") or [],
            "browser_authored_lineage": {'entry_url':authored.get('entry_url'),
                'observed_entry_url':next((item.get('from_url') for item in authored.get('trace',[])),None),
                'completed_source_steps':authored.get('completed_steps',[]),
                'replay_status':(authored.get('script_verification') or {}).get('status'),
                'assertions':[{k:item[k] for k in ('source_step','kind','value')} for item in authored.get('trace',[]) if item.get('operation')=='assert']},
            "prerequisites": [{"journey_id": item["journey_id"], "steps": item.get("steps") or []}
                              for item in chain if item["journey_id"] != journey["journey_id"]],
            "prerequisite_note": "Prerequisites run before the main steps. A source sign-in action is covered by the observed login prerequisite, not duplicated in the main journey.",
            "screens": [{"id": key, "route": value.get("route"),
                         "elements": [{"id": element.get("element_id"), "label": element.get("label"), "type": element.get("type")}
                                      for element in value.get("elements") or []]}
                        for key, value in kb.screens.items() if key in needed]}


def proposed_review_documents(app_key: str, draft, journey_id: str) -> tuple[dict, list[dict]]:
    """Rebuild review evidence from a change set, whether it creates or repairs a journey."""
    from ..journeys import changesets, store

    kb = store.load(app_key)
    if not kb or not draft:
        raise ValueError("The proposed journey or its Knowledge Base is unavailable for review.")
    journey_files = {change.file for change in draft.changes if change.file.startswith("journeys/")}
    if len(journey_files) != 1:
        raise ValueError("The proposed journey must update exactly one journey file.")
    journey_file = next(iter(journey_files))
    journey = copy.deepcopy(kb.journeys.get(journey_id))
    screens = {"screens": copy.deepcopy(list(kb.screens.values()))}
    for change in draft.changes:
        value = (change.after or {}).get("value")
        if change.file == journey_file:
            journey = changesets.apply(journey, change.op, change.path, copy.deepcopy(value))
        elif change.file == "screens.json":
            screens = changesets.apply(screens, change.op, change.path, copy.deepcopy(value))
    if not isinstance(journey, dict) or journey.get("journey_id") != journey_id:
        raise ValueError("The proposed journey ID changed or its preview is invalid.")
    if not isinstance(screens, dict) or not isinstance(screens.get("screens"), list):
        raise ValueError("The proposed screen catalogue is invalid.")
    return journey, screens["screens"]


def _run_agent_check(check_id: int) -> None:
    """Use a real journey walk before the QA agents; leave KB changes as drafts.

    No journey or missing Test Data is reported as work needed, never animated
    as a successful crawl. Only sanitised capture evidence reaches the model.
    """
    from ..journeys import crawl_runs, store, workspace as journey_workspace
    from . import agent_auth, agent_crawl_guide, agent_evidence, agent_evidence_coordinator, agent_journey, agent_reviews, agent_test_data, expert_editor, automation_readiness
    from . import agent_approval
    from ..generation.testcases import reference_context
    from ...models.kb_changes import KbCrawlRun

    db = SessionLocal()
    editor_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="expert-editor-requirements")
    crawl_id = None
    active_agent = "requirements_guide"
    try:
        check = db.get(AutomationAICheck, check_id)
        if check is None or check.status != "queued":
            return
        requested_resume = (check.steps or {}).get("_agent_resume_stage")
        if requested_resume in {"crawl_guide", "navigation_guide", "expert_editor", "automation"} and (
                ((check.steps or {}).get("_agents") or {}).get("requirements_guide") or {}).get("status") != "done":
            # Old or interrupted state may carry a resume marker without its
            # upstream checkpoint. Rebuild from the first agent so the card
            # and the actual execution order cannot disagree.
            _reset(check)
            db.commit()
        setup = (check.steps or {}).get("_agent_setup") or {}
        reuse_kb_evidence = bool(setup.get("reuse_kb_evidence", True))
        row = check.source_row or {}
        check.status = "running"
        db.commit()
        text = " ".join(wb.detail_value(row, key) for key in ("description", "preconditions", "steps", "expected"))
        plan = (check.steps or {}).get("_agent_plan") or {}
        resume = (check.steps or {}).get("_agent_resume_analysis") or {}
        resume_stage = (check.steps or {}).get("_agent_resume_stage")
        qa_start_at = "refine"
        if resume:
            from ...models.automation import AutomationApplication
            crawl_id = int(resume["crawl_id"])
            crawl = db.get(KbCrawlRun, crawl_id)
            app = db.get(AutomationApplication, int(setup["application_id"]))
            automation_progress = ((check.steps or {}).get("_agents") or {}).get("automation") or {}
            if (not crawl or crawl.status != "completed" or not app
                    or automation_progress.get("crawl_id") != crawl_id
                    or crawl.application_id != app.id or crawl.app_id != setup.get("app_key")
                    or crawl.environment.upper() != str(setup.get("environment") or "").upper()):
                raise ValueError("The saved browser capture no longer matches this case and application. Restart the case to collect new evidence.")
            execution = browser_execution_evidence(crawl.plan or {}, crawl.result or {})
            if execution["safety_pause"] or execution["incomplete"] or execution["total"] == 0:
                raise ValueError("The saved browser capture did not complete every action; Analysis cannot resume from it.")
            match = store.describe(text, setup["app_key"])
            if match.get("journey_id") != crawl.journey_id:
                raise ValueError("The approved journey changed since the browser capture. Restart this case to verify the new journey.")
            current_address = crawl.base_url
            reference = _browser_reference(crawl, match, setup["app_key"])
            if not current_address:
                raise ValueError("The browser capture has no application entry address. Restart this case.")
            state = dict(check.steps or {})
            state.pop("_agent_resume_analysis", None)
            check.steps = state
            qa_start_at = resume.get("start_at") or "refine"
            qa_agent = "audit" if qa_start_at == "review" else "analysis"
            _set_agent(db, check, qa_agent, "queued",
                       f"Resuming {qa_agent.title()} from completed browser replay #{crawl_id}; no browser actions will repeat.",
                       crawl_id=crawl_id)
            raise _ResumeAnalysis()

        def show_navigation_wait(next_attempt: int, total: int) -> None:
            _set_agent(db, check, active_agent, "queued",
                       f"Browser discovery queue is busy; waiting 5s for slot attempt {next_attempt}/{total}.",
                       attempt=next_attempt, max_attempts=total)

        public_scan_counts: dict[str, tuple] = {}

        def show_public_scan(run) -> None:
            from .agent_recovery import _scan_progress
            snapshot = _scan_progress(run)
            counts = (snapshot.get("observed_pages") or run.pages_discovered or 0,
                      snapshot.get("observed_controls") or run.elements_discovered or 0,
                      snapshot.get("blockers") or 0, snapshot.get("phase") or "Scanning")
            if public_scan_counts.get(active_agent) == counts:
                return
            public_scan_counts[active_agent] = counts
            _set_agent(db, check, active_agent, "working",
                       f"Browser scan #{run.id}: {counts[0]}/{snapshot.get('max_pages') or 1} pages, "
                       f"{counts[1]} controls; {counts[3]}.", discovery_id=run.id,
                       summary={"pages": counts[0], "controls": counts[1], "blockers": counts[2],
                                "phase": counts[3], "current_url": snapshot.get("current_url")})

        actions = agent_journey.source_steps(row)
        from . import live_authoring
        focus_terms = agent_journey.crawl_focus_terms(actions)
        def save_live_capture(captured):
            state = dict(check.steps or {})
            state['_live_navigation'] = {**captured, 'actions': json.dumps(actions, ensure_ascii=False)}
            check.steps = state
            db.commit()
            from .registry import address_for_crawl
            address = address_for_crawl(db, setup['app_key'], setup['environment'])
            agent_evidence.record_navigation(setup['app_key'], application_id=int(setup['application_id']),
                environment=setup['environment'], address=address, trace=captured['trace'])
            _set_agent(db, check, active_agent, 'working',
                'Live route observations saved; collecting reusable browser controls.',
                navigation_trace=captured['trace'], capture_issue=captured.get('issue'),
                authoring_status=captured.get('status'), completed_source_steps=captured.get('completed_steps', []),
                script_verification=captured.get('script_verification'))
        if not actions:
            _fail(db, check, "requirements_guide", "The saved case has no action steps to prepare as a journey.")
            return
        if resume_stage not in {"crawl_guide", "navigation_guide", "expert_editor", "automation"}:
            from .registry import address_for_crawl
            from ...models.automation import AutomationApplication
            registered_entry_url = address_for_crawl(db, setup["app_key"], setup["environment"])
            app = db.get(AutomationApplication, int(setup["application_id"]))
            if not app or not registered_entry_url:
                _fail(db, check, "requirements_guide", "Configure the registered application and environment entry URL before browser-backed requirements review.")
                return
            _set_agent(db, check, "requirements_guide", "working", "Checking the registered entry page in a real browser before reviewing actions.")
            public_discovery, public_issue = agent_journey.discover(
                db, application_id=app.id, address=registered_entry_url,
                environment=setup["environment"], actor=check.requested_by,
                stop_requested=lambda: _stopping(check.batch_id), on_wait=show_navigation_wait,
                on_progress=show_public_scan,
                force=bool((check.steps or {}).get("_force_discovery")) or not reuse_kb_evidence,
                max_pages=1, focus_terms=focus_terms,
                headed=bool(setup.get('headed', False)), reuse_kb_evidence=reuse_kb_evidence)
            if not public_discovery:
                _fail(db, check, "requirements_guide", f"Registered entry browser scan could not complete: {public_issue or 'no completed scan'}. Retry this agent after the browser runtime is ready.")
                return
            entry = agent_crawl_guide.entry_evidence(public_discovery, registered_entry_url)
            if not entry["verified"]:
                _fail(db, check, "requirements_guide", "The registered entry page was not observed successfully on the configured host and path. Check the environment URL or browser availability; no requirements decision was made.")
                return
            _set_agent(db, check, "requirements_guide", "working",
                       f"Observed registered entry in browser scan #{public_discovery.id}; reviewing {len(actions)} actions.",
                       discovery_id=public_discovery.id, summary=entry)
            requirements_decision = _review_agent(db, check, "requirements_guide", {
                "case_title": wb.detail_value(row, "description")[:500],
                "preconditions": wb.detail_value(row, "preconditions")[:1000],
                "actions": actions, "expected": agent_journey.source_expected(row),
                "registered_entry_url": registered_entry_url, "entry_observation": entry["entry"],
            })
            agent_evidence.record_finding(
                setup["app_key"], environment=setup["environment"], case_id=check.case_id,
                stage="requirements_guide", run_id=public_discovery.id,
                status=requirements_decision.verdict, action_count=len(actions))
            if requirements_decision.verdict == "hold":
                _fail(db, check, "requirements_guide", f"Requirements Guide held the case: {requirements_decision.reason}")
                return
            _set_agent(db, check, "requirements_guide", "done", f"Browser entry verified; AI reviewed {len(actions)} source actions: {requirements_decision.reason}",
                       discovery_id=public_discovery.id, summary=entry)
        if resume_stage not in {"navigation_guide", "expert_editor", "automation"}:
            active_agent = "crawl_guide"
            from .registry import address_for_crawl
            from ...models.automation import AutomationApplication
            from ..journeys import store as crawl_store
            app = db.get(AutomationApplication, int(setup["application_id"]))
            registered_entry_url = address_for_crawl(db, setup["app_key"], setup["environment"])
            if not app or not registered_entry_url:
                _fail(db, check, "crawl_guide", "The registered application entry URL is unavailable.")
                return
            _set_agent(db, check, "crawl_guide", "working", "Reviewing the public crawl for missing routes and authentication needs.")
            public_discovery, public_issue = agent_journey.discover(
                db, application_id=app.id, address=registered_entry_url,
                environment=setup["environment"], actor=check.requested_by,
                stop_requested=lambda: _stopping(check.batch_id), on_wait=show_navigation_wait,
                on_progress=show_public_scan,
                force=resume_stage == "crawl_guide" or not reuse_kb_evidence, max_pages=12,
                goal_actions=actions,
                authoring_fields=live_authoring.selected_fields(db, setup, actions),
                expected_result=agent_journey.source_expected(row),
                on_navigation=save_live_capture,
                on_navigation_progress=lambda message: _set_agent(db, check, 'crawl_guide', 'working', message),
                focus_terms=focus_terms, headed=bool(setup.get('headed', False)), reuse_kb_evidence=reuse_kb_evidence, additional_urls=setup.get('additional_urls'))
            if not public_discovery:
                _fail(db, check, "crawl_guide", f"Public crawl could not complete: {public_issue or 'no completed scan'}.")
                return
            if not agent_crawl_guide.entry_evidence(public_discovery, registered_entry_url)["verified"]:
                _fail(db, check, "crawl_guide", "The public crawl did not verify the registered entry on the configured host and path.")
                return
            signed_in = agent_auth.requires_signed_in_browser(row, actions)
            login_kb = crawl_store.load(setup["app_key"]) if signed_in else None
            login_plan = agent_auth.observed_login_plan(
                login_kb, base_url=registered_entry_url, profile_id=setup.get("profile_id"),
                environment=setup.get("environment")) if login_kb else None
            guide_packet = agent_crawl_guide.guidance_evidence(
                public_discovery, registered_entry_url, signed_in_required=signed_in,
                login_plan_ready=bool(login_plan), profile_selected=bool(setup.get("profile_id")))
            guide_packet["knowledge_base_context"] = agent_evidence.context(
                setup["app_key"], application_id=app.id, environment=setup["environment"])
            guide_packet["previous_repair_attempts"] = [
                item for item in (check.steps or {}).get("_recovery_history", [])
                if item.get("stage") == "crawl_guide"][-2:]
            def crawl_progress(status, attempt, total, message):
                _set_agent(db, check, "crawl_guide", status, f"Attempt {attempt}/{total}: {message}",
                           discovery_id=public_discovery.id)
            advice = agent_reviews.advise_crawl(
                guide_packet, on_progress=crawl_progress,
                should_stop=lambda: _stopping(check.batch_id))
            if agent_crawl_guide.allowed_recrawl(advice.action, already_retried=False):
                _set_agent(db, check, "crawl_guide", "working", "Crawl Guide requested one wider scan of the same registered address; no URL or controls were invented.")
                wider, issue = agent_journey.discover(
                    db, application_id=app.id, address=registered_entry_url,
                    environment=setup["environment"], actor=check.requested_by,
                    stop_requested=lambda: _stopping(check.batch_id), on_wait=show_navigation_wait,
                    force=True, max_pages=20, focus_terms=focus_terms,
                    headed=bool(setup.get('headed', False)), reuse_kb_evidence=reuse_kb_evidence)
                if not wider:
                    _fail(db, check, "crawl_guide", f"Wider scan could not complete: {issue or 'no completed scan'}.")
                    return
                if not agent_crawl_guide.entry_evidence(wider, registered_entry_url)["verified"]:
                    _fail(db, check, "crawl_guide", "The wider scan did not verify the registered entry on the configured host and path.")
                    return
                public_discovery = wider
                guide_packet = agent_crawl_guide.guidance_evidence(
                    public_discovery, registered_entry_url, signed_in_required=signed_in,
                    login_plan_ready=bool(login_plan), profile_selected=bool(setup.get("profile_id")))
            # A model cannot trigger login for a signed-out login test, or
            # bypass the approved journey/profile gates in Navigation Guide.
            auth_note = (" Signed-in discovery remains gated by an approved observed login plan and Test Data."
                         if signed_in else
                         " Authentication advice was not acted on because this case has no signed-in prerequisite."
                         if advice.action == "authenticate" else "")
            _set_agent(db, check, "crawl_guide", "done",
                       f"{advice.reason} Public scan #{public_discovery.id}: {public_discovery.pages_discovered} pages, {public_discovery.elements_discovered} controls.{auth_note}",
                       discovery_id=public_discovery.id,
                       summary={**agent_crawl_guide.entry_evidence(public_discovery, registered_entry_url),
                                "linked_login_candidates": guide_packet.get("linked_login_candidates", [])})
            agent_evidence.record_finding(
                setup["app_key"], environment=setup["environment"], case_id=check.case_id,
                stage="crawl_guide", run_id=public_discovery.id,
                status="done", action_count=len(actions))
        matching_profile, data_issue = agent_test_data.profile_for_explicit_values(
            db, app_key=setup["app_key"], environment=setup["environment"],
            actions=actions, selected_id=setup.get("profile_id"))
        if data_issue:
            _fail(db, check, "navigation_guide", data_issue)
            return
        if matching_profile and matching_profile != setup.get("profile_id"):
            setup = {**setup, "profile_id": matching_profile}
            state = dict(check.steps or {})
            state["_agent_setup"] = setup
            check.steps = state
            db.commit()
            _note_profile_selection(db, check, resume_stage)
        active_agent = "navigation_guide"
        editor_future = None if resume_stage == "automation" else editor_pool.submit(expert_editor.requirements_note, actions)
        if editor_future:
            _set_agent(db, check, "expert_editor", "working", "Reviewing Requirements Guide actions alongside Navigation Guide discovery.")
        match = store.describe(text, setup.get("app_key"))
        if plan.get("journey_id") and plan.get("change_set_id"):
            checkpoint = _published_journey_checkpoint(db, check, setup, plan)
            if not checkpoint:
                _fail(db, check, "navigation_guide", "The saved journey checkpoint is not published for this case and application. Retry Navigation Guide.")
                return
            match["journey_id"] = checkpoint
            match["grounded"] = True
        if resume_stage == "automation" and not match.get("grounded"):
            raise ValueError("The approved journey changed before Automation Expert could retry. Retry Navigation Guide first.")
        if not match.get("grounded"):
            from ...models.automation import AutomationApplication
            app = db.get(AutomationApplication, int(setup["application_id"]))
            if app is None:
                _fail(db, check, "navigation_guide", "The registered application was not found.")
                return
            authored_before_mapping = (check.steps or {}).get('_live_navigation') or {}
            self_contained_authored = (authored_before_mapping.get('status') == 'authored'
                                      and authored_before_mapping.get('source_actions') == actions)
            signed_in_required = agent_auth.requires_signed_in_browser(row, actions) and not self_contained_authored
            context = agent_auth.discovery_context(db, setup, row, actions)
            login_plan = None
            if signed_in_required:
                login_kb = store.load(setup["app_key"])
                login_plan = agent_auth.observed_login_plan(
                    login_kb, base_url=context["address"], profile_id=setup.get("profile_id"),
                    environment=setup.get("environment")) if login_kb else None
                if not login_plan:
                    from . import auth_bootstrap
                    _set_agent(db, check, "expert_editor", "working", "Requesting public login capture to prepare the missing authentication prerequisite.")
                    public, issue = agent_journey.discover(
                        db, application_id=app.id, address=context["address"], environment=setup["environment"],
                        actor=check.requested_by, force=bool((check.steps or {}).get("_force_discovery")),
                        stop_requested=lambda: _stopping(check.batch_id), on_wait=show_navigation_wait,
                        focus_terms=focus_terms, headed=bool(setup.get('headed', False)), reuse_kb_evidence=reuse_kb_evidence, additional_urls=setup.get('additional_urls'))
                    if not public:
                        _fail(db, check, "navigation_guide", issue or "Public login capture did not complete.")
                        return
                    change_id, login_id = auth_bootstrap.propose(db, setup=setup, check=check, discovery=public)
                    _set_agent(db, check, "navigation_guide", "needs_approval",
                               "Prepared the missing login prerequisite from observed controls. Approval Manager will check it before signed-in discovery.",
                               change_set_ids=[change_id], journey_id=login_id, discovery_id=public.id)
                    check.status = "awaiting_approval"
                    db.commit()
                    agent_approval.decide_if_delegated(db, check)
                    return
            _set_agent(db, check, "navigation_guide", "working", "Checking signed-in pages and controls." if signed_in_required else "Checking public pages and controls.")
            last_scan_counts = (-1, -1)

            def show_discovery_progress(run):
                nonlocal last_scan_counts
                from .agent_recovery import _scan_progress
                snapshot = _scan_progress(run)
                counts = (snapshot.get("observed_pages") or run.pages_discovered or 0,
                          snapshot.get("observed_controls") or run.elements_discovered or 0,
                          snapshot.get("blockers") or 0,
                          snapshot.get("phase"))
                if counts == last_scan_counts:
                    return
                last_scan_counts = counts
                _set_agent(db, check, "navigation_guide", "working",
                           f"Browser scan: {counts[0]} pages, {counts[1]} controls, {counts[2]} blocked routes. {counts[3] or 'Scanning'}.",
                           discovery_id=run.id, summary={"pages": counts[0], "controls": counts[1],
                                                         "blockers": counts[2], "phase": counts[3],
                                                         "current_url": snapshot.get("current_url")})

            reuse_verified_capture = bool(self_contained_authored and reuse_kb_evidence
                and not (check.steps or {}).get('_force_discovery')
                and authored_before_mapping.get('entry_url') == context['address']
                and authored_before_mapping.get('expected_result') == agent_journey.source_expected(row)
                and (authored_before_mapping.get('script_verification') or {}).get('status') == 'passed')
            if reuse_verified_capture:
                live_authoring.verify_saved_replay(authored_before_mapping)
                _set_agent(db, check, 'navigation_guide', 'working',
                           'Reusing the exact browser-verified source steps and clean replay; validating the reusable journey.')
            discovery, issue = agent_journey.discover(
                db, application_id=app.id, address=context["address"],
                environment=setup["environment"], actor=check.requested_by,
                stop_requested=lambda: _stopping(check.batch_id),
                on_progress=show_discovery_progress, on_wait=show_navigation_wait,
                login_journey_id=login_plan["journey_id"] if login_plan else None,
                profile_id=setup.get("profile_id"), force=signed_in_required or bool((check.steps or {}).get("_force_discovery")),
                max_pages=20 if signed_in_required else 12, focus_terms=focus_terms,
                additional_urls=list(dict.fromkeys((setup.get('additional_urls') or []) + (agent_evidence.navigation_routes(
                    setup['app_key'], application_id=app.id, environment=setup['environment'], address=context['address'])
                    if reuse_kb_evidence and not signed_in_required else []))),
                headed=bool(setup.get('headed', False)), reuse_kb_evidence=reuse_kb_evidence,
            ) if not reuse_verified_capture and (not signed_in_required or login_plan) else (None,
                None if reuse_verified_capture else "No unique approved login journey with observed controls was found.")
            if _stopping(check.batch_id):
                _mark_stopped(db, check_id)
                return
            if issue:
                if editor_future:
                    _set_agent(db, check, "expert_editor", "done",
                               editor_future.result() + " Browser discovery could not complete; Navigation Guide needs to resume.")
                _fail(db, check, "navigation_guide",
                      f"Browser discovery could not complete. {issue} "
                      "Retry Navigation Guide from its saved handoff after resolving this issue.")
                return
            # A forced recapture is a one-shot instruction. Keep the completed
            # scan for a model-contract retry instead of paying for another
            # browser crawl when Expert Editor omits a decision.
            if (check.steps or {}).get("_force_discovery"):
                state = dict(check.steps or {})
                state.pop("_force_discovery", None)
                check.steps = state
                db.commit()
            auth_gap = agent_auth.gap_message(
                row=row, actions=actions, discovery=discovery,
                credential_names=agent_auth.credential_names_present(
                    db, setup["app_key"], setup["environment"]),
                environment=setup["environment"],
            )
            if auth_gap and not self_contained_authored:
                if editor_future:
                    _set_agent(db, check, "expert_editor", "done",
                               editor_future.result() + " Authentication prerequisite sent to Navigation Guide.")
                _fail(db, check, "navigation_guide", auth_gap)
                return
            _set_agent(db, check, "expert_editor", "working", editor_future.result())
            mapped_actions = actions
            prerequisites = []
            if signed_in_required and login_plan and discovery and discovery.auth_status == "verified":
                prerequisites = [login_plan["journey_id"]]
                mapped_actions = [action for action in actions if not agent_auth.is_login_shorthand(action)]
            editor_notes: list[str] = []
            # A static link crawl cannot reveal menus or choose a route based
            # on this case's intent. Use one bounded live public session only
            # when the current catalogue cannot map the requested actions.
            # Its output is evidence, never a claim that the test passed.
            if not signed_in_required and discovery:
                _, _, missing = agent_journey.observed_mapping(db, discovery, mapped_actions)
                signature = json.dumps(mapped_actions, ensure_ascii=False)
                prior_capture = (check.steps or {}).get('_live_navigation') or {}
                if prior_capture.get('actions') != signature or (resume_stage == 'navigation_guide' and prior_capture.get('status') != 'authored'):
                    captured = live_authoring.author(
                        context['address'], mapped_actions, headed=bool(setup.get('headed', False)),
                        fields=live_authoring.selected_fields(db, setup, mapped_actions),
                        expected_result=agent_journey.source_expected(row),
                        resume=prior_capture if prior_capture.get('actions') == signature and not live_authoring.selected_fields(db, setup, mapped_actions) else None,
                        on_capture=save_live_capture,
                        should_stop=lambda: _stopping(check.batch_id),
                        on_progress=lambda message: _set_agent(db, check, 'navigation_guide', 'working', message))
                    state = dict(check.steps or {})
                    state['_live_navigation'] = {**captured, 'actions': signature}
                    check.steps = state
                    db.commit()
                    agent_evidence.record_navigation(setup['app_key'], application_id=app.id,
                        environment=setup['environment'], address=context['address'], trace=captured['trace'])
                    _set_agent(db, check, 'navigation_guide', 'working',
                               'Live public route capture finished; validating observed controls before mapping.',
                               navigation_trace=captured['trace'], capture_issue=captured.get('issue'))
                    if _stopping(check.batch_id):
                        _mark_stopped(db, check_id)
                        return
                    known = {p.get('url') for p in (discovery.explored_pages or [])}
                    extra = list(dict.fromkeys(p['url'] for p in captured['pages']
                        if p.get('url') not in known and p.get('status') and 200 <= p['status'] < 400))[:8]
                    if extra:
                        _set_agent(db, check, 'navigation_guide', 'working',
                                   f'Live navigation found {len(extra)} additional pages. Verifying their reusable controls.')
                        enriched, capture_issue = agent_journey.discover(
                            db, application_id=app.id, address=context['address'], environment=setup['environment'],
                            actor=check.requested_by, force=True, max_pages=len(extra)+1,
                            additional_urls=extra, headed=bool(setup.get('headed', False)),
                            stop_requested=lambda: _stopping(check.batch_id), on_progress=show_discovery_progress)
                        if enriched:
                            discovery = enriched
                        elif capture_issue:
                            editor_notes.append('Additional page capture incomplete: ' + capture_issue)
                    editor_notes.append(f"Live navigation observed {len(captured['trace'])} safe transitions. " + (captured.get('issue') or 'Control mapping and test assertions still require verification.'))
            authored = (check.steps or {}).get('_live_navigation') or {}
            observed_bindings = observed_screens = None
            if authored.get('status') == 'authored' and authored.get('source_actions') == mapped_actions:
                if not any(item.get('operation') in ('fill','select') for item in authored.get('trace',[])) and (authored.get('script_verification') or {}).get('status') != 'passed':
                    _set_agent(db, check, 'navigation_guide', 'working', 'Replaying the authored guest journey in a clean browser before approval.')
                    authored['script_verification'] = live_authoring.replay(authored, headed=bool(setup.get('headed',False)))
                    save_live_capture(authored)
                    if (authored['script_verification'].get('status') != 'passed'
                            and not (check.steps or {}).get('_live_recoveries')
                            and not _stopping(check.batch_id)):
                        state = dict(check.steps or {})
                        attempt = {'crawl_id': None, 'status': 'working', 'at': datetime.utcnow().isoformat()}
                        state['_live_recoveries'] = [attempt]
                        check.steps = state
                        db.commit()
                        replacement = live_authoring.recover_guest_capture(
                            authored, context['address'], mapped_actions, agent_journey.source_expected(row),
                            headed=bool(setup.get('headed')), should_stop=lambda: _stopping(check.batch_id),
                            on_progress=lambda message: _set_agent(db, check, 'navigation_guide', 'working', message))
                        passed = (replacement.get('script_verification') or {}).get('status') == 'passed'
                        state = dict(check.steps or {})
                        state['_live_recoveries'] = [{**attempt, 'status': 'verified' if passed else 'unresolved'}]
                        check.steps = state
                        db.commit()
                        if passed:
                            authored = replacement
                            save_live_capture(authored)
                observed_bindings, observed_screens = live_authoring.journey_bindings(authored, agent_journey.source_expected(row))
                editor_notes.append('Source steps were expanded by live browser execution. Each expanded step retains its source_step; the exact sequence and assertions are saved for replay.')
            change_id, journey_id, unresolved = agent_journey.draft_from_case(
                db, app_id=setup["app_key"], case_id=check.case_id,
                row=row, actor=check.requested_by, discovery=discovery, editor_notes=editor_notes,
                actions_override=mapped_actions, prerequisite_journeys=prerequisites,
                observed_bindings=observed_bindings, observed_screens=observed_screens,
                authored_capture=authored if observed_bindings else None,
            )
            from ...models.kb_changes import KbChangeSet
            drafted = db.get(KbChangeSet, change_id)
            proposed_journey, proposed_screens = proposed_review_documents(setup["app_key"], drafted, journey_id)
            used_screen_ids = {step.get("screen_id") for step in (proposed_journey or {}).get("steps") or []}
            try:
                verified_proposal = live_authoring.verify_expanded_journey(
                    proposed_journey, {screen['screen_id']: screen for screen in proposed_screens},
                    mapped_actions, agent_journey.source_expected(row), context['address'])
                navigation_decision = agent_reviews.AgentDecision(verdict='pass', reason=
                    'Expanded actions exactly match the independently replayed browser evidence and source-step lineage.') if verified_proposal else _review_agent(db, check, "navigation_guide", {
                    "actions": mapped_actions,
                    "proposed_steps": [{key: value for key, value in step.items() if key != "expected_result"}
                                       for step in (proposed_journey or {}).get("steps") or []],
                    "verification_scope": "Action mapping only. Expected outcomes remain unverified until Automation executes and asserts them.",
                    "screen_routes": [{"id": screen.get("screen_id"), "route": screen.get("route")}
                                      for screen in proposed_screens if isinstance(screen, dict)
                                      and screen.get("screen_id") in used_screen_ids],
                    "unresolved": unresolved,
                    "browser_pages": discovery.pages_discovered if discovery else 0,
                    "browser_controls": discovery.elements_discovered if discovery else 0,
                    "editor_findings": editor_notes[-12:],
                    "knowledge_base_context": agent_evidence.context(
                        setup["app_key"], application_id=app.id, environment=setup["environment"]),
                })
            except agent_reviews.AgentReviewError:
                if drafted and drafted.status == "draft":
                    drafted.status = "rejected"
                    drafted.decision_note = "Navigation Guide AI review did not complete; restart this case to prepare a fresh draft."
                    db.commit()
                raise
            agent_evidence.record_finding(
                setup["app_key"], environment=setup["environment"], case_id=check.case_id,
                stage="navigation_guide", run_id=discovery.id if discovery else None,
                status=navigation_decision.verdict, action_count=len(mapped_actions),
                unresolved_count=len(unresolved), journey_id=journey_id)
            if navigation_decision.verdict == "hold":
                if drafted and drafted.status == "draft":
                    drafted.status = "rejected"
                    drafted.decision_note = navigation_decision.reason[:300]
                    db.commit()
                _fail(db, check, "navigation_guide", f"Navigation Guide held the proposed mapping: {navigation_decision.reason}")
                return
            _set_agent(db, check, "navigation_guide", "working", f"AI checked the proposed journey: {navigation_decision.reason}")
            for note in editor_notes:
                _set_agent(db, check, "expert_editor", "working", "Navigation Guide: " + note)
            if unresolved and (check.steps or {}).get("_agent_auto_approval"):
                if drafted and drafted.status == "draft":
                    drafted.status = "rejected"
                    drafted.decision_note = "Superseded by evidence recovery; incomplete controls cannot be auto-approved."
                    db.commit()
                _fail(db, check, "navigation_guide", "Missing controls require fresh evidence: " + "; ".join(unresolved))
                return
            state = dict(check.steps or {})
            state["_agent_plan"] = {"change_set_id": change_id, "journey_id": journey_id,
                                     "unresolved": unresolved, "discovery_issue": issue}
            check.steps = state
            _set_agent(db, check, "navigation_guide", "needs_approval",
                       f"Journey draft ready for approval. {len(unresolved)} step(s) still need a verified control."
                       + (f" Public discovery: {issue}" if issue else ""),
                       change_set_ids=[change_id], journey_id=journey_id,
                       discovery_id=discovery.id if discovery else None,
                       summary={"pages": discovery.pages_discovered, "controls": discovery.elements_discovered,
                                "blockers": len(discovery.blockers or [])}
                       if discovery else None)
            check.status = "awaiting_approval"
            _set_agent(db, check, "expert_editor", "needs_approval", "Reviewed the journey proposal; only browser-grounded mappings can be published after your approval.")
            check.error = None
            check.finished_at = datetime.utcnow()
            db.commit()
            agent_approval.decide_if_delegated(db, check)
            return
        if editor_future:
            _set_agent(db, check, "expert_editor", "working", editor_future.result())
            _set_agent(db, check, "expert_editor", "working", "Navigation Guide: checking approved journey steps against the saved screen catalogue.")
        kb = store.load(setup["app_key"])
        journey = kb.journeys.get(match["journey_id"]) if kb else None
        if not journey:
            _fail(db, check, "navigation_guide", "The approved journey could not be loaded. Review its Knowledge Base draft.")
            return
        missing = _unverified_journey_steps(journey.get("steps", []))
        if missing:
            from ...models.automation import AutomationApplication
            from ...models.kb_changes import KbChangeSet
            app = db.get(AutomationApplication, int(setup["application_id"]))
            original = db.get(KbChangeSet, plan["change_set_id"]) if plan.get("change_set_id") else None
            journey_file = next((item.file for item in (original.changes if original else [])
                                 if item.file.startswith("journeys/")), None)
            if not app or not journey_file:
                _fail(db, check, "navigation_guide", "The approved journey needs browser evidence, but its source could not be identified.")
                return
            _set_agent(db, check, "navigation_guide", "working", "Rechecking missing controls against the browser catalogue before replay.")
            context = agent_auth.discovery_context(db, setup, row, actions)
            if agent_auth.requires_signed_in_browser(row, actions) and not context["login_journey_id"]:
                _fail(db, check, "navigation_guide", "An observed login prerequisite is required before repairing protected-page controls.")
                return
            discovery, issue = agent_journey.discover(
                db, application_id=app.id, **context,
                environment=setup["environment"], actor=check.requested_by,
                stop_requested=lambda: _stopping(check.batch_id), on_wait=show_navigation_wait,
            )
            proposal_id = None
            unresolved = []
            editor_notes: list[str] = []
            if discovery:
                proposal_id, unresolved = agent_journey.repair_published(
                    db, app_id=setup["app_key"], journey_id=match["journey_id"],
                    journey_file=journey_file, case_id=check.case_id, row=row,
                    actor=check.requested_by, discovery=discovery, editor_notes=editor_notes,
                )
            if not proposal_id and not _stopping(check.batch_id):
                discovery, issue = agent_journey.discover(
                    db, application_id=app.id, **context,
                    environment=setup["environment"], actor=check.requested_by,
                    stop_requested=lambda: _stopping(check.batch_id), on_wait=show_navigation_wait,
                    force=True, max_pages=30,
                )
                if discovery:
                    proposal_id, unresolved = agent_journey.repair_published(
                        db, app_id=setup["app_key"], journey_id=match["journey_id"],
                        journey_file=journey_file, case_id=check.case_id, row=row,
                        actor=check.requested_by, discovery=discovery, editor_notes=editor_notes,
                    )
            for note in editor_notes:
                _set_agent(db, check, "expert_editor", "working", "Navigation Guide: " + note)
            if _stopping(check.batch_id):
                _mark_stopped(db, check_id)
                return
            if proposal_id:
                repair = db.get(KbChangeSet, proposal_id)
                try:
                    navigation_decision = _review_agent(db, check, "navigation_guide", {
                        "saved_actions": actions, "unresolved": unresolved,
                        "browser_pages": discovery.pages_discovered if discovery else 0,
                        "browser_controls": discovery.elements_discovered if discovery else 0,
                        "editor_findings": editor_notes[-12:],
                    })
                except agent_reviews.AgentReviewError:
                    if repair and repair.status == "draft":
                        repair.status = "rejected"
                        repair.decision_note = "Navigation Guide AI review did not complete; retry this case to prepare a fresh repair."
                        db.commit()
                    raise
                if navigation_decision.verdict == "hold":
                    if repair and repair.status == "draft":
                        repair.status = "rejected"
                        repair.decision_note = navigation_decision.reason[:300]
                        db.commit()
                    _fail(db, check, "navigation_guide", f"Navigation Guide held the repair: {navigation_decision.reason}")
                    return
                _set_agent(db, check, "navigation_guide", "working", f"AI reviewed the repair draft: {navigation_decision.reason}")
                state = dict(check.steps or {})
                state["_agent_plan"] = {"change_set_id": proposal_id, "journey_id": match["journey_id"],
                                         "unresolved": unresolved, "discovery_issue": issue}
                check.steps = state
                _set_agent(db, check, "navigation_guide", "needs_approval",
                           f"Browser-verified repair #{proposal_id} is ready. {len(unresolved)} step(s) still need a control.",
                           change_set_ids=[proposal_id], journey_id=match["journey_id"])
                check.status = "awaiting_approval"
                _set_agent(db, check, "expert_editor", "needs_approval", "Reviewed the browser-verified repair; your KB approval is still required.")
                check.error = None
                check.finished_at = datetime.utcnow()
                db.commit()
                agent_approval.decide_if_delegated(db, check)
                return
            _fail(db, check, "navigation_guide", "The browser scan could not identify controls for journey steps "
                  + ", ".join(missing) + (f". Scan detail: {issue}" if issue else ". Check the source page or capture these controls manually."))
            return
        active_agent = "expert_editor"
        review_evidence = approved_review_evidence(kb, journey, actions)
        from .registry import address_for_crawl
        verified_expansion = live_authoring.verify_expanded_journey(journey, kb.screens, actions,
            agent_journey.source_expected(row), address_for_crawl(db, setup['app_key'], setup['environment']))
        expansion_decision = agent_reviews.AgentDecision(verdict='pass',reason='Expanded actions retain every source-step link and exactly match the independently replayed browser controls and assertions.') if verified_expansion else None
        approved_editor_decision = None if resume_stage == "automation" else expansion_decision or _review_agent(db, check, "expert_editor", review_evidence)
        if approved_editor_decision and approved_editor_decision.verdict == "hold":
            _fail(db, check, "expert_editor", f"Expert Editor held the approved journey: {approved_editor_decision.reason}")
            return
        if approved_editor_decision:
            _set_agent(db, check, "expert_editor", "working", f"AI cross-checked the approved journey: {approved_editor_decision.reason}")
        active_agent = "navigation_guide"
        navigation_decision = None if resume_stage == "automation" else expansion_decision or _review_agent(db, check, "navigation_guide", review_evidence)
        if navigation_decision and navigation_decision.verdict == "hold":
            _fail(db, check, "navigation_guide", f"Navigation Guide held the approved journey: {navigation_decision.reason}")
            return
        if navigation_decision:
            _set_agent(db, check, "navigation_guide", "done", f"AI reviewed the approved journey: {navigation_decision.reason}", journey_id=match["journey_id"])
        coverage = journey_workspace.test_data_coverage(kb, db) if kb else {"profiles": []}
        profile_id = setup.get("profile_id")
        if profile_id:
            profile = next((p for p in coverage["profiles"] if p["profile_id"] == profile_id), None)
            if profile is None:
                _fail(db, check, "automation", f"Test Data profile {profile_id} is not defined for this application.")
                return
            if profile.get("kind") == "external":
                _fail(db, check, "automation", "This journey needs an external sign-in. Complete its supported login setup before an unattended crawl.")
                return
            cell = (profile.get("cells") or {}).get(setup["environment"].upper())
            if not cell or cell.get("status") != "ready":
                missing = ", ".join((cell or {}).get("missing") or ["values for this environment"])
                _fail(db, check, "automation", f"Test Data is incomplete: {missing}. Add it to the selected profile before crawling.")
                return
        if _stopping(check.batch_id):
            _mark_stopped(db, check_id)
            return
        active_agent = "automation"
        editor_journey_future = editor_pool.submit(expert_editor.inspect_journey, copy.deepcopy(journey), copy.deepcopy(kb.screens))
        from ...models.automation import AutomationApplication
        from .registry import address_for_crawl
        app = db.get(AutomationApplication, int(setup["application_id"]))
        current_address = (address_for_crawl(db, setup["app_key"], setup["environment"])
                           or (app.base_url if app else "") or "").strip()
        if not current_address:
            _fail(db, check, "automation", "No application entry address is configured for this environment.")
            return
        diagnostic_plan = crawl_runs._plan(kb, match["journey_id"], base_url=current_address,
                                           profile_id=setup.get("profile_id"), stop_before=None,
                                           allow_risky=False, environment=setup.get("environment"))
        readiness = automation_readiness.assess_plan(diagnostic_plan)
        _set_agent(db, check, "automation", "working",
                   f"Script preflight: {readiness['planned_steps']} planned actions; "
                   f"{len(readiness['browser_verification_steps'])} controls require live verification; "
                   f"{len(readiness['issues'])} blocking issue(s).",
                   readiness=readiness, journey_id=match["journey_id"])
        if not readiness["ready"]:
            _fail(db, check, "automation", "Automation Expert cannot run this handoff yet: "
                  + "; ".join(readiness["issues"][:5])
                  + " Repair the journey mapping or Test Data, then restart this case.")
            return
        preflight_packet = {
            "case_title": wb.detail_value(row, "description")[:500],
            "expected_result": agent_journey.source_expected(row),
            "actions": actions,
            "plan": [{"order": order, "step": item.get("step_number"), "action": item.get("text"),
                      "kind": item.get("kind"), "screen_id": item.get("screen_id"),
                      "element_id": (item.get("element") or {}).get("element_id"),
                      "has_data": bool(item.get("variable")), "risky": item.get("risky"),
                      "execution_status": "not_started"}
                     for order, item in enumerate(diagnostic_plan.get("items") or [], start=1)],
            "readiness": readiness,
            "phase": "before_browser_replay",
            "browser_actions_executed": 0,
            "post_execution_observation_available": False,
            "outcome_verification": "The browser runtime captures the final URL and visible alerts, headings, and controls after all actions. Automation Expert evaluates the expected result from that observation; no separate assertion action is required.",
        }
        active_agent = "evidence_coordinator"
        _set_agent(db, check, "evidence_coordinator", "working",
                   "Checking whether any preflight objection needs evidence now or only after browser replay.")
        try:
            preflight_decision = agent_reviews.review("automation_preflight", preflight_packet,
                on_progress=lambda status, attempt, total, message: _set_agent(
                    db, check, "evidence_coordinator", status,
                    f"Script preflight {attempt}/{total}: {message}",
                    attempt=attempt, max_attempts=total),
                should_stop=lambda: _stopping(check.batch_id))
        except agent_reviews.AgentReviewError as exc:
            if _stopping(check.batch_id):
                _mark_stopped(db, check_id)
                return
            preflight_decision = None
            _set_agent(db, check, "evidence_coordinator", "done",
                       f"AI preflight review was unavailable ({str(exc)[:160]}). Deterministic script, host, screen and Test Data gates passed; browser replay will verify the outcome.")
        if preflight_decision and preflight_decision.verdict == "hold":
            try:
                triage = agent_evidence_coordinator.triage(
                    preflight_decision.reason, preflight_packet,
                    on_progress=lambda status, attempt, total, message: _set_agent(
                        db, check, "evidence_coordinator", status,
                        f"Evidence triage {attempt}/{total}: {message}",
                        attempt=attempt, max_attempts=total),
                    should_stop=lambda: _stopping(check.batch_id))
            except agent_reviews.AgentReviewError as exc:
                if _stopping(check.batch_id):
                    _mark_stopped(db, check_id)
                    return
                triage = None
                _set_agent(db, check, "evidence_coordinator", "working",
                           f"Second AI opinion unavailable ({str(exc)[:160]}). Browser replay remains the source of final outcome evidence.")
            if triage and agent_evidence_coordinator.actionable_pre_execution(
                    triage, preflight_packet["plan"], readiness):
                _fail(db, check, "evidence_coordinator",
                      f"A pre-execution handoff gap needs repair before replay: {triage.reason}")
                return
            _set_agent(db, check, "evidence_coordinator", "done",
                       f"Preflight objection classified as {triage.phase.replace('_', ' ') if triage else 'unconfirmed'}: "
                       f"{triage.reason if triage else preflight_decision.reason} "
                       "The ready script may run; only browser replay can confirm its final outcome.")
        elif preflight_decision:
            _set_agent(db, check, "evidence_coordinator", "done",
                       f"Preflight evidence is complete for browser replay: {preflight_decision.reason}")
        active_agent = "automation"
        _set_agent(db, check, "automation", "working",
                   "Executable handoff passed deterministic readiness and evidence coordination. "
                   "Starting browser verification; data-changing actions still require your approval.",
                   readiness=readiness)
        risk_approval = setup.get("allow_risky_once")
        allow_risky_once = (isinstance(risk_approval, dict)
                            and risk_approval.get("journey_id") == match["journey_id"]
                            and risk_approval.get("app_key") == setup["app_key"])
        if allow_risky_once:
            allow_risky_once = (current_address == risk_approval.get("base_url")
                                and _plan_signature(diagnostic_plan.get("items") or []) == risk_approval.get("plan_signature"))
        if risk_approval and not allow_risky_once:
            _fail(db, check, "automation", "The approved browser journey changed. Review the new journey in a safe replay before allowing data-changing actions.")
            return
        if allow_risky_once:
            state = dict(check.steps or {})
            stored_setup = dict(state.get("_agent_setup") or {})
            stored_setup.pop("allow_risky_once", None)
            state["_agent_setup"] = stored_setup
            check.steps = state
            db.commit()
        for browser_attempt in range(1, 7):
            if _stopping(check.batch_id):
                _mark_stopped(db, check_id)
                return
            try:
                crawl = crawl_runs.start(
                    db, app_id=setup["app_key"], journey_id=match["journey_id"],
                    application_id=int(setup["application_id"]), profile_id=setup.get("profile_id"),
                    environment=setup["environment"], actor=check.requested_by,
                    stop_before=None, allow_risky=allow_risky_once, headed=bool(setup.get('headed', False)),
                )
                break
            except crawl_runs.Unavailable as exc:
                if exc.status_code != 429 or browser_attempt == 6:
                    raise
                _set_agent(db, check, "automation", "queued",
                           f"Browser queue is busy; waiting 5s to try slot {browser_attempt + 1}/6.",
                           attempt=browser_attempt, max_attempts=6)
                time.sleep(5)
        crawl_id = crawl.id
        _set_agent(db, check, "automation", "working", "Browser crawl is running safely.", crawl_id=crawl_id,
                   journey_id=match["journey_id"])
        deadline = time.monotonic() + 900
        last_crawl_progress = None
        while time.monotonic() < deadline:
            if _stopping(check.batch_id):
                from ..automation.job_manager import job_manager
                if crawl.run_key:
                    job_manager.cancel(crawl.run_key)
                _mark_stopped(db, check_id)
                return
            db.expire_all()
            crawl = db.get(KbCrawlRun, crawl_id)
            crawl_runs.absorb(db, crawl)
            if crawl.status == "running":
                live = crawl_runs.live(db, crawl)
                completed = sum(str(item.get("status") or item.get("outcome") or "").lower()
                                in {"done", "found", "confirmed", "matched", "completed"}
                                for item in live.get("steps") or [] if isinstance(item, dict))
                progress_key = (completed, live.get("current"), live.get("phase"))
                if progress_key != last_crawl_progress:
                    last_crawl_progress = progress_key
                    _set_agent(db, check, "automation", "working",
                               f"Browser replay: {completed}/{live.get('total') or len(actions)} steps completed. "
                               f"{live.get('phase') or 'Running'}.", crawl_id=crawl_id,
                               summary={"completed": completed, "total": live.get("total") or len(actions),
                                        "current": live.get("current"), "phase": live.get("phase")})
            if crawl.status in ("completed", "failed", "cancelled"):
                break
            time.sleep(2)
        else:
            if crawl.run_key:
                from ..automation.job_manager import job_manager
                job_manager.cancel(crawl.run_key)
            _fail(db, check, "automation", "The browser crawl did not finish within 15 minutes.")
            return
        if crawl.status != "completed":
            if crawl.status == 'failed' and not _stopping(check.batch_id):
                repaired, recovery_issue = _recover_automation_gap(
                    db, check, setup=setup, journey_id=match['journey_id'], row=row,
                    crawl_id=crawl_id, address=current_address, application_id=app.id)
                if repaired:
                    return
                _fail(db, check, 'automation', f'{crawl.error or "Browser replay failed"}. Live recovery: {recovery_issue}')
                return
            _fail(db, check, "automation", crawl.error or f"Browser crawl {crawl.status}.")
            return
        execution = browser_execution_evidence(crawl.plan or {}, crawl.result or {})
        if execution["safety_pause"]:
            pause = execution["safety_pause"]
            state = dict(check.steps or {})
            state["_safety_pause"] = {"crawl_id": crawl_id, "step_order": pause["order"],
                                      "journey_id": crawl.journey_id, "app_key": crawl.app_id}
            check.steps = state
            db.commit()
            _fail(db, check, "automation",
                  f"Browser replay paused safely before step {pause['order']} ({pause['action']}). "
                  f"{execution['completed']}/{execution['total']} steps ran; the submit/change action did not run. "
                  "Review this action and choose Continue browser replay to allow data-changing steps, "
                  "or keep it stopped. A normal retry remains a safe dry run.")
            return
        if execution["incomplete"]:
            repaired, discovery_issue = _recover_automation_gap(
                db, check, setup=setup, journey_id=match["journey_id"],
                row=row, crawl_id=crawl_id, address=current_address,
                application_id=app.id)
            if _stopping(check.batch_id):
                _mark_stopped(db, check_id)
                return
            if repaired:
                return
            _fail(db, check, "automation", "Browser replay did not complete every planned action: "
                  + "; ".join(execution["incomplete"][:5])
                  + f". Additional discovery found no verified repair: {discovery_issue} "
                  "Capture the unresolved control manually if it is not on a public page.")
            return
        observation = (crawl.result or {}).get("outcome_observation")
        observed_url = observation.get("url") if isinstance(observation, dict) else None
        if (not observed_url or not isinstance(observation.get("alerts"), list)
                or not isinstance(observation.get("headings"), list)
                or not isinstance(observation.get("controls"), list)
                or urlsplit(observed_url).netloc != urlsplit(current_address).netloc):
            _fail(db, check, "automation", "Browser replay completed its actions, but the final page outcome was not safely observed on the application host. Retry Automation Expert to collect the result.")
            return
        automation_decision = _review_agent(db, check, "automation", {
            "actions": actions, "case_title": wb.detail_value(row, "description")[:500],
            "expected_result": agent_journey.source_expected(row),
            "final_observation": observation,
            "crawl_summary": (crawl.result or {}).get("summary"),
            "browser_steps": execution["steps"],
        })
        if automation_decision.verdict == "hold":
            _fail(db, check, "automation", f"Automation Expert held the browser run: {automation_decision.reason}")
            return
        _set_agent(db, check, "automation", "done", f"Browser capture reviewed by AI: {automation_decision.reason}", crawl_id=crawl_id,
                   journey_id=match["journey_id"],
                   summary={**((crawl.result or {}).get("summary") or {}),
                            "completed": execution["completed"], "total": execution["total"],
                            "phase": "complete"})
        try:
            editor_journey_note = editor_journey_future.result()
        except Exception as exc:
            editor_journey_note = f"Automation Expert: independent binding review was unavailable ({exc.__class__.__name__}); browser evidence remains authoritative."
        _set_agent(db, check, "expert_editor", "working", editor_journey_note,
                   concerns="held concerns" in editor_journey_note)
        capture_rows = [item for item in (crawl.result or {}).get("rows", []) if isinstance(item, dict)]
        confirmed = sum(item.get("outcome") in {"found", "confirmed", "matched"} for item in capture_rows)
        _set_agent(db, check, "expert_editor", "working",
                   f"Automation Expert: reviewed {len(capture_rows)} captured step(s); {confirmed} explicitly confirmed by browser evidence. Unconfirmed steps remain visible to Audit Expert.")
        case = db.get(AutomationTestCase, check.case_id)
        if case is not None:
            case.application_url = crawl.base_url
            db.commit()
        reference = _browser_reference(crawl, match, setup["app_key"])
        check.knowledge_base = "Automation KB"
        if resume_stage:
            state = dict(check.steps or {})
            state.pop("_agent_resume_stage", None)
            check.steps = state
        db.commit()
    except _ResumeAnalysis:
        pass
    except Exception as exc:  # noqa: BLE001
        logger.warning("Agent workflow could not finish case %s", check_id, exc_info=True)
        check = db.get(AutomationAICheck, check_id)
        if check is not None:
            if _stopping(check.batch_id):
                _mark_stopped(db, check_id)
                return
            _fail(db, check, "expert_editor" if isinstance(exc, expert_editor.ExpertEditorReviewError)
                  else active_agent, str(exc) or exc.__class__.__name__)
        return
    finally:
        db.close()
        editor_pool.shutdown(wait=False, cancel_futures=True)

    _run_check_steps(check_id, reference_override=reference, start_at=qa_start_at)

    db = SessionLocal()
    try:
        check = db.get(AutomationAICheck, check_id)
        if check is None or check.status != "running" or (check.steps or {}).get("classify") != "done":
            return
        case = db.get(AutomationTestCase, check.case_id)
        crawl = db.get(KbCrawlRun, crawl_id)
        from .compiler import compile_playwright
        observed_catalog = [
            {"page_url": item.get("url"), "recommended_locator": item.get("selector"),
             "accessible_name": item.get("app_label") or item.get("design_label"),
             "element_name": item.get("element_id"), "role": item.get("type")}
            for item in (crawl.result or {}).get("rows", [])
            if isinstance(item, dict) and item.get("outcome") in {"confirmed", "new", "healed"}
            and item.get("selector") and item.get("url") and not item.get("ambiguous")
            and not item.get("data_dependent")
        ]
        try:
            script = compile_playwright(case, base_url=crawl.base_url, catalog=observed_catalog,
                                        outcome_observation=(crawl.result or {}).get("outcome_observation"))
        except Exception as exc:
            _fail(db, check, "automation", "Final Playwright script could not be compiled: "
                  f"{exc.__class__.__name__}: {exc}")
            return
        code_errors = [issue.message for issue in script.issues if issue.level == "error"]
        if code_errors or script.unresolved:
            gaps = code_errors + [f"Step {item.get('step_number')}: {item.get('reason')}"
                                  for item in script.unresolved]
            if script.unresolved and not code_errors:
                repaired, discovery_issue = _recover_automation_gap(
                    db, check, setup=setup, journey_id=match["journey_id"],
                    row=row, crawl_id=crawl_id, address=current_address,
                    application_id=int(setup["application_id"]))
                if _stopping(check.batch_id):
                    _mark_stopped(db, check_id)
                    return
                if repaired:
                    return
                gaps.append(f"Extra discovery: {discovery_issue}")
            _fail(db, check, "automation", "Final Playwright script is not ready: "
                  + "; ".join(gaps[:5])
                  + ". Review the captured controls and restart this case after repair.")
            return
        _set_agent(db, check, "automation", "done",
                   f"Final Playwright script compiled from the refined case: {script.step_count} steps, "
                   f"{len(observed_catalog)} unique browser-observed controls, no unresolved locators. "
                   "This is a static check, not a separate device run.",
                   crawl_id=crawl_id)
        _set_agent(db, check, "expert_editor", "working", "Analysis Expert and Audit Expert: checked the refined case and quality result against the browser capture.")
        _set_agent(db, check, "data_entry", "working", "Checking Test Data and preparing audited Knowledge Base changes.")
        try:
            crawl_runs.propose(db, crawl_id, actor=check.requested_by)
            db.refresh(crawl)
        except Exception as exc:  # noqa: BLE001 - no new selectors is a valid outcome
            if "nothing" not in str(exc).lower() and "already proposed" not in str(exc).lower():
                raise
        pending = [value for value in (crawl.automation_change_set_id, crawl.journey_change_set_id) if value]
        _review_data_entry(db, check, crawl, pending)
        if pending:
            _set_agent(db, check, "data_entry", "needs_approval", "Captured KB updates are prepared for your approval.",
                       change_set_ids=pending, crawl_id=crawl_id)
            check.status = "awaiting_approval"
            _set_agent(db, check, "expert_editor", "needs_approval", "Data Entry Expert: reviewed proposed KB updates; publication still needs your approval.")
            check.error = None
            check.finished_at = datetime.utcnow()
            db.commit()
            agent_approval.decide_if_delegated(db, check)
            return
        _set_agent(db, check, "data_entry", "done", "No KB changes were needed; selected Test Data was verified.", crawl_id=crawl_id)
        _set_agent(db, check, "expert_editor", "done", "Completed cross-agent review of requirements, navigation, browser capture, quality and KB preparation.")
        check.status = "done"
        check.finished_at = datetime.utcnow()
        db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Data Entry Expert could not prepare case %s", check_id, exc_info=True)
        check = db.get(AutomationAICheck, check_id)
        if check is not None:
            _fail(db, check, "data_entry", str(exc) or exc.__class__.__name__)
    finally:
        db.close()


def _run_check_steps(check_id: int, *, reference_override: Optional[dict[str, Any]] = None,
                     start_at: str = "refine") -> None:
    db = SessionLocal()
    step = "refine"
    try:
        check = db.get(AutomationAICheck, check_id)
        case = db.get(AutomationTestCase, check.case_id) if check else None
        if check is None or case is None or not (
                check.status == "queued" or
                (check.status == "running" and reference_override is not None
                 and (check.steps or {}).get("_mode") == "agents")):
            return  # deleted, or stopped while it waited
        if _stopping(check.batch_id):
            raise _Stopped()
        check.status = "running"
        check.error = None
        db.commit()

        # 1. AI Refine -- without its own review and classify: those are steps
        # 2 and 4 here, and running them inside refine would do both twice.
        row = check.source_row or {}
        application_url, application_name = _resolve_application(row)
        if (check.steps or {}).get("_mode") == "agents":
            application_url = case.application_url
        else:
            application_url = _for_environment(db, application_url, case.environment)
        reference = reference_override if reference_override is not None else _reference(check)
        agent_mode = (check.steps or {}).get("_mode") == "agents"
        from . import agent_reviews

        def queued_stage(agent_name: str, operation: Any) -> Any:
            if not agent_mode:
                return operation()

            def progress(status: str, attempt: int, total: int, message: str) -> None:
                _set_agent(db, check, agent_name, status, f"Attempt {attempt}/{total}: {message}",
                           attempt=attempt, max_attempts=total)

            return agent_reviews.run_queued(agent_name, operation, on_progress=progress,
                                            should_stop=lambda: _stopping(check.batch_id))

        if start_at == "refine":
            _set_step(db, check, step, "running")
            refined = queued_stage("analysis", lambda: refine_case_content(
                ref=f"check-{check.id}", title=case.display_id, existing=row,
                application_url=application_url, application_name=application_name,
                reference=reference,
            ))
            columns = refined_to_columns(refined)
            columns["display_id"] = case.display_id  # the generated id is authoritative
            for field_name, value in columns.items():
                setattr(case, field_name, value)
            case.objective = refined.objective
            case.bdd_scenario = refined.bdd_scenario
            case.priority = refined.priority or case.priority or "Medium"
            case.test_type = refined.test_type
            case.test_data_required = bool(refined.test_data_required)
            case.test_data_notes = refined.test_data_notes
            case.application_url = application_url
            _set_step(db, check, step, "done")
        elif start_at != "review" or (check.steps or {}).get("refine") != "done":
            raise ValueError("The completed Analysis checkpoint is missing; Audit cannot resume.")

        # 2. Quality Review, coverage against the generated text.
        if _stopping(check.batch_id):
            raise _Stopped()
        step = "review"
        _set_step(db, check, step, "running")
        from .review_agent import auto_improve_test_case, review_test_case

        review = queued_stage("audit", lambda: review_test_case(
            case, db=db, commit=False, reference=reference, strict=agent_mode))
        if (review.get("findings") or {}).get("source") != "model":
            # The heuristic fallback is a structural guess, not a review, and
            # must not decide whether the case gets improved.
            _fail(db, check, step, "The AI reviewer could not be reached, so this case was not reviewed.")
            return
        check.score_before = case.review_score
        _set_step(db, check, step, "done")

        # 3. Auto-Improve, only when the review did not pass.
        if _stopping(check.batch_id):
            raise _Stopped()
        step = "improve"
        if case.review_verdict == "pass":
            check.score_after = case.review_score
            _set_step(db, check, step, "skipped")
        else:
            _set_step(db, check, step, "running")
            before = {name: copy.deepcopy(getattr(case, name)) for name in _IMPROVE_FIELDS}
            improved = queued_stage("audit", lambda: auto_improve_test_case(
                case, db, review_data=review, reference=reference))
            db.refresh(case)
            score_after = (improved.get("review") or {}).get("overall_score", case.review_score)
            if check.score_before is not None and score_after is not None and score_after < check.score_before:
                # An improvement that scores worse is not one. It happened when
                # the improver swapped values it could not source for <<TODO>>
                # placeholders: the re-review marked data readiness down
                # (3.6 -> 2.1) and the case went to Manual. Keep the case as
                # it was reviewed, and say what was discarded.
                for name, value in before.items():
                    setattr(case, name, value)
                findings = dict(case.review_findings or {})
                findings["auto_improve_discarded"] = {
                    "score_before": check.score_before,
                    "score_after": score_after,
                    "reason": "Auto-Improve scored lower than the reviewed case, so the reviewed case was kept.",
                }
                case.review_findings = findings
                check.score_after = check.score_before
                check.improved = False
                logger.info("AI Checks: check %s kept its reviewed case; Auto-Improve scored %s against %s",
                            check.id, score_after, check.score_before)
                db.commit()
                _set_step(db, check, step, "skipped")
            else:
                check.score_after = score_after
                check.improved = True
                _set_step(db, check, step, "done")

        # 4. KB Diff, on the case as it will be approved.
        if _stopping(check.batch_id):
            raise _Stopped()
        step = "diff"
        _diff(db, check, case)

        # 5. AI Classify.
        if _stopping(check.batch_id):
            raise _Stopped()
        step = "classify"
        _classify(db, check, case)

        if (check.steps or {}).get("_mode") == "agents":
            # Data Entry has not prepared or audited KB drafts yet. Exposing
            # "done" here would let the UI send this case for approval early.
            check.status = "running"
        else:
            check.status = "done"
            check.finished_at = datetime.utcnow()
        db.commit()
    except _Stopped:
        _mark_stopped(db, check_id)
    except Exception as exc:  # noqa: BLE001 - one case must not stop the batch
        logger.warning("AI Checks failed for check %s at %s", check_id, step, exc_info=True)
        try:
            check = db.get(AutomationAICheck, check_id)
            if check is not None:
                if _stopping(check.batch_id):
                    _mark_stopped(db, check_id)
                    return
                _fail(db, check, step, str(exc) or exc.__class__.__name__)
        except Exception:  # noqa: BLE001
            logger.exception("Could not record the AI Checks failure for check %s", check_id)
    finally:
        db.close()


# What Auto-Improve and its re-review change on a case; restored together when
# the improvement scores lower than the case it started from.
_IMPROVE_FIELDS = (
    "objective", "preconditions", "steps_structured", "steps_raw", "expected_result", "priority",
    "test_type", "test_data_required", "test_data_status", "test_data_notes",
    "review_score", "review_verdict", "review_scores", "review_findings", "reviewed_at",
)


def _mark_stopped(db: Session, check_id: int) -> None:
    db.rollback()
    check = db.get(AutomationAICheck, check_id)
    if check is None:
        return
    # Steps already finished stay finished; the rest go back to waiting.
    previous = dict(check.steps or _pending_steps())
    check.steps = {
        **{name: (previous.get(name) if previous.get(name) in ("done", "skipped") else "pending") for name in STEPS},
        **{name: value for name, value in previous.items() if name.startswith("_")},
    }
    check.status = "stopped"
    check.error = "Stopped before this case finished. Restart to check it."
    check.finished_at = None
    db.commit()


def _classify(db: Session, check: AutomationAICheck, case: AutomationTestCase) -> None:
    """Classify by rule; Partial and Undecided are kept as Manual."""
    _set_step(db, check, "classify", "running")
    wb.rescore(case)
    wb.apply_classification(case)
    check.classification_detail = case.classification
    if case.classification != wb.CLASSIFICATION_AUTOMATION:
        if case.classification == wb.CLASSIFICATION_PARTIAL:
            case.classification_reason = "Needs minor changes to automate. " + (case.classification_reason or "")
        case.classification = wb.CLASSIFICATION_MANUAL
    editor = ((check.steps or {}).get("_agents") or {}).get("expert_editor") or {}
    if (check.steps or {}).get("_mode") == "agents" and editor.get("concerns"):
        # An agent warning is not just presentation: unresolved browser
        # bindings cannot be promoted into a runnable Automation case by a
        # high prose-quality score or an unrelated KB publication.
        case.classification = wb.CLASSIFICATION_MANUAL
        case.classification_reason = "Browser journey bindings are unverified. Repair and recheck the captured controls before automation."
        check.classification_detail = wb.CLASSIFICATION_MANUAL
    # Placeholders the improver left are flagged, never invented away.
    if _TODO.search(_case_text(case)):
        case.test_data_status = "pending"
    _set_step(db, check, "classify", "done")


def _case_text(case: AutomationTestCase) -> str:
    parts = [case.preconditions or "", case.steps_raw or "", case.expected_result or "", case.test_data or ""]
    for step in case.steps_structured or []:
        if isinstance(step, dict):
            parts.extend(str(step.get(key) or "") for key in ("action", "expected_result", "test_data_ref"))
    return " ".join(parts)


# --- Retry, and re-check after an edit ------------------------------------------

def retry(db: Session, batch_id: str, check_id: int) -> None:
    """Resume failed agent handoffs; the separate restart starts from scratch."""
    check = _get_check(db, batch_id, check_id)
    if check.status == 'stopped' and (check.steps or {}).get('_mode') == 'agents':
        agents = (check.steps or {}).get('_agents') or {}
        if ((agents.get('navigation_guide') or {}).get('status') == 'done'
                and (agents.get('automation') or {}).get('status') != 'done'):
            return retry_agent_stage(db, batch_id, check_id, 'automation')
    if check.status == "failed" and (check.steps or {}).get("_mode") == "agents":
        agents = (check.steps or {}).get("_agents") or {}
        failed = next((name for name in AGENT_NAMES if (agents.get(name) or {}).get("status") == "failed"), None)
        if failed == "expert_editor" and (agents.get("navigation_guide") or {}).get("status") != "done":
            setup=(check.steps or {}).get('_agent_setup') or {}
            if _published_journey_checkpoint(db, check, setup, (check.steps or {}).get('_agent_plan') or {}):
                return retry_agent_stage(db,batch_id,check_id,'expert_editor',_retain_published_plan=True)
            # Expert Editor's semantic check is part of a still-unpublished
            # Navigation proposal. Retry that checkpoint with its completed
            # browser evidence, not an approval-only editor stage.
            _set_agent(db, check, "navigation_guide", "failed",
                       "Expert Editor requested a corrected decision on the saved browser capture.")
            from ...models.automation import AutomationDiscoveryRun
            setup = (check.steps or {}).get("_agent_setup") or {}
            run_id = (agents.get("navigation_guide") or {}).get("discovery_id")
            run = db.get(AutomationDiscoveryRun, run_id) if run_id else None
            if (run and run.status == "completed" and run.application_id == setup.get("application_id")
                    and str(run.application_environment or "").upper() == str(setup.get("environment") or "").upper()):
                state = dict(check.steps or {})
                state.pop("_force_discovery", None)
                check.steps = state
                db.commit()
            return retry_agent_stage(db, batch_id, check_id, "navigation_guide")
        if failed == "analysis":
            return retry_analysis(db, batch_id, check_id)
        if failed and failed != "data_entry":
            return retry_agent_stage(db, batch_id, check_id, failed)
        if failed == "data_entry":
            retry_data_entry(db, batch_id, check_id)
            return
    if ((check.steps or {}).get("_agents") or {}).get("data_entry", {}).get("status") == "needs_approval":
        raise ValueError("Review the prepared Knowledge Base changes first. This case will become ready after they are approved.")
    agents = ((check.steps or {}).get("_agents") or {})
    for name in ("navigation_guide", "automation"):
        pending = agents.get(name) or {}
        if pending.get("status") != "needs_approval":
            continue
        from ...models.kb_changes import KbChangeSet
        if any((db.get(KbChangeSet, change_id) or KbChangeSet()).status != "published"
               for change_id in pending.get("change_set_ids") or []):
            raise ValueError("Approve the prepared Journey KB changes before continuing this case.")
    if check.status in ("queued", "running") and _is_active(batch_id):
        raise ValueError("This case is still being checked.")
    _reset(check)
    db.commit()
    _launch(batch_id, [check.id])


def continue_after_safety_pause(db: Session, batch_id: str, check_id: int) -> None:
    """One-case, one-run consent to execute the journey's data-changing actions."""
    from ...models.kb_changes import KbCrawlRun

    check = _get_check(db, batch_id, check_id)
    pause = (check.steps or {}).get("_safety_pause") or {}
    crawl = db.get(KbCrawlRun, pause.get("crawl_id")) if pause.get("crawl_id") else None
    if check.status != "failed" or not crawl or crawl.status != "completed":
        raise ValueError("No completed browser safety pause is available for this case.")
    plan = crawl.plan or {}
    order = pause.get("step_order")
    items = plan.get("items") or []
    if (not isinstance(order, int) or order < 1 or order > len(items)
            or plan.get("stop_before") != order or plan.get("first_risky") != order
            or not items[order - 1].get("risky")
            or crawl.journey_id != pause.get("journey_id")
            or crawl.app_id != pause.get("app_key")):
        raise ValueError("The paused journey changed. Retry safely before approving its actions.")
    if _is_active(batch_id):
        raise ValueError("Wait for the current check to finish before continuing.")
    _reset(check)
    state = dict(check.steps or {})
    setup = dict(state.get("_agent_setup") or {})
    setup["allow_risky_once"] = {"journey_id": crawl.journey_id, "app_key": crawl.app_id,
                                  "approved_crawl_id": crawl.id, "base_url": crawl.base_url,
                                  "plan_signature": _plan_signature(items)}
    state["_agent_setup"] = setup
    check.steps = state
    db.commit()
    _launch(batch_id, [check.id])


def save_edits(db: Session, batch_id: str, check_id: int, edits: dict[str, Any]) -> None:
    """Store an author's step edits, then re-run Quality Review, KB Diff and AI Classify."""
    check = _get_check(db, batch_id, check_id)
    if check.status == "awaiting_approval":
        raise ValueError("Approve the prepared Knowledge Base changes before editing this refined case.")
    if check.status in ("queued", "running") and _is_active(batch_id):
        raise ValueError("This case is still being checked.")
    case = db.get(AutomationTestCase, check.case_id)
    if case is None:
        raise ValueError("This case no longer exists.")

    from .refine import normalize_action_type

    steps = []
    for index, step in enumerate(edits.get("steps") or [], start=1):
        action = str(step.get("action") or "").strip()
        if not action:
            continue
        previous = step.get("_previous") or {}
        steps.append(
            {
                "step_number": len(steps) + 1,
                "action": action,
                "action_type": normalize_action_type(step.get("action_type")),
                "target": step.get("target", previous.get("target")),
                "test_data_ref": step.get("test_data_ref", previous.get("test_data_ref")),
                "expected_result": (str(step.get("expected_result") or "").strip() or None),
            }
        )
    if not steps:
        raise ValueError("A test case needs at least one step.")

    case.steps_structured = steps
    case.steps_raw = "\n".join(f"{s['step_number']}. {s['action']}" for s in steps)
    if "preconditions" in edits:
        case.preconditions = str(edits.get("preconditions") or "").strip() or None
    if "expected_result" in edits:
        case.expected_result = str(edits.get("expected_result") or "").strip() or None

    # Filling in every <<TODO>> is the author supplying the data; the warning
    # clears. Placeholders left in keep it.
    if _TODO.search(_case_text(case)):
        case.test_data_status = "pending"
    elif case.test_data_status == "pending":
        case.test_data_status = wb.TEST_DATA_USER_PROVIDED

    check.status = "queued"
    steps_state = dict(check.steps or _pending_steps())
    steps_state["review"] = "pending"
    steps_state["diff"] = "pending"
    steps_state["classify"] = "pending"
    check.steps = steps_state
    check.error = None
    db.commit()

    thread = threading.Thread(target=_recheck, args=(batch_id, check.id), daemon=True, name=f"ai-recheck-{check.id}")
    _enter(batch_id)
    thread.start()


def _reset(check: AutomationAICheck) -> None:
    check.status = "queued"
    previous = dict(check.steps or {})
    metadata = {name: value for name, value in previous.items() if name.startswith("_") and name not in ("_agents", "_agent_decision", "_safety_pause")}
    if metadata.get("_mode") == "agents":
        # A full restart cannot keep a stage-only checkpoint. Retaining the
        # resume marker while resetting every card to waiting skipped
        # Requirements Guide and made Navigation Guide appear to start first.
        metadata = {name: metadata[name] for name in ("_mode", "_agent_setup", "_agent_auto_approval", "_recovery_history", "_review_request_id", "_evaluation_handoff", "_original_source", "_human_edits", "_review_recording_id") if name in metadata}
    if "_agent_setup" in metadata:
        metadata["_agent_setup"] = {key: value for key, value in metadata["_agent_setup"].items() if key != "allow_risky_once"}
    if metadata.get("_mode") == "agents":
        metadata["_agents"] = {name: {"status": "waiting", "message": None} for name in AGENT_NAMES}
        manager = ((previous.get('_agents') or {}).get('approval_manager') or {})
        if manager.get('events'):
            metadata['_agents']['approval_manager'] = {
                **manager,
                'status': 'working' if metadata.get('_agent_auto_approval') else manager.get('status', 'waiting'),
                'message': 'Continuing review as browser verification resumes.' if metadata.get('_agent_auto_approval') else manager.get('message'),
            }
    check.steps = {**_pending_steps(), **metadata}
    check.error = None
    check.score_before = None
    check.score_after = None
    check.improved = False
    check.classification_detail = None
    check.finished_at = None


# --- Stop, restart and delete ---------------------------------------------------

def stop(db: Session, batch_id: str) -> int:
    """Stop a batch. Returns how many waiting cases were stopped outright."""
    checks = _batch_checks(db, batch_id)
    if _is_active(batch_id):
        with _active_lock:
            _stop_requested.add(batch_id)
    waiting = [c for c in checks if c.status == "queued"]
    for check in waiting:
        check.status = "stopped"
        check.error = "Stopped before this case was checked. Restart to check it."
    db.commit()
    return len(waiting)


def restart(db: Session, batch_id: str, check_ids: Optional[list[int]] = None) -> int:
    """Run the batch's stopped and failed cases again, from their generated text.

    Finished cases keep their results. Returns how many cases were queued.
    """
    checks = _batch_checks(db, batch_id)
    if any(c.status in ("queued", "running") for c in checks) and _is_active(batch_id):
        raise ValueError("AI Checks are still running on this batch. Stop them first.")
    wanted = set(check_ids or [])
    again = [
        c for c in checks
        if c.status in ("stopped", "failed") and c.case_id and (not wanted or c.id in wanted)
        and ((c.steps or {}).get("_agents") or {}).get("data_entry", {}).get("status") != "needs_approval"
    ]
    if not again:
        raise ValueError("There are no stopped or failed cases to restart.")
    for check in again:
        _reset(check)
    db.commit()
    _launch(batch_id, [c.id for c in again])
    return len(again)


def delete_checks(db: Session, batch_id: str, check_ids: list[int]) -> int:
    """Remove cases from a batch, with their drafts. Returns how many went.

    A case being checked right now, or already sent for approval, stays.
    """
    wanted = set(check_ids)
    checks = [c for c in _batch_checks(db, batch_id) if c.id in wanted]
    if not checks:
        raise LookupError("None of those cases are in this batch.")
    if any(c.status == "running" or (c.status == "queued" and _is_active(batch_id)) for c in checks):
        raise ValueError("Stop AI Checks before deleting a case that is being checked.")
    case_ids = [c.case_id for c in checks if c.case_id]
    cases = db.query(AutomationTestCase).filter(AutomationTestCase.id.in_(case_ids)).all() if case_ids else []
    if any(case.origin != ORIGIN or case.origin_request_id for case in cases):
        raise ValueError("A case already sent for approval cannot be deleted here.")
    for check in checks:
        db.delete(check)
    db.flush()
    for case in cases:
        db.delete(case)
    db.commit()
    return len(checks)


def _batch_checks(db: Session, batch_id: str) -> list[AutomationAICheck]:
    checks = db.query(AutomationAICheck).filter(AutomationAICheck.batch_id == batch_id).all()
    if not checks:
        raise LookupError("No such AI Checks batch.")
    return checks


def set_reuse_kb_evidence(db: Session, batch_id: str, enabled: bool, *, preference: str = 'reuse_kb_evidence') -> None:
    """Set one batch-wide preference for future agent attempts, never a live run."""
    if preference not in {'reuse_kb_evidence', 'headed'}:
        raise ValueError('Unknown browser preference.')
    checks = _batch_checks(db, batch_id)
    if any((check.steps or {}).get("_mode") != "agents" for check in checks):
        raise ValueError("Knowledge Base evidence preference is available only for agent checks.")
    if _is_active(batch_id) or any(check.status in ("queued", "running") for check in checks):
        raise ValueError("Wait for AI Checks to finish or stop before changing this setting.")
    for check in checks:
        state = dict(check.steps or {})
        setup = dict(state.get("_agent_setup") or {})
        setup[preference] = enabled
        state["_agent_setup"] = setup
        check.steps = state
    db.commit()


def _recheck(batch_id: str, check_id: int) -> None:
    db = SessionLocal()
    step = "review"
    try:
        check = db.get(AutomationAICheck, check_id)
        case = db.get(AutomationTestCase, check.case_id)
        check.status = "running"
        db.commit()
        _set_step(db, check, step, "running")
        from .review_agent import review_test_case

        review = review_test_case(case, db=db, commit=False, reference=_reference(check))
        if (review.get("findings") or {}).get("source") != "model":
            _fail(db, check, step, "The AI reviewer could not be reached, so the edit was not re-reviewed.")
            return
        check.score_after = case.review_score
        _set_step(db, check, step, "done")
        step = "diff"
        _diff(db, check, case)
        step = "classify"
        _classify(db, check, case)
        check.status = "done"
        check.finished_at = datetime.utcnow()
        db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Re-check failed for check %s", check_id, exc_info=True)
        check = db.get(AutomationAICheck, check_id)
        if check is not None:
            _fail(db, check, step, str(exc) or exc.__class__.__name__)
    finally:
        db.close()
        _leave(batch_id)


def recheck_cases(db: Session, case_ids: list[int]) -> dict[str, Any]:
    """Re-run Quality Review, KB Diff and AI Classify on cases after a KB change.

    Used by Change & Heal. Same path as saving an edit (_recheck): the case as
    it stands is reviewed again against the updated Knowledge Base -- nothing is
    re-refined, so an author's edits are kept. One case at a time, in one
    background thread, so a change touching many cases does not fan out into
    many concurrent model calls.
    """
    wanted = set(case_ids)
    checks = (
        db.query(AutomationAICheck).filter(AutomationAICheck.case_id.in_(wanted)).order_by(AutomationAICheck.id.desc()).all()
        if wanted else []
    )
    latest: dict[int, AutomationAICheck] = {}
    for check in checks:
        latest.setdefault(check.case_id, check)  # newest check per case
    queued, skipped = [], []
    for case_id in sorted(wanted):
        check = latest.get(case_id)
        if check is None:
            skipped.append({"case_id": case_id, "reason": "never went through AI Checks"})
            continue
        if check.status in ("queued", "running") and _is_active(check.batch_id):
            skipped.append({"case_id": case_id, "reason": "being checked right now"})
            continue
        check.status = "queued"
        state = dict(check.steps or _pending_steps())
        state.update(review="pending", diff="pending", classify="pending")
        check.steps = state
        check.error = None
        queued.append((check.batch_id, check.id))
    db.commit()

    def run() -> None:
        for batch_id, check_id in queued:
            _enter(batch_id)
            _recheck(batch_id, check_id)  # leaves the batch itself

    if queued:
        threading.Thread(target=run, daemon=True, name="ai-recheck-kb-change").start()
    return {"queued": len(queued), "skipped": skipped}


def recheck_one(db: Session, batch_id: str, check_id: int) -> None:
    """Have the reviewer revisit one completed case after its KB changed."""
    check = _get_check(db, batch_id, check_id)
    if check.status != "done" or _is_active(batch_id):
        raise ValueError("Wait for this case and its Knowledge Base changes to finish first.")
    check.status = "queued"
    check.error = None
    check.finished_at = None
    state = dict(check.steps or _pending_steps())
    state.update(review="pending", diff="pending", classify="pending")
    check.steps = state
    db.commit()
    _enter(batch_id)

    def run() -> None:
        _recheck(batch_id, check_id)

    threading.Thread(target=run, daemon=True, name=f"ai-recheck-{check_id}").start()


# --- Reading a batch -------------------------------------------------------------

def _is_active(batch_id: str) -> bool:
    with _active_lock:
        if _active_workers.get(batch_id, 0) > 0:
            return True
    from .check_leases import active
    return active(batch_id)


def _get_check(db: Session, batch_id: str, check_id: int) -> AutomationAICheck:
    check = db.get(AutomationAICheck, check_id)
    if check is None or check.batch_id != batch_id:
        raise LookupError("No such check in this batch.")
    return check


def _step_states(check: AutomationAICheck) -> dict[str, str]:
    """Every step's state, including steps added after the check was made.

    A batch checked before KB Diff existed has no "diff" entry; for a case that
    got past it, the honest state is that it did not run.
    """
    states = {**_pending_steps(), **(check.steps or {})}
    if "diff" not in (check.steps or {}) and (check.steps or {}).get("classify") in ("done", "running"):
        states["diff"] = "skipped"
    return states


def _step_list(case: Optional[AutomationTestCase]) -> list[dict[str, Any]]:
    if case is None:
        return []
    return [
        {
            "step_number": int(step.get("step_number") or index + 1),
            "action": step.get("action") or "",
            "action_type": step.get("action_type"),
            "target": step.get("target"),
            "test_data_ref": step.get("test_data_ref"),
            "expected_result": step.get("expected_result"),
        }
        for index, step in enumerate(case.steps_structured or [])
        if isinstance(step, dict)
    ]


def _complete_published_editor(db: Session, check: AutomationAICheck) -> None:
    """A completed publication resolves only the editor's publication wait."""
    from ...models.kb_changes import KbChangeSet
    state = dict(check.steps or {})
    agents = dict(state.get("_agents") or {})
    editor = dict(agents.get("expert_editor") or {})
    data = agents.get("data_entry") or {}
    ids = data.get("change_set_ids") or []
    if (check.status != "done" or data.get("status") != "done"
            or editor.get("status") != "needs_approval" or not ids):
        return
    decisions = [db.get(KbChangeSet, change_id) for change_id in ids]
    if not all(item and item.status == "published" for item in decisions):
        return
    agents["expert_editor"] = {**editor, "status": "done",
                              "message": "Review complete; the evidence-backed Knowledge Base updates are published."}
    state["_agents"] = agents
    check.steps = state
    db.commit()


def batch_view(db: Session, batch_id: str, *, include_steps: bool = False) -> dict[str, Any]:
    checks = (
        db.query(AutomationAICheck)
        .filter(AutomationAICheck.batch_id == batch_id)
        .order_by(AutomationAICheck.position)
        .all()
    )
    if not checks:
        raise LookupError("No such AI Checks batch.")

    # The author's decision may have happened on the Knowledge Base page.
    # Only published drafts unlock the refined case; a rejected or still-draft
    # change never silently counts as ready for approval.
    from ...models.kb_changes import KbChangeSet
    resume_ids: list[int] = []
    for check in checks:
        _complete_published_editor(db, check)
        state = dict(check.steps or {})
        agents = dict(state.get("_agents") or {})
        # Older workers could skip QA because the browser handoff was running,
        # not queued. Preserve its capture and expose a real Analysis retry;
        # never infer that skipped quality checks passed from a compiled script.
        if (check.status == "awaiting_approval" and not _is_active(batch_id)
                and state.get("classify") == "pending"
                and (agents.get("automation") or {}).get("status") == "done"
                and (agents.get("automation") or {}).get("crawl_id")
                and (agents.get("analysis") or {}).get("status") == "waiting"):
            _fail(db, check, "analysis", "Analysis and Audit did not run after the browser handoff. Retry Analysis using the retained browser capture.")
            continue
        pending_recovery = state.get("_recovery_pending") or {}
        if check.status == "failed" and pending_recovery.get("stage") == "expert_editor":
            editor = agents.get("expert_editor") or {}
            if editor.get("status") != "failed":
                agents["expert_editor"] = {**editor, "status": "failed"}
                state["_agents"] = agents
                check.steps = state
                db.commit()
        pending_name = next((name for name in ("navigation_guide", "automation")
                             if (agents.get(name) or {}).get("status") == "needs_approval"
                             and (agents.get(name) or {}).get("change_set_ids")), None)
        if pending_name:
            pending_agent = agents[pending_name]
            decisions = [db.get(KbChangeSet, change_id)
                         for change_id in pending_agent.get("change_set_ids") or []]
            if (pending_name in {"navigation_guide", "automation"} and (state.get("_agent_plan") or {}).get("unresolved")
                    and (state.get("_agent_auto_approval") or {}).get("scope") == "batch"
                    and (state.get("_agent_decision") or {}).get("held") and not _is_active(batch_id)):
                for decision in decisions:
                    if decision and decision.status == "draft" and (decision.origin or {}).get("ai_check_case_id") == check.case_id:
                        decision.status = "rejected"
                        decision.decision_note = "Superseded by Navigation evidence recovery."
                db.commit()
                _fail(db, check, pending_name, "Missing controls require fresh evidence. Retry the failed agent; completed upstream work is retained.")
                continue
            if all(decision and decision.status == "published" for decision in decisions):
                if _is_active(batch_id):
                    continue  # The first worker is finishing; the next poll resumes the batch.
                # Publication completes a handoff; it is not a full restart.
                # Re-check navigation against the newly published evidence.
                if (agents.get("requirements_guide") or {}).get("status") == "done":
                    agents["navigation_guide"] = {**(agents.get("navigation_guide") or {}), "status": "failed"}
                    state["_agents"] = agents
                    check.steps = state
                    check.status = "failed"
                    retry_agent_stage(db, batch_id, check.id, "navigation_guide", _dispatch=False,
                                      _retain_published_plan=True)
                else:
                    _reset(check)
                resume_ids.append(check.id)
                db.commit()
                continue
            if any(decision and decision.status in ("rejected", "conflicted") for decision in decisions):
                agents[pending_name] = {**pending_agent, "status": "failed",
                                        "message": "The journey repair was rejected or conflicted."}
                state["_agents"] = agents
                check.steps = state
                check.status = "failed"
                check.error = "The journey repair was rejected or conflicted. Restart to prepare a new proposal."
                db.commit()
            continue
        data_agent = ((state.get("_agents") or {}).get("data_entry") or {})
        ids = data_agent.get("change_set_ids") or []
        if (check.status == "done" and data_agent.get("status") == "done" and ids
                and (state.get("_agent_decision") or {}).get("held") and not state.get("_kb_publication_held")):
            prior_decisions = [db.get(KbChangeSet, change_id) for change_id in ids]
            if all(decision and decision.status == "published" for decision in prior_decisions):
                agents = dict(state.get("_agents") or {})
                manager = dict(agents.get("approval_manager") or {})
                agents["approval_manager"] = {**manager, "status": "done", "message": "Knowledge Base changes are published; no decision remains pending."}
                state["_agents"] = agents
                state["_agent_decision"] = {"check_id": check.id, "approved": ids, "held": []}
                check.steps = state
                db.commit()
                continue
        if data_agent.get("status") != "needs_approval" or not ids:
            continue
        decisions = [db.get(KbChangeSet, change_id) for change_id in ids]
        held = (state.get("_agent_decision") or {}).get("held") or []
        if held and (state.get("_agent_auto_approval") or {}).get("scope") == "batch" and not all(
                decision and decision.status == "published" for decision in decisions):
            finish_with_held_kb_update(db, check, held)
            continue
        if all(decision and decision.status == "published" for decision in decisions):
            agents = dict(state.get("_agents") or {})
            agents["data_entry"] = {**data_agent, "status": "done", "message": "Knowledge Base changes approved and published."}
            manager = dict(agents.get("approval_manager") or {})
            if manager.get("status") == "needs_approval":
                agents["approval_manager"] = {**manager, "status": "done", "message": "Knowledge Base changes are published; no decision remains pending."}
            state["_agent_decision"] = {"check_id": check.id, "approved": ids, "held": []}
            state["_agents"] = agents
            check.steps = state
            case = db.get(AutomationTestCase, check.case_id)
            if case is not None:
                # The first classification ran before these selectors existed.
                # Re-evaluate the rule against the published app profile now.
                _classify(db, check, case)
            check.status = "done"
            check.error = None
            check.finished_at = datetime.utcnow()
            db.commit()
        elif any(decision and decision.status in ("rejected", "conflicted") for decision in decisions):
            agents = dict(state.get("_agents") or {})
            agents["data_entry"] = {**data_agent, "status": "failed", "message": "The Knowledge Base draft was rejected or conflicted. Review it before continuing."}
            state["_agents"] = agents
            check.steps = state
            check.error = "The Knowledge Base draft was rejected or conflicted. Review it before continuing."
            db.commit()

    if resume_ids and not _is_active(batch_id):
        _launch(batch_id, resume_ids + [c.id for c in checks if c.status == "queued" and c.id not in resume_ids])
    active = _is_active(batch_id)
    # A check left mid-flight by a process that no longer exists.
    guide_pending = any(c.status == "awaiting_approval" and any(
        (((c.steps or {}).get("_agents") or {}).get(name) or {}).get("status") == "needs_approval"
        for name in ("navigation_guide", "automation")) for c in checks)
    interrupted = [c for c in checks if c.status in ("queued", "running") and not active
                   and not (guide_pending and c.status == "queued")]
    for check in interrupted:
        steps = _step_states(check)
        for name, state in steps.items():
            if state == "running":
                steps[name] = "failed"
        check.steps = steps
        check.status = "failed"
        check.error = "Interrupted -- the server restarted while this case was being checked. Retry it."
        if steps.get("_mode") == "agents":
            agents = copy.deepcopy(steps.get("_agents") or {})
            # Preserve completed upstream handoffs and expose a retry on the
            # interrupted owner instead of forcing Requirements to run again.
            primary = ("requirements_guide", "crawl_guide", "navigation_guide", "expert_editor", "evidence_coordinator", "automation", "analysis", "audit", "data_entry")
            owner = next((name for name in primary if (agents.get(name) or {}).get("status") in {"working", "queued", "retrying"}), None)
            if owner:
                agents[owner] = {**agents[owner], "status": "failed", "message": check.error + " Saved upstream handoffs are retained; browser side effects are not automatically replayed."}
            steps["_agents"] = agents
            check.steps = steps
    if interrupted:
        db.commit()

    cases = {
        case.id: case
        for case in db.query(AutomationTestCase)
        .filter(AutomationTestCase.id.in_([c.case_id for c in checks if c.case_id]))
        .all()
    }

    items = []
    for check in checks:
        if not active and (check.steps or {}).get('_mode') == 'agents':
            from .evaluation_handoff import handoff
            handoff(db, check)
        case = cases.get(check.case_id)
        agents = copy.deepcopy((check.steps or {}).get("_agents")) if (check.steps or {}).get("_mode") == "agents" else None
        if agents and not active and check.status in {"failed", "stopped"}:
            owner = next((name for name, progress in agents.items() if progress.get("status") == "failed"), "upstream agent")
            agents = _settle_active_agents(agents, owner)
        guide = (agents or {}).get("navigation_guide") or {}
        plan = (check.steps or {}).get("_agent_plan") or {}
        if guide and not guide.get("discovery_id") and plan.get("change_set_id"):
            from ...models.kb_changes import KbChangeSet
            from ...models.automation import AutomationDiscoveryRun
            proposal = db.get(KbChangeSet, plan["change_set_id"])
            discovery_id = (proposal.origin or {}).get("discovery_id") if proposal else None
            discovery = db.get(AutomationDiscoveryRun, discovery_id) if discovery_id else None
            if discovery:
                guide["discovery_id"] = discovery.id
                guide["summary"] = {"pages": discovery.pages_discovered, "controls": discovery.elements_discovered,
                                    "blockers": len(discovery.blockers or [])}
        items.append(
            {
                "check_id": check.id,
                "case_id": check.case_id,
                "display_id": case.display_id if case else None,
                "title": (case.description if case else None) or (check.source_row or {}).get("Test Case Description"),
                "status": check.status,
                "steps": {name: _step_states(check).get(name, "pending") for name in STEPS},
                "agents": agents,
                "recovery": (check.steps or {}).get('_live_recoveries') or [],
                "authoring": {key: ((check.steps or {}).get('_live_navigation') or {}).get(key) for key in ('source_actions','completed_steps','status','issue','trace','script_verification')} if (check.steps or {}).get('_live_navigation') else None,
                "safety_pause": (check.steps or {}).get("_safety_pause"),
                "agent_decision": (check.steps or {}).get("_agent_decision") if (check.steps or {}).get("_mode") == "agents" else None,
                "kb_publication_held": bool((check.steps or {}).get("_kb_publication_held")),
                "error": check.error,
                "score_before": check.score_before,
                "score_after": check.score_after,
                "improved": bool(check.improved),
                "classification": case.classification if case and check.status == "done" else None,
                "classification_detail": check.classification_detail,
                "classification_reason": case.classification_reason if case else None,
                "test_data_pending": bool(case and case.test_data_status == "pending"),
                "test_data_notes": case.test_data_notes if case else None,
                "test_data_requirements": [
                    {key: requirement.get(key) for key in ("key", "description", "resolution", "sensitive")}
                    for requirement in (case.test_data_requirements or []) if isinstance(requirement, dict)
                ] if case else [],
                "review_verdict": case.review_verdict if case else None,
                "application_url": case.application_url if case else None,
                "preconditions": case.preconditions if case else None,
                "expected_result": case.expected_result if case else None,
                "test_data": case.test_data if case else None,
                "steps_structured": _step_list(case) if include_steps else None,
                # Counts for the row; the step-by-step report with the edit view.
                "journey_diff": _diff_brief(case.journey_diff if case else None),
                "journey_diff_steps": ((case.journey_diff or {}).get("steps") if case and include_steps else None),
                "source_row": check.source_row,
                # Linked to a review row once sent for approval.
                "sent": bool((case and case.origin_request_id) or (check.steps or {}).get("_sent_unverified")),
                "evaluation_handoff": (check.steps or {}).get("_evaluation_handoff"),
            }
        )

    def count(step: str, state: str) -> int:
        return sum(1 for item in items if (item["steps"] or {}).get(step) == state)

    done = [item for item in items if item["status"] == "done"]
    scored_after = [item["score_after"] for item in done if item["score_after"] is not None]
    scored_before = [item["score_before"] for item in done if item["score_before"] is not None]
    started = min((c.created_at for c in checks if c.created_at), default=None)
    finished = max((c.finished_at for c in checks if c.finished_at), default=None)
    # The worker still owns recovery and durable evaluation handoff after a
    # stage becomes failed/done. Keep polling until that finalization ends.
    running = active or any(item["status"] in ("queued", "running") for item in items)
    stopped = any(item["status"] == "stopped" for item in items)

    return {
        "batch_id": batch_id,
        "mode": "agents" if (checks[0].steps or {}).get("_mode") == "agents" else "knowledge_base",
        "agent_setup": (checks[0].steps or {}).get("_agent_setup") if (checks[0].steps or {}).get("_mode") == "agents" else None,
        "agent_auto_approval": any(((check.steps or {}).get("_agent_auto_approval") or {}).get("scope") == "batch" for check in checks),
        "status": "running" if running else "awaiting_approval" if any(item["status"] == "awaiting_approval" for item in items) else "stopped" if stopped else "complete",
        # Stop was pressed and a case is finishing the step it was on.
        "stopping": running and _stopping(batch_id),
        "total": len(items),
        "started_at": started.isoformat() if started else None,
        "finished_at": None if running or not finished else finished.isoformat(),
        "knowledge_base": checks[0].knowledge_base,
        "pipeline": {
            step: {state: count(step, state) for state in ("done", "skipped", "failed", "running", "pending")}
            for step in STEPS
        },
        "summary": {
            "automation": sum(1 for item in done if item["classification"] == wb.CLASSIFICATION_AUTOMATION),
            "manual": sum(1 for item in done if item["classification"] == wb.CLASSIFICATION_MANUAL),
            "needs_minor_changes": sum(1 for item in done if item["classification_detail"] == wb.CLASSIFICATION_PARTIAL),
            "improved": sum(1 for item in items if item["improved"]),
            "test_data_pending": sum(1 for item in items if item["test_data_pending"]),
            "not_checked": sum(1 for item in items if item["status"] == "failed" and (item.get("agents") or {}).get("data_entry", {}).get("status") != "needs_approval"),
            "stopped": sum(1 for item in items if item["status"] == "stopped"),
            "avg_before": round(sum(scored_before) / len(scored_before), 1) if scored_before else None,
            "avg_after": round(sum(scored_after) / len(scored_after), 1) if scored_after else None,
        },
        "items": items,
    }


# --- Handing a checked case to Review & Approval ---------------------------------

def attach_to_review(
    db: Session, check_id: Any, *, test_case_id: str, request_id: str
) -> Optional[dict[str, Any]]:
    """Link a checked draft to the review row it was sent as; return its AI results.

    The results come from the check record, never from the browser: the scores
    and classification a manager approves on have to be the ones the checks
    produced. Returns None for an id that is not a finished check, so a case
    sent without AI Checks simply carries no AI results.
    """
    try:
        check = db.get(AutomationAICheck, int(check_id))
    except (TypeError, ValueError):
        return None
    if check is None or check.status != "done":
        return None
    case = db.get(AutomationTestCase, check.case_id) if check.case_id else None
    if case is None:
        return None

    case.origin_test_case_id = test_case_id
    case.origin_request_id = request_id

    return {
        "check_id": check.id,
        "case_id": case.id,
        "classification": case.classification,
        "classification_detail": check.classification_detail,
        "classification_reason": case.classification_reason,
        "score_before": check.score_before,
        "score_after": check.score_after,
        "improved": bool(check.improved),
        "review_verdict": case.review_verdict,
        "review_scores": case.review_scores,
        "coverage_basis": (case.review_findings or {}).get("coverage_basis"),
        "test_data_pending": case.test_data_status == "pending",
        "test_data_notes": case.test_data_notes,
        "test_type": case.test_type,
        "steps": _step_list(case),
        "journey_diff": _diff_brief(case.journey_diff),
        # The case as generated, for the manager's Compare view.
        "original": (check.steps or {}).get('_original_source', check.source_row),
    }


# The origin a draft takes once a manager approves it: visible in Automation
# Studio from then on, and still recognisable as having come through AI Checks.
APPROVED_ORIGIN = "ai_checked"


def promote_approved(
    db: Session, case: AutomationTestCase, *, approved_by: Optional[str], approved_at: Optional[datetime]
) -> bool:
    """Approve a checked draft its review row was approved for. True if it changed.

    Manager approval is the only approval these cases need: they were refined,
    reviewed and classified before the manager saw them, which is what the
    Workbench's own approval gate exists to ensure. Missing test data does not
    block -- it was flagged on every screen and the case lands flagged.
    """
    if case.origin != ORIGIN:
        return False
    # Enforce readiness at promotion too, including callers outside the review UI.
    from ...models.database import TestCaseDetail
    from .evaluation_handoff import linked_check, packet
    review_row = db.query(TestCaseDetail).filter(
        TestCaseDetail.request_id == case.origin_request_id,
        TestCaseDetail.test_case_id == case.origin_test_case_id).first() if case.origin_request_id else None
    if review_row and (review_row.test_case_details or {}).get('_agent_resolution'):
        linked = linked_check(db, review_row)
        if not linked or packet(linked, case)['state'] != 'ready':
            return False
    case.origin = APPROVED_ORIGIN
    case.approval_status = wb.APPROVAL_APPROVED
    case.approved_by = approved_by or "manager"
    case.approved_at = approved_at or datetime.utcnow()
    case.decision_reason = "Approved in Review & Approval after AI Checks."
    return True
