"""
--- Automation Module: end-to-end smoke test for the run API -----------------

Drives the Phase 0 API the way the UI will: queue a run from a hand-written
spec, poll it to completion, read the per-test rows, and fetch every piece of
evidence through the authenticated artifact route.

Also checks the guards, because one nobody tests is one nobody has: an unknown
artifact kind is rejected, an unauthenticated request is refused, and a stored
path pointing outside the storage root is refused rather than served.

Runs against a real uvicorn process rather than fastapi.testclient. Two
reasons: httpx is not in the image, and more importantly the job manager
schedules work with asyncio.create_task on the running event loop -- exactly
the behaviour a test harness would paper over. Everything here uses urllib from
the standard library, so the test adds no dependency of its own.

Must run INSIDE the backend image:

    MSYS_NO_PATHCONV=1 docker run --rm \
      -v "$PWD/app:/app/app:ro" \
      -v "$PWD/tests:/app/tests:ro" \
      -v "$PWD/.env:/app/.env:ro" \
      -v "/tmp/smoke-admin.db:/app/admin.db" \
      admin_module:latest python /app/tests/automation/smoke_run_api.py

Point it at a COPY of admin.db -- it writes runs and audit rows.
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, "/app")
os.environ.setdefault("AUTOMATION_STORAGE_PATH", "/tmp/ats-storage")

# No /admin prefix. The app sets root_path="/admin", but that only affects the
# URLs FastAPI generates for a proxy that strips the prefix -- uvicorn still
# serves every route at its bare path. Requesting /admin/... against uvicorn
# directly returns 404.
BASE = "http://127.0.0.1:8099"

SPEC = """
import { test, expect } from '@playwright/test';

