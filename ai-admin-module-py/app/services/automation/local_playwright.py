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
import io
import json
import logging
import os
import re
import shlex
import subprocess
import time
from collections.abc import Callable
from pathlib import Path

from . import workspace as ws
from .base import AutomationRunner, PerTestResult, RunnerResult, await_process
from .env_policy import build_runner_env
from .preflight import is_available, npx_command

_ANSI_ESCAPE_RE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def _strip_ansi(value):
    if not isinstance(value, str):
        return value
    return _ANSI_ESCAPE_RE.sub("", value).strip()


logger = logging.getLogger(__name__)


def _log_tail(path: Path, *, lines: int = 15, limit: int = 2000) -> str | None:
    """The last non-blank lines of run.log, ANSI-stripped, or None."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    kept = [line.rstrip() for line in _strip_ansi(text).splitlines() if line.strip()]
    tail = "\n".join(kept[-lines:])
    return tail[-limit:] or None

# ── Spawning on a loop that cannot spawn ─────────────────────────────────────
# asyncio.create_subprocess_exec needs a loop with a subprocess transport. On
# Windows only the Proactor loop has one, and uvicorn selects a SelectorEventLoop
# whenever it runs with --reload or multiple workers -- so a dev server started
# the ordinary way makes every run die before Playwright is reached, raising a
# NotImplementedError whose str() is empty ("Unexpected error: " in the UI).
# Threads work on any loop, so a run falls back to a blocking Popen driven from
# the default executor rather than failing on how the server happened to boot.

_THREAD_SPAWN_WARNED = False


class _ThreadedStdout:
    """The `.read()` half of StreamReader, backed by a blocking pipe."""

    def __init__(self, pipe: io.BufferedReader) -> None:
        self._pipe = pipe

    async def read(self, n: int = -1) -> bytes:
        # read1, not read: read() would block until n bytes or EOF, which stalls
        # the tee until the report is complete instead of streaming it.
        return await asyncio.to_thread(self._pipe.read1, n)


class _ThreadedProcess:
    """The slice of asyncio.subprocess.Process this runner actually uses."""

    def __init__(self, popen: subprocess.Popen) -> None:
        self._popen = popen
        self.stdout = _ThreadedStdout(popen.stdout) if popen.stdout else None
        self._exit: asyncio.Future | None = None

    @property
    def returncode(self) -> int | None:
        return self._popen.returncode

    def kill(self) -> None:
        try:
            self._popen.kill()
        except OSError:
            # Already gone: the timeout and the process exiting can race.
            pass

    async def wait(self) -> int:
        # One shared waiter, shielded: await_process() cancels its copy when the
        # timeout wins, and the caller then awaits wait() again after the kill.
        # A thread per call would leak one on every timed-out run.
        if self._exit is None:
            self._exit = asyncio.ensure_future(asyncio.to_thread(self._popen.wait))
        return await asyncio.shield(self._exit)


async def _spawn(cmd, *, cwd, stderr, env):
    """Start the runner process. Returns (process, used_thread_fallback)."""
    global _THREAD_SPAWN_WARNED
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=stderr,
            env=env,
        )
        return proc, False
    except NotImplementedError:
        if not _THREAD_SPAWN_WARNED:
            _THREAD_SPAWN_WARNED = True
            logger.warning(
                "This event loop (%s) has no subprocess support, so runs are "
                "spawned on threads instead. On Windows, uvicorn selects such a "
                "loop for --reload; start the server without it to avoid the "
                "fallback.",
                type(asyncio.get_running_loop()).__name__,
            )
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=stderr,
            env=env,
        )
        return _ThreadedProcess(proc), True


# ── Live step progress ───────────────────────────────────────────────────────
# progress-reporter.cjs appends one NDJSON line per test.step boundary while
# the run is still going. Reading it here is what lets the UI show step 3 of 6
# instead of a spinner: the JSON reporter on stdout says nothing until the
# process exits, and by then the question has answered itself.
#
# Polling a file rather than watching it. The reporter appends from another
# process, there is no portable async file-watch in the stdlib, and with slowMo
# in play the events are seconds apart -- so a 0.75s poll is well inside the
# resolution anyone can perceive and costs a stat plus a short read.

_PROGRESS_POLL_SECONDS = 0.75

_WHITESPACE_RUN_RE = re.compile(r"\s+")


def _collapse(value, *, limit: int = 300):
    """Multi-line reporter text as one readable line, or None."""
    if not value:
        return None
    flattened = _WHITESPACE_RUN_RE.sub(" ", str(value)).strip()
    if not flattened:
        return None
    return flattened if len(flattened) <= limit else flattened[: limit - 1].rstrip() + "…"


def _reduce_progress(state: dict, event: dict) -> bool:
    """Fold one reporter event into `state`. True when something changed.

    History is append-only and keyed by (attempt, index): a retry restarts its
    numbering, and without the attempt the list would appear to run backwards
    on the second pass rather than starting a new one.
    """
    kind = event.get("event")

    if kind == "run_begin":
        state["history"] = []
        state["current"] = 0
        state["title"] = None
        state["status"] = "running"
        return True

    if kind == "step_begin":
        state["current"] = event.get("index") or (state.get("current") or 0) + 1
        state["title"] = event.get("title")
        state["attempt"] = event.get("attempt") or 1
        state["status"] = "running"
        return True

    if kind == "step_end":
        state["history"] = [
            row
            for row in state.get("history") or []
            if not (
                row.get("n") == event.get("index")
                and row.get("attempt") == (event.get("attempt") or 1)
            )
        ] + [
            {
                "n": event.get("index"),
                "attempt": event.get("attempt") or 1,
                "title": event.get("title"),
                "ok": bool(event.get("ok")),
                "ms": event.get("duration_ms"),
                # Same treatment the per-test error gets. Playwright colours
                # its call log, so without this the UI renders a step failure
                # as "[2m - waiting for getByLabel('Username')[22m". Newlines
                # collapse too: this is a one-line label under a step row, not
                # a stack trace panel.
                "error": _collapse(_strip_ansi(event.get("error"))),
            }
        ]
        state["current"] = event.get("index") or state.get("current")
        state["title"] = event.get("title")
        if not event.get("ok"):
            state["status"] = "failed"
        return True

    if kind == "test_end":
        state["status"] = event.get("status") or state.get("status")
        return True

    return False


def _read_new_lines(path: Path, cursor: dict) -> list[dict]:
    """Events appended since the last call. Never raises."""
    try:
        size = path.stat().st_size
    except OSError:
        return []
    # The reporter truncates at onBegin, so a shrunken file is a new run rather
    # than corruption -- rewind instead of reading from a stale offset.
    if size < cursor.get("offset", 0):
        cursor["offset"] = 0
    if size == cursor.get("offset", 0):
        return []

    try:
        with path.open("r", encoding="utf-8") as fh:
            fh.seek(cursor.get("offset", 0))
            chunk = fh.read()
            # A partial final line means the reporter is mid-append. Leave it
            # for the next pass rather than parsing half a record.
            if chunk and not chunk.endswith("\n"):
                chunk = chunk[: chunk.rfind("\n") + 1]
            cursor["offset"] = cursor.get("offset", 0) + len(chunk.encode("utf-8"))
    except OSError:
        return []

    events = []
    for line in chunk.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except ValueError:
            continue
    return events


def _publish(state: dict, on_progress) -> None:
    """Hand a snapshot to the caller. A reporting failure never fails a run."""
    try:
        on_progress(dict(state))
    except Exception:  # noqa: BLE001 - progress is diagnostics, not the result
        logger.exception("Progress callback raised; continuing the run")


def _drain_progress_once(path: Path, on_progress) -> None:
    """Final synchronous sweep, for after the process has already exited."""
    state: dict = {"history": [], "current": 0, "status": "running"}
    cursor = {"offset": 0}
    changed = False
    for event in _read_new_lines(path, cursor):
        changed = _reduce_progress(state, event) or changed
    if changed:
        _publish(state, on_progress)


async def _tail_progress(path: Path, on_progress) -> None:
    """Follow the reporter's NDJSON and publish a snapshot on every change."""
    state: dict = {"history": [], "current": 0, "status": "running"}
    cursor = {"offset": 0}
    while True:
        await asyncio.sleep(_PROGRESS_POLL_SECONDS)
        changed = False
        for event in _read_new_lines(path, cursor):
            changed = _reduce_progress(state, event) or changed
        if changed:
            _publish(state, on_progress)


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
        on_progress: Callable[[dict], None] | None = None,
        extra_env: dict[str, str] | None = None,
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
        # progress-reporter.cjs rides alongside the JSON reporter to emit step
        # boundaries while the run is still going -- the JSON reporter writes
        # nothing until the process exits. It appends to progress.ndjson and
        # never touches stdout, so the parse below is unaffected. A workspace
        # written before that reporter existed simply has no file to run, so
        # it is only requested when present.
        reporter = "json"
        if (workspace_dir / ws.PROGRESS_REPORTER_FILE_NAME).exists():
            reporter = f"json,./{ws.PROGRESS_REPORTER_FILE_NAME}"
        cmd = [
            npx_command() or "npx",
            "--yes",
            "playwright",
            "test",
            script_file_name,
            f"--reporter={reporter}",
        ]

        env, withheld_env = build_runner_env(
            source=os.environ,
            # Test data (TESTDATA_*) rides in as overrides, set by the runner
            # itself, so the allowlist above stays exactly as strict as it is.
            overrides={**(extra_env or {}), "AUTOMATION_ENV": environment or "", "CI": "1"},
            runner_name=self.name,
        )

        start = time.monotonic()
        json_stdout = bytearray()
        proc = None
        spawned_on_thread = False

        try:
            with log_path.open("wb") as log_fh:
                proc, spawned_on_thread = await _spawn(
                    cmd,
                    cwd=str(workspace_dir),
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
                progress_task = (
                    asyncio.create_task(
                        _tail_progress(workspace_dir / ws.PROGRESS_FILE_NAME, on_progress)
                    )
                    if on_progress is not None
                    else None
                )
                outcome = await await_process(
                    proc, timeout_seconds=timeout_seconds, cancellation=cancellation
                )
                # One last pass before tearing the tail down, so the steps that
                # completed in the final second are not lost -- on a timeout or
                # a cancel those are the most informative records there are.
                if progress_task is not None:
                    progress_task.cancel()
                    _drain_progress_once(
                        workspace_dir / ws.PROGRESS_FILE_NAME, on_progress
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
            # No report on stdout means Playwright died before any reporter
            # ran (config or module load, npx, browser launch), and the reason
            # is only on stderr. Carry its tail so the run says why.
            if not json_stdout:
                stderr_tail = _log_tail(log_path)
                if stderr_tail:
                    error_message = f"{error_message}\n{stderr_tail}"

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
                "spawn": "thread" if spawned_on_thread else "loop",
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
        top_errors = report.get("errors", [])
        if top_errors and isinstance(top_errors, list):
            first_top_err = top_errors[0]
            if isinstance(first_top_err, dict) and first_top_err.get("message"):
                return [], _strip_ansi(first_top_err.get("message"))
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
