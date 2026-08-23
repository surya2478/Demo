"""
Per-run workspace management.

--- Automation Module: ported from stlc-platform -----------------------------
Source: app/services/automation_runner/workspace.py

Each execution gets its own directory under
    <AUTOMATION_STORAGE_PATH>/workspaces/<run_key>/

The script is written into it, framework config is generated, and the runner
drops artifacts under the same directory so one authenticated endpoint can
serve them all.

The reason this file is ported rather than rewritten is `_link_npm_global_modules`.
Playwright is installed globally in the backend image, and a generated spec
doing `import { test } from '@playwright/test'` will NOT resolve it: Node only
walks parent directories looking for a `node_modules` folder, and NODE_PATH
does not change that — Playwright's TypeScript loader included. It surfaces as
MODULE_NOT_FOUND on an import that looks obviously correct.

Symlinking the workspace's `node_modules` to the npm global root is the fix.
Verified in this project's image: with the link a generated spec runs as the
unprivileged uid and captures video, trace and screenshot; without it the run
fails before the browser starts.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

from ...config import settings
from .preflight import resolve_node_tool

logger = logging.getLogger(__name__)


# Keep in step with the `npm install -g` line in the backend Dockerfile. A host
# and workspace Playwright mismatch is the usual cause of "works locally, fails
# in the container", so this is pinned rather than floating on ^1.
PLAYWRIGHT_PACKAGE_JSON = {
    "name": "ats-automation-run",
    "private": True,
    "version": "0.0.0",
    "devDependencies": {"@playwright/test": "1.55.0"},
    "scripts": {"test": "playwright test"},
}

# {base_url_line} expands to either nothing or `    baseURL: '...',`.
#
# The 90s test timeout is deliberate: Playwright's 30s default is too tight for
# multi-step flows against a slow SIT environment, and upstream observed whole
# batches failing on "Test timeout of 30000ms exceeded" for that reason alone.
# The runner's own subprocess cap still bounds the run.
#
# headless is fixed true — the decision recorded for this deployment. Run
# settings persist as a run_config column so a headed profile can be added
# later without reshaping this template.
PLAYWRIGHT_CONFIG_TS_TEMPLATE = """import {{ defineConfig }} from '@playwright/test';

