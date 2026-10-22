"""Automation Module: test cases composed from the Automation KB, not written.

The usual path asks a model to turn a BRD into test steps in prose, then tries
to match that prose to the application: "Manage Users link or menu item"
becomes a guessed getByRole locator, and the BRD's own fiction (controls the
application does not have) becomes a script that fails at run time. Across
this deployment's dry runs, cases built that way passed 32 of 63; cases whose
every step came from the Knowledge Base passed 127 of 133.

So this path splits the work by what each side is good at:

  * the BRD supplies WHAT -- the requirement, its data and expected outcome;
  * the Automation KB supplies HOW -- `components.json`, verified building
    blocks ("open product page (product)", "select storage (value)", "assert
    plan price (plan)") whose steps carry selectors confirmed on the live site.

The model reads the BRD and may only (1) say, per requirement, whether the KB
covers it, and (2) for a covered one, list component ids with parameter values
from the KB's allowed lists. Code then validates every id, value and page
transition, and assembles the real steps. The model never writes a selector,
a URL or a price: prices and product ids are read from the KB record.

A requirement the KB does not cover is reported, not guessed at:

  covered     -- composed into cases;
  kb_gap      -- the application has it, the KB does not describe it yet
                 (a crawl target);
  blocked     -- the KB records a known defect that prevents it;
  not_in_app  -- nothing in the KB or the crawl shows the application has it.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

from . import knowledge_base as kb
from .llm import complete_json, wrap_user_content

logger = logging.getLogger(__name__)

COMPONENTS_FILE = "components.json"
STATUSES = ("covered", "kb_gap", "blocked", "not_in_app")


# --- What the model may return -----------------------------------------------

class ComposedStep(BaseModel):
    component: str
    params: dict[str, str] = Field(default_factory=dict)


class ComposedCase(BaseModel):
    title: str
    objective: str = ""
    priority: str = "Medium"
    test_type: str = "Positive"
    expected_result: str = ""
    steps: list[ComposedStep] = Field(default_factory=list)


class RequirementResult(BaseModel):
    id: str
    summary: str = ""
    status: Literal["covered", "kb_gap", "blocked", "not_in_app"]
    reason: str = ""
    cases: list[ComposedCase] = Field(default_factory=list)


class Composition(BaseModel):
    requirements: list[RequirementResult]


# --- The KB side ----------------------------------------------------------------

@dataclass
class Library:
    app_key: str
    params: dict[str, dict]
    components: dict[str, dict]
    products: dict[str, dict]
    defects: list[dict]
    app_name: str


def _plan_prices(record: dict) -> dict[str, str]:
    """'24 months AED 348.00 /month' -> {'24 months': '348.00'}."""
    out: dict[str, str] = {}
    for entry in record.get("payment_plans") or []:
        match = re.match(r"\s*(.+?)\s+AED\s+([\d,]+\.\d{2})", str(entry))
        if match:
            out[match.group(1).strip()] = match.group(2)
    return out


def load_library(app_key: str) -> Library:
    folder = kb.get_kb_root() / app_key
    path = folder / COMPONENTS_FILE
    if not path.exists():
        raise FileNotFoundError(
            f"{app_key} has no {COMPONENTS_FILE}: the Automation KB has no components to compose from."
        )
    data = json.loads(path.read_text(encoding="utf-8"))
    products: dict[str, dict] = {}
    for flow in kb.list_flows(app_key):
        for name, record in (flow.get("known_products") or {}).items():
            products[name] = {**record, "price": _plan_prices(record), "name": name}
    profile = kb.load_exact_profile(app_key) or {}
    return Library(
        app_key=app_key,
        params=data.get("params") or {},
        components={c["id"]: c for c in data.get("components") or []},
        products=products,
        defects=list(profile.get("known_defects") or []),
        app_name=profile.get("app_name") or app_key,
    )


def catalogue_text(lib: Library) -> str:
    """The KB as the model sees it: components, allowed values, products, defects."""
    lines = [f"APPLICATION: {lib.app_name} (Automation KB '{lib.app_key}')", "", "COMPONENTS (id -- what it does; params; must start on page -> leaves page):"]
    for comp in lib.components.values():
        params = ", ".join(comp.get("params") or []) or "none"
        rule = "".join(
            f" Only after {key} in {allowed}." for key, allowed in (comp.get("requires_selected") or {}).items()
        )
        lines.append(f"- {comp['id']} -- {comp['description']}{rule} params: {params}; {comp['requires']} -> {comp['leaves']}")
    lines += ["", "PARAMETER VALUES (use exactly one of these strings):"]
    for name, spec in lib.params.items():
        if spec.get("type") == "text":
            lines.append(f"- {name}: free text. {spec.get('_note', '')}")
        else:
            lines.append(f"- {name}: {json.dumps(spec.get('values') or [], ensure_ascii=False)}")
    lines += ["", "PRODUCTS IN THE KB:"]
    for name, record in lib.products.items():
        if not record.get("title"):
            continue
        prices = ", ".join(f"{k} AED {v}" for k, v in record["price"].items())
        lines.append(f"- {name}: stock {record.get('stock_state', 'unknown')}; {prices}")
    lines += ["", "KNOWN DEFECTS IN THIS ENVIRONMENT:"]
    for defect in lib.defects:
        lines.append(f"- {defect.get('id')}: {defect.get('what')}")
    return "\n".join(lines)


SYSTEM_PROMPT = """You turn a BRD into automated test cases for ONE application, using ONLY the \
building blocks of its Automation Knowledge Base. You never write test steps, selectors, URLs or \
prices yourself.

