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
import base64
import json
from pathlib import Path
from threading import Lock
from itertools import chain

import requests
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..config import settings
from ..services.generation import testcases
from ..services.knowledge_base.ingestion import ingest_docx
from ..services.knowledge_base import postgres_client
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

_FIGMA_PROMPT_PATH = Path(__file__).resolve().parent.parent / "figma_vlm_prompt.json"
_FIGMA_PROMPT_LOCK = Lock()
_SQUAD_KNOWLEDGE_BASES = set(testcases.SQUAD_KBS)
# Paths that exist only to generate from a chosen Knowledge Base; a request to
# one of them without a recognised KB is refused instead of silently running
# ungrounded on a different model.
_KB_GENERATION_PATHS = ("/kb-testcases", "/squad-testcases")
SQUAD_DATABASE_NAMES = ("B2B", "BCRM", "SMB")


def _normalize_knowledge_base(value: str) -> str:
    """Any KB the Select KB dropdown offers, in its canonical spelling, or ""."""
    normalized = " ".join((value or "").split()).casefold()
    return next(
        (allowed for allowed in testcases.KNOWLEDGE_BASES if allowed.casefold() == normalized),
        "",
    )


def _normalize_squad_name(value: str) -> str:
    normalized = " ".join((value or "").split()).casefold()
    return next(
        (allowed for allowed in _SQUAD_KNOWLEDGE_BASES if allowed.casefold() == normalized),
        "",
    )


class FigmaVlmPromptPayload(BaseModel):
    prompt: str = Field(min_length=20, max_length=20000)


def _read_figma_vlm_prompt() -> str:
    if _FIGMA_PROMPT_PATH.exists():
        try:
            payload = json.loads(_FIGMA_PROMPT_PATH.read_text(encoding="utf-8"))
            prompt = str(payload.get("prompt", "")).strip()
            if prompt:
                return prompt
        except (OSError, ValueError):
            logger.exception("Unable to read persisted Figma VLM prompt")
    return settings.FIGMA_VLM_PROMPT


@router.get("/figma/vlm-prompt")
def get_figma_vlm_prompt(current_user=Depends(get_current_user_strict)):
    """Return the server-side prompt used for Figma PDF vision extraction."""
    with _FIGMA_PROMPT_LOCK:
        return {"prompt": _read_figma_vlm_prompt(), "model": settings.FIGMA_VLM_MODEL}


