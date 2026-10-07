"""
--- Journey Map: one journey, its flow blueprint and its selectors, side by side --------

A journey's steps used to live in four places that drifted apart: the Journey
KB journey, the Automation KB flow blueprint, the selectors the journey's
elements point at, and the step edits inside pending change sets. The map
makes one of them the source:

  * the JOURNEY owns the steps -- their wording, order, additions, deletions;
  * the AUTOMATION KB owns how each step is done -- the selector (or address)
    of the step's element, which a crawl or QA confirms;
  * the FLOW BLUEPRINT is generated from the two, and regenerated whenever the
    journey's steps change, in the same review. Nobody edits it by hand.

build_map lines the three up for one journey and says, per step, whether its
selector is known and confirmed by the last walk, and whether the flow
blueprint says the same thing; steps only the flow has are shown where they
fall, to be added to the journey or let go. propose turns an edit on the map
into a pair of change sets -- the journey's steps and the regenerated flow --
that are approved together.
"""
from __future__ import annotations

import copy
import json
import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from ...models.kb_changes import KbChangeSet, KbCrawlRun
from . import changesets, diff, editing, journey_crawl, store

# The Automation KB source a regenerated flow is drafted under. It may only
# touch flow blueprints (changesets.draft enforces it): the selectors in a
# generated flow are copied from the Automation KB, never invented here.
SOURCE = "journey-map"


class MapError(ValueError):
    """The edit cannot be turned into change sets; the message says why."""


# --- Reading ---------------------------------------------------------------------------------

def _profile(kb: store.JourneyKB) -> Dict[str, Any]:
    return store.automation_profile(kb)


def _flows(kb: store.JourneyKB) -> Dict[str, Dict[str, Any]]:
    from ..automation import knowledge_base as automation_kb

    return {f["flow_id"]: f for f in automation_kb.list_flows(kb.automation_app_id) if f.get("flow_id")}


def _is_route(value: Optional[str]) -> bool:
    return bool(value) and value.startswith("/") and not value.startswith("//")


def _norm(value: Optional[str]) -> str:
    return re.sub(r"\s+", "", str(value or "")).lower()


def _step_target(kb: store.JourneyKB, profile: Dict[str, Any], step: Dict[str, Any]) -> Dict[str, Any]:
    """What the Automation KB says carries this step out: a selector, an address, or nothing yet."""
    options = [s.strip() for s in str(step.get("screen_id") or "").split("|") if s.strip()]
    screen = kb.screens.get(options[0]) if len(options) == 1 else None
    element = None
    if screen and step.get("element_id"):
        element = next((e for e in screen.get("elements", []) if e.get("element_id") == step["element_id"]), None)
    out: Dict[str, Any] = {
        "screen_ids": options,
        "screen_names": [(kb.screens.get(s) or {}).get("name") or s for s in options],
        "element_id": step.get("element_id"),
        "element_label": (element or {}).get("label"),
        "element_type": (element or {}).get("type"),
        "automation_ref": (element or {}).get("automation_ref"),
        "target": None, "target_kind": "none",
    }
    if step.get("element_id") and element is None:
        out["target_kind"] = "unknown_element"
        return out
    # A recorded step: done the way the person did it, with the selector checked then.
    recorded = step.get("recorded") or {}
    value = (recorded.get("target") or recorded.get("route") or "").strip()
    if element is None and value:
        out.update(target=value, target_kind="route" if _is_route(value) else "selector", recorded=True)
        return out
    if element is not None:
        ref = element.get("automation_ref")
        value = diff._resolve_ref(profile, ref) if ref else None
        if isinstance(value, str) and value.strip():
            out.update(target=value.strip(), target_kind="route" if _is_route(value.strip()) else "selector")
        else:
            out["target_kind"] = "broken_ref" if ref else "no_selector"
        return out
    # A screen-level step: "Navigate to the login page" is done by its address.
    if screen is not None and journey_crawl._NAVIGATE.search(step.get("action") or ""):
        route = journey_crawl._screen_route(kb, screen, profile)
        if route:
            out.update(target=route, target_kind="route")
    return out


def _similar(a: str, b: str) -> float:
    wa, wb = journey_crawl._words(a), journey_crawl._words(b)
    return len(wa & wb) / len(wa | wb) if wa and wb else 0.0


