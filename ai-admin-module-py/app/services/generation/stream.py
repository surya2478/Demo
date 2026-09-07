"""
--- Generation: OpenRouter streaming transport -------------------------------

The Test Assistant tabs render the model's answer as it arrives: the browser
reads the response body chunk by chunk and appends each one to the view. That
is the whole reason this is a separate transport from
services/automation/llm.py -- that one buffers a complete reply and validates
it against a pydantic schema, which by construction cannot render progressively.

So: OpenRouter's SSE stream in, plain text chunks out. No JSON envelope and no
`data:` framing on the way out. The frontend concatenates whatever bytes it
receives and parses the markdown itself; framing here would mean every consumer
has to strip it, and the existing consumers do not.

Two transports, chosen by LLM_PROVIDER, because the prompt and the model are
separable concerns and only the prompt has to live here.

  * openrouter -- this backend holds the key and calls the model directly.
  * ai_service -- the deployed AI service owns the model and its credentials,
    and this backend holds no key at all.

The second one is what makes Knowledge Base grounding reach a deployment that
never had an OpenRouter key. This module was OpenRouter-only on the reasoning
that routing back to the AI service would defeat the point of replacing it.
That conflated two different things. What matters is WHERE THE PROMPT IS
BUILT: build_flow_context_prompt runs in this process, so a request that
reaches this backend is grounded against the Knowledge Base whichever model
answers it. A request that goes straight from the browser to the AI service
cannot be, because nothing here is asked -- which is exactly the difference
between a grounded local result and an ungrounded deployed one.

services/automation/llm.py has its own ai_service transport and is NOT
imported here. It buffers a whole reply to validate against a schema, which by
construction cannot render progressively, and the two modules deliberately
share no transport -- see this file's opening paragraph.
"""
from __future__ import annotations

import json
import logging
from typing import Iterator

import requests

from ...config import settings

logger = logging.getLogger(__name__)


class GenerationError(Exception):
    """Base for anything that stopped a generation producing an answer."""


class GenerationUnavailable(GenerationError):
    """The model was never reached -- configuration or transport.

    Distinct from a bad answer on purpose: this one is the operator's to fix,
    and retrying it changes nothing.
    """


def token_marker(prompt_tokens: int, response_tokens: int, total_tokens: int) -> str:
    """The usage marker the frontend scrapes out of the streamed text.

    `extractTokenCounts` in the frontend matches this exact shape and feeds both
    the request tracker and the per-user token allowance from it. It goes last,
    after the model's own output, so a client that ignores it renders one extra
    line rather than losing content.
    """
    return (
        f"\n\n[TOKEN_COUNTS:Prompt={prompt_tokens},"
        f"Response={response_tokens},Total={total_tokens}]"
    )


def _provider() -> str:
    """Which transport answers. Same setting the Automation module reads."""
    return (settings.LLM_PROVIDER or "ai_service").strip().lower()


def _resolve_limits(
    temperature: float | None, max_tokens: int | None
) -> tuple[float, int]:
    """Reconcile what the client asked for with what the server permits.

    Client values are treated as requests, not instructions. max_tokens in
    particular is a spending control: this backend holds the OpenRouter key, so
    it caps the ceiling rather than letting a form field set it.

    That cap is a spending control and nothing else, so it applies only to the
    provider whose spending it controls. On the ai_service path the AI service
    owns the model and pays for the call, and clamping to a ceiling named after
    OpenRouter would silently truncate a long table for a deployment that has
    no OpenRouter account -- the same mistake AI_SERVICE_TIMEOUT_SECONDS exists
    to correct for timeouts.
    """
    if _provider() == "ai_service":
        resolved_tokens = int(max_tokens) if max_tokens and max_tokens > 0 else 8192
        resolved_temp = 0.1 if temperature is None else min(max(float(temperature), 0.0), 2.0)
        return resolved_temp, resolved_tokens

    ceiling = int(settings.OPENROUTER_MAX_TOKENS or 8192)
    if max_tokens is None or max_tokens <= 0:
        resolved_tokens = ceiling
    else:
        resolved_tokens = min(int(max_tokens), ceiling)

    if temperature is None:
        resolved_temp = float(settings.OPENROUTER_TEMPERATURE or 0.1)
    else:
        resolved_temp = min(max(float(temperature), 0.0), 2.0)

    return resolved_temp, resolved_tokens


