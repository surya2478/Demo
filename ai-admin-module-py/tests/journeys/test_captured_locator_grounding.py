import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.services.automation import compiler, healer
from app.services.journeys import store


class CapturedLocatorGroundingTests(unittest.TestCase):
    def setUp(self):
        self.kb = store.load("bank_test")
        self.assertIsNotNone(self.kb)
        self.journey = next(j for j in self.kb.journeys.values() if len(j.get("steps") or []) == 13)
        self.case = SimpleNamespace(
            objective="Verify that a visitor with valid synthetic details can register for online access and receive a confirmation",
            description="",
            steps_raw="",
        )

    def test_compiler_ignores_wrong_keyword_match_and_grounds_all_form_controls(self):
        wrong = store.JourneyMatch(
            self.kb, {"name": "Other journey", "steps": [], "journey_id": "wrong"}, 99, ["register"]
        )
        steps = [
            {"step_number": item["step_number"], "target": item.get("element_id") or "registration page", "action_type": "navigate" if item["step_number"] == 1 else ("click" if item["step_number"] == 13 else "fill")}
            for item in self.journey["steps"]
        ]
        # A title/keyword cannot establish the active screen. Supply the
        # captured navigation URL before asking to ground form controls.
        steps[0]["target"] = "https://parabank.parasoft.com/parabank/register.htm"
        with patch.object(store, "match_journey", return_value=wrong):
            grounded = compiler._ground_with_observed_journey_selectors(
                self.case, steps, "https://parabank.parasoft.com/parabank"
            )
        self.assertEqual(grounded[1]["target"], '[id="customer.firstName"]')
        self.assertEqual(grounded[11]["target"], '[id="repeatedPassword"]')
        self.assertEqual(grounded[12]["target"], 'input[type="submit"][value="Register"]')

    def test_healer_repairs_entire_captured_form_and_value_checks(self):
        labels = ["First Name", "Last Name", "Address", "City", "State", "Zip Code", "Phone", "SSN", "Username", "Password", "Confirm Password"]
        lines = [
            "import { test, expect } from '@playwright/test';",
            "const BASE_URL = 'https://parabank.parasoft.com';",
            "test('registration', async ({ page }) => {",
            "  await page.goto('https://parabank.parasoft.com/parabank/register.htm');",
        ]
        for number, label in enumerate(labels, start=2):
            lines.extend([
                f"  await test.step('{number}. {label}', async () => {{",
                f"    await page.getByLabel('{label}').first().fill(value_{number});",
                "    await expect(page.getByText('sample').first()).toBeVisible({ timeout: 15000 });",
                "  });",
            ])
        lines.extend([
            "  // 13. Click the Register button",
            "  await page.getByRole('link', { name: 'Register' }).click({ force: true }).catch(() => {});",
            "});",
        ])
        code = "\n".join(lines) + "\n"
        repaired = healer._heal_captured_form_locators(
            code,
            "TimeoutError: locator.fill: waiting for getByLabel('First Name').first()",
            "", None, None,
        )
        self.assertIsNotNone(repaired)
        fixed, diagnosis, changes = repaired
        self.assertIn("11 guessed input locators", diagnosis)
        self.assertEqual(len(changes), 12)
        self.assertNotIn("page.getByLabel(", fixed)
        self.assertEqual(fixed.count(".toHaveValue("), 11)
        self.assertIn('page.locator("[id=\\"customer.firstName\\"]").fill(value_2)', fixed)
        self.assertIn('page.locator("input[type=\\"submit\\"][value=\\"Register\\"]").click();', fixed)
        self.assertNotIn("catch(() => {})", fixed)

    def test_unrelated_application_uses_its_own_screen_controls(self):
        other_kb = SimpleNamespace(screens={
            "signup": {"route": "/signup", "elements": [
                {"element_id": "customer_name", "label": "Full Name", "type": "text_input", "observed_selector": "[data-testid=customer-name]"},
                {"element_id": "email_address", "label": "Email Address", "type": "text_input", "observed_selector": "[data-testid=email-address]"},
                {"element_id": "create_account", "label": "Create Account", "type": "button", "observed_selector": "button[data-testid=create-account]"},
            ]},
        })
        foreign_kb = SimpleNamespace(screens={
            "signup": {"route": "/signup", "elements": [
                {"element_id": "customer_name", "label": "Full Name", "type": "text_input", "observed_selector": "[data-testid=wrong-app]"},
            ]},
        })

        def load(app_id):
            return {"shop": other_kb, "foreign": foreign_kb}[app_id]

        def profile(kb):
            return {"base_url": "https://shop.example.test" if kb is other_kb else "https://foreign.example.test"}

        steps = [
            {"action_type": "navigate", "target": "https://shop.example.test/signup"},
            {"action_type": "fill", "target": "customer_name"},
            {"action_type": "fill", "target": "email_address"},
            {"action_type": "click", "target": "create_account"},
        ]
        code = (
            "const BASE_URL = 'https://shop.example.test';\n"
            "await page.goto('https://shop.example.test/signup');\n"
            "await page.getByLabel('Full Name').first().fill(name);\n"
            "await page.getByPlaceholder('Email Address').first().fill(email);\n"
            "await page.getByRole('button', { name: 'Create Account' }).click();\n"
        )
        with patch.object(store, "list_apps", return_value=["shop", "foreign"]), patch.object(store, "load", side_effect=load), patch.object(store, "automation_profile", side_effect=profile):
            grounded = compiler._ground_with_observed_journey_selectors(self.case, steps, "https://shop.example.test")
            repaired = healer._heal_captured_form_locators(code, "TimeoutError: locator.fill", "", None, None)
        self.assertEqual([item["target"] for item in grounded[1:]], [
            "[data-testid=customer-name]", "[data-testid=email-address]", "button[data-testid=create-account]",
        ])
        self.assertIsNotNone(repaired)
        fixed, _, changes = repaired
        self.assertEqual(len(changes), 3)
        self.assertIn('page.locator("[data-testid=customer-name]").fill(name)', fixed)
        self.assertIn('page.locator("[data-testid=email-address]").fill(email)', fixed)
        self.assertIn('page.locator("button[data-testid=create-account]").click()', fixed)
        self.assertNotIn("wrong-app", fixed)

    def test_ambiguous_control_is_not_guessed(self):
        from app.services.automation.control_evidence import Control, choose_control

        controls = [
            Control("Email", "primary_email", "[data-testid=primary]", "text_input", "capture", "/signup"),
            Control("Email", "alternate_email", "[data-testid=alternate]", "text_input", "capture", "/signup"),
        ]
        self.assertIsNone(choose_control("Email", "fill", controls))

    def test_equivalent_discovery_locator_does_not_delay_healing(self):
        from app.services.automation.control_evidence import Control, choose_control

        controls = [
            Control("Full Name", "customer_name", '[id="customer.name"]', "text_input", "journey capture", "/signup"),
            Control("Full Name", "customer_name", "page.locator('[id=\"customer.name\"]')", "textbox", "application discovery", "/signup"),
        ]
        self.assertEqual(choose_control("Full Name", "fill", controls).selector, '[id="customer.name"]')

    def test_audit_flags_guessed_locators_and_wrong_register_link(self):
        from app.services.automation.locator_audit import audit_script

        code = (
            "import { test } from '@playwright/test';\n"
            "test('case', async ({ page }) => {\n"
            "  await page.goto('https://parabank.parasoft.com/parabank/register.htm');\n"
            "  await test.step('2. First Name', async () => {\n"
            "    await page.getByLabel('First Name').first().fill(name);\n"
            "  });\n"
            "  await test.step('3. Register', async () => {\n"
            "    await page.getByRole('link', { name: 'Register' }).click();\n"
            "  });\n"
            "});\n"
        )
        discovered = [{"role": "link", "accessible_name": "Register", "recommended_locator": "page.getByRole('link', { name: 'Register' })", "page_url": "https://parabank.parasoft.com/parabank/register.htm"}]
        audit = audit_script(code, "https://parabank.parasoft.com", discovered)
        self.assertEqual(audit["needs_update"], 2)
        self.assertEqual(audit["matched"], 0)
        self.assertEqual(audit["code_errors"], [])


if __name__ == "__main__":
    unittest.main()
