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
import json
from pathlib import Path
from threading import Lock
from itertools import chain

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import settings
from ..database.connection import get_db
from ..services.automation import applications as app_scope
from ..services.generation import azure_llm, testcases
from ..services.knowledge_base import ingestion, squads
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
# Paths that exist only to generate from a chosen Knowledge Base; a request to
# one of them without a recognised KB is refused instead of silently running
# ungrounded on a different model.
#   /kb-testcases     Automation KB or Journey KB (a squad is accepted too)
#   /squad-testcases  a registered squad only -- Device Squad KB generation
_KB_GENERATION_PATHS = ("/kb-testcases", "/squad-testcases")
SQUAD_DATABASE_NAMES = ("B2B", "BCRM", "SMB")


def _normalize_knowledge_base(value: str) -> str:
    """Any KB the Select KB dropdown offers, in its canonical spelling, or ""."""
    return testcases.normalize_knowledge_base(value)


def _normalize_squad_name(value: str) -> str:
    return squads.normalize_squad_name(value)


class SquadPayload(BaseModel):
    name: str = Field(min_length=1, max_length=80)


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
        return {"prompt": _read_figma_vlm_prompt(), "model": azure_llm.model_name()}


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
    return {"prompt": prompt, "model": azure_llm.model_name()}


@router.post("/figma/extract-text")
async def extract_figma_pdf_text(
    file: UploadFile = File(...),
    current_user=Depends(get_current_user_strict),
):
    """Extract text from a Figma PDF with the Azure OpenAI model and the saved Figma prompt."""
    filename = file.filename or "figma.pdf"
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")
    if azure_llm.missing_settings():
        raise HTTPException(
            status_code=503,
            detail="Figma extraction is not configured. Missing: " + ", ".join(azure_llm.missing_settings()),
        )

    pdf_bytes = await file.read()
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="The uploaded PDF is empty")
    if len(pdf_bytes) > 50 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="The PDF exceeds the 50 MB extraction limit")
    # A blocking model call; the pool keeps it off the event loop.
    try:
        text = await run_in_threadpool(
            azure_llm.extract_pdf_text, filename=filename, pdf_bytes=pdf_bytes, prompt=_read_figma_vlm_prompt()
        )
    except azure_llm.AzureLLMError as exc:
        raise HTTPException(status_code=502, detail=f"Figma extraction failed: {exc}") from exc

    return {"filename": filename, "text": text, "model": azure_llm.model_name()}


@router.post("/squad-knowledge-base/ingest-docx")
@router.post("/squad-knowledge-base/ingest-document")
async def ingest_squad_knowledge_base_docx(
    squad_name: str = Form(...),
    systems: list[str] = Form(default=[]),
    file: UploadFile = File(...),
    current_user=Depends(get_current_user_strict),
):
    """Extract, embed, and store DOCX, PDF or XLSX in the squad knowledge base."""
    filename = file.filename or "knowledge-base.docx"
    content = await file.read()
    try:
        ingestion.validate_document(filename, content)
        return await run_in_threadpool(ingest_docx, squad_name.strip(), filename, content, systems)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Squad Knowledge Base document ingestion failed")
        raise HTTPException(status_code=502, detail=f"Document ingestion failed: {exc}") from exc


@router.get("/squad-knowledge-base/squads")
def list_squad_knowledge_bases(current_user=Depends(get_current_user_strict)):
    """List the persisted Squad Knowledge Base names."""
    return {"squads": squads.list_squads()}


@router.post("/squad-knowledge-base/squads", status_code=201)
def add_squad_knowledge_base(
    payload: SquadPayload,
    current_user=Depends(get_current_user_strict),
):
    """Persist a new squad name and return the refreshed list."""
    try:
        updated = squads.add_squad(payload.name)
        added = next(name for name in updated if name.casefold() == " ".join(payload.name.split()).casefold())
        return {"squads": updated, "added": added}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _ingestion_event(event: dict) -> str:
    return json.dumps(event, ensure_ascii=False) + "\n"


