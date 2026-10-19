"""
--- Automation Module: LLM transport ----------------------------------------

One narrow job: send a system prompt plus user content, get back JSON that
validates against a pydantic model, or raise something the caller can explain.

The transports below sit behind the same call. Which one answers is
AUTOMATION_LLM_PROVIDER, else LLM_PROVIDER -- so this module can use Azure while
the Test Assistant's own generation stays on LLM_PROVIDER:

  ai_service  the existing AI service at ai_config.BASE_URL. It owns the model
              and its credentials; this backend holds no key. Its chat endpoint
              is the only one that accepts a system_prompt, which is why that
              endpoint and not a /generate/* one.
  openrouter  this backend calls OpenRouter directly with OPENROUTER_API_KEY.
  azure       Azure OpenAI (AZURE_OPENAI_*), through services/generation/azure_llm.py
              -- the same deployment Knowledge Base generation uses.

Everything specific to a transport is isolated in its _call_* function. The
retry, the JSON extraction and the validation are shared, because those failure
modes are the model's, not the transport's.

Nothing here knows what a test case is. Refinement lives in refine.py.
"""
from __future__ import annotations

import json
import logging
import re
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Iterator, TypeVar

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

    # Whichever bracket opens first is the outer value. Trying "[" first
    # unconditionally turned {"requirements": [...]} plus a line of prose into
    # the bare inner list, which then failed the schema.
    spans = []
    for opener, closer in (("[", "]"), ("{", "}")):
        start = text.find(opener)
        end = text.rfind(closer)
        if start != -1 and end > start:
            spans.append((start, text[start : end + 1]))
    candidates.extend(span for _, span in sorted(spans))

    for candidate in candidates:
        try:
            return json.loads(candidate)
        except (TypeError, ValueError):
            continue

    preview = text.strip()[:200].replace("\n", " ")
    raise LLMInvalidResponse(f"The model did not return JSON. It began: {preview!r}")


# ── Transports ───────────────────────────────────────────────────────────────

def _ai_service_base() -> str:
    """Where this module's AI service calls go.

    AI_SERVICE_CHAT_BASE_URL when a deployment sets it -- an AI service for
    AI Checks, refine and healing on a different host from the one the Test
    Assistant tabs use -- else ai_config.BASE_URL, the same service the tabs
    call. A separate setting rather than reusing OPENAI_BASE_URL: that one is
    Squad KB generation's OpenAI-compatible endpoint, and the two are not the
    same kind of service.
    """
    override = (settings.AI_SERVICE_CHAT_BASE_URL or "").strip()
    if ".openai.azure.com" in override.lower():
        # An Azure OpenAI address here sent the AI service's /chat/init and
        # /chat/stream calls to Azure, which has neither. Azure is its own
        # provider ("azure"); the AI service is config.json's BASE_URL.
        logger.warning("AI_SERVICE_CHAT_BASE_URL is an Azure OpenAI address (%s); ignoring it and using "
                       "the AI service from config.json. Leave it empty.", override)
        override = ""
    return (override or settings.ai_config.BASE_URL or "").rstrip("/")


def _ai_service_url() -> str:
    base = _ai_service_base()
    endpoint = settings.ai_config.ENDPOINTS.chatStream or "/chat/stream"
    if not base:
        raise LLMUnavailable(
            "The AI service base URL is not configured. Set it in the Settings "
            "screen, or switch LLM_PROVIDER to 'openrouter'."
        )
    return f"{base}{endpoint if endpoint.startswith('/') else '/' + endpoint}"


def _ai_service_headers() -> dict:
    """The AI service's bearer token, when the deployment sets one.

    This module posted without it. stream.py has always sent it, and the
    deployed service answers 401 to a request that lacks it -- so the
    Automation module's ai_service path (refine, classify, script generation)
    could not have worked against that deployment, and would have failed as an
    unexplained LLMError the first time anyone tried.
    """
    token = (settings.AI_SERVICE_AUTH_TOKEN or "").strip()
    return {"Authorization": f"Bearer {token}"} if token else {}


