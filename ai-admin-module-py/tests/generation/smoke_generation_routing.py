"""
--- Generation routing after the team's Azure / Squad KB merge (2026-10-07) ---------

No model is called: the transports are replaced by recorders, so this checks
WHERE each Select KB choice goes and WHAT it sends.

  1. Device Squad KB  -> /generate/squad-testcases: Azure, the team's squad
     prompt + flow context + squad retrieval, no token cap, no temperature.
     A non-squad KB on that path is refused.
  2. Automation KB -> /generate/kb-testcases: ONE application KB -- a matching
     design journey grounds the prompt, else the crawled flows ("Journey KB",
     its old name, is the same KB). Our disciplined prompt; provider from
     SQUAD_KB_GENERATION_PROVIDER, else OpenAI when configured, else Azure
     (the team's environment), with the token cap kept.
  3. Default KB on this backend (/generate/brd-testcases, no KB): LLM_PROVIDER
     path, no KB grounding.
  4. AI Refine: reference_context is unchanged per KB, and its Azure calls
     still send max_completion_tokens and temperature.
  5. Figma extraction goes to Azure; squads list/add use the team's registry
     (on a throwaway copy).
  6. Coverage Analysis loads and runs its three steps on Azure.

Run from ai-admin-module-py:

    .venv312/Scripts/python.exe tests/generation/smoke_generation_routing.py
"""
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
work = Path(tempfile.mkdtemp())
os.environ["DATABASE_URL"] = f"sqlite:///{(work / 'gen.db').as_posix()}"

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.config import settings  # noqa: E402
from app.routers import generate  # noqa: E402
from app.services.generation import azure_llm, stream, testcases  # noqa: E402
from app.services.knowledge_base import hybrid_retrieval_engine, squads  # noqa: E402
from app.utils.security import get_current_user_strict  # noqa: E402

failures = []


def check(condition, message):
    print(("  ok   " if condition else "  FAIL ") + message)
    if not condition:
        failures.append(message)


calls = []


def fake_azure_stream(**kw):
    calls.append(("azure", kw))
    yield "| ID | Test Case Objective |\n| --- | --- |\n| TC-01 | x |\n"


def fake_stream_chat(**kw):
    calls.append(("stream", kw))
    yield "| Test Case ID | Category |\n| --- | --- |\n| TC-001 | x |\n"


azure_llm.stream_chat = fake_azure_stream
stream.stream_chat = fake_stream_chat
hybrid_retrieval_engine.retrieve_context = lambda squad, query, top_k=5: f"SQUAD CONTEXT FOR {squad}"
squads._SQUADS_PATH = work / "squad_knowledge_bases.json"

api = FastAPI()
api.include_router(generate.router, prefix="/generate")
api.dependency_overrides[get_current_user_strict] = lambda: {"username": "tester", "roles": ["admin"]}
client = TestClient(api)
BRD = "The user signs in with a username and password and selects an organization."


def post(path, kb="", **extra):
    calls.clear()
    data = {"text": BRD, "max_tokens": "4096", "temperature": "0.2", **extra}
    if kb:
        data["knowledge_base"] = kb
    r = client.post(path, data=data)
    return r, (calls[0] if calls else (None, {}))


def set_env(**values):
    for k, v in values.items():
        setattr(settings, k, v)


print("1. Device Squad KB")
r, (kind, kw) = post("/generate/squad-testcases", "Device Squad")
check(r.status_code == 200, f"squad route answers ({r.status_code} {r.text[:120]})")
check(kind == "azure", f"goes to Azure ({kind})")
check(kw.get("system_prompt", "").startswith(testcases.SQUAD_SYSTEM_PROMPT[:60]), "with the team's squad prompt")
check("SQUAD CONTEXT FOR Device Squad" in kw.get("system_prompt", ""), "with the squad's retrieved context")
check(kw.get("max_tokens") is None and kw.get("temperature") is None, "with no token cap and no temperature")
r, _ = post("/generate/squad-testcases", "device   squad")
check(r.status_code == 200, "squad names match regardless of case and spacing")
r, (kind, _) = post("/generate/squad-testcases", "Automation KB")
check(r.status_code == 400 and kind is None, "Automation KB on the squad route is refused")
r, _ = post("/generate/squad-testcases")
check(r.status_code == 400, "no KB on the squad route is refused")

