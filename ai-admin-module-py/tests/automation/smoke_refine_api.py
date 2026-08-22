"""
--- Automation Module: refine endpoint smoke test ---------------------------

Drives POST /automation/candidates/manual/{id}/refine over real HTTP against a
LOCAL OpenAI-compatible stub. No corporate or external host is contacted.

Runs a real uvicorn on a spare port rather than using TestClient: TestClient
needs httpx, which this project does not depend on, and a real server is what
the rest of this module's smoke tests use for the reason recorded in
smoke_run_api.py -- an in-process portal hides event-loop problems.

Auth is handled by overriding get_current_user_strict, the dependency
require_permission nests. The permission check itself still runs against the
injected user's roles, so this proves the route is gated; it only skips proving
that a JWT decodes, which every other endpoint exercises.

Start the stub first, then run from ai-admin-module-py:

    python <scratchpad>/llm_stub.py 8099 &
    .venv312/Scripts/python.exe tests/automation/smoke_refine_api.py
"""
import os
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

# Point the transport at the local stub before app.config is imported.
os.environ.setdefault("LLM_PROVIDER", "openrouter")
os.environ.setdefault("OPENROUTER_BASE_URL", "http://127.0.0.1:8099/v1")
os.environ.setdefault("OPENROUTER_MODEL", "stub/local")
os.environ.setdefault("OPENROUTER_API_KEY", "stub-key-not-real")

import requests  # noqa: E402
import uvicorn  # noqa: E402

from app.main import app  # noqa: E402
from app.database.connection import get_db  # noqa: E402
from app.models.automation import AutomationTestCase  # noqa: E402
from app.utils.security import get_current_user_strict  # noqa: E402

PORT = 8043
BASE = f"http://127.0.0.1:{PORT}/automation"
DISPLAY_ID = "TC-REFINE-SMOKE"

FAKE_ADMIN = {
    "username": "smoke-admin",
    "role": "admin",
    "roles": ["admin"],
    "permissions": ["automation.view", "automation.execute", "automation.approve"],
}

app.dependency_overrides[get_current_user_strict] = lambda: FAKE_ADMIN

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


def cleanup(db, case_id: int | None) -> None:
    db.query(AutomationTestCase).filter(
        AutomationTestCase.display_id == DISPLAY_ID
    ).delete(synchronize_session=False)
    if case_id is not None:
        db.query(AutomationTestCase).filter(
            AutomationTestCase.parent_id == case_id
        ).delete(synchronize_session=False)
    db.commit()


def main() -> int:
    try:
        requests.post("http://127.0.0.1:8099/v1/chat/completions", json={}, timeout=5)
    except requests.RequestException:
        print("The local LLM stub is not running on 127.0.0.1:8099. Start llm_stub.py first.")
        return 1

    server = serve()
    db = next(get_db())
    case_id = None

    try:
        cleanup(db, None)
        seed = AutomationTestCase(
            source="manual",
            display_id=DISPLAY_ID,
            category="Billing",
            description="Verify an invoice can be downloaded as PDF",
            preconditions="A raised invoice exists.",
            steps_raw="1. Open Billing. 2. Select the invoice. 3. Click Download.",
            test_data="invoice_id: a raised invoice",
            expected_result="The PDF downloads.",
            eligibility_score=100,
            eligibility_verdict="ready",
            eligibility_reasons=[],
            created_by="smoke",
        )
        db.add(seed)
        db.commit()
        db.refresh(seed)
        case_id = seed.id
        original_steps = seed.steps_raw
        print(f"=== seeded case #{case_id}, server on :{PORT} ===\n")

        print("=== POST /candidates/manual/{id}/refine ===")
        res = requests.post(
            f"{BASE}/candidates/manual/{case_id}/refine",
            json={"application_url": "http://localhost:5175"},
            timeout=60,
        )
        check("201 Created", res.status_code == 201, f"got {res.status_code}: {res.text[:200]}")
        if res.status_code != 201:
            return 1

        body = res.json()
        check("returns both sides", "original" in body and "refined" in body)
        original, refined = body["original"], body["refined"]

        check("refined is a NEW row", refined["id"] != original["id"])
        check("refined links to its parent", refined["parent_id"] == case_id)
        check("source is 'refined'", refined["source"] == "refined")
        check("display_id preserved, not renamed", refined["display_id"] == DISPLAY_ID)

        check("structured steps produced", len(refined["steps_structured"]) == 3)
        check(
            "step references data by key, never a literal",
            any(s.get("test_data_ref") == "invoice_id" for s in refined["steps_structured"]),
        )
        check("test data requirement captured", len(refined["test_data_requirements"]) == 1)
        check(
            "resolution surfaced",
            refined["test_data_requirements"][0]["resolution"] == "existing_record",
        )
        check("test_data_required flagged", body["test_data_required"] is True)
        check("bdd scenario returned", bool(body.get("bdd_scenario")))
        check("re-scored", isinstance(refined["eligibility"]["score"], int))
        print(
            f"        score {original['eligibility']['score']} -> "
            f"{refined['eligibility']['score']}  "
            f"({original['eligibility']['verdict']} -> {refined['eligibility']['verdict']})"
        )

        print("\n=== the original is left untouched ===")
        again = requests.get(f"{BASE}/candidates/manual/{case_id}", timeout=15)
        check("original still readable", again.status_code == 200)
        check("original steps unchanged", again.json()["steps_raw"] == original_steps)

        print("\n=== the refined case appears as a candidate ===")
        listing = requests.get(f"{BASE}/candidates?source=manual", timeout=15).json()
        check("refined row listed", refined["id"] in [c["id"] for c in listing["candidates"]])

        print("\n=== an unknown case is refused ===")
        missing = requests.post(f"{BASE}/candidates/manual/999999/refine", json={}, timeout=15)
        check("404 for unknown case", missing.status_code == 404, f"got {missing.status_code}")

    finally:
        cleanup(db, case_id)
        print("\n=== cleaned up seeded and refined rows ===")
        server.should_exit = True

    print()
    if failures:
        print("FAILED")
        for f in failures:
            print("  -", f)
        return 1
    print("PASSED -- the refine endpoint works end to end over HTTP")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
