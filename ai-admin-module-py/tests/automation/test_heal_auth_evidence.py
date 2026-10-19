"""Healing must not disguise rejected credentials as a broken logout locator."""
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.routers.automation import EditScriptRequest, _run_auth_rejection, edit_script
from app.services.automation.healer import diagnose_and_heal


class HealAuthEvidenceTests(unittest.TestCase):
    def test_trace_auth_rejection_is_detected(self):
        with tempfile.TemporaryDirectory() as folder:
            artifacts = Path(folder) / "artifacts"
            artifacts.mkdir()
            with zipfile.ZipFile(artifacts / "001-trace.zip", "w") as archive:
                archive.writestr("test.trace", '"text":"The username and password could not be verified."')
            self.assertTrue(_run_auth_rejection(SimpleNamespace(workspace_path=folder)))

    def test_rejected_login_does_not_rewrite_logout_locator(self):
        code = "await page.getByRole('link', { name: 'Log Out' }).click();"
        healed, diagnosis, changes = diagnose_and_heal(
            code=code, error_message="TimeoutError: locator.click waiting for Log Out",
            stack_trace="", authentication_rejected=True,
        )
        self.assertEqual(healed, code)
        self.assertIn("rejected", diagnosis)
        self.assertEqual(changes, [])

    def test_edit_clears_stale_run_step_status(self):
        script = SimpleNamespace(code="old", dry_run_status="failed", dry_run_summary={"failed_step": 4},
                                 dry_run_key="old-run", dry_run_at="yesterday", edited_by_user=False,
                                 framework="playwright", language="typescript", file_name="case.spec.ts",
                                 entry_path="case.spec.ts", execution_command="playwright test")
        db = Mock()
        with patch("app.routers.automation._load_script", return_value=script), \
             patch("app.routers.automation._script_detail", return_value={}), \
             patch("app.routers.automation.compiler.run_static_gate", return_value=[]):
            edit_script(1, EditScriptRequest(code="new"), db=db, current_user={"username": "qa"})
        self.assertEqual(script.dry_run_status, "not_run")
        self.assertIsNone(script.dry_run_summary)
        self.assertIsNone(script.dry_run_key)


if __name__ == "__main__":
    unittest.main()
