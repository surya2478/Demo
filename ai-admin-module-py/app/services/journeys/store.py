"""
--- Journey KB: loading, matching and prompt context --------------------------

A Journey KB lives at knowledge_base/journeys/<app_id>/ next to the Automation
KB's knowledge_base/applications/<app_id>/, inside the backend's build context
for the same reason (see services/automation/knowledge_base.py): anything
outside ai-admin-module-py never reaches the image. JOURNEY_KB_PATH overrides
the location, like AUTOMATION_KB_PATH does, so a deployment can bind-mount an
updated Journey KB without a rebuild.

What this module deliberately does NOT do is hand out locators. A Journey KB
is design knowledge taken from documents; its elements carry an
`automation_ref` pointing into the Automation KB, and only diff.py follows it.
The prompt context built here therefore describes journeys in the
application's own words -- labels, branches, rules -- and nothing a compiler
could mistake for a verified selector.
"""
from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

JOURNEY_KB_ENV = "JOURNEY_KB_PATH"


def journey_kb_root() -> Path:
    """Directory holding one folder per application's Journey KB."""
    override = (os.environ.get(JOURNEY_KB_ENV) or "").strip()
    if override:
        return Path(override).expanduser()
    return Path(__file__).resolve().parents[3] / "knowledge_base" / "journeys"


@dataclass
class JourneyKB:
    app_id: str
    directory: Path
    manifest: Dict[str, Any]
    taxonomy: Dict[str, Any]
    screens: Dict[str, Dict[str, Any]]
    rules: Dict[str, Dict[str, Any]]
    roles: Dict[str, Any]
    state_models: Dict[str, Any]
    journeys: Dict[str, Dict[str, Any]] = field(default_factory=dict)

    @property
    def app_name(self) -> str:
        return self.manifest.get("app_name") or self.app_id

    @property
    def automation_app_id(self) -> str:
        return self.manifest.get("automation_app_id") or self.app_id

    def node(self, journey_id: str) -> Optional[Dict[str, Any]]:
        for node in self.taxonomy.get("nodes", []):
            if node.get("id") == journey_id:
                return node
        return None


