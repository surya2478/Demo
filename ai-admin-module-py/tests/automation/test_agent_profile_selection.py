"""Explicit case values must not be replayed with a contradictory batch profile."""
from types import SimpleNamespace
from unittest.mock import patch

from app.services.automation.agent_test_data import profile_for_explicit_values


def profile(username_variable, password_variable):
    return {"kind": "vault", "fields": [
        {"name": "Username", "variable": username_variable},
        {"name": "Password", "variable": password_variable},
    ]}


def choose(profiles, values, actions, selected):
    kb = SimpleNamespace(roles={"test_data_profiles": profiles})
    app = SimpleNamespace(entries=[])
    def resolve(_entries, _environment, variables):
        return {"values": {name: values[name] for name in variables if name in values}}
    with patch("app.services.automation.agent_test_data.store.load", return_value=kb), \
         patch("app.services.automation.agent_test_data.test_data.find_app", return_value=app), \
         patch("app.services.automation.agent_test_data.test_data.resolve", side_effect=resolve):
        return profile_for_explicit_values(None, app_key="example", environment="QA",
                                           actions=actions, selected_id=selected)


def test_negative_case_selects_unique_matching_profile():
    profiles = {"valid": profile("VALID_USER", "VALID_PASS"),
                "invalid": profile("INVALID_USER", "INVALID_PASS")}
    values = {"VALID_USER": "real_user", "VALID_PASS": "correct",
              "INVALID_USER": "bad_user", "INVALID_PASS": "wrong"}
    actions = ["Enter username bad_user into the username field",
               "Enter password wrong into the password field"]
    assert choose(profiles, values, actions, "valid") == ("invalid", None)


def test_unrelated_application_same_rule_and_ambiguous_match_is_held():
    profiles = {"selected": profile("SHOP_USER", "SHOP_PASS"),
                "candidate_a": profile("A_USER", "A_PASS"),
                "candidate_b": profile("B_USER", "B_PASS")}
    values = {"SHOP_USER": "buyer", "SHOP_PASS": "right",
              "A_USER": "locked", "A_PASS": "wrong",
              "B_USER": "locked", "B_PASS": "wrong"}
    chosen, issue = choose(profiles, values, ["Enter username locked into the username field",
                                            "Enter password wrong into the password field"], "selected")
    assert chosen == "selected" and "Several ready" in issue


def test_missing_match_is_not_guessed():
    chosen, issue = choose({"valid": profile("USER", "PASS")}, {"USER": "real", "PASS": "correct"},
                           ["Enter username unknown into the username field"], "valid")
    assert chosen == "valid" and "no ready matching profile" in issue
