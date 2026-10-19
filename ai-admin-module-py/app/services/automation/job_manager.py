"""
--- Automation Module: run execution and concurrency --------------------------

Replaces upstream's Celery worker with asyncio tasks on the running event loop.
That is a deliberate downgrade, and the reason it is safe here: a run is one
subprocess this process supervises, concurrency is capped at one by default,
and there is no second machine to distribute to. Celery would add Redis and a
worker process to a deployment whose whole point is having neither.

What is given up, stated plainly so nobody discovers it later:

  * A backend restart loses in-flight runs. They are marked failed on the next
    startup sweep rather than left as "running" forever.
  * There is no retry queue. A failed run is re-triggered by a person.
  * Runs do not survive being distributed across replicas, because there are
    none.

Two rules hold in here:

  Background work opens its own database session. The request-scoped session
  from get_db() is closed the moment the response returns, so touching it from
  a background task yields a DetachedInstanceError at best.

  Writes stay coarse -- one row per run, updated on state transitions only.
  This is SQLite with a background purge loop already writing to it; a
  per-log-line write would put run traffic in contention with the rest of the
  application.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from ...config import settings
from ...database.connection import SessionLocal
from ...models.automation import (
    AutomationDiscoveredElement,
    AutomationDiscoveryRun,
    AutomationRun,
    AutomationRunResult,
    AutomationScript,
)
from . import healer
from . import test_data
from . import workspace as ws
from .local_playwright import LocalPlaywrightRunner

logger = logging.getLogger(__name__)


def _scrub(result, secrets: list[str]) -> None:
    """Blank secret test data out of everything a run keeps: results, log, error."""
    if not secrets:
        return
    result.error_message = test_data.redact(result.error_message, secrets)
    for row in result.results:
        row.error_message = test_data.redact(row.error_message, secrets)
        row.stack_trace = test_data.redact(row.stack_trace, secrets)
        row.console_logs = test_data.redact_deep(row.console_logs, secrets)
        row.network_logs = test_data.redact_deep(row.network_logs, secrets)
        row.raw = test_data.redact_deep(row.raw, secrets)
    if result.log_path:
        try:
            path = Path(result.log_path)
            text = path.read_text(encoding="utf-8", errors="replace")
            cleaned = test_data.redact(text, secrets)
            if cleaned != text:
                path.write_text(cleaned, encoding="utf-8")
        except OSError:
            logger.warning("Could not redact the runner log at %s", result.log_path)


class JobManager:
    """Tracks in-flight runs and enforces the concurrency cap.

    A single instance is held at module level. It is not shared across
    processes, which is correct here: this deployment runs one backend process,
    and a cap that only counts its own runs is the honest one.
    """

    def __init__(self) -> None:
        # Values are asyncio.Task or concurrent.futures.Future depending on the
        # calling context -- see submit(). Both expose done() and
        # add_done_callback(), which is all this class needs of them.
        self._tasks: dict[str, Any] = {}
        self._cancels: dict[str, asyncio.Event] = {}
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Remember the application's event loop.

        Needed because the endpoints that submit work are synchronous, and
        FastAPI runs sync endpoints in a threadpool where there is no running
        loop -- asyncio.create_task() there raises "no running event loop".
        Called once from the startup hook, on the loop itself.

        Making the endpoints async would also work, but it would put the
        synchronous SQLite writes on the event loop, which is a worse trade in
        a process that is also serving every other request.
        """
        self._loop = loop

    # ── Capacity ─────────────────────────────────────────────────────────────

    @property
    def limit(self) -> int:
        return max(1, int(settings.AUTOMATION_MAX_CONCURRENT_RUNS or 1))

    def active_count(self) -> int:
        return sum(1 for task in self._tasks.values() if not task.done())

    def capacity(self) -> tuple[bool, str]:
        """Whether another run may start, and why not when it may not.

        Browser runs are memory-hungry and this backend is one process, so the
        cap is a real protection rather than a formality. Refusing with a clear
        reason beats accepting a run that then thrashes the host.
        """
        active = self.active_count()
        if active >= self.limit:
            return False, (
                f"{active} of {self.limit} run slot(s) in use. "
                "Wait for the current run to finish, or raise "
                "AUTOMATION_MAX_CONCURRENT_RUNS."
            )
        return True, ""

    # ── Lifecycle ────────────────────────────────────────────────────────────

    def submit(self, run_key: str) -> None:
        """Schedule a queued run. Returns immediately; the run continues after
        the HTTP response has been sent.

        Callable from either context. A sync endpoint runs in FastAPI's
        threadpool with no loop of its own, so the work is handed to the bound
        application loop instead; an async caller schedules directly.
        """
        cancel = asyncio.Event()
        self._cancels[run_key] = cancel
        coro = self._execute(run_key, cancel)

        try:
            asyncio.get_running_loop()
        except RuntimeError:
            # Threadpool: hand it to the application loop.
            if self._loop is None or self._loop.is_closed():
                self._cancels.pop(run_key, None)
                coro.close()
                raise RuntimeError(
                    "The automation job manager is not bound to an event loop. "
                    "The startup hook did not run."
                )
            handle = asyncio.run_coroutine_threadsafe(coro, self._loop)
        else:
            handle = asyncio.create_task(coro)

        self._tasks[run_key] = handle
        handle.add_done_callback(lambda _h: self._forget(run_key))

    def _forget(self, run_key: str) -> None:
        self._tasks.pop(run_key, None)
        self._cancels.pop(run_key, None)

    def cancel(self, run_key: str) -> bool:
        """Ask a run to stop. The runner terminates the browser process and
        reports whatever artifacts it already captured."""
        event = self._cancels.get(run_key)
        if event is None:
            return False
        # asyncio.Event.set() is not thread-safe, and this is usually called
        # from a sync endpoint in FastAPI's threadpool. Setting it directly
        # from there can leave a waiter on the loop unwoken.
        loop = self._loop
        if loop is not None and not loop.is_closed():
            try:
                asyncio.get_running_loop()
            except RuntimeError:
                loop.call_soon_threadsafe(event.set)
                return True
        event.set()
        return True

    def is_active(self, run_key: str) -> bool:
        task = self._tasks.get(run_key)
        return task is not None and not task.done()

    # ── Execution ────────────────────────────────────────────────────────────

    async def _execute(self, run_key: str, cancel: asyncio.Event) -> None:
        """Materialise the workspace, run the script, persist the outcome.

        Every exit path writes a terminal status. A run left at "running"
        because something raised is worse than a failed one -- the UI polls it
        forever and nobody learns why.
        """
        db = SessionLocal()
        try:
            run = db.query(AutomationRun).filter(AutomationRun.run_key == run_key).first()
            if run is None:
                logger.error("Run %s vanished before execution", run_key)
                return

            code = (run.run_metadata or {}).get("code") or ""
            base_url = (run.run_metadata or {}).get("base_url")
            file_name_hint = (run.run_metadata or {}).get("file_name")

            # --- Test data -------------------------------------------------
            # The values the spec reads from TESTDATA_*, from Automation
            # Studio's Test data for this application and environment. A run
            # missing one stops here, blocked, with the names it needs --
            # rather than typing "<set TESTDATA_...>" into the page and failing
            # at the login step.
            case = getattr(run, "test_case", None) or (
                getattr(run.script, "test_case", None) if getattr(run, "script", None) else None
            )
            data = test_data.for_code(
                db,
                code,
                environment=run.environment,
                case_url=getattr(case, "application_url", None),
                base_url=base_url,
            )
            run.run_metadata = {**(run.run_metadata or {}), "test_data": test_data.public(data)}
            db.commit()
            missing = test_data.missing_message(data)
            if missing:
                self._finalise(db, run, status="failed", outcome="blocked", error=missing)
                return
            data_env: dict[str, str] = dict(data["values"])
            secrets: list[str] = data["secrets"]
            # No address chosen for this run: the environment's own, from Test
            # Data. Scripts read BASE_URL (falling back to the host they were
            # generated against), so this is what sends a run to RC's host.
            if not base_url and data.get("base_url"):
                base_url = data["base_url"]
                data_env["BASE_URL"] = base_url
                run.run_metadata = {**(run.run_metadata or {}), "target_url": data.get("address")}
                db.commit()

            run.status = "running"
            run.started_at = datetime.utcnow()
            run.run_metadata = {
                **(run.run_metadata or {}),
                "execution_phase": "Assessing Readiness & Workspace",
                "phase_step": 1,
            }
            db.commit()

            try:
                workspace = ws.reset_workspace(run_key)
                script_name = ws.materialize_script(
                    workspace=workspace, code=code, suggested_file_path=file_name_hint
                )
                run_cfg = run.run_config or {}
                slow_mo_ms = int(
                    run_cfg.get("slow_mo_ms")
                    if run_cfg.get("slow_mo_ms") is not None
                    else getattr(settings, "AUTOMATION_DEFAULT_SLOW_MO_MS", 1000)
                )
                headless = bool(run_cfg.get("headless", True))
                # Only walks and crawls carry a browser choice; other runs stay
                # on Playwright's Chromium.
                browser, browser_note = (
                    ws.resolve_browser(run_cfg.get("browser")) if run_cfg.get("browser") else ("chromium", None)
                )
                ws.write_playwright_config(
                    workspace,
                    base_url=base_url,
                    slow_mo_ms=slow_mo_ms,
                    headless=headless,
                    browser=browser,
                )
                run.workspace_path = str(workspace)
                run.run_metadata = {
                    **(run.run_metadata or {}),
                    "browser": browser,
                    "browser_note": browser_note,
                    "execution_phase": "Executing Playwright Engine",
                    "phase_step": 4,
                    # Counted from the spec rather than carried down from the
                    # compiler, so a script hand-edited in Script Lab reports
                    # the steps it actually has. Seeded before the run starts
                    # so the UI can say "0 of 6" immediately instead of staying
                    # blank until the first step reports.
                    "step_progress": {
                        "total": code.count("await test.step("),
                        "current": 0,
                        "status": "running",
                        "history": [],
                    },
                }
                db.commit()
            except Exception as exc:  # noqa: BLE001 - surfaced on the run itself
                logger.exception("Workspace preparation failed for %s", run_key)
                self._finalise(
                    db,
                    run,
                    status="failed",
                    outcome="blocked",
                    error=f"Could not prepare the run workspace: {exc}",
                )
                return

            # --- Live step progress ------------------------------------------
            # The runner publishes a snapshot each time a step starts or ends;
            # this writes it where the run-detail poll already looks. `total`
            # is preserved from the seed above because the reporter counts
            # steps as it meets them and cannot know how many are coming.
            #
            # Throttled, and deliberately so: the poll is on a 2s interval, so
            # committing faster than that writes rows nobody reads on a host
            # that is also driving a browser. A terminal snapshot is always
            # written, whatever the clock says, so the last step never sticks
            # at "running".
            progress_state: dict[str, Any] = {"last_commit": 0.0}

            def publish_progress(snapshot: dict) -> None:
                snapshot = test_data.redact_deep(snapshot, secrets)
                now = time.monotonic()
                terminal = snapshot.get("status") in ("failed", "passed", "timedOut")
                if not terminal and now - progress_state["last_commit"] < 1.0:
                    return
                progress_state["last_commit"] = now
                try:
                    current = (
                        db.query(AutomationRun)
                        .filter(AutomationRun.run_key == run_key)
                        .first()
                    )
                    if current is None:
                        return
                    meta = dict(current.run_metadata or {})
                    previous = dict(meta.get("step_progress") or {})
                    meta["step_progress"] = {
                        **previous,
                        **snapshot,
                        "total": previous.get("total") or len(snapshot.get("history") or []),
                        "updated_at": datetime.utcnow().isoformat(),
                    }
                    current.run_metadata = meta
                    db.commit()
                except Exception:  # noqa: BLE001 - never fail a run over progress
                    logger.exception("Could not persist step progress for %s", run_key)
                    db.rollback()

            result = await LocalPlaywrightRunner().run(
                workspace_dir=Path(run.workspace_path),
                script_file_name=script_name,
                environment=run.environment,
                on_progress=publish_progress,
                # A run may ask for longer (a journey recording lasts as long as the person needs).
                timeout_seconds=int(run_cfg.get("timeout_seconds") or settings.AUTOMATION_RUN_TIMEOUT_SECONDS or 600),
                cancellation=cancel,
                extra_env=data_env,
            )
            _scrub(result, secrets)

            counts = {"pass": 0, "fail": 0, "skip": 0, "error": 0, "blocked": 0}
            for row in result.results:
                counts[row.status] = counts.get(row.status, 0) + 1

            # --- Runtime Self-Healing Loop ---------------------------------
            auto_heal = bool(run_cfg.get("auto_heal", True))
            initial_failed = result.run_status != "completed" or (counts["fail"] + counts["error"] > 0)

            if initial_failed and auto_heal and not cancel.is_set():
                logger.info("Run %s failed on initial attempt. Invoking Healer Agent...", run_key)
                run.run_metadata = {
                    **(run.run_metadata or {}),
                    "execution_phase": "Self-Healing Agent Auto-Repair",
                    "phase_step": 5,
                }
                db.commit()
                heal_timeout = float(settings.AUTOMATION_HEAL_TIMEOUT_SECONDS or 120)
                try:
                    first_fail = next((r for r in result.results if r.status in ("fail", "error")), None)
                    err_msg = (first_fail.error_message if first_fail else "") or (result.error_message or "")
                    stack = first_fail.stack_trace if first_fail else ""

                    # Query active discovered element catalogue
                    discovered_rows = (
                        db.query(AutomationDiscoveredElement)
                        .join(
                            AutomationDiscoveryRun,
                            AutomationDiscoveredElement.discovery_run_id == AutomationDiscoveryRun.id,
                        )
                        .filter(AutomationDiscoveryRun.is_current == True)
                        .all()
                    )
                    discovered_list = [
                        {
                            "role": d.role,
                            "accessible_name": d.accessible_name,
                            "recommended_locator": d.recommended_locator,
                            "page_url": d.page_url,
                        }
                        for d in discovered_rows
                    ]

                    # Two hazards, one call. diagnose_and_heal() is
                    # synchronous and network-bound, so calling it directly
                    # would block this event loop -- and this process serves
                    # the whole API, so every request queues behind a heal.
                    # And requests' timeout is per-socket-read, not a deadline:
                    # a provider that trickles keep-alive bytes while it thinks
                    # resets that clock forever. A run once sat at "running" for
                    # 14 minutes with the API frozen behind it. to_thread frees
                    # the loop; wait_for bounds the stage.
                    healed_code, diagnosis, changes = await asyncio.wait_for(
                        asyncio.to_thread(
                            healer.diagnose_and_heal,
                            code=code,
                            error_message=err_msg,
                            stack_trace=stack,
                            discovered_elements=discovered_list,
                            base_url=base_url,
                        ),
                        timeout=heal_timeout,
                    )

                    if healed_code and healed_code.strip() != code.strip():
                        logger.info("Healed script generated for %s. Re-running...", run_key)
                        healed_file = ws.materialize_script(
                            workspace=workspace, code=healed_code, suggested_file_path=file_name_hint
                        )
                        # The healed spec is a different file with its own step
                        # count, and the reporter restarts its numbering for a
                        # fresh process -- so reseed rather than letting the
                        # original run's total describe this one.
                        run.run_metadata = {
                            **(run.run_metadata or {}),
                            "step_progress": {
                                "total": healed_code.count("await test.step("),
                                "current": 0,
                                "status": "running",
                                "history": [],
                                "healed": True,
                            },
                        }
                        db.commit()

                        healed_result = await LocalPlaywrightRunner().run(
                            workspace_dir=Path(run.workspace_path),
                            script_file_name=healed_file,
                            environment=run.environment,
                            timeout_seconds=min(180, int(settings.AUTOMATION_RUN_TIMEOUT_SECONDS or 600)),
                            cancellation=cancel,
                            on_progress=publish_progress,
                            extra_env=data_env,
                        )
                        _scrub(healed_result, secrets)

                        healed_counts = {"pass": 0, "fail": 0, "skip": 0, "error": 0, "blocked": 0}
                        for row in healed_result.results:
                            healed_counts[row.status] = healed_counts.get(row.status, 0) + 1

                        if healed_result.run_status == "completed" and (healed_counts["fail"] + healed_counts["error"] == 0):
                            logger.info("Self-healing SUCCESSFUL for %s! Test passed on healed retry.", run_key)
                            result = healed_result
                            counts = healed_counts
                            run.run_metadata = {
                                **(run.run_metadata or {}),
                                "is_healed": True,
                                "healing_attempts": 1,
                                "healing_diagnosis": diagnosis,
                                "healing_changes": changes,
                                "original_code": code,
                                "healed_code": healed_code,
                            }
                            if run.script_id:
                                script_record = db.query(AutomationScript).filter(AutomationScript.id == run.script_id).first()
                                if script_record:
                                    script_record.code = healed_code
                                    db.commit()
                        else:
                            logger.info("Healed retry for %s also failed. Recording original and healed diagnostic trail.", run_key)
                            run.run_metadata = {
                                **(run.run_metadata or {}),
                                "is_healed": False,
                                "healing_attempts": 1,
                                "healing_diagnosis": diagnosis,
                                "healing_changes": changes,
                                "original_code": code,
                                "healed_code": healed_code,
                            }
                except asyncio.TimeoutError:
                    logger.warning(
                        "Healer Agent exceeded its %.0fs deadline for %s; recording the "
                        "original failure without a healed retry.",
                        heal_timeout,
                        run_key,
                    )
                except Exception as heal_exc:
                    logger.warning("Healer Agent threw an exception for %s: %s", run_key, heal_exc)

            # Persist test results
            for row in result.results:
                db.add(
                    AutomationRunResult(
                        run_id=run.id,
                        test_name=row.name[:500],
                        status=row.status,
                        duration_ms=row.duration_ms,
                        error_message=row.error_message,
                        stack_trace=row.stack_trace,
                        screenshot_path=row.screenshot_path,
                        video_path=row.video_path,
                        trace_path=row.trace_path,
                        console_logs=row.console_logs,
                        network_logs=row.network_logs,
                    )
                )

            run.total_tests = len(result.results)
            run.passed = counts["pass"]
            run.failed = counts["fail"] + counts["error"]
            run.skipped = counts["skip"]
            run.blocked = counts["blocked"]
            run.duration_seconds = int(result.duration_seconds)
            run.log_path = result.log_path
            run.run_metadata = {**(run.run_metadata or {}), "runner": result.metadata}

            self._finalise(
                db,
                run,
                status=result.run_status,
                outcome=_outcome_for(result.run_status, counts),
                error=result.error_message,
            )

        except asyncio.CancelledError:
            self._safe_finalise(db, run_key, "cancelled", None, "The run was cancelled.")
            raise
        except Exception as exc:  # noqa: BLE001 - last resort, must not leave "running"
            logger.exception("Unhandled error executing run %s", run_key)
            # Some exceptions carry no message at all (NotImplementedError is
            # the one that bit us), and "Unexpected error: " tells nobody
            # anything. Fall back to the class name.
            detail = str(exc) or type(exc).__name__
            self._safe_finalise(db, run_key, "failed", "blocked", f"Unexpected error: {detail}")
        finally:
            db.close()

    def _finalise(
        self,
        db,
        run: AutomationRun,
        *,
        status: str,
        outcome: Optional[str],
        error: Optional[str],
    ) -> None:
        run.status = status
        run.outcome = outcome
        run.error_message = error
        run.completed_at = datetime.utcnow()
        db.commit()

    def _safe_finalise(
        self, db, run_key: str, status: str, outcome: Optional[str], error: str
    ) -> None:
        try:
            db.rollback()
            run = db.query(AutomationRun).filter(AutomationRun.run_key == run_key).first()
            if run and run.status in ("queued", "running"):
                self._finalise(db, run, status=status, outcome=outcome, error=error)
        except Exception:  # noqa: BLE001
            logger.exception("Could not record the terminal state for run %s", run_key)


