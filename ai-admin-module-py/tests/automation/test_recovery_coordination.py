import json
from types import SimpleNamespace
from unittest.mock import patch, Mock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.services.automation import recovery_coordination as recovery, ai_checks, agent_reviews, check_leases
from app.models.automation import AutomationAICheckLease


def check():
    return SimpleNamespace(source_row={"Steps": "Sign in"}, steps={"_mode": "agents", "_agent_setup": {
        "app_key": "shop", "environment": "QA", "profile_id": "qa"}})


def test_failed_reviewer_settles_parent_without_erasing_evidence():
    agents = {"navigation_guide": {"status": "working", "events": [{"message": "12 pages captured"}]},
              "expert_editor": {"status": "failed"}, "crawl_guide": {"status": "done"}}
    settled = ai_checks._settle_active_agents(agents, "expert_editor")
    assert settled["navigation_guide"]["status"] == "waiting"
    assert settled["navigation_guide"]["events"] == agents["navigation_guide"]["events"]
    assert settled["expert_editor"]["status"] == "failed"
    assert settled["crawl_guide"]["status"] == "done"
    assert agents["navigation_guide"]["status"] == "working"


def test_long_recovery_explanation_does_not_discard_valid_action():
    advice = recovery.RecoveryAdvice(action='recapture', reason='Observed controls are missing. ' * 40)
    assert advice.action == 'recapture'
    assert len(advice.reason) == 600
    with pytest.raises(ValueError):
        recovery.RecoveryAdvice(action='invent_locator', reason='x' * 1000)


@pytest.mark.parametrize("message,category,action", [
    ("OpenRouter returned 429", "transient", "retry_stage"),
    ("daily quota reached", "provider_configuration", "request_input"),
    ("The application rejected the configured sign-in data", "authentication_or_data", "request_input"),
    ("Playwright dict has no attribute run_key", "software_contract", "repair_code"),
    ("browser runtime is unavailable", "runtime", "refresh_runtime"),
    ("Navigation held the proposed mapping", "missing_evidence", "recapture"),
    ("Expert Editor omitted or duplicated step decisions", "model_contract", "retry_stage"),
])
def test_recovery_routes_real_cause(message, category, action):
    assert recovery.classify(message) == (category, action)


def test_repair_budget_and_scope_are_persisted_not_model_controlled():
    item = check()
    advice = recovery.RecoveryAdvice(action="recapture", reason="Refresh observed controls")
    for attempt in range(1, 4):
        entry = recovery.record_failure(item, "navigation_guide", "missing controls")
        assert entry["attempt"] == attempt
        assert recovery.allowed(entry, advice) == (attempt == 1)
        if attempt == 1:
            item.steps["_recovery_history"][-1]["status"] = "retrying"
    item.steps["_agent_setup"]["environment"] = "SIT"
    assert recovery.record_failure(item, "navigation_guide", "missing controls")["attempt"] == 1
    invalid = recovery.record_failure(item, "navigation_guide", "invalid credential")
    assert not recovery.allowed(invalid, advice)


def test_new_missing_step_can_recover_once_without_reopening_exhausted_step():
    item = check()
    advice = recovery.RecoveryAdvice(action="recapture", reason="Capture the missing step")
    old = recovery.record_failure(item, "navigation_guide", "Step 1 has no observed control")
    item.steps["_recovery_history"][-1]["status"] = "retrying"
    assert recovery.allowed(old, advice)
    assert not recovery.allowed(
        recovery.record_failure(item, "navigation_guide", "Step 1 still has no observed control"), advice)
    new = recovery.record_failure(item, "navigation_guide", "Step 4 has no observed control")
    assert new["gap"] == "steps:4"
    assert new["recaptures_used"] == 0
    assert recovery.allowed(new, advice)
    item.steps["_recovery_history"][-1]["status"] = "retrying"
    assert not recovery.allowed(
        recovery.record_failure(item, "navigation_guide", "Step 4 still has no observed control"), advice)


def test_total_recapture_cap_prevents_unbounded_new_step_scans():
    item = check()
    advice = recovery.RecoveryAdvice(action="recapture", reason="Capture the missing step")
    for step in (1, 2, 3):
        entry = recovery.record_failure(item, "navigation_guide", f"Step {step} has no observed control")
        assert recovery.allowed(entry, advice)
        item.steps["_recovery_history"][-1]["status"] = "retrying"
    fourth = recovery.record_failure(item, "navigation_guide", "Step 4 has no observed control")
    assert not recovery.allowed(fourth, advice)