test('phase 0 proves the module executes and captures evidence', async ({ page }) => {
  await page.setContent('<h1 id="t">automation studio</h1><button id="b">Go</button>');
  await expect(page.locator('#t')).toHaveText('automation studio');
  await page.locator('#b').click();
});
"""


def request(path, token=None, method="GET", body=None, raw=False):
    """Return (status, parsed_or_bytes). Never raises on an HTTP error status."""
    req = urllib.request.Request(f"{BASE}{path}", method=method)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=120) as response:
            payload = response.read()
            if raw:
                return response.status, payload, response.headers.get("content-type", "")
            return response.status, json.loads(payload or b"{}")
    except urllib.error.HTTPError as exc:
        payload = exc.read()
        if raw:
            return exc.code, payload, ""
        try:
            return exc.code, json.loads(payload or b"{}")
        except ValueError:
            return exc.code, {"detail": payload.decode(errors="replace")[:200]}


def wait_for_server(proc, attempts=60):
    for _ in range(attempts):
        if proc.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(f"{BASE}/docs", timeout=2):
                return True
        except Exception:  # noqa: BLE001 - not up yet
            time.sleep(1)
    return False


def main() -> int:
    failures: list[str] = []

    from app.utils.token import create_access_token

    token = create_access_token({"sub": "admin"})

    print("=== starting uvicorn ===")
    # Capture output rather than discarding it. A startup failure here is a
    # real defect -- a missing dependency, a bad import -- and silently
    # reporting "did not start" hides exactly the information needed.
    log = open("/tmp/uvicorn-smoke.log", "wb")
    server = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8099"],
        cwd="/app",
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    try:
        if not wait_for_server(server):
            log.flush()
            print("FAILED - uvicorn did not start. Last lines of its output:\n")
            try:
                with open("/tmp/uvicorn-smoke.log", encoding="utf-8", errors="replace") as fh:
                    print("".join(fh.readlines()[-25:]))
            except OSError:
                pass
            return 1
        print("  up")

        print("\n=== runtime ===")
        _, runtime = request("/automation/runtime", token)
        print("  enabled:", runtime.get("enabled"), "| ready:", runtime.get("ready"))
        for name, info in (runtime.get("frameworks") or {}).items():
            print(f"    {name:11} available={info['available']}  {info['detail'][:48]}")
        if not runtime.get("ready"):
            print("\nFAILED - runtime not ready; this test must run inside the image")
            return 1

        print("\n=== queue a run ===")
        status, created = request(
            "/automation/runs",
            token,
            method="POST",
            body={"code": SPEC, "environment": "SIT", "file_name": "phase0.spec.ts"},
        )
        print("  HTTP", status)
        if status != 202:
            print("  body:", created)
            print("\nFAILED - run was not accepted")
            return 1
        run_key = created["run_key"]
        print("  run_key:", run_key)

        print("\n=== poll ===")
        detail = {}
        for attempt in range(120):
            _, detail = request(f"/automation/runs/{run_key}", token)
            if detail.get("status") in ("completed", "failed", "cancelled"):
                break
            if attempt % 10 == 0:
                print(f"  ...{detail.get('status')}")
            time.sleep(1)

        print("  status  :", detail.get("status"))
        print("  outcome :", detail.get("outcome"))
        print("  error   :", detail.get("error_message"))
        print("  counts  : total=%s pass=%s fail=%s blocked=%s" % (
            detail.get("total_tests"), detail.get("passed"),
            detail.get("failed"), detail.get("blocked")))
        print("  duration:", detail.get("duration_seconds"), "s")

        if detail.get("status") != "completed":
            failures.append(f"run status was {detail.get('status')!r}, expected 'completed'")
        if detail.get("outcome") != "passed":
            failures.append(f"run outcome was {detail.get('outcome')!r}, expected 'passed'")
        if not detail.get("results"):
            failures.append("no per-test results were persisted")

        print("\n=== evidence ===")
        first_id = None
        for result in detail.get("results") or []:
            first_id = first_id or result["id"]
            print(f"  '{result['test_name'][:52]}' -> {result['status']} ({result['duration_ms']}ms)")
            for kind, present in result["evidence"].items():
                if not present:
                    failures.append(f"{kind} was not captured")
                    print(f"    {kind:11} MISSING")
                    continue
                code, payload, ctype = request(
                    f"/automation/runs/{run_key}/results/{result['id']}/artifact/{kind}",
                    token, raw=True,
                )
                print(f"    {kind:11} HTTP {code}  {len(payload):>9,} bytes  {ctype}")
                if code != 200 or not payload:
                    failures.append(f"{kind} artifact did not serve (HTTP {code})")

        print("\n=== log ===")
        code, payload, _ = request(f"/automation/runs/{run_key}/log", token, raw=True)
        print(f"  HTTP {code}  {len(payload):,} bytes")
        if code != 200:
            failures.append("run log did not serve")

        print("\n=== guards ===")
        code, _ = request(
            f"/automation/runs/{run_key}/results/{first_id or 1}/artifact/passwd", token
        )
        print("  unknown artifact kind ->", code)
        if code != 400:
            failures.append("unknown artifact kind was not rejected with 400")

        code, _ = request(f"/automation/runs/{run_key}")
        print("  no token              ->", code)
        if code != 401:
            failures.append("unauthenticated request was not rejected with 401")

        if first_id:
            from app.database.connection import SessionLocal
            from app.models.automation import AutomationRunResult

            db = SessionLocal()
            try:
                row = db.query(AutomationRunResult).filter(
                    AutomationRunResult.id == first_id
                ).first()
                if row:
                    original = row.screenshot_path
                    row.screenshot_path = "/etc/passwd"
                    db.commit()
                    code, _ = request(
                        f"/automation/runs/{run_key}/results/{first_id}/artifact/screenshot",
                        token,
                    )
                    print("  path outside root     ->", code)
                    if code != 403:
                        failures.append("path outside the storage root was not refused with 403")
                    row.screenshot_path = original
                    db.commit()
            finally:
                db.close()

        print("\n=== run list ===")
        _, listing = request("/automation/runs", token)
        print("  summary:", listing.get("summary"))

    finally:
        server.terminate()
        try:
            server.wait(timeout=15)
        except subprocess.TimeoutExpired:
            server.kill()

    print()
    if failures:
        print("FAILED")
        for failure in failures:
            print("  -", failure)
        return 1
    print("PASSED - the run API executes, records and serves evidence end to end")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
