"""
--- Journey KB: integrity, matching, prompt context and the Automation KB diff ---

Covers what the Journey KB promises and nothing else checks:

  1. Integrity -- every screen, element, rule and journey a file names exists,
     and no locator has leaked into the design layer.
  2. Matching -- a requirement lands on the right journey, and a journey that
     needs sign-in brings the sign-in journey with it.
  3. Prompt context -- labels are quoted verbatim, including the application's
     own spellings, and nothing selector-shaped reaches the model.
  4. Diff -- one realistic test case is compared with the Automation KB as the
     crawl recorded it (fixture below, copied from the committed profile), and
     each step lands in the status it should.

No browser, no model, no database. Run from ai-admin-module-py:

    .venv312/Scripts/python.exe tests/journeys/smoke_journey_kb.py
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.services.journeys import diff, store  # noqa: E402

APP = "eand_b2b_portal"
failures = []


def check(condition, message):
    print(("  ok   " if condition else "  FAIL ") + message)
    if not condition:
        failures.append(message)


# The crawl-derived Automation KB entries this journey relies on, as committed
# (git HEAD) before any document-derived edits. A fixture rather than the file
# on disk so the expected statuses do not move when the working copy does.
CRAWLED_PROFILE = {
    "endpoints": {"login": "/b2bportal/login.html?rdr=home&locale=en", "home": "/b2bportal/home.html?locale=en"},
    "selectors": {
        "authentication": {
            "username_field": "//input[@id ='userEmailField']",
            "receive_otp_button": "//button[contains(.,'RECEIVE OTP')]",
            "otp_digit_field_all": "//input[contains(@name,'opt-field')]",
            "error_dialog_ok_button": "//button[contains(.,'OKAY')]",
        },
        "navigation": {"manage_link": "//a[text()='Manage']"},
        "session": {
            "profile_menu": "//a[@class='company-info font-light']",
            "sign_out_button": "//a[text()='Sign Out' and not (contains(@class,'px-10 py-0'))]",
        },
        "trade_license": {"close_document_viewer": "//button[@aria-label='Close']"},
    },
    "step_grounding_rules": [
        {"id": "close_trade_license_viewer", "keywords": ["close the modal", "close the document"], "target": "//button[@aria-label='Close']"},
    ],
}

print("1. Integrity")
kb = store.load(APP)
check(kb is not None, "Journey KB loads")
check(len(kb.journeys) == 2, f"two authored journeys ({sorted(kb.journeys)})")
check(kb.taxonomy["summary"]["total_nodes"] == 253, "taxonomy carries the full master topic list")
node_ids = {n["id"] for n in kb.taxonomy["nodes"]}
for journey in kb.journeys.values():
    check(journey["journey_id"] in node_ids, f"{journey['journey_id']} is a taxonomy node")
    for sid in journey["screens"]:
        check(sid in kb.screens, f"{journey['journey_id']} screen {sid} exists")
    for rid in journey["business_rules"]:
        check(rid in kb.rules, f"{journey['journey_id']} rule {rid} exists")
    for step in journey["steps"]:
        for sid in str(step.get("screen_id", "")).split("|"):
            if sid:
                check(sid in kb.screens, f"{journey['journey_id']} step {step['step_number']} screen {sid} exists")
        if step.get("element_id"):
            screen = kb.screens[step["screen_id"].split("|")[0]]
            check(any(e["element_id"] == step["element_id"] for e in screen["elements"]),
                  f"{journey['journey_id']} step {step['step_number']} element {step['element_id']} exists")
design_text = "".join(p.read_text(encoding="utf-8") for p in kb.directory.rglob("*.json") if p.name != "taxonomy.json")
check(not re.search(r"(?<!:)//[a-z*(]|\[@", design_text), "no XPath or attribute selector anywhere in the design layer")

print("2. Matching")
cases = {
    "I sign in with the one-time password sent to my email": "B2B.REG.EXISTING.SIGNIN.OTP",
    "After login a user with several organizations selects an organization and sees its cost centers": "B2B.REG.EXISTING.SIGNIN.SELECT_ORG",
    "Pay a bill with a saved credit card": None,
}
for text, expected in cases.items():
    match = store.match_journey(text, APP)
    got = match.journey["journey_id"] if match else None
    check(got == expected, f"{text[:50]!r} -> {got}")
chain = store.journey_chain(kb, kb.journeys["B2B.REG.EXISTING.SIGNIN.SELECT_ORG"])
check([j["journey_id"] for j in chain] == ["B2B.REG.EXISTING.SIGNIN.OTP", "B2B.REG.EXISTING.SIGNIN.SELECT_ORG"],
      "Select Organization is preceded by the authored sign-in variant")

print("3. Prompt context")
info = store.describe("select an organization after sign in and view the organization dashboard", APP)
context = info["context"]
check(info["grounded"], "describe() grounds the requirement")
for label in ("No Customer assosiated", "Select a Organization to continue", "N COST CENTERS (PARTY IDS) >", "No pending dues."):
    check(label in context, f"verbatim label in prompt: {label!r}")
check("//" not in context.replace("://", "") and "@id" not in context, "no locator reaches the prompt")

print("4. Diff against the crawled Automation KB")
test_case = [
    "Navigate to the B2B Portal login page",
    "Enter the registered email address in the Username or email field",
    "Click CONTINUE to request the one-time password",
    "Enter the six-digit OTP in boxes 1 to 6",
    "Click Proceed",
    "Verify 'Select a Organization to continue' lists every linked organization",
    "Click the organization card for Com1",
    "Verify the Organization Dashboard header shows the company profile control",
    "Verify the QUICK ACCESS widget lists Buy Fixed Service and Pay Accounts",
    "Open the profile menu",
    "Click Sign Out",
    "Close the modal",
]
expected = [
    diff.MATCH, diff.MATCH, diff.LABEL_DRIFT, diff.MATCH, diff.NOT_CRAWLED, diff.NOT_CRAWLED,
    diff.NOT_CRAWLED, diff.MATCH, diff.NOT_CRAWLED, diff.MATCH, diff.MATCH, diff.NOT_IN_DESIGN,
]
report = diff.diff_case(test_case, "sign in with OTP then select an organization", app_id=APP,
                        automation_profile=CRAWLED_PROFILE)
check(report["journey_id"] == "B2B.REG.EXISTING.SIGNIN.SELECT_ORG", f"diff picked journey {report['journey_id']}")
for row, want in zip(report["steps"], expected):
    check(row["status"] == want, f"{row['action'][:55]:55} -> {row['status']} (want {want})")
drift = report["steps"][2]
check(drift.get("corrected_action") == "Click RECEIVE OTP to request the one-time password",
      f"LABEL_DRIFT proposes the application's wording: {drift.get('corrected_action')!r}")
check(not report["automatable"], "case is not yet automatable (uncrawled controls remain)")

broken = diff.diff_case(["Open the Manage section"], app_id=APP, journey_id="B2B.REG.EXISTING.SIGNIN.SELECT_ORG",
                        automation_profile={"selectors": {}})
check(broken["steps"][0]["status"] in (diff.REF_BROKEN, diff.NOT_CRAWLED),
      f"a reference the Automation KB lost is reported, not guessed ({broken['steps'][0]['status']})")

print("\nDiff report (crawled profile):")
for row in report["steps"]:
    print(f"  {row['status']:13} {row['action'][:60]:60} {row['element_id'] or row['screen_id'] or ''}")
print(json.dumps(report["summary"]))

if failures:
    print(f"\n{len(failures)} check(s) failed")
    sys.exit(1)
print("\nall checks passed")
