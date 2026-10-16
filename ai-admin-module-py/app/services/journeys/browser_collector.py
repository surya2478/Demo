"""Browser-owned crawling without a browser runtime on the API server.

The collector is a WebExtension running in the tester's existing browser.  A
normal authenticated API call creates a short-lived crawl and returns the
collector token once.  The extension receives only that token; it can upload
sanitised DOM snapshots to this crawl and cannot call any other TestPilot API.

Snapshots are evaluated through ``journey_capture`` so extension crawls enter
the same review, proposal, Knowledge Base and flow-generation paths as local
Playwright walks and uploaded captures.
"""
from __future__ import annotations

import hashlib
import hmac
import io
import json
import secrets
import zipfile
import base64
import binascii
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse

from sqlalchemy.orm import Session

from ...config import settings
from ...models.automation import AutomationApplication
from ...models.kb_changes import KbCrawlRun
from . import crawl_runs, journey_capture, journey_crawl

SOURCE = "browser"
SESSION_MINUTES = 30
MAX_PAGES = 40
MAX_LINKS = 300
ASSET_DIR = Path(__file__).resolve().parents[2] / "browser_collector"
MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024


class CollectorError(ValueError):
    """A refused or invalid collector operation."""


def _same_crawl_scope(
    crawl: KbCrawlRun,
    *,
    app_id: str,
    journey_id: str,
    application_id: int,
    environment: str,
    profile_id: Optional[str],
) -> bool:
    return (
        crawl.app_id == app_id
        and crawl.journey_id == journey_id
        and crawl.application_id == application_id
        and (crawl.environment or "").strip().upper() == environment.strip().upper()
        and (crawl.profile_id or None) == (profile_id or None)
    )


def _completed_evidence_parent(
    db: Session,
    requested: KbCrawlRun,
    *,
    app_id: str,
    journey_id: str,
    application_id: int,
    environment: str,
    profile_id: Optional[str],
) -> Optional[KbCrawlRun]:
    """Find completed evidence behind a completed or failed recapture source."""
    if requested.status == "completed" and (requested.result or {}).get("steps"):
        return requested
    collector = ((requested.plan or {}).get("collector") or {})
    ancestor_ids = [collector.get("evidence_from"), collector.get("recapture_of")]
    for raw_id in ancestor_ids:
        if not raw_id:
            continue
        candidate = db.get(KbCrawlRun, int(raw_id))
        if (
            candidate
            and candidate.status == "completed"
            and (candidate.result or {}).get("steps")
            and _same_crawl_scope(
                candidate, app_id=app_id, journey_id=journey_id, application_id=application_id,
                environment=environment, profile_id=profile_id,
            )
        ):
            return candidate
    # Older collector runs did not store recapture lineage. Use only the most
    # recent earlier completed crawl with the exact same execution scope.
    candidates = (
        db.query(KbCrawlRun)
        .filter(
            KbCrawlRun.id < requested.id,
            KbCrawlRun.app_id == app_id,
            KbCrawlRun.journey_id == journey_id,
            KbCrawlRun.application_id == application_id,
            KbCrawlRun.status == "completed",
        )
        .order_by(KbCrawlRun.id.desc())
        .all()
    )
    return next((candidate for candidate in candidates if (candidate.result or {}).get("steps") and _same_crawl_scope(
        candidate, app_id=app_id, journey_id=journey_id, application_id=application_id,
        environment=environment, profile_id=profile_id,
    )), None)


def _capture_dir(crawl_id: int) -> Path:
    return Path(settings.AUTOMATION_STORAGE_PATH).resolve() / "browser-crawls" / str(int(crawl_id))


def capture_file(crawl_id: int, name: str) -> Optional[Path]:
    """Return a collector screenshot without allowing paths outside its crawl."""
    if name != "live.png" and not (name.startswith("shot-") and name.endswith(".png")):
        return None
    root = _capture_dir(crawl_id)
    candidate = (root / Path(name).name).resolve()
    return candidate if candidate.parent == root and candidate.is_file() else None


def _save_screenshot(crawl_id: int, name: str, value: Any) -> bool:
    if not isinstance(value, str) or not value.startswith("data:image/png;base64,"):
        return False
    try:
        raw = base64.b64decode(value.split(",", 1)[1], validate=True)
    except (ValueError, binascii.Error):
        return False
    if not raw.startswith(b"\x89PNG\r\n\x1a\n") or len(raw) > MAX_SCREENSHOT_BYTES:
        return False
    root = _capture_dir(crawl_id)
    root.mkdir(parents=True, exist_ok=True)
    target = root / name
    temporary = root / f".{name}.tmp"
    temporary.write_bytes(raw)
    temporary.replace(target)
    live_temporary = root / ".live.tmp"
    live_temporary.write_bytes(raw)
    live_temporary.replace(root / "live.png")
    return True


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _origin(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise CollectorError("The application address must be an http or https URL.")
    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme}://{parsed.hostname.lower()}{port}"


def _collector(crawl: KbCrawlRun) -> Dict[str, Any]:
    value = (crawl.plan or {}).get("collector")
    if not isinstance(value, dict):
        raise CollectorError("This crawl is not a browser-collector session.")
    return value


