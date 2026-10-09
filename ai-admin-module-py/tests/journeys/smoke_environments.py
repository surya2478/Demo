"""--- Manage environments: add, rename, reorder, delete ---------------------------------

  1. First read seeds the defaults plus any name already in use (PROD).
  2. Add QA2 after QA; a bad name and a duplicate are refused.
  3. Rename RC to RC1 everywhere: values, addresses, defaults, test cases, runs.
     Renaming SIT also keeps applications that had no default on it.
  4. Reorder.
  5. Delete: refused while an application's default or a test case uses it;
     with addresses and values only after confirming; an unused one at once.

Run from ai-admin-module-py:

    .venv312/Scripts/python.exe tests/journeys/smoke_environments.py
"""
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
work = Path(tempfile.mkdtemp())
os.environ["DATABASE_URL"] = f"sqlite:///{(work / 'env.db').as_posix()}"

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.database.connection import Base, SessionLocal, engine  # noqa: E402
import app.models.automation  # noqa: E402,F401
import app.models.kb_changes  # noqa: E402,F401
from app.models.automation import (AutomationDataApp, AutomationDataAppEnvironment, AutomationRun,  # noqa: E402
                                   AutomationTestCase, AutomationTestData)
from app.routers import test_data as test_data_router  # noqa: E402
from app.services.automation import test_data  # noqa: E402
from app.utils.security import get_current_user_strict  # noqa: E402
import app.services.authz as authz  # noqa: E402

Base.metadata.create_all(bind=engine)
failures = []


def check(condition, message):
    print(("  ok   " if condition else "  FAIL ") + message)
    if not condition:
        failures.append(message)


db = SessionLocal()
portal = AutomationDataApp(name="Portal", run_environment="RC")
legacy = AutomationDataApp(name="Legacy")  # no default of its own: SIT
db.add_all([portal, legacy])
db.flush()
db.add_all([
    AutomationDataAppEnvironment(app_id=portal.id, environment="RC", address="https://rc.example.com"),
    AutomationDataAppEnvironment(app_id=portal.id, environment="UAT", address="https://uat.example.com"),
    AutomationDataAppEnvironment(app_id=portal.id, environment="PROD", address="https://example.com"),
    AutomationTestData(app_id=portal.id, environment="RC", key="username", value="rc-user"),
    AutomationTestData(app_id=portal.id, environment="UAT", key="username", value="uat-user"),
    AutomationTestData(app_id=portal.id, environment="*", key="otp", value="123456"),
])
db.commit()

api = FastAPI()
api.include_router(test_data_router.router, prefix="/td")
api.dependency_overrides[get_current_user_strict] = lambda: {"username": "lead", "roles": ["tester"], "permissions": []}
authz.has_permission = lambda roles, perm: perm in ("automation.view", "automation.execute")
client = TestClient(api)
names = lambda body: [e["name"] for e in body["environments"]]  # noqa: E731
envs = lambda: {e["name"]: e for e in client.get("/td/environments").json()["environments"]}  # noqa: E731

print("1. Seeded")
body = client.get("/td/environments").json()
check(names(body) == ["SIT", "QA", "UAT", "RC", "PREPRODUCTION", "PROD"], f"defaults, then PROD from the data ({names(body)})")
e = envs()
check(e["RC"]["usage"] == {"test data values": 1, "application addresses": 1, "application defaults": 1}, f"RC usage {e['RC']['usage']}")
check(e["SIT"]["usage"].get("application defaults") == 1, "SIT counts the application with no default")
check(client.get("/td/apps").json()["environments"] == names(body), "Test Data offers the same list")

print("2. Add")
r = client.post("/td/environments", json={"name": "qa2", "after": "QA"})
check(r.status_code == 201 and names(r.json())[:3] == ["SIT", "QA", "QA2"], f"QA2 after QA ({names(r.json())[:4]})")
check(client.post("/td/environments", json={"name": "QA2"}).status_code == 400, "a duplicate is refused")
check(client.post("/td/environments", json={"name": "*"}).status_code == 400, "'*' is refused")
check(client.post("/td/environments", json={"name": "bad name!"}).status_code == 400, "punctuation is refused")
check(test_data.ordered_environments(["ZZ"])[:3] == ["SIT", "QA", "QA2"], "the shared order follows the list")

print("3. Rename")
db.add(AutomationRun(run_key="r1", environment="RC"))
db.commit()
r = client.patch("/td/environments/RC", json={"name": "rc1"})
check(r.status_code == 200 and "RC1" in names(r.json()) and "RC" not in names(r.json()), f"renamed ({r.status_code})")
changed = r.json()["changed"]
check(changed == {"test data values": 1, "application addresses": 1, "application defaults": 1, "runs": 1}, f"changed everywhere {changed}")
db.expire_all()
check(db.get(AutomationDataApp, portal.id).run_environment == "RC1", "the application's default follows")
check({x.environment for x in db.query(AutomationTestData)} == {"RC1", "UAT", "*"}, "values follow; '*' untouched")
check(client.patch("/td/environments/UAT", json={"name": "RC1"}).status_code == 400, "renaming onto an existing name is refused")
r = client.patch("/td/environments/SIT", json={"name": "SIT1"})
db.expire_all()
check(r.status_code == 200 and db.get(AutomationDataApp, legacy.id).run_environment == "SIT1", "renaming SIT keeps the app with no default on it")
client.patch("/td/environments/SIT1", json={"name": "SIT"})

print("4. Reorder")
r = client.put("/td/environments/order", json={"names": ["UAT", "SIT"]})
check(names(r.json())[:2] == ["UAT", "SIT"] and len(names(r.json())) == 7, f"moved, nothing lost ({names(r.json())})")

print("5. Delete")
r = client.delete("/td/environments/RC1")
check(r.status_code == 400 and "default environment of Portal" in r.json()["detail"], f"the default of an application is kept ({r.json()['detail'][:80]})")
check(envs()["RC1"]["blocked"], "the list says why")
r = client.delete("/td/environments/UAT")
check(r.status_code == 400 and "Confirm" in r.json()["detail"], f"addresses and values need confirming ({r.json()['detail']})")
r = client.delete("/td/environments/UAT?remove_data=true")
check(r.status_code == 200 and r.json()["removed"] == {"test data values": 1, "application addresses": 1}, f"deleted with them ({r.json().get('removed')})")
check("UAT" not in names(r.json()), "gone from the list")
r = client.delete("/td/environments/QA2")
check(r.status_code == 200 and r.json()["removed"] == {}, "an unused one goes at once")
check(client.delete("/td/environments/NOPE").status_code == 404, "an unknown one is 404")
try:
    tc = AutomationTestCase(environment="PREPRODUCTION", display_id="TC-1")
    db.add(tc)
    db.commit()
    r = client.delete("/td/environments/PREPRODUCTION")
    check(r.status_code == 400 and "test case" in r.json()["detail"], f"test cases targeting it keep it ({r.json()['detail'][:60]})")
except Exception as exc:  # the test case model needs more fields here
    db.rollback()
    check(False, f"test case fixture: {exc}")

db.close()
if failures:
    print(f"\n{len(failures)} check(s) failed")
    sys.exit(1)
print("\nall checks passed")
