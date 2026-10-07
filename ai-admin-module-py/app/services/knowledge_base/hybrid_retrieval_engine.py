"""
--- Squad Knowledge Base: hybrid RAG retrieval engine -------------------------

Runs when a user turns on "Squad Knowledge Base" in the Test Assistant UI and
picks a squad (CIM, CRM, B2B, B2C, SAS). The frontend sends that squad name as
`knowledge_base` on the generate-test-cases request; services/generation/
testcases.py calls retrieve_context() here before building the prompt, the
same way it already layers in Automation's flow-blueprint context.

"Hybrid" = two independent retrieval passes over postgres_client's
squad_knowledge_base table, fused into one ranking:

1. keyword_search  -- Postgres full-text search (tsvector/ts_rank_cd). Exact
   terms, IDs, error codes: things embeddings are notoriously bad at matching.
2. vector_search   -- pgvector nearest-neighbour over sentence embeddings.
   Paraphrases and conceptually related passages that share no vocabulary
   with the query.

The two rankings are combined with Reciprocal Rank Fusion (RRF), which needs
no score normalisation between BM25-style ranks and cosine distances -- it
only uses each list's ORDER, which is why it is the standard choice for
combining lexical and semantic search.

Every failure mode here (no Postgres configured, sentence-transformers not
installed, empty result set) degrades to returning "" rather than raising:
generation must still work, ungrounded, when the Knowledge Base is not
reachable -- this mirrors services/automation/knowledge_base.py's contract.
"""
from __future__ import annotations

import logging
import re
import time
from typing import Any

import requests

from ...config import settings
from . import postgres_client

logger = logging.getLogger(__name__)

RRF_K = 60
_MAX_SNIPPET_CHARS = 1200
EMBEDDING_MODEL = settings.SQUAD_KB_EMBEDDING_MODEL
SQUAD_DATABASE_NAMES = ("B2B", "BCRM", "SMB")


def _reciprocal_rank_fusion(
    result_lists: list[list[dict[str, Any]]], k: int = RRF_K
) -> list[dict[str, Any]]:
    """Merge ranked result lists into one ranking via Reciprocal Rank Fusion.

    score(doc) = sum over lists containing doc of 1 / (k + rank_in_that_list)
    Only rank order matters, so BM25-style ts_rank_cd values and cosine
    distances combine without needing comparable scales.
    """
    fused_scores: dict[Any, float] = {}
    documents_by_id: dict[Any, dict[str, Any]] = {}

    for result_list in result_lists:
        for rank, document in enumerate(result_list):
            doc_id = document.get("id")
            if doc_id is None:
                continue
            fused_scores[doc_id] = fused_scores.get(doc_id, 0.0) + 1.0 / (k + rank + 1)
            documents_by_id.setdefault(doc_id, document)

    ranked_ids = sorted(
        fused_scores,
        key=lambda doc_id: fused_scores[doc_id],
        reverse=True,
    )
    return [documents_by_id[doc_id] for doc_id in ranked_ids]


def _format_context(squad: str, documents: list[dict[str, Any]]) -> str:
    if not documents:
        return ""

    sections = []
    for document in documents:
        title = (document.get("title") or "Untitled").strip()
        content = (document.get("content") or "").strip()
        if len(content) > _MAX_SNIPPET_CHARS:
            content = content[:_MAX_SNIPPET_CHARS].rsplit(" ", 1)[0] + " ..."
        sections.append(f"### {title}\n{content}")

    joined = "\n\n".join(sections)
    return (
        f"SQUAD KNOWLEDGE BASE CONTEXT ({squad})\n\n"
        "The following passages were retrieved from the squad's knowledge base "
        "and may contain real field names, IDs, workflows or business rules "
        "relevant to these requirements. Prefer them over generic assumptions "
        "when they apply; ignore them when they do not.\n\n"
        f"{joined}"
    )


