"""Stage retries preserve prior handoffs and reject invalid checkpoints."""
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.models.automation import AutomationAICheck, AutomationApplication, AutomationTestCase
from app.models.kb_changes import KbChangeSet, KbCrawlRun
from app.services.automation import ai_checks


def _check(stage):
    return SimpleNamespace(
        id=12, batch_id="batch", case_id=13, status="failed", error="failed",
        finished_at=None, source_row={"Test Case Description": "Open cart"},
        steps={"_mode": "agents", "refine": "done", "review": "failed",
               "_agent_setup": {"app_key": "shop", "application_id": 8, "environment": "QA"},
               "_agents": {"requirements_guide": {"status": "done"},
                           "navigation_guide": {"status": "done"},
                           "automation": {"status": "done", "crawl_id": 45},
                           "analysis": {"status": "done"}, stage: {"status": "failed"}}},
    )


def test_editor_publication_wait_resolves_only_after_all_drafts_published():
    check = _check("expert_editor")
    check.status = "done"
    check.steps["_agents"]["expert_editor"]["status"] = "needs_approval"
    check.steps["_agents"]["data_entry"] = {"status": "done", "change_set_ids": [1, 2]}
    db = Mock()
    db.get.side_effect = [SimpleNamespace(status="published"), SimpleNamespace(status="draft")]
    ai_checks._complete_published_editor(db, check)
    assert check.steps["_agents"]["expert_editor"]["status"] == "needs_approval"
    db.get.side_effect = [SimpleNamespace(status="published"), SimpleNamespace(status="published")]
    ai_checks._complete_published_editor(db, check)
    assert check.steps["_agents"]["expert_editor"]["status"] == "done"


def test_navigation_retry_preserves_requirements_and_clears_stale_plan():
    check = _check("navigation_guide")
    check.steps["_agent_plan"] = {"change_set_id": 4}
    db = Mock()
    with patch.object(ai_checks, "_get_check", return_value=check), \
         patch.object(ai_checks, "_is_active", return_value=False), \
         patch.object(ai_checks, "_launch") as launch:
        ai_checks.retry_agent_stage(db, "batch", 12, "navigation_guide")
    assert check.status == "queued"
    assert check.steps["_agent_resume_stage"] == "navigation_guide"
    assert check.steps["_agents"]["requirements_guide"]["status"] == "done"
    assert "_agent_plan" not in check.steps
    launch.assert_called_once_with("batch", [12])


def test_editor_contract_failure_retries_unpublished_navigation_checkpoint():
    check = _check("expert_editor")
    check.steps["_agents"]["navigation_guide"] = {"status": "working"}
    db = Mock()
    with patch.object(ai_checks, "_get_check", return_value=check), \
         patch.object(ai_checks, "_is_active", return_value=False), \
         patch.object(ai_checks, "_launch") as launch:
        ai_checks.retry(db, "batch", 12)
    assert check.status == "queued"
    assert check.steps["_agent_resume_stage"] == "navigation_guide"
    assert check.steps["_agents"]["requirements_guide"]["status"] == "done"
    launch.assert_called_once_with("batch", [12])


def test_stopped_browser_replay_resumes_without_discarding_navigation():
    check = _check('automation')
    check.status = 'stopped'
    check.steps['_agents']['automation']['status'] = 'working'
    check.steps['_agent_plan'] = {'journey_id': 'SHOP.GUEST', 'change_set_id': 42}
    check.steps['_agents']['navigation_guide']['journey_id'] = 'SHOP.GUEST'
    db = Mock()
    with patch.object(ai_checks, '_get_check', return_value=check), \
         patch.object(ai_checks, '_is_active', return_value=False), \
         patch.object(ai_checks, '_published_journey_checkpoint', return_value='SHOP.GUEST'), \
         patch('app.services.journeys.store.describe', return_value={'grounded': False}), \
         patch('app.services.journeys.store.load', return_value=SimpleNamespace(journeys={'SHOP.GUEST': {}})), \
         patch.object(ai_checks, '_launch') as launch:
        ai_checks.retry(db, 'batch', 12)
    assert check.steps['_agent_resume_stage'] == 'automation'
    assert check.steps['_agent_plan']['change_set_id'] == 42
    launch.assert_called_once_with('batch', [12])


