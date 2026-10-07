"""
--- A new application: register, name, rename ------------------------------------------

Against a throwaway Journey KB folder and database:

  1. Registering an application with two environments and a typed master
     topic list writes a Journey KB that loads, whose taxonomy holds those
     journeys under the given id prefix with no B2B sign-in prerequisites,
     and registers the application for Test Data and crawling.
  2. The overview works on the empty KB (no Automation KB yet).
  3. A second registration under the same name or key is refused, and an
     address-less one too.
  4. Renaming changes Test Data, the crawl registry and journey_kb.json, and
     never the key.
  5. An application added in Test Data without a KB key gets a Journey KB
     later, and its key is pinned; renaming it in Test Data keeps the key.
  6. A journey added to an empty KB lands where extraction can place it.

Run from ai-admin-module-py:

    .venv312/Scripts/python.exe tests/journeys/smoke_kb_onboarding.py
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
os.environ["JOURNEY_KB_PATH"] = str(work / "journeys")
os.environ["DATABASE_URL"] = f"sqlite:///{(work / 'kb.db').as_posix()}"

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.database.connection import Base, SessionLocal, engine  # noqa: E402
import app.models.automation  # noqa: E402,F401
import app.models.kb_changes  # noqa: E402,F401
from app.models.automation import AutomationApplication, AutomationDataApp  # noqa: E402
from app.routers import knowledge_base_page, test_data as test_data_router  # noqa: E402
from app.services.journeys import documents, store  # noqa: E402
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
api.include_router(test_data_router.router, prefix="/td")
api.dependency_overrides[get_current_user_strict] = lambda: {"username": "engineer", "roles": ["admin"], "permissions": []}
authz.has_permission = lambda roles, perm: True
client = TestClient(api)

OUTLINE = """
Accounts
  View accounts
  Search accounts
