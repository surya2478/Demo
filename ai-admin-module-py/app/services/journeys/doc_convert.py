"""--- PDF to structured Word ------------------------------------------------------------------

A Figma export is a PDF of pictures: large, with little text, and too much for
one extraction. Converting it page by page into a Word document gives the
reviewer something readable and gives extraction a compact, text-only input:

  ai    Azure reads each page (its text, and its screenshot slices when a
        vision model is available) and writes it up as a screen: purpose,
        sections, UI elements, actions and navigation, notes.
  text  No model: each page's own text, with its picture.

The .docx is written next to the document (sources/conversions) and can be
downloaded, or added to the Knowledge Base as a document of its own and
extracted like any other. Runs in a background thread; progress lives in a
small JSON file beside the .docx so it survives a page reload.
"""
from __future__ import annotations

import io
import json
import logging
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field

from ...config import settings
from ...models.kb_changes import KbSourceDocument
from ..automation import llm
from . import documents, store

logger = logging.getLogger(__name__)

CONVERSIONS_DIR = "sources/conversions"
MODES = ("ai", "text")
PICTURE_WIDTH_PX = 1000  # pictures in the .docx: readable, and the file stays small
_running: set[int] = set()
_lock = threading.Lock()


# --- What the model returns for a page -------------------------------------------------------

class _Loose(BaseModel):
    model_config = ConfigDict(extra="ignore")


class CSection(_Loose):
    heading: str = ""
    lines: List[str] = Field(default_factory=list)


class CElement(_Loose):
    label: str = ""
    type: str = ""
    notes: str = ""


class CAction(_Loose):
    trigger: str = ""
    result: str = ""


class CPage(_Loose):
    screen_name: str = ""
    purpose: str = ""
    sections: List[CSection] = Field(default_factory=list)
    elements: List[CElement] = Field(default_factory=list)
    actions: List[CAction] = Field(default_factory=list)
    notes: List[str] = Field(default_factory=list)


SYSTEM_PROMPT = """You write up one page of an application design document (often a Figma export) as a structured description of the screen(s) it shows, for testers.

Return ONLY a JSON object:
{
  "screen_name": "the screen's title as shown, or a short descriptive name",
  "purpose": "one or two sentences: what the user does here",
  "sections": [{"heading": "area of the screen, e.g. Header, Login form, Footer", "lines": ["what is in it, top to bottom"]}],
  "elements": [{"label": "exact visible label", "type": "button|link|text field|password field|dropdown|checkbox|radio|tab|toggle|icon|image|text|table|other", "notes": "placeholder, state, validation, mandatory..."}],
  "actions": [{"trigger": "what the user does", "result": "what happens / where it goes"}],
  "notes": ["annotations, callouts, error messages, business rules written on the page"]
}

Rules:
- Copy labels exactly as written, including capitalisation and punctuation. Never invent a label you cannot read.
- When a page shows several screens or states, describe each as its own section and say which state it is.
- Read the screenshots for labels the page text does not contain; if something is unreadable, say so in notes.
- Empty lists are fine. No prose outside the JSON."""


# --- Files and state -------------------------------------------------------------------------

def _paths(kb: store.JourneyKB, doc: KbSourceDocument) -> Dict[str, Path]:
    base = Path(kb.directory) / CONVERSIONS_DIR
    stem = Path(doc.stored_as).stem
    return {"docx": base / f"{stem}.structured.docx", "state": base / f"{stem}.convert.json"}


def docx_name(doc: KbSourceDocument) -> str:
    return f"{Path(doc.filename).stem} (structured).docx"


def state(kb: store.JourneyKB, doc: KbSourceDocument) -> Dict[str, Any]:
    paths = _paths(kb, doc)
    try:
        data = json.loads(paths["state"].read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"status": "none"}
    if data.get("status") == "running" and doc.id not in _running:
        # The backend restarted mid-way: the thread is gone.
        data.update(status="failed", error="Stopped when the backend restarted; convert again.")
    data["ready"] = data.get("status") == "done" and paths["docx"].exists()
    return data


def _save(kb: store.JourneyKB, doc: KbSourceDocument, data: Dict[str, Any]) -> None:
    path = _paths(kb, doc)["state"]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1), encoding="utf-8")


