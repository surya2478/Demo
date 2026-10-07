"""
--- Azure OpenAI client ---------------------------------------------------------

The single LLM client for Coverage Analysis, Squad Knowledge Base generation
and Figma PDF extraction, configured only by the AZURE_OPENAI_* settings.

Talks to the Azure OpenAI v1 API (https://<resource>.openai.azure.com/openai/v1),
which takes the deployment name as `model` and needs no api-version. Chat calls
use /chat/completions; PDF extraction uses /responses, which accepts files.

Deliberately independent of services/automation/llm.py (Automation Studio) and
services/generation/stream.py (Test Assistant via OpenRouter).
"""
from __future__ import annotations

import base64
import json
import logging
import re
from typing import Any, Iterator, TypeVar

import requests
from pydantic import BaseModel, ValidationError

from ...config import settings
from .stream import token_marker

logger = logging.getLogger(__name__)

TModel = TypeVar("TModel", bound=BaseModel)

_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL)


class AzureLLMError(Exception):
    """Base for anything that stopped a call producing a usable answer."""


class AzureLLMUnavailable(AzureLLMError):
    """Not configured, unreachable, or rejected the request."""


class AzureLLMInvalidResponse(AzureLLMError):
    """The model answered, but not in the shape the caller needs."""


def wrap_user_content(text: str) -> str:
    """Fence untrusted text so the system prompt can treat it as data, not instructions."""
    return f"<user_content>\n{text}\n</user_content>"


def model_name() -> str:
    return (settings.AZURE_OPENAI_MODEL or "").strip()


def missing_settings() -> list[str]:
    return [
        name
        for name, value in (
            ("AZURE_OPENAI_BASE_URL", settings.AZURE_OPENAI_BASE_URL),
            ("AZURE_OPENAI_API_KEY", settings.AZURE_OPENAI_API_KEY),
            ("AZURE_OPENAI_MODEL", settings.AZURE_OPENAI_MODEL),
        )
        if not (value or "").strip()
    ]


def _url(path: str) -> str:
    base = settings.AZURE_OPENAI_BASE_URL.strip().rstrip("/")
    # Tolerate a full endpoint URL copied from the Azure portal.
    for suffix in ("/chat/completions", "/responses"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
    return f"{base}/{path}"


def endpoint(path: str = "chat/completions") -> str:
    """The Azure OpenAI URL a call goes to, for logs ("" when not configured)."""
    return _url(path) if (settings.AZURE_OPENAI_BASE_URL or "").strip() else ""


def _post(path: str, body: dict, *, stream: bool = False) -> requests.Response:
    missing = missing_settings()
    if missing:
        raise AzureLLMUnavailable(
            "Azure OpenAI is not configured. Missing: " + ", ".join(missing) + ". Set them in the backend's .env."
        )

    url = _url(path)
    headers = {"api-key": settings.AZURE_OPENAI_API_KEY.strip(), "Content-Type": "application/json"}
    timeout = float(settings.AZURE_OPENAI_TIMEOUT_SECONDS or 300)

    for attempt in (1, 2):
        try:
            response = requests.post(url, headers=headers, json=body, timeout=timeout, stream=stream)
        except requests.Timeout as exc:
            raise AzureLLMUnavailable(f"Azure OpenAI did not respond within {timeout:.0f}s.") from exc
        except requests.RequestException as exc:
            raise AzureLLMUnavailable(f"Azure OpenAI could not be reached at {url}: {exc}") from exc

        if response.status_code < 400:
            return response

        detail = (response.text or "")[:500]
        response.close()
        # Reasoning models reject any non-default temperature; retry once without it.
        if attempt == 1 and response.status_code == 400 and "temperature" in body and "temperature" in detail.lower():
            logger.info("Model %s rejected 'temperature'; retrying without it", body.get("model"))
            body = {k: v for k, v in body.items() if k != "temperature"}
            continue
        raise AzureLLMUnavailable(f"Azure OpenAI returned {response.status_code} for {url}. {detail}")

    raise AzureLLMUnavailable("Azure OpenAI request failed.")


def _chat_body(
    system_prompt: str, user_input: str, max_tokens: int | None, temperature: float | None
) -> dict[str, Any]:
    """None leaves a limit to the deployment: Device Squad generation sends
    neither, so a long test table is not cut at a token cap."""
    body: dict[str, Any] = {
        "model": model_name(),
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_input},
        ],
    }
    if max_tokens:
        body["max_completion_tokens"] = max_tokens
    if temperature is not None:
        body["temperature"] = temperature
    return body


def _chat(body: dict) -> str:
    response = _post("chat/completions", body)
    try:
        choice = response.json()["choices"][0]
        content = choice["message"].get("content") or ""
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise AzureLLMInvalidResponse(f"Azure OpenAI's reply had an unexpected shape: {exc}") from exc

    if choice.get("finish_reason") == "length":
        logger.warning("Azure OpenAI reply hit max_completion_tokens=%s", body.get("max_completion_tokens"))
        if not content.strip():
            raise AzureLLMInvalidResponse(
                "The model used its whole token budget without producing an answer. "
                "Reduce the input size or raise max tokens for this call."
            )
    return content


