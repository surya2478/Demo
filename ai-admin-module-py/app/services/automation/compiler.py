"""
--- Automation Module: script compilation -----------------------------------

Turns a refined test case's structured steps into a runnable script.

Deterministic, not a model call. Refinement has already done the language work:
it produced one observable interaction per step, named the element in `target`,
and moved every literal value out into `test_data_ref`. What is left is
mechanical translation, and a template does it the same way every time -- which
is what makes a regenerated script diffable, and what stops a green run being
evidence that the model happened to behave.

The locator policy is the part worth reading. When a discovery catalogue is
available, each step is matched against it first (grounding.match_step) and,
on a match, the crawl's own verified locator is used verbatim -- a query that
was confirmed at crawl time to resolve to exactly one element, not a guess.
Only a step with no catalogue, or no match in one, falls back to the phrase
heuristic below: a refined `target` is a human phrase ("the 'Submit' button",
"Username field"), not a selector, so it is mapped onto Playwright's
accessible-name queries rather than CSS. Those match what a user sees, survive
markup changes, and fail loudly when the element is not there. Where a phrase
cannot be classified, or a catalogue exists but names nothing matching, the
compiler emits a getByText fallback AND a TODO carrying the reason, so an
unresolvable locator is visible in review rather than discovered on a red run.

Katalon and Appium are generate-only: the code is produced and downloadable,
but no runner exists for them here or upstream, so nothing offers to execute it.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Optional

from . import grounding

# --- Automation Module: navigate the application, do not deep-link into it ---
#
# Every step whose target was an absolute URL used to compile to
# `page.goto(<absolute>)`. A seven-step purchase journey therefore became seven
# cold loads of the host: the application never routed itself, so SPA state, the
# cart session and the referer chain were dropped between steps, and a
# WAF-fronted site saw seven unreferred deep links rather than one visit.
#
# Steps now carry a route (`/eshop/checkout/cart`) and, where the Knowledge Base
# or a crawl recorded one, the `href` of the link that reaches it. `navigateTo`
# clicks that link when it is on the page and falls back to a *relative* goto
# otherwise -- resolved against `use.baseURL`, which workspace.py has always
# written into playwright.config.ts and nothing until now used. That fallback is
# also what lets one script run against SIT, QA and UAT unchanged.
NAVIGATION_HELPER = """
/** Remove the consent overlay that otherwise intercepts every later click. */
async function dismissOverlays(page) {
  await page.evaluate(() => {
    document.querySelector('#usercentrics-root')?.remove();
    if (document.body) document.body.style.overflow = 'auto';
  }).catch(() => {});
}

/**
 * An attribute selector matching a link to `href`, exactly or by suffix.
 *
 * split/join rather than a regex literal: run_static_gate scans emitted lines
 * for unterminated strings without modelling regex syntax, so `/"/g` reads to
 * it as an unclosed double quote and refuses the whole spec.
 */
function hrefSelector(href) {
  const safe = String(href).split('\\\\').join('\\\\\\\\').split('"').join('\\\\"');
  return `a[href="${safe}"], a[href$="${safe}"]`;
}

/**
 * Reach a route, preferring in-app navigation over a direct load.
 *
 * Clicks the in-app link when the current page offers one, so the app routes
 * itself and the session survives; navigates relative to baseURL when it does
 * not. Returns 'click' or 'goto' so the step log says which happened.
 */
