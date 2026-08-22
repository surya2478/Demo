"""
--- Automation Module: Script Lab smoke test --------------------------------

Drives the Script Lab endpoints over real HTTP: compile a script from a refined
case, check the static gate, hand-edit it, guard regeneration, approve, prove
Katalon is generate-only, dry-run a Playwright script through the ordinary run
pipeline, and download both a single file and the bundle.

The dry run targets http://localhost:5175 -- this app's own dev server. No
corporate or external host is contacted. Whether the spec passes is not the
point: what is being tested is that a dry run becomes a real AutomationRun and
reports back.

Run from ai-admin-module-py (the dev server should be up for the dry run):

    .venv312/Scripts/python.exe tests/automation/smoke_scriptlab_api.py
"""
import os
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import requests  # noqa: E402
import uvicorn  # noqa: E402

from app.main import app  # noqa: E402
from app.database.connection import SessionLocal  # noqa: E402
from app.models.automation import AutomationScript, AutomationTestCase  # noqa: E402
from app.utils.security import get_current_user_strict  # noqa: E402

PORT = 8045
BASE = f"http://127.0.0.1:{PORT}/automation"
DISPLAY_ID = "TC-SCRIPTLAB-SMOKE"
TARGET = "http://localhost:5175"

FAKE_ADMIN = {
    "username": "scriptlab-smoke",
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
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="error"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):
        if server.started:
            return server
        time.sleep(0.1)
    raise RuntimeError("test server did not start")


def cleanup() -> None:
    db = SessionLocal()
    try:
        cases = (
            db.query(AutomationTestCase)
            .filter(AutomationTestCase.display_id == DISPLAY_ID)
            .all()
        )
        for case in cases:
            for script in list(case.scripts or []):
                db.delete(script)
            db.delete(case)
        db.commit()
    finally:
        db.close()


def seed() -> int:
    db = SessionLocal()
    try:
        case = AutomationTestCase(
            source="refined",
            origin="existing",
            display_id=DISPLAY_ID,
            objective="Proves the sign-in form rejects an empty submission.",
            preconditions="The application is reachable.",
            steps_raw="1. Navigate. 2. Enter username. 3. Click Sign In. 4. Verify message.",
            expected_result="A validation message is shown.",
            steps_structured=[
                {"step_number": 1, "action": "Navigate to the sign-in page", "target": TARGET,
                 "test_data_ref": None, "expected_result": "The form is visible"},
                {"step_number": 2, "action": "Enter the username", "target": "Username field",
                 "test_data_ref": "valid_username", "expected_result": "The field holds the value"},
                {"step_number": 3, "action": "Click the 'Sign In' button", "target": "Sign In button",
                 "test_data_ref": None, "expected_result": "The form submits"},
                {"step_number": 4, "action": "Verify the validation message", "target": "Sign in to continue",
                 "test_data_ref": None, "expected_result": "A message is shown"},
            ],
            test_data_requirements=[
                {"key": "valid_username", "description": "An active account",
                 "example_value": None, "sensitive": False, "resolution": "agent_generated"}
            ],
            classification="automation",
            classification_source="policy",
            approval_status="approved",
            test_data_status="ready",
            application_url=TARGET,
            eligibility_score=100,
            eligibility_verdict="ready",
            eligibility_reasons=[],
            created_by=FAKE_ADMIN["username"],
        )
        db.add(case)
        db.commit()
        db.refresh(case)
        return case.id
    finally:
        db.close()


