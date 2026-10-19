"""Scoped, evidence-gated approval delegated to the Agents Refine workflow.

The user may delegate one pending proposal or this AI-check batch. Neither
choice bypasses Knowledge Base versioning, conflict checks, or permission
checks at the API boundary. Unverified steps remain for a human decision.
"""
from __future__ import annotations

import re
import logging
from datetime import datetime
from typing import Any
from urllib.parse import urljoin, urlparse

from sqlalchemy.orm import Session

from ...models.automation import AutomationAICheck, AutomationDiscoveredElement, AutomationDiscoveryRun
from ...models.kb_changes import KbChangeSet, KbCrawlRun
from .agent_journey import _slug, source_steps

logger = logging.getLogger(__name__)


def _pending_ids(check: AutomationAICheck) -> list[int]:
    agents = ((check.steps or {}).get("_agents") or {})
    for name in ("navigation_guide", "automation", "data_entry"):
        agent = agents.get(name) or {}
        if agent.get("status") == "needs_approval":
            return [int(value) for value in agent.get("change_set_ids") or []]
    return []


def _journey_is_grounded(db: Session, change: KbChangeSet, check: AutomationAICheck) -> list[str]:
    issues: list[str] = []
    origin = change.origin or {}
    if origin.get("ai_check_case_id") != check.case_id or change.app_id != ((check.steps or {}).get("_agent_setup") or {}).get("app_key"):
        return ["This draft does not belong to the selected case and application."]
    journey_change = next((item for item in change.changes if item.file.startswith("journeys/")
                           and ((item.op == "create" and item.path == "$")
                                or (item.op == "set" and item.path == "steps"))), None)
    if not journey_change:
        return ["The proposal has no authored journey to check."]
    from ..journeys import changesets
    from .ai_checks import proposed_review_documents
    try:
        if journey_change.op == "create":
            journey_id = ((journey_change.after or {}).get("value") or {}).get("journey_id")
        else:
            current = changesets._load(change.app_id, "journey", journey_change.file)
            journey_id = current.get("journey_id") if isinstance(current, dict) else None
        journey, screens = proposed_review_documents(change.app_id, change, journey_id)
    except (ValueError, changesets.ChangeSetError, KeyError, TypeError) as exc:
        return [f"The proposed journey could not be reconstructed for review: {exc}"]
    steps = journey.get("steps") or []
    actions = source_steps(check.source_row or {})
    authored=(journey.get('source') or {}).get('live_authoring')
    if authored and not origin.get('authentication_prerequisite'):
        # Expanded actions are legitimate only when their source lineage and
        # exact browser trace were replayed, not merely described by a model.
        from . import live_authoring, agent_journey
        from .registry import address_for_crawl
        setup=(check.steps or {}).get('_agent_setup') or {}
        try:
            if authored.get('source_actions')!=actions or authored.get('expected_result')!=agent_journey.source_expected(check.source_row or {}):
                raise ValueError('Authored source actions or expected result changed')
            address=address_for_crawl(db,setup['app_key'],setup['environment'])
            if authored.get('entry_url')!=address:
                raise ValueError('Authored browser evidence belongs to another application entry or environment')
            if any(item.get('operation') in ('fill','select') for item in authored.get('trace',[])):
                raise ValueError('Credential/form journeys require Test Data review before publication')
            live_authoring.verify_saved_replay(authored)
            bindings,observed_screens=live_authoring.journey_bindings(authored,agent_journey.source_expected(check.source_row or {}))
            if steps!=bindings:
                raise ValueError('Proposed steps differ from the replayed browser actions')
            proposed={screen.get('screen_id'):screen for screen in screens}
            for key,observed in observed_screens.items():
                actual=proposed.get(key) or {}
                if actual.get('route')!=observed['route']:
                    raise ValueError('A proposed screen differs from the replayed screen')
                for element in observed['elements']:
                    matching=[item for item in actual.get('elements',[]) if item.get('element_id')==element['element_id']]
                    if len(matching)!=1 or any(matching[0].get(k)!=v for k,v in element.items()):
                        raise ValueError('A proposed control differs from the replayed browser control')
            allowed={'screens.json','sources/taxonomy_overlay.json',journey_change.file}
            if any(item.file not in allowed or item.op not in {'create','set'} for item in change.changes):
                raise ValueError('Authored proposal includes unrelated changes')
        except (ValueError,KeyError,TypeError,OSError) as exc:
            issues.append(str(exc))
        return issues
    if origin.get("authentication_prerequisite"):
        from . import agent_auth
        from ..journeys import store
        from . import auth_bootstrap
        setup = (check.steps or {}).get("_agent_setup") or {}
        if not agent_auth.requires_signed_in_browser(check.source_row or {}, actions):
            issues.append("The source case does not require a login prerequisite.")
        linked_indexes = origin.get("linked_login_control_indexes") or []
        if linked_indexes:
            evidence = db.get(AutomationDiscoveryRun, origin.get("discovery_id"))
            try:
                page, observed_linked, linked_item = auth_bootstrap._linked_login_controls(
                    evidence, store.load(change.app_id), setup.get("environment")) if evidence else (None, [], None)
                parsed_page = urlparse(str((page or {}).get("url") or ""))
                canonical_page = f"{parsed_page.scheme}://{parsed_page.netloc}{parsed_page.path or '/'}"
                if not page or canonical_page != origin.get("linked_login_page_url"):
                    raise ValueError("The linked login page changed.")
                entry = db.get(AutomationDiscoveredElement, origin.get("login_entry_control_id"))
                if (not entry or entry.discovery_run_id != evidence.id or entry.role != "link"
                        or entry.page_url != linked_item.get("source_url")
                        or urljoin(entry.page_url, entry.href or "") != (linked_item.get("entry_url") or linked_item.get("target_url"))
                        or int(entry.confidence_score or 0) < 70 or not entry.recommended_locator
                        or not steps or steps[0].get("element_id") != _slug(entry.element_name or entry.accessible_name or "")):
                    issues.append("The login entry link is not the verified link from the registered page.")
                controls = [next((control for control in observed_linked if control.id == key), None)
                            for key in linked_indexes]
            except (ValueError, TypeError, KeyError):
                controls = [None, None, None]
        else:
            ids = origin.get("login_control_ids") or []
            controls = [db.get(AutomationDiscoveredElement, key) for key in ids]
        if (len(controls) != 3 or any(c is None for c in controls)
                or len({c.page_url for c in controls}) != 1
                or [c.role for c in controls] != ["textbox", "textbox", "button"]
                or (not linked_indexes and any(c.discovery_run_id != origin.get("discovery_id") for c in controls))):
            issues.append("The login prerequisite lacks one observed form.")
        else:
            actions = ["Open the login page", f'Enter "{controls[0].accessible_name}"',
                       f'Enter "{controls[1].accessible_name}"', f'Click "{controls[2].accessible_name}"']
    prerequisites = journey.get("prerequisite_journeys") or []
    if prerequisites:
        from . import agent_auth
        from ..journeys import store
        setup = (check.steps or {}).get("_agent_setup") or {}
        kb = store.load(change.app_id)
        from .registry import address_for_crawl
        address = address_for_crawl(db, change.app_id, setup.get("environment"))
        auth_plan = (agent_auth.observed_login_plan(kb, base_url=address,
                     profile_id=setup.get("profile_id"), requested_journey=prerequisites[0],
                     environment=setup.get("environment"))
                     if kb and address and len(prerequisites) == 1 else None)
        evidence = db.get(AutomationDiscoveryRun, origin.get("discovery_id")) if origin.get("discovery_id") else None
        if auth_plan and evidence and evidence.auth_status == "verified":
            actions = [action for action in actions if not agent_auth.is_login_shorthand(action)]
        else:
            issues.append("The login prerequisite lacks verified authentication evidence.")
    if [step.get("action") for step in steps] != actions:
        issues.append("Proposed actions differ from the saved test case.")
    if not steps:
        issues.append("The journey has no steps.")
    if any(not step.get("screen_id") or (not re.match(r"\s*(open|visit|go to|navigate)", step.get("action") or "", re.I) and not step.get("element_id")) for step in steps):
        issues.append("One or more steps have no observed screen and control.")
    bootstrap_profile = None
    if origin.get("authentication_prerequisite") and len(controls) == 3 and all(controls):
        bootstrap_profile = next((item for item in change.changes if item.file == "roles.json"), None)
        if bootstrap_profile:
            expected = {"name": "Observed login identity", "kind": "vault", "fields": [
                {"name": controls[0].accessible_name, "variable": "TESTDATA_USERNAME"},
                {"name": controls[1].accessible_name, "variable": "TESTDATA_PASSWORD"}]}
            if (bootstrap_profile.path != f"test_data_profiles.{origin.get('login_profile_id')}"
                    or (bootstrap_profile.after or {}).get("value") != expected
                    or (bootstrap_profile.before or {}).get("present")):
                issues.append("The login profile changes more than the observed credential bindings.")
            setup = (check.steps or {}).get("_agent_setup") or {}
            if not {"username", "password"}.issubset(agent_auth.credential_names_present(db, change.app_id, setup.get("environment"))):
                issues.append("The login identity is missing environment Test Data.")
    if not bootstrap_profile and any(re.match(r"\s*(enter|fill|type)", step.get("action") or "", re.I) for step in steps):
        setup = (check.steps or {}).get("_agent_setup") or {}
        profile_id = origin.get("login_profile_id") if origin.get("authentication_prerequisite") else setup.get("profile_id")
        if not profile_id:
            issues.append("Input steps need a ready Test Data profile before automatic approval.")
        else:
            from ..journeys import store, workspace
            kb = store.load(change.app_id)
            coverage = workspace.test_data_coverage(kb, db) if kb else {"profiles": []}
            profile = next((item for item in coverage["profiles"] if item["profile_id"] == profile_id), None)
            cell = (profile or {}).get("cells", {}).get(str(setup.get("environment") or "").upper())
            if not cell or cell.get("status") != "ready":
                issues.append("The selected Test Data profile is not ready for this environment.")
            if origin.get("authentication_prerequisite") and profile:
                from . import agent_auth
                variables = [str(field.get("variable") or "") for field in profile.get("fields") or []
                             if re.fullmatch(r"\s*(username|user name|email|email address|password)\s*",
                                             str(field.get("name") or ""), re.I)]
                if len(variables) != 2 or not agent_auth.login_variables_ready(
                        db, change.app_id, setup.get("environment") or "", variables):
                    issues.append("The login identity does not have one exact ready username/password pair in this environment.")
    discovery = db.get(AutomationDiscoveryRun, origin.get("discovery_id")) if origin.get("discovery_id") else None
    if not discovery or discovery.status != "completed":
        issues.append("There is no completed public-browser discovery for these controls.")
        return issues
    setup = (check.steps or {}).get("_agent_setup") or {}
    if discovery.application_id != setup.get("application_id"):
        issues.append("The browser evidence belongs to another application.")
    if str(discovery.application_environment or "").upper() != str(setup.get("environment") or "").upper():
        issues.append("The browser evidence belongs to another environment.")
    by_screen = {screen.get("screen_id"): screen for screen in screens if isinstance(screen, dict)}
    observed = db.query(AutomationDiscoveredElement).filter(AutomationDiscoveredElement.discovery_run_id == discovery.id).all()
    evidence_host = urlparse(discovery.application_url).netloc
    linked_host = urlparse(str(origin.get("linked_login_page_url") or "")).netloc if origin.get("authentication_prerequisite") else ""
    if linked_host and controls and all(controls):
        observed.extend(controls)
    for step in steps:
        screen = by_screen.get(step.get("screen_id"))
        route = str((screen or {}).get("route") or "")
        route_host = urlparse(route).netloc or evidence_host
        required_host = linked_host if linked_host and route_host == linked_host else evidence_host
        if re.match(r"\s*(open|visit|go to|navigate)", step.get("action") or "", re.I) and screen and not step.get("element_id"):
            if not any(isinstance(page.get("status"), int) and page["status"] < 400
                       and urlparse(page.get("url") or "").netloc == required_host
                       and (urlparse(page.get("url") or "").path or "/").split(";", 1)[0]
                           == (urlparse(route).path if route_host == linked_host and linked_host else route)
                       for page in discovery.explored_pages or [] if isinstance(page, dict)):
                issues.append(f"Step {step.get('step_number')} page was not confirmed by browser discovery.")
            continue
        element = next((item for item in (screen or {}).get("elements", []) if item.get("element_id") == step.get("element_id")), None)
        if not element:
            issues.append(f"Step {step.get('step_number')} has no matching proposed screen control.")
            continue
        if not any(urlparse(control.page_url).netloc == required_host and _slug(control.element_name or control.accessible_name or "") == step.get("element_id")
                   and (urlparse(control.page_url).path or "/").split(";", 1)[0]
                       == (urlparse(route).path if route_host == linked_host and linked_host else route)
                   and control.accessible_name == element.get("label") for control in observed):
            issues.append(f"Step {step.get('step_number')} control was not confirmed by browser discovery.")
    allowed = {"screens.json", "sources/taxonomy_overlay.json", journey_change.file if journey_change else ""}
    if bootstrap_profile:
        allowed.add("roles.json")
    if any(item.file not in allowed or item.op not in {"create", "set"} for item in change.changes):
        issues.append("This proposal includes changes outside the expected journey and screen draft.")
    return issues


