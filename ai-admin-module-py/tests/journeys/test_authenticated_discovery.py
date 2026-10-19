from types import SimpleNamespace
from unittest.mock import patch
import subprocess

from app.services.automation.agent_auth import is_login_shorthand, login_variables_ready, observed_login_plan, ready_login_profile
from app.services.automation.discovery import build_discovery_spec, parse_discovery_output


def _kb(host: str, *, wrong_screen: bool = False, ambiguous: bool = False):
    def screen(route):
        return {"route": route, "elements": [
            {"element_id": "user", "label": "Username", "observed_strategy": "css", "observed_selector": '[name="username"]'},
            {"element_id": "pass", "label": "Password", "observed_strategy": "css", "observed_selector": '[name="password"]'},
            {"element_id": "submit", "label": "Log In", "type": "button", "observed_strategy": "role"},
        ]}
    sid = "login"
    screens = {sid: screen("/login")}
    if wrong_screen:
        screens["other"] = screen("/register")
    journeys = {"LOGIN": {"name": "Customer sign in"}}
    if ambiguous:
        journeys["LOGIN_2"] = {"name": "Customer login"}
    items = [
        {"kind": "goto", "screen_id": sid},
        {"kind": "fill", "screen_id": sid, "element": {"element_id": "user", "label": "Username"}, "variable": "TESTDATA_USERNAME"},
        {"kind": "fill", "screen_id": "other" if wrong_screen else sid,
         "element": {"element_id": "pass", "label": "Password"}, "variable": "TESTDATA_PASSWORD"},
        {"kind": "click", "screen_id": sid, "element": {"element_id": "submit", "label": "Log In"}},
    ]
    return SimpleNamespace(journeys=journeys, screens=screens), items


def test_observed_login_plan_works_for_two_unrelated_applications():
    for host in ("bank.example.test", "retail.example.test"):
        kb, items = _kb(host)
        with patch("app.services.journeys.crawl_runs._plan", return_value={"items": items}):
            plan = observed_login_plan(kb, base_url=f"https://{host}/", profile_id="QA")
        assert plan["login_url"] == f"https://{host}/login"
        assert plan["username_selector"] == '[name="username"]'


def test_observed_login_plan_uses_namespaced_variables_from_selected_profile():
    kb, items = _kb("shop.example.test")
    items[1]["variable"] = "TESTDATA_SETUP_A_USERNAME"
    items[2]["variable"] = "TESTDATA_SETUP_A_PASSWORD"
    with patch("app.services.journeys.crawl_runs._plan", return_value={"items": items}):
        plan = observed_login_plan(kb, base_url="https://shop.example.test/", profile_id="A")
    assert plan and plan["credential_variables"] == ["TESTDATA_SETUP_A_USERNAME", "TESTDATA_SETUP_A_PASSWORD"]


def test_observed_login_plan_rejects_wrong_screen_and_ambiguous_journey():
    for wrong_screen, ambiguous in ((True, False), (False, True)):
        kb, items = _kb("bank.example.test", wrong_screen=wrong_screen, ambiguous=ambiguous)
        with patch("app.services.journeys.crawl_runs._plan", return_value={"items": items}):
            assert observed_login_plan(kb, base_url="https://bank.example.test/", profile_id="QA") is None
    kb, items = _kb("bank.example.test")
    kb.screens["login"]["route"] = "https://retail.example.test/login"
    with patch("app.services.journeys.crawl_runs._plan", return_value={"items": items}):
        assert observed_login_plan(kb, base_url="https://bank.example.test/", profile_id="QA") is None


def test_linked_login_requires_environment_trust_and_observed_screen():
    kb, items = _kb("shop.example.test")
    kb.screens["login"]["route"] = "https://identity.example.test/login"
    with patch("app.services.journeys.crawl_runs._plan", return_value={"items": items}), \
         patch("app.services.journeys.store.automation_profile", return_value={
             "trusted_auth_origins": {"RC": ["https://identity.example.test"]}}):
        assert observed_login_plan(kb, base_url="https://shop.example.test/", profile_id="QA",
                                   environment="SIT") is None
        plan = observed_login_plan(kb, base_url="https://shop.example.test/", profile_id="QA",
                                   environment="RC")
        assert plan and plan["login_origin"] == "https://identity.example.test"
        kb.screens["login"]["route"] = "https://other.example.test/login"
        assert observed_login_plan(kb, base_url="https://shop.example.test/", profile_id="QA",
                                   environment="RC") is None


