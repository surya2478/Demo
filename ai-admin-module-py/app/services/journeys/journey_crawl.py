"""
--- Journey-guided crawl ---------------------------------------------------------

Discovery walks an application page by page and catalogues what it finds; it
cannot know which of forty controls is the "RECEIVE OTP" button of a sign-in
journey, so the catalogue and the Journey KB never met. This crawl starts
from the other end: it walks a Journey KB journey step by step -- the same
steps test cases are written from -- and, for every design element on the way,
tries to find it in the running application:

  1. the Automation KB's selector for it, when there is one (confirming it),
  2. the element's locator hint (role + accessible name),
  3. its label, placeholder and exact text, then its aliases.

Whatever resolves is turned into a unique XPath built from the live DOM and
counted before it is recorded, so a captured selector is known to exist and
to match exactly one element. The walk performs each step's action (fill,
enter the OTP, click) with values from the test-data vault, read through
process.env.TESTDATA_* so the runner's existing resolution, blocking and
redaction apply unchanged; no value passes through this module.

The result is not written anywhere. It becomes a pair of change sets -- the
captured selectors for the Automation KB (source "crawl", the only source
allowed to change it) and the matching automation_ref links for the Journey
KB -- which a reviewer approves like any other.

--- The walk engine: a journey or a flow, watched as it runs -----------------
The same spec walks a flow blueprint (build_flow_plan): its canonical steps
become open / fill / click / look-for items, checked against the flow's own
selectors. While it runs it writes its progress (PROGRESS_FILE) and a frame
of the page about once a second (FRAME_FILE), which the Knowledge Base page
shows live; video and trace are the run's own evidence, for replay.

--- Following the journey's path ------------------------------------------------
A journey walk starts at the environment's address and nothing else; the
application opens its own first screen. Screens are recognised by what is on
them (their markers), never by a recorded URL, and each action the design
says leads somewhere waits for one of its outcomes (the screens' transitions).
The test data picks the journey's scenario, and so the expected outcome. An
error, a different branch, or nothing happening takes the walk off the path:
the steps after it are reported blocked, with the reason, rather than missing.
The address each screen was found at is proposed back to the Knowledge Bases.
Typed values are painted over in screenshots and live frames.

A walk stops before step `stop_before`, and -- unless allowed -- before the
first step that would submit, confirm, pay, save or delete something
(apply_stop), so a dry run against a shared environment changes nothing.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional

from . import diff, store

OUTPUT_FILE = "journey_crawl.json"
SPEC_FILE = "journey_crawl.spec.ts"
PROGRESS_FILE = "walk_progress.json"
FRAME_FILE = "live.png"

INPUT_TYPES = {"text_input", "password_input", "search_input"}
CLICK_TYPES = {"button", "link", "tab", "nav_link", "menu_item", "menu_trigger", "icon_button", "control", "card_list"}
_VERIFY = re.compile(r"^\s*(verify|check|confirm|ensure|observe|validate)\b", re.IGNORECASE)
_NAVIGATE = re.compile(r"\b(navigate|go to|open the .*page|launch)\b", re.IGNORECASE)


# --- Locator hints ----------------------------------------------------------------

_HINT = re.compile(r'^\s*(?P<roles>[a-z/]+)\s+(?:(?P<contains>containing)\s+)?(?:"(?P<name>[^"]*)"|/(?P<regex>[^/]+)/|(?P<rest>.+))?\s*$', re.IGNORECASE)
ROLE_WORDS = {"button", "link", "tab", "textbox", "checkbox", "heading", "searchbox", "listitem", "menuitem", "radio", "combobox", "alert", "dialog"}


def parse_hint(hint: Optional[str]) -> Dict[str, Any]:
    """'button "CONTINUE"' -> {"roles": ["button"], "name": "CONTINUE"}; see the tests."""
    match = _HINT.match(hint or "")
    if not match:
        return {}
    roles = [r for r in match.group("roles").lower().split("/") if r in ROLE_WORDS]
    out: Dict[str, Any] = {"roles": roles}
    name = match.group("name")
    if match.group("regex"):
        out["regex"] = match.group("regex")
    elif name is not None:
        if "<" in name:
            out["placeholder_name"] = True  # e.g. "<organization name>": filled from test data
        elif match.group("contains"):
            out["contains"] = name
        else:
            out["name"] = name
    return out


def _clean(label: Optional[str]) -> str:
    label = re.sub(r"\([^)]*\)", "", label or "").strip().rstrip("*.:").strip()
    return "" if "<" in label else label


# --- The plan ---------------------------------------------------------------------

def _profile_variable(profile: Dict[str, Any], *words: str) -> Optional[str]:
    # The display name only: variable names carry the profile's own words
    # (TESTDATA_MULTI_ORG_EMAIL contains "org") and would match the wrong field.
    for field in profile.get("fields", []):
        tokens = set(re.findall(r"[a-z]+", str(field.get("name", "")).lower()))
        if tokens & set(words):
            return field.get("variable")
    return None


def _descriptor(kb: store.JourneyKB, screen: Dict[str, Any], element: Dict[str, Any], automation: Dict[str, Any]) -> Dict[str, Any]:
    ref = element.get("automation_ref")
    target = diff._resolve_ref(automation, ref) if ref else None
    etype = element.get("type")
    return {
        "screen_id": screen["screen_id"],
        "element_id": element["element_id"],
        "label": element.get("label"),
        "clean_label": _clean(element.get("label")),
        "aliases": [a for a in element.get("aliases", []) if a and "<" not in a],
        # Labels a Reconcile decision accepted ("both"); aliases only help matching.
        "accepted_labels": list(element.get("accepted_labels", [])),
        "type": etype,
        "hint": parse_hint(element.get("locator_hint")),
        "kb_ref": ref,
        # A selector the Automation KB already holds is tried first: finding
        # it confirms it; missing it is itself a finding.
        # Routes ("/b2bportal/home.html") are not selectors; XPaths ("//a") are.
        "kb_target": target if target and not (target.startswith("/") and not target.startswith("//")) else None,
        "group": etype == "otp_input_group",
        "is_input": etype in INPUT_TYPES,
    }


# --- Knowing where the walk is ------------------------------------------------------
# A screen is recognised by what is on it, not by its address: one address can
# show several screens (a dialog over a page) and a screen's address is often
# not recorded. Each screen's markers are the design elements most likely to
# be found (an Automation KB selector first, then a role and name, then a
# label); the walk takes a screen as shown when enough of them are visible.

# Elements that appear only on some outcomes, or carry no findable text.
_NOT_MARKERS = {"inline_error", "status_icon", "toast", "static_panel", "dialog", "tile_list"}
MARKERS_PER_SCREEN = 6


def _path_of(route: Optional[str]) -> Optional[str]:
    match = re.match(r"^(?:https?://[^/?#]+)?(/[^?#]*)", (route or "").strip())
    return (match.group(1).rstrip("/") or "/") if match else None


def _screen_route(kb: store.JourneyKB, screen: Dict[str, Any], automation: Dict[str, Any]) -> Optional[str]:
    route = diff._resolve_ref(automation, screen["route_ref"]) if screen.get("route_ref") else None
    return route or screen.get("route")


def _signature(kb: store.JourneyKB, screen: Dict[str, Any], automation: Dict[str, Any]) -> Dict[str, Any]:
    markers = []
    for element in screen.get("elements", []):
        if element.get("type") in _NOT_MARKERS:
            continue
        desc = _descriptor(kb, screen, element, automation)
        label = desc["clean_label"]
        # Masked or counted text ("p****@e***.com", "N COST CENTERS") is never on the page as written.
        if label and ("*" in label or re.match(r"^N\b", label)):
            desc["clean_label"] = label = ""
        hint = desc["hint"]
        findable = desc["kb_target"] or (hint.get("roles") and (hint.get("name") or hint.get("regex") or hint.get("contains"))) \
            or len(label) >= 4
        if findable:
            markers.append(desc)
    markers.sort(key=lambda d: (not d["kb_target"], not d["hint"].get("roles"), d["type"] != "heading"))
    route = _screen_route(kb, screen, automation)
    return {"name": screen.get("name") or screen["screen_id"], "route": _path_of(route), "markers": markers[:MARKERS_PER_SCREEN]}


def _ids(value: Any) -> List[str]:
    return [s.strip() for s in str(value or "").split("|") if s.strip()]


def _transitions(kb: store.JourneyKB, screen: Dict[str, Any], element_id: str, automation: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Where the design says acting on `element_id` leads, one entry per outcome."""
    out = []
    for t in screen.get("transitions") or []:
        if element_id not in _ids(t.get("on")):
            continue
        to = [sid for sid in _ids(t.get("to")) if sid in kb.screens]
        if not to:
            continue
        effect = str(t.get("effect") or "")
        # "no_customer_banner shown": the outcome is told apart by that element.
        marker = None
        for sid in to:
            element = next((e for e in kb.screens[sid].get("elements", []) if e.get("element_id") and e["element_id"] in effect), None)
            if element is not None:
                marker = _descriptor(kb, kb.screens[sid], element, automation)
                break
        out.append({"to": to, "condition": t.get("condition"), "rule": t.get("rule"), "effect": effect or None, "marker": marker})
    return out


def scenario_for(journey: Dict[str, Any], profile_id: Optional[str]) -> Optional[Dict[str, Any]]:
    """The journey's test scenario this test data is for, if one names it."""
    if not profile_id:
        return None
    return next((s for s in journey.get("test_scenarios") or [] if s.get("test_data") == profile_id), None)


