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

logger = logging.getLogger(__name__)

# Base path for knowledge base
_candidate_1 = Path(__file__).resolve().parents[4] / "knowledge_base" / "applications"
_candidate_2 = Path(__file__).resolve().parents[3] / "knowledge_base" / "applications"
KB_ROOT_DIR = _candidate_1 if _candidate_1.exists() else _candidate_2


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

    text = query_or_url.lower()

    # 1. Match by keyword score
    best_match = None
    best_score = 0

    for flow in flows:
        score = 0
        keywords = flow.get("target_match_keywords", [])
        for kw in keywords:
            if kw.lower() in text:
                score += 2

        # Check category match
        if flow.get("category", "").lower() in text:
            score += 1

        # Check known products
        for prod_name in flow.get("known_products", {}).keys():
            if prod_name.lower() in text:
                score += 5

        if score > best_score:
            best_score = score
            best_match = flow

    if best_score > 0:
        return best_match

    # Default to first flow if none matched specifically
    return flows[0] if flows else None


def build_flow_context_prompt(query_or_brd: str, app_id: str = "eand_ae") -> str:
    """Builds grounding context string to inject into LLM system prompt for test case generation."""
    flow = match_flow_blueprint(query_or_brd, app_id)
    if not flow:
        return ""

    app_prof = load_app_profile(app_id) or {}
    flow_name = flow.get("flow_name", "Standard Flow")
    category = flow.get("category", "General")
    entrypoint = flow.get("catalog_entrypoint", app_prof.get("base_url", "https://www.eand.ae/en/index.html"))

    lines = [
        "",
        "APPLICATION FLOW KNOWLEDGE BASE (GROUND TRUTH):",
        f"Target Application: {app_prof.get('app_name', 'e& UAE')} ({app_prof.get('base_url', '')})",
        f"Matched Flow Blueprint: {flow_name} (Category: {category})",
        f"Catalog Route: {entrypoint}",
        "Canonical Test Traversal Sequence:"
    ]

    for s in flow.get("canonical_steps", []):
        lines.append(f"  {s.get('step_number')}. {s.get('action')}")

    known_prods = flow.get("known_products", {})
    if known_prods:
        lines.append("Supported Products & Config Parameters in this Flow:")
        for p_name, p_meta in list(known_prods.items())[:4]:
            lines.append(f"  - {p_name}: ProductId={p_meta.get('productId')}, SkuId={p_meta.get('skuId')}, Price={p_meta.get('default_price', 'Live')}")

    lines.append("INSTRUCTION: Use this exact flow structure and exact URL routes in your generated Test Cases.")
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

        # Catalog navigation
        elif any(k in act_lower for k in ["catalog", "listing", "earbuds", "smartphones", "smartwatches", "accessories ->"]):
            target = catalog_entry

        # Product configuration page
        elif any(k in act_lower for k in ["product configuration", "configure", "open product", "select the huawei", "select huawei", "select samsung", "select product"]):
            if product_config_url:
                target = product_config_url
            elif catalog_entry:
                target = catalog_entry

        # Variant / Payment Plan
        elif any(k in act_lower for k in ["one time", "full price", "payment option", "variant", "storage", "color"]):
            target = ".segment-tab:has-text('One time'), label:has-text('One Time')"

        # Add to cart
        elif "add to cart" in act_lower or "add to basket" in act_lower:
            target = "button:has-text('ADD TO CART'), button:has-text('Checkout Now')"

        # Checkout
        elif any(k in act_lower for k in ["checkout", "proceed to checkout", "secure checkout", "shopping cart"]):
            target = "button:has-text('Checkout Now'), button:has-text('Proceed to Checkout')"

        grounded_steps.append({
            "step_number": s_num,
            "action": action,
            "target": target,
            "test_data_ref": st.get("test_data_ref"),
            "expected_result": st.get("expected_result")
        })

    return grounded_steps