def test_editor_retry_reuses_completed_capture_after_one_shot_forced_scan():
    check = _check("expert_editor")
    check.steps["_agents"]["navigation_guide"] = {"status": "working", "discovery_id": 53}
    check.steps["_force_discovery"] = True
    run = SimpleNamespace(status="completed", application_id=8, application_environment="QA")
    db = Mock()
    db.get.return_value = run
    with patch.object(ai_checks, "_get_check", return_value=check), \
         patch.object(ai_checks, "_is_active", return_value=False), \
         patch.object(ai_checks, "_launch"):
        ai_checks.retry(db, "batch", 12)
    assert "_force_discovery" not in check.steps
    assert check.steps["_agent_resume_stage"] == "navigation_guide"


def test_editor_retry_preserves_published_expanded_journey():
    check = _check("expert_editor")
    check.steps["_agents"]["navigation_guide"] = {"status": "working"}
    check.steps["_agent_plan"] = {"change_set_id": 42, "journey_id": "SHOP.GUEST"}
    with patch.object(ai_checks, "_get_check", return_value=check), \
         patch.object(ai_checks, "_published_journey_checkpoint", return_value=True), \
         patch.object(ai_checks, "retry_agent_stage") as resume:
        ai_checks.retry(Mock(), "batch", 12)
    resume.assert_called_once_with(resume.call_args.args[0], "batch", 12,
                                   "expert_editor", _retain_published_plan=True)
    assert check.steps["_agent_plan"]["change_set_id"] == 42


def test_crawl_guide_retry_keeps_requirements_and_restarts_downstream_only():
    check = _check("crawl_guide")
    db = Mock()
    with patch.object(ai_checks, "_get_check", return_value=check), \
         patch.object(ai_checks, "_is_active", return_value=False), \
         patch.object(ai_checks, "_launch") as launch:
        ai_checks.retry_agent_stage(db, "batch", 12, "crawl_guide")
    assert check.steps["_agent_resume_stage"] == "crawl_guide"
    assert check.steps["_agents"]["requirements_guide"]["status"] == "done"
    assert check.steps["_agents"]["crawl_guide"]["status"] == "waiting"
    assert check.steps["_agents"]["navigation_guide"]["status"] == "waiting"
    launch.assert_called_once_with("batch", [12])


def test_evidence_coordinator_retry_keeps_approved_navigation_checkpoint():
    check = _check("evidence_coordinator")
    check.steps["_agent_plan"] = {"change_set_id": 42, "journey_id": "SHOP.LOGIN", "unresolved": []}
    check.steps["_agents"]["navigation_guide"] = {"status": "done", "journey_id": "SHOP.LOGIN"}
    change = SimpleNamespace(status="published", app_id="shop", origin={"ai_check_case_id": check.case_id})
    db = Mock()
    db.get.side_effect = lambda model, key: change if model is KbChangeSet and key == 42 else None
    kb = SimpleNamespace(journeys={"SHOP.LOGIN": {"journey_id": "SHOP.LOGIN"}})
    with patch.object(ai_checks, "_get_check", return_value=check), \
         patch("app.services.journeys.store.describe", return_value={"grounded": False}), \
         patch("app.services.journeys.store.load", return_value=kb):
        ai_checks.retry_agent_stage(db, "batch", 12, "evidence_coordinator", _dispatch=False)
    assert check.steps["_agent_resume_stage"] == "automation"
    assert check.steps["_agents"]["navigation_guide"]["status"] == "done"
    assert check.steps["_agents"]["evidence_coordinator"]["status"] == "waiting"
    assert check.steps["_agents"]["automation"]["status"] == "waiting"


def test_publication_resume_retains_approved_journey_checkpoint():
    check = _check("navigation_guide")
    check.steps["_agent_plan"] = {"change_set_id": 42, "journey_id": "SHOP.LOGIN", "unresolved": []}
    db = Mock()
    with patch.object(ai_checks, "_get_check", return_value=check):
        ai_checks.retry_agent_stage(db, "batch", 12, "navigation_guide", _dispatch=False,
                                    _retain_published_plan=True)
    assert check.status == "queued"
    assert check.steps["_agent_plan"]["change_set_id"] == 42


def test_automation_retry_uses_exact_published_case_checkpoint_not_title_match():
    check = _check("automation")
    check.steps["_agent_plan"] = {"change_set_id": 42, "journey_id": "SHOP.LOGIN", "unresolved": []}
    check.steps["_agents"]["navigation_guide"] = {"status": "done", "journey_id": "SHOP.LOGIN"}
    change = SimpleNamespace(status="published", app_id="shop", origin={"ai_check_case_id": check.case_id})
    db = Mock()
    db.get.side_effect = lambda model, key: change if model is KbChangeSet and key == 42 else None
    kb = SimpleNamespace(journeys={"SHOP.LOGIN": {"journey_id": "SHOP.LOGIN"}})
    with patch.object(ai_checks, "_get_check", return_value=check), \
         patch("app.services.journeys.store.describe", return_value={"grounded": False}), \
         patch("app.services.journeys.store.load", return_value=kb):
        ai_checks.retry_agent_stage(db, "batch", 12, "automation", _dispatch=False)
    assert check.status == "queued" and check.steps["_agent_resume_stage"] == "automation"


