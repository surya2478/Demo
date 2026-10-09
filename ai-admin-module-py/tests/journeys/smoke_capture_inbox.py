"""
--- Captures sent straight from the tool: inbox, flow preview, edits, import ------------

Against copies of the B2B Portal's Journey KB and Automation KB and a throwaway
database:

  1. The tool knows the app's receiving page; a bad address is refused.
  2. A capture the tool sends is stored in the inbox, its application and
     environment found from the registered address; a non-capture is refused.
  3. Preview matches it to the journey as a flow without storing anything:
     pages in order with their screens and steps, objects with the design
     element each one is; an app-only object is unmatched.
  4. Edits: drop a page, reorder, rename, choose a page's screen, leave an
     object out, choose the object a step uses -- each one shows in the preview.
  5. Import stores it as a capture walk with the edits; the inbox entry is
     marked imported and cannot be imported or edited again.

Run from ai-admin-module-py:

    .venv312/Scripts/python.exe tests/journeys/smoke_capture_inbox.py
"""
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

APP = "eand_b2b_portal"
work = Path(tempfile.mkdtemp())
shutil.copytree(ROOT / "knowledge_base" / "journeys" / APP, work / "journeys" / APP)
shutil.copytree(ROOT / "knowledge_base" / "applications" / APP, work / "applications" / APP)
os.environ["JOURNEY_KB_PATH"] = str(work / "journeys")
os.environ["AUTOMATION_KB_PATH"] = str(work)
os.environ["DATABASE_URL"] = f"sqlite:///{(work / 'kb.db').as_posix()}"

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.database.connection import Base, engine  # noqa: E402
import app.models.automation  # noqa: E402,F401
import app.models.kb_changes  # noqa: E402,F401
from app.routers import knowledge_base_page  # noqa: E402
from app.services.automation import knowledge_base as automation_kb  # noqa: E402
from app.services.journeys import crawl_runs, journey_capture, store  # noqa: E402
from app.utils.security import get_current_user_strict  # noqa: E402
import app.services.authz as authz  # noqa: E402

Base.metadata.create_all(bind=engine)
failures = []


def check(condition, message):
    print(("  ok   " if condition else "  FAIL ") + message)
    if not condition:
        failures.append(message)


api = FastAPI()
api.include_router(knowledge_base_page.router, prefix="/kb")
api.dependency_overrides[get_current_user_strict] = lambda: {"username": "tester", "roles": ["admin"], "permissions": []}
authz.has_permission = lambda roles, perm: True
client = TestClient(api)

check(str(automation_kb.KB_ROOT_DIR).startswith(str(work)), f"Automation KB is the copy ({automation_kb.KB_ROOT_DIR})")
kb = store.load(APP)
journey_id, plan = None, None
for jid in kb.journeys:
    candidate = crawl_runs._plan(kb, jid, base_url="https://rc.example.com/b2bportal", profile_id=None, stop_before=None, allow_risky=True)
    if len(candidate["screens"]) >= 2:
        journey_id, plan = jid, candidate
        break
check(journey_id is not None, f"a journey with two screens to capture ({journey_id})")
screens = list(plan["screens"].items())


def page_for(sid, elements, *, drop=None, path=None):
    route = (plan["signatures"].get(sid) or {}).get("route") or path or f"/b2bportal/{sid.lower()}"
    out = []
    for n, el in enumerate(elements):
        if el["element_id"] == drop:
            continue
        label = el.get("clean_label") or el.get("label")
        out.append({"role": "button" if not el.get("is_input") else "textbox", "name": label, "tag": "button",
                    "selector": f"//*[@data-testid='{sid}-{el['element_id']}']", "chrome": False, "kind": "control"})
    out.append({"role": "link", "name": "Something only the app has", "tag": "a", "selector": f"//a[@id='extra-{sid}']",
                "chrome": False, "kind": "control"})
    return {"page_id": sid, "name": (plan["signatures"].get(sid) or {}).get("name") or sid,
            "url": f"https://rc.example.com{route}", "title": None, "elements": out, "picked": []}


(sid1, els1), (sid2, els2) = screens[0], screens[1]
dropped = els2[-1]["element_id"]
pages = [page_for(sid1, els1), page_for(sid2, els2, drop=dropped),
         {"page_id": "99-unrelated", "name": "Weather", "url": "https://rc.example.com/weather", "elements": [
             {"role": "button", "name": "Forecast", "tag": "button", "selector": "//button[@id='f']", "kind": "control"}], "picked": []}]



print("1. The tool knows where to send")
js = journey_capture.snippet_js("http://localhost:5175/automation/knowledge-base/capture-receive")
check("'http://localhost:5175/automation/knowledge-base/capture-receive'" in js and "kb-send" in js, "receiving page and Send button in the tool")
check(journey_capture.RECEIVER_PLACEHOLDER in journey_capture.snippet_js(), "without one, the placeholder the app fills in")
try:
    journey_capture.snippet_js("javascript:alert(1)")
    check(False, "a javascript: receiver is refused")
except journey_capture.CaptureError:
    check(True, "a javascript: receiver is refused")

print("2. Received into the inbox")
from app.database.connection import SessionLocal  # noqa: E402
from app.models.automation import AutomationDataApp, AutomationDataAppEnvironment  # noqa: E402
from app.models.kb_changes import KbCrawlRun  # noqa: E402

