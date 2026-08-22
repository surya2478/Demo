"""
--- Automation Module: workbench API smoke test -----------------------------

Drives the Automation TC Coverage Assessment endpoints over real HTTP against a
LOCAL LLM stub. No corporate or external host is contacted.

Covers the whole path the screen walks: list approved sources, refine a batch
as a background job, poll it, read the grid and its counts, classify by rule
and by hand, be refused an approval that is blocked on test data, reject,
reopen, edit, export, and delete.

Start the stub first, then run from ai-admin-module-py:

    python <scratchpad>/llm_stub.py 8099 &
    .venv312/Scripts/python.exe tests/automation/smoke_workbench_api.py
"""
import os
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

os.environ.setdefault("LLM_PROVIDER", "openrouter")
os.environ.setdefault("OPENROUTER_BASE_URL", "http://127.0.0.1:8099/v1")
os.environ.setdefault("OPENROUTER_MODEL", "stub/local")
os.environ.setdefault("OPENROUTER_API_KEY", "stub-key-not-real")

import requests  # noqa: E402
import uvicorn  # noqa: E402

from app.main import app  # noqa: E402
from app.database.connection import SessionLocal  # noqa: E402
from app.models.automation import AutomationTestCase  # noqa: E402
from app.utils.security import get_current_user_strict  # noqa: E402

PORT = 8044
BASE = f"http://127.0.0.1:{PORT}/automation"

FAKE_ADMIN = {
    "username": "workbench-smoke",
    "role": "admin",
    "roles": ["admin"],
    "permissions": ["automation.view", "automation.execute", "automation.approve"],
}
app.dependency_overrides[get_current_user_strict] = lambda: FAKE_ADMIN

failures: list[str] = []
created_ids: list[int] = []


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
        rows = (
            db.query(AutomationTestCase)
            .filter(AutomationTestCase.created_by == FAKE_ADMIN["username"])
            .all()
        )
        for row in rows:
            for script in list(row.scripts or []):
                db.delete(script)
            db.delete(row)
        db.commit()
        if rows:
            print(f"=== cleaned up {len(rows)} row(s) created by this test ===")
    finally:
        db.close()