PAY | Payments
\tPay a bill
\t\tPay by card
- Support
"""

print("1. Register")
r = client.post("/kb/applications", json={
    "name": "e& Money Wallet", "addresses": {"sit": "https://sit.money.example.com/app/", "RC": "https://rc.money.example.com/app"},
    "default_environment": "RC", "outline": OUTLINE,
})
check(r.status_code == 200, f"registered ({r.status_code} {r.text[:200]})")
body = r.json()
KEY = body.get("app_key")
check(KEY == "e_money_wallet", f"key derived from the name: {KEY}")
check(body.get("journey_kb_created") is True, "a Journey KB was created")
check(body.get("default") == "RC" and set(body.get("addresses", {})) == {"SIT", "RC"}, f"environments {body.get('addresses')}")
check(bool(body.get("crawl_app_id")), "registered for crawling")
kb = store.load(KEY)
check(kb is not None and kb.app_name == "e& Money Wallet", "Journey KB loads with its name")
nodes = {n["id"]: n for n in kb.taxonomy["nodes"]}
check("MONEY.ACCOUNTS.VIEW_ACCOUNTS" in nodes, f"journey ids use the prefix: {sorted(nodes)[:4]}")
check("MONEY.PAY.PAY_BILL.PAY_CARD" in nodes, "tabs nest; 'CODE | Title' keeps its code")
check(any(n["title"] == "Support" and n["kind"] == "chapter" for n in nodes.values()), "a bulleted top-level line is a chapter")
check(all(not n.get("prerequisite_journeys") for n in nodes.values()), "no B2B sign-in prerequisites")
check(any("(master" in s for s in kb.manifest["sources"]), "the typed list is listed as the master list")

print("2. Overview on an empty KB")
r = client.get(f"/kb/{KEY}/overview")
check(r.status_code == 200, f"overview ({r.status_code} {r.text[:200]})")
check(r.json().get("base_url") is None and r.json()["automation"]["flows"] == 0, "no other application's crawl is borrowed")
check(r.json()["journeys"]["total"] == 3, f"3 leaf journeys: {r.json()['journeys']}")
r = client.get(f"/kb/{KEY}/sources")
check(r.status_code == 200 and r.json()["sources"][0]["type"] == "master_list", "the master list shows as a source")
r = client.get(f"/kb/{KEY}/registration")
check(r.status_code == 200 and r.json()["journey_kb"] and r.json()["data_app_id"], "registration reports both sides")

print("3. Refusals")
r = client.post("/kb/applications", json={"name": "e& Money Wallet", "addresses": {"SIT": "https://x.example.com"}})
check(r.status_code == 409, "same name refused")
r = client.post("/kb/applications", json={"name": "Other", "app_key": KEY, "addresses": {"SIT": "https://y.example.com"}})
check(r.status_code == 409, "same key refused")
r = client.post("/kb/applications", json={"name": "No address", "addresses": {"SIT": ""}})
check(r.status_code == 400, "an application with no address refused")
r = client.post("/kb/applications", json={"name": "Clash", "addresses": {"SIT": "https://sit.money.example.com/app"}})
check(r.status_code == 409, "another application's address refused")
check(not (work / "journeys" / "clash").exists(), "a refused registration writes no KB")

print("4. Rename")
r = client.put(f"/kb/{KEY}/name", json={"name": "e& Money"})
check(r.status_code == 200, f"renamed ({r.status_code} {r.text[:200]})")
db = SessionLocal()
data_app = db.query(AutomationDataApp).filter(AutomationDataApp.kb_app_id == KEY).first()
crawl = db.query(AutomationApplication).filter(AutomationApplication.app_key == KEY).first()
check(data_app is not None and data_app.name == "e& Money", "Test Data name changed, key kept")
check(crawl is not None and crawl.name == "e& Money", "crawl registry name changed")
check(store.load(KEY).app_name == "e& Money", "journey_kb.json name changed")
r = client.put("/kb/nothing_here/name", json={"name": "x"})
check(r.status_code == 404, "renaming an unknown application is a 404")

print("5. Journey KB later; Test Data rename keeps the key")
r = client.post("/td/apps", json={"name": "Shop Front", "addresses": {"SIT": "https://shop.example.com"}})
check(r.status_code == 200 and r.json()["kb_app_id"] is None, "added in Test Data without a key")
shop_id = r.json()["id"]
r = client.post("/kb/shop_front/journey-kb", json={})
check(r.status_code == 200 and r.json()["app_name"] == "Shop Front", f"Journey KB created later ({r.status_code} {r.text[:200]})")
db.expire_all()
check(db.get(AutomationDataApp, shop_id).kb_app_id == "shop_front", "its key is pinned")
r = client.post("/kb/shop_front/journey-kb", json={})
check(r.status_code == 409, "a second Journey KB is refused")
r = client.post("/td/apps", json={"name": "Legacy App", "addresses": {"SIT": "https://legacy.example.com"}})
legacy = r.json()
r = client.put(f"/td/apps/{legacy['id']}", json={"name": "Legacy App Renamed", "kb_app_id": None})
check(r.status_code == 200 and r.json()["kb_app_id"] == "legacy_app", f"Test Data rename pins the old key: {r.json().get('kb_app_id')}")

print("6. Add a journey to an empty KB")
r = client.post("/kb/shop_front/journeys", json={"parent_id": None, "title": "Checkout", "publish": True})
check(r.status_code == 200 and r.json().get("published"), f"chapter added ({r.status_code} {r.text[:200]})")
chapter = next(n for n in store.load("shop_front").taxonomy["nodes"] if n["title"] == "Checkout")
r = client.post("/kb/shop_front/journeys", json={"parent_id": chapter["id"], "title": "Pay with card", "publish": True})
check(r.status_code == 200 and r.json().get("published"), "journey added under it")
targets = documents.journey_targets(store.load("shop_front"))
check(any(n["title"] == "Pay with card" for n in targets.values()), "extraction can now place a journey there")

print("7. A document's unplaced journey: place it, match again without the model")
import pymupdf  # noqa: E402
from app.models.kb_changes import KbSourceDocument  # noqa: E402

pdf = pymupdf.open()
pdf.new_page().insert_text((72, 72), "Top up the wallet. Enter the Amount and click Top up.")
r = client.post(f"/kb/{KEY}/documents", files={"file": ("Top up.pdf", pdf.tobytes(), "application/pdf")}, data={"doc_kind": "screen_flow"})
check(r.status_code == 201, f"uploaded ({r.status_code} {r.text[:200]})")
doc_id = r.json()["id"]
proposal = documents.XDocument.model_validate({"journeys": [{"taxonomy_id": None, "name": "Top up the wallet", "pages": [1],
                                                             "steps": [{"action": "Click Top up", "page": 1}]}]})
kb = store.load(KEY)
doc = db.get(KbSourceDocument, doc_id)
items = documents.build_items(kb, doc, proposal, documents.read_pages(kb, doc), vision=False)
check([i["action"] for i in items if i["kind"] == "journey"] == ["no_place"], "the journey starts as not in the master list")
doc.status, doc.extraction = "extracted", {"model": "fixed", "vision": False, "pages": [], "calls": 0, "seconds": 0,
                                         "items": items, "counts": {}, "open_questions": [], "proposal": proposal.model_dump()}
db.commit()
accounts = next(n for n in kb.taxonomy["nodes"] if n["title"] == "Accounts")
r = client.post(f"/kb/documents/{doc_id}/place", json={"placements": [{"title": "Top up the wallet", "parent_id": accounts["id"]},
                                                                      {"title": "Wallet history", "parent_id": accounts["id"]}]})
check(r.status_code == 200 and r.json().get("published"), f"placed in one change set ({r.status_code} {r.text[:200]})")
journeys = [i for i in r.json()["document"]["extraction"]["items"] if i["kind"] == "journey"]
check([i["action"] for i in journeys] == ["add"] and journeys[0]["selectable"], f"matched again: {[i['action'] for i in journeys]}")
check(journeys[0].get("journey_id", "").startswith("MONEY.ACCOUNTS."), f"placed under Accounts: {journeys[0].get('journey_id')}")
r = client.post(f"/kb/documents/{doc_id}/place", json={"placements": [{"title": "Top up the wallet", "parent_id": accounts["id"]}]})
check(r.status_code == 400, "the same journey twice under one parent refused")
r = client.post(f"/kb/documents/{doc_id}/place", json={"placements": [{"title": "Cash out", "new_chapter": "Wallet"},
                                                                      {"title": "Cash in", "new_chapter": "Wallet"}]})
check(r.status_code == 200 and r.json().get("published"), f"a new chapter and its journeys in one change set ({r.status_code} {r.text[:150]})")
wallet = [n for n in store.load(KEY).taxonomy["nodes"] if n.get("parent") == "MONEY.WALLET"]
check(sorted(n["title"] for n in wallet) == ["Cash in", "Cash out"], f"both under the new chapter: {[n['title'] for n in wallet]}")
r = client.post(f"/kb/documents/{doc_id}/place", json={"placements": [{"title": "Floating"}]})
check(r.status_code == 400, "a journey with nowhere to go refused")

db.close()
print()
print("FAILED:" if failures else "All checks passed.", *failures, sep="\n  ")
sys.exit(1 if failures else 0)
