"""A generated browser spec must open its bound application before touching controls."""
import unittest
from unittest.mock import patch

from app.models.automation import AutomationTestCase
from app.services.automation.compiler import compile_playwright


class EntryNavigationTests(unittest.TestCase):
    def _case(self, steps):
        return AutomationTestCase(
            display_id="TC-LOGIN", description="Sign in", objective="Sign in",
            application_url="https://example.test/app/index.htm",
            steps_structured=steps,
        )

    def test_fill_first_opens_bound_entry_page(self):
        case = self._case([{"step_number": 1, "action": "Enter username", "action_type": "fill",
                            "target": "[name=username]", "test_data_ref": "username"}])
        with patch("app.services.automation.knowledge_base.ground_case_structured_steps", return_value=case.steps_structured):
            code = compile_playwright(case).code
        self.assertIn('await navigateTo(page, "/app/index.htm", null);', code)
        self.assertLess(code.index('await navigateTo(page, "/app/index.htm", null);'), code.index('test.step("1. Enter username"'))

    def test_explicit_first_navigation_is_not_duplicated(self):
        case = self._case([{"step_number": 1, "action": "Navigate to account page", "action_type": "navigate",
                            "target": "/app/account.htm"}])
        with patch("app.services.automation.knowledge_base.ground_case_structured_steps", return_value=case.steps_structured):
            code = compile_playwright(case).code
        self.assertNotIn('await navigateTo(page, "/app/index.htm", null);', code)


if __name__ == "__main__":
    unittest.main()