def _ai_service_verify() -> bool | str:
    """TLS verification for the AI service, as services/generation/stream.py does it.

    This module posted with requests' default -- the system trust store -- and
    ignored AI_SERVICE_VERIFY_SSL and AI_SERVICE_CA_BUNDLE_PATH. The deployed
    AI service is signed by an internal CA, so generation (which honours both)
    worked while AI Checks, refine, classify and healing failed with
    CERTIFICATE_VERIFY_FAILED against the same host.
    """
    if not settings.AI_SERVICE_VERIFY_SSL:
        return False
    bundle = (settings.AI_SERVICE_CA_BUNDLE_PATH or "").strip()
    return bundle or True


# See services/generation/stream.py for the measurements behind this: an empty
# brd_content makes every reply on the session the literal string "Empty
# Response", and a whole document makes /chat/init return 500. A short real
# excerpt does neither.
_SESSION_SEED_CHARS = 500


def _session_seed(user_input: str) -> str:
    return (user_input or "").strip()[:_SESSION_SEED_CHARS] or "Requirements document."


def _with_instructions(system_prompt: str, user_input: str) -> str:
    """The task's instructions carried inside the message as well.

    The AI service's chat endpoint is a BRD chat assistant with its own system
    prompt, and the `system_prompt` field posted alongside is not reliably what
    the model follows: refinement came back as the model's own restatement of
    the case -- wrapped in {"refined_test_case": ...}, keyed by the source
    table's columns, with no `ref` -- which is exactly what a model that never
    saw the output schema produces. Stating the same instructions in the
    message itself reaches the model either way. The wording is unchanged; only
    where it is delivered is.
    """
    if not (system_prompt or "").strip():
        return user_input
    return (
        "Follow these instructions exactly. They define the task and the only "
        "acceptable output format.\n\n"
        f"<instructions>\n{system_prompt.strip()}\n</instructions>\n\n"
        f"{user_input}"
    )


def _ai_service_init_url() -> str:
    base = _ai_service_base()
    endpoint = settings.ai_config.ENDPOINTS.chatInitiate or "/chat/init"
    return f"{base}{endpoint if endpoint.startswith('/') else '/' + endpoint}"


def _open_ai_service_session(
    *, seed: str, temperature: float, max_tokens: int, timeout: float
) -> str:
    """Open a chat session and return its id.

    The AI service's chat endpoint is stateful and refuses an empty
    session_id with a 404 whose BODY, not status, says why:
    {"error": "Session  not found. Please initialize the session first."}.
    This module and services/generation/stream.py both sent an empty id and
    both therefore failed the same way; they keep separate copies of the
    transport on purpose (see this module's header), so they keep separate
    copies of the handshake too.
    """
    url = _ai_service_init_url()
    params = settings.ai_config.PARAMETERS
    payload = {
        "brd_content": (None, seed),
        "session_id": (None, ""),
        "provider": (None, str(params.provider or "")),
        "model_name": (None, str(params.model or "")),
        "temperature": (None, str(temperature)),
        "max_tokens": (None, str(max_tokens)),
    }
    try:
        response = requests.post(
            url, files=payload, headers=_ai_service_headers(), timeout=timeout, verify=_ai_service_verify()
        )
    except requests.RequestException as exc:
        raise LLMError(f"The AI service session could not be opened at {url}: {exc}") from exc

    if response.status_code >= 400:
        raise LLMError(
            f"The AI service returned {response.status_code} opening a session "
            f"at {url}. {response.text[:300]}"
        )
    try:
        data = response.json()
    except ValueError:
        raise LLMError(f"The AI service did not return JSON opening a session at {url}.") from None

    for key in ("session_id", "sessionId", "id"):
        value = str(data.get(key) or "").strip()
        if value:
            return value
    raise LLMError(
        f"The AI service opened a session at {url} but returned no session id. "
        f"Body: {str(data)[:200]}"
    )


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
    session_id = _open_ai_service_session(
        seed=_session_seed(user_input),
        temperature=temperature,
        max_tokens=max_tokens,
        timeout=timeout,
    )
    payload = {
        "session_id": (None, session_id),
        "user_input": (None, _with_instructions(system_prompt, user_input)),
        "system_prompt": (None, system_prompt),
        "provider": (None, str(params.provider or "")),
        "model_name": (None, str(params.model or "")),
        "temperature": (None, str(temperature)),
        "max_tokens": (None, str(max_tokens)),
    }

    try:
        with requests.post(
            url, files=payload, headers=_ai_service_headers(), timeout=timeout, stream=True,
            verify=_ai_service_verify(),
        ) as response:
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
        # Off unless configured: thinking is billed against max_tokens.
        **settings.openrouter_reasoning(),
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
        choice = data["choices"][0]
        content = choice["message"]["content"] or ""
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise LLMInvalidResponse(f"OpenRouter's reply had an unexpected shape: {exc}") from exc
    # A reasoning model can spend the whole max_tokens thinking and return no
    # answer at all; say so, rather than the bare "empty response" that follows.
    if not content.strip() and choice.get("finish_reason") == "length":
        reasoning = (data.get("usage") or {}).get("completion_tokens_details", {}).get("reasoning_tokens")
        raise LLMInvalidResponse(
            f"The model ran out of its {max_tokens}-token reply before answering"
            + (f" ({reasoning} tokens went on reasoning)" if reasoning else "")
            + ". Give it a larger max_tokens or less to do per call."
        )
    return content


