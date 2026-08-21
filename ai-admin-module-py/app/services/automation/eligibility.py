"""
--- Automation Module: is this test case ready to automate? -------------------

Deterministic and explainable. No LLM call, so the same case always scores the
same and a low score always names its reasons -- a bare number is not
actionable, and "score 55" without "no discrete steps, mentions OTP" tells an
author nothing.

The rules read the field names the data actually uses. Generation writes
"Test Case ID", "Test Steps", "Expected Result" and so on with spaces and title
case, so those are matched exactly rather than normalised into something
tidier that would silently match nothing.

This is the cheap path. Refinement produces validated structured steps via the
LLM and is the quality path; this scorer is what lets an unrefined case be
judged at all, and what tells a user whether refining is worth it.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

# Keys as they appear in test_cases_details.test_case_details.
FIELD_DISPLAY_ID = "Test Case ID"
FIELD_CATEGORY = "Category"
FIELD_DESCRIPTION = "Test Case Description"
FIELD_PRECONDITIONS = "Preconditions"
FIELD_STEPS = "Test Steps"
FIELD_TEST_DATA = "Test Data"
FIELD_EXPECTED = "Expected Result"

# A step that needs a human cannot be automated unattended. Matched on word
# boundaries so "captcha" is caught but "capture" is not.
MANUAL_MARKERS = (
    r"\botp\b",
    r"\bcaptcha\b",
    r"\btwo[- ]factor\b",
    r"\bmfa\b",
    r"verify manually",
    r"manually verify",
    r"visually (?:confirm|verify|inspect)",
    r"\bhuman (?:review|check)\b",
)

VERDICT_READY = "ready"
VERDICT_REVIEW = "review"
VERDICT_NEEDS_ENHANCEMENT = "needs_enhancement"


@dataclass(slots=True)
class EligibilityResult:
    score: int
    verdict: str
    reasons: list[str] = field(default_factory=list)
    step_count: int = 0

    @property
    def can_generate(self) -> bool:
        """Whether generation should be offered at all.

        A case below the enhancement threshold is not blocked out of caution --
        it is blocked because generating from it wastes an LLM call and
        produces a script nobody should trust.
        """
        return self.verdict in (VERDICT_READY, VERDICT_REVIEW)

    def to_dict(self) -> dict:
        return {
            "score": self.score,
            "verdict": self.verdict,
            "reasons": list(self.reasons),
            "step_count": self.step_count,
            "can_generate": self.can_generate,
        }


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return " ".join(str(v) for v in value if v)
    return str(value).strip()


def split_steps(raw: Any) -> list[str]:
    """Split a test case's steps into discrete actions.

    "Test Steps" arrives as ONE string with the steps numbered inside it:

        "1. Navigate to the login page. 2. Enter valid username and
         password. 3. Click the Login button."

    Nothing downstream can consume that -- a compiler needs discrete steps, and
    so does the count this scorer checks. Handles the numbering styles the data
    actually uses, and falls back to line splitting when there is no numbering
    at all.

    A list input is passed through, since refinement produces one.
    """
    if isinstance(raw, (list, tuple)):
        return [str(item).strip() for item in raw if str(item).strip()]

    text = _text(raw)
    if not text:
        return []

    # "Step 1:" / "Step 1." — strip the word so the numeric pass below sees it.
    text = re.sub(r"\bstep\s+(\d+)\s*[:.\)]", r"\1.", text, flags=re.IGNORECASE)

    # Split before a number followed by . ) or : that starts a step. Requires
    # the number to be at the start or preceded by whitespace, so a decimal
    # inside a sentence ("wait 1.5 seconds") does not split it.
    parts = re.split(r"(?:(?<=^)|(?<=\s))(?=\d{1,2}\s*[.)\:]\s+)", text)
    steps = []
    for part in parts:
        cleaned = re.sub(r"^\d{1,2}\s*[.)\:]\s*", "", part).strip()
        cleaned = cleaned.strip(" .;")
        if cleaned:
            steps.append(cleaned)

    if len(steps) > 1:
        return steps

    # No numbering: try lines, then sentences.
    lines = [line.strip(" -•\t").strip() for line in text.splitlines()]
    lines = [line for line in lines if line]
    if len(lines) > 1:
        return lines

    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    return sentences if len(sentences) > 1 else ([text] if text else [])


def _has_manual_marker(*values: Any) -> str | None:
    haystack = " ".join(_text(v) for v in values).lower()
    for pattern in MANUAL_MARKERS:
        match = re.search(pattern, haystack)
        if match:
            return match.group(0)
    return None


def score_test_case(details: dict) -> EligibilityResult:
    """Score one test case from its detail dict.

    Accepts the shape stored in test_cases_details.test_case_details, and also
    the lower-case keys the Studio's own table uses, so an approved case and a
    manually authored one score identically.
    """
    if not isinstance(details, dict):
        return EligibilityResult(0, VERDICT_NEEDS_ENHANCEMENT, ["No test case content"], 0)

    def pick(*keys: str) -> Any:
        for key in keys:
            if key in details and details[key] not in (None, ""):
                return details[key]
        return ""

    steps_raw = pick(FIELD_STEPS, "steps_raw", "steps")
    expected = pick(FIELD_EXPECTED, "expected_result")
    test_data = pick(FIELD_TEST_DATA, "test_data")
    preconditions = pick(FIELD_PRECONDITIONS, "preconditions")
    description = pick(FIELD_DESCRIPTION, "description")

    score = 0
    reasons: list[str] = []

    steps = split_steps(steps_raw)
    if len(steps) >= 2:
        score += 25
    elif len(steps) == 1:
        score += 10
        reasons.append("Only one step could be identified — steps may not be separated")
    else:
        reasons.append("No test steps")

    if _text(expected):
        score += 25
    else:
        reasons.append("No expected result")

    if _text(test_data):
        score += 15
    else:
        reasons.append("No test data")

    if _text(preconditions):
        score += 15
    else:
        reasons.append("No preconditions")

    if len(_text(description).split()) >= 5:
        score += 10
    else:
        reasons.append("Description is missing or too short to convey intent")

    marker = _has_manual_marker(steps_raw, expected, preconditions, description)
    if marker is None:
        score += 10
    else:
        reasons.append(f"Needs a human step ({marker}) — cannot run unattended")

    if score >= 70:
        verdict = VERDICT_READY
    elif score >= 50:
        verdict = VERDICT_REVIEW
    else:
        verdict = VERDICT_NEEDS_ENHANCEMENT

    return EligibilityResult(score=score, verdict=verdict, reasons=reasons, step_count=len(steps))
