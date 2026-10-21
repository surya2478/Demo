"""Load the e& Tablets board-demo cases into Automation Studio and build their scripts.

    python scripts/load_demo_cases.py [--cases knowledge_base/applications/eand_ae/demo_cases_tablets.json]

Creates (or updates, by display_id within the project) approved, automation-
classified cases under the project 'Board Demo - e& Tablets', linked to the
eand_ae application, then compiles their Playwright scripts through the same
handler as Automation Lab's Generate. Idempotent: re-running refreshes steps and
regenerates scripts in place.

Run it inside the backend container on a server, with the KB folder mounted:
    docker exec -i <backend> python - < scripts/load_demo_cases.py
(stdin form: the path defaults below resolve against /app).
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

# Piped over stdin (docker exec -i <c> python - < this file) __file__ is "<stdin>":
# the container's app root is then the working directory, /app.
_here = globals().get("__file__") or ""
ROOT = Path(_here).resolve().parent.parent if _here.endswith(".py") else Path.cwd()
sys.path.insert(0, str(ROOT))

from app.database.connection import SessionLocal  # noqa: E402
from app.models.automation import AutomationApplication, AutomationTestCase  # noqa: E402
from app.models.database import Project  # noqa: E402

PPM_ID = "BOARD-DEMO-TABLETS"
PROJECT_NAME = "Board Demo - e& Tablets"
APP_KEY = "eand_ae"


def expand(case: dict, common: dict) -> list[dict]:
    steps: list[dict] = []
    for item in case["steps"]:
        rows = common[item[1:]] if isinstance(item, str) and item.startswith("@") else [item]
        for action, action_type, target, expected in rows:
            steps.append({
                "step_number": len(steps) + 1,
                "action": action,
                "action_type": action_type,
                "target": target,
                "test_data_ref": None,
                "expected_result": expected,
            })
    return steps


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", default=None,
                        help="Defaults to demo_cases_tablets.json in the Automation KB's eand_ae folder "
                             "(AUTOMATION_KB_PATH on a server, knowledge_base/ locally).")
    parser.add_argument("--no-scripts", action="store_true")
    args = parser.parse_args()
    from app.services.automation.knowledge_base import get_kb_root

    cases_path = Path(args.cases) if args.cases else get_kb_root() / APP_KEY / "demo_cases_tablets.json"
    print(f"Cases: {cases_path}")
    pack = json.loads(cases_path.read_text(encoding="utf-8"))

    db = SessionLocal()
    try:
        app = db.query(AutomationApplication).filter(AutomationApplication.app_key == APP_KEY).first()
        if app is None:
            print(f"No Automation application with app_key {APP_KEY!r}. Register e& UAE first.")
            return 1
        project = db.query(Project).filter(Project.ppm_id == PPM_ID).first()
        if project is None:
            project = Project(ppm_id=PPM_ID, name=PROJECT_NAME, created_by="admin")
            db.add(project)
            db.flush()

        now = datetime.utcnow()
        ids: list[int] = []
        for case in pack["cases"]:
            steps = expand(case, pack["common"])
            values = dict(
                source="refined",
                origin="board_demo_pack",
                display_id=case["display_id"],
                category=case["category"],
                description=case["objective"],
                objective=case["objective"],
                preconditions=(
                    "Guest user (not signed in) on the e& UAE dev site https://devnew.eand.ae, "
                    "desktop browser 1366x768 or wider."
                ),
                steps_raw="\n".join(f"{s['step_number']}. {s['action']}" for s in steps),
                steps_structured=steps,
                test_data="None - guest browsing, no credentials or personal data.",
                test_data_required=False,
                test_data_status="ready",
                test_data_requirements=[],
                expected_result=case["expected_result"],
                priority=case.get("priority", "Medium"),
                test_type=case.get("test_type", "Positive"),
                automation_blockers=[],
                eligibility_score=100,
                eligibility_verdict="ready",
                eligibility_reasons=[],
                classification="automation",
                classification_source="policy",
                classification_reason="Every step targets a selector verified on devnew.eand.ae (crawl 2026-10-20).",
                manual_only_reasons=[],
                approval_status="approved",
                decision_reason="Board demo pack: steps grounded on the 2026-10-20 crawl of devnew.eand.ae.",
                approved_by="admin",
                approved_at=now,
                application_id=app.id,
                application_url=pack["application_url"],
                environment=pack.get("environment"),
                project_id=project.id,
                grounding_status="grounded",
                created_by="admin",
            )
            row = (
                db.query(AutomationTestCase)
                .filter(AutomationTestCase.project_id == project.id,
                        AutomationTestCase.display_id == case["display_id"])
                .first()
            )
            if row is None:
                row = AutomationTestCase(**values)
                db.add(row)
            else:
                for key, value in values.items():
                    setattr(row, key, value)
            db.flush()
            ids.append(row.id)
        db.commit()
        print(f"Project {project.id} {PROJECT_NAME!r}: {len(ids)} case(s) -> ids {ids}")

        if args.no_scripts:
            return 0
        from app.routers.automation import GenerateScriptsRequest, generate_scripts

        result = generate_scripts(
            GenerateScriptsRequest(case_ids=ids, framework="playwright", application_id=app.id,
                                   regenerate=True, ai_locators=False),
            db=db,
            current_user={"username": "admin", "role": "admin"},
        )
        produced = result.get("scripts") or []
        skipped = result.get("skipped") or []
        print(f"Scripts: {len(produced)} generated, {len(skipped)} skipped")
        for s in skipped:
            print("  skipped", s)
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
