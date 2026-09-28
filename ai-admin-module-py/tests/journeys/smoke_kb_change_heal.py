"""
--- Change & Heal: a BRD changes existing journeys ------------------------------------

A small BRD (generated here as a PDF) changes the OTP sign-in: CONTINUE is
renamed RECEIVE OTP, the Proceed button goes (the OTP submits itself), a
"Remember this device" checkbox is added and the OTP rule gains an expiry.
The model is replaced by a fixed reply; everything else is real, against
throwaway copies of the Journey KB and a throwaway database.

  1. Extraction in BRD mode proposes a rename, a journey revision (with what
     it adds, removes and rewords), a restated rule and a new element.
  2. Impact before approval: the journeys, test cases (and which of their
     steps) and Automation KB selectors the selection touches.
  3. A rename alone rewords journey steps that quote the old label; with the
     journey revised, its revised wording wins.
  4. Approving records a heal: the affected test case's KB diff is refreshed
     (before/after kept), an unrelated case is left alone.
  5. Heal actions: AI Checks re-run skips cases that never went through AI
     Checks; a crawl is refused for a journey the change does not touch.
  6. Reverting restores the KB and records a heal of its own.
  7. A screen-flow PDF still never changes existing knowledge.

Run from ai-admin-module-py:

    .venv312/Scripts/python.exe tests/journeys/smoke_kb_change_heal.py
"""
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

work = Path(tempfile.mkdtemp())
shutil.copytree(ROOT / "knowledge_base" / "journeys", work / "journeys")
os.environ["JOURNEY_KB_PATH"] = str(work / "journeys")
os.environ["DATABASE_URL"] = f"sqlite:///{(work / 'kb.db').as_posix()}"
os.environ["JOURNEY_EXTRACTION_VISION_MODEL"] = ""

import pymupdf  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.database.connection import Base, SessionLocal, engine  # noqa: E402
import app.models.automation  # noqa: E402,F401
import app.models.kb_changes  # noqa: E402,F401
from app.models.automation import AutomationTestCase  # noqa: E402
from app.models.kb_changes import KbChangeSet, KbHeal  # noqa: E402
from app.routers import knowledge_base_page  # noqa: E402
from app.services.automation import llm  # noqa: E402
from app.services.journeys import changesets, store  # noqa: E402
from app.utils.security import get_current_user_strict  # noqa: E402
import app.services.authz as authz  # noqa: E402

Base.metadata.create_all(bind=engine)
APP = "eand_b2b_portal"
OTP = "B2B.REG.EXISTING.SIGNIN.OTP"
failures = []


def check(condition, message):
    print(("  ok   " if condition else "  FAIL ") + message)
    if not condition:
        failures.append(message)


def pdf(text: str) -> bytes:
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_textbox(pymupdf.Rect(40, 40, 560, 800), text, fontsize=10)
    return doc.tobytes()


BRD = pdf(
    "BRD-2027-04 Sign-in changes\n"
    "1. The CONTINUE button on the login page is renamed RECEIVE OTP.\n"
    "2. After the sixth digit the OTP is verified automatically; the Proceed button is removed.\n"
    "3. A Remember this device checkbox is added below the OTP boxes.\n"
    "4. The OTP is exactly 6 digits and expires after 5 minutes.\n"
)

kb0 = store.load(APP)
steps = []
for s in kb0.journeys[OTP]["steps"]:
    if s["step_number"] == 7:
        continue  # Proceed goes
    # Like a real model: no expected results, no branches, and the either-or
    # landing screen left out -- the revision must inherit them.
    step = {"action": s["action"], "screen_id": s.get("screen_id") if "|" not in (s.get("screen_id") or "") else None,
            "element_id": s.get("element_id"), "rule_key": s.get("rule"), "page": 1}
    if s["step_number"] == 4:
        step["action"] = "Click RECEIVE OTP to request the one-time password"
    steps.append(step)
    if s["step_number"] == 6:
        steps.append({"action": "Tick Remember this device", "screen_id": "SCR_OTP_ENTRY", "element_id": "remember_device", "page": 1})

REPLY = {
    "journeys": [{"taxonomy_id": OTP, "name": "Sign-in using OTP", "pages": [1], "steps": steps}],
    "screens": [
        {"screen_id": "SCR_LOGIN", "name": "Login", "pages": [1],
         "elements": [{"element_id": "otp_continue", "label": "RECEIVE OTP", "type": "button", "page": 1}]},
        {"screen_id": "SCR_OTP_ENTRY", "name": "OTP entry", "pages": [1],
         "elements": [{"element_id": "remember_device", "label": "Remember this device", "type": "checkbox", "page": 1}]},
    ],
    "rules": [{"key": "R1", "replaces": "BR-AUTH-03", "statement": "The OTP is exactly 6 digits and expires after 5 minutes.",
               "type": "validation", "page": 1}],
}
reply = {"value": REPLY}
prompts = []


def fake_complete_json(*, system_prompt, user_input, model_cls, **kwargs):
    prompts.append(user_input)
    return model_cls.model_validate(json.loads(json.dumps(reply["value"])))


