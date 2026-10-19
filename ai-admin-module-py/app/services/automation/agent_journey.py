"""Prepare a reviewable journey from a saved case and observed public controls.

Requirements Guide owns the case-to-steps transcription. Navigation Guide owns
the browser catalogue and may attach a control only when it was actually seen.
No draft is published here; the normal Knowledge Base approval is mandatory.
"""
from __future__ import annotations

import re
import time
import ast
import copy
import json
import threading
from datetime import datetime, timedelta
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urljoin, urlparse

from sqlalchemy.orm import Session

from ...models.automation import AutomationDiscoveredElement, AutomationDiscoveryRun
from ..journeys import changesets, store
from .eligibility import split_steps
from . import workbench as wb


# Discovery rows created by older code do not record their crawl budget. Only
# reuse a run whose requested budget this process actually knows; otherwise
# a former 3-page probe could masquerade as a full 12-page catalogue. A
# restart causes one fresh scan, then subsequent cases can share it.
_SCAN_BUDGETS: dict[int, tuple[int, frozenset[str]]] = {}
_SCAN_BUDGET_LOCK = threading.Lock()


def _remember_scan_budget(run_id: int, max_pages: int, focus_terms: list[str] | None = None) -> None:
    with _SCAN_BUDGET_LOCK:
        if len(_SCAN_BUDGETS) >= 256:
            _SCAN_BUDGETS.pop(next(iter(_SCAN_BUDGETS)))
        _SCAN_BUDGETS[run_id] = (max_pages, frozenset(focus_terms or []))


def _has_scan_budget(run_id: int, max_pages: int, focus_terms: list[str] | None = None) -> bool:
    with _SCAN_BUDGET_LOCK:
        budget, scanned_focus = _SCAN_BUDGETS.get(run_id, (0, frozenset()))
        return budget >= max_pages and frozenset(focus_terms or []).issubset(scanned_focus)


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")[:65] or "step"


def _tokens(value: str) -> set[str]:
    value = re.sub(r"\b(sign[ -]?in|log[ -]?in|login)\b", "login", value.lower())
    return {"confirm" if word in {"confirmation", "confirmed"} else word for word in re.findall(r"[a-z0-9]+", value) if len(word) > 2 and word not in {"the", "and", "for", "with", "that", "from", "page", "user", "click", "enter", "verify", "shown", "registered", "correct", "valid"}}


def _route(url: str) -> str:
    """Session parameters are not part of a reusable screen identity."""
    return (urlparse(url).path or "/").split(";", 1)[0]


def _entry_routes(url: str) -> set[str]:
    """Observed directory index pages may be the registered entry screen."""
    route = _route(url).rstrip("/") or "/"
    if route.endswith(("/index.html", "/index.htm")):
        return {route}
    base = "" if route == "/" else route
    return {route, base + "/index.html", base + "/index.htm"}


def _screen_id(url: str) -> str:
    parsed = urlparse(url)
    return "SCR_" + _slug((parsed.hostname or "") + _route(url)).upper()[:55]


def _element(control: AutomationDiscoveredElement) -> dict:
    role = (control.role or "").lower()
    is_input = role in {"textbox", "searchbox", "spinbutton"}
    label = control.accessible_name or ""
    item = {
        "element_id": _slug(control.element_name or label), "label": label,
        "type": "password_input" if is_input and "password" in label.lower() else "text_input" if is_input else "dropdown" if role == "combobox" else "link" if role == "link" else "button" if role == "button" else "text",
        "locator_hint": f'{role} "{label}"' if role in {"button", "link", "textbox", "searchbox", "heading", "tab", "combobox"} else None,
        "observed_locator": control.recommended_locator,
        "observed_strategy": control.recommended_strategy,
    }
    selector = _observed_selector(control)
    if selector:
        item["observed_selector"] = selector
    return item


