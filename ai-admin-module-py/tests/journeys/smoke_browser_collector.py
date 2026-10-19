"""Smoke test for the browser-owned, no-Playwright crawl path.

Run from ai-admin-module-py:
    python tests/journeys/smoke_browser_collector.py
"""
import os
import io
import json
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
work = Path(tempfile.mkdtemp())
shutil.copytree(ROOT / "knowledge_base" / "journeys" / "saucedemo", work / "journeys" / "saucedemo")
shutil.copytree(ROOT / "knowledge_base" / "applications" / "saucedemo", work / "applications" / "saucedemo")
os.environ["JOURNEY_KB_PATH"] = str(work / "journeys")
os.environ["AUTOMATION_KB_PATH"] = str(work)
os.environ["AUTOMATION_STORAGE_PATH"] = str(work / "automation-storage")
os.environ["DATABASE_URL"] = f"sqlite:///{(work / 'collector.db').as_posix()}"

from app.database.connection import Base, SessionLocal, engine  # noqa: E402
import app.models.automation  # noqa: E402,F401
import app.models.kb_changes  # noqa: E402,F401
from app.models.automation import (  # noqa: E402
    AutomationApplication, AutomationDataApp, AutomationDataAppEnvironment, AutomationTestData,
)
from app.services.journeys import browser_collector, crawl_runs  # noqa: E402

Base.metadata.create_all(bind=engine)
db = SessionLocal()
failures = []


def check(value, message):
    print(("  ok   " if value else "  FAIL ") + message)
    if not value:
        failures.append(message)


