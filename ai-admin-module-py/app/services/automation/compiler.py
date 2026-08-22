"""
--- Automation Module: script compilation -----------------------------------

Turns a refined test case's structured steps into a runnable script.

Deterministic, not a model call. Refinement has already done the language work:
it produced one observable interaction per step, named the element in `target`,
and moved every literal value out into `test_data_ref`. What is left is
mechanical translation, and a template does it the same way every time -- which
is what makes a regenerated script diffable, and what stops a green run being
evidence that the model happened to behave.

The locator policy is the part worth reading. A refined `target` is a human
phrase ("the 'Submit' button", "Username field"), not a selector, so it is
mapped onto Playwright's accessible-name queries rather than CSS. Those match
what a user sees, survive markup changes, and fail loudly when the element is
not there. Where a phrase cannot be classified, the compiler emits a getByText
fallback AND a TODO, so an unresolvable locator is visible in review rather
than discovered on a red run.

Katalon and Appium are generate-only: the code is produced and downloadable,
but no runner exists for them here or upstream, so nothing offers to execute it.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Optional

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


def _intent(action: str) -> str:
    lowered = (action or "").lower()
    for pattern, intent in _INTENTS:
        if re.search(pattern, lowered):
            return intent
    return "click"


def _clean_target(target: str) -> str:
    """Strip the noun that told us the role, and any surrounding quotes."""
    text = (target or "").strip()
    text = re.sub(r"^(the|a|an)\s+", "", text, flags=re.IGNORECASE)
    text = re.sub(
        r"\s*\b(button|link|checkbox|radio|tab|menu ?item|field|input|text ?box|box|heading|title)\b\s*$",
        "",
        text,
        flags=re.IGNORECASE,
    )
    return text.strip().strip("'\"").strip()


def build_locator(target: Optional[str], intent: str) -> tuple[str, Optional[str]]:
    """Map a human phrase onto a Playwright query.

    Returns (expression, todo). `todo` is set when the phrase could not be
    classified, so the caller can leave a visible marker instead of pretending
    the guess is sound.
    """
    if not target or not target.strip():
        return "page", "No target on this step — the locator is a guess."

    raw = target.strip()
    name = _clean_target(raw)
    lowered = raw.lower()

    for pattern, role in _ROLE_HINTS:
        if re.search(pattern, lowered):
            return f"page.getByRole({_js(role)}, {{ name: {_js(name)} }})", None

    if any(re.search(p, lowered) for p in _FIELD_HINTS) or intent in ("fill", "select"):
        return f"page.getByLabel({_js(name)})", None

    # A path or URL is a destination, not an element.
    if raw.startswith(("/", "http://", "https://")):
        return "page", None

    return (
        f"page.getByText({_js(name)})",
        f"Could not tell what kind of element {raw!r} is — using a text match.",
    )


def compile_playwright(case: Any, *, base_url: Optional[str] = None) -> CompiledScript:
    """Render a Playwright spec from a refined case."""
    steps = list(case.steps_structured or [])
    display_id = case.display_id or "test-case"
    slug = re.sub(r"[^A-Za-z0-9]+", "-", display_id).strip("-").lower() or "spec"
    title = f"{display_id} - {case.objective or case.description or 'automated test'}"

    lines: list[str] = [
        "import { test, expect } from '@playwright/test';",
        "",
        "/**",
        f" * {display_id}",
        f" * {(case.objective or '').strip()}",
        " *",
        " * Compiled from refined steps. Values come from environment variables so",
        " * no credential or record id is baked into the file.",
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
    lines.append(f"test({_js(title[:160])}, async ({{ page }}) => {{")

    target_url = (base_url or case.application_url or "").strip()
    issues: list[StaticGateIssue] = []
    emitted = 0

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
        lines.append(f"  // {number}. {action}")

        if intent == "goto":
            destination = target if (target or "").startswith(("/", "http")) else target_url
            if not destination:
                issues.append(
                    StaticGateIssue(
                        "error",
                        f"Step {number} navigates but no application URL is set.",
                    )
                )
                lines.append("  // TODO: no application URL configured for this navigation.")
                lines.append(f"  await page.goto({_js('/')});")
            else:
                lines.append(f"  await page.goto({_js(destination)});")
        else:
            locator, todo = build_locator(target, intent)
            if todo:
                issues.append(StaticGateIssue("warning", f"Step {number}: {todo}"))
                lines.append(f"  // TODO: {todo}")

            if intent == "fill":
                value = (
                    re.sub(r"[^A-Za-z0-9]+", "_", str(data_ref)).lower()
                    if data_ref
                    else _js("")
                )
                if not data_ref:
                    issues.append(
                        StaticGateIssue(
                            "warning",
                            f"Step {number} enters a value but names no test data key.",
                        )
                    )
                lines.append(f"  await {locator}.fill({value});")
            elif intent == "select":
                value = (
                    re.sub(r"[^A-Za-z0-9]+", "_", str(data_ref)).lower()
                    if data_ref
                    else _js("")
                )
                lines.append(f"  await {locator}.selectOption({value});")
            elif intent == "assert":
                lines.append(f"  await expect({locator}).toBeVisible();")
            elif intent == "wait":
                lines.append("  await page.waitForLoadState('networkidle');")
            else:
                lines.append(f"  await {locator}.click();")

        if expected and intent != "assert":
            lines.append(f"  // expected: {str(expected).strip()}")
        emitted += 1

    if case.expected_result:
        lines.append("")
        lines.append(f"  // Overall expected result: {str(case.expected_result).strip()}")

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
        ),
        issues=issues,
    )
    script.issues.extend(run_static_gate(code, emitted, len(steps)))
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
    return issues


def compile_for(case: Any, framework: str, *, base_url: Optional[str] = None) -> CompiledScript:
    if framework not in FRAMEWORKS:
        raise ValueError(
            f"Unknown framework {framework!r}. Expected one of: {', '.join(FRAMEWORKS)}"
        )
    if framework == "playwright":
        return compile_playwright(case, base_url=base_url)
    return _generate_only(case, framework)
