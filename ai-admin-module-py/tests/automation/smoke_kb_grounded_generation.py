"""--- Classification and scripts follow what the Knowledge Base has confirmed ----------

Against the repository's real Knowledge Base (B2B Portal and e& UAE Portal):

  1. A case built on what a flow lists under unverified_from_brd -- the Manage
     Users "Trade Licence" column, a TL number link in Users -- is Manual, naming the
     feature. A case on the confirmed route (Manage -> view & update details)
     is not.
  2. With no discovery crawl, steps are grounded the way the compiler grounds
     them; a step whose control the KB cannot supply is reported.
  3. A B2B script signs in first (the flow's prerequisite), types the OTP one
     digit per box, uses the flow's own selectors for quoted labels, picks the
     item a Test Data value names, and never falls back to the shop's cart/URL
     check: a verification with nothing checkable fails with a reason.
  4. An e& UAE Portal (shop) script keeps its shop handling.

Run from ai-admin-module-py:

    .venv312/Scripts/python.exe tests/automation/smoke_kb_grounded_generation.py
"""
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
work = Path(tempfile.mkdtemp())
os.environ["DATABASE_URL"] = f"sqlite:///{(work / 'grounded.db').as_posix()}"
os.environ["AUTOMATION_KB_PATH"] = str(ROOT / "knowledge_base")
os.environ["JOURNEY_KB_PATH"] = str(ROOT / "knowledge_base" / "journeys")

from app.services.automation import classification, compiler  # noqa: E402
from app.services.automation import knowledge_base as kb  # noqa: E402

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(("PASS " if condition else "FAIL ") + label + (f"  -- {detail}" if detail and not condition else ""))
    if not condition:
        failures.append(label)


def case(display_id: str, objective: str, steps: list[dict], **extra) -> SimpleNamespace:
    numbered = [{"step_number": i, "target": None, "test_data_ref": None, "expected_result": None, **s}
                for i, s in enumerate(steps, start=1)]
    base = dict(
        display_id=display_id, objective=objective, description=objective, preconditions="",
        steps_structured=numbered, steps_raw="\n".join(s["action"] for s in numbered),
        test_data="", expected_result="", application_url="", category="", automation_blockers=[],
        test_data_requirements=None, recorded_flow_objects=[], application_id=None,
    )
    base.update(extra)
    return SimpleNamespace(**base)


B2B = "eand_b2b_portal"
B2B_URL = "https://devnew-sas.etisalat.ae/b2bportal/login.html"

tc04 = case(
    "TC-04",
    "Verify that an authorized organization with no users retains the empty-table state in Manage Users, "
    "displays the 'Trade License' column header, and offers no Trade License action on the B2B Portal.",
    [
        {"action": "Navigate to https://devnew-sas.etisalat.ae/b2bportal."},
        {"action": "Select the authorized organization with no users from the organization selector.",
         "test_data_ref": "empty_organization"},
        {"action": "Click 'Manage Users'."},
        {"action": "Assert that the users table includes the 'Trade License' column header."},
        {"action": "Assert that the users table contains no user records."},
        {"action": "Assert that the empty users table offers no Trade License action."},
    ],
    preconditions="The tester is authenticated to the B2B Portal.",
    application_url=B2B_URL,
)
tc05 = case(
    "TC-05",
    "Verify that selecting TL123456 from Manage Users shows a loading state followed by a modal containing "
    "its trade-license details and PDF preview on the B2B Portal.",
    [
        {"action": "Navigate to https://devnew-sas.etisalat.ae/b2bportal."},
        {"action": "Click 'Manage Users'."},
        {"action": "Click 'TL123456'.", "test_data_ref": "tl123456_record"},
        {"action": "Click the modal close control."},
    ],
    application_url=B2B_URL,
)
verified = case(
    "TC-10",
    "View the Trade Licence document from Organizational Details on the B2B Portal.",
    [
        {"action": "Click 'Manage'"},
        {"action": "Click 'view & update details'"},
        {"action": "Open the Trade Licence document from the Organizational Details page"},
        {"action": "Verify the Trade Licence number is shown",
         "expected_result": "The label 'Trade Licence Number' is visible"},
        {"action": "Close the Trade Licence document viewer"},
    ],
    application_url=B2B_URL,
)

# --- 1. Unconfirmed features ------------------------------------------------------------
hits04 = {h["feature"] for h in kb.unconfirmed_features(tc04.objective + " " + tc04.steps_raw, B2B)}
check("TC-04 depends on the unconfirmed Trade Licence column", "trade license column" in hits04, str(hits04))
hits05 = {h["feature"] for h in kb.unconfirmed_features(tc05.objective + " " + tc05.steps_raw, B2B)}
# The Trade License Details modal is confirmed in RC (Organization Details -> view & update details,
# 2026-10-21); what stays unconfirmed is opening it from a TL number in Manage Users.
check("TC-05 depends on the unconfirmed TL number link in Manage Users", "tl number link in users" in hits05, str(hits05))
hits_ok = kb.unconfirmed_features(verified.objective + " " + verified.steps_raw, B2B)
check("the confirmed Organizational Details route depends on nothing unconfirmed", hits_ok == [], str(hits_ok))
check("another application's case is never matched against B2B flows",
      kb.unconfirmed_features("Add the iPhone 16 to the cart and checkout on e& UAE", "eand_ae") == [])

