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


def load_app_profile(app_id_or_domain: str = "eand_ae") -> Optional[Dict[str, Any]]:
    """Load application profile by ID or domain."""
    if not KB_ROOT_DIR.exists():
        return None

    # Try direct folder match
    app_dir = KB_ROOT_DIR / app_id_or_domain
    if app_dir.exists() and (app_dir / "app_profile.json").exists():
        with open(app_dir / "app_profile.json", "r", encoding="utf-8") as f:
            return json.load(f)

    # Search by domain or app_id inside profiles
    for sub in KB_ROOT_DIR.iterdir():
        if sub.is_dir() and (sub / "app_profile.json").exists():
            try:
                with open(sub / "app_profile.json", "r", encoding="utf-8") as f:
                    prof = json.load(f)
                    if prof.get("app_id") == app_id_or_domain or prof.get("domain") in app_id_or_domain or prof.get("base_url") in app_id_or_domain:
                        return prof
            except Exception:
                pass
    return None


def list_flows(app_id: str = "eand_ae") -> List[Dict[str, Any]]:
    """List all flow blueprints for an application."""
    flows_dir = KB_ROOT_DIR / app_id / "flows"
    if not flows_dir.exists():
        return []

    flows = []
    for f_path in flows_dir.glob("*.json"):
        try:
            with open(f_path, "r", encoding="utf-8") as f:
                flow_data = json.load(f)
                flows.append(flow_data)
        except Exception as e:
            logger.warning("Failed to parse flow blueprint %s: %s", f_path, e)
    return flows


def match_flow_blueprint(query_or_url: str, app_id: str = "eand_ae") -> Optional[Dict[str, Any]]:
    """Match a user query, BRD text, or URL against the registered Flow Blueprints."""
    flows = list_flows(app_id)
    if not flows:
        return None

    text_lower = (query_or_url or "").lower().strip()

    best_match = None
    best_score = 0

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
                words = [w.lower() for w in prod_clean.split() if len(w) > 3 and w.lower() not in ["apple", "samsung", "huawei", "marshall", "honor"]]
                for w in words:
                    if re.search(r"\b" + re.escape(w) + r"\b", text_lower):
                        score += 6

        if score > best_score:
            best_score = score
            best_match = flow

    if best_score > 0 and best_match:
        return best_match

    # Default to Smartphones flow as primary device flow if present
    for flow in flows:
        if flow.get("flow_id") == "flow_smartphones_purchase" or flow.get("category", "").lower() == "smartphones":
            return flow

    return flows[0] if flows else None


