"""
--- Knowledge Base page: what each stage shows ---------------------------------

The Knowledge Base page puts the Journey KB (design) and the Automation KB
(crawled) side by side, in the order the work happens: sources, journeys,
application model, test data, crawl, Automation KB, reconcile, change & heal.
This module is the read side of the stages that are the Journey KB's own;
crawl and Automation KB reuse the Discovery screens and their API.

Everything here is read-only and computed on request from the files and the
test-data vault, so the page can never show a number the loaders would not
arrive at. Test data is reported as present or missing per field, never as a
value: the vault's values do not leave services/automation/test_data.py.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from . import diff, store

_PDF_REF = re.compile(r"^(?P<doc>.+?\.(?:pdf|docx?))(?:\s+p(?P<pages>[\d\-–, ]+))?", re.IGNORECASE)
LINKED = {diff.MATCH, diff.LABEL_DRIFT}


def _profile(kb: store.JourneyKB) -> Dict[str, Any]:
    from ..automation import knowledge_base as automation_kb

    return automation_kb.load_app_profile(kb.automation_app_id) or {}


def _flows(kb: store.JourneyKB) -> List[Dict[str, Any]]:
    from ..automation import knowledge_base as automation_kb

    return automation_kb.list_flows(kb.automation_app_id)


def _leaf_journeys(kb: store.JourneyKB) -> List[Dict[str, Any]]:
    return [n for n in kb.taxonomy.get("nodes", []) if n.get("kind") != "chapter" and not n.get("children")]


def load_or_raise(app_id: str) -> store.JourneyKB:
    kb = store.load(app_id)
    if kb is None:
        raise LookupError(f"No Journey KB for application '{app_id}'.")
    return kb


# --- Sources ------------------------------------------------------------------------

def sources(kb: store.JourneyKB) -> List[Dict[str, Any]]:
    """The design documents behind this KB, and what each one feeds."""
    docs: Dict[str, Dict[str, Any]] = {}
    for entry in kb.manifest.get("sources", []):
        match = _PDF_REF.match(entry)
        name = (match.group("doc") if match else entry).strip()
        docs[name] = {
            "document": name,
            "type": "master_list" if "(master" in entry.lower() else "screen_flow",
            "journeys": [],
            "statuses": set(),
        }
    for node in kb.taxonomy.get("nodes", []):
        for ref in node.get("sources", []):
            match = _PDF_REF.match(ref)
            if not match:
                continue
            name = match.group("doc").strip()
            doc = docs.setdefault(name, {"document": name, "type": "screen_flow", "journeys": [], "statuses": set()})
            if node.get("kind") == "chapter":
                continue
            if doc["type"] == "master_list":
                continue
            if node["id"] not in [j["id"] for j in doc["journeys"]]:
                doc["journeys"].append({"id": node["id"], "title": node["title"], "status": node["status"]})
                doc["statuses"].add(node["status"])
    total_leaves = len(_leaf_journeys(kb))
    out = []
    for doc in docs.values():
        statuses = doc.pop("statuses")
        if doc["type"] == "master_list":
            doc["extraction"] = "transcribed"
            doc["feeds"] = f"Taxonomy · {total_leaves} journeys"
        elif "detailed" in statuses and statuses <= {"detailed", "partial"}:
            doc["extraction"] = "approved"
        elif "detailed" in statuses:
            doc["extraction"] = "partly_approved"
        else:
            doc["extraction"] = "not_extracted"
        out.append(doc)
    return out


# --- Overview and stage statuses ------------------------------------------------------

def overview(kb: store.JourneyKB) -> Dict[str, Any]:
    profile = _profile(kb)
    leaves = _leaf_journeys(kb)
    counts: Dict[str, int] = {}
    for node in leaves:
        counts[node["status"]] = counts.get(node["status"], 0) + 1
    chapters = [
        {
            "id": n["id"], "title": n["title"], "status": n["status"],
            "journeys": sum(1 for leaf in leaves if leaf["chapter"] == n["chapter"]),
        }
        for n in kb.taxonomy.get("nodes", []) if n.get("kind") == "chapter"
    ]
    elements = [e for s in kb.screens.values() for e in s.get("elements", [])]
    reconcile = diff.reconcile_elements(kb, profile)
    linked = sum(1 for r in reconcile["rows"] if r["element_id"] and r["status"] in LINKED)
    docs = sources(kb)
    open_questions = sum(len(j.get("open_questions", [])) for j in kb.journeys.values())
    return {
        "app_id": kb.app_id,
        "app_name": kb.app_name,
        "automation_app_id": kb.automation_app_id,
        "base_url": profile.get("base_url"),
        "journeys": {"total": len(leaves), "by_status": counts, "authored": len(kb.journeys), "open_questions": open_questions},
        "chapters": chapters,
        "screens": {"catalogued": len(kb.screens), "elements": len(elements), "linked": linked},
        "sources": {"documents": len(docs)},
        "automation": {"flows": len(_flows(kb)), "selectors": len(diff._selector_paths(profile))},
        "reconcile": reconcile["summary"],
    }


# --- Journey detail ---------------------------------------------------------------------

def journey_detail(kb: store.JourneyKB, journey_id: str) -> Dict[str, Any]:
    node = kb.node(journey_id)
    if node is None:
        raise LookupError(f"No journey '{journey_id}'.")
    journey = kb.journeys.get(journey_id)
    result: Dict[str, Any] = {"node": node, "journey": None}
    if journey is None:
        return result

    profile = _profile(kb)
    chain = store.journey_chain(kb, journey)
    rows = {(r["screen_id"], r["element_id"]): r for r in diff.reconcile_elements(kb, profile)["rows"] if r["element_id"]}
    steps = []
    for step in journey.get("steps", []):
        screen_id = str(step.get("screen_id") or "").split("|")[0]
        row = rows.get((screen_id, step.get("element_id")))
        if row:
            link = {"status": row["status"], "automation_target": row["automation_target"], "app_labels": row["app_labels"]}
        elif step.get("element_id"):
            link = {"status": diff.NOT_CRAWLED, "automation_target": None, "app_labels": []}
        else:
            screen = kb.screens.get(screen_id) or {}
            route = diff._resolve_ref(profile, screen["route_ref"]) if screen.get("route_ref") and step.get("step_number") == 1 else None
            link = {"status": diff.MATCH if route else diff.NO_ELEMENT, "automation_target": route, "app_labels": []}
        steps.append({**step, "link": link, "screen_name": (kb.screens.get(screen_id) or {}).get("name")})

    # Who else is affected when this journey changes: journeys that run after
    # it (they list it, or its variant group, as a prerequisite), journeys that
    # hand over to it, and Automation-KB-only journeys that sign in through it.
    me = {journey_id, node.get("parent")}
    used_by = []
    for other in kb.journeys.values():
        if other["journey_id"] == journey_id:
            continue
        if me & set(other.get("prerequisite_journeys", [])):
            used_by.append({"journey_id": other["journey_id"], "name": other["name"], "relation": "runs after this"})
        elif journey_id in other.get("next_journeys", []):
            used_by.append({"journey_id": other["journey_id"], "name": other["name"], "relation": "hands over to this"})
    for other_node in kb.taxonomy.get("nodes", []):
        if other_node.get("status") == "automation_only" and me & set(other_node.get("prerequisite_journeys", [])):
            used_by.append({"journey_id": other_node["id"], "name": other_node["title"], "relation": "runs after this"})

    result["journey"] = {
        **{k: v for k, v in journey.items() if k != "steps"},
        "steps": steps,
        "chain": [{"journey_id": j["journey_id"], "name": j["name"]} for j in chain],
        "next": [{"journey_id": n, "name": (kb.journeys.get(n) or {}).get("name") or n} for n in journey.get("next_journeys", [])],
        "rules": [kb.rules[r] for r in journey.get("business_rules", []) if r in kb.rules],
        "used_by": used_by,
    }
    return result


# --- Application model ---------------------------------------------------------------------

def model(kb: store.JourneyKB) -> Dict[str, Any]:
    profile = _profile(kb)
    rows = diff.reconcile_elements(kb, profile)["rows"]
    screens = []
    used_routes = set()
    for screen in kb.screens.values():
        mine = [r for r in rows if r["screen_id"] == screen["screen_id"]]
        route_value = diff._resolve_ref(profile, screen["route_ref"]) if screen.get("route_ref") else None
        if screen.get("route_ref"):
            used_routes.add(screen["route_ref"])
        design_only = not any(r["status"] in LINKED for r in mine) and not route_value
        screens.append({
            "screen_id": screen["screen_id"],
            "name": screen.get("name"),
            "route": screen.get("route"),
            "route_ref": screen.get("route_ref"),
            "route_in_app": route_value,
            "elements": len(mine),
            "linked": sum(1 for r in mine if r["status"] in LINKED),
            "origin": "design" if design_only else "both",
            "transitions": screen.get("transitions", []),
        })
    endpoints = profile.get("endpoints") or {}
    app_only = [
        {"route_ref": f"endpoints.{key}", "route": value}
        for key, value in endpoints.items()
        if isinstance(value, str) and f"endpoints.{key}" not in used_routes
    ]
    return {"screens": screens, "app_only_routes": app_only}


# --- Test data coverage ---------------------------------------------------------------------

def _profiles(kb: store.JourneyKB) -> Dict[str, Dict[str, Any]]:
    raw = (kb.roles or {}).get("test_data_profiles") or {}
    return {k: v for k, v in raw.items() if not k.startswith("_") and isinstance(v, dict)}


def test_data_coverage(kb: store.JourneyKB, db) -> Dict[str, Any]:
    """Which data profiles have values in which environment -- never the values."""
    from ..automation import test_data as vault

    profiles = _profiles(kb)
    used_by: Dict[str, List[str]] = {pid: list(p.get("extra_users", [])) for pid, p in profiles.items()}
    for journey in kb.journeys.values():
        for scenario in journey.get("test_scenarios", []):
            pid = scenario.get("test_data")
            if pid in used_by:
                used_by[pid].append(f"{journey['name']} · {scenario['scenario_id']}")

    app = vault.find_app(db, kb_app_id=kb.automation_app_id) if db is not None else None
    entries = list(app.entries) if app else []
    environments = vault.ordered_environments(e.environment for e in entries)

    rows = []
    totals = {"ready": 0, "missing": 0, "external": 0}
    for pid, spec in profiles.items():
        kind = spec.get("kind", "vault")
        variables = [f["variable"] for f in spec.get("fields", []) if f.get("variable")]
        cells = {}
        for env in environments:
            if kind == "external":
                cells[env] = {"status": "external", "missing": []}
            elif kind != "vault" or not variables:
                cells[env] = {"status": "missing", "missing": []}
            else:
                resolved = vault.resolve(entries, env, variables)
                cells[env] = {
                    "status": "missing" if resolved["missing"] else "ready",
                    "missing": resolved["missing"],
                    # Which stored key answered each variable -- a name, never a value.
                    "matched_keys": resolved["matches"],
                }
            totals[cells[env]["status"]] += 1
        rows.append({
            "profile_id": pid,
            "name": spec.get("name") or pid,
            "description": spec.get("description"),
            "kind": kind,
            "fields": spec.get("fields", []),
            "state": spec.get("state"),
            "used_by": used_by[pid],
            "cells": cells,
        })
    return {
        "vault_app": {"id": app.id, "name": app.name} if app else None,
        "environments": environments,
        "profiles": rows,
        "totals": totals,
    }