def _authorise(crawl: Optional[KbCrawlRun], token: str, *, writable: bool = True) -> Tuple[KbCrawlRun, Dict[str, Any]]:
    if crawl is None:
        raise CollectorError("No such browser crawl.")
    collector = _collector(crawl)
    if not token or not hmac.compare_digest(_token_hash(token), str(collector.get("token_hash") or "")):
        raise CollectorError("The browser crawl code is not valid.")
    try:
        expires = datetime.fromisoformat(str(collector.get("expires_at")))
    except (TypeError, ValueError) as exc:
        raise CollectorError("The browser crawl has no valid expiry.") from exc
    if datetime.utcnow() >= expires:
        raise CollectorError("The browser crawl code has expired. Start a new browser crawl.")
    if writable and crawl.status != "running":
        raise CollectorError(f"This browser crawl is already {crawl.status}.")
    return crawl, collector


def start(
    db: Session,
    *,
    app_id: str,
    journey_id: str,
    application_id: int,
    environment: Optional[str],
    actor: Optional[str],
    profile_id: Optional[str] = None,
    max_pages: int = 20,
    wait_seconds: int = 20,
    retry_count: int = 2,
    capture_step: Optional[int] = None,
    recapture_of: Optional[int] = None,
) -> Tuple[KbCrawlRun, str]:
    """Create a paired extension crawl, returning its bearer token once."""
    if (journey_id or "").startswith(crawl_runs.FLOW_PREFIX):
        raise CollectorError("Browser crawling currently maps pages to a journey, not a flow blueprint.")
    application = db.get(AutomationApplication, application_id)
    if application is None:
        raise LookupError("No such registered application.")
    kb = crawl_runs._kb(app_id)
    if application.app_key != kb.app_id:
        raise CollectorError(f"{application.name} is registered as '{application.app_key}', not '{kb.app_id}'.")
    if journey_id not in kb.journeys:
        raise LookupError(f"No journey '{journey_id}'.")
    environment = (environment or application.environment or "SIT").strip()
    if environment.upper() in crawl_runs.blocked_environments():
        raise CollectorError(f"Browser crawls do not run against {environment}. Use SIT, QA, UAT or RC.")
    from ..automation.registry import address_for_crawl

    base_url = (address_for_crawl(db, application.app_key, environment) or application.base_url or "").strip()
    allowed_origin = _origin(base_url)
    plan = crawl_runs._plan(kb, journey_id, base_url=base_url, profile_id=profile_id, stop_before=None, allow_risky=False)
    if capture_step is not None and capture_step > len(plan.get("items") or []):
        raise CollectorError(f"Step {capture_step} is not part of this journey.")
    if recapture_of is not None:
        if capture_step is None:
            raise CollectorError("A recapture source requires a selected journey step.")
        parent = db.get(KbCrawlRun, int(recapture_of))
        if parent is None or parent.status not in ("completed", "failed"):
            raise CollectorError("The crawl being recaptured is missing or is still running.")
        if not _same_crawl_scope(
            parent, app_id=app_id, journey_id=journey_id, application_id=application.id,
            environment=environment, profile_id=plan.get("profile_id"),
        ):
            raise CollectorError("The recapture source does not belong to this journey, environment and Test Data selection.")
        evidence_parent = _completed_evidence_parent(
            db, parent, app_id=app_id, journey_id=journey_id, application_id=application.id,
            environment=environment, profile_id=plan.get("profile_id"),
        )
    else:
        evidence_parent = None
    if recapture_of is not None and capture_step is not None:
        # A later recapture must replay earlier selectors repaired in the
        # previous recapture.  Those edits intentionally remain run-local
        # until review/approval, so carry only explicit user repairs and only
        # for prerequisite steps before the new target.
        sources = [source for source in (evidence_parent, parent) if source is not None]
        items = list(plan.get("items") or [])
        for source in sources:
            for order, repaired in enumerate((source.plan or {}).get("items") or [], start=1):
                if order >= int(capture_step) or order > len(items):
                    continue
                repaired_element = repaired.get("element") or {}
                current_element = items[order - 1].get("element") or {}
                if repaired_element.get("repair_strategy") != "user" or (
                    repaired.get("journey_id"), repaired.get("step_number"), repaired.get("screen_id"), repaired_element.get("element_id")
                ) != (
                    items[order - 1].get("journey_id"), items[order - 1].get("step_number"), items[order - 1].get("screen_id"), current_element.get("element_id")
                ):
                    continue
                items[order - 1] = {
                    **items[order - 1],
                    "kind": repaired.get("kind") or items[order - 1].get("kind"),
                    "element": {**current_element, **repaired_element},
                }
                for key in ("option", "key"):
                    if key in repaired:
                        items[order - 1][key] = repaired[key]
        plan["items"] = items
    token = secrets.token_urlsafe(32)
    now = datetime.utcnow()
    plan["source"] = SOURCE
    plan["collector"] = {
        "token_hash": _token_hash(token),
        "created_at": now.isoformat(),
        "expires_at": (now + timedelta(minutes=SESSION_MINUTES)).isoformat(),
        "allowed_origin": allowed_origin,
        "max_pages": max(1, min(int(max_pages), MAX_PAGES)),
        "wait_seconds": max(2, min(int(wait_seconds), 120)),
        "retry_count": max(0, min(int(retry_count), 10)),
        "received": 0,
        "browser": None,
        "state": "waiting",
        "current_url": None,
        "message": "Waiting for the installed browser collector to connect.",
        "capture_step": int(capture_step) if capture_step is not None else None,
        "recapture_of": int(recapture_of) if recapture_of is not None else None,
        "evidence_from": evidence_parent.id if evidence_parent is not None else None,
        "step_events": [],
    }
    crawl = KbCrawlRun(
        app_id=app_id,
        journey_id=journey_id,
        application_id=application.id,
        environment=environment,
        profile_id=plan.get("profile_id"),
        base_url=base_url,
        run_key=None,
        status="running",
        plan=plan,
        result={"collector_pages": []},
        created_by=actor,
    )
    db.add(crawl)
    db.commit()
    db.refresh(crawl)
    return crawl, token


