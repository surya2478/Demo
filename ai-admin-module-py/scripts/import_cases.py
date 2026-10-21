"""Import cases and Test Data written by export_cases.py, then build their scripts.

    python scripts/import_cases.py b2b_cases.json [--overwrite-test-data] [--no-scripts]

On a server, copy the file into the backend container and pipe this script in:
    docker cp b2b_cases.json <backend>:/tmp/b2b_cases.json
    docker exec -i <backend> python - /tmp/b2b_cases.json < ai-admin-module-py/scripts/import_cases.py
    docker exec <backend> rm /tmp/b2b_cases.json

Cases are matched by origin_test_case_id (else display_id) within their project
and updated in place, so re-running is safe. The project is created by PPM ID
when missing; the application is found by its KB key and must already exist.
Test Data: missing entries are added and aliases merged; an existing value is
replaced only with --overwrite-test-data. Scripts are regenerated with this
deployment's compiler for every approved, automation-classified case.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

_here = globals().get("__file__") or ""
ROOT = Path(_here).resolve().parent.parent if _here.endswith(".py") else Path.cwd()
sys.path.insert(0, str(ROOT))

from app.database.connection import SessionLocal  # noqa: E402
from app.models.automation import (  # noqa: E402
    AutomationApplication,
    AutomationDataApp,
    AutomationTestCase,
    AutomationTestData,
)
from app.models.database import Project  # noqa: E402
from app.services.automation import test_data as td  # noqa: E402

ACTOR = "import_cases"
DATETIME_FIELDS = {"created_at", "updated_at", "approved_at", "reviewed_at", "classified_at", "grounded_at"}


def _value(name: str, value):
    if name in DATETIME_FIELDS and isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("file")
    parser.add_argument("--overwrite-test-data", action="store_true")
    parser.add_argument("--no-scripts", action="store_true")
    args = parser.parse_args()
    pack = json.loads(Path(args.file).read_text(encoding="utf-8"))

    db = SessionLocal()
    try:
        columns = {c.name for c in AutomationTestCase.__table__.columns}
        projects: dict[str, Project] = {}
        apps: dict[str, AutomationApplication] = {}
        created = updated = 0
        to_build: dict[int, list[int]] = {}
        missing_apps: set[str] = set()

        for row in pack["cases"]:
            proj = None
            if row.get("_project"):
                ppm = row["_project"]["ppm_id"]
                proj = projects.get(ppm) or db.query(Project).filter(Project.ppm_id == ppm).first()
                if proj is None:
                    proj = Project(ppm_id=ppm, name=row["_project"]["name"], created_by=ACTOR)
                    db.add(proj)
                    db.flush()
                projects[ppm] = proj
            app = None
            if row.get("_application"):
                key = row["_application"]["app_key"]
                app = apps.get(key) or db.query(AutomationApplication).filter(AutomationApplication.app_key == key).first()
                if app is None:
                    missing_apps.add(key)
                else:
                    apps[key] = app

            query = db.query(AutomationTestCase).filter(AutomationTestCase.project_id == (proj.id if proj else None))
            if row.get("origin_test_case_id"):
                query = query.filter(AutomationTestCase.origin_test_case_id == row["origin_test_case_id"])
            else:
                query = query.filter(AutomationTestCase.display_id == row.get("display_id"))
            case = query.first()
            values = {k: _value(k, v) for k, v in row.items() if k in columns and not k.startswith("_")}
            values["project_id"] = proj.id if proj else None
            values["application_id"] = app.id if app else None
            if case is None:
                case = AutomationTestCase(**values)
                db.add(case)
                created += 1
            else:
                for k, v in values.items():
                    setattr(case, k, v)
                updated += 1
            db.flush()
            if case.approval_status == "approved" and case.classification == "automation" and app is not None:
                to_build.setdefault(app.id, []).append(case.id)

        added = merged = overwritten = 0
        missing_data_apps: set[str] = set()
        for entry in pack.get("test_data") or []:
            data_app = db.query(AutomationDataApp).filter(AutomationDataApp.kb_app_id == entry["kb_app_id"]).first()
            if data_app is None:
                missing_data_apps.add(entry["kb_app_id"])
                continue
            existing = (db.query(AutomationTestData)
                        .filter(AutomationTestData.app_id == data_app.id,
                                AutomationTestData.key == entry["key"],
                                AutomationTestData.environment == entry["environment"]).first())
            stored = td.encrypt(entry["value"]) if entry["is_secret"] and entry["value"] is not None else entry["value"]
            if existing is None:
                db.add(AutomationTestData(app_id=data_app.id, environment=entry["environment"], key=entry["key"],
                                          value=stored, is_secret=entry["is_secret"], aliases=entry.get("aliases"),
                                          updated_by=ACTOR))
                added += 1
                continue
            names = [a.strip() for a in (existing.aliases or "").split(",") if a.strip()]
            for alias in (entry.get("aliases") or "").split(","):
                if alias.strip() and alias.strip() not in names:
                    names.append(alias.strip())
            if ", ".join(names) != (existing.aliases or ""):
                existing.aliases = ", ".join(names)
                merged += 1
            if args.overwrite_test_data and td.value_of(existing) != entry["value"]:
                existing.value = stored
                existing.is_secret = entry["is_secret"]
                overwritten += 1
            existing.updated_by = ACTOR
        db.commit()

        print(f"Cases: {created} created, {updated} updated.")
        print(f"Test Data: {added} added, {merged} alias merge(s), {overwritten} value(s) overwritten"
              + ("" if args.overwrite_test_data else " (existing values kept; --overwrite-test-data replaces them)") + ".")
        if missing_apps:
            print(f"Not linked -- no Automation application with key(s): {', '.join(sorted(missing_apps))}")
        if missing_data_apps:
            print(f"Test Data skipped -- no Test Data application for: {', '.join(sorted(missing_data_apps))}")

        if args.no_scripts or not to_build:
            return 0
        from app.routers.automation import GenerateScriptsRequest, generate_scripts

        for app_id, ids in to_build.items():
            result = generate_scripts(
                GenerateScriptsRequest(case_ids=ids, framework="playwright", application_id=app_id,
                                       regenerate=True, ai_locators=False),
                db=db, current_user={"username": ACTOR, "role": "admin"},
            )
            print(f"Scripts: {result.get('generated')} generated for application {app_id}; skipped {result.get('skipped')}")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
