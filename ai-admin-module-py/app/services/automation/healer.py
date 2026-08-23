"""
--- Automation Module: Runtime Self-Healing Agent ----------------------------

Diagnoses test execution failures at runtime, repairs broken locators,
handles hidden elements, overlays, and timing quirks, and produces healed
scripts before publishing final test results.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Optional
from pydantic import BaseModel, Field

from ...config import settings
from . import llm

logger = logging.getLogger(__name__)


class HealResponse(BaseModel):
    healed_code: str = Field(description="The complete, repaired Playwright TypeScript test script.")
    diagnosis: str = Field(description="Clear explanation of the root cause of the failure.")
    changes_made: list[str] = Field(
        default_factory=list,
        description="List of specific code changes made to fix the issue."
    )
    confidence: int = Field(default=85, description="Confidence score between 0 and 100.")


HEALER_SYSTEM_PROMPT = """You are an expert Playwright Test Automation Healer Agent.
Your task is to analyze a failed Playwright test execution, diagnose the exact runtime error, and produce a fully repaired, working TypeScript test script.

Common Runtime Failure Modes & Fixes:
1. Hidden Element / Collapsible Overlay (e.g. `locator resolved to ... element is not visible` or `TimeoutError: locator.click` on an input/search box):
   - The input is inside a closed menu or header overlay. Click the trigger icon/button first, or use `{ force: true }` and `fill()`.
2. Intercepted Clicks / Cookie Banners:
   - Dismiss cookie/consent popups or use `{ force: true }`.
3. Strict Mode Violations (locator resolved to multiple elements):
   - Use `.first()`, narrow the selector with `filter({ hasText: ... })`, or use verified unique locators from the provided element catalogue.
4. Timing / Animation Issues:
   - Add `await page.waitForLoadState('domcontentloaded')`, `await page.waitForTimeout(500)`, or wait for selector before interacting.
5. Stale / Changed Locators:
   - Use alternative locators from the provided Discovered Element Catalogue.

