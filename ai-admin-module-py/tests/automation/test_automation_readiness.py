from copy import deepcopy
import subprocess

from app.services.automation.automation_readiness import assess_plan
from app.services.journeys.journey_crawl import apply_stop, build_spec


def _plan(host: str, screen: str, action: str = "Click Log In") -> dict:
    return {"base_url": f"https://{host}/", "variables": [], "screens": {},
            "items": [{"step_number": 1, "text": action, "kind": "click",
                       "screen_id": screen,
                       "element": {"screen_id": screen, "element_id": "action"}}]}


def test_ready_handoff_for_two_unrelated_applications():
    for host, screen in (("bank.example.test", "bank_login"),
                         ("shop.example.test", "shop_checkout")):
        report = assess_plan(apply_stop(_plan(host, screen), allow_risky=False))
        assert report["ready"] is True
        assert report["code_generated"] is True
        assert report["browser_verification_steps"] == [1]


def test_submit_is_script_ready_but_still_requires_consent_to_execute():
    plan = apply_stop(_plan("bank.example.test", "recovery", "Submit the form"),
                      allow_risky=False)
    report = assess_plan(plan)
    assert report["ready"] is True
    assert report["risky_step"] == 1
    assert plan["stop_before"] == 1


def test_wrong_host_wrong_screen_and_unmapped_action_are_not_ready():
    good = _plan("shop.example.test", "checkout")
    wrong_host = deepcopy(good)
    wrong_host["items"][0]["route"] = "https://other.example.test/pay"
    assert "outside" in " ".join(assess_plan(wrong_host)["issues"])
    wrong_screen = deepcopy(good)
    wrong_screen["items"][0]["element"]["screen_id"] = "login"
    assert "different screen" in " ".join(assess_plan(wrong_screen)["issues"])
    unmapped = deepcopy(good)
    unmapped["items"][0].update(kind="screen", element=None)
    assert "no browser-observed control" in " ".join(assess_plan(unmapped)["issues"])


def test_external_login_route_requires_auth_journey_and_environment_trust():
    plan = _plan("shop.example.test", "login")
    plan["items"][0].update(journey_id="AUTH", route="https://identity.example.test/login")
    plan["auth_journey_ids"] = ["AUTH"]
    plan["trusted_auth_origins"] = ["https://identity.example.test"]
    assert assess_plan(plan)["ready"]
    plan["trusted_auth_origins"] = []
    assert "outside" in " ".join(assess_plan(plan)["issues"])
    plan["trusted_auth_origins"] = ["https://identity.example.test"]
    plan["items"][0]["journey_id"] = "OTHER"
    assert "outside" in " ".join(assess_plan(plan)["issues"])


def test_generated_crawl_parses_with_scoped_external_auth_guard():
    plan = _plan("shop.example.test", "login")
    plan.update(auth_journey_ids=["AUTH"], trusted_auth_origins=["https://identity.example.test"],
                signatures={}, warnings=[], variables=[], screens={}, journey_id="AUTH")
    plan["items"][0].update(journey_id="AUTH", route="https://identity.example.test/login")
    code = build_spec(plan)
    assert "authJourneys.has(item.journey_id) && approvedAuthOrigins.has(origin)" in code
    assert "if (!allowedOrigin(item, page.url()))" in code
    parsed = subprocess.run(
        ["node", "-e", "require('@babel/parser').parse(require('fs').readFileSync(0,'utf8'), {sourceType:'module'})"],
        input=code, text=True, capture_output=True)
    assert parsed.returncode == 0, parsed.stderr