r04 = classification.assess(tc04)
codes04 = [b["code"] for b in r04["blockers"]]
check("TC-04 is classified Manual", r04["classification"] == "manual", f"{r04['classification']}: {r04['reason']}")
check("TC-04's reason names the unconfirmed feature", "kb.unconfirmed_feature" in codes04 and "not confirmed" in r04["reason"], r04["reason"])
r05 = classification.assess(tc05)
check("TC-05 is classified Manual", r05["classification"] == "manual", f"{r05['classification']}: {r05['reason']}")
r_ok = classification.assess(verified)
check("the confirmed-route case has no unconfirmed-feature blocker",
      "kb.unconfirmed_feature" not in [b["code"] for b in r_ok["blockers"]], str(r_ok["blockers"]))

# --- 2. Grounding against what the compiler can resolve when there is no crawl --------------------
fix05 = [f["code"] for f in r05["fixables"]]
check("TC-05's 'TL123456' click is reported as a control the KB does not have",
      "kb.unresolved_in_profile" in fix05, str(fix05))
check("the confirmed-route case grounds against the KB", "kb.unresolved_in_profile" not in
      [f["code"] for f in r_ok["fixables"]], str(r_ok["fixables"]))

# --- 3. B2B scripts ------------------------------------------------------------------------
script = compiler.compile_playwright(verified)
code = script.code
check("signs in first through the OTP flow", "flow_b2b_login_otp" in code and "userEmailField" in code)
check("signs in with the Journey KB's Test Data names",
      "TESTDATA_DEFAULT_ORG_EMAIL" in code and "TESTDATA_OTP" in code)
check("types the OTP one digit per box", "otpBoxes.nth(i).fill(digit)" in code)
check("'Click 'Manage'' uses the flow's own selector", "//div[@id='navbarCollapse']//a[normalize-space(.)='Manage']" in code)
check("the case's own step numbers are kept after the sign-in steps", '"1. Click' in code and '"S1.' in code)
check("the scope comes from the flow, not the shop", "ADD TO CART" not in code and "Organizational Details" in code)
check("no cart/URL stand-in for a verification", "cartOrCheckoutEl" not in code and "onTargetPage" not in code)
check("the quoted expected label is asserted", "getByText(\"Trade Licence Number\")" in code)

code04 = compiler.compile_playwright(tc04).code
check("TC-04's script flags its unconfirmed dependency", "UNCONFIRMED" in code04)
check("TC-04 picks the organization the Test Data value names",
      "getByText(empty_organization, { exact: true })" in code04 and "productEl" not in code04)
check("TC-04 asserts the quoted 'Trade License' label", "getByText(\"Trade License\")" in code04)
check("TC-04's unverifiable assertions fail with a reason instead of passing",
      "throw new Error(\"Step 5: nothing checkable" in code04 and "onTargetPage" not in code04)
check("TC-04 does not sign in twice when the case authenticates itself -- it does not, so it signs in",
      "userEmailField" in code04)
gate = [i.message for i in compiler.compile_playwright(tc04).issues]
check("the static gate warns about the unconfirmed dependency", any("not confirmed" in m for m in gate), str(gate))

signed = case(
    "TC-11",
    "Sign in with OTP and open Organizational Details on the B2B Portal to view the Trade Licence document.",
    [
        {"action": "Enter Email ID in 'Enter your email to receive OTP'", "test_data_ref": "default_org_email"},
        {"action": "Click 'RECEIVE OTP'"},
        {"action": "Click 'Manage'"},
    ],
    application_url=B2B_URL,
)
check("a case that signs in itself gets no extra sign-in", '"S1.' not in compiler.compile_playwright(signed).code)

# --- 4. The shop keeps its handling --------------------------------------------------------
shop = case(
    "TC-20",
    "Add the iPhone 16 Pro smartphone to the cart on the e& UAE shop.",
    [
        {"action": "Navigate to the smartphones catalogue"},
        {"action": "Click on 'iPhone 16 Pro'"},
        {"action": "Click 'Add to cart'"},
        {"action": "Verify the shopping cart shows the device"},
    ],
    application_url="https://devnew-sas.etisalat.ae/en/index.html",
)
shop_code = compiler.compile_playwright(shop).code
check("the shop script keeps ADD TO CART handling", "addBtn" in shop_code)
check("the shop script keeps its product-card click", "productEl" in shop_code)
check("the shop script does not sign in", "userEmailField" not in shop_code)

print()
print(f"{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}")
sys.exit(1 if failures else 0)