def build_flow_context_prompt(query_or_brd: str, app_id: str = "eand_ae") -> str:
    """Builds grounding context string to inject into LLM system prompt for test case generation."""
    flow = match_flow_blueprint(query_or_brd, app_id)
    if not flow:
        return ""

    app_prof = load_app_profile(app_id) or {}
    app_name = app_prof.get("app_name", "e& UAE Web Portal")
    base_url = app_prof.get("base_url", "https://www.eand.ae/en/index.html")
    flow_name = flow.get("flow_name", "Standard Flow")
    category = flow.get("category", "Smartphones")
    entrypoint = flow.get("catalog_entrypoint", base_url)
    cart_endpoint = flow.get("cart_endpoint", "https://www.eand.ae/eshop/checkout/cart")

    lines = [
        "",
        "================================================================================",
        "APPLICATION FLOW KNOWLEDGE BASE (GROUND TRUTH & URL SPECIFICATION)",
        "================================================================================",
        f"Target Application: {app_name} (Home URL: {base_url})",
        f"Domain/Category: {category} -> Flow: {flow_name}",
        f"Catalog Listing URL: {entrypoint}",
        f"Shopping Cart & Checkout Review URL: {cart_endpoint}",
        "",
        "CANONICAL STEP TRAVERSAL & REAL URL ROUTES:"
    ]

    for s in flow.get("canonical_steps", []):
        s_num = s.get("step_number")
        action = s.get("action", "")
        target = s.get("target")
        if target and target.startswith("http"):
            lines.append(f"  {s_num}. {action} (URL: {target})")
        elif target and target.startswith("#"):
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
            
            sku_part = f"&skuId={skuid}" if skuid else ""
            direct_url = f"https://www.eand.ae/eshop/devices/configuration?productId={pid}{sku_part}&catName={category}&listVal=Smartphones&showDefault=true"
            
            lines.append(f"• Product: {p_name}")
            lines.append(f"  - Direct Configuration URL: {direct_url}")
            lines.append(f"  - Identifiers: ProductId={pid}, SkuId={skuid}, Default Price={price}")
            if storage_list:
                lines.append(f"  - Storage Options: {', '.join(storage_list)}")
            if color_list:
                lines.append(f"  - Color Options: {', '.join(color_list)}")
            if plans_list:
                lines.append(f"  - Payment Options: {', '.join(plans_list[:2])}")
            
            first_storage = storage_list[0] if storage_list else ""
            first_color = color_list[0] if color_list else ""
            td_parts = [f"Product: {p_name}", f"ProductId: {pid}", f"SkuId: {skuid}"]
            if first_storage:
                td_parts.append(f"Storage: {first_storage}")
            if first_color:
                td_parts.append(f"Color: {first_color}")
            td_parts.append("Payment: One time")
            lines.append(f"  - Formatted Test Data: \"{', '.join(td_parts)}\"")

    lines.append("")
    lines.append("CRITICAL INSTRUCTIONS FOR TEST CASE GENERATION:")
    lines.append(f"1. PRECONDITIONS: Must state that the user is on '{app_name}' ({base_url}) with cookie banner dismissed.")
    lines.append("2. TEST STEPS: Every generated test case MUST include the real e& URLs directly in the step actions:")
    lines.append(f"   - Include navigation to portal ({base_url}) and catalog route ({entrypoint}).")
    lines.append("   - When opening the product configuration, ALWAYS include the exact Direct Configuration URL (https://www.eand.ae/eshop/devices/configuration?productId=...&skuId=...).")
    lines.append(f"   - Include variant selection, stock detection, Add to Cart, and cart verification ({cart_endpoint}).")
    lines.append("3. TEST DATA: Must explicitly include the 'ProductId: <id>' and 'SkuId: <id>' parameters along with chosen Storage, Color, and Payment option from the Knowledge Base so downstream automated execution can parse them.")
    lines.append("4. GENERATE A BALANCED MATRIX OF TEST CASES:")
    lines.append("   - Positive path: Happy-path purchase with One Time payment.")
    lines.append("   - Installment path: Purchase with Smart Pay installment plan.")
    lines.append("   - Variant validations: Storage and color selection combinations.")
    lines.append("   - Out-of-stock scenario: Disabled 'ADD TO CART' button behavior.")
    lines.append("   - Mandatory selection validation: Attempting Add to Cart without choosing mandatory variants.")
    lines.append("================================================================================")
    lines.append("")
    return "\n".join(lines)


