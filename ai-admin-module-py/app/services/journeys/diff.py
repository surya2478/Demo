"""
--- Journey KB <-> Automation KB: step-level diff --------------------------------

A test case written from the Journey KB speaks the design's language: 'Click
CONTINUE'. The Automation KB speaks the application's: a crawled locator whose
text is RECEIVE OTP. Until now the only bridge between the two was word
overlap in grounding, so the disagreement surfaced as a failed run or a healer
patch, and nobody learned that design and application had drifted.

This module makes the disagreement a report instead. Each step is resolved to
a design element (by the labels and aliases the Journey KB records), the
element's `automation_ref` is followed into the Automation KB profile, and the
two are compared:

  MATCH           design element found, crawled locator found, labels agree.
  LABEL_DRIFT     both found, but the crawled locator's text is not the design
                  label (CONTINUE vs RECEIVE OTP). The step is automatable; the
                  wording is corrected and the drift is worth telling the
                  business about.
  REF_BROKEN      the design element points at an Automation KB entry that no
                  longer exists -- the Automation KB changed under it.
  NOT_CRAWLED     the design element has no Automation KB entry yet. Crawl it.
  NOT_IN_DESIGN   no design element, but an Automation KB grounding rule knows
                  the control. The Journey KB is missing something.
  NO_ELEMENT      an assertion on a screen as a whole; nothing to locate.
  UNRESOLVED      neither KB recognises the step.

Pure functions over data: no browser, no model call, no database.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

from . import store

MATCH = "MATCH"
LABEL_DRIFT = "LABEL_DRIFT"
REF_BROKEN = "REF_BROKEN"
NOT_CRAWLED = "NOT_CRAWLED"
NOT_IN_DESIGN = "NOT_IN_DESIGN"
NO_ELEMENT = "NO_ELEMENT"
UNRESOLVED = "UNRESOLVED"

# Statuses a compiler can act on without a human.
AUTOMATABLE = {MATCH, LABEL_DRIFT, NO_ELEMENT}

_STOP = {
    "the", "a", "an", "to", "of", "and", "or", "in", "on", "with", "for", "from",
    "is", "are", "be", "that", "this", "it", "as", "by", "at", "into", "click",
    "enter", "open", "verify", "check", "select", "confirm", "user", "page", "screen",
}
_NAV = re.compile(r"\b(navigate|go to|open|launch|land on|load)\b", re.IGNORECASE)
_ASSERT = re.compile(r"^\s*(verify|check|confirm|ensure|observe|validate|assert)\b", re.IGNORECASE)
_SELECTOR_TEXT = re.compile(r"(?:contains\(\s*\.\s*,\s*|text\(\)\s*=\s*)'([^']+)'")


def _tokens(text: str) -> set:
    return {t for t in re.findall(r"[a-z0-9]+", (text or "").lower()) if t not in _STOP and len(t) > 1}


def _clean_label(label: str) -> str:
    """'Username or email*' -> 'username or email'; '(bell icon)' -> ''."""
    label = re.sub(r"\([^)]*\)", "", label or "")
    label = label.strip().rstrip("*.:").strip().strip("'\"")
    return "" if "<" in label else label.lower()


def _phrase_in(phrase: str, text: str) -> bool:
    return bool(phrase) and re.search(r"(?<![a-z0-9])" + re.escape(phrase) + r"(?![a-z0-9])", text) is not None


def _resolve_ref(profile: Dict[str, Any], ref: str) -> Optional[str]:
    node: Any = profile
    for part in ref.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node if isinstance(node, str) and node.strip() else None


def _candidates(kb: store.JourneyKB, chain: List[Dict[str, Any]]) -> List[Tuple[Dict, Dict]]:
    """(screen, element) pairs for every screen the journey chain visits."""
    seen, pairs = set(), []
    for journey in chain:
        for sid in journey.get("screens", []):
            if sid in seen or sid not in kb.screens:
                continue
            seen.add(sid)
            screen = kb.screens[sid]
            pairs += [(screen, element) for element in screen.get("elements", [])]
    return pairs


def _score_element(step_text: str, element: Dict[str, Any]) -> int:
    lowered = step_text.lower()
    best = 0
    for phrase in [_clean_label(element.get("label", ""))] + [a.lower() for a in element.get("aliases", [])]:
        if _phrase_in(phrase, lowered):
            best = max(best, 10 + len(phrase.split()))
    return best


def _journey_step_hint(step_text: str, chain: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The journey step this test step was written from, when it clearly was.

    Test cases generated with the Journey KB mirror its step wording; when at
    least 60% of a journey step's content words reappear, its screen/element
    ids are the best evidence available.
    """
    step_tokens = _tokens(step_text)
    best, best_ratio = None, 0.0
    for journey in chain:
        for js in journey.get("steps", []):
            js_tokens = _tokens(js.get("action", ""))
            if not js_tokens:
                continue
            ratio = len(js_tokens & step_tokens) / len(js_tokens)
            if ratio > best_ratio:
                best, best_ratio = js, ratio
    return best if best_ratio >= 0.6 else None