@router.post("/squad-knowledge-base/ingest-docx-stream")
@router.post("/squad-knowledge-base/ingest-document-stream")
async def ingest_squad_knowledge_base_docx_stream(
    squad_name: str = Form(...),
    systems: list[str] = Form(default=[]),
    file: UploadFile = File(...),
    current_user=Depends(get_current_user_strict),
):
    """Stream real extraction, embedding and storage progress as NDJSON."""
    filename = file.filename or "knowledge-base.docx"
    canonical_squad = _normalize_squad_name(squad_name)
    if not canonical_squad:
        raise HTTPException(status_code=400, detail="Select a registered squad.")
    content = await file.read()
    try:
        ingestion.validate_document(filename, content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # A sync generator: StreamingResponse runs it in the thread pool, so the
    # embedding and database calls never block the event loop.
    def events():
        stage = "extract"
        try:
            for event in ingestion.ingest_docx_progress(canonical_squad, filename, content, systems):
                stage = event.get("stage", stage)
                yield _ingestion_event(event)
        except ValueError as exc:
            yield _ingestion_event({"type": "error", "stage": stage, "detail": str(exc)})
        except Exception as exc:
            logger.exception("Streamed document ingestion failed for squad=%s", canonical_squad)
            yield _ingestion_event({"type": "error", "stage": stage, "detail": f"Document ingestion failed: {exc}"})

    return StreamingResponse(events(), media_type="application/x-ndjson", headers=_STREAM_HEADERS)


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


@router.get("/target-applications")
def list_generation_applications(
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    """The applications Generate Test Cases offers: every Test Data application,
    with whether it has an Automation KB, flows, journeys, and its addresses.

    Here rather than under /automation/test-data so it needs only a login --
    the people generating test cases may not hold Automation Studio access.
    """
    return {"applications": app_scope.catalogue(db)}


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
    applications: list[str] = Form(default=[]),
    environment: str = Form(default=""),
    files: list[UploadFile] = File(default=[]),
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    """Generate test cases from requirements text and stream them back.

    `provider` and `model_name` are accepted and ignored. They are part of the
    legacy form contract the frontend still sends, and rejecting them would
    break the tab for no gain, but the model is chosen server-side -- see
    stream_chat's docstring for why a browser-supplied model id is not honoured.

    `knowledge_base` is the Select KB choice. The frontend routes it:

      Default KB      -> ai_config.BASE_URL + generateTestCases (no KB here)
      Device Squad KB -> /generate/squad-testcases, a registered squad; Azure
                         OpenAI with the team's squad prompt (testcases)
      Automation KB,
      Journey KB      -> /generate/kb-testcases; testcases.kb_generation_provider

    `applications` are the Test Data application ids chosen on the page (one
    form field per id) and `environment` the chosen environment. Grounding is
    read for those applications only, and the prompt names them with their
    addresses -- see services/automation/applications.py for why nothing is
    inferred across applications any more. The choice is optional: with none,
    generation keeps the earlier behaviour and cases are saved unlinked.

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

    path = request.url.path.rstrip("/")
    kb_path = path.endswith(_KB_GENERATION_PATHS)
    if knowledge_base:
        knowledge_base = _normalize_knowledge_base(knowledge_base)
    if path.endswith("/squad-testcases") and not testcases.is_squad(knowledge_base):
        raise HTTPException(status_code=400, detail="Unsupported Squad Knowledge Base selection.")
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

    try:
        scope = app_scope.choices(db, applications)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if scope:
        logger.info("Generating for application(s): %s", ", ".join(c.name for c in scope))

    chunks = testcases.stream_test_cases(
        requirements=text,
        applications=scope,
        application_scope=app_scope.scope_prompt(db, scope, environment),
        temperature=temperature,
        max_tokens=max_tokens,
        knowledge_base=knowledge_base,
        generation_mode=generation_mode,
        generation_provider=testcases.kb_generation_provider() if kb_path else None,
    )

    try:
        first = next(chunks, None)
    except (GenerationUnavailable, azure_llm.AzureLLMError) as exc:
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
