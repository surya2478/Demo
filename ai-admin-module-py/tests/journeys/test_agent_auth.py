from types import SimpleNamespace

from app.services.automation.agent_auth import gap_message, requires_signed_in_browser


def test_bank_account_case_does_not_treat_stored_credentials_as_browser_evidence():
    row = {"Preconditions": "Customer is signed in and has an eligible funding account"}
    discovery = SimpleNamespace(auth_status="not_required", blockers=[
        {"url": "https://bank.example.test/accounts/open", "reason": "HTTP 500"}])
    message = gap_message(row=row, actions=["Sign in", "Open New Account"], discovery=discovery,
                          credential_names={"username", "password"}, environment="PREPRODUCTION")
    assert "has username and password" in message
    assert "login is unverified" in message
    assert "Protected account routes were blocked" in message


def test_unrelated_retail_account_case_requires_verified_session_too():
    row = {"Preconditions": "Shopper is authenticated before viewing orders"}
    discovery = SimpleNamespace(auth_status="not_required", blockers=[])
    message = gap_message(row=row, actions=["Open order history"], discovery=discovery,
                          credential_names={"username"}, environment="QA")
    assert "missing password" in message
    assert "anonymous" in message


def test_anonymous_case_and_verified_discovery_are_not_blocked():
    anonymous = {"Preconditions": "Visitor has no account"}
    public = SimpleNamespace(auth_status="not_required", blockers=[])
    assert not requires_signed_in_browser(anonymous, ["Open product catalogue"])
    assert gap_message(row=anonymous, actions=["Open product catalogue"], discovery=public,
                       credential_names=set(), environment="QA") is None
    authenticated = {"Preconditions": "Customer is logged in"}
    verified = SimpleNamespace(auth_status="verified", blockers=[])
    assert gap_message(row=authenticated, actions=["Open account overview"], discovery=verified,
                       credential_names={"username", "password"}, environment="QA") is None