def _catalogue(discovery: AutomationDiscoveryRun | None, controls: list[AutomationDiscoveredElement],
               existing: dict[str, dict] | None = None) -> dict[str, dict]:
    """Carry the entire uniquely observed scan into a reviewable, app-scoped draft."""
    if discovery is None:
        return {}
    host = urlparse(discovery.application_url or "").hostname
    existing_routes: dict[str, str] = {}
    for key, screen in (existing or {}).items():
        raw_route = screen.get("route") or ""
        route = _route(raw_route)
        # A historical session URL may masquerade as another screen's route.
        # Keep the canonical route's identity instead of overwriting it.
        if ";" not in raw_route or route not in existing_routes:
            existing_routes[route] = key
    screens: dict[str, dict] = {}
    for page in getattr(discovery, "explored_pages", None) or []:
        if not isinstance(page, dict) or urlparse(page.get("url") or "").hostname != host:
            continue
        if not isinstance(page.get("status"), int) or page["status"] >= 400:
            continue
        address = page["url"]
        route = _route(address)
        key = existing_routes.get(route) or _screen_id(address)
        screens.setdefault(key, {"screen_id": key, "name": page.get("title") or route,
                                 "route": route, "elements": []})
    for control in controls:
        if urlparse(control.page_url or "").hostname != host or int(control.confidence_score or 0) < 70:
            continue
        route = _route(control.page_url)
        key = existing_routes.get(route) or _screen_id(control.page_url)
        screen = screens.setdefault(key, {"screen_id": key, "name": control.page_title or route,
                                           "route": route, "elements": []})
        element = _element(control)
        if not any(item["element_id"] == element["element_id"] for item in screen["elements"]):
            screen["elements"].append(element)
    return screens


def _merge_screens(existing: dict[str, dict], observed: dict[str, dict]) -> list[dict]:
    merged = copy.deepcopy(existing)
    for key, screen in observed.items():
        if key not in merged:
            merged[key] = copy.deepcopy(screen)
            continue
        prior = merged[key]
        prior["route"] = screen["route"]
        prior["name"] = screen["name"]
        elements = {item.get("element_id"): item for item in prior.get("elements") or []}
        for item in screen["elements"]:
            if item["element_id"] in elements:
                elements[item["element_id"]].update(item)
            else:
                prior.setdefault("elements", []).append(item)
    return list(merged.values())


def _action_control_score(action: str, control: AutomationDiscoveredElement) -> int:
    """Conservative action-aware ranking; never map a multi-field fill to one box."""
    lower = action.lower()
    role = (control.role or "").lower()
    label = (control.accessible_name or "").lower()
    words = _tokens(action)
    label_words = _tokens(label)
    if re.match(r"\s*(select|choose)\b", lower) and role not in {"combobox", "listbox", "radio", "option", "button", "link", "tab"}:
        return 0
    if re.match(r"\s*(enter|fill|type)", lower) and ("," in action or " and " in lower):
        return 0
    if re.match(r"\s*(open|visit|go to|navigate)", lower) and role != "link":
        return 0
    if re.match(r"\s*(click|tap|press)", lower) and role not in {"button", "link", "tab"}:
        return 0
    if re.match(r"\s*submit\b", lower) and role != "button":
        return 0
    if re.search(r"\bbutton\b", lower) and role != "button":
        return 0
    if re.search(r"\blink\b", lower) and role != "link":
        return 0
    if re.match(r"\s*(enter|fill|type)", lower) and role not in {"textbox", "searchbox", "spinbutton"}:
        return 0
    overlap = len(words & label_words)
    # A page can be called registration while its navigation link says Register.
    register = bool(re.search(r"registr", lower) and "register" in label)
    if not overlap and not register:
        return 0
    score = overlap * 12 + (24 if register else 0)
    if "confirm" in words and "confirm" in label_words:
        score += 25
    if re.search(r"submit|save|confirm", lower) and role == "button":
        score += 15
    if re.match(r"\s*(open|visit|go to|navigate)", lower) and role == "link":
        score += 15
    return score


def _observed_selector(control: AutomationDiscoveredElement) -> str | None:
    """Only a uniquely verified CSS locator may be carried into a journey."""
    if control.recommended_strategy != "css":
        return None
    expression = control.recommended_locator or ""
    match = re.fullmatch(r"page\.locator\((.+)\)", expression)
    if not match:
        return None
    try:
        selector = ast.literal_eval(match.group(1))
    except (ValueError, SyntaxError):
        return None
    return selector if isinstance(selector, str) and selector.startswith("[") else None


def _entry_navigation(action: str) -> bool:
    """A recovery/registration page is not the application's entry/login page."""
    if re.search(r"\b(forgot|recover|recovery|reset|register|registration|sign.?up)\b", action, re.I):
        return False
    return bool(re.search(r"\b(login|log[ -]?in|sign[ -]?in|home|entry)\b", action, re.I))


