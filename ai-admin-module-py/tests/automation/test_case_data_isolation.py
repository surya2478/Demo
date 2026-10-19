from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.services.automation import agent_test_data, agent_approval


def suggestion(case_id):
    check = SimpleNamespace(case_id=case_id, source_row={"Steps": "Enter username and password then Login"},
                            steps={"_agent_setup": {"app_key": "demo", "environment": "QA", "application_id": 1}})
    db = Mock()
    db.get.return_value = SimpleNamespace(test_data_requirements=[])
    db.query.return_value.filter.return_value.order_by.return_value.first.return_value = SimpleNamespace(explored_pages=["/login"])
    mapping = ([{"action": "Enter username", "screen_id": "login", "element_id": "user"}],
               {"login": {"elements": [{"element_id": "user", "label": "Username"}]}}, [])
    with patch.object(agent_test_data, "_check", return_value=check), \
         patch.object(agent_test_data.store, "load", return_value=SimpleNamespace()), \
         patch.object(agent_test_data.test_data, "find_app", return_value=SimpleNamespace()), \
         patch("app.services.journeys.workspace.test_data_coverage", return_value={"profiles": []}), \
         patch.object(agent_test_data.agent_journey, "observed_mapping", return_value=mapping):
        return agent_test_data.suggestion(db, "batch", case_id)


def test_case_profiles_do_not_share_value_keys():
    positive, negative = suggestion(32), suggestion(33)
    assert positive["fields"][0]["variable"] == "TESTDATA_CASE_32_USERNAME"
    assert negative["fields"][0]["variable"] == "TESTDATA_CASE_33_USERNAME"
    assert positive["recommended_profile_id"] is None


def test_login_without_model_requirements_is_not_synthetic_safe():
    assert not suggestion(32)["synthetic_safe"]
    assert suggestion(32)["requires_existing_account"]


def test_data_hold_exposes_repair_instead_of_hiding_behind_mapping():
    check = SimpleNamespace(id=1, case_id=2, batch_id="batch", steps={
        "_agents": {"navigation_guide": {"status": "needs_approval", "change_set_ids": [3]}}})
    case = SimpleNamespace(test_data_status="not_required")
    db = Mock()
    db.get.side_effect = lambda model, key: case if key == 2 else SimpleNamespace(id=3)
    with patch.object(agent_approval, "_reuse_ready_data", return_value=None), \
         patch.object(agent_approval, "audit", return_value=["Input steps need a ready Test Data profile before automatic approval."]):
        result = agent_approval.decide_pending(db, check, actor="test")
    assert result["held"]
    assert case.test_data_status == "pending"
    assert "Test Data" in case.test_data_notes
