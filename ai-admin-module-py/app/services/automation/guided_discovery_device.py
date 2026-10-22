"""Guided Flow Discovery with the browser on the user's own device.

The server session (guided_discovery.py) opens a headed browser on the machine
the backend runs on, which an enterprise server cannot do. Here the same
in-page recorder (GUIDED_DISCOVERY_INJECTED_SCRIPT) runs in a Playwright spec
that the loopback device runner executes:

  * the runner reports the spec's progress file -- the objects captured so far
    -- and each report is saved on the test case at once, as the server
    session saves each event;
  * Finish in Studio is returned as `stop` on the next progress call and the
    runner writes the stop file the spec watches; Finish & Save in the
    browser's own overlay ends it directly;
  * the final object list arrives with finish.

The run is an AutomationRun (mode "guided_discovery", execution_target
"device") holding a short-lived code, so any API worker can answer the runner.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets as token_secrets
from datetime import datetime, timedelta
from typing import Any, Optional, Tuple

from sqlalchemy.orm import Session

from ...models.automation import AutomationRun, AutomationTestCase
from . import device_runner, workspace as ws
from .guided_discovery import GUIDED_DISCOVERY_INJECTED_SCRIPT

MODE = "guided_discovery"
SPEC_FILE = "guided_discovery.spec.ts"
OUTPUT_FILE = "guided_discovery.json"
PROGRESS_FILE = "guided_progress.json"
STOP_FILE = "guided_discovery.stop"
MAX_MINUTES = 30
CONNECT_MINUTES = device_runner.SESSION_MINUTES
STATUS = {"queued": "starting", "running": "recording", "completed": "completed", "failed": "error", "cancelled": "stopped"}


class GuidedDeviceError(ValueError):
    pass


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _save_objects(db: Session, case_id: int, objects: list[dict[str, Any]]) -> None:
    """On the case and its twins, as the server session's _persist_captured_objects does."""
    case = db.get(AutomationTestCase, case_id)
    if case is None:
        return
    status = "captured" if objects else "none"
    rows = [case] + db.query(AutomationTestCase).filter(
        AutomationTestCase.display_id == case.display_id, AutomationTestCase.id != case.id).all()
    for row in rows:
        row.recorded_flow_objects = list(objects)
        row.flow_discovery_status = status


def _objects(value: Any) -> Optional[list[dict[str, Any]]]:
    if not isinstance(value, dict) or not isinstance(value.get("objects"), list):
        return None
    return [item for item in value["objects"] if isinstance(item, dict)][:500]


def start(db: Session, case: AutomationTestCase, *, actor: Optional[str], headed: bool = True) -> Tuple[AutomationRun, str]:
    url = (case.application_url or "").strip()
    if not url:
        raise GuidedDeviceError(
            f"{case.display_id} has no application URL, so there is nowhere to open a browser. "
            f"Set the case's application URL first."
        )
    token = token_secrets.token_urlsafe(32)
    now = datetime.utcnow()
    run = AutomationRun(
        run_key=f"device-gd-{token_secrets.token_hex(10)}", framework="playwright", environment=case.environment,
        application_id=getattr(case, "application_id", None), status="queued",
        # Not tied to the case's run history: this records objects, it tests nothing.
        run_config={"headless": not headed, "slow_mo_ms": 0, "mode": MODE, "execution_target": "device"},
        run_metadata={
            "code": build_spec(url), "base_url": url, "file_name": SPEC_FILE, "guided_case_id": case.id,
            "execution_phase": "Waiting for device Playwright runner",
            "device_agent": {
                "token_hash": _hash(token), "created_at": now.isoformat(),
                # The code has to last as long as the recording may, not just its start.
                "expires_at": (now + timedelta(minutes=CONNECT_MINUTES + MAX_MINUTES)).isoformat(),
                "state": "waiting", "message": "Waiting for the device runner.",
            },
        },
        triggered_by=actor,
    )
    db.add(run); db.commit(); db.refresh(run)
    return run, token


