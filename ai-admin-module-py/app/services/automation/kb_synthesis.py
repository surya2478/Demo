"""
--- Automation Module: Knowledge Base synthesis from a crawl ------------------

A crawl produces facts: the routes it reached, the locators it verified, the
hrefs of the links it followed. `knowledge_base.build_draft_profile` writes
those down honestly and stops there -- which is correct, and also why a drafted
application arrives with none of the four keys the model compiler actually
reads. `url_templates`, `endpoints`, named `selectors` groups and
`step_grounding_rules` were all left for a person to type, so every new
application needed the same afternoon of hand-editing that `eand_ae` got.

This closes that gap without inventing anything. A model reads the crawl and
proposes the structure a person would have typed -- which of the catalogued
controls is the cart CTA, what shape the product URL takes, which keywords
should ground which step -- and then every proposal is checked back against the
crawl. A selector the crawl never verified is dropped. A route it never reached
is dropped. A URL template whose literal part is not a route the crawl saw is
dropped.

So the model is doing classification, not generation: it decides what the
crawled facts *mean*, and cannot contribute a fact of its own. That distinction
is the whole reason this is safe to run unattended, and it is why the output is
still stamped `_draft` -- a confident wrong classification is possible, and a
person still signs it off.

Synthesis is optional at every level. No API key, an unreachable provider, a
malformed reply: each falls back to the plain structural draft, which is what
this module started from.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from . import llm

logger = logging.getLogger(__name__)

# How much of the crawl to put in front of the model. A large application
# catalogues hundreds of controls, and the useful ones are the high-confidence
# uniquely-named handful per page -- so send those and say how many were left.
MAX_PAGES_IN_PROMPT = 40
MAX_ELEMENTS_IN_PROMPT = 120


class SynthesisedFlow(BaseModel):
    """One journey the model believes the crawled pages describe."""

    flow_name: str = Field(description="Human name for the journey, e.g. 'Earbuds Purchase Flow'.")
    category: str = Field(default="Discovered", description="Product or functional area.")
    target_match_keywords: List[str] = Field(
        default_factory=list,
        description="Lower-case words that should match a test case to this flow.",
    )
    catalog_entrypoint_route: str = Field(
        default="", description="Route where the journey starts, e.g. '/eshop/devices/listing'."
    )
    canonical_steps: List[Dict[str, Any]] = Field(
        default_factory=list,
        description=(
            "Ordered steps. Each: step_number, action, target (a ROUTE starting "
            "with '/' or a verified selector), href (the link route to click, or "
            "null), expected_result."
        ),
    )


class SynthesisResult(BaseModel):
    """Everything the model proposes for one application."""

    app_name: str = Field(default="", description="A readable application name.")
    framework: str = Field(default="Web Application")
    url_templates: Dict[str, str] = Field(
        default_factory=dict,
        description=(
            "Route templates with {product_id}/{sku_id}/{category} placeholders, "
            "e.g. product_configuration: '/eshop/devices/configuration?productId={product_id}'."
        ),
    )
    endpoints: Dict[str, str] = Field(
        default_factory=dict, description="Named routes, e.g. cart: '/eshop/checkout/cart'."
    )
    selectors: Dict[str, Dict[str, str]] = Field(
        default_factory=dict,
        description=(
            "Named groups (catalog, product_configuration, cart, homepage), each a "
            "map of role name to a selector that appeared in the crawl."
        ),
    )
    cookie_overlay_selector: str = Field(
        default="", description="Host element of the consent overlay, if the crawl saw one."
    )
    step_grounding_rules: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="Ordered {id, keywords[], target} rules. Target may use {cart_route} etc.",
    )
    flows: List[SynthesisedFlow] = Field(default_factory=list)
    notes: List[str] = Field(
        default_factory=list, description="What could not be determined from the crawl."
    )


SYNTHESIS_SYSTEM_PROMPT = """You are a test-automation domain modeller. You are given the raw \
output of an automated crawl of one web application: the pages it reached, the link it followed to \
reach each one, and the interactive controls it catalogued with locators that were VERIFIED to \
resolve at crawl time.