def entry_address(base_url: str) -> str:
    """Where a journey walk begins: the environment's own address, as a folder.

    A folder without its trailing slash is not a page: the B2B portal answers
    /b2bportal with a redirect to an internal host, /b2bportal/ with its login page.
    """
    url = (base_url or "").strip()
    match = re.match(r"^(https?://[^/?#]+)(/[^?#]*)?$", url)
    if not match:
        return url
    path = match.group(2) or "/"
    last = path.rstrip("/").rsplit("/", 1)[-1]
    if not path.endswith("/") and "." not in last:
        path += "/"
    return match.group(1) + path


def build_plan(
    kb: store.JourneyKB,
    journey_id: str,
    *,
    automation_profile: Dict[str, Any],
    base_url: str,
    profile_id: Optional[str] = None,
) -> Dict[str, Any]:
    """What the crawl will do, step by step. Pure data; also shown to the user.

    The walk starts at the environment's address and lets the application
    take it from there. When the test data belongs to one of the journey's
    test scenarios, the walk runs that scenario's steps and expects its
    outcome -- an unregistered email is expected to stay on the login page
    with its banner, not to reach the OTP screen.
    """
    journey = kb.journeys.get(journey_id)
    if journey is None:
        raise ValueError(f"'{journey_id}' has no authored journey file to walk.")
    profiles = {k: v for k, v in ((kb.roles or {}).get("test_data_profiles") or {}).items() if isinstance(v, dict)}
    if not profile_id:
        profile_id = next((pid for pid, p in profiles.items() if "Journey Crawl sign-in" in p.get("extra_users", [])), None)
    data_profile = profiles.get(profile_id or "", {})
    scenario = scenario_for(journey, profile_id)
    warnings: List[str] = []
    if profile_id and scenario is None and data_profile.get("fields"):
        named = [s for s in journey.get("test_scenarios") or [] if s.get("test_data")]
        hint = "; ".join(f"{profiles.get(s['test_data'], {}).get('name', s['test_data'])} for {s['scenario_id']}" for s in named[:4])
        warnings.append(f"No scenario of this journey uses '{data_profile.get('name', profile_id)}'; the walk follows the steps "
                        f"as written and may stop early." + (f" Its scenarios use: {hint}." if hint else ""))
    scenario_steps = set(scenario.get("steps") or []) if scenario else None
    negative = bool(scenario and scenario.get("type") not in ("positive", "alternate"))

    scope = store.journey_scope(kb, journey)
    items: List[Dict[str, Any]] = []
    for walked in scope:
        # Steps of journeys after the chosen one are optional: the landing
        # screen depends on the account (a default organization skips the
        # chooser), and a step that cannot apply is skipped, not failed.
        optional = walked not in store.journey_chain(kb, journey)
        for step in walked.get("steps", []):
            if walked["journey_id"] == journey_id and scenario_steps is not None and step["step_number"] not in scenario_steps:
                items.append({"journey_id": walked["journey_id"], "step_number": step["step_number"], "text": step["action"],
                              "kind": "skip", "reason": f"not part of {scenario['scenario_id']}, the scenario this test data is for"})
                continue
            if walked["journey_id"] != journey_id and negative:
                items.append({"journey_id": walked["journey_id"], "step_number": step["step_number"], "text": step["action"],
                              "kind": "skip", "reason": f"{scenario['scenario_id']} ends before this journey"})
                continue
            if step.get("branch") == "negative_only":
                items.append({"journey_id": walked["journey_id"], "step_number": step["step_number"], "text": step["action"],
                              "kind": "skip", "reason": "error path only; the crawl follows the success path"})
                continue
            # "A|B" means the account decides which screen appears; the plan
            # cannot know, so that step sweeps nothing -- the screen is swept
            # on its first unambiguous visit instead.
            options = [s.strip() for s in str(step.get("screen_id") or "").split("|") if s.strip()]
            screen_id = options[0] if len(options) == 1 else ""
            screen = kb.screens.get(screen_id) or {}
            element = next((e for e in screen.get("elements", []) if e.get("element_id") == step.get("element_id")), None)
            item: Dict[str, Any] = {
                "journey_id": walked["journey_id"], "journey_name": walked["name"], "step_number": step["step_number"],
                "text": step["action"], "screen_id": screen_id or None, "optional": optional,
            }
            if len(options) > 1:
                item["screen_options"] = options
            if element is None:
                route = None
                if screen.get("route_ref"):
                    route = diff._resolve_ref(automation_profile, screen["route_ref"])
                route = route or screen.get("route")
                if _NAVIGATE.search(step["action"]) and route:
                    item.update(kind="goto", route=route)
                else:
                    item.update(kind="screen")
                items.append(item)
                continue
            desc = _descriptor(kb, screen, element, automation_profile)
            item["element"] = desc
            etype = element.get("type")
            if _VERIFY.match(step["action"]):
                item["kind"] = "capture"
            elif desc["group"]:
                item.update(kind="otp", variable=_profile_variable(data_profile, "otp"))
            elif etype in INPUT_TYPES:
                words = ("password",) if etype == "password_input" else ("email", "username", "user")
                item.update(kind="fill", variable=_profile_variable(data_profile, *words))
            elif etype == "card_list":
                item.update(kind="click", text_variable=_profile_variable(data_profile, "organization", "org"))
            elif etype in CLICK_TYPES:
                item["kind"] = "click"
            else:
                item["kind"] = "capture"
            if item["kind"] in ("fill", "otp") and not item.get("variable"):
                item["kind"] = "capture"
                item["reason"] = f"the data profile '{profile_id}' names no value for this field"
            items.append(item)

    screens = {
        sid: [_descriptor(kb, kb.screens[sid], e, automation_profile) for e in kb.screens[sid].get("elements", [])]
        for walked in scope for sid in walked.get("screens", []) if sid in kb.screens
    }
    _expectations(kb, items, automation_profile, scenario)
    involved = set(screens)
    for item in items:
        involved.update(item.get("screen_options") or ([item["screen_id"]] if item.get("screen_id") else []))
        for outcome in item.get("expect") or []:
            involved.update(outcome["to"])
    signatures = {sid: _signature(kb, kb.screens[sid], automation_profile) for sid in sorted(involved) if sid in kb.screens}
    # When the address does not lead into the application (a redirect to a
    # host outside this network), the walk opens the first screen's address.
    fallback = next((i["route"] for i in items if i.get("kind") == "goto" and i.get("route")), None)
    if not fallback:
        first = next((i["screen_id"] for i in items if i.get("screen_id")), None)
        fallback = _screen_route(kb, kb.screens[first], automation_profile) if first in kb.screens else None
    return {
        "app_id": kb.app_id, "journey_id": journey_id, "journey_name": journey["name"],
        "scope": [j["journey_id"] for j in scope], "base_url": base_url, "profile_id": profile_id,
        "entry": entry_address(base_url), "entry_fallback": fallback,
        "scenario": {k: scenario.get(k) for k in ("scenario_id", "type", "title", "steps", "rules", "branch")} if scenario else None,
        "warnings": warnings,
        "variables": sorted({i[k] for i in items for k in ("variable", "text_variable") if i.get(k)}),
        "items": items, "screens": screens, "signatures": signatures,
    }


def _expectations(kb: store.JourneyKB, items: List[Dict[str, Any]], automation: Dict[str, Any],
                  scenario: Optional[Dict[str, Any]]) -> None:
    """For each action that should lead somewhere: the outcomes the design describes, and which is expected.

    The scenario's rules choose the expected outcome (BR-AUTH-01: the
    unregistered email stays on the login page with its banner); without
    one, the outcome leading to the next step's screen is expected. The
    others are known branches: reaching one is reported by name, not as a
    missing element.
    """
    rules = set((scenario or {}).get("rules") or [])
    running = [i for i in items if i.get("kind") != "skip"]
    for index, item in enumerate(running):
        if item.get("kind") not in ("click", "otp") or not item.get("screen_id") or not item.get("element"):
            continue
        later = next((i for i in running[index + 1:] if i.get("screen_id") or i.get("screen_options")), None)
        next_screens = (later.get("screen_options") or [later["screen_id"]]) if later else []
        outcomes = _transitions(kb, kb.screens[item["screen_id"]], item["element"]["element_id"], automation)
        if not outcomes and next_screens and item["screen_id"] not in next_screens:
            outcomes = [{"to": next_screens, "condition": None, "rule": None, "effect": None, "marker": None}]
        if not outcomes:
            continue
        chosen = [o for o in outcomes if o.get("rule") and o["rule"] in rules]
        if not chosen:
            chosen = [o for o in outcomes if set(o["to"]) & set(next_screens) and not o.get("marker")] \
                or [o for o in outcomes if set(o["to"]) & set(next_screens)]
        # The last step of a scenario that ends here: its outcome is the scenario's.
        if not chosen and scenario and not later:
            chosen = outcomes[:1]
        for outcome in outcomes:
            outcome["expected"] = outcome in chosen
        item["expect"] = outcomes


# --- A flow blueprint as a plan -------------------------------------------------------
# A flow's canonical steps carry an action in prose and a target the Automation
# KB recorded for it (an XPath, or a route). The walk needs to know what to do
# with each: open, fill, enter the OTP, click, or only look for it.