def _published_controls(discovery: AutomationDiscoveryRun, screens: dict[str, dict],
                        fresh: list[AutomationDiscoveredElement]) -> list:
    """Reuse previously approved, browser-observed controls for this same app.

    A later crawl may miss a page that an earlier case verified. Published KB
    screens retain that evidence; a new scan must not make it disappear.
    """
    host = urlparse(discovery.application_url or "").hostname
    seen = {(_route(item.page_url), (item.role or "").lower(),
             (item.accessible_name or "").casefold(), item.recommended_locator)
            for item in fresh}
    result = []
    for screen in screens.values():
        route = screen.get("route") or ""
        if not route.startswith("/") or route.startswith("//") or ";" in route:
            continue
        page_url = urljoin(discovery.application_url, route)
        if urlparse(page_url).hostname != host:
            continue
        for element in screen.get("elements") or []:
            kind = element.get("type")
            role = "textbox" if kind in {"text_input", "password_input"} else kind if kind in {"button", "link"} else None
            locator = element.get("observed_locator")
            selector = element.get("observed_selector")
            if not role or not (locator or selector):
                continue
            locator = locator or f"page.locator({selector!r})"
            label = str(element.get("label") or "")
            key = (_route(page_url), role, label.casefold(), locator)
            if key in seen:
                continue
            seen.add(key)
            result.append(SimpleNamespace(
                page_url=page_url, page_title=screen.get("name") or route,
                role=role, accessible_name=label, element_name=element.get("element_id") or "",
                confidence_score=90, href=None, recommended_locator=locator,
                recommended_strategy=element.get("observed_strategy") or ("css" if selector else "role"),
            ))
    return result


def _observation_only(step: str) -> bool:
    return bool(re.match(r"^\s*(?:observe|verify|assert)\b", step, re.I)
                and not re.search(r"\b(?:click|enter|fill|type|select|choose|press|navigate|submit)\b", step, re.I))


def source_expected(row: dict) -> str:
    """Keep observational checks as assertions, not fictional clickable controls."""
    parts = [wb.detail_value(row, "expected")]
    parts.extend(step.strip() for step in split_steps(wb.detail_value(row, "steps")) if _observation_only(step))
    return "\n".join(dict.fromkeys(part for part in parts if part))


def source_steps(row: dict) -> list[str]:
    result: list[str] = []
    for raw in split_steps(wb.detail_value(row, "steps")):
        step = raw.strip()
        if not step or re.fullmatch(r"\d+[.)]", step):
            continue
        if _observation_only(step):
            continue
        # A browser control can fill one field, not a comma-separated form.
        # Expand only plain field lists; instructions with another verb stay
        # intact for a person to check instead of guessing their order.
        match = re.match(r"^(Enter|Fill|Type|Select|Choose)\s+(valid\s+)?(.+)$", step, re.I)
        if match and ("," in match.group(3) or " and " in match.group(3).lower()) and not re.search(r"\b(then|click|press|submit|select|choose|verify|wait|expect|navigate|open|save)\b", match.group(3), re.I) and not re.search(r"(['\"]).*?\band\b.*?\1", match.group(3), re.I):
            fields = [part.strip() for part in re.split(r",\s*|\s+and\s+", match.group(3), flags=re.I) if part.strip()]
            if 2 <= len(fields) <= 20:
                result.extend(f"{match.group(1)} {match.group(2) or ''}{field}" for field in fields)
                continue
        result.append(step)
    return result


def crawl_focus_terms(actions: list[str]) -> list[str]:
    """Prioritize observed links related to the case, without creating routes."""
    stop = {"open", "visit", "navigate", "click", "select", "choose", "enter", "fill", "type",
            "verify", "observe", "page", "site", "home", "guest", "user", "account", "field",
            "button", "link", "valid", "invalid", "observed", "stock", "from", "with", "into",
            "then", "such", "that", "this", "https", "http", "html", "www", "the", "and",
            "using", "actual", "flow", "authorized", "test", "eligible", "inspect", "offered",
            "only", "last", "safe", "review", "point", "before", "final", "correct", "expected"}
    # Preserve the first navigation target as phrases: later branch words
    # must not drown out the offer/page the case needs to reach first.
    terms: list[str] = []
    if actions:
        first = re.sub(r'https?://\S+', ' ', actions[0].lower())
        for fragment in first.split('/'):
            words = [word for word in re.findall(r'[a-z][a-z0-9-]{2,39}', fragment) if word not in stop and word not in {'offer', 'device', 'section'}]
            terms.extend(' '.join(words[i:i + 2]) for i in range(len(words) - 1))
    for action in actions:
        # A URL describes an entry route, not useful semantic link text.
        clean = re.sub(r"https?://\S+", " ", action.lower())
        for term in re.findall(r"[a-z][a-z0-9-]{2,39}", clean):
            if term not in stop and term not in terms:
                terms.append(term)
    return terms[:12]


