import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.services.automation import knowledge_base as automation_kb
from app.services.journeys import store


class AutomationBaselineTests(unittest.TestCase):
    def test_first_crawl_gets_empty_app_scoped_profile_without_overwriting_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            kb = store.JourneyKB(
                app_id="new_app", directory=Path(temporary),
                manifest={"app_name": "New App", "automation_app_id": "new_app"},
                taxonomy={}, screens={}, rules={}, roles={}, state_models={},
            )
            with patch.object(automation_kb, "KB_ROOT_DIR", Path(temporary)):
                self.assertTrue(store.ensure_automation_baseline(kb, "https://example.test/start"))
                profile_path = Path(temporary) / "new_app" / "app_profile.json"
                profile = json.loads(profile_path.read_text(encoding="utf-8"))
                self.assertEqual(profile["base_url"], "https://example.test/start")
                self.assertEqual(profile["selectors"], {})
                self.assertFalse(store.ensure_automation_baseline(kb, "https://changed.test"))
                self.assertEqual(json.loads(profile_path.read_text(encoding="utf-8")), profile)
                self.assertFalse((Path(temporary) / "another_app").exists())


if __name__ == "__main__":
    unittest.main()