def _read(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


# Cached per (app, newest mtime), so an edited file is picked up without a
# restart and an unchanged KB is not re-parsed on every generation.
_cache: Dict[str, Tuple[float, JourneyKB]] = {}


def _newest_mtime(directory: Path) -> float:
    return max((p.stat().st_mtime for p in directory.rglob("*.json")), default=0.0)


def list_apps() -> List[str]:
    root = journey_kb_root()
    if not root.exists():
        return []
    return sorted(p.name for p in root.iterdir() if (p / "journey_kb.json").exists())


def load(app_id: str) -> Optional[JourneyKB]:
    """The Journey KB for `app_id`, or None when there is none."""
    directory = journey_kb_root() / app_id
    manifest_path = directory / "journey_kb.json"
    if not manifest_path.exists():
        return None
    stamp = _newest_mtime(directory)
    cached = _cache.get(app_id)
    if cached and cached[0] == stamp:
        return cached[1]

    manifest = _read(manifest_path, {})
    files = manifest.get("files", {})
    screens_doc = _read(directory / files.get("screens", "screens.json"), {"screens": []})
    rules_doc = _read(directory / files.get("business_rules", "business_rules.json"), {"rules": []})
    kb = JourneyKB(
        app_id=app_id,
        directory=directory,
        manifest=manifest,
        taxonomy=_read(directory / files.get("taxonomy", "taxonomy.json"), {"nodes": []}),
        screens={s["screen_id"]: s for s in screens_doc.get("screens", [])},
        rules={r["rule_id"]: r for r in rules_doc.get("rules", [])},
        roles=_read(directory / files.get("roles", "roles.json"), {}),
        state_models=_read(directory / files.get("state_models", "state_models.json"), {}),
    )
    journeys_dir = directory / files.get("journeys_dir", "journeys")
    for path in sorted(journeys_dir.glob("*.json")) if journeys_dir.exists() else []:
        try:
            journey = _read(path, {})
            kb.journeys[journey["journey_id"]] = journey
        except Exception:  # noqa: BLE001 - one bad file must not hide the rest
            logger.warning("Skipping unreadable journey file %s", path, exc_info=True)
    _cache[app_id] = (stamp, kb)
    return kb


# --- Matching -------------------------------------------------------------------

def _keyword_hits(text: str, keywords: List[str]) -> List[str]:
    lowered = (text or "").lower()
    return [
        k for k in keywords
        if k and re.search(r"\b" + re.escape(k.lower().strip()) + r"\b", lowered)
    ]


@dataclass
class JourneyMatch:
    kb: JourneyKB
    journey: Dict[str, Any]
    score: int
    hits: List[str]


def match_journey(text: str, app_id: Optional[str] = None) -> Optional[JourneyMatch]:
    """The authored journey a requirement is about, or None.

    Scored like the Automation KB's match_flow_blueprint (four points per word
    of each keyword found as a whole phrase), with the evidence rule
    testcases.describe_grounding applies: no keyword hit, no match. A shared
    journey only wins outright -- on a tie the journey that owns the steps is
    the better anchor, and the shared one arrives anyway as a prerequisite or
    next step.
    """
    best: Optional[JourneyMatch] = None
    for candidate_app in ([app_id] if app_id else list_apps()):
        kb = load(candidate_app)
        if kb is None:
            continue
        for journey in kb.journeys.values():
            hits = _keyword_hits(text, journey.get("match_keywords", []))
            if not hits:
                continue
            score = sum(4 * len(h.split()) for h in hits)
            better = best is None or score > best.score or (
                score == best.score and best.journey.get("shared") and not journey.get("shared")
            )
            if better:
                best = JourneyMatch(kb, journey, score, hits)
    return best


def journey_chain(kb: JourneyKB, journey: Dict[str, Any], text: str = "") -> List[Dict[str, Any]]:
    """The journey preceded by everything it needs, in execution order.

    A prerequisite that is a group of variants (SIGNIN: OTP / Password / UAE
    PASS) is satisfied by one authored variant: the one the text names, else
    the first authored one.
    """
    chain: List[Dict[str, Any]] = []
    seen: set = set()

    def resolve(journey_id: str) -> Optional[Dict[str, Any]]:
        if journey_id in kb.journeys:
            return kb.journeys[journey_id]
        node = kb.node(journey_id) or {}
        variants = [kb.journeys[c] for c in node.get("children", []) if c in kb.journeys and not kb.journeys[c].get("shared")]
        if not variants:
            return None
        named = [v for v in variants if _keyword_hits(text, v.get("match_keywords", []))]
        return (named or variants)[0]

    def visit(j: Dict[str, Any]) -> None:
        if j["journey_id"] in seen:
            return
        seen.add(j["journey_id"])
        for prerequisite in j.get("prerequisite_journeys", []):
            resolved = resolve(prerequisite)
            if resolved is not None:
                visit(resolved)
        chain.append(j)

    visit(journey)
    return chain


def journey_scope(kb: JourneyKB, journey: Dict[str, Any], text: str = "") -> List[Dict[str, Any]]:
    """The chain plus every authored journey that can follow it.

    A test case that starts at sign-in usually carries on -- choosing an
    organization, landing on the dashboard -- so resolving its steps against
    the matched journey alone would call half of them unknown.
    """
    scope = journey_chain(kb, journey, text)
    queue = list(scope)
    while queue:
        current = queue.pop(0)
        for next_id in current.get("next_journeys", []):
            nxt = kb.journeys.get(next_id)
            if nxt and nxt not in scope:
                scope.append(nxt)
                queue.append(nxt)
    return scope


# --- Prompt context ---------------------------------------------------------------

def _element_line(element: Dict[str, Any]) -> str:
    parts = [f"'{element['label']}' ({element['type']}"]
    if element.get("mandatory"):
        parts.append(", mandatory")
    if element.get("format"):
        parts.append(f", format: {element['format']}")
    if element.get("default_state"):
        parts.append(f", {element['default_state']}")
    parts.append(")")
    if element.get("empty_state"):
        parts.append(f" empty state: '{element['empty_state']}'")
    if element.get("basis") == "inferred":
        parts.append(" [inferred]")
    return "".join(parts)


def build_context_prompt(match: JourneyMatch, text: str = "") -> str:
    kb, journey = match.kb, match.journey
    chain = journey_chain(kb, journey, text)
    lines = [
        "",
        "=" * 80,
        "JOURNEY KNOWLEDGE BASE (BUSINESS DESIGN -- labels, steps, branches, rules)",
        "=" * 80,
        f"Application: {kb.app_name}",
        f"Journey: {' > '.join(journey.get('journey_path', [journey['name']]))} [{journey['journey_id']}]",
        "Source: solution-design documents. This is what the business designed, not a "
        "verified description of the running application; a later step compares the "
        "test cases with the crawled application.",
        "",
        "EXECUTION ORDER (prerequisite journeys first):",
    ]
    for position, j in enumerate(chain, 1):
        lines.append(f"  {position}. {j['name']} [{j['journey_id']}]")
    following = [kb.journeys[n]["name"] for n in journey.get("next_journeys", []) if n in kb.journeys]
    if following:
        lines.append(f"  then, depending on the branch taken: {', '.join(following)}")

    screen_ids: List[str] = []
    for j in chain:
        lines += ["", f"STEPS -- {j['name']}:"]
        for step in j.get("steps", []):
            tag = " (only on the error path)" if step.get("branch") == "negative_only" else ""
            lines.append(f"  {step['step_number']}. {step['action']}{tag} -> expect: {step['expected_result']}")
        for sid in j.get("screens", []):
            if sid not in screen_ids:
                screen_ids.append(sid)

    lines += ["", "SCREENS AND EXACT LABELS (quote verbatim):"]
    for sid in screen_ids:
        screen = kb.screens.get(sid)
        if not screen:
            continue
        route = f" route {screen['route']}" if screen.get("route") else ""
        lines.append(f"  {screen['name']}{route}:")
        for element in screen.get("elements", []):
            lines.append(f"    - {_element_line(element)}")

    rule_ids: List[str] = []
    for j in chain:
        rule_ids += [r for r in j.get("business_rules", []) if r not in rule_ids]
    if rule_ids:
        lines += ["", "BUSINESS RULES (derive negative/boundary cases from these):"]
        for rid in rule_ids:
            rule = kb.rules.get(rid)
            if not rule:
                continue
            message = f" Message: '{rule['message']}'." if rule.get("message") else ""
            basis = " [inferred -- confirm before asserting]" if rule.get("basis") == "inferred" else ""
            lines.append(f"  {rid}: {rule['statement']}{message}{basis}")

    for j in chain:
        if j.get("conditional_branches"):
            lines += ["", f"CONDITIONAL BRANCHES -- {j['name']}:"]
            for b in j["conditional_branches"]:
                lines.append(f"  {b['branch_id']}: if {b['condition']} -> {b['outcome']} ({b.get('rule', '')})")

    scenarios = [s for j in chain[-1:] for s in j.get("test_scenarios", [])]
    if scenarios:
        lines += ["", "SCENARIOS THE JOURNEY EXPECTS TO BE COVERED:"]
        for s in scenarios:
            lines.append(f"  {s['scenario_id']} [{s['type']}] {s['title']}")

    questions = [q for j in chain for q in j.get("open_questions", [])]
    if questions:
        lines += ["", "OPEN QUESTIONS (state in Preconditions, never assume an answer):"]
        lines += [f"  - {q}" for q in questions]

    directives = kb.manifest.get("generation_directives", [])
    if directives:
        lines += ["", "INSTRUCTIONS FOR TEST CASE GENERATION:"]
        lines += [f"  {i}. {d}" for i, d in enumerate(directives, 1)]
    lines += ["=" * 80, ""]
    return "\n".join(lines)


def describe(text: str, app_id: Optional[str] = None) -> Dict[str, Any]:
    """What the Journey KB knows about a requirement, in the shape
    testcases.describe_grounding reports for the Automation KB."""
    info: Dict[str, Any] = {
        "grounded": False, "reason": "no_journey_matched", "app_id": None,
        "journey_id": None, "journey_name": None, "chain": [], "matched_keywords": [],
        "context": "", "context_chars": 0,
    }
    try:
        if not journey_kb_root().exists():
            info["reason"] = "kb_missing"
            return info
        match = match_journey(text, app_id)
        if not match:
            return info
        context = build_context_prompt(match, text)
        info.update(
            grounded=True, reason="matched", app_id=match.kb.app_id,
            journey_id=match.journey["journey_id"], journey_name=match.journey["name"],
            chain=[j["journey_id"] for j in journey_chain(match.kb, match.journey, text)],
            matched_keywords=match.hits, context=context, context_chars=len(context),
        )
    except Exception:  # noqa: BLE001 - the KB must never break generation
        logger.warning("Journey KB lookup failed", exc_info=True)
        info["reason"] = "error"
    return info