print("2. Automation KB and Journey KB")
saved = {k: getattr(settings, k) for k in ("SQUAD_KB_GENERATION_PROVIDER", "OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL",
                                           "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_MODEL")}
set_env(SQUAD_KB_GENERATION_PROVIDER="openai", OPENAI_API_KEY="k")  # the local .env
r, (kind, kw) = post("/generate/kb-testcases", "Automation KB")
check(r.status_code == 200 and kind == "stream", f"Automation KB answers on the stream transport ({r.status_code}, {kind})")
check(kw.get("provider") == "openai", f"provider openai as configured ({kw.get('provider')})")
check(kw.get("system_prompt", "").startswith(testcases.SYSTEM_PROMPT[:60]), "with our disciplined prompt, not the squad one")
check("SQUAD CONTEXT" not in kw.get("system_prompt", ""), "and no squad context")
check(kw.get("max_tokens") == 4096, "keeping the token cap")
r, (kind, kw) = post("/generate/kb-testcases", "Journey KB")
check(r.status_code == 200 and kind == "stream" and kw.get("provider") == "openai", "Journey KB (old name) is the same KB")
r, (kind, kw) = post("/generate/kb-testcases", "Automation KB", generation_mode="figma_pdf")
check(kw.get("model_override") == settings.FIGMA_VLM_MODEL, "Figma input on a KB uses the Figma model")

set_env(SQUAD_KB_GENERATION_PROVIDER="", OPENAI_API_KEY="", AZURE_OPENAI_BASE_URL="https://x.openai.azure.com/openai/v1",
        AZURE_OPENAI_API_KEY="k", AZURE_OPENAI_MODEL="gpt-6-sol")  # the team's .env
r, (kind, kw) = post("/generate/kb-testcases", "Automation KB")
check(r.status_code == 200 and kind == "azure", f"with only Azure configured, Automation KB goes to Azure ({r.status_code}, {kind})")
check(kw.get("max_tokens") == 4096 and kw.get("temperature") == 0.2, "keeping its token cap and temperature")
check(kw.get("system_prompt", "").startswith(testcases.SYSTEM_PROMPT[:60]), "and our prompt")
r, (kind, _) = post("/generate/kb-testcases", "Journey KB")
check(r.status_code == 200 and kind == "azure", "Journey KB too")
r, _ = post("/generate/kb-testcases", "Nonsense KB")
check(r.status_code == 400, "an unknown KB is refused")
set_env(**saved)

print("3. Default KB (no KB) on this backend")
set_env(SQUAD_KB_GENERATION_PROVIDER="openai", OPENAI_API_KEY="k")
r, (kind, kw) = post("/generate/brd-testcases")
check(r.status_code == 200 and kind == "stream", f"answers on the stream transport ({r.status_code}, {kind})")
check(kw.get("provider") is None and kw.get("model_override") is None, "with LLM_PROVIDER's model, no KB provider")
check(kw.get("system_prompt", "").startswith(testcases.SYSTEM_PROMPT[:60]), "with our prompt")
set_env(**saved)

print("4. AI Refine grounding and Azure parameters")
ref = testcases.reference_context("Automation KB", BRD)
check(ref["kind"] == "automation", f"Automation KB -> automation ({ref['kind']})")
ref = testcases.reference_context("Journey KB", BRD)
check(ref["kind"] == "automation" and ref["knowledge_base"] == "Automation KB", f"Journey KB -> the one Automation KB ({ref['kind']})")
check(testcases.normalize_knowledge_base("journey kb") == "Automation KB", "Journey KB normalises to Automation KB")
signin = ("Sign in to the B2B Portal using OTP: enter the mobile number, request the OTP, "
          "enter the one-time password and select the organization.")
ref = testcases.reference_context("Automation KB", signin)
check(ref["detail"].get("source") == "journey" and ref["context"], f"a requirement a design journey covers is grounded by the journey ({ref['detail'].get('source')})")
ref = testcases.reference_context("Automation KB", "Change the colour of the footer text on the careers page.")
check(ref["detail"].get("source") is None and not ref["context"], f"a requirement neither layer covers stays ungrounded ({ref['detail'].get('source')})")
ref = testcases.reference_context("Automation KB", "Buy the Business First Plus mobile plan from the e& SMB shop, add it to cart and checkout with a card.")
check(ref["detail"].get("source") == "flows" and ref["context"], f"one no journey covers is grounded by the crawled flows ({ref['detail'].get('source')})")
ref = testcases.reference_context("Device Squad", BRD)
check(ref["kind"] == "squad" and "SQUAD CONTEXT" in ref["context"], "Device Squad -> squad, with its context")
body = azure_llm._chat_body("s", "u", 16000, 0.1)
check(body.get("max_completion_tokens") == 16000 and body.get("temperature") == 0.1, "Refine's Azure body keeps max tokens and temperature")
body = azure_llm._chat_body("s", "u", None, None)
check("max_completion_tokens" not in body and "temperature" not in body, "the squad body sends neither")
from app.services.automation import llm as automation_llm  # noqa: E402
check(hasattr(automation_llm, "complete_text") and hasattr(azure_llm, "complete_text"), "Refine's transports are present")

