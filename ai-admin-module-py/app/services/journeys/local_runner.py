"""Short-lived device-owned Playwright journey runs.

The Studio creates a crawl and one opaque token. A loopback-only runner on the
user's device exchanges that token for one generated spec, runs it with the
device's existing Playwright installation, and returns the value-free journey
output. Test Data is never returned to the browser UI or stored in the crawl.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import secrets
import zipfile
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from sqlalchemy.orm import Session

from ...models.automation import AutomationApplication, AutomationRun
from ...models.kb_changes import KbCrawlRun
from ..automation import test_data, workspace as ws
from . import crawl_runs, journey_crawl

SOURCE = "local"
SESSION_MINUTES = 15
MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
ASSET_DIR = Path(__file__).resolve().parents[2] / "local_playwright_runner"


class LocalRunnerError(ValueError):
    pass


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _agent(crawl: KbCrawlRun) -> Dict[str, Any]:
    value = (crawl.plan or {}).get("local_agent")
    if not isinstance(value, dict):
        raise LocalRunnerError("This is not a device Playwright run.")
    return value


def _authorise(crawl: Optional[KbCrawlRun], token: str) -> Tuple[KbCrawlRun, Dict[str, Any]]:
    if crawl is None:
        raise LocalRunnerError("No such device run.")
    agent = _agent(crawl)
    if not token or not hmac.compare_digest(_hash(token), str(agent.get("token_hash") or "")):
        raise LocalRunnerError("The device run code is not valid.")
    try:
        expired = datetime.utcnow() >= datetime.fromisoformat(str(agent.get("expires_at")))
    except (TypeError, ValueError):
        expired = True
    if expired:
        raise LocalRunnerError("The device run code expired. Start a new local dry run.")
    if crawl.status != "running":
        raise LocalRunnerError(f"This device run is already {crawl.status}.")
    return crawl, agent


def start(db: Session, *, app_id: str, journey_id: str, application_id: int,
          profile_id: Optional[str], environment: Optional[str], actor: Optional[str],
          stop_before: Optional[int], allow_risky: bool) -> Tuple[KbCrawlRun, str]:
    application = db.get(AutomationApplication, application_id)
    if application is None:
        raise LookupError("No such registered application.")
    kb = crawl_runs._kb(app_id)
    if application.app_key != kb.app_id:
        raise LocalRunnerError(f"{application.name} is registered as '{application.app_key}', not '{kb.app_id}'.")
    environment = (environment or application.environment or "SIT").strip()
    if environment.upper() in crawl_runs.blocked_environments():
        raise LocalRunnerError(f"Local dry runs do not run against {environment}. Use SIT, QA, UAT or RC.")
    from ..automation.registry import address_for_crawl

    base_url = (address_for_crawl(db, application.app_key, environment) or application.base_url or "").strip()
    if not base_url:
        raise LocalRunnerError(f"{application.name} has no address for {environment}.")
    plan = crawl_runs._plan(kb, journey_id, base_url=base_url, profile_id=profile_id,
                            stop_before=stop_before, allow_risky=allow_risky)
    low = max(0, int(crawl_runs.settings.AUTOMATION_STEP_DELAY_MIN_MS or 0))
    plan["step_delay_ms"] = [low, max(low, int(crawl_runs.settings.AUTOMATION_STEP_DELAY_MAX_MS or 0))]
    code = journey_crawl.build_spec(plan)
    data = test_data.for_code(db, code, environment=environment, base_url=base_url)
    missing = test_data.missing_message(data)
    if missing:
        raise LocalRunnerError(missing)
    token = secrets.token_urlsafe(32)
    now = datetime.utcnow()
    run_key = f"device-{secrets.token_hex(12)}"
    # Keep source="journey" or "flow" because proposal and review semantics
    # depend on it; execution_target says where the identical spec runs.
    plan["execution_target"] = SOURCE
    plan["local_agent"] = {
        "token_hash": _hash(token), "created_at": now.isoformat(),
        "expires_at": (now + timedelta(minutes=SESSION_MINUTES)).isoformat(),
        "state": "waiting", "message": "Waiting for the local Playwright runner.",
        "progress": {},
    }
    run = AutomationRun(
        run_key=run_key, application_id=application.id, framework="playwright", environment=environment,
        status="queued", run_config={"headless": True, "mode": "local_journey_crawl"},
        run_metadata={"code": code, "base_url": base_url, "file_name": journey_crawl.SPEC_FILE,
                      "journey_id": journey_id, "execution_target": "device"}, triggered_by=actor,
    )
    crawl = KbCrawlRun(
        app_id=app_id, journey_id=journey_id, application_id=application.id, environment=environment,
        profile_id=plan.get("profile_id"), base_url=base_url, run_key=run_key, status="running",
        plan=plan, created_by=actor,
    )
    db.add_all([run, crawl]); db.commit(); db.refresh(crawl)
    return crawl, token


def config(db: Session, crawl_id: int, token: str) -> Dict[str, Any]:
    crawl, agent = _authorise(db.get(KbCrawlRun, crawl_id), token)
    run = db.query(AutomationRun).filter(AutomationRun.run_key == crawl.run_key).first()
    if run is None:
        raise LocalRunnerError("The device run record is missing.")
    code = str((run.run_metadata or {}).get("code") or "")
    data = test_data.for_code(db, code, environment=crawl.environment, base_url=crawl.base_url)
    missing = test_data.missing_message(data)
    if missing:
        raise LocalRunnerError(missing)
    now = datetime.utcnow()
    run.status = "running"; run.started_at = run.started_at or now
    run.run_metadata = {**(run.run_metadata or {}), "execution_phase": "Executing on local device"}
    crawl.plan = {**(crawl.plan or {}), "local_agent": {
        **agent, "state": "running", "connected_at": now.isoformat(),
        "message": "Local runner connected and is preparing Playwright.",
    }}
    db.commit()
    return {
        "crawl_id": crawl.id, "run_key": crawl.run_key, "code": code,
        "file_name": journey_crawl.SPEC_FILE, "base_url": crawl.base_url,
        "environment": crawl.environment, "env": data["values"],
        "package_json": ws.PLAYWRIGHT_PACKAGE_JSON,
        "playwright_config": ws._render_playwright_config(crawl.base_url, ".", slow_mo_ms=0, headless=True),
        "progress_reporter": ws.PROGRESS_REPORTER_CJS,
        "output_file": journey_crawl.OUTPUT_FILE, "progress_file": journey_crawl.PROGRESS_FILE,
        "frame_file": journey_crawl.FRAME_FILE,
    }


def progress(db: Session, crawl_id: int, token: str, value: Dict[str, Any]) -> Dict[str, Any]:
    crawl, agent = _authorise(db.get(KbCrawlRun, crawl_id), token)
    snapshot = value.get("progress") if isinstance(value.get("progress"), dict) else {}
    # Generated progress contains action labels and statuses, never field values.
    snapshot = json.loads(json.dumps(snapshot))
    frame = value.get("frame")
    if isinstance(frame, str) and frame:
        try:
            pixels = base64.b64decode(frame, validate=True)
            if len(pixels) <= 5 * 1024 * 1024:
                workspace = ws.workspace_dir_for_run(crawl.run_key)
                workspace.mkdir(parents=True, exist_ok=True)
                (workspace / journey_crawl.FRAME_FILE).write_bytes(pixels)
                run = db.query(AutomationRun).filter(AutomationRun.run_key == crawl.run_key).first()
                if run:
                    run.workspace_path = str(workspace)
        except (ValueError, TypeError):
            pass
    crawl.plan = {**(crawl.plan or {}), "local_agent": {
        **agent, "state": "running", "message": str(value.get("message") or "Running on this device.")[:500],
        "progress": snapshot, "last_progress_at": datetime.utcnow().isoformat(),
    }}
    db.commit()
    return {"accepted": True, "cancelled": False}


def finish(db: Session, crawl_id: int, token: str, output: Dict[str, Any], artifacts: Dict[str, str]) -> KbCrawlRun:
    crawl, agent = _authorise(db.get(KbCrawlRun, crawl_id), token)
    run = db.query(AutomationRun).filter(AutomationRun.run_key == crawl.run_key).first()
    if run is None:
        raise LocalRunnerError("The device run record is missing.")
    workspace = ws.reset_workspace(crawl.run_key)
    (workspace / journey_crawl.OUTPUT_FILE).write_text(json.dumps(output), encoding="utf-8")
    total = 0
    for name, encoded in (artifacts or {}).items():
        clean = Path(name).name
        if clean != name or not (clean == journey_crawl.FRAME_FILE or clean.startswith("shot-")) or not clean.endswith(".png"):
            continue
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError):
            continue
        total += len(data)
        if total > MAX_ARTIFACT_BYTES:
            raise LocalRunnerError("The local evidence upload is larger than 25 MB.")
        (workspace / clean).write_bytes(data)
    result = journey_crawl.evaluate(crawl.plan or {}, output)
    crawl.result = result; crawl.status = "completed"; crawl.error = None; crawl.finished_at = datetime.utcnow()
    crawl.plan = {**(crawl.plan or {}), "local_agent": {
        **agent, "token_hash": None, "state": "completed", "finished": True,
        "message": "Local Playwright run completed and uploaded its result.",
    }}
    run.status = "completed"; run.outcome = "passed"; run.workspace_path = str(workspace); run.completed_at = datetime.utcnow()
    run.total_tests = 1; run.passed = 1
    db.commit(); db.refresh(crawl)
    return crawl


def fail(db: Session, crawl_id: int, token: str, message: str) -> KbCrawlRun:
    crawl, agent = _authorise(db.get(KbCrawlRun, crawl_id), token)
    run = db.query(AutomationRun).filter(AutomationRun.run_key == crawl.run_key).first()
    crawl.status = "failed"; crawl.error = (message or "Local Playwright stopped.")[:1000]; crawl.finished_at = datetime.utcnow()
    crawl.plan = {**(crawl.plan or {}), "local_agent": {
        **agent, "token_hash": None, "state": "failed", "finished": True, "message": crawl.error,
    }}
    if run:
        run.status = "failed"; run.outcome = "blocked"; run.error_message = crawl.error; run.completed_at = datetime.utcnow()
    db.commit(); db.refresh(crawl)
    return crawl


def cancel(db: Session, crawl_id: int) -> KbCrawlRun:
    crawl = db.get(KbCrawlRun, crawl_id)
    if crawl is None:
        raise LookupError("No such device run.")
    agent = _agent(crawl)
    if crawl.status != "running":
        return crawl
    crawl.status = "failed"; crawl.error = "Local dry run stopped by the user."; crawl.finished_at = datetime.utcnow()
    crawl.plan = {**(crawl.plan or {}), "local_agent": {**agent, "token_hash": None, "state": "failed", "message": crawl.error}}
    run = db.query(AutomationRun).filter(AutomationRun.run_key == crawl.run_key).first()
    if run:
        run.status = "cancelled"; run.outcome = "blocked"; run.error_message = crawl.error; run.completed_at = datetime.utcnow()
    db.commit(); db.refresh(crawl)
    return crawl


def live(crawl: KbCrawlRun) -> Dict[str, Any]:
    agent = dict(((crawl.plan or {}).get("local_agent") or {}))
    progress_value = dict(agent.get("progress") or {})
    frame = ws.workspace_dir_for_run(crawl.run_key) / journey_crawl.FRAME_FILE if crawl.run_key else None
    return {
        "id": crawl.id, "status": crawl.status, "run_status": agent.get("state"),
        "phase": agent.get("message"), "total": progress_value.get("total") or len((crawl.plan or {}).get("items") or []),
        "current": progress_value.get("current"), "finished": crawl.status in ("completed", "failed"),
        "steps": progress_value.get("steps") or [],
        "frame_at": frame.stat().st_mtime if frame is not None and frame.exists() else None,
    }


def package() -> bytes:
    if not ASSET_DIR.exists():
        raise LocalRunnerError("The local runner files are missing from this installation.")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(ASSET_DIR.iterdir()):
            if path.is_file():
                archive.write(path, path.name)
    return buffer.getvalue()
