from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from app.services.automation import agent_evidence, agent_journey


def _run(host: str, app_id: int = 7, environment: str = "RC"):
    address = f"https://{host}/portal"
    return SimpleNamespace(
        id=41, application_id=app_id, application_url=address,
        application_environment=environment, auth_mode="none", auth_status="not_required",
        status="completed", pages_discovered=2, elements_discovered=5, blockers=[],
        updated_at=datetime.utcnow(), explored_pages=[
            {"url": address + "/index.html", "requested_url": address,
             "status": 200, "title": "Portal"},
            {"url": address + "/products", "status": 200, "title": "Products"},
        ],
    )


@pytest.mark.parametrize("host", ["shop.example.test", "bank.example.test"])
def test_approved_app_kb_indexes_and_reuses_observed_scan_after_restart(tmp_path, host):
    run = _run(host)
    app = SimpleNamespace(id=7, app_key="sample_app")
    kb = SimpleNamespace(directory=tmp_path, journeys={})
    db = Mock()
    db.get.side_effect = lambda model, key: app if key == 7 else run if key == run.id else None
    with patch.object(agent_evidence.store, "load", return_value=kb):
        agent_evidence.record_scan(db, run, max_pages=12, focus_terms=["products"])
        agent_journey._SCAN_BUDGETS.clear()  # A process restart loses the old in-memory cache.
        found = agent_evidence.reusable_scan(
            db, app_key="sample_app", application_id=7, address=run.application_url,
            environment="RC", max_pages=12, focus_terms=["products"])
        assert found is run
        # A one-page entry proof may reuse the same captured entry even for a different case.
        assert agent_evidence.reusable_scan(
            db, app_key="sample_app", application_id=7, address=run.application_url,
            environment="RC", max_pages=1, focus_terms=["accounts"]) is run
        assert agent_evidence.reusable_scan(
            db, app_key="sample_app", application_id=7, address=run.application_url,
            environment="SIT", max_pages=12, focus_terms=["products"]) is None
        assert agent_evidence.reusable_scan(
            db, app_key="sample_app", application_id=7, address=f"https://other.{host}/portal",
            environment="RC", max_pages=12, focus_terms=["products"]) is None
        assert agent_evidence.reusable_scan(
            db, app_key="sample_app", application_id=7, address=run.application_url,
            environment="RC", max_pages=12, focus_terms=["accounts"]) is None


def test_stale_or_wrong_screen_evidence_is_not_reused(tmp_path):
    run = _run("shop.example.test")
    app = SimpleNamespace(id=7, app_key="sample_app")
    kb = SimpleNamespace(directory=tmp_path, journeys={})
    db = Mock()
    db.get.side_effect = lambda model, key: app if key == 7 else run if key == run.id else None
    with patch.object(agent_evidence.store, "load", return_value=kb):
        agent_evidence.record_scan(db, run, max_pages=12, focus_terms=["products"])
        run.updated_at = datetime.utcnow() - timedelta(days=3)
        assert agent_evidence.reusable_scan(
            db, app_key="sample_app", application_id=7, address=run.application_url,
            environment="RC", max_pages=12, focus_terms=["products"]) is not None
        # The immutable KB index has its own capture timestamp. Expire that record.
        path = tmp_path / "sources" / "agent_observations.json"
        doc = agent_evidence._read(path)
        doc["scans"][0]["captured_at"] = (datetime.utcnow() - timedelta(days=3)).isoformat()
        agent_evidence._write(path, doc)
        assert agent_evidence.reusable_scan(
            db, app_key="sample_app", application_id=7, address=run.application_url,
            environment="RC", max_pages=12, focus_terms=["products"]) is None
        doc["scans"][0]["captured_at"] = datetime.utcnow().isoformat()
        agent_evidence._write(path, doc)
        run.explored_pages = [{"url": run.application_url + "/different", "status": 200, "title": "Other"}]
        assert agent_evidence.reusable_scan(
            db, app_key="sample_app", application_id=7, address=run.application_url,
            environment="RC", max_pages=12, focus_terms=["products"]) is None


def test_finding_context_is_environment_scoped_and_non_executable(tmp_path):
    kb = SimpleNamespace(directory=tmp_path, journeys={"J": {"journey_id": "J", "name": "Catalog"}})
    with patch.object(agent_evidence.store, "load", return_value=kb):
        agent_evidence.record_finding("sample_app", environment="RC", case_id=3,
                                      stage="requirements_guide", run_id=41, status="pass", action_count=4)
        agent_evidence.record_finding("sample_app", environment="SIT", case_id=4,
                                      stage="navigation_guide", run_id=42, status="hold", unresolved_count=2)
        context = agent_evidence.context("sample_app", application_id=7, environment="RC")
    assert context["recent_guide_findings"][0]["case_id"] == 3
    assert len(context["recent_guide_findings"]) == 1
    assert "locator" not in str(context).lower()


def test_guide_uses_kb_scan_without_starting_another_browser_job():
    run = _run("shop.example.test")
    db = Mock()
    db.get.return_value = SimpleNamespace(id=7, app_key="sample_app")
    with patch.object(agent_evidence, "reusable_scan", return_value=run), patch(
        "app.routers.automation.start_discovery", side_effect=AssertionError("unexpected recrawl")
    ):
        found, issue = agent_journey.discover(
            db, application_id=7, address=run.application_url, environment="RC",
            actor="tester", max_pages=12, focus_terms=["products"], reuse_kb_evidence=True)
    assert found is run and issue is None


@pytest.mark.parametrize("actions,expected", [
    (["Open the smartphones catalogue", "Select a device and inspect purchase options"],
     {"smartphones", "device", "purchase"}),
    (["Navigate to login", "Enter username", "Enter password", "Click sign in"],
     {"login", "username", "password", "sign"}),
])
def test_crawl_focus_terms_keep_app_specific_targets_without_filler(actions, expected):
    terms = set(agent_journey.crawl_focus_terms(actions))
    assert expected <= terms
    assert not terms.intersection({"the", "and", "inspect", "select", "navigate"})
