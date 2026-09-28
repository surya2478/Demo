"""
--- Generation: Knowledge Base grounding over the ai_service transport --------

Covers the two things that make a deployed environment produce different test
cases from a local one, and that nothing else tests:

  1. POST /generate/kb-match -- does the Knowledge Base recognise this
     requirement, and does it report the same decision the prompt is built
     from. A badge that disagrees with the prompt is the one failure mode a
     demo cannot survive.

  2. LLM_PROVIDER=ai_service -- the deployed transport. The point is not that
     the bytes come back; it is that the KB grounding is injected BEFORE the
     prompt leaves this process, so a deployment holding no OpenRouter key
     still gets grounded test cases. That is the whole difference between the
     grounded local result and the ungrounded deployed one.

Everything is local: a stub stands in for the AI service and no corporate or
external host is contacted. OPENROUTER_API_KEY is deliberately left EMPTY, so
a regression that routes back to OpenRouter fails loudly here rather than
quietly in the deployment.

Run from ai-admin-module-py:

    .venv312/Scripts/python.exe tests/generation/smoke_kb_grounding.py
"""
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

os.environ["LLM_PROVIDER"] = "ai_service"
# Empty on purpose -- see the module docstring.
os.environ["OPENROUTER_API_KEY"] = ""
os.environ["OPENROUTER_MODEL"] = ""

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.config import settings  # noqa: E402
from app.routers import generate  # noqa: E402
from app.services.generation import testcases  # noqa: E402
from app.utils.security import get_current_user_strict  # noqa: E402

# A requirement the shipped Knowledge Base covers, and one it does not.
GROUNDED_QUERY = "Generate end to end TC for purchasing BUSINESS FIRST PLUS Local 110"
UNGROUNDED_QUERY = "Verify that a user can reset their password from the login screen"

_failures = []
_captured = {}


def check(label, condition, detail=""):
    print(f"  {'PASS' if condition else 'FAIL'}  {label}")
    if not condition:
        _failures.append(label + (f" -- {detail}" if detail else ""))


class _AiServiceStub(BaseHTTPRequestHandler):
    """Stands in for the AI service: multipart in, raw text chunks out."""

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        _captured["body"] = self.rfile.read(length).decode("utf-8", "replace")
        _captured["path"] = self.path
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        for part in (
            "| Test Case ID | Category | Test Case Description |\n",
            "| TC-001 | Mobile Plans | Verify Business First Plus Local 110 |\n",
        ):
            self.wfile.write(part.encode("utf-8"))
            self.wfile.flush()

    def log_message(self, *args):
        pass


