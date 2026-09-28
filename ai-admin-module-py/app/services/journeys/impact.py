"""
--- What a Knowledge Base change touches --------------------------------------------

Reads a list of changes -- a draft being reviewed, or a published change set --
and answers the questions a reviewer and the Heal step ask:

  * which design elements, screens, rules and journeys it changes;
  * which other journeys depend on those (they share the element, screen or
    rule, or list the journey as a prerequisite or next journey);
  * which test cases are affected: those whose AI Checks KB diff matched one
    of those journeys or has it in its chain, and which of their steps point
    at a changed element;
  * which Automation KB selectors and flow blueprints hang off them, and which
    journeys a journey-guided crawl should walk to confirm the change.

Deterministic, read-only, and computed from the change addresses themselves,
so it works the same for an extraction, a Reconcile decision, a crawl's links
or a revert.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from sqlalchemy.orm import Session

from . import store

_SCREEN = re.compile(r"^screens\[screen_id=(?P<screen>[^\]]+)\](?:\.elements\[element_id=(?P<element>[^\]]+)\](?:\.(?P<field>[A-Za-z_]+))?|\.(?P<sfield>[A-Za-z_]+))?")
_RULE = re.compile(r"^rules\[rule_id=(?P<rule>[^\]]+)\]")
_NODE = re.compile(r'^nodes\["(?P<journey>[^"]+)"\]')
# Label-bearing fields: changing one of these can make a test case's quoted
# wording, or a crawled selector built from the label, stale.
LABEL_FIELDS = {"label", "aliases", "accepted_labels", "locator_hint", None}


def _journey_files(kb: store.JourneyKB) -> Dict[str, str]:
    journeys_dir = kb.manifest.get("files", {}).get("journeys_dir", "journeys")
    out: Dict[str, str] = {}
    for path in sorted((kb.directory / journeys_dir).glob("*.json")) if (kb.directory / journeys_dir).exists() else []:
        try:
            out[f"{journeys_dir}/{path.name}"] = json.loads(path.read_text(encoding="utf-8")).get("journey_id")
        except Exception:  # noqa: BLE001
            continue
    return out


def targets(kb: store.JourneyKB, changes: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """What the changes address directly."""
    files = _journey_files(kb)
    elements: Dict[Tuple[str, str], Set[str]] = {}
    screens: Set[str] = set()
    rules: Set[str] = set()
    journeys: Dict[str, Dict[str, Any]] = {}  # id -> journey doc as it will be (for new ones)
    for change in changes:
        rel, path = change.get("file") or "", change.get("path") or ""
        after = (change.get("after") or {}).get("value") if "after" in change else change.get("value")
        if rel == "screens.json":
            m = _SCREEN.match(path)
            if not m:
                continue
            if m.group("element"):
                elements.setdefault((m.group("screen"), m.group("element")), set()).add(m.group("field") or "*")
            else:
                screens.add(m.group("screen"))
                # A whole new screen brings its elements with it.
                if isinstance(after, dict):
                    for el in after.get("elements", []):
                        elements.setdefault((m.group("screen"), el.get("element_id")), set()).add("*")
        elif rel == "business_rules.json":
            m = _RULE.match(path)
            if m:
                rules.add(m.group("rule"))
        elif rel == "sources/taxonomy_overlay.json":
            m = _NODE.match(path)
            if m:
                journeys.setdefault(m.group("journey"), {})
        elif rel.startswith(kb.manifest.get("files", {}).get("journeys_dir", "journeys") + "/"):
            jid = files.get(rel) or (after.get("journey_id") if isinstance(after, dict) and path == "$" else None)
            if jid:
                journeys[jid] = after if path == "$" and isinstance(after, dict) else journeys.get(jid, {})
    return {"elements": elements, "screens": screens, "rules": rules, "journeys": journeys}


def _all_journeys(kb: store.JourneyKB, extra: Dict[str, Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    out = dict(kb.journeys)
    for jid, doc in extra.items():
        if doc and jid not in out:
            out[jid] = doc
    return out


def analyse(kb: store.JourneyKB, changes: List[Dict[str, Any]], db: Optional[Session] = None,
            automation_profile: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    t = targets(kb, changes)
    journeys = _all_journeys(kb, t["journeys"])
    why: Dict[str, List[str]] = {}

    def hit(jid: str, reason: str) -> None:
        # A new journey is touched by being new; listing each element it uses adds nothing.
        if jid in journeys and reason not in why.setdefault(jid, []) and "new journey" not in why[jid]:
            why[jid].append(reason)

    for jid in t["journeys"]:
        hit(jid, "its steps change" if jid in kb.journeys else "new journey")
    for (sid, eid), fields in t["elements"].items():
        for jid, journey in journeys.items():
            if any(s.get("screen_id") == sid and s.get("element_id") == eid for s in journey.get("steps", [])):
                hit(jid, f"uses {sid} · {eid}")
    for sid in t["screens"]:
        for jid, journey in journeys.items():
            if sid in journey.get("screens", []):
                hit(jid, f"passes through {sid}")
    for rid in t["rules"]:
        for jid, journey in journeys.items():
            if rid in journey.get("business_rules", []) or any(s.get("rule") == rid for s in journey.get("steps", [])):
                hit(jid, f"cites {rid}")
    # Journeys that run a changed journey first (prerequisite) or right after.
    direct = set(why)
    for jid, journey in journeys.items():
        for other in direct:
            if other != jid and (other in journey.get("prerequisite_journeys", []) or other in journey.get("next_journeys", [])):
                hit(jid, f"runs with {other}")

    changed_elements = []
    for (sid, eid), fields in sorted(t["elements"].items()):
        element = next((e for e in kb.screens.get(sid, {}).get("elements", []) if e.get("element_id") == eid), None)
        changed_elements.append({
            "screen_id": sid, "element_id": eid, "label": (element or {}).get("label"),
            "fields": sorted(fields), "new": element is None,
            "automation_ref": (element or {}).get("automation_ref"),
            "label_changed": bool(fields & {"label", "aliases", "accepted_labels", "*"}) and element is not None,
        })

    selectors = sorted({e["automation_ref"] for e in changed_elements if e["automation_ref"] and e["label_changed"]})
    flows = sorted({f for jid in why for f in journeys[jid].get("automation_flow_ids", [])})
    out = {
        "journeys": [{"journey_id": jid, "name": journeys[jid].get("name") or jid, "reasons": reasons,
                      "authored": jid in kb.journeys or bool(t["journeys"].get(jid))}
                     for jid, reasons in sorted(why.items())],
        "elements": changed_elements,
        "screens": sorted(t["screens"]),
        "rules": sorted(t["rules"]),
        "automation": {"selectors_to_reverify": selectors, "flows": flows},
        # Journeys a crawl can walk to confirm the change: authored ones that
        # pass through a changed element or screen, or whose steps changed.
        "crawl_journeys": sorted(jid for jid, reasons in why.items()
                                 if (jid in kb.journeys or t["journeys"].get(jid))
                                 and any(not r.startswith("runs with") and not r.startswith("cites") for r in reasons)),
        "test_cases": affected_cases(db, set(why), set(t["elements"])) if db is not None else [],
    }
    out["counts"] = {"journeys": len(out["journeys"]), "elements": len(changed_elements), "rules": len(out["rules"]),
                     "test_cases": len(out["test_cases"]), "selectors": len(selectors)}
    return out


def affected_cases(db: Session, journeys: Set[str], elements: Set[Tuple[str, str]]) -> List[Dict[str, Any]]:
    """Test cases whose KB diff matched an affected journey, or has one in its chain."""
    from ...models.automation import AutomationTestCase

    if not journeys:
        return []
    out = []
    for case in db.query(AutomationTestCase).filter(AutomationTestCase.journey_diff.isnot(None)).all():
        report = case.journey_diff or {}
        chain = set(report.get("chain") or []) | ({report["journey_id"]} if report.get("journey_id") else set())
        if not chain & journeys:
            continue
        touched = [row.get("step_number") for row in report.get("steps", [])
                   if (row.get("screen_id"), row.get("element_id")) in elements]
        out.append({
            "id": case.id, "display_id": case.display_id, "title": (case.description or case.objective or "")[:160],
            "journey_id": report.get("journey_id"), "approval_status": case.approval_status,
            "summary": report.get("summary") or {}, "steps_touched": touched,
        })
    return out
