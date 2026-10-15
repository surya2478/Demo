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
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse

from sqlalchemy.orm import Session

from ...models.automation import AutomationApplication
from ...models.kb_changes import KbCrawlRun
from . import crawl_runs, journey_capture, journey_crawl

SOURCE = "browser"
SESSION_MINUTES = 30
MAX_PAGES = 40
MAX_LINKS = 300
ASSET_DIR = Path(__file__).resolve().parents[2] / "browser_collector"


class CollectorError(ValueError):
    """A refused or invalid collector operation."""


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
    max_pages: int = 20,
    wait_seconds: int = 20,
    retry_count: int = 2,
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
    plan = crawl_runs._plan(kb, journey_id, base_url=base_url, profile_id=None, stop_before=None, allow_risky=False)
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
    selected = items
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
        pages.append(page)
    else:
        pages[existing] = page
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
    pages = list((crawl.result or {}).get("collector_pages") or [])
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
    done_orders = {int(step.get("order") or 0) for step in confirmed_steps}
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
    collector = {
        **collector,
        "state": raw.get("state") or "executing",
        "message": (raw.get("message") or "Running browser setup.")[:1000],
        "action_index": int(raw.get("action_index") or 0),
        "action_total": int(raw.get("action_total") or 0),
        "action_text": (raw.get("action_text") or "")[:500] or None,
        "last_progress_at": datetime.utcnow().isoformat(),
    }
    crawl.plan = {**(crawl.plan or {}), "collector": collector}
    db.commit()
    return {"accepted": True}


def _preview(page: Dict[str, Any]) -> Dict[str, Any]:
    """A value-free, cross-browser visual map of the captured tab viewport."""
    return {
        "page_id": page.get("page_id"),
        "name": page.get("name"),
        "title": page.get("title"),
        "url": page.get("url"),
        "viewport": page.get("viewport") or {"width": 1366, "height": 768},
        "elements": [
            {"role": item.get("role"), "name": item.get("name"), "kind": item.get("kind"), "bounds": item.get("bounds")}
            for item in (page.get("elements") or [])
            if item.get("bounds") and (item.get("name") or item.get("role"))
        ][:120],
    }


def finish(db: Session, crawl_id: int, token: str) -> KbCrawlRun:
    crawl, collector = _authorise(db.get(KbCrawlRun, crawl_id), token)
    pages = list((crawl.result or {}).get("collector_pages") or [])
    if not pages:
        raise CollectorError("No page was received from the browser.")
    plan = dict(crawl.plan or {})
    assignment = journey_capture.assign_screens(plan, pages)
    result = journey_crawl.evaluate(plan, journey_capture.build_output(plan, pages, assignment))
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
        "notes": ([f"Not used by any step of this journey: {', '.join(unassigned)}."] if unassigned else []),
    }
    crawl.result = result
    crawl.status = "completed"
    crawl.finished_at = datetime.utcnow()
    # Removing the hash makes the one-crawl credential unusable even before
    # its wall-clock expiry.
    crawl.plan = {
        **plan,
        "collector": {
            **collector,
            "token_hash": None,
            "finished": True,
            "state": "completed",
            "message": f"Finished after capturing {len(pages)} page(s).",
        },
    }
    db.commit()
    db.refresh(crawl)
    return crawl


def fail(db: Session, crawl_id: int, token: str, message: str) -> KbCrawlRun:
    crawl, collector = _authorise(db.get(KbCrawlRun, crawl_id), token)
    crawl.status = "failed"
    crawl.error = (message or "The browser collector stopped.").strip()[:1000]
    crawl.finished_at = datetime.utcnow()
    crawl.plan = {**(crawl.plan or {}), "collector": {
        **collector, "token_hash": None, "finished": True, "state": "failed", "message": crawl.error,
    }}
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


def package(engine: str) -> bytes:
    """Build WebExtension source for Chromium, Firefox or Safari packaging."""
    engine = engine.lower()
    if engine not in ("chromium", "firefox", "safari"):
        raise CollectorError("Choose chromium, firefox or safari.")
    manifest = ASSET_DIR / f"manifest.{engine}.json"
    required = [manifest, ASSET_DIR / "background.js", ASSET_DIR / "bridge.js", ASSET_DIR / "collector.js", ASSET_DIR / "popup.html", ASSET_DIR / "popup.js", ASSET_DIR / "popup.css"]
    if not all(path.is_file() for path in required):
        raise CollectorError("The browser collector package is incomplete on this server.")
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", manifest.read_text(encoding="utf-8"))
        for path in required[1:]:
            archive.write(path, path.name)
    return out.getvalue()
