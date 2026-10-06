"""
--- Recording a journey, in a real browser ---------------------------------------------

Serves tests/journeys/fixture_portal, runs the recorder spec journey_record
builds through the project's own Playwright runner -- with a stand-in for the
person appended to it, signing in with an email and an OTP and choosing an
organization -- then:

  1. checks what was recorded: one step per action, selectors that match one
     element, the six OTP boxes as one step, and no typed value anywhere;
  2. absorbs the run into a KbCrawlRun and saves it as the OTP journey's steps:
     a journey + flow pair whose flow carries the recorded selectors;
  3. replays the saved journey as an ordinary walk: every step is done with
     its recorded selector and the Test Data value for its field.

Throwaway copies of both Knowledge Bases and a throwaway database; the real
ones are never touched. Needs the Playwright runtime. From ai-admin-module-py:

    .venv312/Scripts/python.exe tests/journeys/smoke_journey_record.py
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

work = Path(tempfile.mkdtemp(prefix="kbrec-"))
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
from app.models.automation import AutomationRun  # noqa: E402
from app.models.kb_changes import KbChangeSet, KbCrawlRun  # noqa: E402
from app.services.automation import knowledge_base as automation_kb  # noqa: E402
from app.services.automation import workspace as ws  # noqa: E402
from app.services.automation.local_playwright import LocalPlaywrightRunner  # noqa: E402
from app.services.automation.preflight import is_ready  # noqa: E402
from app.services.journeys import changesets, crawl_runs, journey_crawl, journey_map, journey_record, store  # noqa: E402

assert str(work) in str(store.journey_kb_root()) and str(work) in str(automation_kb.KB_ROOT_DIR), "refusing to run against the real KBs"
Base.metadata.create_all(bind=engine)
APP = "eand_b2b_portal"
JOURNEY = "B2B.REG.EXISTING.SIGNIN.OTP"
EMAIL, OTP = "rec.user@example.test", "482913"
failures = []


def check(condition, message):
    print(("  ok   " if condition else "  FAIL ") + message)
    if not condition:
        failures.append(message)


if not is_ready():
    print("SKIPPED: the Playwright runtime is not available on this machine.")
    sys.exit(0)

handler = functools.partial(SimpleHTTPRequestHandler, directory=str(ROOT / "tests" / "journeys" / "fixture_portal"))
handler.log_message = lambda *a, **k: None
server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{server.server_address[1]}/b2bportal/login.html"

# The person: what they do once the page has opened, then Finish.
PERSON = f"""
  await page.click('h2');  // a stray click on the heading: not a step
  await page.click('#tab-otp');
  await page.fill('#userEmailField', '{EMAIL}');
  await page.click('#receive');
  for (let i = 1; i <= 6; i++) await page.fill(`[name=opt-field-${{i}}]`, '{OTP}'[i - 1]);
  await page.waitForURL(/select-org/, {{ timeout: 10000 }});
  await sleep(800);
  await page.getByText('Pearl Trading').click();
  await page.waitForURL(/home/, {{ timeout: 10000 }});
  await sleep(1500);
  fs.writeFileSync(STOP, 'finish');
