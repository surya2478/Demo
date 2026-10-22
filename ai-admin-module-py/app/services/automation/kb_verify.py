"""Automation Module: a background crawl that keeps the Automation KB true.

The KB is the map. Every component in `components.json`, with every value it
allows, is a check the crawler can perform: reach the page the component needs
(with the KB's own navigation components), run the component's steps, and see
whether its selectors still find exactly one visible element and its
assertions still hold. Each check comes back

  verified   -- it ran as the KB says;
  ambiguous  -- it ran, but a selector matched more than one visible element;
  failed     -- a step did not run or did not hold, with the step and error.

From those results the crawl proposes KB corrections: the option values each
product really offers (`values_by_product`) and the options a product page
really opens with (`default_variant`).

The crawler also sweeps every page it visits (the journey crawl's sweepPage,
plus the labelled filter options sweepPage cannot address), opens what is
collapsed there and sweeps again, and reports the objects the KB does not know.
An agent step then maps those objects to the KB's open gaps -- requirements a
composition found no component for. Where it sees evidence but cannot yet say
how to check the feature, it may ask to click one control (never buy, pay,
remove, submit or sign in) and see what appears; then it may propose a new
component built ONLY from selectors the crawl saw.

Every proposal is validated and becomes a draft change set (source "crawl")
for a person to approve on the Knowledge Base page; nothing is written to the
KB here. Runs with installed Chrome, paced (1.5 s), a fresh session per page,
and the firewall retry the generated scripts use.
"""
from __future__ import annotations

import itertools
import json
import logging
import re
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel, Field

from . import knowledge_base as kb
from . import kb_compose
from . import workspace as ws
from .llm import complete_json, wrap_user_content

logger = logging.getLogger(__name__)

RUNNER = Path(__file__).with_name("kb_verify_runner.js")
NAV = {
    "landing": [("open_accessories_page", {})],
    "listing": [("open_tablets_listing", {})],
    "cart": [("open_cart", {})],
}
# Never clicked by the agent's probe: anything that buys, pays, removes, submits or signs in.
# Ids a framework generates per render ("mat-mdc-checkbox-36-input", "cdk-overlay-3",
# "ng-tns-c12-4"): unique when seen, different on the next page load.
VOLATILE = re.compile(r"@(id|for|aria-labelledby|aria-describedby|aria-controls)='[^']*?(?<![A-Za-z])(mat|cdk|ng|mdc)-[a-z-]*\d+[^']*'"
                      r"|@id='[^']*\d{3,}[^']*'")
UNSAFE = re.compile(r"\b(buy|pay|checkout|check out|add to cart|remove|delete|submit|sign ?in|log ?in|"
                    r"register|order|confirm|subscribe|call|chat)\b", re.I)


def _sweep_js() -> str:
    """uniqueXPath + groupXPath + sweepPage, cut from the journey crawl's spec."""
    from ..journeys import journey_crawl

    spec = journey_crawl._SPEC
    start = spec.index("function uniqueXPath(el)")
    end = spec.index("return out;\n}\n", spec.index("function sweepPage()")) + len("return out;\n}\n")
    return spec[start:end]


# --- The plan -------------------------------------------------------------------------

def _reach(screen: str) -> list[tuple[str, dict]]:
    if screen in NAV:
        return NAV[screen]
    kind, _, product = screen.partition(":")
    if kind == "product":
        return [("open_product_page", {"product": product})]
    if kind == "product_from_listing":
        return [("open_tablets_listing", {}), ("open_product_from_listing", {"listed_product": product})]
    raise ValueError(screen)


def _build(lib, refs: list[tuple[str, dict]]) -> Optional[list[dict]]:
    case = kb_compose.ComposedCase(
        title="verify", steps=[kb_compose.ComposedStep(component=c, params=p) for c, p in refs]
    )
    built = kb_compose.build_case(lib, "verify", case)
    return None if [e for e in built.errors if "checks nothing" not in e] else built.steps


