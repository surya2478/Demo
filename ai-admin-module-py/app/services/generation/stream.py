"""
--- Generation: streaming transport ------------------------------------------

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

Two more transports exist for the Squad Knowledge Base, and only a caller can
select them (testcases.py passes SQUAD_KB_GENERATION_PROVIDER):

  * openai -- any OpenAI-compatible /chat/completions at OPENAI_BASE_URL.
  * azure  -- the full chat-completions URL in AZURE_AI_CHAT_COMPLETIONS_URL.

openai is deliberately NOT a valid value for LLM_PROVIDER. That setting also
drives services/automation/llm.py, which does not know it, so
LLM_PROVIDER=openai would take down Refine, Review and healing just to change
where test cases are generated. azure is valid: llm.py sends it to the same
Azure OpenAI deployment (AZURE_OPENAI_*), and so does the azure target here
when the older AZURE_AI_* route is not set.
"""
from __future__ import annotations

import json
import logging
from typing import Iterator
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

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


def _provider(override: str | None = None) -> str:
    """Which transport answers.

    LLM_PROVIDER, the same setting the Automation module reads, unless the
    caller names one -- which only the Squad Knowledge Base path does.
    """
    return (override or settings.LLM_PROVIDER or "ai_service").strip().lower()


def _resolve_limits(
    temperature: float | None, max_tokens: int | None, provider: str
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

    openai and azure spend a key this backend holds too, so they share the same
    ceiling rather than each growing a setting of its own.
    """
    if provider == "ai_service":
        resolved_tokens = int(max_tokens) if max_tokens and max_tokens > 0 else 8192
        resolved_temp = 0.1 if temperature is None else min(max(float(temperature), 0.0), 2.0)
        return resolved_temp, resolved_tokens

    # The ceiling is the spending control, and it is also the size of the reply.
    # A lower client value is not honoured: the Test Assistant's form still
    # sends ai_config's 4096, which cut a 16k-character BRD's table off mid-row
    # at the 39th case.
    resolved_tokens = int(settings.OPENROUTER_MAX_TOKENS or 8192)

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
    endpoint = settings.ai_config.ENDPOINTS.chatStream or "/chat/stream"
    return f"{base}{endpoint if endpoint.startswith('/') else '/' + endpoint}"


# --- Automation Module: what /chat/init actually wants -----------------------
# brd_content is the ONLY required field on /chat/init, and the service is not
# indifferent to it:
#
#   brd_content = ""            -> the session opens, and every /chat/stream on
#                                  it answers with the literal string
#                                  "Empty Response". A 200, no error, nothing to
#                                  distinguish it from a model that had nothing
#                                  to say.
#   brd_content = whole BRD     -> /chat/init returns 500 at around 16k chars.
#                                  The service appears to index what it is given
#                                  and does not survive a document that size.
#   brd_content = a short real
#                 excerpt       -> answers normally, and a 16k user_input on the
#                                  same session is handled without complaint.
#
# So the session is seeded with the opening of the document -- non-empty, well
# under the ceiling, and genuinely representative rather than a dummy string --
# and the full text continues to travel in user_input, where size has never been
# a problem. Measured on the deployed service: 50 and 500 char seeds answered in
# 858 and 1074 characters; an empty seed answered "Empty Response" every time.
_SESSION_SEED_CHARS = 500


def _session_seed(user_input: str) -> str:
    """A short, non-empty excerpt of the document, to open the session with."""
    seed = (user_input or "").strip()[:_SESSION_SEED_CHARS]
    # A blank document is a caller error, but it must not become the silent
    # "Empty Response" this constant exists to prevent.
    return seed or "Requirements document."


def _ai_service_init_url() -> str:
    """The AI service's session-init endpoint, built like the stream one."""
    base = (settings.ai_config.BASE_URL or "").rstrip("/")
    endpoint = settings.ai_config.ENDPOINTS.chatInitiate or "/chat/init"
    return f"{base}{endpoint if endpoint.startswith('/') else '/' + endpoint}"


def _open_ai_service_session(
    *, seed: str, temperature: float, max_tokens: int, timeout: float
) -> str:
    """Open a chat session and return its id.

    --- Automation Module: the handshake this transport was missing ----------
    The AI service's chat endpoint is stateful. It will not answer a request
    carrying an empty session_id, and both callers here sent exactly that:

        "session_id": (None, "")

    Its refusal is an HTTP 404 whose body is an application error --
    {"error": "Session  not found. Please initialize the session first."} --
    and that combination is what made this expensive to find. A 404 reads as a
    wrong URL, so the endpoint NAME was corrected first and the same 404 came
    back; only the body distinguishes "no such route" (FastAPI's own
    {"detail": "Not Found"}) from "route fine, session missing". The doubled
    space in "Session  not found" is the empty id being interpolated.

    So the session is opened here and its id travels with the prompt. Cost is
    one extra round trip per generation; the alternative -- caching a session
    across generations -- would tie an unrelated conversation's history to the
    next document, which is worse than the round trip.
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
    headers = {}
    token = (settings.AI_SERVICE_AUTH_TOKEN or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        response = requests.post(
            url,
            files=payload,
            headers=headers or None,
            timeout=timeout,
            verify=_ai_service_verify(),
        )
    except requests.RequestException as exc:
        raise GenerationUnavailable(
            f"The AI service session could not be opened at {url}: {exc}"
        ) from exc

    if response.status_code >= 400:
        raise GenerationUnavailable(
            f"The AI service returned {response.status_code} opening a session "
            f"at {url}. {response.text[:300]}"
        )

    try:
        data = response.json()
    except ValueError:
        raise GenerationUnavailable(
            f"The AI service did not return JSON when opening a session at {url}."
        ) from None

    # Key name is not guaranteed across builds of the service, so accept the
    # spellings it has used rather than failing on a cosmetic difference.
    session_id = ""
    for key in ("session_id", "sessionId", "id"):
        value = str(data.get(key) or "").strip()
        if value:
            session_id = value
            break
    if not session_id:
        raise GenerationUnavailable(
            f"The AI service opened a session at {url} but returned no session "
            f"id. Body: {str(data)[:200]}"
        )

    logger.info("Opened AI service chat session %s", session_id)
    return session_id


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
    timeout = timeout or float(settings.AI_SERVICE_TIMEOUT_SECONDS or 120)
    session_id = _open_ai_service_session(
        seed=_session_seed(user_input),
        temperature=temperature,
        max_tokens=max_tokens,
        timeout=timeout,
    )
    payload = {
        "session_id": (None, session_id),
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
    provider: str | None = None,
    model_override: str | None = None,
) -> Iterator[str]:
    """Stream one chat completion as plain text chunks.

    The transport is LLM_PROVIDER unless `provider` names one. The caller builds
    the prompt and never learns which transport answered -- that is the whole
    point. Knowledge Base grounding is applied by the caller in this process,
    so it survives any route.

    `model_override` is a SERVER-side choice (a setting the caller read), never
    a form field: see _stream_chat_completions for why a browser must not pick
    the model. Only openai and azure honour it, because it is written in their
    model names; an OpenRouter slug and the AI service's own configuration are
    a different vocabulary, and "gpt-5.1" sent to either is simply rejected.

    `yield from`, not `return`, so this stays a generator: every failure below
    then surfaces on the first next() rather than at call time, which is where
    the router is waiting for it with a 502. A bare `return` would let an
    unknown provider escape the router's try block as a 500.
    """
    provider = _provider(provider)
    temperature, max_tokens = _resolve_limits(temperature, max_tokens, provider)

    if provider == "ai_service":
        yield from _stream_ai_service(
            system_prompt=system_prompt,
            user_input=user_input,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
        )
    elif provider in ("openrouter", "openai", "azure"):
        yield from _stream_chat_completions(
            _chat_completions_target(provider, model_override),
            system_prompt=system_prompt,
            user_input=user_input,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
        )
    else:
        raise GenerationUnavailable(
            f"The generation provider is set to {provider!r}, which is not a "
            "transport this build knows. Use 'ai_service', 'openrouter', "
            "'openai' or 'azure'."
        )


def _missing(pairs: tuple[tuple[str, str], ...]) -> list[str]:
    return [name for name, value in pairs if not (value or "").strip()]


def _chat_completions_target(provider: str, model_override: str | None) -> dict:
    """Where an OpenAI-shaped call goes, and how it authenticates.

    The three providers speak the same streaming protocol and differ only in
    what is gathered here, so there is one stream loop instead of three.
    """
    if provider == "openrouter":
        missing = settings.openrouter_missing_keys()
        if missing:
            raise GenerationUnavailable(
                "OpenRouter is not configured. Missing: "
                + ", ".join(missing)
                + ". Set them in the backend's .env."
            )
        headers = {"Authorization": f"Bearer {settings.OPENROUTER_API_KEY}"}
        # Optional attribution. OpenRouter uses these to identify the calling app.
        if settings.OPENROUTER_SITE_URL:
            headers["HTTP-Referer"] = settings.OPENROUTER_SITE_URL
        if settings.OPENROUTER_APP_NAME:
            headers["X-Title"] = settings.OPENROUTER_APP_NAME
        return {
            "label": "OpenRouter",
            "url": settings.OPENROUTER_BASE_URL.rstrip("/") + "/chat/completions",
            "headers": headers,
            "model": settings.OPENROUTER_MODEL,
            "timeout": settings.OPENROUTER_TIMEOUT_SECONDS,
            "token_field": "max_tokens",
            # Reasoning is off unless configured: see OPENROUTER_REASONING.
            "usage": {"usage": {"include": True}, **settings.openrouter_reasoning()},
        }

    if provider == "openai":
        model = (model_override or settings.OPENAI_MODEL or "").strip()
        missing = _missing((
            ("OPENAI_API_KEY", settings.OPENAI_API_KEY),
            ("OPENAI_BASE_URL", settings.OPENAI_BASE_URL),
            ("OPENAI_MODEL", model),
        ))
        if missing:
            raise GenerationUnavailable(
                "OpenAI is not configured. Missing: "
                + ", ".join(missing)
                + ". Set them in the backend's .env."
            )
        return {
            "label": "OpenAI",
            "url": settings.OPENAI_BASE_URL.rstrip("/") + "/chat/completions",
            "headers": {"Authorization": f"Bearer {settings.OPENAI_API_KEY}"},
            "model": model,
            "timeout": settings.OPENAI_TIMEOUT_SECONDS,
            # gpt-5 and the o-series reject max_tokens outright; this name is
            # accepted by every current chat model, older ones included.
            "token_field": "max_completion_tokens",
            "usage": {"stream_options": {"include_usage": True}},
        }

    # azure
    if not settings.AZURE_AI_CHAT_COMPLETIONS_URL.strip() and settings.AZURE_OPENAI_BASE_URL.strip():
        # The Azure OpenAI v1 API (AZURE_OPENAI_*, see azure_llm.py): the
        # deployment is the model, and the key goes in an api-key header.
        from . import azure_llm

        missing = azure_llm.missing_settings()
        if missing:
            raise GenerationUnavailable("Azure OpenAI is not configured. Missing: " + ", ".join(missing) + ".")
        return {
            "label": "Azure OpenAI",
            "url": azure_llm._url("chat/completions"),
            "headers": {"api-key": settings.AZURE_OPENAI_API_KEY.strip()},
            "model": azure_llm.model_name(),
            "timeout": settings.AZURE_OPENAI_TIMEOUT_SECONDS,
            "token_field": "max_completion_tokens",
            "usage": {"stream_options": {"include_usage": True}},
        }
    model = (model_override or settings.AZURE_AI_MODEL or "").strip()
    missing = _missing((
        ("AZURE_AI_CHAT_COMPLETIONS_URL", settings.AZURE_AI_CHAT_COMPLETIONS_URL),
        ("AZURE_AI_API_KEY", settings.AZURE_AI_API_KEY),
        ("AZURE_AI_MODEL", model),
    ))
    if missing:
        raise GenerationUnavailable(
            "Azure AI is not configured. Missing: "
            + ", ".join(missing)
            + ". Set them in the backend's .env."
        )
    parts = urlsplit(settings.AZURE_AI_CHAT_COMPLETIONS_URL.strip())
    # The setting is the WHOLE route, because Azure OpenAI and Azure AI Projects
    # shape it differently. A bare host is the likely mistake, and it fails as
    # an unexplained 404 -- so it is named here instead.
    if not parts.path.rstrip("/").endswith("/chat/completions"):
        raise GenerationUnavailable(
            "AZURE_AI_CHAT_COMPLETIONS_URL must be the full chat-completions "
            "route (ending in /chat/completions), not just the host. Got "
            f"{settings.AZURE_AI_CHAT_COMPLETIONS_URL!r}."
        )
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    if settings.AZURE_AI_API_VERSION and "api-version" not in query:
        query["api-version"] = settings.AZURE_AI_API_VERSION
    url = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))
    if settings.AZURE_AI_AUTH_MODE.strip().lower() == "bearer":
        headers = {"Authorization": f"Bearer {settings.AZURE_AI_API_KEY}"}
    else:
        headers = {"api-key": settings.AZURE_AI_API_KEY}
    return {
        "label": "Azure AI",
        "url": url,
        "headers": headers,
        "model": model,
        "timeout": settings.AZURE_AI_TIMEOUT_SECONDS,
        "token_field": "max_completion_tokens",
        "usage": {"stream_options": {"include_usage": True}},
    }


def _stream_chat_completions(
    target: dict,
    *,
    system_prompt: str,
    user_input: str,
    temperature: float,
    max_tokens: int,
    timeout: float | None = None,
) -> Iterator[str]:
    """Stream one chat completion from an OpenAI-shaped endpoint as text chunks.

    `target` comes from _chat_completions_target. Yields the assistant's
    content deltas in order, then the token marker.

    Note what is absent: a client-supplied model. The model is a server setting
    and nothing else. The frontend does send a `model_name` in its form,
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
    label = target["label"]
    # Limits are already resolved by stream_chat, which is the only caller.
    timeout = timeout or float(target["timeout"] or 120)

    headers = {
        **target["headers"],
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }

    body = {
        "model": target["model"],
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_input},
        ],
        "temperature": temperature,
        target["token_field"]: max_tokens,
        "stream": True,
        # Ask for usage totals on the final frame. Without this the stream ends
        # with no counts at all and the request tracker logs a generation that
        # apparently cost nothing -- a wrong number being worse than none, the
        # marker below is omitted entirely when this does not come back.
        # OpenRouter and OpenAI spell the request differently.
        **target["usage"],
    }

    url = target["url"]
    logger.info(
        "Streaming generation from %s model=%s max_tokens=%d temperature=%.2f",
        label,
        target["model"],
        max_tokens,
        temperature,
    )

    for attempt in (1, 2, 3):
        try:
            response = requests.post(
                url, headers=headers, json=body, timeout=timeout, stream=True
            )
        except requests.Timeout as exc:
            raise GenerationUnavailable(
                f"{label} did not respond within {timeout:.0f}s."
            ) from exc
        except requests.RequestException as exc:
            raise GenerationUnavailable(f"{label} could not be reached: {exc}") from exc
        # Reasoning models (Azure's among them) accept only the default
        # temperature: retry once without it, as azure_llm does.
        if attempt < 3 and label == "OpenRouter" and response.status_code == 400 and "reasoning is mandatory" in (response.text or "").lower() and body.get("reasoning") != {"enabled": True}:
            response.close()
            body = {**body, "reasoning": {"enabled": True}}
            continue
        if attempt < 3 and "temperature" in body and response.status_code == 400 and "temperature" in (response.text or "").lower():
            response.close()
            logger.info("%s rejected 'temperature'; retrying without it", label)
            body = {k: v for k, v in body.items() if k != "temperature"}
            continue
        break

    with response:
        if response.status_code >= 400:
            detail = (response.text or "")[:300]
            raise GenerationUnavailable(
                f"{label} returned {response.status_code}. {detail}"
            )

        usage: dict | None = None
        produced = False
        finish: str | None = None

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
                    "Skipping unparseable SSE frame from %s: %.120s", label, payload
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
                logger.error("%s reported an error mid-stream: %s", label, message)
                yield f"\n\n> **Generation stopped:** {message}\n"
                break

            if frame.get("usage"):
                usage = frame["usage"]

            for choice in frame.get("choices") or []:
                finish = choice.get("finish_reason") or finish
                delta = (choice.get("delta") or {}).get("content")
                if delta:
                    produced = True
                    yield delta

    if not produced:
        reasoning = ((usage or {}).get("completion_tokens_details") or {}).get("reasoning_tokens")
        logger.warning(
            "%s stream closed without producing any content (finish=%s, reasoning tokens=%s)",
            label, finish, reasoning,
        )
        if finish == "length" and reasoning:
            yield (
                f"\n> **No content was returned.** The model spent all {reasoning} tokens "
                "of its reply thinking and never answered. Turn reasoning off "
                "(OPENROUTER_REASONING=off) or raise the reply limit.\n"
            )
        else:
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
            "%s returned no usage totals; omitting the token marker so "
            "the request tracker records nothing rather than zero",
            label,
        )