def _find_element(kb, chain, step_text, step) -> Tuple[Optional[Dict], Optional[Dict], str]:
    """(screen, element, how) for a step, or (screen, None, how) / (None, None, how)."""
    if step.get("screen_id") and step.get("element_id"):
        screen = kb.screens.get(step["screen_id"])
        element = next((e for e in (screen or {}).get("elements", []) if e["element_id"] == step["element_id"]), None)
        if element:
            return screen, element, "ids on the step"

    scored = sorted(
        ((_score_element(step_text, e), s, e) for s, e in _candidates(kb, chain)),
        key=lambda item: item[0],
        reverse=True,
    )
    if scored and scored[0][0] > 0:
        return scored[0][1], scored[0][2], "label/alias in the step text"

    hint = _journey_step_hint(step_text, chain)
    if hint and hint.get("element_id"):
        screen = kb.screens.get(str(hint.get("screen_id", "")).split("|")[0])
        element = next((e for e in (screen or {}).get("elements", []) if e["element_id"] == hint["element_id"]), None)
        if element:
            return screen, element, f"journey step {hint['step_number']} wording"

    # A navigation or whole-screen assertion names a screen, not a control.
    lowered = step_text.lower()
    for journey in chain:
        for sid in journey.get("screens", []):
            screen = kb.screens.get(sid) or {}
            names = [screen.get("name", "").lower()] + [a.lower() for a in screen.get("aliases", [])]
            if any(_phrase_in(n, lowered) for n in names if n):
                return screen, None, "screen name in the step text"
    if hint:
        screen = kb.screens.get(str(hint.get("screen_id", "")).split("|")[0])
        return screen, None, f"journey step {hint['step_number']} wording"
    return None, None, "nothing matched"


