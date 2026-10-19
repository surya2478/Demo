"""An Analysis retry must keep the completed browser handoff intact."""
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.services.automation import ai_checks
from app.services.automation.agent_reviews import AgentReviewError, _transient
from app.services.automation.llm import LLMUnavailable
from app.models.automation import AutomationAICheck, AutomationApplication
from app.models.kb_changes import KbCrawlRun


def _check(app_key="shop_test"):
    return SimpleNamespace(
        id=12, batch_id="batch", status="failed", error="provider quota",
        finished_at=None,
        steps={"_mode": "agents", "refine": "failed",
               "_agent_setup": {"app_key": app_key, "application_id": 8},
               "_agents": {"automation": {"status": "done", "crawl_id": 45},
                           "analysis": {"status": "failed"}}},
    )


def _crawl(app_key="shop_test"):
    return SimpleNamespace(id=45, status="completed", app_id=app_key,
                           application_id=8, plan={"items": [{"kind": "click", "text": "Open cart"}]},
                           result={"steps": [{"order": 1, "status": "done", "capture": {"found": True}}]})


def test_retry_analysis_queues_only_saved_checkpoint():
    check, crawl = _check(), _crawl()
    db = Mock()
    db.get.return_value = crawl
    with patch.object(ai_checks, "_get_check", return_value=check), \
         patch.object(ai_checks, "_is_active", return_value=False), \
         patch.object(ai_checks, "_launch") as launch:
        ai_checks.retry_analysis(db, "batch", 12)
    assert check.status == "queued"
    assert check.steps["_agent_resume_analysis"] == {"crawl_id": 45}
    assert check.steps["_agents"]["automation"]["status"] == "done"
    assert check.steps["_agents"]["analysis"]["status"] == "waiting"
    launch.assert_called_once_with("batch", [12])


def test_retry_analysis_rejects_other_application_capture():
    check, crawl = _check("bank_test"), _crawl("shop_test")
    db = Mock()
    db.get.return_value = crawl
    with patch.object(ai_checks, "_get_check", return_value=check), \
         patch.object(ai_checks, "_is_active", return_value=False), \
         patch.object(ai_checks, "_launch") as launch:
        try:
            ai_checks.retry_analysis(db, "batch", 12)
        except ValueError as exc:
            assert "another application" in str(exc)
        else:
            assert False, "cross-application capture must not be reused"
    launch.assert_not_called()
    assert check.status == "failed"


def test_daily_quota_is_not_retried_immediately():
    assert not _transient(LLMUnavailable("OpenRouter returned 429: free model requests per day exceeded"))


def test_daily_quota_explains_hold_without_repeating_provider_call():
    from app.services.automation import agent_reviews
    with patch.object(agent_reviews, "complete_json", side_effect=LLMUnavailable(
            "OpenRouter returned 429: free model requests per day exceeded")) as model:
        try:
            agent_reviews.review("requirements_guide", {"actions": ["Open cart"]})
        except AgentReviewError as exc:
            assert "daily quota" in str(exc)
        else:
            assert False, "daily quota must stop the agent"
    model.assert_called_once()


def test_resume_worker_skips_browser_and_passes_saved_capture_to_analysis():
    check, crawl = _check(), _crawl()
    check.status = "queued"
    check.case_id = 17
    check.requested_by = "tester"
    check.source_row = {"Test Case Description": "Open cart", "Steps": "1. Open cart"}
    check.steps["_agent_setup"]["environment"] = "QA"
    check.steps["_agent_resume_analysis"] = {"crawl_id": 45}
    crawl.environment = "QA"
    crawl.base_url = "https://shop.example.test/"
    crawl.journey_id = "SHOP.CART"
    crawl.plan = {"items": [{"kind": "click", "text": "Open cart", "screen_id": "home",
                            "element": {"element_id": "cart"}}]}
    crawl.result = {"steps": [{"order": 1, "status": "done", "capture": {
        "found": True, "screen_id": "home", "element_id": "cart"}}], "rows": []}
    app = SimpleNamespace(id=8)
    db = Mock()
    db.get.side_effect = lambda model, key: {AutomationAICheck: check, KbCrawlRun: crawl,
                                              AutomationApplication: app}[model]

    def finish_analysis(*args, **kwargs):
        assert kwargs["reference_override"]["detail"]["crawl_id"] == 45
        check.status = "failed"  # avoid the unrelated final-script/KB stage in this unit test

    with patch.object(ai_checks, "SessionLocal", return_value=db), \
         patch.object(ai_checks, "_run_check_steps", side_effect=finish_analysis) as analysis, \
         patch("app.services.journeys.store.describe", return_value={
             "journey_id": "SHOP.CART", "context": "Shop cart journey"}), \
         patch("app.services.journeys.crawl_runs.start") as browser:
        ai_checks._run_agent_check(12)
    analysis.assert_called_once()
    browser.assert_not_called()
    assert "_agent_resume_analysis" not in check.steps