def discover(db: Session, *, application_id: int, address: str, environment: str, actor: str,
             stop_requested=lambda: False, on_progress=None, on_wait=None, force: bool = False,
             max_pages: int = 12, login_journey_id: str | None = None,
             profile_id: str | None = None, focus_terms: list[str] | None = None,
             reuse_kb_evidence: bool = False, additional_urls: list[str] | None = None, headed: bool = False,
             goal_actions: list[str] | None = None, on_navigation=None,
             on_navigation_progress=None, authoring_fields=None, expected_result='') -> tuple[AutomationDiscoveryRun | None, str | None]:
    """Reuse the versioned discovery service, optionally signing in first."""
    from ...routers import automation as automation_router
    from . import agent_evidence
    from .discovery import validated_capture_urls
    additional_urls = validated_capture_urls(address, additional_urls)
    def covers_extra(run):
        if not additional_urls:
            return True
        observed = {page.get('url') for page in (run.explored_pages or []) if page.get('status') and 200 <= page['status'] < 400 and not page.get('blocked_by_overlay')}
        return set(additional_urls).issubset(observed)

    def capture_goal():
        from . import live_authoring
        captured = live_authoring.author(address, goal_actions, headed=headed,
            fields=authoring_fields, expected_result=expected_result, should_stop=stop_requested,
            on_capture=on_navigation or (lambda capture:None),
            on_progress=on_navigation_progress or (lambda message: None))
        if captured.get('status') == 'authored' and not authoring_fields and not stop_requested():
            if on_navigation_progress:
                on_navigation_progress('Replaying the generated guest script in a clean browser.')
            captured['script_verification'] = live_authoring.replay(captured,headed=headed)
        if on_navigation:
            on_navigation(captured)
        return captured

    if reuse_kb_evidence and not force and not login_journey_id:
        from ...models.automation import AutomationApplication
        application = db.get(AutomationApplication, application_id)
        reusable = agent_evidence.reusable_scan(
            db, app_key=application.app_key, application_id=application_id,
            address=address, environment=environment, max_pages=max_pages,
            focus_terms=focus_terms) if application else None
        if reusable and covers_extra(reusable):
            if goal_actions:
                capture_goal()
                if stop_requested(): return None, 'Discovery was stopped.'
            if on_progress:
                on_progress(reusable)
            return reusable, None

    run = (db.query(AutomationDiscoveryRun)
           .filter(AutomationDiscoveryRun.application_id == application_id,
                   AutomationDiscoveryRun.status == "completed")
           .order_by(AutomationDiscoveryRun.id.desc()).first())
    if (not force and not login_journey_id and run
            and covers_extra(run)
            and run.auth_mode == "none"
            and _has_scan_budget(run.id, max_pages, focus_terms)
            and str(run.application_environment or "").upper() == str(environment or "").upper()
            and (run.application_url or "").rstrip("/") == address.rstrip("/")
            and run.created_at and run.created_at >= datetime.utcnow() - timedelta(minutes=15)):
        if goal_actions:
            capture_goal()
            if stop_requested(): return None, 'Discovery was stopped.'
        return run, None
    try:
        # A fresh crawl follows the case intent before cataloguing its routes.
        # Valid reusable evidence above avoids paying for another live session.
        # Signed-in discovery still belongs to the approved login executor.
        if goal_actions and not login_journey_id:
            captured = capture_goal()
            if stop_requested():
                return None, 'Discovery was stopped.'
            observed_urls = [page['url'] for page in captured['pages']
                if isinstance(page.get('status'), int) and 200 <= page['status'] < 400]
            additional_urls = validated_capture_urls(address, list(dict.fromkeys(additional_urls + observed_urls)))
        for attempt in range(1, 7):
            if stop_requested():
                return None, "Discovery was stopped."
            try:
                run = automation_router.start_discovery(
                    automation_router.DiscoveryRequest(application_id=application_id, application_url=address,
                                                       application_environment=environment, max_pages=max_pages,
                                                       login_journey_id=login_journey_id, profile_id=profile_id,
                                                       focus_terms=focus_terms or [], additional_urls=additional_urls, headless=not headed),
                    db=db, current_user={"username": actor, "role": "admin"},
                )
                break
            except Exception as exc:
                if getattr(exc, "status_code", None) != 429 or attempt == 6:
                    raise
                if on_wait:
                    on_wait(attempt + 1, 6)
                time.sleep(5)
        run_id = run.id if hasattr(run, "id") else run.get("id")
        if not run_id:
            return None, "Discovery did not return a run ID."
        # start_discovery is an HTTP adapter and returns a dictionary. Load the
        # persisted run below before notifying callers: every progress callback
        # needs the same model (including run_key), on its first update too.
        from . import discovery as discovery_service
        # The runner can spend time starting Chromium and writing/absorbing its
        # final catalogue after the crawl's own budget expires. Do not report
        # a false timeout seconds before that completed result is persisted.
        deadline = time.monotonic() + discovery_service.crawl_budget_ms(max_pages) / 1000 + 120
        while time.monotonic() < deadline:
            if stop_requested():
                return None, "Discovery was stopped."
            db.expire_all()
            run = db.get(AutomationDiscoveryRun, run_id)
            if not run:
                return None, "Discovery result was not found."
            automation_router._absorb_discovery_result(db, run)
            if on_progress:
                on_progress(run)
            if run.status in ("completed", "failed"):
                if run.status == "completed":
                    _remember_scan_budget(run.id, max_pages, focus_terms)
                    agent_evidence.record_scan(db, run, max_pages=max_pages, focus_terms=focus_terms)
                return (run, None) if run.status == "completed" else (None, run.error or "Discovery failed.")
            time.sleep(2)
        return None, "Browser discovery did not finish within its crawl budget."
    except Exception as exc:  # A draft can still be reviewed without observed selectors.
        return None, str(getattr(exc, "detail", None) or exc)