llm.complete_json = fake_complete_json

api = FastAPI()
api.include_router(knowledge_base_page.router, prefix="/kb")
api.dependency_overrides[get_current_user_strict] = lambda: {"username": "analyst", "roles": ["tester"], "permissions": []}
authz.has_permission = lambda roles, perm: True
client = TestClient(api)

db = SessionLocal()
affected = AutomationTestCase(
    display_id="TC-OTP-001", description="Sign in with an OTP",
    steps_structured=[{"step_number": 1, "action": "Open the B2B Portal login page"},
                      {"step_number": 2, "action": "Enter the registered email address"},
                      {"step_number": 3, "action": "Click CONTINUE"}],
    journey_diff={"journey_id": OTP, "chain": [OTP, "B2B.REG.EXISTING.SIGNIN.SELECT_ORG"], "summary": {"MATCH": 3},
                  "steps": [{"step_number": 3, "screen_id": "SCR_LOGIN", "element_id": "otp_continue", "status": "MATCH"}]},
)
unrelated = AutomationTestCase(display_id="TC-OTHER-001", description="Order a SIM",
                               journey_diff={"journey_id": "B2B.ORDERS.SIM", "chain": ["B2B.ORDERS.SIM"], "summary": {"MATCH": 2}})
db.add_all([affected, unrelated])
db.commit()


def extract(doc_id):
    client.post(f"/kb/documents/{doc_id}/extract")
    for _ in range(100):
        detail = client.get(f"/kb/documents/{doc_id}").json()
        if detail["status"] != "extracting":
            return detail
        time.sleep(0.1)
    return detail


print("1. BRD extraction proposes changes")
doc = client.post(f"/kb/{APP}/documents", files={"file": ("BRD-2027-04.pdf", BRD, "application/pdf")}, data={"doc_kind": "brd"}).json()
detail = extract(doc["id"])
check(detail["status"] == "extracted", f"extracted ({detail['status']}: {detail.get('error')})")
check("EXISTING JOURNEY STEPS" in prompts[-1] and "describes a CHANGE" in prompts[-1], "the BRD prompt carries the current steps")
items = {i["item_id"]: i for i in detail["extraction"]["items"]}
print("   counts:", detail["extraction"]["counts"])
ren = items["element:SCR_LOGIN.otp_continue"]
check(ren["action"] == "rename" and ren["selectable"] and ren["value"]["old_label"] == "CONTINUE", "CONTINUE -> RECEIVE OTP proposed as a rename")
check(any("receive_otp_button" in w for w in ren["warnings"]), "the rename warns that its crawled selector needs confirming")
rev = items[f"journey:{OTP}"]
check(rev["action"] == "revise" and rev["value"]["delta"] == {"added": [7], "removed": [7], "changed": [4]},
      f"the OTP journey revision: {rev['value']['delta']}")
check(rev["value"]["steps"][-1].get("screen_id") == "SCR_SELECT_ORG|SCR_ORG_DASHBOARD", "the either-or landing screen survives the revision")
okay = next(s for s in rev["value"]["steps"] if s.get("element_id") == "okay")
check(okay.get("branch") == "negative_only" and okay.get("expected_result"), "a revised step keeps the branch and expected result the model left out")
check("element:SCR_OTP_ENTRY.remember_device" in rev["requires"], "the revision needs the new checkbox")
check(items["rule:BR-AUTH-03"]["action"] == "modify", "BR-AUTH-03 restated")

print("2. Impact before approval")
resp = client.post(f"/kb/documents/{doc['id']}/impact", json={"selected": ["element:SCR_LOGIN.otp_continue"]})
check(resp.status_code == 200, f"impact of the rename ({resp.status_code} {resp.text[:300] if resp.status_code != 200 else ''})")
imp = resp.json()
check(imp["counts"]["test_cases"] == 1 and imp["test_cases"][0]["display_id"] == "TC-OTP-001" and imp["test_cases"][0]["steps_touched"] == [3],
      f"the OTP test case, and its step 3, are affected ({imp['test_cases']})")
check("selectors.authentication.receive_otp_button" in imp["automation"]["selectors_to_reverify"], "the RECEIVE OTP selector is to re-verify")
check(OTP in imp["crawl_journeys"], "a crawl of the OTP journey is suggested")
full = [i for i, v in items.items() if v["selectable"]]
imp_all = client.post(f"/kb/documents/{doc['id']}/impact", json={"selected": full}).json()
check(imp_all["counts"]["rules"] == 1 and OTP in [j["journey_id"] for j in imp_all["journeys"]], "the full selection's impact")

print("3. What the changes are")
kb = store.load(APP)
from app.services.journeys import documents  # noqa: E402
doc_row = db.get(app.models.kb_changes.KbSourceDocument, doc["id"])
only_rename, _, _ = documents.build_changes(kb, doc_row, selected=["element:SCR_LOGIN.otp_continue"])
check(any(c["path"] == "steps[step_number=4].action" and c["value"] == "Click RECEIVE OTP to request the one-time password" for c in only_rename),
      "a rename alone rewords the journey step that quotes CONTINUE")
