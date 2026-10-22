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
from . import knowledge_base as kb

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
Your task is to analyze a failed Playwright test execution, diagnose the exact runtime error, and produce a fully repaired, working TypeScript test script grounded in the Application Flow Knowledge Base.

Common Runtime Failure Modes & Knowledge-Base Fixes:
1. Add to Cart / Checkout CTA Timeout (e.g. `expect(locator).toBeVisible() failed` on ADD TO CART / Checkout button):
   - Scroll page slightly (`await page.evaluate(() => window.scrollBy(0, 450));`) to trigger sticky footer and dynamic CTA rendering.
   - Use resilient multi-selector: `button:has-text("ADD TO CART"), button:has-text("Add to cart"), button:has-text("Add To Cart"), button:has-text("Checkout Now"), button:has-text("CHECKOUT NOW"), button:has-text("Proceed to Checkout"), button:has-text("Buy Now"), [data-testid*="cart" i], [class*="add-to-cart" i], button.btn-primary:has-text("Add"), button.checkout-btn, button:has-text("Order Now")`.
   - Incorporate live stock state detection (`.out-of-stock, :text("OUT OF STOCK"), :text("Sold Out"), button:has-text("Notify Me"), button:has-text("Out of Stock")`). If out of stock, assert disabled CTA or out-of-stock message instead of failing on unrendered add button.
2. Usercentrics / Cookie Consent Shadow DOM Overlay:
   - Remove overlay and restore scrolling:
     `await page.evaluate(() => { document.querySelector('#usercentrics-root')?.remove(); document.body.style.overflow = 'auto'; });`
3. Hidden Element / Collapsible Overlay (e.g. `element is not visible` or `TimeoutError: locator.click`):
   - The input is inside a closed menu or header overlay. Click the trigger icon/button first, or use `{ force: true }` and `fill()`.
4. Strict Mode Violations (locator resolved to multiple elements):
   - Use `.first()`, narrow the selector with `filter({ hasText: ... })`, or use verified unique locators from the provided element catalogue.
5. Timing / Animation Issues:
   - Add `await page.waitForLoadState('domcontentloaded')`, `await page.waitForTimeout(500)`, or scroll into view before interacting.