print("5. Figma and squads")
azure_llm.extract_pdf_text = lambda **kw: calls.append(("figma", kw)) or "Extracted text"
set_env(AZURE_OPENAI_BASE_URL="https://x.openai.azure.com/openai/v1", AZURE_OPENAI_API_KEY="k", AZURE_OPENAI_MODEL="gpt-6-sol")
calls.clear()
r = client.post("/generate/figma/extract-text", files={"file": ("design.pdf", b"%PDF-1.4 x", "application/pdf")})
check(r.status_code == 200 and r.json().get("text") == "Extracted text" and calls and calls[0][0] == "figma", f"Figma goes to Azure ({r.status_code})")
check(r.json().get("model") == "gpt-6-sol", "and reports the Azure deployment")
set_env(**saved)
r = client.get("/generate/squad-knowledge-base/squads")
check(r.status_code == 200 and "Device Squad" in r.json()["squads"], f"squads listed ({r.json()})")
r = client.post("/generate/squad-knowledge-base/squads", json={"name": "Routing Test Squad"})
check(r.status_code == 201 and r.json()["added"] == "Routing Test Squad", "a squad is added")
r, (kind, _) = post("/generate/squad-testcases", "Routing Test Squad")
check(r.status_code == 200 and kind == "azure", "and generates on the squad route")

print("6. Coverage Analysis")
from app.routers import coverage as coverage_router  # noqa: E402
from app.schemas.coverage import CoverageMapping, RequirementDecomposition  # noqa: E402
from app.services.generation import coverage as coverage_service  # noqa: E402

coverage_service._PROMPTS_PATH = work / "coverage_prompts.json"
steps = []


def fake_json(*, model_cls, **kw):
    steps.append(model_cls.__name__)
    if model_cls is RequirementDecomposition:
        return model_cls.model_validate({"requirements": [
            {"requirement_id": "REQ-1", "requirement_text": "The user signs in.", "applicable_categories": ["positive", "negative"]}]})
    return model_cls.model_validate({"coverage": [
        {"requirement_id": "REQ-1", "covered_categories": ["positive"], "matched_test_case_ids": ["TC-1"], "gap_reason": "No negative case."}]})


def fake_text(**kw):
    steps.append("recommend")
    return "| ID | Description |\n| --- | --- |\n| TC-NEW-1 | Wrong password is refused |"


coverage_service.complete_json = fake_json
coverage_service.complete_text = fake_text
capi = FastAPI()
capi.include_router(coverage_router.router, prefix="/coverage")
capi.dependency_overrides[get_current_user_strict] = lambda: {"username": "tester", "roles": ["admin"]}
cclient = TestClient(capi)
r = cclient.get("/coverage/prompts")
check(r.status_code == 200 and set(r.json()["prompts"]) == {"decompose", "map", "recommend"}, f"prompts served ({r.status_code})")
sheet = "ID,Description,Steps,Expected\nTC-1,Valid sign in,Enter user and password,Dashboard shown\n"
r = cclient.post("/coverage/analyze", files=[
    ("requirement_files", ("brd.txt", b"The user signs in with a username and password.", "text/plain")),
    ("testcase_file", ("cases.csv", sheet.encode(), "text/csv")),
])
check(r.status_code == 200, f"analyze answers ({r.status_code} {r.text[:200]})")
check(steps == ["RequirementDecomposition", "CoverageMapping", "recommend"], f"three model steps in order ({steps})")
check("TC-NEW-1" in (r.json().get("recommended_test_cases_markdown") or ""), "recommended cases returned")

print()
print("FAILED:" if failures else "All checks passed.", *failures, sep="\n  ")
sys.exit(1 if failures else 0)