all_changes, _, _ = documents.build_changes(kb, doc_row, selected=full)
check(not any(c["path"].startswith("steps[step_number=") for c in all_changes), "with the journey revised, the revision's wording wins")

print("4. Approve -> heal")
r = client.post(f"/kb/documents/{doc['id']}/draft", json={"selected": full})
check(r.status_code == 200, f"drafted ({r.status_code} {r.text[:150]})")
cs_id = r.json()["change_set"]["id"]
check(db.get(KbChangeSet, cs_id).source == "brd" and "BRD change" in db.get(KbChangeSet, cs_id).title, "a BRD change set")
impact_cs = client.get(f"/kb/change-sets/{cs_id}/impact").json()
check(impact_cs["counts"]["test_cases"] == 1, "impact is available on the draft change set too")
r = client.post(f"/kb/change-sets/{cs_id}/approve", json={"note": "BRD-2027-04"})
check(r.status_code == 200 and r.json()["heal_id"], f"approved, heal recorded ({r.status_code})")
heal = client.get(f"/kb/heals/{r.json()['heal_id']}").json()
check(heal["source"] == "brd" and heal["impact"]["counts"]["test_cases"] == 1, "the heal carries the impact")
check(len(heal["rediff"]) == 1 and heal["rediff"][0]["display_id"] == "TC-OTP-001", "only the affected case was re-diffed")
db.expire_all()
check((db.get(AutomationTestCase, affected.id).journey_diff or {}).get("refreshed_by_heal") is True, "its KB diff was refreshed")
check((db.get(AutomationTestCase, unrelated.id).journey_diff or {}).get("refreshed_by_heal") is None, "the unrelated case was not touched")
kb = store.load(APP)
el = next(e for e in kb.screens["SCR_LOGIN"]["elements"] if e["element_id"] == "otp_continue")
check(el["label"] == "RECEIVE OTP" and "continue" in el["aliases"] and el["locator_hint"] == 'button "RECEIVE OTP"', "element renamed, old label an alias")
check(kb.rules["BR-AUTH-03"]["statement"].endswith("expires after 5 minutes."), "rule restated")
otp_steps = kb.journeys[OTP]["steps"]
check(len(otp_steps) == 9 and otp_steps[6]["element_id"] == "remember_device" and not any(s.get("element_id") == "proceed" for s in otp_steps),
      "OTP journey revised: Proceed gone, Remember this device in")
check(any(e["element_id"] == "remember_device" for e in kb.screens["SCR_OTP_ENTRY"]["elements"]), "the new checkbox is on the OTP screen")

print("5. Heal actions")
r = client.post(f"/kb/heals/{heal['id']}/recheck").json()
check(r["recheck"]["queued"] == 0 and r["recheck"]["skipped"][0]["reason"] == "never went through AI Checks",
      "AI Checks re-run skips a case that never went through AI Checks")
r = client.post(f"/kb/heals/{heal['id']}/crawl", json={"journey_id": "B2B.ORDERS.SIM", "application_id": 1})
check(r.status_code == 400, "a crawl is refused for a journey the change does not touch")
check(len(client.get(f"/kb/{APP}/heals").json()["heals"]) == 1, "listed under Change & Heal")

print("6. Revert")
version_id = db.get(KbChangeSet, cs_id).published_version_id
r = client.post(f"/kb/versions/{version_id}/revert")
check(r.status_code == 200, f"reverted ({r.status_code})")
kb = store.load(APP)
check(next(e for e in kb.screens["SCR_LOGIN"]["elements"] if e["element_id"] == "otp_continue")["label"] == "CONTINUE", "label restored")
check(any(s.get("element_id") == "proceed" for s in kb.journeys[OTP]["steps"]), "Proceed step restored")
heals = client.get(f"/kb/{APP}/heals").json()["heals"]
check(len(heals) == 2 and heals[0]["source"] == "revert" and heals[0]["impact"]["counts"]["test_cases"] == 1, "the revert healed the same cases")

print("7. A screen-flow PDF never changes existing knowledge")
reply["value"] = REPLY
flow = client.post(f"/kb/{APP}/documents", files={"file": ("flow.pdf", pdf("Sign-in flow: click RECEIVE OTP"), "application/pdf")}).json()
detail = extract(flow["id"])
kinds = {i["item_id"]: i["action"] for i in detail["extraction"]["items"]}
check(kinds.get("element:SCR_LOGIN.otp_continue") == "differs" and kinds.get(f"journey:{OTP}") == "exists",
      f"differs / exists, not rename / revise ({kinds.get('element:SCR_LOGIN.otp_continue')}, {kinds.get(f'journey:{OTP}')})")
check(not any(i["action"] in ("rename", "revise", "modify") for i in detail["extraction"]["items"]), "no change item at all")
db.close()

shutil.rmtree(work, ignore_errors=True)
if failures:
    print(f"\n{len(failures)} check(s) failed")
    sys.exit(1)
print("\nall checks passed")
