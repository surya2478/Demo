"""Embeddings for the Squad Knowledge Base, shared by ingestion and retrieval.

One place decides where embeddings come from and which key goes with them.
Ingestion and retrieval each had their own copy, and both sent OPENAI_API_KEY
to SQUAD_KB_EMBEDDING_BASE_URL -- which in the deployed configuration is a
self-hosted embedding server on another host, not OpenAI. The two copies also
had to agree on the model for vectors to be comparable at all, which is easier
to guarantee when there is only one.
"""
from __future__ import annotations

import requests

from ...config import settings

# Well under the input-count limit of OpenAI and of vLLM-style servers, and
# small enough that one slow batch does not approach the request timeout.
_BATCH_SIZE = 64


def _endpoint() -> tuple[str, dict[str, str]]:
    """The embeddings URL and the headers to send with it."""
    dedicated = (settings.SQUAD_KB_EMBEDDING_BASE_URL or "").strip()
    if dedicated:
        base, key = dedicated, (settings.SQUAD_KB_EMBEDDING_API_KEY or "").strip()
    else:
        base, key = (settings.OPENAI_BASE_URL or "").strip(), (settings.OPENAI_API_KEY or "").strip()
        if not key:
            raise RuntimeError(
                "No embedding endpoint is configured: set SQUAD_KB_EMBEDDING_BASE_URL, "
                "or OPENAI_API_KEY to use OpenAI's."
            )
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return f"{base.rstrip('/')}/embeddings", headers


def embed(texts: list[str]) -> list[list[float]]:
    """Embed `texts` in order, batching the requests. Raises on any failure.

    Dimensions are not requested: the model decides them, and they must match
    the VECTOR(n) column the corpus was indexed into
    (SQUAD_KB_EMBEDDING_DIMENSIONS), which a mismatch reports at insert time.
    """
    url, headers = _endpoint()
    vectors: list[list[float]] = []
    for start in range(0, len(texts), _BATCH_SIZE):
        batch = texts[start:start + _BATCH_SIZE]
        response = requests.post(
            url,
            headers=headers,
            json={"model": settings.SQUAD_KB_EMBEDDING_MODEL, "input": batch},
            timeout=settings.OPENAI_TIMEOUT_SECONDS,
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Embedding model {settings.SQUAD_KB_EMBEDDING_MODEL} was rejected "
                f"with HTTP {response.status_code}: {response.text[:500]}"
            )
        data = sorted(response.json().get("data") or [], key=lambda item: item["index"])
        if len(data) != len(batch):
            raise RuntimeError(
                f"The embedding server returned {len(data)} vectors for {len(batch)} inputs"
            )
        vectors.extend(list(item["embedding"]) for item in data)
    return vectors
