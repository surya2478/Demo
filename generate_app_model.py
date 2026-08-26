#!/usr/bin/env python3
"""
================================================================================
Application Model Generator (Knowledge Base -> Structured Application Model JSON)
================================================================================
A standalone, zero-dependency runnable tool that parses Knowledge Base JSON files
(app_profile.json and flow_*.json blueprints) and compiles a comprehensive,
fully resolved Application Model in JSON format with:

- Full URL Inventory & Routing Matrix (Home, Catalogs, Direct Product Config URLs, Cart, Checkout)
- Page & Component Models (Selectors, Cookie Overlays, Search, Variant Selectors, CTAs)
- Flow Blueprints (Canonical Steps, Graph Transitions, State Machine, Automation Boundaries)
- Known Products Catalog Matrix (ProductIds, SkuIds, Variant Options, Payment Plans, Test Data Strings)
- Navigation Graphs (Nodes & Directed Edges for traversal)

Usage:
    # Run with default settings (auto-detects knowledge base and outputs application_model.json):
    python generate_app_model.py

    # Specify custom output path:
    python generate_app_model.py --output my_app_model.json

    # Target a specific application ID:
    python generate_app_model.py --app eand_ae --output eand_ae_model.json

    # Specify custom Knowledge Base root path:
    python generate_app_model.py --kb-path ./ai-admin-module-py/knowledge_base/applications
================================================================================
"""

import argparse
import datetime
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional


def find_default_kb_path() -> Optional[Path]:
    """Search for the knowledge base directory across common workspace locations."""
    script_dir = Path(__file__).resolve().parent

    candidates = [
        script_dir / "ai-admin-module-py" / "knowledge_base" / "applications",
        script_dir / "knowledge_base" / "applications",
        script_dir.parent / "knowledge_base" / "applications",
        script_dir.parent / "ai-admin-module-py" / "knowledge_base" / "applications",
        Path("/app/knowledge_base/applications"),
    ]

    for cand in candidates:
        if cand.exists() and cand.is_dir():
            return cand
    return None


def parse_query_params(url: str) -> Dict[str, str]:
    """Extract key-value query parameters from a URL."""
    params = {}
    if "?" in url:
        qs = url.split("?", 1)[1].split("#", 1)[0]
        for pair in qs.split("&"):
            if "=" in pair:
                k, v = pair.split("=", 1)
                params[k] = v
    return params