def _run(db: Session, run_key: str) -> AutomationRun:
    run = db.query(AutomationRun).filter(AutomationRun.run_key == run_key).first()
    if run is None or (run.run_config or {}).get("mode") != MODE:
        raise GuidedDeviceError("No such device guided discovery.")
    return run


def _authorise(db: Session, run_key: str, token: str) -> Tuple[AutomationRun, dict[str, Any]]:
    run = _run(db, run_key)
    agent = (run.run_metadata or {}).get("device_agent") or {}
    if not token or not hmac.compare_digest(_hash(token), str(agent.get("token_hash") or "")):
        raise GuidedDeviceError("The device run code is not valid.")
    if device_runner.expire_if_stale(db, run) or run.status not in ("queued", "running"):
        raise GuidedDeviceError(f"This guided discovery is already {run.status}.")
    return run, agent


def config(db: Session, run_key: str, token: str) -> dict[str, Any]:
    run, agent = _authorise(db, run_key, token)
    now = datetime.utcnow()
    meta = dict(run.run_metadata or {})
    run.status = "running"; run.started_at = run.started_at or now
    run.run_metadata = {**meta, "execution_phase": "Recording on device", "device_agent": {
        **agent, "state": "running", "connected_at": now.isoformat(), "message": "Device runner opened the browser."}}
    db.commit()
    return {
        "run_key": run.run_key, "code": meta.get("code") or "", "file_name": SPEC_FILE,
        "base_url": meta.get("base_url"), "environment": run.environment, "env": {},
        "package_json": ws.PLAYWRIGHT_PACKAGE_JSON,
        "playwright_config": ws._render_playwright_config(
            meta.get("base_url"), ".", slow_mo_ms=0, headless=bool((run.run_config or {}).get("headless", False))),
        "progress_reporter": ws.PROGRESS_REPORTER_CJS,
        "output_file": OUTPUT_FILE, "progress_file": PROGRESS_FILE,
        "frame_file": "live.png", "stream_frame": False,
        "stop_file": STOP_FILE, "heartbeat_seconds": 3,
    }


def progress(db: Session, run_key: str, token: str, value: dict[str, Any]) -> dict[str, Any]:
    run, agent = _authorise(db, run_key, token)
    objects = _objects(value.get("progress"))
    if objects is not None:
        _save_objects(db, int((run.run_metadata or {}).get("guided_case_id") or 0), objects)
    run.run_metadata = {**(run.run_metadata or {}), "device_agent": {
        **agent, "state": "running", "last_progress_at": datetime.utcnow().isoformat(),
        "message": f"{len(objects or [])} object(s) captured on the device."}}
    db.commit()
    return {"accepted": True, "cancelled": False, "stop": bool(agent.get("stop_requested"))}


def finish(db: Session, run_key: str, token: str, output: dict[str, Any]) -> AutomationRun:
    run, agent = _authorise(db, run_key, token)
    objects = _objects(output) or []
    _save_objects(db, int((run.run_metadata or {}).get("guided_case_id") or 0), objects)
    run.status = "completed"; run.outcome = "passed"; run.completed_at = datetime.utcnow()
    run.total_tests = 1; run.passed = 1
    run.run_metadata = {**(run.run_metadata or {}), "guided_objects": len(objects),
                        "guided_reason": str(output.get("reason") or "")[:40], "device_agent": {
        **agent, "token_hash": None, "state": "completed", "finished": True,
        "message": f"Guided discovery on the device saved {len(objects)} object(s)."}}
    db.commit(); db.refresh(run)
    return run


def fail(db: Session, run_key: str, token: str, message: str) -> AutomationRun:
    run, agent = _authorise(db, run_key, token)
    # Objects reported while it ran are already on the case and stay there.
    run.status = "failed"; run.outcome = "blocked"; run.completed_at = datetime.utcnow()
    run.error_message = (message or "Device Playwright stopped.")[:1000]
    run.run_metadata = {**(run.run_metadata or {}), "device_agent": {
        **agent, "token_hash": None, "state": "failed", "finished": True, "message": run.error_message}}
    db.commit(); db.refresh(run)
    return run