def _base_plan(base_url: str, browser: str, pace_ms: int) -> dict:
    return {"base_url": base_url, "browser": browser, "pace_ms": pace_ms, "max_expand": 15,
            "sweep_js": _sweep_js(), "probes": []}


def build_plan(lib: kb_compose.Library, base_url: str, browser: str = "chrome", pace_ms: int = 1500) -> dict:
    products = list((lib.params.get("product") or {}).get("values") or [])
    listed = list((lib.params.get("listed_product") or {}).get("values") or [])
    probes: dict[str, dict] = {}
    skipped: list[str] = []

    def screens_for(comp: dict) -> list[str]:
        req = comp["requires"]
        if req in ("landing", "listing", "cart"):
            return [req]
        if req == "product":
            return [f"product:{p}" for p in products]
        if req == "product_from_listing":
            return [f"product_from_listing:{p}" for p in listed]
        return []

    for comp in lib.components.values():
        if comp["requires"] in ("none", "landing_ar"):
            continue
        names = comp.get("params") or []
        pools = []
        for name in names:
            spec = lib.params.get(name) or {}
            pools.append(spec.get("examples") or (["11-inch"] if spec.get("type") == "text" else spec.get("values") or []))
        for screen in screens_for(comp):
            for combo in itertools.product(*pools) if pools else [()]:
                params = dict(zip(names, combo))
                reach = _reach(screen)
                reach_steps = _build(lib, reach)
                steps = _build(lib, reach + [(comp["id"], params)])
                check_id = f"{comp['id']}({', '.join(combo)})@{screen}" if combo else f"{comp['id']}@{screen}"
                if reach_steps is None or steps is None:
                    skipped.append(check_id)
                    continue
                probe = probes.setdefault(screen, {"id": screen, "screen": screen, "reach": reach_steps,
                                                   "checks": [], "sweep": True})
                probe["checks"].append({"id": check_id, "component": comp["id"], "params": params,
                                        "steps": steps[len(reach_steps):]})
    plan = _base_plan(base_url, browser, pace_ms)
    plan["probes"] = list(probes.values())
    plan["skipped"] = skipped
    return plan


def run_plan(plan: dict, workdir: Path, timeout_s: int = 5400) -> dict:
    workdir = Path(workdir).resolve()
    workdir.mkdir(parents=True, exist_ok=True)
    ws.write_playwright_config(workdir, base_url=plan["base_url"], browser=plan["browser"])
    (workdir / "plan.json").write_text(json.dumps(plan), encoding="utf-8")
    runner = workdir / "kb_verify_runner.js"
    runner.write_text(RUNNER.read_text(encoding="utf-8"), encoding="utf-8")
    with (workdir / "runner.log").open("a", encoding="utf-8") as log:
        proc = subprocess.run(["node", str(runner)], cwd=str(workdir), stdout=log, stderr=subprocess.STDOUT,
                              timeout=timeout_s, shell=False)
    result_path = workdir / "result.json"
    if not result_path.exists():
        raise RuntimeError(f"The crawl produced no result (exit {proc.returncode}); see {workdir / 'runner.log'}.")
    return json.loads(result_path.read_text(encoding="utf-8"))


# --- What the result means ---------------------------------------------------------------

def _known_targets(lib: kb_compose.Library, plan: dict) -> tuple[set[str], set[str]]:
    targets: set[str] = set()
    for probe in plan["probes"]:
        for s in probe["reach"]:
            targets.add(s["target"])
        for check in probe["checks"]:
            for s in check["steps"]:
                targets.add(s["target"])
    profile = kb.load_exact_profile(lib.app_key) or {}
    for entries in (profile.get("selectors") or {}).values():
        if isinstance(entries, dict):
            targets.update(str(v) for v in entries.values())
    labels = {l.strip().lower() for t in targets for l in kb.selector_labels(t) if l.strip()}
    return targets, labels