def _crawl_is_grounded(db: Session, change: KbChangeSet, check: AutomationAICheck) -> list[str]:
    editor = ((check.steps or {}).get("_agents") or {}).get("expert_editor") or {}
    if editor.get("concerns"):
        return ["Expert Editor found an approved journey binding that needs a person to review before publication."]
    origin = (change.origin or {}).get("crawl") or {}
    crawl = db.get(KbCrawlRun, origin.get("crawl_run_id")) if origin.get("crawl_run_id") else None
    if not crawl or crawl.status != "completed" or crawl.app_id != ((check.steps or {}).get("_agent_setup") or {}).get("app_key"):
        return ["This change is not backed by a completed crawl of the selected application."]
    result = crawl.result or {}
    summary = result.get("summary") or {}
    if not result.get("rows") or not summary:
        return ["The crawl has no complete step evidence to check."]
    if int(summary.get("not_found") or 0) or int(summary.get("not_reached") or 0):
        # Inventory includes optional controls (closed menus, alternate states).
        # Validate the actual proposal, not unrelated absent inventory rows.
        issues = _scoped_crawl_changes(change, crawl)
        if issues:
            return issues
    if any(item.op in {"delete", "remove"} for item in change.changes):
        return ["This proposal removes Knowledge Base content and needs a person to approve it."]
    return []


