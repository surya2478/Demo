from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.services.automation.auth_bootstrap import _linked_login_controls, propose, select_controls
from app.services.automation import auth_bootstrap


def test_phone_first_login_is_reported_as_multistep_not_missing_form():
    url = "https://identity.example.test/auth"
    controls = [
        SimpleNamespace(id=1, page_url=url, page_title="Login", role="textbox",
                        accessible_name="Phone number", confidence_score=90),
        SimpleNamespace(id=2, page_url=url, page_title="Login", role="button",
                        accessible_name="Continue", confidence_score=90),
    ]
    with pytest.raises(ValueError, match="multi-step login"):
        select_controls(controls, url)


@pytest.mark.parametrize("app_key", ["shop", "bank"])
def test_selected_phone_profile_is_checked_before_requesting_more_data(app_key):
    kb = SimpleNamespace(roles={"test_data_profiles": {"TEST_PHONE": {
        "kind": "vault", "fields": [{"name": "Mobile number", "variable": "TESTDATA_TEST_PHONE"}]}}})
    setup = {"app_key": app_key, "profile_id": "TEST_PHONE", "environment": "RC"}
    with patch("app.services.automation.test_data.find_app", return_value=SimpleNamespace(entries=[])), \
         patch("app.services.automation.test_data.resolve", return_value={"missing": [], "values": {"TESTDATA_TEST_PHONE": "hidden"}}) as resolved:
        assert auth_bootstrap.selected_phone_data_ready(object(), kb, setup)
        resolved.assert_called_once_with([], "RC", ["TESTDATA_TEST_PHONE"])
    with patch("app.services.automation.test_data.find_app", return_value=SimpleNamespace(entries=[])), \
         patch("app.services.automation.test_data.resolve", return_value={"missing": ["TESTDATA_TEST_PHONE"], "values": {}}):
        assert not auth_bootstrap.selected_phone_data_ready(object(), kb, {**setup, "environment": "SIT"})
    assert not auth_bootstrap.selected_phone_data_ready(None, kb, {**setup, "profile_id": "OTHER"})


def _run(target="https://identity.example.test/login", *, page_status=200):
    return SimpleNamespace(
        application_url="https://shop.example.test/",
        blockers=[{"kind": "linked_auth", "source_url": "https://shop.example.test/",
                   "target_url": target}],
        explored_pages=[{"url": target, "requested_url": target, "status": page_status,
                         "title": "Sign in", "linked_auth": True,
                         "linked_auth_controls": [
                             {"page_url": target, "role": "textbox", "accessible_name": "Username",
                              "recommended_locator": "page.locator('[name=\"username\"]')",
                              "recommended_strategy": "css", "confidence_score": 90}]}],
    )


def test_linked_form_is_only_eligible_for_approved_environment():
    run = _run()
    with patch("app.services.automation.agent_auth.trusted_auth_origins",
               side_effect=lambda _kb, env: {"https://identity.example.test"} if env == "RC" else set()):
        page, controls, linked = _linked_login_controls(run, object(), "RC")
        assert page["url"] == run.explored_pages[0]["url"]
        assert controls[0].accessible_name == "Username"
        assert linked["source_url"] == run.application_url
        with pytest.raises(ValueError, match="not approved"):
            _linked_login_controls(run, object(), "SIT")


def test_blocked_link_never_becomes_a_reusable_login_route():
    with patch("app.services.automation.agent_auth.trusted_auth_origins",
               return_value={"https://identity.example.test"}):
        with pytest.raises(ValueError):
            _linked_login_controls(_run(page_status=403), object(), "RC")


def test_ephemeral_link_is_kept_as_observed_click_not_reusable_route():
    run = _run("https://identity.example.test/login?state=one")
    with patch("app.services.automation.agent_auth.trusted_auth_origins",
               return_value={"https://identity.example.test"}):
        page, _, linked = _linked_login_controls(run, object(), "RC")
        assert page["url"] == linked["target_url"]


@pytest.mark.parametrize("credentials,selected_profile,expected_ready", [
    ({"username", "password"}, None, True), (set(), None, False), (set(), "QA_LOGIN", True)])