def _outcome_for(run_status: str, counts: dict) -> Optional[str]:
    """Translate a run's lifecycle status into what the tests actually said.

    The distinction is the point. A run that never started tested nothing, so
    it is `blocked` -- reporting it as `failed` would blame the application for
    an infrastructure problem, and reporting it as passed would manufacture
    confidence, which is the defect the POC's WAF fallback demonstrated.
    """
    if run_status == "cancelled":
        return None
    if run_status != "completed":
        return "blocked"
    if counts.get("blocked"):
        return "blocked"
    if counts.get("fail") or counts.get("error"):
        return "failed"
    if counts.get("pass"):
        return "passed"
    # Completed with nothing to score. The runner already reports this as a
    # failure, so agreeing here keeps the two consistent.
    return "blocked"


def new_run_key() -> str:
    return f"run-{uuid.uuid4().hex[:12]}"


def sweep_orphaned_runs() -> int:
    """Mark runs abandoned by a restart.

    Without this a backend restart leaves rows at "running" that no task will
    ever finish, and the UI polls them indefinitely. Called once at startup.
    """
    db = SessionLocal()
    try:
        orphans = (
            db.query(AutomationRun)
            .filter(AutomationRun.status.in_(["queued", "running"]))
            .all()
        )
        for run in orphans:
            run.status = "failed"
            run.outcome = "blocked"
            run.error_message = (
                "The backend restarted while this run was in progress, so it was "
                "abandoned. Trigger it again."
            )
            run.completed_at = datetime.utcnow()
        if orphans:
            db.commit()
        return len(orphans)
    except Exception:  # noqa: BLE001
        logger.exception("Could not sweep orphaned automation runs")
        db.rollback()
        return 0
    finally:
        db.close()


job_manager = JobManager()
