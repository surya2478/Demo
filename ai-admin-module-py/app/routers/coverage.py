"""
--- Coverage Analysis API -----------------------------------------------------

One endpoint: upload requirement documents (SDD/BRD/Figma export/etc.) plus an
existing test case sheet, get back a coverage percentage, per-requirement
breakdown, and a markdown table of the test cases needed to close the gaps.

Runs entirely on this backend -- unlike the /generate/* endpoints, there is no
external-AI-service indirection to preserve here, since this capability never
existed on the previous service. The frontend calls this path directly against
VITE_API_URL, the same way it calls /test-case-reviews/submit.
"""
from __future__ import annotations

import json
import logging
from dataclasses import asdict
from typing import Iterator

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..services.automation import extraction
from ..services.generation.azure_llm import AzureLLMError
from ..services.generation import coverage
from ..utils.security import get_current_user_strict

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_REQUIREMENT_FILES = 10

_STREAM_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
}


class CoveragePromptsPayload(BaseModel):
    decompose: str = Field(min_length=20, max_length=20000)
    map: str = Field(min_length=20, max_length=20000)
    recommend: str = Field(min_length=20, max_length=20000)


def _ensure_admin(current_user) -> None:
    roles = current_user.get("roles", []) if isinstance(current_user, dict) else []
    if isinstance(roles, str):
        roles = [roles]
    if "admin" not in [str(r).lower() for r in roles]:
        raise HTTPException(status_code=403, detail="Admin access is required to change the coverage prompts.")


@router.get("/prompts")
def get_coverage_prompts(current_user=Depends(get_current_user_strict)):
    """The system prompts used by the three coverage-analysis LLM calls, plus their built-in defaults."""
    return {"prompts": coverage.get_prompts(), "defaults": coverage.DEFAULT_PROMPTS}


@router.put("/prompts")
def update_coverage_prompts(
    payload: CoveragePromptsPayload,
    current_user=Depends(get_current_user_strict),
):
    """Replace the coverage-analysis system prompts. Takes effect on the next analysis."""
    # Shared by every user's analysis, so writes are admin-only like the AI config.
    _ensure_admin(current_user)
    prompts = coverage.save_prompts(payload.model_dump())
    logger.info("Coverage prompts updated by %s", _username(current_user))
    return {"prompts": prompts, "defaults": coverage.DEFAULT_PROMPTS}


def _username(current_user) -> str:
    return (
        current_user.get("username")
        if isinstance(current_user, dict)
        else getattr(current_user, "username", "unknown")
    )


async def _load_inputs(
    requirement_files: list[UploadFile], testcase_file: UploadFile
) -> tuple[list[dict], str, list[dict[str, str]]]:
    """Validate and extract both uploads. Raises HTTPException on bad input."""
    if not requirement_files:
        raise HTTPException(status_code=400, detail="No requirement documents were uploaded.")
    if len(requirement_files) > MAX_REQUIREMENT_FILES:
        raise HTTPException(
            status_code=400,
            detail=f"Up to {MAX_REQUIREMENT_FILES} requirement documents are supported per request.",
        )

    # Requirement documents: concatenate extracted text, one section per file.
    sources: list[dict] = []
    requirement_sections: list[str] = []
    for upload in requirement_files:
        contents = await upload.read()
        if not contents:
            continue
        file_type = extraction.type_for_filename(upload.filename)
        if file_type is None:
            raise HTTPException(
                status_code=400,
                detail=f"{upload.filename!r} is not a supported format. Supported: "
                + ", ".join(extraction.SUPPORTED_TYPES),
            )
        try:
            extraction.validate_signature(file_type, contents[:16])
            text, _pages = await run_in_threadpool(extraction.extract_text, contents, file_type)
        except extraction.ExtractionError as exc:
            raise HTTPException(status_code=422, detail=f"{upload.filename}: {exc}") from exc
        sources.append({"filename": upload.filename, "characters": len(text)})
        if text.strip():
            requirement_sections.append(f"## Source: {upload.filename}\n{text}")

    if not requirement_sections:
        raise HTTPException(
            status_code=422,
            detail="No readable text was found in the requirement document(s).",
        )
    requirements_text = "\n\n".join(requirement_sections)

    # Existing test cases: prefer a structured table read, fall back to text.
    tc_contents = await testcase_file.read()
    if not tc_contents:
        raise HTTPException(status_code=400, detail="The test case file is empty.")
    tc_type = extraction.type_for_filename(testcase_file.filename)
    if tc_type is None:
        raise HTTPException(
            status_code=400,
            detail=f"{testcase_file.filename!r} is not a supported format. Supported: "
            + ", ".join(extraction.SUPPORTED_TYPES),
        )
    try:
        extraction.validate_signature(tc_type, tc_contents[:16])
        existing_rows = await run_in_threadpool(extraction.extract_rows, tc_contents, tc_type)
    except extraction.ExtractionError as exc:
        raise HTTPException(status_code=422, detail=f"{testcase_file.filename}: {exc}") from exc

    return sources, requirements_text, existing_rows