def analyse(lib: kb_compose.Library, plan: dict, result: dict) -> dict:
    targets, labels = _known_targets(lib, plan)
    checks, screens, selections = [], {}, {}
    for probe in result.get("probes") or []:
        for c in probe.get("checks") or []:
            checks.append({**c, "screen": probe["screen"]})
        if not probe.get("reach_ok"):
            checks.append({"id": f"reach@{probe['screen']}", "screen": probe["screen"], "status": "failed",
                           "failed_step": "reach the page", "error": probe.get("reach_error")})
        if probe.get("selection"):
            selections[probe["screen"]] = probe["selection"]
        objects = {}
        for o in (probe.get("objects") or []) + (probe.get("explored") or []):
            objects.setdefault(o["selector"], o)
        if objects:
            new = [o for o in objects.values()
                   if not o.get("site_wide", o.get("chrome")) and o["selector"] not in targets
                   and (o.get("name") or "").strip().lower() not in labels]
            screens[probe["screen"]] = {"objects": len(objects), "all": list(objects.values()), "new": new}
    for c in checks:
        if c["status"] != "failed":
            continue
        label = re.findall(r"'([^']+)'", c.get("failed_step") or "")
        pool = (screens.get(c["screen"]) or {}).get("new") or []
        if label:
            c["candidates"] = [o["selector"] for o in pool if (o.get("name") or "").strip() == label[-1]][:3]
    counts = {s: sum(1 for c in checks if c["status"] == s) for s in ("verified", "ambiguous", "failed")}
    return {"counts": counts, "checks": checks, "screens": screens, "selections": selections,
            "skipped": plan.get("skipped") or []}


def kb_corrections(lib: kb_compose.Library, analysis: dict) -> list[dict]:
    """Change-set changes the crawl's evidence supports, each with a note saying why."""
    changes: list[dict] = []
    # 1. The option values each product really offers.
    per: dict[tuple[str, str], dict[str, list[str]]] = {}
    for c in analysis["checks"]:
        kind, _, product = c["screen"].partition(":")
        comp = lib.components.get(c.get("component") or "")
        if kind != "product" or not comp or not comp.get("params"):
            continue
        name = comp["params"][0]
        if (lib.params.get(name) or {}).get("type") in ("product", "text"):
            continue
        bucket = per.setdefault((name, product), {"ok": [], "bad": []})
        value = (c.get("params") or {}).get(name)
        bucket["ok" if c["status"] in ("verified", "ambiguous") else "bad"].append(value)
    by_param: dict[str, dict[str, list[str]]] = {}
    for (name, product), b in per.items():
        if b["bad"]:
            by_param.setdefault(name, {})[product] = sorted(set(b["ok"]), key=b["ok"].index)
    for name, mapping in by_param.items():
        current = dict((lib.params.get(name) or {}).get("values_by_product") or {})
        current.update(mapping)
        changes.append({
            "file": kb_compose.COMPONENTS_FILE, "op": "set", "path": f"params.{name}.values_by_product",
            "value": current,
            "note": "Values that failed on the live page: " + "; ".join(
                f"{p}: {', '.join(v for v in per[(name, p)]['bad'])}" for p in mapping),
        })
    # 2. The options a product page really opens with.
    for screen, sel in analysis["selections"].items():
        kind, _, product = screen.partition(":")
        record = lib.products.get(product)
        flow_file = _flow_file_with_product(lib.app_key, product)
        if kind != "product" or not record or not flow_file:
            continue
        live = [p["text"] for p in sel.get("pills") or [] if p.get("active")]
        if sel.get("colour"):
            live.insert(0, sel["colour"])
        kb_parts = [p.strip() for p in str(record.get("default_variant") or "").split("/") if p.strip()]
        if live and set(live) != set(kb_parts):
            key = json.dumps(product)  # quoted path segment: product names contain '"' and ','
            changes.append({
                "file": flow_file, "op": "set", "path": f"known_products[{key}].default_variant",
                "value": " / ".join(live),
                "note": f"The page opens with {' / '.join(live)}; the KB said {' / '.join(kb_parts) or 'nothing'}.",
            })
    return changes


