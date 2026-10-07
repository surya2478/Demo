"""
--- Test Coverage Analysis: orchestration -------------------------------------

Input: requirement documents (SDD/BRD/Figma export/etc.) and one existing test
case sheet. Output: a coverage percentage, a per-requirement breakdown, and a
markdown table of the test cases missing to close the gaps.

Three LLM calls, not one, because a single "read all this and tell me the
coverage" prompt is unauditable and its percentage cannot be trusted:

  1. decompose_requirements  -- turn free-text requirements into a fixed list
     of atomic, independently-testable requirements, each tagged with which of
     positive/negative/edge/ui genuinely apply to it. This fixes the
     denominator before any coverage judgement is made.
  2. map_coverage            -- for each requirement, decide which applicable
     categories the EXISTING test cases already cover, and which existing
     test case IDs cover them. This fixes the numerator.
  3. recommend_test_cases    -- for every requirement/category gap found in
     step 2, write the test case that would close it.

Step 3 only ever sees the gaps, never the whole requirement set, so a document
with 40 requirements and 38 already covered spends its generation budget on
the 2 that matter rather than re-deriving everything the sheet already has.

The percentage itself is arithmetic over steps 1 and 2's output, computed in
compute_coverage() below -- never asked of the model.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock

from ...schemas.coverage import (
    TEST_CATEGORIES,
    CoverageMapping,
    RequirementDecomposition,
)
from ...config import settings
from .azure_llm import complete_json, complete_text, wrap_user_content

logger = logging.getLogger(__name__)
# The app configures no root handler, so INFO from here would otherwise never reach the console.
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s [COVERAGE] %(message)s"))
    logger.addHandler(_handler)
    logger.setLevel(logging.INFO if settings.COVERAGE_DEBUG_LOGS else logging.WARNING)
    logger.propagate = False

# Upper bound on any single text block written to the console.
_LOG_PREVIEW_CHARS = 2000


def _preview(text: str, limit: int = _LOG_PREVIEW_CHARS) -> str:
    text = text or ""
    if len(text) <= limit:
        return text
    return f"{text[:limit]}\n... [{len(text) - limit} more chars not shown]"


def _banner(title: str) -> None:
    logger.info("=" * 20 + f" {title} " + "=" * 20)


def _log_prompt(system_prompt: str, user_message: str) -> None:
    logger.info("--- System prompt (%d chars) ---\n%s", len(system_prompt), system_prompt)
    logger.info("--- User message sent to model (%d chars) ---\n%s", len(user_message), _preview(user_message))

# About 50K tokens of requirement text; longer input is truncated before the first call.
MAX_REQUIREMENTS_TEXT_CHARS = 200_000
MAX_TEST_CASE_ROWS = 400

_DECOMPOSE_SYSTEM_PROMPT = """You are a senior QA analyst reading a \
requirements document -- an SDD, a BRD, a user story set, or a Figma design \
export. Break it into a flat list of atomic, independently-testable \
requirements.

Rules:
- One requirement per row of behaviour. Split compound statements ("the \
system must X and Y") into separate requirements.
- requirement_id is REQ-1, REQ-2, ... sequential, no gaps.
- requirement_text is one sentence stating what the system must do, in your \
own words -- do not quote the document verbatim.
- applicable_categories is the subset of ["positive", "negative", "edge", \
"ui"] that genuinely applies:
  - positive: the requirement has a valid/happy path to verify. Almost \
always applies.
  - negative: there is a way to violate this requirement (invalid input, \
missing input, wrong permission, wrong state) worth a test for.
  - edge: the requirement has a boundary, limit, or empty/maximum condition.
  - ui: the requirement describes something a user sees or interacts with \
on a screen.
- Do not invent requirements the document does not support. A short document \
should produce a short list.

Return ONLY JSON matching this shape, nothing else:
{"requirements": [{"requirement_id": "REQ-1", "requirement_text": "...", \
"applicable_categories": ["positive", "negative"]}]}"""

_MAP_COVERAGE_SYSTEM_PROMPT = """You are a senior QA analyst comparing a list \
of requirements against an existing set of test cases, to find what is \
already tested and what is missing.