def _scoped_crawl_changes(change, crawl) -> list[str]:
    from .ai_checks import browser_execution_evidence
    execution = browser_execution_evidence(crawl.plan or {}, crawl.result or {})
    if not execution["total"] or execution["incomplete"] or execution["safety_pause"]:
        return ["The executed journey has missing or stopped actions; its proposal remains held."]
    host = urlparse(crawl.base_url or "").netloc
    rows = [row for row in (crawl.result or {}).get("rows", [])
            if row.get("outcome") in {"confirmed", "new", "healed"}
            and row.get("selector") and not row.get("ambiguous")
            and not row.get("data_dependent") and host
            and urlparse(row.get("url") or "").netloc == host
            and any(attempt.get("count") == 1 for attempt in row.get("tried", []))]
    for item in change.changes:
        value = (item.after or {}).get("value")
        if item.op != "set":
            return ["Incomplete inventory proposal includes an unsupported operation."]
        if item.file == "app_profile.json" and item.path.startswith("selectors.") and isinstance(value, dict):
            before = (item.before or {}).get("value")
            if isinstance(before, dict) and any(key not in value for key in before):
                return ["The selector proposal removes existing entries and needs review."]
            screen_key = item.path.removeprefix("selectors.")
            if not value or any(not any(_slug(row.get("screen_id") or "") == screen_key
                    and row.get("element_id") == element_id and row["selector"] == selector
                    for row in rows) for element_id, selector in value.items()):
                return ["A proposed selector lacks unique same-host and same-screen browser evidence."]
        elif item.file == "screens.json":
            match = re.fullmatch(r"screens\[screen_id=([^\]]+)\]\.elements\[element_id=([^\]]+)\]\.automation_ref", item.path)
            if not match or not any(row.get("screen_id") == match[1] and row.get("element_id") == match[2]
                    and value == f"selectors.{_slug(match[1])}.{match[2]}" for row in rows):
                return ["A proposed screen binding lacks unique browser evidence."]
        else:
            return ["Incomplete inventory proposal contains changes outside observed selectors and bindings."]
    return []


