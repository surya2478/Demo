"""Regression checks for discovered CSS selectors in generated specs."""
import unittest

from app.services.automation.compiler import (
    repair_legacy_bare_selectors,
    run_static_gate,
    sanitize_catalog_locator,
)


class LocatorSafetyTests(unittest.TestCase):
    def test_bare_css_becomes_playwright_locator(self):
        self.assertEqual(
            sanitize_catalog_locator('[data-test="username"]'),
            'page.locator("[data-test=\\"username\\"]")',
        )

    def test_existing_playwright_expression_is_kept(self):
        self.assertEqual(
            sanitize_catalog_locator('page.getByRole("button", { name: "Login" })'),
            'page.getByRole("button", { name: "Login" })',
        )

    def test_legacy_generated_line_is_repaired_and_rejected_before_repair(self):
        old = 'await [data-test="username"].fill(customer_username);'
        self.assertTrue(any('CSS selector' in issue.message for issue in run_static_gate(old, 0, 0)))
        fixed = repair_legacy_bare_selectors(old)
        self.assertIn('await page.locator(', fixed)
        self.assertFalse(any('CSS selector' in issue.message for issue in run_static_gate(fixed, 0, 0)))


if __name__ == '__main__':
    unittest.main()
