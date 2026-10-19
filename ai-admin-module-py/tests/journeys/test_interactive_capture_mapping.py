"""Headed picks must become scoped drafts, not orphaned crawl captures."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

from app.services.journeys import crawl_runs, changesets, store


def _mapping(app_id: str, host: str, *, selector: str = "//input[@id='username']", picked_host: str | None = None,
             action: str = "Enter username"):
    with TemporaryDirectory() as root:
        directory = Path(root)
        (directory / "journeys").mkdir()
        journey_id = f"{app_id}.LOGIN"
        journey = {"journey_id": journey_id, "name": "Login", "screens": [], "steps": [
            {"step_number": 1, "action": "Open login page", "screen_id": None, "element_id": None},
            {"step_number": 2, "action": action, "screen_id": None, "element_id": None},
        ]}
        (directory / "journeys" / "login.json").write_text(json.dumps(journey), encoding="utf-8")
        kb = store.JourneyKB(app_id=app_id, directory=directory, manifest={}, taxonomy={},
                             screens={}, rules={}, roles={}, state_models={}, journeys={journey_id: journey})
        crawl = SimpleNamespace(
            journey_id=journey_id, base_url=f"https://{host}/", plan={"interactive_capture_order": 2,
                "items": [{"step_number": 1, "text": "Open login page"}, {"step_number": 2, "text": "Enter username"}]},
            result={"steps": [{"order": 2, "status": "done", "capture": {
                "found": True, "count": 1, "ambiguous": False, "selector": selector,
                "url": f"https://{picked_host or host}/login", "app_label": "User name", "tag": "input", "role": "textbox",
            }}]},
        )
        return crawl_runs._interactive_mapping(crawl, kb, {})


def test_headed_pick_maps_unmapped_step_and_stores_selector_for_two_apps():
    for app_id, host in (("APP_A", "a.example.test"), ("APP_B", "b.example.test")):
        changes = _mapping(app_id, host)
        assert len(changes["automation"]) == 1
        assert changes["automation"][0]["value"]["captured_2_user_name"] == "//input[@id='username']"
        steps = next(change["value"] for change in changes["journey"] if change["path"] == "steps")
        assert steps[1]["element_id"] == "captured_2_user_name"
        assert steps[1]["screen_id"].startswith("SCR_")
        assert host.replace(".", "_").upper() in steps[1]["screen_id"]


def test_headed_pick_rejects_control_from_another_application():
    try:
        _mapping("APP_A", "a.example.test", picked_host="b.example.test")
    except changesets.ChangeSetError as error:
        assert "outside" in str(error)
    else:
        raise AssertionError("Cross-application control was accepted")


def test_headed_pick_rejects_missing_selector():
    try:
        _mapping("APP_A", "a.example.test", selector="")
    except changesets.ChangeSetError as error:
        assert "outside" in str(error)
    else:
        raise AssertionError("A missing locator was accepted")


def test_headed_pick_cannot_mislabel_one_field_as_two():
    try:
        _mapping("APP_A", "a.example.test", action="Enter username and password")
    except changesets.ChangeSetError as error:
        assert "multiple fields" in str(error)
    else:
        raise AssertionError("One clicked input was mapped to a two-field action")
