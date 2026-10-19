"""Navigation review sees the full proposed document on both create and retry."""
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.services.automation.ai_checks import proposed_review_documents


def change(file, op, path, value):
    return SimpleNamespace(file=file, op=op, path=path, after={"present": True, "value": value})


def test_preview_new_journey():
    kb = SimpleNamespace(journeys={}, screens={})
    draft = SimpleNamespace(changes=[
        change("journeys/login.json", "create", "$", {"journey_id": "LOGIN", "steps": [{"step_number": 1}]}),
        change("screens.json", "set", "screens", [{"screen_id": "LOGIN_PAGE", "route": "/login"}]),
    ])
    with patch("app.services.journeys.store.load", return_value=kb):
        journey, screens = proposed_review_documents("app", draft, "LOGIN")
    assert len(journey["steps"]) == 1 and screens[0]["route"] == "/login"


def test_preview_retry_applies_field_updates_to_existing_journey():
    kb = SimpleNamespace(journeys={"LOGIN": {"journey_id": "LOGIN", "steps": [{"element_id": "wrong_link"}]}},
                         screens={"LOGIN_PAGE": {"screen_id": "LOGIN_PAGE", "route": "/login"}})
    draft = SimpleNamespace(changes=[
        change("journeys/login.json", "set", "steps", [{"element_id": None}]),
    ])
    with patch("app.services.journeys.store.load", return_value=kb):
        journey, screens = proposed_review_documents("app", draft, "LOGIN")
    assert journey["steps"] == [{"element_id": None}]
    assert screens == [{"screen_id": "LOGIN_PAGE", "route": "/login"}]
    assert kb.journeys["LOGIN"]["steps"][0]["element_id"] == "wrong_link"


def test_preview_rejects_wrong_journey_id():
    kb = SimpleNamespace(journeys={}, screens={})
    draft = SimpleNamespace(changes=[change("journeys/other.json", "create", "$", {"journey_id": "OTHER"})])
    with patch("app.services.journeys.store.load", return_value=kb):
        with pytest.raises(ValueError, match="ID changed"):
            proposed_review_documents("app", draft, "LOGIN")