For every business requirement in the BRD, return one entry:
- id: the requirement's id from the BRD (e.g. BR-04), summary: a few words.
- status:
  * "covered" when the components can demonstrate it; then give one or more cases.
  * "kb_gap" when the requirement describes a screen or control the application plausibly has \
(the KB or its defects mention it, or it sits on a crawled page) but no component exercises it.
  * "blocked" when a KNOWN DEFECT listed in the KB prevents it.
  * "not_in_app" when nothing in the KB suggests the application has it.
  A requirement only partly covered is "covered" for the covered part; say what is left out in reason.
- reason: one sentence; for kb_gap say exactly what component is missing.
- cases (only when covered): each case is
  {title, objective, priority (High|Medium|Low), test_type (Positive|Negative), expected_result,
   steps: [{component, params}]}
  Rules for steps:
  * Start with a component whose start page is "none" (it opens the page).
  * Each next component must start on the page the previous one leaves you on
    ("any" leaves the page unchanged; a product page reached from the listing also counts as "product").
  * params are taken ONLY from PARAMETER VALUES, copied exactly. Use product names exactly as listed.
  * Every case must contain at least one component that asserts something (assert_*, select_*,
    sort_listing, filter_storage, load_more, go_to_tablets_via_menu, switch_to_arabic, open_product_from_listing,
    breadcrumb_to_tablets).
  * Keep cases short (2-6 components) and one idea per case. Do not repeat the same case.