def _flow_file_with_product(app_key: str, product: str) -> Optional[str]:
    """The flow file whose known_products holds `product`."""
    for path in sorted((kb.get_kb_root() / app_key / "flows").glob("*.json")):
        if product in (json.loads(path.read_text(encoding="utf-8")).get("known_products") or {}):
            return f"flows/{path.name}"
    return None


# --- The agent: map unknown objects to the KB's gaps -------------------------------------------

class ProposedComponent(BaseModel):
    id: str
    description: str
    requires: str
    leaves: str = "any"
    params: dict[str, list[str]] = Field(default_factory=dict)
    steps: list[list[str]] = Field(default_factory=list)


class GapFinding(BaseModel):
    requirement: str
    evidence: str  # found | not_found
    objects: list[str] = Field(default_factory=list)
    explanation: str = ""
    page: Optional[str] = None
    try_click: Optional[str] = None
    component: Optional[ProposedComponent] = None


class GapMapping(BaseModel):
    findings: list[GapFinding]


AGENT_PROMPT = """You map objects a crawler saw on a web application to requirements its Automation \
Knowledge Base cannot test yet. You get the open gaps and, per page, objects (role, name, group, selector -- \
each selector matched exactly one element). Objects marked KNOWN are already in the KB; you may use them \
in a component's steps (typically to assert a page still shows its content).

For each gap return {requirement, evidence: "found" | "not_found", objects: [selectors that show it],
explanation: one sentence, page: the page key the objects are on, try_click: null or one selector,
component: null or a proposed component}.
- "found" only when the objects clearly are that feature. Otherwise "not_found"; never guess.
- If you found the feature but cannot tell how to check its result without seeing what a control does,
  set try_click to that control's selector (it must not buy, pay, remove, submit or sign in) and leave
  component null; you will be shown what appeared after the click.
- A component proposal reuses the KB's format:
  {id: snake_case, description, requires: landing | listing | product | cart,
   leaves: "any" or a page, params: {name: [allowed values seen on the page]},
   steps: [[action text, action_type (click | assert | fill), target selector, expected result]]}
  Never use a selector built on a generated id (mat-..-36, cdk-.., ng-..): it changes on every page load;
  prefer selectors on visible text or stable attributes.
  Every target must be a selector from the lists, copied exactly; where one value of a parameter appears
  inside a selector you may write {param} in its place, but only when every allowed value then gives a
  selector from the lists. Include at least one assert step. Do not propose navigation.
Return JSON only: {"findings": [...]}"""


def _proposal_errors(comp: ProposedComponent, seen: set[str], lib: kb_compose.Library) -> list[str]:
    errors = []
    if not re.fullmatch(r"[a-z][a-z0-9_]{2,40}", comp.id):
        errors.append("id is not snake_case")
    if comp.id in lib.components:
        errors.append(f"'{comp.id}' already exists")
    if comp.requires not in ("landing", "listing", "product", "cart"):
        errors.append(f"requires '{comp.requires}' is not a KB page")
    if not comp.steps or not any(len(s) == 4 and s[1] == "assert" for s in comp.steps):
        errors.append("no assert step")
    for s in comp.steps:
        if len(s) != 4 or s[1] not in ("click", "assert", "fill"):
            errors.append(f"malformed step {s}")
            continue
        names = re.findall(r"\{([a-z_]+)\}", s[2])
        renders = [s[2]]
        for name in names:
            values = comp.params.get(name) or []
            if not values:
                errors.append(f"{{{name}}} has no values")
            renders = [r.replace("{" + name + "}", v) for r in renders for v in values]
        if VOLATILE.search(s[2]):
            errors.append(f"generated id, not stable across page loads: {s[2][:120]}")
        missing = [r for r in renders if r not in seen]
        if missing:
            errors.append(f"target not seen on the page: {missing[0][:120]}")
        if s[1] == "click" and UNSAFE.search(s[0]):
            errors.append(f"unsafe action: {s[0]}")
    return errors


