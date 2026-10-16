"""Short-lived, device-owned execution for ordinary Automation Studio runs."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets as token_secrets
from datetime import datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any, Optional, Tuple

from sqlalchemy.orm import Session

from ...models.automation import AutomationRun, AutomationRunResult, AutomationTestCase
from . import test_data, workspace as ws
from .job_manager import new_run_key
from .local_playwright import LocalPlaywrightRunner

SESSION_MINUTES = 15
MAX_ARTIFACT_BYTES = 100 * 1024 * 1024
ALLOWED_ARTIFACT_SUFFIXES = {".png", ".webm", ".zip"}


class DeviceRunnerError(ValueError):
    pass


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _agent(run: AutomationRun) -> dict[str, Any]:
    value = (run.run_metadata or {}).get("device_agent")
    if not isinstance(value, dict):
        raise DeviceRunnerError("This run is not assigned to a device runner.")
    return value


def _authorise(run: Optional[AutomationRun], token: str) -> Tuple[AutomationRun, dict[str, Any]]:
    if run is None:
        raise DeviceRunnerError("No such device run.")
    agent = _agent(run)
    if not token or not hmac.compare_digest(_hash(token), str(agent.get("token_hash") or "")):
        raise DeviceRunnerError("The device run code is not valid.")
    try:
        expired = datetime.utcnow() >= datetime.fromisoformat(str(agent.get("expires_at")))
    except (TypeError, ValueError):
        expired = True
    if expired:
        raise DeviceRunnerError("The device run code expired. Start a new device rerun.")
    if run.status not in ("queued", "running"):
        raise DeviceRunnerError(f"This device run is already {run.status}.")
    return run, agent


def start(
    db: Session, *, code: str, environment: Optional[str], base_url: Optional[str],
    file_name: Optional[str], test_case_id: Optional[int], slow_mo_ms: Optional[int],
    actor: Optional[str], script_id: Optional[int] = None, mode: str = "rerun",
    headless: bool = True,
) -> Tuple[AutomationRun, str]:
    case = db.get(AutomationTestCase, test_case_id) if test_case_id else None
    data = test_data.for_code(
        db, code, environment=environment,
        case_url=case.application_url if case else None, base_url=base_url,
        case_environment=case.environment if case else None,
    )
    missing = test_data.missing_message(data)
    if missing:
        raise DeviceRunnerError(missing)
    target_url = base_url or data.get("base_url")
    token = token_secrets.token_urlsafe(32)
    now = datetime.utcnow()
    run = AutomationRun(
        run_key=new_run_key(), test_case_id=test_case_id, script_id=script_id, framework="playwright",
        environment=data["environment"], status="queued",
        run_config={
            "headless": bool(headless), "slow_mo_ms": int(slow_mo_ms if slow_mo_ms is not None else 1000),
            "mode": mode if mode in {"dry_run", "rerun"} else "rerun", "execution_target": "device",
        },
        run_metadata={
            "code": code, "base_url": target_url, "file_name": file_name,
            "target_url": data.get("address"), "test_data": test_data.public(data),
            "execution_phase": "Waiting for device Playwright runner", "phase_step": 1,
            "device_agent": {
                "token_hash": _hash(token), "created_at": now.isoformat(),
                "expires_at": (now + timedelta(minutes=SESSION_MINUTES)).isoformat(),
                "state": "waiting", "message": "Waiting for the device runner.",
            },
        },
        triggered_by=actor,
    )
    db.add(run); db.commit(); db.refresh(run)
    return run, token


def config(db: Session, run_key: str, token: str) -> dict[str, Any]:
    run, agent = _authorise(db.query(AutomationRun).filter(AutomationRun.run_key == run_key).first(), token)
    metadata = dict(run.run_metadata or {})
    code = str(metadata.get("code") or "")
    case = db.get(AutomationTestCase, run.test_case_id) if run.test_case_id else None
    data = test_data.for_code(
        db, code, environment=run.environment,
        case_url=case.application_url if case else None, base_url=metadata.get("base_url"),
        case_environment=case.environment if case else None,
    )
    missing = test_data.missing_message(data)
    if missing:
        raise DeviceRunnerError(missing)
    base_url = metadata.get("base_url") or data.get("base_url")
    data_env = dict(data["values"])
    # Match the server runner's process environment. Some older approved
    # specs navigate with process.env.BASE_URL directly instead of relying on
    # Playwright's use.baseURL, so the companion must provide both.
    if base_url:
        data_env["BASE_URL"] = str(base_url)
    now = datetime.utcnow()
    declared_steps = code.count("test.step(")
    synthetic_test_step = declared_steps == 0
    total = declared_steps or 1
    run.status = "running"; run.started_at = run.started_at or now
    run.run_metadata = {
        **metadata, "execution_phase": "Executing Playwright on device", "phase_step": 4,
        "step_progress": {"total": total, "current": 0, "status": "running", "history": []},
        "progress_mode": "test" if synthetic_test_step else "steps",
        "device_agent": {**agent, "state": "running", "connected_at": now.isoformat(),
                         "message": "Device runner connected and is preparing Playwright."},
    }
    db.commit()
    run_cfg = run.run_config or {}
    return {
        "run_kind": "automation", "run_key": run.run_key,
        "code": code, "file_name": metadata.get("file_name") or "test.spec.ts",
        "environment": run.environment, "env": data_env,
        "package_json": ws.PLAYWRIGHT_PACKAGE_JSON,
        "playwright_config": ws._render_playwright_config(
            base_url, ".", slow_mo_ms=int(run_cfg.get("slow_mo_ms") or 0), headless=bool(run_cfg.get("headless", True)),
        ),
        "progress_reporter": ws.PROGRESS_REPORTER_CJS,
        "progress_file": ws.PROGRESS_FILE_NAME, "output_file": "results.json", "step_total": total,
        "synthetic_test_step": synthetic_test_step,
    }


def progress(db: Session, run_key: str, token: str, value: dict[str, Any]) -> dict[str, Any]:
    run, agent = _authorise(db.query(AutomationRun).filter(AutomationRun.run_key == run_key).first(), token)
    snapshot = value.get("progress") if isinstance(value.get("progress"), dict) else {}
    snapshot = json.loads(json.dumps(snapshot))
    metadata = dict(run.run_metadata or {})
    case = db.get(AutomationTestCase, run.test_case_id) if run.test_case_id else None
    data = test_data.for_code(
        db, str(metadata.get("code") or ""), environment=run.environment,
        case_url=case.application_url if case else None, base_url=metadata.get("base_url"),
        case_environment=case.environment if case else None,
    )
    clean_tail = test_data.redact(
        str(value.get("log_tail") or ""), data.get("secrets") or []
    )[-50_000:]
    run.run_metadata = {
        **metadata, "step_progress": snapshot, "live_log": clean_tail,
        "device_agent": {**agent, "state": "running", "message": str(value.get("message") or "Running on device.")[:500],
                         "last_progress_at": datetime.utcnow().isoformat()},
    }
    db.commit()
    return {"accepted": True, "cancelled": False}


def _artifact_name(raw: str) -> Optional[PurePosixPath]:
    path = PurePosixPath(str(raw or "").replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts or not path.parts or path.suffix.lower() not in ALLOWED_ARTIFACT_SUFFIXES:
        return None
    if path.parts[0] != "artifacts":
        return None
    return path


def finish(
    db: Session, run_key: str, token: str, *, report: dict[str, Any], artifacts: dict[str, str],
    log: str, exit_code: int, duration_seconds: float,
) -> AutomationRun:
    run, agent = _authorise(db.query(AutomationRun).filter(AutomationRun.run_key == run_key).first(), token)
    workspace = ws.reset_workspace(run.run_key)
    total_bytes = 0
    for raw_name, encoded in (artifacts or {}).items():
        rel = _artifact_name(raw_name)
        if rel is None:
            continue
        try:
            content = base64.b64decode(encoded, validate=True)
        except (TypeError, ValueError):
            continue
        total_bytes += len(content)
        if total_bytes > MAX_ARTIFACT_BYTES:
            raise DeviceRunnerError("The device evidence upload is larger than 100 MB.")
        target = workspace.joinpath(*rel.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    report_bytes = json.dumps(report).encode("utf-8")
    (workspace / "results.json").write_bytes(report_bytes)
    log_path = workspace / "run.log"
    log_path.write_text(str(log or ""), encoding="utf-8", errors="replace")

    runner = LocalPlaywrightRunner()
    rows, parse_failure = runner._parse_results(report_bytes, workspace)
    metadata = dict(run.run_metadata or {})
    case = db.get(AutomationTestCase, run.test_case_id) if run.test_case_id else None
    data = test_data.for_code(
        db, str(metadata.get("code") or ""), environment=run.environment,
        case_url=case.application_url if case else None, base_url=metadata.get("base_url"),
        case_environment=case.environment if case else None,
    )
    secrets = data.get("secrets") or []
    for row in rows:
        row.error_message = test_data.redact(row.error_message, secrets)
        row.stack_trace = test_data.redact(row.stack_trace, secrets)
        db.add(AutomationRunResult(
            run_id=run.id, test_name=row.name[:500], status=row.status, duration_ms=row.duration_ms,
            error_message=row.error_message, stack_trace=row.stack_trace,
            screenshot_path=row.screenshot_path, video_path=row.video_path, trace_path=row.trace_path,
            console_logs=row.console_logs, network_logs=row.network_logs,
        ))
    clean_log = test_data.redact(log_path.read_text(encoding="utf-8", errors="replace"), secrets)
    log_path.write_text(clean_log, encoding="utf-8")
    counts = {name: sum(1 for row in rows if row.status == name) for name in ("pass", "fail", "skip", "error", "blocked")}
    completed = exit_code in (0, 1) and not parse_failure
    run.status = "completed" if completed else "failed"
    run.outcome = "passed" if completed and counts["pass"] and not (counts["fail"] + counts["error"] + counts["blocked"]) else "failed" if completed else "blocked"
    run.error_message = test_data.redact(parse_failure or (None if completed else f"Playwright exited with code {exit_code}."), secrets)
    run.total_tests = len(rows); run.passed = counts["pass"]; run.failed = counts["fail"] + counts["error"]
    run.skipped = counts["skip"]; run.blocked = counts["blocked"]
    run.duration_seconds = max(0, int(duration_seconds)); run.workspace_path = str(workspace); run.log_path = str(log_path)
    run.completed_at = datetime.utcnow()
    progress_value = metadata.get("step_progress") if isinstance(metadata.get("step_progress"), dict) else {}
    if not progress_value.get("history") and rows:
        first = rows[0]
        progress_value = {
            "total": max(1, len(rows)),
            "current": max(1, len(rows)),
            "title": first.name,
            "status": "passed" if run.outcome == "passed" else "failed",
            "history": [
                {
                    "n": index,
                    "title": row.name,
                    "ok": row.status == "pass",
                    "ms": row.duration_ms,
                    "error": row.error_message,
                }
                for index, row in enumerate(rows, start=1)
            ],
        }
    else:
        progress_value = {**progress_value, "status": "passed" if run.outcome == "passed" else "failed"}
    metadata.pop("live_log", None)
    run.run_metadata = {
        **metadata, "execution_phase": "Device run complete", "phase_step": 5,
        "step_progress": progress_value,
        "runner": {"runner": "device-playwright", "exit_code": exit_code, "execution_target": "device"},
        "device_agent": {**agent, "token_hash": None, "state": "completed", "finished": True,
                         "message": "Device Playwright run completed and uploaded its evidence."},
    }
    db.commit(); db.refresh(run)
    return run


def fail(db: Session, run_key: str, token: str, message: str) -> AutomationRun:
    run, agent = _authorise(db.query(AutomationRun).filter(AutomationRun.run_key == run_key).first(), token)
    run.status = "failed"; run.outcome = "blocked"; run.error_message = (message or "Device Playwright stopped.")[:1000]
    run.completed_at = datetime.utcnow()
    run.run_metadata = {**(run.run_metadata or {}), "device_agent": {
        **agent, "token_hash": None, "state": "failed", "finished": True, "message": run.error_message,
    }}
    db.commit(); db.refresh(run)
    return run


def cancel(db: Session, run: AutomationRun) -> AutomationRun:
    agent = _agent(run)
    if run.status not in ("queued", "running"):
        return run
    run.status = "cancelled"; run.outcome = None; run.error_message = "The device run was cancelled by the user."
    run.completed_at = datetime.utcnow()
    run.run_metadata = {**(run.run_metadata or {}), "device_agent": {
        **agent, "token_hash": None, "state": "cancelled", "message": run.error_message,
    }}
    db.commit(); db.refresh(run)
    return run