try:
    app = AutomationApplication(name="SauceDemo", app_key="saucedemo", base_url="https://www.saucedemo.com", environment="SIT")
    data_app = AutomationDataApp(name="SauceDemo data", kb_app_id="saucedemo", url_prefix="https://www.saucedemo.com", run_environment="SIT")
    db.add_all([app, data_app]); db.flush()
    db.add(AutomationDataAppEnvironment(app_id=data_app.id, environment="SIT", address="https://www.saucedemo.com"))
    db.add_all([
        AutomationTestData(app_id=data_app.id, environment="SIT", key="username", value="standard_user", is_secret=False),
        AutomationTestData(app_id=data_app.id, environment="SIT", key="password", value="secret_sauce", is_secret=False),
    ])
    db.commit(); db.refresh(app)
    kb = crawl_runs._kb("saucedemo")
    negative = crawl_runs._plan(
        kb, "SAUCE.AUTH.REJECT_INVALID_CREDENTIALS", base_url=app.base_url,
        profile_id=None, stop_before=None, allow_risky=False,
    )
    check(negative["profile_id"] == "INVALID_CREDENTIALS",
          "a journey defaults to the Test Data profile named by its scenario")
    journey_id = next(iter(kb.journeys))
    crawl, token = browser_collector.start(db, app_id="saucedemo", journey_id=journey_id, application_id=app.id,
                                            environment="SIT", actor="tester", max_pages=3)
    check(crawl.status == "running" and len(token) > 30, "a short-lived browser crawl is created")
    cfg = browser_collector.config(db, crawl.id, token)
    check(cfg["allowed_origin"] == "https://www.saucedemo.com" and cfg["values_collected"] is False,
          "the session is origin-bound and value-free")
    check(any(action.get("kind") == "fill" and action.get("value") for action in cfg["automation"]["actions"]),
          "the short-lived collector config contains the setup values needed to reach the next screen")
    expected_actions = [item for item in (crawl.plan or {}).get("items", []) if item.get("kind") != "skip"]
    check(len(cfg["automation"]["actions"]) == len(expected_actions),
          "the collector executes the complete safe journey after its setup steps")
    expected_route_actions = [
        action for action in cfg["automation"]["actions"]
        if action.get("kind") == "click" and action.get("expected_screens")
    ]
    check(not expected_route_actions or all(action.get("expected_routes") for action in expected_route_actions),
          "click transitions include their expected destination routes for collector validation")
    plan = crawl.plan or {}
    screen_id, elements = next(iter((plan.get("screens") or {}).items()))
    captured = []
    for index, element in enumerate(elements[:20]):
        label = element.get("clean_label") or element.get("label") or element["element_id"]
        captured.append({"role": "textbox" if element.get("is_input") else "button", "name": label,
                         "tag": "input" if element.get("is_input") else "button",
                         "selector": f"[data-testid=\"collector-{index}\"]", "alternates": [], "kind": "control",
                         "bounds": {"x": 20, "y": 40 + index * 24, "width": 180, "height": 20}})
    page = {"page_id": "login", "name": "Login", "url": "https://www.saucedemo.com/", "title": "Swag Labs",
            "browser": "Smoke Browser", "viewport": {"width": 1280, "height": 720},
            "elements": captured, "picked": [], "links": [],
            "screenshot": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="}
    accepted = browser_collector.add_page(db, crawl.id, token, page)
    check(accepted["pages"] == 1, "a sanitised page snapshot is accepted")
    progress = browser_collector.live(crawl)
    check(progress["collector_state"] == "capturing" and progress["pages_received"] == 1,
          "live progress reports the collector state and captured page count")
    check(any(step.get("status") == "done" for step in progress["steps"]),
          "live progress reports journey steps confirmed by captured pages")
    check(progress.get("preview", {}).get("viewport", {}).get("width") == 1280 and progress["preview"]["elements"],
          "live progress includes a value-free tab preview")
    check(progress.get("preview", {}).get("screenshot") == "shot-1.png"
          and browser_collector.capture_file(crawl.id, "live.png") is not None,
          "the exact collector screen is saved and attached to its locator preview")
    changed = {**page, "elements": [*page["elements"], {
        "role": "heading", "name": "Products", "tag": "span", "selector": ".title",
        "alternates": [], "kind": "text", "bounds": {"x": 20, "y": 400, "width": 100, "height": 20},
    }]}
    changed_result = browser_collector.add_page(db, crawl.id, token, changed)
    check(changed_result["pages"] == 2,
          "changed states at the same address are preserved for before-and-after validation")
    for action_index, action in enumerate(cfg["automation"]["actions"]):
        # Collector 1.9.2 omitted the initial goto completion. A later action
        # still proves that sequential prerequisite was completed.
        action_status = "running" if action.get("kind") == "goto" else "done"
        browser_collector.progress(db, crawl.id, token, {
            "state": "executing", "message": f"Completed action {action_index + 1}",
            "action_index": action_index, "action_order": action["order"],
            "action_total": len(cfg["automation"]["actions"]), "action_text": action.get("text"),
            "action_status": action_status,
        })
    ledger_live = browser_collector.live(crawl)
    check(next(step for step in ledger_live["steps"] if step["order"] == 1)["status"] == "done",
          "live progress advances past a legacy running goto after later actions complete")
    try:
        browser_collector.add_page(db, crawl.id, token, {**page, "url": "https://evil.example/"})
        off_origin = False
    except browser_collector.CollectorError:
        off_origin = True
    check(off_origin, "an off-origin snapshot is refused")
    done = browser_collector.finish(db, crawl.id, token)
    check(done.status == "completed" and (done.result or {}).get("capture", {}).get("format") == "browser-collector/1",
          "the snapshots finish through the ordinary crawl evaluator")
    check((done.result or {}).get("rows") is not None and (done.result or {}).get("inventory") is not None,
          "review rows and screen inventory are produced")
    check((done.result or {}).get("capture", {}).get("pages", [{}])[0].get("preview", {}).get("elements"),
          "the completed crawl keeps its captured-screen preview")
    completed_orders = {step["order"] for step in (done.result or {}).get("steps", []) if step.get("status") == "done"}
    expected_orders = {action["order"] for action in cfg["automation"]["actions"]}
    check(expected_orders.issubset(completed_orders),
          "final evaluation preserves every action confirmed by the collector ledger")
    try:
        browser_collector.config(db, crawl.id, token)
        reused = True
    except browser_collector.CollectorError:
        reused = False
    check(not reused, "the collector credential is revoked on completion")
    repair_crawl, repair_token = browser_collector.start(
        db, app_id="saucedemo", journey_id=journey_id, application_id=app.id,
        environment="SIT", actor="tester", max_pages=3, capture_step=2, recapture_of=done.id,
    )
    check((repair_crawl.plan or {}).get("collector", {}).get("recapture_of") == done.id,
          "a recapture records the completed crawl whose evidence it is repairing")
    repair_cfg = browser_collector.config(db, repair_crawl.id, repair_token)
    check(len(repair_cfg["automation"]["actions"]) == 2 and repair_cfg["automation"]["actions"][-1]["interactive"] is True,
          "a repair crawl replays only through the selected step")
    browser_collector.progress(db, repair_crawl.id, repair_token, {
        "state": "executing", "message": "Completed step 1", "action_index": 0,
        "action_order": 1, "action_total": 2, "action_text": "step 1", "action_status": "done",
    })
    browser_collector.progress(db, repair_crawl.id, repair_token, {
        "state": "failed", "message": "Could not find step 2", "action_index": 1,
        "action_order": 2, "action_total": 2, "action_text": "step 2", "action_status": "error",
        "action_error": "Could not find step 2",
    })
    browser_collector.repair(db, repair_crawl.id, repair_token, {
        "order": 2, "selector": "[data-test='picked']", "app_label": "Picked", "role": "textbox",
        "action": "verify_text",
    })
    repair_live = browser_collector.live(repair_crawl)
    check([step.get("status") for step in repair_live["steps"][:2]] == ["done", "error"],
          "failed collector progress keeps completed and failed steps")
    check((repair_crawl.plan or {})["items"][1]["element"]["kb_target"] == "[data-test='picked']",
          "the user-selected collector locator is attached to the failed step")
    check((repair_crawl.plan or {})["items"][1]["kind"] == "capture"
          and (repair_crawl.plan or {})["items"][1]["element"]["repair_action"] == "verify_text",
          "the user-selected recapture action is stored with the repaired locator")
    browser_collector.repair(db, repair_crawl.id, repair_token, {
        "order": 2, "selector": "[data-test='picked-list']", "app_label": "Picked list", "role": "combobox",
        "action": "select_option", "option": "standard",
    })
    check((repair_crawl.plan or {})["items"][1]["kind"] == "select"
          and (repair_crawl.plan or {})["items"][1]["option"] == "standard",
          "an option selected from the recapture menu updates the repaired step")
    browser_collector.add_page(db, repair_crawl.id, repair_token, changed)
    repaired = browser_collector.finish(db, repair_crawl.id, repair_token)
    inherited = {
        step["order"]: step.get("inherited_from_crawl_id")
        for step in (repaired.result or {}).get("steps", [])
        if step.get("inherited_from_crawl_id")
    }
    expected_inherited = {order for order in completed_orders if order > 2}
    check(expected_inherited and expected_inherited.issubset(inherited)
          and all(inherited[order] == done.id for order in expected_inherited),
          "a shortened recapture retains later steps confirmed by its completed parent crawl")
    check(not any(order <= 2 for order in inherited)
          and (repaired.result or {}).get("recapture", {}).get("of_crawl_id") == done.id,
          "replayed steps use fresh evidence while retained steps expose their recapture lineage")
    followup, followup_token = browser_collector.start(
        db, app_id="saucedemo", journey_id=journey_id, application_id=app.id,
        environment="SIT", actor="tester", max_pages=3, capture_step=3, recapture_of=repaired.id,
    )
    check((followup.plan or {})["items"][1]["element"].get("repair_strategy") == "user"
          and (followup.plan or {})["items"][1]["element"].get("kb_target") == "[data-test='picked-list']",
          "a second recapture carries explicit locator repairs from the first recapture into its setup replay")
    browser_collector.cancel(db, followup.id)

    failed_history, failed_history_token = browser_collector.start(
        db, app_id="saucedemo", journey_id=journey_id, application_id=app.id,
        environment="SIT", actor="tester", max_pages=3, capture_step=2, recapture_of=repaired.id,
    )
    browser_collector.config(db, failed_history.id, failed_history_token)
    browser_collector.add_page(db, failed_history.id, failed_history_token, changed)
    browser_collector.progress(db, failed_history.id, failed_history_token, {
        "state": "executing", "message": "Completed step 1", "action_index": 0,
        "action_order": 1, "action_total": 2, "action_text": "step 1", "action_status": "done",
    })
    browser_collector.progress(db, failed_history.id, failed_history_token, {
        "state": "failed", "message": "Could not find step 2", "action_index": 1,
        "action_order": 2, "action_total": 2, "action_text": "step 2", "action_status": "error",
        "action_error": "Could not find step 2",
    })
    failed_history = browser_collector.fail(db, failed_history.id, failed_history_token, "Could not find step 2")
    failed_inherited = {
        step["order"] for step in (failed_history.result or {}).get("steps", [])
        if step.get("inherited_from_crawl_id") == repaired.id
    }
    check(failed_history.status == "failed" and expected_inherited.issubset(failed_inherited),
          "a failed recapture preserves compatible later steps that were already confirmed")

    state_crawl, state_token = browser_collector.start(
        db, app_id="saucedemo", journey_id="SAUCE.SESSION.RESET_APPLICATION_STATE", application_id=app.id,
        environment="SIT", actor="tester", max_pages=3, capture_step=8,
    )
    state_cfg = browser_collector.config(db, state_crawl.id, state_token)
    add_action = next(action for action in state_cfg["automation"]["actions"] if "Add to cart" in (action.get("text") or ""))
    check("Remove" in (add_action.get("satisfied_by") or {}).get("labels", []),
          "recapture setup recognises an Add-to-cart action already satisfied by its Remove state")
    browser_collector.cancel(db, state_crawl.id)
    stopped, stopped_token = browser_collector.start(
        db, app_id="saucedemo", journey_id=journey_id, application_id=app.id,
        environment="SIT", actor="tester", max_pages=3,
    )
    stopped = browser_collector.cancel(db, stopped.id)
    check(stopped.status == "failed" and stopped.error == "Browser crawl stopped by the user.",
          "an authenticated user can stop an incomplete browser crawl")
    try:
        browser_collector.config(db, stopped.id, stopped_token)
        stopped_reused = True
    except browser_collector.CollectorError:
        stopped_reused = False
    check(not stopped_reused, "stopping a browser crawl revokes its collector credential")
    retry_failed, retry_failed_token = browser_collector.start(
        db, app_id="saucedemo", journey_id=journey_id, application_id=app.id,
        environment="SIT", actor="tester", max_pages=3, capture_step=2, recapture_of=stopped.id,
    )
    failed_collector = (retry_failed.plan or {}).get("collector", {})
    check(failed_collector.get("recapture_of") == stopped.id
          and failed_collector.get("evidence_from") == repaired.id,
          "a failed crawl can be recaptured while evidence comes from its latest compatible completed crawl")
    browser_collector.cancel(db, retry_failed.id)
    for engine in ("chromium", "firefox", "safari"):
        package = browser_collector.package(engine, studio_origin="http://127.0.0.1:5175")
        check(package.startswith(b"PK") and len(package) > 1000, f"the {engine} package is buildable")
        with zipfile.ZipFile(io.BytesIO(package)) as archive:
            check("bridge.js" in archive.namelist(), f"the {engine} package includes the one-click bridge")
            manifest = json.loads(archive.read("manifest.json"))
            check(manifest["version"] == "1.10.2", f"the {engine} package has the current collector release")
            check(
                manifest.get("content_scripts", [{}])[0].get("matches") == ["http://127.0.0.1:5175/*"],
                f"the {engine} package can detect the collector from the Studio origin it was downloaded from",
            )
            check(
                set(manifest.get("host_permissions") or []) == {"http://*/*", "https://*/*"},
                f"the {engine} package grants application access when it is installed",
            )
            check(
                not manifest.get("optional_host_permissions"),
                f"the {engine} package does not request application access during pairing",
            )
finally:
    db.close()
    shutil.rmtree(work, ignore_errors=True)

print("\nFAILED:" if failures else "\nAll checks passed.", *failures, sep="\n  ")
raise SystemExit(1 if failures else 0)