def docx_bytes(kb: store.JourneyKB, doc: KbSourceDocument) -> bytes:
    path = _paths(kb, doc)["docx"]
    if not path.exists():
        raise documents.DocumentError("This document has not been converted yet.")
    return path.read_bytes()


# --- Reading a page --------------------------------------------------------------------------

def _structure(kb: store.JourneyKB, doc: KbSourceDocument, page: Dict[str, Any], total: int,
               vision: Optional[str]) -> CPage:
    user = (f"DOCUMENT: {doc.filename}, page {page['page']} of {total}\n"
            + ("The page's screenshot is attached; a tall page comes as several slices, top to bottom.\n" if vision
               else "No screenshot is available: only the page text below. Do not guess what a picture shows.\n")
            + "PAGE TEXT:\n" + llm.wrap_user_content(page["text"] or "(no text on this page)"))
    timeout = float(settings.JOURNEY_EXTRACTION_TIMEOUT_SECONDS or 300)
    if vision and vision.startswith("azure"):
        return llm.complete_json_with_images(system_prompt=SYSTEM_PROMPT, user_input=user, model_cls=CPage,
                                             images=documents.page_images(kb, doc, page["page"]), model=vision,
                                             timeout=timeout, max_tokens=8000, provider="azure")
    if vision:
        return llm.complete_json_with_images(system_prompt=SYSTEM_PROMPT, user_input=user, model_cls=CPage,
                                             images=[documents.page_png(kb, doc, page["page"], zoom=1.2)],
                                             model=vision, timeout=timeout, max_tokens=8000)
    return llm.complete_json(system_prompt=SYSTEM_PROMPT, user_input=user, model_cls=CPage, timeout=timeout,
                             max_tokens=8000, provider=documents.text_provider())