def _summary(result: coverage.CoverageResult, existing_count: int) -> dict:
    return {
        "coverage_percentage": result.coverage_percentage,
        "total_slots": result.total_slots,
        "covered_slots": result.covered_slots,
        "total_requirements": result.total_requirements,
        "fully_covered_requirements": result.fully_covered_requirements,
        "partially_covered_requirements": result.partially_covered_requirements,
        "not_covered_requirements": result.not_covered_requirements,
        "requirement_breakdown": result.requirement_breakdown,
        "category_breakdown": result.category_breakdown,
        "existing_test_case_count": existing_count,
    }


@router.post("/analyze")
async def analyze_coverage(
    requirement_files: list[UploadFile] = File(...),
    testcase_file: UploadFile = File(...),
    current_user=Depends(get_current_user_strict),
):
    """Analyze how well an existing test case sheet covers a set of requirements."""
    _sources, requirements_text, existing_rows = await _load_inputs(requirement_files, testcase_file)
    logger.info(
        "Coverage analysis requested by %s: %d requirement doc(s), %d existing test case row(s)",
        _username(current_user),
        len(requirement_files),
        len(existing_rows),
    )

    try:
        # Off the event loop: minutes of model calls would otherwise stall every other request.
        result, recommendations_markdown = await run_in_threadpool(coverage.analyze, requirements_text, existing_rows)
    except AzureLLMError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {
        **_summary(result, len(existing_rows)),
        "recommended_test_cases_markdown": recommendations_markdown,
    }


def _event(**payload) -> str:
    return json.dumps(payload, ensure_ascii=False) + "\n"


def _stream_analysis(
    sources: list[dict], requirements_text: str, existing_rows: list[dict[str, str]]
) -> Iterator[str]:
    """Run the pipeline one stage at a time, yielding an NDJSON event per transition."""
    stage = "extract"
    try:
        yield _event(
            type="stage",
            stage=stage,
            status="completed",
            data={
                "requirement_documents": sources,
                "requirements_characters": len(requirements_text),
                "analyzed_characters": min(len(requirements_text), coverage.MAX_REQUIREMENTS_TEXT_CHARS),
                "requirements_truncated": len(requirements_text) > coverage.MAX_REQUIREMENTS_TEXT_CHARS,
                "existing_test_case_count": len(existing_rows),
                "test_cases_sent_for_mapping": min(len(existing_rows), coverage.MAX_TEST_CASE_ROWS),
                "test_case_columns": list(existing_rows[0].keys()) if existing_rows else [],
            },
        )

        stage = "decompose"
        yield _event(type="stage", stage=stage, status="running")
        decomposition = coverage.decompose_requirements(requirements_text)
        yield _event(type="stage", stage=stage, status="completed", data=decomposition.model_dump())

        stage = "map"
        yield _event(type="stage", stage=stage, status="running")
        mapping = coverage.map_coverage(decomposition, existing_rows)
        yield _event(type="stage", stage=stage, status="completed", data=mapping.model_dump())

        stage = "compute"
        yield _event(type="stage", stage=stage, status="running")
        result = coverage.compute_coverage(decomposition, mapping)
        summary = _summary(result, len(existing_rows))
        yield _event(
            type="stage",
            stage=stage,
            status="completed",
            data={**summary, "gaps": [asdict(g) for g in result.gaps]},
        )

        stage = "recommend"
        yield _event(type="stage", stage=stage, status="running")
        markdown = coverage.recommend_test_cases(result.gaps)
        yield _event(
            type="stage",
            stage=stage,
            status="completed",
            data={"recommended_test_cases_markdown": markdown},
        )

        yield _event(type="result", data={**summary, "recommended_test_cases_markdown": markdown})
    except AzureLLMError as exc:
        yield _event(type="error", stage=stage, detail=str(exc))
    except Exception:
        logger.exception("Coverage analysis failed during stage %s", stage)
        yield _event(type="error", stage=stage, detail="Unexpected error during coverage analysis.")


@router.post("/analyze-stream")
async def analyze_coverage_stream(
    requirement_files: list[UploadFile] = File(...),
    testcase_file: UploadFile = File(...),
    current_user=Depends(get_current_user_strict),
):
    """Same analysis as /analyze, streamed as NDJSON stage events for a progress UI."""
    # Uploads are read here, before streaming, since they are closed once the handler returns.
    sources, requirements_text, existing_rows = await _load_inputs(requirement_files, testcase_file)
    logger.info(
        "Streamed coverage analysis requested by %s: %d requirement doc(s), %d existing test case row(s)",
        _username(current_user),
        len(requirement_files),
        len(existing_rows),
    )
    return StreamingResponse(
        _stream_analysis(sources, requirements_text, existing_rows),
        media_type="application/x-ndjson",
        headers=_STREAM_HEADERS,
    )
