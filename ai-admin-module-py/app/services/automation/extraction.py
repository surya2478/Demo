"""
--- Automation Module: document text extraction ------------------------------

Turns an uploaded BRD, SRD or test case document into text the rest of the
module can read. One job, no knowledge of batches or test cases.

Ported from the Test Automation Studio's document_service, with two changes
that the difference in architecture forces:

  * synchronous. This backend has no Celery worker, so extraction happens
    inline on the upload request. That is why MAX_EXTRACT_BYTES exists -- a
    200MB PDF would otherwise hold a request thread for minutes.
  * every parser is imported lazily. A backend that never receives a PDF never
    pays PyMuPDF's import cost, and a missing library reports itself against
    the format that needed it rather than breaking startup for everything.

Extracted text is treated as hostile. It reaches an LLM prompt later, and a
requirements document is exactly the kind of file someone can put instructions
inside -- see sanitize().
"""
from __future__ import annotations

import io
import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)

# Extension -> canonical type. The upload path decides by extension and then
# confirms against the file's own magic bytes, because an extension is a claim
# made by whoever named the file.
EXTENSION_TYPES = {
    ".pdf": "pdf",
    ".docx": "docx",
    ".xlsx": "xlsx",
    ".csv": "csv",
    ".txt": "txt",
    ".md": "md",
}

SUPPORTED_TYPES = tuple(sorted(set(EXTENSION_TYPES.values())))

# Extraction happens inline on the request thread, so this is a latency bound
# as much as a memory one.
MAX_EXTRACT_BYTES = 25 * 1024 * 1024

# Past this the text is truncated rather than rejected: a 300-page SRD is a
# real thing to upload, and the first slice of it is still worth reading.
MAX_TEXT_CHARS = 400_000


class ExtractionError(Exception):
    """The file could not be turned into text. The message is user-facing."""


def type_for_filename(filename: str | None) -> str | None:
    """Canonical type for a filename, or None when the extension is unknown."""
    if not filename:
        return None
    return EXTENSION_TYPES.get(Path(filename).suffix.lower())


def validate_signature(file_type: str, head: bytes) -> None:
    """Check the file's leading bytes against the type its name claims.

    Cheap defence against a mislabelled upload reaching a parser that will
    misbehave on it. Text formats are not checked -- anything decodes as text,
    so there is no signature to compare.
    """
    if file_type == "pdf" and not head.startswith(b"%PDF-"):
        raise ExtractionError("This file is named .pdf but its contents are not a PDF.")
    if file_type in {"docx", "xlsx"} and not head.startswith(
        (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")
    ):
        raise ExtractionError(
            f"This file is named .{file_type} but its contents are not an Office "
            "document. Office files are zip archives; this one is not."
        )


# Lines that try to talk to the model rather than describe the system. Matched
# on the extracted text before it is ever put in a prompt. Neutralised in place
# rather than dropped, so a reviewer reading the intake can see what was in the
# document and why a line looks odd.
_INJECTION_PATTERNS = (
    r"ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions",
    r"disregard\s+(?:all\s+)?(?:previous|prior|above)",
    r"you\s+are\s+now\s+(?:a|an)\s+",
    r"system\s*prompt\s*[:=]",
    r"</?\s*(?:system|user_content|assistant)\s*>",
    r"forget\s+(?:everything|all)\s+(?:you|above)",
)

_INJECTION_RE = re.compile("|".join(_INJECTION_PATTERNS), re.IGNORECASE)


def sanitize(text: str) -> str:
    """Defang instruction-shaped lines and normalise whitespace.

    This is the second layer, not the only one: prompts that consume this text
    also fence it in <user_content> and tell the model the contents are data.
    Neither measure is sufficient alone.
    """
    if not text:
        return ""

    text = text.replace("\x00", "")
    text = _INJECTION_RE.sub("[redacted instruction-like text]", text)
    # Collapse the runs of blank lines that PDF extraction leaves behind.
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    text = "\n".join(line.rstrip() for line in text.splitlines())

    if len(text) > MAX_TEXT_CHARS:
        logger.warning("Extracted text truncated from %d to %d chars", len(text), MAX_TEXT_CHARS)
        text = text[:MAX_TEXT_CHARS] + "\n\n[Document truncated at the extraction limit.]"

    return text.strip()


# ── Per-format parsers ───────────────────────────────────────────────────────

def _extract_pdf(contents: bytes) -> tuple[str, int | None]:
    try:
        import fitz
    except ImportError as exc:
        raise ExtractionError(
            "PDF support needs PyMuPDF, which is not installed on this backend."
        ) from exc

    try:
        with fitz.open(stream=contents, filetype="pdf") as doc:
            if doc.needs_pass:
                raise ExtractionError("This PDF is password-protected.")
            pages = [page.get_text() for page in doc]
            return "\n\n".join(pages), len(pages)
    except ExtractionError:
        raise
    except Exception as exc:
        raise ExtractionError(f"This PDF could not be read: {exc}") from exc


def _extract_docx(contents: bytes) -> tuple[str, int | None]:
    try:
        from docx import Document
    except ImportError as exc:
        raise ExtractionError(
            "DOCX support needs python-docx, which is not installed on this backend."
        ) from exc

    try:
        doc = Document(io.BytesIO(contents))
    except Exception as exc:
        raise ExtractionError(f"This Word document could not be read: {exc}") from exc

    parts = [p.text for p in doc.paragraphs if p.text and p.text.strip()]

    # Tables carry the substance in most test case and requirements documents,
    # and python-docx keeps them out of .paragraphs entirely. Skipping them is
    # how a document extracts "successfully" as an almost empty string.
    for table in doc.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells]
            if any(cells):
                parts.append(" | ".join(cells))

    return "\n\n".join(parts), None


