from types import SimpleNamespace
from unittest.mock import patch
import pytest
from app.services.automation import auth_bootstrap, agent_auth


def controls(host):
    return [SimpleNamespace(id=i, page_url=f"https://{host}/login", confidence_score=95,
                            role="button" if i == 3 else "textbox", accessible_name=label,
                            recommended_locator=f"page.locator({selector!r})", recommended_strategy="css")
            for i, label, selector in [(1, "Email", '[id="email"]'), (2, "Password", '[id="password"]'), (3, "Sign In", '[id="submit"]')]]


@pytest.mark.parametrize("host", ["shop.example.test", "portal.example.test"])
def test_fresh_login_selection_accepts_only_observed_ids(host):
    choice = auth_bootstrap.LoginControls(username_id=1, password_id=2, submit_id=3, reason="Observed sign-in form")
    with patch.object(auth_bootstrap.agent_reviews, "run_queued", return_value=choice):
        selected = auth_bootstrap.select_controls(controls(host), f"https://{host}/")
        assert [c.id for c in selected] == [1, 2, 3]


def test_bootstrap_rejects_invented_id_wrong_host_and_ambiguous_controls():
    data = controls("shop.example.test")
    for choice, supplied in [
        (auth_bootstrap.LoginControls(username_id=99, password_id=2, submit_id=3, reason="Missing control"), data),
        (auth_bootstrap.LoginControls(username_id=1, password_id=2, submit_id=3, reason="Wrong host"), controls("other.example.test")),
        (auth_bootstrap.LoginControls(username_id=1, password_id=2, submit_id=3, reason="Ambiguous control"), data + [SimpleNamespace(**{**vars(data[0]), "id": 4, "recommended_locator": '[id="another"]'})]),
    ]:
        with patch.object(auth_bootstrap.agent_reviews, "run_queued", return_value=choice), pytest.raises(ValueError):
            auth_bootstrap.select_controls(supplied, "https://shop.example.test/")


def test_external_success_marker_does_not_fall_back_to_legacy_login():
    from test_authenticated_discovery import _kb
    kb, items = _kb("shop.example.test")
    kb.screens["evil"] = {"route": "//other.example.test/account", "elements": [
        {"element_id": "identity", "label": "Identity", "type": "button", "observed_strategy": "role"}]}
    kb.journeys["LOGIN"]["authentication_success"] = {"screen_id": "evil", "element_id": "identity"}
    with patch("app.services.journeys.crawl_runs._plan", return_value={"items": items}):
        assert agent_auth.observed_login_plan(kb, base_url="https://shop.example.test/", profile_id="QA") is None
