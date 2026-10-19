"""Bounded, evidence-led advice between the public scan and journey mapping.

The model can request another scan, but cannot choose a URL, locator, or
credential. Authentication remains the responsibility of the verified login
plan and Test Data gates in Navigation Guide.
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urlparse


def entry_evidence(run: Any, address: str) -> dict[str, Any]:
    """Report only a successful observation of the registered entry route."""
    wanted = urlparse(address)
    wanted_path = (wanted.path or "/").rstrip("/") or "/"
    pages = run.explored_pages or []
    observed = []
    for page in pages:
        if not isinstance(page, dict):
            continue
        url = str(page.get("url") or "")
        parsed = urlparse(url)
        path = (parsed.path or "/").rstrip("/") or "/"
        try:
            status = int(page.get("status") or 0)
        except (TypeError, ValueError):
            status = 0
        title = str(page.get("title") or "")
        requested = urlparse(str(page.get("requested_url") or ""))
        requested_path = (requested.path or "/").rstrip("/") or "/"
        entry_request = (requested.scheme == wanted.scheme and requested.netloc == wanted.netloc
                         and requested_path == wanted_path)
        if (parsed.scheme == wanted.scheme and parsed.netloc == wanted.netloc
                and (path == wanted_path or entry_request) and 200 <= status < 400
                and not any(marker in title.lower() for marker in ("request rejected", "access denied"))
                and not page.get("blocked_by_overlay")):
            observed.append({"url": url, "status": status, "title": title[:160]})
    return {"verified": bool(observed), "entry": observed[0] if observed else None,
            "pages": len(pages), "controls": int(run.elements_discovered or 0),
            "blockers": len(run.blockers or [])}


def guidance_evidence(run: Any, address: str, *, signed_in_required: bool,
                      login_plan_ready: bool, profile_selected: bool) -> dict[str, Any]:
    """Compact observations; never send captured values or page HTML to the model."""
    def successful(page: dict) -> bool:
        try:
            status = int(page.get("status") or 0)
        except (TypeError, ValueError):
            return False
        return (200 <= status < 400 and not page.get("blocked_by_overlay")
                and not any(word in str(page.get("title") or "").lower()
                            for word in ("request rejected", "access denied")))

    origin = urlparse(address)
    pages = []
    for page in (run.explored_pages or [])[:25]:
        if not isinstance(page, dict):
            continue
        parsed = urlparse(str(page.get("url") or ""))
        if parsed.scheme == origin.scheme and parsed.netloc == origin.netloc:
            pages.append({"path": parsed.path or "/", "status": page.get("status"),
                          "title": str(page.get("title") or "")[:120],
                          "blocked_by_overlay": bool(page.get("blocked_by_overlay"))})
    blockers = []
    linked_login = []
    for item in (run.blockers or [])[:8]:
        if not isinstance(item, dict):
            continue
        parsed = urlparse(str(item.get("url") or ""))
        if parsed.scheme == origin.scheme and parsed.netloc == origin.netloc:
            blockers.append({"path": parsed.path or "/", "reason": str(item.get("reason") or "")[:250]})
            if item.get("kind") == "linked_auth":
                target = urlparse(str(item.get("target_url") or ""))
                observed_page = next((page for page in (run.explored_pages or [])
                                      if isinstance(page, dict) and page.get("linked_auth")
                                      and urlparse(str(page.get("url") or "")).netloc == target.netloc
                                      and successful(page)), None)
                names = [str(control.get("accessible_name") or "")[:80]
                         for control in ((observed_page or {}).get("linked_auth_controls") or [])
                         if isinstance(control, dict) and control.get("role") in {"textbox", "button"}]
                linked_login.append({"source_path": parsed.path or "/", "target_origin": target.scheme + "://" + target.netloc,
                                     "target_path": target.path or "/", "public_page_verified": bool(observed_page),
                                     "observed_path": (urlparse(str((observed_page or {}).get("url") or "")).path or None),
                                     "observed_control_names": names[:12], "credential_host_approved": False})
    return {"registered_entry": address, "entry": entry_evidence(run, address),
            "observed_pages": pages, "blocker_count": len(run.blockers or []),
            "blocker_details": blockers,
            "linked_login_candidates": linked_login,
            "signed_in_required": signed_in_required,
            "approved_login_plan_ready": login_plan_ready,
            "test_data_profile_selected": profile_selected}


def allowed_recrawl(action: str, *, already_retried: bool) -> bool:
    """A model request never changes the target and has a one-pass budget."""
    return action == "recrawl" and not already_retried