def _extract_xlsx(contents: bytes) -> tuple[str, int | None]:
    # 1. Try pandas first
    try:
        import pandas as pd

        book = pd.ExcelFile(io.BytesIO(contents))
        sheets = []
        for name in book.sheet_names:
            frame = book.parse(name).fillna("")
            if frame.empty:
                continue
            sheets.append(f"## Sheet: {name}\n{frame.to_string(index=False)}")
        return "\n\n".join(sheets), len(book.sheet_names)
    except Exception:
        pass

    # 2. Fallback to openpyxl
    try:
        import openpyxl

        wb = openpyxl.load_workbook(io.BytesIO(contents), data_only=True)
        sheets = []
        for name in wb.sheetnames:
            sheet = wb[name]
            rows = []
            for row in sheet.iter_rows(values_only=True):
                cleaned = [str(c).strip() if c is not None else "" for c in row]
                if any(cleaned):
                    rows.append(" | ".join(cleaned))
            if rows:
                sheets.append(f"## Sheet: {name}\n" + "\n".join(rows))
        return "\n\n".join(sheets), len(wb.sheetnames)
    except Exception as exc:
        raise ExtractionError(f"This spreadsheet could not be read: {exc}") from exc


def _extract_text_file(contents: bytes) -> tuple[str, int | None]:
    for encoding in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            return contents.decode(encoding), None
        except UnicodeDecodeError:
            continue
    return contents.decode("utf-8", errors="replace"), None


_PARSERS = {
    "pdf": _extract_pdf,
    "docx": _extract_docx,
    "xlsx": _extract_xlsx,
    "csv": _extract_text_file,
    "txt": _extract_text_file,
    "md": _extract_text_file,
}


def extract_text(contents: bytes, file_type: str) -> tuple[str, int | None]:
    """Extract sanitized text from a document's bytes.

    Returns (text, page_count). page_count is None for formats that have no
    meaningful page concept.
    """
    if len(contents) > MAX_EXTRACT_BYTES:
        raise ExtractionError(
            f"This file is {len(contents) / 1_048_576:.1f}MB, over the "
            f"{MAX_EXTRACT_BYTES // 1_048_576}MB extraction limit."
        )

    parser = _PARSERS.get(file_type)
    if parser is None:
        raise ExtractionError(
            f"{file_type!r} is not a format this intake reads. Supported: "
            + ", ".join(SUPPORTED_TYPES)
        )

    text, pages = parser(contents)
    return sanitize(text), pages


# ── Tabular rows, for documents that hold test cases ─────────────────────────

def extract_rows(contents: bytes, file_type: str) -> list[dict[str, str]]:
    """Pull a document's tabular content out as header-keyed rows.

    Only meaningful for documents that hold a table of test cases. The caller
    maps these headers onto real columns -- this function has no opinion about
    what any header means, which is what keeps the alias table in one place in
    the router rather than duplicated here.

    Returns [] when the document has no table, which is the normal outcome for
    a BRD and not an error.
    """
    if file_type == "csv":
        import csv as csv_module

        text, _ = _extract_text_file(contents)
        reader = csv_module.DictReader(io.StringIO(text))
        return [
            {(k or "").strip(): (v or "").strip() for k, v in row.items() if k}
            for row in reader
        ]

    if file_type == "xlsx":
        import pandas as pd

        try:
            book = pd.ExcelFile(io.BytesIO(contents))
        except Exception as exc:
            raise ExtractionError(f"This spreadsheet could not be read: {exc}") from exc

        rows: list[dict[str, str]] = []
        for name in book.sheet_names:
            frame = book.parse(name).fillna("")
            for record in frame.to_dict(orient="records"):
                row = {
                    str(key).strip(): str(value).strip()
                    for key, value in record.items()
                    if str(key).strip() and not str(key).startswith("Unnamed:")
                }
                if any(row.values()):
                    rows.append(row)
        return rows

    if file_type == "docx":
        try:
            from docx import Document
        except ImportError as exc:
            raise ExtractionError(
                "DOCX support needs python-docx, which is not installed."
            ) from exc

        doc = Document(io.BytesIO(contents))
        rows = []
        for table in doc.tables:
            if len(table.rows) < 2:
                continue
            headers = [c.text.strip() for c in table.rows[0].cells]
            if not any(headers):
                continue
            for row in table.rows[1:]:
                cells = [c.text.strip() for c in row.cells]
                if not any(cells):
                    continue
                rows.append(
                    {h: (cells[i] if i < len(cells) else "") for i, h in enumerate(headers) if h}
                )
        return rows

    # PDF, TXT and MD have no reliable table structure to recover.
    return []