def test_automation_retry_requires_completed_navigation():
    check = _check("automation")
    check.steps["_agents"]["navigation_guide"]["status"] = "failed"
    db = Mock()
    with patch.object(ai_checks, "_get_check", return_value=check), \
         patch.object(ai_checks, "_is_active", return_value=False), \
         patch.object(ai_checks, "_launch") as launch:
        try:
            ai_checks.retry_agent_stage(db, "batch", 12, "automation")
        except ValueError as exc:
            assert "Navigation Guide" in str(exc)
        else:
            assert False, "must reject an unverified upstream handoff"
    assert check.status == "failed"
    launch.assert_not_called()


def test_profile_selection_does_not_regress_completed_navigation_on_automation_retry():
    check = _check("automation")
    with patch.object(ai_checks, "_set_agent") as set_agent:
        ai_checks._note_profile_selection(Mock(), check, "automation")
    assert set_agent.call_args.args[2:4] == ("automation", "working")


def test_data_entry_receives_current_browser_proof_with_proposal():
    change = SimpleNamespace(id=9, source="journey-crawl", origin={}, changes=[
        SimpleNamespace(file="app_profile.json", op="set", path="selectors.login.username",
                        note="Observed on login", before={"value": None}, after={"value": "[id=username]"})])
    crawl = SimpleNamespace(plan={"items": [{"kind": "fill", "text": "Enter username", "screen_id": "LOGIN",
                                                  "element": {"element_id": "username"}}]},
                            result={"summary": {"new": 1}, "rows": [{"screen_id": "LOGIN", "element_id": "username",
                                "outcome": "new", "selector": "[id=username]", "url": "https://shop.example.test/login"}],
                                    "steps": [{"order": 1, "status": "done", "capture": {"found": True, "count": 1,
                                        "screen_id": "LOGIN", "element_id": "username"}}]})
    check = _check("data_entry")
    db = Mock()
    db.get.return_value = change
    with patch.object(ai_checks, "_review_agent", return_value=SimpleNamespace(verdict="pass", reason="Grounded")) as review, \
         patch.object(ai_checks, "_set_agent"):
        ai_checks._review_data_entry(db, check, crawl, [9])
    packet = review.call_args.args[3]
    assert packet["browser_capture"][0]["selector"] == "[id=username]"
    assert packet["browser_actions"][0]["verified"] is True
    assert packet["proposals"][0]["files"][0]["field_updates"][0]["path"] == "selectors.login.username"


def test_audit_retry_keeps_completed_analysis_and_browser_capture():
    check = _check("audit")
    crawl = SimpleNamespace(id=45, status="completed", app_id="shop", application_id=8, environment="QA",
                            plan={"items": [{"kind": "click", "text": "Open cart"}]},
                            result={"steps": [{"order": 1, "status": "done", "capture": {"found": True}}]})
    db = Mock()
    db.get.side_effect = lambda model, key: crawl if model is KbCrawlRun else None
    with patch.object(ai_checks, "_get_check", return_value=check), \
         patch.object(ai_checks, "_is_active", return_value=False), \
         patch.object(ai_checks, "_launch") as launch:
        ai_checks.retry_agent_stage(db, "batch", 12, "audit")
    assert check.steps["_agent_resume_analysis"] == {"crawl_id": 45, "start_at": "review"}
    assert check.steps["refine"] == "done"
    assert check.steps["_agents"]["analysis"]["status"] == "done"
    launch.assert_called_once_with("batch", [12])


def test_audit_retry_rejects_other_application_capture():
    check = _check("audit")
    crawl = SimpleNamespace(id=45, status="completed", app_id="other", application_id=8, environment="QA",
                            plan={"items": [{"kind": "click", "text": "Open cart"}]},
                            result={"steps": [{"order": 1, "status": "done", "capture": {"found": True}}]})
    db = Mock()
    db.get.return_value = crawl
    with patch.object(ai_checks, "_get_check", return_value=check), \
         patch.object(ai_checks, "_is_active", return_value=False), \
         patch.object(ai_checks, "_launch") as launch:
        try:
            ai_checks.retry_agent_stage(db, "batch", 12, "audit")
        except ValueError as exc:
            assert "another application" in str(exc)
        else:
            assert False, "cross-application capture must be refused"
    assert check.status == "failed"
    launch.assert_not_called()


