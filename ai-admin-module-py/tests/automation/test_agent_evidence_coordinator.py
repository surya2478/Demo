from pydantic import ValidationError
import pytest

from app.services.automation.agent_evidence_coordinator import EvidenceTriage, actionable_pre_execution


@pytest.mark.parametrize("host", ["the-internet.herokuapp.com", "www.saucedemo.com"])
def test_final_observation_cannot_block_ready_plan_on_unrelated_apps(host):
    plan = [
        {"step": 1, "kind": "fill", "screen_id": f"{host}/login", "element_id": "username", "has_data": True},
        {"step": 2, "kind": "click", "screen_id": f"{host}/login", "element_id": "login", "has_data": False},
    ]
    hold = EvidenceTriage(phase="post_execution", step_number=None,
                          reason="Final alert and page URL require browser replay")
    assert not actionable_pre_execution(hold, plan, {"ready": True})
    mistaken = EvidenceTriage(phase="pre_execution", step_number=2,
                              reason="Final alert is not yet observed")
    assert not actionable_pre_execution(mistaken, plan, {"ready": True})


def test_missing_control_or_data_remains_blocked():
    plan = [{"step": 2, "kind": "fill", "element_id": None, "has_data": False}]
    hold = EvidenceTriage(phase="pre_execution", step_number=2,
                          reason="Step two has no observed field or Test Data")
    assert actionable_pre_execution(hold, plan, {"ready": False})
    assert actionable_pre_execution(hold, plan, {"ready": True})
    with pytest.raises(ValidationError):
        EvidenceTriage(phase="post_execution", step_number=None,
                       reason="Try another host", locator="[id=made-up]")
