"""The Test Assistant review choice controls whether KB grounding is used."""

from unittest.mock import Mock, patch

from fastapi import HTTPException

from app.routers.ai_checks import AgentSetup, StartChecksRequest, start_checks


ROW = {"Test Case ID": "TC-001", "Test Case Description": "Sign in"}


def _start(mode: str, approval_manager_enabled: bool = False):
    setup = AgentSetup(app_key="demo", application_id=4, profile_id="shopper", environment="QA") if mode == "agents" else None
    body = StartChecksRequest(rows=[ROW], knowledge_base="Automation KB", refine_mode=mode,
                              request_id="REQ-1" if setup else None, agent_setup=setup,
                              approval_manager_enabled=approval_manager_enabled)
    db = Mock()
    db.query.return_value.filter.return_value.first.return_value = Mock(project_id=42, generation={})
    db.get.return_value = Mock(is_active=True, app_key="demo")
    with patch("app.routers.ai_checks.ai_checks.start_batch", return_value="batch-1") as start, \
         patch("app.routers.ai_checks.user_has_permission", return_value=True), \
         patch("app.services.journeys.store.load", return_value=Mock()):
        result = start_checks(body, db=db, current_user={"username": "qa"})
    assert result == {"batch_id": "batch-1"}
    return start.call_args.kwargs


def test_knowledge_base_refine_preserves_selected_kb():
    assert _start("knowledge_base")["knowledge_base"] == "Automation KB"


def test_agents_refine_requires_registered_app_and_preserves_setup():
    kwargs = _start("agents")
    assert kwargs["knowledge_base"] is None
    assert kwargs["agent_setup"]["app_key"] == "demo"
    assert kwargs["environment"] == "QA"


def test_approval_manager_choice_is_forwarded_only_for_agents():
    assert _start("agents", True)["approval_manager_enabled"] is True
    assert _start("knowledge_base", True)["approval_manager_enabled"] is False


def test_approval_manager_requires_approval_permission():
    body = StartChecksRequest(rows=[ROW], refine_mode="agents", request_id="REQ-1",
                              agent_setup=AgentSetup(app_key="demo", application_id=4, environment="QA"),
                              approval_manager_enabled=True)
    db = Mock()
    db.query.return_value.filter.return_value.first.return_value = Mock(project_id=42, generation={})
    with patch("app.routers.ai_checks.user_has_permission", side_effect=lambda _user, permission: permission == "automation.execute"):
        try:
            start_checks(body, db=db, current_user={"username": "qa"})
        except HTTPException as exc:
            assert exc.status_code == 403
        else:
            raise AssertionError("Delegated approval must require approval permission")


def test_approval_manager_choice_is_saved_before_batch_launch():
    from app.models.automation import AutomationAICheck
    from app.services.automation import ai_checks

    db = Mock()
    observed = []

    def on_launch(_batch_id):
        checks = [call.args[0] for call in db.add.call_args_list if isinstance(call.args[0], AutomationAICheck)]
        observed.extend(checks)

    with patch.object(ai_checks, "_launch", side_effect=on_launch):
        ai_checks.start_batch(db, [ROW], actor="qa", agent_setup={"app_key": "demo"}, approval_manager_enabled=True)
    assert observed[0].steps["_agent_auto_approval"] == {"scope": "batch", "requested_by": "qa"}


def test_agents_refine_rejects_missing_setup():
    body = StartChecksRequest(rows=[ROW], refine_mode="agents")
    db = Mock()
    with patch("app.routers.ai_checks.user_has_permission", return_value=True):
        try:
            start_checks(body, db=db, current_user={"username": "qa"})
        except HTTPException as exc:
            assert exc.status_code == 400
        else:
            raise AssertionError("Agents Refine must not start without a saved project and application")


def test_agent_setup_survives_retry_reset():
    from app.services.automation.ai_checks import _reset

    check = Mock()
    check.steps = {"refine": "failed", "_mode": "agents", "_agent_setup": {"app_key": "demo"},
                   "_agents": {"automation": {"status": "failed"}}}
    _reset(check)
    assert check.steps["_agent_setup"] == {"app_key": "demo"}
    assert check.steps["_agents"]["automation"]["status"] == "waiting"
    assert check.steps["refine"] == "pending"


def test_full_restart_drops_stage_resume_and_stale_handoff():
    from app.services.automation.ai_checks import _reset

    check = Mock()
    check.steps = {"refine": "failed", "_mode": "agents",
                   "_agent_setup": {"app_key": "bank_test", "environment": "PREPRODUCTION"},
                   "_agent_auto_approval": {"scope": "batch"},
                   "_agent_resume_stage": "navigation_guide",
                   "_agent_resume_analysis": {"crawl_id": 45},
                   "_agent_plan": {"journey_id": "stale"},
                   "_sent_unverified": True,
                   "_agents": {"requirements_guide": {"status": "done"},
                               "navigation_guide": {"status": "failed"}}}
    _reset(check)
    assert check.steps["_agents"]["requirements_guide"]["status"] == "waiting"
    assert check.steps["_agent_setup"]["app_key"] == "bank_test"
    assert check.steps["_agent_auto_approval"] == {"scope": "batch"}
    assert "_agent_resume_stage" not in check.steps
    assert "_agent_resume_analysis" not in check.steps
    assert "_agent_plan" not in check.steps
    assert "_sent_unverified" not in check.steps
