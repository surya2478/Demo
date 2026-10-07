"""PostgreSQL storage and retrieval for the Squad Knowledge Base."""
from __future__ import annotations

import hashlib
import logging
import os
from datetime import datetime, timezone
from importlib import import_module
from threading import Lock
from typing import Any, Optional

from ...config import settings

logger = logging.getLogger(__name__)
TABLE_NAME = "squad_knowledge_base"
_SYSTEMS_SCHEMA_LOCK = Lock()
_SYSTEMS_SCHEMA_READY = False

try:
    psycopg = import_module("psycopg")
    register_vector = import_module("pgvector.psycopg").register_vector
except ImportError:
    psycopg = None
    register_vector = None


def _resolve_database_url() -> Optional[str]:
    dedicated = (
        settings.SQUAD_KB_DATABASE_URL or os.getenv("SQUAD_KB_DATABASE_URL") or ""
    ).strip()
    if dedicated:
        return dedicated
    fallback = (settings.DATABASE_URL or os.getenv("DATABASE_URL") or "").strip()
    return fallback if fallback.startswith(("postgresql://", "postgres://")) else None


def is_configured() -> bool:
    return bool(_resolve_database_url() and psycopg is not None)


def get_connection(register: bool = True):
    """Open a PostgreSQL connection and optionally register pgvector types."""
    database_url = _resolve_database_url()
    if not database_url:
        raise ValueError("SQUAD_KB_DATABASE_URL or a PostgreSQL DATABASE_URL is required")
    if psycopg is None:
        raise RuntimeError("psycopg is not installed")
    connection = psycopg.connect(database_url)
    if register and register_vector is not None:
        register_vector(connection)
    return connection


def _ensure_systems_column() -> None:
    """Upgrade an existing KB table once per process before inserting metadata."""
    global _SYSTEMS_SCHEMA_READY
    if _SYSTEMS_SCHEMA_READY:
        return
    with _SYSTEMS_SCHEMA_LOCK:
        if _SYSTEMS_SCHEMA_READY:
            return
        with get_connection(register=False) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"ALTER TABLE {TABLE_NAME} ADD COLUMN IF NOT EXISTS "
                    "systems TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]"
                )
            connection.commit()
        _SYSTEMS_SCHEMA_READY = True


def init_db(dimensions: int = 1024) -> None:
    """Create the existing KB schema and retrieval indexes if absent."""
    with get_connection(register=False) as connection:
        with connection.cursor() as cursor:
            cursor.execute("CREATE EXTENSION IF NOT EXISTS vector")
            cursor.execute("CREATE EXTENSION IF NOT EXISTS vectorscale")
            cursor.execute(
                f"""
                CREATE TABLE IF NOT EXISTS {TABLE_NAME} (
                    id TEXT PRIMARY KEY,
                    squad_name TEXT NOT NULL,
                    systems TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
                    document_name TEXT NOT NULL DEFAULT 'Legacy_Import',
                    content TEXT NOT NULL,
                    embedding VECTOR({int(dimensions)}) NOT NULL,
                    created_date_time TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    search_vector TSVECTOR GENERATED ALWAYS AS (
                        to_tsvector('english', content)
                    ) STORED
                )
                """
            )
            cursor.execute(
                f"ALTER TABLE {TABLE_NAME} ADD COLUMN IF NOT EXISTS "
                "systems TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]"
            )
            cursor.execute(f"CREATE INDEX IF NOT EXISTS skb_squad_idx ON {TABLE_NAME} (squad_name)")
            cursor.execute(
                f"CREATE INDEX IF NOT EXISTS skb_search_vector_gin_idx ON {TABLE_NAME} USING gin (search_vector)"
            )
            cursor.execute(
                f"""CREATE INDEX IF NOT EXISTS skb_embedding_diskann_idx
                    ON {TABLE_NAME} USING diskann (embedding vector_cosine_ops)"""
            )
            cursor.execute(
                f"CREATE INDEX IF NOT EXISTS skb_created_date_time_idx ON {TABLE_NAME} (created_date_time DESC)"
            )
        connection.commit()


def save_kb_entry(
    squad_name: str,
    document_name: str,
    content: str,
    embedding_list: list[float],
    systems: list[str] | None = None,
) -> None:
    """Insert one normalized chunk, ignoring exact duplicate fingerprints."""
    normalized = " ".join((content or "").lower().split())
    if not squad_name.strip() or not normalized:
        return

    _ensure_systems_column()
    chunk_id = hashlib.md5(normalized.encode("utf-8")).hexdigest()
    with get_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                f"""
                INSERT INTO {TABLE_NAME}
                    (id, squad_name, systems, document_name, content, embedding, created_date_time)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE SET systems = EXCLUDED.systems
                """,
                (
                    chunk_id,
                    squad_name,
                    systems or [],
                    document_name or "Legacy_Import",
                    content,
                    embedding_list,
                    datetime.now(timezone.utc),
                ),
            )
        connection.commit()


