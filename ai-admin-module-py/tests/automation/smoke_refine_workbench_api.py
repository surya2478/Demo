"""
--- Automation Module: workbench in-place refine smoke test -------------------

Drives POST /automation/workbench/test-cases/refine-bulk over real HTTP against
a LOCAL OpenAI-compatible stub. No corporate or external host is contacted.

--- Why this file exists separately from smoke_refine_api.py ------------------

smoke_refine_api.py covers /candidates/manual/{id}/refine, which produces a new
row. This route is the other one: it refines the workbench grid IN PLACE, and
it is the one the Studio's AI Refine button calls.

It went out mis-bound -- the router passed `case_dict=` where workbench._refine_one
takes `existing=`, and omitted `application_name` entirely -- so every case
raised TypeError inside the per-case `except Exception`, and the route answered
200 with `refined_count: 0`. Nothing in the response distinguished that from a
batch which genuinely changed nothing, so the failure read as a quiet success
in the UI for as long as it lasted.

That is what these assertions are aimed at, in order of what they would have
caught:

  * refined_count equals the number of cases sent, not zero
  * `errors` comes back empty, and carries a reason when it does not
  * the typed application_url reaches the persisted row, which is what makes
    the later AI Classify pass resolve a Knowledge Base profile at all
  * the case is REPLACED, keeping its id and display_id and bumping version

Start the stub first, then run from ai-admin-module-py:

    python tests/automation/llm_stub.py 8099 &
    .venv312/Scripts/python.exe tests/automation/smoke_refine_workbench_api.py
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

PORT = 8044
BASE = f"http://127.0.0.1:{PORT}/automation"
DISPLAY_ID = "TC-WB-REFINE-SMOKE"
TARGET_URL = "https://www.eand.ae/en/smb/index.html"

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


def cleanup(db) -> None:
    db.query(AutomationTestCase).filter(
        AutomationTestCase.display_id == DISPLAY_ID
    ).delete(synchronize_session=False)
    db.commit()


def seed_case(db) -> AutomationTestCase:
    case = AutomationTestCase(
        source="refined",
        origin="imported",
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
    db.add(case)
    db.commit()
    db.refresh(case)
    return case


def main() -> int:
    try:
        requests.post("http://127.0.0.1:8099/v1/chat/completions", json={}, timeout=5)
    except requests.RequestException:
        print("The local LLM stub is not running on 127.0.0.1:8099. Start llm_stub.py first.")
        return 1

    server = serve()
    db = next(get_db())

    try:
        cleanup(db)
        case = seed_case(db)
        case_id = case.id
        original_version = case.version or 1
        print(f"=== seeded case #{case_id}, server on :{PORT} ===\n")

        print("=== POST /workbench/test-cases/refine-bulk ===")
        res = requests.post(
            f"{BASE}/workbench/test-cases/refine-bulk",
            json={"case_ids": [case_id], "application_url": TARGET_URL},
            timeout=60,
        )
        check("200 OK", res.status_code == 200, f"got {res.status_code}: {res.text[:300]}")
        if res.status_code != 200:
            return 1

        body = res.json()
        # The regression itself. This was 0, with errors invisible.
        check(
            "refined_count is 1, not 0",
            body.get("refined_count") == 1,
            f"got {body.get('refined_count')}",
        )
        check(
            "no per-case errors",
            not body.get("errors"),
            f"got {body.get('errors')}",
        )
        check("one case returned", len(body.get("test_cases") or []) == 1)
        if not body.get("test_cases"):
            return 1

        refined = body["test_cases"][0]
        print("\n=== refined in place, not duplicated ===")
        check("same row id", refined["id"] == case_id, f"got {refined['id']}")
        check("display_id preserved", refined["tc_display_id"] == DISPLAY_ID)
        check(
            "version bumped",
            refined["version"] == original_version + 1,
            f"{original_version} -> {refined['version']}",
        )
        check("steps rewritten", len(refined.get("steps") or []) == 3)

        print("\n=== the typed URL reaches the row ===")
        # This is what makes the later classify pass resolve a KB profile:
        # classification folds case.application_url into the text it identifies
        # the application from.
        check(
            "application_url persisted",
            refined.get("application_url") == TARGET_URL,
            f"got {refined.get('application_url')!r}",
        )
        db.expire_all()
        stored = db.query(AutomationTestCase).filter(AutomationTestCase.id == case_id).first()
        check("application_url on the database row", stored.application_url == TARGET_URL)

        print("\n=== a case with no id of ours is refused ===")
        missing = requests.post(
            f"{BASE}/workbench/test-cases/refine-bulk",
            json={"case_ids": [999999]},
            timeout=15,
        )
        check("404 for unknown case", missing.status_code == 404, f"got {missing.status_code}")

        print("\n=== the single-case route takes the same path ===")
        single = requests.post(
            f"{BASE}/workbench/test-cases/{case_id}/refine",
            json={"application_url": TARGET_URL},
            timeout=60,
        )
        check("200 OK", single.status_code == 200, f"got {single.status_code}: {single.text[:300]}")
        if single.status_code == 200:
            check("returns the refined row", single.json()["id"] == case_id)

    finally:
        cleanup(db)
        print("\n=== cleaned up the seeded row ===")
        server.should_exit = True

    print()
    if failures:
        print("FAILED")
        for f in failures:
            print("  -", f)
        return 1
    print("PASSED -- the workbench refines in place and carries the target URL through")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
