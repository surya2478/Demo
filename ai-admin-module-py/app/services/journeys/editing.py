"""
--- Journey KB editing: the tree and a journey's steps -----------------------------

What a document extraction gets wrong has to be correctable on the Knowledge
Base page -- a step in the wrong place sends a journey crawl looking for the
wrong control, and a mis-titled journey matches the wrong requirements.

Every edit here becomes a change set (changesets.draft), so it is reviewed,
published atomically, versioned and revertable like any other KB change. This
module only works out WHICH changes an edit means:

  * The tree is generated (taxonomy.py) from the master outline plus
    sources/taxonomy_overlay.json, and a journey's id is derived from its
    title. Edits therefore go into the overlay -- renaming a journey sets its
    title there, so the id that journey files, test cases and crawls name
    never changes.

  * Steps are numbered, and other parts of a journey point at those numbers:
    a branch's at_step, a scenario's list of steps, and "step 8 -> back to
    step 6" in a branch's outcome. Reordering or deleting steps renumbers all
    of them in the same change set, or the journey would quietly contradict
    itself.

  * Matching (store.match_journey) reads the journey FILES, not the tree. A
    removed journey's file is deleted with it, or it would go on steering
    generation and crawls while no longer shown.
"""
from __future__ import annotations

import copy
import json
import re
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from ...models.kb_changes import KbChangeSet
from . import changesets, store, taxonomy

OVERLAY = "sources/taxonomy_overlay.json"

# The step fields an editor may set; everything else on a step is kept.
STEP_FIELDS = ("action", "expected_result", "screen_id", "element_id")


class EditError(ValueError):
    """An edit that cannot be made as asked."""


# --- Reading -------------------------------------------------------------------------------

def _overlay(kb: store.JourneyKB) -> Dict[str, Any]:
    return json.loads((kb.directory / OVERLAY).read_text(encoding="utf-8"))


def _journey_files(kb: store.JourneyKB) -> Dict[str, str]:
    """journey_id -> its file, relative to the KB folder."""
    journeys_dir = kb.manifest.get("files", {}).get("journeys_dir", "journeys")
    folder = kb.directory / journeys_dir
    out: Dict[str, str] = {}
    for path in sorted(folder.glob("*.json")) if folder.exists() else []:
        try:
            jid = json.loads(path.read_text(encoding="utf-8")).get("journey_id")
        except Exception:  # noqa: BLE001 - an unreadable file is not one we can edit
            continue
        if jid:
            out[jid] = f"{journeys_dir}/{path.name}"
    return out


def _node(kb: store.JourneyKB, journey_id: str) -> Dict[str, Any]:
    node = kb.node(journey_id)
    if node is None:
        raise LookupError(f"No journey '{journey_id}'.")
    return node


def _subtree(kb: store.JourneyKB, journey_id: str) -> List[str]:
    by_id = {n["id"]: n for n in kb.taxonomy.get("nodes", [])}
    out, pending = [], [journey_id]
    while pending:
        current = pending.pop(0)
        out.append(current)
        pending.extend(by_id.get(current, {}).get("children", []))
    return out


def _clean_title(title: str) -> str:
    title = re.sub(r"\s+", " ", (title or "")).strip()
    if not title:
        raise EditError("A journey needs a name.")
    if len(title) > 200:
        raise EditError("A journey name is at most 200 characters.")
    return title


def _draft(db: Session, kb: store.JourneyKB, *, title: str, changes: List[Dict[str, Any]],
           description: Optional[str], actor: Optional[str], journey_id: str) -> KbChangeSet:
    return changesets.draft(
        db, app_id=kb.app_id, kb="journey", title=title, changes=changes, source="manual",
        description=description, origin={"edit": {"journey_id": journey_id}}, actor=actor,
    )


# --- The tree ------------------------------------------------------------------------------