You will be given REQUIREMENTS (with the test categories that apply to each) \
and EXISTING TEST CASES (as written by a human or a prior AI run, in \
whatever columns the sheet happens to have).

For every requirement, decide, for each of its applicable_categories, whether \
an existing test case already exercises it. A test case covers a category \
only if its description or steps actually test that angle -- a single happy- \
path test case does not also cover "negative" or "edge" just because it \
touches the same feature.

Return ONLY JSON matching this shape, nothing else:
{"coverage": [{"requirement_id": "REQ-1", "covered_categories": ["positive"], \
"matched_test_case_ids": ["TC-003"], "gap_reason": "No test exercises the \
invalid-input path."}]}

covered_categories only lists categories that ARE covered. gap_reason \
explains what is missing for the categories NOT in covered_categories; leave \
it empty ("") when every applicable category is covered. matched_test_case_ids \
lists whichever existing test case IDs support the covered categories -- empty \
list when nothing covers this requirement at all."""

_RECOMMEND_SYSTEM_PROMPT = """You are a senior QA analyst writing the test \
cases needed to close specific coverage gaps in an existing test suite.

You will be given a list of gaps, each a requirement and the category \
(positive, negative, edge, or ui) not yet covered. Write exactly one test \
case per gap.

OUTPUT FORMAT

Return ONE GitHub-flavoured markdown table and nothing else. No preamble, no \
code fence, no notes after the table. Exactly these columns, in this order:

| Test Case ID | Category | Gap Addressed | Test Case Description | Preconditions | Test Steps | Test Data | Expected Result | Priority |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

- Test Case ID: NEW-TC-001, NEW-TC-002, ... sequential, no gaps.
- Category: Positive, Negative, Edge or UI -- the gap's category, capitalised.
- Gap Addressed: the requirement_id this case closes, e.g. "REQ-4".
- Test Case Description: one sentence, starting with a verb.
- Preconditions: state required before the steps, or "None".
- Test Steps: numbered inline in one cell, e.g. "1. ... 2. ... 3. ...".
- Test Data: concrete values used, or "None". Never invent real personal data.
- Expected Result: an observable, pass/fail outcome.
- Priority: High, Medium or Low.

