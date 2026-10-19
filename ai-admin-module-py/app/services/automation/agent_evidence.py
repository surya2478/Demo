"""Non-authoritative KB index of browser observations shared by guide agents.

Approved journeys/screens remain the source of executable mappings. This file
only points to immutable discovery rows; it never stores credentials or turns
an observed locator into an approved one.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

from ...models.automation import AutomationApplication, AutomationDiscoveryRun
from ..journeys import store
from .agent_crawl_guide import entry_evidence

_LOCK = threading.RLock()
_FILE = "sources/agent_observations.json"
_MAX_SCANS = 40
_MAX_FINDINGS = 120
_REUSE_AGE = timedelta(hours=24)
logger = logging.getLogger(__name__)


def _path(app_key: str) -> Path | None:
    kb = store.load(app_key)
    return kb.directory / _FILE if kb else None


def _read(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"scans": [], "findings": []}
    return value if isinstance(value, dict) else {"scans": [], "findings": []}


def _write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _url_key(address: str) -> str:
    return hashlib.sha256(address.rstrip("/").encode("utf-8")).hexdigest()


def _terms(values: list[str] | None) -> list[str]:
    return sorted({term.lower() for term in (values or []) if re.fullmatch(r"[a-zA-Z0-9 -]{3,80}", term)})[:12]


def record_scan(db, run: AutomationDiscoveryRun, *, max_pages: int,
                focus_terms: list[str] | None = None) -> None:
    app = db.get(AutomationApplication, run.application_id) if run.application_id else None
    path = _path(app.app_key) if app else None
    if not path or run.status != "completed" or not entry_evidence(run, run.application_url or "")["verified"]:
        return
    entry = {
        "run_id": run.id, "application_id": app.id,
        "environment": str(run.application_environment or "").upper(),
        "entry_key": _url_key(run.application_url or ""),
        "entry_host": urlparse(run.application_url or "").hostname,
        "entry_path": urlparse(run.application_url or "").path or "/",
        "auth_mode": run.auth_mode or "none", "auth_status": run.auth_status or "not_required",
        "max_pages": max_pages, "focus_terms": _terms(focus_terms),
        "pages": run.pages_discovered, "controls": run.elements_discovered,
        "observed_routes": sorted({urlparse(str(page.get("url") or "")).path or "/"
                                   for page in (run.explored_pages or []) if isinstance(page, dict)
                                   and urlparse(str(page.get("url") or "")).hostname == urlparse(run.application_url or "").hostname})[:40],
        "blocker_count": len(run.blockers or []),
        "captured_at": (run.updated_at or datetime.utcnow()).isoformat(),
    }
    try:
        with _LOCK:
            doc = _read(path)
            doc["_purpose"] = "Browser observations for agents; not approved selectors, credentials, or executable journeys."
            doc["scans"] = ([item for item in doc.get("scans", []) if isinstance(item, dict)
                             and item.get("run_id") != run.id] + [entry])[-_MAX_SCANS:]
            doc.setdefault("findings", [])
            _write(path, doc)
    except OSError:
        logger.warning("Could not index browser observation for application %s", app.app_key, exc_info=True)


def reusable_scan(db, *, app_key: str, application_id: int, address: str,
                  environment: str, max_pages: int, focus_terms: list[str] | None = None,
                  auth_mode: str = "none") -> AutomationDiscoveryRun | None:
    path = _path(app_key)
    if not path:
        return None
    now = datetime.utcnow()
    for item in reversed(_read(path).get("scans", [])):
        if not isinstance(item, dict) or item.get("application_id") != application_id:
            continue
        if (item.get("entry_key") != _url_key(address) or
                item.get("environment") != environment.upper() or
                item.get("auth_mode") != auth_mode or
                int(item.get("max_pages") or 0) < max_pages or
                (max_pages > 1 and not set(_terms(focus_terms)).issubset(item.get("focus_terms") or []))):
            continue
        try:
            captured = datetime.fromisoformat(item["captured_at"])
            run_id = int(item["run_id"])
        except (KeyError, TypeError, ValueError):
            continue
        if captured > now or now - captured > _REUSE_AGE:
            continue
        run = db.get(AutomationDiscoveryRun, run_id)
        if (run and run.status == "completed" and run.application_id == application_id
                and (run.application_url or "").rstrip("/") == address.rstrip("/")
                and str(run.application_environment or "").upper() == environment.upper()
                and run.auth_mode == auth_mode and entry_evidence(run, address)["verified"]):
            return run
    return None


def record_finding(app_key: str, *, environment: str, case_id: int | None, stage: str, run_id: int | None,
                   status: str, action_count: int = 0, unresolved_count: int = 0,
                   journey_id: str | None = None) -> None:
    path = _path(app_key)
    if not path:
        return
    entry = {"case_id": case_id, "environment": environment.upper(), "stage": stage,
             "run_id": run_id, "status": status,
             "action_count": action_count, "unresolved_count": unresolved_count,
             "journey_id": journey_id, "recorded_at": datetime.utcnow().isoformat()}
    try:
        with _LOCK:
            doc = _read(path)
            doc["findings"] = ([item for item in doc.get("findings", []) if isinstance(item, dict)
                and not (item.get("case_id") == case_id and item.get("stage") == stage
                         and item.get("environment") == environment.upper())] + [entry])[-_MAX_FINDINGS:]
            doc.setdefault("scans", [])
            _write(path, doc)
    except OSError:
        logger.warning("Could not index guide finding for application %s", app_key, exc_info=True)


def record_navigation(app_key: str, *, application_id: int, environment: str, address: str, trace: list[dict]) -> None:
    """Reusable route observations, not approved actions or passing tests."""
    path = _path(app_key)
    if not path or not trace:
        return
    parsed_origin = urlparse(address)
    origin = (parsed_origin.scheme, parsed_origin.netloc)
    safe = [{key: row.get(key) for key in ('from_url','to_url','role','label','outcome')}
            for row in trace if row.get('outcome') == 'observed'
            and all((urlparse(str(row.get(key) or '')).scheme, urlparse(str(row.get(key) or '')).netloc) == origin
                    for key in ('from_url','to_url'))]
    try:
        with _LOCK:
            doc = _read(path)
            entry = {'application_id':application_id, 'environment':environment.upper(),
                     'entry_key':_url_key(address), 'trace':safe, 'captured_at':datetime.utcnow().isoformat()}
            doc['navigation_captures'] = (doc.get('navigation_captures', []) + [entry])[-20:]
            _write(path,doc)
    except OSError:
        logger.warning('Could not index navigation evidence for application %s', app_key, exc_info=True)


def navigation_routes(app_key: str, *, application_id: int, environment: str, address: str) -> list[str]:
    path = _path(app_key)
    doc = _read(path) if path else {}
    urls = []
    for entry in doc.get('navigation_captures', []):
        if (entry.get('application_id') != application_id or entry.get('environment') != environment.upper()
                or entry.get('entry_key') != _url_key(address)):
            continue
        try:
            age = datetime.utcnow() - datetime.fromisoformat(entry['captured_at'])
        except (ValueError, KeyError, TypeError):
            continue
        if not timedelta(0) <= age <= _REUSE_AGE:
            continue
        urls.extend(row['to_url'] for row in entry.get('trace', []) if row.get('to_url'))
    # These are recapture hints; the browser must verify them afresh.
    from .discovery import validated_capture_urls
    return validated_capture_urls(address,list(dict.fromkeys(urls)))[:8]


def context(app_key: str, *, application_id: int, environment: str) -> dict:
    path = _path(app_key)
    doc = _read(path) if path else {}
    scans = [item for item in doc.get("scans", []) if isinstance(item, dict)
             and item.get("application_id") == application_id
             and item.get("environment") == environment.upper()
             and item.get("auth_mode") == "none"]
    findings = [item for item in doc.get("findings", []) if isinstance(item, dict)
                and item.get("environment") == environment.upper()]
    kb = store.load(app_key)
    return {"recent_scans": [{key: item.get(key) for key in (
                "run_id", "entry_host", "entry_path", "pages", "controls", "observed_routes", "blocker_count")}
             for item in scans[-3:]],
            "observed_navigation": [item for item in doc.get('navigation_captures', [])
                if item.get('application_id') == application_id and item.get('environment') == environment.upper()][-3:],
            "approved_journeys": [{"journey_id": item.get("journey_id"), "name": item.get("name")}
                                  for item in list((kb.journeys if kb else {}).values())[-12:]],
            "recent_guide_findings": [{key: item.get(key) for key in (
                "case_id", "stage", "status", "run_id", "unresolved_count", "journey_id")}
                                      for item in findings[-12:]]}
