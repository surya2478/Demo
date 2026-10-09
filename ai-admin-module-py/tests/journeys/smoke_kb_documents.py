"""
--- Design documents: upload, extract, review, publish, revert -------------------------

Runs the real "Sign-in using Password.pdf" through the document pipeline
against throwaway copies of the Journey KB and a throwaway database. The model
is replaced by a fixed reply shaped like a plausible one -- including the
mistakes a model makes -- so this checks everything around the model:

  1. Upload through the API: signature check, duplicate detection.
  2. Page reading: print headers/footers dropped, page images rendered.
  3. The prompt: page text fenced as data, the taxonomy and existing screens
     given as context, and the model told screenshots were not available.
  4. Review items: an existing element is shown as already there, a differing
     label is reported (not written), a label absent from the page text is
     marked inferred, an authored journey is left alone, a journey with no
     taxonomy node is not invented, links to unknown journeys are dropped.
  5. Drafting only the journey pulls in the screen, element and rule it
     depends on; the change set creates the journey file and marks the node
     detailed; nothing proposed carries a locator.
  6. Publishing writes it, the taxonomy says detailed; reverting deletes the
     new journey file and restores the taxonomy.

Run from ai-admin-module-py:

    .venv312/Scripts/python.exe tests/journeys/smoke_kb_documents.py
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
PDF = Path(r"C:\Test_AI_Agents\AI-Testing-Review\KB-Claude\Sign-in using Password.pdf")
if not PDF.exists():
    print(f"SKIPPED: {PDF} is not on this machine.")
    sys.exit(0)

work = Path(tempfile.mkdtemp())
shutil.copytree(ROOT / "knowledge_base" / "journeys", work / "journeys")
os.environ["JOURNEY_KB_PATH"] = str(work / "journeys")
# The scenario proposes Sign-in using Password as a new journey: start from a KB
# where it is not authored yet (the real KB has it since it was published).
(work / "journeys" / "eand_b2b_portal" / "journeys" / "signin_password.json").unlink(missing_ok=True)
_tax = work / "journeys" / "eand_b2b_portal" / "taxonomy.json"
_tax_doc = json.loads(_tax.read_text(encoding="utf-8"))
for _node in _tax_doc.get("nodes", []) if isinstance(_tax_doc, dict) else []:
    if _node.get("id") == "B2B.REG.EXISTING.SIGNIN.PASSWORD":
        _node["status"] = "source_available"
_tax.write_text(json.dumps(_tax_doc, indent=2), encoding="utf-8")
_overlay = work / "journeys" / "eand_b2b_portal" / "sources" / "taxonomy_overlay.json"
_overlay_doc = json.loads(_overlay.read_text(encoding="utf-8"))
for _key, _entry in _overlay_doc.items():
    if isinstance(_entry, dict) and isinstance(_entry.get("B2B.REG.EXISTING.SIGNIN.PASSWORD"), dict):
        _entry["B2B.REG.EXISTING.SIGNIN.PASSWORD"]["status"] = "source_available"
_overlay.write_text(json.dumps(_overlay_doc, indent=2), encoding="utf-8")
os.environ["DATABASE_URL"] = f"sqlite:///{(work / 'kb.db').as_posix()}"
os.environ["JOURNEY_EXTRACTION_VISION_MODEL"] = ""

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.database.connection import Base, SessionLocal, engine  # noqa: E402
import app.models.automation  # noqa: E402,F401
import app.models.kb_changes  # noqa: E402,F401
from app.routers import knowledge_base_page  # noqa: E402
from app.services.automation import llm  # noqa: E402
from app.services.journeys import changesets, documents, store  # noqa: E402
from app.config import settings  # noqa: E402
from app.utils.security import get_current_user_strict  # noqa: E402
import app.services.authz as authz  # noqa: E402

Base.metadata.create_all(bind=engine)
APP = "eand_b2b_portal"
JDIR = work / "journeys" / APP
PASSWORD = "B2B.REG.EXISTING.SIGNIN.PASSWORD"
failures = []


def check(condition, message):
    print(("  ok   " if condition else "  FAIL ") + message)
    if not condition:
        failures.append(message)


# What a model might plausibly return for this PDF -- including a label the
# text never mentions, a label worded differently from the KB, a link to a
# journey that does not exist, a journey the KB already has and one the
# master list does not.
REPLY = {
    "journeys": [
        {"taxonomy_id": PASSWORD, "name": "Sign-in using Password", "summary": "Username and password, then organization",
         "pages": [1, 2], "roles": ["ROLE_B2B_USER"],
         "next_journeys": ["B2B.REG.EXISTING.SIGNIN.SELECT_ORG", "B2B.NOT.A.JOURNEY"],
         "steps": [
             {"action": "Enter the Username shared during registration", "screen_id": "SCR_LOGIN", "element_id": "username", "page": 1},
             {"action": "Enter the password", "screen_id": "SCR_LOGIN", "element_id": "password", "page": 1},
             {"action": "Click the Sign In button", "expected_result": "The Dashboard screen appears",
              "screen_id": "SCR_LOGIN", "element_id": "sign_in", "page": 1, "rule_key": "R1"},
             {"action": "Change the expired password", "screen_id": "SCR_PASSWORD_EXPIRED", "element_id": "change_password",
              "page": 1, "branch": "alternate", "rule_key": "R3"},
             {"action": "Click the Organization", "expected_result": "The Organization Dashboard appears",
              "screen_id": "SCR_SELECT_ORG", "element_id": "org_card", "page": 2},
             {"action": "Open the ghost screen", "screen_id": "SCR_NOWHERE", "page": 2},
         ]},
        {"taxonomy_id": "B2B.REG.EXISTING.SIGNIN.OTP", "name": "Sign-in using OTP", "pages": [1],
         "steps": [{"action": "anything"}]},
        {"taxonomy_id": None, "name": "Reset a forgotten password by SMS", "pages": [2], "steps": []},
    ],
    "screens": [
        {"screen_id": "SCR_LOGIN", "name": "Login", "pages": [1], "elements": [
            {"element_id": "username", "label": "User Name or Email Address", "type": "text_input", "page": 1, "evidence": "Enter the Username"},
            {"element_id": "sign_in", "label": "Sign In", "type": "button", "page": 1, "evidence": "Click the Sign In button"},
            {"element_id": "show_password", "label": "Show password", "type": "icon_button", "page": 1, "seen_in": "screenshot"},
        ]},
        {"screen_id": "password expired", "name": "Password expired", "purpose": "Forces a new password", "pages": [1],
         "elements": [{"element_id": "change_password", "label": "Change password", "type": "button", "page": 1}]},
    ],
    "rules": [
        {"key": "R1", "statement": "Sign In needs the username and password shared during the registration process.",
         "type": "validation", "page": 1},
        {"key": "R2", "statement": "After successful authentication: if the user has a default organization, that "
         "organization's Dashboard opens directly; if not, Select a Organization to continue is shown.", "page": 1},
        {"key": "R3", "statement": "An expired password must be changed before sign-in completes.", "basis": "inferred", "page": 1},
    ],
    "open_questions": ["Is there a password expiry screen?"],
}
prompts = []
providers = []


def fake_complete_json(*, system_prompt, user_input, model_cls, **kwargs):
    prompts.append((system_prompt, user_input))
    providers.append(kwargs.get("provider"))
    return model_cls.model_validate(json.loads(json.dumps(REPLY)))


llm.complete_json = fake_complete_json

api = FastAPI()
api.include_router(knowledge_base_page.router, prefix="/kb")
api.dependency_overrides[get_current_user_strict] = lambda: {"username": "analyst", "roles": ["tester"], "permissions": []}
authz.has_permission = lambda roles, perm: perm in ("automation.view", "automation.execute")
client = TestClient(api)

print("1. Upload")
r = client.post(f"/kb/{APP}/documents", files={"file": ("notes.pdf", b"hello, not a pdf", "application/pdf")})
check(r.status_code == 400 and "not a PDF" in r.json()["detail"], f"a file named .pdf that is not one is refused ({r.status_code})")
r = client.post(f"/kb/{APP}/documents", files={"file": (PDF.name, PDF.read_bytes(), "application/pdf")}, data={"doc_kind": "screen_flow"})
doc = r.json()
check(r.status_code == 201 and doc["pages"] == 2 and doc["status"] == "uploaded", f"uploaded ({r.status_code}, {doc.get('pages')} pages)")
# The copy of the live KB may already hold documents uploaded there; this
# test tracks its own file.
mine = [f for f in (JDIR / "sources" / "documents").glob("*") if f.name.endswith("_Sign-in using Password.pdf")]
check(len(mine) == 1, "kept under sources/documents")
r = client.post(f"/kb/{APP}/documents", files={"file": ("copy.pdf", PDF.read_bytes(), "application/pdf")})
check(r.status_code == 200 and r.json()["duplicate"] and r.json()["id"] == doc["id"], "the same file again is recognised")
listing = client.get(f"/kb/{APP}/documents").json()
check(listing["vision_model"] is None and len(listing["documents"]) == 1, "listed; no vision model configured")

print("2. Pages")
pages = client.get(f"/kb/documents/{doc['id']}/pages").json()["pages"]
check(len(pages) == 2 and "Click the Sign In button" in pages[0]["text"], "page text read")
check(not any("knowledgemanagement" in p["text"] or "AM" in p["text"].split("\n")[0] for p in pages), "print header and URL footer dropped")
img = client.get(f"/kb/documents/{doc['id']}/pages/1.png")
check(img.status_code == 200 and img.content[:4] == b"\x89PNG", "page 1 rendered as a PNG")

print("3. Extract")
r = client.post(f"/kb/documents/{doc['id']}/extract")
check(r.status_code == 202 and r.json()["status"] == "extracting", f"extraction started ({r.status_code})")
for _ in range(100):
    detail = client.get(f"/kb/documents/{doc['id']}").json()
    if detail["status"] != "extracting":
        break
    time.sleep(0.1)
check(detail["status"] == "extracted", f"extracted ({detail['status']}: {detail.get('error')})")
system, user_input = prompts[0]
check("<user_content>" in user_input and "Screenshots are NOT available" in user_input, "page text fenced; told screenshots are absent")
check(PASSWORD in user_input and "SCR_LOGIN" in user_input and "Never write locators" in system, "taxonomy and existing screens given; locators forbidden")
items = {i["item_id"]: i for i in detail["extraction"]["items"]}
print("   counts:", detail["extraction"]["counts"])

check(items["element:SCR_LOGIN.sign_in"]["action"] == "exists", "'Sign In' recognised as the KB's SIGN IN")
check(items["element:SCR_LOGIN.username"]["action"] == "differs" and not items["element:SCR_LOGIN.username"]["selectable"],
      "'User Name or Email Address' vs 'Username or email*' reported, not written")
show = items["element:SCR_LOGIN.show_password"]
check(show["action"] == "add" and show["value"]["basis"] == "inferred" and show["warnings"], "a label the text never mentions is inferred and flagged")
check(show["value"]["locator_hint"] == 'button "Show password"' and show["value"]["automation_ref"] is None, "locator hint from the design words, no selector")
check("screen:SCR_PASSWORD_EXPIRED" in items and items["screen:SCR_PASSWORD_EXPIRED"]["action"] == "add", "a new screen gets a proper SCR_ id")
check(items["journey:B2B.REG.EXISTING.SIGNIN.OTP"]["action"] == "exists", "an authored journey is left alone")
check(any(i["action"] == "no_place" for i in items.values()), "a journey with no taxonomy node is reported, not invented")
check(items["rule:BR-AUTH-06"]["action"] == "exists", "a rule the KB already has is recognised")
journey = items[f"journey:{PASSWORD}"]
check(journey["action"] == "add" and len(journey["value"]["steps"]) == 6, "the Password journey is proposed with its steps")
check(any("B2B.NOT.A.JOURNEY" in w for w in journey["warnings"]) and any("SCR_NOWHERE" in w for w in journey["warnings"]),
      "unknown journey link and unknown screen reported")
check(journey["value"]["next_journeys"] == ["B2B.REG.EXISTING.SIGNIN.SELECT_ORG"], "only real journeys linked")
check(set(journey["requires"]) >= {"screen:SCR_PASSWORD_EXPIRED", "element:SCR_PASSWORD_EXPIRED.change_password"},
      f"the journey knows what it depends on ({journey['requires']})")
blob = json.dumps(detail["extraction"]["items"])
check("xpath" not in blob.lower() and "//" not in blob, "no locator anywhere in the proposal")

print("4. Draft only the journey")
r = client.post(f"/kb/documents/{doc['id']}/draft", json={"selected": [f"journey:{PASSWORD}"],
                                                       "edits": {f"journey:{PASSWORD}": {"name": "Sign-in using Password -> Dashboard"}}})
check(r.status_code == 200, f"drafted ({r.status_code} {r.text[:200]})")
out = r.json()
check(set(out["auto_included"]) >= {"screen:SCR_PASSWORD_EXPIRED", "element:SCR_PASSWORD_EXPIRED.change_password"},
      f"dependencies pulled in ({out['auto_included']})")
db = SessionLocal()
change_set = changesets.change_set_view(db.get(app.models.kb_changes.KbChangeSet, out["change_set"]["id"]))
files = {c["file"] for c in change_set["changes"]}
check({"screens.json", "business_rules.json", "journeys/signin_password.json", "sources/taxonomy_overlay.json"} <= files, f"files {sorted(files)}")
check(change_set["source"] == "extraction" and change_set["kb"] == "journey", "a Journey KB change set from extraction")
r = client.post(f"/kb/documents/{doc['id']}/draft", json={"selected": [f"journey:{PASSWORD}"]})
check(r.status_code == 400, "a second draft is refused while the first awaits review")
r = client.delete(f"/kb/documents/{doc['id']}")
check(r.status_code == 400, "the document cannot be deleted while its draft awaits review")

print("5. Publish")
version = changesets.publish(db, change_set["id"], actor="reviewer")
kb = store.load(APP)
check(PASSWORD in kb.journeys and kb.journeys[PASSWORD]["name"] == "Sign-in using Password -> Dashboard", "journey file written with the edit")
check(kb.node(PASSWORD)["status"] == "detailed", "the taxonomy now says detailed")
check("SCR_PASSWORD_EXPIRED" in kb.screens and kb.screens["SCR_PASSWORD_EXPIRED"]["elements"][0]["used_by_journeys"] == [PASSWORD],
      "the new screen and its element, linked to the journey")
check(any(r.startswith("BR-PASSWORD-") for r in kb.journeys[PASSWORD]["business_rules"]), "rules numbered for the journey")
check("show_password" not in [e["element_id"] for e in kb.screens["SCR_LOGIN"]["elements"]], "an item not kept was not written")

print("6. Revert")
changesets.revert(db, version.id, actor="reviewer")
kb = store.load(APP)
check(not (JDIR / "journeys" / "signin_password.json").exists() and PASSWORD not in kb.journeys, "the new journey file is gone")
check(kb.node(PASSWORD)["status"] == "source_available" and "SCR_PASSWORD_EXPIRED" not in kb.screens, "taxonomy and screens restored")
print("7. Step-level edits")
JKEY = f"journey:{PASSWORD}"
bad = client.post(f"/kb/documents/{doc['id']}/draft", json={"selected": [JKEY], "edits": {JKEY: {"steps": [{"from": 1, "action": " "}]}}})
check(bad.status_code == 400 and "no action" in bad.json()["detail"], "a step without an action is refused")
bad = client.post(f"/kb/documents/{doc['id']}/draft", json={"selected": [JKEY], "edits": {JKEY: {"steps": [{"from": 1, "action": "a"}, {"from": 1, "action": "b"}]}}})
check(bad.status_code == 400, "a proposed step used twice is refused")
steps_edit = [
    {"from": 2, "action": "Enter the password shared during registration", "expected_result": "The password is masked"},
    {"from": 1, "action": "Enter the Username shared during registration", "expected_result": ""},
    {"from": 3, "action": "Click SIGN IN", "expected_result": "The Dashboard screen appears"},
    {"from": 5, "action": "Click the Organization", "expected_result": "The Organization Dashboard appears"},
    {"action": "Verify the Organization Dashboard shows the organization's accounts", "expected_result": "Accounts are listed"},
]
r = client.post(f"/kb/documents/{doc['id']}/draft", json={"selected": [JKEY], "edits": {JKEY: {"steps": steps_edit}}})
check(r.status_code == 200, f"drafted with edited steps ({r.status_code} {r.text[:200]})")
out = r.json()
check(not any("SCR_PASSWORD_EXPIRED" in a for a in out["auto_included"]),
      f"removing the expired-password step drops the screen only it needed ({out['auto_included']})")
cs = changesets.change_set_view(db.get(app.models.kb_changes.KbChangeSet, out["change_set"]["id"]))
journey_file = next(c for c in cs["changes"] if c["file"] == "journeys/signin_password.json")["after"]["value"]
got = journey_file["steps"]
check([s["action"] for s in got][:3] == ["Enter the password shared during registration", "Enter the Username shared during registration", "Click SIGN IN"],
      "steps reordered and reworded")
check([s["step_number"] for s in got] == [1, 2, 3, 4, 5], "steps renumbered")
check(got[0].get("element_id") == "password" and got[2].get("element_id") == "sign_in" and got[2].get("rule", "").startswith("BR-PASSWORD-"),
      "each kept step keeps its screen, element and rule")
check(got[4].get("note") == "Added by the reviewer." and "element_id" not in got[4], "an added step carries wording only")
check("SCR_PASSWORD_EXPIRED" not in journey_file["screens"] and not any(c["file"] == "screens.json" for c in cs["changes"]),
      "no new screen written for a removed step")
check(journey_file["extraction"]["steps_edited_by_reviewer"] is True, "the journey records that its steps were edited")
changesets.discard(db, out["change_set"]["id"])

print("8. Added steps link to a screen and element")
cat = {s["screen_id"]: s for s in client.get(f"/kb/documents/{doc['id']}").json()["catalog"]}
check(cat["SCR_LOGIN"]["source"] == "kb" and any(e["element_id"] == "password" for e in cat["SCR_LOGIN"]["elements"]),
      "the catalog lists KB screens with their elements")
check(cat["SCR_PASSWORD_EXPIRED"]["source"] == "proposed" and cat["SCR_PASSWORD_EXPIRED"]["elements"][0]["element_id"] == "change_password",
      "and the screens and elements this extraction proposes")
base = [{"from": 1, "action": "Enter the Username"}]
for step, reason in (({"action": "x", "element_id": "password"}, "an element without its screen"),
                     ({"action": "x", "screen_id": "SCR_NOWHERE"}, "an unknown screen"),
                     ({"action": "x", "screen_id": "SCR_LOGIN", "element_id": "change_password"}, "an element from another screen")):
    bad = client.post(f"/kb/documents/{doc['id']}/draft", json={"selected": [JKEY], "edits": {JKEY: {"steps": base + [step]}}})
    check(bad.status_code == 400, f"refused: {reason} ({bad.status_code})")
linked = base + [
    {"action": "Enter the password", "screen_id": "SCR_LOGIN", "element_id": "password"},
    {"action": "Change the expired password", "screen_id": "SCR_PASSWORD_EXPIRED", "element_id": "change_password"},
]
r = client.post(f"/kb/documents/{doc['id']}/draft", json={"selected": [JKEY], "edits": {JKEY: {"steps": linked}}})
check(r.status_code == 200, f"drafted with linked added steps ({r.status_code} {r.text[:200]})")
out = r.json()
check({"screen:SCR_PASSWORD_EXPIRED", "element:SCR_PASSWORD_EXPIRED.change_password"} <= set(out["auto_included"]),
      f"linking an added step to a proposed element keeps it and its screen ({out['auto_included']})")
cs = changesets.change_set_view(db.get(app.models.kb_changes.KbChangeSet, out["change_set"]["id"]))
jf = next(c for c in cs["changes"] if c["file"] == "journeys/signin_password.json")["after"]["value"]
check(jf["steps"][1].get("screen_id") == "SCR_LOGIN" and jf["steps"][1].get("element_id") == "password", "the added step is linked to the KB element")
check(jf["screens"] == ["SCR_LOGIN", "SCR_PASSWORD_EXPIRED"], f"the journey lists the screens its steps use ({jf['screens']})")
new_screen = next(c for c in cs["changes"] if c["path"] == "screens[screen_id=SCR_PASSWORD_EXPIRED]")["after"]["value"]
check(new_screen["elements"][0].get("used_by_journeys") == [PASSWORD], "the proposed element records the journey that uses it")
changesets.discard(db, out["change_set"]["id"])

print("9. Re-link any step; next journeys, roles and keywords")
detail = client.get(f"/kb/documents/{doc['id']}").json()
check(any(r["rule_id"] == "BR-AUTH-06" and r["source"] == "kb" for r in detail["rule_catalog"])
      and any(r["source"] == "proposed" for r in detail["rule_catalog"]), "rules a step may cite: the KB's and the proposed ones")
check(any(j["id"] == "B2B.REG.EXISTING.SIGNIN.SELECT_ORG" and j["authored"] for j in detail["journey_catalog"]), "journeys it may link to")
kw = items[JKEY]["value"]["match_keywords"]
check("sign-in using password" in kw and "change password" in kw, f"default keywords include the name and labels only it uses ({kw})")
for step, reason in (({"from": 3, "action": "x", "rule": "BR-NOPE"}, "an unknown rule"),
                     ({"from": 3, "action": "x", "screen_id": "SCR_SELECT_ORG|SCR_ORG_DASHBOARD", "element_id": "org_card"}, "an element on an either-or screen")):
    bad = client.post(f"/kb/documents/{doc['id']}/draft", json={"selected": [JKEY], "edits": {JKEY: {"steps": [step]}}})
    check(bad.status_code == 400, f"refused: {reason} ({bad.status_code})")
for fields, reason in (({"next_journeys": ["B2B.NOT.A.JOURNEY"]}, "a next journey outside the taxonomy"),
                       ({"match_keywords": [" "]}, "no match keywords")):
    bad = client.post(f"/kb/documents/{doc['id']}/draft", json={"selected": [JKEY], "edits": {JKEY: fields}})
    check(bad.status_code == 400, f"refused: {reason} ({bad.status_code})")
relinked = [
    {"from": 3, "action": "Click SIGN IN", "screen_id": "SCR_LOGIN", "element_id": "sign_in", "rule": "BR-AUTH-06"},
    {"from": 5, "action": "Verify the landing screen", "screen_id": "SCR_SELECT_ORG|SCR_ORG_DASHBOARD", "element_id": None, "rule": None},
]
r = client.post(f"/kb/documents/{doc['id']}/draft", json={"selected": [JKEY], "edits": {JKEY: {
    "steps": relinked, "next_journeys": ["B2B.REG.EXISTING.SIGNIN.SELECT_ORG"], "roles": ["ROLE_B2B_USER"],
    "match_keywords": ["Sign In Using Password", "username and password", "e& password"]}}})
check(r.status_code == 200, f"drafted with re-linked steps ({r.status_code} {r.text[:200]})")
cs = changesets.change_set_view(db.get(app.models.kb_changes.KbChangeSet, r.json()["change_set"]["id"]))
jf = next(c for c in cs["changes"] if c["file"] == "journeys/signin_password.json")["after"]["value"]
check(jf["steps"][0].get("element_id") == "sign_in" and jf["steps"][0].get("rule") == "BR-AUTH-06", "a proposed step re-linked to another element and rule")
check(jf["steps"][1].get("screen_id") == "SCR_SELECT_ORG|SCR_ORG_DASHBOARD" and "rule" not in jf["steps"][1], "an either-or screen, and a cleared rule")
check(jf["business_rules"] == ["BR-AUTH-06"] and not any("BR-PASSWORD" in c["path"] for c in cs["changes"]),
      "the proposed rules no step cites any more are not written")
check(jf["next_journeys"] == ["B2B.REG.EXISTING.SIGNIN.SELECT_ORG"] and jf["roles"] == ["ROLE_B2B_USER"]
      and jf["match_keywords"] == ["sign in using password", "username and password", "e& password"], "next journeys, roles and keywords as set")
changesets.discard(db, r.json()["change_set"]["id"])

print("10. The reviewer adds what the model missed")
additions = [
    {"kind": "screen", "name": "User Cancelled the login", "purpose": "Shown when the request is cancelled", "page": 2},
    {"kind": "element", "screen_id": "SCR_USER_CANCELLED_THE_LOGIN", "label": "BACK TO LOGIN PAGE", "type": "button", "page": 2},
    {"kind": "element", "screen_id": "SCR_LOGIN", "label": "Remember me too", "type": "checkbox", "page": 1},
]
for bad_add, reason in (([{"kind": "screen", "name": "Sign in to Business Online", "screen_id": "SCR_LOGIN"}], "a screen that exists"),
                        ([{"kind": "element", "screen_id": "SCR_NOWHERE", "label": "x"}], "an element on no screen"),
                        ([{"kind": "element", "screen_id": "SCR_LOGIN", "label": "Password", "element_id": "password"}], "an element id taken")):
    bad = client.post(f"/kb/documents/{doc['id']}/draft", json={"selected": [JKEY], "additions": bad_add})
    check(bad.status_code == 400, f"refused: {reason} ({bad.status_code})")
steps = [{"from": 1, "action": "Enter the Username"},
         {"action": "Go back to the login page", "screen_id": "SCR_USER_CANCELLED_THE_LOGIN", "element_id": "back_to_login_page"}]
imp = client.post(f"/kb/documents/{doc['id']}/impact", json={"selected": [JKEY], "additions": additions, "edits": {JKEY: {"steps": steps}}})
check(imp.status_code == 200, f"impact includes the additions ({imp.status_code} {imp.text[:150]})")
r = client.post(f"/kb/documents/{doc['id']}/draft", json={"selected": [JKEY], "additions": additions, "edits": {JKEY: {"steps": steps}}})
check(r.status_code == 200, f"drafted with additions ({r.status_code} {r.text[:200]})")
cs_row = db.get(app.models.kb_changes.KbChangeSet, r.json()["change_set"]["id"])
cs = changesets.change_set_view(cs_row)
screen = next(c for c in cs["changes"] if c["path"] == "screens[screen_id=SCR_USER_CANCELLED_THE_LOGIN]")["after"]["value"]
check(screen["elements"][0]["label"] == "BACK TO LOGIN PAGE" and screen["elements"][0]["locator_hint"] == 'button "BACK TO LOGIN PAGE"'
      and "Added by the reviewer" in screen["elements"][0]["note"], "the added screen carries the added element, marked as the reviewer's")
check(any(c["path"] == "screens[screen_id=SCR_LOGIN].elements[element_id=remember_me_too]" for c in cs["changes"]), "an element added to a KB screen")
check(sorted(cs_row.origin["document"]["added_by_reviewer"]) == ["element:SCR_LOGIN.remember_me_too", "element:SCR_USER_CANCELLED_THE_LOGIN.back_to_login_page", "screen:SCR_USER_CANCELLED_THE_LOGIN"],
      "the change set records what the reviewer added")
changesets.discard(db, cs_row.id)
r = client.delete(f"/kb/documents/{doc['id']}")
check(r.status_code == 204 and not mine[0].exists(), "deleted with its file")

print("11. A journey shared by its variants (Registering to the B2B Portal)")
import pymupdf  # noqa: E402
REG, OWNER = "B2B.REG.EXISTING.REGISTER", "B2B.REG.EXISTING.REGISTER.OWNER"
REPLY.clear()
REPLY.update({
    "journeys": [
        {"taxonomy_id": REG, "name": "Registering to the B2B Portal", "pages": [1],
         "steps": [{"action": "Click REGISTER", "screen_id": "SCR_LOGIN", "element_id": "register", "page": 1},
                   {"action": "Click Sign in with UAE PASS", "screen_id": "SCR_REGISTER_ONLINE", "element_id": "sign_in_with_uae_pass", "page": 1}]},
        {"taxonomy_id": OWNER, "name": "Register as Owner", "pages": [1],
         "steps": [{"action": "Click CONTINUE", "screen_id": "SCR_REGISTER_ONLINE", "element_id": "continue", "page": 1}]},
    ],
    "screens": [{"screen_id": "SCR_REGISTER_ONLINE", "name": "Register Online", "pages": [1],
                 "elements": [{"element_id": "sign_in_with_uae_pass", "label": "Sign in with UAE PASS", "type": "button", "page": 1},
                              {"element_id": "continue", "label": "CONTINUE", "type": "button", "page": 1}]}],
    "rules": [],
})
pdf_doc = pymupdf.open()
pdf_doc.new_page().insert_text((40, 60), "Register Online. Sign in with UAE PASS. CONTINUE", fontsize=10)
reg = client.post(f"/kb/{APP}/documents", files={"file": ("reg.pdf", pdf_doc.tobytes(), "application/pdf")}).json()
client.post(f"/kb/documents/{reg['id']}/extract")
for _ in range(100):
    detail = client.get(f"/kb/documents/{reg['id']}").json()
    if detail["status"] != "extracting":
        break
    time.sleep(0.1)
check("shared by its variants" in prompts[-1][1] and REG in prompts[-1][1], "the prompt offers the shared journey")
items = {i["item_id"]: i for i in detail["extraction"]["items"]}
check(items.get(f"journey:{REG}", {}).get("action") == "add", "the shared registration journey is proposed")
check(items[f"journey:{OWNER}"]["value"]["prerequisite_journeys"] == [REG], "the Owner variant runs after it")
r = client.post(f"/kb/documents/{reg['id']}/draft", json={"selected": [f"journey:{REG}", f"journey:{OWNER}"]})
check(r.status_code == 200, f"drafted ({r.status_code} {r.text[:150]})")
changesets.publish(db, r.json()["change_set"]["id"], actor="reviewer")
kb = store.load(APP)
check(kb.node(REG)["status"] == "detailed" and kb.node(OWNER)["status"] == "detailed", "the shared journey and the variant are detailed")
check(kb.node("B2B.REG.EXISTING.REGISTER.POA")["status"] == "source_available", "the other variants are unchanged")
chain = [j["journey_id"] for j in store.journey_chain(kb, kb.journeys[OWNER])]
check(chain == [REG, OWNER], f"the Owner journey runs the shared steps first ({chain})")
db.close()

print("Extraction provider")
check(providers and set(providers) == {"azure"}, f"page text goes to Azure (JOURNEY_EXTRACTION_PROVIDER) ({set(providers)})")
check(documents.text_model().startswith("azure"), f"extraction records the Azure deployment ({documents.text_model()})")
settings.JOURNEY_EXTRACTION_PROVIDER = ""
check(documents.text_provider() is None, "empty setting falls back to the Automation LLM choice")
settings.JOURNEY_EXTRACTION_PROVIDER = "azure"

shutil.rmtree(work, ignore_errors=True)
if failures:
    print(f"\n{len(failures)} check(s) failed")
    sys.exit(1)
print("\nall checks passed")
