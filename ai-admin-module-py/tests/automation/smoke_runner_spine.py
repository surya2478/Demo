"""
--- Automation Module: end-to-end smoke test for the runner spine ------------

Proves the Phase 0 runtime works: preflight detects the toolchain, a workspace
materialises with a resolvable node_modules, the environment allowlist filters
what a test can see, a spec executes, and screenshot, video and trace are
captured.

This must run INSIDE the backend image -- it needs Node, @playwright/test and
Chromium, which are installed there rather than on the host:

    docker build -t admin_module:latest .

    docker run --rm \
      -v "$PWD/app:/app/app:ro" \
      -v "$PWD/tests:/app/tests:ro" \
      admin_module:latest python /app/tests/automation/smoke_runner_spine.py

On Git Bash prefix the command with MSYS_NO_PATHCONV=1, or the container paths
are rewritten into Windows paths before Docker sees them.

Not a pytest test: it needs the image, so collecting it in a normal run would
fail on every developer machine for the wrong reason.
"""
import asyncio
import os
import sys

sys.path.insert(0, "/app")
os.environ.setdefault("AUTOMATION_STORAGE_PATH", "/tmp/ats-storage")

from app.services.automation import workspace as ws  # noqa: E402
from app.services.automation.local_playwright import LocalPlaywrightRunner  # noqa: E402
from app.services.automation.preflight import runtime_status  # noqa: E402

SPEC = """
import { test, expect } from '@playwright/test';

test('runner spine executes and captures evidence', async ({ page }) => {
  await page.setContent('<h1 id="t">automation studio</h1>');
  await expect(page.locator('#t')).toHaveText('automation studio');
});
"""


async def main() -> int:
    failures = []

    print("=== preflight ===")
    for name, support in runtime_status().items():
        print(f"  {name:12} available={support.available}  {support.detail}")
        if not support.available:
            failures.append(f"preflight: {name} unavailable -- {support.detail}")

    workspace = ws.reset_workspace("smoke")
    script_name = ws.materialize_script(workspace=workspace, code=SPEC)
    ws.write_playwright_config(workspace)

    print(f"\n=== workspace {workspace} ===")
    print("  files:", sorted(p.name for p in workspace.iterdir()))
    link = workspace / "node_modules"
    if not link.is_symlink():
        # The whole reason workspace.py was ported rather than rewritten.
        failures.append("node_modules is not a symlink -- @playwright/test will not resolve")
    else:
        print("  node_modules ->", os.readlink(link))

    result = await LocalPlaywrightRunner().run(
        workspace_dir=workspace,
        script_file_name=script_name,
        environment="SIT",
        timeout_seconds=180,
    )

    print("\n=== result ===")
    print("  run_status  :", result.run_status)
    print("  duration    :", round(result.duration_seconds, 2), "s")
    print("  error       :", result.error_message)
    print("  env withheld:", result.metadata.get("env_withheld_count"))

    if result.run_status != "completed":
        failures.append(f"run_status was {result.run_status!r}, expected 'completed'")
    if not result.results:
        failures.append("no per-test results were parsed")

    for test in result.results:
        print(f"  test        : '{test.name}' -> {test.status} ({test.duration_ms}ms)")
        for label, path in (
            ("screenshot", test.screenshot_path),
            ("video", test.video_path),
            ("trace", test.trace_path),
        ):
            print(f"    {label:10}: {'YES' if path else 'no'}")
            if not path:
                failures.append(f"{label} was not captured")
        if test.status != "pass":
            failures.append(f"test status was {test.status!r}, expected 'pass'")

    print()
    if failures:
        print("FAILED")
        for failure in failures:
            print("  -", failure)
        return 1
    print("PASSED -- runner spine is working end to end")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
