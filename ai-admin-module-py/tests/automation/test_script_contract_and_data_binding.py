from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.models.automation import AutomationTestCase
from app.services.automation import compiler, test_data


def _case(url, value):
    return AutomationTestCase(
        display_id="TC-LOGIN", objective="Login", application_url=url,
        environment="PREPRODUCTION",
        steps_structured=[
            {"step_number": 1, "action": f"Enter username {value} into the username field",
             "action_type": "fill", "target": '[id="username"]',
             "expected_result": f"The username field contains '{value}'"},
        ],
    )


@pytest.mark.parametrize("url,value", [
    ("https://the-internet.herokuapp.com/login", "tomsmith"),
    ("https://shop.example.test/signin", "demo-shop-user"),
])
def test_exact_case_value_links_to_own_app_vault(url, value):
    case = _case(url, value)
    entry = SimpleNamespace(environment="PREPRODUCTION", key="login.username", value=value,
                            is_secret=False, aliases=None)
    app = SimpleNamespace(entries=[entry])
    with patch.object(test_data, "find_app", return_value=app):
        bound = test_data.bind_observed_case_values(None, case)
    assert bound[0]["test_data_ref"] == "login.username"


def test_wrong_app_or_missing_value_does_not_invent_data_link():
    case = _case("https://shop.example.test/signin", "shop-user")
    other_app = SimpleNamespace(entries=[SimpleNamespace(environment="PREPRODUCTION", key="login.username",
                                                         value="other-user", is_secret=False, aliases=None)])
    with patch.object(test_data, "find_app", return_value=other_app):
        assert not test_data.bind_observed_case_values(None, case)[0].get("test_data_ref")


def test_selector_attribute_never_becomes_fill_value_and_missing_data_blocks_run():
    case = _case("https://shop.example.test/signin", "shop-user")
    with patch("app.services.automation.knowledge_base.ground_case_structured_steps", return_value=case.steps_structured):
        script = compiler.compile_playwright(case, base_url=case.application_url)
    assert '.fill("username")' not in script.code
    assert not script.gate_result()["passed"]
    assert any("not linked to Test Data" in error for error in script.gate_result()["errors"])


def test_stored_false_positive_is_refused_before_run():
    case = _case("https://the-internet.herokuapp.com/login", "tomsmith")
    code = '''await test.step("1. Enter username", async () => {
      await page.locator('[id="username"]').fill("username");
    });'''
    assert any("differs from the approved value" in issue.message
               for issue in compiler.validate_case_contract(code, case))