def observed_mapping(db: Session, discovery: AutomationDiscoveryRun | None, actions: list[str],
                     expected: str | None = None,
                     existing_screens: dict[str, dict] | None = None,
                     editor_notes: list[str] | None = None) -> tuple[list[dict], dict[str, dict], list[str]]:
    """Map actions in page order, preserving only unique, observed controls."""
    fresh = (db.query(AutomationDiscoveredElement)
             .filter(AutomationDiscoveredElement.discovery_run_id == discovery.id).all()) if discovery else []
    candidates = list(fresh) + (_published_controls(discovery, existing_screens or {}, fresh) if discovery else [])
    entry_routes = _entry_routes(discovery.application_url or "") if discovery else set()
    screens = _catalogue(discovery, candidates, existing_screens)
    editor_pool = None
    editor_future = None
    prepared: list[dict] = []
    unresolved: list[str] = []
    entry_navigation_steps: set[int] = set()
    routes_at_step: list[str | None] = []
    current_route: str | None = None
    for number, action in enumerate(actions, 1):
        routes_at_step.append(current_route)
        navigation = bool(re.match(r"\s*(open|visit|go to|navigate)", action, re.I))
        # Opening the entry/login page is a page navigation, not a click on a
        # fictional link. It is grounded by the visited page itself.
        if navigation and not current_route and discovery:
            entry_pages = [screen for screen in screens.values()
                           if screen["route"].rstrip("/") in entry_routes]
            action_urls = re.findall(r"https?://[^\s<>\"']+", action)
            explicit_entry_url = any(
                urlparse(value.rstrip(".,)")).hostname == urlparse(discovery.application_url).hostname
                and _route(value.rstrip(".,)")).rstrip("/") in entry_routes
                for value in action_urls
            )
            if entry_pages and (_entry_navigation(action) or explicit_entry_url):
                screen = next((item for item in entry_pages if any(
                    "login" in _tokens(element.get("label") or "") for element in item["elements"])), entry_pages[0])
                current_route = screen["route"]
                prepared.append({"step_number": number, "action": action,
                                 "expected_result": expected if number == len(actions) else None,
                                 "screen_id": screen["screen_id"], "element_id": None})
                entry_navigation_steps.add(number)
                continue
        quoted = re.findall(r"['\"]([^'\"]{2,90})['\"]", action)
        target = quoted[0] if quoted else ""
        words = _tokens(target or action)
        ranked: list[tuple[int, AutomationDiscoveredElement]] = []
        for control in candidates:
            route = _route(control.page_url)
            if urlparse(control.page_url).hostname != urlparse(discovery.application_url).hostname or int(control.confidence_score or 0) < 70:
                continue
            if current_route and not navigation and route != current_route:
                continue
            label = control.accessible_name or ""
            overlap = len(words & _tokens(label))
            exact = bool(target and target.casefold() == label.casefold())
            score = _action_control_score(action, control)
            if not exact and not (score > 0 and (overlap >= 1 or re.search(r"registr", action, re.I))):
                continue
            home = bool(not current_route and route.rstrip("/") in entry_routes)
            ranked.append(((100 if exact else score) * 10 + int(control.confidence_score or 0) + (300 if home else 0), control))
        ranked.sort(key=lambda pair: pair[0], reverse=True)
        selected = ranked[0][1] if ranked and (len(ranked) == 1 or ranked[0][0] > ranked[1][0]) else None
        screen_id = element_id = None
        if selected:
            screen_id = next((key for key, screen in screens.items() if screen["route"] == _route(selected.page_url)), _screen_id(selected.page_url))
            element_id = _slug(selected.element_name or selected.accessible_name or action)
            screen = screens.setdefault(screen_id, {"screen_id": screen_id, "name": selected.page_title or selected.page_url,
                                                    "route": _route(selected.page_url), "elements": []})
            if not any(item["element_id"] == element_id for item in screen["elements"]):
                screen["elements"].append(_element(selected))
            if (selected.role or "").lower() == "link" and selected.href:
                current_route = _route(urljoin(selected.page_url, selected.href))
            elif current_route is None:
                current_route = _route(selected.page_url)
        else:
            unresolved.append(f"Step {number}: {action}")
        prepared.append({"step_number": number, "action": action,
                         "expected_result": expected if number == len(actions) else None,
                         "screen_id": screen_id, "element_id": element_id})
    if editor_notes is not None and discovery:
        from . import expert_editor
        editor_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="expert-editor")
        snapshots = [{"candidate_id": index, "page_url": item.page_url, "role": item.role,
                      "accessible_name": item.accessible_name, "confidence_score": item.confidence_score}
                     for index, item in enumerate(candidates)]
        editor_future = editor_pool.submit(expert_editor.review, actions, snapshots,
                                           discovery.application_url, routes_at_step)
    if editor_future is not None:
        try:
            editor_notes.append(f"Cross-checked {len(prepared)} journey action(s) against {sum(len(screen['elements']) for screen in screens.values())} uniquely observed controls across {len(screens)} scanned screens.")
            report = editor_future.result()
            editor_notes.append(report.note)
            # A keyword score may shortlist a control, but may not approve it.
            # Keep page-only navigation grounded by the observed URL; require
            # an explicit semantic agreement for every control binding.
            for step in prepared:
                number = step["step_number"]
                if step.get("element_id") and number not in report.choices:
                    step["screen_id"] = None
                    step["element_id"] = None
                    editor_notes.append(f"Step {number}: Expert Editor did not confirm the control; mapping held.")
            for number, choice in report.choices.items():
                if not 1 <= number <= len(prepared) or not isinstance(choice.candidate_id, int) or not 0 <= choice.candidate_id < len(candidates):
                    continue
                if number in entry_navigation_steps:
                    editor_notes.append(f"Step {number}: opening the observed entry page needs no clicked control; ignored a link suggestion.")
                    continue
                step = prepared[number - 1]
                control = candidates[choice.candidate_id]
                route = _route(control.page_url)
                active = routes_at_step[number - 1]
                if active and route != active and not re.match(r"\s*(open|visit|go to|navigate)", step["action"], re.I):
                    editor_notes.append(f"Step {number}: held semantic suggestion on a different screen.")
                    continue
                if not active and not re.match(r"\s*(open|visit|go to|navigate)", step["action"], re.I):
                    if route.rstrip("/") not in entry_routes:
                        editor_notes.append(f"Step {number}: held semantic suggestion without an established screen.")
                        continue
                equivalent_controls = [item for item in candidates
                                       if _route(item.page_url) == route and item.role == control.role
                                       and item.accessible_name == control.accessible_name
                                       and int(item.confidence_score or 0) >= 70]
                if {item.recommended_locator for item in equivalent_controls} != {control.recommended_locator}:
                    editor_notes.append(f"Step {number}: held ambiguous browser controls.")
                    continue
                if step["element_id"]:
                    if step["element_id"] == _slug(control.element_name or control.accessible_name or ""):
                        editor_notes.append(f"Step {number}: agreed with Navigation Guide — {choice.reason[:180]}")
                    else:
                        step["screen_id"] = None
                        step["element_id"] = None
                        editor_notes.append(f"Step {number}: conflicting semantic match; held for review instead of publishing either control — {choice.reason[:180]}")
                    continue
                if not _action_control_score(step["action"], control) and not choice.equivalent:
                    continue
                key = next((screen_id for screen_id, screen in screens.items() if screen["route"] == route), None)
                if not key or not any(item["element_id"] == _slug(control.element_name or control.accessible_name or "")
                                      for item in screens[key]["elements"]):
                    continue
                step["screen_id"] = key
                step["element_id"] = _slug(control.element_name or control.accessible_name or "")
                editor_notes.append(f"Step {number}: mapped equivalent wording to browser control “{control.accessible_name}” — {choice.reason[:180]}")
            unresolved = [f"Step {step['step_number']}: {step['action']}" for step in prepared
                          if not step.get("screen_id") or (not re.match(r"\s*(open|visit|go to|navigate)", step["action"], re.I)
                                                            and not step.get("element_id"))]
        except Exception:
            # A failed model review is not a successful mapping. The caller
            # exposes the failure and offers a selected-case retry.
            raise
        finally:
            editor_pool.shutdown(wait=True)
    return prepared, screens, unresolved