def main() -> int:
    server = serve()
    cleanup()
    case_id = seed()
    print(f"=== seeded approved automation case #{case_id} ===\n")

    try:
        print("=== GET /frameworks ===")
        fw = requests.get(f"{BASE}/frameworks", timeout=15).json()
        names = [f["name"] for f in fw["frameworks"]]
        check("all three frameworks listed", set(names) == {"playwright", "katalon", "appium"}, str(names))
        check("only playwright is runnable", fw["runnable"] == ["playwright"], str(fw["runnable"]))

        print("\n=== GET /scripts/approved-cases ===")
        res = requests.get(f"{BASE}/scripts/approved-cases", timeout=20)
        check("200 (route ordering is right)", res.status_code == 200, res.text[:150])
        listing = res.json()
        row = next((c for c in listing["cases"] if c["id"] == case_id), None)
        check("the approved case is in the working set", row is not None)
        check("counts include per-framework tallies", "by_framework" in listing["counts"])

        print("\n=== POST /scripts/generate (playwright) ===")
        gen = requests.post(f"{BASE}/scripts/generate",
                            json={"case_ids": [case_id], "framework": "playwright"}, timeout=30).json()
        check("one script generated", gen["generated"] == 1, str(gen)[:200])
        script = gen["scripts"][0]
        script_id = script["id"]
        code = script["code"]
        check("compiled, not freeform", script["generation_mode"] == "compiled")
        check("static gate passed", script["static_gate_result"]["passed"] is True,
              str(script["static_gate_result"])[:200])
        check("imports playwright", "@playwright/test" in code)
        check("navigates to the real target", f"page.goto(\"{TARGET}\")" in code, code[:200])
        check("label locator for the field", "getByLabel(\"Username\")" in code, "no getByLabel")
        check("role locator for the button", 'getByRole("button", { name: "Sign In" })' in code)
        check("test data via env, not a literal", "process.env.TESTDATA_VALID_USERNAME" in code)
        check("no placeholder domain", "example.com" not in code)
        check("runnable flag set", script["runnable"] is True)
        print("        ---- compiled spec (first lines) ----")
        for line in code.splitlines()[:3]:
            print("        " + line)

        print("\n=== PATCH /scripts/{id} (hand edit) ===")
        edited = requests.patch(f"{BASE}/scripts/{script_id}",
                                json={"code": code + "\n// hand edited\n"}, timeout=20).json()
        check("marked as hand-edited", edited["edited_by_user"] is True)
        check("gate re-ran over the edit", edited["static_gate_result"]["passed"] is True)

        print("\n=== regenerate refuses to discard hand edits ===")
        again = requests.post(f"{BASE}/scripts/generate",
                              json={"case_ids": [case_id], "framework": "playwright",
                                    "regenerate": True}, timeout=30).json()
        check("refused", again["generated"] == 0 and len(again["skipped"]) == 1)
        check("says why", "hand-written edits" in again["skipped"][0]["reason"],
              again["skipped"][0]["reason"][:100])

        print("\n=== POST /scripts/{id}/decide ===")
        approved = requests.post(f"{BASE}/scripts/{script_id}/decide",
                                 json={"decision": "approve"}, timeout=20).json()
        check("approved", approved["status"] == "approved")

        print("\n=== katalon is generate-only ===")
        kat = requests.post(f"{BASE}/scripts/generate",
                            json={"case_ids": [case_id], "framework": "katalon"}, timeout=30).json()
        check("katalon script produced", kat["generated"] == 1, str(kat)[:150])
        kat_script = kat["scripts"][0]
        check("not runnable", kat_script["runnable"] is False)
        check("setup notes explain why", any("generate-only" in n for n in kat_script["setup_notes"]))
        refused = requests.post(f"{BASE}/scripts/dry-run",
                                json={"script_ids": [kat_script["id"]]}, timeout=30)
        check("dry run refuses katalon", refused.status_code == 409, f"got {refused.status_code}")

        print("\n=== POST /scripts/dry-run (playwright, real runner) ===")
        dry = requests.post(f"{BASE}/scripts/dry-run",
                            json={"script_ids": [script_id], "environment": "LOCAL",
                                  "base_url": TARGET}, timeout=60)
        check("202 Accepted", dry.status_code == 202, f"got {dry.status_code}: {dry.text[:200]}")
        if dry.status_code == 202:
            queued = dry.json()["queued"]
            check("one run queued", len(queued) == 1, str(dry.json())[:200])
            run_key = queued[0]["run_key"]
            check("linked by run_key", bool(run_key))

            state = None
            for _ in range(90):
                state = requests.get(f"{BASE}/scripts/{script_id}/dry-run", timeout=20).json()
                if state["dry_run_status"] in ("passed", "failed", "blocked"):
                    break
                time.sleep(1)
            check("dry run reached a terminal state",
                  state and state["dry_run_status"] in ("passed", "failed", "blocked"),
                  str(state)[:200])
            check("it is a real AutomationRun", state and state.get("run", {}).get("run_key") == run_key)
            print(f"        dry_run_status={state['dry_run_status']} "
                  f"outcome={state.get('run', {}).get('outcome')}")

        print("\n=== downloads ===")
        one = requests.get(f"{BASE}/scripts/{script_id}/download", timeout=20)
        check("single file downloads", one.status_code == 200 and "@playwright/test" in one.text)
        bundle = requests.get(f"{BASE}/scripts/download/bundle", timeout=30)
        check("bundle is a zip", bundle.status_code == 200 and bundle.content[:2] == b"PK",
              f"status {bundle.status_code}")

        print("\n=== POST /scripts/delete ===")
        ids = [script_id, kat_script["id"]]
        gone = requests.post(f"{BASE}/scripts/delete", json={"case_ids": ids}, timeout=20).json()
        check("both deleted", gone["deleted"] == 2, str(gone))

    finally:
        cleanup()
        print("\n=== cleaned up the seeded case and its scripts ===")
        server.should_exit = True

    print()
    if failures:
        print("FAILED")
        for f in failures:
            print("  -", f)
        return 1
    print("PASSED -- the Script Lab API works end to end")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