def config(db: Session, crawl_id: int, token: str) -> Dict[str, Any]:
    crawl, collector = _authorise(db.get(KbCrawlRun, crawl_id), token, writable=False)
    now = datetime.utcnow().isoformat()
    collector = {
        **collector,
        "state": "opening",
        "connected_at": collector.get("connected_at") or now,
        "current_url": crawl.base_url,
        "message": "Collector connected. Opening the application in a background tab.",
    }
    crawl.plan = {**(crawl.plan or {}), "collector": collector}
    db.commit()
    automation = _automation(db, crawl)
    return {
        "crawl_id": crawl.id,
        "base_url": crawl.base_url,
        "allowed_origin": collector["allowed_origin"],
        "max_pages": collector["max_pages"],
        "wait_seconds": collector.get("wait_seconds", 20),
        "retry_count": collector.get("retry_count", 2),
        "expires_at": collector["expires_at"],
        "same_origin_only": True,
        "values_collected": False,
        "safe_navigation_only": True,
        # Values cross only this origin-bound, short-lived collector session.
        # They are used in the target page and never enter snapshots/results.
        "automation": automation,
    }


def _automation(db: Session, crawl: KbCrawlRun) -> Dict[str, Any]:
    """Leading actions needed to reach the first screen this crawl should map."""
    from ..automation import test_data

    plan = dict(crawl.plan or {})
    items = list(plan.get("items") or [])
    # Execute the complete safe plan, including any prerequisite journey. This
    # is what lets a Sign out crawl first sign in, reach Products, open the
    # menu, sign out, and finally validate Login. Risky actions have already
    # been converted to ``skip`` by the plan builder when they are not allowed.
    capture_step = (plan.get("collector") or {}).get("capture_step")
    selected = items[:int(capture_step)] if capture_step else items
    variables = [item.get("variable") or item.get("text_variable") for item in selected]
    variables = [name for name in dict.fromkeys(variables) if name]
    data = test_data.for_code(
        db, journey_crawl.build_spec({**plan, "variables": variables}),
        environment=crawl.environment, base_url=crawl.base_url,
    )
    missing = [name for name in variables if name not in data.get("values", {})]
    if missing:
        readable = ", ".join(name.removeprefix("TESTDATA_").replace("_", " ").lower() for name in missing)
        raise CollectorError(f"Test Data is missing {readable} for {crawl.environment}. Add it before continuing the crawl.")
    actions = []
    signatures = plan.get("signatures") if isinstance(plan.get("signatures"), dict) else {}
    for order, item in enumerate(selected, start=1):
        kind = item.get("kind")
        if kind == "skip":
            continue
        element = item.get("element") if isinstance(item.get("element"), dict) else {}
        variable = item.get("variable") or item.get("text_variable")
        action = {
            "order": order,
            "kind": kind,
            "text": item.get("text"),
            "route": item.get("route"),
            "selector": element.get("kb_target"),
            "labels": list(dict.fromkeys(filter(None, [
                element.get("clean_label"), element.get("label"), *(element.get("aliases") or []),
            ]))),
            "roles": (element.get("hint") or {}).get("roles") or [],
            "interactive": bool(capture_step and order == int(capture_step)),
            "option": item.get("option"),
            "key": item.get("key"),
        }
        expected_screens = list(dict.fromkeys(
            screen_id
            for expected in (item.get("expect") or [])
            if expected.get("expected")
            for screen_id in (expected.get("to") or [])
            if screen_id
        ))
        expected_routes = list(dict.fromkeys(
            str((signatures.get(screen_id) or {}).get("route") or "").strip()
            for screen_id in expected_screens
            if str((signatures.get(screen_id) or {}).get("route") or "").strip()
        ))
        if expected_screens:
            action["expected_screens"] = expected_screens
        if expected_routes:
            action["expected_routes"] = expected_routes
        expected_marker = next((
            expected.get("marker") for expected in (item.get("expect") or [])
            if expected.get("expected") and expected.get("marker")
        ), None)
        if expected_marker:
            action["satisfied_by"] = {
                "selector": expected_marker.get("kb_target"),
                "labels": list(dict.fromkeys(filter(None, [
                    expected_marker.get("clean_label"), expected_marker.get("label"),
                    *(expected_marker.get("aliases") or []),
                ]))),
                "roles": (expected_marker.get("hint") or {}).get("roles") or [],
            }
        if variable:
            action["value"] = data["values"][variable]
        actions.append(action)
    return {
        "mode": "run-safe-journey",
        "actions": actions,
        "target": selected[-1].get("text") if selected else None,
    }