def draft_from_case(db: Session, *, app_id: str, case_id: int, row: dict, actor: str,
                    discovery: AutomationDiscoveryRun | None,
                    editor_notes: list[str] | None = None, actions_override: list[str] | None = None,
                    prerequisite_journeys: list[str] | None = None,
                    observed_bindings: list[dict] | None = None,
                    observed_screens: dict[str, dict] | None = None,
                    login_profile: tuple[str, dict] | None = None,
                    authentication_profile_id: str | None = None,
                    authored_capture: dict | None = None) -> tuple[int, str, list[str]]:
    kb = store.load(app_id)
    if kb is None:
        raise ValueError("Register the application first so the agents have a Journey KB to draft into.")
    actions = actions_override if actions_override is not None else source_steps(row)
    if not actions:
        raise ValueError("This case has no action steps to turn into a journey. Add the steps to the saved case first.")
    title = wb.detail_value(row, "description") or f"Test case {case_id}"
    prefix = kb.manifest.get("id_prefix") or "APP"
    chapter_id = f"{prefix}.AGENT_PREPARED"
    suffix = _slug(title).upper()[:45]
    journey_file = f"journeys/{_slug(title)}_{case_id}.json"
    journey_path = kb.directory / journey_file
    previous = json.loads(journey_path.read_text(encoding="utf-8")) if journey_path.exists() else None
    if previous and (previous.get("source") or {}).get("case_id") != case_id:
        raise ValueError("An existing journey file belongs to a different case; no changes were made.")
    journey_id = (previous or {}).get("journey_id") or f"{chapter_id}.{suffix}"
    taken = set(kb.journeys) | {node.get("id") for node in kb.taxonomy.get("nodes", [])}
    if not previous and journey_id in taken:
        journey_id = f"{journey_id}_{case_id}"
    overlay_file = "sources/taxonomy_overlay.json"
    overlay = json.loads((kb.directory / overlay_file).read_text(encoding="utf-8"))
    nodes = list(overlay.get("added_nodes") or [])
    if chapter_id not in taken and not any(node.get("id") == chapter_id for node in nodes):
        nodes.append({"id": chapter_id, "title": "Agent-prepared journeys", "parent": None})
    if not any(node.get("id") == journey_id for node in nodes):
        nodes.append({"id": journey_id, "title": title[:180], "parent": chapter_id, "kind": "journey"})

    if observed_bindings is not None:
        # Internal bootstrap bindings were selected by the editor and checked
        # against this exact discovery catalogue before reaching this point.
        prepared, unresolved = observed_bindings, []
        controls = (db.query(AutomationDiscoveredElement).filter(AutomationDiscoveredElement.discovery_run_id == discovery.id).all()
                    if discovery else [])
        screens = observed_screens if observed_screens is not None else _catalogue(discovery, controls, kb.screens)
    else:
        prepared, screens, unresolved = observed_mapping(db, discovery, actions, source_expected(row), kb.screens,
                                                         editor_notes=editor_notes)
    existing_screens = json.loads((kb.directory / "screens.json").read_text(encoding="utf-8"))["screens"]
    merged_screens = _merge_screens(kb.screens, screens)
    journey = {
        "journey_id": journey_id, "name": title[:180], "journey_path": ["Agent-prepared journeys", title[:180]],
        "summary": wb.detail_value(row, "description"), "audience": "authenticated" if re.search(r"sign.?in|log.?in|account", " ".join(actions), re.I) else "anonymous",
        "screens": list(dict.fromkeys(step["screen_id"] for step in prepared if step.get("screen_id"))), "prerequisite_journeys": prerequisite_journeys or [], "next_journeys": [],
        "match_keywords": [title[:100]],
        "steps": prepared, "business_rules": [], "conditional_branches": [],
        "test_scenarios": [], "open_questions": ["These steps have no observed control yet: " + "; ".join(unresolved)] if unresolved else [],
        "source": {"kind": "agent_prepared", "case_id": case_id, "discovery_id": discovery.id if discovery else None},
    }
    if authored_capture:
        from .live_authoring import script
        journey['source']['live_authoring'] = authored_capture
        journey['source']['generated_script'] = script(authored_capture, title[:180])
    changes = [{"file": overlay_file, "op": "set", "path": "added_nodes", "value": nodes,
                "note": "Requirements Guide placed this source case in the Journey KB."}]
    if previous:
        # A stage retry repairs the same case's journey. Recreating its file
        # fails, while a new file would duplicate a published journey.
        for key in ("steps", "screens", "open_questions", "source", "prerequisite_journeys"):
            changes.append({"file": journey_file, "op": "set", "path": key, "value": journey[key],
                            "note": "Refresh this case's journey from current browser evidence."})
    else:
        changes.append({"file": journey_file, "op": "create", "path": "$", "value": journey,
                        "note": "Draft actions come from the saved case; mapped controls come from public browser discovery."})
    if authentication_profile_id:
        journey["authentication_profile_id"] = authentication_profile_id
        if previous:
            changes.append({"file": journey_file, "op": "set", "path": "authentication_profile_id",
                            "value": authentication_profile_id, "note": "Use the verified login prerequisite."})
    if merged_screens != existing_screens:
        changes.append({"file": "screens.json", "op": "set", "path": "screens", "value": merged_screens,
                        "note": "Navigation Guide captured every uniquely verified public control across the application's scanned pages."})
    if login_profile:
        profile_id, profile = login_profile
        changes.append({"file": "roles.json", "op": "set", "path": f"test_data_profiles.{profile_id}", "value": profile,
                        "note": "Observed login field bindings only; credentials remain in environment Test Data."})
    proposal = changesets.draft(db, app_id=app_id, kb="journey", source="agent-review",
                                title=f"Agent-prepared journey: {title[:190]}", changes=changes,
                                description=f"Case {case_id}; {len(actions)} source steps; {len(unresolved)} controls still need mapping. Review before publishing.",
                                origin={"ai_check_case_id": case_id, "discovery_id": discovery.id if discovery else None}, actor=actor)
    return proposal.id, journey_id, unresolved