_FLOW_FILL = re.compile(r"^\s*(enter|type|input|fill|provide|key in|populate)\b", re.IGNORECASE)
_FLOW_CLICK = re.compile(r"^\s*(click|tap|press|select|choose|open|submit|toggle|expand|switch|go to)\b", re.IGNORECASE)
_FLOW_OTP = re.compile(r"\b(otp|one[- ]time password|verification code|6-digit|six-digit)\b", re.IGNORECASE)
_QUOTED = re.compile(r"['\"‘“]([^'\"’”]{2,60})['\"’”]")
_CAPS = re.compile(r"\b([A-Z][A-Z0-9&]+(?:\s+[A-Z][A-Z0-9&]+)*)\b")


def _flow_target(target: Optional[str]) -> Dict[str, Optional[str]]:
    """{'route': ...} for a page address, {'selector': ...} for an element, {} for prose."""
    value = (target or "").strip()
    if not value:
        return {}
    if value.startswith("/") and not value.startswith("//"):
        return {"route": value}
    if value.startswith(("//", "(//", "xpath=", "css=", "#", ".", "[")) or re.search(r"\[[^\]]+\]", value):
        return {"selector": value[len("xpath="):] if value.startswith("xpath=") else value}
    return {}


def _flow_variable(text: str, data_profile: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """The Test Data value a fill step types, by what the field is.

    The data profile's own variable when it names one -- the same user a
    journey walk signs in as -- else a generic name Test Data matches by meaning.
    """
    lowered = text.lower()
    profile = data_profile or {}
    if _FLOW_OTP.search(text):
        return _profile_variable(profile, "otp") or "TESTDATA_OTP"
    if "password" in lowered:
        return _profile_variable(profile, "password") or "TESTDATA_PASSWORD"
    if any(w in lowered for w in ("email", "username", "user name", "user id", "login")):
        return _profile_variable(profile, "email", "username", "user") or "TESTDATA_USERNAME"
    if "mobile" in lowered or "phone" in lowered:
        return _profile_variable(profile, "mobile", "phone") or "TESTDATA_MOBILE_NUMBER"
    return None


def build_flow_plan(flow: Dict[str, Any], *, automation_profile: Dict[str, Any], base_url: str,
                    data_profile: Optional[Dict[str, Any]] = None, profile_id: Optional[str] = None) -> Dict[str, Any]:
    """What a dry run of a flow blueprint does, step by step, on `base_url`'s host.

    Each step is checked with the selector the flow records for it: found, it
    is confirmed; not found, the walk tries the step's quoted label and says
    the flow's selector failed.
    """
    from ..automation.knowledge_base import absolutize

    flow_id = flow.get("flow_id") or "flow"
    entry = flow.get("catalog_entrypoint") or ""
    start = absolutize(entry, base_url) if entry else base_url
    items: List[Dict[str, Any]] = []
    for step in flow.get("canonical_steps", []):
        number = step.get("step_number") or len(items) + 1
        text = str(step.get("action") or "").strip()
        target = _flow_target(step.get("target"))
        item: Dict[str, Any] = {
            "journey_id": flow_id, "journey_name": flow.get("flow_name") or flow_id, "step_number": number,
            "text": text, "screen_id": None, "optional": False, "expected": step.get("expected_result"),
        }
        if target.get("route"):
            item.update(kind="goto", route=target["route"])
            items.append(item)
            continue
        if not target.get("selector") and _NAVIGATE.search(text):
            item.update(kind="screen", reason="no route recorded; the walk stays where it is")
            items.append(item)
            continue
        quoted = _QUOTED.search(text) or _CAPS.search(text)
        label = quoted.group(1) if quoted else ""
        otp = bool(_FLOW_OTP.search(text)) and _FLOW_FILL.match(text) is not None
        kind = "otp" if otp else "fill" if _FLOW_FILL.match(text) else "click" if _FLOW_CLICK.match(text) else "capture"
        element = {
            "screen_id": "FLOW", "element_id": f"step_{number}", "label": label or text[:80], "clean_label": _clean(label),
            "aliases": [], "accepted_labels": [], "type": "otp_input_group" if otp else ("text_input" if kind == "fill" else None),
            "hint": {}, "kb_ref": f"flows.{flow_id}.step_{number}", "kb_target": target.get("selector"),
            "group": otp, "is_input": kind in ("fill", "otp"),
        }
        item["element"] = element
        item["kind"] = kind
        if kind in ("fill", "otp"):
            variable = _flow_variable(text, data_profile)
            if variable:
                item["variable"] = variable
            else:
                item.update(kind="capture", reason="no Test Data value names this field; the walk only looks for it")
        if kind == "click" and re.search(r"\borgani[sz]ation\b", text, re.IGNORECASE) and not label and not target.get("selector"):
            item["text_variable"] = _profile_variable(data_profile or {}, "organization", "org") or "TESTDATA_ORGANIZATION_NAME"
        items.append(item)
    return {
        "app_id": automation_profile.get("app_id"), "journey_id": flow_id, "journey_name": flow.get("flow_name") or flow_id,
        "scope": [flow_id], "base_url": start, "entry": start, "profile_id": profile_id, "source": "flow",
        "variables": sorted({i[k] for i in items for k in ("variable", "text_variable") if i.get(k)}),
        "items": items, "screens": {}, "signatures": {},
    }


# --- The stop point -----------------------------------------------------------------------

# Steps that only read or sign in, whatever their verb: submitting an OTP or a
# search changes nothing.
SAFE = re.compile(r"\b(otp|one[- ]time|code|sign[- ]?in|log[- ]?in|search|filter|sort)\b", re.IGNORECASE)

RISKY = re.compile(
    r"\b(submit|confirm|pay|payment|place (?:the )?order|purchase|checkout|delete|remove|save|send|approve|reject|"
    r"activate|deactivate|terminate|register|cancel (?:the )?(?:subscription|order|service|request))\b",
    re.IGNORECASE,
)


def apply_stop(plan: Dict[str, Any], *, stop_before: Optional[int] = None, allow_risky: bool = False) -> Dict[str, Any]:
    """Mark the steps that would change something, and where the walk stops.

    `stop_before` is the order (1-based) of the first step not to run. Unless
    `allow_risky`, the walk also stops before the first click that submits,
    confirms, pays, saves or deletes -- the dry run looks, it does not act.
    """
    first_risky = None
    for order, item in enumerate(plan.get("items", []), start=1):
        text = item.get("text") or ""
        risky = item.get("kind") == "click" and bool(RISKY.search(text)) and not SAFE.search(text)
        item["risky"] = risky
        if risky and first_risky is None:
            first_risky = order
    candidates = []
    if stop_before:
        candidates.append((int(stop_before), "stopped where you chose"))
    if first_risky and not allow_risky:
        candidates.append((first_risky, "stopped before a step that would change data (allow it to go further)"))
    if candidates:
        order, reason = min(candidates)
        plan["stop_before"], plan["stop_reason"] = order, reason
    else:
        plan["stop_before"], plan["stop_reason"] = None, None
    plan["first_risky"] = first_risky
    # Only the values the steps that run will type: a walk stopped before the
    # password step does not need a password in Test Data.
    running = plan.get("items", [])[: plan["stop_before"] - 1] if plan["stop_before"] else plan.get("items", [])
    plan["variables"] = sorted({i[k] for i in running for k in ("variable", "text_variable") if i.get(k)})
    return plan


# --- The spec ----------------------------------------------------------------------

_SPEC = r"""import { test } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// --- Journey-guided crawl ---------------------------------------------------
// Walks one Journey KB journey and records, for each design element, whether
// the running application has it and a selector verified to match it alone.
// Values are read from TESTDATA_* only; nothing typed is recorded.

const PLAN = __PLAN__;
const T = { action: 8000, settle: 8000, outcome: 25000 };

// Which values the crawl reads -- listed literally so the runner can resolve
// them from the test-data vault before starting:
__ENV_READS__

const env = (name) => (name ? process.env[name] || '' : '');

// Written whole and renamed into place, so a reader never sees half a file.
function writeAtomic(name, data) {
  const target = path.join(process.cwd(), name);
  const tmp = target + '.tmp';
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, target); } catch (e) { /* the walk goes on without it */ }
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: T.settle }).catch(() => {});
}

function candidates(page, el, textValue) {
  const out = [];
  const h = el.hint || {};
  if (el.kb_target) out.push({ strategy: 'kb', make: () => page.locator(el.kb_target.startsWith('//') || el.kb_target.startsWith('(//') ? `xpath=${el.kb_target}` : el.kb_target) });
  for (const role of h.roles || []) {
    if (h.name) {
      out.push({ strategy: 'role', make: () => page.getByRole(role, { name: h.name, exact: true }) });
      out.push({ strategy: 'role~', make: () => page.getByRole(role, { name: h.name }) });
    }
    if (h.regex) out.push({ strategy: 'role/re', make: () => page.getByRole(role, { name: new RegExp(h.regex, 'i') }) });
  }
  if (textValue) out.push({ strategy: 'data-text', make: () => page.getByText(textValue, { exact: false }) });
  const labels = [el.clean_label, ...(el.aliases || [])].filter(Boolean);
  for (const label of labels) {
    if (el.is_input) {
      out.push({ strategy: 'label', make: () => page.getByLabel(label) });
      out.push({ strategy: 'placeholder', make: () => page.getByPlaceholder(label) });
    }
    out.push({ strategy: 'text', make: () => page.getByText(label, { exact: true }) });
  }
  if (h.contains) out.push({ strategy: 'contains', make: () => page.getByText(h.contains) });
  return out;
}

async function resolve(page, el, textValue) {
  const tried = [];
  let multi = null;
  for (const c of candidates(page, el, textValue)) {
    const loc = c.make();
    const n = await loc.count().catch(() => 0);
    tried.push({ strategy: c.strategy, count: n });
    if (n === 1 || (el.group && n > 1)) {
      if (await loc.first().isVisible().catch(() => false)) return { loc, strategy: c.strategy, count: n, tried };
    }
    if (n > 1 && !multi) multi = { loc, strategy: c.strategy, count: n };
  }
  if (multi && await multi.loc.first().isVisible().catch(() => false)) return { ...multi, tried, ambiguous: true };
  return { loc: null, tried };
}

// Runs in the page: a selector for this element, verified to match only it.
function uniqueXPath(el) {
  const tag = el.tagName.toLowerCase();
  const count = (xp) => { try { return document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength; } catch (e) { return 0; } };
  const ok = (v) => v && !v.includes("'") && v.length <= 80;
  const out = [];
  for (const a of ['data-testid', 'data-test', 'id', 'name', 'formcontrolname', 'aria-label', 'placeholder']) {
    const v = el.getAttribute(a);
    if (ok(v) && !(a === 'id' && /\d{5,}|[a-f0-9]{10,}/i.test(v))) out.push(`//${tag}[@${a}='${v}']`);
  }
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
  if (ok(text) && text.length <= 60) {
    out.push(`//${tag}[normalize-space(.)='${text}']`);
    out.push(`//${tag}[contains(normalize-space(.),'${text}')]`);
  }
  for (const xp of out) if (count(xp) === 1) return xp;
  return null;
}

// Runs in the page: a selector matching exactly this group (the OTP boxes).
function groupXPath(els) {
  const names = els.map(e => e.getAttribute('name') || '').filter(Boolean);
  if (names.length !== els.length || !names.length) return null;
  let prefix = names[0];
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  prefix = prefix.replace(/[-_\d]+$/, '');
  if (prefix.length < 3 || prefix.includes("'")) return null;
  const tag = els[0].tagName.toLowerCase();
  const xp = `//${tag}[contains(@name,'${prefix}')]`;
  const n = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength;
  return n === els.length ? xp : null;
}

// Runs in the page: every visible interactive element on it, with a selector
// verified to match only that element, the role and the name a user sees.
// Never a value. Self-contained: page.evaluate sends it on its own.
function sweepPage() {
  // Links without an href and clickable divs count too: many portals build
  // their buttons that way ("Sign in with UAE PASS" is one).
  const SEL = 'a,button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=combobox],[role=menuitem],[role=switch],[role=option],[onclick],[tabindex]:not([tabindex="-1"])';
  // Site-wide: inside a header, footer or menu, by tag, role, or -- where a
  // site uses neither -- by its container's id or class.
  const SITE_WIDE = /(^|[\s_-])(header|footer|navbar|nav|topbar|top-bar|megamenu|mega-menu|main-menu|site-menu|menu-wrapper|breadcrumbs?)([\s_-]|$)/;
  const isChrome = (el) => {
    let n = el;
    for (let i = 0; n && n.getAttribute && i < 16; i++, n = n.parentElement) {
      const tag = n.tagName.toLowerCase();
      // The page root's classes describe the page, not this element's region.
      if (tag === 'body' || tag === 'html' || tag === 'main' || n.getAttribute('role') === 'main') return false;
      if (tag === 'header' || tag === 'footer' || tag === 'nav') return true;
      const role = n.getAttribute('role') || '';
      if (role === 'banner' || role === 'contentinfo' || role === 'navigation') return true;
      const cls = typeof n.className === 'string' ? n.className : '';
      if (SITE_WIDE.test(((n.id || '') + ' ' + cls).toLowerCase())) return true;
    }
    return false;
  };
  const count = (xp) => { try { return document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength; } catch (e) { return 0; } };
  const ok = (v) => v && !v.includes("'") && v.length <= 80;
  const xpathOf = (el) => {
    const tag = el.tagName.toLowerCase();
    const out = [];
    for (const a of ['data-testid', 'data-test', 'id', 'name', 'formcontrolname', 'aria-label', 'placeholder']) {
      const v = el.getAttribute(a);
      if (ok(v) && !(a === 'id' && /\d{5,}|[a-f0-9]{10,}/i.test(v))) out.push(`//${tag}[@${a}='${v}']`);
    }
    // The DOM's own text: XPath does not see CSS text-transform (REGISTER NOW is 'Register now').
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
    if (ok(text) && text.length <= 60) {
      out.push(`//${tag}[normalize-space(.)='${text}']`);
      out.push(`//${tag}[contains(normalize-space(.),'${text}')]`);
    }
    for (const xp of out) if (count(xp) === 1) return xp;
    const GENERIC = /^(row|col|container|d-|px-|py-|p-|m-|mt-|mb-|ms-|me-|mx-|my-|flex|justify|align|text-|font-|w-|h-|bg-|btn$|ng-|position|overflow)/;
    let n = el.parentElement;
    for (let depth = 0; n && depth < 8 && n.tagName.toLowerCase() !== 'body'; depth++, n = n.parentElement) {
      const atag = n.tagName.toLowerCase();
      const scopes = [];
      if (ok(n.id) && !/\d{5,}|[a-f0-9]{10,}/i.test(n.id)) scopes.push(`//${atag}[@id='${n.id}']`);
      const cls = (typeof n.className === 'string' ? n.className : '').split(/\s+/).filter((c) => c && c.length > 3 && !GENERIC.test(c) && !c.includes("'"));
      if (cls.length) scopes.push(`//${atag}[contains(concat(' ',normalize-space(@class),' '),' ${cls[0]} ')]`);
      for (const scope of scopes) for (const xp of out.slice(0, 3)) {
        const scoped = scope + xp;
        if (count(scoped) === 1) return scoped;
      }
    }
    return null;
  };
  const roleOf = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (['submit', 'button', 'reset', 'image'].includes(ty)) return 'button';
      return ty === 'password' ? 'password' : 'textbox';
    }
    return t;
  };
  const nameOf = (el) => {
    const t = el.tagName.toLowerCase();
    const ty = (el.getAttribute('type') || '').toLowerCase();
    const field = ['input', 'textarea', 'select'].includes(t) && !['submit', 'button', 'reset', 'image'].includes(ty);
    const label = el.labels && el.labels[0] ? el.labels[0].innerText : '';
    const raw = field
      ? (el.getAttribute('aria-label') || label || el.getAttribute('placeholder') || el.getAttribute('name') || '')
      : ((el.innerText || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title') || (ty ? el.getAttribute('value') : '') || '');
    return String(raw).replace(/\s+/g, ' ').trim().slice(0, 80);
  };
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(SEL)) {
    if (out.length >= 150) break;
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (box.width < 2 || box.height < 2 || style.visibility === 'hidden' || style.display === 'none') continue;
    // A clickable container wrapping other controls is not itself one.
    if (!['a', 'button', 'input', 'select', 'textarea'].includes(el.tagName.toLowerCase()) && !el.getAttribute('role')
        && el.querySelector('a,button,input,select,textarea')) continue;
    const selector = xpathOf(el);
    if (!selector || seen.has(selector)) continue;
    seen.add(selector);
    out.push({
      role: roleOf(el), name: nameOf(el), tag: el.tagName.toLowerCase(), selector,
      chrome: isChrome(el),
    });
  }
  return out;
}

// Runs in the page: what the user sees this element called. Never a value.
function describe(el) {
  const label = el.labels && el.labels[0] ? el.labels[0].innerText : '';
  const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  return {
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') || '',
    app_label: (['input', 'textarea', 'select'].includes(el.tagName.toLowerCase())
      ? (el.getAttribute('aria-label') || label || el.getAttribute('placeholder') || '')
      : (text || el.getAttribute('aria-label') || '')).trim(),
  };
}

async function capture(page, el, textValue) {
  const r = await resolve(page, el, textValue);
  const record = { screen_id: el.screen_id, element_id: el.element_id, tried: r.tried, url: page.url() };
  if (!r.loc) return { ...record, found: false };
  const handle = await r.loc.first().elementHandle().catch(() => null);
  let selector = null;
  let info = {};
  if (handle) {
    info = await handle.evaluate(describe).catch(() => ({}));
    selector = el.group
      ? await r.loc.evaluateAll(groupXPath).catch(() => null)
      : await handle.evaluate(uniqueXPath).catch(() => null);
  }
  return { ...record, found: true, strategy: r.strategy, count: r.count, ambiguous: !!r.ambiguous, selector, ...info, _loc: r.loc };
}

// --- Where the walk is ---------------------------------------------------------
// Is this design element on the page? Looser than resolve(): any visible
// match will do, and labels match ignoring case and surrounding words -- the
// design's text is often a little behind the application's.
async function present(page, el) {
  const h = el.hint || {};
  const tries = [];
  if (el.kb_target) tries.push(() => page.locator(el.kb_target.startsWith('//') || el.kb_target.startsWith('(//') ? `xpath=${el.kb_target}` : el.kb_target));
  for (const role of h.roles || []) {
    if (h.name) tries.push(() => page.getByRole(role, { name: h.name }));
    if (h.regex) tries.push(() => page.getByRole(role, { name: new RegExp(h.regex, 'i') }));
    if (h.contains) tries.push(() => page.getByRole(role, { name: h.contains }));
  }
  if (h.contains) tries.push(() => page.getByText(h.contains));
  for (const label of [el.clean_label, ...(el.aliases || [])].filter((l) => l && l.length >= 4)) tries.push(() => page.getByText(label));
  for (const make of tries) {
    try {
      const loc = make();
      const n = await loc.count();
      for (let i = 0; i < Math.min(n, 3); i++) if (await loc.nth(i).isVisible()) return true;
    } catch (e) { /* an invalid selector is a miss */ }
  }
  return false;
}

const pathOf = (u) => { try { return new URL(u).pathname.replace(/\/+$/, '') || '/'; } catch (e) { return null; } };
const screenName = (id) => ((PLAN.signatures || {})[id] || {}).name || id;

// Which of these screens is showing: enough of its markers visible, or its
// known address and at least one marker. The best-supported one wins.
async function recognise(page, ids) {
  let best = null;
  const here = pathOf(page.url());
  for (const id of ids) {
    const sig = (PLAN.signatures || {})[id];
    if (!sig) continue;
    let hits = 0;
    for (const m of sig.markers) if (await present(page, m)) hits++;
    const routed = !!(sig.route && here && sig.route === here);
    const total = sig.markers.length;
    const ok = total ? (hits >= Math.min(2, total) || (routed && hits >= 1)) : routed;
    if (!ok) continue;
    const score = hits + (routed ? 1 : 0);
    const fraction = total ? hits / total : 1;
    if (!best || score > best.score || (score === best.score && fraction > best.fraction)) best = { screen_id: id, score, fraction };
  }
  return best;
}

// Runs in the page: error messages showing, and whether the page is still busy.
function pageSignals() {
  const vis = (e) => { const b = e.getBoundingClientRect(); const s = getComputedStyle(e); return b.width > 1 && b.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  const errors = [];
  for (const e of document.querySelectorAll('[role=alert],[role=alertdialog],[aria-live=assertive],.alert-danger,.alert-error,.text-danger,.invalid-feedback,.error-message,.error-msg,.errorMessage,.toast-error,.mat-error,.mat-mdc-form-field-error')) {
    if (!vis(e)) continue;
    const t = (e.innerText || '').trim().replace(/\s+/g, ' ');
    if (t && t.length <= 200) errors.push(t);
  }
  const text = document.body ? document.body.innerText : '';
  const m = text.match(/\b(internal server error|something went wrong|service (?:is )?unavailable|bad gateway|gateway time-?out|unexpected error|technical (?:error|issue|difficult(?:y|ies)))\b[^\n]{0,120}/i);
  // Words that say error come first: a site may mark a plain notice role=alert.
  if (m && !errors.some((x) => x.toLowerCase().includes(m[1].toLowerCase()))) errors.unshift(m[0].trim());
  let busy = !!document.querySelector('[aria-busy=true]');
  for (const b of document.querySelectorAll('button,[role=button],input[type=submit]')) {
    if (vis(b) && /\b(sending|loading|please wait|processing|submitting|verifying|signing in)\b/i.test(b.innerText || b.value || '')) { busy = true; break; }
  }
  return { errors: [...new Set(errors)].slice(0, 3), busy };
}

// After an action the design says leads somewhere: wait for one of its
// outcomes, an error, or the time limit -- whichever comes first.
async function outcomeOf(page, item, baseline = []) {
  const from = item.screen_id;
  const outcomes = [...(item.expect || [])].sort((a, b) => (b.expected ? 1 : 0) - (a.expected ? 1 : 0));
  const ids = [...new Set([from, ...outcomes.flatMap((o) => o.to)].filter(Boolean))];
  const before = page.url();
  const deadline = Date.now() + T.outcome;
  let errorSeen = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(600);
    const signals = await page.evaluate(pageSignals).catch(() => ({ errors: [], busy: true }));
    if (signals.busy) continue;
    // Only what the action brought: a notice the page always shows is not its outcome
    // (the B2B login page marks its "CLICK HERE" notice role=alert).
    signals.errors = signals.errors.filter((e) => !baseline.includes(e));
    const showing = await recognise(page, ids);
    for (const o of outcomes) {
      let reached = false;
      if (o.marker) reached = (!showing || o.to.includes(showing.screen_id)) && await present(page, o.marker);
      else reached = !!showing && o.to.includes(showing.screen_id) && showing.screen_id !== from;
      if (reached) {
        return { kind: o.expected ? 'expected' : 'branch', screen: showing ? showing.screen_id : o.to[0],
          rule: o.rule || null, condition: o.condition || null, effect: o.effect || null };
      }
    }
    if (signals.errors.length) {
      // Seen twice: a message that flickers while a request finishes is not the outcome.
      if (++errorSeen >= 2) return { kind: 'error', message: signals.errors.join(' · '), screen: showing ? showing.screen_id : null };
    } else errorSeen = 0;
  }
  const now = await recognise(page, Object.keys(PLAN.signatures || {}));
  if (now && now.screen_id !== from) return { kind: 'unexpected', screen: now.screen_id };
  if (page.url() !== before) return { kind: 'unknown', url: page.url() };
  return { kind: 'stuck', screen: now ? now.screen_id : null };
}

function offPathReason(item, o) {
  // The expected outcome as the design words it: "Sign in ... with no_customer_banner shown".
  const wanted = (item.expect || []).filter((x) => x.expected)
    .map((x) => x.to.map(screenName).join(' or ') + (x.effect ? ` with ${x.effect}` : ''));
  const target = wanted.length ? wanted.join(' or ') : 'the next screen';
  if (o.kind === 'error') return `"${o.message}" was shown after step ${item.step_number}, instead of ${target}`;
  if (o.kind === 'branch') return `went the way the design gives for "${o.condition || o.effect || screenName(o.screen)}"${o.rule ? ` (${o.rule})` : ''}, instead of ${target}`;
  if (o.kind === 'unexpected') return `reached ${screenName(o.screen)} instead of ${target}`;
  if (o.kind === 'unknown') return `reached ${o.url}, a screen the Journey KB does not describe, instead of ${target}`;
  return `nothing happened within ${Math.round(T.outcome / 1000)} s of step ${item.step_number}; ${target} never appeared`;
}

// Typed values never appear in a screenshot or a live frame: filled fields are painted over.
async function markFilled(page) {
  await page.evaluate(() => {
    for (const e of document.querySelectorAll('input,textarea')) {
      const t = (e.getAttribute('type') || '').toLowerCase();
      if (['checkbox', 'radio', 'button', 'submit', 'hidden', 'image', 'reset'].includes(t)) continue;
      if (e.value) e.setAttribute('data-walk-filled', ''); else e.removeAttribute('data-walk-filled');
    }
  }).catch(() => {});
}
const masked = (page) => ({ mask: [page.locator('[data-walk-filled]')], maskColor: '#8a8f98' });

// A person's pause between steps (PLAN.step_delay_ms, from the backend's
// settings): with slowMo on every action, a walk does not reach the
// application as a burst of clicks that corporate security would block.
const pause = async (page) => {
  const [low, high] = PLAN.step_delay_ms || [0, 0];
  if (high > 0) await page.waitForTimeout(low + Math.floor(Math.random() * (high - low + 1)));
};

test('journey-guided crawl', async ({ page }) => {
  // Long enough for the pauses and slowMo on top of the steps themselves.
  test.setTimeout(540000);
  const steps = [];
  const sweep = [];
  const swept = new Set();
  const blockers = [];
  let current = null;
  let finished = false;
  // Every screen the walk reaches, catalogued once: all its interactive elements.
  const pages = [];
  const catalogued = new Set();
  const inventory = async (screenId) => {
    let key = screenId;
    if (!key) { try { key = new URL(page.url()).pathname; } catch (e) { key = page.url(); } }
    if (!key || catalogued.has(key)) return;
    catalogued.add(key);
    const elements = await page.evaluate(sweepPage).catch(() => []);
    pages.push({ screen_id: screenId || null, url: page.url(), elements });
  };
  // The address each screen was found at: one screen per address, so a
  // dialog over a page does not take the page's address.
  const routes = {};
  const claimed = {};
  // On a screen for the first time: learn its address, catalogue it, and
  // look for every element the design says it has.
  const arrived = async (screenId) => {
    if (!screenId) return;
    const here = pathOf(page.url());
    if (!routes[screenId] && here && !claimed[here]) { routes[screenId] = here; claimed[here] = screenId; }
    await inventory(screenId);
    if (!swept.has(screenId) && PLAN.screens[screenId]) {
      swept.add(screenId);
      for (const el of PLAN.screens[screenId]) {
        const r = await capture(page, el, null);
        delete r._loc;
        sweep.push(r);
      }
    }
  };
  // Once the application leaves the journey's path, nothing after it can be
  // judged: those steps are blocked, with the reason, not "not found".
  let derailed = null;
  const derail = (order, reason) => { if (!derailed) derailed = { after: order, reason }; };
  // Progress for the page that watches the walk: every step as it lands.
  const progress = () => writeAtomic('__PROGRESS__', JSON.stringify({ total: PLAN.items.length, current, finished, steps, derailed }));
  const record = (step) => { steps.push(step); progress(); };
  const shoot = async (name) => {
    const file = `shot-${name}.png`;
    await markFilled(page);
    await page.screenshot({ path: path.join(process.cwd(), file), fullPage: false, ...masked(page) }).catch(() => {});
    return file;
  };
  // A frame about once a second, so the walk can be watched while it runs.
  let watching = true;
  const frames = (async () => {
    while (watching) {
      try { await markFilled(page); writeAtomic('__FRAME__', await page.screenshot({ timeout: 3000, ...masked(page) })); } catch (e) { /* between pages */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
  const entry = { address: PLAN.entry || PLAN.base_url };
  progress();
  try {
    // In at the environment's address; the application takes it from there.
    try {
      await page.goto(entry.address, { waitUntil: 'domcontentloaded', timeout: 35000 });
    } catch (err) {
      entry.error = String(err && err.message || err).split('\n')[0].slice(0, 200);
    }
    await settle(page);
    entry.landed = page.url();
    let offHost = true;
    try { offHost = new URL(page.url()).host !== new URL(entry.address).host; } catch (e) { /* not a URL: off */ }
    if (entry.error || offHost) {
      if (!PLAN.entry_fallback) throw new Error(entry.error || `${entry.address} redirected to ${entry.landed}`);
      entry.note = entry.error ? `${entry.address} did not open (${entry.error})` : `${entry.address} redirected to ${entry.landed}, outside the environment`;
      entry.fallback = new URL(PLAN.entry_fallback, entry.address).toString();
      await page.goto(entry.fallback, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await settle(page);
      entry.landed = page.url();
    }
    const first = await recognise(page, Object.keys(PLAN.signatures || {}));
    entry.screen = first ? first.screen_id : null;
    if (first) await arrived(first.screen_id);

    for (const [index, item] of PLAN.items.entries()) {
      const out = { order: index + 1, journey_id: item.journey_id, step_number: item.step_number, kind: item.kind, screen_id: item.screen_id || null };
      // The stop point: nothing from here on runs.
      if (PLAN.stop_before && index + 1 >= PLAN.stop_before) {
        for (const [rest, later] of PLAN.items.slice(index).entries()) {
          steps.push({ order: index + rest + 1, journey_id: later.journey_id, step_number: later.step_number, kind: later.kind,
            screen_id: later.screen_id || null, status: 'stopped', reason: PLAN.stop_reason || 'stopped before this step' });
        }
        progress();
        break;
      }
      if (item.kind === 'skip') { record({ ...out, status: 'skipped', reason: item.reason }); continue; }
      if (derailed) { record({ ...out, status: 'blocked', reason: derailed.reason }); continue; }
      await pause(page);
      current = { order: index + 1, step_number: item.step_number, text: item.text, kind: item.kind };
      progress();
      const options = item.screen_options || (item.screen_id ? [item.screen_id] : []);
      // A step of the walked journey whose screen never came: everything after it is blocked.
      const missing = (why) => {
        if (!item.optional) derail(index + 1, why);
        return item.optional ? 'not_applicable' : 'not_reached';
      };
      try {
        if (item.kind === 'goto') {
          // Already there -- the application opened it from its own address -- or open it.
          let shown = item.screen_id ? await recognise(page, [item.screen_id]) : null;
          const already = !!shown;
          if (!shown) {
            await page.goto(new URL(item.route, entry.fallback || entry.address).toString(), { waitUntil: 'domcontentloaded', timeout: 35000 });
            await settle(page);
            shown = item.screen_id ? await recognise(page, [item.screen_id]) : { screen_id: null };
          }
          if (!shown) {
            const status = missing(`${screenName(item.screen_id)} did not appear at ${page.url()}`);
            record({ ...out, status, url: page.url(), reason: `${screenName(item.screen_id)} is not showing`, screenshot: await shoot(index + 1) });
            continue;
          }
          await arrived(item.screen_id);
          record({ ...out, status: 'done', url: page.url(), screen: item.screen_id,
            note: already ? 'already showing: the application opened it from its own address' : `opened ${item.route}`,
            screenshot: await shoot(index + 1) });
          continue;
        }
        if (item.kind === 'screen') {
          if (!options.length) { record({ ...out, status: 'done', url: page.url(), screenshot: await shoot(index + 1) }); continue; }
          const shown = await recognise(page, options);
          if (!shown) {
            const names = options.map(screenName).join(' or ');
            const status = missing(`${names} never appeared (still at ${page.url()})`);
            record({ ...out, status, url: page.url(), reason: `${names} is not showing`, screenshot: await shoot(index + 1) });
            continue;
          }
          await arrived(shown.screen_id);
          record({ ...out, status: 'done', url: page.url(), screen: shown.screen_id, screenshot: await shoot(index + 1) });
          continue;
        }
        const el = item.element;
        const textValue = env(item.text_variable);
        const r = await capture(page, el, textValue);
        const loc = r._loc;
        delete r._loc;
        const before = page.url();
        if (!r.found) {
          // Missing from its screen is a finding; its screen not showing at all is not.
          const shown = item.screen_id ? await recognise(page, [item.screen_id]) : { screen_id: null };
          // Already past it: an OTP form submits itself, so its Proceed button is gone
          // and the page is where pressing it would have led.
          const ahead = !shown && item.expect ? await recognise(page, item.expect.filter((o) => o.expected).flatMap((o) => o.to)) : null;
          if (ahead) {
            await arrived(ahead.screen_id);
            record({ ...out, status: 'auto', capture: r, url: page.url(), screen: ahead.screen_id,
              outcome: { kind: 'expected', screen: ahead.screen_id }, note: `not needed: the application moved on to ${screenName(ahead.screen_id)} by itself`,
              screenshot: await shoot(index + 1) });
            continue;
          }
          if (!shown) {
            const status = missing(`${screenName(item.screen_id)} never appeared (still at ${page.url()})`);
            record({ ...out, status, capture: r, url: page.url(), reason: `${screenName(item.screen_id)} is not showing`, screenshot: await shoot(index + 1) });
            continue;
          }
          await arrived(item.screen_id);
          await inventory(item.screen_id || null);
          record({ ...out, status: item.optional ? 'not_applicable' : 'not_found', capture: r, url: page.url(), screenshot: await shoot(index + 1) });
          continue;
        }
        // Found: this is its screen. Catalogue it before the action changes it.
        await arrived(item.screen_id);
        // What the page says before acting, so the outcome is judged on what is new.
        const baseline = item.expect && item.expect.length
          ? (await page.evaluate(pageSignals).catch(() => ({ errors: [] }))).errors : [];
        if (item.kind === 'fill') await loc.first().fill(env(item.variable), { timeout: T.action });
        if (item.kind === 'otp') {
          const digits = env(item.variable).replace(/\D/g, '').split('');
          const n = await loc.count();
          if (n > 1) { for (let i = 0; i < Math.min(n, digits.length); i++) await loc.nth(i).fill(digits[i], { timeout: T.action }); }
          else await loc.first().fill(digits.join(''), { timeout: T.action });
        }
        if (item.kind === 'click') await loc.first().click({ timeout: T.action });
        let outcome = null;
        if (item.expect && item.expect.length) {
          outcome = await outcomeOf(page, item, baseline);
          if (outcome.screen && outcome.kind !== 'error') await arrived(outcome.screen);
        } else {
          // An OTP form submits itself once the last box is filled: give it
          // time to leave the page before the next screen is swept.
          if (item.kind === 'otp') await page.waitForURL((u) => u.toString() !== before, { timeout: T.settle }).catch(() => {});
          if (['fill', 'otp', 'click'].includes(item.kind)) await settle(page);
        }
        // A flow names no screens: each new page it reaches is catalogued.
        if (!item.screen_id) await inventory(null);
        const offPath = !!outcome && outcome.kind !== 'expected';
        const reason = offPath ? offPathReason(item, outcome) : undefined;
        if (offPath) derail(index + 1, reason);
        record({ ...out, status: offPath ? 'off_path' : 'done', capture: r, url: page.url(), outcome, reason, screenshot: await shoot(index + 1) });
      } catch (err) {
        record({ ...out, status: 'error', error: String(err && err.message || err).split('\n')[0].slice(0, 300), screenshot: await shoot(index + 1) });
      }
    }
  } catch (err) {
    blockers.push(String(err && err.message || err).split('\n')[0].slice(0, 300));
  } finally {
    watching = false;
    await frames.catch(() => {});
    current = null;
    finished = true;
    progress();
    fs.writeFileSync(path.join(process.cwd(), '__OUTPUT__'), JSON.stringify({ steps, sweep, pages, blockers, final_url: page.url(), entry, routes, derailed }, null, 2));
  }
});
"""


def build_spec(plan: Dict[str, Any]) -> str:
    # Literal process.env.NAME reads, so test_data.required_names finds them.
    reads = "\n".join(f"void process.env.{name};" for name in plan["variables"]) or "// none"
    return (
        _SPEC.replace("__PLAN__", json.dumps(plan, ensure_ascii=False))
        .replace("__ENV_READS__", reads)
        .replace("__OUTPUT__", OUTPUT_FILE)
        .replace("__PROGRESS__", PROGRESS_FILE)
        .replace("__FRAME__", FRAME_FILE)
    )


# --- Reading the result ------------------------------------------------------------------

def _norm(text: Optional[str]) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip().rstrip("*.:").strip().lower()


def evaluate(plan: Dict[str, Any], output: Dict[str, Any]) -> Dict[str, Any]:
    """One row per design element the crawl looked for, with what it means.

    outcome: confirmed (the Automation KB selector still resolves), new
    (captured, no Automation KB entry yet), healed (the Automation KB selector
    failed, another way found it), kb_failed (neither), not_found, or
    not_applicable (an optional step whose screen was not shown).
    """
    descriptors = {(el["screen_id"], el["element_id"]): el for els in plan["screens"].values() for el in els}
    for item in plan["items"]:
        if item.get("element"):
            descriptors[(item["element"]["screen_id"], item["element"]["element_id"])] = item["element"]
    captures: Dict[tuple, Dict[str, Any]] = {}
    step_status: Dict[tuple, str] = {}
    for record in output.get("sweep", []):
        captures.setdefault((record["screen_id"], record["element_id"]), record)
    for step in output.get("steps", []):
        cap = step.get("capture")
        if cap:
            key = (cap["screen_id"], cap["element_id"])
            if cap.get("found") or key not in captures:
                captures[key] = cap
            step_status[key] = step["status"]

    rows = []
    for key, el in descriptors.items():
        cap = captures.get(key)
        status = step_status.get(key)
        if cap is None or status in ("not_reached", "blocked"):
            outcome = "not_reached"
        elif not cap.get("found") and status == "auto":
            outcome = "not_applicable"
        elif not cap.get("found"):
            outcome = "not_applicable" if status == "not_applicable" else ("kb_failed" if el.get("kb_target") else "not_found")
        elif cap.get("strategy") == "kb":
            outcome = "confirmed"
        elif el.get("kb_target"):
            outcome = "healed"
        else:
            outcome = "new"
        app_label = (cap or {}).get("app_label") or ""
        drift = bool(app_label and el.get("clean_label") and _norm(app_label) != _norm(el["clean_label"])
                     and _norm(el["clean_label"]) not in _norm(app_label)
                     and not any(_norm(a) == _norm(app_label) for a in el.get("accepted_labels", [])))
        rows.append({
            "screen_id": key[0], "element_id": key[1], "design_label": el.get("label"), "type": el.get("type"),
            "outcome": outcome, "strategy": (cap or {}).get("strategy"), "selector": (cap or {}).get("selector"),
            "ambiguous": bool((cap or {}).get("ambiguous")), "app_label": app_label or None, "label_differs": drift,
            # Found through a test-data value (an organization's name): right
            # for walking the journey, wrong as a lasting selector.
            "data_dependent": (cap or {}).get("strategy") == "data-text",
            "kb_ref": el.get("kb_ref"), "kb_target": el.get("kb_target"), "url": (cap or {}).get("url"),
            "tried": (cap or {}).get("tried", []),
        })
    summary: Dict[str, int] = {}
    for row in rows:
        summary[row["outcome"]] = summary.get(row["outcome"], 0) + 1
    pages = inventory(plan, output, rows)
    texts = {(i["element"]["screen_id"], i["element"]["element_id"]): i.get("text") for i in plan.get("items", []) if i.get("element")}
    kinds = {(i["element"]["screen_id"], i["element"]["element_id"]): i.get("kind") for i in plan.get("items", []) if i.get("element")}
    for row in rows:
        if row["outcome"] in ("kb_failed", "not_found"):
            row["candidates"] = candidates_for({**row, "step_text": texts.get((row["screen_id"], row["element_id"])),
                                                "kind": kinds.get((row["screen_id"], row["element_id"]))}, pages)
    summary["app_only"] = sum(p["app_only"] for p in pages)
    routes = learned_routes(plan, output)
    summary["routes_new"] = sum(1 for r in routes if r["state"] != "same")
    return {
        "rows": sorted(rows, key=lambda r: (r["screen_id"], r["element_id"])),
        "steps": output.get("steps", []),
        "blockers": output.get("blockers", []),
        "final_url": output.get("final_url"),
        "entry": output.get("entry"),
        "derailed": output.get("derailed"),
        "scenario": plan.get("scenario"),
        "routes": routes,
        "summary": summary,
        "inventory": pages,
    }


def learned_routes(plan: Dict[str, Any], output: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The address each screen was found at, against the one the Knowledge Bases record.

    state: same (as recorded), new (none recorded), differs (recorded, but
    the screen was found elsewhere).
    """
    out = []
    for sid, path in sorted((output.get("routes") or {}).items()):
        known = ((plan.get("signatures") or {}).get(sid) or {}).get("route")
        state = "new" if not known else ("same" if known == path else "differs")
        out.append({"screen_id": sid, "path": path, "known": known, "state": state})
    return out


def route_changes(evaluated: Dict[str, Any], kb: "store.JourneyKB", automation_profile: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    """Addresses learnt by a walk, as changes: the Automation KB's endpoints and the Journey KB's link to them.

    A screen found at an address the KBs do not record gets an endpoint named
    after it and a route_ref; one found elsewhere than recorded has its
    endpoint (or its own route) corrected. The query a recorded address
    carries is kept -- the walk compares paths only.
    """
    endpoints = automation_profile.get("endpoints") or {}
    automation: List[Dict[str, Any]] = []
    journey: List[Dict[str, Any]] = []
    for r in evaluated.get("routes") or []:
        if r["state"] == "same" or r["screen_id"] not in kb.screens:
            continue
        screen = kb.screens[r["screen_id"]]
        ref = screen.get("route_ref") or ""
        if r["state"] == "differs" and ref.startswith("endpoints.") and ref.split(".", 1)[1] in endpoints:
            key = ref.split(".", 1)[1]
            query = str(endpoints[key]).partition("?")[2]
            automation.append({"file": "app_profile.json", "op": "set", "path": ref, "value": r["path"] + (f"?{query}" if query else ""),
                               "note": f"{r['screen_id']} was found at {r['path']}, not {r['known']}"})
            continue
        if r["state"] == "differs" and screen.get("route"):
            query = str(screen["route"]).partition("?")[2]
            journey.append({"file": "screens.json", "op": "set", "path": f"screens[screen_id={r['screen_id']}].route",
                            "value": r["path"] + (f"?{query}" if query else ""), "note": f"found at {r['path']}, not {r['known']}"})
            continue
        base = re.sub(r"^scr_", "", r["screen_id"].lower()) or "screen"
        key, n = base, 2
        while key in endpoints and endpoints[key] != r["path"]:
            key, n = f"{base}_{n}", n + 1
        if endpoints.get(key) != r["path"]:
            automation.append({"file": "app_profile.json", "op": "set", "path": f"endpoints.{key}", "value": r["path"],
                               "note": f"the address {r['screen_id']} was found at"})
        journey.append({"file": "screens.json", "op": "set", "path": f"screens[screen_id={r['screen_id']}].route_ref",
                        "value": f"endpoints.{key}", "note": f"found at {r['path']} by the walk"})
    return {"automation": automation, "journey": journey}


# --- Every element on every screen (phase 2) ----------------------------------------------

_STOP_WORDS = {"the", "and", "for", "with", "your", "you", "this", "that", "click", "enter", "select", "tap",
               "verify", "check", "confirm", "button", "field", "link", "page", "screen", "into", "from", "then"}
ROLE_TYPES = {
    "button": "button", "link": "link", "textbox": "text_input", "password": "password_input", "checkbox": "checkbox",
    "radio": "radio", "combobox": "dropdown", "tab": "tab", "menuitem": "menu_item", "switch": "toggle", "option": "option",
}


# Words that name the same thing on a screen: a design's "one-time password"
# is the app's "OTP", its "continue" the app's "next" or "proceed".
_SAME = [{"otp", "code", "passcode"}, {"continue", "next", "proceed", "receive", "request", "send"},
         {"login", "signin", "sign"}, {"logout", "signout"}, {"email", "username", "mail"},
         {"organization", "organisation", "org", "company"}, {"search", "find"}, {"close", "dismiss", "cancel"}]


def _words(text: Optional[str]) -> set:
    lowered = (text or "").lower()
    words = {w for w in re.findall(r"[a-z0-9]+", lowered) if len(w) > 2 and w not in _STOP_WORDS}
    if re.search(r"one[- ]?time\s+pass(word|code)", lowered):
        words.add("otp")
    for group in _SAME:
        if words & group:
            words |= group
    return words


def _page_key(url: Optional[str]) -> str:
    match = re.match(r"https?://[^/?#]+([^?#]*)", url or "")
    return (match.group(1) if match else (url or "")).rstrip("/") or "/"


def inventory(plan: Dict[str, Any], output: Dict[str, Any], rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Per screen the walk reached: every interactive element, and which design element each one is.

    An element is the design's when the walk captured that selector for a
    design element, or its name is a design element's label or alias.
    Anything else is app-only: in the running application, not in the
    Journey KB. Header, footer and navigation elements are site-wide
    ("chrome") and never counted as missing from a screen's design.
    """
    by_screen: Dict[str, List[Dict[str, Any]]] = {}
    for sid, els in (plan.get("screens") or {}).items():
        by_screen.setdefault(sid, []).extend(els)
    by_selector = {r["selector"]: r for r in rows if r.get("selector")}
    out = []
    for page in output.get("pages", []):
        sid = page.get("screen_id")
        design = by_screen.get(sid or "", [])
        names = {}
        for el in design:
            for label in [el.get("clean_label"), *(el.get("aliases") or []), *(el.get("accepted_labels") or [])]:
                if label:
                    names[_norm(label)] = el["element_id"]
        elements = []
        for e in page.get("elements", []):
            matched = (by_selector.get(e.get("selector")) or {}).get("element_id") or names.get(_norm(e.get("name")))
            elements.append({**e, "matched": matched})
        out.append({
            "screen_id": sid, "url": page.get("url"), "page": _page_key(page.get("url")), "elements": elements,
            "app_only": sum(1 for e in elements if not e["matched"] and not e.get("chrome")),
        })
    return out


def candidates_for(row: Dict[str, Any], pages: List[Dict[str, Any]], limit: int = 3) -> List[Dict[str, Any]]:
    """The elements on the row's screen most likely to be the one the walk could not find."""
    wanted = _words(" ".join(filter(None, [row.get("design_label"), row.get("element_id", "").replace("_", " "),
                                           row.get("step_text")])))
    if not wanted:
        return []
    page = next((p for p in pages if row.get("screen_id") and p["screen_id"] == row["screen_id"]), None)
    if page is None and row.get("url"):
        page = next((p for p in pages if p["page"] == _page_key(row["url"])), None)
    if page is None:
        return []
    clickable = row.get("kind") == "click"
    scored = []
    for e in page["elements"]:
        if e.get("chrome") and not wanted & _words(e.get("name")):
            continue
        score = len(wanted & _words(e.get("name")))
        if score:
            # A click step is a button or a link more often than a field.
            if clickable and e.get("role") in ("button", "link", "tab", "menuitem"):
                score += 0.5
            scored.append((score, e))
    scored.sort(key=lambda pair: -pair[0])
    return [{"selector": e["selector"], "name": e.get("name"), "role": e.get("role"), "score": score} for score, e in scored[:limit]]


def _element_id(name: str, role: str, taken: set) -> str:
    base = "_".join(re.findall(r"[a-z0-9]+", (name or "").lower())[:4]) or "element"
    suffix = {"button": "btn", "link": "link", "textbox": "input", "password": "input", "checkbox": "check",
              "radio": "radio", "combobox": "select", "tab": "tab"}.get(role, "")
    candidate = f"{base}_{suffix}" if suffix and not base.endswith(suffix) else base
    unique, n = candidate[:60], 2
    while unique in taken:
        unique, n = f"{candidate[:56]}_{n}", n + 1
    taken.add(unique)
    return unique


def additions(evaluated: Dict[str, Any], keys: List[str], *, walk_id: Any) -> Dict[str, List[Dict[str, Any]]]:
    """Journey KB elements and Automation KB selectors for app-only elements the reviewer chose.

    `keys` are "<screen_id>|<selector>". Each becomes an element of that
    screen (basis "crawled", its label as the app shows it) linked to a new
    selector in the screen's selectors group.
    """
    wanted = set(keys)
    journey: List[Dict[str, Any]] = []
    groups: Dict[str, Dict[str, str]] = {}
    for page in evaluated.get("inventory", []):
        sid = page.get("screen_id")
        if not sid:
            continue
        taken = {e.get("matched") for e in page["elements"] if e.get("matched")}
        for e in page["elements"]:
            if f"{sid}|{e['selector']}" not in wanted or e.get("matched"):
                continue
            element_id = _element_id(e.get("name") or "", e.get("role") or "", taken)
            group = sid.lower()
            groups.setdefault(group, {})[element_id] = e["selector"]
            journey.append({
                "file": "screens.json", "op": "set",
                "path": f"screens[screen_id={sid}].elements[element_id={element_id}]",
                "value": {
                    "element_id": element_id, "label": e.get("name") or element_id,
                    "type": ROLE_TYPES.get(e.get("role") or "", e.get("role") or "control"), "basis": "crawled",
                    "locator_hint": f'{e.get("role")} "{e.get("name")}"' if e.get("name") else None,
                    "automation_ref": f"selectors.{group}.{element_id}", "sources": [f"journey walk #{walk_id}"],
                },
                "note": f"in the app, not in the design: {e.get('role')} '{e.get('name')}'",
            })
    return {"journey": journey, "groups": groups}


# --- Fixes and generated flows (phase 3) ----------------------------------------------------

def flow_fixes(evaluated: Dict[str, Any], flow_rel: str, picks: Dict[int, str]) -> List[Dict[str, Any]]:
    """The flow's step targets a walk supports changing.

    A step whose recorded selector failed but which the walk found another way
    gets the selector it was found with; a step the reviewer picked a
    candidate for gets that one. `picks` is {step_number: selector}.
    """
    changes = []
    seen = set()
    for row in evaluated.get("rows", []):
        if not row["element_id"].startswith("step_"):
            continue
        number = int(row["element_id"].split("_", 1)[1])
        selector = picks.get(number)
        why = "picked by the reviewer from the walk's candidates"
        if not selector and row["outcome"] == "healed" and row.get("selector") and not row.get("ambiguous") and not row.get("data_dependent"):
            selector, why = row["selector"], f"the recorded selector failed; the walk found it with {row['strategy']}"
        if not selector or selector == row.get("kb_target"):
            continue
        seen.add(number)
        changes.append({"file": flow_rel, "op": "set", "path": f"canonical_steps[step_number={number}].target",
                        "value": selector, "note": f"step {number}: was {row.get('kb_target')}; {why}"})
    for number, selector in picks.items():
        if number not in seen and selector:
            changes.append({"file": flow_rel, "op": "set", "path": f"canonical_steps[step_number={number}].target",
                            "value": selector, "note": f"step {number}: picked by the reviewer"})
    return changes


def flow_from_walk(plan: Dict[str, Any], evaluated: Dict[str, Any], journey: Dict[str, Any],
                   journeys: Optional[Dict[str, Dict[str, Any]]] = None) -> Dict[str, Any]:
    """A flow blueprint from a journey walk: the steps it performed, with the selectors it used.

    Only steps that ran are kept, so the flow is what the application really
    did; each target is the selector captured for that step (or the route it
    opened). The flow is a proposal like any other: reviewed before it lands.
    """
    rows = {(r["screen_id"], r["element_id"]): r for r in evaluated.get("rows", [])}
    steps_out = []
    entry = None
    by_order = {s["order"]: s for s in evaluated.get("steps", [])}
    for order, item in enumerate(plan.get("items", []), start=1):
        step = by_order.get(order) or {}
        if step.get("status") != "done":
            continue
        target = None
        if item["kind"] == "goto":
            target = item.get("route")
            entry = entry or target
        elif item.get("element"):
            row = rows.get((item["element"]["screen_id"], item["element"]["element_id"])) or {}
            target = row.get("selector") if not row.get("data_dependent") else None
            target = target or item["element"].get("kb_target")
        if not target:
            continue
        source = (journeys or {}).get(item.get("journey_id")) or (journey if item.get("journey_id") == journey["journey_id"] else {})
        expected = next((s.get("expected_result") for s in source.get("steps", []) if s.get("step_number") == item.get("step_number")), "")
        steps_out.append({"step_number": len(steps_out) + 1, "action": item["text"], "target": target, "expected_result": expected or ""})
    flow_id = "flow_" + re.sub(r"[^a-z0-9]+", "_", journey["journey_id"].lower()).strip("_")[-60:]
    return {
        "flow_id": flow_id,
        "flow_name": journey.get("name") or journey["journey_id"],
        "category": (journey.get("journey_path") or ["Journeys"])[0].title(),
        "subcategory": journey.get("name"),
        "target_match_keywords": journey.get("match_keywords", []),
        "catalog_entrypoint": entry or "",
        "automation_boundary": journey.get("automation_boundary") or {},
        "graph_edges": [],
        "canonical_steps": steps_out,
        "test_data_notes": "Generated from a journey walk; values come from Test Data.",
        "generated_from": {"journey_id": journey["journey_id"]},
    }


# --- Proposing change sets ------------------------------------------------------------------

def proposal(evaluated: Dict[str, Any], automation_profile: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    """The Automation KB and Journey KB changes a crawl result supports.

    Only elements the crawl captured with an unambiguous selector are
    proposed. A new selector goes into a selectors group named after its
    screen (selectors.scr_login.tab_otp) and the Journey KB element is linked
    to it. A healed one replaces the failing selector where it lives, so every
    reference to it heals together; when its group is gone (a broken
    reference), it is placed like a new one and the link is moved.
    """
    selectors = automation_profile.get("selectors") or {}
    groups: Dict[str, Dict[str, Any]] = {}
    automation: List[Dict[str, Any]] = []
    journey: List[Dict[str, Any]] = []
    for row in evaluated["rows"]:
        if row["outcome"] not in ("new", "healed") or not row["selector"] or row["ambiguous"] or row["data_dependent"]:
            continue
        ref = row.get("kb_ref") or ""
        parts = ref.split(".")
        if row["outcome"] == "healed" and len(parts) >= 3 and parts[0] == "selectors" and isinstance(selectors.get(parts[1]), dict):
            automation.append({"file": "app_profile.json", "op": "set", "path": ref, "value": row["selector"],
                               "note": f"was {row['kb_target']}; the crawl found {row['screen_id']} · {row['element_id']} with {row['strategy']}"})
            continue
        group = row["screen_id"].lower()
        groups.setdefault(group, {})[row["element_id"]] = row["selector"]
        new_ref = f"selectors.{group}.{row['element_id']}"
        journey.append({"file": "screens.json", "op": "set",
                        "path": f"screens[screen_id={row['screen_id']}].elements[element_id={row['element_id']}].automation_ref",
                        "value": new_ref, "note": f"captured by the crawl ({row['strategy']})"})
    for group, entries in groups.items():
        existing = selectors.get(group) if isinstance(selectors.get(group), dict) else {}
        automation.append({"file": "app_profile.json", "op": "set", "path": f"selectors.{group}",
                           "value": {**existing, **entries}, "note": f"{len(entries)} selector(s) captured by the crawl"})
    return {"automation": automation, "journey": journey}
