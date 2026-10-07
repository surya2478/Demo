"""
--- Deleting an application from the Knowledge Base page -------------------------------

Against a throwaway Journey KB folder, Automation KB folder and database:

  1. The preview lists what the delete touches: Test Data environments and
     values, the crawl registration, the Journey KB and the crawled folder.
  2. The delete is refused without the exact name, and changes nothing.
  3. With the name, the application leaves Test Data, the crawl list and the
     Journey KB list; both KB folders are moved to knowledge_base/_deleted,
     not erased.
  4. The key is free again: the same application can be registered anew.
  5. An unknown application is a 404.

Run from ai-admin-module-py:

    .venv312/Scripts/python.exe tests/journeys/smoke_kb_delete_app.py
"""
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

work = Path(tempfile.mkdtemp())
(work / "journeys").mkdir()
(work / "applications").mkdir()
os.environ["JOURNEY_KB_PATH"] = str(work / "journeys")
os.environ["DATABASE_URL"] = f"sqlite:///{(work / 'kb.db').as_posix()}"

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.database.connection import Base, SessionLocal, engine  # noqa: E402
import app.models  # noqa: E402,F401
import app.models.automation  # noqa: E402,F401
import app.models.kb_changes  # noqa: E402,F401
from app.models.automation import AutomationApplication, AutomationDataApp  # noqa: E402
from app.routers import knowledge_base_page  # noqa: E402
from app.services.automation import knowledge_base as automation_kb  # noqa: E402
from app.services.journeys import store  # noqa: E402
from app.utils.security import get_current_user_strict  # noqa: E402
import app.services.authz as authz  # noqa: E402

automation_kb.KB_ROOT_DIR = work / "applications"
Base.metadata.create_all(bind=engine)
failures = []


def check(condition, message):
    print(("  ok   " if condition else "  FAIL ") + message)
    if not condition:
        failures.append(message)


api = FastAPI()
api.include_router(knowledge_base_page.router, prefix="/kb")
api.dependency_overrides[get_current_user_strict] = lambda: {"username": "engineer", "roles": ["admin"], "permissions": []}
authz.has_permission = lambda roles, perm: True
client = TestClient(api)

NAME, KEY = "Delete Me Portal", "delete_me_portal"
r = client.post("/kb/applications", json={
    "name": NAME, "addresses": {"SIT": "https://sit.example.com/", "UAT": "https://uat.example.com/"},
    "outline": "Accounts\n  View accounts\n",
})
assert r.status_code == 200, r.text
crawled = work / "applications" / KEY
crawled.mkdir()
(crawled / "app_profile.json").write_text(json.dumps({"app_id": KEY}), encoding="utf-8")

print("1. Preview")
r = client.get(f"/kb/{KEY}/deletion")
p = r.json()
check(r.status_code == 200 and p["name"] == NAME, f"names the application ({r.status_code})")
check(p["test_data"]["environments"] == ["SIT", "UAT"], f"lists its environments ({p['test_data']})")
check(p["crawl"] == {"registered": True, "runs": 0}, f"its crawl registration ({p['crawl']})")
check(p["journey_kb"]["exists"] and p["automation_kb"] == {"exists": True, "shared": False}, "and both Knowledge Bases")

print("2. Refused without the exact name")
for wrong in ("", "delete me portal", "Delete Me"):
    r = client.delete(f"/kb/{KEY}", params={"confirm": wrong})
    check(r.status_code == 400, f"confirm={wrong!r} is refused ({r.status_code})")
r = client.delete(f"/kb/{KEY}")
check(r.status_code == 422, "no confirm at all is refused")
check(store.load(KEY) is not None and crawled.exists(), "and nothing moved")

print("3. Deleted with the name")
r = client.delete(f"/kb/{KEY}", params={"confirm": f"  {NAME} "})
body = r.json()
check(r.status_code == 200 and body["deleted"] == KEY, f"deleted ({r.status_code} {r.text[:150]})")
with SessionLocal() as db:
    check(db.query(AutomationDataApp).filter(AutomationDataApp.kb_app_id == KEY).count() == 0, "gone from Test Data")
    check(db.query(AutomationApplication).filter(AutomationApplication.app_key == KEY).count() == 0, "gone from the crawl list")
check(KEY not in store.list_apps() and not crawled.exists(), "gone from both KB folders")
archived = work / "_deleted" / (body.get("archived_to") or "-")
check((archived / "journey_kb" / "journey_kb.json").exists(), f"Journey KB kept under _deleted/{body.get('archived_to')}")
check((archived / "automation_kb" / "app_profile.json").exists(), "and the crawled folder beside it")
r = client.get(f"/kb/{KEY}/deletion")
check(r.status_code == 404, "the preview now answers 404")

print("4. The key is free again")
r = client.post("/kb/applications", json={"name": NAME, "addresses": {"SIT": "https://sit.example.com/"}})
check(r.status_code == 200 and r.json()["journey_kb_created"], f"registered anew with a fresh Journey KB ({r.status_code})")

print("5. Unknown application")
r = client.delete("/kb/no_such_app", params={"confirm": "x"})
check(r.status_code == 404, f"404 ({r.status_code})")

print()
print("FAILED:" if failures else "All checks passed.", *failures, sep="\n  ")
sys.exit(1 if failures else 0)
