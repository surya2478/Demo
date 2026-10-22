"""Automation Studio local Playwright runner. Listens on loopback only."""
from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST, PORT = "127.0.0.1", 8765
VERSION = "1.4.0"
running_lock = threading.Lock()


def configured_value(name):
    """Read a setting even when Windows started us before SETX was applied."""
    value = os.environ.get(name)
    if value or os.name != "nt":
        return value
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            value, _ = winreg.QueryValueEx(key, name)
            return os.path.expandvars(str(value))
    except (OSError, ImportError):
        return None


def native_browser():
    """Prefer an explicit browser, then an installed Chrome/Edge-family browser."""
    configured = configured_value("AUTOMATION_BROWSER_EXECUTABLE")
    candidates = [Path(configured)] if configured else []
    roots = [Path(value) for value in (
        os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"),
        os.environ.get("LOCALAPPDATA"),
    ) if value]
    for root in roots:
        candidates.extend([
            root / "Google/Chrome/Application/chrome.exe",
            root / "Microsoft/Edge/Application/msedge.exe",
            root / "BraveSoftware/Brave-Browser/Application/brave.exe",
        ])
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    return None


def _ffmpeg_executable(path):
    candidate = Path(path).expanduser()
    if candidate.is_file():
        return candidate
    if candidate.is_dir():
        for name in ("ffmpeg-win64.exe", "ffmpeg.exe", "ffmpeg-linux", "ffmpeg"):
            found = candidate / name
            if found.is_file():
                return found
    return None


def prepare_ffmpeg(modules):
    """Resolve Playwright's current FFmpeg revision without hard-coded folders.

    A configured standalone FFmpeg is copied to the exact private location the
    installed Playwright version expects. If none exists, callers turn video
    off while retaining screenshots and traces.
    """
    registry = modules / "playwright-core" / "browsers.json"
    try:
        browsers = json.loads(registry.read_text(encoding="utf-8")).get("browsers", [])
        revision = next(str(row["revision"]) for row in browsers if row.get("name") == "ffmpeg")
    except (OSError, ValueError, KeyError, StopIteration):
        return False, None
    if os.name == "nt":
        cache = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or Path(os.environ.get("LOCALAPPDATA", tempfile.gettempdir())) / "ms-playwright")
        expected = cache / f"ffmpeg-{revision}" / "ffmpeg-win64.exe"
    else:
        cache = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or Path.home() / ".cache/ms-playwright")
        expected = cache / f"ffmpeg-{revision}" / "ffmpeg-linux"
    if expected.is_file():
        return True, expected
    configured = configured_value("AUTOMATION_FFMPEG_PATH")
    source = _ffmpeg_executable(configured) if configured else None
    if not source:
        source = _ffmpeg_executable(shutil.which("ffmpeg") or "")
    if not source:
        return False, expected
    expected.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, expected)
    try:
        expected.chmod(expected.stat().st_mode | 0o111)
        (expected.parent / "INSTALLATION_COMPLETE").touch()
    except OSError:
        pass
    return True, expected


def decode_pairing(text):
    raw = str(text or "").strip().replace("-", "+").replace("_", "/")
    raw += "=" * (-len(raw) % 4)
    value = json.loads(base64.b64decode(raw).decode("utf-8"))
    for key in ("api", "id", "token", "studio"):
        if not value.get(key):
            raise ValueError("The local run code is incomplete.")
    return value


def api(pair, path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{pair['api']}{path}", data=data, method=method, headers={
        "Authorization": f"Local-Runner {pair['token']}", "Content-Type": "application/json",
    })
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode() or "{}")