def main() -> int:
    try:
        requests.post("http://127.0.0.1:8099/v1/chat/completions", json={}, timeout=5)
    except requests.RequestException:
        print("The local LLM stub is not running on 127.0.0.1:8099. Start llm_stub.py first.")
        return 1

    server = serve()
    try:
        cleanup()

        print("=== GET /workbench/sources ===")
        res = requests.get(f"{BASE}/workbench/sources", timeout=20)
        check("200", res.status_code == 200, res.text[:150])
        sources = res.json()["sources"]
        check("approved cases listed", len(sources) > 0, f"got {len(sources)}")
        check("each carries a refined link field", all("refined_test_case_id" in s for s in sources))
        if not sources:
            return 1
        target = sources[0]
        print(f"        refining {target['tc_display_id']} (source {target['id']})")

        print("\n=== POST /workbench/generate ===")
        res = requests.post(
            f"{BASE}/workbench/generate",
            json={"source_test_case_ids": [target["id"]], "application_url": "http://localhost:5175"},
            timeout=30,
        )
        check("202 Accepted", res.status_code == 202, f"got {res.status_code}: {res.text[:200]}")
        job_id = res.json()["job_id"]
        check("job id returned", bool(job_id))

        print("\n=== GET /workbench/jobs/{id} (poll) ===")
        job = None
        for _ in range(60):
            job = requests.get(f"{BASE}/workbench/jobs/{job_id}", timeout=15).json()
            if job["status"] in ("completed", "failed"):
                break
            time.sleep(0.5)
        check("job completed", job and job["status"] == "completed", str(job)[:200])
        check("percent reached 100", job and job["percent"] == 100)
        check("no errors", job and not job["errors"], str(job.get("errors"))[:200])
        check("one case created", job and len(job["created_ids"]) == 1)
        created_ids.extend(job["created_ids"] if job else [])
        case_id = created_ids[0]

        print("\n=== GET /workbench/test-cases ===")
        grid = requests.get(f"{BASE}/workbench/test-cases", timeout=20).json()
        check("counts present", set(grid["counts"]) >= {"total", "automation", "manual", "approved", "needs_data"})
        row = next((r for r in grid["test_cases"] if r["id"] == case_id), None)
        check("refined row in grid", row is not None)
        if row is None:
            return 1
        check("id and name preserved", row["tc_display_id"] == target["tc_display_id"],
              f"{row['tc_display_id']} != {target['tc_display_id']}")
        check("origin is 'existing'", row["origin"] == "existing", row["origin"])
        check("structured steps present", len(row["steps"]) == 3, str(len(row["steps"])))
        check("classified automatically", row["classification"] in ("automation", "manual", "undecided"))
        check("classification carries a reason", bool(row["classification_reason"]))
        check("test data flagged pending", row["test_data_status"] == "pending", row["test_data_status"])
        check("approval blocked while data pending", row["can_approve"] is False)
        print(f"        classification={row['classification']} :: {row['classification_reason'][:70]}")

        print("\n=== POST /workbench/decide (approve is refused) ===")
        res = requests.post(f"{BASE}/workbench/decide",
                            json={"case_ids": [case_id], "decision": "approve"}, timeout=20).json()
        check("refused, not silently approved", res["updated"] == 0 and len(res["refused"]) == 1)
        check("refusal names the case", res["refused"][0]["display_id"] == target["tc_display_id"])
        print(f"        refused: {res['refused'][0]['reason'][:80]}")

        print("\n=== POST /workbench/classify (forced) ===")
        res = requests.post(f"{BASE}/workbench/classify",
                            json={"case_ids": [case_id], "classification": "manual"}, timeout=20).json()
        check("classification forced", res["test_cases"][0]["classification"] == "manual")
        check("source recorded as user", res["test_cases"][0]["classification_source"] == "user")

        print("\n=== POST /workbench/classify (by rule) ===")
        res = requests.post(f"{BASE}/workbench/classify", json={"case_ids": [case_id]}, timeout=20).json()
        check("re-classified by policy", res["test_cases"][0]["classification_source"] == "policy")

        print("\n=== PATCH /workbench/test-cases/{id} ===")
        res = requests.patch(f"{BASE}/workbench/test-cases/{case_id}",
                             json={"objective": "Edited objective", "priority": "High"}, timeout=20)
        check("200", res.status_code == 200, res.text[:150])
        check("edit applied", res.json()["objective"] == "Edited objective")
        check("priority applied", res.json()["priority"] == "High")

        print("\n=== reject, then reopen ===")
        res = requests.post(f"{BASE}/workbench/decide",
                            json={"case_ids": [case_id], "decision": "reject", "reason": "Not this sprint"},
                            timeout=20).json()
        check("rejected", res["test_cases"][0]["approval_status"] == "rejected")
        res = requests.post(f"{BASE}/workbench/test-cases/{case_id}/reopen", timeout=20).json()
        check("reopened to draft", res["approval_status"] == "draft")

        print("\n=== GET /workbench/export ===")
        res = requests.get(f"{BASE}/workbench/export", params={"classification": "all"}, timeout=20)
        check("200", res.status_code == 200)
        check("is a CSV attachment", "attachment" in res.headers.get("Content-Disposition", ""))
        check("header row present", res.text.splitlines()[0].startswith("Test Case ID,"))
        check("contains the refined case", target["tc_display_id"] in res.text)

        print("\n=== source now shows as refined ===")
        again = requests.get(f"{BASE}/workbench/sources", timeout=20).json()["sources"]
        linked = next((s for s in again if s["id"] == target["id"]), None)
        check("refined_test_case_id populated", linked and linked["refined_test_case_id"] == case_id)

        print("\n=== POST /workbench/delete ===")
        res = requests.post(f"{BASE}/workbench/delete", json={"case_ids": [case_id]}, timeout=20).json()
        check("deleted", res["deleted"] == 1)
        gone = requests.get(f"{BASE}/workbench/test-cases", timeout=20).json()
        check("gone from the grid", all(r["id"] != case_id for r in gone["test_cases"]))

    finally:
        cleanup()
        server.should_exit = True

    print()
    if failures:
        print("FAILED")
        for f in failures:
            print("  -", f)
        return 1
    print("PASSED -- the workbench API works end to end")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