"""
ANCHOR = "  entryShot = await shoot(0);\n  save(); progress();\n"

run_keys = []
try:
    print("1. Record")
    plan = {"entry": BASE, "max_minutes": 3}
    spec = journey_record.build_spec(plan)
    check(ANCHOR in spec, "the spec has the point where the person starts")
    spec = spec.replace(ANCHOR, ANCHOR + PERSON)
    run_key = f"kbrec-{uuid.uuid4().hex[:8]}"
    run_keys.append(run_key)
    workspace = ws.reset_workspace(run_key)
    name = ws.materialize_script(workspace=workspace, code=spec, suggested_file_path=journey_record.SPEC_FILE)
    ws.write_playwright_config(workspace, base_url=BASE, slow_mo_ms=0, headless=True)
    result = asyncio.run(LocalPlaywrightRunner().run(workspace_dir=workspace, script_file_name=name, environment="SIT",
                                                     timeout_seconds=300))
    out_file = workspace / journey_record.OUTPUT_FILE
    check(out_file.exists(), f"the recorder saved what it recorded ({result.run_status}: {result.error_message or 'ok'})")
    if not out_file.exists():
        log = workspace / "run.log"
        print(log.read_text(encoding="utf-8", errors="replace")[-3000:] if log.exists() else "no log")
        sys.exit(1)
    raw = out_file.read_text(encoding="utf-8")
    output = json.loads(raw)
    check(EMAIL not in raw and OTP not in raw and "482" not in raw, "no typed value in the recording")
    check(output["reason"] == "finished", f"ended by Finish ({output['reason']})")
    for ev in output["events"]:
        print(f"     {ev['order']:>2} {ev['kind']:<6} {ev.get('field') or '':<9} {ev.get('target')!s:<52} {ev.get('label')!s:.40}")
    steps = journey_record.recording_steps(output, app_name="B2B Portal")
    for s in steps:
        print(f"     -> {s['action']:<55} {s['recorded'].get('target') or s['recorded'].get('route')}")
    kinds = [s["recorded"]["kind"] for s in steps]
    check(kinds == ["goto", "click", "fill", "click", "otp", "click", "verify"], f"one step per action, then a check of where it ended: {kinds}")
    check(steps[-1]["recorded"]["route"].endswith("/home.html") and steps[-1]["action"].startswith("Verify"), f"the check: {steps[-1]}")
    check(steps[1]["recorded"]["target"] == "//button[@id='tab-otp']", "the OTP tab by its id")
    check(steps[2]["recorded"]["field"] == "username" and steps[2]["recorded"]["target"] == "//input[@id='userEmailField']",
          "the email field, recorded as a username field by its id")
    check(steps[3]["action"] == "Click 'RECEIVE OTP'", f"the button by its label: {steps[3]['action']}")
    check(steps[4]["recorded"]["target"] == "//input[contains(@name,'opt-field')]" and steps[4]["recorded"].get("boxes") == 6,
          f"six OTP boxes as one step: {steps[4]['recorded']}")
    check(all(s["recorded"].get("unique", True) for s in steps[1:]), "every selector matched one element when recorded")
    check(steps[4]["expected_result"].endswith("select-org.html opens"), f"where the OTP led: {steps[4]['expected_result']}")
    check(all((workspace / s["recorded"]["screenshot"]).exists() for s in steps if s["recorded"].get("screenshot")), "screenshots kept")

    print("2. Save as the journey's steps")
    db = SessionLocal()
    db.add(AutomationRun(run_key=run_key, framework="playwright", environment="SIT", status="completed",
                         workspace_path=str(workspace), run_config={}, run_metadata={}))
    crawl = KbCrawlRun(app_id=APP, journey_id=JOURNEY, environment="SIT", base_url=BASE, run_key=run_key, status="running",
                       plan={"source": "record", "journey_id": JOURNEY, "journey_name": "OTP", "app_name": "B2B Portal", "items": []})
    db.add(crawl)
    db.commit()
    crawl = crawl_runs.absorb(db, crawl)
    check(crawl.status == "completed" and len(crawl.result["recording"]) == 7, f"absorbed: {crawl.status} {crawl.error}")
    created = journey_record.save(db, crawl.id, crawl.result["recording"], link_flow=None, actor="tester")
    check(created["journey"] is not None and created["automation"] is not None, "a journey + flow pair is drafted")
    versions = changesets.publish_with_pair(db, created["journey"].id, actor="reviewer")
    check(len(versions) == 2, "approving the journey half publishes the flow too")
    kb = store.load(APP)
    journey = kb.journeys[JOURNEY]
    check([s["action"] for s in journey["steps"]] == [s["action"] for s in steps], "the journey's steps are the recording's")
    check(all(s.get("recorded", {}).get("recording") == crawl.id for s in journey["steps"]), "each step says which recording it came from")
    flow = next(f for f in automation_kb.list_flows(APP) if f["flow_id"] in journey["automation_flow_ids"])
    check([f["target"] for f in flow["canonical_steps"][1:]] == [s["recorded"].get("target") or s["recorded"].get("route") for s in steps[1:]],
          "the flow's targets are the recorded selectors")
    m = journey_map.build_map(kb, JOURNEY, db=db)
    check(m["flow"]["up_to_date"] and m["summary"]["flow_differs"] == 0, f"the Journey Map says the flow matches: {m['summary']}")

    print("3. Replay as a walk")
    profile = automation_kb.load_app_profile(APP)
    walk = journey_crawl.build_plan(kb, JOURNEY, automation_profile=profile, base_url=BASE)
    print("     walk:", [(i["step_number"], i["kind"], i.get("variable")) for i in walk["items"]])
    check([i["kind"] for i in walk["items"]] == ["goto", "click", "fill", "click", "otp", "click", "screen"], "replayed with the recorded actions")
    secrets = {v: (EMAIL if "EMAIL" in v or "USER" in v else OTP if "OTP" in v else "x") for v in walk["variables"]}
    walk_key = f"kbrec-{uuid.uuid4().hex[:8]}"
    run_keys.append(walk_key)
    wws = ws.reset_workspace(walk_key)
    wname = ws.materialize_script(workspace=wws, code=journey_crawl.build_spec(walk), suggested_file_path=journey_crawl.SPEC_FILE)
    ws.write_playwright_config(wws, base_url=BASE, slow_mo_ms=0, headless=True)
    asyncio.run(LocalPlaywrightRunner().run(workspace_dir=wws, script_file_name=wname, environment="SIT", timeout_seconds=300,
                                            extra_env=secrets))
    wout = json.loads((wws / journey_crawl.OUTPUT_FILE).read_text(encoding="utf-8"))
    statuses = [(s["step_number"], s["status"]) for s in wout["steps"]]
    print("     ", statuses, wout["final_url"])
    check(all(st in ("done", "auto") for _, st in statuses), f"every recorded step replayed: {statuses}")
    check(wout["final_url"].endswith("/home.html"), "the replay reached the dashboard")
    evaluated = journey_crawl.evaluate(walk, wout)
    check(all(r["outcome"] == "confirmed" for r in evaluated["rows"] if r["screen_id"] == journey_crawl.RECORDED_SCREEN),
          f"recorded selectors confirmed: {[(r['element_id'], r['outcome']) for r in evaluated['rows']]}")
    check(journey_crawl.proposal(evaluated, profile)["automation"] == [], "a replay proposes no selectors for recorded steps")
    db.close()
finally:
    server.shutdown()
    engine.dispose()
    for key in run_keys:
        shutil.rmtree(ws.workspace_dir_for_run(key), ignore_errors=True)
    shutil.rmtree(work, ignore_errors=True)

print("FAILURES:", failures or "none")
sys.exit(1 if failures else 0)
