import pytest

from app.services.journeys.changesets import ChangeSetError, apply


def test_legacy_roles_accept_first_test_data_profile():
    roles = {"roles": [{"role_id": "ROLE_USER", "name": "User"}]}
    result = apply(roles, "set", "test_data_profiles.SETUP_FIRST", {"name": "First"})
    assert result["test_data_profiles"] == {"SETUP_FIRST": {"name": "First"}}
    apply(result, "set", "test_data_profiles.SETUP_SECOND", {"name": "Second"})
    assert set(result["test_data_profiles"]) == {"SETUP_FIRST", "SETUP_SECOND"}


def test_unrelated_missing_parent_still_fails():
    with pytest.raises(ChangeSetError, match="nothing at"):
        apply({"roles": []}, "set", "misspelled_profiles.SETUP_FIRST", {"name": "First"})