def main():
    stub = HTTPServer(("127.0.0.1", 0), _AiServiceStub)
    threading.Thread(target=stub.serve_forever, daemon=True).start()
    settings.LLM_PROVIDER = "ai_service"
    settings.ai_config.BASE_URL = f"http://127.0.0.1:{stub.server_address[1]}"
    settings.ai_config.ENDPOINTS.chatStream = "/chat/message"

    app = FastAPI()
    app.include_router(generate.router, prefix="/generate")
    app.dependency_overrides[get_current_user_strict] = lambda: {"username": "tester"}
    client = TestClient(app)

    print("\nKB match preflight")
    res = client.post("/generate/kb-match", data={"text": GROUNDED_QUERY})
    check("returns 200", res.status_code == 200, str(res.status_code))
    body = res.json() if res.status_code == 200 else {}
    check("reports the requirement as grounded", body.get("grounded") is True)
    check("names the application", bool(body.get("app_name")), str(body))
    check("names the matched flow", bool(body.get("flow_name")), str(body))
    check(
        "lists the keywords that matched",
        isinstance(body.get("matched_keywords"), list)
        and len(body["matched_keywords"]) > 0,
        str(body.get("matched_keywords")),
    )
    check("reports how much context was added", (body.get("context_chars") or 0) > 0)
    check("does not leak the prompt fragment", "context" not in body)

    print("\nKB match on a requirement the Knowledge Base does not cover")
    res = client.post("/generate/kb-match", data={"text": UNGROUNDED_QUERY})
    check("returns 200 rather than an error", res.status_code == 200)
    miss = res.json() if res.status_code == 200 else {}
    check("reports it as not grounded", miss.get("grounded") is False)
    check(
        "says no flow matched, not that the KB is missing",
        miss.get("reason") == "no_flow_matched",
        str(miss.get("reason")),
    )

    # Two independent defences, and they catch different inputs. Both are
    # tested because removing either one lets a real document through.

    print("\nA requirement sharing only an incidental word with a flow")
    # "Business Requirements Document" contains "business", a word inside the
    # products "Business First Plus Local 110/150/200". Three products x +6 =
    # 18 points, and with nothing else scoring that won outright -- grounding a
    # Trade License BRD against a mobile plan purchase journey and handing it
    # real eand.ae URLs and ProductIds.
    #
    # Fixed in the DATA: product_name_stopwords in the app profile stops a
    # generic word scoring at all, so the matcher now returns nothing here.
    incidental = (
        "Business Requirements Document. B2B Portal - Trade License Details in "
        "Manage Users. The user opens Manage Users and views trade license "
        "details for a business account."
    )
    res = client.post("/generate/kb-match", data={"text": incidental})
    weak = res.json() if res.status_code == 200 else {}
    check("is not reported as grounded", weak.get("grounded") is False, str(weak))
    check(
        "the stopwords stop it at the matcher",
        weak.get("reason") == "no_flow_matched",
        f"expected no_flow_matched, got {weak.get('reason')!r} -- if this says "
        "weak_match, product_name_stopwords is missing from the app profile",
    )

    _captured.clear()
    client.post("/generate/brd-testcases", data={"text": incidental})
    check(
        "and no Knowledge Base block reaches the model",
        "APPLICATION FLOW KNOWLEDGE BASE" not in _captured.get("body", ""),
    )

    print("\nA requirement that names the app but matches no flow")
    # The case stopwords CANNOT fix. Naming the application resolves an app_id,
    # and match_flow_blueprint then falls back to that app's default flow on
    # the reasoning "you asked about this app, here is its primary journey".
    # For a password reset that hands back a mobile plan purchase journey with
    # zero supporting evidence -- and most BRDs name their application.
    named_app = "Verify password reset on the e& UAE SMBApp"
    res = client.post("/generate/kb-match", data={"text": named_app})
    fallback = res.json() if res.status_code == 200 else {}
    check("is not reported as grounded", fallback.get("grounded") is False, str(fallback))
    check(
        "is reported as a rejected weak match",
        fallback.get("reason") == "weak_match",
        str(fallback.get("reason")),
    )
    check("still names the flow it declined", bool(fallback.get("flow_name")))

    _captured.clear()
    client.post("/generate/brd-testcases", data={"text": named_app})
    check(
        "and no Knowledge Base block reaches the model",
        "APPLICATION FLOW KNOWLEDGE BASE" not in _captured.get("body", ""),
    )

    print("\nEmpty input")
    res = client.post("/generate/kb-match", data={"text": "   "})
    check("is refused with 400", res.status_code == 400, str(res.status_code))

    print("\nThe badge and the prompt cannot disagree")
    report = testcases.describe_grounding(GROUNDED_QUERY)
    check("describe_grounding agrees with the endpoint", report["grounded"] is True)
    check(
        "the reported size is the context actually built",
        report["context_chars"] == len(report["context"]),
    )

    print("\nGrounded generation over LLM_PROVIDER=ai_service")
    res = client.post("/generate/brd-testcases", data={"text": GROUNDED_QUERY})
    check("returns 200", res.status_code == 200, str(res.status_code))
    check("no OpenRouter key was needed", not settings.OPENROUTER_API_KEY)
    check("the AI service was the endpoint called", _captured.get("path") == "/chat/message")

    sent = _captured.get("body", "")
    check(
        "the Knowledge Base block reached the AI service",
        "APPLICATION FLOW KNOWLEDGE BASE" in sent,
    )
    check(
        "real catalog URL travelled in the prompt",
        "/en/smb/products/mobile/mobile-plans/business-first-plus.html" in sent,
    )
    check("the model's reply is streamed back", "TC-001" in res.text)

    print("\nUngrounded generation still goes out disciplined")
    _captured.clear()
    res = client.post("/generate/brd-testcases", data={"text": UNGROUNDED_QUERY})
    check("returns 200", res.status_code == 200)
    sent = _captured.get("body", "")
    check(
        "carries the no-knowledge guidance instead of flow context",
        "NO VERIFIED APPLICATION KNOWLEDGE IS AVAILABLE" in sent,
    )
    check(
        "and carries no Knowledge Base block",
        "APPLICATION FLOW KNOWLEDGE BASE" not in sent,
    )

    stub.shutdown()

    print()
    if _failures:
        print(f"{len(_failures)} check(s) FAILED:")
        for failure in _failures:
            print("  -", failure)
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