def _call_azure(
    *, system_prompt: str, user_input: str, timeout: float, max_tokens: int, temperature: float
) -> str:
    """Azure OpenAI as plain chat text; JSON extraction and validation stay shared.

    Not azure_llm.complete_json: that asks Azure for a JSON object, and refine
    asks for a JSON array. Its timeout is AZURE_OPENAI_TIMEOUT_SECONDS.
    """
    from ..generation import azure_llm

    try:
        return azure_llm.complete_text(
            system_prompt=system_prompt, user_input=user_input, max_tokens=max_tokens, temperature=temperature
        )
    except azure_llm.AzureLLMUnavailable as exc:
        raise LLMUnavailable(str(exc)) from exc
    except azure_llm.AzureLLMInvalidResponse as exc:
        raise LLMInvalidResponse(str(exc)) from exc


# The provider a task chose for every call made inside it -- AI Checks set it
# from the Knowledge Base the case was generated with (provider_for_kb), so
# refine, review and classify all go where that case's generation went.
_TASK_PROVIDER: ContextVar[str | None] = ContextVar("automation_llm_provider", default=None)


@contextmanager
def use_provider(provider: str | None) -> Iterator[None]:
    """Calls made inside go to `provider` (None: the usual env-based choice)."""
    token = _TASK_PROVIDER.set(provider or None)
    try:
        yield
    finally:
        _TASK_PROVIDER.reset(token)


def _clean(value: str | None) -> str:
    """The provider word alone. Docker's env_file keeps everything after the
    '=' -- "azure -- for ai refine" or "azure  # refine" arrived whole and
    matched no transport -- so only the first word counts."""
    words = (value or "").split("#", 1)[0].split()
    return words[0].strip().lower() if words else ""


def _provider_name(provider: str | None = None) -> str:
    """The caller's choice, else the task's, else AUTOMATION_LLM_PROVIDER, else LLM_PROVIDER."""
    for value in (provider, _TASK_PROVIDER.get(), settings.AUTOMATION_LLM_PROVIDER, settings.LLM_PROVIDER):
        name = _clean(value)
        if name:
            return name
    return "ai_service"


def _dispatch(
    *,
    system_prompt: str,
    user_input: str,
    timeout: float,
    max_tokens: int,
    temperature: float,
    provider: str | None = None,
) -> str:
    # `provider` lets a caller name the transport; omitted, it is
    # AUTOMATION_LLM_PROVIDER, else LLM_PROVIDER.
    provider = _provider_name(provider)
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
    if provider == "azure":
        return _call_azure(
            system_prompt=system_prompt,
            user_input=user_input,
            timeout=timeout,
            max_tokens=max_tokens,
            temperature=temperature,
        )
    raise LLMUnavailable(
        f"The Automation LLM provider is {provider!r} (AUTOMATION_LLM_PROVIDER, else "
        "LLM_PROVIDER), which is not a transport this build knows. Use 'ai_service', "
        "'openrouter' or 'azure'."
    )