def audit(db: Session, change: KbChangeSet, check: AutomationAICheck) -> list[str]:
    if change.status != "draft":
        return [f"Change #{change.id} is already {change.status}."]
    if not change.changes:
        return ["There are no proposed changes to check."]
    if change.source in {"agent-review", "agent-repair"}:
        return _journey_is_grounded(db, change, check)
    if change.source == "crawl":
        return _crawl_is_grounded(db, change, check)
    return ["This change was not prepared by the agent workflow."]


def _progress(check: AutomationAICheck, status: str, message: str) -> None:
    state = dict(check.steps or {})
    agents = dict(state.get('_agents') or {})
    current = dict(agents.get('approval_manager') or {})
    events = list(current.get('events') or [])
    events.append({'at': datetime.utcnow().isoformat(), 'status': status, 'message': message})
    agents['approval_manager'] = {**current, 'status': status, 'message': message, 'events': events[-30:]}
    state['_agents'] = agents
    check.steps = state


def _reuse_ready_data(db: Session, check: AutomationAICheck, actor: str) -> str | None:
    """Prefer a compatible ready KB profile; never invent working credentials."""
    if ((check.steps or {}).get('_agent_setup') or {}).get('profile_id'):
        return None
    from . import agent_test_data
    try:
        info = agent_test_data.suggestion(db, check.batch_id, check.id)
        profile_id = info.get('recommended_profile_id')
        if profile_id:
            agent_test_data.assign_existing(db, check.batch_id, check.id, profile_id=profile_id, actor=actor)
            db.refresh(check)
            return f"Selected ready KB Test Data profile {profile_id} for {info['environment']}; browser execution must still verify the account."
    except (ValueError, KeyError):
        return None
    except Exception:
        logger.exception('Approval Manager could not inspect reusable Test Data for check %s', check.id)
    return None