export default defineConfig({{
  testDir: '{test_dir}',
  testMatch: /.*\\.(spec|test)?.*\\.[jt]sx?$/,
  testIgnore: ['node_modules/**', 'test-results/**'],
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 120_000,
  reporter: [
    ['list'],
    ['json', {{ outputFile: 'results.json' }}],
  ],
  use: {{
{base_url_line}    headless: {headless_str},
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    trace: 'on',
    screenshot: 'on',
    video: 'on',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: {{ width: 1366, height: 768 }},
    extraHTTPHeaders: {{
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    }},
    launchOptions: {{
      slowMo: {slow_mo_ms},
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--no-sandbox',
      ],
    }},
  }},
  expect: {{ timeout: 15_000 }},
}});
"""



# ── Layout ───────────────────────────────────────────────────────────────────

def storage_root() -> Path:
    return Path(settings.AUTOMATION_STORAGE_PATH)


def workspace_root() -> Path:
    return storage_root() / "workspaces"


def workspace_dir_for_run(run_key: int | str) -> Path:
    return workspace_root() / str(run_key)


def reset_workspace(run_key: int | str) -> Path:
    """Wipe and recreate the workspace directory. Idempotent, so a retry starts
    from a known state rather than inheriting a half-written previous attempt."""
    path = workspace_dir_for_run(run_key)
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)
    path.mkdir(parents=True, exist_ok=True)
    return path


# ── Script materialisation ───────────────────────────────────────────────────

def _script_filename_for(suggested_path: str | None) -> str:
    """Pick a filename inside the workspace. Always ensure a standard .spec.ts / .spec.js extension."""
    candidate = Path(suggested_path or "").name if suggested_path else ""
    if not candidate:
        return "test.spec.ts"
    if candidate.endswith(".ts") and not candidate.endswith(".spec.ts"):
        if candidate.endswith("_spec.ts"):
            candidate = candidate[:-8] + ".spec.ts"
        else:
            candidate = candidate[:-3] + ".spec.ts"
    elif candidate.endswith(".js") and not candidate.endswith(".spec.js"):
        if candidate.endswith("_spec.js"):
            candidate = candidate[:-8] + ".spec.js"
        else:
            candidate = candidate[:-3] + ".spec.js"
    elif not (candidate.endswith(".spec.ts") or candidate.endswith(".spec.js")):
        candidate = f"{candidate}.spec.ts"
    return candidate


def materialize_script(*, workspace: Path, code: str, suggested_file_path: str | None = None) -> str:
    """Write the script source into the workspace and return its filename."""
    filename = _script_filename_for(suggested_file_path)
    (workspace / filename).write_text(code, encoding="utf-8")
    return filename


def materialize_bundle(*, workspace: Path, files: dict[str, str]) -> None:
    """Write a multi-file compiled bundle (specs/, pages/, fixtures/).

    Keys are expected to be safe relative paths, but containment is enforced
    here too: a generated path that escapes the workspace is refused rather
    than trusted, because the keys ultimately derive from model output.
    """
    root = workspace.resolve()
    for rel_path, content in (files or {}).items():
        target = (workspace / rel_path).resolve()
        try:
            target.relative_to(root)
        except ValueError:
            raise ValueError(f"Refusing to write outside the workspace: {rel_path}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")


# ── Framework config ─────────────────────────────────────────────────────────

def _render_playwright_config(
    base_url: str | None,
    test_dir: str,
    slow_mo_ms: int = 1000,
    headless: bool = True,
) -> str:
    if base_url:
        # json.dumps gives a safely quoted string to embed in TypeScript.
        base_url_line = f"    baseURL: {json.dumps(base_url)},\n"
    else:
        base_url_line = ""
    return PLAYWRIGHT_CONFIG_TS_TEMPLATE.format(
        base_url_line=base_url_line,
        test_dir=test_dir,
        slow_mo_ms=max(0, int(slow_mo_ms)),
        headless_str="true" if headless else "false",
    )


def write_playwright_config(
    workspace: Path,
    base_url: str | None = None,
    test_dir: str = ".",
    slow_mo_ms: int = 1000,
    headless: bool = True,
) -> None:
    """Drop package.json and playwright.config.ts, and make @playwright/test
    resolvable from the workspace.

    `base_url` becomes Playwright's `use.baseURL`, so generated specs can call
    `page.goto('/checkout')` rather than hardcoding a host — which is also what
    lets the same script run against SIT, QA and UAT.
    """
    (workspace / "package.json").write_text(
        json.dumps(PLAYWRIGHT_PACKAGE_JSON, indent=2), encoding="utf-8"
    )
    (workspace / "playwright.config.ts").write_text(
        _render_playwright_config(base_url, test_dir, slow_mo_ms=slow_mo_ms, headless=headless),
        encoding="utf-8",
    )
    _link_npm_global_modules(workspace)


@lru_cache(maxsize=1)
def _npm_global_root() -> str | None:
    """The npm global modules directory, e.g. /usr/lib/node_modules.

    NodeSource installs put this at /usr/lib/node_modules, not
    /usr/local/lib/node_modules — hence asking npm rather than guessing.
    Cached for the process lifetime; restart the backend after a Node reinstall.
    """
    # Resolved to a full path first: on Windows npm is a .CMD shim that
    # subprocess cannot launch by bare name. See preflight.resolve_node_tool.
    npm = resolve_node_tool("npm")
    if not npm:
        logger.warning("npm not found while resolving the global module root")
        return None
    try:
        proc = subprocess.run([npm, "root", "-g"], capture_output=True, text=True, timeout=20)
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        logger.warning("npm not found while resolving the global module root")
        return None
    if proc.returncode != 0:
        logger.warning("`npm root -g` failed: %s", proc.stderr.strip())
        return None
    return proc.stdout.strip() or None


def _link_npm_global_modules(workspace: Path) -> None:
    """Point workspace/node_modules at the npm global root.

    Without this, `import { test } from '@playwright/test'` in the generated
    spec fails with MODULE_NOT_FOUND even though the package is installed —
    see this module's docstring.
    """
    link = workspace / "node_modules"

    # Clear anything a previous failed run left behind.
    if link.is_symlink() or link.exists():
        try:
            if link.is_symlink() or link.is_file():
                link.unlink()
            else:
                shutil.rmtree(link, ignore_errors=True)
        except OSError:
            pass

    target = _npm_global_root()
    if not target:
        return
    target_path = Path(target)
    if not target_path.exists():
        logger.warning(
            "npm global root %s does not exist; @playwright/test will not resolve", target
        )
        return

    try:
        link.symlink_to(target_path, target_is_directory=True)
        return
    except OSError as exc:
        logger.info("Could not symlink %s -> %s (%s); trying a junction", link, target_path, exc)

    # Windows refuses symlinks without developer mode or elevation, but a
    # directory junction needs neither and resolves to the same files.
    #
    # That identity is the whole point. A copy does NOT work here: `npx
    # playwright test` loads the runner from the global install while the spec
    # imports @playwright/test from the workspace, and two physical copies are
    # two module instances. Playwright detects that and refuses with "Playwright
    # Test did not expect test() to be called here", reporting zero tests.
    if os.name == "nt":
        try:
            proc = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(link), str(target_path)],
                capture_output=True,
                text=True,
                timeout=20,
            )
            if proc.returncode == 0:
                return
            logger.warning("mklink /J failed: %s", (proc.stderr or proc.stdout).strip())
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as exc:
            logger.warning("Could not create a junction for %s: %s", link, exc)

    # Last resort. Kept because it is better than nothing on a platform with
    # neither symlinks nor junctions, but expect the duplicate-instance error
    # above if the global runner is what ends up executing the spec.
    logger.warning("Falling back to copying %s -> %s", target_path, link)
    try:
        shutil.copytree(target_path, link, symlinks=True, dirs_exist_ok=True)
    except OSError as copy_exc:
        logger.warning("Copy fallback also failed: %s", copy_exc)