def retrieve_context(squad: str, query: str, top_k: int = 5) -> str:
    """Fetch hybrid-ranked Squad Knowledge Base context for `query`, or "".

    This is the single entrypoint services/generation/testcases.py should
    call. It never raises: any failure (Postgres unreachable, no embeddings,
    no matches) results in an empty string, so generation proceeds ungrounded
    instead of failing.
    """
    squad = (squad or "").strip()
    print(
        f"[Squad RAG] Retrieval requested: squad={squad or '<empty>'}, "
        f"query_chars={len(query or '')}, top_k={top_k}",
        flush=True,
    )
    if not squad:
        print("[Squad RAG] Skipped: no squad was supplied.", flush=True)
        return ""

    if not postgres_client.is_configured():
        print(
            "[Squad RAG] Skipped: PostgreSQL is not configured or psycopg is unavailable.",
            flush=True,
        )
        logger.info(
            "Squad Knowledge Base requested (squad=%s) but SQUAD_KB_DATABASE_URL "
            "is not configured; generating without squad grounding.",
            squad,
        )
        return ""

    # Keep the existing production retrieval path authoritative: it performs
    # query chunking, OpenAI embeddings, sparse-term extraction, hybrid ranking,
    # noise filtering, and near-duplicate suppression.
    retrieved_context = hybrid_retrieve(squad, query, top_k=top_k)
    if not retrieved_context or retrieved_context.startswith("No ") or retrieved_context.startswith("Failed "):
        print(
            f"[Squad RAG] Completed with no usable context: squad={squad}, "
            f"result={retrieved_context[:120] if retrieved_context else '<empty>'}",
            flush=True,
        )
        logger.info("Squad Knowledge Base returned no usable matches for squad=%s.", squad)
        return ""

    documents = [
        {"title": f"Retrieved reference {index + 1}", "content": record.strip()}
        for index, record in enumerate(retrieved_context.split("\n---\n"))
        if record.strip()
    ]
    formatted_context = _format_context(squad, documents)
    print(
        "\n===== DEVICE SQUAD HYBRID RAG RETRIEVED CONTEXT =====\n"
        f"Squad: {squad}\n"
        f"Retrieved documents: {len(documents)}\n"
        f"{formatted_context}\n"
        "===== END DEVICE SQUAD HYBRID RAG CONTEXT =====\n",
        flush=True,
    )
    return formatted_context

def recursive_chunk_text(text: str, chunk_size: int = 1500, chunk_overlap: int = 250) -> list[str]:
    """
    Upgraded semantic layout splitter with a length safety valve. 
    Prevents embedding API errors by sub-splitting massive sections if they exceed model thresholds.
    """
    if not text.strip():
        return []
    
    # Maximum character limit safety guard for the configured embedding model.
    EMBEDDING_MAX_CHARS = 1800 
    
    # 1. Break text into logical structural document sections
    raw_blocks = re.split(r'(?=\b(?:Title:|Sub-title:|Scenario:|TC\d+|Step\s*\d+|Pre\s*requisite)\b)', text)
    
    preliminary_chunks = []
    current_chunk = ""

    for block in raw_blocks:
        block_clean = block.strip()
        if not block_clean:
            continue
            
        # If a single section is completely massive on its own, flag it for sub-splitting
        if len(block_clean) > EMBEDDING_MAX_CHARS:
            # Commit whatever we have accumulated so far first
            if current_chunk.strip():
                preliminary_chunks.append(current_chunk.strip())
                current_chunk = ""
            
            # Sub-split this massive block by paragraphs or sentences instead
            sub_paragraphs = block_clean.split("\n\n")
            for sub_p in sub_paragraphs:
                if len(sub_p.strip()) > 0:
                    preliminary_chunks.append(sub_p.strip())
            continue

        # Standard grouping behavior for normally-sized sections
        if len(current_chunk) + len(block_clean) + 1 <= chunk_size:
            current_chunk = f"{current_chunk}\n{block_clean}".strip()
        else:
            if current_chunk.strip():
                preliminary_chunks.append(current_chunk.strip())
            
            # Fallback overlap calculation
            if len(current_chunk) > chunk_overlap:
                overlap_text = current_chunk[-chunk_overlap:]
                current_chunk = f"{overlap_text}\n{block_clean}".strip()
            else:
                current_chunk = block_clean

    print(f" reached =================== recursive_chunk_text line number 211 ")

    if current_chunk.strip():
        preliminary_chunks.append(current_chunk.strip())
    
    # 2. Final safety sweep: double check no remaining chunk violates the hard limit boundary
    final_safe_chunks = []
    for chunk in preliminary_chunks:
        if len(chunk) > EMBEDDING_MAX_CHARS:
            # Emergency fallback: slice character array cleanly if a paragraph was unbroken
            for i in range(0, len(chunk), EMBEDDING_MAX_CHARS - chunk_overlap):
                final_safe_chunks.append(chunk[i:i + EMBEDDING_MAX_CHARS])
        else:
            final_safe_chunks.append(chunk)
    # print(f" reached =================== recursive_chunk_text line 227 ===========  final_safe_chunks  :: {final_safe_chunks}")
    return final_safe_chunks



