"""
--- Automation Module: Application Flow Knowledge Base ------------------------

Manages domain-specific knowledge bases and Flow Blueprints.
Provides flow matching, context injection for LLM test case generation, and
deterministic grounding for Playwright script compilation.
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from ...config import settings

logger = logging.getLogger(__name__)

# --- Automation Module: make the Knowledge Base reach the container ----------
# The data used to live at the repository root, one level above
# ai-admin-module-py. The backend image is built with that directory as its
# context, so `COPY . /app` could not see it and no candidate below resolved
# inside the container -- KB_ROOT_DIR simply did not exist. Nothing raised:
# every lookup here returns [] or None on a missing root, so the compiler, the
# healer and testcases.py carried on producing ungrounded output. It reads as
# an LLM quality problem rather than a packaging one, which is why it survived
# three days of grounding work.
#
# The data now sits at ai-admin-module-py/knowledge_base, inside the build
# context, and _candidate_package finds it at /app/knowledge_base in the image
# and at ai-admin-module-py/knowledge_base on a dev host -- one path that works
# in both places.
#
# AUTOMATION_KB_PATH wins over both. Flow blueprints are the part of this
# system most likely to need a change after go-live, and an override lets a
# deployment bind-mount an updated Knowledge Base over the baked-in one
# without rebuilding the image.
#
# _candidate_repo_root is the old location, kept last so a working tree that
# has not pulled the move still resolves.
def _resolve_kb_root() -> Path:
    here = Path(__file__).resolve()

    override = (settings.AUTOMATION_KB_PATH or "").strip()
    candidates = []
    if override:
        candidates.append(Path(override).expanduser() / "applications")

    _candidate_package = here.parents[3] / "knowledge_base" / "applications"
    _candidate_repo_root = here.parents[4] / "knowledge_base" / "applications"
    candidates += [_candidate_package, _candidate_repo_root]

    for candidate in candidates:
        if candidate.exists():
            logger.info("Knowledge Base root resolved to %s", candidate)
            return candidate

    # Say so once, at import, rather than letting every caller infer an empty
    # Knowledge Base from empty results.
    logger.warning(
        "No Knowledge Base found. Tried: %s. Flow grounding will be skipped and "
        "generated scripts will not be grounded against any application profile. "
        "Set AUTOMATION_KB_PATH to the directory holding 'applications/'.",
        ", ".join(str(c) for c in candidates),
    )
    return _candidate_package


KB_ROOT_DIR = _resolve_kb_root()

# Bumped from 2.0.0 when the model stopped being compiled around one company's
# URLs: `page_models` components, the PDP url_template and every selector now
# come from the profile, so a 2.0.0 document and a 3.0.0 one for the same
# application can legitimately differ in what they contain.
MODEL_VERSION = "3.0.0"


def get_kb_root() -> Path:
    return KB_ROOT_DIR


def list_applications() -> List[Dict[str, Any]]:
    """List all application profiles available in the Knowledge Base."""
    apps = []
    if not KB_ROOT_DIR.exists():
        return apps

    for app_dir in KB_ROOT_DIR.iterdir():
        if app_dir.is_dir():
            profile_file = app_dir / "app_profile.json"
            if profile_file.exists():
                try:
                    with open(profile_file, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        data["flows_count"] = len(list((app_dir / "flows").glob("*.json"))) if (app_dir / "flows").exists() else 0
                        apps.append(data)
                except Exception as e:
                    logger.warning("Failed to load app profile from %s: %s", profile_file, e)
    return apps



# --- Automation Module: the profile is the application, not this file --------
#
# Everything below used to know about e& UAE directly. `build_application_model`
# assembled product URLs from an f-string containing eand.ae and a constant
# `listVal=Smartphones`; `page_models` listed `.device-card` and
# `button:has-text('ADD TO CART')`; `ground_case_structured_steps` was a ladder
# of elif branches keyed on e& vocabulary. Asking for a second application's
# model returned a document full of eand.ae routes, which reads as data and is
# not.
#
# So the site-specific knowledge moved into app_profile.json, where the rest of
# the application's ground truth already lived, and these functions became a
# compiler over it. A new application is onboarded by writing a profile and its
# flows -- no Python change. An application whose profile omits a template
# simply has no entry for it in the model, which is honest; the old fallbacks
# answered with another company's URLs.
#
# Profile keys this module reads, all optional:
#
#   url_templates.product_configuration  Placeholder URL for a PDP, e.g.
#       ".../configuration?productId={product_id}&skuId={sku_id}&catName={category}"
#   endpoints.cart                       Cart/checkout review URL. A flow's own
#                                        `cart_endpoint` overrides it.
#   selectors.<group>                    Named selector groups quoted into the
#                                        model: catalog, product_configuration,
#                                        cart, navigation_header, catalog_links.
#   step_grounding_rules                 Ordered keyword -> target rules that
#                                        replace the old elif ladder.
#   generation_directives                Prompt instructions for the generator.
#   test_case_matrix                     The scenario spread to ask the model for.
#   default_flow_id                      Which flow to fall back to when nothing
#                                        matches, instead of guessing.
#   default_automation_boundary          Scope statement for flows that omit one.
#
# Placeholders available to any template or rule target: {base_url},
# {catalog_entrypoint}, {cart_endpoint}, {product_configuration_url},
# {cookie_host_selector}, {category}, {product_id}, {sku_id}, {product_name}.

_PLACEHOLDER_RE = re.compile(r"\{([a-zA-Z0-9_]+)\}")


def render_template(template: Optional[str], values: Dict[str, Any]) -> str:
    """Substitute {placeholders} from `values`; unknown ones resolve to empty.

    Deliberately not str.format: a profile is user-authored data, and a typo in
    it should produce a slightly wrong URL rather than raise KeyError deep
    inside model compilation.
    """
    if not template:
        return ""
    return _PLACEHOLDER_RE.sub(lambda m: str(values.get(m.group(1), "") or ""), template)


def _strip_empty_params(url: str) -> str:
    """Drop query parameters a template left empty.

    A product with no skuId used to be handled by conditionally appending the
    parameter. With templates the same case shows up as `&skuId=&`, which some
    applications treat as a real empty value -- so remove it instead.
    """
    if not url or "?" not in url:
        return url
    head, _, query = url.partition("?")
    kept = [pair for pair in query.split("&") if pair and not pair.endswith("=")]
    return f"{head}?{'&'.join(kept)}" if kept else head


def parse_query_params(url: str) -> Dict[str, str]:
    """Key/value query parameters of a URL, in the order the URL lists them."""
    params: Dict[str, str] = {}
    if not url or "?" not in url:
        return params
    for pair in url.split("?", 1)[1].split("&"):
        if "=" in pair:
            key, value = pair.split("=", 1)
            if key:
                params[key] = value
    return params


# --- Automation Module: routes rather than absolute URLs ---------------------
#
# Every URL in this Knowledge Base used to be fully qualified, and grounding
# substituted those absolutes straight into a step's `target`. The compiler saw
# `http...` and emitted `page.goto(absolute)` -- so a seven-step journey became
# seven cold deep-link loads against the host. Nothing clicked through the
# application: SPA state, the cart session and the referer chain were dropped
# between every step, and a WAF-fronted site saw seven unreferred hits instead
# of one journey.
#
# The fix is to carry the *route* -- path plus query, same-origin -- and let
# Playwright's `use.baseURL` supply the host. workspace.write_playwright_config
# has always set that; nothing used it.
#
# Absolute URLs stay valid input everywhere. `to_route` downgrades one to a
# route only when it is same-origin with the application's base URL; a genuinely
# external URL is returned untouched, because navigating to a third-party host
# relative to baseURL would silently point at the wrong site.


def _origin_of(url: str) -> str:
    """Scheme and host of a URL, lower-cased, or "" when it has none."""
    match = re.match(r"(https?)://([^/?#]+)", (url or "").strip(), re.IGNORECASE)
    return f"{match.group(1).lower()}://{match.group(2).lower()}" if match else ""


def to_route(url: Optional[str], base_url: Optional[str]) -> str:
    """The path+query of `url` when it shares an origin with `base_url`.

    Returns the input unchanged for a cross-origin URL, for something that is
    already a route, and for a selector -- callers pass step targets in blind
    and a selector must survive the trip.
    """
    raw = (url or "").strip()
    if not raw:
        return ""
    if not raw.lower().startswith(("http://", "https://")):
        # Already a route, or a selector. Either way, not ours to rewrite.
        return raw

    origin = _origin_of(raw)
    base_origin = _origin_of(base_url or "")
    if not origin or not base_origin or origin != base_origin:
        return raw

    remainder = raw[len(origin):]
    return remainder if remainder.startswith("/") else f"/{remainder}"


def is_route(value: Optional[str]) -> bool:
    """True for a same-origin route: starts with "/" and is not a CSS selector.

    `/foo` is a route; `.segment-tab`, `#id` and `button:has-text(...)` are not,
    and neither is a protocol-relative `//cdn.example.com/x`.
    """
    raw = (value or "").strip()
    return raw.startswith("/") and not raw.startswith("//")


def absolutize(route: Optional[str], base_url: Optional[str]) -> str:
    """A route resolved against `base_url`; anything else returned as given.

    The inverse of `to_route`, for the places that still need a URL a person can
    click -- the URL registry, the Discovery screen, audit entries.
    """
    raw = (route or "").strip()
    if not raw or not is_route(raw):
        return raw
    origin = _origin_of(base_url or "")
    return f"{origin}{raw}" if origin else raw


def load_app_profile(app_id_or_domain: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Load an application profile by folder name, app_id, domain or base URL."""
    if not KB_ROOT_DIR.exists():
        return None

    hint = (app_id_or_domain or "").strip()
    if not hint:
        resolved = default_app_id()
        if not resolved:
            return None
        hint = resolved

    # 1. Try direct folder match
    app_dir = KB_ROOT_DIR / hint
    if app_dir.exists() and (app_dir / "app_profile.json").exists():
        with open(app_dir / "app_profile.json", "r", encoding="utf-8") as f:
            return json.load(f)

    # 2. Collect all valid profiles
    profiles: List[Dict[str, Any]] = []
    for sub in KB_ROOT_DIR.iterdir():
        if sub.is_dir() and (sub / "app_profile.json").exists():
            try:
                with open(sub / "app_profile.json", "r", encoding="utf-8") as f:
                    profiles.append(json.load(f))
            except Exception:
                pass

    # 2a. Match exact app_id inside json
    for prof in profiles:
        if prof.get("app_id") == hint:
            return prof

    # 2b. Match by base_url (longest matching base_url wins)
    best_base_prof = None
    best_base_len = 0
    hint_lower = hint.lower()
    for prof in profiles:
        base_url = (prof.get("base_url") or "").strip().lower()
        if base_url and (base_url in hint_lower or hint_lower in base_url):
            if len(base_url) > best_base_len:
                best_base_len = len(base_url)
                best_base_prof = prof

    if best_base_prof:
        return best_base_prof

    # 2c. Match by path keywords (e.g. /smb/ or smb in hint)
    for prof in profiles:
        app_id = (prof.get("app_id") or "").lower()
        app_name = (prof.get("app_name") or "").lower()
        if ("smb" in hint_lower and ("smb" in app_id or "smb" in app_name)):
            return prof

    # 2d. Fallback to domain match
    for prof in profiles:
        domain = (prof.get("domain") or "").strip().lower()
        if domain and domain in hint_lower:
            return prof

    return profiles[0] if profiles else None


