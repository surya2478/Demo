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

Deliberately OpenRouter-only. The point of this module is to replace the call
to the external AI service, so routing back to that service would defeat it.
LLM_PROVIDER still governs the Automation module and is not read here.
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


def _resolve_limits(
    temperature: float | None, max_tokens: int | None
) -> tuple[float, int]:
    """Reconcile what the client asked for with what the server permits.

    Client values are treated as requests, not instructions. max_tokens in
    particular is a spending control: this backend holds the OpenRouter key, so
    it caps the ceiling rather than letting a form field set it.
    """
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


def stream_chat(
    *,
    system_prompt: str,
    user_input: str,
    temperature: float | None = None,
    max_tokens: int | None = None,
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

    temperature, max_tokens = _resolve_limits(temperature, max_tokens)
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