Every cell is a single line. Never use a literal "|" inside a cell -- write \
"or" instead."""

# Built-in prompts. Edits made on the settings screen are stored in
# app/coverage_prompts.json and override these per key.
DEFAULT_PROMPTS: dict[str, str] = {
    "decompose": _DECOMPOSE_SYSTEM_PROMPT,
    "map": _MAP_COVERAGE_SYSTEM_PROMPT,
    "recommend": _RECOMMEND_SYSTEM_PROMPT,
}

_PROMPTS_PATH = Path(__file__).resolve().parents[2] / "coverage_prompts.json"
_PROMPTS_LOCK = Lock()


def get_prompts() -> dict[str, str]:
    """Current prompt per stage: the saved override, else the built-in default."""
    prompts = dict(DEFAULT_PROMPTS)
    with _PROMPTS_LOCK:
        if not _PROMPTS_PATH.exists():
            return prompts
        try:
            saved = json.loads(_PROMPTS_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            logger.warning("Unreadable %s -- using built-in coverage prompts", _PROMPTS_PATH.name)
            return prompts
    for key in DEFAULT_PROMPTS:
        value = str(saved.get(key) or "").strip() if isinstance(saved, dict) else ""
        if value:
            prompts[key] = value
    return prompts


def save_prompts(prompts: dict[str, str]) -> dict[str, str]:
    """Persist all three prompts. A prompt equal to its default is stored as empty, so it tracks future default changes."""
    stored = {
        key: "" if prompts[key].strip() == DEFAULT_PROMPTS[key].strip() else prompts[key].strip()
        for key in DEFAULT_PROMPTS
    }
    with _PROMPTS_LOCK:
        _PROMPTS_PATH.write_text(json.dumps(stored, indent=2, ensure_ascii=False), encoding="utf-8")
    return get_prompts()


@dataclass
class Gap:
    requirement_id: str
    requirement_text: str
    category: str


@dataclass
class CoverageResult:
    coverage_percentage: float
    total_slots: int
    covered_slots: int
    total_requirements: int
    fully_covered_requirements: int
    partially_covered_requirements: int
    not_covered_requirements: int
    requirement_breakdown: list[dict]
    category_breakdown: dict[str, dict[str, int]]
    gaps: list[Gap] = field(default_factory=list)

# Decompose the requirements text into structured RequirementDecomposition object.
# Inputs:
# - requirements_text: The raw text containing the requirements to be decomposed.
# Returns:
# - A RequirementDecomposition object representing the structured decomposition of the requirements.
def decompose_requirements(requirements_text: str) -> RequirementDecomposition:
    _banner("LLM CALL 1/3: DECOMPOSE REQUIREMENTS")
    original = (requirements_text or "").strip()
    text = original[:MAX_REQUIREMENTS_TEXT_CHARS]
    logger.info(
        "Input: %d chars of requirement text (%d sent to the model%s)",
        len(original),
        len(text),
        ", TRUNCATED" if len(original) > len(text) else "",
    )
    if not text:
        logger.info("No text to decompose -- skipping the LLM call.")
        return RequirementDecomposition(requirements=[])
    user_message = wrap_user_content(text)
    system_prompt = get_prompts()["decompose"]
    _log_prompt(system_prompt, user_message)

    started = time.perf_counter()
    decomposition = complete_json(
        system_prompt=system_prompt,
        user_input=user_message,
        model_cls=RequirementDecomposition,
        max_tokens=settings.AZURE_OPENAI_MAX_TOKENS,
    )
    logger.info(
        "Output: %d requirement(s) in %.1fs",
        len(decomposition.requirements),
        time.perf_counter() - started,
    )
    for r in decomposition.requirements:
        logger.info(
            "  %s [%s] %s",
            r.requirement_id,
            ", ".join(r.applicable_categories) or "no categories",
            r.requirement_text,
        )
    return decomposition


def _format_existing_test_cases(rows: list[dict[str, str]]) -> str:
    """Render whatever columns the uploaded sheet has as plain text.

    No header mapping here on purpose -- the mapping step's model reads the
    headers itself, which tolerates any sheet layout instead of only the one
    this application happens to export.
    """
    if not rows:
        return "(no existing test cases were provided)"

    lines = []
    for index, row in enumerate(rows[:MAX_TEST_CASE_ROWS]):
        display_id = (
            row.get("Test Case ID")
            or row.get("display_id")
            or row.get("ID")
            or f"ROW-{index + 1}"
        )
        cells = "; ".join(f"{k}: {v}" for k, v in row.items() if str(v or "").strip())
        lines.append(f"- {display_id} -> {cells}")
    return "\n".join(lines)

# Map coverage of requirements to existing test cases
# Returns a mapping of which requirements are covered by which existing test cases
# Inputs:
# - decomposition: The decomposed requirements.
# - existing_rows: The rows from the uploaded test case sheet.
# Returns:
# - A CoverageMapping object representing which requirements are covered by which existing test cases.
def map_coverage(
    decomposition: RequirementDecomposition, existing_rows: list[dict[str, str]]
) -> CoverageMapping:
    _banner("LLM CALL 2/3: MAP COVERAGE")
    if not decomposition.requirements:
        logger.info("No requirements to map -- skipping the LLM call.")
        return CoverageMapping(coverage=[])

    requirements_block = "\n".join(
        f"- {r.requirement_id} [{', '.join(r.applicable_categories) or 'none'}]: {r.requirement_text}"
        for r in decomposition.requirements
    )
    user_input = (
        "REQUIREMENTS:\n"
        f"{requirements_block}\n\n"
        "EXISTING TEST CASES:\n"
        f"{_format_existing_test_cases(existing_rows)}"
    )
    logger.info(
        "Input: %d requirement(s), %d existing test case row(s) (%d sent), prompt %d chars",
        len(decomposition.requirements),
        len(existing_rows),
        min(len(existing_rows), MAX_TEST_CASE_ROWS),
        len(user_input),
    )
    user_message = wrap_user_content(user_input)
    system_prompt = get_prompts()["map"]
    _log_prompt(system_prompt, user_message)

    started = time.perf_counter()
    mapping = complete_json(
        system_prompt=system_prompt,
        user_input=user_message,
        model_cls=CoverageMapping,
        max_tokens=settings.AZURE_OPENAI_MAX_TOKENS,
    )
    logger.info(
        "Output: %d requirement assessment(s) in %.1fs",
        len(mapping.coverage),
        time.perf_counter() - started,
    )
    for c in mapping.coverage:
        logger.info(
            "  %s covered=[%s] matched=[%s] gap=%s",
            c.requirement_id,
            ", ".join(c.covered_categories),
            ", ".join(c.matched_test_case_ids),
            c.gap_reason or "-",
        )
    missing = {r.requirement_id for r in decomposition.requirements} - {
        c.requirement_id for c in mapping.coverage
    }
    if missing:
        logger.info("Model did not assess: %s (treated as not covered)", ", ".join(sorted(missing)))
    return mapping

# Compute overall coverage statistics based on the mapping of requirements to test cases.
# Inputs:
# - decomposition: The decomposed requirements.
# - mapping: The coverage mapping obtained from map_coverage.
# Returns:
# - A CoverageResult object containing overall coverage statistics and breakdown per requirement.
def compute_coverage(
    decomposition: RequirementDecomposition, mapping: CoverageMapping
) -> CoverageResult:
    """Arithmetic over the two model calls above. No LLM involved here."""
    _banner("COMPUTE COVERAGE (no LLM)")
    coverage_by_id = {c.requirement_id: c for c in mapping.coverage}

    total_slots = 0
    covered_slots = 0
    fully_covered = partially_covered = not_covered = 0
    breakdown: list[dict] = []
    category_totals = {c: {"covered": 0, "total": 0} for c in TEST_CATEGORIES}
    gaps: list[Gap] = []

    for requirement in decomposition.requirements:
        applicable = [c for c in requirement.applicable_categories if c in TEST_CATEGORIES]
        result = coverage_by_id.get(requirement.requirement_id)
        covered = set(result.covered_categories) & set(applicable) if result else set()

        ignored_applicable = set(requirement.applicable_categories) - set(applicable)
        ignored_covered = set(result.covered_categories) - set(applicable) if result else set()
        if ignored_applicable:
            logger.info("  %s: ignored unknown categories %s", requirement.requirement_id, sorted(ignored_applicable))
        if ignored_covered:
            logger.info(
                "  %s: model claimed coverage for non-applicable categories %s -- not counted",
                requirement.requirement_id,
                sorted(ignored_covered),
            )

        total_slots += len(applicable)
        covered_slots += len(covered)
        for category in applicable:
            category_totals[category]["total"] += 1
            if category in covered:
                category_totals[category]["covered"] += 1
            else:
                gaps.append(
                    Gap(
                        requirement_id=requirement.requirement_id,
                        requirement_text=requirement.requirement_text,
                        category=category,
                    )
                )

        if not applicable:
            logger.info("  %s: no applicable categories -- contributes 0 slots", requirement.requirement_id)
            continue
        if len(covered) == len(applicable):
            fully_covered += 1
            status = "FULLY covered"
        elif covered:
            partially_covered += 1
            status = "PARTIALLY covered"
        else:
            not_covered += 1
            status = "NOT covered"

        logger.info(
            "  %s: applicable=%s covered=%s -> %d/%d slots, %s%s (running total %d/%d)",
            requirement.requirement_id,
            applicable,
            sorted(covered),
            len(covered),
            len(applicable),
            status,
            "" if result else " [not assessed by model]",
            covered_slots,
            total_slots,
        )

        breakdown.append(
            {
                "requirement_id": requirement.requirement_id,
                "requirement_text": requirement.requirement_text,
                "applicable_categories": applicable,
                "covered_categories": sorted(covered),
                "matched_test_case_ids": result.matched_test_case_ids if result else [],
                "gap_reason": (result.gap_reason if result else "Not assessed."),
            }
        )

    percentage = round((covered_slots / total_slots) * 100, 1) if total_slots else 0.0

    for category, counts in category_totals.items():
        logger.info("  Category %-8s %d/%d covered", category, counts["covered"], counts["total"])
    logger.info(
        "Requirements: %d fully, %d partially, %d not covered",
        fully_covered,
        partially_covered,
        not_covered,
    )
    logger.info(
        "Coverage = %d covered slots / %d applicable slots x 100 = %.1f%%",
        covered_slots,
        total_slots,
        percentage,
    )
    logger.info("Gaps passed to recommendations: %d", len(gaps))
    for g in gaps:
        logger.info("  GAP %s [%s] %s", g.requirement_id, g.category, g.requirement_text)

    return CoverageResult(
        coverage_percentage=percentage,
        total_slots=total_slots,
        covered_slots=covered_slots,
        total_requirements=len(decomposition.requirements),
        fully_covered_requirements=fully_covered,
        partially_covered_requirements=partially_covered,
        not_covered_requirements=not_covered,
        requirement_breakdown=breakdown,
        category_breakdown=category_totals,
        gaps=gaps,
    )

# Recommend test cases for uncovered gaps.
# Inputs:
# - gaps: A list of Gap objects representing uncovered requirement/test-category combinations.
# Returns:
# - A markdown string containing recommendations for test cases covering the gaps.
def recommend_test_cases(gaps: list[Gap]) -> str:
    """One markdown table covering every gap, or a note that there are none."""
    _banner("LLM CALL 3/3: RECOMMEND TEST CASES")
    if not gaps:
        logger.info("No gaps -- skipping the LLM call.")
        return "No gaps were found -- every applicable test category is already covered."

    gaps_block = "\n".join(
        f"- {g.requirement_id} [{g.category}]: {g.requirement_text}" for g in gaps
    )
    logger.info("Input: %d gap(s), prompt %d chars", len(gaps), len(gaps_block))
    user_message = wrap_user_content(gaps_block)
    system_prompt = get_prompts()["recommend"]
    _log_prompt(system_prompt, user_message)

    started = time.perf_counter()
    text = complete_text(
        system_prompt=system_prompt,
        user_input=user_message,
        temperature=0.2,
        max_tokens=settings.AZURE_OPENAI_MAX_TOKENS,
    )
    text = text.strip()
    table_rows = [line for line in text.splitlines() if line.strip().startswith("|")]
    logger.info(
        "Output: %d chars, ~%d test case row(s) in %.1fs (expected %d, one per gap)",
        len(text),
        max(len(table_rows) - 2, 0),
        time.perf_counter() - started,
        len(gaps),
    )
    logger.info("Output preview:\n%s", _preview(text))
    return text

# Run the full coverage analysis pipeline.
# Inputs:
# - requirements_text: The raw text containing the requirements to be analyzed.
# - existing_rows: A list of dictionaries representing existing test cases.
# Returns:
# - A tuple containing:
#   - A CoverageResult object with overall coverage statistics and breakdown.
#   - A markdown string with recommendations for test cases covering any gaps.
def analyze(requirements_text: str, existing_rows: list[dict[str, str]]) -> tuple[CoverageResult, str]:
    """Run the full pipeline. Raises AzureLLMError on an unusable model reply."""
    decomposition = decompose_requirements(requirements_text)
    mapping = map_coverage(decomposition, existing_rows)
    result = compute_coverage(decomposition, mapping)
    recommendations_markdown = recommend_test_cases(result.gaps)
    return result, recommendations_markdown