def _object_lines(analysis: dict, kb_targets: set[str]) -> tuple[list[str], set[str]]:
    lines, seen = [], set(kb_targets)
    for screen, page in analysis["screens"].items():
        lines.append(f"PAGE {screen}:")
        new_ids = {o["selector"] for o in page["new"]}
        for o in page["all"]:
            if o.get("site_wide", o.get("chrome")):
                continue
            seen.add(o["selector"])
            tag = "" if o["selector"] in new_ids else " KNOWN"
            group = f" group={json.dumps(o['group'])}" if o.get("group") else ""
            lines.append(f"- role={o.get('role')} name={json.dumps(o.get('name'), ensure_ascii=False)}{group} "
                         f"selector={o['selector']}{tag}")
    return lines, seen


def _validate(findings: list[GapFinding], seen: set[str], lib) -> list[dict]:
    out = []
    for f in findings:
        item = f.model_dump()
        item["objects"] = [o for o in f.objects if o in seen]
        if f.component is not None:
            errors = _proposal_errors(f.component, seen, lib)
            item["component_errors"] = errors
            item["component_valid"] = not errors
        out.append(item)
    return out


def map_gaps(lib: kb_compose.Library, plan: dict, analysis: dict, gaps: list[dict], workdir: Path) -> list[dict]:
    """Agent round 1 over the swept objects; one probe-click round where it asks; agent round 2 for those."""
    if not gaps:
        return []
    kb_targets, _ = _known_targets(lib, plan)
    lines, seen = _object_lines(analysis, kb_targets)
    gap_text = "\n".join(f"- {g['id']}: {g.get('summary', '')} -- {g.get('reason', '')}" for g in gaps)
    first = complete_json(
        system_prompt=AGENT_PROMPT,
        user_input=f"OPEN GAPS:\n{wrap_user_content(gap_text)}\n\nOBJECTS:\n" + "\n".join(lines),
        model_cls=GapMapping, max_tokens=8000, temperature=0.1,
    )
    findings = first.findings
    asks = [f for f in findings if f.try_click and f.try_click in seen and f.page in analysis["screens"]
            and not UNSAFE.search(next((o.get("name") or "" for o in analysis["screens"][f.page]["all"]
                                        if o["selector"] == f.try_click), ""))][:3]
    if asks:
        probe_plan = _base_plan(plan["base_url"], plan["browser"], plan["pace_ms"])
        by_page: dict[str, list[str]] = {}
        for f in asks:
            by_page.setdefault(f.page, []).append(f.try_click)
        for page, clicks in by_page.items():
            probe_plan["probes"].append({"id": f"probe@{page}", "screen": page, "checks": [], "sweep": False,
                                         "reach": _build(lib, _reach(page)) or [], "clicks": clicks})
        clicked = run_plan(probe_plan, Path(workdir) / "probe")
        after_lines, appeared = [], {}
        for p in clicked.get("probes") or []:
            for pc in p.get("probe_clicks") or []:
                appeared[pc["target"]] = pc
                for o in pc.get("appeared") or []:
                    seen.add(o["selector"])
                after_lines.append(
                    f"AFTER CLICKING {pc['target']} on {p['screen']}: "
                    + (f"error {pc['error']}" if pc.get("error") else
                       f"url {'changed to ' + pc['url_changed'] if pc.get('url_changed') else 'unchanged'}; appeared:\n"
                       + "\n".join(f"- role={o.get('role')} name={json.dumps(o.get('name'), ensure_ascii=False)} "
                                   f"selector={o['selector']}" for o in (pc.get("appeared") or [])[:60])))
        second = complete_json(
            system_prompt=AGENT_PROMPT,
            user_input=(f"OPEN GAPS:\n{wrap_user_content(gap_text)}\n\nOBJECTS:\n" + "\n".join(lines)
                        + "\n\n" + "\n\n".join(after_lines)
                        + "\n\nReturn findings ONLY for: " + ", ".join(f.requirement for f in asks)
                        + ". The click on the try_click control is a step you may now use; do not ask to click again."),
            model_cls=GapMapping, max_tokens=8000, temperature=0.1,
        )
        replaced = {f.requirement for f in second.findings}
        findings = [f for f in findings if f.requirement not in replaced] + list(second.findings)
        for f in findings:
            if f.try_click in appeared:
                f.explanation = (f.explanation + " (probe-clicked)").strip()
    return _validate(findings, seen, lib)


