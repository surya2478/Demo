"""
--- Generation API -----------------------------------------------------------

Serves the Test Assistant's generation endpoints from this backend, using the
OpenRouter key this backend already holds.

These paths were previously served by an external AI service at
ai_config.BASE_URL, which owned the model and its credentials. The contract is
reproduced here exactly -- same path, same multipart field names, same streamed
plain-text body -- so pointing ai_config.BASE_URL at this backend is the entire
migration and the frontend needs no change to the request itself.

What did change is authentication. The external service took the request
unauthenticated; that was tolerable when it held its own key and its own
budget. Here a request spends this backend's OpenRouter credit, so it requires
a logged-in user like every other write on this API.
"""
from __future__ import annotations

import logging
from itertools import chain

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from ..services.generation import testcases
from ..services.generation.stream import GenerationUnavailable
from ..utils.security import get_current_user_strict

logger = logging.getLogger(__name__)

router = APIRouter()

# Neither header is optional in the deployed setup: nginx sits in front of this
# backend in docker-compose, and its default proxy buffering would hold the
# whole reply until the model finished -- turning a progressive render into a
# blank screen followed by a wall of text.
_STREAM_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
}


@router.post("/brd-testcases")
def generate_brd_testcases(
    text: str = Form(default=""),
    provider: str = Form(default=""),
    model_name: str = Form(default=""),
    temperature: float = Form(default=0.2),
    max_tokens: int = Form(default=4096),
    response_format: str = Form(default="text"),
    files: list[UploadFile] = File(default=[]),
    current_user=Depends(get_current_user_strict),
):
    """Generate test cases from requirements text and stream them back.

    `provider` and `model_name` are accepted and ignored. They are part of the
    legacy form contract the frontend still sends, and rejecting them would
    break the tab for no gain, but the model is chosen server-side -- see
    stream_chat's docstring for why a browser-supplied model id is not honoured.

    The first chunk is pulled before the response is returned. That is the only
    window in which a failure can still become a real status code: once
    StreamingResponse is handed back, the 200 is already on the wire and a
    later error can only be reported inside the body.
    """
    if not (text or "").strip():
        # The external service overloaded this one path: sent `files` and no
        # `text`, it returned the documents' extracted text rather than test
        # cases, and the tab's "Process Documents" button relies on that. That
        # is a document-parsing job, not a model call, and it is not ported --
        # so say which of the two shapes arrived instead of failing as a bare
        # "field required".
        if files:
            raise HTTPException(
                status_code=501,
                detail=(
                    "Document extraction is not implemented on this backend. "
                    "The external AI service returned extracted text when this "
                    "endpoint was sent files instead of a 'text' field; only "
                    "test case generation from text has been ported. Paste or "
                    "edit the requirements text and generate from that."
                ),
            )
        raise HTTPException(
            status_code=400,
            detail="No requirements text was supplied. Add BRD text, process a "
            "document, or import an SSD before generating.",
        )

    username = (
        current_user.get("username")
        if isinstance(current_user, dict)
        else getattr(current_user, "username", "unknown")
    )
    logger.info(
        "Test case generation requested by %s (%d chars of requirements)",
        username,
        len(text),
    )

    chunks = testcases.stream_test_cases(
        requirements=text,
        temperature=temperature,
        max_tokens=max_tokens,
    )

    try:
        first = next(chunks, None)
    except GenerationUnavailable as exc:
        # 502, not 500: this backend is fine, the model behind it is not, and
        # the message names what an operator has to fix.
        logger.error("Generation unavailable: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    body = chunks if first is None else chain([first], chunks)

    return StreamingResponse(
        body,
        media_type="text/plain; charset=utf-8",
        headers=_STREAM_HEADERS,
    )


from ..services.generation.stream import stream_chat
import uuid


@router.post("/chat/session-init")
@router.post("/chat/init")
def init_chat_session(
    brd_content: str = Form(default=""),
    session_id: str = Form(default=""),
    provider: str = Form(default=""),
    model_name: str = Form(default=""),
    temperature: float = Form(default=0.2),
    max_tokens: int = Form(default=4096),
):
    """Initialize a chat session."""
    sid = session_id or f"sess_{uuid.uuid4().hex[:12]}"
    return {"status": "success", "session_id": sid, "message": "Session initialized"}


@router.post("/chat/message")
@router.post("/chat/stream")
def chat_message(
    user_input: str = Form(default=""),
    session_id: str = Form(default=""),
    system_prompt: str = Form(default=""),
    temperature: float = Form(default=0.2),
    max_tokens: int = Form(default=4096),
):
    """Stream chat responses via OpenRouter."""
    sys_prompt = system_prompt or "You are an intelligent QA and test engineering assistant helping test and automate web applications."
    chunks = stream_chat(
        system_prompt=sys_prompt,
        user_input=user_input,
        temperature=temperature,
        max_tokens=max_tokens,
    )
    try:
        first = next(chunks, None)
    except GenerationUnavailable as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    body = chunks if first is None else chain([first], chunks)
    return StreamingResponse(
        body,
        media_type="text/plain; charset=utf-8",
        headers=_STREAM_HEADERS,
    )