db = SessionLocal()
data_app = AutomationDataApp(name="B2B Portal", kb_app_id=APP, run_environment="RC")
db.add(data_app)
db.flush()
db.add(AutomationDataAppEnvironment(app_id=data_app.id, environment="RC", address="https://rc.example.com"))
db.commit()
r = client.post("/kb/captures", json={"capture": {"format": "something-else", "pages": []}})
check(r.status_code == 400, f"not a capture: refused ({r.status_code})")
payload = {"format": journey_capture.FORMAT, "host": "rc.example.com", "started_at": "2026-10-09T08:00:00Z", "pages": pages}
r = client.post("/kb/captures", json={"capture": payload, "origin": "https://rc.example.com"})
cap = r.json()
check(r.status_code == 201 and cap["app_id"] == APP and cap["environment"] == "RC", f"stored, matched to {cap.get('app_id')} / {cap.get('environment')}")
check(cap["status"] == "inbox" and cap["pages"] == 3 and cap["origin"] == "https://rc.example.com", "in the inbox with its pages and origin")
listed = client.get(f"/kb/captures?app_id={APP}").json()["captures"]
check([c["id"] for c in listed] == [cap["id"]], "listed for the application")
cid = cap["id"]
body = {"journey_id": journey_id, "environment": "RC"}

print("3. Preview: the capture as a flow")
before = db.query(KbCrawlRun).count()
pv = client.post(f"/kb/captures/{cid}/preview", json=body).json()
check([p["page_id"] for p in pv["pages"]] == [sid1, sid2, "99-unrelated"], f"pages in captured order ({[p['page_id'] for p in pv['pages']]})")
check(pv["pages"][0]["screen_id"] == sid1 and pv["pages"][1]["screen_id"] == sid2 and pv["pages"][2]["screen_id"] is None,
      "each page on its screen; the unrelated one on none")
first = pv["pages"][0]
used = [e for e in first["elements"] if e["uses"]]
check(len(used) == len(els1) and all(e["uses"][0]["design_label"] for e in used), f"every design element of {sid1} found ({len(used)}/{len(els1)})")
extra = next(e for e in first["elements"] if e["name"] == "Something only the app has")
check(extra["uses"] == [], "an object only the app has is unmatched")
check(db.query(KbCrawlRun).count() == before, "nothing stored by a preview")
check(any(s["page_id"] in (sid1, sid2) and s["status"] == "done" for s in pv["steps"]), "steps carry the page they were found on")

print("4. Edits")
target_step = next((s for s in pv["steps"] if s["has_element"] and s["step_number"] is not None and not s["setup"]), None)
step_choice = {str(target_step["step_number"]): {"page_id": sid2, "selector": f"//a[@id='extra-{sid2}']"}} if target_step else {}
edits = {"order": [sid2, sid1, "99-unrelated"], "dropped_pages": ["99-unrelated"], "names": {sid1: "Sign in page"},
         "screens": {sid2: ""}, "dropped_elements": {sid1: [f"//a[@id='extra-{sid1}']"]}, "steps": step_choice}
r = client.patch(f"/kb/captures/{cid}", json={"edits": edits})
check(r.status_code == 200 and r.json()["edits"]["dropped_pages"] == ["99-unrelated"], "edits saved")
pv = client.post(f"/kb/captures/{cid}/preview", json=body).json()
check([p["page_id"] for p in pv["pages"]] == [sid2, sid1], f"reordered, unrelated page dropped ({[p['page_id'] for p in pv['pages']]})")
check(pv["dropped_pages"] == [{"page_id": "99-unrelated", "name": "Weather"}], "the dropped page is listed to restore")
check(pv["pages"][1]["name"] == "Sign in page", "renamed")
check(pv["pages"][0]["screen_id"] is None and pv["pages"][0]["screen_chosen"] and pv["pages"][0]["auto_screen"] == sid2,
      "screen chosen as none; the automatic match is still shown")
check(all(e["name"] != "Something only the app has" for e in pv["pages"][1]["elements"]), "the left-out object is gone")
if target_step:
    chosen = next(s for s in pv["steps"] if s["step_number"] == target_step["step_number"] and s["kind"] == target_step["kind"])
    check(chosen["chosen"] and chosen["selector"] == f"//a[@id='extra-{sid2}']" and chosen["page_id"] == sid2,
          f"step {target_step['step_number']} uses the chosen object ({chosen['selector']})")
else:
    check(False, "a step with an element to choose for")
client.patch(f"/kb/captures/{cid}", json={"edits": {**edits, "screens": {}}})

print("5. Import")
r = client.post(f"/kb/captures/{cid}/import", json=body)
crawl = r.json()
check(r.status_code == 201 and crawl["status"] == "completed", f"imported as a walk ({r.status_code} {crawl.get('status')})")
stored = db.get(KbCrawlRun, crawl["id"])
pages_used = [p["page_id"] for p in stored.result["capture"]["pages"]]
check(pages_used == [sid2, sid1], f"the walk has the edited pages ({pages_used})")
check((stored.plan or {}).get("source") == "capture", "it is a capture walk")
listed = client.get(f"/kb/captures?app_id={APP}&include_done=true").json()["captures"]
check(listed[0]["status"] == "imported" and listed[0]["crawl_run_id"] == crawl["id"], "inbox entry marked imported")
check(client.get(f"/kb/captures?app_id={APP}").json()["captures"] == [], "and gone from the open inbox")
check(client.post(f"/kb/captures/{cid}/import", json=body).status_code == 400, "not imported twice")
check(client.patch(f"/kb/captures/{cid}", json={"edits": {}}).status_code == 400, "not edited after import")
check(client.delete(f"/kb/captures/{cid}").status_code == 204 and client.post(f"/kb/captures/{cid}/preview", json=body).status_code == 404, "deleted")

db.close()
shutil.rmtree(work, ignore_errors=True)
if failures:
    print(f"\n{len(failures)} check(s) failed")
    sys.exit(1)
print("\nall checks passed")