def add_page(db: Session, crawl_id: int, token: str, raw: Dict[str, Any]) -> Dict[str, Any]:
    crawl, collector = _authorise(db.get(KbCrawlRun, crawl_id), token)
    raw = dict(raw or {})
    screenshot = raw.pop("screenshot", None)
    page = journey_capture._page(raw, f"page-{int(collector.get('received') or 0) + 1}")
    if not page["elements"]:
        raise CollectorError("The snapshot contains no uniquely located elements.")
    if not page.get("url") or _origin(page["url"]) != collector["allowed_origin"]:
        raise CollectorError("The snapshot is outside the registered application's origin.")
    state = dict(crawl.result or {})
    pages = list(state.get("collector_pages") or [])
    # The same route can represent meaningful before/after states (menu closed
    # versus open, Add versus Remove). Replace only an identical snapshot;
    # preserve changed DOM states so earlier journey actions remain provable.
    def fingerprint(value: Dict[str, Any]) -> tuple:
        return tuple(sorted(
            (str(element.get("role") or ""), str(element.get("name") or ""), str(element.get("selector") or ""))
            for element in value.get("elements") or []
        ))

    signature = fingerprint(page)
    existing = next((
        i for i, item in enumerate(pages)
        if item.get("url") == page["url"] and fingerprint(item) == signature
    ), None)
    if existing is None:
        if len(pages) >= int(collector["max_pages"]):
            raise CollectorError("This browser crawl has reached its page limit.")
        shot_number = len(pages) + 1
        pages.append(page)
    else:
        shot_number = existing + 1
        pages[existing] = page
    shot_name = f"shot-{shot_number}.png"
    if _save_screenshot(crawl_id, shot_name, screenshot):
        page["screenshot"] = shot_name
    collector = {
        **collector,
        "received": len(pages),
        "browser": str(raw.get("browser") or collector.get("browser") or "")[:100] or None,
        "state": "capturing",
        "current_url": page.get("url"),
        "last_received_at": datetime.utcnow().isoformat(),
        "message": f"Captured {page.get('name') or page.get('page_id')} ({len(pages)} of up to {collector['max_pages']} pages).",
    }
    crawl.plan = {**(crawl.plan or {}), "collector": collector}
    crawl.result = {**state, "collector_pages": pages}
    db.commit()
    return {"accepted": True, "pages": len(pages), "max_pages": collector["max_pages"]}


def live(crawl: KbCrawlRun) -> Dict[str, Any]:
    """Return connection, page and confirmed-step progress during collection."""
    plan = dict(crawl.plan or {})
    collector = dict(plan.get("collector") or {})
    pages = list((crawl.result or {}).get("collector_pages") or (crawl.result or {}).get("capture", {}).get("pages") or [])
    confirmed_steps = []
    current = None
    if pages:
        try:
            assignment = journey_capture.assign_screens(plan, pages)
            partial = journey_crawl.evaluate(plan, journey_capture.build_output(plan, pages, assignment))
            confirmed_steps = [step for step in partial.get("steps", []) if step.get("status") in ("done", "auto")]
        except (KeyError, TypeError, ValueError):
            # Partial data should never make the live screen disappear. Final
            # evaluation still performs the complete validation on finish.
            confirmed_steps = []
    # The extension reports an action ledger independently of DOM evaluation.
    # It remains available after a failure and therefore accurately shows the
    # completed actions plus the exact failed action.
    by_order = {int(step.get("order") or 0): step for step in confirmed_steps}
    events = list(collector.get("step_events") or [])
    # Runs created by collector releases before the step ledger still retain
    # the zero-based action index. Reconstruct their visible history so an old
    # failure also shows completed steps and the failed step after deployment.
    if not events and collector.get("action_index") is not None:
        failed_order = int(collector.get("action_index") or 0) + 1
        events = [
            {
                "order": order,
                "status": "error" if crawl.status == "failed" and order == failed_order else "done",
                "text": ((plan.get("items") or [{}])[order - 1].get("text") if order <= len(plan.get("items") or []) else None),
                "error": crawl.error if crawl.status == "failed" and order == failed_order else None,
            }
            for order in range(1, failed_order + 1)
        ]
    latest_event_order = max((int(event.get("order") or 0) for event in events), default=0)
    for event in events:
        order = int(event.get("order") or 0)
        if not order:
            continue
        item = (plan.get("items") or [{}])[order - 1] if order <= len(plan.get("items") or []) else {}
        status = {"running": "not_reached", "done": "done", "error": "error"}.get(event.get("status"), "not_reached")
        if event.get("status") == "running" and (
            (by_order.get(order) or {}).get("status") in ("done", "auto")
            or (item.get("kind") == "goto" and order < latest_event_order)
        ):
            status = "done"
        by_order[order] = {
            "order": order,
            "step_number": item.get("step_number") or order,
            "status": status,
            "url": collector.get("current_url"),
            "error": event.get("error"),
        }
    failed_orders = [int(event.get("order") or 0) for event in events if event.get("status") == "error"]
    if crawl.status == "failed" and failed_orders:
        failed_at = min(failed_orders)
        by_order = {order: step for order, step in by_order.items() if order <= failed_at}
    confirmed_steps = [by_order[key] for key in sorted(by_order)]
    done_orders = {int(step.get("order") or 0) for step in confirmed_steps if step.get("status") in ("done", "auto")}
    for order, item in enumerate(plan.get("items") or [], start=1):
        if order not in done_orders:
            current = {
                "order": order,
                "step_number": item.get("step_number") or order,
                "text": item.get("text") or item.get("action") or "Waiting for this step",
                "kind": item.get("kind") or "capture",
            }
            break
    latest = pages[-1] if pages else None
    preview = _preview(latest) if latest else None
    return {
        "id": crawl.id,
        "status": crawl.status,
        "run_status": None,
        "phase": collector.get("message") or "Waiting for the browser collector.",
        "total": len(plan.get("items") or []),
        "current": current if crawl.status == "running" else None,
        "finished": crawl.status in ("completed", "failed"),
        "steps": confirmed_steps,
        "frame_at": None,
        "collector_state": collector.get("state") or "waiting",
        "pages_received": len(pages),
        "pages_max": int(collector.get("max_pages") or 0),
        "current_url": collector.get("current_url"),
        "connected_at": collector.get("connected_at"),
        "action_index": collector.get("action_index"),
        "action_total": collector.get("action_total"),
        "action_text": collector.get("action_text"),
        "preview": preview,
    }


