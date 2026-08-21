"""
Playwright runner — executes one spec via `npx playwright test`.

--- Automation Module: ported from stlc-platform -----------------------------
Source: app/services/automation_runner/local_playwright.py

Runs the spec as a subprocess, forces the JSON reporter, parses per-test
outcomes, and lifts screenshot, video and trace paths out of the attachments
Playwright records.

Two upstream behaviours are preserved deliberately, because both were fixes
rather than choices:

  * A clean exit code is not a result. If the reporter produced nothing
    parseable, the run is reported failed rather than "completed" — otherwise a
    broken config or a spec matching no tests reaches the caller as a scoreable
    outcome.
  * ANSI escapes are stripped from error text, so the UI shows a readable
    message instead of "[31m...[39m".
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import time
from pathlib import Path

from .base import AutomationRunner, PerTestResult, RunnerResult, await_process
from .env_policy import build_runner_env
from .preflight import is_available, npx_command

_ANSI_ESCAPE_RE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def _strip_ansi(value):
    if not isinstance(value, str):
        return value
    return _ANSI_ESCAPE_RE.sub("", value).strip()


# Playwright's vocabulary mapped to the one the database stores. "blocked" is
# not produced here — it is decided a level up, when the target itself could
# not be reached.
PLAYWRIGHT_STATUS_TO_DB = {
    "passed": "pass",
    "failed": "fail",
    "timedout": "fail",
    "skipped": "skip",
    "interrupted": "error",
    "flaky": "fail",
}


class LocalPlaywrightRunner(AutomationRunner):
    name = "local_playwright"

    async def run(
        self,
        *,
        workspace_dir: Path,
        script_file_name: str,
        environment: str | None,
        timeout_seconds: int = 600,
        cancellation: asyncio.Event | None = None,
    ) -> RunnerResult:
        available, detail = is_available("playwright")
        if not available:
            return RunnerResult(
                run_status="failed",
                results=[],
                duration_seconds=0.0,
                log_path=None,
                error_message=detail,
                metadata={"runner": self.name},
            )

        log_path = workspace_dir / "run.log"
        # --reporter=json overrides whatever the workspace config says, so a
        # generated config cannot leave the run unparseable.
        # Full path, not a bare name: on Windows npx is a .CMD shim that
        # subprocess cannot launch. See preflight.resolve_node_tool.
        cmd = [npx_command() or "npx", "--yes", "playwright", "test", script_file_name, "--reporter=json"]

        env, withheld_env = build_runner_env(
            source=os.environ,
            overrides={"AUTOMATION_ENV": environment or "", "CI": "1"},
            runner_name=self.name,
        )

        start = time.monotonic()
        json_stdout = bytearray()
        proc = None

        try:
            with log_path.open("wb") as log_fh:
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    cwd=str(workspace_dir),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=log_fh,
                    env=env,
                )

                async def drain_stdout() -> None:
                    # Tee rather than redirect: stdout carries the JSON report,
                    # and without copying it into the log the log holds stderr
                    # alone and is empty on a clean run.
                    assert proc.stdout is not None
                    while True:
                        chunk = await proc.stdout.read(64 * 1024)
                        if not chunk:
                            break
                        json_stdout.extend(chunk)
                        log_fh.write(chunk)

                drain_task = asyncio.create_task(drain_stdout())
                outcome = await await_process(
                    proc, timeout_seconds=timeout_seconds, cancellation=cancellation
                )

                if outcome != "exited":
                    proc.kill()
                    await proc.wait()
                    drain_task.cancel()
                    cancelled = outcome == "cancelled"
                    return RunnerResult(
                        run_status="cancelled" if cancelled else "failed",
                        results=[],
                        duration_seconds=time.monotonic() - start,
                        log_path=str(log_path),
                        error_message=(
                            "The run was cancelled while the test was executing; "
                            "the browser process was terminated."
                            if cancelled
                            else f"The run timed out after {timeout_seconds}s."
                        ),
                        metadata={
                            "runner": self.name,
                            "command": " ".join(shlex.quote(a) for a in cmd),
                            "cancelled": cancelled,
                        },
                    )
                await drain_task

        except (FileNotFoundError, OSError) as exc:
            return RunnerResult(
                run_status="failed",
                results=[],
                duration_seconds=time.monotonic() - start,
                log_path=None,
                error_message=f"Could not start Playwright: {exc}",
                metadata={"runner": self.name},
            )

        duration = time.monotonic() - start
        exit_code = proc.returncode if proc.returncode is not None else -1

        # Keep the raw report beside the log so it is downloadable as evidence.
        if json_stdout:
            (workspace_dir / "results.json").write_bytes(bytes(json_stdout))

        results, parse_failure = self._parse_results(json_stdout, workspace_dir)

        # 0 = all passed, 1 = a test failed, 2 = interrupted, anything else is
        # a runner fault rather than a test outcome.
        if exit_code in (0, 1):
            run_status, error_message = "completed", None
        else:
            run_status = "failed"
            error_message = f"Playwright exited with code {exit_code}."

        # A clean exit does not prove a test ran. Reporting an unparseable run
        # as "completed" would let a harness defect arrive as a scoreable result.
        if parse_failure:
            run_status = "failed"
            error_message = f"{parse_failure} (exit code {exit_code}; see run.log)"

        return RunnerResult(
            run_status=run_status,
            results=results,
            duration_seconds=duration,
            log_path=str(log_path),
            error_message=error_message,
            metadata={
                "runner": self.name,
                "command": " ".join(shlex.quote(a) for a in cmd),
                "exit_code": exit_code,
                "env_withheld_count": len(withheld_env),
            },
        )

    # ── Parsing ──────────────────────────────────────────────────────────────

    def _parse_results(
        self, raw_json: bytes, workspace_dir: Path
    ) -> tuple[list[PerTestResult], str | None]:
        """Parse the JSON reporter output.

        Returns `(rows, parse_failure_reason)`. An empty result list is never
        replaced with a synthesised outcome.
        """
        if not raw_json:
            return [], (
                "The Playwright JSON reporter produced no output, so no test result "
                "could be read. The run cannot be scored."
            )
        try:
            report = json.loads(raw_json.decode("utf-8", errors="replace"))
        except json.JSONDecodeError:
            return [], (
                "The Playwright JSON reporter output could not be parsed, so no test "
                "result could be read. The run cannot be scored."
            )

        rows: list[PerTestResult] = []
        for suite in report.get("suites", []):
            self._collect_specs(suite, workspace_dir, rows)

        if rows:
            return rows, None
        return [], (
            "The Playwright JSON reporter reported no tests. Nothing executed, so "
            "there is no result to score."
        )

    def _collect_specs(self, suite: dict, workspace_dir: Path, sink: list[PerTestResult]) -> None:
        for spec in suite.get("specs", []):
            for test in spec.get("tests", []):
                for result in test.get("results", []):
                    status = PLAYWRIGHT_STATUS_TO_DB.get(
                        (result.get("status") or "").lower(), "error"
                    )
                    duration_ms = result.get("duration")
                    if isinstance(duration_ms, (int, float)):
                        duration_ms = int(duration_ms)
                    else:
                        duration_ms = None

                    error_message = stack_trace = None
                    error = result.get("error")
                    if isinstance(error, dict):
                        error_message = _strip_ansi(error.get("message"))
                        stack_trace = _strip_ansi(error.get("stack"))
                    elif result.get("errors"):
                        first = (result.get("errors") or [{}])[0]
                        if isinstance(first, dict):
                            error_message = _strip_ansi(first.get("message"))
                            stack_trace = _strip_ansi(first.get("stack"))

                    attachments = result.get("attachments") or []
                    screenshot, video, trace = self._lift_attachments(attachments, workspace_dir)

                    sink.append(
                        PerTestResult(
                            name=spec.get("title") or test.get("title") or "unknown",
                            status=status,
                            duration_ms=duration_ms,
                            error_message=error_message,
                            stack_trace=stack_trace,
                            screenshot_path=screenshot,
                            video_path=video,
                            trace_path=trace,
                            raw={"playwright_status": result.get("status")},
                        )
                    )
        for child in suite.get("suites", []):
            self._collect_specs(child, workspace_dir, sink)

    def _lift_attachments(
        self, attachments: list[dict], workspace_dir: Path
    ) -> tuple[str | None, str | None, str | None]:
        """Pull screenshot, video and trace paths out of the attachment list.

        Paths are confined to the workspace as defence in depth: they come from
        a report a generated spec can influence.
        """
        screenshot = video = trace = None
        root = workspace_dir.resolve()

        for att in attachments:
            name = (att.get("name") or "").lower()
            path = att.get("path")
            if not path:
                continue
            abs_path = (workspace_dir / path).resolve()
            try:
                abs_path.relative_to(root)
            except ValueError:
                continue
            if "screenshot" in name and not screenshot:
                screenshot = str(abs_path)
            elif "video" in name and not video:
                video = str(abs_path)
            elif "trace" in name and not trace:
                trace = str(abs_path)

        return screenshot, video, trace
