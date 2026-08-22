"""A local OpenAI-compatible stub, so the refine endpoint can be exercised
without contacting the corporate AI service or any external host.

Serves POST /v1/chat/completions and answers with a refined test case shaped
exactly as the prompt asks for: a JSON array, one object, echoing back the ref
it was given.

    python llm_stub.py 8099
"""
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


def build_reply(ref: str) -> list:
    return [
        {
            "ref": ref,
            "title": "TC-CSV-01",
            "objective": "Proves a raised invoice can be downloaded as a PDF from Billing.",
            "preconditions": [
                "A customer account exists with at least one raised invoice.",
                "The user is signed in with billing permissions.",
            ],
            "steps": [
                {
                    "step_number": 1,
                    "action": "Navigate to the Billing page",
                    "target": "/billing",
                    "test_data_ref": None,
                    "expected_result": "The invoice list is displayed",
                },
                {
                    "step_number": 2,
                    "action": "Select the invoice row matching the invoice identifier",
                    "target": "Invoice list row",
                    "test_data_ref": "invoice_id",
                    "expected_result": "The invoice detail panel opens",
                },
                {
                    "step_number": 3,
                    "action": "Click the 'Download' button",
                    "target": "Download button",
                    "test_data_ref": None,
                    "expected_result": "A PDF file download begins",
                },
            ],
            "expected_result": "The PDF downloads and contains the selected invoice.",
            "bdd_scenario": (
                "Given a customer with a raised invoice\n"
                "When the user downloads it from the Billing page\n"
                "Then a PDF of that invoice is saved"
            ),
            "priority": "High",
            "test_type": "Positive",
            "test_data_requirements": [
                {
                    "key": "invoice_id",
                    "description": "Identifier of an invoice already raised on the account",
                    "example_value": None,
                    "sensitive": False,
                    "resolution": "existing_record",
                }
            ],
            "test_data_required": True,
            "test_data_notes": "Provide the identifier of an invoice already raised in the environment.",
            "automation_blockers": [],
        }
    ]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8", "replace")

        # Echo the ref back, exactly as the real prompt demands.
        #
        # The payload is JSON nested inside the chat envelope's JSON, so in the
        # raw body its quotes arrive backslash-escaped (\"ref\": \"case-2\") and
        # a regex over the raw text does not match. Decode the envelope first
        # and search the user message, where the quotes are real.
        ref = "unknown"
        try:
            envelope = json.loads(raw)
            content = " ".join(
                str(m.get("content", "")) for m in envelope.get("messages", [])
            )
        except (ValueError, AttributeError, TypeError):
            content = raw
        match = re.search(r'"ref"\s*:\s*"([^"]+)"', content)
        if match:
            ref = match.group(1)

        payload = {
            "id": "stub-1",
            "object": "chat.completion",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        # Fenced on purpose: real models do this despite being
                        # told not to, and extract_json has to cope.
                        "content": "```json\n"
                        + json.dumps(build_reply(ref), indent=2)
                        + "\n```",
                    },
                    "finish_reason": "stop",
                }
            ],
        }
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
    print(f"LLM stub listening on http://127.0.0.1:{port}/v1", flush=True)
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
