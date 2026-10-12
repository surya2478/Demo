"""--- The application(s) chosen on Generate Test Cases ----------------------------------

Two applications share words ("Business", "Payment", "OTP"): the B2B Portal's
flows are keyed on them, and a Trade Licence BRD uses them too. Before the
choice existed, the Trade Licence case matched the B2B flow and took its URL.

  1. Exact profile lookup: an application with no KB folder has no profile
     (load_app_profile still falls back -- the trap this guards against).
  2. Flow matching inside the chosen applications only.
  3. Grounding and the prompt block name only the chosen applications.
  4. Which chosen application each case is for: one chosen, the model's
     Application column, the case's own evidence, else unassigned.
  5. Where a case runs: its own application's address; a URL of another
     application is ignored, not grafted onto this host.
  6. Save stamps every row and reports it; send keeps the link.
  7. AI Checks and the Workbench mirror read the link, not the text.
  8. The dropdown's list.

Run from ai-admin-module-py:

    .venv312/Scripts/python.exe tests/generation/smoke_application_scope.py
"""
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
work = Path(tempfile.mkdtemp())
os.environ["DATABASE_URL"] = f"sqlite:///{(work / 'scope.db').as_posix()}"
os.environ["AUTOMATION_KB_PATH"] = str(work / "kb")
os.environ["JOURNEY_KB_PATH"] = str(work / "journeys")
(work / "journeys").mkdir()


def write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


apps_dir = work / "kb" / "applications"
# Sorts first, so every falling-back lookup lands on it.
write(apps_dir / "a_b2b_portal" / "app_profile.json", {
    "app_id": "a_b2b_portal", "app_name": "B2B Portal", "base_url": "https://b2b.example.com/b2bportal/login",
    "domain": "b2b.example.com",
})
write(apps_dir / "a_b2b_portal" / "flows" / "pay.json", {
    "flow_id": "b2b_payment", "flow_name": "Business payment", "category": "payment",
    "target_match_keywords": ["business", "payment", "otp"],
    "catalog_entrypoint": "https://b2b.example.com/b2bportal/payments",
})
write(apps_dir / "trade_licence" / "app_profile.json", {
    "app_id": "trade_licence", "app_name": "Trade Licence", "base_url": "https://tl.example.com/portal/home",
    "domain": "tl.example.com",
})
write(apps_dir / "trade_licence" / "flows" / "renew.json", {
    "flow_id": "tl_renew", "flow_name": "Renew trade licence", "category": "licence",
    "target_match_keywords": ["trade licence", "renewal"],
    "catalog_entrypoint": "https://tl.example.com/portal/renew",
})

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.database.connection import Base, SessionLocal, engine  # noqa: E402
import app.models.automation  # noqa: E402,F401
import app.models.kb_changes  # noqa: E402,F401
from app.models.automation import (AutomationApplication, AutomationDataApp,  # noqa: E402
                                   AutomationDataAppEnvironment, AutomationTestCase)
from app.models.database import TestCaseDetail  # noqa: E402
from app.routers import generate as generate_router  # noqa: E402
from app.routers import test_case_reviews as reviews_router  # noqa: E402
from app.services.automation import ai_checks  # noqa: E402
from app.services.automation import applications as app_scope  # noqa: E402
from app.services.automation import knowledge_base as kb  # noqa: E402
from app.services.automation import workbench  # noqa: E402
from app.services.generation import testcases  # noqa: E402
from app.utils.security import get_current_user_strict  # noqa: E402

Base.metadata.create_all(bind=engine)
failures = []


def check(condition, message):
    print(("  ok   " if condition else "  FAIL ") + message)
    if not condition:
        failures.append(message)


