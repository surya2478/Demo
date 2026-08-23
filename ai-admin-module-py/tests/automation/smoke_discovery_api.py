"""
--- Automation Module: discovery and grounding smoke test -------------------

Crawls THIS app's own dev server on localhost:5175, catalogues what it renders,
then grounds a refined test case against the result. No corporate or external
host is contacted.

The assertions are about the mechanism, not about any particular element:
a crawl produces pages and elements, each element carries a verified locator,
and grounding resolves the steps it can while naming the ones it cannot.

The dev server must be running. From ai-admin-module-py:

    .venv312/Scripts/python.exe tests/automation/smoke_discovery_api.py
"""
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import requests  # noqa: E402
import uvicorn  # noqa: E402

from app.main import app  # noqa: E402
from app.database.connection import SessionLocal  # noqa: E402
from app.models.automation import (  # noqa: E402
    AutomationDiscoveredElement,
    AutomationDiscoveryRun,
    AutomationTestCase,
)
from app.services.automation import grounding  # noqa: E402
from app.utils.security import get_current_user_strict  # noqa: E402

PORT = 8046
BASE = f"http://127.0.0.1:{PORT}/automation"
TARGET = "http://localhost:5175"
DISPLAY_ID = "TC-GROUNDING-SMOKE"

FAKE_ADMIN = {
    "username": "discovery-smoke",
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
        db.query(AutomationTestCase).filter(
            AutomationTestCase.display_id == DISPLAY_ID
        ).delete(synchronize_session=False)
        for run in db.query(AutomationDiscoveryRun).all():
            db.delete(run)
        db.commit()
    finally:
        db.close()


def seed_case() -> int:
    db = SessionLocal()
    try:
        case = AutomationTestCase(
            source="refined",
            origin="existing",
            display_id=DISPLAY_ID,
            objective="Signs in from the login page.",
            steps_structured=[
                # Navigation needs no control -- must be skipped, not failed.
                {"step_number": 1, "action": "Navigate to the login page",
                 "target": TARGET, "test_data_ref": None, "expected_result": "Form shown"},
                # These name controls the login page really renders.
                {"step_number": 2, "action": "Enter the username",
                 "target": "Username", "test_data_ref": "u", "expected_result": "Filled"},
                {"step_number": 3, "action": "Enter the password",
                 "target": "Password", "test_data_ref": "p", "expected_result": "Filled"},
                {"step_number": 4, "action": "Click the Sign In button",
                 "target": "Sign In", "test_data_ref": None, "expected_result": "Submits"},
                # Deliberately absent from the app -- must be reported, not guessed.
                {"step_number": 5, "action": "Click the Teleport button",
                 "target": "Teleport to Mars", "test_data_ref": None, "expected_result": "n/a"},
            ],
            classification="automation", approval_status="draft",
            eligibility_score=100, eligibility_verdict="ready", eligibility_reasons=[],
            created_by=FAKE_ADMIN["username"],
        )
        db.add(case)
        db.commit()
        db.refresh(case)
        return case.id
    finally:
        db.close()


def main() -> int:
    try:
        requests.get(TARGET, timeout=6)
    except requests.RequestException:
        print(f"The dev server is not running at {TARGET}. Start it first.")
        return 1

    server = serve()
    cleanup()
    case_id = seed_case()
    print(f"=== seeded case #{case_id}, crawling {TARGET} ===\n")

    try:
        print("=== POST /discovery/run ===")
        res = requests.post(
            f"{BASE}/discovery/run",
            json={"application_url": TARGET, "application_environment": "LOCAL", "max_pages": 3},
            timeout=60,
        )
        check("202 Accepted", res.status_code == 202, f"got {res.status_code}: {res.text[:200]}")
        if res.status_code != 202:
            return 1
        started = res.json()
        check("versioned", started["version"] >= 1)
        check("linked to a run", bool(started["run_key"]))
        check("auth mode is anonymous", started["auth_mode"] == "none")

        print("\n=== GET /discovery (poll) ===")
        state = None
        for _ in range(90):
            state = requests.get(f"{BASE}/discovery", timeout=20).json()
            if state["discovery"] and state["discovery"]["status"] in ("completed", "failed"):
                break
            time.sleep(1)
        disc = state["discovery"]
        check("crawl completed", disc and disc["status"] == "completed",
              str(disc.get("error"))[:200] if disc else "no discovery")
        if not disc or disc["status"] != "completed":
            return 1
        check("pages were crawled", disc["pages_discovered"] >= 1, str(disc["pages_discovered"]))
        check("elements were catalogued", state["elements"] > 0, str(state["elements"]))
        print(f"        {disc['pages_discovered']} page(s), {state['elements']} element(s)")

        print("\n=== GET /discovery/elements ===")
        catalog = requests.get(f"{BASE}/discovery/elements", timeout=20).json()
        check("catalogue returned", catalog["total"] > 0)
        check("roles surfaced", len(catalog["roles"]) > 0, str(catalog["roles"]))
        every_locator = all(e["recommended_locator"] for e in catalog["elements"])
        check("every element carries a locator", every_locator)
        strategies = {e["recommended_strategy"] for e in catalog["elements"]}
        check("strategies recorded", strategies.issubset(
            {"role", "label", "text", "placeholder", "testid"}), str(strategies))
        print(f"        roles: {', '.join(catalog['roles'][:6])}")
        for e in catalog["elements"][:3]:
            print(f"        {e['role']:10} {(e['accessible_name'] or '')[:26]:28} "
                  f"{e['recommended_strategy']:11} conf={e['confidence_score']}")

        print("\n=== POST /workbench/ground ===")
        res = requests.post(f"{BASE}/workbench/ground", json={"case_ids": [case_id]}, timeout=30)
        check("200", res.status_code == 200, res.text[:200])
        result = res.json()
        check("one case checked", result["checked"] == 1)
        row = result["test_cases"][0]
        summary = row["grounding_summary"]
        check("status is partial", row["grounding_status"] == grounding.STATUS_PARTIAL,
              row["grounding_status"])
        check("navigation step was skipped, not failed", summary["skipped"] == 1,
              str(summary["skipped"]))
        check("some steps resolved", len(summary["matched"]) >= 1, str(len(summary["matched"])))
        check("the invented control is reported", any(
            "Teleport" in (u.get("target") or "") for u in summary["unresolved"]))
        unresolved = next(u for u in summary["unresolved"] if "Teleport" in (u.get("target") or ""))
        check("the reason is actionable", "No discovered element matches" in unresolved["reason"],
              unresolved["reason"][:80])
        print(f"        matched={len(summary['matched'])} unresolved={len(summary['unresolved'])} "
              f"skipped={summary['skipped']}")
        for m in summary["matched"]:
            print(f"        step {m['step_number']}: {m['target']!r} -> {m['locator']}")
        print(f"        step {unresolved['step_number']}: {unresolved['reason'][:90]}")

        print("\n=== DELETE /discovery resets grounding ===")
        removed = requests.delete(f"{BASE}/discovery", timeout=20).json()
        check("catalogue removed", removed["elements_removed"] > 0)
        check("grounded cases reset", removed["test_cases_reset"] >= 1)
        db = SessionLocal()
        try:
            after = db.query(AutomationTestCase).filter(AutomationTestCase.id == case_id).first()
            check("status back to not_checked",
                  after.grounding_status == grounding.STATUS_NOT_CHECKED, after.grounding_status)
            check("elements gone", db.query(AutomationDiscoveredElement).count() == 0)
        finally:
            db.close()

    finally:
        cleanup()
        print("\n=== cleaned up ===")
        server.should_exit = True

    print()
    if failures:
        print("FAILED")
        for f in failures:
            print("  -", f)
        return 1
    print("PASSED -- discovery and grounding work end to end")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
