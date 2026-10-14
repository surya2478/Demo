"""--- A new journey from a browser capture --------------------------------------------------

Most of the master topic list has a name and no steps yet ("awaiting source"),
so a capture of, say, ordering a plan has no journey to be matched against.
This builds one from the capture:

  where     an existing journey of the master list that has no steps yet, or a
            new one placed under a chapter, group or journey
  screens   each kept page is a screen: the Journey KB screen with its route,
            or a new one whose elements are the page's objects (labels and
            types only -- selectors belong to the Automation KB, which the
            capture fills when it is imported against this journey)
  steps     proposed from the page order: open the first page, fill what was
            picked as a field, then click the object that leads to the next
            page (the one whose label best names that page); the reviewer
            rewords, reorders and re-points them before saving

All of it is one Journey KB change set -- the journey file, its place in the
taxonomy (overlay added_nodes / nodes) and new screens or elements -- approved
and published like any other.
"""
from __future__ import annotations

import copy
import re
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from ...models.kb_changes import KbChangeSet
from . import changesets, documents, editing, journey_capture, journey_crawl, store

MAX_ELEMENTS_PER_SCREEN = 120
JOURNEY_KINDS = ("journey", "variant")

# Captured role -> Journey KB element type (documents.ELEMENT_TYPES).
_TYPE = {
    "textbox": "text_input", "searchbox": "text_input", "password": "password_input", "combobox": "dropdown",
    "select": "dropdown", "checkbox": "checkbox", "radio": "radio", "tab": "tab", "link": "link",
    "button": "button", "menuitem": "button", "switch": "checkbox", "heading": "heading",
    "columnheader": "text", "alert": "inline_error", "clickable": "control",
}


class CaptureJourneyError(ValueError):
    """A journey that cannot be built as asked; the message is user-facing."""


def _words(text: Optional[str]) -> set:
    return journey_crawl._words(text)


def _norm(text: Optional[str]) -> str:
    return journey_crawl._norm(text)


def _etype(obj: Dict[str, Any]) -> str:
    if obj.get("kind") == "text" or (obj.get("kind") != "picked" and obj.get("role") in ("heading", "columnheader")):
        return "heading" if obj.get("role") == "heading" else "text"
    if obj.get("action") == "fill":
        return "text_input"
    if obj.get("action") == "select":
        return "dropdown"
    t = _TYPE.get((obj.get("role") or "").lower())
    if t:
        return t
    return {"a": "link", "button": "button", "input": "text_input", "select": "dropdown", "textarea": "text_input"}.get(obj.get("tag") or "", "control")


def _route_of(screen: Dict[str, Any]) -> Optional[str]:
    route = (screen.get("route") or "").split("?", 1)[0].split("#", 1)[0].rstrip("/")
    return route or None


def _existing_screen(kb: store.JourneyKB, page: Dict[str, Any]) -> Optional[str]:
    """The Journey KB screen this page is: chosen in the flow view, else same route, else same name."""
    chosen = page.get("screen_id")
    if chosen and chosen in kb.screens:
        return chosen
    path = (journey_capture._path(page.get("url")) or "").rstrip("/")
    for sid, screen in kb.screens.items():
        if path and _route_of(screen) == path:
            return sid
    names = {_norm(page.get("name")), _norm(page.get("title"))} - {""}
    for sid, screen in kb.screens.items():
        if _norm(screen.get("name")) in names:
            return sid
    return None


def _pages(capture) -> List[Dict[str, Any]]:
    pages = journey_capture.apply_edits(capture.pages or [], capture.edits)
    if not pages:
        raise CaptureJourneyError("No page is left in the capture.")
    return pages