db = SessionLocal()
b2b = AutomationDataApp(name="B2B Portal", kb_app_id="a_b2b_portal")
tl = AutomationDataApp(name="Trade Licence", kb_app_id="trade_licence")
fresh = AutomationDataApp(name="Payments Hub")  # registered, never crawled
db.add_all([b2b, tl, fresh])
db.flush()
db.add_all([
    AutomationDataAppEnvironment(app_id=b2b.id, environment="SIT", address="https://sit-b2b.example.com/b2bportal"),
    AutomationDataAppEnvironment(app_id=tl.id, environment="SIT", address="https://sit-tl.example.com/portal"),
    AutomationDataAppEnvironment(app_id=fresh.id, environment="SIT", address="https://sit-pay.example.com/hub"),
    AutomationApplication(name="Trade Licence", app_key="trade_licence", base_url="https://tl.example.com/portal/home"),
])
db.commit()

TL, B2B, FRESH = app_scope.choices(db, [tl.id, b2b.id, fresh.id])
BRD = "Business user pays the trade licence renewal fee and confirms the payment with an OTP."

print("1. Exact profile lookup")
check(kb.load_exact_profile(FRESH.kb_app_id) is None, f"no profile for an app with no KB folder ({FRESH.kb_app_id})")
check((kb.load_app_profile(FRESH.kb_app_id) or {}).get("app_id") == "a_b2b_portal",
      "load_app_profile still falls back to the first profile (why the exact lookup exists)")
check(kb.load_exact_profile("trade_licence")["app_name"] == "Trade Licence", "an app's own profile is found")

print("2. Flow matching within the chosen applications")
unscoped = kb.match_flow_blueprint("Business payment with OTP") or {}
check(unscoped.get("_app_id") == "a_b2b_portal", "without a choice, shared words match the B2B flow (the old drift)")
scoped = kb.match_flow_blueprint("Business payment with OTP", only_apps=["trade_licence"])
check(scoped is None or scoped.get("_app_id") == "trade_licence", f"chosen Trade Licence: never B2B ({(scoped or {}).get('_app_id')})")
check(kb.match_flow_blueprint(BRD, only_apps=[FRESH.kb_app_id]) is None, "an app with no flows matches nothing")

print("3. Grounding and the prompt block")
ref = testcases.reference_context(testcases.AUTOMATION_KB, BRD, [TL])
check("tl.example.com" in ref["context"] and "b2b.example.com" not in ref["context"], "grounded in Trade Licence only")
check(ref["detail"]["source"] == "flows", f"source reported ({ref['detail'].get('source')})")
ref = testcases.reference_context(testcases.AUTOMATION_KB, BRD, [FRESH])
check(ref["context"] == "" and ref["detail"]["applications"][0]["reason"] == "no_knowledge_base",
      "an app with no KB contributes nothing, never another app's knowledge")
one = app_scope.scope_prompt(db, [TL], "SIT")
check("Trade Licence -- https://sit-tl.example.com/portal (SIT)" in one, "single: name and its SIT address")
check("b2b" not in one.lower() and "Application\"" not in one, "single: no other app, no extra column")
many = app_scope.scope_prompt(db, [TL, FRESH], "SIT")
check('headed "Application"' in many and '"Payments Hub"' in many, "several: the Application column is asked for")

print("4. Which chosen application a case is for")
row = {"Test Case ID": "TC-001", "Test Case Description": "Pay with OTP on the business payment page"}
check(app_scope.assign(dict(row), [TL]) == TL, "one chosen: that one, whatever the words")
check(app_scope.assign({**row, "Application": "payments hub"}, [TL, FRESH]) == FRESH, "the model's Application column")
check(app_scope.assign({**row, "Application": "B2B Portal"}, [TL, FRESH]) is None, "a column naming an unchosen app is ignored")
check(app_scope.assign({"Test Case Description": "Submit the trade licence renewal"}, [TL, FRESH]) == TL,
      "evidence within the chosen apps (a flow keyword)")
check(app_scope.assign({"Test Case Description": "Open the Payments Hub dashboard"}, [TL, FRESH]) == FRESH, "evidence: the app's name")
check(app_scope.assign(dict(row), [TL, FRESH]) is None, "nothing tells them apart: unassigned, not guessed")
stamped = dict(row)
app_scope.stamp(stamped, [TL])
check(stamped["Application"] == "Trade Licence" and stamped["_app"]["id"] == tl.id and len(stamped["_apps"]) == 1, "stamp writes name, link, scope")

