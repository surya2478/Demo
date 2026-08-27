"""
Runner abstraction.

--- Automation Module: ported from stlc-platform -----------------------------
Source: app/services/automation_runner/base.py

A runner takes a materialised workspace (script on disk plus framework config)
and returns a structured result: per-test outcomes and captured artifact file
paths. Pure stdlib, so this file ports unchanged apart from its docstring.
"""
from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path


async def await_process(
    proc: asyncio.subprocess.Process,
    *,
    timeout_seconds: int,
    cancellation: asyncio.Event | None = None,
) -> str:
    """Wait for a runner subprocess, racing the timeout and a cancel signal.

    Returns "exited", "timeout" or "cancelled". The caller kills the process for
    the latter two; this only decides which happened.

    A process that exited wins over a cancel arriving at the same moment — a
    real result is better evidence than an abandoned one.
    """
    exit_waiter = asyncio.ensure_future(proc.wait())
    waiters: set[asyncio.Future] = {exit_waiter}
    cancel_waiter: asyncio.Future | None = None
    if cancellation is not None:
        cancel_waiter = asyncio.ensure_future(cancellation.wait())
        waiters.add(cancel_waiter)

    done, pending = await asyncio.wait(
        waiters, timeout=timeout_seconds, return_when=asyncio.FIRST_COMPLETED
    )
    for task in pending:
        task.cancel()

    if exit_waiter in done:
        return "exited"
    if cancel_waiter is not None and cancel_waiter in done:
        return "cancelled"
    return "timeout"


@dataclass(slots=True)
class PerTestResult:
    """A single test inside the script's results."""

    name: str
    # Status vocabulary shared with the database:
    #   pass | fail | skip | error | blocked
    #
    # "blocked" is load-bearing and must never be collapsed into "fail" or,
    # worse, "pass". A target that could not be reached did not test anything;
    # recording it as a pass manufactures confidence, which is the defect the
    # POC's WAF fallback demonstrated.
    status: str
    duration_ms: int | None = None
    error_message: str | None = None
    stack_trace: str | None = None
    # Absolute paths on disk to artifacts captured for THIS test.
    screenshot_path: str | None = None
    video_path: str | None = None
    trace_path: str | None = None
    # Parsed inline rather than left as file paths: small, structured JSON
    # attached by the spec through Playwright's public testInfo.attach() API,
    # rather than parsed out of trace.zip's internal format.
    console_logs: list[dict] | None = None
    network_logs: list[dict] | None = None
    raw: dict = field(default_factory=dict)


@dataclass(slots=True)
class RunnerResult:
    """End-to-end runner outcome for one script execution."""

    # queued | running | completed | failed | cancelled
    run_status: str
    results: list[PerTestResult]
    duration_seconds: float
    # Combined stdout/stderr capture; served through the authenticated
    # artifact route rather than as a filesystem path.
    log_path: str | None
    # Set when the runner could not start at all (missing Node, for example),
    # alongside an empty results list and run_status="failed".
    error_message: str | None = None
    # Free-form: workspace dir, command, exit code, how many environment
    # variables the allowlist withheld.
    metadata: dict = field(default_factory=dict)


class AutomationRunner(ABC):
    """Common contract every runner implements."""

    name: str = "base"

    @abstractmethod
    async def run(
        self,
        *,
        workspace_dir: Path,
        script_file_name: str,
        environment: str | None,
        timeout_seconds: int = 600,
        cancellation: asyncio.Event | None = None,
        on_progress: Callable[[dict], None] | None = None,
    ) -> RunnerResult:
        """Execute the script under workspace_dir and return a normalised result.

        workspace_dir     already created, holding the script and its framework
                          config
        script_file_name  file inside workspace_dir to point the runner at
        environment       free-form label ("SIT", "QA"), surfaced to the script
                          as AUTOMATION_ENV so tests can branch on it
        timeout_seconds   hard cap; the runner kills the subprocess and reports
                          run_status="failed"
        cancellation      set by the caller to stop now. The runner terminates
                          the process and reports run_status="cancelled" with
                          whatever artifacts it already wrote. Ignoring this
                          would make a Cancel control a lie.
        on_progress       called with a snapshot dict as the run advances
                          through its steps, so a caller can surface progress
                          before the result exists. Optional, best-effort and
                          never load-bearing: a runner with nothing to report,
                          or a callback that raises, must not change the run's
                          outcome.
        """
        raise NotImplementedError
