"""Export test cases (and their application's Test Data) to move them to another deployment.

    python scripts/export_cases.py --request REQ-1792579170382 -o b2b_cases.json
    python scripts/export_cases.py --project R&D-LAB-TESTING -o lab.json

Writes one JSON file: the project (by PPM ID), the application (by KB key), every
case field except database ids, and the linked application's Test Data entries.
Secret values are decrypted for transport -- the other deployment has its own
key and import_cases.py re-encrypts them. The file therefore holds credentials:
keep it out of git and delete it after importing.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime
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
from app.services.automation import test_data  # noqa: E402

SKIP = {"id", "parent_id", "discovery_run_id", "project_id", "application_id"}


def _plain(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument("--request", help="origin request id, e.g. REQ-1792579170382")
    scope.add_argument("--project", help="project PPM ID")
    parser.add_argument("-o", "--out", required=True)
    args = parser.parse_args()

    db = SessionLocal()
    try:
        query = db.query(AutomationTestCase)
        if args.request:
            query = query.filter(AutomationTestCase.origin_test_case_id.like(f"{args.request}-TC-%"))
        else:
            project = db.query(Project).filter(Project.ppm_id == args.project).first()
            if project is None:
                print(f"No project {args.project!r}.")
                return 1
            query = query.filter(AutomationTestCase.project_id == project.id)
        cases = query.order_by(AutomationTestCase.id).all()
        if not cases:
            print("No cases matched.")
            return 1

        columns = [c.name for c in AutomationTestCase.__table__.columns if c.name not in SKIP]
        projects = {c.project_id for c in cases if c.project_id}
        apps = {c.application_id for c in cases if c.application_id}
        project_rows = {p.id: p for p in db.query(Project).filter(Project.id.in_(projects)).all()} if projects else {}
        app_rows = {a.id: a for a in db.query(AutomationApplication).filter(AutomationApplication.id.in_(apps)).all()} if apps else {}

        out_cases = []
        for case in cases:
            row = {name: _plain(getattr(case, name)) for name in columns}
            project = project_rows.get(case.project_id)
            app = app_rows.get(case.application_id)
            row["_project"] = {"ppm_id": project.ppm_id, "name": project.name} if project else None
            row["_application"] = {"app_key": app.app_key, "name": app.name} if app else None
            out_cases.append(row)

        keys = {a.app_key for a in app_rows.values() if a.app_key}
        data = []
        for data_app in db.query(AutomationDataApp).filter(AutomationDataApp.kb_app_id.in_(keys)).all() if keys else []:
            for entry in db.query(AutomationTestData).filter(AutomationTestData.app_id == data_app.id).all():
                data.append({
                    "kb_app_id": data_app.kb_app_id,
                    "app_name": data_app.name,
                    "key": entry.key,
                    "environment": entry.environment,
                    "is_secret": bool(entry.is_secret),
                    "aliases": entry.aliases,
                    "value": test_data.value_of(entry),
                })

        Path(args.out).write_text(json.dumps({
            "exported_at": datetime.utcnow().isoformat(),
            "scope": {"request": args.request, "project": args.project},
            "cases": out_cases,
            "test_data": data,
        }, indent=1, ensure_ascii=False), encoding="utf-8")
        approved = sum(1 for c in cases if c.approval_status == "approved")
        print(f"{len(cases)} case(s) ({approved} approved), {len(data)} Test Data entr(ies) -> {args.out}")
        print("The file holds Test Data values: keep it out of git, delete it after importing.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
