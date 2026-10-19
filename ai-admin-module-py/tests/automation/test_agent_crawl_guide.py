from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.services.automation import agent_crawl_guide, agent_journey
from app.services.automation.agent_reviews import CrawlAdvice


@pytest.mark.parametrize("address", [
    "https://the-internet.herokuapp.com/login",
    "https://www.saucedemo.com/",
])
def test_registered_entry_is_observed_on_two_unrelated_apps(address):
    run = SimpleNamespace(explored_pages=[{"url": address, "status": 200, "title": "Login"}],
                          elements_discovered=4, blockers=[])
    result = agent_crawl_guide.entry_evidence(run, address)
    assert result["verified"] is True
    assert result["entry"]["url"] == address


@pytest.mark.parametrize("observed", [
    "https://attacker.example/login",
    "https://the-internet.herokuapp.com/other",
])
def test_wrong_host_or_screen_cannot_satisfy_reported_entry(observed):
    run = SimpleNamespace(explored_pages=[{"url": observed, "status": 200}],
                          elements_discovered=4, blockers=[])
    assert agent_crawl_guide.entry_evidence(run, "https://the-internet.herokuapp.com/login")["verified"] is False


def test_browser_observed_canonical_entry_redirect_is_valid_but_wrong_host_is_not():
    address = "https://www.eand.ae/en"
    run = SimpleNamespace(explored_pages=[{"requested_url": address,
                                          "url": "https://www.eand.ae/en/index.html",
                                          "status": 200, "title": "Home"}],
                          elements_discovered=4, blockers=[])
    assert agent_crawl_guide.entry_evidence(run, address)["verified"] is True
    run.explored_pages[0]["url"] = "https://other.example/en/index.html"
    assert agent_crawl_guide.entry_evidence(run, address)["verified"] is False
    run.explored_pages[0]["url"] = "https://www.eand.ae/en/index.html"
    run.explored_pages[0]["title"] = "Request Rejected"
    assert agent_crawl_guide.entry_evidence(run, address)["verified"] is False


def test_failed_entry_and_untrusted_crawl_instruction_are_not_authority():
    run = SimpleNamespace(explored_pages=[{"url": "https://the-internet.herokuapp.com/login", "status": 404}],
                          elements_discovered=0, blockers=[])
    assert agent_crawl_guide.entry_evidence(run, "https://the-internet.herokuapp.com/login")["verified"] is False
    assert agent_crawl_guide.allowed_recrawl("recrawl", already_retried=False)
    assert not agent_crawl_guide.allowed_recrawl("recrawl", already_retried=True)
    with pytest.raises(ValidationError):
        CrawlAdvice(action="recrawl", reason="Try the same page again", url="https://attacker.example")


def test_popup_blocked_entry_is_not_verified_and_details_reach_guide():
    address = "https://www.eand.ae/en"
    run = SimpleNamespace(
        explored_pages=[{"url": address, "status": 200, "title": "Home", "blocked_by_overlay": True}],
        elements_discovered=0,
        blockers=[{"url": address, "reason": "A visible consent overlay blocks this page."}],
    )
    assert agent_crawl_guide.entry_evidence(run, address)["verified"] is False
    packet = agent_crawl_guide.guidance_evidence(
        run, address, signed_in_required=False, login_plan_ready=False, profile_selected=False)
    assert packet["observed_pages"][0]["blocked_by_overlay"] is True
    assert "consent overlay" in packet["blocker_details"][0]["reason"]


def test_http_200_waf_challenge_is_not_verified_entry():
    address = "https://www.eand.ae/en"
    run = SimpleNamespace(
        explored_pages=[{"url": address, "status": 200, "title": "Request Rejected"}],
        elements_discovered=0, blockers=[])
    assert agent_crawl_guide.entry_evidence(run, address)["verified"] is False


def test_linked_login_evidence_requires_observed_unblocked_target():
    source = "https://shop.example.test/"
    target = "https://identity.example.test/login?state=private"
    blocker = {"url": source, "source_url": source, "target_url": target,
               "kind": "linked_auth", "reason": "Observed sign-in link opens a different host"}
    run = SimpleNamespace(explored_pages=[
        {"url": source, "status": 200, "title": "Shop"},
        {"url": target, "status": 200, "title": "Sign in", "linked_auth": True,
         "linked_auth_controls": [{"role": "textbox", "accessible_name": "Username"}]}],
        elements_discovered=3, blockers=[blocker])
    packet = agent_crawl_guide.guidance_evidence(
        run, source, signed_in_required=True, login_plan_ready=False,
        profile_selected=True)
    linked = packet["linked_login_candidates"][0]
    assert linked["public_page_verified"] is True
    assert linked["target_origin"] == "https://identity.example.test"
    assert linked["observed_control_names"] == ["Username"]
    assert "private" not in str(packet)
    run.explored_pages[1]["blocked_by_overlay"] = True
    assert not agent_crawl_guide.guidance_evidence(
        run, source, signed_in_required=True, login_plan_ready=False,
        profile_selected=True)["linked_login_candidates"][0]["public_page_verified"]


def test_unknown_or_narrow_old_scan_cannot_stand_in_for_wider_crawl():
    assert not agent_journey._has_scan_budget(987654321, 12)
    agent_journey._remember_scan_budget(987654321, 3)
    assert not agent_journey._has_scan_budget(987654321, 12)
    agent_journey._remember_scan_budget(987654321, 12)
    assert agent_journey._has_scan_budget(987654321, 12)
