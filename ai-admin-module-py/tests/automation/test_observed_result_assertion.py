"""Final-result assertions must be tied to browser evidence, not guessed locators."""
from unittest.mock import patch

import pytest

from app.models.automation import AutomationTestCase
from app.services.automation.compiler import _observed_result_assertion, compile_playwright
from app.services.journeys import journey_crawl


@pytest.mark.parametrize("url,selector,message", [
    ("https://the-internet.herokuapp.com/login", "//div[@id='flash']", "Your username is invalid!"),
    ("https://shop.example.test/signin", "//p[@role='alert']", "Account not found"),
])
def test_unique_observed_alert_on_exact_host_and_screen(url, selector, message):
    evidence = {"url": url, "assertion_controls": [{"kind": "alert", "text": message, "selector": selector}]}
    result = _observed_result_assertion("Observe the error", "alerts", f"Alert '{message}' is visible",
                                        "Login remains unsuccessful", url, evidence)
    assert result and selector in result and "toBeVisible" in result
    assert _observed_result_assertion("Observe the error", "alerts", f"Alert '{message}' is visible",
                                      "Login remains unsuccessful", "https://wrong.example.test/signin", evidence) is None
    assert _observed_result_assertion("Observe the error", "alerts", f"Alert '{message}' is visible",
                                      "Login remains unsuccessful", url.replace("/login", "/other").replace("/signin", "/other"), evidence) is None
    assert _observed_result_assertion("Observe the error", "alerts", f"Alert '{message}' is visible",
                                      "Login remains unsuccessful", url,
                                      {**evidence, "assertion_controls": evidence["assertion_controls"] * 2}) is None


@pytest.mark.parametrize("entry,outcome,alert", [
    ("https://the-internet.herokuapp.com/login", "https://the-internet.herokuapp.com/secure", "Welcome to the secure area"),
    ("https://shop.example.test/signin", "https://shop.example.test/account", "Signed in successfully"),
])
def test_positive_result_requires_same_host_expected_screen_and_unique_controls(entry, outcome, alert):
    expected = f"The page at {outcome} is displayed, the alert '{alert}' is present, and the Logout control is visible"
    evidence = {"url": outcome, "controls": ["Logout"], "controls_truncated": False,
                "assertion_controls": [{"kind": "alert", "text": alert, "selector": "[id='flash']"}]}
    result = _observed_result_assertion("Observe login result", "Account", expected, expected, entry, evidence)
    assert result and "toHaveURL" in result and "[id='flash']" in result and "Logout" in result
    assert _observed_result_assertion("Observe login result", "Account", expected, expected, entry,
                                      {**evidence, "url": outcome.replace("/secure", "/other").replace("/account", "/other")}) is None
    assert _observed_result_assertion("Observe login result", "Account", expected, expected, entry,
                                      {**evidence, "url": "https://wrong.example.test/account"}) is None
    assert _observed_result_assertion("Observe login result", "Account", expected, expected, entry,
                                      {**evidence, "controls": ["Logout", "Logout"]}) is None


def test_negative_control_assertion_uses_requirement_and_complete_visible_survey():
    url = "https://the-internet.herokuapp.com/login"
    evidence = {"url": url, "controls": ["Login", "Help"], "controls_truncated": False}
    result = _observed_result_assertion("Observe whether the Logout control is absent", "unrelated_link",
                                        "An unrelated link is not displayed",
                                        "The Logout control is not displayed", url, evidence)
    assert result and 'getByText("Logout"' in result and "toBeHidden" in result
    assert _observed_result_assertion("Observe whether the Logout control is absent", "unrelated_link", "",
                                      "The Logout control is not displayed", url,
                                      {**evidence, "controls": ["Logout"]}) is None
    assert _observed_result_assertion("Observe whether the Logout control is absent", "unrelated_link", "",
                                      "The Logout control is not displayed", url,
                                      {**evidence, "controls_truncated": True}) is None


def test_compiler_corrects_refined_assertion_only_with_observed_result():
    url = "https://the-internet.herokuapp.com/login"
    case = AutomationTestCase(display_id="TC-NEG", description="Invalid login", objective="Invalid login",
                              application_url=url,
                              expected_result="Authentication remains unsuccessful and the Logout control is not displayed.",
                              steps_structured=[
                                  {"step_number": 1, "action": "Observe whether an invalid username error appears",
                                   "action_type": "assert", "target": "alerts", "expected_result": "Alert 'Your username is invalid!' is visible"},
                                  {"step_number": 2, "action": "Observe whether the Logout control is absent",
                                   "action_type": "assert", "target": "link_elemental_selenium", "expected_result": "An unrelated link is not displayed"},
                              ])
    evidence = {"url": url, "alerts": ["Your username is invalid!"], "headings": ["Login Page"],
                "controls": ["Login"], "controls_truncated": False,
                "assertion_controls": [{"kind": "alert", "text": "Your username is invalid!", "selector": "//div[@id='flash']"}]}
    with patch("app.services.automation.knowledge_base.ground_case_structured_steps", return_value=case.steps_structured):
        script = compile_playwright(case, base_url=url, outcome_observation=evidence)
    assert not script.unresolved
    assert "//div[@id='flash']" in script.code
    assert 'getByText("Logout"' in script.code
    assert "link_elemental_selenium" not in script.code


def test_crawl_spec_records_final_observation_with_redaction():
    spec = journey_crawl.build_spec({"items": [], "screens": {}, "variables": ["TESTDATA_USERNAME"],
                                     "base_url": "https://example.test/login"})
    assert "outcome_observation: outcomeObservation" in spec
    assert "redactSnapshot(await page.evaluate(outcomeSnapshot))" in spec
    browser_function = spec.split("function outcomeSnapshot()", 1)[1].split("function redactSnapshot", 1)[0]
    assert "uniqueXPath(" not in browser_function  # Node-side helpers are unavailable inside page.evaluate.