def default_app_id() -> Optional[str]:
    """The primary Knowledge Base application id."""
    apps = list_applications()
    if apps:
        return apps[0].get("app_id") or None
    return None


def default_base_url() -> str:
    """The registered application's home URL, or "" if none can be resolved.

    For the handful of callers that have a test case with no application_url of
    its own and need somewhere to point a browser. They each used to carry the
    literal "https://www.eand.ae/en/index.html" instead, so a case belonging to
    any other application quietly opened a stranger's site. "" is the honest
    answer when nothing is registered, and the caller says so.
    """
    profile = load_app_profile(None) or {}
    return (profile.get("base_url") or "").strip()


def resolve_app_id(hint: Optional[str] = None) -> Optional[str]:
    """Best application id for a hint that may be an id, a domain, a URL, or text."""
    hint = (hint or "").strip()
    if hint:
        profile = load_app_profile(hint)
        if profile:
            return profile.get("app_id") or hint
        hint_lower = hint.lower()
        for app in list_applications():
            a_id = app.get("app_id", "")
            a_name = (app.get("app_name") or "").lower()
            a_dom = (app.get("domain") or "").lower()
            if (a_id and a_id.lower() in hint_lower) or (a_name and a_name in hint_lower) or (a_dom and a_dom in hint_lower):
                return a_id
    return default_app_id()


