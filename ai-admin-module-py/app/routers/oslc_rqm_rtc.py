from __future__ import annotations

from datetime import date
import re
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
import requests

from ..config import settings
from ..services.oslc_rqm_rtc import (
    OslcError,
    create_module_with_existing_login,
    estimate_rqm_api_calls,
)
from ..utils.security import get_current_user_strict


router = APIRouter(tags=["OSLC RQM/RTC"])


class OslcConnectionRequest(BaseModel):
    qm_base_url: str = Field(..., description="QM base URL, e.g. https://host:9443/qm")
    jts_base_url: str = Field(..., description="JTS base URL, e.g. https://host:9443/jts")
    verify_ssl: bool = Field(default=True)
    ca_bundle_path: Optional[str] = Field(default=None, description="Optional CA bundle PEM path for corporate/self-signed cert chains")
    username: Optional[str] = Field(default=None, description="Optional override username")
    password: Optional[str] = Field(default=None, description="Optional override password")


class TestCaseByIdRequest(OslcConnectionRequest):
    test_case_id: str


class OwnerInPlanRequest(OslcConnectionRequest):
    owner_name: str
    test_plan_identifier: str


class ExecutedOnDateRequest(OslcConnectionRequest):
    execution_date: date


class FailedInPlanRequest(OslcConnectionRequest):
    test_plan_identifier: str


class EstimateCallsRequest(BaseModel):
    test_case_count: int = 0
    test_plan_count: int = 0
    test_result_count: int = 0
    page_size: int = 200


class ChatQueryRequest(OslcConnectionRequest):
    prompt: str = Field(..., description="Natural language query for RQM/RTC")
    format: str = Field(default="text", description="Output format: text | markdown | json")
    max_items: int = Field(default=25, ge=1, le=200, description="Maximum items to include in formatted list output")


def _resolve_credentials(payload: OslcConnectionRequest, current_user: dict) -> tuple[str, str]:
    username = payload.username or current_user.get("username")
    password = payload.password or current_user.get("password")

    if not username:
        raise HTTPException(status_code=400, detail="Username not available from current login or request body")
    if not password:
        raise HTTPException(
            status_code=400,
            detail=(
                "Password not available from current login context. "
                "Please pass password in the request body for OSLC authentication."
            ),
        )

    return username, password


def _create_initialized_module(payload: OslcConnectionRequest, current_user: dict):
    username, password = _resolve_credentials(payload, current_user)
    effective_ca_bundle = payload.ca_bundle_path or settings.OSLC_CA_BUNDLE_PATH

    module = create_module_with_existing_login(
        qm_base_url=payload.qm_base_url,
        jts_base_url=payload.jts_base_url,
        username=username,
        password=password,
        verify_ssl=payload.verify_ssl,
        ca_bundle_path=effective_ca_bundle,
    )
    module.initialize()
    return module