@pytest.mark.parametrize("redirected", [False, True])
def test_agent_drafts_login_from_observed_link_and_form_only(credentials, selected_profile, expected_ready, redirected):
    target = "https://identity.example.test/login?state=one"
    run = _run(target)
    run.id = 33
    entry_url = "https://shop.example.test/ecare/d/auth?locale=en"
    if redirected:
        run.blockers[0]["entry_url"] = entry_url
    form = [SimpleNamespace(id=i, page_url=target, page_title="Sign in", role=role,
                            accessible_name=name, element_name="", confidence_score=90,
                            recommended_locator=f"page.locator('[name=\"{name.lower()}\"]')",
                            recommended_strategy="css")
            for i, role, name in ((0, "textbox", "Username"), (1, "textbox", "Password"),
                                  (2, "button", "Login"))]
    link = SimpleNamespace(id=99, discovery_run_id=33, page_url=run.application_url,
                           page_title="Shop", role="link", accessible_name="Sign in",
                           element_name="", href=entry_url if redirected else target, confidence_score=90,
                           recommended_locator="page.getByRole('link', {name:'Sign in'})",
                           recommended_strategy="role")
    kb = SimpleNamespace(screens={}, roles={"test_data_profiles": {"QA_LOGIN": {"kind": "vault"}}})
    saved = SimpleNamespace(origin={})
    db = SimpleNamespace(query=lambda _model: SimpleNamespace(filter=lambda *_args: SimpleNamespace(all=lambda: [link])),
                         get=lambda _model, _id: saved, commit=lambda: None)
    with patch("app.services.automation.agent_auth.trusted_auth_origins",
               return_value={"https://identity.example.test"}), \
         patch("app.services.automation.auth_bootstrap.store.load", return_value=kb), \
         patch("app.services.automation.auth_bootstrap.select_controls", return_value=form), \
         patch("app.services.automation.agent_auth.credential_names_present", return_value=credentials), \
         patch("app.services.automation.agent_auth.ready_login_profile", return_value=selected_profile), \
         patch("app.services.automation.auth_bootstrap.agent_journey.draft_from_case",
               return_value=(7, "LOGIN", [])) as draft:
        assert propose(db, setup={"app_key": "shop", "environment": "RC"},
                       check=SimpleNamespace(case_id=12, requested_by="tester"),
                       discovery=run) == (7, "LOGIN")
    kwargs = draft.call_args.kwargs
    first = kwargs["observed_bindings"][0]
    assert first["element_id"] == "sign_in"
    assert kwargs["observed_screens"][first["screen_id"]]["route"] == "/"
    login_screen = kwargs["observed_bindings"][1]["screen_id"]
    assert kwargs["observed_screens"][login_screen]["route"] == "https://identity.example.test/login"
    assert saved.origin["login_entry_control_id"] == 99
    assert saved.origin["credentials_ready_at_draft"] is expected_ready
    assert kwargs["authentication_profile_id"] == (selected_profile or "AUTH_CASE_12")
    if selected_profile:
        assert kwargs["login_profile"] is None


def test_agent_does_not_draft_without_the_exact_observed_entry_link():
    run = _run()
    run.id = 33
    wrong_link = SimpleNamespace(page_url=run.application_url, role="link",
                                 href="https://other.example.test/login", confidence_score=90,
                                 recommended_locator="page.getByRole('link')")
    db = SimpleNamespace(query=lambda _model: SimpleNamespace(filter=lambda *_args: SimpleNamespace(all=lambda: [wrong_link])))
    with patch("app.services.automation.agent_auth.trusted_auth_origins",
               return_value={"https://identity.example.test"}), \
         patch("app.services.automation.auth_bootstrap.store.load", return_value=SimpleNamespace(screens={}, roles={})), \
         patch("app.services.automation.auth_bootstrap.select_controls", return_value=[SimpleNamespace(
             id=i, page_url=run.explored_pages[0]["url"], accessible_name=name, element_name="",
             recommended_locator="page.locator('[name=\"x\"]')", recommended_strategy="css")
             for i, name in enumerate(("Username", "Password", "Login"))]), \
         patch("app.services.automation.auth_bootstrap.agent_journey.draft_from_case") as draft:
        with pytest.raises(ValueError, match="uniquely observed entry link"):
            propose(db, setup={"app_key": "shop", "environment": "RC"},
                    check=SimpleNamespace(case_id=12, requested_by="tester"), discovery=run)
    draft.assert_not_called()