def list_flows(app_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """List all flow blueprints for an application."""
    app_id = app_id or default_app_id()
    if not app_id:
        return []

    flows_dir = KB_ROOT_DIR / app_id / "flows"
    if not flows_dir.exists():
        return []

    flows = []
    for f_path in sorted(flows_dir.glob("*.json")):
        try:
            with open(f_path, "r", encoding="utf-8") as f:
                flow_data = json.load(f)
                flow_data["_app_id"] = app_id
                flows.append(flow_data)
        except Exception as e:
            logger.warning("Failed to parse flow blueprint %s: %s", f_path, e)
    return flows


def flow_cart_endpoint(flow: Dict[str, Any], profile: Dict[str, Any]) -> str:
    """A flow's cart URL, or the application-wide one it inherits."""
    return (flow.get("cart_endpoint") or (profile.get("endpoints") or {}).get("cart") or "").strip()


def selector_group(profile: Dict[str, Any], group: str) -> Dict[str, str]:
    """One named selector group from the profile, or {} when it declares none."""
    selectors = profile.get("selectors") or {}
    value = selectors.get(group)
    return value if isinstance(value, dict) else {}


def selector_list(profile: Dict[str, Any], group: str) -> List[str]:
    """A selector group flattened to a list, for the URL registry's shorthand."""
    selectors = profile.get("selectors") or {}
    value = selectors.get(group)
    if isinstance(value, dict):
        return [str(v) for v in value.values() if v]
    if isinstance(value, list):
        return [str(v) for v in value if v]
    if isinstance(value, str) and value:
        return [value]
    return []


def cookie_host_selector(profile: Dict[str, Any]) -> str:
    return ((profile.get("security_profile") or {}).get("cookie_overlay") or {}).get(
        "host_selector", ""
    ) or ""


def product_configuration_url(
    profile: Dict[str, Any],
    *,
    product_id: str = "",
    sku_id: str = "",
    category: str = "",
    product_name: str = "",
) -> str:
    """Render the profile's PDP template, or "" when it declares none."""
    template = (profile.get("url_templates") or {}).get("product_configuration")
    if not template:
        return ""
    rendered = render_template(
        template,
        {
            "product_id": product_id,
            "sku_id": sku_id,
            "category": category,
            "product_name": product_name,
            "base_url": profile.get("base_url", ""),
        },
    )
    return _strip_empty_params(rendered)


def match_flow_blueprint(
    query_or_url: str, app_id: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """Match a user query, BRD text, or URL against the registered Flow Blueprints."""
    text_lower = (query_or_url or "").lower().strip()

    direct_app = app_id
    if not direct_app and (query_or_url or "").strip():
        resolved = resolve_app_id(query_or_url)
        if resolved and load_app_profile(query_or_url):
            direct_app = resolved

    if direct_app:
        candidate_apps = [direct_app]
    else:
        all_apps = [a.get("app_id") for a in list_applications() if a.get("app_id")]
        candidate_apps = all_apps if all_apps else ([default_app_id()] if default_app_id() else [])

    best_match = None
    best_score = 0
    best_app_id = None

    for cand_app in candidate_apps:
        flows = list_flows(cand_app)
        profile = load_app_profile(cand_app) or {}
        common_words = {
            str(w).lower() for w in (profile.get("product_name_stopwords") or []) if w
        }

        for flow in flows:
            score = 0
            keywords = flow.get("target_match_keywords", [])
            for kw in keywords:
                kw_clean = kw.lower().strip()
                if not kw_clean:
                    continue
                if re.search(r"\b" + re.escape(kw_clean) + r"\b", text_lower):
                    num_words = len(kw_clean.split())
                    score += (4 * num_words)

            cat = flow.get("category", "").lower().strip()
            if cat and re.search(r"\b" + re.escape(cat) + r"\b", text_lower):
                score += 6

            for prod_name in flow.get("known_products", {}).keys():
                prod_clean = prod_name.lower().strip()
                if prod_clean in text_lower:
                    score += 20
                else:
                    words = [
                        w.lower()
                        for w in prod_clean.split()
                        if len(w) > 3 and w.lower() not in common_words
                    ]
                    for w in words:
                        if re.search(r"\b" + re.escape(w) + r"\b", text_lower):
                            score += 6

            if score > best_score:
                best_score = score
                best_match = flow
                best_app_id = cand_app

    if best_score > 0 and best_match:
        best_match["_app_id"] = best_app_id
        return best_match

    # Fallback to default flow of primary application
    fallback_app = direct_app or default_app_id()
    if fallback_app:
        fallback_profile = load_app_profile(fallback_app) or {}
        fallback_flows = list_flows(fallback_app)
        default_flow_id = fallback_profile.get("default_flow_id")
        if default_flow_id:
            for flow in fallback_flows:
                if flow.get("flow_id") == default_flow_id:
                    flow["_app_id"] = fallback_app
                    return flow
        if fallback_flows:
            fallback_flows[0]["_app_id"] = fallback_app
            return fallback_flows[0]

    return None


def build_flow_context_prompt(query_or_brd: str, app_id: Optional[str] = None) -> str:
    """Builds grounding context string to inject into LLM system prompt for test case generation."""
    flow = match_flow_blueprint(query_or_brd, app_id)
    if not flow:
        return ""

    matched_app_id = flow.get("_app_id") or app_id or resolve_app_id(query_or_brd) or default_app_id()
    app_prof = load_app_profile(matched_app_id) or {}
    app_name = app_prof.get("app_name") or matched_app_id or "the target application"
    base_url = app_prof.get("base_url", "")
    flow_name = flow.get("flow_name", "Standard Flow")
    category = flow.get("category", "")
    entrypoint = flow.get("catalog_entrypoint") or base_url
    cart_endpoint = flow_cart_endpoint(flow, app_prof)

    lines = [
        "",
        "================================================================================",
        "APPLICATION FLOW KNOWLEDGE BASE (GROUND TRUTH & URL SPECIFICATION)",
        "================================================================================",
        f"Target Application: {app_name} (Home URL: {base_url})",
        f"Domain/Category: {category} -> Flow: {flow_name}",
    ]
    if entrypoint:
        lines.append(f"Catalog Listing URL: {entrypoint}")
    if cart_endpoint:
        lines.append(f"Shopping Cart & Checkout Review URL: {cart_endpoint}")
    lines += ["", "CANONICAL STEP TRAVERSAL & REAL URL ROUTES:"]

    for s in flow.get("canonical_steps", []):
        s_num = s.get("step_number")
        action = s.get("action", "")
        target = s.get("target")
        if target and target.startswith("http"):
            lines.append(f"  {s_num}. {action} (URL: {target})")
        elif target and not target.startswith("http"):
            lines.append(f"  {s_num}. {action} (Target Selector: {target})")
        else:
            lines.append(f"  {s_num}. {action}")

    known_prods = flow.get("known_products", {})
    if known_prods:
        lines.append("")
        lines.append("REGISTERED PRODUCTS & DIRECT CONFIGURATION URLS:")
        for p_name, p_meta in list(known_prods.items())[:4]:
            pid = p_meta.get("productId", "")
            skuid = p_meta.get("skuId", "")
            price = p_meta.get("default_price", "Live")
            storage_list = p_meta.get("available_storage", [])
            color_list = p_meta.get("available_colors", [])
            plans_list = p_meta.get("payment_plans", [])

            direct_url = product_configuration_url(
                app_prof,
                product_id=pid,
                sku_id=skuid,
                category=category,
                product_name=p_name,
            )

            lines.append(f"• Product: {p_name}")
            if direct_url:
                lines.append(f"  - Direct Configuration URL: {direct_url}")
            lines.append(f"  - Identifiers: ProductId={pid}, SkuId={skuid}, Default Price={price}")
            if storage_list:
                lines.append(f"  - Storage Options: {', '.join(storage_list)}")
            if color_list:
                lines.append(f"  - Color Options: {', '.join(color_list)}")
            if plans_list:
                lines.append(f"  - Payment Options: {', '.join(plans_list[:2])}")

            td_parts = build_test_data_string(p_name, p_meta, app_prof)
            lines.append(f'  - Formatted Test Data: "{td_parts}"')

    # The instructions are the application's own, so a profile that describes a
    # banking portal does not get told to add devices to a cart. Rendered with
    # the same placeholders the URL templates use.
    directives = app_prof.get("generation_directives") or []
    matrix = app_prof.get("test_case_matrix") or []
    values = {
        "app_name": app_name,
        "base_url": base_url,
        "catalog_entrypoint": entrypoint,
        "cart_endpoint": cart_endpoint,
        "category": category,
        "product_configuration_url_template": (app_prof.get("url_templates") or {}).get(
            "product_configuration", ""
        ),
    }
    if directives:
        lines.append("")
        lines.append("CRITICAL INSTRUCTIONS FOR TEST CASE GENERATION:")
        for directive in directives:
            lines.append(render_template(str(directive), values))
    if matrix:
        lines.append("")
        lines.append("GENERATE A BALANCED MATRIX OF TEST CASES:")
        for entry in matrix:
            lines.append(f"   - {render_template(str(entry), values)}")

    lines.append("================================================================================")
    lines.append("")
    return "\n".join(lines)


def build_test_data_string(
    product_name: str, product_meta: Dict[str, Any], profile: Dict[str, Any]
) -> str:
    """The 'ProductId: x, SkuId: y, ...' string the compiler parses back out.

    Built from whichever variant axes the product actually declares, so a
    product with no storage options does not carry an empty 'Storage:' field.
    """
    parts = [
        f"Product: {product_name}",
        f"ProductId: {product_meta.get('productId', '')}",
        f"SkuId: {product_meta.get('skuId', '')}",
    ]
    storage = product_meta.get("available_storage") or []
    colors = product_meta.get("available_colors") or []
    plans = product_meta.get("payment_plans") or []
    if storage:
        parts.append(f"Storage: {storage[0]}")
    if colors:
        parts.append(f"Color: {colors[0]}")

    # `default_payment_plan` is the plan's *label*. A profile whose plan list
    # carries prices ("One time AED 4,299.00") wants the label here instead --
    # this string is a hint the generator copies into test data, and a price
    # baked into it goes stale the week after it is written.
    plan = profile.get("default_payment_plan") or (plans[0] if plans else "")
    if plan:
        parts.append(f"Payment: {plan}")
    return ", ".join(parts)


def resolve_product_config_url(
    text_or_data: str,
    flow: Optional[Dict[str, Any]] = None,
    profile: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    """Extract or resolve a product configuration URL from text or test data."""
    # 1. Check if raw text already has a configuration URL
    url_match = re.search(r"https?://[^\s'\"]+configuration[^\s'\"]*", text_or_data)
    if url_match:
        return url_match.group(0).rstrip(".,)")

    profile = profile or {}
    if not (profile.get("url_templates") or {}).get("product_configuration"):
        return None

    # 2. Check for ProductId and SkuId explicitly in test_data or text
    pid_match = re.search(r"ProductId:\s*([a-zA-Z0-9]+)", text_or_data, re.IGNORECASE)
    sku_match = re.search(r"SkuId:\s*([a-zA-Z0-9]+)", text_or_data, re.IGNORECASE)

    prod_id = pid_match.group(1) if pid_match else None
    sku_id = sku_match.group(1) if sku_match else None
    prod_name = ""

    # 3. Check known products in matched flow
    if flow and not prod_id:
        known = flow.get("known_products", {})
        for name, meta in known.items():
            haystack = text_or_data.lower()
            if name.lower() in haystack or any(
                w.lower() in haystack for w in name.split() if len(w) > 3
            ):
                prod_id = meta.get("productId")
                sku_id = meta.get("skuId")
                prod_name = name
                break

    if prod_id:
        return product_configuration_url(
            profile,
            product_id=prod_id,
            sku_id=sku_id or "",
            category=(flow or {}).get("category", ""),
            product_name=prod_name,
        )

    return None


def ground_case_structured_steps(
    case: Any, app_id: Optional[str] = None
) -> List[Dict[str, Any]]:
    """Ground structured steps of a test case using Knowledge Base Blueprints.

    Matches steps against the flow blueprint's canonical steps and step_grounding_rules,
    substituting live product/plan identifiers and verified URLs/selectors.
    """
    full_text = (
        f"{getattr(case, 'description', '')} {getattr(case, 'objective', '')} "
        f"{getattr(case, 'steps_raw', '')} {getattr(case, 'test_data', '')}"
    )
    flow = match_flow_blueprint(full_text, app_id)
    matched_app_id = (flow.get("_app_id") if flow else None) or app_id or resolve_app_id(full_text) or default_app_id()
    profile = load_app_profile(matched_app_id) or {}

    steps = list(getattr(case, "steps_structured", []) or [])
    if not steps and getattr(case, "steps_raw", None):
        from .eligibility import split_steps
        raw_s = split_steps(case.steps_raw)
        steps = [
            {
                "step_number": i + 1,
                "action": s,
                "target": None,
                "test_data_ref": None,
                "expected_result": None,
            }
            for i, s in enumerate(raw_s)
        ]

    base_url = profile.get("base_url", "")
    catalog_entry = (flow or {}).get("catalog_entrypoint", "") or ""
    cart_endpoint = flow_cart_endpoint(flow or {}, profile)
    config_url = resolve_product_config_url(full_text, flow, profile) or ""
    
    known_prods = (flow or {}).get("known_products", {})
    matched_prod_name = None
    matched_prod_meta = {}
    full_text_lower = full_text.lower()
    for p_name, p_meta in known_prods.items():
        if p_name.lower() in full_text_lower:
            matched_prod_name = p_name
            matched_prod_meta = p_meta
            break

    substitutions = {
        "base_url": base_url,
        "catalog_entrypoint": catalog_entry,
        "cart_endpoint": cart_endpoint,
        "product_configuration_url": config_url or catalog_entry,
        # Route forms of the same four. A blueprint written against these
        # compiles to in-app navigation; one written against the absolute
        # variants above still works, because the step target is downgraded to
        # a route on the way out regardless.
        "base_route": "/",
        "catalog_route": to_route(catalog_entry, base_url),
        "cart_route": to_route(cart_endpoint, base_url),
        "product_configuration_route": to_route(config_url or catalog_entry, base_url),
        "cookie_host_selector": cookie_host_selector(profile),
        "plan_name": matched_prod_name or "",
        "product_name": matched_prod_name or "",
        "product_id": matched_prod_meta.get("productId", ""),
        "rate_plan_id": matched_prod_meta.get("ratePlanId", "") or matched_prod_meta.get("productId", ""),
        "sku_id": matched_prod_meta.get("skuId", ""),
        "price": matched_prod_meta.get("default_price", ""),
    }

    canonical_steps = (flow or {}).get("canonical_steps", [])
    rules = profile.get("step_grounding_rules") or []

    grounded_steps = []
    for i, st in enumerate(steps):
        s_num = st.get("step_number") or (i + 1)
        action = str(st.get("action") or "").strip()
        target = st.get("target")
        act_lower = action.lower()
        # The href of the in-app link that reaches this step's destination,
        # when the blueprint or the crawl recorded one. The compiler prefers
        # clicking it over navigating, so the journey stays inside the app.
        href_hint = str(st.get("href") or "").strip()

        if not target:
            # 0. If step action explicitly provides a URL, use it directly
            url_m = re.search(r"https?://[^\s\)\"\'\>]+", action)
            if url_m:
                target = url_m.group(0).rstrip(".,)")

        if not target:
            # 1. Try matching against canonical steps of the flow
            best_cs = None
            best_cs_score = 0
            for cs in canonical_steps:
                cs_action = str(cs.get("action") or "").lower()
                cs_rendered = cs_action
                for k, v in substitutions.items():
                    cs_rendered = cs_rendered.replace("{{" + k + "}}", str(v).lower()).replace("{" + k + "}", str(v).lower())
                
                score = 0
                if ("{{plan_name}}" in cs_action or "{{product_name}}" in cs_action) and matched_prod_name and (matched_prod_name.lower() in act_lower):
                    score += 5
                
                if any(v in cs_action for v in ["select", "choose"]) and any(v in act_lower for v in ["select", "choose"]):
                    score += 3
                if any(v in cs_action for v in ["buy now", "checkout", "add to cart"]) and any(v in act_lower for v in ["buy now", "checkout", "add to cart", "buy"]):
                    score += 4
                if any(v in cs_action for v in ["tab", "local", "international"]) and any(v in act_lower for v in ["tab", "local", "international"]):
                    score += 4
                if any(v in cs_action for v in ["cookie", "privacy", "banner", "usercentrics"]) and any(v in act_lower for v in ["cookie", "privacy", "banner"]):
                    score += 6
                if any(v in cs_action for v in ["verify", "ordering", "verification", "display"]) and any(v in act_lower for v in ["verify", "ordering", "verification", "display"]):
                    score += 4
                if any(v in cs_action for v in ["navigate", "open", "homepage"]) and any(v in act_lower for v in ["navigate", "open", "homepage"]):
                    score += 3

                cs_words = set(re.findall(r"[a-z0-9]+", cs_rendered)) - {"navigate", "to", "the", "and", "for", "in", "if", "a", "on", "with", "plans", "plan"}
                act_words = set(re.findall(r"[a-z0-9]+", act_lower)) - {"navigate", "to", "the", "and", "for", "in", "if", "a", "on", "with", "plans", "plan"}
                overlap = len(cs_words.intersection(act_words))
                score += overlap * 2

                if score > best_cs_score:
                    best_cs_score = score
                    best_cs = cs

            if best_cs and best_cs_score >= 3:
                cs_target = best_cs.get("target") or ""
                for k, v in substitutions.items():
                    cs_target = cs_target.replace("{{" + k + "}}", str(v)).replace("{" + k + "}", str(v))
                if cs_target:
                    target = cs_target
                if not href_hint:
                    href_hint = render_template(best_cs.get("href"), substitutions).strip()

        if not target:
            # 2. Try matching profile step_grounding_rules
            for rule in rules:
                keywords = [str(k).lower() for k in (rule.get("keywords") or [])]
                matched = any(k in act_lower for k in keywords)
                if not matched and rule.get("first_step_only") and i == 0:
                    matched = True
                if not matched and rule.get("match_known_products"):
                    matched = any(p.lower() in act_lower for p in known_prods.keys())
                if not matched:
                    continue
                rendered = render_template(rule.get("target"), substitutions).strip()
                if rendered:
                    target = rendered
                if not href_hint:
                    href_hint = render_template(rule.get("href"), substitutions).strip()
                break

        # Downgrade to a route last, once the target is settled, so it applies
        # to all four sources above -- the step's own target, a URL written into
        # the action, a canonical step and a grounding rule -- rather than
        # having to be repeated at each. Cross-origin URLs and selectors pass
        # through untouched.
        target = to_route(target, base_url)

        grounded_steps.append({
            "step_number": s_num,
            "action": action,
            "target": target,
            "href": to_route(href_hint, base_url) or None,
            "test_data_ref": st.get("test_data_ref"),
            "expected_result": st.get("expected_result")
        })

    return grounded_steps


def build_application_model(app_id: Optional[str] = None) -> Dict[str, Any]:
    """
    Constructs the comprehensive Application Model in JSON structure from the Knowledge Base.
    Compiles application profile, flow blueprints, full URL registry with parameter details,
    component selectors, known product catalog with direct configuration URLs, and navigation graphs.

    A pure compiler over the profile and its flows: every URL and selector below
    comes from the Knowledge Base. An application that declares no PDP template
    gets a model with no product configuration URLs, rather than a plausible
    document pointing at someone else's site.
    """
    app_id = app_id or default_app_id() or ""
    profile = load_app_profile(app_id) or {
        "app_id": app_id,
        "app_name": f"{app_id} Web Portal" if app_id else "Unregistered application",
        "base_url": "",
        "domain": "",
        "framework": "Web Application",
    }

    flows = list_flows(profile.get("app_id") or app_id)
    base_url = profile.get("base_url", "")
    domain = profile.get("domain", "")
    app_name = profile.get("app_name", "")

    # 1. URL Registry Compilation
    url_registry: List[Dict[str, Any]] = []
    seen_urls = set()

    def _add_url(url: str, url_type: str, category: str, name: str, description: str, query_params: Optional[Dict[str, Any]] = None, selectors: Optional[List[str]] = None):
        if not url or url in seen_urls:
            return
        seen_urls.add(url)
        # A profile may declare either form now. The registry carries both: the
        # route is what a compiled script navigates by, the absolute URL is what
        # a person clicks on the Discovery screen.
        url_registry.append({
            "url": absolutize(url, base_url) or url,
            "route": to_route(url, base_url),
            "url_type": url_type,
            "category": category,
            "name": name,
            "description": description,
            "query_parameters": query_params or {},
            "associated_selectors": [s for s in (selectors or []) if s]
        })

    # Add Base / Home URL
    if base_url:
        homepage_selectors = [
            cookie_host_selector(profile),
            (profile.get("search_mechanism") or {}).get("trigger_selector", ""),
        ] + selector_list(profile, "homepage")
        _add_url(
            url=base_url,
            url_type="Homepage",
            category="General",
            name="Portal Homepage",
            description=f"Main landing page for {app_name or 'the application'}.",
            query_params=parse_query_params(base_url),
            selectors=homepage_selectors,
        )

    # Compile Flows, Pages, and Catalog Products
    enriched_flows = []
    products_catalog: Dict[str, List[Dict[str, Any]]] = {}
    navigation_nodes = [{"id": "homepage", "label": "Portal Homepage", "url": base_url, "type": "entrypoint"}]
    navigation_edges = []
    seen_nodes = {"homepage"}

    catalog_selectors = selector_list(profile, "catalog")
    pdp_selectors = selector_list(profile, "product_configuration")
    cart_selectors = selector_list(profile, "cart")

    for flow in flows:
        f_id = flow.get("flow_id", "")
        f_name = flow.get("flow_name", "")
        cat = flow.get("category", "General")
        entrypoint = flow.get("catalog_entrypoint", "")
        cart_endpoint = flow_cart_endpoint(flow, profile)

        # Add Catalog Entrypoint URL
        if entrypoint:
            _add_url(
                url=entrypoint,
                url_type="Catalog_Listing",
                category=cat,
                name=f"{cat} Catalog Listing",
                description=f"Product listing page for the {cat} category.",
                query_params=parse_query_params(entrypoint),
                selectors=catalog_selectors,
            )
            cat_node_id = f"catalog_{cat.lower()}"
            if cat_node_id not in seen_nodes:
                seen_nodes.add(cat_node_id)
                navigation_nodes.append({
                    "id": cat_node_id,
                    "label": f"{cat} Catalog",
                    "url": entrypoint,
                    "type": "catalog"
                })
                navigation_edges.append({
                    "from": "homepage",
                    "to": cat_node_id,
                    "action": f"navigate_{cat.lower()}_catalog",
                    "trigger_locator": render_template(
                        (profile.get("url_templates") or {}).get(
                            "catalog_link_locator", "a[href*='{category_slug}']"
                        ),
                        {"category_slug": cat.lower(), "category": cat},
                    ),
                })

        # Add Cart Endpoint URL
        if cart_endpoint:
            _add_url(
                url=cart_endpoint,
                url_type="Cart_Checkout",
                category="Checkout",
                name="Shopping Cart & Checkout Review",
                description="Cart review screen showing the selected items and the checkout CTA.",
                query_params=parse_query_params(cart_endpoint),
                selectors=cart_selectors,
            )
            cart_node_id = "shopping_cart"
            if cart_node_id not in seen_nodes:
                seen_nodes.add(cart_node_id)
                navigation_nodes.append({
                    "id": cart_node_id,
                    "label": "Shopping Cart",
                    "url": cart_endpoint,
                    "type": "cart"
                })

        # Process Known Products
        known_prods = flow.get("known_products", {})
        flow_product_list = []
        for p_name, p_meta in known_prods.items():
            pid = p_meta.get("productId", "")
            skuid = p_meta.get("skuId", "")
            price = p_meta.get("default_price", "Live")
            storages = p_meta.get("available_storage", [])
            colors = p_meta.get("available_colors", [])
            plans = p_meta.get("payment_plans", [])
            addons = p_meta.get("optional_addons", [])

            direct_url = product_configuration_url(
                profile, product_id=pid, sku_id=skuid, category=cat, product_name=p_name
            )

            # Add Direct Product Config URL to Registry
            if direct_url:
                _add_url(
                    url=direct_url,
                    url_type="Product_Configuration",
                    category=cat,
                    name=f"{p_name} Configuration Page",
                    description=f"Product detail and configuration page for {p_name}.",
                    query_params=parse_query_params(direct_url),
                    selectors=pdp_selectors,
                )

            prod_entry = {
                "product_name": p_name,
                "product_id": pid,
                "sku_id": skuid,
                "category": cat,
                "default_price": price,
                # Absolute for display and for a person to click; the route
                # beside it is what a compiled script navigates by.
                "direct_configuration_url": absolutize(direct_url, base_url) or direct_url,
                "direct_configuration_route": to_route(direct_url, base_url),
                "available_storage": storages,
                "available_colors": colors,
                "payment_plans": plans,
                "optional_addons": addons,
                "sample_test_data_string": build_test_data_string(p_name, p_meta, profile),
            }
            flow_product_list.append(prod_entry)

        if cat not in products_catalog:
            products_catalog[cat] = []
        products_catalog[cat].extend(flow_product_list)

        # Append graph edges from flow if specified
        for edge in flow.get("graph_edges", []):
            navigation_edges.append(edge)

        # Enriched flow entry
        enriched_flows.append({
            "flow_id": f_id,
            "flow_name": f_name,
            "category": cat,
            "target_match_keywords": flow.get("target_match_keywords", []),
            "catalog_entrypoint_url": absolutize(entrypoint, base_url) or entrypoint,
            "catalog_entrypoint_route": to_route(entrypoint, base_url),
            "cart_endpoint_url": absolutize(cart_endpoint, base_url) or cart_endpoint,
            "cart_endpoint_route": to_route(cart_endpoint, base_url),
            "automation_boundary": flow.get("automation_boundary")
            or profile.get("default_automation_boundary")
            or {},
            "canonical_steps": flow.get("canonical_steps", []),
            "graph_edges": flow.get("graph_edges", []),
            "registered_products": flow_product_list
        })

    # 2. Page and Component Models
    page_models = {
        "homepage": {
            "page_name": "Portal Homepage",
            "url": base_url,
            "components": {
                "cookie_overlay": (profile.get("security_profile") or {}).get("cookie_overlay", {}),
                "search_bar": profile.get("search_mechanism", {}),
                "navigation_header": {
                    "selector": (profile.get("selectors") or {}).get("navigation_header", ""),
                    "categories": list(products_catalog.keys())
                }
            }
        },
        "catalogs": {
            cat_name: {
                "category": cat_name,
                "catalog_url": next((f.get("catalog_entrypoint") for f in flows if f.get("category") == cat_name), ""),
                "components": selector_group(profile, "catalog")
            }
            for cat_name in products_catalog.keys()
        },
        "product_configuration": {
            "url_template": (profile.get("url_templates") or {}).get("product_configuration", ""),
            "components": selector_group(profile, "product_configuration")
        },
        "shopping_cart": {
            "url": (profile.get("endpoints") or {}).get("cart", ""),
            "components": selector_group(profile, "cart")
        }
    }

    # 3. Compile Master Application Model
    app_model = {
        "model_version": MODEL_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "application_info": {
            "app_id": profile.get("app_id", app_id),
            "app_name": app_name,
            "base_url": base_url,
            "domain": domain,
            "framework": profile.get("framework", "Web Application"),
            "default_viewport": profile.get("default_viewport", {"width": 1440, "height": 900}),
            "security_profile": profile.get("security_profile", {}),
            "search_mechanism": profile.get("search_mechanism", {})
        },
        "summary": {
            "total_flows": len(enriched_flows),
            "total_categories": len(products_catalog),
            "total_known_products": sum(len(prods) for prods in products_catalog.values()),
            "total_registered_urls": len(url_registry),
            "total_canonical_steps": sum(len(f.get("canonical_steps", [])) for f in enriched_flows)
        },
        "url_registry": url_registry,
        "page_models": page_models,
        "flows": enriched_flows,
        "products_catalog": products_catalog,
        "navigation_graph": {
            "nodes": navigation_nodes,
            "edges": navigation_edges
        }
    }

    return app_model


def export_application_model_json(app_id: Optional[str] = None, output_path: Optional[str | Path] = None, indent: int = 2) -> str:
    """Builds and exports the Application Model to a JSON string or writes to a file."""
    model = build_application_model(app_id)
    json_str = json.dumps(model, indent=indent, ensure_ascii=False)
    if output_path:
        out_file = Path(output_path)
        out_file.parent.mkdir(parents=True, exist_ok=True)
        with open(out_file, "w", encoding="utf-8") as f:
            f.write(json_str)
        logger.info("Application model successfully exported to %s", out_file)
    return json_str


# --- Automation Module: turning a crawl into a Knowledge Base draft ----------
#
# Discovery and the Knowledge Base were two systems that never met. The crawler
# wrote rows to automation_discovered_elements; the Knowledge Base was files
# somebody typed. So a crawl that catalogued 476 controls moved exactly one
# number on the screen -- "Live Elements Discovered" -- and the three counts
# beside it, which are compiled from the files, sat unchanged. Nothing was
# broken; the two halves simply had no seam.
#
# This is the seam, and it goes one way on purpose: a crawl proposes files, a
# human decides. What a crawler can honestly derive is narrow -- the URLs it
# reached, the controls it verified, whether the app has a search box. It
# cannot derive a flow's intent, a product's identifiers, or which of forty
# controls is the "Add to cart" one. So the draft writes down what it saw,
# names what it could not work out, and never overwrites a hand-authored file
# unless asked in as many words.

DRAFT_FLOW_PREFIX = "flow_discovered_v"

# What a human still has to supply. Listed in the draft itself rather than in
# documentation nobody reads at the moment they need it.
DRAFT_REVIEW_NOTES = [
    "url_templates.product_configuration: the PDP/detail URL shape, with "
    "{product_id} / {sku_id} / {category} placeholders.",
    "endpoints.cart: the cart or review URL, if this application has one.",
    "selectors.catalog / selectors.product_configuration / selectors.cart: "
    "promote the useful entries out of discovered_selectors below. That block "
    "is raw material -- nothing compiles from it until you move entries into "
    "a named selectors group.",
    "step_grounding_rules: keyword -> target rules, evaluated in order.",
    "flows/*.json known_products: real product identifiers; a crawl cannot "
    "infer them.",
]


def _kb_dir_for(app_key: str) -> Path:
    return KB_ROOT_DIR / app_key


def _host_of(url: str) -> str:
    match = re.match(r"https?://([^/:]+)", url or "")
    return match.group(1) if match else ""


def _search_mechanism_from(elements: List[Dict[str, Any]]) -> Dict[str, Any]:
    """A search box, if the crawl verified one.

    One of the few things a crawl can state rather than guess: the locator was
    checked to resolve uniquely before it was catalogued.
    """
    for element in elements:
        role = (element.get("role") or "").lower()
        name = (element.get("accessible_name") or "").lower()
        if role == "searchbox" or (role == "textbox" and "search" in name):
            return {
                "input_selector": element.get("recommended_locator", ""),
                "_derived_from": "Application Discovery crawl",
            }
    return {}


def _discovered_selectors(elements: List[Dict[str, Any]], per_page: int = 25) -> Dict[str, Any]:
    """Verified locators, grouped by the page they were found on.

    Deliberately not written into `selectors`, which the model compiler reads:
    these are raw material, and a page's forty controls are not a selector
    group. Kept beside it so promoting the useful ones is an edit, not research.
    """
    by_page: Dict[str, List[Dict[str, Any]]] = {}
    for element in elements:
        page = element.get("page_url") or ""
        by_page.setdefault(page, []).append(element)

    grouped: Dict[str, Any] = {}
    for page, items in by_page.items():
        items = sorted(
            items, key=lambda e: (-(e.get("confidence_score") or 0), e.get("element_name") or "")
        )[:per_page]
        grouped[page] = {
            (item.get("element_name") or f"element_{index}"): item.get("recommended_locator", "")
            for index, item in enumerate(items)
        }
    return grouped


def build_draft_profile(
    *,
    app_key: str,
    app_name: str,
    base_url: str,
    pages: List[Dict[str, Any]],
    elements: List[Dict[str, Any]],
    blockers: List[Dict[str, Any]],
    crawl_version: int,
    synthesis: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """An app_profile.json a human can edit into a real one.

    `synthesis` is an optional proposal from kb_synthesis: the crawl's facts
    classified into the keys the model compiler reads. It is merged in below
    rather than written over the structural draft, so a failed or absent
    synthesis leaves exactly the draft this function produced before it existed.
    """
    proposal = (synthesis or {}).get("proposal") or {}

    profile: Dict[str, Any] = {
        "app_id": app_key,
        "app_name": app_name,
        "base_url": base_url,
        "domain": _host_of(base_url),
        "framework": proposal.get("framework") or "Web Application",
        "default_viewport": {"width": 1440, "height": 900},
    }

    search = _search_mechanism_from(elements)
    if search:
        profile["search_mechanism"] = search

    # --- The synthesised half -------------------------------------------
    # Every value here survived validation against the crawl in kb_synthesis:
    # a selector it never verified and a route it never reached are already
    # gone. What is left is a classification of crawled facts, which is still a
    # judgement -- hence _draft below, and hence the dropped list recorded with
    # it, so a reviewer can see what the model proposed and lost.
    if proposal.get("url_templates"):
        profile["url_templates"] = dict(proposal["url_templates"])
    if proposal.get("endpoints"):
        profile["endpoints"] = dict(proposal["endpoints"])
    if proposal.get("selectors"):
        profile["selectors"] = {
            group: dict(entries) for group, entries in proposal["selectors"].items()
        }
    if proposal.get("cookie_overlay_selector"):
        profile["security_profile"] = {
            "cookie_overlay": {
                "type": "consent_banner",
                "host_selector": proposal["cookie_overlay_selector"],
                "_derived_from": "Application Discovery crawl",
            }
        }
    if proposal.get("step_grounding_rules"):
        profile["step_grounding_rules"] = list(proposal["step_grounding_rules"])

    # The routes the crawl walked are not repeated here: they are the draft
    # flow's canonical steps, with the HTTP status each returned. One record of
    # a fact, in the place the compiler actually reads it.
    profile["discovered_selectors"] = _discovered_selectors(elements)
    profile["_draft"] = {
        "generated_by": f"Application Discovery crawl v{crawl_version}",
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "pages_crawled": len(pages),
        "elements_catalogued": len(elements),
        "pages_blocked": len(blockers),
        "status": "DRAFT -- review before relying on it for grounding.",
        # Only list what synthesis did not fill in. Telling a reviewer to supply
        # url_templates when the draft already carries one is how a review note
        # trains people to skip review notes.
        "still_needed": [
            note for note in DRAFT_REVIEW_NOTES
            if not _draft_note_satisfied(note, profile)
        ],
    }
    if synthesis:
        profile["_draft"]["synthesis"] = {
            "pages_considered": synthesis.get("pages_considered"),
            "locators_considered": synthesis.get("locators_considered"),
            "notes": (proposal.get("notes") or []),
            # What the model proposed and the crawl would not vouch for. Kept
            # because a long list here is the signal that the crawl was too
            # shallow, not that the model was wrong.
            "rejected": synthesis.get("dropped") or [],
        }
    return profile


# Each review note opens with the profile key it is about, so the key is what
# decides whether the note still applies.
def _draft_note_satisfied(note: str, profile: Dict[str, Any]) -> bool:
    head = note.split(":", 1)[0]
    for path in (part.strip() for part in head.split("/")):
        if not path:
            continue
        cursor: Any = profile
        for segment in path.split("."):
            if not isinstance(cursor, dict) or not cursor.get(segment):
                return False
            cursor = cursor[segment]
    return True


def build_draft_flow(
    *,
    base_url: str,
    pages: List[Dict[str, Any]],
    crawl_version: int,
) -> Dict[str, Any]:
    """A flow blueprint skeleton: the route the crawl actually walked.

    Every step is a page the crawler reached and got a response from, so the
    URLs are real even though the journey they describe is not one a person
    chose. That is the point of a skeleton -- reordering and naming real steps
    is quicker than typing URLs out of a browser bar.
    """
    steps = []
    for index, page in enumerate(pages, start=1):
        title = (page.get("title") or "").strip() or page.get("url", "")
        # The route, not the absolute URL the crawler happened to resolve. The
        # compiler navigates relative to `use.baseURL`, so a blueprint written
        # in routes runs unchanged against SIT, QA and UAT -- and the `href`
        # beside it lets the script click the application's own link instead of
        # deep-linking, which is what keeps the session alive between steps.
        route = to_route(page.get("url", ""), base_url)
        href = to_route(page.get("via_href") or "", base_url)
        link_text = (page.get("via_text") or "").strip()
        action = (
            f"Click '{link_text}' to reach {title}" if link_text and href
            else f"Navigate to {title}"
        )
        steps.append({
            "step_number": index,
            "action": action,
            "target": route,
            "href": href or None,
            "expected_result": f"{title} loads (HTTP {page.get('status')} when crawled).",
        })

    return {
        "flow_id": f"{DRAFT_FLOW_PREFIX}{crawl_version}",
        "flow_name": f"Discovered walkthrough (draft, crawl v{crawl_version})",
        "category": "Discovered",
        "target_match_keywords": [],
        "catalog_entrypoint": base_url,
        "canonical_steps": steps,
        "known_products": {},
        "graph_edges": [],
        "_draft": {
            "generated_by": f"Application Discovery crawl v{crawl_version}",
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "status": (
                "DRAFT -- the steps are pages the crawler reached, in the order it "
                "reached them, not a journey anybody designed. Rename, reorder, "
                "delete what is noise, and add known_products before using it."
            ),
        },
    }


SYNTH_FLOW_PREFIX = "flow_synth_v"


def build_synthesised_flow(
    flow: Dict[str, Any],
    *,
    crawl_version: int,
    ordinal: int,
    base_url: str,
) -> Dict[str, Any]:
    """One model-proposed journey, in blueprint shape.

    The steps arrive already validated against the crawl, so this is a rename
    into the schema `list_flows` reads -- plus the `_draft` stamp, because a
    journey inferred from a crawl order is a plausible reading of the pages,
    not a journey a person designed.
    """
    slug = re.sub(r"[^a-z0-9]+", "_", (flow.get("flow_name") or "").lower()).strip("_")
    steps = []
    for step in flow.get("canonical_steps") or []:
        steps.append({
            "step_number": step.get("step_number"),
            "action": step.get("action") or "",
            "target": step.get("target") or "",
            "href": step.get("href") or None,
            "expected_result": step.get("expected_result") or "",
        })

    return {
        "flow_id": f"{SYNTH_FLOW_PREFIX}{crawl_version}_{slug or ordinal}",
        "flow_name": flow.get("flow_name") or f"Synthesised flow {ordinal}",
        "category": flow.get("category") or "Discovered",
        "target_match_keywords": [
            str(k).lower() for k in (flow.get("target_match_keywords") or [])
        ],
        "catalog_entrypoint": flow.get("catalog_entrypoint_route") or "",
        "canonical_steps": steps,
        # A crawl cannot know a product identifier -- it sees a listing, not a
        # catalogue API -- so this stays empty for a person to fill.
        "known_products": {},
        "graph_edges": [],
        "_draft": {
            "generated_by": f"Knowledge Base synthesis over crawl v{crawl_version}",
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "status": (
                "DRAFT -- a model's reading of the crawled pages. Every route and "
                "selector below was verified by the crawl, but the journey they "
                "describe was inferred. Check the order, then add known_products."
            ),
        },
    }


def write_draft_from_crawl(
    *,
    app_key: str,
    app_name: str,
    base_url: str,
    pages: List[Dict[str, Any]],
    elements: List[Dict[str, Any]],
    blockers: List[Dict[str, Any]],
    crawl_version: int,
    overwrite_profile: bool = False,
    synthesise: bool = True,
) -> Dict[str, Any]:
    """Write a Knowledge Base draft for one application, and say what it did.

    `app_profile.json` is only written when absent, or when overwrite is asked
    for explicitly: for an application anybody has curated, that file is the
    ground truth the whole module compiles from, and a crawl is not entitled to
    replace it. The flow is written under a version-stamped name, so it can
    never collide with a hand-authored blueprint either.
    """
    kb_dir = _kb_dir_for(app_key)
    written: List[str] = []
    skipped: List[Dict[str, str]] = []

    # Classify the crawl before writing anything. A failure here is not fatal:
    # `synthesise` returns None and every writer below falls back to the plain
    # structural draft, which is what this function produced before synthesis
    # existed. Imported here rather than at module scope because kb_synthesis
    # reads this module's route helpers.
    synthesis: Optional[Dict[str, Any]] = None
    if synthesise:
        from . import kb_synthesis

        synthesis = kb_synthesis.synthesise(
            app_name=app_name, base_url=base_url, pages=pages, elements=elements
        )

    try:
        (kb_dir / "flows").mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise PermissionError(
            f"The Knowledge Base at {kb_dir} is not writable ({exc}). In a container "
            f"the baked-in copy is read-only; bind-mount a writable directory and "
            f"point AUTOMATION_KB_PATH at it."
        ) from exc

    def _write(path: Path, payload: Dict[str, Any]) -> None:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        written.append(str(path))

    profile_path = kb_dir / "app_profile.json"
    if profile_path.exists() and not overwrite_profile:
        skipped.append({
            "path": str(profile_path),
            "reason": (
                "A profile already exists and was left alone. Re-run with "
                "overwrite_profile to replace it -- the existing one is what "
                "every model, prompt and grounding rule compiles from."
            ),
        })
    else:
        _write(
            profile_path,
            build_draft_profile(
                app_key=app_key,
                app_name=app_name,
                base_url=base_url,
                pages=pages,
                elements=elements,
                blockers=blockers,
                crawl_version=crawl_version,
                synthesis=synthesis,
            ),
        )

    flow_path = kb_dir / "flows" / f"{DRAFT_FLOW_PREFIX}{crawl_version}.json"
    if pages:
        _write(flow_path, build_draft_flow(
            base_url=base_url, pages=pages, crawl_version=crawl_version
        ))
    else:
        skipped.append({
            "path": str(flow_path),
            "reason": "The crawl reached no pages, so there is no route to write down.",
        })

    # Synthesised flows are written beside the structural one, not instead of
    # it. The structural flow is the crawl's own record and is always true; a
    # synthesised flow is a reading of it, and keeping both lets a reviewer see
    # what was read into what.
    for index, flow in enumerate((synthesis or {}).get("proposal", {}).get("flows") or [], 1):
        payload = build_synthesised_flow(
            flow, crawl_version=crawl_version, ordinal=index, base_url=base_url
        )
        _write(kb_dir / "flows" / f"{payload['flow_id']}.json", payload)

    logger.info(
        "Knowledge Base draft for %s: wrote %d file(s), skipped %d",
        app_key, len(written), len(skipped),
    )
    return {
        "app_key": app_key,
        "kb_dir": str(kb_dir),
        "written": written,
        "skipped": skipped,
        "pages_crawled": len(pages),
        "elements_catalogued": len(elements),
        "pages_blocked": len(blockers),
        # Null when synthesis was not asked for, and when it was asked for but
        # no model could be reached -- the caller can tell "off" from "tried and
        # could not", which matters because the second is worth fixing.
        "synthesis": None if synthesis is None else {
            "requested": True,
            "rejected": synthesis.get("dropped") or [],
            "notes": (synthesis.get("proposal") or {}).get("notes") or [],
            "flows_proposed": len((synthesis.get("proposal") or {}).get("flows") or []),
        },
        "synthesis_requested": bool(synthesise),
    }