def rename(db: Session, kb: store.JourneyKB, journey_id: str, title: str, *, actor: Optional[str]) -> KbChangeSet:
    """Give a journey a new name; its id, and everything naming it, stay."""
    node = _node(kb, journey_id)
    title = _clean_title(title)
    if title == node["title"]:
        raise EditError("That is already the journey's name.")
    overlay = _overlay(kb)
    entry = dict(overlay.get("nodes", {}).get(journey_id, {}))
    entry["title"] = title
    changes: List[Dict[str, Any]] = [{
        "file": OVERLAY, "op": "set", "path": f'nodes["{journey_id}"]', "value": entry,
        "note": f"{node['title']} -> {title}",
    }]
    # Journey files carry their own name and path; keep them in step with the
    # tree, for this journey and every authored one below it.
    position = len(node.get("path") or [node["title"]]) - 1
    files = _journey_files(kb)
    for jid in _subtree(kb, journey_id):
        rel = files.get(jid)
        journey = kb.journeys.get(jid)
        if not rel or journey is None:
            continue
        path = list(journey.get("journey_path") or [])
        if len(path) > position and path[position] == node["title"]:
            path[position] = title
            changes.append({"file": rel, "op": "set", "path": "journey_path", "value": path})
        if jid == journey_id and journey.get("name") != title:
            changes.append({"file": rel, "op": "set", "path": "name", "value": title})
    return _draft(db, kb, title=f"Rename journey: {node['title']} -> {title}", changes=changes,
                  description=None, actor=actor, journey_id=journey_id)


def add(db: Session, kb: store.JourneyKB, parent_id: Optional[str], title: str, *, actor: Optional[str]) -> KbChangeSet:
    """A new journey under `parent_id`, or a new top-level chapter when None."""
    title = _clean_title(title)
    parent = _node(kb, parent_id) if parent_id else None
    overlay = _overlay(kb)
    existing = {n["id"] for n in kb.taxonomy.get("nodes", [])} | {a["id"] for a in overlay.get("added_nodes", [])}
    if parent is not None:
        siblings = [n for n in kb.taxonomy.get("nodes", []) if n.get("parent") == parent["id"]]
        if any(s["title"].lower() == title.lower() for s in siblings):
            raise EditError(f"'{parent['title']}' already has a journey named '{title}'.")
        base = f"{parent['id']}.{taxonomy._slug(title, overlay.get('id_aliases', {}))}"
    else:
        prefix = kb.manifest.get("id_prefix", "B2B")
        base = f"{prefix}.{taxonomy._slug(title, overlay.get('id_aliases', {}))}"
    new_id, n = base, 2
    while new_id in existing:
        new_id, n = f"{base}_{n}", n + 1
    added = copy.deepcopy(overlay.get("added_nodes", []))
    added.append({"id": new_id, "title": title, "parent": parent["id"] if parent else None})
    where = f"under {parent['title']}" if parent else "as a new chapter"
    return _draft(
        db, kb, title=f"Add journey: {title} {where}",
        changes=[{"file": OVERLAY, "op": "set", "path": "added_nodes", "value": added, "note": new_id}],
        description=None, actor=actor, journey_id=new_id,
    )


def dependents(kb: store.JourneyKB, journey_ids: List[str]) -> List[Dict[str, str]]:
    """Journeys outside `journey_ids` that run one of them first or hand over to one."""
    inside = set(journey_ids)
    out = []
    for journey in kb.journeys.values():
        if journey["journey_id"] in inside:
            continue
        for relation, key in (("runs after", "prerequisite_journeys"), ("hands over to", "next_journeys")):
            named = inside & set(journey.get(key, []))
            if named:
                out.append({"journey_id": journey["journey_id"], "name": journey.get("name") or journey["journey_id"],
                            "relation": f"{relation} {', '.join(sorted(named))}"})
    return out


def remove(db: Session, kb: store.JourneyKB, journey_id: str, *, actor: Optional[str]) -> KbChangeSet:
    """Take a journey, and everything below it, out of the tree; delete their journey files."""
    node = _node(kb, journey_id)
    subtree = _subtree(kb, journey_id)
    overlay = _overlay(kb)
    changes: List[Dict[str, Any]] = []

    added = overlay.get("added_nodes", [])
    kept = [a for a in added if a["id"] not in subtree]
    if len(kept) != len(added):
        changes.append({"file": OVERLAY, "op": "set", "path": "added_nodes", "value": kept})
    # A journey the outline lists is removed by naming it; one added on this
    # page simply stops being added.
    if not any(a["id"] == journey_id for a in added):
        removed = list(overlay.get("removed_nodes", []))
        removed.append(journey_id)
        changes.append({"file": OVERLAY, "op": "set", "path": "removed_nodes", "value": removed,
                        "note": f"{node['title']} and {len(subtree) - 1} below it" if len(subtree) > 1 else node["title"]})
    for jid in subtree:
        if jid in overlay.get("nodes", {}):
            changes.append({"file": OVERLAY, "op": "remove", "path": f'nodes["{jid}"]'})
    files = _journey_files(kb)
    for jid in subtree:
        if jid in files:
            changes.append({"file": files[jid], "op": "delete", "path": changesets.ROOT, "note": f"journey file of {jid}"})

    affected = dependents(kb, subtree)
    description = None
    if affected:
        description = "Still named by: " + "; ".join(f"{a['name']} ({a['relation']})" for a in affected)
    below = f" (+{len(subtree) - 1} below)" if len(subtree) > 1 else ""
    return _draft(db, kb, title=f"Remove journey: {node['title']}{below}", changes=changes,
                  description=description, actor=actor, journey_id=journey_id)