def build_app_model_for_app(app_dir: Path) -> Dict[str, Any]:
    """Builds the comprehensive Application Model for a given application folder."""
    profile_file = app_dir / "app_profile.json"
    profile = {}
    if profile_file.exists():
        with open(profile_file, "r", encoding="utf-8") as f:
            profile = json.load(f)

    app_id = profile.get("app_id", app_dir.name)
    app_name = profile.get("app_name", f"{app_id} Web Portal")
    base_url = profile.get("base_url", "")
    domain = profile.get("domain", "")
    framework = profile.get("framework", "Web Application")
    default_viewport = profile.get("default_viewport", {"width": 1440, "height": 900})
    security_profile = profile.get("security_profile", {})
    search_mechanism = profile.get("search_mechanism", {})

    # Load flows
    flows_dir = app_dir / "flows"
    raw_flows: List[Dict[str, Any]] = []
    if flows_dir.exists() and flows_dir.is_dir():
        for fpath in sorted(flows_dir.glob("*.json")):
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    raw_flows.append(json.load(f))
            except Exception as e:
                print(f"[!] Warning: Could not read flow file {fpath.name}: {e}", file=sys.stderr)

    url_registry: List[Dict[str, Any]] = []
    seen_urls = set()

    def _register_url(
        url: str,
        url_type: str,
        category: str,
        name: str,
        description: str,
        query_params: Optional[Dict[str, Any]] = None,
        selectors: Optional[List[str]] = None,
    ):
        if not url or url in seen_urls:
            return
        seen_urls.add(url)
        url_registry.append({
            "url": url,
            "url_type": url_type,
            "category": category,
            "name": name,
            "description": description,
            "query_parameters": query_params or parse_query_params(url),
            "associated_selectors": selectors or [],
        })

    # 1. Base Homepage URL
    if base_url:
        _register_url(
            url=base_url,
            url_type="Homepage",
            category="General",
            name="Portal Homepage",
            description=f"Landing page for {app_name} with navigation header and cookie banner.",
            query_params={},
            selectors=[
                security_profile.get("cookie_overlay", {}).get("host_selector", "#usercentrics-root"),
                search_mechanism.get("trigger_selector", ".search-wrap-dekstop"),
            ],
        )

    # 2. Flows, Products, and Navigation Topology
    enriched_flows = []
    products_catalog: Dict[str, List[Dict[str, Any]]] = {}
    navigation_nodes = [
        {"id": "homepage", "label": "Portal Homepage", "url": base_url, "type": "entrypoint"}
    ]
    navigation_edges = []
    seen_nodes = {"homepage"}

    for flow in raw_flows:
        f_id = flow.get("flow_id", "")
        f_name = flow.get("flow_name", "")
        cat = flow.get("category", "General")
        entrypoint = flow.get("catalog_entrypoint", "")
        cart_endpoint = flow.get("cart_endpoint", "https://www.eand.ae/eshop/checkout/cart")

        # Register Catalog URL
        if entrypoint:
            _register_url(
                url=entrypoint,
                url_type="Catalog_Listing",
                category=cat,
                name=f"{cat} Catalog Listing",
                description=f"Direct product listing and browsing page for {cat} devices and plans.",
                query_params=parse_query_params(entrypoint),
                selectors=[".device-card", ".product-item", "button.variant-btn"],
            )
            cat_node_id = f"catalog_{cat.lower()}"
            if cat_node_id not in seen_nodes:
                seen_nodes.add(cat_node_id)
                navigation_nodes.append({
                    "id": cat_node_id,
                    "label": f"{cat} Catalog",
                    "url": entrypoint,
                    "type": "catalog",
                })
                navigation_edges.append({
                    "from": "homepage",
                    "to": cat_node_id,
                    "action": f"navigate_{cat.lower()}_catalog",
                    "trigger_locator": f"a[href*='{cat.lower()}']",
                })

        # Register Cart URL
        if cart_endpoint:
            _register_url(
                url=cart_endpoint,
                url_type="Cart_Checkout",
                category="Checkout",
                name="Shopping Cart & Checkout Review",
                description="Secure shopping cart review screen showing selected devices, payment plans, and checkout CTA.",
                query_params={},
                selectors=[
                    "button:has-text('Checkout Now')",
                    "button:has-text('Proceed to Checkout')",
                    ".cart-item-summary",
                ],
            )
            cart_node_id = "shopping_cart"
            if cart_node_id not in seen_nodes:
                seen_nodes.add(cart_node_id)
                navigation_nodes.append({
                    "id": cart_node_id,
                    "label": "Shopping Cart",
                    "url": cart_endpoint,
                    "type": "cart",
                })

        # Process Known Products
        known_prods = flow.get("known_products", {})
        flow_prods = []
        for p_name, p_meta in known_prods.items():
            pid = p_meta.get("productId", "")
            skuid = p_meta.get("skuId", "")
            price = p_meta.get("default_price", "Live")
            storages = p_meta.get("available_storage", [])
            colors = p_meta.get("available_colors", [])
            plans = p_meta.get("payment_plans", [])
            addons = p_meta.get("optional_addons", [])

            sku_part = f"&skuId={skuid}" if skuid else ""
            direct_url = (
                f"https://www.eand.ae/eshop/devices/configuration?productId={pid}{sku_part}"
                f"&catName={cat}&listVal=Smartphones&showDefault=true"
            )

            # Register Product Config URL
            _register_url(
                url=direct_url,
                url_type="Product_Configuration",
                category=cat,
                name=f"{p_name} Direct Configuration",
                description=f"PDP configuration page for {p_name} with storage, color, and payment selection.",
                query_params={
                    "productId": pid,
                    "skuId": skuid,
                    "catName": cat,
                    "listVal": "Smartphones",
                    "showDefault": "true",
                },
                selectors=[
                    ".device-variant-options",
                    "[role='radio']",
                    "button.variant-btn",
                    ".segment-tab",
                    "button:has-text('ADD TO CART')",
                    "button:has-text('Checkout Now')",
                ],
            )

            # Build formatted test data reference string
            first_storage = storages[0] if storages else ""
            first_color = colors[0] if colors else ""
            td_parts = [f"Product: {p_name}", f"ProductId: {pid}", f"SkuId: {skuid}"]
            if first_storage:
                td_parts.append(f"Storage: {first_storage}")
            if first_color:
                td_parts.append(f"Color: {first_color}")
            td_parts.append("Payment: One time")

            prod_obj = {
                "product_name": p_name,
                "product_id": pid,
                "sku_id": skuid,
                "category": cat,
                "default_price": price,
                "direct_configuration_url": direct_url,
                "available_storage": storages,
                "available_colors": colors,
                "payment_plans": plans,
                "optional_addons": addons,
                "sample_test_data_string": ", ".join(td_parts),
            }
            flow_prods.append(prod_obj)

        if cat not in products_catalog:
            products_catalog[cat] = []
        products_catalog[cat].extend(flow_prods)

        # Graph edges from flow
        for edge in flow.get("graph_edges", []):
            navigation_edges.append(edge)

        enriched_flows.append({
            "flow_id": f_id,
            "flow_name": f_name,
            "category": cat,
            "target_match_keywords": flow.get("target_match_keywords", []),
            "catalog_entrypoint_url": entrypoint,
            "cart_endpoint_url": cart_endpoint,
            "automation_boundary": flow.get("automation_boundary", {
                "automated_scope": "Catalog -> Product Configuration -> Plan Selection -> Add to Cart -> Cart Verification",
                "external_boundary": "Live Payment Gateway (Credit Card / OTP) is an external boundary.",
            }),
            "canonical_steps": flow.get("canonical_steps", []),
            "graph_edges": flow.get("graph_edges", []),
            "registered_products": flow_prods,
        })

    # 3. Page Models & Component Locators
    page_models = {
        "homepage": {
            "page_name": "Portal Homepage",
            "url": base_url,
            "components": {
                "cookie_overlay": security_profile.get("cookie_overlay", {}),
                "search_bar": search_mechanism,
                "navigation_header": {
                    "selector": "header, .header-container, nav.main-nav",
                    "categories": list(products_catalog.keys()),
                },
            },
        },
        "catalogs": {
            cat_name: {
                "category": cat_name,
                "catalog_url": next(
                    (f.get("catalog_entrypoint") for f in raw_flows if f.get("category") == cat_name),
                    "",
                ),
                "components": {
                    "product_cards": ".device-card, .product-tile, .eshop-product-card",
                    "filter_tabs": ".filter-container, .brand-filter, .category-filter",
                    "sort_dropdown": "select[name='sort'], .sort-by",
                },
            }
            for cat_name in products_catalog.keys()
        },
        "product_configuration": {
            "url_template": (
                "https://www.eand.ae/eshop/devices/configuration?productId={{product_id}}"
                "&skuId={{sku_id}}&catName={{category}}&listVal=Smartphones&showDefault=true"
            ),
            "components": {
                "storage_selector": (
                    ".device-variant-options, .storage-btn, label:has-text('GB'), [role='radio']:has-text('GB')"
                ),
                "color_selector": (
                    ".color-swatch, .color-btn, [role='radio']:has-text('Titanium'), [role='radio']:has-text('Black')"
                ),
                "payment_plan_tabs": (
                    ".segment-tab, [role='radio']:has-text('One time'), button:has-text('One time'), button:has-text('Smart Pay')"
                ),
                "add_to_cart_cta": "button:has-text('ADD TO CART'), button:has-text('Checkout Now')",
                "price_display": ".price-container, .total-price, .device-price",
            },
        },
        "shopping_cart": {
            "url": "https://www.eand.ae/eshop/checkout/cart",
            "components": {
                "cart_summary": ".cart-summary, .order-review-container",
                "item_title": ".cart-item-title, .product-name",
                "payment_breakdown": ".cart-payment-type, .installment-term",
                "proceed_to_checkout_cta": (
                    "button:has-text('Checkout Now'), button:has-text('Proceed to Checkout')"
                ),
            },
        },
    }

    # 4. Master Application Model Object
    app_model = {
        "model_version": "2.0.0",
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "application_info": {
            "app_id": app_id,
            "app_name": app_name,
            "base_url": base_url,
            "domain": domain,
            "framework": framework,
            "default_viewport": default_viewport,
            "security_profile": security_profile,
            "search_mechanism": search_mechanism,
        },
        "summary": {
            "total_flows": len(enriched_flows),
            "total_categories": len(products_catalog),
            "total_known_products": sum(len(p) for p in products_catalog.values()),
            "total_registered_urls": len(url_registry),
            "total_canonical_steps": sum(len(f.get("canonical_steps", [])) for f in enriched_flows),
        },
        "url_registry": url_registry,
        "page_models": page_models,
        "flows": enriched_flows,
        "products_catalog": products_catalog,
        "navigation_graph": {
            "nodes": navigation_nodes,
            "edges": navigation_edges,
        },
    }

    return app_model


