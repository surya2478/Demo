"""Manual live check for authenticated discovery; never runs under unit tests.

Run from the backend directory with its configured virtual environment. Uses
the registered bank_test PREPRODUCTION Test Data without printing its values.
"""
from __future__ import annotations

import asyncio
import time

from app.database.connection import SessionLocal
from app.models.automation import AutomationApplication, AutomationDiscoveryRun
from app.routers import automation
from app.services.automation.agent_auth import observed_login_plan
from app.services.automation.job_manager import job_manager
from app.services.journeys import store


async def main() -> None:
    db = SessionLocal()
    try:
        app = db.query(AutomationApplication).filter(AutomationApplication.app_key == "bank_test").first()
        assert app and app.environment == "PREPRODUCTION"
        kb = store.load(app.app_key)
        plan = observed_login_plan(kb, base_url=app.base_url, profile_id="AGENT_CASE_27")
        assert plan, "No approved browser-observed login journey"
        job_manager.bind_loop(asyncio.get_running_loop())
        result = automation.start_discovery(
            automation.DiscoveryRequest(application_id=app.id, max_pages=12,
                                        login_journey_id=plan["journey_id"], profile_id="AGENT_CASE_27"),
            db=db, current_user={"username": "codex-live-check", "role": "admin"})
        run_id = result["id"]
        print(f"Authenticated discovery #{run_id} started", flush=True)
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            db.expire_all()
            run = db.get(AutomationDiscoveryRun, run_id)
            automation._absorb_discovery_result(db, run)
            if run.status in ("completed", "failed"):
                print(f"status={run.status} auth={run.auth_status} pages={run.pages_discovered} "
                      f"controls={run.elements_discovered} blockers={len(run.blockers or [])} "
                      f"detail={run.auth_detail or run.error}", flush=True)
                return
            await asyncio.sleep(3)
        print("Timed out waiting for live discovery", flush=True)
    finally:
        db.close()


if __name__ == "__main__":
    asyncio.run(main())