# --- Steps -----------------------------------------------------------------------------------

_STEP_REF = re.compile(r"\b(steps?)(\s+)(\d+)\b", re.IGNORECASE)


def _renumber_text(text: Any, mapping: Dict[int, int]) -> Any:
    if not isinstance(text, str):
        return text
    def sub(m: "re.Match[str]") -> str:
        old = int(m.group(3))
        return f"{m.group(1)}{m.group(2)}{mapping[old]}" if old in mapping else m.group(0)
    return _STEP_REF.sub(sub, text)


def restep(journey: Dict[str, Any], steps: List[Dict[str, Any]]) -> Dict[str, Any]:
    """A journey document's steps replaced by `steps`, and what points at them renumbered.

    Each item is {from_step, action, expected_result, screen_id?, element_id?}:
    `from_step` is the number it had (null for a new step). A step left out is
    deleted. Fields an editor does not set (a step's rule, branch, note) are
    kept from the step it came from. Returns {steps, conditional_branches,
    test_scenarios, notes, deleted}; the document itself is not changed.
    """
    if not steps:
        raise EditError("A journey needs at least one step; remove the journey instead.")
    original = {int(s["step_number"]): s for s in journey.get("steps", []) if s.get("step_number") is not None}
    seen: set[int] = set()
    new_steps: List[Dict[str, Any]] = []
    mapping: Dict[int, int] = {}
    for position, item in enumerate(steps, start=1):
        source = item.get("from_step")
        if source is not None:
            source = int(source)
            if source not in original:
                raise EditError(f"Step {source} is not one of this journey's steps.")
            if source in seen:
                raise EditError(f"Step {source} appears twice.")
            seen.add(source)
            step = copy.deepcopy(original[source])
            mapping[source] = position
        else:
            step = {}
        action = re.sub(r"\s+", " ", str(item.get("action") or "")).strip()
        if not action:
            raise EditError(f"Step {position} needs an action.")
        step["action"] = action
        step["expected_result"] = str(item.get("expected_result") or "").strip()
        for field in ("screen_id", "element_id"):
            value = str(item.get(field) or "").strip()
            if value:
                step[field] = value
            else:
                step.pop(field, None)
        # step_number first, as the files are written.
        new_steps.append({"step_number": position, **{k: v for k, v in step.items() if k != "step_number"}})

    deleted = sorted(set(original) - seen)

    # A branch anchored on a deleted step moves to the nearest step before it
    # that is kept (or the first step), and says so.
    def anchor(old: Any) -> Any:
        if not isinstance(old, int) or old in mapping:
            return mapping.get(old, old)
        earlier = [mapping[s] for s in original if s < old and s in mapping]
        return max(earlier) if earlier else 1

    notes: List[str] = []
    branches = copy.deepcopy(journey.get("conditional_branches", []))
    for branch in branches:
        old = branch.get("at_step")
        branch["at_step"] = anchor(old)
        if isinstance(old, int) and old in deleted:
            notes.append(f"{branch.get('branch_id')}: was at deleted step {old}, now at step {branch['at_step']}")
        for field in ("condition", "outcome"):
            branch[field] = _renumber_text(branch.get(field), mapping)
            stale = sorted({int(m.group(3)) for m in _STEP_REF.finditer(str(branch.get(field) or ""))} & set(deleted))
            if stale:
                notes.append(f"{branch.get('branch_id')} {field} still mentions deleted step {', '.join(map(str, stale))}")

    scenarios = copy.deepcopy(journey.get("test_scenarios", []))
    for scenario in scenarios:
        if isinstance(scenario.get("steps"), list):
            scenario["steps"] = sorted(mapping[s] for s in scenario["steps"] if isinstance(s, int) and s in mapping)
    return {"steps": new_steps, "conditional_branches": branches, "test_scenarios": scenarios,
            "notes": notes, "deleted": deleted}


