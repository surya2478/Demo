"""
--- Knowledge Base page API ---------------------------------------------------------

Exercises /automation/knowledge-base/* the way the page calls it: every stage's
endpoint answers for eand_b2b_portal, an unknown app or journey is a 404, and
test-data coverage reports present / missing per field -- with a vault seeded
in a throwaway SQLite database -- without ever returning a value.

Only the router under test is mounted, so no other part of the backend starts.
Run from ai-admin-module-py:

    .venv312/Scripts/python.exe tests/journeys/smoke_kb_page_api.py
"""
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
_db = Path(tempfile.mkdtemp()) / "kb_page.db"
os.environ["DATABASE_URL"] = f"sqlite:///{_db.as_posix()}"

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.database.connection import Base, SessionLocal, engine  # noqa: E402
import app.models.automation  # noqa: E402,F401
from app.models.automation import AutomationDataApp, AutomationTestData  # noqa: E402
from app.routers import knowledge_base_page  # noqa: E402
from app.utils.security import get_current_user_strict  # noqa: E402

Base.metadata.create_all(bind=engine)
api = FastAPI()
api.include_router(knowledge_base_page.router, prefix="/automation/knowledge-base")
api.dependency_overrides[get_current_user_strict] = lambda: {
    "username": "kb-smoke", "role": "admin", "roles": ["admin"], "permissions": ["automation.view"],
}
client = TestClient(api)
BASE = "/automation/knowledge-base/eand_b2b_portal"
failures = []


def check(condition, message):
    print(("  ok   " if condition else "  FAIL ") + message)
    if not condition:
        failures.append(message)


# A vault with SIT values for the multi-organization user and an OTP for every environment.
SECRET = "do-not-leak-4711"
db = SessionLocal()
vault_app = AutomationDataApp(name="B2B Portal", kb_app_id="eand_b2b_portal", url_prefix="https://devnew-sas.etisalat.ae/b2bportal")
db.add(vault_app)
db.flush()
for env, key, value in (("SIT", "multi_org.email", "multi@example.test"), ("SIT", "org_name", "Com1"), ("*", "otp", SECRET)):
    db.add(AutomationTestData(app_id=vault_app.id, environment=env, key=key, value=value, is_secret=False))
db.commit()
db.close()

print("1. Every stage answers")
apps = client.get("/automation/knowledge-base/apps").json()["apps"]
check(any(a["app_id"] == "eand_b2b_portal" for a in apps), "eand_b2b_portal is listed")
overview = client.get(f"{BASE}/overview").json()
check(overview["journeys"]["total"] == 207, f"207 leaf journeys ({overview['journeys']['total']})")
check(overview["screens"] == {"catalogued": 6, "elements": 47, "linked": overview["screens"]["linked"]}, f"screens {overview['screens']}")
check(len(overview["chapters"]) == 18, "18 chapters")
sources = client.get(f"{BASE}/sources").json()["sources"]
by_doc = {s["document"]: s for s in sources}
check(by_doc.get("B2B_Knowledge_Base_-_Explore_Topics.pdf", {}).get("extraction") == "transcribed", "master list is transcribed")
check(by_doc.get("Sign-in using OTP.pdf", {}).get("extraction") == "approved", "OTP PDF is approved")
check(by_doc.get("Registering on B2B Portal.pdf", {}).get("extraction") == "not_extracted", "registration PDF not extracted yet")
taxonomy = client.get(f"{BASE}/taxonomy").json()
check(len(taxonomy["nodes"]) == 253 and "B2B.REG.EXISTING.SIGNIN.OTP" in taxonomy["authored"], "taxonomy with authored journeys")

print("2. Journey detail")
detail = client.get(f"{BASE}/journeys/B2B.REG.EXISTING.SIGNIN.OTP").json()["journey"]
check(len(detail["steps"]) == 9, "9 steps")
check(all("link" in s for s in detail["steps"]), "every step carries its link status")
check(any(u["journey_id"] == "B2B.REG.EXISTING.SIGNIN.SELECT_ORG" for u in detail["used_by"]), f"used_by lists Select Organization ({[u['journey_id'] for u in detail['used_by']]})")
check(all(u["journey_id"] != "B2B.REG.EXISTING.SIGNIN.OTP" for u in detail["used_by"]), "a journey is not listed as using itself")
sel = client.get(f"{BASE}/journeys/B2B.REG.EXISTING.SIGNIN.SELECT_ORG").json()["journey"]
check(all(u["journey_id"] != "B2B.REG.EXISTING.SIGNIN.SELECT_ORG" for u in sel["used_by"]), "Select Organization does not list itself")
awaiting = client.get(f"{BASE}/journeys/B2B.DASH.VIEWING_ALL_ACCOUNTS").json()
check(awaiting["journey"] is None and awaiting["node"]["status"] == "awaiting_source", "an unauthored journey returns its node only")
check(client.get(f"{BASE}/journeys/NOPE").status_code == 404, "unknown journey is a 404")
check(client.get("/automation/knowledge-base/nope/overview").status_code == 404, "unknown app is a 404")

print("3. Model and reconcile")
model = client.get(f"{BASE}/model").json()
check(len(model["screens"]) == 6, "6 screens in the model")
reconcile = client.get(f"{BASE}/reconcile").json()
design_rows = [r for r in reconcile["rows"] if r["element_id"]]
check(len(design_rows) == 47, f"one row per design element ({len(design_rows)})")
check(all(r["status"] in {"MATCH", "LABEL_DRIFT", "NOT_CRAWLED", "REF_BROKEN"} for r in design_rows), "design rows carry element statuses")
check(any(r["status"] == "NOT_IN_DESIGN" for r in reconcile["rows"]), "Automation KB selectors without a design element are reported")

print("4. Test-data coverage")
coverage = client.get(f"{BASE}/test-data").json()
raw = json.dumps(coverage)
check(coverage["vault_app"]["name"] == "B2B Portal", "vault app found by KB id")
check("SIT" in coverage["environments"] and "UAT" in coverage["environments"], f"environments {coverage['environments']}")
cells = {p["profile_id"]: p["cells"] for p in coverage["profiles"]}
check(cells["USER_MULTI_ORG_NO_DEFAULT"]["SIT"]["status"] == "ready", "multi-org user ready in SIT")
check(cells["USER_MULTI_ORG_NO_DEFAULT"]["UAT"]["status"] == "missing", "multi-org user missing in UAT")
check(cells["USER_SINGLE_DEFAULT_ORG"]["SIT"]["missing"] == ["TESTDATA_DEFAULT_ORG_EMAIL"], "default-org user reports the missing variable")
check(cells["OTP_SOURCE"]["UAT"]["status"] == "ready", "an all-environments OTP covers UAT")
check(cells["UAE_PASS_IDENTITY"]["SIT"]["status"] == "external", "UAE PASS identity is external")
check(SECRET not in raw and "multi@example.test" not in raw, "no stored value appears in the response")
multi = next(p for p in coverage["profiles"] if p["profile_id"] == "USER_MULTI_ORG_NO_DEFAULT")
check(any("TS-ORG" in u for u in multi["used_by"]), f"used_by filled from scenarios ({multi['used_by'][:2]})")

if failures:
    print(f"\n{len(failures)} check(s) failed")
    sys.exit(1)
print("\nall checks passed")