Return JSON only: {"requirements": [ ... ]}"""


# --- Validation and assembly --------------------------------------------------------

@dataclass
class BuiltCase:
    requirement: str
    case: ComposedCase
    steps: list[dict] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


_PATH = re.compile(r"\{([a-z_]+)((?:\.[^{}]+)+)\}")


def _render(text: str, values: dict[str, Any]) -> str:
    """{param} first, then {param.path.to.value} through the product record."""
    def simple(match: re.Match) -> str:
        key = match.group(1)
        value = values.get(key)
        return value["name"] if isinstance(value, dict) else str(value) if value is not None else match.group(0)

    out = re.sub(r"\{([a-z_]+)\}", simple, text)

    def dotted(match: re.Match) -> str:
        value: Any = values.get(match.group(1))
        for part in match.group(2).strip(".").split("."):
            value = value.get(part) if isinstance(value, dict) else None
        if value is None:
            raise KeyError(match.group(0))
        return str(value)

    return _PATH.sub(dotted, out)


def _default_selection(lib: Library, record: dict) -> dict[str, str]:
    """The options a product page opens with, from the KB's default_variant.

    "Silver / 1TB / Wi-Fi + Cellular / Nano-Texture Glass" -> {colour: Silver,
    storage: 1TB, connectivity: Wi-Fi + Cellular, display_glass: Nano-Texture Glass},
    matched against each parameter's allowed values.
    """
    parts = [p.strip() for p in str(record.get("default_variant") or "").split("/")]
    out: dict[str, str] = {}
    for name, spec in lib.params.items():
        for value in spec.get("values") or []:
            if value in parts and spec.get("type") != "product":
                out[name] = value
    return out


def _page_ok(current: str, required: str) -> bool:
    if required == "none":
        return True
    if required == "product":
        return current in ("product", "product_from_listing")
    return current == required


def build_case(lib: Library, requirement: str, case: ComposedCase) -> BuiltCase:
    built = BuiltCase(requirement=requirement, case=case)
    page = "none"
    current_product: Optional[dict] = None
    # Option values chosen earlier in the case, by parameter name, for
    # components that only work after certain choices (requires_selected).
    selected: dict[str, str] = {}
    asserts = 0
    if not case.steps:
        built.errors.append("The case has no steps.")
        return built
    for index, ref in enumerate(case.steps, start=1):
        comp = lib.components.get(ref.component)
        if comp is None:
            built.errors.append(f"Step {index}: '{ref.component}' is not a component of this KB.")
            continue
        if index == 1 and comp["requires"] != "none":
            built.errors.append(f"Step {index}: the case must start by opening a page; '{ref.component}' needs '{comp['requires']}'.")
        elif not _page_ok(page, comp["requires"]):
            built.errors.append(f"Step {index}: '{ref.component}' needs the {comp['requires']} page, but the case is on '{page}'.")
        values: dict[str, Any] = {}
        for name in comp.get("params") or []:
            raw = (ref.params.get(name) or "").strip()
            spec = lib.params.get(name) or {}
            if not raw:
                built.errors.append(f"Step {index}: '{ref.component}' needs parameter '{name}'.")
                continue
            if spec.get("type") == "text":
                raw = re.sub(r"[\"'{}]", "", raw)[:60]
                values[name] = raw
            elif raw not in (spec.get("values") or []):
                built.errors.append(f"Step {index}: '{raw}' is not an allowed value of '{name}'.")
                continue
            elif spec.get("type") == "product":
                record = lib.products.get(raw)
                if not record:
                    built.errors.append(f"Step {index}: product '{raw}' has no KB record.")
                    continue
                values[name] = record
                current_product = record
                selected.clear()
                selected.update(_default_selection(lib, record))
            else:
                values[name] = raw
        for key, allowed in (comp.get("requires_selected") or {}).items():
            if key in selected and selected[key] not in allowed:
                built.errors.append(
                    f"Step {index}: '{ref.component}' is only possible when {key} is one of "
                    f"{', '.join(allowed)}; the case chose {selected[key]}."
                )
        # Asking for the option already selected (the product's default, or
        # an earlier choice): the site does not let the active pill be
        # clicked, so only the assertion that it is active is kept.
        state = comp.get("state_param")
        already = bool(state) and selected.get(state) == values.get(state)
        for name, value in values.items():
            if isinstance(value, str):
                selected[name] = value
        if comp.get("uses_current_product"):
            if current_product is None:
                built.errors.append(f"Step {index}: '{ref.component}' needs a product opened earlier in the case.")
                continue
            values["current_product"] = current_product
            wanted = comp.get("only_if_product_stock")
            if wanted and current_product.get("stock_state") != wanted:
                built.errors.append(
                    f"Step {index}: '{ref.component}' applies only to a product whose KB stock is '{wanted}'; "
                    f"{current_product['name']} is '{current_product.get('stock_state', 'unknown')}'."
                )
                continue
        try:
            for action, action_type, target, expected in comp["steps"]:
                if already and action_type == "click":
                    continue
                built.steps.append({
                    "step_number": len(built.steps) + 1,
                    "action": _render(action, values),
                    "action_type": action_type,
                    "target": _render(target, values),
                    "test_data_ref": None,
                    "expected_result": _render(expected, values),
                    "kb_component": comp["id"],
                })
                if action_type == "assert" or "/ar/" in expected or "opens at" in expected:
                    asserts += 1
        except KeyError as missing:
            built.errors.append(f"Step {index}: the KB has no value for {missing} on {ref.component}.")
        if comp["leaves"] != "any":
            page = comp["leaves"]
    if not asserts and not built.errors:
        built.errors.append("The case checks nothing: add an assert_* or a component that asserts.")
    return built


@dataclass
class Result:
    app_key: str
    requirements: list[RequirementResult]
    built: list[BuiltCase]

    @property
    def valid(self) -> list[BuiltCase]:
        return [b for b in self.built if not b.errors]

    @property
    def rejected(self) -> list[BuiltCase]:
        return [b for b in self.built if b.errors]

    def report(self) -> dict:
        by_req: dict[str, list[BuiltCase]] = {}
        for b in self.built:
            by_req.setdefault(b.requirement, []).append(b)
        return {
            "app_key": self.app_key,
            "summary": {s: sum(1 for r in self.requirements if r.status == s) for s in STATUSES}
            | {"cases": len(self.valid), "rejected_cases": len(self.rejected)},
            "requirements": [
                {
                    "id": r.id,
                    "summary": r.summary,
                    "status": r.status,
                    "reason": r.reason,
                    "cases": [b.case.title for b in by_req.get(r.id, []) if not b.errors],
                    "rejected": [{"title": b.case.title, "errors": b.errors} for b in by_req.get(r.id, []) if b.errors],
                }
                for r in self.requirements
            ],
        }


def compose(brd_text: str, app_key: str, *, repair: bool = True) -> Result:
    """BRD text -> requirement statuses and KB-assembled cases. One repair round for rejected cases."""
    lib = load_library(app_key)
    catalogue = catalogue_text(lib)
    user_input = f"{catalogue}\n\nBRD:\n{wrap_user_content(brd_text)}"
    composition = complete_json(
        system_prompt=SYSTEM_PROMPT, user_input=user_input, model_cls=Composition,
        max_tokens=16000, temperature=0.1,
    )
    built = [build_case(lib, r.id, c) for r in composition.requirements if r.status == "covered" for c in r.cases]

    rejected = [b for b in built if b.errors]
    if repair and rejected:
        notes = "\n".join(
            f"- {b.requirement} / {b.case.title}: " + "; ".join(b.errors) for b in rejected
        )
        fix = complete_json(
            system_prompt=SYSTEM_PROMPT,
            user_input=(
                f"{catalogue}\n\nThese cases you composed were rejected by validation:\n{notes}\n\n"
                "Return {\"requirements\": [...]} containing ONLY the requirements above, each with "
                "status covered and corrected cases, or a different status if they cannot be composed."
                f"\n\nBRD:\n{wrap_user_content(brd_text)}"
            ),
            model_cls=Composition, max_tokens=12000, temperature=0.1,
        )
        fixed_ids = {r.id for r in fix.requirements}
        built = [b for b in built if not (b.errors and b.requirement in fixed_ids)]
        for r in fix.requirements:
            original = next((o for o in composition.requirements if o.id == r.id), None)
            if original is not None and r.status != "covered" and not any(
                b.requirement == r.id and not b.errors for b in built
            ):
                original.status, original.reason = r.status, r.reason
            for c in r.cases if r.status == "covered" else []:
                built.append(build_case(lib, r.id, c))
    return Result(app_key=app_key, requirements=composition.requirements, built=built)


# --- Into Automation Studio ------------------------------------------------------

def save_cases(db, result: Result, *, project_id: int, application_id: int, application_url: str,
               environment: Optional[str], prefix: str, approve: bool, username: str) -> list[int]:
    """Create or update the valid cases (by display_id within the project). Returns their ids.

    Classified Automation by policy: every step is a KB component with a verified
    target. `approve` marks them approved; otherwise they wait in Review & Approval.
    """
    from datetime import datetime

    from ...models.automation import AutomationTestCase

    ids: list[int] = []
    for number, b in enumerate(result.valid, start=1):
        display_id = f"{prefix}-{number:03d}"
        c = b.case
        values = dict(
            source="refined",
            origin="kb_composed",
            display_id=display_id,
            category=b.requirement,
            description=c.objective or c.title,
            objective=c.title,
            preconditions="Guest user (not signed in) on the application's test environment.",
            steps_raw="\n".join(f"{s['step_number']}. {s['action']}" for s in b.steps),
            steps_structured=b.steps,
            test_data="None - values come from the Automation KB.",
            test_data_required=False,
            test_data_status="ready",
            test_data_requirements=[],
            expected_result=c.expected_result or c.objective,
            priority=c.priority if c.priority in ("High", "Medium", "Low") else "Medium",
            test_type=c.test_type if c.test_type in ("Positive", "Negative") else "Positive",
            automation_blockers=[],
            eligibility_score=100,
            eligibility_verdict="ready",
            eligibility_reasons=[],
            classification="automation",
            classification_source="policy",
            classification_reason=(
                "Composed from Automation KB components: "
                + ", ".join(dict.fromkeys(s["kb_component"] for s in b.steps))
            ),
            manual_only_reasons=[],
            approval_status="approved" if approve else "draft",
            decision_reason="Composed from the Automation KB." if approve else None,
            approved_by=username if approve else None,
            approved_at=datetime.utcnow() if approve else None,
            application_id=application_id,
            application_url=application_url,
            environment=environment,
            project_id=project_id,
            grounding_status="grounded",
            grounding_summary=f"kb_compose {result.app_key}: requirement {b.requirement}",
            created_by=username,
        )
        row = (
            db.query(AutomationTestCase)
            .filter(AutomationTestCase.project_id == project_id, AutomationTestCase.display_id == display_id)
            .first()
        )
        if row is None:
            row = AutomationTestCase(**values)
            db.add(row)
        else:
            for key, value in values.items():
                setattr(row, key, value)
        db.flush()
        ids.append(row.id)
    # A re-composition can produce fewer cases: earlier composed cases in this
    # project that it did not produce again are removed with their scripts.
    from ...models.automation import AutomationScript

    stale = (
        db.query(AutomationTestCase)
        .filter(AutomationTestCase.project_id == project_id,
                AutomationTestCase.origin == "kb_composed",
                ~AutomationTestCase.id.in_(ids or [-1]))
        .all()
    )
    for row in stale:
        db.query(AutomationScript).filter(AutomationScript.test_case_id == row.id).delete()
        db.delete(row)
    db.commit()
    return ids