print("5. Where a case runs")
check(app_scope.url_for(db, TL, "Open https://b2b.example.com/b2bportal/payments", "SIT") == "https://sit-tl.example.com/portal",
      "another app's URL is ignored, not grafted onto this host")
check(app_scope.url_for(db, TL, "Open https://tl.example.com/portal/renew") == "https://tl.example.com/portal/renew",
      "its own URL keeps its page")
check(app_scope.url_for(db, TL, "", "SIT") == "https://sit-tl.example.com/portal", "the chosen environment's address")
check(app_scope.url_for(db, FRESH, "", None) == "https://sit-pay.example.com/hub", "an app with no KB uses its Test Data address")

print("6. Save stamps; send keeps the link")
api = FastAPI()
api.include_router(reviews_router.router, prefix="/reviews")
api.include_router(generate_router.router, prefix="/generate")
api.dependency_overrides[get_current_user_strict] = lambda: {"username": "author", "roles": ["admin"], "permissions": []}
client = TestClient(api)
rows = [
    {"test_case_id": "REQ-1-TC-1", "request_id": "REQ-1", "test_case_details": {"Test Case ID": "TC-001", "Test Case Description": "Submit the trade licence renewal", "Application": "Trade Licence"}},
    {"test_case_id": "REQ-1-TC-2", "request_id": "REQ-1", "test_case_details": {"Test Case ID": "TC-002", "Test Case Description": "Open the Payments Hub dashboard"}},
    {"test_case_id": "REQ-1-TC-3", "request_id": "REQ-1", "test_case_details": {"Test Case ID": "TC-003", "Test Case Description": "Pay with OTP"}},
]
r = client.post("/reviews/save", json={"request_id": "REQ-1", "rows": rows, "generation": {"output": "x", "applications": [{"id": tl.id, "name": "Trade Licence"}, {"id": fresh.id, "name": "Payments Hub"}]}})
check(r.status_code == 200, f"saved ({r.status_code} {r.text[:120]})")
check(r.json().get("applications") == {"REQ-1-TC-1": "Trade Licence", "REQ-1-TC-2": "Payments Hub", "REQ-1-TC-3": None},
      f"each case's application reported ({r.json().get('applications')})")
db.expire_all()
saved = {d.test_case_id: d.test_case_details for d in db.query(TestCaseDetail).all()}
check(saved["REQ-1-TC-1"]["_app"]["id"] == tl.id, "the link is on the saved row")
r = client.post("/reviews/save", json={"request_id": "REQ-STALE", "rows": rows[:1], "applications": [99999]})
check(r.status_code == 400 and "no longer exist" in r.text, "a deleted application is refused")
r = client.post("/reviews/submit", json={"request_id": "REQ-1", "rows": [{"test_case_id": "REQ-1-TC-1", "test_case_details": {"Test Case ID": "TC-001", "Test Case Description": "Submit the trade licence renewal (checked)"}}]})
check(r.status_code == 200, f"sent ({r.status_code} {r.text[:120]})")
db.expire_all()
sent = db.query(TestCaseDetail).filter(TestCaseDetail.test_case_id == "REQ-1-TC-1").one()
check(sent.test_case_details.get("_app", {}).get("id") == tl.id and sent.test_case_details["Application"] == "Trade Licence",
      "the checked text sent back keeps the link")

