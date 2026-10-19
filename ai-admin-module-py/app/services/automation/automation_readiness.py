"""Evidence-bound readiness check before Automation Expert spends a browser run.

This checks the executable journey-crawl spec, not the final Automation Studio
script (which is compiled only after the case has been refined). A safe pause
before a data-changing action is deliberately not a mapping failure.
"""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse

from ..journeys import journey_crawl


_ACTION = re.compile(r"^\s*(?:click|tap|press|enter|fill|type|select|choose|submit|confirm|save|send|register|sign[ -]?in|log[ -]?in|sign[ -]?out|log[ -]?out)\b", re.I)


def assess_plan(plan: dict[str, Any]) -> dict[str, Any]:
    """Separate code/mapping blockers from controls that need live verification."""
    items = plan.get("items") or []
    issues: list[str] = []
    verify: list[int] = []
    base = urlparse(str(plan.get("base_url") or ""))
    trusted = set(plan.get("trusted_auth_origins") or [])
    auth_journeys = set(plan.get("auth_journey_ids") or [])
    if base.scheme not in {"http", "https"} or not base.hostname:
        issues.append("The application has no valid browser entry address.")
    if not any(item.get("kind") != "skip" for item in items):
        issues.append("The journey has no executable actions.")
    for order, item in enumerate(items, start=1):
        kind = item.get("kind")
        if kind == "skip":
            continue
        number = item.get("step_number") or order
        text = str(item.get("text") or "")
        route = str(item.get("route") or "")
        route_host = urlparse(route).hostname
        route_origin = f"{urlparse(route).scheme}://{urlparse(route).netloc}" if route_host else ""
        if route_host and route_host != base.hostname and not (
                item.get("journey_id") in auth_journeys and route_origin in trusted):
            issues.append(f"Step {number} points outside the registered application host.")
        element = item.get("element")
        if element and item.get("screen_id") and element.get("screen_id") != item["screen_id"]:
            issues.append(f"Step {number} maps a control to a different screen.")
        if _ACTION.match(text):
            if kind not in {"click", "fill", "otp"}:
                issues.append(f"Step {number} has no browser-observed control for its action.")
            elif not element:
                issues.append(f"Step {number} has no browser-observed control for its action.")
            elif kind in {"fill", "otp"} and not item.get("variable"):
                issues.append(f"Step {number} has no selected Test Data value.")
            elif element:
                verify.append(number)
    try:
        code = journey_crawl.build_spec(plan)
        if "from '@playwright/test'" not in code or "const PLAN = " not in code:
            issues.append("The browser-check script is incomplete.")
        if "__PLAN__" in code or "__OUTPUT__" in code or "__ENV_READS__" in code:
            issues.append("The browser-check script still contains an unreplaced template value.")
    except (KeyError, TypeError, ValueError) as exc:
        issues.append(f"The browser-check script could not be built: {exc}")
    return {
        "ready": not issues,
        "issues": list(dict.fromkeys(issues)),
        "browser_verification_steps": list(dict.fromkeys(verify)),
        "risky_step": plan.get("first_risky"),
        "planned_steps": len([item for item in items if item.get("kind") != "skip"]),
        "code_generated": not any("script" in issue.lower() or "spec" in issue.lower() for issue in issues),
    }
