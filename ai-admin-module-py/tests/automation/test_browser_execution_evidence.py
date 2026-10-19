"""Browser replay outcomes are distinct from scanned page-control inventory."""

from app.services.automation.ai_checks import _plan_signature, browser_execution_evidence


def test_safe_pause_does_not_claim_submit_ran():
    plan = {"items": [
        {"text": "Enter account", "kind": "fill", "screen_id": "screen-a", "element": {"element_id": "account"}},
        {"text": "Submit form", "kind": "click", "screen_id": "screen-a", "element": {"element_id": "submit"}, "risky": True},
    ], "stop_before": 2, "first_risky": 2}
    result = {"rows": [{"element_id": "submit", "outcome": "found"}], "steps": [
        {"order": 1, "status": "done", "capture": {"found": True, "screen_id": "screen-a", "element_id": "account"}},
        {"order": 2, "status": "stopped", "reason": "safety stop"},
    ]}
    evidence = browser_execution_evidence(plan, result)
    assert evidence["completed"] == 1
    assert evidence["safety_pause"] == {"order": 2, "action": "Submit form"}
    assert evidence["steps"][1]["status"] == "stopped"


def test_completed_unrelated_application_uses_its_own_execution():
    plan = {"items": [{"text": "Choose item", "kind": "click", "screen_id": "shop-cart",
                       "element": {"element_id": "item"}}]}
    result = {"steps": [{"order": 1, "status": "done", "capture": {
        "found": True, "screen_id": "shop-cart", "element_id": "item"}}]}
    evidence = browser_execution_evidence(plan, result)
    assert evidence["completed"] == 1
    assert not evidence["incomplete"]
    assert evidence["safety_pause"] is None


def test_ambiguous_control_cannot_be_counted_as_executed():
    plan = {"items": [{"text": "Choose item", "kind": "click", "screen_id": "other-app",
                       "element": {"element_id": "item"}}]}
    result = {"rows": [{"element_id": "item", "outcome": "found"}], "steps": [
        {"order": 1, "status": "done", "capture": {"found": False, "ambiguous": True}}]}
    evidence = browser_execution_evidence(plan, result)
    assert evidence["completed"] == 0
    assert evidence["incomplete"] == ["step 1: done (control not verified)"]


def test_wrong_screen_is_not_verified_even_if_label_was_found():
    plan = {"items": [{"text": "Choose item", "kind": "click", "screen_id": "booking-checkout",
                       "element": {"element_id": "confirm"}}]}
    result = {"steps": [{"order": 1, "status": "done", "capture": {
        "found": True, "screen_id": "booking-search", "element_id": "confirm"}}]}
    evidence = browser_execution_evidence(plan, result)
    assert evidence["completed"] == 0
    assert evidence["incomplete"]


def test_risky_approval_cannot_be_reused_after_plan_changes():
    old = [{"text": "Submit form", "screen_id": "checkout", "element": {"element_id": "submit"}}]
    changed = [{"text": "Submit form", "screen_id": "other-page", "element": {"element_id": "submit"}}]
    assert _plan_signature(old) != _plan_signature(changed)
