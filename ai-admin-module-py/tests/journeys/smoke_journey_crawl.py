"""
--- Journey-guided crawl, in a real browser ---------------------------------------------

Serves tests/journeys/fixture_portal -- a stand-in for the B2B Portal shaped
like the design PDFs and the live labels -- builds a crawl plan for "Select
Organization" (which runs after "Sign-in using OTP") from the real Journey KB,
runs the generated spec through the project's own Playwright runner exactly as
a queued run would, then evaluates the result and drafts, pairs and publishes
the proposed change sets against throwaway copies of both Knowledge Bases.

What it proves:
  1. The plan walks the chain in order with the right actions and variables.
  2. The spec runs: it signs in with vault-style TESTDATA_* values, enters
     the OTP digit by digit, chooses the organization and reaches the dashboard.
  3. Known Automation KB selectors are confirmed; missing elements are
     captured with a selector that matches exactly one element; a design
     element the page does not have (Proceed) is reported, not invented.
  4. Values never appear in the result.
  5. Proposals: selectors for the Automation KB (source crawl) and links for
     the Journey KB, paired; approving the Journey KB half publishes both, and
     Reconcile then reports the captured elements as MATCH.

Needs the Playwright runtime the Automation Module uses. Run from ai-admin-module-py:

    .venv312/Scripts/python.exe tests/journeys/smoke_journey_crawl.py
"""
import asyncio
import functools
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

work = Path(tempfile.mkdtemp())
shutil.copytree(ROOT / "knowledge_base" / "journeys", work / "journeys")
auto = work / "automation" / "applications" / "eand_b2b_portal"
(auto / "flows").mkdir(parents=True)
for rel in ("app_profile.json", "flows/flow_b2b_login_otp.json"):
    text = subprocess.run(["git", "show", f"HEAD:ai-admin-module-py/knowledge_base/applications/eand_b2b_portal/{rel}"],
                          cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=True).stdout
    (auto / rel).write_text(text, encoding="utf-8")
os.environ["JOURNEY_KB_PATH"] = str(work / "journeys")
os.environ["AUTOMATION_KB_PATH"] = str(work / "automation")
os.environ["DATABASE_URL"] = f"sqlite:///{(work / 'kb.db').as_posix()}"

from app.database.connection import Base, SessionLocal, engine  # noqa: E402
import app.models.automation  # noqa: E402,F401
import app.models.kb_changes  # noqa: E402,F401
from app.models.kb_changes import KbChangeSet  # noqa: E402
from app.services.automation import knowledge_base as automation_kb  # noqa: E402
from app.services.automation import workspace as ws  # noqa: E402
from app.services.automation.local_playwright import LocalPlaywrightRunner  # noqa: E402
from app.services.automation.preflight import is_ready  # noqa: E402
from app.services.journeys import changesets, diff, journey_crawl, store  # noqa: E402

Base.metadata.create_all(bind=engine)
APP = "eand_b2b_portal"
failures = []


def check(condition, message):
    print(("  ok   " if condition else "  FAIL ") + message)
    if not condition:
        failures.append(message)


if not is_ready():
    print("SKIPPED: the Playwright runtime is not available on this machine.")
    sys.exit(0)

# --- Serve the fixture portal ---------------------------------------------------------
handler = functools.partial(SimpleHTTPRequestHandler, directory=str(ROOT / "tests" / "journeys" / "fixture_portal"))
handler.log_message = lambda *a, **k: None
server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{server.server_address[1]}/b2bportal/login.html?rdr=home&locale=en"

print("1. Plan")
kb = store.load(APP)
profile = automation_kb.load_app_profile(APP)
plan = journey_crawl.build_plan(kb, "B2B.REG.EXISTING.SIGNIN.SELECT_ORG", automation_profile=profile, base_url=BASE)
kinds = [(i["journey_id"].split(".")[-1], i["step_number"], i["kind"]) for i in plan["items"]]
check(plan["scope"] == ["B2B.REG.EXISTING.SIGNIN.OTP", "B2B.REG.EXISTING.SIGNIN.SELECT_ORG"], f"scope {plan['scope']}")
check(all(i["setup"] == (i["journey_id"] != "B2B.REG.EXISTING.SIGNIN.SELECT_ORG") for i in plan["items"]), "sign-in steps are setup")
check(plan["profile_id"] == "USER_MULTI_ORG_NO_DEFAULT", f"crawl profile {plan['profile_id']}")
check(("OTP", 1, "goto") in kinds and ("OTP", 3, "fill") in kinds and ("OTP", 4, "click") in kinds and ("OTP", 6, "otp") in kinds,
      "sign-in: navigate, fill email, click RECEIVE OTP, enter OTP")
check(not any(k[0] == "OTP" and k[2] == "skip" for k in kinds), "the setup journey's error path is left out")
check(("SELECT_ORG", 6, "click") in kinds, "choose the organization card")
check(plan["variables"] == ["TESTDATA_MULTI_ORG_EMAIL", "TESTDATA_ORG_NAME", "TESTDATA_OTP"], f"variables {plan['variables']}")

