"""
--- AI Checks: the selected Knowledge Base reaches every step -------------------

Runs one generated case through AI Checks with "Automation KB" selected (the
application's one Knowledge Base, whose design-journey layer recognises this
case), with "Journey KB" (its old name) and with no KB -- against a throwaway
SQLite database, with the model replaced by a recorder that answers each call
with a canned result.

What it proves:
  1. Refine, Quality Review and Auto-Improve receive the selected KB's context
     (as reference_knowledge inside the fenced payload), and receive nothing
     when no KB was selected.
  2. KB Diff runs for Automation KB (and Journey KB, its old name), stores its
     report on the case, and is skipped for any other choice.
  3. The batch view reports the new step and the diff counts.

No network, no browser, no real model. Run from ai-admin-module-py:

    .venv312/Scripts/python.exe tests/journeys/smoke_ai_checks_kb.py
"""
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
_db = Path(tempfile.mkdtemp()) / "ai_checks_kb.db"
os.environ["DATABASE_URL"] = f"sqlite:///{_db.as_posix()}"

from app.database.connection import Base, SessionLocal, engine  # noqa: E402
import app.models.automation  # noqa: E402,F401
from app.models.automation import AutomationAICheck, AutomationTestCase  # noqa: E402
from app.services.automation import ai_checks, refine, review_agent  # noqa: E402

Base.metadata.create_all(bind=engine)
failures = []


def check(condition, message):
    print(("  ok   " if condition else "  FAIL ") + message)
    if not condition:
        failures.append(message)


# --- The model, replaced by a recorder -----------------------------------------
calls = []

STEPS = [
    {"step_number": 1, "action": "Navigate to the B2B Portal login page", "action_type": "navigate", "target": "login page", "expected_result": "SIGN IN TO BUSINESS ONLINE is shown"},
    {"step_number": 2, "action": "Enter the registered email address", "action_type": "fill", "target": "Username or email*", "expected_result": "The email is accepted"},
    {"step_number": 3, "action": "Click CONTINUE to request the one-time password", "action_type": "click", "target": "CONTINUE", "expected_result": "'Enter your One Time Password.' is shown"},
    {"step_number": 4, "action": "Enter the six-digit OTP in boxes 1 to 6", "action_type": "fill", "target": "OTP digit boxes (6)", "expected_result": "The green tick appears"},
    {"step_number": 5, "action": "Click Proceed", "action_type": "click", "target": "Proceed", "expected_result": "The portal leaves the OTP panel"},
]


def fake_complete_json(*, system_prompt, user_input, model_cls, **_):
    payload = json.loads(user_input.split("<user_content>", 1)[1].rsplit("</user_content>", 1)[0])
    name = model_cls.__name__
    calls.append({"model": name, "payload": payload})
    if name == "_ArrayAdapter":
        ref = payload["items"][0]["ref"]
        return model_cls.model_validate([{
            "ref": ref, "title": payload["items"][0]["title"],
            "objective": "Sign in with OTP.", "preconditions": ["Registered user"],
            "steps": STEPS, "expected_result": "Signed in", "bdd_scenario": "Given/When/Then",
            "priority": "High", "test_type": "Positive", "test_data_requirements": [],
            "test_data_required": False, "test_data_notes": None, "automation_blockers": [],
        }])
    if name == "TestCaseReviewLLMOutput":
        # A coverage gap forces Auto-Improve to run, so all three steps are seen.
        return model_cls(test_case_id="x", step_quality_score=3, data_readiness_score=4,
                         expected_result_clarity_score=4, coverage_score=3,
                         coverage_gaps=["resend path"], issues=[], suggestions=[])
    if name == "ImprovedTestCaseLLM":
        return model_cls(title="t", objective="Sign in with OTP.", preconditions=["Registered user"],
                         steps=STEPS, expected_result="Signed in", priority="High", test_type="Positive")
    raise AssertionError(f"unexpected model call {name}")


refine.complete_json = fake_complete_json
review_agent.complete_json = fake_complete_json
ai_checks._launch = lambda *a, **k: None  # run synchronously below instead of on a thread

# The Automation KB as the crawl recorded it, so the expected diff does not move
# with whatever the working copy of app_profile.json holds.
from app.services.journeys import diff as journey_diff  # noqa: E402

CRAWLED_PROFILE = {
    "endpoints": {"login": "/b2bportal/login.html?rdr=home&locale=en"},
    "selectors": {"authentication": {
        "username_field": "//input[@id ='userEmailField']",
        "receive_otp_button": "//button[contains(.,'RECEIVE OTP')]",
        "otp_digit_field_all": "//input[contains(@name,'opt-field')]",
    }},
}
_diff_case = journey_diff.diff_case
journey_diff.diff_case = lambda steps, text="", **kw: _diff_case(steps, text, automation_profile=CRAWLED_PROFILE, **kw)