def draft_change_sets(db, app_key: str, findings: list[dict], corrections: list[dict], *,
                      actor: str, run_ref: str) -> list[int]:
    """One draft change set (source crawl) for the KB corrections, one per valid proposed component."""
    from ..journeys import changesets

    data = json.loads((kb.get_kb_root() / app_key / kb_compose.COMPONENTS_FILE).read_text(encoding="utf-8"))
    ids = []
    if corrections:
        cs = changesets.draft(
            db, app_id=app_key, kb="automation", source="crawl", actor=actor,
            title=f"KB corrections from verification crawl {run_ref}",
            description="Option values and default selections as the live pages show them.",
            changes=corrections, origin={"kind": "kb_verify", "run": run_ref},
        )
        ids.append(cs.id)
    for f in findings:
        comp = f.get("component")
        if not comp or not f.get("component_valid"):
            continue
        value = {
            "id": comp["id"], "description": comp["description"], "requires": comp["requires"],
            "leaves": comp.get("leaves") or "any", "params": list(comp["params"].keys()),
            "steps": comp["steps"],
            "_provenance": f"Proposed by the KB verification crawl {run_ref} for {f['requirement']}; "
                           "every target was seen on the page and matched one element.",
        }
        changes = [{"file": kb_compose.COMPONENTS_FILE, "op": "set", "path": f"components[id={comp['id']}]",
                    "value": value, "note": f.get("explanation")}]
        for name, values in comp["params"].items():
            if name not in (data.get("params") or {}):
                changes.append({"file": kb_compose.COMPONENTS_FILE, "op": "set", "path": f"params.{name}",
                                "value": {"values": values}, "note": "values seen on the page"})
        cs = changesets.draft(
            db, app_id=app_key, kb="automation", source="crawl", actor=actor,
            title=f"New component {comp['id']} for {f['requirement']}",
            description=f.get("explanation"), changes=changes,
            origin={"kind": "kb_verify", "run": run_ref, "requirement": f["requirement"]},
        )
        ids.append(cs.id)
    return ids


def run(app_key: str, *, base_url: str, workdir: Path, gaps: Optional[list[dict]] = None,
        browser: str = "chrome", reuse: bool = False) -> dict:
    """Crawl, analyse, map gaps. `reuse` re-analyses a finished crawl in `workdir` without crawling again."""
    lib = kb_compose.load_library(app_key)
    started = datetime.utcnow().isoformat(timespec="seconds")
    if reuse:
        plan = json.loads((Path(workdir) / "plan.json").read_text(encoding="utf-8"))
        result = json.loads((Path(workdir) / "result.json").read_text(encoding="utf-8"))
        started = result.get("started_at", started)
    else:
        plan = build_plan(lib, base_url, browser=ws.resolve_browser(browser)[0])
        result = run_plan(plan, workdir)
    analysis = analyse(lib, plan, result)
    findings = map_gaps(lib, plan, analysis, gaps or [], workdir)
    corrections = kb_corrections(lib, analysis)
    screens = {k: {"objects": v["objects"], "new": v["new"]} for k, v in analysis["screens"].items()}
    return {"app_key": app_key, "started_at": started, "finished_at": datetime.utcnow().isoformat(timespec="seconds"),
            "base_url": base_url, "workdir": str(workdir), **{**analysis, "screens": screens},
            "corrections": corrections, "gap_findings": findings}