def _extract_chat_intent(prompt: str) -> tuple[str, dict]:
    text = (prompt or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Prompt is required")

    lowered = text.lower()

    m = re.search(r"test\s*case\s+(\d+)", lowered)
    if m:
        return "test-case", {"test_case_id": m.group(1)}

    m = re.search(
        r"owned\s+by\s+(.+?)\s+in\s+test\s*plan\s+([a-z0-9_-]+)",
        text,
        flags=re.IGNORECASE,
    )
    if m:
        return "owner-in-plan", {
            "owner_name": m.group(1).strip(),
            "test_plan_identifier": m.group(2).strip(),
        }

    if "executed today" in lowered or "executed on today" in lowered:
        return "executed-on", {"execution_date": date.today()}

    m = re.search(
        r"failed\s+test\s*cases?.*?(?:in\s+(?:the\s+)?)?test\s*plan\s+([a-z0-9_-]+)",
        text,
        flags=re.IGNORECASE,
    )
    if m:
        return "failed-in-plan", {"test_plan_identifier": m.group(1).strip()}

    raise HTTPException(
        status_code=400,
        detail=(
            "Unsupported prompt format. Supported examples: "
            "'Give me test case 12345', "
            "'show me all test cases owned by John in test plan 2026MAR12', "
            "'list all test cases executed today', "
            "'show me only failed test cases in the test plan 2026MAR15'."
        ),
    )


def _format_record_text(record: Dict[str, Any]) -> str:
    identifier = record.get("identifier") or "N/A"
    title = record.get("title") or "Untitled"
    owner = record.get("owner") or "Unknown"
    status = record.get("status") or "Unknown"
    executed_on = record.get("executed_on") or "N/A"

    return (
        f"ID: {identifier} | Title: {title} | Owner: {owner} | "
        f"Status: {status} | Executed: {executed_on}"
    )


def _format_record_markdown(record: Dict[str, Any]) -> str:
    identifier = record.get("identifier") or "N/A"
    title = record.get("title") or "Untitled"
    owner = record.get("owner") or "Unknown"
    status = record.get("status") or "Unknown"
    executed_on = record.get("executed_on") or "N/A"
    return (
        f"- **ID:** {identifier} | **Title:** {title} | **Owner:** {owner} | "
        f"**Status:** {status} | **Executed:** {executed_on}"
    )


def _format_chat_response(intent: str, result: Any, params: Dict[str, Any], output_format: str, max_items: int) -> Any:
    output_format = (output_format or "text").lower().strip()

    if output_format == "json":
        return {
            "intent": intent,
            "params": params,
            "count": len(result) if isinstance(result, list) else (1 if result else 0),
            "items": result if isinstance(result, list) else ([result] if result else []),
        }

    record_formatter = _format_record_markdown if output_format == "markdown" else _format_record_text

    if intent == "test-case":
        if not result:
            return f"No test case found for ID {params.get('test_case_id')}"
        if output_format == "markdown":
            return f"### Test case details\n{record_formatter(result)}"
        return f"Test case details:\n{record_formatter(result)}"

    if intent == "owner-in-plan":
        owner = params.get("owner_name")
        plan = params.get("test_plan_identifier")
        if not result:
            return f"No test cases found for owner {owner} in plan {plan}."
        lines = [f"Found {len(result)} test case(s) for owner {owner} in plan {plan}:"]
        lines.extend([record_formatter(item) for item in result[:max_items]])
        if len(result) > max_items:
            lines.append(f"- ...and {len(result) - max_items} more")
        return "\n".join(lines)

    if intent == "executed-on":
        execution_date = params.get("execution_date")
        if not result:
            return f"No executed test cases found on {execution_date}."
        lines = [f"Found {len(result)} executed test case result(s) on {execution_date}:"]
        lines.extend([record_formatter(item) for item in result[:max_items]])
        if len(result) > max_items:
            lines.append(f"- ...and {len(result) - max_items} more")
        return "\n".join(lines)

    if intent == "failed-in-plan":
        plan = params.get("test_plan_identifier")
        if not result:
            return f"No failed test cases found in plan {plan}."
        lines = [f"Found {len(result)} failed test case result(s) in plan {plan}:"]
        lines.extend([record_formatter(item) for item in result[:max_items]])
        if len(result) > max_items:
            lines.append(f"- ...and {len(result) - max_items} more")
        return "\n".join(lines)

    return "Query processed successfully."


@router.post("/discover")
def discover_capabilities(
    payload: OslcConnectionRequest,
    current_user: dict = Depends(get_current_user_strict),
):
    try:
        module = _create_initialized_module(payload, current_user)
        endpoints = module.client.query_endpoints
        unresolved = not any([
            endpoints.test_case_query,
            endpoints.test_plan_query,
            endpoints.test_result_query,
        ])

        response = {
            "status": "ok",
            "query_endpoints": {
                "test_case_query": endpoints.test_case_query,
                "test_plan_query": endpoints.test_plan_query,
                "test_result_query": endpoints.test_result_query,
            },
            "discovery_candidates": module.client.discovery_candidates,
        }

        if unresolved:
            response["note"] = (
                "No standard test case/plan/result query capabilities were auto-resolved. "
                "Review discovery_candidates to identify environment-specific OSLC query bases."
            )

        return response
    except OslcError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except requests.exceptions.SSLError as exc:
        raise HTTPException(
            status_code=502,
            detail=(
                "SSL certificate validation failed while calling Jazz OSLC endpoints. "
                "Use verify_ssl=false for testing, or provide ca_bundle_path with your corporate CA PEM. "
                f"Underlying error: {exc}"
            ),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Discovery failed: {exc}")


@router.post("/test-case")
def get_test_case_by_id(
    payload: TestCaseByIdRequest,
    current_user: dict = Depends(get_current_user_strict),
):
    try:
        module = _create_initialized_module(payload, current_user)
        result = module.get_test_case(payload.test_case_id)
        return {"status": "ok", "result": result}
    except OslcError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except requests.exceptions.SSLError as exc:
        raise HTTPException(
            status_code=502,
            detail=(
                "SSL certificate validation failed while calling Jazz OSLC endpoints. "
                "Use verify_ssl=false for testing, or provide ca_bundle_path with your corporate CA PEM. "
                f"Underlying error: {exc}"
            ),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Test case lookup failed: {exc}")


@router.post("/owner-in-plan")
def list_owner_in_plan(
    payload: OwnerInPlanRequest,
    current_user: dict = Depends(get_current_user_strict),
):
    try:
        module = _create_initialized_module(payload, current_user)
        result = module.list_test_cases_owned_by_user_in_plan(
            owner_name=payload.owner_name,
            test_plan_identifier=payload.test_plan_identifier,
        )
        return {"status": "ok", "count": len(result), "result": result}
    except OslcError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except requests.exceptions.SSLError as exc:
        raise HTTPException(
            status_code=502,
            detail=(
                "SSL certificate validation failed while calling Jazz OSLC endpoints. "
                "Use verify_ssl=false for testing, or provide ca_bundle_path with your corporate CA PEM. "
                f"Underlying error: {exc}"
            ),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Owner-in-plan query failed: {exc}")


@router.post("/executed-on")
def list_executed_on_date(
    payload: ExecutedOnDateRequest,
    current_user: dict = Depends(get_current_user_strict),
):
    try:
        module = _create_initialized_module(payload, current_user)
        result = module.list_test_cases_executed_on(payload.execution_date)
        return {"status": "ok", "count": len(result), "result": result}
    except OslcError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except requests.exceptions.SSLError as exc:
        raise HTTPException(
            status_code=502,
            detail=(
                "SSL certificate validation failed while calling Jazz OSLC endpoints. "
                "Use verify_ssl=false for testing, or provide ca_bundle_path with your corporate CA PEM. "
                f"Underlying error: {exc}"
            ),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Executed-on query failed: {exc}")


@router.post("/failed-in-plan")
def list_failed_in_plan(
    payload: FailedInPlanRequest,
    current_user: dict = Depends(get_current_user_strict),
):
    try:
        module = _create_initialized_module(payload, current_user)
        result = module.list_failed_test_cases_in_plan(payload.test_plan_identifier)
        return {"status": "ok", "count": len(result), "result": result}
    except OslcError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except requests.exceptions.SSLError as exc:
        raise HTTPException(
            status_code=502,
            detail=(
                "SSL certificate validation failed while calling Jazz OSLC endpoints. "
                "Use verify_ssl=false for testing, or provide ca_bundle_path with your corporate CA PEM. "
                f"Underlying error: {exc}"
            ),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed-in-plan query failed: {exc}")


@router.post("/estimate-calls")
def estimate_calls(
    payload: EstimateCallsRequest,
    current_user: dict = Depends(get_current_user_strict),
):
    if payload.test_case_count < 0 or payload.test_plan_count < 0 or payload.test_result_count < 0:
        raise HTTPException(status_code=400, detail="Counts must be non-negative")
    if payload.page_size <= 0:
        raise HTTPException(status_code=400, detail="page_size must be greater than zero")

    estimate = estimate_rqm_api_calls(
        test_case_count=payload.test_case_count,
        test_plan_count=payload.test_plan_count,
        test_result_count=payload.test_result_count,
        page_size=payload.page_size,
    )
    return {"status": "ok", "estimate": estimate}


@router.post("/chat-query")
def chat_query(
    payload: ChatQueryRequest,
    current_user: dict = Depends(get_current_user_strict),
):
    try:
        intent, params = _extract_chat_intent(payload.prompt)
        requested_format = payload.format.lower().strip()
        if requested_format not in {"text", "markdown", "json"}:
            raise HTTPException(status_code=400, detail="Invalid format. Use one of: text, markdown, json")

        module = _create_initialized_module(payload, current_user)
        result: Any = None

        if intent == "test-case":
            result = module.get_test_case(params["test_case_id"])
        elif intent == "owner-in-plan":
            result = module.list_test_cases_owned_by_user_in_plan(
                owner_name=params["owner_name"],
                test_plan_identifier=params["test_plan_identifier"],
            )
        elif intent == "executed-on":
            result = module.list_test_cases_executed_on(params["execution_date"])
        elif intent == "failed-in-plan":
            result = module.list_failed_test_cases_in_plan(params["test_plan_identifier"])
        else:
            raise HTTPException(status_code=400, detail="Unsupported intent")

        count = len(result) if isinstance(result, list) else (1 if result else 0)
        formatted_response = _format_chat_response(
            intent=intent,
            result=result,
            params=params,
            output_format=requested_format,
            max_items=payload.max_items,
        )

        return {
            "status": "ok",
            "intent": intent,
            "format": requested_format,
            "count": count,
            "result": result,
            "formatted_response": formatted_response,
        }

    except OslcError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except requests.exceptions.SSLError as exc:
        raise HTTPException(
            status_code=502,
            detail=(
                "SSL certificate validation failed while calling Jazz OSLC endpoints. "
                "Use verify_ssl=false for testing, or provide ca_bundle_path with your corporate CA PEM. "
                f"Underlying error: {exc}"
            ),
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Chat query failed: {exc}")