def playwright_modules():
    """Find an existing install; never download or install during a run."""
    candidates = []
    configured = configured_value("AUTOMATION_PLAYWRIGHT_PROJECT")
    if configured:
        candidates.append(Path(configured) / "node_modules")
    here = Path(__file__).resolve().parent
    candidates.extend(parent / "node_modules" for parent in (Path.cwd(), here, *here.parents))
    # Common source-checkout locations make the downloaded companion work even
    # before a newly-set Windows user variable reaches an already-open shell.
    profile = Path(os.environ.get("USERPROFILE") or Path.home())
    candidates.extend([
        profile / "OneDrive" / "Documents" / "AIProject" / "node_modules",
        profile / "Documents" / "AIProject" / "node_modules",
    ])
    npm = shutil.which("npm")
    if npm:
        result = subprocess.run([npm, "root", "-g"], capture_output=True, text=True, timeout=20)
        if result.returncode == 0 and result.stdout.strip():
            candidates.append(Path(result.stdout.strip()))
    for candidate in candidates:
        if (candidate / "@playwright" / "test" / "cli.js").exists():
            return candidate.resolve()
    raise RuntimeError("@playwright/test is not installed for this runner. Install it globally or set AUTOMATION_PLAYWRIGHT_PROJECT to an existing Playwright project.")


def link_modules(workspace):
    target, link = playwright_modules(), workspace / "node_modules"
    try:
        link.symlink_to(target, target_is_directory=True)
    except OSError:
        if os.name != "nt":
            raise
        result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "Could not link Playwright into the run.")
    return target


def progress_snapshot(path, total=0, synthetic_test_step=False):
    """Turn the ordinary runner's NDJSON events into the Studio step shape."""
    history, current, title, status = [], 0, None, "running"
    if not path.exists():
        return {"total": total, "current": current, "title": title, "status": status, "history": history}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        kind = event.get("event")
        if kind == "test_begin" and synthetic_test_step:
            current = 1
            title = event.get("title") or "Playwright test"
        elif kind == "step_begin":
            current = int(event.get("index") or current or 0); title = event.get("title")
        elif kind == "step_end":
            number = int(event.get("index") or current or 0)
            history = [row for row in history if row.get("n") != number]
            history.append({"n": number, "title": event.get("title"), "ok": event.get("ok"),
                            "ms": event.get("duration_ms"), "error": event.get("error")})
        elif kind == "test_end" and synthetic_test_step:
            test_status = str(event.get("status") or "")
            history = [{
                "n": 1,
                "title": event.get("title") or title or "Playwright test",
                "ok": test_status == "passed",
                "ms": event.get("duration_ms"),
                "error": event.get("error"),
            }]
            current = 1
        elif kind == "run_end":
            status = event.get("status") or status
    return {"total": max(total, len(history), 1 if synthetic_test_step else 0), "current": current, "title": title, "status": status, "history": history}