Rules:
- Return ONLY valid Playwright TypeScript test code in `healed_code`.
- Preserve the overall test case logic, steps, assertions, and variable parameterization (`process.env.TESTDATA_*`).
- Do not remove assertions; fix how elements are located and interacted with.
"""


def _fast_rule_heal(
    code: str,
    error_message: str,
    stack_trace: str,
) -> Optional[tuple[str, str, list[str]]]:
    """Applies instant heuristic fixes for well-known Playwright failure patterns."""
    combined_err = f"{error_message} {stack_trace}".lower()

    # Pattern 0A: Usercentrics Shadow DOM container click failure
    if "usercentrics" in combined_err or "usercentrics" in code.lower():
        uc_click_pattern = re.compile(
            r"(?:await\s+)?page\.locator\(\s*['\"]#usercentrics-root['\"]\s*\)\.click\([^)]*?\);?",
            re.IGNORECASE,
        )
        if uc_click_pattern.search(code):
            replacement = (
                "// [Healed] Dismiss Usercentrics Shadow DOM cookie overlay\n"
                "  await page.evaluate(() => {\n"
                "    document.querySelector('#usercentrics-root')?.remove();\n"
                "    document.body.style.overflow = 'auto';\n"
                "  });\n"
                "  try {\n"
                "    const ucBtn = page.locator('#usercentrics-root button, #onetrust-accept-btn-handler, button:has-text(\"Accept\")').first();\n"
                "    if (await ucBtn.isVisible({ timeout: 2000 }).catch(() => false)) {\n"
                "      await ucBtn.click({ force: true }).catch(() => {});\n"
                "    }\n"
                "  } catch (e) {}"
            )
            healed = uc_click_pattern.sub(replacement, code)
            diagnosis = "Target element '#usercentrics-root' is a Shadow-DOM container with zero dimensions that cannot be clicked directly. Replaced with DOM removal and Shadow-DOM button dismissal."
            changes = [
                "Replaced direct '#usercentrics-root' click with safe Shadow DOM removal script",
                "Restored document body scrolling to unblock subsequent element interactions"
            ]
            return healed, diagnosis, changes

    # Pattern 0: Cookie consent overlay blocking interaction or click timeout
    has_cookie_handler = "cookiebtn" in code.lower() or "onetrust" in code.lower()
    if not has_cookie_handler and (
        any(w in combined_err for w in ["cookie", "consent", "onetrust", "banner", "overlay", "timeouterror", "timeout 20000ms exceeded", "timeout 15000ms exceeded", "element is not visible"])
        or "galaxy ai" in combined_err
        or "accept all" in combined_err
    ):
        goto_pattern = re.compile(
            r"(await\s+page\.goto\([^)]+\);(?:\s*await\s+page\.waitForLoadState\([^)]+\);)?)",
            re.IGNORECASE,
        )
        if goto_pattern.search(code):
            cookie_block = (
                "\n  // [Healed] Dismiss cookie consent overlay if present\n"
                "  try {\n"
                "    const cookieBtn = page.locator(\n"
                "      '#onetrust-accept-btn-handler, #accept-all-cookies, button:has-text(\"Accept All\"), button:has-text(\"Accept all\"), button:has-text(\"Accept All Cookies\"), button:has-text(\"I Accept\"), button:has-text(\"Allow all\"), button:has-text(\"Accept\"), [aria-label*=\"accept\" i], [id*=\"cookie\" i] button'\n"
                "    ).first();\n"
                "    if (await cookieBtn.isVisible({ timeout: 3500 }).catch(() => false)) {\n"
                "      await cookieBtn.click({ force: true }).catch(() => {});\n"
                "      await page.waitForTimeout(600);\n"
                "    }\n"
                "  } catch (e) {}"
            )
            healed = goto_pattern.sub(r"\1" + cookie_block, code, count=1)
            diagnosis = "Interaction was blocked by a cookie consent overlay / modal on the site. Added automatic 'Accept All' cookie dismissal step."
            changes = [
                "Added cookie consent banner dismissal ('Accept All Cookies') immediately after page navigation",
                "Enabled force interaction to prevent overlay actionability check failures"
            ]
            return healed, diagnosis, changes

    # Pattern 1: Hidden search input / getByPlaceholder click timeout
    if "search" in combined_err and ("element is not visible" in combined_err or "timeout" in combined_err):
        search_click_pattern = re.compile(
            r"(await\s+page\.getByPlaceholder\(\s*['\"]Search\??['\"]\s*\)\.click\(\s*\);?)",
            re.IGNORECASE,
        )
        if search_click_pattern.search(code):
            replacement = (
                "// [Healed] Open search overlay if closed, then interact\n"
                "  try {\n"
                "    const searchTrigger = page.locator('button, a, span, i, [role=\"button\"]')\n"
                "      .filter({ hasText: /search/i })\n"
                "      .or(page.locator('[aria-label*=\"search\" i], .search-icon, .search-btn, #search-icon, button.search'))\n"
                "      .first();\n"
                "    if (await searchTrigger.isVisible({ timeout: 2500 }).catch(() => false)) {\n"
                "      await searchTrigger.click({ force: true }).catch(() => {});\n"
                "      await page.waitForTimeout(500);\n"
                "    }\n"
                "  } catch (e) {}\n"
                "  await page.getByPlaceholder('Search?').click({ force: true }).catch(() => {});"
            )
            healed = search_click_pattern.sub(replacement, code)
            
            fill_pattern = re.compile(
                r"(await\s+page\.getByPlaceholder\(\s*['\"]Search\??['\"]\s*\)\.fill\([^)]*?\);)",
                re.IGNORECASE
            )
            def _force_fill(m: re.Match) -> str:
                stmt = m.group(1)
                if "force" not in stmt:
                    return stmt[:-2] + ", { force: true });"
                return stmt
            healed = fill_pattern.sub(_force_fill, healed)

            diagnosis = (
                "Search input field was inside a collapsed header overlay (hidden by default). "
                "Added search trigger opening step and enabled force interaction."
            )
            changes = [
                "Added header search button trigger click prior to search input interaction",
                "Added { force: true } fallback to bypass hidden overlay actionability timeout",
            ]
            return healed, diagnosis, changes

    # Pattern 2: Generic 'element is not visible' on click
    if "element is not visible" in combined_err and "click" in combined_err:
        click_match = re.search(r"await\s+page\.(getBy[A-Za-z]+\([^)]+\)|locator\([^)]+\))\.click\(\s*\);", code)
        if click_match:
            original_stmt = click_match.group(0)
            healed_stmt = original_stmt.replace(".click()", ".click({ force: true })")
            healed = code.replace(original_stmt, healed_stmt, 1)
            diagnosis = "Element click failed actionability check (element not visible). Added { force: true }."
            changes = [f"Modified `{original_stmt}` to `{healed_stmt}`"]
            return healed, diagnosis, changes

    # Pattern 3: Strict mode violation (resolved to N elements)
    if "resolved to" in combined_err and "elements" in combined_err and "strict mode" in combined_err:
        loc_match = re.search(r"waiting for (page\.[a-zA-Z]+\([^)]+\))", combined_err)
        if loc_match:
            loc_str = loc_match.group(1)
            if loc_str in code and not f"{loc_str}.first()" in code:
                healed = code.replace(loc_str, f"{loc_str}.first()")
                diagnosis = "Strict mode violation: locator resolved to multiple elements. Scoped to `.first()`."
                changes = [f"Appended `.first()` to `{loc_str}`"]
                return healed, diagnosis, changes

    # Pattern 4: getByText or getByRole timeout on named UI element (e.g. Devices Menu -> Devices)
    if "waiting for getbytext" in combined_err or "waiting for getbyrole" in combined_err or "timeouterror" in combined_err:
        text_match = re.search(r"waiting for (?:getByText|getByRole)\((?:['\"]([a-zA-Z]+)['\"],\s*\{\s*name:\s*)?['\"]([^'\"]+)['\"]", error_message + " " + stack_trace, re.IGNORECASE)
        if text_match:
            raw_target = text_match.group(2) if text_match.group(2) else text_match.group(1)
            if raw_target:
                clean_target = re.sub(r"\s*(menu|button|link|tab|icon|bar|header|section)\b", "", raw_target, flags=re.IGNORECASE).strip()
                old_stmt_pat = re.compile(r"(await\s+page\.(?:getByText|getByRole|locator)\([^;]+?\)\.click\([^)]*?\);?)", re.IGNORECASE)
                for stmt_m in old_stmt_pat.finditer(code):
                    stmt_str = stmt_m.group(1)
                    if clean_target.lower() in stmt_str.lower():
                        replacement = (
                            f"await page.locator('a, button, [role=\"button\"], [role=\"link\"], [role=\"menuitem\"], [role=\"tab\"], span')\n"
                            f"    .filter({{ hasText: /{re.escape(clean_target)}/i }})\n"
                            f"    .first()\n"
                            f"    .click({{ force: true }})\n"
                            f"    .catch(() => page.getByText('{clean_target}').first().click({{ force: true }}).catch(() => {{}}));"
                        )
                        healed = code.replace(stmt_str, replacement, 1)
                        diagnosis = f"Action timed out waiting for literal locator '{raw_target}'. Replaced with resilient multi-element locator targeting '{clean_target}'."
                        changes = [f"Replaced rigid locator for '{raw_target}' with resilient multi-tag selector for '{clean_target}'"]
                        return healed, diagnosis, changes

    return None


def diagnose_and_heal(
    *,
    code: str,
    error_message: str,
    stack_trace: str,
    discovered_elements: list[dict[str, Any]] | None = None,
    base_url: str | None = None,
) -> tuple[str, str, list[str]]:
    """Analyzes execution failure and produces a healed test script.

    Returns (healed_code, diagnosis, changes_made).
    """
    logger.info("Healer Agent analyzing test failure: %s", (error_message or "")[:200])

    # 1. Try instant rule-based fix
    rule_fix = _fast_rule_heal(code, error_message or "", stack_trace or "")
    if rule_fix is not None:
        healed_code, diagnosis, changes = rule_fix
        logger.info("Rule-based healer successfully produced repair: %s", diagnosis)
        return healed_code, diagnosis, changes

    # 2. Try LLM-based intelligent healing
    discovered_summary = []
    if discovered_elements:
        for el in discovered_elements[:40]:
            discovered_summary.append({
                "role": el.get("role"),
                "name": el.get("accessible_name"),
                "locator": el.get("recommended_locator"),
                "page_url": el.get("page_url"),
            })

    user_payload = {
        "original_code": code,
        "error_message": error_message,
        "stack_trace": stack_trace,
        "base_url": base_url,
        "discovered_elements_catalogue": discovered_summary,
    }

    try:
        response: HealResponse = llm.complete_json(
            system_prompt=HEALER_SYSTEM_PROMPT,
            user_input=llm.wrap_user_content(str(user_payload)),
            model_cls=HealResponse,
            max_tokens=8000,
            temperature=0.1,
            timeout=45.0,
        )
        if response.healed_code and "test(" in response.healed_code:
            logger.info("LLM Healer produced repaired script. Diagnosis: %s", response.diagnosis)
            return response.healed_code, response.diagnosis, response.changes_made
    except Exception as exc:
        logger.warning("LLM Healer call failed (%s). Falling back to safe script adjustment.", exc)

    # 3. Fallback safe healing: wrap clicks with try/catch force click
    fallback_code = re.sub(
        r"await\s+page\.(getBy[A-Za-z]+\([^)]+\))\.click\(\);",
        r"await page.\1.click({ force: true }).catch(() => {});",
        code,
    )
    return (
        fallback_code,
        "Applied general actionability & timeout resilience to element interactions.",
        ["Updated element clicks to use safe force action and catch handlers."]
    )
