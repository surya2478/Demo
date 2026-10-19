"""Captured browser evidence is distinct from approved executable mappings."""

from app.services.journeys import diff, store, workspace


def test_reported_bank_project_separates_observed_from_mapped():
    kb = store.load("bank_test")
    assert kb is not None
    overview = workspace.overview(kb)
    assert overview["journeys"]["authored"] >= 1
    assert overview["screens"]["observed"] > 0
    assert overview["screens"]["captured_unmapped"] > 0
    assert overview["screens"]["linked"] < overview["screens"]["elements"]
    assert overview["screens"]["captured_unmapped"] <= overview["reconcile"].get(diff.NOT_CRAWLED, 0)


def test_unrelated_project_uses_the_same_evidence_projection():
    other = next((store.load(key) for key in store.list_apps() if key != "bank_test"), None)
    assert other is not None
    overview = workspace.overview(other)
    assert overview["screens"]["observed"] == sum(
        bool(e.get("observed_selector") or e.get("observed_locator"))
        for screen in other.screens.values() for e in screen.get("elements", [])
    )


def test_unobserved_control_is_not_misreported_as_captured():
    screen = {"screen_id": "other-screen", "name": "Other screen", "elements": [{
        "element_id": "missing", "label": "Missing", "type": "button", "locator_hint": "Missing",
    }]}
    element = screen["elements"][0]
    result = diff.compare_element(screen, element, {})
    assert result["status"] == diff.NOT_CRAWLED
    assert not (element.get("observed_selector") or element.get("observed_locator"))