def progress(db: Session, crawl_id: int, token: str, raw: Dict[str, Any]) -> Dict[str, Any]:
    """Persist value-free action progress so the Studio can explain a live crawl."""
    crawl, collector = _authorise(db.get(KbCrawlRun, crawl_id), token)
    events = list(collector.get("step_events") or [])
    status = raw.get("action_status")
    order = int(raw.get("action_order") or 0) or int(raw.get("action_index") or 0) + 1
    if status and order:
        event = {
            "order": order,
            "status": status,
            "text": (raw.get("action_text") or "")[:500] or None,
            "error": (raw.get("action_error") or "")[:1000] or None,
            "at": datetime.utcnow().isoformat(),
        }
        events = [entry for entry in events if int(entry.get("order") or 0) != order]
        events.append(event)
        events.sort(key=lambda entry: int(entry.get("order") or 0))
    collector = {
        **collector,
        "state": raw.get("state") or "executing",
        "message": (raw.get("message") or "Running browser setup.")[:1000],
        "action_index": int(raw.get("action_index") or 0),
        "action_total": int(raw.get("action_total") or 0),
        "action_text": (raw.get("action_text") or "")[:500] or None,
        "last_progress_at": datetime.utcnow().isoformat(),
        "step_events": events,
    }
    crawl.plan = {**(crawl.plan or {}), "collector": collector}
    db.commit()
    return {"accepted": True}


def repair(db: Session, crawl_id: int, token: str, raw: Dict[str, Any]) -> Dict[str, Any]:
    """Attach a user-selected locator to one step of this short-lived crawl."""
    crawl, collector = _authorise(db.get(KbCrawlRun, crawl_id), token)
    order = int(raw.get("order") or 0)
    expected = int(collector.get("capture_step") or 0)
    if not expected or order != expected:
        raise CollectorError("This crawl is not waiting to repair that step.")
    selector = str(raw.get("selector") or "").strip()
    if not selector:
        raise CollectorError("The selected element did not produce a locator.")
    plan = deepcopy(crawl.plan or {})
    items = list(plan.get("items") or [])
    if order > len(items):
        raise CollectorError(f"Step {order} is not part of this journey.")
    item = dict(items[order - 1])
    element = dict(item.get("element") or {})
    element["kb_target"] = selector
    element["repair_strategy"] = "user"
    selected_action = str(raw.get("action") or "").strip() or None
    if selected_action:
        element["repair_action"] = selected_action
        if selected_action in ("verify_visible", "verify_text"):
            item["kind"] = "capture"
        elif selected_action in ("click", "tap"):
            item["kind"] = "click"
        elif selected_action == "double_click":
            item["kind"] = "dblclick"
        elif selected_action in ("hover", "focus"):
            item["kind"] = selected_action
        elif selected_action in ("check", "uncheck"):
            item["kind"] = selected_action
        elif selected_action == "press_enter":
            item["kind"] = "press"
            item["key"] = "Enter"
        elif selected_action == "select_option":
            option = raw.get("option")
            if option is None:
                raise CollectorError("Choose an option from the selected list.")
            item["kind"] = "select"
            item["option"] = str(option)[:500]
        elif selected_action == "fill_test_data":
            if not (item.get("variable") or item.get("text_variable")):
                raise CollectorError("This step has no saved Test Data field to fill.")
            item["kind"] = "fill"
    if raw.get("app_label"):
        element["captured_label"] = str(raw["app_label"])[:200]
    item["element"] = element
    items[order - 1] = item
    collector = dict(plan.get("collector") or {})
    collector["repair"] = {
        "order": order,
        "selector": selector,
        "app_label": (raw.get("app_label") or None),
        "role": (raw.get("role") or None),
        "action": selected_action,
        "option": (raw.get("option") if selected_action == "select_option" else None),
        "captured_at": datetime.utcnow().isoformat(),
    }
    plan["items"] = items
    plan["collector"] = collector
    crawl.plan = plan
    db.commit()
    return {"accepted": True, "order": order}