def _pair_score(step: Dict[str, Any], target: Dict[str, Any], flow_step: Dict[str, Any]) -> Optional[float]:
    ft = flow_step.get("target") or ""
    if target.get("target") and ft:
        if _norm(target["target"]) == _norm(ft):
            return 3.0
        if target["target_kind"] == "route" and _is_route(ft) and journey_crawl._path_of(ft) == journey_crawl._path_of(target["target"]):
            return 3.0
    text = _similar(step.get("action") or "", flow_step.get("action") or "")
    return 1.0 + text if text >= 0.34 else None


def align(steps: List[Tuple[Dict[str, Any], Dict[str, Any]]], flow_steps: List[Dict[str, Any]]) -> List[Tuple[Optional[int], Optional[int]]]:
    """Journey steps against flow steps, order kept: [(journey index | None, flow index | None)].

    A pair is the same step when they name the same selector or address, or
    say much the same thing; the best-scoring order-preserving matching wins
    (weighted LCS), and everything left over is on one side only.
    """
    n, m = len(steps), len(flow_steps)
    best = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            score = _pair_score(steps[i][0], steps[i][1], flow_steps[j])
            options = [best[i + 1][j], best[i][j + 1]]
            if score is not None:
                options.append(best[i + 1][j + 1] + score)
            best[i][j] = max(options)
    out: List[Tuple[Optional[int], Optional[int]]] = []
    i = j = 0
    while i < n and j < m:
        score = _pair_score(steps[i][0], steps[i][1], flow_steps[j])
        if score is not None and abs(best[i][j] - (best[i + 1][j + 1] + score)) < 1e-9:
            out.append((i, j)); i += 1; j += 1
        elif best[i][j] == best[i + 1][j]:
            out.append((i, None)); i += 1
        else:
            out.append((None, j)); j += 1
    out.extend((k, None) for k in range(i, n))
    out.extend((None, k) for k in range(j, m))
    return out


def _last_walk(db: Optional[Session], kb: store.JourneyKB, journey_id: str) -> Optional[Dict[str, Any]]:
    if db is None:
        return None
    crawl = (db.query(KbCrawlRun)
             .filter(KbCrawlRun.app_id == kb.app_id, KbCrawlRun.journey_id == journey_id, KbCrawlRun.status == "completed")
             .order_by(KbCrawlRun.id.desc()).first())
    if crawl is None or not crawl.result:
        return None
    items = (crawl.plan or {}).get("items", [])
    steps: Dict[Tuple[int, str], Dict[str, Any]] = {}
    for step in crawl.result.get("steps", []):
        item = items[step["order"] - 1] if 0 < step.get("order", 0) <= len(items) else {}
        if item.get("journey_id") == journey_id:
            # Keyed by the step's words as well: a walk from before an edit
            # says nothing about a step that has since been renumbered or reworded.
            steps[(step.get("step_number"), _norm(item.get("text")))] = step
    elements = {(r["screen_id"], r["element_id"]): r for r in crawl.result.get("rows", [])}
    return {"id": crawl.id, "environment": crawl.environment, "profile_id": crawl.profile_id,
            "when": crawl.finished_at.isoformat() if crawl.finished_at else None,
            "derailed": crawl.result.get("derailed"), "steps": steps, "elements": elements}


def _capture(target: Dict[str, Any], walk_step: Optional[Dict[str, Any]], element_row: Optional[Dict[str, Any]]) -> str:
    """confirmed | to_confirm | failed | captured | needs_capture | broken_ref | unknown_element | screen."""
    kind = target["target_kind"]
    if kind in ("unknown_element", "broken_ref"):
        return kind
    outcome = (element_row or {}).get("outcome")
    if kind == "no_selector":
        return "captured" if outcome == "new" and (element_row or {}).get("selector") else "needs_capture"
    if kind == "none":
        return "screen"
    if outcome in ("kb_failed",) or (walk_step or {}).get("status") in ("not_found",):
        return "failed"
    if outcome in ("confirmed", "healed") or (walk_step or {}).get("status") in ("done", "auto"):
        return "confirmed"
    return "to_confirm"


