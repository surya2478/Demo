from types import SimpleNamespace
from unittest.mock import patch
import subprocess
from app.services.automation import agent_journey, expert_editor
from app.services.journeys import journey_crawl


def test_select_action_preserves_control_type_and_requires_explicit_test_data():
    control = SimpleNamespace(role="combobox", accessible_name="Delivery method", element_name="delivery",
                              recommended_strategy="css", recommended_locator="page.locator('[id=\"delivery\"]')")
    element = agent_journey._element(control)
    assert element["type"] == "dropdown"
    assert expert_editor._role_allowed("Choose delivery method", "combobox")
    # "Select" can activate a link too; observed label/screen matching still
    # decides which concrete control is valid, not the verb alone.
    assert expert_editor._role_allowed("Select delivery method", "link")
    journey = {"journey_id": "DELIVERY", "name": "Delivery", "steps": [
        {"step_number": 1, "action": "Choose delivery method", "screen_id": "delivery", "element_id": "delivery"}]}
    kb = SimpleNamespace(app_id="shop", journeys={"DELIVERY": journey}, screens={"delivery": {
        "screen_id": "delivery", "name": "Delivery", "route": "/delivery", "elements": [element]}},
        roles={"test_data_profiles": {"QA": {"fields": [{"name": "Delivery method", "variable": "TESTDATA_DELIVERY"}]}}})
    with patch("app.services.journeys.store.journey_chain", return_value=[journey]):
        plan = journey_crawl.build_plan(kb, "DELIVERY", automation_profile={}, base_url="https://shop.example.test", profile_id="QA")
        assert plan["items"][0]["kind"] == "select"
        assert plan["items"][0]["variable"] == "TESTDATA_DELIVERY"
        code = journey_crawl.build_spec(plan)
        parsed = subprocess.run(["node", "-e", "require('@babel/parser').parse(require('fs').readFileSync(0,'utf8'),{sourceType:'module'})"], input=code, text=True, capture_output=True)
        assert parsed.returncode == 0, parsed.stderr
        kb.roles = {}
        plan = journey_crawl.build_plan(kb, "DELIVERY", automation_profile={}, base_url="https://shop.example.test", profile_id=None)
        assert plan["items"][0]["kind"] == "capture"
        assert "names no value" in plan["items"][0]["reason"]