def _authored(kb: store.JourneyKB, journey_id: str) -> tuple[Dict[str, Any], Dict[str, Any], str]:
    node = _node(kb, journey_id)
    journey = kb.journeys.get(journey_id)
    rel = _journey_files(kb).get(journey_id)
    if journey is None or rel is None:
        raise EditError(f"'{node['title']}' has no authored journey file to edit yet.")
    return node, journey, rel


def edit_steps(db: Session, kb: store.JourneyKB, journey_id: str, steps: List[Dict[str, Any]],
               *, actor: Optional[str]) -> KbChangeSet:
    """Replace a journey's steps with `steps`, in that order (see restep)."""
    node, journey, rel = _authored(kb, journey_id)
    result = restep(journey, steps)
    deleted = result["deleted"]
    changes: List[Dict[str, Any]] = [{
        "file": rel, "op": "set", "path": "steps", "value": result["steps"],
        "note": f"{len(result['steps'])} steps" + (f"; deleted {', '.join(map(str, deleted))}" if deleted else ""),
    }]
    for field in ("conditional_branches", "test_scenarios"):
        if result[field] != journey.get(field, []):
            changes.append({"file": rel, "op": "set", "path": field, "value": result[field]})
    if result["steps"] == journey.get("steps", []) and len(changes) == 1:
        raise EditError("Nothing changed.")
    return _draft(db, kb, title=f"Edit steps: {journey.get('name') or node['title']}", changes=changes,
                  description="; ".join(result["notes"]) or None, actor=actor, journey_id=journey_id)


# --- Branches, scenarios and the journeys around one -------------------------------------------

def _text(value: Any, limit: int = 1000) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _next_id(existing: List[str], prefix: str) -> str:
    n = 1
    while f"{prefix}{n}" in existing:
        n += 1
    return f"{prefix}{n}"


def _id_prefix(ids: List[str], fallback: str) -> str:
    """'OTP-B' from ['OTP-B1', 'OTP-B2']; the fallback when there are none to learn from."""
    for value in ids:
        m = re.match(r"^(.*?)(\d+)$", value or "")
        if m:
            return m.group(1)
    return fallback


def edit_branches(db: Session, kb: store.JourneyKB, journey_id: str, branches: List[Dict[str, Any]],
                  *, actor: Optional[str]) -> KbChangeSet:
    """Replace a journey's conditional branches. A blank id gets the next free one."""
    node, journey, rel = _authored(kb, journey_id)
    count = len(journey.get("steps", []))
    old = {b.get("branch_id"): b for b in journey.get("conditional_branches", [])}
    prefix = _id_prefix(list(old), "B")
    out: List[Dict[str, Any]] = []
    ids: List[str] = []
    for position, item in enumerate(branches, start=1):
        branch_id = _text(item.get("branch_id"), 60)
        if branch_id in ids:
            raise EditError(f"Branch id {branch_id} is used twice.")
        branch = copy.deepcopy(old.get(branch_id, {})) if branch_id else {}
        if not branch_id:
            branch_id = _next_id(list(old) + ids, prefix)
        try:
            at_step = int(item.get("at_step"))
        except (TypeError, ValueError):
            raise EditError(f"Branch {position}: choose the step it happens at.") from None
        if not 1 <= at_step <= count:
            raise EditError(f"Branch {position}: step {at_step} does not exist (this journey has {count}).")
        condition, outcome = _text(item.get("condition")), _text(item.get("outcome"))
        if not condition or not outcome:
            raise EditError(f"Branch {position} needs both a condition and an outcome.")
        rule = _text(item.get("rule"), 60) or None
        if rule and rule not in kb.rules:
            raise EditError(f"Branch {position}: there is no rule {rule}.")
        branch.update({"branch_id": branch_id, "at_step": at_step, "condition": condition, "outcome": outcome})
        if rule:
            branch["rule"] = rule
        else:
            branch.pop("rule", None)
        out.append({"branch_id": branch_id, **{k: v for k, v in branch.items() if k != "branch_id"}})
        ids.append(branch_id)
    if out == journey.get("conditional_branches", []):
        raise EditError("Nothing changed.")
    changes = [{"file": rel, "op": "set", "path": "conditional_branches", "value": out}]
    # A scenario that followed a deleted branch no longer names it.
    scenarios = copy.deepcopy(journey.get("test_scenarios", []))
    notes = []
    for scenario in scenarios:
        if scenario.get("branch") and scenario["branch"] not in ids:
            notes.append(f"{scenario.get('scenario_id')} followed deleted branch {scenario['branch']}")
            scenario.pop("branch")
    if scenarios != journey.get("test_scenarios", []):
        changes.append({"file": rel, "op": "set", "path": "test_scenarios", "value": scenarios})
    return _draft(db, kb, title=f"Edit branches: {journey.get('name') or node['title']}", changes=changes,
                  description="; ".join(notes) or None, actor=actor, journey_id=journey_id)


