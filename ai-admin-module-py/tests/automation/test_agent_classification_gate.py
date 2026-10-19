"""Browser binding concerns cannot silently become runnable automation."""
import unittest
from unittest.mock import Mock, patch

from app.services.automation.ai_checks import _classify, _unverified_journey_steps
from app.services.automation.workbench import CLASSIFICATION_MANUAL


class AgentClassificationGateTests(unittest.TestCase):
    def test_implicit_login_and_entry_steps_are_not_skipped(self):
        steps = [
            {"step_number": 1, "action": "Open the login page"},
            {"step_number": 2, "action": "Sign in with valid credentials"},
            {"step_number": 3, "action": "Click Log Out", "screen_id": "login", "element_id": "logout"},
        ]
        self.assertEqual(_unverified_journey_steps(steps), ["1", "2"])

    def test_editor_concerns_force_manual_until_rechecked(self):
        check = Mock(steps={"_mode": "agents", "_agents": {"expert_editor": {"concerns": True}}})
        case = Mock(classification="Automation", classification_reason=None, test_data_status="ready",
                    preconditions="", steps_raw="", expected_result="", test_data="", steps_structured=[])
        with patch("app.services.automation.ai_checks.wb.rescore"), \
             patch("app.services.automation.ai_checks.wb.apply_classification"), \
             patch("app.services.automation.ai_checks._set_step"):
            _classify(Mock(), check, case)
        self.assertEqual(case.classification, CLASSIFICATION_MANUAL)
        self.assertIn("unverified", case.classification_reason)


if __name__ == "__main__":
    unittest.main()
