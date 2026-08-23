"""A local OpenAI-compatible STREAMING stub for the generation endpoints.

tests/automation/llm_stub.py answers in one shot, which is all the refine
transport needs. This endpoint streams, and the parsing it does -- SSE frames,
keep-alive comments, [DONE], a trailing usage frame -- only exists on the
streaming path, so it needs a server that actually produces those.

Serves POST /v1/chat/completions and replies with a small markdown table of
test cases, split across several frames so chunk reassembly is exercised
rather than assumed. Nothing outside localhost is contacted.

    python sse_stub.py 8098
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

# Split mid-row on purpose: if the transport ever reassembles chunks wrongly,
# a table that is only correct once concatenated will show it.
CHUNKS = [
    "| Test Case ID | Category | Test Case Description | Preconditions | "
    "Test Steps | Test Data | Expected Result | Priority |\n",
    "| --- | --- | --- | --- | --- | --- | --- | --- |\n",
    "| TC-001 | Authentication | Verify that a valid user can sign in. | ",
    "A registered account exists. | 1. Open the login page. 2. Enter valid "
    "credentials. 3. Click Sign In. | username=test.user | The dashboard is "
    "displayed. | High |\n",
    "| TC-002 | Authentication | Verify that an invalid password is rejected. | ",
    "A registered account exists. | 1. Open the login page. 2. Enter a wrong "
    "password. 3. Click Sign In. | password=wrong | An invalid credentials "
    "message is shown. | High |\n",
]

USAGE = {"prompt_tokens": 812, "completion_tokens": 244, "total_tokens": 1056}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length).decode("utf-8", "replace") or "{}")

        if not body.get("stream"):
            self.send_error(400, "This stub only answers streaming requests")
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        def frame(obj):
            self.wfile.write(f"data: {json.dumps(obj)}\n\n".encode("utf-8"))
            self.wfile.flush()

        # A keep-alive comment, exactly as OpenRouter sends while a model warms
        # up. A transport that treats it as data corrupts the first row.
        self.wfile.write(b": OPENROUTER PROCESSING\n\n")
        self.wfile.flush()

        for chunk in CHUNKS:
            frame({"choices": [{"delta": {"content": chunk}}]})

        frame({"choices": [], "usage": USAGE})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def log_message(self, *args):  # keep the test output readable
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8098
    print(f"[sse_stub] listening on http://127.0.0.1:{port}/v1/chat/completions")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
