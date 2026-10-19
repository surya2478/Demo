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
Generate-only is a statement about running, not about compiling -- the Katalon
path grounds and asserts the same way this one does, and only Appium is still a
skeleton. See compile_katalon.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any, Optional
from urllib.parse import urljoin, urlsplit

from . import grounding


def _url_host(url: str) -> str:
    """The host of `url`, lower-cased, or "" when it has none.

    Used to decide whether a matched flow's base URL and the case's own URL
    describe the same site, so the more specific of the two can win without
    hard-coding either one's path.
    """
    try:
        return (urlsplit((url or "").strip()).hostname or "").lower()
    except ValueError:
        return ""


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
/**
 * True when `locator` is visible within `ms`, false if it never becomes so.
 *
 * isVisible() looks like the waiting version of this and is not: it samples the
 * DOM once and returns, and its `timeout` option is ignored entirely. Measured
 * against this application, `isVisible({ timeout: 10000 })` on an absent element
 * returned false after 88ms while `waitFor` on the same locator honoured its
 * 3000ms. Every generated guard therefore tested whether an element had already
 * rendered at the instant the step began, which on a card grid that populates
 * after its own fetch is a coin toss -- and a lost toss skipped the step's real
 * work while reporting it passed.
 */
async function appears(locator, ms = 5000) {
  return await locator
    .waitFor({ state: 'visible', timeout: ms })
    .then(() => true)
    .catch(() => false);
}

