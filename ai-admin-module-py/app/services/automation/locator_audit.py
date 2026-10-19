"""Fast, read-only audit of generated Playwright actions against captured controls.

This checks saved evidence, not the current live DOM. A match is not a promise
that the application has not changed since capture.
"""
from __future__ import annotations

import re
from typing import Any

from .compiler import run_static_gate, sanitize_catalog_locator
from .control_evidence import canonical_selector, choose_control, host, observed_controls, route


_ACTION = re.compile(
    r"(?P<locator>page\.(?:locator|getBy[A-Za-z]+)\(.+?\)(?:\.first\(\))?)"
    r"\.(?P<action>fill|click|check|selectOption|press)\("
)
_NAME = re.compile(r"name:\s*['\"]([^'\"]+)['\"]")
_LABEL = re.compile(r"page\.getBy(?:Label|Placeholder|Text)\(['\"]([^'\"]+)['\"]")


def audit_script(code: str, application_url: str | None, discovered: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Return evidence status for every direct Playwright action in a step."""
    issues = run_static_gate(code, code.count("await test.step("), 0)
    result: dict[str, Any] = {
        "code_errors": [item.message for item in issues if item.level == "error"],
        "code_warnings": [item.message for item in issues if item.level == "warning"],
        "actions": [], "matched": 0, "needs_update": 0, "unverified": 0,
        "scope": "saved_capture_only",
    }
    if not application_url or not host(application_url):
        result["code_warnings"].append("No application URL is linked; locator evidence cannot be scoped.")
    active_route = route(application_url)
    current_step = 0
    cache: dict[str, list] = {}
    for line_number, line in enumerate(code.splitlines(), 1):
        step = re.search(r"await test\.step\(['\"](\d+)\.", line)
        if step:
            current_step = int(step.group(1))
        navigation = re.search(r"(?:navigateTo\(page,\s*|page\.goto\()(['\"])(/[^'\"]+|https?://[^'\"]+)\1", line)
        if navigation:
            destination = navigation.group(2)
            if destination.startswith("/") or host(destination) == host(application_url):
                active_route = route(destination)
        if not current_step or not line.lstrip().startswith("await page."):
            continue
        action = _ACTION.search(line)
        if not action:
            continue
        expression = action.group("locator")
        intent = "fill" if action.group("action") in ("fill", "selectOption") else "click"
        if active_route not in cache:
            cache[active_route] = observed_controls(application_url or "", active_route or None, discovered)
        controls = cache[active_route]
        named = _NAME.search(expression) or _LABEL.search(expression)
        control = choose_control(named.group(1), intent, controls) if named else None
        exact = [item for item in controls if canonical_selector(item.selector) == canonical_selector(expression)]
        # A same-named navigation link can be captured alongside a submit
        # button. The curated screen control wins over an exact discovery
        # expression for the wrong element type.
        if control:
            status = "matched" if canonical_selector(control.selector) == canonical_selector(expression) else "needs_update"
            suggestion = None if status == "matched" else sanitize_catalog_locator(control.selector)
        elif exact:
            status, suggestion = "matched", None
        else:
            status, suggestion = "unverified", None
        result[status] += 1
        result["actions"].append({
            "step": current_step, "line": line_number, "action": action.group("action"),
            "locator": expression, "status": status, "suggested_locator": suggestion,
            "screen_route": active_route,
        })
    return result
