"""Smoke test for Katalon Import, end to end through the API.

    python tests/automation/smoke_katalon_import.py <export.zip|.md> [more files ...]

Runs the router in-process with authentication stubbed, a throwaway storage
folder, and the real database for the draft change set (which it discards,
removing the KB folder it created). Checks: upload -> analysis, every case
builds, scripts match their test cases, downloads open, the profile's secrets
never reach any response, and a draft change set applies.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("AUTOMATION_STORAGE_PATH", tempfile.mkdtemp(prefix="katalon-import-"))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.routers import katalon_import  # noqa: E402
from app.services import authz  # noqa: E402

KEY = "katalon_smoke_test"


def main(paths: list[str]) -> int:
    app = FastAPI()
    app.include_router(katalon_import.router, prefix="/k")
    app.dependency_overrides[authz.get_current_user_strict] = lambda: {"username": "smoke", "roles": ["admin"], "permissions": []}
    client = TestClient(app)
    failures: list[str] = []

    def check(ok: bool, what: str) -> None:
        print(("PASS " if ok else "FAIL ") + what)
        if not ok:
            failures.append(what)

    created = client.post("/k/imports", json={"name": "smoke"}).json()
    iid = created["id"]
    files = [("files", (Path(p).name, Path(p).read_bytes())) for p in paths]
    r = client.post(f"/k/imports/{iid}/files", files=files)
    check(r.status_code == 200, f"upload + analyse ({r.status_code})")
    detail = r.json()
    body = json.dumps(detail)
    result = detail["result"]
    check(bool(result and result["models"]), "a model was built")
    summary = result["analysis"]["summary"]
    print("     summary:", json.dumps(summary))
    check("initValue" not in body and "<SECRET" not in body, "no profile values leak into the response")

    statuses = {c["status"] for c in result["cases"]}
    check(bool(result["cases"]), f"cases built ({len(result['cases'])}, statuses {sorted(statuses)})")
    ready = [c for c in result["cases"] if c["status"] == "ready"] or result["cases"]
    case = client.get(f"/k/imports/{iid}/cases/{ready[0]['case_id']}").json()
    check(case["conformance"]["playwright"]["ok"] and case["conformance"]["katalon"]["ok"], "generated scripts match the test case")
    check(len(case["steps"]) == case["conformance"]["playwright"]["tc_steps"], "manual steps = script steps")

    broken = case["scripts"]["playwright"].replace(f"// [TC 3] ", "// [TC 3x] ", 1)
    bad = client.post(f"/k/imports/{iid}/cases/{case['case_id']}/conformance", json={"framework": "playwright", "script": broken}).json()
    check(not bad["ok"], "an edited script with a step removed is caught")

    scripts_status = "ready" if any(c["status"] == "ready" for c in result["cases"]) else "all"
    for path, kind in (("download/test-cases.xlsx?status=all", "xlsx"), (f"download/scripts.zip?status={scripts_status}", "zip"),
                       ("download/kb.zip", "zip"), ("download/report.md", "md")):
        resp = client.get(f"/k/imports/{iid}/{path}")
        ok = resp.status_code == 200 and len(resp.content) > 100
        if ok and kind == "zip":
            names = zipfile.ZipFile(io.BytesIO(resp.content)).namelist()
            ok = bool(names)
            if "CONFORMANCE.json" in names:
                conf = json.loads(zipfile.ZipFile(io.BytesIO(resp.content)).read("CONFORMANCE.json"))
                ok = ok and all(c["ok"] for c in conf)
        check(ok, f"download {path.split('?')[0]}")

    from app.database.connection import SessionLocal
    from app.models.kb_changes import KbChangeSet
    from app.services.automation import knowledge_base as kb
    from app.services.journeys import changesets

    kb_dir = kb.get_kb_root() / KEY
    existed = kb_dir.exists()
    resp = client.post(f"/k/imports/{iid}/kb-change-set", json={"app_key": KEY, "app_name": "Smoke"})
    check(resp.status_code == 201, f"draft change set ({resp.status_code} {resp.text[:200] if resp.status_code != 201 else ''})")
    if resp.status_code == 201:
        db = SessionLocal()
        try:
            cs = db.get(KbChangeSet, resp.json()["change_set_id"])
            check(cs is not None and cs.status == "draft" and len(cs.changes) >= 3, "change set is a draft with the KB files")
            changesets.discard(db, cs.id)
        finally:
            db.close()
    if not existed:
        shutil.rmtree(kb_dir, ignore_errors=True)
    client.delete(f"/k/imports/{iid}")
    print(f"\n{'OK' if not failures else 'FAILED'}: {len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1:]))
