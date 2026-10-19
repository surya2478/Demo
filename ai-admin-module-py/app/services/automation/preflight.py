"""
Runtime preflight: can this host actually execute a browser test?

--- Automation Module: ported from stlc-platform -----------------------------
Source: app/services/automation_runner/preflight.py

Surfaced to the UI so an operator sees "Node not installed" before clicking
Run, rather than an opaque failure five seconds after. The pytest detection is
dropped — this deployment runs Playwright only.

Short-lived checks can be refreshed after installing or repairing the toolchain.
"""
from __future__ import annotations

import shutil
import os
import time
import threading
import subprocess
from dataclasses import dataclass
from pathlib import Path

from ...config import settings


@dataclass(slots=True)
class FrameworkSupport:
    framework: str
    available: bool
    detail: str  # short, human-readable, and actionable when False


def resolve_node_tool(name: str) -> str | None:
    """Absolute path to a Node toolchain executable, or None if absent.

    Windows installs npm and npx as `.CMD` shims. `shutil.which` finds them
    because it honours PATHEXT, but subprocess does not: CreateProcess resolves
    a bare name against PATH with `.exe` only, so `["npx", ...]` raises
    FileNotFoundError on Windows while the identical list works in the Linux
    container. Detection would then report "@playwright/test is not installed"
    on a host where it plainly is.

    Resolving to a full path before handing the name to subprocess is what lets
    one code path serve both. An absolute path is taken as given, so
    AUTOMATION_NODE_PATH can point at a specific toolchain.
    """
    candidate = Path(name)
    if candidate.is_absolute():
        return str(candidate) if candidate.exists() else None
    return shutil.which(name)


def npx_command() -> str | None:
    """How to invoke npx here, honouring AUTOMATION_NODE_PATH."""
    return resolve_node_tool((settings.AUTOMATION_NODE_PATH or "npx").strip() or "npx")


def _capture_version(args: list[str]) -> str | None:
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=20)
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    if proc.returncode != 0:
        return None
    output = proc.stdout.strip() or proc.stderr.strip()
    return output.splitlines()[0] if output else None


def _detect_playwright() -> FrameworkSupport:
    node = resolve_node_tool("node")
    if not node:
        return FrameworkSupport(
            "playwright",
            False,
            "Node.js is not available. The backend image installs Node 20 and "
            "@playwright/test; rebuild it, or install Node on the host running "
            "the backend.",
        )
    project = os.environ.get("AUTOMATION_PLAYWRIGHT_PROJECT") or str(Path.cwd())
    try:
        probe = subprocess.run([node, "-e", "const {chromium}=require('@playwright/test'); chromium.launch({headless:true}).then(async b=>{await b.close();console.log(require('@playwright/test/package.json').version)}).catch(e=>{console.error(e.message);process.exit(1)})"],
                               cwd=project, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return FrameworkSupport("playwright", False, f"Browser launch check failed ({type(exc).__name__}). Check the backend browser runtime.")
    if probe.returncode:
        return FrameworkSupport("playwright", False, "Playwright was found but Chromium could not launch. Check AUTOMATION_PLAYWRIGHT_PROJECT and install the matching Chromium browser.")
    return FrameworkSupport("playwright", True, probe.stdout.strip() + "; Chromium launch verified")


def _detect_node() -> FrameworkSupport:
    node = resolve_node_tool("node")
    version = _capture_version([node, "--version"]) if node else None
    if not version:
        return FrameworkSupport("node", False, "node is not on PATH")
    return FrameworkSupport("node", True, version)


_runtime_cache = None
_runtime_lock = threading.Lock()


def runtime_status(*, refresh: bool = False) -> dict[str, FrameworkSupport]:
    """One-call summary, used by the preflight endpoint and by the runner."""
    global _runtime_cache
    with _runtime_lock:
        if not refresh and _runtime_cache and time.monotonic() < _runtime_cache[0]:
            return dict(_runtime_cache[1])
        status = {"node": _detect_node(), "playwright": _detect_playwright()}
        # Failures are short-lived; repairs take effect without a restart.
        ttl = 60 if all(value.available for value in status.values()) else 5
        _runtime_cache = (time.monotonic() + ttl, status)
        return dict(status)


def is_available(framework: str) -> tuple[bool, str]:
    status = runtime_status().get((framework or "").lower())
    if status is None:
        return False, f"Unsupported framework: {framework}"
    return status.available, status.detail


def is_ready() -> bool:
    """Whether an execution could start right now."""
    return all(entry.available for entry in runtime_status().values())
