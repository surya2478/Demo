"""Application- and screen-scoped controls observed by a browser collector.

Both script generation and runtime healing use this resolver. It never turns
prose into a selector: no unique captured match means no replacement.
"""
from __future__ import annotations

import re
import ast
from dataclasses import dataclass
from typing import Any, Iterable
from urllib.parse import urlparse


_GENERIC = {"a", "an", "the", "field", "input", "textbox", "button", "link", "into", "enter", "click", "on"}


def words(value: Any) -> set[str]:
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", str(value or ""))
    return set(re.findall(r"[a-z0-9]+", text.casefold())) - _GENERIC


def host(value: str | None) -> str:
    return (urlparse(value or "").hostname or "").casefold()


def route(value: str | None) -> str:
    parsed = urlparse(value or "")
    return (parsed.path or "").rstrip("/").casefold()


@dataclass(frozen=True)
class Control:
    label: str
    element_id: str
    selector: str
    kind: str
    source: str
    screen_route: str


def observed_controls(
    application_url: str,
    screen_route: str | None,
    discovered: Iterable[dict[str, Any]] | None = None,
) -> list[Control]:
    """Only controls captured on the requested host and exact screen route."""
    expected_host, expected_route = host(application_url), route(screen_route)
    if not expected_host:
        return []
    controls: list[Control] = []
    try:
        from ..journeys import store

        for app_id in store.list_apps():
            kb = store.load(app_id)
            if not kb or host(store.automation_profile(kb).get("base_url")) != expected_host:
                continue
            for screen in kb.screens.values():
                screen_path = route(screen.get("route"))
                if expected_route and screen_path != expected_route:
                    continue
                for element in screen.get("elements", []):
                    selector = str(element.get("observed_selector") or "").strip()
                    if selector and selector.startswith(("#", "[", "input[", "button[")) and not any(char in selector for char in "\r\n;`"):
                        controls.append(Control(
                            label=str(element.get("label") or ""),
                            element_id=str(element.get("element_id") or ""),
                            selector=selector,
                            kind=str(element.get("type") or ""),
                            source="journey capture",
                            screen_route=screen_path,
                        ))
    except Exception:
        # A missing or malformed KB must not prevent discovery-only grounding.
        pass

    for element in discovered or []:
        page_url = str(element.get("page_url") or element.get("page") or "")
        if host(page_url) != expected_host or (expected_route and route(page_url) != expected_route):
            continue
        locator = str(element.get("recommended_locator") or "").strip()
        if not locator or any(char in locator for char in "\r\n;`"):
            continue
        controls.append(Control(
            label=str(element.get("accessible_name") or ""),
            element_id=str(element.get("element_name") or ""),
            selector=locator,
            kind=str(element.get("role") or ""),
            source="application discovery",
            screen_route=route(page_url),
        ))
    return controls


def choose_control(target: str, intent: str, controls: Iterable[Control]) -> Control | None:
    """Choose only a unique strong name/id match of a compatible control."""
    query = words(target)
    if not query:
        return None
    ranked: list[tuple[int, Control]] = []
    for control in controls:
        kind = control.kind.casefold()
        if intent == "fill" and kind and not any(token in kind for token in ("input", "textbox", "combobox", "textarea")):
            continue
        if intent == "click" and kind and not any(token in kind for token in ("button", "link", "submit", "checkbox", "radio")):
            continue
        label, element_id = words(control.label), words(control.element_id)
        selector = words(control.selector)
        if query == element_id or query == label:
            score = 100
        elif label and label & query and query <= (label | element_id | selector):
            score = 75 + len(query & label)
        else:
            continue
        ranked.append((score, control))
    if not ranked:
        return None
    highest = max(score for score, _ in ranked)
    winners = [control for score, control in ranked if score == highest]
    # The approved Journey capture identifies the intended control when a
    # discovery crawl also saw another same-named element (for example a
    # navigation link and a submit button). Two Journey controls remain
    # ambiguous; we never pick one by file order.
    journey = [control for control in winners if control.source == "journey capture"]
    if journey:
        winners = journey
    # The same captured CSS and discovery expression can describe one control.
    # If their selectors differ, do not guess which one is current.
    unique: dict[str, Control] = {}
    for control in winners:
        key = canonical_selector(control.selector)
        if key not in unique or control.source == "journey capture":
            unique[key] = control
    return next(iter(unique.values())) if len(unique) == 1 else None


def canonical_selector(selector: str) -> str:
    """Treat captured CSS and page.locator(CSS) as the same evidence."""
    value = selector.strip()
    wrapped = re.fullmatch(r"page\.locator\((.+?)\)(?:\.first\(\))?", value)
    if wrapped:
        try:
            css = ast.literal_eval(wrapped.group(1))
            if isinstance(css, str):
                return css.strip()
        except (SyntaxError, ValueError):
            pass
    return value