def _default_timeout(provider: str | None) -> float:
    # Provider-specific, because reading OPENROUTER_TIMEOUT_SECONDS on the
    # ai_service path meant an operator tuning the AI service's timeout had to
    # set a variable named after a provider they were not using.
    chosen = _provider_name(provider)
    if chosen == "openrouter":
        return float(settings.OPENROUTER_TIMEOUT_SECONDS or 120)
    if chosen == "azure":
        return float(settings.AZURE_OPENAI_TIMEOUT_SECONDS or 300)
    return float(settings.AI_SERVICE_TIMEOUT_SECONDS or 120)


def complete_text(
    *,
    system_prompt: str,
    user_input: str,
    max_tokens: int = 16000,
    temperature: float = 0.1,
    timeout: float | None = None,
    provider: str | None = None,
) -> str:
    """Ask for free-form text (e.g. a markdown table) and return it raw.

    Same transport as complete_json without the JSON step -- Coverage Analysis
    uses it for its recommended test cases table.
    """
    return _dispatch(
        system_prompt=system_prompt,
        user_input=user_input,
        timeout=timeout or _default_timeout(provider),
        max_tokens=max_tokens,
        temperature=temperature,
        provider=provider,
    )


# ── The one call the rest of the module uses ─────────────────────────────────

def _unwrap(data: Any) -> Any:
    """The reply without a one-key wrapper the model added around each item.

    [{"refined_test_case": {...}}] -> [{...}], and {"items": [...]} or
    {"result": {...}} -> the inner value. Only a dict with exactly one key whose
    value is itself a dict or list is unwrapped, so a real object is never
    mistaken for a wrapper. Returns `data` itself when nothing was unwrapped.
    """
    def inner(value: Any) -> Any:
        if isinstance(value, dict) and len(value) == 1:
            only = next(iter(value.values()))
            if isinstance(only, (dict, list)):
                return only
        return value

    if isinstance(data, list):
        items = [inner(item) for item in data]
        return items if any(a is not b for a, b in zip(items, data)) else data
    unwrapped = inner(data)
    return unwrapped if unwrapped is not data else data