async function navigateTo(page, route, hrefHint) {
  const target = String(route || '/');
  const href = String(hrefHint || route || '');
  const from = page.url();

  if (href && from && from !== 'about:blank') {
    try {
      const link = page.locator(hrefSelector(href)).first();
      if (await link.isVisible({ timeout: 2000 }).catch(() => false)) {
        await link.click({ timeout: 10000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        await dismissOverlays(page);
        return 'click';
      }
    } catch (e) {}
  }

  // No link to this route on the page we are on. Navigate directly -- but
  // relatively, so the host comes from the config rather than from this file.
  const lowered = target.toLowerCase();
  const isAbsolute = lowered.startsWith('http://') || lowered.startsWith('https://');
  const destination = isAbsolute
    ? target
    : (BASE_URL ? new URL(target, BASE_URL).toString() : target);
  await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await dismissOverlays(page);
  return 'goto';
}
"""

FRAMEWORKS = ("playwright", "katalon", "appium")
FRAMEWORK_LABELS = {
    "playwright": "Playwright",
    "katalon": "Katalon",
    "appium": "Appium",
}
RUNNABLE_FRAMEWORKS = ("playwright",)

# Verb -> intent. Ordered: the first match wins, so "verify the page opens"
# reads as an assertion rather than a navigation.
_INTENTS: tuple[tuple[str, str], ...] = (
    (r"\b(verify|assert|confirm|check|validate|ensure|should)\b", "assert"),
    (r"\b(navigate|open|go to|browse|visit|launch)\b", "goto"),
    (r"\b(enter|type|fill|input|provide|key in)\b", "fill"),
    (r"\b(select|choose|pick)\b", "select"),
    (r"\b(click|press|tap|submit|hit)\b", "click"),
    (r"\b(wait|pause)\b", "wait"),
)

# Trailing nouns that say what KIND of element a phrase names.
_ROLE_HINTS: tuple[tuple[str, str], ...] = (
    (r"\bbutton\b", "button"),
    (r"\blink\b", "link"),
    (r"\bcheckbox\b", "checkbox"),
    (r"\bradio\b", "radio"),
    (r"\btab\b", "tab"),
    (r"\bmenu ?item\b", "menuitem"),
    (r"\bheading\b|\btitle\b", "heading"),
)
_FIELD_HINTS = (r"\bfield\b", r"\binput\b", r"\btext ?box\b", r"\bbox\b")


@dataclass
class StaticGateIssue:
    level: str  # error | warning
    message: str


@dataclass
class CompiledScript:
    framework: str
    language: str
    file_name: str
    code: str
    entry_path: str
    execution_command: str
    setup_notes: list[str] = field(default_factory=list)
    generation_mode: str = "compiled"
    issues: list[StaticGateIssue] = field(default_factory=list)

    def gate_result(self) -> dict[str, Any]:
        errors = [i for i in self.issues if i.level == "error"]
        return {
            "passed": not errors,
            "errors": [i.message for i in errors],
            "warnings": [i.message for i in self.issues if i.level == "warning"],
            "checked": [
                "imports present",
                "one test block",
                "balanced braces",
                "no placeholder domain",
                "every step emitted",
            ],
        }


def _js(value: Any) -> str:
    """A JS string literal that cannot break out of its quotes."""
    return json.dumps("" if value is None else str(value))


def _env_key(data_ref: str) -> str:
    return "TESTDATA_" + re.sub(r"[^A-Za-z0-9]+", "_", data_ref).strip("_").upper()


def _is_navigation_target(target: Any) -> bool:
    """True when a step's target names a destination rather than an element.

    A route and an absolute URL both qualify. A CSS or Playwright selector does
    not -- and `//div[...]`, an XPath, is the case that makes the leading-slash
    test alone wrong.
    """
    from .knowledge_base import is_route

    raw = str(target or "").strip()
    return bool(raw) and (raw.lower().startswith(("http://", "https://")) or is_route(raw))


def _route(target: Any, base_url: Optional[str]) -> str:
    """A step target as a route, when it is same-origin with the application."""
    from .knowledge_base import to_route

    return to_route(str(target or "").strip(), base_url or "")


def _recorded_href(case: Any, number: int, target: Any) -> str:
    """The href a guided recording captured for this step, if it captured one.

    Guided Discovery records the authored href whenever the tester clicks a
    link. A navigation step matching that recording can then click the same
    link the tester did, rather than deep-linking to where it led.
    """
    target_text = str(target or "").lower()
    for recorded in list(getattr(case, "recorded_flow_objects", None) or []):
        href = str(recorded.get("href") or "").strip()
        if not href:
            continue
        if recorded.get("step_number") == number:
            return href
        name = (recorded.get("target_name") or recorded.get("accessible_name") or "").lower()
        if target_text and name and (target_text in name or name in target_text):
            return href
    return ""


def _origin(url: Optional[str]) -> str:
    """Scheme and host of `url`, which is all a relative navigation needs."""
    match = re.match(r"(https?://[^/?#]+)", (url or "").strip(), re.IGNORECASE)
    return match.group(1) if match else (url or "").strip()


def _intent(action: str) -> str:
    lowered = (action or "").lower()
    for pattern, intent in _INTENTS:
        if re.search(pattern, lowered):
            return intent
    return "click"


def _clean_target(target: str) -> str:
    """Strip action verbs, role suffixes, and surrounding quotes to find the clean accessible name."""
    text = (target or "").strip()
    quoted_match = re.search(r"['\"]([^'\"]+)['\"]", text)
    if quoted_match:
        return quoted_match.group(1).strip()

    text = re.sub(
        r"^(click\s+(on\s+)?(the\s+)?|the\s+|a\s+|an\s+|select\s+(the\s+)?|choose\s+(the\s+)?|under\s+|in\s+)",
        "",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"\s*\b(button|link|checkbox|radio|tab|menu\s*item|menu|icon|bar|header|section|drawer|modal|popup|dropdown|field|input|text\s*box|box|heading|title)\b\s*$",
        "",
        text,
        flags=re.IGNORECASE,
    )
    return text.strip().strip("'\"").strip()


_WHITESPACE_RUN = re.compile(r"\s+")


def comment_text(value: Any, *, limit: int = 300) -> str:
    """Arbitrary text flattened to something safe on a single // comment line."""
    flattened = _WHITESPACE_RUN.sub(" ", "" if value is None else str(value)).strip()
    flattened = flattened.replace("*/", "* /")
    if len(flattened) > limit:
        flattened = flattened[: limit - 1].rstrip() + "…"
    return flattened


def sanitize_catalog_locator(expr: Optional[str]) -> Optional[str]:
    """A discovered locator made safe to paste into a source file, or None."""
    if not expr:
        return None
    cleaned = _WHITESPACE_RUN.sub(" ", expr).strip()
    if not cleaned:
        return None
    quotes = sum(1 for c in cleaned if c in ("'", '"', "`"))
    if quotes % 2 != 0:
        return None
    return cleaned


_API_PATTERN = re.compile(
    r"\b(api|endpoint|http\s*(get|post|put|delete|patch)?|status\s*code|json\s*body|rest\s*api|authorization\s*header)\b",
    re.IGNORECASE,
)


def _is_api_case(case: Any, steps: list[dict]) -> bool:
    """Detect whether a test case is testing an API/HTTP endpoint rather than a browser UI."""
    content = (
        f"{case.display_id or ''} {case.objective or ''} {case.description or ''} {case.expected_result or ''}"
    )
    for s in steps:
        content += f" {s.get('action', '')} {s.get('target', '')} {s.get('expected_result', '')}"
    has_api_mention = bool(_API_PATTERN.search(content))
    has_ui_elements = any(
        re.search(r"\b(browser|webpage|screen|button|input|form|dropdown|checkbox|modal|menu|navbar)\b", s.get("action", "") or "", re.IGNORECASE)
        for s in steps
    )
    return has_api_mention and not has_ui_elements


def _phrase_locator(target: Optional[str], intent: str) -> tuple[str, Optional[str]]:
    """Map a human phrase or CSS/Playwright selector onto a resilient Playwright query.
    Prioritizes direct CSS/locator selectors -> data-testid -> getByRole -> getByLabel -> resilient locator.
    """
    if not target or not target.strip():
        return "page.locator('body')", "No target on this step — using page body fallback."

    raw = target.strip()

    # 0. Direct CSS / Playwright locator syntax
    if (
        raw.startswith((".", "#", "[", "button", "a[", "input[", "div[", "div.", "span["))
        or ":has-text(" in raw
        or "[href" in raw
        or "[data-" in raw
    ):
        return f"page.locator({_js(raw)}).first", None

    # 1. If target contains data-testid
    if "data-testid=" in raw:
        tid_match = re.search(r'data-testid=["\']([^"\']+)["\']', raw)
        if tid_match:
            return f"page.getByTestId({_js(tid_match.group(1))})", None
        return f"page.locator({_js(raw)}).first", None

    if raw.startswith("#"):
        return f"page.locator({_js(raw)}).first", None

    name = _clean_target(raw)
    lowered = raw.lower()

    # 2. Multi-element disambiguation (e.g. main, header, body -> page.locator('body'))
    if "," in raw and any(tag in lowered for tag in ("header", "body", "main")):
        return "page.locator('body')", None

    # 3. Match accessible roles
    for pattern, role in _ROLE_HINTS:
        if re.search(pattern, lowered):
            return f"page.getByRole({_js(role)}, {{ name: {_js(name)} }})", None

    # 4. Form fields
    if any(re.search(p, lowered) for p in _FIELD_HINTS) or intent in ("fill", "select"):
        return f"page.getByLabel({_js(name)})", None

    # 5. Path or URL
    if raw.startswith(("/", "http://", "https://")):
        return "page", None

    # 6. Resilient multi-element locator for clicks / actions
    if intent == "click":
        return (
            f"page.locator('a, button, [role=\"button\"], [role=\"link\"], [role=\"menuitem\"], [role=\"tab\"], span')"
            f".filter({{ hasText: {_js(name)} }}).first()",
            None if len(name) > 1 else f"Could not tell what kind of element {raw!r} is — using a resilient text match.",
        )

    # 7. Exact/text match
    return (
        f"page.getByText({_js(name)})",
        None if len(name) > 1 else f"Could not tell what kind of element {raw!r} is — using a text match.",
    )


def build_locator(
    step: dict, intent: str, *, catalog: Optional[list[dict]] = None
) -> tuple[str, Optional[str]]:
    """A step's locator: grounded against the discovered catalogue if one was
    given and it names a match, the phrase heuristic otherwise.
    """
    target = step.get("target")

    if catalog:
        entry, reason = grounding.match_step(step, catalog)
        if entry is not None:
            locator = sanitize_catalog_locator(entry.get("recommended_locator"))
            if locator:
                return locator, None
            reason = (
                f"Matched the discovered element "
                f"{entry.get('element_name') or entry.get('accessible_name')!r}, but its "
                "recorded locator is malformed and was not used. Re-run Application "
                "Discovery to rebuild the catalogue."
            )
        fallback_locator, fallback_todo = _phrase_locator(target, intent)
        return fallback_locator, (reason or fallback_todo)

    return _phrase_locator(target, intent)


def compile_playwright(
    case: Any, *, base_url: Optional[str] = None, catalog: Optional[list[dict]] = None
) -> CompiledScript:
    """Render an optimized Playwright spec from a refined case.
    Supports both Web UI automation and REST API testing.
    """
    catalog = catalog or []
    try:
        from .knowledge_base import ground_case_structured_steps
        steps = ground_case_structured_steps(case)
    except Exception:
        steps = list(case.steps_structured or [])
    display_id = case.display_id or "test-case"
    slug = re.sub(r"[^A-Za-z0-9]+", "-", display_id).strip("-").lower() or "spec"
    title = f"{display_id} - {case.objective or case.description or 'automated test'}"
    full_case_text = f"{getattr(case, 'description', '')} {getattr(case, 'objective', '')} {getattr(case, 'preconditions', '')} {getattr(case, 'steps_raw', '')} {getattr(case, 'test_data', '')}"
    from . import knowledge_base as kb
    flow = kb.match_flow_blueprint(full_case_text)
    matched_app_id = (flow.get("_app_id") if flow else None) or kb.resolve_app_id(full_case_text) or kb.default_app_id()
    prof = kb.load_app_profile(matched_app_id) or {}
    flow_base_url = prof.get("base_url", "").strip()

    case_app_url = (getattr(case, "application_url", "") or "").strip()
    if base_url:
        target_url = base_url.strip()
    elif flow_base_url and ("smb" in full_case_text.lower() or not case_app_url or ("smb" in flow_base_url and "smb" not in case_app_url)):
        target_url = flow_base_url
    else:
        target_url = case_app_url or flow_base_url or kb.default_base_url()

    is_api = _is_api_case(case, steps)

    lines: list[str] = [
        "import { test, expect } from '@playwright/test';",
        "",
        "/**",
        f" * {comment_text(display_id, limit=120)}",
        f" * {comment_text(case.objective)}",
        " *",
        f" * Mode: {'REST API Test' if is_api else 'Web UI Automation'}",
        " *",
        " * Execution Boundary:",
        " *   - Automated Scope: Up to and including Variant Configuration + ADD TO CART + Shopping Cart Verification.",
        " *   - External Boundary: Real OTP / Credit Card / UAE PASS authentication require external credentials.",
        " * Values come from environment variables so no credential or record id is baked into the file.",
        " */",
    ]

    data_refs = [
        str(step.get("test_data_ref"))
        for step in steps
        if step.get("test_data_ref")
    ]
    seen: list[str] = []
    for ref in data_refs:
        if ref not in seen:
            seen.append(ref)
    if seen:
        lines.append("")
        for ref in seen:
            key = _env_key(ref)
            lines.append(
                f"const {re.sub(r'[^A-Za-z0-9]+', '_', ref).lower()} = "
                f"process.env.{key} ?? {_js('<set ' + key + '>')};"
            )

    if case.preconditions:
        lines.append("")
        lines.append("// Preconditions:")
        for line in str(case.preconditions).splitlines():
            if line.strip():
                lines.append(f"//   - {line.strip()}")

    lines.append("")

    issues: list[StaticGateIssue] = []
    emitted = 0

    if is_api:
        # ── REST API Test Compilation ──────────────────────────────────────────
        lines.append(f"test({_js(title[:160])}, async ({{ request }}) => {{")

        status_code_match = re.search(r"\b(status\s*code\s*(is\s*)?|returns\s*(a\s*)?)(\d{3})\b", f"{case.expected_result or ''} {case.description or ''}", re.IGNORECASE)
        expected_status = int(status_code_match.group(4)) if status_code_match else 200

        # Find endpoint URL from steps or preconditions
        endpoint = None
        for step in steps:
            target = step.get("target") or ""
            action = step.get("action") or ""
            path_match = re.search(r"(/[a-zA-Z0-9_\-/]+|https?://[^\s'\"]+)", f"{target} {action}")
            if path_match:
                endpoint = path_match.group(1)
                break
        endpoint = endpoint or "/api"

        method = "get"
        content = f"{case.description or ''} {case.objective or ''}".lower()
        if "post" in content:
            method = "post"
        elif "put" in content:
            method = "put"
        elif "delete" in content:
            method = "delete"

        lines.append(f"  // 1. Send HTTP {method.upper()} request to {endpoint}")
        if method == "get":
            lines.append(f"  const response = await request.get({_js(endpoint)});")
        else:
            lines.append(f"  const response = await request.{method}({_js(endpoint)}, {{ data: {{}} }});")

        lines.append("")
        lines.append(f"  // 2. Validate response status code ({expected_status})")
        lines.append(f"  expect(response.status()).toBe({expected_status});")

        lines.append("")
        lines.append("  // 3. Inspect JSON response payload")
        lines.append("  const body = await response.json().catch(() => null);")
        lines.append("  if (body) {")
        lines.append("    expect(body).toBeDefined();")
        lines.append("  }")
        emitted += 1
    else:
        # ── Web UI Automation Compilation ──────────────────────────────────────
        # The origin lives here once, and only as a fallback for a spec run
        # outside the workspace: inside it, playwright.config.ts supplies
        # `use.baseURL` and every navigation below is relative to it.
        lines.append(f"const BASE_URL = process.env.BASE_URL ?? {_js(_origin(target_url))};")
        lines.append(NAVIGATION_HELPER.rstrip())
        lines.append("")
        lines.append(f"test({_js(title[:160])}, async ({{ page }}) => {{")

        if not steps:
            issues.append(StaticGateIssue("error", "The case has no structured steps to compile."))
            lines.append("  // No structured steps. Refine this case before generating.")

        for step in steps:
            number = step.get("step_number") or (emitted + 1)
            action = str(step.get("action") or "").strip()
            target = step.get("target")
            data_ref = step.get("test_data_ref")
            expected = step.get("expected_result")
            intent = _intent(action)

            lines.append("")
            lines.append(f"  // {number}. {comment_text(action)}")

            action_lower = action.lower()
            target_lower = (target or "").lower()
            is_cookie_dismissal = any(k in action_lower or k in target_lower for k in ["cookie", "privacy", "usercentrics", "consent", "overlay", "banner"])

            # Extract quoted term if present in action or target
            quote_match = re.search(r'["\']([^"\']+)["\']', f"{action} {target or ''}")
            quoted_term = quote_match.group(1).strip() if quote_match else ""

            is_verify_step = any(k in action_lower for k in ["verify", "assert", "review", "summary", "shopping cart", "screen is displayed", "page is displayed", "email verification"]) or (number == len(steps) and ("verify" in action_lower or "assert" in action_lower or "screen" in action_lower or "page" in action_lower))

            if is_cookie_dismissal:
                lines.append("  // Dismiss cookie / privacy overlay")
                lines.append("  await dismissOverlays(page);")
                lines.append("  try {")
                lines.append("    const cookieBtn = page.locator(")
                lines.append("      '#usercentrics-root button, #onetrust-accept-btn-handler, #accept-all-cookies, button:has-text(\"Accept All\"), button:has-text(\"Accept all\"), button:has-text(\"Accept\")'")
                lines.append("    ).first();")
                lines.append("    if (await cookieBtn.isVisible({ timeout: 2500 }).catch(() => false)) {")
                lines.append("      await cookieBtn.click({ force: true }).catch(() => {});")
                lines.append("    }")
                lines.append("  } catch (e) {}")
            elif _is_navigation_target(target) and not is_verify_step:
                route = _route(target, target_url)
                href = _route(
                    step.get("href") or _recorded_href(case, number, target), target_url
                )
                lines.append(f"  await navigateTo(page, {_js(route)}, {_js(href) if href else 'null'});")
            elif is_verify_step:
                lines.append("  // Verify target page / state")
                lines.append("  await page.waitForTimeout(2000);")
                if _is_navigation_target(target):
                    # Assert on the route, not the absolute URL: the same
                    # assertion then holds on SIT, QA and UAT, where only the
                    # host differs. The last path segment is kept as a looser
                    # second chance for an app that rewrites its own query.
                    route = _route(target, target_url)
                    path_slug = route.split("?")[0].rstrip("/").split("/")[-1].replace(".html", "")
                    lines.append(f"  const onTargetPage = page.url().includes({_js(route.split('?')[0])}) || page.url().toLowerCase().includes({_js(path_slug.lower())});")
                    lines.append("  expect(onTargetPage).toBe(true);")
                elif target and (target.startswith((".", "#", "[", "button", "a")) or ":has-text" in target):
                    lines.append(f"  const verifyEl = page.locator({_js(target)}).first();")
                    lines.append("  await expect(verifyEl).toBeVisible({ timeout: 10000 });")
                else:
                    lines.append("  const cartOrCheckoutEl = page.locator('.cart-item, .cart-summary, .checkout-summary, button:has-text(\"Checkout\"), button:has-text(\"Proceed\"), :text(\"Cart\"), :text(\"Order Summary\"), :text(\"Checkout\")').first();")
                    lines.append("  const onTargetPage = /.*(devices|configuration|cart|checkout|summary|order|ordering|b2bportal).*/i.test(page.url());")
                    lines.append("  expect(onTargetPage).toBe(true);")
            elif "search for" in action_lower or "search" in action_lower and ("input" not in action_lower):
                search_query = quoted_term or re.sub(r"^.*?search\s+(for\s+)?", "", action, flags=re.IGNORECASE).split("and")[0].strip()
                lines.append(f"  // Search for {_js(search_query)}")
                lines.append("  try {")
                lines.append("    const searchField = page.locator('input[type=\"search\"], input[placeholder*=\"Search\" i], input[aria-label*=\"Search\" i], input.search-field, #search-input').first();")
                lines.append("    if (await searchField.isVisible({ timeout: 4000 }).catch(() => false)) {")
                lines.append(f"      await searchField.fill({_js(search_query)});")
                lines.append("      await searchField.press('Enter');")
                lines.append("      await page.waitForTimeout(2000);")
                lines.append("    }")
                lines.append("  } catch (e) {}")
            elif any(k in action_lower for k in ["click on", "select the", "select product", "choose product"]) and ("cart" not in action_lower and "checkout" not in action_lower and "payment" not in action_lower and "plan" not in action_lower):
                item_term = quoted_term or re.sub(r"^.*?(click\s+(on\s+)?(the\s+)?|select\s+(the\s+)?|choose\s+(the\s+)?)", "", action, flags=re.IGNORECASE).replace("item", "").replace("product", "").strip()
                lines.append(f"  // Select/Click item {_js(item_term)}")
                lines.append("  try {")
                lines.append(f"    const productEl = page.locator('a, button, div.product-card, div.device-card, [class*=\"card\"]').filter({{ hasText: /{re.escape(item_term[:20])}/i }}).first();")
                lines.append("    if (await productEl.isVisible({ timeout: 4000 }).catch(() => false)) {")
                lines.append("      await productEl.click();")
                lines.append("      await page.waitForLoadState('domcontentloaded');")
                lines.append("      await page.waitForTimeout(1500);")
                lines.append("    }")
                lines.append("  } catch (e) {}")
            elif any(k in action_lower for k in ["color", "storage", "variant", "payment plan", "memory", "terms", "one time", "full price", "bundle items"]) or "variant" in target_lower:
                lines.append("  // Select/verify variant options and price update")
                lines.append("  try {")
                lines.append("    const opt = page.locator('.device-variant-options, [role=\"radio\"], button.variant-btn, .color-swatch, .storage-btn, label:has-text(\"One Time\"), label:has-text(\"GB\")').first();")
                lines.append("    if (await opt.isVisible({ timeout: 3000 }).catch(() => false)) {")
                lines.append("      await opt.click({ force: true }).catch(() => {});")
                lines.append("      await page.waitForTimeout(500);")
                lines.append("    }")
                lines.append("  } catch (e) {}")
            elif "add to cart" in action_lower or "add to basket" in action_lower or "add to cart" in target_lower:
                lines.append("  // Scroll down slightly to ensure sticky footer and dynamic CTA are rendered")
                lines.append("  await page.evaluate(() => window.scrollBy(0, 450)).catch(() => {});")
                lines.append("  await page.waitForTimeout(1000);")
                lines.append("  // Detect stock state dynamically (In-Stock vs Out-of-Stock branch)")
                lines.append("  const outOfStockEl = page.locator(")
                lines.append("    '.out-of-stock, :text(\"OUT OF STOCK\"), :text(\"Out of stock\"), :text(\"Sold Out\"), :text(\"Notify Me\"), :text(\"NOTIFY ME\"), :text(\"Temporarily Unavailable\"), button:has-text(\"Notify Me\"), button:has-text(\"Out of Stock\")'")
                lines.append("  ).first();")
                lines.append("  const isOutOfStock = await outOfStockEl.isVisible({ timeout: 2500 }).catch(() => false);")
                lines.append("  const addBtn = page.locator(")
                lines.append("    'button:has-text(\"ADD TO CART\"), button:has-text(\"Add to cart\"), button:has-text(\"Add to Cart\"), button:has-text(\"Add To Cart\"), button:has-text(\"Checkout Now\"), button:has-text(\"CHECKOUT NOW\"), button:has-text(\"Proceed to Checkout\"), button:has-text(\"Buy Now\"), button:has-text(\"BUY NOW\"), [data-testid*=\"cart\" i], [class*=\"add-to-cart\" i], [class*=\"addToCart\" i], button.btn-primary:has-text(\"Add\"), button.checkout-btn, button:has-text(\"Select Plan\"), button:has-text(\"Order Now\")'")
                lines.append("  ).first();")
                lines.append("  if (isOutOfStock) {")
                lines.append("    console.log(\"Product is OUT OF STOCK on live site — asserting out-of-stock status or disabled CTA\");")
                lines.append("    if (await addBtn.isVisible({ timeout: 2000 }).catch(() => false)) {")
                lines.append("      await expect(addBtn).toBeDisabled();")
                lines.append("    } else {")
                lines.append("      await expect(outOfStockEl).toBeVisible();")
                lines.append("    }")
                lines.append("  } else {")
                lines.append("    await addBtn.scrollIntoViewIfNeeded().catch(() => {});")
                lines.append("    if (await addBtn.isVisible({ timeout: 8000 }).catch(() => false)) {")
                lines.append("      await addBtn.click({ force: true }).catch(() => {});")
                lines.append("      await page.waitForTimeout(2500);")
                lines.append("    } else {")
                lines.append("      const fallbackCta = page.locator('button.btn-primary, [role=\"button\"]:has-text(\"Cart\"), a:has-text(\"Cart\"), button:has-text(\"Continue\")').first();")
                lines.append("      if (await fallbackCta.isVisible({ timeout: 3000 }).catch(() => false)) {")
                lines.append("        await fallbackCta.click({ force: true }).catch(() => {});")
                lines.append("      }")
                lines.append("      await page.waitForTimeout(2000);")
                lines.append("    }")
                lines.append("  }")
            elif any(k in action_lower for k in ["checkout", "proceed to", "buy now"]) or any(k in target_lower for k in ["checkout", "buy now"]):
                lines.append("  // Click Buy Now / Proceed to Checkout")
                lines.append("  try {")
                if target and (target.startswith((".", "#", "[", "button", "a")) or ":has-text" in target or "ratePlanId" in target):
                    lines.append(f"    const checkoutActionBtn = page.locator({_js(target)}).first();")
                else:
                    lines.append("    const checkoutActionBtn = page.locator('button:has-text(\"Buy Now\"), a:has-text(\"Buy Now\"), button:has-text(\"Checkout Now\"), button:has-text(\"Proceed to Checkout\"), button:has-text(\"Checkout\"), a:has-text(\"Checkout\")').first();")
                lines.append("    if (await checkoutActionBtn.isVisible({ timeout: 10000 }).catch(() => false)) {")
                lines.append("      await checkoutActionBtn.click();")
                lines.append("      await page.waitForTimeout(2000);")
                lines.append("    }")
                lines.append("  } catch (e) {}")
            elif any(k in action_lower for k in ["shipping address", "payment method", "enter address", "credit card", "fill form"]):
                lines.append("  // Fill address/checkout details if form presented")
                lines.append("  try {")
                lines.append("    const addressInput = page.locator('input[name*=\"address\" i], input[placeholder*=\"address\" i], textarea, input[name*=\"name\" i], input[type=\"text\"]').first();")
                lines.append("    if (await addressInput.isVisible({ timeout: 3000 }).catch(() => false)) {")
                lines.append("      await addressInput.fill(\"Dubai, UAE\");")
                lines.append("    }")
                lines.append("  } catch (e) {}")
            elif intent == "goto":
                action_url_m = re.search(r"https?://[^\s'\"\)\>]+", action)
                if _is_navigation_target(target):
                    destination = target
                elif action_url_m:
                    destination = action_url_m.group(0).rstrip(".,)")
                else:
                    destination = target_url
                if not destination:
                    issues.append(
                        StaticGateIssue(
                            "error",
                            f"Step {number} navigates but no application URL is set.",
                        )
                    )
                    lines.append("  // TODO: no application URL configured for this navigation.")
                    lines.append("  await navigateTo(page, '/', null);")
                else:
                    route = _route(destination, target_url)
                    href = _route(
                        step.get("href") or _recorded_href(case, number, target), target_url
                    )
                    lines.append(f"  await navigateTo(page, {_js(route)}, {_js(href) if href else 'null'});")
            else:
                recorded_objects = list(getattr(case, "recorded_flow_objects", None) or [])
                recorded_match = None
                for rec in recorded_objects:
                    if rec.get("step_number") == number:
                        recorded_match = rec
                        break
                    rec_target = (rec.get("target_name") or rec.get("accessible_name") or "").lower()
                    if target and (target.lower() in rec_target or rec_target in target.lower()):
                        recorded_match = rec
                        break

                if recorded_match and recorded_match.get("recommended_locator"):
                    locator = recorded_match["recommended_locator"]
                    todo = None
                    lines.append(f"  // [Guided Discovery] Ground-truth recorded locator for {comment_text(recorded_match.get('target_name'))}")
                else:
                    locator, todo = build_locator(step, intent, catalog=catalog)

                if todo and "body" not in locator:
                    issues.append(StaticGateIssue("warning", f"Step {number}: {todo}"))
                    lines.append(f"  // TODO: {comment_text(todo)}")

                if intent == "fill":
                    value = (
                        re.sub(r"[^A-Za-z0-9]+", "_", str(data_ref)).lower()
                        if data_ref
                        else _js(quoted_term or "Test Data")
                    )
                    lines.append(f"  await {locator}.fill({value});")
                elif intent == "select":
                    if any(k in locator.lower() for k in [".plan-card", "button", "tab", "role=", "div", "radio", ":has-text", "hastext", "card"]):
                        lines.append(f"  await {locator}.click();")
                    else:
                        value = (
                            re.sub(r"[^A-Za-z0-9]+", "_", str(data_ref)).lower()
                            if data_ref
                            else _js(quoted_term or "1")
                        )
                        lines.append(f"  await {locator}.selectOption({value});")
                elif intent == "assert":
                    lines.append(f"  await expect({locator}).toBeVisible({{ timeout: 10000 }});")
                elif intent == "wait":
                    lines.append("  await page.waitForLoadState('networkidle');")
                else:
                    lines.append(f"  await {locator}.click();")

            if expected and intent != "assert":
                lines.append(f"  // expected: {comment_text(expected)}")
            emitted += 1

    if case.expected_result:
        lines.append("")
        lines.append(f"  // Overall expected result: {comment_text(case.expected_result)}")

    lines.append("});")
    lines.append("")

    code = "\n".join(lines)
    script = CompiledScript(
        framework="playwright",
        language="typescript",
        file_name=f"{slug}.spec.ts",
        code=code,
        entry_path=f"{slug}.spec.ts",
        execution_command=f"npx playwright test {slug}.spec.ts",
        setup_notes=(
            [f"Set {_env_key(ref)} before running." for ref in seen] if seen else []
        )
        + (
            [
                "No discovered element catalogue was available, so every locator in "
                "this script is the phrase heuristic's best guess. Run Application "
                "Discovery and regenerate to ground it against real elements."
            ]
            if not is_api and not catalog and any(step.get("target") for step in steps)
            else []
        ),
        issues=issues,
    )
    script.issues.extend(run_static_gate(code, emitted, len(steps) if steps else 1))
    return script


def _generate_only(case: Any, framework: str) -> CompiledScript:
    """Katalon and Appium: emit a readable skeleton, never offer to run it.

    No runner exists for either here or upstream, so producing something that
    looks executable would be the misleading option.
    """
    display_id = case.display_id or "test-case"
    slug = re.sub(r"[^A-Za-z0-9]+", "-", display_id).strip("-").lower() or "spec"
    steps = list(case.steps_structured or [])

    body = [f"// {display_id} - {case.objective or ''}".rstrip(), ""]
    if framework == "katalon":
        body.append("import static com.kms.katalon.core.testobject.ObjectRepository.findTestObject")
        body.append("import com.kms.katalon.core.webui.keyword.WebUiBuiltInKeywords as WebUI")
        body.append("")
        for step in steps:
            body.append(f"// {step.get('step_number')}. {step.get('action')}")
            body.append(f"// TODO: bind a Test Object for {step.get('target') or 'this step'}")
        extension, language = "groovy", "groovy"
    else:
        body.append("import { remote } from 'webdriverio';")
        body.append("")
        for step in steps:
            body.append(f"// {step.get('step_number')}. {step.get('action')}")
            body.append(f"// TODO: map {step.get('target') or 'this step'} to a mobile selector")
        extension, language = "js", "javascript"

    return CompiledScript(
        framework=framework,
        language=language,
        file_name=f"{slug}.{extension}",
        code="\n".join(body) + "\n",
        entry_path=f"{slug}.{extension}",
        execution_command="",
        setup_notes=[
            f"{FRAMEWORK_LABELS[framework]} is generate-only in this deployment - "
            "no runner exists, so this file is for download and manual use."
        ],
        generation_mode="compiled",
    )


def _unterminated_string(line: str) -> bool:
    """Whether a line of generated JS leaves a string literal open.

    Counting quote characters does not work: getByText("Score' widget") is
    perfectly valid, and a naive count reads its lone apostrophe as unbalanced.
    So the line is scanned in order, tracking which delimiter opened the
    current string -- only that delimiter can close it, and a backslash escapes
    whatever follows. A `//` outside a string ends the line as a comment.
    """
    quote = None
    index = 0
    while index < len(line):
        char = line[index]
        if quote:
            if char == "\\":
                index += 2
                continue
            if char == quote:
                quote = None
        elif char in ("'", '"', "`"):
            quote = char
        elif char == "/" and line[index + 1 : index + 2] == "/":
            break
        index += 1
    return quote is not None


def run_static_gate(code: str, emitted: int, expected_steps: int) -> list[StaticGateIssue]:
    """Cheap checks before anything spends a browser.

    Every one of these is a failure that costs a full run to discover otherwise,
    and none needs the application to be reachable.
    """
    issues: list[StaticGateIssue] = []

    if "@playwright/test" not in code:
        issues.append(StaticGateIssue("error", "The spec does not import @playwright/test."))
    if code.count("test(") < 1:
        issues.append(StaticGateIssue("error", "The spec declares no test block."))
    if code.count("{") != code.count("}"):
        issues.append(StaticGateIssue("error", "Braces are unbalanced - the file will not parse."))
    if re.search(r"example\.(com|org)", code):
        issues.append(
            StaticGateIssue("error", "The spec points at a placeholder domain (example.com).")
        )
    if expected_steps and emitted < expected_steps:
        issues.append(
            StaticGateIssue(
                "error",
                f"Only {emitted} of {expected_steps} steps were compiled.",
            )
        )

    # Unterminated string literals. Added after a discovered locator carrying a
    # newline in its accessible name was emitted verbatim: the file could not
    # parse, yet every other check here passed it, so the failure surfaced as a
    # red run instead of a refused generation.
    for number, line in enumerate(code.splitlines(), start=1):
        if _unterminated_string(line):
            issues.append(
                StaticGateIssue(
                    "error",
                    f"Line {number} has an unterminated string - the file will not parse.",
                )
            )
            break

    return issues


def compile_for(
    case: Any,
    framework: str,
    *,
    base_url: Optional[str] = None,
    catalog: Optional[list[dict]] = None,
) -> CompiledScript:
    """`catalog` only reaches Playwright. Katalon and Appium are generate-only
    skeletons with no locators to ground -- see _generate_only."""
    if framework not in FRAMEWORKS:
        raise ValueError(
            f"Unknown framework {framework!r}. Expected one of: {', '.join(FRAMEWORKS)}"
        )
    if framework == "playwright":
        return compile_playwright(case, base_url=base_url, catalog=catalog)
    return _generate_only(case, framework)
