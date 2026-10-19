from types import SimpleNamespace
from app.services.automation.agent_journey import _action_control_score
from app.services.automation.expert_editor import _role_allowed
from app.services.automation.agent_journey import source_steps, source_expected


def test_select_can_activate_observed_button_or_link():
    for action, role, label in [('Select Login', 'button', 'Login'),
                                ('Choose Continue', 'link', 'Continue')]:
        observed = SimpleNamespace(role=role, accessible_name=label)
        assert _action_control_score(action, observed) > 0
        assert _role_allowed(action, role)


def test_select_does_not_choose_unrelated_or_input_control():
    assert _action_control_score('Select Login', SimpleNamespace(role='button', accessible_name='Delete')) == 0
    assert _action_control_score('Select Login', SimpleNamespace(role='textbox', accessible_name='Login')) == 0
    assert not _role_allowed('Select Login', 'textbox')


def test_observation_is_preserved_as_assertion_not_click():
    row = {'Steps': '1. Select Login\n2. Observe the Secure Area and Logout control',
           'Expected Result': 'Authentication succeeds'}
    assert source_steps(row) == ['Select Login']
    assert 'Observe the Secure Area and Logout control' in source_expected(row)
    assert source_steps({'Steps': 'Check the checkbox\nVerify the result then click Continue'}) == [
        'Check the checkbox', 'Verify the result then click Continue']
