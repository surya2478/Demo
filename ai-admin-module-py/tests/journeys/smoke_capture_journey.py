"""
--- A new journey from a browser capture -----------------------------------------------

Against copies of the B2B Portal's Journey KB and Automation KB and a throwaway
database, a capture of ordering a plan (dashboard -> Shop and Manage
Subscriptions -> Mobile Plans):

  1. Draft: open the first page, click the object that names the next page
     (the Order link, the Plans card), fill what was picked as a field.
  2. A new journey under a chapter: one change set -- added_nodes, the journey
     file, new screens with the pages' objects, the taxonomy node -- published,
     and the journey is then in the KB with its steps.
  3. The capture then matches the new journey: its click steps are found.
  4. An existing journey of the master list with no steps can be the target.
  5. Refused: a journey that already has steps, a group, no place, no steps.

Run from ai-admin-module-py:

    .venv312/Scripts/python.exe tests/journeys/smoke_capture_journey.py
"""
import os
import shutil
import sys
import tempfile
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

from app.database.connection import Base, SessionLocal, engine  # noqa: E402
import app.models.automation  # noqa: E402,F401
import app.models.kb_changes  # noqa: E402,F401
from app.routers import knowledge_base_page  # noqa: E402
from app.services.journeys import journey_capture, store  # noqa: E402
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
api.dependency_overrides[get_current_user_strict] = lambda: {"username": "lead", "roles": ["admin"], "permissions": []}
authz.has_permission = lambda roles, perm: True
client = TestClient(api)
HOST = "https://rc.example.com"


def ctl(name, sel, role="clickable", **kw):
    return {"role": role, "name": name, "tag": "div", "selector": sel, "kind": "control", "chrome": False, **kw}


pages = [
    {"page_id": "01-dashboard", "name": "Organization Dashboard", "url": f"{HOST}/b2bportal/app/accounts/dashboard360", "elements": [
        ctl("Dashboard", "//a[@id='nav-dash']", "link", chrome=True), ctl("Order", "//a[@id='nav-order']", "link", chrome=True),
        ctl("Pay", "//a[@id='nav-pay']", "link", chrome=True), ctl("ACCOUNTS", "//div[@id='w-accounts']")], "picked": []},
    {"page_id": "02-shop", "name": "Shop and Manage Subscriptions", "url": f"{HOST}/b2bportal/app/order/shop", "elements": [
        ctl("Order", "//a[@id='nav-order']", "link", chrome=True), ctl("Mobile Plans", "//div[@id='menu-mobile']"),
        ctl("Fixed Services", "//div[@id='menu-fixed']"), ctl("Add-Ons", "//div[@id='card-addons']"),
        {"role": "heading", "name": "Shop and Manage Subscriptions", "tag": "h1", "selector": "//h1", "kind": "text"},
        {"role": "heading", "name": "New Subscriptions", "tag": "h2", "selector": "//h2", "kind": "text"}], "picked": []},
    {"page_id": "03-plans", "name": "Mobile Plans", "url": f"{HOST}/b2bportal/app/order/mobile-plans", "elements": [
        {"role": "heading", "name": "Mobile Plans", "tag": "h1", "selector": "//h1[2]", "kind": "text"},
        ctl("Business Plan 150", "//div[@id='plan-150']"), ctl("Business Plan 250", "//div[@id='plan-250']")],
     "picked": [{"name": "Search plans", "role": "input", "tag": "input", "selector": "//input[@id='q']", "action": "fill"},
                {"name": "Add to cart", "role": "button", "tag": "button", "selector": "//button[@id='add']", "action": "click"}]},
]
r = client.post("/kb/captures", json={"capture": {"format": journey_capture.FORMAT, "host": "rc.example.com", "pages": pages}})
cid = r.json()["id"]
client.patch(f"/kb/captures/{cid}", json={"app_id": APP, "environment": "RC"})

print("1. Draft steps")
d = client.get(f"/kb/captures/{cid}/journey-draft").json()
acts = [s["action"] for s in d["steps"]]
check(acts[0] == "Open Organization Dashboard", f"opens the first page ({acts[0]})")
check("Click 'Order'" in acts, f"the Order link leads to the shop ({acts})")
check("Click 'Mobile Plans'" in acts, "the Mobile Plans menu row leads to Mobile Plans")
check("Enter Search plans" in acts, "the picked field is filled")
check(d["title"] == "Mobile Plans" and len(d["pages"]) == 3, f"title from the last page ({d['title']})")
check(any(o["name"] == "Business Plan 150" for o in d["pages"][2]["objects"]), "objects listed per page")