def extract_json(text: str) -> Any:
    """Parse a JSON reply, tolerating a markdown fence or a line of prose around it."""
    if not text or not text.strip():
        raise AzureLLMInvalidResponse("The model returned an empty response.")

    candidates = [text.strip()]
    fenced = _FENCE.match(text.strip())
    if fenced:
        candidates.append(fenced.group(1).strip())
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        candidates.append(text[start : end + 1])

    for candidate in candidates:
        try:
            return json.loads(candidate)
        except ValueError:
            continue
    preview = text.strip()[:200].replace("\n", " ")
    raise AzureLLMInvalidResponse(f"The model did not return JSON. It began: {preview!r}")


def complete_json(
    *,
    system_prompt: str,
    user_input: str,
    model_cls: type[TModel],
    max_tokens: int = 16000,
    temperature: float | None = 0.1,
    attempts: int = 2,
) -> TModel:
    """Ask for a JSON object and return it validated against `model_cls`.

    A reply that fails parsing or validation is retried once, with the error
    handed back to the model. Transport failures are not retried.
    """
    last_error: Exception | None = None
    prompt = user_input
    for attempt in range(1, max(1, attempts) + 1):
        body = _chat_body(system_prompt, prompt, max_tokens, temperature)
        body["response_format"] = {"type": "json_object"}
        raw = _chat(body)
        try:
            return model_cls.model_validate(extract_json(raw))
        except (AzureLLMInvalidResponse, ValidationError) as exc:
            last_error = exc
            logger.warning("Azure OpenAI reply failed validation on attempt %d/%d: %s", attempt, attempts, exc)
            prompt = (
                f"{user_input}\n\nYour previous reply could not be used: {exc}\n"
                "Return ONLY valid JSON matching the requested schema."
            )
    raise AzureLLMInvalidResponse(f"The model did not return usable JSON after {attempts} attempt(s). {last_error}")


def complete_text(
    *,
    system_prompt: str,
    user_input: str,
    max_tokens: int = 16000,
    temperature: float | None = 0.1,
) -> str:
    """Ask for free-form text, e.g. a markdown table."""
    return _chat(_chat_body(system_prompt, user_input, max_tokens, temperature))


def stream_chat(
    *,
    system_prompt: str,
    user_input: str,
    max_tokens: int | None = 16000,
    temperature: float | None = None,
) -> Iterator[str]:
    """Stream a chat completion as plain text chunks, ending with the token-usage marker.

    Configuration and transport errors raise before the first chunk, so callers
    can still turn them into an HTTP error status.
    """
    body = _chat_body(system_prompt, user_input, max_tokens, temperature)
    body["stream"] = True
    body["stream_options"] = {"include_usage": True}
    response = _post("chat/completions", body, stream=True)

    usage: dict | None = None
    produced = False
    with response:
        for line in response.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data:"):
                continue
            payload = line[len("data:"):].strip()
            if payload == "[DONE]":
                break
            try:
                frame = json.loads(payload)
            except ValueError:
                continue

            error = frame.get("error")
            if error:
                message = (error.get("message") if isinstance(error, dict) else str(error)) or "unspecified error"
                logger.error("Azure OpenAI reported an error mid-stream: %s", message)
                yield f"\n\n> **Generation stopped:** {message}\n"
                break

            if frame.get("usage"):
                usage = frame["usage"]
            for choice in frame.get("choices") or []:
                delta = (choice.get("delta") or {}).get("content")
                if delta:
                    produced = True
                    yield delta

    if not produced:
        yield (
            "\n> **No content was returned.** The model accepted the request but "
            "produced an empty reply. Try again, or reduce the size of the input.\n"
        )
    if usage:
        yield token_marker(
            int(usage.get("prompt_tokens") or 0),
            int(usage.get("completion_tokens") or 0),
            int(usage.get("total_tokens") or 0),
        )


def extract_pdf_text(*, filename: str, pdf_bytes: bytes, prompt: str) -> str:
    """Extract text from a PDF with the model's vision input via the Responses API."""
    file_data = f"data:application/pdf;base64,{base64.b64encode(pdf_bytes).decode('ascii')}"
    body = {
        "model": model_name(),
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_file", "filename": filename, "file_data": file_data},
                {"type": "input_text", "text": prompt},
            ],
        }],
    }
    response = _post("responses", body)
    try:
        result = response.json()
    except ValueError as exc:
        raise AzureLLMInvalidResponse(f"Azure OpenAI's reply was not JSON: {exc}") from exc

    text = result.get("output_text") or "\n".join(
        content.get("text", "")
        for item in result.get("output") or []
        for content in item.get("content") or []
        if content.get("type") in {"output_text", "text"}
    )
    if not text.strip():
        raise AzureLLMInvalidResponse("Azure OpenAI returned no extractable text from the PDF.")
    return text.strip()
