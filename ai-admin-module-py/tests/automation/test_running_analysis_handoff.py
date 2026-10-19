"""Live agent workers enter Analysis while the parent check is running."""
from types import SimpleNamespace
from unittest.mock import Mock, patch
import pytest
from app.services.automation import ai_checks


@pytest.mark.parametrize("status,mode,reference,expected", [
    ("running", "agents", {"capture": "saved"}, True),
    ("running", "agents", None, False),
    ("stopped", "agents", {"capture": "saved"}, False),
    ("running", "kb", {"capture": "saved"}, False),
])
def test_analysis_entry_requires_valid_running_handoff(status, mode, reference, expected):
    check = SimpleNamespace(id=1, case_id=2, batch_id="batch", status=status,
                            steps={"_mode": mode}, source_row={})
    case = SimpleNamespace(application_url="https://example.test", display_id="TC-1", environment=None)
    db = Mock()
    db.get.side_effect = lambda model, key: check if key == 1 else case
    with patch.object(ai_checks, "SessionLocal", return_value=db), \
         patch.object(ai_checks, "_stopping", return_value=False), \
         patch.object(ai_checks, "_resolve_application", return_value=(None, "demo")), \
         patch.object(ai_checks, "_set_step"), patch.object(ai_checks, "_fail"), \
         patch("app.services.automation.agent_reviews.run_queued", side_effect=lambda name, operation, **kw: operation()), \
         patch.object(ai_checks, "refine_case_content", side_effect=RuntimeError("test boundary")) as refine:
        ai_checks._run_check_steps(1, reference_override=reference)
    assert refine.called is expected