def main():
    parser = argparse.ArgumentParser(
        description="Generate comprehensive Application Model JSON with full URL details and structure from Knowledge Base."
    )
    parser.add_argument(
        "--app",
        "-a",
        default="all",
        help="Application ID to compile (e.g. 'eand_ae' or 'all' for all applications, default: all)",
    )
    parser.add_argument(
        "--kb-path",
        "-k",
        default=None,
        help="Path to Knowledge Base 'applications' directory. If omitted, auto-detected from workspace.",
    )
    parser.add_argument(
        "--output",
        "-o",
        default="application_model.json",
        help="Output JSON file path (default: application_model.json)",
    )
    parser.add_argument(
        "--indent",
        "-i",
        type=int,
        default=2,
        help="JSON indentation spaces (default: 2)",
    )
    parser.add_argument(
        "--summary",
        "-s",
        action="store_true",
        help="Print detailed terminal summary report",
    )
    parser.add_argument(
        "--quiet",
        "-q",
        action="store_true",
        help="Suppress terminal summary output",
    )

    args = parser.parse_args()

    # Resolve KB Directory
    kb_path = Path(args.kb_path).resolve() if args.kb_path else find_default_kb_path()
    if not kb_path or not kb_path.exists():
        print(
            f"[X] Error: Could not locate Knowledge Base directory.\n"
            f"    Checked path: {kb_path}\n"
            f"    Please supply --kb-path /path/to/knowledge_base/applications",
            file=sys.stderr,
        )
        sys.exit(1)

    app_dirs = [d for d in kb_path.iterdir() if d.is_dir()]
    if args.app != "all":
        app_dirs = [d for d in app_dirs if d.name == args.app]

    if not app_dirs:
        print(f"[X] Error: No matching application found in {kb_path} for app '{args.app}'", file=sys.stderr)
        sys.exit(1)

    # Build models
    if len(app_dirs) == 1:
        result_data = build_app_model_for_app(app_dirs[0])
    else:
        result_data = {
            "model_version": "2.0.0",
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            "applications": [build_app_model_for_app(d) for d in app_dirs],
        }

    # Write output JSON file
    out_path = Path(args.output).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result_data, f, indent=args.indent, ensure_ascii=False)

    if not args.quiet:
        print("=" * 80)
        print("  APPLICATION MODEL GENERATOR - SUCCESSFUL")
        print("=" * 80)
        print(f" Knowledge Base Source : {kb_path}")
        print(f" Output JSON File      : {out_path}")
        print(f" File Size             : {out_path.stat().st_size:,} bytes")
        print("-" * 80)

        # Print breakdown
        models_to_report = (
            result_data.get("applications", []) if "applications" in result_data else [result_data]
        )
        for m in models_to_report:
            app_info = m.get("application_info", {})
            summary = m.get("summary", {})
            print(f" Application ID        : {app_info.get('app_id')}")
            print(f" Application Name      : {app_info.get('app_name')}")
            print(f" Base URL              : {app_info.get('base_url')}")
            print(f" Total Registered Flows: {summary.get('total_flows')}")
            print(f" Total Product SKUs    : {summary.get('total_known_products')}")
            print(f" Total URL Routes      : {summary.get('total_registered_urls')}")
            print(f" Canonical Test Steps  : {summary.get('total_canonical_steps')}")
            print("\n URL Registry Matrix:")
            for u in m.get("url_registry", []):
                print(f"   [{u.get('url_type'):<21}] {u.get('name')}")
                print(f"     URL: {u.get('url')}")
                if u.get("query_parameters"):
                    print(f"     Params: {u.get('query_parameters')}")
            print("-" * 80)
        print(f"[V] Application Model JSON successfully written to: {out_path}\n")


if __name__ == "__main__":
    main()