def repair_published(db: Session, *, app_id: str, journey_id: str, journey_file: str,
                     case_id: int, row: dict, actor: str,
                     discovery: AutomationDiscoveryRun,
                     editor_notes: list[str] | None = None) -> tuple[int | None, list[str]]:
    """Prepare a versioned repair of an approved journey, never edit it in place."""
    kb = store.load(app_id)
    if kb is None or journey_id not in kb.journeys:
        raise ValueError("The approved journey is no longer available.")
    if not journey_file.startswith("journeys/") or not journey_file.endswith(".json"):
        raise ValueError("The approved journey file could not be identified safely.")
    actions = source_steps(row)
    current = kb.journeys[journey_id]
    prepared, observed_screens, unresolved = observed_mapping(
        db, discovery, actions, source_expected(row), kb.screens, editor_notes=editor_notes)
    old_steps = current.get("steps") or []
    # Never erase a previously confirmed mapping because a later scan missed it.
    previous_by_action = {step.get("action"): step for step in old_steps}
    for step in prepared:
        previous = previous_by_action.get(step["action"]) or {}
        if not step.get("screen_id") and previous.get("screen_id") and previous.get("element_id"):
            step["screen_id"] = previous["screen_id"]
            step["element_id"] = previous["element_id"]
    unresolved = [f"Step {step['step_number']}: {step['action']}" for step in prepared
                  if not step.get("screen_id") or (not re.match(r"\s*(open|visit|go to|navigate)", step["action"], re.I) and not step.get("element_id"))]
    merged_screens = _merge_screens(kb.screens, observed_screens)
    if prepared == old_steps and merged_screens == list(kb.screens.values()):
        return None, unresolved
    changes = [
        {"file": journey_file, "op": "set", "path": "steps", "value": prepared,
         "note": "Navigation Guide linked steps to uniquely observed browser controls."},
        {"file": journey_file, "op": "set", "path": "screens", "value": list(dict.fromkeys(
            [step["screen_id"] for step in prepared if step.get("screen_id")])),
         "note": "Include the screens used by the repaired journey."},
        {"file": journey_file, "op": "set", "path": "open_questions", "value": [
            "These steps have no observed control yet: " + "; ".join(unresolved)] if unresolved else [],
         "note": "Keep unresolved steps explicit."},
        {"file": "screens.json", "op": "set", "path": "screens", "value": merged_screens,
         "note": "Use controls and unique CSS selectors verified in browser discovery."},
    ]
    proposal = changesets.draft(
        db, app_id=app_id, kb="journey", source="agent-repair",
        title=f"Browser-verified controls for {current.get('name') or journey_id}"[:300], changes=changes,
        description=f"Case {case_id}; browser discovery #{discovery.id}; {len(unresolved)} steps still need mapping.",
        origin={"ai_check_case_id": case_id, "discovery_id": discovery.id, "journey_id": journey_id}, actor=actor,
    )
    return proposal.id, unresolved