def _automation_rule_for(step_text: str, profile: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    lowered = step_text.lower()
    for rule in profile.get("step_grounding_rules") or []:
        if rule.get("first_step_only"):
            continue
        if any(str(k).lower() in lowered for k in rule.get("keywords") or []):
            return rule
    return None


def diff_step(
    step: Dict[str, Any] | str,
    kb: store.JourneyKB,
    chain: List[Dict[str, Any]],
    profile: Dict[str, Any],
) -> Dict[str, Any]:
    step = {"action": step} if isinstance(step, str) else dict(step)
    text = str(step.get("action") or "")
    # Refine puts the control's exact label in `target`; it is the most direct
    # evidence of which element a step means, so it is matched alongside the
    # prose. Corrections below still rewrite the action only.
    target = str(step.get("target") or "").strip()
    match_text = f"{text} {target}" if target and target.lower() not in text.lower() else text
    screen, element, how = _find_element(kb, chain, match_text, step)
    result: Dict[str, Any] = {
        "step_number": step.get("step_number"),
        "action": text,
        "screen_id": (screen or {}).get("screen_id"),
        "element_id": (element or {}).get("element_id"),
        "design_label": (element or {}).get("label"),
        "resolved_by": how,
        "automation_ref": None,
        "automation_target": None,
        "app_labels": [],
        "status": UNRESOLVED,
        "suggestion": None,
    }

    if element is None:
        if screen is not None and _NAV.search(text) and screen.get("route_ref"):
            route = _resolve_ref(profile, screen["route_ref"])
            result.update(automation_ref=screen["route_ref"], automation_target=route)
            result["status"] = MATCH if route else REF_BROKEN
            if not route:
                result["suggestion"] = f"Automation KB has no '{screen['route_ref']}'; re-crawl or fix the Journey KB reference."
            return result
        rule = _automation_rule_for(match_text, profile)
        if rule and not _ASSERT.match(text):
            result.update(status=NOT_IN_DESIGN, automation_ref=f"step_grounding_rules.{rule.get('id')}",
                          automation_target=rule.get("target"))
            result["suggestion"] = f"The Automation KB knows this control (rule '{rule.get('id')}'); add it to the Journey KB screen it belongs to."
            return result
        if screen is not None:
            result["status"] = NO_ELEMENT
            return result
        result["suggestion"] = "Neither KB recognises this step. Reword it with a label from the Journey KB, or extend the Journey KB."
        return result

    compared = compare_element(screen or {}, element, profile)
    result.update({k: compared[k] for k in ("status", "automation_ref", "automation_target", "app_labels", "suggestion")})
    if compared["status"] == LABEL_DRIFT:
        app_label = compared["app_labels"][0]
        uses_app = any(_phrase_in(a.lower(), text.lower()) for a in compared["app_labels"])
        result["suggestion"] = (
            f"Design says '{element['label']}', the application shows '{app_label}'. "
            + ("The step already uses the application's label." if uses_app
               else f"Reword the step to '{app_label}' for automation and confirm the intended label with the business.")
        )
        if not uses_app:
            result["corrected_action"] = re.sub(re.escape(element["label"]), app_label, text, flags=re.IGNORECASE)
    return result


def compare_element(screen: Dict[str, Any], element: Dict[str, Any], profile: Dict[str, Any]) -> Dict[str, Any]:
    """One design element against the Automation KB: the heart of every diff.

    Used for a test case's steps (diff_step) and for the Knowledge Base page's
    element-level Reconcile, so the two can never disagree about an element.
    """
    ref = element.get("automation_ref")
    out: Dict[str, Any] = {
        "status": NOT_CRAWLED, "automation_ref": ref, "automation_target": None,
        "app_labels": [], "suggestion": None,
    }
    if not ref:
        out["suggestion"] = (
            f"Crawl {screen.get('name') or 'this screen'} and capture this control "
            f"(locator hint: {element.get('locator_hint') or element.get('label')})."
        )
        return out
    target = _resolve_ref(profile, ref)
    if not target:
        out["status"] = REF_BROKEN
        out["suggestion"] = f"Automation KB has no '{ref}' any more; re-crawl, or update the Journey KB reference."
        return out
    out["automation_target"] = target
    out["app_labels"] = _SELECTOR_TEXT.findall(target)
    # The design label, plus any label a Reconcile decision accepted ("both").
    accepted = [_clean_label(element.get("label", ""))] + [_clean_label(a) for a in element.get("accepted_labels", [])]
    design = accepted[0]
    if out["app_labels"] and design and not any(label == a.strip().lower() for a in out["app_labels"] for label in accepted if label):
        out["status"] = LABEL_DRIFT
        out["suggestion"] = f"Design says '{element['label']}', the application shows '{out['app_labels'][0]}'."
        return out
    out["status"] = MATCH
    return out


def _selector_paths(profile: Dict[str, Any]) -> Dict[str, str]:
    """Every selector the Automation KB holds, as {dotted path: selector}."""
    paths: Dict[str, str] = {}

    def walk(node: Any, prefix: str) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                walk(value, f"{prefix}.{key}")
        elif isinstance(node, str) and node.strip():
            paths[prefix] = node

    walk(profile.get("selectors") or {}, "selectors")
    return paths


def reconcile_elements(kb: store.JourneyKB, profile: Dict[str, Any]) -> Dict[str, Any]:
    """Every design element against the Automation KB, plus the reverse.

    Rows for the Journey KB's elements carry compare_element's status. Then
    each Automation KB selector no design element points at becomes a
    NOT_IN_DESIGN row: the application has it, the design never mentioned it.
    """
    rows: List[Dict[str, Any]] = []
    referenced: set = set()
    for screen in kb.screens.values():
        for element in screen.get("elements", []):
            compared = compare_element(screen, element, profile)
            if element.get("automation_ref"):
                referenced.add(element["automation_ref"])
            rows.append({
                "screen_id": screen["screen_id"],
                "screen_name": screen.get("name"),
                "element_id": element["element_id"],
                "design_label": element.get("label"),
                "type": element.get("type"),
                "basis": element.get("basis"),
                "locator_hint": element.get("locator_hint"),
                "journeys": element.get("used_by_journeys") or [
                    j["journey_id"] for j in kb.journeys.values() if screen["screen_id"] in j.get("screens", [])
                ],
                **compared,
            })
    for path, selector in _selector_paths(profile).items():
        if path in referenced:
            continue
        rows.append({
            "screen_id": None, "screen_name": None, "element_id": None, "design_label": None,
            "type": None, "basis": None, "locator_hint": None, "journeys": [],
            "status": NOT_IN_DESIGN, "automation_ref": path, "automation_target": selector,
            "app_labels": _SELECTOR_TEXT.findall(selector),
            "suggestion": "The Automation KB has this control and no Journey KB element points at it; add it to the screen it belongs to, or confirm it is outside the documented journeys.",
        })
    summary: Dict[str, int] = {}
    for row in rows:
        summary[row["status"]] = summary.get(row["status"], 0) + 1
    return {"rows": rows, "summary": summary}


def diff_case(
    steps: List[Dict[str, Any] | str],
    case_text: str = "",
    *,
    app_id: Optional[str] = None,
    journey_id: Optional[str] = None,
    automation_profile: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Diff every step of one test case. `case_text` picks the journey when
    `journey_id` is not given; `automation_profile` defaults to the Automation
    KB profile the Journey KB names."""
    full_text = " ".join([case_text] + [s if isinstance(s, str) else str(s.get("action", "")) for s in steps])
    match = None
    if journey_id:
        for candidate in ([app_id] if app_id else store.list_apps()):
            kb = store.load(candidate)
            if kb and journey_id in kb.journeys:
                match = store.JourneyMatch(kb, kb.journeys[journey_id], 0, [])
                break
    else:
        match = store.match_journey(full_text, app_id)
    if match is None:
        return {"journey_id": None, "reason": "no_journey_matched", "steps": [], "summary": {}, "automatable": False}

    kb = match.kb
    if automation_profile is None:
        automation_profile = store.automation_profile(kb)

    chain = store.journey_scope(kb, match.journey, full_text)
    rows = [diff_step(s, kb, chain, automation_profile) for s in steps]
    summary: Dict[str, int] = {}
    for row in rows:
        summary[row["status"]] = summary.get(row["status"], 0) + 1
    return {
        "app_id": kb.app_id,
        "automation_app_id": kb.automation_app_id,
        "journey_id": match.journey["journey_id"],
        "chain": [j["journey_id"] for j in chain],
        "steps": rows,
        "summary": summary,
        "automatable": all(r["status"] in AUTOMATABLE for r in rows),
    }
