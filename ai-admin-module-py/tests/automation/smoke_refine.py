"""
--- Automation Module: refinement smoke test --------------------------------

Exercises the LLM transport and the refinement mapping against a LOCAL stub
that mimics the AI service's chat endpoint: multipart form in, streamed plain
text out. No external or corporate host is contacted, so this runs anywhere and
in CI.

What it proves:
  * the transport posts the right multipart fields and accumulates a streamed
    reply
  * extract_json survives markdown fences and a chatty preamble
  * a bare JSON array, and the shapes a model reaches for instead, all validate
  * a schema violation is retried once, with the error fed back, and succeeds
  * a reply whose `ref` does not match the request is refused
  * refined output maps onto AutomationTestCase columns and re-scores

Run from ai-admin-module-py:
    .venv312/Scripts/python.exe tests/automation/smoke_refine.py
"""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.config import settings  # noqa: E402
from app.services.automation import llm as llm_mod  # noqa: E402
from app.services.automation.llm import (  # noqa: E402
    LLMInvalidResponse,
    extract_json,
)
from app.services.automation.refine import (  # noqa: E402
    refine_case_content,
    refined_to_columns,
)

REF = "tc-1"

GOOD = [
    {
        "ref": REF,
        "title": "Verify user can log in with valid credentials",
        "objective": "Proves a registered user reaches the dashboard.",
        "preconditions": ["A registered account exists."],
        "steps": [
            {
                "step_number": 1,
                "action": "Navigate to the login page",
                "target": "/login",
                "test_data_ref": None,
                "expected_result": "The login form is visible",
            },
            {
                "step_number": 2,
                "action": "Enter the username",
                "target": "Username field",
                "test_data_ref": "valid_username",
                "expected_result": "The field holds the value",
            },
        ],
        "expected_result": "The dashboard is shown.",
        "bdd_scenario": "Given a registered user, When they sign in, Then the dashboard loads.",
        "priority": "High",
        "test_type": "Positive",
        "test_data_requirements": [
            {
                "key": "valid_username",
                "description": "A username of an active account",
                "example_value": "test.user",
                "sensitive": False,
                "resolution": "existing_record",
            }
        ],
        "test_data_required": True,
        "test_data_notes": "Provide an active account.",
        "automation_blockers": [],
    }
]

# Scripted replies, consumed in order — one per POST the stub receives.
REPLIES: list[str] = []
RECEIVED: list[bytes] = []


class Stub(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        RECEIVED.append(self.rfile.read(length))
        body = (REPLIES.pop(0) if REPLIES else "").encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        # Written in slices so the client genuinely accumulates a stream.
        for i in range(0, len(body), 64):
            self.wfile.write(body[i : i + 64])
            self.wfile.flush()

    def log_message(self, *args):  # silence per-request logging
        pass


def start_stub() -> str:
    server = HTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_port}"


failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"  {'PASS' if condition else 'FAIL'}  {label}")
    if not condition:
        failures.append(f"{label} {detail}".strip())


def main() -> int:
    print("=== extract_json ===")
    check("plain array", extract_json('[{"a":1}]') == [{"a": 1}])
    check("fenced block", extract_json('```json\n[{"a":1}]\n```') == [{"a": 1}])
    check("chatty preamble", extract_json('Sure!\n[{"a":1}]') == [{"a": 1}])
    try:
        extract_json("no json at all")
        check("prose is refused", False)
    except LLMInvalidResponse:
        check("prose is refused", True)

    base = start_stub()
    settings.LLM_PROVIDER = "ai_service"
    settings.ai_config.BASE_URL = base
    settings.ai_config.ENDPOINTS.chatStream = "/chat/message"
    print(f"\n=== local stub at {base} (no external host) ===")

    print("\n=== happy path ===")
    REPLIES.append(json.dumps(GOOD))
    refined = refine_case_content(
        ref=REF,
        title="Verify user can log in with valid credentials",
        existing={"steps_raw": "1. go to login 2. sign in"},
        application_url="http://localhost:5175",
    )
    check("ref echoed", refined.ref == REF)
    check("title preserved", refined.title.startswith("Verify user can log in"))
    check("steps parsed", len(refined.steps) == 2)
    check("test data captured", refined.test_data_requirements[0].key == "valid_username")

    sent = RECEIVED[-1].decode("utf-8", "replace")
    check("system_prompt was sent", "system_prompt" in sent)
    check("user content is fenced", "<user_content>" in sent)
    check("application_url grounded", "http://localhost:5175" in sent)

    print("\n=== model wraps the array in an object ===")
    REPLIES.append(json.dumps({"items": GOOD}))
    wrapped = refine_case_content(ref=REF, title="t", existing={})
    check("unwrapped {'items': [...]}", wrapped.ref == REF)

    print("\n=== bad reply is retried once, with the error fed back ===")
    before = len(RECEIVED)
    REPLIES.append('[{"ref": "tc-1"}]')  # missing required `title`
    REPLIES.append(json.dumps(GOOD))
    retried = refine_case_content(ref=REF, title="t", existing={})
    check("second attempt succeeded", retried.ref == REF)
    check("exactly two calls made", len(RECEIVED) - before == 2, f"got {len(RECEIVED)-before}")
    check(
        "retry carried the validation error",
        "could not be used" in RECEIVED[-1].decode("utf-8", "replace"),
    )

    print("\n=== a mismatched ref is refused ===")
    REPLIES.append(json.dumps([dict(GOOD[0], ref="something-else")]))
    try:
        refine_case_content(ref=REF, title="t", existing={})
        check("mismatched ref refused", False)
    except ValueError:
        check("mismatched ref refused", True)

    print("\n=== mapping onto columns ===")
    cols = refined_to_columns(refined)
    check("steps_structured kept", len(cols["steps_structured"]) == 2)
    check("steps_raw flattened", cols["steps_raw"].startswith("1. Navigate"))
    check("re-scored", isinstance(cols["eligibility_score"], int))
    check("verdict present", cols["eligibility_verdict"] in ("ready", "review", "needs_enhancement"))
    print(
        f"        score={cols['eligibility_score']} verdict={cols['eligibility_verdict']}"
    )

    print()
    if failures:
        print("FAILED")
        for f in failures:
            print("  -", f)
        return 1
    print("PASSED -- refinement transport and mapping work end to end")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