def _pictures(kb: store.JourneyKB, doc: KbSourceDocument, page: int) -> List[bytes]:
    try:
        import pymupdf
    except ImportError:
        import fitz as pymupdf  # type: ignore
    pdf = documents._open_pdf(documents.document_path(kb, doc).read_bytes())
    pg = pdf[page - 1]
    rect = pg.rect
    zoom = min(PICTURE_WIDTH_PX / max(rect.width, 1), 2.0)
    # Same slicing as extraction, so a tall Figma page stays legible in Word.
    slice_h = rect.width * documents.SLICE_RATIO
    count = max(1, min(documents.MAX_SLICES * 2, int(-(-rect.height // slice_h))))
    step = rect.height / count
    out = []
    for i in range(count):
        clip = pymupdf.Rect(rect.x0, rect.y0 + i * step, rect.x1, rect.y0 + (i + 1) * step)
        out.append(pg.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=clip, alpha=False).tobytes("jpeg", jpg_quality=70))
    return out


# --- Writing the .docx -----------------------------------------------------------------------

def _bullets(document, lines: List[str]) -> None:
    for line in lines:
        if line and line.strip():
            document.add_paragraph(line.strip(), style="List Bullet")


def _table(document, headers: List[str], rows: List[List[str]]) -> None:
    table = document.add_table(rows=1, cols=len(headers))
    table.style = "Table Grid"
    for cell, text in zip(table.rows[0].cells, headers):
        cell.text = text
        for run in cell.paragraphs[0].runs:
            run.bold = True
    for row in rows:
        cells = table.add_row().cells
        for cell, text in zip(cells, row):
            cell.text = text or ""


def build_docx(doc: KbSourceDocument, pages: List[Dict[str, Any]], *, mode: str, model: Optional[str],
               images: bool, pictures: Dict[int, List[bytes]]) -> bytes:
    from docx import Document
    from docx.shared import Inches, Pt

    out = Document()
    out.styles["Normal"].font.size = Pt(10)
    out.add_heading(f"{Path(doc.filename).stem} — structured", level=0)
    out.add_paragraph(
        f"Converted from {doc.filename} ({len(pages)} page{'s' if len(pages) != 1 else ''}) on "
        f"{datetime.now().strftime('%Y-%m-%d %H:%M')}. "
        + (f"Each page was read by {model} and written up as a screen." if mode == "ai"
           else "Each page's own text, as written; no model was used.")
    )

    if mode == "ai":
        out.add_heading("Screens in this document", level=1)
        _table(out, ["Page", "Screen", "Purpose"],
               [[str(p["page"]), p["structured"].screen_name, p["structured"].purpose] for p in pages])

    for p in pages:
        s: Optional[CPage] = p.get("structured")
        title = (s.screen_name if s and s.screen_name else (p["text"].strip().splitlines() or [""])[0][:80])
        out.add_heading(f"Page {p['page']}" + (f" · {title}" if title else ""), level=1)
        if s is not None:
            if s.purpose:
                out.add_paragraph(s.purpose)
            for section in s.sections:
                if section.heading:
                    out.add_heading(section.heading, level=2)
                _bullets(out, section.lines)
            if s.elements:
                out.add_heading("UI elements", level=2)
                _table(out, ["Label", "Type", "Notes"], [[e.label, e.type, e.notes] for e in s.elements])
            if s.actions:
                out.add_heading("Actions and navigation", level=2)
                _bullets(out, [f"{a.trigger} → {a.result}" if a.result else a.trigger for a in s.actions])
            if s.notes:
                out.add_heading("Notes", level=2)
                _bullets(out, s.notes)
        else:
            lines = [line.strip() for line in (p["text"] or "").splitlines() if line.strip()]
            if lines:
                out.add_heading("Text on the page", level=2)
                for line in lines:
                    out.add_paragraph(line)
            else:
                out.add_paragraph("(no text on this page)")
        if images and pictures.get(p["page"]):
            out.add_heading("Page picture", level=2)
            for picture in pictures[p["page"]]:
                out.add_picture(io.BytesIO(picture), width=Inches(6))
    buffer = io.BytesIO()
    out.save(buffer)
    return buffer.getvalue()


# --- Running a conversion --------------------------------------------------------------------

def start(kb: store.JourneyKB, doc: KbSourceDocument, *, mode: str, images: bool) -> Dict[str, Any]:
    if mode not in MODES:
        raise documents.DocumentError(f"Mode must be one of {', '.join(MODES)}.")
    if documents._file_type(doc.filename) != "pdf":
        raise documents.DocumentError("Only a PDF can be converted to Word; this is already a Word document.")
    with _lock:
        if doc.id in _running:
            raise documents.DocumentError("This document is already being converted.")
        _running.add(doc.id)
    data = {"status": "running", "mode": mode, "images": images, "page": 0, "pages": doc.pages or 0,
            "started_at": datetime.utcnow().isoformat(timespec="seconds"), "error": None}
    _save(kb, doc, data)
    threading.Thread(target=_run, args=(doc.id, mode, images), name=f"kb-convert-{doc.id}", daemon=True).start()
    return state(kb, doc)


def _run(doc_id: int, mode: str, images: bool) -> None:
    from ...database.connection import SessionLocal

    db = SessionLocal()
    data: Dict[str, Any] = {}
    kb = doc = None
    try:
        doc = db.get(KbSourceDocument, doc_id)
        kb = store.load(doc.app_id)
        data = state(kb, doc) | {"status": "running"}
        vision = documents.vision_model() if mode == "ai" else None
        model = (vision or documents.text_model()) if mode == "ai" else None
        pages = documents.read_pages(kb, doc)
        data.update(pages=len(pages), model=model)
        pictures: Dict[int, List[bytes]] = {}
        for page in pages:
            if mode == "ai":
                page["structured"] = _structure(kb, doc, page, len(pages), vision)
            if images:
                pictures[page["page"]] = _pictures(kb, doc, page["page"])
            data["page"] = page["page"]
            _save(kb, doc, data)
        blob = build_docx(doc, pages, mode=mode, model=model, images=images, pictures=pictures)
        path = _paths(kb, doc)["docx"]
        path.write_bytes(blob)
        data.update(status="done", size_bytes=len(blob), finished_at=datetime.utcnow().isoformat(timespec="seconds"),
                    filename=docx_name(doc))
    except (documents.DocumentError, llm.LLMError) as exc:
        data.update(status="failed", error=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("Converting document %s to Word failed", doc_id)
        data.update(status="failed", error=f"Conversion failed: {exc}")
    finally:
        try:
            if kb is not None and doc is not None:
                data.pop("ready", None)
                _save(kb, doc, data)
        finally:
            with _lock:
                _running.discard(doc_id)
            db.close()