def generate_steps(kb: store.JourneyKB, profile: Dict[str, Any], journey: Dict[str, Any],
                   flow: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The flow blueprint's canonical steps, generated from the journey.

    The success path only: a step for an error branch (negative_only) is a
    test scenario's business, not the flow's. Each step's target is the
    Automation KB selector of its element; a step whose element has none yet
    keeps the target the flow already had for it (a QA-recorded XPath), so
    regenerating never throws away what QA captured.
    """
    steps = [s for s in journey.get("steps", []) if s.get("branch") != "negative_only"]
    targets = [_step_target(kb, profile, s) for s in steps]
    old = list((flow or {}).get("canonical_steps", []))
    matched = {i: j for i, j in align(list(zip(steps, targets)), old) if i is not None and j is not None}
    out = []
    for i, (step, target) in enumerate(zip(steps, targets)):
        previous = old[matched[i]] if i in matched else {}
        value = target.get("target") or previous.get("target") or ""
        extras = {k: v for k, v in previous.items() if k not in ("step_number", "action", "target", "expected_result", "journey_step")}
        out.append({"step_number": len(out) + 1, "action": step.get("action") or "", "target": value,
                    "expected_result": step.get("expected_result") or previous.get("expected_result") or "",
                    **extras, "journey_step": step.get("step_number")})
    return out


def build_map(kb: store.JourneyKB, journey_id: str, *, db: Optional[Session] = None) -> Dict[str, Any]:
    journey = kb.journeys.get(journey_id)
    if journey is None:
        raise LookupError(f"'{journey_id}' has no authored journey file.")
    profile = _profile(kb)
    flows = _flows(kb)
    flow_ids = [f for f in journey.get("automation_flow_ids") or [] if f]
    flow_id = next((f for f in flow_ids if f in flows), None)
    flow = flows.get(flow_id) if flow_id else None
    flow_steps = list((flow or {}).get("canonical_steps", []))
    steps = journey.get("steps", [])
    targets = [_step_target(kb, profile, s) for s in steps]
    walk = _last_walk(db, kb, journey_id)

    # The flow is the success path, so error-branch steps are not expected in it.
    in_flow = [(i, s) for i, s in enumerate(steps) if s.get("branch") != "negative_only"]
    pairs = align([(s, targets[i]) for i, s in in_flow], flow_steps)
    flow_of = {in_flow[a][0]: b for a, b in pairs if a is not None and b is not None}
    flow_only = [b for a, b in pairs if a is None and b is not None]

    rows: List[Dict[str, Any]] = []
    generated = generate_steps(kb, profile, journey, flow)
    for i, step in enumerate(steps):
        target = targets[i]
        walk_step = (walk or {}).get("steps", {}).get((step.get("step_number"), _norm(step.get("action"))))
        element_row = None
        if walk and target["screen_ids"] and step.get("element_id"):
            element_row = walk["elements"].get((target["screen_ids"][0], step["element_id"]))
        f = flow_steps[flow_of[i]] if i in flow_of else None
        flow_diff: List[str] = []
        if step.get("branch") == "negative_only":
            flow_state = "error_path"
        elif f is None:
            flow_state = "missing"
        else:
            gen = next((g for g in generated if g["journey_step"] == step.get("step_number")), {})
            # What differs: the words (the flow says "CONTINUE", the journey
            # "Receive OTP"), the selector or address, or both.
            flow_diff = [part for part, a, b in (("wording", f.get("action"), gen.get("action")),
                                                ("selector", f.get("target"), gen.get("target"))) if _norm(a) != _norm(b)]
            flow_state = "differs" if flow_diff else "same"
        rows.append({
            "kind": "step", "step_number": step.get("step_number"), "action": step.get("action"),
            "expected_result": step.get("expected_result"), "branch": step.get("branch"), "rule": step.get("rule"),
            **target,
            "capture": _capture(target, walk_step, element_row),
            "walk_status": (walk_step or {}).get("status"), "walk_reason": (walk_step or {}).get("reason"),
            "walk_selector": (element_row or {}).get("selector") if (element_row or {}).get("outcome") in ("new", "healed") else None,
            "flow_step": ({"step_number": f.get("step_number"), "action": f.get("action"), "target": f.get("target")} if f else None),
            "flow_state": flow_state, "flow_diff": flow_diff,
        })
    # Steps only the flow has, placed after the journey step before them.
    for b in flow_only:
        f = flow_steps[b]
        before = max((i for i, j in flow_of.items() if j < b), default=-1)
        position = next((k for k, r in enumerate(rows) if r["kind"] == "step" and r["step_number"] == steps[before]["step_number"]), -1) if before >= 0 else -1
        while position + 1 < len(rows) and rows[position + 1]["kind"] == "flow_only":
            position += 1
        rows.insert(position + 1, {"kind": "flow_only", "flow_step": {"step_number": f.get("step_number"), "action": f.get("action"),
                                   "target": f.get("target"), "expected_result": f.get("expected_result")},
                                   "flow_state": "only_flow", "capture": None})

    step_rows = [r for r in rows if r["kind"] == "step"]
    summary = {
        "steps": len(step_rows),
        "mapped": sum(1 for r in step_rows if r["flow_state"] in ("same", "error_path") and r["capture"] in ("confirmed", "to_confirm", "screen")),
        "confirmed": sum(1 for r in step_rows if r["capture"] == "confirmed"),
        "needs_capture": sum(1 for r in step_rows if r["capture"] in ("needs_capture", "captured", "broken_ref", "unknown_element")),
        "failed": sum(1 for r in step_rows if r["capture"] == "failed"),
        "flow_differs": sum(1 for r in step_rows if r["flow_state"] in ("differs", "missing")),
        "only_in_flow": len(flow_only),
    }
    flow_current = bool(flow) and [{k: v for k, v in s.items() if k != "journey_step"} for s in generated] == \
        [{k: v for k, v in s.items() if k != "journey_step"} for s in flow_steps]
    # Verified: the flow is the journey, and a walk confirmed every success-path step.
    success = [r for r in step_rows if r["flow_state"] != "error_path"]
    summary["verified"] = bool(success) and flow_current and summary["only_in_flow"] == 0 \
        and all(r["flow_state"] == "same" and r["capture"] == "confirmed" for r in success)
    return {
        "journey_id": journey_id, "journey_name": journey.get("name") or journey_id,
        "flow": ({"flow_id": flow_id, "flow_name": flow.get("flow_name"), "steps": len(flow_steps),
                  "generated_from": flow.get("generated_from"), "up_to_date": flow_current} if flow else None),
        "linked_flow_ids": flow_ids,
        "suggested_flows": [] if flow else suggest_flows(journey, flows),
        "walk": ({k: walk[k] for k in ("id", "environment", "profile_id", "when", "derailed")} if walk else None),
        "rows": rows, "summary": summary,
        "screens": [{"screen_id": sid, "name": s.get("name") or sid,
                     "elements": [{"element_id": e.get("element_id"), "label": e.get("label"), "type": e.get("type")}
                                  for e in s.get("elements", []) if e.get("element_id")]}
                    for sid, s in kb.screens.items()],
    }


def suggest_flows(journey: Dict[str, Any], flows: Dict[str, Dict[str, Any]], limit: int = 3) -> List[Dict[str, Any]]:
    """Flow blueprints that look like this journey, best first: by name, keywords and step wording."""
    want = journey_crawl._words(" ".join([journey.get("name") or "", " ".join(journey.get("match_keywords") or [])]))
    steps_text = " ".join(s.get("action") or "" for s in journey.get("steps", []))
    scored = []
    for flow_id, f in flows.items():
        have = journey_crawl._words(" ".join([f.get("flow_name") or "", " ".join(f.get("target_match_keywords") or [])]))
        name = len(want & have) / len(want | have) if want and have else 0.0
        body = _similar(steps_text, " ".join(s.get("action") or "" for s in f.get("canonical_steps", [])))
        score = round(name * 0.6 + body * 0.4, 3)
        if score > 0.12:
            scored.append({"flow_id": flow_id, "flow_name": f.get("flow_name"), "score": score,
                           "linked_elsewhere": False})
    scored.sort(key=lambda x: -x["score"])
    return scored[:limit]


def overview(kb: store.JourneyKB, *, db: Optional[Session] = None) -> Dict[str, Any]:
    """Every authored journey with its flow and summary, for the picker."""
    flows = _flows(kb)
    linked = {f for j in kb.journeys.values() for f in (j.get("automation_flow_ids") or [])}
    out = []
    for journey_id, journey in kb.journeys.items():
        try:
            m = build_map(kb, journey_id, db=db)
            out.append({"journey_id": journey_id, "journey_name": m["journey_name"], "flow": m["flow"], "summary": m["summary"]})
        except Exception as exc:  # noqa: BLE001 - one broken journey must not hide the others
            out.append({"journey_id": journey_id, "journey_name": journey.get("name") or journey_id, "flow": None,
                        "summary": None, "error": str(exc)})
    return {"journeys": out,
            "flows": [{"flow_id": fid, "flow_name": f.get("flow_name"), "linked": fid in linked} for fid, f in sorted(flows.items())]}


# --- Changing -------------------------------------------------------------------------------

def _flow_doc(kb: store.JourneyKB, journey: Dict[str, Any], flow_id: str, steps: List[Dict[str, Any]],
              profile: Dict[str, Any]) -> Dict[str, Any]:
    """A new flow blueprint for a journey that has none."""
    first = next((s for s in journey.get("steps", []) if s.get("screen_id") and "|" not in s["screen_id"]), None)
    entry = journey_crawl._screen_route(kb, kb.screens[first["screen_id"]], profile) if first and first["screen_id"] in kb.screens else None
    return {
        "flow_id": flow_id,
        "flow_name": journey.get("name") or journey["journey_id"],
        "category": (journey.get("journey_path") or ["Journeys"])[0].title(),
        "subcategory": journey.get("name"),
        "target_match_keywords": journey.get("match_keywords", []),
        "catalog_entrypoint": entry or "",
        "automation_boundary": journey.get("automation_boundary") or {},
        "graph_edges": [],
        "canonical_steps": steps,
        "generated_from": {"journey_id": journey["journey_id"]},
    }


def new_flow_id(journey_id: str, flows: Dict[str, Any]) -> str:
    base = "flow_" + re.sub(r"[^a-z0-9]+", "_", journey_id.lower()).strip("_")[-60:]
    candidate, n = base, 2
    while candidate in flows:
        candidate, n = f"{base}_{n}", n + 1
    return candidate


def propose(db: Session, kb: store.JourneyKB, journey_id: str, *, steps: Optional[List[Dict[str, Any]]] = None,
            link_flow: Optional[str] = None, actor: Optional[str]) -> Dict[str, Optional[KbChangeSet]]:
    """Draft the journey's edited steps and the flow regenerated from them, as one pair.

    `steps` is the edited list, as the Journey KB steps editor sends it (None:
    the steps stay as they are and only the flow is regenerated). `link_flow`
    links the journey to an existing flow, or "new" creates one; only for a
    journey that has no flow yet.
    """
    from .crawl_runs import _flow_file

    journey = kb.journeys.get(journey_id)
    if journey is None:
        raise MapError(f"'{journey_id}' has no authored journey file.")
    profile = _profile(kb)
    flows = _flows(kb)
    rel = changesets._journey_file(kb, journey_id)
    journey_changes: List[Dict[str, Any]] = []
    notes: List[str] = []
    edited = copy.deepcopy(journey)
    if steps is not None:
        result = editing.restep(journey, steps)
        if result["steps"] != journey.get("steps", []):
            journey_changes.append({"file": rel, "op": "set", "path": "steps", "value": result["steps"],
                                    "note": f"{len(result['steps'])} steps" + (f"; deleted {', '.join(map(str, result['deleted']))}" if result["deleted"] else "")})
        for field in ("conditional_branches", "test_scenarios"):
            if result[field] != journey.get(field, []):
                journey_changes.append({"file": rel, "op": "set", "path": field, "value": result[field]})
        notes.extend(result["notes"])
        edited.update(steps=result["steps"], conditional_branches=result["conditional_branches"], test_scenarios=result["test_scenarios"])

    flow_id = next((f for f in journey.get("automation_flow_ids") or [] if f in flows), None)
    create = False
    if flow_id is None:
        if not link_flow:
            if not journey_changes:
                raise MapError("This journey has no flow blueprint: link an existing one or create one.")
        elif link_flow == "new":
            flow_id, create = new_flow_id(journey_id, flows), True
        elif link_flow in flows:
            flow_id = link_flow
        else:
            raise MapError(f"There is no flow blueprint '{link_flow}'.")
        if flow_id:
            journey_changes.append({"file": rel, "op": "set", "path": "automation_flow_ids",
                                    "value": [*(journey.get("automation_flow_ids") or []), flow_id],
                                    "note": f"linked to the flow blueprint {flow_id}"})

    automation_changes: List[Dict[str, Any]] = []
    if flow_id:
        flow = None if create else flows[flow_id]
        generated = generate_steps(kb, profile, edited, flow)
        stamp = {"journey_id": journey_id, "generated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z"}
        if create:
            automation_changes.append({"file": f"flows/{flow_id}.json", "op": "create", "path": changesets.ROOT,
                                       "value": _flow_doc(kb, edited, flow_id, generated, profile),
                                       "note": f"{len(generated)} steps, generated from the journey"})
        else:
            fl = _flow_file(kb.automation_app_id, flow_id)
            if generated != flow.get("canonical_steps"):
                automation_changes.append({"file": fl, "op": "set", "path": "canonical_steps", "value": generated,
                                           "note": f"{len(generated)} steps, generated from the journey (was {len(flow.get('canonical_steps', []))})"})
            if automation_changes or flow.get("generated_from", {}).get("journey_id") != journey_id:
                automation_changes.append({"file": fl, "op": "set", "path": "generated_from", "value": stamp})

    if not journey_changes and not automation_changes:
        raise MapError("Nothing to change: the journey is as it was and its flow blueprint already matches it.")

    name = journey.get("name") or journey_id
    automation_set = journey_set = None
    origin = {"map": {"journey_id": journey_id, "flow_id": flow_id}}
    if automation_changes:
        automation_set = changesets.draft(
            db, app_id=kb.automation_app_id, kb="automation", source=SOURCE, actor=actor, origin=origin,
            title=f"{'New flow' if create else 'Regenerate flow'} {flow_id} from {name}",
            description="Generated from the journey's steps; every target is the Automation KB's selector for the step's "
                        "element, or the one the flow already had.",
            changes=automation_changes)
    if journey_changes:
        journey_set = changesets.draft(
            db, app_id=kb.app_id, kb="journey", source="manual", actor=actor,
            origin={"map": {**origin["map"], "pair": automation_set.id if automation_set else None}, "edit": {"journey_id": journey_id}},
            title=f"Journey Map: {name}" + (f" ({len(edited['steps'])} steps)" if steps is not None else ""),
            description="; ".join(notes) or (f"Approving this also publishes change set #{automation_set.id}, the flow "
                                             f"regenerated from these steps." if automation_set else None),
            changes=journey_changes)
        if automation_set is not None:
            automation_set.origin = {"map": {**origin["map"], "pair": journey_set.id}}
            db.commit()
    return {"journey": journey_set, "automation": automation_set}


def refresh_pair(db: Session, kb: store.JourneyKB, journey_set: KbChangeSet) -> Optional[KbChangeSet]:
    """After a map draft's steps are revised in review, rebuild its flow half from the revised steps."""
    meta = (journey_set.origin or {}).get("map") or {}
    partner = db.get(KbChangeSet, meta.get("pair") or 0)
    if partner is None or partner.status not in ("draft", "conflicted") or not meta.get("journey_id"):
        return None
    journey = copy.deepcopy(kb.journeys.get(meta["journey_id"]) or {})
    rel = changesets._journey_file(kb, meta["journey_id"])
    for change in journey_set.changes:
        if change.file == rel and change.op == "set" and change.path in ("steps", "conditional_branches", "test_scenarios", "automation_flow_ids"):
            journey[change.path] = copy.deepcopy((change.after or {}).get("value"))
    flow = _flows(kb).get(meta.get("flow_id") or "")
    generated = generate_steps(kb, _profile(kb), journey, flow)
    changes = []
    for change in partner.changes:
        value = copy.deepcopy((change.after or {}).get("value"))
        if change.op == "create" and isinstance(value, dict):
            value["canonical_steps"] = generated
        elif change.path == "canonical_steps":
            value = generated
        changes.append({"file": change.file, "op": change.op, "path": change.path, "value": value, "note": change.note})
    partner.changes = changesets.dry_run(partner.app_id, "automation", changes)
    partner.status = "draft"
    db.commit()
    return partner