def journey_progress_snapshot(path, code):
    """Translate a journey crawler's own progress into the Runs step shape."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except (OSError, ValueError):
        raw = {}
    titles = {}
    match = re.search(r"const PLAN = (\{.*?\});\s*\nconst T", code or "", re.DOTALL)
    if match:
        try:
            plan = json.loads(match.group(1))
            titles = {
                int(item.get("step_number") or index): str(item.get("text") or f"Step {index}")
                for index, item in enumerate(plan.get("items") or [], start=1)
            }
        except (TypeError, ValueError):
            titles = {}
    rows = []
    for index, step in enumerate(raw.get("steps") or [], start=1):
        number = int(step.get("order") or step.get("step_number") or index)
        state = str(step.get("status") or "").lower()
        rows.append({
            "n": number,
            "title": titles.get(int(step.get("step_number") or number), f"{step.get('kind') or 'Step'} {number}"),
            "ok": state in ("done", "passed"),
            "ms": None,
            "error": step.get("reason") or step.get("error"),
        })
    active = raw.get("current") if isinstance(raw.get("current"), dict) else {}
    current = int(active.get("order") or active.get("step_number") or len(rows) or 0)
    title = active.get("text") or titles.get(int(active.get("step_number") or current or 0))
    failed = any(row.get("ok") is False for row in rows)
    status = "failed" if raw.get("finished") and failed else "passed" if raw.get("finished") else "running"
    total = int(raw.get("total") or len(titles) or len(rows))
    return {"total": total, "current": current, "title": title, "status": status, "history": rows}


def log_tail(path, limit=50000):
    """Return a bounded live tail without waiting for the child to close it."""
    try:
        with path.open("rb") as stream:
            stream.seek(0, os.SEEK_END)
            size = stream.tell()
            stream.seek(max(0, size - limit))
            return stream.read().decode("utf-8", errors="replace")
    except OSError:
        return ""


def progress_log(snapshot):
    """Readable activity when Playwright itself has no stdout to stream."""
    lines = []
    for row in snapshot.get("history") or []:
        mark = "PASS" if row.get("ok") else "FAIL"
        duration = f" ({int(row['ms'])} ms)" if row.get("ms") is not None else ""
        lines.append(f"[{mark}] {row.get('n')}. {row.get('title') or 'Step'}{duration}")
    current = int(snapshot.get("current") or 0)
    if snapshot.get("status") == "running" and current > len(snapshot.get("history") or []):
        lines.append(
            f"[RUN ] {current} of {int(snapshot.get('total') or 0)}: "
            f"{snapshot.get('title') or 'Running Playwright'}"
        )
    if snapshot.get("status") != "running":
        lines.append(f"Run {snapshot.get('status')}.")
    return "\n".join(lines)


def collect_automation_evidence(workspace, report):
    """Make report attachment paths portable and return only referenced evidence."""
    artifacts, count = {}, 0
    root = workspace.resolve()

    def visit(suite):
        nonlocal count
        for spec in suite.get("specs", []):
            for test in spec.get("tests", []):
                for result in test.get("results", []):
                    for attachment in result.get("attachments") or []:
                        raw = attachment.get("path")
                        if not raw:
                            continue
                        source = Path(raw)
                        if not source.is_absolute():
                            source = workspace / source
                        try:
                            source = source.resolve(); source.relative_to(root)
                        except (OSError, ValueError):
                            attachment.pop("path", None); continue
                        if not source.is_file() or source.suffix.lower() not in (".png", ".webm", ".zip"):
                            attachment.pop("path", None); continue
                        count += 1
                        name = f"artifacts/{count:03d}-{source.name}"
                        artifacts[name] = base64.b64encode(source.read_bytes()).decode("ascii")
                        attachment["path"] = name
        for child in suite.get("suites", []):
            visit(child)

    for suite in report.get("suites", []):
        visit(suite)
    return artifacts


def run(pair):
    if not running_lock.acquire(blocking=False):
        raise RuntimeError("Another local Playwright run is already active on this device.")
    workspace = Path(tempfile.mkdtemp(prefix="automation-studio-local-"))
    try:
        endpoint = pair.get("endpoint") or f"/automation/knowledge-base/local-runner/sessions/{pair['id']}"
        cfg = api(pair, endpoint)
        (workspace / cfg["file_name"]).write_text(cfg["code"], encoding="utf-8")
        (workspace / "package.json").write_text(json.dumps(cfg["package_json"], indent=2), encoding="utf-8")
        modules = playwright_modules()
        browser = native_browser()
        has_ffmpeg, _ = prepare_ffmpeg(modules)
        playwright_config = str(cfg["playwright_config"])
        # Remain compatible with jobs created by an older server: inject the
        # adaptive settings even when its template predates these options.
        if browser and "AUTOMATION_BROWSER_EXECUTABLE" not in playwright_config:
            playwright_config = playwright_config.replace(
                "launchOptions: {", "launchOptions: {\n      executablePath: process.env.AUTOMATION_BROWSER_EXECUTABLE || undefined,", 1
            )
        if not has_ffmpeg:
            playwright_config = playwright_config.replace("video: 'on'", "video: 'off'").replace("video: 'retain-on-failure'", "video: 'off'")
        (workspace / "playwright.config.ts").write_text(playwright_config, encoding="utf-8")
        (workspace / "progress-reporter.cjs").write_text(cfg["progress_reporter"], encoding="utf-8")
        link_modules(workspace)
        node = shutil.which("node")
        cli = modules / "@playwright" / "test" / "cli.js"
        if not node or not cli.exists():
            raise RuntimeError("The global @playwright/test command is not available on this device.")
        env = {**os.environ, **{str(k): str(v) for k, v in cfg["env"].items()}, "AUTOMATION_ENV": cfg["environment"] or "", "CI": "1"}
        if browser:
            env["AUTOMATION_BROWSER_EXECUTABLE"] = str(browser)
        if not has_ffmpeg:
            env["AUTOMATION_DISABLE_VIDEO"] = "1"
        if cfg.get("run_kind") == "automation":
            env["PLAYWRIGHT_JSON_OUTPUT_NAME"] = cfg["output_file"]
        log = (workspace / "local-run.log").open("wb")
        # Invoke the already-installed package directly. This never downloads a
        # dependency and behaves the same on Windows and Linux.
        command = [node, str(cli), "test", cfg["file_name"], "--reporter=json,./progress-reporter.cjs"]
        process = subprocess.Popen(command,
                                   cwd=workspace, env=env, stdout=log, stderr=subprocess.STDOUT)
        last = None
        started = time.monotonic()
        posted_at = started
        # A recording keeps calling in even when nothing changed, so Studio's
        # Finish (answered as stop) reaches it within a few seconds.
        heartbeat = float(cfg.get("heartbeat_seconds") or 0)
        while process.poll() is None:
            progress_file = workspace / cfg["progress_file"]
            if progress_file.exists():
                try:
                    journey_file = workspace / "walk_progress.json"
                    is_journey_automation = (
                        cfg.get("run_kind") == "automation"
                        and ("journey_crawl" in str(cfg.get("file_name") or "") or journey_file.exists())
                    )
                    if is_journey_automation:
                        current = journey_progress_snapshot(journey_file, cfg.get("code") or "")
                    elif cfg.get("run_kind") == "automation":
                        current = progress_snapshot(
                            progress_file,
                            cfg.get("step_total") or 0,
                            bool(cfg.get("synthetic_test_step")),
                        )
                    else:
                        current = json.loads(progress_file.read_text(encoding="utf-8"))
                    live_log = log_tail(workspace / "local-run.log") if cfg.get("run_kind") == "automation" else ""
                    if cfg.get("run_kind") == "automation" and not live_log.strip():
                        live_log = progress_log(current)
                    encoded = json.dumps({"progress": current, "log": live_log}, sort_keys=True)
                    if encoded != last or (heartbeat and time.monotonic() - posted_at >= heartbeat):
                        payload = {"message": "Running Playwright on this device.", "progress": current}
                        if cfg.get("run_kind") == "automation":
                            payload["log_tail"] = live_log
                        if cfg.get("run_kind") != "automation" and cfg.get("stream_frame", True):
                            frame_file = workspace / cfg["frame_file"]
                            payload["frame"] = base64.b64encode(frame_file.read_bytes()).decode("ascii") if frame_file.exists() else None
                        answer = api(pair, f"{endpoint}/progress", "POST", payload)
                        last, posted_at = encoded, time.monotonic()
                        if cfg.get("stop_file") and isinstance(answer, dict) and answer.get("stop"):
                            (workspace / cfg["stop_file"]).write_text("finish", encoding="utf-8")
                except (OSError, ValueError):
                    pass
                except urllib.error.HTTPError:
                    process.terminate(); raise RuntimeError("The Studio cancelled or rejected this local run.")
            time.sleep(0.75)
        log.close()
        output_file = workspace / cfg["output_file"]
        if cfg.get("run_kind") == "automation":
            if not output_file.exists():
                tail = (workspace / "local-run.log").read_text(encoding="utf-8", errors="replace")[-2000:]
                raise RuntimeError(tail.strip() or f"Playwright produced no JSON report (exit code {process.returncode}).")
            report = json.loads(output_file.read_text(encoding="utf-8"))
            artifacts = collect_automation_evidence(workspace, report)
            final_log = (workspace / "local-run.log").read_text(encoding="utf-8", errors="replace")
            if not final_log.strip():
                journey_file = workspace / "walk_progress.json"
                snapshot = (
                    journey_progress_snapshot(journey_file, cfg.get("code") or "")
                    if "journey_crawl" in str(cfg.get("file_name") or "") or journey_file.exists()
                    else progress_snapshot(
                        workspace / cfg["progress_file"],
                        cfg.get("step_total") or 0,
                        bool(cfg.get("synthetic_test_step")),
                    )
                )
                final_log = progress_log(snapshot)
            # Files the spec writes for Studio (a discovery crawl's catalogue).
            outputs = {}
            for name in cfg.get("output_files") or []:
                source = workspace / Path(str(name)).name
                if source.is_file():
                    outputs[source.name] = base64.b64encode(source.read_bytes()).decode("ascii")
            api(pair, f"{endpoint}/finish", "POST", {
                "report": report, "artifacts": artifacts, "outputs": outputs,
                "log": final_log,
                "exit_code": int(process.returncode or 0), "duration_seconds": time.monotonic() - started,
            })
            return
        if process.returncode != 0 or not output_file.exists():
            tail = (workspace / "local-run.log").read_text(encoding="utf-8", errors="replace")[-2000:]
            raise RuntimeError(tail.strip() or f"Playwright exited with code {process.returncode}.")
        output = json.loads(output_file.read_text(encoding="utf-8"))
        artifacts = {}
        for path in workspace.glob("*.png"):
            artifacts[path.name] = base64.b64encode(path.read_bytes()).decode("ascii")
        api(pair, f"{endpoint}/finish", "POST",
            {"output": output, "artifacts": artifacts})
    except Exception as error:
        try:
            endpoint = pair.get("endpoint") or f"/automation/knowledge-base/local-runner/sessions/{pair['id']}"
            api(pair, f"{endpoint}/fail", "POST", {"message": str(error)[:1000]})
        except Exception:
            pass
        raise
    finally:
        running_lock.release()


class Handler(BaseHTTPRequestHandler):
    def cors(self, origin="*"):
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204); self.cors(self.headers.get("Origin") or "*"); self.end_headers()

    def do_GET(self):
        if self.path != "/health":
            self.send_error(404); return
        data = json.dumps({"ready": True, "version": VERSION}).encode()
        self.send_response(200); self.cors(self.headers.get("Origin") or "*"); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(data)

    def do_POST(self):
        if self.path != "/run":
            self.send_error(404); return
        try:
            length = min(int(self.headers.get("Content-Length") or 0), 20000)
            pair = decode_pairing(json.loads(self.rfile.read(length))["pairing"])
            origin = self.headers.get("Origin") or ""
            if origin != pair["studio"]:
                raise ValueError("This Studio origin is not authorised to use the local runner.")
            threading.Thread(target=self.execute, args=(pair,), daemon=True).start()
            data = json.dumps({"accepted": True, "version": VERSION}).encode()
            self.send_response(202); self.cors(origin); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(data)
        except Exception as error:
            data = json.dumps({"accepted": False, "message": str(error)}).encode()
            self.send_response(400); self.cors(self.headers.get("Origin") or "*"); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(data)

    def execute(self, pair):
        try:
            run(pair)
        except Exception as error:
            print(f"[local-runner] {error}", flush=True)

    def log_message(self, fmt, *args):
        print(f"[local-runner] {fmt % args}", flush=True)


if __name__ == "__main__":
    print(f"Automation Studio local Playwright runner {VERSION} on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
