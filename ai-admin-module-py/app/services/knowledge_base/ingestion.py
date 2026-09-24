from __future__ import annotations

import io
import logging

from docx import Document

from ...config import settings
from . import embeddings, postgres_client

logger = logging.getLogger(__name__)


def _extract_docx_text(content: bytes) -> str:
    document = Document(io.BytesIO(content))
    blocks = []
    for paragraph in document.paragraphs:
        text = " ".join(paragraph.text.split()).strip()
        if text:
            blocks.append(text)
    for table in document.tables:
        for row in table.rows:
            cells = [" ".join(cell.text.split()).strip() for cell in row.cells]
            row_text = " | ".join(cell for cell in cells if cell)
            if row_text:
                blocks.append(row_text)
    return "\n\n".join(blocks).strip()


def _chunk_text(text: str, chunk_size: int = 1500, overlap: int = 250) -> list[str]:
    words = text.split()
    chunks: list[str] = []
    start = 0
    while start < len(words):
        end = start
        length = 0
        while end < len(words) and length + len(words[end]) + (1 if end > start else 0) <= chunk_size:
            length += len(words[end]) + (1 if end > start else 0)
            end += 1
        if end == start:
            end += 1
        chunks.append(" ".join(words[start:end]))
        if end >= len(words):
            break
        overlap_words = max(1, min(end - start - 1, overlap // 6))
        start = end - overlap_words
    return chunks


def ingest_docx(squad_name: str, document_name: str, content: bytes) -> dict[str, int | str]:
    if squad_name not in {"Device Squad", "B2B", "BCRM", "SMB"}:
        raise ValueError("Unsupported Squad Knowledge Base")
    text = _extract_docx_text(content)
    if not text:
        raise ValueError("The DOCX contains no readable text")

    chunks = _chunk_text(text)
    vectors = embeddings.embed(chunks)

    target_squads = ("B2B", "BCRM", "SMB") if squad_name == "Device Squad" else (squad_name,)
    for chunk, embedding in zip(chunks, vectors):
        for target_squad in target_squads:
            postgres_client.save_kb_entry(target_squad, document_name, chunk, embedding)

    return {
        "document_name": document_name,
        "squad_name": squad_name,
        "chunks_ingested": len(chunks),
        "embedding_model": settings.SQUAD_KB_EMBEDDING_MODEL,
    }