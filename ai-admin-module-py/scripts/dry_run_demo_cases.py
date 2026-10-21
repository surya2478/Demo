"""Dry-run the board-demo scripts through Automation Lab's own run pipeline, one at a time.

    python scripts/dry_run_demo_cases.py [TAB-001 TAB-002 ...]

Each run is an ordinary AutomationRun (mode dry_run), so its result, log,
screenshots, trace and video appear in Automation Lab / Runs exactly as if
"Dry run" had been pressed there. Prints a pass/fail table at the end.
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

# Piped over stdin (docker exec -i <c> python - < this file) __file__ is "<stdin>":
# the container's app root is then the working directory, /app.
_here = globals().get("__file__") or ""
ROOT = Path(_here).resolve().parent.parent if _here.endswith(".py") else Path.cwd()
sys.path.insert(0, str(ROOT))

from app.database.connection import SessionLocal  # noqa: E402
from app.models.automation import AutomationRun, AutomationScript, AutomationTestCase  # noqa: E402
from app.models.database import Project  # noqa: E402

PPM_ID = "BOARD-DEMO-TABLETS"


async def main(only: list[str]) -> int:
    from app.routers.automation import DryRunRequest, dry_run_scripts

    db = SessionLocal()
    project = db.query(Project).filter(Project.ppm_id == PPM_ID).first()
    if project is None:
        print("Load the cases first: python scripts/load_demo_cases.py")
        return 1
    rows = (
        db.query(AutomationScript, AutomationTestCase)
        .join(AutomationTestCase, AutomationTestCase.id == AutomationScript.test_case_id)
        .filter(AutomationTestCase.project_id == project.id,
                AutomationScript.is_current.is_(True),
                AutomationScript.framework == "playwright")
        .order_by(AutomationTestCase.display_id)
        .all()
    )
    db.close()
    results = []
    for script, case in rows:
        if only and case.display_id not in only:
            continue
        db = SessionLocal()
        started = time.time()
        out = dry_run_scripts(DryRunRequest(script_ids=[script.id], slow_mo_ms=1000, headless=True),
                              db=db, current_user={"username": "admin", "role": "admin"})
        run_key = out["queued"][0]["run_key"]
        db.close()
        while True:
            await asyncio.sleep(3)
            db = SessionLocal()
            run = db.query(AutomationRun).filter(AutomationRun.run_key == run_key).first()
            status, outcome, err = run.status, run.outcome, (run.error_message or "")
            db.close()
            if status in ("completed", "failed", "cancelled"):
                break
        took = time.time() - started
        results.append((case.display_id, outcome or status, run_key, took, err))
        print(f"{case.display_id:8} {str(outcome or status):8} {took:5.0f}s  {run_key}  {err[:160]}", flush=True)
    passed = sum(1 for r in results if r[1] == "passed")
    print(f"\n{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 2


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(sys.argv[1:])))