SCENARIO_TYPES = ("positive", "negative", "alternate", "edge", "boundary", "data", "empty_state", "security", "ui")


def edit_scenarios(db: Session, kb: store.JourneyKB, journey_id: str, scenarios: List[Dict[str, Any]],
                   *, actor: Optional[str]) -> KbChangeSet:
    """Replace a journey's test scenarios. A blank id gets the next free one."""
    node, journey, rel = _authored(kb, journey_id)
    count = len(journey.get("steps", []))
    branch_ids = {b.get("branch_id") for b in journey.get("conditional_branches", [])}
    old = {s.get("scenario_id"): s for s in journey.get("test_scenarios", [])}
    prefix = _id_prefix(list(old), "TS-")
    out: List[Dict[str, Any]] = []
    ids: List[str] = []
    for position, item in enumerate(scenarios, start=1):
        scenario_id = _text(item.get("scenario_id"), 60)
        if scenario_id in ids:
            raise EditError(f"Scenario id {scenario_id} is used twice.")
        scenario = copy.deepcopy(old.get(scenario_id, {})) if scenario_id else {}
        if not scenario_id:
            scenario_id = _next_id(list(old) + ids, prefix)
        title = _text(item.get("title"), 300)
        if not title:
            raise EditError(f"Scenario {position} needs a title.")
        kind = _text(item.get("type"), 30).lower() or "positive"
        if kind not in SCENARIO_TYPES:
            raise EditError(f"Scenario {position}: type must be one of {', '.join(SCENARIO_TYPES)}.")
        steps = item.get("steps") or []
        if not isinstance(steps, list) or any(not isinstance(s, int) or not 1 <= s <= count for s in steps):
            raise EditError(f"Scenario {position}: steps must be step numbers from 1 to {count}.")
        branch = _text(item.get("branch"), 60) or None
        if branch and branch not in branch_ids:
            raise EditError(f"Scenario {position}: there is no branch {branch}.")
        scenario.update({"scenario_id": scenario_id, "type": kind, "title": title, "steps": sorted(set(steps))})
        for key, value in (("branch", branch), ("test_data", _text(item.get("test_data"), 120) or None)):
            if value:
                scenario[key] = value
            else:
                scenario.pop(key, None)
        out.append({"scenario_id": scenario_id, **{k: v for k, v in scenario.items() if k != "scenario_id"}})
        ids.append(scenario_id)
    if out == journey.get("test_scenarios", []):
        raise EditError("Nothing changed.")
    return _draft(db, kb, title=f"Edit scenarios: {journey.get('name') or node['title']}",
                  changes=[{"file": rel, "op": "set", "path": "test_scenarios", "value": out}],
                  description=None, actor=actor, journey_id=journey_id)


LINK_KEYS = ("prerequisite_journeys", "next_journeys")


def edit_links(db: Session, kb: store.JourneyKB, journey_id: str, links: Dict[str, List[str]],
               *, actor: Optional[str]) -> KbChangeSet:
    """Which journeys run before this one, and which may follow it.

    The journey file holds them for the chain a crawl walks; the overlay holds
    them for the tree. Both are kept in step when the overlay has them too.
    """
    node, journey, rel = _authored(kb, journey_id)
    known = {n["id"] for n in kb.taxonomy.get("nodes", []) if n.get("kind") != "chapter"}
    overlay = _overlay(kb)
    entry = dict(overlay.get("nodes", {}).get(journey_id, {}))
    changes: List[Dict[str, Any]] = []
    overlay_changed = False
    for key in LINK_KEYS:
        if key not in links:
            continue
        values = list(dict.fromkeys(_text(v, 200) for v in links[key] or [] if _text(v, 200)))
        unknown = [v for v in values if v not in known]
        if unknown:
            raise EditError(f"{key.replace('_', ' ')}: not in the journey tree: {', '.join(unknown)}")
        if journey_id in values:
            raise EditError("A journey cannot run before or after itself.")
        if values != journey.get(key, []):
            changes.append({"file": rel, "op": "set", "path": key, "value": values})
        if key in entry and entry[key] != values:
            entry[key] = values
            overlay_changed = True
    if loop := _prerequisite_cycle(kb, journey_id, links.get("prerequisite_journeys")):
        raise EditError(f"That makes a loop: {loop}.")
    if overlay_changed:
        changes.append({"file": OVERLAY, "op": "set", "path": f'nodes["{journey_id}"]', "value": entry})
    if not changes:
        raise EditError("Nothing changed.")
    return _draft(db, kb, title=f"Edit linked journeys: {journey.get('name') or node['title']}", changes=changes,
                  description=None, actor=actor, journey_id=journey_id)