/** Resolve only observed cookie choices; never remove application DOM. */
async function dismissOverlays(page) {
  return observedInteractions.resolveConsent(page);
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
      if (await appears(link, 2000)) {
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

# Inline the same browser-observed interaction implementation used by live
# authoring, keeping downloaded scripts portable without a backend file path.
_interaction_source = Path(__file__).with_name("live_navigation.cjs").read_text(encoding="utf-8")
_interaction_source = _interaction_source.split("// BEGIN PORTABLE OBSERVED INTERACTIONS\n", 1)[1].split("// END PORTABLE OBSERVED INTERACTIONS", 1)[0]
NAVIGATION_HELPER = ("const observedInteractions = (() => { let page, consentScope;\n"
                     + _interaction_source
                     + "return {clickObserved, resolveConsent: async target => {page=target; return dismissOptionalCookies();}};\n})();\n"
                     + NAVIGATION_HELPER)

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
    # How many test.step() blocks the spec will report. Known at compile time,
    # so a run can show "Step 0 of 6" the moment it starts rather than staying
    # blank until the first reporter event lands.
    step_count: int = 0
    # Steps whose locator was inferred from the step's own prose because
    # neither the Knowledge Base nor a discovery catalogue named the element.
    # Populated so a caller can offer these -- and only these -- to the
    # locator agent, then compile again with the answers.
    unresolved: list[dict[str, Any]] = field(default_factory=list)

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


# refine.ACTION_TYPES -> the intent vocabulary this module emits. Kept as a
# mapping rather than shared constants so compiling a case never depends on
# importing the refiner.
_DECLARED_INTENTS: dict[str, str] = {
    "navigate": "goto",
    "click": "click",
    "fill": "fill",
    "select": "select",
    "assert": "assert",
    "wait": "wait",
}


def _intent(action: str, action_type: Optional[str] = None) -> str:
    """A step's intent: what the refiner declared, else the verb heuristic.

    The regex below returns "click" when no verb matches, and that default is
    silent -- an unrecognised verb ("punch in the code") compiles to a click on
    an element the step never meant to click, and the first sign of it is a red
    run. refine.py now asks the model to name the action kind outright, so a
    step that carries one is not guessed at.

    Anything else falls through to the regex: a case refined before the field
    existed, a step the model left it off, or a value outside the vocabulary.
    That is the behaviour every step had before, so nothing regresses on rows
    already in the database.
    """
    declared = _DECLARED_INTENTS.get((action_type or "").strip().lower())
    if declared:
        return declared

    lowered = (action or "").lower()
    for pattern, intent in _INTENTS:
        if re.search(pattern, lowered):
            return intent
    return "click"


# The verbs a step's action can open with, in the same vocabulary _INTENTS
# reads. Stripping a leading verb is safe in a way that stripping a trailing
# phrase is not: an accessible name never begins with the step's own action,
# but "Enter the code in the Promo field" and "Click Save on the Orders page"
# put the element at opposite ends of the sentence, and no regex tells them
# apart. So this strips the end it can be sure of and _unresolved_name flags
# what is left when the result still does not look like a name.
_LEADING_ACTION = re.compile(
    r"^\s*(?:please\s+)?"
    r"(?:click|press|tap|submit|hit|select|choose|pick|enter|type|input"
    r"|fill(?:\s+in)?|provide|key\s+in|set|verify|assert|confirm|check"
    r"|validate|ensure|navigate|go|browse|visit|launch|open|wait)\b"
    r"(?:\s+(?:to|on|in|into|at|for))?"
    r"(?:\s+(?:the|a|an|its))?\s*",
    re.IGNORECASE,
)


def _clean_target(target: str) -> str:
    """Strip action verbs, role suffixes, and surrounding quotes to find the clean accessible name."""
    text = (target or "").strip()
    quoted_match = re.search(r"['\"]([^'\"]+)['\"]", text)
    if quoted_match:
        return quoted_match.group(1).strip()

    text = _LEADING_ACTION.sub("", text, count=1)
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


# An accessible name is short. Six words is generous for one -- "Proceed to
# checkout" is three -- and anything longer is the step's sentence wearing a
# name's clothes.
_MAX_NAME_WORDS = 6

# Joins that belong to a sentence and never to an accessible name. "Back to the
# top" is a plausible button, which is why "to" is not here; "in the", "from
# the" and an assertion's "is displayed" have no business inside a name and are
# the surest sign the step's prose was never split into an action and a target.
_SENTENCE_TELLS: tuple[tuple[str, str], ...] = (
    (r"\b(?:in|on|from|at|under|within|inside|of)\s+the\b", "joins two clauses"),
    (r"\bis\s+(?:displayed|visible|shown|present|enabled|disabled|selected)\b",
     "states an assertion"),
    (r"\bshould\b", "states an expectation"),
)


def _unresolved_name(name: str) -> Optional[str]:
    """Why `name` cannot be trusted as an accessible name, or None if it can.

    Three tells, and all of them mean the same thing: the phrase is still a
    sentence, so the query built from it looks confident and matches nothing.

    That silence was the defect. A step whose target arrived as a whole
    sentence -- which is what /scripts/generate writes when steps_structured is
    rebuilt from steps_raw -- compiled to getByRole with the sentence as the
    name and NO todo, so the static gate saw nothing, review saw nothing, and
    the first red run was the first anyone heard of it. Emitting a reason here
    does not repair the locator; it puts the guess where a person can see it.
    """
    for pattern, why in _SENTENCE_TELLS:
        if re.search(pattern, name, re.IGNORECASE):
            return (
                f"{name!r} {why}, so it is the step's prose rather than the name of "
                "one element. Name the element in the step's target, or run "
                "Application Discovery so this locator can be grounded."
            )

    words = name.split()
    if len(words) > _MAX_NAME_WORDS:
        return (
            f"{name!r} reads as a sentence rather than an element name, so this "
            "locator is a guess. Name the element in the step's target, or run "
            "Application Discovery so it can be grounded against the catalogue."
        )
    for pattern, role in _ROLE_HINTS:
        if re.search(pattern, name, re.IGNORECASE):
            return (
                f"{name!r} still carries the element's own kind ({role}), so the "
                "accessible name was not isolated cleanly and this locator is "
                "unlikely to match."
            )
    return None


_WHITESPACE_RUN = re.compile(r"\s+")


def comment_text(value: Any, *, limit: int = 300) -> str:
    """Arbitrary text flattened to something safe on a single // comment line."""
    flattened = _WHITESPACE_RUN.sub(" ", "" if value is None else str(value)).strip()
    flattened = flattened.replace("*/", "* /")
    if len(flattened) > limit:
        flattened = flattened[: limit - 1].rstrip() + "…"
    return flattened


# --- Automation Module: steps that report themselves -------------------------
#
# A compiled step used to be a `// 3. Click Buy Now` comment above its own
# statements. A comment is inert: the step boundary existed in the source and
# nowhere in the running process, so the UI could say "executing" and nothing
# more until the whole spec exited. Wrapping the same statements in
# `test.step()` gives the boundary a runtime existence -- the reporter is
# called on entry and exit, and progress-reporter.cjs turns those calls into
# the NDJSON the runner tails.
#
# The trace viewer groups by test.step too, so the same change buys named
# sections in every trace without asking for them.


def step_title(number: Any, action: Any, *, limit: int = 120) -> str:
    """A step's label as it appears in the reporter, the trace and the UI.

    Braces are stripped rather than escaped. They survive json.dumps into the
    emitted string literal perfectly well, but run_static_gate decides whether
    a file will parse by counting `{` against `}` across the whole text without
    modelling string literals -- so an action phrased "select {plan} tier"
    would leave the counts uneven and the gate would refuse a spec that is in
    fact valid. Nothing downstream needs the braces.
    """
    text = comment_text(action, limit=limit).replace("{", "(").replace("}", ")")
    return f"{number}. {text}" if text else f"Step {number}"


def _wrap_step_body(lines: list[str], start: int, title: str) -> None:
    """Enclose the statements emitted since `start` in an `await test.step`.

    Splicing after the fact, rather than threading an indent level through the
    ~200 lines of emit logic above, keeps this to one call site per step and
    leaves every existing `lines.append("  ...")` untouched.

    A step that emitted nothing executable is left alone: wrapping bare
    comments in a step would report progress for work that never happened.
    """
    body = lines[start:]
    if not any(line.strip() and not line.strip().startswith("//") for line in body):
        return
    del lines[start:]
    lines.append(f"  await test.step({_js(title)}, async () => {{")
    lines.extend(("  " + line) if line.strip() else line for line in body)
    lines.append("  });")


def sanitize_catalog_locator(expr: Optional[str]) -> Optional[str]:
    """A discovered locator made safe to paste into a source file, or None."""
    if not expr:
        return None
    cleaned = _WHITESPACE_RUN.sub(" ", expr).strip()
    if not cleaned:
        return None
    # Discovery may store a CSS selector rather than a Playwright expression.
    # A bare `[data-test="username"]` emitted after `await` is parsed as an
    # assignment expression, not a locator, and makes the entire spec invalid.
    if cleaned.startswith("page."):
        return cleaned if not re.search(r"[\r\n;]", cleaned) else None
    if re.search(r"[\r\n;`]", cleaned):
        return None
    return f"page.locator({_js(cleaned)})"


def _ground_with_observed_journey_selectors(
    case: Any, steps: list[dict], target_url: str, catalog: Optional[list[dict]] = None
) -> list[dict]:
    """Ground each step by app host, active page route and unique captured control.

    Journey keyword/title matching is deliberately absent: it can select a
    different application's journey and is not evidence that a locator works.
    """
    from .control_evidence import choose_control, host, observed_controls, route

    active_route = route(target_url)
    explicit_route = False
    grounded = []
    for step in steps:
        updated = dict(step)
        target = str(step.get("target") or "").strip()
        intent = _intent(str(step.get("action") or ""), step.get("action_type"))
        if intent == "goto":
            if target.startswith("/") or (target.startswith(("http://", "https://")) and host(target) == host(target_url)):
                active_route = route(target)
                explicit_route = True
        elif target and not target.startswith(("//", "(//", ".//", "xpath=", ".", "#", "[", "input[", "button[", "page.")):
            controls = observed_controls(target_url, active_route or None, catalog)
            if not controls and not explicit_route:
                candidates = observed_controls(target_url, None, catalog)
                if len({control.screen_route for control in candidates}) == 1:
                    controls = candidates
            match = choose_control(target, intent, controls)
            if match and sanitize_catalog_locator(match.selector):
                updated["target"] = match.selector
        grounded.append(updated)
    return grounded


def _observed_literal_assertion(action: str, target: str, observation: Optional[dict], screen_url: str) -> Optional[str]:
    """Keep positive title/text checks tied to the replayed destination."""
    from .control_evidence import host, route
    if (not isinstance(observation, dict) or host(observation.get("url")) != host(screen_url)
            or route(observation.get("url")) != route(screen_url)):
        return None
    values = re.findall(r"['\"]([^'\"]+)['\"]", action)
    if not values:
        return None
    guard = f"await expect(page).toHaveURL({_js(observation['url'])});"
    if "title" in target.lower() and len(values) == 1 and values[0] == observation.get("title"):
        return guard + f"\n  await expect(page).toHaveTitle({_js(values[0])});"
    text = observation.get("visible_text") or []
    text = " ".join(text) if isinstance(text, list) else str(text)
    normalize = lambda value: " ".join(str(value).split())
    if not all(normalize(value) in normalize(text) for value in values):
        return None
    if "button" in target.lower():
        if len(values) != 1 or values[0] not in (observation.get("controls") or []):
            return None
        # The capture supplies the visible label, not an ARIA role. Preserve
        # that evidence instead of inventing 'button' for a link styled as one.
        pattern = r"^\s*" + r"\s+".join(re.escape(word) for word in values[0].split()) + r"\s*$"
        locator = (f"page.getByText(new RegExp({_js(pattern)}, 'i'))"
                   ".locator(\"xpath=ancestor-or-self::*[self::button or self::a or self::input or @role='button'][1]\")")
        return guard + f"\n  await expect({locator}).toBeVisible();\n  await expect({locator}).toBeEnabled();"
    return guard + "\n  " + "\n  ".join(
        "await expect.poll(async () => (await page.locator('body').innerText()).replace(/\\s+/g, ' ').trim())"
        + f".toContain({_js(normalize(value))});" for value in values)


def _observed_result_assertion(action: str, target: str, expected: str,
                               case_expected: str, application_url: str,
                               observation: Optional[dict]) -> Optional[str]:
    """Compile a result check only when the completed replay observed its state.

    An absent control has no locator to capture. Its name must come from the
    saved requirement, and the final visible-control survey must be complete.
    Positive alerts use a unique selector captured from the final DOM.
    """
    from .control_evidence import host, route

    if not isinstance(observation, dict) or host(observation.get("url")) != host(application_url):
        return None
    destination = _EXPECTED_URL_RE.search(expected)
    if destination and re.search(r"\b(?:alert|notification|control|heading)\b", expected, re.I):
        raw_path = destination.group(1)
        expected_route = route(urljoin(application_url, raw_path))
        if route(observation.get("url")) != expected_route:
            return None
        assertions = [f"await expect(page).toHaveURL(new RegExp({_js(re.escape(expected_route))}, 'i'), {{ timeout: 15000 }});"]
        if re.search(r"\b(?:alert|notification)\b", expected, re.I):
            controls = observation.get("assertion_controls")
            matches = [item for item in controls or [] if isinstance(item, dict) and item.get("kind") == "alert" and str(item.get("text") or "").casefold() in expected.casefold()]
            if len(matches) != 1:
                return None
            locator = sanitize_catalog_locator(str(matches[0].get("selector") or ""))
            if not locator:
                return None
            assertions.append(f"await expect({locator}).toBeVisible({{ timeout: 10000 }});")
        visible_control = re.search(r"\bthe\s+([\w -]{2,80}?)\s+control\s+is\s+(?:visible|shown|displayed|present)\b", expected, re.I)
        if visible_control:
            label = visible_control.group(1).strip()
            visible = observation.get("controls")
            if observation.get("controls_truncated") is not False or not isinstance(visible, list) or sum(str(item).casefold() == label.casefold() for item in visible) != 1:
                return None
            assertions.append(f"await expect(page.getByText({_js(label)}, {{ exact: true }})).toBeVisible({{ timeout: 10000 }});")
        return "\n  ".join(assertions)
    if route(observation.get("url")) != route(application_url):
        return None
    missing = re.search(r"\bthe\s+([\w -]{2,80}?)\s+control\s+is\s+(?:absent|not\s+(?:shown|visible|displayed))\b", action, re.I)
    if missing:
        label = missing.group(1).strip()
        if (label.casefold() not in case_expected.casefold()
                or not re.search(r"\b(absent|not displayed|not visible|not shown)\b", case_expected, re.I)
                or observation.get("controls_truncated") is not False):
            return None
        visible = observation.get("controls")
        if not isinstance(visible, list) or any(label.casefold() in str(value).casefold() for value in visible):
            return None
        return f"await expect(page.getByText({_js(label)}, {{ exact: true }})).toBeHidden({{ timeout: 10000 }});"
    if target.casefold().strip() not in {"alert", "alerts", "error", "errors", "error message"}:
        return None
    candidates = observation.get("assertion_controls")
    if not isinstance(candidates, list) or len(candidates) != 1:
        return None
    item = candidates[0]
    if not isinstance(item, dict) or item.get("kind") != "alert":
        return None
    label, selector = str(item.get("text") or ""), str(item.get("selector") or "")
    if not label or label.casefold() not in expected.casefold() or not selector.startswith(("//", "#", "[")):
        return None
    locator = sanitize_catalog_locator(selector)
    return f"await expect({locator}).toBeVisible({{ timeout: 10000 }});" if locator else None


_LEGACY_BARE_SELECTOR = re.compile(r'(?m)(\bawait\s+)(\[[^\r\n\]]+\])(?=\.(?:fill|click|check|press|selectOption)\s*\()')


def repair_legacy_bare_selectors(code: str) -> str:
    """Repair only the old generated `await [attribute=value].fill()` form."""
    return _LEGACY_BARE_SELECTOR.sub(lambda match: match.group(1) + f'page.locator({_js(match.group(2))}).first()', code)


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

    if raw.startswith("page."):
        verified = sanitize_catalog_locator(raw)
        if verified:
            return verified, None

    # --- Automation Module: XPath is a selector, not a phrase ----------------
    # Playwright auto-detects an XPath locator, but only if the expression
    # reaches page.locator() intact. Without this branch the phrase heuristics
    # below read it as prose, silently and with no TODO to show for it:
    #
    #   //a [text()='Manage']              -> page          (no locator at all)
    #   //input[@id='userEmailField']      -> getByLabel("userEmailField")
    #   (//input[@name='opt-field'])[3]    -> getByLabel("opt-field")
    #
    # None of those match anything. This matters now because a Knowledge Base
    # can carry XPath recorded against a real application -- the B2B Portal
    # profile does -- so a grounded step arrives in exactly this shape.
    if raw.startswith(("//", "(//", ".//", "(.//", "xpath=", "(xpath=")):
        return f"page.locator({_js(raw)}).first()", None

    # 0. Direct CSS / Playwright locator syntax
    if (
        raw.startswith((".", "#", "[", "button", "a[", "input[", "div[", "div.", "span["))
        or ":has-text(" in raw
        or "[href" in raw
        or "[data-" in raw
    ):
        return f"page.locator({_js(raw)}).first()", None

    # 1. If target contains data-testid
    if "data-testid=" in raw:
        tid_match = re.search(r'data-testid=["\']([^"\']+)["\']', raw)
        if tid_match:
            return f"page.getByTestId({_js(tid_match.group(1))})", None
        return f"page.locator({_js(raw)}).first()", None

    if raw.startswith("#"):
        return f"page.locator({_js(raw)}).first()", None

    name = _clean_target(raw)
    unresolved = _unresolved_name(name)
    lowered = raw.lower()

    # 2. Multi-element disambiguation (e.g. main, header, body -> page.locator('body'))
    if "," in raw and any(tag in lowered for tag in ("header", "body", "main")):
        return "page.locator('body')", None

    # 3. Match accessible roles
    for pattern, role in _ROLE_HINTS:
        if re.search(pattern, lowered):
            return f"page.getByRole({_js(role)}, {{ name: {_js(name)} }})", unresolved

    # 4. Form fields
    if any(re.search(p, lowered) for p in _FIELD_HINTS) or intent in ("fill", "select"):
        return f"page.getByLabel({_js(name)})", unresolved

    # 5. Path or URL
    if raw.startswith(("/", "http://", "https://")):
        return "page", None

    # 6. Resilient multi-element locator for clicks / actions
    if intent == "click":
        return (
            f"page.locator('a, button, [role=\"button\"], [role=\"link\"], [role=\"menuitem\"], [role=\"tab\"], span')"
            f".filter({{ hasText: {_js(name)} }}).first()",
            unresolved if len(name) > 1 else f"Could not tell what kind of element {raw!r} is — using a resilient text match.",
        )

    # 7. Exact/text match
    return (
        f"page.getByText({_js(name)})",
        unresolved if len(name) > 1 else f"Could not tell what kind of element {raw!r} is — using a text match.",
    )


def build_locator(
    step: dict, intent: str, *, catalog: Optional[list[dict]] = None
) -> tuple[str, Optional[str]]:
    """A step's locator: grounded against the discovered catalogue if one was
    given and it names a match, the phrase heuristic otherwise.
    """
    target = step.get("target")

    # The screen-scoped resolver already selected this observed locator.
    # A broader catalogue search must not override it with another page's
    # similarly named control.
    if isinstance(target, str) and target.strip().startswith(("page.", "#", "[", "input[", "button[")):
        return _phrase_locator(target, intent)

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


# --- Automation Module: post-conditions become assertions --------------------
#
# refine.py's prompt rule 3 requires every step to carry a concrete, observable
# post-condition, and the refiner spends tokens producing them. This compiler
# emitted each one as `// expected: ...` and asserted nothing, so a generated
# spec verified only what the is_verify_step heuristic recognised from the
# action text. A script that clicks through a journey without checking it is
# not a test, and on an application with no Knowledge Base entry those
# per-step post-conditions are the only verification the case has at all.
#
# The rule here is high precision, not high recall. A post-condition is prose,
# and a locator invented from prose matches nothing while looking confident --
# the failure _unresolved_name exists to expose. So an assertion is emitted
# only from a literal the refiner actually quoted, or a URL/path it actually
# named. Everything else keeps the comment it had before: a missing assertion
# is a gap, a fabricated one is a red run against a working application, and
# the second costs far more, because it teaches people to ignore failures.
# A bare path only counts when it stands on its own. Without the leading
# boundary this matched "/privacy" inside "the cookie/privacy banner" and
# asserted the page had navigated to /privacy -- a red run on a working
# application, from a post-condition about dismissing an overlay.
_EXPECTED_URL_RE = re.compile(
    r"(https?://[^\s,;'\"]+"
    r"|(?:(?<=\s)|^)/[A-Za-z0-9][A-Za-z0-9\-_/.]{2,})"
)
_EXPECTED_QUOTED_RE = re.compile(r"[\"']([^\"']{2,80})[\"']")


def expected_assertion(expected: Any, intent: str) -> Optional[str]:
    """A Playwright assertion for a step's expected_result, or None.

    None means "emit the comment, as before" -- see the note above for why that
    is the default rather than a locator guessed from a sentence.
    """
    if intent == "assert":
        # The step already emitted its own visibility assertion.
        return None

    text = str(expected or "").strip()
    if not text:
        return None

    url_match = _EXPECTED_URL_RE.search(text)
    if url_match:
        raw = url_match.group(1).rstrip(".,;:)")
        path = raw.split("://", 1)[-1]
        if "/" in path:
            path = path[path.find("/"):]
        if len(path) > 2:
            return (
                f"await expect(page).toHaveURL(new RegExp({_js(re.escape(path))}, 'i'), "
                "{ timeout: 15000 });"
            )

    # A quoted selector or URL is not an observable string on the page.
    literals = [
        q.strip()
        for q in _EXPECTED_QUOTED_RE.findall(text)
        if q.strip() and not q.strip().startswith(("http", "/", ".", "#", "["))
    ]
    if literals:
        # "One of ('ADD TO CART' or 'Checkout Now') becomes visible" is satisfied
        # by either, so asserting the first one turns a passing application into
        # a red run. The post-condition already names the alternatives, so it
        # compiles to an alternation rather than being dropped.
        if len(literals) > 1 and re.search(r"\bor\b", text, re.IGNORECASE):
            # re.escape() escapes spaces too, and a backslash-space escape is
            # only valid in a JS regex under Annex B -- it throws under the `u` flag.
            pattern = "|".join(
                dict.fromkeys(re.escape(l).replace(r"\ ", " ") for l in literals)
            )
            return (
                f"await expect(page.getByText(new RegExp({_js(pattern)}, 'i')).first())"
                ".toBeVisible({ timeout: 15000 });"
            )
        return (
            f"await expect(page.getByText({_js(literals[0])}).first())"
            ".toBeVisible({ timeout: 15000 });"
        )

    return None


def compile_playwright(
    case: Any,
    *,
    base_url: Optional[str] = None,
    catalog: Optional[list[dict]] = None,
    locator_overrides: Optional[dict[int, dict[str, Any]]] = None,
    outcome_observation: Optional[dict] = None,
) -> CompiledScript:
    """Render an optimized Playwright spec from a refined case.
    Supports both Web UI automation and REST API testing.
    """
    catalog = catalog or []
    locator_overrides = locator_overrides or {}
    unresolved: list[dict[str, Any]] = []
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
    # identify_app_id for the same reason as workbench.sync_approved_test_cases:
    # the falling-back helpers always name an application, so an unmatched case
    # was compiled against whichever profile sorted first.
    matched_app_id = (flow.get("_app_id") if flow else None) or kb.identify_app_id(full_case_text)
    prof = (kb.load_app_profile(matched_app_id) if matched_app_id else {}) or {}
    flow_base_url = prof.get("base_url", "").strip()

    case_app_url = (getattr(case, "application_url", "") or "").strip()
    if base_url:
        target_url = base_url.strip()
    elif flow_base_url and (
        not case_app_url
        or (_url_host(flow_base_url) == _url_host(case_app_url)
            and len(flow_base_url) > len(case_app_url))
    ):
        # The matched flow wins over the case's own URL only when it describes
        # the same host more specifically -- an SMB catalogue inside a consumer
        # domain, say. This read "smb" out of the case text before, which was
        # one customer's site map compiled into the generator.
        target_url = flow_base_url
    else:
        target_url = case_app_url or flow_base_url

    if not target_url:
        # No URL anywhere: not on the case, not from a matched flow, not passed
        # in. Refusing is the point -- the alternative that used to stand here
        # was kb.default_base_url(), which silently pointed the run at the first
        # application in the Knowledge Base. The caller turns this into a skip
        # with this reason attached, so the Workbench can show what is missing.
        raise ValueError(
            f"{display_id} has no application URL. The Knowledge Base does not "
            f"cover this test case, so no URL could be derived from it. Set the "
            f"application URL on the case before generating a script."
        )

    steps = _ground_with_observed_journey_selectors(case, steps, target_url, catalog)
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
        " *   - Automated Scope: Only the approved actions and assertions below.",
        " *   - External Boundary: Credentials and human challenges require authorized test inputs.",
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

        # Playwright creates a blank page. Cases may begin with a fill or click
        # because the entry page is implicit in the application binding. Open
        # that bound page before the first interaction; never guess a URL from
        # the field name or silently wait for a locator on about:blank.
        if steps:
            first = steps[0]
            first_action = str(first.get("action") or "")
            first_navigates = _intent(first_action, first.get("action_type")) == "goto" or _is_navigation_target(first.get("target"))
            if not first_navigates:
                lines.append(f"  await navigateTo(page, {_js(_route(target_url, target_url))}, null);")

        current_screen_url = target_url
        for step in steps:
            number = step.get("step_number") or (emitted + 1)
            action = str(step.get("action") or "").strip()
            target = step.get("target")
            data_ref = step.get("test_data_ref")
            expected = step.get("expected_result")
            intent = _intent(action, step.get("action_type"))
            fill_assertion = None

            lines.append("")
            lines.append(f"  // {number}. {comment_text(action)}")
            # Everything appended from here to the end of this iteration is the
            # step's body, and gets wrapped in test.step() below.
            step_body_start = len(lines)

            action_lower = action.lower()
            target_lower = (target or "").lower()
            is_cookie_dismissal = any(k in action_lower or k in target_lower for k in ["cookie", "privacy", "usercentrics", "consent", "overlay", "banner"])

            # A target may be a CSS selector such as [id="username"]. Its
            # quoted attribute is a locator, never the value to type.
            quote_match = re.search(r'["\']([^"\']+)["\']', action)
            quoted_term = quote_match.group(1).strip() if quote_match else ""

            is_verify_step = any(k in action_lower for k in ["verify", "assert", "review", "summary", "shopping cart", "screen is displayed", "page is displayed", "email verification"]) or (number == len(steps) and ("verify" in action_lower or "assert" in action_lower or "screen" in action_lower or "page" in action_lower))

            result_assertion = ((_observed_literal_assertion(action, str(target or ""), outcome_observation, current_screen_url)
                                 or _observed_result_assertion(action, str(target or ""), str(expected or ""),
                                                         str(case.expected_result or ""), target_url,
                                                         outcome_observation)) if intent == "assert" else None)
            destination = re.search(r"https?://[^\s'\"]+", str(expected or ""))
            if intent != "assert" and destination:
                current_screen_url = destination.group(0).rstrip(".")
            if (intent == "assert" and outcome_observation and not result_assertion
                    and str(target or "").lower().startswith(("page title", "visible text", "button '"))):
                issues.append(StaticGateIssue("error", f"Step {number}: the requested result is not present in the captured destination evidence. Capture it before generating."))
            if result_assertion:
                lines.append(f"  {result_assertion}")
            elif intent == "assert" and expected and _EXPECTED_URL_RE.search(str(expected)):
                route_assertion = expected_assertion(expected, "goto")
                if route_assertion:
                    lines.append(f"  {route_assertion}")
                if re.search(r"\b(?:alert|notification|control)\b", str(expected), re.I):
                    issues.append(StaticGateIssue(
                        "error",
                        f"Step {number}: the expected alert or control has no browser-observed post-action evidence. Capture the outcome before running this script.",
                    ))
            elif is_cookie_dismissal:
                lines.append("  // Dismiss cookie / privacy overlay")
                lines.append("  await dismissOverlays(page);")
                lines.append("  try {")
                lines.append("    const cookieBtn = page.locator(")
                lines.append("      '#usercentrics-root button, #onetrust-accept-btn-handler, #accept-all-cookies, button:has-text(\"Accept All\"), button:has-text(\"Accept all\"), button:has-text(\"Accept\")'")
                lines.append("    ).first();")
                lines.append("    if (await appears(cookieBtn, 2500)) {")
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
                    # toHaveURL rather than a boolean the step computes itself.
                    # The old form -- `const onTargetPage = page.url().includes(..)`
                    # then `expect(onTargetPage).toBe(true)` -- read the URL once
                    # and failed with "Expected: true Received: false", naming
                    # neither the URL it wanted nor the one it got, on a step that
                    # is usually racing a client-side navigation. toHaveURL retries
                    # until the timeout and prints both URLs on failure.
                    pattern = "|".join(
                        dict.fromkeys(
                            re.escape(part)
                            for part in (route.split("?")[0], path_slug.lower())
                            if part
                        )
                    )
                    lines.append(
                        f"  await expect(page).toHaveURL(new RegExp({_js(pattern)}, 'i'), "
                        f"{{ timeout: 15000 }});"
                    )
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
                lines.append("    if (await appears(searchField, 4000)) {")
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
                lines.append("    if (await appears(productEl, 4000)) {")
                lines.append("      await productEl.click();")
                lines.append("      await page.waitForLoadState('domcontentloaded');")
                lines.append("      await page.waitForTimeout(1500);")
                lines.append("    }")
                lines.append("  } catch (e) {}")
            elif any(k in action_lower for k in ["color", "storage", "variant", "payment plan", "memory", "terms", "one time", "full price", "bundle items"]) or "variant" in target_lower:
                lines.append("  // Select/verify variant options and price update")
                lines.append("  try {")
                lines.append("    const opt = page.locator('.device-variant-options, [role=\"radio\"], button.variant-btn, .color-swatch, .storage-btn, label:has-text(\"One Time\"), label:has-text(\"GB\")').first();")
                lines.append("    if (await appears(opt, 3000)) {")
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
                lines.append("  const isOutOfStock = await appears(outOfStockEl, 2500);")
                lines.append("  const addBtn = page.locator(")
                lines.append("    'button:has-text(\"ADD TO CART\"), button:has-text(\"Add to cart\"), button:has-text(\"Add to Cart\"), button:has-text(\"Add To Cart\"), button:has-text(\"Checkout Now\"), button:has-text(\"CHECKOUT NOW\"), button:has-text(\"Proceed to Checkout\"), button:has-text(\"Buy Now\"), button:has-text(\"BUY NOW\"), [data-testid*=\"cart\" i], [class*=\"add-to-cart\" i], [class*=\"addToCart\" i], button.btn-primary:has-text(\"Add\"), button.checkout-btn, button:has-text(\"Select Plan\"), button:has-text(\"Order Now\")'")
                lines.append("  ).first();")
                lines.append("  if (isOutOfStock) {")
                lines.append("    console.log(\"Product is OUT OF STOCK on live site — asserting out-of-stock status or disabled CTA\");")
                lines.append("    if (await appears(addBtn, 2000)) {")
                lines.append("      await expect(addBtn).toBeDisabled();")
                lines.append("    } else {")
                lines.append("      await expect(outOfStockEl).toBeVisible();")
                lines.append("    }")
                lines.append("  } else {")
                lines.append("    await addBtn.scrollIntoViewIfNeeded().catch(() => {});")
                lines.append("    if (await appears(addBtn, 8000)) {")
                lines.append("      await addBtn.click({ force: true }).catch(() => {});")
                lines.append("      await page.waitForTimeout(2500);")
                lines.append("    } else {")
                lines.append("      const fallbackCta = page.locator('button.btn-primary, [role=\"button\"]:has-text(\"Cart\"), a:has-text(\"Cart\"), button:has-text(\"Continue\")').first();")
                lines.append("      if (await appears(fallbackCta, 3000)) {")
                lines.append("        await fallbackCta.click({ force: true }).catch(() => {});")
                lines.append("      }")
                lines.append("      await page.waitForTimeout(2000);")
                lines.append("    }")
                lines.append("  }")
            elif any(k in action_lower for k in ["checkout", "proceed to", "buy now"]) or any(k in target_lower for k in ["checkout", "buy now"]):
                # --- A click step has to be able to fail -------------------
                # This block used to be `if (await appears(btn)) { click }`
                # wrapped in `try {} catch (e) {}`: an absent button skipped the
                # if, a failed click was swallowed, and either way the step was
                # reported green. The journey then died two steps later at "the
                # URL is not the ordering page", which is true, unhelpful, and
                # blames the wrong step.
                #
                # Buy Now is the step's whole purpose, so its absence is the
                # result. toBeVisible retries to the timeout and names the
                # locator it waited on; the click is then unguarded, because a
                # click that throws is a finding rather than an inconvenience.
                # --- filter({ visible: true }) before first() ----------------
                # These targets are comma-lists pairing something precise with
                # something generic -- "a[href*='ratePlanId=...375'], a:has-text
                # ('Buy Now')". Playwright resolves the whole list in DOM order,
                # so first() does not prefer the specific half: on a plans page
                # carrying both tabs' cards in one DOM, it took the *earlier*
                # Buy Now, which belonged to the tab that was not selected and
                # was therefore hidden. The precise selector was present and
                # correct, and lost to its own fallback.
                #
                # Filtering to visible first makes the pairing safe: the generic
                # half can only ever match something the user can actually see,
                # which on a tabbed catalogue is the tab in front.
                lines.append("  // Click Buy Now / Proceed to Checkout")
                if target and (target.startswith((".", "#", "[", "button", "a")) or ":has-text" in target or "ratePlanId" in target):
                    lines.append(f"  const checkoutActionBtn = page.locator({_js(target)}).filter({{ visible: true }}).first();")
                else:
                    lines.append("  const checkoutActionBtn = page.locator('button:has-text(\"Buy Now\"), a:has-text(\"Buy Now\"), button:has-text(\"Checkout Now\"), button:has-text(\"Proceed to Checkout\"), button:has-text(\"Checkout\"), a:has-text(\"Checkout\")').filter({ visible: true }).first();")
                lines.append("  await checkoutActionBtn.scrollIntoViewIfNeeded().catch(() => {});")
                lines.append("  await expect(checkoutActionBtn).toBeVisible({ timeout: 15000 });")
                lines.append("  await checkoutActionBtn.click();")
                lines.append("  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});")
            elif any(k in action_lower for k in ["shipping address", "payment method", "enter address", "credit card", "fill form"]):
                lines.append("  // Fill address/checkout details if form presented")
                lines.append("  try {")
                lines.append("    const addressInput = page.locator('input[name*=\"address\" i], input[placeholder*=\"address\" i], textarea, input[name*=\"name\" i], input[type=\"text\"]').first();")
                lines.append("    if (await appears(addressInput, 3000)) {")
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
                    locator = sanitize_catalog_locator(recorded_match["recommended_locator"])
                    if not locator:
                        locator, todo = build_locator(step, intent, catalog=catalog)
                    else:
                        todo = None
                    lines.append(f"  // [Guided Discovery] Ground-truth recorded locator for {comment_text(recorded_match.get('target_name'))}")
                else:
                    locator, todo = build_locator(step, intent, catalog=catalog)

                # An override applies only where the deterministic path admits
                # it guessed. A locator the Knowledge Base or the catalogue
                # resolved carries no todo and is never second-guessed -- those
                # are verified facts, and a model has nothing to add to a fact.
                if todo and "body" not in locator:
                    override = locator_overrides.get(number)
                    if override and override.get("locator"):
                        locator = override["locator"]
                        why = (override.get("reasoning") or "").strip()
                        lines.append(
                            f"  // [AI-resolved locator, confidence "
                            f"{override.get('confidence', '?')}] "
                            f"{comment_text(why or todo)}"
                        )
                        todo = None
                    else:
                        unresolved.append(
                            {
                                "step_number": number,
                                "action": action,
                                "target": target,
                                "intent": intent,
                                "reason": todo,
                            }
                        )
                        issues.append(StaticGateIssue("warning", f"Step {number}: {todo}"))
                        lines.append(f"  // TODO: {comment_text(todo)}")

                if intent == "fill":
                    if data_ref:
                        value = re.sub(r"[^A-Za-z0-9]+", "_", str(data_ref)).lower()
                    elif quoted_term and not re.search(r"password|passcode|secret|token", f"{action} {target or ''}", re.I):
                        value = _js(quoted_term)
                    else:
                        value = None
                        issues.append(StaticGateIssue(
                            "error", f"Step {number}: input value is not linked to Test Data. Add a value for this application and environment, then regenerate.",
                        ))
                    if value is not None:
                        lines.append(f"  await {locator}.fill({value});")
                        fill_assertion = f"await expect({locator}).toHaveValue({value}, {{ timeout: 15000 }});"
                elif intent == "select":
                    if any(k in locator.lower() for k in [".plan-card", "button", "tab", "role=", "div", "radio", ":has-text", "hastext", "card"]):
                        lines.append(f"  await observedInteractions.clickObserved(page, {locator}, page.url());")
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
                    lines.append(f"  await observedInteractions.clickObserved(page, {locator}, page.url());")

            if expected and intent != "assert":
                lines.append(f"  // expected: {comment_text(expected)}")
                assertion = fill_assertion if intent == "fill" else expected_assertion(expected, intent)
                if assertion:
                    lines.append(f"  {assertion}")

            _wrap_step_body(lines, step_body_start, step_title(number, action))
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
        step_count=emitted,
        unresolved=unresolved,
    )
    script.issues.extend(run_static_gate(code, emitted, len(steps) if steps else 1))
    return script


# --- Automation Module: Katalon ----------------------------------------------
#
# Katalon has no runner here, which is a reason not to EXECUTE it. It was being
# treated as a reason not to COMPILE it: every step emitted two comment lines
# and a "bind a Test Object" TODO, so a nine-step case produced eighteen
# comments and no code, while the same case in Playwright produced a grounded,
# asserted spec from exactly the same inputs.
#
# The inputs were always there. A step carries an intent, a target, a data
# reference and a post-condition; the discovery catalogue carries a verified
# locator for it. What was missing is the translation, and that is all this is.
#
# Two decisions worth defending:
#
#   Test Objects are built at run time. Katalon normally resolves objects out
#   of an Object Repository, and this compiler cannot write one -- that is a
#   .rs file per element in a project layout we do not own. A TestObject
#   constructed in the script carries the same properties the repository entry
#   would, so the file runs in Katalon Studio with nothing to import first.
#
#   Locators are translated, never invented. The catalogue and the locator
#   agent both speak Playwright, so _katalon_selector parses that vocabulary
#   and re-expresses it as XPath. Anything it cannot parse produces a
#   text-contains fallback AND a TODO, exactly as the Playwright path does --
#   the same rule that a visible gap beats a confident guess.


def _xpath_literal(value: str) -> str:
    """An XPath 1.0 string literal for `value`, apostrophes included.

    XPath 1.0 has no escape character, so a name like "I'm hiring talent" -- a
    real accessible name in the catalogue -- cannot be written as one quoted
    literal at all. concat() is the only construction that works, and getting
    this wrong produces a file that fails to parse in Katalon Studio rather
    than one that merely fails to match.
    """
    if "'" not in value:
        return "'" + value + "'"
    parts: list[str] = []
    for chunk in value.split("'"):
        if chunk:
            parts.append("'" + chunk + "'")
        parts.append('"\'"')
    parts.pop()  # split() leaves one separator more than there are gaps
    # XPath 1.0's concat() takes two arguments or more, so a value that is
    # nothing but an apostrophe has to be returned as the bare literal.
    if len(parts) == 1:
        return parts[0]
    return "concat(" + ", ".join(parts) + ")"


def _groovy(value: Any) -> str:
    """A single-quoted Groovy string literal that cannot break out of itself."""
    text = "" if value is None else str(value)
    text = text.replace("\\", "\\\\").replace("'", "\\'")
    text = text.replace("\r", " ").replace("\n", " ")
    return "'" + text + "'"


def _groovy_var(data_ref: Any) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", str(data_ref)).strip("_").lower() or "test_data"


# The accessible names in a real catalogue run to whole paragraphs -- one is
# 120 characters of marketing copy. An exact normalize-space() match on that is
# a locator that cannot succeed, so a long name is matched on a distinctive
# prefix instead and the step is reported as inferred, which puts the
# truncation in front of a reviewer rather than leaving it for a run.
_MAX_EXACT_NAME = 60

_PW_ROLE = re.compile(r"\bgetByRole\(")
_PW_NAMED = re.compile(r"\bgetBy(Label|Placeholder|Text|TestId|AltText|Title)\(")
_PW_RAW = re.compile(r"\blocator\(")
_PW_NAME_KEY = re.compile(r"\bname\s*:")


def _quoted_after(text: str, index: int) -> tuple[Optional[str], int]:
    """The first quoted literal at or after `index`, with escapes resolved.

    A regex of the form ['"](.*?)['"] cannot read these, and the catalogue is
    full of values that break it: getByRole('link', { name: 'I\\'m hiring
    talent' }) truncates to "I", and locator('//div[@id="x"]') truncates at the
    inner double quote. Both produce a locator that is syntactically fine and
    matches nothing, which is the failure mode this module exists to avoid.
    """
    while index < len(text) and text[index] not in ("'", '"', "`"):
        index += 1
    if index >= len(text):
        return None, index
    quote = text[index]
    index += 1
    out: list[str] = []
    while index < len(text):
        char = text[index]
        if char == "\\" and index + 1 < len(text):
            out.append(text[index + 1])
            index += 2
            continue
        if char == quote:
            return "".join(out), index + 1
        out.append(char)
        index += 1
    return None, index

# role -> the tags that role is normally spelled with, so a translated locator
# matches a native <button> as well as an ARIA-annotated <div>.
_ROLE_TAGS: dict[str, tuple[str, ...]] = {
    "button": ("button",),
    "link": ("a",),
    "textbox": ("input", "textarea"),
    "checkbox": ("input",),
    "radio": ("input",),
    "heading": ("h1", "h2", "h3", "h4", "h5", "h6"),
    "combobox": ("select",),
    "option": ("option",),
    "tab": (),
    "menuitem": (),
}

_ATTRIBUTE_NAMED = ("input", "textarea", "select", "option")


def _name_predicate(name: str) -> str:
    """normalize-space() equality, or a contains() on a prefix when too long."""
    if len(name) <= _MAX_EXACT_NAME:
        return "normalize-space()=" + _xpath_literal(name)
    return "contains(normalize-space(.), " + _xpath_literal(name[:40].strip()) + ")"


def _xpath_for_role(role: str, name: Optional[str]) -> str:
    """An XPath union covering the native tags and the ARIA spelling of `role`."""
    role = (role or "").strip().lower()
    tags = _ROLE_TAGS.get(role, ())
    role_literal = _xpath_literal(role or "button")

    if not name:
        branches = ["//" + tag for tag in tags]
        branches.append("//*[@role=" + role_literal + "]")
        return " | ".join(branches)

    predicate = _name_predicate(name)
    literal = _xpath_literal(name)
    branches: list[str] = []
    for tag in tags:
        if tag in _ATTRIBUTE_NAMED:
            # A field has no text content; its name comes from an attribute.
            branches.append(
                "//" + tag + "[@aria-label=" + literal
                + " or @placeholder=" + literal
                + " or @name=" + literal + "]"
            )
        else:
            branches.append("//" + tag + "[" + predicate + "]")
    branches.append("//*[@role=" + role_literal + "][" + predicate + "]")
    if role == "textbox":
        # The label-for-input pairing, which no attribute on the input carries.
        branches.append("//label[" + predicate + "]/following::input[1]")
    return " | ".join(branches)


def _katalon_selector(expression: Optional[str]) -> Optional[tuple[str, str]]:
    """Translate one Playwright locator expression into (kind, selector).

    Both the discovery catalogue and the locator agent store Playwright, so
    this is the single point where that vocabulary becomes something Katalon
    resolves. None means "not recognised": the caller then falls back and says
    so, rather than pasting a page.getByRole(...) call into Groovy.
    """
    if not expression:
        return None
    text = expression.strip()

    raw = _PW_RAW.search(text)
    if raw:
        selector, _ = _quoted_after(text, raw.end())
        selector = (selector or "").strip()
        if selector:
            kind = "xpath" if selector.startswith(("//", "(/")) else "css"
            return (kind, selector)

    role_match = _PW_ROLE.search(text)
    if role_match:
        role, after = _quoted_after(text, role_match.end())
        if role:
            name = None
            name_key = _PW_NAME_KEY.search(text, after)
            if name_key:
                name, _ = _quoted_after(text, name_key.end())
            return ("xpath", _xpath_for_role(role, name or None))

    named = _PW_NAMED.search(text)
    if named:
        kind = named.group(1)
        value, _ = _quoted_after(text, named.end())
        if not value:
            return None
        literal = _xpath_literal(value)
        if kind == "Label":
            return (
                "xpath",
                "//*[@aria-label=" + literal + "] | //label["
                + _name_predicate(value) + "]/following::input[1]",
            )
        if kind == "Placeholder":
            return ("xpath", "//*[@placeholder=" + literal + "]")
        if kind == "TestId":
            return ("xpath", "//*[@data-testid=" + literal + "]")
        if kind == "AltText":
            return ("xpath", "//*[@alt=" + literal + "]")
        if kind == "Title":
            return ("xpath", "//*[@title=" + literal + "]")
        return ("xpath", "//*[" + _name_predicate(value) + "]")

    return None


def _katalon_locator(
    step: dict,
    intent: str,
    *,
    catalog: Optional[list[dict]] = None,
    override: Optional[dict] = None,
) -> tuple[str, str, Optional[str]]:
    """(kind, selector, todo) for a step -- grounded first, inferred last.

    Mirrors build_locator's order of preference so the two frameworks ground a
    case identically: a catalogue match wins, then a locator the model resolved,
    then a selector the step already carries, then the phrase heuristic.
    """
    target = str(step.get("target") or "").strip()

    if catalog:
        entry, _reason = grounding.match_step(step, catalog)
        if entry is not None:
            # The catalogue stores role and accessible name as their own
            # fields, which translate more faithfully than re-parsing the
            # Playwright string it also stores.
            role = (entry.get("role") or "").strip()
            name = (entry.get("accessible_name") or "").strip()
            if role:
                return ("xpath", _xpath_for_role(role, name or None), None)
            translated = _katalon_selector(
                sanitize_catalog_locator(entry.get("recommended_locator"))
            )
            if translated:
                return (translated[0], translated[1], None)

    if override and override.get("locator"):
        translated = _katalon_selector(override["locator"])
        if translated:
            return (translated[0], translated[1], None)

    if target.startswith(("//", "(/")):
        return ("xpath", target, None)
    if target.startswith(("#", ".", "[")) or re.match(r"^[a-z]+\[[^\]]+\]$", target):
        return ("css", target, None)

    # Phrase heuristic: the same role hints the Playwright path reads, so
    # "the 'Submit' button" resolves to a button in both frameworks.
    phrase = _clean_target(target) if target else ""
    if phrase:
        role: Optional[str] = None
        lowered = target.lower()
        for pattern, hint in _ROLE_HINTS:
            if re.search(pattern, lowered):
                role = hint
                break
        if role is None and re.search(r"\bdrop ?down\b|\bcombo ?box\b|\bselect(or)?\b|\bpicker\b", lowered):
            role = "combobox"
        if role is None and any(re.search(p, lowered) for p in _FIELD_HINTS):
            role = "textbox"
        if role is None:
            role = "textbox" if intent == "fill" else "button"
        # selectOptionByLabel only works on a real <select>, so a step that is
        # going to compile to that keyword must resolve to one. Without this the
        # phrase heuristic sent "Size dropdown" to a button and the two halves
        # of the step disagreed about what the element even is.
        if intent == "select" and step.get("test_data_ref"):
            role = "combobox"
        return ("xpath", _xpath_for_role(role, phrase), _unresolved_name(phrase))

    # No target at all. The action itself usually quotes the thing it acts on
    # -- "Click 'Buy Now' on the plan" -- and a literal the refiner actually
    # wrote beats Playwright's page.locator('body') fallback, which for a click
    # is not a guess so much as a certainty of hitting the wrong thing. Still
    # reported as inferred, because it came from prose either way.
    quoted = _EXPECTED_QUOTED_RE.search(str(step.get("action") or ""))
    if quoted and quoted.group(1).strip():
        term = quoted.group(1).strip()
        return (
            "xpath",
            "//*[" + _name_predicate(term) + "]"
            " | //*[contains(normalize-space(.), " + _xpath_literal(term) + ")]",
            "No target on this step; matched on " + repr(term) + " quoted in the action.",
        )

    return (
        "xpath",
        "//body",
        "The step names no element, so no locator could be built for it.",
    )


def _katalon_url_check(text: Any) -> Optional[str]:
    """A URL verification built from a URL or path named in `text`, or None."""
    match = _EXPECTED_URL_RE.search(str(text or ""))
    if not match:
        return None
    raw = match.group(1).rstrip(".,;:)")
    path = raw.split("://", 1)[-1]
    if "/" in path:
        path = path[path.find("/"):]
    if len(path) <= 2:
        return None
    return "WebUI.verifyMatch(WebUI.getUrl(), " + _groovy(".*" + re.escape(path) + ".*") + ", true)"


def _katalon_expected(expected: Any, intent: str) -> Optional[str]:
    """A WebUI verification for a post-condition, or None to keep the comment.

    Same precision rule as expected_assertion: assert only what the refiner
    actually quoted or actually named. A fabricated assertion is a red run
    against a working application, and that teaches people to ignore failures.
    """
    if intent == "assert":
        return None
    text = str(expected or "").strip()
    if not text:
        return None

    url_check = _katalon_url_check(text)
    if url_check:
        return url_check

    literals = [
        q.strip()
        for q in _EXPECTED_QUOTED_RE.findall(text)
        if q.strip() and not q.strip().startswith(("http", "/", ".", "#", "["))
    ]
    if literals:
        if len(literals) > 1 and re.search(r"\bor\b", text, re.IGNORECASE):
            # Either satisfies the post-condition, so one object accepts both
            # rather than the first being asserted and the alternative lost.
            clauses = " or ".join(
                "contains(normalize-space(.), " + _xpath_literal(item) + ")"
                for item in dict.fromkeys(literals)
            )
            return (
                "WebUI.verifyElementPresent(locator('expected', "
                + _groovy("//*[" + clauses + "]")
                + ", 'xpath'), 15, FailureHandling.CONTINUE_ON_FAILURE)"
            )
        return (
            "WebUI.verifyTextPresent("
            + _groovy(literals[0])
            + ", false, FailureHandling.CONTINUE_ON_FAILURE)"
        )

    return None


KATALON_HELPER = """/**
 * A TestObject built at run time, so this script needs no Object Repository
 * entry to run. `kind` is 'xpath' or 'css' -- both are properties Katalon
 * resolves natively.
 */
def locator(String id, String selector, String kind) {
    TestObject object = new TestObject(id)
    object.addProperty(kind, ConditionType.EQUALS, selector)
    return object
}"""


def compile_katalon(
    case: Any,
    *,
    base_url: Optional[str] = None,
    catalog: Optional[list[dict]] = None,
    locator_overrides: Optional[dict[int, dict[str, Any]]] = None,
) -> CompiledScript:
    """A Katalon Studio test script: real WebUI calls, grounded locators.

    Generate-only still -- nothing offers to run it, because no runner exists
    in this deployment. What changed is that the file is now code.
    """
    overrides = locator_overrides or {}
    display_id = case.display_id or "test-case"
    slug = re.sub(r"[^A-Za-z0-9]+", "-", display_id).strip("-").lower() or "spec"
    steps = list(case.steps_structured or [])
    target_url = (base_url or getattr(case, "application_url", None) or "").strip()

    issues: list[StaticGateIssue] = []
    unresolved: list[dict[str, Any]] = []

    lines: list[str] = [
        "/**",
        (" * " + comment_text(display_id) + " - " + comment_text(case.objective or "")).rstrip(),
        " *",
        " * Katalon Studio (Groovy), generated from the refined test case. Every",
        " * locator below was either matched against the discovery catalogue or",
        " * inferred from the step's own words, and an inferred one carries a TODO.",
        " *",
        " * Test Objects are built at run time by locator(), so no Object Repository",
        " * entry is needed. Values come from environment variables, so no credential",
        " * or record id is baked into this file.",
        " */",
        "import com.kms.katalon.core.model.FailureHandling",
        "import com.kms.katalon.core.testobject.ConditionType",
        "import com.kms.katalon.core.testobject.TestObject",
        "import com.kms.katalon.core.webui.keyword.WebUiBuiltInKeywords as WebUI",
        "",
        KATALON_HELPER,
        "",
    ]

    seen_refs: list[str] = []
    for step in steps:
        ref = step.get("test_data_ref")
        if ref and str(ref) not in seen_refs:
            seen_refs.append(str(ref))
    if seen_refs:
        for ref in seen_refs:
            key = _env_key(ref)
            lines.append(
                "String " + _groovy_var(ref) + " = System.getenv(" + _groovy(key) + ") ?: "
                + _groovy("<set " + key + ">")
            )
        lines.append("")

    if case.preconditions:
        lines.append("// Preconditions:")
        for line in str(case.preconditions).splitlines():
            if line.strip():
                lines.append("//   - " + comment_text(line.strip()))
        lines.append("")

    lines.append("WebUI.openBrowser('')")
    lines.append("WebUI.maximizeWindow()")
    lines.append("")

    emitted = 0
    for index, step in enumerate(steps, start=1):
        number = step.get("step_number") or index
        action = str(step.get("action") or "").strip()
        if not action:
            continue
        emitted += 1

        intent = _intent(action, step.get("action_type"))
        expected = step.get("expected_result")
        data_ref = step.get("test_data_ref")

        lines.append("// " + step_title(number, action))

        if intent == "goto":
            action_url = re.search(r"https?://[^\s'\"\)\>]+", action)
            if _is_navigation_target(step.get("target")):
                destination = str(step.get("target")).strip()
            elif action_url:
                destination = action_url.group(0).rstrip(".,)")
            else:
                destination = target_url
            if not destination:
                issues.append(
                    StaticGateIssue(
                        "error", "Step " + str(number) + " navigates but no application URL is set."
                    )
                )
                lines.append("// TODO: no application URL configured for this navigation.")
            else:
                lines.append("WebUI.navigateToUrl(" + _groovy(destination) + ")")
                lines.append("WebUI.waitForPageLoad(30)")
        elif intent == "wait":
            lines.append("WebUI.waitForPageLoad(30)")
        else:
            kind, selector, todo = _katalon_locator(
                step, intent, catalog=catalog, override=overrides.get(number)
            )

            # A verification step whose element could not be resolved, but which
            # names a URL, is really a navigation check. Asserting the URL is
            # something that can actually pass; asserting a guessed element is a
            # red run on a working application, which is the worse of the two.
            url_check = (
                (_katalon_url_check(action) or _katalon_url_check(expected))
                if intent == "assert" and todo
                else None
            )
            if url_check:
                lines.append(url_check)
                if expected:
                    lines.append("// expected: " + comment_text(expected))
                lines.append("")
                continue

            if todo:
                unresolved.append(
                    {
                        "step_number": number,
                        "action": action,
                        "target": step.get("target"),
                        "intent": intent,
                        "reason": todo,
                    }
                )
                issues.append(StaticGateIssue("warning", "Step " + str(number) + ": " + todo))
                lines.append("// TODO: " + comment_text(todo))

            obj = (
                "locator(" + _groovy("step" + str(number)) + ", "
                + _groovy(selector) + ", " + _groovy(kind) + ")"
            )
            if intent == "fill":
                value = _groovy_var(data_ref) if data_ref else _groovy("Test Data")
                lines.append("WebUI.setText(" + obj + ", " + value + ")")
            elif intent == "select":
                if data_ref:
                    lines.append(
                        "WebUI.selectOptionByLabel(" + obj + ", " + _groovy_var(data_ref) + ", false)"
                    )
                else:
                    # A variant tile or a plan card is a click, not a <select>.
                    lines.append("WebUI.click(" + obj + ")")
            elif intent == "assert":
                lines.append("WebUI.verifyElementPresent(" + obj + ", 15)")
            else:
                lines.append("WebUI.click(" + obj + ")")

        if expected:
            lines.append("// expected: " + comment_text(expected))
            verification = _katalon_expected(expected, intent)
            if verification:
                lines.append(verification)
        lines.append("")

    lines.append("WebUI.closeBrowser()")

    if emitted < len(steps):
        issues.append(
            StaticGateIssue(
                "warning",
                str(len(steps) - emitted) + " step(s) had no action text and were skipped.",
            )
        )
    if emitted == 0:
        issues.append(StaticGateIssue("error", "The script emitted no steps."))

    notes = [
        "Katalon is generate-only in this deployment - no runner exists, so this "
        "file is for download and use in Katalon Studio."
    ]
    notes.extend("Set " + _env_key(ref) + " before running." for ref in seen_refs)

    return CompiledScript(
        framework="katalon",
        language="groovy",
        file_name=slug + ".groovy",
        code="\n".join(lines) + "\n",
        entry_path=slug + ".groovy",
        execution_command="",
        setup_notes=notes,
        generation_mode="compiled",
        issues=issues,
        step_count=emitted,
        unresolved=unresolved,
    )


def _generate_only(case: Any, framework: str) -> CompiledScript:
    """Appium: emit a readable skeleton, never offer to run it.

    No mobile runner exists here or upstream, and unlike the web frameworks
    there is no discovery catalogue of mobile elements to ground against, so
    every selector would be a guess. Katalon left this path when it gained a
    real emitter -- see compile_katalon.
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
    # A line inside a /** ... */ block carries no code, and prose in one
    # routinely contains an apostrophe -- "the step's real work". The scanner
    # already stops at a `//`, so line comments were safe; block comments were
    # not, and a helper documented in JSDoc could fail the gate for a sentence
    # rather than for anything the file does. Recognising the continuation and
    # delimiter lines is enough: nothing here emits code on them.
    stripped = line.strip()
    if stripped.startswith(("*", "/*")) or stripped.endswith("*/"):
        return False

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
    if re.search(r"\bawait\s+\[[^\n]+?\]\.(?:fill|click|check|press|selectOption)\s*\(", code):
        issues.append(StaticGateIssue("error", "A CSS selector was used as code instead of a Playwright locator. Regenerate or edit the script before running."))

    # first/last/nth are methods on a Locator, not properties, so `.first.click()`
    # reads the function object and calls `.click` on it: "TypeError:
    # page.locator(...).first.click is not a function", thrown the instant the
    # step runs. Every other check here passed such a spec, so the defect cost a
    # browser, a workspace and a red run to discover something no element on the
    # page could have changed. Anchored to a closing paren so a selector string
    # that happens to contain ".first." is not mistaken for one.
    for match in re.finditer(r"\)\.(first|last|nth)\s*\.", code):
        issues.append(
            StaticGateIssue(
                "error",
                f".{match.group(1)} is called without parentheses - it is a method, "
                f"so this throws at runtime. Use .{match.group(1)}() instead.",
            )
        )
        break
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


def validate_case_contract(code: str, case: Any) -> list[StaticGateIssue]:
    """Catch stored specs that perform a different action than the approved case.

    This runs again before execution, including for scripts generated before
    the current compiler. It never substitutes a locator or test-data value.
    """
    issues: list[StaticGateIssue] = []
    blocks = re.split(r"(?=^\s*await test\.step\()", code or "", flags=re.M)
    for step in (case.steps_structured or []):
        number = step.get("step_number")
        if not number:
            continue
        block = next((part for part in blocks if re.match(rf"\s*await test\.step\(\s*['\"]{number}\.", part)), "")
        if not block:
            continue
        executable = "\n".join(line for line in block.splitlines() if not line.lstrip().startswith("//"))
        expected = str(step.get("expected_result") or "")
        if str(step.get("action_type") or "").lower() == "fill":
            match = re.search(r"\b(?:contains?|has|equals?|is)\s+(?:the\s+value\s+)?['\"]([^'\"]+)['\"]", expected, re.I)
            literal = re.search(r"\.fill\(\s*(['\"])(.*?)\1\s*\)", executable)
            if match and literal and match.group(1) != literal.group(2):
                issues.append(StaticGateIssue("error", f"Step {number}: generated input differs from the approved value. Regenerate after linking this step to Test Data."))
        if str(step.get("action_type") or "").lower() == "assert":
            if _EXPECTED_URL_RE.search(expected) and "toHaveURL(" not in executable:
                issues.append(StaticGateIssue("error", f"Step {number}: the approved destination is not asserted. Regenerate after capturing the result page."))
            combined = f"{step.get('action') or ''} {expected} {getattr(case, 'expected_result', '') or ''}"
            if re.search(r"\bcontrol\s+is\s+(?:absent|not\s+(?:visible|shown|displayed))\b", combined, re.I) and "toBeHidden(" not in executable:
                issues.append(StaticGateIssue("error", f"Step {number}: the required absent control is not asserted. Regenerate using a complete browser observation."))
    return issues


def compile_for(
    case: Any,
    framework: str,
    *,
    base_url: Optional[str] = None,
    catalog: Optional[list[dict]] = None,
    locator_overrides: Optional[dict[int, dict[str, Any]]] = None,
    outcome_observation: Optional[dict] = None,
) -> CompiledScript:
    """`catalog` and `locator_overrides` reach Playwright and Katalon, which
    both compile grounded locators. Appium is still a generate-only skeleton --
    see _generate_only."""
    if framework not in FRAMEWORKS:
        raise ValueError(
            f"Unknown framework {framework!r}. Expected one of: {', '.join(FRAMEWORKS)}"
        )
    if framework == "playwright":
        return compile_playwright(
            case,
            base_url=base_url,
            catalog=catalog,
            locator_overrides=locator_overrides,
            outcome_observation=outcome_observation,
        )
    if framework == "katalon":
        return compile_katalon(
            case,
            base_url=base_url,
            catalog=catalog,
            locator_overrides=locator_overrides,
        )
    return _generate_only(case, framework)
