"""
--- Test Coverage Analysis: LLM response schemas -----------------------------

Two schemas, one per LLM call in services/generation/coverage.py. Both are
validated by services.automation.llm.complete_json, which is also what forces
the model onto JSON at all -- see that module for the retry-on-schema-failure
behaviour.

Coverage percentage is deliberately NOT one of these fields. Asking a model to
also compute the percentage means trusting its arithmetic over a list it just
produced itself; the percentage is instead computed by
services/generation/coverage.py from the requirement/category counts here,
which is the whole reason decomposition and mapping are two calls instead of
one "tell me the coverage %" prompt.
"""
from __future__ import annotations

from pydantic import BaseModel, Field

# The four lenses every requirement is assessed against. Fixed and small on
# purpose: a model asked to invent its own test-type taxonomy invents a
# different one per call, which makes the category breakdown incomparable
# between two runs of the same document.
TEST_CATEGORIES = ("positive", "negative", "edge", "ui")


class DecomposedRequirement(BaseModel):
    """One atomic, independently testable requirement pulled out of the input."""

    requirement_id: str = Field(description="Stable short id, e.g. REQ-1, REQ-2.")
    requirement_text: str = Field(description="One sentence: what the system must do.")
    applicable_categories: list[str] = Field(
        default_factory=list,
        description=(
            "Which of positive, negative, edge, ui genuinely apply to this "
            "requirement. Not every requirement has all four -- a pure backend "
            "batch job has no 'ui' angle, and a read-only report may have no "
            "meaningful 'negative' path."
        ),
    )


class RequirementDecomposition(BaseModel):
    requirements: list[DecomposedRequirement] = Field(default_factory=list)


class RequirementCoverage(BaseModel):
    """Whether one requirement's applicable categories are already tested."""

    requirement_id: str
    covered_categories: list[str] = Field(default_factory=list)
    matched_test_case_ids: list[str] = Field(
        default_factory=list,
        description="IDs from the uploaded test case sheet that cover this requirement.",
    )
    gap_reason: str = Field(
        default="",
        description="Why any uncovered category is uncovered. Empty when fully covered.",
    )


class CoverageMapping(BaseModel):
    coverage: list[RequirementCoverage] = Field(default_factory=list)