print("7. AI Checks and the Workbench read the link")
url, name = ai_checks._resolve_application(saved["REQ-1-TC-1"], db, "SIT")
check((url, name) == ("https://sit-tl.example.com/portal", "Trade Licence"), f"AI Checks: the chosen app's address ({url}, {name})")
check(ai_checks._resolve_application(saved["REQ-1-TC-3"], db, "SIT") == (None, None), "AI Checks: an unassigned case gets no URL")
sent.status = "APPROVED"
db.commit()
workbench.sync_approved_test_cases(db)
case = db.query(AutomationTestCase).filter(AutomationTestCase.origin_test_case_id == "REQ-1-TC-1").one()
crawl = db.query(AutomationApplication).filter(AutomationApplication.app_key == "trade_licence").one()
check(case.application_url == "https://tl.example.com/portal/home", f"Workbench: the chosen app's URL ({case.application_url})")
check(case.application_id == crawl.id, "Workbench: linked to the application row")
from app.services.automation.applications import kb_key_for_case  # noqa: E402
check(kb_key_for_case(case) == "trade_licence", "compiler and classifier read the case's own KB")

print("8. The dropdown")
listed = {a["name"]: a for a in client.get("/generate/target-applications").json()["applications"]}
check(set(listed) == {"B2B Portal", "Trade Licence", "Payments Hub"}, "every Test Data application")
check(listed["Trade Licence"]["has_kb"] and listed["Trade Licence"]["flows"] == 1, "Trade Licence has a KB and one flow")
check(not listed["Payments Hub"]["has_kb"] and listed["Payments Hub"]["addresses"] == {"SIT": "https://sit-pay.example.com/hub"},
      "Payments Hub: no KB, its address")

print("9. Picking the application of an Unassigned case")
pick = lambda tc, app: client.post("/reviews/saved/REQ-1/application", json={"test_case_id": tc, "application_id": app})  # noqa: E731
r = pick("REQ-1-TC-3", b2b.id)
check(r.status_code == 400 and "generated for" in r.text, "an application the request did not choose is refused")
r = pick("REQ-1-TC-3", fresh.id)
check(r.status_code == 200 and r.json()["application"] == "Payments Hub", f"picked ({r.status_code} {r.text[:100]})")
db.expire_all()
picked = db.query(TestCaseDetail).filter(TestCaseDetail.test_case_id == "REQ-1-TC-3").one().test_case_details
check(picked["_app"]["id"] == fresh.id and picked["Application"] == "Payments Hub", "the saved row is linked")
rows_back = {row["test_case_id"]: row.get("application", "absent") for row in client.get("/reviews/sessions/REQ-1").json()["rows"]}
check(rows_back["REQ-1-TC-3"] == "Payments Hub", f"reopening the session shows it ({rows_back})")
check(pick("REQ-1-TC-1", fresh.id).status_code == 409, "an approved case is refused")

table_rows = [{"Test Case ID": "TC-003", "Test Case Description": "Pay with OTP"}]
app_scope.carry_by_case(table_rows, [picked])
check(app_scope.assign(table_rows[0], [TL, FRESH]) == FRESH, "AI Checks starting from the table keep the pick")

from app.models.automation import AutomationAICheck  # noqa: E402
launched = []
ai_checks._launch = lambda batch_id, ids=None: launched.append(ids)  # no model calls here
draft = AutomationTestCase(source="refined", origin="ai_checks", display_id="TC-002", description="x", environment="SIT")
db.add(draft)
db.flush()
db.add(AutomationAICheck(batch_id="B1", position=0, case_id=draft.id, status="done", steps={},
                         source_row={"Test Case ID": "TC-002", "Test Case Description": "Open the Payments Hub dashboard"}))
reviews = db.query(app.models.database.TestCaseReviewDetail).filter_by(request_id="REQ-1").one()
reviews.ai_batch_id = "B1"
db.commit()
r = pick("REQ-1-TC-2", tl.id)
db.expire_all()
draft = db.get(AutomationTestCase, draft.id)
check(r.status_code == 200 and r.json()["rechecked"] and launched, f"a checked case is checked again ({r.text[:100]})")
check(draft.application_url == "https://sit-tl.example.com/portal" and draft.application_id == crawl.id,
      f"its draft moves to the picked application ({draft.application_url})")

db.close()
print()
print("all checks passed" if not failures else f"{len(failures)} check(s) failed")
sys.exit(1 if failures else 0)