def _preview(page: Dict[str, Any]) -> Dict[str, Any]:
    """A value-free, cross-browser visual map of the captured tab viewport."""
    return {
        "page_id": page.get("page_id"),
        "name": page.get("name"),
        "title": page.get("title"),
        "url": page.get("url"),
        "screenshot": page.get("screenshot"),
        "viewport": page.get("viewport") or {"width": 1366, "height": 768},
        "elements": [
            {"role": item.get("role"), "name": item.get("name"), "kind": item.get("kind"), "bounds": item.get("bounds")}
            for item in (page.get("elements") or [])
            if item.get("bounds") and (item.get("name") or item.get("role"))
        ][:120],
    }


def _merge_step_events(output: Dict[str, Any], plan: Dict[str, Any], collector: Dict[str, Any]) -> Dict[str, Any]:
    """Keep actions proven by the collector when captured pages are partial.

    A recapture intentionally keeps only the screens needed around its target.
    DOM-only evaluation therefore cannot rediscover every prerequisite action,
    even though the extension executed and reported those actions successfully.
    The value-free action ledger is the authority for execution status; page
    captures remain the authority for selectors and screen evidence.
    """
    steps = [dict(step) for step in (output.get("steps") or [])]
    by_order = {int(step.get("order") or 0): step for step in steps if int(step.get("order") or 0)}
    items = list(plan.get("items") or [])
    events = list(collector.get("step_events") or [])
    recorded = {int(event.get("order") or 0): str(event.get("status") or "") for event in events}
    recorded_orders = set(recorded)
    latest_recorded = max(recorded_orders, default=0)
    # Collector 1.9.2 advanced past ``goto`` without emitting its done event.
    # A later sequential action proves that the opening action completed.
    for order, item in enumerate(items, start=1):
        if item.get("kind") == "goto" and order < latest_recorded and recorded.get(order) in (None, "running"):
            events.append({"order": order, "status": "done"})
    for event in events:
        order = int(event.get("order") or 0)
        event_status = str(event.get("status") or "")
        status = {"done": "done", "error": "error", "running": "not_reached"}.get(event_status)
        if not order or not status:
            continue
        item = items[order - 1] if order <= len(items) else {}
        step = dict(by_order.get(order) or {
            "order": order,
            "journey_id": item.get("journey_id"),
            "step_number": item.get("step_number") or order,
            "kind": item.get("kind"),
            "screen_id": item.get("screen_id") or None,
        })
        step["status"] = status
        if status == "done":
            step.pop("reason", None)
            step.pop("error", None)
        elif event.get("error"):
            step["error"] = event["error"]
        by_order[order] = step
    return {**output, "steps": [by_order[key] for key in sorted(by_order)]}


def _inherit_recapture_steps(
    db: Session,
    crawl: KbCrawlRun,
    output: Dict[str, Any],
    collector: Dict[str, Any],
) -> Tuple[Dict[str, Any], list[int]]:
    """Retain confirmed evidence beyond a shortened recapture replay.

    A recapture intentionally executes only through ``capture_step``.  Later
    steps must not become ``not run`` merely because they were outside that
    replay, but they also must not be presented as newly executed.  Copy only
    previously confirmed later steps from the explicitly linked parent crawl
    and mark their provenance for the UI and audit trail.
    """
    parent_id = int(collector.get("evidence_from") or 0)
    cutoff = int(collector.get("capture_step") or 0)
    if not cutoff:
        failed_orders = [
            int(event.get("order") or 0) for event in (collector.get("step_events") or [])
            if event.get("status") == "error" and int(event.get("order") or 0)
        ]
        cutoff = min(failed_orders, default=0)
    if not parent_id or not cutoff:
        return output, []
    parent = db.get(KbCrawlRun, parent_id)
    if (
        parent is None
        or parent.status != "completed"
        or parent.app_id != crawl.app_id
        or parent.journey_id != crawl.journey_id
        or parent.application_id != crawl.application_id
        or (parent.environment or "").strip().upper() != (crawl.environment or "").strip().upper()
        or (parent.profile_id or None) != (crawl.profile_id or None)
    ):
        raise CollectorError("The completed crawl used for this recapture is no longer compatible.")

    by_order = {
        int(step.get("order") or 0): dict(step)
        for step in (output.get("steps") or [])
        if int(step.get("order") or 0)
    }
    inherited_orders: list[int] = []
    parent_items = list((parent.plan or {}).get("items") or [])
    current_items = list((crawl.plan or {}).get("items") or [])
    for raw in (parent.result or {}).get("steps") or []:
        order = int(raw.get("order") or 0)
        if order <= cutoff or raw.get("status") not in ("done", "auto"):
            continue
        if order > len(parent_items) or order > len(current_items):
            continue
        parent_item, current_item = parent_items[order - 1], current_items[order - 1]
        parent_element, current_element = parent_item.get("element") or {}, current_item.get("element") or {}
        if (
            parent_item.get("journey_id"), parent_item.get("step_number"), parent_item.get("kind"),
            parent_item.get("screen_id"), parent_element.get("element_id"),
        ) != (
            current_item.get("journey_id"), current_item.get("step_number"), current_item.get("kind"),
            current_item.get("screen_id"), current_element.get("element_id"),
        ):
            continue
        inherited = deepcopy(raw)
        inherited.pop("screenshot", None)
        inherited.pop("error", None)
        inherited.pop("reason", None)
        inherited["inherited_from_crawl_id"] = parent.id
        inherited["note"] = f"Previously confirmed by browser crawl #{parent.id}; this step was not rerun during recapture."
        by_order[order] = inherited
        inherited_orders.append(order)
    return {**output, "steps": [by_order[key] for key in sorted(by_order)]}, inherited_orders


