"""Compose automated test cases from a BRD using only the Automation KB, then build their scripts.

    python scripts/kb_compose_brd.py --brd <file.md|.txt|.docx> [--app eand_ae]
        [--ppm KB-COMPOSE-TABLETS] [--name "KB Compose - e& Tablets"] [--prefix KBC]
        [--approve] [--no-save] [--report out.json]

Prints the coverage report (covered / kb_gap / blocked / not_in_app per
requirement), saves the valid cases to the project (approved with --approve,
otherwise draft for Review & Approval) and compiles their Playwright scripts
through Automation Lab's own Generate handler. Dry-run them afterwards with
    python scripts/dry_run_demo_cases.py --ppm KB-COMPOSE-TABLETS
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_here = globals().get("__file__") or ""
ROOT = Path(_here).resolve().parent.parent if _here.endswith(".py") else Path.cwd()
sys.path.insert(0, str(ROOT))

from app.database.connection import SessionLocal  # noqa: E402
from app.models.automation import AutomationApplication  # noqa: E402
from app.models.database import Project  # noqa: E402
from app.services.automation import kb_compose  # noqa: E402


def read_brd(path: Path) -> str:
    if path.suffix.lower() == ".docx":
        from docx import Document

        doc = Document(str(path))
        parts = [p.text for p in doc.paragraphs]
        for table in doc.tables:
            for row in table.rows:
                parts.append(" | ".join(cell.text for cell in row.cells))
        return "\n".join(p for p in parts if p.strip())
    return path.read_text(encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--brd", required=True)
    parser.add_argument("--app", default="eand_ae")
    parser.add_argument("--ppm", default="KB-COMPOSE-TABLETS")
    parser.add_argument("--name", default="KB Compose - e& Tablets")
    parser.add_argument("--prefix", default="KBC")
    parser.add_argument("--approve", action="store_true")
    parser.add_argument("--no-save", action="store_true")
    parser.add_argument("--report")
    args = parser.parse_args()

    result = kb_compose.compose(read_brd(Path(args.brd)), args.app)
    report = result.report()
    print(json.dumps(report["summary"]))
    for r in report["requirements"]:
        print(f"{r['id']:7} {r['status']:10} {r['reason'][:110]}")
        for title in r["cases"]:
            print(f"          + {title}")
        for bad in r["rejected"]:
            print(f"          x {bad['title']}: {'; '.join(bad['errors'])[:160]}")
    if args.report:
        Path(args.report).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    if args.no_save or not result.valid:
        return 0

    db = SessionLocal()
    try:
        app = db.query(AutomationApplication).filter(AutomationApplication.app_key == args.app).first()
        if app is None:
            print(f"No Automation application with app_key {args.app!r}.")
            return 1
        project = db.query(Project).filter(Project.ppm_id == args.ppm).first()
        if project is None:
            project = Project(ppm_id=args.ppm, name=args.name, created_by="admin")
            db.add(project)
            db.flush()
        address = (app.base_url or "").rstrip("/")
        ids = kb_compose.save_cases(
            db, result, project_id=project.id, application_id=app.id,
            application_url=address, environment=app.environment, prefix=args.prefix,
            approve=args.approve, username="admin",
        )
        print(f"Project {project.id} {args.name!r}: {len(ids)} case(s) -> ids {ids}")
        if not args.approve:
            print("Saved as draft: approve them in Review & Approval, then generate scripts.")
            return 0
        from app.routers.automation import GenerateScriptsRequest, generate_scripts

        out = generate_scripts(
            GenerateScriptsRequest(case_ids=ids, framework="playwright", application_id=app.id,
                                   regenerate=True, ai_locators=False),
            db=db, current_user={"username": "admin", "role": "admin"},
        )
        print(f"Scripts: {out.get('generated')} generated, {len(out.get('skipped') or [])} skipped")
        for s in out.get("skipped") or []:
            print("  skipped", s)
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
