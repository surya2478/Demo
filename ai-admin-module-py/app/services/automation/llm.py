"""
--- Automation Module: LLM transport ----------------------------------------

One narrow job: send a system prompt plus user content, get back JSON that
validates against a pydantic model, or raise something the caller can explain.

Two transports sit behind the same call because the deployment has not decided
which it wants:

  ai_service  the existing AI service at ai_config.BASE_URL. It owns the model
              and its credentials; this backend holds no key. Its chat endpoint
              is the only one that accepts a system_prompt, which is why that
              endpoint and not a /generate/* one.
  openrouter  this backend calls OpenRouter directly with OPENROUTER_API_KEY.

Everything specific to a transport is isolated in its _call_* function. The
retry, the JSON extraction and the validation are shared, because those failure
modes are the model's, not the transport's.

Nothing here knows what a test case is. Refinement lives in refine.py.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, TypeVar

import requests
from pydantic import BaseModel, ValidationError

from ...config import settings

logger = logging.getLogger(__name__)

TModel = TypeVar("TModel", bound=BaseModel)


class LLMError(Exception):
    """Base for anything that stopped this call producing a usable answer."""


class LLMUnavailable(LLMError):
    """Configuration or transport problem — the model was never reached.

    Distinct from LLMInvalidResponse on purpose: this one is the operator's to
    fix, and retrying it changes nothing.
    """


class LLMInvalidResponse(LLMError):
    """The model answered, but not with JSON matching the requested schema."""


# A model told "no markdown fences" still emits them often enough that
# stripping is cheaper than a retry. Matches ```json ... ``` and bare ``` ... ```
_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL)


def wrap_user_content(text: str) -> str:
    """Fence untrusted text so the prompt can disown instructions inside it.

    Test case content is written by users and, for approved cases, produced by
    another model. Either can contain something shaped like an instruction. The
    system prompt tells the model that anything in here is data; this is the
    marker it keys on.
    """
    return f"<user_content>\n{text}\n</user_content>"


def extract_json(text: str) -> Any:
    """Pull the JSON value out of a model reply.

    Tries the whole string first, then a fenced block, then the outermost
    bracketed span. The last step exists because a model that adds one line of
    prose before valid JSON is common, and discarding an otherwise good answer
    over a greeting would waste the call.
    """
    if not text or not text.strip():
        raise LLMInvalidResponse("The model returned an empty response.")

    candidates = [text.strip()]

    fenced = _FENCE.match(text.strip())
    if fenced:
        candidates.append(fenced.group(1).strip())

    for opener, closer in (("[", "]"), ("{", "}")):
        start = text.find(opener)
        end = text.rfind(closer)
        if start != -1 and end > start:
            candidates.append(text[start : end + 1])

    for candidate in candidates:
        try:
            return json.loads(candidate)
        except (TypeError, ValueError):
            continue

    preview = text.strip()[:200].replace("\n", " ")
    raise LLMInvalidResponse(f"The model did not return JSON. It began: {preview!r}")


# ── Transports ───────────────────────────────────────────────────────────────

def _ai_service_url() -> str:
    base = (settings.ai_config.BASE_URL or "").rstrip("/")
    endpoint = settings.ai_config.ENDPOINTS.chatStream or "/chat/stream"
    if not base:
        raise LLMUnavailable(
            "The AI service base URL is not configured. Set it in the Settings "
            "screen, or switch LLM_PROVIDER to 'openrouter'."
        )
    return f"{base}{endpoint if endpoint.startswith('/') else '/' + endpoint}"


def _call_ai_service(
    *, system_prompt: str, user_input: str, timeout: float, max_tokens: int, temperature: float
) -> str:
    """Post to the AI service's chat endpoint and accumulate the reply.

    The endpoint streams raw text chunks rather than returning a JSON envelope,
    so the whole body is read and concatenated before anything tries to parse
    it. Reading it as `response.text` would work too, but streaming keeps
    memory flat on a long reply and matches how the frontend consumes it.

    WHICH MODEL ANSWERS is ai_config.PARAMETERS, the same configuration the
    Test Assistant tabs send and the Settings screen edits. This module used to
    send neither field, so the AI service fell back to whatever its own default
    was and the Studio had no say in it -- the Settings screen could name a
    model that the Automation module then quietly did not use.

    Note the split, which is deliberate. `provider` and `model_name` come from
    the shared configuration because they identify the model, and that is the
    thing the two modules must agree on. `temperature` and `max_tokens` come
    from the call site, because they are per-task: refinement and script
    generation ask for strict JSON against a pydantic schema and pass a low
    temperature and a large ceiling to get it. Clamping those to
    PARAMETERS.maxTokens (4096 in the shipped config) would truncate a long
    JSON reply mid-structure, and complete_json's docstring explains why a
    truncated reply is the one failure a retry cannot fix.

    Unlike the OpenRouter transport, honouring a browser-supplied model is not
    a spending question here: the AI service owns the model and its
    credentials, so this backend's key is not what pays for the call.
    """
    url = _ai_service_url()
    params = settings.ai_config.PARAMETERS
    payload = {
        "session_id": (None, ""),
        "user_input": (None, user_input),
        "system_prompt": (None, system_prompt),
        "provider": (None, str(params.provider or "")),
        "model_name": (None, str(params.model or "")),
        "temperature": (None, str(temperature)),
        "max_tokens": (None, str(max_tokens)),
    }

    try:
        with requests.post(url, files=payload, timeout=timeout, stream=True) as response:
            if response.status_code >= 400:
                body = (response.text or "")[:300]
                raise LLMUnavailable(
                    f"The AI service returned {response.status_code} for {url}. {body}"
                )
            chunks = [
                chunk for chunk in response.iter_content(chunk_size=8192, decode_unicode=True)
            ]
    except requests.Timeout as exc:
        raise LLMUnavailable(f"The AI service did not respond within {timeout:.0f}s.") from exc
    except requests.RequestException as exc:
        raise LLMUnavailable(f"The AI service could not be reached: {exc}") from exc

    return "".join(c if isinstance(c, str) else c.decode("utf-8", "replace") for c in chunks)


def _call_openrouter(
    *, system_prompt: str, user_input: str, timeout: float, max_tokens: int, temperature: float
) -> str:
    missing = settings.openrouter_missing_keys()
    if missing:
        raise LLMUnavailable(
            "OpenRouter is selected but not configured. Missing: "
            + ", ".join(missing)
            + ". Set them in the backend's .env."
        )

    headers = {
        "Authorization": f"Bearer {settings.OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
    }
    # Optional attribution. OpenRouter uses these to identify the calling app.
    if settings.OPENROUTER_SITE_URL:
        headers["HTTP-Referer"] = settings.OPENROUTER_SITE_URL
    if settings.OPENROUTER_APP_NAME:
        headers["X-Title"] = settings.OPENROUTER_APP_NAME

    body = {
        "model": settings.OPENROUTER_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_input},
        ],
        "max_tokens": max_tokens,
        "temperature": temperature,
    }

    url = settings.OPENROUTER_BASE_URL.rstrip("/") + "/chat/completions"
    try:
        response = requests.post(url, headers=headers, json=body, timeout=timeout)
    except requests.Timeout as exc:
        raise LLMUnavailable(f"OpenRouter did not respond within {timeout:.0f}s.") from exc
    except requests.RequestException as exc:
        raise LLMUnavailable(f"OpenRouter could not be reached: {exc}") from exc

    if response.status_code >= 400:
        detail = (response.text or "")[:300]
        raise LLMUnavailable(f"OpenRouter returned {response.status_code}. {detail}")

    try:
        data = response.json()
        return data["choices"][0]["message"]["content"] or ""
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise LLMInvalidResponse(f"OpenRouter's reply had an unexpected shape: {exc}") from exc


def _dispatch(
    *, system_prompt: str, user_input: str, timeout: float, max_tokens: int, temperature: float
) -> str:
    provider = (settings.LLM_PROVIDER or "ai_service").strip().lower()
    if provider == "openrouter":
        return _call_openrouter(
            system_prompt=system_prompt,
            user_input=user_input,
            timeout=timeout,
            max_tokens=max_tokens,
            temperature=temperature,
        )
    if provider == "ai_service":
        return _call_ai_service(
            system_prompt=system_prompt,
            user_input=user_input,
            timeout=timeout,
            max_tokens=max_tokens,
            temperature=temperature,
        )
    raise LLMUnavailable(
        f"LLM_PROVIDER is set to {provider!r}, which is not a transport this build "
        "knows. Use 'ai_service' or 'openrouter'."
    )


# ── The one call the rest of the module uses ─────────────────────────────────

def complete_json(
    *,
    system_prompt: str,
    user_input: str,
    model_cls: type[TModel],
    max_tokens: int = 16000,
    temperature: float = 0.1,
    timeout: float | None = None,
    attempts: int = 2,
) -> TModel:
    """Ask for JSON and return it validated, or raise.

    `attempts` is bounded and small on purpose. A schema violation is usually
    the model misreading the instruction, and one corrective retry fixes most
    of them; beyond that it is spending real money and latency to make the same
    mistake again. A truncated reply in particular is not retriable — the same
    request against the same token cap truncates identically — so the retry
    carries the validation error back to the model rather than repeating the
    request verbatim.

    A transport failure is never retried here: LLMUnavailable means the model
    was not reached, and hammering an unreachable service helps nobody.
    """
    # Provider-specific, because reading OPENROUTER_TIMEOUT_SECONDS on the
    # ai_service path meant an operator tuning the AI service's timeout had to
    # set a variable named after a provider they were not using.
    if timeout is None:
        if (settings.LLM_PROVIDER or "ai_service").strip().lower() == "openrouter":
            timeout = float(settings.OPENROUTER_TIMEOUT_SECONDS or 120)
        else:
            timeout = float(settings.AI_SERVICE_TIMEOUT_SECONDS or 120)
    last_error: Exception | None = None
    prompt = user_input

    for attempt in range(1, max(1, attempts) + 1):
        raw = _dispatch(
            system_prompt=system_prompt,
            user_input=prompt,
            timeout=timeout,
            max_tokens=max_tokens,
            temperature=temperature,
        )
        try:
            return model_cls.model_validate(extract_json(raw))
        except (LLMInvalidResponse, ValidationError) as exc:
            last_error = exc
            logger.warning(
                "LLM reply failed validation on attempt %d/%d: %s", attempt, attempts, exc
            )
            if attempt >= attempts:
                break
            # Hand the failure back rather than re-asking blind.
            prompt = (
                f"{user_input}\n\nYour previous reply could not be used: {exc}\n"
                "Return ONLY valid JSON matching the requested schema."
            )

    raise LLMInvalidResponse(
        f"The model did not return usable JSON after {attempts} attempt(s). {last_error}"
    )


def provider_status() -> dict[str, Any]:
    """Whether the configured transport could be used right now.

    Surfaced to the UI for the same reason the runtime preflight is: a missing
    key should be visible before someone clicks Refine, not after.
    """
    provider = (settings.LLM_PROVIDER or "ai_service").strip().lower()
    if provider == "openrouter":
        missing = settings.openrouter_missing_keys()
        return {
            "provider": provider,
            "configured": not missing,
            "detail": (
                f"OpenRouter model {settings.OPENROUTER_MODEL}"
                if not missing
                else "Not configured. Missing: " + ", ".join(missing)
            ),
        }
    base = (settings.ai_config.BASE_URL or "").strip()
    return {
        "provider": provider,
        "configured": bool(base),
        "detail": (
            f"AI service at {base}" if base else "The AI service base URL is not configured."
        ),
    }