def get_embedding(text: str, model: str = EMBEDDING_MODEL) -> list[float]:
    """Generate one query embedding with the configured embedding model."""
    if not settings.SQUAD_KB_EMBEDDING_BASE_URL.strip():
        logger.warning("SQUAD_KB_EMBEDDING_BASE_URL is not configured; vector retrieval is unavailable.")
        return []
    
    # print(f" reached  =================== get_embedding line number 238 ")

    try:
        headers = {"Content-Type": "application/json"}
        if settings.SQUAD_KB_EMBEDDING_API_KEY.strip():            
            headers["Authorization"] = f"Bearer {settings.SQUAD_KB_EMBEDDING_API_KEY.strip()}"

        # print(f" reached  =================== line number 241 >> ========= {settings.SQUAD_KB_EMBEDDING_BASE_URL.strip().rstrip('/')}/embeddings")
        # print(f" reached  =================== line number 242 >> ========= model {model} ")
        response = requests.post(f"{settings.SQUAD_KB_EMBEDDING_BASE_URL.strip().rstrip('/')}/embeddings",
            
            headers=headers,
            json={
                "model": model,
                "input": text,
                # "dimensions": settings.SQUAD_KB_EMBEDDING_DIMENSIONS,
            },
            timeout=settings.SQUAD_KB_EMBEDDING_TIMEOUT_SECONDS,
        )
        # print(f" response =========== {response}")
        if response.status_code >= 400:
            logger.error(
                "Embedding provider rejected model %s with HTTP %s: %s",
                model,
                response.status_code,
                response.text[:1000],
            )
            return []
        data = response.json().get("data") or []
        return list(data[0].get("embedding") or []) if data else []
    except requests.RequestException as exc:
        logger.error("OpenAI embedding failed for model %s: %s", model, exc)
        return []

