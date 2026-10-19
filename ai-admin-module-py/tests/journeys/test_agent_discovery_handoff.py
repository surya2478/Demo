"""Discovery's HTTP response must never leak into agent progress callbacks."""
from unittest.mock import Mock, patch

from app.models.automation import AutomationDiscoveryRun
from app.services.automation.agent_journey import discover
from app.services.automation.agent_recovery import _scan_progress


def test_first_progress_callback_receives_persisted_run_after_http_start():
    run = AutomationDiscoveryRun(id=42, status="running", run_key=None,
                                 pages_discovered=1, elements_discovered=2)
    db = Mock()
    db.query.return_value.filter.return_value.order_by.return_value.first.return_value = None
    db.get.return_value = run
    updates = []

    def progress(value):
        # These are the same accesses that crashed Navigation Guide on the
        # initial dictionary response, before polling ever started.
        updates.append((value.id, value.run_key, value.pages_discovered, _scan_progress(value)))

    def complete(_db, value):
        value.status = "completed"

    with patch("app.routers.automation.start_discovery", return_value={"id": 42, "status": "running"}) as start, \
         patch("app.routers.automation._absorb_discovery_result", side_effect=complete):
        result, error = discover(db, application_id=3, address="https://example.test/",
                                 environment="QA", actor="tester", force=True, on_progress=progress)

    assert result is run and error is None
    assert updates == [(42, None, 1, {})]
    db.get.assert_called_once_with(AutomationDiscoveryRun, 42)
    start.assert_called_once()


def test_missing_persisted_run_does_not_pass_http_response_to_agent():
    db = Mock()
    db.query.return_value.filter.return_value.order_by.return_value.first.return_value = None
    db.get.return_value = None
    progress = Mock()
    with patch("app.routers.automation.start_discovery", return_value={"id": 42}):
        result, error = discover(db, application_id=3, address="https://example.test/",
                                 environment="QA", actor="tester", force=True, on_progress=progress)
    assert result is None and error == "Discovery result was not found."
    progress.assert_not_called()


def test_failed_browser_run_preserves_actual_failure():
    run = AutomationDiscoveryRun(id=42, status="failed", error="Browser runtime unavailable")
    db = Mock()
    db.query.return_value.filter.return_value.order_by.return_value.first.return_value = None
    db.get.return_value = run
    with patch("app.routers.automation.start_discovery", return_value={"id": 42}), \
         patch("app.routers.automation._absorb_discovery_result"):
        result, error = discover(db, application_id=3, address="https://example.test/",
                                 environment="QA", actor="tester", force=True)
    assert result is None and error == "Browser runtime unavailable"