def _review_summary(change: KbChangeSet) -> dict[str, Any]:
    """Show the model one file per group and the meaningful field-level delta."""
    files: dict[str, list[dict[str, Any]]] = {}
    for item in change.changes:
        before = (item.before or {}).get("value")
        after = (item.after or {}).get("value")
        update: dict[str, Any] = {"operation": item.op, "path": item.path,
                                  "purpose": str(item.note or "")[:180]}
        new_steps = after if item.path == "steps" and isinstance(after, list) else (
            after.get("steps") if item.path == "$" and isinstance(after, dict) else None)
        old_steps = before if item.path == "steps" and isinstance(before, list) else []
        if isinstance(new_steps, list):
            old_by_number = {step.get("step_number"): step for step in old_steps if isinstance(step, dict)}
            update["total_steps"] = len(new_steps)
            update["changed_steps"] = [
                {"number": step.get("step_number"), "action": step.get("action"),
                 "before_screen": (old_by_number.get(step.get("step_number")) or {}).get("screen_id"),
                 "before_control": (old_by_number.get(step.get("step_number")) or {}).get("element_id"),
                 "after_screen": step.get("screen_id"), "after_control": step.get("element_id")}
                for step in new_steps if isinstance(step, dict)
                and old_by_number.get(step.get("step_number")) != step
            ]
        elif item.path == "screens" and isinstance(after, list):
            update["screen_count"] = len(after)
        elif item.path == "added_nodes" and isinstance(after, list):
            update["taxonomy_node_count"] = len(after)
        files.setdefault(item.file, []).append(update)
    return {"id": change.id, "source": change.source,
            "is_login_prerequisite": bool((change.origin or {}).get("authentication_prerequisite")),
            "files": [{"file": file, "field_updates": updates} for file, updates in files.items()]}