def _prerequisite_cycle(kb: store.JourneyKB, journey_id: str, prerequisites: Optional[List[str]]) -> Optional[str]:
    """'A -> B -> A' when the new prerequisites lead back to this journey."""
    if not prerequisites:
        return None
    pending = [(p, [journey_id, p]) for p in prerequisites]
    seen: set[str] = set()
    while pending:
        current, path = pending.pop()
        if current == journey_id:
            return " -> ".join(path)
        if current in seen:
            continue
        seen.add(current)
        for nxt in (kb.journeys.get(current) or {}).get("prerequisite_journeys", []):
            pending.append((nxt, path + [nxt]))
    return None


def move(db: Session, kb: store.JourneyKB, journey_id: str, direction: str, *, actor: Optional[str]) -> KbChangeSet:
    """Move a journey one place up or down among its siblings."""
    node = _node(kb, journey_id)
    if direction not in ("up", "down"):
        raise EditError("Move up or down.")
    parent = kb.node(node["parent"]) if node.get("parent") else None
    siblings = list(parent["children"]) if parent else list(kb.taxonomy.get("roots", []))
    index = siblings.index(journey_id)
    target = index - 1 if direction == "up" else index + 1
    if not 0 <= target < len(siblings):
        raise EditError(f"'{node['title']}' is already {'first' if direction == 'up' else 'last'}.")
    siblings[index], siblings[target] = siblings[target], siblings[index]
    overlay = _overlay(kb)
    order = copy.deepcopy(overlay.get("child_order", {}))
    order[parent["id"] if parent else "$roots"] = siblings
    return _draft(db, kb, title=f"Move journey {direction}: {node['title']}",
                  changes=[{"file": OVERLAY, "op": "set", "path": "child_order", "value": order}],
                  description=None, actor=actor, journey_id=journey_id)


# --- Screens, elements and rules -------------------------------------------------------------

def _kb_file(kb: store.JourneyKB, key: str, default: str) -> str:
    return kb.manifest.get("files", {}).get(key, default)


def _steps_using(kb: store.JourneyKB, screen_id: str, element_id: Optional[str] = None) -> List[Dict[str, Any]]:
    out = []
    for journey in kb.journeys.values():
        for step in journey.get("steps", []):
            screens = str(step.get("screen_id") or "").split("|")
            if screen_id in screens and (element_id is None or step.get("element_id") == element_id):
                out.append({"journey_id": journey["journey_id"], "name": journey.get("name"), "step_number": step.get("step_number")})
    return out


def screen_detail(kb: store.JourneyKB, screen_id: str) -> Dict[str, Any]:
    screen = kb.screens.get(screen_id)
    if screen is None:
        raise LookupError(f"No screen '{screen_id}'.")
    return {
        "screen_id": screen_id, "name": screen.get("name"),
        "elements": [{
            "element_id": e.get("element_id"), "label": e.get("label"), "type": e.get("type"),
            "automation_ref": e.get("automation_ref"), "aliases": e.get("aliases", []),
            "used_by": _steps_using(kb, screen_id, e.get("element_id")),
        } for e in screen.get("elements", [])],
        "used_by": _steps_using(kb, screen_id),
    }