def list_documents(squad_name: str | list[str] | tuple[str, ...]) -> list[str]:
    """Return distinct document names for a squad, newest first."""
    squad_names = [squad_name] if isinstance(squad_name, str) else list(squad_name)
    print(f" ============ postgres client =========== list_documents ===== {squad_name} ")
    squad_names = [name.strip() for name in squad_names if name and name.strip()]
    if not squad_names:
        return []
    try:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"""
                    SELECT document_name
                    FROM {TABLE_NAME}
                    WHERE squad_name = ANY(%s)
                    GROUP BY document_name
                    ORDER BY MAX(created_date_time) DESC, document_name ASC
                    """,
                    (squad_names,),
                )
                print(f" ============ postgres client =========== list_documents ")
                return [row[0] for row in cursor.fetchall() if row[0]]
    except Exception:
        logger.exception("Failed to list Squad Knowledge Base documents for squad=%s", squad_name)
        raise


def query_hybrid_documents(
    squad_name: str | list[str] | tuple[str, ...],
    query_embedding: list[float],
    sparse_query: str,
    limit: int = 3,
    candidate_limit: int = 30,
) -> list[dict[str, Any]]:
    """Return dense and sparse ranked candidates in one PostgreSQL query."""
    squad_names = [squad_name] if isinstance(squad_name, str) else list(squad_name)
    squad_names = [name.strip() for name in squad_names if name and name.strip()]
    if not query_embedding or not squad_names or not sparse_query.strip():
        return []

    bounded_limit = max(1, int(limit))
    bounded_candidates = max(bounded_limit, int(candidate_limit))
    sql = f"""
        WITH dense_ranks AS (
            SELECT id, document_name, content,
                   ROW_NUMBER() OVER (
                       ORDER BY embedding <=> %s::vector, created_date_time DESC
                   ) AS dense_rank
            FROM {TABLE_NAME}
            WHERE squad_name = ANY(%s) AND embedding IS NOT NULL
            ORDER BY dense_rank
            LIMIT %s
        ), sparse_ranks AS (
            SELECT id, document_name, content,
                   ROW_NUMBER() OVER (
                       ORDER BY ts_rank_cd(search_vector, websearch_to_tsquery('english', %s)) DESC,
                                created_date_time DESC
                   ) AS sparse_rank
            FROM {TABLE_NAME}
            WHERE squad_name = ANY(%s)
              AND search_vector @@ websearch_to_tsquery('english', %s)
            ORDER BY sparse_rank
            LIMIT %s
        )
        SELECT COALESCE(d.id, s.id) AS id,
               COALESCE(d.document_name, s.document_name) AS title,
               COALESCE(d.content, s.content) AS content,
               d.dense_rank,
               s.sparse_rank
        FROM dense_ranks d
        FULL OUTER JOIN sparse_ranks s ON d.id = s.id
        ORDER BY
            COALESCE(1.0 / (60 + d.dense_rank), 0.0)
            + COALESCE(1.0 / (60 + s.sparse_rank), 0.0) DESC
        LIMIT %s
    """
    params = (
        query_embedding,
        squad_names,
        bounded_candidates,
        sparse_query,
        squad_names,
        sparse_query,
        bounded_candidates,
        bounded_limit,
    )

    try:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(sql, params)
                columns = [column.name for column in cursor.description]
                return [dict(zip(columns, row)) for row in cursor.fetchall()]
    except Exception:
        logger.exception("Squad Knowledge Base hybrid query failed for squad=%s", squad_name)
        return []


def keyword_search(squad: str, query: str, limit: int = 8) -> list[dict[str, Any]]:
    """Compatibility search for sparse-only callers."""
    if not squad.strip() or not query.strip():
        return []
    try:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"""
                    SELECT id, squad_name AS squad, document_name AS title, content,
                           ts_rank_cd(search_vector, websearch_to_tsquery('english', %s)) AS rank
                    FROM {TABLE_NAME}
                    WHERE squad_name = %s
                      AND search_vector @@ websearch_to_tsquery('english', %s)
                    ORDER BY rank DESC, created_date_time DESC
                    LIMIT %s
                    """,
                    (query, squad, query, max(1, int(limit))),
                )
                columns = [column.name for column in cursor.description]
                return [dict(zip(columns, row)) for row in cursor.fetchall()]
    except Exception:
        logger.exception("Squad Knowledge Base keyword search failed for squad=%s", squad)
        return []


def vector_search(squad: str, embedding: list[float], limit: int = 8) -> list[dict[str, Any]]:
    """Compatibility search for dense-only callers."""
    if not squad.strip() or not embedding:
        return []
    try:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"""
                    SELECT id, squad_name AS squad, document_name AS title, content,
                           1 - (embedding <=> %s::vector) AS score
                    FROM {TABLE_NAME}
                    WHERE squad_name = %s AND embedding IS NOT NULL
                    ORDER BY embedding <=> %s::vector, created_date_time DESC
                    LIMIT %s
                    """,
                    (embedding, squad, embedding, max(1, int(limit))),
                )
                columns = [column.name for column in cursor.description]
                return [dict(zip(columns, row)) for row in cursor.fetchall()]
    except Exception:
        logger.exception("Squad Knowledge Base vector search failed for squad=%s", squad)
        return []


def purge_squad_index(squad_name: str) -> None:
    """Delete all indexed chunks for a squad."""
    with get_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(f"DELETE FROM {TABLE_NAME} WHERE squad_name = %s", (squad_name,))
        connection.commit()