ROW = {
    "Test Case ID": "TC-001",
    "Test Case Description": "Registered user signs in using the one-time password (OTP) sent to email and mobile",
    "Preconditions": "A registered B2B user",
    "Test Steps": "1. Open the login page 2. Enter email 3. Click CONTINUE 4. Enter the OTP 5. Click Proceed",
    "Expected Result": "The user is signed in",
}


def run(knowledge_base):
    calls.clear()
    db = SessionLocal()
    batch = ai_checks.start_batch(db, [dict(ROW)], actor="smoke", knowledge_base=knowledge_base)
    check_id = db.query(AutomationAICheck.id).filter(AutomationAICheck.batch_id == batch).scalar()
    db.close()
    ai_checks._run_check(check_id)
    db = SessionLocal()
    view = ai_checks.batch_view(db, batch, include_steps=True)
    record = db.get(AutomationAICheck, check_id)
    case = db.get(AutomationTestCase, record.case_id)
    result = (view, record, case, list(calls))
    db.close()
    return result


print("1. Automation KB selected (a design journey recognises the case)")
view, record, case, seen = run("Automation KB")
item = view["items"][0]
check(record.status == "done", f"check finished ({record.status}: {record.error})")
check([c["model"] for c in seen] == ["_ArrayAdapter", "TestCaseReviewLLMOutput", "ImprovedTestCaseLLM", "TestCaseReviewLLMOutput"],
      f"refine, review, improve, re-review all called ({[c['model'] for c in seen]})")
for c in seen:
    ref = c["payload"].get("reference_knowledge") or {}
    check(ref.get("knowledge_base") == "Automation KB" and "JOURNEY KNOWLEDGE BASE" in ref.get("content", ""),
          f"{c['model']} received the design journey's context")
check("No Customer assosiated" in seen[0]["payload"]["reference_knowledge"]["content"],
      "context carries the design's verbatim labels")
check(record.steps == {"refine": "done", "review": "done", "improve": "done", "diff": "done", "classify": "done"},
      f"step states {record.steps}")
diff = case.journey_diff or {}
check(diff.get("journey_id") == "B2B.REG.EXISTING.SIGNIN.OTP", f"diff stored on the case for {diff.get('journey_id')}")
statuses = [s["status"] for s in diff.get("steps", [])]
check(statuses[2] == "LABEL_DRIFT" and statuses[4] == "NOT_CRAWLED",
      f"diff statuses {statuses}")
check(item["journey_diff"]["summary"] == diff["summary"], "batch view carries the diff counts")
check(len(item["journey_diff_steps"] or []) == len(STEPS), "edit view carries the step-by-step diff")
check(view["pipeline"]["diff"]["done"] == 1, "pipeline counts the KB Diff step")
check(case.review_findings.get("reference_kb") == "Automation KB", "review records which KB it judged labels against")

print("1b. Journey KB (the old name) is the same KB")
view, record, case, seen = run("Journey KB")
check(record.steps.get("diff") == "done" and (case.journey_diff or {}).get("journey_id") == "B2B.REG.EXISTING.SIGNIN.OTP",
      f"KB Diff still runs ({record.steps.get('diff')})")
check(all((c["payload"].get("reference_knowledge") or {}).get("knowledge_base") == "Automation KB" for c in seen),
      "every step receives it as Automation KB")

print("2. No KB selected")
view, record, case, seen = run(None)
check(record.status == "done", f"check finished ({record.status}: {record.error})")
check(all("reference_knowledge" not in c["payload"] for c in seen), "no step received KB context")
check(record.steps.get("diff") == "skipped" and case.journey_diff is None, "KB Diff skipped, nothing stored")
check(view["items"][0]["journey_diff"] is None, "batch view reports no diff")

print("3. A batch checked before KB Diff existed")
db = SessionLocal()
old = db.get(AutomationAICheck, record.id)
old.steps = {"refine": "done", "review": "done", "improve": "skipped", "classify": "done"}
db.commit()
states = ai_checks.batch_view(db, old.batch_id)["items"][0]["steps"]
db.close()
check(states.get("diff") == "skipped", f"missing diff state reads as skipped ({states.get('diff')})")

if failures:
    print(f"\n{len(failures)} check(s) failed")
    sys.exit(1)
print("\nall checks passed")