def request_stop(db: Session, run_key: str) -> AutomationRun:
    run = _run(db, run_key)
    if run.status == "queued":
        # The runner never connected: nothing to finish, so end it here.
        agent = (run.run_metadata or {}).get("device_agent") or {}
        run.status = "cancelled"; run.completed_at = datetime.utcnow()
        run.run_metadata = {**(run.run_metadata or {}), "device_agent": {
            **agent, "token_hash": None, "state": "cancelled", "message": "Stopped before the device runner connected."}}
    elif run.status == "running":
        agent = (run.run_metadata or {}).get("device_agent") or {}
        run.run_metadata = {**(run.run_metadata or {}), "device_agent": {
            **agent, "stop_requested": True, "message": "Finishing: saving what was captured."}}
    db.commit(); db.refresh(run)
    return run


def status(db: Session, run_key: str) -> dict[str, Any]:
    run = _run(db, run_key)
    device_runner.expire_if_stale(db, run)
    case_id = int((run.run_metadata or {}).get("guided_case_id") or 0)
    case = db.get(AutomationTestCase, case_id)
    objects = (case.recorded_flow_objects or []) if case else []
    agent = (run.run_metadata or {}).get("device_agent") or {}
    return {
        "case_id": case_id, "display_id": case.display_id if case else None, "run_key": run.run_key,
        "status": STATUS.get(run.status, run.status), "execution_target": "device",
        "message": agent.get("message"), "error": run.error_message,
        "objects_count": len(objects), "captured_objects": objects,
    }


_SPEC = r"""import { test } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// --- Guided Flow Discovery on this device ---------------------------------
// Opens the case's application for a person to click through; the injected
// overlay reports every element they use. Ends on Finish & Save in the page,
// Finish in Studio (a stop file), closing the window, or the time limit.

const PLAN = __PLAN__;
const INJECT = __INJECT__;
const STOP = path.join(process.cwd(), '__STOP__');

function writeAtomic(name, data) {
  const target = path.join(process.cwd(), name);
  const tmp = target + '.tmp';
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, target); } catch (e) { /* next write */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('guided discovery', async ({ browser }) => {
  test.setTimeout(PLAN.max_minutes * 60000 + 60000);
  const objects = [];
  let finished = false;
  let reason = '';
  const save = () => writeAtomic('__OUTPUT__', JSON.stringify({ objects, reason, url: PLAN.url }));
  const progress = () => writeAtomic('__PROGRESS__', JSON.stringify({ objects, count: objects.length, finished }));

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.exposeBinding('__onGuidedDiscoveryEvent', (_source, evt) => {
    if (evt && typeof evt === 'object') { objects.push(evt); save(); progress(); }
  });
  await context.exposeBinding('__onGuidedDiscoveryFinish', (_source, history) => {
    if (Array.isArray(history) && history.length > objects.length) objects.splice(0, objects.length, ...history);
    reason = 'finished'; finished = true;
  });
  await context.addInitScript(INJECT);
  const page = await context.newPage();
  try { await page.goto(PLAN.url, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) { /* the person can navigate */ }
  save(); progress();

  const deadline = Date.now() + PLAN.max_minutes * 60000;
  while (!finished) {
    if (fs.existsSync(STOP)) { reason = 'stopped'; break; }
    if (page.isClosed()) { reason = 'closed'; break; }
    if (Date.now() > deadline) { reason = 'time limit'; break; }
    await sleep(500);
  }
  finished = true;
  save(); progress();
  await context.close().catch(() => {});
});
"""


def build_spec(url: str) -> str:
    return (
        _SPEC.replace("__PLAN__", json.dumps({"url": url, "max_minutes": MAX_MINUTES}))
        .replace("__INJECT__", json.dumps(GUIDED_DISCOVERY_INJECTED_SCRIPT))
        .replace("__STOP__", STOP_FILE)
        .replace("__OUTPUT__", OUTPUT_FILE)
        .replace("__PROGRESS__", PROGRESS_FILE)
    )