print("2. Run in a real browser")
spec = journey_crawl.build_spec(plan)
from app.services.automation import test_data  # noqa: E402
check(sorted(test_data.required_names(spec)) == plan["variables"], "the runner can see which TESTDATA_* values the spec needs")
secrets = {"TESTDATA_MULTI_ORG_EMAIL": "crawl.user@example.test", "TESTDATA_OTP": "482913", "TESTDATA_ORG_NAME": "Com1"}
run_key = f"kbtest-{uuid.uuid4().hex[:8]}"
workspace = ws.reset_workspace(run_key)
name = ws.materialize_script(workspace=workspace, code=spec, suggested_file_path=journey_crawl.SPEC_FILE)
ws.write_playwright_config(workspace, base_url=BASE, slow_mo_ms=0, headless=True)
result = asyncio.run(LocalPlaywrightRunner().run(workspace_dir=workspace, script_file_name=name, environment="SIT",
                                                 timeout_seconds=300, extra_env=secrets))
out_file = workspace / journey_crawl.OUTPUT_FILE
check(out_file.exists(), f"the crawl wrote its result ({result.run_status}: {result.error_message or 'ok'})")
if not out_file.exists():
    print((workspace / "run.log").read_text(encoding="utf-8", errors="replace")[-3000:] if (workspace / "run.log").exists() else "no log")
    sys.exit(1)
raw = out_file.read_text(encoding="utf-8")
output = json.loads(raw)
check(all(v not in raw for v in secrets.values() if v != "Com1"), "no test-data value in the result")
check(output["final_url"].endswith("/b2bportal/home.html"), f"walked through to the dashboard ({output['final_url']})")
check(not output["blockers"], f"no blockers ({output['blockers']})")

print("3. Evaluate")
evaluated = journey_crawl.evaluate(plan, output)
rows = {(r["screen_id"], r["element_id"]): r for r in evaluated["rows"]}
print("   summary:", evaluated["summary"])
if os.environ.get("CRAWL_DEBUG"):
    for r in evaluated["rows"]:
        print("   ", r["screen_id"], r["element_id"], r["outcome"], r.get("strategy"), r.get("selector"), r.get("tried"))
check(rows[("SCR_LOGIN", "username")]["outcome"] == "confirmed", "Automation KB selector for the email field confirmed")
check(rows[("SCR_LOGIN", "otp_continue")]["outcome"] == "confirmed" and rows[("SCR_LOGIN", "otp_continue")]["label_differs"],
      "RECEIVE OTP confirmed, and its label differs from the design's CONTINUE")
check(rows[("SCR_OTP_ENTRY", "otp_digit_1_6")]["outcome"] == "confirmed", "OTP boxes confirmed")
tab = rows[("SCR_LOGIN", "tab_otp")]
check(tab["outcome"] == "new" and tab["selector"] == "//button[@id='tab-otp']", f"OTP tab captured by its id: {tab['selector']}")
check(("SCR_LOGIN", "tab_password") not in rows, "sign-in is setup here: its screens are not swept, only its steps")
check(rows[("SCR_SELECT_ORG", "org_card")]["step"] is not None and rows[("SCR_LOGIN", "username")]["setup"], "rows say which journey step they belong to")
check(rows[("SCR_OTP_ENTRY", "proceed")]["outcome"] == "not_found", "Proceed reported as not found -- not invented")
check(rows[("SCR_SELECT_ORG", "title")]["outcome"] == "new", "Select Organization title captured")
check(rows[("SCR_SELECT_ORG", "org_card")]["data_dependent"], "the organization card was found through test data")
check(rows[("SCR_ORG_DASHBOARD", "profile_menu")]["outcome"] == "confirmed", "profile control confirmed on the dashboard")

print("4. Propose, pair, publish")
changes = journey_crawl.proposal(evaluated, profile)
auto_paths = [c["path"] for c in changes["automation"]]
check("selectors.scr_login" in auto_paths, f"Automation KB proposal groups by screen ({auto_paths})")
check(all("org_card" not in json.dumps(c) for c in changes["automation"]), "no data-dependent selector proposed")
db = SessionLocal()
a = changesets.draft(db, app_id=APP, kb="automation", title="crawl", source="crawl", changes=changes["automation"])
j = changesets.draft(db, app_id=APP, kb="journey", title="links", source="crawl", changes=changes["journey"],
                     origin={"crawl": {"pair": a.id}})
versions = changesets.publish_with_pair(db, j.id, actor="reviewer")
check(len(versions) == 2 and db.get(KbChangeSet, a.id).status == "published", "approving the links published the selectors first")
reconcile = diff.reconcile_elements(store.load(APP), automation_kb.load_app_profile(APP))
now = {(r["screen_id"], r["element_id"]): r["status"] for r in reconcile["rows"] if r["element_id"]}
check(now[("SCR_LOGIN", "tab_otp")] == "MATCH" and now[("SCR_SELECT_ORG", "title")] == "MATCH",
      "Reconcile now reports the captured elements as MATCH")
check(now[("SCR_OTP_ENTRY", "proceed")] == "NOT_CRAWLED", "Proceed stays NOT_CRAWLED: the crawl did not invent it")
db.close()

server.shutdown()
shutil.rmtree(ws.workspace_dir_for_run(run_key), ignore_errors=True)
shutil.rmtree(work, ignore_errors=True)
if failures:
    print(f"\n{len(failures)} check(s) failed")
    sys.exit(1)
print("\nall checks passed")
