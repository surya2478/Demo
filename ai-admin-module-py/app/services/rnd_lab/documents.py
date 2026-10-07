"""
--- AI R&D Lab: study documents --------------------------------------------------

Two kinds of source land here. Linked documents are the BRD text already saved
with each case's review request -- snapshotted into the study so an analysis
can be reproduced. Uploads are anything the platform does not have yet: Figma
exports, SRDs, API specs.

Large design files are the reason this is shaped the way it is. A Figma PDF
export of 25MB is ordinary, and sending it whole to a vision model fails: base64
makes it ~33MB on the wire, over what the endpoint accepts, and one call over a
hundred frames loses most of them. So:

  1. The upload is streamed to disk, never held in memory or the database.
  2. Reading happens in a background thread, not on the request.
  3. A PDF's own text layer is read first, page by page -- Figma exports keep
     most labels as real text, and that costs nothing.
  4. Only pages with too little text (frames that are pictures) go to the
     vision model, a few pages per call, each chunk re-rendered smaller when it
     is still over RND_LAB_VISION_MAX_CHUNK_MB.

Every page's text is written with a "=== Page N ===" marker, which is what lets
a mapping cite "Figma p.7" and lets the Lab check that the citation exists.
"""
from __future__ import annotations

import hashlib
import logging
import re
import threading
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from ...config import settings
from ...database.connection import SessionLocal
from ...models.rnd_lab import RndDocument
from ..automation import extraction
from ..automation import workspace as ws

logger = logging.getLogger(__name__)

ROLES = ("brd", "figma", "srd", "api_spec", "other")
IMAGE_TYPES = {".png": "png", ".jpg": "jpg", ".jpeg": "jpg"}
MAX_TEXT_CHARS = 600_000
MAX_PDF_PAGES = 400
# Below this many characters a design page is treated as a picture.
THIN_PAGE_CHARS = 40

PAGE_MARK = re.compile(r"^=== Page (\d+) ===$", re.M)


