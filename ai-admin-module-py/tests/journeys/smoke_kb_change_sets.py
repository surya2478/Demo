"""
--- Knowledge Base change sets: draft, publish, conflict, revert ----------------------

Runs against throwaway copies of both Knowledge Bases -- the Journey KB and
the committed (crawl-derived) Automation KB from git -- and a throwaway SQLite
database, so nothing on disk that the application reads is touched.

  1. A Reconcile decision ("the app is right") becomes a Journey KB change set
     that renames the element, keeps the old label as an alias and rewords the
     journey step; publishing it writes the files and makes the diff agree.
  2. A change set drafted against a value that changed since is refused as a
     conflict and writes nothing.
  3. Versions revert exactly, and only newest-first on the same files.
  4. The Automation KB accepts changes only from a crawl or QA.
  5. A defect is recorded without touching a file or creating a version.
  6. Editing the taxonomy overlay regenerates taxonomy.json.
  7. The API enforces execute to draft and approve to publish.

Run from ai-admin-module-py:

    .venv312/Scripts/python.exe tests/journeys/smoke_kb_change_sets.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

work = Path(tempfile.mkdtemp())
shutil.copytree(ROOT / "knowledge_base" / "journeys", work / "journeys")
auto = work / "automation" / "applications" / "eand_b2b_portal"
(auto / "flows").mkdir(parents=True)
for rel in ("app_profile.json", "flows/flow_b2b_login_otp.json", "flows/flow_b2b_manage_trade_license.json"):
    text = subprocess.run(
        ["git", "show", f"HEAD:ai-admin-module-py/knowledge_base/applications/eand_b2b_portal/{rel}"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=True,
    ).stdout
    (auto / rel).write_text(text, encoding="utf-8")
os.environ["JOURNEY_KB_PATH"] = str(work / "journeys")
os.environ["AUTOMATION_KB_PATH"] = str(work / "automation")
os.environ["DATABASE_URL"] = f"sqlite:///{(work / 'kb.db').as_posix()}"

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.database.connection import Base, SessionLocal, engine  # noqa: E402
import app.models.automation  # noqa: E402,F401
import app.models.kb_changes  # noqa: E402,F401
from app.routers import knowledge_base_page  # noqa: E402
from app.services.journeys import changesets, diff, store  # noqa: E402
from app.services.automation import knowledge_base as automation_kb  # noqa: E402
from app.utils.security import get_current_user_strict  # noqa: E402

Base.metadata.create_all(bind=engine)
APP = "eand_b2b_portal"
JDIR = work / "journeys" / APP
failures = []


def check(condition, message):
    print(("  ok   " if condition else "  FAIL ") + message)
    if not condition:
        failures.append(message)


def element(screen_id, element_id):
    kb = store.load(APP)
    return next(e for e in kb.screens[screen_id]["elements"] if e["element_id"] == element_id)


check(str(automation_kb.get_kb_root()).startswith(str(work)), "Automation KB resolved to the throwaway copy")
db = SessionLocal()

print("1. Reconcile decision -> change set -> publish")
before_screens = (JDIR / "screens.json").read_text(encoding="utf-8")
row = next(r for r in diff.reconcile_elements(store.load(APP), automation_kb.load_app_profile(APP))["rows"]
           if r["element_id"] == "otp_continue")
check(row["status"] == "LABEL_DRIFT", f"otp_continue starts as LABEL_DRIFT ({row['status']})")
cs = changesets.reconcile_decision(db, app_id=APP, decision="app", screen_id="SCR_LOGIN", element_id="otp_continue",
                                   app_label="RECEIVE OTP", actor="author")
files = sorted({c.file for c in cs.changes})
check(cs.status == "draft" and files == ["journeys/signin_otp.json", "screens.json"], f"draft touches {files}")
check((JDIR / "screens.json").read_text(encoding="utf-8") == before_screens, "a draft writes nothing")
v1 = changesets.publish(db, cs.id, actor="reviewer")
check(v1.number == 1 and cs.status == "published", f"published as version {v1.number}")
el = element("SCR_LOGIN", "otp_continue")
check(el["label"] == "RECEIVE OTP" and "continue" in el["aliases"], f"label now {el['label']!r}, old label kept as alias")
step4 = next(s for s in store.load(APP).journeys["B2B.REG.EXISTING.SIGNIN.OTP"]["steps"] if s["step_number"] == 4)
check(step4["action"] == "Click RECEIVE OTP to request the one-time password", f"journey step reworded: {step4['action']!r}")
row = next(r for r in diff.reconcile_elements(store.load(APP), automation_kb.load_app_profile(APP))["rows"]
           if r["element_id"] == "otp_continue")
check(row["status"] == "MATCH", f"otp_continue is now MATCH ({row['status']})")
match = store.match_journey("user clicks continue to request the otp", APP)
check(match is not None, "old wording still finds the journey (alias kept)")

print("2. Conflict")
path = "screens[screen_id=SCR_LOGIN].elements[element_id=username].label"
a = changesets.draft(db, app_id=APP, kb="journey", title="A", changes=[{"file": "screens.json", "op": "set", "path": path, "value": "Email"}])
b = changesets.draft(db, app_id=APP, kb="journey", title="B", changes=[{"file": "screens.json", "op": "set", "path": path, "value": "E-mail address"}])
va = changesets.publish(db, a.id, actor="reviewer")
snapshot = (JDIR / "screens.json").read_text(encoding="utf-8")
try:
    changesets.publish(db, b.id, actor="reviewer")
    check(False, "B should conflict")
except changesets.Conflict as exc:
    check(exc.conflicts[0]["path"] == path, "B is refused as a conflict on the same path")
db.refresh(b)
check(b.status == "conflicted", "B is marked conflicted")
check((JDIR / "screens.json").read_text(encoding="utf-8") == snapshot, "a conflict writes nothing")

print("3. Revert")
try:
    changesets.revert(db, v1.id, actor="reviewer")
    check(False, "v1 must not revert over A")
except changesets.Conflict:
    check(True, "v1 cannot be reverted while a later version changed the same file")
undo_a = changesets.revert(db, va.id, actor="reviewer")
check(element("SCR_LOGIN", "username")["label"] == "Username or email*", "reverting A restores the label")
undo_1 = changesets.revert(db, v1.id, actor="reviewer")
check((JDIR / "screens.json").read_text(encoding="utf-8") == before_screens, "reverting v1 restores screens.json byte for byte")
check(undo_a.number == 3 and undo_1.number == 4, f"reverts are versions too ({undo_a.number}, {undo_1.number})")
try:
    changesets.revert(db, v1.id, actor="reviewer")
    check(False, "double revert")
except changesets.ChangeSetError:
    check(True, "a version reverts once")

print("4. Automation KB guard")
try:
    changesets.draft(db, app_id=APP, kb="automation", title="hand edit", source="manual",
                     changes=[{"file": "app_profile.json", "op": "set", "path": "selectors.authentication.username_field", "value": "#x"}])
    check(False, "manual automation edit accepted")
except changesets.ChangeSetError:
    check(True, "a manual change to the Automation KB is refused")
crawl = changesets.draft(db, app_id=APP, kb="automation", title="crawl capture", source="crawl",
                         changes=[{"file": "app_profile.json", "op": "set", "path": "selectors.authentication.tab_otp", "value": "getByRole('tab', {name: 'Sign in using OTP'})"}])
check(crawl.status == "draft", "a crawl may propose Automation KB changes")

print("5. Defect")
defect = changesets.reconcile_decision(db, app_id=APP, decision="design", screen_id="SCR_LOGIN", element_id="otp_continue", app_label="RECEIVE OTP")
check(defect.kind == "defect" and not defect.changes, "a defect has no file changes")
check(changesets.publish(db, defect.id, actor="reviewer") is None and defect.status == "published", "approving a defect creates no version")

print("6. Taxonomy regenerates from the overlay")
tax_before = json.loads((JDIR / "taxonomy.json").read_text(encoding="utf-8"))
overlay = changesets.draft(db, app_id=APP, kb="journey", title="note", changes=[{
    "file": "sources/taxonomy_overlay.json", "op": "set",
    "path": 'nodes["B2B.REG.EXISTING.SIGNIN.PASSWORD"].note', "value": "Extraction scheduled",
}])
changesets.publish(db, overlay.id, actor="reviewer")
node = next(n for n in json.loads((JDIR / "taxonomy.json").read_text(encoding="utf-8"))["nodes"] if n["id"] == "B2B.REG.EXISTING.SIGNIN.PASSWORD")
check(node.get("note") == "Extraction scheduled", "taxonomy.json rebuilt with the overlay change")
check(len(tax_before["nodes"]) == 253, "taxonomy still 253 nodes")

print("7. API permissions")
api = FastAPI()
api.include_router(knowledge_base_page.router, prefix="/kb")
user = {"username": "exec-only", "role": "tester", "roles": ["tester"], "permissions": []}
api.dependency_overrides[get_current_user_strict] = lambda: user
client = TestClient(api)
import app.services.authz as authz  # noqa: E402
authz_has = authz.has_permission
authz.has_permission = lambda roles, perm: perm in ("automation.view", "automation.execute")
r = client.post(f"/kb/{APP}/reconcile/decide", json={"decision": "both", "screen_id": "SCR_LOGIN", "element_id": "otp_continue", "app_label": "RECEIVE OTP"})
check(r.status_code == 200 and r.json()["status"] == "draft", f"execute may draft ({r.status_code})")
r2 = client.post(f"/kb/change-sets/{r.json()['id']}/approve", json={})
check(r2.status_code == 403, f"execute may not approve ({r2.status_code})")
authz.has_permission = lambda roles, perm: True
r3 = client.post(f"/kb/change-sets/{r.json()['id']}/approve", json={"note": "ok"})
check(r3.status_code == 200 and r3.json()["version"]["number"] >= 1, f"approve publishes ({r3.status_code})")
listing = client.get(f"/kb/{APP}/change-sets").json()
check(listing["pending"] == 2, f"pending counts drafts and conflicts ({listing['pending']})")
check(len(client.get(f"/kb/{APP}/versions").json()["versions"]) >= 6, "versions listed")
# B was drafted against the original label; the reverts put that label back,
# so B no longer conflicts and publishes -- the check is on the value, not on
# history. A fresh pair makes the 409.
check(client.post(f"/kb/change-sets/{b.id}/approve", json={}).status_code == 200, "a conflict clears once the file matches again")
x = changesets.draft(db, app_id=APP, kb="journey", title="X", changes=[{"file": "screens.json", "op": "set", "path": path, "value": "X"}])
y = changesets.draft(db, app_id=APP, kb="journey", title="Y", changes=[{"file": "screens.json", "op": "set", "path": path, "value": "Y"}])
changesets.publish(db, x.id, actor="reviewer")
r4 = client.post(f"/kb/change-sets/{y.id}/approve", json={})
check(r4.status_code == 409 and r4.json()["detail"]["conflicts"], "a conflict answers 409 with the details")
authz.has_permission = authz_has

db.close()
shutil.rmtree(work, ignore_errors=True)
if failures:
    print(f"\n{len(failures)} check(s) failed")
    sys.exit(1)
print("\nall checks passed")