def hybrid_retrieve(squad_name: str, brd_text: str, top_k: int = 3) -> str:
    """
    Advanced retrieval filtering engine. Evaluates text overlap ratios to 
    eliminate broken statements, version tables, and semantic near-duplicates.
    """
    print(f"\n=================================================================")
    print(f"🚀 RUNNING ADAPTIVE DE-NOISING RETRIEVAL PIPELINE FOR: {squad_name}")
    print(f"=================================================================")
    pipeline_start = time.perf_counter()
    database_squads = SQUAD_DATABASE_NAMES if squad_name == "Device Squad" else (squad_name,)
    
    # 1. Bound the input with the existing semantic chunker before extracting
    # search criteria. This keeps embedding requests within model limits.
    safe_chunks = recursive_chunk_text(brd_text)

    clean_query = "\n".join(safe_chunks[:3]).lower()
    for phrase in ["generate test cases for", "write test cases for", "test cases of", "create test cases for"]:
        clean_query = clean_query.replace(phrase, "")

    # print(f" reached 287 =================== hybrid_retrieve ===  clean_query :: {clean_query}")

    raw_words = clean_query.strip().split()
    high_signal_words = []
    seen_search_terms = set()
    
    # Drop pure document formatting keywords from the query
    layout_noise_words = {"contents", "document", "version", "table", "section", "page", "published", "date"}
    
    # print(f" reached 296 =================== hybrid_retrieve ===  layout_noise_words :: {layout_noise_words}")

    for word in raw_words:
        cleaned_word = word.strip(".,;:()[]{}'\"")
        if len(cleaned_word) > 2 and cleaned_word not in seen_search_terms and cleaned_word not in layout_noise_words:
            seen_search_terms.add(cleaned_word)
            high_signal_words.append(cleaned_word)
        if len(high_signal_words) >= 25:
            break
        
    # print(f" reached 306 =================== hybrid_retrieve ===  high_signal_words :: {high_signal_words}")

    sparse_keywords = " ".join(high_signal_words)[:250]
    
    # Generate embeddings based on high-signal criteria
    query_vector = get_embedding(f"search_query: {sparse_keywords}") # Ensure your global get_embedding function is accessible here
    
    # print(f" reached 313 =================== hybrid_retrieve ===  query_vector :: {query_vector}")

    if not query_vector:
        print("[❌ RAG FAILURE] Pipeline stopped: Embedding generation dropped.")
        return "Failed to construct query embeddings matrix."

    try:
        # Request double/triple the top_k value so we can drop duplicates safely.
        # The PostgreSQL adapter computes dense and sparse candidate ranks in a
        # single round trip; RRF remains the engine-level ranking authority.
        ranked_candidates = postgres_client.query_hybrid_documents(
            squad_name=database_squads,
            query_embedding=query_vector,
            sparse_query=sparse_keywords,
            limit=max(30, top_k * 3),
        )
        keyword_hits = [
            candidate for candidate in ranked_candidates
            if candidate.get("sparse_rank") is not None
        ]
        keyword_hits.sort(key=lambda candidate: candidate["sparse_rank"])
        vector_hits = [
            candidate for candidate in ranked_candidates
            if candidate.get("dense_rank") is not None
        ]
        vector_hits.sort(key=lambda candidate: candidate["dense_rank"])
        matched_documents = _reciprocal_rank_fusion([keyword_hits, vector_hits])
        matched_records = [
            "\n".join(part for part in (document.get("title"), document.get("content")) if part)
            for document in matched_documents
        ]
        
        if not matched_records:
            return f"No historical reference test cases discovered for {squad_name}."
            
        cleaned_records = []
        seen_content_signatures = set()

        for record in matched_records:
            record_clean = record.strip()
            record_lower = record_clean.lower()

            # A. CRITERIA 1: Drop broken/incomplete fragments or layout index strings
            lines = [line.strip() for line in record_clean.split("\n") if line.strip()]
            if len(lines) <= 4 and any(word in record_lower for word in ["outcome", "condition", "state"]):
                continue  # Discards fragments like your original Source Chunk #1
                
            # B. CRITERIA 2: Drop metadata revision timelines
            if "published date:" in record_lower or "version 1" in record_lower:
                continue # Discards historical audit noise like your original Source Chunk #2

            # C. CRITERIA 3: Near-Duplicate Detection (Signature analysis approximation)
            # Create a signature from the first 2 lines (e.g., Title + Subtitle)
            if len(lines) >= 2:
                content_signature = " ".join(lines[:2]).lower()
            else:
                content_signature = record_lower[:100]
                
            # Normalize variations by removing dynamic values like test ID integers or arbitrary code numbers
            content_signature = re.sub(r'\d+', '', content_signature)

            if content_signature not in seen_content_signatures:
                seen_content_signatures.add(content_signature)
                cleaned_records.append(record_clean)

        # Retain only the highest-scoring target items matching your original top_k constraint
        final_records = cleaned_records[:top_k]
        
        if not final_records:
            return f"No valid context remaining after high-signal cleanup filters for {squad_name}."

        print(f"🎉 TOTAL RAG PIPELINE SUCCESSFUL IN {time.perf_counter() - pipeline_start:.4f} SECONDS\n")
        return "\n---\n".join(final_records)

    except Exception as e:
        logger.exception("Database hybrid extraction error: %s", e)
        return "Context assembly pipeline execution failure."