def rename_screen(db: Session, kb: store.JourneyKB, screen_id: str, name: str, *, actor: Optional[str]) -> KbChangeSet:
    screen = kb.screens.get(screen_id)
    if screen is None:
        raise LookupError(f"No screen '{screen_id}'.")
    name = _text(name, 200)
    if not name or name == screen.get("name"):
        raise EditError("Give the screen a new name.")
    return changesets.draft(
        db, app_id=kb.app_id, kb="journey", title=f"Rename screen: {screen.get('name')} -> {name}", source="manual",
        changes=[{"file": _kb_file(kb, "screens", "screens.json"), "op": "set",
                  "path": f"screens[screen_id={screen_id}].name", "value": name}],
        origin={"edit": {"screen_id": screen_id}}, actor=actor,
    )


def edit_element(db: Session, kb: store.JourneyKB, screen_id: str, element_id: str, label: str,
                 *, actor: Optional[str]) -> KbChangeSet:
    """Correct an element's label as the design names it."""
    screen = kb.screens.get(screen_id)
    element = next((e for e in (screen or {}).get("elements", []) if e.get("element_id") == element_id), None)
    if element is None:
        raise LookupError(f"No element '{element_id}' on {screen_id}.")
    label = _text(label, 200)
    if not label or label == element.get("label"):
        raise EditError("Give the element a new label.")
    return changesets.draft(
        db, app_id=kb.app_id, kb="journey", title=f"Relabel element: {element.get('label')} -> {label}", source="manual",
        changes=[{"file": _kb_file(kb, "screens", "screens.json"), "op": "set",
                  "path": f"screens[screen_id={screen_id}].elements[element_id={element_id}].label", "value": label}],
        origin={"edit": {"screen_id": screen_id, "element_id": element_id}}, actor=actor,
    )


def remove_element(db: Session, kb: store.JourneyKB, screen_id: str, element_id: str, *, actor: Optional[str]) -> KbChangeSet:
    """Delete an element; steps that pointed at it keep their screen and lose the element link."""
    screen = kb.screens.get(screen_id)
    element = next((e for e in (screen or {}).get("elements", []) if e.get("element_id") == element_id), None)
    if element is None:
        raise LookupError(f"No element '{element_id}' on {screen_id}.")
    changes: List[Dict[str, Any]] = [{
        "file": _kb_file(kb, "screens", "screens.json"), "op": "remove",
        "path": f"screens[screen_id={screen_id}].elements[element_id={element_id}]",
        "note": element.get("label"),
    }]
    files = _journey_files(kb)
    unlinked = []
    for journey in kb.journeys.values():
        steps = copy.deepcopy(journey.get("steps", []))
        touched = False
        for step in steps:
            if step.get("element_id") == element_id and screen_id in str(step.get("screen_id") or "").split("|"):
                step.pop("element_id")
                touched = True
                unlinked.append(f"{journey.get('name')} step {step.get('step_number')}")
        if touched and journey["journey_id"] in files:
            changes.append({"file": files[journey["journey_id"]], "op": "set", "path": "steps", "value": steps,
                            "note": f"unlink {element_id}"})
    return changesets.draft(
        db, app_id=kb.app_id, kb="journey", title=f"Remove element: {element.get('label') or element_id} ({screen_id})",
        source="manual", changes=changes,
        description=("Steps unlinked: " + "; ".join(unlinked)) if unlinked else None,
        origin={"edit": {"screen_id": screen_id, "element_id": element_id}}, actor=actor,
    )


def edit_rule(db: Session, kb: store.JourneyKB, rule_id: str, statement: str, message: Optional[str],
              *, actor: Optional[str]) -> KbChangeSet:
    rule = kb.rules.get(rule_id)
    if rule is None:
        raise LookupError(f"No rule '{rule_id}'.")
    statement = _text(statement, 2000)
    if not statement:
        raise EditError("A rule needs a statement.")
    message = _text(message, 500) or None
    updated = {**rule, "statement": statement}
    if message:
        updated["message"] = message
    else:
        updated.pop("message", None)
    if updated == rule:
        raise EditError("Nothing changed.")
    return changesets.draft(
        db, app_id=kb.app_id, kb="journey", title=f"Edit rule: {rule_id}", source="manual",
        changes=[{"file": _kb_file(kb, "business_rules", "business_rules.json"), "op": "set",
                  "path": f"rules[rule_id={rule_id}]", "value": updated}],
        origin={"edit": {"rule_id": rule_id}}, actor=actor,
    )


