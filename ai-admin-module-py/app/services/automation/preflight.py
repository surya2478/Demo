"""
Runtime preflight: can this host actually execute a browser test?

--- Automation Module: ported from stlc-platform -----------------------------
Source: app/services/automation_runner/preflight.py

Surfaced to the UI so an operator sees "Node not installed" before clicking
Run, rather than an opaque failure five seconds after. The pytest detection is
dropped — this deployment runs Playwright only.

The result is cached for the process lifetime, so restart the backend after
installing or upgrading the toolchain.
"""
from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from functools import lru_cache


@dataclass(slots=True)
class FrameworkSupport:
    framework: str
    available: bool
    detail: str  # short, human-readable, and actionable when False


def _capture_version(args: list[str]) -> str | None:
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=20)
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    if proc.returncode != 0:
        return None
    output = proc.stdout.strip() or proc.stderr.strip()
    return output.splitlines()[0] if output else None


@lru_cache(maxsize=1)
def _detect_playwright() -> FrameworkSupport:
    if not shutil.which("npx"):
        return FrameworkSupport(
            "playwright",
            False,
            "Node.js is not available. The backend image installs Node 20 and "
            "@playwright/test; rebuild it, or install Node on the host running "
            "the backend.",
        )
    version = _capture_version(["npx", "--yes", "playwright", "--version"])
    if not version:
        return FrameworkSupport(
            "playwright",
            False,
            "@playwright/test is not installed. Run "
            "`npm install -g @playwright/test && npx playwright install chromium` "
            "where the backend runs.",
        )
    return FrameworkSupport("playwright", True, version)


@lru_cache(maxsize=1)
def _detect_node() -> FrameworkSupport:
    version = _capture_version(["node", "--version"])
    if not version:
        return FrameworkSupport("node", False, "node is not on PATH")
    return FrameworkSupport("node", True, version)


def runtime_status() -> dict[str, FrameworkSupport]:
    """One-call summary, used by the preflight endpoint and by the runner."""
    return {
        "node": _detect_node(),
        "playwright": _detect_playwright(),
    }


def is_available(framework: str) -> tuple[bool, str]:
    status = runtime_status().get((framework or "").lower())
    if status is None:
        return False, f"Unsupported framework: {framework}"
    return status.available, status.detail


def is_ready() -> bool:
    """Whether an execution could start right now."""
    return all(entry.available for entry in runtime_status().values())