def decide_pending(db: Session, check: AutomationAICheck, *, actor: str) -> dict[str, Any]:
    ids = _pending_ids(check)
    if not ids:
        return {"check_id": check.id, "approved": [], "held": ["This case has no pending agent proposal."]}
    _progress(check, 'working', 'Checking the proposed changes, browser evidence and reusable KB Test Data.')
    db.commit()
    data_note = _reuse_ready_data(db, check, actor)
    if data_note:
        _progress(check, 'working', data_note)
        db.commit()
    changes = [db.get(KbChangeSet, change_id) for change_id in ids]
    if any(change is None for change in changes):
        return {"check_id": check.id, "approved": [], "held": ["A prepared change set could not be found."]}
    try:
        issues = [reason for change in changes for reason in audit(db, change, check)]
    except Exception:
        issues = ["The agent could not verify the proposal's evidence. It remains pending for you."]
    model_failed = False
    if not issues:
        from . import agent_reviews
        try:
            def review_progress(status: str, attempt: int, total: int, message: str) -> None:
                _progress(check, status, f"Attempt {attempt}/{total}: {message}")
                db.commit()

            decision = agent_reviews.review("approval_manager", {
                "saved_case_actions": source_steps(check.source_row or {}),
                "changes": [_review_summary(change) for change in changes],
                "change_shape": "Each file appears once. Multiple field_updates for one file are atomic edits, not duplicate file creation.",
                "browser_evidence_gate": "passed",
            }, on_progress=review_progress)
            _progress(check, "working", f"AI reviewed proposal meaning: {decision.reason}")
            db.commit()
            if decision.verdict == "hold":
                issues = [f"Approval Manager held the proposal: {decision.reason}"]
        except agent_reviews.AgentReviewError as exc:
            issues = [str(exc)]
            model_failed = True
            _progress(check, "failed", issues[0])
            db.commit()
    if issues:
        if any("Test Data" in issue for issue in issues):
            from ...models.automation import AutomationTestCase
            case = db.get(AutomationTestCase, check.case_id)
            if case:
                case.test_data_status = "pending"
                case.test_data_notes = "Resolve the case's Test Data profile: " + "; ".join(issues)
        result = {"check_id": check.id, "approved": [], "held": list(dict.fromkeys(issues))}
    else:
        try:
            from ...routers.knowledge_base_page import _approve
            for change in changes:
                if change.status == "draft":
                    _approve(db, change.id, {"username": f"agent:{actor}"},
                             f"Evidence-gated agent decision requested by {actor} for AI-check batch {check.batch_id}.")
            result = {"check_id": check.id, "approved": ids, "held": []}
        except Exception as exc:  # Conflict and publication failures must never be counted as approval.
            db.rollback()
            result = {"check_id": check.id, "approved": [], "held": [str(getattr(exc, "detail", None) or exc)]}
    state = dict(check.steps or {})
    state["_agent_decision"] = result
    check.steps = state
    data_entry_hold = bool(result['held'] and ((check.steps or {}).get('_agents') or {}).get('data_entry', {}).get('status') == 'needs_approval')
    message = ("KB update withheld; case may continue to Human Evaluation as Manual. " + "; ".join(result['held'])[:300]
               if data_entry_hold else "Held for human review: " + "; ".join(result['held'])[:300] if result['held']
               else f"Approved {len(result['approved'])} evidence-backed KB change set(s).")
    _progress(check, 'done' if data_entry_hold else 'failed' if model_failed else 'needs_approval' if result['held'] else 'done', message)
    db.commit()
    if data_entry_hold:
        from . import ai_checks
        ai_checks.finish_with_held_kb_update(db, check, result['held'])
    return result


def set_policy(db: Session, batch_id: str, *, scope: str, check_id: int | None, actor: str) -> dict[str, Any]:
    checks = (db.query(AutomationAICheck).filter(AutomationAICheck.batch_id == batch_id)
              .order_by(AutomationAICheck.position).all())
    if not checks or (checks[0].steps or {}).get("_mode") != "agents":
        raise ValueError("This is not an Agents Refine batch.")
    if scope not in {"one", "batch", "off"}:
        raise ValueError("Choose this proposal, all proposals in this batch, or turn delegation off.")
    if scope == "one":
        selected = next((item for item in checks if item.id == check_id), None)
        if selected is None:
            raise ValueError("Choose the case whose pending proposal the agent should check.")
        return {"scope": "one", "active": False, "results": [decide_pending(db, selected, actor=actor)]}
    for check in checks:
        state = dict(check.steps or {})
        if scope == "off":
            state.pop("_agent_auto_approval", None)
            check.steps = state
            _progress(check, 'waiting', 'Delegation is off. Future KB proposals wait for your decision.')
        else:
            state["_agent_auto_approval"] = {"scope": "batch", "requested_by": actor}
            check.steps = state
            if check.status == 'done':
                _progress(check, 'done', 'This case finished without a pending KB decision.')
            else:
                _progress(check, 'working', 'Delegated for this batch. Reviewing each proposal in parallel with the other agents.')
    db.commit()
    results = [decide_pending(db, check, actor=actor) for check in checks if _pending_ids(check)] if scope == "batch" else []
    return {"scope": scope, "active": scope == "batch", "results": results}


def decide_if_delegated(db: Session, check: AutomationAICheck) -> None:
    policy = (check.steps or {}).get("_agent_auto_approval") or {}
    if policy.get("scope") == "batch":
        decide_pending(db, check, actor=policy.get("requested_by") or check.requested_by)