def complete_json(
    *,
    system_prompt: str,
    user_input: str,
    model_cls: type[TModel],
    max_tokens: int = 16000,
    temperature: float = 0.1,
    timeout: float | None = None,
    attempts: int = 2,
    provider: str | None = None,
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
    if timeout is None:
        timeout = _default_timeout(provider)
    last_error: Exception | None = None
    prompt = user_input

    for attempt in range(1, max(1, attempts) + 1):
        raw = _dispatch(
            system_prompt=system_prompt,
            user_input=prompt,
            timeout=timeout,
            max_tokens=max_tokens,
            temperature=temperature,
            provider=provider,
        )
        try:
            data = extract_json(raw)
            try:
                return model_cls.model_validate(data)
            except ValidationError:
                # A bare list for a model whose only field is a list:
                # [{...}] -> {"requirements": [{...}]}.
                fields = list(model_cls.model_fields)
                if isinstance(data, list) and len(fields) == 1:
                    try:
                        return model_cls.model_validate({fields[0]: data})
                    except ValidationError:
                        pass
                unwrapped = _unwrap(data)
                if unwrapped is data:
                    raise
                try:
                    return model_cls.model_validate(unwrapped)
                except ValidationError:
                    # Report the reply as it came, not the unwrap attempt.
                    return model_cls.model_validate(data)
        except (LLMInvalidResponse, ValidationError) as exc:
            last_error = exc
            logger.warning(
                "LLM reply failed validation on attempt %d/%d: %s\nReply began: %s",
                attempt, attempts, exc, (raw or "").strip()[:600],
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


def complete_json_with_images(
    *,
    system_prompt: str,
    user_input: str,
    images: list[bytes],
    model: str,
    model_cls: type[TModel],
    max_tokens: int = 16000,
    temperature: float = 0.1,
    timeout: float = 300,
    attempts: int = 2,
    provider: str | None = None,
) -> TModel:
    """complete_json, with pictures: PNG or JPEG bytes sent alongside the text.

    provider "azure": the Azure OpenAI deployment (AZURE_OPENAI_MODEL) reads
    them; `model` is ignored. Otherwise OpenRouter, with a model that accepts
    images -- the AI service's chat endpoint takes text. There the caller names
    the model (JOURNEY_EXTRACTION_VISION_MODEL), not the text model used
    everywhere else.
    """
    import base64

    if provider == "azure":
        from ..generation import azure_llm

        try:
            return azure_llm.complete_json(system_prompt=system_prompt, user_input=user_input, model_cls=model_cls,
                                           max_tokens=max_tokens, temperature=temperature, attempts=attempts,
                                           images=images)
        except azure_llm.AzureLLMUnavailable as exc:
            raise LLMUnavailable(str(exc)) from exc
        except azure_llm.AzureLLMInvalidResponse as exc:
            raise LLMInvalidResponse(str(exc)) from exc
    if (settings.LLM_PROVIDER or "ai_service").strip().lower() != "openrouter":
        raise LLMUnavailable("Reading page images needs LLM_PROVIDER=openrouter; the AI service accepts text only.")
    missing = [k for k in settings.openrouter_missing_keys() if k != "OPENROUTER_MODEL"]
    if missing:
        raise LLMUnavailable("OpenRouter is not configured. Missing: " + ", ".join(missing) + ".")
    headers = {"Authorization": f"Bearer {settings.OPENROUTER_API_KEY}", "Content-Type": "application/json"}
    if settings.OPENROUTER_SITE_URL:
        headers["HTTP-Referer"] = settings.OPENROUTER_SITE_URL
    if settings.OPENROUTER_APP_NAME:
        headers["X-Title"] = settings.OPENROUTER_APP_NAME
    pictures = [
        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(img).decode("ascii")}}
        for img in images
    ]
    url = settings.OPENROUTER_BASE_URL.rstrip("/") + "/chat/completions"
    last_error: Exception | None = None
    prompt = user_input
    for attempt in range(1, max(1, attempts) + 1):
        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": [{"type": "text", "text": prompt}, *pictures]},
            ],
            "max_tokens": max_tokens,
            "temperature": temperature,
            **settings.openrouter_reasoning(),
        }
        try:
            response = requests.post(url, headers=headers, json=body, timeout=timeout)
        except requests.Timeout as exc:
            raise LLMUnavailable(f"OpenRouter did not respond within {timeout:.0f}s.") from exc
        except requests.RequestException as exc:
            raise LLMUnavailable(f"OpenRouter could not be reached: {exc}") from exc
        if response.status_code >= 400:
            raise LLMUnavailable(f"OpenRouter returned {response.status_code} for {model}. {(response.text or '')[:300]}")
        try:
            raw = response.json()["choices"][0]["message"]["content"] or ""
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise LLMInvalidResponse(f"OpenRouter's reply had an unexpected shape: {exc}") from exc
        try:
            return model_cls.model_validate(extract_json(raw))
        except (LLMInvalidResponse, ValidationError) as exc:
            last_error = exc
            logger.warning("Vision reply failed validation on attempt %d/%d: %s", attempt, attempts, exc)
            prompt = (f"{user_input}\n\nYour previous reply could not be used: {exc}\n"
                      "Return ONLY valid JSON matching the requested schema.")
    raise LLMInvalidResponse(f"The model did not return usable JSON after {attempts} attempt(s). {last_error}")


def provider_status() -> dict[str, Any]:
    """Whether the configured transport could be used right now.

    Surfaced to the UI for the same reason the runtime preflight is: a missing
    key should be visible before someone clicks Refine, not after.
    """
    provider = _provider_name()
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
    if provider == "azure":
        from ..generation import azure_llm

        missing = azure_llm.missing_settings()
        return {
            "provider": provider,
            "configured": not missing,
            "detail": (
                f"Azure OpenAI deployment {azure_llm.model_name()}"
                if not missing
                else "Not configured. Missing: " + ", ".join(missing)
            ),
        }
    base = _ai_service_base()
    return {
        "provider": provider,
        "configured": bool(base),
        "detail": (
            f"AI service at {base}" if base else "The AI service base URL is not configured."
        ),
    }