def _evaluate_pages(db: Session, crawl: KbCrawlRun, collector: Dict[str, Any]) -> Dict[str, Any]:
    pages = list((crawl.result or {}).get("collector_pages") or [])
    if not pages:
        raise CollectorError("No page was received from the browser.")
    plan = dict(crawl.plan or {})
    assignment = journey_capture.assign_screens(plan, pages)
    output = journey_capture.build_output(plan, pages, assignment)
    output = _merge_step_events(output, plan, collector)
    output, inherited_orders = _inherit_recapture_steps(db, crawl, output, collector)
    result = journey_crawl.evaluate(plan, output)
    if collector.get("recapture_of"):
        result["recapture"] = {
            "of_crawl_id": int(collector["recapture_of"]),
            "evidence_from_crawl_id": int(collector.get("evidence_from") or 0) or None,
            "step": int(collector.get("capture_step") or 0),
            "inherited_orders": inherited_orders,
        }
    used: Dict[int, list] = {}
    urls = [p.get("url") for p in pages]
    for step in result.get("steps", []):
        if step.get("status") == "done" and step.get("url") in urls:
            used.setdefault(urls.index(step["url"]), []).append(step.get("step_number"))
    unassigned = [p["name"] or p["page_id"] for i, p in enumerate(pages) if not assignment.get(i) and not used.get(i)]
    result["capture"] = {
        "file": "browser collector",
        "format": "browser-collector/1",
        "host": urlparse(crawl.base_url or "").netloc,
        "started_at": collector.get("created_at"),
        "finished_at": datetime.utcnow().isoformat(),
        "uploaded_by": crawl.created_by,
        "browser": collector.get("browser"),
        "pages": [
            {"page_id": p["page_id"], "name": p["name"], "url": p.get("url"), "screen_id": assignment.get(i),
             "steps": used.get(i, []), "elements": len(p["elements"]), "preview": _preview(p)}
            for i, p in enumerate(pages)
        ],
        "notes": (
            ([f"Not used by any step of this journey: {', '.join(unassigned)}."] if unassigned else [])
            + ([f"Previously confirmed later steps were retained from browser crawl #{collector['evidence_from']}; they were not rerun."] if inherited_orders else [])
        ),
    }
    return result


def _recapture_destination_error(crawl: KbCrawlRun, collector: Dict[str, Any]) -> Optional[str]:
    """Reject a repaired transition when its final capture is on another screen."""
    capture_step = int(collector.get("capture_step") or 0)
    plan = dict(crawl.plan or {})
    items = list(plan.get("items") or [])
    pages = list(
        (crawl.result or {}).get("collector_pages")
        or (crawl.result or {}).get("capture", {}).get("pages")
        or []
    )
    if not capture_step or capture_step > len(items) or not pages:
        return None
    item = items[capture_step - 1]
    expected_screens = list(dict.fromkeys(
        screen_id
        for expected in (item.get("expect") or [])
        if expected.get("expected")
        for screen_id in (expected.get("to") or [])
        if screen_id
    ))
    signatures = plan.get("signatures") if isinstance(plan.get("signatures"), dict) else {}
    expected_routes = [
        str((signatures.get(screen_id) or {}).get("route") or "").strip()
        for screen_id in expected_screens
        if str((signatures.get(screen_id) or {}).get("route") or "").strip()
    ]
    if not expected_routes:
        return None
    actual_url = str(pages[-1].get("url") or "")
    actual_path = (urlparse(actual_url).path or "/").rstrip("/") or "/"
    normalised = {(urlparse(route).path or route or "/").rstrip("/") or "/" for route in expected_routes}
    if actual_path in normalised:
        return None
    expected_name = ", ".join(
        str((signatures.get(screen_id) or {}).get("name") or screen_id) for screen_id in expected_screens
    )
    return (
        f"The selected element did not reach {expected_name or ', '.join(expected_routes)}. "
        f"It ended on {actual_path}; recapture step {capture_step} and select the correct element."
    )


def _with_destination_failure(collector: Dict[str, Any], message: str) -> Dict[str, Any]:
    order = int(collector.get("capture_step") or 0)
    events = [dict(event) for event in (collector.get("step_events") or [])]
    events = [event for event in events if int(event.get("order") or 0) != order]
    events.append({"order": order, "status": "error", "error": message, "message": message})
    return {**collector, "step_events": sorted(events, key=lambda event: int(event.get("order") or 0))}


def finish(db: Session, crawl_id: int, token: str) -> KbCrawlRun:
    crawl, collector = _authorise(db.get(KbCrawlRun, crawl_id), token)
    plan = dict(crawl.plan or {})
    destination_error = _recapture_destination_error(crawl, collector)
    if destination_error:
        collector = _with_destination_failure(collector, destination_error)
    result = _evaluate_pages(db, crawl, collector)
    pages = list((result.get("capture") or {}).get("pages") or [])
    crawl.result = result
    crawl.status = "failed" if destination_error else "completed"
    crawl.error = destination_error
    crawl.finished_at = datetime.utcnow()
    # Removing the hash makes the one-crawl credential unusable even before
    # its wall-clock expiry.
    crawl.plan = {
        **plan,
        "collector": {
            **collector,
            "token_hash": None,
            "finished": True,
            "state": crawl.status,
            "message": destination_error or f"Finished after capturing {len(pages)} page(s).",
        },
    }
    db.commit()
    db.refresh(crawl)
    return crawl


