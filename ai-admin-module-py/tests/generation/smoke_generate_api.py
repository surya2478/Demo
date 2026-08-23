"""
--- Generation: brd-testcases endpoint smoke test ----------------------------

Drives POST /generate/brd-testcases over real HTTP against a LOCAL streaming
stub. No corporate or external host is contacted.

This is the endpoint that replaces the external AI service's
/generate/brd-testcases, so what it proves is compatibility as much as
correctness: the legacy multipart field names are still accepted, the body is
still streamed plain text with no SSE framing of its own, and the
[TOKEN_COUNTS:...] marker the frontend scrapes still arrives at the end.

Runs a real uvicorn rather than TestClient, matching the rest of this repo's
smoke tests -- an in-process portal hides event-loop problems, and streaming is
exactly where those show up.

Auth is handled by overriding get_current_user_strict, except in the one case
that deliberately checks an unauthenticated request is refused.

Start the stub first, then run from ai-admin-module-py:

    .venv312/Scripts/python.exe tests/generation/sse_stub.py 8098
    .venv312/Scripts/python.exe tests/generation/smoke_generate_api.py
"""
import os
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

# Point the transport at the local stub before app.config is imported.
os.environ.setdefault("OPENROUTER_BASE_URL", "http://127.0.0.1:8098/v1")
os.environ.setdefault("OPENROUTER_MODEL", "stub/local")
os.environ.setdefault("OPENROUTER_API_KEY", "stub-key-not-real")

import requests  # noqa: E402
import uvicorn  # noqa: E402

from app.main import app  # noqa: E402
from app.utils.security import get_current_user_strict  # noqa: E402

PORT = 8044
STUB = "http://127.0.0.1:8098/v1/chat/completions"
URL = f"http://127.0.0.1:{PORT}/generate/brd-testcases"

FAKE_USER = {"username": "smoke-user", "role": "user", "roles": ["user"]}

BRD = (
    "The system shall allow a registered user to sign in with a username and "
    "password. After three consecutive failed attempts the account is locked "
    "for 15 minutes.\nEnvironment: SIT\nFocus: Authentication"
)

# The legacy form contract, reproduced field for field from TestCases.tsx.
LEGACY_FORM = {
    "provider": "ollama",
    "model_name": "gemma3:1b",
    "temperature": "0.2",
    "max_tokens": "4096",
    "response_format": "text",
}

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"  {'PASS' if condition else 'FAIL'}  {label}")
    if not condition:
        failures.append(f"{label} {detail}".strip())


def serve() -> uvicorn.Server:
    config = uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="error")
    server = uvicorn.Server(config)
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):
        if server.started:
            return server
        time.sleep(0.1)
    raise RuntimeError("the test server did not start")


def main() -> int:
    try:
        requests.post(STUB, json={"stream": True}, timeout=5)
    except requests.RequestException:
        print(f"The local streaming stub is not running on {STUB}. Start sse_stub.py first.")
        return 1

    app.dependency_overrides[get_current_user_strict] = lambda: FAKE_USER
    server = serve()

    try:
        print("\nLegacy form contract, streamed response")
        with requests.post(
            URL, data={**LEGACY_FORM, "text": BRD}, timeout=60, stream=True
        ) as resp:
            check("returns 200", resp.status_code == 200, f"got {resp.status_code}")
            check(
                "body is plain text, not an SSE stream",
                resp.headers.get("Content-Type", "").startswith("text/plain"),
                resp.headers.get("Content-Type", ""),
            )
            check(
                "proxy buffering is disabled",
                resp.headers.get("X-Accel-Buffering") == "no",
            )
            chunks = [c for c in resp.iter_content(chunk_size=None, decode_unicode=True) if c]
            body = "".join(chunks)

        check("arrives in more than one chunk", len(chunks) > 1, f"{len(chunks)} chunk(s)")
        check("no 'data:' framing leaks into the body", "data:" not in body, body[:120])
        check(
            "carries the canonical header row",
            "| Test Case ID | Category | Test Case Description |" in body,
            body[:200],
        )
        check("carries generated rows", "TC-001" in body and "TC-002" in body)
        check(
            "ends with the token marker the frontend scrapes",
            "[TOKEN_COUNTS:Prompt=812,Response=244,Total=1056]" in body,
            body[-120:],
        )

        print("\nInput validation")
        resp = requests.post(URL, data={**LEGACY_FORM, "text": "   "}, timeout=30)
        check("empty text is refused with 400", resp.status_code == 400, f"got {resp.status_code}")

        resp = requests.post(
            URL,
            data=LEGACY_FORM,
            files={"files": ("brd.docx", b"PK\x03\x04stub", "application/octet-stream")},
            timeout=30,
        )
        check(
            "files without text report 501, not a bare 'field required'",
            resp.status_code == 501,
            f"got {resp.status_code}: {resp.text[:160]}",
        )
        check(
            "and the 501 names document extraction",
            "extraction" in resp.text.lower(),
            resp.text[:160],
        )

        print("\nFails closed when OPENROUTER_MODEL is unset")
        # This is the production posture: the route is deployed and reachable,
        # but no model is configured, so it must refuse rather than bill. The
        # setting is restored immediately afterwards.
        from app.config import settings as _settings

        original_model = _settings.OPENROUTER_MODEL
        _settings.OPENROUTER_MODEL = ""
        try:
            resp = requests.post(URL, data={**LEGACY_FORM, "text": BRD}, timeout=30)
            check(
                "refuses with 502 rather than a 200 carrying an error",
                resp.status_code == 502,
                f"got {resp.status_code}",
            )
            check(
                "and the message names the missing setting",
                "OPENROUTER_MODEL" in resp.text,
                resp.text[:200],
            )
        finally:
            _settings.OPENROUTER_MODEL = original_model

        print("\nAuthentication")
        app.dependency_overrides.pop(get_current_user_strict, None)
        resp = requests.post(URL, data={**LEGACY_FORM, "text": BRD}, timeout=30)
        check(
            "an unauthenticated request is refused",
            resp.status_code == 401,
            f"got {resp.status_code}",
        )
    finally:
        app.dependency_overrides.pop(get_current_user_strict, None)
        server.should_exit = True

    print()
    if failures:
        print(f"{len(failures)} check(s) failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