def _trigger(page: Dict[str, Any], target: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The object on `page` most likely clicked to reach `target`: its label names the target page."""
    want = _words(target.get("name")) | _words(target.get("title"))
    want |= _words((journey_capture._path(target.get("url")) or "").replace("/", " ").replace("-", " ").replace("_", " "))
    for obj in target.get("elements") or []:
        if obj.get("role") == "heading" or obj.get("kind") == "text":
            want |= _words(obj.get("name"))
    best, best_score = None, 0.0
    for obj in page.get("elements") or []:
        if obj.get("kind") == "text" or obj.get("action") in ("fill", "select"):
            continue
        words = _words(obj.get("name"))
        if not words:
            continue
        score = len(words & want) / len(words)
        if obj.get("picked"):
            score += 0.3
        if obj.get("role") == "clickable" or obj.get("role") in ("button", "link", "tab", "menuitem"):
            score += 0.1
        if obj.get("chrome"):
            score -= 0.05  # a header link is right only when nothing on the page names the target
        if score > best_score:
            best, best_score = obj, score
    return best if best_score >= 0.5 else None


def propose(kb: store.JourneyKB, capture) -> Dict[str, Any]:
    """Draft steps and screens for a journey made from the capture, for the reviewer to edit."""
    pages = _pages(capture)
    page_out, steps = [], []
    for page in pages:
        sid = _existing_screen(kb, page)
        page_out.append({"page_id": page["page_id"], "name": page["name"], "path": journey_capture._path(page.get("url")),
                         "screen_id": sid, "screen_name": (kb.screens.get(sid) or {}).get("name") if sid else None,
                         "objects": [{"selector": e["selector"], "name": e["name"], "type": _etype(e),
                                      "kind": "picked" if e.get("picked") else e.get("kind"), "chrome": bool(e.get("chrome"))}
                                     for e in page["elements"] if e.get("name")]})
    first = pages[0]
    steps.append({"action": f"Open {first['name']}", "expected_result": f"{first['name']} is shown",
                  "page_id": first["page_id"], "selector": None})
    for i, page in enumerate(pages):
        for obj in page["elements"]:
            if obj.get("picked") and obj.get("action") in ("fill", "select"):
                verb = "Enter" if obj["action"] == "fill" else "Select"
                steps.append({"action": f"{verb} {obj['name']}", "expected_result": f"{obj['name']} takes the value",
                              "page_id": page["page_id"], "selector": obj["selector"]})
            elif obj.get("picked") and obj.get("action") == "assert":
                steps.append({"action": f"Check {obj['name']}", "expected_result": f"'{obj['name']}' is displayed",
                              "page_id": page["page_id"], "selector": obj["selector"]})
        if i + 1 < len(pages):
            target = pages[i + 1]
            hit = _trigger(page, target)
            steps.append({
                "action": f"Click '{hit['name']}'" if hit else f"Go to {target['name']}",
                "expected_result": f"{target['name']} is shown",
                "page_id": page["page_id"], "selector": hit["selector"] if hit else None,
                **({} if hit else {"note": "No object on this page names the next one: choose the one you clicked."}),
            })
    return {"pages": page_out, "steps": steps,
            "title": pages[-1]["name"] if len(pages) > 1 else first["name"]}


# --- Building the change set -------------------------------------------------------------------

def _element_value(obj: Dict[str, Any], element_id: str, source: str) -> Dict[str, Any]:
    etype = _etype(obj)
    if etype not in documents.ELEMENT_TYPES:
        etype = "control"
    return {"element_id": element_id, "label": obj["name"], "type": etype, "used_by_journeys": [],
            "basis": "captured", "locator_hint": documents.locator_hint(etype, obj["name"]), "automation_ref": None,
            "aliases": [], "sources": [source]}


def _unique(base: str, taken: set) -> str:
    out, n = base, 2
    while out in taken:
        out, n = f"{base}_{n}", n + 1
    taken.add(out)
    return out


def build(db: Session, kb: store.JourneyKB, capture, *, journey_id: Optional[str], parent_id: Optional[str],
          title: Optional[str], steps: List[Dict[str, Any]], actor: Optional[str]) -> Tuple[KbChangeSet, str]:
    """Draft the Journey KB change set; returns (change set, journey id)."""
    pages = _pages(capture)
    by_page = {p["page_id"]: p for p in pages}
    steps = [s for s in steps if isinstance(s, dict) and str(s.get("action") or "").strip()]
    if not steps:
        raise CaptureJourneyError("Give the journey at least one step.")
    for s in steps:
        if s.get("page_id") not in by_page:
            raise CaptureJourneyError(f"Step '{s.get('action')}' is on a page that is not in the capture.")

    overlay_changes: List[Dict[str, Any]] = []
    if journey_id:
        node = kb.node(journey_id)
        if node is None:
            raise LookupError(f"No journey '{journey_id}'.")
        if node.get("kind") not in JOURNEY_KINDS:
            raise CaptureJourneyError(f"'{node['title']}' is a {node.get('kind')}, not a journey: choose a journey, or add a new one under it.")
        if journey_id in kb.journeys:
            raise CaptureJourneyError(f"'{node['title']}' already has steps: import the capture against it instead.")
        name = (title or "").strip() or node["title"]
        path = list(node.get("path") or [node["title"]])
    else:
        if not parent_id:
            raise CaptureJourneyError("Choose where the new journey goes in the master list.")
        added, fresh, _ = editing.new_nodes(kb, [(parent_id, title or "")])
        journey_id = fresh[0]["id"]
        name = fresh[0]["title"]
        parent = kb.node(parent_id) or {}
        path = list(parent.get("path") or [parent.get("title", "")]) + [name]
        overlay_changes.append({"file": editing.OVERLAY, "op": "set", "path": "added_nodes", "value": added,
                                "note": f"{journey_id} under {parent.get('title')}"})

    source = f"Browser capture #{capture.id}" + (f" ({capture.host})" if capture.host else "")
    # Each page used by a step, or kept in the capture, becomes a screen.
    screen_of: Dict[str, str] = {}
    new_screens: Dict[str, Dict[str, Any]] = {}
    added_elements: Dict[Tuple[str, str], Dict[str, Any]] = {}
    taken_screens = set(kb.screens)
    for page in pages:
        sid = _existing_screen(kb, page)
        if sid:
            screen_of[page["page_id"]] = sid
            continue
        sid = _unique(documents._screen_id("", page["name"]), taken_screens)
        screen_of[page["page_id"]] = sid
        taken = set()
        elements = []
        for obj in page["elements"]:
            if not obj.get("name") or obj.get("chrome") or len(elements) >= MAX_ELEMENTS_PER_SCREEN:
                continue
            eid = _unique(documents._snake(obj["name"]), taken)
            elements.append({**_element_value(obj, eid, source), "_selector": obj["selector"]})
        new_screens[sid] = {"screen_id": sid, "name": page["name"], "route": journey_capture._path(page.get("url")), "route_ref": None,
                            "sources": [source], "functional_purpose": "", "layout_regions": [], "elements": elements,
                            "transitions": [], "basis": "captured"}

    def element_for(page: Dict[str, Any], selector: str) -> Optional[str]:
        """The element id a step's object is on its screen; added to the screen when it is new there."""
        obj = next((e for e in page["elements"] if e["selector"] == selector), None)
        if obj is None or not obj.get("name"):
            return None
        sid = screen_of[page["page_id"]]
        if sid in new_screens:
            screen = new_screens[sid]
            hit = next((e for e in screen["elements"] if e.get("_selector") == selector), None)
            if hit is None:  # a header or footer object the screen left out
                eid = _unique(documents._snake(obj["name"]), {e["element_id"] for e in screen["elements"]})
                hit = {**_element_value(obj, eid, source), "_selector": selector}
                screen["elements"].append(hit)
            return hit["element_id"]
        existing = kb.screens[sid].get("elements") or []
        for el in existing:
            labels = {_norm(el.get("label")), *(_norm(a) for a in el.get("aliases") or [])}
            if _norm(obj["name"]) in labels:
                return el["element_id"]
        key = (sid, selector)
        if key not in added_elements:
            taken = {e["element_id"] for e in existing} | {v["element_id"] for (s, _), v in added_elements.items() if s == sid}
            added_elements[key] = _element_value(obj, _unique(documents._snake(obj["name"]), taken), source)
        return added_elements[key]["element_id"]

    journey_steps = []
    for n, s in enumerate(steps, start=1):
        page = by_page[s["page_id"]]
        step = {"step_number": n, "action": str(s["action"]).strip()[:500],
                "expected_result": str(s.get("expected_result") or "").strip()[:500],
                "screen_id": screen_of[page["page_id"]]}
        if s.get("selector"):
            eid = element_for(page, s["selector"])
            if eid:
                step["element_id"] = eid
        journey_steps.append(step)

    # Which journey uses which element: the screens record it.
    for step in journey_steps:
        if not step.get("element_id"):
            continue
        sid, eid = step["screen_id"], step["element_id"]
        target = None
        if sid in new_screens:
            target = next(e for e in new_screens[sid]["elements"] if e["element_id"] == eid)
        else:
            target = next((v for (s2, _), v in added_elements.items() if s2 == sid and v["element_id"] == eid), None)
        if target is not None and journey_id not in target["used_by_journeys"]:
            target["used_by_journeys"].append(journey_id)

    used_screens = list(dict.fromkeys(st["screen_id"] for st in journey_steps))
    changes: List[Dict[str, Any]] = list(overlay_changes)
    for sid, screen in new_screens.items():
        if sid not in used_screens:
            continue  # a page no step is on adds nothing to the KB
        screen = copy.deepcopy(screen)
        for e in screen["elements"]:
            e.pop("_selector", None)
        changes.append({"file": "screens.json", "op": "set", "path": f"screens[screen_id={sid}]", "value": screen,
                        "note": f"new screen with {len(screen['elements'])} element(s), from {source}"})
    for (sid, _), element in added_elements.items():
        changes.append({"file": "screens.json", "op": "set",
                        "path": f"screens[screen_id={sid}].elements[element_id={element['element_id']}]",
                        "value": element, "note": f"from {source}"})

    page_names = [by_page[p]["name"] for p in dict.fromkeys(s["page_id"] for s in steps)]
    journey = {
        "journey_id": journey_id, "name": name, "journey_path": path, "sources": [source],
        "roles": [], "prerequisite_journeys": [], "next_journeys": [], "automation_flow_ids": [],
        "screens": used_screens, "business_rules": [],
        "match_keywords": list(dict.fromkeys(k for k in [name.lower(), *(p.lower() for p in page_names)] if k))[:12],
        "automation_boundary": {"automated_scope": " -> ".join(page_names), "external_boundary": ""},
        "steps": journey_steps,
    }
    journeys_dir = kb.manifest.get("files", {}).get("journeys_dir", "journeys")
    slug = "_".join(journey_id.lower().split(".")[-2:])
    rel, n = f"{journeys_dir}/{slug}.json", 2
    while (kb.directory / rel).exists():
        rel, n = f"{journeys_dir}/{slug}_{n}.json", n + 1
    changes.append({"file": rel, "op": "create", "path": changesets.ROOT, "value": journey,
                    "note": f"{len(journey_steps)} steps from {source}"})
    overlay = editing._overlay(kb)
    node = copy.deepcopy(overlay.get("nodes", {}).get(journey_id, {}))
    node.update({"status": "detailed", "journey_file": rel})
    node["sources"] = sorted(set(node.get("sources", [])) | {source})
    changes.append({"file": editing.OVERLAY, "op": "set", "path": f'nodes["{journey_id}"]', "value": node,
                    "note": "marks the journey detailed in the taxonomy"})

    change_set = changesets.draft(
        db, app_id=kb.app_id, kb="journey", title=f"New journey from capture #{capture.id}: {name}",
        changes=changes, source="capture",
        description=f"{len(journey_steps)} steps over {len(used_screens)} screen(s), from {source}.",
        origin={"edit": {"journey_id": journey_id}, "capture": {"capture_id": capture.id}}, actor=actor,
    )
    return change_set, journey_id