def _ai_service_url() -> str:
    """The AI service's streaming chat endpoint, from the live ai_config.

    ai_config is loaded from config.json at startup (see main.py's startup
    hook). A deployment that never loaded it would post to the defaults in
    config.py, which is why the empty base is an error rather than a fallback.
    """
    base = (settings.ai_config.BASE_URL or "").rstrip("/")
    if not base:
        raise GenerationUnavailable(
            "The AI service base URL is not configured. Set it in the Settings "
            "screen, or set LLM_PROVIDER=openrouter."
        )
    endpoint = settings.ai_config.ENDPOINTS.chatStream or "/chat/message"
    return f"{base}{endpoint if endpoint.startswith('/') else '/' + endpoint}"


def _ai_service_verify() -> bool | str:
    """TLS verification for the AI service call.

    A corporate CA that the container's trust store does not carry is the
    normal case in the deployed environment, which is what
    AI_SERVICE_CA_BUNDLE_PATH is for.
    """
    if not settings.AI_SERVICE_VERIFY_SSL:
        return False
    bundle = (settings.AI_SERVICE_CA_BUNDLE_PATH or "").strip()
    return bundle or True


def _stream_ai_service(
    *,
    system_prompt: str,
    user_input: str,
    temperature: float,
    max_tokens: int,
    timeout: float | None,
) -> Iterator[str]:
    """Stream one chat completion from the deployed AI service.

    The wire format is the multipart form the AI service already accepts and
    the same one services/automation/llm.py posts -- session_id, user_input,
    system_prompt, provider, model_name, temperature, max_tokens -- answered
    with raw text chunks rather than SSE frames. So there is nothing to unwrap:
    the bytes are forwarded as they arrive.

    WHICH MODEL ANSWERS is ai_config.PARAMETERS, the configuration the Settings
    screen edits. That is the opposite of the OpenRouter path's rule, and for a
    reason that only looks inconsistent: there, honouring a browser-supplied
    model would let any authenticated user spend this backend's key. Here the
    AI service owns the model and pays for it, so the deployment's own
    configuration is the right authority.

    No token marker is emitted. The AI service returns no usage totals, and
    extractTokenCounts is happy to find none -- the request tracker then
    records nothing for the call, which is the honest outcome. Inventing zeros
    would show every deployed generation as free.
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
    headers = {}
    token = (settings.AI_SERVICE_AUTH_TOKEN or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    timeout = timeout or float(settings.AI_SERVICE_TIMEOUT_SECONDS or 120)
    logger.info(
        "Streaming generation from AI service at %s (model=%s)", url, params.model
    )

    try:
        response = requests.post(
            url,
            files=payload,
            headers=headers or None,
            timeout=timeout,
            stream=True,
            verify=_ai_service_verify(),
        )
    except requests.Timeout as exc:
        raise GenerationUnavailable(
            f"The AI service did not respond within {timeout:.0f}s."
        ) from exc
    except requests.RequestException as exc:
        raise GenerationUnavailable(f"The AI service could not be reached: {exc}") from exc

    produced = False
    with response:
        # Raised before the first yield, so the router can still turn it into a
        # real status code rather than an error pasted inside a 200 body.
        if response.status_code >= 400:
            detail = (response.text or "")[:300]
            raise GenerationUnavailable(
                f"The AI service returned {response.status_code} for {url}. {detail}"
            )

        for chunk in response.iter_content(chunk_size=8192, decode_unicode=True):
            if not chunk:
                continue
            produced = True
            yield chunk if isinstance(chunk, str) else chunk.decode("utf-8", "replace")

    if not produced:
        logger.warning("AI service stream closed without producing any content")
        yield (
            "\n> **No content was returned.** The model accepted the request but "
            "produced an empty reply. Try again, or reduce the size of the input.\n"
        )


def stream_chat(
    *,
    system_prompt: str,
    user_input: str,
    temperature: float | None = None,
    max_tokens: int | None = None,
    timeout: float | None = None,
) -> Iterator[str]:
    """Stream one chat completion as plain text chunks, via LLM_PROVIDER.

    The caller builds the prompt and never learns which transport answered --
    that is the whole point. Knowledge Base grounding is applied by the caller
    in this process, so it survives either route.

    `yield from`, not `return`, so this stays a generator: every failure below
    then surfaces on the first next() rather than at call time, which is where
    the router is waiting for it with a 502. A bare `return` would let an
    unknown LLM_PROVIDER escape the router's try block as a 500.
    """
    provider = _provider()
    temperature, max_tokens = _resolve_limits(temperature, max_tokens)

    if provider == "ai_service":
        yield from _stream_ai_service(
            system_prompt=system_prompt,
            user_input=user_input,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
        )
    elif provider == "openrouter":
        yield from _stream_openrouter(
            system_prompt=system_prompt,
            user_input=user_input,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
        )
    else:
        raise GenerationUnavailable(
            f"LLM_PROVIDER is set to {provider!r}, which is not a transport this "
            "build knows. Use 'ai_service' or 'openrouter'."
        )


def _stream_openrouter(
    *,
    system_prompt: str,
    user_input: str,
    temperature: float,
    max_tokens: int,
    timeout: float | None = None,
) -> Iterator[str]:
    """Stream one chat completion from OpenRouter as plain text chunks.

    Yields the assistant's content deltas in order, then the token marker.

    Note what is absent: a `model` argument. The model is settings.OPENROUTER_-
    MODEL and nothing else. The frontend does send a `model_name` in its form,
    but that value comes from ai_config, which is served to every authenticated
    user and cached in their localStorage -- honouring it would let a browser
    pick which model this backend's key pays for. It also currently holds an
    Ollama tag ("gemma3:1b") that OpenRouter would simply reject.

    Nothing is yielded until the connection is open and the first frame has been
    read, so a configuration error, a 401, or an unreachable host raises before
    the caller has committed to a 200 response. Only failures that land after
    the first token has been produced degrade into in-band text -- unavoidable,
    since the status line is long gone by then.
    """
    missing = settings.openrouter_missing_keys()
    if missing:
        raise GenerationUnavailable(
            "OpenRouter is not configured. Missing: "
            + ", ".join(missing)
            + ". Set them in the backend's .env."
        )

    # Limits are already resolved by stream_chat, which is the only caller.
    timeout = timeout or float(settings.OPENROUTER_TIMEOUT_SECONDS or 120)

    headers = {
        "Authorization": f"Bearer {settings.OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
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
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
        # Ask for usage totals on the final frame. Without this the stream ends
        # with no counts at all and the request tracker logs a generation that
        # apparently cost nothing -- a wrong number being worse than none, the
        # marker below is omitted entirely when this does not come back.
        "usage": {"include": True},
    }

    url = settings.OPENROUTER_BASE_URL.rstrip("/") + "/chat/completions"
    logger.info(
        "Streaming generation from OpenRouter model=%s max_tokens=%d temperature=%.2f",
        settings.OPENROUTER_MODEL,
        max_tokens,
        temperature,
    )

    try:
        response = requests.post(
            url, headers=headers, json=body, timeout=timeout, stream=True
        )
    except requests.Timeout as exc:
        raise GenerationUnavailable(
            f"OpenRouter did not respond within {timeout:.0f}s."
        ) from exc
    except requests.RequestException as exc:
        raise GenerationUnavailable(f"OpenRouter could not be reached: {exc}") from exc

    with response:
        if response.status_code >= 400:
            detail = (response.text or "")[:300]
            raise GenerationUnavailable(
                f"OpenRouter returned {response.status_code}. {detail}"
            )

        usage: dict | None = None
        produced = False

        for line in response.iter_lines(decode_unicode=True):
            if not line:
                continue
            # OpenRouter sends ": OPENROUTER PROCESSING" comment frames as
            # keep-alives while a cold model warms up. They are not data.
            if line.startswith(":"):
                continue
            if not line.startswith("data:"):
                continue

            payload = line[len("data:"):].strip()
            if payload == "[DONE]":
                break

            try:
                frame = json.loads(payload)
            except ValueError:
                logger.warning(
                    "Skipping unparseable SSE frame from OpenRouter: %.120s", payload
                )
                continue

            # An error can arrive mid-stream -- a moderation stop, a model that
            # dropped out, a mid-flight rate limit. The status line is already
            # sent, so the only honest channel left is the body itself.
            error = frame.get("error")
            if error:
                message = (
                    error.get("message") if isinstance(error, dict) else str(error)
                ) or "unspecified error"
                logger.error("OpenRouter reported an error mid-stream: %s", message)
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
        logger.warning("OpenRouter stream closed without producing any content")
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
    else:
        logger.warning(
            "OpenRouter returned no usage totals; omitting the token marker so "
            "the request tracker records nothing rather than zero"
        )