def fail(db: Session, crawl_id: int, token: str, message: str) -> KbCrawlRun:
    crawl, collector = _authorise(db.get(KbCrawlRun, crawl_id), token)
    if not collector.get("evidence_from"):
        history = _completed_evidence_parent(
            db, crawl, app_id=crawl.app_id, journey_id=crawl.journey_id,
            application_id=crawl.application_id, environment=crawl.environment or "",
            profile_id=crawl.profile_id,
        )
        if history is not None:
            collector = {**collector, "evidence_from": history.id}
    if (crawl.result or {}).get("collector_pages"):
        # A terminal failure is still an evidence-bearing result. Preserve its
        # fresh completed/error steps and retain compatible later history.
        crawl.result = _evaluate_pages(db, crawl, collector)
    crawl.status = "failed"
    crawl.error = (message or "The browser collector stopped.").strip()[:1000]
    crawl.finished_at = datetime.utcnow()
    crawl.plan = {**(crawl.plan or {}), "collector": {
        **collector, "token_hash": None, "finished": True, "state": "failed", "message": crawl.error,
    }}
    db.commit()
    db.refresh(crawl)
    return crawl


def ensure_terminal_result(db: Session, crawl: KbCrawlRun) -> KbCrawlRun:
    """Backfill evaluated history for collector failures made before this fix."""
    collector = _collector(crawl)
    destination_error = (
        _recapture_destination_error(crawl, collector)
        if crawl.status == "completed" and (crawl.plan or {}).get("source") == SOURCE
        else None
    )
    if destination_error:
        collector = _with_destination_failure(collector, destination_error)
        result = deepcopy(crawl.result or {})
        capture_step = int(collector.get("capture_step") or 0)
        result["steps"] = [
            {
                **step,
                "status": "error",
                "error": destination_error,
                "reason": destination_error,
            } if int(step.get("order") or 0) == capture_step else step
            for step in (result.get("steps") or [])
        ]
        crawl.result = result
        crawl.status = "failed"
        crawl.error = destination_error
        crawl.plan = {**(crawl.plan or {}), "collector": {**collector, "state": "failed", "message": destination_error}}
        db.commit()
        db.refresh(crawl)
        return crawl
    if (
        crawl.status != "failed"
        or (crawl.plan or {}).get("source") != SOURCE
        or (crawl.result or {}).get("steps")
        or not (crawl.result or {}).get("collector_pages")
    ):
        return crawl
    history = _completed_evidence_parent(
        db, crawl, app_id=crawl.app_id, journey_id=crawl.journey_id,
        application_id=crawl.application_id, environment=crawl.environment or "",
        profile_id=crawl.profile_id,
    )
    if history is not None:
        collector = {**collector, "evidence_from": history.id}
    crawl.result = _evaluate_pages(db, crawl, collector)
    crawl.plan = {**(crawl.plan or {}), "collector": collector}
    db.commit()
    db.refresh(crawl)
    return crawl


def cancel(db: Session, crawl_id: int, message: str = "Browser crawl stopped by the user.") -> KbCrawlRun:
    """Stop a browser crawl from the authenticated Studio UI and revoke it."""
    crawl = db.get(KbCrawlRun, crawl_id)
    if crawl is None:
        raise LookupError("No such browser crawl.")
    collector = _collector(crawl)
    if crawl.status != "running":
        raise CollectorError(f"This browser crawl is already {crawl.status}.")
    crawl.status = "failed"
    crawl.error = message[:1000]
    crawl.finished_at = datetime.utcnow()
    crawl.plan = {**(crawl.plan or {}), "collector": {**collector, "token_hash": None, "finished": True}}
    db.commit()
    db.refresh(crawl)
    return crawl


def package(engine: str, studio_origin: Optional[str] = None) -> bytes:
    """Build WebExtension source for Chromium, Firefox or Safari packaging."""
    engine = engine.lower()
    if engine not in ("chromium", "firefox", "safari"):
        raise CollectorError("Choose chromium, firefox or safari.")
    manifest = ASSET_DIR / f"manifest.{engine}.json"
    required = [manifest, ASSET_DIR / "background.js", ASSET_DIR / "bridge.js", ASSET_DIR / "collector.js", ASSET_DIR / "popup.html", ASSET_DIR / "popup.js", ASSET_DIR / "popup.css"]
    if not all(path.is_file() for path in required):
        raise CollectorError("The browser collector package is incomplete on this server.")
    out = io.BytesIO()
    manifest_data = json.loads(manifest.read_text(encoding="utf-8"))
    if studio_origin:
        origin = _origin(studio_origin)
        manifest_data["content_scripts"] = [{
            "matches": [f"{origin}/*"],
            "js": ["bridge.js"],
            "run_at": "document_start",
        }]
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest_data, indent=2))
        for path in required[1:]:
            archive.write(path, path.name)
    return out.getvalue()