def resolve_product_config_url(text_or_data: str, flow: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """Extract or resolve product configuration URL from text, test data, or flow blueprint."""
    # 1. Check if raw text already has a configuration URL
    url_match = re.search(r"https?://[^\s'\"]+configuration[^\s'\"]*", text_or_data)
    if url_match:
        return url_match.group(0).rstrip(".,)")

    # 2. Check for ProductId and SkuId explicitly in test_data or text
    pid_match = re.search(r"ProductId:\s*([a-zA-Z0-9]+)", text_or_data, re.IGNORECASE)
    sku_match = re.search(r"SkuId:\s*([a-zA-Z0-9]+)", text_or_data, re.IGNORECASE)
    
    prod_id = pid_match.group(1) if pid_match else None
    sku_id = sku_match.group(1) if sku_match else None

    # 3. Check known products in matched flow
    if flow and not prod_id:
        known = flow.get("known_products", {})
        for name, meta in known.items():
            if name.lower() in text_or_data.lower() or any(w.lower() in text_or_data.lower() for w in name.split() if len(w) > 3):
                prod_id = meta.get("productId")
                sku_id = meta.get("skuId")
                break

    if prod_id:
        sku_part = f"&skuId={sku_id}" if sku_id else ""
        cat_name = flow.get("category", "Smartphones") if flow else "Smartphones"
        return f"https://www.eand.ae/eshop/devices/configuration?productId={prod_id}{sku_part}&catName={cat_name}&listVal=Smartphones&showDefault=true"

    return None


def ground_case_structured_steps(case: Any) -> List[Dict[str, Any]]:
    """Ground structured steps of a test case using Knowledge Base Blueprints."""
    full_text = f"{getattr(case, 'description', '')} {getattr(case, 'objective', '')} {getattr(case, 'steps_raw', '')} {getattr(case, 'test_data', '')}"
    flow = match_flow_blueprint(full_text)

    steps = list(getattr(case, "steps_structured", []) or [])
    if not steps and getattr(case, "steps_raw", None):
        from .eligibility import split_steps
        raw_s = split_steps(case.steps_raw)
        steps = [{"step_number": i + 1, "action": s, "target": None, "test_data_ref": None, "expected_result": None} for i, s in enumerate(raw_s)]

    grounded_steps = []
    catalog_entry = flow.get("catalog_entrypoint") if flow else "https://www.eand.ae/eshop/devices/listing?category=mobileDevices&subCategory=cat1100067&catName=Earbuds&listVal=Smartphones&locale=EN"
    product_config_url = resolve_product_config_url(full_text, flow)
    cart_endpoint = flow.get("cart_endpoint") if flow else "https://www.eand.ae/eshop/checkout/cart"

    for i, st in enumerate(steps):
        s_num = st.get("step_number") or (i + 1)
        action = str(st.get("action") or "").strip()
        target = st.get("target")
        act_lower = action.lower()

        # Step 1 / Portal Navigation
        if not target and (i == 0 or "homepage" in act_lower or "index.html" in act_lower or act_lower.startswith("navigate to https://www.eand.ae")):
            target = "https://www.eand.ae/en/index.html"

        # Cookie dismissal
        elif any(k in act_lower for k in ["cookie", "privacy", "overlay", "banner", "usercentrics"]):
            target = "#usercentrics-root"

        # Product configuration page (checked BEFORE generic catalog keywords)
        elif any(k in act_lower for k in ["product configuration", "configure", "open product", "select product", "select the", "choose the", "item configuration", "view details"]) or any(prod.lower() in act_lower for prod in (flow.get("known_products", {}) or {}).keys()):
            if product_config_url:
                target = product_config_url
            elif catalog_entry:
                target = catalog_entry

        # Catalog navigation
        elif any(k in act_lower for k in ["catalog", "listing", "devices ->", "accessories ->", "browse devices", "browse catalog", "category page"]):
            target = catalog_entry

        # Variant / Payment Plan
        elif any(k in act_lower for k in ["one time", "full price", "payment option", "variant", "storage", "color", "smart pay", "installment"]):
            target = ".segment-tab:has-text('One time'), label:has-text('One Time')"

        # Add to cart
        elif "add to cart" in act_lower or "add to basket" in act_lower:
            target = "button:has-text('ADD TO CART'), button:has-text('Checkout Now')"

        # Cart / Checkout Review
        elif any(k in act_lower for k in ["shopping cart", "cart review", "cart screen", "checkout review", "cart page", "verify cart", "verify shopping cart", "secure checkout"]):
            target = cart_endpoint

        # Proceed to Checkout
        elif any(k in act_lower for k in ["checkout", "proceed to checkout", "proceed to"]):
            target = "button:has-text('Checkout Now'), button:has-text('Proceed to Checkout')"

        grounded_steps.append({
            "step_number": s_num,
            "action": action,
            "target": target,
            "test_data_ref": st.get("test_data_ref"),
            "expected_result": st.get("expected_result")
        })

    return grounded_steps