def test_recovery_gap_ignores_correctly_mapped_steps_and_expands_missing_range():
    message = ("Steps 2, 3, and 4 lack screen_id mappings. "
               "Step 1 is correctly mapped with null element_id as required for URL opening. "
               "Steps 2-4 have no observed controls.")
    assert recovery._gap_key(message) == "steps:2,3,4"
    assert recovery._gap_key(
        "Steps 1-3 have verified mappings (Step 1 URL open, Step 2 link, Step 3 tab), "
        "but Step 4 lacks an observed element reference.") == "steps:4"


def test_full_restart_keeps_lessons_but_not_stage_resume_or_side_effect_permission():
    item = check()
    recovery.record_failure(item, "navigation_guide", "missing controls")
    item.steps["_agent_resume_stage"] = "navigation_guide"
    item.steps["_agent_setup"]["allow_risky_once"] = True
    ai_checks._reset(item)
    assert len(item.steps["_recovery_history"]) == 1
    assert "_agent_resume_stage" not in item.steps
    assert "allow_risky_once" not in item.steps["_agent_setup"]


def test_evidence_packets_do_not_drop_final_contradiction():
    evidence = {"steps": [{"id": i, "detail": "x" * 100} for i in range(200)]}
    packets = agent_reviews.evidence_packets(evidence, limit=1500)
    assert [step["id"] for packet in packets for step in packet["steps"]] == list(range(200))
    assert all(len(json.dumps(packet)) <= 1500 for packet in packets)
    with pytest.raises(agent_reviews.AgentReviewError, match="no evidence was discarded"):
        agent_reviews.evidence_packets({"unbounded": "x" * 20000})


def test_nested_browser_evidence_is_partitioned_without_losing_records():
    evidence = {'context': {'navigation': [{'trace': [{'id': i, 'detail': 'x' * 100} for i in range(80)]}]} }
    packets = agent_reviews.evidence_packets(evidence, limit=1500)
    assert [row['id'] for packet in packets for row in packet['context']['navigation'][0]['trace']] == list(range(80))
    assert len(evidence['context']['navigation'][0]['trace']) == 80


def test_batch_lease_excludes_second_worker_and_wrong_owner(tmp_path):
    engine = create_engine("sqlite:///" + str(tmp_path / "leases.db"))
    AutomationAICheckLease.__table__.create(engine)
    with patch.object(check_leases, "SessionLocal", sessionmaker(bind=engine)):
        owner = check_leases.acquire("batch")
        assert owner and check_leases.active("batch")
        assert check_leases.acquire("batch") is None
        assert not check_leases.renew("batch", "other")
        check_leases.release("batch", "other")
        assert check_leases.active("batch")
        check_leases.release("batch", owner)
        assert not check_leases.active("batch")
        assert check_leases.acquire("batch")


def test_handoff_includes_prerequisites_and_late_controls_in_large_kb():
    journey = {"journey_id": "MAIN", "steps": [{"screen_id": "screen49", "element_id": "element59"}]}
    login = {"journey_id": "LOGIN", "steps": [{"screen_id": "login"}]}
    kb = SimpleNamespace(screens={f"screen{i}": {"route": f"/{i}", "elements": [
        {"element_id": f"element{j}", "label": f"Control {j}", "type": "button"} for j in range(60)]} for i in range(50)})
    kb.screens["login"] = {"route": "/login", "elements": []}
    with patch("app.services.journeys.store.journey_chain", return_value=[login, journey]):
        evidence = ai_checks.approved_review_evidence(kb, journey, ["Sign in", "Open control"])
    assert evidence["prerequisites"][0]["journey_id"] == "LOGIN"
    assert len(evidence["screens"]) == 2
    assert evidence["screens"][0]["elements"][-1]["id"] == "element59"


def test_editor_recovery_preserves_its_failed_stage_retry_without_calling_exhausted_provider():
    item = check()
    item.id, item.batch_id, item.status = 1, "batch", "failed"
    item.steps["_agents"] = {"expert_editor": {"status": "failed"}}
    recovery.record_failure(item, "expert_editor", "OpenRouter daily quota reached")
    db = Mock()
    db.get.return_value = item
    with patch.object(ai_checks, "SessionLocal", return_value=db), patch.object(ai_checks, "_run_check"), \
         patch.object(ai_checks, "_stopping", return_value=False), patch.object(recovery, "decide") as decide:
        ai_checks._run_with_recovery(1)
    decide.assert_not_called()
    assert item.steps["_agents"]["expert_editor"]["status"] == "failed"
    assert item.steps["_recovery_history"][-1]["status"] == "needs_input"