def test_namespaced_ready_profile_is_reused_only_when_unique_and_exact():
    profile = {"kind": "vault", "fields": [
        {"name": "Username", "variable": "TESTDATA_SETUP_A_USERNAME"},
        {"name": "Password", "variable": "TESTDATA_SETUP_A_PASSWORD"}]}
    kb = SimpleNamespace(automation_app_id="shop", roles={"test_data_profiles": {"A": profile}})
    def resolved(_entries, _environment, variables):
        return {"missing": [], "matches": {variable: "setup_a." + variable.rsplit("_", 1)[-1].lower()
                                           for variable in variables}}
    with patch("app.services.automation.test_data.find_app", return_value=SimpleNamespace(entries=[])), \
         patch("app.services.automation.test_data.resolve", side_effect=resolved):
        assert ready_login_profile(None, kb, "RC") == "A"
        kb.roles["test_data_profiles"]["B"] = profile
        assert ready_login_profile(None, kb, "RC") is None
        assert ready_login_profile(None, kb, "RC", "A") == "A"
        assert ready_login_profile(None, kb, "RC", "missing") is None


def test_login_values_cannot_be_fuzzily_borrowed_from_another_identity():
    variables = ["TESTDATA_SETUP_A_USERNAME", "TESTDATA_SETUP_A_PASSWORD"]
    with patch("app.services.automation.test_data.find_app", return_value=SimpleNamespace(entries=[])), \
         patch("app.services.automation.test_data.resolve", return_value={
             "missing": [], "matches": {variables[0]: "setup_b.username", variables[1]: "setup_b.password"}}):
        assert not login_variables_ready(None, "shop", "RC", variables)


def test_reported_bank_login_journey_has_observed_controls():
    from app.services.journeys import store
    kb = store.load("bank_test")
    assert kb is not None
    plan = observed_login_plan(kb, base_url="https://parabank.parasoft.com/parabank",
                               profile_id="AGENT_CASE_27")
    assert plan and plan["screen_route"] == "/parabank/index.htm"
    assert plan["submit_name"] == "Log In"


def test_discovery_spec_uses_runner_test_data_and_reports_auth_result():
    auth = {"login_url": "https://bank.example.test/login", "username_selector": '[name="username"]',
            "password_selector": '[name="password"]', "submit_name": "Log In"}
    code = build_discovery_spec("https://bank.example.test/", auth=auth, max_pages=2)
    assert "process.env.TESTDATA_USERNAME" in code
    assert "process.env.TESTDATA_PASSWORD" in code
    assert "auth: authResult" in code
    assert "Sign-in success is unverified" in code
    assert "data-discovery-active-overlay" in code
    assert "Observed sign-in link opens a different host" in code
    assert "queue.unshift(next)" in code
    assert "linked_auth: Boolean(entry.linkedAuth)" in code
    assert "if (entry.linkedAuth) pages[pages.length - 1].linked_auth_controls.push(observedControl)" in code
    assert "credentials require a separately approved trust boundary" in code
    assert chr(8) not in code
    assert r"\b(log|sign)" in code
    parsed = subprocess.run(
        ["node", "-e", "require('@babel/parser').parse(require('fs').readFileSync(0,'utf8'), {sourceType:'module'})"],
        input=code, text=True, capture_output=True)
    assert parsed.returncode == 0, parsed.stderr
    assert parse_discovery_output('{"pages":[],"elements":[],"blockers":[],"auth":{"verified":true}}')["auth"]["verified"]
    parsed_linked = parse_discovery_output('{"pages":[{"url":"https://identity.example/login","status":200,"linked_auth":true}],"elements":[],"blockers":[]}')
    assert parsed_linked["pages"][0]["linked_auth"] is True
    same_path = parse_discovery_output('{"pages":[],"blockers":[],"elements":['
        '{"page_url":"https://shop.example/login","role":"textbox","accessible_name":"Username"},'
        '{"page_url":"https://identity.example/login","role":"textbox","accessible_name":"Username"}]}')
    assert len(same_path["elements"]) == 2
    assert is_login_shorthand("Sign in") and not is_login_shorthand("Sign in, then open account")


def test_discovery_spec_reads_selected_profile_variables_not_only_generic_credentials():
    auth = {"login_url": "https://shop.example.test/login",
            "credential_variables": ["TESTDATA_SETUP_A_USERNAME", "TESTDATA_SETUP_A_PASSWORD"],
            "commands": [{"kind": "goto", "url": "https://shop.example.test/login"}]}
    code = build_discovery_spec("https://shop.example.test/", auth=auth, max_pages=2)
    assert "void process.env.TESTDATA_SETUP_A_USERNAME;" in code
    assert "void process.env.TESTDATA_SETUP_A_PASSWORD;" in code
    assert "const requiredAuthValues = [\"TESTDATA_SETUP_A_USERNAME\", \"TESTDATA_SETUP_A_PASSWORD\"]" in code


def test_multi_control_selection_is_split_for_observed_mapping():
    from app.services.automation.agent_journey import source_steps
    steps = source_steps({"Steps": "1. Sign in. 2. Select account type and funding account. 3. Submit the request."})
    assert "Select account type" in steps
    assert "Select funding account" in steps