@router.put("/figma/vlm-prompt")
def update_figma_vlm_prompt(
    payload: FigmaVlmPromptPayload,
    current_user=Depends(get_current_user_strict),
):
    """Persist the editable Figma extraction prompt for authenticated users."""
    prompt = payload.prompt.strip()
    with _FIGMA_PROMPT_LOCK:
        _FIGMA_PROMPT_PATH.write_text(
            json.dumps({"prompt": prompt}, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
    return {"prompt": prompt, "model": settings.FIGMA_VLM_MODEL}


@router.post("/figma/extract-text")
async def extract_figma_pdf_text(
    file: UploadFile = File(...),
    current_user=Depends(get_current_user_strict),
):
    """Extract text from a Figma PDF using the saved GPT-5.1 vision prompt."""
    filename = file.filename or "figma.pdf"
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    if not settings.OPENAI_API_KEY or not settings.OPENAI_BASE_URL:
        raise HTTPException(status_code=503, detail="OpenAI vision extraction is not configured")

    pdf_bytes = await file.read()
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="The uploaded PDF is empty")
    if len(pdf_bytes) > 50 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="The PDF exceeds the 50 MB extraction limit")

    payload = {
        "model": settings.FIGMA_VLM_MODEL,
        "input": [{
            "role": "user",
            "content": [
                {
                    "type": "input_file",
                    "filename": filename,
                    "file_data": f"data:application/pdf;base64,{base64.b64encode(pdf_bytes).decode('ascii')}",
                },
                {"type": "input_text", "text": _read_figma_vlm_prompt()},
            ],
        }],
    }

    # These handlers are async (they await the upload), so a plain blocking
    # call here would stall the event loop -- every other request on this
    # worker -- for as long as the model takes. The pool keeps it off the loop.
    try:
        response = await run_in_threadpool(
            requests.post,
            f"{settings.OPENAI_BASE_URL.rstrip('/')}/responses",
            headers={
                "Authorization": f"Bearer {settings.OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=settings.OPENAI_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"OpenAI vision request failed: {exc}") from exc

    if response.status_code >= 400:
        detail = response.text[:500]
        raise HTTPException(status_code=502, detail=f"OpenAI vision extraction failed: {detail}")

    result = response.json()
    extracted_text = result.get("output_text", "")
    if not extracted_text:
        output_items = result.get("output") or []
        extracted_text = "\n".join(
            content.get("text", "")
            for item in output_items
            for content in item.get("content", [])
            if content.get("type") in {"output_text", "text"}
        )
    if not extracted_text.strip():
        raise HTTPException(status_code=502, detail="OpenAI returned no extractable text")

    return {"filename": filename, "text": extracted_text.strip(), "model": settings.FIGMA_VLM_MODEL}


@router.post("/squad-knowledge-base/ingest-docx")
async def ingest_squad_knowledge_base_docx(
    squad_name: str = Form(...),
    file: UploadFile = File(...),
    current_user=Depends(get_current_user_strict),
):
    """Extract, embed, and store a DOCX in the selected squad knowledge base."""
    filename = file.filename or "knowledge-base.docx"
    if not filename.lower().endswith(".docx"):
        raise HTTPException(status_code=400, detail="Only DOCX files are supported")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="The DOCX file is empty")
    try:
        return await run_in_threadpool(ingest_docx, squad_name.strip(), filename, content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Squad Knowledge Base DOCX ingestion failed")
        raise HTTPException(status_code=502, detail=f"DOCX ingestion failed: {exc}") from exc


@router.get("/squad-knowledge-base/documents/{squad_name}")
def list_squad_knowledge_base_documents(
    squad_name: str,
    current_user=Depends(get_current_user_strict),
):
    """List distinct ingested document names for a squad."""
    squad_name = _normalize_squad_name(squad_name)
    if not squad_name:
        raise HTTPException(status_code=400, detail="Unsupported Squad Knowledge Base selection.")
    try:
        database_squads = SQUAD_DATABASE_NAMES if squad_name == "Device Squad" else (squad_name,)
        documents = postgres_client.list_documents(database_squads)
        return {"squad_name": squad_name, "documents": documents, "total": len(documents)}
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Squad Knowledge Base is unavailable.") from exc


@router.post("/brd-testcases")
@router.post("/kb-testcases")
@router.post("/squad-testcases")
def generate_brd_testcases(
    request: Request,
    text: str = Form(default=""),
    provider: str = Form(default=""),
    model_name: str = Form(default=""),
    temperature: float = Form(default=0.2),
    max_tokens: int = Form(default=4096),
    response_format: str = Form(default="text"),
    knowledge_base: str = Form(default=""),
    generation_mode: str = Form(default=""),
    files: list[UploadFile] = File(default=[]),
    current_user=Depends(get_current_user_strict),
):
    """Generate test cases from requirements text and stream them back.

    `provider` and `model_name` are accepted and ignored. They are part of the
    legacy form contract the frontend still sends, and rejecting them would
    break the tab for no gain, but the model is chosen server-side -- see
    stream_chat's docstring for why a browser-supplied model id is not honoured.

    `knowledge_base` is the Select KB choice: "Automation KB" or a squad
    (testcases.KNOWLEDGE_BASES). "Default KB" never reaches this backend on
    that path -- it goes to ai_config.BASE_URL -- so empty means no KB.

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

    kb_path = request.url.path.rstrip("/").endswith(_KB_GENERATION_PATHS)
    if knowledge_base:
        knowledge_base = _normalize_knowledge_base(knowledge_base)
    if not knowledge_base and kb_path:
        raise HTTPException(
            status_code=400,
            detail="Unsupported Knowledge Base selection. Choose one of: "
            + ", ".join(testcases.KNOWLEDGE_BASES) + ".",
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
        knowledge_base=knowledge_base,
        generation_mode=generation_mode,
        generation_provider=(
            settings.SQUAD_KB_GENERATION_PROVIDER
            if kb_path
            else None
        ),
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