def test_audit_worker_skips_browser_and_starts_at_quality_review():
    check = _check("audit")
    check.status = "queued"
    check.steps["_agent_resume_analysis"] = {"crawl_id": 45, "start_at": "review"}
    crawl = SimpleNamespace(id=45, status="completed", app_id="shop", application_id=8,
                            environment="QA", base_url="https://shop.example.test/", journey_id="SHOP.CART",
                            plan={"items": [{"kind": "click", "text": "Open cart", "screen_id": "home",
                                             "element": {"element_id": "cart"}}]},
                            result={"steps": [{"order": 1, "status": "done", "capture": {
                                "found": True, "screen_id": "home", "element_id": "cart"}}], "rows": []})
    db = Mock()
    db.get.side_effect = lambda model, key: {AutomationAICheck: check, KbCrawlRun: crawl,
                                              AutomationApplication: SimpleNamespace(id=8)}[model]

    def finish_quality(*args, **kwargs):
        assert kwargs["start_at"] == "review"
        assert kwargs["reference_override"]["detail"]["crawl_id"] == 45
        check.status = "failed"  # skip unrelated final script compilation

    with patch.object(ai_checks, "SessionLocal", return_value=db), \
         patch.object(ai_checks, "_run_check_steps", side_effect=finish_quality) as quality, \
         patch("app.services.journeys.store.describe", return_value={"journey_id": "SHOP.CART"}), \
         patch("app.services.journeys.crawl_runs.start") as browser:
        ai_checks._run_agent_check(12)
    quality.assert_called_once()
    browser.assert_not_called()


def test_data_entry_retry_rejects_other_application_capture():
    check = _check("data_entry")
    crawl = SimpleNamespace(id=45, status="completed", app_id="other", application_id=8,
                            environment="QA", plan={"items": [{"kind": "click", "text": "Open cart"}]},
                            result={"steps": [{"order": 1, "status": "done", "capture": {"found": True}}]})
    db = Mock()
    db.get.side_effect = lambda model, key: {AutomationAICheck: check, KbCrawlRun: crawl}[model]
    try:
        ai_checks.retry_data_entry(db, "batch", 12)
    except ValueError as exc:
        assert "another application" in str(exc)
    else:
        assert False, "KB preparation must not reuse another application's capture"
    assert check.status == "failed"


def test_held_optional_kb_update_goes_to_manual_evaluation_without_publication():
    check = _check("data_entry")
    check.status = "awaiting_approval"
    check.steps["classify"] = "done"
    check.steps["_agents"]["data_entry"] = {"status": "needs_approval", "change_set_ids": [33, 34]}
    case = SimpleNamespace(classification="automation", classification_reason="", review_findings={})
    db = Mock()
    db.get.side_effect = lambda model, key: case if model is AutomationTestCase else None
    assert ai_checks.finish_with_held_kb_update(db, check, ["Observed screen does not match the case."])
    assert check.status == "done"
    assert case.classification == "manual"
    assert check.steps["_agents"]["data_entry"]["status"] == "done"
    assert check.steps["_kb_publication_held"]["change_set_ids"] == [33, 34]
    assert "No KB changes were published" in check.steps["_agents"]["data_entry"]["message"]


def test_journey_hold_cannot_skip_browser_verification():
    check = _check("navigation_guide")
    check.status = "awaiting_approval"
    check.steps["classify"] = "pending"
    check.steps["_agents"]["navigation_guide"] = {"status": "needs_approval", "change_set_ids": [31]}
    db = Mock()
    assert not ai_checks.finish_with_held_kb_update(db, check, ["Mapping is ambiguous."])
    assert check.status == "awaiting_approval"
    db.get.assert_not_called()


def test_original_case_send_marker_requires_held_unverified_mapping():
    check = _check("navigation_guide")
    check.status = "awaiting_approval"
    check.steps["_agents"]["navigation_guide"] = {"status": "needs_approval", "change_set_ids": [31]}
    check.steps["_agent_decision"] = {"held": ["Mapping is ambiguous."]}
    db = Mock()
    with patch.object(ai_checks, "_get_check", return_value=check):
        ai_checks.mark_unverified_sent(db, "batch", 12)
    assert check.steps["_sent_unverified"] is True
    check.steps["_agent_decision"] = {"held": []}
    with patch.object(ai_checks, "_get_check", return_value=check):
        try:
            ai_checks.mark_unverified_sent(db, "batch", 12)
        except ValueError:
            pass
        else:
            assert False, "a verified or undecided case cannot claim this fallback"
