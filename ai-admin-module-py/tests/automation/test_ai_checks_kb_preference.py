from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from app.services.automation import ai_checks


def _check(status="failed", mode="agents", reuse=True):
    return SimpleNamespace(status=status, steps={"_mode": mode, "_agent_setup": {
        "app_key": "sample", "environment": "RC", "reuse_kb_evidence": reuse,
    }})


def test_preference_updates_every_case_for_future_retries():
    checks = [_check(), _check(status="done")]
    db = Mock()
    with patch.object(ai_checks, "_batch_checks", return_value=checks), patch.object(ai_checks, "_is_active", return_value=False):
        ai_checks.set_reuse_kb_evidence(db, "batch", False)
    assert all(check.steps["_agent_setup"]["reuse_kb_evidence"] is False for check in checks)
    assert all(check.steps["_agent_setup"]["environment"] == "RC" for check in checks)
    db.commit.assert_called_once()


@pytest.mark.parametrize("statuses,active", [(["running", "failed"], True), (["queued", "done"], False)])
def test_preference_cannot_change_live_or_queued_attempt(statuses, active):
    checks = [_check(status=status) for status in statuses]
    db = Mock()
    with patch.object(ai_checks, "_batch_checks", return_value=checks), patch.object(ai_checks, "_is_active", return_value=active):
        with pytest.raises(ValueError, match="finish or stop"):
            ai_checks.set_reuse_kb_evidence(db, "batch", False)
    assert all(check.steps["_agent_setup"]["reuse_kb_evidence"] for check in checks)
    db.commit.assert_not_called()


def test_preference_rejects_non_agent_batch():
    db = Mock()
    with patch.object(ai_checks, "_batch_checks", return_value=[_check(mode="knowledge_base")]):
        with pytest.raises(ValueError, match="only for agent"):
            ai_checks.set_reuse_kb_evidence(db, "batch", False)
    db.commit.assert_not_called()