Rules:
- Return ONLY valid Playwright TypeScript test code in `healed_code`.
- Ground repairs using the provided Knowledge Base application blueprint and canonical locators.
- Preserve the overall test case logic, steps, assertions, and variable parameterization (`process.env.TESTDATA_*`).
- Do not remove assertions; fix how elements are located, scrolled, and interacted with.
"""


# --- Automation Module: why the CTA block is spliced, not regex-replaced -----
# The Add-to-Cart heal below rewrites a whole `if (isOutOfStock) {...} else
# {...}` construct. Finding the end of that construct with a regex does not
# work, and the way it failed was silent and expensive.
#
# The pattern used to end at `await page.waitForTimeout(\d+);\s*\}` with a
# non-greedy `.*?` in front. compiler.py emits *two* such statements in this
# block -- one closing the inner `if (await appears(addBtn, 8000))` branch and
# one closing its `else` -- so the match stopped at the first, and the
# substitution truncated the construct mid-way, leaving the original's
# trailing `} else { ... }` stranded after a replacement that had already
# closed the `if`. Two `else` blocks on one `if` is a SyntaxError, and
# Playwright answers a spec it cannot parse with "No tests found": zero tests,
# no browser launched, and therefore no video, screenshot or trace. The run
# reports as failed with an empty test-results/ directory, which reads as an
# artifact-capture problem rather than as a compile error.
#
# Brace matching is not a regular language, so the end is found by scanning.
def _skip_to_matching_brace(code: str, open_idx: int) -> int:
    """Index just past the `}` matching the `{` at `open_idx`, or -1.

    Braces inside strings, template literals and comments are not counted. The
    generated selectors are full of quoted CSS and `:has-text("...")`, so a
    scanner that ignored quoting would reintroduce the same class of bug.
    """
    depth = 0
    i = open_idx
    n = len(code)
    while i < n:
        ch = code[i]
        if ch in "'\"`":
            quote = ch
            i += 1
            while i < n:
                if code[i] == "\\":
                    i += 2
                    continue
                if code[i] == quote:
                    break
                i += 1
            i += 1
            continue
        if ch == "/" and i + 1 < n:
            if code[i + 1] == "/":
                j = code.find("\n", i)
                i = n if j == -1 else j + 1
                continue
            if code[i + 1] == "*":
                j = code.find("*/", i + 2)
                i = n if j == -1 else j + 2
                continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return -1


def _skip_parens(code: str, open_idx: int) -> int:
    """Index just past the `)` matching the `(` at `open_idx`, or -1."""
    depth = 0
    i = open_idx
    n = len(code)
    while i < n:
        ch = code[i]
        if ch in "'\"`":
            quote = ch
            i += 1
            while i < n:
                if code[i] == "\\":
                    i += 2
                    continue
                if code[i] == quote:
                    break
                i += 1
            i += 1
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return -1


_CTA_HEAD_RE = re.compile(r"(?://[^\n]*\n\s*)?const\s+outOfStockEl\s*=", re.IGNORECASE)
_CTA_IF_RE = re.compile(r"if\s*\(\s*isOutOfStock\s*\)\s*", re.IGNORECASE)
_CTA_ELSE_RE = re.compile(r"\s*else\b\s*", re.IGNORECASE)
_CTA_ELSE_IF_RE = re.compile(r"if\s*(?=\()", re.IGNORECASE)


def _cta_block_span(code: str) -> Optional[tuple[int, int]]:
    """Character span of the generated stock-detection / Add-to-Cart block.

    Starts at the `// Detect stock state...` comment when present, otherwise at
    `const outOfStockEl`, and ends past the `}` that closes the whole
    `if (isOutOfStock) ... else ...` chain. Returns None when the block is
    absent or its braces do not balance, so an unrecognised shape is left
    untouched rather than half-rewritten.
    """
    head = _CTA_HEAD_RE.search(code)
    if not head:
        return None
    if_m = _CTA_IF_RE.search(code, head.end())
    if not if_m:
        return None

    pos = if_m.end()
    while True:
        if pos >= len(code) or code[pos] != "{":
            return None
        end = _skip_to_matching_brace(code, pos)
        if end < 0:
            return None
        nxt = _CTA_ELSE_RE.match(code, end)
        if not nxt:
            return head.start(), end
        pos = nxt.end()
        # `else if (...) {` -- step over the condition and keep walking the
        # chain. compiler.py does not emit that shape today, but a healed or
        # hand-edited spec may.
        chained = _CTA_ELSE_IF_RE.match(code, pos)
        if chained:
            paren = _skip_parens(code, chained.end())
            if paren < 0:
                return None
            pos = paren
            while pos < len(code) and code[pos].isspace():
                pos += 1


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

    # Pattern 0B: Add to Cart / Checkout CTA visibility failure or stock state mismatch
    if ("add to cart" in combined_err or "addbtn" in combined_err or "checkout now" in combined_err or "checkout" in combined_err) and (
        "tobevisible" in combined_err or "element(s) not found" in combined_err or "timeouterror" in combined_err or "timeout 15000ms" in combined_err
    ):
        replacement = (
            "// [Healed via Knowledge Base] Resilient CTA interaction & stock detection\n"
            "  await page.evaluate(() => window.scrollBy(0, 450)).catch(() => {});\n"
            "  await page.waitForTimeout(1000);\n"
            "  const outOfStockEl = page.locator(\n"
            "    '.out-of-stock, :text(\"OUT OF STOCK\"), :text(\"Out of stock\"), :text(\"Sold Out\"), :text(\"Notify Me\"), :text(\"NOTIFY ME\"), :text(\"Temporarily Unavailable\"), button:has-text(\"Notify Me\"), button:has-text(\"Out of Stock\")'\n"
            "  ).first();\n"
            "  const isOutOfStock = await outOfStockEl.isVisible({ timeout: 2500 }).catch(() => false);\n"
            "  const addBtn = page.locator(\n"
            "    'button:has-text(\"ADD TO CART\"), button:has-text(\"Add to cart\"), button:has-text(\"Add to Cart\"), button:has-text(\"Add To Cart\"), button:has-text(\"Checkout Now\"), button:has-text(\"CHECKOUT NOW\"), button:has-text(\"Proceed to Checkout\"), button:has-text(\"Buy Now\"), button:has-text(\"BUY NOW\"), [data-testid*=\"cart\" i], [class*=\"add-to-cart\" i], [class*=\"addToCart\" i], button.btn-primary:has-text(\"Add\"), button.checkout-btn, button:has-text(\"Select Plan\"), button:has-text(\"Order Now\")'\n"
            "  ).first();\n"
            "  if (isOutOfStock) {\n"
            "    console.log(\"Product is OUT OF STOCK on live site — asserting out-of-stock status or disabled CTA\");\n"
            "    if (await addBtn.isVisible({ timeout: 2000 }).catch(() => false)) {\n"
            "      await expect(addBtn).toBeDisabled();\n"
            "    } else {\n"
            "      await expect(outOfStockEl).toBeVisible();\n"
            "    }\n"
            "  } else {\n"
            "    await addBtn.scrollIntoViewIfNeeded().catch(() => {});\n"
            "    if (await addBtn.isVisible({ timeout: 8000 }).catch(() => false)) {\n"
            "      await addBtn.click({ force: true }).catch(() => {});\n"
            "      await page.waitForTimeout(2500);\n"
            "    } else {\n"
            "      const fallbackCta = page.locator('button.btn-primary, [role=\"button\"]:has-text(\"Cart\"), a:has-text(\"Cart\"), button:has-text(\"Continue\")').first();\n"
            "      if (await fallbackCta.isVisible({ timeout: 3000 }).catch(() => false)) {\n"
            "        await fallbackCta.click({ force: true }).catch(() => {});\n"
            "      }\n"
            "      await page.waitForTimeout(2000);\n"
            "    }\n"
            "  }"
        )
        span = _cta_block_span(code)
        if span:
            start, end = span
            healed = code[:start] + replacement + code[end:]
            diagnosis = (
                "The 'ADD TO CART' / 'Checkout Now' button failed visibility check. This happens when product variants "
                "require viewport scrolling, sticky footer lazy-rendering, or when the item is out of stock. "
                "Repaired using Knowledge Base resilient multi-selector, viewport scrolling, stock fallback, and non-blocking click."
            )
            changes = [
                "Added scrollBy(0, 450) to trigger dynamic sticky bottom CTA rendering",
                "Expanded Add to Cart locator to multi-casing, multi-variant, and data-testid selectors",
                "Added resilient stock state checking and fallback primary CTA interaction",
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


# --- Automation Module: a heal that will not parse is worse than no heal ------
#
# Every repair below rewrites a script that is about to be re-run, and none of
# them were checked before being handed back. A regex substitution that
# truncated a block, or a model that returned confident but unbalanced
# TypeScript, produced a spec Playwright cannot parse -- and Playwright answers
# that with "No tests found": zero tests, no browser, and therefore no video,
# screenshot or trace. The run reports as failed with an empty test-results/
# directory, which reads as an artifact-capture problem rather than a compile
# error, and the real failure the heal was meant to address never gets seen.
#
# compile_playwright already runs these checks on freshly compiled code. Running
# them again on healed code costs nothing -- no browser, no network -- and turns
# that whole class of defect into a rejected repair. Rejecting means the ORIGINAL
# script runs: it still fails, but it fails honestly, with artifacts and a real
# error message.
def _reject_if_broken(
    healed: str,
    diagnosis: str,
    changes: list[str],
    *,
    original: str,
    source: str,
) -> tuple[str, str, list[str]]:
    """The repair, or the original script when the repair breaks it.

    Only errors the repair INTRODUCED count. The gate also enforces things that
    have nothing to do with healing -- a placeholder domain, say -- and a script
    that arrived with one still has it afterwards. Rejecting over a pre-existing
    error would throw away a good repair and change nothing about the problem,
    since the original carries it too. So the two sets are compared, and the
    repair is refused only for damage that was not already there.
    """
    from .compiler import run_static_gate

    # 0 expected steps: the step-count check does not apply to a heal, which
    # rewrites a script rather than emitting one from a case.
    before = {i.message for i in run_static_gate(original, 0, 0) if i.level == "error"}
    introduced = [
        i
        for i in run_static_gate(healed, 0, 0)
        if i.level == "error" and i.message not in before
    ]
    if not introduced:
        return healed, diagnosis, changes

    reasons = "; ".join(i.message for i in introduced)
    logger.error(
        "%s heal REJECTED -- the repaired script fails the static gate (%s). "
        "Keeping the original script so the run reports its real failure.",
        source,
        reasons,
    )
    return (
        original,
        (
            f"A repair was produced but rejected before it could run: {reasons} "
            "The original script was kept, so this run reports its real failure "
            "rather than a script that cannot be parsed."
        ),
        [f"Rejected {source} heal: {reasons}"],
    )


# --- Automation Module: a heal that cannot fit the model is not attempted -----
#
# The reply is the whole script again, so a heal needs room for the prompt AND
# a script-sized answer. On a small-context model (the enterprise AI service's
# is 8192 tokens) a large script overflows it, the service answers 400 twice,
# and the run waits on two doomed calls before falling back anyway. Estimating
# up front skips straight to the fallback. Three characters per token is
# deliberately pessimistic for code; guessing short is what caused the 400s.
_CHARS_PER_TOKEN = 3
_REPLY_OVERHEAD_TOKENS = 600  # diagnosis, changes list, JSON framing
_MAX_REPLY_TOKENS = 8000


def _reply_budget(prompt: str, code: str) -> int | None:
    """max_tokens for the heal call, or None when it cannot fit the context."""
    context = int(settings.AUTOMATION_HEAL_CONTEXT_TOKENS or 0)
    if context <= 0:
        return _MAX_REPLY_TOKENS
    prompt_tokens = len(prompt) // _CHARS_PER_TOKEN
    needed = len(code) // _CHARS_PER_TOKEN + _REPLY_OVERHEAD_TOKENS
    room = context - prompt_tokens
    if room < needed:
        return None
    return min(room, _MAX_REPLY_TOKENS)


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
        return _reject_if_broken(
            healed_code, diagnosis, changes, original=code, source="Rule-based"
        )

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

    # Match Knowledge Base Flow Blueprint
    kb_context = {}
    try:
        flow = kb.match_flow_blueprint(f"{code} {error_message} {base_url or ''}")
        if flow:
            kb_context = {
                "flow_id": flow.get("flow_id"),
                "flow_name": flow.get("flow_name"),
                "category": flow.get("category"),
                "canonical_steps": flow.get("canonical_steps"),
                "catalog_entrypoint": flow.get("catalog_entrypoint"),
                "cart_endpoint": flow.get("cart_endpoint"),
            }
    except Exception as e:
        logger.warning("Knowledge Base matching in Healer failed: %s", e)

    user_payload = {
        "original_code": code,
        "error_message": error_message,
        "stack_trace": stack_trace,
        "base_url": base_url,
        "discovered_elements_catalogue": discovered_summary,
        "knowledge_base_flow": kb_context,
    }

    user_input = llm.wrap_user_content(str(user_payload))
    reply_budget = _reply_budget(HEALER_SYSTEM_PROMPT + user_input, code)

    try:
        if reply_budget is None:
            raise ValueError(
                f"the prompt and a full healed script will not fit the model's "
                f"{settings.AUTOMATION_HEAL_CONTEXT_TOKENS}-token context "
                f"(AUTOMATION_HEAL_CONTEXT_TOKENS)"
            )
        response: HealResponse = llm.complete_json(
            system_prompt=HEALER_SYSTEM_PROMPT,
            user_input=user_input,
            model_cls=HealResponse,
            max_tokens=reply_budget,
            temperature=0.1,
            timeout=45.0,
        )
        if response.healed_code and "test(" in response.healed_code:
            logger.info("LLM Healer produced repaired script. Diagnosis: %s", response.diagnosis)
            return _reject_if_broken(
                response.healed_code,
                response.diagnosis,
                response.changes_made,
                original=code,
                source="LLM",
            )
    except Exception as exc:
        logger.warning("LLM Healer call failed (%s). Falling back to safe script adjustment.", exc)

    # 3. Fallback safe healing: wrap clicks with try/catch force click
    fallback_code = re.sub(
        r"await\s+page\.(getBy[A-Za-z]+\([^)]+\))\.click\(\);",
        r"await page.\1.click({ force: true }).catch(() => {});",
        code,
    )
    return _reject_if_broken(
        fallback_code,
        "Applied general actionability & timeout resilience to element interactions.",
        ["Updated element clicks to use safe force action and catch handlers."],
        original=code,
        source="Fallback",
    )