print("2. A new journey under a chapter")
kb = store.load(APP)
chapter = next(n for n in kb.taxonomy["nodes"] if n["kind"] == "chapter")
steps = d["steps"] + [{"action": "Click 'Add to cart'", "expected_result": "The plan is in the cart", "page_id": "03-plans", "selector": "//button[@id='add']"}]
r = client.post(f"/kb/captures/{cid}/journey", json={"parent_id": chapter["id"], "title": "Order a mobile plan", "steps": steps})
res = r.json()
jid = res.get("journey_id")
check(r.status_code == 200 and res.get("published"), f"drafted and published ({r.status_code} {res.get('message') or ''})")
files = sorted({c["file"] for c in res["change_set"]["changes"]})
check("screens.json" in files and "sources/taxonomy_overlay.json" in files and any(f.startswith("journeys/") for f in files),
      f"one change set: screens, taxonomy, journey file ({files})")
kb = store.load(APP)
journey = kb.journeys.get(jid)
check(journey is not None and len(journey["steps"]) == len(steps), f"{jid} is in the KB with {len(steps)} steps")
check(kb.node(jid)["status"] == "detailed" and kb.node(jid)["parent"] == chapter["id"], "placed under the chapter, detailed")
check(jid in [n["id"] for n in kb.taxonomy["nodes"] if n["kind"] in ("journey", "variant")], "listed as a journey")
shop = next(s for s in journey["screens"] if kb.screens[s]["name"] == "Shop and Manage Subscriptions")
labels = {e["label"] for e in kb.screens[shop]["elements"]}
check({"Mobile Plans", "Fixed Services", "Add-Ons", "New Subscriptions"} <= labels, f"new screen holds the page's objects ({sorted(labels)})")
order_step = next(st for st in journey["steps"] if st["action"] == "Click 'Order'")
dash = kb.screens[order_step["screen_id"]]
check(order_step["screen_id"] == "SCR_ORG_DASHBOARD" and next(e for e in dash["elements"] if e["element_id"] == order_step["element_id"])["label"] == "Order",
      f"the dashboard page is the KB's dashboard screen; the step uses its Order element ({order_step['screen_id']}.{order_step.get('element_id')})")
check(kb.screens[shop]["route"] == "/b2bportal/app/order/shop", "with its route")
mobile = next(e for e in kb.screens[shop]["elements"] if e["label"] == "Mobile Plans")
check(mobile["used_by_journeys"] == [jid] and mobile["type"] == "control" and "selector" not in str(mobile).lower().replace("locator_hint", ""),
      "elements: used by the journey, typed, no selector (that is the Automation KB's)")
step_add = journey["steps"][-1]
check(step_add.get("element_id") == "add_to_cart" and step_add["screen_id"] == journey["screens"][-1], "the last step points at its element")

print("3. The capture matches the new journey")
pv = client.post(f"/kb/captures/{cid}/preview", json={"journey_id": jid, "environment": "RC"}).json()
done = [s for s in pv["steps"] if s["status"] == "done" and s["has_element"]]
check(len(done) >= 3, f"its click and fill steps are found ({len(done)} found: {[s['element_label'] for s in done]})")

print("4. An existing journey with no steps")
kb = store.load(APP)
waiting = next(n for n in kb.taxonomy["nodes"] if n["kind"] == "journey" and n["id"] not in kb.journeys and n.get("status") == "awaiting_source")
r = client.post(f"/kb/captures/{cid}/journey", json={"journey_id": waiting["id"], "steps": d["steps"][:2]})
check(r.status_code == 200 and r.json()["journey_id"] == waiting["id"] and r.json().get("published"), f"{waiting['title']} gets the steps ({r.status_code})")
kb = store.load(APP)
check(waiting["id"] in kb.journeys and kb.journeys[waiting["id"]]["name"] == waiting["title"], "it keeps its name and place")

print("5. Refused")
check(client.post(f"/kb/captures/{cid}/journey", json={"journey_id": jid, "steps": d["steps"]}).status_code == 400, "a journey that already has steps")
group = next(n for n in kb.taxonomy["nodes"] if n["kind"] == "group")
check(client.post(f"/kb/captures/{cid}/journey", json={"journey_id": group["id"], "steps": d["steps"]}).status_code == 400, "a group")
check(client.post(f"/kb/captures/{cid}/journey", json={"title": "Nowhere", "steps": d["steps"]}).status_code == 400, "no place in the master list")
check(client.post(f"/kb/captures/{cid}/journey", json={"parent_id": chapter["id"], "title": "X", "steps": []}).status_code == 422, "no steps")
check(client.post(f"/kb/captures/{cid}/journey", json={"parent_id": chapter["id"], "title": "Y",
                                                       "steps": [{"action": "Click", "page_id": "nope"}]}).status_code == 400, "a step on a page not in the capture")

shutil.rmtree(work, ignore_errors=True)
if failures:
    print(f"\n{len(failures)} check(s) failed")
    sys.exit(1)
print("\nall checks passed")
