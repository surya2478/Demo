"""
--- Automation Module: why can (or cannot) this test case run unattended? -----

`Classify by rule` used to answer one question -- "does anything in this case
mention a human?" -- and everything that passed it landed in Automation. That
is the right answer to the wrong question. A case can be free of OTPs and still
be unautomatable because it happens on a channel no harness drives, and it can
be automatable in principle while three of its steps name a control the crawl
never found. Both came out as a green badge, and the first honest signal was a
red run days later.

So the rule engine asks three questions instead of one, over the same
deterministic, explainable rules:

  * STEPS   -- is every step an instruction a runner could execute? A step with
               no verb, no target, an "if applicable", or a human in the middle
               of it is not.
  * CHANNEL -- does this case even happen in a browser? A retail counter, an
               IVR call, an SMS the customer receives and a native mobile app
               are all real test cases and none of them are Playwright's.
  * KB      -- do the controls the steps name exist in what discovery found, or
               in the Knowledge Base profile the compiler will read? An
               unresolved locator is not a blocker, but it is work, and the
               author deserves to see it before approving a batch of thirty.

The three answers combine into one of three outcomes, which is the distinction
the old two-way split could not express:

  automation -- nothing to fix; compile it.
  partial    -- automatable after named, minor edits. This is the bucket that
                did not exist, and the one most real cases fall into.
  manual     -- something in it genuinely cannot run unattended.
  undecided  -- there is not enough here to judge at all.

Still no LLM call. The same case classifies the same way twice, every finding
names its step and says what to do about it, and a batch of thirty costs
nothing -- which matters for a decision a human is about to accept in bulk.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

from . import grounding
from . import knowledge_base as kb
from .eligibility import MANUAL_MARKERS, split_steps
from .refine import normalize_action_type

logger = logging.getLogger(__name__)

CLASSIFICATION_AUTOMATION = "automation"
CLASSIFICATION_PARTIAL = "partial"
CLASSIFICATION_MANUAL = "manual"
CLASSIFICATION_UNDECIDED = "undecided"

# What a finding costs the case.
#
#   blocker -- no edit to the test case fixes this. It goes to Manual.
#   fixable -- a named, bounded change makes it automatable. It goes to Partial.
#   note    -- worth showing, changes nothing. Kept out of the verdict entirely
#              so the count under the badge stays a count of real work.
SEVERITY_BLOCKER = "blocker"
SEVERITY_FIXABLE = "fixable"
SEVERITY_NOTE = "note"

# Fixables that are a rewrite of the case or of the deployment, never "a small
# change": no steps at all, steps run together, an unknown channel, nothing
# known about the application.
CHANGES_UNBOUNDED = 99
_WHOLE_CASE_FIXABLES = frozenset({"steps.none", "steps.not_separated", "channel.unknown", "kb.none"})

STATUS_PASS = "pass"
STATUS_ATTENTION = "attention"
STATUS_BLOCKED = "blocked"


@dataclass(slots=True)
class Finding:
    """One thing the rules noticed, and what it means for the verdict.

    `remedy` is only filled for fixables, and is deliberately an instruction
    rather than a description: "name the button this step clicks" is actionable
    where "target is missing" is a field report.
    """

    code: str
    severity: str
    scope: str  # steps | channel | knowledge_base | test_data
    message: str
    step_number: Optional[int] = None
    remedy: Optional[str] = None
    evidence: Optional[str] = None
    # How many edits a fixable costs: one per step it names. A finding about
    # the whole case (no steps, nothing known about the application) is not a
    # small change at any size, so it carries CHANGES_UNBOUNDED.
    changes: int = 1

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "severity": self.severity,
            "scope": self.scope,
            "message": self.message,
            "step_number": self.step_number,
            "remedy": self.remedy,
            "evidence": self.evidence,
            "changes": self.changes,
        }


# ── Channel ──────────────────────────────────────────────────────────────────
#
# Support is a fact about the harness, not about the test case. Playwright
# drives a browser; everything else on this list is a channel a person or a
# different tool has to cover, and saying so by name is more useful than
# "cannot be automated".
#
#   supported    -- the compiler targets this today.
#   needs_change -- automatable, but not as the UI spec this compiler emits.
#   unsupported  -- no path from here to an unattended run.
SUPPORT_SUPPORTED = "supported"
SUPPORT_NEEDS_CHANGE = "needs_change"
SUPPORT_UNSUPPORTED = "unsupported"

CHANNEL_WEB = "web"
CHANNEL_API = "api"
CHANNEL_MOBILE_APP = "mobile_app"
CHANNEL_MESSAGING = "messaging"
CHANNEL_VOICE = "voice"
CHANNEL_RETAIL = "retail"
CHANNEL_DESKTOP = "desktop"
CHANNEL_UNKNOWN = "unknown"

# (channel, label, support, patterns, why)
#
# The patterns are written to need a verb or a channel noun, never a field
# name. "Enter the customer's email address" is a web form; "check the email
# the customer received" is the email channel. Matching bare "email" would put
# every registration test case in the manual pile, which is exactly the kind of
# confident wrong answer this whole module exists to avoid.
_CHANNEL_RULES: tuple[tuple[str, str, str, tuple[str, ...], str], ...] = (
    (
        CHANNEL_WEB,
        "Web",
        SUPPORT_SUPPORTED,
        (
            r"\bbrowser\b", r"\bweb\s?page\b", r"\bwebsite\b", r"\bweb portal\b",
            r"\bportal\b", r"https?://", r"\burl\b", r"\bchrome\b", r"\bfirefox\b",
            r"\bnavigate to\b", r"\blanding page\b", r"\bhome ?page\b",
            r"\blogin page\b", r"\bpage (?:loads|displays|opens)\b",
        ),
        "",
    ),
    (
        CHANNEL_API,
        "API",
        SUPPORT_NEEDS_CHANGE,
        (
            r"\bapi\b", r"\bendpoint\b", r"\brest(?:ful)?\s+(?:api|call|service)\b",
            r"\bsoap\b", r"\bgraphql\b", r"\bpostman\b", r"\bswagger\b",
            r"\bhttp (?:request|response)\b", r"\bpayload\b", r"\bcurl\b",
            r"\bstatus code\b", r"\bjson response\b",
        ),
        "This is an API case. It is automatable, but as a request-level spec "
        "rather than the browser spec the compiler emits today.",
    ),
    (
        CHANNEL_MOBILE_APP,
        "Mobile app",
        SUPPORT_UNSUPPORTED,
        (
            r"\bmobile app\b", r"\bandroid app\b", r"\bios app\b", r"\bnative app\b",
            r"\bapp store\b", r"\bplay store\b", r"\bapk\b", r"\bappium\b",
            r"\binstall the app\b", r"\blaunch the app\b", r"\bopen the app\b",
            r"\bin the app\b", r"\bsmartphone\b",
        ),
        "A native mobile app needs a device harness; this runner drives a browser.",
    ),
    (
        CHANNEL_MESSAGING,
        "SMS / email",
        SUPPORT_UNSUPPORTED,
        (
            r"\bsms\b", r"\btext message\b", r"\bwhatsapp\b",
            r"\b(?:receives?|received|sent|arrives?)\s+(?:an?\s+)?(?:sms|email|message)\b",
            r"\b(?:check|open|read|verify)\s+(?:the\s+)?(?:email|inbox|mailbox)\b",
            r"\bemail (?:is )?(?:received|delivered|triggered)\b", r"\binbox\b",
            r"\bpush notification\b",
        ),
        "Reading a message the customer receives happens outside the browser.",
    ),
    (
        CHANNEL_VOICE,
        "Voice / IVR",
        SUPPORT_UNSUPPORTED,
        (
            r"\bivr\b", r"\bcall cent(?:re|er)\b", r"\bcontact cent(?:re|er)\b",
            r"\bussd\b", r"\bdial\b", r"\bhotline\b", r"\bphone call\b",
            r"\bcall the customer\b", r"\bagent (?:calls|answers)\b",
        ),
        "A voice or USSD channel has no browser surface to drive.",
    ),
    (
        CHANNEL_RETAIL,
        "Retail / branch",
        SUPPORT_UNSUPPORTED,
        (
            r"\bretail (?:store|outlet|shop)\b", r"\bwalk[- ]in\b", r"\bin[- ]store\b",
            r"\bphysical (?:store|sim|document|copy)\b", r"\bkiosk\b",
            r"\bover the counter\b", r"\bbranch (?:staff|office)\b",
            r"\bcourier\b", r"\bdelivery (?:agent|rider)\b", r"\bhard copy\b",
        ),
        "This happens in the physical world, not in an application.",
    ),
    (
        CHANNEL_DESKTOP,
        "Desktop / legacy",
        SUPPORT_UNSUPPORTED,
        (
            r"\bsap gui\b", r"\bcitrix\b", r"\bmainframe\b", r"\bas400\b",
            r"\bdesktop application\b", r"\bwindows application\b",
            r"\bterminal emulator\b", r"\bputty\b", r"\bthick client\b",
        ),
        "A thick client needs a desktop driver, not a browser.",
    ),
)

_COMPILED_CHANNELS = tuple(
    (channel, label, support, tuple(re.compile(p, re.I) for p in patterns), why)
    for channel, label, support, patterns, why in _CHANNEL_RULES
)

_CHANNEL_LABELS = {channel: label for channel, label, _, _, _ in _CHANNEL_RULES}
_CHANNEL_LABELS[CHANNEL_UNKNOWN] = "Not stated"

_CHANNEL_SUPPORT = {channel: support for channel, _, support, _, _ in _CHANNEL_RULES}
_CHANNEL_WHY = {channel: why for channel, _, _, _, why in _CHANNEL_RULES}


# ── Step vocabulary ──────────────────────────────────────────────────────────

# A step a runner can execute starts from one of these. The list is the union
# of refine.ACTION_TYPES, the synonyms the refiner already maps, and the verbs
# that turn up in hand-written cases. A step matching none of them is prose,
# not an instruction -- which is a fixable, since rewriting it is a minute's
# work and the case is otherwise sound.
_ACTION_VERBS = (
    "navigate", "go to", "goto", "open", "visit", "browse", "launch", "load",
    "click", "tap", "press", "submit", "hit", "double[- ]click", "right[- ]click",
    "select", "choose", "pick", "toggle", "switch",
    "enter", "type", "input", "fill", "set", "provide", "populate", "key in",
    "upload", "attach", "download",
    "search", "filter", "sort", "scroll", "hover", "drag", "drop",
    "verify", "confirm", "validate", "check", "ensure", "expect", "observe",
    "assert", "see", "view",
    "login", "log in", "sign in", "logout", "log out", "sign out",
    "add", "remove", "delete", "update", "edit", "modify", "apply", "accept",
    "close", "refresh", "reload", "clear", "cancel", "proceed", "continue",
    "complete", "repeat", "wait", "capture",
    # An API case is still a case. Its steps are instructions even though the
    # channel check will separately say the compiler cannot emit them yet, and
    # reporting them as "not an instruction" on top of that would be two
    # findings for one fact.
    "send", "call", "invoke", "trigger", "execute", "run", "initiate",
    "request", "create", "save",
)
_ACTION_VERB_RE = re.compile(
    r"\b(?:" + "|".join(_ACTION_VERBS) + r")(?:s|es|ed|ing)?\b", re.I
)

# Verbs whose step must name the control it acts on. An assertion or a
# navigation need not -- "the order summary is displayed" is checkable without
# naming a button.
_NEEDS_TARGET_RE = re.compile(
    r"\b(?:click|tap|press|select|choose|enter|type|input|fill|set|provide|"
    r"populate|upload|attach|toggle|check|uncheck)(?:s|es|ed|ing)?\b",
    re.I,
)

# Wording that leaves the runner a choice. Every one of these has been the
# reason a generated script did the wrong thing confidently.
_VAGUE_RE = re.compile(
    r"\b(?:etc\.?|and so on|appropriate|appropriately|as (?:required|needed|applicable)|"
    r"if (?:required|needed|applicable|any)|where applicable|as per (?:the )?requirement|"
    r"necessary|relevant|various|suitable|some other|any other|valid data|"
    r"correct data|properly)\b",
    re.I,
)

# An assertion that does not say what to look at. "Correctly" is not a
# post-condition a runner can evaluate.
_UNCHECKABLE_RE = re.compile(
    r"\b(?:as expected|correctly|properly|successfully|without (?:any )?(?:issue|error)s?|"
    r"looks? (?:good|fine|correct)|works? (?:fine|as expected))\b",
    re.I,
)

_ASSERT_RE = re.compile(
    r"\b(?:verify|verifies|verified|confirm|confirms|validate|validates|ensure|"
    r"ensures|check|checks|assert|expect|should (?:be|display|show))\b",
    re.I,
)

_CONDITIONAL_RE = re.compile(
    r"(?:^|\s)(?:if|unless|otherwise|depending on|in case|optionally)\b", re.I
)

# Two instructions wearing one step number. The runner has to guess where the
# first ends, and a failure cannot be attributed to either half.
_COMPOUND_RE = re.compile(r"\band then\b|;\s*\S|\bafter (?:that|which)\b", re.I)

# A step that names data it was never given. Paired with an empty Test Data
# column this is the single most common reason a compiled script fails on its
# first run.
_DATA_HUNGRY_RE = re.compile(
    r"\b(?:valid|invalid|registered|existing|test)\s+"
    r"(?:credential|username|user name|password|account|customer|msisdn|mobile number|"
    r"email|card|iban|plan|user|id)\w*\b|\bcredentials\b|\btest data\b",
    re.I,
)

_COMPILED_MANUAL_MARKERS = tuple(re.compile(p, re.I) for p in MANUAL_MARKERS)

# A quotable control name inside an unrefined step. "Click on 'Submit'" and
# "click the Continue button" both name their target; the target column being
# empty only means nobody refined the case.
_INLINE_TARGET_RE = re.compile(
    r"['\"]|\b(?:button|field|link|tab|checkbox|radio|menu|icon|dropdown|option|"
    r"toggle|banner|tile|card|url|page|screen|form|search box|text ?box)\b",
    re.I,
)

# An instruction not to do something. "Do not select a plan" is a precondition
# wearing a step number: there is no action for a runner to take, and a
# compiler that reads it as an action does the exact thing the step forbids.
# Anchored to the start so "verify the button is not enabled" -- a real
# assertion -- is left alone.
_NEGATIVE_STEP_RE = re.compile(
    r"^\s*(?:do not|don't|avoid|refrain from)\b", re.I
)

# Steps that check rather than act. Grounding against the Knowledge Base's
# controls skips them: what they check is their expected result, which the
# compiler asserts, not a control the KB has to name.
_CHECK_STEP_RE = re.compile(
    r"^\s*(?:\d+[.)]\s*)?(?:verify|assert|check|confirm|ensure|validate|observe|wait|navigate|go to|open https?://)\b",
    re.I,
)


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return " ".join(str(item) for item in value if item)
    return str(value).strip()


def normalize_steps(steps_structured: Any, steps_raw: Any) -> list[dict]:
    """One shape for a step, whether it was refined or typed into a cell.

    A refined case carries dicts with action/target/expected_result; an
    imported one carries a numbered blob. Judging them differently would mean a
    case's classification changed the moment someone refined it without
    changing a word -- so both are flattened here first, and every check below
    reads only this shape.
    """
    normalized: list[dict] = []

    if isinstance(steps_structured, (list, tuple)) and steps_structured:
        for index, step in enumerate(steps_structured):
            if isinstance(step, dict):
                action = _text(step.get("action"))
                target = _text(step.get("target"))
                # The target is usually already inside the action sentence.
                # Appending it unconditionally would double every label and
                # skew the word overlap the KB check runs on.
                text = (
                    action
                    if target and target.lower() in action.lower()
                    else f"{action} {target}".strip()
                )
                normalized.append(
                    {
                        "step_number": step.get("step_number") or (index + 1),
                        "text": text,
                        "action": action,
                        "action_type": normalize_action_type(step.get("action_type")),
                        "target": target,
                        "expected_result": _text(step.get("expected_result")),
                    }
                )
            else:
                normalized.append(
                    {
                        "step_number": index + 1,
                        "text": _text(step),
                        "action": _text(step),
                        "action_type": None,
                        "target": "",
                        "expected_result": "",
                    }
                )
        return [step for step in normalized if step["text"]]

    for index, line in enumerate(split_steps(steps_raw)):
        normalized.append(
            {
                "step_number": index + 1,
                "text": line,
                "action": line,
                "action_type": None,
                "target": "",
                "expected_result": "",
            }
        )
    return normalized


def _manual_marker(text: str) -> Optional[str]:
    for pattern in _COMPILED_MANUAL_MARKERS:
        match = pattern.search(text)
        if match:
            return match.group(0)
    return None


# ── Check 1: the steps ───────────────────────────────────────────────────────

def check_steps(steps: list[dict], *, has_expected_result: bool) -> dict:
    """Judge every step on its own, and say which one failed and why.

    Per step rather than per case on purpose. "Needs a human" told an author
    that something somewhere in twelve steps mentioned an OTP; "step 7 needs a
    person (otp)" tells them which step to rewrite.
    """
    findings: list[Finding] = []
    actionable = 0

    for step in steps:
        number = step["step_number"]
        text = step["text"]
        lowered = text.lower()

        marker = _manual_marker(lowered)
        if marker:
            findings.append(
                Finding(
                    code="step.needs_human",
                    severity=SEVERITY_BLOCKER,
                    scope="steps",
                    step_number=number,
                    message=f"Step {number} needs a person at run time ({marker}).",
                    evidence=text[:200],
                )
            )
            continue

        has_verb = bool(_ACTION_VERB_RE.search(lowered)) or bool(step["action_type"])
        if not has_verb:
            findings.append(
                Finding(
                    code="step.no_action",
                    severity=SEVERITY_FIXABLE,
                    scope="steps",
                    step_number=number,
                    message=f"Step {number} reads as a statement, not an instruction.",
                    remedy="Rewrite it starting with the action (click, enter, select, verify).",
                    evidence=text[:200],
                )
            )
        else:
            actionable += 1

        # Only when the sentence itself names nothing quotable either -- an
        # unrefined step keeps its target inside the prose.
        if (
            _NEEDS_TARGET_RE.search(lowered)
            and not step["target"]
            and not _INLINE_TARGET_RE.search(text)
        ):
            findings.append(
                Finding(
                    code="step.no_target",
                    severity=SEVERITY_FIXABLE,
                    scope="steps",
                    step_number=number,
                    message=f"Step {number} acts on something it does not name.",
                    remedy="Name the control — its label, button text or role.",
                    evidence=text[:200],
                )
            )

        if _NEGATIVE_STEP_RE.search(text):
            findings.append(
                Finding(
                    code="step.negative",
                    severity=SEVERITY_FIXABLE,
                    scope="steps",
                    step_number=number,
                    message=f"Step {number} says what not to do, so there is no action to run.",
                    remedy="Move it to the preconditions, or state the action the case does take.",
                    evidence=text[:200],
                )
            )

        if _CONDITIONAL_RE.search(lowered):
            findings.append(
                Finding(
                    code="step.conditional",
                    severity=SEVERITY_FIXABLE,
                    scope="steps",
                    step_number=number,
                    message=f"Step {number} is conditional, so the runner has to decide.",
                    remedy="Split it into separate cases, or state which branch this case takes.",
                    evidence=text[:200],
                )
            )

        if _VAGUE_RE.search(lowered):
            findings.append(
                Finding(
                    code="step.vague",
                    severity=SEVERITY_FIXABLE,
                    scope="steps",
                    step_number=number,
                    message=f"Step {number} leaves the value or the control open to interpretation.",
                    remedy="Replace the open wording with the exact value or label.",
                    evidence=text[:200],
                )
            )

        if _ASSERT_RE.search(lowered) and _UNCHECKABLE_RE.search(lowered):
            findings.append(
                Finding(
                    code="step.uncheckable",
                    severity=SEVERITY_FIXABLE,
                    scope="steps",
                    step_number=number,
                    message=f"Step {number} verifies something no runner can evaluate.",
                    remedy="Say what should be on screen — the text, the field, the state.",
                    evidence=text[:200],
                )
            )

        if _COMPOUND_RE.search(text) and len(_ACTION_VERB_RE.findall(lowered)) > 1:
            findings.append(
                Finding(
                    code="step.compound",
                    severity=SEVERITY_FIXABLE,
                    scope="steps",
                    step_number=number,
                    message=f"Step {number} does more than one thing.",
                    remedy="Split it, so a failure points at one action.",
                    evidence=text[:200],
                )
            )

    if not steps:
        findings.append(
            Finding(
                code="steps.none",
                severity=SEVERITY_FIXABLE,
                scope="steps",
                message="No discrete steps could be read from this case.",
                remedy="Refine it, or number the steps in the Test Steps column.",
            )
        )
    elif len(steps) == 1:
        findings.append(
            Finding(
                code="steps.not_separated",
                severity=SEVERITY_FIXABLE,
                scope="steps",
                message="Only one step could be separated out of the Test Steps column.",
                remedy="Number the steps, or refine the case so they are split.",
            )
        )

    if not has_expected_result and not any(step["expected_result"] for step in steps):
        findings.append(
            Finding(
                code="steps.no_expected_result",
                severity=SEVERITY_FIXABLE,
                scope="steps",
                message="Nothing states what a pass looks like.",
                remedy="Add an expected result the run can assert on.",
            )
        )

    if any(f.severity == SEVERITY_BLOCKER for f in findings):
        status = STATUS_BLOCKED
    elif any(f.severity == SEVERITY_FIXABLE for f in findings):
        status = STATUS_ATTENTION
    else:
        status = STATUS_PASS

    return {
        "status": status,
        "total": len(steps),
        "actionable": actionable,
        "summary": _steps_summary(status, len(steps), actionable, findings),
        "findings": [f.to_dict() for f in findings],
        "_findings": findings,
    }


def _steps_summary(status: str, total: int, actionable: int, findings: list[Finding]) -> str:
    if status == STATUS_PASS:
        return f"All {total} step(s) are executable instructions."
    blockers = [f for f in findings if f.severity == SEVERITY_BLOCKER]
    if blockers:
        return f"{len(blockers)} step(s) need a person at run time."
    fixable = len([f for f in findings if f.severity == SEVERITY_FIXABLE])
    return f"{actionable} of {total} step(s) are executable; {fixable} need an edit."


# ── Check 2: the channel ─────────────────────────────────────────────────────

def check_channel(steps: list[dict], case_text: str) -> dict:
    """Which channel this case exercises, and whether the harness drives it.

    Two answers, not one. The dominant channel names the case; a single step on
    an unsupported channel blocks it regardless of what the other twenty do,
    because that step is where the run stops. A web journey that ends with
    "verify the confirmation SMS" is a web case with a manual tail, and calling
    it either purely web or purely manual loses the part that matters.
    """
    hits: dict[str, list[str]] = {}
    for channel, _, _, patterns, _ in _COMPILED_CHANNELS:
        for pattern in patterns:
            match = pattern.search(case_text)
            if match:
                hits.setdefault(channel, []).append(match.group(0).strip())

    findings: list[Finding] = []

    # Per step, so the report can point at the step that leaves the browser.
    off_channel: dict[str, list[int]] = {}
    for step in steps:
        for channel, _, support, patterns, _ in _COMPILED_CHANNELS:
            if support == SUPPORT_SUPPORTED:
                continue
            for pattern in patterns:
                if pattern.search(step["text"]):
                    off_channel.setdefault(channel, []).append(step["step_number"])
                    break

    for channel, numbers in off_channel.items():
        support = _CHANNEL_SUPPORT[channel]
        ordered = sorted(set(numbers))
        listed = ", ".join(str(n) for n in ordered[:6])
        findings.append(
            Finding(
                code=f"channel.{channel}",
                severity=(
                    SEVERITY_BLOCKER if support == SUPPORT_UNSUPPORTED else SEVERITY_FIXABLE
                ),
                scope="channel",
                step_number=ordered[0],
                message=(
                    f"Step(s) {listed} run on the {_CHANNEL_LABELS[channel]} channel. "
                    + _CHANNEL_WHY[channel]
                ).strip(),
                remedy=(
                    None
                    if support == SUPPORT_UNSUPPORTED
                    else "Split the API steps into their own case, or drop them from this one."
                ),
            )
        )

    # The case-level channel: the one with the most evidence, with web winning
    # ties because a browser noun is the weakest possible signal and everything
    # else on the list is a strong one.
    detected = CHANNEL_UNKNOWN
    if hits:
        detected = max(hits, key=lambda c: (len(hits[c]), c == CHANNEL_WEB))
    elif any(_ACTION_VERB_RE.search(step["text"]) for step in steps):
        # No channel noun anywhere, but the steps click and type. That is a
        # browser case that never said so, which is the common shape -- a note,
        # not a finding, because reading it as web has always been right.
        detected = CHANNEL_WEB
        findings.append(
            Finding(
                code="channel.assumed_web",
                severity=SEVERITY_NOTE,
                scope="channel",
                message="No channel is stated. Read as Web, because the steps drive a UI.",
            )
        )
    else:
        findings.append(
            Finding(
                code="channel.unknown",
                severity=SEVERITY_FIXABLE,
                scope="channel",
                message="The channel this case runs on cannot be determined from its text.",
                remedy="Name the channel — the portal, the app, the API — in the preconditions.",
            )
        )

    support = _CHANNEL_SUPPORT.get(detected, SUPPORT_SUPPORTED)
    if any(f.severity == SEVERITY_BLOCKER for f in findings):
        status = STATUS_BLOCKED
    elif any(f.severity == SEVERITY_FIXABLE for f in findings):
        status = STATUS_ATTENTION
    else:
        status = STATUS_PASS

    label = _CHANNEL_LABELS.get(detected, "Not stated")
    return {
        "status": status,
        "detected": detected,
        "label": label,
        "support": support,
        "evidence": sorted(set(hits.get(detected, [])))[:6],
        "summary": (
            f"{label} — drivable by this runner."
            if status == STATUS_PASS
            else f"{label} — see the findings."
        ),
        "findings": [f.to_dict() for f in findings],
        "_findings": findings,
    }


# ── Check 3: the knowledge base ──────────────────────────────────────────────

@dataclass
class ClassificationContext:
    """What the batch knows about the application, resolved once.

    A bulk classify of thirty cases asks the same two questions of the same
    application thirty times. The discovery catalogue is passed in by the
    router (one query per batch) and KB profiles are cached here by app id, so
    the file-backed Knowledge Base is read once per application rather than
    once per case.
    """

    catalog: list[dict] = field(default_factory=list)
    application_name: Optional[str] = None
    use_kb: bool = True
    _profiles: dict[str, Optional[dict]] = field(default_factory=dict, repr=False)

    def profile_for(self, case_text: str, linked_app: Optional[str] = None) -> tuple[Optional[str], Optional[dict]]:
        """The KB profile this case's text identifies, or (None, None).

        `linked_app` is the application the case is linked to (chosen on
        Generate Test Cases): its own profile, exactly, instead of reading one
        out of the text.

        Every failure here is swallowed deliberately. The Knowledge Base is a
        directory bind-mounted into the container, not part of the image; when
        it is missing the honest classification is "no KB", and a stack trace
        out of a bulk classify would lose thirty verdicts over a directory.
        """
        if not self.use_kb:
            return None, None
        if linked_app:
            if linked_app not in self._profiles:
                self._profiles[linked_app] = kb.load_exact_profile(linked_app)
            return linked_app, self._profiles.get(linked_app)
        try:
            app_id = kb.identify_app_id(case_text)
        except Exception:  # pragma: no cover - KB is optional infrastructure
            logger.debug("KB identify failed during classification", exc_info=True)
            return None, None
        if not app_id:
            return None, None
        if app_id not in self._profiles:
            try:
                self._profiles[app_id] = kb.load_app_profile(app_id)
            except Exception:  # pragma: no cover
                logger.debug("KB profile load failed for %s", app_id, exc_info=True)
                self._profiles[app_id] = None
        return app_id, self._profiles.get(app_id)


def _looks_like_selector(target: Any) -> bool:
    """A real selector or route, not prose that was copied into `target`."""
    text = str(target or "").strip()
    return text.startswith(("//", "(//", "/", "http", "#", ".", "[", "xpath=", "a[", "button", "input")) or ":has-text(" in text


def check_knowledge_base(
    steps: list[dict],
    case_text: str,
    context: ClassificationContext,
    linked_app: Optional[str] = None,
    case: Any = None,
) -> dict:
    """Do the controls these steps name exist in anything we know about?

    Never a blocker. A missing catalogue is a fact about the deployment, not
    about the test case -- crawling the application fixes it without touching a
    word of the case, which is the definition of a fixable. What it is not is
    invisible: a case whose every locator will be guessed should not carry the
    same green badge as one whose controls were all found.
    """
    findings: list[Finding] = []
    app_id, profile = context.profile_for(case_text, linked_app)

    # A case built on what a flow lists as not confirmed in the application
    # (unverified_from_brd) has nothing real to ground on: its script guesses,
    # and a guess either fails or passes on nothing. That is not a fix the author
    # can make in the case -- someone has to see the feature work first.
    if context.use_kb:
        try:
            unconfirmed = kb.unconfirmed_features(case_text, app_id)
        except Exception:  # pragma: no cover - the KB is optional infrastructure
            logger.debug("Unconfirmed-feature check failed for %s", app_id, exc_info=True)
            unconfirmed = []
        for hit in unconfirmed:
            findings.append(
                Finding(
                    code="kb.unconfirmed_feature",
                    severity=SEVERITY_BLOCKER,
                    scope="knowledge_base",
                    message=(
                        f"Depends on '{hit['feature']}', which the Knowledge Base flow "
                        f"'{hit['flow_name']}' marks as not confirmed in the application"
                        + (f" (described only by {hit['source']})" if hit.get("source") else "")
                        + "."
                    ),
                    remedy=(
                        "Test it manually for now. Once someone has seen it work, add it to the "
                        "flow's canonical steps with its real selector and classify again."
                    ),
                    evidence=hit.get("detail") or None,
                )
            )

    catalog = context.catalog or []
    if not catalog and profile and app_id and case is not None:
        # No crawl: ask the Knowledge Base what the compiler will ask it --
        # ground_case_structured_steps, flows plus the profile's grounding rules
        # -- instead of letting the profile's existence pass every step. A step
        # that acts on a control and comes back with no target will have its
        # locator guessed from prose. Verify steps are checked by their expected
        # result, not here.
        try:
            grounded = kb.ground_case_structured_steps(case, app_id)
        except Exception:  # pragma: no cover
            logger.debug("KB step grounding failed for %s", app_id, exc_info=True)
            grounded = []
        own_targets = {step["step_number"]: step["target"] for step in steps}
        unresolved_numbers = []
        for index, step in enumerate(grounded):
            number = step.get("step_number") or (index + 1)
            action = str(step.get("action") or "")
            if _CHECK_STEP_RE.match(action) or not grounding.needs_element(
                {"action": action, "target": step.get("target") or action}
            ):
                continue
            target = step.get("target")
            # The case's own target counts only when it is a real selector or
            # route -- the classifier reads prose into `target` when there is none.
            if not target or (target == own_targets.get(number) and not _looks_like_selector(target)):
                unresolved_numbers.append(number)
        if unresolved_numbers:
            listed = ", ".join(str(n) for n in unresolved_numbers[:6])
            findings.append(
                Finding(
                    code="kb.unresolved_in_profile",
                    severity=SEVERITY_FIXABLE,
                    changes=len(unresolved_numbers),
                    evidence=f"steps {', '.join(str(n) for n in unresolved_numbers)}",
                    scope="knowledge_base",
                    message=(
                        f"{len(unresolved_numbers)} step(s) name a control the Knowledge Base "
                        f"'{app_id}' does not have (step {listed}), so their locators would be guessed."
                    ),
                    remedy=(
                        "Reword them to the labels the application uses, add the control to the "
                        "Knowledge Base, or run discovery against the application."
                    ),
                )
            )

    summary = grounding.ground_test_case(
        [
            {
                "step_number": step["step_number"],
                "action": step["action"] or step["text"],
                "target": step["target"] or step["text"],
            }
            for step in steps
        ],
        catalog,
    )
    matched = len(summary["matched"])
    unresolved = summary["unresolved"]

    if not catalog:
        if profile:
            findings.append(
                Finding(
                    code="kb.profile_only",
                    severity=SEVERITY_NOTE,
                    scope="knowledge_base",
                    message=(
                        f"No crawl catalogue for this application. Locators will come "
                        f"from the Knowledge Base profile '{app_id}'."
                    ),
                )
            )
        else:
            findings.append(
                Finding(
                    code="kb.none",
                    severity=SEVERITY_FIXABLE,
                    scope="knowledge_base",
                    message=(
                        "Nothing is known about this application — no crawl catalogue "
                        "and no Knowledge Base profile, so every locator would be guessed."
                    ),
                    remedy="Run discovery against the target application, then classify again.",
                )
            )
    elif unresolved:
        listed = ", ".join(str(item["step_number"]) for item in unresolved[:6])
        findings.append(
            Finding(
                code="kb.unresolved",
                severity=SEVERITY_FIXABLE,
                changes=len(unresolved),
                scope="knowledge_base",
                message=(
                    f"{len(unresolved)} step(s) name a control the catalogue does not "
                    f"have (step {listed})."
                ),
                remedy=(
                    "Re-crawl the pages those steps reach, or reword them to the labels "
                    "the application actually uses."
                ),
            )
        )

    status = (
        STATUS_BLOCKED
        if any(f.severity == SEVERITY_BLOCKER for f in findings)
        else STATUS_ATTENTION
        if any(f.severity == SEVERITY_FIXABLE for f in findings)
        else STATUS_PASS
    )
    return {
        "status": status,
        "app_id": app_id,
        "profile": bool(profile),
        "application_name": context.application_name,
        "catalog_size": len(catalog),
        "matched": matched,
        "unresolved": unresolved,
        "skipped": summary["skipped"],
        "grounding_status": summary["status"],
        "summary": _kb_summary(catalog, matched, unresolved, app_id, bool(profile)),
        "findings": [f.to_dict() for f in findings],
        "_findings": findings,
    }


def _kb_summary(
    catalog: list[dict], matched: int, unresolved: list, app_id, has_profile: bool
) -> str:
    if not catalog:
        return (
            f"No catalogue; Knowledge Base profile '{app_id}' will supply locators."
            if has_profile
            else "No catalogue and no Knowledge Base profile for this application."
        )
    if not unresolved:
        return f"All {matched} control(s) these steps name were found in the catalogue."
    return f"{matched} control(s) found, {len(unresolved)} missing from the catalogue."


# ── Check 4: the test data ───────────────────────────────────────────────────

def check_test_data(steps: list[dict], case_test_data: Any, requirements: Any) -> dict:
    """Whether the steps ask for data the case does not carry.

    Separate from the Test Data badge, which tracks a human's decision. This
    one is about the text: a step saying "log in with valid credentials" beside
    an empty Test Data column is a script that fails on its first run, and it
    is worth naming before approval rather than after.
    """
    findings: list[Finding] = []
    has_data = bool(_text(case_test_data)) or bool(requirements)
    hungry = [step["step_number"] for step in steps if _DATA_HUNGRY_RE.search(step["text"])]

    if hungry and not has_data:
        listed = ", ".join(str(n) for n in hungry[:6])
        findings.append(
            Finding(
                code="data.unspecified",
                severity=SEVERITY_FIXABLE,
                scope="test_data",
                step_number=hungry[0],
                message=f"Step(s) {listed} need data the case does not carry.",
                remedy="Fill in Test Data with the values the run should use.",
            )
        )

    return {
        "status": STATUS_ATTENTION if findings else STATUS_PASS,
        "has_test_data": has_data,
        "steps_needing_data": hungry,
        "summary": (
            f"{len(hungry)} step(s) reference data that has not been provided."
            if findings
            else "Test data is present or not needed."
        ),
        "findings": [f.to_dict() for f in findings],
        "_findings": findings,
    }


# ── The verdict ──────────────────────────────────────────────────────────────

def _linked_app(case: Any) -> Optional[str]:
    try:
        from .applications import kb_key_for_case

        return kb_key_for_case(case)
    except Exception:  # pragma: no cover - a detached or plain object has no link
        return None


def assess(case: Any, context: Optional[ClassificationContext] = None) -> dict:
    """Run every check over one case and combine them into a verdict.

    Takes the ORM row (or anything carrying the same attributes), so callers do
    not have to shape a dict first, and returns the whole report -- the verdict,
    the badge line, and every finding with its step number. The caller decides
    what to persist.
    """
    context = context or ClassificationContext()

    steps = normalize_steps(
        getattr(case, "steps_structured", None), getattr(case, "steps_raw", None)
    )
    case_text = " ".join(
        _text(part)
        for part in (
            getattr(case, "category", None),
            getattr(case, "description", None),
            getattr(case, "objective", None),
            getattr(case, "preconditions", None),
            getattr(case, "steps_raw", None),
            getattr(case, "expected_result", None),
            getattr(case, "application_url", None),
        )
    )
    if steps:
        case_text = case_text + " " + " ".join(step["text"] for step in steps)

    checks = {
        "steps": check_steps(
            steps,
            has_expected_result=bool(_text(getattr(case, "expected_result", None))),
        ),
        "channel": check_channel(steps, case_text),
        "knowledge_base": check_knowledge_base(steps, case_text, context, _linked_app(case), case),
        "test_data": check_test_data(
            steps,
            getattr(case, "test_data", None),
            getattr(case, "test_data_requirements", None),
        ),
    }

    findings: list[Finding] = []
    # A refinement blocker is the model's own reading of the case and outranks
    # everything the regexes below can see, so it leads the list.
    for blocker in list(getattr(case, "automation_blockers", None) or []):
        text = str(blocker)
        if text.startswith("Open question: "):
            # Something to confirm, not something that stops a script: it is
            # shown with the case and does not change the verdict.
            findings.append(
                Finding(code="refine.question", severity=SEVERITY_NOTE, scope="steps", message=text)
            )
            continue
        findings.append(
            Finding(
                code="refine.blocker",
                severity=SEVERITY_BLOCKER,
                scope="steps",
                message=f"Refinement found something that cannot be automated: {text}",
            )
        )
    for check in checks.values():
        findings.extend(check.pop("_findings"))

    blockers = [f for f in findings if f.severity == SEVERITY_BLOCKER]
    fixables = [f for f in findings if f.severity == SEVERITY_FIXABLE]
    notes = [f for f in findings if f.severity == SEVERITY_NOTE]
    for finding in fixables:
        if finding.code in _WHOLE_CASE_FIXABLES:
            finding.changes = CHANGES_UNBOUNDED

    classification, reason = _verdict(steps, blockers, fixables, checks)

    return {
        "classification": classification,
        "reason": reason,
        "checks": checks,
        "blockers": [f.to_dict() for f in blockers],
        "fixables": [f.to_dict() for f in fixables],
        "notes": [f.to_dict() for f in notes],
        "counts": {
            "steps": len(steps),
            "blockers": len(blockers),
            "fixables": len(fixables),
            # Edits the fixables add up to; AI Checks automates a Partial case
            # whose count is small (ai_checks.AUTOMATE_MAX_CHANGES).
            "changes": sum(max(1, f.changes) for f in fixables),
        },
        "checked_at": datetime.utcnow().isoformat(),
        "engine": "rules/2",
    }


def _verdict(
    steps: list[dict], blockers: list[Finding], fixables: list[Finding], checks: dict
) -> tuple[str, str]:
    """One line under the badge, written to be read by whoever approves it."""
    if not steps:
        return (
            CLASSIFICATION_UNDECIDED,
            "No discrete steps to judge. Refine it first, then classify.",
        )

    if blockers:
        lead = blockers[0].message
        if len(blockers) > 1:
            lead += f" (+{len(blockers) - 1} more)"
        return CLASSIFICATION_MANUAL, lead

    if checks["steps"]["actionable"] == 0:
        return (
            CLASSIFICATION_UNDECIDED,
            "Nothing here reads as an instruction. Refine it first, then classify.",
        )

    if fixables:
        lead = fixables[0].message
        if len(fixables) > 1:
            lead += f" (+{len(fixables) - 1} more)"
        return CLASSIFICATION_PARTIAL, lead

    channel = checks["channel"]["label"]
    return (
        CLASSIFICATION_AUTOMATION,
        f"{len(steps)} executable step(s) on {channel}, every control found, "
        "nothing needing a person.",
    )


__all__ = [
    "CLASSIFICATION_AUTOMATION",
    "CLASSIFICATION_PARTIAL",
    "CLASSIFICATION_MANUAL",
    "CLASSIFICATION_UNDECIDED",
    "SEVERITY_BLOCKER",
    "SEVERITY_FIXABLE",
    "SEVERITY_NOTE",
    "STATUS_PASS",
    "STATUS_ATTENTION",
    "STATUS_BLOCKED",
    "ClassificationContext",
    "Finding",
    "assess",
    "check_channel",
    "check_knowledge_base",
    "check_steps",
    "check_test_data",
    "normalize_steps",
]
