"""
--- A browser capture, uploaded as a walk ------------------------------------------------

Against copies of the B2B Portal's Journey KB and Automation KB and a throwaway
database:

  1. The capture tool is served, and is the walk's own selector code.
  2. A capture zip (kb-capture/1) for a journey imports as a completed walk:
     each page goes to its screen, elements are found by label, one left out
     is reported not found, and an unrelated page is noted, not matched.
  3. The same pages in the page-object layout (journey.json + pages/*.json
     with locator.xpath/css) import too, their named elements as picked.
  4. The import goes through the walk's review unchanged: propose drafts
     change sets, and Generate flow drafts the journey's flow blueprint.
  5. Bad uploads are refused: not a zip, no elements, a flow, an unknown journey.

Run from ai-admin-module-py:

    .venv312/Scripts/python.exe tests/journeys/smoke_capture_import.py
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


def zip_of(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, doc in files.items():
            z.writestr(name, json.dumps(doc))
    return buf.getvalue()


ours = zip_of({"manifest.json": {"format": journey_capture.FORMAT, "host": "rc.example.com",
                                 "pages": [{"file": f"pages/{p['page_id']}.json"} for p in pages]},
               **{f"pages/{p['page_id']}.json": p for p in pages}})

print("1. The capture tool")
r = client.get("/kb/capture-tool.js")
check(r.status_code == 200 and "function uniqueXPath" in r.text and "function sweepPage" in r.text and "kb-capture/1" in r.text,
      f"served with the walk's selector code ({r.status_code}, {len(r.text)} chars)")
check(".value" not in r.text.replace("e.target", "").replace("ui.querySelector('#kb-name').value", "").replace("ui.querySelector('#kb-action').value", ""),
      "it never reads an input's value")

print("2. Our capture zip")
r = client.post(f"/kb/{APP}/journey-crawl/import", data={"journey_id": journey_id, "environment": "RC"},
                files={"file": ("capture.zip", ours, "application/zip")})
crawl = r.json()
check(r.status_code == 201 and crawl["status"] == "completed" and crawl["source"] == "capture",
      f"imported as a completed capture walk ({r.status_code} {str(crawl)[:160]})")
result = crawl.get("result") or {}
cap = result.get("capture") or {}
assigned = {p["page_id"]: p["screen_id"] for p in cap.get("pages", [])}
check(assigned.get(sid1) == sid1 and assigned.get(sid2) == sid2, f"each page went to its screen ({assigned})")
check(assigned.get("99-unrelated") is None and any("Weather" in n for n in cap.get("notes", [])), "the unrelated page is noted, not matched")
rows = {(row["screen_id"], row["element_id"]): row for row in result.get("rows", [])}
found = [row for row in rows.values() if row["screen_id"] in (sid1, sid2) and row["outcome"] in ("new", "confirmed", "healed")]
check(len(found) >= len(els1) + len(els2) - 2, f"design elements found by label ({len(found)} of {len(els1) + len(els2)})")
missing = rows.get((sid2, dropped)) or {}
check(missing.get("outcome") in ("not_found", "kb_failed", "not_applicable"), f"the element left out is reported ({missing.get('outcome')})")
check(any(e.get("name") == "Something only the app has" and not e.get("matched") for p in result.get("inventory", []) for e in p["elements"]),
      "the app-only element is in the inventory, unmatched")
check(result.get("routes") is not None and result.get("entry", {}).get("landed", "").startswith("https://rc.example.com"),
      "routes and the entry come from the captured pages")
first_id = crawl["id"]

print("3. The page-object layout")
theirs = zip_of({
    "journey.json": {"journeyId": journey_id, "steps": [{"pageId": "first", "description": "start"}]},
    "pages/first.json": {"pageId": "first", "url": f"https://rc.example.com/b2bportal/{sid1.lower()}", "elements": [
        {"name": (el.get("clean_label") or el["label"]), "role": "button",
         "locator": {"xpath": f"//*[@id='po-{el['element_id']}']", "css": f"#po-{el['element_id']}", "text": el.get("clean_label")},
         "actions": ["click"], "assertions": ["visible"]} for el in els1]},
})
r = client.post(f"/kb/{APP}/journey-crawl/import", data={"journey_id": journey_id},
                files={"file": ("page-objects.zip", theirs, "application/zip")})
other = r.json()
cap2 = (other.get("result") or {}).get("capture") or {}
check(r.status_code == 201 and cap2.get("format") == "page-objects", f"imported ({r.status_code}, format {cap2.get('format')})")
rows2 = [row for row in (other.get("result") or {}).get("rows", []) if row["screen_id"] == sid1]
check(rows2 and all(row["outcome"] in ("new", "confirmed", "healed") for row in rows2), f"its elements are found ({[r_['outcome'] for r_ in rows2]})")
check(any((row.get("selector") or "").startswith("//*[@id='po-") or row.get("strategy") == "kb" for row in rows2),
      "with the page object's xpath as the selector")

print("4. Review, propose, Generate flow")
r = client.get(f"/kb/{APP}/journey-crawls")
check(r.status_code == 200 and any(c["id"] == first_id and c["source"] == "capture" for c in r.json()["crawls"]), "listed with the walks")
r = client.post(f"/kb/journey-crawls/{first_id}/propose", json={"additions": [], "picks": []})
proposed = r.json()
check(r.status_code == 200 and (proposed.get("automation_change_set_id") or proposed.get("journey_change_set_id")),
      f"propose drafts change sets ({r.status_code} {proposed.get('automation_change_set_id')}/{proposed.get('journey_change_set_id')})")
r = client.post(f"/kb/journey-crawls/{first_id}/generate-flow")
check(r.status_code == 200 and (r.json().get("change_set") or {}).get("id"), f"Generate flow drafts the flow blueprint ({r.status_code} {r.text[:160]})")

print("5. Refused")
r = client.post(f"/kb/{APP}/journey-crawl/import", data={"journey_id": journey_id}, files={"file": ("x.zip", b"not a zip", "application/zip")})
check(r.status_code == 400, f"not a zip ({r.status_code})")
r = client.post(f"/kb/{APP}/journey-crawl/import", data={"journey_id": journey_id},
                files={"file": ("empty.json", json.dumps({"pages": [{"elements": []}]}).encode(), "application/json")})
check(r.status_code == 400, f"no elements ({r.status_code})")
r = client.post(f"/kb/{APP}/journey-crawl/import", data={"journey_id": "flow:anything"}, files={"file": ("c.zip", ours, "application/zip")})
check(r.status_code == 400, f"a flow blueprint ({r.status_code})")
r = client.post(f"/kb/{APP}/journey-crawl/import", data={"journey_id": "NO.SUCH.JOURNEY"}, files={"file": ("c.zip", ours, "application/zip")})
check(r.status_code == 404, f"an unknown journey ({r.status_code})")

print()
print("FAILED:" if failures else "All checks passed.", *failures, sep="\n  ")
sys.exit(1 if failures else 0)