def storage_dir(study_id: int) -> Path:
    path = ws.storage_root() / "rnd_lab" / str(study_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _relative(path: Path) -> str:
    return str(path.relative_to(ws.storage_root())).replace("\\", "/")


def resolve(relative: Optional[str]) -> Optional[Path]:
    if not relative:
        return None
    root = ws.storage_root().resolve()
    path = (root / relative).resolve()
    return path if root in path.parents else None


def file_type_for(filename: str) -> Optional[str]:
    suffix = Path(filename or "").suffix.lower()
    return IMAGE_TYPES.get(suffix) or extraction.type_for_filename(filename)


def read_text(doc: RndDocument) -> str:
    path = resolve(doc.text_path)
    if path is None or not path.exists():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")


def pages_of(text: str) -> List[Tuple[Optional[int], str]]:
    """(page, text) pieces of a stored text; one unnumbered piece when it has no markers."""
    marks = list(PAGE_MARK.finditer(text))
    if not marks:
        return [(None, text)]
    out = []
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        out.append((int(m.group(1)), text[m.end():end].strip()))
    return out


def detail(doc: RndDocument) -> Dict:
    return {
        "id": doc.id, "role": doc.role, "origin": doc.origin, "origin_request_id": doc.origin_request_id,
        "filename": doc.filename, "file_type": doc.file_type, "size_bytes": doc.size_bytes,
        "page_count": doc.page_count, "text_chars": doc.text_chars, "status": doc.status,
        "notes": [n for n in doc.notes or [] if not str(n).startswith("sha1:")], "error": doc.error,
        "created_by": doc.created_by, "created_at": doc.created_at.isoformat() if doc.created_at else None,
    }


# --- Linked BRDs ------------------------------------------------------------------

def _write_text(study_id: int, stem: str, text: str) -> Tuple[str, int]:
    text = extraction.sanitize(text)[:MAX_TEXT_CHARS]
    path = storage_dir(study_id) / f"{stem}.txt"
    path.write_text(text, encoding="utf-8")
    return _relative(path), len(text)


def sync_linked(db: Session, study_id: int, linked: Dict[str, List[Dict[str, str]]], username: Optional[str]) -> int:
    """Snapshot each request's BRD text into the study. Returns how many were added."""
    # Keyed by content: the same BRD regenerated under several requests is one source.
    existing = {(d.notes or [None])[0] for d in
                db.query(RndDocument).filter(RndDocument.study_id == study_id, RndDocument.origin == "linked")}
    added = 0
    for request_id, docs in linked.items():
        for item in docs:
            digest = "sha1:" + hashlib.sha1(item["content"].encode("utf-8")).hexdigest()
            if digest in existing:
                continue
            existing.add(digest)
            doc = RndDocument(study_id=study_id, role="brd", origin="linked", origin_request_id=request_id,
                              filename=item["name"][:255], file_type="text", status="ready", created_by=username,
                              notes=[digest])
            db.add(doc)
            db.flush()
            doc.text_path, doc.text_chars = _write_text(study_id, f"linked-{doc.id}", item["content"])
            doc.size_bytes = len(item["content"].encode("utf-8"))
            added += 1
    db.commit()
    return added


# --- Uploads ----------------------------------------------------------------------

class UploadError(Exception):
    pass


def max_upload_bytes() -> int:
    return max(1, settings.RND_LAB_MAX_UPLOAD_MB) * 1024 * 1024


def store_upload(db: Session, study_id: int, role: str, filename: str, stream, username: Optional[str]) -> RndDocument:
    """Stream an upload to disk in 1MB pieces, refusing it once it passes the limit."""
    if role not in ROLES:
        raise UploadError(f"Unknown role {role!r}. Use one of: {', '.join(ROLES)}.")
    file_type = file_type_for(filename)
    if file_type is None:
        raise UploadError("Supported: PDF, PNG/JPG (design frames), DOCX, XLSX, CSV, TXT, MD. "
                          "A .fig file cannot be read -- export the frames from Figma as PDF or PNG.")
    doc = RndDocument(study_id=study_id, role=role, origin="upload", filename=filename[:255],
                      file_type=file_type, status="stored", created_by=username)
    db.add(doc)
    db.flush()
    target = storage_dir(study_id) / f"upload-{doc.id}{Path(filename).suffix.lower()}"
    limit, size = max_upload_bytes(), 0
    try:
        with target.open("wb") as out:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > limit:
                    raise UploadError(f"This file is over the {settings.RND_LAB_MAX_UPLOAD_MB}MB upload limit.")
                out.write(chunk)
        with target.open("rb") as handle:
            head = handle.read(16)
        if file_type in extraction.SUPPORTED_TYPES:
            extraction.validate_signature(file_type, head)
    except Exception:
        db.rollback()
        target.unlink(missing_ok=True)
        raise
    doc.size_bytes = size
    doc.stored_path = _relative(target)
    db.commit()
    return doc


def delete(db: Session, doc: RndDocument) -> None:
    for rel in (doc.stored_path, doc.text_path):
        path = resolve(rel)
        if path is not None:
            path.unlink(missing_ok=True)
    db.delete(doc)
    db.commit()


# --- Reading ----------------------------------------------------------------------

def vision_available() -> bool:
    try:
        from ..generation import azure_llm

        return not azure_llm.missing_settings()
    except Exception:  # noqa: BLE001
        return False


def _fitz():
    try:
        import pymupdf as fitz
    except ImportError:
        import fitz  # type: ignore
    return fitz


def _vision_text(fitz, pdf, pages: List[int], filename: str) -> Dict[int, str]:
    """Read picture-only pages with the Figma vision model, a few pages per call."""
    from ..generation import azure_llm
    from ...routers.generate import _read_figma_vlm_prompt

    per_call = max(1, settings.RND_LAB_VISION_PAGES_PER_CALL)
    cap = max(1, settings.RND_LAB_VISION_MAX_CHUNK_MB) * 1024 * 1024
    prompt = (_read_figma_vlm_prompt() + "\n\nThe pages are given in order. Start each page's text with a line "
              "'=== Page N ===' using the page numbers: " )
    out: Dict[int, str] = {}
    for start in range(0, len(pages), per_call):
        group = pages[start:start + per_call]
        chunk = fitz.open()
        for page_no in group:
            chunk.insert_pdf(pdf, from_page=page_no - 1, to_page=page_no - 1)
        data = chunk.tobytes(garbage=3, deflate=True)
        zoom = 1.0
        while len(data) > cap and zoom > 0.3:
            # Re-render as JPEG pictures, smaller each pass, until the chunk fits.
            smaller = fitz.open()
            for page_no in group:
                src = pdf[page_no - 1]
                pix = src.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
                page = smaller.new_page(width=src.rect.width, height=src.rect.height)
                page.insert_image(page.rect, stream=pix.tobytes("jpeg"))
            data = smaller.tobytes(garbage=3, deflate=True)
            zoom -= 0.25
        reply = azure_llm.extract_pdf_text(filename=filename, pdf_bytes=data,
                                           prompt=prompt + ", ".join(str(p) for p in group))
        pieces = pages_of(reply)
        if len(pieces) == 1 and pieces[0][0] is None:
            out[group[0]] = reply.strip()  # unmarked reply: attribute to the chunk's first page
        else:
            for page_no, text in pieces:
                if page_no in group:
                    out[page_no] = text
    return out


def _read_pdf(path: Path, doc: RndDocument, notes: List[str]) -> Tuple[str, int]:
    fitz = _fitz()
    pdf = fitz.open(str(path))
    if pdf.needs_pass:
        raise extraction.ExtractionError("This PDF is password-protected.")
    count = len(pdf)
    if count > MAX_PDF_PAGES:
        notes.append(f"Only the first {MAX_PDF_PAGES} of {count} pages were read.")
    pages = {i + 1: pdf[i].get_text().strip() for i in range(min(count, MAX_PDF_PAGES))}
    thin = [p for p, t in pages.items() if len(t) < THIN_PAGE_CHARS]
    if doc.role == "figma" and thin:
        if vision_available():
            notes.append(f"{len(thin)} picture-only page(s) read with the vision model.")
            try:
                for page_no, text in _vision_text(fitz, pdf, thin, doc.filename).items():
                    pages[page_no] = text
            except Exception as exc:  # noqa: BLE001 - keep the text layer we have
                logger.warning("Vision read failed for %s", doc.filename, exc_info=True)
                notes.append(f"The vision model could not read them: {str(exc)[:200]}")
        else:
            notes.append(f"{len(thin)} page(s) have no text layer and no vision model is configured "
                         "(AZURE_OPENAI_*); their content is not in the study.")
    text = "\n\n".join(f"=== Page {p} ===\n{t}" for p, t in sorted(pages.items()))
    return text, count


def _read_image(path: Path, doc: RndDocument, notes: List[str]) -> Tuple[str, int]:
    if not vision_available():
        raise extraction.ExtractionError("A design picture needs the vision model (AZURE_OPENAI_*), which is not configured.")
    fitz = _fitz()
    img = fitz.open(str(path))
    pdf = fitz.open("pdf", img.convert_to_pdf())
    text = _vision_text(fitz, pdf, [1], doc.filename).get(1, "")
    notes.append("Read with the vision model.")
    return f"=== Page 1 ===\n{text}", 1


def extract(db: Session, doc: RndDocument) -> None:
    path = resolve(doc.stored_path)
    if path is None or not path.exists():
        raise extraction.ExtractionError("The uploaded file is missing from storage.")
    notes: List[str] = []
    if doc.file_type == "pdf":
        text, pages = _read_pdf(path, doc, notes)
    elif doc.file_type in ("png", "jpg"):
        text, pages = _read_image(path, doc, notes)
    else:
        text, pages = extraction.extract_text(path.read_bytes(), doc.file_type)
    if len(text) > MAX_TEXT_CHARS:
        notes.append(f"Text truncated to {MAX_TEXT_CHARS:,} characters.")
    doc.text_path, doc.text_chars = _write_text(doc.study_id, f"upload-{doc.id}", text)
    doc.page_count = pages
    doc.notes = notes
    if not (text or "").strip():
        raise extraction.ExtractionError("No readable text was found in this file.")


def _run(doc_id: int) -> None:
    db = SessionLocal()
    try:
        doc = db.get(RndDocument, doc_id)
        if doc is None:
            return
        try:
            extract(db, doc)
            doc.status, doc.error = "ready", None
        except Exception as exc:  # noqa: BLE001 - reported on the document
            logger.warning("R&D Lab extraction failed for document %s", doc_id, exc_info=True)
            doc.status, doc.error = "failed", str(exc)[:1000]
        db.commit()
    finally:
        db.close()


def start_extraction(db: Session, doc: RndDocument) -> None:
    doc.status, doc.error = "extracting", None
    db.commit()
    threading.Thread(target=_run, args=(doc.id,), daemon=True, name=f"rnd-doc-{doc.id}").start()


def sweep_stuck(db: Session, study_id: int) -> None:
    """A restart loses the reading thread; say so instead of spinning forever."""
    live = {t.name for t in threading.enumerate()}
    for doc in db.query(RndDocument).filter(RndDocument.study_id == study_id, RndDocument.status == "extracting"):
        if f"rnd-doc-{doc.id}" not in live:
            doc.status, doc.error = "failed", "Reading was interrupted (the server restarted). Retry it."
    db.commit()