Your job is to classify those facts into an application profile. You are NOT to invent facts.

Hard rules:
1. Every selector you output MUST be copied verbatim from the `verified_locators` given to you. \
Never write a selector that is not in that list.
2. Every route you output MUST start with "/" and MUST be a route that appears in `pages` or in \
`link_hrefs`. Never output an absolute URL with a host.
3. url_templates may add {product_id}, {sku_id}, {category} or {product_name} placeholders to a \
route you saw, replacing the literal values in its query string. The path before "?" must be a \
path the crawl actually reached.
4. If the crawl gives you no basis for a key, omit it and say so in `notes`. An omission is \
correct; a plausible guess is not.
5. canonical_steps describe ONE coherent user journey per flow, in order, in the application's own \
language. Prefer `href` click-through over route navigation: set `href` to the route of the link \
that reaches the step's destination whenever the crawl recorded one.
6. step_grounding_rules map test-case wording to targets. Each rule is exactly \
{"id": "...", "keywords": ["...", "..."], "target": "..."} -- the key MUST be spelled \
`keywords` and MUST be a list of lower-case phrases, because a rule with no `keywords` \
list can never match a step and is discarded. `target` may be a verified selector, or one \
of the placeholders {base_route}, {catalog_route}, {cart_route}, {product_configuration_route}.