def remove_rule(db: Session, kb: store.JourneyKB, rule_id: str, *, actor: Optional[str]) -> KbChangeSet:
    """Delete a rule and every citation of it in journey files."""
    rule = kb.rules.get(rule_id)
    if rule is None:
        raise LookupError(f"No rule '{rule_id}'.")
    changes: List[Dict[str, Any]] = [{"file": _kb_file(kb, "business_rules", "business_rules.json"), "op": "remove",
                                      "path": f"rules[rule_id={rule_id}]", "note": rule.get("statement", "")[:120]}]
    files = _journey_files(kb)
    cited = []
    for journey in kb.journeys.values():
        rel = files.get(journey["journey_id"])
        if not rel:
            continue
        doc = {k: copy.deepcopy(journey.get(k)) for k in ("business_rules", "steps", "conditional_branches", "test_scenarios")}
        if doc["business_rules"] and rule_id in doc["business_rules"]:
            doc["business_rules"] = [r for r in doc["business_rules"] if r != rule_id]
        for item in (doc["steps"] or []) + (doc["conditional_branches"] or []):
            if item.get("rule") == rule_id:
                item.pop("rule")
        for scenario in doc["test_scenarios"] or []:
            if rule_id in (scenario.get("rules") or []):
                scenario["rules"] = [r for r in scenario["rules"] if r != rule_id]
        for key, value in doc.items():
            if value is not None and value != journey.get(key):
                changes.append({"file": rel, "op": "set", "path": key, "value": value, "note": f"drop {rule_id}"})
                if journey.get("name") not in cited:
                    cited.append(journey.get("name"))
    return changesets.draft(
        db, app_id=kb.app_id, kb="journey", title=f"Remove rule: {rule_id}", source="manual", changes=changes,
        description=("No longer cited by: " + ", ".join(cited)) if cited else None,
        origin={"edit": {"rule_id": rule_id}}, actor=actor,
    )


# --- A drafted change set, corrected before approval -----------------------------------------

def revise_steps(db: Session, change_set_id: int, position: int, steps: List[Dict[str, Any]],
                 *, actor: Optional[str]) -> KbChangeSet:
    """Edit the steps a draft proposes -- a journey a document created, or steps a change sets.

    The change set keeps its id, title and origin; its changes are re-checked
    exactly as when it was drafted. Branches and scenarios proposed with the
    steps are renumbered with them.
    """
    change_set = db.get(KbChangeSet, change_set_id)
    if change_set is None:
        raise LookupError("No such change set.")
    if change_set.status not in ("draft", "conflicted") or change_set.kb != "journey":
        raise EditError("Only a Journey KB draft can be edited.")
    rows = list(change_set.changes)
    target = next((c for c in rows if c.position == position), None)
    if target is None:
        raise LookupError(f"The change set has no change {position}.")
    value = copy.deepcopy((target.after or {}).get("value"))
    changes = [{"file": c.file, "op": c.op, "path": c.path, "value": copy.deepcopy((c.after or {}).get("value")),
                "note": c.note} for c in rows]
    if target.op == "create" and target.path == changesets.ROOT and isinstance(value, dict) and "steps" in value:
        result = restep(value, steps)
        value.update({k: result[k] for k in ("steps", "conditional_branches", "test_scenarios") if k in value or k == "steps"})
        changes[rows.index(target)]["value"] = value
    elif target.op == "set" and target.path == "steps" and isinstance(value, list):
        # The journey as this draft leaves it: its file, with the draft's
        # other changes to that file applied.
        siblings = {c["path"]: i for i, c in enumerate(changes) if c["file"] == target.file and c["op"] == "set"}
        current = changesets._load(change_set.app_id, "journey", target.file)
        doc = {"steps": value, **{k: changes[siblings[k]]["value"] if k in siblings else current.get(k, [])
                                  for k in ("conditional_branches", "test_scenarios")}}
        result = restep(doc, steps)
        changes[rows.index(target)]["value"] = result["steps"]
        for key in ("conditional_branches", "test_scenarios"):
            if result[key] == doc[key]:
                continue
            if key in siblings:
                changes[siblings[key]]["value"] = result[key]
            else:
                changes.append({"file": target.file, "op": "set", "path": key, "value": result[key]})
    else:
        raise EditError("This change does not propose journey steps.")
    new_rows = changesets.dry_run(change_set.app_id, "journey", changes)
    change_set.changes = new_rows
    change_set.status = "draft"
    if result["notes"]:
        change_set.description = "; ".join(filter(None, [change_set.description, *result["notes"]]))
    origin = dict(change_set.origin or {})
    origin["revised_by"] = actor
    change_set.origin = origin
    db.commit()
    db.refresh(change_set)
    return change_set