Return ONLY JSON matching the requested schema."""


def _route_of(url: str, base_url: str) -> str:
    from .knowledge_base import to_route

    return to_route(url, base_url)


def _crawl_digest(
    *,
    app_name: str,
    base_url: str,
    pages: List[Dict[str, Any]],
    elements: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """What the model is allowed to see, and by construction to reason from."""
    page_rows = []
    for page in pages[:MAX_PAGES_IN_PROMPT]:
        page_rows.append(
            {
                "route": _route_of(page.get("url", ""), base_url),
                "title": (page.get("title") or "")[:200],
                "status": page.get("status"),
                "reached_by_clicking": _route_of(page.get("via_href") or "", base_url) or None,
                "link_text": page.get("via_text") or None,
            }
        )

    ranked = sorted(
        elements,
        key=lambda e: (-(e.get("confidence_score") or 0), e.get("element_name") or ""),
    )
    element_rows = []
    link_hrefs: List[str] = []
    for element in ranked[:MAX_ELEMENTS_IN_PROMPT]:
        href = _route_of(element.get("href") or "", base_url)
        if href and href.startswith("/") and href not in link_hrefs:
            link_hrefs.append(href)
        element_rows.append(
            {
                "name": element.get("element_name"),
                "role": element.get("role"),
                "label": element.get("accessible_name"),
                "locator": element.get("recommended_locator"),
                "confidence": element.get("confidence_score"),
                "on_route": _route_of(element.get("page_url") or "", base_url),
                "href": href or None,
            }
        )

    return {
        "application": {"name": app_name, "base_url": base_url},
        "pages": page_rows,
        "pages_omitted": max(0, len(pages) - MAX_PAGES_IN_PROMPT),
        "verified_locators": element_rows,
        "locators_omitted": max(0, len(elements) - MAX_ELEMENTS_IN_PROMPT),
        "link_hrefs": link_hrefs[:200],
    }


# --- Validation: the model classifies, the crawl decides ---------------------


def _known_routes(digest: Dict[str, Any]) -> set[str]:
    """Every route the crawl actually reached or saw linked."""
    routes = {row["route"] for row in digest["pages"] if row.get("route")}
    routes.update(row for row in digest["link_hrefs"] if row)
    routes.update(
        row["href"] for row in digest["verified_locators"] if row.get("href")
    )
    return {r for r in routes if r.startswith("/")}


def _known_locators(digest: Dict[str, Any]) -> set[str]:
    return {
        row["locator"] for row in digest["verified_locators"] if row.get("locator")
    }


def _route_is_known(route: str, known: set[str]) -> bool:
    """A route counts as known if the crawl saw it, ignoring the query string.

    Query parameters are where the product identifiers live, so an exact match
    would reject every template the model is supposed to produce.
    """
    if not route or not route.startswith("/"):
        return False
    path = route.split("?")[0].rstrip("/") or "/"
    return any((k.split("?")[0].rstrip("/") or "/") == path for k in known)


# What a model calls the keyword list when it does not call it `keywords`.
# knowledge_base.ground_case_structured_steps reads `keywords` and nothing else,
# so a rule keyed on any of these is inert -- it sits in the profile looking
# configured while every step falls through to the phrase heuristic.
_KEYWORD_ALIASES = ("keywords", "wording", "when", "match", "phrases", "triggers")


def normalise_grounding_rule(rule: Dict[str, Any], index: int) -> Dict[str, Any]:
    """One grounding rule in the shape the Knowledge Base actually reads.

    Also gives the rule an `id`: the profile's hand-written rules all carry one,
    it is what a reviewer refers to when discussing a rule, and a model asked
    for rules will often omit it.
    """
    out = dict(rule)

    keywords: List[str] = []
    for alias in _KEYWORD_ALIASES:
        value = out.pop(alias, None)
        if isinstance(value, str) and value.strip():
            keywords.append(value.strip())
        elif isinstance(value, (list, tuple)):
            keywords.extend(str(v).strip() for v in value if str(v).strip())

    seen: List[str] = []
    for word in keywords:
        lowered = word.lower()
        if lowered not in seen:
            seen.append(lowered)
    if seen:
        out["keywords"] = seen

    if not str(out.get("id") or "").strip():
        source = seen[0] if seen else f"rule_{index + 1}"
        out["id"] = re.sub(r"[^a-z0-9]+", "_", source.lower()).strip("_") or f"rule_{index + 1}"
    return out


_PLACEHOLDER_TARGETS = {
    "{base_route}",
    "{catalog_route}",
    "{cart_route}",
    "{product_configuration_route}",
    "{cookie_host_selector}",
}


def _validated(
    result: SynthesisResult, digest: Dict[str, Any]
) -> tuple[SynthesisResult, List[str]]:
    """Drop everything the crawl cannot vouch for, and say what was dropped."""
    known_routes = _known_routes(digest)
    known_locators = _known_locators(digest)
    dropped: List[str] = []

    def keep_route(value: str, where: str) -> str:
        if _route_is_known(value, known_routes):
            return value
        if value:
            dropped.append(f"{where}: route {value!r} was never reached by the crawl.")
        return ""

    def keep_locator(value: str, where: str) -> str:
        if value in known_locators or value in _PLACEHOLDER_TARGETS:
            return value
        if value:
            dropped.append(f"{where}: selector {value!r} was not verified by the crawl.")
        return ""

    result.url_templates = {
        name: kept
        for name, value in (result.url_templates or {}).items()
        if (kept := keep_route(value, f"url_templates.{name}"))
    }
    result.endpoints = {
        name: kept
        for name, value in (result.endpoints or {}).items()
        if (kept := keep_route(value, f"endpoints.{name}"))
    }

    clean_selectors: Dict[str, Dict[str, str]] = {}
    for group, entries in (result.selectors or {}).items():
        kept_group = {
            name: kept
            for name, value in (entries or {}).items()
            if (kept := keep_locator(str(value), f"selectors.{group}.{name}"))
        }
        if kept_group:
            clean_selectors[group] = kept_group
    result.selectors = clean_selectors

    result.cookie_overlay_selector = keep_locator(
        result.cookie_overlay_selector, "cookie_overlay"
    )

    clean_rules = []
    for index, rule in enumerate(result.step_grounding_rules or []):
        rule = normalise_grounding_rule(rule, index)
        target = str(rule.get("target") or "")
        if not rule.get("keywords"):
            # A rule with no keywords never matches a step, so writing it into
            # the profile produces a file that looks configured and grounds
            # nothing. Caught here because a model asked for `keywords` will
            # sometimes answer with `wording` or `when`, and the difference is
            # invisible until a run comes back ungrounded.
            dropped.append(
                f"step_grounding_rules[{index}]: no keywords to match on, so the "
                f"rule could never fire."
            )
            continue
        if target in _PLACEHOLDER_TARGETS or target in known_locators:
            clean_rules.append(rule)
        elif _route_is_known(target, known_routes):
            clean_rules.append(rule)
        elif target:
            dropped.append(
                f"step_grounding_rules[{index}]: target {target!r} is neither a "
                f"verified selector nor a crawled route."
            )
    result.step_grounding_rules = clean_rules

    clean_flows = []
    for flow in result.flows or []:
        flow.catalog_entrypoint_route = keep_route(
            flow.catalog_entrypoint_route, f"flows.{flow.flow_name}.catalog_entrypoint"
        )
        steps = []
        for step in flow.canonical_steps or []:
            target = str(step.get("target") or "")
            href = str(step.get("href") or "")
            if target.startswith("/"):
                if not _route_is_known(target, known_routes):
                    dropped.append(
                        f"flows.{flow.flow_name} step {step.get('step_number')}: "
                        f"route {target!r} was never reached."
                    )
                    continue
            elif target and target not in known_locators:
                dropped.append(
                    f"flows.{flow.flow_name} step {step.get('step_number')}: "
                    f"selector {target!r} was not verified."
                )
                continue
            if href and not _route_is_known(href, known_routes):
                # The step still stands; it just navigates instead of clicking.
                dropped.append(
                    f"flows.{flow.flow_name} step {step.get('step_number')}: "
                    f"href {href!r} was never seen, so the step navigates instead."
                )
                step["href"] = None
            steps.append(step)
        # Renumber: dropping a step mid-flow would otherwise leave a gap.
        for position, step in enumerate(steps, start=1):
            step["step_number"] = position
        flow.canonical_steps = steps
        if steps:
            clean_flows.append(flow)
    result.flows = clean_flows

    return result, dropped


def synthesise(
    *,
    app_name: str,
    base_url: str,
    pages: List[Dict[str, Any]],
    elements: List[Dict[str, Any]],
    timeout: float = 90.0,
) -> Optional[Dict[str, Any]]:
    """Propose profile structure from a crawl, or None when unavailable.

    None is a normal outcome, not an error: no configured provider, an
    unreachable one, or a reply that could not be validated all mean the caller
    writes the plain structural draft it would have written anyway.
    """
    if not pages and not elements:
        return None

    digest = _crawl_digest(
        app_name=app_name, base_url=base_url, pages=pages, elements=elements
    )

    try:
        proposal: SynthesisResult = llm.complete_json(
            system_prompt=SYNTHESIS_SYSTEM_PROMPT,
            user_input=llm.wrap_user_content(_as_prompt(digest)),
            model_cls=SynthesisResult,
            max_tokens=12000,
            temperature=0.1,
            timeout=timeout,
        )
    except Exception as exc:  # noqa: BLE001 - every failure means "write the plain draft"
        logger.warning(
            "Knowledge Base synthesis for %s did not produce a usable proposal (%s). "
            "Falling back to the structural draft.",
            app_name, exc,
        )
        return None

    proposal, dropped = _validated(proposal, digest)
    if dropped:
        logger.info(
            "Knowledge Base synthesis for %s: dropped %d unsupported proposal(s).",
            app_name, len(dropped),
        )

    return {
        "proposal": proposal.model_dump(),
        "dropped": dropped,
        "pages_considered": len(digest["pages"]),
        "locators_considered": len(digest["verified_locators"]),
    }


def _as_prompt(digest: Dict[str, Any]) -> str:
    """The digest as text, with the counts stated rather than left to be inferred."""
    import json

    return json.dumps(digest, indent=2, ensure_ascii=False)


def available() -> bool:
    """Whether a model could be reached for synthesis right now."""
    try:
        return bool((llm.provider_status() or {}).get("configured"))
    except Exception:  # noqa: BLE001
        return False


__all__ = ["synthesise", "available", "SynthesisResult", "SynthesisedFlow"]


# Kept out of the prompt but useful when reading a draft back: the placeholder
# vocabulary a synthesised rule is allowed to use.
GROUNDING_PLACEHOLDERS = sorted(_PLACEHOLDER_TARGETS)